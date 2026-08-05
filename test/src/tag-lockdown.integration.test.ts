import { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SECRET = "test-session-secret-lockdown";

/**
 * Wave-2 gate: the sharing LOCKDOWN, end to end over the real /mcp surface.
 *
 *  - a member's write with no visibility is PRIVATE (default-private is the
 *    doctrine's chokepoint: `share` is the only way anything widens)
 *  - visibility:'org' remains an explicit publish
 *  - the edit tool cannot touch visibility at all (schema-level: the argument
 *    no longer exists)
 *  - share: containment (groups you hold), the person carve-out (emails),
 *    and require AND-tags — all through the tool surface
 */
describe("tag governance wave-2 lockdown over /mcp", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let su: Client;
  let app: Hono;
  let owner: { id: string; token: string };
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };

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

  /** Raw wire text + error envelope. get renders as TEXT since the
   *  presentation layer landed; write/edit/share and every error stay JSON. */
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
    const result = json.result as { isError?: boolean; content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    if (result.isError === true)
      return { ok: false, text, err: JSON.parse(text) as Record<string, unknown> };
    return { ok: true, text };
  };

  /** write/edit/share come back as JSON payloads (non-rendered tools). */
  const callJson = async (
    who: { token: string },
    name: string,
    args: unknown,
  ): Promise<Record<string, unknown>> => {
    const r = await call(who, name, args);
    return (r.ok ? JSON.parse(r.text) : r.err) as Record<string, unknown>;
  };

  const canGet = async (who: { token: string }, id: string): Promise<boolean> => {
    const r = await call(who, "get", { id });
    if (!r.ok) {
      expect(r.err?.code).toBe("not_found");
      return false;
    }
    expect(r.text.startsWith(id)).toBe(true); // rendered get leads with the full id
    return true;
  };

  /** Owner-actor governance call on the app pool (fns self-gate on the GUC). */
  const governance = async (sql: string, params: unknown[] = []): Promise<void> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.actor_id', $1, true)", [owner.id]);
      await c.query(sql, params);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    su = await brain.connect("superuser");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false },
    });

    const admin = new Admin(pool);
    owner = await admin.bootstrapOwner({ name: "Olive Owner", email: "owner@test.brain" });
    alice = await admin.createUser(owner.id, {
      name: "Anna Member",
      email: "alice@test.brain",
      permission: "member",
    });
    bob = await admin.createUser(owner.id, {
      name: "Ben Member",
      email: "bob@test.brain",
      permission: "member",
    });
    await governance("SELECT brain_tag_create('c-suite')");
    await governance("SELECT brain_tag_create('pricing')");
    await governance("SELECT brain_tag_grant('c-suite', $1)", [alice.id]);
    await governance("SELECT brain_tag_grant('c-suite', $1)", [bob.id]);
  }, 180_000);

  afterAll(async () => {
    await su?.end();
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("a member's write with no visibility is PRIVATE — creator-only until shared", async () => {
    const out = await callJson(alice, "write", { title: "unshared thought", body: "kiwi draft" });
    const id = out.id as string;
    expect(id).toBeTruthy();
    expect(await canGet(alice, id)).toBe(true);
    expect(await canGet(bob, id)).toBe(false);
    expect(await canGet(owner, id)).toBe(false);
  });

  it("visibility:'org' is still an explicit publish", async () => {
    const out = await callJson(alice, "write", { title: "published memo", visibility: "org" });
    const id = out.id as string;
    for (const who of [owner, bob]) expect(await canGet(who, id)).toBe(true);
  });

  it("the edit tool cannot widen: visibility is not even an argument anymore", async () => {
    const made = await callJson(alice, "write", { title: "locked down" });
    const id = made.id as string;
    const out = await callJson(alice, "edit", { id, visibility: "org" });
    // strict tool schema: unknown argument → teaching error, nothing written
    expect(out.code).toBeTruthy();
    expect(await canGet(bob, id)).toBe(false);
  });

  it("share into a held group over /mcp — holders see it, others still don't", async () => {
    const made = await callJson(alice, "write", { title: "board pack", body: "for c-suite" });
    const id = made.id as string;
    const shared = await callJson(alice, "share", { id, who: ["c-suite"], reason: "board asked" });
    expect(shared.code).toBeUndefined();
    // share is FIRST-CLASS: the result carries the new audience in the same
    // vocabulary `who` accepts (creator row = alice's email, group = slug)
    const audience = shared.audience as string[][];
    expect(Array.isArray(audience)).toBe(true);
    expect(audience.flat()).toContain("c-suite");
    expect(audience.flat()).toContain("alice@test.brain");
    expect(await canGet(bob, id)).toBe(true); // bob holds c-suite
    expect(await canGet(owner, id)).toBe(false); // owner does NOT hold c-suite — role is not tags
    // ...and get renders it on the wire as "who can see:", never raw uuids
    const got = await call(alice, "get", { id });
    expect(got.ok).toBe(true);
    expect(got.text).toContain("who can see:");
    expect(got.text).toContain("c-suite");
    expect(got.text).not.toContain("shared_with:");
  });

  it("share into a group you do not hold is refused — pricing stays sealed", async () => {
    const made = await callJson(alice, "write", { title: "wrap rates" });
    const id = made.id as string;
    const out = await callJson(alice, "share", { id, who: ["pricing"] });
    expect(out.code).toBe("refused");
    expect(String(out.message)).toMatch(/groups you hold/i);
  });

  it("the person carve-out: share to a member email always works", async () => {
    const made = await callJson(alice, "write", { title: "just for ben" });
    const id = made.id as string;
    await callJson(alice, "share", { id, who: ["bob@test.brain"] });
    expect(await canGet(bob, id)).toBe(true);
    expect(await canGet(owner, id)).toBe(false);
  });
});
