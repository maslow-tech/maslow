import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

describe("PG17 + provisioning smoke", () => {
  let brain: FreshBrain;

  beforeAll(async () => {
    brain = await createFreshBrain();
  }, 120_000);

  afterAll(async () => {
    await brain?.drop();
  });

  it("boots PostgreSQL 17 with the builtin C.UTF-8 locale", async () => {
    const client = await brain.connect("superuser");
    try {
      const ver = await client.query<{ n: string }>(
        "SELECT current_setting('server_version_num') AS n",
      );
      expect(Number(ver.rows[0]?.n)).toBeGreaterThanOrEqual(170000);

      const loc = await client.query<{ datlocprovider: string; datlocale: string | null }>(
        `SELECT datlocprovider, datlocale FROM pg_database WHERE datname = current_database()`,
      );
      expect(loc.rows[0]?.datlocprovider).toBe("b"); // builtin provider
      expect(loc.rows[0]?.datlocale).toBe("C.UTF-8");
    } finally {
      await client.end();
    }
  });

  it("applied the initial migration (ledger records 0001)", async () => {
    const client = await brain.connect("owner");
    try {
      const { rows } = await client.query<{ version: string; name: string }>(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      );
      expect(rows.map((r) => r.version)).toContain("0001");
      expect(rows.find((r) => r.version === "0001")?.name).toBe("init");
    } finally {
      await client.end();
    }
  });

  it("running migrations again is a no-op (idempotent)", async () => {
    const client = await brain.connect("owner");
    try {
      const { runMigrations } = await import("@brain/schema");
      const applied = await runMigrations(client);
      expect(applied).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
