/**
 * Board (kanban) layout for a type's database view.
 *
 * It implements `LayoutProps` and nothing else: the shell (views/TypeView) owns
 * the query, the rows, the config and the CAS write path, so this file is only
 * "where does each card sit, and what does moving one mean?".
 *
 * Four rules earn their keep here:
 *
 *  1. **A drag is ONE patch.** Dropping a card in another column sends exactly
 *     one `onPatch(id, version, { props: { [groupBy]: value } })` — never the
 *     whole props bag, never a second write to "fix up" ordering. Dropping a
 *     card back where it started sends nothing at all. Clearing the value
 *     (the Uncategorized column) sends `null`, the delete sentinel, not `""`.
 *  2. **Optimism ends explicitly.** The card jumps to the new column before the
 *     server answers, but CAS is object-scoped: on a busy board (several people
 *     dragging plus an agent writing) a patch can exhaust all three rebases and
 *     simply not land. The terminal state is visible, never silent — the card
 *     SNAPS BACK to the column it came from, keeps a "didn't save" outline for a
 *     beat, the move is announced on a live region, and the conflict banner
 *     offers keep-mine / take-theirs. There is no third state where a card sits
 *     in a column the server never agreed to.
 *     We learn which happened from `rows`, not from a return value: the shell
 *     folds the server's answer (or the re-read after a refusal) into `rows`
 *     before `onPatch` resolves, so the row itself says whether the move stuck.
 *  3. **No DnD dependency.** Pointer events + a fixed drag layer. Dragging is
 *     not the only way to move a card: focus one and press Alt/Shift+←/→. A
 *     board that can only be operated by dragging is a board a keyboard user
 *     cannot use, and the arrow keys also make it usable on a trackpad without
 *     fine motor control.
 *  4. **Motion is a preference.** `prefers-reduced-motion` drops the tilt, the
 *     lift and every transition (the global CSS floor flattens the rest); the
 *     snap-back stays legible because it is colour and copy, not movement.
 *
 * **On a phone it is one column at a time.** A 280px column beside a 390px
 * viewport is a board you read through a letterbox, so below `MOBILE_QUERY`
 * each column is the full width of the scroller and the scroller snaps: a
 * horizontal swipe moves between columns (native scroll — no gesture handler to
 * fight the browser), a pager says which column you are on and how many there
 * are, and prev/next buttons do it without a swipe.
 *
 * The fifth rule, which the phone forces: **a drag is never the only way to
 * move a card, and on touch it is not a way at all.** Touch-drag on iOS is a
 * coin flip between a drag, a scroll and a long-press context menu, so on a
 * coarse pointer the card does not start a drag — it grows a "Move to…" menu
 * that goes through the SAME `moveCard`, so the write path, the optimism, the
 * snap-back and the conflict banner are all identical whichever way the card
 * moved. (A mouse on a narrow window still drags: the input decides, not the
 * width.) The card also stops declaring `touch-none` there — that property was
 * what made the column impossible to scroll with a finger.
 *
 * Column order follows the property's declared enum order — the schema's order
 * is the pipeline's order ("new, in progress, done"), and re-sorting it
 * alphabetically would scramble every board. Values found on rows but missing
 * from the enum (a stale value, a value an agent wrote before the enum was
 * narrowed) are appended rather than hidden: a card must never be invisible
 * because its value is unfashionable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, GripVertical, MoveRight } from "lucide-react";

import type { ListItem, PropDef } from "../../lib/api";
import { CellValue, rowVersion, type LayoutProps } from "../../views/TypeView";
import { enumTint, fmtRelative } from "../../lib/ui";
import { useTheme } from "../../lib/theme";
import { useCoarsePointer, useIsMobile } from "../../lib/mobile";
import { Empty, PrivateBadge } from "../bits";
import { ConflictBanner, type BannerSnapshot } from "../ConflictBanner";
import { Card } from "../ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Column keys live in their own namespace: a value column is keyed `v:<value>`
 * and the unset column is keyed `unset`. Keying by the raw value would work
 * right up until some property legitimately holds the string we picked as the
 * "no value" sentinel — and then two columns would share one key.
 */
export const UNCATEGORIZED = "unset";

/** The column key a group value belongs to. */
export function columnKeyFor(value: string | null): string {
  return value === null ? UNCATEGORIZED : `v:${value}`;
}

/** How far the pointer must travel before a press becomes a drag. Below this a
 *  press is a click that opens the object, so a shaky hand still opens cards. */
const DRAG_THRESHOLD = 5;

/** How long a refused move keeps its "didn't save" outline. */
const SNAPBACK_MS = 2400;

/** Edge band (px) inside the horizontal scroller that pans while dragging. */
const EDGE_BAND = 64;
const EDGE_STEP = 24;

const REF_KINDS: readonly string[] = ["ref", "ref[]"];

interface BoardColumn {
  /** stable react key + drop-zone id */
  key: string;
  /** the value a card gets when dropped here; `null` clears the property */
  value: string | null;
  label: string;
}

interface PendingMove {
  /** where the card is drawn while the write is in flight */
  target: string | null;
  /** the column's label, for the announcement */
  targetLabel: string;
  title: string | null;
  /** the write has settled; the next render's `rows` is the verdict */
  settled: boolean;
}

interface ConflictState {
  id: string;
  title: string | null;
  /** what we tried to set */
  mine: string | null;
  /** what the server holds now — read back off the row, not assumed */
  theirs: string | null;
  when: string | null;
}

interface Zone {
  key: string;
  rect: { left: number; right: number; top: number; bottom: number };
}

/* --------------------------------------------------------------- pure pieces */

/**
 * The grouping value of one row, normalized to a string or `null`.
 *
 * Unset, empty string and a non-scalar (an array, an object — a shape this
 * property should not hold, but a brain is not a schema police force) all read
 * as `null` and land in Uncategorized, because the alternative is a card that
 * belongs to no column and is therefore invisible.
 */
export function groupValue(row: ListItem, groupBy: string | null): string | null {
  if (!groupBy) return null;
  const v = row.props?.[groupBy];
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function labelFor(value: string | null): string {
  return value ?? "Uncategorized";
}

/**
 * The columns, in order: the property's declared enum values first (schema
 * order — see the file header), then any other value actually present on a row,
 * then Uncategorized.
 *
 * With no enum to go by (a saved config grouping on a text property, or a
 * property that has since left the catalog) the present values are sorted so
 * the board is at least stable between renders.
 *
 * `includeEmptyUncategorized` is false for a viewer: an empty column is a drop
 * target, and a viewer has nothing to drop.
 */
export function boardColumns(
  rows: ListItem[],
  prop: PropDef | null,
  groupBy: string | null,
  includeEmptyUncategorized = true,
): BoardColumn[] {
  const declared = (prop?.enum_values ?? []).filter((v) => typeof v === "string" && v !== "");
  const seen = new Set<string>(declared);
  const extra: string[] = [];
  let unset = 0;
  for (const row of rows) {
    const v = groupValue(row, groupBy);
    if (v === null) {
      unset += 1;
      continue;
    }
    if (seen.has(v)) continue;
    seen.add(v);
    extra.push(v);
  }
  if (declared.length === 0) extra.sort((a, b) => a.localeCompare(b));
  const values: Array<string | null> = [...declared, ...extra];
  if (unset > 0 || includeEmptyUncategorized) values.push(null);
  return values.map((value) => ({
    key: columnKeyFor(value),
    value,
    label: labelFor(value),
  }));
}

/** Which drop zone is under the pointer. Zones do not overlap, so the first hit
 *  wins; outside every zone is `null` (a drop there is a cancel, not a guess). */
export function columnAtPoint(zones: Zone[], x: number, y: number): string | null {
  for (const z of zones) {
    if (x >= z.rect.left && x <= z.rect.right && y >= z.rect.top && y <= z.rect.bottom) {
      return z.key;
    }
  }
  return null;
}

/** Card props worth showing under the title: the config's visible columns,
 *  minus refs (links are not cells) and minus the group property itself (the
 *  column already says it). Mirrors the table's column resolution — a saved
 *  config can name a property the catalog no longer has. */
function cardProps(config: LayoutProps["config"], propDefs: PropDef[], groupBy: string): PropDef[] {
  const byName = new Map(propDefs.map((p) => [p.name, p] as const));
  const chosen = config.columns
    .filter((c) => c.visible)
    .map((c) => byName.get(c.key))
    .filter((p): p is PropDef => p !== undefined && !REF_KINDS.includes(p.kind));
  const cols = chosen.length > 0 ? chosen : propDefs.filter((p) => !REF_KINDS.includes(p.kind));
  return cols.filter((p) => p.name !== groupBy).slice(0, 4);
}

/** OS-level motion preference, watched live (a member can change it mid-session
 *  and the drag layer must stop tilting without a reload). Guarded: a runtime
 *  without matchMedia is treated as "motion is fine", never as a crash. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    return;
  }, []);
  return reduced;
}

/* ------------------------------------------------------------------ the board */

interface DragState {
  id: string;
  pointerId: number;
  /** pointer offset inside the card, so the card does not jump on grab */
  dx: number;
  dy: number;
  width: number;
  /** where the press started — the threshold is measured from HERE, not from
   *  the last move, or a slow drag never crosses it */
  originX: number;
  originY: number;
  x: number;
  y: number;
  over: string | null;
  /** past the threshold — before that it is still a click */
  active: boolean;
}

export default function BoardLayout({
  rows,
  propDefs,
  config,
  onPatch,
  onOpen,
  readOnly,
}: LayoutProps) {
  const { theme } = useTheme();
  const reducedMotion = usePrefersReducedMotion();
  const isMobile = useIsMobile();
  // Touch is what makes a drag unreliable, not width: a mouse on a narrow
  // window keeps the drag, a finger on a wide tablet does not get one.
  const coarse = useCoarsePointer();
  const canDrag = !readOnly && !coarse;
  const groupBy = config.groupBy;
  const prop = useMemo(() => propDefs.find((p) => p.name === groupBy) ?? null, [propDefs, groupBy]);

  const [pending, setPending] = useState<Map<string, PendingMove>>(() => new Map());
  const [snappedBack, setSnappedBack] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  // The drag lives in a ref AND in state: the ref is what the window listeners
  // read (they must not be re-attached on every pointermove), the state is what
  // the drag layer renders.
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDragState] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [refocus, setRefocus] = useState<string | null>(null);

  const zonesRef = useRef<Map<string, HTMLElement>>(new Map());
  const cardsRef = useRef<Map<string, HTMLElement>>(new Map());
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const suppressClick = useRef(false);
  // The floating drag copy, moved IMPERATIVELY on every pointermove — it is the
  // only node whose position changes per move, so a React state write (and the
  // ~200-card re-render it triggers) has no business firing at 60-120 Hz for it.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Zone rects cached for the duration of a drag: `getBoundingClientRect` per
  // column is a forced synchronous layout, and the rects change only when the
  // scroller pans (which invalidates this), never on a bare pointermove.
  const zoneCacheRef = useRef<Zone[] | null>(null);
  // Stable per-card ref callbacks: an inline `ref={(el)=>…}` is a fresh closure
  // each render, so React detaches + re-attaches all ~200 card refs on every
  // re-render. Memoized by id, the identity holds and React leaves them alone.
  const cardRefCbs = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
  const cardRef = useCallback((rowId: string) => {
    const cache = cardRefCbs.current;
    let cb = cache.get(rowId);
    if (!cb) {
      cb = (el: HTMLDivElement | null) => {
        if (el) cardsRef.current.set(rowId, el);
        else cardsRef.current.delete(rowId);
      };
      cache.set(rowId, cb);
    }
    return cb;
  }, []);

  const columns = useMemo(
    () => boardColumns(rows, prop, groupBy, !readOnly),
    [rows, prop, groupBy, readOnly],
  );

  /* --------------------------------------------------- the right-edge fade cue
     A scroll cue must track ACTUAL overflow, not a column count: a 5-column
     board that fits on a wide monitor has nothing to reveal, and once scrolled
     to the far end there is nothing further either. Either case must hide the
     fade — otherwise it dims the last column's real content and falsely signals
     "more →". So measure the scroller and show it only when content genuinely
     extends past the right edge. */
  const [showRightFade, setShowRightFade] = useState(false);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || isMobile) {
      setShowRightFade(false);
      return;
    }
    const measure = (): void => {
      setShowRightFade(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [isMobile, columns.length]);

  /* ------------------------------------------------------- the phone's pager
     Which column fills the screen. It is DERIVED from the scroller rather than
     driving it: the swipe is a native scroll (nothing to intercept, nothing to
     fight), and this only reports where that scroll landed. */
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!isMobile) return;
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      setPage(Math.max(0, Math.round(el.scrollLeft / w)));
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isMobile]);

  // Columns come and go (a live refresh empties the last one, a viewer loses
  // the Uncategorized drop target); the pager must never point past the end.
  const pageIndex = Math.min(page, Math.max(0, columns.length - 1));
  const pageColumn = columns[pageIndex] ?? null;

  const goToColumn = useCallback(
    (index: number) => {
      const el = scrollerRef.current;
      if (!el) return;
      const next = Math.max(0, Math.min(columns.length - 1, index));
      el.scrollTo({
        left: next * el.clientWidth,
        behavior: reducedMotion ? "auto" : "smooth",
      });
      // Optimistic: `scrollTo` is asynchronous and a smooth scroll reports its
      // final position several frames later, so the pager would lag a tap.
      setPage(next);
    },
    [columns.length, reducedMotion],
  );

  /** Where each card is DRAWN: the optimistic target while a write is in
   *  flight, the server's value otherwise. */
  const drawnValue = useCallback(
    (row: ListItem): string | null => {
      const p = pending.get(row.id);
      return p ? p.target : groupValue(row, groupBy);
    },
    [pending, groupBy],
  );

  const grouped = useMemo(() => {
    const byKey = new Map<string, ListItem[]>();
    for (const c of columns) byKey.set(c.key, []);
    for (const row of rows) {
      const key = columnKeyFor(drawnValue(row));
      const bucket = byKey.get(key) ?? byKey.get(UNCATEGORIZED);
      if (bucket) bucket.push(row);
    }
    return byKey;
  }, [columns, rows, drawnValue]);

  // The verdict on a settled move. `rows` is the truth: the shell has already
  // folded in the server's answer (or the post-refusal re-read) by the time the
  // patch resolves, so a card that is not where we put it did not move.
  useEffect(() => {
    let settledIds: string[] | null = null;
    for (const [id, p] of pending) {
      if (!p.settled) continue;
      (settledIds ??= []).push(id);
      const row = rows.find((r) => r.id === id);
      // Gone (deleted, retyped, or no longer ours to read): the shell says so
      // in the notice strip and the card is already off the board.
      if (!row) continue;
      const actual = groupValue(row, groupBy);
      if (actual === p.target) continue;
      setSnappedBack(id);
      setConflict({
        id,
        title: p.title,
        mine: p.target,
        theirs: actual,
        when: row.updated_at,
      });
      setAnnouncement(
        `${p.title ?? "untitled"} did not move to ${p.targetLabel} — it is back in ${labelFor(actual)}.`,
      );
    }
    if (!settledIds) return;
    setPending((prev) => {
      const next = new Map(prev);
      for (const id of settledIds) next.delete(id);
      return next;
    });
  }, [pending, rows, groupBy]);

  useEffect(() => {
    if (snappedBack === null) return;
    const t = setTimeout(() => setSnappedBack(null), SNAPBACK_MS);
    return () => clearTimeout(t);
  }, [snappedBack]);

  // A keyboard move re-parents the card, so React unmounts it from the old
  // column and mounts it in the new one — focus would land on <body> and the
  // next arrow key would go nowhere. Put it back on the card that moved.
  useEffect(() => {
    if (refocus === null) return;
    cardsRef.current.get(refocus)?.focus();
    setRefocus(null);
  }, [refocus, grouped]);

  /**
   * Move one card to one column. The single write path — the drag and the
   * keyboard alternative both come through here, so there is one place where a
   * patch can be emitted and one place that decides it is a no-op.
   */
  const moveCard = useCallback(
    (id: string, column: BoardColumn) => {
      if (readOnly || !groupBy) return;
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      // One in-flight move per card: a second patch would race the first for
      // the same version and lose the CAS by construction.
      if (pending.has(id)) return;
      const from = groupValue(row, groupBy);
      if (from === column.value) return; // dropped where it already was: no write
      setConflict(null);
      setSnappedBack(null);
      setPending((prev) => {
        const next = new Map(prev);
        next.set(id, {
          target: column.value,
          targetLabel: column.label,
          title: row.title,
          settled: false,
        });
        return next;
      });
      setAnnouncement(`Moved ${row.title ?? "untitled"} to ${column.label}.`);
      // Exactly one patch: one property, the row's own version as the CAS base.
      // `null` DELETES the key (the server's clear sentinel) — never `""`.
      void onPatch(id, rowVersion(row), { props: { [groupBy]: column.value } }).then(() => {
        setPending((prev) => {
          const cur = prev.get(id);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(id, { ...cur, settled: true });
          return next;
        });
      });
    },
    [readOnly, groupBy, rows, pending, onPatch],
  );

  /* ------------------------------------------------------------ pointer drag */

  const measureZones = useCallback((): Zone[] => {
    const zones: Zone[] = [];
    for (const [key, el] of zonesRef.current) {
      const r = el.getBoundingClientRect();
      zones.push({ key, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
    }
    return zones;
  }, []);

  /** Zone rects, measured once per drag and re-used until a pan invalidates the
   *  cache — so the hot pointermove path never forces a layout. */
  const zonesForDrag = useCallback((): Zone[] => {
    if (zoneCacheRef.current === null) zoneCacheRef.current = measureZones();
    return zoneCacheRef.current;
  }, [measureZones]);

  const setDrag = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDragState(next);
  }, []);

  /** A drag that ended must not also open the object: the browser fires `click`
   *  right after `pointerup`, and there is no way to cancel it after the fact. */
  const swallowNextClick = useCallback(() => {
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, row: ListItem) => {
    if (readOnly || !groupBy) return;
    // A finger press is a scroll or a tap, never a drag — the "Move to" menu is
    // how a card moves here, and starting a drag would eat the column's scroll.
    if (canDrag === false || e.pointerType === "touch" || e.pointerType === "pen") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // The move menu lives inside the card; pressing it must open a menu, not
    // pick the card up.
    if (e.target instanceof Element && e.target.closest("[data-no-drag]")) return;
    if (pending.has(row.id)) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    // Capture is belt-and-braces (the listeners below are on window, so the
    // drag survives without it) but it keeps the browser from treating the
    // gesture as a text selection or a scroll.
    if (typeof el.setPointerCapture === "function") {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable; the window listeners still see every move */
      }
    }
    zoneCacheRef.current = null; // a fresh drag re-measures the columns once
    setDrag({
      id: row.id,
      pointerId: e.pointerId,
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      width: r.width || 260,
      originX: e.clientX,
      originY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      over: null,
      active: false,
    });
  };

  const finishDrag = useCallback(
    (x: number, y: number, commit: boolean) => {
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      if (!d.active) return; // a press that never became a drag: the click opens it
      swallowNextClick();
      if (!commit) return;
      const key = d.over ?? columnAtPoint(measureZones(), x, y);
      const column = columns.find((c) => c.key === key);
      // Released over no column at all: a cancel, never a guess at the nearest.
      if (column) moveCard(d.id, column);
    },
    [columns, measureZones, moveCard, setDrag, swallowNextClick],
  );

  // Move/up/cancel are watched on WINDOW, not on the card: the pointer spends
  // the whole drag over other elements, and a card that only listened to itself
  // would leave a drag stuck the first time capture is unavailable.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      const moved = Math.abs(ev.clientX - d.originX) + Math.abs(ev.clientY - d.originY);
      if (!d.active && moved <= DRAG_THRESHOLD) return;

      // Pan the board when the pointer rides its edge, so a column off-screen is
      // still reachable without letting go. A pan shifts every column in the
      // viewport, so the cached zone rects are stale after it — invalidate them.
      const scroller = scrollerRef.current;
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (ev.clientX < r.left + EDGE_BAND) {
          scroller.scrollLeft -= EDGE_STEP;
          zoneCacheRef.current = null;
        } else if (ev.clientX > r.right - EDGE_BAND) {
          scroller.scrollLeft += EDGE_STEP;
          zoneCacheRef.current = null;
        }
      }

      const wasActive = d.active;
      const prevOver = d.over;
      const over = columnAtPoint(zonesForDrag(), ev.clientX, ev.clientY);
      const next: DragState = { ...d, x: ev.clientX, y: ev.clientY, over, active: true };
      dragRef.current = next;

      // Move the floating copy imperatively — one composited node, a style write,
      // no React render. The ~200 static cards do not depend on x/y, so a state
      // write here would reconcile the whole board 60-120 times a second.
      const overlay = overlayRef.current;
      if (overlay) {
        overlay.style.transform = `translate3d(${ev.clientX - d.dx}px, ${ev.clientY - d.dy}px, 0)${
          reducedMotion ? "" : " rotate(1.5deg) scale(1.02)"
        }`;
      }

      // Re-render ONLY when the tree actually changes: the first activation
      // (which mounts the overlay and dims the picked-up card) or the hovered
      // column crossing a boundary (which moves the isOver highlight).
      if (!wasActive || over !== prevOver) setDragState(next);
    };
    const onUp = (ev: PointerEvent) => {
      if (dragRef.current?.pointerId !== ev.pointerId) return;
      finishDrag(ev.clientX, ev.clientY, true);
    };
    const onCancel = (ev: PointerEvent) => {
      if (dragRef.current?.pointerId !== ev.pointerId) return;
      finishDrag(ev.clientX, ev.clientY, false);
    };
    // Escape abandons the drag — the only escape hatch once the pointer is
    // captured, and the one every drag surface in the app offers.
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const d = dragRef.current;
      setDrag(null);
      if (d?.active) swallowNextClick();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragging, finishDrag, zonesForDrag, setDrag, swallowNextClick, reducedMotion]);

  /* --------------------------------------------------------------- keyboard */

  const onCardKeyDown = (
    e: ReactKeyboardEvent<HTMLDivElement>,
    row: ListItem,
    colIndex: number,
  ) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(row.id);
      return;
    }
    const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
    const modified = e.altKey || e.shiftKey;
    if (horizontal && modified) {
      if (readOnly || !groupBy) return;
      e.preventDefault();
      const delta = e.key === "ArrowLeft" ? -1 : 1;
      const target = columns[colIndex + delta];
      if (!target) return;
      moveCard(row.id, target);
      setRefocus(row.id);
      return;
    }
    // Unmodified arrows navigate; they never write.
    const column = columns[colIndex];
    if (!column) return;
    const inColumn = grouped.get(column.key) ?? [];
    const at = inColumn.findIndex((r) => r.id === row.id);
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = inColumn[at + (e.key === "ArrowUp" ? -1 : 1)];
      if (next) cardsRef.current.get(next.id)?.focus();
      return;
    }
    if (horizontal) {
      e.preventDefault();
      const step = e.key === "ArrowLeft" ? -1 : 1;
      for (let i = colIndex + step; i >= 0 && i < columns.length; i += step) {
        const c = columns[i];
        if (!c) continue;
        const cards = grouped.get(c.key) ?? [];
        const landing = cards[Math.min(at, cards.length - 1)];
        if (landing) {
          cardsRef.current.get(landing.id)?.focus();
          return;
        }
      }
    }
  };

  /* ----------------------------------------------------------------- render */

  if (!groupBy || (!prop && columns.length <= 1)) {
    return (
      <div className="p-8">
        <Empty>
          This board has nothing to group by — pick a property in the toolbar, or use the table.
        </Empty>
      </div>
    );
  }

  const dragRow = drag?.active ? (rows.find((r) => r.id === drag.id) ?? null) : null;
  const cols = cardProps(config, propDefs, groupBy);
  const conflictRow = conflict ? (rows.find((r) => r.id === conflict.id) ?? null) : null;

  const snapshot = (value: string | null, title: string | null): BannerSnapshot => ({
    title,
    body: null,
    props: { [groupBy]: value },
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Politeness, not an alert: a move that landed is a normal event, and a
          move that did not is already shouting in colour and in the banner. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      {/* The pager: which column of how many, and two ways to change it that
          are not a swipe. Only on a phone — on a desktop every column is
          already on screen, and a pager would be furniture for nothing. */}
      {isMobile && columns.length > 1 && (
        <nav
          aria-label="Board columns"
          className="flex items-center gap-2 border-b border-line-soft px-3 py-2"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            className="touch-target shrink-0 text-dim"
            aria-label="Previous column"
            disabled={pageIndex === 0}
            onClick={() => goToColumn(pageIndex - 1)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <div className="min-w-0 flex-1 text-center">
            <span className="block truncate text-[13px] font-[600]">{pageColumn?.label ?? ""}</span>
            {/* The pager already names the on-screen column and its position; it
                also carries the card count, so the column's own section header
                is hidden on a phone (only one column is visible at a time) —
                naming the same column twice, stacked, was pure redundant chrome. */}
            <span className="font-mono text-[10.5px] text-dim">
              {pageIndex + 1} / {columns.length}
              {pageColumn
                ? ` · ${grouped.get(pageColumn.key)?.length ?? 0} card${
                    (grouped.get(pageColumn.key)?.length ?? 0) === 1 ? "" : "s"
                  }`
                : ""}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="touch-target shrink-0 text-dim"
            aria-label="Next column"
            disabled={pageIndex >= columns.length - 1}
            onClick={() => goToColumn(pageIndex + 1)}
          >
            <ChevronRight aria-hidden />
          </Button>
        </nav>
      )}

      {conflict && (
        <div className={`pt-5 ${isMobile ? "px-4" : "px-8"}`}>
          <ConflictBanner
            variant="conflict"
            when={conflict.when ?? null}
            fields={[`props.${groupBy}`]}
            theirs={snapshot(conflict.theirs, conflict.title)}
            mine={snapshot(conflict.mine, conflict.title)}
            onKeepMine={() => {
              const column = columns.find((c) => c.value === conflict.mine);
              setConflict(null);
              // Retry against the row's CURRENT version — the whole point of a
              // keep-mine is that we saw theirs and still want ours.
              if (column && conflictRow) moveCard(conflict.id, column);
            }}
            onTakeTheirs={() => setConflict(null)}
          />
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollerRef}
          data-testid="board-scroller"
          className={`flex min-h-0 flex-1 overflow-x-auto py-5 ${
            isMobile
              ? // No gap and no side padding: a snap page must be exactly the
                // scroller's width or every swipe drifts a few pixels off.
                "momentum-x snap-x snap-mandatory gap-0 px-0"
              : "gap-3 px-8"
          }`}
        >
          {columns.map((column, colIndex) => {
            const cards = grouped.get(column.key) ?? [];
            const tint = column.value ? enumTint(column.value, theme) : "var(--dim)";
            const isOver = drag?.active === true && drag.over === column.key;
            return (
              <section
                key={column.key}
                aria-label={`${column.label}, ${cards.length} card${cards.length === 1 ? "" : "s"}`}
                className={`flex shrink-0 flex-col ${
                  isMobile ? "w-full snap-start snap-always px-4" : "w-[248px]"
                }`}
              >
                {!isMobile && (
                  <div className="mb-2.5 flex items-center gap-2 px-1">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: tint }}
                    />
                    <span className="text-[12.5px] font-[600]" style={{ color: tint }}>
                      {column.label}
                    </span>
                    <span className="font-mono text-[11px] text-dim">{cards.length}</span>
                  </div>
                )}
                <div
                  data-column-key={column.key}
                  ref={(el) => {
                    if (el) zonesRef.current.set(column.key, el);
                    else zonesRef.current.delete(column.key);
                  }}
                  className={`flex min-h-[80px] flex-1 flex-col gap-2 rounded-none p-2 transition-colors ${
                    isOver ? "bg-accent-soft ring-1 ring-[var(--line)] ring-inset" : "bg-hover"
                  }`}
                >
                  {cards.map((row) => {
                    const inFlight = pending.has(row.id);
                    const failed = snappedBack === row.id;
                    const isDragged = drag?.active === true && drag.id === row.id;
                    return (
                      <Card
                        key={row.id}
                        ref={cardRef(row.id)}
                        role="button"
                        tabIndex={0}
                        aria-grabbed={isDragged || undefined}
                        data-card-id={row.id}
                        title={
                          readOnly
                            ? undefined
                            : canDrag
                              ? "Drag to another column, or press Alt/Shift + ← →"
                              : "Use Move to… to send this card to another column"
                        }
                        onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) =>
                          onPointerDown(e, row)
                        }
                        onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) =>
                          onCardKeyDown(e, row, colIndex)
                        }
                        onClick={() => {
                          if (suppressClick.current) return;
                          onOpen(row.id);
                        }}
                        className={`card gap-0 rounded-none border-0 px-3 py-2.5 select-none ${
                          // `touch-none` is what makes a pointer-drag reliable —
                          // and what makes a column impossible to scroll with a
                          // finger. It belongs only where a drag can happen.
                          canDrag
                            ? "cursor-grab touch-none active:cursor-grabbing"
                            : "cursor-pointer"
                        } ${isDragged ? "opacity-40" : ""} ${inFlight ? "opacity-70" : ""} ${
                          failed ? "ring-1 ring-warn/70 ring-inset" : ""
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {canDrag && (
                            <GripVertical
                              size={13}
                              aria-hidden
                              className="mt-[3px] shrink-0 text-dim"
                            />
                          )}
                          <span className="min-w-0 flex-1 text-[13px] leading-snug font-[550]">
                            {row.title ?? "untitled"}
                          </span>
                          <PrivateBadge visibility={row.visibility} />
                          {/* The non-drag way to move a card. Same `moveCard`, so
                            a move made here is indistinguishable from a dragged
                            one — one CAS patch, same optimism, same snap-back. */}
                          {!readOnly && !canDrag && (
                            <MoveToMenu
                              row={row}
                              columns={columns}
                              current={column}
                              disabled={inFlight}
                              onMove={(target) => {
                                moveCard(row.id, target);
                                setRefocus(row.id);
                              }}
                            />
                          )}
                        </div>
                        {cols.length > 0 && (
                          <dl className="mt-2 flex flex-col gap-1">
                            {cols
                              .filter((c) => {
                                const v = row.props?.[c.name];
                                return v !== null && v !== undefined && v !== "";
                              })
                              .map((c) => (
                                <div
                                  key={c.name}
                                  className="flex items-baseline gap-2 text-[11.5px]"
                                >
                                  <dt className="w-[86px] shrink-0 truncate font-mono text-[10.5px] text-dim">
                                    {c.name.replace(/_/g, " ")}
                                  </dt>
                                  <dd className="min-w-0 truncate text-mut">
                                    <CellValue kind={c.kind} value={row.props?.[c.name]} />
                                  </dd>
                                </div>
                              ))}
                          </dl>
                        )}
                        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-dim">
                          <span>{fmtRelative(row.updated_at)}</span>
                          {inFlight && <span className="text-mut">saving…</span>}
                          {failed && <span className="text-warn">didn’t save — snapped back</span>}
                        </div>
                      </Card>
                    );
                  })}
                  {cards.length === 0 && (
                    <div className="px-2 py-3 text-center text-[11.5px] text-dim italic">
                      {readOnly ? "empty" : canDrag ? "drop here" : "empty — move a card here"}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
        {/* A pipeline usually has more stages than fit at once; this fade over
            the right edge is the cue that the board continues that way, so a
            populated column scrolled off is "more →", not invisible. Gated on
            MEASURED overflow (see showRightFade), never a raw column count, so
            it never dims content that is fully visible or fully scrolled-to. */}
        {!isMobile && showRightFade && <div aria-hidden className="board-scroll-fade" />}
      </div>

      {/* Drag layer: a copy of the card under the pointer. Fixed, unhittable,
          and cheap — the real card stays in place at low opacity so the board
          never reflows mid-drag. */}
      {drag?.active && dragRow && (
        <div
          ref={overlayRef}
          aria-hidden
          className="pointer-events-none fixed top-0 left-0 z-50"
          style={{
            width: drag.width,
            transform: `translate3d(${drag.x - drag.dx}px, ${drag.y - drag.dy}px, 0)${
              reducedMotion ? "" : " rotate(1.5deg) scale(1.02)"
            }`,
          }}
        >
          <Card
            className={`card gap-0 rounded-none border-0 px-3 py-2.5 ${
              reducedMotion ? "" : "shadow-lg"
            }`}
          >
            <span className="text-[13px] leading-snug font-[550]">
              {dragRow.title ?? "untitled"}
            </span>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- move menu */

/**
 * "Move to…" — the board's non-drag move, and the only way a card moves on a
 * touch screen.
 *
 * It is a menu of the board's own columns, minus the one the card is already
 * in (moving a card where it already is writes nothing, so offering it is
 * offering a no-op). Choosing one calls the SAME `moveCard` the drag and the
 * keyboard call: one CAS patch of one property, the same optimistic paint and
 * the same visible snap-back if the write loses.
 *
 * `data-no-drag` is what keeps pressing it from picking the card up on a mouse
 * — the card's pointerdown handler looks for that ancestor and bows out.
 */
function MoveToMenu({
  row,
  columns,
  current,
  disabled,
  onMove,
}: {
  row: ListItem;
  columns: BoardColumn[];
  current: BoardColumn;
  disabled: boolean;
  onMove: (column: BoardColumn) => void;
}) {
  const targets = columns.filter((c) => c.key !== current.key);
  if (targets.length === 0) return null;
  const title = row.title ?? "untitled";

  return (
    <span data-no-drag onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="touch-target -mt-1 -mr-1 shrink-0 text-dim"
              aria-label={`Move ${title} to another column`}
              disabled={disabled}
            >
              <MoveRight aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-48">
          {/* Base UI throws if a label is not inside a Group — and it takes the
              whole menu with it. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            {targets.map((c) => (
              <DropdownMenuItem key={c.key} onClick={() => onMove(c)}>
                {c.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
