/**
 * The whole-brain graph.
 *
 * This replaces the SVG implementation entirely. The old one ran an all-pairs
 * O(n²) repulsion loop per frame in JS and drew DOM nodes into a fixed
 * 1200×800 `viewBox`, which is why it had `DEFAULT_SAMPLE = 80` /
 * `MAX_SAMPLE = 320` (a symptom of the algorithm, never a product decision)
 * and why it piled everything into the middle of a wide screen. All of that is
 * gone: the layout runs in a Web Worker (`lib/graph/physics.worker.ts`,
 * Barnes–Hut, O(n log n)), the drawing is PixiJS sized to the ACTUAL container
 * by `ResizeObserver` (`lib/graph/renderer.ts`), the data is a graphology store
 * plus a CSR adjacency (`lib/graph/store.ts`, `lib/graph/csr.ts`), and the
 * labels are a 2D canvas stacked over the WebGL one (`lib/graph/labels.ts`).
 *
 * Four rules this file is responsible for, each one load-bearing:
 *
 *  1. **Progressive, never silent.** `GET /api/v1/graph` is cursor-paged
 *     (5,000 rows a page). Page one PAINTS — you are looking at your brain
 *     before page two is asked for — and every later page merges into the
 *     layout already on screen (dense indices never move) and reheats the sim
 *     to `alpha(0.5)`, never 1. New nodes are seeded at a neighbour's position
 *     so a page grows out of the graph instead of flying in from a spiral.
 *  2. **`truncated` is said out loud, in plain words, with the fix attached.**
 *     "showing the 5,000 most-connected of 41,208 objects; filter by type or
 *     date to see the rest" — and the type legend and the recency select sit
 *     directly under that sentence, because a sentence telling you to filter
 *     somewhere else is a lie. There is no silent sampling anywhere in this
 *     file.
 *  3. **The client half of the privacy rule.** The server returns an edge only
 *     when BOTH endpoints are visible and counts `degree` over visible edges
 *     only; `GraphStore.ingest` DROPS an edge naming a node it was never
 *     given rather than drawing a placeholder, which would re-create exactly
 *     the hidden-neighbour hint the visible-only-degree rule prevents. Nothing
 *     here reconstructs, infers or displays a node the server did not send.
 *  4. **It is a mount point, not a monolith.** The shortest-path, hubs,
 *     scrubber, selection-bar, presence and saved-view tasks all plug in
 *     through the exported contract below (`useGraphEngine`,
 *     `GraphCameraHandle`, `useGraphSelection`) and render as CHILDREN of this
 *     view, so none of them has to edit this file to exist.
 *
 * Reduced motion is checked directly against the media query for the camera
 * easing, exactly as the old view did: these are canvas pixels, and a global
 * `* { transition: none }` reset cannot reach them.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { X } from "lucide-react";

import { api, type GraphPageResponse } from "../lib/api";
import type { WhereNode } from "../lib/viewConfig";
import { Empty, Spinner, TypeIcon } from "../components/bits";
import { Button } from "@/components/ui/button";
import { registerTypeIcons, fmtNumber, typeName } from "../lib/ui";
import { useTheme } from "../lib/theme";
import { usePeek } from "../lib/peek";
import { readPeekWidth } from "../lib/peekWidth";
import {
  GraphControls,
  GLOBAL_CONTROL_DEFAULTS,
  forcesFrom,
  recencySince,
  useGraphControls,
  type GraphControlValues,
  type GraphTypeCount,
  type RecencyKey,
} from "../components/graph/GraphControls";
import { GraphStore } from "../lib/graph/store";
import { buildCsr } from "../lib/graph/csr";
import { PhysicsHandle, linksFromCsr } from "../lib/graph/physics";
import { createGraphRenderer, type FitInsets, type GraphRenderer } from "../lib/graph/renderer";
import {
  LabelOverlay,
  createSettleDebounce,
  labelTextFor,
  selectLabels,
  type LabelDrawItem,
  type LabelSelection,
  type SettleDebounce,
} from "../lib/graph/labels";
import { forcedLabels, hoverHighlight, selectionHighlight } from "../lib/graph/highlight";
import { useGraphSearch } from "../components/graph/GraphSearch";
import { ballOf, bfs } from "../lib/graph/analysis";
import {
  budgetReached,
  deviceCapCopy,
  graphBudget,
  readDeviceProfile,
  type GraphBudget,
} from "../lib/graph/mobile";
import type { CameraState, Csr, GraphNode, HighlightSet } from "../lib/graph/types";

/* ------------------------------------------------------------------ *
 * contracts other phase-6 tasks mount against
 * ------------------------------------------------------------------ */

/** Rows per page of the whole-brain walk. The server clamps to the same cap. */
export const GRAPH_PAGE_SIZE = 5000;

/** How many titles a search may light up at once before it stops meaning much. */
export const SEARCH_MATCH_CAP = 500;

/**
 * Below this GRAPH-PANE width (CSS px) the desktop overlay panels collide, so
 * the layout collapses to sheets exactly as it does on touch. The left controls
 * rail is `left-3 w-64` → x∈[12,268]; the insight panel and peek are `right-3
 * w-72` → x∈[paneW-300, paneW-12]; they overlap once `paneW < 568`. 640 keeps a
 * margin. Measured on the PANE (viewport minus the app sidebar), not the
 * viewport, so a sidebar-open window in the 768–830px band is caught where a
 * viewport breakpoint (`useIsMobile`, 768) would miss it. */
const GRAPH_COMPACT_WIDTH = 640;

/** Pointer travel (Manhattan, CSS px) that turns a click into a node drag. */
const DRAG_SLOP_PX = 3;

/**
 * The idle breath (see the effect that uses these). `BREATH_ALPHA` is the whole
 * design: `reheat()` defaults to 0.5 and a drag holds 0.3, so ~0.02 is a
 * whisper — enough that nodes drift and the map reads as alive, far too little
 * to re-arrange anything. Alpha decays at 0.0228/tick toward `alphaMin` 0.001,
 * so one breath is roughly four seconds of motion and then the simulation
 * sleeps again at ~0% CPU; the period leaves a clear pause between breaths.
 */
const BREATH_ALPHA = 0.015;
/** Stillness required before breathing resumes — a zoom or drag suppresses it. */
const BREATH_IDLE_MS = 4_000;
/**
 * How often the breath is topped up. This is deliberately MUCH shorter than the
 * ~4s it takes alpha to decay from BREATH_ALPHA to alphaMin: one nudge per
 * decay produced a visible move-stop-move pulse, so instead the alpha is
 * re-topped long before it runs out and the drift is CONTINUOUS while idle.
 * Coming to rest is then the response to being touched, and only that — the
 * top-ups stop, the last one decays out over a couple of seconds, and the
 * simulation sleeps at ~0% CPU until you are idle again.
 */
const BREATH_PERIOD_MS = 1_500;

/**
 * The highlight layers, most authoritative first.
 *
 * They are LAYERS rather than one slot because several features want the
 * dimming at the same time and the answer to "which wins" must be a constant,
 * not whichever effect ran last: a shortest path you asked for outranks a
 * selection you built, which outranks a search you typed, which outranks the
 * scrubber's window, which outranks the hover you are merely passing over.
 */
export type GraphHighlightSource = "path" | "selection" | "focus" | "search" | "changed" | "hover";

// Exported for test/src/graph-e2e.test.ts, which reaches it via a DYNAMIC
// import (GRAPH_VIEW_MODULE) — invisible to knip and typecheck, so removing
// this export breaks e2e at runtime, not at build time. Keep it exported.
export const HIGHLIGHT_PRIORITY: readonly GraphHighlightSource[] = [
  "path",
  "selection",
  // The node you clicked, plus its neighbours. Below an explicit selection (you
  // built that on purpose) and above a search, because clicking a node is the
  // most recent and most specific thing you said you cared about. Without it a
  // click centred a node and left it visually identical to the several hundred
  // around it — "I don't even see which one it centred on".
  "focus",
  "search",
  "changed",
  "hover",
];

/** The winning layer, or null when every layer is empty. */
export function resolveHighlight(
  layers: Readonly<Partial<Record<GraphHighlightSource, HighlightSet | null>>>,
): HighlightSet | null {
  for (const source of HIGHLIGHT_PRIORITY) {
    const set = layers[source];
    if (set !== undefined && set !== null && set.nodes.size > 0) return set;
  }
  return null;
}

/** The camera, as everything outside this file may touch it. */
export interface GraphCameraHandle {
  get: () => CameraState;
  set: (next: Partial<CameraState>) => void;
  /** ease to a camera state (jumps under `prefers-reduced-motion`). */
  ease: (next: Partial<CameraState>, durationMs?: number) => void;
  /** frame the whole graph. */
  fit: (paddingPx?: number) => void;
  /** back to the origin at 1:1. */
  reset: () => void;
  /** ease the camera onto a node, by dense index. */
  centerOn: (index: number, opts?: { scale?: number }) => void;
  /** wake the render loop after an external change. */
  invalidate: () => void;
}

/** What the progressive load is doing right now. */
export interface GraphLoadState {
  phase: "loading" | "ready" | "error";
  /** nodes/edges assembled SO FAR — the first page paints against these. */
  nodes: number;
  edges: number;
  pages: number;
  /** the server fell back to the top-degree sample; say so out loud. */
  truncated: { shown: number; total: number; reason: "size" } | null;
  /**
   * Edges dropped because an endpoint never arrived (deleted or made private
   * mid-walk). Surfaced rather than swallowed — churn is honest, a placeholder
   * node would not be.
   */
  droppedEdges: number;
  /**
   * The CLIENT stopped the walk because this device cannot draw more (see
   * `graphBudget` in lib/graph/mobile.ts) — distinct from `truncated`, which is
   * the SERVER saying the query was too big. Optional so nothing that builds a
   * load state has to know about phones.
   */
  deviceCapped?: { shown: number } | null;
  error: string | null;
}

/** The server-side filter the view is loaded with. */
export interface GraphFilterState {
  /** types kept; empty = every type. `null` is the untyped bucket. */
  types: ReadonlySet<string | null>;
  recency: RecencyKey;
}

/**
 * The engine, as a mounted child sees it. Everything here is stable for the
 * life of the view EXCEPT the plain data fields (`nodes`, `csr`, `revision`,
 * `load`, `highlight`, `selection`, `focus`), which change identity when they
 * change value so a child re-renders.
 */
export interface GraphEngine {
  readonly store: GraphStore;
  /** dense-index-ordered; index i is `store.idAt(i)`. Do not mutate. */
  readonly nodes: readonly GraphNode[];
  readonly csr: Csr | null;
  /** bumps whenever a page lands — derive memos from this. */
  readonly revision: number;
  readonly renderer: GraphRenderer | null;
  readonly physics: PhysicsHandle | null;
  readonly camera: GraphCameraHandle;
  /** install (or clear, with null) one highlight layer. */
  setHighlight: (source: GraphHighlightSource, set: HighlightSet | null) => void;
  readonly highlight: HighlightSet | null;
  readonly selection: ReadonlySet<number>;
  select: (indices: Iterable<number>, mode?: "replace" | "add" | "toggle") => void;
  clearSelection: () => void;
  /** the node the peek panel is on, by dense index. */
  readonly focus: number | null;
  setFocus: (index: number | null) => void;
  readonly hover: number | null;
  readonly load: GraphLoadState;
  /** re-run the paged walk from page one. */
  reload: () => void;
  readonly filters: GraphFilterState;
  setFilters: (next: GraphFilterState) => void;
  readonly controls: GraphControlValues;
  setControls: (patch: Partial<GraphControlValues>) => void;
  indexOf: (id: string) => number | undefined;
  idAt: (index: number) => string | undefined;
  /**
   * A mounted overlay reserves screen space that `camera.fit` must frame AROUND
   * (its own on-screen rectangle, in CSS px from each edge), or clears it with
   * `null` when it closes. Keyed per overlay so several can contribute at once;
   * the largest reserve per edge wins. On touch every reserve is ignored (the
   * panels are sheets that start closed). This is how the insight panel keeps
   * "fit" from framing content behind it.
   */
  reserveFit: (key: string, insets: FitInsets | null) => void;
  /**
   * Touch OR a narrow graph pane — the ONE signal every overlay keys its
   * layout off, identical to the flag GraphView uses for its own rail and
   * legend. Child overlays (the insight panel, the top-centre menu/search/
   * scrubber column) must collapse to full-width bottom sheets when this is
   * true, exactly as the built-in chrome does, or they paint floating desktop
   * panels on top of each other on a phone. Sharing it here (rather than each
   * overlay re-deriving it from `useIsMobile`) is what keeps the narrow-pane
   * case — a fine-pointer window too small for the wide layout — in agreement.
   */
  readonly compact: boolean;
}

const GraphEngineContext = createContext<GraphEngine | null>(null);

/** The engine, from inside `<GraphView>`. Throws outside it, on purpose. */
export function useGraphEngine(): GraphEngine {
  const engine = useContext(GraphEngineContext);
  if (engine === null) {
    throw new Error("useGraphEngine must be used inside <GraphView>");
  }
  return engine;
}

/* ------------------------------------------------------------------ *
 * pure helpers (tested directly)
 * ------------------------------------------------------------------ */

/**
 * The truncation sentence, in plain words with the fix named. The type legend
 * and the recency select sit right under it.
 */
export function truncationCopy(truncated: { shown: number; total: number }): string {
  return (
    `showing the ${fmtNumber(truncated.shown)} most-connected of ` +
    `${fmtNumber(truncated.total)} objects; filter by type or date to see the rest`
  );
}

/**
 * The filter state as the phase-3 `where` AST the route accepts (`type`
 * eq/in/is_null and `updated_at` gte, combined with `and`). Returns undefined
 * when nothing is filtered, so the query string stays empty.
 */
export function graphWhere(
  filters: GraphFilterState,
  now: number = Date.now(),
): WhereNode | undefined {
  const terms: WhereNode[] = [];
  const types = [...filters.types];
  if (types.length === 1) {
    const only = types[0]!;
    terms.push(
      only === null ? { field: "type", op: "is_null" } : { field: "type", op: "eq", value: only },
    );
  } else if (types.length > 1) {
    terms.push({ field: "type", op: "in", value: types });
  }
  const since = recencySince(filters.recency, now);
  if (since !== null) terms.push({ field: "updated_at", op: "gte", value: since });
  if (terms.length === 0) return undefined;
  if (terms.length === 1) return terms[0]!;
  return { and: terms };
}

/** A stable key for a filter state — the load effect's dependency. */
export function filterKey(filters: GraphFilterState): string {
  const types = [...filters.types].map((t) => t ?? "(untyped)").sort();
  return `${filters.recency}|${types.join(",")}`;
}

/** Type counts over the loaded nodes, most-populous first — the legend. */
export function typeCounts(
  nodes: readonly GraphNode[],
  catalog: ReadonlyArray<{ name: string; count: number }> = [],
): GraphTypeCount[] {
  const counts = new Map<string | null, number>();
  // Everything in the load first...
  for (const n of nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  // ...then the catalog's TRUE counts overwrite them, and add every type the
  // load does not contain. A filtered-out type keeps its real number instead of
  // showing 0, which read as "there are none of these" while the filter was in
  // fact working perfectly.
  for (const t of catalog) counts.set(t.name, t.count);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || (a.type ?? "").localeCompare(b.type ?? ""));
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The device's budget, re-read on resize and rotation.
 *
 * The CAPS (nodes, edges, page size, label count) are live: rotating a phone
 * into landscape, or dragging a desktop window down to phone width, re-reads
 * them on the next paint. The RENDERER's two — `resolution` and `antialias` —
 * are read once at mount and deliberately not re-applied, because changing
 * either means tearing down and rebuilding the WebGL context, and a graph that
 * blanks for a second every time you rotate the phone is worse than one drawn
 * at the resolution it started with.
 */
function useGraphBudget(): GraphBudget {
  const [budget, setBudget] = useState<GraphBudget>(() => graphBudget(readDeviceProfile()));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reread = (): void => {
      const next = graphBudget(readDeviceProfile());
      setBudget((prev) =>
        prev.device === next.device &&
        prev.maxNodes === next.maxNodes &&
        prev.labelCap === next.labelCap
          ? prev
          : next,
      );
    };
    window.addEventListener("resize", reread);
    window.addEventListener("orientationchange", reread);
    return () => {
      window.removeEventListener("resize", reread);
      window.removeEventListener("orientationchange", reread);
    };
  }, []);
  return budget;
}

/* ------------------------------------------------------------------ *
 * the view
 * ------------------------------------------------------------------ */

interface GraphViewProps {
  /**
   * Overlays mounted over the canvas (shortest path, hubs, the scrubber, the
   * selection bar, presence avatars). They call `useGraphEngine()` rather than
   * taking props, which is what keeps them out of this file.
   */
  children?: ReactNode;
  /**
   * Chrome pinned to the TOP OF THE CONTROLS RAIL rather than floating over the
   * map — currently the saved-views menu. A saved view is a snapshot of exactly
   * what the rail below it holds (filters, recency, layout, camera), so it
   * belongs against those controls, not in a chip over the middle of the graph.
   * Same move the search box already made ("The overlay is gone; the rail box
   * is the search" — GraphOverlays' header). A slot rather than an import here
   * because the menu is keyed by ACCOUNT and this view has no user.
   */
  rail?: ReactNode;
}

export function GraphView({ children, rail }: GraphViewProps = {}) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // One store for the life of the view; its identity is stable, so every
  // callback below closes over the same object.
  const [store] = useState(() => new GraphStore());
  const nodesRef = useRef<GraphNode[]>([]);
  const csrRef = useRef<Csr | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const physicsRef = useRef<PhysicsHandle | null>(null);
  const overlayRef = useRef<LabelOverlay | null>(null);

  const [revision, setRevision] = useState(0);
  const [load, setLoad] = useState<GraphLoadState>({
    phase: "loading",
    nodes: 0,
    edges: 0,
    pages: 0,
    truncated: null,
    droppedEdges: 0,
    error: null,
  });
  const [reloadNonce, setReloadNonce] = useState(0);
  /** Every type the BRAIN has WITH its true count — not just what this load holds. */
  const [catalogTypes, setCatalogTypes] = useState<ReadonlyArray<{ name: string; count: number }>>(
    [],
  );
  const [engineError, setEngineError] = useState<string | null>(null);
  // The auto-fit contract, read by the physics subscription below: keep
  // re-framing the WHOLE graph on every settle for as long as pages are still
  // arriving (each page widens the layout, and a camera framed on page 1 leaves
  // the rest off-screen — the "starts way too zoomed in" bug), and stop the
  // moment the viewer drives the camera themselves.
  const loadPhaseRef = useRef(load.phase);
  loadPhaseRef.current = load.phase;
  const autoFitRef = useRef(true);
  /** Wall-clock of the last pointer/wheel/camera-key — the idle breath's gate. */
  const lastInteractionRef = useRef(0);
  /**
   * Has the layout come to rest at least once on this load? The idle breath
   * waits for it, and MUST: a continuous breath means the simulation never
   * reports `settled`, so starting it before the first real settle would leave
   * auto-fit armed forever and the camera would re-frame on every breath —
   * a map that quietly zooms in and out by itself. First settle, then breathe.
   */
  const settledOnceRef = useRef(false);
  // Set when a `?focus=<id>` handoff lands on a graph that does not contain its
  // target — the object sorts outside a device-capped (or filtered) load, so the
  // "open full graph here" door opened onto a map missing the very object it
  // promised to centre. Surfaced in the status line instead of silently doing
  // nothing (the camera would otherwise just not move, with no explanation).
  const [focusMissed, setFocusMissed] = useState(false);
  const [filters, setFiltersState] = useState<GraphFilterState>({
    types: new Set<string | null>(),
    recency: "all",
  });
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocusState] = useState<number | null>(null);
  const [selection, setSelectionState] = useState<ReadonlySet<number>>(new Set<number>());
  const [highlight, setHighlightState] = useState<HighlightSet | null>(null);

  const budget = useGraphBudget();
  const touchUi = budget.device !== "desktop";
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  // The desktop overlay layout also collapses to sheets when the GRAPH PANE is
  // narrow — not only on a touch device. `deviceClassOf` returns "desktop" for
  // any fine-pointer window regardless of width, so a mouse window at ~800px
  // with the app sidebar open (pane ~550px) kept the wide layout and its three
  // floating panels overlapped (controls unreachable). Measure the pane and fold
  // narrow into `compact`, the flag every layout switch below now keys off.
  const [narrowPane, setNarrowPane] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      if (width > 0) setNarrowPane(width < GRAPH_COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The viewer touching the map ends auto-fit for good — capture phase, so a
  // drag or a wheel counts even though the renderer's own listeners consume it.
  // The same signal timestamps the last interaction, which is what the idle
  // breath below waits on.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const stop = () => {
      autoFitRef.current = false;
      lastInteractionRef.current = Date.now();
    };
    el.addEventListener("pointerdown", stop, { capture: true });
    el.addEventListener("wheel", stop, { capture: true, passive: true });
    return () => {
      el.removeEventListener("pointerdown", stop, { capture: true });
      el.removeEventListener("wheel", stop, { capture: true });
    };
  }, []);

  // THE IDLE BREATH — a settled force layout is a still image, and a still
  // image of a living brain reads as a screenshot. Every BREATH_PERIOD_MS of
  // genuine idleness the simulation is reheated to BREATH_ALPHA: two orders of
  // magnitude under the 0.5 a real nudge uses, so nodes drift a pixel or two
  // and re-settle rather than re-laying-out. It is the EXISTING simulation, not
  // a second animator — nothing here can disagree with the layout.
  //
  // It is deliberately idle-gated rather than continuous: any pointer, wheel or
  // camera key stamps `lastInteractionRef`, and the breath skips until you have
  // been still again for IDLE_MS. So it never competes with a zoom or a drag,
  // and it never fires while a load is still settling the layout for real.
  //
  // `prefers-reduced-motion` switches it OFF, checked per tick because the
  // setting can change under a running page. A decorative animation with no
  // end is the single clearest case that media query exists for — and it is
  // also what keeps "wait for the graph to stop moving" a thing that can still
  // succeed, for the mobile e2e and for any pixel-diff tooling.
  useEffect(() => {
    const id = setInterval(() => {
      if (prefersReducedMotion()) return;
      if (!settledOnceRef.current) return;
      if (Date.now() - lastInteractionRef.current < BREATH_IDLE_MS) return;
      physicsRef.current?.reheat(BREATH_ALPHA);
    }, BREATH_PERIOD_MS);
    return () => clearInterval(id);
  }, []);
  const compact = touchUi || narrowPane;
  const compactRef = useRef(compact);
  compactRef.current = compact;
  // "Fit" aims at the region left clear by the floating controls, not the raw
  // viewport. On desktop exactly ONE occluder is always mounted — the left
  // controls rail (left-3 + w-64) — so it alone is the base reserve.
  //
  // The base used to also carry `top: 108` for a top-centre menu/search/scrubber
  // column. That column no longer exists on desktop (the views menu moved into
  // the rail, the scrubber into the bottom-right corner), and reserving a strip
  // for chrome that isn't there pushed the whole map DOWN and, with the left
  // reserve, hard into the bottom-right — visibly off-centre, crowding the very
  // panel it was meant to avoid. Reserve what is actually on screen, nothing
  // more.
  //
  // The bottom-right scrubber deliberately gets NO reserve: it occupies a
  // CORNER, and reserving a full-width bottom strip (or full-height right
  // column) for a corner costs far more framing than the overlap it prevents.
  // Overlays that come and go and DO span an edge — the insight panel, a
  // top-3 right-3 w-72 column when opened — still reserve through `reserveFit`.
  // On touch the rail and panel are sheets that start closed, so nothing is
  // reserved.
  const overlayInsetsRef = useRef<Map<string, FitInsets>>(new Map());
  const reserveFit = useCallback((key: string, insets: FitInsets | null): void => {
    if (insets === null) overlayInsetsRef.current.delete(key);
    else overlayInsetsRef.current.set(key, insets);
  }, []);
  const computeFitInsets = useCallback((): FitInsets => {
    // Compact (touch OR a narrow pane) collapses the rail and peek to sheets that
    // start closed, so nothing is reserved — the same rule touch always had.
    if (compactRef.current) return {};
    const merged = { left: 284, top: 0, right: 0, bottom: 0 };
    for (const ins of overlayInsetsRef.current.values()) {
      merged.left = Math.max(merged.left, ins.left ?? 0);
      merged.right = Math.max(merged.right, ins.right ?? 0);
      merged.top = Math.max(merged.top, ins.top ?? 0);
      merged.bottom = Math.max(merged.bottom, ins.bottom ?? 0);
    }
    return merged;
  }, []);
  /** The long-press menu: touch's stand-in for right-click and hover chrome. */
  const [nodeMenu, setNodeMenu] = useState<number | null>(null);
  /** The controls rail, collapsed by default on a phone (it is 264px wide). */
  const [railOpen, setRailOpen] = useState(false);

  /**
   * The SIDE PEEK is the panel a click opens — and it is not one of ours: the
   * shell renders it from `?peek=<id>`, outside this view entirely, ~180ms
   * after the click (NodePeekBridge). So it can neither reserve its own space
   * nor be waited on by effect ordering, and left alone it slides in over the
   * very node the click just centred. Reserving its width here is what makes
   * "centre in the space available" true for the panel that the click itself
   * caused.
   *
   * ponytail: the width is read from storage, so dragging the peek's resizer
   * while it is open does not re-reserve until the next centre. Publish the
   * live width from SidePeek if that ever matters.
   */
  const { top: peekTop, closeAllPeeks } = usePeek();
  // The renderer's handlers are installed ONCE (they are DOM listeners on a
  // canvas that outlives every render), and `closeAllPeeks` changes identity on
  // every URL change — so it goes through a latest-value ref like the rest of
  // this file's callbacks, or the click would call a closure from page load.
  const closePeeksRef = useRef(closeAllPeeks);
  closePeeksRef.current = closeAllPeeks;
  useEffect(() => {
    reserveFit("peek", peekTop === null ? null : { right: readPeekWidth() });
    return () => reserveFit("peek", null);
  }, [peekTop, reserveFit]);

  const {
    values: controls,
    set: setControls,
    reset: resetControls,
  } = useGraphControls("global", GLOBAL_CONTROL_DEFAULTS);

  /** The load effect's (and the worker's) dependency — see below. */
  const filtersKey = useMemo(() => filterKey(filters), [filters]);

  // Latest-value refs: the renderer's callbacks are installed once (they are
  // DOM listeners on a canvas that lives for the life of the view), so they
  // must not close over a stale render's state.
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const highlightRef = useRef<HighlightSet | null>(highlight);
  highlightRef.current = highlight;
  const hoverRef = useRef<number | null>(hover);
  hoverRef.current = hover;
  const focusRef = useRef<number | null>(focus);
  focusRef.current = focus;
  const layersRef = useRef<Partial<Record<GraphHighlightSource, HighlightSet | null>>>({});
  const labelSelectionRef = useRef<LabelSelection>({
    alpha: 0,
    indices: [],
    forcedCount: 0,
    droppedToCap: 0,
  });
  const labelStyleRef = useRef({
    fontFamily: "system-ui, sans-serif",
    color: "#71717a",
    haloColor: "#ffffff",
  });

  /* ---------------- highlight layers ---------------- */

  const applyHighlight = useCallback(() => {
    const next = resolveHighlight(layersRef.current);
    highlightRef.current = next;
    setHighlightState(next);
    rendererRef.current?.setHighlight(next);
  }, []);

  const setHighlight = useCallback(
    (source: GraphHighlightSource, set: HighlightSet | null) => {
      layersRef.current[source] = set;
      applyHighlight();
    },
    [applyHighlight],
  );

  /* ---------------- labels ---------------- */

  const recomputeLabels = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const nodes = nodesRef.current;
    const forced = new Set<number>();
    const fromHighlight = forcedLabels(highlightRef.current);
    if (fromHighlight) for (const i of fromHighlight) forced.add(i);
    if (hoverRef.current !== null) forced.add(hoverRef.current);
    if (focusRef.current !== null) forced.add(focusRef.current);
    labelSelectionRef.current = selectLabels({
      visible: renderer.visibleNodes(),
      cameraScale: renderer.getCamera().scale,
      threshold: controlsRef.current.labelThreshold,
      radiusOf: (i) => renderer.radiusAt(i),
      degreeOf: (i) => nodes[i]?.degree ?? 0,
      forced,
      // The label pass is a full-width 2D canvas redraw per frame, which is
      // the single most expensive thing on the page on a phone. The cap comes
      // from the device budget, not the slider.
      cap: budgetRef.current.labelCap,
    });
    renderer.invalidate();
  }, []);

  const recomputeLabelsRef = useRef(recomputeLabels);
  recomputeLabelsRef.current = recomputeLabels;
  // Clears the rail search — assigned from `graphSearch.clear` once that hook is
  // set up below. A ref because the canvas keyboard handler (Escape) is defined
  // before the hook and must not carry it as a dependency.
  const clearSearchRef = useRef<() => void>(() => {});
  const settleRef = useRef<SettleDebounce | null>(null);
  /** The label-set debounce, created once on first use. */
  const settle = useCallback((): SettleDebounce => {
    if (settleRef.current === null) {
      settleRef.current = createSettleDebounce(() => recomputeLabelsRef.current());
    }
    return settleRef.current;
  }, []);

  /* ---------------- camera ---------------- */

  const cameraAnim = useRef<number | null>(null);
  const easeCamera = useCallback((next: Partial<CameraState>, duration = 320) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (cameraAnim.current !== null) cancelAnimationFrame(cameraAnim.current);
    const from = renderer.getCamera();
    const to: CameraState = {
      x: next.x ?? from.x,
      y: next.y ?? from.y,
      scale: next.scale ?? from.scale,
    };
    if (prefersReducedMotion() || duration <= 0) {
      renderer.setCamera(to);
      return;
    }
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min((now - t0) / duration, 1);
      const e = 1 - Math.pow(1 - t, 3);
      renderer.setCamera({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        scale: from.scale + (to.scale - from.scale) * e,
      });
      cameraAnim.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    cameraAnim.current = requestAnimationFrame(step);
  }, []);

  /**
   * EVERY deliberate camera move ends auto-fit — the same way a pan or a wheel
   * does. Without this, `?focus=<id>` (the object page's "full graph →") centred
   * on its target and the auto-fit re-framed the whole graph a frame later, so
   * the door opened onto a map that pointedly ignored what you came for. It was
   * never specific to that link: search-centre, the peek's centre and the Fit
   * button were all being overruled the same way, silently.
   *
   * The auto-fit itself does NOT go through this handle — it calls
   * `renderer.fit` directly — so disarming here cannot fight it.
   */
  const takeCamera = useCallback(() => {
    autoFitRef.current = false;
    lastInteractionRef.current = Date.now();
  }, []);

  const camera = useMemo<GraphCameraHandle>(
    () => ({
      get: () => rendererRef.current?.getCamera() ?? { x: 0, y: 0, scale: 1 },
      set: (next) => {
        takeCamera();
        rendererRef.current?.setCamera(next);
      },
      ease: (next, duration) => {
        takeCamera();
        easeCamera(next, duration);
      },
      fit: (padding) => {
        takeCamera();
        rendererRef.current?.fit(padding, computeFitInsets());
      },
      reset: () => {
        takeCamera();
        easeCamera({ x: 0, y: 0, scale: 1 });
      },
      centerOn: (index, opts) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        const xy = renderer.positions();
        const x = xy[2 * index];
        const y = xy[2 * index + 1];
        if (x === undefined || y === undefined) return;
        takeCamera();
        const scale = Math.max(renderer.getCamera().scale, opts?.scale ?? 1.3);
        // Land it in the space the panels LEAVE CLEAR, not the raw viewport
        // centre — "centred" behind the insight panel is not centred, it is
        // hidden. Same reserves `fit` frames around; a node has no extent, so
        // the clear rect's own centre is the whole answer here.
        const ins = computeFitInsets();
        const dx = ((ins.left ?? 0) - (ins.right ?? 0)) / 2;
        const dy = ((ins.top ?? 0) - (ins.bottom ?? 0)) / 2;
        easeCamera({ x: x - dx / scale, y: y - dy / scale, scale });
      },
      invalidate: () => rendererRef.current?.invalidate(),
    }),
    [easeCamera, computeFitInsets, takeCamera],
  );

  useEffect(
    () => () => {
      if (cameraAnim.current !== null) cancelAnimationFrame(cameraAnim.current);
      settleRef.current?.cancel();
    },
    [],
  );

  /**
   * FOCUS MOVES THE CAMERA — one rule, one place. Anything that focuses a node
   * (a click on the canvas, a search landing, the `?focus=` handoff from an
   * object's local graph) centres and zooms to it. HOVER deliberately does
   * not: hovering is how you read a neighbourhood without losing your place.
   * The one hover that does move the camera is the insight panel's, which
   * calls `camera.centerOn` itself — that is a list of links, not the map.
   *
   * This is an EFFECT rather than a line in the click handler, and that is the
   * whole trick: clicking opens the peek, which reserves screen space, and a
   * centre computed during the click would use the insets from BEFORE the
   * panel existed and drop the node behind it. React runs a child's effects
   * before its parent's, so by the time this runs the peek has mounted and
   * called `reserveFit`, and `centerOn` sees the space the click actually left.
   */
  useEffect(() => {
    if (focus === null) {
      setHighlight("focus", null);
      return;
    }
    // Light it AND its neighbours. Centring alone is invisible on a dense map
    // — the node lands dead centre looking exactly like the four hundred
    // around it — so the camera move and the halo are one gesture, not two.
    const csr = csrRef.current;
    setHighlight("focus", csr === null ? null : hoverHighlight(csr, focus));
    camera.centerOn(focus);
    // Deliberately NOT keyed on `peekTop` — see the effect below for why the
    // peek OPENING re-centres and the peek CLOSING must not.
  }, [focus, camera, setHighlight, revision]);

  /**
   * The peek OPENING re-centres; the peek CLOSING never does.
   *
   * Opening has to: the panel arrives ~180ms after the click that caused it and
   * takes ~520px of the width, so the centre computed at click time framed a
   * viewport that no longer exists and left the node under the panel.
   *
   * Closing must not, and this is the asymmetry that matters. When the panel
   * goes the map gets WIDER — nothing is hidden, everything that was on screen
   * still is. Re-centring there would slide the whole graph out from under you
   * at the exact moment you are reaching for something you just spotted. Space
   * you gained is not a reason to move; space you lost is.
   */
  useEffect(() => {
    if (peekTop === null) return;
    const index = focusRef.current;
    if (index === null) return;
    camera.centerOn(index);
  }, [peekTop, camera]);

  /* ---------------- selection & focus ---------------- */

  const select = useCallback(
    (indices: Iterable<number>, mode: "replace" | "add" | "toggle" = "replace") => {
      setSelectionState((prev) => {
        const next = mode === "replace" ? new Set<number>() : new Set(prev);
        for (const i of indices) {
          if (mode === "toggle" && next.has(i)) next.delete(i);
          else next.add(i);
        }
        return next;
      });
    },
    [],
  );

  const clearSelection = useCallback(() => setSelectionState(new Set<number>()), []);

  const setFocus = useCallback((index: number | null) => {
    setFocusState(index);
    focusRef.current = index;
    recomputeLabelsRef.current();
  }, []);

  // The selection is a highlight layer, not a second dimming system.
  useEffect(() => {
    const csr = csrRef.current;
    if (selection.size === 0 || csr === null) setHighlight("selection", null);
    else setHighlight("selection", selectionHighlight(csr, selection));
  }, [selection, revision, setHighlight]);

  /**
   * CLOSING THE PEEK IS "I'm done with that one" — the halo goes with it and
   * the map comes back to full brightness, in ONE click, with the camera left
   * exactly where it is.
   *
   * It has to live here rather than in the canvas click handler because the
   * peek is a `fixed inset-0` overlay WITH A BACKDROP: a click anywhere over
   * the graph while it is open is swallowed by that backdrop and never reaches
   * the canvas at all. So the first click only dismissed the panel and the
   * second was the one that finally cleared the highlight — the two-click
   * behaviour. Reacting to the CLOSE catches every way it can happen (backdrop,
   * the × button, Escape, browser back), not just the one we can intercept.
   */
  const hadPeekRef = useRef(false);
  useEffect(() => {
    const had = hadPeekRef.current;
    hadPeekRef.current = peekTop !== null;
    if (!had || peekTop !== null) return;
    setFocus(null);
    clearSelection();
  }, [peekTop, setFocus, clearSelection]);

  // The "search" highlight layer has exactly ONE owner: the `useGraphSearch`
  // instance hoisted below (`graphSearch`), surfaced through the rail's search
  // box. GraphView used to ALSO own it from a second, local `matchIndices`
  // state, so an empty rail box wiped the layer on every page landing — two
  // owners fighting over one layer. That local owner is gone; the single hook
  // installs, updates and releases the layer.

  /* ---------------- the rail's "full graph →" handoff ---------------- */

  // `/graph?focus=<id>&depth=<1..3>`, written by the object page's local graph
  // (`fullGraphHref` in components/LocalGraph.tsx). Crossing over from the rail
  // must not cost you your place, so we centre the camera on the object and
  // carry the LOCAL BALL over as the selection — which is already a highlight
  // layer, so the neighbourhood lights up and everything else dims with no
  // second mechanism. It runs ONCE per (focus, depth, load) rather than on
  // every revision: re-centring the camera under a user who has since panned
  // away would be worse than not honouring the link at all.
  const handoffRef = useRef<string | null>(null);
  useEffect(() => {
    const focusId = searchParams.get("focus");
    if (focusId === null || load.phase !== "ready") return;
    const depthParam = Number.parseInt(searchParams.get("depth") ?? "1", 10);
    const depth = Number.isFinite(depthParam) ? Math.min(3, Math.max(1, depthParam)) : 1;
    const key = `${focusId}|${depth}`;
    if (handoffRef.current === key) return;
    const csr = csrRef.current;
    if (csr === null) return;
    const index = store.indexOf(focusId);
    if (index === undefined) {
      // The focused object is not in this load (device cap or an active
      // filter dropped it) — the door opened onto a graph that omits its own
      // target. Say so; don't guess at something else to centre on. Leave
      // `handoffRef` UNSET so a later reload that includes it can still land.
      setFocusMissed(true);
      return;
    }
    handoffRef.current = key;
    setFocusMissed(false);
    setFocus(index);
    select(ballOf(bfs(csr, index, depth)));
    // No centring here: `setFocus` is what centres now (see the focus effect),
    // and doing it from inside this effect would run BEFORE the peek reserves
    // its space — landing the object you followed the link for underneath the
    // panel describing it.
  }, [searchParams, load.phase, store, camera, select, setFocus]);

  /* ---------------- the store → engine plumbing ---------------- */

  /**
   * Push the store's current state at the renderer and the worker.
   *
   * Dense indices never move, so this MERGES: the renderer reuses its sprites
   * and the worker keeps every settled position; only the tail is new. New
   * indices are seeded at an already-placed neighbour's position (+ jitter) so
   * a page grows out of the graph rather than flying in from d3's spiral.
   */
  const applyStore = useCallback((options: { reheat: boolean }) => {
    const nodes = nodesRef.current;
    const previousCount = nodes.length;
    for (let i = 0; i < store.order; i += 1) {
      const node = store.nodeAt(i);
      if (node === undefined) continue;
      nodes[i] = node;
    }
    nodes.length = store.order;

    const csr = buildCsr(store);
    csrRef.current = csr;
    // A SNAPSHOT, not the live array: `nodesRef` keeps growing in place as
    // pages land, and the renderer holds what it was handed across frames —
    // giving it the mutable array would let it read a node it has no sprite
    // for between two `setGraph` calls. Copying 5,000 pointers is free.
    rendererRef.current?.setGraph(nodes.slice(), csr);

    const physics = physicsRef.current;
    if (physics) {
      const links = linksFromCsr(csr);
      const seed = seedPositions(rendererRef.current, csr, previousCount, nodes.length);
      physics.updateData(
        seed === null
          ? { nodeCount: nodes.length, links }
          : { nodeCount: nodes.length, links, seed },
      );
      physics.start();
      if (options.reheat) physics.reheat(0.5);
    }
    setRevision(store.revision);
    recomputeLabelsRef.current();
  }, []);

  /* ---------------- renderer ---------------- */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;

    const pointerIn = (event: PointerEvent): { x: number; y: number } => {
      const rect = container.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    // Per-frame label overlay scratch, pooled for the life of this renderer the
    // same way `renderer.ts` reuses its `visible`/`renderXY` buffers: `onFrame`
    // runs at up to 60fps during a pan/zoom, and a fresh array + one object per
    // visible label EVERY frame is exactly the minor-GC churn the rest of the
    // pipeline is built to avoid. `overlay.draw` consumes the items
    // synchronously and retains nothing, so mutating pooled objects in place is
    // safe. `labelItems.length` is trimmed to the fill count each frame so
    // `draw` never sees a stale trailing entry.
    type MutableLabelItem = { -readonly [K in keyof LabelDrawItem]: LabelDrawItem[K] };
    const labelItemPool: MutableLabelItem[] = [];
    const labelItems: LabelDrawItem[] = [];

    createGraphRenderer({
      container,
      theme,
      linkDistance: controlsRef.current.linkDistance,
      nodeSizeScale: controlsRef.current.nodeSize,
      resolution: budgetRef.current.resolution,
      antialias: budgetRef.current.antialias,
      hover: budgetRef.current.hoverIsolation,
      onLongPress: (index) => {
        if (index === null) {
          setNodeMenu(null);
          return;
        }
        setFocus(index);
        setNodeMenu(index);
        // A menu that arrives silently under a thumb reads as a glitch; the
        // buzz is what makes it read as "you did that".
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(8);
        }
      },
      onHover: (index) => {
        setHover(index);
        hoverRef.current = index;
        const csr = csrRef.current;
        setHighlight("hover", index === null || csr === null ? null : hoverHighlight(csr, index));
        recomputeLabelsRef.current();
      },
      onPick: (index, event) => {
        if (index === null) {
          // Clicking empty canvas is "I'm done with that one": the peek closes,
          // the halo goes, everything comes back up to full brightness — and
          // the camera stays exactly where you left it.
          //
          // Closing the peek is what makes that ONE click instead of two. The
          // focus and the open peek are two-way bound (NodePeekBridge pushes
          // `?peek=` down onto focus so a shared link lights the right node),
          // so clearing focus alone was immediately undone by the still-open
          // peek re-asserting itself — first click closed the panel, second
          // finally dropped the highlight.
          setFocus(null);
          if (!event.shiftKey) {
            clearSelection();
            closePeeksRef.current();
          }
          return;
        }
        if (event.shiftKey) select([index], "toggle");
        else {
          // A plain click REPLACES what was lit. Without this the ball a
          // `?focus=` handoff selected (or an earlier box-select) stayed lit
          // while you clicked around, so the map kept insisting a previous
          // thing mattered — the "those nodes are still highlighted" report.
          clearSelection();
          setFocus(index);
        }
      },
      onOpen: (index) => {
        const id = store.idAt(index);
        if (id !== undefined) navigate(`/o/${id}`);
      },
      onNodePointerDown: (index, down) => {
        const physics = physicsRef.current;
        const renderer = rendererRef.current;
        if (!physics || !renderer) return false;
        // A click is not a drag until the pointer actually TRAVELS. Treating
        // any pointermove as a drag meant a click with a pixel of hand-jitter
        // — or a trackpad tap, or a synthetic click, all of which emit a move
        // between down and up — silently selected nothing. You clicked a node,
        // the map did nothing, you clicked again holding stiller and it worked:
        // the "it takes two clicks" report. The marquee already uses a 3px
        // threshold for exactly this reason; this is the same number.
        const start = { x: down.clientX, y: down.clientY };
        let moved = false;
        const move = (ev: PointerEvent): void => {
          if (
            !moved &&
            Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) <= DRAG_SLOP_PX
          ) {
            return; // still a click, not yet a drag — do not pin the node
          }
          moved = true;
          const p = pointerIn(ev);
          const world = renderer.screenToWorld(p.x, p.y);
          // `drag: true` holds alphaTarget(0.3) until the matching unpin —
          // the layout stays live under your finger and settles after it.
          physics.pin(index, world.x, world.y, { drag: true });
        };
        const up = (e: PointerEvent): void => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          physics.unpin(index);
          if (!moved) {
            if (e.shiftKey) select([index], "toggle");
            else {
              clearSelection(); // a click replaces the lit set — same as onPick
              setFocus(index);
            }
          }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
        return true;
      },
      onCamera: () => {
        // The labelled SET is deliberately stale during a continuous zoom (the
        // labels ride along with their nodes) and snaps 100ms after it stops.
        settle().bump();
      },
      onFrame: (frame) => {
        const overlay = overlayRef.current;
        if (!overlay || !overlay.available) return;
        const dpr = typeof window === "undefined" ? 1 : (window.devicePixelRatio ?? 1);
        overlay.resize(frame.width, frame.height, dpr);
        const selectionOfLabels = labelSelectionRef.current;
        if (selectionOfLabels.indices.length === 0) {
          overlay.clear();
          return;
        }
        const hl = highlightRef.current;
        const nodes = nodesRef.current;
        const cam = frame.camera;
        let n = 0;
        for (let k = 0; k < selectionOfLabels.indices.length; k += 1) {
          const i = selectionOfLabels.indices[k]!;
          const wx = frame.positions[2 * i];
          const wy = frame.positions[2 * i + 1];
          if (wx === undefined || wy === undefined) continue;
          const dimmed = hl !== null && !hl.nodes.has(i) ? hl.dimAlpha : 1;
          const forcedHere = k < selectionOfLabels.forcedCount;
          const alpha = (forcedHere ? 1 : selectionOfLabels.alpha) * dimmed;
          if (alpha <= 0.01) continue;
          const id = store.idAt(i) ?? "";
          const item = (labelItemPool[n] ??= {} as MutableLabelItem);
          item.index = i;
          item.x = frame.width / 2 + (wx - cam.x) * cam.scale;
          item.y = frame.height / 2 + (wy - cam.y) * cam.scale;
          item.radius = (frame.radii[i] ?? 3) * cam.scale;
          item.text = labelTextFor(nodes[i]?.title, id);
          item.alpha = alpha;
          item.forced = forcedHere;
          labelItems[n] = item;
          n += 1;
        }
        labelItems.length = n;
        overlay.draw(labelItems, 1, labelStyleRef.current);
      },
    })
      .then((renderer) => {
        if (cancelled) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        renderer.setGraph(nodesRef.current.slice(), csrRef.current);
        renderer.setHighlight(highlightRef.current);
        const latest = physicsRef.current?.positions.latest;
        if (latest) renderer.setPositions(latest);
        recomputeLabelsRef.current();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // No WebGL (an old machine, a locked-down browser, jsdom): the page
        // still loads and still tells you what it has, it just cannot draw.
        setEngineError(err instanceof Error ? err.message : "the graph canvas failed to start");
      });

    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
    // Mounted once: the canvas, its listeners and its WebGL context live for
    // the life of the view. Theme/size/force changes are pushed in below.
  }, []);

  /* ---------------- label overlay + physics worker ---------------- */

  useEffect(() => {
    const canvas = labelCanvasRef.current;
    if (!canvas) return;
    const overlay = new LabelOverlay(canvas);
    overlayRef.current = overlay;
    return () => {
      overlay.destroy();
      overlayRef.current = null;
    };
  }, []);

  // The worker is recreated per LOAD, not per mount: after a filter change the
  // store restarts its dense indices at 0, and a worker that kept the previous
  // graph's positions would drop unrelated objects onto them. A fresh worker is
  // a few milliseconds and a correct layout.
  useEffect(() => {
    let handle: PhysicsHandle | null = null;
    try {
      handle = new PhysicsHandle({ forces: forcesFrom(controlsRef.current) });
    } catch (err: unknown) {
      setEngineError(err instanceof Error ? err.message : "the layout worker failed to start");
      return;
    }
    physicsRef.current = handle;
    // A new filter (or a reload) is a DIFFERENT visible set on a fresh layout,
    // so it re-arms auto-fit even for a viewer who had panned the previous one
    // — framing the new set is what the old per-effect `refitted` flag did, and
    // dropping that would have left a filtered graph off-screen with no hint.
    autoFitRef.current = true;
    settledOnceRef.current = false; // a fresh layout has not come to rest yet
    let fitted = false;
    let done = false; // the last auto-fit has been spent
    const off = handle.subscribe((positions) => {
      const latest = positions.latest;
      if (!latest) return;
      const renderer = rendererRef.current;
      if (!renderer) return;
      renderer.setPositions(latest);
      // Auto-fit runs on EVERY tick, not just the first and the settle: a force
      // layout spends its whole life expanding, so a camera set once at tick 1
      // (when the nodes are still packed near the origin, which fits at the
      // zoom-in cap) and then left alone IS the "it opens zoomed in" bug — the
      // frame was correct for a layout that no longer exists. Re-framing each
      // tick means the landing view is, at every instant, exactly what the Fit
      // button would give you. It costs one pass over the position buffer per
      // physics tick (30Hz), which is the same scan culling already does.
      //
      // It ends on the FIRST settle after the load is done — that frame is what
      // the viewer keeps, and nothing auto-moves the camera afterwards (a later
      // layout-slider reheat must not yank it). Any pan or zoom of their own
      // ends it earlier, via `autoFitRef`.
      if (autoFitRef.current && !done && latest.n > 0) {
        renderer.fit(undefined, computeFitInsets());
        if (!fitted) {
          fitted = true;
          settle().bump(); // first paint: pick labels for the frame we just set
        }
        if (latest.settled && loadPhaseRef.current !== "loading") done = true;
      }
      if (latest.settled) {
        // The layout has come to rest for real. This releases the idle breath,
        // which from here on keeps the simulation gently awake — so this is the
        // LAST honest `settled` of the load, and everything that waits on one
        // has to have had its turn by now.
        settledOnceRef.current = true;
        settle().bump();
      }
    });
    return () => {
      off();
      handle?.dispose();
      physicsRef.current = null;
    };
  }, [filtersKey, reloadNonce, settle]);

  /* ---------------- push control/theme changes down ---------------- */

  // SPLIT ON PURPOSE: only the four real force knobs may touch the simulation.
  // `controls` also carries nodeSize and labelThreshold — purely visual, per
  // forcesFrom's own doc ("node size and the label threshold are the
  // renderer's and the overlay's") — and a single [controls] effect reheated
  // the settled 5,000-node layout to alpha 0.5 on EVERY drag step of either
  // visual slider: seconds of 30Hz d3 ticks (~43% of a core) per step, and the
  // layout the member was reading visibly stirring for a change that altered
  // no force. Scalar deps make an identity-only `controls` change a no-op too.
  const { center, repel, linkStrength, linkDistance, nodeSize } = controls;
  useEffect(() => {
    physicsRef.current?.setForces(
      forcesFrom({ ...controlsRef.current, center, repel, linkStrength, linkDistance }),
    );
    physicsRef.current?.reheat(0.5);
  }, [center, repel, linkStrength, linkDistance]);

  useEffect(() => {
    rendererRef.current?.setNodeSizeScale(nodeSize);
    rendererRef.current?.setLinkDistance(linkDistance);
    recomputeLabelsRef.current();
  }, [controls, nodeSize, linkDistance]);

  useEffect(() => {
    rendererRef.current?.setTheme(theme);
    const el = containerRef.current;
    if (el && typeof getComputedStyle === "function") {
      const cs = getComputedStyle(el);
      labelStyleRef.current = {
        fontFamily: cs.fontFamily || "system-ui, sans-serif",
        color: cs.getPropertyValue("--mut").trim() || "#71717a",
        haloColor: cs.getPropertyValue("--ground").trim() || "#ffffff",
      };
    }
    rendererRef.current?.invalidate();
  }, [theme]);

  /* ---------------- the progressive load ---------------- */

  useEffect(() => {
    // Type icons/labels come from the shared registry; deep-linking straight
    // to /graph must not depend on Home having primed it.
    api
      .types()
      .then((ts) => {
        registerTypeIcons(ts);
        setCatalogTypes(ts.map((t) => ({ name: t.name, count: t.count })));
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A different filter is a different visible set entirely — indices from
    // before the clear are meaningless, so everything downstream resets too.
    store.clear();
    nodesRef.current = [];
    csrRef.current = null;
    layersRef.current = {};
    rendererRef.current?.setGraph([], null);
    rendererRef.current?.setHighlight(null);
    setHighlightState(null);
    highlightRef.current = null;
    setSelectionState(new Set<number>());
    setFocusState(null);
    focusRef.current = null;
    // The menu names a dense index, and dense indices restart at 0 on a
    // reload — a menu left open would be pointing at somebody else.
    setNodeMenu(null);
    setLoad({
      phase: "loading",
      nodes: 0,
      edges: 0,
      pages: 0,
      truncated: null,
      droppedEdges: 0,
      deviceCapped: null,
      error: null,
    });

    const where = graphWhere(filters);
    const deviceBudget = budgetRef.current;
    // When this device's node budget is below the server's own cap, an ascending-
    // uuid keyset walk stopped early keeps an ARBITRARY slice and discards the
    // brain's highest-degree hubs (the smaller brain would then look strictly
    // worse than a >cap one, which correctly gets the top-degree sample). Ask the
    // server for that same degree-ordered sample, sized to the node budget, so the
    // hubs are what survive. Desktop (budget ≥ cap) keeps the full keyset walk.
    const wantSample = deviceBudget.maxNodes < GRAPH_PAGE_SIZE;

    void (async () => {
      let after: string | undefined;
      let watermark: string | undefined;
      let pages = 0;
      let dropped = 0;
      // The sample path's edge budget. `maxNodes` alone does NOT enforce
      // `maxEdges` there: the degree-ordered sample keeps the densest hubs and
      // the server returns ALL visible edges among them, so the top-1,500 hubs
      // of a dense brain can carry 2-3x this device's edge budget — the exact
      // melt the budget doc promises to prevent. When the returned edge count
      // overshoots, the node sample is shrunk proportionally and re-requested
      // (bounded), and the partial view is reported via `deviceCapped`.
      let sampleLimit = Math.min(GRAPH_PAGE_SIZE, deviceBudget.maxNodes);
      let sampleShrinks = 0;
      let sampleEdgeCapped = false;
      const SAMPLE_MIN_NODES = 100;
      const SAMPLE_MAX_SHRINKS = 3;
      for (;;) {
        let page: GraphPageResponse;
        try {
          page = await api.graphPage({
            limit: wantSample ? sampleLimit : Math.min(GRAPH_PAGE_SIZE, deviceBudget.pageSize),
            ...(after !== undefined ? { after } : {}),
            ...(watermark !== undefined ? { watermark } : {}),
            ...(where !== undefined ? { where } : {}),
            ...(wantSample ? { sample: true } : {}),
          });
        } catch (err: unknown) {
          if (cancelled) return;
          setLoad((prev) => ({
            ...prev,
            phase: "error",
            error: err instanceof Error ? err.message : "the graph could not be loaded",
          }));
          return;
        }
        if (cancelled) return;

        const stats = store.ingest(page);
        if (
          wantSample &&
          store.size > deviceBudget.maxEdges &&
          sampleLimit > SAMPLE_MIN_NODES &&
          sampleShrinks < SAMPLE_MAX_SHRINKS
        ) {
          // Too many edges among the sampled hubs: drop the lowest-degree tail
          // (the server's sample is degree-ordered, so a smaller limit keeps
          // the best-connected core) and try again before painting anything.
          sampleShrinks += 1;
          sampleEdgeCapped = true;
          sampleLimit = Math.max(
            SAMPLE_MIN_NODES,
            Math.floor((sampleLimit * deviceBudget.maxEdges) / store.size),
          );
          store.clear();
          continue;
        }
        dropped += stats.edgesDropped;
        pages += 1;
        // The FIRST page paints immediately; every later one merges into the
        // layout already on screen and reheats to 0.5.
        applyStore({ reheat: pages > 1 });

        // The device cap is enforced BETWEEN pages, never inside one: a page
        // is one consistent slice of the walk, and dropping half of it would
        // leave edges pointing at nodes we chose not to keep — exactly the
        // hidden-neighbour hint rule 3 exists to prevent. When `wantSample` this
        // path does not run at all: the server returned its degree-ordered top-N
        // in ONE page (nextCursor null), so the budget was honoured by the hubs,
        // and `page.truncated` — set when the brain was larger than the sample —
        // drives the "N most-connected of M" copy. `capped` therefore only fires
        // on the desktop keyset walk, whose pages are ordered `ORDER BY v.id`
        // (reader.ts graphFull) and where stopping early WOULD keep an arbitrary
        // uuid subset — but desktop budgets sit above the server cap, so it is
        // reached only by the edge budget, never as a hub-dropping node slice.
        const capped =
          (page.nextCursor !== null && budgetReached(deviceBudget, store.order, store.size)) ||
          sampleEdgeCapped;
        const done = page.truncated !== null || page.nextCursor === null || capped;
        setLoad({
          phase: done ? "ready" : "loading",
          nodes: store.order,
          edges: store.size,
          pages,
          truncated: page.truncated,
          droppedEdges: dropped,
          deviceCapped: capped ? { shown: store.order } : null,
          error: null,
        });
        if (done) return;
        after = page.nextCursor ?? undefined;
        watermark = page.watermark;
      }
    })();

    return () => {
      cancelled = true;
    };
    // `filters` is captured through its stable key; `applyStore` is stable.
  }, [filtersKey, reloadNonce, applyStore]);

  /* ---------------- keyboard ---------------- */

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Only the canvas surface's own keys. A keystroke that reached here from
      // a slider, the search box or the recency select belongs to that
      // control — panning on its arrow keys would make it unusable.
      if (event.target !== event.currentTarget) return;
      const renderer = rendererRef.current;
      if (!renderer) return;
      const cam = renderer.getCamera();
      const step = 60 / cam.scale;
      switch (event.key) {
        case "ArrowUp":
          renderer.setCamera({ y: cam.y - step });
          break;
        case "ArrowDown":
          renderer.setCamera({ y: cam.y + step });
          break;
        case "ArrowLeft":
          renderer.setCamera({ x: cam.x - step });
          break;
        case "ArrowRight":
          renderer.setCamera({ x: cam.x + step });
          break;
        case "+":
        case "=":
          easeCamera({ scale: cam.scale * 1.25 }, 200);
          break;
        case "-":
        case "_":
          easeCamera({ scale: cam.scale * 0.8 }, 200);
          break;
        case "0":
          camera.reset();
          break;
        case "f":
        case "F":
          renderer.fit(undefined, computeFitInsets());
          break;
        case "Escape":
          clearSearchRef.current();
          setFocus(null);
          clearSelection();
          break;
        default:
          return;
      }
      // Every key above except Escape drove the camera — that's the viewer
      // taking it, so auto-fit stops and the idle breath holds off (Escape only
      // clears search/selection, so it counts as neither).
      if (event.key !== "Escape") {
        autoFitRef.current = false;
        lastInteractionRef.current = Date.now();
      }
      event.preventDefault();
      settle().bump();
    },
    [camera, clearSelection, easeCamera, setFocus],
  );

  /* ---------------- derived UI state ---------------- */

  // The legend is also the FILTER, so it has to list every type you could
  // filter BY — not just the types that survived the filter you already
  // applied. Deriving it from the loaded nodes alone meant picking one type
  // reloaded the graph, the other rows vanished with the nodes that fed them,
  // and adding a second type became impossible: a multi-select you could only
  // ever use once.
  //
  // The COUNT is the type's true size in the brain, not its size in the current
  // load. Seeding the catalog at zero (the first version of this) put a "0"
  // beside every type you had filtered out, which is a lie about the brain
  // dressed as a fact about the view — and it made the filter look broken at
  // the exact moment it was working. How much of the load is on screen is
  // already stated, honestly, by the "showing N of M" line above.
  const legend = useMemo(
    () => typeCounts(nodesRef.current, catalogTypes),
    [revision, catalogTypes],
  );

  const setFilters = useCallback((next: GraphFilterState) => setFiltersState(next), []);

  const toggleType = useCallback((type: string | null) => {
    setFiltersState((prev) => {
      const types = new Set(prev.types);
      if (types.has(type)) types.delete(type);
      else types.add(type);
      return { ...prev, types };
    });
  }, []);

  const clearTypes = useCallback(
    () => setFiltersState((prev) => ({ ...prev, types: new Set<string | null>() })),
    [],
  );

  const setRecency = useCallback(
    (recency: RecencyKey) => setFiltersState((prev) => ({ ...prev, recency })),
    [],
  );

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  const engine = useMemo<GraphEngine>(
    () => ({
      store: store,
      nodes: nodesRef.current,
      csr: csrRef.current,
      revision,
      renderer: rendererRef.current,
      physics: physicsRef.current,
      camera,
      setHighlight,
      highlight,
      selection,
      select,
      clearSelection,
      focus,
      setFocus,
      hover,
      load,
      reload,
      filters,
      setFilters,
      controls,
      setControls,
      indexOf: (id) => store.indexOf(id),
      idAt: (index) => store.idAt(index),
      reserveFit,
      compact,
    }),
    [
      revision,
      camera,
      reserveFit,
      compact,
      setHighlight,
      highlight,
      selection,
      select,
      clearSelection,
      focus,
      setFocus,
      hover,
      load,
      reload,
      filters,
      setFilters,
      controls,
      setControls,
    ],
  );

  // THE ONE search owner. The rail's search box (below) is this hook's
  // presentation; its deep/local passes install the "search" highlight layer.
  // Its local pass re-runs on every page landing (dep `engine.revision`), so a
  // live query's highlight is RE-installed as nodes arrive rather than cleared.
  const graphSearch = useGraphSearch(engine);
  clearSearchRef.current = graphSearch.clear;
  // Force the matches' labels on immediately when the match set changes, rather
  // than waiting for the next physics settle — so a match's label appears as you
  // type even on an already-settled graph (the old local effect did this).
  useEffect(() => {
    recomputeLabelsRef.current();
  }, [graphSearch.matches]);

  const focusNode = focus === null ? undefined : nodesRef.current[focus];
  const menuNode = nodeMenu === null ? undefined : nodesRef.current[nodeMenu];
  const menuId = nodeMenu === null ? undefined : store.idAt(nodeMenu);

  const loadStatus: ReactNode =
    load.error !== null ? (
      <span className="text-ink">
        {load.error}{" "}
        <button
          type="button"
          onClick={reload}
          className="underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)]"
        >
          retry
        </button>
      </span>
    ) : load.truncated !== null ? (
      <span>{truncationCopy(load.truncated)}</span>
    ) : load.deviceCapped != null ? (
      <span>{deviceCapCopy(budget, load.deviceCapped.shown)}</span>
    ) : (
      <span>
        {load.phase === "loading" ? "loading " : "showing "}
        <b className="text-ink">{fmtNumber(load.nodes)}</b> objects,{" "}
        <b className="text-ink">{fmtNumber(load.edges)}</b> links
        {load.pages > 1 && <> · {load.pages} pages</>}
        {load.phase === "loading" && <> …</>}
      </span>
    );

  // The handoff target fell outside this load — tell the user why the graph did
  // not centre where they asked, and what to do about it, rather than nothing.
  const status: ReactNode =
    focusMissed && load.error === null ? (
      <span>
        {loadStatus} ·{" "}
        <span className="text-ink">
          the object you opened here isn’t in this view — clear filters or open the graph on a
          larger screen to find it
        </span>
      </span>
    ) : (
      loadStatus
    );

  return (
    <GraphEngineContext.Provider value={engine}>
      {/* `touch-none` + `overscroll-none`: a finger dragging the map must move
          the CAMERA, never the page behind it, and a fling that reaches the
          edge of the graph must not become a pull-to-refresh. */}
      <div className="relative h-full min-h-0 w-full touch-none overscroll-none overflow-hidden">
        {/* The WebGL canvas mounts here, sized by ResizeObserver. The keyboard
            lives on THIS element rather than the wrapper: it holds no controls
            of its own, so `role="application"` (which makes a screen reader
            pass keys straight through) cannot swallow the controls' own
            browse-mode navigation, and a slider's arrow keys stay the
            slider's. */}
        <div
          ref={containerRef}
          // `focus-ring-inset` (index.css) draws a visible keyboard ring on
          // this full-bleed surface, which owns every pan/zoom/fit key once
          // focused — a bare `outline-none` left it with no focus affordance.
          className="focus-ring-inset absolute inset-0"
          tabIndex={0}
          role="application"
          aria-label={
            touchUi
              ? "Graph of the brain's objects and their connections. Drag to pan, pinch to zoom, tap a node to select it, double-tap to open it, press and hold for its actions."
              : "Graph of the brain's objects and their connections. Arrow keys pan, plus and minus zoom, f fits, 0 resets the camera, escape clears search and selection."
          }
          onKeyDown={onKeyDown}
        />
        {/* labels: a plain 2D canvas ABOVE the WebGL one, never PIXI.Text */}
        <canvas ref={labelCanvasRef} className="pointer-events-none absolute inset-0 z-10" />

        {load.phase === "loading" && load.pages === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center">
            <Spinner />
          </div>
        )}

        {load.phase === "ready" && load.nodes === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center p-8">
            <Empty>
              {filters.types.size > 0 || filters.recency !== "all"
                ? "Nothing matches this filter — widen the type or recency filter."
                : "Nothing to map yet — the graph appears as objects get linked."}
            </Empty>
          </div>
        )}

        {engineError !== null && (
          <div className="absolute inset-x-0 top-0 z-30 border-b border-line-soft bg-panel px-3 py-2 text-[12px] text-mut">
            The graph canvas could not start on this device ({engineError}). Everything else on the
            page still works.
          </div>
        )}

        {/* The compact status strip (phone, or a narrow desktop pane). The
            truncation/device-cap sentence is not allowed to live only inside a
            collapsed panel — "said out loud" has to survive the rail being
            closed, so it is rendered here too, alongside the controls toggle
            that is the only way to reach the rail when it is a sheet. */}
        {compact && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-2 p-3">
            <div className="pointer-events-auto touch-chrome flex flex-col gap-2">
              <Button
                type="button"
                size="sm"
                variant={railOpen ? "default" : "secondary"}
                aria-expanded={railOpen}
                aria-controls="graph-controls-rail"
                onClick={() => setRailOpen((open) => !open)}
              >
                {railOpen ? "Hide controls" : "Controls & filters"}
              </Button>
            </div>
            {!railOpen && (
              // pointer-events-auto, NOT none: on a load failure `status` is
              // `loadStatus`, whose retry <button> is the ONLY recovery surface
              // in the compact-closed layout (the full-screen spinner and the
              // Empty overlay both render for other phases). A pointer-events-
              // none wrapper made that visible retry untappable — a phone user
              // tapping it got silence. This thin top strip capturing taps is
              // the correct trade for a working retry.
              <div className="pointer-events-auto touch-chrome min-w-0 flex-1 border border-line-soft bg-panel/90 px-2.5 py-2 text-[11.5px] leading-snug text-mut">
                {status}
              </div>
            )}
          </div>
        )}

        {/* left rail: search, status, camera, legend/filter, sliders.
            On a phone it is a full-width sheet under the strip above rather
            than a 264px column pinned over a 390px screen, and it starts
            closed — the map is what you came for. `touch-chrome` is what
            raises every control inside it to a 44px target on a coarse
            pointer. */}
        <div
          id="graph-controls-rail"
          hidden={compact && !railOpen}
          className={
            compact
              ? // z-30 (above the other overlays' z-20) so the OPEN, opaque
                // sheet fully occludes the phase-6 top-centre menu/search/
                // scrubber column, which also pins at top-16 — otherwise its
                // search box floats on top of the sheet's own search. The top
                // strip (top-0) stays clear of this, so its rail toggle is still
                // reachable while the sheet is open.
                "touch-chrome pointer-events-none safe-bottom absolute inset-x-3 top-16 bottom-3 z-30 flex flex-col"
              : "pointer-events-none absolute top-3 bottom-3 left-3 z-20 flex w-64 flex-col"
          }
        >
          {rail !== undefined && <div className="pointer-events-auto mb-2 shrink-0">{rail}</div>}
          <div className="pointer-events-auto flex min-h-0 flex-1 flex-col">
            <GraphControls
              values={controls}
              onChange={setControls}
              onResetForces={resetControls}
              types={legend}
              activeTypes={filters.types}
              onToggleType={toggleType}
              onClearTypes={clearTypes}
              recency={filters.recency}
              onRecencyChange={setRecency}
              query={graphSearch.query}
              onQueryChange={graphSearch.setQuery}
              // Enter steps through the matches (centering the camera on each),
              // starting at the first — same landing as before, plus repeat.
              onQuerySubmit={() => graphSearch.step(1)}
              matchCount={graphSearch.query.trim() === "" ? null : graphSearch.matches.length}
              onFitCamera={() => camera.fit()}
              status={status}
            />
          </div>
        </div>

        {/* the peek: learn a node without leaving the map. On a phone it is a
            full-width bottom sheet clear of the home indicator, not a 288px
            card floating in a corner. */}
        {/* Node focus (a search submit, a click) moves the peek card, which is
            silent to a screen reader. GraphControls already announces aggregate
            counts through its own live region; this one speaks the IDENTITY of
            the node just focused, so a member who searches and selects is told
            what they landed on instead of getting silence. */}
        <div className="sr-only" role="status" aria-live="polite">
          {focusNode
            ? `${focusNode.title ?? "untitled"}, ${
                typeName(focusNode.type) || "untyped"
              }, ${fmtNumber(focusNode.degree)} link${focusNode.degree === 1 ? "" : "s"} visible`
            : ""}
        </div>

        {/* NO node preview card here, deliberately.

            A `w-72` card used to pin bottom-right with the focused node's
            title, type and links. It shared that corner and z-index with the
            scrubber, so it opened UNDERNEATH it — but the deeper problem was
            that it duplicated the side peek, which a click already opens and
            which says strictly more. Two panels describing the same node, one
            of them hidden, is worse than one panel that works. The peek is the
            node surface; 'What matters here' stays the graph surface. */}

        {/* The long-press menu. Every action here has a mouse-only equivalent
            elsewhere — right-drag to select, hover to isolate, dbl-click to
            open — so this is not extra surface, it is the touch spelling of
            controls a finger otherwise cannot reach. */}
        {nodeMenu !== null && menuNode !== undefined && menuId !== undefined && (
          <div
            role="dialog"
            aria-modal="false"
            aria-label={`Actions for ${menuNode.title ?? menuId}`}
            className="touch-chrome pointer-events-auto safe-bottom absolute inset-x-0 bottom-0 z-30 border-t border-line-soft bg-panel p-3 shadow-lg"
          >
            <div className="mb-2 flex items-center gap-2">
              <TypeIcon type={menuNode.type} size={16} />
              <div className="min-w-0 flex-1 truncate text-[13.5px] font-[650] text-ink">
                {menuNode.title ?? "untitled"}
              </div>
              <button
                type="button"
                onClick={() => setNodeMenu(null)}
                aria-label="Close actions"
                className="touch-target shrink-0 rounded-none p-1.5 text-dim focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)]"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setNodeMenu(null);
                  navigate(`/o/${menuId}`);
                }}
              >
                Open
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  select([nodeMenu], "toggle");
                  setNodeMenu(null);
                }}
              >
                {selection.has(nodeMenu) ? "Deselect" : "Select"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  // Touch's replacement for hover isolation: the same
                  // neighbourhood, but latched on until you clear it, because
                  // there is no "move the mouse away" on a phone.
                  const csr = csrRef.current;
                  if (csr !== null) select(ballOf(bfs(csr, nodeMenu, 1)));
                  camera.centerOn(nodeMenu);
                  setNodeMenu(null);
                }}
              >
                Show links
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  clearSelection();
                  setHighlight("hover", null);
                  setNodeMenu(null);
                }}
              >
                Clear
              </Button>
            </div>
          </div>
        )}

        {/* mounted overlays (path, hubs, scrubber, selection bar, presence) */}
        {children}
      </div>
    </GraphEngineContext.Provider>
  );
}

/**
 * Starting positions for the indices a page just added: the average of their
 * already-placed neighbours, plus a little jitter so two siblings do not land
 * on the same point. Entries for existing indices stay non-finite, which the
 * worker reads as "leave it where it is"; an index with no placed neighbour
 * stays non-finite too and falls back to d3's phyllotaxis.
 *
 * This is what makes a later page *grow out of* the graph instead of flying in
 * from a spiral — the visual half of "later pages fade in".
 */
function seedPositions(
  renderer: GraphRenderer | null,
  csr: Csr,
  previousCount: number,
  nextCount: number,
): Float32Array | null {
  if (renderer === null || nextCount <= previousCount || previousCount === 0) return null;
  const xy = renderer.positions();
  const placed = Math.min(previousCount, Math.floor(xy.length / 2));
  if (placed === 0) return null;
  const seed = new Float32Array(2 * nextCount).fill(Number.NaN);
  let seeded = 0;
  for (let i = previousCount; i < nextCount && i < csr.n; i += 1) {
    let sx = 0;
    let sy = 0;
    let count = 0;
    const end = csr.offsets[i + 1] ?? 0;
    for (let s = csr.offsets[i] ?? 0; s < end; s += 1) {
      const j = csr.neighbors[s]!;
      if (j >= placed) continue;
      const x = xy[2 * j];
      const y = xy[2 * j + 1];
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y))
        continue;
      sx += x;
      sy += y;
      count += 1;
    }
    if (count === 0) continue;
    seed[2 * i] = sx / count + (Math.random() - 0.5) * 16;
    seed[2 * i + 1] = sy / count + (Math.random() - 0.5) * 16;
    seeded += 1;
  }
  return seeded > 0 ? seed : null;
}
