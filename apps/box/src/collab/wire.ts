/**
 * THE PRODUCTION COLLAB WIRING — the one place the collab parts are assembled.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * Every piece of the multiplayer stack had a home before this file did: the
 * websocket surface and its gates (`server.ts`), the room lifecycle
 * (`docStore.ts`), the CRDT → CAS write (`flush.ts`), the agent-write bridge
 * (`bridge.ts`), the presence relay (`presence.ts`), the join reads
 * (`auth.ts`). What did NOT have a home was the ASSEMBLY — and the assembly is
 * the product. Without it `createCollabServer` runs with no `authorizeRoom`,
 * which is deliberately fail-closed, so a shipped box logs
 *
 *   "collab: no room authorizer wired — every room join will be refused"
 *
 * and refuses every join, forever. Two browsers on the same object diverge and
 * neither ever knows. That is exactly what happened: the wiring lived only
 * inside two integration tests, which built their own stacks and therefore
 * proved the parts worked while proving nothing about the box.
 *
 * So: the assembly is a module, `index.ts` calls it, the dev harness calls it,
 * and the integration suites call it. There is one wiring and everything —
 * production, dev, and every test that claims collab works — exercises it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS ASSEMBLED, AND THE ORDER IT MUST BE ASSEMBLED IN
 *
 * The parts reference each other in a cycle (server → flush, store → flush,
 * flush → store, store → server), so they are constructed in dependency order
 * and every back-reference lives inside a closure that runs long after
 * construction. That is not a style choice; a direct reference cannot be
 * written at all.
 *
 *   1. `createCollabServer` — the socket, the handshake gates, the authorizer.
 *   2. `createDocStore`     — rooms, seeding, snapshots, teardown.
 *   3. `createFlushPipeline`— CRDT → markdown → the SAME CAS write as everyone.
 *   4. `createAgentWriteBridge` — external writes appear in open rooms.
 *   5. the hocuspocus extension that binds (1) to (2)/(3), plus the presence
 *      relay for `route:` rooms.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PRIVACY INVARIANT, RESTATED AT THE ASSEMBLY POINT
 *
 * Two rules survive being wired together, and this file is where they could be
 * lost:
 *
 *  - **The join read is an RLS-bound read as the joiner** (`canJoin`), never a
 *    re-implementation of the 0012 predicate. One answer for "cannot see it"
 *    and "does not exist".
 *  - **Route-room presence never carries an object id the recipient cannot
 *    see.** The relay's `visibleTo` here is a real per-recipient RLS read; it
 *    fails CLOSED (an error resolves to "sees nothing"), because the failure
 *    mode of the alternative is revealing that a private object exists.
 */
import type { Pool } from "pg";
import * as Y from "yjs";
import { parseOrigin, type Writer } from "@brain/mcp-tools";

import { canJoin, connectionMode, isActive, readScopes } from "./auth.js";
import { installCaretIdentityStamp, type CaretPrincipal } from "./caret.js";
import {
  createAgentWriteBridge,
  createSqlActorNames,
  createSqlBridgeFeed,
  type AgentWriteBridge,
} from "./bridge.js";
import { createDocStore, createSqlDocRecords, type DocRecords, type DocStore } from "./docStore.js";
import {
  createFlushPipeline,
  createWriterFlushWrite,
  poolAccessCheck,
  type FlushContributor,
  type FlushPipeline,
} from "./flush.js";
import { markdownDiffBridge } from "./mdDiff.js";
import {
  createAgentPresence,
  createPresenceRelay,
  docRoom,
  routeRoomFromName,
  type AgentPresence,
  type PresenceHandle,
  type PresenceRelay,
  type PresenceRoomKey,
} from "./presence.js";
import {
  createCollabServer,
  isCollabProbeRoom,
  type CollabServer,
  type CollabServerOptions,
} from "./server.js";
import { COLLAB_CLOSE, type CollabPrincipal } from "./types.js";

/**
 * The origin used for the hocuspocus ⇄ store mirror, so a mirrored update is
 * never mirrored back. It must NOT be used for a client's own update: the
 * origin IS the author, and replacing it makes every keystroke unattributed —
 * which the flush pipeline correctly refuses to persist.
 */
const MIRROR_ORIGIN = Symbol("collab:mirror");

/**
 * The stateless message type, in BOTH directions.
 *
 * Restated here rather than imported: the SPA and the box are separate bundles
 * and nothing crosses that boundary (the same discipline `routePresence.ts`
 * uses for this protocol). The client's copy is
 * `apps/box/ui/src/lib/routePresence.ts PRESENCE_MESSAGE` and the two must
 * agree — a mismatch is invisible, because a frame the client does not
 * recognise is dropped and simply renders no rail.
 */
const PRESENCE_MESSAGE = "presence";

/**
 * How often the presence relay's stale-entry TTL sweep runs. Shorter than
 * `PRESENCE_TTL_MS` (45s) so a phantom left by a socket that died without an
 * `onDisconnect` is reaped within roughly one TTL, not left counting toward the
 * room ceiling and inflating every remaining member's "N people here" forever.
 */
const PRESENCE_SWEEP_MS = 30_000;

/** A route room's document name on the wire — `route:<screen>`. */
function isRouteRoomName(documentName: string): boolean {
  return documentName.startsWith("route:");
}

/**
 * Rooms this wiring must keep its hands off entirely.
 *
 * THE CANARY'S PROBE ROOM IS THE ONE THAT BITES. `probeRoom()` opens a
 * synthetic room IN-PROCESS with an empty context — no principal, no object,
 * no database — precisely so the updater's post-swap canary reports on the
 * BUILD rather than on RLS or on the kill switch. An extension hook that
 * demands a principal therefore throws on it, the probe returns false,
 * `collabOk` is false, and the updater ROLLS BACK EVERY RELEASE ON EVERY BOX
 * IN THE FLEET — from a wiring change that looked local to the editor.
 *
 * (Found exactly that way: the first version of this file threw UNAUTHORIZED
 * for a probe room. `collab-wiring.integration.test.ts` pins it now.)
 */
function isUnmanagedRoom(documentName: string): boolean {
  return isCollabProbeRoom(documentName);
}

export interface WireCollabOptions {
  readonly pool: Pool;
  /** the writer every other mutation on this box goes through. */
  readonly writer: Writer;
  /** everything `createCollabServer` takes except the hooks this file owns. */
  readonly server: Omit<CollabServerOptions, "authorizeRoom" | "flushRoom" | "purgeRoom">;
  /** injected by tests; production reads through the pool. */
  readonly records?: DocRecords | undefined;
  readonly flushIdleMs?: number | undefined;
  readonly flushMaxMs?: number | undefined;
  readonly idleTtlMs?: number | undefined;
  readonly sweepMs?: number | undefined;
  readonly persistDebounceMs?: number | undefined;
  readonly persistMaxMs?: number | undefined;
  /** the agent-write bridge's feed cadence. Tests drive it by hand. */
  readonly bridgePollMs?: number | undefined;
  /** start the bridge poller. Off in tests that drive it by hand. */
  readonly startBridge?: boolean | undefined;
  /** presence stale-entry sweep cadence; defaults to `PRESENCE_SWEEP_MS`. */
  readonly presenceSweepMs?: number | undefined;
}

export interface WiredCollab {
  readonly collab: CollabServer;
  readonly store: DocStore;
  readonly flush: FlushPipeline;
  readonly bridge: AgentWriteBridge;
  readonly presence: PresenceRelay;
  /** drain rooms, stop the bridge, tear the server and the store down. */
  close(): Promise<void>;
}

/**
 * Which of `objectIds` may `actorId` see?
 *
 * An RLS-bound read as that actor — the same read `probeJoin` does, batched.
 * FAILS CLOSED: any error resolves to the empty set, because the harm of a
 * false "you may see this" is that presence reveals a private object exists.
 */
function poolVisibility(pool: Pool) {
  return async (actorId: string, objectIds: readonly string[]): Promise<readonly string[]> => {
    if (objectIds.length === 0 || !actorId) return [];
    let client;
    try {
      client = await pool.connect();
    } catch {
      return [];
    }
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(
        "SELECT set_config('app.actor_id', $1, true), set_config('app.on_behalf_of', '', true), set_config('statement_timeout', '2000', true)",
        [actorId],
      );
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM objects WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
        [[...objectIds]],
      );
      await client.query("COMMIT");
      return rows.map((r) => r.id);
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return [];
    } finally {
      client.release();
    }
  };
}

/**
 * Assemble the whole collab stack. The caller still owns `attach(server)` —
 * only the entrypoint has the Node server, and a wiring that reached for one
 * could not be used by a test that does not have one yet.
 */
export function wireCollab(opts: WireCollabOptions): WiredCollab {
  const records = opts.records ?? createSqlDocRecords(opts.pool);

  // Declared before construction because the three pieces close over each
  // other; every use below happens inside a callback, long after this line.
  /* eslint-disable prefer-const -- both are assigned below, after the server
     that closes over them. The cycle (server → flush, store → flush, flush →
     store, store → server) means each is only ever READ from inside a callback
     that runs long after construction; `const` cannot express that ordering. */
  let store: DocStore;
  let flush: FlushPipeline;
  /* eslint-enable prefer-const */

  const collab = createCollabServer({
    ...opts.server,
    pool: opts.pool,
    /**
     * THE join check — an RLS-bound read as the joiner, then the account's
     * CURRENT scopes for read-only vs read-write. Never a re-implementation of
     * the 0012 visibility predicate.
     *
     * A `route:` room is PRESENCE-ONLY and carries NO document, so EVERY
     * connection to it is read-only. That looks like it should break presence,
     * and once did: `inboundWriteRefusal` CLOSES a read-only connection that
     * sends a document mutation, and hocuspocus's provider always performs a
     * document sync on connect (a sync step-2 IS a document mutation) — so the
     * first attempt at marking route rooms read-only made every presence
     * connection open and immediately die with 4404, the rail never appeared,
     * and the box logged the refusal on every page load. The gate now EXEMPTS
     * route rooms (see `inboundWriteRefusal`), which is safe because hocuspocus's
     * own MessageReceiver silently DROPS a read-only connection's sync step-2 /
     * update — it neither applies nor broadcasts them. So read-only is exactly
     * what a document-less room wants: a client that opens a `HocuspocusProvider`
     * to `route:<screen>` and pushes ~1MB Yjs updates gets them dropped on the
     * floor instead of applied to an in-memory doc and fanned out to every
     * co-present member (an unaudited peer channel + memory/bandwidth
     * amplification). Presence itself never touches the Y.Doc — it rides the
     * stateless channel (onStateless/sendStateless), which read-only does not
     * gate — so the rail is unaffected.
     *
     * Nothing a client puts in a route room can reach the brain even so: the
     * room has no object id, `onLoadDocument` hands it no stored document, the
     * flush and purge hooks below refuse it by name, and the doc store has never
     * heard of it. What must not be forgeable in a route room is IDENTITY, and
     * that is guarded where it actually lives — the relay stamps `kind`/
     * `actorId`/`name`/`color`/`glyph` from the authenticated principal and drops
     * any client that authors them.
     *
     * Membership of a route reveals a SCREEN, never an object: `routeRoom`
     * refuses a key that embeds a uuid, so a route cannot be used to probe for
     * one — but ONLY because the raw wire name is run through `routeRoomFromName`
     * (which calls `routeRoom`) here, not merely prefix-matched. Prefix-matching
     * alone would accept `route:<uuid>` and unbounded/arbitrary-charset keys.
     */
    authorizeRoom: async ({ pool: p, principal, objectId }) => {
      const access = await readScopes(p, principal.actorId);
      if (!isActive(access)) return null;
      if (isRouteRoomName(objectId)) {
        // Enforce the route-key contract (charset, length, NO embedded uuid). A
        // name that fails it — or that is not already normalized — is refused,
        // exactly as an unauthorized doc room is.
        return routeRoomFromName(objectId) ? { readOnly: true } : null;
      }
      if (!(await canJoin(p, principal.actorId, objectId))) return null;
      return { readOnly: connectionMode(access?.scopes ?? []) === "ro" };
    },
    // A route room has no object, so there is nothing to flush or purge and the
    // name is not an id the write path could resolve. Refused by name rather
    // than relying on the store to shrug at an unknown room.
    flushRoom: async (objectId: string): Promise<void> => {
      if (isRouteRoomName(objectId) || isUnmanagedRoom(objectId)) return;
      await flush.flush(objectId, "drain");
    },
    // `actorId` is the actor whose committed write triggered the eviction
    // (visibility narrowed / unshared / deleted). It MUST reach `store.purge`:
    // a narrowing purge flushes the still-authorized editors' unflushed text
    // before dropping the row, and that flush's RLS-bound base read runs as this
    // actor. Dropping it here makes the store fall back to the room's last
    // joiner — who may be exactly the member just narrowed away — so the base
    // read returns nothing, the flush no-ops, and every open editor loses up to
    // ~30s of text. See docStore.purge / teardown's `actorOverride`.
    purgeRoom: async (objectId: string, reason, actorId): Promise<void> => {
      if (isRouteRoomName(objectId) || isUnmanagedRoom(objectId)) return;
      await store.purge(objectId, reason, actorId);
    },
  });

  store = createDocStore({
    records,
    applyMarkdownDiff: markdownDiffBridge,
    flush: async (target): Promise<void> => {
      await flush.hook(target);
    },
    onEvict: (objectId, reason): void => collab.evict(objectId, reason),
    ...(opts.idleTtlMs === undefined ? {} : { idleTtlMs: opts.idleTtlMs }),
    ...(opts.sweepMs === undefined ? {} : { sweepMs: opts.sweepMs }),
    ...(opts.persistDebounceMs === undefined ? {} : { persistDebounceMs: opts.persistDebounceMs }),
    ...(opts.persistMaxMs === undefined ? {} : { persistMaxMs: opts.persistMaxMs }),
  });

  flush = createFlushPipeline({
    rooms: store,
    // The SAME core write every other mutation on this box goes through, so a
    // room's text lands as a real version with real attribution and a real
    // audit event — not through a private back door.
    write: createWriterFlushWrite(opts.writer),
    readObject: async (actorId, objectId) => (await records.load(actorId, objectId)).object,
    canWrite: poolAccessCheck(opts.pool),
    // Hocuspocus applies a client's update with the `Connection` as the
    // transaction origin, and the connection carries the ticket-verified
    // principal — so this is where "who typed this" comes from. `null` means
    // UNATTRIBUTED, which the pipeline refuses rather than writing under a
    // convenient actor.
    resolveContributor: (origin: unknown): FlushContributor | null => {
      const connection = origin as
        { context?: { principal?: CollabPrincipal }; readOnly?: unknown } | null | undefined;
      const actorId = connection?.context?.principal?.actorId;
      if (!actorId) return null;
      return { actorId, canWrite: connection?.readOnly !== true };
    },
    applyMarkdownDiff: markdownDiffBridge,
    evictActor: (_objectId, actorId): void => collab.evictActor(actorId, "access_revoked"),
    ...(opts.flushIdleMs === undefined ? {} : { idleMs: opts.flushIdleMs }),
    ...(opts.flushMaxMs === undefined ? {} : { maxMs: opts.flushMaxMs }),
  });

  /* ---------------------------------------------------------------- presence */

  /** Every live presence connection, so a broadcast can reach its socket. */
  const presenceSinks = new Map<string, (payload: string) => void>();

  /**
   * socketId → presence handle. KEYED BY socketId, NOT by the connection
   * object, because hocuspocus hands three DIFFERENT things to the three hooks
   * this binding needs:
   *
   *   connected     → `connection` is a ConnectionConfiguration (`{readOnly}`)
   *                   and the real socket is `connectionInstance`;
   *   onStateless   → `connection` IS the Connection;
   *   onDisconnect  → there is NO connection at all, only `socketId`.
   *
   * The first draft keyed a WeakMap on `connection` and called
   * `sendStateless?.()` on it. Both failed SILENTLY — the optional call landed
   * on a config object with no such method, the WeakMap never matched, and the
   * rail simply never appeared, which is indistinguishable from "nobody else is
   * here". `socketId` is the one identifier all three hooks agree on.
   *
   * Declared HERE (before the relay) so the relay's `onReap` can reach it: a
   * member the TTL sweep drops must have its sink AND its handle reaped in
   * lockstep, or the maps grow without bound for every socket that died without
   * an `onDisconnect`.
   */
  const presenceHandles = new Map<string, PresenceHandle>();

  /** Rooms touched by the last sweep, re-broadcast once so the reaped phantom
   *  leaves the remaining members' rails and counts. */
  const presenceReapedRooms = new Set<PresenceRoomKey>();

  const presence = createPresenceRelay({
    send: (recipient: PresenceHandle, view): void => {
      const sink = presenceSinks.get(recipient.clientId);
      if (!sink) return;
      try {
        // THE WIRE SHAPE IS FLAT, and it is the client's, not ours:
        // `{"type":"presence","states":[…],"counts":{…}}` — see
        // `apps/box/ui/src/lib/routePresence.ts readPresenceView`, which
        // returns null (and therefore silently renders NO RAIL) for anything
        // whose `states` is not an array at the top level. Sending the view
        // NESTED under a `view` key parses cleanly, is dropped as "not a
        // presence frame", and looks exactly like nobody being there.
        sink(JSON.stringify({ type: PRESENCE_MESSAGE, states: view.states, counts: view.counts }));
      } catch {
        /* a bad socket is not the relay's problem */
      }
    },
    visibleTo: poolVisibility(opts.pool),
    onViolation: (handle, keys): void => {
      // The room key is a screen, never content; the actor is not logged.
      console.warn(
        `collab: presence payload authored identity keys [${keys.join(", ")}] in ${handle.room}`,
      );
    },
    // A member the TTL sweep drops leaves two mirror entries behind — its socket
    // sink and its handle — both keyed on a connection that is gone. Reap them on
    // the same signal, and remember the room so the sweep can refresh what its
    // remaining members see.
    onReap: (handle): void => {
      presenceSinks.delete(handle.clientId);
      for (const [socketId, existing] of presenceHandles) {
        if (existing.clientId === handle.clientId) {
          presenceHandles.delete(socketId);
          break;
        }
      }
      presenceReapedRooms.add(handle.room);
    },
  });

  /** Agent cursors ride the same relay, through the same per-recipient filter. */
  const agents: AgentPresence = createAgentPresence({ relay: presence });

  /**
   * A display name is HALF AN IDENTITY CLAIM the room renders as true, so it is
   * read from `accounts` server-side and never taken from a ticket, a payload
   * or the feed. Unresolvable is not fatal — the relay's own fallback is
   * honest.
   */
  // ONE name cache for both surfaces — createSqlActorNames already carries the
  // 5-minute TTL + size cap the bridge's robot cursors use. A second, bespoke
  // forever-map here made the two surfaces disagree about the same person: a
  // rename showed on the robot cursor within minutes but stayed stale on every
  // editor caret until the process restarted (weeks, on a version-pinned box).
  const actorNames = createSqlActorNames(opts.pool);
  const displayName = async (actorId: string): Promise<string | undefined> => {
    try {
      const name = await actorNames(actorId);
      if (typeof name === "string" && name !== "") return name;
    } catch {
      /* a name is a nicety; never a reason to refuse a room */
    }
    return undefined;
  };

  /* ------------------------------------------------------ hocuspocus binding */

  const mirrors = new Map<string, () => void>();
  const unmirror = (documentName: string): void => {
    mirrors.get(documentName)?.();
    mirrors.delete(documentName);
  };
  /**
   * Hocuspocus owns the `Document` it serves; the doc store owns the `Y.Doc`
   * it seeds, persists and flushes. The mirror keeps the two identical, and it
   * PRESERVES the origin in the client → store direction, because the origin is
   * the connection and the connection is the author.
   */
  const mirror = (documentName: string, hpDoc: Y.Doc, storeDoc: Y.Doc): void => {
    unmirror(documentName);
    const up = (update: Uint8Array, origin: unknown): void => {
      if (origin === MIRROR_ORIGIN) return;
      Y.applyUpdate(storeDoc, update, origin);
    };
    const down = (update: Uint8Array, origin: unknown): void => {
      if (origin === MIRROR_ORIGIN) return;
      Y.applyUpdate(hpDoc, update, MIRROR_ORIGIN);
    };
    hpDoc.on("update", up);
    storeDoc.on("update", down);
    mirrors.set(documentName, () => {
      hpDoc.off("update", up);
      storeDoc.off("update", down);
    });
  };

  interface HpConnection {
    readonly socketId?: string;
    sendStateless(payload: string): void;
  }

  /**
   * The slice of a hocuspocus `Document` the caret stamp needs: the stock Yjs
   * awareness it relays, and the `webSocket → { connection }` map that resolves an
   * awareness update's origin back to its authenticated principal.
   */
  interface HpDocument {
    readonly awareness: import("y-protocols/awareness").Awareness;
    readonly connections: Map<
      unknown,
      { readonly connection?: { readonly context?: HpCaretContext } }
    >;
  }
  /** What the connect gate leaves on `Connection.context` for the caret stamp. */
  interface HpCaretContext {
    readonly principal?: CollabPrincipal;
    /** the display name, cached in `connected` so the stamp reads it synchronously. */
    caretName?: string | undefined;
  }

  /**
   * Overwrite each doc-room connection's stock-awareness `user` field with the
   * server's stamp (see caret.ts). The rail is stamped on its own channel; the
   * editor caret is stock Yjs awareness and would otherwise carry a
   * client-authored — hence forgeable — identity to every peer.
   */
  const installCaretStamp = (document: HpDocument): void => {
    installCaretIdentityStamp(document.awareness, (origin): CaretPrincipal | null => {
      const ctx = document.connections.get(origin)?.connection?.context;
      const actorId = ctx?.principal?.actorId;
      if (!actorId) return null;
      return { actorId, name: ctx?.caretName };
    });
  };

  const roomKeyFor = (documentName: string): PresenceRoomKey | null =>
    isRouteRoomName(documentName)
      ? // Validated, never cast: the same `routeRoom` contract the join gate
        // enforces, so a presence room key can never carry a uuid or an
        // out-of-charset/over-length name even if the join gate ever regressed.
        routeRoomFromName(documentName)
      : (docRoom(documentName) as PresenceRoomKey | null);

  collab.hocuspocus.configuration.extensions.push({
    /**
     * Per CONNECTION per document — so a second joiner is read as ITSELF and
     * never inherits the first joiner's grant.
     */
    async onConnect({ documentName, context, connection }: Record<string, unknown>): Promise<void> {
      if (isUnmanagedRoom(documentName as string)) return;
      const principal = (context as { principal?: CollabPrincipal } | undefined)?.principal;
      if (!principal) throw { code: COLLAB_CLOSE.UNAUTHORIZED, reason: "no principal" };
      if (isRouteRoomName(documentName as string)) return;
      const joined = await store.join(documentName as string, principal.actorId);
      if (!joined) throw { code: COLLAB_CLOSE.ROOM_FORBIDDEN, reason: "not available" };
      void connection;
    },
    async onLoadDocument({ documentName }: Record<string, unknown>): Promise<Y.Doc | undefined> {
      if (isUnmanagedRoom(documentName as string)) return undefined;
      if (isRouteRoomName(documentName as string)) return undefined;
      return store.get(documentName as string)?.doc;
    },
    async afterLoadDocument({ documentName, document }: Record<string, unknown>): Promise<void> {
      if (isUnmanagedRoom(documentName as string)) return;
      // The identity stamp applies to ROUTE ROOMS TOO. Hocuspocus relays stock
      // y-protocols awareness between every connection of a `route:<screen>`
      // room (read-only gates sync updates, not awareness — deliberately, per
      // inboundWriteRefusal), so without the stamp any authenticated member
      // could publish a forged `user` blob (kind:"agent", another member's
      // actorId/name) that every co-present member's provider holds — an open
      // identity-forgery channel that violates presence.ts's "IDENTITY IS
      // STAMPED BY THE SERVER" invariant the moment anything renders it. The
      // shipped rail reads only the filtered stateless channel, but the stamp
      // is what keeps that a presentation choice rather than the security line.
      installCaretStamp(document as unknown as HpDocument);
      if (isRouteRoomName(documentName as string)) return;
      const room = store.get(documentName as string);
      if (!room) return;
      mirror(documentName as string, document as Y.Doc, room.doc);
      flush.attach(documentName as string, room.lastActorId);
    },
    /**
     * PRESENCE. Joined here rather than in `onConnect` so a refused document
     * never leaves a live presence entry behind, and so the doc room's entry is
     * created only after the RLS join read said yes.
     */
    async connected({
      documentName,
      context,
      socketId,
      connectionInstance,
    }: Record<string, unknown>): Promise<void> {
      if (isUnmanagedRoom(documentName as string)) return;
      const principal = (context as { principal?: CollabPrincipal } | undefined)?.principal;
      if (!principal) return;
      const room = roomKeyFor(documentName as string);
      if (!room) return;
      // `connectionInstance`, NOT `connection` — see the note on
      // `presenceHandles`: the latter is a config object with no socket on it.
      const conn = connectionInstance as HpConnection | undefined;
      const id = socketId as string | undefined;
      if (!conn || typeof conn.sendStateless !== "function" || !id) return;
      const name = await displayName(principal.actorId);
      // Cache the display name on the connection's context so the editor-caret
      // stamp (installCaretStamp) can read it synchronously when it overwrites
      // this connection's awareness identity. Absent, the stamp still applies —
      // it falls back to a generic label, never to the client's claim.
      (context as { caretName?: string | undefined }).caretName = name;
      const handle = presence.join(room, {
        kind: "human",
        actorId: principal.actorId,
        ...(name === undefined ? {} : { name }),
      });
      // A room at its ceiling refuses the presence channel and leaves the
      // editor alone: presence must never be the reason somebody cannot type.
      if (!handle) return;
      presenceHandles.set(id, handle);
      presenceSinks.set(handle.clientId, (payload: string) => conn.sendStateless(payload));
      // A doc-room member's current object is the room's OWN object, stamped at
      // join time (`memberOf` sets `objectId = roomObjectId(room)`), so there is
      // nothing to focus here — `presence.focus` is a deliberate no-op for doc
      // rooms anyway. Reflecting a human's open object onto the SAME actor's
      // route-room entry ("editing N objects in <route>") is a cross-room
      // correlation that is NOT wired in this phase; only agents populate a
      // route-room object (via their own server-observed `focus`). The
      // per-recipient filter is fail-closed either way, so this under-reports
      // (the safe direction) rather than leaking.
      await presence.broadcast(room);
    },
    async onStateless({
      documentName,
      connection,
      payload,
    }: Record<string, unknown>): Promise<void> {
      const id = (connection as HpConnection | undefined)?.socketId;
      const handle = id === undefined ? undefined : presenceHandles.get(id);
      if (!handle) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload as string);
      } catch {
        return;
      }
      const message = parsed as { type?: unknown; position?: unknown } | null;
      if (!message || message.type !== PRESENCE_MESSAGE) return;
      presence.update(handle, message.position);
      void documentName;
      await presence.broadcast(handle.room);
    },
    async onDisconnect({ documentName, socketId }: Record<string, unknown>): Promise<void> {
      if (isUnmanagedRoom(documentName as string)) return;
      const id = socketId as string | undefined;
      const handle = id === undefined ? undefined : presenceHandles.get(id);
      if (handle && id !== undefined) {
        presenceHandles.delete(id);
        presenceSinks.delete(handle.clientId);
        presence.leave(handle);
        await presence.broadcast(handle.room);
      }
      if (!isRouteRoomName(documentName as string)) store.leave(documentName as string);
    },
    async afterUnloadDocument({ documentName }: Record<string, unknown>): Promise<void> {
      if (isUnmanagedRoom(documentName as string)) return;
      unmirror(documentName as string);
    },
  } as never);

  /* -------------------------------------------------------- agent-write bridge */

  const bridge = createAgentWriteBridge({
    feed: createSqlBridgeFeed(opts.pool),
    rooms: store,
    records,
    // The writing actor's display name, read server-side from `accounts` —
    // never from the feed and never from anything a client sent.
    actorName: actorNames,
    // Phase 5: an ingested write arrives as a NAMED robot cursor rather than as
    // paragraphs from nowhere. Absent, the write still lands — silently.
    agents,
    // The echo gate: a round-tripped origin token, never a content comparison.
    isOwnFlush: (token) => flush.isOwnFlush(token),
    // Hand the newly-stored content to the flush pipeline so its cached base is
    // refreshed in lockstep with the ingest. Without this the next flush of an
    // idle room re-persists the agent's write as a redundant version falsely
    // attributed to whoever had the room open (see `noteExternalWrite`).
    onIngest: ({ objectId, body, title }): void => flush.noteExternalWrite(objectId, body, title),
    parseOrigin,
    ...(opts.bridgePollMs === undefined ? {} : { pollMs: opts.bridgePollMs }),
  });
  if (opts.startBridge !== false) bridge.start();

  /**
   * The presence relay ships a TTL sweep for sockets that die without an
   * `onDisconnect`, but it has no timer of its own — nothing drove it, so the
   * safety net was inert and phantom entries leaked for the life of the process.
   * Drive it here, then re-broadcast every room the sweep touched so the reaped
   * phantom leaves the remaining members' rails and counts.
   */
  const presenceSweep = setInterval(() => {
    const dropped = presence.sweep();
    if (dropped === 0) {
      presenceReapedRooms.clear();
      return;
    }
    const rooms = [...presenceReapedRooms];
    presenceReapedRooms.clear();
    for (const room of rooms) {
      void presence.broadcast(room).catch((err: unknown) => {
        console.warn("collab: presence sweep broadcast failed —", String(err));
      });
    }
  }, opts.presenceSweepMs ?? PRESENCE_SWEEP_MS);
  presenceSweep.unref?.();

  return {
    collab,
    store,
    flush,
    bridge,
    presence,
    async close(): Promise<void> {
      clearInterval(presenceSweep);
      bridge.stop();
      await collab.close();
      await store.close();
      flush.close();
    },
  };
}
