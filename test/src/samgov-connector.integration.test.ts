import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { ConnectorConfigStore, TokenVault } from "@brain/box/dist/connectors/index.js";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The SAM.gov connector surface (0023 + dashboard config routes + the
 * samgov_fetch MCP tool): an OWNER enables it by storing the org API key
 * (encrypted, owner-only, CSRF'd, never echoed back); any member's agent then
 * calls samgov_fetch over /mcp and the box injects the key server-side.
 */

const SECRET = "test-session-secret-samgov";
const CONNECTOR_ENV = {
  BRAIN_CONNECTOR_TOKEN_KEY: randomBytes(32).toString("base64"),
};
const API_KEY = "org-sam-gov-api-key-value";

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

describe("samgov connector (config routes + samgov_fetch tool)", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let owner: { cookie: string; csrf: string };
  let member: { cookie: string; csrf: string };
  let memberBearer: string;
  let memberId: string;

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
      headers: {
        authorization: `Bearer ${memberBearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    return body.result.content[0]!.text;
  };

  const mcpToolNames = async (): Promise<string[]> => {
    const res = await req("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${memberBearer}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    return body.result.tools.map((t) => t.name);
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
    });

    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    const m = await admin.createUser(boot.id, {
      name: "Member",
      email: "member@example.com",
      permission: "member",
    });
    memberBearer = m.token;
    memberId = m.id;
    owner = await login(boot.token);
    member = await login(m.token);
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lists the catalog with enabled status (session required; members see only enabled)", async () => {
    expect((await req("/api/v1/connectors")).status).toBe(401);

    // Before enable: neither tier is set. samgov is a self-adoptable custom
    // connector (an API key), so a member now SEES it on the Connectors page
    // to bring their own key (the approved doctrine reversal) — but the tool
    // stays hidden until a credential actually exists (asserted below).
    const asOwner = await req("/api/v1/connectors", { headers: { cookie: owner.cookie } });
    expect(asOwner.status).toBe(200);
    const ownerList = (await asOwner.json()) as Array<Record<string, unknown>>;
    expect(ownerList.find((e) => e["provider"] === "samgov")).toMatchObject({
      name: "SAM.gov",
      orgEnabled: false,
      myPersonalEnabled: false,
      selfAdoptable: true,
    });

    const asMember = await req("/api/v1/connectors", { headers: { cookie: member.cookie } });
    expect(asMember.status).toBe(200);
    const memberList = (await asMember.json()) as Array<Record<string, unknown>>;
    expect(memberList.find((e) => e["provider"] === "samgov")).toMatchObject({
      orgEnabled: false,
      myPersonalEnabled: false,
    });
  });

  it("samgov_fetch before enable is hidden from tools/list, and a direct call teaches", async () => {
    expect(await mcpToolNames()).not.toContain("samgov_fetch");
    const text = await mcpCall("samgov_fetch", { path: "/opportunities/v2/search" });
    expect(text).toContain("not enabled");
    expect(text).toContain("Connectors");
  });

  it("enable is OWNER ONLY and CSRF-protected; the key is required (no validator — custom class)", async () => {
    // samgov is a CUSTOM connector since its de-hardcoding: no anti-smurf
    // live check (Alice's 2026-07-20 decision — custom connectors store
    // as-is; call-time teaching errors carry the weight). The credential
    // field is the custom class's `value`.
    const asMember = await req(
      "/api/v1/connectors/samgov/config",
      json(member, "PUT", { value: API_KEY }),
    );
    expect(asMember.status).toBe(403);

    const noCsrf = await req("/api/v1/connectors/samgov/config", {
      method: "PUT",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({ value: API_KEY }),
    });
    expect(noCsrf.status).toBe(403);

    const missing = await req("/api/v1/connectors/samgov/config", json(owner, "PUT", {}));
    expect(missing.status).toBe(400);

    const unknown = await req(
      "/api/v1/connectors/nope/config",
      json(owner, "PUT", { anything: "x" }),
    );
    expect(unknown.status).toBe(400);

    const ok = await req(
      "/api/v1/connectors/samgov/config",
      json(owner, "PUT", { value: API_KEY }),
    );
    expect(ok.status).toBe(200);

    const list = (await (
      await req("/api/v1/connectors", { headers: { cookie: member.cookie } })
    ).json()) as Array<Record<string, unknown>>;
    expect(list.find((e) => e["provider"] === "samgov")).toMatchObject({ orgEnabled: true });

    // Org-keyed provider enabled → the tool appears on EVERY member's
    // tools/list (no per-member connect step, no restart).
    expect(await mcpToolNames()).toContain("samgov_fetch");
  });

  it("stores the key encrypted — no plaintext in the row, never echoed by the API", async () => {
    const raw = await pool.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM connector_config WHERE provider = 'samgov'",
    );
    expect(raw.rows[0]!.ciphertext).not.toContain(API_KEY);

    const list = (await (
      await req("/api/v1/connectors", { headers: { cookie: owner.cookie } })
    ).json()) as Array<Record<string, unknown>>;
    expect(JSON.stringify(list)).not.toContain(API_KEY);

    const store = new ConnectorConfigStore(pool, CONNECTOR_ENV);
    expect(await store.getConfig("samgov")).toEqual({ value: API_KEY });

    // wrong key → null (owner re-enters), never a throw
    const wrongKey = new ConnectorConfigStore(pool, {
      BRAIN_CONNECTOR_TOKEN_KEY: randomBytes(32).toString("base64"),
    });
    expect(await wrongKey.getConfig("samgov")).toBeNull();
  });

  it("a pre-custom config row ({apiKey}) keeps working — live boxes migrate with zero credential churn", async () => {
    const store = new ConnectorConfigStore(pool, CONNECTOR_ENV);
    await store.putConfig("samgov", { apiKey: API_KEY }, memberId);
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL) => {
      calls.push(String(input));
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve('{"totalRecords":0}'),
      });
    });
    await mcpCall("samgov_fetch", { path: "/opportunities/v2/search" });
    expect(new URL(calls[0]!).searchParams.get("api_key")).toBe(API_KEY);
    // restore the custom-class shape for the tests below
    await store.putConfig("samgov", { value: API_KEY }, memberId);
  });

  it("samgov_fetch injects the stored key server-side and returns SAM.gov JSON", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (!url.startsWith("https://api.sam.gov/")) throw new Error(`unexpected fetch: ${url}`);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve('{"totalRecords":1}'),
      });
    });

    const text = await mcpCall("samgov_fetch", {
      path: "/opportunities/v2/search",
      params: { postedFrom: "01/01/2026", postedTo: "07/09/2026" },
    });
    expect(text).toContain('"totalRecords":1');
    // the agent-facing result never carries the key
    expect(text).not.toContain(API_KEY);
    // ...but the outbound request did
    expect(new URL(calls[0]!).searchParams.get("api_key")).toBe(API_KEY);
  });

  it("routes full URLs from search results: noticedesc keeps the key, attachments never see it", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://api.sam.gov/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: () => Promise.resolve('{"description":"<p>the scope of work</p>"}'),
        });
      }
      if (url.startsWith("https://sam.gov/api/prod/opps/v3/opportunities/resources/files/")) {
        const body = new TextEncoder().encode("Amendment 0001: see attached PWS.");
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: (k: string) => ({ "content-type": "text/plain" })[k.toLowerCase()] ?? null,
          },
          arrayBuffer: () => Promise.resolve(body.buffer),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    // a search result's `description` URL, pasted verbatim → api.sam.gov + key
    const desc = await mcpCall("samgov_fetch", {
      path: "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=abc123",
    });
    expect(desc).toContain("the scope of work");
    const descUrl = new URL(calls[0]!);
    expect(descUrl.pathname).toBe("/prod/opportunities/v1/noticedesc");
    expect(descUrl.searchParams.get("noticeid")).toBe("abc123");
    expect(descUrl.searchParams.get("api_key")).toBe(API_KEY);

    // a `resourceLinks` URL → sam.gov attachment fetch, NO key on the wire
    const doc = await mcpCall("samgov_fetch", {
      path: "https://sam.gov/api/prod/opps/v3/opportunities/resources/files/deadbeef01/download",
    });
    expect(doc).toContain("Amendment 0001");
    expect(calls[1]).toContain("/resources/files/deadbeef01/download");
    expect(calls[1]).not.toContain("api_key");
    expect(doc).not.toContain(API_KEY);
  });

  it("disable is owner-only and flips the tool back to teaching (and hides it again)", async () => {
    const asMember = await req("/api/v1/connectors/samgov/config", json(member, "DELETE"));
    expect(asMember.status).toBe(403);

    const ok = await req("/api/v1/connectors/samgov/config", json(owner, "DELETE"));
    expect(ok.status).toBe(200);

    expect(await mcpToolNames()).not.toContain("samgov_fetch");
    const text = await mcpCall("samgov_fetch", { path: "/opportunities/v2/search" });
    expect(text).toContain("not enabled");
  });

  it("a per-member OAuth provider needs org config AND the caller's own tokens", async () => {
    // org hasn't configured google → hidden
    expect(await mcpToolNames()).not.toContain("google");

    // owner configures the OAuth client → still hidden until THIS member connects
    const store = new ConnectorConfigStore(pool, CONNECTOR_ENV);
    await store.putConfig("google", { clientId: "id", clientSecret: "secret" }, memberId);
    expect(await mcpToolNames()).not.toContain("google");

    // member's tokens land in the vault (what /connect/callback does) → visible
    const vault = new TokenVault(pool, {}, CONNECTOR_ENV);
    await vault.putTokens({
      accountId: memberId,
      provider: "google",
      accessToken: "at",
      secretBlob: "{}",
    });
    expect(await mcpToolNames()).toContain("google");

    // disconnect → hidden again
    await vault.deleteTokens(memberId, "google");
    expect(await mcpToolNames()).not.toContain("google");
    await store.deleteConfig("google");
  });
});
