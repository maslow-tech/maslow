import type { Migration } from "./types.js";

/**
 * Retire the think surface entirely (product decision, 2026-07-08). The think TOOL was
 * removed earlier, but the brain_think() SECURITY DEFINER function it
 * called still existed and stayed EXECUTE-granted to brain_app — a dead but
 * callable write surface. Drop it.
 *
 * Historical 'think' events stay in the ledger untouched — the events table is
 * append-only audit history, not something a migration rewrites.
 *
 * Guarded per the migration doctrine: DROP ... IF EXISTS never throws on a box
 * where the function is already gone or was never created.
 */

const SQL = `
DROP FUNCTION IF EXISTS brain_think(text);
`;

export const migration0020: Migration = {
  version: "0020",
  name: "drop-think",
  sql: SQL,
  // DROP FUNCTION is not a linted destructive rule — no ack needed; adding a
  // list ack here would trip the stale-ack rule (it would match no destructive
  // statement). The top-level reason stays as changelog prose.
  reason: "drop the dead brain_think() function (its tool was removed); history rows stay",
};
