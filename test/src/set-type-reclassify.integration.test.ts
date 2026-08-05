import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Admin, Writer, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * set_type as reclassification (work item d2286dda): an object moves between
 * types IN PLACE — id, manual links, history, and audit trail survive; the
 * target type's required props are supplied through `props`; the old type's
 * scalar values are dropped (and returned). The old promotion-only refusal
 * ("create a new typed object with write()") recommended data loss; this
 * suite pins the replacement semantics.
 */
describe("set_type reclassification", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let writer: Writer;
  let admin: Admin;
  let alice: string;

  const wctx = (id: string): WriteContext => ({ actorId: id, scopes: ["read", "write"] });

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    writer = new Writer(pool);
    admin = new Admin(pool);
    alice = (await admin.bootstrapOwner({ name: "alice", email: "owner@example.com" })).id;

    const owner = await brain.connect("owner");
    try {
      const exec = new SchemaExecutor(owner);
      // task: due (date), done (bool) — the misfiled shape
      const task = await exec.defineType({ name: "task" }, alice);
      await exec.addProperty({ typeId: task.typeId, name: "due", kind: "date" }, alice);
      await exec.addProperty({ typeId: task.typeId, name: "done", kind: "bool" }, alice);
      // work_item: kind (required enum), priority (enum) — the target shape
      const wi = await exec.defineType({ name: "work_item" }, alice);
      await exec.addProperty(
        {
          typeId: wi.typeId,
          name: "kind",
          kind: "enum",
          required: true,
          enumValues: ["bug", "improvement"],
        },
        alice,
      );
      await exec.defineType({ name: "person" }, alice);
      await exec.addProperty(
        { typeId: wi.typeId, name: "assignee", kind: "ref[]", refTypeName: "person" },
        alice,
      );
      // pointer: holds a scalar ref → task, to pin the FK refusal
      const ptr = await exec.defineType({ name: "pointer" }, alice);
      await exec.addProperty(
        { typeId: ptr.typeId, name: "the_task", kind: "ref", refTypeName: "task" },
        alice,
      );
    } finally {
      await owner.end();
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("moves a typed object to another type: id/links/history survive, props replaced", async () => {
    const anchor = await writer.write(wctx(alice), { title: "an anchor" });
    const o = await writer.write(wctx(alice), {
      type: "task",
      title: "misfiled",
      props: { due: "2026-08-01", done: false },
      links: [{ rel: "references", to: anchor.id }],
    });

    const r = await writer.setType(wctx(alice), o.id, "work_item", {
      version: o.version,
      props: { kind: "bug" },
      reason: "was really a bug report",
    });
    expect(r).toMatchObject({ id: o.id, from_type: "task", to_type: "work_item" });
    expect(r.version).toBe(o.version + 1);
    // the old scalar values come back to the caller, not silently vanish
    expect(r.dropped_props).toMatchObject({ done: false });
    expect(r.dropped_props!["due"]).toBeTruthy();

    const su = await brain.connect("superuser");
    try {
      const obj = await su.query<{ type_id: number }>("SELECT type_id FROM objects WHERE id = $1", [
        o.id,
      ]);
      const wi = await su.query<{ id: number }>("SELECT id FROM types WHERE name = 'work_item'");
      expect(obj.rows[0]!.type_id).toBe(wi.rows[0]!.id);
      // ext row moved tables
      const oldExt = await su.query("SELECT 1 FROM task_ext WHERE id = $1", [o.id]);
      expect(oldExt.rowCount).toBe(0);
      const newExt = await su.query<{ kind: string }>(
        "SELECT kind FROM work_item_ext WHERE id = $1",
        [o.id],
      );
      expect(newExt.rows[0]!.kind).toBe("bug");
      // manual link untouched
      const edge = await su.query(
        "SELECT 1 FROM edges WHERE from_id = $1 AND to_id = $2 AND rel = 'references'",
        [o.id, anchor.id],
      );
      expect(edge.rowCount).toBe(1);
      // the audit trail shows an explicit set_type event with from/to types
      const ev = await su.query<{ payload: { from_type_id: number; to_type_id: number } }>(
        "SELECT payload FROM events WHERE target = $1 AND kind = 'set_type' ORDER BY seq DESC LIMIT 1",
        [o.id],
      );
      expect(ev.rowCount).toBe(1);
      expect(ev.rows[0]!.payload.to_type_id).toBe(wi.rows[0]!.id);
      expect(ev.rows[0]!.payload.from_type_id).not.toBeNull();
    } finally {
      await su.end();
    }
  });

  it("retyping an already-typed object is version-guarded (omitted == mismatch)", async () => {
    const o = await writer.write(wctx(alice), { type: "task", title: "guarded" });
    await expect(
      writer.setType(wctx(alice), o.id, "work_item", { props: { kind: "bug" } }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      writer.setType(wctx(alice), o.id, "work_item", { version: 99, props: { kind: "bug" } }),
    ).rejects.toMatchObject({ code: "conflict" });
    // the conflict teaches the current version, and retrying with it works
    await writer.setType(wctx(alice), o.id, "work_item", {
      version: o.version,
      props: { kind: "bug" },
    });
  });

  it("still demands the target's required props on a retype", async () => {
    const o = await writer.write(wctx(alice), { type: "task", title: "missing kind" });
    await expect(
      writer.setType(wctx(alice), o.id, "work_item", { version: o.version }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("refuses to retype out from under another object's scalar ref", async () => {
    const t = await writer.write(wctx(alice), { type: "task", title: "referenced" });
    await writer.write(wctx(alice), { type: "pointer", props: { the_task: t.id } });
    await expect(
      writer.setType(wctx(alice), t.id, "work_item", {
        version: t.version,
        props: { kind: "bug" },
      }),
    ).rejects.toMatchObject({ code: "refused" });
  });

  it("ref[] props ride along as links, and enum values are still enforced", async () => {
    const person = await writer.write(wctx(alice), { title: "a person" });
    const o = await writer.write(wctx(alice), { type: "task", title: "with assignee" });
    await expect(
      writer.setType(wctx(alice), o.id, "work_item", {
        version: o.version,
        props: { kind: "not_a_value" },
      }),
    ).rejects.toMatchObject({ code: "validation" });
    const r = await writer.setType(wctx(alice), o.id, "work_item", {
      version: o.version,
      props: { kind: "improvement", assignee: [person.id] },
    });
    expect(r.to_type).toBe("work_item");
    const su = await brain.connect("superuser");
    try {
      const edge = await su.query(
        "SELECT 1 FROM edges WHERE from_id = $1 AND to_id = $2 AND rel = 'assignee'",
        [o.id, person.id],
      );
      expect(edge.rowCount).toBe(1);
    } finally {
      await su.end();
    }
  });
});
