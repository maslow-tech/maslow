import { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SECRET = "test-session-secret-parity";

/**
 * Wave-1 behavior-preservation gate (tag governance): with the 0057 audience
 * model live underneath, the tool surface still speaks org/private/shared_with
 * and every visibility line holds EXACTLY as before — through the real /mcp
 * HTTP surface, for three humans:
 *
 *   - an org note is visible to everyone
 *   - A's private note is invisible to B and the owner
 *   - A's note shared with B is visible to exactly A and B
 *   - search and list ride the same lines (RLS filters them, not the queries)
 */
describe("tag governance wave-1 parity — the org/private surface is behavior-preserved", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let owner: { id: string; token: string };
  let memberA: { id: string; token: string };
  let memberB: { id: string; token: string };

  const mcp = async (
    who: { token: string },
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${who.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /**
   * tools/call → the single text content ON THE WIRE. Since the presentation
   * layer landed, get/search/list render as TEXT; only errors (and the
   * non-rendered tools, e.g. write) still carry a JSON envelope. So the
   * helper hands back the raw text + error flag and lets each assertion speak
   * the wire's own language instead of JSON.parse-ing rendered prose.
   */
  const call = async (
    who: { token: string },
    name: string,
    args: unknown,
  ): Promise<{ ok: boolean; text: string; err?: Record<string, unknown> }> => {
    const { status, json } = await mcp(who, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
    const result = json.result as { isError?: boolean; content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    if (result.isError === true)
      return { ok: false, text, err: JSON.parse(text) as Record<string, unknown> };
    return { ok: true, text };
  };

  const canGet = async (who: { token: string }, id: string): Promise<boolean> => {
    const r = await call(who, "get", { id });
    if (!r.ok) {
      expect(r.err?.code).toBe("not_found");
      return false;
    }
    // Rendered get leads with the fetched object's own FULL id.
    expect(r.text.startsWith(id)).toBe(true);
    return true;
  };

  /** Rendered search text — hit lines quote each title, so containment on
   *  `"Title"` (quotes included) is exact per-hit. */
  const searchText = async (who: { token: string }, query: string): Promise<string> => {
    const r = await call(who, "search", { query });
    expect(r.ok).toBe(true);
    return r.text;
  };

  let orgNote: string;
  let privateNote: string;
  let sharedWithB: string;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false },
    });

    const admin = new Admin(pool);
    owner = await admin.bootstrapOwner({ name: "Olive Owner", email: "owner@test.brain" });
    memberA = await admin.createUser(owner.id, {
      name: "Anna Member",
      email: "a@test.brain",
      permission: "member",
    });
    memberB = await admin.createUser(owner.id, {
      name: "Ben Member",
      email: "b@test.brain",
      permission: "member",
    });
    const w = async (args: Record<string, unknown>): Promise<string> => {
      const r = await call(memberA, "write", args);
      expect(r.ok).toBe(true);
      const out = JSON.parse(r.text) as { id?: string }; // write is non-rendered: still JSON
      expect(out.id).toBeTruthy();
      return out.id as string;
    };
    // Explicit publish — since wave 2 (default-private) an omitted visibility
    // lands creator-only; org-wide is a deliberate act.
    orgNote = await w({
      title: "Quarterly kickoff memo",
      body: "the zebra roadmap for everyone",
      visibility: "org",
    });
    privateNote = await w({
      title: "Anna's scratchpad",
      body: "half-formed zebra thoughts",
      visibility: "private",
    });
    sharedWithB = await w({
      title: "Anna and Ben's draft",
      body: "the zebra draft we are writing together",
      visibility: "private",
      shared_with: [memberB.id],
    });
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("an org note is visible to everyone", async () => {
    for (const who of [owner, memberA, memberB]) {
      expect(await canGet(who, orgNote)).toBe(true);
    }
  });

  it("A's private note is invisible to B and the owner — and a 404, never a 403", async () => {
    expect(await canGet(memberA, privateNote)).toBe(true);
    for (const who of [owner, memberB]) {
      const r = await call(who, "get", { id: privateNote });
      expect(r.ok).toBe(false);
      expect(r.err?.code).toBe("not_found");
    }
  });

  it("A's note shared with B is visible to exactly A and B", async () => {
    expect(await canGet(memberA, sharedWithB)).toBe(true);
    expect(await canGet(memberB, sharedWithB)).toBe(true);
    expect(await canGet(owner, sharedWithB)).toBe(false);
  });

  it("search rides the same lines — every hit list matches that caller's visibility", async () => {
    const a = await searchText(memberA, "zebra");
    expect(a).toContain('"Quarterly kickoff memo"');
    expect(a).toContain(`"Anna's scratchpad"`);
    expect(a).toContain(`"Anna and Ben's draft"`);
    const b = await searchText(memberB, "zebra");
    expect(b).toContain('"Quarterly kickoff memo"');
    expect(b).toContain(`"Anna and Ben's draft"`);
    expect(b).not.toContain(`"Anna's scratchpad"`);
    const o = await searchText(owner, "zebra");
    expect(o).toContain('"Quarterly kickoff memo"');
    expect(o).not.toContain(`"Anna's scratchpad"`);
    expect(o).not.toContain(`"Anna and Ben's draft"`);
  });

  it("list shared_with_me shows B exactly what was shared with them", async () => {
    const r = await call(memberB, "list", { visibility: "shared_with_me" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Anna and Ben's draft");
    expect(r.text).not.toContain("Anna's scratchpad");
  });
});
