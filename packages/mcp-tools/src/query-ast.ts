import { quoteIdentifier, validationError } from "@brain/shared";

/**
 * The whitelisted where/sort AST. The security
 * property: an agent-supplied FIELD NAME never becomes SQL — it is resolved
 * against the catalog to a pre-quoted column (or rejected), and every VALUE is
 * a bound parameter. So `list(type, {where})` can't be an injection channel.
 * Pagination is keyset on (sort_col, id), never a mutable column alone.
 */

export type ScalarValue = string | number | boolean | null;

export type WhereNode =
  | { readonly and: readonly WhereNode[] }
  | { readonly or: readonly WhereNode[] }
  | { readonly not: WhereNode }
  | {
      readonly field: string;
      readonly op: CompareOp;
      readonly value?: ScalarValue | readonly ScalarValue[];
    };

export type CompareOp =
  "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "like" | "ilike" | "in" | "is_null" | "is_not_null";

export interface SortSpec {
  readonly field: string;
  readonly dir?: "asc" | "desc";
}

/** Resolves an agent field name to a real, pre-quoted, prefixed SQL column. */
export interface ResolvedField {
  /** e.g. `o."title"` or `e."status"` — already safe to interpolate. Unused
   *  (empty string) when kind is "ref[]" — see refRel. */
  readonly sqlColumn: string;
  readonly kind: string;
  /**
   * Present when kind is "ref[]": the rel verb this property's links use
   * (from the catalog, never agent-supplied text). A ref[] property has no
   * ext-row column — filtering it means "does a manual edge with this rel
   * point at this id", compiled as an EXISTS against edges, not a plain
   * column compare.
   */
  readonly refRel?: string;
}
export type FieldResolver = (name: string) => ResolvedField | null;

const OP_SQL: Record<Exclude<CompareOp, "in" | "is_null" | "is_not_null">, string> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  like: "LIKE",
  ilike: "ILIKE",
};

/** A growable parameter list; returns the `$N` placeholder for each value. */
export class Params {
  readonly values: unknown[];
  constructor(seed: unknown[] = []) {
    this.values = [...seed];
  }
  push(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

const MAX_AST_DEPTH = 8;

const WHERE_EXAMPLE =
  `a where clause looks like {"field":"stage","op":"eq","value":"won"} — ` +
  `combine with {"and":[...]} / {"or":[...]} / {"not":...}; ` +
  `shorthand: {"stage":"won"} (equality), {"stage":["won","lost"]} (any-of), {"stage":null} (unset)`;

/**
 * Coerce the two malformed `where` shapes real clients actually send into the
 * AST, instead of failing the call (live data: ~18% of list calls failed, and
 * these two shapes were the bulk of it):
 *
 *  - a JSON STRING — claude.ai clients with a stale cached tool schema
 *    serialize the object arg to a string;
 *  - a bare map ({stage:"won"}) — agents write equality maps, not the AST.
 *    Scalars become eq, arrays become in, null becomes is_null.
 *
 * A real AST node passes through untouched — but we detect it by SHAPE, not by
 * key name, so a brain whose type has a property literally named "field" (or
 * "not"/"and"/"or") still gets the documented shorthand ({field:"email"} is an
 * equality on that property, not a malformed AST node). An object is an AST node
 * only when it is actually shaped like one: {and:[…]}/{or:[…]} (array value),
 * {not:{…}} (object value), or a leaf carrying an `op` (alongside `field`).
 * Anything else fails with a corrected example — the error is the only schema
 * a stale client is guaranteed to read.
 */
export function coerceWhere(raw: unknown): WhereNode {
  if (typeof raw === "string") {
    try {
      return coerceWhere(JSON.parse(raw));
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw validationError(`where was a string that is not valid JSON; ${WHERE_EXAMPLE}`);
      }
      throw e;
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw validationError(`malformed where clause; ${WHERE_EXAMPLE}`);
  }
  const obj = raw as Record<string, unknown>;
  // Discriminate AST-vs-shorthand by SHAPE, not key presence: a key named
  // "and"/"or"/"not"/"field" whose value doesn't match the AST shape for that
  // key is a shorthand equality on that property, not a malformed AST node.
  const isNode = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v);
  if (
    Array.isArray(obj.and) ||
    Array.isArray(obj.or) ||
    isNode(obj.not) ||
    ("op" in obj && "field" in obj)
  ) {
    return obj as WhereNode;
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    throw validationError(`where was an empty object; ${WHERE_EXAMPLE}`);
  }
  const nodes: WhereNode[] = entries.map(([field, value]) => {
    if (value === null) return { field, op: "is_null" as const };
    if (Array.isArray(value)) {
      return { field, op: "in" as const, value: value as readonly ScalarValue[] };
    }
    if (typeof value === "object") {
      throw validationError(
        `where.${field} is an object — the shorthand takes scalars/arrays/null; ${WHERE_EXAMPLE}`,
      );
    }
    return { field, op: "eq" as const, value: value as ScalarValue };
  });
  return nodes.length === 1 ? nodes[0]! : { and: nodes };
}

/**
 * Reject a filter value whose JS type can't match the column's kind, before it
 * becomes a bound param (a boolean against an int column would otherwise make
 * Postgres throw an operator/coercion error we'd surface as "internal"). null
 * is always allowed (it compares fine); like/ilike keep string semantics.
 */
function checkValueKind(kind: string, value: unknown): void {
  if (value === null) return;
  const t = typeof value;
  const ok =
    kind === "int" || kind === "decimal" || kind === "float"
      ? t === "number"
      : kind === "bool"
        ? t === "boolean"
        : t === "string"; // text / enum / ref / id / date / timestamp
  if (!ok) throw validationError(`filter value for a ${kind} field has the wrong type`);
}

export function compileWhere(
  node: WhereNode,
  resolve: FieldResolver,
  params: Params,
  depth = 0,
): string {
  if (depth > MAX_AST_DEPTH) throw validationError("where clause is nested too deeply");
  if (node === null || typeof node !== "object") throw validationError("malformed where clause");

  if ("and" in node) {
    if (!Array.isArray(node.and) || node.and.length === 0) throw validationError("empty 'and'");
    return (
      "(" + node.and.map((n) => compileWhere(n, resolve, params, depth + 1)).join(" AND ") + ")"
    );
  }
  if ("or" in node) {
    if (!Array.isArray(node.or) || node.or.length === 0) throw validationError("empty 'or'");
    return "(" + node.or.map((n) => compileWhere(n, resolve, params, depth + 1)).join(" OR ") + ")";
  }
  if ("not" in node) {
    return "(NOT " + compileWhere(node.not, resolve, params, depth + 1) + ")";
  }
  if ("field" in node) {
    const col = resolve(node.field);
    if (!col) throw validationError(`unknown or non-filterable field "${String(node.field)}"`);
    // ref[] properties (e.g. task.claimed_by) have no ext-row column — the
    // catalog lists them right alongside scalar props, so "filter tasks by
    // who they're claimed by" is a completely natural thing to try, and it
    // used to be flatly rejected as "unknown or non-filterable field" (this
    // was the dominant cause of `list` failures in a live 21h sample, same
    // family as the write-side ref[]-via-props issue). Compile it as an
    // EXISTS against the manual edge the property's links create.
    if (col.kind === "ref[]") return compileRefListWhere(col.refRel!, node, params);
    switch (node.op) {
      case "is_null":
        return `${col.sqlColumn} IS NULL`;
      case "is_not_null":
        return `${col.sqlColumn} IS NOT NULL`;
      case "in": {
        if (!Array.isArray(node.value)) throw validationError("'in' needs an array value");
        if (node.value.length === 0) return "false";
        for (const v of node.value) checkValueKind(col.kind, v);
        return `${col.sqlColumn} = ANY(${params.push(node.value)})`;
      }
      default: {
        const sqlOp = OP_SQL[node.op as keyof typeof OP_SQL];
        if (!sqlOp) throw validationError(`unknown operator "${String(node.op)}"`);
        if (node.value === undefined || Array.isArray(node.value)) {
          throw validationError(`operator "${node.op}" needs a scalar value`);
        }
        // Type-check the value against the column BEFORE it reaches Postgres, so
        // a mistyped filter (e.g. a boolean on an int field) is a clean
        // validation error instead of a leaked DB/coercion failure.
        checkValueKind(col.kind, node.value);
        return `${col.sqlColumn} ${sqlOp} ${params.push(node.value)}`;
      }
    }
  }
  throw validationError("malformed where clause");
}

/**
 * "does a manual edge with this rel point from the object at this id" — the
 * only two operators that make sense for a set-valued property: eq (one id)
 * and in (any of these ids). rel is catalog-resolved (never agent text), so
 * it's a safe bound param, not string interpolation.
 */
function compileRefListWhere(
  rel: string,
  node: { readonly op: CompareOp; readonly value?: ScalarValue | readonly ScalarValue[] },
  params: Params,
): string {
  if (node.op === "eq") {
    if (typeof node.value !== "string") {
      throw validationError(`"${rel}" is a list — filter with op:"eq" (one id) or op:"in" (ids)`);
    }
    return `EXISTS (SELECT 1 FROM edges WHERE from_id = o."id" AND rel = ${params.push(rel)} AND to_id = ${params.push(node.value)} AND provenance = 'manual')`;
  }
  if (node.op === "in") {
    if (!Array.isArray(node.value)) throw validationError("'in' needs an array value");
    if (node.value.length === 0) return "false";
    for (const v of node.value) {
      if (typeof v !== "string") {
        throw validationError(`"${rel}" is a list of ids — 'in' needs an array of id strings`);
      }
    }
    return `EXISTS (SELECT 1 FROM edges WHERE from_id = o."id" AND rel = ${params.push(rel)} AND to_id = ANY(${params.push(node.value)}) AND provenance = 'manual')`;
  }
  throw validationError(
    `"${rel}" is a list — filter with op:"eq" (one id) or op:"in" (ids), not "${node.op}"`,
  );
}

export interface CompiledSort {
  readonly orderBy: string;
  readonly column: ResolvedField;
  readonly dir: "asc" | "desc";
}

/** Compile ORDER BY with a mandatory `id` tiebreaker (keyset-safe). */
export function compileSort(
  sort: SortSpec | undefined,
  resolve: FieldResolver,
  idColumn = 'o."id"',
): CompiledSort {
  if (!sort) {
    return { orderBy: `${idColumn} ASC`, column: { sqlColumn: idColumn, kind: "id" }, dir: "asc" };
  }
  const col = resolve(sort.field);
  if (!col) throw validationError(`unknown or non-sortable field "${String(sort.field)}"`);
  if (col.kind === "ref[]") {
    throw validationError(`"${sort.field}" is a list — it has no single value to sort by`);
  }
  const dir = sort.dir === "desc" ? "desc" : "asc";
  const kw = dir === "desc" ? "DESC" : "ASC";
  // tiebreaker keeps the keyset total-ordered even on a non-unique sort column
  return { orderBy: `${col.sqlColumn} ${kw}, ${idColumn} ${kw}`, column: col, dir };
}

export interface Cursor {
  readonly v: ScalarValue;
  readonly id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    if (typeof c !== "object" || c === null || typeof c.id !== "string") {
      throw new Error("bad cursor");
    }
    return c;
  } catch {
    throw validationError("invalid pagination cursor");
  }
}

/**
 * The keyset predicate for the NEXT page after `cursor`, ordered by
 * (sortColumn, id). For asc: (sort, id) > (v, id); for desc: (sort, id) < (v, id).
 * Row-value comparison gives correct tie handling on the id tiebreaker.
 */
export function keysetPredicate(
  sort: CompiledSort,
  cursor: Cursor,
  params: Params,
  idColumn = 'o."id"',
): string {
  const cmp = sort.dir === "desc" ? "<" : ">";
  const vp = params.push(cursor.v);
  const idp = params.push(cursor.id);
  return `(${sort.column.sqlColumn}, ${idColumn}) ${cmp} (${vp}, ${idp})`;
}

export { quoteIdentifier };
