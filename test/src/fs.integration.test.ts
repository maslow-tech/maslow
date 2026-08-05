import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, FsStore } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";
import { McpClient } from "./support/mcp-client.js";
import { FS_MAX_FILE_BYTES } from "@brain/schema";

/**
 * The brain filesystem, end to end — the full
 * three-surface matrix over ONE box app: the bash MCP tool, the bearer fs HTTP
 * surface, and the cookie-authed dashboard mirror, all bound by the same RLS.
 *
 * Case map: 1-11 live here. Case 12 (migrate-with-data: slug collisions,
 * reserved/empty fallbacks, seeded skeleton) lives in
 * migrate-with-data.integration.test.ts ("0037 backfills unique home slugs…"),
 * where the pre-0037 seeding it needs already exists. Case 13 (python/js WASM
 * bridge) is fs-bridge.spike.test.ts, pinned as a regression per Task 0.
 */

// A real 1x1 PNG (binary, has NUL/high bytes — a good round-trip probe).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

const SECRET = "test-session-secret-please-change";

function cookieValue(res: Response, name: string): string | undefined {
  const lines =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const line of lines) {
    const m = line.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (m) return m[1];
  }
  return undefined;
}

interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timed_out?: boolean;
  persisted?: string[];
  deleted?: string[];
  persisted_note?: string;
}

describe("brain filesystem · three surfaces, one RLS boundary", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;

  let alice: { id: string; token: string }; // owner → /home/alice
  let bob: { id: string; token: string }; // member → /home/bob
  let vera: { id: string; token: string }; // viewer → read scope
  let bot: { id: string; token: string }; // HISTORICAL service account → /home/service-bot

  let aliceMcp: McpClient;
  let bobMcp: McpClient;
  let veraMcp: McpClient;

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(path, init));

  const bearer = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });

  const bash = (client: McpClient, script: string, timeoutMs?: number): Promise<BashResult> =>
    client.call<BashResult>("bash", {
      script,
      ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    });

  const login = async (token: string): Promise<{ cookie: string; csrf: string }> => {
    const res = await req("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const session = cookieValue(res, "brain_session");
    const csrf = cookieValue(res, "brain_csrf");
    if (!session || !csrf) throw new Error("login did not set both cookies");
    return { cookie: `brain_session=${session}; brain_csrf=${csrf}`, csrf };
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false },
    });

    const admin = new Admin(pool);
    alice = await admin.bootstrapOwner({ name: "alice", email: "alice@example.com" });
    bob = await admin.createUser(alice.id, {
      name: "bob",
      email: "bob@example.com",
      permission: "member",
    });
    vera = await admin.createUser(alice.id, {
      name: "vera",
      email: "vera@example.com",
      permission: "viewer",
    });
    bot = await admin.createUser(alice.id, {
      name: "Service Bot",
      email: "bot@example.com",
      permission: "member",
    });

    aliceMcp = new McpClient(req, alice.token);
    bobMcp = new McpClient(req, bob.token);
    veraMcp = new McpClient(req, vera.token);
    await aliceMcp.initialize();
    await bobMcp.initialize();
    await veraMcp.initialize();
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  // ---- case 1: round-trip across surfaces ---------------------------------

  it("1 · HTTP upload → bash edit → second bash read → HTTP download, bytes intact", async () => {
    const put = await req("/api/v1/fs/file?path=/shared/reports/pixel.png", {
      method: "PUT",
      headers: bearer(alice.token, { "content-type": "image/png" }),
      body: PNG,
    });
    expect(put.status).toBe(200);
    expect((await put.json()) as object).toMatchObject({
      path: "/shared/reports/pixel.png",
      size: PNG.length,
      sha256: PNG_SHA,
      mime: "image/png",
    });

    // bash edit: derive a report next to it (a durable write via the tool)
    const edit = await bash(
      aliceMcp,
      `sha256sum /shared/reports/pixel.png | cut -d' ' -f1 > /shared/reports/pixel.sha`,
    );
    expect(edit.stderr).toBe("");
    expect(edit.exitCode).toBe(0);
    expect(edit.persisted).toContain("/shared/reports/pixel.sha");

    // a SECOND bash call — fresh sandbox — reads what the first wrote
    const read = await bash(bobMcp, `cat /shared/reports/pixel.sha`);
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe(PNG_SHA);

    // HTTP download: identical bytes + the spec headers
    const dl = await req("/api/v1/fs/file?path=/shared/reports/pixel.png", {
      headers: bearer(bob.token),
    });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("image/png");
    expect(dl.headers.get("cache-control")).toBe("private, no-store");
    expect(dl.headers.get("content-disposition")).toBe('inline; filename="pixel.png"');
    const bytes = Buffer.from(await dl.arrayBuffer());
    expect(bytes.equals(PNG)).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(PNG_SHA);
  });

  // ---- case 2: persistence across calls -----------------------------------

  it("2 · writes and EMPTY mkdirs persist across calls and members", async () => {
    const r1 = await bash(
      aliceMcp,
      `mkdir -p /shared/projects/apollo/empty && echo "kickoff notes" > /shared/projects/apollo/notes.txt`,
    );
    expect(r1.stderr).toBe("");
    expect(r1.exitCode).toBe(0);
    expect(r1.persisted).toContain("/shared/projects/apollo/empty");
    expect(r1.persisted).toContain("/shared/projects/apollo/notes.txt");

    // another member, another exec: the tree is shared and durable
    const r2 = await bash(
      bobMcp,
      `test -d /shared/projects/apollo/empty && echo DIR-OK; cat /shared/projects/apollo/notes.txt`,
    );
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toBe("DIR-OK\nkickoff notes\n");
  });

  // ---- case 3: /home privacy on all three surfaces ------------------------

  it("3 · a foreign home is absent on bash, 404 on HTTP, 404 on the dashboard", async () => {
    const w = await bash(aliceMcp, `echo "board deck draft" > ~/secret.txt`);
    expect(w.exitCode).toBe(0);
    expect(w.persisted).toContain("/home/alice/secret.txt");

    // bash: privacy by absence — no oracle, just ENOENT + a home-less ls
    const b = await bash(bobMcp, `ls /home; cat /home/alice/secret.txt; echo exit=$?`);
    expect(b.stdout).toContain("bob");
    expect(b.stdout).not.toContain("alice");
    expect(b.stderr).toContain("cat: /home/alice/secret.txt: No such file or directory");
    expect(b.stdout).toContain("exit=1");

    // bearer HTTP: uniform not_found on read AND list
    const get = await req("/api/v1/fs/file?path=/home/alice/secret.txt", {
      headers: bearer(bob.token),
    });
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: "not found" });
    const ls = await req("/api/v1/fs/list?path=/home/alice", { headers: bearer(bob.token) });
    expect(ls.status).toBe(404);

    // dashboard: same store, same uniform 404 through a cookie session
    const session = await login(bob.token);
    const dash = await req("/api/v1/files/file?path=/home/alice/secret.txt", {
      headers: { cookie: session.cookie },
    });
    expect(dash.status).toBe(404);
    expect(await dash.json()).toEqual({ error: "not found" });
    // …while the same session reads /shared fine (the 404 is privacy, not auth)
    const shared = await req("/api/v1/files/list?path=/shared", {
      headers: { cookie: session.cookie },
    });
    expect(shared.status).toBe(200);
  });

  // ---- case 4: RLS is the boundary (raw SQL proof) ------------------------

  it("4 · raw GUC-set queries: 0 foreign-home rows; WITH CHECK rejects a forged write", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.actor_id', $1, true)", [bob.id]);
      const rows = await c.query("SELECT path FROM fs_entries WHERE path LIKE '/home/alice%'");
      expect(rows.rowCount).toBe(0);
      // fs_pin_owner pins the row to alice; WITH CHECK (owner = actor) rejects bob
      await expect(
        c.query(
          `INSERT INTO fs_entries (path, parent, name, kind, content, size_bytes, created_by, updated_by)
           VALUES ('/home/alice/forged.txt', '/home/alice', 'forged.txt', 'file', 'x'::bytea, 1, $1, $1)`,
          [bob.id],
        ),
      ).rejects.toThrow(/row-level security/);
      await c.query("ROLLBACK");

      // unset actor GUC ⇒ fail closed to shared-only (no home rows at all)
      const bare = await c.query(
        "SELECT path FROM fs_entries WHERE path LIKE '/home/%' AND owner_id IS NOT NULL",
      );
      expect(bare.rowCount).toBe(0);
    } finally {
      c.release();
    }
  });

  // ---- case 5: on_behalf_of narrowing -------------------------------------

  it("5 · x-on-behalf-of is inert — a service account always acts as itself", async () => {
    // REGRESSION PIN. on_behalf_of is retired: every caller (historical
    // service accounts included) acts only as itself, so the header no longer
    // narrows, no longer fails closed on 'none', and no longer gates on a
    // malformed value or a human token. It is simply not read. This test
    // exists so that reintroducing the scoping fails loudly rather than
    // silently.
    const put = await req("/api/v1/fs/file?path=/home/service-bot/memo.txt", {
      method: "PUT",
      headers: bearer(bot.token, { "content-type": "text/plain" }),
      body: "for the bot's eyes",
    });
    expect(put.status).toBe(200);

    // the bot's own home stays visible no matter what the header says
    for (const value of [bob.id, "none", "zzz-not-a-uuid"]) {
      const res = await req("/api/v1/fs/file?path=/home/service-bot/memo.txt", {
        headers: bearer(bot.token, { "x-on-behalf-of": value }),
      });
      expect(res.status).toBe(200);
    }

    // …and a human token carrying it is not refused, because nothing reads it
    const human = await req("/api/v1/fs/list?path=/shared", {
      headers: bearer(alice.token, { "x-on-behalf-of": bob.id }),
    });
    expect(human.status).toBe(200);
  });

  // ---- case 6: concurrency ------------------------------------------------

  it("6 · parallel appends both land; parallel whole-file writes leave one untorn winner", async () => {
    await bash(aliceMcp, `: > /shared/race-append.log`);
    const [a1, a2] = await Promise.all([
      bash(aliceMcp, `echo from-alice >> /shared/race-append.log`),
      bash(bobMcp, `echo from-bob >> /shared/race-append.log`),
    ]);
    expect(a1.exitCode).toBe(0);
    expect(a2.exitCode).toBe(0);
    const merged = await bash(aliceMcp, `sort /shared/race-append.log`);
    expect(merged.stdout).toBe("from-alice\nfrom-bob\n");

    // whole-file writes: single-statement upsert per file — never torn
    const aBody = "A".repeat(6000);
    const bBody = "B".repeat(6000);
    const [w1, w2] = await Promise.all([
      bash(aliceMcp, `echo ${aBody} > /shared/race-write.txt`),
      bash(bobMcp, `echo ${bBody} > /shared/race-write.txt`),
    ]);
    expect(w1.exitCode).toBe(0);
    expect(w2.exitCode).toBe(0);
    const final = await req("/api/v1/fs/file?path=/shared/race-write.txt", {
      headers: bearer(alice.token),
    });
    const text = (await final.text()).trim();
    expect([aBody, bBody]).toContain(text); // exactly one winner, no interleave
  });

  // ---- case 7: quota + per-file cap ---------------------------------------

  it("7 · a full brain teaches ENOSPC through bash; an over-cap upload is a 413", async () => {
    // a second box over the same brain, with a 1-byte quota (the skeleton
    // already exceeds it) — FsStore reads the env at construction
    process.env.BRAIN_FS_QUOTA_BYTES = "1";
    let tiny: Hono;
    try {
      tiny = createBox({ pool, ownerClient });
    } finally {
      delete process.env.BRAIN_FS_QUOTA_BYTES;
    }
    const tinyMcp = new McpClient(
      (path, init) => Promise.resolve(tiny.request(path, init)),
      alice.token,
    );
    await tinyMcp.initialize();
    const r = await tinyMcp.call<BashResult>("bash", {
      script: `echo overflow > /shared/quota-probe.txt`,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/brain filesystem is full .* delete files you no longer need/);
    // Real full-disk semantics: `>` creates the (zero-byte, zero-delta) file,
    // then the content write hits ENOSPC — so the file may exist but MUST be
    // empty (checked through the normal-quota app).
    const probe = await req("/api/v1/fs/file?path=/shared/quota-probe.txt", {
      headers: bearer(alice.token),
    });
    if (probe.status === 200) expect(await probe.text()).toBe("");
    else expect(probe.status).toBe(404);

    // the 25MB per-file cap on the HTTP surface
    const big = await req("/api/v1/fs/file?path=/shared/too-big.bin", {
      method: "PUT",
      headers: bearer(alice.token),
      body: Buffer.alloc(FS_MAX_FILE_BYTES + 1),
    });
    expect(big.status).toBe(413);
  });

  // ---- case 8: timeout durability -----------------------------------------

  it("8 · exit 124 keeps pre-timeout writes; the trailer confirms them", async () => {
    const r = await bash(
      aliceMcp,
      `echo made-it > /shared/timeout-survivor.txt
       sleep 60
       echo never > /shared/timeout-too-late.txt`,
      1500,
    );
    expect(r.exitCode).toBe(124);
    expect(r.timed_out).toBe(true);
    expect(r.stderr).toContain("files written before the timeout were saved");
    expect(r.persisted).toContain("/shared/timeout-survivor.txt");
    expect(r.persisted_note).toContain("/shared/timeout-survivor.txt");

    const saved = await req("/api/v1/fs/file?path=/shared/timeout-survivor.txt", {
      headers: bearer(bob.token),
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toBe("made-it\n");
    expect(
      (
        await req("/api/v1/fs/file?path=/shared/timeout-too-late.txt", {
          headers: bearer(bob.token),
        })
      ).status,
    ).toBe(404);
  }, 30_000);

  // ---- case 9: read-scope tokens ------------------------------------------

  it("9 · a viewer token reads through bash but every write is EROFS", async () => {
    const r = await bash(veraMcp, `cat /shared/projects/apollo/notes.txt`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("kickoff notes\n");

    for (const script of [
      `echo x > /shared/vera.txt`,
      `mkdir /shared/vera-dir`,
      `rm /shared/projects/apollo/notes.txt`,
    ]) {
      const w = await bash(veraMcp, script);
      expect(w.exitCode, script).not.toBe(0);
      expect(w.stderr, script).toContain("EROFS");
    }
    expect(
      (
        await req("/api/v1/fs/file?path=/shared/projects/apollo/notes.txt", {
          headers: bearer(alice.token),
        })
      ).status,
    ).toBe(200);
    expect(
      (await req("/api/v1/fs/file?path=/shared/vera.txt", { headers: bearer(alice.token) })).status,
    ).toBe(404);
  });

  // ---- case 10: foreign-home writes fail loudly ---------------------------

  it("10 · a foreign-home write via bash fails LOUDLY and never ghost-persists", async () => {
    const w = await bash(bobMcp, `echo pwned > /home/alice/hack.txt`);
    expect(w.exitCode).not.toBe(0);
    expect(w.stderr).toMatch(/only \/shared, \/home\/<you> and \/tmp are writable/);
    expect(w.persisted ?? []).toEqual([]);

    const check = await bash(aliceMcp, `test -e ~/hack.txt && echo LANDED || echo ABSENT`);
    expect(check.stdout.trim()).toBe("ABSENT");
  });

  // ---- path-contract backlink warning -------------------------------------

  it("warns when an rm/rename hits a /shared path a record mentions", async () => {
    await bash(
      aliceMcp,
      `mkdir -p /shared/contracts && echo "terms" > /shared/contracts/acme.md && echo scratch > /shared/contracts/noref.md`,
    );
    // a record whose body references ONE of the file paths (the attach pattern)
    await aliceMcp.call("write", {
      title: "Acme deal",
      body: "See the signed terms at /shared/contracts/acme.md before renewal.",
    });

    // remove BOTH in one script: only the referenced path should be named
    const r = await bash(aliceMcp, `rm /shared/contracts/acme.md /shared/contracts/noref.md`);
    expect(r.exitCode).toBe(0);
    expect(r.deleted).toContain("/shared/contracts/acme.md");
    const warned = `${r.stderr}${(r as { path_refs_warning?: string }).path_refs_warning ?? ""}`;
    expect(warned).toContain("/shared/contracts/acme.md");
    expect(warned.toLowerCase()).toContain("record");
    // precision: the UNreferenced path must NOT appear in the warning
    expect(warned).not.toContain("noref.md");
  });

  // ---- case 11: doctrine --------------------------------------------------

  it("11 · start teaches FILES and names the caller's real home", async () => {
    const r = await aliceMcp.call<{ text: string }>("start");
    expect(r.text).toContain("FILES — a real, persistent filesystem");
    expect(r.text).toContain("your home: /home/alice");
    // the recovery surface is only useful if start names the real commands
    expect(r.text).toContain("history <path>");
    expect(r.text).toContain("restore <path>");
    expect(r.text).toContain("ELOCKED");
    // and the old "no undo" claim must be gone — rm is a soft delete now
    expect(r.text).not.toContain("no trash, no undo");

    const b = await bobMcp.call<{ text: string }>("start");
    expect(b.text).toContain("your home: /home/bob");
  });

  // ---- locks: RLS-scoped, enforced on the write path ----------------------

  it("12 · a lock refuses foreign writes through bash; a home lock stays private", async () => {
    // Locks are set by a human via the dashboard (Task 8/9); here we drive the
    // store directly to prove the FsStore boundary that HTTP will sit on.
    const store = new FsStore(pool);

    // A shared file alice locks: bob's bash write is refused with ELOCKED, then
    // unlocking lets it through — enforcement crosses the member boundary.
    await bash(aliceMcp, `mkdir -p /shared/canon && echo truth > /shared/canon/thesis.md`);
    await store.lock({ actorId: alice.id }, "/shared/canon/thesis.md");
    const blocked = await bash(bobMcp, `echo slop > /shared/canon/thesis.md`);
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr).toContain("ELOCKED");
    // the file is untouched
    expect((await bash(bobMcp, `cat /shared/canon/thesis.md`)).stdout).toBe("truth\n");
    await store.unlock({ actorId: alice.id }, "/shared/canon/thesis.md");
    const ok = await bash(bobMcp, `echo ok > /shared/canon/thesis.md`);
    expect(ok.exitCode).toBe(0);

    // A home-file lock is invisible to a foreign member (RLS), yet still
    // enforced for its owner: bob can't see alice's lock at all; alice's own
    // write is refused until she unlocks.
    await bash(aliceMcp, `echo private > ~/held.md`);
    await store.lock({ actorId: alice.id }, "/home/alice/held.md");
    expect(await store.lockInfo({ actorId: bob.id }, "/home/alice/held.md")).toBeNull();
    expect(await store.lockInfo({ actorId: alice.id }, "/home/alice/held.md")).toMatchObject({
      lockedByName: "alice",
    });
    const own = await bash(aliceMcp, `echo edit > ~/held.md`);
    expect(own.exitCode).not.toBe(0);
    expect(own.stderr).toContain("ELOCKED");
    await store.unlock({ actorId: alice.id }, "/home/alice/held.md");
    expect((await bash(aliceMcp, `echo edit > ~/held.md`)).exitCode).toBe(0);
  });

  // ---- a version number is bounded caller input, on every surface ---------

  /**
   * `fs_versions.version_no` is an int4. A caller-supplied number past
   * 2147483647 used to sail through every parser (it is a perfectly good
   * positive JS integer) and land in Postgres raw, which answered "value
   * "3000000000" is out of range for type integer": a 500 on HTTP and a
   * database message printed into the agent's sandbox. Out-of-range is bad
   * INPUT — it teaches, exactly like any other version number that isn't one.
   */
  it("13 · an out-of-int4 version number teaches on every surface, never reaches Postgres", async () => {
    const HUGE = 3_000_000_000; // > int4 max, still a safe JS integer
    await bash(aliceMcp, `mkdir -p /shared/vnum && echo one > /shared/vnum/doc.md`);
    await bash(aliceMcp, `echo two > /shared/vnum/doc.md`); // v1 now exists

    const restore = await req("/api/v1/fs/restore", {
      method: "POST",
      headers: bearer(alice.token, { "content-type": "application/json" }),
      body: JSON.stringify({ path: "/shared/vnum/doc.md", version: HUGE }),
    });
    expect(restore.status).toBe(400);
    expect(await restore.json()).toEqual({ error: "version must be a version number" });

    const version = await req(`/api/v1/fs/version?path=/shared/vnum/doc.md&v=${HUGE}`, {
      headers: bearer(alice.token),
    });
    expect(version.status).toBe(400);
    expect(await version.json()).toEqual({ error: "v query param must be a version number" });

    // bash: the usage line (exit 2) — the same answer `restore doc.md v3` gets.
    const cli = await bash(aliceMcp, `restore /shared/vnum/doc.md ${HUGE}`);
    expect(cli.exitCode).toBe(2);
    expect(cli.stderr).toMatch(/^usage: restore/);

    // …and no surface leaks the database's wording into the sandbox.
    const diff = await bash(aliceMcp, `diff /shared/vnum/doc.md ${HUGE}`);
    for (const s of [cli.stderr, diff.stderr, diff.stdout]) {
      expect(s).not.toMatch(/out of range for type integer/);
    }

    // the file is untouched by any of it
    expect((await bash(aliceMcp, `cat /shared/vnum/doc.md`)).stdout).toBe("two\n");
  });
});
