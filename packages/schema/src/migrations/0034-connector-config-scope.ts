import type { Migration } from "./types.js";

/**
 * Connector credential SCOPING (unified integrations, PR1). A connector
 * credential was one row per provider for the whole box (owner-set, org-wide).
 * It gains a scope: `org` (owner-set, every member uses it — the existing
 * behavior) or `personal` (one member's own credential/OAuth client, usable
 * only by them). Owners may set either; regular members may set only personal.
 *
 *   scope='org'      → owner_account IS NULL, at most one row per provider
 *   scope='personal' → owner_account = the member, at most one per (provider,member)
 *
 * Back-compat is the whole game here (this runs on live boxes with real
 * credentials — every box in the field): existing rows backfill to
 * ('org', NULL) via the column DEFAULT and are NEVER re-encrypted. The store's
 * AAD branches on scope — org rows keep the legacy `connector_config:<provider>`
 * AAD and decrypt unchanged; personal rows get an account-bound AAD. No FK
 * references connector_config(provider), so dropping the PK is safe.
 *
 * Migration doctrine: append-only, guarded, never throws on box state. The new
 * columns can't pre-exist; the DEFAULT makes every existing row satisfy the
 * CHECK; the partial unique index on org rows is satisfied because provider was
 * the PK (already unique).
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

ALTER TABLE connector_config ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'org';
ALTER TABLE connector_config ADD COLUMN IF NOT EXISTS owner_account uuid REFERENCES accounts(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_config_scope_ck') THEN
    ALTER TABLE connector_config ADD CONSTRAINT connector_config_scope_ck
      CHECK (scope IN ('org','personal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_config_scope_owner_ck') THEN
    ALTER TABLE connector_config ADD CONSTRAINT connector_config_scope_owner_ck
      CHECK ((scope = 'org') = (owner_account IS NULL));
  END IF;
END $$;

-- provider is no longer globally unique (an org row and per-member personal
-- rows can coexist); replace the PK with two partial unique indexes.
ALTER TABLE connector_config DROP CONSTRAINT IF EXISTS connector_config_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS connector_config_org_uq
  ON connector_config (provider) WHERE scope = 'org';
CREATE UNIQUE INDEX IF NOT EXISTS connector_config_personal_uq
  ON connector_config (provider, owner_account) WHERE scope = 'personal';
`;

export const migration0034: Migration = {
  version: "0034",
  name: "connector-config-scope",
  sql: SQL,
  // Drops the connector_config(provider) PK to allow an org row + per-member
  // personal rows to coexist, replacing it with two partial unique indexes
  // that keep the same uniqueness guarantees. No FK references the PK (verified:
  // custom_connectors/0033 and the vault key off accounts, not connector_config),
  // and no row data is deleted or altered — every existing row backfills to
  // ('org', NULL) via the column DEFAULT.
  allowDestructive: [
    {
      rule: "drop-constraint",
      match: "connector_config_pkey",
      reason:
        "replace connector_config PK with partial unique indexes for scoping; no FK, no data loss",
    },
  ],
};
