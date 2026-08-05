import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer, type WebSocket } from "ws";
import type { Pool } from "pg";
import type { KillSwitchGate } from "../kill-switch.js";
import {
  COLLAB_CLOSE,
  COLLAB_PATH,
  collabAllowedHosts,
  evictCloseCode,
  handshakeDecision,
  type CollabEvictReason,
  type CollabPrincipal,
  type CollabReadiness,
  type CollabRooms,
} from "./types.js";
import { verifyTicket } from "./auth.js";
import {
  createReauthLoop,
  inboundWriteRefusal,
  REAUTH_INTERVAL_MS,
  type ReauthEvent,
} from "./authz.js";
import {
  closeActorConnections,
  collabEvictions,
  liveCollabConnections,
  roomIndexSource,
} from "./rooms.js";
import { isRouteRoomName } from "./presence.js";

/**
 * The box's collab (Yjs / Hocuspocus) websocket server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE UPGRADE PATH IS NOT HONO, AND INHERITS NONE OF HONO'S GATES.
 *
 * `serve({ fetch: app.fetch, port })` (apps/box/src/index.ts) returns the Node
 * http server; a websocket upgrade is delivered on that server's `upgrade`
 * event and never reaches `app.fetch`. So `app.use("*", killSwitch.middleware())`
 * (box.ts), the dashboard's session + CSRF checks, and the security headers all
 * apply to exactly zero bytes of this surface. Every one of those guarantees
 * has to be re-established HERE, by hand:
 *
 *  - the kill-switch is consulted on every handshake AND on a timer, so a box
 *    the booth suspended stops accepting edits and drops the sockets it already
 *    has. Without it a suspended box keeps taking keystrokes and flushing them
 *    into the customer's database while every HTTP surface correctly 503s, and
 *    the sticky-off latch means nothing for this surface;
 *  - a strict `Origin` allowlist stands in for CORS, which does not apply to
 *    websocket handshakes, and for the double-submit CSRF header, which a
 *    browser will not send on a websocket open. With `SameSite` cookies this is
 *    the only control against cross-site websocket hijacking;
 *  - the connection principal comes ONLY from a short-lived ticket minted by an
 *    authenticated HTTP request. Nothing the client asserts about itself is
 *    believed, and the session cookie is not accepted here at all (its key
 *    space and the ticket's are deliberately separate — see types.ts).
 *
 * Refusals close with a specific code + reason (COLLAB_CLOSE) so the client can
 * tell "box off" (wait and retry) from "unauthorized" (get a new ticket) from
 * "bad origin" (never retry — it is a bug or an attack).
 */

/**
 * Room-name prefix of the CANARY's synthetic room (`probeRoom`, below).
 *
 * Deliberately not a uuid: every real room is named by an object id, so this
 * name cannot collide with one, and any persistence hook keyed on object ids
 * skips it by construction (`isCollabProbeRoom`). A probe room holds no object,
 * no brain content, and is never written anywhere.
 */
const COLLAB_PROBE_PREFIX = "canary-probe:";

/** True for the canary's synthetic room — never an object id. */
export function isCollabProbeRoom(documentName: string): boolean {
  return documentName.startsWith(COLLAB_PROBE_PREFIX);
}

/** What a room authorizer grants for one document. `null` refuses the join. */
export interface CollabRoomGrant {
  /** true ⇒ the connection may read the room but not write into it. */
  readonly readOnly: boolean;
}

/**
 * Per-document authorization. Hocuspocus multiplexes documents over a single
 * socket and reads the document name out of the MESSAGE, not the URL, so this
 * cannot be folded into the handshake — it runs once per document per socket.
 *
 * The implementation must be an ACTUAL RLS-bound read as the joining actor
 * (`SELECT 1 FROM objects WHERE id = $1` in a transaction with
 * `app.actor_id` set), never a re-implementation of the visibility predicate in
 * application code: there is one visibility rule and it lives in Postgres.
 * The pool is handed in so the authorizer needs no separate plumbing.
 */
export type AuthorizeCollabRoom = (ctx: {
  readonly pool: Pool;
  readonly principal: CollabPrincipal;
  readonly objectId: string;
}) => Promise<CollabRoomGrant | null> | CollabRoomGrant | null;

export interface CollabServerOptions {
  /** brain_app pool — the room authorizer's and (later) the blob store's handle. */
  readonly pool: Pool;
  /** the dashboard session secret; the ticket key is derived from it. */
  readonly sessionSecret: string;
  /** the SAME gate the Hono middleware uses. Absent (dev) ⇒ ungated, as elsewhere. */
  readonly killSwitch?: KillSwitchGate | undefined;
  /** the box's own public URL or host — the Origin allowlist. */
  readonly publicHost?: string | undefined;
  /** extra allowed origins (comma-separated env, split by the caller). */
  readonly allowedOrigins?: readonly string[] | undefined;
  /** websocket path; defaults to /dash/collab. */
  readonly path?: string | undefined;
  /**
   * Per-document join check. Left unset the server is FAIL-CLOSED: every room
   * join is refused. A skeleton that accepted joins would be an unguarded
   * second write path into the brain, so "not wired yet" must mean "refuses",
   * never "allows".
   */
  readonly authorizeRoom?: AuthorizeCollabRoom | undefined;
  /** how often the kill-switch is re-checked for LIVE sockets (ms). */
  readonly killPollMs?: number | undefined;
  /**
   * how often EVERY live connection's authorization is re-derived from the
   * database (ms). Defaults to `REAUTH_INTERVAL_MS`; the design states a ≤60s
   * staleness bound, so raising it changes a published guarantee.
   */
  readonly reauthIntervalMs?: number | undefined;
  /** re-check observations (downgrade/evict/unconfirmed) — logging and tests. */
  readonly onReauthEvent?: ((event: ReauthEvent) => void) | undefined;
  /**
   * Drop a room's persisted state — the doc store's `purge`. Wired by the task
   * that assembles the store; absent, an eviction still closes every socket and
   * unloads the in-memory document.
   *
   * Whether it flushes first depends on the reason. A DELETE ('deleted') does
   * NOT flush — that would resurrect content into an object the user just
   * trashed. But an audience NARROWING ('visibility_changed' to private, or a
   * dropped shared reader) leaves the object — and its still-authorized editors
   * — in place, so `purge` flushes their unflushed body edits before dropping
   * the room (see docStore.purge). Without that flush the creator and remaining
   * readers silently lose whatever they had typed since the last flush.
   */
  readonly purgeRoom?:
    ((objectId: string, reason: CollabEvictReason, actorId?: string) => Promise<void>) | undefined;
  /** flush hook, filled in by the persistence task; awaited during a drain. */
  readonly flushRoom?: ((objectId: string) => Promise<void>) | undefined;
  /** upper bound on a drain, so a wedged flush cannot outlive the stop grace. */
  readonly drainTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** Minimal shape of the Node server we attach to (http or http2). */
export interface UpgradeCapableServer {
  on(
    event: "upgrade",
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
  listenerCount(event: string): number;
}

export interface CollabServer {
  /** hook the collab surface onto the running Node server's `upgrade` event. */
  attach(server: UpgradeCapableServer): void;
  /** the live-room set the dashboard's `open_in_editor` guard consults. */
  readonly rooms: CollabRooms;
  /**
   * drop a room right now — visibility change, unshare, delete. `actorId` is the
   * actor whose write triggered it, threaded to `purgeRoom` so a narrowing
   * eviction flushes as an actor who can still see the object; omitted for an
   * internal eviction (idle teardown, box-off).
   */
  evict(objectId: string, reason: CollabEvictReason, actorId?: string): void;
  /** drop ONE account's connections everywhere, leaving the rooms up. */
  evictActor(accountId: string, reason: CollabEvictReason): void;
  /** run a re-authorization pass now, awaited. The timer's manual form. */
  reauthNow(): Promise<void>;
  /**
   * The post-swap canary's collab probe: open and close ONE synthetic room,
   * in-process, and report whether the machinery worked. See `probeRoom` below
   * for why it touches neither the database nor the kill-switch.
   */
  probeRoom(): Promise<boolean>;
  /** stop accepting, flush every live room, close every socket. */
  drainAll(): Promise<void>;
  /** drain, then tear down hocuspocus and the timers. */
  close(): Promise<void>;
  /** `/healthz` readiness: not-ready as soon as the socket stops accepting. */
  readiness(): CollabReadiness;
  /** the hocuspocus instance — the seam later tasks hang extensions on. */
  readonly hocuspocus: Hocuspocus;
}

const DEFAULT_KILL_POLL_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
/** One update message ceiling. A doc room on a t3-class box is not a file upload. */
const MAX_PAYLOAD_BYTES = 1_000_000;

export function createCollabServer(opts: CollabServerOptions): CollabServer {
  const path = opts.path ?? COLLAB_PATH;
  const allowedHosts = collabAllowedHosts(opts.publicHost, opts.allowedOrigins);
  const now = opts.now ?? ((): number => Date.now());
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  if (allowedHosts.length === 0) {
    console.warn(
      "collab: no public host configured — websocket origins are accepted only when they " +
        "match the request's own Host (loopback-to-loopback in dev). Set BRAIN_PUBLIC_URL.",
    );
  }
  if (!opts.authorizeRoom) {
    console.warn(
      "collab: no room authorizer wired — every room join will be refused (fail-closed skeleton).",
    );
  }

  // `noServer`: WE own the upgrade, so the gate runs before ws ever sees it.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  const hocuspocus = new Hocuspocus({
    name: "brain-collab",
    quiet: true,
    // The box entrypoint owns SIGTERM (drainAndExit): it flushes the call-audit
    // queue AND drains rooms before exiting. Hocuspocus's own signal handler
    // would race that and process.exit(0) out from under it.
    stopOnSignals: false,
    onConnect: async ({ documentName, context, connection }) => {
      const principal = (context as { principal?: CollabPrincipal }).principal;
      if (isCollabProbeRoom(documentName)) {
        // The canary's synthetic room. It is opened IN-PROCESS with no
        // principal, holds no object, and is never persisted — so it must not
        // reach the authorizer (which would need an actor and a real object id
        // and would refuse it). A SOCKET that names one is a client guessing at
        // internals: refuse it with the same answer every unavailable room
        // gets, so a probe room can never become a shared scratch document.
        if (principal) throw { code: COLLAB_CLOSE.ROOM_FORBIDDEN, reason: "not available" };
        connection.readOnly = true;
        return;
      }
      if (!principal) {
        // Unreachable via attach() (the handshake gate sets it), but a direct
        // handleConnection caller must not get an anonymous room.
        throw { code: COLLAB_CLOSE.UNAUTHORIZED, reason: "no connection principal" };
      }
      const grant = opts.authorizeRoom
        ? await opts.authorizeRoom({ pool: opts.pool, principal, objectId: documentName })
        : null;
      if (!grant) {
        // One answer for "cannot see it" and "does not exist" — a room must
        // never reveal that a private object exists.
        throw { code: COLLAB_CLOSE.ROOM_FORBIDDEN, reason: "not available" };
      }
      connection.readOnly = grant.readOnly;
    },
    // ------------------------------------------------------ inbound write gate
    //
    // Hocuspocus accepts updates from any connected client by default. Without
    // this, `/dash/collab` is a SECOND, UNGUARDED WRITE PATH into the brain: a
    // viewer legitimately joins a room they may read, types, and the flush
    // persists it — attributed to whoever else is in the room. The connection's
    // `readOnly` flag comes from the account's CURRENT DB scopes (at join, and
    // re-derived every ≤60s by the loop below), never from the ticket and never
    // from the UI's idea of the role.
    //
    // The refusal is confined to messages that actually MUTATE the document.
    // Awareness (cursors, presence) must keep flowing from a read-only
    // participant — booting a viewer for moving their cursor would be a bug
    // wearing a security badge.
    //
    // A rejected `beforeHandleMessage` makes hocuspocus close the connection
    // with the `code`/`reason` carried on the thrown value; both are ours.
    beforeHandleMessage: async ({ connection, update, documentName }) => {
      const refusal = inboundWriteRefusal({
        readOnly: connection?.readOnly === true,
        message: update,
        isRouteRoom: isRouteRoomName(documentName),
      });
      if (refusal) throw refusal;
    },
    // A tripwire, not a gate — by the time `onChange` runs the update is
    // already in the doc. It can only fire if BOTH lines above failed at once
    // (our refusal and hocuspocus's own read-only drop), which would mean the
    // library's semantics changed under us. Close the connection and say so
    // loudly; the flush's independent attribution check is the last line.
    onChange: async ({ transactionOrigin, documentName }) => {
      const origin = transactionOrigin as { readOnly?: unknown; close?: unknown } | null;
      if (!origin || origin.readOnly !== true) return;
      console.error(
        `collab: a read-only connection mutated ${documentName} — the inbound write gate did not hold`,
      );
      if (typeof origin.close === "function") {
        (origin as { close: (e: { code: number; reason: string }) => void }).close({
          code: COLLAB_CLOSE.ROOM_FORBIDDEN,
          reason: "read-only connection",
        });
      }
    },
  });

  /** Every socket we accepted, including ones that have not joined a document. */
  const sockets = new Set<WebSocket>();
  let accepting = true;
  let attached: UpgradeCapableServer | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const closeSocket = (ws: WebSocket, code: number, reason: string): void => {
    try {
      ws.close(code, reason);
    } catch {
      /* already gone */
    }
  };

  /** Close every live socket (joined or not) with one code. */
  const closeAllSockets = (code: number, reason: string): void => {
    for (const [name, doc] of hocuspocus.documents) {
      // Same reason as `evictAll`: the canary's in-process probe room is not a
      // person's session, and a suspended box must not fail the collab probe.
      if (isCollabProbeRoom(name)) continue;
      for (const connection of doc.getConnections()) {
        try {
          connection.close({ code, reason });
        } catch {
          /* already gone */
        }
      }
    }
    for (const ws of sockets) closeSocket(ws, code, reason);
    sockets.clear();
  };

  const rooms: CollabRooms = {
    has: (objectId: string): boolean => hocuspocus.documents.has(objectId),
    get size(): number {
      return hocuspocus.documents.size;
    },
  };

  const evict = (objectId: string, reason: CollabEvictReason, actorId?: string): void => {
    const doc = hocuspocus.documents.get(objectId);
    if (!doc) return;
    const code = evictCloseCode(reason);
    for (const connection of doc.getConnections()) {
      // Read-only FIRST, and synchronously: `close` is asynchronous down at the
      // socket, and a message already queued must not be applied on the way out.
      connection.readOnly = true;
      try {
        connection.close({ code, reason });
      } catch {
        /* already gone */
      }
    }
    // Drop the in-memory room too, so `rooms.has` goes false immediately and a
    // rejoin re-runs the join check instead of resuming the old grant. Whether
    // the persisted state is flushed first depends on the reason — a delete
    // does not, an audience narrowing does. See `purgeRoom`. `actorId` is the
    // triggering writer: on a narrowing eviction the flush must run as an actor
    // who can still see the object, or it silently no-ops and drops the
    // still-authorized editors' unflushed text.
    void (async (): Promise<void> => {
      if (opts.purgeRoom) await opts.purgeRoom(objectId, reason, actorId);
      await hocuspocus.unloadDocument(doc);
    })().catch((err: unknown) => {
      console.warn(`collab: unload after evict failed (${String(err)})`);
    });
  };

  const evictAll = (reason: CollabEvictReason): void => {
    for (const name of [...hocuspocus.documents.keys()]) {
      // The canary's probe room is skipped on purpose. Eviction fires when the
      // box is suspended, and a suspended box must not fail the post-swap
      // collab probe — that would make a killed box condemn every release the
      // fleet ships. The probe reports on the MACHINERY, not on the gate.
      if (isCollabProbeRoom(name)) continue;
      evict(name, reason);
    }
  };

  /**
   * Everything, including sockets that have not joined a document.
   *
   * `evictAll` alone would leave those open: they hold no room, so they iterate
   * over nothing — and a socket with a live handshake but no room is exactly
   * what an editor tab looks like in the second before it joins. The box going
   * off has to take those too, or a suspended box would still be handing out
   * rooms a moment later.
   */
  const evictEverything = (reason: CollabEvictReason, detail?: string): void => {
    evictAll(reason);
    closeAllSockets(evictCloseCode(reason), detail ?? reason);
  };

  /**
   * Close one ACCOUNT's connections, everywhere, leaving the rooms up.
   *
   * This is the offboarding path (`revoke_user`, a suspension, a demotion), and
   * it is deliberately not `evict`: the other people in those rooms have every
   * right to be there, and turning one person's revocation into everyone's
   * dropped socket — and, with it, everyone's unflushed paragraph — would be a
   * worse outage than the one it prevents.
   */
  const evictActor = (accountId: string, reason: CollabEvictReason): void => {
    const closed = closeActorConnections(roomIndexSource(hocuspocus), accountId, reason);
    if (closed > 0) {
      console.warn(`collab: closed ${closed} connection(s) for a revoked/changed account`);
    }
  };

  // The write paths announce, we subscribe: a visibility flip, an unshare, a
  // trash or a revocation reaches the sockets in the same breath as the commit,
  // instead of waiting up to a minute for the re-check below. See rooms.ts.
  const unbindEvictions = collabEvictions.bind({
    evictObject: evict,
    evictActor,
    evictAll: evictEverything,
  });

  /**
   * The FLOOR under all of that: every ≤60s, every live connection's
   * authorization is re-derived from the database — the join read AND the
   * scopes/status read, as the actor. It is not redundant with the eviction
   * hooks, it is what makes them non-load-bearing: a direct SQL edit, a restore
   * from backup, or a write path added later that forgets to announce is caught
   * here within the stated bound.
   */
  const reauth = createReauthLoop({
    pool: opts.pool,
    connections: () => liveCollabConnections(roomIndexSource(hocuspocus)),
    intervalMs: opts.reauthIntervalMs ?? REAUTH_INTERVAL_MS,
    ...(opts.now ? { now: opts.now } : {}),
    onEvent: (event) => {
      if (event.kind === "evicted") {
        console.warn(`collab: re-check evicted a connection (${event.reason})`);
      } else if (event.kind === "unconfirmed") {
        console.warn(`collab: re-check could not confirm access — ${event.detail}`);
      }
      opts.onReauthEvent?.(event);
    },
  });

  // ---------------------------------------------------------- upgrade handler

  const refuse = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    code: number,
    reason: string,
  ): void => {
    // Complete the handshake, then close with our code. A pre-handshake
    // `HTTP/1.1 403` would collapse every refusal into the browser's opaque
    // 1006, and the client could not tell "box off" (retry) from "bad origin"
    // (never retry). Nothing is read from or written to the socket in between:
    // no message handler is attached, no document is loaded, no principal
    // exists, so a cross-site opener gains exactly nothing.
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        closeSocket(ws, code, reason);
      });
    } catch {
      socket.destroy();
    }
  };

  const handleUpgrade = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://box.invalid");
    } catch {
      socket.destroy();
      return;
    }
    const mine = url.pathname === path || url.pathname.startsWith(`${path}/`);
    if (!mine) {
      // Someone else may own this upgrade. Only refuse it when we are the sole
      // listener — otherwise a second websocket surface would be killed by us.
      if (!attached || attached.listenerCount("upgrade") <= 1) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
      return;
    }

    // The kill-switch answer is the SAME one the Hono middleware gates every
    // request with — same gate object, same ~5s lease cache, same fail-closed
    // semantics. `allowed()` may refresh over the network; a rejected promise
    // must fail CLOSED, not throw out of an event handler.
    let boxOn = true;
    if (opts.killSwitch) {
      try {
        boxOn = await opts.killSwitch.allowed();
      } catch {
        boxOn = false;
      }
    }

    const gates = {
      accepting,
      boxOn,
      origin: req.headers.origin,
      requestHost: req.headers.host,
      allowedHosts,
    };

    // Run the non-credential gates FIRST, with no principal. `handshakeDecision`
    // checks the ticket last, so anything other than UNAUTHORIZED here means
    // draining / box-off / bad-origin refused this handshake before credentials
    // mattered — and we must not touch the ticket at all in that case: verifying
    // it SPENDS it (below), and a cross-site opener or a suspended box would
    // otherwise burn a ticket the legitimate tab is about to use.
    const preflight = handshakeDecision({ ...gates, principal: null });
    if (!preflight.ok && preflight.code !== COLLAB_CLOSE.UNAUTHORIZED) {
      refuse(req, socket, head, preflight.code, preflight.reason);
      return;
    }

    const decision = handshakeDecision({
      ...gates,
      // `verifyTicket` (auth.ts), NOT the raw `verifyCollabTicket`: the crypto
      // check alone leaves a ticket replayable for its whole TTL by anyone who
      // read it out of a proxy access log (it rides in the URL query string).
      // This SPENDS the jti, so a second use of the same ticket is refused as
      // UNAUTHORIZED — indistinguishable, to a probe, from a forged one.
      principal: verifyTicket(opts.sessionSecret, url.searchParams.get("ticket"), {
        now: now(),
      }),
    });

    if (!decision.ok) {
      refuse(req, socket, head, decision.code, decision.reason);
      return;
    }

    const principal = decision.principal;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.once("close", () => sockets.delete(ws));
      ws.on("error", () => {
        /* a socket error must never take the box down */
      });
      // The principal rides in the hocuspocus context, so every hook (join,
      // the periodic re-check, the flush) attributes to ONE actor.
      hocuspocus.handleConnection(ws, req, { principal });
    });
  };

  const attach = (server: UpgradeCapableServer): void => {
    if (attached) throw new Error("collab: already attached to a server");
    attached = server;
    server.on("upgrade", (req, socket, head) => {
      void handleUpgrade(req, socket, head).catch((err: unknown) => {
        console.error("collab: upgrade handler failed —", err);
        socket.destroy();
      });
    });

    // Authorization is re-derived for every live connection from here on. Not
    // started in the constructor: an unattached server has no sockets, and a
    // test that builds one must not acquire a database connection for nothing.
    reauth.start();

    // A handshake-time check is not enough: a room can be held open for hours.
    // Poll the same gate the upgrade handler consults — the SAME KillSwitchGate
    // object, so it is the same lease-cached answer, not a second opinion — and
    // drop every socket the moment the box goes off.
    const killSwitch = opts.killSwitch;
    if (killSwitch) {
      const period = opts.killPollMs ?? DEFAULT_KILL_POLL_MS;
      killTimer = setInterval(() => {
        void (async (): Promise<void> => {
          let on = true;
          try {
            on = await killSwitch.allowed();
          } catch {
            on = false;
          }
          if (!on && (hocuspocus.documents.size > 0 || sockets.size > 0)) {
            console.warn("collab: box is off — closing live rooms");
            evictEverything("box_off", "box is off or unreachable");
          }
        })();
      }, period);
      killTimer.unref();
    }
  };

  // -------------------------------------------------------------- canary probe

  /** A wedged probe must never hold `/canary` open — it is a health endpoint. */
  const PROBE_TIMEOUT_MS = 3_000;

  const withProbeTimeout = async <T>(work: Promise<T>, what: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`collab probe: ${what} exceeded ${PROBE_TIMEOUT_MS}ms`)),
            PROBE_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * THE UPDATER'S POST-SWAP COLLAB PROBE (`/canary` → `collabOk`).
   *
   * Before this existed the canary exercised an HTTP write only, so a release
   * that broke the websocket surface — a bad hocuspocus/yjs upgrade, a broken
   * bundle, a module that throws on first document — passed the canary and was
   * never rolled back, on every box in the fleet.
   *
   * What it does: opens ONE synthetic room in-process, checks it materialized,
   * closes it. That exercises hocuspocus, the document machinery and the Yjs
   * codec — the parts a broken build breaks — and nothing else. In particular:
   *
   *  - it writes NO brain content and creates no object. The room name is not an
   *    object id (`COLLAB_PROBE_PREFIX`), there is no persistence hook for it,
   *    and the doc is never mutated, so nothing can be flushed anywhere. This
   *    runs on production boxes, where synthetic data in the brain is forbidden;
   *  - it never reaches the room authorizer or the database: no actor exists to
   *    authorize, and a probe that needed one would be reporting on RLS rather
   *    than on the build;
   *  - it does NOT consult the kill-switch, and the eviction paths skip probe
   *    rooms. `/canary` deliberately bypasses the gate (an intentionally-off box
   *    is not a broken deploy); if the probe failed on a suspended box, one
   *    killed box would condemn — and roll back — every release the fleet ships.
   *    Probe the machinery, not the gate.
   */
  const probeRoom = async (): Promise<boolean> => {
    // A fresh name per probe: overlapping probes (a canary sample racing the
    // updater's heartbeat) must not tear down each other's room.
    const name = `${COLLAB_PROBE_PREFIX}${randomUUID()}`;
    let connection: { disconnect(): Promise<unknown> | unknown } | undefined;
    try {
      connection = (await withProbeTimeout(
        Promise.resolve(hocuspocus.openDirectConnection(name, {})),
        "open",
      )) as unknown as { disconnect(): Promise<unknown> | unknown };
      const opened = hocuspocus.documents.has(name);
      await withProbeTimeout(Promise.resolve(connection.disconnect()), "close");
      connection = undefined;
      return opened;
    } catch (err) {
      console.error("collab: canary room probe failed —", err);
      return false;
    } finally {
      // Belt and braces on every path (including the timeout one): a probe must
      // not leak a connection or a room into a long-running process.
      if (connection) {
        await Promise.resolve(connection.disconnect()).catch(() => {
          /* already gone */
        });
      }
      const leaked = hocuspocus.documents.get(name);
      if (leaked) {
        await hocuspocus.unloadDocument(leaked).catch(() => {
          /* already gone */
        });
      }
    }
  };

  // ------------------------------------------------------------------- drain

  /**
   * SIGTERM path. The flush cadence means a live room can hold up to ~30s of
   * typed text in process memory only, and the updater recreates this container
   * on EVERY release — so a drain that skipped the flush would silently eat the
   * last paragraph of everyone who was typing, on every box, on every release.
   *
   * Order: stop accepting (→ `/healthz` not-ready) → mark every live connection
   * read-only so nothing new lands mid-flush → flush → close.
   */
  const drainAll = async (): Promise<void> => {
    accepting = false;
    for (const doc of hocuspocus.documents.values()) {
      for (const connection of doc.getConnections()) connection.readOnly = true;
    }
    // A probe room is not a document: it has no object, no blob and nothing to
    // flush, and handing its synthetic name to `flushRoom` would ask the write
    // path to persist a room that does not exist.
    const names = [...hocuspocus.documents.keys()].filter((n) => !isCollabProbeRoom(n));
    const flushRoom = opts.flushRoom;
    if (flushRoom && names.length > 0) {
      const flushes = Promise.allSettled(names.map((name) => flushRoom(name)));
      const bound = new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs).unref());
      const outcome = await Promise.race([flushes, bound]);
      if (Array.isArray(outcome)) {
        for (const r of outcome) {
          if (r.status === "rejected") console.error("collab: drain flush failed —", r.reason);
        }
      } else {
        console.error(`collab: drain flush exceeded ${drainTimeoutMs}ms — closing anyway`);
      }
    }
    closeAllSockets(COLLAB_CLOSE.DRAINING, "box restarting; reconnect shortly");
  };

  const close = async (): Promise<void> => {
    // Unhook FIRST: a write racing the shutdown must not find a half-torn-down
    // server, and an announcement with nothing to evict is a no-op by design.
    unbindEvictions();
    reauth.stop();
    await drainAll();
    if (killTimer) clearInterval(killTimer);
    killTimer = undefined;
    // hocuspocus.destroy() resolves only once every document has unloaded;
    // bound it so a wedged extension cannot outlive the compose stop grace.
    const bound = new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs).unref());
    await Promise.race([
      hocuspocus.destroy().catch((err: unknown) => {
        console.warn("collab: destroy failed —", String(err));
      }),
      bound,
    ]);
    wss.close();
  };

  return {
    attach,
    rooms,
    evict,
    evictActor,
    reauthNow: reauth.runOnce,
    probeRoom,
    drainAll,
    close,
    readiness: (): CollabReadiness =>
      accepting ? { ready: true } : { ready: false, reason: "collab draining" },
    hocuspocus,
  };
}
