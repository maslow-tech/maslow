import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
const RCTX: ReadContext = { actorId: SYSTEM };

type PropEvent = {
  kind: string;
  payload: { changed?: Record<string, { old: unknown; new: unknown }>; private?: boolean };
};

describe("0013 · prop-level history", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let reader: Reader;
  let writer: Writer;
  let id: string;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    reader = new Reader(pool);
    writer = new Writer(pool);
    owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "gadget" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "price", kind: "int" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "sku", kind: "text" }, SYSTEM);
    const w = await writer.write(WCTX, {
      type: "gadget",
      title: "widget",
      props: { price: 100, sku: "A-1" },
      // explicit org publish — writes now default to private, which would
      // redact the update_props values the first test asserts on
      visibility: "org",
    });
    id = w.id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  it("a prop edit records old and new values as an update_props event", async () => {
    const cur = (await reader.get(RCTX, id)) as { version: number };
    await writer.edit(WCTX, id, { version: cur.version, props: { price: 250 } });
    const h = (await reader.history(RCTX, id)) as { events: PropEvent[] };
    const ev = h.events.find((e) => e.kind === "update_props");
    expect(ev).toBeDefined();
    expect(ev!.payload.changed!.price).toEqual({ old: 100, new: 250 });
    // untouched prop is NOT in the diff
    expect(ev!.payload.changed!.sku).toBeUndefined();
  });

  it("a body-only edit emits no update_props event (tsv refresh is excluded)", async () => {
    const cur = (await reader.get(RCTX, id)) as { version: number };
    await writer.edit(WCTX, id, {
      version: cur.version,
      bodyOps: [{ op: "set", text: "new body" }],
    });
    const h = (await reader.history(RCTX, id)) as { events: PropEvent[] };
    const propEvents = h.events.filter((e) => e.kind === "update_props");
    expect(propEvents).toHaveLength(1); // still just the one from the prior test
  });

  it("a private object's prop edit records {private:true}, not values", async () => {
    const w = await writer.write(WCTX, {
      type: "gadget",
      title: "secret widget",
      props: { price: 7 },
      visibility: "private",
    });
    const cur = (await reader.get(RCTX, w.id)) as { version: number };
    await writer.edit(WCTX, w.id, { version: cur.version, props: { price: 9 } });
    const h = (await reader.history(RCTX, w.id)) as { events: PropEvent[] };
    const ev = h.events.find((e) => e.kind === "update_props");
    expect(ev).toBeDefined();
    expect(ev!.payload).toEqual({ private: true });
  });
});
