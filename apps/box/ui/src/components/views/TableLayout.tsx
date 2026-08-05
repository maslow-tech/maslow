/**
 * The table layout — the database's default face, and the only layout you edit
 * *in place*.
 *
 * It implements `LayoutProps` and nothing else: no fetching, no query building,
 * no `api.*` call of its own. Every write leaves through `onPatch`, every view
 * preference through `onConfigChange`, and the new row through `onCreate` —
 * which is the shell's create, not a second one (the shell owns the idempotency
 * key, so a lost response can never become two rows).
 *
 * Four rules earn this file its size:
 *
 *  1. **One cell edit is one field-granular CAS patch.** Committing a cell
 *     sends `props: { <key>: <value> }` against that row's own `version` —
 *     never the whole props object, which would revert keys nobody in this tab
 *     touched (agents write into these rows too). The editors are literally
 *     `PropsPanel`'s `PropField`, so a `date` is a date picker and an `enum`
 *     can only hold a declared value, in the rail and in the grid alike.
 *  2. **Optimistic, but never dishonest.** The typed value paints immediately.
 *     When the patch settles, the row is the truth again: if the value we asked
 *     for is not what the row now holds, the cell VISIBLY REVERTS and grows an
 *     inline conflict affordance (what you set · Retry · Dismiss). A silent
 *     revert and a permanently dirty cell the member believes is saved are both
 *     bugs — and this is the only place that can tell you WHICH cell lost,
 *     which the shell's one-line notice strip cannot.
 *  3. **Conflict state is derived, not remembered.** After a patch settles we
 *     keep only "this is what was attempted"; whether that is a conflict is
 *     recomputed from `rows` on every render and self-clears the moment the row
 *     agrees. So a live refresh that brings the value into line drops the badge
 *     instead of stranding it, and a stale latch can never re-appear.
 *  4. **A viewer gets no editor at all.** `readOnly` renders plain values with
 *     no grid focus, no editors and no new-row row. The endpoints refuse a
 *     viewer's write independently — this is UX, not the boundary.
 *
 * Keyboard: the body is a roving-tabindex grid. Arrows move a cell at a time,
 * Enter opens the editor, Enter commits and closes it, Escape cancels and
 * returns focus to the cell.
 *
 * **On a phone it is still a table.** A grid of columns does not become
 * readable by being squeezed into 390px — it becomes six columns of ellipsis.
 * So below `MOBILE_QUERY` the table keeps its real column widths and scrolls
 * HORIZONTALLY (momentum scrolling and `overscroll-behavior-x: contain` come
 * from `[data-slot="table-container"]` in index.css), with the TITLE COLUMN
 * PINNED to the left edge — sticky, opaque, and carrying a hairline shadow
 * while there is anything scrolled underneath it. Which row you are reading is
 * the one thing that must never scroll away; everything else can.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Columns3, Plus, X } from "lucide-react";

import type { ListItem, PropDef } from "../../lib/api";
import type { ColumnConfig, Sort, ViewConfig } from "../../lib/viewConfig";
import {
  CellValue,
  humanProp,
  rowVersion,
  visibleColumns,
  type LayoutProps,
} from "../../views/TypeView";
import { PrivateBadge } from "../bits";
import { PropField } from "../PropsPanel";
import { fmtRelative } from "../../lib/ui";
import { useIsMobile } from "../../lib/mobile";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Kinds that never get a column: a `ref` is an edge, edited from the links
 *  rail (a props patch cannot express it), and `ref[]` even less so. */
const NON_COLUMN_KINDS: readonly string[] = ["ref", "ref[]"];

/** Narrower than this a header is unreadable; a drag stops at both ends. */
const MIN_COL_WIDTH = 72;
const MAX_COL_WIDTH = 720;

/** The pinned title column's width on a phone. Wide enough for a real title at
 *  13.5px, narrow enough to leave most of a 390px screen for the data you
 *  scrolled sideways to read. */
const MOBILE_TITLE_WIDTH = 168;
/** Below this the table would rather scroll than compress. A phone viewport is
 *  ~360-430px, so any table with more than one property crosses it. */
const MOBILE_MIN_TABLE_WIDTH = 640;

/** One cell's identity. Property names are member-authored, so the separator is
 *  a NUL rather than any character a name could contain; the id half is a uuid,
 *  so splitting on the first NUL always recovers both. */
const SEP = "\u0000";

function cellKey(id: string, prop: string): string {
  return `${id}${SEP}${prop}`;
}

function splitCellKey(key: string): { id: string; prop: string } {
  const at = key.indexOf(SEP);
  return at < 0 ? { id: key, prop: "" } : { id: key.slice(0, at), prop: key.slice(at + 1) };
}

/** One attempted write, remembered only until the row agrees with it. */
interface Attempt {
  value: unknown;
  /** The version the CAS was made against — shown in the conflict tooltip, so
   *  "someone changed this first" is a fact and not a vibe. */
  base: number;
}

/**
 * Is what the row now holds the value we asked for?
 *
 * Kind-aware on purpose: a `date` sent as `2026-07-02` comes back as a full
 * timestamp, and `"3"` and `3` are the same number. Comparing raw strings would
 * flag a perfectly successful write as a conflict, which is worse than missing
 * one — it teaches members to ignore the badge.
 */
export function sameCellValue(kind: string, a: unknown, b: unknown): boolean {
  const emptyA = a === null || a === undefined || a === "";
  const emptyB = b === null || b === undefined || b === "";
  if (emptyA || emptyB) return emptyA && emptyB;
  if (kind === "date") return String(a).slice(0, 10) === String(b).slice(0, 10);
  if (kind === "timestamp") {
    const ta = new Date(String(a)).getTime();
    const tb = new Date(String(b)).getTime();
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb;
    return String(a) === String(b);
  }
  if (kind === "bool") return Boolean(a) === Boolean(b);
  if (kind === "int" || kind === "decimal" || kind === "float") {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a) === String(b);
}

/**
 * Every column this type COULD show, in the config's order, each carrying
 * whether it is currently visible and how wide.
 *
 * `visibleColumns` is the shell's single answer to "what is on screen" — it
 * already resolves a saved config against a catalog that has since changed, and
 * falls back to the first handful when nothing is saved. This widens that to
 * the full menu without letting the two disagree: hiding a column therefore
 * starts from what is actually on screen, never from an empty `config.columns`
 * that would silently re-expand to the default six.
 */
export function materializeColumns(config: ViewConfig, propDefs: PropDef[]): ColumnConfig[] {
  const candidates = propDefs.filter((p) => !NON_COLUMN_KINDS.includes(p.kind));
  const shown = new Set(visibleColumns(config, propDefs).map((p) => p.name));
  const widths = new Map(config.columns.map((c) => [c.key, c.width] as const));

  const ordered: PropDef[] = [];
  const seen = new Set<string>();
  for (const c of config.columns) {
    const p = candidates.find((x) => x.name === c.key);
    if (p && !seen.has(p.name)) {
      ordered.push(p);
      seen.add(p.name);
    }
  }
  for (const p of candidates) {
    if (!seen.has(p.name)) {
      ordered.push(p);
      seen.add(p.name);
    }
  }

  return ordered.map((p) => {
    const width = widths.get(p.name);
    const col: ColumnConfig = { key: p.name, visible: shown.has(p.name) };
    if (typeof width === "number") col.width = width;
    return col;
  });
}

/* ------------------------------------------------------------------ layout */

export function TableLayout({
  rows,
  propDefs,
  config,
  onConfigChange,
  onPatch,
  onOpen,
  readOnly,
  onCreate,
  creating = false,
}: LayoutProps) {
  const cols = useMemo(() => visibleColumns(config, propDefs), [config, propDefs]);
  const sort = config.sort[0] ?? null;
  const isMobile = useIsMobile();

  /** In-flight edits, painted over the row until the shell answers. */
  const [pending, setPending] = useState<ReadonlyMap<string, Attempt>>(new Map());
  /** Settled edits, kept only while the row still disagrees with them. */
  const [settled, setSettled] = useState<ReadonlyMap<string, Attempt>>(new Map());
  /** Which cell is open for editing. */
  const [editing, setEditing] = useState<{ id: string; prop: string } | null>(null);
  /** Where grid focus sits — one cell in the whole table is tabbable. */
  const [active, setActive] = useState<{ r: number; c: number }>({ r: 0, c: 0 });

  const kindOf = useCallback(
    (prop: string) => propDefs.find((p) => p.name === prop)?.kind ?? "text",
    [propDefs],
  );

  // Rule 3: a settled attempt the row now agrees with is not a conflict and
  // must not linger — otherwise a later remote write to that cell would
  // resurrect a badge for an edit that landed minutes ago.
  useEffect(() => {
    if (settled.size === 0) return;
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    const next = new Map(settled);
    let changed = false;
    for (const [key, attempt] of settled) {
      const { id, prop } = splitCellKey(key);
      const row = byId.get(id);
      // A row that left the view (deleted, retyped, no longer ours to read) has
      // nothing to revert into — the shell has already said so in its notice.
      if (!row || sameCellValue(kindOf(prop), row.props?.[prop], attempt.value)) {
        next.delete(key);
        changed = true;
      }
    }
    if (changed) setSettled(next);
  }, [rows, settled, kindOf]);

  /** Focus returns to the cell once its editor closes — losing the caret to the
   *  document body after every edit makes the grid unusable by keyboard. */
  const cellRefs = useRef(new Map<string, HTMLElement>());
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    cellRefs.current.get(key)?.focus();
  });

  // Stable per-cell ref callbacks: an inline `register={(el)=>…}` is a fresh
  // closure every render, so React detaches + re-attaches EVERY cell ref on
  // every re-render — and a single cell focus / arrow-key move re-renders the
  // whole body (the roving-tabindex `active` state feeds every cell). Memoized
  // by cellKey the identity holds, so React leaves the untouched refs alone.
  // Same fix commit bd87f85 made for BoardLayout's card refs.
  const cellRefCbs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const cellRef = useCallback((key: string) => {
    const cache = cellRefCbs.current;
    let cb = cache.get(key);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) cellRefs.current.set(key, el);
        else cellRefs.current.delete(key);
      };
      cache.set(key, cb);
    }
    return cb;
  }, []);

  /* --------------------------------------------------- the right-edge fade cue
     The phone table scrolls sideways to reveal columns that do not fit, and the
     fade says so — but ONLY while there is more table past the right edge. A
     fade that is always painted dims the LAST column's real values once the
     member swipes to the end and falsely signals "swipe for more" when there is
     nothing further. So track actual overflow on the scroller (the Table's inner
     `overflow-x-auto` container), exactly as BoardLayout does for its columns. */
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [showRightFade, setShowRightFade] = useState(false);
  useEffect(() => {
    if (!isMobile) {
      setShowRightFade(false);
      return;
    }
    const el = frameRef.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
    if (!el) {
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
  }, [isMobile, cols.length, rows.length]);

  const forget = useCallback((key: string) => {
    setSettled((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);

  const commit = useCallback(
    async (row: ListItem, def: PropDef, value: unknown) => {
      if (readOnly) return;
      const key = cellKey(row.id, def.name);
      // Re-committing the value already stored is not an edit: it would burn a
      // version and could 409 against someone else's harmless write.
      if (sameCellValue(def.kind, row.props?.[def.name], value)) {
        forget(key);
        return;
      }
      const attempt: Attempt = { value, base: rowVersion(row) };
      setPending((m) => new Map(m).set(key, attempt));
      forget(key);
      try {
        await onPatch(row.id, attempt.base, { props: { [def.name]: value } });
      } finally {
        // `onPatch` is documented never to reject (the shell folds the answer in
        // and reports refusals itself), but a surprise must not strand the cell
        // in a permanent "saving" state that hides the real value.
        setPending((m) => {
          const next = new Map(m);
          next.delete(key);
          return next;
        });
        setSettled((m) => new Map(m).set(key, attempt));
      }
    },
    [forget, onPatch, readOnly],
  );

  const toggleSort = (prop: string) =>
    onConfigChange({
      ...config,
      sort: [{ prop, dir: sort?.prop === prop && sort.dir === "asc" ? "desc" : "asc" }],
    });

  const setColumnVisible = (key: string, visible: boolean) => {
    const all = materializeColumns(config, propDefs);
    onConfigChange({ ...config, columns: all.map((c) => (c.key === key ? { ...c, visible } : c)) });
  };

  const setColumnWidth = (key: string, width: number) => {
    const all = materializeColumns(config, propDefs);
    const clamped = Math.round(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, width)));
    onConfigChange({
      ...config,
      columns: all.map((c) => (c.key === key ? { ...c, width: clamped } : c)),
    });
  };

  /* ------------------------------------------------------------- keyboard */

  const focusAt = (r: number, c: number) => {
    const row = rows[r];
    const col = cols[c];
    if (!row || !col) return;
    setActive({ r, c });
    refocus.current = cellKey(row.id, col.name);
  };

  const onCellKeyDown = (e: React.KeyboardEvent, r: number, c: number, row: ListItem) => {
    const col = cols[c];
    if (!col) return;
    if (editing !== null && editing.id === row.id && editing.prop === col.name) {
      // Arrows belong to the caret (or to an open listbox) while an editor is
      // up. PropField owns commit-on-Enter and revert-on-Escape — in the rail
      // and here alike — so all this does is close the editor after it.
      if (e.key === "Enter" || e.key === "Escape") {
        setEditing(null);
        refocus.current = cellKey(row.id, col.name);
      }
      return;
    }
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusAt(r, Math.min(cols.length - 1, c + 1));
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusAt(r, Math.max(0, c - 1));
        break;
      case "ArrowDown":
        e.preventDefault();
        focusAt(Math.min(rows.length - 1, r + 1), c);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(Math.max(0, r - 1), c);
        break;
      case "Enter":
        if (readOnly) return;
        e.preventDefault();
        setActive({ r, c });
        setEditing({ id: row.id, prop: col.name });
        break;
      default:
        break;
    }
  };

  /* ---------------------------------------------------------------- render */

  const th = "py-2.5 text-[11px] font-semibold tracking-[.07em] text-dim uppercase select-none";
  const ariaSortFor = (prop: string): "ascending" | "descending" | "none" =>
    sort?.prop === prop ? (sort.dir === "asc" ? "ascending" : "descending") : "none";

  const widthOf = (name: string): number | undefined =>
    config.columns.find((c) => c.key === name)?.width;

  // Rows and columns come and go under us (a live refresh, a hidden column);
  // the roving tabindex must land somewhere real on every render.
  const activeRow = Math.min(active.r, Math.max(0, rows.length - 1));
  const activeCol = Math.min(active.c, Math.max(0, cols.length - 1));

  // The phone's gutter is 16px, not 32px — a 390px screen cannot spend a sixth
  // of itself on margins — and the title column is pinned rather than scrolled.
  const gutter = isMobile ? "pl-4" : "pl-8";
  const endGutter = isMobile ? "pr-4" : "pr-8";
  const pinned = isMobile ? "sticky left-0 z-10 pinned-col" : "";

  return (
    <div className="relative" ref={frameRef}>
      <Table
        className="text-[13.5px]"
        // Tailwind cannot see a class it did not read at build time, so the
        // phone's minimum table width is an inline style: the point of it is that
        // the table REFUSES to compress below a readable size and scrolls
        // instead, which a class that silently failed to exist would not do.
        {...(isMobile ? { style: { minWidth: MOBILE_MIN_TABLE_WIDTH } } : {})}
        data-mobile={isMobile ? "true" : undefined}
      >
        {/* Widths live in the view config, so a resize is a local preference: it
          never re-compiles the query and never costs a round-trip. */}
        <colgroup>
          <col {...(isMobile ? { style: { width: MOBILE_TITLE_WIDTH } } : {})} />
          {cols.map((c) => {
            const w = widthOf(c.name);
            return <col key={c.name} {...(w === undefined ? {} : { style: { width: w } })} />;
          })}
          <col style={{ width: 120 }} />
          <col style={{ width: 44 }} />
        </colgroup>

        {/* Sticky, and opaque: --panel is translucent in the dark skin, so rows
          would scroll visibly through the header. */}
        <TableHeader className="sticky top-0 z-20 bg-panel2">
          <TableRow>
            {/* z-30, not z-20: this cell is sticky in BOTH axes on a phone (it is
              inside the sticky header AND pinned left), so it has to win
              against the header cells that are only sticky in one. */}
            <TableHead
              aria-sort={ariaSortFor("title")}
              className={`${th} pr-4 ${gutter} ${
                isMobile ? "sticky left-0 z-30 bg-panel2 pinned-col" : ""
              }`}
            >
              <SortButton prop="title" sort={sort} onToggle={toggleSort}>
                Title
              </SortButton>
            </TableHead>
            {cols.map((c) => (
              <TableHead
                key={c.name}
                aria-sort={ariaSortFor(c.name)}
                className={`${th} relative px-4`}
              >
                <SortButton prop={c.name} sort={sort} onToggle={toggleSort}>
                  {humanProp(c.name)}
                </SortButton>
                <ColumnGrip
                  name={c.name}
                  current={widthOf(c.name)}
                  onResize={(w) => setColumnWidth(c.name, w)}
                />
              </TableHead>
            ))}
            <TableHead aria-sort={ariaSortFor("updated_at")} className={`${th} px-4 text-right`}>
              <SortButton prop="updated_at" sort={sort} onToggle={toggleSort}>
                Updated
              </SortButton>
            </TableHead>
            <TableHead className={`${th} ${endGutter} pl-0 text-right`}>
              <ColumnMenu
                config={config}
                propDefs={propDefs}
                onToggle={setColumnVisible}
                onReset={() => onConfigChange({ ...config, columns: [] })}
              />
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.map((o, r) => (
            <TableRow key={o.id} className="group">
              {/* Opaque on purpose: a translucent pinned cell lets the columns it
                is supposed to be covering scroll visibly through it. `bg-ground`
                is the page's own ground in both skins, so the pin reads as the
                page rather than as a floating panel. */}
              <TableCell
                className={`max-w-[380px] py-0 pr-4 ${gutter} ${pinned} ${
                  isMobile ? "bg-ground" : ""
                }`}
              >
                <Link
                  to={`/o/${o.id}`}
                  onClick={(e) => {
                    // Plain click is an in-app open; modified clicks stay real
                    // link behaviour (new tab, copy address).
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    onOpen(o.id);
                  }}
                  className="flex items-center gap-2 py-2.5 font-[550] text-ink"
                >
                  <span className="truncate group-hover:underline group-hover:decoration-[var(--line)]">
                    {o.title ?? "untitled"}
                  </span>
                  <PrivateBadge visibility={o.visibility} />
                </Link>
              </TableCell>

              {cols.map((c, ci) => {
                const key = cellKey(o.id, c.name);
                const inFlight = pending.get(key);
                const attempt = settled.get(key);
                const conflict =
                  attempt !== undefined && !sameCellValue(c.kind, o.props?.[c.name], attempt.value)
                    ? attempt
                    : null;
                return (
                  <Cell
                    key={c.name}
                    def={c}
                    row={o}
                    value={inFlight ? inFlight.value : o.props?.[c.name]}
                    saving={inFlight !== undefined}
                    conflict={conflict}
                    readOnly={readOnly}
                    editing={editing?.id === o.id && editing.prop === c.name}
                    focused={r === activeRow && ci === activeCol}
                    rowIndex={r}
                    colIndex={ci}
                    register={cellRef(key)}
                    onFocus={() => setActive({ r, c: ci })}
                    onKeyDown={(e) => onCellKeyDown(e, r, ci, o)}
                    onBeginEdit={() => {
                      setActive({ r, c: ci });
                      setEditing({ id: o.id, prop: c.name });
                    }}
                    onEndEdit={() => setEditing(null)}
                    onChange={(v) => {
                      setEditing(null);
                      refocus.current = key;
                      void commit(o, c, v);
                    }}
                    onRetry={() => {
                      if (!attempt) return;
                      void commit(o, c, attempt.value);
                    }}
                    onDismiss={() => forget(key)}
                  />
                );
              })}

              <TableCell className="px-4 py-2.5 text-right whitespace-nowrap text-dim">
                {fmtRelative(o.updated_at)}
              </TableCell>
              <TableCell className={`py-2.5 pl-0 ${endGutter}`} />
            </TableRow>
          ))}

          {/* The new row is the SHELL's create, drawn where a member expects to
            find it. It never calls the API itself — the shell owns the
            idempotency key that keeps a lost response from becoming two rows. */}
          {!readOnly && onCreate && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={cols.length + 3} className="p-0">
                <button
                  type="button"
                  onClick={() => onCreate()}
                  disabled={creating}
                  className={`touch-target flex w-full cursor-pointer items-center gap-2 py-2.5 ${gutter} text-left text-[13px] text-dim transition-colors hover:bg-hover hover:text-mut disabled:cursor-default disabled:opacity-60`}
                >
                  <Plus size={13} aria-hidden />
                  {creating ? "Adding…" : "New row"}
                </button>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {/* The phone table scrolls sideways to reveal the columns that do not fit;
          this fade over the right edge is the affordance that says so, so a
          column clipped at the viewport reads as "swipe for more", not broken.
          Shown ONLY while content genuinely extends past the right edge — at the
          scroll-end it would otherwise dim the last column's real content. */}
      {isMobile && showRightFade && <div aria-hidden className="table-scroll-fade" />}
    </div>
  );
}

/* ------------------------------------------------------------ sort controls */

// The sort control is a real <button>, not an onClick on the <th>: a keyboard
// user must be able to reach and operate it, and a screen reader must hear that
// the column is sortable (the button label) and which way it is sorted (aria-sort
// on the columnheader). Hoisted to module scope so its identity is stable — a
// component defined inside the render body is a NEW type every render, which
// unmounts and remounts the header controls on every table re-render.
const SORTABLE_CLASS =
  "inline-flex cursor-pointer items-center transition-colors hover:text-mut focus-visible:text-ink";

function SortButton({
  prop,
  sort,
  onToggle,
  children,
}: {
  prop: string;
  sort: Sort | null;
  onToggle: (prop: string) => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={() => onToggle(prop)} className={SORTABLE_CLASS}>
      {children}
      <SortMark prop={prop} sort={sort} />
    </button>
  );
}

function SortMark({ prop, sort }: { prop: string; sort: Sort | null }) {
  if (sort?.prop !== prop) return null;
  return sort.dir === "asc" ? (
    <ArrowUp size={10} className="ml-1 inline" aria-hidden />
  ) : (
    <ArrowDown size={10} className="ml-1 inline" aria-hidden />
  );
}

/* -------------------------------------------------------------------- cell */

interface CellProps {
  def: PropDef;
  row: ListItem;
  value: unknown;
  saving: boolean;
  conflict: Attempt | null;
  readOnly: boolean;
  editing: boolean;
  focused: boolean;
  /** The cell's position, carried purely so the memo comparison re-renders it
   *  when a sort/filter moves it — the navigation closures below capture these
   *  indices, so a stale one would arrow-navigate from the wrong cell. */
  rowIndex: number;
  colIndex: number;
  register: (el: HTMLElement | null) => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onChange: (value: unknown) => void;
  onRetry: () => void;
  onDismiss: () => void;
}

/**
 * Skip a cell's re-render unless something it actually paints — or a value one
 * of its parent-owned handler closures captures — changed. The handler props
 * (`onFocus`/`onKeyDown`/…) are deliberately EXCLUDED: they are fresh inline
 * closures every parent render, but everything they close over is a compared
 * prop here (`row`, `def`, `conflict`, `rowIndex`, `colIndex`), so an equal set
 * of these guarantees the excluded closures are behaviourally identical too.
 */
function cellPropsEqual(a: CellProps, b: CellProps): boolean {
  return (
    a.def === b.def &&
    a.row === b.row &&
    a.value === b.value &&
    a.saving === b.saving &&
    a.conflict === b.conflict &&
    a.readOnly === b.readOnly &&
    a.editing === b.editing &&
    a.focused === b.focused &&
    a.rowIndex === b.rowIndex &&
    a.colIndex === b.colIndex &&
    a.register === b.register
  );
}

const Cell = memo(function Cell({
  def,
  row,
  value,
  saving,
  conflict,
  readOnly,
  editing,
  focused,
  register,
  onFocus,
  onKeyDown,
  onBeginEdit,
  onEndEdit,
  onChange,
  onRetry,
  onDismiss,
}: CellProps) {
  // Rule 4: a viewer gets values, not disabled inputs — nothing here is
  // focusable, so tabbing the page never lands on a dead editor.
  if (readOnly) {
    return (
      <TableCell className="px-4 py-2.5 text-mut">
        <CellValue kind={def.kind} value={value} />
      </TableCell>
    );
  }

  const label = `${humanProp(def.name)} of ${row.title ?? "untitled"}`;
  return (
    <TableCell className="px-0 py-0 text-mut" data-conflict={conflict ? "true" : undefined}>
      <div
        ref={register}
        tabIndex={focused ? 0 : -1}
        aria-label={label}
        aria-invalid={conflict ? true : undefined}
        data-saving={saving ? "true" : undefined}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          // An editor abandoned by clicking elsewhere must close, or the cell
          // keeps an input open over a value that has already been committed
          // (PropField commits on blur) — a dirty-looking cell that is saved.
          if (!editing) return;
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          onEndEdit();
        }}
        className={[
          "min-h-[38px] px-4 py-1.5 outline-none",
          "focus-visible:ring-1 focus-visible:ring-ink/40 focus-visible:ring-inset",
          conflict ? "bg-destructive/5 ring-1 ring-destructive/40 ring-inset" : "",
          saving ? "opacity-60" : "",
        ].join(" ")}
      >
        {editing ? (
          <PropField def={def} value={value} onChange={onChange} />
        ) : (
          <button
            type="button"
            aria-label={`Edit ${label}`}
            onClick={onBeginEdit}
            // The cell itself carries the roving tabindex; this is the mouse
            // affordance, not a second tab stop.
            tabIndex={-1}
            className="flex w-full cursor-text items-center py-1 text-left"
          >
            <CellValue kind={def.kind} value={value} />
          </button>
        )}
        {conflict && (
          <div
            role="status"
            className="flex items-center gap-1.5 py-1 text-[11px] text-destructive"
          >
            <AlertTriangle size={11} aria-hidden />
            <span title={`You set “${describeValue(conflict.value)}” on version ${conflict.base}.`}>
              not saved
            </span>
            <button
              type="button"
              onClick={onRetry}
              className="cursor-pointer underline underline-offset-2"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onDismiss}
              aria-label={`Dismiss unsaved ${label}`}
              className="cursor-pointer rounded-full p-0.5 hover:bg-hover-strong"
            >
              <X size={10} aria-hidden />
            </button>
          </div>
        )}
      </div>
    </TableCell>
  );
}, cellPropsEqual);

function describeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/* ------------------------------------------------------------ column chrome */

/** Drag to resize. Width is a view preference, so it is written on RELEASE —
 *  one config write per drag, not one per pointer move. */
function ColumnGrip({
  name,
  current,
  onResize,
}: {
  name: string;
  current: number | undefined;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ x: number; from: number } | null>(null);

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${humanProp(name)} column`}
      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none hover:bg-hover-strong"
      onPointerDown={(e) => {
        const head = e.currentTarget.parentElement;
        const from = current ?? head?.getBoundingClientRect().width ?? MIN_COL_WIDTH;
        drag.current = { x: e.clientX, from };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        const next = d.from + (e.clientX - d.x);
        if (Math.abs(next - d.from) >= 2) onResize(next);
      }}
      // The header cell sorts on click; grabbing its edge must not.
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** Show/hide, straight into the shared config. The last visible column cannot
 *  be hidden — an empty `columns` list means "use the defaults" everywhere
 *  else, so hiding the last one would silently restore six of them. */
function ColumnMenu({
  config,
  propDefs,
  onToggle,
  onReset,
}: {
  config: ViewConfig;
  propDefs: PropDef[];
  onToggle: (key: string, visible: boolean) => void;
  onReset: () => void;
}) {
  const all = materializeColumns(config, propDefs);
  const shown = all.filter((c) => c.visible).length;
  if (all.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-xs" className="text-dim" aria-label="Choose columns">
            <Columns3 aria-hidden />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-[220px] p-1.5">
        <div className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-[.07em] text-dim uppercase">
          Columns
        </div>
        <ul className="flex flex-col">
          {all.map((c) => {
            const last = c.visible && shown <= 1;
            return (
              <li key={c.key}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={c.visible}
                  disabled={last}
                  title={last ? "At least one column stays visible" : ""}
                  onClick={() => onToggle(c.key, !c.visible)}
                  className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-50"
                >
                  <span className="w-3.5 shrink-0 text-ink">
                    {c.visible ? <Check size={12} aria-hidden /> : null}
                  </span>
                  <span className="truncate">{humanProp(c.key)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={onReset}
          className="mt-1 w-full cursor-pointer border-t border-line-soft px-2 py-1.5 text-left text-[12px] text-dim transition-colors hover:bg-hover hover:text-mut"
        >
          Reset columns
        </button>
      </PopoverContent>
    </Popover>
  );
}
