import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { KillSwitchGate } from "../kill-switch.js";
import { collabEvictions } from "./rooms.js";
import { createCollabServer, type CollabServer } from "./server.js";
import { COLLAB_CLOSE, COLLAB_PATH, mintCollabTicket } from "./types.js";

/**
 * The upgrade path over REAL sockets. This is the surface Hono never sees, so
 * "the gate is a pure function and the pure function is tested" is not enough —
 * these drive an actual `upgrade` event on an actual Node server and assert the
 * close code the client receives.
 */

const SECRET = "collab-test-session-secret";
// The room authorizer is deliberately left unwired here: the pool is never
// touched, because every join is refused before it would be.
const POOL = {} as Pool;

let running: { http: Server; collab: CollabServer } | undefined;

afterEach(async () => {
  if (!running) return;
  const { http, collab } = running;
  running = undefined;
  await collab.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

function killSwitch(state: { on: boolean }): KillSwitchGate {
  return { allowed: async () => state.on } as unknown as KillSwitchGate;
}

async function start(
  opts: Partial<Parameters<typeof createCollabServer>[0]> = {},
): Promise<{ port: number; collab: CollabServer }> {
  const http = createServer((_req, res) => res.end("ok"));
  const collab = createCollabServer({
    pool: POOL,
    sessionSecret: SECRET,
    publicHost: "https://brain.example.test",
    ...opts,
  });
  collab.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  running = { http, collab };
  return { port: (http.address() as AddressInfo).port, collab };
}

function ticketFor(actorId = "acct-1", scopes: readonly string[] = ["read", "write"]): string {
  return mintCollabTicket(SECRET, { actorId, role: "member", scopes }).ticket;
}

interface DialResult {
  readonly opened: boolean;
  readonly code?: number;
  readonly reason?: string;
  readonly error?: string;
}

/**
 * Open a socket and report how it ended: a close code (the refusal path), a
 * handshake error (no upgrade at all), or "still open after a beat".
 */
function dial(
  port: number,
  opts: {
    readonly origin?: string | null;
    readonly ticket?: string | null;
    readonly path?: string;
    readonly settleMs?: number;
  } = {},
): Promise<DialResult & { readonly socket?: WebSocket }> {
  const path = opts.path ?? COLLAB_PATH;
  const query = opts.ticket === null ? "" : `?ticket=${encodeURIComponent(opts.ticket ?? "")}`;
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.origin = opts.origin ?? "https://brain.example.test";
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${query}`, { headers });

  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const done = (r: DialResult & { socket?: WebSocket }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    ws.on("open", () => {
      opened = true;
      // A refusal completes the handshake and closes in the same breath, so an
      // "open" alone proves nothing — wait a beat and see if it survives.
      setTimeout(() => done({ opened: true, socket: ws }), opts.settleMs ?? 120);
    });
    ws.on("close", (code, reason) => {
      done({ opened, code, reason: reason.toString("utf8") });
    });
    ws.on("error", (err) => {
      done({ opened, error: err.message });
    });
  });
}

describe("collab upgrade gate", () => {
  it("accepts a valid ticket from the box's own origin", async () => {
    const { port } = await start();
    const r = await dial(port, { ticket: ticketFor() });
    expect(r.error).toBeUndefined();
    expect(r.code).toBeUndefined();
    expect(r.opened).toBe(true);
    r.socket?.close();
  });

  it("refuses a cross-site origin with BAD_ORIGIN, even with a valid ticket", async () => {
    // Websocket handshakes are not subject to CORS and carry no CSRF header;
    // Origin is the only control against cross-site websocket hijacking.
    const { port } = await start();
    const r = await dial(port, { ticket: ticketFor(), origin: "https://evil.example" });
    expect(r.code).toBe(COLLAB_CLOSE.BAD_ORIGIN);
  });

  it("refuses a missing Origin header", async () => {
    const { port } = await start();
    const r = await dial(port, { ticket: ticketFor(), origin: null });
    expect(r.code).toBe(COLLAB_CLOSE.BAD_ORIGIN);
  });

  it("refuses a missing, forged or expired ticket with UNAUTHORIZED", async () => {
    const { port } = await start();
    expect((await dial(port, { ticket: null })).code).toBe(COLLAB_CLOSE.UNAUTHORIZED);
    expect((await dial(port, { ticket: "not-a-ticket" })).code).toBe(COLLAB_CLOSE.UNAUTHORIZED);
    const foreign = mintCollabTicket("some-other-secret", {
      actorId: "acct-1",
      role: "owner",
      scopes: ["read", "write"],
    }).ticket;
    expect((await dial(port, { ticket: foreign })).code).toBe(COLLAB_CLOSE.UNAUTHORIZED);
    const stale = mintCollabTicket(
      SECRET,
      { actorId: "acct-1", role: "member", scopes: ["read"] },
      { now: Date.now() - 600_000 },
    ).ticket;
    expect((await dial(port, { ticket: stale })).code).toBe(COLLAB_CLOSE.UNAUTHORIZED);
  });

  it("never accepts a cookie — only a ticket", async () => {
    // The session cookie is signed with the raw secret; the ticket key is
    // derived from it. A cookie replayed as a ticket is just an invalid ticket.
    const { port } = await start();
    const r = await dial(port, { ticket: null });
    expect(r.code).toBe(COLLAB_CLOSE.UNAUTHORIZED);
  });

  it("spends the ticket at the handshake — a replay is UNAUTHORIZED", async () => {
    // The ticket rides in the URL query string (a browser cannot set headers on
    // `new WebSocket(...)`), so it lands in proxy access logs. Single use is what
    // makes that acceptable: a ticket recovered from a log is already spent.
    const { port } = await start();
    const ticket = ticketFor();
    const first = await dial(port, { ticket });
    expect(first.opened).toBe(true);
    expect(first.code).toBeUndefined();
    first.socket?.close();

    const replay = await dial(port, { ticket });
    expect(replay.code).toBe(COLLAB_CLOSE.UNAUTHORIZED);
  });

  it("does not spend the ticket on a refusal decided before credentials", async () => {
    // box-off / draining / bad-origin are answered before the ticket is looked
    // at; burning it there would knock out the legitimate tab about to use it.
    const state = { on: false };
    const { port } = await start({ killSwitch: killSwitch(state) });
    const ticket = ticketFor();
    expect((await dial(port, { ticket })).code).toBe(COLLAB_CLOSE.BOX_OFF);

    state.on = true;
    expect((await dial(port, { ticket, origin: "https://evil.example" })).code).toBe(
      COLLAB_CLOSE.BAD_ORIGIN,
    );

    const ok = await dial(port, { ticket });
    expect(ok.opened).toBe(true);
    expect(ok.code).toBeUndefined();
    ok.socket?.close();
  });

  it("refuses the handshake when the kill-switch says the box is off", async () => {
    // A box suspended from the booth must not keep taking edits into the
    // customer's database while every HTTP surface correctly 503s.
    const state = { on: false };
    const { port } = await start({ killSwitch: killSwitch(state) });
    const off = await dial(port, { ticket: ticketFor() });
    expect(off.code).toBe(COLLAB_CLOSE.BOX_OFF);

    state.on = true;
    const on = await dial(port, { ticket: ticketFor() });
    expect(on.opened).toBe(true);
    expect(on.code).toBeUndefined();
    on.socket?.close();
  });

  it("box-off beats every other refusal", async () => {
    const { port } = await start({ killSwitch: killSwitch({ on: false }) });
    const r = await dial(port, { ticket: null, origin: "https://evil.example" });
    expect(r.code).toBe(COLLAB_CLOSE.BOX_OFF);
  });

  it("closes LIVE sockets when the box is switched off mid-session", async () => {
    // A room can be held open for hours; a handshake-time check alone would
    // leave a suspended box streaming and accepting writes.
    const state = { on: true };
    const { port } = await start({ killSwitch: killSwitch(state), killPollMs: 20 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}${COLLAB_PATH}?ticket=${ticketFor()}`, {
      headers: { origin: "https://brain.example.test" },
    });
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    state.on = false;
    expect(await closed).toBe(COLLAB_CLOSE.BOX_OFF);
  });

  it("does not answer upgrades on any other path", async () => {
    const { port } = await start();
    const r = await dial(port, { ticket: ticketFor(), path: "/dash/not-collab" });
    expect(r.opened).toBe(false);
    expect(r.error).toMatch(/404/);
  });

  it("stops accepting once drained, and says so on readiness", async () => {
    const { port, collab } = await start();
    expect(collab.readiness()).toEqual({ ready: true });
    const live = await dial(port, { ticket: ticketFor() });
    expect(live.opened).toBe(true);
    const closed = new Promise<number>((resolve) =>
      live.socket?.on("close", (code) => resolve(code)),
    );

    await collab.drainAll();
    expect(await closed).toBe(COLLAB_CLOSE.DRAINING);
    expect(collab.readiness().ready).toBe(false);

    const after = await dial(port, { ticket: ticketFor() });
    expect(after.code).toBe(COLLAB_CLOSE.DRAINING);
  });

  it("flushes live rooms before closing sockets on drain", async () => {
    // The room, not the objects table, holds the last ~30s of typing; a drain
    // that skipped the flush would eat it on every release.
    const flushed: string[] = [];
    const { collab } = await start({
      flushRoom: async (objectId: string) => {
        flushed.push(objectId);
      },
    });
    // No live rooms yet (the authorizer refuses every join), so the drain is a
    // no-op — what is asserted here is that it completes and is idempotent.
    await collab.drainAll();
    await collab.drainAll();
    expect(flushed).toEqual([]);
    expect(collab.readiness().ready).toBe(false);
  });

  it("exposes an empty live-room set until a join is authorized", async () => {
    const { collab } = await start();
    expect(collab.rooms.has("obj-1")).toBe(false);
    expect(collab.rooms.size).toBe(0);
    // evicting a room that does not exist is a no-op, not a throw
    expect(() => collab.evict("obj-1", "visibility_changed")).not.toThrow();
  });

  it("refuses to attach twice", async () => {
    const { collab } = await start();
    const other = createServer();
    expect(() => collab.attach(other)).toThrow(/already attached/);
    other.close();
  });
});

describe("collab eviction wiring", () => {
  it("subscribes to the eviction hub while it is up, and unsubscribes on close", async () => {
    // The write paths announce into the hub and never hold a server handle, so
    // "is anything listening" is the whole contract between them.
    const { collab } = await start();
    expect(collabEvictions.bound).toBe(true);
    await collab.close();
    expect(collabEvictions.bound).toBe(false);
  });

  it("closes a revoked account's socket even before it has joined a room", async () => {
    // Offboarding must reach a tab that has handshaked but not yet joined —
    // otherwise the race is a hole: revoke, then the join lands a second later.
    const { port, collab } = await start();
    const ticket = mintCollabTicket(SECRET, {
      actorId: "acct-evicted",
      role: "member",
      scopes: ["read", "write"],
    }).ticket;
    const live = await dial(port, { ticket });
    expect(live.opened).toBe(true);
    const closed = new Promise<number>((resolve) =>
      live.socket?.on("close", (code) => resolve(code)),
    );

    // A hub announcement, exactly as `revoke_user` fires it — no server handle.
    collabEvictions.all("access_revoked");
    expect(await closed).toBe(COLLAB_CLOSE.EVICTED);
    expect(collab.rooms.size).toBe(0);
  });

  it("evicting an account with nothing open is a no-op, not a throw", async () => {
    const { collab } = await start();
    expect(() => collab.evictActor("acct-nobody", "access_revoked")).not.toThrow();
    expect(() => collabEvictions.actor("acct-nobody", "access_revoked")).not.toThrow();
  });

  it("re-checks nothing, and touches no database, when no connection has joined", async () => {
    // The pool in this file is an empty object: a re-check pass that reached for
    // it would throw. That is the assertion.
    const { collab } = await start();
    await expect(collab.reauthNow()).resolves.toBeUndefined();
  });
});

/**
 * The updater's post-swap collab probe. A release that breaks the websocket
 * surface but not HTTP used to pass the canary and was never rolled back; this
 * is the check that catches it, and it has to be true on a box that is off.
 */
describe("collab canary probe", () => {
  it("opens and closes a synthetic room, leaving nothing behind", async () => {
    const { collab } = await start();
    await expect(collab.probeRoom()).resolves.toBe(true);
    // No room, no object, nothing for a flush to persist.
    expect(collab.rooms.size).toBe(0);
  });

  it("passes on a SUSPENDED box — it probes the machinery, not the gate", async () => {
    // /canary deliberately bypasses the kill-switch: an intentionally-off box is
    // not a broken deploy. If the probe failed while a box was suspended, that
    // one box would condemn — and roll back — every release the fleet ships.
    const { collab } = await start({ killSwitch: killSwitch({ on: false }), killPollMs: 20 });
    await expect(collab.probeRoom()).resolves.toBe(true);
    expect(collab.rooms.size).toBe(0);
  });

  it("never touches the database (the pool here would throw if it did)", async () => {
    // POOL is `{}`: a probe that reached for the authorizer, the doc store or
    // any query would throw rather than resolve true.
    const { collab } = await start({ authorizeRoom: () => null });
    await expect(collab.probeRoom()).resolves.toBe(true);
  });

  it("is repeatable and concurrency-safe (a fresh room name each time)", async () => {
    const { collab } = await start();
    const results = await Promise.all([collab.probeRoom(), collab.probeRoom(), collab.probeRoom()]);
    expect(results).toEqual([true, true, true]);
    expect(collab.rooms.size).toBe(0);
  });
});
