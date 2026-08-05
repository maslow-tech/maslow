/**
 * The time scrubber — "what changed?" as STRUCTURE.
 *
 * Drag it and the brain grows in front of you: objects created or updated
 * inside the window glow, everything else recedes to `DIM_ALPHA.changed`, and
 * the shape you already know stays on screen as context. This is the only
 * surface in the product where "what did the agent add this week" is a picture
 * of the graph rather than a list — which is the whole reason it recedes
 * (0.35) instead of isolating (0.12): you are watching growth against an
 * existing shape, and a shape you cannot see is not a comparison.
 *
 * ## The privacy rule, which is the reason this file is careful
 *
 * The event feed has NO RLS. It carries "actor X updated <uuid>" for objects
 * the viewer cannot get — a documented ceiling since migration 0012. So:
 *
 *  - **This component never reads the feed.** Not `api.timeline`, not
 *    `api.activityFeed`. Its only source is `GET /api/v1/graph/changed`, which
 *    intersects the changed set with the viewer's visible node set server-side
 *    and computes every number AFTER that intersection.
 *  - **It renders only the ids the server returned**, and every count it shows
 *    is a count of THOSE ids (`count`, `byKind`, and the mapped-into-view
 *    number, which is a subset of them). A count derived from raw feed rows —
 *    or a pulse keyed on a target id — would announce that a private object
 *    exists and hand over its uuid, defeating the visible-subgraph work the
 *    graph read path does.
 *  - Ids the server returned that this client has not loaded yet are simply
 *    not lit. They are never synthesized into placeholder nodes (same rule as
 *    `GraphStore.ingest`), and the copy says how many are off-view rather than
 *    implying the window was empty.
 *
 * ## Glow and pulse ride `highlight.ts`, not a second animation system
 *
 * Membership is chosen here; nothing is animated here. `changedHighlight`
 * builds the set, `GraphEngine.setHighlight("changed", …)` installs it as ONE
 * layer among five (path > selection > search > changed > hover), and the
 * renderer owns the eased dim. The pulse is the same idea: instead of a second
 * per-frame loop fighting the renderer's tween, the set is reinstalled at an
 * alternating `dimAlpha` every half period, and the renderer's own 140ms ease
 * turns two values into a breathe. That costs two set installs per 1.6s rather
 * than a 60Hz animation on a graph that is otherwise idle at ~0% CPU.
 *
 * `prefers-reduced-motion` drops the alternation entirely and leaves the
 * steady glow: the glow IS the feature, so it becomes constant rather than
 * disappearing — the same call `HighlightController.pulse()` makes.
 *
 * ## Shape
 *
 * Presentational state lives here (the stop, the fetch), graph state does not:
 * everything about the graph arrives through `useGraphEngine()`. That is what
 * lets this mount as a child of `<GraphView>` without either file knowing more
 * about the other than the contract.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, RotateCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api, ApiError, type GraphChangedResponse } from "../../lib/api";
import type { WhereNode } from "../../lib/viewConfig";
import { verb } from "../../lib/feed";
import { fmtDateTime, fmtNumber } from "../../lib/ui";
import { changedHighlight, makeHighlightSet, DIM_ALPHA } from "../../lib/graph/highlight";
import { filterKey, graphWhere, useGraphEngine } from "../../views/GraphView";

/* ------------------------------------------------------------------ *
 * the window: discrete stops, so the drag is reversible and keyboardable
 * ------------------------------------------------------------------ */

/** One position of the scrubber. `hours: 0` is "all time" — the scrubber off. */
interface ScrubberStop {
  /** stable and content-free: it is a storage key and (later) a saved view's. */
  readonly key: string;
  /** window length in hours; 0 means no window at all. */
  readonly hours: number;
  /** how the window reads in a sentence: "the last 7 days". */
  readonly label: string;
}

/**
 * The stops, narrow → wide, ending at "all time".
 *
 * Discrete rather than continuous on purpose. A continuous milliseconds slider
 * is impossible to land on the same window twice, cannot be driven from the
 * keyboard in meaningful units, and would fire a request per pixel; a stop
 * list is arrow-key operable, announces itself ("the last 7 days"), and makes
 * the presets literally the same control as the drag rather than a second one.
 *
 * Left → right widens, so dragging right GROWS the lit set — the motion the
 * feature is named for.
 */
export const SCRUBBER_STOPS: readonly ScrubberStop[] = [
  { key: "1h", hours: 1, label: "the last hour" },
  { key: "3h", hours: 3, label: "the last 3 hours" },
  { key: "6h", hours: 6, label: "the last 6 hours" },
  { key: "12h", hours: 12, label: "the last 12 hours" },
  { key: "24h", hours: 24, label: "the last 24 hours" },
  { key: "2d", hours: 48, label: "the last 2 days" },
  { key: "3d", hours: 72, label: "the last 3 days" },
  { key: "7d", hours: 24 * 7, label: "the last 7 days" },
  { key: "14d", hours: 24 * 14, label: "the last 14 days" },
  { key: "30d", hours: 24 * 30, label: "the last 30 days" },
  { key: "60d", hours: 24 * 60, label: "the last 60 days" },
  { key: "90d", hours: 24 * 90, label: "the last 90 days" },
  { key: "180d", hours: 24 * 180, label: "the last 180 days" },
  { key: "1y", hours: 24 * 365, label: "the last year" },
  { key: "all", hours: 0, label: "all time" },
];

/** The four buttons above the drag. They are stops, not a parallel control. */
const SCRUBBER_PRESETS: readonly string[] = ["24h", "7d", "30d", "all"];

/** Short face for a preset button. */
const PRESET_LABELS: Readonly<Record<string, string>> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  all: "All",
};

/** Index of the "off" stop — also the default, so the graph mounts fully lit. */
export const ALL_TIME_INDEX = SCRUBBER_STOPS.length - 1;

/** A stop by key, or "all time" for anything unrecognised. Never throws. */
export function stopIndexOf(key: string): number {
  const i = SCRUBBER_STOPS.findIndex((s) => s.key === key);
  return i === -1 ? ALL_TIME_INDEX : i;
}

/** A stop by index, clamped — a slider value is not trusted. */
export function stopAt(index: number): ScrubberStop {
  if (!Number.isFinite(index)) return SCRUBBER_STOPS[ALL_TIME_INDEX]!;
  const i = Math.min(SCRUBBER_STOPS.length - 1, Math.max(0, Math.round(index)));
  return SCRUBBER_STOPS[i]!;
}

/** The `since` bound for a stop, or null when the scrubber is off. */
export function sinceForStop(stop: ScrubberStop, now: number = Date.now()): string | null {
  if (stop.hours <= 0) return null;
  return new Date(now - stop.hours * 3_600_000).toISOString();
}

/**
 * The label the spec asks for, in plain words, naming the instant AND the
 * window — "since 3:20 PM" alone is unreadable a day later, and "the last 7
 * days" alone hides which 7 days a stale panel is showing.
 */
export function windowCopy(stop: ScrubberStop, since: string | null): string {
  if (stop.hours <= 0 || since === null) {
    return "Showing all time — no since-window, nothing is dimmed.";
  }
  return `Showing changes since ${fmtDateTime(since)} — ${stop.label}.`;
}

/* ------------------------------------------------------------------ *
 * pure helpers over the SERVER'S ids (tested directly)
 * ------------------------------------------------------------------ */

/**
 * The server's ids as dense indices, dropping the ones this client has not
 * loaded (a later page, or a node outside the current filter). The dropped
 * ones are reported as a number, never invented as nodes.
 */
export function mapChangedIds(
  ids: readonly string[],
  indexOf: (id: string) => number | undefined,
): Set<number> {
  const out = new Set<number>();
  for (const id of ids) {
    const i = indexOf(id);
    if (i !== undefined) out.add(i);
  }
  return out;
}

/**
 * `byKind` as prose, most-frequent first, through the timeline's OWN verb map
 * so the graph and the feed never disagree about what "update_props" is
 * called. These counts are the server's post-intersection ones.
 */
export function kindSummary(byKind: Readonly<Record<string, number>>): string {
  const merged = new Map<string, number>();
  for (const [kind, n] of Object.entries(byKind)) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const word = verb(kind);
    merged.set(word, (merged.get(word) ?? 0) + n);
  }
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word, n]) => `${fmtNumber(n)} ${word}`)
    .join(" · ");
}

/**
 * The count sentence. `count` is the server's (post-intersection) id count;
 * `lit` is how many of those ids this client has actually loaded. Both are
 * counts of the SAME returned ids — nothing here is derived from a feed row.
 */
export function changedCopy(count: number, lit: number): string {
  if (count === 0) return "Nothing you can see changed in this window.";
  const noun = `${fmtNumber(count)} object${count === 1 ? "" : "s"}`;
  if (lit >= count) return `${noun} changed — glowing in the graph.`;
  if (lit === 0) {
    return `${noun} changed, none of them in the part of the graph loaded so far.`;
  }
  return `${noun} changed — ${fmtNumber(lit)} glowing here, the rest outside the loaded graph.`;
}

/** Pulse period, matching `HighlightController`'s. Half of it per install. */
export const PULSE_PERIOD_MS = 1600;

/** The dim floor the pulse breathes DOWN to (from `DIM_ALPHA.changed`). */
export const PULSE_DIM_LOW = 0.18;

/** How long a drag must rest before it becomes a request. */
export const SCRUB_DEBOUNCE_MS = 250;

/* ------------------------------------------------------------------ *
 * reduced motion
 * ------------------------------------------------------------------ */

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/* ------------------------------------------------------------------ *
 * the component
 * ------------------------------------------------------------------ */

interface TimeScrubberProps {
  /** which stop to open on. Defaults to "all" — the graph mounts undimmed. */
  defaultStop?: string;
  /** injectable clock, so the window copy is assertable in tests. */
  now?: () => number;
}

type FetchState =
  | { phase: "off" }
  | { phase: "loading" }
  | { phase: "ready"; data: GraphChangedResponse }
  | { phase: "error"; message: string };

const NO_EDGES: ReadonlySet<number> = new Set<number>();

export function TimeScrubber({ defaultStop = "all", now = Date.now }: TimeScrubberProps = {}) {
  const engine = useGraphEngine();
  const reduced = useReducedMotion();

  const [index, setIndex] = useState(() => stopIndexOf(defaultStop));
  /** the stop a request was actually made for — the drag debounces onto it. */
  const [committed, setCommitted] = useState(() => stopIndexOf(defaultStop));
  const [state, setState] = useState<FetchState>({ phase: "off" });
  const [reloadNonce, setReloadNonce] = useState(0);

  const stop = stopAt(index);
  const committedStop = stopAt(committed);

  // Latest-value refs: the highlight effects must not re-run (and reinstall a
  // set) merely because the engine object got a new identity this render —
  // which it does on every pulse, since the pulse IS a highlight change.
  const indexOfRef = useRef(engine.indexOf);
  indexOfRef.current = engine.indexOf;
  const { setHighlight, revision } = engine;

  // The view's own filter, so the server intersects against the nodes actually
  // on screen. `filterKey` is the stable dependency; the AST itself is rebuilt
  // per request because it carries a `since` computed from the clock.
  const filtersKey = filterKey(engine.filters);
  const filtersRef = useRef(engine.filters);
  filtersRef.current = engine.filters;

  /* ---------------- drag → one request ---------------- */

  useEffect(() => {
    if (index === committed) return;
    const t = setTimeout(() => setCommitted(index), SCRUB_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [index, committed]);

  useEffect(() => {
    const since = sinceForStop(committedStop, now());
    if (since === null) {
      setState({ phase: "off" });
      return;
    }
    let cancelled = false;
    setState({ phase: "loading" });
    const where: WhereNode | undefined = graphWhere(filtersRef.current, now());
    api
      .graphChanged({ since, ...(where !== undefined ? { where } : {}) })
      .then((data) => {
        if (!cancelled) setState({ phase: "ready", data });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : "could not read what changed";
        setState({ phase: "error", message });
      });
    return () => {
      cancelled = true;
    };
    // Deps are deliberate: `now` is a stable injected clock and the filter is
    // represented by its stable key (`filtersRef` carries the AST), so a
    // re-render never refires the request — only a new window, a new filter or
    // an explicit recheck does.
  }, [committedStop, filtersKey, reloadNonce, now]);

  /* ---------------- ids → the "changed" highlight layer ---------------- */

  const data = state.phase === "ready" ? state.data : null;
  const ids = data?.ids;

  const indices = useMemo(
    // `revision` is the signal that later pages landed: nodesRef is mutated in
    // place, so a page that arrives after the fetch joins the glow here.
    () => mapChangedIds(ids ?? [], indexOfRef.current),
    [ids, revision],
  );

  useEffect(() => {
    setHighlight("changed", indices.size === 0 ? null : changedHighlight(indices));
  }, [indices, setHighlight]);

  // Leaving the scrubber must never leave the graph dimmed.
  useEffect(() => () => setHighlight("changed", null), [setHighlight]);

  /* ---------------- the pulse ---------------- */

  useEffect(() => {
    if (indices.size === 0 || reduced) return;
    let low = false;
    const timer = setInterval(() => {
      low = !low;
      setHighlight(
        "changed",
        makeHighlightSet("changed", indices, NO_EDGES, low ? PULSE_DIM_LOW : DIM_ALPHA.changed),
      );
    }, PULSE_PERIOD_MS / 2);
    return () => clearInterval(timer);
  }, [indices, reduced, setHighlight]);

  /* ---------------- copy ---------------- */

  const since = sinceForStop(committedStop, now());
  const clear = useCallback(() => setIndex(ALL_TIME_INDEX), []);

  const count = data?.count ?? 0;
  const lit = indices.size;

  return (
    <div
      className="pointer-events-auto flex w-full max-w-[26rem] flex-col gap-1.5 border border-line-soft bg-panel p-2 shadow-sm"
      data-testid="time-scrubber"
    >
      <div className="flex items-center gap-1.5">
        <Clock size={13} className="shrink-0 text-dim" aria-hidden />
        <span className="flex-1 text-[11.5px] text-mut">Highlight changes since</span>
        {committedStop.hours > 0 && (
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="h-5 gap-1 px-1.5 text-[10.5px] text-dim hover:text-ink"
              aria-label="Recheck this window"
            >
              <RotateCw size={10} aria-hidden /> Recheck
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={clear}
              className="h-5 gap-1 px-1.5 text-[10.5px] text-dim hover:text-ink"
              aria-label="Clear the since-window"
            >
              <X size={10} aria-hidden /> Clear
            </Button>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {SCRUBBER_PRESETS.map((key) => {
          const preset = stopIndexOf(key);
          const active = index === preset;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setIndex(preset)}
              aria-pressed={active}
              className={`flex-1 rounded-none border border-line-soft px-1.5 py-0.5 text-[11px] transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ink-strong)] ${
                active ? "bg-hover-strong text-ink" : "text-dim"
              }`}
            >
              {PRESET_LABELS[key] ?? key}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-0.5">
        <label htmlFor="graph-scrubber" className="sr-only">
          Changed since
        </label>
        <input
          id="graph-scrubber"
          type="range"
          min={0}
          max={SCRUBBER_STOPS.length - 1}
          step={1}
          value={index}
          aria-valuetext={stop.label}
          onChange={(e) => setIndex(Number(e.target.value))}
          className="h-1 w-full cursor-pointer appearance-none rounded-none bg-[var(--line)] accent-[var(--ink-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink-strong)]"
        />
        <div className="flex justify-between text-[10px] text-dim" aria-hidden>
          <span>{SCRUBBER_STOPS[0]!.key}</span>
          <span className="font-mono">{stop.key}</span>
          <span>all</span>
        </div>
      </div>

      <p className="text-[11.5px] text-mut" role="status">
        {windowCopy(committedStop, since)}
      </p>

      {state.phase === "loading" && (
        <p className="text-[11px] text-dim" role="status">
          Reading what changed…
        </p>
      )}

      {state.phase === "error" && (
        <p className="text-[11px] text-dim" role="status">
          Could not read what changed: {state.message}. Nothing is dimmed.
        </p>
      )}

      {data !== null && (
        <div className="flex flex-col gap-0.5">
          <p className="text-[11.5px] text-ink">{changedCopy(count, lit)}</p>
          {count > 0 && kindSummary(data.byKind) !== "" && (
            <p className="font-mono text-[10.5px] text-dim">{kindSummary(data.byKind)}</p>
          )}
          {data.truncated !== null && (
            <p className="text-[10.5px] text-dim">
              The graph is showing the {fmtNumber(data.truncated.shown)} most-connected of{" "}
              {fmtNumber(data.truncated.total)} objects, so this window is only the changes among
              those — filter by type or date to narrow it.
            </p>
          )}
          {data.feedTruncated && (
            <p className="text-[10.5px] text-dim">
              Only the most recent activity was scanned; older changes inside this window are not
              shown. Pick a shorter window to be sure.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
