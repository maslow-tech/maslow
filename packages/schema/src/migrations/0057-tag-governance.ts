import type { Migration } from "./types.js";

/**
 * Tag governance. One primitive replaces the binary org/private model:
 *
 *   tags         — personal (one per account), the org singleton, and
 *                  owner-created custom group tags.
 *   account_tags — who holds which tag.
 *   objects.audience — DNF rows of tag-id strings: a caller sees a row when
 *                  they hold EVERY tag in AT LEAST ONE audience row.
 *
 * This migration mints the org + personal tags (trigger keeps new accounts
 * covered), heals the always-provisioned teammate account, backfills audience
 * from the legacy visibility/shared_with columns behavior-preservingly, and
 * swaps the objects RLS policy to brain_can_see(audience). The legacy columns
 * stay (the Writer dual-writes them for one release); a later release drops
 * them once the fleet has proven audience.
 *
 * Migration doctrine (runs on live boxes, real data):
 * - Never throws on box state it didn't create: the teammate heal is wrapped
 *   (no owner / duplicate email ⇒ NOTICE + skip, the box keeps updating), the
 *   mint sweeps are ON CONFLICT DO NOTHING, and the backfill only touches rows
 *   still at the '[]' default.
 * - Cross-actor steps (mint sweep, audience backfill) run under
 *   SET LOCAL ROLE brain_system (FORCE RLS binds brain_owner since 0040);
 *   BYPASSRLS skips policies, not GRANTs, so brain_system gets the minimum
 *   table privileges it needs here.
 * - The backfill UPDATE disables brain_objects_audit (a compile of existing
 *   visibility into audience is not a user action — same rationale as 0018)
 *   AND brain_objects_biconditional (a plain fn that reads types + ext tables,
 *   which brain_system has no GRANTs on; the UPDATE can't change type/liveness
 *   so the invariant is untouched). SET CONSTRAINTS ALL IMMEDIATE first, per
 *   the 0018 pending-trigger-events lesson.
 * - Deliberate creator compat escape in the policy: an UNSTAMPED row
 *   (audience = '[]') is visible to — and writable by — its CREATOR only.
 *   Until the Writer stamps audience (the very next task in this wave), every
 *   INSERT still carries the '[]' default, and Postgres applies the SELECT
 *   half of the policy to INSERT ... RETURNING (which every Writer insert
 *   uses) — a strict policy would hard-refuse ALL writes on a box mid-update.
 *   Creator-only is strictly narrower than the legacy policy (where the
 *   default was org-visible), so this is fail-closed, never a leak. The
 *   escape goes away when the legacy columns are dropped.
 *
 * Rollback: a pre-0057 image still reads the legacy columns and its policy
 * swap is re-applied by that image's schema view — availability preserved,
 * never disclosure (audience is strictly narrower than the legacy policy for
 * unstamped rows).
 */

const UUID_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const SQL = `
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------- tables
CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE COLLATE "C" CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  kind text NOT NULL COLLATE "C" CHECK (kind IN ('personal','org','custom')),
  account_id uuid REFERENCES accounts(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal') = (account_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_one_personal_per_account ON tags(account_id) WHERE kind = 'personal';
CREATE UNIQUE INDEX IF NOT EXISTS tags_org_singleton ON tags(kind) WHERE kind = 'org';

CREATE TABLE IF NOT EXISTS account_tags (
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tag_id, account_id)
);
CREATE INDEX IF NOT EXISTS account_tags_by_account ON account_tags(account_id);

-- FORCE RLS at birth (doctrine). Tag NAMES are org-readable (the share sheet
-- needs them); NO mutation policy exists — every write goes through the
-- SECURITY DEFINER governance fns below, so no request-serving role can mutate
-- either table directly, agents included.
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
ALTER TABLE account_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tags_read ON tags;
CREATE POLICY tags_read ON tags FOR SELECT USING (true);
DROP POLICY IF EXISTS account_tags_read ON account_tags;
CREATE POLICY account_tags_read ON account_tags FOR SELECT USING (true);
GRANT SELECT ON tags, account_tags TO brain_app;

-- BYPASSRLS skips policies, not GRANTs (0040 lesson): the governance fns and
-- mint paths execute as brain_system and need real table privileges.
GRANT SELECT, INSERT, UPDATE, DELETE ON tags, account_tags TO brain_system;
GRANT SELECT ON accounts TO brain_system;
GRANT UPDATE (token_hash) ON accounts TO brain_system;

-- ---------------------------------------------------------------- default-tag trigger
-- New accounts get their tags at birth — a trigger, so no app path can forget.
-- SECURITY DEFINER (owner brain_system) because the inserting role (brain_app
-- via the createUser definer chain) has no INSERT on the tag tables.
CREATE OR REPLACE FUNCTION brain_mint_default_tags() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_tag uuid;
BEGIN
  INSERT INTO tags (slug, kind, account_id)
    VALUES ('person-' || left(NEW.id::text, 8), 'personal', NEW.id)
    ON CONFLICT DO NOTHING RETURNING id INTO v_tag;
  IF v_tag IS NOT NULL THEN
    INSERT INTO account_tags (tag_id, account_id) VALUES (v_tag, NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO account_tags (tag_id, account_id)
    SELECT id, NEW.id FROM tags WHERE kind = 'org' ON CONFLICT DO NOTHING;
  RETURN NEW;
END $fn$;
ALTER FUNCTION brain_mint_default_tags() OWNER TO brain_system;
DROP TRIGGER IF EXISTS accounts_mint_default_tags ON accounts;
CREATE TRIGGER accounts_mint_default_tags AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION brain_mint_default_tags();
REVOKE EXECUTE ON FUNCTION brain_mint_default_tags() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_mint_default_tags() TO brain_owner;

-- ---------------------------------------------------------------- mint
-- Org tag + a personal tag per EXISTING account + holdings. brain_system for
-- the cross-actor sweep (FORCE RLS binds brain_owner). ON CONFLICT everywhere:
-- a partial earlier run (or an adopted box in a strange state) must not latch.
SET LOCAL ROLE brain_system;
INSERT INTO tags (slug, kind) VALUES ('maslow-org', 'org') ON CONFLICT DO NOTHING;
INSERT INTO tags (slug, kind, account_id)
  SELECT 'person-' || left(a.id::text, 8), 'personal', a.id FROM accounts a
  ON CONFLICT DO NOTHING;
INSERT INTO account_tags (tag_id, account_id)
  SELECT t.id, t.account_id FROM tags t WHERE t.kind = 'personal'
  ON CONFLICT DO NOTHING;
INSERT INTO account_tags (tag_id, account_id)
  SELECT (SELECT id FROM tags WHERE kind = 'org'), a.id FROM accounts a
  ON CONFLICT DO NOTHING;
RESET ROLE;

-- Teammate account heal: every workspace has the bot, no owner click. A random
-- unusable token hash — the box boot loop mints the real one.
-- brain_provision_teammate (0031) asserts app.actor_id is an active owner, so
-- borrow the oldest one for the call; a box with no active owner (bootstrap
-- not run yet) skips — the account trigger + boot loop cover it later.
DO $do$
DECLARE v_owner uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE is_service) THEN RETURN; END IF;
  SELECT id INTO v_owner FROM accounts
    WHERE role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE NOTICE '0057: no active owner yet — teammate heal deferred to provisioning';
    RETURN;
  END IF;
  PERFORM set_config('app.actor_id', v_owner::text, true);
  PERFORM brain_provision_teammate('Maslow Teammate', 'teammate@service.brain',
    encode(sha256((random()::text || clock_timestamp()::text)::bytea), 'hex'));
  PERFORM set_config('app.actor_id', '', true);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0057: teammate heal skipped: %', SQLERRM;  -- never latch a box
END $do$;

-- ---------------------------------------------------------------- governance fns
-- Owner-asserted, SECURITY DEFINER (owner brain_system → RLS-free inside),
-- called ONLY by owner-gated dashboard routes. No MCP tool references these.
CREATE OR REPLACE FUNCTION brain_assert_owner() RETURNS uuid
LANGUAGE plpgsql SET search_path = public AS $fn$
DECLARE v_actor uuid; v_role text;
BEGIN
  v_actor := nullif(current_setting('app.actor_id', true), '')::uuid;
  SELECT role INTO v_role FROM accounts
    WHERE id = v_actor AND status = 'active' AND revoked_at IS NULL;
  IF v_role IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'owner required'; END IF;
  RETURN v_actor;
END $fn$;
ALTER FUNCTION brain_assert_owner() OWNER TO brain_system;
REVOKE EXECUTE ON FUNCTION brain_assert_owner() FROM PUBLIC;

CREATE OR REPLACE FUNCTION brain_tag_create(p_slug text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_actor uuid; v_id uuid;
BEGIN
  v_actor := brain_assert_owner();
  INSERT INTO tags (slug, kind, created_by) VALUES (p_slug, 'custom', v_actor) RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;
ALTER FUNCTION brain_tag_create(text) OWNER TO brain_system;

CREATE OR REPLACE FUNCTION brain_tag_grant(p_slug text, p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_actor uuid; v_tag tags%ROWTYPE;
BEGIN
  v_actor := brain_assert_owner();
  SELECT * INTO v_tag FROM tags WHERE slug = p_slug;
  IF v_tag.id IS NULL THEN RAISE EXCEPTION 'no such tag'; END IF;
  IF v_tag.kind = 'personal' THEN RAISE EXCEPTION 'personal tags are not assignable'; END IF;
  IF v_tag.kind = 'custom' AND EXISTS (SELECT 1 FROM accounts WHERE id = p_account AND is_service) THEN
    RAISE EXCEPTION 'service accounts hold only their personal and org tags';
  END IF;
  INSERT INTO account_tags (tag_id, account_id, granted_by) VALUES (v_tag.id, p_account, v_actor)
    ON CONFLICT DO NOTHING;
END $fn$;
ALTER FUNCTION brain_tag_grant(text, uuid) OWNER TO brain_system;

CREATE OR REPLACE FUNCTION brain_tag_revoke(p_slug text, p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_tag tags%ROWTYPE;
BEGIN
  PERFORM brain_assert_owner();
  SELECT * INTO v_tag FROM tags WHERE slug = p_slug;
  IF v_tag.id IS NULL OR v_tag.kind <> 'custom' THEN
    RAISE EXCEPTION 'only custom tags can be revoked';
  END IF;
  DELETE FROM account_tags WHERE tag_id = v_tag.id AND account_id = p_account;
END $fn$;
ALTER FUNCTION brain_tag_revoke(text, uuid) OWNER TO brain_system;

-- Boot-path token mint for the always-provisioned teammate (no actor: runs at
-- container start). Rotates the single is_service account's token hash.
CREATE OR REPLACE FUNCTION brain_teammate_token(p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id uuid;
BEGIN
  UPDATE accounts SET token_hash = p_hash WHERE is_service RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'no teammate account'; END IF;
  RETURN v_id;
END $fn$;
ALTER FUNCTION brain_teammate_token(text) OWNER TO brain_system;

REVOKE EXECUTE ON FUNCTION brain_tag_create(text), brain_tag_grant(text, uuid),
  brain_tag_revoke(text, uuid), brain_teammate_token(text) FROM PUBLIC;
-- The three tag fns self-gate via brain_assert_owner (they read app.actor_id),
-- so the request-serving role may call them — the owner check is inside.
GRANT EXECUTE ON FUNCTION brain_tag_create(text), brain_tag_grant(text, uuid),
  brain_tag_revoke(text, uuid) TO brain_app;
-- brain_teammate_token has NO in-function auth check (the boot path has no
-- actor to check), so it must NOT be reachable by the request-serving role:
-- an ungated SECURITY DEFINER that rotates the teammate's credential is a
-- privilege-escalation primitive if any brain_app path can execute it. Grant
-- it ONLY to brain_owner — the box's boot/migrate connection
-- (BRAIN_OWNER_DATABASE_URL) — which never serves an arbitrary-SQL surface.
GRANT EXECUTE ON FUNCTION brain_teammate_token(text) TO brain_owner;

-- ---------------------------------------------------------------- audience
ALTER TABLE objects ADD COLUMN IF NOT EXISTS audience jsonb NOT NULL DEFAULT '[]';
-- brain_app UPDATE on objects is column-scoped (0012); the Writer dual-writes
-- audience from the very next release. brain_system needs it for the backfill.
GRANT UPDATE (audience) ON objects TO brain_app;
GRANT UPDATE (audience) ON objects TO brain_system;

-- The backfill UPDATE must not flood the timeline (audit trigger, 0018
-- rationale) and must not fire the biconditional (a plain fn reading types +
-- ext tables brain_system has no GRANTs on; audience can't change type or
-- liveness, so the invariant is untouched). IMMEDIATE first: pending deferred
-- trigger events block ALTER TABLE on any box with rows (the 0018 lesson).
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE objects DISABLE TRIGGER brain_objects_audit;
ALTER TABLE objects DISABLE TRIGGER brain_objects_biconditional;

SET LOCAL ROLE brain_system;
-- org rows → [[orgTag]]
UPDATE objects o SET audience = jsonb_build_array(jsonb_build_array(
    (SELECT id::text FROM tags WHERE kind = 'org')))
  WHERE o.visibility = 'org' AND o.audience = '[]'::jsonb;
-- private rows → [[creator]] + [[each shared_with]] (personal tags; accounts
-- with no tag — deleted mid-flight — simply contribute no row: fail closed)
UPDATE objects o SET audience = COALESCE((
    SELECT jsonb_agg(jsonb_build_array(t.id::text))
    FROM tags t
    WHERE t.kind = 'personal'
      AND (t.account_id = o.created_by OR t.account_id = ANY(o.shared_with))
  ), '[]'::jsonb)
  WHERE o.visibility = 'private' AND o.audience = '[]'::jsonb;
RESET ROLE;

ALTER TABLE objects ENABLE TRIGGER brain_objects_audit;
ALTER TABLE objects ENABLE TRIGGER brain_objects_biconditional;

-- ---------------------------------------------------------------- policy
-- Match = hold EVERY tag in AT LEAST ONE audience row. CASE-guards throughout
-- (0030 rationale: Postgres may evaluate branches in any order) so a malformed
-- audience value — non-array jsonb, non-uuid tag strings — fails CLOSED for
-- that value instead of throwing and taking every objects query down with it.
CREATE OR REPLACE FUNCTION brain_can_see(aud jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(COALESCE(aud, '[]'::jsonb)) = 'array' THEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(aud) AS r(tag_row)
    WHERE jsonb_typeof(r.tag_row) = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(r.tag_row) AS t(tag)
        WHERE CASE WHEN t.tag ~ '${UUID_RE}'
          THEN NOT EXISTS (
            SELECT 1 FROM account_tags at
            WHERE at.tag_id = t.tag::uuid
              AND at.account_id = nullif(current_setting('app.actor_id', true), '')::uuid)
          ELSE true END)
  ) ELSE false END
$fn$;

-- Both halves carry the creator compat escape (header comment): an unstamped
-- ('[]') row is creator-only rather than hard-refused while the fleet is
-- mid-update between this migration and the audience-stamping Writer. The
-- USING half matters too: INSERT ... RETURNING (every Writer insert) must see
-- the row it just wrote.
--
-- The third disjunct is the DR escape, same shape (and same GUC) as the 0037
-- fs_entries policy: under the old model a bare brain_owner connection could
-- at least see org rows, so export/DR worked implicitly; under tags a
-- connection with no held tags sees NOTHING, and a whole-brain export would
-- silently dump an empty brain. The escape is reachable only by the owner
-- role (never brain_app — the GUC alone grants nothing to the request path),
-- and the export/import already runs inside SET LOCAL app.fs_dr = 'on'. The
-- WITH CHECK half is what lets a DR IMPORT reload rows whose audiences the
-- importing session could never satisfy.
DROP POLICY IF EXISTS brain_visibility ON objects;
CREATE POLICY brain_visibility ON objects
  USING (brain_can_see(audience)
    OR (audience = '[]'::jsonb
        AND created_by = nullif(current_setting('app.actor_id', true), '')::uuid)
    OR (current_user = 'brain_owner'
        AND current_setting('app.fs_dr', true) = 'on'))
  WITH CHECK (brain_can_see(audience)
    OR (audience = '[]'::jsonb
        AND created_by = nullif(current_setting('app.actor_id', true), '')::uuid)
    OR (current_user = 'brain_owner'
        AND current_setting('app.fs_dr', true) = 'on'));
`;

export const migration0057: Migration = {
  version: "0057",
  name: "tag-governance",
  sql: SQL,
};
