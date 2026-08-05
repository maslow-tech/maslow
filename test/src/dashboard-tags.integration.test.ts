import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Wave 3, task 12: the Access page + share sheet API.
 *
 *  - GET /tags: session-level (the share sheet needs group names for every
 *    member) — slugs, kinds, holders
 *  - POST /tags, /tags/:slug/grant, /tags/:slug/revoke: OWNER-only, thin
 *    wrappers over the SECURITY DEFINER governance fns (their only callers)
 *  - POST /objects/:id/share: member-level — a dashboard click IS the human
 *    approval; Writer.share enforces creator-only + containment, not the route
 *  - GET /objects/:id gains `audience` as resolved slug rows
 */
describe("dashboard tags + share API", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let ownerId: string;
  let ownerToken: string;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let botId: string;

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

  const call = (
    method: string,
    path: string,
    body: unknown,
    auth: { cookie: string; csrf: string },
  ): Promise<Response> =>
    req(path, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: "test-session-secret-tags", secureCookies: false },
    });
    const admin = new Admin(pool);
    const o = await admin.bootstrapOwner({ name: "olive", email: "owner@test.brain" });
    ownerId = o.id;
    ownerToken = o.token;
    const a = await admin.createUser(ownerId, {
      name: "alice",
      email: "alice@test.brain",
      permission: "member",
    });
    alice = { id: a.id, token: a.token };
    const b = await admin.createUser(ownerId, {
      name: "bob",
      email: "bob@test.brain",
      permission: "member",
    });
    bob = { id: b.id, token: b.token };
    // Was a service account (the 0057 grant fn used to refuse custom tags to
    // one). 0059 retired that class, so this is now an ordinary member — kept
    // because the grant/revoke assertions below still need a third holder.
    const svc = await admin.createUser(ownerId, {
      name: "Legacy Service",
      email: "svc@service.brain",
      permission: "member",
    });
    botId = svc.id;
  }, 120_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("owner creates a tag; every member can list it; holders update on grant/revoke", async () => {
    const ownerAuth = await login(ownerToken);
    expect((await call("POST", "/api/v1/tags", { slug: "c-suite" }, ownerAuth)).status).toBe(200);

    const grant = await call(
      "POST",
      "/api/v1/tags/c-suite/grant",
      { accountId: alice.id },
      ownerAuth,
    );
    expect(grant.status).toBe(200);

    // reads are session-level: a plain member sees the tag list
    const aliceAuth = await login(alice.token);
    const list = await req("/api/v1/tags", { headers: { cookie: aliceAuth.cookie } });
    expect(list.status).toBe(200);
    const tags = (
      (await list.json()) as { tags: Array<{ slug: string; kind: string; holders: string[] }> }
    ).tags;
    const cSuite = tags.find((t) => t.slug === "c-suite")!;
    expect(cSuite.kind).toBe("custom");
    expect(cSuite.holders).toContain(alice.id);
    // birthright tags are visible too
    expect(tags.some((t) => t.kind === "org")).toBe(true);
    expect(tags.filter((t) => t.kind === "personal").length).toBeGreaterThanOrEqual(4);

    const revoke = await call(
      "POST",
      "/api/v1/tags/c-suite/revoke",
      { accountId: alice.id },
      ownerAuth,
    );
    expect(revoke.status).toBe(200);
    const after = (
      (await (await req("/api/v1/tags", { headers: { cookie: aliceAuth.cookie } })).json()) as {
        tags: Array<{ slug: string; holders: string[] }>;
      }
    ).tags;
    expect(after.find((t) => t.slug === "c-suite")!.holders).not.toContain(alice.id);
  });

  it("members get 403 on every governance mutation", async () => {
    const aliceAuth = await login(alice.token);
    expect((await call("POST", "/api/v1/tags", { slug: "rogue" }, aliceAuth)).status).toBe(403);
    expect(
      (await call("POST", "/api/v1/tags/c-suite/grant", { accountId: alice.id }, aliceAuth)).status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/v1/tags/c-suite/revoke", { accountId: bob.id }, aliceAuth)).status,
    ).toBe(403);
  });

  it("a bad slug is a 400; a personal tag is never grantable", async () => {
    const ownerAuth = await login(ownerToken);
    expect((await call("POST", "/api/v1/tags", { slug: "Bad Slug!" }, ownerAuth)).status).toBe(400);
    // The grant fn's remaining refusal. It also refused SERVICE accounts until
    // 0059 retired that class; personal tags stay unassignable because a
    // personal tag IS the identity — granting one would hand someone else your
    // private audience.
    const personal = await ownerClient.query<{ slug: string }>(
      "SELECT slug FROM tags WHERE kind = 'personal' AND account_id = $1",
      [botId],
    );
    const res = await call(
      "POST",
      `/api/v1/tags/${personal.rows[0]!.slug}/grant`,
      { accountId: alice.id },
      ownerAuth,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not assignable/i);
  });

  it("share sheet flow: creator shares into a held group; containment refused; audience slugs on GET", async () => {
    const ownerAuth = await login(ownerToken);
    await call("POST", "/api/v1/tags", { slug: "pricing" }, ownerAuth);
    await call("POST", "/api/v1/tags/c-suite/grant", { accountId: alice.id }, ownerAuth);
    await call("POST", "/api/v1/tags/c-suite/grant", { accountId: bob.id }, ownerAuth);

    const aliceAuth = await login(alice.token);
    const made = await call("POST", "/api/v1/objects", { title: "board pack" }, aliceAuth);
    expect(made.status).toBe(200);
    const id = ((await made.json()) as { id: string }).id;

    // default private: bob's dashboard 404s it
    const bobAuth = await login(bob.token);
    expect(
      (await req(`/api/v1/objects/${id}`, { headers: { cookie: bobAuth.cookie } })).status,
    ).toBe(404);

    // containment: alice does not hold pricing
    const sealed = await call(
      "POST",
      `/api/v1/objects/${id}/share`,
      { who: ["pricing"] },
      aliceAuth,
    );
    expect(sealed.status).toBeGreaterThanOrEqual(400);

    // the held group works — bob (a holder) now sees it, with a LABELED
    // audience: custom tags keep their slug, and alice's personal row carries
    // her NAME (the chips must never read `person-xxxxxxxx`). `you` is
    // session-relative — bob is not alice, so her row has no you flag.
    const shared = await call(
      "POST",
      `/api/v1/objects/${id}/share`,
      { who: ["c-suite"], reason: "board pack for the leadership" },
      aliceAuth,
    );
    expect(shared.status).toBe(200);
    const seen = await req(`/api/v1/objects/${id}`, { headers: { cookie: bobAuth.cookie } });
    expect(seen.status).toBe(200);
    type AudTag = { slug: string; label: string; kind: string; you?: boolean };
    const obj = (await seen.json()) as { audience?: AudTag[][] };
    expect(obj.audience).toBeDefined();
    const flat = obj.audience!.flat();
    expect(
      flat.some((t) => t.kind === "custom" && t.slug === "c-suite" && t.label === "c-suite"),
    ).toBe(true);
    const alicePersonal = flat.find((t) => t.kind === "personal");
    expect(alicePersonal).toBeDefined();
    expect(alicePersonal!.label).toBe("alice");
    expect(alicePersonal!.you).toBeUndefined();

    // a non-creator cannot share someone else's (visible) object
    const stolen = await call("POST", `/api/v1/objects/${id}/share`, { who: ["c-suite"] }, bobAuth);
    expect(stolen.status).toBeGreaterThanOrEqual(400);
  });
});
