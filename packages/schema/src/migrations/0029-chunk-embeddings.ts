import type { Migration } from "./types.js";

/**
 * 0029 — chunk-level local embeddings (retrieval stack v2).
 *
 * Replaces the per-OBJECT `object_embeddings` sidecar (0014, Bedrock Titan,
 * 1024 dims — never enabled on any box, empty fleet-wide) with per-CHUNK
 * `object_chunks` for the local embedding model:
 *
 *   - one row per ~300-word body chunk (apps/box/src/chunker.ts), so a query
 *     lands on the passage that answers it instead of a whole-document blur;
 *   - chunk text is STORED so a reranker can judge query+passage jointly
 *     without re-slicing bodies (chunk text is derived data, like the tsv);
 *   - dims match the box's local embedder (EMBED_DIMS), not Titan.
 *
 * Same doctrine as 0014, same guards:
 *   - sidecar table → no audit/prop-history triggers, brain_app stays
 *     SELECT-only, RLS is the one EXISTS policy every derived table uses;
 *   - GUARDED on pgvector: without the extension this whole migration is a
 *     no-op (RAISE NOTICE) and search stays lexical — never a bricked update.
 *     The boot self-heal (apps/box/src/index.ts) uses CHUNKS_DDL to grow the
 *     table later if pgvector appears, since migrations never re-run;
 *   - dropping object_embeddings is safe on ANY box state: it only ever held
 *     derived vectors and the sweep rebuilds everything from objects rows.
 */

/**
 * Embedding dimensionality of the box's local model. Matryoshka-truncated —
 * chosen by the retrieval eval (2026-07): see the retrieval design spec.
 * Changing this requires a NEW migration that rebuilds object_chunks.
 */
export const EMBED_DIMS = 768;

/** Chunk-embeddings DDL, shared verbatim between 0029 and the box's
 * boot-time self-heal (same pattern as 0014's EMBEDDINGS_DDL). */
export const CHUNKS_DDL = `
  CREATE TABLE object_chunks (
    object_id       uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    chunk_ix        int NOT NULL,
    text            text NOT NULL,
    embedding       vector(${EMBED_DIMS}) NOT NULL,
    source_version  bigint NOT NULL,
    chunker_version int NOT NULL,
    embedded_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (object_id, chunk_ix)
  );

  -- cosine HNSW: the reader's semantic arm orders by embedding <=> query.
  CREATE INDEX object_chunks_hnsw
    ON object_chunks USING hnsw (embedding vector_cosine_ops);

  -- Same visibility story as every derived table (0012): a row resolves only
  -- if its object does. brain_app only ever SELECTs; the owner sweep writes.
  ALTER TABLE object_chunks ENABLE ROW LEVEL SECURITY;
  CREATE POLICY brain_visibility ON object_chunks
    USING (EXISTS (SELECT 1 FROM objects o WHERE o.id = object_id));
  GRANT SELECT ON object_chunks TO brain_app;
`;

const SQL = `
SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000000', true);
SET LOCAL lock_timeout = '5s';

DO $do$
BEGIN
  -- The old per-object sidecar is superseded either way — drop it even on a
  -- box where pgvector is absent (there it never existed; IF EXISTS no-ops).
  DROP TABLE IF EXISTS object_embeddings;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    BEGIN
      CREATE EXTENSION vector;
    EXCEPTION WHEN insufficient_privilege OR undefined_file OR undefined_object
                 OR feature_not_supported THEN
      RAISE NOTICE 'pgvector not installable here — semantic search stays disabled';
      RETURN;
    END;
  END IF;

  -- A box whose boot self-heal already created the table (pgvector arrived
  -- between releases) keeps it — same shape by construction (shared DDL).
  IF to_regclass('public.object_chunks') IS NOT NULL THEN
    RAISE NOTICE 'object_chunks already exists — keeping it';
    RETURN;
  END IF;

${CHUNKS_DDL}
END
$do$;
`;

export const migration0029: Migration = {
  version: "0029",
  name: "chunk-embeddings",
  sql: SQL,
  allowDestructive: [
    {
      rule: "drop-table",
      match: "object_embeddings",
      reason:
        "drops object_embeddings, a derived-data sidecar that was never enabled on " +
        "any box (BRAIN_EMBEDDINGS unset fleet-wide, table empty everywhere); even " +
        "were it populated, the embed sweep rebuilds every row from objects — no " +
        "user data lives in it, so this is safe on a box we have never seen",
    },
  ],
};
