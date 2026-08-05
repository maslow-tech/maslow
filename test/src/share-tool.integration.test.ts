import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, Writer, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Wave 2, task 8: `share` — the ONE way an audience widens (decision
 * b38da150 rule 2). The lockdown matrix core:
 *
 *  - the creator shares into a GROUP tag only if they HOLD it (containment,
 *    server-enforced) — person-shares (member emails) are always allowed
 *  - `require` tags compile into every who row (AND semantics: c-suite AND
 *    us-person), while the creator's own row stays bare — the creator can
 *    never lock themselves out
 *  - only the creator may share, same line the legacy visibility rule drew
 *  - a share lands an audit event carrying actor + reason
 */
describe("share tool — the one way an audience widens", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let su: Client;
  let writer: Writer;
  let ownerId: string;
  let alice: { id: string; ctx: WriteContext };
  let bob: { id: string; email: string };

  /** Run an owner-actor governance call on the app pool (fns self-gate). */
  const governance = async (sql: string, params: unknown[] = []): Promise<void> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.actor_id', $1, true)", [ownerId]);
      await c.query(sql, params);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  };

  const tagId = async (slug: string): Promise<string> =>
    (await su.query<{ id: string }>("SELECT id FROM tags WHERE slug = $1", [slug])).rows[0]!.id;

  const personalTag = async (accountId: string): Promise<string> =>
    (
      await su.query<{ id: string }>(
        "SELECT id FROM tags WHERE kind = 'personal' AND account_id = $1",
        [accountId],
      )
    ).rows[0]!.id;

  const audienceOf = async (objectId: string): Promise<string[][]> =>
    (
      await su.query<{ audience: string[][] }>("SELECT audience FROM objects WHERE id = $1", [
        objectId,
      ])
    ).rows[0]!.audience;

  const legacyOf = async (objectId: string): Promise<{ visibility: string; shared: string[] }> => {
    const r = await su.query<{ visibility: string; shared_with: string[] }>(
      "SELECT visibility, shared_with FROM objects WHERE id = $1",
      [objectId],
    );
    return { visibility: r.rows[0]!.visibility, shared: r.rows[0]!.shared_with };
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    su = await brain.connect("superuser");
    writer = new Writer(pool);

    const admin = new Admin(pool);
    ownerId = (await admin.bootstrapOwner({ name: "olive", email: "owner@test.brain" })).id;
    const a = await admin.createUser(ownerId, {
      name: "alice",
      email: "alice@test.brain",
      permission: "member",
    });
    alice = { id: a.id, ctx: { actorId: a.id, scopes: ["read", "write"] } };
    const b = await admin.createUser(ownerId, {
      name: "bob",
      email: "bob@test.brain",
      permission: "member",
    });
    bob = { id: b.id, email: "bob@test.brain" };

    // governance: three custom tags; alice holds c-suite (and us-person via a
    // later grant in the require test), NOT pricing.
    await governance("SELECT brain_tag_create('c-suite')");
    await governance("SELECT brain_tag_create('pricing')");
    await governance("SELECT brain_tag_create('us-person')");
    await governance("SELECT brain_tag_grant('c-suite', $1)", [alice.id]);
  }, 120_000);

  afterAll(async () => {
    await su?.end();
    await pool?.end();
    await brain?.drop();
  });

  const privateNote = async (title: string): Promise<string> =>
    (await writer.write(alice.ctx, { title, visibility: "private" })).id;

  it("creator shares into a group tag they hold — audience [[creator],[c-suite]]", async () => {
    const id = await privateNote("board memo");
    await writer.share(alice.ctx, id, { who: ["c-suite"] });
    const aud = await audienceOf(id);
    expect(aud).toHaveLength(2);
    expect(aud).toEqual(
      expect.arrayContaining([[await personalTag(alice.id)], [await tagId("c-suite")]]),
    );
  });

  it("a group tag the caller does NOT hold is refused (containment)", async () => {
    const id = await privateNote("wrap rates");
    await expect(writer.share(alice.ctx, id, { who: ["pricing"] })).rejects.toThrow(
      /groups you hold/i,
    );
    // audience untouched — still creator-only
    expect(await audienceOf(id)).toEqual([[await personalTag(alice.id)]]);
  });

  it("a person-share to a member email is always allowed", async () => {
    const id = await privateNote("draft for bob");
    await writer.share(alice.ctx, id, { who: [bob.email] });
    const aud = await audienceOf(id);
    expect(aud).toEqual(
      expect.arrayContaining([[await personalTag(alice.id)], [await personalTag(bob.id)]]),
    );
    // legacy compat mapping: still column-driven paths see private+shared_with
    const legacy = await legacyOf(id);
    expect(legacy.visibility).toBe("private");
    expect(legacy.shared).toEqual([bob.id]);
  });

  it("require compiles into every who row — the creator row stays bare", async () => {
    await governance("SELECT brain_tag_grant('us-person', $1)", [alice.id]);
    const id = await privateNote("ITAR capture notes");
    await writer.share(alice.ctx, id, { who: ["c-suite"], require: ["us-person"] });
    const aud = await audienceOf(id);
    const cSuite = await tagId("c-suite");
    const usPerson = await tagId("us-person");
    const creator = await personalTag(alice.id);
    expect(aud).toHaveLength(2);
    // who row carries BOTH tags (AND); creator row carries neither
    const whoRow = aud.find((r) => r.includes(cSuite))!;
    expect([...whoRow].sort()).toEqual([cSuite, usPerson].sort());
    expect(aud).toEqual(expect.arrayContaining([[creator]]));
  });

  it("sharing into the org tag is an explicit publish — legacy maps back to org", async () => {
    const id = await privateNote("company update");
    await writer.share(alice.ctx, id, { who: ["maslow-org"] });
    const org = await su.query<{ id: string }>("SELECT id FROM tags WHERE kind = 'org'");
    expect(await audienceOf(id)).toEqual(
      expect.arrayContaining([[await personalTag(alice.id)], [org.rows[0]!.id]]),
    );
    expect((await legacyOf(id)).visibility).toBe("org");
  });

  it("a non-creator cannot share — visible objects refuse, invisible ones are a 404", async () => {
    const bobCtx: WriteContext = { actorId: bob.id, scopes: ["read", "write"] };
    // bob can SEE this one (shared with him) — the creator-only rule refuses
    const visible = await privateNote("shared but not his");
    await writer.share(alice.ctx, visible, { who: [bob.email] });
    await expect(writer.share(bobCtx, visible, { who: ["c-suite"] })).rejects.toThrow(/creator/i);
    // bob cannot see this one at all — not_found, never a 403 (a refusal
    // would confirm the object exists)
    const hidden = await privateNote("alice's alone");
    await expect(writer.share(bobCtx, hidden, { who: [bob.email] })).rejects.toThrow(
      /no live object/i,
    );
  });

  it("an unknown slug or email teaches instead of guessing", async () => {
    const id = await privateNote("typo target");
    await expect(writer.share(alice.ctx, id, { who: ["no-such-group"] })).rejects.toThrow(
      /no tag or member/i,
    );
  });

  it("the creator row survives every share — re-sharing never locks the creator out", async () => {
    const id = await privateNote("resilience check");
    const creator = await personalTag(alice.id);
    await writer.share(alice.ctx, id, { who: ["c-suite"] });
    await writer.share(alice.ctx, id, { who: [bob.email], require: ["us-person"] });
    const aud = await audienceOf(id);
    expect(aud).toEqual(expect.arrayContaining([[creator]]));
  });

  it("writes default PRIVATE for humans — audience [[creator]], legacy private", async () => {
    const id = (await writer.write(alice.ctx, { title: "no visibility given" })).id;
    expect(await audienceOf(id)).toEqual([[await personalTag(alice.id)]]);
    expect((await legacyOf(id)).visibility).toBe("private");
  });

  it("write(visibility:'org') is still an explicit publish", async () => {
    const id = (await writer.write(alice.ctx, { title: "meeting record", visibility: "org" })).id;
    expect((await legacyOf(id)).visibility).toBe("org");
  });

  it("the edit tool no longer exposes visibility/shared_with — share is the only widening path", async () => {
    const { TOOLS } = await import("@brain/mcp-tools");
    const shape = (TOOLS.edit!.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).not.toContain("visibility");
    expect(Object.keys(shape)).not.toContain("shared_with");
    expect(Object.keys((TOOLS.share!.inputSchema as unknown as { shape: object }).shape)).toEqual(
      expect.arrayContaining(["who", "require"]),
    );
  });

  it("share lands an audit event with actor + reason", async () => {
    const id = await privateNote("audited share");
    await writer.share(alice.ctx, id, { who: ["c-suite"], reason: "board asked for it" });
    const ev = await su.query<{ actor: string; payload: { reason?: string } }>(
      `SELECT actor, payload FROM events
        WHERE target = $1 AND kind = 'update' ORDER BY seq DESC LIMIT 1`,
      [id],
    );
    expect(ev.rows[0]!.actor).toBe(alice.id);
    expect(ev.rows[0]!.payload.reason).toBe("board asked for it");
  });
});
