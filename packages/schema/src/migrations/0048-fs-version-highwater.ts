import type { Migration } from "./types.js";

/**
 * `fs_version_seq` — the per-path version-number HIGH-WATER MARK, and the
 * reaper teaching it every number it destroys.
 *
 * A `version_no` is a handle a human writes down: `history` prints it, and
 * `restore <path> 3` / `diff <path> 3` are typed hours later from a note. It
 * was allocated as `max(version_no) + 1` over the rows that still EXIST, and
 * nothing anywhere remembered the numbers eviction had taken. So once history
 * for a path was fully reclaimed — the per-path cap plus the global byte budget
 * both do that routinely — the counter silently restarted at 1, and the SAME
 * number then named completely different bytes. The remembered `restore
 * /shared/plan.md 3` did not fail honestly; it resolved to a snapshot created
 * AFTER the one the caller meant and reported success. Numbers that are reused
 * are not identifiers.
 *
 * The mark therefore has to live OUTSIDE the evictable rows: one tiny row per
 * path, `last_no` = the highest number ever issued for it, updated by the only
 * thing that ever destroys a number — `brain_fs_evict_versions`, which now
 * records `max(version_no)` per path for every row it deletes (all three
 * passes). Allocation becomes `greatest(max(surviving), last_no) + 1`, so
 * numbers only ever go UP; a gap means "that version is gone", never "that
 * version is something else now".
 *
 * Privacy: the table holds PATHS, and a path in a member's home is exactly as
 * private as the file. brain_app therefore gets NO table privileges at all —
 * it reads the mark only through `brain_fs_version_floor(path)`, a SECURITY
 * DEFINER function that takes an exact path and returns an integer, so nothing
 * can be enumerated and no path ever crosses the boundary that the caller did
 * not itself supply. Same shape, same reasoning as 0045's reaper.
 *
 * Nothing ever prunes this table, and that is the point: a mark that could be
 * reclaimed would let the number it guards be reissued, which is the bug. It
 * holds one short row per path that has ever had a version destroyed (a few
 * dozen bytes), and an `rm` keeps its row so a recreated path does not restart
 * at 1 either.
 *
 * Live-box safe / append-only: IF NOT EXISTS + CREATE OR REPLACE, guarded on
 * `fs_versions` existing at all (a box mid-update whose 0043 has not landed
 * skips with a NOTICE rather than latching), and the reaper keeps its exact
 * 0045 signature so an app that has not been recreated yet calls it unchanged.
 * The seq write is ordered by path so two concurrent reapers take the row locks
 * in the same order; the caller runs the whole reap inside a SAVEPOINT anyway,
 * so the worst case stays "housekeeping skipped", never a failed write.
 */
const SQL = `
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------ fs_version_seq
CREATE TABLE IF NOT EXISTS fs_version_seq (
  path       text COLLATE "C" PRIMARY KEY,
  last_no    int NOT NULL CHECK (last_no >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- brain_app is deliberately absent from these grants: it reaches the mark only
-- through the accessor below, which cannot be used to enumerate paths.
GRANT SELECT, INSERT, UPDATE ON fs_version_seq TO brain_system;

-- ------------------------------------------------------------ the accessor
-- Exact-path lookup, nothing else: answers 0 for a path that never had one.
CREATE OR REPLACE FUNCTION brain_fs_version_floor(p_path text) RETURNS int
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_catalog AS $fn$
  SELECT coalesce((SELECT last_no FROM fs_version_seq WHERE path = p_path), 0);
$fn$;

ALTER FUNCTION brain_fs_version_floor(text) OWNER TO brain_system;
REVOKE EXECUTE ON FUNCTION brain_fs_version_floor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_fs_version_floor(text) TO brain_app, brain_owner;

-- ------------------------------------------------------------ the reaper
-- Byte-for-byte 0045 apart from the three high-water recordings: every DELETE
-- now RETURNs (path, version_no) and folds the per-path maximum into
-- fs_version_seq before the numbers are gone.
DO $mig$
BEGIN
  IF to_regclass('public.fs_versions') IS NULL THEN
    RAISE NOTICE 'fs_versions absent — skipping the version high-water reaper';
    RETURN;
  END IF;

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
    WITH del AS (
      DELETE FROM fs_versions WHERE id IN (
        SELECT id FROM fs_versions
         WHERE path = p_path AND reason = 'overwrite'
         ORDER BY version_no DESC OFFSET p_keep)
      RETURNING path, version_no),
    hw AS (SELECT path, max(version_no) AS no FROM del GROUP BY path)
    INSERT INTO fs_version_seq AS s (path, last_no)
    SELECT path, no FROM hw ORDER BY path
    ON CONFLICT (path) DO UPDATE
      SET last_no = greatest(s.last_no, excluded.last_no), updated_at = now();

    -- Global budget, pass 1: oldest-first across EVERY path and every owner,
    -- excluding the op's own rows.
    WITH over AS (
      SELECT coalesce(sum(size_bytes), 0) - p_budget AS excess FROM fs_versions),
    victims AS (
      SELECT id, size_bytes,
             sum(size_bytes) OVER (ORDER BY created_at, path, version_no) AS running
        FROM fs_versions
       WHERE NOT (id = ANY(v_own))),
    del AS (
      DELETE FROM fs_versions WHERE id IN (
        SELECT victims.id FROM victims, over
         WHERE over.excess > 0 AND victims.running - victims.size_bytes < over.excess)
      RETURNING path, version_no),
    hw AS (SELECT path, max(version_no) AS no FROM del GROUP BY path)
    INSERT INTO fs_version_seq AS s (path, last_no)
    SELECT path, no FROM hw ORDER BY path
    ON CONFLICT (path) DO UPDATE
      SET last_no = greatest(s.last_no, excluded.last_no), updated_at = now();

    IF cardinality(v_own) = 0 THEN
      RETURN v_dropped;
    END IF;

    -- Pass 2: still over budget ⇒ this ONE operation's snapshots outweigh the
    -- entire budget. Deterministic (path, version_no), and the casualties go
    -- back to the caller by name.
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
      RETURNING id, path, version_no),
    hw AS (SELECT path, max(version_no) AS no FROM del GROUP BY path),
    seq AS (
      INSERT INTO fs_version_seq AS s (path, last_no)
      SELECT path, no FROM hw ORDER BY path
      ON CONFLICT (path) DO UPDATE
        SET last_no = greatest(s.last_no, excluded.last_no), updated_at = now()
      RETURNING 1)
    SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO v_dropped FROM del;

    RETURN v_dropped;
  END
  $fn$;

  ALTER FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[]) OWNER TO brain_system;
  REVOKE EXECUTE ON FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[]) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[])
    TO brain_app, brain_owner;
END
$mig$;
`;

export const migration0048: Migration = {
  version: "0048",
  name: "fs-version-highwater",
  sql: SQL,
};
