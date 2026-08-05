import type { Migration } from "./types.js";

/**
 * brain_prop_audit (0013) never carried its own version — the frontend
 * (propsChangesByVersion) matched an update_props event to the nearest
 * preceding create/update event by seq as a best-effort heuristic, since
 * both fire in the same edit() transaction. Correct in the common case,
 * but explicitly NOT a guarantee under concurrent editors (two sessions
 * committing close together could interleave seq order).
 *
 * By the time this trigger fires (AFTER UPDATE on the ext table), the SAME
 * transaction's earlier UPDATE to `objects` has already bumped its version
 * — visible to this query since a transaction always sees its own prior
 * writes, regardless of isolation level. So we can just look it up and
 * stamp it directly: exact, not inferred.
 *
 * Frontend keeps the seq-heuristic as a fallback for events written before
 * this migration (historical event rows aren't rewritten — payload.version
 * will be absent on those).
 */
const SQL = `
CREATE OR REPLACE FUNCTION brain_prop_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_reason text := nullif(current_setting('app.write_reason', true), '');
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  v_diff jsonb := '{}'::jsonb;
  v_vis text;
  v_version bigint;
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
  SELECT visibility, version INTO v_vis, v_version FROM objects WHERE id = NEW.id;
  INSERT INTO events (actor, kind, target, payload)
  VALUES (
    v_actor,
    'update_props',
    NEW.id,
    CASE WHEN v_vis IS DISTINCT FROM 'org'
         THEN jsonb_build_object('private', true)
         ELSE jsonb_build_object('changed', v_diff, 'reason', v_reason, 'version', v_version) END
  );
  RETURN NULL;
END
$fn$;
`;

export const migration0027: Migration = {
  version: "0027",
  name: "props-version-exact",
  sql: SQL,
};
