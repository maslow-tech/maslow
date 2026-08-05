import { describe, expect, it, vi } from "vitest";

import { ApiError, ConflictError, type LinkObjectInput, type PatchObjectInput } from "../api";
import { buildSpatialHash } from "./renderer";
import {
  BULK_MAX,
  MARQUEE_MIN_PX,
  applyBulkRow,
  bulkSummaryLine,
  canBulkMutate,
  classifyBulkError,
  coerceBulkValue,
  confirmLine,
  indicesInScreenRect,
  isMarqueeRect,
  isRetryable,
  isValidPropKey,
  isValidRel,
  marqueeArmed,
  marqueeMode,
  nextSelection,
  planBulkRows,
  rectFromPoints,
  runBulk,
  summarizeBulk,
  type BulkIntent,
  type BulkRow,
  type BulkTarget,
  type BulkWriter,
} from "./selection";

/**
 * What these pin is the selection surface's CONTRACT — the four rules the
 * module header commits to, each of which is a way bulk editing goes wrong:
 *
 *  - one transaction per object, each against ITS OWN freshly-read
 *    `baseVersion` (a shared version is a batch that cannot report which
 *    object it lost);
 *  - a link row's idempotency key is minted once and REUSED by every retry
 *    (links never bump a version, so the key is the only thing standing
 *    between a retried row and a second write);
 *  - a per-object 409 lands on that object's row and nowhere else — the other
 *    rows still succeed and the batch reports the partial result;
 *  - a viewer may select but may not write.
 */

/* ------------------------------------------------------------------ *
 * marquee
 * ------------------------------------------------------------------ */

describe("marquee geometry", () => {
  it("normalizes a rect dragged in any direction", () => {
    expect(rectFromPoints(10, 10, 40, 30)).toEqual({ x: 10, y: 10, width: 30, height: 20 });
    expect(rectFromPoints(40, 30, 10, 10)).toEqual({ x: 10, y: 10, width: 30, height: 20 });
  });

  it("treats a wobbled click as no marquee at all", () => {
    expect(isMarqueeRect(rectFromPoints(10, 10, 12, 11))).toBe(false);
    expect(isMarqueeRect(rectFromPoints(10, 10, 10 + MARQUEE_MIN_PX, 10))).toBe(true);
  });
});

describe("marqueeMode", () => {
  it("needs alt — a bare drag is the camera, and shift stays click-toggle", () => {
    expect(marqueeMode({ altKey: false, shiftKey: false })).toBeNull();
    expect(marqueeMode({ altKey: false, shiftKey: true })).toBeNull();
    expect(marqueeArmed({ altKey: false, shiftKey: false })).toBe(false);
  });

  it("alt replaces, alt+shift adds", () => {
    expect(marqueeMode({ altKey: true, shiftKey: false })).toBe("replace");
    expect(marqueeMode({ altKey: true, shiftKey: true })).toBe("add");
    expect(marqueeArmed({ altKey: true, shiftKey: false })).toBe(true);
  });

  it("leaves meta and ctrl alone — those are the path picker and a right-click", () => {
    expect(marqueeMode({ altKey: true, shiftKey: false, metaKey: true })).toBeNull();
    expect(marqueeMode({ altKey: true, shiftKey: false, ctrlKey: true })).toBeNull();
  });
});

describe("indicesInScreenRect", () => {
  // Four nodes on a line at world x = 0, 100, 200, 300.
  const xy = new Float32Array([0, 0, 100, 0, 200, 0, 300, 0]);
  const hash = buildSpatialHash(xy, 4, 80);
  const identity = (sx: number, sy: number) => ({ x: sx, y: sy });

  it("returns exactly the nodes inside the rect, ascending", () => {
    const got = indicesInScreenRect(hash, xy, { x: 90, y: -10, width: 120, height: 20 }, identity);
    expect(got).toEqual([1, 2]);
  });

  it("is precise, not cell-granular — a rect between two nodes selects none", () => {
    expect(
      indicesInScreenRect(hash, xy, { x: 110, y: -10, width: 40, height: 20 }, identity),
    ).toEqual([]);
  });

  it("uses the projection it was handed, so the camera is honoured", () => {
    // A 2× zoom: one screen pixel is half a world unit.
    const zoomed = (sx: number, sy: number) => ({ x: sx / 2, y: sy / 2 });
    const got = indicesInScreenRect(hash, xy, { x: 0, y: -10, width: 220, height: 20 }, zoomed);
    expect(got).toEqual([0, 1]);
  });
});

describe("nextSelection", () => {
  it("replaces, adds and toggles", () => {
    const prev = new Set([1, 2]);
    expect([...nextSelection(prev, [3], "replace")]).toEqual([3]);
    expect([...nextSelection(prev, [3], "add")].sort()).toEqual([1, 2, 3]);
    expect([...nextSelection(prev, [2], "toggle")]).toEqual([1]);
  });
});

/* ------------------------------------------------------------------ *
 * planning
 * ------------------------------------------------------------------ */

const target = (id: string, title: string | null = id, index = 0): BulkTarget => ({
  index,
  id,
  title,
  type: "note",
});

describe("planBulkRows", () => {
  it("mints exactly one idempotency key per object", () => {
    let n = 0;
    const rows = planBulkRows([target("a"), target("b", "b", 1)], () => `k${(n += 1)}`);
    expect(rows.map((r) => r.idempotencyKey)).toEqual(["k1", "k2"]);
    expect(rows.every((r) => r.state === "queued" && r.attempts === 0)).toBe(true);
  });

  it("never plans the same object twice", () => {
    const rows = planBulkRows([target("a"), target("a")], () => "k");
    expect(rows).toHaveLength(1);
  });
});

describe("coerceBulkValue", () => {
  it("does not sniff a type out of the text", () => {
    expect(coerceBulkValue("text", "0912")).toEqual({ ok: true, value: "0912", error: null });
    expect(coerceBulkValue("text", "false")).toEqual({ ok: true, value: "false", error: null });
  });

  it("parses the kind that was asked for, and refuses what it cannot", () => {
    expect(coerceBulkValue("number", " 42 ").value).toBe(42);
    expect(coerceBulkValue("number", "abc").ok).toBe(false);
    expect(coerceBulkValue("boolean", "TRUE").value).toBe(true);
    expect(coerceBulkValue("boolean", "maybe").ok).toBe(false);
  });

  it("clears with an explicit null — the patch route's delete-this-key", () => {
    expect(coerceBulkValue("clear", "anything")).toEqual({ ok: true, value: null, error: null });
  });
});

describe("key and verb shapes", () => {
  it("accepts identifiers and refuses the rest", () => {
    expect(isValidPropKey("status")).toBe(true);
    expect(isValidPropKey("owner_id")).toBe(true);
    expect(isValidPropKey("")).toBe(false);
    expect(isValidPropKey("2fast")).toBe(false);
    expect(isValidPropKey("drop table")).toBe(false);
    expect(isValidRel("about")).toBe(true);
    expect(isValidRel("about it")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * the CAS driver
 * ------------------------------------------------------------------ */

interface Recorder {
  writer: BulkWriter;
  reads: string[];
  patches: Array<{ id: string; patch: PatchObjectInput }>;
  links: Array<{ id: string; input: LinkObjectInput }>;
}

/** A fake box. `versions` is what each object's read answers. */
function recorder(
  versions: Record<string, number> = {},
  fail: (id: string, attempt: number) => unknown | null = () => null,
): Recorder {
  const attempts = new Map<string, number>();
  const reads: string[] = [];
  const patches: Array<{ id: string; patch: PatchObjectInput }> = [];
  const links: Array<{ id: string; input: LinkObjectInput }> = [];
  const bump = (id: string): number => {
    const n = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, n);
    return n;
  };
  return {
    reads,
    patches,
    links,
    writer: {
      readVersion: async (id) => {
        reads.push(id);
        return versions[id] ?? 1;
      },
      patch: async (id, patch) => {
        const boom = fail(id, bump(id));
        if (boom) throw boom;
        patches.push({ id, patch });
        return { id, version: patch.baseVersion + 1 };
      },
      link: async (id, input) => {
        const boom = fail(id, bump(id));
        if (boom) throw boom;
        links.push({ id, input });
        return { from: id, rel: input.rel, to: input.to };
      },
    },
  };
}

const propIntent: BulkIntent = { kind: "prop", key: "status", value: "done" };
const linkIntent: BulkIntent = { kind: "link", to: "hub", toTitle: "The hub", rel: "about" };

describe("runBulk — property set", () => {
  it("writes ONE transaction per object, each with that object's own baseVersion", async () => {
    const r = recorder({ a: 3, b: 11, c: 7 });
    const rows = planBulkRows([target("a"), target("b"), target("c")], () => "k");
    const out = await runBulk(propIntent, rows, { writer: r.writer, concurrency: 1 });

    expect(out.every((row) => row.state === "done")).toBe(true);
    expect(r.reads).toEqual(["a", "b", "c"]);
    expect(r.patches).toEqual([
      { id: "a", patch: { baseVersion: 3, props: { status: "done" } } },
      { id: "b", patch: { baseVersion: 11, props: { status: "done" } } },
      { id: "c", patch: { baseVersion: 7, props: { status: "done" } } },
    ]);
  });

  it("sends only the one changed key, so a disjoint edit elsewhere survives", async () => {
    const r = recorder({ a: 1 });
    await runBulk({ kind: "prop", key: "owner", value: null }, planBulkRows([target("a")]), {
      writer: r.writer,
    });
    expect(r.patches[0]?.patch.props).toEqual({ owner: null });
    expect(r.patches[0]?.patch).not.toHaveProperty("body");
    expect(r.patches[0]?.patch).not.toHaveProperty("title");
  });

  it("surfaces one object's 409 on THAT row and still writes the others", async () => {
    const r = recorder({ a: 1, b: 2, c: 3 }, (id) =>
      id === "b" ? new ConflictError("conflict", 9, null) : null,
    );
    const out = await runBulk(propIntent, planBulkRows([target("a"), target("b"), target("c")]), {
      writer: r.writer,
      concurrency: 1,
    });

    expect(out.map((row) => row.state)).toEqual(["done", "conflict", "done"]);
    expect(out[1]?.currentVersion).toBe(9);
    expect(out[1]?.message).toContain("v9");
    // Partial success is reported, never swallowed.
    const summary = summarizeBulk(out);
    expect(summary).toMatchObject({ total: 3, done: 2, conflicts: 1, failed: 0, finished: true });
    expect(bulkSummaryLine(summary)).toBe("2 of 3 written · 1 changed underneath you");
  });

  it("retrying re-runs only the unsettled rows, and re-reads their version", async () => {
    let firstPass = true;
    const r = recorder({ a: 1, b: 2 }, (id) =>
      id === "b" && firstPass ? new ConflictError("conflict", 5, null) : null,
    );
    const rows = planBulkRows([target("a"), target("b")]);
    const first = await runBulk(propIntent, rows, { writer: r.writer, concurrency: 1 });
    expect(first.map((row) => row.state)).toEqual(["done", "conflict"]);

    firstPass = false;
    const second = await runBulk(propIntent, first, { writer: r.writer, concurrency: 1 });

    expect(second.map((row) => row.state)).toEqual(["done", "done"]);
    // "a" was already done: not read again, not written again.
    expect(r.reads).toEqual(["a", "b", "b"]);
    expect(r.patches.map((p) => p.id)).toEqual(["a", "b"]);
    expect(second[1]?.attempts).toBe(2);
  });
});

describe("runBulk — link all to…", () => {
  it("uses the ROW's idempotency key, and the same one on every retry", async () => {
    let firstPass = true;
    const r = recorder({}, (id) => (firstPass && id === "b" ? new ApiError(503, "down") : null));
    let n = 0;
    const rows = planBulkRows([target("a"), target("b")], () => `key-${(n += 1)}`);

    const first = await runBulk(linkIntent, rows, { writer: r.writer, concurrency: 1 });
    expect(first.map((row) => row.state)).toEqual(["done", "error"]);
    expect(r.links).toEqual([
      { id: "a", input: { to: "hub", rel: "about", idempotencyKey: "key-1" } },
    ]);

    firstPass = false;
    const second = await runBulk(linkIntent, first, { writer: r.writer, concurrency: 1 });
    expect(second.map((row) => row.state)).toEqual(["done", "done"]);
    // The retry re-used key-2 — a fresh key here is a duplicated write, and a
    // link cannot 409 to catch it.
    expect(r.links[1]).toEqual({
      id: "b",
      input: { to: "hub", rel: "about", idempotencyKey: "key-2" },
    });
  });

  it("never reads a version — a link edit has none to compare against", async () => {
    const r = recorder();
    await runBulk(linkIntent, planBulkRows([target("a")]), { writer: r.writer });
    expect(r.reads).toEqual([]);
    expect(r.patches).toEqual([]);
  });

  it("skips the link target when it is itself in the selection", async () => {
    const r = recorder();
    const out = await runBulk(linkIntent, planBulkRows([target("a"), target("hub")]), {
      writer: r.writer,
      concurrency: 1,
    });
    expect(out.map((row) => row.state)).toEqual(["done", "skipped"]);
    expect(r.links.map((l) => l.id)).toEqual(["a"]);
    // A skipped row is terminal — a retry pass leaves it alone.
    const again = await runBulk(linkIntent, out, { writer: r.writer });
    expect(again[1]?.state).toBe("skipped");
  });
});

describe("runBulk — reporting", () => {
  it("reports progress as rows change state, never only at the end", async () => {
    const r = recorder({ a: 1, b: 1 });
    const seen: string[][] = [];
    await runBulk(propIntent, planBulkRows([target("a"), target("b")]), {
      writer: r.writer,
      concurrency: 1,
      onProgress: (rows) => seen.push(rows.map((row) => row.state)),
    });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toEqual(["done", "done"]);
  });

  it("never rejects — one object's thrown error is that object's row", async () => {
    const r = recorder({ a: 1 }, () => new Error("boom"));
    const out = await runBulk(propIntent, planBulkRows([target("a")]), { writer: r.writer });
    expect(out[0]?.state).toBe("error");
    expect(out[0]?.message).toBe("boom");
    expect(isRetryable(out[0]!)).toBe(true);
  });

  it("stops when asked, leaving the untouched rows queued", async () => {
    const r = recorder({ a: 1, b: 1 });
    const out = await runBulk(propIntent, planBulkRows([target("a"), target("b")]), {
      writer: r.writer,
      concurrency: 1,
      shouldStop: () => true,
    });
    expect(out.map((row) => row.state)).toEqual(["queued", "queued"]);
    expect(summarizeBulk(out).finished).toBe(false);
  });
});

describe("classifyBulkError", () => {
  it("calls a 409 with a version a conflict, and carries the version back", () => {
    const got = classifyBulkError(new ConflictError("lost", 12, null));
    expect(got.state).toBe("conflict");
    expect(got.currentVersion).toBe(12);
  });

  it("does NOT call a 404 a conflict — that would be prose leaking what a 409 refuses to", () => {
    const got = classifyBulkError(new ApiError(404, "not_found"));
    expect(got.state).toBe("error");
    expect(got.currentVersion).toBeNull();
    expect(got.message).toBe("gone, or no longer visible to you");
  });

  it("explains a refusal rather than offering a rebase that cannot work", () => {
    const got = classifyBulkError(new ConflictError("locked", null, null, "open_in_editor"));
    expect(got.state).toBe("error");
    expect(got.message).toContain("editor");
  });
});

describe("applyBulkRow", () => {
  it("counts an attempt per try, so a row can say how hard it tried", async () => {
    const r = recorder({ a: 1 });
    const row: BulkRow = planBulkRows([target("a")])[0]!;
    const once = await applyBulkRow(propIntent, row, r.writer);
    expect(once.attempts).toBe(1);
    const twice = await applyBulkRow(propIntent, once, r.writer);
    expect(twice.attempts).toBe(2);
  });
});

describe("confirmLine", () => {
  it("says the count, the change and that nothing is undone for you", () => {
    expect(confirmLine(propIntent, 14)).toContain("14 objects");
    expect(confirmLine(propIntent, 14)).toContain("nothing is undone automatically");
    expect(confirmLine(propIntent, 1)).toContain("1 object.");
    expect(confirmLine(linkIntent, 3)).toContain("The hub");
    expect(confirmLine({ kind: "prop", key: "owner", value: null }, 2)).toContain("Clear");
  });
});

describe("canBulkMutate", () => {
  it("lets a member and an owner write, and never a viewer", () => {
    expect(canBulkMutate({ role: "owner" })).toBe(true);
    expect(canBulkMutate({ role: "member" })).toBe(true);
    expect(canBulkMutate({ role: "viewer" })).toBe(false);
    expect(canBulkMutate(null)).toBe(false);
  });

  it("is read-only in the demo bundle, which has no box behind it", () => {
    vi.stubEnv("VITE_DEMO", "1");
    try {
      expect(canBulkMutate({ role: "owner" })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("BULK_MAX", () => {
  it("is a real cap, not a comment", () => {
    expect(BULK_MAX).toBeGreaterThan(0);
    expect(BULK_MAX).toBeLessThanOrEqual(1000);
  });
});
