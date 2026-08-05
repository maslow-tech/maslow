import type { Migration } from "./types.js";

/**
 * set_type moved from the executor (brain_owner, promotion-only, manual event)
 * into the Writer (brain_app, promote OR retype, RLS-bound) — so the manual
 * 'set_type' event write went with it, and brain_app cannot INSERT INTO events
 * directly (SELECT-only grant; events are written by the SECURITY DEFINER
 * audit triggers). Teach the objects audit trigger to recognise a type change
 * instead: an UPDATE that moves type_id emits kind 'set_type' with the
 * from/to type ids in the payload, keeping the audit trail explicit for an
 * irreversible operation. Everything else (create/delete/restore/update) is
 * byte-identical to 0026's version.
 *
 * Also covers the executor's operator ops for free: demote and drop_type null
 * type_id and now show as 'set_type' (to_type_id null) rather than a generic
 * 'update' — strictly more accurate, and nothing matches on those kinds.
 *
 * The move also needs brain_app to be able to write objects.type_id at all:
 * 0012 narrowed the blanket UPDATE grant to named columns (so the app can
 * never rewrite created_by — that guard stays) and type_id was left out
 * because set_type was executor-only then. Widening a column grant is
 * additive and idempotent; type_id stays fenced by the FK to types and the
 * deferred biconditional (a type_id without its matching ext row cannot
 * commit).
 *
 * Otherwise a pure CREATE OR REPLACE of one function: no data read or
 * written, no assumptions about box state (migration doctrine rule 1
 * satisfied trivially).
 */
const SQL = `
GRANT UPDATE (type_id) ON objects TO brain_app;

CREATE OR REPLACE FUNCTION brain_audit_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor_txt text := current_setting('app.actor_id', true);
  v_reason text := nullif(current_setting('app.write_reason', true), '');
  v_actor uuid;
  v_kind text;
  v_payload jsonb;
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
  ELSIF OLD.type_id IS DISTINCT FROM NEW.type_id THEN
    v_kind := 'set_type';
  ELSE
    v_kind := 'update';
  END IF;

  v_payload := jsonb_build_object('version', NEW.version, 'reason', v_reason);
  IF v_kind = 'set_type' THEN
    v_payload := v_payload
      || jsonb_build_object('from_type_id', OLD.type_id, 'to_type_id', NEW.type_id);
  END IF;

  INSERT INTO events (actor, kind, target, payload)
  VALUES (v_actor, v_kind, NEW.id, v_payload);
  RETURN NULL;
END
$fn$;
`;

export const migration0056: Migration = {
  version: "0056",
  name: "set-type-audit",
  sql: SQL,
};
