import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Reader,
  Writer,
  Admin,
  FsStore,
  callTool,
  type ToolDeps,
  type AuthedContext,
} from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * recent and history must show WHO did something by NAME, not just an opaque
 * actor id — an agent reading the feed should see "Ada Lovelace", not a uuid.
 * The raw id stays too (it's the join key), but a human name rides alongside.
 */
describe("recent / history resolve actor ids to names", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let deps: ToolDeps;
  let ctx: AuthedContext;
  let actorName: string;

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
    actorName = "Ada Lovelace";
    const boot = await deps.admin.bootstrapOwner({ name: actorName, email: "ada@example.com" });
    ctx = { actorId: boot.id, scopes: ["read", "write", "schema-admin"], role: "owner" };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  it("recent carries actor_name alongside the raw actor id", async () => {
    await callTool(deps, ctx, "write", { title: "first note", body: "hello" });
    await (deps.writer as Writer).flushAudit();
    const res = (await callTool(deps, ctx, "recent", { limit: 20 })) as {
      events: Array<Record<string, unknown>>;
    };
    expect(res.events.length).toBeGreaterThan(0);
    const create = res.events.find((e) => e.kind === "create")!;
    expect(create.actor).toBe(ctx.actorId); // raw id still present (the join key)
    expect(create.actor_name).toBe(actorName); // ...and now the human name
  });

  it("history carries names on both revisions (by_name) and events (actor_name)", async () => {
    const obj = (await callTool(deps, ctx, "write", {
      title: "draft",
      body: "v1",
    })) as { id: string };
    await callTool(deps, ctx, "edit", {
      id: obj.id,
      title: "draft (renamed)",
      version: 1,
    });
    const hist = (await callTool(deps, ctx, "history", { id: obj.id })) as {
      versions: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
    };
    // the title edit snapshots the prior spine → a before_image revision
    const rev = hist.versions[0]!;
    expect(rev.by).toBe(ctx.actorId);
    expect(rev.by_name).toBe(actorName);
    // and the lifecycle events name their actor too
    const ev = hist.events.find((e) => e.kind === "create" || e.kind === "update")!;
    expect(ev.actor).toBe(ctx.actorId);
    expect(ev.actor_name).toBe(actorName);
  });
});
