import type { Migration } from "./types.js";

/**
 * Remote MCP connectors (unified integrations, PR2a). Two NEW tables — the box
 * gains the ability to proxy a third-party MCP server as one collapsed
 * `maslow_<slug>` tool:
 *
 *   remote_mcp_server      — the operator-registered server DEFINITION. Only
 *                            NON-secret metadata lives here (url, transport,
 *                            auth shape, scope, status). The bearer token itself
 *                            stays in connector_config (0024/0034), encrypted,
 *                            keyed by the same slug — so the credential + the
 *                            visibility story reuse the PR1 scoped store.
 *   remote_mcp_tools_cache — the tools/list snapshot vetted at registration and
 *                            rendered (sanitized, fenced) at call time.
 *
 * The as_host_allowlist / token_endpoint_host / issuer columns are reserved for
 * PR2b (OAuth discovery/provenance) and stay NULL in PR2a — carried on the row
 * now so the OAuth increment is a pure code change, not another migration.
 *
 * Migration doctrine (runs on LIVE boxes): append-only, guarded, NEVER throws on
 * box state. New tables only — no ALTER of a live credential row. CREATE TABLE
 * IF NOT EXISTS + IF NOT EXISTS indexes make a re-run a no-op; a box that
 * somehow already has these tables keeps them (RAISE NOTICE, never an error).
 * No RLS: reached only through the box's owner-gated RemoteMcpStore, same
 * posture as connector_config / custom_connectors.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS remote_mcp_server (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL UNIQUE COLLATE "C"
                         CHECK (slug ~ '^[a-z][a-z0-9_]{1,31}$'),
  name                 text NOT NULL,
  scope                text NOT NULL DEFAULT 'org' CHECK (scope IN ('org','personal')),
  owner_account        uuid REFERENCES accounts(id) ON DELETE CASCADE,
  url                  text NOT NULL,
  transport            text NOT NULL DEFAULT 'streamable-http'
                         CHECK (transport IN ('streamable-http','sse')),
  auth_kind            text NOT NULL DEFAULT 'none'
                         CHECK (auth_kind IN ('none','bearer','header')),
  auth_name            text,
  status               text NOT NULL DEFAULT 'enabled',
  -- reserved for PR2b (OAuth provenance) — NULL in PR2a
  as_host_allowlist    jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_endpoint_host  text,
  issuer               text,
  created_by           uuid REFERENCES accounts(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- org rows have no owner; personal rows are owned by exactly one member.
  CONSTRAINT remote_mcp_server_scope_owner_ck
    CHECK ((scope = 'org') = (owner_account IS NULL))
);

CREATE TABLE IF NOT EXISTS remote_mcp_tools_cache (
  server_id   uuid PRIMARY KEY REFERENCES remote_mcp_server(id) ON DELETE CASCADE,
  tools       jsonb NOT NULL DEFAULT '[]'::jsonb,
  etag        text,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON remote_mcp_server TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON remote_mcp_tools_cache TO brain_app;
`;

export const migration0036: Migration = {
  version: "0036",
  name: "remote-mcp",
  sql: SQL,
};
