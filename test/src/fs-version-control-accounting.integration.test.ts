import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, FsStore, type FsCtx } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Version control vs the LIVE quota. The snapshot log and the live tree
 * are two different budgets on purpose: `fs_usage.total_bytes` is the quota the
 * member sees and every write checks, while `fs_versions` is bounded separately
 * by FS_VERSION_KEEP_PER_PATH + FS_VERSION_BUDGET_BYTES. Confusing them is the
 * whole failure class this file pins:
 *
 *  - if snapshot bytes were charged to fs_usage, ordinary editing would fill a
 *    member's disk out from under them and the LIVE write would start failing
 *    ENOSPC for bytes they never asked to keep;
 *  - if a quota-rejected write left its snapshot behind, the history would grow
 *    a revision of bytes that were never replaced — accounting that lies;
 *  - if any version-control op (rm-to-trash, restore, a clobbering rename)
 *    forgot to adjust fs_usage, the counter would drift off the real byte sum
 *    until a false ENOSPC locked a member out of a brain with free space.
 *
 * The eviction/retention bounds themselves live in fs-store.integration.test.ts;
 * this file only owns the seam between the two budgets.
 */
describe("fs version control · the snapshot log never spends the live quota", () => {
  let brain: FreshBrain;
  let adminPool: Pool;
  let fsPool: Pool;
  let store: FsStore;

  let alice: string;

  const ctx = (actorId: string, extra: Partial<FsCtx> = {}): FsCtx => ({ actorId, ...extra });

  /** The live counter every write checks. */
  const usage = async (): Promise<number> => {
    const r = await fsPool.query<{ total_bytes: string }>("SELECT total_bytes FROM fs_usage");
    return Number(r.rows[0]!.total_bytes);
  };

  /**
   * The TRUE byte sums, read as superuser (BYPASSRLS): fs_entries and
   * fs_versions are both FORCE-RLS, so an app-role read of either would see
   * shared rows only and could not prove a brain-wide accounting identity.
   */
  const trueSums = async (): Promise<{ live: number; versions: number }> => {
    const su = await brain.connect("superuser");
    try {
      const r = await su.query<{ live: string; versions: string }>(
        `SELECT (SELECT coalesce(sum(size_bytes), 0)::text
                   FROM fs_entries WHERE kind = 'file') AS live,
                (SELECT coalesce(sum(size_bytes), 0)::text FROM fs_versions) AS versions`,
      );
      return { live: Number(r.rows[0]!.live), versions: Number(r.rows[0]!.versions) };
    } finally {
      await su.end();
    }
  };

  const truncateVersions = async (): Promise<void> => {
    const su = await brain.connect("superuser");
    try {
      await su.query("TRUNCATE fs_versions");
    } finally {
      await su.end();
    }
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    adminPool = new Pool(brain.appConfig);
    fsPool = new Pool({ ...brain.appConfig, max: 4 });
    store = new FsStore(fsPool);

    const admin = new Admin(adminPool);
    alice = (await admin.bootstrapOwner({ name: "alice", email: "alice@example.com" })).id;
  }, 120_000);

  afterAll(async () => {
    await fsPool?.end();
    await adminPool?.end();
    await brain?.drop();
  });

  it("history bytes are never charged to fs_usage — editing cannot ENOSPC a member out", async () => {
    await truncateVersions();
    const base = await usage();
    // Headroom for ONE live copy of the file and nothing more. If snapshots were
    // charged to the same counter, the second overwrite would already be ENOSPC.
    const body = (tag: string): Buffer => Buffer.from(tag.repeat(5_000)); // 10 KiB, versionable
    const headroom = 15_000;
    const tight = new FsStore(fsPool, { quotaBytes: base + headroom });
    const p = "/shared/acct/edit.md";

    for (const tag of ["ab", "cd", "ef", "gh", "ij", "kl", "mn", "op"]) {
      await tight.write(ctx(alice), p, body(tag), "text/markdown");
    }

    // Eight writes ⇒ seven snapshots ⇒ ~70 KiB of history, far past the 15 KiB of
    // quota headroom — yet every write succeeded and the counter only ever held
    // the one live copy.
    const hist = await tight.history(ctx(alice), p);
    expect(hist.length).toBe(7);
    const sums = await trueSums();
    expect(sums.versions).toBeGreaterThan(headroom);
    expect(await usage()).toBe(base + 10_000);
    expect((await tight.read(ctx(alice), p)).bytes.toString()).toBe(body("op").toString());
  });

  it("a write the quota rejects leaves NO snapshot behind — the log records only real replacements", async () => {
    const p = "/shared/acct/rejected.md";
    await store.write(ctx(alice), p, Buffer.from("v1\n"), "text/markdown");
    await store.write(ctx(alice), p, Buffer.from("v2\n"), "text/markdown");
    const before = await store.history(ctx(alice), p);
    expect(before.length).toBe(1); // the v1 snapshot

    // snapshotIfVersionable() runs BEFORE bumpUsage() inside one transaction, so
    // the ENOSPC rollback has to take the snapshot with it. A snapshot that
    // survived would claim v2 was replaced when it never was.
    const tight = new FsStore(fsPool, { quotaBytes: (await usage()) + 5 });
    await expect(
      tight.write(ctx(alice), p, Buffer.from("x".repeat(5_000)), "text/markdown"),
    ).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("ENOSPC") });

    const after = await store.history(ctx(alice), p);
    expect(after.length).toBe(before.length);
    expect(after.map((v) => v.content.toString())).toEqual(before.map((v) => v.content.toString()));
    expect((await store.read(ctx(alice), p)).bytes.toString()).toBe("v2\n");
  });

  it("fs_usage still equals the live byte sum after an overwrite/rm/restore/clobber churn", async () => {
    // Every version-control op moves bytes into or out of the live tree, and
    // each has its own usage adjustment: rm sends bytes to the trash (usage
    // DOWN), restore brings them back (usage UP), a clobbering rename destroys
    // the destination (usage DOWN by the destination) while moving the source.
    // A single missed adjustment drifts the counter and eventually fires a false
    // ENOSPC on a brain with free space, so the identity is asserted at the end.
    const d = "/shared/acct/churn";
    await store.write(ctx(alice), `${d}/a.md`, Buffer.from("aaaa\n"), "text/markdown");
    await store.write(ctx(alice), `${d}/a.md`, Buffer.from("aaaaaaaa\n"), "text/markdown");
    await store.write(ctx(alice), `${d}/b.md`, Buffer.from("bb\n"), "text/markdown");
    await store.write(ctx(alice), `${d}/c.bin`, Buffer.from([0x00, 0xff, 0x10, 0x00]));

    // delete → trash, then bring it back from the trash
    await store.rm(ctx(alice), `${d}/b.md`);
    expect(await store.exists(ctx(alice), `${d}/b.md`)).toBe(false);
    await store.restore(ctx(alice), `${d}/b.md`);
    expect((await store.read(ctx(alice), `${d}/b.md`)).bytes.toString()).toBe("bb\n");

    // roll a.md back a version (the live bytes shrink), then clobber c.bin by
    // renaming a.md onto it (destination bytes leave the tree entirely)
    const aHist = await store.versionList(ctx(alice), `${d}/a.md`);
    await store.restore(ctx(alice), `${d}/a.md`, aHist[0]!.version_no);
    await store.rename(ctx(alice), `${d}/a.md`, `${d}/c.bin`);
    expect(await store.exists(ctx(alice), `${d}/a.md`)).toBe(false);

    // recursive rm of the whole directory, then a fresh file in its place
    await store.rm(ctx(alice), d, true);
    await store.write(ctx(alice), `${d}/fresh.md`, Buffer.from("fresh\n"), "text/markdown");

    const sums = await trueSums();
    expect(await usage()).toBe(sums.live);
    // …and neither side is trivially zero: the identity has to be proven over a
    // tree that still holds bytes and a log that really was written to.
    expect(sums.live).toBeGreaterThan(0);
    expect(sums.versions).toBeGreaterThan(0);
  });
});
