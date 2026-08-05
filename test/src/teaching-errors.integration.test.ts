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
 * The claude.ai-facing hardening pass, driven by live failure data (Jul 8-15
 * audit windows: list failed 18.6%/16.3% on the two boxes, write 8.6%/40.1%):
 *
 *  - Clients with stale cached schemas send `where` as a JSON STRING, and
 *    agents send bare equality maps ({stage:"won"}) instead of the AST. Both
 *    are unambiguous — coerce them instead of failing the call.
 *  - Agents guess type names (meeting, project) — the unknown-type error must
 *    carry the live type list and a did-you-mean, because an error message is
 *    the only schema a stale client is guaranteed to read.
 */
describe("teaching errors + where coercion", () => {
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
    await callTool(deps, ctx, "define_type", {
      name: "opportunity",
      properties: [
        { name: "stage", kind: "text" },
        { name: "pwin", kind: "int" },
      ],
    });
    await callTool(deps, ctx, "write", {
      type: "opportunity",
      title: "won one",
      props: { stage: "won", pwin: 80 },
    });
    await callTool(deps, ctx, "write", {
      type: "opportunity",
      title: "lost one",
      props: { stage: "lost", pwin: 10 },
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  it("where sent as a JSON string (stale-schema client) is parsed, not rejected", async () => {
    const r = (await callTool(deps, ctx, "list", {
      type: "opportunity",
      where: JSON.stringify({ field: "stage", op: "eq", value: "won" }),
    })) as { items: Array<{ title: string }> };
    expect(r.items.map((i) => i.title)).toEqual(["won one"]);
  });

  it("a bare equality map becomes the AST: scalars eq, arrays in, null is_null", async () => {
    const eq = (await callTool(deps, ctx, "list", {
      type: "opportunity",
      where: { stage: "won" },
    })) as { items: Array<{ title: string }> };
    expect(eq.items.map((i) => i.title)).toEqual(["won one"]);

    const inn = (await callTool(deps, ctx, "list", {
      type: "opportunity",
      where: { stage: ["won", "lost"] },
    })) as { items: unknown[] };
    expect(inn.items).toHaveLength(2);

    const isnull = (await callTool(deps, ctx, "list", {
      type: "opportunity",
      where: { stage: null },
    })) as { items: unknown[] };
    expect(isnull.items).toHaveLength(0);
  });

  it("a real AST keeps working exactly as before", async () => {
    const r = (await callTool(deps, ctx, "list", {
      type: "opportunity",
      where: { and: [{ field: "pwin", op: "gte", value: 50 }] },
    })) as { items: Array<{ title: string }> };
    expect(r.items.map((i) => i.title)).toEqual(["won one"]);
  });

  it("an uncoercible where teaches with a corrected example", async () => {
    await expect(
      callTool(deps, ctx, "list", { type: "opportunity", where: "{stage: won" }),
    ).rejects.toThrow(/example|field.*op.*value/i);
  });

  it("unknown type on list carries the live types and a did-you-mean", async () => {
    const err = await callTool(deps, ctx, "list", { type: "oportunity" }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toMatch(/oportunity/);
    expect(err).toMatch(/opportunity/); // did-you-mean hits the close name
    expect(err).toMatch(/types/i); // and the live list is named
  });

  it("unknown type on write teaches the same way", async () => {
    const err = await callTool(deps, ctx, "write", { type: "meeting", title: "x" }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toMatch(/meeting/);
    expect(err).toMatch(/opportunity/); // live type list present
  });

  it("start seeds the standing-context files so they ALWAYS exist and render", async () => {
    const first = (await callTool(deps, ctx, "start", {})) as { text: string };
    expect(first.text).toContain("## Standing context — org-wide");
    // The file was really created — readable through the same store.
    const seeded = await deps.fsStore.read({ actorId: SYSTEM }, "/shared/start.md");
    expect(seeded.bytes.toString("utf8")).toContain("Nothing here yet");
    // Idempotent: a second start reads the same content, no error, section stays.
    const again = (await callTool(deps, ctx, "start", {})) as { text: string };
    expect(again.text).toContain("## Standing context — org-wide");
  });

  it("a read-only caller never seeds — start still works, section absent", async () => {
    await deps.fsStore.rm({ actorId: SYSTEM }, "/shared/start.md");
    const ro: AuthedContext = { ...ctx, scopes: ["read"] };
    const s = (await callTool(deps, ro, "start", {})) as { text: string };
    expect(s.text).not.toContain("## Standing context — org-wide");
    await expect(deps.fsStore.read({ actorId: SYSTEM }, "/shared/start.md")).rejects.toThrow();
    // The next write-scoped start heals it.
    const healed = (await callTool(deps, ctx, "start", {})) as { text: string };
    expect(healed.text).toContain("## Standing context — org-wide");
  });

  it("start doctrine tells the agent to check for a matching skill before process work", async () => {
    const s = (await callTool(deps, ctx, "start", {})) as Record<string, unknown>;
    const text = JSON.stringify(s).toLowerCase();
    expect(text).toContain("skill");
    // The skills-first behavior: match the task to an encoded routine and
    // follow it rather than improvising (wording revised with the start
    // skills index — this pins the teaching, not the exact prose).
    expect(text).toMatch(/skills first/i);
    expect(text).toMatch(/never improvise/i);
  });
});
