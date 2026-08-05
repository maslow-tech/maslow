import { FS_OBO_CONJUNCT } from "./fs-rls.js";
import type { Migration } from "./types.js";

/**
 * `fs_versions` gets the on_behalf_of narrowing conjunct `fs_entries` has had
 * since 0037 — the version log was leaking home-file CONTENT to a narrowed
 * session.
 *
 * 0043 created `fs_versions_visibility` by hand-copying `fs_visibility` and
 * described it as mirroring fs_entries "exactly". It didn't: fs_entries' USING
 * is `(shared OR mine) AND <obo conjunct>`, and the copy kept only
 * `(shared OR mine)`. A service account acting for a member sets
 * `app.on_behalf_of` (apps/box/src/mcp-http.ts + fs-http.ts read the
 * `x-on-behalf-of` header; FsStore.txn pushes it into the GUC), so in that
 * session `read('/home/<actor>/secret.md')` correctly returned ENOENT while
 * `history()`, `versionList()`, `versionContent()` and `listTrash()` — plus
 * GET /api/v1/fs/history, /fs/version and /fs/trash — handed back the same
 * file's bytes out of the snapshot log. The narrowing is not cosmetic: a bot
 * token narrowed to Bob must see Bob's slice, not the bot principal's own home,
 * and 'none'/garbage must fail closed to shared-only. Prior bytes of a private
 * home file are exactly as private as the live file.
 *
 * The conjunct is no longer written out twice: both policies now embed the one
 * frozen string in ./fs-rls.ts, so they cannot drift apart a second time.
 *
 * WITH CHECK is stated EXPLICITLY here and deliberately does NOT carry the
 * conjunct. A policy with no WITH CHECK reuses its USING expression for
 * INSERT, so adding the conjunct to USING alone would also stop a narrowed
 * session from recording snapshots for rows it is allowed to write — a write
 * that silently loses its own history is worse than the leak. This mirrors
 * 0037's fs_entries WITH CHECK exactly: DR escape, shared rows, or the actor's
 * own. owner_id on a snapshot is copied from the live fs_entries row it
 * captured, which the fs_pin_owner trigger already pinned, so INSERT can never
 * mint a row into someone else's home either way.
 *
 * Append-only: 0043 already shipped and its checksum is recorded on every
 * box that took that release, so it is immutable — this replaces the policy
 * with DROP/CREATE instead. Live-box safe: `DROP POLICY IF EXISTS` is a no-op
 * on a box that somehow lacks it, the CREATE is the only new state, and the
 * 5s lock_timeout bounds the ACCESS EXCLUSIVE lock the policy swap takes. If
 * fs_versions does not exist at all (a box mid-update whose 0043 hasn't
 * landed), the DO block notices and skips rather than throwing — a migration
 * must never latch a box on state it didn't create.
 */
const SQL = `
SET LOCAL lock_timeout = '5s';

DO $mig$
BEGIN
  IF to_regclass('public.fs_versions') IS NULL THEN
    RAISE NOTICE 'fs_versions absent — skipping the on_behalf_of policy swap';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS fs_versions_visibility ON fs_versions;

  -- USING now matches fs_entries' fs_visibility term for term: the DR escape
  -- (brain_owner + app.fs_dr = 'on'), then (shared OR mine) AND the narrowing
  -- conjunct. A narrowed session's version view is exactly its live view.
  -- WITH CHECK stays un-narrowed on purpose (see the header).
  CREATE POLICY fs_versions_visibility ON fs_versions
    USING (
      (current_user = 'brain_owner'
        AND current_setting('app.fs_dr', true) = 'on')
      OR ((owner_id IS NULL
            OR owner_id = nullif(current_setting('app.actor_id', true), '')::uuid)
          AND ${FS_OBO_CONJUNCT}))
    WITH CHECK (
      (current_user = 'brain_owner'
        AND current_setting('app.fs_dr', true) = 'on')
      OR owner_id IS NULL
      OR owner_id = nullif(current_setting('app.actor_id', true), '')::uuid);
END
$mig$;
`;

export const migration0046: Migration = {
  version: "0046",
  name: "fs-versions-obo",
  sql: SQL,
};
