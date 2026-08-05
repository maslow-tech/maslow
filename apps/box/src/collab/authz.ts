import type { Pool } from "pg";
import {
  connectionMode,
  isActive,
  probeJoin,
  readScopes,
  type CollabConnectionMode,
} from "./auth.js";
import { isRouteRoomName } from "./presence.js";
import { COLLAB_CLOSE, type CollabEvictReason, type CollabRefusal } from "./types.js";

/**
 * LIVE RE-AUTHORIZATION, and the INBOUND WRITE GATE.
 *
 * `auth.ts` answers "may this actor join this room, right now" once. This
 * module keeps answering it for as long as the socket is open, and refuses the
 * bytes a connection may not send.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A JOIN-TIME CHECK IS NOT A CHECK
 *
 * A doc room is held for as long as a tab is open — hours, a weekend, a laptop
 * lid. Everything the join gate proved is a statement about one instant:
 *
 *   09:00  Dana joins #roadmap. Member, write scope, org-visible object. Fine.
 *   09:05  Dana is offboarded (`revoke_user`), or demoted member→viewer, or the
 *          object is flipped org→private, or Dana is dropped from `shared_with`,
 *          or the object is trashed.
 *   17:00  Dana's laptop, still open on the doc, is still receiving every
 *          keystroke the rest of the team types, and — without the write gate —
 *          still typing into it. Nothing ever asked the database again.
 *
 * Offboarding somebody while their laptop is open on the doc is the concrete
 * trigger, and it is the case where being wrong is worst. So:
 *
 *  (a) EVERY 60s PER CONNECTION PER ROOM the join read AND the scopes/status
 *      read are re-run (`reauthorize`). Stated staleness bound: ≤60s. A
 *      connection that has lost read access is CLOSED; one that has only lost
 *      write scope is DOWNGRADED IN PLACE — it keeps reading, it stops writing.
 *  (b) `rooms.ts` carries the immediate path: the write that makes the change
 *      fires an eviction and the affected rooms close in that same breath.
 *      The 60s poll is the FLOOR, not the mechanism — it catches whatever the
 *      eviction hooks miss (a direct SQL edit, a restore from backup, a code
 *      path added later that forgets to fire).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "THE DATABASE SAID NO" IS NOT "THE DATABASE DID NOT ANSWER"
 *
 * Fail-closed cannot mean "evict everyone whenever Postgres blinks": a
 * five-second connection storm would empty every editor on the box and throw
 * away text that has not been flushed yet. It also cannot mean "carry on":
 * an unconfirmable principal is exactly the one we are worried about.
 *
 * The split is by consequence. A pass that cannot reach the database
 * IMMEDIATELY takes write away (`readOnly = true`) — so within one interval no
 * unconfirmed principal can put a byte into the brain, which is the property
 * that matters — and leaves the socket reading. If it still cannot confirm
 * after `REAUTH_UNCONFIRMED_GRACE_MS`, the connection is closed. Reading on for
 * a few minutes of content the principal already had in memory is a far smaller
 * harm than losing the last paragraph of everyone on the box.
 *
 * Design: docs/superpowers/specs/2026-07-21-workspace-ui-design.md, phase 2
 * ("Authorization is re-checked while the socket is open", "Auth is three
 * checks, not one" #3).
 */

/* ========================================================================== *
 * Cadence                                                                     *
 * ========================================================================== */

/** The stated bound. Do not raise it without restating the bound in the spec. */
export const REAUTH_INTERVAL_MS = 60_000;

/**
 * How long a connection may stay open while the database refuses to answer.
 * It is read-only for every second of that window (see the module comment), so
 * this bounds *reading*, not writing.
 */
const REAUTH_UNCONFIRMED_GRACE_MS = 5 * 60_000;

/* ========================================================================== *
 * The decision                                                                *
 * ========================================================================== */

type ReauthOutcome =
  /** still authorized; `mode` is the CURRENT write answer, not the join-time one. */
  | { readonly action: "keep"; readonly mode: CollabConnectionMode }
  /** the database answered, and the answer is no. */
  | { readonly action: "evict"; readonly reason: CollabEvictReason }
  /** the database did not answer. Not evidence of anything — see the module comment. */
  | { readonly action: "unconfirmed"; readonly detail: string };

/**
 * Re-run BOTH reads for one connection in one room.
 *
 * Account first: it is a single indexed row and it settles the cheaper, broader
 * question ("is this person still allowed to hold a socket at all"). Only then
 * the per-object RLS read, which costs a pooled connection and a transaction.
 *
 * The eviction reason for an object-level denial is ALWAYS `visibility_changed`,
 * never "deleted" or "unshared" — the probe cannot tell those apart (that is the
 * point: one answer for "cannot see it" and "does not exist"), and the reason
 * travels to the client in the close frame. Guessing would leak whether a
 * private object still exists.
 */
export async function reauthorize(
  pool: Pool,
  actorId: string,
  objectId: string,
): Promise<ReauthOutcome> {
  let access: Awaited<ReturnType<typeof readScopes>>;
  try {
    access = await readScopes(pool, actorId);
  } catch (err) {
    return { action: "unconfirmed", detail: `account read failed: ${String(err)}` };
  }
  // A row that is GONE is a definite answer, not an outage: the account was
  // deleted. Same for a status that is no longer active (revoked, suspended).
  if (!access || !isActive(access)) return { action: "evict", reason: "access_revoked" };

  // A ROUTE (presence-only) room has NO object to authorize against — its join
  // gate (`authorizeRoom` in wire.ts) runs the account check ONLY and skips
  // `canJoin`. Re-derive it the same way here: running the object-visibility
  // probe against a non-uuid `route:<screen>` name makes `probeJoin` return
  // "denied", which would evict every presence connection every ≤60s and tear
  // down the presence rail on every non-editor screen fleet-wide. A route room
  // carries NO document (it rides the stateless presence channel), so every
  // connection is read-only: hocuspocus then silently drops any sync update a
  // client tries to push into it, and the write gate exempts route rooms so the
  // read-only status never closes the connection.
  if (isRouteRoomName(objectId)) return { action: "keep", mode: "ro" };

  const join = await probeJoin(pool, actorId, objectId);
  if (join === "unavailable") return { action: "unconfirmed", detail: "join probe unavailable" };
  if (join === "denied") return { action: "evict", reason: "visibility_changed" };

  return { action: "keep", mode: connectionMode(access.scopes) };
}

/* ========================================================================== *
 * The loop                                                                    *
 * ========================================================================== */

/**
 * One live (socket, document) pair, reduced to what re-authorization needs.
 *
 * Deliberately NOT a hocuspocus `Connection`: the decision logic must be
 * testable without a websocket, a document or a server, and the adapter that
 * produces these from hocuspocus lives in `rooms.ts`.
 */
export interface LiveCollabConnection {
  readonly objectId: string;
  readonly actorId: string;
  /**
   * STABLE identity of the underlying connection across passes — the adapter
   * builds a fresh wrapper every time, so the wrapper itself cannot be the key.
   * Held in a WeakMap, so a closed connection's bookkeeping is collected with
   * it and the loop cannot leak.
   */
  readonly ref: object;
  /** true ⇒ the connection may read but not write. Assignment takes effect live. */
  readOnly: boolean;
  close(refusal: CollabRefusal): void;
}

/** What a pass did to a connection — logging and tests, never the client. */
export type ReauthEvent =
  | { readonly kind: "downgraded"; readonly objectId: string; readonly actorId: string }
  | {
      readonly kind: "evicted";
      readonly objectId: string;
      readonly actorId: string;
      readonly reason: CollabEvictReason;
    }
  | {
      readonly kind: "unconfirmed";
      readonly objectId: string;
      readonly actorId: string;
      readonly detail: string;
    };

interface ReauthLoopOptions {
  readonly pool: Pool;
  /** enumerate the live (socket, document) pairs. Called fresh every pass. */
  readonly connections: () => Iterable<LiveCollabConnection>;
  readonly intervalMs?: number | undefined;
  readonly unconfirmedGraceMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly onEvent?: ((event: ReauthEvent) => void) | undefined;
}

interface ReauthLoop {
  start(): void;
  stop(): void;
  /** one pass, awaited. The timer calls this; tests call it directly. */
  runOnce(): Promise<void>;
}

export function createReauthLoop(opts: ReauthLoopOptions): ReauthLoop {
  const intervalMs = opts.intervalMs ?? REAUTH_INTERVAL_MS;
  const graceMs = opts.unconfirmedGraceMs ?? REAUTH_UNCONFIRMED_GRACE_MS;
  const now = opts.now ?? ((): number => Date.now());
  const emit = (event: ReauthEvent): void => {
    try {
      opts.onEvent?.(event);
    } catch {
      /* an observer must never break the loop */
    }
  };

  /** When each connection first failed to be confirmed. Cleared on any answer. */
  const unconfirmedSince = new WeakMap<object, number>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const runOnce = async (): Promise<void> => {
    // A pass that overruns its interval must not stack: two concurrent passes
    // would double every read against a database that is evidently already slow.
    if (running) return;
    running = true;
    try {
      const live = [...opts.connections()];
      if (live.length === 0) return;

      // One answer per (actor, object) per pass. A room with eight people in it
      // is eight connections but at most eight account reads and eight join
      // reads — and a person with the same doc open in three tabs costs one of
      // each. Cached WITHIN a pass only: the whole point is freshness.
      const cache = new Map<string, Promise<ReauthOutcome>>();
      const decide = (actorId: string, objectId: string): Promise<ReauthOutcome> => {
        const key = `${actorId} ${objectId}`;
        let pending = cache.get(key);
        if (!pending) {
          pending = reauthorize(opts.pool, actorId, objectId);
          cache.set(key, pending);
        }
        return pending;
      };

      await Promise.all(
        live.map(async (conn) => {
          let outcome: ReauthOutcome;
          try {
            outcome = await decide(conn.actorId, conn.objectId);
          } catch (err) {
            // reauthorize() catches its own reads; anything reaching here is a
            // bug, and a bug must not become an "allow".
            outcome = { action: "unconfirmed", detail: `re-check threw: ${String(err)}` };
          }

          if (outcome.action === "evict") {
            unconfirmedSince.delete(conn.ref);
            emit({
              kind: "evicted",
              objectId: conn.objectId,
              actorId: conn.actorId,
              reason: outcome.reason,
            });
            // Take write away BEFORE closing: `close` is asynchronous down at
            // the socket, and a message already queued must not be applied on
            // its way out.
            conn.readOnly = true;
            conn.close({ code: COLLAB_CLOSE.EVICTED, reason: outcome.reason });
            return;
          }

          if (outcome.action === "unconfirmed") {
            const first = unconfirmedSince.get(conn.ref);
            if (first === undefined) {
              unconfirmedSince.set(conn.ref, now());
            } else if (now() - first >= graceMs) {
              unconfirmedSince.delete(conn.ref);
              emit({
                kind: "evicted",
                objectId: conn.objectId,
                actorId: conn.actorId,
                reason: "access_revoked",
              });
              conn.readOnly = true;
              conn.close({ code: COLLAB_CLOSE.EVICTED, reason: "access_revoked" });
              return;
            }
            emit({
              kind: "unconfirmed",
              objectId: conn.objectId,
              actorId: conn.actorId,
              detail: outcome.detail,
            });
            // Unconfirmed ⇒ no writes, immediately. Reading continues until the
            // grace runs out.
            if (!conn.readOnly) conn.readOnly = true;
            return;
          }

          unconfirmedSince.delete(conn.ref);
          if (outcome.mode === "ro" && !conn.readOnly) {
            conn.readOnly = true;
            emit({ kind: "downgraded", objectId: conn.objectId, actorId: conn.actorId });
          }
          // DELIBERATELY NEVER THE REVERSE. A connection is only ever moved
          // TOWARDS read-only here. Re-granting write would undo the drain
          // (SIGTERM marks every connection read-only precisely so nothing new
          // lands mid-flush) and would silently undo the unconfirmed downgrade
          // above. A genuine viewer→member promotion lands on the next join,
          // which is a reconnect away and costs the user nothing.
        }),
      );
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        void runOnce().catch((err: unknown) => {
          console.error("collab: re-authorization pass failed —", err);
        });
      }, intervalMs);
      // Never hold the process open for a re-check.
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    runOnce,
  };
}

/* ========================================================================== *
 * The inbound write gate                                                      *
 * ========================================================================== */

/**
 * Hocuspocus accepts updates from any connected client by default. Without a
 * gate, `/dash/collab` is a SECOND, UNGUARDED WRITE PATH into the brain: a
 * viewer (`scopes = ['read']`) legitimately joins a room they may read, types,
 * and the server-side flush persists it — as somebody else, because the flush
 * attributes content to whoever is in the room. "UX is not the security
 * boundary" applies to the transport, not only to endpoints.
 *
 * There are three lines here, and none of them is the other's excuse:
 *
 *  1. `connection.readOnly`, set from the account's CURRENT DB scopes at join
 *     and re-derived every ≤60s above. Hocuspocus's own `MessageReceiver`
 *     honours it and drops sync updates from a read-only connection.
 *  2. THIS gate, in `beforeHandleMessage`, which refuses the message outright
 *     rather than trusting (1) to keep behaving that way across a library
 *     upgrade — the update-dropping in (1) is an implementation detail of a
 *     dependency, not a contract we own.
 *  3. The flush's independent refusal of content with no attributable author.
 */

/** y-protocols/hocuspocus wire constants. Stable protocol numbering, not API. */
const MSG_SYNC = 0;
const MSG_SYNC_REPLY = 4;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

/**
 * Read a lib0 varuint. Returns the value and the offset just past it, or null
 * if the buffer ends mid-number.
 */
function readVarUint(data: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let i = at;
  while (i < data.length) {
    const byte = data[i] as number;
    value += (byte & 0x7f) * 2 ** shift;
    i += 1;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7;
    // A varuint longer than this is not a length we would ever emit; refuse
    // rather than loop on hostile input.
    if (shift > 35) return null;
  }
  return null;
}

/**
 * Does this raw client message carry a document mutation?
 *
 * The server sees `varString(documentName) + varUint(messageType) + …`, so the
 * document name is skipped by its length prefix and never decoded — we need the
 * type, not the name, and a room name is not ours to log.
 *
 * Only sync step-2 and sync-update mutate the doc. Awareness (cursors,
 * presence), queryAwareness, stateless and sync step-1 do not, and a read-only
 * participant must keep being able to send them — booting a viewer for moving
 * their cursor would be a bug wearing a security badge.
 *
 * Returns true for anything it cannot decode: an undecodable message from a
 * read-only connection is refused, because the alternative is deciding a
 * message is harmless on the strength of not understanding it.
 */
export function isDocumentMutation(data: Uint8Array): boolean {
  const nameLen = readVarUint(data, 0);
  if (!nameLen) return true;
  const typeAt = nameLen.next + nameLen.value;
  if (typeAt > data.length) return true;
  const type = readVarUint(data, typeAt);
  if (!type) return true;
  if (type.value !== MSG_SYNC && type.value !== MSG_SYNC_REPLY) return false;
  const sync = readVarUint(data, type.next);
  if (!sync) return true;
  return sync.value === SYNC_STEP_2 || sync.value === SYNC_UPDATE;
}

/**
 * The gate itself. `null` ⇒ let the message through.
 *
 * A refusal closes the connection (hocuspocus closes on a rejected
 * `beforeHandleMessage`, using the `code`/`reason` carried on the thrown
 * value). That is deliberate: an authorized read-only client marks its editor
 * non-editable and never sends an update, so a read-only connection that sends
 * one is a client that is not honouring its grant. Letting it keep trying
 * would be a silent retry loop against a gate that will never open.
 */
export function inboundWriteRefusal(input: {
  readonly readOnly: boolean;
  readonly message: Uint8Array;
  /** true for a `route:<screen>` presence room. */
  readonly isRouteRoom?: boolean;
}): CollabRefusal | null {
  // A route (presence-only) room carries NO document, and every connection to it
  // is read-only. Do NOT close it on a sync message: hocuspocus's MessageReceiver
  // already drops a read-only connection's sync step-2 / update SILENTLY (it
  // neither applies nor broadcasts them — verified in the vendored server), so
  // closing here would stop nothing and would only kill presence, whose provider
  // performs a document sync on connect (sync step-2 IS a document mutation).
  // That was the observed failure when route rooms were first marked read-only;
  // exempting the gate is what lets the read-only status hold without it.
  if (input.isRouteRoom) return null;
  if (!input.readOnly) return null;
  if (!isDocumentMutation(input.message)) return null;
  return { code: COLLAB_CLOSE.ROOM_FORBIDDEN, reason: "read-only connection" };
}
