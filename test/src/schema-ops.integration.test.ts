import { Pool, type Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Reader, Writer, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };

async function withActor<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.actor_id', $1, true)", [SYSTEM]);
    const r = await fn();
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Verification read on the owner client. Since 0057 a bare brain_owner sees no
 *  objects rows (audience RLS); the txn-local DR escape is the sanctioned way
 *  for brain_owner to read everything. */
async function withDr<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL app.fs_dr = 'on'");
    const r = await fn();
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

describe("agent schema ops", () => {
  let brain: FreshBrain;
  let owner: Client;
  let app: Client;
  let exec: SchemaExecutor;

  beforeEach(async () => {
    brain = await createFreshBrain();
    owner = await brain.connect("owner");
    app = await brain.connect("app");
    exec = new SchemaExecutor(owner);
  }, 120_000);

  afterEach(async () => {
    await app?.end();
    await owner?.end();
    await brain?.drop();
  });

  it("adds columns of every scalar kind", async () => {
    const t = await exec.defineType({ name: "widget" }, SYSTEM);
    for (const kind of ["text", "int", "decimal", "float", "bool", "date", "timestamp"] as const) {
      await exec.addProperty({ typeId: t.typeId, name: `f_${kind}`, kind }, SYSTEM);
    }
    const cols = await owner.query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'widget_ext'",
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.data_type]));
    expect(byName["f_int"]).toBe("bigint");
    expect(byName["f_decimal"]).toBe("numeric");
    expect(byName["f_float"]).toBe("double precision");
    expect(byName["f_timestamp"]).toBe("timestamp with time zone");
  });

  it("D.6: rejects NaN/Infinity on decimal AND float", async () => {
    const t = await exec.defineType({ name: "measure" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "d", kind: "decimal" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "f", kind: "float" }, SYSTEM);

    async function insert(col: string, val: string): Promise<void> {
      await withActor(app, async () => {
        const o = await app.query<{ id: string }>(
          "INSERT INTO objects (type_id, created_by) VALUES ($1,$2) RETURNING id",
          [t.typeId, SYSTEM],
        );
        await app.query(`INSERT INTO measure_ext (id, ${col}) VALUES ($1, $2)`, [
          o.rows[0]!.id,
          val,
        ]);
      });
    }
    await expect(insert("d", "NaN")).rejects.toThrow();
    await expect(insert("f", "Infinity")).rejects.toThrow();
    await expect(insert("f", "-Infinity")).rejects.toThrow();
    // a finite value is fine
    await expect(insert("d", "3.14")).resolves.toBeUndefined();
  });

  it("D.4: enum membership is enforced against enum_option", async () => {
    const t = await exec.defineType({ name: "task" }, SYSTEM);
    await exec.addProperty(
      { typeId: t.typeId, name: "status", kind: "enum", enumValues: ["open", "done"] },
      SYSTEM,
    );
    async function insert(status: string): Promise<void> {
      await withActor(app, async () => {
        const o = await app.query<{ id: string }>(
          "INSERT INTO objects (type_id, created_by) VALUES ($1,$2) RETURNING id",
          [t.typeId, SYSTEM],
        );
        await app.query("INSERT INTO task_ext (id, status) VALUES ($1, $2)", [
          o.rows[0]!.id,
          status,
        ]);
      });
    }
    await expect(insert("open")).resolves.toBeUndefined();
    await expect(insert("nonsense")).rejects.toThrow(/enum/i);
  });

  it("ref: a uuid column with a validated FK to the target ext table (type-safe)", async () => {
    const client = await exec.defineType({ name: "client" }, SYSTEM);
    const deal = await exec.defineType({ name: "deal" }, SYSTEM);
    await exec.addProperty(
      { typeId: deal.typeId, name: "account", kind: "ref", refTypeName: "client" },
      SYSTEM,
    );
    // a deal referencing a real client id works; a random uuid fails the FK
    const clientId = await withActor(app, async () => {
      const o = await app.query<{ id: string }>(
        "INSERT INTO objects (type_id, created_by) VALUES ($1,$2) RETURNING id",
        [client.typeId, SYSTEM],
      );
      await app.query("INSERT INTO client_ext (id) VALUES ($1)", [o.rows[0]!.id]);
      return o.rows[0]!.id;
    });
    await expect(
      withActor(app, async () => {
        const o = await app.query<{ id: string }>(
          "INSERT INTO objects (type_id, created_by) VALUES ($1,$2) RETURNING id",
          [deal.typeId, SYSTEM],
        );
        await app.query("INSERT INTO deal_ext (id, account) VALUES ($1, $2)", [
          o.rows[0]!.id,
          clientId,
        ]);
      }),
    ).resolves.toBeUndefined();

    await expect(
      withActor(app, async () => {
        const o = await app.query<{ id: string }>(
          "INSERT INTO objects (type_id, created_by) VALUES ($1,$2) RETURNING id",
          [deal.typeId, SYSTEM],
        );
        await app.query("INSERT INTO deal_ext (id, account) VALUES ($1, gen_random_uuid())", [
          o.rows[0]!.id,
        ]);
      }),
    ).rejects.toThrow();
  });

  it("cyclic types: two types can reference each other (refs added post-creation)", async () => {
    const a = await exec.defineType({ name: "person" }, SYSTEM);
    const b = await exec.defineType({ name: "company" }, SYSTEM);
    await exec.addProperty(
      { typeId: a.typeId, name: "employer", kind: "ref", refTypeName: "company" },
      SYSTEM,
    );
    await exec.addProperty(
      { typeId: b.typeId, name: "ceo", kind: "ref", refTypeName: "person" },
      SYSTEM,
    );
    const fks = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.table_constraints
       WHERE constraint_type = 'FOREIGN KEY' AND table_name IN ('person_ext', 'company_ext')`,
    );
    expect(Number(fks.rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it("ref[]: creates a junction table with real FKs", async () => {
    await exec.defineType({ name: "tag" }, SYSTEM);
    const post = await exec.defineType({ name: "post" }, SYSTEM);
    await exec.addProperty(
      { typeId: post.typeId, name: "tags", kind: "ref[]", refTypeName: "tag" },
      SYSTEM,
    );
    const junctions = await owner.query<{ name: string }>(
      "SELECT name FROM physical_name WHERE kind = 'table' AND name LIKE 'post%tags%'",
    );
    expect(junctions.rowCount).toBe(1);
  });

  it("set_type promotes an untyped note (and re-setting the same type is a no-op)", async () => {
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    const noteId = await withActor(app, async () => {
      const o = await app.query<{ id: string }>(
        "INSERT INTO objects (body, created_by) VALUES ('grows up', $1) RETURNING id",
        [SYSTEM],
      );
      return o.rows[0]!.id;
    });
    const pool = new Pool(brain.appConfig);
    try {
      const writer = new Writer(pool);
      const promoted = await writer.setType(WCTX, noteId, "client");
      expect(promoted.from_type).toBeNull();
      expect(promoted.to_type).toBe("client");
      // DR-escaped reads: since 0057 a bare brain_owner sees no objects rows.
      const row = await withDr(owner, () =>
        owner.query<{ type_id: number }>("SELECT type_id FROM objects WHERE id = $1", [noteId]),
      );
      expect(row.rows[0]!.type_id).toBe(t.typeId);
      const ext = await withDr(owner, () =>
        owner.query("SELECT 1 FROM client_ext WHERE id = $1", [noteId]),
      );
      expect(ext.rowCount).toBe(1);
      // second set to the same type: idempotent no-op, no version bump
      const again = await writer.setType(WCTX, noteId, "client");
      expect(again.version).toBe(promoted.version);
    } finally {
      await pool.end();
    }
  });

  it("dropType onlyIfEmpty: objects (even trashed) and deprecated inbound refs refuse; empty deletes fully", async () => {
    const junk = await exec.defineType({ name: "junk" }, SYSTEM);
    await exec.addProperty(
      { typeId: junk.typeId, name: "flavor", kind: "enum", enumValues: ["a", "b"] },
      SYSTEM,
    );
    // an object filed under it — even after trashing — blocks deletion
    const id = await withActor(app, async () => {
      const o = await app.query<{ id: string }>(
        "INSERT INTO objects (type_id, title, created_by) VALUES ($1, 'x', $2) RETURNING id",
        [junk.typeId, SYSTEM],
      );
      await app.query("INSERT INTO junk_ext (id) VALUES ($1)", [o.rows[0]!.id]);
      return o.rows[0]!.id;
    });
    await expect(exec.dropType(junk.typeId, SYSTEM, { onlyIfEmpty: true })).rejects.toMatchObject({
      code: "refused",
    });
    await withActor(app, () =>
      app.query(
        "UPDATE objects SET deleted_at = now(), deleted_by = $2, version = version + 1 WHERE id = $1",
        [id, SYSTEM],
      ),
    );
    await expect(exec.dropType(junk.typeId, SYSTEM, { onlyIfEmpty: true })).rejects.toMatchObject({
      code: "refused",
    });

    // a DEPRECATED inbound ref prop still blocks (its FK would break the DROP)
    const empty = await exec.defineType({ name: "empty" }, SYSTEM);
    const other = await exec.defineType({ name: "other" }, SYSTEM);
    const p = await exec.addProperty(
      { typeId: other.typeId, name: "target", kind: "ref", refTypeName: "empty" },
      SYSTEM,
    );
    await exec.deprecateProperty(p.propertyId, SYSTEM);
    await expect(exec.dropType(empty.typeId, SYSTEM, { onlyIfEmpty: true })).rejects.toMatchObject({
      code: "refused",
    });

    // zero objects, no inbound refs: table, catalog rows, and enum values all go
    const clean = await exec.defineType({ name: "cleanme" }, SYSTEM);
    await exec.addProperty(
      { typeId: clean.typeId, name: "mood", kind: "enum", enumValues: ["ok"] },
      SYSTEM,
    );
    await exec.dropType(clean.typeId, SYSTEM, { onlyIfEmpty: true });
    const tbl = await owner.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'cleanme_ext'",
    );
    expect(tbl.rowCount).toBe(0);
    const cat = await owner.query("SELECT 1 FROM types WHERE id = $1", [clean.typeId]);
    expect(cat.rowCount).toBe(0);
    const en = await owner.query("SELECT 1 FROM enum_option WHERE type_id = $1", [clean.typeId]);
    expect(en.rowCount).toBe(0);
  });

  it("dropType onlyIfEmpty refuses even when the type's only objects are INVISIBLE to the caller", async () => {
    // Tag-model regression (0057): the emptiness check must count ALL objects,
    // not the caller-visible slice — a member's PRIVATE object under the type
    // must still block deletion, with the teaching refusal (never a raw FK
    // error from the catalog DELETE).
    const secret = await exec.defineType({ name: "secretful" }, SYSTEM);
    const stranger = "11111111-1111-1111-1111-111111111111";
    await withDr(owner, async () => {
      await owner.query(
        `INSERT INTO accounts (id, name, email, role, scopes, token_hash)
         VALUES ($1, 'stranger', 'stranger@test.brain', 'member', ARRAY['read','write'], 'x')
         ON CONFLICT DO NOTHING`,
        [stranger],
      );
    });
    await withActor(app, async () => {
      // as the stranger: a private (creator-only audience) object of the type
      await app.query("SELECT set_config('app.actor_id', $1, true)", [stranger]);
      const o = await app.query<{ id: string }>(
        `INSERT INTO objects (type_id, title, created_by, visibility, audience)
         SELECT $1, 'their secret', $2, 'private',
                (SELECT jsonb_build_array(jsonb_build_array(id::text)) FROM tags
                  WHERE kind = 'personal' AND account_id = $2)
         RETURNING id`,
        [secret.typeId, stranger],
      );
      await app.query("INSERT INTO secretful_ext (id) VALUES ($1)", [o.rows[0]!.id]);
    });
    await expect(exec.dropType(secret.typeId, SYSTEM, { onlyIfEmpty: true })).rejects.toMatchObject(
      { code: "refused" },
    );
  });

  it("catalog omits retired types; the dashboard listTypes keeps them", async () => {
    await exec.defineType({ name: "visible_t" }, SYSTEM);
    const dead = await exec.defineType({ name: "dead_t" }, SYSTEM);
    await exec.deprecateType(dead.typeId, SYSTEM);
    const pool = new Pool(brain.appConfig);
    try {
      const reader = new Reader(pool);
      const cat = await reader.catalog({ actorId: SYSTEM });
      const names = cat.types.map((t) => t["name"]);
      expect(names).toContain("visible_t");
      expect(names).not.toContain("dead_t");
      const dash = await reader.listTypes({ actorId: SYSTEM });
      expect(dash.map((t) => t["name"])).toContain("dead_t");
    } finally {
      await pool.end();
    }
  });

  it("enforces the global schema budget with a teaching error", async () => {
    const tiny = new SchemaExecutor(owner, {
      maxTypes: 1,
      maxPropertiesPerType: 1,
      maxEnumValues: 100,
    });
    await tiny.defineType({ name: "only" }, SYSTEM);
    await expect(tiny.defineType({ name: "toomany" }, SYSTEM)).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("deprecate/restore a property", async () => {
    const t = await exec.defineType({ name: "widget" }, SYSTEM);
    const p = await exec.addProperty({ typeId: t.typeId, name: "color", kind: "text" }, SYSTEM);
    await exec.deprecateProperty(p.propertyId, SYSTEM);
    let row = await owner.query<{ deprecated: boolean }>(
      "SELECT deprecated FROM type_properties WHERE id = $1",
      [p.propertyId],
    );
    expect(row.rows[0]!.deprecated).toBe(true);
    await exec.restoreProperty(p.propertyId, SYSTEM);
    row = await owner.query("SELECT deprecated FROM type_properties WHERE id = $1", [p.propertyId]);
    expect(row.rows[0]!.deprecated).toBe(false);
  });
});
