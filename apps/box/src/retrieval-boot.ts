import { Client } from "pg";
import { CHUNKS_DDL } from "@brain/schema";
import { startEmbedSweep } from "./embedder.js";
import { LocalEmbedder } from "./local-embedder.js";
import { LocalReranker } from "./local-reranker.js";
import { limitConcurrency, memoizeEmbedQuery, memoizeRerank } from "./inference-cache.js";

/**
 * Retrieval stack v2 boot — ONE routine for every box (prod boot and the dev
 * harness), so the never-brick guarantees can't drift between them:
 *
 * - probe object_chunks; if missing but pgvector is installed, self-heal with
 *   the shared DDL (0029 no-ops on a box without the extension; boot is the
 *   retry point because append-only migrations never re-run)
 * - load the embedder (only when the table is ready) and the reranker
 *   CONCURRENTLY; either failing just disables its stage — a corrupt model or
 *   missing pgvector serves lexical search and keeps updating, never bricks
 * - the embed sweep gets its own DEDICATED owner connection (never the
 *   executor's client — its queries would land inside executor transactions),
 *   with an error listener so a dropped connection can't crash the process
 */
interface RetrievalBootOptions {
  /** Connected brain_owner client, used only for the chunks-table probe/heal. */
  readonly ownerClient: Client;
  /** Owner connection string for the sweep's dedicated client. */
  readonly ownerUrl: string;
  /** Model directory override (default: BRAIN_MODEL_DIR, then /app/models). */
  readonly modelDir?: string;
  /** Sweep cadence override — the dev harness runs hot to embed a fresh seed
   *  in seconds; prod keeps the defaults. */
  readonly sweep?: { intervalMs?: number; batchSize?: number };
  /** Disk write-shed signal: pauses the embed sweep under
   *  disk pressure (the same guard the Writer uses — one measurement source). */
  readonly shouldShed?: () => Promise<boolean>;
}

export interface RetrievalStack {
  readonly embedQuery?: (query: string) => Promise<number[] | null>;
  readonly rerank?: (
    query: string,
    candidates: ReadonlyArray<{ id: string; text: string }>,
  ) => Promise<Array<{ id: string; score: number }> | null>;
}

/** Concurrent local inferences allowed on the request path. Default 2 — enough
 *  to keep the model busy without letting a burst starve /healthz, writes, and
 *  websocket upgrades on a 2-vCPU box. Override with BRAIN_INFERENCE_CONCURRENCY. */
function inferenceConcurrency(): number {
  const raw = Number(process.env["BRAIN_INFERENCE_CONCURRENCY"] ?? "");
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

export async function initRetrievalStack(opts: RetrievalBootOptions): Promise<RetrievalStack> {
  const infMax = inferenceConcurrency();
  const probe = await opts.ownerClient.query<{ ok: boolean }>(
    "SELECT to_regclass('public.object_chunks') IS NOT NULL AS ok",
  );
  let ready = probe.rows[0]?.ok ?? false;
  if (!ready) {
    const ext = await opts.ownerClient.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    if ((ext.rowCount ?? 0) > 0) {
      await opts.ownerClient.query(CHUNKS_DDL);
      console.log("embeddings: created object_chunks (pgvector installed post-0029)");
      ready = true;
    }
  }

  const dirOpt = opts.modelDir ? { modelDir: opts.modelDir } : {};
  const embedder = new LocalEmbedder(dirOpt);
  const reranker = new LocalReranker(dirOpt);
  // The two model loads are independent — warm them concurrently. The
  // embedder is only worth loading when the chunks table exists.
  const [embedLoad, rerankLoad] = await Promise.allSettled([
    ready
      ? embedder.preload()
      : Promise.reject(new Error("object_chunks missing (postgres lacks pgvector)")),
    reranker.preload(),
  ]);

  let embedQuery: RetrievalStack["embedQuery"];
  if (!ready) {
    console.warn(
      "embeddings: object_chunks is missing (postgres lacks pgvector) — " +
        "semantic search disabled, lexical only",
    );
  } else if (embedLoad.status === "rejected") {
    console.warn(
      "embeddings: local model failed to load — semantic search disabled, " +
        `lexical only (${String(embedLoad.reason)})`,
    );
  } else {
    const sweepClient = new Client({ connectionString: opts.ownerUrl });
    // ponytail: no auto-reconnect — sweep ticks fail loudly until restart
    sweepClient.on("error", (e) => console.warn(`embed-sweep client: ${String(e)}`));
    await sweepClient.connect();
    // Since 0039 the content tables are FORCE ROW LEVEL SECURITY, so brain_owner
    // no longer sees private objects by ownership. The sweep must embed them too
    // (their vectors stay RLS-guarded in object_chunks) — become brain_system,
    // the one BYPASSRLS role, for this connection only. If the role isn't there
    // yet (a box mid-transition, before 0039), log and keep going as brain_owner:
    // org objects still embed; private ones catch up once the migration lands.
    try {
      await sweepClient.query("SET ROLE brain_system");
    } catch (e) {
      console.warn(
        `embed-sweep: could not SET ROLE brain_system (${String(e)}) — ` +
          "private objects will not embed until 0039 has applied",
      );
    }
    startEmbedSweep({
      ownerClient: sweepClient,
      embedder,
      ...(opts.sweep ?? {}),
      ...(opts.shouldShed ? { shouldShed: opts.shouldShed } : {}),
    });
    // Cached + admission-controlled: see inference-cache.ts. Search costs one
    // embedding plus RERANK_WINDOW cross-encoder passes, all on the request
    // path, and that is what saturates a 2-vCPU box under concurrency
    // (see inference-cache.ts). Cache misses behave exactly as before.
    embedQuery = memoizeEmbedQuery(limitConcurrency((q: string) => embedder.embedQuery(q), infMax));
    console.log(
      "embeddings: local sweep + hybrid search enabled (cached, " + `max ${infMax} concurrent)`,
    );
  }

  let rerank: RetrievalStack["rerank"];
  if (rerankLoad.status === "fulfilled") {
    // The reranker is ~20x the embedder's cost per search, so it gets the same
    // treatment: only genuinely new (query, candidate) pairs reach the model.
    rerank = memoizeRerank(
      limitConcurrency(
        (q: string, cands: ReadonlyArray<{ id: string; text: string }>) =>
          reranker.rerank(q, cands),
        infMax,
      ),
    );
    console.log(`reranker: local cross-encoder enabled (cached, max ${infMax} concurrent)`);
  } else {
    console.warn(
      `reranker: local model failed to load — stage disabled (${String(rerankLoad.reason)})`,
    );
  }

  return { ...(embedQuery ? { embedQuery } : {}), ...(rerank ? { rerank } : {}) };
}
