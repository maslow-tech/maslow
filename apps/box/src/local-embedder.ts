import { EMBED_DIMS } from "@brain/schema";

import type { Embedder } from "./embedder.js";

/**
 * The box's own embedding model — weights baked into the image, inference
 * in-process on CPU via ONNX. No network egress, no provider account, no
 * IAM: semantic search works on any box the day it is installed, which is
 * the whole appliance pitch.
 *
 * Model: chosen by the 2026-07 retrieval eval (see the design spec) from the
 * ~100-150M retrieval-tuned class; int8-quantized ONNX runs ~50-150 ms per
 * embed on the fleet's smallest box (2 vCPU). The model directory is copied
 * into the image at build time, pinned by upstream revision — transformers.js
 * is configured local-only so a missing file can never turn into a runtime
 * download.
 *
 * Loading is lazy + memoized behind preload(): boot calls preload() and on
 * failure DISABLES the semantic arm rather than crashing — a corrupt model
 * must never brick a box (same doctrine as a missing pgvector).
 */

/** Query/document instruction prefixes, per retrieval-tuned model family. */
interface LocalEmbedderOptions {
  /** Directory holding the model folder (default: BRAIN_MODEL_DIR or /app/models). */
  readonly modelDir?: string;
  /** Model folder name inside modelDir. */
  readonly modelName?: string;
  readonly queryPrefix?: string;
  readonly documentPrefix?: string;
}

const DEFAULT_MODEL_NAME = "nomic-embed-text-v1.5";
const DEFAULT_QUERY_PREFIX = "search_query: ";
const DEFAULT_DOCUMENT_PREFIX = "search_document: ";

type FeatureExtractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

export class LocalEmbedder implements Embedder {
  private readonly modelDir: string;
  private readonly modelName: string;
  private readonly queryPrefix: string;
  private readonly documentPrefix: string;
  private extractor?: Promise<FeatureExtractor>;

  constructor(opts: LocalEmbedderOptions = {}) {
    this.modelDir = opts.modelDir ?? process.env.BRAIN_MODEL_DIR ?? "/app/models";
    this.modelName = opts.modelName ?? DEFAULT_MODEL_NAME;
    this.queryPrefix = opts.queryPrefix ?? DEFAULT_QUERY_PREFIX;
    this.documentPrefix = opts.documentPrefix ?? DEFAULT_DOCUMENT_PREFIX;
  }

  /**
   * Load tokenizer + weights and run one warm-up embed. Boot awaits this and
   * treats a rejection as "no semantic search on this box" — so all failure
   * modes (missing dir, corrupt onnx, unsupported arch) surface HERE, not on
   * the first user search.
   */
  async preload(): Promise<void> {
    const e = await this.load();
    await e("warm-up", { pooling: "mean", normalize: true });
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(this.queryPrefix + text);
  }

  async embedDocument(text: string): Promise<number[]> {
    return this.embed(this.documentPrefix + text);
  }

  private load(): Promise<FeatureExtractor> {
    // Memoized as a promise so concurrent first calls share one load; a
    // REJECTED load is cleared so a transient failure (EMFILE etc.) can
    // retry instead of poisoning every future embed.
    this.extractor ??= (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.localModelPath = this.modelDir;
      env.allowRemoteModels = false; // an appliance never phones home
      const p = await pipeline("feature-extraction", this.modelName, { dtype: "q8" });
      return p as unknown as FeatureExtractor;
    })();
    this.extractor.catch(() => {
      this.extractor = undefined;
    });
    return this.extractor;
  }

  private async embed(text: string): Promise<number[]> {
    const extractor = await this.load();
    const out = await extractor(text, { pooling: "mean", normalize: true });
    const vec = Array.from(out.data);
    if (vec.length < EMBED_DIMS) {
      throw new Error(
        `model ${this.modelName} returned ${vec.length} dims; schema needs ${EMBED_DIMS}`,
      );
    }
    if (vec.length === EMBED_DIMS) return vec;
    // Matryoshka truncation: keep the first EMBED_DIMS components, renormalize.
    const cut = vec.slice(0, EMBED_DIMS);
    const norm = Math.sqrt(cut.reduce((s, x) => s + x * x, 0)) || 1;
    return cut.map((x) => x / norm);
  }
}
