import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
const RCTX: ReadContext = { actorId: SYSTEM };

/**
 * Hardening fixes found by the adversarial MCP sweep. Each `it` pins one gap so
 * a regression fails loudly.
 */
describe("brain hardening", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let writer: Writer;
  let reader: Reader;
  let owner: Awaited<ReturnType<FreshBrain["connect"]>>;
  let exec: SchemaExecutor;

  beforeEach(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    writer = new Writer(pool);
    reader = new Reader(pool);
    owner = await brain.connect("owner");
    exec = new SchemaExecutor(owner);
  }, 120_000);

  afterEach(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  // #1 — required enforced beyond create
  it("edit cannot clear a required property to null", async () => {
    const t = await exec.defineType({ name: "person" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "bio", kind: "text", required: true }, SYSTEM);
    const o = await writer.write(WCTX, { type: "person", props: { bio: "hi" } });
    await expect(
      writer.edit(WCTX, o.id, { version: o.version, props: { bio: null } }),
    ).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("set_type demands required props, and accepts the promotion once they're supplied", async () => {
    const t = await exec.defineType({ name: "person" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "bio", kind: "text", required: true }, SYSTEM);
    const note = await writer.write(WCTX, { title: "note" });
    await expect(writer.setType(WCTX, note.id, "person")).rejects.toMatchObject({
      code: "validation",
    });
    const r = await writer.setType(WCTX, note.id, "person", { props: { bio: "hi" } });
    expect(r.to_type).toBe("person");
    expect(r.from_type).toBeNull();
  });

  // #2 — malformed filter value → clean validation, never internal
  it("a non-scalar / mistyped filter value is a validation error, not internal", async () => {
    const t = await exec.defineType({ name: "person" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "age", kind: "int" }, SYSTEM);
    await writer.write(WCTX, { type: "person", props: { age: 30 } });
    await expect(
      reader.list(RCTX, "person", { where: { field: "age", op: "eq", value: { a: 1 } } as never }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      reader.list(RCTX, "person", { where: { field: "age", op: "eq", value: true } }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  // #4 — history returns real revisions, and only for spine changes (no phantoms)
  it("history.versions is populated on spine edits, skipped on prop-only edits", async () => {
    const t = await exec.defineType({ name: "doc" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tag", kind: "text" }, SYSTEM);
    const o = await writer.write(WCTX, { type: "doc", title: "v1", body: "one" });
    const e1 = await writer.edit(WCTX, o.id, { version: o.version, title: "v2" }); // spine change → snapshot
    const e2 = await writer.edit(WCTX, o.id, {
      version: e1.version,
      bodyOps: [{ op: "set", text: "two" }],
    }); // spine change → snapshot
    await writer.edit(WCTX, o.id, { version: e2.version, props: { tag: "x" } }); // prop-only → NO snapshot
    const h = (await reader.history(RCTX, o.id)) as { versions: unknown[] };
    expect(h.versions.length).toBe(2); // two spine edits; the prop-only edit added no phantom
    expect(h.versions[0]).toMatchObject({ version: "2" }); // newest superseded version
  });

  // #5 — title is bounded
  it("an oversized title is rejected", async () => {
    await expect(writer.write(WCTX, { title: "x".repeat(4097) })).rejects.toMatchObject({
      code: "validation",
    });
  });

  // #6 — unknown body op fails loudly (not a silent no-op)
  it("an unknown body op is rejected, not a silent no-op", async () => {
    const o = await writer.write(WCTX, { title: "t", body: "b" });
    await expect(
      writer.edit(WCTX, o.id, { version: o.version, bodyOps: [{ op: "nuke" } as never] }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  // #8 — bool props reject non-booleans
  it("a boolean property rejects a bool-ish string", async () => {
    const t = await exec.defineType({ name: "flag" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "on", kind: "bool" }, SYSTEM);
    await expect(writer.write(WCTX, { type: "flag", props: { on: "yes" } })).rejects.toMatchObject({
      code: "validation",
    });
    // a real boolean still works
    const ok = await writer.write(WCTX, { type: "flag", props: { on: true } });
    expect(ok.version).toBe(1);
  });

  // #9 — enum value list is capped
  it("an enum with too many values is rejected", async () => {
    const t = await exec.defineType({ name: "thing" }, SYSTEM);
    const values = Array.from({ length: 101 }, (_, i) => `v${i}`);
    await expect(
      exec.addProperty(
        { typeId: t.typeId, name: "kind", kind: "enum", enumValues: values },
        SYSTEM,
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });
});
