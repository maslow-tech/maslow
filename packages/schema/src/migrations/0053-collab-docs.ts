import type { Migration } from "./types.js";

/**
 * Collab room persistence — the Yjs blob behind a live editing room.
 *
 * Markdown in `objects` stays the single source of truth AT REST. This table
 * holds only the room's in-flight CRDT state plus the bookkeeping that makes a
 * restart safe:
 *
 *  - `blob`                    compacted Yjs snapshot (see COMPACTION below).
 *  - `last_flushed_version`    the `objects.version` the blob was last
 *                              reconciled to. Equal to the object's current
 *                              version ⇒ resume the blob; different ⇒ rebase
 *                              it (an MCP/CAS write landed while the room was
 *                              down). A blob is never resumed over a NEWER
 *                              object version — that would revert an
 *                              acknowledged agent write.
 *  - `epoch`                   doc epoch advertised in the sync handshake. A
 *                              client holding a live Y.Doc across an app
 *                              recreate must not merge it into a freshly
 *                              re-seeded server doc (Yjs would treat identical
 *                              paragraphs as two independent insert sequences
 *                              and duplicate the body end to end); on epoch
 *                              change the client discards local Y state.
 *  - `state` / `animating_target_version`
 *                              room lifecycle: 'idle' | 'draining' (teardown
 *                              is serialized against joins — final flush
 *                              commits before a mid-drain join seeds) |
 *                              'animating' (phase 5 agent cursors: while an
 *                              agent write is applied in chunks the row holds
 *                              the target `objects.version`, flushes are
 *                              suspended, and a room resuming an 'animating'
 *                              blob IGNORES it and re-seeds from stored
 *                              markdown — which already contains the whole
 *                              committed agent write, so a crash mid-animation
 *                              cannot revert it).
 *
 * BOTH `state` and `animating_target_version` exist FROM BIRTH deliberately.
 * Phase 5 needs no second migration: migrations are append-only and every one
 * of them runs unattended on live production boxes, so a column we already know
 * we need ships now rather than as a second live-box event later.
 *
 * ---------------------------------------------------------------- RLS route
 * HAND-ROLLED, both clauses. `brain_attach_visibility(p_table text)` was
 * checked first and does NOT fit:
 *
 *  - Its non-junction branch emits `EXISTS (SELECT 1 FROM objects o WHERE
 *    o.id = <table>.id)`. It assumes the table's own PRIMARY KEY *is* the
 *    object id and is literally named `id`. Here the FK column is
 *    `object_id`, so the helper would generate a policy referencing a
 *    column this table does not have.
 *  - The shape it creates is `USING`-only (the 0012 derived-table shape,
 *    where the base table's own policy re-checks the write). That is not
 *    enough for a table the collab server INSERTs into directly: a USING-only
 *    policy would let an actor write an update blob for an object they cannot
 *    see. This table therefore repeats the IDENTICAL predicate as
 *    `WITH CHECK`, and does its own ENABLE + FORCE.
 *
 * The predicate is spelled out rather than delegated to the objects policy
 * (`EXISTS (SELECT 1 FROM objects o WHERE o.id = object_id)`) on purpose: that
 * shorter form is only equivalent while the reading role is itself RLS-bound
 * on `objects`, and FORCE on THIS table would otherwise leave `brain_owner`
 * seeing every room's blob through an unfiltered subquery. Spelling it out
 * fails closed for every role, in every order the fleet's migrations land.
 *
 * THE ROW PREDICATE IS THE OBJECT'S VISIBILITY, NOT THE BLOB'S CREATOR. This
 * is the whole reason the table exists: a per-creator policy would make a
 * shared room's blob unreadable to the SECOND person who joins, i.e. it would
 * break multiplayer precisely where multiplayer starts. Consequences, both
 * intended: an org-visible object's room is joinable by every member; a
 * private object's room is reachable only by its creator and the accounts in
 * `shared_with`, so presence in that room can never reveal to anyone else that
 * the object exists (the privacy invariant, unchanged).
 *
 * The collab server reads and writes this table under the SAME request-serving
 * role and actor as any other write — `brain_app` with `app.actor_id` set,
 * never `brain_system`, never any BYPASSRLS path. FORCE binds the table owner
 * (`brain_owner`) too, so no request-serving path is exempt. A session that
 * has not set `app.actor_id` still sees ORG-visible rooms — that is the
 * predicate, not an oversight — and, because the predicate's first arm
 * (`o.visibility = 'org'`) is actor-independent and serves as the WITH CHECK
 * too, such a session CAN also INSERT/UPDATE/DELETE an org-visible object's
 * room blob. Do NOT assume "no actor ⇒ read-only" here (0052/0054's identical
 * claims hold only because their predicates are pure actor-equality); no
 * shipped path writes this table without set_config, but a maintenance script
 * that relied on it would silently be able to corrupt org room state. What an
 * actor-less session can never do is see or touch a PRIVATE room, so the
 * rollback case (an image predating this migration, which never sets
 * `app.actor_id`) still fails in the safe direction for the boundary that
 * matters: unavailability of private rooms, never disclosure. Exactly the
 * ceiling 0012 documents for `objects`.
 *
 * NO BACKFILL, and therefore NO `SET LOCAL ROLE brain_system`. Nothing in this
 * file reads or writes rows across actors — the table starts empty and is
 * filled by the running app. Do not add a cross-actor step here: it would
 * defeat the boundary this file exists to draw.
 *
 * Live-box safe (doctrine rule 1 — never throw on box state you didn't create,
 * in particular the canary-rollback re-run where this migration applied and
 * the app was then rolled back to a build predating the table): IF NOT EXISTS
 * everywhere, DO-block guards that RAISE NOTICE and skip when the table, the
 * check constraint, the policy or the FORCE flag is already present, and a 5s
 * lock_timeout on the first statement. This migration never ALTERs anything it
 * did not create, and never grants BYPASSRLS to anyone.
 */

const VISIBILITY_PREDICATE = `EXISTS (
    SELECT 1 FROM objects o
    WHERE o.id = collab_docs.object_id
      AND (o.visibility = 'org'
        OR o.created_by = nullif(current_setting('app.actor_id', true), '')::uuid
        OR nullif(current_setting('app.actor_id', true), '')::uuid = ANY(o.shared_with)))`;

const SQL = `
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------- collab_docs
CREATE TABLE IF NOT EXISTS collab_docs (
  object_id                 uuid PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  blob                      bytea NOT NULL,
  epoch                     bigint NOT NULL DEFAULT 1,
  last_flushed_version      bigint NOT NULL,
  state                     text NOT NULL DEFAULT 'idle'
                              CONSTRAINT collab_docs_state_check
                              CHECK (state IN ('idle', 'draining', 'animating')),
  animating_target_version  bigint,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE collab_docs IS
  'Live Yjs room state for one object. Markdown in objects is the source of '
  'truth at rest; this holds only in-flight CRDT state. COMPACTION: the blob '
  'is a SNAPSHOT rewritten on every flush and the update log is dropped — an '
  'append-only Yjs log grows without bound on a volume it shares with PGDATA, '
  'the WAL archive and the pgBackRest repo, and it would retain every '
  'insertion INCLUDING text the author later deleted, which neither the body, '
  'the before-image nor history retain (cf. 0028-redact-connector-history). '
  'PURGE: rows are deleted on room teardown, on object delete/trash, and on a '
  'visibility narrowing. Never build anything that treats a row here as a '
  'durable record — it is disposable by design.';

-- The CHECK travels with CREATE TABLE above; this only heals a box where the
-- table already exists from an earlier partial run of THIS migration.
DO $mig$
BEGIN
  IF to_regclass('public.collab_docs') IS NULL THEN
    RAISE NOTICE '0053: collab_docs missing — skipping state check constraint';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.collab_docs'::regclass
      AND conname = 'collab_docs_state_check'
  ) THEN
    RAISE NOTICE '0053: collab_docs_state_check already present — skipping';
  ELSE
    -- The offending-rows test is an EXCEPTION handler, NOT a SELECT pre-check:
    -- collab_docs is FORCE RLS below with an OBJECT-visibility predicate, so on a
    -- re-applied box the migration runner (brain_owner, no app.actor_id) sees
    -- only org-object rows — a private-object room row outside the enum is
    -- RLS-hidden from the pre-check yet still validated by the ALTER (DDL
    -- validation is not RLS-filtered), which would throw check_violation and
    -- latch the updater. Doctrine rule 1: a box we did not create keeps running,
    -- it does NOT stop updating. (Matches 0054-saved-views' identical construct.)
    BEGIN
      ALTER TABLE collab_docs ADD CONSTRAINT collab_docs_state_check
        CHECK (state IN ('idle', 'draining', 'animating'));
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE '0053: collab_docs rows outside the state enum — leaving the constraint off';
    END;
  END IF;
END
$mig$;

-- ------------------------------------------------------------------- RLS
-- Hand-rolled (see the header for why brain_attach_visibility does not fit).
-- The WITH CHECK is the SAME predicate as the USING, deliberately: USING alone
-- would let an actor INSERT a blob for an object they cannot see.
DO $mig$
BEGIN
  IF to_regclass('public.collab_docs') IS NULL THEN
    RAISE NOTICE '0053: collab_docs missing — skipping RLS';
    RETURN;
  END IF;

  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.collab_docs'::regclass)
     AND (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.collab_docs'::regclass) THEN
    RAISE NOTICE '0053: collab_docs already ENABLE+FORCE RLS — leaving it alone';
  ELSE
    ALTER TABLE collab_docs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE collab_docs FORCE ROW LEVEL SECURITY;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'collab_docs'
      AND policyname = 'collab_docs_visibility'
  ) THEN
    RAISE NOTICE '0053: policy collab_docs_visibility already present — skipping';
  ELSE
    -- A plain PL/pgSQL utility statement, NOT an EXECUTE: nothing here is
    -- dynamic (the table name is fixed and the predicate is baked in by the
    -- TypeScript template literal before Postgres sees this SQL), so there is
    -- no identifier or literal to quote and no reason to trip the repo's
    -- %I/%L quoting gate (quoting-lint.ts rule B).
    CREATE POLICY collab_docs_visibility ON collab_docs
      USING (${VISIBILITY_PREDICATE})
      WITH CHECK (${VISIBILITY_PREDICATE});
  END IF;
END
$mig$;

-- ------------------------------------------------------------------ grants
-- The request-serving role only. SELECT (seed/resume a room), INSERT (first
-- persist), UPDATE (every flush rewrites blob + last_flushed_version + state),
-- DELETE (teardown / object trash / visibility narrowing purge). No grant to
-- any other role, and never BYPASSRLS: the collab server is just another
-- RLS-bound writer.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    RAISE NOTICE '0053: role brain_app missing — skipping grants';
    RETURN;
  END IF;
  GRANT SELECT, INSERT, UPDATE, DELETE ON collab_docs TO brain_app;
END
$mig$;
`;

export const migration0053: Migration = {
  version: "0053",
  name: "collab-docs",
  sql: SQL,
};
