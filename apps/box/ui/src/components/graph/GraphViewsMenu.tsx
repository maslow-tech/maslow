/**
 * Saved GRAPH views — "this filter, these forces, this camera, this node" under
 * a name, in the sidebar, one click away.
 *
 * There is no new table and no new migration: 0045's `saved_views` already
 * allows `kind: "graph"` (its CHECK constraint lists it), and `<SavedViews>`
 * was written to treat a config as opaque precisely so this file could reuse it
 * verbatim. What lives HERE is the one thing that file deliberately does not
 * know: the SHAPE of a graph config, and what restoring one has to do.
 *
 * Five rules earn their keep:
 *
 *  1. **One filter language.** The saved filters are the phase-3 filter model
 *     the graph already loads with (`GraphFilterState` → `graphWhere`), not a
 *     bespoke second one. A saved view that could express a filter the toolbar
 *     cannot would be a filter nobody could edit back out again.
 *  2. **Everything read back is hostile-shaped.** A config is JSON an OLDER
 *     release wrote (or a member hand-edited into the jsonb through some future
 *     surface), so `normalizeGraphViewConfig` clamps every number, drops every
 *     unknown key and never trusts a type. A NaN reaching d3 turns every
 *     position into NaN and the graph silently vanishes with no error anywhere.
 *  3. **Restoring is: filters → refetch → camera. In that order, once.** The
 *     forces go down first (so the worker starts the new load with them), then
 *     the filters (which is what triggers the refetch — and only when they
 *     actually changed), and the camera is set only after the first positions
 *     land, because the view fits the camera on its first tick and a camera set
 *     before that is immediately overwritten. The layout is never rebuilt and
 *     never re-heated to `alpha(1)`: the saved positions keep settling under
 *     the camera you asked for, with at most a gentle nudge.
 *  4. **A focus node that is no longer visible is silently skipped.** Not an
 *     error, not a toast, not a "this object is gone" — the object may simply
 *     have been made private, and saying so would confirm it exists. Same rule
 *     as everywhere else in the graph.
 *  5. **No share affordance, ever.** A graph config embeds object ids and a
 *     filter can embed a title, which is exactly why `saved_views` is FORCE
 *     RLS and per member. Cross-member sharing is out of scope by decision, not
 *     by omission — `<SavedViews>` offers no share button and neither does
 *     this.
 *
 * What is deliberately NOT saved: the hover highlight (it is pointer state that
 * exists for as long as the pointer is still) and the selection (a working set,
 * not a view — and its members are DENSE INDICES, which mean nothing at all
 * after the refetch a restore may perform). Both normalize to `"none"`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SavedViews } from "../SavedViews";
import {
  RECENCY_OPTIONS,
  normalizeControls,
  GLOBAL_CONTROL_DEFAULTS,
  type GraphControlValues,
  type RecencyKey,
} from "./GraphControls";
import { clampScale } from "../../lib/graph/renderer";
import type { CameraState } from "../../lib/graph/types";
import {
  filterKey,
  useGraphEngine,
  type GraphEngine,
  type GraphFilterState,
} from "../../views/GraphView";

/* ------------------------------------------------------------------ *
 * the config shape
 * ------------------------------------------------------------------ */

/** Bumped only if a config stops being readable by an older normalizer. */
export const GRAPH_VIEW_CONFIG_VERSION = 1;

/**
 * The highlight layers a VIEW can carry.
 *
 * `hover` and `selection` are `GraphHighlightSource`s but not saveable ones
 * (see the header); anything unrecognised — including those two — reads back as
 * `"none"`.
 */
type SavedHighlightMode = "none" | "path" | "search" | "changed";

const SAVED_HIGHLIGHT_MODES: readonly SavedHighlightMode[] = ["none", "path", "search", "changed"];

/** How long a saved title/id string may be before it is refused as junk. */
const MAX_ID_CHARS = 200;
/** Search text longer than this is not a search, it is a paste accident. */
const MAX_QUERY_CHARS = 200;
/** The type filter is a legend of the loaded graph; a longer list is junk. */
const MAX_TYPES = 200;

const DEPTH_MIN = 1;
const DEPTH_MAX = 3;
export const DEFAULT_DEPTH = 1;

/**
 * The active highlight, as a view remembers it: the mode plus the ONE input
 * that makes that mode mean anything. Without the input a restored "search"
 * highlights nothing and a restored "path" has no endpoints, so the mode alone
 * would be a setting with no effect.
 */
export interface SavedHighlightConfig {
  mode: SavedHighlightMode;
  /** the search box's text; `""` unless `mode === "search"`. */
  query: string;
  /** shortest-path endpoints, as OBJECT IDS (indices do not survive a reload). */
  path: { from: string; to: string } | null;
  /** the scrubber's window start, ISO-8601; null unless `mode === "changed"`. */
  since: string | null;
}

/** The filter half, in the phase-3 model the graph already loads with. */
export interface SavedGraphFilters {
  /** kept types; `null` is the untyped bucket. Empty = every type. */
  types: Array<string | null>;
  recency: RecencyKey;
}

/**
 * Everything a saved graph view remembers. Stored as `saved_views.config`.
 *
 * A `type` rather than an `interface` on purpose: only a type alias carries the
 * implicit index signature that makes it assignable to the opaque
 * `Record<string, unknown>` `<SavedViews>` takes, and a cast there would be a
 * cast on the one value in this file that must stay honest.
 */
export type GraphViewConfig = {
  v: number;
  filters: SavedGraphFilters;
  /** the six force/legibility sliders, in UI units. */
  controls: GraphControlValues;
  camera: CameraState;
  /** the peek panel's object, as an ID — a dense index means nothing later. */
  focus: string | null;
  /** the local-graph depth carried over from the rail handoff, 1–3. */
  depth: number;
  highlight: SavedHighlightConfig;
};

/** The parts of a view the graph ENGINE does not own — the host passes them in
 *  and gets them back on restore, so the overlays that do own them (search,
 *  shortest path, the scrubber, the rail's depth) stay out of this file. */
export interface GraphViewExtras {
  depth: number;
  highlight: SavedHighlightConfig;
}

export const EMPTY_HIGHLIGHT: SavedHighlightConfig = {
  mode: "none",
  query: "",
  path: null,
  since: null,
};

/* ------------------------------------------------------------------ *
 * normalization — everything below here treats its input as hostile
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A non-empty, bounded string, or null. Used for ids and ISO timestamps. */
function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return null;
  return trimmed;
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * A camera rounded to the precision a saved view is worth.
 *
 * This is not cosmetic: the live config is sampled off a canvas that moves
 * continuously, and an un-rounded sample would make the dirty dot flicker on
 * sub-pixel drift while a settling simulation nudges the fit. World units at
 * one decimal and scale at four are far finer than anything the eye resolves.
 */
export function roundCamera(camera: CameraState): CameraState {
  return {
    x: round(camera.x, 1),
    y: round(camera.y, 1),
    scale: round(camera.scale, 4),
  };
}

export function normalizeCamera(raw: unknown): CameraState {
  const r = isRecord(raw) ? raw : {};
  const x = Number(r.x);
  const y = Number(r.y);
  return roundCamera({
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    // clampScale is the renderer's own clamp (and answers 1 for a NaN), so a
    // saved camera can never be one the wheel could not have produced.
    scale: clampScale(Number(r.scale)),
  });
}

export function normalizeDepth(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_DEPTH;
  return n < DEPTH_MIN ? DEPTH_MIN : n > DEPTH_MAX ? DEPTH_MAX : n;
}

function normalizeRecency(raw: unknown): RecencyKey {
  return RECENCY_OPTIONS.some((o) => o.key === raw) ? (raw as RecencyKey) : "all";
}

export function normalizeFilters(raw: unknown): SavedGraphFilters {
  const r = isRecord(raw) ? raw : {};
  const out: Array<string | null> = [];
  const seen = new Set<string>();
  if (Array.isArray(r.types)) {
    for (const entry of r.types) {
      if (out.length >= MAX_TYPES) break;
      if (entry === null) {
        if (seen.has(" ")) continue;
        seen.add(" ");
        out.push(null);
        continue;
      }
      const name = str(entry, MAX_ID_CHARS);
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  // Sorted so two identical filters built in different click orders compare
  // equal: `<SavedViews>` dirty-checks by structure, and arrays keep order.
  out.sort(compareTypes);
  return { types: out, recency: normalizeRecency(r.recency) };
}

/** null (the untyped bucket) sorts first; everything else alphabetically. */
function compareTypes(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

export function normalizeHighlight(raw: unknown): SavedHighlightConfig {
  const r = isRecord(raw) ? raw : {};
  const mode: SavedHighlightMode = SAVED_HIGHLIGHT_MODES.includes(r.mode as SavedHighlightMode)
    ? (r.mode as SavedHighlightMode)
    : "none";
  const rawPath = isRecord(r.path) ? r.path : null;
  const from = rawPath === null ? null : str(rawPath.from, MAX_ID_CHARS);
  const to = rawPath === null ? null : str(rawPath.to, MAX_ID_CHARS);
  const path = from !== null && to !== null ? { from, to } : null;
  const query = str(r.query, MAX_QUERY_CHARS) ?? "";
  const since = str(r.since, MAX_ID_CHARS);

  // A mode without its input is not that mode. Dropping it here (rather than
  // letting an overlay render an empty path panel) is what keeps a restored
  // view from looking broken. Only the input the mode actually uses is kept:
  // a stale object id riding along inside an unrelated view is content stored
  // for nothing, and this config is content-bearing enough already.
  if (mode === "path") {
    return path === null ? EMPTY_HIGHLIGHT : { mode, query: "", path, since: null };
  }
  if (mode === "search") {
    return query === "" ? EMPTY_HIGHLIGHT : { mode, query, path: null, since: null };
  }
  if (mode === "changed") {
    return since === null ? EMPTY_HIGHLIGHT : { mode, query: "", path: null, since };
  }
  return EMPTY_HIGHLIGHT;
}

/**
 * A stored config as this release understands it. Total: every field has a
 * defined answer for every input, including `undefined`, a string, or an array.
 */
export function normalizeGraphViewConfig(raw: unknown): GraphViewConfig {
  const r = isRecord(raw) ? raw : {};
  return {
    v: GRAPH_VIEW_CONFIG_VERSION,
    filters: normalizeFilters(r.filters),
    controls: normalizeControls(
      isRecord(r.controls) ? (r.controls as Partial<GraphControlValues>) : null,
      GLOBAL_CONTROL_DEFAULTS,
    ),
    camera: normalizeCamera(r.camera),
    focus: str(r.focus, MAX_ID_CHARS),
    depth: normalizeDepth(r.depth),
    highlight: normalizeHighlight(r.highlight),
  };
}

/**
 * The config for what is on screen right now.
 *
 * It runs through the SAME normalizer the restore path uses, so "is what I am
 * looking at still what I saved?" is a structural comparison between two
 * normalized objects and never reports dirty for a difference that does not
 * survive a round trip through jsonb.
 */
export function buildGraphViewConfig(input: {
  filters: GraphFilterState;
  controls: GraphControlValues;
  camera: CameraState;
  focus: string | null;
  depth: number;
  highlight: SavedHighlightConfig;
}): GraphViewConfig {
  return normalizeGraphViewConfig({
    v: GRAPH_VIEW_CONFIG_VERSION,
    filters: { types: [...input.filters.types], recency: input.filters.recency },
    controls: input.controls,
    camera: input.camera,
    focus: input.focus,
    depth: input.depth,
    highlight: input.highlight,
  });
}

/** The saved filters as the engine's own filter state. */
export function filtersFromConfig(config: GraphViewConfig): GraphFilterState {
  return { types: new Set(config.filters.types), recency: config.filters.recency };
}

/** Whether restoring `config` over `current` needs a refetch at all. A restore
 *  that only moved the camera must not throw the whole graph away. */
export function needsRefetch(config: GraphViewConfig, current: GraphFilterState): boolean {
  return filterKey(filtersFromConfig(config)) !== filterKey(current);
}

/* ------------------------------------------------------------------ *
 * the live camera, sampled
 * ------------------------------------------------------------------ */

/** How often the live camera is read for the "what is on screen" config. */
const CAMERA_SAMPLE_MS = 500;

/**
 * The camera as a piece of React state.
 *
 * The renderer's camera is a mutable object read through a handle — it changes
 * on every wheel event and every frame of an easing, and none of that is a
 * React render. Polling it slowly (and only re-rendering when the ROUNDED value
 * actually moved) is what lets the saved-views control show a truthful dirty
 * dot without re-rendering the toolbar at 60Hz.
 */
function useSampledCamera(
  camera: GraphEngine["camera"],
  intervalMs: number = CAMERA_SAMPLE_MS,
): CameraState {
  const [state, setState] = useState<CameraState>(() => roundCamera(camera.get()));
  useEffect(() => {
    const read = (): void => {
      const next = roundCamera(camera.get());
      setState((prev) =>
        prev.x === next.x && prev.y === next.y && prev.scale === next.scale ? prev : next,
      );
    };
    read();
    const id = setInterval(read, intervalMs);
    return () => clearInterval(id);
  }, [camera, intervalMs]);
  return state;
}

/* ------------------------------------------------------------------ *
 * the restore
 * ------------------------------------------------------------------ */

/** How long the camera restore waits for the first positions before giving up
 *  and setting the camera anyway (a graph with no WebGL never ticks at all). */
const RESTORE_TIMEOUT_MS = 4000;
/** How often the pending restore checks whether the first tick has landed. */
const RESTORE_POLL_MS = 32;
/** The nudge after a restore that refetched. Never 1 — that visibly explodes an
 *  almost-correct layout, which is the exact "jarring re-layout" this avoids. */
const RESTORE_REHEAT_ALPHA = 0.3;

interface PendingRestore {
  camera: CameraState;
  focus: string | null;
  reheat: boolean;
  deadline: number;
}

/* ------------------------------------------------------------------ *
 * the component
 * ------------------------------------------------------------------ */

export interface GraphViewsMenuProps {
  /** whose views these are; a different member never sees a stale list. */
  accountId: string;
  /**
   * The bits the engine does not own. Omitted means "this host has no scrubber
   * / path / rail depth yet" — the view saves the defaults and restores them
   * into nothing, which is a no-op rather than an error.
   */
  extras?: Partial<GraphViewExtras>;
  /** Handed the saved extras on restore, before the refetch is kicked off. */
  onRestoreExtras?: (extras: GraphViewExtras) => void;
  className?: string;
}

/**
 * The saved-views control for the whole-brain graph.
 *
 * Mount it as a child of `<GraphView>` (it reads the engine from context):
 *
 * ```tsx
 * <GraphView>
 *   <GraphViewsMenu accountId={me.id} extras={extras} onRestoreExtras={setExtras} />
 * </GraphView>
 * ```
 */
export function GraphViewsMenu(props: GraphViewsMenuProps) {
  const engine = useGraphEngine();
  return <GraphViewsMenuBody engine={engine} {...props} />;
}

/**
 * The body, with the engine passed explicitly.
 *
 * Split out so it can be rendered against a stub engine in tests: the context
 * lives inside `<GraphView>`, and standing that up means PixiJS, a Worker and
 * the paged endpoint — none of which this control's behaviour depends on.
 */
export function GraphViewsMenuBody({
  engine,
  accountId,
  extras,
  onRestoreExtras,
  className,
}: GraphViewsMenuProps & { engine: GraphEngine }) {
  const camera = useSampledCamera(engine.camera);
  const pendingRef = useRef<PendingRestore | null>(null);
  const [restoreNonce, setRestoreNonce] = useState(0);

  // Latest-value refs: the restore runs on a timer that outlives the render it
  // was scheduled in, and must never act on a stale engine.
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const extrasRef = useRef(onRestoreExtras);
  extrasRef.current = onRestoreExtras;

  const focusId = engine.focus === null ? null : (engine.idAt(engine.focus) ?? null);
  const depth = normalizeDepth(extras?.depth);
  const highlight = useMemo(() => normalizeHighlight(extras?.highlight), [extras?.highlight]);

  const config = useMemo(
    () =>
      buildGraphViewConfig({
        filters: engine.filters,
        controls: engine.controls,
        camera,
        focus: focusId,
        depth,
        highlight,
      }),
    [engine.filters, engine.controls, camera, focusId, depth, highlight],
  );

  /**
   * Apply a saved view.
   *
   * Order matters and is the whole point of this function: forces first (so the
   * worker starts a new load already holding them), then the extras, then the
   * filters — and the camera is deferred to the effect below, because the view
   * fits the camera on its first tick and would overwrite anything set now.
   */
  const applyConfig = useCallback((raw: Record<string, unknown>) => {
    const current = engineRef.current;
    const config = normalizeGraphViewConfig(raw);

    current.setControls(config.controls);
    extrasRef.current?.({ depth: config.depth, highlight: config.highlight });

    const refetch = needsRefetch(config, current.filters);
    if (refetch) current.setFilters(filtersFromConfig(config));

    pendingRef.current = {
      camera: config.camera,
      focus: config.focus,
      // A restore that did NOT refetch is looking at a layout that is already
      // settled and already correct — reheating it would make every node drift
      // out from under the camera we just restored, which is precisely the
      // jarring thing this is supposed to avoid.
      reheat: refetch,
      deadline: Date.now() + RESTORE_TIMEOUT_MS,
    };
    setRestoreNonce((n) => n + 1);
  }, []);

  /**
   * Finish a pending restore once the first positions have landed.
   *
   * Waiting on the FIRST TICK rather than on `load.phase === "ready"` is
   * deliberate: `<GraphView>` calls `renderer.fit()` in the first positions
   * callback of a load, so a camera set before that is thrown away — and a
   * large brain stays in `"loading"` for several pages after that first tick,
   * which is far too long to leave the camera somewhere the member did not ask
   * for.
   */
  useEffect(() => {
    if (pendingRef.current === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attempt = (): void => {
      const pending = pendingRef.current;
      if (pending === null) return;
      const current = engineRef.current;

      // A load that failed has no positions coming, and no camera worth
      // restoring onto an empty canvas.
      if (current.load.phase === "error") {
        pendingRef.current = null;
        return;
      }

      const ticked = current.physics?.positions.latest != null;
      if (!ticked && Date.now() < pending.deadline) {
        timer = setTimeout(attempt, RESTORE_POLL_MS);
        return;
      }

      pendingRef.current = null;
      // `set`, not `ease`: there is nothing meaningful to ease FROM — the fit
      // that just ran framed a graph the member never asked to look at.
      current.camera.set(pending.camera);
      current.camera.invalidate();

      if (pending.focus !== null) {
        const index = current.indexOf(pending.focus);
        // Not found means filtered out, trashed, or no longer visible to this
        // member. Silence is the rule: an "it's gone" message about an object
        // they cannot see would confirm that it exists.
        if (index !== undefined) current.setFocus(index);
      }

      if (pending.reheat) current.physics?.reheat(RESTORE_REHEAT_ALPHA);
    };

    attempt();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [restoreNonce]);

  return (
    <div
      className={`pointer-events-auto flex shrink-0 items-center border border-line-soft bg-panel p-1 shadow-sm ${
        className ?? ""
      }`}
    >
      <SavedViews
        accountId={accountId}
        kind="graph"
        // Graph views are GLOBAL — the graph has no per-type page to hang a
        // scope off, and 0045's unique index is (member, kind, scope, name),
        // so a null scope keeps every graph view's name unique among the
        // member's own graph views.
        scope={null}
        config={config}
        onApply={applyConfig}
        nameBase="Graph view"
        className="h-6 flex-1 justify-start px-1.5 text-[11px]"
      />
    </div>
  );
}
