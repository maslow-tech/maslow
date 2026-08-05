import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  SpentTicketStore,
  canJoin,
  connectionMode,
  isActive,
  readScopes,
  verifyTicket,
} from "./auth.js";
import { mintCollabTicket } from "./types.js";

/**
 * The DB-bound half of the collab gate. `canJoin` is asserted against a FAKE
 * pool that records the SQL it was handed: the point of this file is that the
 * join check really is an RLS-bound read as the joiner (a read-only txn, the
 * actor GUC, then a plain SELECT on `objects`) and NOT a reimplementation of
 * the 0012 visibility predicate — a divergence no test of the SQL policy could
 * catch. Whether that SELECT returns a row for a shared private object is
 * Postgres's job, and is covered by the collab integration tests.
 */

const SECRET = "collab-auth-test-secret";

interface FakeQuery {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

function fakePool(opts: {
  readonly rowCount?: number;
  readonly rows?: Record<string, unknown>[];
  readonly failOn?: RegExp;
  readonly connectFails?: boolean;
}): { pool: Pool; queries: FakeQuery[]; released: () => number } {
  const queries: FakeQuery[] = [];
  let releases = 0;
  const client = {
    query: async (sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      if (opts.failOn?.test(sql)) throw new Error("boom");
      return { rowCount: opts.rowCount ?? 0, rows: opts.rows ?? [] };
    },
    release: () => {
      releases += 1;
    },
  };
  const pool = {
    connect: async () => {
      if (opts.connectFails) throw new Error("no connections");
      return client;
    },
    query: async (sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      return { rowCount: opts.rows?.length ?? 0, rows: opts.rows ?? [] };
    },
  };
  return { pool: pool as unknown as Pool, queries, released: () => releases };
}

const OBJECT_ID = "11111111-2222-3333-4444-555555555555";
const ACTOR = "acct-42";

describe("connectionMode", () => {
  it("is rw only with the write scope", () => {
    expect(connectionMode(["read", "write"])).toBe("rw");
    expect(connectionMode(["write"])).toBe("rw");
  });

  it("is ro for a viewer, and for an account with no scopes at all", () => {
    // A viewer joins rooms READ-ONLY — being allowed in is not permission to
    // write, and hocuspocus accepts updates from any connection not marked so.
    expect(connectionMode(["read"])).toBe("ro");
    expect(connectionMode([])).toBe("ro");
    expect(connectionMode(["schema-admin"])).toBe("ro");
  });
});

describe("verifyTicket", () => {
  it("accepts a freshly minted ticket exactly once", () => {
    const store = new SpentTicketStore();
    const { ticket } = mintCollabTicket(SECRET, {
      actorId: ACTOR,
      role: "member",
      scopes: ["read"],
    });

    const first = verifyTicket(SECRET, ticket, { store });
    expect(first?.actorId).toBe(ACTOR);
    // Replay: a ticket recovered from a proxy access log is already spent.
    expect(verifyTicket(SECRET, ticket, { store })).toBeNull();
  });

  it("refuses a tampered, absent or expired ticket with the same null answer", () => {
    const store = new SpentTicketStore();
    const { ticket } = mintCollabTicket(
      SECRET,
      { actorId: ACTOR, role: "member", scopes: ["read", "write"] },
      { ttlSeconds: 30, now: 1_000_000 },
    );
    expect(verifyTicket(SECRET, `${ticket}x`, { store, now: 1_000_000 })).toBeNull();
    expect(verifyTicket(SECRET, undefined, { store, now: 1_000_000 })).toBeNull();
    expect(verifyTicket("another-secret", ticket, { store, now: 1_000_000 })).toBeNull();
    // 31s later the TTL is gone.
    expect(verifyTicket(SECRET, ticket, { store, now: 1_031_000 })).toBeNull();
  });

  it("carries the mint-time scopes as a hint, which authorize nothing on their own", () => {
    const store = new SpentTicketStore();
    const { ticket } = mintCollabTicket(SECRET, {
      actorId: ACTOR,
      role: "viewer",
      scopes: ["read"],
    });
    const principal = verifyTicket(SECRET, ticket, { store });
    expect(principal?.scopes).toEqual(["read"]);
    expect(principal?.role).toBe("viewer");
  });
});

describe("SpentTicketStore", () => {
  it("refuses a second spend and drops entries once they expire", () => {
    const store = new SpentTicketStore();
    expect(store.spend("jti-1", 10_000, 1_000)).toBe(true);
    expect(store.spend("jti-1", 10_000, 1_000)).toBe(false);
    expect(store.size).toBe(1);
    // Past the expiry the sweep reclaims it — the map is bounded by one TTL
    // window, never by uptime.
    expect(store.spend("jti-2", 30_000, 20_000)).toBe(true);
    expect(store.size).toBe(1);
  });

  it("refuses an already-expired id outright", () => {
    const store = new SpentTicketStore();
    expect(store.spend("jti-old", 5_000, 6_000)).toBe(false);
  });
});

describe("canJoin", () => {
  it("runs a read-only txn as the joining actor and asks objects directly", async () => {
    const { pool, queries, released } = fakePool({ rowCount: 1 });
    await expect(canJoin(pool, ACTOR, OBJECT_ID)).resolves.toBe(true);

    expect(queries[0]?.sql).toBe("BEGIN READ ONLY");
    expect(queries[1]?.sql).toContain("set_config('app.actor_id', $1, true)");
    expect(queries[1]?.params?.[0]).toBe(ACTOR);
    // The visibility rule is Postgres's, not ours: a bare SELECT under RLS.
    expect(queries[2]?.sql).toBe("SELECT 1 FROM objects WHERE id = $1 AND deleted_at IS NULL");
    expect(queries[2]?.params?.[0]).toBe(OBJECT_ID);
    expect(queries[3]?.sql).toBe("COMMIT");
    expect(released()).toBe(1);
  });

  it("refuses when RLS returns no row — the same answer as a missing object", async () => {
    const { pool } = fakePool({ rowCount: 0 });
    await expect(canJoin(pool, ACTOR, OBJECT_ID)).resolves.toBe(false);
  });

  it("fails closed on a malformed id without touching the pool", async () => {
    const { pool, queries } = fakePool({ rowCount: 1 });
    await expect(canJoin(pool, ACTOR, "not-a-uuid")).resolves.toBe(false);
    await expect(canJoin(pool, "", OBJECT_ID)).resolves.toBe(false);
    expect(queries).toHaveLength(0);
  });

  it("fails closed (and rolls back, and releases) when the read errors", async () => {
    const { pool, queries, released } = fakePool({ rowCount: 1, failOn: /FROM objects/ });
    await expect(canJoin(pool, ACTOR, OBJECT_ID)).resolves.toBe(false);
    expect(queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(released()).toBe(1);
  });

  it("fails closed when no connection can be had", async () => {
    const { pool } = fakePool({ connectFails: true });
    await expect(canJoin(pool, ACTOR, OBJECT_ID)).resolves.toBe(false);
  });
});

describe("readScopes", () => {
  it("returns the CURRENT row and drops scopes the box does not define", async () => {
    const { pool, queries } = fakePool({
      rows: [{ scopes: ["read", "write", "sudo"], status: "active", role: "member" }],
    });
    const access = await readScopes(pool, ACTOR);
    expect(access).toEqual({ scopes: ["read", "write"], status: "active", role: "member" });
    expect(queries[0]?.sql).toContain("FROM accounts WHERE id = $1");
    expect(isActive(access)).toBe(true);
  });

  it("treats a missing or suspended account as not active", async () => {
    const gone = fakePool({ rows: [] });
    expect(await readScopes(gone.pool, ACTOR)).toBeNull();
    expect(isActive(null)).toBe(false);

    const suspended = fakePool({ rows: [{ scopes: ["read"], status: "revoked", role: "member" }] });
    expect(isActive(await readScopes(suspended.pool, ACTOR))).toBe(false);
  });
});
