import { Pool, type Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import {
  Reader,
  Writer,
  Admin,
  FsStore,
  callTool,
  type ToolDeps,
  type AuthedContext,
  type WriteContext,
} from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";

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

describe("claim reason: app.write_reason -> events.payload.reason", () => {
  let brain: FreshBrain;
  let pool: Pool;

  beforeEach(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
  }, 120_000);

  afterEach(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("a create with app.write_reason set produces a create event carrying that reason", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.actor_id', $1, true)", [SYSTEM]);
      await client.query("SELECT set_config('app.write_reason', $1, true)", ["seeded from a doc"]);
      const r = await client.query<{ id: string }>(
        "INSERT INTO objects (title, created_by) VALUES ($1, $2) RETURNING id",
        ["hi", SYSTEM],
      );
      await client.query("COMMIT");
      const ev = await client.query<{ payload: { reason?: string } }>(
        "SELECT payload FROM events WHERE target = $1 AND kind = 'create'",
        [r.rows[0]!.id],
      );
      expect(ev.rows[0]!.payload.reason).toBe("seeded from a doc");
    } finally {
      client.release();
    }
  });

  it("an omitted app.write_reason produces payload.reason = null", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.actor_id', $1, true)", [SYSTEM]);
      const r = await client.query<{ id: string }>(
        "INSERT INTO objects (title, created_by) VALUES ($1, $2) RETURNING id",
        ["hi", SYSTEM],
      );
      await client.query("COMMIT");
      const ev = await client.query<{ payload: { reason?: string | null } }>(
        "SELECT payload FROM events WHERE target = $1 AND kind = 'create'",
        [r.rows[0]!.id],
      );
      expect(ev.rows[0]!.payload.reason ?? null).toBeNull();
    } finally {
      client.release();
    }
  });
});

describe("claim reason: Writer.write/edit", () => {
  const CTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
  let brain: FreshBrain;
  let pool: Pool;
  let writer: Writer;
  let owner: Client;

  beforeEach(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    writer = new Writer(pool);
    owner = await brain.connect("owner");
  }, 120_000);

  afterEach(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  it("write() with a reason produces a create event carrying it", async () => {
    const r = await writer.write(CTX, { title: "hi", reason: "seeding the demo" });
    const ev = await owner.query<{ payload: { reason?: string } }>(
      "SELECT payload FROM events WHERE target = $1 AND kind = 'create'",
      [r.id],
    );
    expect(ev.rows[0]!.payload.reason).toBe("seeding the demo");
  });

  it("write() without a reason produces payload.reason = null", async () => {
    const r = await writer.write(CTX, { title: "hi" });
    const ev = await owner.query<{ payload: { reason?: string | null } }>(
      "SELECT payload FROM events WHERE target = $1 AND kind = 'create'",
      [r.id],
    );
    expect(ev.rows[0]!.payload.reason ?? null).toBeNull();
  });

  it("edit() with a reason produces an update event whose payload.version matches this edit", async () => {
    const w = await writer.write(CTX, { title: "a", body: "one" });
    const e = await writer.edit(CTX, w.id, {
      version: 1,
      bodyOps: [{ op: "set", text: "two" }],
      reason: "fixing a typo",
    });
    expect(e.version).toBe(2);
    const ev = await owner.query<{ payload: { reason?: string; version?: number } }>(
      "SELECT payload FROM events WHERE target = $1 AND kind = 'update' ORDER BY seq DESC LIMIT 1",
      [w.id],
    );
    expect(ev.rows[0]!.payload.reason).toBe("fixing a typo");
    expect(ev.rows[0]!.payload.version).toBe(2);
  });

  it("a prop edit produces an update_props event carrying old/new AND the reason", async () => {
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    // explicit org publish — the default is now private, which would redact
    // the update_props payload this test asserts on
    const w = await writer.write(CTX, {
      type: "client",
      props: { tier: "silver" },
      visibility: "org",
    });
    await writer.edit(CTX, w.id, {
      version: 1,
      props: { tier: "gold" },
      reason: "upgraded",
    });
    const ev = await owner.query<{
      payload: { changed?: Record<string, { old: unknown; new: unknown }>; reason?: string };
    }>("SELECT payload FROM events WHERE target = $1 AND kind = 'update_props'", [w.id]);
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0]!.payload.changed?.["tier"]).toEqual({ old: "silver", new: "gold" });
    expect(ev.rows[0]!.payload.reason).toBe("upgraded");
  });

  it("0027: update_props stamps the exact version — no seq-proximity guessing needed", async () => {
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client3" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    const w = await writer.write(CTX, {
      type: "client3",
      props: { tier: "silver" },
      visibility: "org", // org publish so update_props carries the version un-redacted
    });
    // an unrelated title edit first (its own 'update' event), THEN the prop
    // edit — if version-stamping ever regressed to seq-proximity guessing,
    // this is exactly the shape that could misattribute to the wrong version.
    const titleEdit = await writer.edit(CTX, w.id, { version: 1, title: "renamed" });
    const propEdit = await writer.edit(CTX, w.id, {
      version: titleEdit.version,
      props: { tier: "gold" },
      reason: "exact stamp check",
    });
    const ev = await owner.query<{ payload: { version?: number } }>(
      "SELECT payload FROM events WHERE target = $1 AND kind = 'update_props'",
      [w.id],
    );
    expect(ev.rows[0]!.payload.version).toBe(propEdit.version);
    expect(ev.rows[0]!.payload.version).not.toBe(titleEdit.version);
  });

  it("two edits in a row: each event's reason lines up with its own version, not the adjacent one", async () => {
    const w = await writer.write(CTX, { body: "a" });
    await writer.edit(CTX, w.id, {
      version: 1,
      bodyOps: [{ op: "set", text: "b" }],
      reason: "first",
    });
    await writer.edit(CTX, w.id, {
      version: 2,
      bodyOps: [{ op: "set", text: "c" }],
      reason: "second",
    });
    const events = await owner.query<{ payload: { reason?: string; version?: number } }>(
      "SELECT payload FROM events WHERE target = $1 AND kind = 'update' ORDER BY seq ASC",
      [w.id],
    );
    expect(events.rows.map((r) => r.payload.version)).toEqual([2, 3]);
    expect(events.rows.map((r) => r.payload.reason)).toEqual(["first", "second"]);
  });

  it("changing two properties in one edit call produces one update_props event with both, and the reason", async () => {
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client2" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "seats", kind: "int" }, SYSTEM);
    const w = await writer.write(CTX, {
      type: "client2",
      props: { tier: "silver", seats: 3 },
      visibility: "org", // org publish so the update_props diff stays un-redacted
    });
    await writer.edit(CTX, w.id, {
      version: 1,
      props: { tier: "gold", seats: 10 },
      reason: "annual renewal bundle",
    });
    const ev = await owner.query<{
      payload: { changed?: Record<string, { old: unknown; new: unknown }>; reason?: string };
    }>("SELECT payload FROM events WHERE target = $1 AND kind = 'update_props'", [w.id]);
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0]!.payload.changed).toEqual({
      tier: { old: "silver", new: "gold" },
      seats: { old: 3, new: 10 },
    });
    expect(ev.rows[0]!.payload.reason).toBe("annual renewal bundle");
  });

  it("prepend and find_replace body ops both carry the reason through to their update event", async () => {
    const w = await writer.write(CTX, { body: "middle" });
    const prepended = await writer.edit(CTX, w.id, {
      version: 1,
      bodyOps: [{ op: "prepend", text: "start " }],
      reason: "add context up front",
    });
    await writer.edit(CTX, w.id, {
      version: prepended.version,
      bodyOps: [{ op: "find_replace", find: "middle", replace: "center", expectCount: 1 }],
      reason: "fix terminology",
    });
    const events = await owner.query<{ payload: { reason?: string; version?: number } }>(
      "SELECT payload FROM events WHERE target = $1 AND kind = 'update' ORDER BY seq ASC",
      [w.id],
    );
    expect(events.rows.map((r) => r.payload.reason)).toEqual([
      "add context up front",
      "fix terminology",
    ]);
    const finalBody = await withDr(owner, () =>
      owner.query<{ body: string }>("SELECT body FROM objects WHERE id = $1", [w.id]),
    );
    // prepend concatenates literally — no separator injected
    expect(finalBody.rows[0]!.body).toBe("start center");
  });

  it("delete and restore events carry a numeric payload.version too (needed for the history timeline)", async () => {
    const w = await writer.write(CTX, { title: "temp" });
    const del = await writer.softDelete(CTX, w.id);
    const restored = await writer.restore(CTX, w.id);
    const events = await owner.query<{ kind: string; payload: { version?: number } }>(
      "SELECT kind, payload FROM events WHERE target = $1 AND kind IN ('delete','restore') ORDER BY seq ASC",
      [w.id],
    );
    expect(events.rows).toEqual([
      { kind: "delete", payload: { version: del.version, reason: null } },
      { kind: "restore", payload: { version: restored.version, reason: null } },
    ]);
  });

  it("a private object's prop-change event stays redacted (no reason leak either)", async () => {
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    const w = await writer.write(CTX, {
      type: "client",
      props: { tier: "silver" },
      visibility: "private",
    });
    await writer.edit(CTX, w.id, {
      version: 1,
      props: { tier: "gold" },
      reason: "secret upgrade",
    });
    const ev = await owner.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE target = $1 AND kind = 'update_props'",
      [w.id],
    );
    expect(ev.rows[0]!.payload).toEqual({ private: true });
  });
});

describe("claim reason: tool surface + doctrine", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let deps: ToolDeps;
  let ctx: AuthedContext;

  beforeEach(async () => {
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
    ctx = { actorId: SYSTEM, scopes: ["read", "write", "schema-admin"], role: "owner" };
  }, 120_000);

  afterEach(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  it("the write tool accepts and threads reason through to the create event", async () => {
    const r = (await callTool(deps, ctx, "write", {
      title: "hi",
      reason: "via the tool surface",
    })) as { id: string };
    const ev = await owner.query<{ payload: { reason?: string } }>(
      "SELECT payload FROM events WHERE target = $1 AND kind = 'create'",
      [r.id],
    );
    expect(ev.rows[0]!.payload.reason).toBe("via the tool surface");
  });

  it("the edit tool accepts and threads reason through to the update event", async () => {
    const w = (await callTool(deps, ctx, "write", { title: "a", body: "one" })) as {
      id: string;
    };
    await callTool(deps, ctx, "edit", {
      id: w.id,
      version: 1,
      body_ops: [{ op: "set", text: "two" }],
      reason: "via the tool surface",
    });
    const ev = await owner.query<{ payload: { reason?: string } }>(
      "SELECT payload FROM events WHERE target = $1 AND kind = 'update' ORDER BY seq DESC LIMIT 1",
      [w.id],
    );
    expect(ev.rows[0]!.payload.reason).toBe("via the tool surface");
  });

  it("start's doctrine tells agents to pass a reason", async () => {
    const out = (await callTool(deps, ctx, "start", {})) as { text: string };
    expect(out.text).toContain("Say why");
    expect(out.text).toContain("reason");
  });
});

describe("claim reason: Reader.history surfaces payload", () => {
  const CTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
  let brain: FreshBrain;
  let pool: Pool;
  let writer: Writer;
  let reader: Reader;

  beforeEach(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    writer = new Writer(pool);
    reader = new Reader(pool);
  }, 120_000);

  afterEach(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("history() events include payload.reason for both create and update_props", async () => {
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    const w = await writer.write(CTX, {
      type: "client",
      props: { tier: "silver" },
      reason: "start",
      visibility: "org", // org publish so update_props keeps reason + changed values
    });
    await writer.edit(CTX, w.id, { version: 1, props: { tier: "gold" }, reason: "upgrade" });
    const hist = (await reader.history({ actorId: SYSTEM }, w.id)) as {
      events: Array<{
        kind: string;
        payload: {
          reason?: string;
          changed?: Record<string, { old: unknown; new: unknown }>;
        };
      }>;
    };
    const create = hist.events.find((e) => e.kind === "create")!;
    const propUpdate = hist.events.find((e) => e.kind === "update_props")!;
    expect(create.payload.reason).toBe("start");
    expect(propUpdate.payload.reason).toBe("upgrade");
    expect(propUpdate.payload.changed?.["tier"]).toEqual({ old: "silver", new: "gold" });
    await owner.end();
  });
});
