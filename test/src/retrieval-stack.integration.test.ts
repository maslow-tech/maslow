import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { startEmbedSweep, type Embedder } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
const RCTX: ReadContext = { actorId: SYSTEM };

/** 768-dim unit vector on one axis — cheap cosine anchors. */
function axisArr(i: number): number[] {
  const v = new Array<number>(768).fill(0);
  v[i] = 1;
  return v;
}
const axisStr = (i: number): string => `[${axisArr(i).join(",")}]`;

/** Keyword→axis fake embedder: deterministic, no model needed. Texts about
 * the same topic land on the same axis (cosine 1), others are orthogonal. */
const TOPICS: Record<string, number> = { dental: 3, billing: 7, rocket: 700 };
function vecFor(text: string): number[] {
  const t = text.toLowerCase();
  for (const [kw, ax] of Object.entries(TOPICS)) if (t.includes(kw)) return axisArr(ax);
  return axisArr(500);
}
const fakeEmbedder: Embedder = {
  embedQuery: (t) => Promise.resolve(vecFor(t)),
  embedDocument: (t) => Promise.resolve(vecFor(t)),
};

const words = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

describe("retrieval stack v2 · chunk sweep, graph augmentation, rerank, diversity", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let writer: Writer;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    owner = await brain.connect("owner");
    writer = new Writer(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  describe("embed sweep (chunk-level)", () => {
    it("chunks + embeds due objects, including title-only ones, then goes idle", async () => {
      const long = await writer.write(WCTX, {
        title: "Dental practice handbook",
        body: `${words(320, "aa")}\n\n${words(320, "bb")}`,
      });
      const titleOnly = await writer.write(WCTX, { title: "Priya Patel" });

      // Production drives the sweep as brain_system (retrieval-boot.ts SET ROLE
      // brain_system, the one BYPASSRLS role): since the 0057 tag model a bare
      // brain_owner connection holds no tags and sees NO objects at all — the
      // sweep would find nothing due and this poll would read zero chunks
      // forever. Mirror boot on the same client, reset after.
      await owner.query("SET ROLE brain_system");
      const sweep = startEmbedSweep({
        ownerClient: owner,
        embedder: fakeEmbedder,
        intervalMs: 50,
        batchSize: 4,
        log: () => {},
      });
      try {
        await expect
          .poll(
            async () => {
              const r = await owner.query(
                `SELECT count(*)::int AS n FROM object_chunks WHERE object_id = ANY($1::uuid[])`,
                [[long.id, titleOnly.id]],
              );
              return r.rows[0]!.n as number;
            },
            { timeout: 10_000 },
          )
          .toBeGreaterThanOrEqual(3); // ≥2 chunks for the long body + 1 title-only
        const chunks = await owner.query(
          `SELECT object_id, chunk_ix, text, source_version FROM object_chunks
           WHERE object_id = $1 ORDER BY chunk_ix`,
          [titleOnly.id],
        );
        expect(chunks.rows).toHaveLength(1);
        expect(chunks.rows[0]!.text).toBe("Priya Patel");
      } finally {
        sweep.stop();
        await owner.query("RESET ROLE");
      }
    });

    it("re-embeds after an edit (source_version follows objects.version)", async () => {
      const obj = await writer.write(WCTX, { title: "Rocket notes", body: "rocket telemetry" });
      // Same as above: the sweep and its readback run as brain_system, exactly
      // as retrieval-boot does — bare brain_owner sees nothing under 0057.
      await owner.query("SET ROLE brain_system");
      const sweep = startEmbedSweep({
        ownerClient: owner,
        embedder: fakeEmbedder,
        intervalMs: 50,
        log: () => {},
      });
      try {
        const sourceVersion = async (): Promise<number | null> => {
          const r = await owner.query(
            `SELECT max(source_version)::int AS v FROM object_chunks WHERE object_id = $1`,
            [obj.id],
          );
          return r.rows[0]!.v as number | null;
        };
        await expect.poll(sourceVersion, { timeout: 10_000 }).toBe(1);
        await writer.edit(WCTX, obj.id, {
          bodyOps: [{ op: "append", text: " and dental floss" }],
        });
        // the sweep may have idled into backoff by now — give it room to wake
        await expect.poll(sourceVersion, { timeout: 10_000 }).toBe(2);
      } finally {
        sweep.stop();
        await owner.query("RESET ROLE");
      }
    });

    it("embeds PRIVATE objects too — via the brain_system sweep role (FORCE RLS, 0039)", async () => {
      // Production runs the sweep on a dedicated connection that SET ROLE's to
      // brain_system (retrieval-boot.ts), the one BYPASSRLS role, so private
      // objects are embedded (their vectors stay RLS-guarded in object_chunks).
      // A bare brain_owner client would NOT see them under FORCE — so drive the
      // sweep exactly as boot does, and prove the private object gets chunked.
      const secret = await writer.write(WCTX, {
        title: "Confidential dental audit",
        body: "dental billing irregularities",
        visibility: "private",
      });
      const sysClient = await brain.connect("owner");
      await sysClient.query("SET ROLE brain_system");
      const sweep = startEmbedSweep({
        ownerClient: sysClient,
        embedder: fakeEmbedder,
        intervalMs: 50,
        batchSize: 4,
        log: () => {},
      });
      try {
        await expect
          .poll(
            async () => {
              const r = await sysClient.query(
                "SELECT count(*)::int AS n FROM object_chunks WHERE object_id = $1",
                [secret.id],
              );
              return r.rows[0]!.n as number;
            },
            { timeout: 10_000 },
          )
          .toBeGreaterThanOrEqual(1);
      } finally {
        sweep.stop();
        await sysClient.end();
      }

      // And the creator can semantic-search their own private object…
      const reader = new Reader(pool, { embedQuery: (q) => Promise.resolve(vecFor(q)) });
      const mine = await reader.search(RCTX, "dental checkups");
      expect(mine.map((h) => h["id"])).toContain(secret.id);
      // …while a different member cannot (object_chunks RLS holds under FORCE).
      const stranger = await owner.query(
        `INSERT INTO accounts (name, role, token_hash) VALUES ('priv-stranger', 'member', 'y') RETURNING id`,
      );
      const theirs = await reader.search(
        { actorId: stranger.rows[0]!.id as string },
        "dental checkups",
      );
      expect(theirs.map((h) => h["id"])).not.toContain(secret.id);
    });
  });

  describe("semantic arm over chunks", () => {
    it("pools to the best chunk per object — a long doc appears once, with the matching passage", async () => {
      // Manually seed chunks so ranks are exact: one object with two chunks
      // (one close, one far), one distractor object.
      const doc = await writer.write(WCTX, { title: "Ops handbook", body: "operations" });
      const other = await writer.write(WCTX, { title: "Launch review", body: "vehicles" });
      // The real embed sweep writes object_chunks as brain_system (retrieval-
      // boot SET ROLE brain_system): a bare brain_owner connection holds no
      // tags under 0057 and cannot satisfy object_chunks' EXISTS-on-objects
      // WITH CHECK for any object. Mirror production here.
      await owner.query("SET ROLE brain_system");
      await owner.query(
        `INSERT INTO object_chunks (object_id, chunk_ix, text, embedding, source_version, chunker_version)
         VALUES ($1, 0, 'the dental hygiene chapter', $2::vector, 1, 1),
                ($1, 1, 'an unrelated appendix', $3::vector, 1, 1),
                ($4, 0, 'rocket downlink parsing', $5::vector, 1, 1)`,
        [doc.id, axisStr(3), axisStr(120), other.id, axisStr(700)],
      );
      await owner.query("RESET ROLE");
      const reader = new Reader(pool, { embedQuery: (q) => Promise.resolve(vecFor(q)) });
      const hits = await reader.search(RCTX, "dental checkups"); // no lexical overlap
      const ids = hits.map((h) => h["id"]);
      expect(ids).toContain(doc.id);
      expect(ids.filter((i) => i === doc.id)).toHaveLength(1);
      const hit = hits.find((h) => h["id"] === doc.id)!;
      expect(hit["snippet"]).toContain("dental hygiene"); // the passage, not the appendix
      expect(hit["match"]).toBe("semantic");
    });
  });

  describe("graph augmentation", () => {
    it("surfaces edge-connected objects with zero word overlap, annotated via", async () => {
      const person = await writer.write(WCTX, { title: "Zorble Quux", body: "our lead engineer" });
      const project = await writer.write(WCTX, {
        title: "Initiative Umbra",
        body: "warehouse retrofit effort",
      });
      const customer = await writer.write(WCTX, {
        title: "Veltrix Logistics",
        body: "pilot deployment site",
      });
      await writer.link(WCTX, person.id, "owns", project.id);
      await writer.link(WCTX, project.id, "customer_of", customer.id);

      const reader = new Reader(pool); // lexical only — graph still applies
      const hits = await reader.search(RCTX, "Zorble");
      const ids = hits.map((h) => h["id"]);
      expect(ids[0]).toBe(person.id);
      expect(ids).toContain(project.id); // hop 1
      expect(ids).toContain(customer.id); // hop 2
      const graphHit = hits.find((h) => h["id"] === project.id)!;
      expect(graphHit["match"]).toBe("graph");
      expect((graphHit["via"] as { seed: string }).seed).toBe("Zorble Quux");
      // graph hits rank BELOW the direct match
      expect(ids.indexOf(project.id)).toBeGreaterThan(ids.indexOf(person.id));
    });

    it("never leaks private objects through edges (RLS holds on the walk)", async () => {
      // the anchor must be org-visible to the stranger (wave-2 default is private)
      const seed = await writer.write(WCTX, {
        title: "Flumox gateway",
        body: "public anchor",
        visibility: "org",
      });
      const secret = await writer.write(WCTX, {
        title: "Hidden ledger",
        body: "private numbers",
        visibility: "private",
      });
      await writer.link(WCTX, seed.id, "about", secret.id);
      // a different actor: sees the seed, must NOT see the private neighbor
      const stranger = await owner.query(
        `INSERT INTO accounts (name, role, token_hash) VALUES ('stranger', 'member', 'x')
         RETURNING id`,
      );
      const strangerId = stranger.rows[0]!.id as string;
      const reader = new Reader(pool);
      const hits = await reader.search({ actorId: strangerId }, "Flumox");
      const ids = hits.map((h) => h["id"]);
      expect(ids).toContain(seed.id);
      expect(ids).not.toContain(secret.id);
    });
  });

  describe("rerank slot", () => {
    it("reorders the head by reranker scores", async () => {
      const a = await writer.write(WCTX, { title: "Gribble alpha", body: "gribble stuff one" });
      const b = await writer.write(WCTX, { title: "Gribble beta", body: "gribble stuff two" });
      const reader = new Reader(pool, {
        rerank: (_q, cands) =>
          Promise.resolve(cands.map((c) => ({ id: c.id, score: c.id === b.id ? 10 : 1 }))),
      });
      const hits = await reader.search(RCTX, "gribble");
      const ids = hits.map((h) => h["id"]);
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
      void a;
    });

    it("a failing reranker keeps the fused order (never breaks search)", async () => {
      const reader = new Reader(pool, {
        rerank: () => Promise.reject(new Error("model exploded")),
      });
      const hits = await reader.search(RCTX, "gribble");
      expect(hits.length).toBeGreaterThan(0);
    });

    it("rerank:false skips the cross-encoder entirely (as-you-type pass)", async () => {
      let calls = 0;
      const reader = new Reader(pool, {
        rerank: (_q, cands) => {
          calls += 1;
          return Promise.resolve(cands.map((c) => ({ id: c.id, score: 1 })));
        },
      });
      const hits = await reader.search(RCTX, "gribble", { rerank: false });
      expect(hits.length).toBeGreaterThan(0);
      expect(calls).toBe(0);
    });
  });

  describe("combined multi-query search", () => {
    it("fuses paraphrases into one deduplicated list, corroborated hits first", async () => {
      const doc = await writer.write(WCTX, {
        title: "Quibble stewardship handbook",
        body: "quibble ownership and zibber routing live here",
      });
      const other = await writer.write(WCTX, { title: "Zibber appendix", body: "zibber only" });
      const reader = new Reader(pool);
      // doc matches BOTH phrasings, other matches one — doc must rank first,
      // and neither may appear twice.
      const hits = await reader.searchCombined(RCTX, ["quibble ownership", "zibber"]);
      const ids = hits.map((h) => h["id"]);
      expect(ids[0]).toBe(doc.id);
      expect(ids).toContain(other.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("refuses an empty queries array", async () => {
      const reader = new Reader(pool);
      await expect(reader.searchCombined(RCTX, [])).rejects.toMatchObject({
        code: "validation",
      });
    });
  });

  describe("type diversity", () => {
    it("one type cannot monopolize the page when other types matched", async () => {
      const owner2 = await brain.connect("owner");
      try {
        const { SchemaExecutor } = await import("@brain/schema");
        const exec = new SchemaExecutor(owner2);
        await exec.defineType({ name: "meeting" }, SYSTEM);
      } finally {
        await owner2.end();
      }
      for (let i = 0; i < 8; i++) {
        await writer.write(WCTX, {
          type: "meeting",
          title: `Sprintish sync ${i}`,
          body: "the flargle cadence review",
        });
      }
      const person = await writer.write(WCTX, {
        title: "Flargle Owner",
        body: "runs the flargle cadence",
      });
      const reader = new Reader(pool);
      const hits = await reader.search(RCTX, "flargle", { limit: 5 });
      expect(hits).toHaveLength(5);
      expect(hits.map((h) => h["id"])).toContain(person.id);
    });
  });
});
