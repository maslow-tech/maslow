import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { Admin, Reader, Writer, type ReadContext, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Private visibility (migration 0012): RLS keeps private objects invisible to
 * everyone but their creator + shared_with, across every read surface — get,
 * search, history snapshots, backlinks — and the write path enforces
 * creator-only control of visibility/sharing.
 */
describe("private visibility (RLS, 0012)", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let reader: Reader;
  let writer: Writer;
  let admin: Admin;

  let alice: string; // owner
  let bob: string; // member
  let carol: string; // member
  let secretId: string; // alice's private note
  let orgId: string; // an org-visible note

  const rctx = (id: string): ReadContext => ({ actorId: id });
  const wctx = (id: string): WriteContext => ({ actorId: id, scopes: ["read", "write"] });

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    reader = new Reader(pool);
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

    // wave-2 default-private: an omitted visibility now means private, so an
    // org-visible fixture must be published explicitly.
    orgId = (
      await writer.write(wctx(alice), {
        title: "Alice",
        body: "org-visible person",
        visibility: "org",
      })
    ).id;
    secretId = (
      await writer.write(wctx(alice), {
        title: "comp thoughts",
        body: "zephyrite salary band notes",
        visibility: "private",
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("creator sees a private object; others get not-found", async () => {
    const mine = await reader.get(rctx(alice), secretId);
    expect(mine.visibility).toBe("private");
    await expect(reader.get(rctx(bob), secretId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("private content is invisible to search for others", async () => {
    const forAlice = await reader.search(rctx(alice), "zephyrite");
    expect(forAlice.length).toBe(1);
    const forBob = await reader.search(rctx(bob), "zephyrite");
    expect(forBob.length).toBe(0);
  });

  it("every account got a personal page only they can see", async () => {
    const bobs = await reader.search(rctx(bob), "personal", { limit: 200 });
    expect(bobs.some((r) => r.title === "bob — personal")).toBe(true);
    expect(bobs.some((r) => r.title === "carol — personal")).toBe(false);
    const alices = await reader.search(rctx(alice), "personal", { limit: 200 });
    expect(alices.some((r) => r.title === "alice — personal")).toBe(true);
    expect(alices.some((r) => r.title === "bob — personal")).toBe(false);
  });

  it("edges to a private object are invisible to others (backlinks + link refusal)", async () => {
    await writer.link(wctx(alice), secretId, "about", orgId);
    const forAlice = await reader.get(rctx(alice), orgId);
    expect((forAlice.backlinks as Array<{ id: string }>).some((b) => b.id === secretId)).toBe(true);
    const forBob = await reader.get(rctx(bob), orgId);
    expect((forBob.backlinks as Array<{ id: string }>).some((b) => b.id === secretId)).toBe(false);
    // bob cannot even create a link toward the private object
    await expect(writer.link(wctx(bob), orgId, "refs", secretId)).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("history snapshots of a private object are invisible to others", async () => {
    const v = (await reader.get(rctx(alice), secretId)).version as number;
    await writer.edit(wctx(alice), secretId, {
      version: v,
      bodyOps: [{ op: "set", text: "revised" }],
    });
    const mine = await reader.history(rctx(alice), secretId);
    expect((mine.versions as unknown[]).length).toBeGreaterThan(0);
    const theirs = await reader.history(rctx(bob), secretId);
    expect((theirs.versions as unknown[]).length).toBe(0);
  });

  it("shared_with grants visibility to exactly those accounts", async () => {
    const v = (await reader.get(rctx(alice), secretId)).version as number;
    await writer.edit(wctx(alice), secretId, { version: v, sharedWith: [bob] });
    const forBob = await reader.get(rctx(bob), secretId);
    expect(forBob.title).toBe("comp thoughts");
    await expect(reader.get(rctx(carol), secretId)).rejects.toMatchObject({ code: "not_found" });
    const hits = await reader.search(rctx(bob), "comp thoughts");
    // graph augmentation may append VISIBLE connected objects (the org page
    // alice linked earlier) — the word match stays first, and exactly one
    // object matched by words. Nothing invisible may ride along either way.
    expect(hits[0]!.title).toBe("comp thoughts");
    expect(hits.filter((h) => h.match !== "graph")).toHaveLength(1);
    const carolHits = await reader.search(rctx(carol), "comp thoughts");
    expect(carolHits.some((h) => h.title === "comp thoughts")).toBe(false);
  });

  it("only the creator may change visibility or sharing", async () => {
    // bob can read (shared) but cannot widen sharing or flip visibility
    await expect(writer.edit(wctx(bob), secretId, { sharedWith: [bob, carol] })).rejects.toThrow(
      /only the creator/,
    );
    await expect(writer.edit(wctx(bob), secretId, { visibility: "org" })).rejects.toThrow(
      /only the creator/,
    );
    // and bob cannot privatize someone else's org object
    await expect(writer.edit(wctx(bob), orgId, { visibility: "private" })).rejects.toThrow(
      /only the creator/,
    );
  });

  it("rejects sharing with an unknown account", async () => {
    await expect(
      writer.write(wctx(alice), {
        title: "x",
        visibility: "private",
        sharedWith: ["00000000-0000-0000-0000-00000000dead"],
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("the creator can flip their own object org <-> private (default is private)", async () => {
    const created = await writer.write(wctx(bob), { title: "bob flip note" });
    const id = created.id;
    // wave-2 default-private: an omitted visibility means only bob can see it
    expect((await reader.get(rctx(bob), id)).visibility).toBe("private");
    await expect(reader.get(rctx(alice), id)).rejects.toMatchObject({ code: "not_found" });
    const e = await writer.edit(wctx(bob), id, { version: created.version, visibility: "org" });
    const back = await reader.get(rctx(alice), id);
    expect(back.visibility).toBe("org");
    await writer.edit(wctx(bob), id, { version: e.version, visibility: "private" });
    await expect(reader.get(rctx(alice), id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("a shared reader cannot delete or restore the creator's private object", async () => {
    const { id } = await writer.write(wctx(alice), {
      title: "shared but mine",
      visibility: "private",
      sharedWith: [bob],
    });
    await expect(writer.softDelete(wctx(bob), id)).rejects.toMatchObject({ code: "not_found" });
    await writer.softDelete(wctx(alice), id); // creator can
    await expect(writer.restore(wctx(bob), id)).rejects.toMatchObject({ code: "not_found" });
    await writer.restore(wctx(alice), id);
  });

  it("a shared reader cannot merge a private object into an org one (would publish it)", async () => {
    const priv = await writer.write(wctx(alice), {
      title: "private loser",
      body: "confidential",
      visibility: "private",
      sharedWith: [bob],
    });
    // explicit publish — wave-2 default-private would otherwise make this bob-only
    const org = await writer.write(wctx(bob), { title: "org winner", visibility: "org" });
    // the 0019 scope-identity guard fires first: private→org is never identical sharing
    await expect(writer.merge(wctx(bob), priv.id, org.id)).rejects.toThrow(/identical sharing/);
  });

  it("a shared reader cannot merge two private objects even with identical sharing (creator only)", async () => {
    const a = await writer.write(wctx(alice), {
      title: "alice private a",
      visibility: "private",
      sharedWith: [bob],
    });
    const b = await writer.write(wctx(alice), {
      title: "alice private b",
      visibility: "private",
      sharedWith: [bob],
    });
    await expect(writer.merge(wctx(bob), a.id, b.id)).rejects.toThrow(/only the creator/);
  });

  it("merge is refused while links hidden inside private objects still point at the loser", async () => {
    // the dup pair must be org-visible (alice links to x; wave-2 default is private)
    const x = await writer.write(wctx(bob), { title: "dup x", visibility: "org" });
    const y = await writer.write(wctx(bob), { title: "dup y", visibility: "org" });
    const hidden = await writer.write(wctx(alice), {
      title: "alice private referrer",
      visibility: "private",
    });
    await writer.link(wctx(alice), hidden.id, "mentions", x.id);

    // bob sees no backlinks but get's census tells him one is hidden
    const refs = (await reader.get(rctx(bob), x.id)) as {
      backlinks: unknown[];
      hidden_from_you: number;
    };
    expect(refs.backlinks.length).toBe(0);
    expect(refs.hidden_from_you).toBe(1);

    await expect(writer.merge(wctx(bob), x.id, y.id)).rejects.toThrow(/cannot see/);
    // the creator of the hidden link CAN do the merge (all edges visible)
    await writer.merge(wctx(alice), x.id, y.id);
  });

  it("set_type cannot touch (or probe) someone else's private object", async () => {
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    try {
      await exec.defineType({ name: "tag" }, alice);
      const priv = await writer.write(wctx(alice), {
        title: "untyped private",
        visibility: "private",
      });
      await expect(writer.setType(wctx(bob), priv.id, "tag")).rejects.toMatchObject({
        code: "not_found",
      });
      await writer.setType(wctx(alice), priv.id, "tag"); // creator may promote
    } finally {
      await owner.end();
    }
  });

  it("list visibility:'private' surfaces my private objects and nobody else's", async () => {
    const mine = await reader.listPrivate(rctx(alice), "private");
    const ids = mine.map((r) => r.id);
    expect(ids).toContain(secretId);
    expect(ids).not.toContain(orgId); // org-visible
    expect(mine.every((r) => r.created_by === alice)).toBe(true);
    // bob's own private listing never shows alice's secret
    const bobs = await reader.listPrivate(rctx(bob), "private");
    expect(bobs.map((r) => r.id)).not.toContain(secretId);
  });

  it("list visibility:'shared_with_me' surfaces exactly what others shared with me", async () => {
    // secretId was shared with bob earlier in the suite
    const forBob = await reader.listPrivate(rctx(bob), "shared_with_me");
    expect(forBob.map((r) => r.id)).toContain(secretId);
    expect(forBob.every((r) => r.created_by !== bob)).toBe(true);
    // carol was never shared on it
    const forCarol = await reader.listPrivate(rctx(carol), "shared_with_me");
    expect(forCarol.map((r) => r.id)).not.toContain(secretId);
  });

  it("typed list + count accept the visibility filter", async () => {
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    try {
      await exec.defineType({ name: "memo" }, alice);
      const priv = await writer.write(wctx(alice), {
        type: "memo",
        title: "private memo",
        visibility: "private",
        sharedWith: [bob],
      });
      // explicit publish (wave-2 default-private) — the filter test needs a real org memo
      await writer.write(wctx(alice), { type: "memo", title: "org memo", visibility: "org" });

      const mine = await reader.list(rctx(alice), "memo", { visibility: "private" });
      expect(mine.items.map((r) => r.id)).toEqual([priv.id]);
      expect(await reader.count(rctx(alice), "memo", { visibility: "private" })).toBe(1);

      const sharedToBob = await reader.list(rctx(bob), "memo", { visibility: "shared_with_me" });
      expect(sharedToBob.items.map((r) => r.id)).toEqual([priv.id]);
      // carol can't see it at all, filtered or not
      const sharedToCarol = await reader.list(rctx(carol), "memo", {
        visibility: "shared_with_me",
      });
      expect(sharedToCarol.items).toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it("shared_with is disclosed only to the creator", async () => {
    const { id } = await writer.write(wctx(alice), {
      title: "who knows",
      visibility: "private",
      sharedWith: [bob, carol],
    });
    const mine = await reader.get(rctx(alice), id);
    expect((mine.shared_with as string[]).sort()).toEqual([bob, carol].sort());
    const bobs = await reader.get(rctx(bob), id);
    expect(bobs.shared_with).toBeUndefined();
  });
});
