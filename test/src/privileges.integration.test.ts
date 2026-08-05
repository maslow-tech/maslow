import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPrivileges } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM_ACCOUNT = "00000000-0000-0000-0000-000000000000";
const PG_INSUFFICIENT_PRIVILEGE = "42501";

async function expectDenied(client: Client, sql: string, params: unknown[] = []): Promise<void> {
  try {
    await client.query(sql, params);
    throw new Error(`expected permission denied, but query succeeded: ${sql}`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    expect(code, `expected 42501 for: ${sql} (got ${String(code)})`).toBe(
      PG_INSUFFICIENT_PRIVILEGE,
    );
  }
}

describe("brain_app privilege model", () => {
  let brain: FreshBrain;
  let app: Client;

  beforeAll(async () => {
    brain = await createFreshBrain();
    app = await brain.connect("app");
  }, 120_000);

  afterAll(async () => {
    await app?.end();
    await brain?.drop();
  });

  it("passes the full catalog privilege audit (reused by the DR runbook)", async () => {
    const su = await brain.connect("superuser");
    try {
      const result = await auditPrivileges(su);
      expect(
        result.ok,
        `privilege violations:\n${result.violations.map((v) => ` - ${v.name}: ${v.detail}`).join("\n")}`,
      ).toBe(true);
      // sanity: the audit actually ran a meaningful number of checks
      expect(result.checks.length).toBeGreaterThan(25);
    } finally {
      await su.end();
    }
  });

  it("blocks account escalation at the DB (no INSERT, no role/status UPDATE)", async () => {
    await expectDenied(app, "INSERT INTO accounts (name, role) VALUES ('mallory', 'owner')");
    await expectDenied(app, "UPDATE accounts SET role = 'owner' WHERE id = $1", [SYSTEM_ACCOUNT]);
    await expectDenied(app, "UPDATE accounts SET status = 'active' WHERE id = $1", [
      SYSTEM_ACCOUNT,
    ]);
    await expectDenied(app, "UPDATE accounts SET token_hash = 'x' WHERE id = $1", [SYSTEM_ACCOUNT]);
    await expectDenied(app, "DELETE FROM accounts WHERE id = $1", [SYSTEM_ACCOUNT]);
  });

  it("forbids forging or mutating the append-only events log", async () => {
    await expectDenied(app, "INSERT INTO events (actor, kind) VALUES ($1, 'forged')", [
      SYSTEM_ACCOUNT,
    ]);
    await expectDenied(app, "UPDATE events SET kind = 'x'");
    await expectDenied(app, "DELETE FROM events");
  });

  it("forbids writing the schema catalog (SELECT-only, M1)", async () => {
    await expectDenied(app, "INSERT INTO types (name, physical_name) VALUES ('evil', 'evil')");
    await expectDenied(app, "UPDATE types SET deprecated = true");
    await expectDenied(app, "DELETE FROM type_properties");
    await expectDenied(
      app,
      "INSERT INTO enum_option (type_id, property_id, value) VALUES (1,1,'x')",
    );
    await expectDenied(app, "INSERT INTO physical_name (name, kind) VALUES ('x','table')");
  });

  it("forbids creating relations in the public schema", async () => {
    await expectDenied(app, "CREATE TABLE evil (id int)");
  });

  it("allows the writes the app legitimately needs", async () => {
    // the write path always sets app.actor_id; the D.3 audit trigger requires it
    await app.query("SELECT set_config('app.actor_id', $1, false)", [SYSTEM_ACCOUNT]);
    // a note (type_id NULL), attributed to the seeded system account
    const ins = await app.query<{ id: string }>(
      "INSERT INTO objects (title, body, created_by) VALUES ('n', 'hello', $1) RETURNING id",
      [SYSTEM_ACCOUNT],
    );
    expect(ins.rows[0]?.id).toBeTruthy();

    // column-limited account update is permitted
    const upd = await app.query("UPDATE accounts SET name = 'system-renamed' WHERE id = $1", [
      SYSTEM_ACCOUNT,
    ]);
    expect(upd.rowCount).toBe(1);

    // and reading the catalog is fine
    const sel = await app.query("SELECT count(*) FROM types");
    expect(sel.rowCount).toBe(1);
  });
});
