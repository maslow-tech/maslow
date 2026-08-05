import type { Migration } from "./types.js";

/**
 * Per-member saved views. A named, pinnable snapshot of a
 * workspace view's configuration: the database view-config
 * (filter/sort/group/layout/columns) today, and the graph view
 * (filters, forces, camera, focus) later.
 *
 * `kind` ALREADY INCLUDES 'graph'. The graph view therefore needs no second
 * migration: migrations are append-only and every one of them runs unattended
 * on live production boxes, so a value we already know we need ships now rather
 * than as a second live-box event later. Same reasoning as 0053's `state` /
 * `animating_target_version`.
 *
 * `scope` is the view-config's subject — the type name for a database view,
 * NULL for a global/all-objects one. It is deliberately plain text and NOT a
 * FK to `types`: a saved view whose type was renamed or dropped should go
 * stale in the sidebar, not cascade-delete or block the rename.
 *
 * ---------------------------------------------------------------- RLS route
 * HAND-ROLLED, both clauses. `brain_attach_visibility(p_table text)` (main's
 * force-rls migration) was checked first and does NOT fit: its predicate is
 * OBJECT visibility — it joins the row's own `id` (or `from_id`/`to_id`) to
 * `objects` and defers to the 0012 policy. This table's owner column is
 * `member_id` and its `id` is a view id, not an object id, so the helper
 * would generate a policy referencing a row that does not exist. Hand-rolled
 * deliberately; do not "simplify" it into the helper.
 *
 * POLICY SHAPE IS STATED, NOT INHERITED. The predicate appears BOTH as
 * `USING` and — identically — as `WITH CHECK`:
 *
 *  - The 0012 derived-table shape is `USING`-only, which is safe there only
 *    because a base table's own policy re-checks the write. This table has no
 *    base table behind it. With `USING` alone a member could INSERT or UPDATE
 *    a row stamped with ANOTHER member's `member_id`, planting an
 *    attacker-chosen pinned view — carrying filters, camera and focus — into
 *    someone else's sidebar chrome. That is click-target injection into
 *    trusted UI, not a data-hygiene nit: the victim clicks their own sidebar
 *    and lands somewhere the attacker chose.
 *  - `WITH CHECK` is also what makes `member_id` non-forgeable on UPDATE: a
 *    member may not hand one of their own views to somebody else's sidebar by
 *    rewriting the owner column.
 *
 * ENABLE + FORCE ROW LEVEL SECURITY AT BIRTH, because `config` is
 * CONTENT-BEARING: filter literals ("title contains …", a property value) and
 * a saved focus embed private object ids and titles, i.e. brain content that
 * RLS governs everywhere else. FORCE binds the table owner (`brain_owner`)
 * too, so no request-serving path is exempt. A session that has not set
 * `app.actor_id` sees NOTHING here and can write nothing — the rollback case
 * (an image predating this migration, which never sets `app.actor_id`) fails
 * in the safe direction: unavailability, never disclosure.
 *
 * NO BACKFILL, and therefore NO `SET LOCAL ROLE brain_system`. Nothing in this
 * file reads or writes rows across actors — the table starts empty and is
 * filled by the running app (phase 3's localStorage views are migrated by the
 * client, under the member's own session, not by this migration). Do not add a
 * cross-actor step here: it would defeat the boundary this file exists to draw.
 *
 * UNIQUENESS is `(member_id, kind, scope, name)` — one name per member, per
 * kind, per scope — written with `coalesce(scope, '')` so the GLOBAL case
 * (scope IS NULL) is actually deduped. A plain four-column unique index does
 * not: SQL NULLs are distinct, so a member could create ten global views all
 * called "My view" and get ten identical sidebar entries. `NULLS NOT
 * DISTINCT` would express the same thing, but it is Postgres 15+, and a
 * migration that syntax-errors on an older box throws → the updater latches
 * after 3 attempts → the box silently stops updating (a production latch incident).
 * The expression form runs everywhere.
 *
 * `updated_at` is maintained by the app on write, not by a trigger — there is
 * no touch-trigger convention in this schema and adding one for a chrome table
 * would put a fleet-wide trigger on the critical path of a cosmetic feature.
 *
 * Live-box safe (doctrine rule 1 — never throw on box state you didn't create,
 * in particular the canary-rollback re-run where this migration applied and
 * the app was then rolled back to a build predating the table): IF NOT EXISTS
 * everywhere, DO-block guards that RAISE NOTICE and skip when the table, the
 * check constraint, the unique index, the policy or the FORCE flag is already
 * present, and a 5s lock_timeout on the first statement. This migration never
 * ALTERs anything it did not create, and never grants BYPASSRLS to anyone.
 */

const OWNER_PREDICATE = `member_id = nullif(current_setting('app.actor_id', true), '')::uuid`;

const SQL = `
SET LOCAL lock_timeout = '5s';

-- --------------------------------------------------------------- saved_views
CREATE TABLE IF NOT EXISTS saved_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'database'
               CONSTRAINT saved_views_kind_check
               CHECK (kind IN ('database', 'graph')),
  scope      text,
  name       text NOT NULL,
  config     jsonb NOT NULL,
  pinned     boolean NOT NULL DEFAULT false,
  position   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE saved_views IS
  'Per-member named workspace views: kind=database (phase-3 view-config: '
  'filter/sort/group/layout/columns) or kind=graph (phase-6 filters, forces, '
  'camera, focus). scope is the type name the view is bound to, NULL for a '
  'global one. CONTENT-BEARING: config embeds filter literals and a saved '
  'focus, so it carries object ids and titles — hence FORCE RLS, owner '
  'predicate as USING *and* WITH CHECK. Rows are per-member and NEVER shared; '
  'sharing a view with another member is deliberately not a feature here.';

-- The CHECK travels with CREATE TABLE above; this only heals a box where the
-- table already exists from an earlier partial run of THIS migration.
DO $mig$
BEGIN
  IF to_regclass('public.saved_views') IS NULL THEN
    RAISE NOTICE '0054: saved_views missing — skipping kind check constraint';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.saved_views'::regclass
      AND conname = 'saved_views_kind_check'
  ) THEN
    RAISE NOTICE '0054: saved_views_kind_check already present — skipping';
  ELSE
    -- The offending-rows test is an EXCEPTION handler, not a SELECT pre-check:
    -- by the time this runs on a re-applied box the table is FORCE RLS, and the
    -- migration runner (brain_owner) is bound by that policy with no
    -- app.actor_id set — so a pre-check would see zero rows and then the ALTER
    -- would validate against ALL of them and throw. Doctrine rule 1: a box we
    -- did not create keeps running, it does NOT stop updating.
    BEGIN
      ALTER TABLE saved_views ADD CONSTRAINT saved_views_kind_check
        CHECK (kind IN ('database', 'graph'));
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE '0054: saved_views rows outside the kind enum — leaving the constraint off';
    END;
  END IF;
END
$mig$;

-- One name per member, per kind, per scope. coalesce(scope, '') so the global
-- (scope IS NULL) case is deduped too — see the header for why this is not a
-- plain four-column index and not NULLS NOT DISTINCT.
DO $mig$
BEGIN
  IF to_regclass('public.saved_views') IS NULL THEN
    RAISE NOTICE '0054: saved_views missing — skipping unique index';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'saved_views_member_kind_scope_name_idx'
  ) THEN
    RAISE NOTICE '0054: saved_views_member_kind_scope_name_idx already present — skipping';
  ELSE
    -- Duplicates can only exist on a box that ran an earlier partial version of
    -- this migration. They are caught by an EXCEPTION handler rather than a
    -- SELECT … HAVING count(*) > 1 pre-check for the same reason as the CHECK
    -- above: on a re-applied box this table is FORCE RLS and brain_owner sees
    -- none of the rows, but the index build sees all of them. Skipping the
    -- index degrades the app's upsert to "creates a second row" — cosmetic,
    -- not a data or privacy fault — whereas throwing latches the updater.
    BEGIN
      CREATE UNIQUE INDEX saved_views_member_kind_scope_name_idx
        ON saved_views (member_id, kind, coalesce(scope, ''), name);
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE '0054: duplicate saved_views names present — leaving the unique index off';
    END;
  END IF;
END
$mig$;

-- ------------------------------------------------------------------- RLS
-- Hand-rolled (see the header for why brain_attach_visibility does not fit).
-- The WITH CHECK is the SAME predicate as the USING, deliberately: USING alone
-- would let a member INSERT or UPDATE a row stamped with another member's
-- member_id and plant a pinned view in that member's sidebar.
DO $mig$
BEGIN
  IF to_regclass('public.saved_views') IS NULL THEN
    RAISE NOTICE '0054: saved_views missing — skipping RLS';
    RETURN;
  END IF;

  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.saved_views'::regclass)
     AND (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.saved_views'::regclass) THEN
    RAISE NOTICE '0054: saved_views already ENABLE+FORCE RLS — leaving it alone';
  ELSE
    ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
    ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'saved_views'
      AND policyname = 'saved_views_owner'
  ) THEN
    RAISE NOTICE '0054: policy saved_views_owner already present — skipping';
  ELSE
    -- A plain PL/pgSQL utility statement, NOT an EXECUTE: nothing here is
    -- dynamic (the table name is fixed and OWNER_PREDICATE is baked in by the
    -- TypeScript template literal before Postgres sees this SQL), so there is
    -- no identifier or literal to quote and no reason to trip the repo's
    -- %I/%L quoting gate (quoting-lint.ts rule B).
    CREATE POLICY saved_views_owner ON saved_views
      USING (${OWNER_PREDICATE})
      WITH CHECK (${OWNER_PREDICATE});
  END IF;
END
$mig$;

-- ------------------------------------------------------------------ grants
-- The request-serving role only. SELECT (list the sidebar), INSERT (save a
-- view), UPDATE (rename, repin, reorder, re-save the config), DELETE (remove
-- one). No grant to any other role, and never BYPASSRLS: saved views are just
-- another RLS-bound per-member table.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    RAISE NOTICE '0054: role brain_app missing — skipping grants';
    RETURN;
  END IF;
  GRANT SELECT, INSERT, UPDATE, DELETE ON saved_views TO brain_app;
END
$mig$;
`;

export const migration0054: Migration = {
  version: "0054",
  name: "saved-views",
  sql: SQL,
};
