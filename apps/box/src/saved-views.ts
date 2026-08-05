import { BrainError } from "@brain/shared";
import type { Pool, PoolClient } from "pg";

/**
 * Per-member saved views (table + policy: migration 0054).
 *
 * A saved view is a named, pinnable snapshot of a workspace view's
 * configuration: the phase-3 database view-config (filter/sort/group/layout/
 * columns) today, the phase-6 graph view (filters, forces, camera, focus)
 * later. Rows are per-member and are NEVER shared — sharing a view with
 * another member is deliberately not a feature.
 *
 * -------------------------------------------------------------- the boundary
 * RLS IS THE BOUNDARY, not this file. Every method runs inside ONE transaction
 * that sets a transaction-local `app.actor_id` (the `true`) under the ordinary
 * request-serving role (`brain_app`, the pool this box hands the dashboard) —
 * exactly like the Reader, the Writer and the collab docStore. `saved_views` is
 * ENABLE + FORCE ROW LEVEL SECURITY with the owner predicate stated as BOTH
 * `USING` and `WITH CHECK`, so:
 *
 *   - a SELECT/UPDATE/DELETE naming ANOTHER member's view id matches zero rows
 *     and this store reports `not_found` — the 404 comes out of the RLS-bound
 *     statement itself, never from fetching a row and comparing `member_id` in
 *     TypeScript. A foreign id and a nonexistent id are therefore
 *     indistinguishable to the caller, which is the point: a saved view's
 *     existence is itself information (its name and config carry filter
 *     literals and object ids).
 *   - an INSERT/UPDATE cannot stamp a row with someone else's `member_id`
 *     (`WITH CHECK`), so nobody can plant a pinned view in another member's
 *     sidebar.
 *
 * The `AND member_id = $actor` that appears in the statements below is BELT AND
 * BRACES for a box whose 0054 guards skipped the policy — it is not the
 * enforcement story, and it must not be read as one. The proof that the POLICY
 * enforces is a SQL-level test (two actors, one connection each, no
 * application code in the path); do not "simplify" that test into a store-level
 * one, and do not delete the policy on the grounds that these WHERE clauses
 * exist.
 *
 * `set_config(..., true)` is transaction-local on purpose: a session-level GUC
 * would leak this actor into the next borrower of a pooled connection.
 */

/** Kinds mirror 0054's CHECK constraint. `graph` is phase 6; it already exists
 *  in the schema so phase 6 needs no second live-box migration. */
const SAVED_VIEW_KINDS = ["database", "graph"] as const;
type SavedViewKind = (typeof SAVED_VIEW_KINDS)[number];

interface SavedView {
  readonly id: string;
  readonly kind: SavedViewKind;
  /** The view's subject — a type name for a database view, null for a global
   *  one. Plain text, deliberately not a FK: a renamed type leaves the view
   *  stale in the sidebar rather than cascading a delete. */
  readonly scope: string | null;
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly pinned: boolean;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SavedViewFilter {
  readonly kind?: SavedViewKind;
  /** `null` selects the GLOBAL views (scope IS NULL); omit to select all. */
  readonly scope?: string | null;
}

interface SavedViewCreate {
  readonly kind?: SavedViewKind;
  readonly scope?: string | null;
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly pinned?: boolean;
}

/** Only the fields a rename/re-save/pin touches. `kind` and `scope` are NOT
 *  patchable: a view that changes subject is a different view, and allowing it
 *  would let one PATCH walk a row out from under the unique index. */
interface SavedViewPatch {
  readonly name?: string;
  readonly config?: Record<string, unknown>;
  readonly pinned?: boolean;
}

/** `config` lands in a jsonb column that the browser round-trips on every
 *  sidebar render; 64KB is far above any real filter/camera payload and well
 *  below anything that hurts. Measured on the serialized form, in BYTES, not
 *  characters — a caller must not smuggle 64K of astral-plane text past a
 *  `.length` check. */
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_NAME_CHARS = 200;
const MAX_SCOPE_CHARS = 200;
/** Bounds one member's sidebar (and this table) without a quota system. Hit
 *  only by a runaway client; the teaching error says to delete one. */
const MAX_VIEWS_PER_MEMBER = 500;
/** A reorder addresses the member's own list, which is capped above. */
const MAX_REORDER_IDS = MAX_VIEWS_PER_MEMBER;

const STORE_TIMEOUT_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (): BrainError => new BrainError("not_found", "no saved view with that id");

const invalid = (message: string): BrainError => new BrainError("validation", message);

// ------------------------------------------------------------------ parsing
// Exported so the HTTP layer validates with the SAME rules the store enforces
// — one definition of "a legal saved view", not two that drift.

/** `config` must be a JSON OBJECT (not an array, not a scalar, not null) whose
 *  serialized form fits the cap. Arrays are refused deliberately: every
 *  consumer treats config as a keyed record, and accepting `[]` today makes
 *  `config.layout` silently undefined tomorrow. */
export function parseConfig(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("config must be a JSON object");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    // Cycles, BigInt, a throwing toJSON — all reachable from a hand-rolled
    // client, none of them storable.
    throw invalid("config must be a JSON object");
  }
  if (serialized === undefined) throw invalid("config must be a JSON object");
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    throw invalid(`config must be under ${MAX_CONFIG_BYTES} bytes`);
  }
  return raw as Record<string, unknown>;
}

export function parseKind(raw: unknown): SavedViewKind {
  if (raw === undefined || raw === null) return "database";
  if (typeof raw !== "string" || !SAVED_VIEW_KINDS.includes(raw as SavedViewKind)) {
    throw invalid(`kind must be one of ${SAVED_VIEW_KINDS.join(", ")}`);
  }
  return raw as SavedViewKind;
}

/** `undefined` and `null` both mean the GLOBAL scope; a blank string is a
 *  client bug (it would collide with the global row under the unique index's
 *  `coalesce(scope, '')`), so it is normalized to null rather than stored. */
export function parseScope(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw invalid("scope must be a string or null");
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_SCOPE_CHARS) {
    throw invalid(`scope must be at most ${MAX_SCOPE_CHARS} characters`);
  }
  return trimmed;
}

export function parseName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") throw invalid("name is required");
  const trimmed = raw.trim();
  if (trimmed.length > MAX_NAME_CHARS) {
    throw invalid(`name must be at most ${MAX_NAME_CHARS} characters`);
  }
  return trimmed;
}

export function parsePinned(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw invalid("pinned must be a boolean");
  return raw;
}

// -------------------------------------------------------------------- rows
interface Row {
  id: string;
  kind: string;
  scope: string | null;
  name: string;
  config: unknown;
  pinned: boolean;
  position: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = `id, kind, scope, name, config, pinned, position, created_at, updated_at`;

/** Sidebar order: pinned first, then the member's own `position`, then creation
 *  order — a stable tiebreak for rows that were never reordered (and for two
 *  rows that share a position, which a concurrent create can produce). */
const SIDEBAR_ORDER = `pinned DESC, saved_views.position ASC, created_at ASC, id ASC`;

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function toView(r: Row): SavedView {
  return {
    id: r.id,
    // The DB's CHECK is the authority; if a box's 0054 guard skipped it, an
    // unknown kind reads back as the default rather than throwing at a member
    // who is only trying to list their sidebar.
    kind: SAVED_VIEW_KINDS.includes(r.kind as SavedViewKind)
      ? (r.kind as SavedViewKind)
      : "database",
    scope: r.scope,
    name: r.name,
    config: r.config && typeof r.config === "object" ? (r.config as Record<string, unknown>) : {},
    pinned: r.pinned,
    position: typeof r.position === "number" ? r.position : Number(r.position),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** 23505 = unique_violation: the (member, kind, scope, name) index. Reported as
 *  a validation error naming the collision, which is the member's OWN row —
 *  no other member's data can produce it (the index is per member_id, and RLS
 *  would not have shown them the row anyway). */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

export class SavedViewsStore {
  constructor(private readonly pool: Pool) {}

  /**
   * ONE transaction, transaction-local `app.actor_id`, request-serving role.
   * See the header: this is what makes the RLS policy the enforcement point.
   */
  private async asActor<T>(
    actorId: string,
    fn: (c: PoolClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      await client.query(
        "SELECT set_config('app.actor_id', $1, true), set_config('app.on_behalf_of', '', true), set_config('statement_timeout', $2, true)",
        [actorId, String(STORE_TIMEOUT_MS)],
      );
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** The member's own views, sidebar order: pinned first, then `position`,
   *  then creation order (a stable tiebreak for rows that never got reordered). */
  async list(actorId: string, filter: SavedViewFilter = {}): Promise<SavedView[]> {
    const scopeGiven = "scope" in filter;
    const { rows } = await this.asActor(
      actorId,
      (c) =>
        c.query<Row>(
          `SELECT ${COLUMNS} FROM saved_views
            WHERE member_id = $1
              AND ($2::text IS NULL OR kind = $2::text)
              AND ($3::boolean IS FALSE OR scope IS NOT DISTINCT FROM $4::text)
            ORDER BY ${SIDEBAR_ORDER}`,
          [actorId, filter.kind ?? null, scopeGiven, scopeGiven ? (filter.scope ?? null) : null],
        ),
      true,
    );
    return rows.map(toView);
  }

  async create(actorId: string, input: SavedViewCreate): Promise<SavedView> {
    const kind = parseKind(input.kind);
    const scope = parseScope(input.scope);
    const name = parseName(input.name);
    const config = parseConfig(input.config);
    const pinned = input.pinned === undefined ? false : parsePinned(input.pinned);

    return this.asActor(actorId, async (c) => {
      // RLS-scoped count: it can only ever see this member's rows, so the cap
      // is per member and no member can push another one over it.
      const { rows: counted } = await c.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM saved_views WHERE member_id = $1",
        [actorId],
      );
      if (Number(counted[0]?.n ?? 0) >= MAX_VIEWS_PER_MEMBER) {
        throw invalid(
          `you already have ${MAX_VIEWS_PER_MEMBER} saved views — delete one before saving another`,
        );
      }
      let rows: Row[];
      try {
        // `member_id` is the ACTOR, always — never a client-supplied field.
        // The policy's WITH CHECK would refuse anything else anyway; not
        // offering the parameter means there is nothing to refuse.
        ({ rows } = await c.query<Row>(
          `INSERT INTO saved_views (member_id, kind, scope, name, config, pinned, position)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6,
                   coalesce(
                     (SELECT max(v.position) + 1 FROM saved_views AS v WHERE v.member_id = $1),
                     0))
           RETURNING ${COLUMNS}`,
          [actorId, kind, scope, name, JSON.stringify(config), pinned],
        ));
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw invalid("you already have a view with that name — pick another name");
        }
        throw e;
      }
      const row = rows[0];
      // Unreachable via RLS (the WITH CHECK passes or the INSERT throws), but
      // an INSERT that returns nothing must not become an `undefined` cast.
      if (!row) throw notFound();
      return toView(row);
    });
  }

  /**
   * Rename / re-save / pin. A foreign or unknown id matches zero rows under the
   * policy and surfaces as `not_found` — the caller cannot tell the two apart,
   * and no other member's row is ever read, let alone returned.
   */
  async update(actorId: string, id: string, patch: SavedViewPatch): Promise<SavedView> {
    // Not a uuid ⇒ it cannot be anyone's view. Answered like any other unknown
    // id rather than as a 400: the shapes of ids a member may hold is not
    // something this endpoint should teach differently per case. (It also
    // keeps a malformed id from reaching the ::uuid cast as a 22P02 → 500.)
    if (!UUID_RE.test(id)) throw notFound();

    const sets: string[] = [];
    const params: unknown[] = [actorId, id];
    if (patch.name !== undefined) {
      params.push(parseName(patch.name));
      sets.push(`name = $${params.length}`);
    }
    if (patch.config !== undefined) {
      params.push(JSON.stringify(parseConfig(patch.config)));
      sets.push(`config = $${params.length}::jsonb`);
    }
    if (patch.pinned !== undefined) {
      params.push(parsePinned(patch.pinned));
      sets.push(`pinned = $${params.length}`);
    }
    if (sets.length === 0) throw invalid("nothing to update");
    // `updated_at` is maintained here, not by a trigger — 0054 deliberately
    // ships no touch-trigger (see its header).
    sets.push("updated_at = now()");

    return this.asActor(actorId, async (c) => {
      let rows: Row[];
      try {
        ({ rows } = await c.query<Row>(
          `UPDATE saved_views SET ${sets.join(", ")}
            WHERE id = $2 AND member_id = $1
            RETURNING ${COLUMNS}`,
          params,
        ));
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw invalid("you already have a view with that name — pick another name");
        }
        throw e;
      }
      const row = rows[0];
      if (!row) throw notFound();
      return toView(row);
    });
  }

  /** Idempotent from the caller's side only in the sense that a second delete
   *  reports `not_found`, exactly as a foreign id does. */
  async remove(actorId: string, id: string): Promise<void> {
    if (!UUID_RE.test(id)) throw notFound();
    const { rowCount } = await this.asActor(actorId, (c) =>
      c.query("DELETE FROM saved_views WHERE id = $1 AND member_id = $2", [id, actorId]),
    );
    if (!rowCount) throw notFound();
  }

  /**
   * Set `position` from the order of `ids` — the whole reorder in ONE
   * statement, so a drag never leaves half the sidebar renumbered.
   *
   * Every id must be one of the caller's own views. A foreign id updates
   * nothing (the policy), so the counts disagree and the whole transaction
   * rolls back with `not_found`: the caller learns "one of those is not yours
   * or does not exist" and nothing about WHICH, which is the same answer an
   * unknown id gets.
   */
  async reorder(actorId: string, ids: readonly string[]): Promise<SavedView[]> {
    if (!Array.isArray(ids) || ids.length === 0) throw invalid("ids must be a non-empty array");
    if (ids.length > MAX_REORDER_IDS) {
      throw invalid(`ids must contain at most ${MAX_REORDER_IDS} entries`);
    }
    if (!ids.every((id) => typeof id === "string" && UUID_RE.test(id))) throw notFound();
    if (new Set(ids).size !== ids.length) throw invalid("ids must not repeat");

    return this.asActor(actorId, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE saved_views AS v
            SET position = ord.pos - 1, updated_at = now()
           FROM unnest($1::uuid[]) WITH ORDINALITY AS ord(id, pos)
          WHERE v.id = ord.id AND v.member_id = $2`,
        [ids, actorId],
      );
      if (rowCount !== ids.length) throw notFound();
      const { rows } = await c.query<Row>(
        `SELECT ${COLUMNS} FROM saved_views
          WHERE member_id = $1
          ORDER BY ${SIDEBAR_ORDER}`,
        [actorId],
      );
      return rows.map(toView);
    });
  }
}
