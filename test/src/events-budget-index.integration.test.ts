import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Migration 0040: a PARTIAL composite index
 * `events_actor_budget ON events (actor, at) WHERE kind NOT LIKE 'call:%'`
 * serving the per-token write-budget query (write-path.ts). Built via
 * concurrent[] / CREATE INDEX CONCURRENTLY — the first production use of that
 * runner path — so this test also proves the concurrent steps ran and the index
 * came out VALID over createFreshBrain's real runMigrations.
 */
describe("events write-budget partial index (0040)", () => {
  let brain: FreshBrain;

  beforeAll(async () => {
    brain = await createFreshBrain();
  }, 120_000);

  afterAll(async () => {
    await brain?.drop();
  });

  it("built events_actor_budget as a VALID index via concurrent[]", async () => {
    const owner = await brain.connect("owner");
    try {
      const r = await owner.query<{ indisvalid: boolean; indisready: boolean }>(
        `SELECT i.indisvalid, i.indisready
           FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = 'events_actor_budget'`,
      );
      expect(r.rowCount, "the index exists").toBe(1);
      expect(r.rows[0]!.indisvalid, "CIC completed → index is valid").toBe(true);
      expect(r.rows[0]!.indisready).toBe(true);
    } finally {
      await owner.end();
    }
  });

  it("keeps events_actor (0001) — it is the ONLY index for call:* actor queries", async () => {
    const owner = await brain.connect("owner");
    try {
      const r = await owner.query(
        "SELECT 1 FROM pg_class WHERE relname = 'events_actor' AND relkind = 'i'",
      );
      expect(r.rowCount).toBe(1);
    } finally {
      await owner.end();
    }
  });

  it("the budget query uses the partial index (predicate implication holds)", async () => {
    const owner = await brain.connect("owner");
    try {
      // enable_seqscan=off forces the planner to reach for an index; it can only
      // pick events_actor_budget if the query's `kind NOT LIKE 'call:%'` implies
      // the index's identical partial predicate.
      await owner.query("SET enable_seqscan = off");
      const plan = await owner.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT count(*)::int AS n FROM events
          WHERE actor = '00000000-0000-0000-0000-000000000000'
            AND at > now() - make_interval(secs => 3600)
            AND kind NOT LIKE 'call:%'`,
      );
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text, `plan should reference the partial index:\n${text}`).toContain(
        "events_actor_budget",
      );
    } finally {
      await owner.end();
    }
  });
});
