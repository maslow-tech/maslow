import type { Migration } from "./types.js";

/**
 * D.2 ref-column ↔ edge mirror + D.8 write-side liveness.
 *
 * Two surfaces, one graph: a scalar `ref` property is canonical, and the DB
 * keeps a matching `edge` (provenance `ref:<col>`) in sync. A generic AFTER
 * trigger on each ext table diffs its ref columns (catalog-driven) and
 * inserts/deletes the mirror edge; while doing so it raises a session flag so
 * the edge guard permits it. Any OTHER writer that tries to INSERT/DELETE a
 * `ref:%` edge directly is refused (M3) — those edges belong to the column.
 *
 * D.8 write-side: a ref may not point at a soft-deleted/missing target (the FK
 * already enforces type + existence; this adds liveness).
 */

const SQL = `
-- Mirror ref columns → edges (canonical = the column).
CREATE OR REPLACE FUNCTION brain_ref_mirror_ext()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_type smallint := TG_ARGV[0]::smallint;
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END;
  v_id  uuid  := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  r record;
  v_oldval uuid;
  v_newval uuid;
  v_live boolean;
BEGIN
  FOR r IN
    SELECT name, physical_name FROM type_properties
    WHERE type_id = v_type AND kind = 'ref' AND NOT deprecated
  LOOP
    v_oldval := (v_old ->> r.physical_name)::uuid;
    v_newval := (v_new ->> r.physical_name)::uuid;
    IF v_oldval IS DISTINCT FROM v_newval THEN
      PERFORM set_config('brain.ref_mirror', '1', true);
      IF v_oldval IS NOT NULL THEN
        DELETE FROM edges
        WHERE from_id = v_id AND rel = r.name AND to_id = v_oldval
          AND provenance = 'ref:' || r.physical_name;
      END IF;
      IF v_newval IS NOT NULL THEN
        SELECT (deleted_at IS NULL) INTO v_live FROM objects WHERE id = v_newval;
        IF v_live IS NULL OR v_live = false THEN
          RAISE EXCEPTION 'ref target % is missing or deleted', v_newval
            USING ERRCODE = 'foreign_key_violation';
        END IF;
        INSERT INTO edges (from_id, rel, to_id, provenance)
        VALUES (v_id, r.name, v_newval, 'ref:' || r.physical_name)
        ON CONFLICT (from_id, rel, to_id) DO NOTHING;
      END IF;
      PERFORM set_config('brain.ref_mirror', '', true);
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;

-- Guard: only the mirror may touch ref:% edges; manual link/unlink use 'manual'.
CREATE OR REPLACE FUNCTION brain_guard_ref_edges()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.provenance LIKE 'ref:%')
     OR (TG_OP = 'DELETE' AND OLD.provenance LIKE 'ref:%') THEN
    IF current_setting('brain.ref_mirror', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'ref-provenance edges are managed by the ref column, not directly'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER brain_edges_guard_ref
  BEFORE INSERT OR DELETE ON edges
  FOR EACH ROW EXECUTE FUNCTION brain_guard_ref_edges();

-- Re-issue the attach helper to also wire the ref mirror onto new ext tables.
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
    'CREATE TRIGGER brain_ext_ref_mirror AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION brain_ref_mirror_ext(%L)',
    p_ext_table, p_type_id::text);
  EXECUTE format(
    'CREATE CONSTRAINT TRIGGER brain_ext_biconditional AFTER INSERT OR UPDATE OR DELETE ON %I
       DEFERRABLE INITIALLY DEFERRED
       FOR EACH ROW EXECUTE FUNCTION brain_biconditional_ext(%L)',
    p_ext_table, p_type_id::text);
END
$fn$;

REVOKE EXECUTE ON FUNCTION brain_attach_ext_triggers(text, smallint) FROM PUBLIC;
`;

export const migration0006: Migration = {
  version: "0006",
  name: "ref-mirror",
  sql: SQL,
};
