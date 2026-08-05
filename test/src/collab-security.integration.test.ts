import { Buffer } from "node:buffer";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Pool, type Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { Admin, Writer, type WriteContext } from "@brain/mcp-tools";
import {
  COLLAB_CLOSE,
  COLLAB_PATH,
  COLLAB_TICKET_MAX_TTL_SECONDS,
  createBox,
  createCollabServer,
  mintCollabTicket,
  type CollabPrincipal,
  type CollabServer,
  type KillSwitchGate,
  type UpgradeCapableServer,
} from "@brain/box";
import { canJoin, connectionMode, isActive, readScopes } from "@brain/box/dist/collab/auth.js";
import { REAUTH_INTERVAL_MS, type ReauthEvent } from "@brain/box/dist/collab/authz.js";
import { createSqlDocRecords, type RoomView } from "@brain/box/dist/collab/docStore.js";
import {
  createFlushPipeline,
  createWriterFlushWrite,
  poolAccessCheck,
  type FlushPipeline,
  type FlushRooms,
} from "@brain/box/dist/collab/flush.js";
import { markdownDiffBridge } from "@brain/box/dist/collab/mdDiff.js";
import {
  createPresenceRelay,
  docRoom,
  routeRoom,
  type PresenceHandle,
  type PresencePrincipal,
  type PresenceView,
} from "@brain/box/dist/collab/presence.js";
import { applyMarkdownToDoc, docToMarkdown } from "@brain/box/dist/collab/serialize.js";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * COLLAB SECURITY, over real websockets, against a real booted box.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT THE INTEGRATION LEVEL AT ALL
 *
 * The unit tests around `apps/box/src/collab/` prove the pure decisions
 * (`handshakeDecision`, `inboundWriteRefusal`, `reauthorize`, the presence
 * stamp) and even drive real sockets against a bare Node server. None of that
 * can prove the property this file is about: that the gates are WIRED, in the
 * order the design states, on the path a browser actually takes — a websocket
 * upgrade delivered on the Node server's `upgrade` event, which never reaches
 * `app.fetch` and therefore inherits neither the kill-switch middleware, nor
 * the session/CSRF checks, nor the security headers.
 *
 * So the box here is the real one: `createFreshBrain` (RLS, migrations, real
 * accounts) + `createBox` (the Hono app, so a ticket is minted by an
 * authenticated, CSRF-protected HTTP request, exactly as the dashboard does it)
 * + `serve()` (the real Node server) + `collab.attach(server)`. The rooms are
 * seeded from `objects` through an RLS-bound read as the joiner and reconciled
 * by the real flush pipeline writing through the real `Writer`. Every refusal
 * asserted below is a close frame a browser would receive.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS ASSERTED (design phase 2, "Testing → Integration (collab security)")
 *
 *  1. a viewer's inbound Yjs update is REFUSED and never reaches a flush — the
 *     object's version and body are untouched, with a member sitting in the same
 *     room whose flush would otherwise have carried the viewer's text in under
 *     the member's actor. The member's identical edit IS persisted, so the
 *     negative means something;
 *  2. an upgrade from a foreign `Origin` is refused even with a valid session
 *     cookie AND a valid ticket, and the refusal does not spend the ticket;
 *  3. a ticket is single-use and time-bound: a replay and an over-TTL ticket are
 *     both `UNAUTHORIZED`, indistinguishably;
 *  4. a socket held open across a revoke / a member→viewer demotion / an
 *     org→private flip by another member / removal from `shared_with` loses
 *     access within the stated ≤60s bound — driven here by the re-check's own
 *     `reauthNow()` hook rather than by sleeping through a minute, and
 *     deliberately WITHOUT the immediate eviction hook (this test's `Writer` has
 *     no `onAccessChange`), so what is proven is the FLOOR, not the fast path;
 *  5. an upgrade is refused while the kill switch says the box is off, and live
 *     sockets are closed on the flip;
 *  6. a client cannot author another member's `actorId`, nor a `kind: "agent"`
 *     identity, in awareness — the relay overwrites both and peers see the
 *     authenticated identity;
 *  7. route-level presence for a private object is invisible to a recipient who
 *     cannot see it — neither the entry nor any count reveals that it exists.
 *
 * (6) and (7) drive the presence relay directly, with a REAL per-recipient
 * RLS-bound visibility read, because the relay is not yet attached to the
 * websocket surface: stock hocuspocus awareness would relay verbatim, which is
 * precisely the thing the relay exists to replace.
 */

/* ========================================================================== *
 * The wire                                                                    *
 * ========================================================================== */

/**
 * hocuspocus frames every message as `varString(documentName) +
 * varUint(messageType) + …` (lib0 varints). Encoded by hand here on purpose:
 * these tests must depend on the PROTOCOL a browser speaks, not on the server's
 * own encoder — a shared encoder would happily agree with itself about a format
 * neither the client nor the gate actually implements.
 */
const MSG_SYNC = 0;
const MSG_SYNC_REPLY = 4;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

class WireEncoder {
  private readonly bytes: number[] = [];

  varUint(value: number): this {
    let v = value;
    while (v > 127) {
      this.bytes.push(128 | (v & 127));
      v = Math.floor(v / 128);
    }
    this.bytes.push(v & 127);
    return this;
  }

  varString(value: string): this {
    return this.varBytes(new Uint8Array(Buffer.from(value, "utf8")));
  }

  varBytes(value: Uint8Array): this {
    this.varUint(value.length);
    for (const byte of value) this.bytes.push(byte);
    return this;
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class WireDecoder {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}

  varUint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.data[this.pos];
      if (byte === undefined) throw new Error("truncated varuint");
      this.pos += 1;
      value += (byte & 127) * 2 ** shift;
      if ((byte & 128) === 0) return value;
      shift += 7;
      if (shift > 35) throw new Error("varuint too long");
    }
  }

  varBytes(): Uint8Array {
    const length = this.varUint();
    const out = this.data.slice(this.pos, this.pos + length);
    if (out.length !== length) throw new Error("truncated byte array");
    this.pos += length;
    return out;
  }

  varString(): string {
    return Buffer.from(this.varBytes()).toString("utf8");
  }
}

interface CollabFrame {
  readonly name: string;
  readonly type: number;
  readonly step?: number;
  readonly payload?: Uint8Array;
}

/** Best-effort parse; anything undecodable is simply not a frame we waited for. */
function parseFrame(data: Uint8Array): CollabFrame | null {
  try {
    const d = new WireDecoder(data);
    const name = d.varString();
    const type = d.varUint();
    if (type === MSG_SYNC || type === MSG_SYNC_REPLY) {
      const step = d.varUint();
      return { name, type, step, payload: d.varBytes() };
    }
    return { name, type };
  } catch {
    return null;
  }
}

function syncStep1Message(documentName: string, stateVector: Uint8Array): Uint8Array {
  return new WireEncoder()
    .varString(documentName)
    .varUint(MSG_SYNC)
    .varUint(SYNC_STEP_1)
    .varBytes(stateVector)
    .done();
}

function syncUpdateMessage(documentName: string, update: Uint8Array): Uint8Array {
  return new WireEncoder()
    .varString(documentName)
    .varUint(MSG_SYNC)
    .varUint(SYNC_UPDATE)
    .varBytes(update)
    .done();
}

/* ========================================================================== *
 * A socket, as a browser holds one                                            *
 * ========================================================================== */

class CollabSocket {
  private readonly frames: CollabFrame[] = [];
  private readonly listeners = new Set<() => void>();
  private ended: { code: number; reason: string } | undefined;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      const frame = parseFrame(new Uint8Array(data));
      if (frame) this.frames.push(frame);
      this.wake();
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.ended = { code, reason: reason.toString("utf8") };
      this.wake();
    });
    // A socket error must never fail a test by escaping as an unhandled event.
    ws.on("error", () => this.wake());
  }

  private wake(): void {
    for (const listener of [...this.listeners]) listener();
  }

  send(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  /** The close code, or null if the socket is still up after `ms`. */
  closeCode(ms = 2_000): Promise<number | null> {
    return this.settle(ms).then((end) => end?.code ?? null);
  }

  /** The close frame, or null if the socket is still up after `ms`. */
  settle(ms = 2_000): Promise<{ code: number; reason: string } | null> {
    return new Promise((resolve) => {
      if (this.ended) return resolve(this.ended);
      const listener = (): void => {
        if (!this.ended) return;
        cleanup();
        resolve(this.ended);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.ended ?? null);
      }, ms);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
    });
  }

  /** The first frame matching `pred`, or null if the socket closes/times out. */
  waitFrame(pred: (frame: CollabFrame) => boolean, ms = 5_000): Promise<CollabFrame | null> {
    return new Promise((resolve) => {
      const listener = (): void => {
        const hit = this.frames.find(pred);
        if (hit) {
          cleanup();
          resolve(hit);
          return;
        }
        if (this.ended) {
          cleanup();
          resolve(null);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, ms);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
      listener();
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/* ========================================================================== *
 * The harness                                                                 *
 * ========================================================================== */

const SECRET = "collab-security-integration-secret";
/** The box's own public origin. The Origin allowlist is derived from it. */
const ORIGIN = "https://brain.example.test";
/** A tight flush cadence so "after the flush interval" is a test, not a nap. */
const FLUSH_IDLE_MS = 200;
const FLUSH_MAX_MS = 2_000;

interface Auth {
  readonly cookie: string;
  readonly csrf: string;
}

function cookieValue(res: Response, name: string): string | undefined {
  const lines =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const line of lines) {
    const m = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(line);
    if (m) return decodeURIComponent(m[1] as string);
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("collab security (real sockets, real box)", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let admin: Admin;
  let writer: Writer;
  let collab: CollabServer;
  let flush: FlushPipeline;
  let httpServer: ReturnType<typeof serve>;
  let baseUrl: string;
  let wsUrl: string;

  /** The kill-switch answer the collab server consults, flipped by one test. */
  const killState = { on: true };
  /** Everything the ≤60s re-check did, so a downgrade can be told from a close. */
  const reauthEvents: ReauthEvent[] = [];
  /** `collab_docs.last_flushed_version`, in memory — the flush's CAS base. */
  const baseVersions = new Map<string, number>();
  /** The last actor to join a room; the flush's documented attribution fallback. */
  const lastActor = new Map<string, string>();
  /** Sockets opened by a test, closed after it whatever it asserted. */
  const openSockets: CollabSocket[] = [];

  const accounts: Record<string, { id: string; token: string }> = {};
  const objects: Record<string, string> = {};

  const wctx = (actorId: string): WriteContext => ({ actorId, scopes: ["read", "write"] });

  // ---------------------------------------------------------------- HTTP side

  const login = async (token: string): Promise<Auth> => {
    const res = await fetch(`${baseUrl}/api/login`, {
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

  /**
   * A ticket, from the REAL endpoint: session + CSRF + an active-status re-read.
   * Nothing in this file mints a principal the box would not have minted.
   */
  const mintTicket = async (auth: Auth): Promise<string> => {
    const res = await fetch(`${baseUrl}/api/v1/collab/ticket`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string };
    expect(typeof body.ticket).toBe("string");
    return body.ticket;
  };

  const ticketFor = async (token: string): Promise<string> => mintTicket(await login(token));

  // ----------------------------------------------------------- socket helpers

  const dial = async (opts: {
    ticket?: string | null;
    origin?: string | null;
    cookie?: string;
  }): Promise<CollabSocket> => {
    const query = opts.ticket === null ? "" : `?ticket=${encodeURIComponent(opts.ticket ?? "")}`;
    const headers: Record<string, string> = {};
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    if (opts.cookie) headers.cookie = opts.cookie;
    const ws = new WebSocket(`${wsUrl}${COLLAB_PATH}${query}`, { headers });
    const socket = new CollabSocket(ws);
    openSockets.push(socket);
    await new Promise<void>((resolve) => {
      ws.once("open", () => resolve());
      // A refusal completes the handshake and then closes, so "open" fires for
      // refusals too; a genuine handshake failure resolves through close/error.
      ws.once("close", () => resolve());
      ws.once("error", () => resolve());
    });
    return socket;
  };

  /**
   * Open a room the way a client does: sync step 1, then take the server's
   * step 2 as the authoritative document state. `null` when the join was
   * refused (the room is never revealed, so a refusal simply never syncs).
   */
  const joinRoom = async (socket: CollabSocket, objectId: string): Promise<Y.Doc | null> => {
    const doc = new Y.Doc();
    socket.send(syncStep1Message(objectId, Y.encodeStateVector(doc)));
    const frame = await socket.waitFrame(
      (f) => f.name === objectId && f.type === MSG_SYNC && f.step === SYNC_STEP_2,
    );
    if (!frame?.payload) {
      doc.destroy();
      return null;
    }
    Y.applyUpdate(doc, frame.payload, "server");
    return doc;
  };

  /** Type a paragraph into a client-side doc and return the update it produced. */
  const typeParagraph = (doc: Y.Doc, text: string): Uint8Array => {
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      const fragment = doc.getXmlFragment("body");
      const paragraph = new Y.XmlElement("paragraph");
      const content = new Y.XmlText();
      content.insert(0, text);
      paragraph.insert(0, [content]);
      fragment.insert(fragment.length, [paragraph]);
    }, "local");
    return Y.encodeStateAsUpdate(doc, before);
  };

  /** Join as an account, end to end: login → ticket → upgrade → room. */
  const joinAs = async (
    token: string,
    objectId: string,
  ): Promise<{ socket: CollabSocket; doc: Y.Doc }> => {
    const socket = await dial({ ticket: await ticketFor(token) });
    const doc = await joinRoom(socket, objectId);
    expect(doc, "expected the join to be authorized").not.toBeNull();
    return { socket, doc: doc as Y.Doc };
  };

  // --------------------------------------------------------------- DB helpers

  /**
   * Read the object AS an actor, RLS-bound — the same shape as `visibleTo`
   * below. Since the 0057 tag model a bare pool read (no actor GUC) sees
   * NOTHING on `objects` — org visibility now means "the viewer holds the org
   * tag", and a connection with no actor holds none — so every baseline read
   * here must name a viewer. Defaults to alice, who created every object in
   * this file (a creator keeps seeing their own rows even after a flip).
   */
  const readObject = async (
    objectId: string,
    asActorId?: string,
  ): Promise<{ version: number; body: string; title: string | null }> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(
        "SELECT set_config('app.actor_id', $1, true), set_config('app.on_behalf_of', '', true)",
        [asActorId ?? accounts.alice!.id],
      );
      const { rows } = await client.query<{ version: number; body: string | null; title: string }>(
        "SELECT version, body, title FROM objects WHERE id = $1",
        [objectId],
      );
      await client.query("COMMIT");
      const row = rows[0];
      if (!row) throw new Error(`no such object ${objectId}`);
      return { version: Number(row.version), body: row.body ?? "", title: row.title };
    } finally {
      client.release();
    }
  };

  /**
   * THE per-recipient visibility read: an RLS-bound `SELECT` as that actor, the
   * same rule `probeJoin` uses. Never a predicate re-implemented here — there is
   * one visibility rule and it lives in Postgres.
   */
  const visibleTo = async (
    actorId: string,
    objectIds: readonly string[],
  ): Promise<readonly string[]> => {
    if (objectIds.length === 0) return [];
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(
        "SELECT set_config('app.actor_id', $1, true), set_config('app.on_behalf_of', '', true)",
        [actorId],
      );
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM objects WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
        [[...objectIds]],
      );
      await client.query("COMMIT");
      return rows.map((r) => r.id);
    } finally {
      client.release();
    }
  };

  const presencePrincipalFor = async (
    actorId: string,
    kind: "human" | "agent" = "human",
  ): Promise<PresencePrincipal> => {
    const { rows } = await pool.query<{ name: string }>("SELECT name FROM accounts WHERE id = $1", [
      actorId,
    ]);
    return { kind, actorId, name: rows[0]?.name ?? "Member" };
  };

  // ------------------------------------------------------------------- boot

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    admin = new Admin(pool);
    // NO `onAccessChange`: the immediate eviction hub is deliberately NOT wired
    // in this file. Every eviction asserted below therefore comes from the ≤60s
    // re-check — the floor the design promises, not the fast path that usually
    // beats it to the socket.
    writer = new Writer(pool);
    const records = createSqlDocRecords(pool);

    const owner = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    accounts.owner = owner;
    for (const [key, name, permission] of [
      ["alice", "Alice Member", "member"],
      ["bob", "Bob Member", "member"],
      ["dana", "Dana Demoted", "member"],
      ["rex", "Rex Revoked", "member"],
      ["claude", "Claude", "member"],
      ["vera", "Vera Viewer", "viewer"],
    ] as const) {
      accounts[key] = await admin.createUser(owner.id, {
        name,
        email: `${key}@example.com`,
        permission,
      });
    }

    const alice = accounts.alice!.id;
    objects.viewerDoc = (
      await writer.write(wctx(alice), {
        title: "Roadmap",
        body: "the shared roadmap",
        visibility: "org",
      })
    ).id;
    objects.memberDoc = (
      await writer.write(wctx(alice), {
        title: "Notes",
        body: "the shared notes",
        visibility: "org",
      })
    ).id;
    objects.revokeDoc = (
      await writer.write(wctx(alice), {
        title: "Offboarding",
        body: "still org-visible",
        visibility: "org",
      })
    ).id;
    objects.demoteDoc = (
      await writer.write(wctx(alice), {
        title: "Demotion",
        body: "still org-visible",
        visibility: "org",
      })
    ).id;
    objects.flipDoc = (
      await writer.write(wctx(alice), {
        title: "Comp",
        body: "about to become private",
        visibility: "org",
      })
    ).id;
    const shareDocCreated = await writer.write(wctx(alice), {
      title: "Shared privately",
      body: "shared with bob, for now",
      visibility: "private",
    });
    objects.shareDoc = shareDocCreated.id;
    await writer.edit(wctx(alice), objects.shareDoc, {
      sharedWith: [accounts.bob!.id],
      version: shareDocCreated.version,
    });
    objects.privateDoc = (
      await writer.write(wctx(alice), {
        title: "Alice only",
        body: "nobody else may know this exists",
        visibility: "private",
      })
    ).id;
    objects.killDoc = (
      await writer.write(wctx(alice), {
        title: "Kill switch",
        body: "org-visible",
        visibility: "org",
      })
    ).id;

    // A gate object shaped exactly like the one `index.ts` hands the collab
    // server. Only the collab surface is gated here: what is under test is the
    // upgrade path, which is the surface Hono's middleware never sees.
    const killSwitch = {
      allowed: async (): Promise<boolean> => killState.on,
    } as unknown as KillSwitchGate;

    /**
     * The room-facing slice of the (not-yet-assembled) doc store: hocuspocus's
     * own `Document` IS the room's Y.Doc, which is the shape the production
     * wiring takes — the store seeds it in `onLoadDocument`, exactly as below.
     */
    const documents = (): Map<string, Y.Doc> =>
      (collab.hocuspocus as unknown as { documents: Map<string, Y.Doc> }).documents;

    const flushRooms: FlushRooms = {
      get(objectId: string): RoomView | undefined {
        const doc = documents().get(objectId);
        if (!doc) return undefined;
        return {
          objectId,
          doc,
          epoch: 1,
          baseVersion: baseVersions.get(objectId) ?? 0,
          state: "idle",
          connections: 1,
          lastActorId: lastActor.get(objectId) ?? "",
          // No animation in this harness; a non-null target would suspend the
          // flush pipeline entirely (phase 5).
          animatingTargetVersion: null,
        };
      },
      async markFlushed(objectId: string, version: number): Promise<void> {
        baseVersions.set(objectId, version);
      },
    };

    flush = createFlushPipeline({
      rooms: flushRooms,
      // The SAME core write every other mutation goes through — so a leaked
      // keystroke would show up as a real version, with real attribution.
      write: createWriterFlushWrite(writer, { reason: "live editor" }),
      readObject: async (actorId, objectId) => (await records.load(actorId, objectId)).object,
      canWrite: poolAccessCheck(pool),
      // Hocuspocus applies a client's update with the `Connection` as the
      // transaction origin, and the connection carries the authenticated
      // principal — so this is where "who typed this" comes from.
      resolveContributor: (origin) => {
        const connection = origin as
          { context?: { principal?: CollabPrincipal }; readOnly?: unknown } | null | undefined;
        const principal = connection?.context?.principal;
        if (!principal) return null;
        return { actorId: principal.actorId, canWrite: connection?.readOnly !== true };
      },
      applyMarkdownDiff: markdownDiffBridge,
      idleMs: FLUSH_IDLE_MS,
      maxMs: FLUSH_MAX_MS,
    });

    collab = createCollabServer({
      pool,
      sessionSecret: SECRET,
      publicHost: ORIGIN,
      killSwitch,
      killPollMs: 25,
      // The STATED bound, unchanged. Passes are driven by `reauthNow()` below —
      // the design's own hook — rather than by sleeping for a minute.
      reauthIntervalMs: REAUTH_INTERVAL_MS,
      onReauthEvent: (event) => reauthEvents.push(event),
      // The three checks, wired as the design states: an RLS-bound join read as
      // the joiner, and the write grant from the account's CURRENT DB scopes.
      authorizeRoom: async ({ pool: p, principal, objectId }) => {
        if (!(await canJoin(p, principal.actorId, objectId))) return null;
        const access = await readScopes(p, principal.actorId);
        if (!isActive(access)) return null;
        lastActor.set(objectId, principal.actorId);
        return { readOnly: connectionMode(access?.scopes ?? []) === "ro" };
      },
      flushRoom: (objectId: string) => flush.flush(objectId, "drain"),
    });

    // Seed the room from `objects` — read as the JOINER, so the room's content
    // never comes from a wider read than the join itself. Registered as an
    // extension rather than through `configure()`, which would re-register every
    // hook the server already owns.
    (
      collab.hocuspocus as unknown as {
        configuration: { extensions: Record<string, unknown>[] };
      }
    ).configuration.extensions.push({
      onLoadDocument: async (payload: {
        documentName: string;
        document: Y.Doc;
        context?: { principal?: CollabPrincipal };
      }): Promise<void> => {
        const actorId = payload.context?.principal?.actorId;
        if (!actorId) return;
        const { object } = await records.load(actorId, payload.documentName);
        if (!object || object.deleted) return;
        applyMarkdownToDoc(payload.document, object.body ?? "", object.title);
        baseVersions.set(payload.documentName, object.version);
        flush.attach(payload.documentName, actorId);
      },
    });

    const app = createBox({
      pool,
      ownerClient,
      dashboard: {
        sessionSecret: SECRET,
        secureCookies: false,
        liveRooms: collab.rooms,
      },
    });

    const started = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
      (resolve) => {
        const server: ReturnType<typeof serve> = serve(
          { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
          () => resolve({ server, port: (server.address() as AddressInfo).port }),
        );
      },
    );
    httpServer = started.server;
    baseUrl = `http://127.0.0.1:${started.port}`;
    wsUrl = `ws://127.0.0.1:${started.port}`;
    // The line where everything Hono guarantees stops.
    collab.attach(httpServer as unknown as UpgradeCapableServer);
  }, 180_000);

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.close();
    // Let hocuspocus finish unloading the rooms those sockets held, so the next
    // test's join runs the join check again instead of resuming a live room.
    await sleep(50);
    killState.on = true;
  });

  afterAll(async () => {
    flush?.close();
    await collab?.close();
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await pool?.end();
    await ownerClient?.end();
    await brain?.drop();
  });

  /* ====================================================================== *
   * 1. The inbound write gate                                               *
   * ====================================================================== */

  it("refuses a viewer's Yjs update, and it never reaches a flush", async () => {
    const objectId = objects.viewerDoc!;

    // A MEMBER is in the room and stays there. That is the attack this asserts
    // against: without the inbound gate the viewer types, the doc changes, and
    // the member's own flush carries the viewer's text into the brain under the
    // MEMBER's actor — a second, unguarded write path with clean attribution.
    const member = await joinAs(accounts.alice!.token, objectId);
    expect(docToMarkdown(member.doc)).toContain("the shared roadmap");
    expect(collab.rooms.has(objectId)).toBe(true);

    // Settle the room's own attach-time flush first, so the baseline is what
    // the seeded room reconciles to rather than whatever it started at.
    await sleep(FLUSH_IDLE_MS * 3);
    await flush.flush(objectId, "manual");
    const before = await readObject(objectId);

    const viewer = await dial({ ticket: await ticketFor(accounts.vera!.token) });
    const viewerDoc = await joinRoom(viewer, objectId);
    // A viewer may READ the room — refusing the join would break reading, not
    // tighten anything. The gate is on the bytes, not the door.
    expect(viewerDoc).not.toBeNull();

    const update = typeParagraph(viewerDoc as Y.Doc, "VIEWER-INJECTED-TEXT");
    viewer.send(syncUpdateMessage(objectId, update));

    const end = await viewer.settle(4_000);
    expect(end?.code).toBe(COLLAB_CLOSE.ROOM_FORBIDDEN);
    expect(end?.reason).toBe("read-only connection");

    // The member's socket is untouched: one client's refusal is not everyone's
    // outage.
    expect(await member.socket.closeCode(200)).toBeNull();

    // Now give the flush every chance to carry it: past the idle window, then a
    // forced cycle while the member is still in the room.
    await sleep(FLUSH_IDLE_MS * 3);
    await flush.flush(objectId, "manual");

    const after = await readObject(objectId);
    expect(after.version).toBe(before.version);
    expect(after.body).toBe(before.body);
    expect(after.body).not.toContain("VIEWER-INJECTED-TEXT");
    // …and it never even reached the server's copy of the document.
    const room = (collab.hocuspocus as unknown as { documents: Map<string, Y.Doc> }).documents.get(
      objectId,
    );
    expect(room && docToMarkdown(room)).not.toContain("VIEWER-INJECTED-TEXT");
  });

  it("persists a MEMBER's identical edit — the control that makes the refusal mean something", async () => {
    const objectId = objects.memberDoc!;
    const member = await joinAs(accounts.alice!.token, objectId);
    await sleep(FLUSH_IDLE_MS * 3);
    await flush.flush(objectId, "manual");
    const before = await readObject(objectId);

    member.socket.send(syncUpdateMessage(objectId, typeParagraph(member.doc, "MEMBER-TYPED-TEXT")));

    // The socket survives (the gate is a gate, not a tripwire for everyone)…
    expect(await member.socket.closeCode(FLUSH_IDLE_MS * 3)).toBeNull();
    await flush.flush(objectId, "manual");

    const after = await readObject(objectId);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.body).toContain("MEMBER-TYPED-TEXT");
  });

  /* ====================================================================== *
   * 2. Origin                                                               *
   * ====================================================================== */

  it("refuses a foreign Origin even with a valid session cookie and ticket", async () => {
    // Websocket handshakes are not subject to CORS and carry no CSRF header, so
    // with a SameSite cookie the Origin allowlist is the ONLY control against
    // cross-site websocket hijacking. Handing the attacker both the cookie and a
    // freshly minted ticket is the point: neither is what refuses this.
    const auth = await login(accounts.alice!.token);
    const ticket = await mintTicket(auth);

    const evil = await dial({ ticket, origin: "https://evil.example", cookie: auth.cookie });
    expect(await evil.closeCode()).toBe(COLLAB_CLOSE.BAD_ORIGIN);

    const noOrigin = await dial({ ticket, origin: null, cookie: auth.cookie });
    expect(await noOrigin.closeCode()).toBe(COLLAB_CLOSE.BAD_ORIGIN);

    // And the cross-site attempt did not burn the ticket the real tab is about
    // to use: Origin is answered before credentials are looked at.
    const good = await dial({ ticket });
    expect(await good.closeCode(300)).toBeNull();
  });

  /* ====================================================================== *
   * 3. The ticket                                                           *
   * ====================================================================== */

  it("spends a ticket at the handshake — a replay is refused", async () => {
    // The ticket rides in the URL query string (a browser cannot set headers on
    // `new WebSocket(...)`), so it lands in proxy access logs. Single use is what
    // makes that acceptable.
    const ticket = await ticketFor(accounts.alice!.token);
    const first = await dial({ ticket });
    expect(await first.closeCode(300)).toBeNull();
    first.close();

    const replay = await dial({ ticket });
    expect(await replay.closeCode()).toBe(COLLAB_CLOSE.UNAUTHORIZED);
  });

  it("refuses a ticket older than its TTL, indistinguishably from a forged one", async () => {
    const alice = accounts.alice!.id;
    const stale = mintCollabTicket(
      SECRET,
      { actorId: alice, role: "member", scopes: ["read", "write"] },
      { now: Date.now() - (COLLAB_TICKET_MAX_TTL_SECONDS + 60) * 1_000 },
    ).ticket;
    const expired = await dial({ ticket: stale });
    expect(await expired.closeCode()).toBe(COLLAB_CLOSE.UNAUTHORIZED);

    const forged = mintCollabTicket("some-other-secret", {
      actorId: alice,
      role: "owner",
      scopes: ["read", "write"],
    }).ticket;
    const rejected = await dial({ ticket: forged });
    // One answer for every failure mode — a probe learns nothing about which
    // check refused it.
    expect(await rejected.closeCode()).toBe(COLLAB_CLOSE.UNAUTHORIZED);
  });

  /* ====================================================================== *
   * 4. Live re-authorization (the ≤60s floor)                               *
   * ====================================================================== */

  it("states a ≤60s re-check bound and honours it", () => {
    expect(REAUTH_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  it("evicts a socket whose account was revoked", async () => {
    const objectId = objects.revokeDoc!;
    const rex = accounts.rex!;
    const { socket } = await joinAs(rex.token, objectId);

    await admin.revokeAccount(accounts.owner!.id, rex.id);
    // No eviction hub is wired here — this is the periodic re-check doing it.
    await collab.reauthNow();

    const end = await socket.settle(3_000);
    expect(end?.code).toBe(COLLAB_CLOSE.EVICTED);
    expect(end?.reason).toBe("access_revoked");
    expect(
      reauthEvents.some(
        (e) => e.kind === "evicted" && e.actorId === rex.id && e.reason === "access_revoked",
      ),
    ).toBe(true);
  });

  it("takes write away from a member demoted to viewer, within the same bound", async () => {
    const objectId = objects.demoteDoc!;
    const dana = accounts.dana!;
    const { socket, doc } = await joinAs(dana.token, objectId);
    await sleep(FLUSH_IDLE_MS * 3);
    await flush.flush(objectId, "manual");
    const before = await readObject(objectId);

    // A DIRECT SQL demotion, deliberately: no route fires an eviction for it, so
    // this is exactly the class of change the periodic re-check exists to catch.
    await ownerClient.query(
      "UPDATE accounts SET role = 'viewer', scopes = ARRAY['read']::text[] WHERE id = $1",
      [dana.id],
    );
    await collab.reauthNow();

    // A lost WRITE scope is a downgrade in place, not an eviction: the design
    // closes a connection that lost READ access, and keeps one that can still
    // read. What must be true either way is that it can no longer write.
    expect(await socket.closeCode(200)).toBeNull();
    expect(reauthEvents.some((e) => e.kind === "downgraded" && e.actorId === dana.id)).toBe(true);

    socket.send(syncUpdateMessage(objectId, typeParagraph(doc, "AFTER-DEMOTION-TEXT")));
    const end = await socket.settle(4_000);
    expect(end?.code).toBe(COLLAB_CLOSE.ROOM_FORBIDDEN);

    await sleep(FLUSH_IDLE_MS * 3);
    await flush.flush(objectId, "manual");
    const after = await readObject(objectId);
    expect(after.version).toBe(before.version);
    expect(after.body).not.toContain("AFTER-DEMOTION-TEXT");
  });

  it("evicts a socket when another member flips the object org→private", async () => {
    const objectId = objects.flipDoc!;
    const creator = await joinAs(accounts.alice!.token, objectId);
    const other = await joinAs(accounts.bob!.token, objectId);

    await writer.edit(wctx(accounts.alice!.id), objectId, {
      visibility: "private",
      version: (await readObject(objectId)).version,
    });
    await collab.reauthNow();

    const end = await other.socket.settle(3_000);
    expect(end?.code).toBe(COLLAB_CLOSE.EVICTED);
    // Never "deleted", never "unshared": the probe cannot tell those apart, and
    // the reason travels to the browser. A close frame must not become an oracle.
    expect(end?.reason).toBe("visibility_changed");
    // The creator, who may still see it, keeps their room.
    expect(await creator.socket.closeCode(200)).toBeNull();
  });

  it("evicts a socket when the account is removed from shared_with", async () => {
    const objectId = objects.shareDoc!;
    const shared = await joinAs(accounts.bob!.token, objectId);
    // Sharing is what let bob in at all — 0012's `shared_with`, not org
    // visibility, so this proves the join read is the real RLS predicate.
    expect(docToMarkdown(shared.doc)).toContain("shared with bob");

    // The version read must be RLS-bound AS ALICE: shareDoc is private, and
    // `readObject` reads as alice — the creator — by default.
    const shareDocVersion = (await readObject(objectId)).version;
    await writer.edit(wctx(accounts.alice!.id), objectId, {
      sharedWith: [],
      version: shareDocVersion,
    });
    await collab.reauthNow();

    const end = await shared.socket.settle(3_000);
    expect(end?.code).toBe(COLLAB_CLOSE.EVICTED);
    // Same reason as the visibility flip, on purpose: an unshare must not be
    // distinguishable from any other narrowing.
    expect(end?.reason).toBe("visibility_changed");
  });

  /* ====================================================================== *
   * 5. The kill switch                                                      *
   * ====================================================================== */

  it("refuses upgrades while the box is off, and closes live sockets on the flip", async () => {
    const objectId = objects.killDoc!;
    const live = await joinAs(accounts.alice!.token, objectId);
    // Minted while the box is ON; the refusal below must not consume it.
    const ticket = await ticketFor(accounts.alice!.token);

    killState.on = false;

    const end = await live.socket.settle(3_000);
    expect(end?.code).toBe(COLLAB_CLOSE.BOX_OFF);

    const refused = await dial({ ticket });
    expect(await refused.closeCode()).toBe(COLLAB_CLOSE.BOX_OFF);

    killState.on = true;
    // Box-off is answered before credentials, so the ticket survived the refusal.
    const back = await dial({ ticket });
    expect(await back.closeCode(300)).toBeNull();
  });

  /* ====================================================================== *
   * 6 + 7. Presence                                                         *
   * ====================================================================== */

  describe("presence relay", () => {
    const views = new Map<string, PresenceView>();
    const violations: { handle: PresenceHandle; keys: readonly string[] }[] = [];
    let relay: ReturnType<typeof createPresenceRelay>;

    beforeAll(() => {
      relay = createPresenceRelay({
        send: (recipient, view) => views.set(recipient.clientId, view),
        // The real per-recipient RLS read. Nothing else may decide what a
        // recipient is told about.
        visibleTo,
        onViolation: (handle, keys) => violations.push({ handle, keys }),
      });
    });

    afterEach(() => {
      views.clear();
      violations.length = 0;
    });

    it("overwrites a client's attempt to author another member's identity", async () => {
      const room = docRoom(objects.viewerDoc!);
      expect(room).not.toBeNull();
      const alice = await presencePrincipalFor(accounts.alice!.id);
      const bob = await presencePrincipalFor(accounts.bob!.id);
      const aliceHandle = relay.join(room as `doc:${string}`, alice, { clientId: "doc-alice" });
      const bobHandle = relay.join(room as `doc:${string}`, bob, { clientId: "doc-bob" });
      expect(aliceHandle).not.toBeNull();
      expect(bobHandle).not.toBeNull();

      // Bob publishes a state claiming to BE Alice — and, for good measure, to
      // be the agent, whose entries the rail draws differently.
      relay.update(bobHandle as PresenceHandle, {
        kind: "agent",
        actorId: alice.actorId,
        name: alice.name,
        color: "presence-agent",
        glyph: "robot",
        anchor: 12,
        head: 12,
        objectId: objects.privateDoc,
      });
      await relay.broadcast(room as `doc:${string}`);

      const seen = views.get("doc-alice");
      expect(seen).toBeDefined();
      const spoofer = seen?.states.find((s) => s.clientId === "doc-bob");
      expect(spoofer).toBeDefined();
      // Identity is the SERVER's, from the authenticated principal.
      expect(spoofer?.actorId).toBe(bob.actorId);
      expect(spoofer?.kind).toBe("human");
      expect(spoofer?.name).toBe(bob.name);
      expect(spoofer?.glyph).not.toBe("robot");
      // The position half — the only thing a client authors — survives.
      expect(spoofer?.position).toEqual({ anchor: 12, head: 12 });
      // Nobody in this room is an agent.
      expect(seen?.states.some((s) => s.kind === "agent")).toBe(false);
      expect(seen?.counts.agents).toBe(0);
      // The only `objectId` on the wire is the ROOM's own — a doc room IS the
      // visibility boundary — never the private id the client tried to smuggle
      // in under a key that is not on the position allowlist.
      expect(spoofer?.objectId).toBe(objects.viewerDoc);
      expect(JSON.stringify(seen)).not.toContain(objects.privateDoc!);

      // A well-behaved client never authors an identity key, so this is a
      // protocol violation worth logging — not a stray field.
      expect(violations.length).toBe(1);
      for (const key of ["kind", "actorId", "name", "color", "glyph", "objectId"]) {
        expect(violations[0]?.keys).toContain(key);
      }

      relay.leave(aliceHandle as PresenceHandle);
      relay.leave(bobHandle as PresenceHandle);
    });

    it("hides a private object from route-level presence — entry AND count", async () => {
      const route = routeRoom("deals");
      expect(route).not.toBeNull();
      // A route key may never embed an object id: route rooms are joinable by
      // anyone, so membership itself would become the oracle.
      expect(routeRoom(`object/${objects.privateDoc!}`)).toBeNull();

      const alice = await presencePrincipalFor(accounts.alice!.id);
      const bob = await presencePrincipalFor(accounts.bob!.id);
      const aliceHandle = relay.join(route as `route:${string}`, alice, { clientId: "r-alice" });
      const bobHandle = relay.join(route as `route:${string}`, bob, { clientId: "r-bob" });
      expect(aliceHandle).not.toBeNull();
      expect(bobHandle).not.toBeNull();

      // Alice has her private note open in side-peek. The relay learns that
      // server-side (never from a client payload).
      relay.focus(aliceHandle as PresenceHandle, objects.privateDoc!);
      await relay.broadcast(route as `route:${string}`);

      const bobView = views.get("r-bob");
      expect(bobView).toBeDefined();
      const aliceToBob = bobView?.states.find((s) => s.actorId === alice.actorId);
      // The HUMAN stays in the rail: an avatar that blinks out the moment its
      // owner opens something private IS the announcement.
      expect(aliceToBob).toBeDefined();
      // …but the object does not travel with her, and no count admits it.
      expect(aliceToBob?.objectId).toBeUndefined();
      expect(bobView?.counts.objects).toBe(0);
      expect(bobView?.counts.objectsByActor[alice.actorId]).toBeUndefined();
      expect(JSON.stringify(bobView)).not.toContain(objects.privateDoc!);

      // Alice's own view resolves it, because her own RLS read returns it.
      const aliceView = views.get("r-alice");
      expect(aliceView?.states.find((s) => s.actorId === alice.actorId)?.objectId).toBe(
        objects.privateDoc,
      );
      expect(aliceView?.counts.objects).toBe(1);
      expect(aliceView?.counts.objectsByActor[alice.actorId]).toBe(1);

      // The filter is not "always hide": an org-visible object resolves for both.
      relay.focus(aliceHandle as PresenceHandle, objects.memberDoc!);
      await relay.broadcast(route as `route:${string}`);
      expect(views.get("r-bob")?.states.find((s) => s.actorId === alice.actorId)?.objectId).toBe(
        objects.memberDoc,
      );
      expect(views.get("r-bob")?.counts.objects).toBe(1);

      relay.leave(aliceHandle as PresenceHandle);
      relay.leave(bobHandle as PresenceHandle);
    });

    it("drops an agent entirely from a recipient who cannot see what it is writing", async () => {
      const route = routeRoom("deals");
      const alice = await presencePrincipalFor(accounts.alice!.id);
      const bob = await presencePrincipalFor(accounts.bob!.id);
      const agent = await presencePrincipalFor(accounts.claude!.id, "agent");
      const aliceHandle = relay.join(route as `route:${string}`, alice, { clientId: "a-alice" });
      const bobHandle = relay.join(route as `route:${string}`, bob, { clientId: "a-bob" });
      const agentHandle = relay.join(route as `route:${string}`, agent, { clientId: "a-agent" });
      relay.focus(agentHandle as PresenceHandle, objects.privateDoc!);
      await relay.broadcast(route as `route:${string}`);

      // An agent's presence IS the write. With no object this recipient can see,
      // an agent entry is nothing but "an invisible write happened".
      const bobView = views.get("a-bob");
      expect(bobView?.states.some((s) => s.kind === "agent")).toBe(false);
      expect(bobView?.counts.agents).toBe(0);
      expect(JSON.stringify(bobView)).not.toContain(objects.privateDoc!);

      // For the one person who can see the object, the agent is there.
      const aliceView = views.get("a-alice");
      expect(
        aliceView?.states.some((s) => s.kind === "agent" && s.objectId === objects.privateDoc),
      ).toBe(true);
      expect(aliceView?.counts.agents).toBe(1);

      relay.leave(aliceHandle as PresenceHandle);
      relay.leave(bobHandle as PresenceHandle);
      relay.leave(agentHandle as PresenceHandle);
    });
  });
});
