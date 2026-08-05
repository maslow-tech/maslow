import { beforeEach, describe, expect, it } from "vitest";
import {
  applicability,
  clearAllDrafts,
  clearCollabBuffer,
  clearDraft,
  collabBufferKey,
  draftKey,
  listDrafts,
  parseDraftKey,
  purgeForeignDrafts,
  readCollabBuffer,
  readDraft,
  writeCollabBuffer,
  writeDraft,
} from "./draftMirror";

/**
 * The mirror holds brain content — including private-object bodies — outside the
 * RLS boundary on a possibly shared machine. These tests pin the rules that make
 * that acceptable: scoped by account, purged on account change, cleared on
 * ack/logout, and never reapplied over a newer version without asking.
 */
describe("draft mirror", () => {
  const A = "acct-aaaa";
  const B = "acct-bbbb";
  const OBJ = "obj-1111";

  it("round-trips a draft with the version it was typed against", () => {
    writeDraft(A, OBJ, { body: "half a sentence" }, 7, 1_700_000_000_000);

    expect(readDraft(A, OBJ)).toEqual({
      fields: { body: "half a sentence" },
      baseVersion: 7,
      savedAt: 1_700_000_000_000,
    });
    expect(localStorage.getItem(draftKey(A, OBJ))).toContain("half a sentence");
  });

  it("clears on ack", () => {
    writeDraft(A, OBJ, { body: "typed" }, 7);
    clearDraft(A, OBJ);
    expect(readDraft(A, OBJ)).toBeNull();
    expect(localStorage.getItem(draftKey(A, OBJ))).toBeNull();
  });

  it("clears every draft on logout / 401", () => {
    writeDraft(A, "o1", { body: "one" }, 1);
    writeDraft(A, "o2", { body: "two" }, 1);
    localStorage.setItem("brain-theme", "dark");

    expect(clearAllDrafts()).toBe(2);
    expect(readDraft(A, "o1")).toBeNull();
    expect(readDraft(A, "o2")).toBeNull();
    // unrelated app state is untouched
    expect(localStorage.getItem("brain-theme")).toBe("dark");
  });

  it("purges another member's drafts when a second account signs in", () => {
    writeDraft(A, "o1", { body: "member A private note" }, 3);
    writeDraft(A, "o2", { title: "A's title" }, 4);
    writeDraft(B, "o3", { body: "member B" }, 5);

    // App.tsx calls this before the first render as member B.
    expect(purgeForeignDrafts(B)).toBe(2);

    expect(localStorage.getItem(draftKey(A, "o1"))).toBeNull();
    expect(localStorage.getItem(draftKey(A, "o2"))).toBeNull();
    expect(readDraft(B, "o3")?.fields).toEqual({ body: "member B" });
  });

  it("purges everything when the current account is unknown", () => {
    writeDraft(A, "o1", { body: "x" }, 1);
    expect(purgeForeignDrafts("")).toBe(1);
    expect(localStorage.getItem(draftKey(A, "o1"))).toBeNull();
  });

  it("never hands one account another account's draft, and deletes it on the way", () => {
    writeDraft(A, OBJ, { body: "A's text" }, 2);

    expect(readDraft(B, OBJ)).toBeNull();
    // reading as B is itself a purge — A's text does not linger
    expect(localStorage.getItem(draftKey(A, OBJ))).toBeNull();
  });

  it("drops corrupt or malformed entries rather than trusting them", () => {
    localStorage.setItem(draftKey(A, "o1"), "{not json");
    localStorage.setItem(draftKey(A, "o2"), JSON.stringify({ fields: { body: "x" } }));

    expect(readDraft(A, "o1")).toBeNull();
    expect(readDraft(A, "o2")).toBeNull();
    expect(localStorage.getItem(draftKey(A, "o1"))).toBeNull();
    expect(localStorage.getItem(draftKey(A, "o2"))).toBeNull();
  });

  it("parses keys and rejects shapes it cannot attribute", () => {
    expect(parseDraftKey(draftKey(A, OBJ))).toEqual({ accountId: A, objectId: OBJ });
    expect(parseDraftKey("brain-theme")).toBeNull();
    expect(parseDraftKey("brain.draft.")).toBeNull();
    expect(parseDraftKey("brain.draft..obj")).toBeNull();
  });

  it("lists only this account's drafts", () => {
    writeDraft(A, "o1", { body: "mine" }, 1);
    writeDraft(A, "o2", { body: "also mine" }, 1);

    const rows = listDrafts(A)
      .map((r) => r.objectId)
      .sort();
    expect(rows).toEqual(["o1", "o2"]);
    expect(listDrafts(B)).toEqual([]);
  });

  it("auto-applies only at the exact version it was typed against", () => {
    const draft = { fields: { body: "x" }, baseVersion: 7, savedAt: 0 };

    expect(applicability(draft, 7)).toBe("auto");
    // an agent wrote in between — offer a diff, never silently reapply
    expect(applicability(draft, 8)).toBe("offer");
    // stale read of an older version is equally untrustworthy
    expect(applicability(draft, 6)).toBe("offer");
  });
});

/**
 * The COLLAB offline buffer rides the SAME privacy regime as the CAS draft — the
 * gap it fills is only that body/title travel over the socket, not the queue, so
 * they never reach the CAS draft mirror. It must be account-scoped, purged on
 * account change, and wiped on logout exactly as the draft is.
 */
describe("collab offline buffer", () => {
  const A = "acct-aaaa";
  const B = "acct-bbbb";
  const OBJ = "obj-9999";

  beforeEach(() => localStorage.clear());

  const NONE = { title: "", body: "" };
  /** A buffer whose base is the server content it diverged from. */
  const buf = (content: { title: string; body: string }, base = NONE) => ({ content, base });

  it("round-trips the content AND the base it diverged from", () => {
    writeCollabBuffer(
      A,
      OBJ,
      buf({ title: "Draft", body: "typed while the socket was down" }, { title: "T", body: "old" }),
    );
    expect(readCollabBuffer(A, OBJ)).toEqual({
      content: { title: "Draft", body: "typed while the socket was down" },
      base: { title: "T", body: "old" },
    });
  });

  it("never persists an empty content with an empty base (it would stomp a fresh room)", () => {
    writeCollabBuffer(A, OBJ, buf(NONE, NONE));
    expect(readCollabBuffer(A, OBJ)).toBeNull();
    expect(localStorage.getItem(collabBufferKey(A, OBJ))).toBeNull();
  });

  it("PERSISTS an emptied content when the base is non-empty (an offline deletion)", () => {
    // The user deleted the whole note while offline; the server still holds it.
    // Dropping this buffer would silently revert the deletion on reload — the
    // base is the deletion's only evidence, so it must survive.
    writeCollabBuffer(A, OBJ, buf(NONE, { title: "Keep?", body: "server still has this" }));
    expect(readCollabBuffer(A, OBJ)).toEqual({
      content: NONE,
      base: { title: "Keep?", body: "server still has this" },
    });
  });

  it("a truly empty write clears an existing buffer", () => {
    writeCollabBuffer(A, OBJ, buf({ title: "x", body: "y" }));
    writeCollabBuffer(A, OBJ, buf(NONE, NONE));
    expect(readCollabBuffer(A, OBJ)).toBeNull();
  });

  it("reads a legacy content-only buffer as content with an empty base", () => {
    // A buffer a browser persisted before the base field existed.
    localStorage.setItem(
      collabBufferKey(A, OBJ),
      JSON.stringify({ title: "legacy", body: "old shape", savedAt: 1 }),
    );
    expect(readCollabBuffer(A, OBJ)).toEqual({
      content: { title: "legacy", body: "old shape" },
      base: NONE,
    });
  });

  it("clears on demand (the server now holds the text)", () => {
    writeCollabBuffer(A, OBJ, buf({ title: "x", body: "y" }));
    clearCollabBuffer(A, OBJ);
    expect(readCollabBuffer(A, OBJ)).toBeNull();
  });

  it("never hands one account another account's buffer, and deletes it on the way", () => {
    writeCollabBuffer(A, OBJ, buf({ title: "A private", body: "A body" }));
    expect(readCollabBuffer(B, OBJ)).toBeNull();
    expect(localStorage.getItem(collabBufferKey(A, OBJ))).toBeNull();
  });

  it("is purged when another member signs in (same wipe as the CAS draft)", () => {
    writeDraft(A, "o1", { body: "A draft" }, 1);
    writeCollabBuffer(A, "o2", buf({ title: "A", body: "A collab" }));
    writeCollabBuffer(B, "o3", buf({ title: "B", body: "B collab" }));

    // 2 of A's entries (one draft, one buffer) removed; B's buffer kept.
    expect(purgeForeignDrafts(B)).toBe(2);
    // Read B's first: reading as A would itself purge B (defense in depth).
    expect(readCollabBuffer(B, "o3")?.content.body).toBe("B collab");
    expect(localStorage.getItem(collabBufferKey(A, "o2"))).toBeNull();
  });

  it("is wiped on logout by clearAllDrafts", () => {
    writeDraft(A, "o1", { body: "draft" }, 1);
    writeCollabBuffer(A, "o2", buf({ title: "t", body: "buffer" }));
    expect(clearAllDrafts()).toBe(2);
    expect(readCollabBuffer(A, "o2")).toBeNull();
  });
});
