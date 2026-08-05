import Graph from "graphology";
import { describe, expect, it } from "vitest";

import {
  CSR_MAX_NODES,
  buildCsr,
  degree,
  edgeKey,
  forEachNeighbor,
  neighborsOf,
  relOf,
  slotRange,
  unpackEdgeKey,
} from "./csr";
import { GraphStore } from "./store";
import type { GraphEdge, GraphNode } from "./types";

/**
 * Two things carry this file.
 *
 * The first is that the CSR is a hand-rolled index, and everything downstream
 * (hover isolation, shortest path, the rail's BFS, culling) trusts it
 * completely — a mis-indexed neighbour is not a crash, it is the WRONG object
 * highlighted, which nobody notices until it is in front of a customer. So the
 * adjacency is checked against graphology ground truth built independently from
 * the same generated data: same neighbour sets, same degrees, symmetric under
 * undirected traversal, and the interned rel table round-tripping every hop.
 *
 * The second is the drop rule. An edge naming a node this client was never
 * given is DROPPED — never rendered against a synthesized placeholder — because
 * a placeholder re-creates exactly the hidden-neighbour hint that the server's
 * both-endpoints-visible and visible-only-degree rules exist to prevent. It is
 * asserted from both directions: the edge is gone, and so is any trace of the
 * unknown id (no index, no node, no rel-table entry).
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

const RELS = ["works_at", "mentions", "owns", "blocked_by", "part_of"] as const;

interface Generated {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * A random graph with the shapes a real brain produces: parallel edges (two
 * verbs between the same pair), repeated rows (a retried page), and the
 * occasional self-link.
 */
function randomGraph(seed: number, n: number, m: number): Generated {
  const rnd = mulberry32(seed);
  const nodes: GraphNode[] = [];
  for (let i = 0; i < n; i += 1) {
    nodes.push({
      id: `obj-${i}`,
      title: i % 7 === 0 ? null : `Object ${i}`,
      type: i % 3 === 0 ? null : `type-${i % 5}`,
      degree: 0,
    });
  }
  const edges: GraphEdge[] = [];
  for (let k = 0; k < m; k += 1) {
    const a = Math.floor(rnd() * n);
    const b = Math.floor(rnd() * n);
    edges.push({
      from: `obj-${a}`,
      to: `obj-${b}`,
      rel: RELS[Math.floor(rnd() * RELS.length)]!,
    });
    // ~5% of rows are a duplicate of the one just emitted (a retried page).
    if (rnd() < 0.05) edges.push({ ...edges[edges.length - 1]! });
  }
  return { nodes, edges };
}

/**
 * The store's documented survivors: no self-loops, and each from|to|rel once.
 * Held as a graphology graph built with graphology's own API — the ground truth
 * the CSR is measured against.
 */
function groundTruth(g: Generated): Graph {
  const gt = new Graph({ type: "directed", multi: true, allowSelfLoops: false });
  for (const n of g.nodes) gt.addNode(n.id);
  for (const e of g.edges) {
    if (e.from === e.to) continue;
    const key = `${e.from}|${e.to}|${e.rel}`;
    if (gt.hasEdge(key)) continue;
    gt.addDirectedEdgeWithKey(key, e.from, e.to, { rel: e.rel });
  }
  return gt;
}

/**
 * Ingest in pages the way the server pages: every edge rides the page carrying
 * its LATER endpoint, so both endpoints have already arrived and nothing legit
 * is ever dropped. (That contract is exactly why dropping is safe.)
 */
function ingestPaged(g: Generated, pageSize: number): GraphStore {
  const store = new GraphStore();
  const pageOf = new Map<string, number>();
  g.nodes.forEach((n, i) => pageOf.set(n.id, Math.floor(i / pageSize)));

  const pages = Math.max(1, Math.ceil(g.nodes.length / pageSize));
  const edgesByPage: GraphEdge[][] = Array.from({ length: pages }, () => []);
  for (const e of g.edges) {
    const pf = pageOf.get(e.from);
    const pt = pageOf.get(e.to);
    if (pf === undefined || pt === undefined) continue;
    edgesByPage[Math.max(pf, pt)]!.push(e);
  }

  for (let p = 0; p < pages; p += 1) {
    store.ingest({
      nodes: g.nodes.slice(p * pageSize, (p + 1) * pageSize),
      edges: edgesByPage[p]!,
    });
  }
  return store;
}

// ---------------------------------------------------------------------------
// CSR vs graphology
// ---------------------------------------------------------------------------

describe("buildCsr against graphology ground truth", () => {
  const seeds = [1, 7, 42, 1337, 90210];

  for (const seed of seeds) {
    it(`matches neighbour sets and degrees (seed ${seed})`, () => {
      const g = randomGraph(seed, 120, 400);
      const gt = groundTruth(g);
      const store = ingestPaged(g, 37);
      const csr = buildCsr(store);

      expect(store.order).toBe(gt.order);
      expect(store.size).toBe(gt.size);
      expect(csr.n).toBe(gt.order);
      expect(csr.m).toBe(gt.size);
      expect(csr.neighbors.length).toBe(2 * gt.size);
      expect(csr.relIndex.length).toBe(csr.neighbors.length);

      for (let i = 0; i < csr.n; i += 1) {
        const id = store.idAt(i)!;

        // Same neighbour SET as graphology (which dedupes parallel verbs).
        const mine = new Set<string>();
        for (const j of neighborsOf(csr, i)) mine.add(store.idAt(j)!);
        expect([...mine].sort()).toEqual([...gt.neighbors(id)].sort());

        // Same DEGREE, counting each incident edge — including parallel verbs,
        // which is why the ground truth is `edges(node).length` rather than a
        // neighbour count.
        expect(degree(csr, i)).toBe(gt.edges(id).length);
      }
    });

    it(`is symmetric under undirected traversal (seed ${seed})`, () => {
      const g = randomGraph(seed, 90, 260);
      const csr = buildCsr(ingestPaged(g, 25));

      // Multiset symmetry: j appears in i's list exactly as often as i appears
      // in j's — parallel verbs included, or hover isolation would light up an
      // asymmetric neighbourhood.
      const count = (i: number, j: number) => {
        let c = 0;
        for (const k of neighborsOf(csr, i)) if (k === j) c += 1;
        return c;
      };
      for (let i = 0; i < csr.n; i += 1) {
        for (const j of new Set(neighborsOf(csr, i))) {
          expect(count(i, j)).toBe(count(j, i));
        }
      }
    });

    it(`round-trips every rel through the interned table (seed ${seed})`, () => {
      const g = randomGraph(seed, 80, 240);
      const gt = groundTruth(g);
      const store = ingestPaged(g, 19);
      const csr = buildCsr(store);

      const tally = new Map<string, number>();
      const bump = (m: Map<string, number>, k: string, by: number) =>
        m.set(k, (m.get(k) ?? 0) + by);
      // Both sides canonicalize the undirected pair the SAME way (lexicographic
      // on the id, not on the dense index — "obj-10" sorts before "obj-9" while
      // index 9 comes before index 10, and mixing the two silently compares
      // different keys).
      const pairKey = (x: string, y: string, rel: string | null) =>
        x < y ? `${x}|${y}|${rel}` : `${y}|${x}|${rel}`;

      for (let i = 0; i < csr.n; i += 1) {
        forEachNeighbor(csr, i, (j, slot) => {
          bump(tally, pairKey(store.idAt(i)!, store.idAt(j)!, relOf(csr, slot)), 1);
        });
      }

      const expected = new Map<string, number>();
      gt.forEachEdge((_e, attrs, source, target) => {
        // Each edge contributes one half on each endpoint.
        bump(expected, pairKey(source, target, (attrs as { rel: string }).rel), 2);
      });

      expect(tally).toEqual(expected);

      // Interning: one entry per DISTINCT verb, not per edge.
      const distinct = new Set<string>();
      gt.forEachEdge((_e, attrs) => distinct.add((attrs as { rel: string }).rel));
      expect([...csr.rels].sort()).toEqual([...distinct].sort());
    });
  }

  it("builds the same adjacency however the pages are cut", () => {
    const g = randomGraph(5, 70, 200);
    const onePage = buildCsr(ingestPaged(g, 70));
    const csr = buildCsr(ingestPaged(g, 9));

    expect(csr.n).toBe(onePage.n);
    expect(csr.m).toBe(onePage.m);
    // Ids arrive in the same order either way, so the dense indices — and
    // therefore every row's extent — agree exactly.
    expect([...csr.offsets]).toEqual([...onePage.offsets]);

    // Within a row the slot ORDER follows edge-insertion order, which paging
    // legitimately permutes; nothing downstream depends on it (every consumer
    // walks the whole row). What must agree is each row's (neighbour, rel)
    // MULTISET — that is the adjacency itself.
    const row = (c: typeof csr, i: number): string[] => {
      const out: string[] = [];
      forEachNeighbor(c, i, (j, slot) => out.push(`${j}|${relOf(c, slot)}`));
      return out.sort();
    };
    for (let i = 0; i < csr.n; i += 1) {
      expect(row(csr, i)).toEqual(row(onePage, i));
    }
  });

  it("keeps offsets a valid prefix sum with every neighbour in range", () => {
    const csr = buildCsr(ingestPaged(randomGraph(11, 60, 150), 13));
    expect(csr.offsets.length).toBe(csr.n + 1);
    expect(csr.offsets[0]).toBe(0);
    expect(csr.offsets[csr.n]).toBe(csr.neighbors.length);
    for (let i = 0; i < csr.n; i += 1) {
      expect(csr.offsets[i + 1]!).toBeGreaterThanOrEqual(csr.offsets[i]!);
      expect(slotRange(csr, i)).toEqual([csr.offsets[i], csr.offsets[i + 1]]);
    }
    for (const j of csr.neighbors) {
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(csr.n);
    }
  });

  it("handles an empty store", () => {
    const csr = buildCsr(new GraphStore());
    expect(csr.n).toBe(0);
    expect(csr.m).toBe(0);
    expect(csr.offsets.length).toBe(1);
    expect(csr.neighbors.length).toBe(0);
    expect(csr.rels).toEqual([]);
    expect(degree(csr, 0)).toBe(0);
    expect(neighborsOf(csr, 0).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the drop rule
// ---------------------------------------------------------------------------

describe("edges naming an unknown node are dropped, never placeholdered", () => {
  const A: GraphNode = { id: "a", title: "A", type: "note", degree: 1 };
  const B: GraphNode = { id: "b", title: "B", type: "note", degree: 1 };

  it("drops the edge and leaves no trace of the unknown id", () => {
    const store = new GraphStore();
    const stats = store.ingest({
      nodes: [A, B],
      edges: [
        { from: "a", to: "b", rel: "knows" },
        { from: "a", to: "ghost", rel: "secret_rel" },
        { from: "ghost-2", to: "b", rel: "other_secret" },
      ],
    });

    expect(stats.edgesAdded).toBe(1);
    expect(stats.edgesDropped).toBe(2);
    expect(stats.nodesAdded).toBe(2);

    // No placeholder node was synthesized: the unknown ids have no index, no
    // node, and no seat in the dense map — nothing to render, nothing to hint.
    expect(store.order).toBe(2);
    expect(store.has("ghost")).toBe(false);
    expect(store.indexOf("ghost-2")).toBeUndefined();
    expect(store.indexToId).toEqual(["a", "b"]);

    const csr = buildCsr(store);
    expect(csr.m).toBe(1);
    expect(degree(csr, store.indexOf("a")!)).toBe(1);
    expect(degree(csr, store.indexOf("b")!)).toBe(1);
    // Not even the hidden edge's VERB leaks into the interned table.
    expect(csr.rels).toEqual(["knows"]);
  });

  it("does not resurrect a dropped edge when the node arrives later", () => {
    const store = new GraphStore();
    store.ingest({ nodes: [A], edges: [{ from: "a", to: "b", rel: "knows" }] });
    expect(buildCsr(store).m).toBe(0);

    // The server emits an edge on the page carrying its later endpoint, so this
    // never happens for a live row; when it does, the row is genuinely gone and
    // must stay gone until it is re-sent.
    store.ingest({ nodes: [B], edges: [] });
    expect(buildCsr(store).m).toBe(0);

    store.ingest({ nodes: [], edges: [{ from: "a", to: "b", rel: "knows" }] });
    expect(buildCsr(store).m).toBe(1);
  });

  it("drops self-links rather than double-counting a degree", () => {
    const store = new GraphStore();
    const stats = store.ingest({
      nodes: [A],
      edges: [{ from: "a", to: "a", rel: "relates_to" }],
    });
    expect(stats.selfLoopsDropped).toBe(1);
    expect(stats.edgesAdded).toBe(0);
    expect(degree(buildCsr(store), 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ingest merge semantics (what the CSR's index stability rests on)
// ---------------------------------------------------------------------------

describe("GraphStore.ingest merges pages", () => {
  it("never moves the dense index of a node it already holds", () => {
    const g = randomGraph(3, 40, 90);
    const store = new GraphStore();
    store.ingest({ nodes: g.nodes.slice(0, 20), edges: [] });
    const before = new Map(store.idToIndex);

    store.ingest({ nodes: g.nodes.slice(10, 40), edges: [] });
    for (const [id, i] of before) expect(store.idToIndex.get(id)).toBe(i);
    expect(store.order).toBe(40);
    expect(store.indexToId.length).toBe(40);
  });

  it("is idempotent under a retried page", () => {
    const g = randomGraph(9, 30, 80);
    const store = new GraphStore();
    const first = store.ingest({ nodes: g.nodes, edges: g.edges });
    const csr1 = buildCsr(store);

    const again = store.ingest({ nodes: g.nodes, edges: g.edges });
    const csr2 = buildCsr(store);

    expect(again.nodesAdded).toBe(0);
    expect(again.edgesAdded).toBe(0);
    expect(again.nodesUpdated).toBe(g.nodes.length);
    expect(again.edgesRepeated + again.selfLoopsDropped).toBe(g.edges.length);
    expect(first.edgesAdded).toBe(csr1.m);
    expect([...csr2.neighbors]).toEqual([...csr1.neighbors]);
    expect([...csr2.offsets]).toEqual([...csr1.offsets]);
  });

  it("refreshes attributes and bumps the revision only on a real change", () => {
    const store = new GraphStore();
    store.ingest({ nodes: [{ id: "a", title: "old", type: null, degree: 0 }], edges: [] });
    const rev = store.revision;

    store.ingest({ nodes: [], edges: [] });
    expect(store.revision).toBe(rev);

    store.ingest({ nodes: [{ id: "a", title: "new", type: "person", degree: 4 }], edges: [] });
    expect(store.revision).toBe(rev + 1);
    expect(store.node("a")).toEqual({ id: "a", title: "new", type: "person", degree: 4 });
    expect(store.nodeAt(0)?.title).toBe("new");
    expect(store.nodeAt(9)).toBeUndefined();
  });

  it("clears everything, including the index maps", () => {
    const store = ingestPaged(randomGraph(2, 20, 40), 20);
    store.clear();
    expect(store.order).toBe(0);
    expect(store.size).toBe(0);
    expect(store.idToIndex.size).toBe(0);
    expect(store.indexToId).toEqual([]);
    expect(buildCsr(store).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// accessors
// ---------------------------------------------------------------------------

describe("accessors are allocation-lean and total", () => {
  const csr = buildCsr(ingestPaged(randomGraph(21, 50, 140), 17));

  it("returns a VIEW over the CSR's own buffer, not a copy", () => {
    const view = neighborsOf(csr, 3);
    expect(view.buffer).toBe(csr.neighbors.buffer);
    expect(view.length).toBe(degree(csr, 3));
  });

  it("agrees with forEachNeighbor", () => {
    for (let i = 0; i < csr.n; i += 1) {
      const walked: number[] = [];
      const slots: number[] = [];
      forEachNeighbor(csr, i, (j, slot) => {
        walked.push(j);
        slots.push(slot);
      });
      expect(walked).toEqual([...neighborsOf(csr, i)]);
      for (const s of slots) expect(csr.rels).toContain(relOf(csr, s));
    }
  });

  it("answers for out-of-range indices instead of throwing", () => {
    expect(degree(csr, -1)).toBe(0);
    expect(degree(csr, csr.n)).toBe(0);
    expect(neighborsOf(csr, -1).length).toBe(0);
    expect(neighborsOf(csr, csr.n + 5).length).toBe(0);
    expect(slotRange(csr, -1)).toEqual([0, 0]);
    expect(relOf(csr, -1)).toBeNull();
    expect(relOf(csr, csr.neighbors.length)).toBeNull();
    let called = 0;
    forEachNeighbor(csr, csr.n, () => {
      called += 1;
    });
    expect(called).toBe(0);
  });
});

describe("edgeKey", () => {
  it("is order-independent and round-trips", () => {
    expect(edgeKey(4, 9)).toBe(edgeKey(9, 4));
    expect(unpackEdgeKey(edgeKey(9, 4))).toEqual([4, 9]);
    expect(edgeKey(0, 0)).toBe(0);
    expect(edgeKey(1, 2)).not.toBe(edgeKey(1, 3));
    expect(edgeKey(1, 2)).not.toBe(edgeKey(2, 3));
  });

  it("stays an exact integer across the whole index space", () => {
    const max = edgeKey(CSR_MAX_NODES - 1, CSR_MAX_NODES - 1);
    expect(Number.isSafeInteger(max)).toBe(true);
    expect(unpackEdgeKey(max)).toEqual([CSR_MAX_NODES - 1, CSR_MAX_NODES - 1]);
  });
});
