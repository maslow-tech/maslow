import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import {
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWTPayload,
  type KeyLike,
} from "jose";
import { BrainError } from "@brain/shared";
import type { Scope } from "./write-path.js";

/**
 * The single MCP token validator. Two token shapes, one
 * outcome — an authenticated {actorId, scopes}:
 *   - Claude Code STATIC BEARER: an opaque, hashed, DB-backed token. Only its
 *     sha256 HASH ever reaches Postgres — never the token itself.
 *   - claude.ai/Desktop OAuth JWT: verified LOCALLY with a hard-pinned
 *     asymmetric alg (reject none/HS*), `aud` == the canonical /mcp URL, `exp`.
 * The token is never forwarded to Postgres in either path.
 */

const ASYMMETRIC_ALGS = ["ES256", "RS256", "EdDSA"] as const;

export interface AuthedContext {
  readonly actorId: string;
  readonly scopes: readonly Scope[];
  readonly role: string;
  /** per-call FLOW bag: tool internals drop metadata facts here (modes run,
   *  hit counts, exit codes — enums/booleans/counts ONLY, never content) and
   *  the box merges it into the mcp_call log line. Seeded by the HTTP layer;
   *  absent = nobody is collecting. Mutable by design. */
  flow?: Record<string, unknown>;
}

export class AuthError extends BrainError {
  readonly wwwAuthenticate: string;
  constructor(message: string, wwwAuthenticate = 'Bearer error="invalid_token"') {
    super("refused", message, { unblock: "present a valid, unexpired, in-scope token" });
    this.name = "AuthError";
    this.wwwAuthenticate = wwwAuthenticate;
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint an opaque static bearer token (returned once; only the hash is stored). */
export function generateToken(prefix = "brain_sk"): { token: string; hash: string } {
  const token = `${prefix}_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

function parseScopes(raw: unknown): Scope[] {
  const valid: Scope[] = ["read", "write", "schema-admin"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is Scope => valid.includes(s as Scope));
}

/** Static bearer path: resolve the token HASH to a live account. */
export async function validateStaticBearer(pool: Pool, token: string): Promise<AuthedContext> {
  const hash = hashToken(token);
  const { rows } = await pool.query<{
    id: string;
    role: string;
    scopes: string[];
    status: string;
    revoked_at: Date | null;
    expires_at: Date | null;
  }>(
    "SELECT id, role, scopes, status, revoked_at, expires_at FROM accounts WHERE token_hash = $1",
    [hash],
  );
  const acc = rows[0];
  if (!acc) throw new AuthError("unknown token");
  if (acc.status !== "active" || acc.revoked_at !== null) throw new AuthError("token revoked");
  if (acc.expires_at !== null && acc.expires_at.getTime() <= Date.now()) {
    throw new AuthError("token expired");
  }
  return {
    actorId: acc.id,
    scopes: parseScopes(acc.scopes),
    role: acc.role,
  };
}

/**
 * Re-check a live account by its id (not by token). Used by the OAuth refresh
 * grant to RE-AUTHORIZE against the account's CURRENT state before minting a new
 * access token: a member revoked (or with scopes reduced) after connecting must
 * not keep getting fresh tokens via their refresh token. Returns the account's
 * current scopes/role; throws if it is no longer usable.
 */
export async function validateActorById(pool: Pool, actorId: string): Promise<AuthedContext> {
  const { rows } = await pool.query<{
    id: string;
    role: string;
    scopes: string[];
    status: string;
    revoked_at: Date | null;
    expires_at: Date | null;
  }>("SELECT id, role, scopes, status, revoked_at, expires_at FROM accounts WHERE id = $1", [
    actorId,
  ]);
  const acc = rows[0];
  if (!acc) throw new AuthError("unknown account");
  if (acc.status !== "active" || acc.revoked_at !== null) throw new AuthError("account revoked");
  if (acc.expires_at !== null && acc.expires_at.getTime() <= Date.now()) {
    throw new AuthError("account expired");
  }
  return {
    actorId: acc.id,
    scopes: parseScopes(acc.scopes),
    role: acc.role,
  };
}

export interface JwtVerifyOptions {
  readonly publicKey: KeyLike | Uint8Array;
  /** the canonical /mcp URL this box answers on (RFC 8707 audience binding). */
  readonly canonicalAud: string;
}

/** OAuth JWT path: verify locally, alg-pinned + aud-bound. */
export async function validateJwt(token: string, opts: JwtVerifyOptions): Promise<AuthedContext> {
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(token, opts.publicKey, {
      algorithms: [...ASYMMETRIC_ALGS], // rejects "none" and HS* (alg confusion)
      audience: opts.canonicalAud,
    });
    payload = res.payload;
  } catch (e) {
    throw new AuthError(`invalid token: ${(e as Error).message}`);
  }
  if (typeof payload.sub !== "string") throw new AuthError("token has no subject");
  return {
    actorId: payload.sub,
    scopes: parseScopes(payload.scopes ?? payload.scope),
    role: typeof payload.role === "string" ? payload.role : "member",
  };
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

/** JS `\s` is exactly the set `String#trim` strips, so this is the regex class. */
function isSpace(ch: string): boolean {
  return ch.trim() === "";
}

/**
 * `Authorization: Bearer <token>` → the token, or null if the header is
 * malformed. Hand-rolled rather than `/^Bearer\s+(.+)$/i` because that pattern
 * backtracks polynomially on a long whitespace run (CodeQL js/polynomial-redos);
 * every accept/reject decision below mirrors it exactly, including that `.`
 * never matches a line terminator, so a token containing one stays malformed.
 */
export function parseBearerToken(header: string): string | null {
  const h = header.trim();
  if (h.slice(0, 6).toLowerCase() !== "bearer") return null;
  let i = 6;
  // the regex's `\s+`: at least one space, then all of them (greedy, and no
  // shorter split can match, since anything it gives back is still whitespace).
  if (i >= h.length || !isSpace(h[i]!)) return null;
  while (i < h.length && isSpace(h[i]!)) i++;
  const token = h.slice(i);
  // `(.+)$` on a trimmed header: non-empty, and no line terminator inside.
  if (token === "") return null;
  for (let k = 0; k < token.length; k++) {
    const c = token.charCodeAt(k);
    // LF, CR, U+2028, U+2029 are the only characters `.` refuses.
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) return null;
  }
  return token;
}

/**
 * The one front-door validator. `Authorization: Bearer <token>` → context.
 * JWTs are verified locally (needs `jwt`); everything else is a static bearer.
 */
export async function authenticate(
  pool: Pool,
  authorizationHeader: string | undefined,
  opts?: { jwt?: JwtVerifyOptions },
): Promise<AuthedContext> {
  if (!authorizationHeader) {
    throw new AuthError("missing Authorization header", 'Bearer realm="brain"');
  }
  const token = parseBearerToken(authorizationHeader);
  if (token === null) throw new AuthError("malformed Authorization header");
  if (looksLikeJwt(token) && opts?.jwt) return validateJwt(token, opts.jwt);
  return validateStaticBearer(pool, token);
}

export function requireScope(ctx: AuthedContext, scope: Scope): void {
  if (!ctx.scopes.includes(scope)) {
    throw new AuthError(
      `this token lacks the '${scope}' scope`,
      'Bearer error="insufficient_scope"',
    );
  }
}

// ---- test/dev helpers for the OAuth JWT path (KMS holds the key in prod) ----

export interface DevSigner {
  readonly publicKey: KeyLike;
  sign(payload: {
    sub: string;
    scopes: Scope[];
    role?: string;
    aud: string;
    expiresInSeconds?: number;
    alg?: string;
  }): Promise<string>;
}

/**
 * A local ES256 signer standing in for KMS. `now` is injected so tests can mint
 * already-expired tokens deterministically.
 */
export async function makeDevSigner(keypair: {
  privateKey: KeyLike;
  publicKey: KeyLike;
}): Promise<DevSigner> {
  return {
    publicKey: keypair.publicKey,
    async sign(p) {
      const iat = Math.floor(Date.now() / 1000);
      const jwt = new SignJWT({ scopes: p.scopes, role: p.role ?? "member" })
        .setProtectedHeader({ alg: p.alg ?? "ES256" })
        .setSubject(p.sub)
        .setAudience(p.aud)
        .setIssuedAt(iat)
        .setExpirationTime(iat + (p.expiresInSeconds ?? 600));
      return jwt.sign(keypair.privateKey);
    },
  };
}

export async function generateDevKeypair(): Promise<{ privateKey: KeyLike; publicKey: KeyLike }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return { privateKey: privateKey as KeyLike, publicKey: publicKey as KeyLike };
}

export { importJWK };
