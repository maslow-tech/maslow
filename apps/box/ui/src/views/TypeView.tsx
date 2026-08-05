import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useParams, useSearchParams } from "react-router";
import { CalendarDays, Columns3, LayoutGrid, Plus, Rows3, Trash2, X } from "lucide-react";
import {
  api,
  ApiError,
  ConflictError,
  newIdempotencyKey,
  type FeedEvent,
  type ListItem,
  type PatchObjectInput,
  type PropDef,
  type TypeSummary,
  type Whoami,
} from "../lib/api";
import {
  defaultConfigFor,
  normalizeConfig,
  readViewConfig,
  toListQuery,
  writeViewConfig,
  type Filter,
  type Layout,
  type ScalarValue,
  type ViewConfig,
} from "../lib/viewConfig";
import { CreateHint, Empty, EnumPill, Spinner, TypeIcon } from "../components/bits";
import { useIsMobile } from "../lib/mobile";
import { SavedViews } from "../components/SavedViews";
import { usePeek } from "../lib/peek";
import { fmtDate, fmtNumber, registerTypeIcons, typeLabel, typeName } from "../lib/ui";
import { isDemo } from "../demo";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FilterBar, groupableProps } from "../components/views/FilterBar";
import { TableLayout } from "../components/views/TableLayout";
import BoardLayout from "../components/views/BoardLayout";
import { GalleryLayout } from "../components/views/GalleryLayout";
import { CalendarLayout } from "../components/views/CalendarLayout";

/**
 * A type is a DATABASE, and this file is its shell — not one of its views.
 *
 * Everything that is the same whichever way you look at the rows lives here and
 * exactly once: the view config (lib/viewConfig), the fetch that compiles that
 * config to the server's query, paging, the trash mode, the toolbar, the New
 * row, the CAS patch path, and the live-update subscription. A layout receives
 * `LayoutProps` and renders — it owns no data loading, no query building and no
 * write plumbing of its own, so four layouts cannot drift into four dialects.
 *
 * Three rules hold the seams:
 *
 *  1. **One query.** `toListQuery(config)` is the only thing that reaches
 *     `api.list`. Re-fetching is keyed on that compiled payload, so hiding a
 *     column or resizing one never costs a round-trip while changing a filter
 *     always does.
 *  2. **Rows are the truth.** `onPatch` resolves after the write settles and
 *     the shell has folded the server's answer into `rows`; a refusal (409, a
 *     row we may no longer read) re-reads that row and says so in the notice
 *     strip. A layout renders `rows` — it must not keep a private copy that
 *     could outlive a rejected write.
 *  3. **Writes are gated twice.** Viewers (and the canned demo build) get no
 *     write affordance AND the endpoints refuse them independently; the UI is
 *     never the security boundary.
 */

/** Table pages; the other layouts want the whole board at once. */
const PAGE = 50;
const BULK_LIMIT = 200;
/** Ceiling for a live refresh that preserves an already-paged window. */
const MAX_WINDOW = 500;
/** Feed fallback cadence while no live socket is reporting for this route. */
const LIVE_POLL_MS = 12_000;
const LIVE_FEED_LIMIT = 40;

const REF_KINDS: readonly string[] = ["ref", "ref[]"];

/* ------------------------------------------------------------- layout contract */

/** The fields half of a CAS patch — `baseVersion` is passed separately so a
 *  layout can never forget it. Inside `props`, `null` DELETES that one key. */
export type PatchFields = Omit<PatchObjectInput, "baseVersion">;

/**
 * The one prop bundle every layout receives. It is uniform on purpose: the four
 * layouts are built in parallel against this interface, and the shell hands all
 * of them the same six things.
 *
 * `readOnly` rides along because the write affordances a layout draws (an
 * editable cell, a draggable card) must disappear for a viewer — it is UX, not
 * enforcement; `onPatch` would be refused server-side anyway.
 */
export interface LayoutProps {
  /** Everything loaded for the current query, in server order. */
  rows: ListItem[];
  /** The type's living properties, in catalog order. Columns/group/date keys in
   *  `config` are names into this list (plus the spine: title, updated_at, …). */
  propDefs: PropDef[];
  config: ViewConfig;
  /** Persisted by the shell, per member and per type. Pass the WHOLE next
   *  config — it is one object, not a bag of independent settings. */
  onConfigChange: (next: ViewConfig) => void;
  /**
   * Compare-and-set write for one row. Resolves once the shell has folded the
   * result in; it never rejects — a conflict or refusal shows in the notice
   * strip and the row is re-read, so the layout's next render is the truth.
   */
  onPatch: (id: string, baseVersion: number, fields: PatchFields) => Promise<void>;
  /** Open the object (its own page today; the phase-4 side-peek later). */
  onOpen: (id: string) => void;
  /** A viewer, or the demo build: draw no write affordance. */
  readOnly: boolean;
  /**
   * Add a row, the SHELL's way — same defaults-from-the-view rule, same one
   * idempotency key per intent. A layout that wants its own "+ New" (the
   * table's last row, a gallery's trailing card) calls this; it must never
   * reach `api.createObject` itself, or a lost response becomes two rows.
   *
   * Optional so a layout can be written against `LayoutProps` without one.
   */
  onCreate?: () => void;
  /** A create is in flight — the affordance says so and stays disabled. */
  creating?: boolean;
}

export type LayoutComponent = ComponentType<LayoutProps>;

/** Which skeleton stands in for which layout while the first page loads. The
 *  calendar has no skeleton of its own — a grid of empty cells IS the loading
 *  state — so it borrows the card shape for its unscheduled tray. */
const SKELETON_FOR: Record<Layout, "list" | "table" | "cards" | "board"> = {
  table: "table",
  board: "board",
  gallery: "cards",
  calendar: "cards",
};

/** `ListItem.version` comes off the wire as a string on some routes and a
 *  number on others; a CAS base is always a number. */
export function rowVersion(row: ListItem): number {
  return typeof row.version === "number" ? row.version : Number(row.version);
}

/* ----------------------------------------------------------------- live source */

/**
 * "Something in this type changed."
 *
 * Phase 2 put route-level presence on the collab socket; when that rail lands on
 * the client it is passed in here and reports remote writes as they happen. The
 * default is the feed poller, which is ALSO the permanent fallback: a socket
 * that is down must degrade to a slower refresh, never to a stale page.
 *
 * Returns its own unsubscribe. Never throws — a failing poll is a missed
 * refresh, not a broken database view.
 */
export type LiveSubscribe = (type: string, onChange: () => void) => () => void;

/** Feed sequence numbers are bigints on the wire (decimal strings). Compare
 *  them as numbers-in-strings so a 2^53 crossing cannot silently mis-order. */
export function seqGreater(a: string, b: string): boolean {
  const x = a.replace(/^0+/, "");
  const y = b.replace(/^0+/, "");
  if (!/^\d+$/.test(x) || !/^\d+$/.test(y)) return a !== b;
  if (x.length !== y.length) return x.length > y.length;
  return x > y;
}

export function maxSeq(events: FeedEvent[]): string | null {
  let max: string | null = null;
  for (const e of events) {
    if (typeof e.seq !== "string" || e.seq === "") continue;
    if (max === null || seqGreater(e.seq, max)) max = e.seq;
  }
  return max;
}

/**
 * Does anything newer than `since` concern this database?
 *
 * Two ways in: the event targets an object OF this type (a create, an edit, a
 * delete), or it targets an object we are CURRENTLY SHOWING — which is how a
 * row that was retyped or deleted out of this view still triggers the refresh
 * that removes it.
 */
export function feedTouchesType(
  events: FeedEvent[],
  type: string,
  since: string | null,
  rowIds: ReadonlySet<string>,
): boolean {
  return events.some((e) => {
    if (since !== null && !seqGreater(e.seq, since)) return false;
    if (e.target_type === type) return true;
    return e.target !== null && rowIds.has(e.target);
  });
}

/** The default live source: poll the feed, skip hidden tabs, never overlap. */
function feedLiveSource(rowIdsRef: { current: ReadonlySet<string> }): LiveSubscribe {
  return (type, onChange) => {
    if (isDemo()) return () => undefined;
    let since: string | null = null;
    let stopped = false;
    let inFlight = false;

    const tick = async () => {
      if (stopped || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const events = await api.feed(LIVE_FEED_LIMIT);
        if (stopped) return;
        const top = maxSeq(events);
        // The first poll only establishes a baseline — everything in the feed
        // predates this mount, and refreshing on it would double every load.
        if (since !== null && feedTouchesType(events, type, since, rowIdsRef.current)) onChange();
        if (top !== null && (since === null || seqGreater(top, since))) since = top;
        else if (since === null) since = "0";
      } catch {
        // A failed poll is a missed refresh; the next tick tries again.
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const handle = setInterval(() => void tick(), LIVE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  };
}

/* --------------------------------------------------------------- new-row props */

/**
 * The properties a new row must carry to be visible in the view that created
 * it. Filtering a board to `status is open` and pressing New has exactly one
 * sane meaning: a row with `status = open`.
 *
 * Only `eq` on a real property of this type qualifies — `ne`/`gt`/`ilike` imply
 * a range, not a value; spine columns (title, updated_at) are not props; refs
 * are links, which a create cannot make. Two `eq`s on the same property are a
 * contradiction the UI allows to be typed: the first one wins, and the row
 * simply will not match the second.
 */
export function filterDefaults(
  filters: readonly Filter[],
  propDefs: readonly PropDef[],
): Record<string, ScalarValue> {
  const byName = new Map(propDefs.filter((p) => !p.deprecated).map((p) => [p.name, p] as const));
  const out: Record<string, ScalarValue> = {};
  for (const f of filters) {
    if (f.op !== "eq") continue;
    const def = byName.get(f.prop);
    if (!def || REF_KINDS.includes(def.kind)) continue;
    const v = f.value;
    if (v === null || v === undefined || Array.isArray(v)) continue;
    if (f.prop in out) continue;
    out[f.prop] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ prop names */

/**
 * A property name as a member reads it. The operator vocabulary that used to
 * live beside this — which ops a kind offers, what a chip says — belongs to
 * `components/views/FilterBar` now, and to exactly one place: the shell drew
 * its own filter popover before the builder existed, and two implementations of
 * "which operators does `ref[]` accept" is precisely how a UI starts sending
 * clauses the query AST refuses.
 */
export function humanProp(name: string): string {
  return name.replace(/_/g, " ");
}

/* ------------------------------------------------------------------- the shell */

interface TypeViewProps {
  user: Whoami;
  /**
   * Layout components by name. Merged OVER the built-ins, so a host (or a test)
   * can supply one layout without restating the other three.
   */
  layouts?: Partial<Record<Layout, LayoutComponent>>;
  /** Extra toolbar content, rendered in the shared toolbar's right-hand slot
   *  (presence avatars once the route-level rail lands). */
  toolbarSlot?: ReactNode;
  /** Live-change subscription; defaults to the feed poller. */
  live?: LiveSubscribe;
}

export function TypeView({ user, layouts, toolbarSlot, live }: TypeViewProps) {
  const { type = "" } = useParams();
  const { openPeek } = usePeek();
  const [searchParams] = useSearchParams();
  const isMobile = useIsMobile();

  // Arriving with `?view=<id>` — a pinned view clicked in the sidebar — means a
  // SAVED config is authoritative for this page load, and <SavedViews> will
  // apply it as soon as the list lands. Seeding from the localStorage working
  // cache in that case is a race we would sometimes lose: whichever of the two
  // fetches answered last would win. Read through a ref so picking a view later
  // (which sets the same param) does not re-run the catalog effect and throw
  // the member's config away.
  const viewParamRef = useRef<string | null>(null);
  viewParamRef.current = searchParams.get("view");

  const [def, setDef] = useState<TypeSummary | null>(null);
  const [config, setConfig] = useState<ViewConfig>(() => defaultConfigFor(null));
  // Until the catalog answers we do not know this type's defaults, so nothing
  // is fetched and nothing is persisted — a config written before then would
  // overwrite the member's saved one with an empty shell.
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<ListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [trash, setTrash] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // A FRESH load that failed (most often a hiccup while the box self-updates) is
  // NOT an empty database — keep the two apart so the body offers a retry rather
  // than "no objects here yet", which would tell the member a populated database
  // is empty and invite them to start over.
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);

  const canWrite = user.role !== "viewer" && !isDemo();

  useEffect(() => {
    setDef(null);
    setReady(false);
    setConfig(defaultConfigFor(null));
    setRows(null);
    setCursor(null);
    setTrash(false);
    setNotice(null);
    let alive = true;
    api
      .types()
      .then((ts) => {
        if (!alive) return;
        registerTypeIcons(ts);
        const d = ts.find((t) => t.name === type) ?? null;
        setDef(d);
        setConfig(
          viewParamRef.current
            ? defaultConfigFor(d)
            : readViewConfig(user.id, type, defaultConfigFor(d)),
        );
        setReady(true);
      })
      .catch((e) => {
        console.error(e);
        if (!alive) return;
        // The catalog is a nicety for the toolbar; the rows are the page. Fall
        // back to type-less defaults rather than showing nothing at all.
        setConfig(
          viewParamRef.current
            ? defaultConfigFor(null)
            : readViewConfig(user.id, type, defaultConfigFor(null)),
        );
        setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [type, user.id]);

  useEffect(() => {
    if (!ready) return;
    writeViewConfig(user.id, type, config);
  }, [ready, user.id, type, config]);

  const propDefs = useMemo(() => (def?.properties ?? []).filter((p) => !p.deprecated), [def]);
  // Grouping is asked of the SAME function the bar's picker offers, so "the
  // Board button is enabled" and "the picker has something in it" can never
  // disagree — a board enabled against an axis the bar refuses to offer is a
  // dead end the member cannot get out of.
  const groupable = useMemo(() => groupableProps(propDefs), [propDefs]);
  const dateProps = useMemo(
    () => propDefs.filter((p) => p.kind === "date" || p.kind === "timestamp"),
    [propDefs],
  );

  // The compiled query IS the fetch identity: two configs that compile to the
  // same wire payload are the same request, so a column resize never refetches
  // and a changed filter always does.
  const queryKey = useMemo(() => JSON.stringify(toListQuery(config)), [config]);
  const query = useMemo(() => JSON.parse(queryKey) as ReturnType<typeof toListQuery>, [queryKey]);
  const pageLimit = config.layout === "table" ? PAGE : BULK_LIMIT;

  // Every in-flight load carries a generation; a response from a superseded
  // query (filter changed while it was out) is dropped rather than rendered.
  const loadGen = useRef(0);
  const rowIdsRef = useRef<ReadonlySet<string>>(new Set<string>());
  rowIdsRef.current = useMemo(() => new Set((rows ?? []).map((r) => r.id)), [rows]);

  const load = useCallback(
    (limit: number, opts: { keepRows?: boolean } = {}) => {
      const gen = (loadGen.current += 1);
      if (!opts.keepRows) {
        setRows(null);
        setLoadError(false);
      }
      api
        .list(type, {
          limit,
          ...query,
          ...(trash ? { deleted: true } : {}),
        })
        .then((r) => {
          if (gen !== loadGen.current) return;
          setRows(r.items);
          setCursor(r.nextCursor);
          setTruncated(r.nextCursor !== null && limit >= BULK_LIMIT);
          setLoadError(false);
        })
        .catch((e) => {
          if (gen !== loadGen.current) return;
          console.error(e);
          setCursor(null);
          if (opts.keepRows) {
            // A background refresh (a live change) failed: keep what is on screen
            // and just say the refresh did not land.
            setNotice("Could not refresh these rows. Try again in a moment.");
          } else {
            // A fresh load failed: leave `rows` null (NOT []) so the empty-state
            // copy never fires, and render a retryable error instead.
            setLoadError(true);
          }
        });
    },
    [type, query, trash],
  );

  useEffect(() => {
    if (!ready) return;
    load(pageLimit);
  }, [ready, load, pageLimit]);

  /** A live change: re-read the window the member is actually looking at,
   *  including pages they loaded, and keep the old rows on screen while it
   *  flies so the page does not blink. */
  const refresh = useCallback(() => {
    const loaded = rowIdsRef.current.size;
    load(Math.min(Math.max(loaded, pageLimit), MAX_WINDOW), { keepRows: true });
  }, [load, pageLimit]);

  // The subscription outlives any one query: it is re-armed only when the TYPE
  // (or the source) changes, so changing a filter does not reset the live
  // stream's baseline and cost an extra poll.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const subscribe = useMemo(() => live ?? feedLiveSource(rowIdsRef), [live]);
  useEffect(() => {
    if (!ready || !type) return;
    return subscribe(type, () => refreshRef.current());
  }, [ready, type, subscribe]);

  const loadMore = () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const gen = loadGen.current;
    api
      .list(type, {
        limit: PAGE,
        cursor,
        ...query,
        ...(trash ? { deleted: true } : {}),
      })
      .then((r) => {
        if (gen !== loadGen.current) return;
        setRows((prev) => [...(prev ?? []), ...r.items]);
        setCursor(r.nextCursor);
      })
      .catch(console.error)
      .finally(() => setLoadingMore(false));
  };

  /** Re-read one row after a write we could not trust, and drop it if it is
   *  gone (deleted, retyped, or no longer ours to read). */
  const rereadRow = useCallback(async (id: string) => {
    try {
      const o = await api.object(id);
      setRows((prev) =>
        prev
          ? prev.map((r) =>
              r.id === id
                ? {
                    ...r,
                    title: o.title,
                    version: o.version,
                    visibility: o.visibility,
                    updated_at: o.updated_at,
                    props: o.props,
                  }
                : r,
            )
          : prev,
      );
    } catch {
      setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    }
  }, []);

  const onPatch = useCallback(
    async (id: string, baseVersion: number, fields: PatchFields) => {
      if (!canWrite) {
        setNotice("You have read-only access to this brain.");
        return;
      }
      setNotice(null);
      try {
        const r = await api.patchObject(id, { baseVersion, ...fields });
        setRows((prev) =>
          prev
            ? prev.map((row) => (row.id === id ? applyFields(row, fields, r.version) : row))
            : prev,
        );
      } catch (e) {
        if (e instanceof ConflictError) {
          // Never clobber: the write did not land, so show what did.
          setNotice("Someone else changed that row first — reloaded it.");
        } else if (e instanceof ApiError && e.status === 404) {
          setNotice("That row is gone.");
        } else {
          setNotice(e instanceof Error ? e.message : "That change did not save.");
        }
        await rereadRow(id);
      }
    },
    [canWrite, rereadRow],
  );

  // One idempotency key per New-row INTENT, kept across retries of that intent
  // and minted fresh once it lands — a lost response must never become two rows.
  const createKey = useRef<string | null>(null);
  const createRow = async () => {
    if (!canWrite || creating || !type) return;
    if (!createKey.current) createKey.current = newIdempotencyKey();
    setCreating(true);
    setNotice(null);
    try {
      const props = filterDefaults(config.filters, propDefs);
      await api.createObject({
        type,
        idempotencyKey: createKey.current,
        ...(Object.keys(props).length > 0 ? { props } : {}),
      });
      createKey.current = null;
      refresh();
    } catch (e) {
      // Keep the key: pressing New again retries the SAME intent.
      setNotice(e instanceof Error ? e.message : "Could not add a row.");
    } finally {
      setCreating(false);
    }
  };

  // A row click PEEKS: the object opens in the slide-over over this table, so
  // the filters, the paging and the scroll position all survive being read.
  // "Open full page" inside the panel is the way to the route.
  const onOpen = useCallback((id: string) => openPeek(id), [openPeek]);

  const registry = useMemo(() => ({ ...BUILTIN_LAYOUTS, ...(layouts ?? {}) }), [layouts]);
  const boardReady = config.groupBy !== null || groupable.length > 0;
  const calendarReady = config.dateProp !== null;
  // A layout the type cannot support (a board with nothing to group by) falls
  // back to the table rather than rendering an empty frame.
  const layoutName: Layout =
    (config.layout === "board" && !boardReady) || (config.layout === "calendar" && !calendarReady)
      ? "table"
      : config.layout;
  const LayoutView = registry[layoutName] ?? BUILTIN_LAYOUTS.table;

  const setLayout = (next: Layout) => {
    setConfig((c) => {
      if (next === "board" && c.groupBy === null && groupable[0]) {
        return { ...c, layout: next, groupBy: groupable[0].name };
      }
      if (next === "calendar" && c.dateProp === null && dateProps[0]) {
        return { ...c, layout: next, dateProp: dateProps[0].name };
      }
      return { ...c, layout: next };
    });
  };

  // What Reset returns to. Derived from the live catalog rather than the
  // current config, so "default" means the type's default and not "whatever it
  // happened to be when the page loaded".
  const defaults = useMemo(() => defaultConfigFor(def), [def]);

  return (
    <div className="flex min-h-full flex-col">
      <header className={`border-b border-line-soft pb-4 ${isMobile ? "px-4 pt-4" : "px-8 pt-7"}`}>
        <div className="flex items-baseline gap-3">
          <h1 className="flex items-center gap-2.5 text-[21px] font-[650] tracking-[-0.02em]">
            <TypeIcon icon={def?.icon} type={type} size={20} />
            {def ? typeLabel(def) : typeName(type)}
          </h1>
          {def && (
            <span className="text-[13px] text-dim">
              {fmtNumber(def.count)} object{def.count === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {def?.description && <p className="mt-1.5 text-[13.5px] text-mut">{def.description}</p>}
        {/* The schema strip is a chip per property — on a phone that is a wall
            of chrome above the rows people came for. The same facts are one tap
            away in any object's props panel. */}
        {def && !isMobile && <SchemaStrip def={def} />}

        {/* The one toolbar every layout shares: switcher · layout axis · filters
            · trash · New. A layout draws none of this itself. */}
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-none border border-line-soft">
            <LayoutButton
              layout="table"
              active={layoutName === "table"}
              onPick={setLayout}
              icon={<Rows3 aria-hidden />}
              label="Table"
              compact={isMobile}
            />
            <LayoutButton
              layout="board"
              active={layoutName === "board"}
              onPick={setLayout}
              icon={<Columns3 aria-hidden />}
              label="Board"
              compact={isMobile}
              disabled={!boardReady}
              title={boardReady ? "" : "Board needs an enum property to group by"}
            />
            <LayoutButton
              layout="gallery"
              active={layoutName === "gallery"}
              onPick={setLayout}
              icon={<LayoutGrid aria-hidden />}
              label="Gallery"
              compact={isMobile}
            />
            <LayoutButton
              layout="calendar"
              active={layoutName === "calendar"}
              onPick={setLayout}
              icon={<CalendarDays aria-hidden />}
              label="Calendar"
              compact={isMobile}
              disabled={!calendarReady}
              title={calendarReady ? "" : "Calendar needs a date property"}
            />
          </div>

          {layoutName === "calendar" && dateProps.length > 0 && (
            <Select
              value={config.dateProp ?? ""}
              onValueChange={(v) => v && setConfig((c) => ({ ...c, dateProp: v }))}
            >
              <SelectTrigger size="sm" className="w-[170px]">
                <span className="text-dim">on</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dateProps.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {humanProp(p.name)}
                  </SelectItem>
                ))}
                <SelectItem value="updated_at">updated</SelectItem>
              </SelectContent>
            </Select>
          )}

          <div className="mx-1 h-4 w-px bg-line-soft" aria-hidden />

          {/* Filters · sort · grouping · columns, for every layout, from the one
              builder. It edits the shared `ViewConfig` and hands back a WHOLE
              next config; the shell just stores it, which is why a filter built
              on the board is the same filter the table shows. */}
          <FilterBar
            propDefs={propDefs}
            config={config}
            onChange={setConfig}
            defaults={defaults}
            // Grouping is a board's axis; on a table/gallery/calendar the picker
            // would edit a setting nothing on screen reads.
            showGroupBy={layoutName === "board"}
            // The table draws its OWN column menu (it also owns widths and a
            // reset); a second one in the toolbar would be two controls for one
            // setting. The calendar has no columns at all.
            showColumns={layoutName === "board" || layoutName === "gallery"}
          />

          {/* Saved views: the same config the bar edits, captured under a name
              and pinnable to this member's sidebar. The config crosses as an
              opaque record — the component is shared with phase 6's graph views
              — so what comes back is normalized here, against THIS type's
              defaults, exactly as a config read out of localStorage is. */}
          <SavedViews
            accountId={user.id}
            scope={type}
            config={config as unknown as Record<string, unknown>}
            nameBase={`${def ? typeLabel(def) : typeName(type)} view`}
            onApply={(raw) => setConfig(normalizeConfig(raw, defaults))}
          />

          <div className="ml-auto flex items-center gap-2">
            {toolbarSlot}
            <Button
              variant={trash ? "destructive" : "ghost"}
              size="sm"
              className={trash ? "" : "text-dim"}
              onClick={() => setTrash((t) => !t)}
              title="Soft-deleted objects are kept forever — nothing is ever purged"
            >
              <Trash2 aria-hidden /> {trash ? "Viewing trash" : "Trash"}
            </Button>
            {canWrite && !trash && (
              <Button size="sm" onClick={() => void createRow()} disabled={creating}>
                <Plus aria-hidden /> {creating ? "Adding…" : "New"}
              </Button>
            )}
          </div>
        </div>

        {notice && (
          <div className="mt-3 flex items-center gap-2 rounded-none border border-line-soft bg-hover px-3 py-2 text-[12.5px] text-mut">
            <span className="flex-1">{notice}</span>
            <button
              onClick={() => setNotice(null)}
              className="cursor-pointer text-dim hover:text-mut"
              aria-label="dismiss"
            >
              <X size={12} aria-hidden />
            </button>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1">
        {/* The placeholder is the shape of what is coming: a table skeleton
            becomes a table, so the page settles instead of re-laying out. */}
        {!rows && !loadError && <Spinner variant={SKELETON_FOR[layoutName]} />}
        {!rows && loadError && (
          <div className={isMobile ? "p-4" : "p-8"}>
            <Empty
              action={
                <Button variant="outline" size="sm" onClick={() => load(pageLimit)}>
                  Try again
                </Button>
              }
            >
              Couldn't load these rows — a hiccup, most likely while the box reconnects. They're
              still here.
            </Empty>
          </div>
        )}
        {rows && rows.length === 0 && (
          <div className={isMobile ? "p-4" : "p-8"}>
            <Empty
              // Only offer the keystroke where it actually works: a viewer and
              // the trash have nothing to create into.
              {...(canWrite && !trash && config.filters.length === 0
                ? { hint: <CreateHint what={`a ${typeName(type)}`} /> }
                : {})}
            >
              {trash
                ? "The trash is empty — nothing of this type has been deleted."
                : config.filters.length > 0
                  ? "Nothing matches these filters. Drop one to widen the view — the objects are still there."
                  : `No ${typeName(type)} objects here yet — they'll appear as the brain learns them.`}
            </Empty>
          </div>
        )}

        {rows && rows.length > 0 && (
          <>
            {truncated && (
              <div
                className={`mt-4 rounded-none border border-line-soft bg-hover px-3.5 py-2.5 text-[12.5px] text-mut ${
                  isMobile ? "mx-4" : "mx-8"
                }`}
              >
                Showing the {BULK_LIMIT} most recently updated objects — counts are partial. Narrow
                with filters to see everything.
              </div>
            )}
            <LayoutView
              rows={rows}
              propDefs={propDefs}
              config={config}
              onConfigChange={setConfig}
              onPatch={onPatch}
              onOpen={onOpen}
              readOnly={!canWrite}
              // Absent, not disabled, when there is nothing to create INTO: a
              // viewer, or the trash. `exactOptionalPropertyTypes` means the
              // key has to be missing, not `undefined`.
              {...(canWrite && !trash ? { onCreate: () => void createRow() } : {})}
              creating={creating}
            />
            {layoutName === "table" && cursor && (
              <div className={`py-4 ${isMobile ? "px-4" : "px-8"}`}>
                <Button
                  variant="outline"
                  size="sm"
                  className="touch-target"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Fold a patch we just made into the row we are showing. `null` inside `props`
 *  deletes that key — mirroring the server — and every other key is left alone,
 *  so a disjoint edit by someone else survives our render. */
export function applyFields(row: ListItem, fields: PatchFields, version: number): ListItem {
  const next: ListItem = { ...row, version };
  if (fields.title !== undefined) next.title = fields.title;
  if (fields.visibility !== undefined) next.visibility = fields.visibility;
  if (fields.props) {
    const props = { ...(row.props ?? {}) };
    for (const [k, v] of Object.entries(fields.props)) {
      if (v === null) delete props[k];
      else props[k] = v;
    }
    next.props = props;
  }
  return next;
}

function LayoutButton({
  layout,
  active,
  onPick,
  icon,
  label,
  disabled,
  title,
  compact = false,
}: {
  layout: Layout;
  active: boolean;
  onPick: (l: Layout) => void;
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
  /** Icon only — four labelled buttons do not fit across a phone. The name
   *  survives as the accessible name, so nothing is lost to a screen reader. */
  compact?: boolean;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className={`touch-target rounded-none ${compact ? "px-3" : ""}`}
      onClick={() => onPick(layout)}
      disabled={disabled ?? false}
      title={title || label}
      aria-pressed={active}
      {...(compact ? { "aria-label": label } : {})}
    >
      {icon} {compact ? null : label}
    </Button>
  );
}

/* ------------------------------------------------------------------- layouts */

/**
 * The four layouts, resolved by name — and the ONLY place they are named. A
 * host (or a test) that wants a different one passes `layouts`, which is merged
 * over this map; nothing else in the shell knows a layout's module.
 *
 * Each of them imports a few helpers back out of this file (`LayoutProps`,
 * `CellValue`, `rowVersion`, `visibleColumns`), so these four edges are import
 * cycles. They are sound because every binding crossing them is a HOISTED
 * FUNCTION DECLARATION, initialized before either module's body runs and only
 * called during render — long after both have finished evaluating. Keep it that
 * way: turning `CellValue` or `rowVersion` into a `const` arrow function would
 * turn a safe cycle into a temporal-dead-zone crash on whichever module the
 * bundler happens to enter first.
 */
export const BUILTIN_LAYOUTS: Record<Layout, LayoutComponent> = {
  table: TableLayout,
  board: BoardLayout,
  gallery: GalleryLayout,
  calendar: CalendarLayout,
};

/** Columns the config says to show, resolved against the live catalog (a saved
 *  config can name a property that has since been deprecated or dropped). */
export function visibleColumns(config: ViewConfig, propDefs: PropDef[]): PropDef[] {
  const byName = new Map(propDefs.map((p) => [p.name, p] as const));
  const chosen = config.columns
    .filter((c) => c.visible)
    .map((c) => byName.get(c.key))
    .filter((p): p is PropDef => p !== undefined && !REF_KINDS.includes(p.kind));
  if (chosen.length > 0) return chosen;
  return propDefs.filter((p) => !REF_KINDS.includes(p.kind)).slice(0, 6);
}

/* ------------------------------------------------------------------- pieces */

/** The type's shape at a glance: one chip per property, kind-annotated, so a
 *  page communicates its schema without opening an object. Refs point at the
 *  type they link to; enums show how many values they range over. */
function SchemaStrip({ def }: { def: TypeSummary }) {
  const props = def.properties.filter((p) => !p.deprecated);
  if (props.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {props.map((p) => {
        // Only annotate with something the reader controls or navigates by: how
        // many options an enum ranges over, or which database a link points at.
        // The raw storage kind ("int", "text", "date") is implementation
        // language — it is dropped, so a scalar shows just its human name.
        const detail =
          p.kind === "enum"
            ? `${p.enum_values?.length ?? 0} values`
            : (p.kind === "ref" || p.kind === "ref[]") && p.ref_type
              ? `→ ${typeName(p.ref_type)}`
              : null;
        return (
          <span
            key={p.name}
            className="inline-flex items-center gap-1 rounded-none border border-line-soft bg-hover px-2 py-0.5 text-[11.5px]"
            title={
              p.kind === "enum" && p.enum_values?.length
                ? `${humanProp(p.name)}: ${p.enum_values.join(" · ")}`
                : humanProp(p.name)
            }
          >
            <span className="font-[550] text-mut">{humanProp(p.name)}</span>
            {p.required && <span className="text-destructive">*</span>}
            {detail && <span className="font-mono text-[10px] text-dim">{detail}</span>}
          </span>
        );
      })}
    </div>
  );
}

export function CellValue({ kind, value }: { kind: string; value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-dim">—</span>;
  }
  if (kind === "enum") return <EnumPill value={String(value)} />;
  if (kind === "bool") return <span>{value ? "yes" : "no"}</span>;
  if (kind === "int" || kind === "decimal" || kind === "float") {
    return <span className="font-mono text-[12.5px]">{fmtNumber(String(value))}</span>;
  }
  if (kind === "date" || kind === "timestamp") return <span>{fmtDate(String(value))}</span>;
  return <span className="block max-w-[260px] truncate">{String(value)}</span>;
}
