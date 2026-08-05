import { Pool, type Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
const RCTX: ReadContext = { actorId: SYSTEM };

describe("output-size guards: search batching, recent() summary default, getMany body cap", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let reader: Reader;
  let writer: Writer;

  beforeEach(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    owner = await brain.connect("owner");
    reader = new Reader(pool);
    writer = new Writer(pool);
  }, 120_000);

  afterEach(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  describe("searchMany: shared limit budget across a queries:[...] batch", () => {
    it("caps the COMBINED total across all queries, not each independently", async () => {
      // 25 objects that all match every one of 5 distinct query words.
      for (let i = 0; i < 25; i++) {
        await writer.write(WCTX, {
          title: `Batch Widget ${i}`,
          body: "alpha bravo charlie delta echo — every word matches",
        });
      }
      const result = await reader.searchMany(
        RCTX,
        ["alpha", "bravo", "charlie", "delta", "echo"],
        { limit: 200 }, // if applied per-query (the old bug), this would be 5 x 200 = 1000
      );
      expect(result).toHaveLength(5);
      const totalHits = result.reduce((sum, r) => sum + r.hits.length, 0);
      expect(totalHits).toBeLessThanOrEqual(200);
    });

    it("a single query in the batch behaves like an unbatched search (no unnecessary shrinkage)", async () => {
      for (let i = 0; i < 30; i++) {
        await writer.write(WCTX, { title: `Solo Widget ${i}`, body: "onlyword" });
      }
      const [single] = await reader.searchMany(RCTX, ["onlyword"], { limit: 25 });
      const direct = await reader.search(RCTX, "onlyword", { limit: 25 });
      expect(single!.hits).toHaveLength(direct.length);
    });
  });

  describe("recent(): summarized by default", () => {
    it("omitting summary now strips payloads (was raw by default)", async () => {
      await writer.write(WCTX, { title: "has a body", body: "x".repeat(2000) });
      const r = await reader.recent(RCTX, { limit: 10 });
      expect(r.events.length).toBeGreaterThan(0);
      expect(r.events.every((e) => !("payload" in e))).toBe(true);
    });

    it("summary:false still returns the full raw payload when actually needed", async () => {
      await writer.write(WCTX, { title: "has a body", body: "specific content to check for" });
      const r = await reader.recent(RCTX, { limit: 10, summary: false });
      const created = r.events.find((e) => e.kind === "create");
      expect(created).toBeDefined();
      expect(created).toHaveProperty("payload");
    });

    it("summary:true is unchanged (explicit true still summarizes)", async () => {
      await writer.write(WCTX, { title: "x" });
      const r = await reader.recent(RCTX, { limit: 10, summary: true });
      expect(r.events.every((e) => !("payload" in e))).toBe(true);
    });
  });

  describe("getMany: body truncation only when actually batching", () => {
    it("a single get() (via the singular path) returns the FULL body, untruncated", async () => {
      const bigBody = "y".repeat(8000);
      const w = await writer.write(WCTX, { title: "big", body: bigBody });
      const got = await reader.get(RCTX, w.id);
      expect(got.body).toBe(bigBody);
      expect(got).not.toHaveProperty("body_truncated");
    });

    it("getMany with a SINGLE id in the array also returns the full body (batch size 1 = get)", async () => {
      const bigBody = "y".repeat(8000);
      const w = await writer.write(WCTX, { title: "big", body: bigBody });
      const [got] = await reader.getMany(RCTX, [w.id]);
      expect(got!.body).toBe(bigBody);
      expect(got).not.toHaveProperty("body_truncated");
    });

    it("getMany with MULTIPLE ids truncates each large body and flags it", async () => {
      const bigBody = "y".repeat(8000);
      const a = await writer.write(WCTX, { title: "big a", body: bigBody });
      const b = await writer.write(WCTX, { title: "big b", body: bigBody });
      const results = await reader.getMany(RCTX, [a.id, b.id]);
      for (const r of results) {
        expect((r.body as string).length).toBeLessThan(bigBody.length);
        expect(r.body_truncated).toBe(true);
      }
    });

    it("getMany with multiple ids does NOT truncate or flag a body under the cap", async () => {
      const smallBody = "short body";
      const a = await writer.write(WCTX, { title: "small a", body: smallBody });
      const b = await writer.write(WCTX, { title: "small b", body: smallBody });
      const results = await reader.getMany(RCTX, [a.id, b.id]);
      for (const r of results) {
        expect(r.body).toBe(smallBody);
        expect(r).not.toHaveProperty("body_truncated");
      }
    });
  });

  describe("search(): fuzzy title matching only runs as a true zero-hit fallback", () => {
    it("does NOT blend in fuzzy title noise when lexical already found real matches", async () => {
      // Real lexical hit: "orange" appears as its own word.
      const realHit = await writer.write(WCTX, {
        title: "Orange Corp",
        body: "our orange business",
      });
      // A fuzzy-ONLY match: "orange" is a raw substring of "Storange", but tsv
      // tokenizes "storange" as one word — it does NOT lexically match a
      // search for "orange". Only the ILIKE fuzzy pass would ever find this.
      await writer.write(WCTX, { title: "Storange Industries", body: "unrelated content" });

      const hits = await reader.search(RCTX, "orange", { semantic: false });
      expect(hits.some((h) => h.id === realHit.id)).toBe(true);
      // The fuzzy-only doc must be absent entirely — not just unlabeled —
      // because lexical already returned a real match.
      expect(hits.some((h) => h.match === "title_fuzzy")).toBe(false);
    });

    it("still falls back to fuzzy title matching when lexical finds nothing", async () => {
      const fuzzyOnly = await writer.write(WCTX, {
        title: "Zorbington Numbers",
        body: "unrelated body text",
      });
      // "zorb" won't stem-match "Zorbington" via full-text (different token),
      // but the ILIKE fuzzy pass should still find it since lexical is empty.
      const hits = await reader.search(RCTX, "zorb", { semantic: false });
      expect(hits.some((h) => h.id === fuzzyOnly.id && h.match === "title_fuzzy")).toBe(true);
    });
  });
});
