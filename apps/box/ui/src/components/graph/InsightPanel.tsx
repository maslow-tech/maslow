/**
 * "What matters here?" — the graph's answer to the one question a force layout
 * cannot answer by being pretty.
 *
 * Three ranked answers, each of which the table views cannot give you at all:
 *
 *  1. **Hubs**, by visible degree. The node radius already encodes this, but a
 *     radius is a comparison you have to make with your eyes across a screen;
 *     the list is the same fact you can read, hover and act on.
 *  2. **Brokers**, by betweenness (Brandes — exact while the visible graph is
 *     small, 64 sampled pivots above that). This is the one that earns the
 *     panel: degree finds the object with the most links, betweenness finds the
 *     object that JOINS TWO CLUSTERS — usually a low-degree thing nobody would
 *     have looked at, and usually the most load-bearing object in the brain.
 *  3. **Orphans**, visible degree 0. Not decoration: this is the brain's actual
 *     to-do list of things to go and link, which is why the row set can be
 *     selected in one click and handed straight to the selection bar's
 *     "link all to…".
 *
 * ## The honesty rule this file exists to keep
 *
 * Every number here is computed over the VISIBLE SUBGRAPH — the server counts
 * `degree` over edges whose BOTH endpoints the viewer can see, because a degree
 * that included hidden links would tell the viewer a private object exists and
 * point at it (visible-only degree, by design). The consequence is that an
 * object whose only link is to somebody else's private note is an orphan HERE
 * and is not an orphan in the brain. That would be an unpleasant surprise if
 * the panel let you discover it by acting on it, so the panel SAYS it, in the
 * panel, above the lists — see `VISIBILITY_NOTE`. Copy is the feature.
 *
 * The same rule is why the ranks are labelled provisional while pages are still
 * landing: mid-load the CSR holds only the pages that arrived, so a broker score
 * computed then would be an answer about a subgraph of a subgraph. Betweenness
 * therefore runs only once the walk is `ready`, and the panel says why until it
 * is.
 *
 * ## Shape
 *
 * Presentational and controlled (`InsightPanelView`), exactly like
 * `GraphControls`: every value arrives as a prop, every change leaves as a
 * callback, so the lists are testable without a WebGL context, a layout worker
 * or a mounted `<GraphView>`. `InsightPanel` is the thin wiring that reads
 * `useGraphEngine()` and mounts as a CHILD of the view (the p6-t8 mount
 * contract), which is why neither this feature nor the view has to know about
 * the other's internals.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Link2, Radar, ScatterChart, Share2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TypeIcon } from "../bits";
import { hoverHighlight } from "../../lib/graph/highlight";
import { labelTextFor } from "../../lib/graph/labels";
import type { CameraState, GraphNode } from "../../lib/graph/types";
// The broker ranking is Brandes betweenness — heavy enough to want a thread. It
// runs through the SHARED, unit-tested engine in lib/graph/analysis.ts (the same
// function the analysis worker runs), not a second copy maintained here: a
// divergent in-panel Brandes was exactly the drift this consolidation removes.
import { analyze, type AnalysisSummary, type RankedNode } from "../../lib/graph/analysis";
import {
  createAnalysisWorker,
  requestAnalysis,
  type AnalysisWorkerLike,
} from "../../lib/graph/analysis.worker";
import { fmtNumber } from "../../lib/ui";
import { useGraphEngine } from "../../views/GraphView";

/* ------------------------------------------------------------------ *
 * copy
 * ------------------------------------------------------------------ */

/**
 * The visibility rule, in the panel rather than in a doc nobody opens.
 *
 * It is a constant because it is asserted by the tests: the panel may never
 * ship a hub rank or an orphan count without this sentence next to it.
 */
export const VISIBILITY_NOTE =
  "Counted over the objects you can see. An object whose only links are to " +
  "things private to someone else looks like an orphan here — “orphan” means " +
  "orphan as far as you can see, not orphan in the brain.";

/** Said while pages are still landing, so a provisional rank never reads as final. */
export const PROVISIONAL_NOTE =
  "Still loading — these ranks change as the rest of the graph lands.";

/* ------------------------------------------------------------------ *
 * ranking (pure — tested directly)
 * ------------------------------------------------------------------ */

/** Rows shown per ranked list. Ten is a glance; fifty is a second list view. */
export const INSIGHT_LIST_LIMIT = 10;

/** Orphans are a to-do list, so the panel shows more of them before it stops. */
const ORPHAN_LIST_LIMIT = 50;

/** One row of a ranked list. `index` is the dense index — the graph's currency. */
export interface InsightRow {
  readonly index: number;
  readonly id: string;
  readonly title: string | null;
  readonly type: string | null;
  /** the metric shown at the right of the row (links, or a broker score). */
  readonly value: number;
}

/** `store.idAt`, as the pure rankers take it. */
type IdAt = (index: number) => string | undefined;

function toRow(
  nodes: readonly GraphNode[],
  idAt: IdAt,
  index: number,
  value: number,
): InsightRow | null {
  const node = nodes[index];
  if (node === undefined) return null;
  const id = idAt(index) ?? node.id;
  if (typeof id !== "string" || id === "") return null;
  return { index, id, title: node.title, type: node.type, value };
}

/**
 * Sort desc by value, then by title, then by id — a stable, content-independent
 * tie-break so two runs over the same data produce the same list (an unstable
 * top-10 that reshuffles on every re-render is unreadable).
 */
function byValue(a: InsightRow, b: InsightRow): number {
  if (b.value !== a.value) return b.value - a.value;
  const at = (a.title ?? "").toLowerCase();
  const bt = (b.title ?? "").toLowerCase();
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Top hubs by VISIBLE degree.
 *
 * `GraphNode.degree` is the server's visible-only count and is the authority
 * (see `types.ts`); the CSR's own degree agrees with it only once every page
 * has landed, and mid-load it is legitimately smaller. Degree 0 is excluded —
 * an orphan is not a hub, it is the third list.
 */
export function topHubs(
  nodes: readonly GraphNode[],
  idAt: IdAt,
  limit: number = INSIGHT_LIST_LIMIT,
): InsightRow[] {
  const rows: InsightRow[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const degree = nodes[i]?.degree ?? 0;
    if (degree <= 0) continue;
    const row = toRow(nodes, idAt, i, degree);
    if (row !== null) rows.push(row);
  }
  rows.sort(byValue);
  return rows.slice(0, Math.max(0, limit));
}

/**
 * Broker rows from `analyze`'s ranked betweenness result. The engine already
 * dropped zero-score nodes and sorted+capped to the requested count (score desc,
 * ties by index), so this is a straight index→row projection over the nodes the
 * server has handed us; a node whose page has not landed is simply skipped.
 */
function brokerRows(
  ranked: readonly RankedNode[],
  nodes: readonly GraphNode[],
  idAt: IdAt,
  limit: number = INSIGHT_LIST_LIMIT,
): InsightRow[] {
  const rows: InsightRow[] = [];
  for (const r of ranked) {
    const row = toRow(nodes, idAt, r.index, r.score);
    if (row !== null) rows.push(row);
  }
  return rows.slice(0, Math.max(0, limit));
}

/**
 * Every dense index with visible degree 0, in index (arrival) order.
 *
 * Deliberately read off `GraphNode.degree` rather than the CSR: the server's
 * count is the whole visible truth for a node the moment its page lands, while
 * the CSR is only as complete as the pages so far — using it would flag a node
 * as an orphan purely because its neighbour is on page four.
 */
export function orphanIndices(nodes: readonly GraphNode[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if ((nodes[i]?.degree ?? 0) === 0) out.push(i);
  }
  return out;
}

/** Orphan rows, alphabetical — a to-do list you read, not a ranking. */
export function orphanRows(
  nodes: readonly GraphNode[],
  idAt: IdAt,
  limit: number = ORPHAN_LIST_LIMIT,
): InsightRow[] {
  const rows: InsightRow[] = [];
  for (const i of orphanIndices(nodes)) {
    const row = toRow(nodes, idAt, i, 0);
    if (row !== null) rows.push(row);
  }
  rows.sort((a, b) => {
    const at = labelTextFor(a.title, a.id).toLowerCase();
    const bt = labelTextFor(b.title, b.id).toLowerCase();
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows.slice(0, Math.max(0, limit));
}

/* ------------------------------------------------------------------ *
 * camera framing (pure — tested directly)
 * ------------------------------------------------------------------ */

/** Never zoom past this, however tight the set is — a lone node is not 40×. */
export const MAX_FIT_SCALE = 2.5;

/**
 * The camera that frames `indices` inside a container of `size`, or null when
 * none of them has a finite position yet (the first frames before the worker
 * has ticked, and every jsdom test).
 *
 * Pure so the framing is testable without a WebGL context: the renderer's
 * `positions()` and `size()` are the only two things it needs, and both are
 * plain data.
 */
export function cameraFor(
  positions: Float32Array | readonly number[],
  size: { width: number; height: number },
  indices: Iterable<number>,
  paddingPx = 80,
): CameraState | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
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

  const width = Math.max(1, size.width - 2 * paddingPx);
  const height = Math.max(1, size.height - 2 * paddingPx);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min(MAX_FIT_SCALE, Math.max(0.05, Math.min(width / spanX, height / spanY)));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
}

/* ------------------------------------------------------------------ *
 * the presentational panel
 * ------------------------------------------------------------------ */

/** Which ranked list a row came from — the hover/click handlers take it along. */
export type InsightList = "hubs" | "brokers" | "orphans";

export type BrokerPhase = "idle" | "waiting" | "computing" | "ready";

export interface InsightPanelViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hubs: readonly InsightRow[];
  brokers: readonly InsightRow[];
  orphans: readonly InsightRow[];
  /** total orphans, which can exceed the rows shown. */
  orphanCount: number;
  brokerPhase: BrokerPhase;
  /** false ⇒ the broker scores are extrapolated from sampled pivots. */
  brokersExact: boolean;
  /** the walk is still paging — every rank on screen is provisional. */
  loading: boolean;
  /**
   * The graph on screen is a TOP-DEGREE sample of a larger brain (`truncated`
   * for a brain over `GRAPH_FULL_MAX`, or a mobile `deviceCapped` budget), not
   * the whole thing. Orphans (degree 0) are the FIRST nodes such a sample drops,
   * so an empty orphan list here means "not loaded", never "none exist"; a
   * low-degree broker joining two clusters can be absent for the same reason.
   * When set, both lists are suppressed with an honest caveat instead of
   * presented as an authoritative answer.
   */
  sampled: boolean;
  /** hover (or keyboard focus) moved onto a row, or off every row (null). */
  onHoverRow: (row: InsightRow | null, list: InsightList) => void;
  /** a row was clicked — opens the side-peek on that node. */
  onOpenRow: (row: InsightRow, list: InsightList) => void;
  /** the orphans one-click filter: isolate them / release them. */
  orphansIsolated: boolean;
  onToggleOrphans: () => void;
  /** the shortcut into the selection bar's "link all to…" (p6-t13). */
  onLinkOrphans?: (() => void) | undefined;
  /**
   * Touch OR a narrow pane (the engine's shared `compact` flag). When set the
   * panel is a bottom sheet, not a top-right floating card — the same treatment
   * GraphView's rail, legend and peek get — so it does not paint on top of the
   * phone's top status strip and the top-centre menu/search/scrubber column.
   */
  compact?: boolean;
}

function Section({
  id,
  title,
  hint,
  count,
  icon,
  openSection,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  count: number | null;
  icon: ReactNode;
  openSection: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="shrink-0 border-t border-line-soft first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={openSection}
        aria-controls={`${id}-body`}
        className="flex w-full items-center gap-1.5 rounded-none px-2.5 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ink-strong)]"
      >
        {openSection ? (
          <ChevronDown size={12} className="shrink-0 text-dim" aria-hidden />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-dim" aria-hidden />
        )}
        <span className="shrink-0 text-dim" aria-hidden>
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-[650] text-ink">{title}</span>
        {count !== null && (
          <span className="shrink-0 font-mono text-[10.5px] text-dim tabular-nums">
            {fmtNumber(count)}
          </span>
        )}
      </button>
      <div id={`${id}-body`} hidden={!openSection}>
        <p className="px-2.5 pb-1 text-[11px] text-dim">{hint}</p>
        {children}
      </div>
    </div>
  );
}

function Rows({
  rows,
  list,
  valueLabel,
  formatValue,
  onHoverRow,
  onOpenRow,
  emptyCopy,
}: {
  rows: readonly InsightRow[];
  list: InsightList;
  valueLabel: string;
  formatValue: (row: InsightRow) => string;
  onHoverRow: (row: InsightRow | null, list: InsightList) => void;
  onOpenRow: (row: InsightRow, list: InsightList) => void;
  emptyCopy: string;
}) {
  if (rows.length === 0) {
    return <p className="px-2.5 pb-2 text-[11.5px] text-dim">{emptyCopy}</p>;
  }
  return (
    <ul className="max-h-56 overflow-y-auto pb-1.5" onPointerLeave={() => onHoverRow(null, list)}>
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            onClick={() => onOpenRow(row, list)}
            onPointerEnter={() => onHoverRow(row, list)}
            onFocus={() => onHoverRow(row, list)}
            onBlur={() => onHoverRow(null, list)}
            title={`${labelTextFor(row.title, row.id)} — ${formatValue(row)} ${valueLabel}`}
            className="flex w-full items-center gap-1.5 rounded-none px-2.5 py-1 text-left text-[12px] hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ink-strong)]"
          >
            <TypeIcon type={row.type} size={12} />
            <span className="min-w-0 flex-1 truncate text-ink">
              {labelTextFor(row.title, row.id)}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] text-dim tabular-nums">
              {formatValue(row)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The panel itself, controlled. Everything it knows arrives as a prop, which is
 * what makes the lists and their copy assertable without a graph engine.
 */
export function InsightPanelView({
  open,
  onOpenChange,
  hubs,
  brokers,
  orphans,
  orphanCount,
  brokerPhase,
  brokersExact,
  loading,
  sampled,
  onHoverRow,
  onOpenRow,
  orphansIsolated,
  onToggleOrphans,
  onLinkOrphans,
  compact = false,
}: InsightPanelViewProps) {
  const [sections, setSections] = useState<Record<InsightList, boolean>>({
    hubs: true,
    brokers: false,
    orphans: false,
  });
  const toggle = useCallback(
    (key: InsightList) => setSections((prev) => ({ ...prev, [key]: !prev[key] })),
    [],
  );

  if (!open) {
    // On compact the trigger sits BOTTOM-right, not top-right: the top edge is
    // owned by the phone's status strip and the top-centre overlay column, and
    // a top-right button paints on top of them. Bottom-right clears both.
    return (
      <div
        className={
          compact
            ? "pointer-events-auto touch-chrome safe-bottom absolute right-3 bottom-3 z-30"
            : "pointer-events-auto absolute top-3 right-3 z-20"
        }
      >
        <Button
          size="xs"
          variant="secondary"
          onClick={() => onOpenChange(true)}
          aria-expanded={false}
          className="gap-1 border border-line-soft shadow-sm"
        >
          <Radar size={12} aria-hidden /> What matters here
        </Button>
      </div>
    );
  }

  return (
    <aside
      aria-label="What matters here — hubs, brokers and orphans"
      className={
        compact
          ? // A full-width bottom sheet (like the rail, legend and peek), above
            // the other overlays' z-20 so it never renders behind the top-centre
            // column. Height-capped so the map stays partly visible above it.
            "pointer-events-auto touch-chrome safe-bottom absolute inset-x-3 bottom-3 z-30 flex max-h-[70%] flex-col border border-line-soft bg-panel shadow-md"
          : "pointer-events-auto absolute top-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] w-72 flex-col border border-line-soft bg-panel shadow-md"
      }
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line-soft px-2.5 py-1.5">
        <Radar size={13} className="shrink-0 text-dim" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-[12.5px] font-[650] text-ink">
          What matters here
        </h2>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Collapse the insight panel"
          className="shrink-0 rounded-none p-1 text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)]"
        >
          <X size={12} aria-hidden />
        </button>
      </div>

      <p className="shrink-0 border-b border-line-soft px-2.5 py-1.5 text-[11px] text-dim">
        {VISIBILITY_NOTE}
      </p>

      {loading && (
        <p
          className="shrink-0 border-b border-line-soft px-2.5 py-1 text-[11px] text-mut"
          role="status"
        >
          {PROVISIONAL_NOTE}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section
          id="graph-insight-hubs"
          title="Hubs"
          hint="the most-linked objects you can see."
          count={hubs.length}
          icon={<Share2 size={11} aria-hidden />}
          openSection={sections.hubs}
          onToggle={() => toggle("hubs")}
        >
          <Rows
            rows={hubs}
            list="hubs"
            valueLabel="links"
            formatValue={(row) => fmtNumber(row.value)}
            onHoverRow={onHoverRow}
            onOpenRow={onOpenRow}
            emptyCopy="Nothing is linked yet — every object here is an orphan."
          />
        </Section>

        <Section
          id="graph-insight-brokers"
          title="Brokers — objects joining clusters"
          hint={
            sampled
              ? "high betweenness over the most-connected sample on screen — not the whole brain. A low-degree object joining two clusters may be outside the sample entirely; filter by type or date to rank the full graph."
              : brokersExact
                ? "high betweenness: the objects most shortest paths run through. Degree misses these — a broker can have two links and still hold two clusters together."
                : "high betweenness, estimated from sampled pivots on a graph this size. The objects most shortest paths run through — degree misses these."
          }
          count={brokerPhase === "ready" ? brokers.length : null}
          icon={<ScatterChart size={11} aria-hidden />}
          openSection={sections.brokers}
          onToggle={() => toggle("brokers")}
        >
          {brokerPhase === "ready" ? (
            <Rows
              rows={brokers}
              list="brokers"
              valueLabel="paths through"
              formatValue={(row) => row.value.toFixed(row.value >= 10 ? 0 : 1)}
              onHoverRow={onHoverRow}
              onOpenRow={onOpenRow}
              emptyCopy="No object sits between two others here — nothing to broker yet."
            />
          ) : (
            <p className="px-2.5 pb-2 text-[11.5px] text-dim" role="status">
              {brokerPhase === "computing"
                ? "Working out who joins what…"
                : "Brokers are worked out once the whole graph has landed."}
            </p>
          )}
        </Section>

        <Section
          id="graph-insight-orphans"
          title="Orphans — nothing links them"
          hint={
            sampled
              ? "the brain's actual gaps — but they can't be found in a sample. Orphans are degree-0, and this view shows only the most-connected objects, so the least-connected (orphans among them) were never loaded."
              : "the brain's actual gaps: objects with no visible link at all. This is a to-do list of things to go and link."
          }
          count={sampled ? null : orphanCount}
          icon={<Link2 size={11} aria-hidden />}
          openSection={sections.orphans}
          onToggle={() => toggle("orphans")}
        >
          {sampled ? (
            <p className="px-2.5 pb-2 text-[11.5px] text-dim" role="status">
              Orphans can't be computed on a sampled graph — filter by type or date to load the
              whole brain, then the gaps are exact.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1 px-2.5 pb-1.5">
                <Button
                  size="xs"
                  variant={orphansIsolated ? "default" : "secondary"}
                  onClick={onToggleOrphans}
                  disabled={orphanCount === 0}
                  aria-pressed={orphansIsolated}
                  className="gap-1"
                >
                  {orphansIsolated ? "Show everything again" : `Isolate ${fmtNumber(orphanCount)}`}
                </Button>
                {onLinkOrphans !== undefined && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={onLinkOrphans}
                    disabled={orphanCount === 0}
                    className="gap-1 text-dim hover:text-ink"
                  >
                    <Link2 size={11} aria-hidden /> Link selected to…
                  </Button>
                )}
              </div>
              <Rows
                rows={orphans}
                list="orphans"
                valueLabel="visible links"
                formatValue={() => "0"}
                onHoverRow={onHoverRow}
                onOpenRow={onOpenRow}
                emptyCopy="Nothing is stranded — every object you can see has at least one link."
              />
              {orphanCount > orphans.length && (
                <p className="px-2.5 pb-2 text-[11px] text-dim">
                  {fmtNumber(orphanCount - orphans.length)} more not listed. “Isolate” selects all{" "}
                  {fmtNumber(orphanCount)}.
                </p>
              )}
            </>
          )}
        </Section>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * the mounted panel
 * ------------------------------------------------------------------ */

interface InsightPanelProps {
  /** rows per ranked list. */
  limit?: number;
  /** start expanded. Collapsed by default — the graph is the page, not this. */
  defaultOpen?: boolean;
  /**
   * The selection bar's "link all to…" (p6-t13). The orphan filter already
   * SELECTS every orphan, so the bar can act on them with no help from here;
   * this is the shortcut that saves the trip to the bar. Omitted ⇒ no button,
   * rather than a button that does nothing.
   */
  onLinkSelected?: (ids: string[]) => void;
  /**
   * The fallback idle scheduler, used ONLY when no real Worker exists (jsdom,
   * or a browser without `Worker`) — injectable for tests. Defaults to
   * `requestIdleCallback`/`setTimeout`.
   */
  schedule?: (fn: () => void) => () => void;
  /**
   * The analysis worker factory — injectable for tests. Defaults to the real
   * off-main-thread worker. A test double can resolve synchronously with no
   * WebGL/Worker at all; `null` forces the inline `schedule` fallback.
   */
  createWorker?: (() => AnalysisWorkerLike) | null;
}

/** Run `fn` when the browser is next idle; returns its canceller. */
function defaultSchedule(fn: () => void): () => void {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => fn(), { timeout: 600 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = setTimeout(fn, 0);
  return () => clearTimeout(timer);
}

/** A real dedicated Worker exists (the browser); false in jsdom/node tests. */
function supportsWorker(): boolean {
  return typeof Worker !== "undefined";
}

/** How long the pointer must rest on a row before the camera goes there. */
const HOVER_CAMERA_DELAY_MS = 180;

export function InsightPanel({
  limit = INSIGHT_LIST_LIMIT,
  defaultOpen = false,
  onLinkSelected,
  schedule = defaultSchedule,
  createWorker = createAnalysisWorker,
}: InsightPanelProps = {}) {
  const engine = useGraphEngine();
  const [open, setOpen] = useState(defaultOpen);
  const [brokerState, setBrokerState] = useState<{
    revision: number;
    brokers: readonly RankedNode[];
    exact: boolean;
  } | null>(null);
  const [computing, setComputing] = useState(false);
  // The worker is created lazily on first use and reused across recomputes;
  // torn down on unmount so a closed graph never leaves a thread running.
  const workerRef = useRef<AnalysisWorkerLike | null>(null);
  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  const { nodes, csr, revision, load, camera, setHighlight, select, clearSelection, setFocus } =
    engine;
  const idAt = engine.idAt;

  // Reserve the panel's own rectangle (w-72 = 288px, + the right-3 = 12px gutter)
  // so `camera.fit` frames content into the region left visible beside it, not
  // behind it. Cleared when the panel closes or unmounts. Only meaningful on
  // desktop; the engine ignores reserves on touch, where the panel is a sheet.
  const reserveFit = engine.reserveFit;
  useEffect(() => {
    reserveFit("insight", open ? { right: 300 } : null);
    return () => reserveFit("insight", null);
  }, [open, reserveFit]);
  const ready = load.phase === "ready";

  /* ---------------- the three lists ---------------- */

  // `nodes` is mutated in place as pages land, so `revision` is the signal —
  // exactly as the view's own memos do it.
  const hubs = useMemo(() => topHubs(nodes, idAt, limit), [revision, limit, idAt, nodes]);
  const orphanAll = useMemo(() => orphanIndices(nodes), [revision, nodes]);
  const orphans = useMemo(
    () => orphanRows(nodes, idAt, ORPHAN_LIST_LIMIT),
    [revision, idAt, nodes],
  );

  /**
   * Betweenness runs only when the panel's broker list can actually be looked
   * at AND the walk has finished: mid-load the CSR is a subgraph of a subgraph,
   * and a broker ranking over it would be confidently wrong.
   *
   * It runs GENUINELY off the main thread — in `analysis.worker.ts`, via the
   * shared `analyze` engine — because Brandes over a 5,000-node graph is a
   * multi-second stall and an idle callback would still run it on the main
   * thread, janking the canvas. When no real Worker exists (jsdom, a browser
   * without `Worker`) it falls back to the same `analyze` on an idle callback,
   * so the panel still fills; it is the SAME function either way.
   */
  useEffect(() => {
    if (!open || !ready || csr === null || csr.n === 0) return;
    if (brokerState !== null && brokerState.revision === revision) return;
    setComputing(true);
    let cancelled = false;
    const finish = (summary: AnalysisSummary | null): void => {
      if (cancelled) return;
      if (summary !== null) {
        setBrokerState({ revision, brokers: summary.brokers, exact: summary.betweennessExact });
      }
      setComputing(false);
    };
    // Only the brokers are wanted here — the panel computes hubs and orphans
    // itself off the server's visible-degree count (see topHubs/orphanIndices),
    // which the CSR-derived versions cannot match mid-load. `hubs: 0` skips them.
    const options = { brokers: limit, hubs: 0 };

    if (createWorker !== null && supportsWorker()) {
      let worker = workerRef.current;
      if (worker === null) {
        worker = createWorker();
        workerRef.current = worker;
      }
      requestAnalysis(worker, csr, options)
        .then(finish)
        // A worker error leaves the prior ranking in place and just stops the
        // spinner — a graph that keeps running beats a panel that vanishes.
        .catch(() => finish(null));
      return () => {
        cancelled = true;
        setComputing(false);
      };
    }

    const cancel = schedule(() => finish(analyze(csr, options)));
    return () => {
      cancelled = true;
      cancel();
      setComputing(false);
    };
  }, [open, ready, csr, revision, brokerState, schedule, createWorker, limit]);

  const brokers = useMemo(
    () => (brokerState === null ? [] : brokerRows(brokerState.brokers, nodes, idAt, limit)),
    [brokerState, limit, idAt, nodes, revision],
  );

  const brokerPhase: BrokerPhase =
    brokerState !== null && brokerState.revision === revision
      ? "ready"
      : computing
        ? "computing"
        : "waiting";

  /* ---------------- hover: highlight now, camera after a beat ---------------- */

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverCamera = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);
  useEffect(() => cancelHoverCamera, [cancelHoverCamera]);

  const onHoverRow = useCallback(
    (row: InsightRow | null) => {
      cancelHoverCamera();
      if (row === null) {
        setHighlight("hover", null);
        return;
      }
      // The highlight is instant — that is the "which one is it" answer. The
      // camera waits, so running the pointer down a list of ten does not fly
      // the graph around ten times.
      setHighlight("hover", csr === null ? null : hoverHighlight(csr, row.index));
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        camera.centerOn(row.index);
      }, HOVER_CAMERA_DELAY_MS);
    },
    [cancelHoverCamera, camera, csr, setHighlight],
  );

  const onOpenRow = useCallback(
    (row: InsightRow) => {
      cancelHoverCamera();
      setFocus(row.index);
      camera.centerOn(row.index);
    },
    [camera, cancelHoverCamera, setFocus],
  );

  /* ---------------- the orphans filter ---------------- */

  const orphanSet = useMemo(() => new Set(orphanAll), [orphanAll]);
  const selection = engine.selection;
  const orphansIsolated =
    orphanSet.size > 0 &&
    selection.size === orphanSet.size &&
    [...selection].every((i) => orphanSet.has(i));

  const isolateOrphans = useCallback(() => {
    if (orphansIsolated) {
      clearSelection();
      return;
    }
    if (orphanSet.size === 0) return;
    // Selecting IS the filter: the view turns a selection into its own
    // highlight layer (everything else recedes, the members keep their labels)
    // and the selection bar's bulk actions become available on exactly this
    // set — which is what makes "here are your gaps" one click from "link
    // them to something".
    select(orphanAll, "replace");
    const renderer = engine.renderer;
    const next =
      renderer === null ? null : cameraFor(renderer.positions(), renderer.size(), orphanAll);
    if (next !== null) camera.ease(next);
    else camera.fit();
  }, [camera, clearSelection, engine.renderer, orphanAll, orphanSet.size, orphansIsolated, select]);

  const linkOrphans = useCallback(() => {
    if (onLinkSelected === undefined) return;
    if (!orphansIsolated) select(orphanAll, "replace");
    const ids = orphanAll.map((i) => idAt(i)).filter((id): id is string => typeof id === "string");
    onLinkSelected(ids);
  }, [idAt, onLinkSelected, orphanAll, orphansIsolated, select]);

  return (
    <InsightPanelView
      open={open}
      onOpenChange={setOpen}
      hubs={hubs}
      brokers={brokers}
      orphans={orphans}
      orphanCount={orphanAll.length}
      brokerPhase={brokerPhase}
      brokersExact={brokerState?.exact ?? true}
      loading={load.phase === "loading"}
      // The loaded graph is a top-degree slice (a brain over GRAPH_FULL_MAX, or
      // a mobile device budget), so orphans (degree 0, dropped first) and
      // low-degree brokers are structurally uncomputable from it.
      sampled={load.truncated !== null || (load.deviceCapped ?? null) !== null}
      onHoverRow={onHoverRow}
      onOpenRow={onOpenRow}
      orphansIsolated={orphansIsolated}
      onToggleOrphans={isolateOrphans}
      onLinkOrphans={onLinkSelected === undefined ? undefined : linkOrphans}
      compact={engine.compact}
    />
  );
}
