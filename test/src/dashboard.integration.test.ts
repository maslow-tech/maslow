import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, Writer, type WriteContext } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The browser-facing API. The end-user UI was removed
 * so a fresh design can be built against this API; the security properties ARE
 * the deliverable, so this suite proves them against the real box Hono app
 * driven through `app.request` (no socket): cookie login that never leaks the
 * bearer, read-only /api gated on the session, owner-only CSRF-protected
 * member-admin, and that /mcp still ignores cookies.
 */

const SECRET = "test-session-secret-please-change";
const APP_VERSION = "5.2.0-test";

/** Pull a Set-Cookie name=value pair out of a Response (undici getSetCookie). */
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

describe("read-only dashboard", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let ownerToken: string;
  let ownerId: string;
  let memberToken: string;

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

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false, appVersion: APP_VERSION },
    });

    const boot = await new Admin(pool).bootstrapOwner({
      name: "Owner",
      email: "owner@example.com",
    });
    ownerToken = boot.token;
    ownerId = boot.id;
    // An owner mints a read-only member (a valid, lower-privilege login).
    const member = await new Admin(pool).createUser(ownerId, {
      name: "Reader",
      email: "user@example.com",
      permission: "viewer",
    });
    memberToken = member.token;
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("login sets an HttpOnly SameSite=Strict cookie and never leaks the bearer", async () => {
    const res = await req("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ownerToken }),
    });
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();
    const sessionLine = setCookies.find((l) => l.startsWith("brain_session="));
    expect(sessionLine).toBeTruthy();
    expect(sessionLine).toMatch(/HttpOnly/i);
    expect(sessionLine).toMatch(/SameSite=Strict/i);

    const bodyText = await res.text();
    const parsed = JSON.parse(bodyText) as { role: string; csrfToken: string };
    expect(parsed.role).toBe("owner");
    expect(parsed.csrfToken).toBeTruthy();

    // The raw bearer must appear NOWHERE: not in the body, not in any cookie.
    expect(bodyText).not.toContain(ownerToken);
    for (const line of setCookies) expect(line).not.toContain(ownerToken);
    // The session cookie is a signed {sub,role,scope,exp} envelope, not the token.
    const session = cookieValue(res, "brain_session");
    expect(session).toBeTruthy();
    expect(session).not.toContain(ownerToken);
  });

  it("gates read /api on the session cookie (200 with, 401 without)", async () => {
    const { cookie } = await login(ownerToken);
    const ok = await req("/api/v1/whoami", { headers: { cookie } });
    expect(ok.status).toBe(200);
    const me = (await ok.json()) as { id: string; role: string };
    expect(me.id).toBe(ownerId);
    expect(me.role).toBe("owner");
    // stamped with the app build for the SPA fail-safe reload
    expect(ok.headers.get("x-brain-app-version")).toBe(APP_VERSION);

    const anon = await req("/api/v1/whoami");
    expect(anon.status).toBe(401);

    const badCookie = await req("/api/v1/whoami", {
      headers: { cookie: "brain_session=tampered.signature" },
    });
    expect(badCookie.status).toBe(401);
  });

  it("search is lexical-only by default and runs the full stack with deep=1", async () => {
    const writer = new Writer(pool);
    const wctx: WriteContext = { actorId: ownerId, scopes: ["write"] };
    await writer.write(wctx, { title: "Flimflam alpha", body: "flimflam one" });
    await writer.write(wctx, { title: "Flimflam beta", body: "flimflam two" });

    let embeds = 0;
    let reranks = 0;
    // Same pool + session secret as `app`, so the login cookie carries over —
    // only the retrieval hooks differ (spies standing in for the models).
    const deepApp = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false, appVersion: APP_VERSION },
      embedQuery: () => {
        embeds += 1;
        return Promise.resolve(null);
      },
      rerank: (_q, cands) => {
        reranks += 1;
        return Promise.resolve(cands.map((c) => ({ id: c.id, score: 1 })));
      },
    });
    const { cookie } = await login(ownerToken);
    const dreq = (path: string): Promise<Response> =>
      Promise.resolve(deepApp.request(path, { headers: { cookie } }));

    const quick = await dreq("/api/v1/search?q=flimflam");
    expect(quick.status).toBe(200);
    expect(((await quick.json()) as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(embeds).toBe(0);
    expect(reranks).toBe(0);

    const deep = await dreq("/api/v1/search?q=flimflam&deep=1");
    expect(deep.status).toBe(200);
    const hits = (await deep.json()) as Array<{ match: string }>;
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.match).toBeTruthy();
    expect(embeds).toBe(1);
    expect(reranks).toBe(1);
  });

  it("locks down the JSON surface with a strict CSP (no HTML, no unsafe-inline)", async () => {
    const { cookie } = await login(ownerToken);
    const res = await req("/api/v1/whoami", { headers: { cookie } });
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("keeps owner member-admin owner-only (member → 403, owner → 200)", async () => {
    const member = await login(memberToken);
    // Member sends a VALID csrf pair, so only the scope re-auth can block it.
    const denied = await req("/api/v1/admin/members", {
      method: "POST",
      headers: {
        cookie: member.cookie,
        "content-type": "application/json",
        "x-csrf-token": member.csrf,
      },
      body: JSON.stringify({ name: "Nope", email: "u@example.com", permission: "viewer" }),
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/owner/i);

    const owner = await login(ownerToken);
    const created = await req("/api/v1/admin/members", {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-csrf-token": owner.csrf,
      },
      body: JSON.stringify({ name: "New Member", email: "u@example.com", permission: "viewer" }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { id: string; token: string };
    expect(body.id).toBeTruthy();
    expect(body.token).toBeTruthy();
  });

  it("rejects an admin POST that is missing the CSRF header (double-submit)", async () => {
    const owner = await login(ownerToken);
    const res = await req("/api/v1/admin/members", {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "No CSRF", email: "u@example.com", permission: "viewer" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/csrf/i);

    // A mismatched header is likewise rejected.
    const mismatch = await req("/api/v1/admin/members", {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-csrf-token": "not-the-cookie-value",
      },
      body: JSON.stringify({ name: "Bad CSRF", email: "u@example.com", permission: "viewer" }),
    });
    expect(mismatch.status).toBe(403);
  });

  it("keeps /mcp ignoring cookies (a cookie-only request is unauthorized)", async () => {
    const { cookie } = await login(ownerToken);
    const res = await req("/mcp", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeTruthy();
  });
});
