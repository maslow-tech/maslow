import type { Migration } from "./types.js";

/**
 * `fs_version_seq` (0048) shipped with NO row-level security, while both of its
 * siblings — `fs_entries` (0037) and `fs_versions` (0043) — are FORCE-RLS
 * specifically so the migration/DR role cannot read a member's private home
 * without deliberately setting `app.fs_dr`. The new table stores one row per
 * PATH, so `brain_owner` could enumerate every member's private home paths with
 * no escape set:
 *
 *     fs_versions   /home/%  -> 0 rows        (FORCE holds)
 *     fs_entries    /home/%  -> 0 rows        (FORCE holds)
 *     fs_version_seq         -> /home/alice/oracle/journal.md   <- leak
 *
 * A private home PATH is as private as the file at it — the path is the thing
 * `listTrash` goes to such lengths to keep unenumerable. This closes exactly the
 * divergence FORCE was introduced to prevent.
 *
 * The policy mirrors fs_entries: shared paths (anything not under /home/) are
 * visible to everyone, a home path only to the actor whose slug it carries
 * (resolved through fs_homes, the same derivation fs_pin_owner uses), plus the
 * documented brain_owner + app.fs_dr escape for whole-brain export.
 *
 * It does NOT reuse FS_OBO_CONJUNCT: that clause is written against an
 * `owner_id` column, and this table has none — it holds only (path, last_no).
 * Ownership is DERIVED from the path here, and the derivation already restricts
 * a narrowed service session to its own home; the only rows it leaves broadly
 * readable are non-home (`/shared`) paths, which carry no private ownership to
 * narrow. If this table ever gains an owner_id, switch to the shared conjunct so
 * the three tables stay literally identical.
 *
 * `brain_system` is BYPASSRLS, so brain_fs_version_floor / the allocator keep
 * working unchanged; `brain_app` was never granted this table at all.
 *
 * Migration doctrine: append-only, guarded, idempotent — ENABLE/FORCE and a
 * DROP-then-CREATE policy are all no-ops on a re-run, and a box that somehow
 * lacks the table skips the whole block instead of throwing.
 */
const SQL = `
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.fs_version_seq') IS NULL THEN
    RAISE NOTICE 'fs_version_seq absent (pre-0048 box) — skipping its RLS';
    RETURN;
  END IF;

  -- Every identifier below is a fixed literal, but the %I/%L gate is
  -- categorical: any EXECUTE must build its SQL through format(). Same shape
  -- 0040 uses for its conditional grants.
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', 'fs_version_seq');
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', 'fs_version_seq');
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I',
                 'fs_version_seq_visibility', 'fs_version_seq');
  EXECUTE format($pol$
    CREATE POLICY %I ON %I
      USING (
        (current_user = 'brain_owner'
          AND current_setting('app.fs_dr', true) = 'on')
        OR path NOT LIKE '/home/%%'
        OR EXISTS (
          SELECT 1 FROM fs_homes h
           WHERE h.slug = split_part(path, '/', 3)
             AND h.actor_id = nullif(current_setting('app.actor_id', true), '')::uuid
        )
      )
  $pol$, 'fs_version_seq_visibility', 'fs_version_seq');
END
$$;
`;

export const migration0049: Migration = {
  version: "0049",
  name: "fs-version-seq-rls",
  sql: SQL,
};
