import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, FsStore, type FsCtx } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Filesystem version control + locks — the SECURITY half (migration 0043;
 * design 2026-07-21). 0043 adds two new surfaces that can leak or be bypassed:
 *
 *  - `fs_versions` (snapshots of prior + deleted bytes) is a SECOND copy of file
 *    content. If its RLS is weaker than fs_entries', a member reads another
 *    member's private home history — the same content, through a new door.
 *  - a LOCK is a write-refusal flag; it is only as good as its weakest mutation
 *    path, so every mutator must consult it (including via an ancestor).
 *
 * These are regression tests for the boundary itself, kept deliberately blunt:
 * bob must never observe alice's home content, existence, or lock state.
 */
describe("fs version control · privacy + lock enforcement", () => {
  let brain: FreshBrain;
  let adminPool: Pool;
  let fsPool: Pool;
  let store: FsStore;

  let alice: string; // owner  → /home/alice
  let bob: string; // member → /home/bob

  const ctx = (actorId: string, extra: Partial<FsCtx> = {}): FsCtx => ({ actorId, ...extra });

  beforeAll(async () => {
    brain = await createFreshBrain();
    adminPool = new Pool(brain.appConfig);
    fsPool = new Pool({ ...brain.appConfig, max: 4 });
    store = new FsStore(fsPool);

    const admin = new Admin(adminPool);
    alice = (await admin.bootstrapOwner({ name: "alice", email: "alice@example.com" })).id;
    bob = (
      await admin.createUser(alice, { name: "bob", email: "bob@example.com", permission: "member" })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await fsPool?.end();
    await adminPool?.end();
    await brain?.drop();
  });

  // ---- privacy: fs_versions must not become a second read path -------------

  it("a foreign home's version history, trash and lock state are all invisible", async () => {
    const secret = "/home/alice/private/diary.md";
    await store.write(ctx(alice), secret, Buffer.from("v1 confession\n"), "text/markdown");
    await store.write(ctx(alice), secret, Buffer.from("v2 confession\n"), "text/markdown");

    // alice sees her own history (the feature works for its owner)
    const mine = await store.history(ctx(alice), secret);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((h) => h.content.toString().includes("v1 confession"))).toBe(true);

    // bob sees NOTHING of it — no rows, no bytes, no lock state, no oracle
    expect(await store.history(ctx(bob), secret)).toEqual([]);
    await expect(store.versionContent(ctx(bob), secret, mine[0]!.version_no)).rejects.toThrow();
    expect(await store.lockInfo(ctx(bob), secret)).toBeNull();

    // and bob cannot resurrect it through restore
    await expect(store.restore(ctx(bob), secret)).rejects.toThrow();
    expect((await store.read(ctx(alice), secret)).bytes.toString()).toBe("v2 confession\n");
  });

  it("a deleted foreign home file never appears in another member's trash", async () => {
    const gone = "/home/alice/private/gone.md";
    await store.write(ctx(alice), gone, Buffer.from("erase me\n"), "text/markdown");
    await store.rm(ctx(alice), gone);

    // alice can find + restore it
    expect((await store.listTrash(ctx(alice))).map((t) => t.path)).toContain(gone);

    // bob's whole-tree trash must not enumerate it (path is itself a leak)
    expect((await store.listTrash(ctx(bob))).map((t) => t.path)).not.toContain(gone);
    // …nor via an explicitly targeted prefix
    expect((await store.listTrash(ctx(bob), "/home/alice")).map((t) => t.path)).not.toContain(gone);

    await store.restore(ctx(alice), gone);
    expect((await store.read(ctx(alice), gone)).bytes.toString()).toBe("erase me\n");
  });

  it("shared history IS visible to every member (the feature still works)", async () => {
    const doc = "/shared/team/plan.md";
    await store.write(ctx(alice), doc, Buffer.from("draft one\n"), "text/markdown");
    await store.write(ctx(alice), doc, Buffer.from("draft two\n"), "text/markdown");

    const seen = await store.history(ctx(bob), doc);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((h) => h.content.toString().includes("draft one"))).toBe(true);
  });

  // ---- locks: every mutation path must consult the flag --------------------

  it("a locked file refuses every mutation but still reads", async () => {
    const p = "/shared/canon/thesis.md";
    await store.write(ctx(alice), p, Buffer.from("truth\n"), "text/markdown");
    await store.lock(ctx(alice), p);

    const unchanged = async (): Promise<void> => {
      expect((await store.read(ctx(bob), p)).bytes.toString()).toBe("truth\n");
    };

    await expect(store.write(ctx(bob), p, Buffer.from("slop\n"))).rejects.toThrow(/ELOCKED/);
    await unchanged();
    await expect(store.append(ctx(bob), p, Buffer.from("more\n"))).rejects.toThrow(/ELOCKED/);
    await unchanged();
    await expect(store.rm(ctx(bob), p)).rejects.toThrow(/ELOCKED/);
    await unchanged();
    await expect(store.rename(ctx(bob), p, "/shared/canon/moved.md")).rejects.toThrow(/ELOCKED/);
    await unchanged();
    await expect(store.restore(ctx(bob), p)).rejects.toThrow(/ELOCKED/);
    await unchanged();

    // reads were never affected — proven by `unchanged()` above
    expect(await store.lockInfo(ctx(bob), p)).toMatchObject({ lockedByName: "alice" });
  });

  it("renaming ONTO a locked path cannot clobber it", async () => {
    const target = "/shared/canon/protected.md";
    const src = "/shared/scratch/attacker.md";
    await store.write(ctx(alice), target, Buffer.from("keep\n"), "text/markdown");
    await store.write(ctx(bob), src, Buffer.from("evil\n"), "text/markdown");
    await store.lock(ctx(alice), target);

    await expect(store.rename(ctx(bob), src, target)).rejects.toThrow(/ELOCKED/);
    expect((await store.read(ctx(alice), target)).bytes.toString()).toBe("keep\n");
  });

  it("a locked DIRECTORY protects its whole subtree", async () => {
    const dir = "/shared/sealed";
    const child = "/shared/sealed/deep/note.md";
    await store.write(ctx(alice), child, Buffer.from("inside\n"), "text/markdown");
    await store.lock(ctx(alice), dir);

    await expect(store.write(ctx(bob), child, Buffer.from("x\n"))).rejects.toThrow(/ELOCKED/);
    await expect(
      store.write(ctx(bob), "/shared/sealed/deep/new.md", Buffer.from("x\n")),
    ).rejects.toThrow(/ELOCKED/);
    expect((await store.read(ctx(bob), child)).bytes.toString()).toBe("inside\n");
  });

  it("only the locker or an owner can unlock", async () => {
    const p = "/shared/canon/owned.md";
    await store.write(ctx(alice), p, Buffer.from("x\n"), "text/markdown");
    await store.lock(ctx(bob), p); // bob locks it

    // alice is an OWNER → may force-unlock (isOwner comes from the DB role,
    // never from a caller-supplied claim)
    await store.unlock(ctx(alice, { isOwner: true }), p);
    expect(await store.lockInfo(ctx(alice), p)).toBeNull();

    // re-lock as alice; bob (a plain member, not the locker) must not steal it
    await store.lock(ctx(alice), p);
    await expect(store.unlock(ctx(bob), p)).rejects.toThrow();
    expect(await store.lockInfo(ctx(bob), p)).not.toBeNull();
  });
});
