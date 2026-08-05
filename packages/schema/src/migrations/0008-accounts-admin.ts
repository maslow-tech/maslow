import type { Migration } from "./types.js";

/**
 * Local member administration. brain_app has NO
 * INSERT on accounts and cannot change role/status — so account creation,
 * revocation, and token rotation go through narrow SECURITY DEFINER functions
 * (owned by brain_owner) that:
 *   - require the acting account (app.actor_id) to be an OWNER, and
 *   - only ever create role='member' (no owner/operator escalation, M1),
 * writing an attributed event. A compromised brain_app therefore still cannot
 * escalate — the DB refuses it.
 *
 * brain_bootstrap_owner is the one-time first-owner bootstrap: it is
 * self-guarding on a zero-owner box.
 */

const SQL = `
CREATE OR REPLACE FUNCTION brain_create_member(
  p_name text, p_email text, p_scopes text[], p_token_hash text, p_expires_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_actor_role text;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'app.actor_id is not set' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT role INTO v_actor_role FROM accounts WHERE id = v_actor;
  IF v_actor_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only an owner may create members' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (p_scopes <@ ARRAY['read','write','schema-admin']::text[]) THEN
    RAISE EXCEPTION 'invalid scopes' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO accounts (name, email, role, scopes, token_hash, expires_at)
  VALUES (p_name, p_email, 'member', p_scopes, p_token_hash, p_expires_at)
  RETURNING id INTO v_id;
  INSERT INTO events (actor, kind, target, payload)
  VALUES (v_actor, 'create_member', v_id, jsonb_build_object('scopes', to_jsonb(p_scopes)));
  RETURN v_id;
END
$fn$;

CREATE OR REPLACE FUNCTION brain_revoke_account(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_actor_role text;
BEGIN
  SELECT role INTO v_actor_role FROM accounts WHERE id = v_actor;
  IF v_actor_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only an owner may revoke accounts' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE accounts SET status = 'revoked', revoked_at = now(), token_hash = NULL WHERE id = p_id;
  INSERT INTO events (actor, kind, target, payload) VALUES (v_actor, 'revoke_account', p_id, '{}');
END
$fn$;

CREATE OR REPLACE FUNCTION brain_rotate_token(p_id uuid, p_new_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_actor_role text;
BEGIN
  SELECT role INTO v_actor_role FROM accounts WHERE id = v_actor;
  -- an owner may rotate anyone's token; a member may rotate only its own
  IF v_actor_role IS DISTINCT FROM 'owner' AND v_actor IS DISTINCT FROM p_id THEN
    RAISE EXCEPTION 'not permitted to rotate this token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE accounts SET token_hash = p_new_hash WHERE id = p_id AND status = 'active';
  INSERT INTO events (actor, kind, target, payload) VALUES (v_actor, 'rotate_token', p_id, '{}');
END
$fn$;

-- One-time first-owner bootstrap: only works on a zero-owner box.
CREATE OR REPLACE FUNCTION brain_bootstrap_owner(p_name text, p_token_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE role = 'owner') THEN
    RAISE EXCEPTION 'an owner already exists' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO accounts (name, role, scopes, token_hash)
  VALUES (p_name, 'owner', ARRAY['read','write','schema-admin']::text[], p_token_hash)
  RETURNING id INTO v_id;
  -- attribute the bootstrap to the new owner itself
  PERFORM set_config('app.actor_id', v_id::text, true);
  INSERT INTO events (actor, kind, target, payload) VALUES (v_id, 'bootstrap_owner', v_id, '{}');
  RETURN v_id;
END
$fn$;

REVOKE EXECUTE ON FUNCTION brain_create_member(text, text, text[], text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_revoke_account(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_rotate_token(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_bootstrap_owner(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_create_member(text, text, text[], text, timestamptz) TO brain_app, brain_owner;
GRANT EXECUTE ON FUNCTION brain_revoke_account(uuid) TO brain_app, brain_owner;
GRANT EXECUTE ON FUNCTION brain_rotate_token(uuid, text) TO brain_app, brain_owner;
GRANT EXECUTE ON FUNCTION brain_bootstrap_owner(text, text) TO brain_app, brain_owner;
`;

export const migration0008: Migration = {
  version: "0008",
  name: "accounts-admin",
  sql: SQL,
};
