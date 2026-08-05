import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations, type Migration } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

describe("migration runner", () => {
  let brain: FreshBrain;
  let owner: Client;

  beforeEach(async () => {
    brain = await createFreshBrain();
    owner = await brain.connect("owner");
  }, 120_000);

  afterEach(async () => {
    await owner?.end();
    await brain?.drop();
  });

  const scratch: Migration = {
    version: "9001",
    name: "scratch",
    sql: "CREATE TABLE scratch_t (id int PRIMARY KEY, a int);",
  };
  const withIndex: Migration = {
    version: "9002",
    name: "scratch_idx",
    sql: "ALTER TABLE scratch_t ADD COLUMN b int;",
    concurrent: [
      "DROP INDEX IF EXISTS scratch_b_ix",
      "CREATE INDEX CONCURRENTLY scratch_b_ix ON scratch_t (b)",
    ],
  };

  async function indexValid(name: string): Promise<boolean | null> {
    const { rows } = await owner.query<{ v: boolean }>(
      `SELECT i.indisvalid AS v FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = $1`,
      [name],
    );
    return rows.length ? (rows[0]?.v ?? null) : null;
  }

  it("applies pending migrations and runs CIC outside the txn (status → done)", async () => {
    const applied = await runMigrations(owner, [scratch, withIndex]);
    expect(applied).toEqual(["9001", "9002"]);
    expect(await indexValid("scratch_b_ix")).toBe(true);

    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM schema_migrations WHERE version = '9002'",
    );
    expect(rows[0]?.status).toBe("done");
  });

  it("is idempotent — re-running applies nothing", async () => {
    await runMigrations(owner, [scratch, withIndex]);
    const again = await runMigrations(owner, [scratch, withIndex]);
    expect(again).toEqual([]);
  });

  it("rolls back a failing migration atomically (no partial state, no ledger row)", async () => {
    const bad: Migration = {
      version: "9003",
      name: "bad",
      sql: "CREATE TABLE ok_t (id int); INSERT INTO does_not_exist VALUES (1);",
    };
    await expect(runMigrations(owner, [bad])).rejects.toThrow();

    const tbl = await owner.query<{ v: string | null }>("SELECT to_regclass('ok_t') AS v");
    expect(tbl.rows[0]?.v).toBeNull();
    const led = await owner.query("SELECT 1 FROM schema_migrations WHERE version = '9003'");
    expect(led.rowCount).toBe(0);
  });

  it("resumes an interrupted CREATE INDEX CONCURRENTLY", async () => {
    await runMigrations(owner, [scratch, withIndex]);
    // Simulate a crash after the txn commit but before/inside the concurrent step:
    // the ledger sits at pending_concurrent and the index is gone.
    await owner.query(
      "UPDATE schema_migrations SET status = 'pending_concurrent' WHERE version = '9002'",
    );
    await owner.query("DROP INDEX scratch_b_ix");
    expect(await indexValid("scratch_b_ix")).toBeNull();

    const applied = await runMigrations(owner, [scratch, withIndex]);
    expect(applied).toEqual(["9002"]); // only the unfinished one resumes
    expect(await indexValid("scratch_b_ix")).toBe(true);
  });

  it("linter blocks a destructive migration; ack lets it through", async () => {
    await runMigrations(owner, [scratch]);
    const drop: Migration = {
      version: "9100",
      name: "drop-a",
      sql: "ALTER TABLE scratch_t DROP COLUMN a;",
    };
    await expect(runMigrations(owner, [drop])).rejects.toThrow(/linter/i);

    const acked: Migration = {
      ...drop,
      allowDestructive: [{ rule: "drop-column", match: "scratch_t", reason: "contract phase" }],
    };
    await expect(runMigrations(owner, [acked])).resolves.toEqual(["9100"]);
    const col = await owner.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='scratch_t' AND column_name='a'",
    );
    expect(col.rowCount).toBe(0);
  });

  it("refuses checksum drift on an already-applied version", async () => {
    await runMigrations(owner, [scratch]);
    const tampered: Migration = { ...scratch, sql: scratch.sql + " -- changed" };
    await expect(runMigrations(owner, [tampered])).rejects.toThrow(/drift/i);
  });
});
