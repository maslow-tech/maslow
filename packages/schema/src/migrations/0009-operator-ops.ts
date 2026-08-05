import type { Migration } from "./types.js";

/**
 * Executor primitives for the operator schema ops:
 * dynamic-table DML (delete ext rows during drop/demote/retype) and a guarded
 * relation drop. All brain_owner-only. DROP TABLE goes through here so it is
 * never assembled from raw text in Node, and the executor runs
 * it in a SEPARATE txn from the ext-row DELETE.
 */

const SQL = `
CREATE OR REPLACE FUNCTION brain_delete_ext_row(p_ext_table text, p_id uuid)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('DELETE FROM %I WHERE id = $1', p_ext_table) USING p_id;
END
$fn$;

CREATE OR REPLACE FUNCTION brain_delete_ext_all(p_ext_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('DELETE FROM %I', p_ext_table);
END
$fn$;

CREATE OR REPLACE FUNCTION brain_drop_relation(p_name text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('DROP TABLE IF EXISTS %I', p_name);
END
$fn$;

REVOKE EXECUTE ON FUNCTION brain_delete_ext_row(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_delete_ext_all(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_drop_relation(text) FROM PUBLIC;
`;

export const migration0009: Migration = {
  version: "0009",
  name: "operator-ops",
  sql: SQL,
  // The migration only DEFINES functions; the DROP TABLE lives inside a
  // format() string that runs at operator time, never at apply time. So the
  // migration itself applies no destructive DDL.
  allowDestructive: [
    {
      rule: "drop-table",
      match: "brain_drop_relation",
      reason:
        "the DROP TABLE lives inside a format() string literal in the brain_drop_relation " +
        "primitive — no apply-time destructive DDL runs",
    },
  ],
};
