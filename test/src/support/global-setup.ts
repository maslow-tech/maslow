import { startPg, type StartedPg } from "./pg-harness.js";

/**
 * One ephemeral PG17 for the whole integration/e2e/scenario run. Each test
 * creates its own uniquely-named database (see createFreshBrain) so suites are
 * isolated without paying a container spin per file. Connection coordinates are
 * handed to the (forked) test workers via env, which they inherit at spawn.
 */
let pg: StartedPg | undefined;

export async function setup(): Promise<void> {
  pg = await startPg();
  // pgvector into template1 (superuser — the extension isn't owner-creatable),
  // so every createFreshBrain clone is born with it, exactly like a prod box
  // whose initdb script installed it (deploy/postgres). Migration 0014 then
  // only has to see it in pg_extension.
  const admin = await pg.connect("template1");
  try {
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await admin.end();
  }
  process.env.BRAIN_PG_HOST = pg.host;
  process.env.BRAIN_PG_PORT = String(pg.port);
}

export async function teardown(): Promise<void> {
  await pg?.stop();
}
