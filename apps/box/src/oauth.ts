import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Context, Hono } from "hono";
import type { Pool } from "pg";
import {
  type DevSigner,
  validateStaticBearer,
  validateActorById,
  type AuthedContext,
  type Scope,
} from "@brain/mcp-tools";
import { uiPage } from "@brain/shared";

/**
 * The box's OAuth 2.1 authorization server (per the MCP auth spec).
 *
 * Why this exists: claude.ai / Claude Desktop add a remote MCP server through an
 * OAuth flow (protected-resource discovery → authorization-server metadata →
 * dynamic client registration → PKCE authorize → token). The box is a
 * static-bearer/JWT resource server, so without these endpoints that flow fails
 * ("couldn't register with the sign-in service"). This module makes the box its
 * OWN authorization server so a member connects it in the UI in one click.
 *
 * Trust model (unchanged): member accounts live ONLY on the box — the booth
 * never sees them. So the sign-in service is box-local. A member proves
 * identity by pasting the member token the owner issued them (decision:
 * token-paste); the box verifies it via the same `validateStaticBearer` used by
 * `/mcp`, then issues a short-lived JWT the box verifies locally on `/mcp`.
 *
 * v1 scope: clients + auth codes are IN-MEMORY, bounded (client registry capped
 * + evicted, codes swept on expiry) so an unauthenticated /oauth/register can't
 * OOM the box; a dynamically-registered client re-registers transparently after
 * a restart. The token-signing key is loaded from BRAIN_OAUTH_SIGNING_KEY_B64
 * (index.ts) so tokens survive restarts; a per-process key + loud warning is the
 * dev fallback. Follow-up: move the signing key to KMS + persist the registry.
 */

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_SECONDS = 3600;
// Refresh token: long-lived + SLIDING (its clock resets on every use, below), so
// an actively-used connection renews itself indefinitely and the member paste
// their token exactly once, at setup. Only a connection idle for this whole
// window re-authenticates. Rotated on every use (OAuth 2.1 public-client rule).
const REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const SUPPORTED_SCOPES = ["read", "write", "schema-admin"] as const;
/** Cap the in-memory client registry so unauthenticated /oauth/register can't OOM the box. */
const MAX_CLIENTS = 5_000;
/** Cap the refresh store the same way (each is one connected session). */
const MAX_REFRESH_TOKENS = 20_000;
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 200;

interface RegisteredClient {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly clientName: string;
}

interface AuthCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly ctx: AuthedContext;
  readonly scopes: readonly Scope[];
  readonly expiresAt: number;
}

/**
 * A persisted refresh grant. We store the HASH of the refresh token (never the
 * token itself), plus everything needed to re-authorize and re-issue: the
 * account id (re-checked live on use), the bound client, and the granted scopes.
 */
interface RefreshRecord {
  readonly tokenHash: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly scopes: readonly Scope[];
  readonly expiresAt: number;
}

export interface OAuthOptions {
  readonly pool: Pool;
  /** signs the issued access-token JWTs (box verifies them locally on /mcp). */
  readonly signer: DevSigner;
  /**
   * The box's canonical public origin, e.g. https://brain.example.com. Used to
   * build the issuer + endpoints + the /mcp audience. If omitted, it is derived
   * per-request from the Host header (fine for a single-domain box).
   */
  readonly publicUrl?: string;
  /**
   * File on a durable volume where the registered-client registry is persisted.
   * Without it, dynamically-registered clients live only in memory, so a box
   * restart invalidates every connected client's `client_id` (they'd have to
   * re-add the connector). With it, connections survive restarts.
   */
  readonly stateFile?: string;
}

/** The public origin for this request: configured value wins, else derive from Host. */
function originOf(c: Context, configured?: string): string {
  if (configured) return configured.replace(/\/+$/, "");
  const proto = c.req.header("x-forwarded-proto") ?? "https";
  const host = c.req.header("host") ?? "localhost";
  return `${proto}://${host}`;
}

/** The resource identifier the issued token is bound to (RFC 8707): <origin>/mcp. */
export function mcpAudience(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

function b64urlSha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/** Atomic best-effort JSON persist: mkdir → write a 0600 temp → rename over the
 *  target. Shared by the client-registry and refresh-token stores. An
 *  unwritable path degrades to in-memory, never a crash. */
function persistJson(file: string, values: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(values), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* best-effort — an unwritable store degrades to in-memory, not a crash */
  }
}

function json(c: Context, body: unknown, status = 200): Response {
  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "no-store");
  return c.json(body as object, status as 200);
}

type ScopeResult = { readonly ok: true; readonly scopes: Scope[] } | { readonly ok: false };

/**
 * Resolve the requested scope against what the member actually holds.
 * - omitted/empty ⇒ LEAST privilege (`read` if the member has it, else the
 *   single lowest granted scope) — never the member's full set, so a client
 *   that sends no scope can't silently pocket `schema-admin`.
 * - a genuinely UNSUPPORTED scope (unknown string) ⇒ `invalid_scope`.
 * - a supported-but-ungranted scope is DROPPED, not rejected: the token is
 *   granted `requested ∩ granted` (RFC 6749 down-scoping). This is
 *   required for clients that request the full advertised set — claude.ai asks
 *   for `read write schema-admin`, so a member holding only `read write` must
 *   still connect, with a correspondingly narrowed token. Down-scoping only
 *   ever grants LESS than the account holds (no escalation). An empty
 *   intersection (asked only for ungranted scopes) ⇒ `invalid_scope`.
 */
function resolveScopes(requested: string | undefined, granted: readonly Scope[]): ScopeResult {
  const grantedSet = new Set<Scope>(granted);
  const req = (requested ?? "").split(/\s+/).filter(Boolean);
  if (req.length === 0) {
    if (grantedSet.has("read")) return { ok: true, scopes: ["read"] };
    const least = [...granted].sort(
      (a, b) => SUPPORTED_SCOPES.indexOf(a) - SUPPORTED_SCOPES.indexOf(b),
    );
    return { ok: true, scopes: least.slice(0, 1) };
  }
  const supported = new Set<string>(SUPPORTED_SCOPES);
  for (const s of req) {
    if (!supported.has(s)) return { ok: false }; // unknown scope ⇒ client error
  }
  const scopes = req.filter((s) => grantedSet.has(s as Scope)) as Scope[];
  if (scopes.length === 0) return { ok: false }; // asked only for ungranted scopes
  return { ok: true, scopes };
}

/** Headers for the sign-in page: its own CSP + anti-clickjacking (framing kills a token-paste UI). */
function signInHeaders(c: Context, redirectUri?: string): void {
  // form-action MUST allow the OAuth redirect target. On submit the box replies
  // 302 → the client's redirect_uri (e.g. https://claude.ai/api/mcp/auth_callback),
  // and Chrome enforces `form-action` against that REDIRECT, not just the POST
  // target. With only 'self' the connect flow silently dies: the browser refuses
  // to follow the 302 and the page appears to "just refresh" (the box still logs
  // a clean 302 — the block is entirely client-side). The redirect_uri is already
  // exact-matched to the client's registered allowlist before we get here, so
  // trusting its origin in the CSP is safe.
  let formAction = "'self'";
  if (redirectUri) {
    try {
      formAction += ` ${new URL(redirectUri).origin}`;
    } catch {
      /* unparseable → fall back to 'self' only */
    }
  }
  // style-src 'unsafe-inline' carries the page's one <style> tag; with scripts,
  // images, and connections still at 'none' and every input esc()'d, inline
  // style injection is not a reachable channel here.
  c.header(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  );
  c.header("x-frame-options", "DENY");
}

/** A registrable redirect target: absolute https, or loopback http (native apps), no fragment. */
function isValidRedirectUri(raw: string): boolean {
  if (raw.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );
}

/** The token-paste sign-in page — the one HTML surface, self-contained + CSP-safe. */
function signInPage(params: Record<string, string>, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return uiPage(
    "Connect your brain",
    `<div class="card">
    <div class="card-head">
      <h1>Connect your brain</h1>
      <p class="muted">Paste the access token your owner issued you to authorize this connection.</p>
    </div>
    ${error ? `<div class="alert">${esc(error)}</div>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <div class="field">
        <label for="tok">Access token</label>
        <input id="tok" type="password" name="token" placeholder="brain_sk_…" autocomplete="off" autofocus required spellcheck="false">
      </div>
      <button type="submit" class="primary full">Sign in &amp; connect</button>
    </form>
    <p class="muted" style="margin-top:14px">Verified on this box — your token never leaves it.</p>
  </div>`,
    { width: "narrow" },
  );
}

/**
 * Mount the OAuth discovery + authorization + token endpoints. Also owns the
 * `/.well-known/oauth-protected-resource` document the box points at from its
 * 401 `WWW-Authenticate` (see mcp-http.ts).
 */
export function mountOAuth(app: Hono, opts: OAuthOptions): void {
  const clients = new Map<string, RegisteredClient>();
  const codes = new Map<string, AuthCode>();

  // Load the persisted client registry (survives restarts). Auth codes stay
  // in-memory — they are seconds-lived, so a restart mid-flow just re-auths.
  if (opts.stateFile) {
    try {
      const rows = JSON.parse(readFileSync(opts.stateFile, "utf8")) as RegisteredClient[];
      for (const c of rows) if (c && typeof c.clientId === "string") clients.set(c.clientId, c);
    } catch {
      /* missing/corrupt registry → start empty; clients re-register on demand */
    }
  }
  const persistClients = (): void => {
    if (!opts.stateFile) return;
    persistJson(opts.stateFile, [...clients.values()]);
  };

  // --- refresh-token store (hash → record), persisted beside the client registry
  // so connections survive restarts. A separate file keeps the client-registry
  // format untouched (older boxes' persisted registries still load). ---
  const refreshFile = opts.stateFile ? `${opts.stateFile}.refresh` : undefined;
  const refresh = new Map<string, RefreshRecord>();
  if (refreshFile) {
    try {
      const rows = JSON.parse(readFileSync(refreshFile, "utf8")) as RefreshRecord[];
      const now = Date.now();
      for (const r of rows) {
        if (r && typeof r.tokenHash === "string" && r.expiresAt > now) refresh.set(r.tokenHash, r);
      }
    } catch {
      /* missing/corrupt → start empty; connections re-auth once on next expiry */
    }
  }
  const persistRefresh = (): void => {
    if (!refreshFile) return;
    persistJson(refreshFile, [...refresh.values()]);
  };
  const sweepRefresh = (): void => {
    const now = Date.now();
    for (const [h, r] of refresh) if (r.expiresAt <= now) refresh.delete(h);
  };
  /** Mint + store a rotating refresh token; returns the raw token to hand the client. */
  const issueRefresh = (actorId: string, clientId: string, scopes: readonly Scope[]): string => {
    sweepRefresh();
    if (refresh.size >= MAX_REFRESH_TOKENS) {
      const oldest = refresh.keys().next().value; // insertion-ordered ⇒ oldest first
      if (oldest !== undefined) refresh.delete(oldest);
    }
    const raw = `brain_rt_${randomBytes(32).toString("base64url")}`;
    const tokenHash = b64urlSha256(raw);
    refresh.set(tokenHash, {
      tokenHash,
      actorId,
      clientId,
      scopes,
      expiresAt: Date.now() + REFRESH_TTL_SECONDS * 1000,
    });
    persistRefresh();
    return raw;
  };

  const origin = (c: Context): string => originOf(c, opts.publicUrl);
  /** Sign an access-token JWT for these grant details (shared by both grant types). */
  const mintAccess = (o: string, actorId: string, role: string, scopes: readonly Scope[]) =>
    opts.signer.sign({
      sub: actorId,
      scopes: [...scopes],
      role,
      aud: mcpAudience(o),
      expiresInSeconds: ACCESS_TTL_SECONDS,
    });

  /** Drop expired auth codes so an unexchanged-code leak can't grow unbounded. */
  const sweepCodes = (): void => {
    const now = Date.now();
    for (const [code, entry] of codes) if (entry.expiresAt < now) codes.delete(code);
  };

  const preflight = (c: Context): Response => {
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-methods", "GET, POST, OPTIONS");
    c.header("access-control-allow-headers", "content-type, authorization");
    return c.body(null, 204);
  };
  app.options("/oauth/*", preflight);
  app.options("/.well-known/*", preflight);

  // --- RFC 9728: protected-resource metadata (points at THIS box as its own AS) ---
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const origin = originOf(c, opts.publicUrl);
    return json(c, {
      resource: mcpAudience(origin),
      authorization_servers: [origin],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });

  // --- RFC 8414: authorization-server metadata ---
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = originOf(c, opts.publicUrl);
    return json(c, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SUPPORTED_SCOPES,
    });
  });

  // --- RFC 7591: dynamic client registration (public clients, PKCE, no secret) ---
  app.post("/oauth/register", async (c) => {
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return json(c, { error: "invalid_client_metadata" }, 400);
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (
      redirectUris.length === 0 ||
      redirectUris.length > MAX_REDIRECT_URIS ||
      !redirectUris.every(isValidRedirectUri)
    ) {
      return json(c, { error: "invalid_redirect_uri" }, 400);
    }
    // Bound the registry: evict the oldest (insertion-ordered Map) at the cap so
    // an unauthenticated caller can't loop registrations into an OOM.
    if (clients.size >= MAX_CLIENTS) {
      const oldest = clients.keys().next().value;
      if (oldest !== undefined) clients.delete(oldest);
    }
    const clientId = `brain_client_${randomBytes(16).toString("base64url")}`;
    const rawName = typeof body.client_name === "string" ? body.client_name : "MCP client";
    const client: RegisteredClient = {
      clientId,
      redirectUris,
      clientName: rawName.slice(0, MAX_CLIENT_NAME),
    };
    clients.set(clientId, client);
    persistClients();
    return json(
      c,
      {
        client_id: clientId,
        redirect_uris: redirectUris,
        client_name: client.clientName,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  // --- authorize (GET renders the token-paste sign-in) ---
  app.get("/oauth/authorize", (c) => {
    const q = c.req.query();
    const check = validateAuthorizeParams(clients, q);
    if (!check.ok) return c.text(check.error, 400);
    signInHeaders(c, check.params.redirect_uri);
    return c.html(signInPage(check.params));
  });

  // --- authorize (POST verifies the pasted member token, mints an auth code) ---
  app.post("/oauth/authorize", async (c) => {
    const form = await c.req.parseBody();
    const q: Record<string, string> = {};
    for (const k of [
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
    ]) {
      const v = form[k];
      if (typeof v === "string") q[k] = v;
    }
    const check = validateAuthorizeParams(clients, q);
    if (!check.ok) return c.text(check.error, 400);

    const token = typeof form.token === "string" ? form.token.trim() : "";
    let ctx: AuthedContext;
    try {
      ctx = await validateStaticBearer(opts.pool, token);
    } catch {
      signInHeaders(c, check.params.redirect_uri);
      return c.html(
        signInPage(check.params, "That token was not accepted. Check it and try again."),
        401,
      );
    }

    // Resolve scope against the member's grants: omitted ⇒ least privilege, and
    // an over-request (unsupported/ungranted) is redirected back as invalid_scope.
    const scopeResult = resolveScopes(q.scope, ctx.scopes);
    if (!scopeResult.ok) {
      const err = new URL(q.redirect_uri!);
      err.searchParams.set("error", "invalid_scope");
      if (q.state) err.searchParams.set("state", q.state);
      return c.redirect(err.toString(), 302);
    }

    sweepCodes();
    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      clientId: q.client_id!,
      redirectUri: q.redirect_uri!,
      codeChallenge: q.code_challenge!,
      ctx,
      scopes: scopeResult.scopes,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(q.redirect_uri!);
    url.searchParams.set("code", code);
    if (q.state) url.searchParams.set("state", q.state);
    return c.redirect(url.toString(), 302);
  });

  // --- token: authorization_code (PKCE) and refresh_token grants ---
  app.post("/oauth/token", async (c) => {
    const form = await c.req.parseBody();
    const grantType = String(form.grant_type ?? "");
    if (grantType === "authorization_code") return tokenFromCode(c, form);
    if (grantType === "refresh_token") return tokenFromRefresh(c, form);
    return json(c, { error: "unsupported_grant_type" }, 400);
  });

  // authorization_code → access token + refresh token (first issuance, at setup)
  async function tokenFromCode(
    c: Context,
    form: Awaited<ReturnType<Context["req"]["parseBody"]>>,
  ): Promise<Response> {
    const code = String(form.code ?? "");
    const verifier = String(form.code_verifier ?? "");
    const clientId = String(form.client_id ?? "");
    const redirectUri = String(form.redirect_uri ?? "");

    const entry = codes.get(code);
    codes.delete(code); // single-use, even on failure
    if (!entry || entry.expiresAt < Date.now()) {
      return json(c, { error: "invalid_grant" }, 400);
    }
    if (entry.clientId !== clientId || entry.redirectUri !== redirectUri) {
      return json(c, { error: "invalid_grant" }, 400);
    }
    // PKCE S256: base64url(sha256(verifier)) must equal the stored challenge.
    const expected = Buffer.from(entry.codeChallenge);
    const actual = Buffer.from(b64urlSha256(verifier));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return json(c, { error: "invalid_grant" }, 400);
    }

    const o = origin(c);
    const accessToken = await mintAccess(o, entry.ctx.actorId, entry.ctx.role, entry.scopes);
    const refreshToken = issueRefresh(entry.ctx.actorId, entry.clientId, entry.scopes);
    return json(c, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: entry.scopes.join(" "),
    });
  }

  // refresh_token → new access token + ROTATED refresh token (silent renewal).
  // Rotates (single-use) so a stolen-then-rotated token is dead on replay, and
  // RE-AUTHORIZES against the live account so a revoked member can't renew.
  async function tokenFromRefresh(
    c: Context,
    form: Awaited<ReturnType<Context["req"]["parseBody"]>>,
  ): Promise<Response> {
    const raw = String(form.refresh_token ?? "");
    const clientId = String(form.client_id ?? "");
    const rec = refresh.get(b64urlSha256(raw));
    if (rec) refresh.delete(rec.tokenHash); // rotation: consume on use, even on failure below
    if (!rec || rec.expiresAt <= Date.now()) {
      if (rec) persistRefresh();
      return json(c, { error: "invalid_grant" }, 400);
    }
    if (rec.clientId !== clientId) {
      persistRefresh();
      return json(c, { error: "invalid_grant" }, 400);
    }
    // Re-authorize against the account's CURRENT state (revoked / scope-reduced
    // members must not keep renewing). Reissue the intersection of the originally
    // granted scopes and what the account still holds.
    let ctx: AuthedContext;
    try {
      ctx = await validateActorById(opts.pool, rec.actorId);
    } catch {
      persistRefresh();
      return json(c, { error: "invalid_grant" }, 400);
    }
    const granted = new Set<Scope>(ctx.scopes);
    const scopes = rec.scopes.filter((s) => granted.has(s));
    if (scopes.length === 0) {
      persistRefresh();
      return json(c, { error: "invalid_grant" }, 400);
    }

    const o = origin(c);
    const accessToken = await mintAccess(o, rec.actorId, ctx.role, scopes);
    const refreshToken = issueRefresh(rec.actorId, rec.clientId, scopes); // slides the clock
    return json(c, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    });
  }
}

interface ValidParams {
  readonly ok: true;
  readonly params: Record<string, string>;
}
interface InvalidParams {
  readonly ok: false;
  readonly error: string;
}

/**
 * Validate the authorize request against the registered client. Redirect-uri is
 * exact-matched to a registered value (prevents open-redirect); PKCE S256 is
 * required (public client). Returns the sanitized params to carry into the form.
 */
function validateAuthorizeParams(
  clients: Map<string, RegisteredClient>,
  q: Record<string, string | undefined>,
): ValidParams | InvalidParams {
  const clientId = q.client_id ?? "";
  const redirectUri = q.redirect_uri ?? "";
  const client = clients.get(clientId);
  if (!client) return { ok: false, error: "unknown client_id" };
  if (!client.redirectUris.includes(redirectUri)) {
    return { ok: false, error: "redirect_uri not registered for this client" };
  }
  if ((q.response_type ?? "") !== "code") return { ok: false, error: "response_type must be code" };
  if (!q.code_challenge) return { ok: false, error: "code_challenge (PKCE) is required" };
  if ((q.code_challenge_method ?? "") !== "S256") {
    return { ok: false, error: "code_challenge_method must be S256" };
  }
  const params: Record<string, string> = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: q.code_challenge,
    code_challenge_method: "S256",
  };
  if (q.scope) params.scope = q.scope;
  if (q.state) params.state = q.state;
  return { ok: true, params };
}
