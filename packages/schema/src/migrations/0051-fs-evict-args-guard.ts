import type { Migration } from "./types.js";

/**
 * Defense-in-depth on `brain_fs_evict_versions`. That function is SECURITY
 * DEFINER, owned by `brain_system` (BYPASSRLS), and granted to `brain_app` — so
 * its body runs over the WHOLE `fs_versions` table with RLS bypassed. Its
 * budget/keep are caller-supplied, and a hostile pair turns it into a
 * global-wipe primitive:
 *
 *   brain_fs_evict_versions(0, <path>, 0, '{}')  →  deletes every row, every
 *   home, every owner. `p_budget = 0` makes `sum(size_bytes) - p_budget` the
 *   whole table, so the global pass marks all of it excess; `p_keep = 0` drops
 *   every overwrite snapshot for the path too.
 *
 * Not member-reachable today — no request path lets a member run raw SQL, and
 * the one call site passes the env-configured budget with keep >= 1 — so this is
 * an unnecessary privilege, not a live hole. Closing it anyway (audit finding,
 * 2026-07-23): the function must stay safe to hold that grant even if a future
 * caller, or a bug, passes bad args.
 *
 * Two guards, neither of which touches the legitimate call (its budget is always
 * a positive byte count — the smallest in the codebase is a test's 200_000 —
 * and its keep is env-guarded to >= 1):
 *   - refuse `p_budget <= 0`; raised as a check_violation so it aborts under the
 *     caller's SAVEPOINT and the live write still lands.
 *   - floor `p_keep` at 1, so a call can never drop ALL of a path's overwrite
 *     history (and a negative value can't reach `OFFSET`, which would error).
 *
 * The body is otherwise **byte-for-byte 0048's** — the CURRENT definition, which
 * maintains the fs_version_seq high-water mark on every delete so version numbers
 * never restart after an eviction. (0045's earlier body did NOT; basing this on
 * 0045 would silently revert 0048 — the append-only "never edit a shipped
 * migration, and copy the LIVE body" rule, learned here the hard way.) Only the
 * DECLARE line for v_keep, the p_budget guard, and the per-path OFFSET's use of
 * v_keep are new.
 *
 * Migration doctrine: CREATE OR REPLACE is idempotent; 0045/0048 (and the
 * brain_system owner from 0040) always precede this in the ledger.
 */
const SQL = `
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION brain_fs_evict_versions(
  p_budget   bigint,
  p_path     text,
  p_keep     int,
  p_own_ids  uuid[]
) RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_own     uuid[] := coalesce(p_own_ids, '{}'::uuid[]);
  v_keep    int    := GREATEST(coalesce(p_keep, 0), 1);
  v_dropped uuid[] := '{}'::uuid[];
BEGIN
  -- Defense in depth (0051): this runs BYPASSRLS over the whole table, so it
  -- must refuse args that would weaponise it. A non-positive budget makes the
  -- global pass treat the entire table as excess — only ever "wipe everything".
  -- Raised so it aborts to the caller's SAVEPOINT: housekeeping is skipped, the
  -- live write still lands.
  IF p_budget <= 0 THEN
    RAISE EXCEPTION 'brain_fs_evict_versions: p_budget must be positive (got %)', p_budget
      USING ERRCODE = 'check_violation';
  END IF;

  -- Per-path cap: keep at most v_keep (>= 1) overwrite snapshots for THIS path.
  WITH del AS (
    DELETE FROM fs_versions WHERE id IN (
      SELECT id FROM fs_versions
       WHERE path = p_path AND reason = 'overwrite'
       ORDER BY version_no DESC OFFSET v_keep)
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

-- Owner + grants unchanged from 0045/0048, re-asserted so a CREATE OR REPLACE
-- that somehow reset them (it does not) still lands in the right shape.
ALTER FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[]) OWNER TO brain_system;
REVOKE EXECUTE ON FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[])
  TO brain_app, brain_owner;
`;

export const migration0051: Migration = {
  version: "0051",
  name: "fs-evict-args-guard",
  sql: SQL,
};
