import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, parseOrigin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Dashboard write endpoints (POST/PATCH/DELETE /api/v1/objects). Humans mutate
 * brain content through the SAME Writer the MCP tools use. This proves:
 *  - a write-scoped member can create → edit → soft-delete, with history
 *    attributing the change to the member and reason "dashboard";
 *  - the optimistic-concurrency guard: a stale version → 409 + current version;
 *  - a version-less PATCH is a 400 (guard can't silently no-op);
 *  - CSRF is required;
 *  - a VIEWER (read-only) is refused (403) — no privilege escalation (red-team C1);
 *  - editing an object the member can't see is a 404 (RLS).
 *
 * The workspace-UI write path (p1-t3) EXTENDS these same routes and adds link
 * edits; those cases live in dashboard-write-path.integration.test.ts.
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

describe("dashboard object write endpoints", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let ownerToken: string;
  let memberToken: string;
  let viewerToken: string;

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(path, init));

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

  const call = (
    method: string,
    path: string,
    body: unknown,
    auth: { cookie: string; csrf: string },
  ): Promise<Response> =>
    req(path, {
      method,
      headers: {
        cookie: auth.cookie,
        "content-type": "application/json",
        "x-csrf-token": auth.csrf,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false },
    });
    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    ownerToken = boot.token;
    const member = await admin.createUser(boot.id, {
      name: "Member",
      email: "member@example.com",
      permission: "member",
    });
    memberToken = member.token;
    const viewer = await admin.createUser(boot.id, {
      name: "Viewer",
      email: "viewer@example.com",
      permission: "viewer",
    });
    viewerToken = viewer.token;
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("a member creates, edits, and soft-deletes an object", async () => {
    const auth = await login(memberToken);
    const created = await call(
      "POST",
      "/api/v1/objects",
      { title: "ripped row", body: "hello" },
      auth,
    );
    expect(created.status).toBe(200);
    const { id, version } = (await created.json()) as { id: string; version: number };
    expect(id).toBeTruthy();

    const edited = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { version, title: "ripped row 2" },
      auth,
    );
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { version: number }).version).toBe(version + 1);

    const del = await call("DELETE", `/api/v1/objects/${id}`, undefined, auth);
    expect(del.status).toBe(200);
  });

  it("clearing a title (title: null) succeeds — no 500 from Buffer.byteLength(null)", async () => {
    const auth = await login(memberToken);
    const { id, version } = (await (
      await call("POST", "/api/v1/objects", { title: "clear me" }, auth)
    ).json()) as { id: string; version: number };
    const cleared = await call("PATCH", `/api/v1/objects/${id}`, { version, title: null }, auth);
    expect(cleared.status).toBe(200);
    const obj = (await (await call("GET", `/api/v1/objects/${id}`, undefined, auth)).json()) as {
      title: string | null;
    };
    expect(obj.title).toBeNull();
  });

  it("rejects a non-string, non-null title with a 400", async () => {
    const auth = await login(memberToken);
    const { id, version } = (await (
      await call("POST", "/api/v1/objects", { title: "typed" }, auth)
    ).json()) as { id: string; version: number };
    const res = await call("PATCH", `/api/v1/objects/${id}`, { version, title: 42 }, auth);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid visibility instead of fail-open coercing to org", async () => {
    const auth = await login(memberToken);
    const res = await call("POST", "/api/v1/objects", { title: "x", visibility: "public" }, auth);
    expect(res.status).toBe(400);
  });

  it("a stale version returns 409 with the current version", async () => {
    const auth = await login(memberToken);
    const { id, version } = (await (
      await call("POST", "/api/v1/objects", { title: "conflict me" }, auth)
    ).json()) as { id: string; version: number };
    const first = await call("PATCH", `/api/v1/objects/${id}`, { version, title: "first" }, auth);
    expect(first.status).toBe(200);
    const stale = await call("PATCH", `/api/v1/objects/${id}`, { version, title: "second" }, auth);
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { details?: { current_version?: number } };
    expect(body.details?.current_version).toBe(version + 1);
  });

  it("a PATCH without a version is a 400 (guard cannot silently no-op)", async () => {
    const auth = await login(memberToken);
    const { id } = (await (
      await call("POST", "/api/v1/objects", { title: "needs version" }, auth)
    ).json()) as { id: string };
    const res = await call("PATCH", `/api/v1/objects/${id}`, { title: "no version" }, auth);
    expect(res.status).toBe(400);
  });

  it("history attributes the edit to the member with reason dashboard", async () => {
    const auth = await login(memberToken);
    const { id, version } = (await (
      await call("POST", "/api/v1/objects", { title: "audited" }, auth)
    ).json()) as { id: string; version: number };
    await call("PATCH", `/api/v1/objects/${id}`, { version, title: "audited 2" }, auth);
    const hist = (await (
      await call("GET", `/api/v1/objects/${id}/history`, undefined, auth)
    ).json()) as {
      events: Array<{ actor: string | null; payload: Record<string, unknown> | null }>;
    };
    // The reason lands in the update event payload (0026); the member is the
    // actor. Since p1-t3 every dashboard write also carries a per-request
    // origin token, which rides the SAME reason string as a `dashboard#<token>`
    // suffix (events has no origin column, and 0026's triggers are shipped).
    // parseOrigin is the only supported way to read it back — a bare
    // `reason === "dashboard"` comparison is what this assertion used to do and
    // is exactly what the suffix breaks.
    const dashboardEvent = hist.events.find(
      (e) =>
        typeof e.payload?.reason === "string" &&
        parseOrigin(e.payload.reason as string).reason === "dashboard",
    );
    expect(dashboardEvent).toBeTruthy();
    const { origin } = parseOrigin((dashboardEvent!.payload as { reason: string }).reason);
    expect(origin).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a write without a csrf header is rejected (403)", async () => {
    const auth = await login(memberToken);
    const res = await req("/api/v1/objects", {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "no csrf" }),
    });
    expect(res.status).toBe(403);
  });

  it("a viewer (read-only) cannot create, edit, or delete — no privilege escalation", async () => {
    const owner = await login(ownerToken);
    const { id, version } = (await (
      await call("POST", "/api/v1/objects", { title: "owner made this" }, owner)
    ).json()) as { id: string; version: number };

    const viewer = await login(viewerToken);
    const create = await call("POST", "/api/v1/objects", { title: "viewer create" }, viewer);
    expect(create.status).toBe(403);
    const edit = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { version, title: "viewer edit" },
      viewer,
    );
    expect(edit.status).toBe(403);
    const del = await call("DELETE", `/api/v1/objects/${id}`, undefined, viewer);
    expect(del.status).toBe(403);
  });

  it("editing an object the member cannot see is a 404 (RLS)", async () => {
    const owner = await login(ownerToken);
    const { id, version } = (await (
      await call(
        "POST",
        "/api/v1/objects",
        { title: "owner private", visibility: "private" },
        owner,
      )
    ).json()) as { id: string; version: number };

    const auth = await login(memberToken);
    const res = await call("PATCH", `/api/v1/objects/${id}`, { version, title: "peek" }, auth);
    expect(res.status).toBe(404);
  });
});
