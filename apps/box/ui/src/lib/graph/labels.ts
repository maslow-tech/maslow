/**
 * Node labels for the graph engine — selection (which nodes earn one) and the
 * 2D canvas overlay that draws them ABOVE the WebGL layer.
 *
 * The one architectural rule here, and the reason this file exists at all:
 * **a label is never a `PIXI.Text`.** Every `PIXI.Text` is its own texture
 * upload and its own draw call, so 200 of them is 200 textures and a stall on
 * every zoom; 5,000 of them is a browser tab you can hear. A second, plain 2D
 * `<canvas>` stacked over the WebGL canvas draws all of them in one pass with
 * the browser's own text rasteriser, at the page's real font, for free — and it
 * gets sub-pixel antialiasing and the system font stack, which a WebGL atlas
 * never gets right.
 *
 * The committed legibility (LOD) rules, all four
 * of which exist because an unfiltered label layer is illegible mush:
 *
 *  1. **Fade threshold.** `labelAlpha = smoothstep(t, t * 1.6, cameraScale)`,
 *     where `t` is the user's label-threshold slider. Below `t` no labels at
 *     all; above `t * 1.6` full strength; between, a smooth ramp — a hard
 *     cutoff makes labels pop in and out while you scroll-zoom, which reads as
 *     a bug.
 *  2. **Screen radius > 6px.** A label on a 2px dot is a label with no owner:
 *     you cannot tell which speck it belongs to. Radius is measured in SCREEN
 *     pixels (world radius × camera scale), so this rule follows the zoom.
 *  3. **Capped at K = 200, ranked by descending degree.** Past ~200 strings the
 *     overlay stops being readable and starts costing measurable frame time.
 *     Degree is the ranking key because the hubs are what orient you.
 *  4. **Recomputed on a 100ms camera-settle debounce.** Selection walks the
 *     visible set and sorts it; doing that on every wheel event during a
 *     continuous zoom is the difference between 60fps and 30. Positions still
 *     update every frame — only the SET of labelled nodes is debounced, so
 *     labels stay glued to their nodes while the camera moves.
 *
 * Truncation measures the string in the page's ACTUAL font: a character-count
 * guess either wastes half the room or overflows, and it is wrong in a
 * different direction for every font. Measurement is injectable because jsdom
 * has no canvas 2D context — the fallback is an average-advance estimate,
 * never a throw.
 *
 * The rail's local graph (`components/LocalGraph.tsx`, which replaced
 * `MiniMap.tsx`) measures its SVG labels through `fitText` below rather than
 * carrying a second measurer — which is what the note here used to ask for.
 */

/** Hard cap on labels drawn at once, ranked by descending degree. */
export const LABEL_CAP = 200;

/** A node smaller than this on SCREEN gets no label — you couldn't tell whose. */
export const LABEL_MIN_SCREEN_RADIUS = 6;

/** Camera-settle debounce before the labelled SET is recomputed. */
export const LABEL_SETTLE_MS = 100;

/** Default max label width in CSS px before the middle-out ellipsis. */
const LABEL_MAX_WIDTH = 132;

/** Label type size in CSS px. Matches the rail's old title size. */
const LABEL_FONT_SIZE = 11.5;

/**
 * Hermite smoothstep, clamped. `smoothstep(a, b, x)` is 0 at/below `a`, 1 at/
 * above `b`, and S-curved between — the ramp the fade threshold rides on.
 * Degenerate (`b <= a`) collapses to a step so a slider pinned at 0 still
 * behaves.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The committed fade curve: labels start appearing at the slider value and
 * reach full strength at 1.6× it.
 */
export function labelAlpha(threshold: number, cameraScale: number): number {
  const t = Math.max(0, threshold);
  return smoothstep(t, t * 1.6, cameraScale);
}

/** Node radius floor, in WORLD units (screen radius is `r * camera.scale`). */
export const NODE_R_MIN = 3;
/** Node radius ceiling — a hub is visibly a hub without eating the viewport. */
export const NODE_R_MAX = 24;

/**
 * The spec's node radius, in CSS px at camera scale 1:
 * `clamp(3, 3 * sqrt(1 + deg), 24) * userSizeSlider`. Area grows with degree,
 * so a hub is visibly a hub. The slider multiplies AFTER the clamp so it scales
 * the whole range uniformly instead of flattening it.
 *
 * This module owns the formula AND its bounds, and `renderer.ts` re-exports
 * both rather than keeping a second copy: label selection needs exactly the
 * number the renderer draws, and two copies of this drifting apart is a label
 * floating off its node. `labels.ts` is the leaf (it imports nothing), so the
 * dependency can only point this way.
 */
export function nodeRadius(degree: number, sizeSlider = 1): number {
  const d = Number.isFinite(degree) && degree > 0 ? degree : 0;
  return Math.min(NODE_R_MAX, Math.max(NODE_R_MIN, 3 * Math.sqrt(1 + d))) * sizeSlider;
}

/** What `selectLabels` needs to know. All lookups are by DENSE INDEX. */
interface LabelSelectionInput {
  /**
   * The dense indices currently inside the viewport (from culling). Selection
   * is deliberately over the VISIBLE set, not the whole graph: the top-200 hubs
   * of a 5,000-node brain are mostly offscreen when you zoom into a corner, and
   * labelling them would leave the thing you are looking at unlabelled.
   */
  readonly visible: ArrayLike<number>;
  /** device-independent px per world unit. */
  readonly cameraScale: number;
  /** the user's label-threshold slider. */
  readonly threshold: number;
  /** base (camera-scale-1) radius in px, per dense index. */
  readonly radiusOf: (index: number) => number;
  /** the server's visible-only degree per dense index — the ranking key. */
  readonly degreeOf: (index: number) => number;
  /**
   * Indices whose label is forced on regardless of threshold, radius or cap —
   * search matches and the hovered/selected node. They are emitted FIRST and do
   * not consume cap slots, because a search that highlights a match without
   * naming it has told you nothing.
   */
  readonly forced?: ReadonlySet<number> | undefined;
  readonly cap?: number | undefined;
  readonly minScreenRadius?: number | undefined;
}

/** The outcome of one selection pass. */
export interface LabelSelection {
  /**
   * Overlay opacity from the fade curve. `forced` labels ignore it (they draw
   * at full strength); everything else multiplies by it.
   */
  readonly alpha: number;
  /** dense indices to label, forced ones first, then descending degree. */
  readonly indices: number[];
  /** how many of the leading `indices` are forced. */
  readonly forcedCount: number;
  /** visible-and-eligible nodes that lost their label to the cap. */
  readonly droppedToCap: number;
}

const EMPTY_SELECTION: LabelSelection = {
  alpha: 0,
  indices: [],
  forcedCount: 0,
  droppedToCap: 0,
};

/**
 * Choose the labelled nodes. Pure, allocation-light, and cheap enough to run on
 * a 100ms debounce over a 5,000-node visible set (one filter pass + one sort of
 * the survivors).
 */
export function selectLabels(input: LabelSelectionInput): LabelSelection {
  const cap = input.cap ?? LABEL_CAP;
  const minR = input.minScreenRadius ?? LABEL_MIN_SCREEN_RADIUS;
  const scale = Number.isFinite(input.cameraScale) ? input.cameraScale : 0;
  const alpha = labelAlpha(input.threshold, scale);
  const forced = input.forced;
  const hasForced = forced !== undefined && forced.size > 0;

  // Forced labels survive a zero alpha — that is the whole point of forcing
  // them. Nothing else does, and skipping the walk keeps a zoomed-out graph at
  // literally zero label cost.
  if (alpha <= 0 && !hasForced) return EMPTY_SELECTION;
  if (cap <= 0 && !hasForced) return EMPTY_SELECTION;

  const indices: number[] = [];
  let forcedCount = 0;
  const seen = new Set<number>();

  // Stable descending-degree order — ties broken by index so the set does not
  // flicker between two equal-degree nodes across recomputes.
  const byDegree = (a: number, b: number): number => {
    const d = input.degreeOf(b) - input.degreeOf(a);
    return d !== 0 ? d : a - b;
  };

  if (hasForced) {
    // Collect the VISIBLE forced nodes, then RANK AND CAP them. A forced set is
    // the ENTIRE node set of a search/selection highlight, and a focus handoff
    // auto-selects a whole BFS ball — hundreds to thousands of nodes. Left
    // uncapped they blew the K-label budget and (with the draw-time bypass, now
    // gone) overprinted each other into the exact mush the declutter exists to
    // stop, while onFrame shaped every one of them each frame. So forced labels
    // take their share of the SAME budget FIRST — the thing you are looking at
    // wins the cap — keeping the hubs of a large selection and dropping the rest.
    // `Math.max(cap, 1)` still shows at least the hover/search focus even when
    // labels are otherwise off (cap ≤ 0).
    const forcedVisible: number[] = [];
    for (let k = 0; k < input.visible.length; k += 1) {
      const i = input.visible[k]!;
      if (!forced.has(i) || seen.has(i)) continue;
      seen.add(i);
      forcedVisible.push(i);
    }
    forcedVisible.sort(byDegree);
    const forcedBudget = Math.max(cap, 1);
    forcedCount = forcedVisible.length > forcedBudget ? forcedBudget : forcedVisible.length;
    for (let k = 0; k < forcedCount; k += 1) indices.push(forcedVisible[k]!);
  }

  if (alpha <= 0 || cap <= 0) {
    return { alpha, indices, forcedCount, droppedToCap: 0 };
  }

  // One pass to collect the eligible, then rank. Nodes whose SCREEN radius is
  // under the floor are not candidates at all — they are specks. Forced nodes
  // are already `seen`, so they never double-count against the budget.
  const eligible: number[] = [];
  for (let k = 0; k < input.visible.length; k += 1) {
    const i = input.visible[k]!;
    if (seen.has(i)) continue;
    if (input.radiusOf(i) * scale <= minR) continue;
    seen.add(i);
    eligible.push(i);
  }

  eligible.sort(byDegree);

  // Ordinary labels fill whatever the forced labels left of the budget, so the
  // TOTAL never exceeds the cap — the committed "≤ K labels drawn at once".
  const remaining = cap - forcedCount;
  const kept = remaining <= 0 ? 0 : eligible.length > remaining ? remaining : eligible.length;
  for (let k = 0; k < kept; k += 1) indices.push(eligible[k]!);

  return { alpha, indices, forcedCount, droppedToCap: eligible.length - kept };
}

// ---------------------------------------------------------------------------
// text measurement + truncation
// ---------------------------------------------------------------------------

/** Measures a string's advance width in px for a CSS `font` shorthand. */
export type TextMeasurer = (text: string, font: string) => number;

let sharedCtx: CanvasRenderingContext2D | null | undefined;

/**
 * The real measurer: one offscreen 2D context reused forever (creating one per
 * call is the classic way to make text layout the slowest thing on the page).
 *
 * jsdom — and any environment without a canvas backend — returns no context. We
 * fall back to an average-advance estimate rather than throwing: a label that is
 * truncated slightly wrong in a test environment is a non-event; a graph that
 * cannot render in one is not.
 */
const measureText: TextMeasurer = (text, font) => {
  if (sharedCtx === undefined) {
    try {
      sharedCtx = document.createElement("canvas").getContext("2d");
    } catch {
      sharedCtx = null;
    }
  }
  if (sharedCtx) {
    sharedCtx.font = font;
    return sharedCtx.measureText(text).width;
  }
  const size = parseFloat(font) || LABEL_FONT_SIZE;
  return text.length * size * 0.52;
};

/**
 * Truncate to `maxPx` in the given font, appending an ellipsis — measured, not
 * guessed. Binary search over the prefix length, so a long title costs
 * log(n) measurements rather than n.
 */
export function fitText(
  text: string,
  maxPx: number,
  font: string,
  measure: TextMeasurer = measureText,
): string {
  if (maxPx <= 0 || text.length === 0) return text;
  if (measure(text, font) <= maxPx) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid)}…`, font) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? "…" : `${text.slice(0, lo)}…`;
}

/** The label for a node — never `""`, so an untitled object stays clickable. */
export function labelTextFor(title: string | null | undefined, id: string): string {
  const t = (title ?? "").trim();
  if (t.length > 0) return t;
  // The id's short form, matching the rest of the dashboard's untitled treatment.
  return id.length > 8 ? id.slice(0, 8) : id;
}

// ---------------------------------------------------------------------------
// the overlay
// ---------------------------------------------------------------------------

/** One label, already projected to CSS pixels by the caller. */
export interface LabelDrawItem {
  readonly index: number;
  /** screen x of the node CENTER, in CSS px. */
  readonly x: number;
  /** screen y of the node CENTER, in CSS px. */
  readonly y: number;
  /** the node's SCREEN radius in CSS px — the label sits just under it. */
  readonly radius: number;
  readonly text: string;
  /**
   * Per-item multiplier on the pass alpha: the highlight controller's node
   * alpha, so a dimmed node's label dims with it instead of floating over the
   * isolation as a bright orphan.
   */
  readonly alpha?: number | undefined;
  /**
   * A forced label (search match / hover / selection) always draws and reserves
   * its box FIRST, so ordinary labels yield around it. Ordinary labels yield to
   * anything already placed — the declutter pass in `draw`.
   */
  readonly forced?: boolean | undefined;
}

/** Colors + geometry for one draw pass. The caller reads them from CSS vars. */
interface LabelDrawStyle {
  /** the page font FAMILY (not the shorthand) — the size is ours. */
  readonly fontFamily: string;
  readonly fontSize?: number | undefined;
  readonly color: string;
  /** halo painted under the glyphs so text stays readable over edges. */
  readonly haloColor: string;
  readonly haloWidth?: number | undefined;
  readonly maxWidth?: number | undefined;
}

/**
 * The 2D canvas stacked over the WebGL canvas.
 *
 * It owns nothing but its own context: the caller decides what to draw and
 * where, this class only makes the drawing correct and cheap (device pixel
 * ratio, one font set per pass, one clear per frame). It is intentionally not a
 * React component — it is driven from the same rAF loop as the renderer, and a
 * setState per frame is exactly the cost this whole engine exists to avoid.
 */
export class LabelOverlay {
  private readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = null;
    try {
      this.ctx = canvas.getContext("2d");
    } catch {
      this.ctx = null;
    }
  }

  /** True when there is a real 2D context; false in jsdom. Callers may skip. */
  get available(): boolean {
    return this.ctx !== null;
  }

  /**
   * Size the backing store to `w × h` CSS px at `dpr` device pixels. Skipped
   * when nothing changed — resizing a canvas clears it and reallocates, so
   * doing it per frame from a ResizeObserver echo is a real cost.
   */
  resize(w: number, h: number, dpr = 1): void {
    const nextDpr = dpr > 0 ? dpr : 1;
    if (this.width === w && this.height === h && this.dpr === nextDpr) return;
    this.width = w;
    this.height = h;
    this.dpr = nextDpr;
    this.canvas.width = Math.max(1, Math.round(w * nextDpr));
    this.canvas.height = Math.max(1, Math.round(h * nextDpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  clear(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Draw one pass. `alpha` is the fade-curve value for the non-forced labels;
   * items carry their own multiplier for highlight dimming.
   *
   * Two rules keep a dense cluster legible instead of an overprinted mush — the
   * defect this pass exists to close:
   *
   *  - **Offset, never centered.** The label sits just UNDER the node, so the
   *    node circle never overprints its own text (a centered label draws the dot
   *    straight through the glyphs).
   *  - **Greedy declutter.** Items arrive in priority order (forced first, then
   *    descending degree). Each reserves an axis-aligned box; a later label whose
   *    box overlaps one already placed is DROPPED rather than drawn on top of it.
   *    This holds for forced labels (search / hover / selection) TOO: they reserve
   *    first, so an ordinary label always yields to them, but two forced labels
   *    that overlap no longer overprint — the higher-degree one (emitted first)
   *    wins and the other is culled. The halo under the glyphs keeps the
   *    survivors readable over edges.
   *
   * The center x is clamped to the viewport so the leftmost label in a cluster
   * cannot start before x=0 and clip against the screen edge.
   *
   * Off-screen items are skipped rather than clipped — the browser would clip
   * them anyway, but measuring and shaping a string nobody sees is the kind of
   * cost that only shows up on a customer's laptop.
   */
  draw(
    items: readonly LabelDrawItem[],
    alpha: number,
    style: LabelDrawStyle,
    measure: TextMeasurer = measureText,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.clear();
    if (items.length === 0 || alpha <= 0) return;

    const size = style.fontSize ?? LABEL_FONT_SIZE;
    const font = `${size}px ${style.fontFamily}`;
    const maxWidth = style.maxWidth ?? LABEL_MAX_WIDTH;
    const haloWidth = style.haloWidth ?? 3;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;

    // Declutter state: boxes already claimed this pass, in priority order.
    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    const lineH = size * 1.15;
    const gapX = 3; // breathing room between neighbours before they count as colliding
    const gapY = 2;
    const edge = 2; // keep a clamped label off the very edge

    const pad = 24;
    for (const item of items) {
      if (
        item.x < -pad ||
        item.y < -pad ||
        item.x > this.width + pad ||
        item.y > this.height + pad
      ) {
        continue;
      }
      const a = Math.min(1, Math.max(0, alpha * (item.alpha ?? 1)));
      if (a <= 0.01) continue;
      const text = fitText(item.text, maxWidth, font, measure);
      const half = Math.min(this.width / 2, measure(text, font) / 2);
      // Clamp the center so a wide label near an edge cannot clip off-screen.
      const cx = Math.min(Math.max(item.x, half + edge), this.width - half - edge);
      const y = item.y + item.radius + 3;
      const box = {
        x0: cx - half - gapX,
        y0: y - gapY,
        x1: cx + half + gapX,
        y1: y + lineH + gapY,
      };

      // Declutter applies to EVERY label, forced included. Forced labels used to
      // skip this test and paint on top of whatever was there — fine for one
      // hover, but a large forced set (a focus handoff's auto-selected BFS ball)
      // then overprinted itself into mush. Priority is carried by ORDER, not by a
      // bypass: `selectLabels` emits forced-first then by descending degree, so a
      // forced label claims its box before any ordinary one, and the FIRST of two
      // overlapping forced labels (the higher-degree hub) is the one that wins.
      let hit = false;
      for (const p of placed) {
        if (box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0) {
          hit = true;
          break;
        }
      }
      if (hit) continue; // a higher-priority label owns this space — drop it
      placed.push(box);

      ctx.globalAlpha = a;
      if (haloWidth > 0) {
        ctx.strokeStyle = style.haloColor;
        ctx.lineWidth = haloWidth;
        ctx.strokeText(text, cx, y);
      }
      ctx.fillStyle = style.color;
      ctx.fillText(text, cx, y);
    }
    ctx.globalAlpha = 1;
  }

  /** Drop the context reference; the canvas itself belongs to React. */
  destroy(): void {
    this.clear();
    this.ctx = null;
  }
}

// ---------------------------------------------------------------------------
// the camera-settle debounce
// ---------------------------------------------------------------------------

/** A trailing debounce with an explicit flush — see `LABEL_SETTLE_MS`. */
export interface SettleDebounce {
  /** the camera moved; (re)start the timer. */
  bump(): void;
  /** run now if something is pending. */
  flush(): void;
  /** drop anything pending (unmount). */
  cancel(): void;
  readonly pending: boolean;
}

/**
 * Recompute-on-settle. Trailing only: during a continuous scroll-zoom the
 * labelled SET is deliberately stale (the labels ride along with their nodes,
 * which is what makes the zoom read as smooth), and it snaps to the truth
 * 100ms after your hand stops.
 */
export function createSettleDebounce(fn: () => void, ms = LABEL_SETTLE_MS): SettleDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    bump(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    flush(): void {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      fn();
    },
    cancel(): void {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
    get pending(): boolean {
      return timer !== null;
    },
  };
}
