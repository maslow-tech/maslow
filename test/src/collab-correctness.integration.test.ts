import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import WebSocket from "ws";
import * as Y from "yjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Admin, parseOrigin, Writer, type AccessChange, type ToolDeps } from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import {
  COLLAB_CLOSE,
  COLLAB_PATH,
  createBox,
  createCollabServer,
  createShutdown,
  type CollabPrincipal,
  type CollabRooms,
  type CollabServer,
} from "@brain/box";
import {
  createDocStore,
  createSqlDocRecords,
  type DocRecords,
  type DocStore,
} from "@brain/box/dist/collab/docStore.js";
import {
  createFlushPipeline,
  createWriterFlushWrite,
  poolAccessCheck,
  type FlushContributor,
  type FlushPipeline,
} from "@brain/box/dist/collab/flush.js";
import {
  createAgentWriteBridge,
  createSqlBridgeFeed,
  type AgentWriteBridge,
} from "@brain/box/dist/collab/bridge.js";
import { canJoin, connectionMode, isActive, readScopes } from "@brain/box/dist/collab/auth.js";
import { markdownDiffBridge } from "@brain/box/dist/collab/mdDiff.js";
import {
  BODY_FRAGMENT,
  docToMarkdown,
  normalizeMarkdown,
} from "@brain/box/dist/collab/serialize.js";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * COLLAB CORRECTNESS — the multiplayer editor from the OUTSIDE, over real
 * websockets, against a real brain.
 *
 * The security half of this surface lives in its own file; this one asserts the
 * properties a person typing in the editor gets to rely on, every one of which
 * is a way the design can be built "correctly" and still eat somebody's
 * paragraph:
 *
 *  - ROOM AUTH IS THE DATABASE. A private object refuses every non-creator —
 *    the OWNER included, because private is creator-only on this box — and a
 *    `shared_with` member is ACCEPTED. The second half matters as much as the
 *    first: an "RLS-equivalent" predicate in application code forgets
 *    `shared_with` immediately, which leaves a shared object CAS-writable over
 *    HTTP but unjoinable in the editor — the exact multiplayer case rooms exist
 *    for, broken in a way no test of the SQL policy would catch.
 *  - ONE WRITE, ONE ACTOR. A co-edited flush is N transactions, one per
 *    contributor, each carrying only that contributor's ranges. Two people
 *    typing produce two versions and Timeline says who wrote what.
 *  - CONVERGENCE. Two websocket clients typing at once end on byte-identical
 *    markdown, and the body that lands in Postgres is that same markdown as
 *    seen from BOTH clients.
 *  - A RESTART LOSES NOTHING AND DUPLICATES NOTHING. The blob resumes instead
 *    of re-seeding (which would drop up to 30s of persisted keystrokes) and
 *    never merges into a re-seed (which would duplicate the body end to end).
 *    An MCP write that lands while the process is down REBASES: the agent's
 *    text survives AND the unflushed typed text survives.
 *  - A FLUSH DOES NOT RE-ENTER ITS OWN BRIDGE. An idle open document writes no
 *    version, no history row and no audit event, poll after poll — the echo
 *    loop this design is most exposed to would otherwise rewrite every open
 *    object forever.
 *  - SIGTERM LOSES NOTHING. The updater recreates this container on every
 *    release; the drain has to get the last keystrokes into Postgres.
 *  - THE ROOM OWNS body/title. A PATCH carrying body for an object with a live
 *    room is refused 409 `open_in_editor` rather than clobbering the CRDT,
 *    while a props-only PATCH on the same object still succeeds.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPOSITION IS IN THIS FILE, ON PURPOSE.
 *
 * `startStack` below wires the phase-2 modules together the way the box's
 * entrypoint does — collab server (upgrade gate + ticket principal) → doc store
 * (seed/resume/rebase/compaction) → flush pipeline (per-contributor CAS writes)
 * → agent-write bridge (feed watcher) — plus the one piece hocuspocus forces on
 * any embedding: it owns the `Y.Doc` it hands to clients, so the store's room
 * doc and the hocuspocus document are kept in lockstep by a mirror that
 * PRESERVES the transaction origin (the `Connection`), which is what makes
 * per-contributor attribution possible at all. Nothing here fakes a module.
 */

const SECRET = "collab-correctness-session-secret";

/** Long enough that no timer fires mid-test; those tests flush explicitly. */
const NO_AUTO_FLUSH = { flushIdleMs: 600_000, flushMaxMs: 600_000 };

/** Origin the mirror uses when it copies one doc into the other. */
const MIRROR_ORIGIN = "test:mirror";

type Auth = { cookie: string; csrf: string };

interface RoomClient {
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly socket: HocuspocusProviderWebsocket;
  destroy(): void;
}

type JoinOutcome =
  | { readonly ok: true; readonly client: RoomClient }
  | { readonly ok: false; readonly closeCode: number | undefined };

interface Stack {
  readonly port: number;
  readonly collab: CollabServer;
  readonly store: DocStore;
  readonly flush: FlushPipeline;
  readonly bridge: AgentWriteBridge;
  /** Sockets opened against THIS stack; torn down before it stops listening. */
  readonly clients: RoomClient[];
  /** graceful teardown — drains and flushes, like `close()` in the entrypoint. */
  close(): Promise<void>;
  /**
   * SIGKILL: the process is gone, so nothing flushes and nothing drains. Only
   * what Postgres already holds survives — which is the whole point of the
   * restart tests.
   */
  kill(): Promise<void>;
  /** the entrypoint's SIGTERM sequencer, over this stack's rooms. */
  sigterm(): Promise<number>;
}

function cookieValue(res: Response, name: string): string | undefined {
  const all =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const line of all) {
    const m = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(line);
    if (m) return decodeURIComponent(m[1] as string);
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** Poll a condition to a deadline; the message names what never happened. */
async function waitFor(
  what: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Append a paragraph — one person typing one thing.
 *
 * Deliberately a plain Yjs edit rather than a TipTap command: the binding is
 * the client's business (and its own unit tests'), while what this file asserts
 * is what the SERVER does with the updates that arrive.
 */
function type(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(BODY_FRAGMENT);
    const paragraph = new Y.XmlElement("paragraph");
    const inline = new Y.XmlText();
    inline.insert(0, text);
    paragraph.insert(0, [inline]);
    fragment.insert(fragment.length, [paragraph]);
  });
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * A `ws` client that sends an `Origin`.
 *
 * The provider constructs its socket as `new WebSocketPolyfill(url)` with no
 * options, and the upgrade gate refuses a missing Origin (fail closed, because
 * a websocket handshake carries no CORS and no CSRF header). A browser sets the
 * header itself; in Node we have to.
 */
function originWebSocket(origin: string): new (url: string) => WebSocket {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { origin } });
    }
  };
}

describe("collab correctness", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let admin: Admin;
  let records: DocRecords;
  let writer: Writer;

  let ownerId: string;
  let ownerAuth: Auth;
  let aliceId: string;
  let aliceAuth: Auth;
  let bobId: string;
  let bobAuth: Auth;
  let agentId: string;

  /**
   * The live-room set the dashboard's `open_in_editor` guard consults, aimed at
   * whichever stack is currently up. One box for the file, many stacks.
   */
  let liveStack: CollabServer | undefined;
  const liveRooms: CollabRooms = {
    has: (objectId: string): boolean => liveStack?.rooms.has(objectId) ?? false,
    get size(): number {
      return liveStack?.rooms.size ?? 0;
    },
  };

  const stacks: Stack[] = [];

  // ------------------------------------------------------------------ HTTP

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(path, init));

  const login = async (token: string): Promise<Auth> => {
    const res = await req("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const session = cookieValue(res, "brain_session");
    const csrf = cookieValue(res, "brain_csrf");
    if (!session || !csrf) throw new Error("login did not set both cookies");
    return { cookie: `brain_session=${session}; brain_csrf=${csrf}`, csrf };
  };

  const call = (method: string, path: string, body: unknown, auth: Auth): Promise<Response> =>
    req(path, {
      method,
      headers: {
        cookie: auth.cookie,
        "content-type": "application/json",
        "x-csrf-token": auth.csrf,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const create = async (body: unknown, auth: Auth): Promise<{ id: string; version: number }> => {
    const res = await call("POST", "/api/v1/objects", body, auth);
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; version: number };
  };

  /** The object as an actor may see it — the same RLS-bound read the store uses. */
  const stored = async (
    objectId: string,
    actorId: string,
  ): Promise<{ version: number; title: string | null; body: string }> => {
    const { object } = await records.load(actorId, objectId);
    if (!object) throw new Error(`object ${objectId} is not visible to ${actorId}`);
    return { version: object.version, title: object.title, body: object.body ?? "" };
  };

  interface HistoryVersion {
    version: string | number;
    by: string | null;
    snapshot: { title: string | null; body: string | null };
  }
  interface HistoryEvent {
    seq: string | number;
    actor: string | null;
    kind: string;
    payload: Record<string, unknown> | null;
  }

  const history = async (
    objectId: string,
    auth: Auth,
  ): Promise<{ versions: HistoryVersion[]; events: HistoryEvent[] }> => {
    const res = await call("GET", `/api/v1/objects/${objectId}/history`, undefined, auth);
    expect(res.status).toBe(200);
    return (await res.json()) as { versions: HistoryVersion[]; events: HistoryEvent[] };
  };

  /** Every `update` audit event for an object, oldest first, with its origin token. */
  const updateEvents = async (
    objectId: string,
    auth: Auth,
  ): Promise<
    Array<{ actor: string | null; version: number; reason: string; origin: string | null }>
  > => {
    const { events } = await history(objectId, auth);
    return events
      .filter((e) => e.kind === "update")
      .map((e) => {
        const raw = typeof e.payload?.reason === "string" ? (e.payload.reason as string) : "";
        const { reason, origin } = parseOrigin(raw);
        return {
          actor: e.actor,
          version: Number(e.payload?.version ?? 0),
          reason,
          origin,
          seq: Number(e.seq),
        };
      })
      .sort((a, b) => a.seq - b.seq)
      .map(({ actor, version, reason, origin }) => ({ actor, version, reason, origin }));
  };

  // ------------------------------------------------------------ the stack

  interface StackOptions {
    readonly flushIdleMs?: number;
    readonly flushMaxMs?: number;
  }

  async function startStack(opts: StackOptions = {}): Promise<Stack> {
    const http: Server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;
    const publicHost = `http://127.0.0.1:${port}`;

    /**
     * The process is dead: from here nothing flushes, nothing drains. Set by
     * `kill()` BEFORE anything else, so a timer that fires on the way out is a
     * no-op rather than a graceful save the crash would not have given us.
     */
    let dead = false;

    // The three pieces reference each other (server → flush, store → flush,
    // flush → store), so they are declared in dependency order and the back
    // references live inside callbacks that run long after construction.
    const collab = createCollabServer({
      pool,
      sessionSecret: SECRET,
      publicHost,
      // THE join check, not a re-implementation of the 0012 predicate: an
      // actual RLS-bound read as the joiner, then the account's CURRENT scopes
      // for read-only vs read-write. One answer for "cannot see it" and "does
      // not exist" — the caller turns `null` into ROOM_FORBIDDEN.
      authorizeRoom: async ({ pool: p, principal, objectId }) => {
        if (!(await canJoin(p, principal.actorId, objectId))) return null;
        const access = await readScopes(p, principal.actorId);
        if (!isActive(access)) return null;
        return { readOnly: connectionMode(access?.scopes ?? []) === "ro" };
      },
      flushRoom: async (objectId: string): Promise<void> => {
        if (!dead) await flush.flush(objectId, "drain");
      },
      // Faithful to the wired `purgeRoom` (apps/box/src/collab/wire.ts): the
      // triggering write's actor is threaded to `store.purge`, so a narrowing
      // eviction flushes as an actor who can still see the object rather than
      // falling back to the room's last joiner.
      purgeRoom: async (objectId: string, reason, actorId): Promise<void> => {
        if (!dead) await store.purge(objectId, reason, actorId);
      },
      drainTimeoutMs: 10_000,
    });

    const store: DocStore = createDocStore({
      records,
      applyMarkdownDiff: markdownDiffBridge,
      flush: async (target): Promise<void> => {
        if (!dead) await flush.hook(target);
      },
      onEvict: (objectId, reason): void => {
        if (!dead) collab.evict(objectId, reason);
      },
      // No idle teardown or sweep inside a test: room lifecycle has its own
      // unit tests, and a sweep firing mid-assertion would be a flake, not a
      // finding.
      idleTtlMs: 600_000,
      sweepMs: 600_000,
      persistDebounceMs: 20,
      persistMaxMs: 100,
    });

    const flush: FlushPipeline = createFlushPipeline({
      rooms: store,
      // The SAME core write every other mutation on this box goes through.
      write: createWriterFlushWrite(writer),
      readObject: async (actorId, objectId) => (await records.load(actorId, objectId)).object,
      canWrite: poolAccessCheck(pool),
      // Hocuspocus applies a client's update with the `Connection` as the
      // transaction origin, and the connection carries the ticket-verified
      // principal — so this is where "who typed this" comes from. Returning
      // null means UNATTRIBUTED, which the pipeline refuses rather than writing
      // under a convenient actor.
      resolveContributor: (origin: unknown): FlushContributor | null => {
        const connection = origin as
          { context?: { principal?: CollabPrincipal }; readOnly?: unknown } | null | undefined;
        const actorId = connection?.context?.principal?.actorId;
        if (!actorId) return null;
        return { actorId, canWrite: connection?.readOnly !== true };
      },
      applyMarkdownDiff: markdownDiffBridge,
      evictActor: (_objectId, actorId): void => collab.evictActor(actorId, "access_revoked"),
      idleMs: opts.flushIdleMs ?? 3_000,
      maxMs: opts.flushMaxMs ?? 30_000,
    });

    const bridge = createAgentWriteBridge({
      feed: createSqlBridgeFeed(pool),
      rooms: store,
      records,
      // The echo gate: a round-tripped origin token, never a content comparison.
      isOwnFlush: (token) => flush.isOwnFlush(token),
      parseOrigin,
      pollMs: 60_000, // driven by hand; these tests never race a timer
    });

    // ---- hocuspocus ⇄ doc store ------------------------------------------
    //
    // Hocuspocus owns the `Document` it serves to clients, and the doc store
    // owns the `Y.Doc` it seeds, persists and flushes. `onLoadDocument` returns
    // the store's doc so hocuspocus starts from the seeded state; from then on
    // the two are mirrored, and the mirror PRESERVES the origin in the
    // client → store direction, because the origin is the connection and the
    // connection is the author. Copying with a fresh origin would make every
    // keystroke unattributed and the flush would refuse to persist any of it.
    const mirrors = new Map<string, () => void>();
    const unmirror = (documentName: string): void => {
      mirrors.get(documentName)?.();
      mirrors.delete(documentName);
    };
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

    collab.hocuspocus.configuration.extensions.push({
      // Per CONNECTION per document — so a second joiner is read as ITSELF and
      // never inherits the first joiner's grant.
      async onConnect({ documentName, context }) {
        const principal = (context as { principal?: CollabPrincipal }).principal;
        if (!principal) throw { code: COLLAB_CLOSE.UNAUTHORIZED, reason: "no principal" };
        const joined = await store.join(documentName, principal.actorId);
        if (!joined) throw { code: COLLAB_CLOSE.ROOM_FORBIDDEN, reason: "not available" };
      },
      async onLoadDocument({ documentName }) {
        return store.get(documentName)?.doc;
      },
      async afterLoadDocument({ documentName, document }) {
        const room = store.get(documentName);
        if (!room) return;
        mirror(documentName, document as unknown as Y.Doc, room.doc);
        flush.attach(documentName, room.lastActorId);
      },
      async onDisconnect({ documentName }) {
        store.leave(documentName);
      },
      async afterUnloadDocument({ documentName }) {
        unmirror(documentName);
      },
    });

    collab.attach(http);
    liveStack = collab;

    const closeHttp = (): Promise<void> =>
      new Promise<void>((resolve) => http.close(() => resolve()));

    let torn = false;
    const stackClients: RoomClient[] = [];
    /**
     * Clients go FIRST, always. The provider reconnects on an unexpected close,
     * so a socket left alive while the listener goes away turns into an
     * ECONNREFUSED nobody is waiting on — an unhandled rejection that fails the
     * run for reasons that have nothing to do with the assertion.
     */
    const dropClients = (): void => {
      for (const client of stackClients.splice(0)) client.destroy();
    };

    const stack: Stack = {
      port,
      collab,
      store,
      flush,
      bridge,
      clients: stackClients,
      async close(): Promise<void> {
        if (torn) return;
        torn = true;
        if (liveStack === collab) liveStack = undefined;
        dropClients();
        bridge.stop();
        await collab.close();
        if (!dead) await store.close();
        flush.close();
        await closeHttp();
      },
      async kill(): Promise<void> {
        if (torn) return;
        torn = true;
        dead = true;
        if (liveStack === collab) liveStack = undefined;
        dropClients();
        flush.close();
        bridge.stop();
        // `collab.close()` still runs, but with `dead` set its drain flushes
        // nothing: the sockets go away exactly as they would when the process
        // is killed, and the doc store is deliberately NOT closed — closing it
        // would flush and then purge the very blob a crash has to leave behind.
        await collab.close();
        await closeHttp();
      },
      async sigterm(): Promise<number> {
        // The entrypoint's own sequencer, same stages and same order: rooms
        // first (a room flush is an attributed write that enqueues audit rows),
        // then the audit queue.
        let code = -1;
        const exited = new Promise<number>((resolve) => {
          const handler = createShutdown({
            stages: [
              { name: "collab rooms", budgetMs: 10_000, run: () => collab.drainAll() },
              {
                name: "call-audit queue",
                budgetMs: 5_000,
                run: () => writer.flushAudit(),
              },
            ],
            totalBudgetMs: 20_000,
            exit: (c) => {
              code = c;
              resolve(c);
            },
          });
          handler("SIGTERM");
        });
        await exited;
        return code;
      },
    };
    stacks.push(stack);
    return stack;
  }

  // ------------------------------------------------------------- websocket

  /** Mint a fresh single-use ticket; every socket open needs its own. */
  const ticketFor = async (auth: Auth): Promise<string> => {
    const res = await call("POST", "/api/v1/collab/ticket", undefined, auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string };
    expect(typeof body.ticket).toBe("string");
    return body.ticket;
  };

  /** Open a room over a REAL socket. Resolves either synced, or with the close code. */
  const joinRoom = async (stack: Stack, auth: Auth, objectId: string): Promise<JoinOutcome> => {
    const ticket = await ticketFor(auth);
    const url = `ws://127.0.0.1:${stack.port}${COLLAB_PATH}?ticket=${encodeURIComponent(ticket)}`;
    const socket = new HocuspocusProviderWebsocket({
      url,
      // The provider's own retry loop would replay a SPENT ticket and be
      // refused every time; a reconnect mints a new one (client's job).
      maxAttempts: 1,
      quiet: true,
      WebSocketPolyfill: originWebSocket(`http://127.0.0.1:${stack.port}`),
    });
    const doc = new Y.Doc();
    let closeCode: number | undefined;
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: objectId,
      document: doc,
      quiet: true,
      // Two providers in ONE process would otherwise sync through a
      // BroadcastChannel and the convergence test would prove nothing about
      // the wire.
      broadcast: false,
    });
    const client: RoomClient = {
      doc,
      provider,
      socket,
      destroy(): void {
        provider.destroy();
        socket.destroy();
      },
    };

    const outcome = await new Promise<JoinOutcome>((resolve) => {
      let settled = false;
      const done = (value: JoinOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      provider.on("synced", () => done({ ok: true, client }));
      provider.on("close", (payload: { event?: { code?: number } }) => {
        closeCode = payload?.event?.code;
        done({ ok: false, closeCode });
      });
      setTimeout(() => done({ ok: false, closeCode }), 15_000).unref?.();
    });

    if (outcome.ok) stack.clients.push(client);
    else client.destroy();
    return outcome;
  };

  /** Join and fail the test if the room refused — the happy path, inline. */
  const mustJoin = async (stack: Stack, auth: Auth, objectId: string): Promise<RoomClient> => {
    const outcome = await joinRoom(stack, auth, objectId);
    if (!outcome.ok)
      throw new Error(`room ${objectId} refused the join (close ${outcome.closeCode})`);
    return outcome.client;
  };

  /**
   * Wait out the flush a join arms.
   *
   * `attach` fires a flush immediately — that is how carry-over from a resumed
   * blob lands before anyone can type on top of it — and it runs concurrently
   * with the first keystrokes. A test that wants to say "this text reached
   * Postgres ONLY because of the drain/the explicit flush" has to let that
   * cycle finish first, or it is asserting against a race. `flush()` on a room
   * whose cycle is in flight waits for it (and its follow-up) rather than
   * starting a second one.
   */
  const settle = async (stack: Stack, objectId: string): Promise<void> => {
    await stack.flush.flush(objectId, "manual");
  };

  /**
   * The room's server-side markdown — what a flush would serialize.
   *
   * Read off a CLONE, never off the live doc. `doc.getXmlFragment(...)` is not
   * a pure read the first time it runs on a doc that received its types through
   * `applyUpdate` (a resumed blob): Yjs integrates the type inside a
   * transaction, which the flush pipeline sees as an edit with no author. A
   * test helper must not inject phantom contributors into the thing it is
   * observing.
   */
  const roomMarkdown = (stack: Stack, objectId: string): string => {
    const room = stack.store.get(objectId);
    if (!room) throw new Error(`no live room for ${objectId}`);
    const copy = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(room.doc));
      return docToMarkdown(copy);
    } finally {
      copy.destroy();
    }
  };

  // ------------------------------------------------------------- lifecycle

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    records = createSqlDocRecords(pool);

    let deps: ToolDeps | undefined;
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false, liveRooms },
      onDeps: (d) => {
        deps = d;
      },
    });
    if (!deps) throw new Error("createBox did not hand back its tool deps");
    writer = deps.writer;

    admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    ownerId = boot.id;
    ownerAuth = await login(boot.token);

    const alice = await admin.createUser(ownerId, {
      name: "Alice",
      email: "alice@example.com",
      permission: "member",
    });
    aliceId = alice.id;
    aliceAuth = await login(alice.token);

    const bob = await admin.createUser(ownerId, {
      name: "Bob",
      email: "bob@example.com",
      permission: "member",
    });
    bobId = bob.id;
    bobAuth = await login(bob.token);

    // The "agent" — an ordinary member account, because an MCP write is an
    // ordinary write. What makes it external is that it does not come from a
    // room, not that it comes from a different kind of account.
    const agent = await admin.createUser(ownerId, {
      name: "Agent",
      email: "agent@example.com",
      permission: "member",
    });
    agentId = agent.id;

    // Props only exist on a TYPED object, so the props-patch case needs a real
    // type with a real column.
    const exec = new SchemaExecutor(ownerClient);
    const t = await exec.defineType({ name: "card" }, ownerId);
    await exec.addProperty({ typeId: t.typeId, name: "stage", kind: "text" }, ownerId);
  }, 180_000);

  afterEach(async () => {
    for (const stack of stacks.splice(0)) await stack.close();
    liveStack = undefined;
  });

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  // ======================================================== room authorization

  it("a private object refuses every non-creator — the owner included — and accepts a shared_with member", async () => {
    const stack = await startStack(NO_AUTO_FLUSH);
    const { id } = await create(
      { title: "alice's private note", body: "for me", visibility: "private" },
      aliceAuth,
    );

    // The creator, obviously.
    const mine = await joinRoom(stack, aliceAuth, id);
    expect(mine.ok).toBe(true);

    // A colleague who has never been shared on it. ONE answer for "cannot see
    // it" and "does not exist": a room may never reveal that a private object
    // exists.
    const stranger = await joinRoom(stack, bobAuth, id);
    expect(stranger.ok).toBe(false);
    expect(stranger.ok === false && stranger.closeCode).toBe(COLLAB_CLOSE.ROOM_FORBIDDEN);

    // AND THE OWNER. Private is creator-only on this box, even against the
    // account that can do everything else — the room is not a side door.
    const owner = await joinRoom(stack, ownerAuth, id);
    expect(owner.ok).toBe(false);
    expect(owner.ok === false && owner.closeCode).toBe(COLLAB_CLOSE.ROOM_FORBIDDEN);

    // Now share it. `shared_with` is part of the ONE visibility rule (0012), so
    // the join — an actual RLS-bound read as the joiner — must accept Bob
    // without anyone teaching the room about sharing.
    const { version } = await stored(id, aliceId);
    await writer.editFields({ actorId: aliceId, scopes: ["read", "write"] }, id, {
      baseVersion: version,
      sharedWith: [bobId],
      reason: "share",
    });

    const shared = await joinRoom(stack, bobAuth, id);
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    await waitFor("Bob's client to receive the shared body", () =>
      docToMarkdown(shared.client.doc).includes("for me"),
    );

    // Sharing widened access; it did not widen it to the owner.
    const ownerAgain = await joinRoom(stack, ownerAuth, id);
    expect(ownerAgain.ok).toBe(false);
    expect(ownerAgain.ok === false && ownerAgain.closeCode).toBe(COLLAB_CLOSE.ROOM_FORBIDDEN);
  });

  // ==================================================== per-contributor flush

  it("a co-edited flush writes one version per contributor, each carrying only their own ranges", async () => {
    const stack = await startStack(NO_AUTO_FLUSH);
    const { id, version: v0 } = await create(
      { title: "shared doc", body: "base", visibility: "org" },
      aliceAuth,
    );

    const alice = await mustJoin(stack, aliceAuth, id);
    const bob = await mustJoin(stack, bobAuth, id);
    await waitFor("Bob to see the seeded body", () => docToMarkdown(bob.doc).includes("base"));
    await settle(stack, id);
    expect((await stored(id, aliceId)).version).toBe(v0);

    // Sequenced on purpose: this test is about ATTRIBUTION, and one run per
    // person is the case whose expected version count is knowable. (Genuinely
    // concurrent typing gets its own test below.)
    type(alice.doc, "alice line");
    await waitFor("alice's line to reach the room", () =>
      roomMarkdown(stack, id).includes("alice line"),
    );
    await waitFor("alice's line to reach Bob", () => docToMarkdown(bob.doc).includes("alice line"));

    type(bob.doc, "bob line");
    await waitFor("bob's line to reach the room", () =>
      roomMarkdown(stack, id).includes("bob line"),
    );

    await stack.flush.flush(id, "manual");

    // TWO versions, not one. A multi-actor write does not exist on this box, so
    // the flush splits — and the accepted consequence is N versions.
    const after = await stored(id, aliceId);
    expect(after.version).toBe(v0 + 2);
    expect(after.body).toContain("alice line");
    expect(after.body).toContain("bob line");

    const events = await updateEvents(id, aliceAuth);
    const flushes = events.filter((e) => e.reason === "live editor");
    expect(flushes.map((e) => e.actor)).toEqual([aliceId, bobId]);
    expect(flushes.map((e) => e.version)).toEqual([v0 + 1, v0 + 2]);
    // Both sub-writes are this ROOM's, so they share the room's origin token —
    // which is exactly what lets the bridge drop its own events.
    expect(flushes[0]?.origin).toBeTruthy();
    expect(flushes[1]?.origin).toBe(flushes[0]?.origin);

    // ONLY THEIR OWN RANGES. The before-image Bob's write replaced is the body
    // as Alice's write left it: her sentence, and not one character of his. If
    // the flush had written one merged blob under a single actor, this snapshot
    // would already contain "bob line".
    const { versions } = await history(id, aliceAuth);
    const replacedByBob = versions.find((v) => Number(v.version) === v0 + 1);
    expect(replacedByBob).toBeDefined();
    expect(replacedByBob?.by).toBe(bobId);
    expect(replacedByBob?.snapshot.body ?? "").toContain("alice line");
    expect(replacedByBob?.snapshot.body ?? "").not.toContain("bob line");
  });

  // ================================================================ convergence

  it("two websocket clients typing concurrently converge, and the stored body matches both", async () => {
    const stack = await startStack(NO_AUTO_FLUSH);

    /** One object, two clients, both typing before either has heard the other. */
    const race = async (first: "alice" | "bob"): Promise<string> => {
      const { id } = await create(
        { title: `race ${first}`, body: "start", visibility: "org" },
        aliceAuth,
      );
      const alice = await mustJoin(stack, aliceAuth, id);
      const bob = await mustJoin(stack, bobAuth, id);
      await waitFor("both clients to see the seed", () => docToMarkdown(bob.doc).includes("start"));
      await settle(stack, id);

      if (first === "alice") {
        type(alice.doc, "alpha from alice");
        type(bob.doc, "beta from bob");
      } else {
        type(bob.doc, "beta from bob");
        type(alice.doc, "alpha from alice");
      }

      const both = (md: string): boolean =>
        md.includes("alpha from alice") && md.includes("beta from bob");
      await waitFor("alice to have both lines", () => both(docToMarkdown(alice.doc)));
      await waitFor("bob to have both lines", () => both(docToMarkdown(bob.doc)));
      await waitFor("the room to have both lines", () => both(roomMarkdown(stack, id)));

      // CONVERGENCE: not "both contain the text" but "both are the same text",
      // and the same as the server's.
      const fromAlice = docToMarkdown(alice.doc);
      const fromBob = docToMarkdown(bob.doc);
      expect(fromAlice).toBe(fromBob);
      expect(roomMarkdown(stack, id)).toBe(fromAlice);

      await stack.flush.flush(id, "manual");

      // The body that landed in Postgres is what BOTH clients are looking at.
      const after = await stored(id, aliceId);
      expect(normalizeMarkdown(after.body)).toBe(fromAlice);
      expect(normalizeMarkdown(after.body)).toBe(fromBob);
      expect(occurrences(after.body, "alpha from alice")).toBe(1);
      expect(occurrences(after.body, "beta from bob")).toBe(1);
      return normalizeMarkdown(after.body);
    };

    // Order of arrival must not decide the outcome: Yjs orders concurrent
    // inserts by client id, not by who reached the server first.
    const aliceFirst = await race("alice");
    const bobFirst = await race("bob");
    expect(new Set(aliceFirst.split("\n\n"))).toEqual(new Set(bobFirst.split("\n\n")));
  });

  // ==================================================== restart mid-session

  it("a process restart mid-session resumes the blob without duplicating the body", async () => {
    const first = await startStack(NO_AUTO_FLUSH);
    const { id, version: v0 } = await create({ title: "restart", body: "seed line" }, aliceAuth);

    const alice = await mustJoin(first, aliceAuth, id);
    await settle(first, id);

    type(alice.doc, "typed but never flushed");
    await waitFor("the room to hold the unflushed text", () =>
      roomMarkdown(first, id).includes("typed but never flushed"),
    );
    // The keystrokes are in the CRDT and in `collab_docs` — and nowhere else.
    await first.store.persist(id);
    const beforeCrash = await stored(id, aliceId);
    expect(beforeCrash.version).toBe(v0);
    expect(beforeCrash.body).not.toContain("typed but never flushed");

    await first.kill();

    // A new process, the same database.
    const second = await startStack(NO_AUTO_FLUSH);
    const back = await mustJoin(second, aliceAuth, id);

    // RESUMED, not re-seeded: the persisted keystrokes are still there…
    const resumed = roomMarkdown(second, id);
    expect(resumed).toContain("typed but never flushed");
    // …and NOT merged into a fresh seed, which is how a body duplicates end to
    // end (the failure the doc epoch exists to prevent).
    expect(occurrences(resumed, "seed line")).toBe(1);
    expect(occurrences(resumed, "typed but never flushed")).toBe(1);
    expect(resumed).toBe(normalizeMarkdown("seed line\n\ntyped but never flushed"));

    await waitFor("the rejoining client to receive the resumed room", () =>
      docToMarkdown(back.doc).includes("typed but never flushed"),
    );
    expect(docToMarkdown(back.doc)).toBe(resumed);

    // The carry-over lands on the object under the joiner, exactly once.
    await second.flush.flush(id, "manual");
    const after = await stored(id, aliceId);
    expect(after.version).toBeGreaterThan(v0);
    expect(occurrences(after.body, "typed but never flushed")).toBe(1);
    expect(occurrences(after.body, "seed line")).toBe(1);
  });

  it("an MCP write during the outage rebases rather than reverts — both texts survive", async () => {
    const first = await startStack(NO_AUTO_FLUSH);
    const { id, version: v0 } = await create(
      { title: "outage", body: "seed line", visibility: "org" },
      aliceAuth,
    );

    const alice = await mustJoin(first, aliceAuth, id);
    await settle(first, id);

    type(alice.doc, "typed but never flushed");
    await waitFor("the room to hold the unflushed text", () =>
      roomMarkdown(first, id).includes("typed but never flushed"),
    );
    await first.store.persist(id);
    expect((await stored(id, aliceId)).version).toBe(v0);
    await first.kill();

    // The agent writes while the box is down. This is an ACKNOWLEDGED write:
    // somebody may already have read it, so it can never be reverted by a
    // resumed blob.
    const agentWrite = await writer.editFields(
      { actorId: agentId, scopes: ["read", "write"] },
      id,
      {
        baseVersion: v0,
        body: "seed line\n\nagent wrote this",
        reason: "mcp",
      },
    );
    expect(agentWrite.version).toBe(v0 + 1);

    const second = await startStack(NO_AUTO_FLUSH);
    await mustJoin(second, aliceAuth, id);

    // REBASE: re-seed from the authoritative markdown, then re-apply the blob's
    // unflushed delta on top. Neither side is dropped.
    //
    // WAIT for it. `attach` arms the carry-over cycle and runs it CONCURRENTLY
    // with the join returning (see settle()'s note above), so reading the room
    // straight after mustJoin asserts against a race — it passed locally and on
    // the PR, then failed on main with the pre-rebase text
    // ('seed line\n\ntyped but never flushed'), blocking a release. waitFor
    // cannot hide a genuine failure: if the rebase never lands this still fails,
    // just with a timeout instead of a confusing diff.
    await waitFor("the room to rebase onto the agent's acknowledged write", () =>
      roomMarkdown(second, id).includes("agent wrote this"),
    );
    const rebased = roomMarkdown(second, id);
    expect(rebased).toContain("agent wrote this");
    expect(rebased).toContain("typed but never flushed");
    expect(occurrences(rebased, "agent wrote this")).toBe(1);
    expect(occurrences(rebased, "typed but never flushed")).toBe(1);
    expect(occurrences(rebased, "seed line")).toBe(1);

    await second.flush.flush(id, "manual");
    const after = await stored(id, aliceId);
    expect(after.body).toContain("agent wrote this");
    expect(after.body).toContain("typed but never flushed");
    expect(occurrences(after.body, "agent wrote this")).toBe(1);
    expect(occurrences(after.body, "typed but never flushed")).toBe(1);
  });

  // ============================================ narrowing preserves live edits

  it("a visibility narrowing flushes the room's unflushed edits before dropping it", async () => {
    // The bug: narrowing an object to private (or dropping a shared reader)
    // evicted+PURGED the whole room WITHOUT flushing, so the still-authorized
    // editors' just-typed body text — held only in the CRDT — was lost, and the
    // client's reconnect adopted a stale re-seed as authoritative. The fix
    // flushes those edits first: the object still exists and still has
    // authorized editors, so their text belongs in objects.body.
    const stack = await startStack(NO_AUTO_FLUSH);
    const { id, version: v0 } = await create(
      { title: "narrowing", body: "seed line", visibility: "org" },
      aliceAuth,
    );

    const alice = await mustJoin(stack, aliceAuth, id);
    await settle(stack, id);
    type(alice.doc, "typed just before going private");
    await waitFor("the room to hold the unflushed text", () =>
      roomMarkdown(stack, id).includes("typed just before going private"),
    );
    // The keystrokes live in the CRDT only — objects.body does not have them.
    expect((await stored(id, aliceId)).body).not.toContain("typed just before going private");

    // Alice narrows the object to private. This BUMPS the version (leaving the
    // room's baseVersion stale) but does not touch the body — the single-user
    // repro. In production the write path then announces, driving
    // evict → purgeRoom(id, "visibility_changed"); the harness calls purge
    // directly, exactly as its wired purgeRoom does.
    const narrowed = await writer.editFields({ actorId: aliceId, scopes: ["read", "write"] }, id, {
      baseVersion: v0,
      visibility: "private",
      reason: "went private",
    });
    expect(narrowed.version).toBe(v0 + 1);

    await stack.store.purge(id, "visibility_changed", aliceId);

    // The room is gone, AND the typed text was flushed to objects.body first —
    // rebased over the version the narrowing bumped — rather than lost.
    expect(stack.store.get(id)).toBeUndefined();
    const after = await stored(id, aliceId);
    expect(after.body).toContain("seed line");
    expect(after.body).toContain("typed just before going private");
    expect(occurrences(after.body, "typed just before going private")).toBe(1);
    expect(after.version).toBeGreaterThan(narrowed.version);
  });

  it("a narrowing write stamps the AccessChange with the WRITING actor's id", async () => {
    // The actor on the AccessChange is load-bearing, not diagnostic: the collab
    // eviction flushes the room AS this actor, who must still be able to see the
    // object. The narrowing writer (the creator) always can — the room's last
    // joiner may be exactly the member just narrowed away. This pins that the
    // write path stamps the writer, which is where the whole thread starts.
    const seen: AccessChange[] = [];
    const spyWriter = new Writer(pool, { onAccessChange: (c) => seen.push(c) });
    const { id, version } = await create(
      { title: "announce", body: "x", visibility: "org" },
      aliceAuth,
    );
    await spyWriter.editFields({ actorId: aliceId, scopes: ["read", "write"] }, id, {
      baseVersion: version,
      visibility: "private",
      reason: "went private",
    });
    expect(seen).toEqual([{ objectId: id, reason: "visibility_changed", actorId: aliceId }]);
  });

  it("evicts as the WRITER, not the room's last joiner, so a narrowing keeps live text", async () => {
    // THE ORDERING THAT HID THE BUG. Bob joins AFTER Alice, so the room's
    // `lastActorId` is Bob (nothing in production calls `touch`, so typing never
    // moves it). Alice — the creator — has unflushed text in the CRDT and then
    // narrows the object to private, removing Bob's access. The committed write
    // announces, and the collab server's `evict` drives `purgeRoom` → the doc
    // store's teardown flush.
    //
    // Threaded with ALICE (the writer, who can still see the object) the flush's
    // base read succeeds and her text lands. Left to fall back to the room's
    // last joiner BOB — who just lost visibility — that base read returns
    // nothing, the flush no-ops, and Alice's paragraph is gone. This exercises
    // the whole wired path (`collab.evict` → `purgeRoom` → `store.purge`), so it
    // fails on the pre-fix code that dropped the actor at any link.
    const stack = await startStack(NO_AUTO_FLUSH);
    const { id, version: v0 } = await create(
      { title: "ordering", body: "seed", visibility: "org" },
      aliceAuth,
    );

    const alice = await mustJoin(stack, aliceAuth, id);
    await mustJoin(stack, bobAuth, id); // joins LAST → the room's lastActorId is Bob
    await settle(stack, id);
    expect(stack.store.get(id)?.lastActorId).toBe(bobId);

    type(alice.doc, "alice typed, not yet flushed");
    await waitFor("the room to hold Alice's unflushed text", () =>
      roomMarkdown(stack, id).includes("alice typed, not yet flushed"),
    );
    expect((await stored(id, aliceId)).body).not.toContain("alice typed, not yet flushed");

    const narrowed = await writer.editFields({ actorId: aliceId, scopes: ["read", "write"] }, id, {
      baseVersion: v0,
      visibility: "private",
      reason: "went private",
    });

    // The real wired path, actor and all — not a direct `store.purge`.
    stack.collab.evict(id, "visibility_changed", aliceId);
    await waitFor(
      "the room to be torn down by the eviction",
      () => stack.store.get(id) === undefined,
    );

    const after = await stored(id, aliceId);
    expect(after.body).toContain("alice typed, not yet flushed");
    expect(after.version).toBeGreaterThan(narrowed.version);
  });

  // ================================================== no echo, no version churn

  it("a flush's own feed event does not re-enter the bridge, and an idle room writes nothing", async () => {
    // A REAL cadence here: the point is that several flush windows pass with a
    // document open and nothing at all happens.
    const stack = await startStack({ flushIdleMs: 150, flushMaxMs: 1_500 });
    const { id, version: v0 } = await create(
      { title: "echo", body: "line one", visibility: "org" },
      aliceAuth,
    );

    // The watcher starts BEFORE the flush, so the flush's own event is one it
    // actually has to recognise. Starting after would test nothing.
    await stack.bridge.start();

    const alice = await mustJoin(stack, aliceAuth, id);
    type(alice.doc, "line two");

    // The idle cadence flushes on its own — no manual call.
    await waitFor("the idle flush to land", async () => (await stored(id, aliceId)).version > v0);
    const afterFlush = await stored(id, aliceId);
    expect(afterFlush.version).toBe(v0 + 1);
    expect(afterFlush.body).toContain("line two");

    const eventsAfterFlush = (await updateEvents(id, aliceAuth)).length;
    const roomAfterFlush = roomMarkdown(stack, id);

    // Several flush intervals of an OPEN, IDLE document. If the flush's event
    // re-entered the bridge, the bridge would diff stale markdown into the live
    // doc, dirty it, and the next flush would write again — version churn on a
    // document nobody touched, and at worst a stable echo loop.
    for (let i = 0; i < 6; i += 1) {
      await stack.bridge.poll();
      await sleep(200);
    }

    const idle = await stored(id, aliceId);
    expect(idle.version).toBe(afterFlush.version);
    expect(idle.body).toBe(afterFlush.body);
    expect((await updateEvents(id, aliceAuth)).length).toBe(eventsAfterFlush);
    expect(roomMarkdown(stack, id)).toBe(roomAfterFlush);

    const stats = stack.bridge.stats();
    expect(stats.ownFlush).toBeGreaterThanOrEqual(1);
    expect(stats.ingested).toBe(0);
    expect(stats.conflicts).toBe(0);

    // …and the gate is not "drop everything": a genuinely external write still
    // reaches the open editor.
    await writer.editFields({ actorId: agentId, scopes: ["read", "write"] }, id, {
      baseVersion: idle.version,
      body: `${idle.body}\n\nfrom the agent`,
      reason: "mcp",
    });
    await stack.bridge.poll();
    await waitFor("the agent's write to reach the live room", () =>
      roomMarkdown(stack, id).includes("from the agent"),
    );
    expect(stack.bridge.stats().ingested).toBe(1);
  });

  // ========================================================= SIGTERM drain

  it("a SIGTERM during typing loses nothing", async () => {
    // No timer may fire: the ONLY thing that can get these keystrokes into
    // Postgres is the drain.
    const stack = await startStack(NO_AUTO_FLUSH);
    const { id, version: v0 } = await create({ title: "shutdown", body: "before" }, aliceAuth);

    const alice = await mustJoin(stack, aliceAuth, id);
    await settle(stack, id);

    type(alice.doc, "the last paragraph");
    await waitFor("the room to hold the last keystrokes", () =>
      roomMarkdown(stack, id).includes("the last paragraph"),
    );
    const beforeSignal = await stored(id, aliceId);
    expect(beforeSignal.version).toBe(v0);
    expect(beforeSignal.body).not.toContain("the last paragraph");

    const code = await stack.sigterm();
    expect(code).toBe(0);

    const after = await stored(id, aliceId);
    expect(after.version).toBe(v0 + 1);
    expect(after.body).toContain("before");
    expect(after.body).toContain("the last paragraph");

    // The drain's write is a normal attributed write — the person who typed it
    // is on it, not the process.
    const flushes = (await updateEvents(id, aliceAuth)).filter((e) => e.reason === "live editor");
    expect(flushes.map((e) => e.actor)).toEqual([aliceId]);
  });

  // ================================================ the room owns body/title

  it("a body PATCH for an object with a live room is 409 open_in_editor, while props still patch", async () => {
    const stack = await startStack(NO_AUTO_FLUSH);
    const { id, version } = await create(
      { type: "card", title: "open in editor", body: "held by the room", props: { stage: "new" } },
      aliceAuth,
    );

    // No room yet: the phase-1 CAS path is untouched.
    const beforeRoom = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: version, body: "held by the room, edited" },
      aliceAuth,
    );
    expect(beforeRoom.status).toBe(200);
    const v1 = ((await beforeRoom.json()) as { version: number }).version;

    await mustJoin(stack, aliceAuth, id);
    await waitFor("the live-room set to see the room", () => liveRooms.has(id));

    // ONE authoritative writer. A CAS write here would land underneath a CRDT
    // built on the previous version, and the next flush would overwrite it with
    // no 409, no banner and no draft to recover from.
    const bodyPatch = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: v1, body: "clobbered from curl" },
      aliceAuth,
    );
    expect(bodyPatch.status).toBe(409);
    const refusal = (await bodyPatch.json()) as { code: string; reason: string; unblock?: string };
    expect(refusal.code).toBe("conflict");
    expect(refusal.reason).toBe("open_in_editor");

    // Title is room-owned too.
    const titlePatch = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: v1, title: "renamed from curl" },
      aliceAuth,
    );
    expect(titlePatch.status).toBe(409);
    expect(((await titlePatch.json()) as { reason: string }).reason).toBe("open_in_editor");

    // Props are NOT room-owned: the board, the side-peek and every database
    // view keep working while the same object is open in someone's editor.
    const propsPatch = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: v1, props: { stage: "in progress" } },
      aliceAuth,
    );
    expect(propsPatch.status).toBe(200);

    const obj = (await (
      await call("GET", `/api/v1/objects/${id}`, undefined, aliceAuth)
    ).json()) as { props?: Record<string, unknown>; body?: string };
    expect(obj.props?.stage).toBe("in progress");
    // The refused patches changed nothing.
    expect(String(obj.body)).toContain("held by the room, edited");
    expect(String(obj.body)).not.toContain("clobbered from curl");
  });
});
