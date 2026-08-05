import type { Migration } from "./types.js";

/**
 * brain_provision_teammate — owner-gated find-or-create of the single
 * `is_service` account the AI teammate bot authenticates as (0030 added the
 * column; this mints the account behind the box console's "Provision" button).
 *
 * Idempotent: if a service account already exists (any status), re-provision
 * REACTIVATES it and re-mints its token (we never keep the old one) rather than
 * creating a duplicate — so it also heals a box where the token was lost. The
 * caller (Admin.provisionTeammate) generates the token + hash; only the hash is
 * stored, exactly like every other account.
 *
 * Pure function definition — touches no existing rows, cannot throw on box
 * state, so it's safe on every live box per the migration doctrine.
 */
const SQL = `
CREATE OR REPLACE FUNCTION brain_provision_teammate(p_name text, p_email text, p_hash text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_role text;
  v_id uuid;
BEGIN
  SELECT role INTO v_actor_role FROM accounts
    WHERE id = nullif(current_setting('app.actor_id', true), '')::uuid;
  IF v_actor_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only an owner may provision the teammate';
  END IF;

  -- reuse an existing service account (reactivate + rotate) — never duplicate.
  -- NORMALIZE it too: an adopted row of unknown provenance must come out as a
  -- plain member with exactly read+write — never inheriting owner/schema-admin
  -- from whatever a previous life left on the row (unexpected-box-state doctrine).
  SELECT id INTO v_id FROM accounts WHERE is_service = true ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE accounts
      SET token_hash = p_hash,
          status = 'active',
          role = 'member',
          scopes = ARRAY['read','write']::text[],
          expires_at = NULL
      WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO accounts (name, email, role, scopes, token_hash, is_service)
  VALUES (p_name, p_email, 'member', ARRAY['read','write']::text[], p_hash, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
`;

export const migration0031: Migration = {
  version: "0031",
  name: "provision-teammate",
  sql: SQL,
};
