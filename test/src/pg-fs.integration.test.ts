import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Admin, FsStore, runBash, type BashRunCtx } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * PgFs + runBash: bash IS the brain
 * filesystem. Proves live write-through persistence across execs, /tmp
 * ephemerality, foreign-home refusal through the /home stub (never
 * ghost-persisting), read-only EROFS, append coalescing (a `>>` loop is a
 * handful of store round-trips, not one per iteration), and timeout
 * durability — completed writes survive an exit-124 script.
 */

describe("PgFs write-through bash runner", () => {
  let brain: FreshBrain;
  let adminPool: Pool;
  let fsPool: Pool; // the dedicated small pool the store owns (box.ts shape)
  let store: FsStore;

  let alice: string; // owner → /home/alice
  let bob: string; // member → /home/bob

  const ctx = (actorId: string, slug: string, extra: Partial<BashRunCtx> = {}): BashRunCtx => ({
    actorId,
    slug,
    readOnly: false,
    ...extra,
  });

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

  it("writes persist across two runBash calls; the shell starts in $HOME", async () => {
    const r1 = await runBash(
      `pwd && echo "draft one" > notes.txt && echo "team doc" > /shared/team.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(r1.stderr).toBe("");
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toContain("/home/alice"); // cwd = the caller's home
    expect(r1.persisted).toContain("/home/alice/notes.txt");
    expect(r1.persisted).toContain("/shared/team.md");
    expect(r1.persisted_note).toMatch(/^persisted: wrote /);

    // a SECOND exec — fresh sandbox, same brain — reads what the first wrote
    const r2 = await runBash(`cat ~/notes.txt /shared/team.md`, ctx(alice, "alice"), store);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toBe("draft one\nteam doc\n");

    // …and so does the store directly (single source of truth)
    const direct = await store.read({ actorId: alice }, "/shared/team.md");
    expect(direct.bytes.toString()).toBe("team doc\n");
  });

  it("an empty mkdir persists (an INSERT, not a diff artifact)", async () => {
    const r1 = await runBash(`mkdir -p /shared/projects/apollo`, ctx(alice, "alice"), store);
    expect(r1.exitCode).toBe(0);
    expect(r1.persisted).toContain("/shared/projects/apollo");

    const r2 = await runBash(
      `ls /shared/projects && test -d /shared/projects/apollo && echo IS-DIR`,
      ctx(bob, "bob"),
      store,
    );
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toBe("apollo\nIS-DIR\n");
    expect((await store.stat({ actorId: bob }, "/shared/projects/apollo")).kind).toBe("dir");
  });

  it("/tmp is scratch: usable in one exec, gone the next, never persisted", async () => {
    const r1 = await runBash(
      `echo scratch > /tmp/work.txt && cat /tmp/work.txt`,
      ctx(alice, "alice"),
      store,
    );
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toBe("scratch\n");
    expect(r1.persisted ?? []).toEqual([]); // /tmp writes are not "persisted"

    const r2 = await runBash(`cat /tmp/work.txt`, ctx(alice, "alice"), store);
    expect(r2.exitCode).not.toBe(0);
    expect(r2.stderr).toContain("work.txt");
    await expect(store.stat({ actorId: alice }, "/tmp/work.txt")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("writes outside the writable roots teach instead of ghost-persisting", async () => {
    const r = await runBash(`echo x > /etc/passwd`, ctx(alice, "alice"), store);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/only \/shared, \/home\/<you> and \/tmp are writable/);
    expect(r.persisted ?? []).toEqual([]);
  });

  it("a foreign-home write fails LOUDLY via the /home stub and never lands", async () => {
    await store.write({ actorId: alice }, "/home/alice/secret.txt", Buffer.from("shh"));

    const w = await runBash(`echo pwned > /home/alice/hack.txt`, ctx(bob, "bob"), store);
    expect(w.exitCode).not.toBe(0);
    expect(w.stderr).toMatch(/only \/shared, \/home\/<you> and \/tmp are writable/);
    expect(w.persisted ?? []).toEqual([]);
    expect(await store.exists({ actorId: alice }, "/home/alice/hack.txt")).toBe(false);

    // privacy by absence: alice's home isn't in bob's namespace at all
    const r = await runBash(
      `ls /home; cat /home/alice/secret.txt; echo exit=$?`,
      ctx(bob, "bob"),
      store,
    );
    expect(r.stdout).toContain("bob");
    expect(r.stdout).not.toContain("alice");
    // uniform absence — the exact message any missing path gets, no denial oracle
    expect(r.stderr).toContain("cat: /home/alice/secret.txt: No such file or directory");
    expect(r.stdout).toContain("exit=1");
  });

  it("a read-only ctx reads everything but every write is EROFS", async () => {
    const ro = ctx(alice, "alice", { readOnly: true });
    const r = await runBash(`cat /shared/team.md`, ro, store);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("team doc\n");

    for (const script of [
      `echo x > /shared/nope.txt`,
      `echo x >> /shared/team.md`,
      `mkdir /shared/nope-dir`,
      `rm /shared/team.md`,
    ]) {
      const w = await runBash(script, ro, store);
      expect(w.exitCode, script).not.toBe(0);
      expect(w.stderr, script).toContain("EROFS");
    }
    expect(await store.exists({ actorId: alice }, "/shared/nope.txt")).toBe(false);
    expect(await store.exists({ actorId: alice }, "/shared/team.md")).toBe(true);
  });

  it("coalesces an append loop into a handful of store round-trips", async () => {
    const appendSpy = vi.spyOn(store, "append");
    try {
      const r = await runBash(
        `for i in $(seq 200); do echo line$i >> counts.log; done`,
        ctx(alice, "alice"),
        store,
      );
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.persisted).toContain("/home/alice/counts.log");
      // 200 iterations × 2 fs appends each — coalesced to a couple of UPDATEs
      expect(appendSpy.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      appendSpy.mockRestore();
    }

    const back = await store.read({ actorId: alice }, "/home/alice/counts.log");
    const lines = back.bytes.toString().split("\n").filter(Boolean);
    expect(lines.length).toBe(200);
    expect(lines[0]).toBe("line1");
    expect(lines[199]).toBe("line200");
  });

  it("timeout durability: exit 124, pre-timeout writes saved, trailer says so", async () => {
    const r = await runBash(
      `echo early bird > survived.txt
       echo buffered >> survived.txt
       sleep 60
       echo never-runs > too-late.txt`,
      ctx(alice, "alice"),
      store,
      { timeoutMs: 1500 },
    );
    expect(r.exitCode).toBe(124);
    expect(r.timed_out).toBe(true);
    expect(r.stderr).toContain("files written before the timeout were saved");
    expect(r.persisted).toContain("/home/alice/survived.txt");
    expect(r.persisted_note).toContain("/home/alice/survived.txt");

    const saved = await store.read({ actorId: alice }, "/home/alice/survived.txt");
    expect(saved.bytes.toString()).toBe("early bird\nbuffered\n"); // buffered append flushed too
    expect(await store.exists({ actorId: alice }, "/home/alice/too-late.txt")).toBe(false);
  }, 30_000);

  it("rm and mv persist through: delete + rename land in the trailer and the store", async () => {
    await runBash(
      `echo v1 > /shared/old-name.txt && mkdir -p /shared/attic`,
      ctx(alice, "alice"),
      store,
    );
    const r = await runBash(
      `mv /shared/old-name.txt /shared/attic/new-name.txt && rm -r /shared/projects`,
      ctx(alice, "alice"),
      store,
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.persisted).toContain("/shared/attic/new-name.txt");
    expect(r.deleted).toContain("/shared/old-name.txt");
    expect(r.deleted).toContain("/shared/projects");
    expect(r.persisted_note).toContain("deleted");

    expect(await store.exists({ actorId: alice }, "/shared/old-name.txt")).toBe(false);
    expect(await store.exists({ actorId: alice }, "/shared/projects")).toBe(false);
    const moved = await store.read({ actorId: alice }, "/shared/attic/new-name.txt");
    expect(moved.bytes.toString()).toBe("v1\n");
  });

  it("binary bytes survive the sandbox round-trip (pipes use readFileBytes)", async () => {
    // a real 1x1 PNG: NUL bytes + high bytes — mojibake would corrupt it
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    await store.write({ actorId: alice }, "/shared/pixel.png", png, "image/png");
    const r = await runBash(
      `cp /shared/pixel.png copy.png && cat copy.png | sha256sum | cut -d' ' -f1`,
      ctx(alice, "alice"),
      store,
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const { createHash } = await import("node:crypto");
    expect(r.stdout.trim()).toBe(createHash("sha256").update(png).digest("hex"));
    const copied = await store.read({ actorId: alice }, "/home/alice/copy.png");
    expect(copied.bytes.equals(png)).toBe(true);
  });

  it(
    "python WASM file I/O runs over PgFs itself (spike's production shape)",
    { timeout: 120_000 },
    async () => {
      const r = await runBash(
        `python3 -c "open('/shared/upper.txt','w').write(open('/shared/team.md').read().upper())"`,
        ctx(alice, "alice"),
        store,
      );
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.persisted).toContain("/shared/upper.txt");
      const out = await store.read({ actorId: alice }, "/shared/upper.txt");
      expect(out.bytes.toString()).toBe("TEAM DOC\n");
    },
  );

  it(
    "the offline python toolkit imports and does real work over the brain fs",
    { timeout: 180_000 },
    async () => {
      // -c form: every vendored package imports; openpyxl round-trips an xlsx
      // THROUGH the persistent brain filesystem (zipfile I/O over /host).
      const r = await runBash(
        `python3 -c "
import openpyxl, pypdf, bs4, tabulate, dateutil.parser, markdown
wb = openpyxl.Workbook(); ws = wb.active
ws.append(['name', 'qty']); ws.append(['apples', 12])
wb.save('inventory.xlsx')
back = openpyxl.load_workbook('inventory.xlsx').active
print('xlsx:', back['A2'].value, back['B2'].value)
print(tabulate.tabulate([['x', 1]], headers=['k', 'v']).splitlines()[0])
"`,
        ctx(alice, "alice"),
        store,
      );
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("xlsx: apples 12");
      expect(r.persisted).toContain("/home/alice/inventory.xlsx");
      // the workbook is REAL bytes in Postgres (a zip: PK magic)
      const saved = await store.read({ actorId: alice }, "/home/alice/inventory.xlsx");
      expect(saved.bytes.subarray(0, 2).toString()).toBe("PK");

      // script-file form goes through the runpy rewrite, argv intact
      await store.write(
        { actorId: alice },
        "/home/alice/args.py",
        Buffer.from("import sys, tabulate\nprint('argv-ok', sys.argv[1])\n"),
      );
      const s = await runBash(`python3 args.py hello`, ctx(alice, "alice"), store);
      expect(s.stderr).toBe("");
      expect(s.stdout).toContain("argv-ok hello");

      // heredoc / stdin form — the program arrives on stdin, so there is no
      // argv to carry the sys.path preamble; the shadow must inject it into the
      // stdin stream. This is the MOST natural way to write multi-line python,
      // and it silently missed the toolkit before the readsStdinProgram fix.
      const h = await runBash(
        `python3 <<'PY'\nimport openpyxl, bs4\nprint('heredoc-toolkit-ok')\nPY`,
        ctx(alice, "alice"),
        store,
      );
      expect(h.stderr).toBe("");
      expect(h.exitCode).toBe(0);
      expect(h.stdout).toContain("heredoc-toolkit-ok");
      // explicit `python3 -` is the same stdin path — also reaches the toolkit.
      // (NB: `from __future__` can't be exercised here — just-bash wraps every
      // program in a ~400-line harness, so a future-import is never line 1, on
      // -c/heredoc/stdin alike. That's a just-bash limit, not a toolkit one.)
      const dash = await runBash(
        `printf 'import tabulate\\nprint("dash-ok", len(tabulate.tabulate([[1]])))\\n' | python3 -`,
        ctx(alice, "alice"),
        store,
      );
      expect(dash.stderr).toBe("");
      expect(dash.stdout).toContain("dash-ok");

      // the toolkit itself is read-only — rm teaches instead of landing
      const w = await runBash(`rm -r /opt/python/openpyxl`, ctx(alice, "alice"), store);
      expect(w.exitCode).not.toBe(0);
      expect(w.stderr).toContain("EROFS");
      const still = await runBash(
        `python3 -c "import openpyxl; print('still-there')"`,
        ctx(alice, "alice"),
        store,
      );
      expect(still.stdout).toContain("still-there");
    },
  );

  it("a home-less caller (a pre-0037 historical service account) runs shared-only, not refused", async () => {
    // simulate a service account provisioned before 0037: no fs_homes row
    const bot = (
      await new Admin(adminPool).createUser(alice, {
        name: "bot",
        email: "bot@example.com",
        permission: "member",
      })
    ).id;
    // brain_app can't DELETE fs_homes (grants are SELECT/INSERT) — use su
    const su = await brain.connect("superuser");
    try {
      await su.query("DELETE FROM fs_homes WHERE actor_id = $1", [bot]);
    } finally {
      await su.end();
    }
    // (slug was never resolved for this account, so nothing is cached)
    expect(await store.homeSlugOrNull(bot)).toBeNull();

    // shell starts in /shared, no /home mount, USER=shared; /shared is usable
    const r = await runBash(
      `pwd; echo "$USER"; ls /home 2>&1 | head -1; echo bot-note > /shared/bot.txt`,
      { actorId: bot, slug: null, readOnly: false },
      store,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("/shared");
    expect(r.stdout).toContain("shared"); // USER
    expect(r.persisted).toContain("/shared/bot.txt");
    // the org tree is readable and what it wrote is durable
    expect((await store.read({ actorId: alice }, "/shared/bot.txt")).bytes.toString()).toBe(
      "bot-note\n",
    );
  });

  it("python respects timeout_ms past the 10s default cap", { timeout: 30_000 }, async () => {
    // just-bash caps sub-interpreters at 10s by default; runBash raises the
    // cap to the requested timeout. An 11s busy-loop under 20s must finish.
    const r = await runBash(
      `python3 -c "
import time
t = time.time()
while time.time() - t < 11: pass
print('past-ten')
"`,
      ctx(alice, "alice"),
      store,
      { timeoutMs: 20_000 },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("past-ten");
  });

  it(
    "python cannot read the real host filesystem — the sandbox boundary holds",
    { timeout: 120_000 },
    async () => {
      // The python /host mount is just-bash's virtual FS (our PgFs + guarded
      // base), NOT node's real disk — proven by the workflow security audit.
      // This negatively pins it: a real, secret-shaped host path that exists on
      // disk must be invisible inside the sandbox. A just-bash upgrade that
      // added a node:fs fallback would pass every positive test but fail here.
      const r = await runBash(
        `python3 -c "
import os
for p in ('/etc/passwd', '/etc/hosts', '${process.cwd().replace(/'/g, "")}/package.json'):
    print(p, os.path.exists(p))
"`,
        ctx(alice, "alice"),
        store,
      );
      expect(r.exitCode).toBe(0);
      // none of the real host paths resolve inside the sandbox
      expect(r.stdout).not.toContain("True");
      expect(r.stdout).toContain("/etc/passwd False");
    },
  );

  it("symlinks teach on the brain fs; chmod is an accepted no-op", async () => {
    const r = await runBash(
      `ln -s /shared/team.md /shared/link.md; echo ln-exit=$?; chmod 600 /shared/team.md && echo chmod-ok`,
      ctx(alice, "alice"),
      store,
    );
    expect(r.stdout).toContain("ln-exit=1");
    expect(r.stderr).toMatch(/symlinks are not supported/);
    expect(r.stdout).toContain("chmod-ok");
    expect(await store.exists({ actorId: alice }, "/shared/link.md")).toBe(false);
  });

  it("history/diff/restore are available as bash commands", async () => {
    // Seed the versions through the store, then drive the commands through the
    // real bash runner. (A shell `>` redirect truncates the file BEFORE writing
    // the new bytes — two store writes — so echo-based setup would interleave
    // empty overwrite snapshots and blur which version says what.)
    const w = (body: string) =>
      store.write({ actorId: alice }, "/home/alice/vc.md", Buffer.from(body), "text/markdown");
    await w("one\n");
    await w("two\n");

    const h = await runBash(`history /home/alice/vc.md`, ctx(alice, "alice"), store);
    expect(h.exitCode).toBe(0);
    expect(h.stdout).toMatch(/v1\b/);
    expect(h.stdout).toContain("overwrite");

    // No versions yet ⇒ a plain, non-fatal answer; a missing path is diff(1)'s
    // exit 2 "trouble", never a silent 0.
    await runBash(`echo fresh > /home/alice/fresh.md`, ctx(alice, "alice"), store);
    const none = await runBash(`history /home/alice/fresh.md`, ctx(alice, "alice"), store);
    expect(none.exitCode).toBe(0);
    const missing = await runBash(`history /home/alice/nope.md`, ctx(alice, "alice"), store);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("No such file or directory");

    // diff: last snapshot vs the working tree — differences are exit 1, like diff(1).
    const d = await runBash(`diff /home/alice/vc.md`, ctx(alice, "alice"), store);
    expect(d.exitCode).toBe(1);
    expect(d.stdout).toContain("-one");
    expect(d.stdout).toContain("+two");
    // explicit version vs the working tree, and version-vs-version
    const d1 = await runBash(`diff -q /home/alice/vc.md 1`, ctx(alice, "alice"), store);
    expect(d1.exitCode).toBe(1);
    expect(d1.stdout).toContain("differ");

    // The shadow does NOT cost us the builtin's file-vs-file compare.
    const two = await runBash(
      `printf 'a\\nb\\n' > /tmp/x && printf 'a\\nc\\n' > /tmp/y && diff /tmp/x /tmp/y; echo "rc=$?"; diff /tmp/x /tmp/x; echo "same=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(two.stdout).toContain("-b");
    expect(two.stdout).toContain("+c");
    expect(two.stdout).toContain("rc=1");
    expect(two.stdout).toContain("same=0");

    // restore rolls the live file back — and the same exec sees it (the mounts
    // are synced, not left holding a stale cache).
    const r = await runBash(
      `restore /home/alice/vc.md 1 && cat /home/alice/vc.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("one");
    // …and it says what it KEPT: the replaced bytes became a new version, so an
    // agent can tell a real (undoable) roll-back from a silent content shred.
    expect(r.stdout).toMatch(
      /restored \/home\/alice\/vc\.md from v1 \(previous content kept as v2/,
    );
    expect(r.persisted).toContain("/home/alice/vc.md");
    expect((await store.read({ actorId: alice }, "/home/alice/vc.md")).bytes.toString()).toBe(
      "one\n",
    );
  });

  /**
   * Regression (adversarial review 2026-07-22): bash is the ONLY write surface
   * an agent has and it declares no mime, so versionability was decided by the
   * extension table alone — a table that knew `.md/.txt/.json/.py` and nothing
   * else. Every source file, script and extensionless file an agent edits
   * (`app.ts`, `deploy.sh`, `schema.sql`, `Makefile`, `README`) was classified
   * `application/octet-stream` ⇒ binary ⇒ overwritten with NO history, while
   * `history` answered "no version history" — the same words a not-yet-edited
   * text file gets. Silent, and indistinguishable from safe.
   */
  it("code and extensionless files edited through bash keep history; `history` says why one can't", async () => {
    const names = ["app.ts", "deploy.sh", "schema.sql", "Makefile", "notes", ".gitignore"];
    const r = await runBash(
      `mkdir -p /shared/code && for f in ${names.join(" ")}; do echo v1 > /shared/code/$f; echo v2 > /shared/code/$f; done`,
      ctx(alice, "alice"),
      store,
    );
    expect(r.exitCode).toBe(0);
    const counts: Record<string, number> = {};
    for (const n of names)
      counts[n] = (await store.versionList({ actorId: alice }, `/shared/code/${n}`)).length;
    expect(counts).toEqual(Object.fromEntries(names.map((n) => [n, 1])));

    const h = await runBash(`history /shared/code/app.ts`, ctx(alice, "alice"), store);
    expect(h.exitCode).toBe(0);
    expect(h.stdout).toMatch(/v1\toverwrite/);
    // …and the prior draft really comes back
    const back = await runBash(
      `restore /shared/code/app.ts && cat /shared/code/app.ts`,
      ctx(alice, "alice"),
      store,
    );
    expect(back.stdout).toContain("v1");

    // A genuinely unversionable file no longer LOOKS like a fresh one.
    await store.write(
      { actorId: alice },
      "/shared/code/logo.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "image/png",
    );
    const png = await runBash(`history /shared/code/logo.png`, ctx(alice, "alice"), store);
    expect(png.exitCode).toBe(0);
    expect(png.stdout).toMatch(/binary \(image\/png\)/);
    expect(png.stdout).toContain("overwrites are not snapshotted");
    // while a text file with no edits yet keeps the plain, honest answer
    await runBash(`echo fresh > /shared/code/fresh.ts`, ctx(alice, "alice"), store);
    const fresh = await runBash(`history /shared/code/fresh.ts`, ctx(alice, "alice"), store);
    expect(fresh.stdout).toBe("no version history for /shared/code/fresh.ts\n");
  });

  it("diff keeps the shadowed builtin's contract and refuses a heap bomb", async () => {
    // Every case below is a regression the first cut of the shadow shipped
    // (adversarial review 2026-07-21): the builtin compared raw strings, read
    // `-` from stdin, took clustered short flags, and answered -q without
    // diffing at all.

    // A trailing-newline-only difference IS a difference.
    const nl = await runBash(
      `printf 'a\\nb' > /tmp/n1; printf 'a\\nb\\n' > /tmp/n2; diff /tmp/n1 /tmp/n2; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(nl.stdout).toContain("rc=1");
    expect(nl.stdout).toContain("No newline at end of file");

    // `-` is stdin, not a file named "-".
    const stdin = await runBash(
      `printf 'b\\n' > /tmp/s1; printf 'a\\n' | diff - /tmp/s1; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(stdin.stderr).not.toContain("No such file");
    expect(stdin.stdout).toContain("-a");
    expect(stdin.stdout).toContain("+b");
    expect(stdin.stdout).toContain("rc=1");

    // Clustered short flags parse char-by-char (-qi = -q -i): case-only
    // difference under -i is "identical", so rc=0 proves BOTH letters landed.
    const cluster = await runBash(
      `printf 'A\\n' > /tmp/c1; printf 'a\\n' > /tmp/c2; diff -qi /tmp/c1 /tmp/c2; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(cluster.stderr).not.toContain("invalid option");
    expect(cluster.stdout).toContain("rc=0");
    const bad = await runBash(`diff -z /tmp/c1 /tmp/c2`, ctx(alice, "alice"), store);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("invalid option -- 'z'");

    // Two big text files: the unified body refuses (exit 2) instead of
    // allocating, but -q still answers from the compare alone.
    const big = (ch: string) => Buffer.from(`${ch}\n`.repeat(700_000)); // ~1.4MB
    await store.write({ actorId: alice }, "/home/alice/big1.txt", big("x"), "text/plain");
    await store.write({ actorId: alice }, "/home/alice/big2.txt", big("y"), "text/plain");
    const heavy = await runBash(
      `diff /home/alice/big1.txt /home/alice/big2.txt; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(heavy.stdout).toContain("rc=2");
    expect(heavy.stderr).toMatch(/too large/);
    const brief = await runBash(
      `diff -q /home/alice/big1.txt /home/alice/big2.txt; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(brief.stdout).toContain("differ");
    expect(brief.stdout).toContain("rc=1");

    // Version mode inherits the same raw compare: a snapshot that only lost
    // its final newline still renders as a change.
    const w = (body: string) =>
      store.write({ actorId: alice }, "/home/alice/nl.md", Buffer.from(body), "text/markdown");
    await w("keep\n");
    await w("keep");
    const vnl = await runBash(`diff /home/alice/nl.md; echo "rc=$?"`, ctx(alice, "alice"), store);
    expect(vnl.stdout).toContain("rc=1");
    expect(vnl.stdout).toContain("No newline at end of file");
  });

  it("diff decides identity on BYTES — non-UTF-8 files are never called identical", async () => {
    // Regression (adversarial review 2026-07-22): `diff` decoded both sides
    // with toString("utf8") and compared the STRINGS. Every invalid byte
    // decodes to U+FFFD, so two files whose bytes genuinely differ collapsed
    // to the same string: `diff -s <path>` printed "are identical" and every
    // form exited 0 — diff(1)'s "no differences" — while the snapshot and the
    // working tree really did differ. A script keying on the exit code (the
    // normal way to use diff) was actively misled, and the lie reached any
    // versionable extension (.txt/.csv/.md/.json/.py…) holding latin-1,
    // cp1252 or otherwise binary-ish bytes.
    const c = { actorId: alice };

    // Same length, same decoded string (U+FFFD U+FFFD), different bytes.
    await store.write(c, "/shared/bin/x.txt", Buffer.from([0xff, 0xfe]), "text/plain");
    await store.write(c, "/shared/bin/x.txt", Buffer.from([0xfe, 0xff]), "text/plain");
    const v = await store.versionList(c, "/shared/bin/x.txt");
    expect(v).toHaveLength(1);
    expect(
      (await store.versionContent(c, "/shared/bin/x.txt", v[0]!.version_no)).toString("hex"),
    ).toBe("fffe");
    expect((await store.read(c, "/shared/bin/x.txt")).bytes.toString("hex")).toBe("feff");

    // …so no form may claim identity: GNU's answer, exit 1, for -s/-q/default.
    for (const flag of ["-s", "-q", ""]) {
      const r = await runBash(`diff ${flag} /shared/bin/x.txt`, ctx(alice, "alice"), store);
      expect(r.exitCode, `diff ${flag}`).toBe(1);
      expect(r.stdout, `diff ${flag}`).toBe(
        "Binary files /shared/bin/x.txt@v1 and /shared/bin/x.txt differ\n",
      );
    }

    // The file-vs-file passthrough is reimplemented here, so it had the same
    // hole — and read its operands as utf8, losing the bytes before comparing.
    await store.write(c, "/shared/bin/a.txt", Buffer.from([0xff, 0xfe]), "text/plain");
    await store.write(c, "/shared/bin/b.txt", Buffer.from([0xfe, 0xff]), "text/plain");
    const ff = await runBash(
      `diff -s /shared/bin/a.txt /shared/bin/b.txt; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(ff.stdout).toContain("Binary files /shared/bin/a.txt and /shared/bin/b.txt differ");
    expect(ff.stdout).toContain("rc=1");

    // Truly equal bytes are still identical (the fix must not cry wolf), and
    // a NUL is binary even though it round-trips through UTF-8.
    await store.write(c, "/shared/bin/c.txt", Buffer.from([0xff, 0xfe]), "text/plain");
    const same = await runBash(
      `diff -s /shared/bin/a.txt /shared/bin/c.txt; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(same.stdout).toContain("are identical");
    expect(same.stdout).toContain("rc=0");
    await store.write(c, "/shared/bin/n1.txt", Buffer.from([0x61, 0x00, 0x62]), "text/plain");
    await store.write(c, "/shared/bin/n2.txt", Buffer.from([0x61, 0x00, 0x63]), "text/plain");
    const nul = await runBash(
      `diff /shared/bin/n1.txt /shared/bin/n2.txt; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(nul.stdout).toContain("Binary files");
    expect(nul.stdout).toContain("rc=1");

    // Valid multibyte UTF-8 is TEXT, not binary: it still gets a real patch.
    const u = (body: string) =>
      store.write(c, "/shared/bin/u.md", Buffer.from(body, "utf8"), "text/markdown");
    await u("héllo 😀 线上\n");
    await u("héllo 😀 线下\n");
    const uni = await runBash(`diff /shared/bin/u.md; echo "rc=$?"`, ctx(alice, "alice"), store);
    expect(uni.stdout).not.toContain("Binary files");
    expect(uni.stdout).toContain("-héllo 😀 线上");
    expect(uni.stdout).toContain("+héllo 😀 线下");
    expect(uni.stdout).toContain("rc=1");

    // -i still folds ASCII case for the compare (diff(1)'s own answer), but it
    // only ever runs on text — it can no longer promote differing bytes.
    const ic = await runBash(
      `printf 'A\\n' > /tmp/i1; printf 'a\\n' > /tmp/i2; diff -si /tmp/i1 /tmp/i2; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(ic.stdout).toContain("are identical");
    expect(ic.stdout).toContain("rc=0");
    const icbin = await runBash(
      `diff -i /shared/bin/a.txt /shared/bin/b.txt; echo "rc=$?"`,
      ctx(alice, "alice"),
      store,
    );
    expect(icbin.stdout).toContain("Binary files");
    expect(icbin.stdout).toContain("rc=1");
  });

  it("diff between two SNAPSHOTS is byte-decided too; history exposes each sha256", async () => {
    // The same U+FFFD fusion reached the snapshot-vs-snapshot arm
    // (`diff <path> <a> <b>`), which never touches the working tree — and
    // that arm is how an agent audits history, so "identical" there hid a
    // real edit. Delete-snapshots (rm) are used deliberately: a versionable
    // path can hold non-UTF-8 bytes, and `rm` is the other snapshot maker.
    const c = { actorId: alice };
    const p = "/shared/binv/two.txt";
    await store.write(c, p, Buffer.from([0x80, 0x81, 0x82]), "text/plain");
    await store.rm(c, p);
    await store.write(c, p, Buffer.from([0x90, 0x91, 0x92]), "text/plain");
    await store.rm(c, p);
    const [v1, v2] = [await store.versionContent(c, p, 1), await store.versionContent(c, p, 2)];
    expect(v1.toString("hex")).toBe("808182");
    expect(v2.toString("hex")).toBe("909192");
    expect(v1.equals(v2)).toBe(false); // the bytes really do differ…

    // …so no flag combination may call them identical or exit 0.
    for (const flag of ["-q", "-s", "-qs", ""]) {
      const r = await runBash(`diff ${flag} ${p} 1 2`, ctx(alice, "alice"), store);
      expect(r.exitCode, `diff ${flag}`).toBe(1);
      expect(r.stdout, `diff ${flag}`).toBe(`Binary files ${p}@v1 and ${p}@v2 differ\n`);
    }
    // A snapshot compared with ITSELF is still identical — no crying wolf.
    const self = await runBash(`diff -s ${p} 2 2; echo "rc=$?"`, ctx(alice, "alice"), store);
    expect(self.stdout).toContain(`Files ${p}@v2 and ${p}@v2 are identical`);
    expect(self.stdout).toContain("rc=0");

    // `history` carries each snapshot's sha256 (abbreviated): the sandbox has
    // no cmp/xxd/sha256sum, so this is an agent's only byte-level signal for
    // snapshots it cannot otherwise hash — and distinct bytes must show
    // distinct hashes.
    const h = await runBash(`history ${p}`, ctx(alice, "alice"), store);
    expect(h.exitCode).toBe(0);
    const [head, ...lines] = h.stdout.trim().split("\n");
    expect(head).toBe("VERSION\tREASON\tSIZE\tSHA256\tEDITED_BY\tWHEN");
    const shaOf = (vn: string): string => {
      const row = lines.find((l) => l.startsWith(`${vn}\t`));
      expect(row, `history row for ${vn}`).toBeDefined();
      return row!.split("\t")[3]!;
    };
    const [s1, s2] = [shaOf("v1"), shaOf("v2")];
    expect(s1).toMatch(/^[0-9a-f]{12}$/);
    expect(s2).toMatch(/^[0-9a-f]{12}$/);
    expect(s1).not.toBe(s2);
    // The printed prefixes are the REAL digests, not decorative.
    const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 12);
    expect(s1).toBe(sha(v1));
    expect(s2).toBe(sha(v2));
  });

  it("a shell `>` overwrite records ONE snapshot of the REAL prior bytes", async () => {
    // Regression (adversarial review 2026-07-21, critical): a `>` redirect is
    // truncate-THEN-write in the sandbox — two FsStore mutations on one path —
    // so the snapshot fired twice and the newest version was the 0-byte
    // truncation the shell had just made. `restore <path>` with no version
    // takes the newest snapshot, so the documented undo verb WIPED the file to
    // empty instead of recovering it. Everything below drives the agent-facing
    // bash surface (never store.write), because that was the only path that
    // reproduced it.

    // 1. A brand-new file created by `>` has NO prior content ⇒ no version row.
    const fresh = await runBash(
      `mkdir -p /shared/vc1 && echo ORIGINAL > /shared/vc1/doc.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(fresh.exitCode).toBe(0);
    expect(await store.versionList({ actorId: alice }, "/shared/vc1/doc.md")).toEqual([]);

    // 2. One logical shell edit ⇒ exactly ONE snapshot, holding the real prior text.
    const edit = await runBash(`echo EDITED > /shared/vc1/doc.md`, ctx(alice, "alice"), store);
    expect(edit.exitCode).toBe(0);
    const vs = await store.versionList({ actorId: alice }, "/shared/vc1/doc.md");
    expect(vs.map((v) => [v.version_no, v.reason, v.size_bytes])).toEqual([
      [1, "overwrite", "ORIGINAL\n".length],
    ]);

    // 3. `diff` with no version diffs the working tree against that real prior
    //    snapshot — not "@@ -0,0 +1,1 @@ +EDITED", which is what an empty
    //    newest-version made it print.
    const d = await runBash(`diff /shared/vc1/doc.md`, ctx(alice, "alice"), store);
    expect(d.exitCode).toBe(1);
    expect(d.stdout).toContain("-ORIGINAL");
    expect(d.stdout).toContain("+EDITED");

    // 4. `restore` with no version brings the real content back — never an
    //    empty file the user never had.
    const back = await runBash(
      `restore /shared/vc1/doc.md && cat /shared/vc1/doc.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(back.exitCode).toBe(0);
    expect(back.stdout).toContain("ORIGINAL");
    expect((await store.read({ actorId: alice }, "/shared/vc1/doc.md")).bytes.toString()).toBe(
      "ORIGINAL\n",
    );

    // 5. N shell edits leave N REAL revisions — the retention budget buys
    //    KEEP_PER_PATH real revisions, not half that.
    await runBash(
      `mkdir -p /shared/vc2 && for i in 1 2 3 4 5; do echo "rev$i" > /shared/vc2/n.md; done`,
      ctx(alice, "alice"),
      store,
    );
    const many = await store.versionList({ actorId: alice }, "/shared/vc2/n.md");
    expect(many.map((v) => v.size_bytes)).not.toContain(0); // no interleaved 0B rows
    expect(many).toHaveLength(4); // rev1..rev4 preserved; rev5 is live
    const h = await runBash(`history /shared/vc2/n.md`, ctx(alice, "alice"), store);
    expect(h.stdout).not.toMatch(/\t0B\t/);
    const r5 = await runBash(
      `restore /shared/vc2/n.md && cat /shared/vc2/n.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(r5.stdout).toContain("rev4");

    // 6. A deliberate truncate-and-stop keeps the real content as the newest
    //    snapshot (nothing junk lands on top of it), and an EMPTY file is still
    //    fully recoverable from an `rm` — that snapshot is rm's own
    //    reason='delete' row, which this guard does not touch.
    const trunc = await runBash(
      `mkdir -p /shared/vc3 && echo KEEPME > /shared/vc3/t.md && > /shared/vc3/t.md && rm /shared/vc3/t.md && restore /shared/vc3/t.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(trunc.exitCode).toBe(0);
    // the empty file came back, as itself
    expect((await store.read({ actorId: alice }, "/shared/vc3/t.md")).bytes.length).toBe(0);
    const t = await store.versionList({ actorId: alice }, "/shared/vc3/t.md");
    expect(t.some((v) => v.reason === "delete" && v.size_bytes === 0)).toBe(true);
    expect(t.some((v) => v.reason === "overwrite" && v.size_bytes === "KEEPME\n".length)).toBe(
      true,
    );

    // 7. The heredoc form (`cat > f <<EOF`) truncates the same way, so it gets
    //    the same treatment: one snapshot of the real prior bytes, and
    //    `restore` brings those bytes back.
    await runBash(
      `mkdir -p /shared/vc4 && printf 'v1 body\\n' > /shared/vc4/h.md`,
      ctx(alice, "alice"),
      store,
    );
    const hd = await runBash(
      `cat > /shared/vc4/h.md <<'EOF'\nv2 body\nEOF\nrestore /shared/vc4/h.md && cat /shared/vc4/h.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(hd.exitCode).toBe(0);
    expect(hd.stdout).toContain("v1 body");
    expect((await store.read({ actorId: alice }, "/shared/vc4/h.md")).bytes.toString()).toBe(
      "v1 body\n",
    );
    expect(
      (await store.versionList({ actorId: alice }, "/shared/vc4/h.md")).filter(
        (v) => v.reason === "overwrite" && v.size_bytes === 0,
      ),
    ).toEqual([]);
  });

  it("the 0-byte-truncation guard holds INSIDE one exec, and for python's open(…,'w')", async () => {
    // Companion regression to the test above, pinning the two shapes an agent
    // actually types that it did not cover. Both matter because the truncate
    // and the content write land in DIFFERENT places in the PgFs pipeline
    // depending on the writer: within one exec the mount's append buffer and
    // stat/list memos are live between the two mutations (a cross-exec pair
    // starts from a cold sandbox each time), and python3's file object writes
    // through the shadow rather than the shell's redirect. If the guard ever
    // moves from the store's choke point up into `diff`/`restore`, the
    // single-exec form is the one that regresses first.

    // 1. THE reported repro verbatim: create, edit and diff in ONE script. The
    //    bug printed "@@ -0,0 +1,1 @@" with a body of "+EDITED" only — telling
    //    the agent the file had no prior content and never showing the text it
    //    had just destroyed.
    const oneExec = await runBash(
      `mkdir -p /shared/vc5 && echo ORIGINAL > /shared/vc5/doc.md && echo EDITED > /shared/vc5/doc.md && diff /shared/vc5/doc.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(oneExec.exitCode).toBe(1); // diff's "they differ"
    expect(oneExec.stdout).toContain("-ORIGINAL");
    expect(oneExec.stdout).toContain("+EDITED");
    expect(oneExec.stdout).toContain("@@ -1,1 +1,1 @@"); // a replacement, NOT "-0,0"
    expect(
      (await store.versionList({ actorId: alice }, "/shared/vc5/doc.md")).map((v) => [
        v.version_no,
        v.reason,
        v.size_bytes,
      ]),
    ).toEqual([[1, "overwrite", "ORIGINAL\n".length]]);

    // 2. python3's `open(path, 'w')` truncates then writes exactly like `>`,
    //    through the python shadow instead of the shell redirect.
    await runBash(
      `mkdir -p /shared/vc6 && echo ORIGINAL > /shared/vc6/p.md`,
      ctx(alice, "alice"),
      store,
    );
    const py = await runBash(
      `python3 -c "open('/shared/vc6/p.md','w').write('EDITED\\n')"`,
      ctx(alice, "alice"),
      store,
    );
    expect(py.exitCode).toBe(0);
    expect((await store.read({ actorId: alice }, "/shared/vc6/p.md")).bytes.toString()).toBe(
      "EDITED\n",
    );
    expect(
      (await store.versionList({ actorId: alice }, "/shared/vc6/p.md")).map((v) => [
        v.version_no,
        v.reason,
        v.size_bytes,
      ]),
    ).toEqual([[1, "overwrite", "ORIGINAL\n".length]]);
    const pyBack = await runBash(
      `diff /shared/vc6/p.md; restore /shared/vc6/p.md && cat /shared/vc6/p.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(pyBack.stdout).toContain("-ORIGINAL");
    expect(pyBack.stdout).toContain("+EDITED");
    expect((await store.read({ actorId: alice }, "/shared/vc6/p.md")).bytes.toString()).toBe(
      "ORIGINAL\n",
    );
  });

  it("re-saving UNCHANGED text spends no retention budget — the real revision survives", async () => {
    // Regression (adversarial review 2026-07-21): the retention budget is
    // FS_VERSION_KEEP_PER_PATH *real* revisions, so a non-edit must not buy a
    // slot. Agents re-emit whole files constantly (a formatter that changed
    // nothing, a re-run script), and every such re-save used to snapshot a
    // fresh copy of the live bytes: ten of them filled all ten slots with
    // copies of the working tree and EVICTED the last real revision. The file
    // then had a "history" that could not answer either question it exists for
    // — `diff <path>` printed nothing (newest snapshot == live) and
    // `restore <path>` handed back the bytes already on disk, reporting
    // success. The shell shape is the one that matters: `>` is
    // truncate-THEN-append, so the store never sees the new bytes beside the
    // old ones and only the consecutive-identical rule catches it.
    await runBash(
      `mkdir -p /shared/vc7 && echo ORIGINAL > /shared/vc7/doc.md && echo CHANGED > /shared/vc7/doc.md`,
      ctx(alice, "alice"),
      store,
    );
    // …now 12 re-saves of the SAME text: one logical no-op, twelve times.
    for (let i = 0; i < 12; i++) {
      const r = await runBash(`echo CHANGED > /shared/vc7/doc.md`, ctx(alice, "alice"), store);
      expect(r.exitCode).toBe(0);
    }

    // The ONE real revision is still there — not evicted by no-op noise — and
    // history never grew a run of identical rows.
    const vs = await store.versionList({ actorId: alice }, "/shared/vc7/doc.md");
    expect(vs.map((v) => v.size_bytes)).toEqual([
      "CHANGED\n".length, // the state before the first no-op
      "ORIGINAL\n".length, // the real prior revision, still recoverable
    ]);
    expect(new Set(vs.map((v) => v.sha256)).size).toBe(2); // no duplicate rows

    // `diff <path>` answers "what actually changed", never "nothing" — it picks
    // the newest snapshot that DIFFERS from the working tree.
    const d = await runBash(`diff /shared/vc7/doc.md`, ctx(alice, "alice"), store);
    expect(d.exitCode).toBe(1); // they differ
    expect(d.stdout).toContain("-ORIGINAL");
    expect(d.stdout).toContain("+CHANGED");

    // …and bare `restore` undoes that real edit, not the no-op on top of it.
    const back = await runBash(
      `restore /shared/vc7/doc.md && cat /shared/vc7/doc.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(back.exitCode).toBe(0);
    expect(back.stdout).toContain("ORIGINAL");
    expect((await store.read({ actorId: alice }, "/shared/vc7/doc.md")).bytes.toString()).toBe(
      "ORIGINAL\n",
    );

    // The same rule at the store's own door: a byte-identical store.write and a
    // zero-byte append are non-edits too, and neither buys a slot.
    const before = await store.versionList({ actorId: alice }, "/shared/vc7/doc.md");
    await store.write({ actorId: alice }, "/shared/vc7/doc.md", Buffer.from("ORIGINAL\n"));
    await store.append({ actorId: alice }, "/shared/vc7/doc.md", Buffer.alloc(0));
    expect(await store.versionList({ actorId: alice }, "/shared/vc7/doc.md")).toEqual(before);
  });

  it("restore --list surfaces the trash from inside the sandbox", async () => {
    await runBash(
      `echo gone > /home/alice/gone.md && rm /home/alice/gone.md`,
      ctx(alice, "alice"),
      store,
    );
    const t = await runBash(`restore --list`, ctx(alice, "alice"), store);
    expect(t.exitCode).toBe(0);
    expect(t.stdout).toContain("/home/alice/gone.md");
    // and the listed path restores by name
    const back = await runBash(
      `restore /home/alice/gone.md && cat /home/alice/gone.md`,
      ctx(alice, "alice"),
      store,
    );
    expect(back.exitCode).toBe(0);
    expect(back.stdout).toContain("gone");
    // bob's trash never shows alice's home (RLS, same as every other surface)
    const bobT = await runBash(`restore --list`, ctx(bob, "bob"), store);
    expect(bobT.stdout).not.toContain("/home/alice/");
  });

  it("version commands stay RLS-scoped: bob sees nothing of alice's home", async () => {
    await store.write(
      { actorId: alice },
      "/home/alice/secret.md",
      Buffer.from("v1\n"),
      "text/markdown",
    );
    await store.write(
      { actorId: alice },
      "/home/alice/secret.md",
      Buffer.from("v2\n"),
      "text/markdown",
    );

    // Bob's namespace has no /home/alice at all — history/diff/restore refuse
    // exactly like a missing path (privacy by absence, never a leak).
    const h = await runBash(`history /home/alice/secret.md`, ctx(bob, "bob"), store);
    expect(h.exitCode).toBe(2);
    expect(h.stdout).not.toContain("v1");
    const r = await runBash(`restore /home/alice/secret.md 1`, ctx(bob, "bob"), store);
    expect(r.exitCode).not.toBe(0);
    expect((await store.read({ actorId: alice }, "/home/alice/secret.md")).bytes.toString()).toBe(
      "v2\n",
    );
  });

  // ---- locks survive a subtree move through bash ---------------------------

  // Regression (lock bypass): `mv` of an UNLOCKED ancestor is one prefix-rewrite
  // over the whole subtree, so it relocated a locked descendant without an
  // ELOCKED — the protected path simply stopped existing where the human left
  // it, and re-creating it afterwards left attacker bytes at the canonical path.
  // PgFs.mv delegates to FsStore.rename, which now consults locks BELOW both
  // ends; this pins the BASH surface so a future PgFs.mv that stops delegating
  // (e.g. a copy-then-delete walk) can't reopen the hole.
  it("`mv` of an unlocked ancestor is refused while a descendant is locked", async () => {
    const locked = "/shared/mvlock/a/b/c/secret.md";
    await store.write({ actorId: alice }, locked, Buffer.from("CANON\n"));
    await store.write({ actorId: alice }, "/shared/mvlock/free/keep.md", Buffer.from("KEEP\n"));
    await store.lock({ actorId: alice }, locked);

    // a cross-directory move of the GRANDparent: refused, naming the descendant
    const r = await runBash(`mv /shared/mvlock/a /shared/mvlock/free/a`, ctx(bob, "bob"), store);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(`ELOCKED: ${locked} is locked by alice`);
    expect(await store.exists({ actorId: alice }, locked)).toBe(true);
    expect(await store.exists({ actorId: alice }, "/shared/mvlock/free/a/b/c/secret.md")).toBe(
      false,
    );

    // …and the escalation the bypass enabled: move the parent away, then
    // re-create the protected path with attacker bytes.
    const esc = await runBash(
      `mv /shared/mvlock/a/b /shared/mvlock/gone; mkdir -p /shared/mvlock/a/b/c; echo PWNED > ${locked}`,
      ctx(bob, "bob"),
      store,
    );
    expect(esc.exitCode).not.toBe(0);
    expect((await store.read({ actorId: alice }, locked)).bytes.toString()).toBe("CANON\n");
    expect(await store.exists({ actorId: alice }, "/shared/mvlock/gone")).toBe(false);
    expect((await store.lockInfo({ actorId: alice }, locked))?.lockedByName).toBe("alice");

    // no over-blocking: a sibling subtree with no lock under it still moves
    const ok = await runBash(
      `mv /shared/mvlock/free /shared/mvlock/moved && ls /shared/mvlock/moved`,
      ctx(bob, "bob"),
      store,
    );
    expect(ok.exitCode).toBe(0);
    expect(await store.exists({ actorId: alice }, "/shared/mvlock/moved/keep.md")).toBe(true);
  });

  // ---- `>>` fails where it is written, not at the exec-end flush -----------

  // Regression (silent success on a locked path): append COALESCING meant the
  // store never saw `echo x >> locked.md` until the exec-end flushAll — so the
  // shell scored the redirect a SUCCESS, took the `&&` branch, and only the
  // tool result (long afterwards) carried the ELOCKED. An agent scripting
  // `echo … >> canon.md && rm draft.md` therefore deleted the draft believing
  // the append had landed. PgFs now probes the lock AT the redirect, so `>>`
  // refuses exactly where `>` does; the pinned pair below is the contract.
  it("`>>` to a locked path refuses at the redirect — the `&&` successor never runs", async () => {
    await store.write({ actorId: alice }, "/shared/lk/canon.md", Buffer.from("KEEP\n"));
    await store.write({ actorId: alice }, "/shared/lk/draft.md", Buffer.from("DRAFT\n"));
    await store.lock({ actorId: alice }, "/shared/lk/canon.md");

    const app = await runBash(
      `echo PWNED >> /shared/lk/canon.md && rm /shared/lk/draft.md`,
      ctx(bob, "bob"),
      store,
    );
    expect(app.exitCode).not.toBe(0);
    expect(app.stderr).toContain("ELOCKED: /shared/lk/canon.md is locked by alice");
    // the successor of the `&&` did NOT run — the draft is still there
    expect(await store.exists({ actorId: alice }, "/shared/lk/draft.md")).toBe(true);
    expect((await store.read({ actorId: alice }, "/shared/lk/canon.md")).bytes.toString()).toBe(
      "KEEP\n",
    );
    expect(app.persisted).toBeUndefined();

    // …byte-for-byte the same refusal `>` gives: that IS the contract
    const trunc = await runBash(
      `echo PWNED > /shared/lk/canon.md && rm /shared/lk/draft.md`,
      ctx(bob, "bob"),
      store,
    );
    expect(trunc.exitCode).toBe(app.exitCode);
    expect(trunc.stderr).toBe(app.stderr);
    expect(await store.exists({ actorId: alice }, "/shared/lk/draft.md")).toBe(true);

    // an ANCESTOR lock (a locked folder protecting its subtree) refuses too
    await store.write({ actorId: alice }, "/shared/lk/sub/note.md", Buffer.from("N\n"));
    await store.lock({ actorId: alice }, "/shared/lk/sub");
    const anc = await runBash(
      `echo PWNED >> /shared/lk/sub/note.md && echo NEVER-RUNS`,
      ctx(bob, "bob"),
      store,
    );
    expect(anc.stdout).not.toContain("NEVER-RUNS");
    expect(anc.stderr).toContain("ELOCKED: /shared/lk/sub is locked by alice");
    expect((await store.read({ actorId: alice }, "/shared/lk/sub/note.md")).bytes.toString()).toBe(
      "N\n",
    );

    // No over-blocking, and the probe must not defeat append coalescing: an
    // UNLOCKED path still costs ONE store round-trip for a whole loop.
    const spy = vi.spyOn(store, "append");
    try {
      const ok = await runBash(
        `for i in 1 2 3 4 5; do echo "l$i" >> /shared/lk/free.md; done && echo LOOP-OK`,
        ctx(bob, "bob"),
        store,
      );
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toBe("LOOP-OK\n");
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect((await store.read({ actorId: alice }, "/shared/lk/free.md")).bytes.toString()).toBe(
      "l1\nl2\nl3\nl4\nl5\n",
    );
  });

  // Regression (adversarial review 2026-07-21): `mkdir` was the ONE mutator
  // that never consulted locks, so `mkdir -p` planted durable directories
  // anywhere inside a locked subtree — exit 0, a "persisted" tool result, and
  // the injected entry sitting in `ls` beside the protected content.
  it("`mkdir -p` inside a locked directory is refused and persists nothing", async () => {
    await store.write({ actorId: alice }, "/shared/mkl/doc.md", Buffer.from("DOC\n"));
    await store.mkdir({ actorId: alice }, "/shared/mkl/kept");
    await store.lock({ actorId: alice }, "/shared/mkl");

    const r = await runBash(
      `mkdir -p /shared/mkl/injected/deep && echo NEVER-RUNS`,
      ctx(bob, "bob"),
      store,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("ELOCKED: /shared/mkl is locked by alice");
    expect(r.stdout).not.toContain("NEVER-RUNS");
    expect(r.persisted ?? []).toEqual([]);
    expect(await store.exists({ actorId: alice }, "/shared/mkl/injected")).toBe(false);

    // nothing durable landed: the locked dir still holds exactly what alice left
    const ls = await runBash(`ls /shared/mkl`, ctx(bob, "bob"), store);
    expect(ls.stdout).toBe("doc.md\nkept\n");

    // `mkdir -p` of a dir that already exists mutates nothing ⇒ still exit 0
    const noop = await runBash(`mkdir -p /shared/mkl/kept && echo OK`, ctx(bob, "bob"), store);
    expect(noop.exitCode).toBe(0);
    expect(noop.stdout).toContain("OK");

    await store.unlock({ actorId: alice }, "/shared/mkl");
    const after = await runBash(`mkdir -p /shared/mkl/injected/deep`, ctx(bob, "bob"), store);
    expect(after.exitCode).toBe(0);
    expect(await store.exists({ actorId: alice }, "/shared/mkl/injected/deep")).toBe(true);
  });

  // ---- flush isolation: one path's failure never costs another path bytes ----

  it("a refused `>>` never costs EARLIER paths the bytes their redirects already took", async () => {
    await store.write({ actorId: alice }, "/shared/fl1/locked.md", Buffer.from("KEEP\n"));
    await store.write({ actorId: alice }, "/shared/fl1/a.md", Buffer.from("A\n"));
    await store.write({ actorId: alice }, "/shared/fl1/b.md", Buffer.from("B\n"));
    await store.lock({ actorId: alice }, "/shared/fl1/locked.md");

    // a.md and b.md are still BUFFERED when the locked redirect aborts the
    // exec; runBash flushes anyway, so bytes a completed `>>` already scored a
    // success keep landing — durability does not depend on a clean exit.
    const r = await runBash(
      `echo A2 >> /shared/fl1/a.md
       echo B2 >> /shared/fl1/b.md
       echo PWNED >> /shared/fl1/locked.md && echo NEVER-RUNS
       echo ALSO-NEVER`,
      ctx(bob, "bob"),
      store,
    );

    const read = async (p: string): Promise<string> =>
      (await store.read({ actorId: alice }, p)).bytes.toString();
    expect(await read("/shared/fl1/locked.md")).toBe("KEEP\n");
    expect(await read("/shared/fl1/a.md")).toBe("A\nA2\n");
    expect(await read("/shared/fl1/b.md")).toBe("B\nB2\n");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("ELOCKED: /shared/fl1/locked.md");
    // fail-closed: nothing after the refusal ran
    expect(r.stdout).not.toContain("NEVER-RUNS");
    expect(r.stdout).not.toContain("ALSO-NEVER");
    expect(r.persisted).toEqual(expect.arrayContaining(["/shared/fl1/a.md", "/shared/fl1/b.md"]));
    expect(r.persisted).not.toContain("/shared/fl1/locked.md");
  });

  // The pathological window the redirect-time probe cannot close: a path whose
  // append is refused only AFTER its bytes were buffered (a lock taken between
  // probe and flush, a transient store failure). Reading it must still tell the
  // truth about the file — every coreutil renders ANY readFile throw as "No
  // such file or directory", so an ordering flush that threw ELOCKED reported
  // the protected file as MISSING, the most misleading answer available.
  it("a file whose queued append cannot flush still READS its durable bytes", async () => {
    await store.write({ actorId: alice }, "/shared/fl3/doc.md", Buffer.from("CANON\n"));
    const real = store.append.bind(store);
    const spy = vi
      .spyOn(store, "append")
      .mockImplementation(async (c, p: string, bytes: Buffer) => {
        if (p === "/shared/fl3/doc.md") {
          const e = new Error("ELOCKED: /shared/fl3/doc.md is locked by alice") as Error & {
            code: string;
          };
          e.code = "ELOCKED";
          throw e;
        }
        return real(c, p, bytes);
      });
    let r;
    try {
      r = await runBash(
        `echo X >> /shared/fl3/doc.md; cat /shared/fl3/doc.md`,
        ctx(alice, "alice"),
        store,
      );
    } finally {
      spy.mockRestore();
    }

    expect(r.stdout).toBe("CANON\n"); // NOT "No such file or directory"
    expect(r.stderr).not.toContain("No such file");
    // …and the loss is still surfaced, naming the path whose bytes died
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("NOT SAVED: /shared/fl3/doc.md");
    expect((await store.read({ actorId: alice }, "/shared/fl3/doc.md")).bytes.toString()).toBe(
      "CANON\n",
    );
  });

  it("a failing flush is isolated per path: other buffered appends land, stderr names the loss", async () => {
    await store.write({ actorId: alice }, "/shared/fl2/bad.md", Buffer.from("BAD\n"));
    await store.write({ actorId: alice }, "/shared/fl2/good.md", Buffer.from("GOOD\n"));

    // A store failure that is NOT a lock (transient/size/…): the first path in
    // the pending map throws at flush time, after both appends were buffered.
    const real = store.append.bind(store);
    const spy = vi
      .spyOn(store, "append")
      .mockImplementation(async (c, p: string, bytes: Buffer) => {
        if (p === "/shared/fl2/bad.md") throw new Error("EBOOM: simulated store failure");
        return real(c, p, bytes);
      });
    let r;
    try {
      r = await runBash(
        `echo X >> /shared/fl2/bad.md
         echo Y >> /shared/fl2/good.md
         ls /shared/fl2`,
        ctx(alice, "alice"),
        store,
      );
    } finally {
      spy.mockRestore();
    }

    const read = async (p: string): Promise<string> =>
      (await store.read({ actorId: alice }, p)).bytes.toString();
    // the unrelated file's append MUST still be in Postgres
    expect(await read("/shared/fl2/good.md")).toBe("GOOD\nY\n");
    expect(await read("/shared/fl2/bad.md")).toBe("BAD\n");
    // …and the caller is told exactly which path lost its bytes
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("EBOOM");
    expect(r.stderr).toContain("NOT SAVED: /shared/fl2/bad.md");
    expect(r.persisted).toContain("/shared/fl2/good.md");
    expect(r.persisted).not.toContain("/shared/fl2/bad.md");
    // the readdir that ran between them is not turned into an ENOENT
    expect(r.stdout).toContain("good.md");
    expect(r.stdout).not.toContain("No such file");
  });
});
