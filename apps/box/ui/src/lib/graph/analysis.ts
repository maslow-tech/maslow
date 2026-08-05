/**
 * Graph ANALYSIS over the CSR — the questions no table view can answer.
 *
 * Everything here is a pure function of a `Csr` (plus, for the direction
 * filters, an orientation mask). No DOM, no worker globals, no d3, no
 * graphology at runtime — which is what lets the heavy half of the file
 * (`betweenness`) run unchanged inside `analysis.worker.ts` and the cheap half
 * (`bfs`, `shortestPaths`) run on the main thread inside a pointer handler.
 *
 * Four things earn their place, each because it converts "pretty" into "here
 * is what to do":
 *
 *  1. **`bfs`** — one walk, used by three surfaces: the rail's local graph
 *     (depth 1–3), the depth filters, and the neighbour-link toggle. It hands
 *     back `levels` (the rail's radial rings ride on hop count), `parents` and
 *     `parentSlots` (the spawn-at-your-parent animation and the verb on a tree
 *     edge), and the visit `order`. Tree edges and "all edges among the set"
 *     are two separate exported functions because they are two different
 *     claims about the data: the tree is a hierarchy, the internal set is the
 *     true local density, and the rail's toggle picks.
 *  2. **`shortestPaths`** — "how are these two connected?", answered with ALL
 *     shortest paths (capped, default 3) and each hop carrying its
 *     relationship VERB. This is the single strongest argument for the graph
 *     existing: no table view can answer it at all, and the cost is one
 *     bidirectional BFS over an in-memory `Int32Array`.
 *  3. **`topHubs` + `betweenness`** — degree finds the busy objects;
 *     betweenness finds the BROKERS, which degree misses entirely: the one
 *     object joining two clusters can have degree 2 and still be the only
 *     thing holding the brain together. Brandes is exact at n ≤ 2,000 and 64
 *     sampled pivots above it (see `betweenness`).
 *  4. **`orphans`** — visible degree 0. The brain's actual gaps, and the one
 *     ranked list that reads as a to-do list.
 *
 * **"Visible" is the whole vocabulary here.** The CSR is built from the
 * visible subgraph only (the server returns an edge only when BOTH endpoints
 * are visible and counts degree over visible edges), so every number below —
 * a hop count, a hub's degree, a broker's score, an orphan — means "as far as
 * THIS viewer can see". That is stated in the UI copy rather than papered
 * over: an object whose only link is to something private is legitimately an
 * orphan here, and the alternative (counting the hidden link) would tell the
 * viewer a private object exists and point at it.
 */

import { edgeKey, relOf } from "./csr";
import type { GraphStore } from "./store";
import type { Csr } from "./types";

// ---------------------------------------------------------------------------
// direction
// ---------------------------------------------------------------------------

/**
 * Which way a traversal may cross an edge. The CSR is UNDIRECTED by
 * construction (both endpoints own a half-edge slot), so "out"/"in" are only
 * meaningful against an orientation mask — see `buildOrientation`.
 */
export type TraversalDirection = "both" | "out" | "in";

/** Orientation bit: a directed edge runs OWNER → NEIGHBOUR at this slot. */
const SLOT_OUT = 1;
/** Orientation bit: a directed edge runs NEIGHBOUR → OWNER at this slot. */
const SLOT_IN = 2;

interface TraversalOptions {
  /** default "both" — every traversal the graph performs is undirected. */
  direction?: TraversalDirection;
  /**
   * Length-2m mask parallel to `csr.neighbors`, from `buildOrientation`.
   *
   * Omitted (the common case) the traversal is undirected and `direction` is
   * IGNORED rather than guessed: the CSR alone genuinely does not know which
   * way an edge points, and silently returning a directed-looking answer from
   * undirected data is the kind of wrong that shows up as the wrong
   * neighbourhood in the rail. Callers that mean in/out (the rail's toggles)
   * build the mask once per load and pass it.
   */
  orientation?: Uint8Array | null;
}

/**
 * The orientation mask for a CSR, derived from the store's DIRECTED graphology
 * graph: one byte per half-edge slot, `SLOT_OUT` set when a directed edge runs
 * from the slot's owner to its neighbour, `SLOT_IN` when one runs the other
 * way. Both bits set means the pair is linked in both directions.
 *
 * Derived per PAIR (not per parallel edge) and therefore independent of the
 * order `buildCsr` happened to fill its slots in — a mask that silently
 * disagreed with the adjacency it indexes would be undebuggable.
 */
export function buildOrientation(store: GraphStore, csr: Csr): Uint8Array {
  const mask = new Uint8Array(csr.neighbors.length);
  for (let i = 0; i < csr.n; i += 1) {
    const from = store.indexToId[i];
    if (from === undefined) continue;
    const end = csr.offsets[i + 1]!;
    for (let s = csr.offsets[i]!; s < end; s += 1) {
      const to = store.indexToId[csr.neighbors[s]!];
      if (to === undefined) continue;
      let bits = 0;
      if (store.graph.hasDirectedEdge(from, to)) bits |= SLOT_OUT;
      if (store.graph.hasDirectedEdge(to, from)) bits |= SLOT_IN;
      mask[s] = bits;
    }
  }
  return mask;
}

/** 0 means "no filter" — the undirected walk, and the hot path. */
function directionMask(options: TraversalOptions): number {
  if (options.orientation == null) return 0;
  if (options.direction === "out") return SLOT_OUT;
  if (options.direction === "in") return SLOT_IN;
  return 0;
}

function allowed(mask: number, orientation: Uint8Array | null | undefined, slot: number): boolean {
  if (mask === 0) return true;
  return ((orientation![slot] ?? 0) & mask) !== 0;
}

// ---------------------------------------------------------------------------
// BFS
// ---------------------------------------------------------------------------

interface BfsResult {
  readonly source: number;
  /** the depth requested (the walk stops there, it does not run to exhaustion). */
  readonly depth: number;
  /** hop count per node; **-1 for unreached** (including out-of-range calls). */
  readonly levels: Int32Array;
  /** BFS parent per node; -1 for the source and for unreached nodes. */
  readonly parents: Int32Array;
  /**
   * The half-edge slot, **owned by the parent**, that discovered each node —
   * so `relOf(csr, parentSlots[v])` names the hop without a second lookup.
   * -1 for the source and for unreached nodes.
   */
  readonly parentSlots: Int32Array;
  /** every reached node in BFS order, source first. `order.length` is the ball size. */
  readonly order: Int32Array;
}

/**
 * Undirected BFS ball of radius `depth` from `source`.
 *
 * Allocates four arrays and nothing else: no per-neighbour object, no
 * `Map<string, …>`, no closure per hop. The rail runs this on every navigation
 * (debounced 150–250ms) and the depth filter runs it on every slider move, so
 * "cheap" is a requirement, not a nicety.
 *
 * `depth` is clamped at 0; a depth of 0 is the source alone, which is what the
 * rail wants while it is still resolving the focus object.
 */
export function bfs(
  csr: Csr,
  source: number,
  depth = 1,
  options: TraversalOptions = {},
): BfsResult {
  const n = csr.n;
  const levels = new Int32Array(n).fill(-1);
  const parents = new Int32Array(n).fill(-1);
  const parentSlots = new Int32Array(n).fill(-1);
  const maxDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;

  if (source < 0 || source >= n) {
    return { source, depth: maxDepth, levels, parents, parentSlots, order: new Int32Array(0) };
  }

  const mask = directionMask(options);
  const orientation = options.orientation ?? null;

  // One flat queue, reused as the visit order — a BFS ball is at most n nodes,
  // so the array is sized once and never grows.
  const queue = new Int32Array(n);
  queue[0] = source;
  levels[source] = 0;
  let head = 0;
  let tail = 1;

  while (head < tail) {
    const u = queue[head]!;
    head += 1;
    const level = levels[u]!;
    if (level >= maxDepth) continue;
    const end = csr.offsets[u + 1]!;
    for (let s = csr.offsets[u]!; s < end; s += 1) {
      if (!allowed(mask, orientation, s)) continue;
      const v = csr.neighbors[s]!;
      if (levels[v]! >= 0) continue;
      levels[v] = level + 1;
      parents[v] = u;
      parentSlots[v] = s;
      queue[tail] = v;
      tail += 1;
    }
  }

  return {
    source,
    depth: maxDepth,
    levels,
    parents,
    parentSlots,
    order: queue.slice(0, tail),
  };
}

/**
 * The BFS TREE edges — one per reached node, the edge that discovered it.
 * A clean radial hierarchy; the rail's "show neighbour links" toggle OFF.
 */
export function treeEdges(result: BfsResult): Set<number> {
  const edges = new Set<number>();
  for (let k = 0; k < result.order.length; k += 1) {
    const v = result.order[k]!;
    const parent = result.parents[v]!;
    if (parent >= 0) edges.add(edgeKey(parent, v));
  }
  return edges;
}

/**
 * EVERY edge with both endpoints in the set — the true local density, and the
 * only way the rail can show that two of your neighbours know each other
 * (which the old MiniMap structurally could not). The rail toggle ON.
 */
export function internalEdges(csr: Csr, nodes: Iterable<number>): Set<number> {
  const members = nodes instanceof Set ? (nodes as Set<number>) : new Set(nodes);
  const edges = new Set<number>();
  for (const u of members) {
    if (u < 0 || u >= csr.n) continue;
    const end = csr.offsets[u + 1]!;
    for (let s = csr.offsets[u]!; s < end; s += 1) {
      const v = csr.neighbors[s]!;
      if (members.has(v)) edges.add(edgeKey(u, v));
    }
  }
  return edges;
}

/** The reached set as a `Set`, for the highlight constructors. */
export function ballOf(result: BfsResult): Set<number> {
  const set = new Set<number>();
  for (let k = 0; k < result.order.length; k += 1) set.add(result.order[k]!);
  return set;
}

// ---------------------------------------------------------------------------
// shortest paths
// ---------------------------------------------------------------------------

/** One hop of a path, labelled with the verb that makes the path readable. */
interface PathHop {
  readonly from: number;
  readonly to: number;
  /** the relationship verb from the CSR's interned rel table ("" if untyped). */
  readonly rel: string;
  /** the half-edge slot OWNED BY `from` that carries this hop. */
  readonly slot: number;
}

interface GraphPath {
  /** dense indices, `source` first and `target` last. */
  readonly nodes: readonly number[];
  /** `nodes.length - 1` hops, in order. */
  readonly hops: readonly PathHop[];
}

interface ShortestPathsOptions {
  /** how many equal-length paths to return. Default 3, minimum 1. */
  maxPaths?: number;
}

interface ShortestPathsResult {
  readonly source: number;
  readonly target: number;
  /** hop count. 0 when source === target; **-1 when unreachable**. */
  readonly length: number;
  readonly paths: readonly GraphPath[];
  /** true when more shortest paths exist than were returned. */
  readonly truncated: boolean;
}

/** The spec's cap: all shortest paths, up to three. */
const DEFAULT_MAX_PATHS = 3;

/**
 * All shortest paths (up to `maxPaths`) between two objects, each hop carrying
 * its relationship verb.
 *
 * **Bidirectional, by complete levels.** Two BFS fronts grow from the two ends,
 * always expanding the SMALLER frontier, each one level at a time. Expanding
 * whole levels is what makes the answer provably right: the moment the fronts
 * touch, some node has both distances, so the true distance L* is at most
 * `df + db`; and every shortest path then has a node at forward distance
 * `min(df, L*)` whose backward distance is already known. So the minimum of
 * `distF + distB` over the touched nodes IS L*, with no extra level needed.
 *
 * **Enumeration joins at ONE level** (`j = min(df, L)`) rather than at every
 * meeting node. Every shortest path crosses forward-distance `j` exactly once,
 * so each path is generated exactly once and there is no dedup pass — which
 * matters because dedup on a hub pair is where a naive implementation spends
 * all its time.
 *
 * **Undirected on purpose.** "How are these two connected?" is a question about
 * connection, not about arrow direction; the rail's in/out toggles are a
 * different feature (see `bfs`). Parallel edges between the same pair
 * contribute ONE hop, labelled with the first verb in adjacency order — the
 * peek shows the full relationship list for a pair, and returning the same
 * node sequence three times because three verbs join two objects would burn
 * the cap on a single path.
 */
export function shortestPaths(
  csr: Csr,
  source: number,
  target: number,
  options: ShortestPathsOptions = {},
): ShortestPathsResult {
  const maxPaths = Math.max(
    1,
    Number.isFinite(options.maxPaths ?? DEFAULT_MAX_PATHS)
      ? Math.floor(options.maxPaths ?? DEFAULT_MAX_PATHS)
      : DEFAULT_MAX_PATHS,
  );
  const n = csr.n;
  const miss: ShortestPathsResult = {
    source,
    target,
    length: -1,
    paths: [],
    truncated: false,
  };
  if (source < 0 || source >= n || target < 0 || target >= n) return miss;
  if (source === target) {
    return {
      source,
      target,
      length: 0,
      paths: [{ nodes: [source], hops: [] }],
      truncated: false,
    };
  }

  const distF = new Int32Array(n).fill(-1);
  const distB = new Int32Array(n).fill(-1);
  distF[source] = 0;
  distB[target] = 0;

  let frontF: number[] = [source];
  let frontB: number[] = [target];
  let df = 0;
  let db = 0;
  let length = -1;

  while (length < 0 && frontF.length > 0 && frontB.length > 0) {
    if (frontF.length <= frontB.length) {
      const step = expandLevel(csr, frontF, distF, distB, df + 1);
      frontF = step.next;
      df += 1;
      length = step.best;
    } else {
      const step = expandLevel(csr, frontB, distB, distF, db + 1);
      frontB = step.next;
      db += 1;
      length = step.best;
    }
  }

  if (length < 0) return miss;

  // The single join level. `j <= df` (so distF is complete there) and
  // `length - j <= db` (so distB is too) — see the header's proof.
  const j = Math.min(df, length);
  const paths: GraphPath[] = [];
  let truncated = false;

  for (let v = 0; v < n && !truncated && paths.length < maxPaths; v += 1) {
    if (distF[v] !== j || distB[v] !== length - j) continue;

    // Prefixes run source ← v (walking DOWN distF), suffixes run v → target
    // (walking down distB). Both are enumerated with the same cap, so a hub
    // pair cannot make this loop unbounded.
    const prefix = walkDown(csr, v, distF, maxPaths);
    const suffix = walkDown(csr, v, distB, maxPaths);
    truncated = truncated || prefix.truncated || suffix.truncated;

    // Every prefix pairs with every suffix. `taken < combos` at the end is the
    // only honest truncation signal: the cap can be reached in the middle of
    // either loop, and a path left on the floor MUST be reported (the panel
    // says "3 of the shortest paths" or it says "the shortest paths", and the
    // difference is a claim about the user's brain).
    const combos = prefix.nodes.length * suffix.nodes.length;
    let taken = 0;

    for (let p = 0; p < prefix.nodes.length && paths.length < maxPaths; p += 1) {
      for (let q = 0; q < suffix.nodes.length && paths.length < maxPaths; q += 1) {
        const head = prefix.nodes[p]!;
        const headRels = prefix.rels[p]!;
        const tail = suffix.nodes[q]!;
        const tailRels = suffix.rels[q]!;

        // `head` is [v, …, source]; reverse it so the path reads forwards.
        const nodes: number[] = [];
        const rels: number[] = [];
        for (let i = head.length - 1; i >= 0; i -= 1) nodes.push(head[i]!);
        for (let i = headRels.length - 1; i >= 0; i -= 1) rels.push(headRels[i]!);
        for (let i = 1; i < tail.length; i += 1) nodes.push(tail[i]!);
        for (let i = 0; i < tailRels.length; i += 1) rels.push(tailRels[i]!);

        paths.push(materialize(csr, nodes, rels));
        taken += 1;
      }
    }

    if (taken < combos) truncated = true;
  }

  // More join-level nodes left unvisited means more paths exist than we
  // returned. Cheaper to note it here than to count them all.
  if (!truncated && paths.length >= maxPaths) {
    truncated = moreJoinNodes(distF, distB, j, length, paths);
  }

  return { source, target, length, paths, truncated };
}

/** One complete BFS level. `best` is the shortest distance if the fronts met. */
function expandLevel(
  csr: Csr,
  frontier: readonly number[],
  dist: Int32Array,
  other: Int32Array,
  level: number,
): { next: number[]; best: number } {
  const next: number[] = [];
  let best = -1;
  for (let k = 0; k < frontier.length; k += 1) {
    const u = frontier[k]!;
    const end = csr.offsets[u + 1]!;
    for (let s = csr.offsets[u]!; s < end; s += 1) {
      const v = csr.neighbors[s]!;
      if (dist[v]! >= 0) continue;
      dist[v] = level;
      next.push(v);
      const o = other[v]!;
      // Each node gets each distance at most once, so checking here covers
      // every (distF, distB) pair exactly once — no O(n) scan for the minimum.
      if (o >= 0 && (best < 0 || level + o < best)) best = level + o;
    }
  }
  return { next, best };
}

/**
 * Every path from `start` down the `dist` gradient to the anchor (`dist === 0`),
 * up to `limit` of them. Explicit stack, not recursion: a chain graph makes the
 * path length O(n), and a 5,000-deep call stack is a crash, not a slow render.
 *
 * Parallel edges to the same neighbour are collapsed (the first slot wins) so
 * two verbs between the same pair do not produce two identical node sequences.
 */
function walkDown(
  csr: Csr,
  start: number,
  dist: Int32Array,
  limit: number,
): { nodes: number[][]; rels: number[][]; truncated: boolean } {
  const nodes: number[][] = [];
  const rels: number[][] = [];
  if (start < 0 || start >= csr.n || dist[start]! < 0) {
    return { nodes, rels, truncated: false };
  }

  const path: number[] = [start];
  const relPath: number[] = [];
  const cursors: number[] = [csr.offsets[start]!];
  let truncated = false;

  while (cursors.length > 0) {
    const depth = cursors.length - 1;
    const cur = path[depth]!;

    if (dist[cur] === 0) {
      if (nodes.length >= limit) {
        truncated = true;
        break;
      }
      nodes.push(path.slice());
      rels.push(relPath.slice());
      cursors.pop();
      path.pop();
      if (relPath.length > 0) relPath.pop();
      continue;
    }

    const start1 = csr.offsets[cur]!;
    const end = csr.offsets[cur + 1]!;
    const want = dist[cur]! - 1;
    let s = cursors[depth]!;
    let stepped = false;

    while (s < end) {
      const v = csr.neighbors[s]!;
      if (dist[v] === want && !seenEarlier(csr, start1, s, v)) {
        cursors[depth] = s + 1;
        path.push(v);
        relPath.push(csr.relIndex[s]!);
        cursors.push(csr.offsets[v]!);
        stepped = true;
        break;
      }
      s += 1;
    }

    if (!stepped) {
      cursors.pop();
      path.pop();
      if (relPath.length > 0) relPath.pop();
    }
  }

  return { nodes, rels, truncated };
}

/** True when `v` already appeared in this node's slots before `slot`. */
function seenEarlier(csr: Csr, from: number, slot: number, v: number): boolean {
  for (let s = from; s < slot; s += 1) {
    if (csr.neighbors[s] === v) return true;
  }
  return false;
}

/** A node sequence plus one rel index per hop, turned into a labelled path. */
function materialize(csr: Csr, nodes: number[], rels: number[]): GraphPath {
  const hops: PathHop[] = [];
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const from = nodes[i]!;
    const to = nodes[i + 1]!;
    // The traversal recorded a slot on whichever side it walked from; re-find
    // the slot owned by `from` so a caller can trust `slot`'s owner.
    const slot = slotBetween(csr, from, to, rels[i] ?? -1);
    hops.push({ from, to, rel: (slot >= 0 ? relOf(csr, slot) : null) ?? "", slot });
  }
  return { nodes, hops };
}

/** The slot at `from` reaching `to` with this rel; any slot to `to` otherwise. */
function slotBetween(csr: Csr, from: number, to: number, relIndex: number): number {
  const end = csr.offsets[from + 1]!;
  let fallback = -1;
  for (let s = csr.offsets[from]!; s < end; s += 1) {
    if (csr.neighbors[s] !== to) continue;
    if (csr.relIndex[s] === relIndex) return s;
    if (fallback < 0) fallback = s;
  }
  return fallback;
}

/** Is there a join-level node we never enumerated? Then paths were left behind. */
function moreJoinNodes(
  distF: Int32Array,
  distB: Int32Array,
  j: number,
  length: number,
  paths: readonly GraphPath[],
): boolean {
  const used = new Set<number>();
  for (const path of paths) {
    const at = path.nodes[j];
    if (at !== undefined) used.add(at);
  }
  for (let v = 0; v < distF.length; v += 1) {
    if (distF[v] === j && distB[v] === length - j && !used.has(v)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ranking: hubs, brokers, orphans
// ---------------------------------------------------------------------------

/** One row of a ranked side list. */
export interface RankedNode {
  readonly index: number;
  readonly score: number;
}

/** How many rows the hub/broker lists show by default. */
const DEFAULT_RANK_K = 10;

/**
 * Top `k` by DEGREE over the visible subgraph. Degree-0 nodes are excluded —
 * padding a hub list with isolated objects reads as a bug, and they have their
 * own list (`orphans`).
 */
export function topHubs(csr: Csr, k = DEFAULT_RANK_K): RankedNode[] {
  const degrees = new Float64Array(csr.n);
  for (let i = 0; i < csr.n; i += 1) degrees[i] = csr.offsets[i + 1]! - csr.offsets[i]!;
  return topByScore(degrees, k);
}

/**
 * Top `k` by score, descending, ties broken by ascending index so the list is
 * stable across renders. Non-positive scores are dropped.
 */
export function topByScore(scores: ArrayLike<number>, k = DEFAULT_RANK_K): RankedNode[] {
  const limit = Math.max(0, Math.floor(k));
  if (limit === 0) return [];
  const rows: RankedNode[] = [];
  for (let i = 0; i < scores.length; i += 1) {
    const score = scores[i]!;
    if (score > 0) rows.push({ index: i, score });
  }
  rows.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
  return rows.slice(0, limit);
}

/**
 * Visible degree 0 — the brain's actual gaps, in dense-index order.
 *
 * "Orphan as far as you can see": an object whose only relationship points at
 * something this viewer cannot see is an orphan HERE, and the UI says so. The
 * alternative leaks the existence of the hidden object.
 */
export function orphans(csr: Csr): number[] {
  const out: number[] = [];
  for (let i = 0; i < csr.n; i += 1) {
    if (csr.offsets[i + 1]! === csr.offsets[i]!) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// betweenness (Brandes)
// ---------------------------------------------------------------------------

/** At or below this node count every node is a source: the score is exact. */
const BETWEENNESS_EXACT_MAX = 2000;
/** Above it, this many deterministic pivots. */
export const BETWEENNESS_PIVOTS = 64;

interface BetweennessOptions {
  /** exact at or below this many nodes. Default 2,000. */
  exactMax?: number;
  /** pivots used above `exactMax`. Default 64. */
  pivots?: number;
  /** pivot-sampling seed. Fixed by default: the same graph ranks the same way. */
  seed?: number;
}

interface BetweennessResult {
  /** score per dense index; 0 for every node no shortest path passes through. */
  readonly scores: Float64Array;
  /** true when every eligible node was used as a source. */
  readonly exact: boolean;
  /** how many sources were actually run. */
  readonly pivots: number;
}

/**
 * Brandes betweenness — the BROKER finder.
 *
 * Degree answers "who is busy"; betweenness answers "who is load-bearing", and
 * those are different objects. The one note joining the sales cluster to the
 * engineering cluster has degree 2 and the highest betweenness in the brain;
 * lose it and the graph falls in half. A ranked list of those is worth its
 * cost, which is why this function exists and why it runs in a worker.
 *
 * **Exact at n ≤ 2,000, 64 sampled pivots above.** Brandes is O(n·m); at the
 * committed 5,000-node / 15,000-edge budget the exact run is ~75M edge visits
 * and would hold the worker for seconds on every filter change, while the
 * sampled estimator (scale each pivot's contribution by eligible/pivots) gets
 * the same top-10 for a ranked list nobody reads past row ten. Pivots are
 * drawn deterministically from a seeded PRNG over the NON-ISOLATED nodes, so
 * the same graph always ranks the same way (a list that reshuffles on every
 * recompute reads as noise) and no pivot is wasted on a node that can start no
 * path.
 *
 * Undirected: every pair is discovered from both ends, so the accumulated
 * scores are halved.
 */
export function betweenness(csr: Csr, options: BetweennessOptions = {}): BetweennessResult {
  const n = csr.n;
  const scores = new Float64Array(n);
  if (n === 0) return { scores, exact: true, pivots: 0 };

  const exactMax = options.exactMax ?? BETWEENNESS_EXACT_MAX;
  const wanted = Math.max(1, Math.floor(options.pivots ?? BETWEENNESS_PIVOTS));

  const eligible: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (csr.offsets[i + 1]! > csr.offsets[i]!) eligible.push(i);
  }
  if (eligible.length === 0) return { scores, exact: true, pivots: 0 };

  const exact = n <= exactMax || wanted >= eligible.length;
  const sources = exact ? eligible : samplePivots(eligible, wanted, options.seed ?? 0x5eed);

  const dist = new Int32Array(n);
  const sigma = new Float64Array(n);
  const delta = new Float64Array(n);
  const stack = new Int32Array(n);
  const queue = new Int32Array(n);
  // Predecessors as an intrusive linked list over half-edge slots: at most one
  // entry per half-edge per run, so the arrays are sized once. A `number[][]`
  // would allocate n arrays per source — n² allocations for an exact run.
  const predHead = new Int32Array(n);
  const predNext = new Int32Array(csr.neighbors.length);
  const predNode = new Int32Array(csr.neighbors.length);
  // Stamp array collapsing PARALLEL edges: two verbs between the same pair are
  // one path, not two, and double-counting sigma would inflate both endpoints.
  const mark = new Int32Array(n).fill(-1);
  let stamp = 0;

  for (const s of sources) {
    dist.fill(-1);
    sigma.fill(0);
    delta.fill(0);
    predHead.fill(-1);
    let predCount = 0;

    dist[s] = 0;
    sigma[s] = 1;
    queue[0] = s;
    let head = 0;
    let tail = 1;
    let top = 0;

    while (head < tail) {
      const v = queue[head]!;
      head += 1;
      stack[top] = v;
      top += 1;
      stamp += 1;
      const end = csr.offsets[v + 1]!;
      const dv = dist[v]!;
      for (let slot = csr.offsets[v]!; slot < end; slot += 1) {
        const w = csr.neighbors[slot]!;
        if (mark[w] === stamp) continue;
        mark[w] = stamp;
        if (dist[w]! < 0) {
          dist[w] = dv + 1;
          queue[tail] = w;
          tail += 1;
        }
        if (dist[w] !== dv + 1) continue;
        sigma[w] = sigma[w]! + sigma[v]!;
        predNode[predCount] = v;
        predNext[predCount] = predHead[w]!;
        predHead[w] = predCount;
        predCount += 1;
      }
    }

    while (top > 0) {
      top -= 1;
      const w = stack[top]!;
      const coeff = (1 + delta[w]!) / sigma[w]!;
      for (let e = predHead[w]!; e >= 0; e = predNext[e]!) {
        const v = predNode[e]!;
        delta[v] = delta[v]! + sigma[v]! * coeff;
      }
      if (w !== s) scores[w] = scores[w]! + delta[w]!;
    }
  }

  const scale = (exact ? 1 : eligible.length / sources.length) / 2;
  if (scale !== 1) {
    for (let i = 0; i < n; i += 1) scores[i] = scores[i]! * scale;
  }

  return { scores, exact, pivots: sources.length };
}

/** Deterministic pivot draw — a ranked list that reshuffles reads as noise. */
function samplePivots(pool: readonly number[], count: number, seed: number): number[] {
  const random = mulberry32(seed);
  const bag = pool.slice();
  const take = Math.min(count, bag.length);
  // Partial Fisher–Yates: only the first `take` slots are settled.
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(random() * (bag.length - i));
    const swap = bag[i]!;
    bag[i] = bag[j]!;
    bag[j] = swap;
  }
  const out = bag.slice(0, take);
  out.sort((a, b) => a - b);
  return out;
}

/** The same small PRNG the fixtures use: seeded, portable, no dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// the one call the panel makes
// ---------------------------------------------------------------------------

export interface AnalysisOptions extends BetweennessOptions {
  /** rows in the hub list. Default 10. */
  hubs?: number;
  /** rows in the broker list. Default 10. */
  brokers?: number;
  /** skip Brandes entirely (the rail's local graph does not need it). */
  skipBetweenness?: boolean;
}

export interface AnalysisSummary {
  readonly n: number;
  readonly m: number;
  /** top by degree. */
  readonly hubs: readonly RankedNode[];
  /** top by betweenness — the brokers. Empty when betweenness was skipped. */
  readonly brokers: readonly RankedNode[];
  /** visible degree 0, in index order. */
  readonly orphans: readonly number[];
  readonly betweennessExact: boolean;
  readonly betweennessPivots: number;
  /** wall-clock milliseconds, surfaced in the panel rather than guessed at. */
  readonly ms: number;
}

/**
 * Everything the "what matters here?" panel shows, in one pass. Called on the
 * main thread for a small graph and through `analysis.worker.ts` for a big one
 * — same function either way, so the worker cannot drift from the fallback.
 */
export function analyze(csr: Csr, options: AnalysisOptions = {}): AnalysisSummary {
  const started = now();
  const hubs = topHubs(csr, options.hubs ?? DEFAULT_RANK_K);
  const gaps = orphans(csr);

  let brokers: RankedNode[] = [];
  let exact = true;
  let pivots = 0;
  if (options.skipBetweenness !== true) {
    const result = betweenness(csr, options);
    brokers = topByScore(result.scores, options.brokers ?? DEFAULT_RANK_K);
    exact = result.exact;
    pivots = result.pivots;
  }

  return {
    n: csr.n,
    m: csr.m,
    hubs,
    brokers,
    orphans: gaps,
    betweennessExact: exact,
    betweennessPivots: pivots,
    ms: now() - started,
  };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
