import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Inbox } from "lucide-react";

import { rowVersion, type LayoutProps } from "../../views/TypeView";
import type { ListItem, PropDef } from "../../lib/api";
import { useIsMobile } from "../../lib/mobile";
import { PrivateBadge } from "../bits";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The calendar layout: the type's rows placed on a month (or week) grid by
 * `config.dateProp`, draggable from one day to another.
 *
 * Three things make this file longer than "render a grid":
 *
 *  1. **Timezone honesty.** A date property is a *stored representation*, not an
 *     instant, and the number-one calendar bug is a date-only value that drifts
 *     a day because someone ran it through `new Date()` (which parses
 *     `2026-07-21` as UTC midnight — July 20th in every negative-offset
 *     timezone). So `2026-07-21` is placed on July 21 **by string**, never by
 *     conversion, and rescheduling it writes `2026-07-23` — same shape, same
 *     precision, no invented time-of-day. A value that genuinely IS an instant
 *     (`…T09:00:00Z`, `…+05:30`) is placed on the viewer's local day, and moving
 *     it shifts its date component by whole days so its time-of-day and its
 *     offset survive the move byte for byte. See `parseStoredDate`/`withDay`.
 *  2. **The optimistic override is explicitly reverted.** A drag paints the chip
 *     in its new cell immediately, but that override lives only until `onPatch`
 *     settles — win or lose, it is dropped in a `finally` and the next render is
 *     `rows` again (the shell's rule 2: a layout keeps no private copy that can
 *     outlive a rejected write). A terminal conflict therefore snaps the chip
 *     back to where the server says it is, and we say so out loud rather than
 *     leaving a lie on screen.
 *  3. **Dragging is not the only way.** Every chip is a real button: `m` picks
 *     it up, arrows choose a day (±1, ±7), Enter drops it, Escape cancels, `u`
 *     unschedules. Reschedule-by-mouse-only would put this whole layout out of
 *     reach of keyboard and screen-reader members.
 *  4. **A phone gets an agenda, not a grid.** Seven columns across 390px is
 *     ~50px per day — a month grid there is 42 unreadable boxes. Below
 *     `MOBILE_QUERY` the same buckets render as a vertical agenda: one heading
 *     per day that actually has something on it, its objects stacked full
 *     width beneath, in date order, with the unscheduled tray unchanged. The
 *     range controls (‹ › · Today · month/week) are the same controls doing the
 *     same thing, so "next month" means next month in both forms.
 *     Chips there are not `draggable`: HTML5 drag on iOS is a long-press
 *     lottery. Rescheduling on a phone goes through the object itself — tapping
 *     a chip opens the peek, which on a phone is a full-screen sheet with the
 *     property editor in it — and the layout says so instead of leaving a dead
 *     drag affordance on screen.
 *
 * Writes go through the shell's `onPatch` — ONE patch per move, of ONE property
 * — and the affordances disappear entirely for a viewer (`readOnly`) or when
 * the chosen date is a spine column the server owns (`updated_at`).
 */

/* --------------------------------------------------------------- date model */

const DAY_MS = 86_400_000;
/** `YYYY-MM-DD`, and the only shape we ever hand back to the server for a
 *  date-only property. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A stored value carrying a time, with an optional zone designator. Space as
 *  the separator is Postgres' own text output (`2026-07-21 09:00:00+00`). */
const WITH_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/i;

/**
 * How a date value is WRITTEN DOWN, which is what we must preserve:
 *
 * - `date`  — `2026-07-21`. A calendar day, with no instant behind it. Placed
 *             and rewritten literally.
 * - `naive` — `2026-07-21T09:00`. A wall-clock time with no zone; whoever wrote
 *             it meant a local time, so we keep the day literal too.
 * - `zoned` — `2026-07-21T09:00:00Z` / `+05:30`. A real instant: it lands on the
 *             viewer's local day, and a move shifts its date component.
 */
type StoredDate =
  | { form: "date"; day: string }
  | { form: "naive"; day: string; time: string }
  | { form: "zoned"; day: string; time: string; zone: string };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function dayKeyFromUtc(d: Date): string {
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** The calendar day a real instant falls on FOR THIS VIEWER. Only ever called
 *  for values that are genuinely instants. */
function localDayKey(d: Date): string {
  return `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayKey(): string {
  return localDayKey(new Date());
}

/** Day keys are compared and stepped in UTC arithmetic — a calendar triple has
 *  no zone, and doing the arithmetic locally would make a DST boundary add or
 *  drop an hour and round to the wrong day. */
function utcMs(day: string): number {
  const m = DATE_ONLY.exec(day);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function isRealDay(day: string): boolean {
  const ms = utcMs(day);
  return Number.isFinite(ms) && dayKeyFromUtc(new Date(ms)) === day;
}

export function addDays(day: string, n: number): string {
  const ms = utcMs(day);
  if (!Number.isFinite(ms)) return day;
  return dayKeyFromUtc(new Date(ms + n * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  const a = utcMs(from);
  const b = utcMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

/** 0 = Sunday. */
export function weekdayOf(day: string): number {
  const ms = utcMs(day);
  return Number.isFinite(ms) ? new Date(ms).getUTCDay() : 0;
}

/**
 * Read a stored date value without converting anything.
 *
 * Returns `null` for anything that is not a date we recognise (absent, a
 * number, free text, an impossible `2026-02-31`) — such a row is *unscheduled*,
 * which is honest: we cannot place it, and dropping it on a day will write a
 * value we do understand.
 */
export function parseStoredDate(raw: unknown): StoredDate | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  if (DATE_ONLY.test(s)) return isRealDay(s) ? { form: "date", day: s } : null;
  const m = WITH_TIME.exec(s);
  if (!m) return null;
  const day = m[1];
  const time = m[2];
  const zone = m[3];
  if (!day || !time || !isRealDay(day)) return null;
  if (!zone) return { form: "naive", day, time };
  return { form: "zoned", day, time, zone };
}

/** `+0530` / `+05` → `+05:30` / `+05:00`, so `new Date()` parses it everywhere.
 *  Used only to READ an instant — the original text is what we write back. */
function parsableZone(zone: string): string {
  if (/^z$/i.test(zone)) return "Z";
  if (zone.length === 3) return `${zone}:00`;
  return zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
}

function instantOf(s: StoredDate & { form: "zoned" }): Date | null {
  const d = new Date(`${s.day}T${s.time}${parsableZone(s.zone)}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Which cell a value belongs in.
 *
 * Date-only and zone-less values return their own day STRING — no Date is
 * constructed, so they cannot shift. Only a genuine instant is resolved to the
 * viewer's local day, which is what an instant means.
 */
export function storedDayKey(s: StoredDate): string {
  if (s.form !== "zoned") return s.day;
  const t = instantOf(s);
  return t ? localDayKey(t) : s.day;
}

/**
 * The value to WRITE so this object lands on `target`, in the same
 * representation it already had.
 *
 *  - date-only stays date-only;
 *  - a zone-less time keeps its wall clock;
 *  - an instant is shifted by whole days, so its time-of-day AND its original
 *    offset text survive verbatim (`09:00:00Z` stays `09:00:00Z`).
 *
 * With nothing stored yet (a chip dragged out of the Unscheduled tray) the
 * property's KIND decides: a `date` gets the bare day, anything else gets local
 * NOON of that day — noon because no real offset can push noon across midnight,
 * so the chip lands where it was dropped for the member who dropped it.
 */
export function withDay(current: StoredDate | null, target: string, kind: string): string {
  if (!current) return kind === "date" ? target : localNoonIso(target);
  if (current.form === "date") return target;
  if (current.form === "naive") return `${target}T${current.time}`;
  const delta = daysBetween(storedDayKey(current), target);
  return `${addDays(current.day, delta)}T${current.time}${current.zone}`;
}

function localNoonIso(day: string): string {
  const m = DATE_ONLY.exec(day);
  if (!m) return day;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0).toISOString();
}

/** The chip's time caption. A zone-less time is shown exactly as stored (we do
 *  not know what zone it meant, so we do not pretend); an instant is shown in
 *  the viewer's own clock. */
export function timeLabel(s: StoredDate | null): string | null {
  if (!s || s.form === "date") return null;
  if (s.form === "naive") {
    const hm = s.time.slice(0, 5);
    // Midnight is what a date-only value becomes when it is stored as a
    // timestamp (a due_date at "…T00:00"); printing "12:00 AM" on it is noise,
    // not information. Treat it as time-less.
    return hm === "00:00" ? null : hm;
  }
  const t = instantOf(s);
  // Suppress the label only when the value's OWN wall clock reads midnight — the
  // same deterministic test the naive branch uses. Keying it off the viewer's
  // LOCAL hours (`t.getHours()`) instead made an instant read as timed for one
  // member and as date-only for another, and vanish entirely for whoever sat
  // in the offset where it happened to align to local 00:00.
  const wallMidnight = s.time.slice(0, 5) === "00:00";
  if (!t) return wallMidnight ? null : s.time.slice(0, 5);
  if (wallMidnight) return null;
  return t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/* ----------------------------------------------------------------- the grid */

function startOfWeek(day: string): string {
  return addDays(day, -weekdayOf(day));
}

/** Whole weeks covering `anchor`'s month — 35 or 42 days, always Sunday-first
 *  and always starting/ending on a week boundary. */
export function monthGridDays(anchor: string): string[] {
  const m = DATE_ONLY.exec(anchor);
  if (!m) return weekGridDays(anchor);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const first = dayKeyFromUtc(new Date(Date.UTC(y, mo - 1, 1)));
  const last = dayKeyFromUtc(new Date(Date.UTC(y, mo, 0)));
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 6);
  const out: string[] = [];
  for (let d = start; daysBetween(d, end) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

export function weekGridDays(anchor: string): string[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

type Span = "month" | "week";

function gridDays(anchor: string, span: Span): string[] {
  return span === "month" ? monthGridDays(anchor) : weekGridDays(anchor);
}

/** Step the view. A month step snaps to the 1st so repeated clicks cannot drift
 *  (Jan 31 → "one month on" is not a real date). */
function shiftAnchor(anchor: string, span: Span, dir: 1 | -1): string {
  if (span === "week") return addDays(anchor, 7 * dir);
  const m = DATE_ONLY.exec(anchor);
  if (!m) return anchor;
  return dayKeyFromUtc(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + dir, 1)));
}

/** Dates are formatted from a UTC-built Date with `timeZone: "UTC"`, so the
 *  label of a day key is that key — never the day before it. */
function fmtDay(day: string, opts: Intl.DateTimeFormatOptions): string {
  const ms = utcMs(day);
  if (!Number.isFinite(ms)) return day;
  return new Date(ms).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}

function humanDay(day: string): string {
  return fmtDay(day, { month: "short", day: "numeric" });
}

export function rangeLabel(anchor: string, span: Span): string {
  if (span === "month") return fmtDay(anchor, { month: "long", year: "numeric" });
  const days = weekGridDays(anchor);
  const a = days[0] ?? anchor;
  const b = days[6] ?? anchor;
  return `${humanDay(a)} – ${fmtDay(b, { month: "short", day: "numeric", year: "numeric" })}`;
}

const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, i) =>
  // 2024-01-07 was a Sunday; UTC throughout so the labels cannot rotate.
  new Date(Date.UTC(2024, 0, 7 + i)).toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC",
  }),
);

/* ------------------------------------------------------------------- values */

/** Spine columns the server owns: they can be CHOSEN as the calendar's date
 *  (seeing when rows were touched is useful) but they can never be patched, so
 *  the whole move affordance is off for them. */
const SPINE_DATE_PROPS: readonly string[] = ["updated_at", "created_at"];

function rawDateValue(row: ListItem, dateProp: string): unknown {
  if (dateProp === "updated_at") return row.updated_at;
  if (dateProp === "created_at") return row.created_at;
  return row.props?.[dateProp];
}

function dayOfRow(row: ListItem, dateProp: string): string | null {
  const s = parseStoredDate(rawDateValue(row, dateProp));
  return s ? storedDayKey(s) : null;
}

function titleOf(row: ListItem): string {
  return row.title ?? "untitled";
}

function humanProp(name: string): string {
  return name.replace(/_/g, " ");
}

/** Chips per cell before the overflow affordance takes over. A month cell that
 *  grows without bound stops being a month. */
const MONTH_CHIPS = 3;
const WEEK_CHIPS = 10;

/* ------------------------------------------------------------------ layout */

export function CalendarLayout({ rows, propDefs, config, onPatch, onOpen, readOnly }: LayoutProps) {
  const isMobile = useIsMobile();
  const dateProp = config.dateProp ?? "";
  const isSpine = SPINE_DATE_PROPS.includes(dateProp);
  const propDef: PropDef | null = propDefs.find((p) => p.name === dateProp) ?? null;
  // A saved config can name a property that has since been dropped. That is not
  // a crash and not an empty page: every row simply reads as unscheduled, and
  // we say why rather than silently showing nothing.
  const unknownProp = !isSpine && propDef === null;
  const propKind = propDef?.kind ?? (isSpine ? "timestamp" : "date");

  const canMove = !readOnly && !isSpine && !unknownProp;
  // A required property cannot be unset — offering an Unscheduled drop that the
  // server will refuse is worse than not offering it.
  const canUnschedule = canMove && !(propDef?.required ?? false);

  const [span, setSpan] = useState<Span>("month");
  const [anchor, setAnchor] = useState<string>(() => initialAnchor(rows, dateProp));
  /** Optimistic day per row, held ONLY while its patch is in flight. */
  const [pending, setPending] = useState<ReadonlyMap<string, string | null>>(new Map());
  /** Keyboard move in progress: which chip, and which day it is hovering. */
  const [grab, setGrab] = useState<{ id: string; day: string } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [overDay, setOverDay] = useState<string | null | undefined>(undefined);
  const [announce, setAnnounce] = useState("");
  /** A move we have stopped painting optimistically; the effect below reads the
   *  rows that came back and reports what actually happened. */
  const [settled, setSettled] = useState<{ id: string; target: string | null } | null>(null);

  const dragId = useRef<string | null>(null);
  const pendingRef = useRef<ReadonlyMap<string, string | null>>(pending);
  pendingRef.current = pending;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const days = useMemo(() => gridDays(anchor, span), [anchor, span]);
  const visible = useMemo(() => new Set(days), [days]);

  const effectiveDay = useCallback(
    (row: ListItem): string | null => {
      const override = pending.get(row.id);
      if (override !== undefined) return override;
      return dayOfRow(row, dateProp);
    },
    [pending, dateProp],
  );

  /** Rows bucketed by the day they are drawn on, plus the two buckets that are
   *  not cells: nothing to place, and placed outside the window. */
  const { byDay, unscheduled, offscreen, offscreenDays } = useMemo(() => {
    const map = new Map<string, ListItem[]>();
    const none: ListItem[] = [];
    const offDays: string[] = [];
    for (const row of rows) {
      const day = effectiveDay(row);
      if (day === null) {
        none.push(row);
        continue;
      }
      if (!visible.has(day)) {
        offDays.push(day);
        continue;
      }
      const bucket = map.get(day);
      if (bucket) bucket.push(row);
      else map.set(day, [row]);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => {
        const at = String(rawDateValue(a, dateProp) ?? "");
        const bt = String(rawDateValue(b, dateProp) ?? "");
        return at === bt ? titleOf(a).localeCompare(titleOf(b)) : at.localeCompare(bt);
      });
    }
    return { byDay: map, unscheduled: none, offscreen: offDays.length, offscreenDays: offDays };
  }, [rows, effectiveDay, visible, dateProp]);

  // The window that would bring the nearest hidden record into view — so the
  // "outside this month" note is a door, not a dead end.
  const jumpTarget = useMemo(() => {
    let best: string | null = null;
    let bestAbs = Infinity;
    for (const d of offscreenDays) {
      const a = Math.abs(daysBetween(anchor, d));
      if (a < bestAbs) {
        bestAbs = a;
        best = d;
      }
    }
    return best;
  }, [offscreenDays, anchor]);

  /** The agenda's rows: the days of this range that actually have something on
   *  them, in order. A month of empty headings is not an agenda — the grid is
   *  what shows you an empty Tuesday, and the grid is not what a phone gets. */
  const agendaDays = useMemo(
    () => days.filter((d) => (byDay.get(d)?.length ?? 0) > 0),
    [days, byDay],
  );

  // A keyboard move that walks off the visible weeks brings the view with it —
  // otherwise the member is steering a chip they cannot see.
  useEffect(() => {
    if (grab && !visible.has(grab.day)) setAnchor(grab.day);
  }, [grab, visible]);

  // The explicit part of explicit-revert: once the optimistic override is gone,
  // compare what we asked for against what the server actually left behind and
  // SAY it. `rows` is authoritative here — the shell has already folded in the
  // patch result, or re-read the row after a conflict.
  useEffect(() => {
    if (!settled) return;
    const row = rows.find((r) => r.id === settled.id) ?? null;
    if (!row) {
      setAnnounce("That row is no longer in this view.");
    } else {
      const now = dayOfRow(row, dateProp);
      if (now === settled.target) {
        setAnnounce(
          `${titleOf(row)} moved to ${settled.target ? humanDay(settled.target) : "Unscheduled"}.`,
        );
      } else {
        setAnnounce(
          `That move didn’t stick — ${titleOf(row)} is back on ${now ? humanDay(now) : "Unscheduled"}.`,
        );
      }
    }
    setSettled(null);
  }, [settled, rows, dateProp]);

  /**
   * One move = one CAS patch of one property.
   *
   * The optimistic day is painted immediately and dropped in `finally` whatever
   * happened: `onPatch` never rejects, so "the write was refused" reaches us as
   * `rows` disagreeing with what we asked for — and the moment we stop painting
   * over `rows`, the chip is back where the server says it is.
   */
  const moveTo = useCallback(
    async (row: ListItem, target: string | null) => {
      if (!canMove) return;
      // One in-flight move per row: a second drag would CAS against a version
      // we already know is stale and lose on purpose.
      if (pendingRef.current.has(row.id)) return;
      if (target !== null && !isRealDay(target)) return;
      const stored = parseStoredDate(rawDateValue(row, dateProp));
      const current = stored ? storedDayKey(stored) : null;
      if (current === target) return;
      if (target === null && !canUnschedule) {
        setAnnounce(`${humanProp(dateProp)} is required — ${titleOf(row)} can’t be unscheduled.`);
        return;
      }
      const next = target === null ? null : withDay(stored, target, propKind);
      setPending((p) => new Map(p).set(row.id, target));
      try {
        await onPatch(row.id, rowVersion(row), { props: { [dateProp]: next } });
      } finally {
        if (alive.current) {
          setPending((p) => {
            const m = new Map(p);
            m.delete(row.id);
            return m;
          });
          setSettled({ id: row.id, target });
        }
      }
    },
    [canMove, canUnschedule, dateProp, propKind, onPatch],
  );

  /* ------------------------------------------------------------ interaction */

  const onDragStartChip = (e: DragEvent<HTMLElement>, row: ListItem) => {
    dragId.current = row.id;
    try {
      e.dataTransfer.setData("text/plain", row.id);
      e.dataTransfer.effectAllowed = "move";
    } catch {
      // Some environments (and jsdom) have no working dataTransfer; the ref is
      // the source of truth precisely so the drag still works.
    }
  };

  const dropTargetProps = (day: string | null, enabled: boolean) =>
    enabled
      ? {
          onDragOver: (e: DragEvent<HTMLElement>) => {
            e.preventDefault();
            try {
              e.dataTransfer.dropEffect = "move";
            } catch {
              /* see above */
            }
            setOverDay(day);
          },
          onDragLeave: () => setOverDay((d) => (d === day ? undefined : d)),
          onDrop: (e: DragEvent<HTMLElement>) => {
            e.preventDefault();
            setOverDay(undefined);
            let id = dragId.current;
            if (!id) {
              try {
                id = e.dataTransfer.getData("text/plain") || null;
              } catch {
                id = null;
              }
            }
            dragId.current = null;
            const row = rows.find((r) => r.id === id) ?? null;
            if (row) void moveTo(row, day);
          },
        }
      : {};

  const onChipKey = (e: KeyboardEvent<HTMLElement>, row: ListItem) => {
    if (!canMove) return;
    const held = grab && grab.id === row.id ? grab : null;
    if (!held) {
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        const from = effectiveDay(row) ?? todayKey();
        setGrab({ id: row.id, day: from });
        setAnnounce(
          `Moving ${titleOf(row)} from ${effectiveDay(row) ? humanDay(from) : "Unscheduled"}. ` +
            `Arrow keys choose a day, Enter drops it, Escape cancels, U unschedules.`,
        );
      }
      return;
    }
    const step = (n: number) => {
      e.preventDefault();
      const day = addDays(held.day, n);
      setGrab({ id: row.id, day });
      setAnnounce(`${humanDay(day)}`);
    };
    switch (e.key) {
      case "ArrowLeft":
        step(-1);
        break;
      case "ArrowRight":
        step(1);
        break;
      case "ArrowUp":
        step(-7);
        break;
      case "ArrowDown":
        step(7);
        break;
      case "Enter":
      case " ":
        // Committing from the keyboard must not also fire the chip's click
        // (which would open the object we just rescheduled).
        e.preventDefault();
        setGrab(null);
        void moveTo(row, held.day);
        break;
      case "Escape":
        e.preventDefault();
        setGrab(null);
        setAnnounce("Move cancelled.");
        break;
      case "u":
      case "U":
        e.preventDefault();
        setGrab(null);
        void moveTo(row, null);
        break;
      default:
        break;
    }
  };

  /* ---------------------------------------------------------------- render */

  const chipLimit = span === "month" ? MONTH_CHIPS : WEEK_CHIPS;
  const today = todayKey();
  const month = anchor.slice(0, 7);

  const renderChip = (row: ListItem, opts: { tray?: boolean } = {}) => {
    const stored = parseStoredDate(rawDateValue(row, dateProp));
    const time = opts.tray ? null : timeLabel(stored);
    const held = grab?.id === row.id ? grab : null;
    const inFlight = pending.has(row.id);
    return (
      <button
        key={row.id}
        // Not draggable on a phone: iOS turns a long press on a draggable
        // element into a lottery between a drag, a selection and a context
        // menu, and the loser is always the member.
        draggable={canMove && !isMobile}
        type="button"
        onDragStart={canMove && !isMobile ? (e) => onDragStartChip(e, row) : undefined}
        onDragEnd={() => {
          dragId.current = null;
          setOverDay(undefined);
        }}
        onClick={() => onOpen(row.id)}
        onKeyDown={(e) => onChipKey(e, row)}
        onBlur={() => setGrab((g) => (g && g.id === row.id ? null : g))}
        data-object-id={row.id}
        aria-label={`${titleOf(row)}${canMove && !isMobile ? " — press M to move" : ""}`}
        aria-grabbed={held ? true : undefined}
        title={titleOf(row)}
        className={cn(
          "group flex w-full min-w-0 items-center gap-1.5 rounded-none border px-1.5 py-1 text-left transition-colors",
          "bg-card border-line-soft hover:bg-hover-strong",
          canMove && !isMobile && "cursor-grab active:cursor-grabbing",
          isMobile && "touch-target py-2",
          inFlight && "opacity-60",
          held && "border-ring ring-2 ring-ring/40",
        )}
      >
        {time && <span className="shrink-0 font-mono text-[10px] text-dim">{time}</span>}
        <span className="min-w-0 flex-1 truncate text-[11.5px] leading-tight font-[550] text-ink">
          {titleOf(row)}
        </span>
        <PrivateBadge visibility={row.visibility} />
        {held && (
          <span className="shrink-0 font-mono text-[10px] text-mut">→ {humanDay(held.day)}</span>
        )}
      </button>
    );
  };

  return (
    <div className={`flex min-h-0 flex-1 flex-col gap-3 py-5 ${isMobile ? "px-4" : "px-8"}`}>
      {/* Local controls only. WHICH property the calendar reads is the shell's
          toolbar; how much of it you are looking at is ours. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={span === "month" ? "Previous month" : "Previous week"}
            onClick={() => setAnchor((a) => shiftAnchor(a, span, -1))}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={span === "month" ? "Next month" : "Next week"}
            onClick={() => setAnchor((a) => shiftAnchor(a, span, 1))}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <span className="text-[14px] font-[650] tracking-[-0.01em]">
          {rangeLabel(anchor, span)}
        </span>
        <Button variant="outline" size="xs" className="text-mut" onClick={() => setAnchor(today)}>
          Today
        </Button>

        <div className="ml-auto flex overflow-hidden rounded-none border border-line-soft">
          {(["month", "week"] as const).map((s) => (
            <Button
              key={s}
              variant={span === s ? "secondary" : "ghost"}
              size="xs"
              className="rounded-none capitalize"
              aria-pressed={span === s}
              onClick={() => setSpan(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      {(isSpine || unknownProp || readOnly) && (
        <p className="text-[12px] text-dim">
          {unknownProp
            ? `This view is set to “${humanProp(dateProp)}”, which this type no longer has — pick another date property.`
            : isSpine
              ? `${humanProp(dateProp)} is set by the box — pick a date property of this type to reschedule by dragging.`
              : "You have read-only access, so objects can be opened but not rescheduled."}
        </p>
      )}

      {isMobile && canMove && (
        <p className="text-[12px] text-dim">
          Tap an object to open it — its {humanProp(dateProp)} is editable there.
        </p>
      )}

      {isMobile ? (
        <div className="flex flex-col border-t border-line-soft" data-agenda="true">
          {agendaDays.length === 0 && (
            <p className="py-6 text-center text-[12.5px] text-dim">
              Nothing scheduled in this {span === "month" ? "month" : "week"}.
            </p>
          )}
          {agendaDays.map((day) => {
            const bucket = byDay.get(day) ?? [];
            return (
              <section
                key={day}
                data-day={day}
                aria-label={`${fmtDay(day, { weekday: "long", month: "long", day: "numeric" })} — ${bucket.length} object${bucket.length === 1 ? "" : "s"}`}
                className="border-b border-line-soft py-2.5"
              >
                <h3 className="mb-1.5 flex items-baseline gap-2">
                  <span
                    className={cn(
                      "font-mono text-[12px]",
                      day === today
                        ? "rounded-full bg-primary px-1.5 py-0.5 text-primary-foreground"
                        : "text-mut",
                    )}
                  >
                    {fmtDay(day, { day: "numeric", month: "short" })}
                  </span>
                  <span className="text-[11px] tracking-[.07em] text-dim uppercase">
                    {fmtDay(day, { weekday: "long" })}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-dim">{bucket.length}</span>
                </h3>
                {/* No chip cap here: an agenda row is as tall as it needs to be,
                    which is the whole reason a list beats a grid on a phone. */}
                <div className="flex flex-col gap-1.5">{bucket.map((row) => renderChip(row))}</div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-7 border-t border-l border-line-soft">
          {WEEKDAY_LABELS.map((w) => (
            <div
              key={w}
              className="border-r border-b border-line-soft px-2 py-1.5 text-[11px] font-semibold tracking-[.07em] text-dim uppercase"
            >
              {w}
            </div>
          ))}
          {days.map((day) => {
            const bucket = byDay.get(day) ?? [];
            const open = expanded.has(day);
            const shown = open ? bucket : bucket.slice(0, chipLimit);
            const hidden = bucket.length - shown.length;
            const outside = span === "month" && day.slice(0, 7) !== month;
            return (
              <div
                key={day}
                data-day={day}
                role="group"
                aria-label={`${fmtDay(day, { weekday: "long", month: "long", day: "numeric" })} — ${bucket.length} object${bucket.length === 1 ? "" : "s"}`}
                {...dropTargetProps(day, canMove)}
                className={cn(
                  "flex flex-col gap-1 border-r border-b border-line-soft p-1.5",
                  span === "month" ? "min-h-[104px]" : "min-h-[320px]",
                  outside && "bg-hover/60",
                  overDay === day && "bg-accent-soft",
                  grab?.day === day && "ring-2 ring-ring/50 ring-inset",
                )}
              >
                <div className="flex items-baseline gap-1.5 px-0.5">
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      day === today
                        ? "rounded-full bg-primary px-1.5 py-0.5 text-primary-foreground"
                        : outside
                          ? "text-dim"
                          : "text-mut",
                    )}
                  >
                    {Number(day.slice(8, 10))}
                  </span>
                </div>
                {shown.map((row) => renderChip(row))}
                {hidden > 0 && (
                  <button
                    type="button"
                    onClick={() => setExpanded((s) => new Set(s).add(day))}
                    className="cursor-pointer px-1 py-0.5 text-left text-[11px] text-dim hover:text-mut"
                  >
                    +{hidden} more
                  </button>
                )}
                {open && bucket.length > chipLimit && (
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((s) => {
                        const n = new Set(s);
                        n.delete(day);
                        return n;
                      })
                    }
                    className="cursor-pointer px-1 py-0.5 text-left text-[11px] text-dim hover:text-mut"
                  >
                    show less
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {offscreen > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-dim">
          <span>
            {offscreen} object{offscreen === 1 ? " falls" : "s fall"} outside this{" "}
            {span === "month" ? "month" : "week"}.
          </span>
          {jumpTarget && (
            <Button
              variant="outline"
              size="xs"
              className="text-mut"
              onClick={() => setAnchor(jumpTarget)}
            >
              Jump to {rangeLabel(jumpTarget, span)}
            </Button>
          )}
        </div>
      )}

      {(unscheduled.length > 0 || canUnschedule) && (
        <div
          {...dropTargetProps(null, canUnschedule)}
          aria-label="Unscheduled"
          role="group"
          data-tray="unscheduled"
          className={cn(
            "flex flex-col gap-1.5 border border-line-soft p-2.5",
            overDay === null && "bg-accent-soft",
          )}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[.07em] text-dim uppercase">
            <Inbox size={12} aria-hidden /> Unscheduled
            <span className="font-mono text-[11px] normal-case">{unscheduled.length}</span>
          </div>
          {unscheduled.length === 0 ? (
            <p className="px-1 py-1 text-[11.5px] text-dim italic">
              Drop an object here to clear its {humanProp(dateProp)}.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {unscheduled.map((row) => (
                <div key={row.id} className="w-[200px] max-w-full">
                  {renderChip(row, { tray: true })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {grab && (
        <p className="text-[12px] text-mut">
          <CalendarClock size={12} className="mr-1 inline" aria-hidden />
          Moving to {humanDay(grab.day)} — arrows choose a day, Enter drops it, Escape cancels.
        </p>
      )}

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
    </div>
  );
}

/**
 * Open on the month the member is most likely to want: this one if anything
 * loaded lands in it, otherwise the month of the earliest thing that did load.
 * Opening on an empty month when every row sits in March reads as "the calendar
 * is broken".
 */
export function initialAnchor(rows: ListItem[], dateProp: string): string {
  const today = todayKey();
  if (!dateProp) return today;
  const month = today.slice(0, 7);
  let earliest: string | null = null;
  for (const row of rows) {
    const day = dayOfRow(row, dateProp);
    if (day === null) continue;
    if (day.slice(0, 7) === month) return today;
    if (earliest === null || day < earliest) earliest = day;
  }
  return earliest ?? today;
}
