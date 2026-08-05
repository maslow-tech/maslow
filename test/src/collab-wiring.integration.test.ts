import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Admin, Writer } from "@brain/mcp-tools";
import {
  COLLAB_PATH,
  createBox,
  wireCollab,
  type UpgradeCapableServer,
  type WiredCollab,
} from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * `collab/serialize.ts` BODY_FRAGMENT — the ONE fragment a room's body lives
 * in. Named here rather than guessed: the first draft of this file read
 * `"default"` (TipTap's default) and got an empty string back from a room that
 * was in fact seeded correctly, which is a failure mode worth pinning.
 */
const BODY_FRAGMENT = "body";

/**
 * THE SHIPPED WIRING — does the box a user runs actually do multiplayer?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, AND WHY THE OTHER TWO COLLAB SUITES DID NOT COVER IT
 *
 * `collab-security` and `collab-correctness` are thorough and were green, and
 * the box still refused every single room join, on every box in the fleet,
 * forever. Both suites build their OWN stack: they call `createCollabServer`
 * directly and pass an `authorizeRoom` they wrote inline. `apps/box/src/index.ts`
 * — the actual entrypoint — passed none, and `createCollabServer` is
 * deliberately fail-closed without one, so production logged
 *
 *   "collab: no room authorizer wired — every room join will be refused"
 *
 * and refused. The suites proved the PARTS. Nobody tested the ASSEMBLY, because
 * there was no assembly to test: each test WAS a private assembly, and a test
 * that builds the thing it is testing cannot notice that production builds
 * something else.
 *
 * So the assembly is now a module (`collab/wire.ts`), and this file boots THAT,
 * over a real Node server, with real sockets. It asserts the smallest set of
 * things that were all false before it existed:
 *
 *  1. a member can JOIN a room and sync it (the authorizer is wired at all);
 *  2. two connections in that room CONVERGE — text typed on one arrives on the
 *     other, which is the product;
 *  3. the room seeds from the object's stored body (the doc store is wired);
 *  4. a member who cannot SEE the object is refused, indistinguishably from a
 *     room that does not exist (the privacy invariant survives assembly);
 *  5. no warning about a missing authorizer is emitted.
 *
 * (5) sounds redundant next to (1). It is not: the warning is the exact signal
 * that was there to be read for the whole time the feature was broken, and a
 * test that watches for it fails LOUDLY the next time somebody constructs the
 * server without going through the wiring.
 */

/** A ws client that sends a browser-shaped `Origin`; the gate requires one. */
function originWebSocket(origin: string): new (url: string) => WebSocket {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { origin } });
    }
  } as unknown as new (url: string) => WebSocket;
}

function cookieValue(res: Response, name: string): string | null {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const match = new RegExp(`(?:^|; )${name}=([^;]+)`).exec(raw);
    if (match?.[1]) return match[1];
  }
  return null;
}

interface Auth {
  cookie: string;
  csrf: string;
}

interface Joined {
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  doc: Y.Doc;
  synced: boolean;
  closeCode: number | undefined;
  destroy(): void;
}

describe("collab: the wiring the box ships", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let wired: WiredCollab;
  let http: Server;
  let port: number;
  let app: { request(path: string, init?: RequestInit): Promise<Response> | Response };

  let ownerAuth: Auth;
  let aliceAuth: Auth;
  let bobAuth: Auth;
  let sharedId: string;
  let privateId: string;

  /** Everything the collab wiring logged during boot — see assertion (5). */
  const warnings: string[] = [];

  beforeAll(async () => {
    const realWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
      realWarn(...args);
    };

    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");

    const admin = new Admin(pool);
    const writer = new Writer(pool);
    const owner = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    const alice = await admin.createUser(owner.id, {
      name: "Alice",
      email: "alice@example.com",
      permission: "member",
    });
    const bob = await admin.createUser(owner.id, {
      name: "Bob",
      email: "bob@example.com",
      permission: "member",
    });

    const SECRET = "wiring-test-session-secret";

    // A listener FIRST, so the origin allowlist can name the real port.
    http = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    port = (http.address() as AddressInfo).port;
    http.close();

    const publicHost = `http://127.0.0.1:${port}`;

    // THE PRODUCTION ASSEMBLY. Not a stack assembled here — the same call
    // `apps/box/src/index.ts` makes, with the same hooks.
    wired = wireCollab({
      pool,
      writer,
      server: { pool, sessionSecret: SECRET, publicHost },
      // The bridge polls the feed; nothing here depends on it, and a live timer
      // in a test is a flake generator.
      startBridge: false,
      flushIdleMs: 200,
      flushMaxMs: 2_000,
    });

    const box = createBox({
      pool,
      ownerClient,
      dashboard: {
        sessionSecret: SECRET,
        secureCookies: false,
        liveRooms: wired.collab.rooms,
      },
      collabProbe: () => wired.collab.probeRoom(),
    });
    app = box;

    const server = serve({ fetch: box.fetch, port });
    wired.collab.attach(server as unknown as UpgradeCapableServer);
    http = server as unknown as Server;

    const login = async (token: string): Promise<Auth> => {
      const res = await Promise.resolve(
        box.request("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }),
      );
      expect(res.status).toBe(200);
      const session = cookieValue(res, "brain_session");
      const csrf = cookieValue(res, "brain_csrf");
      if (!session || !csrf) throw new Error("login did not set both cookies");
      return { cookie: `brain_session=${session}; brain_csrf=${csrf}`, csrf };
    };
    ownerAuth = await login(owner.token);
    aliceAuth = await login(alice.token);
    bobAuth = await login(bob.token);

    sharedId = (
      await writer.write(
        { actorId: alice.id, scopes: ["read", "write"] },
        { title: "Roadmap", body: "the shared roadmap", visibility: "org" },
      )
    ).id;
    // Alice's private object: Bob may not join its room, and must not be able
    // to tell "cannot see it" from "does not exist".
    privateId = (
      await writer.write(
        { actorId: alice.id, scopes: ["read", "write"] },
        { title: "Alice only", body: "nobody else may know this exists", visibility: "private" },
      )
    ).id;

    console.warn = realWarn;
  }, 120_000);

  afterAll(async () => {
    await wired?.close().catch(() => undefined);
    await new Promise<void>((resolve) => http?.close(() => resolve()));
    await pool?.end().catch(() => undefined);
    await ownerClient?.end().catch(() => undefined);
    await brain?.drop().catch(() => undefined);
  });

  const ticketFor = async (auth: Auth): Promise<string> => {
    const res = await Promise.resolve(
      app.request("/api/v1/collab/ticket", {
        method: "POST",
        headers: {
          cookie: auth.cookie,
          "content-type": "application/json",
          "x-csrf-token": auth.csrf,
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string };
    return body.ticket;
  };

  /** Open a real socket into a room. Resolves synced, or with the close code. */
  const join = async (auth: Auth, room: string): Promise<Joined> => {
    const ticket = await ticketFor(auth);
    const socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}${COLLAB_PATH}?ticket=${encodeURIComponent(ticket)}`,
      // A collab ticket is SINGLE-USE, so the provider's own retry loop would
      // replay a spent ticket and be refused forever.
      maxAttempts: 1,
      quiet: true,
      WebSocketPolyfill: originWebSocket(`http://127.0.0.1:${port}`),
    });
    const doc = new Y.Doc();
    const out: Joined = {
      socket,
      doc,
      synced: false,
      closeCode: undefined,
      provider: undefined as unknown as HocuspocusProvider,
      destroy(): void {
        out.provider?.destroy();
        socket.destroy();
        doc.destroy();
      },
    };
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      out.provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: room,
        document: doc,
        quiet: true,
        onSynced: () => {
          out.synced = true;
          done();
        },
        onClose: ({ event }) => {
          out.closeCode = event?.code;
          done();
        },
        onAuthenticationFailed: () => done(),
      });
      setTimeout(done, 15_000);
    });
    return out;
  };

  it("does not warn that the room authorizer is missing", () => {
    // The exact line production logged for as long as the feature was broken.
    expect(warnings.filter((w) => w.includes("no room authorizer wired"))).toEqual([]);
  });

  it("a member joins a room, and it is seeded from the object's stored body", async () => {
    const a = await join(aliceAuth, sharedId);
    try {
      expect(a.closeCode, `join refused with ${a.closeCode}`).toBeUndefined();
      expect(a.synced).toBe(true);
      await expect
        .poll(() => a.doc.getXmlFragment(BODY_FRAGMENT).toString(), { timeout: 10_000 })
        .toContain("shared roadmap");
    } finally {
      a.destroy();
    }
  }, 60_000);

  it("two connections in one room converge", async () => {
    const a = await join(aliceAuth, sharedId);
    const b = await join(bobAuth, sharedId);
    try {
      expect(a.synced && b.synced, "both sides synced").toBe(true);

      // Type on A's document exactly as the editor's Yjs binding does.
      a.doc.getXmlFragment(BODY_FRAGMENT).insert(0, [
        (() => {
          const p = new Y.XmlElement("paragraph");
          p.insert(0, [new Y.XmlText("ALPHA-FROM-A")]);
          return p;
        })(),
      ]);

      await expect
        .poll(() => b.doc.getXmlFragment(BODY_FRAGMENT).toString(), {
          message: "B must receive A's text",
          timeout: 15_000,
        })
        .toContain("ALPHA-FROM-A");

      // …and the other direction, because a one-way relay would pass the above.
      b.doc.getXmlFragment(BODY_FRAGMENT).insert(0, [
        (() => {
          const p = new Y.XmlElement("paragraph");
          p.insert(0, [new Y.XmlText("BETA-FROM-B")]);
          return p;
        })(),
      ]);
      await expect
        .poll(() => a.doc.getXmlFragment(BODY_FRAGMENT).toString(), {
          message: "A must receive B's text",
          timeout: 15_000,
        })
        .toContain("BETA-FROM-B");
    } finally {
      a.destroy();
      b.destroy();
    }
  }, 90_000);

  it("a member who cannot see the object is refused — and cannot tell it exists", async () => {
    const bobOnPrivate = await join(bobAuth, privateId);
    const bobOnNothing = await join(bobAuth, "00000000-0000-4000-8000-000000000000");
    try {
      expect(bobOnPrivate.synced).toBe(false);
      expect(bobOnNothing.synced).toBe(false);
      // ONE answer for "cannot see it" and "does not exist". A different close
      // code for the two would make the room an oracle for private objects.
      expect(bobOnPrivate.closeCode).toBe(bobOnNothing.closeCode);
    } finally {
      bobOnPrivate.destroy();
      bobOnNothing.destroy();
    }
  }, 60_000);

  /**
   * THE RELEASE CANARY. `probeRoom()` opens a synthetic room in-process with an
   * EMPTY context — no principal, no object, no database — so the updater's
   * post-swap check reports on the BUILD rather than on RLS or the kill switch.
   *
   * This is here because the first draft of `wire.ts` broke it: its `onConnect`
   * demanded a principal and threw on the probe room, which would have made
   * `collabOk` false and rolled back EVERY RELEASE ON EVERY BOX IN THE FLEET —
   * from a change that looked confined to the editor. A wiring change is a
   * fleet change, so the canary is asserted here, next to the wiring.
   */
  it("does not break the updater's collab canary probe", async () => {
    await expect(wired.collab.probeRoom()).resolves.toBe(true);
    // Twice: the probe must be repeatable and must not leak a room, because the
    // updater runs it on a heartbeat and not just once.
    await expect(wired.collab.probeRoom()).resolves.toBe(true);
  }, 30_000);

  it("the owner's own room still works (the authorizer is not member-only)", async () => {
    const o = await join(ownerAuth, sharedId);
    try {
      expect(o.closeCode).toBeUndefined();
      expect(o.synced).toBe(true);
    } finally {
      o.destroy();
    }
  }, 60_000);
});
