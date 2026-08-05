import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createReauthLoop,
  inboundWriteRefusal,
  isDocumentMutation,
  reauthorize,
  REAUTH_INTERVAL_MS,
  type LiveCollabConnection,
  type ReauthEvent,
} from "./authz.js";
import { COLLAB_CLOSE } from "./types.js";

/**
 * The re-check is the control that makes offboarding real for a socket that is
 * already open, so these assert the two failure modes that would make it
 * theatre: an evict that never fires, and an evict that fires on a database
 * blip and empties every editor on the box.
 */

/* -------------------------------------------------------------- fake pool */

interface FakeState {
  /** account row, or null for "no such account". */
  account: { scopes: string[]; status: string; role: string } | null;
  /** does the RLS-bound join read see the object? */
  visible: boolean;
  /** make the account read throw (an outage, not an answer). */
  accountThrows?: boolean;
  /** make the join read throw. */
  joinThrows?: boolean;
}

/**
 * Enough of `pg` for `readScopes` (pool.query) and `probeJoin` (pool.connect →
 * BEGIN / set_config / SELECT / COMMIT).
 */
function fakePool(state: FakeState): Pool {
  const client = {
    query: async (sql: string) => {
      if (/^SELECT 1 FROM objects/.test(sql)) {
        if (state.joinThrows) throw new Error("boom");
        return { rowCount: state.visible ? 1 : 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release: () => undefined,
  };
  return {
    query: async () => {
      if (state.accountThrows) throw new Error("boom");
      return { rows: state.account ? [state.account] : [] };
    },
    connect: async () => client,
  } as unknown as Pool;
}

const OBJ = "11111111-2222-3333-4444-555555555555";

function member(scopes: string[] = ["read", "write"]): FakeState["account"] {
  return { scopes, status: "active", role: "member" };
}

/* ----------------------------------------------------------- the decision */

describe("reauthorize", () => {
  it("keeps a member with write scope in write mode", async () => {
    const pool = fakePool({ account: member(), visible: true });
    expect(await reauthorize(pool, "acct-1", OBJ)).toEqual({ action: "keep", mode: "rw" });
  });

  it("reports read-only for an account demoted to viewer", async () => {
    // The ticket said member; the DB now says viewer. The DB wins — that is the
    // whole point of re-reading instead of trusting the mint-time snapshot.
    const pool = fakePool({ account: member(["read"]), visible: true });
    expect(await reauthorize(pool, "acct-1", OBJ)).toEqual({ action: "keep", mode: "ro" });
  });

  it("evicts a revoked account", async () => {
    const pool = fakePool({
      account: { scopes: ["read", "write"], status: "revoked", role: "member" },
      visible: true,
    });
    expect(await reauthorize(pool, "acct-1", OBJ)).toEqual({
      action: "evict",
      reason: "access_revoked",
    });
  });

  it("evicts an account whose row is gone", async () => {
    const pool = fakePool({ account: null, visible: true });
    expect(await reauthorize(pool, "acct-1", OBJ)).toEqual({
      action: "evict",
      reason: "access_revoked",
    });
  });

  it("evicts when the object is no longer visible, and says only that", async () => {
    // org→private, dropped from shared_with, trashed — the probe cannot tell
    // them apart and MUST NOT guess: the reason travels to the browser, and a
    // specific one would leak whether a private object still exists.
    const pool = fakePool({ account: member(), visible: false });
    expect(await reauthorize(pool, "acct-1", OBJ)).toEqual({
      action: "evict",
      reason: "visibility_changed",
    });
  });

  it("does not turn a database outage into a revocation", async () => {
    const accountDown = fakePool({ account: member(), visible: true, accountThrows: true });
    expect((await reauthorize(accountDown, "acct-1", OBJ)).action).toBe("unconfirmed");

    const joinDown = fakePool({ account: member(), visible: true, joinThrows: true });
    expect((await reauthorize(joinDown, "acct-1", OBJ)).action).toBe("unconfirmed");
  });

  it("treats a malformed object id as a denial, not an outage", async () => {
    const pool = fakePool({ account: member(), visible: true });
    expect(await reauthorize(pool, "acct-1", "not-a-uuid")).toEqual({
      action: "evict",
      reason: "visibility_changed",
    });
  });

  it("keeps a route (presence-only) room read-only without running the object probe", async () => {
    // A `route:<screen>` room has NO object to authorize against — its join gate
    // checks the account only. Running the object-visibility probe against a
    // non-uuid name reads as "denied" and would evict every presence connection
    // every ≤60s, tearing down the presence rail on every non-editor screen. A
    // route room carries no document, so it is ALWAYS "ro" — even for a
    // write-scoped member — so a client cannot push document content into it.
    // `visible: false` proves the probe is skipped: a doc room here would be
    // evicted.
    const pool = fakePool({ account: member(["read", "write"]), visible: false });
    expect(await reauthorize(pool, "acct-1", "route:deals")).toEqual({
      action: "keep",
      mode: "ro",
    });
  });

  it("still evicts a revoked account holding a route room (account check first)", async () => {
    // The route short-circuit is AFTER the account read: an offboarded person's
    // presence socket must still close, it just closes for access_revoked.
    const pool = fakePool({
      account: { scopes: ["read"], status: "revoked", role: "member" },
      visible: true,
    });
    expect(await reauthorize(pool, "acct-1", "route:deals")).toEqual({
      action: "evict",
      reason: "access_revoked",
    });
  });
});

/* --------------------------------------------------------------- the loop */

function conn(objectId: string, actorId: string, readOnly = false): LiveCollabConnection {
  const closed: { code: number; reason: string }[] = [];
  const ref = {};
  const c = {
    objectId,
    actorId,
    ref,
    readOnly,
    close(refusal: { code: number; reason: string }): void {
      closed.push(refusal);
    },
  };
  return Object.assign(c, { closed }) as LiveCollabConnection & {
    closed: { code: number; reason: string }[];
  };
}

function closesOf(c: LiveCollabConnection): { code: number; reason: string }[] {
  return (c as unknown as { closed: { code: number; reason: string }[] }).closed;
}

describe("createReauthLoop", () => {
  it("defaults to the stated ≤60s bound", () => {
    expect(REAUTH_INTERVAL_MS).toBe(60_000);
  });

  it("closes a connection whose account was revoked while it was open", async () => {
    const state: FakeState = { account: member(), visible: true };
    const c = conn(OBJ, "acct-1");
    const events: ReauthEvent[] = [];
    const loop = createReauthLoop({
      pool: fakePool(state),
      connections: () => [c],
      onEvent: (e) => events.push(e),
    });

    await loop.runOnce();
    expect(closesOf(c)).toEqual([]);

    state.account = { scopes: ["read", "write"], status: "revoked", role: "member" };
    await loop.runOnce();
    expect(closesOf(c)).toEqual([{ code: COLLAB_CLOSE.EVICTED, reason: "access_revoked" }]);
    // Write is taken away BEFORE the close — a queued message must not land on
    // the way out.
    expect(c.readOnly).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "evicted", reason: "access_revoked" });
  });

  it("downgrades a demoted member in place instead of closing them", async () => {
    const state: FakeState = { account: member(), visible: true };
    const c = conn(OBJ, "acct-1");
    const events: ReauthEvent[] = [];
    const loop = createReauthLoop({
      pool: fakePool(state),
      connections: () => [c],
      onEvent: (e) => events.push(e),
    });

    state.account = member(["read"]);
    await loop.runOnce();
    expect(c.readOnly).toBe(true);
    expect(closesOf(c)).toEqual([]);
    expect(events).toContainEqual({ kind: "downgraded", objectId: OBJ, actorId: "acct-1" });
  });

  it("never re-grants write to a connection that is already read-only", async () => {
    // A drain marks every connection read-only precisely so nothing new lands
    // mid-flush; a re-check that "helpfully" restored write would undo it.
    const c = conn(OBJ, "acct-1", true);
    const loop = createReauthLoop({
      pool: fakePool({ account: member(), visible: true }),
      connections: () => [c],
    });
    await loop.runOnce();
    expect(c.readOnly).toBe(true);
  });

  it("evicts when the object stops being visible", async () => {
    const state: FakeState = { account: member(), visible: true };
    const c = conn(OBJ, "acct-1");
    const loop = createReauthLoop({ pool: fakePool(state), connections: () => [c] });
    state.visible = false;
    await loop.runOnce();
    expect(closesOf(c)).toEqual([{ code: COLLAB_CLOSE.EVICTED, reason: "visibility_changed" }]);
  });

  it("takes write away on an unconfirmable pass but does not close, then closes after the grace", async () => {
    // A five-second connection storm must not empty every editor on the box —
    // but an unconfirmed principal must not be able to write for a single pass.
    const state: FakeState = { account: member(), visible: true, accountThrows: true };
    const c = conn(OBJ, "acct-1");
    let clock = 1_000;
    const loop = createReauthLoop({
      pool: fakePool(state),
      connections: () => [c],
      unconfirmedGraceMs: 300_000,
      now: () => clock,
    });

    await loop.runOnce();
    expect(c.readOnly).toBe(true);
    expect(closesOf(c)).toEqual([]);

    clock += 299_000;
    await loop.runOnce();
    expect(closesOf(c)).toEqual([]);

    clock += 2_000;
    await loop.runOnce();
    expect(closesOf(c)).toEqual([{ code: COLLAB_CLOSE.EVICTED, reason: "access_revoked" }]);
  });

  it("forgets the unconfirmed window once the database answers again", async () => {
    const state: FakeState = { account: member(), visible: true, accountThrows: true };
    const c = conn(OBJ, "acct-1");
    let clock = 0;
    const loop = createReauthLoop({
      pool: fakePool(state),
      connections: () => [c],
      unconfirmedGraceMs: 1_000,
      now: () => clock,
    });
    await loop.runOnce();
    state.accountThrows = false;
    clock += 10_000;
    await loop.runOnce();
    // The blip is over; a later blip starts its own window rather than
    // inheriting a stale one and closing immediately.
    state.accountThrows = true;
    await loop.runOnce();
    expect(closesOf(c)).toEqual([]);
  });

  it("re-checks every connection in every room, once per (actor, object) pair", async () => {
    const state: FakeState = { account: member(), visible: true };
    const pool = fakePool(state);
    const spy = vi.spyOn(pool, "query");
    // one person with the doc open in two tabs + a second person in the room
    const a1 = conn(OBJ, "acct-1");
    const a2 = conn(OBJ, "acct-1");
    const b1 = conn(OBJ, "acct-2");
    const loop = createReauthLoop({ pool, connections: () => [a1, a2, b1] });
    await loop.runOnce();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not stack passes when one overruns its interval", async () => {
    let resolveQuery: (() => void) | undefined;
    const pool = {
      query: () =>
        new Promise((resolve) => {
          resolveQuery = () => resolve({ rows: [member()] });
        }),
      connect: async () => ({ query: async () => ({ rowCount: 1, rows: [] }), release: () => {} }),
    } as unknown as Pool;
    let enumerated = 0;
    const loop = createReauthLoop({
      pool,
      connections: () => {
        enumerated += 1;
        return [conn(OBJ, "acct-1")];
      },
    });
    const first = loop.runOnce();
    await loop.runOnce(); // must be a no-op while the first is in flight
    expect(enumerated).toBe(1);
    resolveQuery?.();
    await first;
  });

  it("does nothing at all when there are no live connections", async () => {
    const pool = fakePool({ account: member(), visible: true });
    const spy = vi.spyOn(pool, "query");
    const loop = createReauthLoop({ pool, connections: () => [] });
    await loop.runOnce();
    expect(spy).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------- the inbound write gate */

/** lib0 varuint (values here are all < 128, i.e. one byte). */
function msg(documentName: string, ...rest: number[]): Uint8Array {
  const name = Buffer.from(documentName, "utf8");
  return new Uint8Array([name.length, ...name, ...rest]);
}

const SYNC = 0;
const AWARENESS = 1;
const QUERY_AWARENESS = 3;
const SYNC_REPLY = 4;

describe("inbound write gate", () => {
  it("classifies sync step-2 and sync-update as document mutations", () => {
    expect(isDocumentMutation(msg("doc", SYNC, 1))).toBe(true);
    expect(isDocumentMutation(msg("doc", SYNC, 2))).toBe(true);
    expect(isDocumentMutation(msg("doc", SYNC_REPLY, 2))).toBe(true);
  });

  it("does not classify awareness, queryAwareness or sync step-1 as mutations", () => {
    // A read-only participant still has a cursor. Booting a viewer for moving
    // it would be a bug wearing a security badge.
    expect(isDocumentMutation(msg("doc", AWARENESS))).toBe(false);
    expect(isDocumentMutation(msg("doc", QUERY_AWARENESS))).toBe(false);
    expect(isDocumentMutation(msg("doc", SYNC, 0))).toBe(false);
  });

  it("treats an undecodable message as a mutation", () => {
    // Refusing on "I do not understand this" is the only safe direction: the
    // alternative is deciding a message is harmless because we could not read it.
    expect(isDocumentMutation(new Uint8Array([]))).toBe(true);
    expect(isDocumentMutation(new Uint8Array([200]))).toBe(true); // truncated varuint
    expect(isDocumentMutation(new Uint8Array([9, 1, 2]))).toBe(true); // name longer than buffer
    expect(isDocumentMutation(msg("doc", SYNC))).toBe(true); // sync with no sub-type
  });

  it("lets a writable connection through, whatever it sends", () => {
    expect(inboundWriteRefusal({ readOnly: false, message: msg("doc", SYNC, 2) })).toBeNull();
  });

  it("refuses a document mutation from a read-only connection", () => {
    expect(inboundWriteRefusal({ readOnly: true, message: msg("doc", SYNC, 2) })).toEqual({
      code: COLLAB_CLOSE.ROOM_FORBIDDEN,
      reason: "read-only connection",
    });
  });

  it("lets a read-only connection keep sending awareness", () => {
    expect(inboundWriteRefusal({ readOnly: true, message: msg("doc", AWARENESS) })).toBeNull();
  });

  it("never closes a route room, even on a document mutation from a read-only connection", () => {
    // Route rooms are read-only AND document-less: hocuspocus silently drops
    // their sync updates, so closing would only kill presence (whose provider
    // syncs on connect). The gate exempts them; the drop does the work.
    expect(
      inboundWriteRefusal({
        readOnly: true,
        isRouteRoom: true,
        message: msg("route:deals", SYNC, 2),
      }),
    ).toBeNull();
    expect(
      inboundWriteRefusal({
        readOnly: true,
        isRouteRoom: true,
        message: msg("route:deals", SYNC, 2),
      }),
    ).toBeNull();
  });
});
