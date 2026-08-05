import type { Migration } from "./types.js";

/**
 * `(path, version_no)` becomes UNIQUE on fs_versions — the pair every reader
 * keys on finally identifies exactly one row.
 *
 * 0043 shipped `fs_versions_path_no` NON-unique, and the store allocated
 * version_no with a plain `max(version_no) + 1`. Nothing serialized two
 * snapshotters of one path: a `rm -r <dir>` holds the advisory lock on the
 * DIRECTORY while a concurrent `write <dir>/f.md` holds it on the FILE —
 * different keys — so both read the same max and both inserted that number.
 * The result is two different bodies sharing one version number, and every
 * reader keys on the pair: `versionContent(path, v)` returns whichever row the
 * plan happened to reach, `restore(path, v)` puts back whichever that was, and
 * `history`/`versionList` show one number twice. A duplicate is not a display
 * bug — it is an undo that hands back bytes the caller never asked for.
 *
 * Two halves; the store half (fs-store.ts) allocates under this index instead
 * of trusting the racy read, so a lost race is a retry, not a second row.
 *
 * Live-box safe, per the migration doctrine — this runs on boxes that have
 * been taking snapshots since 0043 shipped and may ALREADY carry duplicates:
 *  - The de-duplication renumbers the LATER row of each colliding group onto
 *    free numbers above that path's max (chronology first, id as the tiebreak),
 *    so no snapshot is destroyed and version_no stays monotone in time. It
 *    writes rows this migration did not create, so it runs under
 *    `SET LOCAL ROLE brain_system`: fs_versions is FORCE RLS (0043/0046) and
 *    the runner (brain_owner) is bound by it, so a plain UPDATE would have
 *    fixed shared rows only and left every home's duplicates behind — and then
 *    the unique index would have failed on a box we'd just half-repaired.
 *  - Every step is wrapped: a missing table, a missing brain_system, a failed
 *    renumber or an index that still cannot be built all RAISE NOTICE and skip.
 *    A box that cannot be de-duplicated keeps running the old behavior (the
 *    store's ON CONFLICT DO NOTHING infers no arbiter, so it degrades to the
 *    pre-0047 insert) — it does NOT stop updating.
 *
 * The old non-unique index is dropped once the unique one exists: a btree on
 * `(path, version_no)` scans backwards for every `ORDER BY version_no DESC`
 * query 0043 built it for, so keeping both only taxes each snapshot INSERT.
 */
const SQL = `
SET LOCAL lock_timeout = '5s';

DO $mig$
DECLARE
  v_renumbered int := 0;
BEGIN
  IF to_regclass('public.fs_versions') IS NULL THEN
    RAISE NOTICE 'fs_versions absent — skipping the (path, version_no) unique index';
    RETURN;
  END IF;

  -- ---------------------------------------------------------- de-duplicate
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_system') THEN
    BEGIN
      -- brain_system is the ONE role allowed to read across actors (0040); it
      -- had SELECT + DELETE for the reaper (0045) and now needs UPDATE for
      -- this renumber. It is NOLOGIN and reachable only via SET ROLE from
      -- brain_owner, so this widens nothing a request-serving role can use.
      GRANT SELECT, UPDATE ON fs_versions TO brain_system;
      SET LOCAL ROLE brain_system;
      WITH ranked AS (
        SELECT id, path, version_no,
               row_number() OVER (PARTITION BY path, version_no
                                  ORDER BY created_at, id) AS rn
          FROM fs_versions),
      tops AS (
        SELECT path, max(version_no) AS top_no FROM fs_versions GROUP BY path),
      losers AS (
        SELECT r.id,
               t.top_no + (row_number() OVER (PARTITION BY r.path
                                              ORDER BY r.version_no, r.rn))::int AS new_no
          FROM ranked r JOIN tops t ON t.path = r.path
         WHERE r.rn > 1)
      UPDATE fs_versions v SET version_no = l.new_no FROM losers l WHERE v.id = l.id;
      GET DIAGNOSTICS v_renumbered = ROW_COUNT;
      RESET ROLE;
      IF v_renumbered > 0 THEN
        RAISE NOTICE 'fs_versions: renumbered % duplicate (path, version_no) row(s)', v_renumbered;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      RAISE NOTICE 'fs_versions: de-duplication skipped (%)', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'brain_system absent — skipping the fs_versions de-duplication';
  END IF;

  -- ---------------------------------------------------------- the index
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS fs_versions_path_no_uniq
      ON fs_versions (path, version_no);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'fs_versions: unique (path, version_no) index not created (%) — keeping the non-unique one', SQLERRM;
    RETURN;
  END;

  BEGIN
    DROP INDEX IF EXISTS fs_versions_path_no;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'fs_versions: old non-unique index left in place (%)', SQLERRM;
  END;
END
$mig$;
`;

export const migration0047: Migration = {
  version: "0047",
  name: "fs-versions-unique",
  sql: SQL,
};
