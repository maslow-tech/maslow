import { describe, expect, it } from "vitest";
import {
  limitConcurrency,
  memoizeEmbedQuery,
  memoizeRerank,
  type RerankCandidate,
} from "./inference-cache.js";

describe("memoizeEmbedQuery", () => {
  it("calls the model once for a repeated query", async () => {
    let calls = 0;
    const embed = memoizeEmbedQuery(async (q) => {
      calls++;
      return [q.length];
    });
    expect(await embed("hello")).toEqual([5]);
    expect(await embed("hello")).toEqual([5]);
    expect(calls).toBe(1);
    expect(embed.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("treats case and whitespace differences as the same query", async () => {
    let calls = 0;
    const embed = memoizeEmbedQuery(async () => {
      calls++;
      return [1];
    });
    await embed("Who owns  billing?");
    await embed("who owns billing?");
    await embed("  WHO OWNS BILLING?  ");
    expect(calls).toBe(1);
  });

  it("collapses CONCURRENT identical queries into one inference", async () => {
    // the load case that matters: N agents searching the same thing at once
    let calls = 0;
    const embed = memoizeEmbedQuery(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return [7];
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => embed("same")));
    expect(calls).toBe(1);
    expect(results.every((r) => r?.[0] === 7)).toBe(true);
  });

  it("does not cache a rejection — the next call retries the model", async () => {
    let calls = 0;
    const embed = memoizeEmbedQuery(async () => {
      calls++;
      if (calls === 1) throw new Error("model warming up");
      return [2];
    });
    await expect(embed("q")).rejects.toThrow("model warming up");
    expect(await embed("q")).toEqual([2]);
    expect(calls).toBe(2);
  });

  it("evicts oldest entries past max", async () => {
    let calls = 0;
    const embed = memoizeEmbedQuery(
      async () => {
        calls++;
        return [1];
      },
      { max: 2 },
    );
    await embed("a");
    await embed("b");
    await embed("c"); // evicts "a"
    await embed("a"); // miss again
    expect(calls).toBe(4);
    expect(embed.stats().size).toBe(2);
  });
});

describe("memoizeRerank", () => {
  const cands = (...ids: string[]): RerankCandidate[] =>
    ids.map((id) => ({ id, text: `text-${id}` }));

  it("only scores candidates it has not seen for this query", async () => {
    const seen: string[][] = [];
    const rerank = memoizeRerank(async (_q, c) => {
      seen.push(c.map((x) => x.id));
      return c.map((x) => ({ id: x.id, score: x.id.charCodeAt(0) }));
    });

    await rerank("q", cands("a", "b", "c"));
    await rerank("q", cands("b", "c", "d")); // only "d" is new

    expect(seen[0]).toEqual(["a", "b", "c"]);
    expect(seen[1]).toEqual(["d"]);
  });

  it("returns scores for every candidate, cached or fresh, in input order", async () => {
    const rerank = memoizeRerank(async (_q, c) =>
      c.map((x) => ({ id: x.id, score: x.id === "a" ? 10 : 1 })),
    );
    await rerank("q", cands("a"));
    const out = await rerank("q", cands("a", "b"));
    expect(out).toEqual([
      { id: "a", score: 10 },
      { id: "b", score: 1 },
    ]);
  });

  it("re-scores when a candidate's TEXT changed, even with the same id", async () => {
    let calls = 0;
    const rerank = memoizeRerank(async (_q, c) => {
      calls++;
      return c.map((x) => ({ id: x.id, score: x.text.length }));
    });
    await rerank("q", [{ id: "a", text: "short" }]);
    const out = await rerank("q", [{ id: "a", text: "much longer text" }]);
    expect(calls).toBe(2);
    expect(out).toEqual([{ id: "a", score: 16 }]);
  });

  it("keys on the query — the same candidate under a different query re-scores", async () => {
    let calls = 0;
    const rerank = memoizeRerank(async (_q, c) => {
      calls++;
      return c.map((x) => ({ id: x.id, score: 1 }));
    });
    await rerank("first", cands("a"));
    await rerank("second", cands("a"));
    expect(calls).toBe(2);
  });

  it("passes a null through instead of returning a half-scored list", async () => {
    // null means the reranker is unavailable; the caller must see that, not a
    // partial ordering it would treat as complete
    const rerank = memoizeRerank(async (_q, c) => (c.length > 0 ? null : []));
    await expect(rerank("q", cands("a"))).resolves.toBeNull();
  });
});

describe("limitConcurrency", () => {
  it("never exceeds the cap and still completes every call", async () => {
    let active = 0;
    let peak = 0;
    const work = limitConcurrency(async (n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    }, 2);

    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => work(i)));
    expect(peak).toBeLessThanOrEqual(2);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("releases its slot when the wrapped call throws", async () => {
    const work = limitConcurrency(async (fail: boolean) => {
      if (fail) throw new Error("boom");
      return "ok";
    }, 1);
    await expect(work(true)).rejects.toThrow("boom");
    // a leaked slot would deadlock this call
    await expect(work(false)).resolves.toBe("ok");
  });

  it("rejects a nonsensical cap", () => {
    expect(() => limitConcurrency(async () => 1, 0)).toThrow();
  });
});
