import type { Migration } from "./types.js";

/**
 * Widen `remote_mcp_server.auth_kind`'s CHECK to admit 'oauth'.
 *
 * 0036 created the column as CHECK (auth_kind IN ('none','bearer','header')).
 * 0038 then added the whole OAuth column set (issuer, token_endpoint, …) but
 * never widened that constraint, so `RemoteMcpStore.register()` — which writes
 * auth_kind='oauth' for the OAuth registration path — raised check_violation
 * (23514) on EVERY box. The dashboard's runApi does not recognize a raw pg
 * error, so the owner saw a bare 500 "internal error" with nothing logged.
 * Net effect: OAuth remote-MCP registration has never once succeeded in the
 * fleet. Non-OAuth (none/bearer/header) was unaffected.
 *
 * Migration doctrine (runs on LIVE boxes): append-only — 0036 is shipped and is
 * NOT edited; this is the forward fix.
 *
 * Why the constraint swap is safe on a box we've never seen: the new predicate
 * is a strict SUPERSET of the old one, so every row that satisfied the old
 * CHECK satisfies the new one by construction — the validating ADD cannot fail
 * on existing data. The DROP is IF EXISTS (a box whose constraint was already
 * dropped, or renamed by hand, is a no-op rather than an error), and the whole
 * swap is wrapped so ANY surprise degrades to a NOTICE + skip instead of
 * throwing: a box that keeps the narrow constraint keeps today's behavior
 * (OAuth registration refused) rather than latching the updater and freezing
 * every future update.
 *
 * Pure DDL on a constraint — no rows read, no backfill — so FORCE RLS (0040)
 * does not apply and no `SET LOCAL ROLE brain_system` is needed.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  ALTER TABLE remote_mcp_server DROP CONSTRAINT IF EXISTS remote_mcp_server_auth_kind_check;
  ALTER TABLE remote_mcp_server ADD CONSTRAINT remote_mcp_server_auth_kind_check
    CHECK (auth_kind IN ('none','bearer','header','oauth'));
EXCEPTION WHEN OTHERS THEN
  -- Never throw on box state we did not create (migration doctrine #1). A box
  -- that lands here keeps whatever constraint it had; OAuth registration stays
  -- refused there, but the box keeps updating.
  RAISE NOTICE 'skipping remote_mcp_server auth_kind CHECK widening: %', SQLERRM;
END $$;
`;

export const migration0044: Migration = {
  version: "0044",
  name: "remote-mcp-oauth-authkind",
  sql: SQL,
  // Same shape as 0015's accounts.role swap: drop→re-add in ONE transaction to a
  // strict SUPERSET (adds 'oauth'). No existing row can violate the new
  // predicate — anything that satisfied ('none','bearer','header') satisfies
  // ('none','bearer','header','oauth') — and no row is admitted in between,
  // since the swap never leaves the transaction. Expand-only, so the usual
  // "DROP CONSTRAINT can silently admit invalid data" hazard does not apply.
  allowDestructive: [
    {
      rule: "drop-constraint",
      match: "remote_mcp_server_auth_kind_check",
      reason:
        "add 'oauth' to remote_mcp_server.auth_kind CHECK — superset swap in one txn (expand-only)",
    },
  ],
};
