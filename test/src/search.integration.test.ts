import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
const RCTX: ReadContext = { actorId: SYSTEM };

describe("full-text search spans notes AND typed fields", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let reader: Reader;
  let writer: Writer;
  let clientId: string;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    reader = new Reader(pool);
    writer = new Writer(pool);
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "industry", kind: "text" }, SYSTEM);
    await exec.addProperty(
      { typeId: t.typeId, name: "status", kind: "enum", enumValues: ["active", "churned"] },
      SYSTEM,
    );
    await owner.end();

    const c = await writer.write(WCTX, {
      type: "client",
      title: "Acme Corp",
      body: "a plain note body",
      props: { industry: "aerospace manufacturing", status: "active" },
    });
    clientId = c.id;
    await writer.write(WCTX, { title: "untyped", body: "a findable widget note" });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("finds a typed object by a TYPED FIELD value (not in title/body)", async () => {
    const hits = await reader.search(RCTX, "aerospace", { type: "client" });
    expect(hits.map((h) => h.id)).toContain(clientId);
  });

  it("finds a typed object by title too", async () => {
    const hits = await reader.search(RCTX, "Acme", { type: "client" });
    expect(hits.map((h) => h.id)).toContain(clientId);
  });

  it("unscoped search spans notes (title/body across everything)", async () => {
    const hits = await reader.search(RCTX, "widget", {});
    expect(hits.length).toBe(1);
  });

  it("finds a typed-field value by DEFAULT (unscoped) search", async () => {
    // 'aerospace' lives only in the client's industry ext field, not its
    // title/body — before w7 this was invisible to an unscoped search.
    const hits = await reader.search(RCTX, "aerospace", {});
    expect(hits.map((h) => h.id)).toContain(clientId);
  });

  it("unscoped search honors soft-delete on the union path (the load-bearing objects join)", async () => {
    await writer.softDelete(WCTX, clientId);
    const gone = await reader.search(RCTX, "aerospace", {});
    expect(gone.map((h) => h.id)).not.toContain(clientId);
    await writer.restore(WCTX, clientId);
    const back = await reader.search(RCTX, "aerospace", {});
    expect(back.map((h) => h.id)).toContain(clientId);
  });

  it("excludes soft-deleted objects", async () => {
    await writer.softDelete(WCTX, clientId);
    const hits = await reader.search(RCTX, "aerospace", { type: "client" });
    expect(hits.map((h) => h.id)).not.toContain(clientId);
    await writer.restore(WCTX, clientId);
  });

  it("has a GIN index on the ext search vector", async () => {
    const owner = await brain.connect("owner");
    try {
      const r = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_indexes
         WHERE tablename = 'client_ext' AND indexdef ILIKE '%gin%tsv%'`,
      );
      expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(1);
    } finally {
      await owner.end();
    }
  });

  // MUST BE LAST — irreversibly drops client_ext.tsv on the shared brain.
  it("never throws when an ext table's tsv column has drifted away (doctrine)", async () => {
    const owner = await brain.connect("owner");
    try {
      await owner.query("ALTER TABLE client_ext DROP COLUMN tsv");
    } finally {
      await owner.end();
    }
    // A FRESH reader re-enumerates (30s TTL) and must skip the now-drifted ext
    // table rather than emit a union arm over a missing column (which would 500).
    const fresh = new Reader(pool);
    const hits = await fresh.search(RCTX, "Acme", {});
    expect(hits.map((h) => h.id)).toContain(clientId); // title/body arm still resolves
  });
});

describe("0018 · weighted ranking — the entity outranks its mentioners", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let reader: Reader;
  let writer: Writer;
  let entityId: string;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    reader = new Reader(pool);
    writer = new Writer(pool);

    // The reported pollution: one entity NAMED Zenith, many ledger-ish notes
    // that merely MENTION Zenith in their bodies (written after, so recency
    // favors the noise).
    entityId = (await writer.write(WCTX, { title: "Zenith", body: "our biggest client account" }))
      .id;
    for (let i = 0; i < 12; i++) {
      await writer.write(WCTX, {
        title: `timesheet week ${i}`,
        body: `logged 6 hours on the Zenith account, invoiced Zenith for review cycle ${i}`,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("a title match (weight A) beats body mentions (weight C): entity is hit #1", async () => {
    const hits = await reader.search(RCTX, "Zenith", { limit: 10 });
    expect(hits.length).toBeGreaterThan(1); // the mentioners still show up...
    expect(hits[0]!.id).toBe(entityId); // ...but the entity leads
  });

  it("a typed-field match (weight B) beats a body mention (weight C) in type-scoped search", async () => {
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    try {
      const t = await exec.defineType({ name: "vendor" }, SYSTEM);
      await exec.addProperty({ typeId: t.typeId, name: "specialty", kind: "text" }, SYSTEM);
      const specialist = await writer.write(WCTX, {
        type: "vendor",
        title: "Kite Systems",
        props: { specialty: "quantflux calibration" },
      });
      // ts_rank_cd SUMS occurrences (2×C = 1×B), so a doc that repeats the
      // term enough can still climb past a higher-weighted single hit —
      // single mention here; the weights fix ordering, not term-stuffing.
      await writer.write(WCTX, {
        type: "vendor",
        title: "Bolt Works",
        body: "they once asked about quantflux drift, not their field",
      });
      const hits = await reader.search(RCTX, "quantflux", { type: "vendor" });
      expect(hits[0]!.id).toBe(specialist.id);
    } finally {
      await owner.end();
    }
  });

  /**
   * TERM-STUFFING — the ceiling the block above documents but could not close:
   * "ts_rank_cd SUMS occurrences … the weights fix ordering, not term-stuffing".
   *
   * Reported live 2026-07-26: searching a person's full name ranked a document
   * that mentioned her six times ABOVE her own profile (measured 1.5908 vs
   * 1.5000), so typing the whole name did WORSE than typing half of it. No
   * multiplier can fix that — content scores are unbounded above — so the title
   * became a TIER that is compared before the score.
   */
  it("a term-stuffed mentioner cannot outrank the thing that IS the title", async () => {
    await writer.write(WCTX, {
      title: "weekly ledger — accounts review",
      body: "Zenith was invoiced. Zenith replied. Zenith escalated. Chased Zenith again. Zenith signed. Zenith closed the cycle.",
    });
    const hits = await reader.search(RCTX, "Zenith", { limit: 10 });
    expect(hits[0]!.id).toBe(entityId);
  });

  it("holds for a MULTI-WORD title — the case that was actually reported", async () => {
    const person = await writer.write(WCTX, {
      title: "Meena Rao",
      body: "CTO. Signatory on the agreement.",
    });
    await writer.write(WCTX, {
      title: "agreement — signature chase",
      body: "Meena Rao was sent it. Meena Rao replied. Meena Rao asked for a delay. Waiting on Meena Rao. Meena Rao signs. Follow up with Meena Rao.",
    });
    const hits = await reader.search(RCTX, "Meena Rao", { limit: 10 });
    expect(hits[0]!.id).toBe(person.id);
  });

  it("the advantage exists WHILE TYPING, not only on the last keystroke", async () => {
    // Mid-word, full-text matches nothing and the fuzzy TITLE pass is the only
    // arm — so what decides the answer is the order fuzzy returns candidates
    // in. That order used to be `updated_at DESC`, which is not a ranking of
    // anything: this longer title, written LAST, came back first, and with a
    // small LIMIT the real answer could miss the page entirely.
    await writer.write(WCTX, {
      title: "Zenith rollout retrospective — quarterly notes",
      body: "post-mortem",
    });
    const hits = await reader.search(RCTX, "Zenit", { limit: 10 });
    expect(hits[0]!.id).toBe(entityId);
  });

  /**
   * The tier is applied LAST because everything after it re-sorts. The
   * cross-encoder reorders its whole window by its own score and knows nothing
   * about titles — so a tier applied before it is simply undone. A dev box with
   * no reranker model cannot catch that (the stage silently disables itself),
   * which is how it nearly shipped; this stub is the box that HAS one.
   */
  it("survives the reranker, which re-sorts by its own score", async () => {
    const reversing = new Reader(pool, {
      // Score by REVERSE arrival: the most hostile reranker possible, and a
      // faithful stand-in for "the model disagrees with us".
      rerank: async (_q, docs) => docs.map((d, i) => ({ id: d.id, score: i })),
    });
    const hits = await reversing.search(RCTX, "Zenith", { limit: 10 });
    expect(hits[0]!.id).toBe(entityId);
  });

  it("leaves a conceptual query alone — no title matches, no reordering", async () => {
    // The guard that keeps this safe for AGENTS: an MCP caller asking a
    // question rather than naming a thing must get the arms' own ranking back,
    // untouched. Matching no title means the tier pass returns the list as-is.
    const hits = await reader.search(RCTX, "invoiced review cycle", { limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    // No title contains that phrase, so the tier pass must not fire at all —
    // the content winner keeps the top slot and the ENTITY does not hijack it
    // just for sharing a word with the query.
    expect(hits[0]!.id).not.toBe(entityId);
    expect(String(hits[0]!["title"])).toMatch(/timesheet|ledger/);
  });

  it("objects.tsv carries weights (A title, C body)", async () => {
    const owner = await brain.connect("owner");
    try {
      // Since 0057 a bare brain_owner connection holds no tags and sees no
      // objects rows; this is a schema verification read, so use the DR escape
      // (txn-local, exactly as the export path does).
      await owner.query("BEGIN READ ONLY");
      await owner.query("SET LOCAL app.fs_dr = 'on'");
      const r = await owner.query<{ tsv: string }>(
        "SELECT tsv::text AS tsv FROM objects WHERE id = $1",
        [entityId],
      );
      await owner.query("COMMIT");
      expect(r.rows[0]!.tsv).toContain("'zenith':1A");
      expect(r.rows[0]!.tsv).toMatch(/C/); // body lexemes stamped C
    } finally {
      await owner.end();
    }
  });
});
