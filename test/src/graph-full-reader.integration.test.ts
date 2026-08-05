import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, GRAPH_FULL_MAX, Reader, Writer, type WriteContext } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Reader.graphFull — the whole-visible-brain graph behind the graph view.
 *
 * A graph leaks differently from a table, so the two privacy rules are asserted
 * directly: an edge needs BOTH endpoints visible, and `degree` counts only
 * visible edges (a degree that included a hidden link would tell the viewer a
 * private object exists and point at it). Plus the paging contract: keyset by
 * id, each edge delivered exactly once on the page carrying its higher-id
 * endpoint, and a recorded watermark so an object deleted mid-walk still
 * resolves instead of leaving page 1's edges dangling.
 */
describe("Reader.graphFull", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let reader: Reader;
  let ownerId: string;
  let memberId: string;
  const ids: string[] = [];
  let secretId: string;
  let bridgeId: string;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    reader = new Reader(pool);
    const writer = new Writer(pool);
    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    ownerId = boot.id;
    const member = await admin.createUser(ownerId, {
      name: "Member",
      email: "m@example.com",
      permission: "member",
    });
    memberId = member.id;
    const octx: WriteContext = { actorId: ownerId, scopes: ["read", "write"] };
    const mctx: WriteContext = { actorId: memberId, scopes: ["read", "write"] };
    for (let i = 0; i < 12; i++) {
      const o = await writer.write(octx, { title: `node ${i}`, visibility: "org" });
      ids.push(o.id as string);
    }
    for (let i = 0; i < 11; i++) {
      await writer.link(octx, ids[i]!, "next", ids[i + 1]!);
    }
    // a private object of the MEMBER's, linked to a public one the owner sees
    const secret = await writer.write(mctx, { title: "member secret", visibility: "private" });
    secretId = secret.id as string;
    bridgeId = ids[0]!;
    await writer.link(mctx, secretId, "mentions", bridgeId);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("GRAPH_FULL_MAX is 5000", () => {
    expect(GRAPH_FULL_MAX).toBe(5000);
  });

  it("owner sees every visible node, all edges carry rel, no cursor when it fits", async () => {
    const g = await reader.graphFull({ actorId: ownerId });
    expect(g.nodes.length).toBe(13); // 12 + the owner's bootstrap personal note
    expect(g.edges.length).toBe(11);
    expect(g.edges.every((e) => e.rel === "next")).toBe(true);
    expect(g.nextCursor).toBeNull();
    expect(g.truncated).toBeNull();
    expect(Number.isFinite(Date.parse(g.watermark))).toBe(true);
  });

  it("the private edge is absent for the owner AND does not inflate degree", async () => {
    const g = await reader.graphFull({ actorId: ownerId });
    expect(g.nodes.some((n) => n.id === secretId)).toBe(false);
    expect(g.edges.some((e) => e.from === secretId || e.to === secretId)).toBe(false);
    const bridge = g.nodes.find((n) => n.id === bridgeId)!;
    expect(bridge.degree).toBe(1); // only ids[0] -> ids[1]
  });

  it("the member (the creator) sees their private node and its edge", async () => {
    const g = await reader.graphFull({ actorId: memberId });
    expect(g.nodes.some((n) => n.id === secretId)).toBe(true);
    expect(g.edges.some((e) => e.from === secretId && e.rel === "mentions")).toBe(true);
    const bridge = g.nodes.find((n) => n.id === bridgeId)!;
    expect(bridge.degree).toBe(2);
  });

  it("paging is exactly-once and complete", async () => {
    const seen: string[] = [];
    const edges: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page: Awaited<ReturnType<Reader["graphFull"]>> = await reader.graphFull(
        { actorId: ownerId },
        after === undefined ? { limit: 5 } : { limit: 5, after },
      );
      pages++;
      for (const n of page.nodes) seen.push(n.id);
      for (const e of page.edges) {
        // both endpoints must already be known to the client
        expect(seen).toContain(e.from);
        expect(seen).toContain(e.to);
        edges.push(`${e.from}|${e.rel}|${e.to}`);
      }
      if (!page.nextCursor) break;
      after = page.nextCursor;
      expect(pages).toBeLessThan(10);
    }
    expect(new Set(seen).size).toBe(13);
    expect(new Set(edges).size).toBe(11);
  });

  it("a delete mid-walk does not dangle: the watermark keeps page 2 consistent", async () => {
    const writer = new Writer(pool);
    const p1 = await reader.graphFull({ actorId: ownerId }, { limit: 6 });
    expect(p1.nextCursor).not.toBeNull();
    // delete an object that has NOT been paged yet
    const paged = new Set(p1.nodes.map((n) => n.id));
    const victim = ids.find((i) => !paged.has(i))!;
    await writer.softDelete({ actorId: ownerId, scopes: ["read", "write"] }, victim);
    let after = p1.nextCursor as string;
    const rest: string[] = [];
    for (;;) {
      const p = await reader.graphFull({ actorId: ownerId }, { limit: 6, after });
      for (const n of p.nodes) rest.push(n.id);
      if (!p.nextCursor) break;
      after = p.nextCursor;
    }
    expect(rest).toContain(victim);
    // and a fresh walk (new watermark) no longer sees it
    const fresh = await reader.graphFull({ actorId: ownerId });
    expect(fresh.nodes.some((n) => n.id === victim)).toBe(false);
  });

  it("filters by type name and by since", async () => {
    const none = await reader.graphFull({ actorId: ownerId }, { filters: { types: ["nope"] } });
    expect(none.nodes.length).toBe(0);
    expect(none.edges.length).toBe(0);
    const untyped = await reader.graphFull({ actorId: ownerId }, { filters: { types: [null] } });
    expect(untyped.nodes.length).toBeGreaterThan(0);
    const future = await reader.graphFull(
      { actorId: ownerId },
      { filters: { since: new Date(Date.now() + 60_000).toISOString() } },
    );
    expect(future.nodes.length).toBe(0);
  });

  it("rejects a bad cursor and a bad watermark", async () => {
    await expect(reader.graphFull({ actorId: ownerId }, { after: "nonsense" })).rejects.toThrow();
    await expect(reader.graphFull({ actorId: ownerId }, { watermark: "nope" })).rejects.toThrow();
  });

  it("falls back to the sample past the max", async () => {
    const g0 = await reader.graphFull({ actorId: ownerId }, { limit: 3 });
    expect(g0.nodes.length).toBe(3);
    expect(g0.nextCursor).not.toBeNull();
    const su = await brain.connect("superuser");
    try {
      await su.query("SELECT set_config('app.actor_id', $1, false)", [ownerId]);
      await su.query(
        `INSERT INTO objects (title, created_by, visibility)
         SELECT 'bulk ' || g, $1, 'org' FROM generate_series(1, 6000) g`,
        [ownerId],
      );
    } finally {
      await su.end();
    }
    const g = await reader.graphFull({ actorId: ownerId });
    expect(g.truncated).not.toBeNull();
    expect(g.truncated!.reason).toBe("size");
    expect(g.truncated!.total).toBeGreaterThan(GRAPH_FULL_MAX);
    expect(g.truncated!.shown).toBe(GRAPH_FULL_MAX);
    expect(g.nodes.length).toBe(GRAPH_FULL_MAX);
    expect(g.nextCursor).toBeNull();
    // top-degree first
    expect(g.nodes[0]!.degree).toBeGreaterThanOrEqual(g.nodes[1]!.degree);
    expect(g.edges.every((e) => typeof e.rel === "string")).toBe(true);
  });

  it("sampleOrder 'recency' keeps the freshest nodes a degree sample would drop", async () => {
    // /graph/changed's case: the node of interest is fresh and low-degree —
    // exactly what a top-degree cut discards. A recency cut must keep it.
    // Inserted directly (like the bulk rows above) — the 6000 bulk objects
    // already spent the owner token's daily write budget.
    let freshId: string;
    const su = await brain.connect("superuser");
    try {
      await su.query("SELECT set_config('app.actor_id', $1, false)", [ownerId]);
      const r = await su.query<{ id: string }>(
        `INSERT INTO objects (title, created_by, visibility)
         VALUES ('just changed, no links', $1, 'org') RETURNING id`,
        [ownerId],
      );
      freshId = r.rows[0]!.id;
    } finally {
      await su.end();
    }

    const byDegree = await reader.graphFull({ actorId: ownerId }, { sample: true, limit: 2 });
    expect(byDegree.nodes.some((n) => n.id === freshId)).toBe(false);

    const byRecency = await reader.graphFull(
      { actorId: ownerId },
      { sample: true, limit: 2, sampleOrder: "recency" },
    );
    expect(byRecency.nodes[0]!.id).toBe(freshId);
    // Ordering never changes membership: the member's private object stays
    // invisible to the owner however the sample is ranked.
    expect(byRecency.nodes.some((n) => n.id === secretId)).toBe(false);
  });
});
