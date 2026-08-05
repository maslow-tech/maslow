import type { Migration } from "./types.js";

/**
 * Persist the authorization server's advertised scopes on the remote-MCP server
 * row, so the connect flow can send a `scope` parameter.
 *
 * PR2b shipped the OAuth client path WITHOUT ever sending `scope`:
 * `remoteAuthorizeUrl` takes an optional `scopes` argument, its one caller never
 * passed it, and `AsMetadata` did not even declare `scopes_supported` — so a
 * provider's advertised scopes were parsed nowhere and stored nowhere.
 *
 * An AS that requires a scope then rejects the authorize request. Robinhood
 * (`scopes_supported: ["internal"]`) does it SILENTLY: no error, no error param
 * — its authorize endpoint client-side-redirects to the agentic hub, so the
 * member is bounced back with no consent screen and nothing is logged anywhere.
 * Verified live 2026-07-22: the identical URL plus `&scope=internal` renders the
 * consent screen. This affected EVERY OAuth remote-MCP server whose AS requires
 * a scope, not just Robinhood.
 *
 * Endpoints (and now scopes) must come ONLY from stored discovery — the connect
 * flow never re-discovers (G2.6) — so this is a column, not a runtime fetch.
 *
 * Migration doctrine (runs on LIVE boxes): append-only; ADD COLUMN IF NOT EXISTS
 * is a no-op on a re-run. Nullable with no default and no backfill: NULL means
 * "registered before this shipped, scopes unknown", which the connect path
 * treats exactly as it does today (omit `scope`) — so an existing row keeps its
 * current behavior rather than gaining a guessed value. Re-registering the
 * server repopulates it from live discovery. No RLS (remote_mcp_server is
 * owner/registry state, not member content), no data rewrite, no credential
 * touched.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

-- jsonb (not text[]) to match as_host_allowlist on this same table — one shape
-- for "list of strings from discovery" so the store's row mapping stays uniform.
ALTER TABLE remote_mcp_server ADD COLUMN IF NOT EXISTS scopes jsonb;
`;

export const migration0050: Migration = {
  version: "0050",
  name: "remote-mcp-oauth-scopes",
  sql: SQL,
};
