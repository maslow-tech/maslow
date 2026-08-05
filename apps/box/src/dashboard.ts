import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { logEvt } from "./log.js";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Client, Pool } from "pg";
import { isBrainError, refusedError } from "@brain/shared";
import { getBrandingPublic, setBranding, type BrandingUpdate } from "./branding.js";
import { collabEvictions } from "./collab/rooms.js";
import { mintCollabTicket } from "./collab/types.js";
import {
  fsHttpError,
  lockRow,
  trashRow,
  versionNo,
  versionResponse,
  versionRow,
} from "./fs-http.js";
import {
  parseConfig,
  parseKind,
  parseName,
  parsePinned,
  parseScope,
  SavedViewsStore,
} from "./saved-views.js";
import {
  authenticate,
  GRAPH_FULL_MAX,
  normalizeFsPath,
  toolNames,
  VersionConflictError,
  type Admin,
  type FsCtx,
  type FsStore,
  type GraphFullFilters,
  type JwtVerifyOptions,
  type Reader,
  type Writer,
  type Scope,
} from "@brain/mcp-tools";
import {
  CONNECTOR_CATALOG,
  ConnectorConfigStore,
  CustomConnectorStore,
  GOOGLE_PROVIDER,
  TokenVault,
  validateDefinition,
  beginOAuth,
  completeOAuth,
  googleAuthorizeUrl,
  googleCreds,
  googleExchange,
  googleValidateClient,
  loadCreds,
  MICROSOFT_PROVIDER,
  microsoftAuthorizeUrl,
  microsoftCreds,
  microsoftExchange,
  microsoftValidateClient,
  type ExchangeFn,
} from "./connectors/index.js";

/**
 * The browser-facing surface of the box: cookie-session auth +
 * a JSON API. Served at the same origin as the app — never `/mcp` (which keeps
 * ignoring cookies and only trusts `Authorization: Bearer`).
 *
 * NOTE: the original user-facing UI (server-rendered pages, CSS, client JS) was
 * intentionally removed so a fresh design can be built against this API from
 * scratch — nothing here renders HTML. What remains is the security-critical
 * contract a new UI consumes:
 *   - Login exchanges an owner/member STATIC BEARER (posted once to /api/login
 *     over HTTPS) for a long-lived, HttpOnly + SameSite=Strict session cookie.
 *     The MCP write/DDL token is NEVER put in the browser: the cookie holds only
 *     {account id, role, expiry}, HMAC-signed with an env secret. The bearer is
 *     neither stored in the cookie nor echoed back.
 *   - /api/v1/* GETs are backed by the Reader ONLY (never the executor/DDL).
 *   - /api/v1/objects writes (POST/PATCH/DELETE) go through the SAME Writer the
 *     MCP tools use. Authorization is NOT the cookie: writeRoute re-reads the
 *     account's scopes from the DB per request and hands them to the Writer, so
 *     a viewer (scopes=['read']) is refused (403) and RLS scopes every write to
 *     what the member can see. Every write is CSRF-protected (double-submit).
 *   - /api/v1/admin/* (create/rotate/revoke members) go through Admin, are
 *     CSRF-protected (double-submit) and re-auth the OWNER scope server-side per
 *     route — a read/member cookie hitting an admin route gets 403.
 */

// ---------------------------------------------------------------- versioning
/** Stamps every /api response; a client can force a fail-safe reload on skew. */
// Injected by the release build (deploy/Dockerfile ARG → env). The old
// hardcoded const silently drifted (v0.2.2/v0.2.3 shipped reporting "0.2.1").
export const APP_VERSION = process.env.BRAIN_APP_VERSION ?? "dev";
const API_VERSION = "v1";

/** One tag on an object-page audience chip, pre-labeled for humans: org →
 *  "everyone", personal → the holder's name (+ `you` when it's the viewer),
 *  custom → its slug. The SPA renders labels; slugs ride along for tooling.
 *  `email` (personal tags) lets the share sheet prefill people back into WHO —
 *  share REPLACES the audience, so the sheet must open showing the current
 *  state or a well-meaning edit silently evicts everyone not re-picked.
 *  `governor` marks the bare always-kept row so the sheet can exclude it. */
interface AudienceTagWire {
  slug: string;
  label: string;
  kind: string;
  you?: boolean;
  email?: string;
  governor?: boolean;
}

const SESSION_COOKIE = "brain_session";
const CSRF_COOKIE = "brain_csrf";
// Long-lived by design (product decision, 2026-07-08): sign in once, stay signed in.
// Safe because requireSession re-reads accounts.status on EVERY request, so a
// revoked/suspended member's cookie stops working immediately regardless of its
// expiry — the cookie's lifetime is convenience, the DB status is the authority.
// HttpOnly + SameSite=Strict + read-only scope bound the stolen-cookie blast
// radius; a member is cut off the instant an owner revokes them.
const DEFAULT_SESSION_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

export interface DashboardOptions {
  readonly reader: Reader;
  readonly admin: Admin;
  /** Shared with the MCP tool registry — dashboard writes use the SAME write
   *  path (scope gate, RLS, versioning, provenance) as agent writes. */
  readonly writer: Writer;
  readonly pool: Pool;
  /** The ONE FsStore (same instance as bash + the bearer fs surface), so the
   *  dashboard file manager rides identical RLS/quota enforcement. */
  readonly fsStore: FsStore;
  /** HMAC secret that signs the session cookie (from an env secret in prod). */
  readonly sessionSecret: string;
  /** Set the `Secure` cookie flag (default true; tests disable it). */
  readonly secureCookies?: boolean;
  readonly sessionTtlSeconds?: number;
  readonly appVersion?: string;
  /** brain_owner box_kv handle (branding/favicon). A dedicated Pool in prod, the
   *  executor Client in tests. Optional so tests that don't exercise branding
   *  can omit it. Separate from the executor client so a rolled-back DDL txn
   *  can't discard a branding write (owner-vs-client race). */
  readonly ownerKv?: Pool | Client;
  /** If the box verifies OAuth JWTs, login accepts them too (else static bearer). */
  readonly jwt?: JwtVerifyOptions;
  /** Connector-surface seam (tests): env for the vault key, and a fake
   *  exchange registry so the callback never talks to a real provider. */
  readonly connectors?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly exchangeRegistry?: Record<string, ExchangeFn>;
  };
  /**
   * Phase-2 seam: the set of objects that currently have a LIVE collab room.
   *
   * While a room is live it is the single authoritative writer for that
   * object's body and title, so a direct CAS `PATCH` of either field is
   * refused (409 `open_in_editor`) instead of being applied underneath the
   * room — otherwise a disconnected client (or curl) writes v7 while the room
   * holds a CRDT based on v6, and the room's next flush silently overwrites v7
   * with no conflict, no banner and no draft to recover from.
   *
   * Left unset in phase 1 (no rooms exist yet), which makes the check inert.
   * It never gates props/links/visibility patches — those stay on CAS.
   *
   * `has` must be a cheap in-memory lookup: it runs on every body/title patch.
   * It is asked only about ids the caller already named, and its answer is
   * never surfaced for an object the caller cannot see (the RLS-bound write
   * has to succeed first for anything to be revealed), so it cannot be used to
   * probe for the existence of a private object.
   */
  readonly liveRooms?: { has(objectId: string): boolean };
}

// ------------------------------------------------------------ session tokens
interface SessionPayload {
  readonly sub: string;
  readonly role: string;
  /** Always "read". This is NOT the write-authorization signal — writes
   *  re-read the account's real scopes from the DB per request (writeRoute).
   *  Kept minimal so a stolen cookie never carries standalone write authority. */
  readonly scope: "read";
  readonly iat: number;
  readonly exp: number;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign `<payload>.<hmac>`; the HMAC covers the payload segment only. */
function signSession(secret: string, payload: SessionPayload): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Verify signature (constant-time) + expiry; returns null on any tampering. */
function verifySession(secret: string, token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.sub !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp * 1000 <= Date.now()
  ) {
    return null;
  }
  return payload;
}

// ---- connector OAuth flow-binding cookie ------------------------------------
// Binds the PUBLIC /connect/callback to the member who began the flow, closing
// the cross-member token-capture path (Mallory begins → relays the consent URL
// → Alice authorizes with HER Google → tokens land under Mallory). The session
// cookie is SameSite=Strict and provably absent at the provider's cross-site 302
// back to the callback, so a dedicated SameSite=Lax, path=/connect cookie is the
// only thing that can carry per-flow identity across that redirect. It is
// domain-separated from the session cookie by an HMAC prefix, self-expiring, and
// single-use (read-and-cleared at the top of the callback).
const FLOW_COOKIE = "brain_connect_flow";
const FLOW_MAC_PREFIX = "connflow:v1:";

function signFlow(secret: string, accountId: string, ttlSec: number): string {
  const body = b64url(
    JSON.stringify({ sub: accountId, exp: Math.floor(Date.now() / 1000) + ttlSec }),
  );
  const sig = createHmac("sha256", secret)
    .update(FLOW_MAC_PREFIX + body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyFlow(secret: string, token: string | undefined): { sub: string } | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret)
    .update(FLOW_MAC_PREFIX + body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: { sub?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 <= Date.now()) return null;
  return { sub: payload.sub };
}

type FlowBindMode = "observe" | "enforce" | "off";
function flowBindMode(cEnv: NodeJS.ProcessEnv): FlowBindMode {
  const v = cEnv.BRAIN_CONNECT_FLOW_BIND;
  return v === "enforce" || v === "off" ? v : "observe";
}

// --------------------------------------------------------------- the router
export function mountDashboard(app: Hono, opts: DashboardOptions): void {
  const secure = opts.secureCookies ?? true;
  const ttl = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const version = opts.appVersion ?? APP_VERSION;
  const dash = new Hono();

  // ---- security headers (JSON API only) -----------------------------------
  // The /api surface serves only JSON, so it keeps the strict default-src 'none'
  // CSP. Scoped to /api/* (all dashboard routes live there) so it never touches
  // the dashboard SPA the box serves at the root, which needs its own CSP.
  const securityHeaders: MiddlewareHandler = async (c, next) => {
    await next();
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Brain-App-Version", version);
  };
  dash.use("/api/*", securityHeaders);
  // One line per state-changing dashboard call — method + route + status only
  // (URL params are slugs/uuids; bodies, which may hold pasted tokens or file
  // paths, are NEVER logged). Middleware, not per-route: future routes are
  // covered by construction.
  dash.use("/api/*", async (c, next) => {
    await next();
    const m = c.req.method;
    if (m !== "POST" && m !== "PUT" && m !== "DELETE") return;
    // Log the MATCHED ROUTE PATTERN, never the raw path: raw paths carry
    // caller-typed strings (an unmatched /api/<junk> 404 would let any
    // unauthenticated client write arbitrary text into the log, and a typo'd
    // param can carry a pasted token). Only-middleware matches (the 404
    // case) have no concrete route — skip them entirely.
    const route = c.req.matchedRoutes.at(-1)?.path ?? "";
    if (!route || route.includes("*")) return;
    if (route.endsWith("/api/login") || route.endsWith("/api/logout")) return;
    logEvt("dashboard_mutation", { method: m, path: route, status: c.res.status });
  });

  // ---- cookie helpers -----------------------------------------------------
  const setSessionCookie = (c: Context, payload: SessionPayload): string => {
    const token = signSession(opts.sessionSecret, payload);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, // the browser JS can never read it
      secure,
      sameSite: "Strict",
      path: "/",
      maxAge: ttl,
    });
    // Double-submit CSRF token: readable by JS, echoed as a header on writes.
    const csrf = randomBytes(24).toString("base64url");
    setCookie(c, CSRF_COOKIE, csrf, {
      httpOnly: false,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAge: ttl,
    });
    return csrf;
  };

  const clearCookies = (c: Context): void => {
    setCookie(c, SESSION_COOKIE, "", {
      httpOnly: true,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAge: 0,
    });
    setCookie(c, CSRF_COOKIE, "", {
      httpOnly: false,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAge: 0,
    });
    // Clear any in-flight connect-flow cookie too (hygiene: no cross-login
    // completion on a shared machine).
    setCookie(c, FLOW_COOKIE, "", {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/connect",
      maxAge: 0,
    });
  };

  // Set the flow-binding cookie at connect-begin (SameSite=Lax so it survives
  // the provider's cross-site 302 back to /connect/callback). Set regardless of
  // mode — harmless in observe/off.
  const setFlowCookie = (c: Context, accountId: string): void => {
    setCookie(c, FLOW_COOKIE, signFlow(opts.sessionSecret, accountId, 600), {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/connect",
      maxAge: 600,
    });
  };

  const session = (c: Context): SessionPayload | null =>
    verifySession(opts.sessionSecret, getCookie(c, SESSION_COOKIE));

  // ---- login / logout -----------------------------------------------------
  dash.post("/api/login", async (c) => {
    // Accept the bearer as JSON {token} or a form field (forgiving about
    // content-type). Over HTTPS it is posted ONCE, validated server-side, and
    // never persisted. The response is JSON either way — there is no UI to
    // redirect to (the old page-rendering surface was removed), so a redirect
    // would land on a 404; a rebuilt client drives navigation itself.
    const contentType = c.req.header("content-type") ?? "";
    let token = "";
    if (contentType.includes("application/json")) {
      const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
      token = typeof body.token === "string" ? body.token : "";
    } else {
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      token = typeof form["token"] === "string" ? (form["token"] as string) : "";
    }
    if (!token) return c.json({ error: "missing token" }, 400);

    let ctx;
    try {
      ctx = await authenticate(
        opts.pool,
        `Bearer ${token}`,
        opts.jwt ? { jwt: opts.jwt } : undefined,
      );
    } catch {
      logEvt("auth_rejected", { surface: "dashboard", reason: "bad_login" }, "warn");
      // Never leak whether the token existed; never echo it back.
      return c.json({ error: "invalid token" }, 401);
    }

    // Health check on login: a cheap DB round-trip so the operator sees
    // whether the box is healthy the moment they sign in. A failure does NOT
    // block login — it's reported in the response for the UI to surface.
    let health: { ok: boolean; checkedAt: string };
    try {
      await opts.pool.query("SELECT 1");
      health = { ok: true, checkedAt: new Date().toISOString() };
    } catch {
      health = { ok: false, checkedAt: new Date().toISOString() };
    }

    const now = Math.floor(Date.now() / 1000);
    const csrf = setSessionCookie(c, {
      sub: ctx.actorId,
      role: ctx.role,
      scope: "read",
      iat: now,
      exp: now + ttl,
    });
    // The response carries the CSRF token + role + health only — never the bearer.
    return c.json({ ok: true, role: ctx.role, csrfToken: csrf, appVersion: version, health });
  });

  dash.post("/api/logout", (c) => {
    clearCookies(c);
    return c.json({ ok: true });
  });

  // ---- read-only API (Reader only; requires a valid session cookie) -------
  // A valid signature is not enough: re-check accounts.status per request so
  // revocation cuts browser access IMMEDIATELY, not at cookie expiry. The MCP
  // bearer path (authenticate()) and the admin routes already re-check the DB
  // per request — without this, a revoked member's open tab kept reading for
  // up to the session TTL.
  const requireSession = async (c: Context): Promise<SessionPayload | Response> => {
    const s = session(c);
    if (!s) return c.json({ error: "unauthorized" }, 401);
    const { rows } = await opts.pool.query<{ status: string }>(
      "SELECT status FROM accounts WHERE id = $1",
      [s.sub],
    );
    if (rows[0]?.status !== "active") {
      clearCookies(c);
      return c.json({ error: "unauthorized" }, 401);
    }
    return s;
  };

  const readCtx = (s: SessionPayload) => ({ actorId: s.sub });

  const api = <T>(c: Context, fn: (s: SessionPayload) => Promise<T>) =>
    requireSession(c).then((s) => (s instanceof Response ? s : runApi(c, () => fn(s))));

  const validScopes: readonly Scope[] = ["read", "write", "schema-admin"];
  const parseScopes = (raw: unknown): Scope[] =>
    Array.isArray(raw) ? raw.filter((s): s is Scope => validScopes.includes(s as Scope)) : [];

  // Write gate for dashboard mutations — the ONE gate. Requires a valid session
  // + CSRF, then reads the account's REAL scopes AND status from the DB per
  // request (never the cookie's stale minted scope) and builds a WriteContext
  // from them — so a viewer (scopes=['read']) hits the Writer's own scope gate
  // → refusedError → 403, exactly as the MCP bearer path enforces.
  // Authorization is the DB scopes, NOT SessionPayload.scope (which stays
  // "read").
  //
  // `status` rides the SAME query as `scopes` deliberately. requireSession
  // already re-read it, but that was a separate round-trip: a revocation
  // landing between the two reads would let the write through on a
  // year-long cookie. One read, one decision — a non-active account is refused
  // here (403) rather than being handed to the Writer with live scopes.
  //
  // Every dashboard mutation goes through this — there is no second auth
  // helper. These are the widest-reaching mutations on the box (arbitrary
  // create/patch/delete/link over the member's whole visible brain), so they
  // are the last surface that should invent its own gate.
  const writeRoute = <T>(
    c: Context,
    fn: (ctx: { actorId: string; scopes: readonly Scope[] }) => Promise<T>,
  ) =>
    requireSession(c).then(async (s) => {
      if (s instanceof Response) return s;
      if (!csrfOk(c)) return c.json({ error: "csrf check failed" }, 403);
      const { rows } = await opts.pool.query<{ scopes: string[]; status: string }>(
        "SELECT scopes, status FROM accounts WHERE id = $1",
        [s.sub],
      );
      if (rows[0]?.status !== "active") {
        clearCookies(c);
        return c.json({ error: "forbidden" }, 403);
      }
      const scopes = parseScopes(rows[0].scopes);
      return runApi(c, () => fn({ actorId: s.sub, scopes }));
    });

  dash.get(`/api/${API_VERSION}/version`, (c) =>
    c.json({ appVersion: version, apiVersion: API_VERSION }),
  );

  // ---- branding (white-label) --------------------------------------------
  // Public GET: the login screen needs the name/favicon flag before anyone is
  // authenticated. Owner-only POST: set the name + favicon. Both no-op safely
  // when no ownerKv is wired (branding just reads as default).
  dash.get(`/api/${API_VERSION}/branding`, (c) =>
    runApi(c, async () =>
      opts.ownerKv ? getBrandingPublic(opts.ownerKv) : { name: null, hasFavicon: false },
    ),
  );
  dash.post(`/api/${API_VERSION}/branding`, (c) =>
    adminRoute(c, async () => {
      const owner = opts.ownerKv;
      if (!owner) throw badRequest("branding is not configurable on this box");
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const update: BrandingUpdate = {
        ...("name" in body ? { name: body.name as string | null } : {}),
        ...("faviconDataUrl" in body
          ? { faviconDataUrl: body.faviconDataUrl as string | null }
          : {}),
      };
      try {
        await setBranding(owner, update);
      } catch (e) {
        throw badRequest(e instanceof Error ? e.message : "invalid branding");
      }
      return getBrandingPublic(owner);
    }),
  );

  dash.get(`/api/${API_VERSION}/whoami`, (c) =>
    api(c, async (s) => ({ ...(await opts.reader.whoami(readCtx(s))), appVersion: version })),
  );
  dash.get(`/api/${API_VERSION}/members`, (c) => api(c, (s) => opts.reader.members(readCtx(s))));
  dash.get(`/api/${API_VERSION}/types`, (c) => api(c, (s) => opts.reader.listTypes(readCtx(s))));
  dash.get(`/api/${API_VERSION}/types/:name`, (c) =>
    api(c, (s) => opts.reader.describeType(readCtx(s), c.req.param("name"))),
  );
  // Tag governance: the object page renders the audience as LABELED rows
  // (OR of ANDs) — humans read "only you" / "everyone" / a person's name, not
  // `person-45a33741` (the raw-slug chips were unreadable in the field). Read
  // RLS-bound as the viewer — reader.get above already 404'd anything the
  // viewer can't see — and resolved against the org-readable tag + account
  // names. `you` is session-relative on purpose: the page is per-viewer.
  // undefined on a pre-0057 box.
  const audienceLabeled = async (
    actorId: string,
    objectId: string,
  ): Promise<AudienceTagWire[][] | undefined> => {
    const client = await opts.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      const has = await client.query<{ ok: boolean }>(
        "SELECT to_regclass('public.tags') IS NOT NULL AS ok",
      );
      if (has.rows[0]?.ok !== true) {
        await client.query("COMMIT");
        return undefined;
      }
      const r = await client.query<{
        audience: string[][];
        governor_id: string | null;
      }>(
        `SELECT audience, COALESCE(governed_by, created_by) AS governor_id
           FROM objects WHERE id = $1 AND deleted_at IS NULL`,
        [objectId],
      );
      const aud = r.rows[0]?.audience ?? [];
      const governorId = r.rows[0]?.governor_id ?? null;
      const ids = [...new Set(aud.flat())];
      const tagRows =
        ids.length > 0
          ? await client.query<{
              id: string;
              slug: string;
              kind: string;
              holder_id: string | null;
              holder_name: string | null;
              holder_email: string | null;
            }>(
              `SELECT t.id, t.slug, t.kind,
                      a.id AS holder_id, a.name AS holder_name, a.email AS holder_email
                 FROM tags t
                 LEFT JOIN account_tags h ON h.tag_id = t.id AND t.kind = 'personal'
                 LEFT JOIN accounts a ON a.id = h.account_id
                WHERE t.id = ANY($1)`,
              [ids],
            )
          : { rows: [] as never[] };
      await client.query("COMMIT");
      const byId = new Map(
        tagRows.rows.map((x) => {
          const wire: AudienceTagWire = {
            slug: x.slug,
            kind: x.kind,
            label:
              x.kind === "org"
                ? "everyone"
                : x.kind === "personal"
                  ? (x.holder_name ?? x.slug)
                  : x.slug,
            ...(x.kind === "personal" && x.holder_id === actorId ? { you: true } : {}),
            ...(x.kind === "personal" && x.holder_email ? { email: x.holder_email } : {}),
            ...(x.kind === "personal" && governorId !== null && x.holder_id === governorId
              ? { governor: true }
              : {}),
          };
          return [x.id, wire] as const;
        }),
      );
      return aud.map((row) =>
        row.map((t) => byId.get(t) ?? { slug: t, label: t, kind: "custom" as const }),
      );
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return undefined;
    } finally {
      client.release();
    }
  };
  dash.get(`/api/${API_VERSION}/objects/:id`, (c) =>
    api(c, async (s) => {
      const obj = await opts.reader.get(readCtx(s), c.req.param("id"));
      const audience = await audienceLabeled(s.sub, c.req.param("id"));
      return audience === undefined ? obj : { ...obj, audience };
    }),
  );
  dash.get(`/api/${API_VERSION}/list`, (c) =>
    api(c, (s) => {
      const type = c.req.query("type");
      if (!type) throw badRequest("type is required");
      return opts.reader.list(readCtx(s), type, parseListOpts(c));
    }),
  );
  dash.get(`/api/${API_VERSION}/search`, (c) =>
    api(c, (s) => {
      const q = c.req.query("q") ?? c.req.query("query") ?? "";
      const type = c.req.query("type");
      const limit = numParam(c.req.query("limit"));
      // Two-stage contract with the SPA: the default pass is lexical-only
      // (as-you-type latency — no embed round-trip, no edge walk); deep=1 is
      // the settle pass and runs the full hybrid stack.
      const deep = c.req.query("deep") === "1";
      return opts.reader.search(readCtx(s), q, {
        semantic: deep,
        graph: deep,
        rerank: deep,
        ...(type ? { type } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    }),
  );
  dash.get(`/api/${API_VERSION}/timeline`, (c) =>
    api(c, (s) =>
      opts.reader.recent(readCtx(s), {
        ...(numParam(c.req.query("limit")) !== undefined
          ? { limit: numParam(c.req.query("limit")) }
          : {}),
        ...(numParam(c.req.query("since_seq")) !== undefined
          ? { sinceSeq: numParam(c.req.query("since_seq")) }
          : {}),
      }),
    ),
  );

  // ---- the graph view's data path (phase 6) ------------------------------
  // The WHOLE visible brain, keyset-paged. The payload is `Reader.graphFull`'s
  // verbatim — `truncated` and `nextCursor` included — because both are load-
  // bearing in the UI: the client assembles pages behind a progress indicator
  // and must be able to say "showing the 5,000 most-connected of 41,208" out
  // loud. Silent sampling is the one thing this endpoint must never do.
  //
  // `/graph-sample` below stays exactly as it is: it is the home-page sample
  // AND the >GRAPH_FULL_MAX fallback shape, so it must not drift.
  dash.get(`/api/${API_VERSION}/graph`, (c) =>
    api(c, (s) => {
      const after = c.req.query("after");
      const watermark = c.req.query("watermark");
      const limit = numParam(c.req.query("limit"));
      const filters = parseGraphWhere(c.req.query("where"));
      // The client sets this when a small-device budget will cap the walk before
      // GRAPH_FULL_MAX: take the degree-ordered sample of the top `limit` nodes
      // instead of an arbitrary ascending-uuid slice that would drop the hubs.
      const sample = c.req.query("sample") === "1";
      return opts.reader.graphFull(readCtx(s), {
        ...(after ? { after } : {}),
        // Carried across pages so page 4 is served against page 1's snapshot;
        // the cursor also carries it, this is for a client that keeps it.
        ...(watermark ? { watermark } : {}),
        // graphFull clamps too — this is the route stating its own contract,
        // not trusting the layer below to keep it.
        ...(limit !== undefined ? { limit: Math.min(limit, GRAPH_FULL_MAX) } : {}),
        ...(filters ? { filters } : {}),
        ...(sample ? { sample: true } : {}),
      });
    }),
  );

  /**
   * The time scrubber's "what changed since T" — ids ONLY, and only ids the
   * viewer already has.
   *
   * The event feed has NO RLS (accepted ceiling, 0012: it carries "actor X
   * updated <uuid>" for objects the viewer cannot get). So the changed ids are
   * intersected with the viewer's VISIBLE node set — read out of `graphFull`,
   * i.e. computed by the same RLS-bound SQL that decides which nodes the graph
   * was given — and every count below is computed AFTER that intersection.
   * A raw changed-count, or a pulse keyed on a target id, would reveal
   * private-object activity and its uuid, defeating the visible-only-degree
   * work the graph read path does. No feed row reaches the client.
   *
   * Registered BEFORE `/graph/:id`: `changed` is a static segment that the
   * param route would otherwise swallow (the neighbors reader would then 400
   * on a non-uuid id).
   */
  dash.get(`/api/${API_VERSION}/graph/changed`, (c) =>
    api(c, async (s) => {
      const sinceRaw = c.req.query("since");
      if (sinceRaw === undefined || !Number.isFinite(Date.parse(sinceRaw))) {
        throw badRequest("since is required and must be an ISO-8601 timestamp");
      }
      const since = new Date(sinceRaw).toISOString();
      const filters = parseGraphWhere(c.req.query("where")) ?? {};
      const ctx = readCtx(s);

      // The scrubber can only NARROW what the view's filters already allow:
      // the window start is the later of the two bounds.
      const windowSince =
        filters.since !== undefined && filters.since > since ? filters.since : since;
      // Deliberately NOT paged: a page of the visible set would be a partial
      // intersection, so ids the viewer can see would silently stop pulsing.
      // The window is already narrow (it is the scrubber's), and past
      // GRAPH_FULL_MAX changed nodes `truncated` says so out loud. When that
      // cap DOES bite, the sample must keep the most recently UPDATED nodes,
      // not the best-connected: this is a "what changed since T" read, and a
      // degree-ordered sample would systematically drop exactly the fresh,
      // low-degree nodes the pulse exists to highlight.
      const visible = await opts.reader.graphFull(ctx, {
        filters: { ...filters, since: windowSince },
        sampleOrder: "recency",
      });
      const visibleIds = new Set(visible.nodes.map((n) => n.id));

      const feed = await opts.reader.activityFeed(ctx, { limit: GRAPH_CHANGED_FEED_SCAN });
      const ids: string[] = [];
      const seen = new Set<string>();
      const byKind: Record<string, number> = {};
      let oldestScanned: string | null = null;
      for (const row of feed) {
        const at = isoOrNull(row["at"]);
        if (at !== null && (oldestScanned === null || at < oldestScanned)) oldestScanned = at;
        const target = typeof row["target"] === "string" ? row["target"] : null;
        // THE intersection. Everything below it counts survivors only.
        if (target === null || !visibleIds.has(target)) continue;
        // A node that changed inside the window also has OLDER rows in the
        // feed; counting those would inflate the kind histogram.
        if (at !== null && at < since) continue;
        const kind = typeof row["kind"] === "string" ? row["kind"] : "unknown";
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        if (!seen.has(target)) {
          seen.add(target);
          ids.push(target);
        }
      }
      return {
        since,
        watermark: visible.watermark,
        // most-recent event first — the order the pulse plays in.
        ids,
        count: ids.length,
        byKind,
        // > GRAPH_FULL_MAX changed nodes: the visible set was sampled, so the
        // intersection is a subset. The UI says so rather than implying it
        // caught everything.
        truncated: visible.truncated,
        // The feed scan is capped as well: an older change inside the window
        // may not have been looked at.
        feedTruncated:
          feed.length >= GRAPH_CHANGED_FEED_SCAN && oldestScanned !== null && oldestScanned > since,
      };
    }),
  );

  dash.get(`/api/${API_VERSION}/graph/:id`, (c) =>
    api(c, (s) => {
      const rel = c.req.query("rel");
      const direction = c.req.query("direction") as "in" | "out" | "both" | undefined;
      return opts.reader.neighbors(readCtx(s), c.req.param("id"), {
        ...(rel ? { rel } : {}),
        ...(direction ? { direction } : {}),
      });
    }),
  );

  // ---- dashboard aggregates (Reader-only enrichments the SPA renders) -----
  dash.get(`/api/${API_VERSION}/stats`, (c) => api(c, (s) => opts.reader.stats(readCtx(s))));
  dash.get(`/api/${API_VERSION}/feed`, (c) =>
    api(c, (s) => {
      const limit = numParam(c.req.query("limit"));
      return opts.reader.activityFeed(readCtx(s), limit !== undefined ? { limit } : {});
    }),
  );
  dash.get(`/api/${API_VERSION}/recent-objects`, (c) =>
    api(c, (s) => {
      const limit = numParam(c.req.query("limit"));
      return opts.reader.recentObjects(readCtx(s), limit !== undefined ? { limit } : {});
    }),
  );
  dash.get(`/api/${API_VERSION}/objects/:id/history`, (c) =>
    api(c, (s) => opts.reader.history(readCtx(s), c.req.param("id"))),
  );
  dash.get(`/api/${API_VERSION}/untyped`, (c) =>
    api(c, (s) => {
      const limit = numParam(c.req.query("limit"));
      return opts.reader.untypedObjects(readCtx(s), limit !== undefined ? { limit } : {});
    }),
  );
  dash.get(`/api/${API_VERSION}/private`, (c) =>
    api(c, (s) => {
      const limit = numParam(c.req.query("limit"));
      return opts.reader.privateObjects(readCtx(s), limit !== undefined ? { limit } : {});
    }),
  );
  dash.get(`/api/${API_VERSION}/trash`, (c) =>
    api(c, (s) => {
      const limit = numParam(c.req.query("limit"));
      return opts.reader.deletedObjects(readCtx(s), limit !== undefined ? { limit } : {});
    }),
  );
  dash.get(`/api/${API_VERSION}/graph-sample`, (c) =>
    api(c, (s) => {
      const limit = numParam(c.req.query("limit"));
      return opts.reader.graphSample(readCtx(s), limit !== undefined ? { limit } : {});
    }),
  );

  // ---- object writes (Writer; CSRF + DB-scope gate) ----------------------
  // Humans mutate brain content from the dashboard through the SAME Writer the
  // MCP tools use — the actor is the logged-in member, provenance is stamped as
  // a dashboard edit (reason "dashboard"), history/versioning ride along, and
  // RLS scopes every write to what the member can see. Write scope is enforced
  // from the DB (writeRoute), not the cookie.
  dash.post(`/api/${API_VERSION}/objects`, (c) =>
    writeRoute(c, async (ctx) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      // Never silently coerce an invalid visibility to org (fail-open on privacy).
      if (b.visibility !== undefined && b.visibility !== "private" && b.visibility !== "org") {
        throw badRequest("visibility must be 'org' or 'private'");
      }
      // A create has no baseVersion to conflict on, so CAS cannot make it
      // retry-safe. The client mints ONE key per user intent (⌘N) and reuses it
      // across retries; a replay returns the original result and writes nothing.
      // Without it a lost response on the create makes a second object, which
      // surfaces to the user as "the UI creates ghost duplicates".
      const idempotencyKey = parseIdempotencyKey(b.idempotencyKey);
      return opts.writer.write(ctx, {
        ...(typeof b.type === "string" ? { type: b.type } : {}),
        ...(typeof b.title === "string" ? { title: b.title } : {}),
        ...(typeof b.body === "string" ? { body: b.body } : {}),
        ...(b.props && typeof b.props === "object"
          ? { props: b.props as Record<string, unknown> }
          : {}),
        ...(b.visibility === "private" || b.visibility === "org"
          ? { visibility: b.visibility }
          : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        reason: "dashboard",
        originToken: newOriginToken(),
      });
    }),
  );

  dash.patch(`/api/${API_VERSION}/objects/:id`, (c) =>
    writeRoute(c, async (ctx) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const id = c.req.param("id");
      // The save queue speaks `baseVersion`; the original dashboard client (and
      // the shipped tests) speak `version`. Both are accepted forever — renaming
      // a wire field is not worth breaking an open tab mid-deploy over.
      const raw = b.baseVersion !== undefined ? b.baseVersion : b.version;
      const baseVersion = Number(raw);
      // Version is required and must be numeric — the optimistic-concurrency
      // guard is a no-op without it, and list rows carry version as a string. (C3)
      if (raw === undefined || raw === null || !Number.isInteger(baseVersion)) {
        throw badRequest("a numeric `baseVersion` is required to edit (optimistic concurrency)");
      }
      // title: a string sets it, null clears it (nullable column); reject other types.
      if (b.title !== undefined && b.title !== null && typeof b.title !== "string") {
        throw badRequest("title must be a string or null");
      }
      if (b.body !== undefined && typeof b.body !== "string") {
        throw badRequest("body must be a string");
      }
      if (
        b.props !== undefined &&
        (typeof b.props !== "object" || b.props === null || Array.isArray(b.props))
      ) {
        throw badRequest("props must be an object");
      }
      if (b.visibility !== undefined && b.visibility !== "private" && b.visibility !== "org") {
        throw badRequest("visibility must be 'org' or 'private'");
      }
      // Edges are their own routes now (below) — they do not bump the version,
      // so they cannot ride a CAS patch's conflict semantics and they need
      // idempotency keys a field patch has no slot for. Refuse loudly rather
      // than silently dropping them from the patch.
      if (b.links !== undefined || b.unlinks !== undefined) {
        throw badRequest(
          "link edits moved to POST/DELETE /api/v1/objects/:id/links — they do not bump the version",
        );
      }

      // The live-room guard — exactly one authoritative writer. Only
      // body/title are room-owned; props, links and visibility stay on CAS and
      // are never blocked. Ordered AFTER the scope check and BEHIND an RLS-bound
      // read so it can never tell a caller that an object they cannot see —
      // or cannot write — is open in someone's editor.
      const touchesRoomFields = b.body !== undefined || b.title !== undefined;
      // `liveRooms` keys on the canonical lowercase room name while the URL id
      // is caller-supplied (Postgres matches uuids case-insensitively), so the
      // guard must normalize or an UPPERCASE-id PATCH slides straight past the
      // 409 and edits body/title underneath the live room.
      if (
        touchesRoomFields &&
        ctx.scopes.includes("write") &&
        opts.liveRooms?.has(id.toLowerCase())
      ) {
        // Throws not_found (→ 404) for an object this member cannot see.
        await opts.reader.get({ actorId: ctx.actorId }, id);
        throw new ApiError(409, {
          code: "conflict",
          reason: "open_in_editor",
          message: "this object is open in the collaborative editor",
          unblock: "open it in the editor and type there — the room owns body and title",
        });
      }

      return opts.writer.editFields(ctx, id, {
        baseVersion,
        ...(b.title !== undefined ? { title: b.title as string | null } : {}),
        ...(b.body !== undefined ? { body: b.body as string } : {}),
        // Passed through byte-for-byte: editFields patches only the supplied
        // keys and an explicit null DELETES that key, leaving its siblings
        // alone. Stripping nulls here would turn a delete into a no-op.
        ...(b.props !== undefined ? { props: b.props as Record<string, unknown> } : {}),
        ...(b.visibility === "private" || b.visibility === "org"
          ? { visibility: b.visibility }
          : {}),
        reason: "dashboard",
        originToken: newOriginToken(),
      });
    }),
  );

  // ---- link edits ---------------------------------------------------------
  // Deliberately NOT part of the field patch: an edge write does not bump
  // objects.version, so it can never lose a CAS and can never 409. That is
  // exactly why it carries an idempotencyKey instead — a lost response on a
  // retry would otherwise be indistinguishable from a fresh intent.
  //
  // Both routes ride the same writeRoute gate, so both are unreachable without
  // the CSRF header, and both resolve their endpoints under RLS inside the
  // Writer: an object the member cannot see reads as "does not exist" — the
  // same refusal a truly absent id gets, which is the property that matters.
  const linkArgs = async (c: Context) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.to !== "string" || !b.to) throw badRequest("`to` (an object id) is required");
    if (typeof b.rel !== "string" || !b.rel) throw badRequest("`rel` is required");
    return { to: b.to, rel: b.rel, idempotencyKey: parseIdempotencyKey(b.idempotencyKey) };
  };

  dash.post(`/api/${API_VERSION}/objects/:id/links`, (c) =>
    writeRoute(c, async (ctx) => {
      const { to, rel, idempotencyKey } = await linkArgs(c);
      return opts.writer.link(
        ctx,
        c.req.param("id"),
        rel,
        to,
        idempotencyKey !== undefined ? { idempotencyKey } : {},
      );
    }),
  );

  dash.delete(`/api/${API_VERSION}/objects/:id/links`, (c) =>
    writeRoute(c, async (ctx) => {
      const { to, rel, idempotencyKey } = await linkArgs(c);
      return opts.writer.unlink(
        ctx,
        c.req.param("id"),
        rel,
        to,
        idempotencyKey !== undefined ? { idempotencyKey } : {},
      );
    }),
  );

  // Trash (undo is the existing restore path). The Writer's UPDATE carries the
  // visibility predicate in its WHERE, so an object the member cannot see —
  // and a private object they merely share — comes back 404, never 403: a 403
  // would confirm the id exists.
  dash.delete(`/api/${API_VERSION}/objects/:id`, (c) =>
    writeRoute(c, (ctx) => opts.writer.softDelete(ctx, c.req.param("id"))),
  );

  // ---- owner member-admin (Admin; CSRF + server-side owner re-auth) -------
  // Order: valid session → CSRF double-submit → owner role re-read from the DB.
  // A read/member cookie can NEVER reach these (403), and no request without the
  // CSRF header/cookie pair is accepted (403), even for an owner.
  const requireOwnerWrite = async (c: Context): Promise<SessionPayload | Response> => {
    const s = session(c);
    if (!s) return c.json({ error: "unauthorized" }, 401);
    if (!csrfOk(c)) return c.json({ error: "csrf check failed" }, 403);
    // Re-auth scope server-side: trust the DB's current role, not the cookie.
    const { rows } = await opts.pool.query<{ role: string; status: string }>(
      "SELECT role, status FROM accounts WHERE id = $1",
      [s.sub],
    );
    const acc = rows[0];
    if (!acc || acc.status !== "active" || acc.role !== "owner") {
      return c.json({ error: "forbidden: owner scope required" }, 403);
    }
    return s;
  };

  const adminRoute = <T>(c: Context, fn: (s: SessionPayload) => Promise<T>) =>
    requireOwnerWrite(c).then((s) => (s instanceof Response ? s : runApi(c, () => fn(s))));

  dash.post(`/api/${API_VERSION}/admin/members`, (c) =>
    adminRoute(c, async (s) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        name?: unknown;
        email?: unknown;
        permission?: unknown;
      };
      if (typeof body.name !== "string" || body.name.trim() === "") {
        throw badRequest("name is required");
      }
      if (typeof body.email !== "string" || body.email.trim() === "") {
        throw badRequest("email is required");
      }
      if (
        body.permission !== "owner" &&
        body.permission !== "member" &&
        body.permission !== "viewer"
      ) {
        throw badRequest("permission must be one of owner, member, viewer");
      }
      return opts.admin.createUser(s.sub, {
        name: body.name,
        email: body.email,
        permission: body.permission,
      });
    }),
  );
  dash.post(`/api/${API_VERSION}/admin/members/:id/rotate`, (c) =>
    adminRoute(c, (s) => opts.admin.rotateToken(s.sub, c.req.param("id"))),
  );
  dash.post(`/api/${API_VERSION}/admin/members/:id/revoke`, (c) =>
    adminRoute(c, async (s) => {
      const id = c.req.param("id");
      await opts.admin.revokeAccount(s.sub, id);
      // Offboarding someone while their laptop is open on a doc is the exact
      // case a join-time-only check gets wrong: the session cookie and the MCP
      // token are dead the moment the row flips, but a websocket that is
      // ALREADY OPEN keeps streaming every keystroke the team types until
      // something closes it. Close it here, in the same breath as the write —
      // the ≤60s re-check (collab/authz.ts) is the floor, not the mechanism.
      //
      // Rooms stay up: everyone else in them still belongs there.
      collabEvictions.actor(id, "access_revoked");
      return { ok: true };
    }),
  );

  // ---- tag governance (wave 3): the Access page + share sheet API ---------
  // Reads are plain-session — the share sheet needs group names for every
  // member. Mutations are OWNER-only and call the SECURITY DEFINER governance
  // fns; these routes are their ONLY callers, by design: governance is
  // human-only, no MCP path exists.
  dash.get(`/api/${API_VERSION}/tags`, (c) =>
    api(c, async () => {
      const { rows } = await opts.pool.query<{
        slug: string;
        kind: "personal" | "org" | "custom";
        account_id: string | null;
        holders: string[];
      }>(
        `SELECT t.slug, t.kind, t.account_id,
                COALESCE(array_agg(at.account_id ORDER BY at.granted_at)
                         FILTER (WHERE at.account_id IS NOT NULL), '{}') AS holders
           FROM tags t
           LEFT JOIN account_tags at ON at.tag_id = t.id
          GROUP BY t.id
          ORDER BY CASE t.kind WHEN 'org' THEN 0 WHEN 'custom' THEN 1 ELSE 2 END, t.slug`,
      );
      return { tags: rows };
    }),
  );

  // The governance fns RAISE messages written to be shown (the owner gate,
  // personal-tags-not-assignable, the service-account rule) — surface P0001
  // verbatim; anything else stays generic (dash_api_error logs it).
  const tagGovernance = async (actorId: string, sql: string, params: unknown[]): Promise<void> => {
    const client = await opts.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      await client.query(sql, params);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      const err = e as { code?: string; message?: string };
      if (err.code === "P0001") throw badRequest(err.message ?? "not permitted");
      throw e;
    } finally {
      client.release();
    }
  };
  const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
  const ACCOUNT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  dash.post(`/api/${API_VERSION}/tags`, (c) =>
    adminRoute(c, async (s) => {
      const body = (await c.req.json().catch(() => ({}))) as { slug?: unknown };
      if (typeof body.slug !== "string" || !TAG_SLUG_RE.test(body.slug)) {
        throw badRequest("slug must be lowercase letters/digits/dashes (max 63 chars)");
      }
      await tagGovernance(s.sub, "SELECT brain_tag_create($1)", [body.slug]);
      return { ok: true };
    }),
  );
  const tagHolderRoute = (op: "grant" | "revoke") => (c: Context) =>
    adminRoute(c, async (s) => {
      const body = (await c.req.json().catch(() => ({}))) as { accountId?: unknown };
      if (typeof body.accountId !== "string" || !ACCOUNT_ID_RE.test(body.accountId)) {
        throw badRequest("accountId must be a member id (see /members)");
      }
      await tagGovernance(s.sub, `SELECT brain_tag_${op}($1, $2)`, [
        c.req.param("slug"),
        body.accountId,
      ]);
      return { ok: true };
    });
  dash.post(`/api/${API_VERSION}/tags/:slug/grant`, tagHolderRoute("grant"));
  dash.post(`/api/${API_VERSION}/tags/:slug/revoke`, tagHolderRoute("revoke"));

  // Share from the dashboard: a click on the share sheet IS the human
  // approval the doctrine asks agents for. Same Writer.share as the MCP tool —
  // creator-only + containment enforced there, never re-implemented here.
  dash.post(`/api/${API_VERSION}/objects/:id/share`, (c) =>
    writeRoute(c, async (ctx) => {
      const body = (await c.req.json().catch(() => ({}))) as {
        who?: unknown;
        require?: unknown;
        reason?: unknown;
      };
      const strs = (v: unknown): string[] | undefined =>
        Array.isArray(v) && v.every((x): x is string => typeof x === "string")
          ? (v as string[])
          : undefined;
      return opts.writer.share(ctx, c.req.param("id"), {
        who: strs(body.who),
        require: strs(body.require),
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
    }),
  );

  // ---- delayed owner removal (0058) ---------------------------------------
  // Reads are session-level on purpose: owner_removals is org-READABLE by
  // design (the fan-out announces the change anyway); mutations go through the
  // owner-asserted SECURITY DEFINER fns via adminRoute.
  dash.get(`/api/${API_VERSION}/owner-removals`, (c) =>
    api(c, async () => {
      const { rows } = await opts.pool.query(
        `SELECT r.id, r.target_id, a.name AS target_name, r.initiated_by,
                i.name AS initiated_by_name, r.effective_at, r.cancelled_at, r.executed_at
           FROM owner_removals r
           JOIN accounts a ON a.id = r.target_id
           LEFT JOIN accounts i ON i.id = r.initiated_by
          ORDER BY r.created_at DESC LIMIT 20`,
      );
      return { removals: rows };
    }),
  );
  // Owner-removal notice: the notification channel was removed with the
  // teammate; the Members-page banner + the org-readable removal ledger remain
  // the signal. Kept as a content-free log line (no names, no text) so the
  // governance event still leaves a trace in docker logs.
  const notifyOwners = (kind: "initiated" | "cancelled"): void => {
    logEvt("owner_removal_notice", { kind });
  };
  dash.post(`/api/${API_VERSION}/owners/:id/removal`, (c) =>
    adminRoute(c, async (s) => {
      const target = c.req.param("id");
      if (!ACCOUNT_ID_RE.test(target)) throw badRequest("target must be a member id");
      await tagGovernance(s.sub, "SELECT brain_owner_removal_initiate($1)", [target]);
      notifyOwners("initiated");
      return { ok: true };
    }),
  );
  dash.post(`/api/${API_VERSION}/owner-removals/:id/cancel`, (c) =>
    adminRoute(c, async (s) => {
      await tagGovernance(s.sub, "SELECT brain_owner_removal_cancel($1)", [c.req.param("id")]);
      notifyOwners("cancelled");
      return { ok: true };
    }),
  );

  // ---- connectors (enable = owner supplies a credential; stored encrypted) --
  const cEnv = opts.connectors?.env ?? process.env;
  const configStore = new ConnectorConfigStore(opts.pool, cEnv);
  const customStore = new CustomConnectorStore(opts.pool);
  const vault = new TokenVault(opts.pool, {}, cEnv);

  /** Effective google OAuth-client creds: the owner-stored config row. */
  const googleAppCreds = () => loadCreds(configStore, GOOGLE_PROVIDER, googleCreds);
  /** Effective Microsoft app creds: the owner-stored config row. */
  const microsoftAppCreds = () => loadCreds(configStore, MICROSOFT_PROVIDER, microsoftCreds);

  /** Where the provider sends the browser back: derived from the box's public
   *  domain, BRAIN_CONNECT_REDIRECT_URI as the (dev) fallback. */
  const callbackUri = (): string | null =>
    cEnv.BRAIN_DOMAIN
      ? `https://${cEnv.BRAIN_DOMAIN}/connect/callback`
      : (cEnv.BRAIN_CONNECT_REDIRECT_URI ?? null);

  /** Member-level write gate: valid session + CSRF (no owner requirement) —
   *  connecting/disconnecting YOUR OWN provider account is not an admin op. */
  const memberWrite = async (c: Context): Promise<SessionPayload | Response> => {
    const s = await requireSession(c);
    if (s instanceof Response) return s;
    if (!csrfOk(c)) return c.json({ error: "csrf check failed" }, 403);
    return s;
  };
  const memberRoute = <T>(c: Context, fn: (s: SessionPayload) => Promise<T>) =>
    memberWrite(c).then((s) => (s instanceof Response ? s : runApi(c, () => fn(s))));

  // Catalog + per-provider status for the CALLING account. `enabled` and
  // `connected` are cheap row-existence checks — never a decrypt or a network
  // call. `redirectUri` is surfaced so the owner can copy it into the
  // provider's console when registering the OAuth client.
  dash.get(`/api/${API_VERSION}/connectors`, (c) =>
    api(c, async (s) => {
      const isOwner = s.role === "owner";
      const configured = await configStore.listConfigured();
      const orgEnabled = new Set(
        configured.filter((r) => r.scope === "org").map((r) => r.provider),
      );
      const myPersonal = new Set(
        configured
          .filter((r) => r.scope === "personal" && r.ownerAccount === s.sub)
          .map((r) => r.provider),
      );

      // Custom connectors are self-adoptable (a member can bring their own key
      // for one whose owner-authored DEFINITION exists), so members now SEE
      // them to adopt — the approved reversal of "members see nothing
      // unconfigured". Auth-none connectors have no cred to adopt, so a member
      // only sees those once an owner enables them org-wide.
      const custom = (await customStore.list()).filter((d) => {
        const selfAdoptable = d.authKind !== "none";
        return isOwner || orgEnabled.has(d.slug) || selfAdoptable;
      });
      const customEntries = custom.map((d) => ({
        provider: d.slug,
        name: d.name,
        custom: true,
        selfAdoptable: d.authKind !== "none",
        fields:
          d.authKind === "none"
            ? []
            : [
                {
                  key: "value",
                  label: `${d.authName} (${d.authKind === "header" ? "header" : "query parameter"})`,
                  secret: true,
                },
              ],
        orgEnabled: orgEnabled.has(d.slug),
        myPersonalEnabled: myPersonal.has(d.slug),
        access: [
          {
            app: d.name,
            allows: `agents call ${d.baseUrl}${d.allowedPrefixes.length ? ` under ${d.allowedPrefixes.join(", ")}` : ""}`,
          },
        ],
        // The owner's edit surface: the full definition (never the secret).
        ...(isOwner
          ? {
              definition: {
                baseUrl: d.baseUrl,
                authKind: d.authKind,
                authName: d.authName,
                allowedPrefixes: d.allowedPrefixes,
                instructions: d.instructions,
                description: d.description,
              },
            }
          : {}),
      }));

      // Catalog providers (google/microsoft) are per-member OAuth; a personal
      // OAuth client isn't wired yet (PR1b), so they are NOT self-adoptable —
      // a member still sees them only once an owner enables the org app.
      const visible = CONNECTOR_CATALOG.filter(
        (entry) => isOwner || orgEnabled.has(entry.provider),
      );
      const catalogEntries = await Promise.all(
        visible.map(async (entry) => ({
          provider: entry.provider,
          name: entry.name,
          fields: entry.fields,
          selfAdoptable: false,
          orgEnabled: orgEnabled.has(entry.provider),
          myPersonalEnabled: myPersonal.has(entry.provider),
          // "What it can access" is member-facing (informed consent before
          // Connect); the setup guide is the owner's job, so only owners get it.
          access: entry.access,
          ...(entry.scopes ? { scopes: entry.scopes } : {}),
          ...(isOwner ? { setup: entry.setup } : {}),
          ...(entry.oauth
            ? {
                oauth: true,
                connected: await vault.hasTokens(s.sub, entry.provider),
                redirectUri: callbackUri(),
              }
            : {}),
        })),
      );
      return [...customEntries, ...catalogEntries];
    }),
  );

  /** Per-provider live credential check (see the anti-smurf gate below).
   *  A provider with no validator passes — but every catalog provider gets
   *  one. Custom connectors are exempt BY DECISION (product decision 2026-07-20): they
   *  have no bespoke validator, so enable stores as-is and call-time teaching
   *  errors carry the weight. */
  const validateConfig = (
    provider: string,
    fields: Record<string, string>,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (provider === MICROSOFT_PROVIDER) {
      const creds = microsoftCreds(fields);
      return creds
        ? microsoftValidateClient(creds)
        : Promise.resolve({
            ok: false,
            error: "clientId, clientSecret, and tenantId are required",
          });
    }
    if (provider === GOOGLE_PROVIDER) {
      const creds = googleCreds(fields);
      return creds
        ? googleValidateClient(creds)
        : Promise.resolve({ ok: false, error: "clientId and clientSecret are required" });
    }
    return Promise.resolve({ ok: true });
  };

  // Re-check the caller is an owner, from the DB (never the cookie). Throws a
  // 403-mapped refused error otherwise. Used by routes that gate PER-REQUEST
  // on scope rather than wrapping the whole handler in adminRoute.
  const assertOwner = async (accountId: string): Promise<void> => {
    const { rows } = await opts.pool.query<{ role: string; status: string }>(
      "SELECT role, status FROM accounts WHERE id = $1",
      [accountId],
    );
    const acc = rows[0];
    if (!acc || acc.status !== "active" || acc.role !== "owner") {
      throw refusedError(
        "only an owner can set an org-wide credential",
        "set it as a personal credential, or ask an owner",
      );
    }
  };

  // Enable / re-configure a connector credential. `scope` in the body picks
  // the tier: 'org' (owner-only, every member uses it) or 'personal' (the
  // CALLING member's own; owner_account is forced from the session, never a
  // client field). Stored values are never echoed back.
  dash.put(`/api/${API_VERSION}/connectors/:provider/config`, (c) =>
    memberRoute(c, async (s) => {
      const provider = c.req.param("provider");
      const entry = CONNECTOR_CATALOG.find((e) => e.provider === provider);
      if (!configStore.hasKey()) {
        throw badRequest("BRAIN_CONNECTOR_TOKEN_KEY is not configured on this box");
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const scope: "org" | "personal" = body.scope === "personal" ? "personal" : "org";
      if (scope === "org") await assertOwner(s.sub);
      // PR1: personal credentials are not yet wired for the per-member OAuth
      // providers (google/microsoft still auth every member against the org's
      // OAuth app). Personal API-key / custom connectors are fully supported.
      if (scope === "personal" && entry?.oauth) {
        throw badRequest(
          "a personal credential isn't available for this provider yet — it uses the org's OAuth app",
        );
      }
      const ref =
        scope === "personal" ? ({ scope, ownerAccount: s.sub } as const) : ({ scope } as const);

      if (!entry) {
        // Custom connector: enable = store the secret as `value` (or an empty
        // blob for auth "none"). No validator by decision — see validateConfig.
        const def = await customStore.get(provider);
        if (!def) throw badRequest("unknown connector");
        const fields: Record<string, string> = {};
        if (def.authKind !== "none") {
          const v = body["value"];
          if (typeof v !== "string" || v.trim() === "") throw badRequest("value is required");
          fields.value = v.trim();
        }
        await configStore.putConfig(def.slug, fields, s.sub, ref);
        return { ok: true, scope };
      }
      const fields: Record<string, string> = {};
      for (const f of entry.fields) {
        const v = body[f.key];
        if (typeof v !== "string" || v.trim() === "") throw badRequest(`${f.key} is required`);
        fields[f.key] = v.trim();
      }
      // Anti-smurf gate: prove the credential against the real provider BEFORE
      // storing — an enable flips tool visibility, so a made-up key must never
      // turn anything on. Validators fail closed on provider outage. Runs for
      // personal saves too (same provider probe, now member-triggerable).
      const checked = await validateConfig(entry.provider, fields);
      if (!checked.ok) throw badRequest(checked.error);
      await configStore.putConfig(entry.provider, fields, s.sub, ref);
      return { ok: true, scope };
    }),
  );

  // Re-scope a credential in place (org↔personal) — OWNER ONLY (flipping the
  // shared org credential is an admin act; a member only ever touches their
  // own via PUT/DELETE). Refuses to clobber an existing row at the target.
  dash.post(`/api/${API_VERSION}/connectors/:provider/config/rescope`, (c) =>
    adminRoute(c, async (s) => {
      const provider = c.req.param("provider");
      const body = (await c.req.json().catch(() => ({}))) as {
        to?: unknown;
        ownerAccount?: unknown;
      };
      const to = body.to === "personal" ? "personal" : body.to === "org" ? "org" : null;
      if (!to) throw badRequest("`to` must be 'org' or 'personal'");
      const from = to === "org" ? ({ scope: "personal" } as const) : ({ scope: "org" } as const);
      const owner = typeof body.ownerAccount === "string" ? body.ownerAccount : s.sub;
      const fromRef = to === "org" ? { scope: "personal" as const, ownerAccount: owner } : from;
      const toRef =
        to === "personal"
          ? { scope: "personal" as const, ownerAccount: owner }
          : { scope: "org" as const };
      const res = await configStore.rescope(provider, fromRef, toRef, s.sub, () =>
        opts.pool.connect(),
      );
      if (!res.ok) throw badRequest(res.error);
      return { ok: true, to };
    }),
  );

  // ---- custom connectors (owner-defined HTTP connectors, 0033) -----------

  // Create or update a definition — OWNER ONLY. Optionally enables it in the
  // same call when a `secret` is supplied (or the connector needs none).
  dash.post(`/api/${API_VERSION}/connectors/custom`, (c) =>
    adminRoute(c, async (s) => {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const str = (k: string): string => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
      const def = {
        slug: str("slug"),
        name: str("name") || str("slug"),
        baseUrl: str("baseUrl"),
        authKind: (["header", "query", "none"] as const).find((k) => k === b.authKind) ?? "none",
        authName: str("authName") || null,
        allowedPrefixes: Array.isArray(b.allowedPrefixes)
          ? b.allowedPrefixes.filter((p): p is string => typeof p === "string" && p.trim() !== "")
          : [],
        instructions: str("instructions"),
        description: str("description"),
      };
      // The catalog and every static tool name are reserved: a custom slug
      // must never shadow a built-in surface.
      const reserved = new Set<string>([
        ...CONNECTOR_CATALOG.map((e) => e.provider),
        ...toolNames().map((t) => t.replace(/_fetch$/, "")),
      ]);
      const problem = validateDefinition({ ...def, reservedSlugs: reserved });
      if (problem) throw badRequest(problem);
      await customStore.upsert(def, s.sub);
      const secret = str("secret");
      if (def.authKind === "none") {
        await configStore.putConfig(def.slug, {}, s.sub);
      } else if (secret !== "") {
        if (!configStore.hasKey()) {
          throw badRequest("BRAIN_CONNECTOR_TOKEN_KEY is not configured on this box");
        }
        await configStore.putConfig(def.slug, { value: secret }, s.sub);
      }
      return { ok: true, slug: def.slug };
    }),
  );

  // Delete a custom connector — OWNER ONLY: definition + org credential.
  dash.delete(`/api/${API_VERSION}/connectors/custom/:slug`, (c) =>
    adminRoute(c, async () => {
      const slug = c.req.param("slug");
      await configStore.deleteConfig(slug);
      await customStore.delete(slug);
      return { ok: true };
    }),
  );

  // Disable a connector credential. `?scope=personal` removes the CALLING
  // member's own (any member); the org credential (default) is owner-only.
  dash.delete(`/api/${API_VERSION}/connectors/:provider/config`, (c) =>
    memberRoute(c, async (s) => {
      const provider = c.req.param("provider");
      if (c.req.query("scope") === "personal") {
        await configStore.deleteConfig(provider, { scope: "personal", ownerAccount: s.sub });
        return { ok: true, scope: "personal" };
      }
      await assertOwner(s.sub);
      await configStore.deleteConfig(provider);
      return { ok: true, scope: "org" };
    }),
  );

  // Start MY connect flow (any signed-in account): mint state + PKCE, hand the
  // browser the provider consent URL.
  dash.post(`/api/${API_VERSION}/connectors/:provider/connect`, (c) =>
    memberRoute(c, async (s) => {
      const provider = c.req.param("provider");
      if (provider !== GOOGLE_PROVIDER && provider !== MICROSOFT_PROVIDER) {
        throw badRequest("unknown connector");
      }
      const redirectUri = callbackUri();
      if (!redirectUri) {
        throw badRequest("BRAIN_DOMAIN / BRAIN_CONNECT_REDIRECT_URI is not configured");
      }
      // Read creds ONCE and close over them — re-reading after beginOAuth
      // would race a concurrent owner disable into a 200 {consentUrl: null}
      // plus an orphaned state row.
      const build = await (async (): Promise<
        ((state: string, codeChallenge: string) => string) | null
      > => {
        if (provider === GOOGLE_PROVIDER) {
          const creds = await googleAppCreds();
          return creds
            ? (state, codeChallenge) =>
                googleAuthorizeUrl(creds, { state, codeChallenge, redirectUri })
            : null;
        }
        const creds = await microsoftAppCreds();
        return creds
          ? (state, codeChallenge) =>
              microsoftAuthorizeUrl(creds, { state, codeChallenge, redirectUri })
          : null;
      })();
      if (!build) throw badRequest("connector is not enabled — an owner must configure it first");
      const begun = await beginOAuth(opts.pool, { accountId: s.sub, provider, redirectUri });
      setFlowCookie(c, s.sub); // bind the callback to this member
      return { consentUrl: build(begun.state, begun.codeChallenge) };
    }),
  );

  // Disconnect MY account from a provider.
  dash.delete(`/api/${API_VERSION}/connectors/:provider`, (c) =>
    memberRoute(c, async (s) => {
      await vault.deleteTokens(s.sub, c.req.param("provider"));
      return { ok: true };
    }),
  );

  // The provider callback — PUBLIC (no session: the single-use state row IS
  // the auth; completeOAuth validates + consumes it). Every outcome is a
  // redirect back to the connectors page; code/state/tokens are never echoed
  // into the response or a log.
  dash.get("/connect/callback", async (c) => {
    // Read the flow-binding cookie and IMMEDIATELY clear it (single-use on EVERY
    // exit path — success, error redirect, or thrown).
    const flow = verifyFlow(opts.sessionSecret, getCookie(c, FLOW_COOKIE));
    setCookie(c, FLOW_COOKIE, "", {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/connect",
      maxAge: 0,
    });
    const mode = flowBindMode(cEnv);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.redirect("/connectors?error=missing_params");
    // Enforce: a missing flow cookie means we cannot bind this callback to its
    // initiator — refuse WITHOUT calling completeOAuth (don't burn the state row).
    if (mode === "enforce" && !flow) {
      return c.redirect("/connectors?error=session_required");
    }
    const registry: Record<string, ExchangeFn> = { ...(opts.connectors?.exchangeRegistry ?? {}) };
    if (!opts.connectors?.exchangeRegistry) {
      const [g, m] = await Promise.all([googleAppCreds(), microsoftAppCreds()]);
      if (g) registry[GOOGLE_PROVIDER] = googleExchange(g);
      if (m) registry[MICROSOFT_PROVIDER] = microsoftExchange(m);
    }
    try {
      const done = await completeOAuth(opts.pool, vault, registry, {
        state,
        code,
        // Only ENFORCE binds the consume to the initiating member; observe/off
        // pass null so the atomic consume keeps its state-only WHERE (behavior
        // identical to today — the hole stays exactly as open as it already is).
        expectedAccountId: mode === "enforce" && flow ? flow.sub : null,
      });
      if (mode === "observe") {
        // Structured telemetry ONLY (never blocks): real member connects on the
        // real boxes prove the Lax cookie survives the provider's cross-site 302
        // — the one premise CI cannot test — before any box flips to enforce.
        console.info(
          "connect_flow_bind " +
            JSON.stringify({
              cookie_present: !!flow,
              matched: !!(flow && done.ok && flow.sub === done.accountId),
              provider: done.ok ? done.provider : null,
            }),
        );
      }
      return c.redirect(
        done.ok
          ? `/connectors?connected=${encodeURIComponent(done.provider)}`
          : `/connectors?error=${encodeURIComponent(done.reason)}`,
      );
    } catch {
      // e.g. the vault key is missing at store time — still a clean redirect.
      return c.redirect("/connectors?error=exchange_failed");
    }
  });

  // ---- files (the brain filesystem) ---------------------------------------
  // Cookie-authed mirror of the bearer fs surface (fs-http.ts): same ONE
  // FsStore, so RLS is the boundary and a foreign home is a uniform 404 here
  // too. Reads ride the session gate like every /api read; mutations add CSRF
  // (memberWrite) — dashboard sessions gaining file-WRITE powers is an accepted
  // doctrine widening (connectors precedent, spec trade-off #4). Distinct
  // /api/v1/files/* prefix: /api/v1/fs/* is claimed by the bearer routes,
  // which are registered first on the same app. The actor GUC is set inside
  // the store on EVERY op, downloads included — a viewer session maps to a
  // read-only FsCtx so the store refuses its writes with the teaching EROFS.
  // isOwner rides the ctx so an owner can clear another member's file lock
  // (the store's unlock/lock-takeover rule); it grants nothing else. It is the
  // only privileged bit in the FsCtx, so — exactly like requireOwnerWrite — it
  // comes from the DB's CURRENT role, re-read per request, NEVER
  // SessionPayload.role: that is a claim minted at login and the session TTL
  // is a year, so a demoted owner's open tab would otherwise keep
  // force-unlocking other members' files.
  // The same read decides readOnly (a demotion to viewer takes effect at once),
  // and a missing row fails closed to read-only.
  const fsSessionCtx = async (s: SessionPayload): Promise<FsCtx> => {
    const { rows } = await opts.pool.query<{ role: string }>(
      "SELECT role FROM accounts WHERE id = $1",
      [s.sub],
    );
    const role = rows[0]?.role ?? "viewer";
    return role === "viewer"
      ? { actorId: s.sub, readOnly: true }
      : { actorId: s.sub, ...(role === "owner" ? { isOwner: true } : {}) };
  };

  /** uuid → display name for the human surface (the bearer routes keep ids). */
  const displayNames = async (ids: string[]): Promise<Map<string, string>> => {
    const names = new Map<string, string>();
    const uniq = [...new Set(ids)];
    if (uniq.length === 0) return names;
    const { rows } = await opts.pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM accounts WHERE id = ANY($1)",
      [uniq],
    );
    for (const r of rows) names.set(r.id, r.name);
    return names;
  };

  // fs routes bypass runApi: their bodies/errors must match the bearer surface
  // byte-for-byte (uniform {error:"not found"} 404, 413 for cap/quota), which
  // fsHttpError produces and BrainError.toJSON does not.
  const fsRead = (c: Context, fn: (s: SessionPayload) => Promise<Response>) =>
    requireSession(c).then((s) =>
      s instanceof Response ? s : fn(s).catch((e: unknown) => fsHttpError(c, e)),
    );
  const fsWrite = (c: Context, fn: (s: SessionPayload) => Promise<Response>) =>
    memberWrite(c).then((s) =>
      s instanceof Response ? s : fn(s).catch((e: unknown) => fsHttpError(c, e)),
    );

  dash.get(`/api/${API_VERSION}/files/usage`, (c) =>
    fsRead(c, async (s) => {
      const u = await opts.fsStore.usage(await fsSessionCtx(s));
      return c.json({ total_bytes: u.totalBytes, quota_bytes: u.quotaBytes });
    }),
  );

  dash.get(`/api/${API_VERSION}/files/list`, (c) =>
    fsRead(c, async (s) => {
      const path = c.req.query("path");
      if (!path || path.trim() === "") {
        return c.json({ error: "path query param is required" }, 400);
      }
      const ctx = await fsSessionCtx(s);
      const entries = await opts.fsStore.list(ctx, path);
      // The dashboard is the human surface: resolve updated_by uuids to
      // display names (the bot/state precedent). The bearer surface keeps ids.
      const ids = [...new Set(entries.map((e) => e.updatedBy))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const { rows } = await opts.pool.query<{ id: string; name: string }>(
          "SELECT id, name FROM accounts WHERE id = ANY($1)",
          [ids],
        );
        for (const r of rows) names.set(r.id, r.name);
      }
      // Lock state RIDES the listing — the folder's own lock (it governs the
      // whole subtree) plus one per row. The file manager shows a lock on every
      // row, and one GET per row would be an N+1 against a 4-connection pool.
      // Same store, same ctx, so RLS scopes these exactly like the rows above.
      const locks = await opts.fsStore.lockInfoMany(ctx, [path, ...entries.map((e) => e.path)]);
      return c.json({
        lock: lockRow(locks.get(normalizeFsPath(path)) ?? null),
        entries: entries.map((e) => ({
          name: e.name,
          kind: e.kind,
          size: e.size,
          mtime: e.updatedAt.toISOString(),
          updated_by: names.get(e.updatedBy) ?? null,
          lock: lockRow(locks.get(e.path) ?? null),
        })),
      });
    }),
  );

  dash.get(`/api/${API_VERSION}/files/file`, (c) =>
    fsRead(c, async (s) => {
      const path = c.req.query("path");
      if (!path || path.trim() === "") {
        return c.json({ error: "path query param is required" }, 400);
      }
      const { meta, bytes } = await opts.fsStore.read(await fsSessionCtx(s), path);
      c.header("Content-Type", meta.mime ?? "application/octet-stream");
      c.header("Content-Length", String(bytes.length));
      c.header("Cache-Control", "private, no-store");
      c.header("X-Content-Type-Options", "nosniff");
      // attachment (not the bearer route's inline): the dashboard's Download
      // action means "save this", and never rendering fetched bytes in the
      // dashboard origin is the safer default anyway.
      c.header(
        "Content-Disposition",
        `attachment; filename="${meta.name.replace(/["\\\r\n]/g, "_")}"`,
      );
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      return c.body(ab);
    }),
  );

  dash.post(`/api/${API_VERSION}/files/upload`, (c) =>
    fsWrite(c, async (s) => {
      let path: string;
      let bytes: Buffer;
      let mime: string | undefined;
      try {
        const body = await c.req.parseBody();
        const f = body["file"];
        if (!(f instanceof File)) {
          return c.json({ error: "multipart upload needs a 'file' field" }, 400);
        }
        const p = body["path"];
        if (typeof p !== "string" || p.trim() === "") {
          return c.json({ error: "multipart upload needs a 'path' field (destination path)" }, 400);
        }
        // A directory destination (trailing slash) takes the uploaded file's
        // own name; otherwise `path` names the file itself (fs-http rule).
        path = p.endsWith("/") ? `${p}${f.name.replace(/[/\\]/g, "_")}` : p;
        bytes = Buffer.from(await f.arrayBuffer());
        mime = f.type || undefined;
      } catch {
        return c.json({ error: "could not read the upload body" }, 400);
      }
      const meta = await opts.fsStore.write(await fsSessionCtx(s), path, bytes, mime);
      return c.json({ path: meta.path, size: meta.size, sha256: meta.sha256, mime: meta.mime });
    }),
  );

  dash.post(`/api/${API_VERSION}/files/mkdir`, (c) =>
    fsWrite(c, async (s) => {
      const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
      if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
      await opts.fsStore.mkdir(await fsSessionCtx(s), body.path);
      return c.json({ ok: true });
    }),
  );

  dash.post(`/api/${API_VERSION}/files/rename`, (c) =>
    fsWrite(c, async (s) => {
      const body = (await c.req.json().catch(() => null)) as { from?: string; to?: string } | null;
      if (typeof body?.from !== "string" || typeof body?.to !== "string") {
        return c.json({ error: "from and to are required" }, 400);
      }
      await opts.fsStore.rename(await fsSessionCtx(s), body.from, body.to);
      return c.json({ ok: true });
    }),
  );

  dash.post(`/api/${API_VERSION}/files/delete`, (c) =>
    fsWrite(c, async (s) => {
      const body = (await c.req.json().catch(() => null)) as {
        path?: string;
        recursive?: boolean;
      } | null;
      if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
      const { removed, unrecoverable } = await opts.fsStore.rm(
        await fsSessionCtx(s),
        body.path,
        body.recursive === true,
      );
      return c.json({ removed, unrecoverable });
    }),
  );

  // ---- files · version control, locks, trash ------------------------------
  // The cookie mirror of the bearer /api/v1/fs/{history,version,restore,lock,
  // unlock,trash} routes, same ONE FsStore and the same JSON shapes — with
  // edited_by resolved to a display name, as the human surface does for
  // updated_by above. RLS on fs_versions scopes exactly like fs_entries, so a
  // foreign home's history and trash are simply empty here too.

  dash.get(`/api/${API_VERSION}/files/history`, (c) =>
    fsRead(c, async (s) => {
      const path = c.req.query("path");
      if (!path || path.trim() === "") {
        return c.json({ error: "path query param is required" }, 400);
      }
      const versions = await opts.fsStore.versionList(await fsSessionCtx(s), path);
      const names = await displayNames(versions.map((v) => v.edited_by));
      return c.json({
        versions: versions.map((v) => ({
          ...versionRow(v),
          edited_by: names.get(v.edited_by) ?? null,
        })),
      });
    }),
  );

  dash.get(`/api/${API_VERSION}/files/version`, (c) =>
    fsRead(c, async (s) => {
      const path = c.req.query("path");
      if (!path || path.trim() === "") {
        return c.json({ error: "path query param is required" }, 400);
      }
      const v = versionNo(c.req.query("v"));
      if (v === null) return c.json({ error: "v query param must be a version number" }, 400);
      return versionResponse(
        c,
        path,
        await opts.fsStore.versionContent(await fsSessionCtx(s), path, v),
      );
    }),
  );

  dash.post(`/api/${API_VERSION}/files/restore`, (c) =>
    fsWrite(c, async (s) => {
      const body = (await c.req.json().catch(() => null)) as {
        path?: string;
        version?: number;
      } | null;
      if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
      let version: number | undefined;
      if (body.version !== undefined && body.version !== null) {
        const v = versionNo(body.version);
        if (v === null) return c.json({ error: "version must be a version number" }, 400);
        version = v;
      }
      const res = await opts.fsStore.restore(await fsSessionCtx(s), body.path, version);
      return c.json({ ok: true, restored_from: res.restoredFrom, preserved: res.preserved });
    }),
  );

  dash.get(`/api/${API_VERSION}/files/lock`, (c) =>
    fsRead(c, async (s) => {
      const path = c.req.query("path");
      if (!path || path.trim() === "") {
        return c.json({ error: "path query param is required" }, 400);
      }
      return c.json(lockRow(await opts.fsStore.lockInfo(await fsSessionCtx(s), path)));
    }),
  );

  dash.post(`/api/${API_VERSION}/files/lock`, (c) =>
    fsWrite(c, async (s) => {
      const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
      if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
      const ctx = await fsSessionCtx(s);
      await opts.fsStore.lock(ctx, body.path);
      return c.json({ ok: true, ...lockRow(await opts.fsStore.lockInfo(ctx, body.path)) });
    }),
  );

  dash.post(`/api/${API_VERSION}/files/unlock`, (c) =>
    fsWrite(c, async (s) => {
      const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
      if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
      await opts.fsStore.unlock(await fsSessionCtx(s), body.path);
      return c.json({ ok: true, ...lockRow(null) });
    }),
  );

  dash.get(`/api/${API_VERSION}/files/trash`, (c) =>
    fsRead(c, async (s) => {
      const prefix = c.req.query("prefix");
      const entries = await opts.fsStore.listTrash(
        await fsSessionCtx(s),
        prefix && prefix.trim() !== "" ? prefix : undefined,
      );
      const names = await displayNames(entries.map((e) => e.edited_by));
      return c.json({
        entries: entries.map((e) => ({
          ...trashRow(e),
          edited_by: names.get(e.edited_by) ?? null,
        })),
      });
    }),
  );

  // ---- saved views (per-member sidebar views; design phase 4) -------------
  //
  // A saved view is the member's OWN chrome: a named database view-config
  // (phase 3) or graph view (phase 6), pinnable to their sidebar. Rows live in
  // `saved_views` (migration 0054) behind FORCE RLS with the owner predicate as
  // USING *and* WITH CHECK, and every statement here runs through
  // SavedViewsStore, which sets a transaction-local `app.actor_id` under the
  // request-serving pool. A foreign id is therefore a uniform 404 sourced from
  // the RLS-bound statement itself — this layer never reads a row and then
  // compares `member_id` in JavaScript.
  //
  // MUTATIONS RIDE memberRoute (session + CSRF + active status), NOT writeRoute
  // — a DELIBERATE DEVIATION from "every dashboard mutation goes through the
  // one write gate", stated here so it is not read as an oversight. writeRoute
  // authorizes against the account's `write` SCOPE, which is authority over
  // BRAIN CONTENT; a saved view is not brain content and touches no object. A
  // VIEWER (scopes = ['read']) legitimately saves, pins and reorders their own
  // views — refusing them would break reading, not tighten anything, exactly
  // the reasoning the collab ticket below spells out. What still gates every
  // mutation: a valid session, the CSRF double-submit, an ACTIVE account
  // (requireSession re-reads `accounts.status` per request, so revocation cuts
  // this off immediately), and the RLS policy, which is the boundary.
  const savedViews = new SavedViewsStore(opts.pool);

  // `?kind=` filters database/graph. `?scope=<type>` filters to that type;
  // `?scope=` (present but empty) selects the GLOBAL views (scope IS NULL);
  // omitting it entirely returns every kind/scope, which is what the sidebar
  // wants.
  dash.get(`/api/${API_VERSION}/views`, (c) =>
    api(c, async (s) => {
      const kind = c.req.query("kind");
      const scope = c.req.query("scope");
      const views = await savedViews.list(s.sub, {
        ...(kind !== undefined ? { kind: parseKind(kind) } : {}),
        ...(scope !== undefined ? { scope: parseScope(scope) } : {}),
      });
      return { views };
    }),
  );

  dash.post(`/api/${API_VERSION}/views`, (c) =>
    memberRoute(c, async (s) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      // Field-by-field, never a spread of the parsed body: `member_id`,
      // `position`, `created_at` and friends are the server's to set.
      return savedViews.create(s.sub, {
        ...("kind" in body ? { kind: parseKind(body.kind) } : {}),
        ...("scope" in body ? { scope: parseScope(body.scope) } : {}),
        ...("pinned" in body ? { pinned: parsePinned(body.pinned) } : {}),
        name: parseName(body.name),
        config: parseConfig(body.config),
      });
    }),
  );

  // The reorder route is registered BEFORE /views/:id so `reorder` can never be
  // taken for a view id (it is not a uuid, so the store would 404 it anyway —
  // but ordering the routes is the check that does not depend on that).
  dash.post(`/api/${API_VERSION}/views/reorder`, (c) =>
    memberRoute(c, async (s) => {
      const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
      if (!Array.isArray(body.ids)) throw badRequest("ids must be an array of view ids");
      const views = await savedViews.reorder(s.sub, body.ids as string[]);
      return { views };
    }),
  );

  dash.patch(`/api/${API_VERSION}/views/:id`, (c) =>
    memberRoute(c, async (s) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      // `kind` and `scope` are not patchable (see SavedViewPatch): a view that
      // changes subject is a different view. Refused rather than ignored —
      // silently dropping them would let a client believe it moved one.
      if ("kind" in body || "scope" in body) {
        throw badRequest("kind and scope cannot be changed — save a new view instead");
      }
      const patch = {
        ...("name" in body ? { name: parseName(body.name) } : {}),
        ...("config" in body ? { config: parseConfig(body.config) } : {}),
        ...("pinned" in body ? { pinned: parsePinned(body.pinned) } : {}),
      };
      return savedViews.update(s.sub, c.req.param("id"), patch);
    }),
  );

  dash.delete(`/api/${API_VERSION}/views/:id`, (c) =>
    memberRoute(c, async (s) => {
      await savedViews.remove(s.sub, c.req.param("id"));
      return { ok: true };
    }),
  );

  // ---- collab ticket (the websocket's ONLY source of identity) ------------
  //
  // The `/dash/collab` upgrade path is not Hono: it inherits no session check,
  // no CSRF check and no security headers (see collab/server.ts). The
  // connection principal therefore cannot be asserted by the websocket client
  // and cannot be read from the cookie there — it is minted HERE, by an
  // authenticated, CSRF-protected HTTP request, and carried to the socket as a
  // short-lived signed ticket.
  //
  // GATED ON SESSION + CSRF + ACTIVE STATUS, NOT ON WRITE SCOPE. A viewer
  // (`scopes = ['read']`) legitimately holds a socket — they join rooms
  // READ-ONLY — so refusing them a ticket would break reading, not tighten
  // anything. The write gate is a separate, later check on the connection
  // itself (collab/auth.ts `connectionMode`, from the CURRENT DB scopes), and
  // the per-room join gate is a third (an RLS-bound read as the joiner). None
  // of the three substitutes for another.
  //
  // The ticket carries the account's scopes as they are AT MINT TIME, purely as
  // a hint for logging and the initial UI state; the socket re-reads
  // `accounts.scopes`/`status` from the database at join and every ≤60s, so a
  // demotion or revocation lands on a socket that is already open.
  //
  // TTL is 30s (the module cap is 120s) because the ticket rides in the
  // websocket URL's query string — browsers cannot set headers on
  // `new WebSocket(...)` — and so lands in proxy access logs. It is also
  // SINGLE-USE: the spent `jti` is tracked in memory by collab/auth.ts, which
  // is sound only because the box is a single app process (one container, one
  // node) and MUST become DB-backed if that ever changes.
  const COLLAB_TICKET_TTL_SECONDS = 30;
  dash.post(`/api/${API_VERSION}/collab/ticket`, (c) =>
    memberRoute(c, async (s) => {
      // One read, one decision — the same reason writeRoute re-reads `status`
      // alongside `scopes`: a revocation landing between two round-trips must
      // not mint a ticket on a year-long cookie.
      const { rows } = await opts.pool.query<{ scopes: string[]; status: string; role: string }>(
        "SELECT scopes, status, role FROM accounts WHERE id = $1",
        [s.sub],
      );
      const acc = rows[0];
      if (!acc || acc.status !== "active") {
        clearCookies(c);
        throw new ApiError(403, { error: "forbidden" });
      }
      const { ticket } = mintCollabTicket(
        opts.sessionSecret,
        { actorId: s.sub, role: acc.role, scopes: parseScopes(acc.scopes) },
        { ttlSeconds: COLLAB_TICKET_TTL_SECONDS },
      );
      return { ticket, expiresInMs: COLLAB_TICKET_TTL_SECONDS * 1000 };
    }),
  );

  app.route("/", dash);
}

// ------------------------------------------------------------- API plumbing
class BadRequest extends Error {}
function badRequest(message: string): BadRequest {
  return new BadRequest(message);
}

/** A refusal that carries its own status + JSON body (the live-room 409). */
class ApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly payload: Record<string, unknown>,
  ) {
    super(String(payload.message ?? "error"));
    this.name = "ApiError";
  }
}

/**
 * Per-request origin token stamped on every dashboard write's audit event.
 *
 * The phase-2 collab bridge recognises its own flush writes from this value
 * and nothing else — recognising them by comparing content is the documented
 * cause of the echo loop. Random per request (not per session): two tabs of
 * the same member are two origins.
 */
function newOriginToken(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Client-minted idempotency key: one per user INTENT, reused across retries.
 * Bounded because it lands in a primary key — a caller must not be able to put
 * a megabyte in an index entry.
 */
function parseIdempotencyKey(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
    throw badRequest("idempotencyKey must be a string of 1–200 characters");
  }
  return raw;
}

async function runApi<T>(c: Context, fn: () => Promise<T>): Promise<Response> {
  try {
    const out = await fn();
    return c.json(out as Record<string, unknown>);
  } catch (e) {
    if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
    if (e instanceof ApiError) return c.json(e.payload, e.status);
    // A lost CAS answers with what the winner left behind, so the client can
    // rebase its changed fields instead of asking the user to retype them. The
    // snapshot was read INSIDE the losing transaction as the caller, so it is
    // RLS-bound and can only contain content this caller may already read. An
    // object the caller can no longer see never reaches here — the Writer
    // throws not_found (404) rather than a 409, because a 409 carries a
    // version and so would confirm both existence and rate of change.
    if (e instanceof VersionConflictError) {
      return c.json({ ...e.toJSON(), currentVersion: e.currentVersion, current: e.current }, 409);
    }
    if (isBrainError(e)) {
      const status =
        e.code === "not_found"
          ? 404
          : e.code === "refused"
            ? 403
            : e.code === "conflict"
              ? 409
              : 400;
      return c.json(e.toJSON(), status);
    }
    // An exception we don't recognize is a BUG, not a caller error. The BODY
    // stays generic (never leak internals to the browser), but it MUST leave a
    // trace: this silent catch once turned a plain check_violation
    // (register() writing auth_kind='oauth' against 0036's narrower CHECK) into
    // an "internal error" with literally nothing in the box logs to debug from.
    // Message + SQLSTATE only — deliberately NOT pg's `detail`, which echoes the
    // offending row's values.
    console.error(
      JSON.stringify({
        evt: "dash_api_error",
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        code: (e as { code?: unknown }).code ?? null,
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    return c.json({ error: "internal error" }, 500);
  }
}

function numParam(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** How far back `/graph/changed` scans the feed. Reader clamps at 200 too. */
const GRAPH_CHANGED_FEED_SCAN = 200;

/** Nesting cap on a graph `where`, matching the query AST's own. */
const GRAPH_WHERE_DEPTH_MAX = 8;

const GRAPH_WHERE_HELP =
  `the graph filters by type and recency: ` +
  `{"field":"type","op":"in","value":["deal","person"]} (null = untyped) and ` +
  `{"field":"updated_at","op":"gte","value":"2026-07-01T00:00:00Z"}, ` +
  `combined with {"and":[…]}`;

interface GraphWhereAcc {
  types?: Set<string | null>;
  since?: string;
  until?: string;
}

/**
 * The graph reuses the phase-3 filter language — the SAME `where` AST the
 * table/board/gallery build (`toListQuery`, apps/box/ui/src/lib/viewConfig.ts)
 * — instead of inventing a second one for the canvas.
 *
 * What it accepts is narrower than `/list`, because `Reader.graphFull` spans
 * EVERY type at once:
 *
 *   - `type`       eq / in / is_null → the node-type filter (`null` = untyped)
 *   - `updated_at` gte / gt          → `since` (the recency half)
 *   - `updated_at` lte / lt          → `until`
 *   - `{and:[…]}`  combines them; repeated terms INTERSECT (tightest wins)
 *
 * Anything else — `or`/`not`, `created_at`, and any PROPERTY filter — is
 * refused with a 400 naming the field. A property lives in its type's ext
 * table, and a graph over every type has no single table to resolve it
 * against, so honouring one needs a `graphFull` extension rather than route
 * plumbing. Silently DROPPING the term is the one thing that must not happen:
 * the viewer would be shown nodes they had filtered out, and every derived
 * number (degree, hubs, orphans, the changed count) would be computed over a
 * set that does not match the chips on screen.
 *
 * A strict bound (`gt`/`lt`) is honoured as inclusive — `graphFull`'s window is
 * closed. The difference is one instant on a timestamp, and erring wide keeps
 * a node visible rather than hiding one.
 */
function parseGraphWhere(raw: string | undefined): GraphFullFilters | undefined {
  if (raw === undefined || raw === "") return undefined;
  let node: unknown;
  try {
    node = JSON.parse(raw);
  } catch {
    throw badRequest("where must be valid JSON");
  }
  const acc: GraphWhereAcc = {};
  walkGraphWhere(node, acc, 0);
  const out: { types?: (string | null)[]; since?: string; until?: string } = {};
  if (acc.types !== undefined) out.types = [...acc.types];
  if (acc.since !== undefined) out.since = acc.since;
  if (acc.until !== undefined) out.until = acc.until;
  return Object.keys(out).length > 0 ? out : undefined;
}

function walkGraphWhere(node: unknown, acc: GraphWhereAcc, depth: number): void {
  if (depth > GRAPH_WHERE_DEPTH_MAX) throw badRequest("where is nested too deeply");
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    throw badRequest(`where must be a filter node — ${GRAPH_WHERE_HELP}`);
  }
  const n = node as Record<string, unknown>;
  if (Array.isArray(n["and"])) {
    for (const child of n["and"]) walkGraphWhere(child, acc, depth + 1);
    return;
  }
  if (n["or"] !== undefined || n["not"] !== undefined) {
    throw badRequest(`the graph filter combines terms with {"and":[…]} only — ${GRAPH_WHERE_HELP}`);
  }
  const field = n["field"];
  const op = n["op"];
  if (typeof field !== "string" || typeof op !== "string") {
    throw badRequest(`where must be a filter node — ${GRAPH_WHERE_HELP}`);
  }
  if (field === "type") return applyGraphTypeTerm(acc, op, n["value"]);
  if (field === "updated_at") return applyGraphRecencyTerm(acc, op, n["value"]);
  throw badRequest(
    `the graph cannot filter on "${field}" — ${GRAPH_WHERE_HELP}. ` +
      `Filter the type view for property filters.`,
  );
}

function applyGraphTypeTerm(acc: GraphWhereAcc, op: string, value: unknown): void {
  let term: Set<string | null>;
  if (op === "is_null") {
    term = new Set<string | null>([null]);
  } else if (op === "eq") {
    if (value === null) term = new Set<string | null>([null]);
    else if (typeof value === "string" && value !== "") term = new Set<string | null>([value]);
    else throw badRequest('a type "eq" filter takes a type name (or null for untyped)');
  } else if (op === "in") {
    if (!Array.isArray(value) || value.length === 0) {
      throw badRequest('a type "in" filter takes a non-empty array of type names');
    }
    term = new Set<string | null>();
    for (const t of value) {
      if (t === null) term.add(null);
      else if (typeof t === "string" && t !== "") term.add(t);
      else throw badRequest('a type "in" filter takes type names (or null for untyped)');
    }
  } else {
    throw badRequest(`the graph's type filter accepts eq, in and is_null — not "${op}"`);
  }
  acc.types = acc.types === undefined ? term : new Set([...acc.types].filter((t) => term.has(t)));
  // An empty list reads as "no type filter" downstream, so a contradiction has
  // to be refused here rather than quietly widening back to the whole brain.
  if (acc.types.size === 0) {
    throw badRequest("these type filters cannot all hold — nothing would match");
  }
}

function applyGraphRecencyTerm(acc: GraphWhereAcc, op: string, value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw badRequest("an updated_at filter takes an ISO-8601 timestamp");
  }
  // Normalized to UTC so the string compares below are ordering compares.
  const iso = new Date(value).toISOString();
  if (op === "gte" || op === "gt") {
    if (acc.since === undefined || iso > acc.since) acc.since = iso;
  } else if (op === "lte" || op === "lt") {
    if (acc.until === undefined || iso < acc.until) acc.until = iso;
  } else {
    throw badRequest(`the graph's updated_at filter accepts gt, gte, lt and lte — not "${op}"`);
  }
}

/** A pg timestamptz (Date) or an ISO string, as a comparable UTC ISO string. */
function isoOrNull(v: unknown): string | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

function parseListOpts(c: Context): Parameters<Reader["list"]>[2] {
  const out: Record<string, unknown> = {};
  const where = c.req.query("where");
  if (where) {
    try {
      out["where"] = JSON.parse(where);
    } catch {
      throw badRequest("where must be valid JSON");
    }
  }
  const sort = c.req.query("sort");
  if (sort) {
    try {
      out["sort"] = JSON.parse(sort);
    } catch {
      throw badRequest("sort must be valid JSON");
    }
  }
  const limit = numParam(c.req.query("limit"));
  if (limit !== undefined) out["limit"] = limit;
  const cursor = c.req.query("cursor");
  if (cursor) out["cursor"] = cursor;
  if (c.req.query("props") === "1") out["props"] = true;
  if (c.req.query("deleted") === "1") out["deleted"] = true;
  // The Reader compiles where/sort against a catalog whitelist (query-ast), so
  // untrusted JSON here can never reach SQL un-validated.
  return out as Parameters<Reader["list"]>[2];
}

// ------------------------------------------------------------- CSRF (double-submit)
function csrfOk(c: Context): boolean {
  const header = c.req.header("x-csrf-token");
  const cookie = getCookie(c, CSRF_COOKIE);
  if (!header || !cookie) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(cookie);
  return a.length === b.length && timingSafeEqual(a, b);
}
