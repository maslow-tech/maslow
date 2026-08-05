/**
 * The main-thread handle on the layout worker, plus the double-buffered
 * position store the renderer reads.
 *
 * Everything expensive happens in `physics.worker.ts`; this file is deliberately
 * thin, and its whole job is the two things that are easy to get wrong at the
 * boundary:
 *
 *  1. **Zero-copy in both directions.** A position buffer arrives transferred
 *     (detached in the worker) and is transferred BACK once it falls out of the
 *     interpolation window, so the worker refills a pool instead of allocating
 *     2n floats 30 times a second. The consequence the renderer must respect is
 *     stated on `PositionStore`: a buffer older than `previous` is gone —
 *     literally detached — so nothing may hold a reference to one across
 *     frames.
 *  2. **The store keeps exactly the last two ticks.** Physics runs at 30Hz and
 *     the renderer at 60Hz, so every other frame has no new data and must
 *     interpolate; two buffers is the minimum that supports that and the
 *     maximum that can be kept without a copy.
 *
 * The worker is injectable (`options.worker`) because the message protocol and
 * the settle behaviour are worth testing, and spinning a real `Worker` in jsdom
 * to test them is not.
 */

import type { Csr, PositionBuffer } from "./types";
// Protocol + tuning come from ./physics-protocol, NOT from ./physics.worker.
// The worker's self-wiring is guarded by a real-`WorkerGlobalScope` check and
// so would be inert here, but a VALUE import is a hard module dependency: it
// would put d3-force in the main bundle as well as the worker chunk. Keep this
// import off the worker module.
import { type ForceParams, type PhysicsCommand, type PhysicsEvent } from "./physics-protocol";

/**
 * The slice of `Worker` this file uses. Narrow on purpose: a test double is
 * four methods, not a DOM class.
 */
export interface PhysicsWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}

/** What `updateData` needs: the node count and the undirected edge list. */
interface PhysicsData {
  /** node count; dense indices `[0, nodeCount)`, matching `GraphStore`. */
  nodeCount: number;
  /** interleaved undirected pairs `[a0, b0, a1, b1, …]`, length 2m. */
  links: Int32Array;
  /**
   * optional starting positions for NEW indices only (interleaved x,y;
   * non-finite entries fall back to d3's phyllotaxis). The rail spawns a new
   * node at its BFS parent's position through this, so it grows out of the
   * graph instead of flying in from a spiral.
   */
  seed?: Float32Array;
}

/**
 * The undirected edge list the worker wants, taken straight off the CSR.
 *
 * Each undirected edge owns two half-edge slots; emitting only the slot where
 * `neighbor > i` yields each edge exactly once — and yields PARALLEL edges the
 * right number of times, which matters because two objects joined by two verbs
 * should pull twice as hard as one joined by one.
 */
export function linksFromCsr(csr: Csr): Int32Array {
  const out = new Int32Array(2 * csr.m);
  let k = 0;
  for (let i = 0; i < csr.n; i += 1) {
    const end = csr.offsets[i + 1]!;
    for (let s = csr.offsets[i]!; s < end; s += 1) {
      const j = csr.neighbors[s]!;
      if (j <= i) continue;
      out[k] = i;
      out[k + 1] = j;
      k += 2;
    }
  }
  // Self-loops (which the store drops) and any half-edge asymmetry would leave
  // the tail unfilled; hand back only what was written.
  return k === out.length ? out : out.subarray(0, k);
}

/**
 * The last two position buffers, and the lerp between them.
 *
 * **Ownership:** the store owns every buffer it holds. When a third tick
 * arrives the oldest is evicted and handed back to the worker (transferred,
 * i.e. DETACHED here) — so a renderer that stashed it would read a zero-length
 * array. Read `latest`/`previous` inside the frame, never across one.
 */
export class PositionStore {
  private buffers: [PositionBuffer | null, PositionBuffer | null] = [null, null];

  /** The newest tick, or null before the first one lands. */
  get latest(): PositionBuffer | null {
    return this.buffers[1];
  }

  /** The tick before `latest` — the other end of the interpolation. */
  get previous(): PositionBuffer | null {
    return this.buffers[0];
  }

  /** Node count of the newest buffer; 0 before the first tick. */
  get n(): number {
    return this.buffers[1]?.n ?? 0;
  }

  /** True once the simulation has stopped ticking (see the worker header). */
  get settled(): boolean {
    return this.buffers[1]?.settled ?? false;
  }

  /**
   * Admit a tick. Returns the buffer that fell out of the window so the caller
   * can transfer it back to the worker, or null if nothing was evicted.
   */
  push(buffer: PositionBuffer): Float32Array | null {
    const evicted = this.buffers[0];
    this.buffers[0] = this.buffers[1];
    this.buffers[1] = buffer;
    // Only recycle a buffer the worker can still use: after a data change the
    // node count moves and an old-length buffer is worse than a fresh one.
    if (evicted === null) return null;
    return evicted.n === buffer.n ? evicted.xy : null;
  }

  /**
   * Linear interpolation between the last two ticks into `out` (interleaved
   * x,y, length ≥ 2n), which is what turns 30Hz physics into 60Hz motion.
   * `t` is clamped to [0, 1]; with only one buffer it copies that one. Returns
   * false when there is nothing to draw yet.
   */
  lerpInto(out: Float32Array, t: number): boolean {
    const latest = this.buffers[1];
    if (latest === null) return false;
    const n = latest.n;
    if (out.length < 2 * n) return false;
    const previous = this.buffers[0];
    if (previous === null || previous.n !== n || t >= 1) {
      out.set(latest.xy.subarray(0, 2 * n));
      return true;
    }
    const k = t <= 0 ? 0 : t;
    for (let i = 0; i < 2 * n; i += 1) {
      const a = previous.xy[i]!;
      out[i] = a + (latest.xy[i]! - a) * k;
    }
    return true;
  }

  /** Drop both buffers (a filter change, a new brain, unmount). */
  clear(): void {
    this.buffers = [null, null];
  }
}

interface PhysicsHandleOptions {
  /** inject a double in tests; defaults to the real module worker. */
  worker?: PhysicsWorkerLike;
  /** starting force bag; normalized in the worker. */
  forces?: Partial<ForceParams>;
  /** called after every tick lands in the store. */
  onTick?: (store: PositionStore, event: PhysicsEvent) => void;
}

/**
 * `start/stop/updateData/setForces/pin/unpin` over the worker, with the
 * position store attached.
 *
 * Commands are fire-and-forget: the worker is the only owner of the simulation
 * state, and every answer comes back as a tick. There is no request/response
 * pairing anywhere in this protocol, which is why it cannot deadlock.
 */
export class PhysicsHandle {
  readonly positions = new PositionStore();

  private readonly worker: PhysicsWorkerLike;
  private readonly listener: (event: { data: unknown }) => void;
  private readonly subscribers = new Set<(store: PositionStore, event: PhysicsEvent) => void>();
  private nodeCount = 0;
  private disposed = false;

  constructor(options: PhysicsHandleOptions = {}) {
    this.worker = options.worker ?? createPhysicsWorker();
    this.listener = (event) => this.receive(event.data);
    this.worker.addEventListener("message", this.listener);
    if (options.onTick) this.subscribers.add(options.onTick);
    if (options.forces) this.setForces(options.forces);
  }

  /** Subscribe to ticks. Returns the unsubscribe. */
  subscribe(fn: (store: PositionStore, event: PhysicsEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Resume ticking (a no-op if the graph is empty or already running). */
  start(): void {
    this.send({ type: "start" });
  }

  /** Pause ticking without losing the layout — the positions stay where they
   * are and `start()` picks up from there. */
  stop(): void {
    this.send({ type: "stop" });
  }

  /**
   * Replace the graph. Existing dense indices keep their positions (the store
   * never moves an index), so a later page of a paged load merges into the
   * layout already on screen instead of restarting it; the worker reheats to
   * `alpha(0.5)`, never 1.
   */
  updateData(data: PhysicsData): void {
    this.nodeCount = Math.max(0, Math.floor(data.nodeCount));
    const transfer: Transferable[] = [data.links.buffer as ArrayBuffer];
    const command: PhysicsCommand =
      data.seed === undefined
        ? { type: "data", nodeCount: this.nodeCount, links: data.links }
        : { type: "data", nodeCount: this.nodeCount, links: data.links, seed: data.seed };
    if (data.seed !== undefined) transfer.push(data.seed.buffer as ArrayBuffer);
    // The buffers we just handed over are detached on this side; the caller
    // must not reuse them (documented on PhysicsData).
    this.send(command, transfer);
  }

  /** Move one or more force sliders. Unknown/out-of-range values are clamped
   * worker-side, because these come back out of a persisted saved view. */
  setForces(forces: Partial<ForceParams>): void {
    this.send({ type: "forces", forces });
  }

  /**
   * Hold node `index` at a world point. `drag: true` marks it as a pointer
   * drag, which holds `alphaTarget(0.3)` until the matching `unpin` — a rail
   * focus node is pinned WITHOUT it, so the layout still settles to rest.
   */
  pin(index: number, x: number, y: number, options?: { drag?: boolean }): void {
    this.send({ type: "pin", index, x, y, drag: options?.drag === true });
  }

  /** Release a pinned node. */
  unpin(index: number): void {
    this.send({ type: "unpin", index });
  }

  /** Nudge a settled layout back to life (0.5 by default — never 1). */
  reheat(alpha?: number): void {
    this.send(alpha === undefined ? { type: "reheat" } : { type: "reheat", alpha });
  }

  /** Stop everything and tear the worker down. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.removeEventListener("message", this.listener);
    this.worker.terminate();
    this.subscribers.clear();
    this.positions.clear();
  }

  private send(command: PhysicsCommand, transfer?: Transferable[]): void {
    if (this.disposed) return;
    if (transfer === undefined) this.worker.postMessage(command);
    else this.worker.postMessage(command, transfer);
  }

  private receive(data: unknown): void {
    if (this.disposed) return;
    const event = data as PhysicsEvent | null;
    if (event === null || typeof event !== "object" || event.type !== "tick") return;
    const buffer: PositionBuffer = {
      n: event.n,
      xy: event.xy,
      tick: event.tick,
      alpha: event.alpha,
      settled: event.settled,
    };
    const recycled = this.positions.push(buffer);
    if (recycled !== null && recycled.length === 2 * this.nodeCount) {
      this.send({ type: "release", xy: recycled }, [recycled.buffer as ArrayBuffer]);
    }
    for (const fn of this.subscribers) fn(this.positions, event);
  }
}

/**
 * The real worker. Vite rewrites `new URL("./physics.worker.ts",
 * import.meta.url)` into the built worker chunk; the cast is because `Worker`'s
 * overloaded `postMessage` does not structurally match our narrowed interface.
 */
function createPhysicsWorker(): PhysicsWorkerLike {
  if (typeof Worker === "undefined") {
    throw new Error("physics: no Worker in this environment — inject options.worker");
  }
  return new Worker(new URL("./physics.worker.ts", import.meta.url), {
    type: "module",
    name: "graph-physics",
  }) as unknown as PhysicsWorkerLike;
}
