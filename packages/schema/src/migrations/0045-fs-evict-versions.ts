import type { Migration } from "./types.js";

/**
 * `brain_fs_evict_versions` — the version-history reaper, elevated.
 *
 * fs_versions is FORCE-RLS (0043), and eviction used to run as plain brain_app
 * inside the writing member's transaction. The USING policy governs DELETE and
 * every aggregate the same way it governs SELECT, so both the budget
 * MEASUREMENT (`sum(size_bytes)`) and the victim SET were scoped to the writer:
 * shared rows plus that writer's own home. A cap documented as global was
 * therefore per-actor — N members meant N budgets, the table grew without
 * bound with headcount — and one member's stale home snapshots could never be
 * reclaimed by anybody else's writes, because nobody else could see them.
 *
 * Housekeeping is not a read: the budget is a property of the whole TABLE, so
 * it has to be evaluated over the whole table. brain_app is NOBYPASSRLS by
 * design and cannot `SET ROLE brain_system` (that check is against the SESSION
 * user), so the elevation is ownership: a SECURITY DEFINER function owned by
 * brain_system — exactly the precedent 0040 set for brain_edge_count, which
 * needs the TRUE edge count under FORCE for the same reason.
 *
 * The privacy boundary is DISCLOSURE, not deletion (the design already accepts
 * oldest-first eviction of any owner's snapshots — that is what a shared budget
 * means). So the function returns nothing about the rows it reaped: no path, no
 * content, no owner_id, not even a count of other people's rows. Its only
 * return value is the subset of the CALLER'S OWN row ids — ids the caller
 * itself just passed in — so a member learns strictly what they already knew.
 *
 * Append-only, guarded, runs on live boxes: CREATE OR REPLACE + IF EXISTS
 * guards, nothing here throws on box state it did not create.
 */
const SQL = `
SET LOCAL lock_timeout = '5s';

-- brain_system does the deleting, so it needs the table privileges to match its
-- BYPASSRLS attribute (0043 granted brain_app only). SELECT + DELETE only: the
-- reaper never inserts and never updates.
GRANT SELECT, DELETE ON fs_versions TO brain_system;

-- p_own_ids are the rows the calling operation JUST inserted. They are evicted
-- last and separately (pass 2), never alongside everybody else's history: one
-- \`rm -r\` inserts its whole subtree's trash sharing a single txn clock, so an
-- age-ranked pass that could reach them would shred the very trash the rm had
-- just promised was recoverable. Returns the subset of p_own_ids it could not
-- retain — the caller maps those back to paths locally and reports them.
CREATE OR REPLACE FUNCTION brain_fs_evict_versions(
  p_budget   bigint,
  p_path     text,
  p_keep     int,
  p_own_ids  uuid[]
) RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_own     uuid[] := coalesce(p_own_ids, '{}'::uuid[]);
  v_dropped uuid[] := '{}'::uuid[];
BEGIN
  -- Per-path cap: keep at most p_keep overwrite snapshots for THIS path.
  DELETE FROM fs_versions WHERE id IN (
    SELECT id FROM fs_versions
     WHERE path = p_path AND reason = 'overwrite'
     ORDER BY version_no DESC OFFSET p_keep);

  -- Global budget, pass 1: oldest-first across EVERY path and every owner,
  -- excluding the op's own rows. \`excess\` is measured over the whole table
  -- (the op's own bytes do count against the budget) but the op's own rows are
  -- not eligible victims. Ordering is (created_at, path, version_no) — total
  -- and stable — so which history ages out is reproducible, and the prefix rule
  -- deletes THROUGH the row that crosses the excess so the table actually lands
  -- at-or-under budget instead of hovering above it forever.
  WITH over AS (
    SELECT coalesce(sum(size_bytes), 0) - p_budget AS excess FROM fs_versions),
  victims AS (
    SELECT id, size_bytes,
           sum(size_bytes) OVER (ORDER BY created_at, path, version_no) AS running
      FROM fs_versions
     WHERE NOT (id = ANY(v_own)))
  DELETE FROM fs_versions WHERE id IN (
    SELECT victims.id FROM victims, over
     WHERE over.excess > 0 AND victims.running - victims.size_bytes < over.excess);

  IF cardinality(v_own) = 0 THEN
    RETURN v_dropped;
  END IF;

  -- Pass 2: still over budget ⇒ this ONE operation's snapshots outweigh the
  -- entire budget. Something has to give, but deterministically (path,
  -- version_no) and the casualties go back to the caller by name.
  WITH over AS (
    SELECT coalesce(sum(size_bytes), 0) - p_budget AS excess FROM fs_versions),
  victims AS (
    SELECT id, path, size_bytes,
           sum(size_bytes) OVER (ORDER BY path, version_no) AS running
      FROM fs_versions
     WHERE id = ANY(v_own)),
  del AS (
    DELETE FROM fs_versions WHERE id IN (
      SELECT victims.id FROM victims, over
       WHERE over.excess > 0 AND victims.running - victims.size_bytes < over.excess)
    RETURNING id)
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO v_dropped FROM del;

  RETURN v_dropped;
END
$fn$;

-- Owned by brain_system (NOLOGIN, BYPASSRLS) so the body sees the whole table
-- under FORCE; brain_owner may reassign because roles.ts grants it membership.
ALTER FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[]) OWNER TO brain_system;
REVOKE EXECUTE ON FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[])
  TO brain_app, brain_owner;
`;

export const migration0045: Migration = {
  version: "0045",
  name: "fs-evict-versions",
  sql: SQL,
};
