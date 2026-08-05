import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";
import { McpClient, type McpToolError } from "./support/mcp-client.js";

/**
 * The end-to-end acceptance: a real box app + a scripted MCP
 * client speaking Streamable HTTP JSON-RPC through the full auth + dispatch
 * stack — connect, list tools, build a schema, write, read, search.
 */
describe("e2e · box over MCP", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let client: McpClient;
  let ownerToken: string;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({ pool, ownerClient });

    // install.sh does this first-owner bootstrap in production
    const boot = await new Admin(pool).bootstrapOwner({
      name: "Owner",
      email: "owner@example.com",
    });
    ownerToken = boot.token;
    client = new McpClient((path, init) => Promise.resolve(app.request(path, init)), ownerToken);
  }, 120_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("initializes and lists the tool surface", async () => {
    const init = await client.initialize();
    expect(init.protocolVersion).toBeTruthy();
    expect(init.serverInfo.name).toBe("brain");
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const t of ["define_type", "add_property", "write", "get", "search", "list"]) {
      expect(names).toContain(t);
    }
  });

  it("rejects an unauthenticated / bad token with 401", async () => {
    const anon = new McpClient(
      (path, init) => Promise.resolve(app.request(path, init)),
      "brain_sk_not_a_real_token",
    );
    await expect(anon.initialize()).rejects.toMatchObject({ brain: { code: "refused" } });
  });

  it("drives a full schema→write→read→search flow over MCP", async () => {
    const t = await client.call<{ type_id: number }>("define_type", {
      name: "client",
      properties: [{ name: "tier", kind: "text" }],
    });
    await client.call("add_property", {
      type_id: t.type_id,
      name: "status",
      kind: "enum",
      enum_values: ["prospect", "active"],
    });

    const w = await client.call<{ id: string }>("write", {
      type: "client",
      title: "Acme Corporation",
      body: "a promising prospect",
      props: { tier: "gold", status: "prospect" },
    });
    expect(w.id).toBeTruthy();

    // get/search/list render as line-oriented text on the MCP wire (the
    // presentation layer) — assert on the text, ids appearing shortened.
    const got = await client.call<string>("get", { id: w.id });
    expect(got).toContain(w.id); // the fetched object's own id stays FULL
    expect(got).toContain("client");
    expect(got).toContain("tier=gold");
    expect(got).toContain("status=prospect");

    const found = await client.call<string>("search", { query: "Acme" });
    expect(found).toContain(w.id.slice(0, 13));

    const listed = await client.call<string>("list", {
      type: "client",
      where: { field: "status", op: "eq", value: "prospect" },
    });
    expect(listed).toContain(w.id.slice(0, 13));

    // enum membership is enforced end-to-end
    await expect(
      client.call("write", { type: "client", props: { status: "nonsense" } }),
    ).rejects.toMatchObject({ brain: { code: "validation" } });
  });

  it("returns teaching errors as MCP tool errors (not raw faults)", async () => {
    let err: McpToolError | undefined;
    try {
      await client.call("get", { id: "00000000-0000-0000-0000-000000000009" });
    } catch (e) {
      err = e as McpToolError;
    }
    expect(err?.brain?.code).toBe("not_found");
  });
});
