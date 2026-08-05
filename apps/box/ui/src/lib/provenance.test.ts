import { describe, expect, it } from "vitest";
import {
  attributeBody,
  attributeProp,
  attributionRuns,
  propsChangesByVersion,
  reasonForVersion,
  type HistoryEvent,
  type HistoryVersion,
} from "./provenance";

function createEvent(version: number, reason: string | null, actor = "alice"): HistoryEvent {
  return {
    seq: String(version),
    at: "2026-01-01T00:00:00Z",
    actor,
    actor_name: actor,
    kind: "create",
    payload: { version, reason },
  };
}
function updateEvent(
  version: number,
  reason: string | null,
  actor = "alice",
  seq?: string,
): HistoryEvent {
  return {
    seq: seq ?? String(version),
    at: "2026-01-02T00:00:00Z",
    actor,
    actor_name: actor,
    kind: "update",
    payload: { version, reason },
  };
}
function updatePropsEvent(
  seq: string,
  changed: Record<string, { old: unknown; new: unknown }>,
  reason: string | null,
  actor = "alice",
  version?: number,
): HistoryEvent {
  return {
    seq,
    at: "2026-01-03T00:00:00Z",
    actor,
    actor_name: actor,
    kind: "update_props",
    payload: version === undefined ? { changed, reason } : { changed, reason, version },
  };
}

describe("attributeProp", () => {
  it("attributes an unchanged property to the creation reason", () => {
    const a = attributeProp("tier", [createEvent(1, "seeded")]);
    expect(a).toEqual({
      actor: "alice",
      actorName: "alice",
      at: "2026-01-01T00:00:00Z",
      reason: "seeded",
    });
  });

  it("attributes a changed property to the update_props event that changed it", () => {
    const events = [
      createEvent(1, "seeded"),
      updatePropsEvent("5", { tier: { old: "silver", new: "gold" } }, "upgraded", "bob"),
    ];
    const a = attributeProp("tier", events);
    expect(a).toEqual({
      actor: "bob",
      actorName: "bob",
      at: "2026-01-03T00:00:00Z",
      reason: "upgraded",
    });
  });

  it("attributes a multiply-changed property to the LATEST update_props event that touched it", () => {
    const events = [
      createEvent(1, "seeded"),
      updatePropsEvent("5", { tier: { old: "silver", new: "gold" } }, "upgraded", "bob"),
      updatePropsEvent("9", { tier: { old: "gold", new: "platinum" } }, "corrected", "carol"),
    ];
    const a = attributeProp("tier", events);
    expect(a?.reason).toBe("corrected");
  });

  it("ignores update_props events for OTHER properties", () => {
    const events = [
      createEvent(1, "seeded"),
      updatePropsEvent("5", { seats: { old: 1, new: 2 } }, "grew", "bob"),
    ];
    const a = attributeProp("tier", events);
    expect(a?.reason).toBe("seeded");
  });
});

describe("attributeBody", () => {
  it("attributes a word from creation and a word appended later to their own reasons", () => {
    const events = [createEvent(1, "start"), updateEvent(2, "add greeting", "bob")];
    const versions: HistoryVersion[] = [
      {
        version: 1,
        at: "t1",
        by: "alice",
        by_name: "alice",
        snapshot: { title: null, body: "hello" },
      },
    ];
    const result = attributeBody("hello world", versions, events);
    const words = result.filter((t) => t.isWord);
    expect(words.map((w) => w.token)).toEqual(["hello", "world"]);
    expect(words[0]!.attribution?.reason).toBe("start");
    expect(words[1]!.attribution?.reason).toBe("add greeting");
  });

  it("a body never edited attributes every word to creation", () => {
    const events = [createEvent(1, "start")];
    const result = attributeBody("only ever this", [], events);
    const words = result.filter((t) => t.isWord);
    expect(words.length).toBeGreaterThan(0);
    expect(words.every((w) => w.attribution?.reason === "start")).toBe(true);
  });

  it("a rewrite attributes new words to that edit, unchanged words stay creation-attributed", () => {
    const events = [createEvent(1, "start"), updateEvent(2, "rewrote it", "bob")];
    const versions: HistoryVersion[] = [
      {
        version: 1,
        at: "t1",
        by: "alice",
        by_name: "alice",
        snapshot: { title: null, body: "old text here" },
      },
    ];
    const result = attributeBody("new text here", versions, events);
    const words = result.filter((t) => t.isWord);
    expect(words.find((w) => w.token === "new")!.attribution?.reason).toBe("rewrote it");
    expect(words.find((w) => w.token === "text")!.attribution?.reason).toBe("start");
    expect(words.find((w) => w.token === "here")!.attribution?.reason).toBe("start");
  });

  it("handles version arriving as a string (bigint over the wire) without string-concatenation", () => {
    // before_image.version is a Postgres bigint; the pg driver hands it back
    // as a string despite the declared `number` type. A bare `v.version + 1`
    // would silently produce "11" instead of 2 for this fixture.
    const events = [createEvent(1, "start"), updateEvent(2, "fixed", "bob")];
    const versions: HistoryVersion[] = [
      {
        version: "1" as unknown as number,
        at: "t1",
        by: "alice",
        by_name: "alice",
        snapshot: { title: null, body: "old" },
      },
    ];
    const result = attributeBody("new", versions, events);
    const words = result.filter((t) => t.isWord);
    expect(words.find((w) => w.token === "new")!.attribution?.reason).toBe("fixed");
  });

  it("two edits in a row attribute correctly even out of chronological input order", () => {
    const events = [
      updateEvent(3, "second", "carol"),
      createEvent(1, "start", "alice"),
      updateEvent(2, "first", "bob"),
    ];
    const versions: HistoryVersion[] = [
      { version: 2, at: "t2", by: "bob", by_name: "bob", snapshot: { title: null, body: "a b" } },
      { version: 1, at: "t1", by: "alice", by_name: "alice", snapshot: { title: null, body: "a" } },
    ];
    const result = attributeBody("a b c", versions, events);
    const words = result.filter((t) => t.isWord);
    expect(words.find((w) => w.token === "a")!.attribution?.reason).toBe("start");
    expect(words.find((w) => w.token === "b")!.attribution?.reason).toBe("first");
    expect(words.find((w) => w.token === "c")!.attribution?.reason).toBe("second");
  });

  it("a prepend (word inserted at the START) attributes only the new leading word to the edit", () => {
    const events = [createEvent(1, "start"), updateEvent(2, "add context up front", "bob")];
    const versions: HistoryVersion[] = [
      {
        version: 1,
        at: "t1",
        by: "alice",
        by_name: "alice",
        snapshot: { title: null, body: "middle" },
      },
    ];
    const result = attributeBody("start middle", versions, events);
    const words = result.filter((t) => t.isWord);
    expect(words.map((w) => w.token)).toEqual(["start", "middle"]);
    expect(words.find((w) => w.token === "start")!.attribution?.reason).toBe(
      "add context up front",
    );
    expect(words.find((w) => w.token === "middle")!.attribution?.reason).toBe("start");
  });

  it("an edit with no reason given attributes to a null reason, not a crash", () => {
    const events = [createEvent(1, "start"), updateEvent(2, null, "bob")];
    const versions: HistoryVersion[] = [
      {
        version: 1,
        at: "t1",
        by: "alice",
        by_name: "alice",
        snapshot: { title: null, body: "old" },
      },
    ];
    const result = attributeBody("new", versions, events);
    const words = result.filter((t) => t.isWord);
    expect(words[0]!.attribution?.actorName).toBe("bob");
    expect(words[0]!.attribution?.reason).toBeNull();
  });

  it("a null body with no history attributes nothing (no words, no crash)", () => {
    const result = attributeBody(null, [], [createEvent(1, "start")]);
    expect(result.filter((t) => t.isWord)).toEqual([]);
  });

  it("a very large body diff finishes fast and stays correct, instead of hanging on O(n*m) LCS", () => {
    // Word-level LCS is O(n*m) time+space. Two ~8000-word bodies is 64M+
    // DP cells — enough to make a naive diff visibly hang. This must
    // complete quickly via the size-guarded fallback, not the full LCS.
    const bigOld = Array.from({ length: 8000 }, (_, i) => `word${i}`).join(" ");
    const bigNewDifferent = Array.from({ length: 8000 }, (_, i) => `changed${i}`).join(" ");
    const events = [createEvent(1, "start"), updateEvent(2, "big rewrite", "bob")];
    const versions: HistoryVersion[] = [
      {
        version: 1,
        at: "t1",
        by: "alice",
        by_name: "alice",
        snapshot: { title: null, body: bigOld },
      },
    ];

    const startedAt = Date.now();
    const result = attributeBody(bigNewDifferent, versions, events);
    expect(Date.now() - startedAt).toBeLessThan(2000);

    const words = result.filter((t) => t.isWord);
    expect(words).toHaveLength(8000);
    // Too large to diff word-by-word, so the whole new body is attributed to
    // the edit that produced it — coarse, but correct and fast.
    expect(words.every((w) => w.attribution?.reason === "big rewrite")).toBe(true);
  });

  it("a very large UNCHANGED body carries origins over instead of re-attributing everything", () => {
    const bigBody = Array.from({ length: 8000 }, (_, i) => `word${i}`).join(" ");
    const events = [createEvent(1, "start"), updateEvent(2, "touched something else", "bob")];
    const versions: HistoryVersion[] = [
      {
        version: 1,
        at: "t1",
        by: "alice",
        by_name: "alice",
        snapshot: { title: null, body: bigBody },
      },
    ];
    // Body text is byte-identical across the transition (e.g. only a prop
    // changed) — every word should still trace back to creation, not v2.
    const result = attributeBody(bigBody, versions, events);
    const words = result.filter((t) => t.isWord);
    expect(words.every((w) => w.attribution?.reason === "start")).toBe(true);
  });
});

describe("attributionRuns", () => {
  it("merges consecutive same-origin words into one run, not one run per word", () => {
    const events = [createEvent(1, "start"), updateEvent(2, "add greeting", "bob")];
    const versions: HistoryVersion[] = [
      {
        version: 1,
        at: "t1",
        by: "alice",
        by_name: "alice",
        snapshot: { title: null, body: "hello" },
      },
    ];
    // "hello" (v1) + " world wide" (v2 addition) -> two runs, not five tokens.
    const runs = attributionRuns("hello world wide", versions, events);
    expect(runs.map((r) => r.text)).toEqual(["hello", " world wide"]);
    expect(runs[0]!.attribution?.reason).toBe("start");
    expect(runs[1]!.attribution?.reason).toBe("add greeting");
  });

  it("run offsets are exact character positions into the current body", () => {
    const events = [createEvent(1, "start"), updateEvent(2, "rewrote it", "bob")];
    const versions: HistoryVersion[] = [
      {
        version: 1,
        at: "t1",
        by: "alice",
        by_name: "alice",
        snapshot: { title: null, body: "old text here" },
      },
    ];
    const body = "new text here";
    const runs = attributionRuns(body, versions, events);
    for (const r of runs) {
      expect(body.slice(r.start, r.end)).toBe(r.text);
    }
  });

  it("an unedited body collapses to a single run covering the whole thing", () => {
    const events = [createEvent(1, "start")];
    const runs = attributionRuns("only ever this", [], events);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe("only ever this");
    expect(runs[0]!.attribution?.reason).toBe("start");
  });

  it("a null body produces no runs", () => {
    expect(attributionRuns(null, [], [createEvent(1, "start")])).toEqual([]);
  });
});

describe("reasonForVersion", () => {
  it("finds the create/update event that produced a given version", () => {
    const events = [createEvent(1, "seeded"), updateEvent(2, "fixed", "bob")];
    expect(reasonForVersion(1, events)?.reason).toBe("seeded");
    expect(reasonForVersion(2, events)?.reason).toBe("fixed");
    expect(reasonForVersion(3, events)).toBeNull();
  });
});

describe("propsChangesByVersion", () => {
  it("matches an update_props event to the nearest preceding update event's version", () => {
    const events = [
      createEvent(1, "seeded", "alice"),
      updateEvent(2, "upgraded", "bob", "10"),
      updatePropsEvent("11", { tier: { old: "silver", new: "gold" } }, "upgraded", "bob"),
    ];
    const grouped = propsChangesByVersion(events);
    expect(grouped.size).toBe(1);
    const entry = grouped.get(2)!;
    expect(entry.changes).toEqual([{ key: "tier", old: "silver", new: "gold" }]);
    expect(entry.attribution.reason).toBe("upgraded");
  });

  it("groups multiple changed props from the same event together", () => {
    const events = [
      createEvent(1, "seeded"),
      updateEvent(2, "batch update", "bob", "10"),
      updatePropsEvent(
        "11",
        { tier: { old: "silver", new: "gold" }, seats: { old: 1, new: 5 } },
        "batch update",
        "bob",
      ),
    ];
    const grouped = propsChangesByVersion(events);
    const entry = grouped.get(2)!;
    expect(entry.changes).toHaveLength(2);
    expect(entry.changes.map((c) => c.key).sort()).toEqual(["seats", "tier"]);
  });

  it("keeps two separate props edits distinct, each under its own version", () => {
    const events = [
      createEvent(1, "seeded"),
      updateEvent(2, "upgraded tier", "bob", "10"),
      updatePropsEvent("11", { tier: { old: "silver", new: "gold" } }, "upgraded tier", "bob"),
      updateEvent(3, "added seats", "carol", "20"),
      updatePropsEvent("21", { seats: { old: 1, new: 5 } }, "added seats", "carol"),
    ];
    const grouped = propsChangesByVersion(events);
    expect(grouped.size).toBe(2);
    expect(grouped.get(2)!.changes).toEqual([{ key: "tier", old: "silver", new: "gold" }]);
    expect(grouped.get(3)!.changes).toEqual([{ key: "seats", old: 1, new: 5 }]);
    expect(grouped.get(3)!.attribution.reason).toBe("added seats");
  });

  it("prefers a stamped payload.version (0027) over the seq-proximity heuristic, even when they'd disagree", () => {
    const events = [
      createEvent(1, "seeded"),
      // An 'update' event sits right before the update_props event by seq —
      // the OLD heuristic would match to version 2. The stamped version (3)
      // must win instead.
      updateEvent(2, "unrelated title change", "bob", "10"),
      updatePropsEvent(
        "11",
        { tier: { old: "silver", new: "gold" } },
        "exact stamp",
        "carol",
        3, // stamped version, disagrees with what seq-proximity would pick
      ),
    ];
    const grouped = propsChangesByVersion(events);
    expect(grouped.has(2)).toBe(false);
    expect(grouped.get(3)!.changes).toEqual([{ key: "tier", old: "silver", new: "gold" }]);
    expect(grouped.get(3)!.attribution.reason).toBe("exact stamp");
  });

  it("skips private-redacted update_props events (no changed payload)", () => {
    const events: HistoryEvent[] = [
      createEvent(1, "seeded"),
      updateEvent(2, "secret change", "bob", "10"),
      {
        seq: "11",
        at: "2026-01-03T00:00:00Z",
        actor: "bob",
        actor_name: "bob",
        kind: "update_props",
        payload: { private: true },
      },
    ];
    const grouped = propsChangesByVersion(events);
    expect(grouped.size).toBe(0);
  });
});
