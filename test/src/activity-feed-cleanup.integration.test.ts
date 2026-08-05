import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Reader,
  Writer,
  Admin,
  callTool,
  type ToolDeps,
  type AuthedContext,
  FsStore,
} from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";

/**
 * Activity-feed cleanup (live data: 66% of the maslow box's events table was
 * call:* audit rows, 27 of the last 50 feed entries):
 *
 *  - recent defaults to CONTENT events; the call:* audit stream is opt-in
 *    via kinds:'all'. Agents don't pass optional params — the default is the
 *    behavior.
 *  - call:* audit rows are kept FOREVER (owner decision) — events is
 *    append-only, no retention prune.
 */
describe("activity feed cleanup — quiet default, call-log retention", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let deps: ToolDeps;
  let ctx: AuthedContext;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    owner = await brain.connect("owner");
    deps = {
      reader: new Reader(pool),
      writer: new Writer(pool),
      admin: new Admin(pool),
      executor: new SchemaExecutor(owner),
      fsStore: new FsStore(pool),
    };
    await deps.admin.bootstrapOwner({ name: "alice", email: "a@example.com" });
    ctx = { actorId: SYSTEM, scopes: ["read", "write", "schema-admin"], role: "owner" };
    await callTool(deps, ctx, "write", { title: "a note", body: "hello" });
    await (deps.writer as Writer).flushAudit(); // settle call:* audit rows
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  it("recent hides call:* rows by default; kinds:'all' opts back in", async () => {
    const quiet = (await callTool(deps, ctx, "recent", {})) as {
      events: Array<{ kind: string }>;
    };
    expect(quiet.events.length).toBeGreaterThan(0);
    expect(quiet.events.every((e) => !e.kind.startsWith("call:"))).toBe(true);

    const loud = (await callTool(deps, ctx, "recent", { kinds: "all" })) as {
      events: Array<{ kind: string }>;
    };
    expect(loud.events.some((e) => e.kind.startsWith("call:"))).toBe(true);
  });

  it("keeps call:* audit rows forever — no retention prune, however old", async () => {
    // Backdate a call:* row far past the old 30-day cap; it must still survive.
    await owner.query(
      `UPDATE events SET at = now() - interval '400 days'
       WHERE seq = (SELECT seq FROM events WHERE kind LIKE 'call:%' ORDER BY seq LIMIT 1)`,
    );
    const old = await owner.query(
      "SELECT count(*)::int AS n FROM events WHERE kind LIKE 'call:%' AND at < now() - interval '30 days'",
    );
    expect(old.rows[0].n).toBeGreaterThan(0); // audit rows are permanent now
  });
});
