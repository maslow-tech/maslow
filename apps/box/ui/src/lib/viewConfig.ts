/**
 * The one view-config model — shared by every layout (table, board, gallery,
 * calendar) and, from phase 6, by the graph's filters too.
 *
 * Two rules make this file worth having:
 *
 *  1. **One filter language, not two.** `Filter` is a thin mirror of the
 *     server's whitelisted where-AST (`packages/mcp-tools/src/query-ast.ts`):
 *     the same operator set, scalars/arrays as values, nothing else.
 *     `toListQuery` compiles a config to exactly the `{ where, sort }` payload
 *     `api.list()` sends — so a filter the board built is byte-identical to the
 *     one the table (or the graph) builds, and no layout gets to invent its own
 *     query dialect.
 *  2. **A saved config is brain content.** A filter literal can embed a private
 *     object's id or title, so the persisted copy is keyed by account
 *     (`brain.view.<accountId>.<typeName>`) and purged the moment a different
 *     member is signed in on this browser — the same contract, and the same
 *     failure modes, as `draftMirror`. Storage can throw (Safari private mode,
 *     quota, policy): every access is guarded, because a view preference we
 *     cannot persist is a degraded feature, never a broken page.
 *
 * Anything read back from storage is treated as hostile-shaped: an older
 * release's config, a hand-edited value, or plain corruption normalizes to the
 * type's defaults field by field rather than throwing on render.
 */

import type { PropDef, TypeSummary } from "./api";

const PREFIX = "brain.view.";

/** Layouts the TypeView can render. Unknown values normalize to "table". */
export type Layout = "table" | "board" | "gallery" | "calendar";

const LAYOUTS: readonly Layout[] = ["table", "board", "gallery", "calendar"];

/** Exactly the operators `compileWhere` accepts — do not add one here without
 *  adding it there first (the server rejects unknown ops). */
export type FilterOp =
  "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "like" | "ilike" | "in" | "is_null" | "is_not_null";

const OPS: readonly FilterOp[] = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "like",
  "ilike",
  "in",
  "is_null",
  "is_not_null",
];

/** Ops that carry no value at all (a value would be dropped server-side). */
const VALUELESS_OPS: readonly FilterOp[] = ["is_null", "is_not_null"];

export type ScalarValue = string | number | boolean | null;

/**
 * One condition. `prop` is a property name OR a spine column the server exposes
 * to where/sort (`id`, `title`, `created_at`, `updated_at`, `version`) — it is
 * resolved against the catalog server-side, never interpolated, so an unknown
 * name is a clean 400, not an injection.
 */
export interface Filter {
  prop: string;
  op: FilterOp;
  /** scalar for the comparison ops, array for `in`, absent for `is_null` /
   *  `is_not_null`. */
  value?: ScalarValue | ScalarValue[];
}

export interface Sort {
  prop: string;
  dir: "asc" | "desc";
}

export interface ColumnConfig {
  key: string;
  visible: boolean;
  /** px; absent means "size to content". */
  width?: number;
}

export interface ViewConfig {
  layout: Layout;
  filters: Filter[];
  /** Ordered. Only the FIRST entry reaches the server (see `toListQuery`). */
  sort: Sort[];
  /** Board grouping property; null means "no grouping chosen yet". */
  groupBy: string | null;
  /** Calendar date property; null means the type has nothing to place on a
   *  calendar. */
  dateProp: string | null;
  columns: ColumnConfig[];
}

/** The `{ where, sort }` half of `api.list()`'s options. */
export interface ListQuery {
  where?: WhereNode;
  sort?: { field: string; dir: "asc" | "desc" };
}

export type WhereNode =
  { and: WhereNode[] } | { field: string; op: FilterOp; value?: ScalarValue | ScalarValue[] };

// ------------------------------------------------------------------ defaults

/** Props that get a table column: everything the cell renderers can show. Refs
 *  are links, not cells — the row's link affordances handle those. */
const NON_COLUMN_KINDS: readonly string[] = ["ref", "ref[]"];

/** How many columns start visible. The rest stay in the column menu. */
const DEFAULT_VISIBLE_COLUMNS = 6;

/** An enum with more values than this is a tag soup, not a board axis. */
const MAX_GROUP_VALUES = 12;

const DATE_KINDS: readonly string[] = ["date", "timestamp"];

function livingProps(type: TypeSummary | null | undefined): PropDef[] {
  return (type?.properties ?? []).filter((p) => !p.deprecated);
}

/**
 * Sensible starting point for a type: the first handful of its own properties
 * as visible columns, a low-cardinality enum to group a board by, and a date
 * property for the calendar.
 *
 * With no type definition (unknown type, still loading) this returns an empty
 * shell rather than guessing: no columns, no groupBy, no dateProp.
 */
export function defaultConfigFor(type: TypeSummary | null | undefined): ViewConfig {
  const props = livingProps(type);
  const columns: ColumnConfig[] = props
    .filter((p) => !NON_COLUMN_KINDS.includes(p.kind))
    .map((p, i) => ({ key: p.name, visible: i < DEFAULT_VISIBLE_COLUMNS }));

  const groupCandidate = props.find(
    (p) =>
      p.kind === "enum" &&
      Array.isArray(p.enum_values) &&
      p.enum_values.length > 0 &&
      p.enum_values.length <= MAX_GROUP_VALUES,
  );
  // A date PROPERTY beats the spine: "due" is what a calendar is for, and
  // updated_at moves under you every time anyone touches the row. Only when the
  // type has no date of its own does the spine stand in — and only if we know
  // the type at all.
  const dateCandidate = props.find((p) => DATE_KINDS.includes(p.kind));

  return {
    layout: "table",
    filters: [],
    sort: [{ prop: "updated_at", dir: "desc" }],
    groupBy: groupCandidate?.name ?? null,
    dateProp: dateCandidate?.name ?? (type ? "updated_at" : null),
    columns,
  };
}

// ------------------------------------------------------------- normalization

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isScalar(v: unknown): v is ScalarValue {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function normalizeFilter(raw: unknown): Filter | null {
  if (!isPlainObject(raw)) return null;
  const prop = raw["prop"];
  const op = raw["op"];
  if (typeof prop !== "string" || !prop) return null;
  if (typeof op !== "string" || !OPS.includes(op as FilterOp)) return null;
  const o = op as FilterOp;
  if (VALUELESS_OPS.includes(o)) return { prop, op: o };
  const value = raw["value"];
  if (o === "in") {
    if (!Array.isArray(value) || !value.every(isScalar)) return null;
    return { prop, op: o, value: value as ScalarValue[] };
  }
  if (!isScalar(value)) return null;
  return { prop, op: o, value };
}

function normalizeSort(raw: unknown): Sort | null {
  if (!isPlainObject(raw)) return null;
  const prop = raw["prop"];
  if (typeof prop !== "string" || !prop) return null;
  return { prop, dir: raw["dir"] === "desc" ? "desc" : "asc" };
}

function normalizeColumn(raw: unknown): ColumnConfig | null {
  if (!isPlainObject(raw)) return null;
  const key = raw["key"];
  if (typeof key !== "string" || !key) return null;
  const width = raw["width"];
  const col: ColumnConfig = { key, visible: raw["visible"] !== false };
  if (typeof width === "number" && Number.isFinite(width) && width > 0) col.width = width;
  return col;
}

/**
 * Turn anything at all into a usable config, field by field, falling back to
 * `fallback` (normally `defaultConfigFor(type)`) for whatever does not parse.
 *
 * Never throws: an older release's shape, a truncated write or a hand-edited
 * value must degrade to defaults, not blank the page. A partially valid config
 * keeps its valid parts — losing one bad filter is better than losing the
 * user's whole column layout.
 */
export function normalizeConfig(raw: unknown, fallback: ViewConfig): ViewConfig {
  if (!isPlainObject(raw)) return { ...fallback };
  const layout = raw["layout"];
  const filters = Array.isArray(raw["filters"])
    ? raw["filters"].map(normalizeFilter).filter((f): f is Filter => f !== null)
    : fallback.filters;
  const sort = Array.isArray(raw["sort"])
    ? raw["sort"].map(normalizeSort).filter((s): s is Sort => s !== null)
    : fallback.sort;
  const columns = Array.isArray(raw["columns"])
    ? raw["columns"].map(normalizeColumn).filter((c): c is ColumnConfig => c !== null)
    : fallback.columns;
  const groupBy = raw["groupBy"];
  const dateProp = raw["dateProp"];
  return {
    layout: LAYOUTS.includes(layout as Layout) ? (layout as Layout) : fallback.layout,
    filters,
    sort,
    groupBy:
      typeof groupBy === "string" && groupBy ? groupBy : groupBy === null ? null : fallback.groupBy,
    dateProp:
      typeof dateProp === "string" && dateProp
        ? dateProp
        : dateProp === null
          ? null
          : fallback.dateProp,
    columns,
  };
}

// --------------------------------------------------------------- compilation

/**
 * `like`/`ilike` mean "contains" in the UI, so a value with no explicit `%`
 * gets wrapped. `_` is deliberately NOT treated as pattern intent: property
 * values are full of underscores (`in_progress`), and reading one as a
 * single-char wildcard would silently widen the filter.
 */
function likeValue(v: ScalarValue): ScalarValue {
  if (typeof v !== "string") return v;
  return v.includes("%") ? v : `%${v}%`;
}

function filterToNode(f: Filter): WhereNode {
  if (VALUELESS_OPS.includes(f.op)) return { field: f.prop, op: f.op };
  if (f.op === "in") {
    return {
      field: f.prop,
      op: f.op,
      value: (Array.isArray(f.value) ? f.value : []) as ScalarValue[],
    };
  }
  const value = isScalar(f.value) ? f.value : null;
  return {
    field: f.prop,
    op: f.op,
    value: f.op === "like" || f.op === "ilike" ? likeValue(value) : value,
  };
}

/**
 * Compile a config into exactly the `where`/`sort` `api.list()` sends.
 *
 * - no filters ⇒ no `where` key at all (the server's own default: everything);
 * - one filter ⇒ the bare leaf node, matching what the AST expects;
 * - many ⇒ `{ and: [...] }`;
 * - `sort` is the FIRST entry only. `Reader.list` takes a single `SortSpec`
 *   (keyset pagination is `(sort_col, id)` — a second column would break the
 *   cursor), so extra entries stay in the config for layouts that want a local
 *   secondary ordering and are not sent. An empty sort sends nothing and the
 *   server orders by id.
 */
export function toListQuery(config: ViewConfig): ListQuery {
  const nodes = config.filters.map(filterToNode);
  const out: ListQuery = {};
  if (nodes.length === 1) out.where = nodes[0]!;
  else if (nodes.length > 1) out.where = { and: nodes };
  const first = config.sort[0];
  if (first) out.sort = { field: first.prop, dir: first.dir };
  return out;
}

// --------------------------------------------------------------- persistence

export function viewConfigKey(accountId: string, typeName: string): string {
  return `${PREFIX}${accountId}.${typeName}`;
}

/** Account ids are uuids (no dots), so the FIRST dot after the prefix splits
 *  the key. Anything that does not parse is treated as foreign and purged
 *  rather than trusted. */
export function parseViewConfigKey(key: string): { accountId: string; typeName: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const accountId = rest.slice(0, dot);
  const typeName = rest.slice(dot + 1);
  if (!accountId || !typeName) return null;
  return { accountId, typeName };
}

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function allViewKeys(s: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const k = s.key(i);
    if (k !== null && k.startsWith(PREFIX)) keys.push(k);
  }
  return keys;
}

/**
 * This account's saved config for one type, normalized against `fallback`
 * (pass `defaultConfigFor(type)`). Nothing saved, unreadable, or shaped like an
 * older release ⇒ the fallback, never an exception.
 *
 * Reading is also a gate: keys belonging to another account are DELETED here,
 * exactly as in `draftMirror` — the caller asked as this account, so anything
 * else belongs to someone who used this browser before.
 */
export function readViewConfig(
  accountId: string,
  typeName: string,
  fallback: ViewConfig,
): ViewConfig {
  const s = store();
  if (!s || !accountId || !typeName) return { ...fallback };
  purgeForeignViewConfigs(accountId);
  const key = viewConfigKey(accountId, typeName);
  try {
    const raw = s.getItem(key);
    if (raw === null) return { ...fallback };
    return normalizeConfig(JSON.parse(raw) as unknown, fallback);
  } catch {
    // Corrupt JSON is not recoverable preference — drop it rather than keep
    // unreadable (and possibly content-bearing) text sitting in storage.
    try {
      s.removeItem(key);
    } catch {
      /* storage gone; nothing else to do */
    }
    return { ...fallback };
  }
}

export function writeViewConfig(accountId: string, typeName: string, config: ViewConfig): void {
  const s = store();
  if (!s || !accountId || !typeName) return;
  try {
    s.setItem(viewConfigKey(accountId, typeName), JSON.stringify(config));
  } catch {
    // Quota or private mode: the in-memory config still drives this session.
  }
}

/** "Reset view" — back to whatever `defaultConfigFor` says. */
export function clearViewConfig(accountId: string, typeName: string): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(viewConfigKey(accountId, typeName));
  } catch {
    /* ignore */
  }
}

/** Logout and 401/session-expiry: a saved filter can name a private object, so
 *  it does not outlive the session that saved it. Not scoped to an account on
 *  purpose — we may not know who we were. */
export function clearAllViewConfigs(): number {
  const s = store();
  if (!s) return 0;
  try {
    const keys = allViewKeys(s);
    for (const k of keys) s.removeItem(k);
    return keys.length;
  } catch {
    return 0;
  }
}

/**
 * Wipe every saved config that does NOT belong to `currentAccountId`, so member
 * B signing in on member A's browser never sees — and never re-sends — A's
 * filters. An empty/unknown current account wipes everything: if we cannot
 * prove a config is ours, it is not ours.
 */
export function purgeForeignViewConfigs(currentAccountId: string): number {
  const s = store();
  if (!s) return 0;
  try {
    let removed = 0;
    for (const key of allViewKeys(s)) {
      const parsed = parseViewConfigKey(key);
      if (!currentAccountId || parsed === null || parsed.accountId !== currentAccountId) {
        s.removeItem(key);
        removed += 1;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}
