import type { Migration } from "./types.js";

/**
 * A partial composite index for the per-token write-budget check
 * (write-path.ts:791): `count(*) FROM events WHERE actor=$1 AND at > now()-… AND
 * kind NOT LIKE 'call:%'`. Today that full-scans the actor's audit history, and
 * call:* events (0019) are ~2/3 of the table. The index matches the query's
 * partial predicate exactly so the budget check reads only lifecycle rows.
 *
 * This is the FIRST production use of the concurrent[] / CREATE INDEX
 * CONCURRENTLY mechanism the runner was built for (bootstrap.ts runConcurrent):
 * - lead with a session `SET lock_timeout = '30s'` so a build that waits on a
 *   lock fails FAST-AND-TRANSIENT (retried next poll) rather than hanging until
 *   the 10-min compose SIGKILL and latching. lock_timeout never fires without
 *   contention, so it does not cap a legitimate long build.
 * - the resume idiom is `DROP INDEX CONCURRENTLY IF EXISTS` (NOT plain DROP
 *   INDEX, which takes ACCESS EXCLUSIVE on events) so an interrupted CIC resumes
 *   without locking the table.
 * - RESET lock_timeout at the end so the setting doesn't leak past this run.
 *
 * `events_actor` (0001) is NOT redundant and must stay: this index is PARTIAL
 * (excludes call:%), so events_actor remains the only index that can serve an
 * actor-scoped call:* audit/usage query.
 *
 * sql is a true no-op (`SELECT 1;`) — all index work is in concurrent[], which
 * runs outside the migration transaction (CIC cannot run in a txn).
 */

const SQL = `
-- No transactional DDL: the index is built concurrently (see concurrent[]).
SELECT 1;
`;

export const migration0041: Migration = {
  version: "0041",
  name: "events-actor-budget-index",
  sql: SQL,
  concurrent: [
    "SET lock_timeout = '30s'",
    "DROP INDEX CONCURRENTLY IF EXISTS events_actor_budget",
    "CREATE INDEX CONCURRENTLY events_actor_budget ON events (actor, at) WHERE kind NOT LIKE 'call:%'",
    "RESET lock_timeout",
  ],
};
