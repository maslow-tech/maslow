import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, Writer, type WriteContext } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Saved views (phase 4) — the CROSS-MEMBER boundary, not "the migration ran".
 *
 * A saved view's `config` is content-bearing: it carries filter literals, and a
 * saved focus embeds an OBJECT ID and the title the member typed to find it. A
 * view therefore leaks exactly what the privacy invariant forbids leaking — the
 * existence of another member's private object — and the sidebar it renders
 * into is trusted UI, so a row planted with someone else's `member_id` is a
 * click-target injection, not a data-hygiene nit.
 *
 * What this file pins, in the order it matters:
 *
 *  1. **Invisibility, both ways round.** B's list does not contain A's view,
 *     and — asserted on the raw response body, not just the parsed array — does
 *     not contain the private object's id or title ANYWHERE. B cannot PATCH or
 *     DELETE A's view by id: both answer the same uniform 404 an unknown id
 *     gets, because "there is a view here you may not touch" is itself the
 *     disclosure.
 *  2. **The POLICY, not the handler.** Every ownership check is also made at
 *     the SQL level, as `brain_app` with a transaction-local `app.actor_id` and
 *     no application code in the path: B SELECTs/UPDATEs/DELETEs zero of A's
 *     rows (the `USING`), and both an INSERT stamped with A's `member_id` and
 *     an UPDATE that rewrites `member_id` to A's are refused (the `WITH
 *     CHECK`). The store's `AND member_id = $actor` is belt and braces; if a
 *     test only exercised the handler, deleting the policy would keep the suite
 *     green and the box would be wide open on any path that forgot the clause.
 *  3. **CSRF on every mutation**, and the mutation provably did not happen.
 *  4. **The size cap in BYTES**, so a config that passes a `.length` check on
 *     multibyte text is still refused.
 *  5. **Reorder touches only the caller's rows** — and a reorder naming a
 *     foreign id rolls the WHOLE thing back rather than renumbering half a
 *     sidebar.
 *
 * A VIEWER saving their own view is asserted deliberately: mutations here ride
 * memberRoute (session + CSRF + active account), not writeRoute, because the
 * `write` scope is authority over brain content and a saved view is chrome. If
 * that deviation is ever "corrected" into writeRoute, this test says what
 * breaks.
 */

const SECRET = "test-session-secret-please-change";

/**
 * The store's cap, RESTATED rather than imported: apps/box/src/saved-views.ts is
 * not on this package's module graph (`@brain/box` publishes its index, not its
 * internals), and a deep relative import would drag the box's sources into this
 * package's tsc program for one number. The number is not left to drift — the
 * server's own refusal message names it, and the assertion below reads it back.
 */
const MAX_CONFIG_BYTES = 64 * 1024;

interface Auth {
  readonly cookie: string;
  readonly csrf: string;
}
interface ViewJson {
  id: string;
  kind: string;
  scope: string | null;
  name: string;
  config: Record<string, unknown>;
  pinned: boolean;
  position: number;
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

/** A transaction with `app.actor_id` set exactly as the request path sets it —
 *  transaction-local, under the request-serving role. */
async function withActor<T>(client: Client, actorId: string, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    const r = await fn();
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

describe("saved views are per-member and invisible cross-member", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;

  let memberA: string;
  let memberB: string;
  let authA: Auth;
  let authB: Auth;
  let authViewer: Auth;

  /** An object ONLY member A can see, plus the title she typed to find it —
   *  both of which end up inside her view's config. */
  let privateId: string;
  const PRIVATE_TITLE = "acquisition of northwind — do not share";

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(path, init));

  const login = async (token: string): Promise<Auth> => {
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

  /** A mutation with the CSRF header. `csrf: false` omits it — the same request
   *  in every other respect, which is what makes the refusal meaningful. */
  const call = (
    method: string,
    path: string,
    body: unknown,
    auth: Auth,
    opts: { csrf?: boolean } = {},
  ): Promise<Response> =>
    req(path, {
      method,
      headers: {
        cookie: auth.cookie,
        "content-type": "application/json",
        ...(opts.csrf === false ? {} : { "x-csrf-token": auth.csrf }),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const get = (path: string, auth: Auth): Promise<Response> =>
    req(path, { headers: { cookie: auth.cookie } });

  const listViews = async (auth: Auth, query = ""): Promise<ViewJson[]> => {
    const res = await get(`/api/v1/views${query}`, auth);
    expect(res.status).toBe(200);
    return ((await res.json()) as { views: ViewJson[] }).views;
  };

  const createView = async (
    auth: Auth,
    body: Record<string, unknown>,
  ): Promise<{ status: number; view: ViewJson; raw: string }> => {
    const res = await call("POST", "/api/v1/views", body, auth);
    const raw = await res.text();
    return { status: res.status, view: JSON.parse(raw || "{}") as ViewJson, raw };
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
    const a = await admin.createUser(boot.id, {
      name: "Ada",
      email: "ada@example.com",
      permission: "member",
    });
    const b = await admin.createUser(boot.id, {
      name: "Ben",
      email: "ben@example.com",
      permission: "member",
    });
    const v = await admin.createUser(boot.id, {
      name: "Vic",
      email: "vic@example.com",
      permission: "viewer",
    });
    memberA = a.id;
    memberB = b.id;
    authA = await login(a.token);
    authB = await login(b.token);
    authViewer = await login(v.token);

    const writer = new Writer(pool);
    const actx: WriteContext = { actorId: memberA, scopes: ["read", "write"] };
    privateId = (
      await writer.write(actx, {
        title: PRIVATE_TITLE,
        body: "creator-only",
        visibility: "private",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  // ---- 1. invisibility over HTTP -----------------------------------------

  /** A's view, created once and leaned on by the blocks below. */
  let aViewId: string;

  it("A's saved view carries a private object id and title, and A sees it", async () => {
    const { status, view } = await createView(authA, {
      name: "northwind watch",
      scope: "deal",
      pinned: true,
      config: {
        layout: "board",
        focus: privateId,
        filters: [{ prop: "title", op: "ilike", value: PRIVATE_TITLE }],
      },
    });
    expect(status).toBe(200);
    aViewId = view.id;
    expect(view.pinned).toBe(true);
    expect(view.scope).toBe("deal");

    const mine = await listViews(authA);
    expect(mine.map((x) => x.id)).toEqual([aViewId]);
    expect((mine[0]!.config as { focus?: string }).focus).toBe(privateId);
  });

  it("B's list contains neither the view nor anything inside its config", async () => {
    // B has a view of his own, so "empty list" cannot be what makes this pass.
    const own = await createView(authB, { name: "ben's board", config: { layout: "table" } });
    expect(own.status).toBe(200);

    const res = await get("/api/v1/views", authB);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const views = (JSON.parse(raw) as { views: ViewJson[] }).views;
    expect(views.map((x) => x.name)).toEqual(["ben's board"]);
    expect(views.map((x) => x.id)).not.toContain(aViewId);
    // The privacy invariant is about the CONTENT, not the row: the id and the
    // title of A's private object must not appear anywhere in the payload.
    expect(raw).not.toContain(privateId);
    expect(raw).not.toContain(PRIVATE_TITLE);
    expect(raw).not.toContain("northwind watch");

    // …and no filter revives it: a scope/kind query is still B's own rows.
    expect(await listViews(authB, "?scope=deal")).toEqual([]);
    expect((await listViews(authB, "?kind=database")).map((x) => x.id)).not.toContain(aViewId);
  });

  it("B cannot PATCH or DELETE A's view by id — the same 404 an unknown id gets", async () => {
    const unknown = "11111111-2222-3333-4444-555555555555";
    const patch = await call("PATCH", `/api/v1/views/${aViewId}`, { name: "mine now" }, authB);
    expect(patch.status).toBe(404);
    const patchBody = (await patch.json()) as { code: string; message: string };
    expect(patchBody.code).toBe("not_found");

    const patchUnknown = await call("PATCH", `/api/v1/views/${unknown}`, { name: "x" }, authB);
    expect(patchUnknown.status).toBe(404);
    // Byte-identical to the unknown-id answer: a distinguishable "forbidden"
    // would confirm that a view with that id exists.
    expect((await patchUnknown.json()) as unknown).toEqual(patchBody);

    const del = await call("DELETE", `/api/v1/views/${aViewId}`, undefined, authB);
    expect(del.status).toBe(404);
    const delUnknown = await call("DELETE", `/api/v1/views/${unknown}`, undefined, authB);
    expect(delUnknown.status).toBe(404);
    expect((await del.json()) as unknown).toEqual((await delUnknown.json()) as unknown);

    // and A's row is untouched by any of it
    const mine = await listViews(authA);
    expect(mine.map((x) => x.name)).toEqual(["northwind watch"]);
  });

  it("a client-supplied member_id is ignored, not honoured", async () => {
    // The handler builds the row field by field and never spreads the body, so
    // there is nothing to refuse — the row belongs to its creator. Asserted
    // because "we don't read that field" is exactly the kind of thing a later
    // refactor to `{...body}` silently undoes.
    const { status, view } = await createView(authB, {
      name: "smuggled",
      member_id: memberA,
      memberId: memberA,
      config: {},
    });
    expect(status).toBe(200);
    const su = await brain.connect("superuser");
    try {
      const r = await su.query<{ member_id: string }>(
        "SELECT member_id FROM saved_views WHERE id = $1",
        [view.id],
      );
      expect(r.rows[0]!.member_id).toBe(memberB);
    } finally {
      await su.end();
    }
    expect((await listViews(authA)).map((x) => x.name)).not.toContain("smuggled");
  });

  // ---- 2. the policy itself, no application code in the path -------------

  it("the RLS policy — not the handler — is what refuses cross-member access", async () => {
    const client = await brain.connect("app");
    try {
      // B reads nothing of A's, by id or otherwise.
      const seen = await withActor(client, memberB, () =>
        client.query("SELECT id FROM saved_views WHERE id = $1", [aViewId]),
      );
      expect(seen.rowCount).toBe(0);

      const updated = await withActor(client, memberB, () =>
        client.query("UPDATE saved_views SET name = 'mine now' WHERE id = $1", [aViewId]),
      );
      expect(updated.rowCount).toBe(0);

      const deleted = await withActor(client, memberB, () =>
        client.query("DELETE FROM saved_views WHERE id = $1", [aViewId]),
      );
      expect(deleted.rowCount).toBe(0);

      // The WITH CHECK, both shapes it has to cover:
      // (a) an INSERT stamped with A's member_id — a pinned view planted in A's
      //     sidebar, pointing wherever B chose.
      await expect(
        withActor(client, memberB, () =>
          client.query(
            `INSERT INTO saved_views (member_id, kind, name, config, pinned)
             VALUES ($1, 'database', 'planted', $2::jsonb, true)`,
            [memberA, JSON.stringify({ layout: "table" })],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);

      // (b) an UPDATE that hands one of B's OWN rows to A. USING alone would
      //     allow this: the row B is updating is visibly his.
      const mine = await withActor(client, memberB, () =>
        client.query<{ id: string }>("SELECT id FROM saved_views ORDER BY created_at LIMIT 1"),
      );
      expect(mine.rowCount).toBe(1);
      await expect(
        withActor(client, memberB, () =>
          client.query("UPDATE saved_views SET member_id = $1 WHERE id = $2", [
            memberA,
            mine.rows[0]!.id,
          ]),
        ),
      ).rejects.toThrow(/row-level security/i);

      // A session with no app.actor_id at all sees nothing and writes nothing —
      // the rollback case (an image predating the migration) fails towards
      // unavailability, never disclosure.
      const anon = await client.query("SELECT id FROM saved_views");
      expect(anon.rowCount).toBe(0);

      // and A still holds exactly the row she created.
      const stillHers = await withActor(client, memberA, () =>
        client.query<{ name: string }>("SELECT name FROM saved_views"),
      );
      expect(stillHers.rows.map((r) => r.name)).toEqual(["northwind watch"]);
    } finally {
      await client.end();
    }
  });

  // ---- 3. CSRF on every mutation -----------------------------------------

  it("every mutation is refused without the CSRF header, and does not happen", async () => {
    const before = await listViews(authA);

    const post = await call("POST", "/api/v1/views", { name: "no csrf", config: {} }, authA, {
      csrf: false,
    });
    expect(post.status).toBe(403);
    expect((await post.json()) as { error: string }).toEqual({ error: "csrf check failed" });

    const patch = await call(
      "PATCH",
      `/api/v1/views/${aViewId}`,
      { name: "renamed without csrf" },
      authA,
      { csrf: false },
    );
    expect(patch.status).toBe(403);

    const reorder = await call("POST", "/api/v1/views/reorder", { ids: [aViewId] }, authA, {
      csrf: false,
    });
    expect(reorder.status).toBe(403);

    const del = await call("DELETE", `/api/v1/views/${aViewId}`, undefined, authA, { csrf: false });
    expect(del.status).toBe(403);

    // A refusal that still wrote would be worse than no check at all.
    expect(await listViews(authA)).toEqual(before);

    // A wrong (not merely missing) token is refused too — the double-submit is
    // a comparison, not a presence check.
    const wrong = await req("/api/v1/views", {
      method: "POST",
      headers: {
        cookie: authA.cookie,
        "content-type": "application/json",
        "x-csrf-token": "not-the-cookie",
      },
      body: JSON.stringify({ name: "wrong csrf", config: {} }),
    });
    expect(wrong.status).toBe(403);

    // No session at all: the read is gated too (a saved view names a type and
    // embeds object ids — it is not public chrome).
    const anon = await req("/api/v1/views");
    expect(anon.status).toBe(401);
  });

  // ---- 4. the size cap, measured in bytes --------------------------------

  it("an oversized config is refused on create and on patch", async () => {
    const huge = { blob: "x".repeat(MAX_CONFIG_BYTES + 1_000) };
    const created = await createView(authA, { name: "too big", config: huge });
    expect(created.status).toBe(400);
    const err = JSON.parse(created.raw) as { code: string; message: string };
    expect(err.code).toBe("validation");
    // The server names the cap; this is what keeps the constant above honest.
    expect(err.message).toContain(String(MAX_CONFIG_BYTES));

    const patched = await call("PATCH", `/api/v1/views/${aViewId}`, { config: huge }, authA);
    expect(patched.status).toBe(400);

    // BYTES, not characters: this config's serialized `.length` is comfortably
    // under the cap while its UTF-8 length is roughly double it. A `.length`
    // check would store it.
    const multibyte = { blob: "é".repeat(Math.floor(MAX_CONFIG_BYTES * 0.75)) };
    expect(JSON.stringify(multibyte).length).toBeLessThan(MAX_CONFIG_BYTES);
    expect(Buffer.byteLength(JSON.stringify(multibyte), "utf8")).toBeGreaterThan(MAX_CONFIG_BYTES);
    const wide = await createView(authA, { name: "wide chars", config: multibyte });
    expect(wide.status).toBe(400);

    // A large-but-legal config still stores and round-trips.
    const ok = { blob: "x".repeat(1_000) };
    const fine = await createView(authA, { name: "big but legal", config: ok });
    expect(fine.status).toBe(200);
    expect((fine.view.config as { blob: string }).blob.length).toBe(1_000);

    // config must be an OBJECT — an array today is `config.layout === undefined`
    // tomorrow.
    const arr = await createView(authA, { name: "array config", config: [] });
    expect(arr.status).toBe(400);

    // and A's original row survived every refusal above unchanged.
    const still = await listViews(authA);
    const original = still.find((x) => x.id === aViewId);
    expect((original?.config as { focus?: string }).focus).toBe(privateId);

    await call("DELETE", `/api/v1/views/${fine.view.id}`, undefined, authA);
  });

  // ---- 5. reorder stays inside the caller's own rows ---------------------

  it("a reorder renumbers only the caller's views, and rolls back on a foreign id", async () => {
    // A gets two more rows so there is an order to change.
    const two = await createView(authA, { name: "second", config: {} });
    const three = await createView(authA, { name: "third", config: {} });
    expect(two.status).toBe(200);
    expect(three.status).toBe(200);

    const su = await brain.connect("superuser");
    try {
      const positions = async (member: string): Promise<Array<[string, number]>> => {
        const r = await su.query<{ name: string; position: number }>(
          "SELECT name, position FROM saved_views WHERE member_id = $1 ORDER BY name",
          [member],
        );
        return r.rows.map((x) => [x.name, Number(x.position)]);
      };
      const bBefore = await positions(memberB);
      expect(bBefore.length).toBeGreaterThan(0);

      const order = [three.view.id, two.view.id, aViewId];
      const res = await call("POST", "/api/v1/views/reorder", { ids: order }, authA);
      expect(res.status).toBe(200);
      const returned = ((await res.json()) as { views: ViewJson[] }).views;
      // aViewId is pinned, so it still sorts first in the sidebar — position is
      // what the reorder owns, and it is the caller's requested rank.
      const byId = new Map(returned.map((x) => [x.id, x.position]));
      expect(byId.get(three.view.id)).toBe(0);
      expect(byId.get(two.view.id)).toBe(1);
      expect(byId.get(aViewId)).toBe(2);

      // B's rows are byte-for-byte where they were: a reorder is scoped by the
      // policy, not by the ids the client happened to send.
      expect(await positions(memberB)).toEqual(bBefore);

      // A foreign id in the list: the whole statement matches fewer rows than
      // ids, so the transaction rolls back — no half-renumbered sidebar, and no
      // "which one was it" hint in the answer.
      const bView = (
        await su.query<{ id: string }>("SELECT id FROM saved_views WHERE member_id = $1 LIMIT 1", [
          memberB,
        ])
      ).rows[0]!.id;
      const mixed = await call(
        "POST",
        "/api/v1/views/reorder",
        { ids: [bView, aViewId, two.view.id, three.view.id] },
        authA,
      );
      expect(mixed.status).toBe(404);
      expect(await positions(memberB)).toEqual(bBefore);
      const aAfter = await positions(memberA);
      expect(aAfter).toEqual([
        ["northwind watch", 2],
        ["second", 1],
        ["third", 0],
      ]);
    } finally {
      await su.end();
    }
  });

  it("a duplicate name is refused per member, but two members may share one", async () => {
    const dup = await createView(authA, { name: "second", config: {} });
    expect(dup.status).toBe(400);
    // The collision is A's OWN row; the same name under a different scope, or
    // under another member, is a different view entirely.
    const scoped = await createView(authA, { name: "second", scope: "deal", config: {} });
    expect(scoped.status).toBe(200);
    const bSame = await createView(authB, { name: "second", config: {} });
    expect(bSame.status).toBe(200);
  });

  it("a viewer saves and pins their own view (memberRoute, not writeRoute)", async () => {
    // Deliberate: the `write` scope is authority over BRAIN CONTENT, and a
    // saved view is the member's own chrome. A viewer refused here would have a
    // broken read experience, not a tighter box.
    const made = await createView(authViewer, {
      name: "viewer's shelf",
      config: { layout: "gallery" },
    });
    expect(made.status).toBe(200);
    const pinned = await call(
      "PATCH",
      `/api/v1/views/${made.view.id}`,
      { pinned: true },
      authViewer,
    );
    expect(pinned.status).toBe(200);
    expect(((await pinned.json()) as ViewJson).pinned).toBe(true);

    // …and the viewer's chrome is as invisible to A as anyone else's.
    expect((await listViews(authA)).map((x) => x.name)).not.toContain("viewer's shelf");
  });
});
