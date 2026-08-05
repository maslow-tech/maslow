import type { Hono } from "hono";
import { Pool, type Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, GRAPH_FULL_MAX, Writer, type WriteContext } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The graph view against a brain BIG ENOUGH for the old behaviour to be visible,
 * read by all three tiers at once.
 *
 * `graph-sample` pins the old top-degree sample (cap 320); `graph-full-reader`
 * and `graph-route` pin the reader's rules and the route's filter language on a
 * dozen nodes. None of them can catch the two things that only appear at size,
 * which is what this file exists for:
 *
 *  1. **Completeness.** With >320 objects the sample cap would be plainly
 *     visible in the payload. The whole-graph path must return the FULL visible
 *     set — and "full" is checked against an independent RLS oracle (a plain
 *     `count(*)` run as that actor on its own connection), not against a number
 *     this file computed from the same query under test. Run as owner, member A
 *     (the creator of the private objects), member B (shared with) and viewer,
 *     because each of the four sees a different brain.
 *
 *  2. **Paging under churn.** One walk, many transactions: while it is in
 *     flight a SECOND connection creates objects and soft-deletes objects that
 *     have not been paged yet. The walk must deliver exactly the watermark
 *     snapshot — every id in it once, the post-watermark creations never, and
 *     the mid-walk deletions still delivered (a dropped node would leave the
 *     already-delivered edges pointing at nothing).
 *
 * And THE LEAK TEST, at every tier: an edge whose other endpoint is private to
 * another member must be absent AND must not appear in the visible endpoint's
 * `degree` — a degree of 2 beside one drawn edge is a working oracle for "a
 * private object exists and it points here". It is asserted on the full path
 * AND on the >GRAPH_FULL_MAX sample fallback, which is a second, separate query.
 *
 * Nothing here reads a real box; the brain is created fresh and dropped.
 */

const SECRET = "test-session-secret-please-change";

/** Enough plain objects that the old 320-node sample cap would show. */
const FILLER = 340;
/** chain (FILLER-1) + the hub's own org edge. */
const ORG_EDGES = FILLER;

/**
 * Give the planner statistics for the rows we just bulk-inserted.
 *
 * A brain this size has them (autovacuum analyses it long before it reaches
 * 5,000 objects); a table seeded milliseconds ago does not, and the difference
 * is not cosmetic. With default stats the planner estimates the `vis` CTE at
 * TWO rows, so it builds `ve` as a nested loop over vis × vis — 25 MILLION
 * index probes, ~6s, past the reader's 5s statement timeout — and the sample
 * path 500s. With stats it hash-joins: 13ms. Analysing here keeps the test
 * measuring the query the box actually runs instead of a cold-statistics
 * artifact. (It is also a real, if narrow, operational cliff: a brain that
 * bulk-imports its way past GRAPH_FULL_MAX serves a 500 from the graph until
 * autovacuum catches up.)
 */
async function analyze(su: Client): Promise<void> {
  await su.query("ANALYZE objects, edges");
}

function cookieValue(res: Response, name: string): string | undefined {
  const all =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const line of all) {
    const m = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(line);
    if (m) return decodeURIComponent(m[1] as string);
  }
  return undefined;
}

interface GraphNode {
  id: string;
  title: string | null;
  type: string | null;
  degree: number;
}
interface GraphEdge {
  from: string;
  to: string;
  rel: string;
}
interface GraphPage {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nextCursor: string | null;
  watermark: string;
  truncated: { shown: number; total: number; reason: string } | null;
}
interface ChangedPayload {
  since: string;
  watermark: string;
  ids: string[];
  count: number;
  byKind: Record<string, number>;
  truncated: unknown;
  feedTruncated: boolean;
}

describe("the whole-brain graph at scale", () => {
  let brain: FreshBrain;
  let pool: Pool;
  /** A SECOND pool, so the churn in the paging test is genuinely another
   *  connection racing the walk rather than the walk's own client. */
  let churnPool: Pool;
  let ownerClient: Client;
  let app: Hono;

  let ownerId: string;
  let aliceId: string;
  let bobId: string;
  let viewerId: string;
  const cookies: Record<string, string> = {};

  const fillerIds: string[] = [];
  let hubId: string;
  let alicePrivateId: string;
  let aliceSharedId: string;
  let recentOrgId: string;
  let changedSince: string;

  const get = (path: string, cookie: string): Promise<Response> =>
    Promise.resolve(app.request(path, { headers: { cookie } }));

  const login = async (token: string): Promise<string> => {
    const res = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const session = cookieValue(res, "brain_session");
    const csrf = cookieValue(res, "brain_csrf");
    if (!session || !csrf) throw new Error("login did not set both cookies");
    return `brain_session=${session}; brain_csrf=${csrf}`;
  };

  const graph = async (query: string, who: string): Promise<GraphPage> => {
    const res = await get(`/api/v1/graph${query}`, cookies[who] as string);
    const body = (await res.json()) as GraphPage & { error?: string };
    expect(res.status, `graph${query} as ${who} refused: ${body.error}`).toBe(200);
    return body;
  };

  const changed = async (query: string, who: string): Promise<ChangedPayload> => {
    const res = await get(`/api/v1/graph/changed${query}`, cookies[who] as string);
    const body = (await res.json()) as ChangedPayload & { error?: string };
    expect(res.status, `changed${query} as ${who} refused: ${body.error}`).toBe(200);
    return body;
  };

  /**
   * The oracle: what RLS says this actor can see, asked directly, on its own
   * connection, with a query the graph does not share. If the graph agrees with
   * this it is complete; if it agrees with itself that proves nothing.
   */
  const asActor = async <T>(actorId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      await c.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } finally {
      c.release();
    }
  };

  const visibleCount = (actorId: string): Promise<number> =>
    asActor(actorId, async (c) => {
      const r = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM objects WHERE deleted_at IS NULL",
      );
      return Number(r.rows[0]!.n);
    });

  /** The watermark snapshot, by its definition: alive AS OF `wm`. */
  const snapshotIds = (actorId: string, wm: string): Promise<Set<string>> =>
    asActor(actorId, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM objects
         WHERE created_at <= $1::timestamptz
           AND (deleted_at IS NULL OR deleted_at > $1::timestamptz)`,
        [wm],
      );
      return new Set(r.rows.map((x) => x.id));
    });

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    churnPool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false },
    });

    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    ownerId = boot.id;
    const alice = await admin.createUser(ownerId, {
      name: "Alice",
      email: "alice@example.com",
      permission: "member",
    });
    aliceId = alice.id;
    const bob = await admin.createUser(ownerId, {
      name: "Bob",
      email: "bob@example.com",
      permission: "member",
    });
    bobId = bob.id;
    const viewer = await admin.createUser(ownerId, {
      name: "Vic",
      email: "vic@example.com",
      permission: "viewer",
    });
    viewerId = viewer.id;
    cookies["owner"] = await login(boot.token);
    cookies["alice"] = await login(alice.token);
    cookies["bob"] = await login(bob.token);
    cookies["viewer"] = await login(viewer.token);

    // The bulk of the brain, inserted directly: 340 org objects in a chain.
    // Row-by-row writes would spend the whole beforeAll budget on a fact the
    // write path already proves elsewhere; what matters here is the SIZE.
    const su = await brain.connect("superuser");
    try {
      await su.query("SELECT set_config('app.actor_id', $1, false)", [ownerId]);
      // Since 0057 the policy reads `audience`, not `visibility` — stamp the
      // org tag exactly as the Writer would, or these rows are creator-only.
      const r = await su.query<{ id: string }>(
        `INSERT INTO objects (title, created_by, visibility, audience)
         SELECT 'filler ' || g, $1, 'org',
                (SELECT jsonb_build_array(jsonb_build_array(id::text))
                 FROM tags WHERE kind = 'org')
         FROM generate_series(1, $2::int) g
         RETURNING id`,
        [ownerId, FILLER],
      );
      for (const row of r.rows) fillerIds.push(row.id);
      await su.query(
        `INSERT INTO edges (from_id, rel, to_id, provenance)
         SELECT a.id, 'next', b.id, 'manual'
         FROM unnest($1::uuid[]) WITH ORDINALITY AS a(id, n)
         JOIN unnest($1::uuid[]) WITH ORDINALITY AS b(id, n) ON b.n = a.n + 1`,
        [fillerIds],
      );
      await analyze(su);
    } finally {
      await su.end();
    }
    expect(fillerIds.length).toBe(FILLER);

    const writer = new Writer(pool);
    const octx: WriteContext = { actorId: ownerId, scopes: ["read", "write"] };
    const actx: WriteContext = { actorId: aliceId, scopes: ["read", "write"] };

    // The one node every privacy assertion hangs off: org-visible, so all four
    // tiers get it, and an endpoint of edges only some of them may see.
    hubId = (await writer.write(octx, { title: "org hub", visibility: "org" })).id as string;
    await writer.link(octx, hubId, "next", fillerIds[0] as string);

    // Everything after this instant is what the scrubber window covers.
    changedSince = (
      await pool.query<{ now: Date }>("SELECT now() AS now")
    ).rows[0]!.now.toISOString();

    recentOrgId = (
      await writer.write(octx, { title: "recently changed org note", visibility: "org" })
    ).id as string;

    // Alice's private object, linked to the hub. Nobody but Alice may learn it
    // exists — not the owner, not another member, not the viewer.
    alicePrivateId = (await writer.write(actx, { title: "alice private", visibility: "private" }))
      .id as string;
    await writer.link(actx, alicePrivateId, "mentions", hubId);

    // …and one shared with Bob: same privacy machinery, opposite answer for the
    // one member it names.
    aliceSharedId = (
      await writer.write(actx, {
        title: "alice shared with bob",
        visibility: "private",
        sharedWith: [bobId],
      })
    ).id as string;
    await writer.link(actx, aliceSharedId, "mentions", hubId);
  }, 300_000);

  afterAll(async () => {
    await ownerClient?.end();
    await churnPool?.end();
    await pool?.end();
    await brain?.drop();
  });

  // ---- 1. completeness ---------------------------------------------------

  it("returns the FULL visible set for every tier — not a 320-node sample", async () => {
    for (const [who, actorId] of [
      ["owner", ownerId],
      ["alice", aliceId],
      ["bob", bobId],
      ["viewer", viewerId],
    ] as const) {
      const g = await graph("", who);
      const expected = await visibleCount(actorId);
      expect(g.nodes.length, `${who} node count`).toBe(expected);
      // the number the old cap would have produced, stated out loud
      expect(g.nodes.length, `${who} above the old cap`).toBeGreaterThan(320);
      expect(new Set(g.nodes.map((n) => n.id)).size, `${who} has no duplicate node`).toBe(
        g.nodes.length,
      );
      expect(g.nextCursor, `${who} fits in one page`).toBeNull();
      expect(g.truncated, `${who} is not truncated`).toBeNull();
      expect(Number.isFinite(Date.parse(g.watermark))).toBe(true);
    }
  }, 120_000);

  it("each tier sees exactly the edges its own visible endpoints allow", async () => {
    // The chain + the hub's org edge are common to everyone; the two private
    // edges are the only difference between the four payloads.
    expect((await graph("", "owner")).edges.length).toBe(ORG_EDGES);
    expect((await graph("", "viewer")).edges.length).toBe(ORG_EDGES);
    expect((await graph("", "bob")).edges.length).toBe(ORG_EDGES + 1);
    expect((await graph("", "alice")).edges.length).toBe(ORG_EDGES + 2);
  }, 120_000);

  // ---- 2. the leak test, at every tier ------------------------------------

  it("the private endpoint is absent for the owner, and its edge is not in the hub's degree", async () => {
    const g = await graph("", "owner");
    expect(g.nodes.some((n) => n.id === alicePrivateId)).toBe(false);
    expect(g.edges.some((e) => e.from === alicePrivateId || e.to === alicePrivateId)).toBe(false);
    // the sharpest case: the owner outranks Alice everywhere else on the box.
    expect(g.nodes.find((n) => n.id === hubId)!.degree).toBe(1);
    expect(JSON.stringify(g)).not.toContain(alicePrivateId);
  }, 120_000);

  it("…for another member, whose own shared edge still counts", async () => {
    const g = await graph("", "bob");
    expect(g.nodes.some((n) => n.id === alicePrivateId)).toBe(false);
    expect(g.edges.some((e) => e.from === alicePrivateId || e.to === alicePrivateId)).toBe(false);
    expect(JSON.stringify(g)).not.toContain(alicePrivateId);
    // Bob is on shared_with, so THAT object and THAT edge are his to see —
    // degree 2 = the org edge + the shared one, and no third hidden hop.
    expect(g.nodes.some((n) => n.id === aliceSharedId)).toBe(true);
    expect(g.edges.some((e) => e.from === aliceSharedId && e.to === hubId)).toBe(true);
    expect(g.nodes.find((n) => n.id === hubId)!.degree).toBe(2);
  }, 120_000);

  it("…and for a viewer, who is on neither object", async () => {
    const g = await graph("", "viewer");
    for (const hidden of [alicePrivateId, aliceSharedId]) {
      expect(g.nodes.some((n) => n.id === hidden)).toBe(false);
      expect(g.edges.some((e) => e.from === hidden || e.to === hidden)).toBe(false);
      expect(JSON.stringify(g)).not.toContain(hidden);
    }
    expect(g.nodes.find((n) => n.id === hubId)!.degree).toBe(1);
  }, 120_000);

  it("the creator sees both of her objects, both edges, and the full degree", async () => {
    const g = await graph("", "alice");
    expect(g.nodes.some((n) => n.id === alicePrivateId)).toBe(true);
    expect(g.nodes.some((n) => n.id === aliceSharedId)).toBe(true);
    expect(g.edges.filter((e) => e.to === hubId && e.rel === "mentions").length).toBe(2);
    expect(g.nodes.find((n) => n.id === hubId)!.degree).toBe(3);
  }, 120_000);

  // ---- 3. /graph/changed --------------------------------------------------

  it("the scrubber returns only ids the caller was already given, and counts them exactly", async () => {
    const q = `?since=${encodeURIComponent(changedSince)}`;
    for (const who of ["owner", "alice", "bob", "viewer"] as const) {
      const c = await changed(q, who);
      const visible = new Set((await graph("", who)).nodes.map((n) => n.id));
      expect(c.ids.length, `${who} saw something change`).toBeGreaterThan(0);
      for (const id of c.ids) expect(visible.has(id), `${who} got an unreadable id`).toBe(true);
      // "count matches the returned ids exactly" — not the raw feed row count,
      // which is bigger and would itself be a signal.
      expect(c.count, `${who} count`).toBe(c.ids.length);
      expect(new Set(c.ids).size, `${who} ids are unique`).toBe(c.ids.length);
      expect(c.ids, `${who} sees the recent org note`).toContain(recentOrgId);
    }
  }, 120_000);

  it("the scrubber never names another member's private object", async () => {
    const q = `?since=${encodeURIComponent(changedSince)}`;
    for (const who of ["owner", "viewer"] as const) {
      const c = await changed(q, who);
      expect(c.ids).not.toContain(alicePrivateId);
      expect(c.ids).not.toContain(aliceSharedId);
      expect(JSON.stringify(c)).not.toContain(alicePrivateId);
      expect(JSON.stringify(c)).not.toContain(aliceSharedId);
    }
    const bob = await changed(q, "bob");
    expect(bob.ids).not.toContain(alicePrivateId);
    expect(JSON.stringify(bob)).not.toContain(alicePrivateId);
    expect(bob.ids).toContain(aliceSharedId); // shared_with, so it is his
    const alice = await changed(q, "alice");
    expect(alice.ids).toContain(alicePrivateId);
    expect(alice.ids).toContain(aliceSharedId);
  }, 120_000);

  // ---- 4. paging under concurrent writes ---------------------------------

  it("pages the watermark snapshot exactly once while another connection churns", async () => {
    const churn = new Writer(churnPool);
    const cctx: WriteContext = { actorId: ownerId, scopes: ["read", "write"] };

    const first = await graph("?limit=50", "owner");
    expect(first.nodes.length).toBe(50);
    expect(first.nextCursor).not.toBeNull();
    const wm = first.watermark;
    // The snapshot, defined independently of the endpoint under test.
    const snapshot = await snapshotIds(ownerId, wm);
    expect(snapshot.size).toBeGreaterThan(320);

    // Victims: filler objects that page 1 did NOT deliver, taken from the top
    // of the id order so the walk reaches them last — each is therefore deleted
    // while still pending. Paging is keyset by id, so "> page 1's last id" is
    // exactly "not yet delivered". Only fillers: deleting the hub would rewrite
    // the graph every later assertion reads.
    const pagedTo = first.nodes[first.nodes.length - 1]!.id;
    const victims = fillerIds
      .filter((id) => id > pagedTo && snapshot.has(id))
      .sort()
      .slice(-5);
    expect(victims.length).toBe(5);
    const deleted: string[] = [];
    const created: string[] = [];

    const seen = new Set<string>();
    const seenEdges = new Set<string>();
    for (const n of first.nodes) seen.add(n.id);
    for (const e of first.edges) seenEdges.add(`${e.from}|${e.rel}|${e.to}`);
    let cursor = first.nextCursor;
    for (let page = 0; cursor !== null; page++) {
      expect(page).toBeLessThan(50);
      // …another connection, mid-walk: one creation (post-watermark, must never
      // appear) and one soft-delete of a not-yet-paged node (must STILL appear,
      // or page 1's edges would point at a node that never arrives).
      created.push((await churn.write(cctx, { title: `churn create ${page}` })).id as string);
      const victim = victims[page];
      if (victim !== undefined) {
        await churn.softDelete(cctx, victim);
        deleted.push(victim);
      }

      const g: GraphPage = await graph(`?limit=50&after=${encodeURIComponent(cursor)}`, "owner");
      expect(g.watermark, "every page of one walk shares its snapshot").toBe(wm);
      for (const n of g.nodes) {
        expect(seen.has(n.id), `duplicate node ${n.id}`).toBe(false);
        seen.add(n.id);
      }
      for (const e of g.edges) {
        const key = `${e.from}|${e.rel}|${e.to}`;
        expect(seenEdges.has(key), `duplicate edge ${key}`).toBe(false);
        seenEdges.add(key);
        // an edge never arrives before either of its endpoints
        expect(seen.has(e.from)).toBe(true);
        expect(seen.has(e.to)).toBe(true);
      }
      cursor = g.nextCursor;
    }

    expect(deleted.length).toBe(victims.length);
    expect(created.length).toBeGreaterThan(0);
    // complete: nothing missing…
    for (const id of snapshot) expect(seen.has(id), `missing ${id}`).toBe(true);
    // …and nothing extra: the churn's post-watermark objects stayed out.
    expect(seen.size).toBe(snapshot.size);
    for (const id of created) expect(seen.has(id)).toBe(false);
    // the mid-walk deletions were still delivered against the snapshot
    for (const id of deleted) expect(seen.has(id)).toBe(true);
    expect(seenEdges.size).toBe(ORG_EDGES);

    // A FRESH walk takes a new watermark and reflects the churn both ways.
    const fresh = await graph("", "owner");
    const freshIds = new Set(fresh.nodes.map((n) => n.id));
    for (const id of deleted) expect(freshIds.has(id)).toBe(false);
    for (const id of created) expect(freshIds.has(id)).toBe(true);
    expect(fresh.nodes.length).toBe(await visibleCount(ownerId));
  }, 300_000);

  // ---- 5. past the ceiling ------------------------------------------------

  it("past GRAPH_FULL_MAX it says truncated and serves the sample — still no leak", async () => {
    const su = await brain.connect("superuser");
    try {
      await su.query("SELECT set_config('app.actor_id', $1, false)", [ownerId]);
      // Same audience stamp as the beforeAll seed: org-visible under 0057.
      await su.query(
        `INSERT INTO objects (title, created_by, visibility, audience)
         SELECT 'bulk ' || g, $1, 'org',
                (SELECT jsonb_build_array(jsonb_build_array(id::text))
                 FROM tags WHERE kind = 'org')
         FROM generate_series(1, $2::int) g`,
        [ownerId, GRAPH_FULL_MAX],
      );
      await analyze(su);
    } finally {
      await su.end();
    }

    const g = await graph("", "owner");
    expect(g.truncated).not.toBeNull();
    expect(g.truncated!.reason).toBe("size");
    expect(g.truncated!.total).toBeGreaterThan(GRAPH_FULL_MAX);
    expect(g.truncated!.total).toBe(await visibleCount(ownerId));
    expect(g.truncated!.shown).toBe(GRAPH_FULL_MAX);
    expect(g.nodes.length).toBe(GRAPH_FULL_MAX);
    // sampling and paging do not mix: a truncated response hands out no cursor.
    expect(g.nextCursor).toBeNull();
    // the sample is top-degree first, not keyset order
    expect(g.nodes[0]!.degree).toBeGreaterThanOrEqual(g.nodes[g.nodes.length - 1]!.degree);

    // The fallback is a SECOND query, so the leak rule has to hold there too.
    expect(g.nodes.some((n) => n.id === alicePrivateId)).toBe(false);
    expect(g.edges.some((e) => e.from === alicePrivateId || e.to === alicePrivateId)).toBe(false);
    expect(JSON.stringify(g)).not.toContain(alicePrivateId);
    const hub = g.nodes.find((n) => n.id === hubId);
    expect(hub, "the hub is the most-connected node, so the sample keeps it").toBeDefined();
    expect(hub!.degree).toBe(1);

    const viewer = await graph("", "viewer");
    expect(viewer.truncated!.reason).toBe("size");
    expect(JSON.stringify(viewer)).not.toContain(alicePrivateId);
    expect(JSON.stringify(viewer)).not.toContain(aliceSharedId);
  }, 300_000);
});
