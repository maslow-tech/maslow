import type { Migration } from "./types.js";

/**
 * The generic invariant triggers — a FIXED,
 * hand-audited set that reads the catalog at runtime. There are NO per-type
 * generated function bodies (that would be an owner-privileged injection
 * surface): define_type emits only CREATE TABLE + CREATE TRIGGER … EXECUTE
 * FUNCTION <generic_fn>, passing the type_id as a literal argument.
 *
 * Object-level triggers (on the fixed `objects` table) are attached here:
 *   D.3 audit event (SECURITY DEFINER, actor from app.actor_id, append-only)
 *   D.5 tsv (2-arg to_tsvector, left(text, N))
 *   D.7 soft-delete rewrite (DELETE → UPDATE deleted_at, mirrored into ext)
 *   D.1 biconditional (typed object ⇔ one live ext row), deferred
 *
 * Per-ext generic functions are defined here and attached by the executor
 * (brain_attach_ext_triggers): D.5 tsv over typed text/enum columns, and the
 * D.1 ext side. Ref-mirror (D.2) / enum (D.4) / ref-safety (D.8) land with
 * add_property in later migrations, where the columns they guard exist.
 */

const SQL = `
-- The executor stores the ext table name so triggers can find it without
-- re-deriving (additive; the surrogate-id model).
ALTER TABLE types ADD COLUMN IF NOT EXISTS ext_table text COLLATE "C";

-- ---------------------------------------------------------------- D.5 tsv (objects)
CREATE OR REPLACE FUNCTION brain_tsv_objects()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- 2-arg to_tsvector is immutable; left(...) bounds the input so the tsvector
  -- stays under its 1 MB cap even at the 1 MB body limit.
  NEW.tsv := to_tsvector('english',
    left(coalesce(NEW.title, '') || ' ' || coalesce(NEW.body, ''), 1000000));
  RETURN NEW;
END
$fn$;

-- ---------------------------------------------------------------- D.3 audit event
-- SECURITY DEFINER (owned by brain_owner) so audit rows are written even though
-- brain_app has no INSERT on events; a missing actor ABORTS (M6).
CREATE OR REPLACE FUNCTION brain_audit_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor_txt text := current_setting('app.actor_id', true);
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
  VALUES (v_actor, v_kind, NEW.id, jsonb_build_object('version', NEW.version));
  RETURN NULL;
END
$fn$;

-- ---------------------------------------------------------------- D.7 soft-delete
-- Rewrite a physical DELETE into a soft-delete UPDATE and mirror it into the
-- typed ext row, so a cascade can never physically purge anything.
CREATE OR REPLACE FUNCTION brain_soft_delete_objects()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_now timestamptz := now();
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_ext text;
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RETURN NULL; -- already soft-deleted; nothing to do
  END IF;
  IF OLD.type_id IS NOT NULL THEN
    SELECT ext_table INTO v_ext FROM types WHERE id = OLD.type_id;
    IF v_ext IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL', v_ext)
        USING v_now, OLD.id;
    END IF;
  END IF;
  UPDATE objects SET deleted_at = v_now, deleted_by = v_actor
    WHERE id = OLD.id AND deleted_at IS NULL;
  RETURN NULL; -- cancel the physical DELETE
END
$fn$;

-- ---------------------------------------------------------------- D.1 biconditional (objects side)
CREATE OR REPLACE FUNCTION brain_biconditional_object()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_ext text;
  v_total int;
  v_matching int;
BEGIN
  IF NEW.type_id IS NULL THEN
    RETURN NULL; -- notes are exempt
  END IF;
  SELECT ext_table INTO v_ext FROM types WHERE id = NEW.type_id;
  IF v_ext IS NULL THEN
    RAISE EXCEPTION 'biconditional: type % has no ext table', NEW.type_id;
  END IF;
  EXECUTE format('SELECT count(*) FROM %I WHERE id = $1', v_ext) USING NEW.id INTO v_total;
  IF v_total <> 1 THEN
    RAISE EXCEPTION 'biconditional: typed object % must have exactly one ext row (found %)',
      NEW.id, v_total;
  END IF;
  EXECUTE format('SELECT count(*) FROM %I WHERE id = $1 AND (deleted_at IS NULL) = ($2 IS NULL)', v_ext)
    USING NEW.id, NEW.deleted_at INTO v_matching;
  IF v_matching <> 1 THEN
    RAISE EXCEPTION 'biconditional: ext liveness mismatch for object %', NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;

-- ---------------------------------------------------------------- D.1 biconditional (ext side, generic)
CREATE OR REPLACE FUNCTION brain_biconditional_ext()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_type smallint := TG_ARGV[0]::smallint;
  v_id uuid;
  v_parent_type smallint;
  v_parent_deleted timestamptz;
  v_found boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN NULL; -- physical ext delete only via cascade from a (never-)hard-deleted object
  END IF;
  v_id := NEW.id;
  SELECT type_id, deleted_at, true INTO v_parent_type, v_parent_deleted, v_found
    FROM objects WHERE id = v_id;
  IF v_found IS NULL THEN
    RAISE EXCEPTION 'biconditional: ext row % has no parent object', v_id;
  END IF;
  IF v_parent_type IS DISTINCT FROM v_type THEN
    RAISE EXCEPTION 'biconditional: parent type mismatch for %', v_id;
  END IF;
  IF (v_parent_deleted IS NULL) <> (NEW.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'biconditional: liveness mismatch for %', v_id;
  END IF;
  RETURN NULL;
END
$fn$;

-- ---------------------------------------------------------------- D.5 tsv (ext, generic)
CREATE OR REPLACE FUNCTION brain_tsv_ext()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_type smallint := TG_ARGV[0]::smallint;
  v_doc jsonb := to_jsonb(NEW);
  v_text text := '';
  r record;
BEGIN
  FOR r IN
    SELECT physical_name FROM type_properties
    WHERE type_id = v_type AND kind IN ('text', 'enum') AND NOT deprecated
  LOOP
    v_text := v_text || ' ' || coalesce(v_doc ->> r.physical_name, '');
  END LOOP;
  NEW.tsv := to_tsvector('english', left(v_text, 1000000));
  RETURN NEW;
END
$fn$;

-- ---------------------------------------------------------------- attach: ext triggers
-- Called by the executor after creating an ext table. Only identifiers (%I) and
-- the type_id literal (%L) are interpolated.
CREATE OR REPLACE FUNCTION brain_attach_ext_triggers(p_ext_table text, p_type_id smallint)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
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

-- ---------------------------------------------------------------- attach: object triggers
CREATE TRIGGER brain_objects_tsv
  BEFORE INSERT OR UPDATE ON objects
  FOR EACH ROW EXECUTE FUNCTION brain_tsv_objects();

CREATE TRIGGER brain_objects_audit
  AFTER INSERT OR UPDATE ON objects
  FOR EACH ROW EXECUTE FUNCTION brain_audit_event();

CREATE TRIGGER brain_objects_soft_delete
  BEFORE DELETE ON objects
  FOR EACH ROW EXECUTE FUNCTION brain_soft_delete_objects();

CREATE CONSTRAINT TRIGGER brain_objects_biconditional
  AFTER INSERT OR UPDATE ON objects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION brain_biconditional_object();
`;

export const migration0003: Migration = {
  version: "0003",
  name: "invariants",
  sql: SQL,
};
