import type { Hono } from "hono";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Branding (box_kv) writes must run on a SEPARATE
 * brain_owner handle from the schema executor's dedicated client. If they share
 * the connection, node-pg FIFO-serializes a branding INSERT into an open
 * executor BEGIN…ROLLBACK, so a write that already returned HTTP 200 is silently
 * lost on the rollback. These two cases prove the fix (dedicated ownerKv pool)
 * and document the exact bug (shared-client fallback).
 */

const SECRET = "test-session-secret-please-change";

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

describe("owner box_kv write isolation from the executor txn", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client; // the "executor" client
  let ownerToken: string;

  const login = async (app: Hono): Promise<{ cookie: string; csrf: string }> => {
    const res = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ownerToken }),
    });
    const session = cookieValue(res, "brain_session");
    const csrf = cookieValue(res, "brain_csrf");
    if (!session || !csrf) throw new Error("login did not set both cookies");
    return { cookie: `brain_session=${session}; brain_csrf=${csrf}`, csrf };
  };

  const postBranding = (app: Hono, name: string, auth: { cookie: string; csrf: string }) =>
    app.request("/api/v1/branding", {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        "content-type": "application/json",
        "x-csrf-token": auth.csrf,
      },
      body: JSON.stringify({ name }),
    });

  const getName = async (app: Hono): Promise<string | null> => {
    const res = await app.request("/api/v1/branding");
    return ((await res.json()) as { name: string | null }).name;
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    ownerToken = (await new Admin(pool).bootstrapOwner({ name: "alice", email: "a@example.com" }))
      .token;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await ownerClient?.end();
    await brain?.drop();
  });

  it("FIXED: a branding write on the dedicated ownerKv pool survives an executor ROLLBACK", async () => {
    const ownerKv = new Pool(brain.ownerConfig);
    ownerKv.on("error", () => {});
    try {
      const app = createBox({ pool, ownerClient, ownerKv, dashboard: { sessionSecret: SECRET } });
      const auth = await login(app);

      // simulate an in-flight executor transaction on the dedicated client
      await ownerClient.query("BEGIN");
      const res = await postBranding(app, "Persisted", auth); // runs on ownerKv, autocommit
      expect(res.status).toBe(200);
      await ownerClient.query("ROLLBACK"); // the executor txn rolls back

      expect(await getName(app), "the branding write is NOT enclosed by the executor txn").toBe(
        "Persisted",
      );
    } finally {
      await ownerKv.end();
    }
  });

  it("BUG (documented): the shared-client fallback loses the write on ROLLBACK", async () => {
    // No ownerKv → falls back to the executor ownerClient (shared connection).
    const app = createBox({ pool, ownerClient, dashboard: { sessionSecret: SECRET } });
    const auth = await login(app);

    const before = await getName(app); // whatever a prior test committed
    await ownerClient.query("BEGIN");
    const res = await postBranding(app, "Ghost", auth); // INSERT queued INSIDE the open txn
    expect(res.status).toBe(200);
    await ownerClient.query("ROLLBACK"); // ...and lost here

    const after = await getName(app);
    expect(after, "the shared-client 'Ghost' write vanished on rollback").not.toBe("Ghost");
    expect(after, "state is exactly what it was before the lost write").toBe(before);
  });
});
