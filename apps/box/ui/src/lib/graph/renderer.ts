/**
 * The PixiJS renderer for the graph engine.
 *
 * This file replaces the SVG-with-a-fixed-`1200×800`-viewBox drawing loop in
 * `views/GraphView.tsx`. That viewBox is the reason the current graph looks
 * wrong on a real screen: the simulation is centred on a 1200×800 world that is
 * then letterboxed into whatever the container actually is, so on a wide
 * monitor everything piles into the middle with dead margin either side, and on
 * a narrow one it clips. Here the drawing surface is sized to the ACTUAL
 * container via a `ResizeObserver`, and the camera — not a viewBox — decides
 * what you see.
 *
 * Four rules make this fast enough to be worth moving off SVG for, and each one
 * is a hard constraint rather than a preference:
 *
 *  1. **One texture, N sprites, per-node `tint`.** Every node is a `Sprite`
 *     over ONE shared white-circle `RenderTexture`. `tint` is a per-vertex
 *     attribute inside Pixi's batcher, so colour-by-type costs nothing and the
 *     whole node layer is a handful of draw calls. A `PIXI.Graphics` per node
 *     is FORBIDDEN — that is one draw call each, which is exactly the wall the
 *     SVG version hits at a few hundred nodes.
 *  2. **One `Graphics` for ALL edges**, cleared and rebuilt each frame with
 *     every `moveTo`/`lineTo` in a single path: one geometry, one stroke, one
 *     draw call (two when a highlight splits them into dim and bright passes).
 *  3. **Physics ticks at 30Hz, this renders at 60Hz** by linear interpolation
 *     between the last two `PositionBuffer`s. The worker owns simulation time;
 *     the renderer only ever reads. When the sim settles and nothing is
 *     tweening or moving, the rAF loop STOPS — a settled graph costs ~0% CPU,
 *     and any input wakes it through `invalidate()`.
 *  4. **Nothing is drawn that cannot be seen.** Viewport culling runs over the
 *     position buffer: a linear scan under `LINEAR_SCAN_MAX` nodes (a scan of
 *     10k floats is faster than any structure), a spatial hash above it. The
 *     hash is exported (`GraphRenderer.hash()`, `forEachInRect`) because
 *     box-select and hit testing must ask the same question of the same
 *     structure rather than each growing their own.
 *
 * Pixi itself is imported LAZILY (`await import("pixi.js")` inside
 * `createGraphRenderer`) and only its types are imported statically. That keeps
 * the WebGL bundle out of every route that merely touches graph math, and it
 * keeps this module importable — and therefore unit-testable — in jsdom, where
 * there is no GL context at all.
 */

import type { Application, Container, Graphics, Sprite, Texture } from "pixi.js";

import type { Theme } from "../theme";
import { typeHue } from "../ui";
import { edgeKey, forEachNeighbor } from "./csr";
import { NODE_R_MAX, NODE_R_MIN, nodeRadius } from "./labels";
// `mobile.ts` imports this module's pure camera math back (`clampScale`,
// `screenToWorld`) rather than re-deriving it slightly differently. The cycle
// is function-level on both sides — nothing at module scope in either file
// touches the other — so it resolves cleanly under ESM.
import { TouchGestures, pinchCamera, type GesturePoint } from "./mobile";
import type { CameraState, Csr, GraphNode, HighlightSet, PositionBuffer } from "./types";

/**
 * The node-size spec (`clamp(3, 3 * sqrt(1 + deg), 24) * slider`) and its two
 * bounds live in `labels.ts`, which is the leaf of this pair — the label
 * overlay must place a label at exactly the radius drawn here, so there is one
 * definition and the renderer re-exports it for its existing callers.
 */
export { NODE_R_MAX, NODE_R_MIN, nodeRadius };

/* ------------------------------------------------------------------ *
 * Committed render / legibility constants
 * ------------------------------------------------------------------ */

/** Radius of the shared circle texture, in texture pixels. */
const TEXTURE_R = 32;

export const SCALE_MIN = 0.02;
export const SCALE_MAX = 8;

/** How far `fit` may zoom IN. Zooming out is unbounded (SCALE_MIN); see fit(). */
export const FIT_SCALE_MAX = 2;

/** Below this node count a linear cull scan beats any spatial structure. */
export const LINEAR_SCAN_MAX = 10_000;

/** Cull an edge whose on-screen length is under this many pixels. */
export const EDGE_MIN_PX = 2;

/** Hit testing accepts a click within `r + HIT_SLOP_PX` screen pixels — the
 *  mouse floor. A fingertip is not a cursor: on a coarse pointer most nodes
 *  render as ~3px dots, so a 4px slop leaves a ~10px target well under the 44px
 *  thumb floor the rest of the shell meets, and taps land on the wrong node or
 *  the background. `COARSE_HIT_SLOP_PX` widens the catch radius on touch so a
 *  small dot becomes thumb-reachable; the nearest-node tie-break still resolves
 *  which one a fat catch actually selects. */
const HIT_SLOP_PX = 4;
const COARSE_HIT_SLOP_PX = 18;

/**
 * Is the primary pointer coarse (touch)? Watched LIVE, not cached once: a
 * convertible/2-in-1 (Surface, iPad + keyboard) flips between mouse and touch
 * by folding, and a value latched at the first graph interaction would keep the
 * wrong catch radius — a folded-to-tablet user tapping ~3px dots with the 4px
 * mouse floor, or vice-versa — until a full reload re-probed. This mirrors
 * BlockEditor's `useCoarsePointer`, which subscribes to the same query change.
 */
let coarseMql: MediaQueryList | null = null;
let coarsePointer = false;
function ensureCoarseProbe(): void {
  // Wire the listener once, the first time a real MediaQueryList exists. Where
  // `matchMedia` is absent (jsdom, some webviews) this stays a no-op and the
  // mouse floor is used — the frame that has always shipped.
  if (coarseMql !== null) return;
  try {
    const mql = window.matchMedia?.("(pointer: coarse)");
    if (!mql) return;
    coarseMql = mql;
    coarsePointer = mql.matches;
    mql.addEventListener?.("change", (event) => {
      coarsePointer = event.matches;
    });
  } catch {
    coarsePointer = false;
  }
}
function hitSlopPx(): number {
  ensureCoarseProbe();
  return coarsePointer ? HIT_SLOP_PX + COARSE_HIT_SLOP_PX : HIT_SLOP_PX;
}

/** Fallback link distance; the hash cell is ~2× this (design doc). */
export const DEFAULT_LINK_DISTANCE = 60;

/** Asymmetric dim tween — in fast, out slow, because that reads better. */
const DIM_IN_MS = 140;
const DIM_OUT_MS = 200;

/** Physics period assumed until two buffers have actually been observed. */
const DEFAULT_TICK_MS = 1000 / 30;

/* ------------------------------------------------------------------ *
 * Pure math — exported because the label overlay, box-select, the
 * minimap and the tests all need exactly these and must not re-derive
 * them slightly differently.
 * ------------------------------------------------------------------ */

function clamp(lo: number, v: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Camera scale is clamped so a stray wheel event cannot lose the graph. */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return clamp(SCALE_MIN, scale, SCALE_MAX);
}

/**
 * The scale that frames a `contentW × contentH` layout inside an `availW ×
 * availH` clear rect. Zooming OUT is unbounded (down to SCALE_MIN) — everything
 * has to be on screen. Zooming IN stops at `FIT_SCALE_MAX`: a brain smaller
 * than the viewport used to be magnified up to SCALE_MAX, so a fresh /graph
 * opened on a handful of giant blobs.
 */
export function fitScale(
  contentW: number,
  contentH: number,
  availW: number,
  availH: number,
): number {
  return clampScale(Math.min(availW / contentW, availH / contentH, FIT_SCALE_MAX));
}

/**
 * Where `fit` puts the content's centre on ONE axis, in screen px.
 *
 * The true centre (`extent / 2`) is what reads as centred, so that is the aim.
 * The panels only get to override it to the extent they must: the content's
 * half-size plus the padding must clear the reserved edge at each end, which
 * bounds the centre to `[lead + pad + half, extent - trail - pad - half]`.
 * Clamping the true centre into that band spends whatever slack exists on being
 * centred. When the band is empty (the axis that sized the fit — no slack at
 * all) it collapses to the clear rect's own centre, the old behaviour.
 */
export function fitCenter(
  extent: number,
  lead: number,
  trail: number,
  paddingPx: number,
  half: number,
): number {
  const lo = lead + paddingPx + half;
  const hi = extent - trail - paddingPx - half;
  if (lo > hi) return extent / 2 + (lead - trail) / 2;
  return clamp(lo, extent / 2, hi);
}

/**
 * Normalize a camera read back from a saved view. Persisted values are treated
 * as hostile-shaped (`CameraState` says so) — NaN, Infinity and missing fields
 * all resolve to the identity camera rather than blanking the canvas.
 */
export function normalizeCamera(cam: Partial<CameraState> | null | undefined): CameraState {
  const x = Number(cam?.x);
  const y = Number(cam?.y);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    scale: clampScale(Number(cam?.scale)),
  };
}

/**
 * World → screen. `camera.x/y` is the world point under the CENTRE of the
 * container (see `CameraState`), which is what keeps the same thing on screen
 * when the container resizes.
 */
export function worldToScreen(
  camera: CameraState,
  width: number,
  height: number,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: (x - camera.x) * camera.scale + width / 2,
    y: (y - camera.y) * camera.scale + height / 2,
  };
}

/** Screen → world; the exact inverse of `worldToScreen`. */
export function screenToWorld(
  camera: CameraState,
  width: number,
  height: number,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return {
    x: (sx - width / 2) / camera.scale + camera.x,
    y: (sy - height / 2) / camera.scale + camera.y,
  };
}

/**
 * `clamp(0.06, 8 / sqrt(visibleEdges), 0.35)` — a sparse graph gets crisp
 * lines, a hairball gets a haze that still shows density instead of a solid
 * block of ink.
 */
export function edgeAlpha(visibleEdges: number): number {
  if (!Number.isFinite(visibleEdges) || visibleEdges <= 0) return 0.35;
  return clamp(0.06, 8 / Math.sqrt(visibleEdges), 0.35);
}

/**
 * Interpolation factor between the previous and current position buffers.
 * Clamped to [0, 1]: if the worker stalls we hold the latest frame rather than
 * extrapolating nodes off into space.
 */
export function interpolationFactor(elapsedMs: number, tickMs: number): number {
  const period = Number.isFinite(tickMs) && tickMs > 1 ? tickMs : DEFAULT_TICK_MS;
  return clamp(0, elapsedMs / period, 1);
}

/**
 * Lerp two interleaved xy buffers into `out` (allocation-free; `out` is reused
 * every frame). Buffers of different lengths happen legitimately — a later page
 * of the paged load adds nodes — so the tail beyond the shorter buffer is taken
 * from `next` verbatim, which is where the new nodes are.
 */
export function lerpPositions(
  prev: Float32Array,
  next: Float32Array,
  t: number,
  out: Float32Array,
): Float32Array {
  const n = Math.min(next.length, out.length);
  const shared = Math.min(prev.length, n);
  for (let i = 0; i < shared; i += 1) {
    const a = prev[i]!;
    out[i] = a + (next[i]! - a) * t;
  }
  for (let i = shared; i < n; i += 1) out[i] = next[i]!;
  return out;
}

/** The world-space rectangle currently on screen, plus a margin in world units. */
export interface ViewRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Screen-pixel space the floating controls cover, reserved by `fit`. */
export interface FitInsets {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export function viewRect(
  camera: CameraState,
  width: number,
  height: number,
  marginWorld = 0,
): ViewRect {
  const halfW = width / (2 * camera.scale) + marginWorld;
  const halfH = height / (2 * camera.scale) + marginWorld;
  return {
    minX: camera.x - halfW,
    minY: camera.y - halfH,
    maxX: camera.x + halfW,
    maxY: camera.y + halfH,
  };
}

/**
 * Should this edge be skipped?
 *
 * Two rejections, both O(1):
 *
 *  - **Sub-pixel edges.** Projected length under `EDGE_MIN_PX` is a line you
 *     cannot see; at 5k+ edges these are the bulk of the geometry when zoomed
 *     out, and dropping them is most of the win.
 *  - **Off-screen edges.** The design says "both endpoints offscreen", but the
 *     literal reading also deletes a long edge that CROSSES the viewport with
 *     both ends outside it — a visible line vanishing is a worse bug than a few
 *     extra segments. So the test is the conservative one: reject only when
 *     both endpoints are outside the SAME edge of the view rect, which can
 *     never remove a segment that intersects it.
 */
export function shouldCullEdge(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rect: ViewRect,
  scale: number,
): boolean {
  const dx = (x1 - x0) * scale;
  const dy = (y1 - y0) * scale;
  if (dx * dx + dy * dy < EDGE_MIN_PX * EDGE_MIN_PX) return true;
  if (x0 < rect.minX && x1 < rect.minX) return true;
  if (x0 > rect.maxX && x1 > rect.maxX) return true;
  if (y0 < rect.minY && y1 < rect.minY) return true;
  if (y0 > rect.maxY && y1 > rect.maxY) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

/**
 * Parse the CSS colour tokens the two skins are actually written in — the
 * aurora tokens (`--line`, `--ink-strong`, `--ground`) are plain hex and
 * `rgba()`, which is why they, and not the shadcn `oklch()` tokens, are what
 * this reads. Anything it cannot parse returns null and the caller falls back
 * to a per-skin default, so an unparseable token dims the graph's chrome
 * slightly rather than painting it black on black.
 */
export function parseCssColor(input: string | null | undefined): { rgb: number; a: number } | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      const a = hex.length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
      if ([r, g, b].some(Number.isNaN)) return null;
      return { rgb: (r << 16) | (g << 8) | b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const v = parseInt(hex.slice(0, 6), 16);
      if (Number.isNaN(v)) return null;
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { rgb: v, a: Number.isNaN(a) ? 1 : a };
    }
    return null;
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (!m) return null;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const chan = (raw: string): number => {
    const v = raw.endsWith("%") ? (parseFloat(raw) / 100) * 255 : parseFloat(raw);
    return Number.isFinite(v) ? clamp(0, Math.round(v), 255) : NaN;
  };
  const r = chan(parts[0]!);
  const g = chan(parts[1]!);
  const b = chan(parts[2]!);
  if ([r, g, b].some(Number.isNaN)) return null;
  let a = 1;
  if (parts.length >= 4) {
    const raw = parts[3]!;
    const v = raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
    a = Number.isFinite(v) ? clamp(0, v, 1) : 1;
  }
  return { rgb: (r << 16) | (g << 8) | b, a };
}

/** The non-node colours the graph draws with, resolved per skin. */
interface GraphPalette {
  /** edge stroke */
  edge: number;
  /** multiplies the computed edge alpha — the token's own alpha */
  edgeAlpha: number;
  /** ring around highlighted / hovered nodes */
  ring: number;
  /** thin outline separating overlapping nodes (the page ground colour) */
  ground: number;
}

const PALETTE_FALLBACK: Record<Theme, GraphPalette> = {
  dark: { edge: 0xffffff, edgeAlpha: 0.55, ring: 0xffffff, ground: 0x060608 },
  light: { edge: 0x000000, edgeAlpha: 0.55, ring: 0x000000, ground: 0xffffff },
};

/**
 * Read the skin's tokens off a live element. Both skins work because the
 * tokens, not this file, hold the design — `--line` is `rgba(255,255,255,.08)`
 * in the aurora skin and `rgba(0,0,0,.12)` on paper.
 */
export function readPalette(el: Element | null, theme: Theme): GraphPalette {
  const base = PALETTE_FALLBACK[theme] ?? PALETTE_FALLBACK.dark;
  if (!el || typeof getComputedStyle !== "function") return { ...base };
  let style: CSSStyleDeclaration;
  try {
    style = getComputedStyle(el);
  } catch {
    return { ...base };
  }
  const line = parseCssColor(style.getPropertyValue("--line"));
  const ink = parseCssColor(style.getPropertyValue("--ink-strong"));
  const ground = parseCssColor(style.getPropertyValue("--ground"));
  return {
    edge: line ? line.rgb : base.edge,
    // The token's alpha is very low by design (it is a hairline over paper);
    // the graph re-derives its own alpha from edge count and uses the token's
    // only as a per-skin trim, floored so edges never disappear entirely.
    edgeAlpha: line ? clamp(0.35, line.a * 6, 1) : base.edgeAlpha,
    ring: ink ? ink.rgb : base.ring,
    ground: ground ? ground.rgb : base.ground,
  };
}

/** `#rrggbb` (from `typeHue`) → the packed int Pixi's `tint` wants. */
export function hexToInt(hex: string, fallback = 0x8b8b98): number {
  const parsed = parseCssColor(hex);
  return parsed ? parsed.rgb : fallback;
}

/* ------------------------------------------------------------------ *
 * Spatial hash
 * ------------------------------------------------------------------ */

/**
 * A uniform-grid spatial hash over the position buffer, in the same
 * flat-typed-array style as the CSR: a counting sort into `items`, with
 * `cellStart` as the prefix sums. No per-cell arrays, no Map, nothing to GC at
 * 60Hz.
 *
 * Cell size is ~2× the link distance (design doc), which puts a handful of
 * nodes in a cell for a settled force layout — so a hit test is "this cell plus
 * its 8 neighbours", and a box-select is the cells the box overlaps.
 */
export interface SpatialHash {
  readonly n: number;
  /** world units per cell (may be larger than requested — see `MAX_CELLS`). */
  readonly cell: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  /** length `cols * rows + 1`; cell c owns `items[cellStart[c]..cellStart[c+1])`. */
  readonly cellStart: Int32Array;
  /** dense node indices, bucketed by cell. */
  readonly items: Int32Array;
}

/**
 * Grid cap. A single node flung far from the cluster (which happens early in a
 * simulation) would otherwise demand a grid of millions of cells; the cell size
 * grows instead, which costs a slightly wider scan and never an OOM.
 */
function maxCells(n: number): number {
  return Math.max(64, n * 4);
}

export function buildSpatialHash(
  xy: Float32Array,
  n: number,
  cellSize = DEFAULT_LINK_DISTANCE * 2,
): SpatialHash {
  const count = Math.max(0, Math.min(n, Math.floor(xy.length / 2)));
  if (count === 0) {
    return {
      n: 0,
      cell: Math.max(1, cellSize),
      minX: 0,
      minY: 0,
      cols: 1,
      rows: 1,
      cellStart: new Int32Array(2),
      items: new Int32Array(0),
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const x = xy[2 * i]!;
    const y = xy[2 * i + 1]!;
    // A NaN position is a worker bug, not a reason to poison the whole grid.
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  let cell = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : DEFAULT_LINK_DISTANCE * 2;
  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const cap = maxCells(count);
  let cols = Math.max(1, Math.ceil(w / cell));
  let rows = Math.max(1, Math.ceil(h / cell));
  if (cols * rows > cap) {
    cell *= Math.sqrt((cols * rows) / cap);
    cols = Math.max(1, Math.ceil(w / cell));
    rows = Math.max(1, Math.ceil(h / cell));
  }

  const cellStart = new Int32Array(cols * rows + 1);
  const items = new Int32Array(count);
  const cellOf = new Int32Array(count);

  for (let i = 0; i < count; i += 1) {
    const x = xy[2 * i]!;
    const y = xy[2 * i + 1]!;
    const cx = Number.isFinite(x) ? clamp(0, Math.floor((x - minX) / cell), cols - 1) : 0;
    const cy = Number.isFinite(y) ? clamp(0, Math.floor((y - minY) / cell), rows - 1) : 0;
    const c = cy * cols + cx;
    cellOf[i] = c;
    cellStart[c + 1] = cellStart[c + 1]! + 1;
  }
  for (let c = 0; c < cols * rows; c += 1) cellStart[c + 1] = cellStart[c + 1]! + cellStart[c]!;

  const cursor = new Int32Array(cols * rows);
  for (let c = 0; c < cols * rows; c += 1) cursor[c] = cellStart[c]!;
  for (let i = 0; i < count; i += 1) {
    const c = cellOf[i]!;
    items[cursor[c]!] = i;
    cursor[c] = cursor[c]! + 1;
  }

  return { n: count, cell, minX, minY, cols, rows, cellStart, items };
}

/** Cell column/row for a world point, clamped into the grid. */
function cellCoords(hash: SpatialHash, x: number, y: number): [number, number] {
  const cx = clamp(0, Math.floor((x - hash.minX) / hash.cell), hash.cols - 1);
  const cy = clamp(0, Math.floor((y - hash.minY) / hash.cell), hash.rows - 1);
  return [cx, cy];
}

/**
 * Every node whose position is inside the world rectangle. This is the
 * primitive box-select uses (the marquee is a screen rect converted with
 * `screenToWorld`) and the one viewport culling uses above `LINEAR_SCAN_MAX`.
 * Candidates come from the overlapping cells; each is then tested exactly, so
 * the result is precise, not cell-granular.
 */
export function forEachInRect(
  hash: SpatialHash,
  xy: Float32Array,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  fn: (index: number) => void,
): void {
  if (hash.n === 0) return;
  const x0 = Math.min(minX, maxX);
  const x1 = Math.max(minX, maxX);
  const y0 = Math.min(minY, maxY);
  const y1 = Math.max(minY, maxY);
  const [c0, r0] = cellCoords(hash, x0, y0);
  const [c1, r1] = cellCoords(hash, x1, y1);
  for (let cy = r0; cy <= r1; cy += 1) {
    const base = cy * hash.cols;
    for (let cx = c0; cx <= c1; cx += 1) {
      const c = base + cx;
      const end = hash.cellStart[c + 1]!;
      for (let s = hash.cellStart[c]!; s < end; s += 1) {
        const i = hash.items[s]!;
        const x = xy[2 * i]!;
        const y = xy[2 * i + 1]!;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) fn(i);
      }
    }
  }
}

/**
 * Candidates within `radius` world units of a point: the containing cell plus
 * the ring of cells the radius reaches (the 8 neighbours at the usual radius).
 * Candidates are NOT distance-filtered — the caller compares against each
 * node's own radius, which is what hit testing needs.
 */
export function forEachNear(
  hash: SpatialHash,
  x: number,
  y: number,
  radius: number,
  fn: (index: number) => void,
): void {
  if (hash.n === 0) return;
  const ring = Math.max(1, Math.ceil(Math.max(0, radius) / hash.cell));
  const [cx, cy] = cellCoords(hash, x, y);
  const c0 = Math.max(0, cx - ring);
  const c1 = Math.min(hash.cols - 1, cx + ring);
  const r0 = Math.max(0, cy - ring);
  const r1 = Math.min(hash.rows - 1, cy + ring);
  for (let ry = r0; ry <= r1; ry += 1) {
    const base = ry * hash.cols;
    for (let rx = c0; rx <= c1; rx += 1) {
      const c = base + rx;
      const end = hash.cellStart[c + 1]!;
      for (let s = hash.cellStart[c]!; s < end; s += 1) fn(hash.items[s]!);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

/** What one rendered frame drew — handed to `onFrame` for the label overlay. */
interface FrameInfo {
  camera: CameraState;
  width: number;
  height: number;
  /** interpolated world positions actually drawn this frame (interleaved xy). */
  positions: Float32Array;
  /** world radius per node index. */
  radii: Float32Array;
  /** dense indices inside the viewport, ascending. */
  visible: Int32Array;
  /** edges drawn (post-cull) — what `edgeAlpha` was computed from. */
  visibleEdges: number;
}

interface GraphRendererOptions {
  /** the element the canvas fills; sized by `ResizeObserver`, never a viewBox. */
  container: HTMLElement;
  theme: Theme;
  /** link distance from the layout controls — sets the hash cell (2×). */
  linkDistance?: number;
  /** the node-size slider, 0.5–2. */
  nodeSizeScale?: number;
  /** hover changed (dense index or null). Already hit-tested. */
  onHover?: (index: number | null) => void;
  /** a click that did not pan and did not drag. `index` null = background. */
  onPick?: (index: number | null, event: PointerEvent) => void;
  /** dbl-click on a node — the "open it" gesture. */
  onOpen?: (index: number) => void;
  /**
   * Pointer went down on a node. Return true to CLAIM the gesture (node drag,
   * marquee); the renderer then leaves the camera alone for that gesture.
   */
  onNodePointerDown?: (index: number, event: PointerEvent) => boolean;
  /** camera changed (pan/zoom/fit) — persisted into the saved view. */
  onCamera?: (camera: CameraState) => void;
  /**
   * A finger held still on the canvas — touch's answer to right-click and to
   * every hover-revealed control. `index` is null for the background.
   * Container-local CSS px, so the caller can anchor a sheet or menu.
   */
  onLongPress?: (index: number | null, point: { x: number; y: number }) => void;
  /**
   * Cap on the WebGL backing store (`resolution`). A phone at DPR 3 fills nine
   * times the pixels of a DPR=1 screen for a difference nobody can see at 6
   * inches; `graphBudget` in `mobile.ts` is what decides the number.
   */
  resolution?: number;
  /** MSAA. Off on high-DPR phones, where it costs fill and buys nothing. */
  antialias?: boolean;
  /**
   * Report hover at all. False on touch devices: there is no hover, and a
   * synthesized one would isolate a neighbourhood you never asked about and
   * then leave it isolated with no way to leave.
   */
  hover?: boolean;
  /** after each frame; the label overlay draws from this. */
  onFrame?: (frame: FrameInfo) => void;
}

export interface GraphRenderer {
  /** nodes + adjacency. Dense indices never move, so this merges cheaply. */
  setGraph(nodes: readonly GraphNode[], csr: Csr | null): void;
  /** a new physics tick; becomes the interpolation target. */
  setPositions(buffer: PositionBuffer): void;
  setHighlight(highlight: HighlightSet | null): void;
  setNodeSizeScale(scale: number): void;
  setLinkDistance(distance: number): void;
  setTheme(theme: Theme): void;
  getCamera(): CameraState;
  setCamera(camera: Partial<CameraState>): void;
  /** frame the whole graph in the current container. `insets` (screen px)
   *  reserve the space the floating controls cover so the graph fits into the
   *  region actually visible, not behind the panels. */
  fit(paddingPx?: number, insets?: FitInsets): void;
  screenToWorld(sx: number, sy: number): { x: number; y: number };
  worldToScreen(x: number, y: number): { x: number; y: number };
  /** nearest node within `r + 4px` of a screen point, else null. */
  hitTest(sx: number, sy: number): number | null;
  /** the spatial hash over the positions on screen (built on demand). */
  hash(): SpatialHash;
  /** the interpolated positions currently drawn — box-select tests these. */
  positions(): Float32Array;
  radiusAt(index: number): number;
  visibleNodes(): Int32Array;
  size(): { width: number; height: number };
  /** wake the render loop (after an external change). */
  invalidate(): void;
  /** Subscribe a DOM overlay to fire after each DRAWN frame; returns an
   *  unsubscribe. Fires only while the render loop is awake, so an overlay that
   *  rides it inherits the renderer's idle-CPU budget instead of spinning its
   *  own perpetual rAF. */
  onFrameTick(fn: () => void): () => void;
  destroy(): void;
}

/**
 * Build the renderer. Async because Pixi v8's `Application.init()` is, and
 * because Pixi itself is code-split out of the main bundle here.
 *
 * The caller owns teardown: `destroy()` removes the canvas, disconnects the
 * observer, drops every listener and destroys the texture. Leaking a WebGL
 * context per navigation is how a SPA graph page ends up killing the tab.
 */
export async function createGraphRenderer(options: GraphRendererOptions): Promise<GraphRenderer> {
  /**
   * THE ORDER MATTERS, AND SO DOES THE SECOND IMPORT.
   *
   * Pixi v8 generates its shader-sync, uniform-sync and UBO-sync functions with
   * `new Function` — which is `unsafe-eval`. A box serves the SPA under
   * `script-src 'self'` (apps/box/src/box.ts) and always will: the graph is not
   * a reason to hand every script on the page the ability to compile code from
   * a string, on a product whose whole claim is that the brain does not leave
   * the box.
   *
   * Without the polyfill install, `Application.init()` throws
   * "Current environment does not allow unsafe-eval" and the canvas never
   * starts — so the graph did not render ON A BOX, on any device, desktop
   * included, while rendering perfectly under the dev server (which serves no
   * CSP). `pixi.js/unsafe-eval` swaps every generator for an interpreted
   * equivalent and neuters the two `_unsafeEvalCheck`s.
   *
   * It MUST be installed before `new PIXI.Application()` — the check runs
   * during `init()` — and it is awaited alongside pixi itself so the code-split
   * chunk carries both.
   */
  const [PIXI] = await Promise.all([import("pixi.js"), import("pixi.js/unsafe-eval")]);
  const { container } = options;

  let destroyed = false;
  let theme: Theme = options.theme;
  let palette = readPalette(container, theme);
  let sizeScale = options.nodeSizeScale ?? 1;
  let linkDistance = options.linkDistance ?? DEFAULT_LINK_DISTANCE;

  let width = Math.max(1, container.clientWidth || 1);
  let height = Math.max(1, container.clientHeight || 1);

  const app: Application = new PIXI.Application();
  await app.init({
    width,
    height,
    backgroundAlpha: 0,
    antialias: options.antialias ?? true,
    autoDensity: true,
    autoStart: false,
    resolution: Math.max(
      1,
      Math.min(
        options.resolution ?? Number.POSITIVE_INFINITY,
        typeof window !== "undefined" ? (window.devicePixelRatio ?? 1) : 1,
      ),
    ),
    preference: "webgl",
    powerPreference: "high-performance",
  });
  // Between `await`s the caller may already have unmounted.
  if (destroyed) {
    app.destroy(true, { children: true, texture: true });
    throw new Error("graph renderer destroyed during init");
  }

  app.ticker.stop();
  // We do our own hit testing against the spatial hash; Pixi's event system
  // would walk 50k sprites per pointermove for the same answer.
  app.stage.eventMode = "none";
  app.stage.interactiveChildren = false;

  const canvas = app.canvas as HTMLCanvasElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  // `touch-action: none` is what kills the 300ms tap delay AND stops the page
  // from scrolling or rubber-banding while a finger drags the map;
  // `overscroll-behavior: none` stops a fling at the edge of the canvas from
  // becoming a pull-to-refresh. The tap highlight and text selection are the
  // other two things a browser does to a canvas that only ever look like bugs.
  canvas.style.touchAction = "none";
  canvas.style.overscrollBehavior = "none";
  canvas.style.userSelect = "none";
  canvas.style.setProperty("-webkit-tap-highlight-color", "transparent");
  canvas.style.setProperty("-webkit-user-select", "none");
  container.appendChild(canvas);

  /** The one circle every node sprite shares (rule 1). */
  const circle: Graphics = new PIXI.Graphics()
    .circle(TEXTURE_R, TEXTURE_R, TEXTURE_R)
    .fill(0xffffff);
  const nodeTexture: Texture = app.renderer.generateTexture({
    target: circle,
    resolution: 2,
    antialias: true,
  });
  circle.destroy();

  /** camera → world container transform; sprites live in WORLD coordinates. */
  const world: Container = new PIXI.Container();
  const edgeLayer: Graphics = new PIXI.Graphics();
  const nodeLayer: Container = new PIXI.Container();
  const ringLayer: Graphics = new PIXI.Graphics();
  world.addChild(edgeLayer);
  world.addChild(nodeLayer);
  world.addChild(ringLayer);
  app.stage.addChild(world);

  const camera: CameraState = { x: 0, y: 0, scale: 1 };

  let nodes: readonly GraphNode[] = [];
  let csr: Csr | null = null;
  let sprites: Sprite[] = [];
  let radii = new Float32Array(0);

  // Typed off `PositionBuffer` rather than `new Float32Array(0)`: the worker's
  // buffers are transferables whose backing store TypeScript widens to
  // `ArrayBufferLike`, and a locally-inferred `Float32Array<ArrayBuffer>` will
  // not accept them.
  let prevXY: PositionBuffer["xy"] = new Float32Array(0);
  let nextXY: PositionBuffer["xy"] = new Float32Array(0);
  let renderXY = new Float32Array(0);
  let lastTickAt = 0;
  let tickPeriod = DEFAULT_TICK_MS;
  let settled = false;

  let highlight: HighlightSet | null = null;
  let dimFrom = 0;
  let dimTo = 0;
  let dimStart = 0;
  let dimDuration = DIM_IN_MS;

  let hashCache: SpatialHash | null = null;
  let visible = new Int32Array(0);
  let visibleCount = 0;
  // Per-frame scratch, allocated once and reused: at 60Hz a fresh Uint8Array
  // and a fresh array of segment coordinates every frame is pure GC pressure.
  let shown = new Int32Array(0);
  let shownCount = 0;
  let brightSegments = new Float64Array(0);
  let brightCount = 0;

  let rafId = 0;
  let dirty = true;

  // Overlay listeners called after each DRAWN frame — the DOM overlays (node
  // presence badges) ride the render loop instead of spinning their own rAF, so
  // they too go quiet the moment the graph settles (rule 3: idle ≈ 0% CPU).
  const frameListeners = new Set<() => void>();

  const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

  function invalidate(): void {
    dirty = true;
    schedule();
  }

  function schedule(): void {
    if (destroyed || rafId !== 0) return;
    rafId = requestAnimationFrame(frame);
  }

  /* ---------------- data ---------------- */

  function setGraph(next: readonly GraphNode[], adjacency: Csr | null): void {
    nodes = next;
    csr = adjacency;
    // Dense indices never move (store invariant), so existing sprites are
    // reused and only the tail is created — a later page of the paged load
    // must not rebuild the scene graph the layout has been settling.
    for (let i = sprites.length; i < nodes.length; i += 1) {
      const sprite: Sprite = new PIXI.Sprite(nodeTexture);
      sprite.anchor.set(0.5);
      sprite.visible = false;
      nodeLayer.addChild(sprite);
      sprites.push(sprite);
    }
    for (let i = nodes.length; i < sprites.length; i += 1) sprites[i]!.visible = false;

    if (radii.length < nodes.length) radii = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      radii[i] = nodeRadius(node.degree, sizeScale);
      const sprite = sprites[i]!;
      sprite.tint = hexToInt(typeHue(node.type, theme));
      sprite.scale.set(radii[i]! / TEXTURE_R);
    }
    hashCache = null;
    invalidate();
  }

  function setPositions(buffer: PositionBuffer): void {
    prevXY = nextXY.length > 0 ? nextXY : buffer.xy;
    nextXY = buffer.xy;
    if (renderXY.length !== nextXY.length) renderXY = new Float32Array(nextXY.length);
    const t = now();
    if (lastTickAt > 0) {
      const observed = t - lastTickAt;
      // Smooth the observed physics period so one slow tick does not stutter
      // the interpolation for the next second.
      if (observed > 1 && observed < 500) tickPeriod = tickPeriod * 0.8 + observed * 0.2;
    }
    lastTickAt = t;
    settled = buffer.settled;
    hashCache = null;
    invalidate();
  }

  function setHighlight(next: HighlightSet | null): void {
    highlight = next;
    dimFrom = currentDim();
    dimTo = next ? next.dimAlpha : 1;
    dimDuration = next ? DIM_IN_MS : DIM_OUT_MS;
    dimStart = now();
    invalidate();
  }

  function currentDim(): number {
    if (dimStart === 0) return 1;
    const t = clamp(0, (now() - dimStart) / dimDuration, 1);
    // ease-out cubic
    const e = 1 - Math.pow(1 - t, 3);
    return dimFrom + (dimTo - dimFrom) * e;
  }

  function setNodeSizeScale(scale: number): void {
    sizeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    for (let i = 0; i < nodes.length; i += 1) {
      radii[i] = nodeRadius(nodes[i]!.degree, sizeScale);
      sprites[i]!.scale.set(radii[i]! / TEXTURE_R);
    }
    invalidate();
  }

  function setLinkDistance(distance: number): void {
    linkDistance = Number.isFinite(distance) && distance > 0 ? distance : DEFAULT_LINK_DISTANCE;
    hashCache = null;
    invalidate();
  }

  function setTheme(next: Theme): void {
    theme = next;
    palette = readPalette(container, theme);
    for (let i = 0; i < nodes.length; i += 1) {
      sprites[i]!.tint = hexToInt(typeHue(nodes[i]!.type, theme));
    }
    invalidate();
  }

  /* ---------------- camera ---------------- */

  function getCamera(): CameraState {
    return { ...camera };
  }

  function applyCamera(next: Partial<CameraState>, notify = true): void {
    const normalized = normalizeCamera({ ...camera, ...next });
    if (
      normalized.x === camera.x &&
      normalized.y === camera.y &&
      normalized.scale === camera.scale
    ) {
      return;
    }
    camera.x = normalized.x;
    camera.y = normalized.y;
    camera.scale = normalized.scale;
    if (notify) options.onCamera?.(getCamera());
    invalidate();
  }

  function fit(paddingPx = 48, insets?: FitInsets): void {
    const count = positionedCount();
    if (count === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const x = renderXY[2 * i]!;
      const y = renderXY[2 * i + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const r = radii[i] ?? NODE_R_MIN;
      if (x - r < minX) minX = x - r;
      if (x + r > maxX) maxX = x + r;
      if (y - r < minY) minY = y - r;
      if (y + r > maxY) maxY = y + r;
    }
    if (!Number.isFinite(minX)) return;
    // The floating controls (the left rail, the bottom peek) sit OVER a
    // full-bleed canvas, so "fit" has to aim at the region a member can
    // actually see, not the raw viewport — otherwise a third of the graph fits
    // neatly behind the panel. Insets shrink the target rect and shift its
    // center by the same amount, so the content lands in the clear space.
    const left = insets?.left ?? 0;
    const right = insets?.right ?? 0;
    const top = insets?.top ?? 0;
    const bottom = insets?.bottom ?? 0;
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    const availW = Math.max(width - left - right - paddingPx * 2, 1);
    const availH = Math.max(height - top - bottom - paddingPx * 2, 1);
    const scale = fitScale(w, h, availW, availH);
    // WHERE the framed content sits, as a screen x/y for its center.
    //
    // Centering it in the CLEAR RECT (viewport centre shifted by the insets) is
    // what this used to do, and on a wide pane with only a left rail reserved it
    // parks the map hard against the right edge — visibly off-centre, crowded
    // against whatever lives in that corner. But ignoring the insets and using
    // the raw viewport centre would slide content under the rail.
    //
    // Neither, then: aim for the TRUE centre and give it up only as far as the
    // panels actually force. Content is sized to the clear rect, so the
    // non-constraining axis has real slack — `fitCenter` spends that slack on
    // being centred, and falls back to the clear-rect centre on the axis that
    // has none. On a square-ish graph in a wide pane that is the whole
    // difference between "centred" and "shoved into the corner".
    const halfW = (w * scale) / 2;
    const halfH = (h * scale) / 2;
    const sx = fitCenter(width, left, right, paddingPx, halfW);
    const sy = fitCenter(height, top, bottom, paddingPx, halfH);
    // Screen centre → camera: a world point p draws at width/2 + (p - cam)*scale.
    const cx = (minX + maxX) / 2 - (sx - width / 2) / scale;
    const cy = (minY + maxY) / 2 - (sy - height / 2) / scale;
    applyCamera({ x: cx, y: cy, scale });
  }

  /* ---------------- queries ---------------- */

  /** Nodes that have BOTH a row in the store and a position from the worker. */
  function positionedCount(): number {
    return Math.min(nodes.length, Math.floor(renderXY.length / 2));
  }

  function toWorld(sx: number, sy: number): { x: number; y: number } {
    return screenToWorld(camera, width, height, sx, sy);
  }

  function toScreen(x: number, y: number): { x: number; y: number } {
    return worldToScreen(camera, width, height, x, y);
  }

  function ensureHash(): SpatialHash {
    if (!hashCache) {
      hashCache = buildSpatialHash(renderXY, positionedCount(), Math.max(8, linkDistance * 2));
    }
    return hashCache;
  }

  /**
   * Nearest node whose circle (plus the pointer's slop) contains the point. The
   * hash gives the candidates; the comparison is in SCREEN pixels so the slop
   * means the same thing at every zoom. The slop widens for a coarse (touch)
   * pointer so a fingertip can land on a small dot — see `hitSlopPx`.
   */
  function hitTest(sx: number, sy: number): number | null {
    if (positionedCount() === 0) return null;
    const p = toWorld(sx, sy);
    const slopWorld = hitSlopPx() / camera.scale;
    const maxR = NODE_R_MAX * Math.max(1, sizeScale) + slopWorld;
    let best = -1;
    let bestD = Infinity;
    forEachNear(ensureHash(), p.x, p.y, maxR, (i) => {
      const dx = renderXY[2 * i]! - p.x;
      const dy = renderXY[2 * i + 1]! - p.y;
      const d2 = dx * dx + dy * dy;
      const reach = (radii[i] ?? NODE_R_MIN) + slopWorld;
      if (d2 <= reach * reach && d2 < bestD) {
        bestD = d2;
        best = i;
      }
    });
    return best >= 0 ? best : null;
  }

  /* ---------------- frame ---------------- */

  function cull(rect: ViewRect): void {
    if (visible.length < nodes.length) visible = new Int32Array(nodes.length);
    visibleCount = 0;
    const count = positionedCount();
    if (count <= LINEAR_SCAN_MAX) {
      // A straight scan of the position buffer beats any structure at this
      // size — it is one sequential pass over a Float32Array.
      for (let i = 0; i < count; i += 1) {
        const x = renderXY[2 * i]!;
        const y = renderXY[2 * i + 1]!;
        if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) {
          visible[visibleCount] = i;
          visibleCount += 1;
        }
      }
      return;
    }
    forEachInRect(ensureHash(), renderXY, rect.minX, rect.minY, rect.maxX, rect.maxY, (i) => {
      visible[visibleCount] = i;
      visibleCount += 1;
    });
    // The hash walks cell-major, so restore ascending index order — callers
    // (labels by degree, box-select) assume a stable ordering.
    const slice = visible.subarray(0, visibleCount);
    slice.sort();
  }

  function drawNodes(dim: number): void {
    const hlNodes = highlight?.nodes ?? null;
    // Hide only what was shown LAST frame — sweeping all 50k sprites every
    // frame to set `visible = false` is a per-frame cost proportional to the
    // whole graph, which is exactly what culling exists to avoid.
    for (let k = 0; k < shownCount; k += 1) {
      const sprite = sprites[shown[k]!];
      if (sprite) sprite.visible = false;
    }
    if (shown.length < visible.length) shown = new Int32Array(visible.length);
    shownCount = 0;
    for (let k = 0; k < visibleCount; k += 1) {
      const i = visible[k]!;
      const sprite = sprites[i];
      if (!sprite) continue;
      sprite.visible = true;
      sprite.position.set(renderXY[2 * i]!, renderXY[2 * i + 1]!);
      sprite.alpha = hlNodes && !hlNodes.has(i) ? dim : 1;
      shown[shownCount] = i;
      shownCount += 1;
    }
  }

  /**
   * Every edge in ONE `Graphics` (rule 2): one path built from `moveTo`/
   * `lineTo`, then at most two strokes — dimmed and highlighted. Each
   * undirected edge is walked once (`i < neighbour`), so a pair is not drawn
   * twice; parallel verbs collapse onto the same line, which is what you want
   * visually.
   */
  function drawEdges(rect: ViewRect, dim: number): number {
    edgeLayer.clear();
    if (!csr) return 0;

    const count = positionedCount();

    const hlEdges = highlight?.edges ?? null;
    brightCount = 0;
    let drawn = 0;
    const lineWidth = Math.max(0.6, 1 / camera.scale);

    // NO endpoint-visibility pre-filter here, on purpose. `shouldCullEdge` is
    // deliberately conservative — it rejects an edge only when both endpoints
    // sit outside the SAME side of the view rect, "which can never remove a
    // segment that intersects it" — and a fast path keyed on the node cull's
    // in-view flags defeated exactly that guarantee: an edge whose two
    // endpoints are both off-screen was discarded even when the segment
    // crossed the middle of the screen, so zooming into the corridor between
    // two clusters (the gesture used to inspect how two groups connect) made
    // every inter-cluster edge vanish and the region read as disconnected.
    // The pre-filter saved two array reads per culled edge; shouldCullEdge is
    // itself O(1), so correctness costs almost nothing. (This also means edges
    // draw when NO node is visible — the corridor case exactly.)
    for (let i = 0; i < csr.n && i < count; i += 1) {
      const x0 = renderXY[2 * i]!;
      const y0 = renderXY[2 * i + 1]!;
      forEachNeighbor(csr, i, (j) => {
        if (j <= i || j >= count) return;
        const x1 = renderXY[2 * j]!;
        const y1 = renderXY[2 * j + 1]!;
        if (shouldCullEdge(x0, y0, x1, y1, rect, camera.scale)) return;
        drawn += 1;
        if (hlEdges?.has(edgeKey(i, j))) {
          if (brightCount + 4 > brightSegments.length) {
            const grown = new Float64Array(Math.max(1024, brightSegments.length * 2));
            grown.set(brightSegments);
            brightSegments = grown;
          }
          brightSegments[brightCount] = x0;
          brightSegments[brightCount + 1] = y0;
          brightSegments[brightCount + 2] = x1;
          brightSegments[brightCount + 3] = y1;
          brightCount += 4;
          return;
        }
        edgeLayer.moveTo(x0, y0);
        edgeLayer.lineTo(x1, y1);
      });
    }

    const base = edgeAlpha(drawn) * palette.edgeAlpha;
    // Only stroke when the path actually has segments — everything can be
    // culled (zoomed far out, or a viewport over empty space).
    if (drawn > brightCount / 4) {
      edgeLayer.stroke({
        width: lineWidth,
        color: palette.edge,
        alpha: highlight ? base * dim : base,
      });
    }

    if (brightCount > 0) {
      for (let k = 0; k < brightCount; k += 4) {
        edgeLayer.moveTo(brightSegments[k]!, brightSegments[k + 1]!);
        edgeLayer.lineTo(brightSegments[k + 2]!, brightSegments[k + 3]!);
      }
      edgeLayer.stroke({
        width: lineWidth * 1.8,
        color: palette.ring,
        alpha: clamp(0.3, base * 3, 0.9),
      });
    }
    return drawn;
  }

  /** Rings on highlighted nodes — one `Graphics`, and only when the set is small. */
  function drawRings(): void {
    ringLayer.clear();
    const hl = highlight?.nodes;
    if (!hl || hl.size === 0 || hl.size > 128) return;
    const count = positionedCount();
    let drawn = 0;
    for (const i of hl) {
      if (i < 0 || i >= count) continue;
      const r = (radii[i] ?? NODE_R_MIN) + 2 / camera.scale;
      ringLayer.circle(renderXY[2 * i]!, renderXY[2 * i + 1]!, r);
      drawn += 1;
    }
    if (drawn === 0) return;
    ringLayer.stroke({ width: Math.max(1, 2 / camera.scale), color: palette.ring, alpha: 0.9 });
  }

  function frame(): void {
    rafId = 0;
    if (destroyed) return;

    const t = now();
    const factor = interpolationFactor(t - lastTickAt, tickPeriod);
    const animating = !settled && factor < 1;
    if (nextXY.length > 0) {
      if (renderXY.length !== nextXY.length) renderXY = new Float32Array(nextXY.length);
      lerpPositions(prevXY, nextXY, factor, renderXY);
      // The hash is over what is on screen, so a moved frame stales it.
      if (animating) hashCache = null;
    }

    const dim = currentDim();
    const dimming = Math.abs(dim - dimTo) > 0.001;

    world.scale.set(camera.scale);
    world.position.set(width / 2 - camera.x * camera.scale, height / 2 - camera.y * camera.scale);

    const margin = NODE_R_MAX * Math.max(1, sizeScale);
    const rect = viewRect(camera, width, height, margin);
    cull(rect);
    const drawnEdges = drawEdges(rect, dim);
    drawNodes(dim);
    drawRings();

    app.renderer.render(app.stage);
    dirty = false;

    options.onFrame?.({
      camera: getCamera(),
      width,
      height,
      positions: renderXY,
      radii,
      visible: visible.subarray(0, visibleCount),
      visibleEdges: drawnEdges,
    });
    // After the canvas is drawn, let DOM overlays reposition against the same
    // frame. Only ever called while the loop is awake, so a settled graph fires
    // zero of these.
    for (const listener of frameListeners) {
      try {
        listener();
      } catch (err) {
        console.error("graph: frame listener threw —", err);
      }
    }

    // A settled graph with nothing tweening costs zero frames until something
    // (a tick, a camera move, a hover) calls `invalidate()`.
    if (animating || dimming || dirty) schedule();
  }

  /* ---------------- input ---------------- */

  const pointer = {
    panning: false,
    claimed: false,
    id: -1,
    lastX: 0,
    lastY: 0,
    downX: 0,
    downY: 0,
    moved: false,
  };
  let hovered: number | null = null;

  function localPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const p = localPoint(event);
    const before = toWorld(p.x, p.y);
    // ctrl+wheel is the trackpad pinch gesture; it arrives with big deltas.
    const intensity = event.ctrlKey ? 0.01 : 0.0015;
    const scale = clampScale(camera.scale * Math.exp(-event.deltaY * intensity));
    if (scale === camera.scale) return;
    applyCamera({
      scale,
      x: before.x - (p.x - width / 2) / scale,
      y: before.y - (p.y - height / 2) / scale,
    });
  }

  /* ---- touch ----
   *
   * Touch pointers do NOT go through the mouse path above. Everything that
   * makes the mouse path good — hover isolation, drag-a-node, dbl-click —
   * either does not exist on a phone or actively breaks it, so fingers are
   * handed to the recogniser in `mobile.ts` and come back as five gestures.
   * `touch-action: none` on the canvas (set at construction) is what removes
   * the 300ms tap delay and stops the page scrolling/rubber-banding under the
   * map; the double-tap is recognised from raw timings, never from `dblclick`.
   */

  /**
   * The last touch PointerEvent, handed to `onPick` so its consumer can read
   * `shiftKey` (always false on touch) without the callback contract having to
   * grow a second shape. Never used for coordinates — the gesture carries
   * those, already resolved.
   */
  let lastTouchEvent: PointerEvent | null = null;

  const touch = new TouchGestures((gesture) => {
    switch (gesture.kind) {
      case "pan":
        applyCamera({
          x: camera.x - gesture.dx / camera.scale,
          y: camera.y - gesture.dy / camera.scale,
        });
        return;
      case "pinch":
        applyCamera(pinchCamera(camera, width, height, gesture.from, gesture.to));
        return;
      case "tap": {
        const event = lastTouchEvent;
        if (event !== null) options.onPick?.(hitTest(gesture.x, gesture.y), event);
        return;
      }
      case "doubletap": {
        const hit = hitTest(gesture.x, gesture.y);
        if (hit !== null) {
          options.onOpen?.(hit);
          return;
        }
        // Background double-tap is the phone's "zoom in here" — the gesture
        // every map app has trained every thumb to expect. Anchored on the
        // tap, so the thing you aimed at is the thing you get.
        const before = toWorld(gesture.x, gesture.y);
        const scale = clampScale(camera.scale * 1.8);
        applyCamera({
          scale,
          x: before.x - (gesture.x - width / 2) / scale,
          y: before.y - (gesture.y - height / 2) / scale,
        });
        return;
      }
      case "longpress":
        options.onLongPress?.(hitTest(gesture.x, gesture.y), { x: gesture.x, y: gesture.y });
        return;
    }
  });

  function gesturePoint(event: PointerEvent): GesturePoint {
    const p = localPoint(event);
    return { id: event.pointerId, x: p.x, y: p.y, t: event.timeStamp || now() };
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      lastTouchEvent = event;
      canvas.setPointerCapture?.(event.pointerId);
      touch.down(gesturePoint(event));
      return;
    }
    if (event.button !== 0 && event.button !== 1) return;
    const p = localPoint(event);
    pointer.id = event.pointerId;
    pointer.downX = p.x;
    pointer.downY = p.y;
    pointer.lastX = p.x;
    pointer.lastY = p.y;
    pointer.moved = false;
    pointer.claimed = false;

    const hit = event.button === 0 ? hitTest(p.x, p.y) : null;
    if (hit !== null && options.onNodePointerDown?.(hit, event)) {
      pointer.claimed = true;
      return;
    }
    pointer.panning = true;
    canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      lastTouchEvent = event;
      touch.move(gesturePoint(event));
      return;
    }
    const p = localPoint(event);
    if (pointer.panning && event.pointerId === pointer.id) {
      const dx = p.x - pointer.lastX;
      const dy = p.y - pointer.lastY;
      pointer.lastX = p.x;
      pointer.lastY = p.y;
      if (Math.abs(p.x - pointer.downX) > 3 || Math.abs(p.y - pointer.downY) > 3) {
        pointer.moved = true;
      }
      applyCamera({ x: camera.x - dx / camera.scale, y: camera.y - dy / camera.scale });
      return;
    }
    if (pointer.claimed || options.hover === false) return;
    const hit = hitTest(p.x, p.y);
    if (hit !== hovered) {
      hovered = hit;
      canvas.style.cursor = hit === null ? "grab" : "pointer";
      options.onHover?.(hit);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      lastTouchEvent = event;
      canvas.releasePointerCapture?.(event.pointerId);
      if (event.type === "pointercancel") touch.cancel(event.pointerId);
      else touch.up(gesturePoint(event));
      return;
    }
    if (event.pointerId !== pointer.id) return;
    const wasPanning = pointer.panning;
    const moved = pointer.moved;
    const claimed = pointer.claimed;
    pointer.panning = false;
    pointer.claimed = false;
    pointer.id = -1;
    canvas.releasePointerCapture?.(event.pointerId);
    if (claimed || !wasPanning || moved) return;
    const p = localPoint(event);
    options.onPick?.(hitTest(p.x, p.y), event);
  }

  function onPointerLeave(): void {
    if (hovered !== null) {
      hovered = null;
      options.onHover?.(null);
    }
  }

  function onDoubleClick(event: MouseEvent): void {
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (hit !== null) options.onOpen?.(hit);
  }

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.style.cursor = "grab";

  /* ---------------- sizing ---------------- */

  function resize(w: number, h: number): void {
    const nw = Math.max(1, Math.floor(w));
    const nh = Math.max(1, Math.floor(h));
    if (nw === width && nh === height) return;
    width = nw;
    height = nh;
    app.renderer.resize(width, height);
    invalidate();
  }

  // THE fix for "everything piles into the middle": the drawing surface is the
  // container's real size, tracked live, not a 1200×800 viewBox scaled to fit.
  const observer =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver((entries) => {
          const entry = entries[0];
          if (!entry) return;
          const box = entry.contentRect;
          resize(box.width, box.height);
        })
      : null;
  observer?.observe(container);
  resize(container.clientWidth || width, container.clientHeight || height);

  invalidate();

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (rafId !== 0) cancelAnimationFrame(rafId);
    rafId = 0;
    frameListeners.clear();
    observer?.disconnect();
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("dblclick", onDoubleClick);
    touch.dispose();
    canvas.remove();
    // The shared circle texture is destroyed exactly once, here, and NOT again
    // via `destroy({ texture: true })` — every sprite references this one
    // texture, so the sweep would try to destroy it N times.
    nodeTexture.destroy(true);
    // `true` destroys the canvas-bearing renderer, so the WebGL context is
    // released instead of leaking one per navigation.
    app.destroy(true, { children: true });
    sprites = [];
    nodes = [];
    csr = null;
    hashCache = null;
  }

  return {
    setGraph,
    setPositions,
    setHighlight,
    setNodeSizeScale,
    setLinkDistance,
    setTheme,
    getCamera,
    setCamera: (next) => applyCamera(next),
    fit,
    screenToWorld: toWorld,
    worldToScreen: toScreen,
    hitTest,
    hash: ensureHash,
    positions: () => renderXY,
    radiusAt: (i) => radii[i] ?? NODE_R_MIN,
    visibleNodes: () => visible.subarray(0, visibleCount),
    size: () => ({ width, height }),
    invalidate,
    onFrameTick: (fn) => {
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },
    destroy,
  };
}
