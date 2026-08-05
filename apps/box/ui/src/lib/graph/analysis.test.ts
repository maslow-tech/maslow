import { describe, expect, it } from "vitest";

import {
  AnalysisEngine,
  requestAnalysis,
  reviveCsr,
  type AnalysisEvent,
  type AnalysisWorkerLike,
} from "./analysis.worker";
import {
  BETWEENNESS_PIVOTS,
  ballOf,
  betweenness,
  bfs,
  buildOrientation,
  analyze,
  internalEdges,
  orphans,
  shortestPaths,
  topByScore,
  topHubs,
  treeEdges,
} from "./analysis";
import { buildCsr, edgeKey } from "./csr";
import { GraphStore } from "./store";
import type { Csr, GraphEdge, GraphNode } from "./types";

/**
 * What this file is defending.
 *
 * The analysis layer is where the graph stops being a picture, and every one
 * of its answers is a CLAIM about the user's brain: "these two objects are
 * connected, like this, through these verbs"; "this object is the broker
 * holding two clusters together"; "these forty objects are linked to nothing".
 * A wrong answer here is not a visual glitch — it is a confident sentence about
 * someone's data that happens to be false, and nobody can tell by looking.
 *
 * So every claim is checked against an INDEPENDENT oracle rather than against
 * the implementation's own opinion:
 *
 *  - shortest paths against a hand-written adjacency-list BFS and a brute-force
 *    enumeration of every shortest path, over a seeded random graph, with each
 *    returned hop's verb checked against the edge list that produced it;
 *  - betweenness against the closed form for a path graph (`i * (n - 1 - i)`),
 *    which pins the undirected halving that a Brandes implementation silently
 *    gets wrong;
 *  - the sampled estimator against the exact one on a fixture with PLANTED
 *    brokers, because "64 pivots is close enough" is an assertion about
 *    ranking, not about arithmetic;
 *  - orphans and hubs against brute force over the same CSR.
 *
 * The other half is the semantics the rail depends on: BFS depth, and tree
 * edges (a hierarchy) versus all edges among the set (the true local density) —
 * two different claims, which is why they are two functions and two tests.
 */

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Deterministic PRNG — a fixture that fails only on Tuesdays is worthless. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type EdgeSpec = readonly [from: string, to: string, rel?: string];

interface Fixture {
  store: GraphStore;
  csr: Csr;
  /** dense index of an id — every assertion below is written in ids. */
  at(id: string): number;
  /** id at a dense index. */
  idOf(index: number): string;
  edges: GraphEdge[];
}

function fixture(ids: readonly string[], edges: readonly EdgeSpec[]): Fixture {
  const nodes: GraphNode[] = ids.map((id) => ({ id, title: id, type: null, degree: 0 }));
  const rows: GraphEdge[] = edges.map(([from, to, rel]) => ({ from, to, rel: rel ?? "links" }));
  const store = new GraphStore();
  store.ingest({ nodes, edges: rows });
  const csr = buildCsr(store);
  return {
    store,
    csr,
    at: (id) => {
      const index = store.indexOf(id);
      if (index === undefined) throw new Error(`fixture: no node ${id}`);
      return index;
    },
    idOf: (index) => {
      const id = store.idAt(index);
      if (id === undefined) throw new Error(`fixture: no index ${index}`);
      return id;
    },
    edges: rows,
  };
}

/** An undirected adjacency list built straight off the edge rows — the oracle. */
function adjacency(fx: Fixture): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (let i = 0; i < fx.csr.n; i += 1) adj.set(i, new Set<number>());
  for (const e of fx.edges) {
    const a = fx.at(e.from);
    const b = fx.at(e.to);
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  return adj;
}

/** Plain BFS over the oracle adjacency. Nothing here touches `analysis.ts`. */
function distancesFrom(adj: Map<number, Set<number>>, source: number, n: number): number[] {
  const dist = new Array<number>(n).fill(-1);
  dist[source] = 0;
  const queue = [source];
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head]!;
    for (const v of adj.get(u) ?? []) {
      if (dist[v] !== -1) continue;
      dist[v] = dist[u]! + 1;
      queue.push(v);
    }
  }
  return dist;
}

/** Every shortest path a→b, brute force. Only ever called on tiny fixtures. */
function allShortestPaths(
  adj: Map<number, Set<number>>,
  n: number,
  a: number,
  b: number,
): number[][] {
  const dist = distancesFrom(adj, a, n);
  if (dist[b] === -1) return [];
  const out: number[][] = [];
  const walk = (path: number[]): void => {
    const last = path[path.length - 1]!;
    if (last === b) {
      out.push(path.slice());
      return;
    }
    for (const v of adj.get(last) ?? []) {
      if (dist[v] === dist[last]! + 1) walk([...path, v]);
    }
  };
  walk([a]);
  return out.filter((p) => p.length - 1 === dist[b]);
}

/** A seeded random graph with the shape a brain produces (sparse, clustered). */
function randomFixture(seed: number, n: number, extraEdges: number): Fixture {
  const random = mulberry32(seed);
  const rels = ["works_at", "mentions", "owns", "blocked_by"];
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  const edges: EdgeSpec[] = [];
  // A random forest first (so most of the graph is reachable), then chords.
  for (let i = 1; i < n; i += 1) {
    if (random() < 0.12) continue; // leaves a few components — reachability matters
    const parent = Math.floor(random() * i);
    edges.push([`n${i}`, `n${parent}`, rels[Math.floor(random() * rels.length)]!]);
  }
  for (let k = 0; k < extraEdges; k += 1) {
    const a = Math.floor(random() * n);
    const b = Math.floor(random() * n);
    if (a === b) continue;
    edges.push([`n${a}`, `n${b}`, rels[Math.floor(random() * rels.length)]!]);
  }
  return fixture(ids, edges);
}

/**
 * Six clusters chained by five single bridge nodes. Every inter-cluster path
 * must cross a bridge (degree 2) and its two gateway nodes, so the brokers are
 * PLANTED and known before the algorithm runs — which is what makes "exact and
 * sampled agree on the top ten" a real assertion instead of a tautology.
 */
function clusteredFixture(seed: number): {
  fx: Fixture;
  bridges: number[];
  gateways: number[];
} {
  const random = mulberry32(seed);
  const clusters = 6;
  const per = 100;
  const ids: string[] = [];
  const edges: EdgeSpec[] = [];

  for (let c = 0; c < clusters; c += 1) {
    for (let k = 0; k < per; k += 1) ids.push(`c${c}-${k}`);
    for (let k = 1; k < per; k += 1) {
      const parent = Math.floor(random() * k);
      edges.push([`c${c}-${k}`, `c${c}-${parent}`, "mentions"]);
    }
    for (let extra = 0; extra < 40; extra += 1) {
      const a = Math.floor(random() * per);
      const b = Math.floor(random() * per);
      if (a !== b) edges.push([`c${c}-${a}`, `c${c}-${b}`, "mentions"]);
    }
  }
  for (let i = 0; i + 1 < clusters; i += 1) {
    ids.push(`bridge${i}`);
    edges.push([`c${i}-0`, `bridge${i}`, "part_of"]);
    edges.push([`bridge${i}`, `c${i + 1}-0`, "part_of"]);
  }

  const fx = fixture(ids, edges);
  return {
    fx,
    bridges: Array.from({ length: clusters - 1 }, (_, i) => fx.at(`bridge${i}`)),
    gateways: Array.from({ length: clusters }, (_, c) => fx.at(`c${c}-0`)),
  };
}

// ---------------------------------------------------------------------------
// BFS
// ---------------------------------------------------------------------------

describe("bfs", () => {
  //      a — b — d
  //      |   |
  //      c — e — f
  const fx = fixture(
    ["a", "b", "c", "d", "e", "f", "z"],
    [
      ["a", "b"],
      ["a", "c"],
      ["b", "d"],
      ["b", "e"],
      ["c", "e"],
      ["e", "f"],
    ],
  );

  it("depth 1 is the node and its neighbours, and nothing else", () => {
    const result = bfs(fx.csr, fx.at("a"), 1);
    expect([...ballOf(result)].map(fx.idOf).sort()).toEqual(["a", "b", "c"]);
    expect(result.levels[fx.at("a")]).toBe(0);
    expect(result.levels[fx.at("b")]).toBe(1);
    expect(result.levels[fx.at("d")]).toBe(-1);
  });

  it("depth 0 is the source alone", () => {
    const result = bfs(fx.csr, fx.at("a"), 0);
    expect([...ballOf(result)]).toEqual([fx.at("a")]);
  });

  it("levels are true hop counts and parents form a tree back to the source", () => {
    const result = bfs(fx.csr, fx.at("a"), 3);
    const dist = distancesFrom(adjacency(fx), fx.at("a"), fx.csr.n);
    for (let i = 0; i < fx.csr.n; i += 1) expect(result.levels[i]).toBe(dist[i]);

    // Every reached non-source node has a parent one level up, reached by a
    // real half-edge slot whose owner IS that parent.
    for (const v of ballOf(result)) {
      if (v === result.source) continue;
      const parent = result.parents[v]!;
      expect(result.levels[parent]).toBe(result.levels[v]! - 1);
      const slot = result.parentSlots[v]!;
      expect(fx.csr.neighbors[slot]).toBe(v);
      expect(slot).toBeGreaterThanOrEqual(fx.csr.offsets[parent]!);
      expect(slot).toBeLessThan(fx.csr.offsets[parent + 1]!);
    }
  });

  it("never reaches a disconnected node, and never leaves the visit order dirty", () => {
    const result = bfs(fx.csr, fx.at("a"), 9);
    expect([...ballOf(result)]).not.toContain(fx.at("z"));
    expect(result.levels[fx.at("z")]).toBe(-1);
    expect(result.parents[fx.at("z")]).toBe(-1);
    // order is source-first and non-decreasing in level
    expect(result.order[0]).toBe(fx.at("a"));
    for (let k = 1; k < result.order.length; k += 1) {
      expect(result.levels[result.order[k]!]!).toBeGreaterThanOrEqual(
        result.levels[result.order[k - 1]!]!,
      );
    }
  });

  it("an out-of-range source is an empty ball, not a throw", () => {
    for (const source of [-1, fx.csr.n, 1e9]) {
      const result = bfs(fx.csr, source, 2);
      expect(result.order.length).toBe(0);
    }
  });

  describe("neighbour links", () => {
    // b and c are BOTH neighbours of a, and are joined through e at depth 2.
    const result = bfs(fx.csr, fx.at("a"), 2);
    const ball = ballOf(result);

    it("tree edges are one per reached node — a clean hierarchy", () => {
      const tree = treeEdges(result);
      expect(tree.size).toBe(ball.size - 1);
      expect(tree.has(edgeKey(fx.at("a"), fx.at("b")))).toBe(true);
      // c—e and b—e cannot BOTH be tree edges: e was discovered once.
      const cToE = tree.has(edgeKey(fx.at("c"), fx.at("e")));
      const bToE = tree.has(edgeKey(fx.at("b"), fx.at("e")));
      expect(cToE !== bToE).toBe(true);
    });

    it("internal edges are every edge among the set — the true local density", () => {
      const internal = internalEdges(fx.csr, ball);
      expect(internal.has(edgeKey(fx.at("c"), fx.at("e")))).toBe(true);
      expect(internal.has(edgeKey(fx.at("b"), fx.at("e")))).toBe(true);
      // …and strictly more than the tree, which is the whole point of the toggle.
      expect(internal.size).toBeGreaterThan(treeEdges(result).size);
      // never an edge leaving the set (f is at depth 3)
      expect(internal.has(edgeKey(fx.at("e"), fx.at("f")))).toBe(false);
    });

    it("internal edges over a random ball match brute force", () => {
      const random = randomFixture(11, 200, 120);
      const ball2 = ballOf(bfs(random.csr, 3, 2));
      const expected = new Set<number>();
      const adj = adjacency(random);
      for (const u of ball2) {
        for (const v of adj.get(u) ?? []) {
          if (ball2.has(v)) expected.add(edgeKey(u, v));
        }
      }
      expect([...internalEdges(random.csr, ball2)].sort()).toEqual([...expected].sort());
    });
  });

  describe("direction", () => {
    // a → b → c, and d → b (so b has one out and two in).
    const dir = fixture(
      ["a", "b", "c", "d"],
      [
        ["a", "b", "knows"],
        ["b", "c", "knows"],
        ["d", "b", "knows"],
      ],
    );
    const orientation = buildOrientation(dir.store, dir.csr);

    it("follows outgoing edges only when asked", () => {
      const out = bfs(dir.csr, dir.at("b"), 1, { direction: "out", orientation });
      expect([...ballOf(out)].map(dir.idOf).sort()).toEqual(["b", "c"]);
    });

    it("follows incoming edges only when asked", () => {
      const inbound = bfs(dir.csr, dir.at("b"), 1, { direction: "in", orientation });
      expect([...ballOf(inbound)].map(dir.idOf).sort()).toEqual(["a", "b", "d"]);
    });

    it("is undirected by default, and without an orientation mask", () => {
      expect([...ballOf(bfs(dir.csr, dir.at("b"), 1, { orientation }))].length).toBe(4);
      // No mask: the CSR genuinely does not know which way an edge points, so
      // `direction` is ignored rather than guessed at.
      expect([...ballOf(bfs(dir.csr, dir.at("b"), 1, { direction: "out" }))].length).toBe(4);
    });
  });
});

// ---------------------------------------------------------------------------
// shortest paths
// ---------------------------------------------------------------------------

describe("shortestPaths", () => {
  it("labels a one-hop connection with its verb", () => {
    const fx = fixture(["a", "b"], [["a", "b", "works_at"]]);
    const result = shortestPaths(fx.csr, fx.at("a"), fx.at("b"));
    expect(result.length).toBe(1);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]!.nodes.map(fx.idOf)).toEqual(["a", "b"]);
    expect(result.paths[0]!.hops).toHaveLength(1);
    expect(result.paths[0]!.hops[0]!.rel).toBe("works_at");
    expect(result.paths[0]!.hops[0]!.from).toBe(fx.at("a"));
    expect(result.paths[0]!.hops[0]!.to).toBe(fx.at("b"));
    // the slot is owned by `from`, so a caller can trust it
    const slot = result.paths[0]!.hops[0]!.slot;
    expect(slot).toBeGreaterThanOrEqual(fx.csr.offsets[fx.at("a")]!);
    expect(slot).toBeLessThan(fx.csr.offsets[fx.at("a") + 1]!);
  });

  it("returns EVERY equal-length path, each hop carrying its own verb", () => {
    //  a —(hired)→ m1 —(reports_to)→ b
    //  a —(met)→   m2 —(emailed)→    b
    //  a —(cited)→ m3 —(owns)→       b
    //  plus a longer route that must NOT be returned
    const fx = fixture(
      ["a", "b", "m1", "m2", "m3", "y1", "y2"],
      [
        ["a", "m1", "hired"],
        ["m1", "b", "reports_to"],
        ["a", "m2", "met"],
        ["m2", "b", "emailed"],
        ["a", "m3", "cited"],
        ["m3", "b", "owns"],
        ["a", "y1", "long"],
        ["y1", "y2", "long"],
        ["y2", "b", "long"],
      ],
    );
    const result = shortestPaths(fx.csr, fx.at("a"), fx.at("b"), { maxPaths: 3 });

    expect(result.length).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.paths).toHaveLength(3);

    const readable = result.paths
      .map((p) => p.hops.map((h) => `${fx.idOf(h.from)}-${h.rel}->${fx.idOf(h.to)}`).join(" "))
      .sort();
    expect(readable).toEqual([
      "a-cited->m3 m3-owns->b",
      "a-hired->m1 m1-reports_to->b",
      "a-met->m2 m2-emailed->b",
    ]);
    // every path really does run source → target
    for (const path of result.paths) {
      expect(path.nodes[0]).toBe(fx.at("a"));
      expect(path.nodes[path.nodes.length - 1]).toBe(fx.at("b"));
      expect(path.hops).toHaveLength(path.nodes.length - 1);
    }
  });

  it("caps at maxPaths and says so", () => {
    const fx = fixture(
      ["a", "b", "m1", "m2", "m3", "m4"],
      [
        ["a", "m1"],
        ["m1", "b"],
        ["a", "m2"],
        ["m2", "b"],
        ["a", "m3"],
        ["m3", "b"],
        ["a", "m4"],
        ["m4", "b"],
      ],
    );
    const capped = shortestPaths(fx.csr, fx.at("a"), fx.at("b"), { maxPaths: 3 });
    expect(capped.paths).toHaveLength(3);
    expect(capped.truncated).toBe(true);

    const two = shortestPaths(fx.csr, fx.at("a"), fx.at("b"), { maxPaths: 2 });
    expect(two.paths).toHaveLength(2);
    expect(two.truncated).toBe(true);

    const all = shortestPaths(fx.csr, fx.at("a"), fx.at("b"), { maxPaths: 4 });
    expect(all.paths).toHaveLength(4);
    expect(all.truncated).toBe(false);
  });

  it("finds a long path with alternates in the middle", () => {
    // s — p — (q1 | q2) — r — t : length 4, two shortest paths, and the join
    // level lands strictly inside the path.
    const fx = fixture(
      ["s", "p", "q1", "q2", "r", "t"],
      [
        ["s", "p", "a"],
        ["p", "q1", "b"],
        ["p", "q2", "c"],
        ["q1", "r", "d"],
        ["q2", "r", "e"],
        ["r", "t", "f"],
      ],
    );
    const result = shortestPaths(fx.csr, fx.at("s"), fx.at("t"));
    expect(result.length).toBe(4);
    expect(result.paths).toHaveLength(2);
    expect(result.paths.map((p) => p.nodes.map(fx.idOf).join(">")).sort()).toEqual([
      "s>p>q1>r>t",
      "s>p>q2>r>t",
    ]);
    for (const path of result.paths) {
      expect(path.hops.map((h) => h.rel)).toHaveLength(4);
      expect(path.hops.every((h) => h.rel.length > 0)).toBe(true);
    }
  });

  it("collapses parallel verbs into one hop rather than one path each", () => {
    const fx = fixture(
      ["a", "b"],
      [
        ["a", "b", "works_at"],
        ["a", "b", "founded"],
      ],
    );
    const result = shortestPaths(fx.csr, fx.at("a"), fx.at("b"));
    expect(result.paths).toHaveLength(1);
    expect(["works_at", "founded"]).toContain(result.paths[0]!.hops[0]!.rel);
  });

  it("reports unreachable as -1 with no paths, and never as a fake route", () => {
    const fx = fixture(["a", "b", "c"], [["a", "b"]]);
    const result = shortestPaths(fx.csr, fx.at("a"), fx.at("c"));
    expect(result.length).toBe(-1);
    expect(result.paths).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("handles the degenerate calls", () => {
    const fx = fixture(["a", "b"], [["a", "b"]]);
    const self = shortestPaths(fx.csr, fx.at("a"), fx.at("a"));
    expect(self.length).toBe(0);
    expect(self.paths).toEqual([{ nodes: [fx.at("a")], hops: [] }]);
    expect(shortestPaths(fx.csr, -1, fx.at("b")).length).toBe(-1);
    expect(shortestPaths(fx.csr, fx.at("a"), 999).length).toBe(-1);
  });

  it("matches an independent BFS oracle over a random graph, path by path", () => {
    const fx = randomFixture(4242, 300, 220);
    const adj = adjacency(fx);
    const random = mulberry32(9);
    const relsBetween = new Map<number, Set<string>>();
    for (const e of fx.edges) {
      const key = edgeKey(fx.at(e.from), fx.at(e.to));
      if (!relsBetween.has(key)) relsBetween.set(key, new Set());
      relsBetween.get(key)!.add(e.rel);
    }

    let reachable = 0;
    for (let trial = 0; trial < 60; trial += 1) {
      const a = Math.floor(random() * fx.csr.n);
      const b = Math.floor(random() * fx.csr.n);
      const expected = distancesFrom(adj, a, fx.csr.n)[b]!;
      const result = shortestPaths(fx.csr, a, b, { maxPaths: 3 });
      expect(result.length).toBe(expected);
      if (expected < 0) {
        expect(result.paths).toEqual([]);
        continue;
      }
      reachable += 1;
      expect(result.paths.length).toBeGreaterThan(0);
      expect(result.paths.length).toBeLessThanOrEqual(3);

      const seen = new Set<string>();
      for (const path of result.paths) {
        expect(path.nodes[0]).toBe(a);
        expect(path.nodes[path.nodes.length - 1]).toBe(b);
        expect(path.nodes.length - 1).toBe(expected);
        // no path returned twice, and no node visited twice
        const key = path.nodes.join(">");
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        expect(new Set(path.nodes).size).toBe(path.nodes.length);
        // every hop is a real edge, labelled with a verb that edge really has
        for (const hop of path.hops) {
          expect(adj.get(hop.from)!.has(hop.to)).toBe(true);
          expect(relsBetween.get(edgeKey(hop.from, hop.to))!.has(hop.rel)).toBe(true);
        }
      }
    }
    expect(reachable).toBeGreaterThan(20); // the fixture must actually connect
  });

  it("returns all of them when brute force says there are few", () => {
    const fx = randomFixture(77, 120, 90);
    const adj = adjacency(fx);
    const random = mulberry32(3);
    for (let trial = 0; trial < 40; trial += 1) {
      const a = Math.floor(random() * fx.csr.n);
      const b = Math.floor(random() * fx.csr.n);
      const brute = allShortestPaths(adj, fx.csr.n, a, b);
      const result = shortestPaths(fx.csr, a, b, { maxPaths: 3 });
      if (brute.length === 0) {
        expect(result.paths).toEqual([]);
        continue;
      }
      expect(result.paths.length).toBe(Math.min(3, brute.length));
      expect(result.truncated).toBe(brute.length > 3);
      const bruteKeys = new Set(brute.map((p) => p.join(">")));
      for (const path of result.paths) expect(bruteKeys.has(path.nodes.join(">"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// hubs and orphans
// ---------------------------------------------------------------------------

describe("topHubs / orphans", () => {
  const fx = randomFixture(5150, 400, 500);

  it("ranks hubs by visible degree, ties broken by index", () => {
    const hubs = topHubs(fx.csr, 12);
    const brute = [...Array(fx.csr.n).keys()]
      .map((i) => ({ index: i, score: fx.csr.offsets[i + 1]! - fx.csr.offsets[i]! }))
      .filter((row) => row.score > 0)
      .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
      .slice(0, 12);
    expect(hubs).toEqual(brute);
  });

  it("never pads the hub list with isolated objects", () => {
    const sparse = fixture(["a", "b", "lonely1", "lonely2"], [["a", "b"]]);
    expect(
      topHubs(sparse.csr, 10)
        .map((row) => sparse.idOf(row.index))
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("finds exactly the visible-degree-0 objects", () => {
    const brute: number[] = [];
    for (let i = 0; i < fx.csr.n; i += 1) {
      if (fx.csr.offsets[i + 1]! === fx.csr.offsets[i]!) brute.push(i);
    }
    expect(orphans(fx.csr)).toEqual(brute);
    // and the brute force is not vacuous
    const isolated = fixture(["a", "b", "alone"], [["a", "b"]]);
    expect(orphans(isolated.csr).map(isolated.idOf)).toEqual(["alone"]);
  });

  it("drops non-positive scores from a ranking", () => {
    expect(topByScore([0, 4, 0, 1], 10)).toEqual([
      { index: 1, score: 4 },
      { index: 3, score: 1 },
    ]);
    expect(topByScore([1, 2, 3], 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// betweenness
// ---------------------------------------------------------------------------

describe("betweenness", () => {
  it("matches the closed form for a path graph (which pins the halving)", () => {
    // 0—1—2—3—4: node i sits on i * (n - 1 - i) shortest pairs.
    const ids = ["p0", "p1", "p2", "p3", "p4"];
    const fx = fixture(
      ids,
      ids.slice(1).map((id, i) => [ids[i]!, id] as EdgeSpec),
    );
    const { scores, exact } = betweenness(fx.csr);
    expect(exact).toBe(true);
    for (let i = 0; i < ids.length; i += 1) {
      expect(scores[fx.at(ids[i]!)]).toBeCloseTo(i * (ids.length - 1 - i), 9);
    }
  });

  it("gives a star's centre every pair and its leaves none", () => {
    const fx = fixture(
      ["hub", "l1", "l2", "l3", "l4"],
      [
        ["hub", "l1"],
        ["hub", "l2"],
        ["hub", "l3"],
        ["hub", "l4"],
      ],
    );
    const { scores } = betweenness(fx.csr);
    expect(scores[fx.at("hub")]).toBeCloseTo(6, 9); // C(4, 2) pairs
    for (const leaf of ["l1", "l2", "l3", "l4"]) expect(scores[fx.at(leaf)]).toBe(0);
  });

  it("finds the BROKER that degree misses", () => {
    // Two 4-cliques joined by one edge through `broker`. The broker has degree
    // 4 while the clique members have 4 or 5 — degree cannot tell them apart,
    // betweenness can.
    const edges: EdgeSpec[] = [];
    for (const side of ["L", "R"]) {
      for (let i = 0; i < 4; i += 1) {
        for (let j = i + 1; j < 4; j += 1) edges.push([`${side}${i}`, `${side}${j}`]);
      }
    }
    edges.push(["L0", "broker"]);
    edges.push(["broker", "R0"]);
    const ids = ["broker", ...["L", "R"].flatMap((s) => [0, 1, 2, 3].map((i) => `${s}${i}`))];
    const fx = fixture(ids, edges);

    const { scores } = betweenness(fx.csr);
    const brokers = topByScore(scores, 3).map((row) => fx.idOf(row.index));
    expect(brokers[0]).toBe("broker");
    // and degree genuinely does NOT single it out
    const byDegree = topHubs(fx.csr, 3).map((row) => fx.idOf(row.index));
    expect(byDegree).not.toContain("broker");
  });

  it("is not inflated by parallel verbs between the same pair", () => {
    const single = fixture(
      ["a", "b", "c"],
      [
        ["a", "b", "one"],
        ["b", "c", "one"],
      ],
    );
    const parallel = fixture(
      ["a", "b", "c"],
      [
        ["a", "b", "one"],
        ["a", "b", "two"],
        ["b", "c", "one"],
        ["b", "c", "two"],
      ],
    );
    expect(betweenness(parallel.csr).scores[parallel.at("b")]).toBe(
      betweenness(single.csr).scores[single.at("b")],
    );
  });

  it("is empty, not broken, on a graph with no edges", () => {
    const fx = fixture(["a", "b"], []);
    const result = betweenness(fx.csr);
    expect(result.pivots).toBe(0);
    expect([...result.scores]).toEqual([0, 0]);
  });

  it("is deterministic: the same graph ranks the same way twice", () => {
    const { fx } = clusteredFixture(31);
    const a = betweenness(fx.csr, { exactMax: 0, pivots: BETWEENNESS_PIVOTS });
    const b = betweenness(fx.csr, { exactMax: 0, pivots: BETWEENNESS_PIVOTS });
    expect([...a.scores]).toEqual([...b.scores]);
  });

  it("sampled 64 pivots agrees with exact on the top ten", () => {
    const { fx, bridges, gateways } = clusteredFixture(2026);
    expect(fx.csr.n).toBe(605);

    const exact = betweenness(fx.csr);
    expect(exact.exact).toBe(true);
    expect(exact.pivots).toBe(fx.csr.n);

    const sampled = betweenness(fx.csr, { exactMax: 0, pivots: 64, seed: 11 });
    expect(sampled.exact).toBe(false);
    expect(sampled.pivots).toBe(64);

    const exactTop = topByScore(exact.scores, 10).map((row) => row.index);
    const sampledTop = topByScore(sampled.scores, 10).map((row) => row.index);

    // The planted brokers are the answer, and both runs find them: nothing but
    // a bridge or a gateway can make the top ten, because every inter-cluster
    // pair in the fixture is forced through one.
    const planted = new Set([...bridges, ...gateways]);
    for (const index of exactTop) expect(planted.has(index)).toBe(true);
    for (const index of sampledTop) expect(planted.has(index)).toBe(true);

    // Every BRIDGE the exact run ranks in the top ten is in the sampled top ten
    // too. (Not every bridge makes it: the chain's end bridges carry a genuinely
    // smaller cut than the middle ones, and betweenness is right about that.)
    const isBridge = new Set(bridges);
    const exactBridges = exactTop.filter((index) => isBridge.has(index));
    expect(exactBridges.length).toBeGreaterThanOrEqual(3);
    for (const bridge of exactBridges) expect(sampledTop).toContain(bridge);

    // …and the two rankings are the same list, give or take the tail.
    const overlap = sampledTop.filter((index) => exactTop.includes(index)).length;
    expect(overlap).toBeGreaterThanOrEqual(8);
    expect(sampledTop[0]).toBe(exactTop[0]);
  });

  it("stays exact when the pivot budget covers every eligible node", () => {
    const fx = fixture(
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    const result = betweenness(fx.csr, { exactMax: 0, pivots: 64 });
    expect(result.exact).toBe(true);
    expect(result.scores[fx.at("b")]).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------
// analyze + the worker protocol
// ---------------------------------------------------------------------------

describe("analyze", () => {
  const fx = randomFixture(808, 250, 300);

  it("is exactly the individual answers, in one pass", () => {
    const summary = analyze(fx.csr, { hubs: 5, brokers: 5 });
    expect(summary.n).toBe(fx.csr.n);
    expect(summary.m).toBe(fx.csr.m);
    expect(summary.hubs).toEqual(topHubs(fx.csr, 5));
    expect(summary.orphans).toEqual(orphans(fx.csr));
    expect(summary.brokers).toEqual(topByScore(betweenness(fx.csr).scores, 5));
    expect(summary.betweennessExact).toBe(true);
    expect(summary.ms).toBeGreaterThanOrEqual(0);
  });

  it("skips Brandes when the caller does not need brokers", () => {
    const summary = analyze(fx.csr, { skipBetweenness: true });
    expect(summary.brokers).toEqual([]);
    expect(summary.betweennessPivots).toBe(0);
    expect(summary.hubs.length).toBeGreaterThan(0);
  });
});

describe("AnalysisEngine", () => {
  const fx = randomFixture(9090, 80, 60);

  it("answers an analyze command with the same summary as the inline call", () => {
    const events: AnalysisEvent[] = [];
    const engine = new AnalysisEngine((event) => events.push(event));
    engine.handle({ type: "analyze", id: 7, csr: fx.csr, options: { hubs: 3, brokers: 3 } });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("result");
    if (event.type !== "result") throw new Error("unreachable");
    expect(event.id).toBe(7);
    expect(event.summary.hubs).toEqual(topHubs(fx.csr, 3));
    expect(event.summary.orphans).toEqual(orphans(fx.csr));
  });

  it("reports a malformed command as an error event instead of dying", () => {
    const events: AnalysisEvent[] = [];
    const engine = new AnalysisEngine((event) => events.push(event));
    engine.handle({ type: "analyze", id: 3, csr: { n: 4 } });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect(events[0]!.id).toBe(3);
  });

  it("ignores a message it does not own", () => {
    const events: AnalysisEvent[] = [];
    const engine = new AnalysisEngine((event) => events.push(event));
    engine.handle({ type: "tick" });
    engine.handle(null);
    engine.handle(undefined);
    expect(events).toEqual([]);
  });

  it("revives a plain-array CSR and refuses an inconsistent one", () => {
    const revived = reviveCsr({
      n: fx.csr.n,
      m: fx.csr.m,
      offsets: [...fx.csr.offsets],
      neighbors: [...fx.csr.neighbors],
      relIndex: [...fx.csr.relIndex],
      rels: [...fx.csr.rels],
    });
    expect(revived.offsets).toEqual(fx.csr.offsets);
    expect(() =>
      reviveCsr({ n: 2, offsets: [0], neighbors: [], relIndex: [], rels: [] }),
    ).toThrow();
    expect(() => reviveCsr(null)).toThrow();
  });
});

describe("requestAnalysis", () => {
  /** A worker double: the engine, wired through the same message shapes. */
  function fakeWorker(): AnalysisWorkerLike {
    const listeners = new Set<(event: { data: unknown }) => void>();
    const engine = new AnalysisEngine((event) => {
      for (const listener of [...listeners]) listener({ data: event });
    });
    return {
      postMessage: (message: unknown) => {
        engine.handle(message);
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      terminate: () => {
        listeners.clear();
      },
    };
  }

  it("resolves with the summary and unsubscribes itself", async () => {
    const fx = randomFixture(5, 60, 40);
    const worker = fakeWorker();
    const summary = await requestAnalysis(worker, fx.csr, { hubs: 4 });
    expect(summary.hubs).toEqual(topHubs(fx.csr, 4));
  });

  it("rejects on an error event rather than hanging the panel", async () => {
    const worker = fakeWorker();
    await expect(requestAnalysis(worker, { n: 3 } as unknown as Csr)).rejects.toThrow(/csr/);
  });

  it("never resolves one request with another's answer", async () => {
    const a = randomFixture(1, 40, 20);
    const b = randomFixture(2, 90, 70);
    const worker = fakeWorker();
    const [first, second] = await Promise.all([
      requestAnalysis(worker, a.csr, { hubs: 2 }),
      requestAnalysis(worker, b.csr, { hubs: 2 }),
    ]);
    expect(first.n).toBe(a.csr.n);
    expect(second.n).toBe(b.csr.n);
  });
});
