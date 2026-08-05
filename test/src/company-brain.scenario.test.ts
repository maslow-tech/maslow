import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { exportBrain, importBrain } from "@brain/cli";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";
import { McpClient, type McpToolError } from "./support/mcp-client.js";

/**
 * The red-team scenario suite — the required merge gate. A
 * realistic company-brain session over the REAL MCP surface, then adversarial
 * cross-cutting probes proving the invariants compose (no single feature's
 * tests own "they all hold together at once").
 */
describe("scenario · a company brain, end to end + under attack", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let owner: McpClient;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({ pool, ownerClient });
    const boot = await new Admin(pool).bootstrapOwner({
      name: "Founder",
      email: "owner@example.com",
    });
    owner = new McpClient((p, i) => Promise.resolve(app.request(p, i)), boot.token);
  }, 120_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  const ids: Record<string, string> = {};

  it("builds a CRM schema and populates it (schema→write→link→search)", async () => {
    const client = await owner.call<{ type_id: number }>("define_type", { name: "client" });
    const deal = await owner.call<{ type_id: number }>("define_type", { name: "deal" });
    await owner.call("add_property", {
      type_id: client.type_id,
      name: "tier",
      kind: "enum",
      enum_values: ["bronze", "gold"],
    });
    await owner.call("add_property", {
      type_id: deal.type_id,
      name: "account",
      kind: "ref",
      ref_type_name: "client",
    });
    await owner.call("add_property", {
      type_id: deal.type_id,
      name: "amount",
      kind: "decimal",
    });

    const acme = await owner.call<{ id: string }>("write", {
      type: "client",
      title: "Acme Aerospace",
      props: { tier: "gold" },
    });
    ids.acme = acme.id;
    const d = await owner.call<{ id: string }>("write", {
      type: "deal",
      title: "Acme Q1",
      props: { account: acme.id, amount: "50000.00" },
    });
    ids.deal = d.id;

    // the ref materialized a backlink edge (D.2) — visible on get (rendered
    // text; backlink targets carry short ids)
    const acmeFull = await owner.call<string>("get", { id: acme.id });
    expect(acmeFull).toContain(`account ← "Acme Q1" (deal ${d.id.slice(0, 13)}, ref:account)`);

    // search finds by a typed field value
    const hits = await owner.call<string>("search", { query: "aerospace", type: "client" });
    expect(hits).toContain(acme.id.slice(0, 13));
  });

  it("dedupes safely (merge re-points the ref) and soft-delete round-trips", async () => {
    const dup = await owner.call<{ id: string }>("write", {
      type: "client",
      title: "ACME",
      props: { tier: "bronze" },
    });
    await owner.call("merge", { loser: dup.id, winner: ids.acme });
    // loser is a tombstone; the winner keeps the deal's ref. Rendered get
    // surfaces a tombstone as a DELETED line (and omits it on live objects).
    const loser = await owner.call<string>("get", { id: dup.id });
    expect(loser).toContain("DELETED");

    await owner.call("delete", { id: ids.deal });
    expect(await owner.call<string>("get", { id: ids.deal })).toContain("DELETED");
    await owner.call("restore", { id: ids.deal });
    expect(await owner.call<string>("get", { id: ids.deal })).not.toContain("DELETED");
  });

  it("member scoping + DB-enforced no-escalation", async () => {
    const member = await owner.call<{ id: string; token: string }>("create_user", {
      name: "Analyst",
      email: "user@example.com",
      permission: "viewer",
    });
    const analyst = new McpClient((p, i) => Promise.resolve(app.request(p, i)), member.token);
    await analyst.call("catalog", {}); // read ok
    await expect(analyst.call("write", { title: "nope" })).rejects.toMatchObject({
      brain: { code: "refused" },
    });
    await expect(
      analyst.call("create_user", { name: "x", email: "user@example.com", permission: "viewer" }),
    ).rejects.toMatchObject({ brain: { code: "refused" } });
  });

  it("survives the injection gauntlet (identifier / literal / AST)", async () => {
    // identifier injection → schema error, nothing runs
    await expect(
      owner.call("define_type", { name: "x'; DROP TABLE objects; --" }),
    ).rejects.toMatchObject({ brain: { code: "schema" } });
    // AST field injection → validation, objects intact
    await expect(
      owner.call("list", {
        type: "client",
        where: { field: "tier); DROP TABLE objects; --", op: "eq", value: "gold" },
      }),
    ).rejects.toMatchObject({ brain: { code: "validation" } });
    // literal is stored as data, never executed
    const evil = "'; DELETE FROM objects; --";
    const n = await owner.call<{ id: string }>("write", { title: evil, body: evil });
    const got = await owner.call<string>("get", { id: n.id });
    expect(got).toContain(`title: ${evil}`);
    // the brain is very much still here
    expect(await owner.call<string>("search", { query: "aerospace", type: "client" })).not.toMatch(
      /^0 hits/,
    );
  });

  it("optimistic concurrency: two edits at the same version — one conflicts", async () => {
    const n = await owner.call<{ id: string; version: number }>("write", { body: "base" });
    const [a, b] = await Promise.allSettled([
      owner.call("edit", { id: n.id, version: n.version, body_ops: [{ op: "set", text: "A" }] }),
      owner.call("edit", { id: n.id, version: n.version, body_ops: [{ op: "set", text: "B" }] }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("offboarding: the whole brain exports and re-hydrates into a fresh box", async () => {
    const data = JSON.parse(JSON.stringify(await exportBrain(ownerClient)));

    const fresh = await createFreshBrain();
    const freshOwner = await fresh.connect("owner");
    try {
      await importBrain(freshOwner, data);
      // Readbacks under the txn-local DR escape on BOTH sides: since 0057 a
      // bare brain_owner connection holds no tags and counts zero objects.
      const drCount = async (c: typeof freshOwner): Promise<string> => {
        await c.query("BEGIN");
        try {
          await c.query("SET LOCAL app.fs_dr = 'on'");
          return (await c.query<{ n: string }>("SELECT count(*)::text AS n FROM objects")).rows[0]!
            .n;
        } finally {
          await c.query("COMMIT");
        }
      };
      expect(await drCount(freshOwner)).toBe(await drCount(ownerClient));
      // the migrated deal's ref survived
      await freshOwner.query("BEGIN");
      await freshOwner.query("SET LOCAL app.fs_dr = 'on'");
      const deal = await freshOwner.query<{ account: string }>(
        "SELECT account FROM deal_ext WHERE id = $1",
        [ids.deal],
      );
      await freshOwner.query("COMMIT");
      expect(deal.rows[0]!.account).toBe(ids.acme);
    } finally {
      await freshOwner.end();
      await fresh.drop();
    }
  });

  it("a teaching error never echoes stored content", async () => {
    let err: McpToolError | undefined;
    try {
      await owner.call("get", { id: "00000000-0000-0000-0000-0000000000aa" });
    } catch (e) {
      err = e as McpToolError;
    }
    expect(err?.brain?.code).toBe("not_found");
    expect(JSON.stringify(err?.brain)).not.toMatch(/DELETE FROM|DROP TABLE/);
  });
});
