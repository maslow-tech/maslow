import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LABEL_CAP,
  LABEL_MIN_SCREEN_RADIUS,
  LabelOverlay,
  createSettleDebounce,
  fitText,
  labelAlpha,
  labelTextFor,
  nodeRadius,
  selectLabels,
  smoothstep,
} from "./labels";
import type { LabelDrawItem, TextMeasurer } from "./labels";

/**
 * What this file is defending.
 *
 * The label layer is the only part of the graph engine where a wrong answer is
 * invisible in code review and obvious on screen: too many labels and the graph
 * is mush, too few and it is a dot plot, and a truncation guessed from a
 * character count is wrong in a different direction for every font. So the four
 * committed rules — the smoothstep fade, the 6px screen-radius floor, the K=200
 * cap by descending degree, the 100ms camera-settle debounce — are asserted
 * directly, along with the two properties that keep them from *looking* broken:
 * the ranking is stable under ties (an unstable tie-break makes labels flicker
 * between two equal-degree nodes on every recompute), and forced labels (search
 * matches) survive a zero fade alpha, because a highlighted match nobody names
 * has told the user nothing.
 */

// A deterministic stand-in for canvas text metrics: 6px per character, 3px for
// the ellipsis. jsdom has no 2D context, and a test that depends on the host's
// font rasteriser is a test that fails on someone else's laptop.
const measure: TextMeasurer = (text) => {
  let w = 0;
  for (const ch of text) w += ch === "…" ? 3 : 6;
  return w;
};

describe("smoothstep / labelAlpha", () => {
  it("is clamped, monotone and S-curved between the edges", () => {
    expect(smoothstep(1, 2, 0.5)).toBe(0);
    expect(smoothstep(1, 2, 1)).toBe(0);
    expect(smoothstep(1, 2, 2)).toBe(1);
    expect(smoothstep(1, 2, 9)).toBe(1);
    expect(smoothstep(1, 2, 1.5)).toBeCloseTo(0.5, 6);
    // strictly increasing across the ramp
    let prev = -1;
    for (let x = 1; x <= 2; x += 0.05) {
      const v = smoothstep(1, 2, x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("degenerates to a step when the edges collapse", () => {
    expect(smoothstep(0, 0, 0)).toBe(1);
    expect(smoothstep(2, 2, 1.5)).toBe(0);
    expect(smoothstep(2, 2, 2)).toBe(1);
  });

  it("fades in over [t, t*1.6] — the committed threshold curve", () => {
    expect(labelAlpha(1, 0.9)).toBe(0);
    expect(labelAlpha(1, 1)).toBe(0);
    expect(labelAlpha(1, 1.3)).toBeCloseTo(0.5, 6);
    expect(labelAlpha(1, 1.6)).toBe(1);
    expect(labelAlpha(1, 4)).toBe(1);
  });
});

describe("nodeRadius", () => {
  it("clamps to [3, 24] and grows with sqrt(degree)", () => {
    expect(nodeRadius(0)).toBe(3);
    expect(nodeRadius(-5)).toBe(3);
    expect(nodeRadius(3)).toBeCloseTo(6, 6);
    expect(nodeRadius(10_000)).toBe(24);
    expect(nodeRadius(3, 2)).toBeCloseTo(12, 6);
  });
});

describe("selectLabels", () => {
  const degrees = (i: number) => i; // node i has degree i
  const base = {
    threshold: 1,
    cameraScale: 2, // alpha === 1
    radiusOf: () => 10,
    degreeOf: degrees,
  };

  it("draws nothing below the fade threshold", () => {
    const out = selectLabels({ ...base, cameraScale: 0.5, visible: [1, 2, 3] });
    expect(out.alpha).toBe(0);
    expect(out.indices).toEqual([]);
  });

  it("skips nodes whose SCREEN radius is at or under the floor", () => {
    // world radius 3 at scale 2 == 6px screen, which is not > 6.
    const out = selectLabels({
      ...base,
      radiusOf: (i) => (i === 1 ? 3 : 10),
      visible: [0, 1, 2],
    });
    expect(out.indices).not.toContain(1);
    expect(out.indices).toEqual([2, 0]);
    expect(LABEL_MIN_SCREEN_RADIUS).toBe(6);
  });

  it("caps at K = 200 keeping the highest degrees", () => {
    const visible = Array.from({ length: 500 }, (_, i) => i);
    const out = selectLabels({ ...base, visible });
    expect(LABEL_CAP).toBe(200);
    expect(out.indices).toHaveLength(200);
    expect(out.droppedToCap).toBe(300);
    expect(out.indices[0]).toBe(499);
    expect(Math.min(...out.indices)).toBe(300);
  });

  it("breaks degree ties by index, so the set is stable across recomputes", () => {
    const visible = [7, 3, 9, 1];
    const flat = { ...base, degreeOf: () => 5 };
    const a = selectLabels({ ...flat, visible });
    const b = selectLabels({ ...flat, visible: [...visible].reverse() });
    expect(a.indices).toEqual([1, 3, 7, 9]);
    expect(b.indices).toEqual(a.indices);
  });

  it("ranks over the VISIBLE set only — offscreen hubs do not steal slots", () => {
    const out = selectLabels({ ...base, visible: [1, 2], cap: 1 });
    expect(out.indices).toEqual([2]);
  });

  it("forces labels on first, past the cap, the radius floor and a zero alpha", () => {
    const out = selectLabels({
      ...base,
      cameraScale: 0.5, // alpha 0 — everything else is silent
      radiusOf: () => 0.1,
      visible: [4, 5, 6],
      forced: new Set([5]),
      cap: 0,
    });
    expect(out.alpha).toBe(0);
    expect(out.indices).toEqual([5]);
    expect(out.forcedCount).toBe(1);
  });

  it("never labels a node twice when it is both forced and eligible", () => {
    const out = selectLabels({ ...base, visible: [1, 2, 3], forced: new Set([2]) });
    expect(out.indices.filter((i) => i === 2)).toHaveLength(1);
    expect(out.indices[0]).toBe(2);
    expect(out.forcedCount).toBe(1);
  });

  it("caps a large forced set at the budget, keeping the highest-degree forced", () => {
    // A focus handoff auto-selects a whole BFS ball — hundreds of forced nodes.
    // They must not blow the K-label budget; forced take the cap FIRST, ranked by
    // degree, and the total (forced + ordinary) never exceeds it.
    const visible = Array.from({ length: 500 }, (_, i) => i);
    const forced = new Set(visible); // everything forced
    const out = selectLabels({ ...base, visible, forced, cap: 200 });
    expect(out.indices).toHaveLength(200); // total still ≤ cap
    expect(out.forcedCount).toBe(200); // forced consumed the whole budget
    expect(out.indices[0]).toBe(499); // highest degree first (degreeOf(i) = i in base)
    expect(Math.min(...out.indices)).toBe(300); // the 200 highest-degree forced
  });

  it("forced take the cap first, then ordinary labels fill the remainder", () => {
    // 3 forced + a wide visible set at cap 5 → 3 forced + 2 ordinary = 5 total.
    const visible = Array.from({ length: 50 }, (_, i) => i);
    const out = selectLabels({ ...base, visible, forced: new Set([0, 1, 2]), cap: 5 });
    expect(out.forcedCount).toBe(3);
    expect(out.indices).toHaveLength(5);
    // The 2 ordinary slots go to the highest-degree non-forced nodes (49, 48).
    expect(out.indices.slice(3)).toEqual([49, 48]);
  });

  it("tolerates a repeated index in the visible array", () => {
    const out = selectLabels({ ...base, visible: [3, 3, 3] });
    expect(out.indices).toEqual([3]);
  });
});

describe("fitText", () => {
  it("returns the string untouched when it fits", () => {
    expect(fitText("hello", 100, "12px x", measure)).toBe("hello");
  });

  it("truncates to the MEASURED width, not a character guess", () => {
    // "abcdefghij" is 60px; at 33px the widest prefix + "…" that fits is 5 chars.
    expect(fitText("abcdefghij", 33, "12px x", measure)).toBe("abcde…");
  });

  it("degrades to a bare ellipsis rather than overflowing", () => {
    expect(fitText("abcdefghij", 4, "12px x", measure)).toBe("…");
    expect(fitText("abcdefghij", 0, "12px x", measure)).toBe("abcdefghij");
  });

  it("measures the ellipsis it is about to append", () => {
    // 36px fits exactly six 6px chars, but only five once "…" (3px) is added.
    expect(fitText("abcdefghij", 36, "12px x", measure)).toBe("abcde…");
  });
});

describe("labelTextFor", () => {
  it("never renders an empty label for an untitled object", () => {
    expect(labelTextFor(null, "0191d4c8-aaaa-bbbb")).toBe("0191d4c8");
    expect(labelTextFor("   ", "0191d4c8-aaaa-bbbb")).toBe("0191d4c8");
    expect(labelTextFor("Acme Corp", "0191d4c8")).toBe("Acme Corp");
  });
});

describe("createSettleDebounce", () => {
  afterEach(() => vi.useRealTimers());

  it("fires once, 100ms after the camera stops moving", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createSettleDebounce(fn);
    d.bump();
    vi.advanceTimersByTime(60);
    d.bump();
    vi.advanceTimersByTime(60);
    expect(fn).not.toHaveBeenCalled(); // still moving
    expect(d.pending).toBe(true);
    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(false);
  });

  it("flushes and cancels", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createSettleDebounce(fn, 50);
    d.bump();
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    d.flush(); // nothing pending
    expect(fn).toHaveBeenCalledTimes(1);
    d.bump();
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// the overlay
// ---------------------------------------------------------------------------

interface FakeCtx {
  calls: { text: string; x: number; y: number; alpha: number; stroke: boolean }[];
  cleared: number;
}

function fakeCanvas(): { canvas: HTMLCanvasElement; rec: FakeCtx } {
  const rec: FakeCtx = { calls: [], cleared: 0 };
  const ctx = {
    font: "",
    textAlign: "",
    textBaseline: "",
    lineJoin: "",
    miterLimit: 0,
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    setTransform: () => {},
    clearRect: () => {
      rec.cleared += 1;
    },
    strokeText: (text: string, x: number, y: number) => {
      rec.calls.push({ text, x, y, alpha: ctx.globalAlpha, stroke: true });
    },
    fillText: (text: string, x: number, y: number) => {
      rec.calls.push({ text, x, y, alpha: ctx.globalAlpha, stroke: false });
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, rec };
}

const style = {
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSize: 12,
  color: "#111",
  haloColor: "#fff",
};

function item(over: Partial<LabelDrawItem> = {}): LabelDrawItem {
  return { index: 0, x: 100, y: 100, radius: 8, text: "node", ...over };
}

describe("LabelOverlay", () => {
  it("sizes the backing store by DPR and only when something changed", () => {
    const { canvas } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 2);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(canvas.style.width).toBe("400px");
    canvas.width = 1; // a resize would overwrite this; a no-op will not
    o.resize(400, 300, 2);
    expect(canvas.width).toBe(1);
  });

  it("clears once per pass and draws a halo under each label", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    o.draw([item(), item({ index: 1, x: 200 })], 1, style, measure);
    expect(rec.cleared).toBe(1);
    expect(rec.calls.filter((c) => c.stroke)).toHaveLength(2);
    expect(rec.calls.filter((c) => !c.stroke)).toHaveLength(2);
    // label sits just under the node: y + radius + 3
    expect(rec.calls[0]!.y).toBe(111);
  });

  it("multiplies the pass alpha by the per-item (highlight) alpha", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    o.draw([item({ alpha: 0.5 })], 0.5, style, measure);
    expect(rec.calls[0]!.alpha).toBeCloseTo(0.25, 6);
  });

  it("skips fully-dimmed and off-screen labels without measuring them", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    const spy = vi.fn(measure);
    o.draw(
      [item({ alpha: 0 }), item({ index: 1, x: 900 }), item({ index: 2, y: -400 })],
      1,
      style,
      spy,
    );
    expect(rec.calls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("clears without drawing at zero alpha", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    o.draw([item()], 0, style, measure);
    expect(rec.cleared).toBe(1);
    expect(rec.calls).toHaveLength(0);
  });

  it("truncates in the page font to the max width", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    o.draw(
      [item({ text: "a very long object title indeed" })],
      1,
      {
        ...style,
        maxWidth: 33,
      },
      measure,
    );
    expect(rec.calls[0]!.text).toBe("a ver…");
  });

  it("drops an ordinary label whose box overlaps one already placed", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    // Two ordinary labels at the SAME spot: the first claims the box, the second
    // overlaps it and is dropped rather than overprinted.
    o.draw([item({ text: "AAAA" }), item({ index: 1, text: "BBBB" })], 1, style, measure);
    const drawn = rec.calls.filter((c) => !c.stroke).map((c) => c.text);
    expect(drawn).toEqual(["AAAA"]);
  });

  it("keeps both when they do not overlap", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    o.draw([item({ text: "AAAA" }), item({ index: 1, x: 300, text: "BBBB" })], 1, style, measure);
    const drawn = rec.calls.filter((c) => !c.stroke).map((c) => c.text);
    expect(drawn).toEqual(["AAAA", "BBBB"]);
  });

  it("honours the caller's priority order — the FIRST of two overlapping ordinary labels wins", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    // The contract the graph relies on: the caller feeds items forced-first then
    // by descending degree, so "first placed wins" == "highest priority wins".
    // Reversing the pair flips which survives, which is exactly why the order is
    // load-bearing and pinned here.
    o.draw([item({ text: "HIGH" }), item({ index: 1, text: "low" })], 1, style, measure);
    o.draw([item({ text: "low" }), item({ index: 1, text: "HIGH" })], 1, style, measure);
    const drawn = rec.calls.filter((c) => !c.stroke).map((c) => c.text);
    // pass 1 kept HIGH, pass 2 (reversed) kept low — order decides, nothing else.
    expect(drawn).toEqual(["HIGH", "low"]);
  });

  it("declutters FORCED labels against each other instead of overprinting", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    // Two FORCED labels at the same spot: forced no longer bypasses the overlap
    // test, so the first (the higher-degree hub, emitted first) claims the box and
    // the overlapping one is dropped — otherwise a large forced set (a focus
    // handoff's BFS ball) reprints itself into mush.
    o.draw(
      [item({ text: "AAAA", forced: true }), item({ index: 1, text: "BBBB", forced: true })],
      1,
      style,
      measure,
    );
    const drawn = rec.calls.filter((c) => !c.stroke).map((c) => c.text);
    expect(drawn).toEqual(["AAAA"]);
  });

  it("keeps FORCED priority over an ordinary label by ORDER (forced emitted first)", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    // selectLabels emits forced first, so a forced label reserves its box before
    // any ordinary one at the same spot and the ordinary one yields.
    o.draw(
      [item({ text: "BBBB", forced: true }), item({ index: 1, text: "AAAA" })],
      1,
      style,
      measure,
    );
    const drawn = rec.calls.filter((c) => !c.stroke).map((c) => c.text);
    expect(drawn).toEqual(["BBBB"]);
  });

  it("clamps a wide label's center so its box cannot clip off either edge", () => {
    const { canvas, rec } = fakeCanvas();
    const o = new LabelOverlay(canvas);
    o.resize(400, 300, 1);
    // "AAAAAAAA" is 48px → half-width 24; edge keep-off is 2, so the center is
    // clamped into [26, 374]. (x stays within the ±24px off-screen cull margin so
    // the node is drawn at all, then the clamp pulls its wide box back on-screen.)
    o.draw([item({ x: -20, text: "AAAAAAAA" })], 1, style, measure);
    o.draw([item({ x: 420, text: "AAAAAAAA" })], 1, style, measure);
    const xs = rec.calls.filter((c) => !c.stroke).map((c) => c.x);
    expect(xs).toEqual([26, 374]);
  });

  it("is a silent no-op where there is no 2D context (jsdom)", () => {
    const canvas = { getContext: () => null, style: {} } as unknown as HTMLCanvasElement;
    const o = new LabelOverlay(canvas);
    expect(o.available).toBe(false);
    expect(() => o.draw([item()], 1, style, measure)).not.toThrow();
    expect(() => o.clear()).not.toThrow();
    expect(() => o.destroy()).not.toThrow();
  });
});
