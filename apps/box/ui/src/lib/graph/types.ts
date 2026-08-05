/**
 * The shared contracts for the phase-6 graph engine — the store, the CSR
 * adjacency, the worker's position buffers, the highlight model, and the
 * camera. Everything else in `lib/graph/*` (worker, renderer, layout, hover
 * isolation, shortest path, the rail's local graph) compiles against this file
 * and nothing else, which is why it lands first.
 *
 * Two invariants run through the whole file and are restated where they bite:
 *
 *  1. **Dense indices are the currency.** A node's `id` is a uuid; every hot
 *     path (position buffer, CSR neighbour walk, highlight set, spatial hash)
 *     addresses nodes by their DENSE INDEX into `GraphStore.indexToId`, so a
 *     lookup is an array offset and never a string hash. Indices are assigned
 *     in arrival order and NEVER move for a node already in the store — that is
 *     what lets a later page of a paged load merge in without invalidating the
 *     positions the simulation has already settled.
 *  2. **The graph shows the visible subgraph, and only that.** `degree` is the
 *     server's visible-only degree (see `Reader.graphFull`): counting a hidden
 *     link would tell the viewer a private object exists and point at it. The
 *     client's matching half of that rule is that an edge naming a node it was
 *     never given is DROPPED, never rendered against a synthesized placeholder
 *     (see `GraphStore.ingest`).
 */

/** A node exactly as `GET /api/v1/graph` returns it (`Reader.GraphFullNode`). */
export interface GraphNode {
  id: string;
  /** null for an untitled object — render the id's short form, never "". */
  title: string | null;
  /** null for an untyped object; the type name drives the per-node tint. */
  type: string | null;
  /**
   * Degree over the VISIBLE subgraph only, computed server-side. It is the
   * authority for node radius, hub ranking and the orphans filter; the CSR's
   * own `degree(csr, i)` agrees with it only once every page has landed, and
   * mid-load it is legitimately smaller.
   */
  degree: number;
}

/** An edge exactly as `GET /api/v1/graph` returns it (`Reader.GraphFullEdge`). */
export interface GraphEdge {
  from: string;
  to: string;
  /** the relationship verb — shortest-path labels every hop with it. */
  rel: string;
}

/** One page of the cursor-paged whole-brain walk, as handed to `ingest`. */
export interface GraphPage {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/**
 * Compressed sparse row adjacency over the dense indices, built once per load.
 *
 * Undirected: every edge contributes TWO half-edge slots (one on each
 * endpoint), because every question the graph answers — hover isolation,
 * shortest path, BFS for the rail's local graph, connected components — is an
 * undirected traversal. Direction survives in the store's graphology graph for
 * anything that needs it (arrowheads, in/out toggles).
 *
 * Parallel edges are kept: two objects linked by two different verbs are two
 * slots, so the rel table round-trips and degree matches graphology's.
 *
 * A `Csr` is immutable and is tied to the `GraphStore.revision` it was built
 * from — after an `ingest` the indices it holds are still valid (they never
 * move) but it is missing the new rows, so rebuild it.
 */
export interface Csr {
  /** node count; every index in `neighbors` is in `[0, n)`. */
  readonly n: number;
  /** undirected edge count; `neighbors.length === 2 * m`. */
  readonly m: number;
  /** length n+1 prefix sums: node i owns slots `[offsets[i], offsets[i+1])`. */
  readonly offsets: Int32Array;
  /** length 2m; the neighbour's dense index at each slot. */
  readonly neighbors: Int32Array;
  /** length 2m, parallel to `neighbors`: an index into `rels`. */
  readonly relIndex: Int32Array;
  /** the interned relationship-verb table; `relIndex` indexes into it. */
  readonly rels: readonly string[];
}

/**
 * One tick's worth of positions, produced by the layout worker and transferred
 * (zero-copy) to the renderer.
 *
 * `xy` is interleaved — node i is at `xy[2 * i]`, `xy[2 * i + 1]` — because one
 * buffer transfers, interpolates and uploads better than two, and the renderer
 * lerps between the last two buffers (physics at 30Hz, render at 60Hz).
 */
export interface PositionBuffer {
  /** node count; `xy.length === 2 * n`. */
  readonly n: number;
  /** interleaved x,y in world units, indexed by dense node index. */
  readonly xy: Float32Array;
  /** monotonic tick counter — the renderer interpolates between two ticks. */
  readonly tick: number;
  /** the simulation's alpha at this tick. */
  readonly alpha: number;
  /**
   * True once alpha fell below alphaMin and the worker stopped ticking. A
   * settled graph costs ~0% CPU, so the renderer stops requesting frames too
   * (until a camera move, a hover, or a reheat).
   */
  readonly settled: boolean;
}

/** What produced a highlight — the renderer styles each differently. */
export type HighlightKind = "hover" | "path" | "search" | "selection" | "changed";

/**
 * A highlighted subset of the graph: everything in it renders at full strength,
 * everything else tweens down to `dimAlpha`.
 *
 * Members are DENSE INDICES, so a set is only meaningful against the store
 * revision that produced it. Edges are keyed with `edgeKey(a, b)` from `csr.ts`
 * (an undirected, order-independent packing of the two endpoint indices).
 */
export interface HighlightSet {
  readonly kind: HighlightKind;
  readonly nodes: ReadonlySet<number>;
  readonly edges: ReadonlySet<number>;
  /** alpha for NON-members. 0.12 for hover isolation, per the design. */
  readonly dimAlpha: number;
}

/**
 * The viewport, in world units. `x`/`y` is the world point under the CENTER of
 * the container (not a corner — the container resizes, and a centered camera
 * keeps the same thing on screen when it does); `scale` is device-independent
 * pixels per world unit.
 *
 * Persisted inside a saved graph view (`saved_views`, `kind: "graph"`), so a
 * value read back is treated as hostile-shaped and normalized, never trusted.
 */
export interface CameraState {
  x: number;
  y: number;
  scale: number;
}
