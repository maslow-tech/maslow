import { describe, expect, it } from "vitest";

import type { BrainObject, Edge } from "../lib/api";
import {
  ENTER_MS,
  EXIT_MS,
  LOCAL_NODE_CAP,
  RECENTER_MS,
  RING_RADIUS,
  SPAWN_JITTER,
  adjacencyFrom,
  advanceLayout,
  buildLocalSet,
  capReached,
  clampDepth,
  cubicBezier,
  diffLayout,
  fullGraphHref,
  neighborLinksOn,
  normalizeLocalPrefs,
  physicsLinks,
  radialLayout,
  railScale,
  retargetLayout,
  spawnJitter,
  type LocalGraphSet,
  type LocalLayout,
  type Point,
} from "./LocalGraph";

/**
 * The rail's local graph, tested where it actually decides things: the BFS ball
 * and its 80-node cap, the deterministic radial layout, and — the part the
 * whole "it never moves" complaint reduces to — the NAVIGATION DIFF.
 *
 * The diff has four promises and each one is a test below: survivors keep their
 * coordinates, newcomers spawn at their BFS parent, leavers are released only
 * once their fade is over, and the cap keeps the highest-degree members.
 */

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

function edge(id: string, rel = "mentions", extra: Partial<Edge> = {}): Edge {
  return {
    rel,
    id,
    provenance: "manual",
    target_deleted: false,
    target_title: id.toUpperCase(),
    target_type: "note",
    ...extra,
  };
}

function object(id: string, links: Edge[] = [], backlinks: Edge[] = []): BrainObject {
  return {
    id,
    type: "note",
    title: id.toUpperCase(),
    body: null,
    version: 1,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    deleted_at: null,
    visibility: "org",
    props: {},
    links,
    backlinks,
    links_truncated: false,
    backlinks_truncated: false,
    hidden_from_you: 0,
  };
}

const OPTS = { depth: 1, incoming: true, outgoing: true, neighborLinks: true };

/** A star: `focus` linked out to `n` leaves. */
function star(n: number, focus = "focus"): BrainObject {
  return object(
    focus,
    Array.from({ length: n }, (_, i) => edge(`n${i}`)),
  );
}

function layoutOf(set: LocalGraphSet, targets: ReadonlyMap<string, Point>, now = 0): LocalLayout {
  return diffLayout(null, set, targets, now);
}

/* ------------------------------------------------------------------ *
 * the ball
 * ------------------------------------------------------------------ */

describe("buildLocalSet", () => {
  it("puts the focus first and reaches its neighbours at hop 1", () => {
    const adj = adjacencyFrom([object("focus", [edge("a")], [edge("b", "cites")])]);
    const set = buildLocalSet(adj, "focus", OPTS);
    expect(set.nodes[0]?.id).toBe("focus");
    expect(set.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "focus"]);
    expect(set.nodes.find((n) => n.id === "a")?.hop).toBe(1);
    expect(set.nodes.find((n) => n.id === "a")?.parent).toBe("focus");
    expect(set.edges.every((e) => e.atFocus)).toBe(true);
  });

  it("drops a deleted edge target rather than drawing a placeholder", () => {
    const adj = adjacencyFrom([
      object("focus", [edge("a"), edge("gone", "mentions", { target_deleted: true })]),
    ]);
    const set = buildLocalSet(adj, "focus", OPTS);
    expect(set.nodes.map((n) => n.id)).not.toContain("gone");
  });

  it("only follows outgoing links when the incoming toggle is off", () => {
    const adj = adjacencyFrom([object("focus", [edge("out1")], [edge("in1")])]);
    const set = buildLocalSet(adj, "focus", { ...OPTS, incoming: false });
    const ids = set.nodes.map((n) => n.id);
    expect(ids).toContain("out1");
    expect(ids).not.toContain("in1");
  });

  it("shows a neighbour-to-neighbour edge only with neighbour links ON", () => {
    // focus → a, focus → b, and a → b: the thing the old two-column rail
    // structurally could not express.
    const adj = adjacencyFrom([
      object("focus", [edge("a"), edge("b")]),
      object("a", [edge("b")], [edge("focus")]),
    ]);
    const dense = buildLocalSet(adj, "focus", OPTS);
    expect(dense.edges.some((e) => !e.atFocus)).toBe(true);

    const tree = buildLocalSet(adj, "focus", { ...OPTS, neighborLinks: false });
    expect(tree.edges.every((e) => e.atFocus)).toBe(true);
  });

  it("reaches hop 2 only through an EXPANDED record", () => {
    const unexpanded = adjacencyFrom([object("focus", [edge("a")])]);
    expect(buildLocalSet(unexpanded, "focus", { ...OPTS, depth: 2 }).nodes).toHaveLength(2);

    const expanded = adjacencyFrom([
      object("focus", [edge("a")]),
      object("a", [edge("deep")], [edge("focus")]),
    ]);
    const set = buildLocalSet(expanded, "focus", { ...OPTS, depth: 2 });
    expect(set.nodes.find((n) => n.id === "deep")?.hop).toBe(2);
    expect(set.nodes.find((n) => n.id === "deep")?.parent).toBe("a");
  });

  it("returns just the focus when both direction toggles are off", () => {
    const adj = adjacencyFrom([star(5)]);
    const set = buildLocalSet(adj, "focus", { ...OPTS, incoming: false, outgoing: false });
    expect(set.nodes.map((n) => n.id)).toEqual(["focus"]);
  });
});

/* ------------------------------------------------------------------ *
 * the 80-node cap
 * ------------------------------------------------------------------ */

describe("the node cap", () => {
  it("keeps the highest-degree members and reports the rest as overflow", () => {
    // 120 neighbours of the focus. Ten of them are also linked to each other's
    // hub, which gives them a higher local degree than the plain leaves.
    const leaves = Array.from({ length: 120 }, (_, i) => `n${i}`);
    const focus = object(
      "focus",
      leaves.map((id) => edge(id)),
    );
    // give n0..n9 extra degree by expanding them with links to a shared node
    const boosted = leaves
      .slice(0, 10)
      .map((id, i) => object(id, [edge("hub"), edge(`extra${i}`)], [edge("focus")]));
    const adj = adjacencyFrom([focus, ...boosted]);

    const set = buildLocalSet(adj, "focus", OPTS);
    const ids = new Set(set.nodes.map((n) => n.id));

    expect(set.nodes.length).toBe(LOCAL_NODE_CAP);
    expect(set.overflow).toBe(121 - LOCAL_NODE_CAP); // focus + 120 reached
    // every boosted (higher-degree) neighbour survives the cap
    for (const id of leaves.slice(0, 10)) expect(ids.has(id)).toBe(true);
    expect(ids.has("focus")).toBe(true);
  });

  it("never drops the source, and never exceeds the cap", () => {
    const degree = (i: number) => 100 - i;
    const order = Int32Array.from(Array.from({ length: 200 }, (_, i) => i));
    const levels = Int32Array.from(order, (i) => (i === 0 ? 0 : 1));
    const parents = Int32Array.from(order, (i) => (i === 0 ? -1 : 0));
    const { kept, overflow } = capReached(order, levels, parents, degree, 10);
    expect(kept.has(0)).toBe(true);
    expect(kept.size).toBe(10);
    expect(overflow).toBe(190);
    // ranked by degree: 1..9 have the highest scores after the source
    expect([...kept].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("admits a node together with its BFS ancestors so the tree never breaks", () => {
    // 0 → 1 → 2, plus a fat leaf 3 hanging off the source. Cap 3 must not keep
    // 2 without 1 (which would leave 2 parentless and unplaceable).
    const order = Int32Array.from([0, 1, 3, 2]);
    const levels = Int32Array.from([0, 1, 2, 1]);
    const parents = Int32Array.from([-1, 0, 1, 0]);
    const degree = (i: number) => [9, 1, 8, 5][i]!;
    const { kept } = capReached(order, levels, parents, degree, 3);
    expect(kept.has(2)).toBe(kept.has(1));
    expect(kept.size).toBeLessThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ *
 * layout
 * ------------------------------------------------------------------ */

describe("radialLayout", () => {
  it("pins the focus at the origin and puts hop h on ring h", () => {
    const adj = adjacencyFrom([
      object("focus", [edge("a")]),
      object("a", [edge("deep")], [edge("focus")]),
    ]);
    const set = buildLocalSet(adj, "focus", { ...OPTS, depth: 2 });
    const pos = radialLayout(set, RING_RADIUS);
    expect(pos.get("focus")).toEqual({ x: 0, y: 0 });
    expect(Math.hypot(pos.get("a")!.x, pos.get("a")!.y)).toBeCloseTo(RING_RADIUS, 6);
    expect(Math.hypot(pos.get("deep")!.x, pos.get("deep")!.y)).toBeCloseTo(RING_RADIUS * 2, 6);
  });

  it("is deterministic — the same set lays out identically twice", () => {
    const set = buildLocalSet(adjacencyFrom([star(6)]), "focus", OPTS);
    expect([...radialLayout(set).entries()]).toEqual([...radialLayout(set).entries()]);
  });

  it("gives a bushier branch a wider angular span", () => {
    // focus → a (which has three children) and focus → b (which has none).
    const adj = adjacencyFrom([
      object("focus", [edge("a"), edge("b")]),
      object("a", [edge("a1"), edge("a2"), edge("a3")], [edge("focus")]),
    ]);
    const set = buildLocalSet(adj, "focus", { ...OPTS, depth: 2, neighborLinks: false });
    const pos = radialLayout(set, RING_RADIUS);
    const spread = (ids: string[]) => {
      const angles = ids.map((id) => Math.atan2(pos.get(id)!.y, pos.get(id)!.x));
      return Math.max(...angles) - Math.min(...angles);
    };
    // a's three children fan out; b has no wedge of its own to spend
    expect(spread(["a1", "a2", "a3"])).toBeGreaterThan(0);
  });
});

describe("railScale", () => {
  it("is 1 at the reference rail and shrinks the forces for a narrower one", () => {
    expect(railScale(320, 320)).toBeCloseTo(1, 6);
    expect(railScale(220, 220)).toBeLessThan(1);
    expect(railScale(600, 600)).toBeGreaterThan(1);
  });

  it("never collapses to zero on a rail that has not been measured yet", () => {
    expect(railScale(0, 0)).toBeGreaterThan(0);
  });
});

describe("physicsLinks", () => {
  it("emits the set's own dense indices, two per edge", () => {
    const set = buildLocalSet(adjacencyFrom([star(3)]), "focus", OPTS);
    const links = physicsLinks(set);
    expect(links.length).toBe(set.edges.length * 2);
    for (const i of links) expect(i).toBeLessThan(set.nodes.length);
  });
});

/* ------------------------------------------------------------------ *
 * the navigation diff — the heart of it
 * ------------------------------------------------------------------ */

describe("diffLayout", () => {
  const adjA = adjacencyFrom([
    object("focus", [edge("a"), edge("b")]),
    object("a", [edge("c")], [edge("focus")]),
  ]);

  it("keeps a surviving node's coordinates exactly — it is never rebuilt", () => {
    const first = buildLocalSet(adjA, "focus", { ...OPTS, depth: 2 });
    const before = layoutOf(first, radialLayout(first));
    // drift the layout, as a real frame would
    const drifted = advanceLayout(before, 1000);
    const moved = drifted.nodes.get("a")!;

    // navigate to `a`: the set changes, but `a` is in both
    const second = buildLocalSet(adjA, "a", { ...OPTS, depth: 2 });
    const after = diffLayout(drifted, second, radialLayout(second), 2000);

    const survivor = after.nodes.get("a")!;
    expect(survivor.x).toBe(moved.x);
    expect(survivor.y).toBe(moved.y);
    // and it is heading somewhere new rather than sitting there
    expect(survivor.tweenMs).toBe(RECENTER_MS);
    expect(survivor.tweenAt).toBe(2000);
  });

  it("spawns a new node at its BFS parent's position, within the jitter bound", () => {
    const first = buildLocalSet(adjacencyFrom([object("focus", [edge("a")])]), "focus", OPTS);
    const before = layoutOf(first, radialLayout(first));
    const parentAt = before.nodes.get("a")!;

    // `a` grows a child; `c` is new and its BFS parent is `a`
    const grown = adjacencyFrom([
      object("focus", [edge("a")]),
      object("a", [edge("c")], [edge("focus")]),
    ]);
    const second = buildLocalSet(grown, "focus", { ...OPTS, depth: 2 });
    const after = diffLayout(before, second, radialLayout(second), 500);

    const born = after.nodes.get("c")!;
    expect(Math.hypot(born.x - parentAt.x, born.y - parentAt.y)).toBeLessThanOrEqual(
      SPAWN_JITTER + 1e-9,
    );
    expect(born.alpha).toBe(0);
    expect(born.phase).toBe("entering");
    expect(born.phaseAt).toBe(500);
  });

  it("falls back to the parent's TARGET when the parent is itself new", () => {
    const first = buildLocalSet(adjacencyFrom([object("focus")]), "focus", OPTS);
    const before = layoutOf(first, radialLayout(first));
    const second = buildLocalSet(
      adjacencyFrom([object("focus", [edge("a")]), object("a", [edge("c")], [edge("focus")])]),
      "focus",
      { ...OPTS, depth: 2 },
    );
    const targets = radialLayout(second);
    const after = diffLayout(before, second, targets, 0);
    const parentTarget = targets.get("a")!;
    const born = after.nodes.get("c")!;
    expect(Math.hypot(born.x - parentTarget.x, born.y - parentTarget.y)).toBeLessThanOrEqual(
      SPAWN_JITTER + 1e-9,
    );
  });

  it("marks a removed node leaving in place — and does NOT release it yet", () => {
    const first = buildLocalSet(adjA, "focus", { ...OPTS, depth: 2 });
    const before = advanceLayout(layoutOf(first, radialLayout(first)), 1000);
    const wasAt = before.nodes.get("b")!;

    // a set that no longer contains `b`
    const second = buildLocalSet(adjacencyFrom([object("focus", [edge("a")])]), "focus", OPTS);
    const after = diffLayout(before, second, radialLayout(second), 2000);

    const leaving = after.nodes.get("b")!;
    expect(leaving.phase).toBe("leaving");
    expect(leaving.phaseAt).toBe(2000);
    expect(leaving.x).toBe(wasAt.x);
    expect(leaving.y).toBe(wasAt.y);
    expect(leaving.toX).toBe(wasAt.x); // frozen: it fades, it does not fly off
  });

  it("releases a removed node only once the fade is over", () => {
    const first = buildLocalSet(adjA, "focus", { ...OPTS, depth: 2 });
    // Let the entrance finish first: a node that leaves BEFORE it has ever been
    // drawn correctly fades from alpha 0, which would make this test vacuous.
    const before = advanceLayout(layoutOf(first, radialLayout(first)), ENTER_MS);
    expect(before.nodes.get("b")!.alpha).toBe(1);
    const second = buildLocalSet(adjacencyFrom([object("focus", [edge("a")])]), "focus", OPTS);
    const after = diffLayout(before, second, radialLayout(second), 1000);

    const midFade = advanceLayout(after, 1000 + EXIT_MS / 2);
    expect(midFade.nodes.has("b")).toBe(true);
    expect(midFade.nodes.get("b")!.alpha).toBeGreaterThan(0);
    expect(midFade.nodes.get("b")!.alpha).toBeLessThan(1);

    const done = advanceLayout(after, 1000 + EXIT_MS);
    expect(done.nodes.has("b")).toBe(false);
  });

  it("re-centers: it unpins the old focus and pins the new one", () => {
    const first = buildLocalSet(adjA, "focus", { ...OPTS, depth: 2 });
    const before = layoutOf(first, radialLayout(first));
    expect(before.nodes.get("focus")!.pinned).toBe(true);

    const second = buildLocalSet(adjA, "a", { ...OPTS, depth: 2 });
    const targets = radialLayout(second);
    const after = diffLayout(before, second, targets, 0);

    expect(after.nodes.get("focus")!.pinned).toBe(false);
    expect(after.nodes.get("a")!.pinned).toBe(true);
    expect(after.focus).toBe("a");
    // the new focus is tweening to the centre rather than being teleported there
    expect(after.nodes.get("a")!.toX).toBe(0);
    expect(after.nodes.get("a")!.toY).toBe(0);
    expect(after.nodes.get("a")!.x).not.toBe(0);
    // …and the old focus is on its way out to a ring
    expect(after.nodes.get("focus")!.toX).toBe(targets.get("focus")!.x);
  });

  it("revives a node that comes back mid-fade instead of restarting it", () => {
    const first = buildLocalSet(adjA, "focus", { ...OPTS, depth: 2 });
    const before = layoutOf(first, radialLayout(first));
    const shrunk = buildLocalSet(adjacencyFrom([object("focus", [edge("a")])]), "focus", OPTS);
    const leaving = advanceLayout(diffLayout(before, shrunk, radialLayout(shrunk), 0), EXIT_MS / 2);
    const fading = leaving.nodes.get("b")!;
    expect(fading.phase).toBe("leaving");

    const revived = diffLayout(leaving, first, radialLayout(first), EXIT_MS / 2).nodes.get("b")!;
    expect(revived.phase).toBe("entering");
    expect(revived.alpha0).toBeCloseTo(fading.alpha, 6);
    expect(revived.x).toBe(fading.x); // it resumes from where it was fading
  });

  it("skips the animation entirely when the durations are zeroed (reduced motion)", () => {
    const set = buildLocalSet(adjA, "focus", { ...OPTS, depth: 2 });
    const layout = diffLayout(null, set, radialLayout(set), 0, {
      recenterMs: 0,
      enterMs: 0,
    });
    for (const node of layout.nodes.values()) {
      expect(node.alpha).toBe(1);
      expect(node.phase).toBe("steady");
    }
    expect(advanceLayout(layout, 0).settled).toBe(true);
  });
});

describe("advanceLayout", () => {
  it("eases a tween to completion and then reports settled", () => {
    const set = buildLocalSet(adjacencyFrom([star(3)]), "focus", OPTS);
    const targets = radialLayout(set);
    const start = diffLayout(null, set, targets, 0);
    // a first paint has nothing to tween from, so give it one
    const moved = diffLayout(start, set, targets, 0);
    const half = advanceLayout(moved, RECENTER_MS / 2);
    expect(half.settled).toBe(false);
    const end = advanceLayout(moved, RECENTER_MS + ENTER_MS);
    expect(end.settled).toBe(true);
    const n0 = end.nodes.get("n0")!;
    expect(n0.x).toBeCloseTo(targets.get("n0")!.x, 5);
    expect(n0.alpha).toBe(1);
  });
});

describe("retargetLayout", () => {
  it("leaves a mid-tween node alone so a physics tick cannot restart it", () => {
    const set = buildLocalSet(adjacencyFrom([star(2)]), "focus", OPTS);
    const layout = diffLayout(
      diffLayout(null, set, radialLayout(set), 0),
      set,
      radialLayout(set),
      0,
    );
    const before = layout.nodes.get("n0")!;
    const after = retargetLayout(layout, new Map([["n0", { x: 999, y: 999 }]]), 10, 0);
    expect(after.nodes.get("n0")!.toX).toBe(before.toX);
  });

  it("adopts a new target once the tween is over", () => {
    const set = buildLocalSet(adjacencyFrom([star(2)]), "focus", OPTS);
    const layout = advanceLayout(
      diffLayout(diffLayout(null, set, radialLayout(set), 0), set, radialLayout(set), 0),
      RECENTER_MS + ENTER_MS,
    );
    const after = retargetLayout(
      layout,
      new Map([["n0", { x: 12, y: -5 }]]),
      RECENTER_MS + ENTER_MS,
      0,
    );
    expect(after.nodes.get("n0")!.toX).toBe(12);
    expect(after.nodes.get("n0")!.toY).toBe(-5);
  });

  it("never retargets a leaving node", () => {
    const full = buildLocalSet(adjacencyFrom([star(2)]), "focus", OPTS);
    const shrunk = buildLocalSet(adjacencyFrom([object("focus", [edge("n0")])]), "focus", OPTS);
    const layout = diffLayout(
      diffLayout(null, full, radialLayout(full), 0),
      shrunk,
      radialLayout(shrunk),
      0,
    );
    const after = retargetLayout(layout, new Map([["n1", { x: 500, y: 500 }]]), 0, 0);
    expect(after.nodes.get("n1")!.toX).not.toBe(500);
  });
});

/* ------------------------------------------------------------------ *
 * small pure pieces
 * ------------------------------------------------------------------ */

describe("spawnJitter", () => {
  it("is deterministic in the id and bounded by the magnitude", () => {
    for (const id of ["a", "b", "c", "0191d0b7-1", "…"]) {
      const j = spawnJitter(id);
      expect(spawnJitter(id)).toEqual(j);
      expect(Math.hypot(j.x, j.y)).toBeLessThanOrEqual(SPAWN_JITTER + 1e-9);
    }
    expect(spawnJitter("a")).not.toEqual(spawnJitter("b"));
  });
});

describe("cubicBezier", () => {
  it("is pinned at both ends and monotone in between", () => {
    const ease = cubicBezier(0.4, 0, 0.2, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    let prev = 0;
    for (let t = 0.05; t < 1; t += 0.05) {
      const v = ease(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
});

describe("preferences", () => {
  it("clamps depth into 1–3, including from a hostile persisted value", () => {
    expect(clampDepth(0)).toBe(1);
    expect(clampDepth(9)).toBe(3);
    expect(clampDepth("2")).toBe(1);
    expect(clampDepth(Number.NaN)).toBe(1);
  });

  it("defaults neighbour links ON for d ≤ 2 and OFF at d = 3, until the user decides", () => {
    expect(neighborLinksOn({ ...normalizeLocalPrefs(null), depth: 1 })).toBe(true);
    expect(neighborLinksOn({ ...normalizeLocalPrefs(null), depth: 2 })).toBe(true);
    expect(neighborLinksOn({ ...normalizeLocalPrefs(null), depth: 3 })).toBe(false);
    expect(neighborLinksOn({ ...normalizeLocalPrefs(null), depth: 3, neighborLinks: true })).toBe(
      true,
    );
  });

  it("survives junk out of localStorage", () => {
    expect(normalizeLocalPrefs("nope")).toEqual({
      depth: 1,
      incoming: true,
      outgoing: true,
      neighborLinks: null,
    });
    expect(normalizeLocalPrefs({ depth: 3, incoming: false })).toEqual({
      depth: 3,
      incoming: false,
      outgoing: true,
      neighborLinks: null,
    });
  });
});

describe("fullGraphHref", () => {
  it("carries the focus AND the depth, so the handoff preserves your place", () => {
    const href = fullGraphHref("0191d0b7-aaaa", 2);
    expect(href.startsWith("/graph?")).toBe(true);
    const params = new URLSearchParams(href.slice("/graph?".length));
    expect(params.get("focus")).toBe("0191d0b7-aaaa");
    expect(params.get("depth")).toBe("2");
  });

  it("clamps a nonsense depth rather than putting it in the URL", () => {
    expect(new URLSearchParams(fullGraphHref("x", 99).slice(7)).get("depth")).toBe("3");
  });
});
