// The native connector TOKEN VAULT (0022): encrypt-at-rest storage +
// transparent refresh for OAuth secrets, ported from the proven maslow-tech
// module. Encryption is AES-256-GCM with BRAIN_CONNECTOR_TOKEN_KEY (base64 of
// 32 bytes), read from env and held OUTSIDE the database — a leaked DB row is
// useless on its own. The access token AND the provider's secret blob live
// only inside the ciphertext; only the (non-sensitive) expiry + scopes are
// stored clear, so the read path skips a decrypt while the token is valid.
//
// BRAIN_CONNECTOR_TOKEN_KEY is ESCROWED + NON-ROTATABLE by design: rotating
// it orphans every stored token and forces a mass re-auth — a key change is a
// deliberate "everyone reconnects" event. Custody is the customer's at
// install (their box, their vault), same trust model as the other box secrets.
//
// Plaintext tokens never reach the DB, the logs, or an error message. A
// decrypt failure or an expired-and-unrefreshable secret returns a typed
// `reauth_required` (never a thrown 500), so the agent surfaces a clean
// "reconnect" instead of leaking or crashing.

import type { Pool } from "pg";
import { logEvt } from "../log.js";
import { decrypt, encrypt, vaultKey } from "./crypto.js";

// Refresh a little before true expiry so an in-flight call doesn't race the clock.
const EXPIRY_SKEW_MS = 60_000;

type VaultPlaintext = { accessToken: string; secretBlob: string };

/** A provider's refresh hook: opaque secretBlob in → fresh tokens out. */
export type RefreshResult =
  | { ok: true; accessToken: string; secretBlob: string; expiresAt?: number; scopes?: string[] }
  | { ok: false };
export type RefreshFn = (secretBlob: string) => Promise<RefreshResult>;

// The versioned secret-blob format every OAuth connector hands the vault: a
// tiny JSON envelope holding the raw refresh token. Defined ONCE here (the
// vault owns the blob format) and imported by google.ts / microsoft.ts.
type SecretEnvelope = { v: 1; refreshToken: string };

export function packEnvelope(refreshToken: string): string {
  const env: SecretEnvelope = { v: 1, refreshToken };
  return JSON.stringify(env);
}

export function unpackEnvelope(secretBlob: string): SecretEnvelope | null {
  try {
    const e = JSON.parse(secretBlob) as Partial<SecretEnvelope>;
    if (e && e.v === 1 && typeof e.refreshToken === "string" && e.refreshToken !== "") {
      return { v: 1, refreshToken: e.refreshToken };
    }
  } catch {
    // not JSON / legacy shape — caller fails closed below
  }
  return null;
}

/** The clear, non-secret token fingerprint (G5.1): a stored token is bound to
 *  its exact (client_id, token_endpoint host, server_url host). Any change to
 *  any of the three invalidates the token at SERVE time (G5.2). Legacy
 *  Google/Microsoft rows carry an all-NULL fingerprint (the org-client shape,
 *  G5.3) and are served without a fingerprint check. */
export interface TokenFingerprint {
  readonly clientId: string | null;
  readonly tokenEndpointHost: string | null;
  readonly serverUrlHost: string | null;
}

const NULL_FP: TokenFingerprint = { clientId: null, tokenEndpointHost: null, serverUrlHost: null };
const isAllNull = (fp: TokenFingerprint): boolean =>
  fp.clientId === null && fp.tokenEndpointHost === null && fp.serverUrlHost === null;
const fpEqual = (a: TokenFingerprint, b: TokenFingerprint): boolean =>
  a.clientId === b.clientId &&
  a.tokenEndpointHost === b.tokenEndpointHost &&
  a.serverUrlHost === b.serverUrlHost;

/** The fingerprint THIS caller/server presents at serve time. `personal` marks a
 *  per-member (DCR'd) client so a NULL-stored row is never wildcarded by one
 *  (G5.3). */
export interface EffectiveFingerprint extends TokenFingerprint {
  readonly personal: boolean;
}

interface StoreArgs {
  readonly accountId: string;
  readonly provider: string;
  readonly accessToken: string;
  readonly secretBlob: string;
  /** epoch ms */
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
  /** G5.1: bind the token to its client + endpoint + server host. Omitted for
   *  legacy Google/Microsoft (stored NULL — the org-client shape). */
  readonly fingerprint?: TokenFingerprint;
}

type FreshToken =
  | { ok: true; accessToken: string; scopes: readonly string[] }
  | { ok: false; reason: "not_connected" | "reauth_required" };

export class TokenVault {
  constructor(
    private readonly pool: Pool,
    /** provider slug → refresh hook; a provider PR adds one entry. */
    private readonly refreshRegistry: Record<string, RefreshFn> = {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** AAD binds a token blob to its exact (table, account, provider) slot, so a
   *  DB-writer cannot splice one account's ciphertext into another's row. */
  private aad(accountId: string, provider: string): string {
    return `connector_secrets:${accountId}:${provider}`;
  }

  /** Encrypt and persist an account's tokens for one provider (initial
   *  connect, or after a refresh). Caller supplies plaintext; only ciphertext
   *  lands in the DB. */
  async putTokens(args: StoreArgs): Promise<void> {
    const plain: VaultPlaintext = { accessToken: args.accessToken, secretBlob: args.secretBlob };
    const enc = encrypt(
      vaultKey(this.env),
      JSON.stringify(plain),
      this.aad(args.accountId, args.provider),
    );
    const fp = args.fingerprint ?? NULL_FP;
    await this.pool.query(
      `INSERT INTO connector_secrets
         (account_id, provider, ciphertext, iv, auth_tag, expires_at, scopes,
          client_id, token_endpoint_host, server_url_host, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (account_id, provider) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
         expires_at = EXCLUDED.expires_at, scopes = EXCLUDED.scopes,
         client_id = EXCLUDED.client_id, token_endpoint_host = EXCLUDED.token_endpoint_host,
         server_url_host = EXCLUDED.server_url_host, updated_at = now()`,
      [
        args.accountId,
        args.provider,
        enc.ciphertext,
        enc.iv,
        enc.authTag,
        args.expiresAt !== undefined ? new Date(args.expiresAt) : null,
        args.scopes ?? [],
        fp.clientId,
        fp.tokenEndpointHost,
        fp.serverUrlHost,
      ],
    );
  }

  /** Return a valid access token for (account, provider), refreshing if
   *  expired. Never throws on a token problem — missing/corrupt/expired-and-
   *  unrefreshable returns a typed reason so the caller prompts a reconnect.
   *
   *  `effective` (remote OAuth only) enforces the G5 token fingerprint at SERVE
   *  time, not only on refresh (G5.2): a client/endpoint/server-host change
   *  invalidates the stored token immediately, even while unexpired — the old
   *  token is NEVER handed back. Google/Microsoft pass no `effective` (their
   *  rows are the legacy all-NULL org-client shape). */
  async getFreshAccessToken(
    accountId: string,
    provider: string,
    effective?: EffectiveFingerprint,
  ): Promise<FreshToken> {
    const r = await this.pool.query<{
      ciphertext: string;
      iv: string;
      auth_tag: string;
      expires_at: Date | null;
      scopes: string[];
      client_id: string | null;
      token_endpoint_host: string | null;
      server_url_host: string | null;
    }>(
      `SELECT ciphertext, iv, auth_tag, expires_at, scopes,
              client_id, token_endpoint_host, server_url_host
         FROM connector_secrets WHERE account_id = $1 AND provider = $2`,
      [accountId, provider],
    );
    const row = r.rows[0];
    if (!row) return { ok: false, reason: "not_connected" };

    const stored: TokenFingerprint = {
      clientId: row.client_id,
      tokenEndpointHost: row.token_endpoint_host,
      serverUrlHost: row.server_url_host,
    };

    // G5.2/G5.3 — the serve-time fingerprint gate, BEFORE any decrypt/serve, so
    // an unexpired token is still refused on mismatch (never handed back).
    if (effective) {
      if (isAllNull(stored)) {
        // A NULL-fingerprint (legacy) row may be served/refreshed only by the
        // legacy org client — a personal (DCR'd) client never wildcards it.
        if (effective.personal) return { ok: false, reason: "reauth_required" };
      } else if (!fpEqual(stored, effective)) {
        // Any client/endpoint/server-host change ⇒ reconnect, never the old token.
        return { ok: false, reason: "reauth_required" };
      }
    }

    let plain: VaultPlaintext;
    try {
      plain = JSON.parse(
        decrypt(
          vaultKey(this.env),
          row.ciphertext,
          row.iv,
          row.auth_tag,
          this.aad(accountId, provider),
        ),
      ) as VaultPlaintext;
    } catch {
      // Wrong key, tampered row, or AAD/slot mismatch — force a clean
      // reconnect, and SAY SO: a row that exists but won't decrypt is the
      // BRAIN_CONNECTOR_TOKEN_KEY incident class.
      logEvt("connector_error", { provider, op: "decrypt", error: "decrypt_failed" }, "warn");
      return { ok: false, reason: "reauth_required" };
    }
    // Shape guard: a spliced or wrong-shape blob must not surface as an "ok"
    // token carrying undefined — fail closed to a reconnect.
    if (typeof plain.accessToken !== "string" || typeof plain.secretBlob !== "string") {
      return { ok: false, reason: "reauth_required" };
    }

    const stillValid =
      row.expires_at !== null ? row.expires_at.getTime() - EXPIRY_SKEW_MS > Date.now() : true; // unknown expiry → assume usable; a real call 401s if not
    if (stillValid) return { ok: true, accessToken: plain.accessToken, scopes: row.scopes };

    const refresh = this.refreshRegistry[provider];
    if (!refresh) return { ok: false, reason: "reauth_required" };
    let result: RefreshResult;
    try {
      result = await refresh(plain.secretBlob);
    } catch {
      return { ok: false, reason: "reauth_required" };
    }
    if (!result.ok) return { ok: false, reason: "reauth_required" };

    await this.putTokens({
      accountId,
      provider,
      accessToken: result.accessToken,
      secretBlob: result.secretBlob,
      ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
      scopes: result.scopes ?? row.scopes,
      // Preserve the row's fingerprint across refresh (remote OAuth keeps its
      // binding; legacy rows stay all-NULL).
      fingerprint: stored,
    });
    return { ok: true, accessToken: result.accessToken, scopes: result.scopes ?? row.scopes };
  }

  /** Cheap connected-status check: row existence only — no decrypt, no
   *  refresh network call. A status page wants this, not getFreshAccessToken. */
  async hasTokens(accountId: string, provider: string): Promise<boolean> {
    const r = await this.pool.query(
      "SELECT 1 FROM connector_secrets WHERE account_id = $1 AND provider = $2",
      [accountId, provider],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Every provider this account has stored tokens for, in ONE query — the
   *  bulk form of hasTokens for a tools/list visibility sweep (test membership
   *  in-memory instead of N per-provider round-trips). Row existence only. */
  async connectedProviders(accountId: string): Promise<Set<string>> {
    const r = await this.pool.query<{ provider: string }>(
      "SELECT provider FROM connector_secrets WHERE account_id = $1",
      [accountId],
    );
    return new Set(r.rows.map((row) => row.provider));
  }

  /** Forget an account's tokens for one provider (disconnect). */
  async deleteTokens(accountId: string, provider: string): Promise<void> {
    await this.pool.query("DELETE FROM connector_secrets WHERE account_id = $1 AND provider = $2", [
      accountId,
      provider,
    ]);
  }
}
