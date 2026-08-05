import type { Migration } from "./types.js";

/**
 * Normal permission tiers + owner guardrails.
 *
 * Replaces the granular read/write/schema-admin scope checkboxes with three
 * standard tiers — the `role` IS the tier and scopes are DERIVED from it:
 *   - owner   → read, write, schema-admin (+ manage people). Multiple owners
 *               are allowed and are PEERS: none can revoke another or itself.
 *   - member  → read, write.
 *   - viewer  → read (read-only).
 *
 * Every account is created through brain_create_user, which REQUIRES a name,
 * an email, and a tier — no nameless "owner" default, no à-la-carte scopes.
 * brain_bootstrap_owner likewise now requires a name + email.
 *
 * Guardrails from the adversarial run are baked into brain_revoke_account:
 * only an owner may revoke, never themselves, never another owner, and an
 * unknown id RAISES instead of silently succeeding.
 */

const SQL = `
-- 1) 'viewer' becomes a first-class role (read-only tier).
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_role_check
  CHECK (role IN ('owner', 'member', 'viewer', 'operator', 'system'));

-- 2) Unified account creation: name + email + tier all required, scopes derived.
--    Owner-gated; creating an 'owner' is the one deliberate escalation.
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
    WHEN 'member' THEN ARRAY['read','write']
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

-- 3) Revocation guardrails.
CREATE OR REPLACE FUNCTION brain_revoke_account(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_actor_role text;
  v_target_role text;
BEGIN
  SELECT role INTO v_actor_role FROM accounts WHERE id = v_actor;
  IF v_actor_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only an owner may revoke accounts';
  END IF;
  IF p_id = v_actor THEN
    RAISE EXCEPTION 'an owner cannot revoke their own account';
  END IF;
  SELECT role INTO v_target_role FROM accounts WHERE id = p_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'no such account: %', p_id;
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'owners are peers — an owner cannot revoke another owner';
  END IF;
  UPDATE accounts SET status = 'revoked', revoked_at = now(), token_hash = NULL WHERE id = p_id;
  INSERT INTO events (actor, kind, target, payload) VALUES (v_actor, 'revoke_account', p_id, '{}');
END
$fn$;

-- 4) First-owner bootstrap now requires a name + email (no nameless default).
DROP FUNCTION IF EXISTS brain_bootstrap_owner(text, text);
CREATE OR REPLACE FUNCTION brain_bootstrap_owner(p_name text, p_email text, p_token_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE role = 'owner') THEN
    RAISE EXCEPTION 'an owner already exists' USING ERRCODE = 'unique_violation';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'owner name is required';
  END IF;
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'owner email is required';
  END IF;
  INSERT INTO accounts (name, email, role, scopes, token_hash)
  VALUES (btrim(p_name), btrim(p_email), 'owner', ARRAY['read','write','schema-admin']::text[], p_token_hash)
  RETURNING id INTO v_id;
  PERFORM set_config('app.actor_id', v_id::text, true);
  INSERT INTO events (actor, kind, target, payload) VALUES (v_id, 'bootstrap_owner', v_id, '{}');
  RETURN v_id;
END
$fn$;

REVOKE EXECUTE ON FUNCTION brain_create_user(text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_bootstrap_owner(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_create_user(text, text, text, text) TO brain_app, brain_owner;
GRANT EXECUTE ON FUNCTION brain_bootstrap_owner(text, text, text) TO brain_app, brain_owner;
`;

export const migration0015: Migration = {
  version: "0015",
  name: "permission-tiers-owner-guards",
  sql: SQL,
  // The role CHECK is swapped drop→re-add in ONE transaction to a strict
  // SUPERSET (adds 'viewer'); no row can violate it and none is admitted in
  // between. Pure expand, safe.
  allowDestructive: [
    {
      rule: "drop-constraint",
      match: "accounts_role_check",
      reason: "add 'viewer' to accounts.role CHECK — superset swap in one txn (expand-only)",
    },
  ],
};
