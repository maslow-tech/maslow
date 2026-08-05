import { describe, expect, it } from "vitest";

import {
  DOUBLE_TAP_MS,
  LONG_PRESS_MS,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  TouchGestures,
  budgetReached,
  deviceCapCopy,
  deviceClassOf,
  graphBudget,
  pinchCamera,
  pinchDistance,
  pinchMidpoint,
  readDeviceProfile,
  type DeviceProfile,
  type GesturePoint,
  type PinchPair,
  type TouchGesture,
} from "./mobile";
import { SCALE_MAX, SCALE_MIN, screenToWorld } from "./renderer";
import type { CameraState } from "./types";

/**
 * Three things carry this file, and none of them can be checked by looking at
 * a phone once.
 *
 * The first is the pinch invariant. "It zooms" is not the requirement — the
 * requirement is that the world point between your fingers STAYS between your
 * fingers, including at the zoom clamps, because a pinch that drifts is the
 * single most common way a hand-rolled touch canvas feels broken and the
 * hardest thing to notice on a device you are also holding.
 *
 * The second is that a gesture must not become two gestures. Panning must not
 * also select what happens to be under the last pixel of the pan; a long press
 * must not also fire the tap that its own lift produces; lifting one finger out
 * of a pinch must not select. Every one of those is asserted as an ABSENCE,
 * which is exactly the class of bug that ships when the only test is a thumb.
 *
 * The third is that the mobile performance budget is enforced rather than
 * aspired to. The stated target — ≤1,500 nodes / ≤4,500 edges, ≥30fps median
 * on a 2021-class phone — is only real if `graphBudget` actually caps the walk
 * and the render, so the numbers are pinned here and a weak phone is asserted
 * to get LESS, not the same.
 */

/* ------------------------------------------------------------------ *
 * harness
 * ------------------------------------------------------------------ */

/** A hand-cranked timer, so the long press is deterministic. */
function scheduler() {
  const jobs = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void): unknown => {
      const id = next;
      next += 1;
      jobs.set(id, fn);
      return id;
    },
    clearTimer: (handle: unknown): void => {
      jobs.delete(handle as number);
    },
    /** fire everything currently armed. */
    fire: (): void => {
      for (const [id, fn] of [...jobs]) {
        jobs.delete(id);
        fn();
      }
    },
    pending: (): number => jobs.size,
  };
}

function harness(longPressMs = LONG_PRESS_MS) {
  const emitted: TouchGesture[] = [];
  const clock = scheduler();
  const gestures = new TouchGestures((g) => emitted.push(g), {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    longPressMs,
  });
  return { emitted, clock, gestures, kinds: () => emitted.map((g) => g.kind) };
}

const p = (id: number, x: number, y: number, t: number): GesturePoint => ({ id, x, y, t });

const pair = (a: GesturePoint, b: GesturePoint): PinchPair => ({ a, b });

/* ------------------------------------------------------------------ *
 * pinch math
 * ------------------------------------------------------------------ */

describe("pinch math", () => {
  const camera: CameraState = { x: 12, y: -30, scale: 1.4 };
  const W = 800;
  const H = 600;

  it("measures distance and midpoint", () => {
    const two = pair(p(1, 100, 100, 0), p(2, 100, 140, 0));
    expect(pinchDistance(two)).toBe(40);
    expect(pinchMidpoint(two)).toEqual({ x: 100, y: 120 });
  });

  it("keeps the world point under the midpoint fixed while spreading", () => {
    const from = pair(p(1, 300, 300, 0), p(2, 340, 300, 0));
    const to = pair(p(1, 260, 300, 16), p(2, 380, 300, 16));

    const anchorBefore = screenToWorld(camera, W, H, 320, 300);
    const next = pinchCamera(camera, W, H, from, to);
    const anchorAfter = screenToWorld(next, W, H, 320, 300);

    expect(next.scale).toBeCloseTo(camera.scale * 3, 6); // 40px → 120px
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 6);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 6);
  });

  it("keeps it fixed while pinching in, too", () => {
    const from = pair(p(1, 200, 400, 0), p(2, 400, 400, 0));
    const to = pair(p(1, 275, 400, 16), p(2, 325, 400, 16));

    const before = screenToWorld(camera, W, H, 300, 400);
    const next = pinchCamera(camera, W, H, from, to);
    const after = screenToWorld(next, W, H, 300, 400);

    expect(next.scale).toBeCloseTo(camera.scale * 0.25, 6);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("is a two-finger PAN when the fingers do not spread", () => {
    const from = pair(p(1, 300, 300, 0), p(2, 340, 300, 0));
    const to = pair(p(1, 350, 320, 16), p(2, 390, 320, 16));

    const next = pinchCamera(camera, W, H, from, to);
    expect(next.scale).toBeCloseTo(camera.scale, 6);
    // Fingers moved +50/+20 screen px, so the camera moved the other way, in
    // world units — the map followed the hand.
    expect(next.x).toBeCloseTo(camera.x - 50 / camera.scale, 6);
    expect(next.y).toBeCloseTo(camera.y - 20 / camera.scale, 6);
  });

  it("anchors correctly at the zoom clamp instead of sliding away", () => {
    const hot: CameraState = { x: 0, y: 0, scale: SCALE_MAX };
    const from = pair(p(1, 390, 300, 0), p(2, 410, 300, 0));
    const to = pair(p(1, 200, 300, 16), p(2, 600, 300, 16));

    const next = pinchCamera(hot, 800, 600, from, to);
    expect(next.scale).toBe(SCALE_MAX);
    // The midpoint did not move (400 → 400), so a clamped zoom must leave the
    // camera exactly where it was rather than translating by a scale that was
    // never applied.
    expect(next.x).toBeCloseTo(hot.x, 6);
    expect(next.y).toBeCloseTo(hot.y, 6);
  });

  it("clamps a collapse to zero distance instead of producing NaN", () => {
    const from = pair(p(1, 300, 300, 0), p(2, 300, 300, 0)); // zero distance
    const to = pair(p(1, 200, 300, 16), p(2, 400, 300, 16));
    const next = pinchCamera(camera, W, H, from, to);
    expect(Number.isFinite(next.scale)).toBe(true);
    expect(Number.isFinite(next.x)).toBe(true);
    expect(Number.isFinite(next.y)).toBe(true);
    expect(next.scale).toBeGreaterThanOrEqual(SCALE_MIN);
    expect(next.scale).toBeLessThanOrEqual(SCALE_MAX);
  });
});

/* ------------------------------------------------------------------ *
 * gestures
 * ------------------------------------------------------------------ */

describe("TouchGestures — one finger", () => {
  it("emits a tap for a quick press that does not move", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.up(p(1, 102, 101, 90));
    expect(h.emitted).toEqual([{ kind: "tap", x: 102, y: 101 }]);
  });

  it("does not tap a press held past the tap window", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.up(p(1, 100, 100, TAP_MAX_MS + 50));
    expect(h.kinds()).toEqual([]);
  });

  it("pans by the delta between moves", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.move(p(1, 130, 110, 16));
    h.gestures.move(p(1, 140, 90, 32));
    expect(h.emitted).toEqual([
      { kind: "pan", dx: 30, dy: 10 },
      { kind: "pan", dx: 10, dy: -20 },
    ]);
  });

  it("does NOT also select when a pan ends near where it began", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.move(p(1, 220, 100, 16));
    h.gestures.move(p(1, 101, 100, 120)); // dragged out and back
    h.gestures.up(p(1, 100, 100, 200));
    expect(h.kinds()).toEqual(["pan", "pan"]);
  });

  it("ignores a move for a finger it never saw go down", () => {
    const h = harness();
    h.gestures.move(p(9, 10, 10, 5));
    expect(h.kinds()).toEqual([]);
  });
});

describe("TouchGestures — double tap", () => {
  it("recognises two quick taps in the same place", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.up(p(1, 100, 100, 60));
    h.gestures.down(p(2, 104, 98, 160));
    h.gestures.up(p(2, 104, 98, 210));
    expect(h.kinds()).toEqual(["tap", "doubletap"]);
  });

  it("does not join two taps that are too far apart in time", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.up(p(1, 100, 100, 60));
    const late = DOUBLE_TAP_MS + 200;
    h.gestures.down(p(2, 100, 100, late));
    h.gestures.up(p(2, 100, 100, late + 50));
    expect(h.kinds()).toEqual(["tap", "tap"]);
  });

  it("does not join two taps that are too far apart on the glass", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.up(p(1, 100, 100, 60));
    h.gestures.down(p(2, 300, 100, 140));
    h.gestures.up(p(2, 300, 100, 190));
    expect(h.kinds()).toEqual(["tap", "tap"]);
  });

  it("does not chain a third tap into a second double", () => {
    const h = harness();
    for (const [i, t] of [0, 120, 240].entries()) {
      h.gestures.down(p(i + 1, 100, 100, t));
      h.gestures.up(p(i + 1, 100, 100, t + 40));
    }
    expect(h.kinds()).toEqual(["tap", "doubletap", "tap"]);
  });
});

describe("TouchGestures — long press", () => {
  it("fires after the hold and reports where the finger is", () => {
    const h = harness();
    h.gestures.down(p(1, 210, 90, 0));
    h.clock.fire();
    expect(h.emitted).toEqual([{ kind: "longpress", x: 210, y: 90 }]);
  });

  it("suppresses the tap that the same lift would otherwise produce", () => {
    const h = harness();
    h.gestures.down(p(1, 210, 90, 0));
    h.clock.fire();
    h.gestures.up(p(1, 210, 90, LONG_PRESS_MS + 10));
    expect(h.kinds()).toEqual(["longpress"]);
  });

  it("is cancelled by a finger that moves out of the slop", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.move(p(1, 100 + TAP_SLOP_PX + 5, 100, 40));
    expect(h.clock.pending()).toBe(0);
    h.clock.fire();
    expect(h.kinds()).toEqual(["pan"]);
  });

  it("is cancelled by a second finger arriving", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.down(p(2, 200, 100, 20));
    h.clock.fire();
    expect(h.kinds()).toEqual([]);
  });

  it("is cancelled when the finger lifts before the hold completes", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.up(p(1, 100, 100, 80));
    expect(h.clock.pending()).toBe(0);
    expect(h.kinds()).toEqual(["tap"]);
  });
});

describe("TouchGestures — two fingers", () => {
  it("emits pinches, never pans", () => {
    const h = harness();
    h.gestures.down(p(1, 300, 300, 0));
    h.gestures.down(p(2, 340, 300, 4));
    h.gestures.move(p(1, 280, 300, 20));
    h.gestures.move(p(2, 360, 300, 24));

    expect(h.kinds()).toEqual(["pinch", "pinch"]);
    const first = h.emitted[0];
    if (first?.kind !== "pinch") throw new Error("expected a pinch");
    expect(pinchDistance(first.from)).toBe(40);
    expect(pinchDistance(first.to)).toBe(60);
  });

  it("does not select when one finger of a pinch lifts", () => {
    const h = harness();
    h.gestures.down(p(1, 300, 300, 0));
    h.gestures.down(p(2, 340, 300, 4));
    h.gestures.move(p(1, 280, 300, 20));
    h.gestures.up(p(2, 340, 300, 40));
    h.gestures.up(p(1, 280, 300, 60));
    expect(h.kinds()).toEqual(["pinch"]);
  });

  it("keeps panning with the finger that is still down", () => {
    const h = harness();
    h.gestures.down(p(1, 300, 300, 0));
    h.gestures.down(p(2, 340, 300, 4));
    h.gestures.up(p(2, 340, 300, 40));
    h.gestures.move(p(1, 320, 300, 60));
    expect(h.emitted.at(-1)).toEqual({ kind: "pan", dx: 20, dy: 0 });
  });

  it("interprets nothing at all once a third finger lands", () => {
    const h = harness();
    h.gestures.down(p(1, 300, 300, 0));
    h.gestures.down(p(2, 340, 300, 4));
    h.gestures.down(p(3, 380, 300, 8));
    h.gestures.move(p(1, 200, 300, 20));
    h.gestures.up(p(1, 200, 300, 40));
    expect(h.kinds()).toEqual([]);
  });
});

describe("TouchGestures — cancellation", () => {
  it("emits nothing when the OS takes the gesture", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.cancel(1);
    expect(h.kinds()).toEqual([]);
    expect(h.clock.pending()).toBe(0);
  });

  it("drops its timer on dispose", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.dispose();
    expect(h.clock.pending()).toBe(0);
    expect(h.gestures.active).toBe(0);
  });

  it("recovers to a clean state after a cancel", () => {
    const h = harness();
    h.gestures.down(p(1, 100, 100, 0));
    h.gestures.cancel(1);
    h.gestures.down(p(2, 100, 100, 100));
    h.gestures.up(p(2, 100, 100, 150));
    expect(h.kinds()).toEqual(["tap"]);
  });
});

/* ------------------------------------------------------------------ *
 * device budget
 * ------------------------------------------------------------------ */

const profile = (patch: Partial<DeviceProfile> = {}): DeviceProfile => ({
  width: 1440,
  height: 900,
  dpr: 2,
  coarse: false,
  ...patch,
});

describe("device classification", () => {
  it("calls a mouse machine a desktop whatever its size", () => {
    expect(deviceClassOf(profile({ width: 500, height: 800 }))).toBe("desktop");
  });

  it("calls a 390px phone a phone", () => {
    expect(deviceClassOf(profile({ width: 390, height: 844, coarse: true }))).toBe("phone");
  });

  it("still calls it a phone in landscape", () => {
    // The SHORT edge decides — a rotated iPhone is 844×390, not a tablet.
    expect(deviceClassOf(profile({ width: 844, height: 390, coarse: true }))).toBe("phone");
  });

  it("calls a big touchscreen a tablet", () => {
    expect(deviceClassOf(profile({ width: 1024, height: 1366, coarse: true }))).toBe("tablet");
  });
});

describe("graphBudget", () => {
  it("leaves a desktop alone — the 5,000-node spec target is untouched", () => {
    const budget = graphBudget(profile());
    expect(budget.device).toBe("desktop");
    expect(budget.pageSize).toBe(5000);
    expect(budget.maxNodes).toBeGreaterThanOrEqual(50_000);
    expect(budget.hoverIsolation).toBe(true);
    expect(budget.antialias).toBe(true);
  });

  it("holds a phone to the stated 1,500-node / 4,500-edge target", () => {
    const budget = graphBudget(profile({ width: 390, height: 844, dpr: 3, coarse: true }));
    expect(budget.device).toBe("phone");
    expect(budget.maxNodes).toBe(1500);
    expect(budget.maxEdges).toBe(4500);
    expect(budget.pageSize).toBe(1500);
  });

  it("gives a weak phone LESS, not the same", () => {
    const strong = graphBudget(
      profile({ width: 390, height: 844, dpr: 3, coarse: true, cores: 8 }),
    );
    const weak = graphBudget(
      profile({ width: 390, height: 844, dpr: 3, coarse: true, cores: 4, memoryGb: 2 }),
    );
    expect(weak.maxNodes).toBeLessThan(strong.maxNodes);
    expect(weak.maxEdges).toBeLessThan(strong.maxEdges);
    expect(weak.labelCap).toBeLessThan(strong.labelCap);
  });

  it("caps the backing store on a high-DPR phone and drops MSAA", () => {
    const budget = graphBudget(profile({ width: 390, height: 844, dpr: 3, coarse: true }));
    expect(budget.resolution).toBe(1.5);
    expect(budget.antialias).toBe(false);
  });

  it("keeps MSAA where pixels are big enough to alias", () => {
    const budget = graphBudget(profile({ width: 390, height: 844, dpr: 1, coarse: true }));
    expect(budget.antialias).toBe(true);
    expect(budget.resolution).toBe(1);
  });

  it("turns hover isolation off wherever there is no hover", () => {
    expect(graphBudget(profile({ width: 390, height: 844, coarse: true })).hoverIsolation).toBe(
      false,
    );
    expect(graphBudget(profile({ width: 1024, height: 1366, coarse: true })).hoverIsolation).toBe(
      false,
    );
  });

  it("thins the label pass on touch devices", () => {
    const desktop = graphBudget(profile());
    const phone = graphBudget(profile({ width: 390, height: 844, coarse: true }));
    expect(phone.labelCap).toBeLessThan(desktop.labelCap);
    expect(phone.labelCap).toBeGreaterThan(0);
  });
});

describe("budgetReached", () => {
  const phone = graphBudget(profile({ width: 390, height: 844, coarse: true }));

  it("is false while there is room", () => {
    expect(budgetReached(phone, 100, 200)).toBe(false);
  });

  it("trips on nodes", () => {
    expect(budgetReached(phone, phone.maxNodes, 0)).toBe(true);
  });

  it("trips on edges alone — a small, dense graph is still too much fill", () => {
    expect(budgetReached(phone, 10, phone.maxEdges)).toBe(true);
  });
});

describe("deviceCapCopy", () => {
  it("says the number, the reason and the fix — never sampling in silence", () => {
    const phone = graphBudget(profile({ width: 390, height: 844, coarse: true }));
    const copy = deviceCapCopy(phone, 1500);
    expect(copy).toContain("1,500");
    expect(copy).toContain("this phone");
    expect(copy).toMatch(/filter by type or date/);
    expect(copy).toMatch(/larger screen/);
    // The device cap stops an ascending-uuid keyset walk early (reader.ts
    // graphFull `ORDER BY v.id`), so the slice is arbitrary — the copy must NOT
    // claim "most-connected" (that ranking belongs to the server truncation
    // path only). It must instead admit it is a partial view.
    expect(copy).not.toMatch(/most.connected/i);
    expect(copy).toMatch(/partial view/);
  });
});

describe("readDeviceProfile", () => {
  it("reads the live window without throwing in jsdom", () => {
    const live = readDeviceProfile();
    expect(live.width).toBeGreaterThan(0);
    expect(live.height).toBeGreaterThan(0);
    expect(live.dpr).toBeGreaterThan(0);
    expect(typeof live.coarse).toBe("boolean");
  });
});
