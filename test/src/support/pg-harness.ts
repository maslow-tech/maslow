import { Client, type ClientConfig } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

/**
 * Ephemeral PG17 for integration/e2e/scenario suites.
 *
 * The container is initialized with the **PG17 builtin `C.UTF-8` locale**
 * — version-stable and OS-independent — so tests run against
 * the same collation the real box uses. Everything else (roles, the initial
 * migration, the executor) is layered on top by the suites.
 */

// pgvector build of postgres:17 — migration 0014 (semantic search) needs the
// extension available; everything else is identical to stock postgres:17.
const PG_IMAGE = "pgvector/pgvector:pg17";
const SUPERUSER = "postgres";
const SUPERUSER_PASSWORD = "postgres";
const DEFAULT_DB = "brain";

export interface StartedPg {
  readonly container: StartedTestContainer;
  readonly host: string;
  readonly port: number;
  /** A superuser connection config for the default `brain` database. */
  superuserConfig(database?: string): ClientConfig;
  /** Open a new superuser client (caller must `end()` it). */
  connect(database?: string): Promise<Client>;
  stop(): Promise<void>;
}

export async function startPg(): Promise<StartedPg> {
  const container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: SUPERUSER,
      POSTGRES_PASSWORD: SUPERUSER_PASSWORD,
      POSTGRES_DB: DEFAULT_DB,
      // PG17 builtin locale provider — version-stable, OS-independent.
      POSTGRES_INITDB_ARGS: "--locale-provider=builtin --locale=C.UTF-8 --encoding=UTF8",
    })
    .withExposedPorts(5432)
    // postgres logs "ready to accept connections" once during initdb and once
    // on the real start; wait for the second so initdb (and POSTGRES_DB) is done.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  const superuserConfig = (database: string = DEFAULT_DB): ClientConfig => ({
    host,
    port,
    user: SUPERUSER,
    password: SUPERUSER_PASSWORD,
    database,
  });

  return {
    container,
    host,
    port,
    superuserConfig,
    async connect(database?: string): Promise<Client> {
      const client = new Client(superuserConfig(database));
      await client.connect();
      return client;
    },
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}
