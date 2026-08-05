import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Reader, Writer, Admin } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Wave-1 dual-write (plan Task 3): the Writer must stamp `objects.audience` — the
 * DNF the 0057 policy actually reads — alongside the legacy visibility columns,
 * for BOTH create and edit. Without this every post-migration write is invisible
 * (audience defaults to '[]', which brain_can_see rejects). The reader parity
 * checks prove the stamped audience produces the intended visibility.
 */
describe("wave 1 · writer dual-writes audience", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let su: Client;
  let writer: Writer;
  let reader: Reader;
  let a: { id: string; token: string };
  let b: { id: string; token: string };
  let c: { id: string; token: string };

  const asA = () => ({ actorId: a.id, scopes: ["read", "write"] as const });
  const readerCtx = (id: string) => ({ actorId: id, scopes: ["read"] as const });

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    su = await brain.connect("superuser");
    writer = new Writer(pool);
    reader = new Reader(pool);
    const admin = new Admin(pool);
    const owner = await admin.bootstrapOwner({ name: "Owner", email: "owner@test.brain" });
    a = await admin.createUser(owner.id, {
      name: "Ana",
      email: "a@test.brain",
      permission: "member",
    });
    b = await admin.createUser(owner.id, {
      name: "Ben",
      email: "b@test.brain",
      permission: "member",
    });
    c = await admin.createUser(owner.id, {
      name: "Cy",
      email: "c@test.brain",
      permission: "member",
    });
  }, 180_000);

  afterAll(async () => {
    await su?.end();
    await pool?.end();
    await brain?.drop();
  });

  const audienceOf = async (id: string) =>
    (await su.query<{ audience: unknown }>("SELECT audience FROM objects WHERE id = $1", [id]))
      .rows[0]!.audience as string[][];

  it("create: a default write stamps audience = [[creator's personal tag]] (wave-2 default-private)", async () => {
    // wave 2: omitted visibility means PRIVATE for humans — the stamped
    // audience is the creator's personal tag, not the org tag.
    const { id } = await writer.write(asA(), { title: "team memo", body: "x" });
    const aud = await audienceOf(id);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toHaveLength(1);
    const personal = await su.query<{ id: string }>(
      "SELECT id FROM tags WHERE kind = 'personal' AND account_id = $1",
      [a.id],
    );
    expect(aud[0]![0]).toBe(personal.rows[0]!.id);
    // only the creator can read it
    expect(await reader.get(readerCtx(a.id), id)).toMatchObject({ title: "team memo" });
    await expect(reader.get(readerCtx(c.id), id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("create: an explicit org publish stamps audience = [[orgTag]]", async () => {
    const { id } = await writer.write(asA(), {
      title: "published memo",
      body: "x",
      visibility: "org",
    });
    const aud = await audienceOf(id);
    const orgTag = await su.query<{ id: string }>("SELECT id FROM tags WHERE kind = 'org'");
    expect(aud).toEqual([[orgTag.rows[0]!.id]]);
    // everyone can read it
    expect(await reader.get(readerCtx(c.id), id)).toMatchObject({ title: "published memo" });
  });

  it("create: a private+shared note stamps one audience row per person", async () => {
    const { id } = await writer.write(asA(), {
      title: "mine",
      body: "y",
      visibility: "private",
      sharedWith: [b.id],
    });
    const aud = await audienceOf(id);
    expect(aud).toHaveLength(2); // [[creator],[b]]
    // B sees it, C does not — the stamped audience, not the legacy column, decides
    expect(await reader.get(readerCtx(b.id), id)).toMatchObject({ title: "mine" });
    await expect(reader.get(readerCtx(c.id), id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("edit: narrowing org→private rewrites audience to just the creator", async () => {
    // explicit publish — wave-2 default-private would never have let C read it
    const { id, version } = await writer.write(asA(), {
      title: "was public",
      body: "z",
      visibility: "org",
    });
    expect(await audienceOf(id)).toHaveLength(1);
    // C really could read it as org…
    expect(await reader.get(readerCtx(c.id), id)).toMatchObject({ title: "was public" });
    await writer.edit(asA(), id, { version, visibility: "private" });
    const aud = await audienceOf(id);
    expect(aud).toHaveLength(1);
    // …and now cannot
    await expect(reader.get(readerCtx(c.id), id)).rejects.toMatchObject({ code: "not_found" });
    expect(await reader.get(readerCtx(a.id), id)).toMatchObject({ title: "was public" });
  });

  it("edit: adding a share appends that person's audience row", async () => {
    const { id } = await writer.write(asA(), {
      title: "share later",
      body: "q",
      visibility: "private",
    });
    await expect(reader.get(readerCtx(b.id), id)).rejects.toMatchObject({ code: "not_found" });
    // pure sharedWith change — creator only; version-guarded, re-read for it
    const cur = (await reader.get(readerCtx(a.id), id)) as { version: number };
    await writer.edit(asA(), id, { version: cur.version, sharedWith: [b.id] });
    expect(await audienceOf(id)).toHaveLength(2);
    expect(await reader.get(readerCtx(b.id), id)).toMatchObject({ title: "share later" });
  });
});
