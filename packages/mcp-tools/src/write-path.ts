import type { Pool, PoolClient } from "pg";
import {
  BrainError,
  conflictError,
  isBrainError,
  notFoundError,
  quoteIdentifier,
  refusedError,
  validationError,
} from "@brain/shared";
import { loadTypeByName, loadTypeById, type LoadedType } from "./catalog.js";

/**
 * The write middleware — the single write front door.
 * Every mutation: authenticate scope → check write-shed + per-token budget →
 * SET LOCAL app.actor_id → apply in ONE transaction → return. Writes run
 * concurrently; correctness = version optimistic lock + same-txn idempotency.
 * Runs as brain_app (never the owner). DDL never happens here.
 */

export type Scope = "read" | "write" | "schema-admin";

export interface WriteContext {
  readonly actorId: string;
  readonly scopes: readonly Scope[];
  /** server-derived per-account key; a replay returns the stored result. */
  readonly idempotencyKey?: string;
}

export interface WriteBudget {
  readonly maxMutationsPerWindow: number;
  readonly windowSeconds: number;
  readonly maxBodyBytes: number;
  readonly maxTitleBytes: number;
}

export const DEFAULT_WRITE_BUDGET: WriteBudget = {
  maxMutationsPerWindow: 2000,
  windowSeconds: 60,
  maxBodyBytes: 1_048_576, // 1 MB; the DB CHECK also enforces it
  maxTitleBytes: 4_096, // a title is a short label — bound it (body is the big field)
};

export interface WriterOptions {
  readonly budget?: WriteBudget;
  readonly statementTimeoutMs?: number;
  /** returns { shed: true } to reject writes while reads keep working. */
  readonly diskGuard?: () => Promise<{ shed: boolean }>;
  /**
   * Fired AFTER a write that has already COMMITTED and that NARROWED who may
   * see an object. The collab server subscribes (apps/box/src/collab/rooms.ts)
   * and closes the live editor rooms for that object in the same breath.
   *
   * It is a notification, not a gate: it runs after the transaction, it is
   * never awaited, and a throw is swallowed. A websocket problem must not
   * surface as a failed `edit`, and must certainly not make a caller retry a
   * write that succeeded.
   *
   * WHY THE WRITER AND NOT THE ROUTES: the same visibility flip arrives through
   * the MCP `edit` tool, the dashboard's CAS `PATCH` and (for trashing) the
   * `delete` tool. The Writer is the one place all three already pass through,
   * so hooking it means a caller added later gets eviction without having to
   * remember it exists.
   */
  readonly onAccessChange?: (change: AccessChange) => void;
}

/**
 * Why a committed write narrowed an object's audience. Deliberately mirrors the
 * box's collab evict-reason vocabulary; `apps/box/src/collab/rooms.ts` carries a
 * compile-time proof the two have not drifted (this package is the lower layer
 * and cannot import that type).
 */
export type AccessChangeReason = "visibility_changed" | "unshared" | "deleted";

export interface AccessChange {
  readonly objectId: string;
  readonly reason: AccessChangeReason;
  /**
   * The actor whose committed write narrowed the audience. It is load-bearing,
   * not diagnostic: the collab eviction of a visibility_changed/unshared room
   * FLUSHES the still-authorized editors' unflushed text before dropping the
   * room, and that flush is an RLS-bound base read that must run as an actor who
   * can still SEE the object. This writer just wrote it, so they can — falling
   * back to the room's last joiner (who may be exactly the member just
   * unshared/narrowed away) makes the base read return nothing, the flush no-op,
   * and every open editor's last ~30s of text is silently lost.
   */
  readonly actorId: string;
}

export type BodyOp =
  | { readonly op: "append"; readonly text: string }
  | { readonly op: "prepend"; readonly text: string }
  | { readonly op: "set"; readonly text: string }
  | {
      readonly op: "find_replace";
      readonly find: string;
      readonly replace: string;
      readonly expectCount: number;
    };

export type Visibility = "org" | "private";

/**
 * An edge to create/remove relative to the object being written/edited:
 * exactly one of `to` (object → target) or `from` (source → object).
 */
export interface LinkSpec {
  readonly rel: string;
  readonly to?: string;
  readonly from?: string;
}

/**
 * The origin marker carried on an audit event's `reason` (see `attachOrigin`).
 * `events` has no origin column — 0026's triggers build the payload from
 * `app.write_reason` alone — so the token rides the reason as a structured
 * suffix and comes back out with `parseOrigin`.
 */
export const ORIGIN_MARKER = "dashboard#";

/** An origin token is an opaque id, deliberately narrow so the suffix parse is
 *  unambiguous and nothing user-authored can be smuggled into the reason. */
const ORIGIN_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** `<reason> dashboard#<token>` — anchored, so only a trailing marker counts. */
const ORIGIN_SUFFIX_RE = new RegExp(`^([\\s\\S]*?)\\s*${ORIGIN_MARKER}([A-Za-z0-9_.:-]{1,64})$`);

/**
 * Recover the human reason and the origin token from a stored event reason.
 *
 * The collab bridge (phase 2) recognises its OWN flush writes from this value
 * and nothing else. It must never decide "this is my write" by comparing
 * content: the flush serializes state S1 while the user types on to S2, so a
 * content comparison says "different, therefore theirs" and the bridge applies
 * its own stale diff back into the live doc — the documented echo loop.
 *
 * Known ceiling (accepted): a hand-written reason that itself ends in
 * `dashboard#<token-shaped-word>` parses as an origin. The consequence is a
 * dropped bridge event, not a wrong write, and the token charset keeps the
 * shape rare.
 */
export function parseOrigin(reason: string): { reason: string; origin: string | null } {
  const m = ORIGIN_SUFFIX_RE.exec(reason);
  if (!m) return { reason, origin: null };
  return { reason: m[1]!, origin: m[2]! };
}

/** Build the reason string that carries `origin`, validating the token. */
export function attachOrigin(reason: string | undefined, origin: string | undefined): string {
  const base = reason ?? "";
  if (origin === undefined) return base;
  if (!ORIGIN_TOKEN_RE.test(origin)) {
    throw validationError(
      "originToken must be a short opaque id (letters, digits, . : _ -; max 64 chars)",
    );
  }
  return base ? `${base} ${ORIGIN_MARKER}${origin}` : `${ORIGIN_MARKER}${origin}`;
}

export interface WriteInput {
  readonly type?: string;
  readonly title?: string;
  readonly body?: string;
  readonly props?: Record<string, unknown>;
  /** 'private' = visible only to the creator + sharedWith (RLS, 0012). */
  readonly visibility?: Visibility;
  readonly sharedWith?: readonly string[];
  /**
   * Connector doc refs this content derives from — stamped on the row as
   * source_refs (provenance; "everything derived from doc X" is a query).
   * Scoping is the agent's judgment, not enforced here.
   */
  readonly sources?: readonly string[];
  /** edges to attach in the SAME txn — a dead target fails the whole create. */
  readonly links?: readonly LinkSpec[];
  /** why this is being written — lands on the create event (0026). */
  readonly reason?: string;
  /** who/what produced this write, round-tripped through the audit event's
   *  reason (`dashboard#<token>`) so the collab bridge can recognise its own
   *  flushes without comparing content. */
  readonly originToken?: string;
  /**
   * Client-minted, one per user INTENT and reused across retries. A create has
   * no baseVersion to conflict on, so without this a lost response on ⌘N makes
   * a second object. Deduped in the SAME transaction as the write against
   * `write_idempotency` (0052); a replay returns the original result verbatim.
   * Separate from `WriteContext.idempotencyKey`, which is the older
   * server-derived per-account reservation against the `idempotency` table —
   * both may be set, they do not interact.
   */
  readonly idempotencyKey?: string;
}

export interface EditInput {
  readonly version?: number;
  /** null clears the title (objects.title is nullable); string sets it. */
  readonly title?: string | null;
  readonly bodyOps?: readonly BodyOp[];
  /** PARTIAL patch — only supplied keys change; an explicit null clears. */
  readonly props?: Record<string, unknown>;
  /** creator-only: flip org/private, or replace the share list. */
  readonly visibility?: Visibility;
  readonly sharedWith?: readonly string[];
  /** edges to add / remove in the same txn. */
  readonly links?: readonly LinkSpec[];
  readonly unlinks?: readonly LinkSpec[];
  /** why this change is being made — lands on the update/update_props event (0026). */
  readonly reason?: string;
  /** see WriteInput.originToken. */
  readonly originToken?: string;
}

/** Input to `share` — audience change in the human vocabulary (slugs/emails). */
export interface ShareInput {
  /** OR rows: tag slugs of groups the CALLER holds, and/or member emails
   *  (person-shares — always allowed, no holding requirement). */
  readonly who?: readonly string[];
  /** AND tags compiled into every who row (e.g. 'us-person'): custom slugs
   *  every viewer must ALSO hold. They only narrow, so holding is not required. */
  readonly require?: readonly string[];
  /** hand governance (who may share/transfer next) to this member — an email,
   *  resolved like person-shares. The old governor keeps whatever visibility
   *  this call's audience gives them; include the new governor in `who` so
   *  they can actually see what they now govern. */
  readonly transferTo?: string;
  /** why — lands on the audit event (0026). */
  readonly reason?: string;
  /** see WriteInput.originToken. */
  readonly originToken?: string;
}

export interface WriteResult {
  readonly id: string;
  readonly version: number;
}

/**
 * The current state of an object at the moment a CAS write lost, read INSIDE
 * the losing transaction and therefore RLS-bound: it can only ever contain
 * content the caller may already read.
 *
 * `props` carries SCALAR properties only. ref[] properties are edges, not
 * fields — they are patched through links/unlinks and never bump the version,
 * so they can never be the thing a version conflict is about.
 */
export interface ConflictSnapshot {
  readonly title: string | null;
  readonly body: string | null;
  readonly props: Record<string, unknown>;
  readonly updated_at: string;
  /** display name of the account whose write produced `currentVersion`, or
   *  null when the attribution event is not visible to this caller. */
  readonly actor_name: string | null;
}

/**
 * A version-mismatch conflict that carries what the caller needs to rebase.
 *
 * Extends BrainError with code "conflict", so everything that already matches
 * on `code` (mapWriteError, the MCP error mapper, the existing tests) keeps
 * working unchanged. The snapshot deliberately lives on its OWN field and NOT
 * in `details`: `BrainErrorDetails` is the teaching channel, which references
 * other objects by id only and never echoes stored strings. A caller
 * that wants the content asks for it explicitly.
 */
export class VersionConflictError extends BrainError {
  readonly currentVersion: number;
  readonly current: ConflictSnapshot;

  constructor(currentVersion: number, current: ConflictSnapshot, targetId?: string) {
    super("conflict", "version conflict: the object changed since you last read it", {
      unblock: "re-read the object with get(id) and retry the edit with the new version",
      details: {
        current_version: currentVersion,
        ...(targetId ? { id: targetId } : {}),
      },
    });
    this.name = "VersionConflictError";
    this.currentVersion = currentVersion;
    this.current = current;
    Object.setPrototypeOf(this, VersionConflictError.prototype);
  }
}

/** Internal signal: another transaction claimed our idempotency key while we
 *  were writing. Rolled back and resolved by run() — never escapes the Writer. */
class IdempotencyRace extends Error {
  constructor() {
    super("idempotency key claimed concurrently");
    this.name = "IdempotencyRace";
    Object.setPrototypeOf(this, IdempotencyRace.prototype);
  }
}

export class Writer {
  private readonly budget: WriteBudget;
  private readonly statementTimeoutMs: number;
  private readonly diskGuard?: () => Promise<{ shed: boolean }>;
  private readonly onAccessChange?: (change: AccessChange) => void;
  constructor(
    private readonly pool: Pool,
    opts: WriterOptions = {},
  ) {
    this.budget = opts.budget ?? DEFAULT_WRITE_BUDGET;
    this.statementTimeoutMs = opts.statementTimeoutMs ?? 5000;
    if (opts.diskGuard) this.diskGuard = opts.diskGuard;
    if (opts.onAccessChange) this.onAccessChange = opts.onAccessChange;
  }

  /**
   * Announce a committed narrowing of an object's audience. Never throws, never
   * blocks: the write is already durable, and the subscriber is a websocket
   * server that may not even exist on this box.
   */
  private announceAccessChange(
    objectId: string,
    reason: AccessChangeReason,
    actorId: string,
  ): void {
    if (!this.onAccessChange) return;
    try {
      this.onAccessChange({ objectId, reason, actorId });
    } catch (err) {
      console.warn("write-path: onAccessChange listener threw —", String(err));
    }
  }

  /**
   * Compile legacy visibility/sharedWith to the audience DNF the 0057 policy
   * reads. Wave-1 transition: the tool surface still speaks org/private; the
   * POLICY only reads `audience`, so every write must stamp it. Returns a JSON
   * string of rows (each row an array of tag-id strings).
   * - org      → [[orgTag]]                        (everyone holds the org tag)
   * - private  → [[creatorTag], [sharedTag], …]    (one row per person)
   * Returns null on a pre-0057 box (no `tags` table ⇒ no `audience` column) —
   * callers then omit the column entirely and the legacy visibility columns
   * still drive the (not-yet-swapped) policy.
   */
  private tagsTable: { present: boolean; at: number } | null = null;
  private static readonly TAGS_PROBE_TTL_MS = 60_000;

  /**
   * Is `tags` (0057) present on THIS box? Same shape as the idempotency probe
   * above: a box can run an app image newer than its schema, so an absent
   * table means the dual-write degrades, never that the write fails. Positive
   * answers cache forever (the table is never dropped); negative ones expire
   * so a box that migrates mid-process starts stamping without a restart.
   */
  private async hasTagsTable(c: PoolClient): Promise<boolean> {
    const cached = this.tagsTable;
    if (cached?.present) return true;
    if (cached && Date.now() - cached.at < Writer.TAGS_PROBE_TTL_MS) return false;
    const r = await c.query<{ present: boolean }>(
      "SELECT to_regclass('public.tags') IS NOT NULL AS present",
    );
    const present = r.rows[0]?.present === true;
    this.tagsTable = { present, at: Date.now() };
    return present;
  }

  private govTable: { present: boolean; at: number } | null = null;

  /** Is 0058 (governed_by + owner_removals) on THIS box? Same probe shape as
   *  hasTagsTable — both columns/tables land in one transactional migration. */
  private async hasGovernance(c: PoolClient): Promise<boolean> {
    const cached = this.govTable;
    if (cached?.present) return true;
    if (cached && Date.now() - cached.at < Writer.TAGS_PROBE_TTL_MS) return false;
    const r = await c.query<{ present: boolean }>(
      "SELECT to_regclass('public.owner_removals') IS NOT NULL AS present",
    );
    const present = r.rows[0]?.present === true;
    this.govTable = { present, at: Date.now() };
    return present;
  }

  private async audienceFor(
    c: PoolClient,
    visibility: Visibility,
    creatorId: string,
    sharedWith: readonly string[],
  ): Promise<string | null> {
    if (!(await this.hasTagsTable(c))) return null;
    if (visibility === "org") {
      const r = await c.query<{ id: string }>("SELECT id FROM tags WHERE kind = 'org'");
      return JSON.stringify(r.rows[0] ? [[r.rows[0].id]] : []);
    }
    const ids = [creatorId, ...sharedWith];
    const r = await c.query<{ id: string }>(
      "SELECT id FROM tags WHERE kind = 'personal' AND account_id = ANY($1)",
      [ids],
    );
    return JSON.stringify(r.rows.map((t) => [t.id]));
  }

  // ---- create -----------------------------------------------------------
  async write(ctx: WriteContext, input: WriteInput): Promise<WriteResult> {
    this.checkBodySize(input.body);
    this.checkTitleSize(input.title);
    // Doc provenance only: non-empty sources are stamped on the row so
    // "everything derived from doc X" stays a query forever. Scoping the page
    // (new page, shared with the doc's people) is the agent's judgment,
    // taught by the tool description — the box does not compute or enforce it.
    const sourceRefs =
      input.sources && input.sources.length > 0 ? JSON.stringify(input.sources) : null;
    // Validate the token BEFORE opening a transaction — a malformed origin is a
    // caller bug, not a write to roll back.
    const reason = attachOrigin(input.reason, input.originToken);
    // DEFAULT PRIVATE (tag governance rule 1): every write lands creator-only
    // unless visibility is explicit. There is no longer any actor with a
    // different default — the service accounts that defaulted to org went with
    // the teammate feature, and 0059 retired the last of their rows.
    const visibility: Visibility = input.visibility ?? "private";
    return this.runIdempotent(ctx, input.idempotencyKey, async (c) => {
      await this.setWriteReason(c, reason, input.originToken);
      const sharedWith = await this.resolveSharedWith(c, input.sharedWith);
      // source_refs appears in the INSERT only when stamped, so plain writes
      // keep working against a not-yet-migrated schema (the migrate-with-data
      // seed, and any box mid-update).
      const extraCol = sourceRefs !== null ? ", source_refs" : "";
      const extraVal = sourceRefs !== null ? [sourceRefs] : [];
      // Dual-write: the 0057 policy reads `audience`, so every INSERT stamps it
      // from the same visibility/sharedWith the legacy columns get. Appended
      // LAST, so its param index is (fixed cols) + extraVal.length + 1. Null on
      // a pre-0057 box — the column is omitted, like source_refs above.
      const audience = await this.audienceFor(c, visibility, ctx.actorId, sharedWith ?? []);
      const audCol = audience !== null ? ", audience" : "";
      const audVal = audience !== null ? [audience] : [];
      // 0058: the writer stamps the governor at birth (creator). Probe-gated
      // like audience — a pre-0058 box simply omits the column.
      const hasGov = await this.hasGovernance(c);
      const govCol = hasGov ? ", governed_by" : "";
      const govVal = hasGov ? [ctx.actorId] : [];
      if (input.type) {
        const t = await loadTypeByName(c, input.type);
        if (t.deprecated) {
          throw validationError(
            `type "${input.type}" is retired — revive it with define_type visible:true before filing new objects under it`,
          );
        }
        this.checkRequired(t, input.props ?? {});
        const { props: cleanProps, links: refLinks } = this.extractRefListLinks(
          t,
          input.props ?? {},
        );
        const obj = await c.query<{ id: string; version: string }>(
          `INSERT INTO objects (type_id, title, body, created_by, visibility, shared_with${extraCol}${audCol}${govCol})
           VALUES ($1, $2, $3, $4, $5, $6${sourceRefs !== null ? ", $7" : ""}${audience !== null ? `, $${7 + extraVal.length}::jsonb` : ""}${hasGov ? `, $${7 + extraVal.length + audVal.length}` : ""}) RETURNING id, version`,
          [
            t.id,
            input.title ?? null,
            input.body ?? null,
            ctx.actorId,
            visibility,
            sharedWith ?? [],
            ...extraVal,
            ...audVal,
            ...govVal,
          ],
        );
        const id = obj.rows[0]!.id;
        await this.insertExtRow(c, t, id, cleanProps);
        await this.applyLinks(c, id, [...(input.links ?? []), ...refLinks]);
        return { id, version: Number(obj.rows[0]!.version) };
      }
      if (input.props && Object.keys(input.props).length > 0) {
        throw validationError("a note has no typed properties — give it a type first (set_type)");
      }
      const obj = await c.query<{ id: string; version: string }>(
        `INSERT INTO objects (title, body, created_by, visibility, shared_with${extraCol}${audCol}${govCol})
         VALUES ($1, $2, $3, $4, $5${sourceRefs !== null ? ", $6" : ""}${audience !== null ? `, $${6 + extraVal.length}::jsonb` : ""}${hasGov ? `, $${6 + extraVal.length + audVal.length}` : ""}) RETURNING id, version`,
        [
          input.title ?? null,
          input.body ?? null,
          ctx.actorId,
          visibility,
          sharedWith ?? [],
          ...extraVal,
          ...audVal,
          ...govVal,
        ],
      );
      const id = obj.rows[0]!.id;
      await this.applyLinks(c, id, input.links);
      return { id, version: Number(obj.rows[0]!.version) };
    });
  }

  /** Attach the inline links of a write/edit: manual edges anchored on `id`. */
  private async applyLinks(
    c: PoolClient,
    id: string,
    links: readonly LinkSpec[] | undefined,
  ): Promise<void> {
    for (const l of links ?? []) {
      const { verb, other, outbound } = resolveLinkSpec(id, l);
      await assertLive(c, other, outbound ? "target" : "source");
      const [fromId, toId] = outbound ? [id, other] : [other, id];
      await insertManualEdge(c, fromId, verb, toId);
    }
  }

  private async removeLinks(
    c: PoolClient,
    id: string,
    unlinks: readonly LinkSpec[] | undefined,
  ): Promise<void> {
    for (const l of unlinks ?? []) {
      const { verb, other, outbound } = resolveLinkSpec(id, l);
      const [fromId, toId] = outbound ? [id, other] : [other, id];
      await deleteManualEdge(c, fromId, verb, toId);
    }
  }

  // ---- edit -------------------------------------------------------------
  async edit(ctx: WriteContext, id: string, input: EditInput): Promise<WriteResult> {
    this.checkTitleSize(input.title);
    const reason = attachOrigin(input.reason, input.originToken);
    // Set inside the transaction, announced after it commits — a live editor
    // room must not be torn down on the strength of a write that then rolled
    // back. Null when this edit did not take anyone's access away.
    const access: { narrowed: AccessChangeReason | null } = { narrowed: null };
    const result = await this.run(ctx, async (c) => {
      await this.setWriteReason(c, reason, input.originToken);
      const cur = await c.query<{
        type_id: number | null;
        version: string;
        title: string | null;
        body: string | null;
        created_by: string;
        updated_at: Date;
        visibility: Visibility;
        shared_with: string[];
      }>(
        "SELECT type_id, version, title, body, created_by, updated_at, visibility, shared_with FROM objects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [id],
      );
      if (cur.rowCount === 0) throw notFoundError(id);
      const row = cur.rows[0]!;
      const currentVersion = Number(row.version);

      // Visibility/sharing are creator-only (RLS cannot express per-column
      // rules, so this is the enforcement point). A shared reader may edit
      // content but never widen or narrow who sees it.
      if (
        (input.visibility !== undefined || input.sharedWith !== undefined) &&
        row.created_by !== ctx.actorId
      ) {
        throw refusedError(
          "only the creator may change an object's visibility or sharing",
          "ask the creator to share it or make it org-visible",
        );
      }
      const sharedWith = await this.resolveSharedWith(c, input.sharedWith);

      const bodyOps = input.bodyOps ?? [];
      // Does this edit touch the OBJECT (spine/props/visibility)? Edges are
      // not object state: a links/unlinks-only edit must not bump the version
      // or updated_at — the old link()/unlink() tools never did, and a bump
      // here would version-conflict every concurrent editor of a hub object.
      const objectChanges =
        bodyOps.length > 0 ||
        input.title !== undefined ||
        input.visibility !== undefined ||
        input.sharedWith !== undefined ||
        !!input.props;
      const isPureAppend =
        bodyOps.length > 0 &&
        bodyOps.every((o) => o.op === "append") &&
        input.title === undefined &&
        input.visibility === undefined &&
        input.sharedWith === undefined &&
        !input.props;

      // Every object op except a pure append is version-guarded: an
      // OMITTED version yields the SAME conflict as a mismatch — the error
      // carries current_version + the "re-read with get(id) and retry with the
      // new version" unblock, so interactive agents (and the share-later flow)
      // self-heal in one round-trip instead of silently last-write-wins.
      if (objectChanges && !isPureAppend && input.version !== currentVersion) {
        // The snapshot is read HERE, inside the losing transaction and under
        // the caller's own actor GUC, so it can only contain content this
        // caller may read. Zero rows above already threw not_found: an object
        // the caller cannot see is a 404, never a 409 — a 409 carries a version
        // and so confirms both existence and rate of change.
        throw new VersionConflictError(currentVersion, await this.conflictSnapshot(c, id, row), id);
      }

      let newBody = row.body;
      for (const op of bodyOps) newBody = this.applyBodyOp(newBody, op);
      this.checkBodySize(newBody ?? undefined);

      // Snapshot the pre-edit spine ONLY when the spine changes, so `history`
      // shows real title/body revisions — no phantom rows for prop-only edits
      // before_image is the spine's revision log; props/links live in events.
      const spineChanges = bodyOps.length > 0 || input.title !== undefined;
      if (spineChanges) {
        await c.query(
          `INSERT INTO before_image (object_id, version, snapshot, "by")
           VALUES ($1, $2, $3, $4)`,
          [id, currentVersion, JSON.stringify({ title: row.title, body: row.body }), ctx.actorId],
        );
      }

      const refLinks: LinkSpec[] = [];
      if (objectChanges) {
        const sets: string[] = ["version = version + 1", "updated_at = now()"];
        const vals: unknown[] = [id];
        if (bodyOps.length > 0) {
          sets.push(`body = $${vals.length + 1}`);
          vals.push(newBody);
        }
        if (input.title !== undefined) {
          sets.push(`title = $${vals.length + 1}`);
          vals.push(input.title);
        }
        if (input.visibility !== undefined) {
          sets.push(`visibility = $${vals.length + 1}`);
          vals.push(input.visibility);
        }
        if (sharedWith !== undefined) {
          sets.push(`shared_with = $${vals.length + 1}`);
          vals.push(sharedWith);
        }
        // Dual-write: keep `audience` in step with any visibility/sharing change,
        // recomputed from the MERGED values (the arg where supplied, else the
        // current row's) so the 0057 policy sees the same intent as the legacy
        // columns. Only the creator reaches here (guarded above).
        if (input.visibility !== undefined || sharedWith !== undefined) {
          const mergedVis = (input.visibility ?? row.visibility) as Visibility;
          const mergedShared = sharedWith ?? (row.shared_with as string[]);
          const audience = await this.audienceFor(c, mergedVis, row.created_by, mergedShared);
          if (audience !== null) {
            sets.push(`audience = $${vals.length + 1}::jsonb`);
            vals.push(audience);
          }
        }
        // M3: never mutate a tombstone.
        await c.query(
          `UPDATE objects SET ${sets.join(", ")} WHERE id = $1 AND deleted_at IS NULL`,
          vals,
        );

        if (input.props) {
          if (row.type_id === null) {
            throw validationError("a note has no typed properties to patch");
          }
          const t = await loadTypeById(c, row.type_id);
          this.checkRequiredNotCleared(t, input.props);
          const { props: cleanProps, links } = this.extractRefListLinks(t, input.props);
          refLinks.push(...links);
          await this.patchExtRow(c, t, id, cleanProps);
        }
      }
      await this.applyLinks(c, id, [...(input.links ?? []), ...refLinks]);
      await this.removeLinks(c, id, input.unlinks);
      // ONLY A NARROWING EVICTS. private→org and "added Dana to shared_with"
      // take nobody's access away, and evicting on them would interrupt every
      // open editor on the object for a change that widened it — the classic
      // "security control that trains people to ignore it". By the same rule,
      // a shared_with shrink counts as a narrowing ONLY while the object ends
      // up (or stays) private: on an ORG-visible object shared_with grants
      // nothing beyond what 'org' already grants, so dropping an entry takes
      // no one's access away — evicting there would tear down every open
      // editor's room for a routine edit.
      const endsPrivate = (input.visibility ?? row.visibility) === "private";
      if (input.visibility === "private" && row.visibility !== "private") {
        access.narrowed = "visibility_changed";
      } else if (
        endsPrivate &&
        sharedWith !== undefined &&
        dropsAnyone(row.shared_with, sharedWith)
      ) {
        access.narrowed = "unshared";
      }
      return { id, version: objectChanges ? currentVersion + 1 : currentVersion };
    });
    if (access.narrowed) this.announceAccessChange(id, access.narrowed, ctx.actorId);
    return result;
  }

  // ---- share ------------------------------------------------------------
  /**
   * `share` — the ONE way an audience widens (tag governance, decision rule 2).
   * Compiles the human vocabulary (group slugs + member emails, plus `require`
   * AND-tags) into the audience DNF:
   *
   *   [[creatorPersonalTag]] ∪ { [whoTag, ...require] per who entry }
   *
   * The creator row is always present and always BARE — a creator can never
   * lock themselves out, not even with a require they don't hold. Containment
   * is server-enforced: you may share into a GROUP tag only if you hold it;
   * person-shares are always allowed. The legacy visibility/shared_with
   * columns are kept in step lossily (org iff a row is exactly [orgTag], else
   * private + person-shares) — they are read only by pre-0057 fallback paths
   * and drop a release later.
   */
  async share(ctx: WriteContext, id: string, input: ShareInput): Promise<WriteResult> {
    const reason = attachOrigin(input.reason, input.originToken);
    const access: { narrowed: AccessChangeReason | null } = { narrowed: null };
    const result = await this.run(ctx, async (c) => {
      await this.setWriteReason(c, reason, input.originToken);
      const hasGov = await this.hasGovernance(c);
      const cur = await c.query<{
        version: string;
        created_by: string;
        governed_by?: string | null;
        visibility: string;
        shared_with: string[];
      }>(
        `SELECT version, created_by, visibility, shared_with${hasGov ? ", governed_by" : ""}
           FROM objects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id],
      );
      if (cur.rowCount === 0) throw notFoundError(id);
      const row = cur.rows[0]!;
      // The GOVERNOR — the creator, unless governance was transferred — is who
      // may change the audience. Orphan stewardship: when the governor's
      // account is no longer active, a live OWNER may govern the rows they can
      // SEE (this row resolved above, so RLS already said yes); a revoked
      // member's private-only rows never resolve here — the privacy promise
      // working, not a gap.
      const governor = (hasGov ? row.governed_by : null) ?? row.created_by;
      if (governor !== ctx.actorId) {
        const steward = await c.query(
          `SELECT 1 FROM accounts me
            WHERE me.id = $2 AND me.role = 'owner' AND me.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM accounts g
                               WHERE g.id = $1 AND g.status = 'active')`,
          [governor, ctx.actorId],
        );
        if ((steward.rowCount ?? 0) === 0) {
          throw refusedError(
            "only the object's governor — the creator, unless governance was transferred — " +
              "may change its audience",
            "ask them to share it; owners may steward visible objects whose governor was revoked",
          );
        }
      }
      if (!(await this.hasTagsTable(c))) {
        throw refusedError(
          "this box has not migrated to tag governance yet",
          "retry after the next self-update completes",
        );
      }
      if (input.transferTo !== undefined && !hasGov) {
        throw refusedError(
          "this box has not migrated to object governance yet",
          "retry after the next self-update completes",
        );
      }

      const creator = await c.query<{ id: string }>(
        "SELECT id FROM tags WHERE kind = 'personal' AND account_id = $1",
        [ctx.actorId],
      );
      const creatorTag = creator.rows[0]?.id;
      if (!creatorTag) {
        throw refusedError(
          "your account has no personal tag yet — the box is mid-migration",
          "retry in a minute",
        );
      }

      const unknownEntry = (entry: string): BrainError =>
        validationError(
          `"${entry}" matches no tag or member email — catalog lists member emails; owners manage tags on the Access page`,
        );

      // WHO: group slugs (containment: must be held) + member emails (carve-out)
      type Resolved = { tagId: string; personalOf?: string; isOrg: boolean };
      const who: Resolved[] = [];
      for (const raw of [...new Set(input.who ?? [])]) {
        const entry = raw.trim();
        if (entry.length === 0) continue;
        if (entry.includes("@")) {
          const r = await c.query<{ tag_id: string; account_id: string }>(
            `SELECT t.id AS tag_id, a.id AS account_id
               FROM accounts a
               JOIN tags t ON t.kind = 'personal' AND t.account_id = a.id
              WHERE lower(a.email) = lower($1) AND a.status = 'active'`,
            [entry],
          );
          if (r.rowCount === 0) throw unknownEntry(entry);
          who.push({ tagId: r.rows[0]!.tag_id, personalOf: r.rows[0]!.account_id, isOrg: false });
          continue;
        }
        const t = await c.query<{ id: string; kind: string; held: boolean }>(
          `SELECT t.id, t.kind,
                  EXISTS (SELECT 1 FROM account_tags at
                           WHERE at.tag_id = t.id AND at.account_id = $2) AS held
             FROM tags t WHERE t.slug = $1 AND t.kind IN ('custom', 'org')`,
          [entry, ctx.actorId],
        );
        if (t.rowCount === 0) throw unknownEntry(entry);
        if (!t.rows[0]!.held) {
          throw refusedError(
            `you can only share into groups you hold — you are not in "${entry}"`,
            "ask an owner to grant you the tag on the Access page, or share with members by email",
          );
        }
        who.push({ tagId: t.rows[0]!.id, isOrg: t.rows[0]!.kind === "org" });
      }

      // REQUIRE: custom AND-tags. They only ever narrow, so no holding check.
      const require: string[] = [];
      for (const raw of [...new Set(input.require ?? [])]) {
        const entry = raw.trim();
        if (entry.length === 0) continue;
        const t = await c.query<{ id: string }>(
          "SELECT id FROM tags WHERE slug = $1 AND kind = 'custom'",
          [entry],
        );
        if (t.rowCount === 0) {
          throw validationError(
            `require: "${entry}" is not a custom tag — owners manage tags on the Access page`,
          );
        }
        require.push(t.rows[0]!.id);
      }

      // audience: creator row BARE + one row per who entry with require folded in
      const rows: string[][] = [[creatorTag]];
      for (const w of who) {
        if (w.tagId === creatorTag) continue; // self-share collapses into the creator row
        rows.push([w.tagId, ...require.filter((r) => r !== w.tagId)]);
      }
      const seenRows = new Set<string>();
      const audience = rows.filter((r) => {
        const key = [...r].sort().join(",");
        if (seenRows.has(key)) return false;
        seenRows.add(key);
        return true;
      });

      const isOrgWide = require.length === 0 && who.some((w) => w.isOrg);
      const mappedVisibility: Visibility = isOrgWide ? "org" : "private";
      const mappedShared = [
        ...new Set(
          who
            .filter((w) => w.personalOf !== undefined && w.personalOf !== ctx.actorId)
            .map((w) => w.personalOf!),
        ),
      ];

      // transfer_to: hand governance to a member (resolved like person-shares).
      let transferee: string | undefined;
      if (input.transferTo !== undefined) {
        const t = await c.query<{ id: string }>(
          `SELECT id FROM accounts
            WHERE lower(email) = lower($1) AND status = 'active'`,
          [input.transferTo.trim()],
        );
        if (t.rowCount === 0) {
          throw validationError(
            `transfer_to: "${input.transferTo}" matches no active member email`,
          );
        }
        transferee = t.rows[0]!.id;
      }

      await c.query(
        `UPDATE objects SET audience = $2::jsonb, visibility = $3, shared_with = $4,
                version = version + 1, updated_at = now()
                ${transferee !== undefined ? ", governed_by = $5" : ""}
          WHERE id = $1 AND deleted_at IS NULL`,
        [
          id,
          JSON.stringify(audience),
          mappedVisibility,
          mappedShared,
          ...(transferee !== undefined ? [transferee] : []),
        ],
      );

      // A share can also NARROW (fewer rows than before) — same eviction rule
      // as edit: only a narrowing tears live editor rooms down.
      if (mappedVisibility === "private" && row.visibility !== "private") {
        access.narrowed = "visibility_changed";
      } else if (mappedVisibility === "private" && dropsAnyone(row.shared_with, mappedShared)) {
        access.narrowed = "unshared";
      }
      return { id, version: Number(row.version) + 1 };
    });
    if (access.narrowed) this.announceAccessChange(id, access.narrowed, ctx.actorId);
    return result;
  }

  /**
   * The field-granular patch the dashboard save queue speaks:
   * only the fields the user actually changed are sent, so two
   * people editing disjoint fields of the same object merge cleanly instead of
   * clobbering each other.
   *
   * A thin wrapper over edit() — same transaction, same CAS, same audit event —
   * with two guarantees spelled out:
   *
   *  - `body` becomes a single `set` op, which IS version-guarded (unlike a
   *    pure append). A save-queue flush must lose the CAS if someone else wrote
   *    in the meantime; that is the whole point of `baseVersion`.
   *  - `props` is a PARTIAL patch: a value of `null` deletes THAT key and
   *    leaves its siblings untouched. Sending the whole props object back would
   *    revert a concurrent editor's change to a field this client never touched.
   */
  async editFields(
    ctx: WriteContext,
    id: string,
    fields: {
      readonly baseVersion?: number;
      readonly title?: string | null;
      readonly body?: string;
      readonly props?: Record<string, unknown>;
      readonly visibility?: Visibility;
      readonly sharedWith?: readonly string[];
      readonly reason?: string;
      readonly originToken?: string;
    },
  ): Promise<WriteResult> {
    const input: {
      version?: number;
      title?: string | null;
      bodyOps?: BodyOp[];
      props?: Record<string, unknown>;
      visibility?: Visibility;
      sharedWith?: readonly string[];
      reason?: string;
      originToken?: string;
    } = {};
    if (fields.baseVersion !== undefined) input.version = fields.baseVersion;
    if (fields.title !== undefined) input.title = fields.title;
    if (fields.body !== undefined) input.bodyOps = [{ op: "set", text: fields.body }];
    // Passed through byte-for-byte: edit() already patches only the supplied
    // keys and clears the ones explicitly set to null. Do NOT "helpfully" strip
    // nulls here — that would silently turn a delete into a no-op.
    if (fields.props !== undefined) input.props = fields.props;
    if (fields.visibility !== undefined) input.visibility = fields.visibility;
    if (fields.sharedWith !== undefined) input.sharedWith = fields.sharedWith;
    if (fields.reason !== undefined) input.reason = fields.reason;
    if (fields.originToken !== undefined) input.originToken = fields.originToken;
    return this.edit(ctx, id, input);
  }

  // ---- soft delete / restore -------------------------------------------
  // Private objects: delete/restore are creator-only — a shared_with reader
  // may see the row (RLS) but not tombstone or resurrect it. The predicate is
  // in the WHERE so a shared reader gets the same not_found as a stranger.
  async softDelete(ctx: WriteContext, id: string): Promise<WriteResult> {
    const result = await this.run(ctx, async (c) => {
      const r = await c.query<{ version: string }>(
        `UPDATE objects SET deleted_at = now(), deleted_by = $2, version = version + 1, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
           AND (visibility = 'org' OR created_by = $2) RETURNING version`,
        [id, ctx.actorId],
      );
      if (r.rowCount === 0) throw notFoundError(id);
      return { id, version: Number(r.rows[0]!.version) };
    });
    // A trashed object's room is not a room anyone may still be typing into.
    // Announced only on the committed path — a `not_found` throws above.
    this.announceAccessChange(id, "deleted", ctx.actorId);
    return result;
  }

  async restore(ctx: WriteContext, id: string): Promise<WriteResult> {
    return this.run(ctx, async (c) => {
      const r = await c.query<{ version: string }>(
        `UPDATE objects SET deleted_at = NULL, deleted_by = NULL, version = version + 1, updated_at = now()
         WHERE id = $1 AND deleted_at IS NOT NULL
           AND (visibility = 'org' OR created_by = $2) RETURNING version`,
        [id, ctx.actorId],
      );
      if (r.rowCount === 0) throw notFoundError(id);
      return { id, version: Number(r.rows[0]!.version) };
    });
  }

  // ---- graph: manual edges ---------------------------------------------
  /** `idempotencyKey` matters here for the same reason it does on create: a
   *  link edit deliberately does NOT bump the version, so it can never 409 and
   *  a lost response would otherwise be retried into a second edge. (The edge
   *  INSERT is itself ON CONFLICT DO NOTHING, so the row cannot duplicate — the
   *  key is what makes the RESULT the caller sees identical across retries.) */
  async link(
    ctx: WriteContext,
    fromId: string,
    rel: string,
    toId: string,
    opts: { readonly idempotencyKey?: string } = {},
  ): Promise<{ from: string; rel: string; to: string }> {
    const verb = validateRel(rel);
    if (fromId === toId) throw validationError("an object cannot link to itself");
    return this.runIdempotent(ctx, opts.idempotencyKey, async (c) => {
      await assertLive(c, fromId, "source");
      await assertLive(c, toId, "target");
      await insertManualEdge(c, fromId, verb, toId);
      return { from: fromId, rel: verb, to: toId };
    });
  }

  async unlink(
    ctx: WriteContext,
    fromId: string,
    rel: string,
    toId: string,
    opts: { readonly idempotencyKey?: string } = {},
  ): Promise<{ from: string; rel: string; to: string; removed: boolean }> {
    const verb = validateRel(rel);
    return this.runIdempotent(ctx, opts.idempotencyKey, async (c) => {
      const removed = await deleteManualEdge(c, fromId, verb, toId);
      return { from: fromId, rel: verb, to: toId, removed };
    });
  }

  // ---- merge (the safe dedupe) -----------------------------------------
  /**
   * Merge `loserId` into `winnerId`: re-point all inbound refs+edges
   * to the winner, move the loser's outbound manual edges, union the body, and
   * soft-delete the loser as a redirect — all in one txn, both versions bumped,
   * recorded in merge_journal for reversibility. Same type only.
   */
  async merge(
    ctx: WriteContext,
    loserId: string,
    winnerId: string,
  ): Promise<{ winner: string; loser: string }> {
    if (loserId === winnerId) throw validationError("cannot merge an object with itself");
    const result = await this.run(ctx, async (c) => {
      const both = await c.query<{
        id: string;
        type_id: number | null;
        body: string | null;
        deleted_at: Date | null;
        visibility: string;
        created_by: string;
        shared_with: string[];
      }>(
        "SELECT id, type_id, body, deleted_at, visibility, created_by, shared_with FROM objects WHERE id = ANY($1) FOR UPDATE",
        [[loserId, winnerId]],
      );
      const loser = both.rows.find((r) => r.id === loserId);
      const winner = both.rows.find((r) => r.id === winnerId);
      if (!loser || !winner) throw notFoundError();
      if (loser.deleted_at || winner.deleted_at) {
        throw refusedError("both objects must be live to merge", "restore them first");
      }
      if (loser.type_id !== winner.type_id) {
        throw refusedError("merge requires the same type", "retype one of them first");
      }
      // A merge folds two audiences' content into ONE page — legal only when
      // the audiences are already identical, else the loser's content leaks to
      // the winner's readers (or vice versa). Same visibility AND — for
      // private objects — the same share list, as sets. On org objects
      // shared_with is dead state (RLS short-circuits on visibility), so a
      // residual list left over from a past private phase must not refuse an
      // org↔org merge.
      if (
        loser.visibility !== winner.visibility ||
        (loser.visibility === "private" && !sameIdSet(loser.shared_with, winner.shared_with))
      ) {
        throw refusedError(
          "merge requires identical sharing — the same visibility and the same share list",
          "align their sharing first (creator-only), or keep them separate and link them",
        );
      }
      // A merge copies the loser's body into the winner (and journals it under
      // the winner's visibility) — moving a private object is the creator's
      // call alone, never a shared reader's.
      for (const o of [loser, winner]) {
        if (o.visibility === "private" && o.created_by !== ctx.actorId) {
          throw refusedError(
            "only the creator may merge a private object",
            "ask the creator, or copy what you need into a new object",
          );
        }
      }
      // Re-pointing runs under RLS: links inside OTHER users' private objects
      // are invisible here and would be silently skipped, stranding them on a
      // tombstone. Refuse instead of corrupting the graph.
      // ponytail: counting refusal — a definer-side repoint would avoid it, add
      // one if hidden-link merges become a real workflow.
      const trueEdges = await c.query<{ n: number }>("SELECT brain_edge_count($1, false) AS n", [
        loserId,
      ]);
      const visibleEdges = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM edges WHERE from_id = $1 OR to_id = $1",
        [loserId],
      );
      if (trueEdges.rows[0]!.n > visibleEdges.rows[0]!.n) {
        throw refusedError(
          "objects you cannot see still link to this object",
          "their owners must unlink first — or merge in the other direction",
        );
      }

      // inbound manual edges: copy to winner then drop from loser
      await c.query(
        `INSERT INTO edges (from_id, rel, to_id, provenance)
         SELECT from_id, rel, $2, 'manual' FROM edges
         WHERE to_id = $1 AND provenance = 'manual' AND from_id <> $2
         ON CONFLICT (from_id, rel, to_id) DO NOTHING`,
        [loserId, winnerId],
      );
      await c.query("DELETE FROM edges WHERE to_id = $1 AND provenance = 'manual'", [loserId]);
      // outbound manual edges: move to winner
      await c.query(
        `INSERT INTO edges (from_id, rel, to_id, provenance)
         SELECT $2, rel, to_id, 'manual' FROM edges
         WHERE from_id = $1 AND provenance = 'manual' AND to_id <> $2
         ON CONFLICT (from_id, rel, to_id) DO NOTHING`,
        [loserId, winnerId],
      );
      await c.query("DELETE FROM edges WHERE from_id = $1 AND provenance = 'manual'", [loserId]);

      // inbound ref edges: re-point the referencing ext COLUMN (the mirror moves
      // the edges). Group by (ext_table, column) so one UPDATE covers each type.
      const refs = await c.query<{ ext: string; col: string }>(
        `SELECT DISTINCT t.ext_table AS ext, substring(e.provenance from 5) AS col
         FROM edges e JOIN objects o ON o.id = e.from_id JOIN types t ON t.id = o.type_id
         WHERE e.to_id = $1 AND e.provenance LIKE 'ref:%'`,
        [loserId],
      );
      for (const { ext, col } of refs.rows) {
        await c.query(
          `UPDATE ${quoteIdentifier(ext)} SET ${quoteIdentifier(col)} = $1 WHERE ${quoteIdentifier(col)} = $2`,
          [winnerId, loserId],
        );
      }

      // union the body onto the winner (bumps its version). The loser's
      // source_refs provenance stays on its tombstone row, reachable via the
      // journal — merge does not rewrite it.
      if (loser.body) {
        await c.query(
          "UPDATE objects SET body = coalesce(body, '') || $2, version = version + 1, updated_at = now() WHERE id = $1",
          [winnerId, `\n\n${loser.body}`],
        );
      } else {
        await c.query(
          "UPDATE objects SET version = version + 1, updated_at = now() WHERE id = $1",
          [winnerId],
        );
      }

      await c.query(
        'INSERT INTO merge_journal (loser, winner, "by", snapshot) VALUES ($1, $2, $3, $4)',
        [loserId, winnerId, ctx.actorId, JSON.stringify({ body: loser.body })],
      );
      // soft-delete the loser as a redirect (bumps its version, mirrors to ext)
      await c.query(
        "UPDATE objects SET deleted_at = now(), deleted_by = $2, version = version + 1, updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
        [loserId, ctx.actorId],
      );
      return { winner: winnerId, loser: loserId };
    });
    // The loser is a tombstone now — a redirect, not a page anyone may keep
    // typing into. The winner is untouched by this: its audience did not
    // change (merge refuses unless the two audiences were already identical),
    // and evicting it would interrupt editors for no reason at all.
    this.announceAccessChange(loserId, "deleted", ctx.actorId);
    return result;
  }

  // ---- set_type (promote / reclassify) ----------------------------------
  /**
   * Give an object a type — or move it to a different type — IN PLACE: the id,
   * manual links (and their backlinks), version history, and audit trail all
   * survive. The one thing a retype discards is the OLD type's scalar prop
   * values (the ext row moves tables); they are returned as `dropped_props` so
   * the caller can carry anything forward. `props` supplies the target type's
   * values under exactly write()'s rules: required props must be present,
   * ref[] arrays become manual edges.
   *
   * Version rules mirror edit(): retyping an ALREADY-TYPED object replaces
   * prop values, so it demands the caller's read version (omitted == mismatch,
   * same self-healing conflict); promoting an untyped note discards nothing
   * and checks the version only when one is supplied.
   *
   * A scalar `ref` property in ANOTHER object that points here FKs this
   * object's ext row (the FK targets the ext table, not objects), so a retype
   * under it is refused with the repoint instruction instead of breaking the
   * graph. Manual and ref[] edges are type-independent and survive untouched;
   * this object's own outbound ref edges are cleaned by the mirror trigger
   * when the old ext row goes.
   */
  async setType(
    ctx: WriteContext,
    id: string,
    typeName: string,
    input: {
      readonly props?: Record<string, unknown>;
      readonly version?: number;
      readonly reason?: string;
    } = {},
  ): Promise<{
    id: string;
    version: number;
    from_type: string | null;
    to_type: string;
    dropped_props?: Record<string, unknown>;
  }> {
    return this.run(ctx, async (c) => {
      await this.setWriteReason(c, input.reason ?? "", undefined);
      const cur = await c.query<{
        type_id: number | null;
        version: string;
        title: string | null;
        body: string | null;
        updated_at: Date;
      }>(
        "SELECT type_id, version, title, body, updated_at FROM objects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [id],
      );
      if (cur.rowCount === 0) throw notFoundError(id);
      const row = cur.rows[0]!;
      const currentVersion = Number(row.version);

      const t = await loadTypeByName(c, typeName);
      if (t.deprecated) {
        throw validationError(
          `type "${typeName}" is retired — revive it with define_type visible:true before filing objects under it`,
        );
      }
      if (row.type_id === t.id) {
        // Idempotent no-op: nothing to replace, nothing to bump.
        return { id, version: currentVersion, from_type: t.name, to_type: t.name };
      }
      const guarded = row.type_id !== null || input.version !== undefined;
      if (guarded && input.version !== currentVersion) {
        throw new VersionConflictError(currentVersion, await this.conflictSnapshot(c, id, row), id);
      }

      const props = input.props ?? {};
      this.checkRequired(t, props);
      const { props: cleanProps, links: refLinks } = this.extractRefListLinks(t, props);

      let fromType: string | null = null;
      let dropped: Record<string, unknown> | undefined;
      if (row.type_id !== null) {
        const oldT = await loadTypeById(c, row.type_id);
        fromType = oldT.name;
        dropped = await this.readScalarProps(c, oldT, id);
        try {
          const del = await c.query(`DELETE FROM ${quoteIdentifier(oldT.extTable)} WHERE id = $1`, [
            id,
          ]);
          // The biconditional guarantees a live typed object has exactly one
          // ext row — zero here is invariant breakage, not a user error.
          if (del.rowCount !== 1) {
            throw new Error(`set_type: expected one ${oldT.name} ext row for ${id}`);
          }
        } catch (e) {
          if ((e as { code?: string }).code === "23503") {
            throw refusedError(
              `other objects still point at this one through "${oldT.name}"-typed ref properties`,
              "repoint or clear those refs first (get shows the backlinks), then retype",
              { id },
            );
          }
          throw e;
        }
      }
      await c.query(
        "UPDATE objects SET type_id = $2, version = version + 1, updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
        [id, t.id],
      );
      await this.insertExtRow(c, t, id, cleanProps);
      await this.applyLinks(c, id, refLinks);
      return {
        id,
        version: currentVersion + 1,
        from_type: fromType,
        to_type: t.name,
        ...(dropped && Object.keys(dropped).length > 0 ? { dropped_props: dropped } : {}),
      };
    });
  }

  /** The ext row's scalar values (logical names, non-null only) — what a retype
   *  is about to discard. */
  private async readScalarProps(
    c: PoolClient,
    t: LoadedType,
    id: string,
  ): Promise<Record<string, unknown>> {
    const scalars = t.properties.filter((p) => !p.deprecated && p.kind !== "ref[]");
    if (scalars.length === 0) return {};
    const cols = scalars.map((p) => quoteIdentifier(p.physicalName)).join(", ");
    const r = await c.query(`SELECT ${cols} FROM ${quoteIdentifier(t.extTable)} WHERE id = $1`, [
      id,
    ]);
    const ext = (r.rows[0] ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const p of scalars) {
      const v = ext[p.physicalName];
      if (v !== null && v !== undefined) out[p.name] = v;
    }
    return out;
  }

  // ---- internals --------------------------------------------------------

  /**
   * Publish the reason (0026 reads it in both audit triggers) and, when the
   * caller named one, the origin token.
   *
   * `app.write_origin` is set as its own GUC so a LATER migration can add a
   * real origin column and read it directly, without changing a caller. Until
   * then the token also rides the reason string (attachOrigin), because the
   * shipped triggers build their payload from `app.write_reason` alone and
   * migrations are append-only — this file cannot retroactively widen 0026.
   */
  private async setWriteReason(
    c: PoolClient,
    reason: string,
    originToken: string | undefined,
  ): Promise<void> {
    await c.query(
      "SELECT set_config('app.write_reason', $1, true), set_config('app.write_origin', $2, true)",
      [reason, originToken ?? ""],
    );
  }

  /**
   * What the object looks like right now, for a caller whose CAS just lost.
   * Runs inside the caller's transaction (RLS-bound, row already locked FOR
   * UPDATE) and is best-effort about attribution: an events/accounts row this
   * caller cannot read yields a null name rather than an error or a leak.
   */
  private async conflictSnapshot(
    c: PoolClient,
    id: string,
    row: {
      type_id: number | null;
      title: string | null;
      body: string | null;
      updated_at: Date;
    },
  ): Promise<ConflictSnapshot> {
    let props: Record<string, unknown> = {};
    if (row.type_id !== null) {
      const t = await loadTypeById(c, row.type_id);
      const scalars = t.properties.filter((p) => !p.deprecated && p.kind !== "ref[]");
      if (scalars.length > 0) {
        const cols = scalars.map((p) => quoteIdentifier(p.physicalName)).join(", ");
        const r = await c.query(
          `SELECT ${cols} FROM ${quoteIdentifier(t.extTable)} WHERE id = $1`,
          [id],
        );
        const ext = (r.rows[0] ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const p of scalars) out[p.name] = ext[p.physicalName] ?? null;
        props = out;
      }
    }
    const who = await c.query<{ name: string | null }>(
      // events.seq is the monotonic order (wall-clock `at` is not), so the
      // newest lifecycle event on this object is simply the highest seq.
      `SELECT a.name FROM events e JOIN accounts a ON a.id = e.actor
       WHERE e.target = $1 AND e.kind NOT LIKE 'call:%'
       ORDER BY e.seq DESC LIMIT 1`,
      [id],
    );
    return {
      title: row.title,
      body: row.body,
      props,
      updated_at: row.updated_at.toISOString(),
      actor_name: who.rows[0]?.name ?? null,
    };
  }

  /**
   * Is `write_idempotency` (0052) present on THIS box?
   *
   * A box can briefly run an app image newer than its schema (the updater pulls
   * the app, then migrates; a canary rollback can leave the pair inverted for
   * longer). Doctrine rule 1 — never throw on box state you didn't create — so
   * an absent table means the key is IGNORED and the write proceeds, never that
   * the write fails. This probe is a fallback, not the design: on a migrated
   * box it answers from cache and costs nothing.
   *
   * A positive answer is cached forever (the table is never dropped); a
   * negative one expires, so a box that migrates mid-process starts deduping
   * without a restart.
   */
  private idemTable: { present: boolean; at: number } | null = null;
  private static readonly IDEM_PROBE_TTL_MS = 60_000;

  private async hasIdempotencyTable(c: PoolClient): Promise<boolean> {
    const cached = this.idemTable;
    if (cached?.present) return true;
    if (cached && Date.now() - cached.at < Writer.IDEM_PROBE_TTL_MS) return false;
    const r = await c.query<{ present: boolean }>(
      "SELECT to_regclass('public.write_idempotency') IS NOT NULL AS present",
    );
    const present = r.rows[0]?.present === true;
    this.idemTable = { present, at: Date.now() };
    return present;
  }

  /**
   * Rate at which an insert also sweeps expired dedupe rows. 0052 makes the
   * write path the retention mechanism on purpose (no scheduler, no pg_cron):
   * the table shares an EBS volume with PGDATA, the WAL archive and the
   * pgBackRest repo, so a row kept forever is paid for four times.
   */
  private static readonly IDEM_PURGE_RATE = 1 / 64;

  private applyBodyOp(body: string | null, op: BodyOp): string {
    const cur = body ?? "";
    switch (op.op) {
      case "append":
        // Literal concatenation — callers keep full control of separators by
        // including their own newline; we never inject one.
        return cur + op.text;
      case "prepend":
        return op.text + cur;
      case "set":
        return op.text;
      case "find_replace": {
        if (op.find === "") {
          throw validationError("find_replace requires a non-empty find");
        }
        const count = cur.split(op.find).length - 1;
        if (count !== op.expectCount) {
          throw validationError("find_replace occurrence count did not match", {
            expected: op.expectCount,
            found: count,
          });
        }
        return cur.split(op.find).join(op.replace);
      }
      default:
        // Unreachable once body_ops is schema-validated, but never let an
        // unknown op silently no-op: fail loudly instead of a false success.
        throw validationError(`unknown body op "${String((op as { op?: unknown }).op)}"`);
    }
  }

  private checkTitleSize(title: string | null | undefined): void {
    // null is a deliberate clear (SET title = NULL); only measure strings.
    if (typeof title === "string" && Buffer.byteLength(title, "utf8") > this.budget.maxTitleBytes) {
      throw validationError("title exceeds the size cap", { maxBytes: this.budget.maxTitleBytes });
    }
  }

  /** A props patch must not clear a required property to null/undefined. */
  private checkRequiredNotCleared(t: LoadedType, props: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(props)) {
      const p = t.properties.find((x) => x.name === key);
      if (p?.required && !p.deprecated && (value === null || value === undefined)) {
        throw validationError(`property "${key}" is required and cannot be cleared`, {
          property_id: p.id,
        });
      }
    }
  }

  /** Dedupe a share list and require every entry to be a live member/owner. */
  private async resolveSharedWith(
    c: PoolClient,
    sharedWith: readonly string[] | undefined,
  ): Promise<string[] | undefined> {
    if (sharedWith === undefined) return undefined;
    const unique = [...new Set(sharedWith)];
    if (unique.length === 0) return [];
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM accounts
       WHERE id = ANY($1) AND status = 'active' AND role IN ('owner', 'member', 'viewer')`,
      [unique],
    );
    if (r.rows[0]!.n !== unique.length) {
      throw validationError(
        "shared_with contains an unknown or inactive account — check catalog for current member ids",
      );
    }
    return unique;
  }

  private checkBodySize(body: string | undefined): void {
    if (body !== undefined && Buffer.byteLength(body, "utf8") > this.budget.maxBodyBytes) {
      throw validationError("body exceeds the 1 MB cap", { maxBytes: this.budget.maxBodyBytes });
    }
  }

  private checkRequired(t: LoadedType, props: Record<string, unknown>): void {
    for (const p of t.properties) {
      if (p.required && !p.deprecated) {
        const v = props[p.name];
        if (v === undefined || v === null) {
          throw validationError(`property "${p.name}" is required`, { property_id: p.id });
        }
      }
    }
  }

  /**
   * A ref[] property can't be set as an ext-row column (kind ref[] means a
   * SET of edges, not a scalar) — resolveProps rejects it outright. But the
   * catalog lists ref[] properties (e.g. task.claimed_by) right alongside
   * scalar ones, so an agent following "fill its properties" naturally tries
   * props:{claimed_by:[id]} and eats a validation round-trip every time
   * (confirmed: this was the single largest cause of write failures in a
   * live 21h sample — every ref[]-via-props attempt fails, then gets retried
   * via links and succeeds). Since every ref[] property name IS already the
   * rel verb used to link it (task.claimed_by, work_item.claimed_by,
   * decision's "Relationship verbs in use" agree — this is an established
   * convention, not a guess), treat props.<name>:[ids] as sugar for
   * links:[{rel:name, to:id}, ...] instead of throwing. Anything that isn't a
   * plain array of id strings still gets the original clear error — this
   * only removes the one keystroke-perfect, always-safe case.
   */
  private extractRefListLinks(
    t: LoadedType,
    props: Record<string, unknown>,
  ): { props: Record<string, unknown>; links: LinkSpec[] } {
    const cleanProps: Record<string, unknown> = {};
    const links: LinkSpec[] = [];
    for (const [key, value] of Object.entries(props)) {
      const p = t.properties.find((x) => x.name === key);
      if (p && !p.deprecated && p.kind === "ref[]" && Array.isArray(value)) {
        for (const v of value) {
          if (typeof v !== "string") {
            throw validationError(
              `property "${key}" is a list of ids — pass an array of uuid strings`,
            );
          }
          links.push({ rel: key, to: v });
        }
        continue;
      }
      cleanProps[key] = value;
    }
    return { props: cleanProps, links };
  }

  /** Build the props column list for an ext INSERT (scalar/enum/ref; ref[] deferred to link). */
  private resolveProps(
    t: LoadedType,
    props: Record<string, unknown>,
  ): { columns: string[]; values: unknown[] } {
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(props)) {
      const p = t.properties.find((x) => x.name === key);
      if (!p) throw validationError(`unknown property "${key}" for this type`);
      if (p.deprecated) throw validationError(`property "${key}" is deprecated`);
      if (p.kind === "ref[]") {
        throw validationError(
          `property "${key}" is a list — attach members with links on write/edit`,
        );
      }
      // Postgres would coerce bool-ish strings ("yes"/"1") — reject non-booleans
      // so bool props are as strictly typed as the numeric/date ones.
      if (
        p.kind === "bool" &&
        value !== null &&
        value !== undefined &&
        typeof value !== "boolean"
      ) {
        throw validationError(`property "${key}" is a boolean — pass true or false`);
      }
      columns.push(p.physicalName);
      values.push(value === undefined ? null : value);
    }
    return { columns, values };
  }

  private async insertExtRow(
    c: PoolClient,
    t: LoadedType,
    id: string,
    props: Record<string, unknown>,
  ): Promise<void> {
    const { columns, values } = this.resolveProps(t, props);
    const allCols = ["id", ...columns];
    const placeholders = allCols.map((_, i) => `$${i + 1}`);
    const sql = `INSERT INTO ${quoteIdentifier(t.extTable)} (${allCols
      .map(quoteIdentifier)
      .join(", ")}) VALUES (${placeholders.join(", ")})`;
    await c.query(sql, [id, ...values]);
  }

  private async patchExtRow(
    c: PoolClient,
    t: LoadedType,
    id: string,
    props: Record<string, unknown>,
  ): Promise<void> {
    const { columns, values } = this.resolveProps(t, props);
    if (columns.length === 0) return;
    const sets = columns.map((col, i) => `${quoteIdentifier(col)} = $${i + 2}`);
    const sql = `UPDATE ${quoteIdentifier(t.extTable)} SET ${sets.join(", ")} WHERE id = $1`;
    await c.query(sql, [id, ...values]);
  }

  /**
   * The txn wrapper: scope gate → shed → budget → actor + timeout → same-txn
   * idempotency → fn → commit. Any failure rolls back (including the
   * idempotency reservation), so a crash mid-way retries exactly once.
   *
   * Two independent dedupe mechanisms meet here and do not interact:
   *  - `ctx.idempotencyKey` — the older server-derived per-account reservation
   *    against the `idempotency` table (reserve → run → mark done).
   *  - `idempotencyKey` (this parameter) — the client-minted key from
   *    WriteInput / link / unlink, recorded in `write_idempotency` (0052).
   */
  /** run() with a client-minted dedupe key. Argument order puts the closure
   *  last so a keyed call reads exactly like an unkeyed one. */
  private runIdempotent<T extends Record<string, unknown>>(
    ctx: WriteContext,
    idempotencyKey: string | undefined,
    fn: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.run(ctx, fn, idempotencyKey);
  }

  private async run<T extends Record<string, unknown>>(
    ctx: WriteContext,
    fn: (c: PoolClient) => Promise<T>,
    idempotencyKey?: string,
  ): Promise<T> {
    if (!ctx.scopes.includes("write")) {
      throw refusedError("this token cannot write", "ask the owner for a write-scoped token");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.actor_id', $1, true), set_config('statement_timeout', $2, true)",
        [ctx.actorId, String(this.statementTimeoutMs)],
      );

      if (this.diskGuard) {
        const g = await this.diskGuard();
        if (g.shed) {
          throw refusedError(
            "the box is in read-only write-shed (disk nearly full)",
            "reads still work; free space or grow the volume, then retry",
          );
        }
      }

      // Client-minted dedupe (0052), in the SAME transaction as the write, and
      // checked BEFORE the write-budget gate below: a recognized REPLAY is a
      // pure read, not a new mutation, so it must not be gated by (or count
      // against) the budget. Otherwise an aggressive retry — the exact scenario
      // this key exists to cover (a lost HTTP response, e.g. the workspace-ui
      // save queue re-firing a ⌘N create) — could be refused with 'write budget
      // exceeded' precisely because the ORIGINAL write's lifecycle event has
      // pushed the actor to the ceiling, and the client could then NEVER obtain
      // the recorded result. Rows are RLS-scoped to the writing actor, so a
      // replay presented by a DIFFERENT member is a miss (it performs its own,
      // budget-gated write) rather than a window into the first member's result.
      // The dedupe INSERT for a genuinely NEW write still runs after fn() below,
      // so new writes stay budget-gated; only the replay bypasses the gate.
      let dedupeKey: string | null = null;
      if (idempotencyKey && (await this.hasIdempotencyTable(client))) {
        const prior = await client.query<{ result: T }>(
          "SELECT result FROM write_idempotency WHERE key = $1",
          [idempotencyKey],
        );
        if (prior.rowCount === 1) {
          await client.query("COMMIT");
          return prior.rows[0]!.result;
        }
        dedupeKey = idempotencyKey;
      }

      const b = await client.query<{ n: number }>(
        // Exclude 'call:*' audit events (0019): they are logged for every tool
        // call, reads included, and must NOT count as mutations against the
        // write budget — only real lifecycle events do.
        "SELECT count(*)::int AS n FROM events WHERE actor = $1 AND at > now() - make_interval(secs => $2) AND kind NOT LIKE 'call:%'",
        [ctx.actorId, this.budget.windowSeconds],
      );
      if ((b.rows[0]?.n ?? 0) >= this.budget.maxMutationsPerWindow) {
        throw refusedError(
          "write budget exceeded for this token",
          "wait for the rolling window to refill before writing again",
          { limit: this.budget.maxMutationsPerWindow },
        );
      }

      let reserved = false;
      if (ctx.idempotencyKey) {
        const ins = await client.query(
          "INSERT INTO idempotency (account_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING key",
          [ctx.actorId, ctx.idempotencyKey],
        );
        if (ins.rowCount === 1) {
          reserved = true;
        } else {
          const prior = await client.query<{ status: string; result: T | null }>(
            "SELECT status, result FROM idempotency WHERE account_id = $1 AND key = $2",
            [ctx.actorId, ctx.idempotencyKey],
          );
          if (prior.rows[0]?.status === "done" && prior.rows[0].result) {
            await client.query("COMMIT");
            return prior.rows[0].result;
          }
          throw conflictError(0);
        }
      }

      const result = await fn(client);

      if (dedupeKey) {
        // ON CONFLICT DO NOTHING, not an UPDATE: a recorded result is immutable
        // (0052 grants no UPDATE), because a replay must return what the
        // ORIGINAL write returned. Zero rows means someone claimed the key
        // between our SELECT and this INSERT — re-read under RLS to learn who:
        //
        //  - visible ⇒ OUR actor raced itself (two retries in flight). Their
        //    write is committed, so ours must not stand alongside it: unwind
        //    and return theirs.
        //  - invisible ⇒ the key collided with ANOTHER actor's (0052 accepts a
        //    global key namespace; keys are client-minted uuids so this is
        //    negligible). Per that migration's contract this degrades to "not
        //    deduped", never to an error and never to a cross-actor read — our
        //    write stands, it simply has no dedupe row of its own.
        const ins = await client.query(
          `INSERT INTO write_idempotency (key, actor_id, result)
           VALUES ($1, $2, $3::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`,
          [dedupeKey, ctx.actorId, JSON.stringify(result)],
        );
        if (ins.rowCount === 0) {
          const mine = await client.query("SELECT 1 FROM write_idempotency WHERE key = $1", [
            dedupeKey,
          ]);
          if (mine.rowCount === 1) throw new IdempotencyRace();
          console.warn(
            "write-path: idempotency key collided across actors — this write is not deduped",
          );
        }
        if (Math.random() < Writer.IDEM_PURGE_RATE) {
          // Sampled retention sweep (0052). RLS scopes the DELETE to this
          // actor's own rows, which is all this session may touch anyway.
          await client.query(
            "DELETE FROM write_idempotency WHERE created_at < now() - interval '24 hours'",
          );
        }
      }

      if (reserved) {
        await client.query(
          "UPDATE idempotency SET status = 'done', result = $3 WHERE account_id = $1 AND key = $2",
          [ctx.actorId, ctx.idempotencyKey, JSON.stringify(result)],
        );
      }
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (err instanceof IdempotencyRace && idempotencyKey) {
        return await this.replayIdempotent<T>(client, ctx, idempotencyKey);
      }
      throw mapWriteError(err);
    } finally {
      client.release();
    }
  }

  /**
   * Resolve a lost same-actor idempotency race: our write is already rolled
   * back, so read the winner's recorded result and return it as ours.
   *
   * The row was visible a statement ago (that is how run() classified the
   * race), so the miss branch means it was purged in between — vanishingly
   * rare. Nothing was written, so the honest answer is to refuse and ask for a
   * fresh key: inventing a result, or silently retrying without the key, would
   * trade a rare error for a duplicate object, which is the exact failure the
   * key exists to prevent.
   */
  private async replayIdempotent<T extends Record<string, unknown>>(
    client: PoolClient,
    ctx: WriteContext,
    key: string,
  ): Promise<T> {
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.actor_id', $1, true)", [ctx.actorId]);
      const prior = await client.query<{ result: T }>(
        "SELECT result FROM write_idempotency WHERE key = $1",
        [key],
      );
      await client.query("COMMIT");
      if (prior.rowCount === 1) return prior.rows[0]!.result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapWriteError(err);
    }
    throw new BrainError("conflict", "that idempotency key is already in use by another write", {
      unblock: "retry with a freshly generated idempotencyKey",
    });
  }

  /**
   * Append one 'call:<tool>' audit event for a tool invocation (0019). Called
   * by the dispatch wrapper for EVERY tool, reads included — this is the only
   * write a viewer (read-only token) ever triggers, so it deliberately skips
   * the write-scope and write-budget checks in run(): brain_log_call is a
   * SECURITY DEFINER grant that can only ever write a 'call:*' event attributed
   * to the caller, never a lifecycle kind.
   *
   * The activity feed (recent) is org-wide, so PRIVATE-object content must
   * never land in the logged args — that would leak past the visibility RLS.
   * Full args are kept for org-visible work; the content fields of a private
   * write/edit are redacted (the call is still logged, just not its content).
   *
   * Best-effort by contract: audit must never break the call it logs. The
   * caller wraps this in try/catch, and the function itself skips silently on
   * an unattributed actor. Own connection + transaction so it never rides
   * inside a read-only read transaction.
   */
  /** Audit writes queued behind one another — bounded so a stalled DB can't
   *  grow memory, SERIALIZED so the backlog holds at most one pool connection
   *  (live tool calls never queue behind a wall of audit connects). */
  private auditChain: Promise<void> = Promise.resolve();
  private auditQueued = 0;
  private auditShed = 0;
  private static readonly AUDIT_MAX_PENDING = 200;
  /** At the cap, a caller waits this long for the backlog to drain before its
   *  row is shed. Backpressure keeps the "every call is audited" contract under
   *  a burst; the bound keeps a WEDGED database from hanging tool calls. */
  private static readonly AUDIT_BACKPRESSURE_MS = 1_000;

  /**
   * Queue a call-audit write WITHOUT blocking the caller on the audit
   * transaction's round-trips. Redaction runs HERE, before this resolves —
   * the caller awaits it (sub-ms; one indexed SELECT only for edit) so the
   * redaction decision is made at CALL time, never against object state a
   * later call may have changed (a private edit must stay redacted even if
   * the object goes org-visible a moment later). Order among audit rows is
   * FIFO; relative to the next call's lifecycle events it is best-effort,
   * which the audit contract already allows. Over the pending cap, the row
   * is shed — loudly — but never the call.
   */
  async enqueueCallLog(
    actorId: string,
    tool: string,
    args: unknown,
    meta: { ok: boolean; ms: number; error?: string },
  ): Promise<void> {
    // At the cap, apply BACKPRESSURE rather than dropping the row: wait for the
    // serial chain to drain a slot. A burst then costs latency, not audit
    // completeness. Only a database that stays wedged past the bound sheds —
    // loudly. (The depth check must be re-read after every await: a burst of
    // concurrent callers all suspend here, so a stale read would let them all
    // through and the cap would never bind.)
    const deadline = Date.now() + Writer.AUDIT_BACKPRESSURE_MS;
    while (this.auditQueued >= Writer.AUDIT_MAX_PENDING && Date.now() < deadline) {
      await this.auditChain.catch(() => undefined);
    }
    if (this.auditQueued >= Writer.AUDIT_MAX_PENDING) {
      this.auditShed += 1;
      console.warn(
        `call-audit: shed 'call:${tool}' — audit backlog stuck at ${this.auditQueued} pending ` +
          `after ${Writer.AUDIT_BACKPRESSURE_MS}ms (${this.auditShed} shed total); is the database wedged?`,
      );
      return;
    }
    // Reserve the slot SYNCHRONOUSLY, before the redaction await: concurrent
    // calls all suspend on redaction, so a post-await check would see depth 0
    // for every one of them.
    this.auditQueued += 1;
    let loggedArgs: unknown;
    try {
      loggedArgs = await this.redactForAudit(tool, args);
    } catch {
      loggedArgs = "[redacted: unknown]"; // fail closed — never log raw args
    }
    this.auditChain = this.auditChain
      .then(() => this.writeAuditRow(actorId, tool, loggedArgs, meta))
      .catch(() => undefined)
      .finally(() => {
        this.auditQueued -= 1;
      });
  }

  /** Settle every queued audit write — tests and graceful shutdown await this.
   *  Yields a macrotask each round so rows still awaiting redaction (reserved,
   *  not yet chained) get a chance to attach instead of spinning the loop. */
  async flushAudit(): Promise<void> {
    while (this.auditQueued > 0) {
      await this.auditChain;
      if (this.auditQueued > 0) await new Promise((r) => setImmediate(r));
    }
  }

  /** Back-compat single-shot: redact (call-time semantics) then write, awaited. */
  async logCall(
    actorId: string,
    tool: string,
    args: unknown,
    meta: { ok: boolean; ms: number; error?: string },
  ): Promise<void> {
    const loggedArgs = await this.redactForAudit(tool, args).catch(() => "[redacted: unknown]");
    await this.writeAuditRow(actorId, tool, loggedArgs, meta);
  }

  private async writeAuditRow(
    actorId: string,
    tool: string,
    loggedArgs: unknown,
    meta: { ok: boolean; ms: number; error?: string },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      const payload: Record<string, unknown> = { args: loggedArgs, ok: meta.ok, ms: meta.ms };
      if (meta.error) payload.error = meta.error;
      await client.query("SELECT brain_log_call($1, $2::jsonb)", [tool, JSON.stringify(payload)]);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      // swallow: logging a call must never fail the call
    } finally {
      client.release();
    }
  }

  /** DENY-BY-DEFAULT audit redaction (G4.1). Redaction is NOT a positive list of
   *  connectors to scrub (that fail-OPEN posture would let a new/dynamic
   *  synthesized tool leak its args into the org-wide feed). Instead, a tool is
   *  redacted UNLESS it is a first-party tool whose args are org
   *  metadata/content the activity feed may show. The two sets below are that
   *  first-party safe-list; everything else (google, microsoft, every
   *  `<slug>_fetch`, and any unknown tool) has all non-structural arg fields
   *  redacted. */

  /** First-party tools handled by an EXPLICIT branch below (their own field
   *  logic). Listed for clarity; the branches are the source of truth. */

  /** First-party tools whose args are org metadata/content — pass through in
   *  full (there is no privacy cost, and full-fidelity audit is the goal).
   *  `write`/`edit` are ALSO first-party but handled by the private-object
   *  branch below; `search`/`list`/`create_user` by their own branches. NOTE:
   *  the connector tools (`google`, `microsoft`) are deliberately NOT here — a
   *  member's mailbox/calendar payload is not org content, so they fall to the
   *  deny-by-default path. */
  private static readonly FIRST_PARTY_PASSTHROUGH: ReadonlySet<string> = new Set([
    "start",
    "catalog",
    "get",
    "recent",
    "history",
    "delete",
    "restore",
    "set_type",
    "define_type",
    "add_property",
    "merge",
    "revoke_user",
  ]);

  /** Structural arg fields kept under deny-by-default: which endpoint/verb/id/
   *  page was addressed is legitimate audit trail; the PAYLOAD is not. Anything
   *  not here is redacted. `tool` is kept but SANITIZED (see sanitizeToolField).*/
  private static readonly STRUCTURAL_KEEP: ReadonlySet<string> = new Set([
    "tool",
    "method",
    "path",
    "action",
    "id",
    "ids",
    "cursor",
    "limit",
    "offset",
    "page",
    "per_page",
    "perPage",
    "type",
    "scope",
    "provider",
    "kind",
  ]);

  /** Fields of a PRIVATE object whose values are its content, sharing graph, or
   *  relationships — none of these may enter the org-wide feed. */
  private static readonly PRIVATE_OBJECT_FIELDS = [
    "title",
    "body",
    "body_ops",
    "props",
    "shared_with",
    "links",
    "unlinks",
  ];

  /**
   * Strip anything private from a call's args before it lands in the org-wide
   * activity feed (events.payload is NOT RLS-filtered — it is read verbatim by
   * every viewer, so redaction MUST happen here, at write time). DENY-BY-DEFAULT
   * (G4): the redactor's baseline is to redact; a tool is trusted with its full
   * args only if it is first-party. Classes:
   *
   *  - search query / list where: the actor's own text — reveals intent and can
   *    quote private content — is dropped ('[redacted]').
   *  - create_user email: member PII — dropped, keeping name + permission so the
   *    "who was added, as what" audit still reads.
   *  - private write/edit: content, sharing list, and links are dropped. write
   *    is private when args say so; edit also when the TARGET is already private
   *    (looked up under the actor's RLS — if it isn't visible, redact anyway,
   *    since leaking is the worse failure). Org-visible write/edit pass through.
   *  - first-party pass-through tools (FIRST_PARTY_PASSTHROUGH): full args.
   *  - EVERYTHING ELSE — connector tools (google/microsoft), custom
   *    `<slug>_fetch`, and any unknown/dynamic tool — keeps only
   *    STRUCTURAL_KEEP fields (endpoint/verb/id/page); every other arg field
   *    is dropped ('[redacted: connector]'). The kept `tool` field is
   *    sanitized (G4.3).
   */
  private async redactForAudit(tool: string, args: unknown): Promise<unknown> {
    if (args === null || typeof args !== "object") return args;
    const a = args as Record<string, unknown>;

    if (tool === "search") {
      const clone = { ...a };
      if ("query" in clone) clone.query = "[redacted]";
      if ("queries" in clone) clone.queries = "[redacted]";
      return clone;
    }
    if (tool === "list") {
      return "where" in a ? { ...a, where: "[redacted]" } : args;
    }
    if (tool === "create_user") {
      return "email" in a ? { ...a, email: "[redacted]" } : args;
    }

    // Deny-by-default gate: anything that is NOT a first-party tool (and not the
    // private-object write/edit handled below) has all non-structural args
    // redacted. This is the single seam that covers google/microsoft, every
    // `<slug>_fetch`, and any future dynamic tool.
    if (tool !== "write" && tool !== "edit" && !Writer.FIRST_PARTY_PASSTHROUGH.has(tool)) {
      return this.redactUntrusted(a);
    }

    let isPrivate = false;
    if (tool === "write") {
      isPrivate = a.visibility === "private";
    } else if (tool === "edit") {
      isPrivate = a.visibility === "private";
      if (!isPrivate && typeof a.id === "string") {
        // Bare pool query, no actor GUC: RLS hides every private row from an
        // unattributed session, so "not visible" ⇒ redact — the same fail-
        // closed outcome as the old actor-scoped lookup, without a txn. Any
        // error also redacts (leaking is the worse failure).
        try {
          const r = await this.pool.query<{ visibility: string }>(
            "SELECT visibility FROM objects WHERE id = $1",
            [a.id],
          );
          isPrivate = r.rows.length === 0 || r.rows[0]!.visibility === "private";
        } catch {
          isPrivate = true;
        }
      }
    }
    if (!isPrivate) return args;
    const clone: Record<string, unknown> = { ...a };
    for (const f of Writer.PRIVATE_OBJECT_FIELDS) {
      if (f in clone) clone[f] = "[redacted: private]";
    }
    return clone;
  }

  /**
   * Deny-by-default rendering for a non-first-party tool (G4.1/G4.3): keep only
   * STRUCTURAL_KEEP fields, drop every other arg field, and sanitize the kept
   * `tool` field.
   */
  private redactUntrusted(a: Record<string, unknown>): Record<string, unknown> {
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      if (!Writer.STRUCTURAL_KEEP.has(k)) {
        clone[k] = "[redacted: connector]";
        continue;
      }
      if (k === "tool") {
        clone.tool = sanitizeToolField(v);
        continue;
      }
      clone[k] = v;
    }
    return clone;
  }
}

/** Sanitize a kept upstream tool NAME before it enters events.payload (G4.3):
 *  strict charset + length allowlist; anything else ⇒ '[redacted: unknown-tool]'.
 *  (Control chars, markup, and over-long strings all fail the charset/length
 *  test, so no separate stripping pass is needed.) */
function sanitizeToolField(v: unknown): string {
  if (typeof v !== "string") return "[redacted: unknown-tool]";
  if (v.length === 0 || v.length > 64) return "[redacted: unknown-tool]";
  if (!/^[A-Za-z0-9_.-]+$/.test(v)) return "[redacted: unknown-tool]";
  return v;
}

/** Set equality for account-id lists (order/duplicate insensitive). */
/**
 * Did this share-list edit take somebody OFF the list? Additions do not remove
 * anyone's access and must not evict; only a removal does. A null/absent
 * previous list means there was nobody to remove.
 */
function dropsAnyone(
  before: readonly string[] | null | undefined,
  after: readonly string[],
): boolean {
  if (!before || before.length === 0) return false;
  const kept = new Set(after);
  return before.some((id) => !kept.has(id));
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

const REL_RE = /^[a-z][a-z0-9_]*$/;

/** A relationship verb: a lowercase identifier, ≤ 63 bytes. */
function validateRel(rel: unknown): string {
  if (typeof rel !== "string" || !REL_RE.test(rel) || Buffer.byteLength(rel, "utf8") > 63) {
    throw validationError("rel must be a lowercase verb like 'reports_to'");
  }
  return rel;
}

/** Validate an inline link spec relative to the anchored object `id`. */
function resolveLinkSpec(
  id: string,
  l: LinkSpec,
): { verb: string; other: string; outbound: boolean } {
  const verb = validateRel(l.rel);
  const hasTo = typeof l.to === "string";
  const hasFrom = typeof l.from === "string";
  if (hasTo === hasFrom) {
    throw validationError("each link needs exactly one of 'to' or 'from'");
  }
  const other = (hasTo ? l.to : l.from)!;
  if (other === id) throw validationError("an object cannot link to itself");
  return { verb, other, outbound: hasTo };
}

/** The one manual-edge INSERT — link() and inline write/edit links share it. */
async function insertManualEdge(
  c: PoolClient,
  fromId: string,
  verb: string,
  toId: string,
): Promise<void> {
  await c.query(
    `INSERT INTO edges (from_id, rel, to_id, provenance)
     VALUES ($1, $2, $3, 'manual') ON CONFLICT (from_id, rel, to_id) DO NOTHING`,
    [fromId, verb, toId],
  );
}

/**
 * The one manual-edge DELETE — manual provenance ONLY (ref:% edges belong to
 * their typed property; the edge guard rejects hand-deleting them anyway).
 */
async function deleteManualEdge(
  c: PoolClient,
  fromId: string,
  verb: string,
  toId: string,
): Promise<boolean> {
  const r = await c.query(
    "DELETE FROM edges WHERE from_id = $1 AND rel = $2 AND to_id = $3 AND provenance = 'manual'",
    [fromId, verb, toId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** D.8 write-side: an edge endpoint must exist and be live. */
async function assertLive(c: PoolClient, id: string, role: "source" | "target"): Promise<void> {
  const r = await c.query<{ deleted: boolean }>(
    "SELECT (deleted_at IS NOT NULL) AS deleted FROM objects WHERE id = $1",
    [id],
  );
  if (r.rowCount === 0) throw validationError(`the ${role} object does not exist`);
  if (r.rows[0]!.deleted) {
    throw refusedError(
      `the ${role} object is deleted`,
      "restore it first, or link to a live object",
    );
  }
}

export function mapWriteError(err: unknown): BrainError {
  if (isBrainError(err)) return err;
  const e = err as { code?: string; constraint?: string; message?: string };
  switch (e.code) {
    case "P0001": // a policy guard's own RAISE (owner/revoke/permission rules) —
      // surface its message verbatim; these are written to be shown to the caller.
      return refusedError(e.message ?? "not permitted", "the brain's rules don't allow this");
    case "42501": // insufficient_privilege (admin/definer fns, RLS WITH CHECK)
      return refusedError(
        "not permitted",
        "this action needs an owner token, or an object you created",
      );
    case "23514": // check_violation (NaN/Inf, body cap, enum)
      return validationError("a value failed a constraint");
    case "23503": // fk_violation (ref target missing / wrong type)
      return validationError("a referenced object does not exist or is the wrong type");
    case "23505":
      return validationError("that value must be unique");
    case "40001": // serialization_failure
      return conflictError(0);
    case "57014": // statement_timeout
      return refusedError("the write timed out", "retry; if it persists the box may be overloaded");
    default:
      return validationError("the write could not be applied");
  }
}
