import type { Migration } from "./types.js";

/**
 * 0014 — semantic search substrate (tool-surface v2, phase 2).
 *
 * A pgvector-backed sidecar table: one embedding per live object, maintained
 * by the box's background sweep (apps/box/src/embedder.ts) as brain_owner —
 * NOT by the write path, so writes never wait on (or fail with) an embedding
 * provider, and the same sweep is the backfill for pre-existing objects.
 *
 * Sidecar table instead of columns on `objects`, deliberately:
 *   - no audit/prop-history triggers fire for embedding maintenance (no
 *     timeline spam, no version bumps),
 *   - brain_app's column-narrowed UPDATE grant on objects (0012) stays intact,
 *   - RLS is one EXISTS policy, same shape as every derived table.
 *
 * GUARDED on pgvector being installable: a box whose postgres image lacks the
 * extension (pre-v2 image, stock postgres) applies this migration as a no-op
 * and keeps lexical-only search — never a bricked update. The reader detects
 * the table's absence at runtime (to_regclass) and skips the semantic arm.
 *
 * 1024 dims = Bedrock Titan Text Embeddings V2 default (the box's embedder).
 */

/**
 * The embeddings substrate DDL, shared verbatim between this migration and
 * the box's boot-time self-heal (a box whose pgvector arrived AFTER 0014
 * no-op'd can still grow the table — migrations are append-only and never
 * re-run). Plain statements (not EXECUTE): plpgsql resolves them only when
 * reached, so a guard's early RETURN keeps the vector type unevaluated on
 * boxes without the extension.
 */
export const EMBEDDINGS_DDL = `
  CREATE TABLE object_embeddings (
    object_id uuid PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
    embedding vector(1024) NOT NULL,
    source_version bigint NOT NULL,
    embedded_at timestamptz NOT NULL DEFAULT now()
  );

  -- cosine HNSW: the reader orders by embedding <=> query.
  CREATE INDEX object_embeddings_hnsw
    ON object_embeddings USING hnsw (embedding vector_cosine_ops);

  -- Same visibility story as every derived table (0012): a row resolves only
  -- if its object does. brain_app only ever SELECTs; the owner sweep writes.
  ALTER TABLE object_embeddings ENABLE ROW LEVEL SECURITY;
  CREATE POLICY brain_visibility ON object_embeddings
    USING (EXISTS (SELECT 1 FROM objects o WHERE o.id = object_id));
  GRANT SELECT ON object_embeddings TO brain_app;
`;

const SQL = `
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000000', true);
SET LOCAL lock_timeout = '5s';

DO $do$
BEGIN
  -- The extension is normally pre-installed by the provisioning layer (the
  -- box postgres image's initdb script; template1 in tests) because CREATE
  -- EXTENSION needs superuser and migrations run as brain_owner. Still try —
  -- and on any box where it can't happen, no-op instead of bricking the
  -- update: search stays lexical there (the box self-heals the table at boot
  -- if pgvector is installed later).
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      CREATE EXTENSION vector;
    EXCEPTION WHEN insufficient_privilege OR undefined_file OR undefined_object
                 OR feature_not_supported THEN
      RAISE NOTICE 'pgvector not installable here — semantic search stays disabled';
      RETURN;
    END;
  END IF;

${EMBEDDINGS_DDL}
END
$do$;
`;

export const migration0014: Migration = {
  version: "0014",
  name: "embeddings",
  sql: SQL,
};
