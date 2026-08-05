import type { Migration } from "./types.js";

/**
 * think() timeline writer + the merge journal.
 *
 * think() must append to the events timeline, but brain_app has no INSERT on
 * events (append-only, definer-only). So a narrow SECURITY DEFINER function
 * writes a single 'think' event attributed to app.actor_id, input-validated.
 * (It cannot forge arbitrary kinds/targets — it only ever writes a think.)
 *
 * merge_journal records each redirect so a merge is reversible (unmerge) and
 * auditable; brain_app may append to it (it is a recovery aid, not the audit log).
 */

const SQL = `
CREATE OR REPLACE FUNCTION brain_think(p_note text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $fn$
DECLARE
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_seq bigint;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'app.actor_id is not set' USING ERRCODE = 'raise_exception';
  END IF;
  IF p_note IS NULL OR length(p_note) = 0 OR length(p_note) > 4000 THEN
    RAISE EXCEPTION 'a think note must be 1..4000 characters' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO events (actor, kind, target, payload)
  VALUES (v_actor, 'think', NULL, jsonb_build_object('note', p_note))
  RETURNING seq INTO v_seq;
  RETURN v_seq;
END
$fn$;

REVOKE EXECUTE ON FUNCTION brain_think(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION brain_think(text) TO brain_app, brain_owner;

CREATE TABLE merge_journal (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  loser    uuid NOT NULL REFERENCES objects(id),
  winner   uuid NOT NULL REFERENCES objects(id),
  at       timestamptz NOT NULL DEFAULT now(),
  "by"     uuid NOT NULL REFERENCES accounts(id),
  snapshot jsonb NOT NULL,
  unmerged_at timestamptz
);
CREATE INDEX merge_journal_loser ON merge_journal (loser);
GRANT SELECT, INSERT, UPDATE ON merge_journal TO brain_app;
`;

export const migration0007: Migration = {
  version: "0007",
  name: "think-merge",
  sql: SQL,
};
