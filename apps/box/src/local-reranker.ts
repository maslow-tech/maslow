/**
 * Optional local cross-encoder reranker (retrieval stack v2, stage 5).
 *
 * A cross-encoder reads query + candidate JOINTLY with full attention — far
 * more accurate ordering than comparing two precomputed vectors, far too
 * slow to run against every object. So it only reorders the head of the
 * fused list (RERANK_WINDOW in the reader).
 *
 * This stage EARNED its place on the retrieval eval (+1.6 P@5 / +3.6 MRR
 * over semantic-only; it also converts the graph arm from negative to
 * positive) and on the 2 vCPU soak (~616 ms per 20-candidate pass), so it
 * runs unconditionally. The reader treats a null/failed rerank as "keep the
 * fused order", so a box without the model just skips the stage.
 *
 * Same locality rules as the embedder: weights baked into the image, pinned
 * revision, transformers.js local-only, preload-or-disable at boot.
 */

interface LocalRerankerOptions {
  readonly modelDir?: string;
  readonly modelName?: string;
}

const DEFAULT_RERANKER_NAME = "mxbai-rerank-xsmall-v1";

interface RankerParts {
  tokenizer: (
    a: string[],
    opts: { text_pair: string[]; padding: boolean; truncation: boolean },
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  model: (inputs: Record<string, unknown>) => Promise<{ logits: { data: Float32Array } }>;
}

export class LocalReranker {
  private readonly modelDir: string;
  private readonly modelName: string;
  private parts?: Promise<RankerParts>;

  constructor(opts: LocalRerankerOptions = {}) {
    this.modelDir = opts.modelDir ?? process.env.BRAIN_MODEL_DIR ?? "/app/models";
    this.modelName = opts.modelName ?? DEFAULT_RERANKER_NAME;
  }

  /** Load + one warm-up score; boot awaits this and disables the stage on
   * failure (a broken reranker must never brick a box or a search). */
  async preload(): Promise<void> {
    await this.score("warm-up", ["warm-up"]);
  }

  async rerank(
    query: string,
    candidates: ReadonlyArray<{ id: string; text: string }>,
  ): Promise<Array<{ id: string; score: number }>> {
    if (candidates.length === 0) return [];
    const scores = await this.score(
      query,
      candidates.map((c) => c.text),
    );
    return candidates.map((c, i) => ({ id: c.id, score: scores[i] ?? -Infinity }));
  }

  private load(): Promise<RankerParts> {
    this.parts ??= (async () => {
      const { env, AutoTokenizer, AutoModelForSequenceClassification } =
        await import("@huggingface/transformers");
      env.localModelPath = this.modelDir;
      env.allowRemoteModels = false;
      const tokenizer = await AutoTokenizer.from_pretrained(this.modelName);
      const model = await AutoModelForSequenceClassification.from_pretrained(this.modelName, {
        dtype: "q8",
      });
      return { tokenizer, model } as unknown as RankerParts;
    })();
    this.parts.catch(() => {
      this.parts = undefined;
    });
    return this.parts;
  }

  private async score(query: string, texts: string[]): Promise<number[]> {
    const { tokenizer, model } = await this.load();
    const inputs = await tokenizer(new Array(texts.length).fill(query) as string[], {
      text_pair: texts,
      padding: true,
      truncation: true,
    });
    const out = await model(inputs);
    // One relevance logit per pair; monotonic, so no sigmoid needed to sort.
    return Array.from(out.logits.data);
  }
}
