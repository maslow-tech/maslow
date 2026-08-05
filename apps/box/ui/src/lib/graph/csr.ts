/**
 * CSR (compressed sparse row) adjacency over the store's dense indices, built
 * once per load.
 *
 * This is the file that makes the graph a working surface instead of a picture.
 * Hover isolation runs on every mouse move, shortest path runs on every ⌘-click,
 * the rail's local graph runs a BFS on every navigation, and viewport culling
 * runs every frame — all of them are one-hop walks, and all of them must cost
 * nothing. Three flat `Int32Array`s give a one-hop lookup in O(deg) with no
 * allocation and no pointer chasing, where a `Map<string, string[]>` would
 * allocate an array per node per query and thrash the GC at 60Hz.
 *
 *   offsets:   n+1 prefix sums; node i owns slots [offsets[i], offsets[i+1])
 *   neighbors: 2m; the neighbour's dense index at each slot
 *   relIndex:  2m; parallel to neighbors — an index into the interned `rels`
 *
 * The rel table is interned because a brain has a handful of verbs across tens
 * of thousands of edges: an Int32 per half-edge plus one string per distinct
 * verb, instead of one string reference per half-edge, is what lets
 * shortest-path label every hop without touching the store.
 *
 * Undirected by construction (each edge writes a slot on BOTH endpoints) —
 * every traversal the graph performs is undirected, and direction is still on
 * the store's graphology graph for arrowheads and the rail's in/out toggles.
 * Parallel edges (two verbs between the same pair) are kept as two slots, so
 * `degree(csr, i)` equals graphology's `degree` and the rel table round-trips.
 */

import type { GraphStore } from "./store";
import type { Csr } from "./types";

/**
 * The index space `edgeKey` packs into. Dense indices are bounded by the
 * server's `GRAPH_FULL_MAX` (5,000) by a wide margin; 2^26 keeps the packed key
 * exactly representable as a float64 integer (2^26 * 2^26 = 2^52 < 2^53).
 */
export const CSR_MAX_NODES = 1 << 26;

/** Returned for an out-of-range node so callers never branch on undefined. */
const EMPTY = new Int32Array(0);

/**
 * Build the adjacency. Two passes over the edges (count, then fill) so the
 * arrays are allocated exactly once at their final size — a growable
 * intermediate would allocate n arrays and copy them.
 */
export function buildCsr(store: GraphStore): Csr {
  const n = store.order;
  const offsets = new Int32Array(n + 1);

  // Pass 1 — count half-edges per node, straight into offsets[i + 1] so the
  // prefix sum below can run in place.
  store.graph.forEachEdge((_edge, _attrs, source, target) => {
    const a = store.idToIndex.get(source);
    const b = store.idToIndex.get(target);
    // Unreachable while the store is the only writer (it refuses an edge whose
    // endpoints it does not hold), but a CSR that silently mis-indexes is a
    // class of bug that shows up as the wrong object highlighted, so skip.
    if (a === undefined || b === undefined) return;
    offsets[a + 1] = offsets[a + 1]! + 1;
    offsets[b + 1] = offsets[b + 1]! + 1;
  });

  for (let i = 0; i < n; i += 1) {
    offsets[i + 1] = offsets[i + 1]! + offsets[i]!;
  }

  const total = offsets[n]!;
  const neighbors = new Int32Array(total);
  const relIndex = new Int32Array(total);

  // Write cursor per node, seeded at each node's first slot.
  const cursor = new Int32Array(n);
  for (let i = 0; i < n; i += 1) cursor[i] = offsets[i]!;

  const rels: string[] = [];
  const relIds = new Map<string, number>();

  // Pass 2 — fill both halves of every edge.
  store.graph.forEachEdge((_edge, attrs, source, target) => {
    const a = store.idToIndex.get(source);
    const b = store.idToIndex.get(target);
    if (a === undefined || b === undefined) return;

    const rel = attrs.rel ?? "";
    let r = relIds.get(rel);
    if (r === undefined) {
      r = rels.length;
      rels.push(rel);
      relIds.set(rel, r);
    }

    const pa = cursor[a]!;
    cursor[a] = pa + 1;
    neighbors[pa] = b;
    relIndex[pa] = r;

    const pb = cursor[b]!;
    cursor[b] = pb + 1;
    neighbors[pb] = a;
    relIndex[pb] = r;
  });

  return { n, m: total / 2, offsets, neighbors, relIndex, rels };
}

/**
 * The neighbours of node `i` as a SUBARRAY VIEW — same underlying buffer, no
 * copy of the data. Safe to iterate in a hot loop; do not mutate it (it is the
 * CSR's own storage).
 *
 * For the truly allocation-free path (no view object at all), and when the rel
 * of each hop is needed, use `forEachNeighbor`.
 */
export function neighborsOf(csr: Csr, i: number): Int32Array {
  if (i < 0 || i >= csr.n) return EMPTY;
  return csr.neighbors.subarray(csr.offsets[i]!, csr.offsets[i + 1]!);
}

/**
 * Walk the neighbours of `i` with zero allocation of any kind. `slot` is the
 * half-edge slot, so `relOf(csr, slot)` names the hop.
 */
export function forEachNeighbor(
  csr: Csr,
  i: number,
  fn: (neighbor: number, slot: number) => void,
): void {
  if (i < 0 || i >= csr.n) return;
  const end = csr.offsets[i + 1]!;
  for (let s = csr.offsets[i]!; s < end; s += 1) {
    fn(csr.neighbors[s]!, s);
  }
}

/** Degree of node `i` over the visible subgraph, O(1), no allocation. */
export function degree(csr: Csr, i: number): number {
  if (i < 0 || i >= csr.n) return 0;
  return csr.offsets[i + 1]! - csr.offsets[i]!;
}

/** The relationship verb at a half-edge slot, or null if the slot is invalid. */
export function relOf(csr: Csr, slot: number): string | null {
  if (slot < 0 || slot >= csr.neighbors.length) return null;
  return csr.rels[csr.relIndex[slot]!] ?? null;
}

/** The half-edge slot range `[start, end)` owned by node `i`. */
export function slotRange(csr: Csr, i: number): readonly [number, number] {
  if (i < 0 || i >= csr.n) return [0, 0];
  return [csr.offsets[i]!, csr.offsets[i + 1]!];
}

/**
 * An order-independent key for the undirected pair (a, b) — what a
 * `HighlightSet.edges` holds, so a path or a hover can be tested against an
 * edge from either end without allocating a string per edge per frame.
 */
export function edgeKey(a: number, b: number): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * CSR_MAX_NODES + hi;
}

/** Inverse of `edgeKey`. */
export function unpackEdgeKey(key: number): [number, number] {
  const lo = Math.floor(key / CSR_MAX_NODES);
  return [lo, key - lo * CSR_MAX_NODES];
}
