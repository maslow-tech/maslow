import { randomUUID } from "node:crypto";
import { Client, type ClientConfig } from "pg";
import { bootstrapRoles, DEV_PASSWORDS, runMigrations, type Migration } from "@brain/schema";

/** Coordinates of the shared container started by global-setup. */
export function sharedConn(): { host: string; port: number } {
  const host = process.env.BRAIN_PG_HOST;
  const port = Number(process.env.BRAIN_PG_PORT);
  if (!host || !Number.isFinite(port)) {
    throw new Error("shared PG not started — is the vitest globalSetup configured?");
  }
  return { host, port };
}

const SUPERUSER = "postgres";
const SUPERUSER_PASSWORD = "postgres";

export interface FreshBrain {
  readonly database: string;
  readonly superuserConfig: ClientConfig;
  readonly ownerConfig: ClientConfig;
  readonly appConfig: ClientConfig;
  /** Open a client as a given role (caller ends it). */
  connect(role: "superuser" | "owner" | "app"): Promise<Client>;
  drop(): Promise<void>;
}

/**
 * Create a fresh, fully-provisioned brain database (roles + initial migration)
 * on the shared container. Databases are cloned from template1, which initdb
 * gave the builtin C.UTF-8 locale, so the collation model is preserved.
 */
export async function createFreshBrain(migrations?: readonly Migration[]): Promise<FreshBrain> {
  const { host, port } = sharedConn();
  const database = `brain_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  const admin = new Client({
    host,
    port,
    user: SUPERUSER,
    password: SUPERUSER_PASSWORD,
    database: "postgres",
  });
  await admin.connect();
  try {
    // `database` is generated hex → safe to interpolate.
    await admin.query(`CREATE DATABASE ${database} TEMPLATE template1`);
  } finally {
    await admin.end();
  }

  const superuserConfig: ClientConfig = {
    host,
    port,
    user: SUPERUSER,
    password: SUPERUSER_PASSWORD,
    database,
  };
  const ownerConfig: ClientConfig = {
    host,
    port,
    user: "brain_owner",
    password: DEV_PASSWORDS.owner,
    database,
  };
  const appConfig: ClientConfig = {
    host,
    port,
    user: "brain_app",
    password: DEV_PASSWORDS.app,
    database,
  };

  const su = new Client(superuserConfig);
  await su.connect();
  try {
    await bootstrapRoles(su, { database, passwords: DEV_PASSWORDS });
  } finally {
    await su.end();
  }

  const owner = new Client(ownerConfig);
  await owner.connect();
  try {
    await runMigrations(owner, migrations);
  } finally {
    await owner.end();
  }

  return {
    database,
    superuserConfig,
    ownerConfig,
    appConfig,
    async connect(role) {
      const cfg =
        role === "superuser" ? superuserConfig : role === "owner" ? ownerConfig : appConfig;
      const client = new Client(cfg);
      await client.connect();
      return client;
    },
    async drop() {
      const a = new Client({
        host,
        port,
        user: SUPERUSER,
        password: SUPERUSER_PASSWORD,
        database: "postgres",
      });
      await a.connect();
      try {
        await a.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
        await a.query(`DROP DATABASE IF EXISTS ${database}`);
      } finally {
        await a.end();
      }
    },
  };
}
