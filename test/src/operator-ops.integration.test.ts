import { Pool, type Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
const RCTX: ReadContext = { actorId: SYSTEM };

describe("operator schema ops", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let exec: SchemaExecutor;
  let writer: Writer;
  let reader: Reader;

  beforeEach(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    owner = await brain.connect("owner");
    exec = new SchemaExecutor(owner);
    writer = new Writer(pool);
    reader = new Reader(pool);
  }, 120_000);

  afterEach(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  async function regclass(name: string): Promise<string | null> {
    const r = await owner.query<{ v: string | null }>("SELECT to_regclass($1) AS v", [name]);
    return r.rows[0]!.v;
  }

  /** Verification read on the owner client. Since 0057 a bare brain_owner sees
   *  no objects/ext rows (audience RLS); the txn-local DR escape is the
   *  sanctioned way for brain_owner to read everything. */
  async function withDr<T>(fn: () => Promise<T>): Promise<T> {
    await owner.query("BEGIN");
    try {
      await owner.query("SET LOCAL app.fs_dr = 'on'");
      const r = await fn();
      await owner.query("COMMIT");
      return r;
    } catch (e) {
      await owner.query("ROLLBACK");
      throw e;
    }
  }

  it("rename is cheap (surrogate id): objects keep their type_id", async () => {
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    const o = await writer.write(WCTX, { type: "client", title: "Acme" });
    await exec.renameType(t.typeId, "account", SYSTEM);
    const types = await reader.listTypes(RCTX);
    expect(types.map((x) => x.name)).toContain("account");
    expect(types.map((x) => x.name)).not.toContain("client");
    // the object still resolves to the (renamed) type — no data rewrite
    const got = await reader.get(RCTX, o.id);
    expect(got.type).toBe("account");
  });

  it("demote turns a typed object back into a note (ext row dropped)", async () => {
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    const o = await writer.write(WCTX, { type: "client", props: { tier: "gold" } });
    await exec.demote(o.id, SYSTEM);
    const got = await reader.get(RCTX, o.id);
    expect(got.type).toBeNull();
    // under DR (which sees every row) so 0 proves the row is truly gone,
    // not merely hidden from a bare owner connection by the audience RLS.
    const ext = await withDr(() => owner.query("SELECT 1 FROM client_ext WHERE id = $1", [o.id]));
    expect(ext.rowCount).toBe(0);
  });

  it("retype moves an object between types", async () => {
    const a = await exec.defineType({ name: "lead" }, SYSTEM);
    void a;
    await exec.defineType({ name: "client" }, SYSTEM);
    const o = await writer.write(WCTX, { type: "lead", title: "Acme" });
    await exec.retype(o.id, "client", SYSTEM);
    const got = await reader.get(RCTX, o.id);
    expect(got.type).toBe("client");
    // read through the DR escape so a 0-count means "row truly gone", not RLS
    const leadExt = await withDr(() => owner.query("SELECT 1 FROM lead_ext WHERE id = $1", [o.id]));
    expect(leadExt.rowCount).toBe(0);
    const clientExt = await withDr(() =>
      owner.query("SELECT 1 FROM client_ext WHERE id = $1", [o.id]),
    );
    expect(clientExt.rowCount).toBe(1);
  });

  it("drop_type does NOT abort on the biconditional; objects become notes; table dropped", async () => {
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    const o1 = await writer.write(WCTX, { type: "client", props: { tier: "gold" } });
    const o2 = await writer.write(WCTX, { type: "client", props: { tier: "silver" } });

    await exec.dropType(t.typeId, SYSTEM);

    // the type + its table are gone
    expect(await regclass("client_ext")).toBeNull();
    const types = await reader.listTypes(RCTX);
    expect(types.map((x) => x.name)).not.toContain("client");
    // the objects survive as notes
    for (const o of [o1, o2]) {
      const got = await reader.get(RCTX, o.id);
      expect(got.type).toBeNull();
      expect(got.deleted_at).toBeNull();
    }
  });

  it("drop_type refuses while another type still references it", async () => {
    const client = await exec.defineType({ name: "client" }, SYSTEM);
    const deal = await exec.defineType({ name: "deal" }, SYSTEM);
    await exec.addProperty(
      { typeId: deal.typeId, name: "account", kind: "ref", refTypeName: "client" },
      SYSTEM,
    );
    await expect(exec.dropType(client.typeId, SYSTEM)).rejects.toMatchObject({ code: "refused" });
    // still there
    expect(await regclass("client_ext")).not.toBeNull();
  });
});
