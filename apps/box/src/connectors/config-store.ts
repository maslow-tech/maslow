// Connector credential storage (0023 + scoping 0034). A credential is a
// scoped, encrypted blob: `org` (owner-set, every member uses it) or
// `personal` (one member's own, usable only by them). Same AES-256-GCM under
// BRAIN_CONNECTOR_TOKEN_KEY as the token vault, key held outside the DB;
// plaintext never reaches the DB, the logs, or an error message.
//
// AAD binds each blob to its identity so a row can't be spliced elsewhere:
//   org      → `connector_config:<provider>`            (LEGACY — unchanged, so
//                                                         pre-0034 rows decrypt
//                                                         with zero re-encryption)
//   personal → `connector_config:<provider>:<account>`  (account-bound)

import type { Pool, PoolClient } from "pg";
import { logEvt } from "../log.js";
import { decrypt, encrypt, vaultKey } from "./crypto.js";

type ConnectorScope = "org" | "personal";

/** Identifies one credential row. Omitting `scope` means the org row. */
interface CredentialRef {
  readonly scope?: ConnectorScope;
  /** required (and only meaningful) when scope === 'personal'. */
  readonly ownerAccount?: string;
}

interface ConfiguredRow {
  readonly provider: string;
  readonly scope: ConnectorScope;
  readonly ownerAccount: string | null;
  readonly updated_at: Date;
}

/** The subset of pg's Pool/PoolClient this store needs — lets rescope() run
 *  the whole move inside one transaction on a single checked-out client. */
type Queryable = Pick<Pool, "query">;

export class ConnectorConfigStore {
  constructor(
    private readonly db: Queryable,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** true when BRAIN_CONNECTOR_TOKEN_KEY is usable (pre-check for enable). */
  hasKey(): boolean {
    try {
      vaultKey(this.env);
      return true;
    } catch {
      return false;
    }
  }

  /** AAD binds a config blob to (provider, scope[, account]). Org keeps the
   *  pre-scoping literal so every live row decrypts unchanged; personal is
   *  account-bound (anti-splice), mirroring the token vault's AAD. */
  private aad(provider: string, scope: ConnectorScope, ownerAccount?: string): string {
    return scope === "org"
      ? `connector_config:${provider}`
      : `connector_config:${provider}:${ownerAccount}`;
  }

  private norm(ref?: CredentialRef): { scope: ConnectorScope; owner: string | null } {
    const scope = ref?.scope ?? "org";
    if (scope === "personal") {
      if (!ref?.ownerAccount) throw new Error("personal credential requires ownerAccount");
      return { scope, owner: ref.ownerAccount };
    }
    return { scope: "org", owner: null };
  }

  /** Encrypt and persist a credential (enable / re-configure). Defaults to the
   *  org row; pass {scope:'personal', ownerAccount} for a member's own. */
  async putConfig(
    provider: string,
    creds: Record<string, string>,
    enabledBy: string,
    ref?: CredentialRef,
  ): Promise<void> {
    const { scope, owner } = this.norm(ref);
    const enc = encrypt(
      vaultKey(this.env),
      JSON.stringify(creds),
      this.aad(provider, scope, owner ?? undefined),
    );
    // Upsert onto the matching partial unique index (0034): org rows conflict
    // on (provider) WHERE scope='org'; personal on (provider, owner_account).
    const conflict =
      scope === "org"
        ? "(provider) WHERE scope = 'org'"
        : "(provider, owner_account) WHERE scope = 'personal'";
    await this.db.query(
      `INSERT INTO connector_config
         (provider, scope, owner_account, ciphertext, iv, auth_tag, enabled_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT ${conflict} DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
         enabled_by = EXCLUDED.enabled_by, updated_at = now()`,
      [provider, scope, owner, enc.ciphertext, enc.iv, enc.authTag, enabledBy],
    );
  }

  /** Decrypted credentials for a SPECIFIC row (defaults to the org row), or
   *  null when it isn't enabled OR won't decrypt (wrong/missing key) — the
   *  owner re-enters rather than the box throwing. */
  async getConfig(provider: string, ref?: CredentialRef): Promise<Record<string, string> | null> {
    const { scope, owner } = this.norm(ref);
    const r = await this.db.query<{ ciphertext: string; iv: string; auth_tag: string }>(
      owner === null
        ? "SELECT ciphertext, iv, auth_tag FROM connector_config WHERE provider = $1 AND scope = 'org'"
        : "SELECT ciphertext, iv, auth_tag FROM connector_config WHERE provider = $1 AND scope = 'personal' AND owner_account = $2",
      owner === null ? [provider] : [provider, owner],
    );
    const row = r.rows[0];
    if (!row) return null;
    try {
      return JSON.parse(
        decrypt(
          vaultKey(this.env),
          row.ciphertext,
          row.iv,
          row.auth_tag,
          this.aad(provider, scope, owner ?? undefined),
        ),
      ) as Record<string, string>;
    } catch {
      // a row EXISTS but won't decrypt — key/AAD mismatch, the
      // BRAIN_CONNECTOR_TOKEN_KEY incident class. Never silent.
      logEvt("connector_error", { provider, op: "decrypt", error: "decrypt_failed" }, "warn");
      return null;
    }
  }

  /** The credential that serves THIS caller's calls: personal-first — their
   *  own row wins, else the org row, else null. One choke point for the
   *  org-vs-personal resolution rule. Returns the decrypted creds plus which
   *  scope answered (callers that mint OAuth tokens need to know). */
  async getEffective(
    provider: string,
    accountId: string,
  ): Promise<{ creds: Record<string, string>; scope: ConnectorScope } | null> {
    const personal = await this.getConfig(provider, { scope: "personal", ownerAccount: accountId });
    if (personal) return { creds: personal, scope: "personal" };
    const org = await this.getConfig(provider);
    if (org) return { creds: org, scope: "org" };
    return null;
  }

  /** Disable a credential (defaults to the org row). Members' stored tokens
   *  are left alone. */
  async deleteConfig(provider: string, ref?: CredentialRef): Promise<void> {
    const { owner } = this.norm(ref);
    await this.db.query(
      owner === null
        ? "DELETE FROM connector_config WHERE provider = $1 AND scope = 'org'"
        : "DELETE FROM connector_config WHERE provider = $1 AND scope = 'personal' AND owner_account = $2",
      owner === null ? [provider] : [provider, owner],
    );
  }

  /** Re-scope a credential (org↔personal) IN PLACE: decrypt under the old AAD,
   *  re-encrypt under the new, one transaction. Refuses to clobber an existing
   *  row at the destination — no silent overwrite of a shared org credential. */
  async rescope(
    provider: string,
    from: CredentialRef,
    to: CredentialRef,
    enabledBy: string,
    connect: () => Promise<PoolClient>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const creds = await this.getConfig(provider, from);
    if (!creds) return { ok: false, error: "no such credential to re-scope" };
    if (await this.getConfig(provider, to)) {
      return { ok: false, error: "a credential already exists at that scope — delete it first" };
    }
    const client = await connect();
    try {
      await client.query("BEGIN");
      const txStore = new ConnectorConfigStore(client, this.env);
      await txStore.deleteConfig(provider, from);
      await txStore.putConfig(provider, creds, enabledBy, to);
      await client.query("COMMIT");
      return { ok: true };
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      logEvt("connector_error", { provider, op: "rescope", error: "tx_failed" }, "warn");
      return { ok: false, error: "re-scope failed" };
    } finally {
      client.release();
    }
  }

  /** Every configured credential row (no decrypt) — provider + scope + owner. */
  async listConfigured(): Promise<ConfiguredRow[]> {
    const r = await this.db.query<{
      provider: string;
      scope: ConnectorScope;
      owner_account: string | null;
      updated_at: Date;
    }>(
      "SELECT provider, scope, owner_account, updated_at FROM connector_config ORDER BY provider, scope",
    );
    return r.rows.map((x) => ({
      provider: x.provider,
      scope: x.scope,
      ownerAccount: x.owner_account,
      updated_at: x.updated_at,
    }));
  }

  /** ORG-enabled providers only (back-compat shape for callers that predate
   *  scoping and only care about the org tier). */
  async listProviders(): Promise<Array<{ provider: string; updated_at: Date }>> {
    const r = await this.db.query<{ provider: string; updated_at: Date }>(
      "SELECT provider, updated_at FROM connector_config WHERE scope = 'org' ORDER BY provider",
    );
    return r.rows;
  }

  /** Providers USABLE by this caller: every org credential + this caller's own
   *  personal ones. Row-only — the visibility gate reads this. */
  async configuredForCaller(accountId: string): Promise<Set<string>> {
    const r = await this.db.query<{ provider: string }>(
      `SELECT DISTINCT provider FROM connector_config
        WHERE scope = 'org' OR (scope = 'personal' AND owner_account = $1)`,
      [accountId],
    );
    return new Set(r.rows.map((x) => x.provider));
  }
}
