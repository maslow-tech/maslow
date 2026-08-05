import { describe, expect, it } from "vitest";
import {
  ANIMATION_MAX_GAP_MS,
  ANIMATION_MIN_GAP_MS,
  ANIMATION_TOTAL_CAP_MS,
  maxChunksFor,
  planAnimation,
  positionFor,
  type AnimationHunk,
  type AnimationPlan,
} from "./animate.js";

/**
 * Three properties, and every assertion below is one of them:
 *
 *  - the animation NEVER changes the write. Concatenate the chunks and you have
 *    the input diff, each hunk exactly once, whatever path was taken;
 *  - the duration is capped whatever the hunk count — 1, 10 or 400 — because a
 *    room's flushes are suspended for the whole window;
 *  - the fast paths (reduced motion, nobody watching) collapse to the phase-2
 *    behaviour: one chunk, one transaction, no timer.
 */

interface TestHunk extends AnimationHunk {
  readonly id: number;
}

const WATCHED = { humanViewers: 2 } as const;

function hunks(n: number, spacing = 10): TestHunk[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    anchor: i * spacing,
    head: i * spacing + 4,
  }));
}

/** Every hunk that came out of the plan, in the order the chunks apply them. */
function flatten<H extends AnimationHunk>(plan: AnimationPlan<H>): H[] {
  return plan.chunks.flatMap((chunk) => [...chunk.hunks]);
}

function ids(plan: AnimationPlan<TestHunk>): number[] {
  return flatten(plan).map((hunk) => hunk.id);
}

/* -------------------------------------------------------------- duration cap */

describe("duration cap", () => {
  it.each([1, 2, 3, 10, 31, 32, 400, 5_000])("holds for %i hunks", (n) => {
    const plan = planAnimation(hunks(n), WATCHED);
    expect(plan.totalMs).toBeLessThanOrEqual(ANIMATION_TOTAL_CAP_MS);
    const last = plan.chunks[plan.chunks.length - 1];
    expect(last?.atMs).toBeLessThanOrEqual(ANIMATION_TOTAL_CAP_MS);
    expect(plan.totalMs).toBe(last?.atMs);
  });

  it("keeps every gap inside the legible band", () => {
    for (const n of [2, 5, 10, 20, 31, 400]) {
      const plan = planAnimation(hunks(n), WATCHED);
      expect(plan.gapMs).toBeGreaterThanOrEqual(ANIMATION_MIN_GAP_MS);
      expect(plan.gapMs).toBeLessThanOrEqual(ANIMATION_MAX_GAP_MS);
      for (const [i, chunk] of plan.chunks.entries()) {
        expect(chunk.delayMs).toBe(i === 0 ? 0 : plan.gapMs);
        expect(chunk.atMs).toBe(i * plan.gapMs);
      }
    }
  });

  it("merges hunks rather than adding chunks once the budget is spent", () => {
    const cap = maxChunksFor();
    const small = planAnimation(hunks(3), WATCHED);
    expect(small.chunks).toHaveLength(3);
    expect(small.chunks.every((chunk) => chunk.hunks.length === 1)).toBe(true);

    const huge = planAnimation(hunks(400), WATCHED);
    expect(huge.chunks).toHaveLength(cap);
    // 400 hunks over 31 chunks: sizes differ by at most one, none empty.
    const sizes = huge.chunks.map((chunk) => chunk.hunks.length);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(400);
  });

  it("a single hunk is one chunk with no wait", () => {
    const plan = planAnimation(hunks(1), WATCHED);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.mode).toBe("animated");
    expect(plan.totalMs).toBe(0);
    expect(plan.chunks[0]?.delayMs).toBe(0);
  });

  it("honours an overridden budget", () => {
    const timing = { minGapMs: 10, maxGapMs: 20, totalCapMs: 100 };
    const plan = planAnimation(hunks(400), { ...WATCHED, timing });
    expect(plan.chunks).toHaveLength(maxChunksFor(timing));
    expect(plan.totalMs).toBeLessThanOrEqual(100);
    expect(plan.gapMs).toBeGreaterThanOrEqual(10);
    expect(plan.gapMs).toBeLessThanOrEqual(20);
    expect(ids(plan)).toEqual(hunks(400).map((hunk) => hunk.id));
  });
});

/* ----------------------------------------------------------------- ordering */

describe("ordering", () => {
  it("orders by document position, not arrival order", () => {
    // The markdown bridge walks its plan descending so indices stay valid; a
    // cursor has to read top to bottom.
    const shuffled = [...hunks(10)].reverse();
    const plan = planAnimation(shuffled, WATCHED);
    expect(ids(plan)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const anchors = flatten(plan).map((hunk) => hunk.anchor);
    expect([...anchors].sort((a, b) => a - b)).toEqual(anchors);
  });

  it("breaks ties by range width then by arrival, deterministically", () => {
    const tied: TestHunk[] = [
      { id: 0, anchor: 12, head: 30 },
      { id: 1, anchor: 12, head: 12 },
      { id: 2, anchor: 12, head: 30 },
      { id: 3, anchor: 4, head: 9 },
    ];
    const first = planAnimation(tied, WATCHED);
    const second = planAnimation(tied, WATCHED);
    expect(ids(first)).toEqual([3, 1, 0, 2]);
    expect(ids(second)).toEqual(ids(first));
  });

  it("chunk ranges advance through the document and cover their hunks", () => {
    const plan = planAnimation(hunks(400), WATCHED);
    let previous = -1;
    for (const chunk of plan.chunks) {
      expect(chunk.range.anchor).toBeGreaterThan(previous);
      expect(chunk.range.head).toBeGreaterThanOrEqual(chunk.range.anchor);
      previous = chunk.range.anchor;
      // A merged chunk selects the whole span it is about to rewrite.
      for (const hunk of chunk.hunks) {
        expect(hunk.anchor).toBeGreaterThanOrEqual(chunk.range.anchor);
        expect(hunk.head).toBeLessThanOrEqual(chunk.range.head);
      }
    }
    expect(positionFor(plan.chunks[0]!.range)).toEqual({
      anchor: plan.chunks[0]!.range.anchor,
      head: plan.chunks[0]!.range.head,
    });
  });

  it("clamps nonsense positions instead of scheduling NaN", () => {
    const plan = planAnimation(
      [
        { id: 0, anchor: Number.NaN, head: Number.NaN },
        { id: 1, anchor: -20, head: -5 },
        { id: 2, anchor: 8, head: 2 },
      ] satisfies TestHunk[],
      WATCHED,
    );
    for (const chunk of plan.chunks) {
      expect(Number.isFinite(chunk.range.anchor)).toBe(true);
      expect(chunk.range.anchor).toBeGreaterThanOrEqual(0);
      expect(chunk.range.head).toBeGreaterThanOrEqual(chunk.range.anchor);
    }
    expect(ids(plan).sort()).toEqual([0, 1, 2]);
  });
});

/* --------------------------------------------------------------- fast paths */

describe("fast paths", () => {
  it("reduced motion returns exactly one chunk with every hunk", () => {
    const input = hunks(400);
    const plan = planAnimation(input, { prefersReducedMotion: true, humanViewers: 6 });
    expect(plan.mode).toBe("reduced-motion");
    expect(plan.chunks).toHaveLength(1);
    expect(plan.totalMs).toBe(0);
    expect(plan.gapMs).toBe(0);
    expect(plan.chunks[0]?.delayMs).toBe(0);
    expect(ids(plan)).toEqual(input.map((hunk) => hunk.id));
  });

  it("zero live human viewers returns exactly one chunk with every hunk", () => {
    const input = hunks(400);
    const plan = planAnimation(input, { humanViewers: 0 });
    expect(plan.mode).toBe("no-viewers");
    expect(plan.chunks).toHaveLength(1);
    expect(plan.totalMs).toBe(0);
    expect(ids(plan)).toEqual(input.map((hunk) => hunk.id));
  });

  it("still orders the single chunk's hunks by document position", () => {
    const plan = planAnimation([...hunks(6)].reverse(), { prefersReducedMotion: true });
    expect(ids(plan)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a caller that omits the viewer count gets the boring path", () => {
    // Forgetting the field must degrade to one transaction, never to a 1.2s
    // window with the room's flushes suspended for an audience that may not
    // exist. Animation is presentation, never a precondition for the write.
    expect(planAnimation(hunks(20)).mode).toBe("no-viewers");
    expect(planAnimation(hunks(20)).chunks).toHaveLength(1);
  });

  it("an empty diff schedules nothing at all", () => {
    const plan = planAnimation<TestHunk>([], WATCHED);
    expect(plan.mode).toBe("empty");
    expect(plan.chunks).toHaveLength(0);
    expect(plan.totalMs).toBe(0);
  });
});

/* -------------------------------------------------- the union is the write */

describe("no hunk is dropped or duplicated", () => {
  const cases: { name: string; n: number; opts: Parameters<typeof planAnimation>[1] }[] = [
    { name: "animated, one chunk per hunk", n: 7, opts: WATCHED },
    { name: "animated, merged chunks", n: 400, opts: WATCHED },
    { name: "animated, exactly at the chunk cap", n: maxChunksFor(), opts: WATCHED },
    { name: "reduced motion", n: 53, opts: { prefersReducedMotion: true, humanViewers: 3 } },
    { name: "no viewers", n: 53, opts: { humanViewers: 0 } },
  ];

  for (const { name, n, opts } of cases) {
    it(`${name}: the union of all chunks is the input diff`, () => {
      const input = hunks(n);
      const plan = planAnimation(input, opts);
      const out = flatten(plan);
      expect(out).toHaveLength(input.length);
      expect(new Set(out).size).toBe(input.length);
      // Same objects, not merely equal ones: this module never rewrites a hunk.
      expect(new Set(out)).toEqual(new Set(input));
      expect(out.map((hunk) => hunk.id)).toEqual(input.map((hunk) => hunk.id));
      expect(plan.chunks.every((chunk) => chunk.hunks.length > 0)).toBe(true);
    });
  }

  it("survives hunks that share a position", () => {
    const input: TestHunk[] = Array.from({ length: 120 }, (_, i) => ({
      id: i,
      anchor: 40,
      head: 40 + (i % 3),
    }));
    const plan = planAnimation(input, WATCHED);
    expect(flatten(plan)).toHaveLength(input.length);
    expect(new Set(flatten(plan)).size).toBe(input.length);
  });
});
