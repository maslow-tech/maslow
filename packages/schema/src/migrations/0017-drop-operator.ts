import type { Migration } from "./types.js";

/**
 * Kill the on-box 'operator' actor entirely (product decision, 2026-07-07). It was
 * plumbing for an SSM-era operator-CLI workflow that never shipped and
 * whose transport (SSM) was deliberately removed — zero events were ever
 * attributed to it on any live box. Vendor-side operators live in the BOOTH
 * (operators table + /admin console); the box needs no such actor.
 *
 * Defensive by construction (a production latch lesson): this runs on
 * every update, so nothing here may ever throw on a box in an unexpected
 * state. If some box DOES have data referencing the operator account, the
 * account is left in place (and the CHECK keeps 'operator') rather than
 * failing the migrate — a NOTICE is raised for the logs instead.
 */

const OPERATOR_ID = "00000000-0000-0000-0000-0000000000ff";

const SQL = `
DO $mig$
BEGIN
  -- The operator's own audit events are test/no-op noise by definition
  -- (the workflow never shipped); remove them so the account can go.
  DELETE FROM events WHERE actor = '${OPERATOR_ID}';
  BEGIN
    DELETE FROM accounts WHERE id = '${OPERATOR_ID}';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'operator account is still referenced — left in place';
  END;

  -- Tighten the role CHECK only when no operator rows remain (adding a CHECK
  -- validates existing rows — doing it unconditionally could fail the migrate).
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'operator') THEN
    ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
    ALTER TABLE accounts ADD CONSTRAINT accounts_role_check
      CHECK (role IN ('owner', 'member', 'viewer', 'system'));
  END IF;
END
$mig$;
`;

export const migration0017: Migration = {
  version: "0017",
  name: "drop-operator",
  sql: SQL,
  // Deletes the never-used builtin operator account (+ its zero-or-test
  // events) and narrows the role CHECK — both guarded so an unexpected
  // reference leaves the box untouched instead of failing the migrate.
  allowDestructive: [
    {
      rule: "drop-constraint",
      match: "accounts_role_check",
      reason:
        "narrow the accounts.role CHECK back down, guarded to run only when no operator rows " +
        "remain (no-throw); removing the dead SSM-era operator account",
    },
  ],
};
