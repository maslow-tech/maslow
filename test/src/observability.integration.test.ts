import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import { toBoxErrorReport } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/** the distinguished system actor (migration 0001) — machine-action attribution. */
const SYSTEM_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

describe("observability egress (operator actor removed in 0017)", () => {
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

  it("a real pg unique violation maps to a closed code without leaking row values", async () => {
    const exec = new SchemaExecutor(owner);
    await exec.defineType({ name: "client" }, SYSTEM_ACCOUNT_ID);
    let caught: unknown;
    try {
      await owner.query("INSERT INTO types (name, physical_name) VALUES ('client', 'client')");
    } catch (e) {
      caught = e;
    }
    const report = toBoxErrorReport(caught);
    expect(report.code).toBe("db_unique_violation");
    expect(JSON.stringify(report)).not.toMatch(/client/); // no content leaked
  });

  it("the operator actor is gone: no row, and the role CHECK refuses 'operator'", async () => {
    // 0017 removed the never-used SSM-era operator account entirely.
    const rows = await owner.query("SELECT 1 FROM accounts WHERE role = 'operator'");
    expect(rows.rowCount).toBe(0);
    await expect(
      owner.query(
        `INSERT INTO accounts (name, role, status, scopes)
         VALUES ('ghost op', 'operator', 'active', '{}')`,
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });
});
