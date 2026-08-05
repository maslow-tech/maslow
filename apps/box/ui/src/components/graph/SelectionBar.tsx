/**
 * The graph's selection bar — and the alt-drag marquee that fills it.
 *
 * Selecting a visible cluster is the one thing only the graph can express, so
 * this is where the graph stops being a picture and becomes a working surface.
 * Three actions, and each is deliberately the smallest useful one:
 *
 *  - **Open all** pushes the whole selection onto the side-peek STACK (phase 4)
 *    rather than navigating away — you read fourteen objects without losing the
 *    camera, and closing walks back down the pile.
 *  - **Link all to…** picks one target object and one verb, then writes one
 *    link per selected object, each with the ROW'S OWN idempotency key.
 *  - **Set a property** writes one PATCH per selected object, each against
 *    that object's own `baseVersion`, read immediately beforehand.
 *
 * Everything a write touches lives in `lib/graph/selection.ts`; this file is
 * the surface. Four rules it is responsible for:
 *
 *  1. **A confirm step, always.** The bar composes an intent and then SAYS what
 *    it is about to do, in a sentence with the count in it, before the first
 *    request. Bulk writes with a one-click trigger are how a graph gesture
 *    turns into "why does every object say status: done".
 *  2. **A progress row per object, and per-object failures shown
 *    INDIVIDUALLY.** Object #7's 409 is object #7's row, with its own message
 *    and its own retry button. Partial success is stated as a count of what
 *    landed — the bar has no "success" state, only "12 of 14 written".
 *  3. **Retry reuses the plan.** Retrying re-runs `runBulk` over the SAME rows,
 *    so the successes are skipped and the failures keep the idempotency keys
 *    they were minted with. Re-planning would mint new keys, which is the one
 *    thing protecting a link retry from double-writing.
 *  4. **A viewer sees the selection and none of the writes.** Selection is a
 *    read surface (it highlights, it opens); the mutating controls are not
 *    rendered for a viewer at all, rather than rendered disabled. The box's own
 *    role check refuses them regardless — this is UX, not the boundary.
 *
 * `SelectionBar` is presentational and controlled, exactly like
 * `GraphControls`: every value arrives as a prop, the write surface arrives as
 * an injectable `writer`, and the object search arrives as an injectable
 * `search`. `SelectionSurface` is the thin adapter that wires both it and the
 * marquee to the engine, and is what mounts inside `<GraphView>`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlertTriangle,
  Check,
  Link2,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TypeIcon } from "../bits";
import { api, type Whoami } from "../../lib/api";
import { usePeek } from "../../lib/peek";
import { fmtNumber } from "../../lib/ui";
import { useGraphEngine } from "../../views/GraphView";
import type { SpatialHash } from "../../lib/graph/renderer";
import {
  BULK_MAX,
  bulkSummaryLine,
  canBulkMutate,
  coerceBulkValue,
  confirmLine,
  indicesInScreenRect,
  isRetryable,
  isValidPropKey,
  isValidRel,
  isMarqueeRect,
  marqueeArmed,
  marqueeMode,
  planBulkRows,
  rectFromPoints,
  runBulk,
  summarizeBulk,
  type BulkIntent,
  type BulkRow,
  type BulkTarget,
  type BulkValueKind,
  type BulkWriter,
  type ScreenRect,
  type SelectionMode,
} from "../../lib/graph/selection";

/* ------------------------------------------------------------------ *
 * the link-target picker's search seam
 * ------------------------------------------------------------------ */

interface LinkTargetHit {
  id: string;
  title: string | null;
  type: string | null;
}

export type LinkTargetSearch = (query: string) => Promise<LinkTargetHit[]>;

/** The real lookup: the existing search endpoint, nothing new on the box. */
const defaultLinkTargetSearch: LinkTargetSearch = async (query) => {
  const hits = await api.search(query, { limit: 8 });
  return hits.map((h) => ({ id: h.id, title: h.title, type: h.type }));
};

/* ------------------------------------------------------------------ *
 * the marquee
 * ------------------------------------------------------------------ */

/** Just the bit of the renderer a marquee needs — so tests hand it a fake. */
interface MarqueeProjection {
  screenToWorld(sx: number, sy: number): { x: number; y: number };
  hash(): SpatialHash;
  positions(): Float32Array;
}

interface MarqueeLayerProps {
  /** null while the WebGL renderer is still starting. */
  projection: MarqueeProjection | null;
  onSelect: (indices: number[], mode: SelectionMode) => void;
  /** the engine has no nodes yet, or the surface is otherwise inert. */
  disabled?: boolean;
}

/**
 * The alt-drag marquee, as a layer stacked over the canvas.
 *
 * It takes pointer events ONLY while Alt is held. Any other time it is
 * `pointer-events: none`, so panning, zooming, hover isolation, click-to-peek
 * and shift-click-to-toggle all keep reaching the canvas underneath untouched
 * — a selection layer that ate the camera would be a worse trade than no
 * selection layer.
 */
export function MarqueeLayer({ projection, onSelect, disabled = false }: MarqueeLayerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [armed, setArmed] = useState(false);
  const [rect, setRect] = useState<ScreenRect | null>(null);
  const drag = useRef<{ x: number; y: number; mode: SelectionMode } | null>(null);

  // Arm on the modifier, and disarm on blur as well as keyup: alt-tabbing away
  // never delivers the keyup, and a permanently-armed layer would swallow the
  // camera for the rest of the session.
  useEffect(() => {
    if (disabled) return;
    const sync = (e: KeyboardEvent): void => {
      if (drag.current !== null) return;
      setArmed(marqueeArmed(e));
    };
    const off = (): void => {
      if (drag.current === null) setArmed(false);
    };
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", off);
    };
  }, [disabled]);

  const pointIn = useCallback((e: { clientX: number; clientY: number }) => {
    const box = ref.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const mode = marqueeMode(e);
      if (mode === null || disabled) return;
      // Alt-drag is a window-manager gesture on some desktops; claim it.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = pointIn(e);
      drag.current = { x: p.x, y: p.y, mode };
      setRect({ x: p.x, y: p.y, width: 0, height: 0 });
    },
    [disabled, pointIn],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (start === null) return;
      const p = pointIn(e);
      // Alt+Shift picked up mid-drag still means "add" — the mode is read
      // continuously so the modifier you end on is the one that applies.
      const mode = marqueeMode(e);
      drag.current = { ...start, mode: mode ?? start.mode };
      setRect(rectFromPoints(start.x, start.y, p.x, p.y));
    },
    [pointIn],
  );

  const finish = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      drag.current = null;
      setRect(null);
      setArmed(marqueeArmed(e));
      if (start === null) return;
      const p = pointIn(e);
      const box = rectFromPoints(start.x, start.y, p.x, p.y);
      // A wobbled alt-click is not "select nothing" — leave the selection be.
      if (!isMarqueeRect(box) || projection === null) return;
      const indices = indicesInScreenRect(
        projection.hash(),
        projection.positions(),
        box,
        (sx, sy) => projection.screenToWorld(sx, sy),
      );
      onSelect(indices, start.mode);
    },
    [onSelect, pointIn, projection],
  );

  return (
    <div
      ref={ref}
      data-testid="graph-marquee-layer"
      data-armed={armed ? "true" : "false"}
      className="absolute inset-0 z-20"
      style={{
        pointerEvents: armed || rect !== null ? "auto" : "none",
        cursor: armed ? "crosshair" : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {rect !== null && (
        <div
          data-testid="graph-marquee-rect"
          aria-hidden
          className="absolute border border-dashed border-[var(--ink-strong)] bg-[var(--hover-strong)]"
          style={{
            left: rect.x,
            top: rect.y,
            width: Math.max(rect.width, 1),
            height: Math.max(rect.height, 1),
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * the bar
 * ------------------------------------------------------------------ */

type Stage = "idle" | "link" | "prop" | "confirm" | "running";

export interface SelectionBarProps {
  user: Whoami;
  /** the selected objects, in dense-index order. Empty renders nothing. */
  targets: readonly BulkTarget[];
  onClear: () => void;
  /** push the whole selection onto the side-peek stack. */
  onOpenAll: (ids: string[]) => void;
  /** at least one write landed — the caller reloads the graph. */
  onWrote?: () => void;
  /** test/demo seams. */
  writer?: BulkWriter;
  search?: LinkTargetSearch;
}

const STATE_LABEL: Record<BulkRow["state"], string> = {
  queued: "queued",
  running: "writing…",
  done: "written",
  conflict: "conflict",
  error: "failed",
  skipped: "skipped",
};

export function SelectionBar({
  user,
  targets,
  onClear,
  onOpenAll,
  onWrote,
  writer,
  search = defaultLinkTargetSearch,
}: SelectionBarProps) {
  const mayWrite = canBulkMutate(user);
  const [stage, setStage] = useState<Stage>("idle");
  const [intent, setIntent] = useState<BulkIntent | null>(null);
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  // link composer
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LinkTargetHit[]>([]);
  const [target, setTarget] = useState<LinkTargetHit | null>(null);
  const [rel, setRel] = useState("about");

  // property composer
  const [propKey, setPropKey] = useState("");
  const [valueKind, setValueKind] = useState<BulkValueKind>("text");
  const [rawValue, setRawValue] = useState("");

  const count = targets.length;
  const overCap = count > BULK_MAX;

  // A selection change abandons whatever was being composed — the sentence in
  // the confirm step named a count that is no longer true.
  const key = useMemo(() => targets.map((t) => t.id).join(","), [targets]);
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    setStage("idle");
    setIntent(null);
    setRows(null);
  }, [key]);

  useEffect(() => {
    if (stage !== "link") return;
    const q = query.trim();
    if (q === "") {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void search(q)
        .then((found) => {
          if (live) setHits(found);
        })
        .catch(() => {
          if (live) setHits([]);
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, search, stage]);

  const value = coerceBulkValue(valueKind, rawValue);

  const reset = useCallback(() => {
    setStage("idle");
    setIntent(null);
    setRows(null);
    setQuery("");
    setHits([]);
    setTarget(null);
    setRawValue("");
    setPropKey("");
    setValueKind("text");
  }, []);

  const review = useCallback((next: BulkIntent) => {
    setIntent(next);
    setStage("confirm");
  }, []);

  const run = useCallback(
    async (plan: BulkRow[], which: BulkIntent) => {
      setBusy(true);
      setStage("running");
      setRows(plan);
      const final = await runBulk(which, plan, {
        ...(writer ? { writer } : {}),
        onProgress: (next) => setRows(next.slice()),
      });
      setRows(final);
      setBusy(false);
      if (summarizeBulk(final).done > 0) onWrote?.();
    },
    [onWrote, writer],
  );

  const apply = useCallback(() => {
    if (intent === null) return;
    void run(planBulkRows(targets), intent);
  }, [intent, run, targets]);

  const retryFailed = useCallback(() => {
    if (intent === null || rows === null) return;
    // The SAME rows, so successes are skipped and failures keep their keys.
    void run(rows, intent);
  }, [intent, rows, run]);

  const retryOne = useCallback(
    async (id: string) => {
      if (intent === null || rows === null) return;
      const row = rows.find((r) => r.id === id);
      if (row === undefined) return;
      setBusy(true);
      const [updated] = await runBulk(intent, [row], {
        ...(writer ? { writer } : {}),
      });
      setRows((prev) =>
        prev === null || updated === undefined
          ? prev
          : prev.map((r) => (r.id === id ? updated : r)),
      );
      setBusy(false);
      if (updated?.state === "done") onWrote?.();
    },
    [intent, onWrote, rows, writer],
  );

  if (count === 0) return null;

  const summary = rows === null ? null : summarizeBulk(rows);
  const retryable = rows === null ? [] : rows.filter(isRetryable);

  return (
    <div
      role="region"
      aria-label="Graph selection"
      // TOP, and bounded by the two things it kept landing on. Centred at the
      // BOTTOM it sat straight across the "What changed" panel and the Layout
      // control — a bar that appears the moment you box-select, over the
      // controls you were about to use. Insetting to the gap between the left
      // rail (left-3 + w-64) and the right panel column, rather than centring
      // on the whole canvas, is what makes "cannot overlap" a property of the
      // geometry instead of a wide margin and some hope.
      className="pointer-events-auto absolute top-3 right-[19.5rem] left-[17.5rem] z-30 mx-auto flex w-[min(46rem,100%)] flex-col border border-line-soft bg-panel shadow-md"
    >
      {/* ---- the bar itself ---- */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2">
        <span className="text-[12.5px] font-[650] text-ink">{fmtNumber(count)} selected</span>
        <span className="text-[11.5px] text-dim">
          alt-drag to box-select · alt+shift adds · shift-click one
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onOpenAll(targets.map((t) => t.id))}
            className="gap-1 text-dim hover:text-ink"
          >
            Open all
          </Button>
          {mayWrite && (
            <>
              <Button
                size="xs"
                variant={stage === "link" ? "secondary" : "ghost"}
                disabled={overCap || busy}
                onClick={() => setStage(stage === "link" ? "idle" : "link")}
                className="gap-1 text-dim hover:text-ink"
              >
                <Link2 size={12} aria-hidden /> Link all to…
              </Button>
              <Button
                size="xs"
                variant={stage === "prop" ? "secondary" : "ghost"}
                disabled={overCap || busy}
                onClick={() => setStage(stage === "prop" ? "idle" : "prop")}
                className="gap-1 text-dim hover:text-ink"
              >
                <SlidersHorizontal size={12} aria-hidden /> Set a property
              </Button>
            </>
          )}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              reset();
              onClear();
            }}
            className="gap-1 text-dim hover:text-ink"
          >
            <X size={12} aria-hidden /> Clear
          </Button>
        </div>
      </div>

      {mayWrite && overCap && (
        <p className="border-t border-line-soft px-2.5 py-1.5 text-[11.5px] text-mut">
          {fmtNumber(count)} objects is past the {fmtNumber(BULK_MAX)}-object bulk limit — each
          object is its own transaction, so this many is a job for a filter or an agent, not a
          progress bar. Narrow the selection to edit it.
        </p>
      )}

      {/* ---- link composer ---- */}
      {mayWrite && stage === "link" && (
        <div className="flex flex-col gap-2 border-t border-line-soft px-2.5 py-2">
          <label htmlFor="bulk-link-target" className="text-[11.5px] text-mut">
            Link every selected object to
          </label>
          <Input
            id="bulk-link-target"
            value={target === null ? query : (target.title ?? target.id)}
            onChange={(e) => {
              setTarget(null);
              setQuery(e.target.value);
            }}
            placeholder="Search for the object to link to…"
            className="border-line-soft bg-panel2"
          />
          {target === null && hits.length > 0 && (
            <ul className="flex max-h-40 flex-col overflow-y-auto border border-line-soft">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setTarget(h);
                      setHits([]);
                    }}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                  >
                    <TypeIcon type={h.type} size={12} />
                    <span className="min-w-0 flex-1 truncate text-ink">{h.title ?? h.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="bulk-link-rel" className="text-[11.5px] text-mut">
                with the verb
              </label>
              <Input
                id="bulk-link-rel"
                value={rel}
                onChange={(e) => setRel(e.target.value)}
                className="w-40 border-line-soft bg-panel2 font-mono"
              />
            </div>
            <Button
              size="sm"
              disabled={target === null || !isValidRel(rel)}
              onClick={() => {
                if (target === null) return;
                review({ kind: "link", to: target.id, toTitle: target.title, rel: rel.trim() });
              }}
              className="ml-auto"
            >
              Review {fmtNumber(count)} links
            </Button>
          </div>
        </div>
      )}

      {/* ---- property composer ---- */}
      {mayWrite && stage === "prop" && (
        <div className="flex flex-wrap items-end gap-2 border-t border-line-soft px-2.5 py-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="bulk-prop-key" className="text-[11.5px] text-mut">
              Property
            </label>
            <Input
              id="bulk-prop-key"
              value={propKey}
              onChange={(e) => setPropKey(e.target.value)}
              placeholder="status"
              className="w-44 border-line-soft bg-panel2 font-mono"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="bulk-prop-kind" className="text-[11.5px] text-mut">
              Value is
            </label>
            <select
              id="bulk-prop-kind"
              value={valueKind}
              onChange={(e) => setValueKind(e.target.value as BulkValueKind)}
              className="h-8 rounded-none border border-line-soft bg-panel2 px-1.5 text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)]"
            >
              <option value="text">text</option>
              <option value="number">a number</option>
              <option value="boolean">true / false</option>
              <option value="clear">cleared (delete the key)</option>
            </select>
          </div>
          {valueKind !== "clear" && (
            <div className="flex flex-col gap-1">
              <label htmlFor="bulk-prop-value" className="text-[11.5px] text-mut">
                Value
              </label>
              <Input
                id="bulk-prop-value"
                value={rawValue}
                onChange={(e) => setRawValue(e.target.value)}
                aria-invalid={rawValue !== "" && !value.ok}
                className="w-48 border-line-soft bg-panel2"
              />
            </div>
          )}
          {rawValue !== "" && !value.ok && value.error !== null && (
            <p className="w-full text-[11.5px] text-destructive">{value.error}</p>
          )}
          <Button
            size="sm"
            disabled={!isValidPropKey(propKey) || !value.ok}
            onClick={() => review({ kind: "prop", key: propKey.trim(), value: value.value })}
            className="ml-auto"
          >
            Review {fmtNumber(count)} writes
          </Button>
        </div>
      )}

      {/* ---- confirm ---- */}
      {stage === "confirm" && intent !== null && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft bg-hover px-2.5 py-2">
          <p className="min-w-0 flex-1 text-[12px] text-ink">{confirmLine(intent, count)}</p>
          <Button size="sm" variant="ghost" onClick={() => setStage("idle")} className="text-dim">
            Cancel
          </Button>
          <Button size="sm" onClick={apply}>
            Write {fmtNumber(count)}
          </Button>
        </div>
      )}

      {/* ---- progress ---- */}
      {rows !== null && summary !== null && (
        <div className="flex flex-col border-t border-line-soft">
          <ul className="flex max-h-52 flex-col overflow-y-auto">
            {rows.map((row) => (
              <li
                key={row.id}
                data-testid={`bulk-row-${row.id}`}
                data-state={row.state}
                className="flex items-center gap-2 border-b border-line-soft px-2.5 py-1 last:border-b-0"
              >
                <span aria-hidden className="shrink-0 text-dim">
                  {row.state === "done" ? (
                    <Check size={12} />
                  ) : row.state === "running" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : row.state === "conflict" || row.state === "error" ? (
                    <AlertTriangle size={12} className="text-destructive" />
                  ) : (
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--line)]" />
                  )}
                </span>
                <span className="min-w-0 shrink truncate text-[12px] text-ink">
                  {row.title ?? row.id}
                </span>
                <span className="shrink-0 text-[11px] text-dim">{STATE_LABEL[row.state]}</span>
                {row.message !== null && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-mut">
                    {row.message}
                  </span>
                )}
                {isRetryable(row) && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void retryOne(row.id)}
                    className="ml-auto shrink-0 gap-1 text-dim hover:text-ink"
                  >
                    <RotateCcw size={11} aria-hidden /> Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-2.5 py-1.5">
            <p role="status" aria-live="polite" className="min-w-0 flex-1 text-[11.5px] text-mut">
              {bulkSummaryLine(summary)}
            </p>
            {retryable.length > 0 && !busy && (
              <Button size="xs" variant="secondary" onClick={retryFailed} className="gap-1">
                <RotateCcw size={11} aria-hidden /> Retry {retryable.length} failed
              </Button>
            )}
            {summary.finished && (
              <Button size="xs" variant="ghost" onClick={reset} className="text-dim">
                Done
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * the adapter that mounts inside <GraphView>
 * ------------------------------------------------------------------ */

interface SelectionSurfaceProps {
  user: Whoami;
  writer?: BulkWriter;
  search?: LinkTargetSearch;
}

/**
 * Marquee + bar, wired to the engine. Mounted as a child of `<GraphView>`:
 *
 * ```tsx
 * <GraphView>
 *   <SelectionSurface user={user} />
 * </GraphView>
 * ```
 *
 * It is deliberately thin — every decision it could get wrong lives in
 * `SelectionBar` (controlled) or `lib/graph/selection.ts` (pure), both of which
 * are tested without a WebGL context.
 */
export function SelectionSurface({ user, writer, search }: SelectionSurfaceProps) {
  const engine = useGraphEngine();
  const peek = usePeek();

  const targets = useMemo<BulkTarget[]>(() => {
    const out: BulkTarget[] = [];
    for (const index of [...engine.selection].sort((a, b) => a - b)) {
      const id = engine.idAt(index);
      const node = engine.nodes[index];
      if (id === undefined || node === undefined) continue;
      out.push({ index, id, title: node.title, type: node.type });
    }
    return out;
  }, [engine]);

  const onSelect = useCallback(
    (indices: number[], mode: SelectionMode) => {
      engine.select(indices, mode);
    },
    [engine],
  );

  return (
    <>
      <MarqueeLayer
        projection={engine.renderer}
        onSelect={onSelect}
        disabled={engine.nodes.length === 0}
      />
      <SelectionBar
        user={user}
        targets={targets}
        onClear={engine.clearSelection}
        onOpenAll={(ids) => peek.openPeekAll(ids)}
        onWrote={engine.reload}
        {...(writer ? { writer } : {})}
        {...(search ? { search } : {})}
      />
    </>
  );
}
