import type { Migration } from "./types.js";

/**
 * Org-level connector configuration (the "enable" half of the connector
 * model): an OWNER supplies a provider's credentials once (e.g. the SAM.gov
 * API key); the per-member OAuth token vault lands with the OAuth-connector
 * branch as its own migration.
 *
 *   connector_config — one row per provider, holding the owner-supplied
 *                      credentials as a single encrypted JSON blob:
 *                      AES-256-GCM under BRAIN_CONNECTOR_TOKEN_KEY, key
 *                      held OUTSIDE the database. `enabled_by` records which
 *                      owner enabled it; `updated_at` when.
 *
 * No RLS: reached only through the box's ConnectorConfigStore (owner-gated at
 * the HTTP layer), never through the generic read/write tool surface.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

CREATE TABLE connector_config (
  provider    text PRIMARY KEY COLLATE "C",
  ciphertext  text NOT NULL,
  iv          text NOT NULL,
  auth_tag    text NOT NULL,
  enabled_by  uuid NOT NULL REFERENCES accounts(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_config TO brain_app;
`;

export const migration0024: Migration = {
  version: "0024",
  name: "connector-config",
  sql: SQL,
};
