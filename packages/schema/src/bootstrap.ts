import type { Client } from "pg";
import { buildRolesSql, type RolePasswords } from "./roles.js";
import { MIGRATIONS, migrationChecksum, type Migration } from "./migrations/index.js";
import { lintMigrations } from "./migration-linter.js";

/**
 * Bootstrap + migration entry points. The runner is:
 *   - serialized by a session advisory lock (one migrator at a time),
 *   - transactional per migration (a failure leaves no partial state + no
 *     ledger row),
 *   - resumable across CREATE INDEX CONCURRENTLY: the txn commits with a
 *     `pending_concurrent` ledger status, the concurrent (idempotent) steps run
 *     outside the txn, then the row flips to `done`. An interrupted CIC re-runs.
 */

/** Create the three roles + hand ownership to brain_owner. Run as superuser. */
export async function bootstrapRoles(
  superuser: Client,
  opts: { database: string; passwords: RolePasswords },
): Promise<void> {
  await superuser.query(buildRolesSql(opts));
}

const MIGRATION_ADVISORY_LOCK = 4242424242;

/**
 * The ledger is owned by the runner (not a migration) so it can carry the
 * resumability status. Created idempotently as brain_owner.
 */
async function ensureLedger(owner: Client): Promise<void> {
  await owner.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY COLLATE "C",
      name       text NOT NULL,
      checksum   text NOT NULL COLLATE "C",
      status     text NOT NULL DEFAULT 'done'
                   CHECK (status IN ('pending_concurrent', 'done')),
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await owner.query("GRANT SELECT ON schema_migrations TO brain_app");
}

async function runConcurrent(owner: Client, m: Migration): Promise<void> {
  // Outside any transaction (the caller has committed): each statement is
  // idempotent, so an interrupted run resumes by simply re-running them.
  for (const stmt of m.concurrent ?? []) {
    await owner.query(stmt);
  }
}

export interface RunMigrationsOptions {
  /** Skip the linter (used by tests that deliberately apply destructive DDL). */
  readonly skipLint?: boolean;
}

/**
 * Apply all pending migrations in order. Returns the versions applied this run.
 * Refuses a migration whose checksum changed since it was recorded (immutable
 * history) and refuses to apply a lint-flagged destructive migration.
 */
export async function runMigrations(
  owner: Client,
  migrations: readonly Migration[] = MIGRATIONS,
  opts: RunMigrationsOptions = {},
): Promise<string[]> {
  if (!opts.skipLint) {
    const findings = lintMigrations(migrations);
    if (findings.length > 0) {
      const summary = findings.map((f) => ` - ${f.version} [${f.rule}]: ${f.message}`).join("\n");
      throw new Error(`migration linter blocked ${findings.length} finding(s):\n${summary}`);
    }
  }

  await owner.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK]);
  const applied: string[] = [];
  try {
    await ensureLedger(owner);

    const known = new Map<string, { checksum: string; status: string }>();
    const { rows } = await owner.query<{ version: string; checksum: string; status: string }>(
      "SELECT version, checksum, status FROM schema_migrations",
    );
    for (const r of rows) known.set(r.version, { checksum: r.checksum, status: r.status });

    for (const m of migrations) {
      const checksum = migrationChecksum(m);
      const prior = known.get(m.version);

      if (prior !== undefined) {
        if (prior.checksum !== checksum) {
          throw new Error(
            `migration ${m.version} (${m.name}) checksum drift: applied migrations are immutable`,
          );
        }
        if (prior.status === "done") continue;
        // Interrupted between the txn commit and the concurrent steps: finish them.
        await runConcurrent(owner, m);
        await owner.query("UPDATE schema_migrations SET status = 'done' WHERE version = $1", [
          m.version,
        ]);
        applied.push(m.version);
        continue;
      }

      const hasConcurrent = (m.concurrent?.length ?? 0) > 0;
      await owner.query("BEGIN");
      try {
        await owner.query(m.sql);
        await owner.query(
          `INSERT INTO schema_migrations (version, name, checksum, status)
           VALUES ($1, $2, $3, $4)`,
          [m.version, m.name, checksum, hasConcurrent ? "pending_concurrent" : "done"],
        );
        await owner.query("COMMIT");
      } catch (err) {
        await owner.query("ROLLBACK");
        throw err;
      }

      if (hasConcurrent) {
        await runConcurrent(owner, m);
        await owner.query("UPDATE schema_migrations SET status = 'done' WHERE version = $1", [
          m.version,
        ]);
      }
      applied.push(m.version);
    }
  } finally {
    await owner.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK]);
  }
  return applied;
}
