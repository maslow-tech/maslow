/**
 * The physics PROTOCOL and TUNING — the pieces the main thread and the worker
 * must agree on, and nothing else.
 *
 * This file exists purely so that agreement costs no bundle. `physics.ts` (the
 * main-thread handle) needs the force defaults, the tick rate and the message
 * types; `physics.worker.ts` needs all of that PLUS d3-force. Importing the
 * constants from the worker module — even though its self-wiring is guarded by
 * a real-`WorkerGlobalScope` check and so is inert on the main thread — makes
 * the bundler pull d3-force into the main chunk as well as the worker chunk,
 * because a value import is a hard module dependency.
 *
 * So the d3-free half lives here, both sides import it, and the worker
 * re-exports it for callers (and tests) that reach for it by the worker's name.
 * Keep this file free of d3 and of any DOM/worker globals.
 */

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

/** Physics rate. The renderer runs at 60Hz and interpolates between ticks. */
export const PHYSICS_TICK_HZ = 30;

/**
 * Every force knob, in one bag. The six the user can actually move (link
 * distance, link strength, repel, center, plus node size and the label
 * threshold which live in the renderer) are persisted inside a saved graph
 * view, which means a value read back is hostile-shaped until
 * `normalizeForces` has been over it.
 */
export interface ForceParams {
  /** target link length in world units. UI range 10–250. */
  linkDistance: number;
  /** multiplier on d3's degree-normalized link strength. UI range 0–2. */
  linkStrength: number;
  /** `forceManyBody` strength; NEGATIVE is repulsion. UI range 0 to −200. */
  chargeStrength: number;
  /** `forceX`/`forceY` strength pulling toward the origin. UI range 0–0.15. */
  centerStrength: number;
  /** Barnes–Hut approximation threshold; higher is faster and coarser. */
  theta: number;
  /** repulsion is clamped below this distance (the singularity guard). */
  distanceMin: number;
  /** repulsion is IGNORED beyond this distance — the 2–5× knob. */
  distanceMax: number;
  /** d3's friction: 1 − decay of velocity per tick. */
  velocityDecay: number;
  /** ~0.0228 settles in ~300 ticks (10s at 30Hz). */
  alphaDecay: number;
  /** below this the simulation stops ticking entirely. */
  alphaMin: number;
  /** what a data change reheats TO. Never 1 — see the header. */
  reheatAlpha: number;
  /** alpha floor held while a node is being dragged. */
  dragAlphaTarget: number;
  /**
   * `forceCollide` strength — how hard two circles refuse to intersect. 1 is
   * d3's full resolution, 0 turns collision off entirely (which is what the
   * graph did before it had any, and what the collision test flips to prove
   * its own assertion is not vacuous).
   */
  collideStrength: number;
}

/** The committed defaults for the global (whole-brain) graph. */
export const DEFAULT_FORCES: ForceParams = {
  linkDistance: 40,
  linkStrength: 1,
  chargeStrength: -120,
  centerStrength: 0.06,
  theta: 1.0,
  distanceMin: 1,
  distanceMax: 400,
  velocityDecay: 0.5,
  alphaDecay: 0.0228,
  alphaMin: 0.001,
  reheatAlpha: 0.5,
  dragAlphaTarget: 0.3,
  collideStrength: 1,
};

/**
 * The object page's rail runs the same engine in ~300px, so its forces are
 * scaled to the rail rather than inherited from the global view (a −120 charge
 * in a 300px box throws every neighbour off the edge).
 */
export const RAIL_FORCES: ForceParams = {
  ...DEFAULT_FORCES,
  linkDistance: 20,
  chargeStrength: -60,
  centerStrength: 0.08,
};

/**
 * Note the argument order — `(value, lo, hi)`. `renderer.ts` exports a `clamp`
 * with the bounds FIRST; they are deliberately not shared, so check which one
 * you are importing.
 */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Fold a partial (and possibly hostile — it may have come out of a persisted
 * saved view) force bag onto a base. Anything non-finite or out of range is
 * clamped or dropped; the result is always a usable simulation, because a NaN
 * that reaches d3 turns every position into NaN and the graph disappears with
 * no error anywhere.
 */
export function normalizeForces(
  partial: Partial<ForceParams> | undefined,
  base: ForceParams = DEFAULT_FORCES,
): ForceParams {
  const p = partial ?? {};
  const num = (v: number | undefined, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  const distanceMin = clamp(num(p.distanceMin, base.distanceMin), 0.1, 100);
  return {
    linkDistance: clamp(num(p.linkDistance, base.linkDistance), 1, 1000),
    linkStrength: clamp(num(p.linkStrength, base.linkStrength), 0, 2),
    // strength is repulsive, so it is clamped to <= 0 — a positive charge
    // collapses the whole graph into a point and looks like a crash.
    chargeStrength: clamp(num(p.chargeStrength, base.chargeStrength), -2000, 0),
    centerStrength: clamp(num(p.centerStrength, base.centerStrength), 0, 1),
    theta: clamp(num(p.theta, base.theta), 0, 2),
    distanceMin,
    distanceMax: Math.max(distanceMin, clamp(num(p.distanceMax, base.distanceMax), 1, 1e6)),
    velocityDecay: clamp(num(p.velocityDecay, base.velocityDecay), 0.01, 0.95),
    alphaDecay: clamp(num(p.alphaDecay, base.alphaDecay), 0.0001, 0.5),
    alphaMin: clamp(num(p.alphaMin, base.alphaMin), 0.0001, 0.5),
    reheatAlpha: clamp(num(p.reheatAlpha, base.reheatAlpha), 0, 1),
    dragAlphaTarget: clamp(num(p.dragAlphaTarget, base.dragAlphaTarget), 0, 1),
    collideStrength: clamp(num(p.collideStrength, base.collideStrength), 0, 1),
  };
}

// ---------------------------------------------------------------------------
// the wire protocol
// ---------------------------------------------------------------------------

/**
 * Main thread → worker.
 *
 * `links` and `seed` are `Int32Array`/`Float32Array` and are TRANSFERRED, not
 * copied: a 15,000-edge brain is a 120KB structured clone per data update
 * otherwise, and the whole-brain load sends one of these per page.
 */
export type PhysicsCommand =
  | {
      readonly type: "data";
      /** node count; dense indices are `[0, nodeCount)` and never move. */
      readonly nodeCount: number;
      /** interleaved undirected pairs: `[a0, b0, a1, b1, …]`, length 2m. */
      readonly links: Int32Array;
      /**
       * optional starting positions for NEW indices, interleaved x,y. Non-finite
       * entries (and anything past the end) fall back to d3's phyllotaxis. The
       * rail uses this to spawn a new node at its BFS parent's position instead
       * of flying it in from the spiral.
       */
      readonly seed?: Float32Array;
    }
  | { readonly type: "forces"; readonly forces: Partial<ForceParams> }
  | {
      readonly type: "pin";
      readonly index: number;
      readonly x: number;
      readonly y: number;
      /** a pointer drag: holds `alphaTarget` up until the matching unpin. */
      readonly drag?: boolean;
    }
  | { readonly type: "unpin"; readonly index: number }
  | { readonly type: "start" }
  | { readonly type: "stop" }
  | { readonly type: "reheat"; readonly alpha?: number }
  /** a position buffer the main thread is done with — see the pool in physics.worker.ts. */
  | { readonly type: "release"; readonly xy: Float32Array };

/**
 * Worker → main thread. One message type: a tick. The last tick before the
 * simulation goes quiet carries `settled: true`, and nothing follows it until
 * a reheat.
 */
export type PhysicsEvent = {
  readonly type: "tick";
  readonly n: number;
  readonly xy: Float32Array;
  readonly tick: number;
  readonly alpha: number;
  readonly settled: boolean;
};

/** How the engine talks back. `transfer` is the zero-copy list. */
export type PhysicsPost = (event: PhysicsEvent, transfer: Transferable[]) => void;
