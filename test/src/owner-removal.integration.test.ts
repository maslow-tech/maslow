import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Wave 5, task 19: delayed owner removal — any owner may initiate demoting
 * another (or themselves); every owner may veto inside the 72h window; the
 * LAST active owner can never be removed (initiate AND execution both check);
 * the sweep executes due rows and demotion strips capability, never
 * visibility. Role is not tags.
 */
describe("delayed owner removal", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let su: Client;
  let app: Hono;
  let ownerA: { id: string; token: string };
  let ownerB: { id: string; token: string };
  let member: { id: string; token: string };

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(path, init));

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

  const login = async (token: string): Promise<{ cookie: string; csrf: string }> => {
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

  const post = (
    path: string,
    auth: { cookie: string; csrf: string },
    body?: unknown,
  ): Promise<Response> =>
    req(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const pendingFor = async (target: string): Promise<{ id: string; effective_at: string }[]> =>
    (
      await su.query<{ id: string; effective_at: string }>(
        `SELECT id, effective_at::text AS effective_at FROM owner_removals
          WHERE target_id = $1 AND cancelled_at IS NULL AND executed_at IS NULL`,
        [target],
      )
    ).rows;

  const roleOf = async (id: string): Promise<string> =>
    (await su.query<{ role: string }>("SELECT role FROM accounts WHERE id = $1", [id])).rows[0]!
      .role;

  const sweep = async (): Promise<number> =>
    Number(
      (await ownerClient.query<{ n: number }>("SELECT brain_owner_removal_sweep() AS n")).rows[0]!
        .n,
    );

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    su = await brain.connect("superuser");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: "test-session-secret-removal", secureCookies: false },
    });
    const admin = new Admin(pool);
    ownerA = await admin.bootstrapOwner({ name: "owner-a", email: "a-owner@test.brain" });
    ownerB = await admin.createUser(ownerA.id, {
      name: "owner-b",
      email: "b-owner@test.brain",
      permission: "owner",
    });
    member = await admin.createUser(ownerA.id, {
      name: "mel",
      email: "mel@test.brain",
      permission: "member",
    });
  }, 120_000);

  afterAll(async () => {
    await su?.end();
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("initiate → a pending row 72h out; duplicates refused; members 403; targets must be owners", async () => {
    const a = await login(ownerA.token);
    expect((await post(`/api/v1/owners/${ownerB.id}/removal`, a)).status).toBe(200);
    const rows = await pendingFor(ownerB.id);
    expect(rows).toHaveLength(1);
    const hoursOut = (new Date(rows[0]!.effective_at).getTime() - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(71);
    expect(hoursOut).toBeLessThan(73);
    // duplicate pending → 400 with the fn's message
    const dup = await post(`/api/v1/owners/${ownerB.id}/removal`, a);
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { error: string }).error).toMatch(/already pending/i);
    // a member can neither initiate nor cancel
    const m = await login(member.token);
    expect((await post(`/api/v1/owners/${ownerA.id}/removal`, m)).status).toBe(403);
    expect((await post(`/api/v1/owner-removals/${rows[0]!.id}/cancel`, m)).status).toBe(403);
    // a non-owner target is refused
    const notOwner = await post(`/api/v1/owners/${member.id}/removal`, a);
    expect(notOwner.status).toBe(400);
    expect(((await notOwner.json()) as { error: string }).error).toMatch(/not an active owner/i);
  });

  it("the TARGET may veto their own removal; everyone can read the ledger", async () => {
    const b = await login(ownerB.token);
    const rows = await pendingFor(ownerB.id);
    expect((await post(`/api/v1/owner-removals/${rows[0]!.id}/cancel`, b)).status).toBe(200);
    expect(await pendingFor(ownerB.id)).toHaveLength(0);
    const m = await login(member.token);
    const list = await req("/api/v1/owner-removals", { headers: { cookie: m.cookie } });
    expect(list.status).toBe(200);
    const parsed = (await list.json()) as { removals: Array<{ cancelled_at: string | null }> };
    expect(parsed.removals.length).toBeGreaterThan(0);
  });

  it("the sweep is a no-op before effective_at, demotes after — capability gone, visibility intact", async () => {
    const a = await login(ownerA.token);
    expect((await post(`/api/v1/owners/${ownerB.id}/removal`, a)).status).toBe(200);
    expect(await sweep()).toBe(0); // 72h have not passed
    // fast-forward: pull effective_at into the past (superuser test rig only)
    await su.query(
      `UPDATE owner_removals SET effective_at = now() - interval '1 minute'
        WHERE target_id = $1 AND cancelled_at IS NULL AND executed_at IS NULL`,
      [ownerB.id],
    );
    expect(await sweep()).toBe(1);
    expect(await roleOf(ownerB.id)).toBe("member");
    // demotion never touches visibility: b's account is still active
    const status = await su.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1", [
      ownerB.id,
    ]);
    expect(status.rows[0]!.status).toBe("active");
  });

  it("the LAST owner can never be removed — initiate refuses, and execution re-checks", async () => {
    // ownerA is now the last active owner
    const a = await login(ownerA.token);
    const res = await post(`/api/v1/owners/${ownerA.id}/removal`, a);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/last owner/i);
    // execution-time guard: forge a pending row via superuser, then sweep — it
    // must cancel itself rather than demote the last owner
    await su.query(
      `INSERT INTO owner_removals (target_id, initiated_by, effective_at)
       VALUES ($1, $1, now() - interval '1 minute')`,
      [ownerA.id],
    );
    expect(await sweep()).toBe(0);
    expect(await roleOf(ownerA.id)).toBe("owner");
    const ghost = await su.query(
      `SELECT cancelled_at FROM owner_removals
        WHERE target_id = $1 AND executed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [ownerA.id],
    );
    expect(ghost.rows[0]!.cancelled_at).not.toBeNull();
  });
});
