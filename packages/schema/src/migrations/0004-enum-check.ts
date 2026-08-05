import type { Migration } from "./types.js";

/**
 * D.4 enum membership. Enum values live in
 * enum_option (data, not DDL); a generic BEFORE trigger validates every enum
 * column against the non-deprecated options for its property. Attached to each
 * ext table by the executor via brain_attach_ext_triggers (replaced here to
 * include the enum check).
 */

const SQL = `
CREATE OR REPLACE FUNCTION brain_enum_check_ext()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_type smallint := TG_ARGV[0]::smallint;
  v_doc jsonb := to_jsonb(NEW);
  r record;
  v_val text;
BEGIN
  FOR r IN
    SELECT id, physical_name FROM type_properties
    WHERE type_id = v_type AND kind = 'enum' AND NOT deprecated
  LOOP
    v_val := v_doc ->> r.physical_name;
    IF v_val IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM enum_option
      WHERE property_id = r.id AND value = v_val AND NOT deprecated
    ) THEN
      RAISE EXCEPTION 'enum: value is not a permitted option for property %', r.id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;

-- Re-issue the attach helper so a new ext table also gets the enum check.
CREATE OR REPLACE FUNCTION brain_attach_ext_triggers(p_ext_table text, p_type_id smallint)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER brain_ext_enum BEFORE INSERT OR UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION brain_enum_check_ext(%L)',
    p_ext_table, p_type_id::text);
  EXECUTE format(
    'CREATE TRIGGER brain_ext_tsv BEFORE INSERT OR UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION brain_tsv_ext(%L)',
    p_ext_table, p_type_id::text);
  EXECUTE format(
    'CREATE CONSTRAINT TRIGGER brain_ext_biconditional AFTER INSERT OR UPDATE OR DELETE ON %I
       DEFERRABLE INITIALLY DEFERRED
       FOR EACH ROW EXECUTE FUNCTION brain_biconditional_ext(%L)',
    p_ext_table, p_type_id::text);
END
$fn$;

REVOKE EXECUTE ON FUNCTION brain_attach_ext_triggers(text, smallint) FROM PUBLIC;

-- DML primitive: create the ext row when promoting a note to a type (set_type).
-- Dynamic table name is %I-quoted server-side; the id is bound.
CREATE OR REPLACE FUNCTION brain_promote_ext(p_ext_table text, p_id uuid)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('INSERT INTO %I (id) VALUES ($1)', p_ext_table) USING p_id;
END
$fn$;

REVOKE EXECUTE ON FUNCTION brain_promote_ext(text, uuid) FROM PUBLIC;
`;

export const migration0004: Migration = {
  version: "0004",
  name: "enum-check",
  sql: SQL,
};
