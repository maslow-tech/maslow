import { FS_OBO_CONJUNCT } from "./fs-rls.js";
import type { Migration } from "./types.js";

/**
 * The brain filesystem (supersedes the per-object file-attachments 0033,
 * which never shipped in any release, so rewriting the version in place is
 * legal: no live ledger has ever checksummed it).
 *
 * One persistent, Postgres-backed tree used by agents exclusively through the
 * bash tool. Three tables, all created HERE (no ALTER of foreign state — the
 * fleet has latched twice on migrations that assumed box state they didn't
 * create):
 *
 *  1. `fs_homes` — actor ↔ home slug (`/home/alice`, never a uuid). Slugs are
 *     immutable; display-name changes don't move homes.
 *  2. `fs_entries` — the tree. Bytes live INLINE in the row (no blob table, no
 *     dedup: dedup would create an RLS-less blob surface and a cross-home
 *     content-existence oracle). 25MB/file CHECK; quota is store-code
 *     maintained in `fs_usage` (deliberately NO usage trigger — an AFTER
 *     trigger serializes every write through a singleton row and turns append
 *     loops O(n²)).
 *  3. `fs_usage` — a singleton byte counter, kept by FsStore in the same txn
 *     as each size-changing op.
 *
 * RLS on fs_entries is THE security boundary, binding bash, bearer HTTP and
 * the dashboard identically: shared rows (owner_id NULL) for everyone, home
 * rows only for their owner. `fs_pin_owner` derives owner_id from the path
 * BEFORE the policy's WITH CHECK runs, so a row can never lie about whose
 * home it's in, no matter the surface. FORCE means even brain_owner sessions
 * see shared-only unless they set app.actor_id — fail closed.
 *
 * Known ceiling (accepted for v1, same doctrine as 0012's documented
 * ceilings): the filesystem is binary home/shared, so a private or
 * shared_with-scoped record can no longer carry a matching-audience
 * attachment — a restricted-audience file either sits in the author's home
 * (invisible to the subset) or in /shared (visible to everyone).
 *
 * Live-box safe: IF NOT EXISTS everywhere, DO-block guards with RAISE NOTICE
 * + skip on any surprise, first line takes a 5s lock_timeout. Nothing here
 * throws on box state this migration didn't create.
 */

// The per-file cap this migration ORIGINALLY shipped: 25 MB. It is frozen here
// as a literal on purpose — migrations are append-only and the ledger checksums
// each one, so importing the live constant would silently rewrite this file's
// SQL (and its checksum) every time the cap changes. 0060 widens it; the
// current value lives in ./fs-limits.js.
const MAX_FILE_BYTES = 26_214_400;

// The on_behalf_of narrowing conjunct now lives in ./fs-rls.js, shared with
// 0046 (which puts the SAME text on fs_versions — 0043 hand-copied this policy
// and lost it, leaking home-file content through history/trash to a narrowed
// session). The string is byte-identical to the literal that used to sit here,
// so this migration's checksum is unchanged and no applied ledger drifts.
const OBO_CONJUNCT = FS_OBO_CONJUNCT;

const SQL = `
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------------ fs_homes
-- One home slug per account. Reserved names can never shadow the fixed
-- namespace; the CHECK is the same regex the store validates against.
CREATE TABLE IF NOT EXISTS fs_homes (
  actor_id uuid PRIMARY KEY REFERENCES accounts(id),
  slug     text NOT NULL UNIQUE COLLATE "C"
           CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'
                  AND slug NOT IN ('user','shared','home','tmp','bin','usr','etc','root'))
);

-- ------------------------------------------------------------------ fs_entries
CREATE TABLE IF NOT EXISTS fs_entries (
  path        text PRIMARY KEY COLLATE "C",   -- absolute, normalized, no trailing slash
  parent      text NOT NULL COLLATE "C",
  name        text NOT NULL COLLATE "C",
  kind        text NOT NULL CHECK (kind IN ('dir','file')),
  content     bytea,                          -- NULL iff dir; NO dedup, NO blob table
  size_bytes  bigint NOT NULL DEFAULT 0,
  sha256      text,
  mime        text,
  owner_id    uuid REFERENCES accounts(id),   -- NULL = shared; pinned BY TRIGGER for /home/*
  created_by  uuid NOT NULL REFERENCES accounts(id),
  updated_by  uuid NOT NULL REFERENCES accounts(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (path = '/' OR path ~ '^(/[^/]+)+$'),
  CHECK ((kind = 'dir') = (content IS NULL)),
  CHECK (content IS NULL OR octet_length(content) <= ${MAX_FILE_BYTES})
);
CREATE INDEX IF NOT EXISTS fs_entries_parent_idx ON fs_entries (parent, name);

-- ------------------------------------------------------------------ fs_usage
CREATE TABLE IF NOT EXISTS fs_usage (
  singleton   bool PRIMARY KEY DEFAULT true CHECK (singleton),
  total_bytes bigint NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------------ triggers
-- Rows under /home/* get owner_id from the fs_homes slug lookup; everything
-- else is shared (NULL). BEFORE row, so it runs before the RLS WITH CHECK:
-- "write into /home/alice as bob" is rejected by Postgres on every surface.
CREATE OR REPLACE FUNCTION fs_pin_owner()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_owner uuid;
BEGIN
  IF NEW.path LIKE '/home/%' THEN
    SELECT actor_id INTO v_owner
    FROM fs_homes WHERE slug = split_part(NEW.path, '/', 3);
    IF v_owner IS NULL THEN
      RAISE EXCEPTION 'fs_no_such_home: /home/% is not a member home',
        split_part(NEW.path, '/', 3);
    END IF;
    NEW.owner_id := v_owner;
  ELSE
    NEW.owner_id := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS fs_pin_owner ON fs_entries;
CREATE TRIGGER fs_pin_owner
  BEFORE INSERT OR UPDATE ON fs_entries
  FOR EACH ROW EXECUTE FUNCTION fs_pin_owner();

-- Parent must exist and be a dir (the store does implicit mkdir -p; this is
-- the backstop). NO FK, NO cascades — a dir rename is a single-statement
-- prefix rewrite in store code, and rows in one UPDATE change in arbitrary
-- physical order, so this fires AFTER (per row, at statement end, when the
-- whole rewrite is visible) rather than BEFORE, where a child could be
-- checked against a parent path that hasn't been rewritten yet.
CREATE OR REPLACE FUNCTION fs_assert_parent()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.path = '/' THEN
    RETURN NULL;  -- the root has no parent
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fs_entries p WHERE p.path = NEW.parent AND p.kind = 'dir') THEN
    RAISE EXCEPTION 'fs_no_parent: % is not an existing directory', NEW.parent;
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS fs_assert_parent ON fs_entries;
CREATE TRIGGER fs_assert_parent
  AFTER INSERT OR UPDATE ON fs_entries
  FOR EACH ROW EXECUTE FUNCTION fs_assert_parent();

-- ------------------------------------------------------------------ backfill
-- A home slug for every existing account: slugify(name) = lower, non-[a-z0-9]
-- runs become '-', trimmed; collisions get -2,-3…; empty/reserved/pathological
-- names fall back to 'user-<first 8 of uuid>'. Per-account guarded — a
-- surprising account NOTICEs and is skipped, it never fails the migrate.
DO $mig$
DECLARE
  r record;
  v_base text;
  v_slug text;
  v_n int;
BEGIN
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE NOTICE 'fs 0037: accounts table missing — skipping home backfill';
    RETURN;
  END IF;
  FOR r IN
    SELECT a.id, a.name FROM accounts a
    WHERE NOT EXISTS (SELECT 1 FROM fs_homes h WHERE h.actor_id = a.id)
    ORDER BY a.created_at, a.id
  LOOP
    BEGIN
      v_base := trim(both '-' from
                  regexp_replace(lower(coalesce(r.name, '')), '[^a-z0-9]+', '-', 'g'));
      v_base := trim(both '-' from left(v_base, 63));
      IF v_base !~ '^[a-z0-9][a-z0-9-]{0,62}$'
         OR v_base IN ('user','shared','home','tmp','bin','usr','etc','root') THEN
        v_base := 'user-' || left(r.id::text, 8);
      END IF;
      v_slug := v_base;
      v_n := 1;
      WHILE EXISTS (SELECT 1 FROM fs_homes WHERE slug = v_slug) LOOP
        v_n := v_n + 1;
        v_slug := left(v_base, 63 - length('-' || v_n::text)) || '-' || v_n::text;
      END LOOP;
      INSERT INTO fs_homes (actor_id, slug) VALUES (r.id, v_slug);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'fs 0037: skipped home slug for account % (%)', r.id, SQLERRM;
    END;
  END LOOP;
END
$mig$;

-- ------------------------------------------------------------------ seed
-- The fixed skeleton + the in-band rules README + a home dir per backfilled
-- account. Runs BEFORE RLS is enabled below, so the brain_owner seed needs no
-- actor gymnastics. Attributed to the 0001 system account; NOTICE + skip if
-- some box has lost it (nothing here may throw on foreign state).
DO $mig$
DECLARE
  sys constant uuid := '00000000-0000-0000-0000-000000000000';
  v_readme bytea;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = sys) THEN
    RAISE NOTICE 'fs 0037: system account missing — skipping skeleton seed';
    RETURN;
  END IF;

  INSERT INTO fs_entries (path, parent, name, kind, created_by, updated_by)
  VALUES ('/', '', '', 'dir', sys, sys)
  ON CONFLICT (path) DO NOTHING;

  INSERT INTO fs_entries (path, parent, name, kind, created_by, updated_by)
  VALUES ('/shared', '/', 'shared', 'dir', sys, sys),
         ('/home',   '/', 'home',   'dir', sys, sys)
  ON CONFLICT (path) DO NOTHING;

  v_readme := convert_to(
'# The brain filesystem

- /shared is visible to every member. Whatever you save here survives
  across calls, sessions, and members.
- /home/<you> is private to you. Other members'' homes do not exist in
  your view. Your shell starts in your home.
- /tmp is scratch and vanishes when a script ends. Only /shared,
  /home/<you> and /tmp are writable.
- To attach a file to a record, save it under /shared and put its
  absolute path in a text property (for example
  spec_path: /shared/projects/apollo/spec.md). Never paste file bodies
  into properties.
', 'UTF8');

  INSERT INTO fs_entries
    (path, parent, name, kind, content, size_bytes, sha256, mime, created_by, updated_by)
  VALUES
    ('/shared/README.md', '/shared', 'README.md', 'file', v_readme,
     octet_length(v_readme), encode(sha256(v_readme), 'hex'), 'text/markdown', sys, sys)
  ON CONFLICT (path) DO NOTHING;

  INSERT INTO fs_entries (path, parent, name, kind, created_by, updated_by)
  SELECT '/home/' || h.slug, '/home', h.slug, 'dir', sys, sys
  FROM fs_homes h
  ON CONFLICT (path) DO NOTHING;

  INSERT INTO fs_usage (singleton, total_bytes) VALUES (true, 0)
  ON CONFLICT (singleton) DO NOTHING;
  UPDATE fs_usage
  SET total_bytes = coalesce((SELECT sum(size_bytes) FROM fs_entries WHERE kind = 'file'), 0);
END
$mig$;

-- ------------------------------------------------------------------ RLS
-- THE security boundary. FORCE binds the table owner too: any session that
-- has not set app.actor_id — including a future migration — sees shared rows
-- only (fail closed, never disclosure). Subquery-free on the hot path; the
-- on_behalf_of CASE only runs for home rows while a narrowing header is set.
-- The one deliberate escape is DR export/import: brain_owner may opt in with
-- SET LOCAL app.fs_dr = 'on' (the whole-brain dump must include home rows,
-- and FORCE means row_security=off errors rather than bypasses for the
-- owner). brain_app can never take it — the conjunct checks current_user —
-- and a migration that doesn't set the GUC stays fail-closed shared-only.
ALTER TABLE fs_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE fs_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fs_visibility ON fs_entries;
CREATE POLICY fs_visibility ON fs_entries
  USING (
    (current_user = 'brain_owner'
      AND current_setting('app.fs_dr', true) = 'on')
    OR ((owner_id IS NULL
          OR owner_id = nullif(current_setting('app.actor_id', true), '')::uuid)
        AND ${OBO_CONJUNCT}))
  WITH CHECK (
    (current_user = 'brain_owner'
      AND current_setting('app.fs_dr', true) = 'on')
    OR owner_id IS NULL
    OR owner_id = nullif(current_setting('app.actor_id', true), '')::uuid);

-- ------------------------------------------------------------------ grants
-- Column-scoped UPDATE: created_by/created_at/owner_id/kind are never
-- client-updatable (owner_id is trigger-pinned; a kind flip would dodge the
-- dir/content CHECK semantics).
GRANT SELECT, INSERT, DELETE ON fs_entries TO brain_app;
GRANT UPDATE (path, parent, name, content, size_bytes, sha256, mime, updated_by, updated_at)
  ON fs_entries TO brain_app;
-- homeSlug lookups + the createUser companion insert.
GRANT SELECT, INSERT ON fs_homes TO brain_app;
-- FsStore maintains the quota counter in the same txn as each write.
GRANT SELECT, UPDATE ON fs_usage TO brain_app;
`;

export const migration0037: Migration = {
  version: "0037",
  name: "filesystem",
  sql: SQL,
};
