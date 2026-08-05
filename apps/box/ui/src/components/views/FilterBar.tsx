/**
 * The view-config builder — filters, sort keys, grouping, columns, reset.
 *
 * One bar serves every layout (table, board, gallery, calendar) because the
 * thing it edits is the SHARED `ViewConfig` from `lib/viewConfig`, not any
 * layout's private state. Three rules hold it together:
 *
 *  1. **It never mutates.** Every control emits a whole new `ViewConfig`
 *     through `onChange`. The bar keeps no copy of the config — the host owns
 *     it, persists it, and re-renders us with it — so a rejected or
 *     externally-changed config can never leave a stale chip on screen.
 *  2. **It only offers what the server accepts.** The operator menu is derived
 *     from the property's kind against `query-ast.ts`'s real whitelist: `ref[]`
 *     takes only `eq`/`in` (it compiles to an EXISTS over edges — presence and
 *     comparison ops are refused), `bool` values are booleans not strings,
 *     numbers are numbers. A filter this bar can build is a filter the box can
 *     run; the UI never invents a dialect the query AST will 400 on.
 *  3. **Only the first sort key reaches the server** (`toListQuery` sends one
 *     `SortSpec` — keyset pagination is `(sort_col, id)`, so a second column
 *     would break the cursor). The bar says so out loud rather than pretending
 *     a three-key sort is server-side, and later keys stay in the config for
 *     layouts that refine the loaded rows locally.
 *
 * Two deliberate non-features:
 *
 *  - **"In the last N days" is materialized, not rolling.** The whitelist has
 *    no relative-date operator, so the preset fills a concrete date into a
 *    `>=` filter. A saved view therefore keeps the date it was built with; it
 *    does not silently follow the clock, and the chip shows the real date so
 *    nobody is misled about which it is.
 *  - **A filter value can be brain content** (an object id, a private title).
 *    Nothing here logs, copies or transmits a value on its own — it goes into
 *    the config the host persists per account, and `viewConfig`'s purge rules
 *    are what keep it from outliving the session.
 *
 * Styling stays on the semantic tokens (`text-dim`, `border-line-soft`,
 * `bg-hover`) so the bar is correct in both skins without a single hardcoded
 * colour, and every control is a real button/input/menu item — the whole bar is
 * reachable with Tab and operable with Enter/Space/arrows.
 */
import { useMemo, useState, type ReactElement } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Columns3,
  Layers,
  ListFilter,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";

import type { PropDef } from "../../lib/api";
import type { Filter, FilterOp, ScalarValue, Sort, ViewConfig } from "../../lib/viewConfig";
import { fmtDate } from "../../lib/ui";
import { useIsMobile } from "../../lib/mobile";
import { BottomSheet } from "../BottomSheet";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";

/* ------------------------------------------------------------------ kinds */

const REF_KINDS: readonly string[] = ["ref", "ref[]"];
const NUMBER_KINDS: readonly string[] = ["int", "decimal", "float"];
const DATE_KINDS: readonly string[] = ["date", "timestamp"];
const VALUELESS_OPS: readonly FilterOp[] = ["is_null", "is_not_null"];

/** Mirrors `viewConfig`'s own ceiling: an enum with more values than this is a
 *  tag soup, not a grouping axis. */
const MAX_GROUP_VALUES = 12;

/** Spine columns the reader exposes to where/sort alongside a type's own
 *  properties (`baseResolver` in packages/mcp-tools/src/reader.ts). `id` and
 *  `version` are filterable too but are noise in a picker — a member filters
 *  by title and by when a row moved, not by row version. */
const SPINE_PROPS: readonly PropDef[] = [
  { name: "title", kind: "text", required: false, deprecated: false },
  { name: "created_at", kind: "timestamp", required: false, deprecated: false },
  { name: "updated_at", kind: "timestamp", required: false, deprecated: false },
];

interface OpChoice {
  op: FilterOp;
  label: string;
}

/** Offered for every kind whose column can actually be NULL-tested. NOT for
 *  `ref[]`, which has no column at all. */
const PRESENCE_OPS: readonly OpChoice[] = [
  { op: "is_null", label: "is empty" },
  { op: "is_not_null", label: "is not empty" },
];

const NUM_OPS: readonly OpChoice[] = [
  { op: "eq", label: "=" },
  { op: "ne", label: "≠" },
  { op: "gt", label: ">" },
  { op: "gte", label: "≥" },
  { op: "lt", label: "<" },
  { op: "lte", label: "≤" },
];

const DATE_OPS: readonly OpChoice[] = [
  { op: "gte", label: "on or after" },
  { op: "lte", label: "on or before" },
  { op: "eq", label: "on" },
];

const TEXT_OPS: readonly OpChoice[] = [
  { op: "ilike", label: "contains" },
  { op: "eq", label: "is" },
  { op: "ne", label: "is not" },
];

const ENUM_OPS: readonly OpChoice[] = [
  { op: "eq", label: "is" },
  { op: "ne", label: "is not" },
  { op: "in", label: "is any of" },
];

/**
 * The operators a kind really supports, in the order a member reaches for
 * them. Every entry exists in `FilterOp` (which mirrors the server whitelist),
 * and every kind's list is what `compileWhere` will actually run:
 *
 *  - `ref[]` compiles to an EXISTS over manual edges and accepts ONLY `eq`
 *    (one id) and `in` (ids) — `ne`/`is_null` on it are a validation error, so
 *    they are not offered;
 *  - `bool` takes a real boolean, so no `contains`;
 *  - an unknown kind returns [] — not filterable rather than a guess that 400s.
 */
export function opsForKind(kind: string): readonly OpChoice[] {
  if (kind === "enum") return [...ENUM_OPS, ...PRESENCE_OPS];
  if (kind === "text" || kind === "id") return [...TEXT_OPS, ...PRESENCE_OPS];
  if (NUMBER_KINDS.includes(kind)) return [...NUM_OPS, ...PRESENCE_OPS];
  if (DATE_KINDS.includes(kind)) return [...DATE_OPS, ...PRESENCE_OPS];
  if (kind === "bool") return [{ op: "eq", label: "is" }, ...PRESENCE_OPS];
  if (kind === "ref") {
    return [{ op: "eq", label: "is" }, { op: "ne", label: "is not" }, ...PRESENCE_OPS];
  }
  if (kind === "ref[]") {
    return [
      { op: "eq", label: "includes" },
      { op: "in", label: "includes any of" },
    ];
  }
  return [];
}

/** Read when a filter names a property the catalog no longer knows (a saved
 *  view, a deprecated prop) — the chip still has to say something true. */
const GENERIC_OP_LABELS: Record<FilterOp, string> = {
  eq: "is",
  ne: "is not",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  like: "contains",
  ilike: "contains",
  in: "is any of",
  is_null: "is empty",
  is_not_null: "is not empty",
};

function humanProp(name: string): string {
  return name.replace(/_/g, " ");
}

/* ------------------------------------------------------- property universes */

function living(propDefs: readonly PropDef[]): PropDef[] {
  return propDefs.filter((p) => !p.deprecated);
}

/** A type's own name always wins over the spine entry of the same name — the
 *  catalog resolves the property, so a picker that offered both would let a
 *  member choose the one the server will not use. */
function withSpine(own: PropDef[]): PropDef[] {
  const taken = new Set(own.map((p) => p.name));
  return [...own, ...SPINE_PROPS.filter((p) => !taken.has(p.name))];
}

/** Everything a filter can be built on: living props with a real operator set,
 *  plus the spine. */
export function filterableProps(propDefs: readonly PropDef[]): PropDef[] {
  return withSpine(living(propDefs).filter((p) => opsForKind(p.kind).length > 0));
}

/** Everything ORDER BY can take. `ref[]` is a list — the server refuses it
 *  ("it has no single value to sort by"), so it never reaches the picker. */
export function sortableProps(propDefs: readonly PropDef[]): PropDef[] {
  return withSpine(living(propDefs).filter((p) => p.kind !== "ref[]"));
}

/**
 * Properties a board (or a grouped table) can use as its axis: a declared enum
 * with at most `MAX_GROUP_VALUES` values, or a yes/no. Free text and ids are
 * excluded on purpose — grouping by them makes one column per row.
 */
export function groupableProps(propDefs: readonly PropDef[]): PropDef[] {
  return living(propDefs).filter(
    (p) =>
      (p.kind === "enum" &&
        Array.isArray(p.enum_values) &&
        p.enum_values.length > 0 &&
        p.enum_values.length <= MAX_GROUP_VALUES) ||
      p.kind === "bool",
  );
}

interface ColumnEntry {
  key: string;
  label: string;
  visible: boolean;
}

/**
 * The column menu's rows: the saved order first (dead keys dropped — a config
 * can name a property that has since been deprecated), then any property added
 * to the type since the config was saved, hidden until asked for.
 *
 * Refs are not columns (the row's link affordances carry those), matching the
 * table layout's own `visibleColumns`.
 */
export function columnEntries(config: ViewConfig, propDefs: readonly PropDef[]): ColumnEntry[] {
  const live = living(propDefs).filter((p) => !REF_KINDS.includes(p.kind));
  const byName = new Map(live.map((p) => [p.name, p] as const));
  const seen = new Set<string>();
  const out: ColumnEntry[] = [];
  for (const c of config.columns) {
    if (!byName.has(c.key) || seen.has(c.key)) continue;
    seen.add(c.key);
    out.push({ key: c.key, label: humanProp(c.key), visible: c.visible });
  }
  for (const p of live) {
    if (seen.has(p.name)) continue;
    out.push({ key: p.name, label: humanProp(p.name), visible: false });
  }
  return out;
}

/* --------------------------------------------------------------- chip label */

function displayValue(kind: string, v: ScalarValue): string {
  if (v === null) return "empty";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (DATE_KINDS.includes(kind) && typeof v === "string") return fmtDate(v);
  return String(v);
}

/**
 * What a chip says. Pure, so the visible text and the remove button's
 * accessible name can never disagree. The operator reads in the property's own
 * kind ("status is open", not "status eq open"); `%` wrappers a member never
 * typed are not shown back to them.
 */
export function filterChipLabel(f: Filter, propDefs: readonly PropDef[] = []): string {
  const kind = filterableProps(propDefs).find((p) => p.name === f.prop)?.kind ?? "";
  const verb =
    opsForKind(kind).find((o) => o.op === f.op)?.label ?? GENERIC_OP_LABELS[f.op] ?? f.op;
  const name = humanProp(f.prop);
  if (VALUELESS_OPS.includes(f.op)) return `${name} ${verb}`;
  const raw = Array.isArray(f.value)
    ? f.value.map((v) => displayValue(kind, v)).join(", ")
    : displayValue(kind, (f.value ?? null) as ScalarValue);
  return `${name} ${verb} ${raw}`;
}

/* ------------------------------------------------------------ value coercion */

/** Comma-separated ids/values for the multi-value ops that have no picker. */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build the `Filter` a draft describes, or `null` when the draft is not yet a
 * filter (no value, an unparseable number, an empty any-of). Returning null
 * rather than a half-filter is what keeps a malformed clause off the wire:
 * "Add" stays disabled until this returns something.
 *
 * `values` carries the enum multi-select; `text` carries every single-value
 * editor. Numbers become numbers and booleans become booleans because
 * `checkValueKind` rejects a string in either position.
 */
export function buildFilter(
  prop: PropDef,
  op: FilterOp,
  draft: { text: string; values: readonly string[] },
): Filter | null {
  if (VALUELESS_OPS.includes(op)) return { prop: prop.name, op };
  if (op === "in") {
    const values = prop.kind === "enum" ? [...draft.values] : splitList(draft.text);
    if (values.length === 0) return null;
    return { prop: prop.name, op, value: values };
  }
  const text = draft.text.trim();
  if (text === "") return null;
  if (NUMBER_KINDS.includes(prop.kind)) {
    const n = Number(text);
    if (!Number.isFinite(n)) return null;
    return { prop: prop.name, op, value: n };
  }
  if (prop.kind === "bool") return { prop: prop.name, op, value: text === "true" };
  return { prop: prop.name, op, value: text };
}

/**
 * The date `N` days back, as the `YYYY-MM-DD` a date input holds. Day
 * granularity for timestamps too: "in the last 7 days" is a human span, and a
 * to-the-second boundary would make the same saved view answer differently
 * every time it loads.
 */
export function relativeSince(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const SINCE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

/* ------------------------------------------------------------------ reducers */

export function withFilterAt(config: ViewConfig, index: number | null, f: Filter): ViewConfig {
  const filters =
    index === null ? [...config.filters, f] : config.filters.map((x, i) => (i === index ? f : x));
  return { ...config, filters };
}

export function withoutFilterAt(config: ViewConfig, index: number): ViewConfig {
  return { ...config, filters: config.filters.filter((_, i) => i !== index) };
}

function withSortPropAt(config: ViewConfig, index: number, prop: string): ViewConfig {
  return {
    ...config,
    sort: config.sort.map((s, i) => (i === index ? { ...s, prop } : s)),
  };
}

export function withSortDirAt(config: ViewConfig, index: number, dir: Sort["dir"]): ViewConfig {
  return { ...config, sort: config.sort.map((s, i) => (i === index ? { ...s, dir } : s)) };
}

export function withoutSortAt(config: ViewConfig, index: number): ViewConfig {
  return { ...config, sort: config.sort.filter((_, i) => i !== index) };
}

/** Append a key. A property already in the sort is left alone rather than
 *  duplicated — two keys on one column order nothing. */
export function withAddedSort(config: ViewConfig, prop: string): ViewConfig {
  if (config.sort.some((s) => s.prop === prop)) return config;
  return { ...config, sort: [...config.sort, { prop, dir: "asc" }] };
}

export function withGroupBy(config: ViewConfig, prop: string | null): ViewConfig {
  return { ...config, groupBy: prop };
}

/**
 * Toggle one column. The result is always the FULL resolved column list, so
 * the first toggle turns an implicit config (empty `columns`, where the table
 * falls back to the first handful of properties) into an explicit one — after
 * which what the menu shows and what the table renders cannot drift.
 *
 * Hiding the last visible column is refused: a table with no columns is a
 * blank page, and the member has no affordance left to undo it from.
 */
export function withColumnVisible(
  config: ViewConfig,
  propDefs: readonly PropDef[],
  key: string,
  visible: boolean,
): ViewConfig {
  const entries = columnEntries(config, propDefs);
  if (!visible && entries.filter((e) => e.visible).length <= 1) return config;
  return resolveColumns(config, entries, (e) => (e.key === key ? visible : e.visible));
}

/** Every column on, order and widths kept. */
export function withAllColumns(config: ViewConfig, propDefs: readonly PropDef[]): ViewConfig {
  return resolveColumns(config, columnEntries(config, propDefs), () => true);
}

/** Widths a member dragged in the table are view state too — a visibility
 *  toggle must not silently reset them. */
function resolveColumns(
  config: ViewConfig,
  entries: readonly ColumnEntry[],
  visible: (e: ColumnEntry) => boolean,
): ViewConfig {
  const widths = new Map(config.columns.map((c) => [c.key, c.width] as const));
  const columns = entries.map((e) => {
    const width = widths.get(e.key);
    return {
      key: e.key,
      visible: visible(e),
      ...(typeof width === "number" ? { width } : {}),
    };
  });
  return { ...config, columns };
}

/** What Reset returns to when the host has not supplied the type's defaults:
 *  no filters, the standard recency order, columns and layout untouched. */
export function fallbackDefaults(config: ViewConfig): ViewConfig {
  return { ...config, filters: [], sort: [{ prop: "updated_at", dir: "desc" }] };
}

/** Is there anything for Reset to do? Compared on the fields this bar edits —
 *  a column width dragged in the table is not "a view to reset". */
export function isDirty(config: ViewConfig, defaults: ViewConfig): boolean {
  const shape = (c: ViewConfig) =>
    JSON.stringify({
      filters: c.filters,
      sort: c.sort,
      groupBy: c.groupBy,
      columns: c.columns.map((x) => ({ key: x.key, visible: x.visible })),
    });
  return shape(config) !== shape(defaults);
}

/* -------------------------------------------------------------------- props */

interface FilterBarProps {
  /** The type's properties, in catalog order. Deprecated ones are dropped
   *  here — a saved filter on one still renders as a chip, it just cannot be
   *  built again. */
  propDefs: readonly PropDef[];
  config: ViewConfig;
  /** Receives a WHOLE new config. The bar never mutates the one it was given. */
  onChange: (next: ViewConfig) => void;
  /** The type's defaults (`defaultConfigFor(type)`) — what Reset returns to.
   *  Without it Reset falls back to `fallbackDefaults`. */
  defaults?: ViewConfig;
  /** Hide the group-by picker where grouping means nothing (a plain table).
   *  Default: shown. */
  showGroupBy?: boolean;
  /** Hide the column menu for layouts that have no columns (board, calendar).
   *  Default: shown. */
  showColumns?: boolean;
  className?: string;
}

/* ---------------------------------------------------------------- the bar */

export function FilterBar({
  propDefs,
  config,
  onChange,
  defaults,
  showGroupBy = true,
  showColumns = true,
  className,
}: FilterBarProps) {
  const filterable = useMemo(() => filterableProps(propDefs), [propDefs]);
  const sortable = useMemo(() => sortableProps(propDefs), [propDefs]);
  const groupable = useMemo(() => groupableProps(propDefs), [propDefs]);
  const columns = useMemo(() => columnEntries(config, propDefs), [config, propDefs]);
  const resetTo = useMemo(() => defaults ?? fallbackDefaults(config), [defaults, config]);
  const dirty = isDirty(config, resetTo);

  const [editing, setEditing] = useState<number | null>(null);
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  const hiddenCount = columns.filter((c) => !c.visible).length;
  // Reachable empty state: a type with no properties of its own is still
  // filterable and sortable — on the spine. Say that rather than showing an
  // editor that looks broken.
  const noOwnProps = living(propDefs).length === 0;
  const editorNote = noOwnProps
    ? "This type has no properties of its own yet — filter on the title or the dates."
    : null;

  // The SAME controls in both frames. On a desktop they are a wrapping row of
  // buttons; on a phone that row is four lines of chrome above the data and
  // every popover it opens lands out of thumb reach, so they move into a bottom
  // sheet. One definition, two containers — a second, phone-only filter builder
  // is how the two would drift into offering different operators.
  const controls = (
    <>
      <FilterEditor
        props={filterable}
        initial={null}
        open={editing === -1}
        onOpenChange={(o) => setEditing(o ? -1 : null)}
        onCommit={(f) => {
          onChange(withFilterAt(config, null, f));
          setEditing(null);
        }}
        trigger={
          <Button variant="outline" size="sm" className="text-mut">
            <ListFilter aria-hidden /> Filter
          </Button>
        }
        note={editorNote}
      />

      {config.filters.map((f, i) => {
        const label = filterChipLabel(f, propDefs);
        return (
          <Badge
            key={`${f.prop}-${f.op}-${i}`}
            variant="secondary"
            className="h-7 gap-1 pr-1 pl-2 font-normal"
          >
            <FilterEditor
              props={filterable}
              initial={f}
              open={editing === i}
              onOpenChange={(o) => setEditing(o ? i : null)}
              onCommit={(next) => {
                onChange(withFilterAt(config, i, next));
                setEditing(null);
              }}
              trigger={
                <button
                  type="button"
                  className="cursor-pointer rounded-none px-0.5 hover:underline"
                  aria-label={`edit filter ${label}`}
                >
                  {label}
                </button>
              }
              note={editorNote}
            />
            <button
              type="button"
              onClick={() => onChange(withoutFilterAt(config, i))}
              className="cursor-pointer rounded-none p-0.5 hover:bg-hover-strong"
              aria-label={`remove filter ${label}`}
            >
              <X size={10} aria-hidden />
            </button>
          </Badge>
        );
      })}

      {config.filters.length > 1 && (
        <Button
          variant="ghost"
          size="xs"
          className="text-dim"
          onClick={() => onChange({ ...config, filters: [] })}
        >
          clear filters
        </Button>
      )}

      {/* A vertical hairline separates a ROW of controls. Stacked in the sheet
          it would be a 1px sliver between two buttons, which reads as damage. */}
      {!isMobile && <div className="mx-0.5 h-4 w-px bg-line-soft" aria-hidden />}

      <SortMenu config={config} props={sortable} onChange={onChange} />

      {showGroupBy && (
        <GroupByPicker config={config} props={groupable} propDefs={propDefs} onChange={onChange} />
      )}

      {showColumns && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="text-mut">
                <Columns3 aria-hidden />
                Columns
                {hiddenCount > 0 && <span className="text-dim">· {hiddenCount} hidden</span>}
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="min-w-52">
            {/* The label is a GroupLabel — Base UI requires it inside a Group,
                and it throws (taking the whole menu with it) if it is not. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Show columns</DropdownMenuLabel>
              {columns.length === 0 && (
                <DropdownMenuItem disabled>This type has no columns yet</DropdownMenuItem>
              )}
              {columns.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.key}
                  checked={c.visible}
                  onCheckedChange={(next) =>
                    onChange(withColumnVisible(config, propDefs, c.key, next))
                  }
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
            {columns.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onChange(withAllColumns(config, propDefs))}>
                  Show all
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="text-dim"
        disabled={!dirty}
        onClick={() => onChange({ ...resetTo })}
        title={dirty ? "Back to this type's default view" : "Already the default view"}
      >
        <RotateCcw aria-hidden /> Reset
      </Button>
    </>
  );

  if (!isMobile) {
    return (
      <div
        className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}
        role="group"
        aria-label="View options"
      >
        {controls}
      </div>
    );
  }

  // The phone's entry point: one button that says how much is currently
  // narrowing the view, because a filtered list that does not admit it is
  // filtered is the single most confusing thing a database view can do.
  const active = config.filters.length;
  return (
    <>
      <Button
        variant={active > 0 ? "secondary" : "outline"}
        size="sm"
        className={`touch-target ${className ?? ""}`}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        onClick={() => setSheetOpen(true)}
      >
        <ListFilter aria-hidden /> View
        {active > 0 && <span className="font-mono text-[11px]">{active}</span>}
      </Button>
      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="View options"
        description="Filters, sort, grouping and columns — they apply to every layout."
        testId="view-options-sheet"
      >
        <div role="group" aria-label="View options" className="flex flex-col items-stretch gap-2.5">
          {controls}
        </div>
      </BottomSheet>
    </>
  );
}

/**
 * What a select's closed trigger reads. The primitive's `Select.Value` renders
 * the raw stored VALUE, which is not what a member typed or chose — an
 * operator would sit there as "ilike" and a boolean as "true". The trigger says
 * the label instead, so the closed control and the open list agree.
 */
function TriggerLabel({ value, placeholder }: { value: string; placeholder?: string }) {
  if (value === "") {
    return <span className="flex-1 truncate text-left text-dim">{placeholder ?? ""}</span>;
  }
  return <span className="flex-1 truncate text-left">{value}</span>;
}

/* ------------------------------------------------------------------- sorting */

function sortOptions(props: readonly PropDef[], config: ViewConfig): PropDef[] {
  const known = new Set(props.map((p) => p.name));
  const orphans = config.sort
    .filter((s) => !known.has(s.prop))
    .map<PropDef>((s) => ({ name: s.prop, kind: "text", required: false, deprecated: false }));
  return [...props, ...orphans];
}

/**
 * Multi-key sort. The first key is the one the box orders by; the rest are
 * kept for layouts that refine what is already loaded, and the popover says
 * exactly that instead of implying a server-side compound sort.
 */
function SortMenu({
  config,
  props,
  onChange,
}: {
  config: ViewConfig;
  props: readonly PropDef[];
  onChange: (next: ViewConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = sortOptions(props, config);
  const first = config.sort[0];
  const extra = config.sort.length - 1;
  const summary = !first
    ? "Sort"
    : `${humanProp(first.prop)} ${first.dir === "asc" ? "↑" : "↓"}${extra > 0 ? ` +${extra}` : ""}`;
  const unused = options.filter((p) => !config.sort.some((s) => s.prop === p.name));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="text-mut">
            <ArrowUpDown aria-hidden /> {summary}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[320px] p-3">
        <div className="flex flex-col gap-2">
          {config.sort.length === 0 && (
            <p className="text-[12px] text-dim">
              No sort key — rows come back in the box&apos;s own order. Add one below.
            </p>
          )}

          {config.sort.map((s, i) => (
            <div key={`${s.prop}-${i}`} className="flex items-center gap-1.5">
              <span className="w-9 shrink-0 text-[11px] text-dim">{i === 0 ? "sort" : "then"}</span>
              <Select
                value={s.prop}
                onValueChange={(v) => v && onChange(withSortPropAt(config, i, v))}
              >
                <SelectTrigger
                  size="sm"
                  className="min-w-0 flex-1"
                  aria-label={`sort key ${i + 1} property`}
                >
                  <TriggerLabel value={humanProp(s.prop)} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((p) => (
                    <SelectItem key={p.name} value={p.name}>
                      {humanProp(p.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={`sort ${humanProp(s.prop)} ${s.dir === "asc" ? "descending" : "ascending"}`}
                aria-pressed={s.dir === "desc"}
                onClick={() => onChange(withSortDirAt(config, i, s.dir === "asc" ? "desc" : "asc"))}
              >
                {s.dir === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-dim"
                aria-label={`remove sort key ${humanProp(s.prop)}`}
                onClick={() => onChange(withoutSortAt(config, i))}
              >
                <X aria-hidden />
              </Button>
            </div>
          ))}

          {unused.length > 0 ? (
            <Select value="" onValueChange={(v) => v && onChange(withAddedSort(config, v))}>
              <SelectTrigger size="sm" className="w-full" aria-label="add a sort key">
                <TriggerLabel value="" placeholder="Add a sort key…" />
              </SelectTrigger>
              <SelectContent>
                {unused.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {humanProp(p.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-[11.5px] text-dim">Every sortable property is already a key.</p>
          )}

          {config.sort.length > 1 && (
            <p className="text-[11px] leading-relaxed text-dim">
              The box orders by the first key. Later keys refine the rows already loaded — they are
              not sent with the query.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ grouping */

const NO_GROUP = "__none__";

function GroupByPicker({
  config,
  props,
  propDefs,
  onChange,
}: {
  config: ViewConfig;
  props: readonly PropDef[];
  propDefs: readonly PropDef[];
  onChange: (next: ViewConfig) => void;
}) {
  // A saved config can name a property that is gone or has grown past the
  // grouping ceiling — keep it selectable so it can be seen and cleared.
  const known = new Set(props.map((p) => p.name));
  const options =
    config.groupBy && !known.has(config.groupBy)
      ? [
          ...props,
          { name: config.groupBy, kind: "text", required: false, deprecated: false } as PropDef,
        ]
      : [...props];

  if (options.length === 0) {
    const why = living(propDefs).length === 0 ? "This type has no properties yet." : "";
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-dim"
        disabled
        title={`Grouping needs a yes/no or an enum with at most ${MAX_GROUP_VALUES} values. ${why}`.trim()}
      >
        <Layers aria-hidden /> Group
      </Button>
    );
  }

  return (
    <Select
      value={config.groupBy ?? NO_GROUP}
      onValueChange={(v) => v && onChange(withGroupBy(config, v === NO_GROUP ? null : v))}
    >
      <SelectTrigger size="sm" className="w-[168px]" aria-label="group by">
        <span className="text-dim">group</span>
        <TriggerLabel value={config.groupBy === null ? "none" : humanProp(config.groupBy)} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_GROUP}>none</SelectItem>
        {options.map((p) => (
          <SelectItem key={p.name} value={p.name}>
            {humanProp(p.name)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* -------------------------------------------------------------- filter editor */

/**
 * Property → operator → value, in one popover, for both "add a filter" and
 * "edit this chip". It is the same component for both so an edited filter can
 * never be built by different rules than a new one.
 */
function FilterEditor({
  props,
  initial,
  open,
  onOpenChange,
  onCommit,
  trigger,
  note,
}: {
  props: readonly PropDef[];
  initial: Filter | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommit: (f: Filter) => void;
  trigger: ReactElement;
  /** Shown above the controls; how the bar says "this type is bare" without
   *  rendering an editor that looks broken. */
  note?: string | null;
}) {
  const [field, setField] = useState("");
  const [op, setOp] = useState<FilterOp | "">("");
  const [text, setText] = useState("");
  const [values, setValues] = useState<string[]>([]);

  const prop = props.find((p) => p.name === field) ?? null;
  const ops = prop ? opsForKind(prop.kind) : [];
  const valueless = op !== "" && VALUELESS_OPS.includes(op);

  /** Opening seeds from the filter being edited (or blank for a new one) —
   *  state never survives a close, so a half-typed value cannot leak into the
   *  next chip you open. */
  const seed = (o: boolean) => {
    if (o) {
      const f = initial;
      setField(f?.prop ?? "");
      setOp(f?.op ?? "");
      setText(
        f && !Array.isArray(f.value) && f.value !== undefined && f.value !== null
          ? String(f.value)
          : "",
      );
      setValues(f && Array.isArray(f.value) ? f.value.map((v) => String(v)) : []);
    } else {
      setField("");
      setOp("");
      setText("");
      setValues([]);
    }
    onOpenChange(o);
  };

  const draft = prop && op !== "" ? buildFilter(prop, op, { text, values }) : null;

  const commit = () => {
    if (!draft) return;
    onCommit(draft);
    seed(false);
  };

  return (
    <Popover open={open} onOpenChange={seed}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-[320px] p-3">
        {props.length === 0 ? (
          <p className="text-[12px] text-dim">There is nothing on this type to filter by.</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {note && <p className="text-[11.5px] text-dim">{note}</p>}
            <Select
              value={field}
              onValueChange={(v) => {
                if (!v) return;
                setField(v);
                const kind = props.find((p) => p.name === v)?.kind ?? "text";
                setOp(opsForKind(kind)[0]?.op ?? "eq");
                setText("");
                setValues([]);
              }}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="filter property">
                <TriggerLabel value={prop ? humanProp(prop.name) : ""} placeholder="Property…" />
              </SelectTrigger>
              <SelectContent>
                {props.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {humanProp(p.name)}
                    <span className="ml-1.5 font-mono text-[10px] text-dim">{p.kind}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {prop && (
              <div className="flex gap-2">
                <Select value={op} onValueChange={(v) => v && setOp(v as FilterOp)}>
                  <SelectTrigger size="sm" className="w-[126px] shrink-0" aria-label="operator">
                    <TriggerLabel value={ops.find((o) => o.op === op)?.label ?? ""} />
                  </SelectTrigger>
                  <SelectContent>
                    {ops.map((o) => (
                      <SelectItem key={o.op} value={o.op}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {!valueless && (
                  <ValueEditor
                    prop={prop}
                    op={op}
                    text={text}
                    values={values}
                    onText={setText}
                    onValues={setValues}
                    onEnter={commit}
                  />
                )}
              </div>
            )}

            {prop && !valueless && DATE_KINDS.includes(prop.kind) && op === "gte" && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-dim">in the last</span>
                {SINCE_PRESETS.map((p) => (
                  <Button
                    key={p.days}
                    variant="outline"
                    size="xs"
                    onClick={() => setText(relativeSince(p.days))}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            )}

            <Button size="sm" onClick={commit} disabled={!draft}>
              <Plus aria-hidden /> {initial ? "Update filter" : "Add filter"}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ValueEditor({
  prop,
  op,
  text,
  values,
  onText,
  onValues,
  onEnter,
}: {
  prop: PropDef;
  op: FilterOp | "";
  text: string;
  values: string[];
  onText: (v: string) => void;
  onValues: (v: string[]) => void;
  onEnter: () => void;
}) {
  const enumValues = prop.enum_values ?? [];

  if (prop.kind === "enum" && op === "in") {
    if (enumValues.length === 0) {
      return <p className="flex-1 self-center text-[11.5px] text-dim">No declared values.</p>;
    }
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="min-w-0 flex-1 justify-between">
              {values.length === 0 ? "values…" : `${values.length} selected`}
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-44">
          {enumValues.map((v) => (
            <DropdownMenuCheckboxItem
              key={v}
              checked={values.includes(v)}
              onCheckedChange={(next) =>
                onValues(next ? [...values, v] : values.filter((x) => x !== v))
              }
            >
              {v}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (prop.kind === "enum") {
    if (enumValues.length === 0) {
      return <p className="flex-1 self-center text-[11.5px] text-dim">No declared values.</p>;
    }
    return (
      <Select value={text} onValueChange={(v) => v && onText(v)}>
        <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="value">
          <TriggerLabel value={text} placeholder="value" />
        </SelectTrigger>
        <SelectContent>
          {enumValues.map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (prop.kind === "bool") {
    return (
      <Select value={text} onValueChange={(v) => v && onText(v)}>
        <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label="value">
          <TriggerLabel
            value={text === "" ? "" : text === "true" ? "yes" : "no"}
            placeholder="value"
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">yes</SelectItem>
          <SelectItem value="false">no</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  if (NUMBER_KINDS.includes(prop.kind)) {
    return (
      <Input
        type="number"
        aria-label="value"
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder="0"
        className="h-8 min-w-0 flex-1"
        onKeyDown={(e) => e.key === "Enter" && onEnter()}
      />
    );
  }

  if (DATE_KINDS.includes(prop.kind)) {
    return (
      <Input
        type="date"
        aria-label="value"
        value={text}
        onChange={(e) => onText(e.target.value)}
        className="h-8 min-w-0 flex-1"
        onKeyDown={(e) => e.key === "Enter" && onEnter()}
      />
    );
  }

  // text, id, ref, ref[] — a ref filter matches an object id exactly, and the
  // `in` form takes a comma-separated list of them.
  return (
    <Input
      aria-label="value"
      value={text}
      onChange={(e) => onText(e.target.value)}
      placeholder={
        REF_KINDS.includes(prop.kind) ? (op === "in" ? "id, id…" : "object id") : "text…"
      }
      className="h-8 min-w-0 flex-1"
      onKeyDown={(e) => e.key === "Enter" && onEnter()}
    />
  );
}
