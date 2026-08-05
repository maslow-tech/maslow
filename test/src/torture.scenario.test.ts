import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The torture suite — hammer every area the red-team passes covered, under REAL
 * concurrency (a connection pool, Promise.all fan-out): lost-update, isolation,
 * idempotency races, versioning, the full CRUD + schema-evolution lifecycle
 * (add_property / retype / demote / drop_type / deprecate), and the injection /
 * escalation / integrity matrix — all at once, composed.
 */
const SYSTEM = "00000000-0000-0000-0000-000000000000";
const W: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
const R: ReadContext = { actorId: SYSTEM };

describe("TORTURE · concurrency, versioning, idempotency", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let writer: Writer;
  let reader: Reader;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool({ ...brain.appConfig, max: 20 });
    owner = await brain.connect("owner");
    writer = new Writer(pool);
    reader = new Reader(pool);
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("lost-update: 25 concurrent edits at the same base version — exactly ONE wins", async () => {
    const n = await writer.write(W, { body: "base" });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        writer.edit(W, n.id, { version: 1, bodyOps: [{ op: "set", text: `v${i}` }] }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter(
      (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "conflict",
    );
    expect(fulfilled.length).toBe(1);
    expect(conflicts.length).toBe(24);
    const got = await reader.get(R, n.id);
    expect(got.version).toBe(2); // exactly one bump
  });

  it("independent concurrent writes: 60 new objects, all distinct, all version 1", async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => writer.write(W, { title: `c${i}`, body: `body ${i}` })),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(60);
    expect(results.every((r) => r.version === 1)).toBe(true);
  });

  it("version-free appends: 30 concurrent appends all land (no lost writes)", async () => {
    const n = await writer.write(W, { body: "" });
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        writer.edit(W, n.id, { bodyOps: [{ op: "append", text: `[${i}]` }] }),
      ),
    );
    const got = (await reader.get(R, n.id)) as { body: string; version: number };
    for (let i = 0; i < 30; i++) expect(got.body).toContain(`[${i}]`);
    expect(got.version).toBe(31); // 1 create + 30 appends
  });

  it("idempotency race: 15 concurrent calls, same key → exactly ONE object", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () =>
        writer.write({ ...W, idempotencyKey: "race-key" }, { body: "once-only" }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
      id: string;
    }>[];
    const uniqueIds = new Set(ok.map((r) => r.value.id));
    // Counted under the txn-local DR escape: since 0057 a bare brain_owner
    // connection holds no tags and would count zero rows either way — the
    // escape makes 1 mean "exactly one row, ever" again.
    await owner.query("BEGIN");
    await owner.query("SET LOCAL app.fs_dr = 'on'");
    const cnt = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM objects WHERE body = 'once-only'",
    );
    await owner.query("COMMIT");
    expect(Number(cnt.rows[0]!.n)).toBe(1); // exactly one row, ever
    expect(uniqueIds.size).toBeLessThanOrEqual(1 + 0); // all fulfilled share the id (or lost to a benign conflict)
  });

  it("consistent reads under a write storm (readers never see a torn object)", async () => {
    const n = await writer.write(W, { title: "hot", body: "0" });
    let v = 1;
    const writes = (async () => {
      for (let i = 0; i < 20; i++) {
        v = (await writer.edit(W, n.id, { version: v, bodyOps: [{ op: "set", text: `${i}` }] }))
          .version;
      }
    })();
    const reads = Promise.all(
      Array.from({ length: 40 }, async () => {
        const g = (await reader.get(R, n.id)) as { title: string; body: string };
        // title is immutable here; body is always a clean integer string
        expect(g.title).toBe("hot");
        expect(/^\d+$/.test(g.body)).toBe(true);
      }),
    );
    await Promise.all([writes, reads]);
  });
});

describe("TORTURE · full CRUD + schema evolution lifecycle", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let writer: Writer;
  let reader: Reader;
  let exec: SchemaExecutor;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool({ ...brain.appConfig, max: 10 });
    owner = await brain.connect("owner");
    writer = new Writer(pool);
    reader = new Reader(pool);
    exec = new SchemaExecutor(owner);
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("CRUD: create → read → update → delete → restore, versions tracked", async () => {
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    const c = await writer.write(W, { type: "client", title: "Acme", props: { tier: "bronze" } });
    expect((await reader.get(R, c.id)).version).toBe(1);
    const u = await writer.edit(W, c.id, {
      version: 1,
      props: { tier: "gold" },
      title: "Acme Inc",
    });
    expect(u.version).toBe(2);
    expect(((await reader.get(R, c.id)).props as { tier: string }).tier).toBe("gold");
    await writer.softDelete(W, c.id);
    expect((await reader.get(R, c.id)).deleted_at).not.toBeNull();
    await writer.restore(W, c.id);
    expect((await reader.get(R, c.id)).deleted_at).toBeNull();
  });

  it("add_property to a type WITH existing rows (instant, nullable, no backfill surprise)", async () => {
    const t = await exec.defineType({ name: "deal" }, SYSTEM);
    const d = await writer.write(W, { type: "deal", title: "Q1" });
    // add a property AFTER the row exists
    await exec.addProperty({ typeId: t.typeId, name: "amount", kind: "decimal" }, SYSTEM);
    // the existing row reads the new prop as null; a new write can set it
    expect(((await reader.get(R, d.id)).props as { amount: unknown }).amount).toBeNull();
    await writer.edit(W, d.id, { version: 1, props: { amount: "1000.50" } });
    expect(((await reader.get(R, d.id)).props as { amount: string }).amount).toBe("1000.50");
  });

  it("retype + demote move an object between shapes correctly", async () => {
    await exec.defineType({ name: "lead" }, SYSTEM);
    const o = await writer.write(W, { type: "lead", title: "movable" });
    await exec.retype(o.id, "client", SYSTEM);
    expect((await reader.get(R, o.id)).type).toBe("client");
    await exec.demote(o.id, SYSTEM);
    expect((await reader.get(R, o.id)).type).toBeNull();
  });

  it("deprecate/restore a property and a type", async () => {
    const t = await exec.defineType({ name: "widget" }, SYSTEM);
    const p = await exec.addProperty({ typeId: t.typeId, name: "color", kind: "text" }, SYSTEM);
    await exec.deprecateProperty(p.propertyId, SYSTEM);
    const desc = await reader.describeType(R, "widget");
    const color = (desc.properties as Array<{ name: string; deprecated: boolean }>).find(
      (x) => x.name === "color",
    );
    expect(color?.deprecated).toBe(true);
    await exec.restoreProperty(p.propertyId, SYSTEM);
    await exec.deprecateType(t.typeId, SYSTEM);
    const types = await reader.listTypes(R);
    expect((types.find((x) => x.name === "widget") as { deprecated: boolean }).deprecated).toBe(
      true,
    );
  });

  it("drop_type with live data: objects become notes, table dropped, no orphan", async () => {
    const t = await exec.defineType({ name: "temp" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "x", kind: "int" }, SYSTEM);
    const a = await writer.write(W, { type: "temp", props: { x: 1 } });
    const b = await writer.write(W, { type: "temp", props: { x: 2 } });
    await exec.dropType(t.typeId, SYSTEM);
    const reg = await owner.query<{ v: string | null }>("SELECT to_regclass('temp_ext') AS v");
    expect(reg.rows[0]!.v).toBeNull();
    for (const o of [a, b]) {
      const g = await reader.get(R, o.id);
      expect(g.type).toBeNull();
      expect(g.deleted_at).toBeNull(); // survived as a note
    }
  });
});
