import type { Client } from "pg";

import { CHUNKER_VERSION, chunkBody } from "./chunker.js";

/**
 * Semantic-search embeddings (retrieval stack v2).
 *
 * Providers implement query/document asymmetry explicitly: retrieval-tuned
 * models (nomic, arctic) want different instruction prefixes on the query
 * side vs the corpus side, and hiding that inside one embed() invited the
 * bug where both sides silently used the same prefix.
 *
 * Maintenance is a background SWEEP, not a write-path hook: every tick it
 * (re)chunks + embeds a batch of objects whose chunks are missing or stale —
 * `source_version < objects.version` after an edit, or `chunker_version`
 * bumped by a chunker change. One mechanism covers backfill of pre-existing
 * objects AND keeps up with new writes; an embedder outage delays semantic
 * freshness but never blocks or fails a write. Runs as brain_owner on a
 * DEDICATED connection (never the executor's — its queries must not land
 * inside an executor transaction) so RLS is bypassed and private objects are
 * embedded too (their vectors stay RLS-guarded in the table).
 */

const EMBED_INPUT_CAP = 6000; // chars per embed call — bounds tokenizer work

/**
 * Ceiling on chunks embedded per object. A body at the 1 MB cap yields ~500
 * chunks; embedding them all would pin the sweep on one object for minutes.
 * Everything past the cap is simply not semantically indexed (lexical still
 * covers it) — and we log it, so the cap is never silent.
 */
const MAX_CHUNKS_PER_OBJECT = 120;

export interface Embedder {
  /** Embed a search query (query-side instruction prefix, if the model has one). */
  embedQuery(text: string): Promise<number[]>;
  /** Embed corpus content (document-side prefix, if the model has one). */
  embedDocument(text: string): Promise<number[]>;
}

/**
 * Chunks an object for embedding. Body chunks come from the deterministic
 * chunker; a body-less object still gets ONE chunk carrying its title, so
 * "Priya Patel" the person is semantically findable even with an empty body.
 * The stored chunk text is pure content; the EMBED input prepends the title
 * to every chunk (title context disambiguates pronouns and fragments).
 */
export function chunkObject(
  title: string | null,
  body: string | null,
): Array<{
  ix: number;
  text: string;
  embedInput: string;
}> {
  const t = (title ?? "").trim();
  let chunks = chunkBody(body ?? "");
  if (chunks.length === 0) {
    if (t === "") return [];
    chunks = [{ ix: 0, text: t }];
  }
  return chunks.map((c) => ({
    ix: c.ix,
    text: c.text,
    embedInput: `${t}\n${c.text}`.trim().slice(0, EMBED_INPUT_CAP),
  }));
}

interface EmbedSweepOptions {
  /** DEDICATED brain_owner connection (already connected). */
  readonly ownerClient: Client;
  readonly embedder: Embedder;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly log?: (msg: string) => void;
  /** disk write-shed signal: when true, PAUSE the sweep —
   *  embeddings are large pgvector rows and the biggest re-derivable filler, so
   *  under disk pressure they yield to keep the box writable. Skips the tick and
   *  retries next interval (never drops a due row — it stays due). */
  readonly shouldShed?: () => Promise<boolean>;
}

/** Start the sweep loop. Returns a stop() for tests/shutdown. */
export function startEmbedSweep(opts: EmbedSweepOptions): { stop: () => void } {
  const interval = opts.intervalMs ?? 15_000;
  const batch = opts.batchSize ?? 8;
  const log = opts.log ?? ((m) => console.log(m));
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let idleTicks = 0;

  // Reschedule the next tick with idle backoff. Extracted so the shed-skip path
  // still reschedules (a bare `return` from tick would halt the loop).
  const schedule = (didWork: boolean): void => {
    if (stopped) return;
    idleTicks = didWork ? 0 : Math.min(idleTicks + 1, 5);
    timer = setTimeout(() => void tick(), interval * 2 ** idleTicks);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // Under disk write-shed, pause: skip this tick so the biggest re-derivable
    // filler stops adding pressure. Due rows stay due and resume when it clears.
    if (opts.shouldShed && (await opts.shouldShed().catch(() => false))) {
      log("embed-sweep: paused (disk write-shed active)");
      schedule(false);
      return;
    }
    let didWork = false;
    try {
      // Empty title+body rows are EXCLUDED, not skipped in the loop: a skip
      // writes no row, so the object stays "due" forever and permanently
      // occupies batch slots — starving everything older than it. "Due" =
      // no chunk row that is BOTH version-fresh and chunker-fresh.
      const due = await opts.ownerClient.query<{
        id: string;
        title: string | null;
        body: string | null;
        version: string;
      }>(
        `SELECT o.id, o.title, o.body, o.version
           FROM objects o
          WHERE o.deleted_at IS NULL
            AND btrim(coalesce(o.title, '') || coalesce(o.body, '')) <> ''
            AND NOT EXISTS (
              SELECT 1 FROM object_chunks c
               WHERE c.object_id = o.id
                 AND c.source_version = o.version
                 AND c.chunker_version = ${CHUNKER_VERSION}
            )
          ORDER BY o.updated_at DESC
          LIMIT ${batch}`,
      );
      for (const row of due.rows) {
        // Per-object isolation: one deterministically-failing embed (bad
        // content, wrong-dim model) must not abort the batch every tick and
        // starve the rest of the backfill.
        try {
          const chunks = chunkObject(row.title, row.body);
          if (chunks.length > MAX_CHUNKS_PER_OBJECT) {
            log(
              `embed-sweep: object ${row.id}: ${chunks.length} chunks, embedding first ` +
                `${MAX_CHUNKS_PER_OBJECT} (rest stays lexical-only)`,
            );
            chunks.length = MAX_CHUNKS_PER_OBJECT;
          }
          // Embed OUTSIDE the write txn (slow model calls must not hold a
          // transaction open), then swap the object's chunk set atomically so
          // readers never see a half-written mix of old and new chunks.
          const vecs: string[] = [];
          for (const c of chunks) {
            const v = await opts.embedder.embedDocument(c.embedInput);
            vecs.push(`[${v.join(",")}]`);
          }
          await opts.ownerClient.query("BEGIN");
          try {
            await opts.ownerClient.query(`DELETE FROM object_chunks WHERE object_id = $1`, [
              row.id,
            ]);
            for (let i = 0; i < chunks.length; i++) {
              const c = chunks[i]!;
              await opts.ownerClient.query(
                `INSERT INTO object_chunks
                   (object_id, chunk_ix, text, embedding, source_version, chunker_version, embedded_at)
                 VALUES ($1, $2, $3, $4::vector, $5, $6, now())`,
                [row.id, c.ix, c.text, vecs[i], row.version, CHUNKER_VERSION],
              );
            }
            await opts.ownerClient.query("COMMIT");
          } catch (err) {
            await opts.ownerClient.query("ROLLBACK");
            throw err;
          }
          didWork = true;
        } catch (err) {
          log(`embed-sweep: object ${row.id}: ${String(err)}`);
        }
      }
    } catch (err) {
      // best-effort: log and let the next tick retry (model hiccup, etc.)
      log(`embed-sweep: ${String(err)}`);
    }
    // Idle backoff: an empty tick means nothing is due — don't anti-join the
    // whole objects table every 15s on a quiet box. Any work resets the pace.
    schedule(didWork);
  };

  void tick(); // first pass immediately (backfill starts on boot)
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
