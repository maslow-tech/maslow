import type { Migration } from "./types.js";

/**
 * Full tool-call audit (product decision, 2026-07-08). Every MCP tool call — including
 * reads (start, search, get, list, catalog) that were never logged before —
 * appends one event so the activity log shows EVERYTHING every member and
 * agent did, not just mutations.
 *
 * Like brain_think (0007), this is a narrow SECURITY DEFINER writer: brain_app
 * has no INSERT on events (M6), so the app cannot forge audit rows directly.
 * This function only ever writes a 'call:<tool>' event attributed to the
 * caller's app.actor_id — it cannot forge a lifecycle kind (create/delete/...).
 *
 * Defensive per the migration doctrine: it NEVER throws. An unattributed call
 * (no app.actor_id) is skipped rather than failing the tool. Audit is
 * best-effort — logging must never break the call it is logging.
 */

const SQL = `
CREATE OR REPLACE FUNCTION brain_log_call(p_tool text, p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
BEGIN
  IF v_actor IS NULL THEN
    RETURN;  -- unattributed call: skip, never break the tool over audit
  END IF;
  IF p_tool IS NULL OR btrim(p_tool) = '' THEN
    RETURN;
  END IF;
  INSERT INTO events (actor, kind, target, payload)
  VALUES (
    v_actor,
    'call:' || left(regexp_replace(p_tool, '[^a-z_]', '', 'g'), 40),
    NULL,
    coalesce(p_payload, '{}'::jsonb)
  );
END
$fn$;

REVOKE EXECUTE ON FUNCTION brain_log_call(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_log_call(text, jsonb) TO brain_app, brain_owner;
`;

export const migration0019: Migration = {
  version: "0019",
  name: "call-audit",
  sql: SQL,
};
