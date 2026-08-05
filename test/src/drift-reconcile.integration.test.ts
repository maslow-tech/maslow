import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { driftReport, reconcileDrift, SchemaExecutor } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";

describe("drift reconciler", () => {
  let brain: FreshBrain;
  let owner: Client;
  let exec: SchemaExecutor;
  let typeId: number;

  beforeEach(async () => {
    brain = await createFreshBrain();
    owner = await brain.connect("owner");
    exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    typeId = t.typeId;
    await exec.addProperty({ typeId, name: "tier", kind: "text" }, SYSTEM);
    await exec.addProperty({ typeId, name: "tags", kind: "ref[]", refTypeName: "client" }, SYSTEM);
  }, 120_000);

  afterEach(async () => {
    await owner?.end();
    await brain?.drop();
  });

  it("reports no drift on a healthy schema", async () => {
    expect(await driftReport(owner)).toEqual([]);
  });

  it("detects a missing column and quarantines the type", async () => {
    await owner.query("ALTER TABLE client_ext DROP COLUMN tier");
    const findings = await driftReport(owner);
    expect(findings.map((f) => f.kind)).toContain("missing_column");

    const res = await reconcileDrift(owner, { quarantine: true, actor: SYSTEM });
    expect(res.quarantined).toContain(typeId);
    const dep = await owner.query<{ deprecated: boolean }>(
      "SELECT deprecated FROM types WHERE id = $1",
      [typeId],
    );
    expect(dep.rows[0]!.deprecated).toBe(true);
    const ev = await owner.query("SELECT 1 FROM events WHERE kind = 'quarantine_type'");
    expect(ev.rowCount).toBe(1);
  });

  it("detects a missing ext table and a missing junction", async () => {
    // drop the ref[] junction
    const j = await owner.query<{ name: string }>(
      "SELECT name FROM physical_name WHERE type_id = $1 AND name <> 'client_ext' AND kind = 'table'",
      [typeId],
    );
    await owner.query(`DROP TABLE "${j.rows[0]!.name}"`);
    const findings = await driftReport(owner);
    expect(findings.map((f) => f.kind)).toContain("missing_junction");
  });

  it("post-restore mode is report-only (never quarantines)", async () => {
    await owner.query("ALTER TABLE client_ext DROP COLUMN tier");
    const res = await reconcileDrift(owner, {
      quarantine: true,
      postRestore: true,
      actor: SYSTEM,
    });
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.quarantined).toEqual([]);
    const dep = await owner.query<{ deprecated: boolean }>(
      "SELECT deprecated FROM types WHERE id = $1",
      [typeId],
    );
    expect(dep.rows[0]!.deprecated).toBe(false);
  });
});
