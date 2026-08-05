import { describe, expect, it } from "vitest";

import {
  applySnapshot,
  carryDeniedRoomContent,
  collabConflictFields,
  diffKeys,
  fieldNames,
  saveLabel,
} from "./ObjectView";

/**
 * The object page's pure decisions, tested without a DOM: what the header says
 * about the save, and how a field-granular draft lands on a snapshot.
 */
describe("carryDeniedRoomContent — never wipe a loaded body on a pre-sync denial", () => {
  it("does NOT carry an empty doc that never synced (the fleet-wide wipe)", () => {
    // A room denied before its first sync (BAD_ORIGIN / ROOM_FORBIDDEN / the
    // fail-closed authorizeRoom skeleton) holds nothing. Carrying "" over the
    // real note would destroy it — so the loaded draft is left alone.
    expect(carryDeniedRoomContent(false, { title: "", body: "" })).toBe(false);
  });

  it("carries offline text typed before the first sync, so it is not stranded", () => {
    expect(carryDeniedRoomContent(false, { title: "", body: "typed offline" })).toBe(true);
    expect(carryDeniedRoomContent(false, { title: "Draft", body: "" })).toBe(true);
  });

  it("carries a synced room's content even when it is legitimately empty", () => {
    // The room held the server's body at least once; an empty note is a real
    // empty note, and denial hands it back to CAS as such.
    expect(carryDeniedRoomContent(true, { title: "", body: "" })).toBe(true);
    expect(carryDeniedRoomContent(true, { title: "T", body: "b" })).toBe(true);
  });
});

describe("saveLabel", () => {
  it("lets offline outrank everything, because it explains everything", () => {
    expect(saveLabel({ kind: "saving", fields: ["body"], attempt: 1 }, false, true, false)).toEqual(
      {
        text: "offline — kept locally",
        tone: "warn",
      },
    );
  });

  it("shows conflict over an in-flight save, in the alarm (danger) tone", () => {
    expect(saveLabel({ kind: "saving", fields: ["body"], attempt: 1 }, true, true, false)).toEqual({
      text: "conflict",
      tone: "danger",
    });
  });

  it("names the editor lock distinctly, in the alarm (danger) tone", () => {
    expect(saveLabel({ kind: "idle" }, true, false, true)).toEqual({
      text: "locked by the editor",
      tone: "danger",
    });
  });

  it("reads saving → saved → nothing", () => {
    expect(saveLabel({ kind: "dirty", fields: ["title"] }, true, false, false)?.text).toBe(
      "unsaved",
    );
    expect(
      saveLabel({ kind: "saving", fields: ["title"], attempt: 1 }, true, false, false)?.text,
    ).toBe("saving…");
    expect(
      saveLabel({ kind: "rebasing", baseVersion: 4, attempt: 1 }, true, false, false)?.text,
    ).toBe("saving…");
    expect(saveLabel({ kind: "saved", version: 5 }, true, false, false)?.text).toBe("saved");
    expect(saveLabel({ kind: "idle" }, true, false, false)).toBeNull();
  });

  it("never claims a failed save landed — a failed save is the alarm (danger) tone", () => {
    expect(saveLabel({ kind: "error", status: 500, message: "boom" }, true, false, false)).toEqual({
      text: "not saved — kept locally",
      tone: "danger",
    });
  });

  it("keeps the offline/reconnecting 'kept locally' states in the calm (warn) tone, not alarm", () => {
    // These reassure the user their work is safe; wearing the alarm red would
    // read as data loss during a routine box self-update.
    expect(saveLabel({ kind: "idle" }, false, false, false)?.tone).toBe("warn");
    expect(saveLabel({ kind: "idle" }, true, false, false, "offline")?.tone).toBe("warn");
    expect(saveLabel({ kind: "idle" }, true, false, false, "connecting")?.tone).toBe("warn");
  });

  it("reflects the live room's socket state, which the CAS `save` can't", () => {
    const idle = { kind: "idle" } as const;
    // A live room persists body/title over the socket even while CAS is idle.
    expect(saveLabel(idle, true, false, false, "live")?.text).toBe("synced");
    // A down socket is invisible to navigator.onLine — surface it anyway.
    expect(saveLabel(idle, true, false, false, "offline")).toEqual({
      text: "reconnecting — kept locally",
      tone: "warn",
    });
    expect(saveLabel(idle, true, false, false, "connecting")?.tone).toBe("warn");
    // A DENIED room owns nothing — body/title are back on CAS, so the label
    // tracks the CAS save state, not a bare "disconnected" that hides it. Idle
    // shows nothing (as single-player does); an active CAS save shows through.
    expect(saveLabel(idle, true, false, false, "denied")).toBeNull();
    expect(
      saveLabel({ kind: "saving", fields: ["body"], attempt: 1 }, true, false, false, "denied")
        ?.text,
    ).toBe("saving…");
    expect(saveLabel({ kind: "saved", version: 5 }, true, false, false, "denied")?.text).toBe(
      "saved",
    );
    expect(
      saveLabel({ kind: "error", status: 401, message: "no" }, true, false, false, "denied")?.text,
    ).toBe("not saved — kept locally");
    // No room ⇒ single-player behaviour unchanged (idle shows nothing).
    expect(saveLabel(idle, true, false, false, null)).toBeNull();
  });
});

describe("collabConflictFields", () => {
  it("names only the room fields that actually diverged", () => {
    expect(
      collabConflictFields({
        mine: { title: "A", body: "same" },
        theirs: { title: "B", body: "same" },
      }),
    ).toEqual(["title"]);
    expect(
      collabConflictFields({
        mine: { title: "same", body: "mine" },
        theirs: { title: "same", body: "theirs" },
      }),
    ).toEqual(["body"]);
    expect(
      collabConflictFields({
        mine: { title: "x", body: "y" },
        theirs: { title: "x", body: "y" },
      }),
    ).toEqual([]);
  });
});

describe("applySnapshot", () => {
  const base = { title: "t", body: "b", props: { a: 1, b: 2 } };

  it("applies only the fields the draft carries", () => {
    expect(applySnapshot(base, { body: "b2" })).toEqual({
      title: "t",
      body: "b2",
      props: { a: 1, b: 2 },
    });
  });

  it("treats a null prop as the delete it is", () => {
    expect(applySnapshot(base, { props: { a: null } }).props).toEqual({ b: 2 });
  });

  it("does not mutate the snapshot it was given", () => {
    applySnapshot(base, { props: { a: 9 } });
    expect(base.props["a"]).toBe(1);
  });

  it("keeps an explicit null title as untitled", () => {
    expect(applySnapshot(base, { title: null }).title).toBeNull();
  });
});

describe("fieldNames", () => {
  it("names props key by key, not as one 'props' blob", () => {
    expect(fieldNames({ title: "x", props: { stage: "won" } })).toEqual(["title", "props.stage"]);
  });
});

describe("diffKeys", () => {
  it("ignores keys that agree, absent or not", () => {
    expect(diffKeys({ a: 1, b: null }, { a: 1 })).toEqual([]);
  });

  it("reports keys that differ on either side", () => {
    expect(diffKeys({ a: 1 }, { a: 2, c: "x" }).sort()).toEqual(["a", "c"]);
  });

  it("compares structured values by content", () => {
    expect(diffKeys({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
  });
});
