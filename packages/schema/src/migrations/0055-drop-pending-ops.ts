import type { Migration } from "./types.js";

/**
 * Drop `pending_ops` — a table that has never done anything (2026-07-27 cleanup).
 *
 * 0001-init created it, indexed it (`pending_ops_status`), and granted
 * SELECT/INSERT/UPDATE/DELETE on it to brain_app, for a planned
 * "durable queue for out-of-band-confirm ops": a destructive or over-budget op
 * would be parked as a row, return "pending" immediately, and re-enter with a
 * fresh version check once a human confirmed it. That feature was never built.
 *
 * Nothing reads or writes it. A whole-repo search finds the name in exactly two
 * live places: this schema package (its own CREATE in 0001) and the RESERVED
 * denylist in packages/shared/src/identifier.ts — which is a NAME blocklist, not
 * a use. No reader, no writer, no MCP tool, no dashboard route, no test touches
 * it. So no box can hold a meaningful row and nothing can reference the table.
 *
 * The RESERVED entry stays deliberately. That list is documented as
 * "kept deliberately broad — a rejected-but-legal name costs the agent a rename;
 * an accepted collision corrupts the catalog", and boxes mid-rollout still have
 * the table until they converge. Freeing the name buys nothing and races the
 * fleet.
 *
 * Guarded per the migration doctrine: DROP ... IF EXISTS never throws on a box
 * where the table is already gone. Dropping the table takes its index and grants
 * with it, so neither needs its own statement.
 */

const SQL = `
DROP TABLE IF EXISTS pending_ops;
`;

export const migration0055: Migration = {
  version: "0055",
  name: "drop-pending-ops",
  sql: SQL,
  allowDestructive: [
    {
      rule: "drop-table",
      match: "pending_ops",
      reason:
        "safe on a box we have never seen: no application code has ever read or written pending_ops since 0001 created it, so no box can hold a row that matters and nothing can hold a reference to it",
    },
  ],
  reason:
    "drop the never-implemented pending_ops out-of-band-confirm queue (created in 0001, never read or written)",
};
