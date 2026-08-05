import { describe, expect, it } from "vitest";

import { buildCsr } from "./csr";
import { PhysicsHandle, PositionStore, linksFromCsr, type PhysicsWorkerLike } from "./physics";
import { nodeRadius } from "./labels";
import {
  DEFAULT_FORCES,
  PhysicsEngine,
  RAIL_FORCES,
  normalizeForces,
  type PhysicsCommand,
  type PhysicsEvent,
  type TickScheduler,
} from "./physics.worker";
import { GraphStore } from "./store";
import type { PositionBuffer } from "./types";

/**
 * The physics engine is the one part of the graph that runs forever, off the
 * main thread, with no DOM to look at — so the things worth pinning down are
 * exactly the ones that are invisible until a laptop fan tells you about them:
 *
 *  - the simulation SETTLES and then STOPS. A layout that keeps ticking at
 *    alpha 1e-9 costs a core forever and is indistinguishable from a settled
 *    one on screen; the tests assert the clock is actually cancelled and that
 *    nothing is emitted afterwards.
 *  - a reheat RESUMES it, and reheats to 0.5 rather than 1 (a full reheat
 *    visibly explodes an almost-correct layout, which reads to a user as "the
 *    graph reset itself" when a later page of a paged load landed).
 *  - a PINNED node does not move — the whole drag interaction, and the rail's
 *    pinned focus node, are built on that being exactly true rather than
 *    approximately true.
 *  - the message protocol round-trips, including the buffer recycling: a
 *    position buffer is transferred out and transferred BACK, and the engine
 *    reuses the identical object. If that ever silently stops working the only
 *    symptom is 2.4MB/s of garbage at 10k nodes.
 *
 * Everything runs headlessly: the worker is stubbed (a plain object with the
 * four methods `PhysicsHandle` uses) and the 30Hz clock is a manual scheduler,
 * so a 300-tick settle is instant and never flaky.
 */

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** The 30Hz clock, under test control. */
class ManualScheduler implements TickScheduler {
  private fn: (() => void) | null = null;
  private active = false;
  starts = 0;
  stops = 0;

  start(fn: () => void, _intervalMs: number): void {
    if (this.active) return;
    this.fn = fn;
    this.active = true;
    this.starts += 1;
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.stops += 1;
  }

  get running(): boolean {
    return this.active;
  }

  /** Run up to `n` ticks, stopping early if the engine cancels the clock.
   * Returns how many actually ran. */
  run(n: number): number {
    let ran = 0;
    for (let i = 0; i < n; i += 1) {
      if (!this.active || this.fn === null) break;
      this.fn();
      ran += 1;
    }
    return ran;
  }
}

interface Harness {
  engine: PhysicsEngine;
  scheduler: ManualScheduler;
  events: PhysicsEvent[];
  /** every buffer handed back to the engine, in order. */
  released: Float32Array[];
  /** the transfer list of the last post. */
  lastTransfer: Transferable[];
  last(): PhysicsEvent;
  /** copy the newest positions out before the next tick reuses the buffer. */
  positionsOf(index: number): [number, number];
}

/**
 * An engine wired to a manual clock, with every emitted buffer immediately
 * handed back (which is what the real main thread does two ticks later) so the
 * pool is exercised by every test rather than by one.
 */
function makeEngine(options?: {
  recycle?: boolean;
  forces?: Parameters<typeof normalizeForces>[0];
}): Harness {
  const events: PhysicsEvent[] = [];
  const released: Float32Array[] = [];
  const scheduler = new ManualScheduler();
  const harness: Harness = {
    engine: null as unknown as PhysicsEngine,
    scheduler,
    events,
    released,
    lastTransfer: [],
    last: () => events[events.length - 1]!,
    positionsOf: (index) => {
      const e = events[events.length - 1]!;
      return [e.xy[2 * index]!, e.xy[2 * index + 1]!];
    },
  };
  const engine = new PhysicsEngine(
    (event, transfer) => {
      harness.lastTransfer = transfer;
      // Copy out before recycling: the real main thread holds the buffer for
      // two ticks, this harness holds a snapshot forever.
      events.push({ ...event, xy: Float32Array.from(event.xy) });
      if (options?.recycle !== false) {
        released.push(event.xy);
        engine.handle({ type: "release", xy: event.xy });
      }
    },
    scheduler,
    options?.forces ? { forces: options.forces } : undefined,
  );
  harness.engine = engine;
  return harness;
}

/** An undirected ring plus a few chords — connected, no isolated nodes. */
function ringLinks(n: number): Int32Array {
  const pairs: number[] = [];
  for (let i = 0; i < n; i += 1) {
    pairs.push(i, (i + 1) % n);
    if (i % 5 === 0) pairs.push(i, (i + Math.floor(n / 2)) % n);
  }
  return Int32Array.from(pairs);
}

function loadRing(h: Harness, n: number): void {
  h.engine.handle({ type: "data", nodeCount: n, links: ringLinks(n) });
}

/** Tick until the engine cancels its own clock. Returns the tick count. */
function settle(h: Harness, cap = 5000): number {
  return h.scheduler.run(cap);
}

// ---------------------------------------------------------------------------
// settle behaviour
// ---------------------------------------------------------------------------

describe("PhysicsEngine — settling", () => {
  it("decays to rest and STOPS ticking, in roughly the committed 300 ticks", () => {
    const h = makeEngine();
    loadRing(h, 60);

    expect(h.scheduler.running).toBe(true);
    // Data lands as a nudge, not an explosion: alpha 0.5, never 1.
    expect(h.engine.alpha).toBeCloseTo(DEFAULT_FORCES.reheatAlpha, 10);

    const ticks = settle(h);

    // alphaDecay 0.0228 from alpha 0.5 crosses alphaMin 0.001 at ~270 ticks —
    // ~9s at 30Hz, inside the ≤4s-to-legible / 10s-to-rest budget.
    expect(ticks).toBeGreaterThan(200);
    expect(ticks).toBeLessThan(320);
    expect(h.scheduler.running).toBe(false);
    expect(h.engine.alpha).toBeLessThan(DEFAULT_FORCES.alphaMin);
  });

  it("marks only the final tick settled, and emits nothing after it", () => {
    const h = makeEngine();
    loadRing(h, 40);
    settle(h);

    const settledFlags = h.events.map((e) => e.settled);
    expect(settledFlags.filter(Boolean)).toHaveLength(1);
    expect(settledFlags[settledFlags.length - 1]).toBe(true);

    const emitted = h.events.length;
    // The clock is cancelled, so a settled graph costs ~0% CPU: driving the
    // scheduler again produces nothing at all.
    expect(h.scheduler.run(50)).toBe(0);
    expect(h.events).toHaveLength(emitted);
  });

  it("resumes on reheat, and reheats to 0.5 rather than 1", () => {
    const h = makeEngine();
    loadRing(h, 40);
    settle(h);
    const settledAt = h.events.length;

    h.engine.handle({ type: "reheat" });
    expect(h.scheduler.running).toBe(true);
    expect(h.engine.alpha).toBeCloseTo(0.5, 10);
    expect(h.engine.alpha).toBeLessThan(1);

    const resumed = settle(h);
    expect(resumed).toBeGreaterThan(200);
    expect(h.events.length).toBeGreaterThan(settledAt);
    expect(h.last().settled).toBe(true);
    // Tick numbers are monotonic across a reheat — the renderer uses them to
    // tell a stale buffer from a fresh one.
    expect(h.last().tick).toBe(h.events.length);
  });

  it("reheats on a data change instead of restarting the layout", () => {
    const h = makeEngine();
    loadRing(h, 30);
    settle(h);
    const before = h.positionsOf(3);

    // Page two of a paged load: 30 more nodes, same dense indices for the old
    // ones — the settled layout must survive it.
    h.engine.handle({ type: "data", nodeCount: 60, links: ringLinks(60) });
    expect(h.engine.alpha).toBeCloseTo(0.5, 10);
    expect(h.scheduler.running).toBe(true);

    h.scheduler.run(1);
    const after = h.positionsOf(3);
    expect(h.last().n).toBe(60);
    // It moves (the graph changed) but it does not teleport.
    expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(60);
  });

  it("does nothing at all with an empty graph", () => {
    const h = makeEngine();
    h.engine.handle({ type: "data", nodeCount: 0, links: new Int32Array(0) });
    expect(h.scheduler.running).toBe(false);
    expect(h.events).toHaveLength(0);

    h.engine.handle({ type: "start" });
    h.engine.handle({ type: "reheat" });
    expect(h.scheduler.running).toBe(false);
    expect(h.events).toHaveLength(0);
  });

  it("stops and restarts without losing the layout", () => {
    const h = makeEngine();
    loadRing(h, 40);
    h.scheduler.run(30);
    const paused = h.positionsOf(7);
    const alpha = h.engine.alpha;

    h.engine.handle({ type: "stop" });
    expect(h.scheduler.running).toBe(false);
    expect(h.scheduler.run(20)).toBe(0);

    h.engine.handle({ type: "start" });
    expect(h.scheduler.running).toBe(true);
    expect(h.engine.alpha).toBeCloseTo(alpha, 10);
    h.scheduler.run(1);
    const resumed = h.positionsOf(7);
    expect(Math.hypot(resumed[0] - paused[0], resumed[1] - paused[1])).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// layout sanity — the forces are actually wired
// ---------------------------------------------------------------------------

describe("PhysicsEngine — layout", () => {
  it("produces a finite, spread-out layout", () => {
    const h = makeEngine();
    loadRing(h, 80);
    settle(h);

    const { xy, n } = h.last();
    expect(n).toBe(80);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < 2 * n; i += 1) expect(Number.isFinite(xy[i]!)).toBe(true);
    for (let i = 0; i < n; i += 1) {
      minX = Math.min(minX, xy[2 * i]!);
      maxX = Math.max(maxX, xy[2 * i]!);
    }
    // Repulsion ran: 80 nodes are not stacked on the origin.
    expect(maxX - minX).toBeGreaterThan(50);
    // Centering ran: they did not fly off to infinity either.
    expect(maxX - minX).toBeLessThan(20000);
  });

  it("keeps a node's position when a later page grows the graph", () => {
    const h = makeEngine();
    loadRing(h, 20);
    settle(h);
    const kept = h.positionsOf(11);

    h.engine.handle({ type: "data", nodeCount: 40, links: ringLinks(20) });
    h.engine.handle({ type: "stop" });
    // Positions are emitted on tick, so take one tick with no time to move.
    h.engine.handle({ type: "start" });
    h.scheduler.run(1);
    const now = h.positionsOf(11);
    expect(Math.hypot(now[0] - kept[0], now[1] - kept[1])).toBeLessThan(40);
  });

  it("seeds new nodes where the caller asks", () => {
    const h = makeEngine();
    const seed = new Float32Array(4);
    seed[0] = 500;
    seed[1] = -500;
    seed[2] = NaN; // non-finite: fall back to d3's own placement
    seed[3] = NaN;
    h.engine.handle({ type: "data", nodeCount: 2, links: new Int32Array(0), seed });
    h.engine.handle({ type: "stop" });
    h.engine.handle({ type: "start" });
    h.scheduler.run(1);

    const [x, y] = h.positionsOf(0);
    // One tick of centering at 0.06 * 0.5 alpha barely moves it.
    expect(x).toBeGreaterThan(400);
    expect(y).toBeLessThan(-400);
    const [x1, y1] = h.positionsOf(1);
    expect(Number.isFinite(x1)).toBe(true);
    expect(Number.isFinite(y1)).toBe(true);
  });

  it("drops a link naming a node it was never given, instead of throwing", () => {
    const h = makeEngine();
    // Index 99 does not exist: d3 would throw "node not found" and take the
    // whole worker down mid-load.
    expect(() => {
      h.engine.handle({ type: "data", nodeCount: 4, links: Int32Array.from([0, 1, 2, 99, 3, 3]) });
    }).not.toThrow();
    settle(h);
    expect(h.last().n).toBe(4);
    for (const v of h.last().xy) expect(Number.isFinite(v)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pinning
// ---------------------------------------------------------------------------

describe("PhysicsEngine — pinning", () => {
  it("holds a pinned node exactly still, tick after tick", () => {
    const h = makeEngine();
    loadRing(h, 40);
    h.scheduler.run(20);

    h.engine.handle({ type: "pin", index: 2, x: 120, y: -60 });
    const from = h.events.length;
    h.scheduler.run(150);

    expect(h.events.length).toBeGreaterThan(from);
    for (let e = from; e < h.events.length; e += 1) {
      const ev = h.events[e]!;
      expect(ev.xy[4]).toBe(120);
      expect(ev.xy[5]).toBe(-60);
    }
  });

  it("lets a node move again once unpinned", () => {
    const h = makeEngine();
    loadRing(h, 40);
    // A drag keeps the simulation warm, so the release is observable.
    h.engine.handle({ type: "pin", index: 2, x: 120, y: -60, drag: true });
    h.scheduler.run(60);
    expect(h.positionsOf(2)).toEqual([120, -60]);

    h.engine.handle({ type: "unpin", index: 2 });
    h.scheduler.run(60);
    const [x, y] = h.positionsOf(2);
    expect(Math.hypot(x - 120, y + 60)).toBeGreaterThan(0.5);
  });

  it("holds the simulation warm while dragging and lets it cool on release", () => {
    const h = makeEngine();
    loadRing(h, 30);
    h.engine.handle({ type: "pin", index: 0, x: 10, y: 10, drag: true });

    // alphaTarget(0.3) — a drag never settles, however long it lasts.
    expect(h.scheduler.run(2000)).toBe(2000);
    expect(h.scheduler.running).toBe(true);
    expect(h.engine.alpha).toBeGreaterThan(0.25);
    expect(h.last().settled).toBe(false);

    h.engine.handle({ type: "unpin", index: 0 });
    const ticks = settle(h);
    expect(ticks).toBeGreaterThan(0);
    expect(h.scheduler.running).toBe(false);
    expect(h.last().settled).toBe(true);
  });

  it("ignores a pin on an index it does not have, and a non-finite point", () => {
    const h = makeEngine();
    loadRing(h, 5);
    expect(() => {
      h.engine.handle({ type: "pin", index: 99, x: 1, y: 1, drag: true });
      h.engine.handle({ type: "pin", index: 1, x: NaN, y: 1 });
      h.engine.handle({ type: "unpin", index: 99 });
    }).not.toThrow();
    settle(h);
    for (const v of h.last().xy) expect(Number.isFinite(v)).toBe(true);
  });

  it("drops a drag pin whose index disappears in a data change", () => {
    const h = makeEngine();
    loadRing(h, 20);
    h.engine.handle({ type: "pin", index: 15, x: 0, y: 0, drag: true });
    expect(h.scheduler.run(500)).toBe(500); // held warm

    h.engine.handle({ type: "data", nodeCount: 8, links: ringLinks(8) });
    // The dragged node is gone with the filter change; nothing holds the floor
    // any more, so the layout is allowed to come to rest.
    expect(settle(h)).toBeLessThan(400);
    expect(h.scheduler.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forces
// ---------------------------------------------------------------------------

describe("normalizeForces", () => {
  it("ships the committed tuning as the default", () => {
    expect(DEFAULT_FORCES.theta).toBe(1.0);
    expect(DEFAULT_FORCES.distanceMax).toBe(400);
    expect(DEFAULT_FORCES.distanceMin).toBe(1);
    expect(DEFAULT_FORCES.velocityDecay).toBe(0.5);
    expect(DEFAULT_FORCES.alphaDecay).toBeCloseTo(0.0228, 5);
    expect(DEFAULT_FORCES.reheatAlpha).toBe(0.5);
    expect(DEFAULT_FORCES.dragAlphaTarget).toBe(0.3);
    // The rail runs the same engine scaled down, not the global bag.
    expect(RAIL_FORCES.linkDistance).toBeLessThan(DEFAULT_FORCES.linkDistance);
    expect(RAIL_FORCES.chargeStrength).toBeGreaterThan(DEFAULT_FORCES.chargeStrength);
  });

  it("normalizes a hostile bag read back out of a saved view", () => {
    const hostile = {
      linkDistance: Number.NaN,
      linkStrength: 99,
      chargeStrength: 500, // positive would collapse the graph to a point
      centerStrength: -3,
      alphaDecay: 0,
      velocityDecay: 12,
      distanceMax: Number.POSITIVE_INFINITY,
    };
    const out = normalizeForces(hostile);
    expect(out.linkDistance).toBe(DEFAULT_FORCES.linkDistance);
    expect(out.linkStrength).toBe(2);
    expect(out.chargeStrength).toBe(0);
    expect(out.centerStrength).toBe(0);
    expect(out.alphaDecay).toBeGreaterThan(0);
    expect(out.velocityDecay).toBeLessThanOrEqual(0.95);
    expect(Number.isFinite(out.distanceMax)).toBe(true);
    expect(out.distanceMax).toBeGreaterThanOrEqual(out.distanceMin);
    // undefined leaves the base alone
    expect(normalizeForces(undefined)).toEqual(DEFAULT_FORCES);
  });

  it("folds a partial change onto the live bag and nudges the layout", () => {
    const h = makeEngine();
    loadRing(h, 20);
    settle(h);

    h.engine.handle({ type: "forces", forces: { linkDistance: 200, chargeStrength: -5 } });
    expect(h.engine.forces.linkDistance).toBe(200);
    expect(h.engine.forces.chargeStrength).toBe(-5);
    // untouched knobs survive
    expect(h.engine.forces.theta).toBe(DEFAULT_FORCES.theta);
    // a force change is a layout change: reheat to 0.5, not 1
    expect(h.engine.alpha).toBeCloseTo(0.5, 10);
    expect(h.scheduler.running).toBe(true);
    settle(h);
    for (const v of h.last().xy) expect(Number.isFinite(v)).toBe(true);
  });

  it("takes its starting bag from the constructor", () => {
    const h = makeEngine({ forces: { linkDistance: 20, chargeStrength: -60 } });
    expect(h.engine.forces.linkDistance).toBe(20);
    expect(h.engine.forces.chargeStrength).toBe(-60);
    expect(h.engine.forces.distanceMax).toBe(DEFAULT_FORCES.distanceMax);
  });
});

// ---------------------------------------------------------------------------
// the transferable buffer pool
// ---------------------------------------------------------------------------

describe("PhysicsEngine — position buffers", () => {
  it("transfers the buffer and reuses the ones handed back", () => {
    const h = makeEngine();
    loadRing(h, 10);
    h.scheduler.run(6);

    // Every tick is posted with its backing buffer in the transfer list —
    // that is the zero-copy contract.
    expect(h.lastTransfer).toHaveLength(1);
    expect(h.lastTransfer[0]).toBeInstanceOf(ArrayBuffer);

    // The harness releases each buffer immediately, so the pool never empties
    // and the engine allocates nothing after the first few ticks.
    const distinct = new Set(h.released.map((b) => b.buffer));
    expect(distinct.size).toBeLessThanOrEqual(2);
    expect(h.released.length).toBeGreaterThan(4);
  });

  it("refuses a recycled buffer of the wrong length", () => {
    const h = makeEngine({ recycle: false });
    loadRing(h, 10);
    h.scheduler.run(2);
    const stale = new Float32Array(2 * 999);
    h.engine.handle({ type: "release", xy: stale });
    h.scheduler.run(1);
    expect(h.last().xy).toHaveLength(20);
    expect(h.last().n).toBe(10);
  });

  it("allocates a fresh buffer when nothing has been handed back", () => {
    const h = makeEngine({ recycle: false });
    loadRing(h, 10);
    h.scheduler.run(3);
    expect(h.events.every((e) => e.xy.length === 20)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PositionStore
// ---------------------------------------------------------------------------

function buffer(n: number, fill: number, tick: number, settled = false): PositionBuffer {
  const xy = new Float32Array(2 * n).fill(fill);
  return { n, xy, tick, alpha: 0.1, settled };
}

describe("PositionStore", () => {
  it("keeps exactly the last two ticks and evicts the third", () => {
    const store = new PositionStore();
    expect(store.latest).toBeNull();
    expect(store.previous).toBeNull();
    expect(store.n).toBe(0);
    expect(store.settled).toBe(false);

    const first = buffer(3, 1, 1);
    expect(store.push(first)).toBeNull();
    expect(store.latest?.tick).toBe(1);
    expect(store.previous).toBeNull();

    const second = buffer(3, 2, 2);
    expect(store.push(second)).toBeNull();
    expect(store.previous?.tick).toBe(1);
    expect(store.latest?.tick).toBe(2);

    const third = buffer(3, 3, 3, true);
    // The evicted buffer comes back for recycling — same object, no copy.
    expect(store.push(third)).toBe(first.xy);
    expect(store.previous?.tick).toBe(2);
    expect(store.latest?.tick).toBe(3);
    expect(store.settled).toBe(true);
    expect(store.n).toBe(3);
  });

  it("does not recycle across a node-count change", () => {
    const store = new PositionStore();
    store.push(buffer(3, 1, 1));
    store.push(buffer(3, 2, 2));
    expect(store.push(buffer(5, 3, 3))).toBeNull();
  });

  it("interpolates between the two ticks", () => {
    const store = new PositionStore();
    store.push(buffer(2, 0, 1));
    store.push(buffer(2, 10, 2));

    const out = new Float32Array(4);
    expect(store.lerpInto(out, 0.5)).toBe(true);
    expect(Array.from(out)).toEqual([5, 5, 5, 5]);

    expect(store.lerpInto(out, 0)).toBe(true);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);

    expect(store.lerpInto(out, 3)).toBe(true); // clamped
    expect(Array.from(out)).toEqual([10, 10, 10, 10]);
  });

  it("copies the single buffer it has, and refuses an undersized target", () => {
    const store = new PositionStore();
    expect(store.lerpInto(new Float32Array(4), 0.5)).toBe(false);
    store.push(buffer(2, 7, 1));
    const out = new Float32Array(4);
    expect(store.lerpInto(out, 0.5)).toBe(true);
    expect(Array.from(out)).toEqual([7, 7, 7, 7]);
    expect(store.lerpInto(new Float32Array(2), 0.5)).toBe(false);
  });

  it("clears", () => {
    const store = new PositionStore();
    store.push(buffer(2, 1, 1));
    store.clear();
    expect(store.latest).toBeNull();
    expect(store.previous).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the message protocol, with the worker stubbed
// ---------------------------------------------------------------------------

class StubWorker implements PhysicsWorkerLike {
  readonly posted: { message: PhysicsCommand; transfer: Transferable[] | undefined }[] = [];
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  terminated = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message: message as PhysicsCommand, transfer });
  }

  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Pretend the worker emitted a tick. */
  emit(event: PhysicsEvent): void {
    for (const fn of this.listeners) fn({ data: event });
  }

  commands(type: PhysicsCommand["type"]): PhysicsCommand[] {
    return this.posted.filter((p) => p.message.type === type).map((p) => p.message);
  }
}

describe("PhysicsHandle — message protocol", () => {
  it("sends one command per call, with the shapes the worker parses", () => {
    const worker = new StubWorker();
    const handle = new PhysicsHandle({ worker });

    handle.start();
    handle.stop();
    handle.setForces({ linkDistance: 33 });
    handle.pin(4, 10, -10);
    handle.pin(5, 1, 2, { drag: true });
    handle.unpin(4);
    handle.reheat();
    handle.reheat(0.2);

    expect(worker.posted.map((p) => p.message.type)).toEqual([
      "start",
      "stop",
      "forces",
      "pin",
      "pin",
      "unpin",
      "reheat",
      "reheat",
    ]);
    const pins = worker.commands("pin");
    expect(pins[0]).toEqual({ type: "pin", index: 4, x: 10, y: -10, drag: false });
    expect(pins[1]).toEqual({ type: "pin", index: 5, x: 1, y: 2, drag: true });
    expect(worker.commands("unpin")[0]).toEqual({ type: "unpin", index: 4 });
    expect(worker.commands("reheat")).toEqual([{ type: "reheat" }, { type: "reheat", alpha: 0.2 }]);
    expect(worker.commands("forces")[0]).toEqual({ type: "forces", forces: { linkDistance: 33 } });
  });

  it("transfers the link buffer instead of cloning it", () => {
    const worker = new StubWorker();
    const handle = new PhysicsHandle({ worker });
    const links = Int32Array.from([0, 1, 1, 2]);
    const seed = new Float32Array([0, 0, 1, 1, 2, 2]);

    handle.updateData({ nodeCount: 3, links, seed });
    const post = worker.posted[0]!;
    expect(post.message.type).toBe("data");
    expect(post.transfer).toEqual([links.buffer, seed.buffer]);
  });

  it("omits `seed` entirely when there is none", () => {
    const worker = new StubWorker();
    const handle = new PhysicsHandle({ worker });
    handle.updateData({ nodeCount: 2, links: Int32Array.from([0, 1]) });
    const message = worker.posted[0]!.message;
    expect(message).not.toHaveProperty("seed");
    expect(worker.posted[0]!.transfer).toHaveLength(1);
  });

  it("passes a constructor force bag straight through", () => {
    const worker = new StubWorker();
    new PhysicsHandle({ worker, forces: { chargeStrength: -60 } });
    expect(worker.commands("forces")[0]).toEqual({
      type: "forces",
      forces: { chargeStrength: -60 },
    });
  });

  it("files incoming ticks into the store and hands the stale buffer back", () => {
    const worker = new StubWorker();
    const ticks: PhysicsEvent[] = [];
    const handle = new PhysicsHandle({ worker, onTick: (_s, e) => ticks.push(e) });
    handle.updateData({ nodeCount: 2, links: Int32Array.from([0, 1]) });

    const a = new Float32Array([0, 0, 0, 0]);
    const b = new Float32Array([2, 2, 2, 2]);
    const c = new Float32Array([4, 4, 4, 4]);
    worker.emit({ type: "tick", n: 2, xy: a, tick: 1, alpha: 0.5, settled: false });
    worker.emit({ type: "tick", n: 2, xy: b, tick: 2, alpha: 0.4, settled: false });
    expect(worker.commands("release")).toHaveLength(0);

    worker.emit({ type: "tick", n: 2, xy: c, tick: 3, alpha: 0.3, settled: false });
    const release = worker.commands("release")[0] as { type: "release"; xy: Float32Array };
    // The identical Float32Array goes back — that is the zero-copy round trip.
    expect(release.xy).toBe(a);
    expect(worker.posted[worker.posted.length - 1]!.transfer).toEqual([a.buffer]);

    expect(handle.positions.previous?.tick).toBe(2);
    expect(handle.positions.latest?.tick).toBe(3);
    expect(ticks.map((t) => t.tick)).toEqual([1, 2, 3]);
  });

  it("ignores anything that is not a tick", () => {
    const worker = new StubWorker();
    const handle = new PhysicsHandle({ worker });
    for (const junk of [null, undefined, 7, "tick", { type: "nope" }]) {
      for (const fn of worker.listeners) fn({ data: junk });
    }
    expect(handle.positions.latest).toBeNull();
  });

  it("unsubscribes and disposes cleanly", () => {
    const worker = new StubWorker();
    const handle = new PhysicsHandle({ worker });
    const seen: number[] = [];
    const off = handle.subscribe((_s, e) => seen.push(e.tick));
    worker.emit({ type: "tick", n: 1, xy: new Float32Array(2), tick: 1, alpha: 1, settled: false });
    off();
    worker.emit({ type: "tick", n: 1, xy: new Float32Array(2), tick: 2, alpha: 1, settled: false });
    expect(seen).toEqual([1]);

    handle.dispose();
    expect(worker.terminated).toBe(true);
    expect(worker.listeners.size).toBe(0);
    const after = worker.posted.length;
    handle.start();
    handle.dispose();
    expect(worker.posted).toHaveLength(after);
    expect(handle.positions.latest).toBeNull();
  });

  it("refuses to build a real worker where there is none", () => {
    const original = Reflect.get(globalThis, "Worker");
    Reflect.deleteProperty(globalThis, "Worker");
    try {
      expect(() => new PhysicsHandle()).toThrow(/no Worker/);
    } finally {
      if (original !== undefined) Reflect.set(globalThis, "Worker", original);
    }
  });
});

// ---------------------------------------------------------------------------
// end to end, still headless: handle → stub worker → real engine → handle
// ---------------------------------------------------------------------------

describe("PhysicsHandle over a real engine (worker stubbed)", () => {
  it("settles, stops, and reheats through the wire protocol", () => {
    const scheduler = new ManualScheduler();
    let engine: PhysicsEngine | null = null;
    const worker = new StubWorker();
    // Loopback: whatever the handle posts is handed to a real engine, and
    // whatever the engine emits is delivered back as a message. Transfer
    // semantics are honoured by never touching a buffer after posting it.
    const loopback: PhysicsWorkerLike = {
      postMessage: (message) => engine?.handle(message as PhysicsCommand),
      addEventListener: (t, fn) => worker.addEventListener(t, fn),
      removeEventListener: (t, fn) => worker.removeEventListener(t, fn),
      terminate: () => engine?.dispose(),
    };
    engine = new PhysicsEngine((event) => worker.emit(event), scheduler);

    const handle = new PhysicsHandle({ worker: loopback });
    handle.updateData({ nodeCount: 50, links: ringLinks(50) });

    expect(scheduler.running).toBe(true);
    const ticks = scheduler.run(5000);
    expect(ticks).toBeGreaterThan(200);
    expect(ticks).toBeLessThan(320);
    expect(scheduler.running).toBe(false);

    const latest = handle.positions.latest;
    expect(latest?.settled).toBe(true);
    expect(latest?.n).toBe(50);
    expect(handle.positions.previous?.settled).toBe(false);
    expect(handle.positions.n).toBe(50);

    // Two buffers are held for interpolation and the rest went back to the
    // engine, so the pool — not the allocator — is feeding the loop.
    const out = new Float32Array(100);
    expect(handle.positions.lerpInto(out, 0.5)).toBe(true);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);

    handle.reheat();
    expect(scheduler.running).toBe(true);
    expect(scheduler.run(5000)).toBeGreaterThan(200);
    expect(handle.positions.latest?.settled).toBe(true);

    handle.dispose();
    expect(scheduler.running).toBe(false);
  });

  it("keeps a pinned node exactly where the handle put it", () => {
    const scheduler = new ManualScheduler();
    const worker = new StubWorker();
    let engine: PhysicsEngine | null = null;
    const loopback: PhysicsWorkerLike = {
      postMessage: (message) => engine?.handle(message as PhysicsCommand),
      addEventListener: (t, fn) => worker.addEventListener(t, fn),
      removeEventListener: (t, fn) => worker.removeEventListener(t, fn),
      terminate: () => engine?.dispose(),
    };
    const seen: [number, number][] = [];
    engine = new PhysicsEngine((event) => worker.emit(event), scheduler);
    const handle = new PhysicsHandle({
      worker: loopback,
      onTick: (store) => {
        const latest = store.latest!;
        seen.push([latest.xy[0]!, latest.xy[1]!]);
      },
    });

    handle.updateData({ nodeCount: 25, links: ringLinks(25) });
    handle.pin(0, -42, 17, { drag: true });
    scheduler.run(120);

    expect(seen.length).toBeGreaterThan(100);
    for (const [x, y] of seen) {
      expect(x).toBe(-42);
      expect(y).toBe(17);
    }

    handle.unpin(0);
    scheduler.run(60);
    const [x, y] = seen[seen.length - 1]!;
    expect(Math.hypot(x + 42, y - 17)).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// linksFromCsr
// ---------------------------------------------------------------------------

describe("linksFromCsr", () => {
  it("emits every undirected edge exactly once, parallel verbs included", () => {
    const store = new GraphStore();
    store.ingest({
      nodes: [
        { id: "a", title: "A", type: null, degree: 3 },
        { id: "b", title: "B", type: null, degree: 3 },
        { id: "c", title: "C", type: null, degree: 2 },
      ],
      edges: [
        { from: "a", to: "b", rel: "mentions" },
        // a second verb between the same pair is a second link: it should pull
        // twice as hard, so it is emitted twice.
        { from: "a", to: "b", rel: "owns" },
        { from: "b", to: "c", rel: "part_of" },
      ],
    });
    const csr = buildCsr(store);
    const links = linksFromCsr(csr);

    expect(links).toHaveLength(2 * csr.m);
    const pairs: string[] = [];
    for (let i = 0; i < links.length; i += 2) pairs.push(`${links[i]}-${links[i + 1]}`);
    expect(pairs.sort()).toEqual(["0-1", "0-1", "1-2"]);
  });

  it("is empty for a graph with no edges", () => {
    const store = new GraphStore();
    store.ingest({
      nodes: [{ id: "a", title: null, type: null, degree: 0 }],
      edges: [],
    });
    expect(linksFromCsr(buildCsr(store))).toHaveLength(0);
  });

  it("feeds the engine directly", () => {
    const store = new GraphStore();
    const nodes = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      title: null,
      type: null,
      degree: 2,
    }));
    const edges = nodes.map((n, i) => ({ from: n.id, to: `n${(i + 1) % 12}`, rel: "next" }));
    store.ingest({ nodes, edges });

    const h = makeEngine();
    h.engine.handle({
      type: "data",
      nodeCount: store.order,
      links: linksFromCsr(buildCsr(store)),
    });
    settle(h);
    expect(h.last().n).toBe(12);
    expect(h.last().settled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the module does not wire itself up outside a worker
// ---------------------------------------------------------------------------

describe("worker module", () => {
  it("does not wire itself up outside a worker scope", () => {
    // Every test in this file imported physics.worker.ts on the main thread.
    // The guard at the bottom of that module is what kept it inert — no
    // message handler, no 30Hz interval, no second simulation — which is also
    // what lets physics.ts import its protocol constants safely.
    expect("WorkerGlobalScope" in globalThis).toBe(false);
    expect((globalThis as { onmessage?: unknown }).onmessage ?? null).toBeNull();
  });
});

describe("node collision", () => {
  /**
   * `forceManyBody` is a POINT charge — it knows nothing about how big a node
   * DRAWS, so the simulation considers two nodes "apart" while their circles
   * sit on top of each other. It bites worst where a dense neighbourhood packs
   * nodes of very different degree (and so very different radius) together,
   * which is why most of a graph looks fine and a minority visibly intersects.
   *
   * What this pins is the DIFFERENCE the force makes, measured on one layout
   * run twice. An absolute "nothing ever intersects" would be a lie: a hub
   * with 40 spokes all held at linkDistance cannot geometrically fit them all
   * without touching, and collision is a soft constraint that loses to links
   * when the two genuinely conflict. Reducing the worst intersection by most
   * of its size is the honest, and achievable, claim.
   */
  function cluster(spokes: number): { nodeCount: number; links: Int32Array } {
    const pairs: number[] = [];
    for (let i = 1; i <= spokes; i += 1) {
      pairs.push(0, i); // hub → spoke
      pairs.push(i, (i % spokes) + 1); // spoke → next, closing the ring
    }
    return { nodeCount: spokes + 1, links: Int32Array.from(pairs) };
  }

  /** Worst amount, in world units, that any pair sits inside its own radii. */
  function worstOverlap(e: PhysicsEvent, spokes: number): number {
    const r = (i: number): number => nodeRadius(i === 0 ? spokes : 3);
    let worst = 0;
    for (let a = 0; a < e.n; a += 1) {
      for (let b = a + 1; b < e.n; b += 1) {
        const dx = e.xy[2 * a]! - e.xy[2 * b]!;
        const dy = e.xy[2 * a + 1]! - e.xy[2 * b + 1]!;
        worst = Math.max(worst, r(a) + r(b) - Math.hypot(dx, dy));
      }
    }
    return worst;
  }

  function settleCluster(spokes: number, collideStrength: number): number {
    const { nodeCount, links } = cluster(spokes);
    const h = makeEngine({ forces: { collideStrength } });
    h.engine.handle({ type: "data", nodeCount, links });
    h.scheduler.run(800);
    return worstOverlap(h.last(), spokes);
  }

  it("pulls intersecting circles apart — most of the overlap goes away", () => {
    const spokes = 40;
    const off = settleCluster(spokes, 0);
    const on = settleCluster(spokes, 1);

    // The bug, reproduced: with no collision the circles genuinely intersect.
    expect(off, "collision-off must intersect or this test proves nothing").toBeGreaterThan(5);
    // The fix, measured: most of that intersection is gone.
    expect(on, `overlap ${on.toFixed(1)} vs ${off.toFixed(1)} without collision`).toBeLessThan(
      off * 0.5,
    );
  });

  it("clears completely when the links leave room for it", () => {
    // Eight spokes on the same ring have space to be fully separated, so here
    // the constraint IS satisfiable and collision must satisfy it exactly.
    const spokes = 8;
    expect(settleCluster(spokes, 1)).toBeLessThanOrEqual(0);
  });
});
