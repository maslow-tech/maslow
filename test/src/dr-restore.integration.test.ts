import { Client } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPrivileges, bootstrapRoles, DEV_PASSWORDS, runMigrations } from "@brain/schema";

/**
 * DR round-trip — globals-first restore + privilege audit
 * (the acceptance bar: "DR round-trip incl. --globals-only +
 * privilege-audit assertions").
 *
 * The load-bearing claim: **recovery must not re-open escalation.** A `pg_dump`
 * of the brain database carries table ownership + grants (the least-
 * privilege model) but NOT the roles themselves (roles are cluster-global). So
 * a faithful DR restores the globals FIRST, then the database, then re-asserts
 * the exact privilege model with the same `auditPrivileges` the fresh-box
 * test uses.
 *
 * We prove globals-first is genuinely load-bearing by restoring into a SECOND,
 * fresh cluster that has no brain_* roles at all: skip the globals and the
 * database restore's `ALTER ... OWNER TO brain_owner` / `GRANT ... TO brain_app`
 * would fail, leaving objects owned by the superuser — the exact silent
 * escalation a careless restore invites. Here we do it in the correct order and
 * assert the model survived.
 *
 * This file spins its own postgres:17 containers (not the shared harness) so it
 * has container `exec` access to run pg_dumpall / pg_dump / psql, and two
 * independent clusters for a true source→target round-trip.
 */

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const SUPERUSER = "postgres";
const SUPERUSER_PASSWORD = "postgres";
const PG_IMAGE = "postgres:17";
// Match pg-harness.ts: builtin, version-stable, OS-independent collation.
const INITDB_ARGS = "--locale-provider=builtin --locale=C.UTF-8 --encoding=UTF8";

interface Box {
  readonly container: StartedTestContainer;
  readonly host: string;
  readonly port: number;
}

// See pr6-backups: a pg Client emits an 'error' EVENT when its socket drops
// (container.stop() in afterAll, or an instance restart). Without a listener
// that becomes an unhandled exception that the single-fork runner misattributes
// to an unrelated file. Guard every client we open here too.
let tearingDown = false;
const EXPECTED_DISCONNECT = new Set(["57P01", "57P02", "57P03", "ECONNRESET", "EPIPE"]);
function attachDisconnectGuard(c: Client, label: string): void {
  c.on("error", (err: Error & { code?: string }) => {
    const expected =
      tearingDown ||
      (err.code !== undefined && EXPECTED_DISCONNECT.has(err.code)) ||
      /terminat|connection.*closed|server closed/i.test(err.message);
    if (!expected) console.warn(`[${label}] unexpected client error: ${String(err)}`);
  });
}

async function startPg(env: Record<string, string>): Promise<Box> {
  const container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: SUPERUSER,
      POSTGRES_PASSWORD: SUPERUSER_PASSWORD,
      POSTGRES_INITDB_ARGS: INITDB_ARGS,
      ...env,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();
  return { container, host: container.getHost(), port: container.getMappedPort(5432) };
}

/** Run a shell command in the container and fail loudly on a non-zero exit. */
async function sh(box: Box, cmd: string): Promise<string> {
  const res = await box.container.exec(["sh", "-c", cmd]);
  if (res.exitCode !== 0) {
    throw new Error(`exec failed (exit ${res.exitCode}): ${cmd}\n${res.output}`);
  }
  return res.output;
}

describe("DR round-trip (globals-first + privilege audit)", () => {
  let source: Box;
  let target: Box;

  beforeAll(async () => {
    // Source cluster owns the `brain` database; target is a bare fresh cluster
    // (default `postgres` db only — no `brain`, no brain_* roles).
    // Promise.allSettled (not .all): if one container fails to start, the one
    // that DID start must still be torn down, or its container + anonymous
    // volume leak forever (afterAll below only stops `source`/`target`, which
    // Promise.all would leave unassigned on a partial failure).
    const [sourceResult, targetResult] = await Promise.allSettled([
      startPg({ POSTGRES_DB: "brain" }),
      startPg({ POSTGRES_DB: "postgres" }),
    ]);
    const started = [sourceResult, targetResult].flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    if (sourceResult.status === "rejected") {
      await Promise.all(started.map((box) => box.container.stop().catch(() => {})));
      throw sourceResult.reason;
    }
    if (targetResult.status === "rejected") {
      await Promise.all(started.map((box) => box.container.stop().catch(() => {})));
      throw targetResult.reason;
    }
    source = sourceResult.value;
    target = targetResult.value;
  }, 180_000);

  afterAll(async () => {
    tearingDown = true;
    await source?.container.stop().catch(() => {});
    await target?.container.stop().catch(() => {});
  });

  it("restores globals-first into a fresh cluster and the privilege model survives", async () => {
    // ---- 1. build a real brain on the source: roles + migrations + data ----
    const su = new Client({
      host: source.host,
      port: source.port,
      user: SUPERUSER,
      password: SUPERUSER_PASSWORD,
      database: "brain",
    });
    attachDisconnectGuard(su, "pr6-dr/su");
    await su.connect();
    try {
      await bootstrapRoles(su, { database: "brain", passwords: DEV_PASSWORDS });
    } finally {
      await su.end();
    }

    const owner = new Client({
      host: source.host,
      port: source.port,
      user: "brain_owner",
      password: DEV_PASSWORDS.owner,
      database: "brain",
    });
    attachDisconnectGuard(owner, "pr6-dr/owner");
    await owner.connect();
    try {
      await runMigrations(owner);
      // write some data AS brain_owner (owner owns the tables). The D.3 audit
      // trigger requires a non-null actor, so set app.actor_id first.
      await owner.query("SELECT set_config('app.actor_id', $1, false)", [SYSTEM]);
      await owner.query(
        "INSERT INTO objects (id, title, body, created_by) VALUES ($1, 'DR note', 'survive the restore', $2)",
        ["11111111-1111-1111-1111-111111111111", SYSTEM],
      );
      // sanity: the source itself already satisfies the model.
      const pre = await auditPrivileges(owner);
      expect(pre.ok, `source violations:\n${pre.violations.map((v) => v.name).join("\n")}`).toBe(
        true,
      );
    } finally {
      await owner.end();
    }

    // ---- 2. capture the dumps via container exec ---------------------------
    // Globals = roles + grants + role attributes (cluster-wide). Written to a
    // file then cat'd so only stdout (the SQL) comes back, never stderr NOTICEs.
    await sh(
      source,
      "pg_dumpall -U postgres -h /var/run/postgresql --globals-only > /tmp/globals.sql",
    );
    // The database itself, with ownership + ACLs. --create so the restore
    // recreates `brain` owned by brain_owner on the target cluster.
    await sh(
      source,
      "pg_dump -U postgres -h /var/run/postgresql --create --format=plain -d brain > /tmp/brain.sql",
    );
    const globalsSql = (await source.container.exec(["cat", "/tmp/globals.sql"])).output;
    const brainSql = (await source.container.exec(["cat", "/tmp/brain.sql"])).output;

    // the globals must actually define the brain_* roles (globals-first is real)
    expect(globalsSql).toContain("CREATE ROLE brain_owner");
    expect(globalsSql).toContain("CREATE ROLE brain_app");

    // ---- 3. restore into the fresh target cluster, globals FIRST -----------
    await target.container.copyContentToContainer([
      { content: globalsSql, target: "/tmp/globals.sql" },
      { content: brainSql, target: "/tmp/brain.sql" },
    ]);

    // globals first: creates brain_owner/brain_app/brain_external. (No
    // ON_ERROR_STOP: the bootstrap `postgres` superuser ALTER is benign.)
    await sh(target, "psql -U postgres -h /var/run/postgresql -d postgres -f /tmp/globals.sql");

    // then the database: --create makes it, populates it, applies ownership+ACLs.
    // ON_ERROR_STOP=1 → any ownership/grant failure (i.e. globals were skipped)
    // would fail the restore loudly instead of silently mis-owning objects.
    await sh(
      target,
      "psql -U postgres -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -f /tmp/brain.sql",
    );

    // ---- 4. the data survived ---------------------------------------------
    const tgtSu = new Client({
      host: target.host,
      port: target.port,
      user: SUPERUSER,
      password: SUPERUSER_PASSWORD,
      database: "brain",
    });
    attachDisconnectGuard(tgtSu, "pr6-dr/tgtSu");
    await tgtSu.connect();
    try {
      const note = await tgtSu.query<{ body: string }>("SELECT body FROM objects WHERE id = $1", [
        "11111111-1111-1111-1111-111111111111",
      ]);
      expect(note.rows[0]?.body).toBe("survive the restore");

      // ---- 5. THE GATE: the least-privilege model survived the restore -----
      const audit = await auditPrivileges(tgtSu);
      expect(
        audit.ok,
        `privilege model did not survive the DR restore:\n${audit.violations
          .map((v) => ` - ${v.name}: ${v.detail}`)
          .join("\n")}`,
      ).toBe(true);
      // sanity: the audit actually exercised a meaningful number of checks
      expect(audit.checks.length).toBeGreaterThan(25);

      // and explicitly: brain_app is still owned by nobody + can't touch the
      // escalation surfaces (belt-and-braces beyond audit.ok).
      const ownsNothing = await tgtSu.query<{ v: boolean }>(
        `SELECT count(*) = 0 AS v FROM pg_class c JOIN pg_roles r ON c.relowner = r.oid
         WHERE r.rolname = 'brain_app' AND c.relkind = 'r'`,
      );
      expect(ownsNothing.rows[0]?.v).toBe(true);
      const brainOwnerOwnsObjects = await tgtSu.query<{ v: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON c.relowner = r.oid
         WHERE c.relname = 'objects' AND r.rolname = 'brain_owner') AS v`,
      );
      expect(brainOwnerOwnsObjects.rows[0]?.v).toBe(true);
    } finally {
      await tgtSu.end();
    }
  }, 180_000);
});
