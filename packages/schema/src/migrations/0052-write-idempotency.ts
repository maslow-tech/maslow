import type { Migration } from "./types.js";

/**
 * Write-path idempotency keys — idempotency for the ops CAS cannot cover.
 *
 * CAS (`UPDATE … WHERE id = $1 AND version = $2`) makes `PATCH` retry-safe by
 * construction, but `POST /dash/objects` has no `baseVersion` to conflict on
 * and link edits deliberately do not bump the version, so neither can ever
 * 409. Those mutations carry a client-minted `idempotencyKey` (one per user
 * intent, reused across retries) and record their result HERE, in the same
 * transaction as the write; a replay reads the row back and returns the
 * original result instead of creating a second object or a second edge.
 *
 * CONTENT-BEARING — `result` holds object ids and titles, i.e. brain content
 * that RLS governs everywhere else. So: ENABLE + FORCE ROW LEVEL SECURITY at
 * birth, with the owner predicate as BOTH `USING` and `WITH CHECK`.
 *
 *  - `USING` alone (the shape 0012 uses for derived tables, where the base
 *    table's own policy re-checks the write) is NOT enough here: this table
 *    has no base table behind it. A USING-only policy lets one member INSERT
 *    a dedupe row stamped with ANOTHER member's actor_id, and then read that
 *    member's write results back out of it. The identical predicate as
 *    `WITH CHECK` is what makes the row's owner column non-forgeable.
 *  - NOT `brain_attach_visibility` (0040 on main): that helper's predicate is
 *    OBJECT visibility — it joins the row's `id` (or `from_id`/`to_id`) to
 *    `objects` and defers to the 0012 policy. This table's owner column is
 *    `actor_id` and its PK is a client string, not an object id, so the
 *    helper's shape does not fit. Hand-rolled deliberately; do not "simplify"
 *    it into the helper.
 *  - FORCE means brain_owner is bound too: a session that has not set
 *    app.actor_id sees NOTHING here (fail closed, never disclosure).
 *
 * RETENTION IS PART OF THIS MIGRATION, not a later chore. This table lives on
 * the same EBS volume as PGDATA, the WAL archive and the pgBackRest repo, so
 * rows retained forever are paid for four times over. Dedupe rows are only
 * meaningful for the lifetime of a client retry, so:
 *
 *  - `created_at` is indexed, and
 *  - the write path opportunistically DELETEs rows older than 24h on a
 *    sampled fraction of inserts (cheapest possible retention — no scheduler,
 *    no pg_cron, no extra container), which is why brain_app is granted
 *    DELETE. The table COMMENT below states that rows past 24h are disposable
 *    so nobody later mistakes this for a durable ledger. Losing a row past
 *    24h is harmless: the worst case is a retry that arrives a day late being
 *    treated as a fresh intent.
 *
 * RETENTION SCOPING CAVEAT (deliberate — this paragraph IS the retention
 * contract, so it must not overclaim): the sampled DELETE runs under this
 * table's own FORCE-RLS owner policy, so it only ever sees the PURGING
 * actor's rows — retention is per-actor self-service. Rows belonging to an
 * actor who stops writing (an offboarded member, a revoked token, a one-off
 * service account) are never reaped by the sweep and persist until the
 * accounts ON DELETE CASCADE fires — which for a deactivated-but-kept
 * account is never. The residue per departed actor is bounded (their writes
 * since their own last sampled purge), so this cannot grow unbounded on a
 * live box; but "rows older than 24h are deleted" is only fully true for
 * actors who keep writing. Anything stronger needs a purge in the
 * offboarding path or a brain_system sweep — neither exists today.
 *
 * NO BACKFILL, and therefore NO `SET LOCAL ROLE brain_system` — nothing here
 * reads or writes rows across actors. Do not add one: a cross-actor step in
 * this file would defeat the boundary the file exists to draw.
 *
 * Live-box safe (doctrine rule 1 — never throw on box state you didn't
 * create, in particular the canary-rollback re-run, where this migration
 * applied and the app was then rolled back to a build predating the table):
 * IF NOT EXISTS everywhere, DO-block guards that RAISE NOTICE and skip when
 * the table, the policy, the FORCE flag or the index is already there, and a
 * 5s lock_timeout on the first statement. This migration never ALTERs
 * anything it did not create, and never grants BYPASSRLS to anyone.
 *
 * Known ceiling (accepted): `key` is a GLOBAL primary key, not (actor_id,
 * key). Keys are client-minted random uuids, so a cross-actor collision is
 * negligible; the write path inserts with ON CONFLICT DO NOTHING and then
 * re-reads under RLS, so a colliding key degrades to "not deduped" rather
 * than to a leak or an error.
 */

const OWNER_PREDICATE = `actor_id = nullif(current_setting('app.actor_id', true), '')::uuid`;

const SQL = `
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------- write_idempotency
CREATE TABLE IF NOT EXISTS write_idempotency (
  key        text PRIMARY KEY,
  actor_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  result     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE write_idempotency IS
  'Dedupe records for non-CAS dashboard writes (create object, link edits). '
  'DISPOSABLE: rows older than 24h carry no meaning and are deleted '
  'opportunistically by the write path on a sampled fraction of inserts. '
  'This is not a ledger — never build anything that reads rows older than a '
  'client retry window.';

-- Retention index: the opportunistic purge is
--   DELETE FROM write_idempotency WHERE created_at < now() - interval '24 hours'
-- and it must not seq-scan the table on a busy box.
DO $mig$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'write_idempotency_created_at_idx'
  ) THEN
    RAISE NOTICE '0052: write_idempotency_created_at_idx already present — skipping';
  ELSE
    CREATE INDEX write_idempotency_created_at_idx ON write_idempotency (created_at);
  END IF;
END
$mig$;

-- ------------------------------------------------------------------ RLS
-- Hand-rolled (see the header for why brain_attach_visibility does not fit).
-- The WITH CHECK is the SAME predicate as the USING, deliberately: without it
-- a member could stamp a dedupe row with someone else's actor_id and read
-- that member's write results back.
DO $mig$
BEGIN
  IF to_regclass('public.write_idempotency') IS NULL THEN
    RAISE NOTICE '0052: write_idempotency missing — skipping RLS';
    RETURN;
  END IF;

  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.write_idempotency'::regclass)
     AND (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.write_idempotency'::regclass) THEN
    RAISE NOTICE '0052: write_idempotency already ENABLE+FORCE RLS — leaving it alone';
  ELSE
    ALTER TABLE write_idempotency ENABLE ROW LEVEL SECURITY;
    ALTER TABLE write_idempotency FORCE ROW LEVEL SECURITY;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'write_idempotency'
      AND policyname = 'write_idempotency_owner'
  ) THEN
    RAISE NOTICE '0052: policy write_idempotency_owner already present — skipping';
  ELSE
    -- Issued as a plain PL/pgSQL utility statement, NOT via EXECUTE. Nothing
    -- here is dynamic: the table name is fixed and OWNER_PREDICATE is baked in
    -- by the TypeScript template literal before Postgres ever sees this SQL,
    -- so there is no identifier or literal to quote. Wrapping it in EXECUTE
    -- would trip the repo's %I/%L quoting gate (quoting-lint.ts rule B) for no
    -- benefit — that gate exists to catch EXECUTE sites that interpolate a
    -- runtime value, and it is right to refuse a bare dollar-quoted EXECUTE.
    CREATE POLICY write_idempotency_owner ON write_idempotency
      USING (${OWNER_PREDICATE})
      WITH CHECK (${OWNER_PREDICATE});
  END IF;
END
$mig$;

-- ------------------------------------------------------------------ grants
-- SELECT (replay lookup) + INSERT (record a result) + DELETE (the 24h
-- opportunistic purge). No UPDATE: a recorded result is immutable — a replay
-- must return what the original write returned. Never BYPASSRLS.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    RAISE NOTICE '0052: role brain_app missing — skipping grants';
    RETURN;
  END IF;
  GRANT SELECT, INSERT, DELETE ON write_idempotency TO brain_app;
END
$mig$;
`;

export const migration0052: Migration = {
  version: "0052",
  name: "write-idempotency",
  sql: SQL,
};
