import type { Migration } from "./types.js";

/**
 * Remote-MCP OAuth (unified integrations, PR2b — the token-fingerprint + OAuth
 * provenance columns, gate table G5 / G2). The spec calls this "0037", but that
 * slot was taken by the filesystem migration when it merged first; append-only
 * doctrine (the ledger checksums applied migrations) means this takes the next
 * free slot, strictly after everything on main, so it can never apply out of
 * order on a live box. Pure column adds — no data rewrite, no live credential
 * row touched.
 *
 *   connector_secrets  gains the SERVE-TIME token fingerprint (G5.1): the clear,
 *     non-secret triple (client_id, token_endpoint_host, server_url_host) the
 *     vault checks on every getFreshAccessToken. Any change to any of the three
 *     forces reconnect and refuses to serve the old token (G5.2). Existing
 *     Google/Microsoft rows stay NULL — the legacy org-client shape (G5.3).
 *
 *   connector_oauth_state  gains the in-flight OAuth provenance carried from
 *     begin to callback: issuer (the AS we bound to — RFC 9207 iss is checked
 *     against it, G2.2), resource (the RFC 8707 audience — the canonical server
 *     URL, G2.1), and the same fingerprint triple so completeOAuth can stamp it
 *     onto the vault write (G5.1). NULL for Google/Microsoft flows (no change).
 *
 *   remote_mcp_server  gains the VETTED OAuth endpoints resolved once at
 *     configure time by discovery.ts (authorization/token/registration). They
 *     come ONLY from AS metadata (never a DCR response — G2.6); storing them
 *     means the connect/callback/refresh path never re-discovers. issuer and
 *     token_endpoint_host already exist (reserved by 0036).
 *
 * Migration doctrine (runs on LIVE boxes): append-only, guarded, NEVER throws on
 * box state. Every ADD COLUMN is IF NOT EXISTS, so a re-run is a no-op and a box
 * that somehow already has a column keeps it. No RLS, no ALTER of a secret value
 * — only clear columns are added.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

-- G5.1: the serve-time token fingerprint (clear, non-secret).
ALTER TABLE connector_secrets ADD COLUMN IF NOT EXISTS client_id           text;
ALTER TABLE connector_secrets ADD COLUMN IF NOT EXISTS token_endpoint_host text;
ALTER TABLE connector_secrets ADD COLUMN IF NOT EXISTS server_url_host     text;

-- G2.1/G2.2/G5.1: OAuth provenance carried begin -> callback.
ALTER TABLE connector_oauth_state ADD COLUMN IF NOT EXISTS issuer              text;
ALTER TABLE connector_oauth_state ADD COLUMN IF NOT EXISTS resource            text;
ALTER TABLE connector_oauth_state ADD COLUMN IF NOT EXISTS client_id           text;
ALTER TABLE connector_oauth_state ADD COLUMN IF NOT EXISTS token_endpoint_host text;
ALTER TABLE connector_oauth_state ADD COLUMN IF NOT EXISTS server_url_host     text;

-- G2.3/G2.6: the vetted OAuth endpoints, resolved once from AS metadata.
ALTER TABLE remote_mcp_server ADD COLUMN IF NOT EXISTS authorization_endpoint text;
ALTER TABLE remote_mcp_server ADD COLUMN IF NOT EXISTS token_endpoint         text;
ALTER TABLE remote_mcp_server ADD COLUMN IF NOT EXISTS registration_endpoint  text;

-- G2.5: per-member acknowledgment of an ORG server's third-party AS. Before a
-- member's first org-scope Connect the box-origin UI names the exact AS origin
-- ("sign in to <origin>, a server your admin added — not Maslow") and requires
-- an explicit ack, recorded here bound to the AS origin the member SAW. If the
-- org server is repointed to a different AS (G5.4), the stored as_origin no
-- longer matches and the member must acknowledge the new one before connecting.
CREATE TABLE IF NOT EXISTS remote_mcp_member_ack (
  slug        text NOT NULL COLLATE "C",
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_origin   text NOT NULL,
  acked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, account_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON remote_mcp_member_ack TO brain_app;
`;

export const migration0038: Migration = {
  version: "0038",
  name: "remote-mcp-oauth",
  sql: SQL,
};
