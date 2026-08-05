import { createHash, randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, generateDevKeypair, makeDevSigner } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * MCP OAuth (per the MCP auth spec). Proves the box's own authorization server lets
 * a client register, sign in with a pasted member token, exchange a PKCE code
 * for a JWT, and use that JWT on /mcp — i.e. the claude.ai one-click flow works.
 */

const PUBLIC_URL = "https://brain.test";
const form = (o: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o).toString(),
});
const b64url = (b: Buffer): string => b.toString("base64url");

describe("MCP OAuth · authorization server", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let ownerToken: string;
  let readerToken: string;
  let ownerId: string;

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    // The Host header drives the derived origin/issuer in the OAuth handlers.
    Promise.resolve(
      app.request(path, { ...init, headers: { host: "brain.test", ...(init?.headers ?? {}) } }),
    );

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    const keypair = await generateDevKeypair();
    const signer = await makeDevSigner(keypair);
    app = createBox({ pool, ownerClient, oauth: { pool, signer, publicUrl: PUBLIC_URL } });

    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    ownerToken = boot.token;
    ownerId = boot.id;
    const member = await admin.createUser(boot.id, {
      name: "Reader",
      email: "user@example.com",
      permission: "viewer",
    });
    readerToken = member.token;
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("publishes discovery metadata pointing at itself as the auth server", async () => {
    const prm = await req("/.well-known/oauth-protected-resource");
    expect(prm.status).toBe(200);
    const prmBody = (await prm.json()) as { resource: string; authorization_servers: string[] };
    expect(prmBody.resource).toBe(`${PUBLIC_URL}/mcp`);
    expect(prmBody.authorization_servers).toContain(PUBLIC_URL);

    const asm = await req("/.well-known/oauth-authorization-server");
    const asmBody = (await asm.json()) as Record<string, unknown>;
    expect(asmBody.issuer).toBe(PUBLIC_URL);
    expect(asmBody.authorization_endpoint).toBe(`${PUBLIC_URL}/oauth/authorize`);
    expect(asmBody.token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
    expect(asmBody.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("points /mcp 401s at the resource metadata (so claude.ai starts the flow)", async () => {
    const res = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });

  it("runs the full register → authorize(token) → token → use-on-/mcp flow", async () => {
    // 1. Dynamic client registration.
    const reg = await req("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://claude.ai/callback"],
        client_name: "Claude",
      }),
    });
    expect(reg.status).toBe(201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    expect(clientId).toBeTruthy();

    // 2. PKCE pair + the authorize request.
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const authParams = {
      client_id: clientId,
      redirect_uri: "https://claude.ai/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      scope: "read",
    };

    const page = await req(`/oauth/authorize?${new URLSearchParams(authParams).toString()}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    // 3. Sign in by pasting the member (owner) token → redirect carries the code.
    const posted = await req("/oauth/authorize", form({ ...authParams, token: ownerToken }));
    expect(posted.status).toBe(302);
    const location = posted.headers.get("location")!;
    const cbUrl = new URL(location);
    expect(cbUrl.searchParams.get("state")).toBe("xyz");
    const code = cbUrl.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 4. Exchange the code (+ PKCE verifier) for an access token.
    const tok = await req(
      "/oauth/token",
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: "https://claude.ai/callback",
      }),
    );
    expect(tok.status).toBe(200);
    const token = (await tok.json()) as { access_token: string; token_type: string };
    expect(token.token_type).toBe("Bearer");
    expect(token.access_token.split(".")).toHaveLength(3); // a JWT

    // 5. The issued JWT authenticates on /mcp (tools/list requires a valid token).
    const mcp = await req("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcp.status).toBe(200);
    const rpc = (await mcp.json()) as { result?: { tools?: unknown[] }; error?: unknown };
    expect(rpc.error).toBeUndefined();
    expect(Array.isArray(rpc.result?.tools)).toBe(true);

    // And a garbage bearer is still rejected (the gate is real, not open).
    const denied = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-jwt" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(denied.status).toBe(401);
  });

  it("rejects a wrong PKCE verifier at the token endpoint", async () => {
    const reg = await req("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/callback"] }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const challenge = b64url(createHash("sha256").update("the-real-verifier").digest());
    const authParams = {
      client_id: clientId,
      redirect_uri: "https://claude.ai/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const posted = await req("/oauth/authorize", form({ ...authParams, token: ownerToken }));
    const code = new URL(posted.headers.get("location")!).searchParams.get("code")!;

    const tok = await req(
      "/oauth/token",
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: "WRONG-verifier",
        client_id: clientId,
        redirect_uri: "https://claude.ai/callback",
      }),
    );
    expect(tok.status).toBe(400);
    expect(((await tok.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("rejects an unregistered redirect_uri and a bad member token", async () => {
    const reg = await req("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/callback"] }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const base = {
      client_id: clientId,
      response_type: "code",
      code_challenge: b64url(createHash("sha256").update("v").digest()),
      code_challenge_method: "S256",
    };

    // Open-redirect guard: a redirect_uri not registered for the client is 400.
    const evil = await req(
      `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: "https://evil.example/steal" }).toString()}`,
    );
    expect(evil.status).toBe(400);

    // A bad token re-renders the sign-in with a 401, no code minted.
    const bad = await req(
      "/oauth/authorize",
      form({ ...base, redirect_uri: "https://claude.ai/callback", token: "nope" }),
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("location")).toBeNull();
  });

  // ---- hardening (Ishaan's review of PR #3) --------------------------------

  const registerClient = async (): Promise<string> => {
    const reg = await req("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/callback"] }),
    });
    return ((await reg.json()) as { client_id: string }).client_id;
  };
  const authParamsFor = (clientId: string, scope?: string): Record<string, string> => ({
    client_id: clientId,
    redirect_uri: "https://claude.ai/callback",
    response_type: "code",
    code_challenge: b64url(createHash("sha256").update("verifier").digest()),
    code_challenge_method: "S256",
    ...(scope !== undefined ? { scope } : {}),
  });

  it("makes the sign-in page un-framable (anti-clickjacking)", async () => {
    const clientId = await registerClient();
    const page = await req(
      `/oauth/authorize?${new URLSearchParams(authParamsFor(clientId)).toString()}`,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });

  it("down-scopes an over-requested scope to the granted subset (reader asking read+write gets read)", async () => {
    const clientId = await registerClient();
    const res = await req(
      "/oauth/authorize",
      form({ ...authParamsFor(clientId, "read write"), token: readerToken }),
    );
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    // over-request is DROPPED, not rejected: a code is issued (RFC 6749 §3.3)
    expect(url.searchParams.get("error")).toBeNull();
    const code = url.searchParams.get("code");
    expect(code).not.toBeNull();
    // ...and the token carries only 'read' — write was never granted, so it's dropped
    const tok = await req(
      "/oauth/token",
      form({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: "verifier",
        client_id: clientId,
        redirect_uri: "https://claude.ai/callback",
      }),
    );
    expect(((await tok.json()) as { scope: string }).scope).toBe("read");
  });

  it("lets a read+write member connect when the client over-requests schema-admin", async () => {
    // The exact claude.ai case: it requests the full advertised set
    // (read write schema-admin); a member holding only read+write must still
    // connect, down-scoped — not fail with invalid_scope.
    const member = await new Admin(pool).createUser(ownerId, {
      name: "RW Member",
      email: "rwmember@example.com",
      permission: "member",
    });
    const clientId = await registerClient();
    const res = await req(
      "/oauth/authorize",
      form({ ...authParamsFor(clientId, "read write schema-admin"), token: member.token }),
    );
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.searchParams.get("error")).toBeNull();
    expect(url.searchParams.get("code")).not.toBeNull();
  });

  it("still rejects a request for ONLY an ungranted scope (empty intersection)", async () => {
    const clientId = await registerClient();
    const res = await req(
      "/oauth/authorize",
      form({ ...authParamsFor(clientId, "write"), token: readerToken }),
    );
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.searchParams.get("error")).toBe("invalid_scope");
    expect(url.searchParams.get("code")).toBeNull();
  });

  it("defaults an omitted scope to least privilege (read), not the full set", async () => {
    const clientId = await registerClient();
    const posted = await req(
      "/oauth/authorize",
      form({ ...authParamsFor(clientId), token: ownerToken }),
    );
    const code = new URL(posted.headers.get("location")!).searchParams.get("code")!;
    const tok = await req(
      "/oauth/token",
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: "verifier",
        client_id: clientId,
        redirect_uri: "https://claude.ai/callback",
      }),
    );
    // Owner holds every scope, but omitting `scope` must yield only `read`.
    expect(((await tok.json()) as { scope: string }).scope).toBe("read");
  });

  // --- refresh tokens: authenticate once, renew silently, forever ---
  // Full connect flow → returns the token response (access + refresh).
  const connect = async (
    token: string,
    scope?: string,
  ): Promise<{ clientId: string; access: string; refresh: string }> => {
    const clientId = await registerClient();
    const posted = await req(
      "/oauth/authorize",
      form({ ...authParamsFor(clientId, scope), token }),
    );
    const code = new URL(posted.headers.get("location")!).searchParams.get("code")!;
    const tok = await req(
      "/oauth/token",
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: "verifier",
        client_id: clientId,
        redirect_uri: "https://claude.ai/callback",
      }),
    );
    const body = (await tok.json()) as { access_token: string; refresh_token: string };
    return { clientId, access: body.access_token, refresh: body.refresh_token };
  };
  const doRefresh = (refresh: string, clientId: string): Promise<Response> =>
    req(
      "/oauth/token",
      form({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }),
    );

  it("authorization_code issues a refresh_token alongside the access token", async () => {
    const { refresh } = await connect(ownerToken);
    expect(refresh).toMatch(/^brain_rt_/);
  });

  it("refresh mints a new usable access token AND rotates the refresh token", async () => {
    const { clientId, access, refresh } = await connect(ownerToken);
    const res = await doRefresh(refresh, clientId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    expect(body.access_token).not.toBe(access); // fresh access token
    expect(body.refresh_token).not.toBe(refresh); // rotated (single-use)
    // the new access token actually works on /mcp
    const mcp = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${body.access_token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "catalog", arguments: {} },
      }),
    });
    expect(mcp.status).toBe(200);
  });

  it("a rotated (used) refresh token is dead on replay", async () => {
    const { clientId, refresh } = await connect(ownerToken);
    expect((await doRefresh(refresh, clientId)).status).toBe(200); // first use ok
    const replay = await doRefresh(refresh, clientId); // same token again
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refresh slides: the chain renews indefinitely (refresh the refreshed)", async () => {
    const { clientId, refresh } = await connect(ownerToken);
    const r1 = (await (await doRefresh(refresh, clientId)).json()) as { refresh_token: string };
    const r2 = await doRefresh(r1.refresh_token, clientId);
    expect(r2.status).toBe(200); // the freshly-issued token also refreshes
  });

  it("refresh is bound to its client (a different client_id is rejected)", async () => {
    const { refresh } = await connect(ownerToken);
    const other = await registerClient();
    expect((await doRefresh(refresh, other)).status).toBe(400);
  });

  it("a revoked member cannot refresh (re-authorized against the live account)", async () => {
    const admin = new Admin(pool);
    const victim = await admin.createUser(ownerId, {
      name: "Victim",
      email: "victim@example.com",
      permission: "viewer",
    });
    const { clientId, refresh } = await connect(victim.token);
    await admin.revokeAccount(ownerId, victim.id); // owner revokes them
    const res = await doRefresh(refresh, clientId);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("advertises the refresh_token grant in AS metadata", async () => {
    const asm = await req("/.well-known/oauth-authorization-server");
    const body = (await asm.json()) as { grant_types_supported: string[] };
    expect(body.grant_types_supported).toContain("refresh_token");
  });

  it("rejects a non-https / fragment redirect_uri at registration", async () => {
    for (const bad of ["http://evil.example/cb", "https://ok.example/cb#frag", "ftp://x/y"]) {
      const reg = await req("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [bad] }),
      });
      expect(reg.status).toBe(400);
    }
    // Loopback http IS allowed (native apps).
    const ok = await req("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:8976/cb"] }),
    });
    expect(ok.status).toBe(201);
  });
});

// A refresh token must survive a box RESTART — else every update forces a
// re-auth. Two box instances over the SAME stateFile stand in for restart:
// connect on box A, then refresh on box B (fresh process, same durable volume).
describe("MCP OAuth · refresh tokens survive restart", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let stateFile: string;
  let ownerToken: string;

  const reqOn = (app: Hono, path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      app.request(path, { ...init, headers: { host: "brain.test", ...(init?.headers ?? {}) } }),
    );
  const bootBox = async (): Promise<Hono> => {
    const signer = await makeDevSigner(await generateDevKeypair());
    return createBox({
      pool,
      ownerClient,
      oauth: { pool, signer, publicUrl: PUBLIC_URL, stateFile },
    });
  };
  const register = async (app: Hono): Promise<string> => {
    const reg = await reqOn(app, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/callback"] }),
    });
    return ((await reg.json()) as { client_id: string }).client_id;
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    stateFile = join(mkdtempSync(join(tmpdir(), "brain-oauth-")), "clients.json");
    ownerToken = (
      await new Admin(pool).bootstrapOwner({ name: "Owner", email: "owner@example.com" })
    ).token;
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("a refresh token issued on box A still works on box B (same stateFile)", async () => {
    const boxA = await bootBox();
    const clientId = await register(boxA);
    const posted = await reqOn(
      boxA,
      "/oauth/authorize",
      form({
        client_id: clientId,
        redirect_uri: "https://claude.ai/callback",
        response_type: "code",
        code_challenge: b64url(createHash("sha256").update("verifier").digest()),
        code_challenge_method: "S256",
        token: ownerToken,
      }),
    );
    const code = new URL(posted.headers.get("location")!).searchParams.get("code")!;
    const tok = await reqOn(
      boxA,
      "/oauth/token",
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: "verifier",
        client_id: clientId,
        redirect_uri: "https://claude.ai/callback",
      }),
    );
    const refresh = ((await tok.json()) as { refresh_token: string }).refresh_token;

    // "restart": a brand-new box process, same persisted state.
    const boxB = await bootBox();
    const res = await reqOn(
      boxB,
      "/oauth/token",
      form({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { access_token: string }).access_token).toBeTruthy();
  });
});
