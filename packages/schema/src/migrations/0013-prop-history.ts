import type { Migration } from "./types.js";

/**
 * 0013 — prop-level history (the gap agents kept hitting: title/body edits
 * snapshot into before_image, but a prop edit left NO record of the old value).
 *
 * A generic AFTER UPDATE trigger on every typed ext table diffs OLD vs NEW
 * (minus id/deleted_at/tsv bookkeeping) and records the changed columns as
 * `update_props` events: payload {changed: {col: {old, new}}}.
 *
 * Privacy: events are org-visible, so for objects with visibility <> 'org' the
 * event records only {private: true} — WHICH columns changed and their values
 * stay out of the org-visible stream (same reasoning as before_image RLS).
 */
const SQL = `
-- SECURITY DEFINER (owned by brain_owner) so the audit row is written even
-- though brain_app has no INSERT on events — same pattern as brain_audit (D.3).
CREATE OR REPLACE FUNCTION brain_prop_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
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
         ELSE jsonb_build_object('changed', v_diff) END
  );
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION brain_attach_prop_audit(p_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER prop_audit AFTER UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION brain_prop_audit()', p_table);
END
$fn$;
REVOKE EXECUTE ON FUNCTION brain_attach_prop_audit(text) FROM PUBLIC;

-- Re-issue ext-table creation so every FUTURE type gets the audit at birth
-- (keeps 0012's visibility attach; OR REPLACE preserves existing REVOKEs).
CREATE OR REPLACE FUNCTION brain_create_ext_table(p_ext_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TABLE %I (
       id uuid PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
       deleted_at timestamptz,
       tsv tsvector
     )', p_ext_table);
  EXECUTE format('CREATE INDEX ON %I USING gin (tsv)', p_ext_table);
  PERFORM brain_attach_visibility(p_ext_table);
  PERFORM brain_attach_prop_audit(p_ext_table);
END
$fn$;

-- ...and attach to every EXISTING typed ext table.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT ext_table FROM types
  LOOP
    PERFORM brain_attach_prop_audit(r.ext_table);
  END LOOP;
END
$do$;
`;

export const migration0013: Migration = {
  version: "0013",
  name: "prop-history",
  sql: SQL,
};
