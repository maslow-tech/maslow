import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The workspace-UI write path over the dashboard API (p1-t3). These routes are
 * an EXTENSION of the shipped POST/PATCH/DELETE /api/v1/objects — the older
 * behaviour is covered by dashboard-writes.integration.test.ts and must keep
 * passing unchanged. What this file pins:
 *
 *  - the ONE gate: every new route is unreachable without the CSRF header, and
 *    a revoked account is refused even though its session cookie is valid for
 *    a year (writeRoute re-reads scopes AND status per request);
 *  - idempotent create: the same idempotencyKey replayed makes ONE object, and
 *    a different member's identical key is NOT a window into the first
 *    member's result;
 *  - field-granular PATCH: `baseVersion` and the legacy `version` both work, a
 *    props null deletes THAT key and leaves its siblings alone;
 *  - the 409 carries the RLS-bound `current` snapshot to rebase against, and an
 *    object the caller cannot see is a 404 with no version and no title;
 *  - the live-room guard: a body/title patch of a room-held object is refused
 *    409 open_in_editor, while props/links/visibility patches sail through —
 *    and the guard never reveals a private object to someone who can't see it;
 *  - link edits: idempotent, versionless, and indistinguishable from "no such
 *    object" when an endpoint is invisible to the caller.
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

describe("dashboard workspace write path", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let admin: Admin;
  let ownerId: string;
  let ownerToken: string;
  let memberToken: string;
  let otherToken: string;
  let viewerToken: string;

  /** The phase-2 seam, driven by hand: phase 1 ships with it empty. */
  const liveRooms = new Set<string>();

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

  const create = async (
    body: unknown,
    auth: { cookie: string; csrf: string },
  ): Promise<{ id: string; version: number }> => {
    const res = await call("POST", "/api/v1/objects", body, auth);
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; version: number };
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: {
        sessionSecret: SECRET,
        secureCookies: false,
        liveRooms: { has: (id: string) => liveRooms.has(id) },
      },
    });
    admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    ownerId = boot.id;
    ownerToken = boot.token;
    memberToken = (
      await admin.createUser(ownerId, {
        name: "Member",
        email: "member@example.com",
        permission: "member",
      })
    ).token;
    otherToken = (
      await admin.createUser(ownerId, {
        name: "Other",
        email: "other@example.com",
        permission: "member",
      })
    ).token;
    viewerToken = (
      await admin.createUser(ownerId, {
        name: "Viewer",
        email: "viewer@example.com",
        permission: "viewer",
      })
    ).token;

    // Props only exist on a TYPED object, so the field-granular props cases
    // need a real type with real columns.
    const exec = new SchemaExecutor(ownerClient);
    const t = await exec.defineType({ name: "card" }, ownerId);
    await exec.addProperty({ typeId: t.typeId, name: "keep", kind: "text" }, ownerId);
    await exec.addProperty({ typeId: t.typeId, name: "gone", kind: "text" }, ownerId);
    await exec.addProperty({ typeId: t.typeId, name: "status", kind: "text" }, ownerId);
  }, 180_000);

  afterAll(async () => {
    liveRooms.clear();
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  // ---- the one gate ------------------------------------------------------

  it("every new route is unreachable without the CSRF header", async () => {
    const auth = await login(memberToken);
    const { id } = await create({ title: "csrf target" }, auth);
    const noCsrf = (method: string, path: string, body: unknown) =>
      req(path, {
        method,
        headers: { cookie: auth.cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect(
      (await noCsrf("POST", `/api/v1/objects/${id}/links`, { to: id, rel: "mentions" })).status,
    ).toBe(403);
    expect(
      (await noCsrf("DELETE", `/api/v1/objects/${id}/links`, { to: id, rel: "mentions" })).status,
    ).toBe(403);
    expect((await noCsrf("PATCH", `/api/v1/objects/${id}`, { baseVersion: 1 })).status).toBe(403);
  });

  it("a revoked member loses write access on the NEXT request, not at cookie expiry", async () => {
    const owner = await login(ownerToken);
    const doomed = await admin.createUser(ownerId, {
      name: "Doomed",
      email: "doomed@example.com",
      permission: "member",
    });
    const auth = await login(doomed.token);
    // Writes fine while active.
    const ok = await call("POST", "/api/v1/objects", { title: "while active" }, auth);
    expect(ok.status).toBe(200);

    await call("POST", `/api/v1/admin/members/${doomed.id}/revoke`, {}, owner);

    // Same cookie, same CSRF token, one request later.
    const after = await call("POST", "/api/v1/objects", { title: "after revoke" }, auth);
    expect(after.status).not.toBe(200);
    expect([401, 403]).toContain(after.status);
  });

  // ---- idempotent create -------------------------------------------------

  it("a replayed idempotencyKey returns the original create and makes ONE object", async () => {
    const auth = await login(memberToken);
    const key = `create-${Date.now()}-a`;
    const first = await create({ title: "only once", idempotencyKey: key }, auth);
    const second = await create({ title: "only once", idempotencyKey: key }, auth);
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version);

    // Count on an owner connection under the txn-local DR escape: since 0057
    // an actor-less brain_app query (and a bare brain_owner one) sees NO rows,
    // so a plain pool.query here would count 0 no matter what the write did.
    const owner = await brain.connect("owner");
    try {
      await owner.query("BEGIN READ ONLY");
      await owner.query("SET LOCAL app.fs_dr = 'on'");
      const { rows } = await owner.query<{ n: string }>(
        "SELECT count(*) AS n FROM objects WHERE title = $1",
        ["only once"],
      );
      await owner.query("COMMIT");
      expect(Number(rows[0]!.n)).toBe(1);
    } finally {
      await owner.end();
    }
  });

  it("another member's identical key is a MISS, not a window into the first result", async () => {
    const mine = await login(memberToken);
    const theirs = await login(otherToken);
    const key = `shared-key-${Date.now()}`;
    const first = await create({ title: "mine", idempotencyKey: key }, mine);
    const second = await create({ title: "theirs", idempotencyKey: key }, theirs);
    expect(second.id).not.toBe(first.id);
  });

  it("rejects an unusable idempotencyKey rather than putting it in a primary key", async () => {
    const auth = await login(memberToken);
    const res = await call(
      "POST",
      "/api/v1/objects",
      { title: "x", idempotencyKey: "k".repeat(500) },
      auth,
    );
    expect(res.status).toBe(400);
  });

  // ---- field-granular PATCH ---------------------------------------------

  it("accepts baseVersion, and keeps the legacy `version` field working", async () => {
    const auth = await login(memberToken);
    const a = await create({ title: "base" }, auth);
    const viaBase = await call(
      "PATCH",
      `/api/v1/objects/${a.id}`,
      { baseVersion: a.version, title: "base 2" },
      auth,
    );
    expect(viaBase.status).toBe(200);
    const v2 = ((await viaBase.json()) as { version: number }).version;

    const viaLegacy = await call(
      "PATCH",
      `/api/v1/objects/${a.id}`,
      { version: v2, title: "base 3" },
      auth,
    );
    expect(viaLegacy.status).toBe(200);
  });

  it("a null prop deletes THAT key and leaves its siblings untouched", async () => {
    const auth = await login(memberToken);
    const { id, version } = await create(
      { type: "card", title: "props", props: { keep: "yes", gone: "no" } },
      auth,
    );
    const patched = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: version, props: { gone: null } },
      auth,
    );
    expect(patched.status).toBe(200);
    const obj = (await (await call("GET", `/api/v1/objects/${id}`, undefined, auth)).json()) as {
      props?: Record<string, unknown>;
    };
    // `gone` was cleared (the ext column reads back null); `keep` — which this
    // patch never mentioned — is byte-identical. Sending the whole props object
    // back instead would have reverted a concurrent editor's change to `keep`.
    expect(obj.props?.keep).toBe("yes");
    expect(obj.props?.gone ?? null).toBeNull();
  });

  it("refuses link edits on the field patch — edges have their own routes", async () => {
    const auth = await login(memberToken);
    const a = await create({ title: "no inline links" }, auth);
    const b = await create({ title: "target" }, auth);
    const res = await call(
      "PATCH",
      `/api/v1/objects/${a.id}`,
      { baseVersion: a.version, links: [{ rel: "mentions", to: b.id }] },
      auth,
    );
    expect(res.status).toBe(400);
  });

  // ---- conflict + not-found ---------------------------------------------

  it("a lost CAS returns 409 with the current snapshot to rebase against", async () => {
    const auth = await login(memberToken);
    const { id, version } = await create({ title: "rebase me", body: "v1" }, auth);
    expect(
      (await call("PATCH", `/api/v1/objects/${id}`, { baseVersion: version, body: "winner" }, auth))
        .status,
    ).toBe(200);

    const stale = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: version, body: "loser" },
      auth,
    );
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      code: string;
      currentVersion: number;
      current: { title: string | null; body: string | null; actor_name: string | null };
    };
    expect(body.code).toBe("conflict");
    expect(body.currentVersion).toBe(version + 1);
    expect(body.current.body).toBe("winner");
    expect(body.current.title).toBe("rebase me");
  });

  it("an object the caller cannot see is a 404 carrying no version and no title", async () => {
    const owner = await login(ownerToken);
    const { id, version } = await create({ title: "owner private", visibility: "private" }, owner);
    const auth = await login(memberToken);
    const res = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: version, title: "peek" },
      auth,
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    // A 409 (with a version) would confirm both existence and rate of change.
    expect(text).not.toContain("owner private");
    expect(text).not.toContain("current_version");
    expect(text).not.toContain("currentVersion");
  });

  it("DELETE of an invisible object is 404, never 403 (a 403 confirms the id)", async () => {
    const owner = await login(ownerToken);
    const { id } = await create({ title: "owner private 2", visibility: "private" }, owner);
    const auth = await login(memberToken);
    const res = await call("DELETE", `/api/v1/objects/${id}`, undefined, auth);
    expect(res.status).toBe(404);
  });

  // ---- the live-room guard (phase-2 rail, inert in phase 1) --------------

  it("phase 1 has no rooms, so the guard is inert", async () => {
    const auth = await login(memberToken);
    const { id, version } = await create({ title: "no room" }, auth);
    expect(liveRooms.size).toBe(0);
    const res = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: version, body: "typed offline" },
      auth,
    );
    expect(res.status).toBe(200);
  });

  it("a body/title patch of a room-held object is refused 409 open_in_editor", async () => {
    const auth = await login(memberToken);
    const { id, version } = await create({ title: "in the editor", body: "v1" }, auth);
    liveRooms.add(id);
    try {
      for (const patch of [{ body: "curl wins" }, { title: "curl wins" }]) {
        const res = await call(
          "PATCH",
          `/api/v1/objects/${id}`,
          { baseVersion: version, ...patch },
          auth,
        );
        expect(res.status).toBe(409);
        expect(((await res.json()) as { reason?: string }).reason).toBe("open_in_editor");
      }
    } finally {
      liveRooms.delete(id);
    }
  });

  it("props, visibility and link patches are never blocked by a live room", async () => {
    const auth = await login(memberToken);
    const a = await create({ type: "card", title: "boarded" }, auth);
    const b = await create({ title: "card target" }, auth);
    liveRooms.add(a.id);
    try {
      const props = await call(
        "PATCH",
        `/api/v1/objects/${a.id}`,
        { baseVersion: a.version, props: { status: "doing" } },
        auth,
      );
      expect(props.status).toBe(200);
      const v = ((await props.json()) as { version: number }).version;

      const vis = await call(
        "PATCH",
        `/api/v1/objects/${a.id}`,
        { baseVersion: v, visibility: "private" },
        auth,
      );
      expect(vis.status).toBe(200);

      const link = await call(
        "POST",
        `/api/v1/objects/${a.id}/links`,
        { to: b.id, rel: "mentions" },
        auth,
      );
      expect(link.status).toBe(200);
    } finally {
      liveRooms.delete(a.id);
    }
  });

  it("the room guard never tells a stranger that a private object exists", async () => {
    const owner = await login(ownerToken);
    const { id, version } = await create(
      { title: "private and open", visibility: "private" },
      owner,
    );
    liveRooms.add(id);
    try {
      const auth = await login(memberToken);
      const res = await call(
        "PATCH",
        `/api/v1/objects/${id}`,
        { baseVersion: version, body: "probe" },
        auth,
      );
      // 404 — NOT the 409 that would confirm someone is editing it right now.
      expect(res.status).toBe(404);
    } finally {
      liveRooms.delete(id);
    }
  });

  // ---- link edits --------------------------------------------------------

  it("links are versionless and idempotent — a replay returns the same edge", async () => {
    const auth = await login(memberToken);
    const a = await create({ title: "edge from" }, auth);
    const b = await create({ title: "edge to" }, auth);
    const key = `link-${Date.now()}`;

    const first = await call(
      "POST",
      `/api/v1/objects/${a.id}/links`,
      { to: b.id, rel: "mentions", idempotencyKey: key },
      auth,
    );
    expect(first.status).toBe(200);
    const second = await call(
      "POST",
      `/api/v1/objects/${a.id}/links`,
      { to: b.id, rel: "mentions", idempotencyKey: key },
      auth,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());

    // The edge write does not bump the version — that is why it can never 409.
    const obj = (await (await call("GET", `/api/v1/objects/${a.id}`, undefined, auth)).json()) as {
      version: number;
    };
    expect(Number(obj.version)).toBe(a.version);

    const removed = await call(
      "DELETE",
      `/api/v1/objects/${a.id}/links`,
      { to: b.id, rel: "mentions" },
      auth,
    );
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { removed: boolean }).removed).toBe(true);
  });

  it("linking to an object the member cannot see is refused, and reads as absent", async () => {
    const owner = await login(ownerToken);
    const hidden = await create({ title: "hidden target", visibility: "private" }, owner);
    const auth = await login(memberToken);
    const mine = await create({ title: "my source" }, auth);
    const res = await call(
      "POST",
      `/api/v1/objects/${mine.id}/links`,
      { to: hidden.id, rel: "mentions" },
      auth,
    );
    // The Writer's endpoint probe runs under RLS, so a private object is
    // indistinguishable from one that was never created — that is the property
    // that matters. It answers 400 ("the target object does not exist") rather
    // than 404 because it is a validation refusal, and that is shipped
    // behaviour shared with the MCP `edit` tool; it is NOT this route's to
    // change. What must hold is that no edge was made and nothing leaked.
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("hidden target");

    // Counted under the DR escape: since 0057 the actor-less pool sees no
    // edges rows at all, so a plain pool.query would answer 0 even if the
    // refused link HAD landed.
    const ownerConn = await brain.connect("owner");
    try {
      await ownerConn.query("BEGIN READ ONLY");
      await ownerConn.query("SET LOCAL app.fs_dr = 'on'");
      const edges = await ownerConn.query("SELECT 1 FROM edges WHERE from_id = $1 AND to_id = $2", [
        mine.id,
        hidden.id,
      ]);
      await ownerConn.query("COMMIT");
      expect(edges.rowCount).toBe(0);
    } finally {
      await ownerConn.end();
    }
  });

  it("a link route without `to` or `rel` is a 400", async () => {
    const auth = await login(memberToken);
    const a = await create({ title: "bad link args" }, auth);
    expect(
      (await call("POST", `/api/v1/objects/${a.id}/links`, { rel: "mentions" }, auth)).status,
    ).toBe(400);
    expect((await call("POST", `/api/v1/objects/${a.id}/links`, { to: a.id }, auth)).status).toBe(
      400,
    );
  });

  it("a viewer cannot link or unlink", async () => {
    const owner = await login(ownerToken);
    const a = await create({ title: "viewer link source" }, owner);
    const b = await create({ title: "viewer link target" }, owner);
    const auth = await login(viewerToken);
    const res = await call(
      "POST",
      `/api/v1/objects/${a.id}/links`,
      { to: b.id, rel: "mentions" },
      auth,
    );
    expect(res.status).toBe(403);
  });
});
