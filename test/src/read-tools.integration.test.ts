import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
const RCTX: ReadContext = { actorId: SYSTEM };

describe("read tools + query AST", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let reader: Reader;
  let writer: Writer;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    reader = new Reader(pool);
    writer = new Writer(pool);

    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "task" }, SYSTEM);
    await exec.addProperty(
      { typeId: t.typeId, name: "status", kind: "enum", enumValues: ["open", "done"] },
      SYSTEM,
    );
    await exec.addProperty({ typeId: t.typeId, name: "priority", kind: "int" }, SYSTEM);
    await owner.end();

    for (let i = 0; i < 25; i++) {
      await writer.write(WCTX, {
        type: "task",
        title: `task ${i}`,
        body: `body of task number ${i} widget`,
        props: { status: i % 2 === 0 ? "open" : "done", priority: i },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("get() returns body, props, links, backlinks", async () => {
    const list = await reader.list(RCTX, "task", { limit: 1 });
    const id = list.items[0]!.id as string;
    const g = await reader.get(RCTX, id);
    expect(g.type).toBe("task");
    expect(g.props).toHaveProperty("status");
    expect(g.props).toHaveProperty("priority");
    expect(Array.isArray(g.links)).toBe(true);
  });

  it("list() filters via the whitelisted AST", async () => {
    const open = await reader.list(RCTX, "task", {
      where: { field: "status", op: "eq", value: "open" },
      limit: 200,
    });
    expect(open.items.length).toBe(13); // 0,2,...,24
    const highPri = await reader.count(RCTX, "task", {
      where: { field: "priority", op: "gte", value: 20 },
    });
    expect(highPri).toBe(5); // 20..24
  });

  it("rejects an unknown field in the AST (no injection)", async () => {
    await expect(
      reader.list(RCTX, "task", {
        where: { field: "status; DROP TABLE objects; --", op: "eq", value: "x" },
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      reader.list(RCTX, "task", { where: { field: "nonexistent", op: "eq", value: 1 } }),
    ).rejects.toMatchObject({ code: "validation" });
    // objects table is very much still there
    const still = await reader.count(RCTX, "task", {});
    expect(still).toBe(25);
  });

  it("keyset pagination is stable and complete", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await reader.list(RCTX, "task", {
        sort: { field: "priority", dir: "asc" },
        limit: 10,
        ...(cursor ? { cursor } : {}),
      });
      for (const it of page.items) seen.add(it.id as string);
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10); // guard against a cursor loop
    } while (cursor);
    expect(seen.size).toBe(25); // every row, exactly once
  });

  it("search() spans title/body", async () => {
    const hits = await reader.search(RCTX, "widget", { limit: 200 });
    expect(hits.length).toBe(25);
    const one = await reader.search(RCTX, "task 7 number", {});
    expect(one.length).toBeGreaterThan(0);
  });

  it("describe_type / list_types / list_rels / whoami / members", async () => {
    const types = await reader.listTypes(RCTX);
    expect(types.map((t) => t.name)).toContain("task");
    const desc = await reader.describeType(RCTX, "task");
    const props = desc.properties as Array<{ name: string; enum_values: string[] }>;
    const status = props.find((p) => p.name === "status");
    expect(status?.enum_values.sort()).toEqual(["done", "open"]);
    const me = await reader.whoami(RCTX);
    expect(me.id).toBe(SYSTEM);
    const members = await reader.members(RCTX);
    expect(Array.isArray(members)).toBe(true);
  });

  it("recent() paginates by seq, and list_deleted surfaces tombstones", async () => {
    const r1 = await reader.recent(RCTX, { limit: 5 });
    expect(r1.events.length).toBe(5);
    expect(r1.nextSeq).not.toBeNull();
    const r2 = await reader.recent(RCTX, { limit: 5, sinceSeq: r1.nextSeq! });
    expect((r2.events[0] as { seq: string }).seq).not.toBe((r1.events[0] as { seq: string }).seq);

    const victim = (await reader.list(RCTX, "task", { limit: 1 })).items[0]!.id as string;
    await writer.softDelete(WCTX, victim);
    const deleted = await reader.listDeleted(RCTX, { type: "task" });
    expect(deleted.some((d) => d.id === victim)).toBe(true);
  });
});
