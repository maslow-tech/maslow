import { describe, expect, it } from "vitest";

import { buildCsr, forEachNeighbor } from "./csr";
import { LABEL_SETTLE_MS, nodeRadius, selectLabels } from "./labels";
import { linksFromCsr } from "./physics";
import {
  DEFAULT_FORCES,
  PHYSICS_TICK_HZ,
  PhysicsEngine,
  type PhysicsEvent,
  type TickScheduler,
} from "./physics.worker";
import {
  LINEAR_SCAN_MAX,
  buildSpatialHash,
  clampScale,
  forEachInRect,
  shouldCullEdge,
  viewRect,
  type SpatialHash,
  type ViewRect,
} from "./renderer";
import { GraphStore } from "./store";
import type { CameraState, Csr, GraphEdge, GraphNode } from "./types";

/**
 * The GATING graph performance benchmark.
 *
 * This file exists because "the graph felt fine on my laptop" is not a test.
 * The performance budget is 5,000 nodes / 15,000 edges, sustained
 * ≥ 55fps median with no frame over 33ms at the 95th percentile during a
 * continuous 10s pan+zoom, initial layout settled in ≤ 4s, idle CPU ≈ 0% once
 * settled — and this file FAILS THE BUILD when the number regresses, rather
 * than printing a measurement nobody reads.
 *
 * ## Why the assertion is split
 *
 * CI has no GPU. A frame-rate assertion on a swiftshader/llvmpipe (or absent)
 * WebGL context measures the software rasterizer, not our code: it would be
 * simultaneously too slow to pass and too noisy to trust, and the first green
 * build would come from someone raising the threshold until it passed. So the
 * criterion is decomposed into the two things that ARE ours and ARE portable:
 *
 *  1. **Worker tick time** — the physics engine's per-tick cost, measured on
 *     the real d3 simulation with the shipped force parameters. This is the
 *     thing that makes a laptop fan audible.
 *  2. **Per-frame main-thread CPU work** — culling, edge geometry build, and
 *     label selection, mirroring `drawEdges`/`cull` in renderer.ts step for
 *     step, driven along a real 10s pan+zoom camera path. This is everything
 *     the frame costs us before Pixi hands anything to the GPU.
 *
 * Both are gated against budgets DERIVED from the 33ms cap (see BUDGETS), and
 * the whole-frame frame-rate assertion is kept behind `GRAPH_BENCH_GPU=1` for
 * a local, GPU-capable run. Passing the CPU gates does not prove 55fps; failing
 * them proves we can no longer reach it, which is what a gate is for.
 *
 * ## Where 55fps IS proven
 *
 * This file is a PROXY and says so; for a while it was also the only thing that
 * looked at performance at all, which made the committed budget a number
 * nobody had measured. The real assertion now lives in
 * `apps/box/ui/e2e/workspace.spec.ts` ("holds the frame budget during a 10s
 * pan+zoom at the committed scale"): a real browser, a real compositor, real
 * `requestAnimationFrame` deltas sampled WHILE the camera is being driven, at
 * the budgeted 5,000 nodes / 15,000 edges (seeded by
 * `BRAIN_DEV_GRAPH_SCALE`, and the test SKIPS rather than pretending when the
 * box is not seeded at scale). Measured 2026-07-22 on an M-series laptop:
 * 8.3ms median, 10ms p95 over 1,202 frames — against budgets of 18.2ms and
 * 33ms. Keep both: this one fails fast and everywhere, that one is the truth.
 *
 * ## The idle criterion
 *
 * "Idle CPU ≈ 0% once settled" is measured exactly, not approximately: below
 * `alphaMin` the engine must cancel its own clock, so the assertion is ZERO
 * further ticks and ZERO further emitted buffers after the settle. A sim that
 * keeps ticking at alpha 1e-9 looks identical on screen and costs a core
 * forever — that is the regression this catches.
 *
 * ## GRAPH_FULL_MAX
 *
 * The server's `GRAPH_FULL_MAX` (5,000) is not an independent constant: it is
 * THIS benchmark's node count. The threshold moves only when this benchmark
 * moves with it — i.e. when the 20,000/60,000 stretch below stops being
 * "measured but not gating" and becomes a gate. Raising GRAPH_FULL_MAX without
 * raising GATING_NODES here ships a graph size nothing has ever measured.
 *
 * ## Where the numbers stood when this landed (M-series, 2026-07-21)
 *
 *   worker tick (5k)   median 14.3ms  p95 15.5ms   270 ticks → rest in 9.0s
 *                      first 4s of ticks cost 1.7s of CPU (budget 4s)
 *   frame CPU  (5k)    median 0.46ms  p95 0.74ms   peak 15,000 edges drawn
 *   worker tick (20k)  median 73.7ms  — over the 30Hz interval, which is
 *                      exactly why 20k is not gating: the layout clock cannot
 *                      keep pace there and the graph settles in slow motion.
 *   frame CPU  (20k)   median 2.26ms  p95 3.02ms
 *
 * The frame-CPU budgets have a lot of headroom against those numbers, and that
 * is deliberate: they are the CRITERION, not a high-water mark. A gate pinned
 * to "yesterday's measurement plus 20%" fails on every legitimate feature and
 * gets deleted; this one fails when we can no longer hit the number we sold.
 */

/* ------------------------------------------------------------------ *
 * The committed numbers
 * ------------------------------------------------------------------ */

/** The gating graph. Equal to the server's `GRAPH_FULL_MAX` by construction. */
const GATING_NODES = 5_000;
const GATING_EDGES = 15_000;

/** Measured, reported, and deliberately NOT gating. */
const STRETCH_NODES = 20_000;
const STRETCH_EDGES = 60_000;

/** The continuous pan+zoom from the criterion: 10s at 60fps. */
const PAN_SECONDS = 10;
const PAN_FPS = 60;
const PAN_FRAMES = PAN_SECONDS * PAN_FPS;

/** A representative canvas — a maximized graph page on a 16" laptop. */
const VIEW_W = 1440;
const VIEW_H = 900;

/**
 * Every budget below is derived from the two numbers in the criterion, so the
 * derivation is auditable instead of being folk-lore constants:
 *
 *   FRAME_CAP_MS    33.3  the p95 cap, stated
 *   FRAME_MEDIAN_MS 18.2  1000/55, the median
 *   CPU_SHARE       0.5   the share of a frame the MAIN THREAD may spend on
 *                         our own work. The other half is Pixi's draw call
 *                         submission, the compositor and browser overhead. A
 *                         renderer that spends a whole 18ms frame in JS has
 *                         nothing left for the GPU and misses the median.
 */
const FRAME_CAP_MS = 1000 / 30;
const FRAME_MEDIAN_MS = 1000 / 55;
const CPU_SHARE = 0.5;

/**
 * Slack multiplier for slower CI hardware. Default 1 — the budgets are the
 * budgets. This exists so a runner-class change is a ONE-LINE, REVIEWED
 * decision recorded in CI config, not a silent threshold bump inside this file.
 * If you find yourself raising it to make a red build green, the build is
 * telling you the truth.
 */
const SLACK = Number(process.env.GRAPH_BENCH_SLACK ?? "1") || 1;

const BUDGETS = {
  /** median main-thread frame work */
  frameCpuMedianMs: FRAME_MEDIAN_MS * CPU_SHARE * SLACK,
  /** p95 main-thread frame work */
  frameCpuP95Ms: FRAME_CAP_MS * CPU_SHARE * SLACK,
  /**
   * Median physics tick. The hard constraint is the 30Hz interval itself — a
   * tick that takes longer than 33.3ms means the layout clock cannot keep pace
   * — so the median budget is 75% of it, leaving room for the spikes a real
   * machine has without letting the average drift into falling behind.
   */
  tickMedianMs: (1000 / PHYSICS_TICK_HZ) * 0.75 * SLACK,
  /** p95 physics tick — a tick over the interval means the clock falls behind */
  tickP95Ms: (1000 / PHYSICS_TICK_HZ) * SLACK,
  /** the ≤4s-to-legible window, in CPU ms (see LEGIBLE_TICKS) */
  legibleMs: 4_000 * SLACK,
  /** the layout must come to REST inside this wall-clock window */
  restSeconds: 10,
} as const;

/**
 * "Initial layout settled in ≤ 4s" is a WALL-CLOCK statement about what the
 * user sees, and the shipped alphaDecay does not reach `alphaMin` in 4s — it
 * reaches it in ~270 ticks ≈ 9s at 30Hz, which is the documented
 * ≤4s-to-legible / ≤10s-to-rest split (see physics.test.ts). Asserting "total
 * settle CPU ≤ 4000ms" would therefore be gating a coincidence: it passes with
 * ~4% margin on an M-series laptop purely because ~270 ticks × ~14ms lands
 * just under 4s, and it would fail on any slower machine while telling you
 * nothing about what a user sees.
 *
 * So the criterion is asserted as what it actually means: through the first 4
 * seconds the simulation KEEPS REAL-TIME PACE (4s of wall clock buys 4s of
 * ticks, so the layout the user is watching is 4s along and legible), and the
 * whole thing comes to rest inside the 10s window. A regression that makes
 * ticks slower shows up as the clock falling behind, which is the real failure.
 */
const LEGIBLE_TICKS = Math.round(4 * PHYSICS_TICK_HZ);

/** Local, GPU-capable opt-in for the whole-frame frame-rate assertion. */
const GPU = process.env.GRAPH_BENCH_GPU === "1";

/* ------------------------------------------------------------------ *
 * Deterministic graph generation
 * ------------------------------------------------------------------ */

/** A tiny LCG — the same graph on every machine, on every run, forever. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const TYPES = ["person", "company", "deal", "note", "task", null] as const;
const RELS = ["works_at", "mentions", "owns", "blocks", "about"] as const;

interface Generated {
  nodes: GraphNode[];
  edges: GraphEdge[];
  store: GraphStore;
  csr: Csr;
  degrees: Int32Array;
}

/**
 * A graph shaped like a real brain, not like a lattice: a spanning tree (so
 * there are no orphan islands to accidentally cull for free) plus preferential
 * attachment for the rest, which produces the heavy-tailed degree distribution
 * that makes hub rendering and label ranking cost what they really cost. A
 * uniform random graph would understate both.
 */
function makeGraph(nodeCount: number, edgeCount: number, seed = 0x5eed): Generated {
  const rand = lcg(seed);
  const degrees = new Int32Array(nodeCount);
  const edges: GraphEdge[] = [];
  const seen = new Set<number>();
  // Endpoint bag: an index appears once per half-edge, so drawing from it is
  // preferential attachment with no cumulative-sum scan.
  const bag: number[] = [0];

  const idOf = (i: number): string => `obj_${i}`;

  const link = (a: number, b: number): boolean => {
    if (a === b) return false;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * nodeCount + hi;
    if (seen.has(key)) return false;
    seen.add(key);
    edges.push({
      from: idOf(a),
      to: idOf(b),
      rel: RELS[Math.floor(rand() * RELS.length)] ?? "mentions",
    });
    degrees[a] = degrees[a]! + 1;
    degrees[b] = degrees[b]! + 1;
    bag.push(a, b);
    return true;
  };

  // 1. spanning tree — connected, no isolates.
  for (let i = 1; i < nodeCount; i += 1) {
    link(i, bag[Math.floor(rand() * bag.length)] ?? 0);
  }
  // 2. preferential attachment up to the edge count, with a bounded retry so a
  //    saturated pair can never spin.
  let guard = 0;
  while (edges.length < edgeCount && guard < edgeCount * 20) {
    guard += 1;
    const a = bag[Math.floor(rand() * bag.length)] ?? 0;
    const b = Math.floor(rand() * nodeCount);
    link(a, b);
  }

  const nodes: GraphNode[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    nodes.push({
      id: idOf(i),
      // A seventh of a real brain is untitled; the label path must pay for the
      // id-shortening fallback too.
      title: i % 7 === 0 ? null : `Object ${i} — generated benchmark fixture`,
      type: TYPES[i % TYPES.length] ?? null,
      degree: degrees[i]!,
    });
  }

  const store = new GraphStore();
  store.ingest({ nodes, edges });
  return { nodes, edges, store, csr: buildCsr(store), degrees };
}

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

/** Sorted-copy percentile. `p` in [0,1]. */
function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

const median = (samples: readonly number[]): number => percentile(samples, 0.5);

interface Stats {
  median: number;
  p95: number;
  max: number;
  total: number;
  count: number;
}

function stats(samples: readonly number[]): Stats {
  return {
    median: median(samples),
    p95: percentile(samples, 0.95),
    max: samples.length === 0 ? 0 : Math.max(...samples),
    total: samples.reduce((a, b) => a + b, 0),
    count: samples.length,
  };
}

function report(label: string, s: Stats, extra: Record<string, number | string> = {}): void {
  const bits = Object.entries(extra)
    .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(2) : v}`)
    .join(" ");
  // Reported on every run: a gate that only speaks when it fails leaves nobody
  // any idea how much headroom is left.
  console.info(
    `[graph-perf] ${label}: n=${s.count} median=${s.median.toFixed(2)}ms ` +
      `p95=${s.p95.toFixed(2)}ms max=${s.max.toFixed(2)}ms total=${s.total.toFixed(0)}ms ${bits}`.trim(),
  );
}

/* ------------------------------------------------------------------ *
 * Physics harness (a manual clock, so the settle is measured at full speed)
 * ------------------------------------------------------------------ */

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

  /** One tick. Returns false if the engine has cancelled its own clock. */
  tick(): boolean {
    if (!this.active || this.fn === null) return false;
    this.fn();
    return true;
  }
}

interface SettleResult {
  ticks: number;
  samples: number[];
  events: number;
  finalXY: Float32Array;
  settledFlag: boolean;
  alpha: number;
  scheduler: ManualScheduler;
  engine: PhysicsEngine;
}

/**
 * Run a cold layout to rest, timing every tick. Buffers are handed straight
 * back (what the real main thread does two ticks later), so the pool is
 * exercised exactly as in production — a benchmark that never recycles would
 * measure an allocation path we do not ship.
 */
function settleLayout(g: Generated, maxTicks: number): SettleResult {
  const scheduler = new ManualScheduler();
  let events = 0;
  let finalXY = new Float32Array(0);
  let settledFlag = false;

  const engine = new PhysicsEngine((event: PhysicsEvent) => {
    events += 1;
    settledFlag = event.settled === true;
    finalXY = Float32Array.from(event.xy);
    engine.handle({ type: "release", xy: event.xy });
  }, scheduler);

  engine.handle({
    type: "data",
    nodeCount: g.nodes.length,
    links: linksFromCsr(g.csr),
  });

  const samples: number[] = [];
  let ticks = 0;
  while (ticks < maxTicks) {
    const t0 = performance.now();
    const ran = scheduler.tick();
    const dt = performance.now() - t0;
    if (!ran) break;
    ticks += 1;
    samples.push(dt);
  }

  return {
    ticks,
    samples,
    events,
    finalXY,
    settledFlag,
    alpha: engine.alpha,
    scheduler,
    engine,
  };
}

/* ------------------------------------------------------------------ *
 * Frame harness — the main-thread work of one rendered frame
 * ------------------------------------------------------------------ */

/**
 * The camera path. A continuous pan+zoom, never at rest, sweeping from a
 * zoomed-out overview (most edges sub-pixel, culling does the work) into a
 * zoomed-in neighbourhood (few nodes visible, labels all on) and back. The
 * worst case for us is the middle of that sweep, which is why the path crosses
 * it repeatedly rather than sitting at either end.
 */
function cameraAt(t: number, span: number): CameraState {
  return {
    x: Math.sin(t * 0.9) * span * 0.28,
    y: Math.cos(t * 0.7) * span * 0.28,
    scale: clampScale(0.42 + 0.34 * Math.sin(t * 0.55)),
  };
}

/** Bounding span of a settled layout, for a camera path that stays on it. */
function worldSpan(xy: Float32Array, n: number): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const x = xy[2 * i]!;
    const y = xy[2 * i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return 1000;
  return Math.max(maxX - minX, maxY - minY, 1);
}

interface FrameHarness {
  /** One frame's main-thread work: cull + edge geometry. Time it outside. */
  frame: (camera: CameraState) => void;
  /** The 100ms-debounced label pass, on its own cadence. */
  labels: (camera: CameraState, visibleCount: number) => void;
  /** live counters, for the report and the sanity assertions */
  drawnEdges: number;
  visibleNodes: number;
  labelPasses: number;
}

/**
 * Mirrors `cull` + `drawEdges` + the label pass from renderer.ts / labels.ts,
 * minus the Pixi calls. Kept deliberately step-for-step with the renderer: if
 * this drifts from the real frame it stops measuring the real frame, so any
 * change to `cull`/`drawEdges` must land here in the same commit.
 */
function makeFrameHarness(g: Generated, xy: Float32Array): FrameHarness {
  const n = g.nodes.length;
  const csr = g.csr;
  const visible = new Int32Array(n);
  // Pre-sized: the renderer grows this once and then never again, so growth is
  // not part of the steady-state frame it is meant to measure.
  const segments = new Float64Array(4 * g.edges.length);
  const radii = new Float32Array(n);
  for (let i = 0; i < n; i += 1) radii[i] = nodeRadius(g.degrees[i]!, 1);

  // The hash is built on demand and cached while positions hold still, exactly
  // as `ensureHash` does; a settled graph rebuilds it zero times.
  let hash: SpatialHash | null = null;
  const ensureHash = (): SpatialHash => {
    hash ??= buildSpatialHash(xy, n, 120);
    return hash;
  };

  const h: FrameHarness = {
    drawnEdges: 0,
    visibleNodes: 0,
    labelPasses: 0,
    frame: (camera: CameraState): void => {
      const rect: ViewRect = viewRect(camera, VIEW_W, VIEW_H, 24);

      // --- cull (renderer.ts `cull`) -------------------------------------
      let visibleCount = 0;
      if (n <= LINEAR_SCAN_MAX) {
        for (let i = 0; i < n; i += 1) {
          const x = xy[2 * i]!;
          const y = xy[2 * i + 1]!;
          if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) {
            visible[visibleCount] = i;
            visibleCount += 1;
          }
        }
      } else {
        forEachInRect(ensureHash(), xy, rect.minX, rect.minY, rect.maxX, rect.maxY, (i) => {
          visible[visibleCount] = i;
          visibleCount += 1;
        });
        visible.subarray(0, visibleCount).sort();
      }

      // --- edge geometry (renderer.ts `drawEdges`) -----------------------
      // No endpoint-visibility pre-filter, mirroring the renderer: the flags
      // fast path deleted edges that CROSS the viewport with both ends
      // off-screen, so the real draw loop dropped it — and this harness must
      // measure the same (slightly larger) workload the renderer now pays.
      let drawn = 0;
      let write = 0;
      for (let i = 0; i < csr.n && i < n; i += 1) {
        const x0 = xy[2 * i]!;
        const y0 = xy[2 * i + 1]!;
        forEachNeighbor(csr, i, (j) => {
          if (j <= i || j >= n) return;
          const x1 = xy[2 * j]!;
          const y1 = xy[2 * j + 1]!;
          if (shouldCullEdge(x0, y0, x1, y1, rect, camera.scale)) return;
          drawn += 1;
          if (write + 4 <= segments.length) {
            segments[write] = x0;
            segments[write + 1] = y0;
            segments[write + 2] = x1;
            segments[write + 3] = y1;
            write += 4;
          }
        });
      }

      h.drawnEdges = drawn;
      h.visibleNodes = visibleCount;
    },
    labels: (camera: CameraState, visibleCount: number): void => {
      h.labelPasses += 1;
      selectLabels({
        visible: visible.subarray(0, visibleCount),
        cameraScale: camera.scale,
        threshold: 0.5,
        radiusOf: (i) => radii[i] ?? 3,
        degreeOf: (i) => g.degrees[i] ?? 0,
      });
    },
  };
  return h;
}

interface PanResult {
  frames: number[];
  labelPasses: number;
  peakEdges: number;
  peakVisible: number;
}

/**
 * The 10s continuous pan+zoom, frame by frame. Label selection runs on its real
 * 100ms debounce (once every `LABEL_SETTLE_MS`), because charging every frame
 * for it would be measuring something we do not ship — and never charging for
 * it would hide a label regression entirely.
 */
function runPan(g: Generated, xy: Float32Array, frames: number, warmup = 30): PanResult {
  const harness = makeFrameHarness(g, xy);
  const span = worldSpan(xy, g.nodes.length);
  const labelEveryNFrames = Math.max(1, Math.round((LABEL_SETTLE_MS / 1000) * PAN_FPS));

  // Warm-up frames are run and DISCARDED: the first few passes measure the JIT
  // compiling our loops, not the loops.
  for (let f = 0; f < warmup; f += 1) harness.frame(cameraAt(f / PAN_FPS, span));

  const samples: number[] = [];
  let peakEdges = 0;
  let peakVisible = 0;
  for (let f = 0; f < frames; f += 1) {
    const camera = cameraAt(f / PAN_FPS, span);
    const t0 = performance.now();
    harness.frame(camera);
    if (f % labelEveryNFrames === 0) harness.labels(camera, harness.visibleNodes);
    samples.push(performance.now() - t0);
    if (harness.drawnEdges > peakEdges) peakEdges = harness.drawnEdges;
    if (harness.visibleNodes > peakVisible) peakVisible = harness.visibleNodes;
  }

  return { frames: samples, labelPasses: harness.labelPasses, peakEdges, peakVisible };
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

describe("graph performance — GATING (5,000 nodes / 15,000 edges)", () => {
  it("settles a cold layout inside the CPU budget, then stops ticking entirely", () => {
    const g = makeGraph(GATING_NODES, GATING_EDGES);
    expect(g.nodes.length).toBe(GATING_NODES);
    expect(g.edges.length).toBe(GATING_EDGES);

    // Cap well above the ~270 ticks the shipped alphaDecay needs, so a
    // never-settling regression fails on the settle assertions below rather
    // than hanging the run.
    // One discarded settle on a small graph first: the very first tick of a
    // process pays for JIT-compiling d3's force loops (~40ms here), which is
    // a benchmark artifact, not something a user pays twice.
    settleLayout(makeGraph(300, 900, 0xbeef), 400);

    const settled = settleLayout(g, 2_000);
    const s = stats(settled.samples);
    const restSeconds = settled.ticks / PHYSICS_TICK_HZ;
    const legibleCpuMs = settled.samples
      .slice(0, LEGIBLE_TICKS)
      .reduce((a: number, b: number) => a + b, 0);
    report("worker tick (5k)", s, {
      ticks: settled.ticks,
      restSeconds: restSeconds.toFixed(1),
      legibleCpuMs,
    });

    // 1. it actually settles, and says so.
    expect(settled.settledFlag).toBe(true);
    expect(settled.alpha).toBeLessThan(DEFAULT_FORCES.alphaMin);

    // 2. ≤4s-to-legible: the first 4 seconds of ticks cost less than 4
    //    seconds, i.e. the sim keeps real-time pace and the layout the user
    //    is watching is genuinely 4s along.
    expect(settled.ticks).toBeGreaterThanOrEqual(LEGIBLE_TICKS);
    expect(legibleCpuMs).toBeLessThanOrEqual(BUDGETS.legibleMs);

    // 3. ≤10s-to-rest, and the clock never falls behind on the way there.
    expect(restSeconds).toBeLessThanOrEqual(BUDGETS.restSeconds);
    expect(s.total).toBeLessThanOrEqual(restSeconds * 1000 * SLACK);

    // 4. per-tick cost leaves the 30Hz clock able to keep up.
    expect(s.median).toBeLessThanOrEqual(BUDGETS.tickMedianMs);
    expect(s.p95).toBeLessThanOrEqual(BUDGETS.tickP95Ms);

    // 5. idle CPU ≈ 0%: below alphaMin the clock is CANCELLED. Measured as
    //    zero further ticks and zero further emitted buffers — not as "alpha
    //    is small", which a spinning sim also satisfies.
    expect(settled.scheduler.running).toBe(false);
    const eventsAtRest = settled.events;
    for (let i = 0; i < 200; i += 1) expect(settled.scheduler.tick()).toBe(false);
    expect(settled.events).toBe(eventsAtRest);
  }, 120_000);

  it("holds the per-frame CPU budget through a continuous 10s pan+zoom", () => {
    const g = makeGraph(GATING_NODES, GATING_EDGES);
    const settled = settleLayout(g, 2_000);
    expect(settled.settledFlag).toBe(true);

    const pan = runPan(g, settled.finalXY, PAN_FRAMES);
    const s = stats(pan.frames);
    report("frame CPU (5k)", s, {
      peakEdges: pan.peakEdges,
      peakVisible: pan.peakVisible,
      labelPasses: pan.labelPasses,
      headroomFps: 1000 / Math.max(s.median / CPU_SHARE, 0.001),
    });

    expect(s.count).toBe(PAN_FRAMES);
    // The label pass really ran on its debounce — a zero here would mean the
    // frame budget was measured without it.
    expect(pan.labelPasses).toBeGreaterThan(PAN_SECONDS * 5);
    // And the pan really moved over the graph rather than off it.
    expect(pan.peakVisible).toBeGreaterThan(0);
    expect(pan.peakEdges).toBeGreaterThan(0);

    expect(s.median).toBeLessThanOrEqual(BUDGETS.frameCpuMedianMs);
    expect(s.p95).toBeLessThanOrEqual(BUDGETS.frameCpuP95Ms);
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * Stretch — measured, reported, NOT gating
 * ------------------------------------------------------------------ */

describe("graph performance — STRETCH (20,000 / 60,000), measured not gating", () => {
  it("reports the stretch numbers against the ≥30fps target without gating on them", () => {
    const g = makeGraph(STRETCH_NODES, STRETCH_EDGES, 0xb1_6bee);

    // A bounded prefix of the settle, not the whole thing: the stretch is a
    // measurement, and a full 20k settle would add a minute to every build
    // for a number nothing depends on.
    const settled = settleLayout(g, 60);
    const tick = stats(settled.samples);
    report("worker tick (20k)", tick, { ticks: settled.ticks });

    const pan = runPan(g, settled.finalXY, 180, 10);
    const frame = stats(pan.frames);
    const estimatedFps = 1000 / Math.max(frame.median / CPU_SHARE, 0.001);
    report("frame CPU (20k)", frame, {
      peakEdges: pan.peakEdges,
      peakVisible: pan.peakVisible,
      estimatedFps,
      target: "30fps (not gating)",
    });

    // The ONLY assertions here are that the measurement happened. The 30fps
    // stretch target is deliberately not enforced: gating on it would either
    // block a shipping graph or get silently relaxed, and the honest state of
    // the world is "we measure it and we know where it stands".
    expect(Number.isFinite(estimatedFps)).toBe(true);
    expect(frame.count).toBe(180);
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * The whole-frame assertion — local / GPU-capable only
 * ------------------------------------------------------------------ */

/**
 * The real thing: a Pixi renderer on a real GPU, driven by real rAF for 10s of
 * pan+zoom, asserting the criterion verbatim (≥55fps median, no frame over
 * 33ms at p95). Runs only with `GRAPH_BENCH_GPU=1` — see the header for why it
 * cannot be the CI gate. Run it before any change that touches the render loop:
 *
 *   GRAPH_BENCH_GPU=1 pnpm --filter @brain/box-ui test -- perf.bench
 */
describe.runIf(GPU)("graph performance — whole frame (GRAPH_BENCH_GPU=1)", () => {
  it("sustains ≥55fps median with no frame over 33ms at p95", async () => {
    const { createGraphRenderer } = await import("./renderer");
    const g = makeGraph(GATING_NODES, GATING_EDGES);
    const settled = settleLayout(g, 2_000);

    const container = document.createElement("div");
    container.style.width = `${VIEW_W}px`;
    container.style.height = `${VIEW_H}px`;
    document.body.appendChild(container);

    const deltas: number[] = [];
    let lastFrameAt = 0;
    const renderer = await createGraphRenderer({
      container,
      theme: "dark",
      onFrame: () => {
        const t = performance.now();
        if (lastFrameAt > 0) deltas.push(t - lastFrameAt);
        lastFrameAt = t;
      },
    });

    try {
      renderer.setGraph(g.nodes, g.csr);
      renderer.setPositions({
        n: g.nodes.length,
        xy: settled.finalXY,
        tick: settled.ticks,
        alpha: 0,
        settled: true,
      });
      renderer.fit();

      const span = worldSpan(settled.finalXY, g.nodes.length);
      await new Promise<void>((resolve) => {
        const start = performance.now();
        const step = (): void => {
          const elapsed = performance.now() - start;
          if (elapsed >= PAN_SECONDS * 1000) {
            resolve();
            return;
          }
          renderer.setCamera(cameraAt(elapsed / 1000, span));
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    } finally {
      renderer.destroy();
      container.remove();
    }

    // Drop the first second: context warm-up, texture upload and the first
    // sprite allocation are a load cost, not a steady-state frame cost.
    const steady = deltas.slice(PAN_FPS);
    const s = stats(steady);
    report("whole frame (5k, GPU)", s, { fps: 1000 / Math.max(s.median, 0.001) });

    expect(s.count).toBeGreaterThan(PAN_SECONDS * 30);
    expect(1000 / s.median).toBeGreaterThanOrEqual(55);
    expect(s.p95).toBeLessThanOrEqual(FRAME_CAP_MS);
  }, 180_000);
});
