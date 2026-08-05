import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, FsStore, type FsCtx } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * ADVERSARIAL second pass over the filesystem's version-control surface
 * (migrations 0043 fs_versions + locks, 0045 the elevated reaper, 0046 the
 * on_behalf_of narrowing, 0047 the unique pair, 0048 fs_version_seq).
 *
 * The premise: `fs_versions` is a SECOND COPY of file bytes and
 * `fs_version_seq` is a THIRD surface that holds PATHS. fs_entries' RLS was
 * argued for line by line; anything newer that is even slightly weaker is a
 * new door onto the same private home. 0046 already fixed one such hole (the
 * dropped obo conjunct), so this file assumes there are more and goes looking
 * for them: content oracles, EXISTENCE oracles (an error that differs between
 * "exists but forbidden" and "absent" is a leak), metadata oracles, trash
 * enumeration, LIKE-metacharacter smuggling, direct calls to the SECURITY
 * DEFINER helpers, and eviction used as a weapon.
 *
 * Everything here is `bob` (a plain member) against `alice`'s private home,
 * except the last block, which checks the DB-privilege layer directly.
 *
 * Where a probe FOUND something, the test asserts the observed behaviour and
 * says so in a FINDING comment, so the reproduction is executable and the
 * suite still tells the truth about what the code does today.
 */
describe("fs version control · adversarial privacy pass 2", () => {
  let brain: FreshBrain;
  let adminPool: Pool;
  let fsPool: Pool;
  let store: FsStore;

  let alice: string; // owner  → /home/alice
  let bob: string; // member → /home/bob

  const ctx = (actorId: string, extra: Partial<FsCtx> = {}): FsCtx => ({ actorId, ...extra });

  /** Ground truth, read as superuser (both fs tables are FORCE RLS). */
  const asSuper = async <T>(fn: (c: import("pg").Client) => Promise<T>): Promise<T> => {
    const su = await brain.connect("superuser");
    try {
      return await fn(su);
    } finally {
      await su.end();
    }
  };

  const message = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "<<no error>>";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

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

  // ---------------------------------------------------------------- content

  it("every read surface of a foreign home answers empty/ENOENT — no bytes, no rows", async () => {
    const secret = "/home/alice/vault/keys.md";
    await store.write(ctx(alice), secret, Buffer.from("k1 aaaa\n"), "text/markdown");
    await store.write(ctx(alice), secret, Buffer.from("k2 bbbb\n"), "text/markdown");
    await store.write(ctx(alice), secret, Buffer.from("k3 cccc\n"), "text/markdown");

    // alice's own view is populated (the feature works)
    expect((await store.versionList(ctx(alice), secret)).length).toBeGreaterThan(0);

    // bob: every surface, including the ones that carry bytes
    expect(await store.history(ctx(bob), secret)).toEqual([]);
    expect(await store.versionList(ctx(bob), secret)).toEqual([]);
    expect(await store.listTrash(ctx(bob), secret)).toEqual([]);
    expect(await store.lockInfo(ctx(bob), secret)).toBeNull();
    expect((await store.lockInfoMany(ctx(bob), [secret])).size).toBe(0);
    expect(await store.versionSkipReason(ctx(bob), secret)).toBeNull();
    expect(await store.exists(ctx(bob), secret)).toBe(false);
    for (const v of [1, 2, 3, 4]) {
      await expect(store.versionContent(ctx(bob), secret, v)).rejects.toThrow(/ENOENT|no version/);
    }
    // …and no mutation path lets him touch it either
    await expect(store.restore(ctx(bob), secret)).rejects.toThrow();
    await expect(store.restore(ctx(bob), secret, 1)).rejects.toThrow();
    await expect(store.lock(ctx(bob), secret)).rejects.toThrow();
    await expect(store.unlock(ctx(bob), secret)).rejects.toThrow();
  });

  // -------------------------------------------------- EXISTENCE ORACLE (FINDING)

  it("REGRESSION: the evicted-vs-never-existed wording is NOT an oracle across homes", async () => {
    // brain_fs_version_floor (0048) is SECURITY DEFINER owned by brain_system,
    // so it reads fs_version_seq with RLS BYPASSED, for any path the caller
    // types. missingVersionError() branches on it — "was evicted" when the
    // number is at or below the high-water mark, "no version N" above it — and
    // versionContent() has NO write-scope check by design (reads rely on RLS
    // to make a foreign home indistinguishable from a missing path).
    //
    // Result: bob gets two DIFFERENT answers for two paths he cannot see, and
    // the boundary between them is alice's edit count.
    const target = "/home/alice/oracle/journal.md";
    // 12 writes ⇒ 11 overwrite snapshots ⇒ the per-path cap (10) evicts v1 and
    // records the high-water mark for this path in fs_version_seq.
    for (let i = 1; i <= 12; i++) {
      await store.write(ctx(alice), target, Buffer.from(`entry ${i}\n`), "text/markdown");
    }
    const seq = await asSuper(
      async (c) =>
        (
          await c.query<{ path: string; last_no: number }>(
            "SELECT path, last_no FROM fs_version_seq",
          )
        ).rows,
    );
    expect(seq).toContainEqual({ path: target, last_no: expect.any(Number) });

    const hit = await message(store.versionContent(ctx(bob), target, 1));
    const miss = await message(
      store.versionContent(ctx(bob), "/home/alice/oracle/never-existed.md", 1),
    );

    // OBSERVED (real output pasted in the report):
    //   hit  = "version 1 of /home/alice/oracle/journal.md was evicted — history
    //           is bounded, so old versions age out; run `history …` for what is
    //           still kept"
    //   miss = "no version 1 for /home/alice/oracle/never-existed.md"
    // FIXED: missingVersionError now consults the high-water mark ONLY once the
    // caller can already observe something at the path under their OWN RLS. For
    // a foreign home both answers are the same flat miss, so absence carries no
    // information — the same uniform-ENOENT contract every other read honours.
    expect(hit).toMatch(/^no version 1 for/);
    expect(miss).toMatch(/^no version 1 for/);

    // …and the mark is no longer binary-searchable, so the QUANTITATIVE half of
    // the leak (alice's edit count) is gone too.
    const lastNo = seq.find((s) => s.path === target)!.last_no;
    const evicted = async (v: number): Promise<boolean> =>
      /was evicted/.test(await message(store.versionContent(ctx(bob), target, v)));
    expect(await evicted(lastNo)).toBe(false);
    expect(await evicted(lastNo + 1)).toBe(false);

    // The helpful wording still reaches the one caller entitled to it: alice can
    // see her own path, so she is told the difference between "aged out" and
    // "never existed" — the fix narrows the oracle, it does not blunt the tool.
    expect(await message(store.versionContent(ctx(alice), target, 1))).toMatch(/was evicted/);
  });

  // ------------------------------------------------------------------ trash

  it("trash cannot be enumerated with any prefix, including LIKE metacharacters", async () => {
    const gone = "/home/alice/trash/secret-plan.md";
    const wild = "/home/alice/tra_h/100%-secret.md"; // %, _ live in real names
    await store.write(ctx(alice), gone, Buffer.from("plan bytes\n"), "text/markdown");
    await store.write(ctx(alice), wild, Buffer.from("wild bytes\n"), "text/markdown");
    await store.rm(ctx(alice), gone);
    await store.rm(ctx(alice), wild);

    // alice can see her own trash
    const mine = (await store.listTrash(ctx(alice))).map((t) => t.path);
    expect(mine).toContain(gone);
    expect(mine).toContain(wild);

    // bob: every prefix shape, including metacharacters that would widen a
    // naive LIKE (likeChildren escapes \ % _ — this is the regression pin).
    for (const prefix of [
      "/",
      "/home",
      "/home/",
      "/home/alice",
      "/home/alice/trash",
      "/home/alice/tra_h",
      "/home/%",
      "/home/_lice",
      "/home/alice/%",
      "/home/alice/tra%h",
      "/home/alice/trash/%",
      "/%",
      "/_",
      "/home/alice/tra\\_h",
      "/shared",
    ]) {
      const rows = await store.listTrash(ctx(bob), prefix);
      expect(
        rows.map((t) => t.path),
        `prefix ${prefix}`,
      ).not.toContain(gone);
      expect(
        rows.map((t) => t.path),
        `prefix ${prefix}`,
      ).not.toContain(wild);
      // not even sizes/timestamps of foreign rows ride along
      expect(
        rows.filter((r) => r.path.startsWith("/home/alice")),
        `prefix ${prefix} home rows`,
      ).toEqual([]);
    }

    // traversal is still refused rather than normalised into a wider prefix
    await expect(store.listTrash(ctx(bob), "/home/bob/../alice")).rejects.toThrow(/\.\./);
    await expect(store.listTrash(ctx(bob), "/home/%2e%2e/alice")).rejects.toThrow(
      /percent-encoded/,
    );
  });

  it("a deleted foreign file cannot be resurrected — not into its own path, not into /shared", async () => {
    const gone = "/home/alice/trash/secret-plan.md";
    await expect(store.restore(ctx(bob), gone)).rejects.toThrow();
    // bob names a path he DOES own; the snapshot is keyed by path, so there is
    // nothing of alice's to pull through.
    await expect(store.restore(ctx(bob), "/shared/stolen.md")).rejects.toThrow(
      /no version to restore/,
    );
    await expect(store.restore(ctx(bob), "/home/bob/secret-plan.md")).rejects.toThrow(
      /no version to restore/,
    );
    expect(await store.exists(ctx(bob), "/shared/stolen.md")).toBe(false);
    // and alice's trash is untouched by all of that
    expect((await store.listTrash(ctx(alice))).map((t) => t.path)).toContain(gone);
  });

  // ------------------------------------------------------------------ locks

  it("lock state of an invisible path is unobservable, and lockedByName leaks no membership", async () => {
    const p = "/home/alice/vault/keys.md";
    await store.lock(ctx(alice), p);
    expect(await store.lockInfo(ctx(alice), p)).toMatchObject({ lockedByName: "alice" });

    expect(await store.lockInfo(ctx(bob), p)).toBeNull();
    expect((await store.lockInfoMany(ctx(bob), [p, "/home/alice", "/home/alice/vault"])).size).toBe(
      0,
    );
    // the write-gate PROBE must not become the oracle the reads refused to be:
    // an ELOCKED here would confirm both existence and that someone locked it.
    await expect(store.assertNotLockedForWrite(ctx(bob), p)).resolves.toBeUndefined();
    await expect(
      store.assertNotLockedForWrite(ctx(bob), "/home/alice/vault/absent.md"),
    ).resolves.toBeUndefined();

    // an ancestor lock in alice's home must not block or reveal itself to bob
    await store.lock(ctx(alice), "/home/alice/vault");
    await expect(store.assertNotLockedForWrite(ctx(bob), p)).resolves.toBeUndefined();
    expect(await store.lockInfo(ctx(bob), "/home/alice/vault")).toBeNull();
    await store.unlock(ctx(alice), "/home/alice/vault");
    await store.unlock(ctx(alice), p);
  });

  it("a shared lock names its holder — that IS the feature, and it stops at the lock", async () => {
    const p = "/shared/locked/doc.md";
    await store.write(ctx(alice), p, Buffer.from("x\n"), "text/markdown");
    await store.lock(ctx(alice), p);
    expect(await store.lockInfo(ctx(bob), p)).toMatchObject({ lockedByName: "alice" });
    // bob learns nothing about paths alice locked in her home from this call
    expect((await store.lockInfoMany(ctx(bob), [p, "/home/alice/vault/keys.md"])).size).toBe(1);
    await store.unlock(ctx(alice), p);
  });

  // -------------------------------------------------------------- obo parity

  // ------------------------------------------------- rename cannot re-home bytes

  it("moving a file between /shared and a home re-pins ownership on BOTH tables", async () => {
    // A snapshot copies owner_id off the live row, and fs_pin_owner fires on
    // UPDATE too — so `mv /shared/x /home/alice/x` must not leave later
    // snapshots owner_id NULL (bob reading alice's home history), and
    // `mv /home/alice/y /shared/y` must not retro-publish y's private history.
    await store.write(ctx(alice), "/shared/mv/x.md", Buffer.from("public v1\n"), "text/markdown");
    await store.rename(ctx(alice), "/shared/mv/x.md", "/home/alice/mv/x.md");
    await store.write(ctx(alice), "/home/alice/mv/x.md", Buffer.from("now private\n"));
    await store.write(ctx(alice), "/home/alice/mv/x.md", Buffer.from("still private\n"));
    expect(await store.history(ctx(bob), "/home/alice/mv/x.md")).toEqual([]);
    const owners = await asSuper(
      async (c) =>
        (
          await c.query<{ owner_id: string | null }>(
            "SELECT DISTINCT owner_id FROM fs_versions WHERE path = '/home/alice/mv/x.md'",
          )
        ).rows,
    );
    expect(owners).toEqual([{ owner_id: alice }]);

    await store.write(ctx(alice), "/home/alice/mv/y.md", Buffer.from("private v1\n"));
    await store.write(ctx(alice), "/home/alice/mv/y.md", Buffer.from("private v2\n"));
    await store.rename(ctx(alice), "/home/alice/mv/y.md", "/shared/mv/y.md");
    // the LIVE file is now shared (that is alice's choice); its PRIOR history
    // stays keyed to the old, private path and stays invisible.
    expect((await store.read(ctx(bob), "/shared/mv/y.md")).bytes.toString()).toBe("private v2\n");
    expect(await store.history(ctx(bob), "/home/alice/mv/y.md")).toEqual([]);
    expect(await store.versionList(ctx(bob), "/home/alice/mv/y.md")).toEqual([]);
  });

  // ---------------------------------------------- the DB privilege layer itself

  it("fs_versions is FORCE RLS and its DR escape needs brain_owner AND the GUC", async () => {
    const forced = await asSuper(
      async (c) =>
        (
          await c.query<{ relname: string; f: boolean; e: boolean }>(
            `SELECT relname, relforcerowsecurity AS f, relrowsecurity AS e
               FROM pg_class WHERE relname IN ('fs_versions','fs_entries','fs_version_seq')
              ORDER BY relname`,
          )
        ).rows,
    );
    expect(forced).toContainEqual({ relname: "fs_versions", f: true, e: true });
    expect(forced).toContainEqual({ relname: "fs_entries", f: true, e: true });

    // brain_app cannot buy the escape by setting the GUC itself
    const app = await brain.connect("app");
    try {
      await app.query("BEGIN READ ONLY");
      await app.query("SELECT set_config('app.fs_dr', 'on', true)");
      const r = await app.query(
        "SELECT count(*)::int AS n FROM fs_versions WHERE path LIKE '/home/alice/%'",
      );
      expect(r.rows[0].n).toBe(0);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }

    // brain_owner without the GUC is bound too; with it, it is the documented escape
    const owner = await brain.connect("owner");
    try {
      const before = await owner.query(
        "SELECT count(*)::int AS n FROM fs_versions WHERE path LIKE '/home/alice/%'",
      );
      expect(before.rows[0].n).toBe(0);
      await owner.query("BEGIN READ ONLY");
      await owner.query("SELECT set_config('app.fs_dr', 'on', true)");
      const after = await owner.query(
        "SELECT count(*)::int AS n FROM fs_versions WHERE path LIKE '/home/alice/%'",
      );
      expect(after.rows[0].n).toBeGreaterThan(0);
      await owner.query("ROLLBACK");
    } finally {
      await owner.end();
    }
  });

  it("brain_app has no table privileges on fs_version_seq (paths never cross that way)", async () => {
    const app = await brain.connect("app");
    try {
      await expect(app.query("SELECT path FROM fs_version_seq")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
    }
  });

  it("REGRESSION: fs_version_seq is FORCE-RLS — brain_owner cannot enumerate home PATHS", async () => {
    // fs_entries and fs_versions are FORCE RLS precisely so the migration
    // runner / DR role cannot read a member's home without the explicit
    // app.fs_dr escape. 0048's fs_version_seq holds one row PER PATH and was
    // created with no policy at all, so the same role reads every private
    // home path that has ever had a version evicted — no GUC, no escape.
    const owner = await brain.connect("owner");
    try {
      const rows = await owner.query<{ path: string }>(
        "SELECT path FROM fs_version_seq WHERE path LIKE '/home/%' ORDER BY path",
      );
      // FIXED by 0049: the table now carries the same FORCE-RLS + policy its two
      // sibling tables have, so a private home PATH is as unreadable here as the
      // file itself. All three agree for the same role and prefix.
      expect(rows.rowCount ?? 0).toBe(0);

      const versions = await owner.query(
        "SELECT count(*)::int AS n FROM fs_versions WHERE path LIKE '/home/%'",
      );
      expect(versions.rows[0].n).toBe(0); // convergence, not divergence

      // and the documented escape still works, so DR export is unaffected
      await owner.query("SET app.fs_dr = 'on'");
      const withEscape = await owner.query<{ path: string }>(
        "SELECT path FROM fs_version_seq WHERE path LIKE '/home/%'",
      );
      expect(withEscape.rowCount ?? 0).toBeGreaterThan(0);
      await owner.query("RESET app.fs_dr");
    } finally {
      await owner.end();
    }
  });

  it("REGRESSION (0051): brain_fs_evict_versions refuses the args that made it a global-wipe primitive", async () => {
    // 0045/0048 grant EXECUTE to brain_app and every argument is caller-
    // supplied; the body runs SECURITY DEFINER as brain_system (BYPASSRLS), so
    // the RLS that protects alice's snapshots does not apply to its DELETE.
    // Before 0051, `brain_fs_evict_versions(0, path, 0, '{}')` wiped the whole
    // table — every home, every owner — from one actor-less call. 0051 guards
    // the two args that weaponised it without touching the legitimate call.
    //
    // Shared brain: this test asserts on its OWN unique path plus deltas, and
    // touches no other path, so it neither depends on nor perturbs global state.
    // The pre-0051 version ended by WIPING fs_versions (via the evict call it was
    // demonstrating) and later tests leaned on that reset — so mirror it exactly:
    // TRUNCATE fs_versions only at the end (NOT fs_version_seq, which evict never
    // touched — a downstream test reads a floor from it).
    const total = (): Promise<number> =>
      asSuper(
        async (c) =>
          (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM fs_versions")).rows[0]!.n,
      );
    const count = (path: string): Promise<number> =>
      asSuper(
        async (c) =>
          (
            await c.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM fs_versions WHERE path = $1",
              [path],
            )
          ).rows[0]!.n,
      );

    const p = "/home/alice/reaper/target.md";
    for (let i = 1; i <= 4; i++) {
      await store.write(ctx(alice), p, Buffer.from(`r${i}\n`), "text/markdown");
    }
    // a SECOND member's UNRELATED history, so a whole-table wipe would show
    await store.write(ctx(bob), "/shared/reaper/keep.md", Buffer.from("a\n"), "text/markdown");
    await store.write(ctx(bob), "/shared/reaper/keep.md", Buffer.from("b\n"), "text/markdown");
    const aliceStart = await count(p); // 4 writes ⇒ 3 overwrite snapshots
    expect(aliceStart).toBeGreaterThan(1);
    const before = await total();

    // (1) p_budget = 0 — the whole-brain wipe — is now REFUSED (check_violation),
    // and refusing aborts to the caller's SAVEPOINT: not one row is deleted.
    const app = await brain.connect("app");
    try {
      await expect(
        app.query(
          "SELECT brain_fs_evict_versions(0::bigint, '/nonexistent'::text, 0::int, '{}'::uuid[])",
        ),
      ).rejects.toThrow(/p_budget must be positive/);
    } finally {
      await app.end();
    }
    expect(await total()).toBe(before); // nothing destroyed

    // (2) p_keep = 0 no longer means "spare nothing" — it is floored to 1. With a
    // huge budget (global pass evicts nothing), the path is trimmed to its single
    // newest overwrite instead of being wiped to zero, and NO other path is
    // touched. Before 0051, keep=0 → OFFSET 0 → all of alice's snapshots gone.
    const app2 = await brain.connect("app");
    try {
      await app2.query(
        "SELECT brain_fs_evict_versions($1::bigint, $2::text, 0::int, '{}'::uuid[])",
        [1_000_000_000_000, p],
      );
    } finally {
      await app2.end();
    }
    expect(await count(p)).toBe(1); // floored to 1 (not 0), newest kept
    expect(await count("/shared/reaper/keep.md")).toBeGreaterThan(0); // unrelated path untouched

    // Mirror the pre-0051 end state: fs_versions empty (evict never touched
    // fs_version_seq, so neither do we — a later test reads a floor from it).
    await asSuper((c) => c.query("TRUNCATE fs_versions"));
  });

  it("brain_fs_version_floor is callable by brain_app for ANY path (the oracle's root)", async () => {
    const app = await brain.connect("app");
    try {
      const r = await app.query<{ f: number }>("SELECT brain_fs_version_floor($1) AS f", [
        "/home/alice/oracle/journal.md",
      ]);
      expect(r.rows[0]!.f).toBeGreaterThan(0); // a private path, answered to an actor-less session
      const miss = await app.query<{ f: number }>("SELECT brain_fs_version_floor($1) AS f", [
        "/home/alice/oracle/never-existed.md",
      ]);
      expect(miss.rows[0]!.f).toBe(0);
    } finally {
      await app.end();
    }
  });

  // --------------------------------------------------- eviction as a weapon

  it("eviction is global and age-ranked — B's writes CAN reclaim A's history, but not selectively", async () => {
    // Documented behaviour: the byte budget is a property of the
    // whole table. The security question is whether it can be TARGETED. It is
    // ordered (created_at, path, version_no), so a member can only push the
    // oldest rows out — never choose a victim.
    await asSuper(async (c) => {
      await c.query("TRUNCATE fs_versions");
      await c.query("TRUNCATE fs_version_seq");
    });

    const alicePath = "/home/alice/evict/old.md";
    await store.write(ctx(alice), alicePath, Buffer.from("A".repeat(400)), "text/markdown");
    await store.write(ctx(alice), alicePath, Buffer.from("B".repeat(400)), "text/markdown");
    expect((await store.versionList(ctx(alice), alicePath)).length).toBe(1);

    // A store with a deliberately tiny budget, driven ONLY by bob, in HIS
    // scope. The bytes must DIFFER each round: an identical overwrite is a
    // no-op and takes no snapshot at all (which is how the first draft of this
    // test silently proved nothing).
    const tight = new FsStore(fsPool, { versionBudgetBytes: 500 });
    for (let i = 0; i < 4; i++) {
      await tight.write(
        ctx(bob),
        "/home/bob/evict/mine.md",
        Buffer.from(String.fromCharCode(67 + i).repeat(400)),
      );
    }

    // alice's older snapshot has been reclaimed by bob's writes …
    expect(await store.versionList(ctx(alice), alicePath)).toEqual([]);
    // … but bob learned nothing: he still cannot see it, its path, or its size.
    expect(await store.history(ctx(bob), alicePath)).toEqual([]);
    expect((await store.listTrash(ctx(bob))).map((t) => t.path)).not.toContain(alicePath);
    // and the number it used is now permanently burned, so a later snapshot of
    // that path can never reuse it (0048's whole point).
    await store.write(ctx(alice), alicePath, Buffer.from("D".repeat(10)));
    const after = await store.versionList(ctx(alice), alicePath);
    expect(after.every((v) => v.version_no > 1)).toBe(true);
  });
});
