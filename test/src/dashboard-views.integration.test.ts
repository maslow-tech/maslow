import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The database views (phase 3) against a real box.
 *
 * Two things are pinned, and both are about a seam that a unit test on either
 * side would happily let rot:
 *
 *  1. **The client's filter model cannot drift from the server's query AST.**
 *     The dashboard compiles one `ViewConfig` into the `{where, sort}` the list
 *     endpoint takes (`toListQuery`, apps/box/ui/src/lib/viewConfig.ts). Adding
 *     an operator there that `compileWhere` does not accept ships a view that
 *     400s on a member's saved filter — and nothing in the SPA's own tests
 *     would notice, because they stub `api.list`. So this file runs the REAL
 *     `toListQuery` over every operator the client can emit and sends each
 *     result to the REAL endpoint, then checks the rows that come back mean
 *     what the filter said. The operator list is read out of the client's own
 *     source, so a new one that nothing here exercises fails the suite instead
 *     of shipping untested.
 *  2. **A prop patch is authorized on the server, not in the layout.** A viewer
 *     dragging a card is refused 403 (the read-only UI is UX, never the
 *     boundary), the same patch by a member succeeds, and the version moves by
 *     exactly one — the number every subsequent CAS write depends on.
 *
 * `toListQuery` is loaded through a NON-LITERAL specifier on purpose: it is a
 * browser module (it touches `localStorage`), and a static import would drag
 * the SPA's DOM-typed sources into this package's node-typed tsc program.
 * Vitest resolves and transforms it at runtime; tsc never follows it.
 */

const VIEW_CONFIG_MODULE = "../../apps/box/ui/src/lib/viewConfig.js";
const VIEW_CONFIG_SOURCE = fileURLToPath(
  new URL("../../apps/box/ui/src/lib/viewConfig.ts", import.meta.url),
);

/** The client's shapes, restated structurally (see the note above). */
type ClientOp =
  "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "like" | "ilike" | "in" | "is_null" | "is_not_null";
type Scalar = string | number | boolean | null;
interface ClientFilter {
  prop: string;
  op: ClientOp;
  value?: Scalar | Scalar[];
}
interface ClientConfig {
  layout: "table" | "board" | "gallery" | "calendar";
  filters: ClientFilter[];
  sort: Array<{ prop: string; dir: "asc" | "desc" }>;
  groupBy: string | null;
  dateProp: string | null;
  columns: Array<{ key: string; visible: boolean; width?: number }>;
}
interface ListQuery {
  where?: unknown;
  sort?: { field: string; dir: "asc" | "desc" };
}

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

describe("dashboard database views", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let admin: Admin;
  let toListQuery: (config: ClientConfig) => ListQuery;

  let memberAuth: { cookie: string; csrf: string };
  let viewerAuth: { cookie: string; csrf: string };
  const ids: Record<string, string> = {};

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(path, init));

  const login = async (token: string): Promise<{ cookie: string; csrf: string }> => {
    const res = await req("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const session = cookieValue(res, "brain_session");
    const csrf = cookieValue(res, "brain_csrf");
    if (!session || !csrf) throw new Error("login did not set both cookies");
    return { cookie: `brain_session=${session}; brain_csrf=${csrf}`, csrf };
  };

  const call = (
    method: string,
    path: string,
    body: unknown,
    auth: { cookie: string; csrf: string },
  ): Promise<Response> =>
    req(path, {
      method,
      headers: {
        cookie: auth.cookie,
        "content-type": "application/json",
        "x-csrf-token": auth.csrf,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const get = (path: string, auth: { cookie: string; csrf: string }): Promise<Response> =>
    req(path, { headers: { cookie: auth.cookie } });

  /** Exactly the URL the SPA builds: `api.list(type, {limit, ...toListQuery})`. */
  const listUrl = (config: ClientConfig, limit = 50): string => {
    const q = toListQuery(config);
    const p = new URLSearchParams({ type: "deal", props: "1", limit: String(limit) });
    if (q.where !== undefined) p.set("where", JSON.stringify(q.where));
    if (q.sort !== undefined) p.set("sort", JSON.stringify(q.sort));
    return `/api/v1/list?${p}`;
  };

  /** Titles the view returns, in the order the server returned them. */
  const titles = async (config: ClientConfig): Promise<string[]> => {
    const res = await get(listUrl(config), memberAuth);
    const body = (await res.json()) as { items?: Array<{ title: string | null }>; error?: string };
    expect(res.status, `list refused ${JSON.stringify(toListQuery(config))}: ${body.error}`).toBe(
      200,
    );
    return (body.items ?? []).map((i) => i.title ?? "");
  };

  const config = (over: Partial<ClientConfig> = {}): ClientConfig => ({
    layout: "table",
    filters: [],
    sort: [{ prop: "updated_at", dir: "desc" }],
    groupBy: "stage",
    dateProp: "due",
    columns: [{ key: "stage", visible: true }],
    ...over,
  });

  const oneFilter = (f: ClientFilter): ClientConfig => config({ filters: [f] });

  beforeAll(async () => {
    ({ toListQuery } = (await import(VIEW_CONFIG_MODULE)) as {
      toListQuery: (c: ClientConfig) => ListQuery;
    });

    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false },
    });
    admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    const memberToken = (
      await admin.createUser(boot.id, {
        name: "Member",
        email: "member@example.com",
        permission: "member",
      })
    ).token;
    const viewerToken = (
      await admin.createUser(boot.id, {
        name: "Viewer",
        email: "viewer@example.com",
        permission: "viewer",
      })
    ).token;

    // One type carrying a property of every kind a filter chip can be built on
    // — the UI offers ops per KIND, so a kind with no coverage here is a kind
    // whose filters were never tried against real SQL.
    const exec = new SchemaExecutor(ownerClient);
    const t = await exec.defineType({ name: "deal" }, boot.id);
    await exec.addProperty(
      { typeId: t.typeId, name: "stage", kind: "enum", enumValues: ["open", "won", "lost"] },
      boot.id,
    );
    await exec.addProperty({ typeId: t.typeId, name: "city", kind: "text" }, boot.id);
    await exec.addProperty({ typeId: t.typeId, name: "amount", kind: "int" }, boot.id);
    await exec.addProperty({ typeId: t.typeId, name: "due", kind: "date" }, boot.id);
    await exec.addProperty({ typeId: t.typeId, name: "closed", kind: "bool" }, boot.id);

    memberAuth = await login(memberToken);
    viewerAuth = await login(viewerToken);

    const make = async (title: string, props: Record<string, unknown>): Promise<void> => {
      const res = await call("POST", "/api/v1/objects", { type: "deal", title, props }, memberAuth);
      expect(res.status, `creating ${title}`).toBe(200);
      ids[title] = ((await res.json()) as { id: string }).id;
    };
    await make("Alpha", {
      stage: "open",
      city: "Austin",
      amount: 10,
      due: "2026-07-15",
      closed: false,
    });
    await make("Beta", {
      stage: "won",
      city: "Dallas",
      amount: 40,
      due: "2026-07-02",
      closed: true,
    });
    // Everything unset: the row that separates "is empty" from "is not empty",
    // and the one a `ne` filter must NOT quietly include.
    await make("Gamma", {});
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  // ---- every where/sort shape the client can compile ----------------------

  /**
   * One case per operator the client offers. Written as data so the coverage
   * guard below can prove the set is complete rather than plausible.
   */
  const CASES: Array<{
    op: ClientOp;
    filter: ClientFilter;
    expect: string[];
    excludes?: string[];
  }> = [
    { op: "eq", filter: { prop: "stage", op: "eq", value: "open" }, expect: ["Alpha"] },
    // SQL three-valued logic: `<>` does not match NULL, so Gamma is absent —
    // asserted, because a client that "helpfully" rewrote ne to NOT(eq) would
    // change which rows a saved filter shows.
    {
      op: "ne",
      filter: { prop: "stage", op: "ne", value: "open" },
      expect: ["Beta"],
      excludes: ["Alpha", "Gamma"],
    },
    { op: "lt", filter: { prop: "amount", op: "lt", value: 40 }, expect: ["Alpha"] },
    { op: "lte", filter: { prop: "amount", op: "lte", value: 40 }, expect: ["Alpha", "Beta"] },
    { op: "gt", filter: { prop: "amount", op: "gt", value: 10 }, expect: ["Beta"] },
    { op: "gte", filter: { prop: "amount", op: "gte", value: 10 }, expect: ["Alpha", "Beta"] },
    // The UI's "contains": toListQuery wraps the typed value in %…%, and the
    // wrapping is the point — an unwrapped LIKE matches nothing here.
    { op: "like", filter: { prop: "city", op: "like", value: "ustin" }, expect: ["Alpha"] },
    { op: "ilike", filter: { prop: "city", op: "ilike", value: "AUSTIN" }, expect: ["Alpha"] },
    {
      op: "in",
      filter: { prop: "stage", op: "in", value: ["open", "won"] },
      expect: ["Alpha", "Beta"],
    },
    { op: "is_null", filter: { prop: "stage", op: "is_null" }, expect: ["Gamma"] },
    {
      op: "is_not_null",
      filter: { prop: "stage", op: "is_not_null" },
      expect: ["Alpha", "Beta"],
    },
  ];

  for (const c of CASES) {
    it(`the list endpoint honours a compiled \`${c.op}\` filter`, async () => {
      const got = await titles(oneFilter(c.filter));
      expect([...got].sort()).toEqual([...c.expect].sort());
      for (const gone of c.excludes ?? []) expect(got).not.toContain(gone);
    });
  }

  it("covers every operator the client can emit (no drift from query-ast)", () => {
    // The client's own list, read out of its source: adding an op there without
    // a case here fails HERE, before it fails on a member's saved filter.
    const src = readFileSync(VIEW_CONFIG_SOURCE, "utf8");
    const block = /const OPS:\s*readonly FilterOp\[\]\s*=\s*\[([\s\S]*?)\]/.exec(src);
    expect(
      block,
      "viewConfig.ts no longer declares `const OPS: readonly FilterOp[]`",
    ).not.toBeNull();
    const declared = [...(block?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...CASES.map((c) => c.op)].sort());
  });

  it("compiles bool and date properties into filters the server accepts", async () => {
    expect(await titles(oneFilter({ prop: "closed", op: "eq", value: true }))).toEqual(["Beta"]);
    expect(await titles(oneFilter({ prop: "due", op: "gte", value: "2026-07-10" }))).toEqual([
      "Alpha",
    ]);
    expect(await titles(oneFilter({ prop: "due", op: "lte", value: "2026-07-10" }))).toEqual([
      "Beta",
    ]);
    expect(await titles(oneFilter({ prop: "due", op: "eq", value: "2026-07-15" }))).toEqual([
      "Alpha",
    ]);
  });

  it("filters on the spine columns the chips also offer", async () => {
    expect(await titles(oneFilter({ prop: "title", op: "eq", value: "Alpha" }))).toEqual(["Alpha"]);
    expect(await titles(oneFilter({ prop: "title", op: "ilike", value: "amm" }))).toEqual([
      "Gamma",
    ]);
    const byId = await titles(oneFilter({ prop: "id", op: "eq", value: ids["Beta"] as string }));
    expect(byId).toEqual(["Beta"]);
  });

  it("many filters compile to ONE `and` node the server ANDs", async () => {
    const both = config({
      filters: [
        { prop: "stage", op: "ne", value: "won" },
        { prop: "amount", op: "gte", value: 5 },
      ],
    });
    expect(toListQuery(both).where).toHaveProperty("and");
    expect(await titles(both)).toEqual(["Alpha"]);
  });

  it("no filters compiles to no `where` at all — the server's own default", async () => {
    const q = toListQuery(config({ filters: [] }));
    expect(q.where).toBeUndefined();
    expect((await titles(config({ filters: [] }))).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("every sort the client can emit is a sort the server orders by", async () => {
    // Only the FIRST sort entry is sent (keyset pagination is (sort_col, id)),
    // and each of these is a column a header click or a saved view can produce.
    expect(toListQuery(config({ sort: [] })).sort).toBeUndefined();
    expect(
      toListQuery(
        config({
          sort: [
            { prop: "title", dir: "asc" },
            { prop: "amount", dir: "desc" },
          ],
        }),
      ).sort,
    ).toEqual({ field: "title", dir: "asc" });

    expect(await titles(config({ sort: [{ prop: "title", dir: "asc" }] }))).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(await titles(config({ sort: [{ prop: "title", dir: "desc" }] }))).toEqual([
      "Gamma",
      "Beta",
      "Alpha",
    ]);
    // A property sort. Filtered to the rows that HAVE the property, because
    // Postgres orders NULLs first on DESC and this is a test of the compiled
    // sort, not of that (real, and deliberately unmasked) behaviour.
    expect(
      await titles(
        config({
          filters: [{ prop: "amount", op: "is_not_null" }],
          sort: [{ prop: "amount", dir: "desc" }],
        }),
      ),
    ).toEqual(["Beta", "Alpha"]);
    for (const field of ["updated_at", "created_at", "id", "version"]) {
      for (const dir of ["asc", "desc"] as const) {
        const got = await titles(config({ sort: [{ prop: field, dir }] }));
        expect(got.sort(), `sort by ${field} ${dir}`).toEqual(["Alpha", "Beta", "Gamma"]);
      }
    }
  });

  it("a compiled filter with no matches is an empty list, not an error", async () => {
    expect(await titles(oneFilter({ prop: "city", op: "ilike", value: "nowhere" }))).toEqual([]);
  });

  // ---- who may move a card -----------------------------------------------

  it("a viewer's prop patch is 403 and moves nothing", async () => {
    const id = ids["Alpha"] as string;
    const before = await get(`/api/v1/objects/${id}`, memberAuth);
    const { version } = (await before.json()) as { version: number };

    // Exactly what a board drag sends.
    const res = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: version, props: { stage: "won" } },
      viewerAuth,
    );
    expect(res.status).toBe(403);

    const after = (await (await get(`/api/v1/objects/${id}`, memberAuth)).json()) as {
      version: number;
      props: Record<string, unknown>;
    };
    expect(after.version).toBe(version);
    expect(after.props["stage"]).toBe("open");
  });

  it("a member's prop patch succeeds and bumps the version exactly once", async () => {
    const id = ids["Beta"] as string;
    const before = (await (await get(`/api/v1/objects/${id}`, memberAuth)).json()) as {
      version: number;
      props: Record<string, unknown>;
    };

    const res = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: before.version, props: { stage: "lost" } },
      memberAuth,
    );
    expect(res.status).toBe(200);
    const { version } = (await res.json()) as { version: number };
    expect(version).toBe(before.version + 1);

    const after = (await (await get(`/api/v1/objects/${id}`, memberAuth)).json()) as {
      version: number;
      props: Record<string, unknown>;
    };
    expect(after.version).toBe(before.version + 1);
    expect(after.props["stage"]).toBe("lost");
    // The patch is field-granular: a drag moves the group property and touches
    // nothing else on the card.
    expect(after.props["city"]).toBe(before.props["city"]);
    expect(after.props["amount"]).toBe(before.props["amount"]);

    // And the base is spent: replaying the same drag is a conflict, not a
    // second silent bump.
    const replay = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: before.version, props: { stage: "open" } },
      memberAuth,
    );
    expect(replay.status).toBe(409);
    const still = (await (await get(`/api/v1/objects/${id}`, memberAuth)).json()) as {
      version: number;
    };
    expect(still.version).toBe(before.version + 1);
  });

  it("a moved card is where the filtered view says it is", async () => {
    // The write and the read agree: after the patch above, `stage is lost`
    // returns Beta and `stage is won` no longer does.
    expect(await titles(oneFilter({ prop: "stage", op: "eq", value: "lost" }))).toEqual(["Beta"]);
    expect(await titles(oneFilter({ prop: "stage", op: "eq", value: "won" }))).toEqual([]);
  });
});
