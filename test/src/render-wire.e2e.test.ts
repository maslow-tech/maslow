import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Admin,
  FsStore,
  Reader,
  Writer,
  callTool,
  type AuthedContext,
  type ToolDeps,
} from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";
import { McpClient, type McpToolError } from "./support/mcp-client.js";

/**
 * The MCP presentation layer, proven on the WIRE (not on renderToolResult in
 * isolation): a real box app + the scripted MCP client, asserting the exact
 * text that get/search/recent/list put on the wire — short ids, collapsed
 * autosave runs, omitted noise fields — while every non-rendered tool and
 * every error keeps its JSON envelope. Also measures rendered-vs-JSON bytes
 * (the reason the layer exists) with a sanity floor: rendered <= JSON.
 */

const FULL_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const short = (id: string): string => id.slice(0, 13); // 8-4 short-id prefix

const FAR_BODY = [
  "Appendix — atlas sequencing detail.",
  "",
  "Line two survives verbatim on the wire,",
  "and so does this third line with trailing punctuation!",
].join("\n");

describe("e2e · MCP presentation layer on the wire", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let owner: McpClient;
  let member: McpClient;
  let deps: ToolDeps;
  let ownerCtx: AuthedContext;

  let headId: string; // "Atlas roadmap" — head of the 2-hop chain
  let midId: string; // links to head
  let farId: string; // links to mid → hop-2 from head
  let memberPrivateId: string; // member's PRIVATE object linking to mid (hop-2)
  let draftId: string; // edited 7× in a row (autosave churn)
  let projectIds: string[];

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({ pool, ownerClient });

    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    const req = (path: string, init: RequestInit) => Promise.resolve(app.request(path, init));
    owner = new McpClient(req, boot.token);

    const m = await admin.createUser(boot.id, {
      name: "Mira Chen",
      email: "mira@example.com",
      permission: "member",
    });
    member = new McpClient(req, m.token);

    // In-process deps for the JSON baseline (same actor as the wire calls, so
    // the payloads being compared are byte-for-byte the same data).
    deps = {
      reader: new Reader(pool),
      writer: new Writer(pool),
      admin,
      executor: new SchemaExecutor(ownerClient),
      fsStore: new FsStore(pool),
    };
    ownerCtx = { actorId: boot.id, scopes: ["read", "write", "schema-admin"], role: "owner" };

    // ---- seed: a schema, ~15 linked objects, private hop-2, autosave churn --
    const t = await owner.call<{ type_id: number }>("define_type", {
      name: "project",
      properties: [{ name: "lead", kind: "text" }],
    });
    await owner.call("add_property", {
      type_id: t.type_id,
      name: "status",
      kind: "enum",
      enum_values: ["active", "done"],
    });

    projectIds = [];
    for (let i = 1; i <= 11; i++) {
      const w = await owner.call<{ id: string }>("write", {
        type: "project",
        title: `Atlas workstream ${i}`,
        body: `Workstream ${i} of the atlas program.`,
        props: { lead: "Mira Chen", status: "active" },
      });
      projectIds.push(w.id);
    }
    // The chain is a MULTI-ACTOR fixture (Mira links to mid and traverses to
    // far), so under tag governance's default-private writes it must publish
    // explicitly — org visibility is no longer the write default.
    headId = (
      await owner.call<{ id: string }>("write", {
        type: "project",
        title: "Atlas roadmap",
        body: "The atlas master roadmap: sequencing for every workstream.",
        props: { lead: "Owner", status: "active" },
        visibility: "org",
      })
    ).id;
    projectIds.push(headId);

    midId = (
      await owner.call<{ id: string }>("write", {
        title: "Atlas mid analysis",
        body: "Connects the roadmap to the appendix.",
        visibility: "org",
        links: [{ rel: "about", to: headId }],
      })
    ).id;
    farId = (
      await owner.call<{ id: string }>("write", {
        title: "Atlas far appendix",
        body: FAR_BODY,
        visibility: "org",
        links: [{ rel: "refines", to: midId }],
      })
    ).id;

    // The second user's PRIVATE object, linking to mid — a hop-2 neighbor of
    // head that must be visible to its creator only.
    memberPrivateId = (
      await member.call<{ id: string }>("write", {
        title: "Mira private scratchpad",
        body: "not for anyone else",
        visibility: "private",
        links: [{ rel: "about", to: midId }],
      })
    ).id;

    // Autosave churn: 7 consecutive appends by one actor on one object.
    draftId = (await owner.call<{ id: string }>("write", { title: "Draft doc", body: "v0" })).id;
    for (let i = 1; i <= 7; i++) {
      await owner.call("edit", {
        id: draftId,
        body_ops: [{ op: "append", text: ` +${i}` }],
      });
    }
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  // ---- recent --------------------------------------------------------------

  it("recent: header carries max_seq, autosave runs collapse, actors are names not uuids", async () => {
    const text = await owner.call<string>("recent", { limit: 200 });
    expect(typeof text).toBe("string");
    expect(text).toMatch(/^\d+ events · max_seq \d+/);
    // 7 consecutive edits by one actor on one object → ONE ×7 line.
    expect(text).toContain("×7");
    expect(text).toContain(`"Draft doc"`);
    // Actor renders as the name; no full uuid anywhere on the recent wire.
    expect(text).toContain("Owner");
    expect(text).not.toMatch(FULL_UUID);
    // Targets are short ids.
    expect(text).toContain(short(draftId));
  });

  // ---- search --------------------------------------------------------------

  it("search: short ids only, no float rank, no <b> markup", async () => {
    const text = await owner.call<string>("search", { query: "atlas roadmap" });
    expect(typeof text).toBe("string");
    expect(text).toMatch(/^\d+ hits for "atlas roadmap"/);
    expect(text).toContain(short(headId));
    expect(text).not.toMatch(FULL_UUID); // hit ids are 12-hex short, never full
    expect(text).not.toContain("<b>");
    expect(text).not.toContain("rank");
  });

  // ---- get -----------------------------------------------------------------

  it("get: full own id, short link ids, noise fields omitted, body verbatim", async () => {
    const text = await owner.call<string>("get", { id: farId });
    expect(text.startsWith(farId)).toBe(true); // the fetched object's own id, FULL
    expect(text).toContain(`refines → "Atlas mid analysis" (note ${short(midId)})`);
    expect(text).not.toContain(midId); // link targets are short ids
    // Omission is meaning: none of the spelled-out negatives reach the wire.
    expect(text).not.toContain("deleted_at");
    expect(text).not.toContain("shared_with");
    expect(text).not.toContain("hidden_from_you");
    expect(text).not.toContain("links_truncated");
    // The body arrives with every line intact, indented two spaces — the
    // indentation keeps column 0 renderer-owned so content can't forge
    // protocol lines (DELETED markers, batch separators, fake rows).
    const indented = FAR_BODY.split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    expect(text).toContain(`body:\n${indented}`);
  });

  it("get neighbors:true: hop2 present; the private hop-2 object only for its creator", async () => {
    const mine = await owner.call<string>("get", { id: headId, neighbors: true });
    expect(mine).toContain("hop2 — what the linked objects link to");
    expect(mine).toContain(short(farId));
    expect(mine).toContain(`via ${short(midId)}`);
    // Mira's private scratchpad links to mid too — invisible to the owner.
    expect(mine).not.toContain(short(memberPrivateId));

    const theirs = await member.call<string>("get", { id: headId, neighbors: true });
    expect(theirs).toContain("hop2 — what the linked objects link to");
    expect(theirs).toContain(short(memberPrivateId)); // creator sees their own
    expect(theirs).toContain(short(farId));
  });

  // ---- list ----------------------------------------------------------------

  it("list: rows render short, nextCursor survives verbatim and pages", async () => {
    const args = { type: "project", limit: 6 };
    const text = await owner.call<string>("list", args);
    expect(text).toMatch(/^project: 6 rows/);
    expect(text).not.toMatch(FULL_UUID);

    const cursorLine = text.match(/^nextCursor: (.+)$/m);
    expect(cursorLine).not.toBeNull();
    const cursor = cursorLine![1]!;

    // Verbatim: the rendered cursor is exactly the JSON payload's nextCursor.
    const json = (await callTool(deps, ownerCtx, "list", args)) as { nextCursor: string | null };
    expect(cursor).toBe(json.nextCursor);

    // And it round-trips: page 2 exists and repeats no page-1 row.
    const page2 = await owner.call<string>("list", { ...args, cursor });
    expect(page2).toMatch(/^project: 6 rows/);
    const page1Ids = [...text.matchAll(/^([0-9a-f]{8}-[0-9a-f]{4})/gm)].map((m) => m[1]!);
    expect(page1Ids).toHaveLength(6);
    for (const id of page1Ids) expect(page2).not.toContain(id);
  });

  // ---- short-id round trip -------------------------------------------------

  it("a short id printed by search resolves over the wire via get", async () => {
    const found = await owner.call<string>("search", { query: "atlas appendix" });
    const hit = found.match(/^([0-9a-f]{8}-[0-9a-f]{4}) · /m);
    expect(hit).not.toBeNull();
    const shortIdFromWire = hit![1]!;

    const got = await owner.call<string>("get", { id: shortIdFromWire });
    const ownId = got.match(FULL_UUID)?.[0];
    expect(ownId).toBeDefined();
    expect(ownId!.startsWith(shortIdFromWire)).toBe(true);
    expect(got.startsWith(ownId!)).toBe(true); // resolved to the full object
  });

  // ---- non-rendered tools + errors stay JSON -------------------------------

  it("non-rendered tools still return parseable JSON on the wire", async () => {
    // write already proved it during seeding; start is the read-side check
    // (catalog and history render as text now).
    const s = await owner.call<{ text: string }>("start");
    expect(typeof s).toBe("object");
    expect(typeof s.text).toBe("string");

    const w = await owner.call<{ id: string }>("write", { title: "json check" });
    expect(w.id).toMatch(FULL_UUID);
  });

  it("catalog and history render as text, short ids accepted by history", async () => {
    const cat = await owner.call<string>("catalog");
    expect(typeof cat).toBe("string");
    expect(cat).toContain("## Types in this brain");
    expect(cat).toContain("- project — ");

    const hist = await owner.call<string>("history", { id: short(draftId) });
    expect(typeof hist).toBe("string");
    expect(hist.startsWith(`history of ${draftId}`)).toBe(true); // short id resolved
    expect(hist).toContain("events (");
  });

  it("errors keep the JSON BrainError envelope", async () => {
    let err: McpToolError | undefined;
    try {
      await owner.call("get", { id: "00000000-0000-0000-0000-000000000009" });
    } catch (e) {
      err = e as McpToolError;
    }
    // err.brain is only populated when the wire text parsed as JSON — this IS
    // the proof the envelope survived the presentation layer.
    expect(err?.brain?.code).toBe("not_found");
    expect(typeof err?.brain?.message).toBe("string");
  });

  // ---- efficiency ----------------------------------------------------------

  it("rendered wire text is never larger than the JSON it replaces", async () => {
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: "recent", args: { limit: 200 } },
      { tool: "search", args: { query: "atlas roadmap" } },
      { tool: "get", args: { id: headId, neighbors: true } },
      { tool: "list", args: { type: "project", limit: 6 } },
    ];
    const rows: string[] = ["tool   | json bytes | text bytes | saving %"];
    for (const { tool, args } of cases) {
      const text = await owner.call<string>(tool, args);
      expect(typeof text).toBe("string");
      const json = JSON.stringify(await callTool(deps, ownerCtx, tool, args));
      const textBytes = Buffer.byteLength(text, "utf8");
      const jsonBytes = Buffer.byteLength(json, "utf8");
      expect(textBytes).toBeLessThanOrEqual(jsonBytes);
      const saving = ((1 - textBytes / jsonBytes) * 100).toFixed(1);
      rows.push(
        `${tool.padEnd(6)} | ${String(jsonBytes).padStart(10)} | ${String(textBytes).padStart(10)} | ${saving.padStart(7)}%`,
      );
    }
    console.log(`\n${rows.join("\n")}\n`);
  });
});
