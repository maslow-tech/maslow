import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, Writer, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Wave 5, task 18: object governance. The GOVERNOR — the creator, unless
 * transferred — is who share checks; `transfer_to` hands that role on; orphan
 * stewardship lets a live OWNER govern a revoked member's VISIBLE objects,
 * while their private-only rows stay dead (the privacy promise working).
 */
describe("object governance — governed_by, transfer, orphan stewardship", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let su: Client;
  let writer: Writer;
  let admin: Admin;
  let ownerId: string;
  let alice: { id: string; email: string; ctx: WriteContext };
  let bob: { id: string; email: string; ctx: WriteContext };
  const octx = (): WriteContext => ({ actorId: ownerId, scopes: ["read", "write"] });

  const governedBy = async (id: string): Promise<string | null> =>
    (
      await su.query<{ governed_by: string | null }>(
        "SELECT governed_by FROM objects WHERE id = $1",
        [id],
      )
    ).rows[0]!.governed_by;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    su = await brain.connect("superuser");
    writer = new Writer(pool);
    admin = new Admin(pool);
    ownerId = (await admin.bootstrapOwner({ name: "olive", email: "owner@test.brain" })).id;
    const a = await admin.createUser(ownerId, {
      name: "alice",
      email: "alice@test.brain",
      permission: "member",
    });
    alice = {
      id: a.id,
      email: "alice@test.brain",
      ctx: { actorId: a.id, scopes: ["read", "write"] },
    };
    const b = await admin.createUser(ownerId, {
      name: "bob",
      email: "bob@test.brain",
      permission: "member",
    });
    bob = { id: b.id, email: "bob@test.brain", ctx: { actorId: b.id, scopes: ["read", "write"] } };
  }, 120_000);

  afterAll(async () => {
    await su?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("a write stamps governed_by = creator; the seeded backfill did the same for old rows", async () => {
    const id = (await writer.write(alice.ctx, { title: "mine" })).id;
    expect(await governedBy(id)).toBe(alice.id);
  });

  it("transfer_to hands governance: the old governor keeps visibility, loses share rights", async () => {
    const id = (await writer.write(alice.ctx, { title: "handover" })).id;
    // transfer to bob, keeping alice visible (her creator row) and letting bob see it
    await writer.share(alice.ctx, id, { who: [bob.email], transferTo: bob.email });
    expect(await governedBy(id)).toBe(bob.id);
    // alice still SEES it (her row survived) but may no longer share it
    await expect(writer.share(alice.ctx, id, { who: [alice.email] })).rejects.toThrow(/governor/i);
    // bob, the new governor, may
    await expect(
      writer.share(bob.ctx, id, { who: [alice.email, bob.email] }),
    ).resolves.toBeDefined();
  });

  it("a non-governor cannot transfer what they can merely see", async () => {
    const id = (await writer.write(alice.ctx, { title: "not bob's to give" })).id;
    await writer.share(alice.ctx, id, { who: [bob.email] });
    await expect(
      writer.share(bob.ctx, id, { who: [bob.email], transferTo: bob.email }),
    ).rejects.toThrow(/governor/i);
  });

  it("transfer_to refuses an unknown email, and a REVOKED member", async () => {
    const id = (await writer.write(alice.ctx, { title: "no ghosts" })).id;
    await expect(writer.share(alice.ctx, id, { transferTo: "nobody@test.brain" })).rejects.toThrow(
      /no active member/i,
    );
    // Revoked is the only class of account the resolver still refuses. It used
    // to refuse service accounts too; 0059 retired the last of them, so there
    // is no longer such a class — but "active" must keep meaning active.
    const gone = await admin.createUser(ownerId, {
      name: "Departed",
      email: "departed@test.brain",
      permission: "member",
    });
    await admin.revokeAccount(ownerId, gone.id);
    await expect(
      writer.share(alice.ctx, id, { transferTo: "departed@test.brain" }),
    ).rejects.toThrow(/no active member/i);
  });

  it("orphan stewardship: an OWNER governs a revoked member's VISIBLE object; a member cannot; private orphans stay dead", async () => {
    const doomed = await admin.createUser(ownerId, {
      name: "doomed",
      email: "doomed@test.brain",
      permission: "member",
    });
    const dctx: WriteContext = { actorId: doomed.id, scopes: ["read", "write"] };
    const orgNote = (await writer.write(dctx, { title: "team runbook", visibility: "org" })).id;
    const privateNote = (await writer.write(dctx, { title: "doomed's diary" })).id;

    await admin.revokeAccount(ownerId, doomed.id);

    // a plain member cannot steward (checked FIRST — the owner's narrowing
    // below rightly hides the row from bob afterwards)
    await expect(writer.share(bob.ctx, orgNote, { who: [bob.email] })).rejects.toThrow(/governor/i);
    // a live owner stewards the visible orphan (e.g. narrows it to themselves)
    await expect(writer.share(octx(), orgNote, { who: [] })).resolves.toBeDefined();
    // the private orphan never even resolves — a 404, not a stewardship grant
    await expect(writer.share(octx(), privateNote, { who: [] })).rejects.toThrow(/no live object/i);
  });

  it("stewardship does not open LIVE members' objects to owners", async () => {
    const id = (await writer.write(alice.ctx, { title: "alive and mine", visibility: "org" })).id;
    await expect(writer.share(octx(), id, { who: [] })).rejects.toThrow(/governor/i);
  });
});
