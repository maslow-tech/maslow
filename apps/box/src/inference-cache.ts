/**
 * Caching + admission control for the box's two local models.
 *
 * WHY THIS EXISTS (measured on a production 2-vCPU box):
 * under ~17 concurrent searchers the app pegged one core at 97% while Postgres
 * sat at 0.08%. The bottleneck is not the database — it is local model inference
 * on the request path. Every `search` costs 1 query embedding + RERANK_WINDOW
 * (20) cross-encoder passes, so ~21 inferences per search, serialised onto a
 * single-threaded event loop on a 2-vCPU box.
 *
 * Clustering across both cores is the other half of the fix, but it is NOT safe
 * here yet: live collab rooms (CRDT state) live in one process's memory, so a
 * websocket landing on the wrong worker cannot see its room. That needs session
 * affinity first. This module is the part that is safe today.
 *
 * Three levers, all pure wrappers — no behaviour change when they miss:
 *   1. memoizeEmbedQuery — identical queries skip the model entirely.
 *   2. memoizeRerank     — per (query, candidate) score cache; a repeated query
 *                          over an overlapping candidate set only scores what is
 *                          genuinely new, which is the common case when an agent
 *                          pages or rephrases.
 *   3. limitConcurrency  — caps in-flight inference so a burst queues instead of
 *                          starving the event loop that also serves /healthz,
 *                          writes, and websocket upgrades.
 *
 * Caches are per-process and in-memory: a restart loses them, which is fine —
 * they are an optimisation, never a source of truth. Entries are keyed by exact
 * text, so a changed document produces a different key rather than a stale hit.
 */

/** Small LRU. Map preserves insertion order, so the oldest key is the first. */
class Lru<V> {
  private readonly m = new Map<string, V>();
  constructor(private readonly max: number) {}

  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v === undefined) return undefined;
    // refresh recency
    this.m.delete(k);
    this.m.set(k, v);
    return v;
  }

  set(k: string, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) {
      const oldest = this.m.keys().next();
      if (!oldest.done) this.m.delete(oldest.value);
    }
  }

  get size(): number {
    return this.m.size;
  }
}

/** Queries differing only in case/whitespace are the same query to the model. */
const normalise = (q: string): string => q.trim().replace(/\s+/g, " ").toLowerCase();

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export interface MemoizedEmbedQuery {
  (query: string): Promise<number[] | null>;
  readonly stats: () => CacheStats;
}

/**
 * Cache query embeddings, and collapse concurrent identical queries into ONE
 * inference. The in-flight map matters as much as the cache: N agents issuing
 * the same search simultaneously would otherwise each pay for the model.
 */
export function memoizeEmbedQuery(
  fn: (query: string) => Promise<number[] | null>,
  opts: { max?: number } = {},
): MemoizedEmbedQuery {
  const cache = new Lru<number[] | null>(opts.max ?? 512);
  const inflight = new Map<string, Promise<number[] | null>>();
  let hits = 0;
  let misses = 0;

  const wrapped = async (query: string): Promise<number[] | null> => {
    const key = normalise(query);
    const cached = cache.get(key);
    if (cached !== undefined) {
      hits++;
      return cached;
    }
    const pending = inflight.get(key);
    if (pending) {
      hits++;
      return pending;
    }
    misses++;
    const p = (async () => {
      try {
        const v = await fn(query);
        cache.set(key, v);
        return v;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };

  return Object.assign(wrapped, {
    stats: (): CacheStats => ({ hits, misses, size: cache.size }),
  });
}

export interface RerankCandidate {
  readonly id: string;
  readonly text: string;
}
export interface RerankScore {
  readonly id: string;
  readonly score: number;
}
type RerankFn = (
  query: string,
  candidates: readonly RerankCandidate[],
) => Promise<RerankScore[] | null>;

export interface MemoizedRerank {
  (query: string, candidates: readonly RerankCandidate[]): Promise<RerankScore[] | null>;
  readonly stats: () => CacheStats;
}

/**
 * Cache cross-encoder scores per (query, candidate). This is the expensive one:
 * the reranker scores 20 pairs per search, so it is ~20x the query-embedding
 * cost. Only genuinely new pairs reach the model; cached ones are merged back in
 * their original positions.
 *
 * The candidate's TEXT is part of the key, so an edited object re-scores instead
 * of serving a stale score.
 */
export function memoizeRerank(fn: RerankFn, opts: { max?: number } = {}): MemoizedRerank {
  const cache = new Lru<number>(opts.max ?? 4096);
  let hits = 0;
  let misses = 0;

  const keyFor = (q: string, c: RerankCandidate): string => {
    // length-prefix the id so an id containing the separator cannot collide
    return `${normalise(q)}\u0000${c.id.length}:${c.id}\u0000${hashText(c.text)}`;
  };

  const wrapped = async (
    query: string,
    candidates: readonly RerankCandidate[],
  ): Promise<RerankScore[] | null> => {
    const out = new Map<string, number>();
    const missing: RerankCandidate[] = [];

    for (const c of candidates) {
      const hit = cache.get(keyFor(query, c));
      if (hit === undefined) missing.push(c);
      else {
        hits++;
        out.set(c.id, hit);
      }
    }

    if (missing.length > 0) {
      misses += missing.length;
      const scored = await fn(query, missing);
      // A null means "reranker unavailable" — pass that through untouched rather
      // than returning a half-scored list the caller would treat as complete.
      if (!scored) return null;
      for (const s of scored) {
        out.set(s.id, s.score);
        const cand = missing.find((m) => m.id === s.id);
        if (cand) cache.set(keyFor(query, cand), s.score);
      }
    }

    return candidates
      .filter((c) => out.has(c.id))
      .map((c) => ({ id: c.id, score: out.get(c.id) as number }));
  };

  return Object.assign(wrapped, {
    stats: (): CacheStats => ({ hits, misses, size: cache.size }),
  });
}

/** FNV-1a — cheap, non-cryptographic, only needs to detect text changes. */
function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Cap concurrent inference. This does NOT make the model faster — it stops a
 * burst of searches from monopolising the event loop, so cheap requests
 * (/healthz, writes, websocket upgrades) still get served while the queue drains.
 * Order is preserved: callers are released FIFO.
 */
export function limitConcurrency<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  max: number,
): (...args: A) => Promise<R> {
  if (max <= 0) throw new Error("limitConcurrency: max must be >= 1");
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return async (...args: A): Promise<R> => {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn(...args);
    } finally {
      release();
    }
  };
}
