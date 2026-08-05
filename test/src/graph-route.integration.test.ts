import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, GRAPH_FULL_MAX, Writer, type WriteContext } from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * `GET /api/v1/graph` and `GET /api/v1/graph/changed` — the graph view's data
 * path at the HTTP seam.
 *
 * The reader's own privacy rules are pinned in graph-full-reader; what is only
 * provable here is the ROUTE's half:
 *
 *  1. **One filter language.** The `where` the table view compiles is the
 *     `where` the graph sends. A property filter the graph cannot honour is
 *     REFUSED (400) rather than dropped — a silently dropped term would show
 *     the viewer nodes they had filtered out and make every derived number
 *     (degree, hubs, orphans, the changed count) disagree with the chips on
 *     screen.
 *  2. **The scrubber never leaks the feed.** `events` has no RLS (0012), so
 *     `/graph/changed` intersects the feed's target ids with the viewer's
 *     visible node set and counts only survivors. The owner must not learn
 *     that a member's private object exists, or its uuid, by asking what
 *     changed.
 *  3. `/graph/changed` is not swallowed by the older `/graph/:id` neighbors
 *     route, and `/graph-sample` (the fallback + rail) still answers.
 */

const SECRET = "test-session-secret-please-change";

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

describe("dashboard graph routes", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let ownerCookie: string;
  let memberCookie: string;
  let ownerId: string;
  let memberId: string;
  const noteIds: string[] = [];
  let dealId: string;
  let secretId: string;
  let bridgeId: string;
  let startedAt: string;

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

  const graph = async (query: string, cookie = ownerCookie): Promise<GraphPage> => {
    const res = await get(`/api/v1/graph${query}`, cookie);
    const body = (await res.json()) as GraphPage & { error?: string };
    expect(res.status, `graph${query} refused: ${body.error}`).toBe(200);
    return body;
  };

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
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    ownerId = boot.id;
    const member = await admin.createUser(ownerId, {
      name: "Member",
      email: "member@example.com",
      permission: "member",
    });
    memberId = member.id;
    ownerCookie = await login(boot.token);
    memberCookie = await login(member.token);

    // One real type so the type filter has something to name.
    const exec = new SchemaExecutor(ownerClient);
    await exec.defineType({ name: "deal" }, ownerId);

    const writer = new Writer(pool);
    const octx: WriteContext = { actorId: ownerId, scopes: ["read", "write"] };
    const mctx: WriteContext = { actorId: memberId, scopes: ["read", "write"] };

    startedAt = new Date(Date.now() - 60_000).toISOString();

    // A 6-node chain of untyped notes…
    for (let i = 0; i < 6; i++) {
      const o = await writer.write(octx, { title: `note ${i}`, visibility: "org" });
      noteIds.push(o.id as string);
    }
    for (let i = 0; i < 5; i++) {
      await writer.link(octx, noteIds[i]!, "next", noteIds[i + 1]!);
    }
    // …plus one typed object, so a type filter can separate them.
    dealId = (await writer.write(octx, { type: "deal", title: "Big deal", visibility: "org" }))
      .id as string;

    // A private object of the MEMBER's, linked to a note the owner can see.
    // Its uuid appears in `events` (which has no RLS) — the whole point of the
    // /graph/changed intersection.
    bridgeId = noteIds[0]!;
    secretId = (await writer.write(mctx, { title: "member secret", visibility: "private" }))
      .id as string;
    await writer.link(mctx, secretId, "mentions", bridgeId);
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  // ---- GET /api/v1/graph -------------------------------------------------

  it("requires a session", async () => {
    expect((await app.request("/api/v1/graph")).status).toBe(401);
    expect((await app.request("/api/v1/graph/changed?since=2020-01-01T00:00:00Z")).status).toBe(
      401,
    );
  });

  it("returns the whole visible graph with rel-bearing edges and no cursor", async () => {
    const g = await graph("");
    // 6 notes + 1 deal + the owner's bootstrap personal note.
    expect(g.nodes.length).toBe(8);
    expect(g.edges.length).toBe(5);
    expect(g.edges.every((e) => e.rel === "next")).toBe(true);
    expect(g.nextCursor).toBeNull();
    expect(g.truncated).toBeNull();
    expect(Number.isFinite(Date.parse(g.watermark))).toBe(true);
  });

  it("the owner never sees the member's private node, edge, or its degree", async () => {
    const g = await graph("");
    expect(g.nodes.some((n) => n.id === secretId)).toBe(false);
    expect(g.edges.some((e) => e.from === secretId || e.to === secretId)).toBe(false);
    expect(g.nodes.find((n) => n.id === bridgeId)!.degree).toBe(1);

    const m = await graph("", memberCookie);
    expect(m.nodes.some((n) => n.id === secretId)).toBe(true);
  });

  it("pages by cursor and delivers every node and edge exactly once", async () => {
    const seenNodes = new Set<string>();
    const seenEdges: string[] = [];
    let cursor: string | null = null;
    let watermark: string | null = null;
    for (let page = 0; page < 20; page++) {
      const g: GraphPage = await graph(
        `?limit=3${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (watermark === null) watermark = g.watermark;
      else expect(g.watermark).toBe(watermark); // one snapshot for the walk
      for (const n of g.nodes) {
        expect(seenNodes.has(n.id)).toBe(false);
        seenNodes.add(n.id);
      }
      for (const e of g.edges) {
        // both endpoints already delivered when the edge arrives
        expect(seenNodes.has(e.from)).toBe(true);
        expect(seenNodes.has(e.to)).toBe(true);
        seenEdges.push(`${e.from}->${e.to}`);
      }
      cursor = g.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seenNodes.size).toBe(8);
    expect(seenEdges.length).toBe(5);
    expect(new Set(seenEdges).size).toBe(5);
  });

  it("clamps limit to GRAPH_FULL_MAX instead of erroring", async () => {
    const g = await graph(`?limit=${GRAPH_FULL_MAX * 100}`);
    expect(g.nodes.length).toBeLessThanOrEqual(GRAPH_FULL_MAX);
    expect(g.nodes.length).toBe(8);
  });

  it("rejects a malformed cursor and a malformed watermark", async () => {
    expect((await get("/api/v1/graph?after=not-a-cursor", ownerCookie)).status).toBe(400);
    expect((await get("/api/v1/graph?watermark=yesterday", ownerCookie)).status).toBe(400);
  });

  // ---- the phase-3 filter model, serialized as `where` --------------------

  it("filters by type with the same where AST the table view compiles", async () => {
    const typed = await graph(
      `?where=${encodeURIComponent(JSON.stringify({ field: "type", op: "in", value: ["deal"] }))}`,
    );
    expect(typed.nodes.map((n) => n.id)).toEqual([dealId]);

    const untyped = await graph(
      `?where=${encodeURIComponent(JSON.stringify({ field: "type", op: "is_null" }))}`,
    );
    expect(untyped.nodes.some((n) => n.id === dealId)).toBe(false);
    expect(untyped.nodes.some((n) => n.id === bridgeId)).toBe(true);
  });

  it("filters by recency, and combines terms with and", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const none = await graph(
      `?where=${encodeURIComponent(JSON.stringify({ field: "updated_at", op: "gte", value: future }))}`,
    );
    expect(none.nodes.length).toBe(0);

    const both = await graph(
      `?where=${encodeURIComponent(
        JSON.stringify({
          and: [
            { field: "type", op: "in", value: ["deal"] },
            { field: "updated_at", op: "gte", value: startedAt },
          ],
        }),
      )}`,
    );
    expect(both.nodes.map((n) => n.id)).toEqual([dealId]);
  });

  it("REFUSES a filter it cannot honour rather than dropping it", async () => {
    // A property filter: the graph spans every type, so there is no single ext
    // table to resolve `stage` against. Dropping it would show the viewer nodes
    // they filtered out.
    const res = await get(
      `/api/v1/graph?where=${encodeURIComponent(JSON.stringify({ field: "stage", op: "eq", value: "won" }))}`,
      ownerCookie,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("stage");

    for (const where of [
      { or: [{ field: "type", op: "eq", value: "deal" }] },
      { not: { field: "type", op: "eq", value: "deal" } },
      { field: "created_at", op: "gte", value: "2026-01-01T00:00:00Z" },
      { field: "type", op: "ne", value: "deal" },
    ]) {
      const r = await get(
        `/api/v1/graph?where=${encodeURIComponent(JSON.stringify(where))}`,
        ownerCookie,
      );
      expect(r.status, `expected 400 for ${JSON.stringify(where)}`).toBe(400);
    }

    expect((await get("/api/v1/graph?where=%7Bnot-json", ownerCookie)).status).toBe(400);
  });

  it("refuses contradictory type terms instead of widening back to everything", async () => {
    const res = await get(
      `/api/v1/graph?where=${encodeURIComponent(
        JSON.stringify({
          and: [
            { field: "type", op: "eq", value: "deal" },
            { field: "type", op: "is_null" },
          ],
        }),
      )}`,
      ownerCookie,
    );
    expect(res.status).toBe(400);
  });

  // ---- GET /api/v1/graph/changed -----------------------------------------

  const changed = async (query: string, cookie = ownerCookie): Promise<ChangedPayload> => {
    const res = await get(`/api/v1/graph/changed${query}`, cookie);
    const body = (await res.json()) as ChangedPayload & { error?: string };
    expect(res.status, `changed${query} refused: ${body.error}`).toBe(200);
    return body;
  };

  it("is a route of its own, not the neighbors param route", async () => {
    const c = await changed(`?since=${encodeURIComponent(startedAt)}`);
    expect(Array.isArray(c.ids)).toBe(true);
    expect(c.since).toBe(new Date(startedAt).toISOString());
  });

  it("requires an ISO-8601 since", async () => {
    expect((await get("/api/v1/graph/changed", ownerCookie)).status).toBe(400);
    expect((await get("/api/v1/graph/changed?since=lunchtime", ownerCookie)).status).toBe(400);
  });

  it("returns only ids the viewer was already given — never a feed row", async () => {
    const c = await changed(`?since=${encodeURIComponent(startedAt)}`);
    const visible = new Set((await graph("")).nodes.map((n) => n.id));
    expect(c.ids.length).toBeGreaterThan(0);
    for (const id of c.ids) expect(visible.has(id)).toBe(true);
    // the member's private object changed inside the window and has feed rows
    expect(c.ids).not.toContain(secretId);
    expect(JSON.stringify(c)).not.toContain(secretId);
    expect(c.count).toBe(c.ids.length);
  });

  it("counts only survivors of the intersection", async () => {
    const owner = await changed(`?since=${encodeURIComponent(startedAt)}`);
    const feedRes = await get("/api/v1/feed?limit=200", ownerCookie);
    expect(feedRes.status).toBe(200);
    const feed = (await feedRes.json()) as Array<{ target: string | null; kind: string }>;

    // The feed has NO RLS (0012): the private object's uuid is right there in
    // the owner's own feed…
    expect(feed.some((r) => r.target === secretId)).toBe(true);
    // …and none of it survives into the scrubber payload — not the id, and not
    // the count, which is computed after the intersection rather than over the
    // raw rows.
    expect(owner.ids).not.toContain(secretId);
    expect(sumOf(owner.byKind)).toBeLessThan(feed.filter((r) => r.target !== null).length);

    // The creator, reading the identical feed, does get their own object.
    const member = await changed(`?since=${encodeURIComponent(startedAt)}`, memberCookie);
    expect(member.ids).toContain(secretId);
  });

  it("an empty window is empty, and the scrubber can only narrow the view filter", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const none = await changed(`?since=${encodeURIComponent(future)}`);
    expect(none.ids).toEqual([]);
    expect(none.count).toBe(0);
    expect(sumOf(none.byKind)).toBe(0);

    // where says "deal only"; since says "everything recent" → deal only.
    const scoped = await changed(
      `?since=${encodeURIComponent(startedAt)}&where=${encodeURIComponent(
        JSON.stringify({ field: "type", op: "in", value: ["deal"] }),
      )}`,
    );
    expect(scoped.ids).toEqual([dealId]);
  });

  // ---- the fallback + rail path is untouched -----------------------------

  it("keeps /graph-sample and /graph/:id answering", async () => {
    const sample = await get("/api/v1/graph-sample?limit=5", ownerCookie);
    expect(sample.status).toBe(200);
    expect(Array.isArray(((await sample.json()) as { nodes: unknown[] }).nodes)).toBe(true);

    const neighbors = await get(`/api/v1/graph/${bridgeId}`, ownerCookie);
    expect(neighbors.status).toBe(200);
  });
});

function sumOf(h: Record<string, number>): number {
  return Object.values(h).reduce((a, b) => a + b, 0);
}
