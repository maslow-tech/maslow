import type { Migration } from "./types.js";

/**
 * Private objects (personal brains) + explicit sharing. Two columns and
 * row-level security:
 *   objects.visibility  ∈ ('org','private') — 'private' = creator-only
 *   objects.shared_with uuid[]              — extra accounts a private object
 *                                             is explicitly shared with
 * Enforcement lives in Postgres RLS keyed on app.actor_id (which every
 * read/write txn already sets), so no reader query can forget a filter —
 * brain_app is not the table owner, so the policies bind it everywhere.
 *
 * Coverage: objects (title/body), before_image (edit snapshots), merge_journal
 * (merge snapshots), edges (graph), and every generated ext/junction table
 * (typed props) via brain_attach_visibility, which the table-creator
 * primitives now call. The derived policies are all EXISTS-on-objects, so they
 * compose with the objects policy automatically — sharing included.
 *
 * Known ceilings (accepted, metadata-only):
 * - object events carry no content (payload = version numbers), so events get
 *   no RLS; the timeline may show "actor X updated <uuid>" for an object you
 *   cannot get. think() events DO carry their note text and are org-visible BY
 *   DESIGN — the doctrine forbids personal content in a think.
 * - a ref/edge created while a target was org-visible survives the target
 *   later going private; it exposes only an opaque uuid.
 * - who may CHANGE visibility/shared_with is app-enforced (write path,
 *   creator-only); RLS cannot express per-column rules.
 * - ROLLBACK FAILS CLOSED: if the updater migrates 0012 and then rolls back to
 *   a pre-0012 image, that image's reads never set app.actor_id, so PRIVATE
 *   rows are invisible to everyone (org data unaffected) until the box
 *   re-upgrades. Unavailability, never disclosure — the safe direction.
 */

const SQL = `
-- Migrations run as brain_owner; the audit trigger needs an actor for the
-- personal-page seed INSERTs at the bottom.
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000000', true);

-- This migration takes ACCESS EXCLUSIVE locks on live tables. Fail fast if a
-- long-running txn holds one, instead of queueing every app query behind us
-- on an unattended box (the runner retries a failed migration).
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------------ visibility
ALTER TABLE objects ADD COLUMN visibility text NOT NULL DEFAULT 'org' COLLATE "C"
  CHECK (visibility IN ('org', 'private'));
ALTER TABLE objects ADD COLUMN shared_with uuid[] NOT NULL DEFAULT '{}';

-- ------------------------------------------------------------------ RLS: spine
ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_visibility ON objects
  USING (visibility = 'org'
      OR created_by = nullif(current_setting('app.actor_id', true), '')::uuid
      OR nullif(current_setting('app.actor_id', true), '')::uuid = ANY(shared_with))
  WITH CHECK (visibility = 'org'
      OR created_by = nullif(current_setting('app.actor_id', true), '')::uuid
      OR nullif(current_setting('app.actor_id', true), '')::uuid = ANY(shared_with));

-- The WITH CHECK above is only meaningful if brain_app cannot rewrite
-- created_by: narrow the blanket UPDATE grant to the columns the app writes.
REVOKE UPDATE ON objects FROM brain_app;
GRANT UPDATE (title, body, version, updated_at, deleted_at, deleted_by, visibility, shared_with)
  ON objects TO brain_app;

-- before_image / merge_journal snapshots carry title/body — visible iff the
-- object is (the EXISTS runs under the objects policy for brain_app).
ALTER TABLE before_image ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_visibility ON before_image
  USING (EXISTS (SELECT 1 FROM objects o WHERE o.id = object_id));

ALTER TABLE merge_journal ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_visibility ON merge_journal
  USING (EXISTS (SELECT 1 FROM objects o WHERE o.id = winner));

-- an edge is visible iff BOTH endpoints are.
ALTER TABLE edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY brain_visibility ON edges
  USING (EXISTS (SELECT 1 FROM objects a WHERE a.id = from_id)
     AND EXISTS (SELECT 1 FROM objects b WHERE b.id = to_id));

-- ------------------------------------------------------------------ RLS: generated tables
-- One policy shape for every generated table. Junctions (from_id/to_id) need
-- both endpoints; ext tables hang off their parent object row.
CREATE OR REPLACE FUNCTION brain_attach_visibility(p_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_is_junction boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = p_table AND column_name = 'from_id'
  ) INTO v_is_junction;
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  IF v_is_junction THEN
    EXECUTE format(
      'CREATE POLICY brain_visibility ON %I
         USING (EXISTS (SELECT 1 FROM objects a WHERE a.id = %I.from_id)
            AND EXISTS (SELECT 1 FROM objects b WHERE b.id = %I.to_id))',
      p_table, p_table, p_table);
  ELSE
    EXECUTE format(
      'CREATE POLICY brain_visibility ON %I
         USING (EXISTS (SELECT 1 FROM objects o WHERE o.id = %I.id))',
      p_table, p_table);
  END IF;
END
$fn$;
REVOKE EXECUTE ON FUNCTION brain_attach_visibility(text) FROM PUBLIC;

-- Re-issue the creator primitives so every FUTURE ext/junction table gets the
-- policy at birth (OR REPLACE keeps the existing REVOKEs).
CREATE OR REPLACE FUNCTION brain_create_ext_table(p_ext_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TABLE %I (
       id uuid PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
       deleted_at timestamptz,
       tsv tsvector
     )', p_ext_table);
  EXECUTE format('CREATE INDEX ON %I USING gin (tsv)', p_ext_table);
  PERFORM brain_attach_visibility(p_ext_table);
END
$fn$;

CREATE OR REPLACE FUNCTION brain_create_junction(
  p_junction text, p_from_ext text, p_to_ext text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TABLE %I (
       from_id uuid NOT NULL REFERENCES %I(id) ON DELETE CASCADE,
       to_id   uuid NOT NULL REFERENCES %I(id) ON DELETE CASCADE,
       PRIMARY KEY (from_id, to_id)
     )', p_junction, p_from_ext, p_to_ext);
  PERFORM brain_attach_visibility(p_junction);
END
$fn$;

-- ...and attach it to every EXISTING generated table.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT name FROM physical_name WHERE kind = 'table'
  LOOP
    PERFORM brain_attach_visibility(r.name);
  END LOOP;
END
$do$;

-- ------------------------------------------------------------------ edge census
-- Definer (owner bypasses RLS): the TRUE number of edges touching an object,
-- regardless of who can see them. Count only — never row content. The write
-- path compares it with the caller-visible count to refuse a merge that would
-- silently skip re-pointing links hidden inside someone's private objects, and
-- referrers() reports the difference as hidden_from_you.
CREATE OR REPLACE FUNCTION brain_edge_count(p_id uuid, p_inbound_only boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF p_inbound_only THEN
    SELECT count(*)::int INTO v_n FROM edges WHERE to_id = p_id;
  ELSE
    SELECT count(*)::int INTO v_n FROM edges WHERE from_id = p_id OR to_id = p_id;
  END IF;
  RETURN v_n;
END
$fn$;
REVOKE EXECUTE ON FUNCTION brain_edge_count(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_edge_count(uuid, boolean) TO brain_app, brain_owner;

-- ------------------------------------------------------------------ personal pages
-- Every active member/owner gets one private home page (new accounts get
-- theirs in createMember/bootstrapOwner). Attributed to the system actor set
-- at the top of this migration.
INSERT INTO objects (title, body, visibility, created_by)
SELECT a.name || ' — personal',
       'Private page for ' || a.name || '. Objects with visibility ''private'' — ' ||
       'including this one — are visible only to their creator (and any accounts ' ||
       'in shared_with). Keep personal context here; keep org knowledge org-visible.',
       'private', a.id
FROM accounts a
WHERE a.role IN ('owner', 'member') AND a.status = 'active';
`;

export const migration0012: Migration = {
  version: "0012",
  name: "private-visibility",
  sql: SQL,
};
