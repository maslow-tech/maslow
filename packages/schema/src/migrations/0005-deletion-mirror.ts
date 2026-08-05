import type { Migration } from "./types.js";

/**
 * Mirror an object's soft-delete/restore into its typed ext row.
 *
 * The write path soft-deletes via UPDATE objects SET deleted_at (proper
 * rowcount + version bump), not a physical DELETE. The D.7 BEFORE DELETE
 * trigger only fires on a physical DELETE, so without this AFTER UPDATE mirror
 * the ext row's liveness would diverge from the object and the deferred D.1
 * biconditional would abort the commit. This keeps object.deleted_at and
 * ext.deleted_at in lockstep on both delete and restore.
 */

const SQL = `
CREATE OR REPLACE FUNCTION brain_mirror_deletion_ext()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_ext text;
BEGIN
  IF NEW.type_id IS NOT NULL AND (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) THEN
    SELECT ext_table INTO v_ext FROM types WHERE id = NEW.type_id;
    IF v_ext IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET deleted_at = $1 WHERE id = $2', v_ext)
        USING NEW.deleted_at, NEW.id;
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER brain_objects_mirror_deletion
  AFTER UPDATE ON objects
  FOR EACH ROW EXECUTE FUNCTION brain_mirror_deletion_ext();
`;

export const migration0005: Migration = {
  version: "0005",
  name: "deletion-mirror",
  sql: SQL,
};
