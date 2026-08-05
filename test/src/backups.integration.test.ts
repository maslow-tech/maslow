import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * Backups + PITR, against the REAL pgBackRest path.
 *
 * This suite builds `deploy/postgres/Dockerfile` and boots it with the actual
 * `deploy/postgres/postgresql.conf` + `deploy/pgbackrest/pgbackrest.conf` and
 * the actual `backup-scheduler.sh` that the compose sidecar runs. It is
 * deliberately NOT a stand-in: the previous version of this file exercised the
 * documented `cp`-to-a-local-dir fallback, which meant CI was green on a code
 * path production does not use — and the pgBackRest config it was standing in
 * for had a bug (inline comments on value lines) that would have failed EVERY
 * `archive-push` on EVERY box, invisibly, from the day archiving was switched
 * back on. Building and running the real artifact is the only thing that finds
 * that class of defect.
 *
 * What it proves, in order:
 *   1. the shipped image + config boot with archive_mode=on, the pgBackRest
 *      archive_command and wal_compression=zstd — and a box whose stanza does
 *      not exist yet stays UP (archiving fails, Postgres does not)
 *   2. the scheduler's bootstrap is idempotent and takes the first full
 *   3. WAL actually reaches the repo
 *   4. **PITR**: restore to a timestamp T — pre-T rows survive, post-T rows do not
 *   5. **expire really reclaims**: backups AND their dependent WAL disappear and
 *      the repo shrinks
 *   6. every failure mode is safe: stanza already exists, postgres unreachable,
 *      disk at the write-shed threshold, repo over its budget, repo wiped
 *
 * Honest posture, restated because it is easy to over-read a green
 * suite: the repo is LOCAL, on the same volume as PGDATA. This bounds LOGICAL
 * mistakes with PITR at RPO ≈ 60s. It does not survive whole-volume loss.
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const PG_CONF = join(repoRoot, "deploy", "postgres", "postgresql.conf");
const PGBACKREST_CONF = join(repoRoot, "deploy", "pgbackrest", "pgbackrest.conf");

const SU = "postgres";
const SOCK = "/var/run/postgresql";
const REPO = "/var/lib/pgbackrest";
const PGDATA = "/var/lib/postgresql/data";
/** archive-async's queue. A failing async worker reports itself HERE, not in
 *  pg_stat_archiver — see the stanza-missing test. */
const SPOOL = "/var/spool/pgbackrest";
const RESTORE_DIR = "/var/lib/postgresql/restore";
const SCHEDULER = "/usr/local/bin/brain-backup.sh";
/** A small tmpfs used to exercise the budget arithmetic against a filesystem of
 *  a KNOWN size — far more honest (and faster) than trying to fill a CI runner. */
const SMALL_REPO = "/smallrepo";
const SMALL_REPO_MB = 64;
const IMAGE_TAG = "brain-postgres-backups-test:ci";

let container: StartedTestContainer;

interface Exec {
  readonly out: string;
  readonly code: number;
}

/** Exec as the `postgres` OS user (the uid everything in the box runs as). */
async function pexec(cmd: string[], env: Record<string, string> = {}): Promise<Exec> {
  const res = await container.exec(cmd, { user: SU, env });
  return { out: res.output, code: res.exitCode };
}

/** Run a bash snippet in the container as `postgres`. */
async function sh(script: string, env: Record<string, string> = {}): Promise<Exec> {
  return pexec(["bash", "-c", script], env);
}

/** One-value psql against an instance in the container, over its unix socket. */
async function q(sql: string, port = 5432): Promise<string> {
  const r = await pexec([
    "psql",
    "-U",
    SU,
    "-h",
    SOCK,
    "-p",
    String(port),
    "-d",
    "postgres",
    "-qtAX",
    "-c",
    sql,
  ]);
  expect(r.code, `psql failed for ${sql}:\n${r.out}`).toBe(0);
  return r.out.trim();
}

/** One-value psql against a NAMED database (the drill's scope bug hid in the
 *  gap between `postgres` and where the data actually lives). */
async function qDb(db: string, sql: string, port = 5432): Promise<string> {
  const r = await pexec([
    "psql",
    "-U",
    SU,
    "-h",
    SOCK,
    "-p",
    String(port),
    "-d",
    db,
    "-qtAX",
    "-c",
    sql,
  ]);
  expect(r.code, `psql failed for ${sql} on ${db}:\n${r.out}`).toBe(0);
  return r.out.trim();
}

async function qNum(sql: string, port = 5432): Promise<number> {
  return Number(await q(sql, port));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  what: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 90_000,
  stepMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(stepMs);
  }
}

/** Full backups currently in the repo (directory names are `<ts>F`). */
async function fullBackupCount(): Promise<number> {
  const r = await sh(
    `ls -1 ${REPO}/backup/brain 2>/dev/null | grep -Ec '^[0-9]{8}-[0-9]{6}F$' || true`,
  );
  return Number(r.out.trim() || "0");
}

/** Archived WAL segments in the repo (pgBackRest stores them zstd-compressed). */
async function archivedWalCount(): Promise<number> {
  const r = await sh(`find ${REPO}/archive/brain -type f -name '*.zst' 2>/dev/null | wc -l`);
  return Number(r.out.trim() || "0");
}

async function repoSizeKb(): Promise<number> {
  const r = await sh(`du -sk ${REPO} | cut -f1`);
  return Number(r.out.trim() || "0");
}

/** Force the current WAL segment closed and wait for pgBackRest to archive it. */
async function switchAndAwaitArchive(): Promise<void> {
  const seg = await q("SELECT pg_walfile_name(pg_current_wal_lsn())");
  await q("SELECT pg_switch_wal()");
  await q("CHECKPOINT");
  await waitFor(`segment ${seg} to reach the repo`, async () => {
    const r = await sh(`find ${REPO}/archive/brain -type f -name '${seg}-*' | wc -l`);
    return Number(r.out.trim() || "0") >= 1;
  });
}

describe("box backups · pgBackRest base backup, WAL archive, PITR and expiry", () => {
  beforeAll(async () => {
    // Build the REAL postgres image (pgBackRest install + the scheduler). A
    // broken apt install or a missing binary fails here, in CI, rather than on
    // a user's box where a silently-failing archive_command retains WAL
    // until the volume fills.
    //
    // Deliberately the `docker build` CLI rather than
    // `GenericContainer.fromDockerfile`: the latter drives the daemon's legacy
    // build endpoint, which bypasses BuildKit's cache and was observed taking
    // >15 minutes for this Dockerfile (the same build finishes in seconds
    // through the CLI). It also builds it exactly the way release.yml does.
    await run(
      "docker",
      ["build", "--progress=plain", "-t", IMAGE_TAG, join(repoRoot, "deploy", "postgres")],
      {
        timeout: 15 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    container = await new GenericContainer(IMAGE_TAG)
      .withEnvironment({
        POSTGRES_USER: SU,
        POSTGRES_PASSWORD: SU,
        POSTGRES_DB: "postgres",
        // Match pg-harness.ts: builtin, version-stable collation.
        POSTGRES_INITDB_ARGS: "--locale-provider=builtin --locale=C.UTF-8 --encoding=UTF8",
      })
      // The SHIPPED configs, byte for byte — this suite's whole value is that
      // it runs what boxes run.
      .withCopyFilesToContainer([
        { source: PG_CONF, target: "/etc/postgresql/postgresql.conf", mode: 0o644 },
        { source: PGBACKREST_CONF, target: "/etc/pgbackrest/pgbackrest.conf", mode: 0o644 },
      ])
      // `logging_collector=off` is the ONE deviation: the shipped config sends
      // postgres logs to files, which would make a CI failure undebuggable.
      // Everything WAL/archiving-related is left exactly as shipped.
      .withCommand([
        "postgres",
        "-c",
        "config_file=/etc/postgresql/postgresql.conf",
        "-c",
        "logging_collector=off",
      ])
      .withTmpFs({ [SMALL_REPO]: `rw,size=${SMALL_REPO_MB}m,mode=1777` })
      // TWO "ready" lines, not `pg_isready`. The official entrypoint runs a
      // TEMPORARY server to execute initdb + the /docker-entrypoint-initdb.d
      // scripts, then stops it and starts the real one. `pg_isready` answers
      // during that temporary window, so waiting on it returns a container whose
      // postgres is about to shut down — CI failed with "FATAL: the database
      // system is shutting down" on the very first query. The second occurrence
      // is the real server. (This works because `logging_collector=off` above
      // keeps postgres logging to stderr, where the wait strategy can see it.)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(180_000)
      .start();

    // Belt: the log line is emitted a moment before the socket accepts.
    //
    // And one success is NOT enough. The official entrypoint runs a temporary
    // server for initdb, stops it, then execs the real one — and the temp
    // server's pgBackRest archive-push child can outlive it, get re-parented to
    // the real postmaster (PID 1), and be reaped as an unknown child. The real
    // postmaster reads that as a backend crash and does a full recovery cycle
    // ~20ms AFTER logging "ready to accept connections". So the sequence is
    // ready → briefly refusing → ready, and a wait that stops at the first
    // success hands the suite a cluster that is about to drop its connections.
    // Seen twice in CI as `psql failed for SHOW archive_mode` on the very first
    // test, and as four `psql failed for …` mid-suite.
    //
    // Require the cluster to be ready CONSECUTIVELY across a window wider than
    // that recovery, so "ready" means settled rather than merely observed once.
    await waitFor("the real postgres to accept connections", async () => {
      const r = await pexec(["pg_isready", "-U", SU, "-h", SOCK]);
      return r.code === 0;
    });
    let consecutive = 0;
    await waitFor("postgres to stay ready (no startup crash-recovery in flight)", async () => {
      const r = await pexec(["pg_isready", "-U", SU, "-h", SOCK]);
      consecutive = r.code === 0 ? consecutive + 1 : 0;
      return consecutive >= 5;
    });
  }, 900_000);

  afterAll(async () => {
    await container?.stop().catch(() => {});
  });

  // ------------------------------------------------------------------ (1)
  it("boots the shipped image + config with pgBackRest archiving and wal_compression", async () => {
    const version = await sh("pgbackrest version");
    expect(version.code, `pgbackrest is not installed:\n${version.out}`).toBe(0);
    expect(version.out).toMatch(/pgBackRest \d+\.\d+/);

    expect(await q("SHOW archive_mode")).toBe("on");
    expect(await q("SHOW archive_command")).toBe("pgbackrest --stanza=brain archive-push %p");
    expect(await q("SHOW wal_compression")).toBe("zstd");
    expect(await q("SHOW archive_timeout")).toBe("1min");
  });

  // A box picks up `archive_mode = on` the moment the new postgres image lands,
  // but its stanza is only created seconds-to-minutes later by the sidecar. That
  // window MUST be survivable: archiving fails, the database does not.
  it("stays up while the stanza does not exist yet (archiving fails, postgres does not)", async () => {
    expect(await fullBackupCount()).toBe(0);
    await q("CREATE TABLE smoke(id int)");
    await q("INSERT INTO smoke SELECT generate_series(1,100)");
    await q("SELECT pg_switch_wal()");

    // Do NOT wait on pg_stat_archiver.failed_count. Under `archive-async=y` the
    // async worker aborts and writes its failure into the SPOOL, and the
    // foreground archive-push only reports that on a LATER invocation — so
    // failed_count can sit at 0 while archiving is comprehensively broken.
    // MEASURED on this exact image: archived_count=0, failed_count=0,
    // last_failed_wal=NULL, with a .ready segment queued and global.error
    // already written. That is why pitr.md's archiver health check cannot lean
    // on failed_count alone. Assert the signals that ARE deterministic.
    await waitFor("pgBackRest to record the missing stanza in its spool", async () => {
      const r = await sh(`test -f ${SPOOL}/archive/brain/out/global.error && echo yes || true`);
      return r.out.trim() === "yes";
    });

    // The invariant this test exists for: the server is still serving.
    const ready = await pexec(["pg_isready", "-U", SU, "-h", SOCK]);
    expect(ready.code, "postgres must stay up when archiving fails").toBe(0);
    expect(await qNum("SELECT count(*) FROM smoke")).toBe(100);

    // …and nothing was silently counted as archived: no WAL reached the repo and
    // the segment is still queued. A box in this window loses no WAL, it just
    // cannot recycle it — which is what `archive-push-queue-max` bounds.
    expect(await qNum("SELECT archived_count FROM pg_stat_archiver")).toBe(0);
    expect(await archivedWalCount()).toBe(0);
    const queued = await sh(
      `ls -1 ${PGDATA}/pg_wal/archive_status/ 2>/dev/null | grep -c '\\.ready$' || true`,
    );
    expect(
      Number(queued.out.trim() || "0"),
      "a WAL segment must still be queued for archiving",
    ).toBeGreaterThanOrEqual(1);

    // The operator-facing signal that IS reliable: a direct, synchronous push
    // fails loudly and names the cause.
    const seg = await sh(`ls -1 ${PGDATA}/pg_wal | grep -E '^[0-9A-F]{24}$' | head -1`);
    const push = await sh(
      `pgbackrest --stanza=brain --no-archive-async archive-push ` +
        `${PGDATA}/pg_wal/${seg.out.trim()} 2>&1`,
    );
    expect(push.code, `archive-push must fail without a stanza:\n${push.out}`).not.toBe(0);
    expect(push.out).toContain("has a stanza-create been performed");
  }, 180_000);

  // ------------------------------------------------------------------ (2)
  it("bootstraps the stanza on an EMPTY repo volume and takes the first full", async () => {
    const first = await sh(`${SCHEDULER} once`);
    // Exit 0 is not incidental: this process is what `compose up --wait` waits
    // on, and a non-zero exit there latches the fleet's updater.
    expect(first.code, `scheduler must never exit non-zero:\n${first.out}`).toBe(0);
    expect(first.out).toContain("running stanza-create");

    const info = await sh(
      `test -f ${REPO}/archive/brain/archive.info && test -f ${REPO}/backup/brain/backup.info && echo yes`,
    );
    expect(info.out.trim()).toBe("yes");
    expect(await fullBackupCount()).toBe(1);
  }, 300_000);

  it("is idempotent: a second cycle re-uses the stanza and takes no extra full", async () => {
    const before = await fullBackupCount();
    const second = await sh(`${SCHEDULER} once`);
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("running stanza-create");
    expect(second.out).toContain("no full due");
    expect(await fullBackupCount()).toBe(before);

    // …and pgBackRest's own stanza-create is idempotent too, which is what the
    // bootstrap relies on for a box that already has a repo.
    const again = await sh(
      `pgbackrest --stanza=brain --repo1-path=${REPO} --pg1-socket-path=${SOCK} stanza-create`,
    );
    expect(again.code, `stanza-create must be safe to re-run:\n${again.out}`).toBe(0);
  }, 300_000);

  // ------------------------------------------------------------------ (3)
  it("archives WAL into the repo once the stanza exists", async () => {
    await q("INSERT INTO smoke SELECT generate_series(1,1000)");
    await switchAndAwaitArchive();
    expect(await archivedWalCount()).toBeGreaterThanOrEqual(1);
    expect(await qNum("SELECT archived_count FROM pg_stat_archiver")).toBeGreaterThanOrEqual(1);
  }, 180_000);

  // ------------------------------------------------------------------ (4) PITR
  // The one that matters. A backup that has never been restored is not a backup.
  it("restores to a timestamp: pre-T rows survive, post-T rows do not", async () => {
    // Everything below happens AFTER the base backup taken in (2), so it exists
    // only in archived WAL — recovery has to replay it to be correct.
    await q("CREATE TABLE pitr_probe(id int PRIMARY KEY, note text)");
    await q("INSERT INTO pitr_probe VALUES (1,'pre'),(2,'pre'),(3,'pre')");
    await switchAndAwaitArchive();

    // T strictly between the pre-T and post-T commits.
    await q("SELECT pg_sleep(1)");
    const target = await q("SELECT clock_timestamp()::text");
    await q("SELECT pg_sleep(2)");

    await q("INSERT INTO pitr_probe VALUES (4,'post'),(5,'post'),(6,'post')");
    await switchAndAwaitArchive();

    const mk = await sh(`mkdir -p ${RESTORE_DIR} && chmod 700 ${RESTORE_DIR}`);
    expect(mk.code).toBe(0);

    const restore = await sh(
      `pgbackrest --stanza=brain --repo1-path=${REPO} --pg1-path=${RESTORE_DIR} ` +
        `--type=time --target="${target}" --target-action=promote ` +
        `--log-level-console=info restore`,
    );
    expect(restore.code, `pgbackrest restore failed:\n${restore.out}`).toBe(0);
    expect(restore.out).toContain("restore command end: completed successfully");

    // Start the restored cluster on :5433. It replays the archived WAL up to T
    // and promotes. `archive_mode=off` so a restored copy can never push WAL
    // into the live stanza.
    const start = await sh(
      `pg_ctl -D ${RESTORE_DIR} -o "-p 5433 -c logging_collector=off -c archive_mode=off" ` +
        `-l /tmp/restore.log -w -t 180 start`,
    );
    if (start.code !== 0) {
      const log = await sh("cat /tmp/restore.log || true");
      throw new Error(`restored instance did not start:\n${start.out}\n--- log ---\n${log.out}`);
    }

    // pg_ctl -w returns as soon as connections are accepted, which happens
    // DURING hot-standby replay — assert on the PROMOTED instance, not the
    // recovering one, or a loaded runner reads the table before it exists.
    await waitFor("recovery to reach T and promote", async () => {
      const r = await pexec([
        "psql",
        "-U",
        SU,
        "-h",
        SOCK,
        "-p",
        "5433",
        "-d",
        "postgres",
        "-qtAX",
        "-c",
        "SELECT pg_is_in_recovery()",
      ]);
      return r.code === 0 && r.out.trim() === "f";
    });

    expect(await qNum("SELECT count(*) FROM pitr_probe WHERE note='pre'", 5433)).toBe(3);
    expect(await qNum("SELECT count(*) FROM pitr_probe WHERE note='post'", 5433)).toBe(0);
    expect(await qNum("SELECT count(*) FROM pitr_probe", 5433)).toBe(3);
    // The live cluster is untouched by the restore.
    expect(await qNum("SELECT count(*) FROM pitr_probe")).toBe(6);

    await sh(`pg_ctl -D ${RESTORE_DIR} -m immediate stop; rm -rf ${RESTORE_DIR}`);
  }, 600_000);

  // ------------------------------------------------------------------ (5) expire
  // Unbounded archive growth is what wedged two production disks in July and got
  // WAL archiving turned off fleet-wide. "We call expire" is not evidence;
  // bytes going away is.
  it("expire reclaims old backups AND their dependent WAL, shrinking the repo", async () => {
    // Real bytes, so the reclamation is measurable rather than rounding noise.
    await q("CREATE TABLE bulk(id int, pad text)");
    for (const pad of ["x", "y"]) {
      await q(`INSERT INTO bulk SELECT g, repeat('${pad}',900) FROM generate_series(1,30000) g`);
      await switchAndAwaitArchive();
      const b = await sh(`${SCHEDULER} now`);
      expect(b.code).toBe(0);
      expect(b.out).toContain("full backup OK");
    }

    const backupsBefore = await fullBackupCount();
    const walBefore = await archivedWalCount();
    const sizeBefore = await repoSizeKb();
    expect(backupsBefore).toBeGreaterThanOrEqual(3);
    expect(walBefore).toBeGreaterThanOrEqual(3);

    const expire = await sh(
      `pgbackrest --stanza=brain --repo1-path=${REPO} ` +
        `--repo1-retention-full=1 --repo1-retention-archive=1 --log-level-console=info expire`,
    );
    expect(expire.code, `expire failed:\n${expire.out}`).toBe(0);
    expect(expire.out).toContain("remove expired backup");
    expect(expire.out).toContain("remove archive");

    const backupsAfter = await fullBackupCount();
    const walAfter = await archivedWalCount();
    const sizeAfter = await repoSizeKb();
    expect(backupsAfter).toBe(1);
    expect(walAfter).toBeLessThan(walBefore);
    expect(sizeAfter).toBeLessThan(sizeBefore);
  }, 900_000);

  // ------------------------------------------------------------------ (6) guards
  it("steps retention down as the repo eats into its budget, never below one full", async () => {
    const r = await sh(
      `source ${SCHEDULER}; for p in 0 74 75 89 90 99 100 250; do printf '%s:%s ' "$p" "$(effective_retention "$p")"; done`,
      { BRAIN_BACKUP_LIB_ONLY: "1", BRAIN_BACKUP_RETENTION_FULL: "4" },
    );
    expect(r.code).toBe(0);
    // 4 fulls while there is room; harder expiry as the budget fills; never 0 —
    // a repo with no full backup is not a backup, it is WAL nobody can replay.
    expect(r.out.trim()).toBe("0:4 74:4 75:3 89:3 90:2 99:2 100:1 250:1");
  });

  it("refuses a backup when the repo is over its runtime-computed budget", async () => {
    // A 64 MB filesystem ⇒ a 20% budget of ~12.8 MB. Put 20 MB in it and the
    // guard must refuse — this exercises the real df/du arithmetic, not a mock.
    const fill = await sh(
      `dd if=/dev/zero of=${SMALL_REPO}/blob bs=1M count=20 2>/dev/null && echo ok`,
    );
    expect(fill.out.trim()).toBe("ok");

    const r = await sh(`source ${SCHEDULER}; space_ok; echo "space_ok=$?"`, {
      BRAIN_BACKUP_LIB_ONLY: "1",
      BRAIN_BACKUP_REPO_PATH: SMALL_REPO,
      BRAIN_BACKUP_REPO_BUDGET_PCT: "20",
      // isolate the budget check from the other two refusal reasons
      BRAIN_WRITE_SHED_PCT: "99",
      BRAIN_BACKUP_MIN_FREE_MB: "1",
    });
    expect(r.out).toContain("REFUSING backup: repo is");
    expect(r.out).toContain("space_ok=1");
  });

  it("refuses a backup at the write-shed threshold, using the app's own knob", async () => {
    const before = await fullBackupCount();
    // BRAIN_WRITE_SHED_PCT is the SAME variable apps/box/src/disk-guard.ts reads
    // to stop content writes. One number, one meaning, two enforcement points —
    // not a second, competing disk monitor.
    const r = await sh(`${SCHEDULER} now`, { BRAIN_WRITE_SHED_PCT: "0" });
    expect(r.code, "a refused backup must still exit 0").toBe(0);
    expect(r.out).toContain("REFUSING backup: volume is");
    expect(r.out).toContain("at/over the write-shed threshold");
    expect(await fullBackupCount()).toBe(before);
  }, 180_000);

  it("waits instead of failing when postgres is unreachable", async () => {
    const r = await sh(`${SCHEDULER} once`, {
      BRAIN_PG_SOCKET_DIR: "/tmp/definitely-not-a-socket",
    });
    expect(r.code, "an unreachable postgres must not fail the container").toBe(0);
    expect(r.out).toContain("postgres is not accepting connections");
  }, 180_000);

  // Docker creates a named volume's mountpoint ROOT-OWNED when the path does not
  // exist in the image, and `pgbackrest_repo` has been declared in
  // docker-compose.yml since long before the image created /var/lib/pgbackrest.
  // So on every box already in the field that volume exists and is root-owned,
  // and the `postgres` uid cannot write to it — exactly the shape of failure
  // that makes every archive_command fail silently for weeks.
  // The scheduler enters as root, heals it, and re-execs itself as postgres.
  it("heals a root-owned repo volume and drops to the postgres user", async () => {
    const root = async (script: string): Promise<Exec> => {
      const res = await container.exec(["bash", "-c", script], { user: "root" });
      return { out: res.output, code: res.exitCode };
    };
    // Reproduce the field condition on a scratch path (the live repo is in use).
    const stray = "/var/lib/pgbackrest-rootowned";
    await root(`rm -rf ${stray}; mkdir -p ${stray}; chown root:root ${stray}; chmod 0755 ${stray}`);
    expect((await root(`stat -c '%U' ${stray}`)).out.trim()).toBe("root");

    // Point the scheduler at the root-owned path and at a dead socket, so the
    // cycle stops right after the heal-and-demote without touching the live repo.
    const r = await root(
      `BRAIN_BACKUP_REPO_PATH=${stray} BRAIN_PG_SOCKET_DIR=/tmp/not-a-socket ${SCHEDULER} once` +
        `; echo "===="; stat -c '%U %a' ${stray}; id -un`,
    );
    expect(r.code, "the root path must still exit 0").toBe(0);
    expect(r.out).toContain("dropping to the postgres user");
    // healed to postgres-owned 0750 — the repo holds full copies of the brain
    expect(r.out.split("====").pop()?.trim().split("\n")[0]?.trim()).toBe("postgres 750");
    // and the work itself did NOT run as root
    expect(r.out).toContain("postgres is not accepting connections");

    await root(`rm -rf ${stray}`);
  }, 300_000);

  // REGRESSION. The wedge alarm used to be gated on `failed_count > 0`, which
  // makes it silent in the one case we actually measured: archive-async=y means
  // a failing push is recorded in the SPOOL while pg_stat_archiver still reads
  // archived=0 failed=0. A detector that only fires on the golden-path signal is
  // not a detector — this is the July disk-fill going unnoticed.
  it("reports a WEDGED archiver from the spool alone, with failed_count still 0", async () => {
    const failedBefore = await qNum("SELECT failed_count FROM pg_stat_archiver");
    const errDir = `${SPOOL}/archive/brain/out`;
    await sh(
      `mkdir -p ${errDir} && printf '25\\nunable to push\\n' > ${errDir}/000000010000000000000099.error`,
    );

    const r = await sh(`${SCHEDULER} once 2>&1`);
    expect(r.code, `the scheduler must still exit 0 while alarming:\n${r.out}`).toBe(0);
    expect(r.out).toContain("WAL ARCHIVING IS WEDGED");
    expect(r.out).toMatch(/spool error\(s\)/);
    // The whole point: it fired without needing failed_count to move.
    expect(await qNum("SELECT failed_count FROM pg_stat_archiver")).toBe(failedBefore);

    await sh(`rm -f ${errDir}/000000010000000000000099.error`);
    const clean = await sh(`${SCHEDULER} once 2>&1`);
    expect(clean.out).not.toContain("WAL ARCHIVING IS WEDGED");
  }, 300_000);

  // A marker in the FUTURE (NTP correction on a long-lived box, a restored
  // volume carrying an old marker) made `now - last` negative forever, so the
  // box silently never took another backup while every other signal looked fine.
  it("recovers when the last-full marker is in the future", async () => {
    const before = await fullBackupCount();
    await sh(`echo $(( $(date +%s) + 86400 )) > ${REPO}/.brain-last-full`);

    const r = await sh(`${SCHEDULER} once 2>&1`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("in the FUTURE");
    expect(r.out).toContain("taking a FULL backup");
    expect(await fullBackupCount()).toBeGreaterThan(before);

    // …and the marker is sane again, so the next cycle waits normally.
    const stamp = Number((await sh(`cat ${REPO}/.brain-last-full`)).out.trim());
    expect(stamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5);
    const next = await sh(`${SCHEDULER} once 2>&1`);
    expect(next.out).toContain("no full due");
  }, 300_000);

  // ------------------------------------------------------------ restore drill
  //
  // Everything above proves we WROTE a backup. These prove we can READ one back
  // — the difference between a backup and a hypothesis. The drill is also the
  // one thing in this file that could damage production if it were wrong, so
  // the two dangerous cases are asserted directly, not just the happy path.

  it("DRILL: actually restores the newest backup, starts it, and reads every heap", async () => {
    // The probe lives in a SEPARATE database, not `postgres`. That is the whole
    // point: on a real box the brain's tables are in the `brain` database, and
    // the first version of this drill scanned only `postgres`, found no user
    // tables, summed zero and reported "drill PASSED: read 0 rows" on a box
    // holding ~11k objects. This test passed anyway, because its probe table was
    // in `postgres` — the one database the bug did not affect. A fixture that
    // sits in the only safe place cannot catch a scope bug.
    await sh(
      `psql -U ${SU} -h ${SOCK} -qtAX -d postgres -c "SELECT 1 FROM pg_database WHERE datname='drilldb'" | grep -q 1 || createdb -U ${SU} -h ${SOCK} drilldb`,
    );
    await qDb("drilldb", "CREATE TABLE IF NOT EXISTS drill_probe(id int primary key, note text)");
    await qDb(
      "drilldb",
      "INSERT INTO drill_probe VALUES (1,'a'),(2,'b'),(3,'c') ON CONFLICT DO NOTHING",
    );
    await sh(`${SCHEDULER} now 2>&1`); // a full that contains the probe rows
    await switchAndAwaitArchive();

    const r = await sh(`${SCHEDULER} drill 2>&1`);
    expect(r.code).toBe(0);
    expect(r.out, r.out).toContain("drill PASSED");
    // It restored, started a real postgres, and SCANNED every user table —
    // "started" alone would not catch an unreadable heap.
    expect(r.out).toMatch(/read \d+ row\(s\) across \d+ user table\(s\)/);
    // …and it actually found the rows, in the NON-default database. Asserting a
    // non-zero count is what makes this a proof rather than a smoke test.
    expect(r.out, r.out).toMatch(/drilldb — [1-9]\d* user table\(s\), 3 row\(s\)/);

    // The marker records the pass so the box can report it.
    const marker = (await sh(`cat ${REPO}/.brain-last-drill`)).out.trim();
    expect(marker).toMatch(/^\d+ ok /);

    // …and it cleaned up after itself. A drill that leaves a whole copy of the
    // database behind is a disk-filling bug wearing a backup's clothes.
    const left = await sh(`test -d ${REPO}/.drill && echo present || echo gone`);
    expect(left.out.trim()).toBe("gone");
  }, 600_000);

  it("DRILL: never archives into the live repo (the one failure that would damage prod)", async () => {
    // The restored PGDATA carries production's postgresql.conf verbatim —
    // archive_mode=on, archive_command pointing at OUR stanza. A promoted drill
    // instance that honoured it would push a bogus timeline into the archive
    // every real restore depends on. The drill overrides archive_mode on the
    // command line and asserts it at startup; this proves the repo is untouched
    // across a drill.
    const walBefore = await archivedWalCount();
    const backupsBefore = await fullBackupCount();

    const r = await sh(`${SCHEDULER} drill 2>&1`);
    expect(r.out, r.out).toContain("drill PASSED");

    expect(await archivedWalCount()).toBe(walBefore);
    expect(await fullBackupCount()).toBe(backupsBefore);
    // No stray timeline-history file from a promotion leaking into the archive.
    const histories = await sh(`find ${REPO}/archive/brain -name '*.history' 2>/dev/null | wc -l`);
    expect(Number(histories.out.trim())).toBe(0);
  }, 600_000);

  it("DRILL: never disturbs the LIVE cluster — no postmaster is handed to PID 1", async () => {
    // The bug this pins (found 2026-08-02, by probing rather than by review):
    // the drill used to start its scratch cluster with `pg_ctl start`, which
    // DAEMONISES. The scratch postmaster's parent exits, so the kernel
    // re-parents it to PID 1 of its container. In the `backup` sidecar PID 1 is
    // the scheduler and nothing notices — but the same script ships in the
    // POSTGRES image, where PID 1 IS THE LIVE POSTMASTER. It then reaps a child
    // it never forked, cannot distinguish it from a crashed backend, and does
    // what a crashed backend requires: "terminating any other active server
    // processes" — every connection dropped, the whole cluster crash-recovered.
    // Measured 4 drills, 4 crash-recovery cycles.
    //
    // This suite runs the scheduler inside the postgres container, so it sits in
    // exactly that topology — which is WHY it belongs here: it is the harness
    // that reproduces the operator foot-gun (`docker compose exec postgres
    // brain-backup.sh drill`). The fix forks the postmaster as a direct child
    // and reaps it with `wait`, so no PID 1 anywhere can inherit it.
    //
    // Asserted against the LIVE postmaster's own log, not an inference: that
    // line is emitted only on a crash-recovery cycle, so counting it is a direct
    // reading of "did the user's database go down".
    const crashCount = async (): Promise<number> => {
      const { stdout, stderr } = await run("docker", ["logs", container.getId()], {
        maxBuffer: 64 * 1024 * 1024,
      });
      return `${stdout}${stderr}`.split("all server processes terminated").length - 1;
    };
    const before = await crashCount();

    const r = await sh(`${SCHEDULER} drill 2>&1`);
    expect(r.out, r.out).toContain("drill PASSED");
    // The live cluster is still serving on its own socket, uninterrupted.
    const ready = await sh(`pg_isready -q -h ${SOCK} -p 5432; echo $?`);
    expect(ready.out.trim()).toBe("0");
    expect(await crashCount(), "a restore drill crash-recovered the LIVE cluster").toBe(before);
  }, 600_000);

  it("DRILL: refuses to point at PGDATA, or at any directory containing it", async () => {
    // The drill rm -rf's its target. Pointing it at the live cluster — or at an
    // ancestor of it — must be refused before anything runs, not caught later.
    for (const bad of [PGDATA, `${PGDATA}/base`, "/var/lib/postgresql", "/"]) {
      const r = await sh(`${SCHEDULER} drill 2>&1`, { BRAIN_RESTORE_DRILL_PATH: bad });
      expect(r.code, `drill should refuse ${bad}`).toBe(0); // never exits non-zero
      expect(r.out, `drill should refuse ${bad}`).toContain("REFUSING drill");
    }
    // The live cluster is untouched and still serving. Probe lives in `drilldb`,
    // not `postgres` — see the first DRILL test for why that distinction matters.
    expect(Number(await qDb("drilldb", "SELECT count(*) FROM drill_probe"))).toBe(3);
  }, 300_000);

  it("DRILL: a killed drill's orphaned scratch copy is reclaimed on the next cycle", async () => {
    // A container killed mid-drill leaves a whole copy of the database on the
    // volume. Nothing else would ever remove it, so the next cycle does —
    // BEFORE it reads the disk, so its numbers are honest.
    await sh(
      `mkdir -p ${REPO}/.drill && dd if=/dev/zero of=${REPO}/.drill/junk bs=1M count=8 2>/dev/null`,
    );
    const r = await sh(`${SCHEDULER} once 2>&1`);
    expect(r.out).toContain("reclaiming an orphaned restore-drill directory");
    const left = await sh(`test -d ${REPO}/.drill && echo present || echo gone`);
    expect(left.out.trim()).toBe("gone");
  }, 300_000);

  it("DRILL: an orphan is DELETED, never signalled — a stale pid must not hit the live cluster", async () => {
    // A pid file is a CLAIM about a pid, not a handle on a process. An orphaned
    // drill dir's pid was written by a process in a DEAD container, and
    // container pids are small and heavily reused — signalling it can land on a
    // live postgres backend, which makes the LIVE postmaster terminate every
    // other backend and enter crash recovery. The box's own database briefly
    // stops serving because a backup drill tidied up. So orphans are deleted,
    // never signalled. (The drill no longer resolves ANY pid from a file — it
    // signals the child it forked — but the reclaim path still runs on dirs it
    // did not create, which is what this pins.)
    //
    // Forge exactly that: an orphan holding the LIVE postmaster's pid. If the
    // reclaim signalled it, the live cluster would drop connections.
    const livePid = (await sh(`head -1 ${PGDATA}/postmaster.pid`)).out.trim();
    expect(livePid).toMatch(/^\d+$/);
    await sh(
      `mkdir -p ${REPO}/.drill && cp ${PGDATA}/postmaster.pid ${REPO}/.drill/postmaster.pid`,
    );

    const r = await sh(`${SCHEDULER} once 2>&1`);
    expect(r.out).toContain("reclaiming an orphaned restore-drill directory");

    // The live cluster never noticed: same postmaster, still serving, no crash
    // recovery. (A SIGQUIT would have shown up as a connection drop here.)
    expect((await sh(`head -1 ${PGDATA}/postmaster.pid`)).out.trim()).toBe(livePid);
    expect((await sh(`pg_isready -h ${SOCK} -p 5432`)).code).toBe(0);
    expect(await qNum("SELECT 1")).toBe(1);
  }, 300_000);

  it("DRILL: scratch space is not counted against the repo budget", async () => {
    // The scratch copy lives inside the repo volume. If `du` counted it, a drill
    // would push the repo over budget and start REFUSING backups for space it is
    // about to hand straight back.
    const clean = await sh(`du -sk --exclude=.drill ${REPO} | cut -f1`);
    await sh(
      `mkdir -p ${REPO}/.drill && dd if=/dev/zero of=${REPO}/.drill/junk bs=1M count=32 2>/dev/null`,
    );
    const r = await sh(`${SCHEDULER} once 2>&1`);
    // The logged repo size is the CLEAN one, not clean+32MB.
    const logged = /repo (\d+)K \/ /.exec(r.out)?.[1];
    expect(logged).toBeDefined();
    expect(Number(logged)).toBeLessThan(Number(clean.out.trim()) + 16_000);
    await sh(`rm -rf ${REPO}/.drill`);
  }, 300_000);

  it("DRILL: a future drill marker does not silently disable drills forever", async () => {
    // Same trap as the full-backup marker: a clock that moves backwards leaves
    // `now - last` negative forever, and every other signal keeps looking fine.
    await sh(`echo "$(( $(date +%s) + 864000 )) ok rows=1" > ${REPO}/.brain-last-drill`);
    const r = await sh(`${SCHEDULER} once 2>&1`);
    expect(r.out).toContain("FUTURE");
  }, 300_000);

  it("re-bootstraps from scratch when the repo has been wiped", async () => {
    // Dotfiles need naming explicitly — `${REPO}/*` does not glob them. The
    // drill marker is one, so it has to be listed or the repo is not "wiped".
    const wipe = await sh(
      `rm -rf ${REPO}/* ${REPO}/.brain-last-full ${REPO}/.brain-last-drill ${REPO}/.drill; ls -A ${REPO} | wc -l`,
    );
    expect(wipe.out.trim()).toBe("0");

    // `once` bails politely when the live postgres is momentarily not accepting
    // connections — in production the loop just catches it next poll, so the
    // bail is CORRECT behavior, and this test asserting on a single invocation
    // re-creates the retry by hand. CI hit exactly that: a not-ready instant a
    // few hundred ms wide, right after the preceding drill test, failing this
    // assertion with "waiting (this is normal during a release or a restart)"
    // in the output. Retry the cycle until it actually RAN (bounded by waitFor),
    // rather than treating the scheduler's designed patience as a failure.
    let out = "";
    await waitFor(
      "a cycle that actually ran against a ready postgres",
      async () => {
        const r = await sh(`${SCHEDULER} once`);
        expect(r.code).toBe(0); // even the bail exits 0 — never-exit doctrine
        out = r.out;
        return !r.out.includes("not accepting connections");
      },
      120_000,
      2_000,
    );
    expect(out).toContain("running stanza-create");
    expect(await fullBackupCount()).toBe(1);
  }, 600_000);
});
