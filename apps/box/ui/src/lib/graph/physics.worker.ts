/**
 * The layout worker: `d3-force` on a background thread, positions handed back
 * as a transferable `Float32Array`.
 *
 * This file exists to delete the single worst line in the old graph —
 * `GraphView.tsx`'s all-pairs O(n²) repulsion loop, run in JS on the main
 * thread once per frame. That loop is the entire reason `DEFAULT_SAMPLE = 80`
 * and `MAX_SAMPLE = 320` exist: the cap was a symptom of the algorithm, not a
 * product decision. `forceManyBody` approximates the same repulsion with a
 * Barnes–Hut walk over a `d3-quadtree` (O(n log n)), off the main thread, which
 * is what lets the view show the whole visible brain instead of its 320 busiest
 * objects.
 *
 * Four decisions are committed here rather than left as knobs, each because the
 * alternative is a visible regression:
 *
 *  1. **`distanceMax: 400`.** The highest-leverage knob in the whole engine —
 *     it stops the Barnes–Hut walk descending for far-away mass, which is a 2–5×
 *     speedup at 10k+ nodes and changes the settled layout almost not at all
 *     (repulsion at 400px is already dominated by the link and centering
 *     forces). `theta: 1.0` and `distanceMin: 1` come with it: theta 1.0 is a
 *     coarser (faster) approximation than d3's 0.9 default, and distanceMin
 *     clamps the singularity when two nodes land on top of each other.
 *  2. **The simulation STOPS below `alphaMin`.** d3's own timer keeps firing
 *     rAF callbacks forever if you let it; ours cancels its interval, so a
 *     settled graph costs ~0% CPU and a laptop fan does not spin because a tab
 *     is open on the graph page. Nothing is emitted after the final tick, which
 *     carries `settled: true` so the renderer can stop requesting frames too.
 *  3. **Reheat is `alpha(0.5)`, never `alpha(1)`.** A full reheat visibly
 *     explodes an almost-correct layout: every node flies out and re-converges,
 *     which reads as "the graph reset" when all that happened was page 4 of a
 *     paged load landing. 0.5 nudges. Dragging uses `alphaTarget(0.3)` — the
 *     sim stays warm while the pointer is down and cools when it lifts.
 *  4. **Ticks are driven by US at 30Hz, not by d3's internal timer.** d3's
 *     timer is rAF-based and there is no rAF in a worker; more importantly we
 *     need the tick rate decoupled from the render rate (physics 30Hz, render
 *     60Hz with the renderer lerping between the last two buffers). The
 *     simulation is constructed and immediately `.stop()`ed for exactly this
 *     reason — everything after that is `sim.tick()` under our own scheduler.
 *
 * The engine is a plain exported class taking its `postMessage` and its
 * scheduler as constructor arguments, and the worker wiring at the bottom of
 * the file only runs inside a real `WorkerGlobalScope`. That is what makes the
 * message protocol and the settle behaviour testable headlessly, in jsdom, with
 * no worker at all.
 */

import { nodeRadius } from "./labels";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type ForceCollide,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

// ---------------------------------------------------------------------------
// protocol + tuning
// ---------------------------------------------------------------------------

// The d3-free half of this module lives in ./physics-protocol so the main
// thread can import the constants and message types WITHOUT dragging d3-force
// into the main bundle (a value import is a hard module dependency, guarded
// self-wiring or not). Re-exported here so `./physics.worker` remains a valid
// name for all of it.
export {
  DEFAULT_FORCES,
  PHYSICS_TICK_HZ,
  RAIL_FORCES,
  normalizeForces,
  type ForceParams,
  type PhysicsCommand,
  type PhysicsEvent,
  type PhysicsPost,
} from "./physics-protocol";

import {
  DEFAULT_FORCES,
  PHYSICS_TICK_HZ,
  clamp,
  normalizeForces,
  type ForceParams,
  type PhysicsCommand,
  type PhysicsPost,
} from "./physics-protocol";

// ---------------------------------------------------------------------------
// the tick scheduler
// ---------------------------------------------------------------------------

/**
 * The 30Hz clock, injectable so tests can step the simulation deterministically
 * instead of waiting on wall time (a settle test on a real timer is 10 seconds
 * of nothing, and flaky besides).
 */
export interface TickScheduler {
  start(fn: () => void, intervalMs: number): void;
  stop(): void;
  readonly running: boolean;
}

/** The real clock: `setInterval`. There is no rAF in a worker. */
export function createIntervalScheduler(): TickScheduler {
  let handle: ReturnType<typeof setInterval> | null = null;
  return {
    start(fn, intervalMs) {
      if (handle !== null) return;
      handle = setInterval(fn, intervalMs);
    },
    stop() {
      if (handle === null) return;
      clearInterval(handle);
      handle = null;
    },
    get running() {
      return handle !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------

interface SimNode extends SimulationNodeDatum {
  index: number;
}

type SimLink = SimulationLinkDatum<SimNode>;

/**
 * Clear space left between two node EDGES, in world units. Small on purpose:
 * the ask is "close but not touching", and a big gap would push a dense
 * community apart into something that reads as unrelated.
 */
export const COLLIDE_GAP_PX = 2;

/**
 * Above this many nodes, collision is switched OFF.
 *
 * It is the most expensive force here — a quadtree rebuilt every tick — and it
 * took the 5,000-node gating benchmark's p95 from ~12ms to ~19ms locally and
 * over the 83ms budget on CI's loaded runners. That budget is not decoration:
 * a tick slower than the 30Hz interval means the layout clock cannot keep pace.
 *
 * Turning it off up there costs nothing that anyone can see. Overlap is a
 * LEGIBILITY problem, and legibility is already gone at 5,000 nodes: every node
 * is at or near NODE_R_MIN, drawn a few pixels wide, and the picture is a
 * cloud rather than a set of distinguishable circles. The brains where you can
 * actually see two nodes intersecting are the ones well under this line.
 */
export const COLLIDE_MAX_NODES = 2_000;

/** How many position buffers the pool will hold. The main thread keeps two
 * (previous + latest, for interpolation) and returns the third — so three is
 * exactly the working set and a fourth would only ever sit idle. */
const POOL_MAX = 3;

export class PhysicsEngine {
  private readonly sim: Simulation<SimNode, SimLink>;
  private readonly linkForce: ForceLink<SimNode, SimLink>;
  private readonly chargeForce: ForceManyBody<SimNode>;
  private readonly collideForce: ForceCollide<SimNode>;
  private readonly xForce: ForceX<SimNode>;
  private readonly yForce: ForceY<SimNode>;

  private params: ForceParams;
  private nodes: SimNode[] = [];
  /** per-link base strength (1/min(deg)), so the multiplier can be re-applied
   * without recomputing degrees on every slider move. */
  private linkBase: Float64Array = new Float64Array(0);
  /** Per-node collision radius, by dense index — the drawn radius plus a gap. */
  private radii: Float64Array = new Float64Array(0);
  private dragging = new Set<number>();
  private pool: Float32Array[] = [];
  private tickCount = 0;
  private intervalMs: number;
  private disposed = false;

  constructor(
    private readonly post: PhysicsPost,
    private readonly scheduler: TickScheduler = createIntervalScheduler(),
    options?: { forces?: Partial<ForceParams>; base?: ForceParams; tickHz?: number },
  ) {
    this.params = normalizeForces(options?.forces, options?.base ?? DEFAULT_FORCES);
    this.intervalMs = 1000 / Math.max(1, options?.tickHz ?? PHYSICS_TICK_HZ);

    this.linkForce = forceLink<SimNode, SimLink>([]).id((d) => d.index);
    this.chargeForce = forceManyBody<SimNode>();
    // Radius-aware separation. `forceManyBody` is a point charge: it knows
    // nothing about how big a node DRAWS, so a degree-24 hub (radius 24px)
    // happily swallowed its degree-1 neighbours (radius 3px) while the
    // simulation considered them comfortably apart. Collision is the only
    // force here that reads the rendered size, and it is what makes "close but
    // never touching" true rather than approximately true.
    this.collideForce = forceCollide<SimNode>().radius((d) => this.radii[d.index] ?? 0);
    this.xForce = forceX<SimNode>(0);
    this.yForce = forceY<SimNode>(0);

    // d3 starts its own rAF timer the moment a simulation is constructed; we
    // drive ticks ourselves at 30Hz, so kill it immediately and never call
    // `restart()` (which would start a SECOND clock ticking the same sim).
    this.sim = forceSimulation<SimNode, SimLink>()
      .stop()
      .force("link", this.linkForce as Force<SimNode, SimLink>)
      .force("charge", this.chargeForce as Force<SimNode, SimLink>)
      .force("collide", this.collideForce as Force<SimNode, SimLink>)
      .force("x", this.xForce as Force<SimNode, SimLink>)
      .force("y", this.yForce as Force<SimNode, SimLink>);

    this.applyParams();
    this.sim.alpha(0);
  }

  /** The live force bag, already normalized. Tests and the UI read it back. */
  get forces(): ForceParams {
    return this.params;
  }

  /** Current alpha — 0-ish means settled. */
  get alpha(): number {
    return this.sim.alpha();
  }

  /** True while the 30Hz clock is running. */
  get running(): boolean {
    return this.scheduler.running;
  }

  /** Node count the simulation currently holds. */
  get order(): number {
    return this.nodes.length;
  }

  handle(command: PhysicsCommand): void {
    if (this.disposed) return;
    switch (command.type) {
      case "data":
        this.setData(command.nodeCount, command.links, command.seed);
        return;
      case "forces":
        this.params = normalizeForces(command.forces, this.params);
        this.applyParams();
        // A force change is a layout change: nudge, do not explode.
        this.reheat(Math.max(this.sim.alpha(), this.params.reheatAlpha));
        return;
      case "pin":
        this.pin(command.index, command.x, command.y, command.drag === true);
        return;
      case "unpin":
        this.unpin(command.index);
        return;
      case "start":
        this.startTicking();
        return;
      case "stop":
        this.scheduler.stop();
        return;
      case "reheat":
        this.reheat(command.alpha ?? this.params.reheatAlpha);
        return;
      case "release":
        this.recycle(command.xy);
        return;
    }
  }

  /** Stop the clock and drop the pool. The worker itself is torn down by the
   * main thread calling `terminate()`; this is for the headless case. */
  dispose(): void {
    this.disposed = true;
    this.scheduler.stop();
    this.pool = [];
  }

  // -- data ----------------------------------------------------------------

  private setData(nodeCount: number, links: Int32Array, seed?: Float32Array): void {
    const n = Math.max(0, Math.floor(nodeCount));
    const next: SimNode[] = new Array<SimNode>(n);

    for (let i = 0; i < n; i += 1) {
      const existing = this.nodes[i];
      if (existing !== undefined) {
        // Dense indices NEVER move for a node already in the store, so page 4
        // of a paged load must not disturb the layout page 1 has been settling
        // for three seconds: the same node object (x, y, vx, vy and any pin)
        // carries straight over.
        next[i] = existing;
        continue;
      }
      const node: SimNode = { index: i };
      const sx = seed?.[2 * i];
      const sy = seed?.[2 * i + 1];
      if (sx !== undefined && sy !== undefined && Number.isFinite(sx) && Number.isFinite(sy)) {
        node.x = sx;
        node.y = sy;
      }
      // No seed: leave x/y undefined and let d3's phyllotaxis place it.
      next[i] = node;
    }

    this.nodes = next;
    // A node being dragged can vanish in a filter change; if it was the last
    // one holding the alpha floor up, release the floor or the simulation
    // never settles again and the fan never stops.
    for (const index of [...this.dragging]) {
      if (index >= n) this.dragging.delete(index);
    }
    if (this.dragging.size === 0) this.sim.alphaTarget(0);

    // Buffers in the pool are sized for the OLD node count; a stale-length
    // buffer would be silently short and the tail of the graph would freeze.
    this.pool = [];

    // Order matters: nodes first, THEN links. `forceLink` resolves a link's
    // numeric source/target against the simulation's CURRENT node array and
    // then MUTATES the link object in place to hold node references — so a
    // fresh link array is built every update (never reused), and it is handed
    // over only after the new nodes are in.
    this.sim.nodes(this.nodes);

    const m = Math.floor(links.length / 2);
    const simLinks: SimLink[] = new Array<SimLink>(m);
    const deg = new Int32Array(n);
    let kept = 0;
    for (let e = 0; e < m; e += 1) {
      const a = links[2 * e]!;
      const b = links[2 * e + 1]!;
      // An endpoint outside [0, n) is a caller bug, but a link d3 cannot
      // resolve THROWS and would take the whole worker down mid-load, so drop
      // it and keep laying out the graph we do have.
      if (a < 0 || b < 0 || a >= n || b >= n || a === b) continue;
      simLinks[kept] = { source: a, target: b };
      deg[a] = deg[a]! + 1;
      deg[b] = deg[b]! + 1;
      kept += 1;
    }
    simLinks.length = kept;

    this.linkBase = new Float64Array(kept);
    for (let e = 0; e < kept; e += 1) {
      const link = simLinks[e]!;
      const a = link.source as number;
      const b = link.target as number;
      // d3's default: normalize by the less-connected endpoint, so a hub does
      // not drag its whole neighbourhood into itself.
      this.linkBase[e] = 1 / Math.max(1, Math.min(deg[a]!, deg[b]!));
    }

    // Same formula the renderer draws with (labels.ts owns it), so the gap you
    // see is the gap the simulation enforces. The node-size SLIDER is
    // deliberately not applied: it is a visual scale that must not reheat the
    // layout, per the split in GraphView.
    // ponytail: base radius only — cranking the size slider past ~1.5 can
    // reintroduce touching; pass nodeSize into the force bag if that matters.
    this.radii = new Float64Array(n);
    for (let i = 0; i < n; i += 1) this.radii[i] = nodeRadius(deg[i]!) + COLLIDE_GAP_PX;
    // d3 CACHES the per-node radius when a force is initialized, and forces
    // are initialized by `simulation.nodes()` — which ran above, before the
    // degrees these radii come from had even been counted. Re-registering the
    // force re-initializes it against the radii we now have. Without this the
    // collide force is silently present and uniformly zero-radius: no error,
    // no effect, and a layout identical to having no collision at all.
    // …and only where it earns its cost (see COLLIDE_MAX_NODES).
    this.sim.force(
      "collide",
      n <= COLLIDE_MAX_NODES ? (this.collideForce as Force<SimNode, SimLink>) : null,
    );

    this.linkForce.links(simLinks);
    this.applyLinkParams();

    if (n === 0) {
      this.scheduler.stop();
      this.sim.alpha(0);
      return;
    }
    this.reheat(this.params.reheatAlpha);
  }

  // -- forces --------------------------------------------------------------

  private applyParams(): void {
    this.sim
      .velocityDecay(this.params.velocityDecay)
      .alphaDecay(this.params.alphaDecay)
      .alphaMin(this.params.alphaMin);
    this.collideForce.strength(this.params.collideStrength);
    this.chargeForce
      .strength(this.params.chargeStrength)
      .theta(this.params.theta)
      .distanceMin(this.params.distanceMin)
      .distanceMax(this.params.distanceMax);
    this.xForce.strength(this.params.centerStrength);
    this.yForce.strength(this.params.centerStrength);
    this.applyLinkParams();
    this.sim.alphaTarget(this.dragging.size > 0 ? this.params.dragAlphaTarget : 0);
  }

  private applyLinkParams(): void {
    const base = this.linkBase;
    const mult = this.params.linkStrength;
    this.linkForce
      .distance(this.params.linkDistance)
      // Re-setting the accessor is what makes d3 recompute its cached strength
      // array, which is the whole point of calling this on every slider move.
      .strength((_link, i) => (base[i] ?? 0) * mult);
  }

  // -- pinning -------------------------------------------------------------

  /**
   * Dense-index lookup for a command off the wire. The `number` on
   * `PhysicsCommand` is a compile-time claim about a `postMessage` payload and
   * nothing more: `nodes["__proto__"]` resolves to `Array.prototype`, which is
   * neither undefined nor a node, so every write in `pin` would land on the
   * prototype of every array in the worker. The bounds check is a numeric
   * conversion first, so no string ever reaches the subscript.
   */
  private nodeAt(index: number): SimNode | undefined {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.nodes.length) return undefined;
    return this.nodes[i];
  }

  private pin(index: number, x: number, y: number, drag: boolean): void {
    const node = this.nodeAt(index);
    if (node === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
    node.fx = x;
    node.fy = y;
    // Also move it NOW: a drag must track the pointer on the very next emitted
    // buffer, not one tick behind it.
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    if (drag) {
      // The node's OWN index, so a `"3"` off the wire cannot leave an entry the
      // matching unpin fails to delete — which would hold the alpha floor up
      // forever and the simulation would never settle.
      this.dragging.add(node.index);
      this.sim.alphaTarget(this.params.dragAlphaTarget);
    }
    this.startTicking();
  }

  private unpin(index: number): void {
    const node = this.nodeAt(index);
    if (node !== undefined) {
      // d3 tests `fx == null`, so null releases and `undefined` would too —
      // null is used because `exactOptionalPropertyTypes` forbids the latter.
      node.fx = null;
      node.fy = null;
    }
    if (this.dragging.delete(node?.index ?? index) && this.dragging.size === 0) {
      // Pointer up: stop holding the floor and let it cool to rest.
      this.sim.alphaTarget(0);
    }
    this.startTicking();
  }

  // -- ticking -------------------------------------------------------------

  private reheat(alpha: number): void {
    if (this.nodes.length === 0) return;
    this.sim.alpha(clamp(alpha, 0, 1));
    this.startTicking();
  }

  private startTicking(): void {
    if (this.disposed || this.nodes.length === 0) return;
    if (this.scheduler.running) return;
    this.scheduler.start(() => this.step(), this.intervalMs);
  }

  /** One simulation tick + one emitted buffer. Public so a test (or a future
   * "step once" debug control) can drive the sim without a clock. */
  step(): void {
    if (this.disposed || this.nodes.length === 0) return;
    this.sim.tick();
    const alpha = this.sim.alpha();
    const settled = alpha < this.params.alphaMin;
    if (settled) {
      // Below alphaMin the layout is done: cancel the clock so an open graph
      // tab costs nothing, and say so on the way out.
      this.scheduler.stop();
    }
    this.emit(alpha, settled);
  }

  private emit(alpha: number, settled: boolean): void {
    const n = this.nodes.length;
    const xy = this.take(n);
    for (let i = 0; i < n; i += 1) {
      const node = this.nodes[i]!;
      xy[2 * i] = node.x ?? 0;
      xy[2 * i + 1] = node.y ?? 0;
    }
    this.tickCount += 1;
    this.post({ type: "tick", n, xy, tick: this.tickCount, alpha, settled }, [
      xy.buffer as ArrayBuffer,
    ]);
  }

  // -- the buffer pool -----------------------------------------------------
  //
  // Every emitted buffer is TRANSFERRED, which detaches it here — so without a
  // pool the worker allocates a fresh 2n Float32Array 30 times a second (2.4MB
  // /s of garbage at 10k nodes) and the GC pauses show up as jank in the very
  // render loop this design exists to keep smooth. The main thread posts each
  // buffer back once it has fallen out of the interpolation window.

  private take(n: number): Float32Array {
    const want = 2 * n;
    const reused = this.pool.pop();
    if (reused !== undefined && reused.length === want) return reused;
    return new Float32Array(want);
  }

  private recycle(xy: Float32Array): void {
    if (!(xy instanceof Float32Array)) return;
    // A buffer from before a data change is the wrong length; drop it.
    if (xy.length !== 2 * this.nodes.length) return;
    if (this.pool.length >= POOL_MAX) return;
    this.pool.push(xy);
  }
}

// ---------------------------------------------------------------------------
// worker wiring
// ---------------------------------------------------------------------------

/**
 * True only inside a real dedicated worker. jsdom (and node) have a `self` but
 * no `WorkerGlobalScope`, so importing this module in a test never installs a
 * message handler and never starts a clock.
 */
function isWorkerScope(): boolean {
  const g = globalThis as unknown as {
    self?: unknown;
    WorkerGlobalScope?: new () => unknown;
  };
  return (
    typeof g.WorkerGlobalScope === "function" &&
    g.self !== undefined &&
    g.self instanceof g.WorkerGlobalScope
  );
}

if (isWorkerScope()) {
  const scope = globalThis as unknown as {
    postMessage(message: unknown, transfer: Transferable[]): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  };
  const engine = new PhysicsEngine((event, transfer) => scope.postMessage(event, transfer));
  scope.addEventListener("message", (event) => {
    engine.handle(event.data as PhysicsCommand);
  });
}
