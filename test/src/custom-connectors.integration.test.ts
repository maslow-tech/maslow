import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Custom connectors (0033): an OWNER defines an external HTTP API on the
 * dashboard (base URL, auth shape, instructions); every member's agent then
 * gets a `<slug>_fetch` MCP tool. Covers the definition CRUD gates, the
 * seeded samgov definition, tools/list visibility, the teaching surface
 * (empty call → instructions), and the executor rails (auth attach, host
 * pinning, secret scrub).
 */

const SECRET = "test-session-secret-custom";
const CONNECTOR_ENV = {
  BRAIN_CONNECTOR_TOKEN_KEY: randomBytes(32).toString("base64"),
};
const API_SECRET = "shh-custom-connector-secret";

// custom.ts now routes every request through the injected SSRF egress guard, so
// we intercept at THAT seam (createBox `net.guardedFetch`) instead of stubbing
// the global fetch. Each test sets `guardImpl` to record the request + return a
// canned response; the guard's return shape is { status, headers, text }.
type GuardResp = { status: number; headers: Headers; text: string };
let guardImpl:
  | ((
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => Promise<GuardResp>)
  | null = null;

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

describe("custom connectors (owner-defined HTTP connectors)", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let owner: { cookie: string; csrf: string };
  let member: { cookie: string; csrf: string };
  let memberBearer: string;

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

  const json = (
    who: { cookie: string; csrf: string },
    method: string,
    body?: unknown,
  ): RequestInit => ({
    method,
    headers: {
      cookie: who.cookie,
      "x-csrf-token": who.csrf,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const mcpCall = async (name: string, args: unknown): Promise<string> => {
    const res = await req("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${memberBearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    return body.result.content[0]!.text;
  };

  const mcpTools = async (): Promise<Array<{ name: string; description: string }>> => {
    const res = await req("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${memberBearer}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    return body.result.tools;
  };

  const DEF = {
    slug: "weatherapi",
    name: "Weather API",
    baseUrl: "https://api.weather.example",
    authKind: "header",
    authName: "X-Api-Key",
    allowedPrefixes: ["/v1/"],
    description: "Query the org's weather data service.",
    instructions: "GET /v1/forecast?city=… returns a 7-day forecast. One call per city.",
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: {
        sessionSecret: SECRET,
        secureCookies: false,
        connectors: { env: CONNECTOR_ENV },
      },
      net: {
        guardedFetch: (u, i) =>
          guardImpl ? guardImpl(u, i) : Promise.reject(new Error("no guardImpl set for this test")),
      },
    });

    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    const m = await admin.createUser(boot.id, {
      name: "Member",
      email: "member@example.com",
      permission: "member",
    });
    memberBearer = m.token;
    owner = await login(boot.token);
    member = await login(m.token);
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    guardImpl = null;
  });

  it("migration 0033 seeds the samgov definition (data, not code)", async () => {
    const r = await pool.query<{ base_url: string; auth_kind: string; auth_name: string }>(
      "SELECT base_url, auth_kind, auth_name FROM custom_connectors WHERE slug = 'samgov'",
    );
    expect(r.rows[0]).toEqual({
      base_url: "https://api.sam.gov",
      auth_kind: "query",
      auth_name: "api_key",
    });
  });

  it("creating a definition is OWNER ONLY and validates slug/URL/reserved names", async () => {
    expect((await req("/api/v1/connectors/custom", json(member, "POST", DEF))).status).toBe(403);

    const badUrl = await req(
      "/api/v1/connectors/custom",
      json(owner, "POST", { ...DEF, baseUrl: "http://api.weather.example" }),
    );
    expect(badUrl.status).toBe(400);
    expect(((await badUrl.json()) as { error: string }).error).toMatch(/https/);

    for (const host of ["https://169.254.169.254", "https://localhost", "https://db.internal"]) {
      const res = await req(
        "/api/v1/connectors/custom",
        json(owner, "POST", { ...DEF, baseUrl: host }),
      );
      expect(res.status).toBe(400);
    }

    for (const slug of ["google", "search", "Bad-Slug"]) {
      const res = await req("/api/v1/connectors/custom", json(owner, "POST", { ...DEF, slug }));
      expect(res.status).toBe(400);
    }

    expect((await req("/api/v1/connectors/custom", json(owner, "POST", DEF))).status).toBe(200);
  });

  it("definition without a credential: owner AND member see it (self-adopt), tool still hidden", async () => {
    const ownerList = (await (
      await req("/api/v1/connectors", { headers: { cookie: owner.cookie } })
    ).json()) as Array<Record<string, unknown>>;
    expect(ownerList.find((e) => e["provider"] === "weatherapi")).toMatchObject({
      custom: true,
      orgEnabled: false,
      myPersonalEnabled: false,
      selfAdoptable: true,
    });

    // A member now SEES a self-adoptable connector so they can bring their own
    // key (approved doctrine reversal) — but the TOOL stays hidden until a
    // credential exists, and a direct call still teaches.
    const memberList = (await (
      await req("/api/v1/connectors", { headers: { cookie: member.cookie } })
    ).json()) as Array<Record<string, unknown>>;
    expect(memberList.find((e) => e["provider"] === "weatherapi")).toMatchObject({
      orgEnabled: false,
      myPersonalEnabled: false,
    });

    expect((await mcpTools()).map((t) => t.name)).not.toContain("weatherapi_fetch");
    const text = await mcpCall("weatherapi_fetch", { path: "/v1/forecast" });
    expect(text).toContain("not enabled");
  });

  it("enable (secret stored) → the tool appears for every member, description from the definition", async () => {
    const ok = await req(
      "/api/v1/connectors/weatherapi/config",
      json(owner, "PUT", { value: API_SECRET }),
    );
    expect(ok.status).toBe(200);

    const tools = await mcpTools();
    const tool = tools.find((t) => t.name === "weatherapi_fetch");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe(DEF.description);
  });

  it("empty call returns the owner's instructions (the teaching surface)", async () => {
    const text = await mcpCall("weatherapi_fetch", {});
    expect(text).toContain("7-day forecast");
  });

  it("executor rails: header auth attached, host pinned, prefixes enforced, secret scrubbed", async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
    guardImpl = (url, init) => {
      seen.push({ url, headers: init?.headers ?? {}, method: init?.method ?? "GET" });
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        text: '{"forecast":"sunny"}',
      });
    };

    // plain GET: auth header attached server-side, never in the result
    const okText = await mcpCall("weatherapi_fetch", {
      path: "/v1/forecast",
      params: { city: "richmond" },
    });
    expect(okText).toContain("sunny");
    expect(okText).not.toContain(API_SECRET);
    expect(seen[0]!.headers["X-Api-Key"]).toBe(API_SECRET);
    expect(new URL(seen[0]!.url).searchParams.get("city")).toBe("richmond");

    // POST passes through (all-methods decision) with a JSON body
    await mcpCall("weatherapi_fetch", {
      path: "/v1/forecast",
      method: "POST",
      body: '{"city":"richmond"}',
    });
    expect(seen[1]!.method).toBe("POST");

    // path traversal cannot escape the pinned host or the allowlist — these are
    // rejected in customFetch BEFORE the guard is ever called (no outbound req).
    const escape = await mcpCall("weatherapi_fetch", { path: "//evil.example/steal" });
    expect(escape).toMatch(/pinned|allowed/);
    const outside = await mcpCall("weatherapi_fetch", { path: "/v2/other" });
    expect(outside).toContain("allowed paths");
    expect(seen).toHaveLength(2);

    // upstream error bodies echo scrubbed — never the secret
    guardImpl = () =>
      Promise.resolve({ status: 500, headers: new Headers(), text: `boom ${API_SECRET} boom` });
    const errText = await mcpCall("weatherapi_fetch", { path: "/v1/forecast" });
    expect(errText).not.toContain(API_SECRET);
    expect(errText).toContain("[redacted]");
  });

  it("query-param auth and no-auth connectors work; no-auth enables with an empty blob", async () => {
    expect(
      (
        await req(
          "/api/v1/connectors/custom",
          json(owner, "POST", {
            slug: "qparam",
            name: "Q",
            baseUrl: "https://q.example",
            authKind: "query",
            authName: "token",
            secret: API_SECRET,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await req(
          "/api/v1/connectors/custom",
          json(owner, "POST", {
            slug: "publicapi",
            name: "Public",
            baseUrl: "https://open.example",
            authKind: "none",
          }),
        )
      ).status,
    ).toBe(200);

    const names = (await mcpTools()).map((t) => t.name);
    expect(names).toContain("qparam_fetch"); // secret in the create call enabled it
    expect(names).toContain("publicapi_fetch"); // auth none enables immediately

    const seen: string[] = [];
    guardImpl = (url) => {
      seen.push(url);
      return Promise.resolve({ status: 200, headers: new Headers(), text: "{}" });
    };
    await mcpCall("qparam_fetch", { path: "/x" });
    expect(new URL(seen[0]!).searchParams.get("token")).toBe(API_SECRET);
    await mcpCall("publicapi_fetch", { path: "/x" });
    expect(new URL(seen[1]!).searchParams.size).toBe(0);
  });

  it("delete removes the definition AND the credential; the tool disappears", async () => {
    expect((await req("/api/v1/connectors/custom/weatherapi", json(member, "DELETE"))).status).toBe(
      403,
    );
    expect((await req("/api/v1/connectors/custom/weatherapi", json(owner, "DELETE"))).status).toBe(
      200,
    );
    const cfg = await pool.query("SELECT 1 FROM connector_config WHERE provider = 'weatherapi'");
    expect(cfg.rowCount).toBe(0);
    expect((await mcpTools()).map((t) => t.name)).not.toContain("weatherapi_fetch");
  });
});
