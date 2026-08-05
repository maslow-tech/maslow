// The native connector OAuth connect flow (0022), ported from the proven
// maslow-tech module. Two halves around the user's trip to the provider's
// consent screen:
//   beginOAuth    — mint a CSRF state + a PKCE verifier/challenge, persist the
//                   single-use state row (bound to this account), and hand
//                   back what the authorize URL needs. The codeVerifier never
//                   leaves the box.
//   completeOAuth — validate + CONSUME the state (rejects unknown, replayed,
//                   or expired = CSRF / code-injection defense), run the
//                   provider's code exchange with the BOUND verifier (so a
//                   code can't be redeemed against a different flow's
//                   verifier), and store the tokens in the vault. It never
//                   throws — it returns a typed reason the callback route
//                   maps to a redirect.

import { createHash, randomBytes } from "node:crypto";
import { logEvt } from "../log.js";
import type { Pool } from "pg";
import type { TokenFingerprint, TokenVault } from "./vault.js";

const STATE_TTL_MS = 10 * 60_000;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A provider's code-exchange hook: authorization code + bound PKCE verifier
 *  in → tokens out. A provider PR adds one registry entry. */
export type ExchangeResult =
  | {
      ok: true;
      accessToken: string;
      /** the provider's opaque secret to encrypt + persist (e.g. MSAL's
       *  serialized token cache). Handed straight to the vault, never parsed. */
      secretBlob: string;
      expiresAt?: number;
      scopes?: string[];
    }
  | { ok: false };
export type ExchangeFn = (params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) => Promise<ExchangeResult>;

interface BeginResult {
  readonly state: string;
  /** challenge method is always S256 — callers hardcode it in the URL. */
  readonly codeChallenge: string;
}

/** The OAuth-provenance binding a remote-MCP connect carries from begin to
 *  callback (PR2b). Google/Microsoft omit it entirely (native, no provenance
 *  columns set). `issuer` arms the RFC 9207 `iss` check (G2.2); `resource` is
 *  the RFC 8707 audience already baked into the resource-bound exchange hook
 *  (G2.1); `fingerprint` is stamped onto the vault write (G5.1). */
interface OAuthBinding {
  readonly issuer: string;
  readonly resource: string;
  readonly fingerprint: TokenFingerprint;
}

/** Start a connect flow for (account, provider). The caller builds the
 *  provider's authorize URL around the returned state + challenge. Each begin
 *  also sweeps expired state rows, so abandoned flows never accumulate.
 *  `binding` (remote OAuth only) persists the issuer/resource/fingerprint so the
 *  callback can enforce G2.2 and stamp G5.1. */
export async function beginOAuth(
  pool: Pool,
  args: {
    accountId: string;
    provider: string;
    redirectUri: string;
    binding?: OAuthBinding;
  },
): Promise<BeginResult> {
  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const b = args.binding;
  await pool.query(
    `WITH sweep AS (
       DELETE FROM connector_oauth_state WHERE created_at < now() - interval '10 minutes'
     )
     INSERT INTO connector_oauth_state
       (state, account_id, provider, code_verifier, redirect_uri,
        issuer, resource, client_id, token_endpoint_host, server_url_host)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      state,
      args.accountId,
      args.provider,
      codeVerifier,
      args.redirectUri,
      b?.issuer ?? null,
      b?.resource ?? null,
      b?.fingerprint.clientId ?? null,
      b?.fingerprint.tokenEndpointHost ?? null,
      b?.fingerprint.serverUrlHost ?? null,
    ],
  );
  return { state, codeChallenge };
}

type CompleteResult =
  | { ok: true; accountId: string; provider: string }
  | {
      ok: false;
      reason:
        "unknown_state" | "expired_state" | "unknown_provider" | "exchange_failed" | "iss_mismatch";
    };

/** Finish a connect flow at the provider callback. Consumes the state row
 *  (single-use) whatever the outcome. `iss` (RFC 9207, present for a remote AS
 *  that returns it) MUST equal the issuer stored at begin — an AS mix-up on the
 *  callback is rejected before any token is stored (G2.2). */
export async function completeOAuth(
  pool: Pool,
  vault: TokenVault,
  exchangeRegistry: Record<string, ExchangeFn>,
  args: {
    state: string;
    code: string;
    iss?: string | undefined;
    /**
     * When a string, the atomic consume is tightened to
     * `state=$1 AND account_id=$2`, so a cross-member callback (the flow cookie
     * names a DIFFERENT account than the state row) matches NO row — the VICTIM's
     * legitimate state row is PRESERVED (no attacker-induced DoS) and the result
     * is the ordinary `unknown_state` (no oracle distinguishing mismatch from a
     * truly-unknown state). When null (observe/off), the WHERE is state-only,
     * identical to today.
     */
    expectedAccountId: string | null;
  },
): Promise<CompleteResult> {
  // Consume atomically: a replayed callback finds no row.
  const bind = args.expectedAccountId !== null;
  const r = await pool.query<{
    account_id: string;
    provider: string;
    code_verifier: string;
    redirect_uri: string;
    created_at: Date;
    issuer: string | null;
    client_id: string | null;
    token_endpoint_host: string | null;
    server_url_host: string | null;
  }>(
    `DELETE FROM connector_oauth_state WHERE state = $1${bind ? " AND account_id = $2" : ""}
       RETURNING account_id, provider, code_verifier, redirect_uri, created_at,
                 issuer, client_id, token_endpoint_host, server_url_host`,
    bind ? [args.state, args.expectedAccountId] : [args.state],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: "unknown_state" };
  if (Date.now() - row.created_at.getTime() > STATE_TTL_MS) {
    return { ok: false, reason: "expired_state" };
  }
  // G2.2 — RFC 9207 issuer binding. If this flow bound an issuer at begin, the
  // callback's `iss` must match it EXACTLY. A remote AS is required to return
  // `iss`; a mismatch (or a missing one) means an AS mix-up — reject, store
  // nothing. (Native Google/Microsoft rows carry a NULL issuer and skip this.)
  if (row.issuer !== null && args.iss !== row.issuer) {
    return { ok: false, reason: "iss_mismatch" };
  }
  // The account may have been revoked/suspended between begin and callback —
  // don't store tokens for an inactive account (they'd linger unusable).
  const acct = await pool.query("SELECT 1 FROM accounts WHERE id = $1 AND status = 'active'", [
    row.account_id,
  ]);
  if (acct.rowCount === 0) return { ok: false, reason: "unknown_state" };
  const exchange = exchangeRegistry[row.provider];
  if (!exchange) return { ok: false, reason: "unknown_provider" };

  let tokens: ExchangeResult;
  try {
    tokens = await exchange({
      code: args.code,
      codeVerifier: row.code_verifier,
      redirectUri: row.redirect_uri,
    });
  } catch {
    logEvt("connector_error", { provider: row.provider, op: "exchange", error: "threw" }, "warn");
    return { ok: false, reason: "exchange_failed" };
  }
  if (!tokens.ok) {
    logEvt("connector_error", { provider: row.provider, op: "exchange", error: "refused" }, "warn");
    return { ok: false, reason: "exchange_failed" };
  }

  // G5.1 — stamp the fingerprint carried from begin (NULL triple for native
  // providers; the client/endpoint/server-host triple for a remote OAuth flow).
  const fingerprint: TokenFingerprint = {
    clientId: row.client_id,
    tokenEndpointHost: row.token_endpoint_host,
    serverUrlHost: row.server_url_host,
  };
  await vault.putTokens({
    accountId: row.account_id,
    provider: row.provider,
    accessToken: tokens.accessToken,
    secretBlob: tokens.secretBlob,
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    scopes: tokens.scopes ?? [],
    fingerprint,
  });
  return { ok: true, accountId: row.account_id, provider: row.provider };
}
