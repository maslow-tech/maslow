import type { Migration } from "./types.js";

/**
 * The DDL-exec primitives — the ONLY place DDL is
 * emitted. Each is a brain_owner PL/pgSQL function that assembles DDL from
 * PARAMETERS using `format('%I')` for every identifier; Node never sends raw
 * DDL text. The load-bearing guarantee is: identifier sanitizer (Node) +
 * `%I` quoting here, enforced by the static %I/%L quoting lint over these
 * bodies (quoting-lint.ts). No CHECK/DEFAULT is ever built from a string; enum
 * membership and defaults live in the catalog, not in DDL.
 *
 * Column SQL types are chosen server-side from a fixed whitelist (a CASE that
 * bakes the type into a literal format template) — never interpolated from
 * caller input — so there is no %s anywhere.
 *
 * EXECUTE privilege on all of these is revoked from PUBLIC: only brain_owner
 * (the executor's dedicated connection) calls them.
 */

const SQL = `
-- Create a <type>_ext table: the typed sibling of an objects spine row.
-- Base columns are fixed; typed columns are added by brain_add_column.
CREATE OR REPLACE FUNCTION brain_create_ext_table(p_ext_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TABLE %I (
       id uuid PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
       deleted_at timestamptz,
       tsv tsvector
     )', p_ext_table);
  -- GIN index on the typed-field search vector (D.5 spans ext tables too).
  EXECUTE format('CREATE INDEX ON %I USING gin (tsv)', p_ext_table);
END
$fn$;

-- Grant the app role DML on a generated table (ext or junction) so the write
-- path can populate it. Catalog tables never pass through here.
CREATE OR REPLACE FUNCTION brain_grant_app(p_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO brain_app', p_table);
END
$fn$;

-- Add a typed column. The SQL type is chosen from a fixed whitelist keyed by
-- the brain 'kind'; unsupported kinds raise. ref/ref[] columns are handled by
-- the caller (uuid column + separate FK, or a junction table).
CREATE OR REPLACE FUNCTION brain_add_column(p_table text, p_column text, p_kind text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  fmt text;
BEGIN
  fmt := CASE p_kind
    WHEN 'text'      THEN 'ALTER TABLE %I ADD COLUMN %I text'
    WHEN 'int'       THEN 'ALTER TABLE %I ADD COLUMN %I bigint'
    WHEN 'decimal'   THEN 'ALTER TABLE %I ADD COLUMN %I numeric'
    WHEN 'float'     THEN 'ALTER TABLE %I ADD COLUMN %I double precision'
    WHEN 'bool'      THEN 'ALTER TABLE %I ADD COLUMN %I boolean'
    WHEN 'date'      THEN 'ALTER TABLE %I ADD COLUMN %I date'
    WHEN 'timestamp' THEN 'ALTER TABLE %I ADD COLUMN %I timestamptz'
    WHEN 'enum'      THEN 'ALTER TABLE %I ADD COLUMN %I text'
    WHEN 'ref'       THEN 'ALTER TABLE %I ADD COLUMN %I uuid'
    ELSE NULL
  END;
  IF fmt IS NULL THEN
    RAISE EXCEPTION 'brain_add_column: unsupported kind %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  EXECUTE format(fmt, p_table, p_column);
END
$fn$;

-- decimal/float NaN/Inf sanity CHECK (D.6). Built from fixed literals; the
-- column identifier is the only interpolation.
CREATE OR REPLACE FUNCTION brain_add_numeric_check(p_table text, p_column text, p_constraint text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NULL OR (%I <> ''NaN'' AND %I NOT IN (''Infinity'', ''-Infinity'')))',
    p_table, p_constraint, p_column, p_column, p_column);
END
$fn$;

-- A ref column's FK, added post-creation and NOT VALID (so it is instant on a
-- populated table); validated separately (own txn) by brain_validate_constraint.
CREATE OR REPLACE FUNCTION brain_add_ref_fk(
  p_table text, p_constraint text, p_column text, p_target_ext text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I (id) NOT VALID',
    p_table, p_constraint, p_column, p_target_ext);
END
$fn$;

CREATE OR REPLACE FUNCTION brain_validate_constraint(p_table text, p_constraint text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', p_table, p_constraint);
END
$fn$;

-- A ref[] junction: a hidden table carrying a real FK per element.
CREATE OR REPLACE FUNCTION brain_create_junction(
  p_junction text, p_from_ext text, p_to_ext text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format(
    'CREATE TABLE %I (
       from_id uuid NOT NULL REFERENCES %I(id) ON DELETE CASCADE,
       to_id   uuid NOT NULL REFERENCES %I(id) ON DELETE CASCADE,
       PRIMARY KEY (from_id, to_id)
     )', p_junction, p_from_ext, p_to_ext);
END
$fn$;

-- Lock the primitives down: only brain_owner (function owner) may execute.
REVOKE EXECUTE ON FUNCTION brain_create_ext_table(text)                 FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_grant_app(text)                        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_add_column(text, text, text)           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_add_numeric_check(text, text, text)    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_add_ref_fk(text, text, text, text)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_validate_constraint(text, text)        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_create_junction(text, text, text)      FROM PUBLIC;
`;

export const migration0002: Migration = {
  version: "0002",
  name: "executor-primitives",
  sql: SQL,
};
