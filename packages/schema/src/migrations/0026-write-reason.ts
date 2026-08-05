import type { Migration } from "./types.js";

/**
 * Widens both audit triggers to carry an optional free-text reason:
 *   - brain_audit_event (0003)  -> create/update/delete/restore events
 *   - brain_prop_audit  (0013)  -> update_props events
 *
 * packages/mcp-tools sets app.write_reason before write()/edit(), mirroring
 * the existing app.actor_id pattern, so every event answers not just who/when
 * but why (claim provenance).
 * Both triggers fire inside the SAME transaction as a given write()/edit()
 * call, so the same transaction-local var reaches both.
 */
const SQL = `
CREATE OR REPLACE FUNCTION brain_audit_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor_txt text := current_setting('app.actor_id', true);
  v_reason text := nullif(current_setting('app.write_reason', true), '');
  v_actor uuid;
  v_kind text;
BEGIN
  IF v_actor_txt IS NULL OR v_actor_txt = '' THEN
    RAISE EXCEPTION 'app.actor_id is not set — refusing to write an unattributed event'
      USING ERRCODE = 'raise_exception';
  END IF;
  v_actor := v_actor_txt::uuid;

  IF TG_OP = 'INSERT' THEN
    v_kind := 'create';
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    v_kind := 'delete';
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    v_kind := 'restore';
  ELSE
    v_kind := 'update';
  END IF;

  INSERT INTO events (actor, kind, target, payload)
  VALUES (v_actor, v_kind, NEW.id, jsonb_build_object('version', NEW.version, 'reason', v_reason));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION brain_prop_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_reason text := nullif(current_setting('app.write_reason', true), '');
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_diff jsonb := '{}'::jsonb;
  v_vis text;
  k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(v_new) LOOP
    IF k NOT IN ('id', 'deleted_at', 'tsv')
       AND v_old->k IS DISTINCT FROM v_new->k THEN
      v_diff := v_diff
        || jsonb_build_object(k, jsonb_build_object('old', v_old->k, 'new', v_new->k));
    END IF;
  END LOOP;
  IF v_diff = '{}'::jsonb THEN
    RETURN NULL; -- bookkeeping-only update (tsv refresh, soft-delete mirror)
  END IF;
  SELECT visibility INTO v_vis FROM objects WHERE id = NEW.id;
  INSERT INTO events (actor, kind, target, payload)
  VALUES (
    v_actor,
    'update_props',
    NEW.id,
    CASE WHEN v_vis IS DISTINCT FROM 'org'
         THEN jsonb_build_object('private', true)
         ELSE jsonb_build_object('changed', v_diff, 'reason', v_reason) END
  );
  RETURN NULL;
END
$fn$;
`;

export const migration0026: Migration = {
  version: "0026",
  name: "write-reason",
  sql: SQL,
};
