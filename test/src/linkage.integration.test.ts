import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };
const RCTX: ReadContext = { actorId: SYSTEM };

describe("linkage (ref↔edge, link/unlink)", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let writer: Writer;
  let reader: Reader;

  beforeEach(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    writer = new Writer(pool);
    reader = new Reader(pool);
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    await exec.defineType({ name: "client" }, SYSTEM);
    const deal = await exec.defineType({ name: "deal" }, SYSTEM);
    await exec.addProperty(
      { typeId: deal.typeId, name: "account", kind: "ref", refTypeName: "client" },
      SYSTEM,
    );
    await owner.end();
  }, 120_000);

  afterEach(async () => {
    await pool?.end();
    await brain?.drop();
  });

  async function edgeCount(): Promise<number> {
    const owner = await brain.connect("owner");
    try {
      // Since 0057 a bare brain_owner connection holds no tags and sees no
      // objects (and therefore no edges — their policy is EXISTS-on-objects);
      // this is a verification read, so use the txn-local DR escape.
      await owner.query("BEGIN READ ONLY");
      await owner.query("SET LOCAL app.fs_dr = 'on'");
      const r = await owner.query<{ n: string }>("SELECT count(*)::text AS n FROM edges");
      await owner.query("COMMIT");
      return Number(r.rows[0]!.n);
    } finally {
      await owner.end();
    }
  }

  it("D.2: setting a ref column materializes a mirror edge; clearing removes it", async () => {
    const c1 = await writer.write(WCTX, { type: "client", title: "Acme" });
    const d = await writer.write(WCTX, { type: "deal", title: "Q1", props: { account: c1.id } });

    // the mirror edge exists as a backlink on the client
    const nb = await reader.neighbors(RCTX, c1.id, { direction: "in" });
    expect(nb.some((e) => e.id === d.id && e.rel === "account")).toBe(true);

    // clearing the ref removes the edge
    await writer.edit(WCTX, d.id, { version: d.version, props: { account: null } });
    const nb2 = await reader.neighbors(RCTX, c1.id, { direction: "in" });
    expect(nb2.length).toBe(0);
  });

  it("D.2 guard: a manual attempt to create/delete a ref:% edge is refused", async () => {
    const c1 = await writer.write(WCTX, { type: "client" });
    const d = await writer.write(WCTX, { type: "deal", props: { account: c1.id } });
    const owner = await brain.connect("owner");
    try {
      // Since 0057 a bare brain_owner connection sees no edges rows (RLS would
      // make the DELETE silently match nothing, never reaching the guard), so
      // each forgery attempt runs under the txn-local DR escape — the guard
      // trigger must refuse even the most privileged application role.
      await owner.query("BEGIN");
      await owner.query("SET LOCAL app.fs_dr = 'on'");
      // even the owner can't forge a ref edge directly
      await expect(
        owner.query(
          "INSERT INTO edges (from_id, rel, to_id, provenance) VALUES ($1,'account',$2,'ref:account')",
          [d.id, c1.id],
        ),
      ).rejects.toThrow(/managed by the ref column/i);
      await owner.query("ROLLBACK");
      await owner.query("BEGIN");
      await owner.query("SET LOCAL app.fs_dr = 'on'");
      await expect(
        owner.query("DELETE FROM edges WHERE from_id=$1 AND provenance LIKE 'ref:%'", [d.id]),
      ).rejects.toThrow(/managed by the ref column/i);
      await owner.query("ROLLBACK");
    } finally {
      await owner.end();
    }
  });

  it("D.8: a ref to a soft-deleted target is refused", async () => {
    const c1 = await writer.write(WCTX, { type: "client" });
    await writer.softDelete(WCTX, c1.id);
    await expect(
      writer.write(WCTX, { type: "deal", props: { account: c1.id } }),
    ).rejects.toBeTruthy();
  });

  it("link/unlink manages 'manual' edges and rejects self-loops + dead endpoints", async () => {
    const a = await writer.write(WCTX, { title: "a" });
    const b = await writer.write(WCTX, { title: "b" });
    const before = await edgeCount();

    await writer.link(WCTX, a.id, "relates_to", b.id);
    expect(await edgeCount()).toBe(before + 1);
    const nb = await reader.neighbors(RCTX, a.id, { direction: "out", rel: "relates_to" });
    expect(nb.map((e) => e.id)).toContain(b.id);

    // idempotent link
    await writer.link(WCTX, a.id, "relates_to", b.id);
    expect(await edgeCount()).toBe(before + 1);

    const un = await writer.unlink(WCTX, a.id, "relates_to", b.id);
    expect(un.removed).toBe(true);
    expect(await edgeCount()).toBe(before);

    await expect(writer.link(WCTX, a.id, "x", a.id)).rejects.toMatchObject({ code: "validation" });
    await writer.softDelete(WCTX, b.id);
    await expect(writer.link(WCTX, a.id, "relates_to", b.id)).rejects.toMatchObject({
      code: "refused",
    });
    await expect(writer.link(WCTX, a.id, "BAD REL", b.id)).rejects.toMatchObject({
      code: "validation",
    });
  });
});
