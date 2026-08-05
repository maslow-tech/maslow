/**
 * The phone half of the graph: touch gestures, and an honest performance
 * budget for the device actually holding them.
 *
 * Two things live here, and they are here together because they are the same
 * decision seen from two sides — "what can a finger do to this canvas" and
 * "what can this canvas afford to draw for that finger".
 *
 * ## Gestures
 *
 * The renderer's mouse path (drag to pan, hover to isolate, dbl-click to open,
 * pointer-down on a node to drag it) does not survive contact with a phone:
 * there is no hover, `dblclick` on touch is late and unreliable, and a
 * one-finger drag that starts on a node would mean you can never pan a dense
 * graph. So touch pointers are routed through `TouchGestures` instead, which
 * recognises exactly five things:
 *
 * - **one finger down and moving → pan.** Always the camera, never a node
 *   drag: dragging a node is a mouse affordance and is deliberately not
 *   offered on touch (you cannot see what you would be grabbing under your own
 *   thumb).
 * - **two fingers → pinch zoom + pan together**, anchored on the midpoint, so
 *   the world point between your fingers stays between your fingers.
 * - **tap → select** (the mouse's click).
 * - **double-tap → open** (the mouse's dbl-click), recognised HERE from raw
 *   pointer timing rather than from the DOM's `dblclick`, so there is no
 *   300ms click delay and no dependence on synthesized mouse events.
 * - **long press → the node menu** (the mouse's right-click / hover chrome).
 *
 * Everything is fed plain `{id, x, y, t}` records and emits plain gesture
 * objects, with timers injected — so the whole state machine is unit-testable
 * with no DOM, no jsdom pointer-event polyfill, and no fake canvas.
 *
 * ## Budget
 *
 * A phone is not a small laptop: it has roughly a tenth of the GPU fill rate,
 * a thermal budget measured in seconds, and (at DPR 3) nine times the pixels
 * per CSS px to fill. The desktop target from the spec — 5,000 nodes / 15,000
 * edges at ≥55fps — is not reachable there and pretending otherwise produces a
 * page that "works" by melting.
 *
 * **Stated mobile target: ≤1,500 nodes / ≤4,500 edges, ≥30fps median during a
 * continuous pan+zoom, on a 2021-class phone (A14 / Snapdragon 7-series) at
 * DPR ≤ 2.** `graphBudget` is how that target is enforced rather than hoped
 * for: it caps the walk, caps the render resolution, drops antialiasing on
 * low-DPR devices where it buys nothing visible, and thins the label pass.
 * When the cap bites, the view SAYS SO in plain words (the same doctrine as
 * server-side truncation) — silent sampling is never an option.
 */

import { clampScale, screenToWorld } from "./renderer";
import type { CameraState } from "./types";

/* ------------------------------------------------------------------ *
 * gesture constants
 * ------------------------------------------------------------------ */

/** A finger that stays inside this many px is still "in one place". */
export const TAP_SLOP_PX = 12;

/** Longer than this and a lift is not a tap — it was a hold you gave up on. */
export const TAP_MAX_MS = 500;

/** Two taps closer together than this are one double-tap. */
export const DOUBLE_TAP_MS = 320;

/** …and no further apart than this. Fingers are not mice: 32px, not 4. */
const DOUBLE_TAP_SLOP_PX = 32;

/** Hold this long without moving and you get the node menu. */
export const LONG_PRESS_MS = 480;

/* ------------------------------------------------------------------ *
 * gesture types
 * ------------------------------------------------------------------ */

/** One finger, in container-local CSS pixels. */
export interface GesturePoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** event timestamp in ms. */
  readonly t: number;
}

/** Two fingers at one instant — a pinch is the delta between two of these. */
export interface PinchPair {
  readonly a: GesturePoint;
  readonly b: GesturePoint;
}

export type TouchGesture =
  | { readonly kind: "pan"; readonly dx: number; readonly dy: number }
  | { readonly kind: "pinch"; readonly from: PinchPair; readonly to: PinchPair }
  | { readonly kind: "tap"; readonly x: number; readonly y: number }
  | { readonly kind: "doubletap"; readonly x: number; readonly y: number }
  | { readonly kind: "longpress"; readonly x: number; readonly y: number };

interface TouchGesturesOptions {
  /** injected so tests drive the long press without wall-clock time. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly longPressMs?: number;
}

/* ------------------------------------------------------------------ *
 * pinch math
 * ------------------------------------------------------------------ */

export function pinchDistance(pair: PinchPair): number {
  return Math.hypot(pair.a.x - pair.b.x, pair.a.y - pair.b.y);
}

export function pinchMidpoint(pair: PinchPair): { x: number; y: number } {
  return { x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 };
}

/**
 * The camera after a pinch step.
 *
 * The invariant, and the only thing that makes a pinch feel like a pinch: the
 * world point that was under the midpoint of your fingers is under the
 * midpoint of your fingers afterwards. That covers the pan half for free — two
 * fingers sliding without spreading move the map exactly as one finger would —
 * so pinch and two-finger pan are ONE gesture, not two fighting each other.
 *
 * The scale is clamped FIRST and the translation solved against the clamped
 * value, so at the zoom limits the map stops growing instead of sliding out
 * from under your fingers.
 */
export function pinchCamera(
  camera: CameraState,
  width: number,
  height: number,
  from: PinchPair,
  to: PinchPair,
): CameraState {
  const d0 = pinchDistance(from);
  const d1 = pinchDistance(to);
  const ratio = d0 > 0 && Number.isFinite(d0) && Number.isFinite(d1) ? d1 / d0 : 1;
  const scale = clampScale(camera.scale * (ratio > 0 ? ratio : 1));

  const was = pinchMidpoint(from);
  const anchor = screenToWorld(camera, width, height, was.x, was.y);
  const mid = pinchMidpoint(to);
  return {
    scale,
    x: anchor.x - (mid.x - width / 2) / scale,
    y: anchor.y - (mid.y - height / 2) / scale,
  };
}

/* ------------------------------------------------------------------ *
 * the recogniser
 * ------------------------------------------------------------------ */

type Mode = "idle" | "pan" | "pinch" | "spent";

/**
 * A touch state machine over raw pointer records.
 *
 * `spent` is the mode a gesture enters once it can no longer become a tap (it
 * panned, it pinched, it long-pressed, or a third finger joined). Lifting out
 * of `spent` emits nothing — which is what stops "pan then lift" from also
 * selecting whatever happened to be under the last pixel of the pan, the
 * single most common way a hand-rolled touch layer feels broken.
 */
export class TouchGestures {
  private readonly emit: (gesture: TouchGesture) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly longPressMs: number;

  private readonly points = new Map<number, GesturePoint>();
  private mode: Mode = "idle";
  private start: GesturePoint | null = null;
  /** the finger left the tap slop at some point — so the lift is not a tap. */
  private panned = false;
  private lastPinch: PinchPair | null = null;
  private lastTap: GesturePoint | null = null;
  private timer: unknown = null;

  constructor(emit: (gesture: TouchGesture) => void, options: TouchGesturesOptions = {}) {
    this.emit = emit;
    this.setTimer =
      options.setTimer ?? ((fn, ms) => (typeof setTimeout === "function" ? setTimeout(fn, ms) : 0));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => {
        if (typeof clearTimeout === "function")
          clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.longPressMs = options.longPressMs ?? LONG_PRESS_MS;
  }

  /** Fingers currently down. The renderer reads this to know touch is driving. */
  get active(): number {
    return this.points.size;
  }

  down(point: GesturePoint): void {
    this.points.set(point.id, point);
    if (this.points.size === 1) {
      this.mode = "pan";
      this.start = point;
      this.panned = false;
      this.armLongPress(point);
      return;
    }
    this.cancelLongPress();
    if (this.points.size === 2) {
      this.mode = "pinch";
      this.lastPinch = this.pair();
      return;
    }
    // Three fingers is not a gesture this canvas has; it is also not an
    // accident worth guessing at. Stop interpreting until the hand lifts.
    this.mode = "spent";
    this.lastPinch = null;
  }

  move(point: GesturePoint): void {
    const previous = this.points.get(point.id);
    if (previous === undefined) return;
    this.points.set(point.id, point);

    if (this.mode === "pan" && this.points.size === 1) {
      const from = this.start;
      if (from !== null && Math.hypot(point.x - from.x, point.y - from.y) > TAP_SLOP_PX) {
        this.panned = true;
        this.cancelLongPress();
      }
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      if (dx !== 0 || dy !== 0) this.emit({ kind: "pan", dx, dy });
      return;
    }

    if (this.mode === "pinch" && this.points.size >= 2) {
      const to = this.pair();
      const from = this.lastPinch;
      this.lastPinch = to;
      if (from !== null) this.emit({ kind: "pinch", from, to });
    }
  }

  up(point: GesturePoint): void {
    const held = this.points.get(point.id);
    this.points.delete(point.id);
    this.cancelLongPress();

    if (this.mode === "pan" && !this.panned && held !== undefined && this.start !== null) {
      const from = this.start;
      const still = Math.hypot(point.x - from.x, point.y - from.y) <= TAP_SLOP_PX;
      const quick = point.t - from.t <= TAP_MAX_MS;
      if (still && quick) this.tapped(point);
    }

    if (this.points.size === 1) {
      // A pinch that lost a finger becomes a one-finger pan — but NOT a
      // pending tap: your hand has been on the glass the whole time.
      this.mode = "pan";
      this.start = null;
      this.panned = true;
      this.lastPinch = null;
      return;
    }
    if (this.points.size === 0) this.reset();
  }

  /** The OS took the gesture (a scroll took over, a call came in). Emit nothing. */
  cancel(pointerId: number): void {
    this.points.delete(pointerId);
    this.cancelLongPress();
    if (this.points.size === 0) this.reset();
    else this.mode = "spent";
  }

  /** Drop timers on unmount. */
  dispose(): void {
    this.cancelLongPress();
    this.points.clear();
    this.reset();
  }

  private tapped(point: GesturePoint): void {
    const previous = this.lastTap;
    const isDouble =
      previous !== null &&
      point.t - previous.t <= DOUBLE_TAP_MS &&
      Math.hypot(point.x - previous.x, point.y - previous.y) <= DOUBLE_TAP_SLOP_PX;
    if (isDouble) {
      this.lastTap = null;
      this.emit({ kind: "doubletap", x: point.x, y: point.y });
      return;
    }
    this.lastTap = point;
    this.emit({ kind: "tap", x: point.x, y: point.y });
  }

  private armLongPress(point: GesturePoint): void {
    this.cancelLongPress();
    this.timer = this.setTimer(() => {
      this.timer = null;
      // Only if that finger is still the only one down and still where it was.
      const current = this.points.get(point.id);
      if (current === undefined || this.points.size !== 1) return;
      if (Math.hypot(current.x - point.x, current.y - point.y) > TAP_SLOP_PX) return;
      this.mode = "spent";
      this.lastTap = null;
      this.emit({ kind: "longpress", x: current.x, y: current.y });
    }, this.longPressMs);
  }

  private cancelLongPress(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private pair(): PinchPair {
    const ordered = [...this.points.values()].sort((p, q) => p.id - q.id);
    const a = ordered[0]!;
    const b = ordered[1] ?? a;
    return { a, b };
  }

  private reset(): void {
    this.mode = "idle";
    this.start = null;
    this.panned = false;
    this.lastPinch = null;
  }
}

/* ------------------------------------------------------------------ *
 * device budget
 * ------------------------------------------------------------------ */

/** What we know about the machine drawing the graph. */
export interface DeviceProfile {
  /** viewport CSS px. */
  readonly width: number;
  readonly height: number;
  /** `devicePixelRatio`. */
  readonly dpr: number;
  /** `(pointer: coarse)` — a finger, not a mouse. */
  readonly coarse: boolean;
  /** `navigator.hardwareConcurrency`, when the browser admits to one. */
  readonly cores?: number | undefined;
  /** `navigator.deviceMemory` in GB, Chromium-only. */
  readonly memoryGb?: number | undefined;
}

export type DeviceClass = "desktop" | "tablet" | "phone";

/** The caps a device class earns. Every number here is enforced, not advisory. */
export interface GraphBudget {
  readonly device: DeviceClass;
  /** stop the paged walk once this many nodes are loaded. */
  readonly maxNodes: number;
  /** …or this many edges, whichever bites first. */
  readonly maxEdges: number;
  /** rows per page — smaller pages paint sooner on a slow radio. */
  readonly pageSize: number;
  /** cap on the renderer's backing-store resolution. */
  readonly resolution: number;
  /** MSAA is a real cost per pixel and invisible under a thumb at DPR 3. */
  readonly antialias: boolean;
  /** how many labels the 2D overlay may draw at once. */
  readonly labelCap: number;
  /** hover isolation (`onHover` dimming) — meaningless without a pointer. */
  readonly hoverIsolation: boolean;
}

const DESKTOP_BUDGET: Omit<GraphBudget, "device"> = {
  maxNodes: 50_000,
  maxEdges: 200_000,
  pageSize: 5000,
  resolution: 2,
  antialias: true,
  labelCap: 200,
  hoverIsolation: true,
};

/**
 * Classify the device. Coarse pointer decides touch-vs-mouse (a touchscreen
 * laptop still has a mouse, so `coarse` alone is not "phone"); the SHORTER
 * viewport edge decides size, so a landscape phone is still a phone.
 */
export function deviceClassOf(profile: DeviceProfile): DeviceClass {
  const min = Math.min(profile.width, profile.height);
  if (!profile.coarse) return "desktop";
  if (min < 600) return "phone";
  return "tablet";
}

/**
 * The budget for a device. Phones get the stated ≤1,500-node / ≤4,500-edge
 * target; a phone that also reports few cores or little memory (a cheap or old
 * one — the machine most likely to be someone's only computer) is halved again
 * rather than left to thermal-throttle its way to a slideshow.
 */
export function graphBudget(profile: DeviceProfile): GraphBudget {
  const device = deviceClassOf(profile);
  if (device === "desktop") return { device, ...DESKTOP_BUDGET };

  if (device === "tablet") {
    return {
      device,
      maxNodes: 4000,
      maxEdges: 12_000,
      pageSize: 2000,
      resolution: Math.min(2, Math.max(1, profile.dpr)),
      antialias: profile.dpr < 2,
      labelCap: 80,
      hoverIsolation: false,
    };
  }

  const weak =
    (profile.cores !== undefined && profile.cores > 0 && profile.cores <= 4) ||
    (profile.memoryGb !== undefined && profile.memoryGb > 0 && profile.memoryGb <= 4);
  return {
    device,
    maxNodes: weak ? 750 : 1500,
    maxEdges: weak ? 2250 : 4500,
    pageSize: weak ? 750 : 1500,
    // DPR 3 at 60fps is ~2.6× the fill of DPR 2 for a difference no one can
    // see on a 6" panel. 1.5 is the honest ceiling on a phone.
    resolution: Math.min(1.5, Math.max(1, profile.dpr)),
    // Antialiasing earns its cost only where pixels are big enough to alias.
    antialias: profile.dpr < 1.5,
    labelCap: weak ? 16 : 28,
    hoverIsolation: false,
  };
}

/** Read the live device, defensively — any missing API means "assume desktop". */
export function readDeviceProfile(): DeviceProfile {
  if (typeof window === "undefined") {
    return { width: 1440, height: 900, dpr: 1, coarse: false };
  }
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return {
    width: window.innerWidth || 1440,
    height: window.innerHeight || 900,
    dpr: window.devicePixelRatio ?? 1,
    coarse:
      typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)").matches
        : false,
    cores: nav?.hardwareConcurrency,
    memoryGb: (nav as { deviceMemory?: number } | undefined)?.deviceMemory,
  };
}

/** True once the walk has taken all this device is going to be given. */
export function budgetReached(budget: GraphBudget, nodes: number, edges: number): boolean {
  return nodes >= budget.maxNodes || edges >= budget.maxEdges;
}

/**
 * The device-cap sentence. Same doctrine as the server's truncation copy: say
 * the number, name the reason, and attach the fix — never sample in silence.
 *
 * NOT "most-connected": unlike the server's >GRAPH_FULL_MAX truncation (which
 * ranks `ORDER BY degree DESC`), the device cap stops the keyset walk early on
 * the whole-brain pages, which the server orders `ORDER BY v.id` (reader.ts
 * graphFull) — an ascending-uuid slice, i.e. an ARBITRARY subset. Claiming
 * "most-connected" here would promise a ranking the data does not carry, so the
 * copy says only that this is a partial view.
 */
export function deviceCapCopy(budget: GraphBudget, shown: number): string {
  const where = budget.device === "phone" ? "this phone" : "this device";
  return (
    `showing ${shown.toLocaleString()} objects — ` +
    `${where} caps the map here to stay smooth, so this is a partial view; ` +
    `filter by type or date, or open the graph on a larger screen, to see the rest`
  );
}
