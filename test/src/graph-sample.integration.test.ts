import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reader, Writer, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Regression: graphSample's limit was hardcoded to Math.min(..., 80) while
 * the box dashboard's GraphView "load more" button already stepped sampleLimit
 * up to MAX_SAMPLE=320 in steps of 80 — every click past the first silently
 * re-requested (and got back) the same top-80 nodes, so "load more" did
 * nothing visible past the initial page.
 */
describe("graphSample's node cap matches the UI's MAX_SAMPLE (320), not the old 80", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let reader: Reader;
  const ctx: WriteContext = {
    actorId: "00000000-0000-0000-0000-000000000000",
    scopes: ["read", "write"],
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    reader = new Reader(pool);
    const writer = new Writer(pool);
    // 90 plain objects — more than the old 80 cap, comfortably under 320.
    for (let i = 0; i < 90; i++) {
      await writer.write(ctx, { title: `graph-sample node ${i}` });
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("a limit above the old 80 cap (but under 320) returns that many nodes", async () => {
    const sample = await reader.graphSample({ actorId: ctx.actorId }, { limit: 90 });
    expect(sample.nodes.length).toBe(90);
  });

  it("a limit above 320 still clamps at 320", async () => {
    const sample = await reader.graphSample({ actorId: ctx.actorId }, { limit: 10_000 });
    expect(sample.nodes.length).toBeLessThanOrEqual(320);
  });

  it("the default (no limit) is unaffected", async () => {
    const sample = await reader.graphSample({ actorId: ctx.actorId });
    expect(sample.nodes.length).toBe(24);
  });
});
