import type { Migration } from "./types.js";

/**
 * brain_reissue_owner_token — the break-glass owner-token minter for a box
 * whose first-owner token was lost BEFORE first login. It
 * is a brain_owner-ONLY SECURITY DEFINER function, deliberately NOT granted to
 * brain_app: the request-serving app connects as brain_app and — even if SQL-
 * injected — has no EXECUTE, so it can never mint an owner token. The only
 * caller is the tools-profile `reissue-owner-token` service, which connects via
 * BRAIN_OWNER_DATABASE_URL (host/compose access = the box owner's own key), the
 * same authorization basis as migrate's owner bootstrap.
 *
 * Correctness (the three lookup bugs the design named):
 *  - match on lower(btrim(email)) to line up with the accounts unique index on
 *    lower(email) and 0015's btrim-not-lowercased storage (no casing lockout);
 *  - set events.actor EXPLICITLY to the found owner id (break-glass never sets
 *    app.actor_id, so the NOT NULL FK insert would otherwise fail);
 *  - 0 matches → RAISE (an explicit operator action on an unknown owner is an
 *    error, like brain_revoke_account); at most 1 given the unique index.
 *
 * Under FORCE RLS (0039): events + accounts are deliberately NOT FORCE'd, so the
 * brain_owner definer's inserts/updates bypass by ownership exactly as the other
 * account-admin fns (create_user/revoke) do — no brain_system needed. The body
 * is pure CREATE OR REPLACE + REVOKE/GRANT: ZERO rows, a true no-op on every
 * production-box self-update (never-throw doctrine satisfied).
 */
const SQL = `
CREATE OR REPLACE FUNCTION brain_reissue_owner_token(p_email text, p_token_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM accounts
   WHERE lower(btrim(email)) = lower(btrim(p_email))
     AND role = 'owner'
     AND status <> 'revoked';
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no active owner with email %', p_email USING ERRCODE = 'raise_exception';
  END IF;
  UPDATE accounts SET token_hash = p_token_hash WHERE id = v_id;
  INSERT INTO events (actor, kind, target, payload)
  VALUES (v_id, 'reissue_owner_token', v_id, '{}'::jsonb);
  RETURN v_id;
END;
$fn$;

-- Break-glass, brain_owner-ONLY: NEVER brain_app (the app pool can't mint owner
-- tokens), NEVER brain_system.
REVOKE EXECUTE ON FUNCTION brain_reissue_owner_token(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_reissue_owner_token(text, text) TO brain_owner;
`;

export const migration0042: Migration = {
  version: "0042",
  name: "reissue-owner-token",
  sql: SQL,
};
