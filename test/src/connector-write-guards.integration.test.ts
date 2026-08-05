import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, Writer, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Connector write groundwork (0021): `sources` stamps provenance on the row
 * (scoping the derived page is agent doctrine, not box enforcement), and
 * merge requires identical sharing so cross-audience content can never fold
 * into one page.
 */
describe("connector write groundwork (0021)", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let writer: Writer;
  let admin: Admin;

  let alice: string; // owner
  let bob: string; // member
  let carol: string; // member

  const wctx = (id: string): WriteContext => ({ actorId: id, scopes: ["read", "write"] });

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    writer = new Writer(pool);
    admin = new Admin(pool);

    alice = (await admin.bootstrapOwner({ name: "alice", email: "owner@example.com" })).id;
    bob = (
      await admin.createUser(alice, { name: "bob", email: "bob@example.com", permission: "member" })
    ).id;
    carol = (
      await admin.createUser(alice, {
        name: "carol",
        email: "carol@example.com",
        permission: "member",
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  /** Inspect a row as the table owner (bypasses RLS) — assertions only. */
  const inspect = async (id: string) => {
    const c = await brain.connect("owner");
    try {
      // Since 0039 (FORCE RLS) brain_owner no longer reads private objects by
      // ownership — become brain_system (BYPASSRLS) to inspect raw rows.
      await c.query("SET ROLE brain_system");
      const r = await c.query(
        "SELECT body, visibility, shared_with, source_refs FROM objects WHERE id = $1",
        [id],
      );
      return r.rows[0]!;
    } finally {
      await c.end();
    }
  };

  // ---- provenance ----------------------------------------------------------

  it("sources: [] is a normal write — no provenance stamped", async () => {
    const r = await writer.write(wctx(alice), { title: "normal", sources: [] });
    const row = await inspect(r.id);
    // "private" is the write default for human actors (tag governance wave 2)
    expect(row).toMatchObject({ visibility: "private", source_refs: null });
  });

  it("non-empty sources stamp source_refs; scoping stays exactly what the agent chose", async () => {
    const r = await writer.write(wctx(alice), {
      title: "from the contract",
      body: "derived",
      visibility: "private",
      sharedWith: [bob],
      sources: ["msgraph:doc1", "msgraph:doc2"],
    });
    const row = await inspect(r.id);
    expect(row.visibility).toBe("private");
    expect(row.shared_with).toEqual([bob]);
    expect(row.source_refs).toEqual(["msgraph:doc1", "msgraph:doc2"]);
  });

  it("sources without explicit scoping does not change write semantics (doctrine, not code)", async () => {
    const r = await writer.write(wctx(alice), { title: "cited", sources: ["msgraph:doc1"] });
    const row = await inspect(r.id);
    // default unchanged by sources — the prompt carries the scoping rule. The
    // default itself is now "private" (tag governance wave 2), which happens to
    // match the connector-derived-content doctrine.
    expect(row.visibility).toBe("private");
    expect(row.source_refs).toEqual(["msgraph:doc1"]);
  });

  // ---- merge scope-identity ------------------------------------------------

  it("merge refuses different visibility and different share lists", async () => {
    const org = await writer.write(wctx(alice), { title: "org one", visibility: "org" });
    const priv = await writer.write(wctx(alice), { title: "priv one", visibility: "private" });
    await expect(writer.merge(wctx(alice), priv.id, org.id)).rejects.toMatchObject({
      code: "refused",
    });

    const withBob = await writer.write(wctx(alice), {
      title: "bob circle",
      visibility: "private",
      sharedWith: [bob],
    });
    const withCarol = await writer.write(wctx(alice), {
      title: "carol circle",
      visibility: "private",
      sharedWith: [carol],
    });
    await expect(writer.merge(wctx(alice), withBob.id, withCarol.id)).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("merge allows identical sharing (same visibility, same share list)", async () => {
    const a = await writer.write(wctx(alice), {
      title: "frag a",
      body: "a",
      visibility: "private",
      sharedWith: [bob],
    });
    const b = await writer.write(wctx(alice), {
      title: "frag b",
      body: "b",
      visibility: "private",
      sharedWith: [bob],
    });
    await writer.merge(wctx(alice), a.id, b.id);
    const row = await inspect(b.id);
    expect(row.body).toContain("a");
    expect(row.body).toContain("b");
  });

  it("org objects with residual shared_with still merge (shared_with is dead state on org)", async () => {
    const residual = await writer.write(wctx(alice), {
      title: "was private once",
      body: "r",
      visibility: "private",
      sharedWith: [bob],
    });
    await writer.edit(wctx(alice), residual.id, { version: residual.version, visibility: "org" }); // shared_with stays [bob]
    const plainOrg = await writer.write(wctx(alice), {
      title: "always org",
      body: "p",
      visibility: "org",
    });
    await writer.merge(wctx(alice), residual.id, plainOrg.id);
    const row = await inspect(plainOrg.id);
    expect(row.body).toContain("r");
  });

  it("a merged loser keeps its provenance on the tombstone", async () => {
    const a = await writer.write(wctx(alice), {
      title: "cited frag",
      body: "x",
      sources: ["msgraph:doc9"],
    });
    const b = await writer.write(wctx(alice), { title: "plain frag", body: "y" });
    await writer.merge(wctx(alice), a.id, b.id);
    const loser = await inspect(a.id);
    expect(loser.source_refs).toEqual(["msgraph:doc9"]); // still queryable
  });
});
