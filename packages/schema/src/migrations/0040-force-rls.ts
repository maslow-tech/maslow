import type { Migration } from "./types.js";

/**
 * FORCE ROW LEVEL SECURITY — close the owner-by-ownership bypass (privacy
 * invariant, part 3: "private is readable by no one but its author, ever —
 * including a box owner").
 *
 * Background. 0012 only `ENABLE`d RLS. A table owner bypasses ENABLE'd RLS by
 * ownership, so brain_owner (the executor + the branding/favicon dashboard
 * client + the embed sweep) could read every member's private object. Today no
 * request-serving path uses brain_owner for content, but one future wiring
 * mistake — a content query on the owner client — would silently leak every
 * private object, and no test would catch it (privilege-audit only checked
 * `relrowsecurity`). This migration makes the boundary structural.
 *
 * What FORCE changes. Under FORCE ROW LEVEL SECURITY even the table owner is
 * subject to the policies. brain_owner is NOBYPASSRLS, so after this it sees
 * only org rows + rows for whatever app.actor_id it happens to have set (none,
 * on the executor/branding paths → private invisible, fail-closed).
 *
 * The one legitimate all-rows reader — brain_system. Two jobs genuinely need
 * to read across actors: the embed sweep (every private object must still be
 * embedded so its creator can semantic-search it) and brain_edge_count (the
 * true edge census that lets merge/referrers report links hidden inside
 * someone's private objects). Both move to brain_system (NOLOGIN, BYPASSRLS,
 * created in roles.ts). BYPASSRLS overrides FORCE. brain_system is reached ONLY
 * via `SET ROLE brain_system` from brain_owner — never a login credential, and
 * BYPASSRLS is not inherited through the membership, so no ordinary brain_owner
 * or brain_app connection can cross the boundary. brain_system is granted the
 * minimum table privileges it needs (SELECT objects/edges; SELECT/INSERT/DELETE
 * object_chunks) — BYPASSRLS skips the policies, not the base GRANTs.
 *
 * Scope. FORCE is applied to exactly the tables 0012/0029 put RLS on: objects,
 * before_image, merge_journal, edges, object_chunks (if pgvector is present),
 * and every generated ext/junction table. `fs_entries` is already FORCE (0037)
 * and is skipped. The `events` table is deliberately NOT brought under RLS in
 * this migration — its lifecycle rows carry no title/body (version numbers and
 * an opaque target uuid only), the metadata leak is a documented, accepted
 * ceiling (0012), and adding RLS there risks recent/history/activityFeed/
 * call-audit for no content gain.
 *
 * Migration-doctrine (runs live on a user's real data):
 * - Pure DDL + GRANT + one ALTER FUNCTION OWNER. brain_owner can always run
 *   DDL on tables it owns; FORCE only gates row DML, so this migration itself
 *   touches no rows and cannot be RLS-constrained.
 * - Never throws on box state it didn't create: object_chunks is guarded (a box
 *   without pgvector never made it), and the generated-table loop is derived
 *   from physical_name, exactly like 0012's own loop.
 * - Going forward, any migration that BACKFILLS rows across actors must
 *   `SET LOCAL ROLE brain_system` for that step (documented in CLAUDE.md).
 *   Nothing after 0039 does so yet.
 *
 * Rollback: rolling back to a pre-0039 image simply restores owner-by-ownership
 * bypass (FORCE dropped with the image's schema view) — availability, never
 * disclosure; the safe direction, same as 0012.
 */

const SQL = `
-- DDL only; the audit trigger is not armed here, but keep the convention.
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000000', true);

-- Same courtesy as 0012: fail fast rather than queue every app query behind an
-- ACCESS EXCLUSIVE lock on an unattended box (the runner retries).
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------- brain_system grants
-- BYPASSRLS skips policies, not table privileges. Grant the minimum the sweep
-- and the edge census need. (Role + membership were created in roles.ts, run
-- as superuser before this migration.)
-- USAGE to reference tables; CREATE because a role can only be made the OWNER
-- of an object (brain_edge_count, below) in a schema where it may create — a
-- one-time requirement of ALTER FUNCTION ... OWNER TO. Harmless: brain_system
-- is NOLOGIN and reached only via SET ROLE from brain_owner, which already owns
-- the schema outright, so this adds no reachable capability.
GRANT USAGE, CREATE ON SCHEMA public TO brain_system;
GRANT SELECT ON objects TO brain_system;
GRANT SELECT ON edges   TO brain_system;

-- ------------------------------------------------------------- FORCE the spine
ALTER TABLE objects       FORCE ROW LEVEL SECURITY;
ALTER TABLE before_image  FORCE ROW LEVEL SECURITY;
ALTER TABLE merge_journal FORCE ROW LEVEL SECURITY;
ALTER TABLE edges         FORCE ROW LEVEL SECURITY;

-- object_chunks exists only where pgvector was installable (0029). Guard it,
-- and hand the sweep its write privileges.
DO $chunks$
BEGIN
  IF to_regclass('public.object_chunks') IS NOT NULL THEN
    -- Identifier is a constant, but the %I/%L lint gate requires format() for
    -- every dynamic EXECUTE — keep the gate total, no bare-string exceptions.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', 'object_chunks');
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I TO brain_system', 'object_chunks');
  ELSE
    RAISE NOTICE '0039: object_chunks absent (no pgvector) — chunk FORCE skipped';
  END IF;
END
$chunks$;

-- ------------------------------------------------------------- FORCE generated tables
-- Every ext/junction table carries the same brain_visibility policy (0012).
-- FORCE each so the owner can't read a private object's typed props either.
DO $gen$
DECLARE r record;
BEGIN
  FOR r IN SELECT name FROM physical_name WHERE kind = 'table'
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.name);
  END LOOP;
END
$gen$;

-- ------------------------------------------------------------- future tables
-- Re-issue the visibility attacher so tables created AFTER 0039 (new typed
-- properties) get FORCE at birth, not just ENABLE. OR REPLACE keeps the REVOKE.
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
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
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

-- ------------------------------------------------------------- edge census → brain_system
-- The SECURITY DEFINER census (0012) runs as its owner. Under FORCE, if the
-- owner is brain_owner (RLS-bound) it would count only visible edges — the
-- opposite of its purpose. Reassign it to brain_system so it keeps returning
-- the TRUE count (used only to report "N links hidden from you", never content).
ALTER FUNCTION brain_edge_count(uuid, boolean) OWNER TO brain_system;
`;

export const migration0040: Migration = {
  version: "0040",
  name: "force-rls",
  sql: SQL,
};
