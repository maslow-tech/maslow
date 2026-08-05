import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, FsStore, MAX_FILE_BYTES, normalizeFsPath, type FsCtx } from "@brain/mcp-tools";
import { MIGRATIONS } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * FsStore (migration 0037; design 2026-07-16): the single path-first store
 * over fs_entries. Proves the whole contract Tasks 3/5/6 build on: durable
 * round-trips, mkdir -p, prefix-scoped rm/rename, quota + per-file cap,
 * traversal rejection, write-scope teaching errors, read-only tokens, and —
 * the boundary itself — RLS keeping foreign homes invisible even to raw SQL.
 */

// A real 1x1 PNG (binary, has NUL/high bytes — a good round-trip probe).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

describe("FsStore over fs_entries", () => {
  let brain: FreshBrain;
  let adminPool: Pool;
  let fsPool: Pool; // the dedicated small pool the store owns (box.ts shape)
  let store: FsStore;

  let alice: string; // owner → /home/alice
  let bob: string; // member → /home/bob

  const ctx = (actorId: string, extra: Partial<FsCtx> = {}): FsCtx => ({ actorId, ...extra });

  const usage = async (): Promise<number> => {
    const r = await fsPool.query<{ total_bytes: string }>("SELECT total_bytes FROM fs_usage");
    return Number(r.rows[0]!.total_bytes);
  };

  /** Total fs_versions bytes — what the global eviction budget bounds. */
  const versionBytes = async (): Promise<number> => {
    const r = await fsPool.query<{ n: string }>(
      "SELECT coalesce(sum(size_bytes), 0) AS n FROM fs_versions",
    );
    return Number(r.rows[0]!.n);
  };

  /**
   * The TRUE fs_versions total, read as superuser (BYPASSRLS) — `versionBytes`
   * above runs as brain_app with no app.actor_id, so RLS shows it shared rows
   * only. The global budget is a property of the whole TABLE, so proving it
   * needs the un-scoped sum.
   */
  const versionBytesAll = async (): Promise<number> => {
    const su = await brain.connect("superuser");
    try {
      const r = await su.query<{ n: string }>(
        "SELECT coalesce(sum(size_bytes), 0) AS n FROM fs_versions",
      );
      return Number(r.rows[0]!.n);
    } finally {
      await su.end();
    }
  };

  /** Every version row's id, oldest-first — including rows RLS hides from us. */
  const versionIdsAll = async (): Promise<string[]> => {
    const su = await brain.connect("superuser");
    try {
      const r = await su.query<{ id: string }>(
        "SELECT id FROM fs_versions ORDER BY created_at, path, version_no",
      );
      return r.rows.map((x) => x.id);
    } finally {
      await su.end();
    }
  };

  /** Isolate a budget test: drop snapshots earlier tests left, as superuser. */
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
    bob = (
      await admin.createUser(alice, { name: "bob", email: "bob@example.com", permission: "member" })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await fsPool?.end();
    await adminPool?.end();
    await brain?.drop();
  });

  // ---- path validation ------------------------------------------------------

  it("normalizeFsPath rejects traversal and malformed paths, strips a trailing slash", () => {
    expect(normalizeFsPath("/shared/a/")).toBe("/shared/a");
    expect(normalizeFsPath("/")).toBe("/");
    for (const bad of [
      "relative.txt",
      "",
      "/shared/../etc/passwd",
      "/shared/./x",
      "/shared//x",
      "/shared/a%2e%2e/x",
      "/shared/%2Fx",
      "/shared/a\u0000b",
      "/shared/a\nb",
    ]) {
      expect(() => normalizeFsPath(bad), bad).toThrow();
    }
  });

  it("`..` is rejected by every op, not just the helper", async () => {
    await expect(store.read(ctx(alice), "/shared/../home/bob/x")).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      store.write(ctx(alice), "/shared/../shared/x.txt", Buffer.from("x")),
    ).rejects.toMatchObject({ code: "validation" });
  });

  // ---- round-trip -----------------------------------------------------------

  it("write → read/stat/list round-trips bytes and metadata (implicit mkdir -p)", async () => {
    const body = Buffer.from("hello brain\n");
    const meta = await store.write(ctx(alice), "/shared/notes/hello.txt", body);
    expect(meta).toMatchObject({
      path: "/shared/notes/hello.txt",
      name: "hello.txt",
      kind: "file",
      size: body.length,
      mime: "text/plain", // extension fallback
      sha256: createHash("sha256").update(body).digest("hex"),
      updatedBy: alice,
    });

    const back = await store.read(ctx(alice), "/shared/notes/hello.txt");
    expect(back.bytes.equals(body)).toBe(true);
    expect(back.meta.sha256).toBe(meta.sha256);

    const st = await store.stat(ctx(alice), "/shared/notes");
    expect(st.kind).toBe("dir");

    const listed = await store.list(ctx(alice), "/shared/notes");
    expect(listed.map((e) => e.name)).toEqual(["hello.txt"]);
    const shared = await store.list(ctx(bob), "/shared");
    expect(shared.map((e) => e.name)).toContain("notes");
    expect(shared.map((e) => e.name)).toContain("README.md");

    // binary bytes survive exactly; caller mime wins over the extension
    await store.write(ctx(alice), "/shared/notes/pixel.bin", PNG, "image/png");
    const png = await store.read(ctx(alice), "/shared/notes/pixel.bin");
    expect(png.bytes.equals(PNG)).toBe(true);
    expect(png.meta.mime).toBe("image/png");

    // overwrite = last write wins, size/sha follow
    const v2 = Buffer.from("v2");
    const meta2 = await store.write(ctx(alice), "/shared/notes/hello.txt", v2);
    expect(meta2.size).toBe(2);
    expect((await store.read(ctx(alice), "/shared/notes/hello.txt")).bytes.equals(v2)).toBe(true);
  });

  it("append extends content (creates when missing) and keeps size/sha true", async () => {
    await store.append(ctx(alice), "/shared/log.txt", Buffer.from("one\n"));
    await store.append(ctx(alice), "/shared/log.txt", Buffer.from("two\n"));
    const r = await store.read(ctx(alice), "/shared/log.txt");
    expect(r.bytes.toString()).toBe("one\ntwo\n");
    expect(r.meta.size).toBe(8);
    expect(r.meta.sha256).toBe(createHash("sha256").update("one\ntwo\n").digest("hex"));
  });

  it("mkdir -p creates chains, is idempotent, and refuses a file in the way", async () => {
    await store.mkdir(ctx(alice), "/shared/a/b/c");
    await store.mkdir(ctx(alice), "/shared/a/b/c"); // no-op
    expect(await store.exists(ctx(bob), "/shared/a/b/c")).toBe(true);
    expect((await store.stat(ctx(bob), "/shared/a/b")).kind).toBe("dir");

    await store.write(ctx(alice), "/shared/a/file.txt", Buffer.from("x"));
    await expect(store.mkdir(ctx(alice), "/shared/a/file.txt")).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("EEXIST"),
    });
    // …and a dir can't be overwritten by a file write
    await expect(store.write(ctx(alice), "/shared/a/b", Buffer.from("x"))).rejects.toMatchObject({
      message: expect.stringContaining("EISDIR"),
    });
  });

  // ---- rm / rename ----------------------------------------------------------

  it("rm -rf is one prefix-scoped delete: right count, no lookalike casualties", async () => {
    await store.write(ctx(alice), "/shared/rmme/a.txt", Buffer.from("aaaa"));
    await store.write(ctx(alice), "/shared/rmme/sub/b.txt", Buffer.from("bb"));
    await store.mkdir(ctx(alice), "/shared/rmme/sub/empty");
    await store.write(ctx(alice), "/shared/rmme2.txt", Buffer.from("survivor"));

    await expect(store.rm(ctx(alice), "/shared/rmme")).rejects.toMatchObject({
      message: expect.stringContaining("ENOTEMPTY"),
    });

    const before = await usage();
    const n = await store.rm(ctx(alice), "/shared/rmme", true);
    expect(n).toEqual({ removed: 5, unrecoverable: [] }); // rmme, a.txt, sub, b.txt, empty
    expect(await usage()).toBe(before - 6); // 4 + 2 file bytes freed
    expect(await store.exists(ctx(alice), "/shared/rmme")).toBe(false);
    expect(await store.exists(ctx(alice), "/shared/rmme2.txt")).toBe(true); // prefix-safe

    await expect(store.rm(ctx(alice), "/shared/rmme", true)).rejects.toMatchObject({
      code: "not_found",
    });
    // empty dirs go without recursive (rmdir)
    await store.mkdir(ctx(alice), "/shared/soon-empty");
    expect((await store.rm(ctx(alice), "/shared/soon-empty")).removed).toBe(1);
  });

  it("rename moves a whole subtree in one statement, parents included", async () => {
    await store.write(ctx(alice), "/shared/proj/spec.md", Buffer.from("# spec"));
    await store.write(ctx(alice), "/shared/proj/notes/day1.md", Buffer.from("day one"));

    await store.rename(ctx(alice), "/shared/proj", "/shared/projects/apollo");
    expect(await store.exists(ctx(alice), "/shared/proj")).toBe(false);
    const spec = await store.read(ctx(alice), "/shared/projects/apollo/spec.md");
    expect(spec.bytes.toString()).toBe("# spec");
    const day1 = await store.stat(ctx(alice), "/shared/projects/apollo/notes/day1.md");
    expect(day1.name).toBe("day1.md");
    const listed = await store.list(ctx(alice), "/shared/projects/apollo");
    expect(listed.map((e) => e.name).sort()).toEqual(["notes", "spec.md"]);

    await expect(
      store.rename(ctx(alice), "/shared/projects", "/shared/projects/apollo/inside"),
    ).rejects.toMatchObject({ message: expect.stringContaining("EINVAL") });

    // a file may overwrite a file (POSIX rename); usage drops by the loser
    await store.write(ctx(alice), "/shared/win.txt", Buffer.from("winner"));
    await store.write(ctx(alice), "/shared/lose.txt", Buffer.from("loser!!"));
    const before = await usage();
    await store.rename(ctx(alice), "/shared/win.txt", "/shared/lose.txt");
    expect(await usage()).toBe(before - 7);
    expect((await store.read(ctx(alice), "/shared/lose.txt")).bytes.toString()).toBe("winner");
  });

  it("renames a directory whose path contains an astral char (emoji), children intact", async () => {
    // JS .length (UTF-16 units) ≠ Postgres char_length; the subtree cut is
    // computed in SQL so an emoji in the path can't misparent children.
    await store.write(ctx(alice), "/shared/📁box/a.txt", Buffer.from("aa"));
    await store.write(ctx(alice), "/shared/📁box/sub/b.txt", Buffer.from("bbb"));
    await store.rename(ctx(alice), "/shared/📁box", "/shared/plainbox");

    expect(await store.exists(ctx(alice), "/shared/📁box")).toBe(false);
    expect((await store.read(ctx(alice), "/shared/plainbox/a.txt")).bytes.toString()).toBe("aa");
    const deep = await store.stat(ctx(alice), "/shared/plainbox/sub/b.txt");
    expect(deep.name).toBe("b.txt");
    const listed = await store.list(ctx(alice), "/shared/plainbox");
    expect(listed.map((e) => e.name).sort()).toEqual(["a.txt", "sub"]);
  });

  it("concurrent creates of the SAME new path don't drift the quota counter", async () => {
    const before = await usage();
    // two writers race to create one new path; last-write-wins, but the usage
    // counter must reflect ONE file's bytes (advisory lock serializes them).
    await Promise.all([
      store.write(ctx(alice), "/shared/race.txt", Buffer.from("A".repeat(100))),
      store.write(ctx(bob), "/shared/race.txt", Buffer.from("B".repeat(100))),
    ]);
    expect(await usage()).toBe(before + 100); // not 200
    // and a concurrent first-append to a new path doesn't raise a raw dup-key
    await Promise.all([
      store.append(ctx(alice), "/shared/race2.log", Buffer.from("x\n")),
      store.append(ctx(bob), "/shared/race2.log", Buffer.from("y\n")),
    ]);
    const both = (await store.read(ctx(alice), "/shared/race2.log")).bytes.toString();
    expect(both.split("\n").filter(Boolean).sort().join(",")).toBe("x,y");
  });

  it("a home file moved to /shared becomes visible; the reverse hides it", async () => {
    await store.write(ctx(alice), "/home/alice/draft.md", Buffer.from("draft"));
    expect(await store.exists(ctx(bob), "/home/alice/draft.md")).toBe(false);
    await store.rename(ctx(alice), "/home/alice/draft.md", "/shared/published.md");
    expect(await store.exists(ctx(bob), "/shared/published.md")).toBe(true);
    // bob pulls it into HIS home — now alice can't see it
    await store.rename(ctx(bob), "/shared/published.md", "/home/bob/mine.md");
    expect(await store.exists(ctx(alice), "/home/bob/mine.md")).toBe(false);
    expect((await store.read(ctx(bob), "/home/bob/mine.md")).bytes.toString()).toBe("draft");
  });

  // ---- versioning -----------------------------------------------------------

  it("overwriting a text file snapshots the prior content into fs_versions", async () => {
    await store.write(ctx(alice), "/home/alice/plan.md", Buffer.from("v1 body\n"), "text/markdown");
    await store.write(ctx(alice), "/home/alice/plan.md", Buffer.from("v2 body\n"), "text/markdown");
    const hist = await store.history(ctx(alice), "/home/alice/plan.md");
    expect(hist).toHaveLength(1);
    expect(hist[0]!.reason).toBe("overwrite");
    expect(hist[0]!.content.toString()).toBe("v1 body\n"); // the PRIOR bytes
  });

  it("overwriting a binary or an oversized file snapshots nothing", async () => {
    await store.write(ctx(alice), "/home/alice/pic.png", Buffer.from([0x89, 0x50]), "image/png");
    await store.write(ctx(alice), "/home/alice/pic.png", Buffer.from([0x89, 0x51]), "image/png");
    expect(await store.history(ctx(alice), "/home/alice/pic.png")).toHaveLength(0);
  });

  /**
   * A media type is `type/subtype` plus OPTIONAL parameters, and it is
   * case-insensitive — so `text/plain;charset=UTF-8` (what a bare WHATWG
   * `fetch(url, {method:"PUT", body:"…"})` sends, straight through
   * `PUT /api/v1/fs/file`) and `TEXT/MARKDOWN` are the same text-ish type the
   * versionable set already names. Matching the raw header against that set
   * silently gave the documented ingestion path NO history at all, and stored
   * the parameterised string on the row so later appends stayed broken too.
   */
  it("a charset parameter or uppercase in the mime still versions, and is not stored", async () => {
    for (const [p, mime] of [
      ["/home/alice/param-a.md", "text/plain;charset=UTF-8"],
      ["/home/alice/param-b.md", "text/markdown; charset=utf-8"],
      ["/home/alice/param-c.json", "application/json; charset=utf-8"],
      ["/home/alice/param-d.yaml", "application/x-yaml"], // a real File.type alias
      ["/home/alice/param-e.md", "TEXT/MARKDOWN"],
    ] as const) {
      await store.write(ctx(alice), p, Buffer.from("v1\n"), mime);
      await store.write(ctx(alice), p, Buffer.from("v2\n"), mime);
      const hist = await store.history(ctx(alice), p);
      expect(`${p} → ${hist.length}`).toBe(`${p} → 1`);
      expect(hist[0]!.content.toString()).toBe("v1\n");
    }
    // The essence is what lands on the row — the parameter is dropped at the
    // boundary, so nothing downstream ever sees it.
    expect((await store.stat(ctx(alice), "/home/alice/param-a.md")).mime).toBe("text/plain");
    expect((await store.stat(ctx(alice), "/home/alice/param-e.md")).mime).toBe("text/markdown");
    // …and history keeps accumulating across a later append on the same file.
    await store.append(ctx(alice), "/home/alice/param-a.md", Buffer.from("v3\n")); // snapshots "v2\n"
    await store.write(ctx(alice), "/home/alice/param-a.md", Buffer.from("v4\n"), "text/plain");
    const grown = await store.history(ctx(alice), "/home/alice/param-a.md");
    expect(grown.map((h) => h.content.toString())).toEqual(["v2\nv3\n", "v2\n", "v1\n"]);
  });

  it("versionability falls back to the EXTENSION when the declared mime is useless", async () => {
    // An uploader that knows nothing (`application/octet-stream`, or a browser
    // with no `.md` mapping) must not cost a .md file its history.
    for (const p of ["/home/alice/blind.md", "/home/alice/blind.json"]) {
      await store.write(ctx(alice), p, Buffer.from("v1\n"), "application/octet-stream");
      await store.write(ctx(alice), p, Buffer.from("v2\n"), "application/octet-stream");
      expect(`${p} → ${(await store.history(ctx(alice), p)).length}`).toBe(`${p} → 1`);
    }
    // The fallback stays narrow: a binary extension AND a binary mime is still
    // never snapshotted.
    await store.write(ctx(alice), "/home/alice/blind.zip", Buffer.from([1, 2]), "application/zip");
    await store.write(ctx(alice), "/home/alice/blind.zip", Buffer.from([1, 3]), "application/zip");
    expect(await store.history(ctx(alice), "/home/alice/blind.zip")).toHaveLength(0);
  });

  /**
   * bash is the ONLY write surface an agent has, and it declares no mime at
   * all — so versionability of everything an agent actually edits was decided
   * by the extension table alone. That table knew `.md/.txt/.json/.py` and
   * nothing else: `app.ts`, `deploy.sh`, `schema.sql`, `run.log` and every
   * extensionless file (`README`, `Makefile`, `.gitignore`, `Dockerfile`) fell
   * through to `application/octet-stream` and got NO history at all, while the
   * versionable set listed `text/x-typescript` — a mime no code path could
   * produce. The classifier is content-decided now (small + no NUL + valid
   * UTF-8 ⇒ text), so the guarantee is "if it's text and small, you can get it
   * back", independent of what the name happens to end in.
   */
  it("code, extensionless and unknown-extension text files all get overwrite history", async () => {
    const names = [
      "README",
      "Makefile",
      ".gitignore",
      "Dockerfile",
      "app.ts",
      "app.tsx",
      "deploy.sh",
      "schema.sql",
      "page.html",
      "style.css",
      "run.log",
      "main.go",
      "conf.toml",
      "ok.md", // control: worked before, must keep working
    ];
    const got: Record<string, number> = {};
    for (const n of names) {
      const p = `/shared/nomime/${n}`;
      await store.write(ctx(alice), p, Buffer.from("v1\n")); // no mime — the bash shape
      await store.write(ctx(alice), p, Buffer.from("v2\n"));
      got[n] = (await store.history(ctx(alice), p)).length;
    }
    expect(got).toEqual(Object.fromEntries(names.map((n) => [n, 1])));
    // …and the restored bytes are the PRIOR ones, not a stub
    expect((await store.history(ctx(alice), "/shared/nomime/app.ts"))[0]!.content.toString()).toBe(
      "v1\n",
    );
    // The mime table still names what it can, for display/Content-Type…
    const mimeOf = async (n: string): Promise<string | null> =>
      (await store.stat(ctx(alice), `/shared/nomime/${n}`)).mime;
    expect(await mimeOf("app.ts")).toBe("text/x-typescript");
    expect(await mimeOf("deploy.sh")).toBe("text/x-shellscript");
    expect(await mimeOf("run.log")).toBe("text/plain");

    // …and content that is genuinely binary still snapshots nothing, whether or
    // not the name says so: a NUL, a DEL or a stray C0 control is the tell, and
    // a known-binary type vetoes even printable-looking bytes.
    for (const [n, a, b] of [
      ["blob", Buffer.from([0x41, 0x00, 0x42]), Buffer.from([0x41, 0x00, 0x43])],
      ["ctrl", Buffer.from([0x01, 0x02]), Buffer.from([0x01, 0x03])],
      ["shot.png", PNG, Buffer.concat([PNG, Buffer.from([0])])],
    ] as const) {
      const p = `/shared/nomime/${n}`;
      await store.write(ctx(alice), p, a);
      await store.write(ctx(alice), p, b);
      expect(`${n} → ${(await store.history(ctx(alice), p)).length}`).toBe(`${n} → 0`);
    }

    // Non-UTF-8 TEXT is still text: a cp1252/latin-1 export (curly quotes,
    // accents) is what a person edits and expects back, so "decodes as UTF-8"
    // is not the test — the structural one is.
    const cp1252 = Buffer.from([0x68, 0x69, 0xe9, 0x92, 0x0a]); // "hi" + é + a curly quote
    await store.write(ctx(alice), "/shared/nomime/legacy.csv", cp1252);
    await store.write(ctx(alice), "/shared/nomime/legacy.csv", Buffer.from("hi\n"));
    const legacy = await store.history(ctx(alice), "/shared/nomime/legacy.csv");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.content.toString("hex")).toBe(cp1252.toString("hex")); // bytes exact
  });

  /**
   * The skip is silent by design (a write must never fail over history), so the
   * ONLY way an agent learns its file is unprotected is by asking — and the old
   * answer, a bare "no version history", read exactly like "you haven't edited
   * it yet". Same words for "one edit away from safe" and "will never be
   * saved" is how you lose bytes you thought were kept.
   */
  it("tells a caller WHY a file has no history (binary / oversized), not just that it hasn't", async () => {
    await store.write(ctx(alice), "/shared/why/fresh.md", Buffer.from("v1\n"));
    expect(await store.versionSkipReason(ctx(alice), "/shared/why/fresh.md")).toBeNull();

    await store.write(ctx(alice), "/shared/why/pic.png", PNG, "image/png");
    expect(await store.versionSkipReason(ctx(alice), "/shared/why/pic.png")).toMatch(/binary/);

    const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
    await store.write(ctx(alice), "/shared/why/big.md", big);
    expect(await store.versionSkipReason(ctx(alice), "/shared/why/big.md")).toMatch(/1\.0MB|cap/);

    // a directory and a missing path are not "unversionable files"
    expect(await store.versionSkipReason(ctx(alice), "/shared/why")).toBeNull();
    expect(await store.versionSkipReason(ctx(alice), "/shared/why/nope.md")).toBeNull();
  });

  it("a garbage mime falls back to the extension instead of being stored", async () => {
    await store.write(ctx(alice), "/home/alice/junk.md", Buffer.from("v1\n"), "not a mime type");
    expect((await store.stat(ctx(alice), "/home/alice/junk.md")).mime).toBe("text/markdown");
  });

  it("keeps only the last N overwrite versions per path", async () => {
    for (let i = 1; i <= 13; i++)
      await store.write(ctx(alice), "/home/alice/n.md", Buffer.from(`v${i}\n`), "text/markdown");
    const hist = await store.history(ctx(alice), "/home/alice/n.md");
    expect(hist.length).toBe(10); // FS_VERSION_KEEP_PER_PATH
    expect(hist[0]!.content.toString()).toBe("v12\n"); // newest snapshot = prior of v13
    expect(hist.at(-1)!.content.toString()).toBe("v3\n"); // v1, v2 evicted
  });

  it("evicts the oldest versions across paths once the global byte budget is exceeded", async () => {
    // Isolate: clear any snapshots earlier tests left so the global sum is exact.
    const su = await brain.connect("superuser");
    try {
      await su.query("TRUNCATE fs_versions");
    } finally {
      await su.end();
    }
    // Two versionable files whose PRIOR bytes are each exactly `size`; budget is
    // one snapshot's worth, so the second overwrite evicts the first path's.
    const size = 200_000;
    const body = Buffer.alloc(size, 0x61); // 'a' * size — text/markdown, versionable
    const tight = new FsStore(fsPool, { versionBudgetBytes: size });
    await tight.write(ctx(alice), "/home/alice/g1.md", body, "text/markdown");
    await tight.write(ctx(alice), "/home/alice/g1.md", Buffer.from("z\n"), "text/markdown");
    // After the first snapshot the table is exactly at budget — nothing evicted.
    expect(await tight.history(ctx(alice), "/home/alice/g1.md")).toHaveLength(1);
    await tight.write(ctx(alice), "/home/alice/g2.md", body, "text/markdown");
    await tight.write(ctx(alice), "/home/alice/g2.md", Buffer.from("z\n"), "text/markdown");
    // Now two snapshots would exceed the budget → the oldest (g1) is dropped.
    expect(await tight.history(ctx(alice), "/home/alice/g1.md")).toHaveLength(0);
    expect(await tight.history(ctx(alice), "/home/alice/g2.md")).toHaveLength(1);
  });

  it("the global budget bounds EVERY member's history, not just the writer's own", async () => {
    await truncateVersions();
    // The budget is a property of the fs_versions TABLE, so it has to be
    // measured and enforced over the whole table — but eviction runs inside the
    // writing member's transaction and fs_versions is FORCE-RLS. Scoped to the
    // writer, `sum(size_bytes)` and the DELETE both see shared rows plus that
    // writer's own home only, so the "global" cap was silently per-actor: N
    // members ⇒ N budgets, and one member's stale home snapshots could never be
    // reclaimed by anyone else's writes. The reaper is elevated (a brain_system
    // SECURITY DEFINER function that discloses nothing) precisely so this holds.
    const budget = 200_000;
    const body = Buffer.alloc(100_000, 0x61); // versionable text
    const tight = new FsStore(fsPool, { versionBudgetBytes: budget });

    // bob fills his OWN home to the budget — invisible to alice under RLS.
    for (const n of ["b1", "b2", "b3"]) {
      await tight.write(ctx(bob), `/home/bob/vb/${n}.md`, body, "text/markdown");
      await tight.write(ctx(bob), `/home/bob/vb/${n}.md`, Buffer.from("z\n"), "text/markdown");
    }
    expect(await versionBytesAll()).toBeLessThanOrEqual(budget);
    const bobRows = await versionIdsAll();
    expect(bobRows.length).toBeGreaterThan(0);

    // alice now churns UNRELATED shared history. Each of her snapshots must age
    // out the globally-oldest row — bob's — not just her own visible slice.
    for (const n of ["a1", "a2"]) {
      await tight.write(ctx(alice), `/shared/vbG/${n}.md`, body, "text/markdown");
      await tight.write(ctx(alice), `/shared/vbG/${n}.md`, Buffer.from("z\n"), "text/markdown");
    }

    expect(await versionBytesAll()).toBeLessThanOrEqual(budget);
    // bob's snapshots were the oldest, so they are what paid for alice's…
    const after = new Set(await versionIdsAll());
    expect(bobRows.filter((id) => after.has(id))).toEqual([]);
    expect(await tight.history(ctx(bob), "/home/bob/vb/b1.md")).toHaveLength(0);
    // …while the writer's own newest snapshot survives, as always.
    expect(await tight.history(ctx(alice), "/shared/vbG/a2.md")).toHaveLength(1);
    // and eviction only ever reclaims HISTORY — bob's live file is untouched.
    expect((await tight.read(ctx(bob), "/home/bob/vb/b1.md")).bytes.toString()).toBe("z\n");
  });

  it("a broken reaper never fails the live write it was housekeeping for", async () => {
    await truncateVersions();
    // Eviction is best-effort by contract: history must never be able to take a
    // real write down with it. It runs inside the writer's transaction now, so
    // a bare try/catch would not be enough — an error poisons the WHOLE
    // transaction — hence the savepoint. Simulate the worst case (a box whose
    // migration has not landed, so the function is simply absent).
    const su = await brain.connect("superuser");
    try {
      await su.query(
        "ALTER FUNCTION brain_fs_evict_versions(bigint, text, int, uuid[]) RENAME TO brain_fs_evict_versions_off",
      );
      await store.write(ctx(alice), "/shared/vbE/keep.md", Buffer.from("v1\n"), "text/markdown");
      // the overwrite (which snapshots, then evicts) still lands…
      await store.write(ctx(alice), "/shared/vbE/keep.md", Buffer.from("v2\n"), "text/markdown");
      expect((await store.read(ctx(alice), "/shared/vbE/keep.md")).bytes.toString()).toBe("v2\n");
      // …and so does an rm, which reports no casualties because none were taken
      expect(await store.rm(ctx(alice), "/shared/vbE/keep.md")).toEqual({
        removed: 1,
        unrecoverable: [],
      });
      expect(await store.restore(ctx(alice), "/shared/vbE/keep.md")).toMatchObject({
        restoredFrom: 2,
      });
    } finally {
      await su.query(
        "ALTER FUNCTION brain_fs_evict_versions_off(bigint, text, int, uuid[]) RENAME TO brain_fs_evict_versions",
      );
      await su.end();
    }
  });

  it("an rm -r never evicts its OWN trash first, and lands the table under budget", async () => {
    await truncateVersions();
    // Older history worth 150 KB, then an rm -r whose own trash is 120 KB — the
    // pair blows a 200 KB budget, so SOMETHING must go. It must be the older
    // history, never the delete's own snapshots: eviction ranks victims by age
    // and every row of one rm shares the txn clock, so a delete that reached
    // into its own trash used to hard-delete the files it had just promised
    // were recoverable.
    const budget = 200_000;
    const tight = new FsStore(fsPool, { versionBudgetBytes: budget });
    await tight.write(ctx(alice), "/shared/vbA/old.md", Buffer.alloc(150_000, 0x61), "text/plain");
    await tight.write(ctx(alice), "/shared/vbA/old.md", Buffer.from("z\n"), "text/plain");
    expect(await tight.history(ctx(alice), "/shared/vbA/old.md")).toHaveLength(1);

    const tree = ["/shared/vbA/t/f0.bin", "/shared/vbA/t/f1.bin", "/shared/vbA/t/f2.bin"];
    for (const [i, p] of tree.entries())
      await tight.write(ctx(alice), p, Buffer.alloc(40_000, i + 1), "application/octet-stream");

    const res = await tight.rm(ctx(alice), "/shared/vbA/t", true);
    expect(res).toEqual({ removed: 4, unrecoverable: [] }); // the dir + 3 files
    // every file the rm removed is in the trash and really comes back...
    expect((await tight.listTrash(ctx(alice), "/shared/vbA/t")).map((t) => t.path).sort()).toEqual(
      tree,
    );
    for (const p of tree) await tight.restore(ctx(alice), p);
    // ...and the 150 KB of older history is what paid for it, so the table is
    // at-or-under budget rather than parked permanently above it.
    expect(await tight.history(ctx(alice), "/shared/vbA/old.md")).toHaveLength(0);
    expect(await versionBytes()).toBeLessThanOrEqual(budget);
  });

  it("an rm -r bigger than the whole budget reports every path it could not keep", async () => {
    await truncateVersions();
    // The degenerate case: one delete's snapshots outweigh the entire budget, so
    // not all of it can be retained. What must never happen is the old
    // behaviour — a plain success while a RANDOM subset (ordered by the uuid
    // primary key) was silently hard-deleted. Now the survivors are the
    // deterministic tail, and every casualty is named in the result.
    const budget = 100_000;
    const tight = new FsStore(fsPool, { versionBudgetBytes: budget });
    const paths = Array.from({ length: 6 }, (_, i) => `/shared/vbB/file${i}.bin`);
    for (const [i, p] of paths.entries())
      await tight.write(ctx(alice), p, Buffer.alloc(60_000, i + 1), "application/octet-stream");

    const res = await tight.rm(ctx(alice), "/shared/vbB", true);
    expect(res.removed).toBe(7); // the dir + 6 files
    // deterministic: oldest-first by path, keeping the newest tail that fits
    expect(res.unrecoverable).toEqual(paths.slice(0, 5));
    const trash = (await tight.listTrash(ctx(alice), "/shared/vbB")).map((t) => t.path).sort();
    expect(trash).toEqual(paths.slice(5));
    // the report is EXACT — what it names is gone, what it doesn't is restorable
    for (const p of res.unrecoverable)
      await expect(tight.restore(ctx(alice), p)).rejects.toThrow(/no version to restore/);
    await tight.restore(ctx(alice), paths[5]!);
    expect(await versionBytes()).toBeLessThanOrEqual(budget);
  });

  it("the budget is a HARD bound — an odd budget still lands the table under it", async () => {
    await truncateVersions();
    // Regression for the eviction off-by-one. The victim prefix used to stop at
    // the last row still STRICTLY under the excess, keeping the row that would
    // cross it, so the table never actually got under budget: with a budget that
    // is not a multiple of the snapshot size it parked permanently ABOVE the cap
    // (3 KB snapshots against a 4 KB budget settled at 6 KB and stayed there),
    // and a snapshot bigger than the whole budget was never evicted at all. The
    // rule deletes THROUGH the crossing row (`running - size_bytes < excess`),
    // so the post-condition is byte-exact, not "budget plus one snapshot".
    const budget = 4_000;
    const tight = new FsStore(fsPool, { versionBudgetBytes: budget });
    const body = Buffer.alloc(3_000, 0x61); // versionable text; 3000 ∤ 4000
    for (let i = 0; i < 4; i++) {
      await tight.write(ctx(alice), `/shared/vbX/f${i}.md`, body, "text/markdown");
      await tight.write(ctx(alice), `/shared/vbX/f${i}.md`, Buffer.from("z\n"), "text/markdown");
      expect(await versionBytesAll()).toBeLessThanOrEqual(budget);
    }
    // exactly one 3 KB snapshot fits, so that is the steady state — the newest.
    expect(await versionBytesAll()).toBe(3_000);
    expect(await tight.history(ctx(alice), "/shared/vbX/f3.md")).toHaveLength(1);

    // The degenerate shape on the OVERWRITE path (the rm path is covered above):
    // one snapshot larger than the ENTIRE budget keeps no history rather than
    // sitting over the cap forever — and the live write still lands untouched,
    // because history is never allowed to fail a write.
    const huge = Buffer.alloc(200_000, 0x62);
    await tight.write(ctx(alice), "/shared/vbX/huge.md", huge, "text/markdown");
    await tight.write(ctx(alice), "/shared/vbX/huge.md", Buffer.from("z\n"), "text/markdown");
    expect((await tight.read(ctx(alice), "/shared/vbX/huge.md")).bytes.toString()).toBe("z\n");
    expect(await tight.history(ctx(alice), "/shared/vbX/huge.md")).toHaveLength(0);
    expect(await versionBytesAll()).toBeLessThanOrEqual(budget);
  });

  it("version numbers are never REUSED, even after a path's whole history is evicted", async () => {
    await truncateVersions();
    // A version_no is a handle a human writes down ("roll back to v3"). It used
    // to be allocated as `max(surviving version_no) + 1`, so once eviction took
    // every row for a path the counter silently restarted at 1 — and the SAME
    // number then named completely different bytes. `restore <path> 3` after an
    // eviction did not fail honestly; it resolved to freshly-created content and
    // reported success. The high-water mark now lives outside the evictable
    // rows, so numbers only ever go up.
    const budget = 3_000;
    const tight = new FsStore(fsPool, { versionBudgetBytes: budget });
    const p = "/shared/vbM/mono.md";
    for (let i = 1; i <= 4; i++)
      await tight.write(ctx(alice), p, Buffer.from(`rev${i}\n`.repeat(60)));
    const before = (await tight.versionList(ctx(alice), p)).map((v) => v.version_no);
    expect(before[0]).toBe(3); // v1..v3 = the three prior states of four writes

    // Unrelated churn evicts every one of that path's rows (oldest-first, and
    // they ARE the oldest) — history for it is now empty.
    for (let i = 0; i < 3; i++) {
      await tight.write(ctx(alice), `/shared/vbM/churn${i}.md`, Buffer.alloc(1_500, 0x61));
      await tight.write(ctx(alice), `/shared/vbM/churn${i}.md`, Buffer.from("z\n"));
    }
    expect(await tight.versionList(ctx(alice), p)).toHaveLength(0);

    // The next snapshot of that path must NOT be numbered 1 again.
    await tight.write(ctx(alice), p, Buffer.from("after eviction\n"));
    const after = (await tight.versionList(ctx(alice), p)).map((v) => v.version_no);
    expect(after[0]!).toBeGreaterThan(before[0]!);

    // …and an evicted number resolves to nothing at all, rather than to some
    // later file's bytes: it says the history was evicted, in those words.
    await expect(tight.versionContent(ctx(alice), p, 2)).rejects.toThrow(/evicted/);
    await expect(tight.restore(ctx(alice), p, 2)).rejects.toThrow(/evicted/);
    // a number that was never issued still reads as a plain miss
    await expect(tight.versionContent(ctx(alice), p, 99)).rejects.toThrow(/no version 99/);

    // The same guarantee on the DELETE path: rm's trash snapshot numbers itself
    // off the same high-water mark, so a delete after an eviction cannot reissue
    // a number either.
    const del = await tight.rm(ctx(alice), p);
    expect(del.removed).toBe(1);
    const trashNos = (await tight.versionList(ctx(alice), p)).map((v) => v.version_no);
    expect(trashNos[0]!).toBeGreaterThan(after[0]!);

    // The mark itself is a PATH table, and a path in a home is as private as the
    // file: the request-serving role reaches it only through the exact-path
    // accessor, never by reading (or enumerating) rows.
    await expect(fsPool.query("SELECT * FROM fs_version_seq")).rejects.toMatchObject({
      code: "42501",
    });
    const su = await brain.connect("superuser");
    try {
      // The mark records what eviction DESTROYED (v3 here) — surviving rows
      // speak for themselves, so the allocation is greatest(max surviving, mark)
      // and only the reaper ever has to write.
      const mark = await su.query<{ last_no: number }>(
        "SELECT last_no FROM fs_version_seq WHERE path = $1",
        [p],
      );
      expect(mark.rows[0]!.last_no).toBe(before[0]!);
    } finally {
      await su.end();
    }
  });

  it("a box whose high-water migration hasn't landed still writes (numbering degrades, never fails)", async () => {
    await truncateVersions();
    // Same contract as the broken reaper above: history may lose a guarantee on
    // a box mid-update, but it may never take a live write down with it. With
    // 0048's accessor absent the store must fall back to the pre-0048 `max + 1`
    // allocation instead of failing every snapshot on a missing function.
    const su = await brain.connect("superuser");
    try {
      await su.query(
        "ALTER FUNCTION brain_fs_version_floor(text) RENAME TO brain_fs_version_floor_off",
      );
      const old = new FsStore(fsPool); // fresh instance ⇒ fresh capability probe
      const p = "/shared/vbP/pre48.md";
      await old.write(ctx(alice), p, Buffer.from("v1\n"));
      await old.write(ctx(alice), p, Buffer.from("v2\n"));
      expect((await old.read(ctx(alice), p)).bytes.toString()).toBe("v2\n");
      expect((await old.versionList(ctx(alice), p)).map((v) => v.version_no)).toEqual([1]);
      expect(await old.rm(ctx(alice), p)).toEqual({ removed: 1, unrecoverable: [] });
      expect(await old.restore(ctx(alice), p)).toMatchObject({ restoredFrom: 2 });
    } finally {
      await su.query(
        "ALTER FUNCTION brain_fs_version_floor_off(text) RENAME TO brain_fs_version_floor",
      );
      await su.end();
    }
  });

  // ---- soft-delete / trash / restore ----------------------------------------

  it("rm soft-deletes: content is restorable", async () => {
    await store.write(ctx(alice), "/home/alice/gone.md", Buffer.from("keepme\n"), "text/markdown");
    await store.rm(ctx(alice), "/home/alice/gone.md");
    expect(await store.exists(ctx(alice), "/home/alice/gone.md")).toBe(false);
    const trash = await store.listTrash(ctx(alice));
    expect(trash.map((t) => t.path)).toContain("/home/alice/gone.md");
    await store.restore(ctx(alice), "/home/alice/gone.md");
    const back = await store.read(ctx(alice), "/home/alice/gone.md");
    expect(back.bytes.toString()).toBe("keepme\n");
    // once restored it's a live path again — gone from the trash listing
    expect((await store.listTrash(ctx(alice))).map((t) => t.path)).not.toContain(
      "/home/alice/gone.md",
    );
  });

  it("recursive rm snapshots every descendant file (binary too), each restorable", async () => {
    await store.write(ctx(alice), "/home/alice/proj/a.md", Buffer.from("aaa"), "text/markdown");
    await store.write(ctx(alice), "/home/alice/proj/sub/b.bin", PNG, "image/png"); // binary
    await store.rm(ctx(alice), "/home/alice/proj", true);
    const trash = (await store.listTrash(ctx(alice), "/home/alice/proj")).map((t) => t.path).sort();
    expect(trash).toEqual(["/home/alice/proj/a.md", "/home/alice/proj/sub/b.bin"]);
    await store.restore(ctx(alice), "/home/alice/proj/sub/b.bin");
    expect((await store.read(ctx(alice), "/home/alice/proj/sub/b.bin")).bytes.equals(PNG)).toBe(
      true,
    );
  });

  // ---- (path, version_no) is a KEY, not a label -----------------------------

  it("a concurrent rm -r and write never mint two snapshots sharing one version_no", async () => {
    // The two ops lock DIFFERENT advisory keys — `rm -r` takes the DIRECTORY's,
    // `write` takes the FILE's — so nothing serialized their `max+1` reads and
    // both wrote v1 for one path. (path, version_no) is the pair every reader
    // keys on (versionContent, restore, versionList), so a duplicate means the
    // undo verb hands back whichever body the plan happened to reach.
    for (let round = 1; round <= 6; round++) {
      const dir = `/shared/race${round}`;
      const paths: string[] = [];
      for (let i = 0; i < 40; i++) {
        const p = `${dir}/f${i}.md`;
        paths.push(p);
        await store.write(ctx(alice), p, Buffer.from(`seed ${i}\n`), "text/markdown");
      }
      const hot = paths[20]!;
      const [rmRes, wrRes] = await Promise.allSettled([
        store.rm(ctx(alice), dir, true),
        store.write(ctx(alice), hot, Buffer.from(`clobber ${round}\n`), "text/markdown"),
      ]);
      // The loser of a version race RETRIES; neither op may fail, and neither
      // may quietly skip a snapshot to succeed.
      expect(
        [rmRes, wrRes].map((r) => (r.status === "fulfilled" ? "ok" : String(r.reason))),
      ).toEqual(["ok", "ok"]);
      // Every removed file is recoverable whatever the interleaving: a path is
      // either live again (the write re-created it after the delete) or sitting
      // in the trash with its delete snapshot.
      const trashed = new Set((await store.listTrash(ctx(alice), dir)).map((t) => t.path));
      for (const p of paths) {
        const live = await store.exists(ctx(alice), p);
        expect(live || trashed.has(p), `${p} vanished without a trash row`).toBe(true);
      }
    }
    // Read the WHOLE table (superuser bypasses RLS): the pair must identify one
    // row, everywhere, for every owner.
    const su = await brain.connect("superuser");
    try {
      const dupes = await su.query(
        `SELECT path, version_no, count(*) AS n FROM fs_versions
          GROUP BY path, version_no HAVING count(*) > 1`,
      );
      expect(dupes.rows).toEqual([]);
    } finally {
      await su.end();
    }
  }, 180_000);

  it("two NESTED rm -r never mint two snapshots sharing one version_no", async () => {
    // The other half of the same race, and the one a file-vs-directory framing
    // misses: BOTH racers are ancestor-scoped. `rm -r /a` keyed on '/a' and
    // `rm -r /a/b` on '/a/b' — neither is the other's key — yet both snapshot
    // every file under /a/b. Nothing serialized their `max+1` reads, so the
    // descendant got its delete snapshot twice under one number. It is fixed by
    // the same rule, not a second one: an rm -r takes the key of every FILE it
    // will snapshot, so the two ops meet on the descendant's key whichever
    // directories they were pointed at.
    for (let round = 1; round <= 10; round++) {
      const dir = `/shared/nested-race/${round}`;
      const deep = `${dir}/inner/doc.md`;
      const sibling = `${dir}/sibling.md`;
      await store.write(ctx(alice), deep, Buffer.from(`deep ${round}\n`), "text/markdown");
      await store.write(ctx(alice), sibling, Buffer.from(`side ${round}\n`), "text/markdown");
      const res = await Promise.allSettled([
        store.rm(ctx(alice), dir, true),
        store.rm(ctx(alice), `${dir}/inner`, true),
      ]);
      // Losing the subtree to the ancestor's rm is the one legitimate failure
      // (ENOENT); a version-race refusal (EAGAIN) or a raw pg error is not.
      for (const r of res) {
        if (r.status === "rejected") {
          expect(r.reason, `${dir}: unexpected rejection`).toMatchObject({ code: "not_found" });
        }
      }
      // Whoever won, the bytes are recoverable: both files sit in the trash.
      const trashed = new Set((await store.listTrash(ctx(alice), dir)).map((t) => t.path));
      for (const p of [deep, sibling]) {
        expect(trashed.has(p), `${p} vanished without a trash row`).toBe(true);
      }
      // And the delete snapshot is ONE row, holding the bytes that were live.
      expect(await store.versionContent(ctx(alice), deep, 1)).toEqual(
        Buffer.from(`deep ${round}\n`),
      );
      expect((await store.versionList(ctx(alice), deep)).map((v) => v.version_no)).toEqual([1]);
    }
    const su = await brain.connect("superuser");
    try {
      const dupes = await su.query(
        `SELECT path, version_no, count(*) AS n FROM fs_versions
          WHERE path LIKE '/shared/nested-race/%'
          GROUP BY path, version_no HAVING count(*) > 1`,
      );
      expect(dupes.rows).toEqual([]);
    } finally {
      await su.end();
    }
  }, 180_000);

  it("a tied version_no would make restore(path, v) non-deterministic — it can't tie", async () => {
    // The consequence the unique key exists for. `rm -r <dir>` racing a
    // `write <dir>/f.md` used to leave a 'delete' row and an 'overwrite' row
    // sharing ONE number, and the two answer restore differently: the overwrite
    // rolls the live file back, the delete refuses with EEXIST ("a deleted file
    // restores only to a free path"). With no tiebreak, which one `restore(f, 2)`
    // reached was physical row order — the SAME request succeeded on one run and
    // was refused on the next, and `history` printed two indistinguishable v2s.
    // So: every number a path's history shows is unique, addressing an
    // 'overwrite' version of a LIVE file always rolls it back to exactly the
    // bytes versionContent reports, and EEXIST is reachable only for a 'delete'
    // row the caller actually asked for.
    for (let round = 1; round <= 30; round++) {
      const dir = `/shared/tie-race/${round}`;
      const f = `${dir}/f.md`;
      await store.write(ctx(alice), f, Buffer.from("AAAA\n"), "text/markdown");
      await store.write(ctx(alice), f, Buffer.from("BBBB\n"), "text/markdown"); // v1 = AAAA
      const res = await Promise.allSettled([
        store.rm(ctx(alice), dir, true),
        store.write(ctx(alice), f, Buffer.from("CCCC\n"), "text/markdown"),
      ]);
      expect(
        res.map((r) => (r.status === "fulfilled" ? "ok" : String(r.reason))),
        `${f}: the version race must cost neither op`,
      ).toEqual(["ok", "ok"]);

      const hist = await store.versionList(ctx(alice), f);
      const numbers = hist.map((v) => v.version_no);
      expect(
        new Set(numbers).size,
        `history lists a repeated version: ${hist.map((v) => `v${v.version_no}:${v.reason}`).join(",")}`,
      ).toBe(numbers.length);

      // Put a live file back, then address every snapshot BY NUMBER — the shape
      // whose answer used to depend on which tied row the plan happened to hit.
      await store.write(ctx(alice), f, Buffer.from("LIVE\n"), "text/markdown");
      for (const v of hist) {
        const label = `${f} v${v.version_no} (${v.reason})`;
        if (v.reason === "delete") {
          await expect(store.restore(ctx(alice), f, v.version_no), label).rejects.toMatchObject({
            message: expect.stringContaining("EEXIST"),
          });
          continue;
        }
        const want = await store.versionContent(ctx(alice), f, v.version_no);
        const done = await store.restore(ctx(alice), f, v.version_no);
        expect(done.restoredFrom, label).toBe(v.version_no);
        expect((await store.read(ctx(alice), f)).bytes, label).toEqual(want);
      }
    }
  }, 180_000);

  it("the database itself refuses a duplicate (path, version_no)", async () => {
    const su = await brain.connect("superuser");
    try {
      const idx = await su.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'fs_versions' AND indexname = 'fs_versions_path_no_uniq'`,
      );
      expect(idx.rows[0]?.indexdef ?? "").toContain("UNIQUE");
      const ins = (body: string) =>
        su.query(
          `INSERT INTO fs_versions (path, version_no, reason, content, size_bytes, edited_by)
           VALUES ('/shared/uniq-proof.md', 1, 'overwrite', $1::bytea, octet_length($1::bytea), $2)`,
          [Buffer.from(body), alice],
        );
      await ins("REAL\n");
      await expect(ins("IMPOSTOR\n")).rejects.toMatchObject({ code: "23505" });
    } finally {
      await su.end();
    }
  });

  it("0047 de-duplicates a box that already carried duplicate version numbers", async () => {
    const mig = MIGRATIONS.find((m) => m.version === "0047")!;
    const dup = "/home/bob/legacy-dup.md"; // a HOME path: RLS-hidden from the runner
    const su = await brain.connect("superuser");
    try {
      // pre-0047 state: no unique index, and one path carrying two v1 rows —
      // exactly what an rm -r racing a write left behind.
      await su.query("DROP INDEX IF EXISTS fs_versions_path_no_uniq");
      await su.query(
        `INSERT INTO fs_versions
           (path, version_no, reason, content, size_bytes, owner_id, edited_by, created_at)
         VALUES ($1, 1, 'overwrite', $2::bytea, octet_length($2::bytea), $3, $3,
                 now() - interval '2 min'),
                ($1, 1, 'delete', $4::bytea, octet_length($4::bytea), $3, $3,
                 now() - interval '1 min')`,
        [dup, Buffer.from("older\n"), bob, Buffer.from("newer\n")],
      );
    } finally {
      await su.end();
    }
    // Run it the way a live box does: as brain_owner, in one transaction.
    const owner = await brain.connect("owner");
    try {
      await owner.query("BEGIN");
      await owner.query(mig.sql);
      await owner.query("COMMIT");
    } finally {
      await owner.end();
    }
    const after = await brain.connect("superuser");
    try {
      // Both snapshots survived — the LATER one was renumbered above the max,
      // so version_no stays monotone in time and nothing was destroyed.
      const rows = await after.query<{ version_no: number; content: Buffer }>(
        "SELECT version_no, content FROM fs_versions WHERE path = $1 ORDER BY version_no",
        [dup],
      );
      expect(rows.rows.map((r) => [r.version_no, r.content.toString()])).toEqual([
        [1, "older\n"],
        [2, "newer\n"],
      ]);
      const dupes = await after.query(
        `SELECT path FROM fs_versions GROUP BY path, version_no HAVING count(*) > 1`,
      );
      expect(dupes.rows).toEqual([]);
      // and the index is back, so it can't happen again
      const idx = await after.query(
        `SELECT 1 FROM pg_indexes
          WHERE tablename = 'fs_versions' AND indexname = 'fs_versions_path_no_uniq'`,
      );
      expect(idx.rowCount).toBe(1);
    } finally {
      await after.end();
    }
  }, 60_000);

  it("restore refuses onto an occupied path only for a delete-restore; older versions roll back", async () => {
    // a delete-snapshot resurrected onto a now-occupied path is EEXIST
    await store.write(ctx(alice), "/home/alice/occ.md", Buffer.from("first\n"), "text/markdown");
    await store.rm(ctx(alice), "/home/alice/occ.md");
    await store.write(ctx(alice), "/home/alice/occ.md", Buffer.from("second\n"), "text/markdown");
    await expect(store.restore(ctx(alice), "/home/alice/occ.md")).rejects.toMatchObject({
      message: expect.stringContaining("EEXIST"),
    });
    expect((await store.read(ctx(alice), "/home/alice/occ.md")).bytes.toString()).toBe("second\n");

    // but rolling back to an older OVERWRITE version onto the live file succeeds
    await store.write(ctx(alice), "/home/alice/roll.md", Buffer.from("r1\n"), "text/markdown");
    await store.write(ctx(alice), "/home/alice/roll.md", Buffer.from("r2\n"), "text/markdown");
    const hist = await store.history(ctx(alice), "/home/alice/roll.md");
    await store.restore(ctx(alice), "/home/alice/roll.md", hist[0]!.version_no);
    expect((await store.read(ctx(alice), "/home/alice/roll.md")).bytes.toString()).toBe("r1\n");
  });

  it("restore(path, versionNo) reverts to that version and is itself undoable", async () => {
    const p = "/home/alice/doc.md";
    await store.write(ctx(alice), p, Buffer.from("one\n"), "text/markdown"); // snapshotted by next write
    await store.write(ctx(alice), p, Buffer.from("two\n"), "text/markdown"); // fs_versions="one"
    const hist = await store.history(ctx(alice), p);
    // versionContent returns the exact bytes of a specific snapshot (for diff/UI)
    expect((await store.versionContent(ctx(alice), p, hist[0]!.version_no)).toString()).toBe(
      "one\n",
    );
    await store.restore(ctx(alice), p, hist[0]!.version_no); // back to "one"
    expect((await store.read(ctx(alice), p)).bytes.toString()).toBe("one\n");
    // "two" was snapshotted by the restore, so it's recoverable too
    expect((await store.history(ctx(alice), p)).some((h) => h.content.toString() === "two\n")).toBe(
      true,
    );
  });

  /**
   * A version number is caller input all the way down (HTTP body, bash operand,
   * dashboard). `version_no` is an int4, so a number past 2147483647 used to be
   * handed to Postgres raw and came back as a DatabaseError — "value
   * "3000000000" is out of range for type integer" — which HTTP rendered as a
   * 500 and bash printed into the sandbox. The parsers bound it now, but the
   * store is the last surface every caller shares, so it maps 22003
   * (numeric_value_out_of_range) to the SAME teaching error a merely-unknown
   * version gets: no raw pg error ever escapes FsStore.
   */
  it("an out-of-int4 version number is a teaching error, not a raw Postgres failure", async () => {
    const p = "/home/alice/vc/badnum.md";
    const HUGE = 3_000_000_000; // > int4 max, still a safe JS integer
    await store.write(ctx(alice), p, Buffer.from("one\n"), "text/markdown");
    await store.write(ctx(alice), p, Buffer.from("two\n"), "text/markdown"); // v1 exists

    for (const call of [
      () => store.restore(ctx(alice), p, HUGE),
      () => store.versionContent(ctx(alice), p, HUGE),
    ]) {
      const e = await call().then(
        () => null,
        (err: Error) => err,
      );
      expect(e).not.toBeNull();
      expect(e!.name).not.toBe("DatabaseError");
      expect(e!.message).not.toMatch(/out of range for type integer/);
      expect(e!.message).toContain(`no version ${HUGE} for ${p}`);
    }

    // …and the file itself is untouched by the refused restore.
    expect((await store.read(ctx(alice), p)).bytes.toString()).toBe("two\n");
  });

  /**
   * `restore`'s version argument is OPTIONAL, and "an argument was passed" is
   * not "the argument is truthy". Gated on truthiness, `restore(p, 0)` fell
   * through to the implicit "undo the last change" branch: no error, and the
   * live file was rewritten from a version the caller never named — an
   * explicit selector silently swapped for a different one. Every malformed
   * selector now refuses with EINVAL before a row is read, and only
   * `undefined` means "newest snapshot".
   */
  it("an explicit but malformed version selector is refused, never treated as 'newest'", async () => {
    const p = "/home/alice/vc/selector.md";
    await store.write(ctx(alice), p, Buffer.from("one\n"), "text/markdown");
    await store.write(ctx(alice), p, Buffer.from("two\n"), "text/markdown"); // v1 = "one\n"

    for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = await store.restore(ctx(alice), p, bad).then(
        () => null,
        (err: Error & { details?: { errno?: string } }) => err,
      );
      expect(e, `restore(${String(bad)}) must throw`).not.toBeNull();
      expect(e!.details?.errno).toBe("EINVAL");
      expect(e!.message).toMatch(/version must be a positive integer/);
      // Nothing was touched: not the live bytes, not the version history.
      expect((await store.read(ctx(alice), p)).bytes.toString()).toBe("two\n");
      expect((await store.history(ctx(alice), p)).map((h) => h.version_no)).toEqual([1]);
      // Same contract on the read side.
      await expect(store.versionContent(ctx(alice), p, bad)).rejects.toThrow(
        /version must be a positive integer/,
      );
    }

    // An explicit version that is well-formed but nonexistent stays ENOENT
    // ("you typed the wrong number"), and still mutates nothing.
    await expect(store.restore(ctx(alice), p, 99)).rejects.toThrow(/no version 99/);
    expect((await store.read(ctx(alice), p)).bytes.toString()).toBe("two\n");

    // …while omitting it entirely still means "undo the last change".
    expect((await store.restore(ctx(alice), p)).restoredFrom).toBe(1);
    expect((await store.read(ctx(alice), p)).bytes.toString()).toBe("one\n");
  });

  it("restore preserves the live bytes it replaces even when they are NOT versionable", async () => {
    // The roll-back branch used to preserve the live content through the WRITE
    // path's filter (text-ish mime, ≤1 MiB), so restoring over a big or binary
    // working copy silently shredded it: no snapshot, no error, and "undo the
    // restore" happily re-applied the SAME old bytes. A restore that cannot
    // preserve what it replaces is a destroy, not an undo — the preserve
    // snapshot is unconditional now, exactly like rm's delete-snapshot.

    // (a) live content OVER the 1 MiB version cap
    const big = "/home/alice/vc/report.md";
    await store.write(ctx(alice), big, Buffer.from("# tiny seed\n"), "text/markdown");
    const huge = Buffer.alloc(1_500_000, 0x62); // 1.5 MB — over FS_VERSION_MAX_FILE_BYTES
    await store.write(ctx(alice), big, huge, "text/markdown"); // snapshots the seed as v1
    await store.restore(ctx(alice), big, 1);
    expect((await store.read(ctx(alice), big)).bytes.toString()).toBe("# tiny seed\n");
    const bigHist = await store.history(ctx(alice), big);
    const kept = bigHist.find((h) => h.size_bytes === huge.length);
    expect(kept).toBeDefined(); // the oversized bytes we replaced survived
    expect(kept!.reason).toBe("overwrite");
    await store.restore(ctx(alice), big, kept!.version_no); // undo the restore
    expect((await store.read(ctx(alice), big)).bytes.equals(huge)).toBe(true);

    // (b) live content whose MIME is not versionable (binary)
    const bin = "/home/alice/vc/doc.md";
    await store.write(ctx(alice), bin, Buffer.from("markdown v1\n"), "text/markdown");
    await store.write(ctx(alice), bin, PNG, "image/png"); // snapshots "markdown v1" as v1
    await store.restore(ctx(alice), bin, 1);
    expect((await store.read(ctx(alice), bin)).bytes.toString()).toBe("markdown v1\n");
    const binKept = (await store.history(ctx(alice), bin)).find((h) => h.content.equals(PNG));
    expect(binKept).toBeDefined(); // the PNG bytes we replaced survived
    await store.restore(ctx(alice), bin, binKept!.version_no);
    expect((await store.read(ctx(alice), bin)).bytes.equals(PNG)).toBe(true);

    // (c) the result says what it did, so an agent can tell a real undo from a
    // no-op (the bash `restore` line and the HTTP response are built from it)
    const res = await store.restore(ctx(alice), bin, 1);
    expect(res.restoredFrom).toBe(1);
    expect(res.preserved).toMatchObject({ size_bytes: PNG.length });

    // (d) an EMPTY live file still preserves nothing (there are no bytes to keep)
    const empty = "/home/alice/vc/empty.md";
    await store.write(ctx(alice), empty, Buffer.from("seed\n"), "text/markdown");
    await store.write(ctx(alice), empty, Buffer.alloc(0), "text/markdown");
    const emptyRes = await store.restore(ctx(alice), empty, 1);
    expect(emptyRes.preserved).toBeNull();
    expect((await store.read(ctx(alice), empty)).bytes.toString()).toBe("seed\n");
  });

  it("trash is RLS-scoped: a foreign home's deletions never appear", async () => {
    await store.write(ctx(bob), "/home/bob/private.md", Buffer.from("bob only\n"), "text/markdown");
    await store.rm(ctx(bob), "/home/bob/private.md");
    // bob sees his own trashed file; alice never does
    expect((await store.listTrash(ctx(bob))).map((t) => t.path)).toContain("/home/bob/private.md");
    expect((await store.listTrash(ctx(alice))).map((t) => t.path)).not.toContain(
      "/home/bob/private.md",
    );
    // and alice can't restore what she can't see
    await expect(store.restore(ctx(alice), "/home/bob/private.md")).rejects.toThrow();
  });

  it("rename over an existing file snapshots the clobbered destination (mv is not a shredder)", async () => {
    // A destination-clobbering `mv` removes the destination row exactly like an
    // `rm` does, so it MUST leave the same delete-snapshot. It didn't: the
    // clobber branch DELETEd the loser with no snapshot, so `mv slop.md
    // thesis.md` destroyed thesis.md permanently while `rm thesis.md` stayed
    // fully recoverable — the trash guarantee silently bypassed by a rename.
    await store.write(
      ctx(alice),
      "/home/alice/mv/thesis.md",
      Buffer.from("SOURCE OF TRUTH\n"),
      "text/markdown",
    );
    await store.write(
      ctx(alice),
      "/home/alice/mv/draft.md",
      Buffer.from("slop\n"),
      "text/markdown",
    );
    await store.rename(ctx(alice), "/home/alice/mv/draft.md", "/home/alice/mv/thesis.md");
    expect((await store.read(ctx(alice), "/home/alice/mv/thesis.md")).bytes.toString()).toBe(
      "slop\n",
    );

    // the clobbered bytes survive as a delete-snapshot, exactly as an rm's do
    const hist = await store.history(ctx(alice), "/home/alice/mv/thesis.md");
    expect(hist.map((h) => [h.reason, h.content.toString()])).toEqual([
      ["delete", "SOURCE OF TRUTH\n"],
    ]);
    // it restores only to a FREE path (trash rule), so it stays EEXIST while
    // the intruder occupies it — recovery is: move the intruder aside, restore
    await expect(store.restore(ctx(alice), "/home/alice/mv/thesis.md")).rejects.toMatchObject({
      message: expect.stringContaining("EEXIST"),
    });
    await store.rename(ctx(alice), "/home/alice/mv/thesis.md", "/home/alice/mv/slop.md");
    expect((await store.listTrash(ctx(alice), "/home/alice/mv")).map((t) => t.path)).toContain(
      "/home/alice/mv/thesis.md",
    );
    await store.restore(ctx(alice), "/home/alice/mv/thesis.md");
    expect((await store.read(ctx(alice), "/home/alice/mv/thesis.md")).bytes.toString()).toBe(
      "SOURCE OF TRUTH\n",
    );

    // unconditional like rm's: a BINARY destination is captured too (the
    // text-ish/1 MiB versionable filter gates overwrites, never removals)
    await store.write(ctx(alice), "/home/alice/mv/img.png", PNG, "image/png");
    await store.write(ctx(alice), "/home/alice/mv/other.png", Buffer.from("x"), "image/png");
    await store.rename(ctx(alice), "/home/alice/mv/other.png", "/home/alice/mv/img.png");
    await store.rename(ctx(alice), "/home/alice/mv/img.png", "/home/alice/mv/tiny.png");
    await store.restore(ctx(alice), "/home/alice/mv/img.png");
    expect((await store.read(ctx(alice), "/home/alice/mv/img.png")).bytes.equals(PNG)).toBe(true);
  });

  // ---- locks ----------------------------------------------------------------

  it("a locked file refuses writes/rm/rename but allows reads", async () => {
    const p = "/shared/canon/thesis.md";
    await store.write(ctx(alice), p, Buffer.from("truth\n"), "text/markdown");
    await store.lock(ctx(alice), p);
    await expect(store.write(ctx(bob), p, Buffer.from("slop\n"))).rejects.toThrow(/ELOCKED/);
    await expect(store.rm(ctx(bob), p)).rejects.toThrow(/ELOCKED/);
    await expect(store.rename(ctx(bob), p, "/shared/canon/moved.md")).rejects.toThrow(/ELOCKED/);
    // reads are never blocked by a lock
    expect((await store.read(ctx(bob), p)).bytes.toString()).toBe("truth\n");
    await store.unlock(ctx(alice), p);
    await store.write(ctx(bob), p, Buffer.from("ok\n")); // now allowed
    expect((await store.read(ctx(bob), p)).bytes.toString()).toBe("ok\n");
  });

  it("locking a directory protects the whole subtree", async () => {
    await store.write(ctx(alice), "/shared/locked-dir/a.md", Buffer.from("a\n"), "text/markdown");
    await store.lock(ctx(alice), "/shared/locked-dir");
    await expect(
      store.write(ctx(bob), "/shared/locked-dir/a.md", Buffer.from("x\n")),
    ).rejects.toThrow(/ELOCKED/);
    // a brand-new file under the locked dir is refused too
    await expect(
      store.write(ctx(bob), "/shared/locked-dir/new.md", Buffer.from("y\n")),
    ).rejects.toThrow(/ELOCKED/);
    await store.unlock(ctx(alice), "/shared/locked-dir");
    await store.write(ctx(bob), "/shared/locked-dir/a.md", Buffer.from("x\n"));
  });

  // Regression: mkdir was the ONE mutator that never consulted locks (every
  // other one — write/append/rm/rename/restore — calls assertNotLocked), so a
  // second member could create directories anywhere inside a locked subtree
  // and land durable rows beside the protected content. It now runs the same
  // self+ancestor check; `mkdir -p` of a dir that ALREADY exists mutates
  // nothing, so that stays a success no-op even under the lock.
  it("mkdir is refused at or under a locked path, but -p of an existing dir stays a no-op", async () => {
    await store.write(ctx(alice), "/shared/mk/doc.md", Buffer.from("DOC\n"));
    await store.mkdir(ctx(alice), "/shared/mk/kept");
    await store.lock(ctx(alice), "/shared/mk");

    // directly-locked parent, deeper ancestor lock, and the locked path itself
    await expect(store.mkdir(ctx(bob), "/shared/mk/injected")).rejects.toThrow(
      /ELOCKED: \/shared\/mk is locked by alice/,
    );
    await expect(store.mkdir(ctx(bob), "/shared/mk/injected/deep")).rejects.toThrow(
      /ELOCKED: \/shared\/mk is locked by alice/,
    );
    // atomic refusal: not even the intermediate dir of the chain was created
    expect(await store.exists(ctx(alice), "/shared/mk/injected")).toBe(false);
    expect(await store.exists(ctx(alice), "/shared/mk/injected/deep")).toBe(false);
    expect((await store.list(ctx(alice), "/shared/mk")).map((e) => e.name).sort()).toEqual([
      "doc.md",
      "kept",
    ]);

    // -p on what already exists mutates nothing → still a success no-op
    await store.mkdir(ctx(bob), "/shared/mk/kept");
    await store.mkdir(ctx(bob), "/shared/mk");

    await store.unlock(ctx(alice), "/shared/mk");
    await store.mkdir(ctx(bob), "/shared/mk/injected/deep");
    expect(await store.exists(ctx(alice), "/shared/mk/injected/deep")).toBe(true);
  });

  // Regression: locks used to be checked only against the target and its
  // ANCESTORS, so `rm -r` (or a rename) of an UNLOCKED PARENT wiped locked
  // descendants — lock row and all — and the attacker could then recreate the
  // protected path with their own bytes. A subtree-scoped mutation must consult
  // locks BELOW it too, and refuse atomically (zero rows touched).
  it("a lock BELOW an unlocked parent refuses recursive rm and rename of that parent", async () => {
    await store.write(ctx(alice), "/shared/sub/proj/secret.md", Buffer.from("SECRET\n"));
    await store.write(ctx(alice), "/shared/sub/proj/plain.md", Buffer.from("PLAIN\n"));
    await store.lock(ctx(alice), "/shared/sub/proj/secret.md");

    // both subtree ops are refused, and the error names the locked DESCENDANT
    await expect(store.rm(ctx(bob), "/shared/sub", true)).rejects.toThrow(
      /ELOCKED: \/shared\/sub\/proj\/secret\.md is locked by alice/,
    );
    await expect(
      store.rename(ctx(bob), "/shared/sub/proj", "/shared/sub/hijacked"),
    ).rejects.toThrow(/ELOCKED: \/shared\/sub\/proj\/secret\.md is locked by alice/);

    // atomic refusal: nothing deleted, nothing moved, no snapshot rows queued
    expect(await store.exists(ctx(alice), "/shared/sub/proj/secret.md")).toBe(true);
    expect(await store.exists(ctx(alice), "/shared/sub/proj/plain.md")).toBe(true);
    expect(await store.exists(ctx(alice), "/shared/sub/hijacked")).toBe(false);
    expect((await store.read(ctx(alice), "/shared/sub/proj/secret.md")).bytes.toString()).toBe(
      "SECRET\n",
    );
    expect(await store.versionList(ctx(alice), "/shared/sub/proj/secret.md")).toEqual([]);
    expect(await store.versionList(ctx(alice), "/shared/sub/proj/plain.md")).toEqual([]);
    expect((await store.lockInfo(ctx(alice), "/shared/sub/proj/secret.md"))?.lockedByName).toBe(
      "alice",
    );

    // the descendant scan is segment-safe and doesn't over-block: a lookalike
    // sibling subtree, and a single-file rm elsewhere, are untouched
    await store.write(ctx(alice), "/shared/subZ/x.md", Buffer.from("Z\n"));
    expect((await store.rm(ctx(bob), "/shared/subZ", true)).removed).toBe(2);
    await store.write(ctx(alice), "/shared/sub/plain2.md", Buffer.from("P2\n"));
    expect((await store.rm(ctx(bob), "/shared/sub/plain2.md")).removed).toBe(1);

    // unlocking releases the parent again
    await store.unlock(ctx(alice), "/shared/sub/proj/secret.md");
    // /shared/sub + /shared/sub/proj + secret.md + plain.md
    expect((await store.rm(ctx(bob), "/shared/sub", true)).removed).toBe(4);
    expect(await store.exists(ctx(alice), "/shared/sub/proj/secret.md")).toBe(false);
  });

  it("lockInfo names the locker; locking a non-existent path is a teaching error", async () => {
    const p = "/shared/canon/who.md";
    await store.write(ctx(alice), p, Buffer.from("hi\n"), "text/markdown");
    expect(await store.lockInfo(ctx(bob), p)).toBeNull();
    await store.lock(ctx(alice), p);
    expect(await store.lockInfo(ctx(bob), p)).toMatchObject({ lockedByName: "alice" });
    await store.unlock(ctx(alice), p);
    await expect(store.lock(ctx(alice), "/shared/canon/nope.md")).rejects.toThrow(/cannot lock/);
  });

  it("only the locker or an owner may unlock", async () => {
    const p = "/shared/canon/held.md";
    await store.write(ctx(bob), p, Buffer.from("held\n"), "text/markdown");
    await store.lock(ctx(bob), p);
    // a non-owner who is not the locker cannot unlock (alice here is owner, so
    // use a fresh member to prove the boundary is the lock, not the role)
    const carol = (
      await new Admin(adminPool).createUser(alice, {
        name: "carol",
        email: "carol@example.com",
        permission: "member",
      })
    ).id;
    await expect(store.unlock(ctx(carol), p)).rejects.toThrow(/locked by/);
    // the owner can force-unlock
    await store.unlock(ctx(alice, { isOwner: true }), p);
    expect(await store.lockInfo(ctx(alice), p)).toBeNull();
  });

  // ---- limits ---------------------------------------------------------------

  it("rejects a file over the 25MB cap with an EFBIG teaching error", async () => {
    const fat = Buffer.alloc(MAX_FILE_BYTES + 1);
    await expect(store.write(ctx(alice), "/shared/fat.bin", fat)).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("EFBIG"),
    });
    expect(await store.exists(ctx(alice), "/shared/fat.bin")).toBe(false);
  });

  it("quota exhaustion is an ENOSPC teaching error and rolls the write back", async () => {
    const tight = new FsStore(fsPool, { quotaBytes: (await usage()) + 10 });
    await tight.write(ctx(alice), "/shared/fits.txt", Buffer.from("12345")); // 5 ≤ 10
    await expect(
      tight.write(ctx(alice), "/shared/too-big.txt", Buffer.from("123456789")),
    ).rejects.toMatchObject({
      code: "refused",
      message: expect.stringMatching(/ENOSPC: brain filesystem is full .* delete files/),
    });
    expect(await tight.exists(ctx(alice), "/shared/too-big.txt")).toBe(false);
    // the counter was not left inflated by the rolled-back write
    await tight.append(ctx(alice), "/shared/fits.txt", Buffer.from("67890"));
    await store.rm(ctx(alice), "/shared/fits.txt");
  });

  // ---- write scope / read-only ----------------------------------------------

  it("foreign-home writes are refused with the teaching error (every mutation)", async () => {
    const teach = /only \/shared, \/home\/<you> and \/tmp are writable/;
    await expect(store.write(ctx(bob), "/home/alice/hi.txt", Buffer.from("x"))).rejects.toThrow(
      teach,
    );
    await expect(store.append(ctx(bob), "/home/alice/hi.txt", Buffer.from("x"))).rejects.toThrow(
      teach,
    );
    await expect(store.mkdir(ctx(bob), "/home/alice/dir")).rejects.toThrow(teach);
    await expect(store.rm(ctx(bob), "/home/alice", true)).rejects.toThrow(teach);
    await expect(store.rename(ctx(bob), "/shared/log.txt", "/home/alice/log.txt")).rejects.toThrow(
      teach,
    );
    // outside the tree entirely, and the fixed roots themselves
    await expect(store.write(ctx(bob), "/etc/passwd", Buffer.from("x"))).rejects.toThrow(teach);
    await expect(store.rm(ctx(bob), "/shared", true)).rejects.toThrow(teach);
    await expect(store.rm(ctx(bob), "/home/bob", true)).rejects.toThrow(teach);
  });

  it("a read-only ctx gets EROFS on every mutation, reads still work", async () => {
    const ro = ctx(alice, { readOnly: true });
    await expect(store.write(ro, "/shared/ro.txt", Buffer.from("x"))).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("EROFS"),
    });
    await expect(store.mkdir(ro, "/shared/ro-dir")).rejects.toThrow(/EROFS/);
    await expect(store.rm(ro, "/shared/log.txt")).rejects.toThrow(/EROFS/);
    expect((await store.read(ro, "/shared/log.txt")).bytes.length).toBeGreaterThan(0);
  });

  // ---- privacy: absence + RLS -------------------------------------------------

  it("foreign homes are absent, not forbidden: uniform not_found + missing from ls", async () => {
    await store.write(ctx(alice), "/home/alice/secret.txt", Buffer.from("shh"));
    await expect(store.read(ctx(bob), "/home/alice/secret.txt")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(store.stat(ctx(bob), "/home/alice")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.list(ctx(bob), "/home/alice")).rejects.toMatchObject({ code: "not_found" });
    expect(await store.exists(ctx(bob), "/home/alice/secret.txt")).toBe(false);
    // /home lists ONLY the caller's own home
    expect((await store.list(ctx(bob), "/home")).map((e) => e.name)).toEqual(["bob"]);
    expect((await store.list(ctx(alice), "/home")).map((e) => e.name)).toEqual(["alice"]);
  });

  it("RLS proof: raw SQL as actor B sees 0 of A's home rows; WITH CHECK rejects", async () => {
    const c = await brain.connect("app");
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.actor_id', $1, true)", [bob]);
      const peek = await c.query("SELECT path FROM fs_entries WHERE path LIKE '/home/alice/%'");
      expect(peek.rowCount).toBe(0);
      const home = await c.query("SELECT path FROM fs_entries WHERE parent = '/home'");
      expect(home.rows.map((r: { path: string }) => r.path)).toEqual(["/home/bob"]);
      await expect(
        c.query(
          `INSERT INTO fs_entries (path, parent, name, kind, content, size_bytes, created_by, updated_by)
           VALUES ('/home/alice/sneak.txt', '/home/alice', 'sneak.txt', 'file', '\\x00', 1, $1, $1)`,
          [bob],
        ),
      ).rejects.toThrow(/row-level security/);
      await c.query("ROLLBACK");

      // no actor GUC at all ⇒ fail closed to shared-only (FORCE RLS)
      const cold = await c.query(
        "SELECT count(*)::int AS n FROM fs_entries WHERE owner_id IS NOT NULL",
      );
      expect(cold.rows[0]!.n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it("homeSlug resolves the caller's slug; slugs shape the tree", async () => {
    expect(await store.homeSlug(alice)).toBe("alice");
    expect(await store.homeSlug(bob)).toBe("bob");
  });
});
