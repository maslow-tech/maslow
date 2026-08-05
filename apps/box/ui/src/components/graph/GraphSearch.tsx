/**
 * Search over the graph — highlighting IN PLACE, never filtering.
 *
 * The old view's search dimmed everything that did not match to alpha 0.2,
 * which is the one thing a graph search must not do: a match you cannot place
 * among its neighbours is a list row, and we already have a very good list
 * (`/search`). So this component never removes, hides or filters a node. It
 * installs the `"search"` highlight layer, and that layer already means three
 * things everywhere else in the engine:
 *
 *  - **halo** — `renderer.drawRings()` rings every member of the active set
 *    (up to 128 of them; past that the forced labels carry it, because 500
 *    rings is a smear, not a signal);
 *  - **label forced on** — `forcedLabels()` in `lib/graph/highlight.ts` returns
 *    the member set for `kind: "search"`, so matches keep their label at any
 *    zoom, below the fade threshold and past the K-label cap;
 *  - **a light global dim only** — `DIM_ALPHA.search` is 0.45, deliberately
 *    much gentler than hover isolation's 0.12. The surroundings stay legible;
 *    that context is the whole reason to search here rather than in a table.
 *
 * Two arms, exactly like `/search` and ⌘K, and for the same reason — the
 * first is instant and the second is better:
 *
 *  1. **Local, over what is already loaded.** Titles and type names, debounced
 *    ({@link SEARCH_DEBOUNCE_MS}), scored so an exact prefix beats a substring
 *    beats a type match, ties broken by visible degree. No round trip, so it
 *    tracks your typing.
 *  2. **`api.search`, for the deeper matches.** The map holds titles and types;
 *    the box holds bodies, embeddings and the graph arm. The deep pass fires
 *    {@link DEEP_DEBOUNCE_MS} after you stop typing and its hits are MERGED
 *    into the same highlight, never rendered as new nodes: an id the client was
 *    never given is counted ("N more elsewhere in your brain") and nothing
 *    about it is drawn. Synthesising a node for it would re-create exactly the
 *    hidden-neighbour hint the visible-only-degree rule exists to prevent, and
 *    a deep hit can legitimately be off this map because a filter excluded it
 *    or the load was truncated.
 *
 * The camera is only moved when you ask. `Enter` steps to the next match,
 * "Fit" frames the whole match set, and the follow checkbox (off by default)
 * re-fits as you type. Search must not steal your place any more than the peek
 * does — that is the same promise `NodePeekBridge` keeps on click.
 *
 * Mounting: `useGraphSearch(engine)` is the headless half, and it has exactly
 * ONE owner — it is hoisted into `<GraphView>`, which wires its own controls-rail
 * search box (`GraphControls`' `query` / `onQueryChange` / `matchCount` /
 * `onQuerySubmit`) to it. There is one search on screen (the rail box) and one
 * writer of the `"search"` layer. This used to be split: GraphView kept a local
 * `matchIndices` state AND a standalone `<GraphSearch>` overlay each installed
 * the layer, so the empty rail box cleared the overlay's highlight on every page
 * landing. Both duplicates are gone; `GraphSearchPanel` below is the standalone
 * presentation kept for tests and any future non-rail mount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, Scan, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "../../lib/api";
import { searchHighlight } from "../../lib/graph/highlight";
import { clampScale } from "../../lib/graph/renderer";
import type { CameraState, GraphNode } from "../../lib/graph/types";
import { fmtNumber, typeName } from "../../lib/ui";
import { SEARCH_MATCH_CAP, type GraphEngine } from "../../views/GraphView";

/* ------------------------------------------------------------------ *
 * tuning
 * ------------------------------------------------------------------ */

/** Local pass: fast enough to feel live, slow enough not to re-scan per key. */
export const SEARCH_DEBOUNCE_MS = 160;

/** Deep pass: only after you have stopped typing — it costs a round trip. */
export const DEEP_DEBOUNCE_MS = 420;

/** Deep hits requested. More than this cannot be read as a highlight anyway. */
const DEEP_LIMIT = 40;

/** A one-word query is a prefix of half the brain; the deep arm waits for two. */
const DEEP_MIN_QUERY = 2;

/** Padding around the match bounding box when fitting the camera, in px. */
const FIT_PADDING_PX = 96;

/** Never zoom PAST this to frame a tight (or single-node) match set. */
const MAX_FIT_SCALE = 1.6;

/* ------------------------------------------------------------------ *
 * matching (pure)
 * ------------------------------------------------------------------ */

/** Where a node matched, best first — the ranking, not a display string. */
type MatchScore = 0 | 1 | 2;

/**
 * Score one node against an already-lowercased needle, or null for no match.
 *
 * Titles beat types because you searched for a name; a prefix beats a
 * substring because "not" should surface "Notes" before "Annotation".
 */
export function scoreNode(node: GraphNode, needle: string): MatchScore | null {
  const title = node.title === null ? "" : node.title.toLowerCase();
  if (title !== "") {
    if (title.startsWith(needle)) return 0;
    if (title.includes(needle)) return 1;
  }
  const raw = node.type === null ? "" : node.type.toLowerCase();
  const label = typeName(node.type).toLowerCase();
  if ((raw !== "" && raw.includes(needle)) || (label !== "" && label.includes(needle))) return 2;
  return null;
}

interface GraphMatchResult {
  /** dense indices, best first, capped. */
  readonly indices: readonly number[];
  readonly set: ReadonlySet<number>;
  /** how many matched BEFORE the cap — the copy says so when they differ. */
  readonly total: number;
  readonly capped: boolean;
}

const EMPTY_MATCH: GraphMatchResult = {
  indices: [],
  set: new Set<number>(),
  total: 0,
  capped: false,
};

/**
 * Every loaded node whose title or type matches, ranked. Runs over the whole
 * loaded array (5,000 nodes is a sub-millisecond scan) and caps only at the
 * END, so the cap drops the worst matches rather than whichever happened to
 * arrive in the last page.
 */
export function matchGraphNodes(
  nodes: readonly GraphNode[],
  query: string,
  cap: number = SEARCH_MATCH_CAP,
): GraphMatchResult {
  const needle = query.trim().toLowerCase();
  if (needle === "") return EMPTY_MATCH;

  const hits: Array<{ index: number; score: MatchScore; degree: number }> = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    const score = scoreNode(node, needle);
    if (score === null) continue;
    hits.push({ index: i, score, degree: node.degree });
  }
  hits.sort((a, b) => a.score - b.score || b.degree - a.degree || a.index - b.index);

  const kept = hits.length > cap ? hits.slice(0, cap) : hits;
  const indices = kept.map((h) => h.index);
  return {
    indices,
    set: new Set(indices),
    total: hits.length,
    capped: hits.length > cap,
  };
}

interface MergedMatches extends GraphMatchResult {
  /**
   * Deep hits whose id is not on this map — filtered out, or truncated away.
   * Counted and said out loud; NEVER drawn as a node (see the header).
   */
  readonly offMap: number;
}

/**
 * Fold the deep pass into the local one. Deep hits already on the map are
 * appended after the local matches (the local ones are the literal answer to
 * what you typed); ones that are not are counted.
 */
export function mergeDeepMatches(
  local: GraphMatchResult,
  deepIds: readonly string[],
  indexOf: (id: string) => number | undefined,
  cap: number = SEARCH_MATCH_CAP,
): MergedMatches {
  if (deepIds.length === 0) return { ...local, offMap: 0 };

  const indices = [...local.indices];
  const set = new Set(local.set);
  let offMap = 0;
  let added = 0;
  for (const id of deepIds) {
    const index = indexOf(id);
    if (index === undefined) {
      offMap += 1;
      continue;
    }
    if (set.has(index)) continue;
    if (indices.length >= cap) {
      added += 1;
      continue;
    }
    set.add(index);
    indices.push(index);
    added += 1;
  }
  return {
    indices,
    set,
    total: local.total + added,
    capped: local.total + added > cap,
    offMap,
  };
}

/* ------------------------------------------------------------------ *
 * camera fit (pure)
 * ------------------------------------------------------------------ */

/**
 * A camera that frames `indices`, or null when none of them has a position
 * yet (the first tick has not landed, or the set is empty).
 *
 * Deliberately not `renderer.fit()`: that frames the WHOLE graph, and the
 * point of fitting a search is to fly to the four things you asked about
 * without losing which continent they are on — hence the generous padding and
 * the {@link MAX_FIT_SCALE} ceiling, which keeps a single match from becoming
 * a full-screen dot with no context around it.
 */
export function fitToIndices(
  positions: Float32Array,
  indices: Iterable<number>,
  size: { width: number; height: number },
  paddingPx: number = FIT_PADDING_PX,
): CameraState | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let found = 0;

  for (const i of indices) {
    const x = positions[2 * i];
    const y = positions[2 * i + 1];
    if (x === undefined || y === undefined) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    found += 1;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (found === 0) return null;

  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const usableX = Math.max(1, width - 2 * paddingPx);
  const usableY = Math.max(1, height - 2 * paddingPx);
  const scale = clampScale(Math.min(MAX_FIT_SCALE, Math.min(usableX / spanX, usableY / spanY)));

  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
}

/* ------------------------------------------------------------------ *
 * the headless hook
 * ------------------------------------------------------------------ */

interface GraphSearchOptions {
  debounceMs?: number;
  deepMs?: number;
  cap?: number;
  /** turn the `api.search` arm off (the rail's local graph does not want it). */
  deep?: boolean;
}

interface GraphSearchState {
  query: string;
  setQuery: (q: string) => void;
  /** ranked dense indices, local matches first. */
  matches: readonly number[];
  matchSet: ReadonlySet<number>;
  /** matches before the cap. */
  total: number;
  capped: boolean;
  /** deep hits that are not on this map (counted, never drawn). */
  offMap: number;
  deepening: boolean;
  /** which match `step` last moved the camera to, or -1. */
  cursor: number;
  step: (delta: number) => void;
  fitToMatches: () => void;
  follow: boolean;
  setFollow: (on: boolean) => void;
  clear: () => void;
}

/**
 * The whole behaviour, with no markup. The panel below is one presentation of
 * it; GraphView's rail box should be another.
 */
export function useGraphSearch(
  engine: GraphEngine,
  options: GraphSearchOptions = {},
): GraphSearchState {
  const {
    debounceMs = SEARCH_DEBOUNCE_MS,
    deepMs = DEEP_DEBOUNCE_MS,
    cap = SEARCH_MATCH_CAP,
    deep = true,
  } = options;

  const [query, setQueryState] = useState("");
  const [debounced, setDebounced] = useState("");
  const [deepIds, setDeepIds] = useState<readonly string[]>([]);
  const [deepening, setDeepening] = useState(false);
  const [follow, setFollow] = useState(false);
  const [cursor, setCursor] = useState(-1);

  /** Monotonic ticket: only the newest deep pass may land. */
  const ticket = useRef(0);

  /* ---- debounce the local pass ---- */
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), debounceMs);
    return () => clearTimeout(t);
  }, [query, debounceMs]);

  /* ---- the deep pass ---- */
  useEffect(() => {
    const q = debounced.trim();
    ticket.current += 1;
    const mine = ticket.current;
    if (!deep || q.length < DEEP_MIN_QUERY) {
      setDeepIds([]);
      setDeepening(false);
      return;
    }
    const t = setTimeout(() => {
      setDeepening(true);
      api
        .search(q, { limit: DEEP_LIMIT, deep: true })
        .then((hits) => {
          if (ticket.current !== mine) return;
          setDeepIds(hits.map((h) => h.id));
          setDeepening(false);
        })
        .catch(() => {
          // A deep pass that fails (embedder warming, a box without pgvector)
          // quietly leaves the local matches standing — exactly as ⌘K does.
          if (ticket.current !== mine) return;
          setDeepIds([]);
          setDeepening(false);
        });
    }, deepMs);
    return () => clearTimeout(t);
  }, [debounced, deep, deepMs]);

  /* ---- matching ---- */
  const local = useMemo(
    () => matchGraphNodes(engine.nodes, debounced, cap),
    // `engine.nodes` is mutated IN PLACE as pages land — `revision` is the
    // signal that it changed, and the array's identity is not. Same pattern
    // (and same reason) as GraphView's own `typeCounts` memo.
    [engine.nodes, engine.revision, debounced, cap],
  );

  const merged = useMemo(
    () => mergeDeepMatches(local, deepIds, engine.indexOf, cap),
    [local, deepIds, engine.indexOf, cap],
  );

  /* ---- install the highlight layer ---- */
  const { setHighlight } = engine;
  useEffect(() => {
    setHighlight("search", merged.set.size === 0 ? null : searchHighlight(merged.set));
  }, [merged, setHighlight]);

  // Releasing the layer on unmount matters: the panel can be unmounted (a
  // saved view switching layouts) while a query is still typed, and a stuck
  // dim with nothing driving it is unrecoverable without a reload.
  useEffect(() => () => setHighlight("search", null), [setHighlight]);

  /* ---- the camera, only when asked ---- */
  const { camera, renderer } = engine;

  const fitToMatches = useCallback(() => {
    const indices = merged.indices;
    if (indices.length === 0) return;
    if (indices.length === 1) {
      camera.centerOn(indices[0]!);
      return;
    }
    if (renderer === null) {
      camera.centerOn(indices[0]!);
      return;
    }
    const next = fitToIndices(renderer.positions(), indices, renderer.size());
    if (next === null) camera.centerOn(indices[0]!);
    else camera.ease(next);
  }, [merged, camera, renderer]);

  const step = useCallback(
    (delta: number) => {
      const indices = merged.indices;
      if (indices.length === 0) return;
      setCursor((prev) => {
        const n = indices.length;
        const next = prev < 0 ? (delta >= 0 ? 0 : n - 1) : (((prev + delta) % n) + n) % n;
        const index = indices[next];
        if (index !== undefined) camera.centerOn(index);
        return next;
      });
    },
    [merged, camera],
  );

  // A new query invalidates the walk position, never the camera.
  useEffect(() => setCursor(-1), [debounced]);

  const followRef = useRef(follow);
  followRef.current = follow;
  useEffect(() => {
    if (!followRef.current) return;
    if (merged.indices.length === 0) return;
    fitToMatches();
  }, [merged, fitToMatches]);

  const setQuery = useCallback((q: string) => setQueryState(q), []);
  const clear = useCallback(() => {
    setQueryState("");
    setDebounced("");
    setDeepIds([]);
    setDeepening(false);
    setCursor(-1);
  }, []);

  return {
    query,
    setQuery,
    matches: merged.indices,
    matchSet: merged.set,
    total: merged.total,
    capped: merged.capped,
    offMap: merged.offMap,
    deepening,
    cursor,
    step,
    fitToMatches,
    follow,
    setFollow,
    clear,
  };
}

/* ------------------------------------------------------------------ *
 * copy
 * ------------------------------------------------------------------ */

/**
 * The status line. It says "in place" on purpose: the one thing a user needs
 * to know about this search is that nothing was removed from the map.
 */
export function matchSummary(state: {
  matches: readonly number[];
  total: number;
  capped: boolean;
  offMap: number;
}): string {
  const shown = state.matches.length;
  if (shown === 0) {
    return "No matches on this map — nothing was filtered away, there is simply nothing here.";
  }
  const head = state.capped
    ? `${fmtNumber(shown)} of ${fmtNumber(state.total)} matches highlighted in place`
    : `${fmtNumber(shown)} match${shown === 1 ? "" : "es"} highlighted in place`;
  const tail =
    state.offMap > 0
      ? ` · ${fmtNumber(state.offMap)} more elsewhere in your brain (not on this map)`
      : "";
  return `${head}${tail}`;
}

/* ------------------------------------------------------------------ *
 * the panel
 * ------------------------------------------------------------------ */

interface GraphSearchPanelProps extends GraphSearchOptions {
  engine: GraphEngine;
  /** put the caret in the box on mount (the ⌘F entry point does). */
  autoFocus?: boolean;
  className?: string;
}

/**
 * The presentation, taking its engine explicitly — which is what lets it be
 * rendered in a test (and in the rail) without a live `<GraphView>` around it.
 */
export function GraphSearchPanel({
  engine,
  autoFocus = false,
  className,
  ...options
}: GraphSearchPanelProps) {
  const search = useGraphSearch(engine, options);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const typed = search.query.trim() !== "";
  const has = search.matches.length > 0;

  return (
    <div
      role="search"
      aria-label="Search the graph"
      className={[
        "pointer-events-auto flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-1.5",
        className ?? "",
      ]
        .join(" ")
        .trim()}
    >
      <div className="relative">
        <Search
          size={13}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim"
          aria-hidden
        />
        <Input
          ref={inputRef}
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              search.step(e.shiftKey ? -1 : 1);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              search.clear();
            }
          }}
          placeholder="Find on the map — title, type, or anything the box can search…"
          aria-label="Find on the map"
          className="border-line-soft bg-panel pr-8 pl-7 shadow-sm"
        />
        {search.query !== "" && (
          <button
            type="button"
            onClick={() => search.clear()}
            aria-label="Clear search"
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-none p-1.5 text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)]"
          >
            <X size={13} aria-hidden />
          </button>
        )}
      </div>

      {typed && (
        <div className="flex flex-col gap-1 border border-line-soft bg-panel px-2.5 py-1.5 shadow-sm">
          <div className="text-[11.5px] text-dim" role="status">
            {matchSummary(search)}
          </div>
          {search.deepening && (
            <div className="flex items-center gap-1.5 text-[11px] text-dim">
              <span
                className="deep-pulse inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]"
                aria-hidden
              />
              searching bodies and meaning…
            </div>
          )}
          {has && (
            <div className="flex items-center gap-1 pt-0.5">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => search.step(-1)}
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
              >
                <ChevronUp size={13} aria-hidden />
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => search.step(1)}
                aria-label="Next match"
                title="Next match (Enter)"
              >
                <ChevronDown size={13} aria-hidden />
              </Button>
              <span className="font-mono text-[10.5px] text-dim tabular-nums" aria-hidden>
                {search.cursor < 0 ? "—" : search.cursor + 1}/{fmtNumber(search.matches.length)}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => search.fitToMatches()}
                title="Frame every match"
                className="ml-auto"
              >
                <Scan size={13} aria-hidden />
                <span className="ml-1">Fit</span>
              </Button>
              <label className="flex items-center gap-1 text-[11px] text-dim">
                <input
                  type="checkbox"
                  checked={search.follow}
                  onChange={(e) => search.setFollow(e.target.checked)}
                  className="accent-[var(--ink-strong)]"
                />
                follow
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
