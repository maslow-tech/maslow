import type { Hocuspocus } from "@hocuspocus/server";
import type { AccessChange, AccessChangeReason } from "@brain/mcp-tools";
import type { LiveCollabConnection } from "./authz.js";
import { evictCloseCode, type CollabEvictReason, type CollabPrincipal } from "./types.js";

/**
 * THE EVICTION PATH: how a write that changes who may see something reaches the
 * sockets that are streaming it, in the same breath, without a poll.
 *
 * The ≤60s re-check in `authz.ts` is the floor. This is the fast path, and the
 * two are not redundant: 60 seconds of a just-offboarded laptop receiving every
 * keystroke the team types is the exact window the design refuses to accept, and
 * a poll can only ever shrink it, never close it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A HUB AND NOT A DIRECT CALL
 *
 * The writes that change access are spread across two packages and three
 * surfaces — the MCP `edit`/`delete` tools, the dashboard's CAS `PATCH`, and
 * the admin member routes — and the thing that must react to them (the collab
 * server) is constructed after some of them and is absent entirely in tests,
 * in the CLI, and on a box where nobody has opened an editor. Threading a
 * server handle down every one of those paths would mean `packages/mcp-tools`
 * knowing what a websocket is.
 *
 * So the write paths announce, and the collab server subscribes. Unbound, an
 * announcement is a no-op — correct, not lossy: with no collab server there are
 * no rooms, and there is nothing to evict.
 *
 * IN-PROCESS ON PURPOSE, AND SOUND ONLY BECAUSE THE BOX IS ONE APP PROCESS —
 * the same standing assumption as the single-use ticket store (auth.ts). The
 * announcer (a Writer inside `brain-app-1`) and the subscriber (the collab
 * server inside `brain-app-1`) are the same process. If the box ever runs two
 * app processes, an eviction fired on process A would not reach a socket held
 * by process B, and this MUST become a LISTEN/NOTIFY (or equivalent) fan-out
 * before that happens. Treat it as a blocking prerequisite of any such change.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT AN EVICTION MAY SAY
 *
 * The close reason reaches a browser. It carries no content, no title, no actor
 * and no object id — just the class of change — and an object-level denial is
 * always reported as `visibility_changed`, never as the more specific
 * "deleted"/"unshared" the prober cannot actually distinguish. A room must
 * never reveal that a private object exists.
 *
 * Design invariant: authorization is re-checked while the socket is open.
 */

/* ========================================================================== *
 * The reason vocabulary is shared, and proven shared                          *
 * ========================================================================== */

/**
 * `packages/mcp-tools` cannot import a box type (it is the lower layer), so the
 * Writer declares its own copy of the reason union. This function is where the
 * two meet, and its SIGNATURE IS A COMPILE-TIME PROOF they have not drifted: if
 * the Writer ever announces a reason the collab close-code mapping does not
 * know, the build fails on the return statement below instead of a live socket
 * receiving a close frame the client cannot classify.
 */
export function evictReasonFor(reason: AccessChangeReason): CollabEvictReason {
  return reason;
}

/* ========================================================================== *
 * The hub                                                                     *
 * ========================================================================== */

/** What the collab server plugs in. Every method must be non-throwing. */
export interface CollabEvictionSink {
  /**
   * close every connection in this room, then drop the room. `actorId` is the
   * actor whose committed write triggered this — threaded down to the doc store's
   * purge so a narrowing eviction FLUSHES the still-authorized editors' text as
   * an actor who can still see the object (see `AccessChange.actorId`). Absent
   * for an internal eviction with no triggering write.
   */
  evictObject(objectId: string, reason: CollabEvictReason, actorId?: string): void;
  /**
   * close every connection HELD BY THIS ACCOUNT, in every room. Rooms with
   * other people in them stay up — offboarding one person must not interrupt
   * everyone else's editor.
   */
  evictActor(accountId: string, reason: CollabEvictReason): void;
  /** close everything (kill-switch flip, drain). */
  evictAll(reason: CollabEvictReason): void;
}

export class CollabEvictionHub {
  private sink: CollabEvictionSink | undefined;

  /**
   * Attach the collab server. Returns the detach function; the LAST bind wins,
   * and detaching a stale binding is a no-op (so an out-of-order teardown in a
   * test cannot silently unhook the live server).
   */
  bind(sink: CollabEvictionSink): () => void {
    this.sink = sink;
    return (): void => {
      if (this.sink === sink) this.sink = undefined;
    };
  }

  get bound(): boolean {
    return this.sink !== undefined;
  }

  /**
   * Every announcement is swallowed on error. An eviction is a consequence of a
   * write that has ALREADY COMMITTED — throwing here would surface a websocket
   * problem as a failed `edit` and, worse, could make a caller retry a write
   * that succeeded.
   */
  private fire(what: string, run: (sink: CollabEvictionSink) => void): void {
    const sink = this.sink;
    if (!sink) return;
    try {
      run(sink);
    } catch (err) {
      console.warn(`collab: ${what} eviction failed —`, String(err));
    }
  }

  /** an object's audience changed, or it was trashed. */
  object(objectId: string, reason: CollabEvictReason, actorId?: string): void {
    if (!objectId) return;
    this.fire("object", (sink) => sink.evictObject(objectId, reason, actorId));
  }

  /** an account was revoked, suspended or re-scoped. */
  actor(accountId: string, reason: CollabEvictReason): void {
    if (!accountId) return;
    this.fire("actor", (sink) => sink.evictActor(accountId, reason));
  }

  /** the box went off, or is shutting down. */
  all(reason: CollabEvictReason): void {
    this.fire("all", (sink) => sink.evictAll(reason));
  }
}

/**
 * The process-wide hub. One process, one collab server, one hub — see the
 * module comment for why that is sound and what breaks it.
 */
export const collabEvictions = new CollabEvictionHub();

/**
 * The `WriterOptions.onAccessChange` callback, ready to hand to `new Writer`.
 *
 * The Writer is the ONE seam every surface's access change passes through — the
 * MCP `edit` tool, the dashboard `PATCH`, `delete` — so hooking it here means a
 * new caller of `edit` gets eviction for free instead of having to remember.
 */
export function announceAccessChange(change: AccessChange): void {
  // Lowercase the id: every room map keys on the CANONICAL lowercase uuid
  // (the join gate refuses any other spelling), but this id arrives from the
  // write path's caller — an MCP `edit` accepts an uppercase spelling and
  // Postgres matches it case-insensitively. Announced verbatim, an uppercase
  // id would miss the live room entirely and the narrowing/unshare/trash
  // eviction (including the purge's flush-as-triggering-actor) would never
  // run, leaving the ≤60s reauth floor as the only line.
  collabEvictions.object(
    change.objectId.toLowerCase(),
    evictReasonFor(change.reason),
    change.actorId,
  );
}

/* ========================================================================== *
 * The hocuspocus adapter                                                      *
 * ========================================================================== */

/**
 * Minimal structural view of the hocuspocus connection this module touches.
 * Structural, not the imported `Connection` class, so the room index can be
 * exercised with a plain object in a test and so a field we do not use cannot
 * quietly become load-bearing.
 *
 * `readOnly` is declared `boolean` here while hocuspocus types it `Boolean`;
 * assignment of a primitive is what the library itself does, and narrowing it
 * keeps `LiveCollabConnection` honest.
 */
export interface RoomConnection {
  readOnly: boolean;
  context?: unknown;
  close(event?: { code: number; reason: string }): void;
}

/** The slice of hocuspocus the room index reads. */
export interface RoomIndexSource {
  readonly documents: Map<string, { getConnections(): RoomConnection[] }>;
}

/** Narrow the hocuspocus instance to what this module needs. */
export function roomIndexSource(hocuspocus: Hocuspocus): RoomIndexSource {
  return hocuspocus as unknown as RoomIndexSource;
}

function principalOf(connection: RoomConnection): CollabPrincipal | undefined {
  const ctx = connection.context as { principal?: CollabPrincipal } | undefined;
  return ctx?.principal;
}

/**
 * Every live (socket, document) pair, as the re-check loop wants them.
 *
 * A connection with NO PRINCIPAL is skipped rather than evicted: the upgrade
 * gate cannot produce one (it refuses a socket without a verified ticket) and
 * `onConnect` throws for one, so if it exists at all it is a hocuspocus
 * internal — a direct-connection handle, say — and it is not a browser we can
 * make a statement about. It is also, by the same argument, not a socket
 * streaming to a person.
 */
export function liveCollabConnections(source: RoomIndexSource): LiveCollabConnection[] {
  const out: LiveCollabConnection[] = [];
  for (const [objectId, doc] of source.documents) {
    for (const connection of doc.getConnections()) {
      const principal = principalOf(connection);
      if (!principal) continue;
      out.push({
        objectId,
        actorId: principal.actorId,
        // The hocuspocus Connection object IS the stable identity across
        // passes; this wrapper is rebuilt every time and must never be the key.
        ref: connection,
        get readOnly(): boolean {
          return connection.readOnly === true;
        },
        set readOnly(value: boolean) {
          connection.readOnly = value;
        },
        close(refusal): void {
          try {
            connection.close({ code: refusal.code, reason: refusal.reason });
          } catch {
            /* already gone */
          }
        },
      });
    }
  }
  return out;
}

/**
 * Close every connection this account holds, wherever it is, and report how
 * many. Rooms are NOT dropped: the other people in them still have every right
 * to be there, and tearing their room down would turn one person's offboarding
 * into everyone's lost paragraph.
 */
export function closeActorConnections(
  source: RoomIndexSource,
  accountId: string,
  reason: CollabEvictReason,
): number {
  if (!accountId) return 0;
  let closed = 0;
  const code = evictCloseCode(reason);
  for (const conn of liveCollabConnections(source)) {
    if (conn.actorId !== accountId) continue;
    // Write goes first and synchronously: `close` is asynchronous down at the
    // socket, and a message already in flight must not be applied on the way
    // out.
    conn.readOnly = true;
    conn.close({ code, reason });
    closed += 1;
  }
  return closed;
}
