import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";

/** Run `fn` in a txn with app.actor_id set (as the write path would). */
async function withActor<T>(client: Client, actor: string, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actor]);
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

describe("generic invariant triggers", () => {
  let brain: FreshBrain;
  let owner: Client;
  let app: Client;
  let typeId: number;

  beforeAll(async () => {
    brain = await createFreshBrain();
    owner = await brain.connect("owner");
    app = await brain.connect("app");
    const def = await new SchemaExecutor(owner).defineType({ name: "client" }, SYSTEM);
    typeId = def.typeId;
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await brain?.drop();
  });

  // ---- D.5 tsv ----------------------------------------------------------
  it("D.5: populates the search vector on objects", async () => {
    const id = await withActor(app, SYSTEM, async () => {
      const r = await app.query<{ id: string }>(
        "INSERT INTO objects (title, body, created_by) VALUES ('t', 'a searchable haystack', $1) RETURNING id",
        [SYSTEM],
      );
      return r.rows[0]!.id;
    });
    const hit = await withDr(owner, () =>
      owner.query<{ v: boolean }>(
        "SELECT tsv @@ websearch_to_tsquery('english', 'searchable') AS v FROM objects WHERE id = $1",
        [id],
      ),
    );
    expect(hit.rows[0]!.v).toBe(true);
  });

  // ---- D.3 audit + attribution -----------------------------------------
  it("D.3: writes an attributed 'create' event", async () => {
    const id = await withActor(app, SYSTEM, async () => {
      const r = await app.query<{ id: string }>(
        "INSERT INTO objects (body, created_by) VALUES ('x', $1) RETURNING id",
        [SYSTEM],
      );
      return r.rows[0]!.id;
    });
    const ev = await owner.query<{ actor: string; kind: string }>(
      "SELECT actor, kind FROM events WHERE target = $1 AND kind = 'create'",
      [id],
    );
    expect(ev.rows[0]).toMatchObject({ actor: SYSTEM, kind: "create" });
  });

  it("D.3: a write with no app.actor_id ABORTS (no unattributed rows)", async () => {
    // Since 0057 the audience RLS WITH CHECK fires before the D.3 audit trigger
    // ever runs — the write still aborts, just with the RLS message.
    await expect(
      app.query("INSERT INTO objects (body, created_by) VALUES ('y', $1)", [SYSTEM]),
    ).rejects.toThrow(/row-level security/i);
  });

  // ---- D.1 biconditional ------------------------------------------------
  it("D.1: a typed object without a live ext row is rejected at commit", async () => {
    await expect(
      withActor(app, SYSTEM, async () => {
        await app.query("INSERT INTO objects (type_id, created_by) VALUES ($1, $2)", [
          typeId,
          SYSTEM,
        ]);
      }),
    ).rejects.toThrow(/biconditional/i);
  });

  it("D.1: object + ext in the same txn commit fine", async () => {
    const id = await withActor(app, SYSTEM, async () => {
      const o = await app.query<{ id: string }>(
        "INSERT INTO objects (type_id, created_by) VALUES ($1, $2) RETURNING id",
        [typeId, SYSTEM],
      );
      const oid = o.rows[0]!.id;
      await app.query("INSERT INTO client_ext (id) VALUES ($1)", [oid]);
      return oid;
    });
    const chk = await withDr(owner, () =>
      owner.query("SELECT 1 FROM client_ext WHERE id = $1", [id]),
    );
    expect(chk.rowCount).toBe(1);
  });

  it("D.1: an ext row whose parent is a note (type mismatch) is rejected", async () => {
    await expect(
      withActor(app, SYSTEM, async () => {
        const o = await app.query<{ id: string }>(
          "INSERT INTO objects (created_by) VALUES ($1) RETURNING id",
          [SYSTEM],
        );
        await app.query("INSERT INTO client_ext (id) VALUES ($1)", [o.rows[0]!.id]);
      }),
    ).rejects.toThrow(/biconditional/i);
  });

  // ---- D.7 soft-delete --------------------------------------------------
  it("D.7: DELETE on a note is rewritten to a soft-delete (row survives)", async () => {
    const id = await withActor(app, SYSTEM, async () => {
      const r = await app.query<{ id: string }>(
        "INSERT INTO objects (body, created_by) VALUES ('doomed', $1) RETURNING id",
        [SYSTEM],
      );
      return r.rows[0]!.id;
    });
    await withActor(app, SYSTEM, async () => {
      await app.query("DELETE FROM objects WHERE id = $1", [id]);
    });
    const row = await withDr(owner, () =>
      owner.query<{ deleted_at: Date | null; deleted_by: string | null }>(
        "SELECT deleted_at, deleted_by FROM objects WHERE id = $1",
        [id],
      ),
    );
    expect(row.rowCount).toBe(1); // still physically present
    expect(row.rows[0]!.deleted_at).not.toBeNull();
    expect(row.rows[0]!.deleted_by).toBe(SYSTEM);
    const ev = await owner.query("SELECT 1 FROM events WHERE target = $1 AND kind = 'delete'", [
      id,
    ]);
    expect(ev.rowCount).toBe(1);
  });

  it("D.7: soft-deleting a typed object mirrors into its ext row", async () => {
    const id = await withActor(app, SYSTEM, async () => {
      const o = await app.query<{ id: string }>(
        "INSERT INTO objects (type_id, created_by) VALUES ($1, $2) RETURNING id",
        [typeId, SYSTEM],
      );
      await app.query("INSERT INTO client_ext (id) VALUES ($1)", [o.rows[0]!.id]);
      return o.rows[0]!.id;
    });
    await withActor(app, SYSTEM, async () => {
      await app.query("DELETE FROM objects WHERE id = $1", [id]);
    });
    const ext = await withDr(owner, () =>
      owner.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM client_ext WHERE id = $1", [
        id,
      ]),
    );
    expect(ext.rows[0]!.deleted_at).not.toBeNull();
  });
});
