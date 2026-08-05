import type { Migration } from "./types.js";

/**
 * Filesystem version control + locks. Append-only, guarded, runs on live
 * boxes — IF NOT EXISTS everywhere, first line takes a 5s lock_timeout, nothing
 * here throws on box state this migration didn't create.
 *
 * `fs_versions` is an RLS-scoped snapshot log: the PRIOR bytes on an overwrite,
 * the content at delete. It mirrors the fs_entries visibility policy exactly
 * (shared rows for everyone, home rows only for their owner), including the
 * app.fs_dr DR escape, and is FORCE-RLS so any session that has not set
 * app.actor_id sees shared-only (fail closed, never disclosure). `fs_entries`
 * gains a lock flag (locked_by/locked_at) so a member can pin a path while it
 * is being edited.
 */
const SQL = `
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------------ fs_versions
CREATE TABLE IF NOT EXISTS fs_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path        text NOT NULL COLLATE "C",
  version_no  int  NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('overwrite','delete')),
  content     bytea NOT NULL,
  size_bytes  bigint NOT NULL,
  sha256      text,
  mime        text,
  owner_id    uuid REFERENCES accounts(id),          -- NULL = shared (mirrors fs_entries)
  edited_by   uuid NOT NULL REFERENCES accounts(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fs_versions_path_no ON fs_versions (path, version_no DESC);
CREATE INDEX IF NOT EXISTS fs_versions_evict   ON fs_versions (created_at);

-- ------------------------------------------------------------------ lock columns
ALTER TABLE fs_entries ADD COLUMN IF NOT EXISTS locked_by uuid REFERENCES accounts(id);
ALTER TABLE fs_entries ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- ------------------------------------------------------------------ RLS
-- Mirrors fs_entries' fs_visibility exactly: the DR escape (brain_owner +
-- app.fs_dr = 'on'), shared rows (owner_id NULL) for everyone, home rows only
-- for the actor. FORCE binds the table owner too, so a session without
-- app.actor_id stays fail-closed shared-only.
ALTER TABLE fs_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fs_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fs_versions_visibility ON fs_versions;
CREATE POLICY fs_versions_visibility ON fs_versions
  USING (
    (current_user = 'brain_owner'
      AND current_setting('app.fs_dr', true) = 'on')
    OR owner_id IS NULL
    OR owner_id = nullif(current_setting('app.actor_id', true), '')::uuid
  );

-- ------------------------------------------------------------------ grants
GRANT SELECT, INSERT, DELETE ON fs_versions TO brain_app;
-- The 0037 column-scoped UPDATE grant on fs_entries predates the lock columns;
-- extend it so FsStore.lock/unlock (brain_app) may stamp/clear them. owner_id
-- stays trigger-pinned and off the grant, so a lock can never re-home a row.
GRANT UPDATE (locked_by, locked_at) ON fs_entries TO brain_app;
`;

export const migration0043: Migration = {
  version: "0043",
  name: "fs-versions-locks",
  sql: SQL,
};
