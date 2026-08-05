/**
 * Renderer unit tests.
 *
 * Everything here exercises the renderer's PURE half — the camera transform,
 * the LOD formulas, the interpolation, the cull tests and the spatial hash.
 * That is deliberate and it is the whole reason `renderer.ts` imports Pixi
 * lazily: there is no WebGL context in jsdom, so a module that pulled Pixi in
 * at import time would make every one of these unrunnable, and the formulas
 * that decide whether a graph is legible would ship untested.
 *
 * `createGraphRenderer` itself (canvas, sprites, ResizeObserver) is covered by
 * the browser E2E pass, not here.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LINK_DISTANCE,
  EDGE_MIN_PX,
  FIT_SCALE_MAX,
  LINEAR_SCAN_MAX,
  NODE_R_MAX,
  NODE_R_MIN,
  SCALE_MAX,
  SCALE_MIN,
  buildSpatialHash,
  clampScale,
  edgeAlpha,
  fitCenter,
  fitScale,
  forEachInRect,
  forEachNear,
  hexToInt,
  interpolationFactor,
  lerpPositions,
  nodeRadius,
  normalizeCamera,
  parseCssColor,
  readPalette,
  screenToWorld,
  shouldCullEdge,
  viewRect,
  worldToScreen,
} from "./renderer";
import type { CameraState } from "./types";

const cam = (x: number, y: number, scale: number): CameraState => ({ x, y, scale });

describe("camera transform", () => {
  it("puts camera.x/y under the CENTRE of the container, not a corner", () => {
    // This is the bug the whole file exists to fix: a fixed 1200x800 viewBox
    // anchors the world to a corner and letterboxes it, so a wide container
    // grows dead margin. A centre-anchored camera keeps the same world point
    // under the middle at every size.
    const c = cam(10, -20, 2);
    expect(worldToScreen(c, 800, 600, 10, -20)).toEqual({ x: 400, y: 300 });
    expect(worldToScreen(c, 1600, 600, 10, -20)).toEqual({ x: 800, y: 300 });
  });

  it("screenToWorld is the exact inverse of worldToScreen", () => {
    const c = cam(133.5, -42.25, 0.37);
    for (const [sx, sy] of [
      [0, 0],
      [37, 911],
      [1279, 43],
    ] as const) {
      const w = screenToWorld(c, 1280, 960, sx, sy);
      const s = worldToScreen(c, 1280, 960, w.x, w.y);
      expect(s.x).toBeCloseTo(sx, 6);
      expect(s.y).toBeCloseTo(sy, 6);
    }
  });

  it("scale is clamped, and a hostile persisted camera normalizes", () => {
    expect(clampScale(1e9)).toBe(SCALE_MAX);
    expect(clampScale(0)).toBe(SCALE_MIN);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(normalizeCamera({ x: Number.NaN, y: Infinity, scale: -3 })).toEqual({
      x: 0,
      y: 0,
      scale: SCALE_MIN,
    });
    expect(normalizeCamera(null)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(normalizeCamera({ x: 5, y: 6, scale: 2 })).toEqual({ x: 5, y: 6, scale: 2 });
  });

  it("fit zooms out without limit but in no further than FIT_SCALE_MAX", () => {
    // Bigger than the clear rect: zoom out as far as it takes.
    expect(fitScale(4000, 2000, 1000, 800)).toBeCloseTo(0.25, 6);
    // Smaller than it: bounded, or a 29-object brain opens on giant blobs.
    expect(fitScale(20, 10, 1000, 800)).toBe(FIT_SCALE_MAX);
    expect(fitScale(400, 300, 1000, 800)).toBe(FIT_SCALE_MAX);
    // The tighter axis wins.
    expect(fitScale(500, 2000, 1000, 800)).toBeCloseTo(0.4, 6);
  });

  it("fit centres for real, and yields to a panel only as far as it must", () => {
    // Slack on this axis (content 200 wide in a 1000px viewport behind a 284px
    // rail): the true centre, 500, already clears the rail, so take it. The old
    // clear-rect centre would have parked this at 642 — the "shoved into the
    // corner" framing this function exists to stop.
    expect(fitCenter(1000, 284, 0, 48, 100)).toBe(500);
    // Wider content: the true centre would tuck its left edge under the rail,
    // so it gives up exactly enough to clear it — 532, not the full 642.
    expect(fitCenter(1000, 284, 0, 48, 200)).toBe(532);
    // No slack at all (the axis that sized the fit) — fall back to the
    // clear-rect centre, which is the behaviour that always shipped.
    expect(fitCenter(1000, 284, 0, 48, 400)).toBe(642);
    // Symmetric reserves leave the true centre alone.
    expect(fitCenter(1000, 200, 200, 48, 100)).toBe(500);
  });

  it("the view rect covers exactly the container, plus the margin", () => {
    const r = viewRect(cam(0, 0, 2), 800, 400, 0);
    expect(r).toEqual({ minX: -200, minY: -100, maxX: 200, maxY: 100 });
    const m = viewRect(cam(0, 0, 2), 800, 400, 24);
    expect(m.minX).toBe(-224);
    expect(m.maxY).toBe(124);
  });
});

describe("node radius", () => {
  it("is clamp(3, 3*sqrt(1+deg), 24) so hubs are visibly hubs", () => {
    expect(nodeRadius(0)).toBe(NODE_R_MIN);
    expect(nodeRadius(3)).toBeCloseTo(6, 6);
    expect(nodeRadius(15)).toBeCloseTo(12, 6);
    // 3*sqrt(1+80) = 27 -> clamped
    expect(nodeRadius(80)).toBe(NODE_R_MAX);
    expect(nodeRadius(100_000)).toBe(NODE_R_MAX);
  });

  it("grows monotonically with degree", () => {
    let last = 0;
    for (const d of [0, 1, 2, 5, 12, 40, 63]) {
      const r = nodeRadius(d);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
  });

  it("applies the size slider AFTER the clamp, scaling the whole range", () => {
    expect(nodeRadius(0, 2)).toBe(NODE_R_MIN * 2);
    expect(nodeRadius(500, 2)).toBe(NODE_R_MAX * 2);
    expect(nodeRadius(3, 0.5)).toBeCloseTo(3, 6);
  });

  it("survives a garbage degree rather than producing NaN geometry", () => {
    expect(nodeRadius(Number.NaN)).toBe(NODE_R_MIN);
    expect(nodeRadius(-5)).toBe(NODE_R_MIN);
  });
});

describe("edge alpha", () => {
  it("is clamp(0.06, 8/sqrt(edges), 0.35)", () => {
    expect(edgeAlpha(100)).toBeCloseTo(0.35, 6); // 0.8 -> clamped high
    expect(edgeAlpha(1024)).toBeCloseTo(0.25, 6);
    expect(edgeAlpha(100_000)).toBeCloseTo(0.06, 6); // 0.025 -> clamped low
  });

  it("never returns 0 (an invisible graph) for a degenerate count", () => {
    expect(edgeAlpha(0)).toBe(0.35);
    expect(edgeAlpha(Number.NaN)).toBe(0.35);
  });

  it("fades as the graph gets denser", () => {
    expect(edgeAlpha(5_000)).toBeLessThan(edgeAlpha(500));
  });
});

describe("interpolation between physics ticks", () => {
  it("maps elapsed time onto [0,1] across one 30Hz period", () => {
    const period = 1000 / 30;
    expect(interpolationFactor(0, period)).toBe(0);
    expect(interpolationFactor(period / 2, period)).toBeCloseTo(0.5, 6);
    expect(interpolationFactor(period, period)).toBe(1);
  });

  it("clamps instead of extrapolating when the worker stalls", () => {
    expect(interpolationFactor(5_000, 1000 / 30)).toBe(1);
    expect(interpolationFactor(-10, 1000 / 30)).toBe(0);
  });

  it("lerps the shared prefix and takes new nodes straight from the target", () => {
    // Page 2 of the paged load added a third node: it has no previous
    // position, so it must appear where the worker put it, not at (0,0).
    const prev = new Float32Array([0, 0, 10, 10]);
    const next = new Float32Array([2, 2, 20, 20, 99, -99]);
    const out = new Float32Array(6);
    lerpPositions(prev, next, 0.5, out);
    expect(Array.from(out)).toEqual([1, 1, 15, 15, 99, -99]);
  });

  it("writes into the caller's buffer (no per-frame allocation)", () => {
    const out = new Float32Array(4);
    const result = lerpPositions(
      new Float32Array([0, 0, 0, 0]),
      new Float32Array([4, 4, 4, 4]),
      1,
      out,
    );
    expect(result).toBe(out);
    expect(Array.from(out)).toEqual([4, 4, 4, 4]);
  });
});

describe("edge culling", () => {
  const rect = { minX: -100, minY: -100, maxX: 100, maxY: 100 };

  it("drops sub-pixel edges", () => {
    // 1 world unit at scale 1 projects to 1px, under the 2px floor.
    expect(shouldCullEdge(0, 0, 1, 0, rect, 1)).toBe(true);
    // the same edge at 4x is 4px and survives
    expect(shouldCullEdge(0, 0, 1, 0, rect, 4)).toBe(false);
    expect(EDGE_MIN_PX).toBe(2);
  });

  it("drops edges with both endpoints past the same side", () => {
    expect(shouldCullEdge(200, 0, 300, 50, rect, 1)).toBe(true);
    expect(shouldCullEdge(0, -400, 50, -300, rect, 1)).toBe(true);
  });

  it("KEEPS a long edge that crosses the viewport with both ends outside", () => {
    // The literal "both endpoints offscreen" rule would delete this line even
    // though it visibly crosses the screen — a vanishing edge is a worse bug
    // than a few extra segments, so the test is same-side, not offscreen.
    expect(shouldCullEdge(-500, 0, 500, 0, rect, 1)).toBe(false);
    expect(shouldCullEdge(-500, -500, 500, 500, rect, 1)).toBe(false);
  });

  it("keeps an edge with one endpoint on screen", () => {
    expect(shouldCullEdge(0, 0, 900, 900, rect, 1)).toBe(false);
  });
});

describe("spatial hash", () => {
  const grid = (cols: number, rows: number, step: number): Float32Array => {
    const xy = new Float32Array(cols * rows * 2);
    let k = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        xy[k] = c * step;
        xy[k + 1] = r * step;
        k += 2;
      }
    }
    return xy;
  };

  it("buckets every node exactly once", () => {
    const xy = grid(20, 20, 25);
    const hash = buildSpatialHash(xy, 400, DEFAULT_LINK_DISTANCE * 2);
    expect(hash.n).toBe(400);
    expect(hash.items.length).toBe(400);
    expect(hash.cellStart[hash.cols * hash.rows]).toBe(400);
    expect(new Set(Array.from(hash.items)).size).toBe(400);
  });

  it("finds exactly the nodes inside a world rect (box-select's primitive)", () => {
    const xy = grid(20, 20, 25); // 0..475 on both axes
    const hash = buildSpatialHash(xy, 400, 120);
    const found: number[] = [];
    forEachInRect(hash, xy, 0, 0, 50, 50, (i) => found.push(i));
    found.sort((a, b) => a - b);
    // a 3x3 block of the 20-wide grid: rows 0..2, cols 0..2
    expect(found).toEqual([0, 1, 2, 20, 21, 22, 40, 41, 42]);
  });

  it("agrees with a brute-force scan on a random cloud", () => {
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const n = 2_000;
    const xy = new Float32Array(n * 2);
    for (let i = 0; i < n; i += 1) {
      xy[2 * i] = (rand() - 0.5) * 4000;
      xy[2 * i + 1] = (rand() - 0.5) * 4000;
    }
    const hash = buildSpatialHash(xy, n, 130);
    const box = { x0: -300, y0: 120, x1: 700, y1: 900 };
    const brute: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const x = xy[2 * i]!;
      const y = xy[2 * i + 1]!;
      if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) brute.push(i);
    }
    const hashed: number[] = [];
    forEachInRect(hash, xy, box.x0, box.y0, box.x1, box.y1, (i) => hashed.push(i));
    hashed.sort((a, b) => a - b);
    expect(hashed).toEqual(brute);
    expect(brute.length).toBeGreaterThan(50); // the test would be vacuous otherwise
  });

  it("returns the containing cell plus its neighbours for a point query", () => {
    const xy = grid(10, 10, 30);
    const hash = buildSpatialHash(xy, 100, 60);
    const near = new Set<number>();
    forEachNear(hash, 0, 0, 5, (i) => near.add(i));
    // node 0 sits at (0,0); whatever else the ring returns, it must be there,
    // and it must not be the whole graph.
    expect(near.has(0)).toBe(true);
    expect(near.size).toBeLessThan(100);
  });

  it("survives an empty graph and NaN positions from a broken tick", () => {
    const empty = buildSpatialHash(new Float32Array(0), 0);
    expect(empty.n).toBe(0);
    let hits = 0;
    forEachInRect(empty, new Float32Array(0), -1e6, -1e6, 1e6, 1e6, () => (hits += 1));
    forEachNear(empty, 0, 0, 10, () => (hits += 1));
    expect(hits).toBe(0);

    const xy = new Float32Array([0, 0, Number.NaN, Number.NaN, 10, 10]);
    const hash = buildSpatialHash(xy, 3, 50);
    expect(hash.n).toBe(3);
    expect(Number.isFinite(hash.minX)).toBe(true);
    expect(hash.cols * hash.rows).toBeGreaterThan(0);
  });

  it("caps the grid so one far-flung node cannot demand millions of cells", () => {
    // Early in a simulation a node routinely lands far outside the cluster.
    const xy = new Float32Array([0, 0, 1, 1, 2, 2, 1e7, 1e7]);
    const hash = buildSpatialHash(xy, 4, 10);
    expect(hash.cols * hash.rows).toBeLessThanOrEqual(Math.max(64, 4 * 4));
    expect(hash.cell).toBeGreaterThan(10);
    const found: number[] = [];
    forEachInRect(hash, xy, -1, -1, 3, 3, (i) => found.push(i));
    expect(found.sort()).toEqual([0, 1, 2]);
  });

  it("keeps the linear-scan threshold at the documented 10k", () => {
    expect(LINEAR_SCAN_MAX).toBe(10_000);
  });
});

describe("theme colours", () => {
  it("parses the hex and rgba forms the skins are written in", () => {
    expect(parseCssColor("#ffffff")).toEqual({ rgb: 0xffffff, a: 1 });
    expect(parseCssColor("#060608")).toEqual({ rgb: 0x060608, a: 1 });
    expect(parseCssColor("#fff")).toEqual({ rgb: 0xffffff, a: 1 });
    const line = parseCssColor("rgba(255, 255, 255, 0.08)");
    expect(line?.rgb).toBe(0xffffff);
    expect(line?.a).toBeCloseTo(0.08, 6);
    expect(parseCssColor("rgb(0 0 0 / 12%)")?.rgb).toBe(0x000000);
  });

  it("returns null for anything it cannot parse, so the caller can fall back", () => {
    // The shadcn tokens are oklch(); the graph reads the aurora tokens, and an
    // unparseable value must not become black-on-black.
    expect(parseCssColor("oklch(0.922 0 0)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor(null)).toBeNull();
    expect(parseCssColor("#12345")).toBeNull();
  });

  it("hexToInt turns a typeHue string into a Pixi tint", () => {
    expect(hexToInt("#4aa8ff")).toBe(0x4aa8ff);
    expect(hexToInt("not a color", 0x123456)).toBe(0x123456);
  });

  it("falls back per skin when no element or no tokens are available", () => {
    const dark = readPalette(null, "dark");
    const light = readPalette(null, "light");
    expect(dark.ground).toBe(0x060608);
    expect(light.ground).toBe(0xffffff);
    expect(dark.edgeAlpha).toBeGreaterThan(0);
  });

  it("reads the live tokens off an element, so both skins work", () => {
    const el = document.createElement("div");
    el.style.setProperty("--line", "rgba(255, 255, 255, 0.08)");
    el.style.setProperty("--ink-strong", "#ffffff");
    el.style.setProperty("--ground", "#060608");
    document.body.appendChild(el);
    try {
      const p = readPalette(el, "dark");
      expect(p.edge).toBe(0xffffff);
      expect(p.ring).toBe(0xffffff);
      expect(p.ground).toBe(0x060608);
      // the hairline token's own alpha is boosted but never past opaque
      expect(p.edgeAlpha).toBeGreaterThanOrEqual(0.35);
      expect(p.edgeAlpha).toBeLessThanOrEqual(1);
    } finally {
      el.remove();
    }
  });
});
