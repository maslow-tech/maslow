import type { Migration } from "./types.js";

/**
 * Weighted full-text ranking (the entity-vs-ledger fix). The 0003 tsv
 * triggers mashed title + body into ONE unweighted tsvector, so ts_rank_cd
 * could not tell the client titled "Acme" from the 50 invoices that mention
 * Acme in a body — entity-name searches drowned under ledger rows.
 *
 * Fix: stamp where each word came from with setweight —
 *   A = objects.title   (the entity's own name)
 *   B = typed ext fields (text/enum props)
 *   C = objects.body    (passing mentions)
 * ts_rank_cd's DEFAULT weight array is {D:0.1, C:0.2, B:0.4, A:1.0}, so the
 * search queries need no change at all: a title holder outranks a body
 * mention 5:1 natively.
 *
 * Backfill re-chews every existing row (the BEFORE triggers recompute tsv on
 * any UPDATE). The audit trigger is disabled around it — a tsv rebuild is not
 * a user action and must not flood the events timeline; the deferred
 * biconditional stays on (rows are consistent, it passes).
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------- D.5 tsv (objects), weighted
CREATE OR REPLACE FUNCTION brain_tsv_objects()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- 2-arg to_tsvector is immutable; left(...) bounds the input so the tsvector
  -- stays under its 1 MB cap even at the 1 MB body limit.
  NEW.tsv :=
      setweight(to_tsvector('english', left(coalesce(NEW.title, ''), 10000)), 'A')
   || setweight(to_tsvector('english', left(coalesce(NEW.body, ''), 1000000)), 'C');
  RETURN NEW;
END
$fn$;

-- ------------------------------------------------------- D.5 tsv (ext, generic), weighted
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
  NEW.tsv := setweight(to_tsvector('english', left(v_text, 1000000)), 'B');
  RETURN NEW;
END
$fn$;

-- ------------------------------------------------------- backfill
-- Setting tsv to NULL is a no-op payload: the BEFORE trigger overwrites it
-- with the weighted vector. updated_at/version are untouched — this is not
-- an edit.
--
-- The deferred biconditional constraint triggers must fire PER ROW here, not
-- queue to commit: queued (pending) trigger events block ALTER TABLE on any
-- box that actually has rows ("cannot ALTER TABLE … pending trigger events").
-- Empty test DBs never hit this — caught on the seeded eval brain.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE objects DISABLE TRIGGER brain_objects_audit;
UPDATE objects SET tsv = NULL;
ALTER TABLE objects ENABLE TRIGGER brain_objects_audit;

DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT ext_table FROM types WHERE ext_table IS NOT NULL
  LOOP
    EXECUTE format('UPDATE %I SET tsv = NULL', r.ext_table);
  END LOOP;
END
$do$;
`;

export const migration0018: Migration = {
  version: "0018",
  name: "weighted-tsv",
  sql: SQL,
};
