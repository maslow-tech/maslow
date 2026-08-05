import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Reader,
  Writer,
  Admin,
  callTool,
  type ToolDeps,
  type AuthedContext,
  FsStore,
} from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";

/**
 * Two footguns found live-driving the MCP surface:
 *
 *  1. z.object strips unknown keys, so edit({body: "..."}) parsed to an op-less
 *     edit and returned SUCCESS while changing nothing — an agent that confuses
 *     write's `body` with edit's `body_ops` believes its edit landed. Every
 *     tool's advertised JSON schema already says additionalProperties: false;
 *     the runtime must actually enforce it.
 *
 *  2. append/prepend concatenate literally (raw): appending "- a bullet" to a
 *     body ending "…the moat." yields "…the moat.- a bullet". Callers keep full
 *     control of separators by including their own newline(s) in the text. (An
 *     earlier revision auto-inserted a blank-line separator, which silently
 *     corrupted inline appends mid-sentence; reverted to literal concatenation.)
 */
describe("edit tool strictness — unknown args rejected, append/prepend concatenate literally", () => {
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
    await deps.admin.bootstrapOwner({ name: "alice", email: "a@example.com" });
    ctx = { actorId: SYSTEM, scopes: ["read", "write", "schema-admin"], role: "owner" };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  async function create(body: string): Promise<{ id: string }> {
    return (await callTool(deps, ctx, "write", { title: "note", body })) as { id: string };
  }

  async function bodyOf(id: string): Promise<string> {
    const got = (await callTool(deps, ctx, "get", { id })) as { body: string };
    return got.body;
  }

  it("edit rejects unknown args instead of silently succeeding (the body-vs-body_ops trap)", async () => {
    const o = await create("original text");
    await expect(
      callTool(deps, ctx, "edit", { id: o.id, version: 1, body: "replacement text" }),
    ).rejects.toThrow(/body/);
    expect(await bodyOf(o.id)).toBe("original text"); // and nothing changed
  });

  it("write rejects unknown args too (strictness is registry-wide)", async () => {
    await expect(
      callTool(deps, ctx, "write", { title: "x", bodyy: "typo'd field" }),
    ).rejects.toThrow(/bodyy/);
  });

  it("append concatenates literally — no separator is injected", async () => {
    const o = await create("…past performance is the moat.");
    await callTool(deps, ctx, "edit", {
      id: o.id,
      version: 1,
      body_ops: [{ op: "append", text: "- [Renewal playbook](https://x) drafted" }],
    });
    expect(await bodyOf(o.id)).toBe(
      "…past performance is the moat.- [Renewal playbook](https://x) drafted",
    );
  });

  it("append preserves a caller-supplied newline verbatim", async () => {
    const o = await create("line one");
    await callTool(deps, ctx, "edit", {
      id: o.id,
      version: 1,
      body_ops: [{ op: "append", text: "\nline two" }],
    });
    expect(await bodyOf(o.id)).toBe("line one\nline two");
  });

  it("append to an empty body is just the new text", async () => {
    const o = (await callTool(deps, ctx, "write", { title: "empty note" })) as { id: string };
    await callTool(deps, ctx, "edit", {
      id: o.id,
      version: 1,
      body_ops: [{ op: "append", text: "first content" }],
    });
    expect(await bodyOf(o.id)).toBe("first content");
  });

  it("prepend concatenates literally — no separator is injected", async () => {
    const o = await create("the existing body");
    await callTool(deps, ctx, "edit", {
      id: o.id,
      version: 1,
      body_ops: [{ op: "prepend", text: "## New heading" }],
    });
    expect(await bodyOf(o.id)).toBe("## New headingthe existing body");
  });

  it("find_replace with an empty find is refused (never splits between every char)", async () => {
    const o = await create("abc");
    await expect(
      callTool(deps, ctx, "edit", {
        id: o.id,
        version: 1,
        body_ops: [{ op: "find_replace", find: "", replace: "X", expectCount: 0 }],
      }),
      // rejected at the schema boundary (find: z.string().min(1)); the runtime
      // applyBodyOp guard is the belt-and-suspenders behind it.
    ).rejects.toThrow(/invalid arguments|find/i);
    expect(await bodyOf(o.id)).toBe("abc"); // body untouched, not "aXbXc"
  });
});
