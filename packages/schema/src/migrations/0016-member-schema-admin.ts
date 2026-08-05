import type { Migration } from "./types.js";

/**
 * Members can reshape the schema too (owner decision). `schema-admin` isn't a
 * management power — it's just working with the brain's structure (define_type,
 * add_property, set_type) — so a `member` gets it alongside read+write. The
 * ONLY thing that stays owner-exclusive is managing PEOPLE (create_user /
 * revoke_user), which is gated on the owner ROLE, not a scope.
 *
 * Redefines brain_create_user's member tier to include schema-admin, and
 * backfills every existing active member so they gain it immediately.
 */

const SQL = `
CREATE OR REPLACE FUNCTION brain_create_user(
  p_name text, p_email text, p_permission text, p_token_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_actor_role text;
  v_scopes text[];
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'app.actor_id is not set' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT role INTO v_actor_role FROM accounts WHERE id = v_actor;
  IF v_actor_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only an owner may create users';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'name is required';
  END IF;
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'email is required';
  END IF;
  v_scopes := CASE p_permission
    WHEN 'owner'  THEN ARRAY['read','write','schema-admin']
    WHEN 'member' THEN ARRAY['read','write','schema-admin']
    WHEN 'viewer' THEN ARRAY['read']
    ELSE NULL END;
  IF v_scopes IS NULL THEN
    RAISE EXCEPTION 'permission must be one of owner, member, viewer';
  END IF;
  INSERT INTO accounts (name, email, role, scopes, token_hash)
  VALUES (btrim(p_name), btrim(p_email), p_permission, v_scopes, p_token_hash)
  RETURNING id INTO v_id;
  INSERT INTO events (actor, kind, target, payload)
  VALUES (v_actor, 'create_user', v_id, jsonb_build_object('permission', p_permission));
  RETURN v_id;
END
$fn$;

-- Backfill: every active member gains schema-admin (idempotent).
UPDATE accounts
   SET scopes = ARRAY['read','write','schema-admin']::text[]
 WHERE role = 'member' AND status = 'active'
   AND NOT ('schema-admin' = ANY(scopes));
`;

export const migration0016: Migration = {
  version: "0016",
  name: "member-schema-admin",
  sql: SQL,
};
