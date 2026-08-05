import { describe, expect, it } from "vitest";

import { buildCsr, edgeKey } from "./csr";
import {
  DIM_ALPHA,
  HIGHLIGHT_ENTER_MS,
  HIGHLIGHT_EXIT_MS,
  HOVER_DIM_ALPHA,
  HighlightController,
  changedHighlight,
  forcedLabels,
  hoverHighlight,
  makeHighlightSet,
  neighborhood,
  orphanHighlight,
  pathHighlight,
  searchHighlight,
  selectionHighlight,
} from "./highlight";
import { GraphStore } from "./store";
import type { Csr, GraphEdge, GraphNode } from "./types";

/**
 * Two things carry this file.
 *
 * The first is that hover isolation is the interaction people judge the whole
 * graph on: it runs on every mouse move, and a membership that is off by one
 * hop dims the thing you are pointing at. So the neighborhood is asserted
 * against the CSR from both directions (every neighbour in, every non-neighbour
 * out) on a graph with the shapes a real brain produces — parallel verbs, a
 * hub, and an orphan.
 *
 * The second is that there is exactly ONE dimming system. Five features share
 * the controller, so the tests pin the properties that make sharing safe:
 * swapping sets mid-tween continues from the current alpha instead of snapping,
 * the fall is faster than the rise (the committed 140/200 asymmetry), the tween
 * is frame-rate independent (the same curve at 8ms and 33ms steps, because a
 * per-frame constant step silently runs 2× fast at 120Hz), and
 * `prefers-reduced-motion` produces the correct END state immediately rather
 * than no state at all.
 */

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * A small hand-checkable graph:
 *
 *   0 ──knows── 1 ──knows── 2 ──knows── 3        4 (orphan)
 *   │                                            5 ──owns/mentions── 6 (parallel)
 *   └──works_at─ 2
 */
function fixture(): { csr: Csr; store: GraphStore } {
  const nodes: GraphNode[] = Array.from({ length: 7 }, (_, i) => ({
    id: `n${i}`,
    title: `Node ${i}`,
    type: null,
    degree: 0,
  }));
  const edges: GraphEdge[] = [
    { from: "n0", to: "n1", rel: "knows" },
    { from: "n1", to: "n2", rel: "knows" },
    { from: "n2", to: "n3", rel: "knows" },
    { from: "n0", to: "n2", rel: "works_at" },
    { from: "n5", to: "n6", rel: "owns" },
    { from: "n5", to: "n6", rel: "mentions" },
  ];
  const store = new GraphStore();
  store.ingest({ nodes, edges });
  return { csr: buildCsr(store), store };
}

/** Drive the controller like a render loop. Returns the final timestamp. */
function run(c: HighlightController, ms: number, step = 16, from = 0): number {
  c.advance(from);
  let t = from;
  while (t < from + ms) {
    t = Math.min(from + ms, t + step);
    c.advance(t);
  }
  return t;
}

// ---------------------------------------------------------------------------
// membership
// ---------------------------------------------------------------------------

describe("neighborhood", () => {
  it("is the node plus its one-hop neighbours, and nothing else", () => {
    const { csr } = fixture();
    const hood = neighborhood(csr, 2);
    expect([...hood.nodes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(hood.depth.get(2)).toBe(0);
    expect(hood.depth.get(0)).toBe(1);
    expect(hood.nodes.has(4)).toBe(false);
  });

  it("names the incident edges by order-independent key", () => {
    const { csr } = fixture();
    const hood = neighborhood(csr, 2);
    expect(hood.edges.has(edgeKey(2, 1))).toBe(true);
    expect(hood.edges.has(edgeKey(1, 2))).toBe(true);
    expect(hood.edges.has(edgeKey(2, 0))).toBe(true);
    expect(hood.edges.has(edgeKey(2, 3))).toBe(true);
    // 0—1 is inside the ball but is not incident to the hovered node
    expect(hood.edges.has(edgeKey(0, 1))).toBe(false);
  });

  it("adds the edges among members only when asked (the rail's toggle)", () => {
    const { csr } = fixture();
    const hood = neighborhood(csr, 2, 1, true);
    expect(hood.edges.has(edgeKey(0, 1))).toBe(true);
  });

  it("walks further hops and records depth", () => {
    const { csr } = fixture();
    const hood = neighborhood(csr, 3, 2);
    expect([...hood.nodes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(hood.depth.get(3)).toBe(0);
    expect(hood.depth.get(2)).toBe(1);
    expect(hood.depth.get(0)).toBe(2);
  });

  it("is empty for an out-of-range index rather than throwing", () => {
    const { csr } = fixture();
    expect(neighborhood(csr, -1).nodes.size).toBe(0);
    expect(neighborhood(csr, 999).nodes.size).toBe(0);
  });

  it("terminates on a parallel-verb pair (the same neighbour twice)", () => {
    const { csr } = fixture();
    const hood = neighborhood(csr, 5, 3);
    expect([...hood.nodes].sort((a, b) => a - b)).toEqual([5, 6]);
  });
});

describe("set constructors", () => {
  it("hover isolates at the committed 0.12", () => {
    const { csr } = fixture();
    const set = hoverHighlight(csr, 2)!;
    expect(set.kind).toBe("hover");
    expect(set.dimAlpha).toBe(0.12);
    expect(HOVER_DIM_ALPHA).toBe(0.12);
    expect(set.nodes.has(4)).toBe(false);
    expect(hoverHighlight(csr, 42)).toBeNull();
  });

  it("path lights every node and every hop", () => {
    const set = pathHighlight([
      [0, 1, 2],
      [0, 2],
    ]);
    expect([...set.nodes].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(set.edges.has(edgeKey(0, 1))).toBe(true);
    expect(set.edges.has(edgeKey(1, 2))).toBe(true);
    expect(set.edges.has(edgeKey(0, 2))).toBe(true);
    expect(set.edges.size).toBe(3);
  });

  it("search dims less than hover and claims no edges", () => {
    const set = searchHighlight([1, 3]);
    expect(set.edges.size).toBe(0);
    expect(set.dimAlpha).toBeGreaterThan(HOVER_DIM_ALPHA);
    expect(set.dimAlpha).toBe(DIM_ALPHA.search);
  });

  it("orphans are the visible-degree-0 nodes", () => {
    const { csr } = fixture();
    const set = orphanHighlight(csr);
    expect([...set.nodes]).toEqual([4]);
  });

  it("selection lights the edges inside the selection", () => {
    const { csr } = fixture();
    const set = selectionHighlight(csr, [0, 1, 4]);
    expect(set.edges.has(edgeKey(0, 1))).toBe(true);
    expect(set.edges.has(edgeKey(0, 2))).toBe(false);
  });

  it("changed recedes rather than hides", () => {
    const set = changedHighlight([2]);
    expect(set.kind).toBe("changed");
    expect(set.dimAlpha).toBe(DIM_ALPHA.changed);
    expect(set.dimAlpha).toBeGreaterThan(HOVER_DIM_ALPHA);
  });

  it("forces labels for the sets that name things by name", () => {
    const { csr } = fixture();
    expect(forcedLabels(searchHighlight([1]))).toEqual(new Set([1]));
    expect(forcedLabels(selectionHighlight(csr, [1]))).toEqual(new Set([1]));
    expect(forcedLabels(hoverHighlight(csr, 1))).toBeUndefined();
    expect(forcedLabels(pathHighlight([[0, 1]]))).toBeUndefined();
    expect(forcedLabels(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the controller
// ---------------------------------------------------------------------------

const still = () => false;

describe("HighlightController", () => {
  it("starts fully lit with nothing dimmed and nothing animating", () => {
    const c = new HighlightController(5, { reducedMotion: still });
    expect(c.nodeAlpha(0)).toBe(1);
    expect(c.animating).toBe(false);
    expect(c.advance(0)).toBe(false);
    expect(c.isMember(3)).toBe(true);
    expect(c.nodeAlpha(99)).toBe(1);
  });

  it("dims non-members toward 0.12 and leaves members alone", () => {
    const { csr } = fixture();
    const c = new HighlightController(csr.n, { reducedMotion: still });
    c.set(hoverHighlight(csr, 2));
    run(c, HIGHLIGHT_ENTER_MS);
    expect(c.nodeAlpha(2)).toBe(1);
    expect(c.nodeAlpha(1)).toBe(1);
    // within a few percent of the target after the committed duration
    expect(c.nodeAlpha(4)).toBeGreaterThan(HOVER_DIM_ALPHA);
    expect(c.nodeAlpha(4)).toBeLessThan(0.2);
    run(c, 1000);
    expect(c.nodeAlpha(4)).toBeCloseTo(HOVER_DIM_ALPHA, 3);
    expect(c.animating).toBe(false);
  });

  it("falls faster than it rises — the committed 140/200 asymmetry", () => {
    const { csr } = fixture();
    const c = new HighlightController(csr.n, { reducedMotion: still });
    c.set(hoverHighlight(csr, 2));
    const t = run(c, 100);
    const fell = 1 - c.nodeAlpha(4); // fraction of the 0.88 drop covered
    const fellFrac = fell / (1 - HOVER_DIM_ALPHA);

    c.finish();
    c.set(null);
    run(c, 100, 16, t); // same elapsed time, opposite direction
    const roseFrac = (c.nodeAlpha(4) - HOVER_DIM_ALPHA) / (1 - HOVER_DIM_ALPHA);

    expect(fellFrac).toBeGreaterThan(roseFrac);
    expect(HIGHLIGHT_ENTER_MS).toBeLessThan(HIGHLIGHT_EXIT_MS);
    expect(HIGHLIGHT_ENTER_MS).toBeGreaterThanOrEqual(120);
    expect(HIGHLIGHT_ENTER_MS).toBeLessThanOrEqual(150);
    expect(HIGHLIGHT_EXIT_MS).toBe(200);
  });

  it("is frame-rate independent — same curve at 8ms and 33ms steps", () => {
    const { csr } = fixture();
    const fast = new HighlightController(csr.n, { reducedMotion: still });
    const slow = new HighlightController(csr.n, { reducedMotion: still });
    fast.set(hoverHighlight(csr, 2));
    slow.set(hoverHighlight(csr, 2));
    run(fast, 96, 8);
    run(slow, 96, 32);
    expect(fast.nodeAlpha(4)).toBeCloseTo(slow.nodeAlpha(4), 5);
  });

  it("continues from the current alpha when a set is swapped mid-tween", () => {
    const { csr } = fixture();
    const c = new HighlightController(csr.n, { reducedMotion: still });
    c.set(hoverHighlight(csr, 2));
    run(c, 60);
    const mid = c.nodeAlpha(4);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(HOVER_DIM_ALPHA);

    // hovering a node that DOES include 4 turns it around from where it is
    c.set(makeHighlightSet("hover", new Set([4])));
    c.advance(60);
    c.advance(68);
    expect(c.nodeAlpha(4)).toBeGreaterThan(mid);
    expect(c.nodeAlpha(4)).toBeLessThan(1);
  });

  it("stops animating once settled, so the render loop can stop", () => {
    const { csr } = fixture();
    const c = new HighlightController(csr.n, { reducedMotion: still });
    c.set(hoverHighlight(csr, 2));
    let t = 0;
    let frames = 0;
    c.advance(t);
    while (c.advance((t += 16))) {
      frames += 1;
      if (frames > 1000) break;
    }
    expect(frames).toBeLessThan(200);
    expect(c.animating).toBe(false);
    expect(c.advance(t + 16)).toBe(false);
  });

  it("honours prefers-reduced-motion by arriving instantly, not by doing nothing", () => {
    const { csr } = fixture();
    const c = new HighlightController(csr.n, { reducedMotion: () => true });
    c.set(hoverHighlight(csr, 2));
    expect(c.nodeAlpha(4)).toBeCloseTo(HOVER_DIM_ALPHA, 6);
    expect(c.nodeAlpha(1)).toBe(1);
    expect(c.advance(16)).toBe(false);
    expect(c.pulse(400)).toBe(1);
    c.set(null);
    expect(c.nodeAlpha(4)).toBe(1);
  });

  it("pulses for the scrubber and stays inside [0, 1]", () => {
    const c = new HighlightController(1, { reducedMotion: still });
    expect(c.pulse(0)).toBeCloseTo(0, 6);
    expect(c.pulse(800)).toBeCloseTo(1, 6);
    for (let t = 0; t < 4000; t += 37) {
      const p = c.pulse(t);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("grows with the store: a node arriving mid-hover fades in, never pops", () => {
    const c = new HighlightController(2, { reducedMotion: still });
    c.set(makeHighlightSet("hover", new Set([0])));
    const t = run(c, 1000);
    expect(c.nodeAlpha(1)).toBeCloseTo(HOVER_DIM_ALPHA, 3);
    c.resize(4);
    expect(c.nodeAlpha(1)).toBeCloseTo(HOVER_DIM_ALPHA, 3); // preserved
    expect(c.nodeAlpha(3)).toBe(1); // new node starts lit…
    run(c, 1000, 16, t);
    expect(c.nodeAlpha(3)).toBeCloseTo(HOVER_DIM_ALPHA, 3); // …then joins the dim
  });

  it("resets to a clean, fully-lit state", () => {
    const { csr } = fixture();
    const c = new HighlightController(csr.n, { reducedMotion: still });
    c.set(hoverHighlight(csr, 2));
    run(c, 1000);
    c.reset();
    expect(c.current).toBeNull();
    expect(c.nodeAlpha(4)).toBe(1);
    expect(c.animating).toBe(false);
  });

  it("ignores an absurd dt (a backgrounded tab) instead of teleporting", () => {
    const { csr } = fixture();
    const c = new HighlightController(csr.n, { reducedMotion: still });
    c.set(hoverHighlight(csr, 2));
    c.advance(0);
    c.advance(60_000);
    // clamped to one 100ms slice, not 60 seconds of decay
    expect(c.nodeAlpha(4)).toBeGreaterThan(HOVER_DIM_ALPHA + 0.02);
  });
});

describe("HighlightController.edgeAlpha", () => {
  it("is fully lit with no active set", () => {
    const c = new HighlightController(4, { reducedMotion: still });
    expect(c.edgeAlpha(0, 1)).toBe(1);
  });

  it("inherits the dimmer endpoint", () => {
    const { csr } = fixture();
    const c = new HighlightController(csr.n, { reducedMotion: () => true });
    c.set(hoverHighlight(csr, 2));
    // 3 is a member (lit), 4 is not — the edge follows 4 down…
    expect(c.edgeAlpha(3, 4)).toBeCloseTo(HOVER_DIM_ALPHA, 6);
    // …and not one step further: the knock is a floor, not a multiplier, so
    // the surrounding structure stays visible as context instead of vanishing.
    expect(c.edgeAlpha(4, 6)).toBeCloseTo(HOVER_DIM_ALPHA, 6);
  });

  it("knocks down a lit-endpoint edge that the set did not name (the path case)", () => {
    const c = new HighlightController(4, { reducedMotion: () => true });
    c.set(pathHighlight([[0, 1, 2]]));
    expect(c.edgeAlpha(0, 1)).toBe(1); // a hop on the path
    // 0—2 joins two path nodes but is not a hop: dimmed, not lit
    expect(c.edgeAlpha(0, 2)).toBeCloseTo(DIM_ALPHA.path, 6);
  });

  it("leaves every edge to its endpoints when the set names no edges", () => {
    const c = new HighlightController(4, { reducedMotion: () => true });
    c.set(searchHighlight([0, 1]));
    expect(c.edgeAlpha(0, 1)).toBe(1);
    expect(c.edgeAlpha(0, 3)).toBeCloseTo(DIM_ALPHA.search, 6);
  });
});
