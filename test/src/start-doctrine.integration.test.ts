import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Reader,
  Writer,
  Admin,
  FsStore,
  callTool,
  toolDescriptors,
  INITIALIZE_INSTRUCTIONS,
  type ToolDeps,
  type AuthedContext,
} from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";

describe("start tool + typed tool descriptors", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let deps: ToolDeps;
  let ctx: AuthedContext;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    owner = await brain.connect("owner");
    deps = {
      reader: new Reader(pool),
      writer: new Writer(pool),
      admin: new Admin(pool),
      executor: new SchemaExecutor(owner),
      fsStore: new FsStore(pool),
    };
    ctx = { actorId: SYSTEM, scopes: ["read", "write", "schema-admin"], role: "owner" };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  it("start returns identity + the live catalog (no doctrine — v2 is test-first)", async () => {
    const out = (await callTool(deps, ctx, "start", {})) as { text: string };
    expect(out.text).toMatch(/connected to this org's brain as/);
    expect(out.text).toContain("## Types in this brain");
    expect(out.text).toContain("## Members");
    expect(out.text).toContain("## Relationship verbs in use");
    // the old behavior doctrine is deliberately gone (re-derived by testing)
    expect(out.text).not.toContain("How this brain works");
    // skills: start teaches the 'skill'-type routine convention (create + invoke)
    expect(out.text).toContain("'skill'-type objects");
    expect(out.text).toContain("when_to_run");
    // document everything, link it, and traverse links to answer
    expect(out.text).toContain("Write it down");
    expect(out.text).toContain("Link, don't strand");
    expect(out.text).toContain("traversing");
    // de-dup: check before you add, edit/link the existing record instead
    expect(out.text).toContain("Don't duplicate");
  });

  it("catalog returns you + types-with-properties + members + rels", async () => {
    const cat = (await callTool(deps, ctx, "catalog", {})) as {
      you: { id: string };
      types: unknown[];
      members: unknown[];
      rels: string[];
    };
    expect(cat.you.id).toBe(SYSTEM);
    expect(Array.isArray(cat.types)).toBe(true);
    expect(Array.isArray(cat.members)).toBe(true);
    expect(Array.isArray(cat.rels)).toBe(true);
  });

  it("descriptors carry real JSON schemas, not the untyped stub", () => {
    const all = toolDescriptors();
    const byName = Object.fromEntries(all.map((d) => [d.name, d.inputSchema]));
    // the regression: additionalProperties:true with no properties made
    // clients stringify every arg
    const addProp = byName["add_property"] as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(addProp.properties.type_id?.type).toBe("number");
    expect(addProp.required).toContain("type_id");
    const edit = byName["edit"] as { properties: Record<string, { type?: string }> };
    expect(edit.properties.version?.type).toBe("number");
    // every tool advertises an object schema with declared properties or none needed
    for (const d of all) {
      expect((d.inputSchema as { type: string }).type).toBe("object");
    }
  });

  it("initialize instructions point the agent at start", () => {
    expect(INITIALIZE_INSTRUCTIONS).toContain("call its start tool first");
  });

  it("start + the bash descriptor teach versioning, undelete and locks", async () => {
    // The filesystem stopped being a one-way door (0040): edits snapshot, rm is
    // a soft delete and a human can lock a path. An agent that doesn't know
    // that either refuses to fix a bad write or works around a lock by hand, so
    // both surfaces it reads — start's FILES doctrine and the bash tool
    // description — have to name the commands and the ELOCKED refusal.
    const out = (await callTool(deps, ctx, "start", {})) as { text: string };
    expect(out.text).toContain("history <path>");
    expect(out.text).toContain("diff <path>");
    expect(out.text).toContain("restore <path>");
    expect(out.text).toContain("restore --list");
    expect(out.text).toContain("ELOCKED");
    expect(out.text).not.toContain("no trash, no undo");

    const bash = toolDescriptors().find((d) => d.name === "bash");
    expect(bash?.description).toContain("history <path>");
    expect(bash?.description).toContain("restore <path>");
    expect(bash?.description).toContain("ELOCKED");
    // the old absolute claim is what agents were being taught before
    expect(bash?.description).not.toContain("there is no trash");
  });

  it("start teaches that ref/ref[] properties need an object id, not a member id", async () => {
    // Measured miss (a live event-log sample): agents repeatedly grabbed a
    // member's id straight out of the Members section for claimed_by/
    // decided_by and got a dead-target error every time, because a member id
    // is a login identity, not a graph object — the actual fix is teaching
    // this here, not reconciling the two id spaces in code.
    const out = (await callTool(deps, ctx, "start", {})) as { text: string };
    expect(out.text).toContain("points at another");
    expect(out.text).toContain("never at a member's id");
    expect(out.text).toContain("login identity, not a graph object");
    // and: don't force people into an unrelated type — define one if none fits
    expect(out.text).toContain('define one (e.g. "person")');
  });
});
