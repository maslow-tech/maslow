import type { Pool, PoolClient } from "pg";
import type { Scope } from "@brain/mcp-tools";
import { verifyCollabTicket, type CollabPrincipal } from "./types.js";

/**
 * The DB-bound half of collab authorization: the ticket's single-use gate, the
 * CURRENT account read, and the room join check.
 *
 * `types.ts` stays pure (crypto + the handshake decision, no `pg`); everything
 * here needs the database, so it lives apart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE CHECKS ARE INDEPENDENT. NONE SUBSTITUTES FOR ANOTHER.
 *
 *  1. UPGRADE  — session-minted ticket + strict Origin + kill-switch
 *                (`handshakeDecision`, types.ts). It answers "may this socket
 *                exist, and WHO holds it". It says nothing about any document.
 *  2. JOIN     — `canJoin()`: an ACTUAL RLS-bound read as the joiner, per
 *                document. Hocuspocus multiplexes documents over one socket and
 *                takes the document name from the MESSAGE, not the URL, so a
 *                valid handshake grants access to exactly zero rooms.
 *  3. WRITE    — `connectionMode()` over the account's CURRENT scopes. A viewer
 *                (`scopes = ['read']`) legitimately passes 1 and 2 for an
 *                object they may read; without 3 they could type and a
 *                server-side flush would persist it as them. Being allowed in
 *                the room is not permission to write to it.
 *
 * And the ticket's `scopes` copy authorizes NOTHING. It is a mint-time snapshot
 * carried for convenience; every gate re-reads `accounts.scopes` + `status`
 * from the database (`readScopes`) at join and on the periodic re-check, so
 * demoting member→viewer or revoking an account takes effect on a socket that
 * is already open.
 *
 * Design invariants: auth is three checks, not one; authorization is
 * re-checked while the socket is open.
 */

// ------------------------------------------------------------ single-use jti

/**
 * Spent ticket ids.
 *
 * A ticket rides in the websocket URL's query string (a browser cannot set
 * headers on `new WebSocket(...)`), so it lands in proxy access logs and in
 * whatever `Referer`-shaped telemetry sits in front of the box. Single use plus
 * the ≤60s TTL is what makes that acceptable: a ticket recovered from a log is
 * already both expired and spent.
 *
 * IN MEMORY ON PURPOSE, AND SOUND ONLY BECAUSE THE BOX IS ONE APP PROCESS.
 * The minter (`POST /api/v1/collab/ticket`, dashboard.ts) and the spender (the
 * websocket upgrade) run in the same `brain-app-1` container, sharing this map.
 * The moment the box runs two app processes — a second replica, a worker that
 * terminates websockets, any horizontal scale — this MUST become a DB-backed
 * (or otherwise shared) store, because a ticket spent on process A would still
 * be fresh on process B and single-use would silently degrade to "reusable
 * within the TTL". Treat that as a blocking prerequisite of any such change.
 *
 * Entries are pruned by expiry, so the map is bounded by the number of tickets
 * minted in one TTL window — tens, not thousands.
 */
export class SpentTicketStore {
  private readonly spentAt = new Map<string, number>();
  private lastSweep = 0;

  /**
   * Record a ticket id as used. Returns false if it was ALREADY used (or if it
   * is already expired, which the caller should have refused anyway) — the
   * caller must treat false as "unauthorized", identically to a bad signature.
   */
  spend(jti: string, expiresAtMs: number, nowMs: number = Date.now()): boolean {
    this.sweep(nowMs);
    if (expiresAtMs <= nowMs) return false;
    if (this.spentAt.has(jti)) return false;
    this.spentAt.set(jti, expiresAtMs);
    return true;
  }

  /** Drop expired entries. Cheap: the map only ever holds one TTL window. */
  private sweep(nowMs: number): void {
    // At most once a second — a burst of reconnects must not turn every
    // handshake into a full map scan.
    if (nowMs - this.lastSweep < 1_000) return;
    this.lastSweep = nowMs;
    for (const [jti, exp] of this.spentAt) {
      if (exp <= nowMs) this.spentAt.delete(jti);
    }
  }

  /** Live entry count — tests and logging only. */
  get size(): number {
    return this.spentAt.size;
  }
}

/** The process-wide store. See the class comment for why one process is the rule. */
const spentTickets = new SpentTicketStore();

/**
 * Verify a ticket AND spend it. This is the function the upgrade path must
 * call — `verifyCollabTicket` (types.ts) checks the crypto but knows nothing
 * about replay, so calling it directly leaves a ticket reusable for its whole
 * TTL by anyone who read it out of a log.
 *
 * Returns the connection principal, or null for every failure mode (bad
 * signature, malformed, expired, over the TTL cap, already spent) so a probe
 * cannot tell which check refused it.
 */
export function verifyTicket(
  sessionSecret: string,
  raw: string | undefined | null,
  opts: { readonly now?: number; readonly store?: SpentTicketStore } = {},
): CollabPrincipal | null {
  const now = opts.now ?? Date.now();
  const principal = verifyCollabTicket(sessionSecret, raw, now);
  if (!principal) return null;
  const store = opts.store ?? spentTickets;
  if (!store.spend(principal.ticketId, principal.expiresAt, now)) return null;
  return principal;
}

// ----------------------------------------------------------- current account

/** What the database says about an account RIGHT NOW — never the ticket's copy. */
interface CollabAccountAccess {
  readonly scopes: readonly Scope[];
  readonly status: string;
  readonly role: string;
}

const VALID_SCOPES: readonly Scope[] = ["read", "write", "schema-admin"];

function parseScopes(raw: unknown): Scope[] {
  return Array.isArray(raw) ? raw.filter((s): s is Scope => VALID_SCOPES.includes(s as Scope)) : [];
}

/**
 * The account's CURRENT scopes + status + role.
 *
 * Called at join and on the ≤60s re-check, NEVER replaced by the ticket's
 * snapshot: a member demoted to viewer, suspended, or revoked while their
 * laptop sits open on a document must lose write (and then the room) without
 * waiting for a reconnect. Returns null when the account is gone — the caller
 * treats that exactly like "not active".
 */
export async function readScopes(
  pool: Pool,
  accountId: string,
): Promise<CollabAccountAccess | null> {
  const { rows } = await pool.query<{ scopes: unknown; status: string; role: string }>(
    "SELECT scopes, status, role FROM accounts WHERE id = $1",
    [accountId],
  );
  const row = rows[0];
  if (!row) return null;
  return { scopes: parseScopes(row.scopes), status: row.status, role: row.role };
}

/** An account may hold a socket at all only while it is active. */
export function isActive(access: CollabAccountAccess | null): boolean {
  return access?.status === "active";
}

// ------------------------------------------------------------------ the join

/**
 * Postgres refuses a non-uuid literal for a uuid column with 22P02; pre-filter.
 *
 * CANONICAL LOWERCASE ONLY — deliberately no /i flag. Postgres compares uuids
 * case-insensitively, but every in-process map on the collab path (hocuspocus
 * `documents`, the doc store's rooms, the flush pipeline's rooms, the
 * dashboard's `open_in_editor` guard) keys on the RAW documentName string. An
 * uppercase spelling that authorized here would create a SECOND, parallel room
 * for the same object: invisible to `liveRooms.has` (a CAS body PATCH slides
 * past the 409 guard), missed by `collab.evict`'s fast path on an unshare/
 * narrowing, and CAS-fighting the canonical room's flushes over one
 * `collab_docs` row. Refusing the non-canonical spelling at the join gate —
 * the same rule `routeRoomFromName` enforces for route rooms — closes all
 * three at once. Every legitimate client sends ids exactly as the API returned
 * them: lowercase.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Bound the join read; a wedged database must not hold a handshake open. */
const JOIN_TIMEOUT_MS = 5_000;

/**
 * The three answers a join read can give.
 *
 * `unavailable` exists ONLY for the live re-check (authz.ts). At JOIN time the
 * distinction is irrelevant — `canJoin` collapses it to false, because a
 * database hiccup during a handshake is a refusal the client simply retries.
 * On a socket that is already open it matters: "the database said no" is a
 * revocation and must evict, while "the database did not answer" is not
 * evidence of anything and must not be turned into one. See `reauthorize`.
 */
type JoinProbe = "allowed" | "denied" | "unavailable";

/**
 * May this actor open this object's room?
 *
 * THIS IS AN ACTUAL RLS-BOUND READ AS THE JOINER — a read-only transaction with
 * `app.actor_id` set to the account, then `SELECT 1 FROM objects WHERE id = $1
 * AND deleted_at IS NULL`. If the row comes back, migration 0012's policy let
 * this actor see it; if it does not, they may not join.
 *
 * NEVER reimplement the 0012 predicate here. There is one visibility rule and
 * it lives in Postgres. A second copy in application code diverges immediately:
 * the obvious version (`visibility = 'org' OR created_by = actor`) forgets
 * `shared_with`, which would leave a shared private object CAS-writable through
 * the HTTP API but unjoinable in the editor — the exact multiplayer case the
 * room exists for, broken in a way no test of the SQL policy would catch.
 *
 * There is exactly ONE copy of this read (here), shared by the join gate and
 * the ≤60s re-check, so the two can never drift apart into "you may join but
 * may not stay" or the reverse.
 */
export async function probeJoin(
  pool: Pool,
  accountId: string,
  objectId: string,
): Promise<JoinProbe> {
  // A malformed id is not a database outage — it is a definite "no".
  if (!accountId || !UUID_RE.test(objectId)) return "denied";
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    console.warn("collab: join check could not get a connection —", String(err));
    return "unavailable";
  }
  try {
    await client.query("BEGIN READ ONLY");
    // Txn-local GUCs (the `true`), so a pooled connection never carries this
    // actor into the next borrower. `app.on_behalf_of` is cleared explicitly
    // for the same reason the Reader clears it: a stale session-level value
    // would narrow (or widen) this read invisibly.
    await client.query(
      "SELECT set_config('app.actor_id', $1, true), set_config('app.on_behalf_of', '', true), set_config('statement_timeout', $2, true)",
      [accountId, String(JOIN_TIMEOUT_MS)],
    );
    const { rowCount } = await client.query(
      "SELECT 1 FROM objects WHERE id = $1 AND deleted_at IS NULL",
      [objectId],
    );
    await client.query("COMMIT");
    return (rowCount ?? 0) > 0 ? "allowed" : "denied";
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Never surface the error to the client, and never let it become an "allow".
    console.warn("collab: join check failed —", String(err));
    return "unavailable";
  } finally {
    client.release();
  }
}

/**
 * The join gate. Fail closed: a malformed id, a query error, a dead pool — all
 * false. And the caller must give ONE answer for "cannot see it" and "does not
 * exist" (`ROOM_FORBIDDEN`, "not available"): a room must never reveal that a
 * private object exists.
 */
export async function canJoin(pool: Pool, accountId: string, objectId: string): Promise<boolean> {
  return (await probeJoin(pool, accountId, objectId)) === "allowed";
}

// ------------------------------------------------------------- write or read

/** How a connection is marked once it has joined. */
export type CollabConnectionMode = "rw" | "ro";

/**
 * The WRITE check, third and separate. Derived from the account's CURRENT DB
 * scopes (`readScopes`), never from the ticket and never from the UI's idea of
 * the role: a viewer joins rooms read-only, and hocuspocus accepts updates from
 * any connected client unless the connection is explicitly marked read-only —
 * which would make `/dash/collab` a second, unguarded write path into the
 * brain. "UX is not the security boundary" applies to the transport too.
 */
export function connectionMode(scopes: readonly Scope[] | readonly string[]): CollabConnectionMode {
  return scopes.includes("write") ? "rw" : "ro";
}
