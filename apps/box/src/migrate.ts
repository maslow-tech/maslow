import { Client, Pool } from "pg";
import { bootstrapRoles, reconcileDrift, runMigrations, type RolePasswords } from "@brain/schema";
import { Admin } from "@brain/mcp-tools";

/**
 * The box migration entrypoint — `node dist/migrate.js`.
 * Run once at install (and idempotently on every update): create the three
 * roles as superuser, run the infra migrations as brain_owner, report drift,
 * and — if BRAIN_BOOTSTRAP_OWNER_NAME is set — do the one-time first-owner
 * bootstrap, printing the owner token ONCE (install.sh captures + ships it).
 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const database = process.env.BRAIN_DB ?? "brain";
  const passwords: RolePasswords = {
    owner: requireEnv("BRAIN_OWNER_PASSWORD"),
    app: requireEnv("BRAIN_APP_PASSWORD"),
    external: requireEnv("BRAIN_EXTERNAL_PASSWORD"),
  };

  // 1. roles + ownership, as the cluster superuser
  const su = new Client({ connectionString: requireEnv("BRAIN_SUPERUSER_DATABASE_URL") });
  await su.connect();
  try {
    await bootstrapRoles(su, { database, passwords });
    console.log("migrate: roles bootstrapped");
  } finally {
    await su.end();
  }

  // 2. infra migrations + drift report, as brain_owner
  const owner = new Client({ connectionString: requireEnv("BRAIN_OWNER_DATABASE_URL") });
  await owner.connect();
  try {
    const applied = await runMigrations(owner);
    console.log(
      `migrate: applied ${applied.length} migration(s): ${applied.join(", ") || "(none new)"}`,
    );
    const drift = await reconcileDrift(owner);
    console.log(`migrate: drift findings = ${drift.findings.length}`);
  } finally {
    await owner.end();
  }

  // 3. one-time first-owner bootstrap (self-guarding on zero-owner). Requires a
  //    real name + email — no nameless default owner.
  const ownerName = process.env.BRAIN_BOOTSTRAP_OWNER_NAME;
  const ownerEmail = process.env.BRAIN_BOOTSTRAP_OWNER_EMAIL;
  if (Boolean(ownerName) !== Boolean(ownerEmail)) {
    // A stale half-set bootstrap var must NEVER fail the migrate: this runs on
    // every update, and throwing here latches the updater on already-running
    // boxes (fresh installs are guarded by install.sh, which requires both).
    console.warn(
      "migrate: BRAIN_BOOTSTRAP_OWNER_NAME/EMAIL only partially set — bootstrap skipped " +
        "(set BOTH to bootstrap a first owner; remove the leftover var to silence this)",
    );
  }
  if (ownerName && ownerEmail) {
    const pool = new Pool({ connectionString: requireEnv("BRAIN_APP_DATABASE_URL") });
    pool.on("error", (e) => console.warn(`migrate pool: idle client error (${String(e)})`));
    try {
      const boot = await new Admin(pool).bootstrapOwner({ name: ownerName, email: ownerEmail });
      console.log(`OWNER_TOKEN=${boot.token}`); // printed once; ship to the operator
    } catch {
      console.log("migrate: an owner already exists (bootstrap skipped)");
    } finally {
      await pool.end();
    }
  }
  console.log("migrate: done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
