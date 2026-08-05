import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client, Pool } from "pg";
import { bootstrapRoles, DEV_PASSWORDS, runMigrations, SchemaExecutor } from "@brain/schema";
import { Admin, Writer } from "@brain/mcp-tools";
import { resolveDevDb } from "./dev-db-name.mjs";
import { createBox } from "../src/box.js";
import { wireCollab } from "../src/collab/wire.js";
import type { UpgradeCapableServer } from "../src/collab/server.js";
import { initRetrievalStack } from "../src/retrieval-boot.js";
import { seedBrain } from "./seed.js";
import { scaleFromEnv, seedScale } from "./seed-scale.js";

/**
 * Local dev box: one command that stands up a seeded brain and serves the box
 * on :8080 so the dashboard UI (apps/box/ui) has something real to render.
 *
 *   pnpm --filter @brain/box dev:box
 *
 * - Postgres runs in docker (pgvector/pgvector:pg17, same image as tests) on
 *   :55432, container `brain-dev-pg`, reused across runs.
 * - The `brain_dev` database is DROPPED and re-seeded on every start so the
 *   demo content is deterministic.
 * - Owner/member/viewer tokens are printed and written to dev/dev-tokens.json
 *   (gitignored) for the UI dev loop.
 */

const PG_IMAGE = "pgvector/pgvector:pg17";
const CONTAINER = "brain-dev-pg";
const PG_PORT = 55432;
const DB = resolveDevDb();
const HERE = dirname(fileURLToPath(import.meta.url));

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

async function ensurePostgres(): Promise<void> {
  const running = docker("ps", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Names}}");
  if (running === CONTAINER) return;
  // A stopped leftover with the same name blocks `docker run` — clear it.
  try {
    docker("rm", "-f", CONTAINER);
  } catch {
    /* no leftover container — fine */
  }
  docker(
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_INITDB_ARGS=--locale-provider=builtin --locale=C.UTF-8 --encoding=UTF8",
    "-p",
    `${PG_PORT}:5432`,
    PG_IMAGE,
  );
}

async function waitForPg(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const c = new Client({
      host: "127.0.0.1",
      port: PG_PORT,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    try {
      await c.connect();
      await c.query("SELECT 1");
      await c.end();
      return;
    } catch {
      await c.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("postgres did not become ready on :" + PG_PORT);
}

async function recreateDb(): Promise<void> {
  const admin = new Client({
    host: "127.0.0.1",
    port: PG_PORT,
    user: "postgres",
    password: "postgres",
    database: "postgres",
  });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${DB}"`);
    await admin.query(`CREATE DATABASE "${DB}" TEMPLATE template1`);
  } finally {
    await admin.end();
  }

  const su = new Client({
    host: "127.0.0.1",
    port: PG_PORT,
    user: "postgres",
    password: "postgres",
    database: DB,
  });
  await su.connect();
  try {
    // brain_owner can't CREATE EXTENSION (not superuser), so 0029 would
    // no-op and semantic search would stay off — install pgvector here.
    await su.query("CREATE EXTENSION IF NOT EXISTS vector");
    await bootstrapRoles(su, { database: DB, passwords: DEV_PASSWORDS });
  } finally {
    await su.end();
  }

  const owner = new Client({
    host: "127.0.0.1",
    port: PG_PORT,
    user: "brain_owner",
    password: DEV_PASSWORDS.owner,
    database: DB,
  });
  await owner.connect();
  try {
    await runMigrations(owner);
  } finally {
    await owner.end();
  }
}

async function main(): Promise<void> {
  console.log("dev-box: ensuring postgres container…");
  await ensurePostgres();
  await waitForPg();
  console.log(`dev-box: recreating + migrating ${DB}…`);
  await recreateDb();

  const appUrl = `postgres://brain_app:${DEV_PASSWORDS.app}@127.0.0.1:${PG_PORT}/${DB}`;
  const ownerUrl = `postgres://brain_owner:${DEV_PASSWORDS.owner}@127.0.0.1:${PG_PORT}/${DB}`;

  const pool = new Pool({ connectionString: appUrl, max: 10 });
  pool.on("error", (e) => console.warn(`app pool: idle client error (${String(e)})`));
  const ownerClient = new Client({ connectionString: ownerUrl });
  await ownerClient.connect();
  const ownerKv = new Pool({ connectionString: ownerUrl, max: 3 });
  ownerKv.on("error", (e) => console.warn(`owner-kv pool: idle client error (${String(e)})`));

  console.log("dev-box: seeding demo brain…");
  const tokens = await seedBrain({
    admin: new Admin(pool),
    writer: new Writer(pool),
    executor: new SchemaExecutor(ownerClient),
  });

  // Opt-in bulk graph, for the performance budget the design spec commits to
  // (5,000 nodes / 15,000 edges). Off unless BRAIN_DEV_GRAPH_SCALE is set; see
  // seed-scale.ts for why it is allowed to write SQL directly.
  const scale = scaleFromEnv();
  if (scale) {
    const ownerAccount = tokens.find((t) => t.permission === "owner") ?? tokens[0];
    if (ownerAccount) {
      console.log(`dev-box: seeding ${scale.nodes} nodes / ${scale.edges} edges…`);
      await seedScale(ownerClient, { ...scale, ownerId: ownerAccount.accountId });
    }
  }

  const tokensPath = join(HERE, "dev-tokens.json");
  mkdirSync(dirname(tokensPath), { recursive: true });
  writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
  console.log("\ndev-box tokens (also in apps/box/dev/dev-tokens.json):");
  for (const t of tokens) console.log(`  ${t.permission.padEnd(6)} ${t.name}: ${t.token}`);

  // Retrieval stack v2 in dev — the SAME boot routine as prod (probe,
  // self-heal, degrade-to-lexical), only the model dir and sweep cadence
  // differ: weights live in deploy/models (populated by
  // deploy/fetch-models.sh), and the hot sweep embeds the fresh seed in
  // seconds instead of minutes.
  const { embedQuery, rerank } = await initRetrievalStack({
    ownerClient,
    ownerUrl,
    modelDir: join(HERE, "..", "..", "..", "deploy", "models"),
    sweep: { intervalMs: 2_000, batchSize: 32 },
  });

  /**
   * MULTIPLAYER IS PART OF THE DEV BOX, not an extra.
   *
   * The documented verify loop is "run dev-box, drive the SPA" — so a dev box
   * with no collab server means the loop cannot exercise the feature at all,
   * and a reviewer proving multiplayer has to hand-write a throwaway launcher
   * (which is exactly what happened). This is the SAME `wireCollab` the box
   * entrypoint calls; nothing about the room, the authorizer, the flush or the
   * presence relay is dev-only.
   *
   * The session secret is FIXED in dev so a restart does not invalidate the
   * cookie you are already holding. It is a dev constant and reaches no box.
   */
  const sessionSecret = process.env.BRAIN_DEV_SESSION_SECRET ?? "dev-box-session-secret";
  const wired = wireCollab({
    pool,
    writer: new Writer(pool),
    server: {
      pool,
      sessionSecret,
      // Loopback in both directions; the Origin allowlist accepts the request's
      // own Host when no public URL is configured.
      publicHost: `http://localhost:${Number(process.env.PORT ?? 8080)}`,
      // The Vite dev server proxies /api but the websocket comes from :5173,
      // so its origin has to be allowed explicitly or every upgrade is refused
      // with a code the SPA reports as "denied".
      allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    },
  });

  const app = createBox({
    pool,
    ownerClient,
    ownerKv,
    dashboard: {
      secureCookies: false,
      appVersion: "dev",
      sessionSecret,
      liveRooms: wired.collab.rooms,
    },
    collabProbe: () => wired.collab.probeRoom(),
    ...(embedQuery ? { embedQuery } : {}),
    ...(rerank ? { rerank } : {}),
  });
  const port = Number(process.env.PORT ?? 8080);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`\ndev-box listening on http://localhost:${info.port}`);
    console.log(`  UI dev:   pnpm --filter @brain/box-ui dev  (proxies /api here)`);
    console.log(`  collab:   ws://localhost:${info.port}/dash/collab (rooms + presence live)`);
  });
  // The upgrade event is the ONLY place a websocket can be seen; everything
  // Hono guarantees stops at the line above.
  wired.collab.attach(server as unknown as UpgradeCapableServer);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
