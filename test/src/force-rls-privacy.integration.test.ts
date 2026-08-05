import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPrivileges } from "@brain/schema";
import { Admin, Writer, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * FORCE ROW LEVEL SECURITY (migration 0039) — the structural proof of privacy
 * invariant part 3: a private object is readable by NO ONE but its author,
 * including the box owner with the brain_owner table-owner role.
 *
 * These tests exercise the exact bypass 0039 closes: brain_owner previously
 * read every private object by table ownership. Now it is RLS-bound, and the
 * ONLY way to read across actors is `SET ROLE brain_system` (BYPASSRLS), which
 * no request-serving or login path can do. The tests also prove the two
 * legitimate all-rows consumers still work: the embed sweep (must embed private
 * objects) and brain_edge_count (must count edges hidden inside private ones).
 */
describe("FORCE RLS · owner cannot read another actor's private object (0039)", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let alice: string;
  let bob: string;
  let secretId: string; // alice's private note

  const wctx = (id: string): WriteContext => ({ actorId: id, scopes: ["read", "write"] });

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    const admin = new Admin(pool);
    const writer = new Writer(pool);
    alice = (await admin.bootstrapOwner({ name: "alice", email: "alice@example.com" })).id;
    bob = (
      await admin.createUser(alice, { name: "bob", email: "bob@example.com", permission: "member" })
    ).id;
    secretId = (
      await writer.write(wctx(alice), {
        title: "comp thoughts",
        body: "zephyrite salary band notes",
        visibility: "private",
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("brain_owner — the table owner — cannot SELECT another actor's private object", async () => {
    const owner = await brain.connect("owner");
    try {
      // No actor set: brain_owner is RLS-bound under FORCE, sees org rows only.
      const r = await owner.query("SELECT id, title FROM objects WHERE id = $1", [secretId]);
      expect(r.rowCount, "owner must NOT see alice's private object").toBe(0);

      // Even impersonating bob via the actor GUC, the private object stays hidden
      // (bob is neither creator nor in shared_with) — the policy, not ownership.
      await owner.query("SELECT set_config('app.actor_id', $1, false)", [bob]);
      const asBob = await owner.query("SELECT id FROM objects WHERE id = $1", [secretId]);
      expect(asBob.rowCount, "owner-as-bob must not see it either").toBe(0);
    } finally {
      await owner.end();
    }
  });

  it("brain_owner is a member of brain_system but does NOT inherit BYPASSRLS", async () => {
    // This is the crux: membership grants the ability to SET ROLE, but role
    // attributes (BYPASSRLS) are never inherited — so an ordinary brain_owner
    // session stays RLS-bound. If this ever regressed, FORCE would be moot.
    const owner = await brain.connect("owner");
    try {
      const mem = await owner.query<{ v: boolean }>(
        "SELECT pg_has_role('brain_owner','brain_system','MEMBER') AS v",
      );
      expect(mem.rows[0]!.v, "brain_owner must be a member of brain_system").toBe(true);

      // still can't read the private object without explicitly switching role
      const hidden = await owner.query("SELECT id FROM objects WHERE id = $1", [secretId]);
      expect(hidden.rowCount).toBe(0);
    } finally {
      await owner.end();
    }
  });

  it("SET ROLE brain_system is the one path that reads across actors", async () => {
    const owner = await brain.connect("owner");
    try {
      await owner.query("SET ROLE brain_system");
      const r = await owner.query<{ title: string }>("SELECT title FROM objects WHERE id = $1", [
        secretId,
      ]);
      expect(r.rowCount, "brain_system must see every object").toBe(1);
      expect(r.rows[0]!.title).toBe("comp thoughts");

      // and it drops back — RESET ROLE returns to the RLS-bound brain_owner
      await owner.query("RESET ROLE");
      const after = await owner.query("SELECT id FROM objects WHERE id = $1", [secretId]);
      expect(after.rowCount, "back to brain_owner: hidden again").toBe(0);
    } finally {
      await owner.end();
    }
  });

  it("brain_app can never SET ROLE brain_system (not a member)", async () => {
    const app = await brain.connect("app");
    try {
      await expect(app.query("SET ROLE brain_system")).rejects.toMatchObject({
        // 42501 insufficient_privilege — brain_app is not a member
        code: "42501",
      });
    } finally {
      await app.end();
    }
  });

  it("the embed sweep, as brain_system, still sees private objects to embed them", async () => {
    // Replays the sweep's own due-query (embedder.ts) under brain_system: the
    // private object must be in the work set, or its creator could never
    // semantic-search it. The vectors it writes stay RLS-guarded in the table.
    const owner = await brain.connect("owner");
    try {
      await owner.query("SET ROLE brain_system");
      const due = await owner.query<{ id: string }>(
        `SELECT o.id FROM objects o
          WHERE o.deleted_at IS NULL
            AND btrim(coalesce(o.title,'') || coalesce(o.body,'')) <> ''
            AND NOT EXISTS (
              SELECT 1 FROM object_chunks c
               WHERE c.object_id = o.id AND c.source_version = o.version)`,
      );
      const ids = due.rows.map((r) => r.id);
      expect(ids, "sweep (brain_system) must pick up the private object").toContain(secretId);

      // and it can write + read the chunk row (INSERT/SELECT/DELETE granted)
      await owner.query(
        `INSERT INTO object_chunks
           (object_id, chunk_ix, text, embedding, source_version, chunker_version, embedded_at)
         SELECT id, 0, 'zephyrite salary band notes',
                ('[' || repeat('0,', 767) || '1]')::vector, version, 1, now()
           FROM objects WHERE id = $1`,
        [secretId],
      );
      const back = await owner.query("SELECT 1 FROM object_chunks WHERE object_id = $1", [
        secretId,
      ]);
      expect(back.rowCount, "brain_system may write the private object's chunks").toBe(1);
    } finally {
      await owner.end();
    }
  });

  it("but a private object's chunks stay invisible to other members (RLS holds on object_chunks)", async () => {
    // The sweep wrote a chunk for alice's private note above. brain_app acting
    // as bob must not be able to read it — object_chunks is FORCE'd too.
    const app = await brain.connect("app");
    try {
      await app.query("SELECT set_config('app.actor_id', $1, false)", [bob]);
      const r = await app.query("SELECT 1 FROM object_chunks WHERE object_id = $1", [secretId]);
      expect(r.rowCount, "bob must not read alice's private chunk").toBe(0);

      // alice (the creator) can
      await app.query("SELECT set_config('app.actor_id', $1, false)", [alice]);
      const mine = await app.query("SELECT 1 FROM object_chunks WHERE object_id = $1", [secretId]);
      expect(mine.rowCount, "alice reads her own private chunk").toBe(1);
    } finally {
      await app.end();
    }
  });

  it("brain_edge_count still returns the TRUE census, incl. edges hidden in private objects", async () => {
    // Build the real hidden-edge shape: alice's PRIVATE note links to an
    // ORG object O. Bob can see O, but the edge into it is invisible to him
    // (its source is private). brain_edge_count (SECURITY DEFINER, now owned by
    // brain_system) must still count it — that's how referrers() reports
    // "N links hidden from you" and merge refuses to silently drop them.
    const writer = new Writer(pool);
    const orgTarget = (await writer.write(wctx(alice), { title: "shared roadmap", body: "org" }))
      .id;
    await writer.write(wctx(alice), {
      title: "alice private ref",
      body: "my take on the roadmap",
      visibility: "private",
      links: [{ rel: "about", to: orgTarget }],
    });

    const app = await brain.connect("app");
    try {
      // Bob sees O, but not the edge into it (the source note is private) …
      await app.query("SELECT set_config('app.actor_id', $1, false)", [bob]);
      const visible = await app.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM edges WHERE to_id = $1",
        [orgTarget],
      );
      expect(visible.rows[0]!.n, "the inbound edge is RLS-hidden from bob").toBe(0);

      // … but the census function reports the real inbound count (1).
      const census = await app.query<{ n: number }>("SELECT brain_edge_count($1, true) AS n", [
        orgTarget,
      ]);
      expect(census.rows[0]!.n, "census counts the hidden edge").toBe(1);

      // sanity: alice (who owns both endpoints) sees the edge normally
      await app.query("SELECT set_config('app.actor_id', $1, false)", [alice]);
      const aliceSees = await app.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM edges WHERE to_id = $1",
        [orgTarget],
      );
      expect(aliceSees.rows[0]!.n).toBe(1);
    } finally {
      await app.end();
    }
  });

  it("passes the full privilege audit, now asserting FORCE + brain_system", async () => {
    const su = await brain.connect("superuser");
    try {
      const result = await auditPrivileges(su);
      expect(
        result.ok,
        `privilege violations:\n${result.violations.map((v) => ` - ${v.name}: ${v.detail}`).join("\n")}`,
      ).toBe(true);
      // the new checks are present
      const names = new Set(result.checks.map((c) => c.name));
      expect(names.has("brain_owner NOBYPASSRLS")).toBe(true);
      expect(names.has("brain_system BYPASSRLS")).toBe(true);
      expect(names.has("objects has RLS forced")).toBe(true);
    } finally {
      await su.end();
    }
  });
});
