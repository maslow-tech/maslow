import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin, parseOrigin } from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The workspace write path, from the OUTSIDE — the properties a human typing in
 * the editor gets to rely on. Everything here is asserted over the HTTP surface
 * with real cookies against a real brain; nothing reaches into the Writer.
 *
 * The contract this pins ("exactly one authoritative writer",
 * "refusals that teach"):
 *
 *  - TWO WRITERS, ONE WINNER. Two PATCHes racing on the same baseVersion:
 *    exactly one 200 and one 409 — never two 200s (a lost update, the bug the
 *    whole CAS exists to prevent) and never two 409s (a deadlock the user reads
 *    as "the app ate my edit"). The 409 hands the loser the winner's title and
 *    body so the UI can rebase without making the user retype, and after the
 *    rebase the history shows BOTH sides' text: the winner's as a durable
 *    revision, the loser's as the head.
 *  - A 404 IS A 404. An object private to another member answers 404 with no
 *    version and no title in the body. A 409 there would leak the object's
 *    existence AND its rate of change, and the title would leak its content.
 *  - THE GATE HOLDS FOR EVERYONE. Every mutation is 403 without a matching
 *    x-csrf-token, the owner included — the owner is the account worth CSRFing.
 *    A viewer is 403 on all of them.
 *  - RETRIES ARE FREE. A replayed create makes ONE object and returns the same
 *    id; a replayed link makes ONE edge (counted in `edges` directly, because
 *    the response alone cannot tell a dedupe from a second write).
 *  - AUTHORIZATION IS THE DB, NOT THE COOKIE. Narrowing a member's scopes takes
 *    effect on the very NEXT request, not at cookie expiry a year later.
 *  - PROPS PATCH, NOT REPLACE. A null deletes the named key only, so two people
 *    editing different fields of the same card do not revert each other.
 *  - THE AUDIT SURVIVES. Every dashboard write is attributed to the member with
 *    reason "dashboard" and carries the per-request origin token the phase-2
 *    collab bridge uses to recognise its own flushes.
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

type Auth = { cookie: string; csrf: string };

describe("workspace write path", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let admin: Admin;
  let ownerId: string;
  let ownerToken: string;
  let memberId: string;
  let memberToken: string;
  let otherToken: string;
  let viewerToken: string;

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

  const call = (method: string, path: string, body: unknown, auth: Auth): Promise<Response> =>
    req(path, {
      method,
      headers: {
        cookie: auth.cookie,
        "content-type": "application/json",
        "x-csrf-token": auth.csrf,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const create = async (body: unknown, auth: Auth): Promise<{ id: string; version: number }> => {
    const res = await call("POST", "/api/v1/objects", body, auth);
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; version: number };
  };

  const get = async (id: string, auth: Auth): Promise<Record<string, unknown>> => {
    const res = await call("GET", `/api/v1/objects/${id}`, undefined, auth);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  /**
   * A count the RLS of 0057 cannot blind: since tag governance an actor-less
   * brain_app query (and a bare brain_owner one) sees NO objects/edges rows,
   * so `pool.query("SELECT count(*)…")` answers 0 no matter what a write did.
   * Verification counts run on an owner connection under the txn-local DR
   * escape, exactly as the export path does.
   */
  const countAsDr = async (sql: string, params: unknown[]): Promise<number> => {
    const owner = await brain.connect("owner");
    try {
      await owner.query("BEGIN READ ONLY");
      await owner.query("SET LOCAL app.fs_dr = 'on'");
      const { rows } = await owner.query<{ n: string }>(sql, params);
      await owner.query("COMMIT");
      return Number(rows[0]!.n);
    } finally {
      await owner.end();
    }
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
    admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    ownerId = boot.id;
    ownerToken = boot.token;
    const member = await admin.createUser(ownerId, {
      name: "Member",
      email: "member@example.com",
      permission: "member",
    });
    memberId = member.id;
    memberToken = member.token;
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

    // Props only exist on a TYPED object, so the props cases need a real type
    // with real columns.
    const exec = new SchemaExecutor(ownerClient);
    const t = await exec.defineType({ name: "card" }, ownerId);
    await exec.addProperty({ typeId: t.typeId, name: "keep", kind: "text" }, ownerId);
    await exec.addProperty({ typeId: t.typeId, name: "gone", kind: "text" }, ownerId);
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  // ---- two writers, one winner -------------------------------------------

  it("two PATCHes on the same baseVersion: exactly one 200 and one 409", async () => {
    const auth = await login(memberToken);
    const { id, version } = await create({ title: "race", body: "seed" }, auth);

    // Fired together, not sequenced: the Writer takes a FOR UPDATE on the row,
    // so the loser blocks and then re-reads a bumped version. Sequencing them
    // would prove nothing about the case that actually happens — two people
    // hitting save at once.
    const [a, b] = await Promise.all([
      call("PATCH", `/api/v1/objects/${id}`, { baseVersion: version, body: "left" }, auth),
      call("PATCH", `/api/v1/objects/${id}`, { baseVersion: version, body: "right" }, auth),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    const won = (await winner.json()) as { version: number };
    expect(won.version).toBe(version + 1);

    // The 409 carries what the UI needs to rebase: whose text is on the row
    // now, and the version to send back.
    const conflict = (await loser.json()) as {
      code: string;
      currentVersion: number;
      current: { title: string | null; body: string | null };
    };
    expect(conflict.code).toBe("conflict");
    expect(conflict.currentVersion).toBe(version + 1);
    expect(conflict.current.title).toBe("race");
    expect(["left", "right"]).toContain(conflict.current.body);

    // Rebase the way the client does: keep the winner's text, add ours.
    const winningText = conflict.current.body as string;
    const losingText = winningText === "left" ? "right" : "left";
    const rebased = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: conflict.currentVersion, body: `${winningText}\n${losingText}` },
      auth,
    );
    expect(rebased.status).toBe(200);

    // Neither side's text vanished: the winner's is a durable revision in the
    // version log, and the head holds both.
    const hist = (await (
      await call("GET", `/api/v1/objects/${id}/history`, undefined, auth)
    ).json()) as {
      versions: Array<{ version: string; snapshot: { title: string | null; body: string | null } }>;
    };
    const snapshots = hist.versions.map((v) => v.snapshot.body);
    expect(snapshots).toContain(winningText);
    const head = await get(id, auth);
    expect(String(head.body)).toContain(winningText);
    expect(String(head.body)).toContain(losingText);
  });

  // ---- a 404 is a 404 -----------------------------------------------------

  it("patching another member's private object is 404 — no version, no title", async () => {
    const theirs = await login(otherToken);
    const { id, version } = await create(
      { title: "other member secret", body: "secret body", visibility: "private" },
      theirs,
    );

    const auth = await login(memberToken);
    const res = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: version, title: "peek" },
      auth,
    );
    // 409 would confirm the object exists AND how fast it is changing; the
    // title would hand over its content.
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("other member secret");
    expect(text).not.toContain("secret body");
    expect(text).not.toContain("currentVersion");
    expect(text).not.toContain("current_version");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.currentVersion).toBeUndefined();
    expect(parsed.current).toBeUndefined();
    expect(parsed.title).toBeUndefined();
  });

  // ---- the gate holds for everyone ---------------------------------------

  it("every mutation is 403 without a matching csrf token — the owner included", async () => {
    const auth = await login(ownerToken);
    const a = await create({ title: "csrf source" }, auth);
    const b = await create({ title: "csrf target" }, auth);

    const mutations: Array<[string, string, unknown]> = [
      ["POST", "/api/v1/objects", { title: "no csrf" }],
      ["PATCH", `/api/v1/objects/${a.id}`, { baseVersion: a.version, title: "no csrf" }],
      ["POST", `/api/v1/objects/${a.id}/links`, { to: b.id, rel: "mentions" }],
      ["DELETE", `/api/v1/objects/${a.id}/links`, { to: b.id, rel: "mentions" }],
    ];

    for (const [method, path, payload] of mutations) {
      const missing = await req(path, {
        method,
        headers: { cookie: auth.cookie, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(missing.status, `${method} ${path} with no csrf header`).toBe(403);

      // A mismatched token is exactly as dead as a missing one — an attacker
      // who can guess the shape must not get a different answer.
      const mismatched = await req(path, {
        method,
        headers: {
          cookie: auth.cookie,
          "content-type": "application/json",
          "x-csrf-token": "n".repeat(auth.csrf.length),
        },
        body: JSON.stringify(payload),
      });
      expect(mismatched.status, `${method} ${path} with a wrong csrf header`).toBe(403);
    }

    // The owner's own object is untouched by any of it.
    const still = await get(a.id, auth);
    expect(still.title).toBe("csrf source");
  });

  it("a viewer is 403 on create, patch, link and unlink", async () => {
    const owner = await login(ownerToken);
    const a = await create({ title: "viewer source" }, owner);
    const b = await create({ title: "viewer target" }, owner);

    const viewer = await login(viewerToken);
    expect((await call("POST", "/api/v1/objects", { title: "viewer create" }, viewer)).status).toBe(
      403,
    );
    expect(
      (
        await call(
          "PATCH",
          `/api/v1/objects/${a.id}`,
          { baseVersion: a.version, title: "viewer edit" },
          viewer,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("POST", `/api/v1/objects/${a.id}/links`, { to: b.id, rel: "mentions" }, viewer))
        .status,
    ).toBe(403);
    expect(
      (await call("DELETE", `/api/v1/objects/${a.id}/links`, { to: b.id, rel: "mentions" }, viewer))
        .status,
    ).toBe(403);
  });

  // ---- retries are free ---------------------------------------------------

  it("a replayed create makes ONE object and returns the same id twice", async () => {
    const auth = await login(memberToken);
    const key = `ws-create-${Date.now()}`;
    const title = `replayed create ${key}`;
    const first = await create({ title, idempotencyKey: key }, auth);
    const second = await create({ title, idempotencyKey: key }, auth);
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version);

    // The response alone cannot tell a dedupe from a second write — count.
    expect(await countAsDr("SELECT count(*) AS n FROM objects WHERE title = $1", [title])).toBe(1);
  });

  it("a replayed link makes ONE edge", async () => {
    const auth = await login(memberToken);
    const from = await create({ title: "replayed link from" }, auth);
    const to = await create({ title: "replayed link to" }, auth);
    const key = `ws-link-${Date.now()}`;

    const first = await call(
      "POST",
      `/api/v1/objects/${from.id}/links`,
      { to: to.id, rel: "mentions", idempotencyKey: key },
      auth,
    );
    expect(first.status).toBe(200);
    const second = await call(
      "POST",
      `/api/v1/objects/${from.id}/links`,
      { to: to.id, rel: "mentions", idempotencyKey: key },
      auth,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());

    expect(
      await countAsDr(
        "SELECT count(*) AS n FROM edges WHERE from_id = $1 AND to_id = $2 AND rel = $3",
        [from.id, to.id, "mentions"],
      ),
    ).toBe(1);
  });

  // ---- authorization is the DB, not the cookie ---------------------------

  it("a member demoted mid-session is refused on the very next request", async () => {
    // Its OWN account: this test narrows scopes in the DB, and doing that to
    // the shared member would leak into every test that runs after it if an
    // assertion above the restore ever fails.
    const demoted = await admin.createUser(ownerId, {
      name: "Demoted",
      email: "demoted@example.com",
      permission: "member",
    });
    const auth = await login(demoted.token);
    const before = await call("POST", "/api/v1/objects", { title: "while a writer" }, auth);
    expect(before.status).toBe(200);
    const mine = (await before.json()) as { id: string; version: number };

    // Narrow the scopes in the DB and change NOTHING about the session: the
    // cookie is good for a year, so if authorization came from the cookie this
    // write would land.
    await ownerClient.query("UPDATE accounts SET scopes = ARRAY['read']::text[] WHERE id = $1", [
      demoted.id,
    ]);

    const after = await call("POST", "/api/v1/objects", { title: "after demotion" }, auth);
    expect(after.status).toBe(403);
    const patchAfter = await call(
      "PATCH",
      `/api/v1/objects/${mine.id}`,
      { baseVersion: mine.version, title: "after demotion" },
      auth,
    );
    expect(patchAfter.status).toBe(403);

    // Refused, not merely reported as refused. (Counted via the DR escape:
    // the actor-less pool count would answer 0 even if the write HAD landed.)
    expect(
      await countAsDr("SELECT count(*) AS n FROM objects WHERE title = $1", ["after demotion"]),
    ).toBe(0);
  });

  // ---- props patch, not replace ------------------------------------------

  it("a null prop deletes only the named key", async () => {
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

    const obj = (await get(id, auth)) as { props?: Record<string, unknown> };
    // `keep` was never mentioned by the patch, so it is byte-identical — the
    // property that lets two people edit different fields of the same card.
    expect(obj.props?.keep).toBe("yes");
    expect(obj.props?.gone ?? null).toBeNull();
  });

  // ---- the audit survives -------------------------------------------------

  it("history attributes the write to the member, reason dashboard, with an origin token", async () => {
    const auth = await login(memberToken);
    const { id, version } = await create({ title: "audited" }, auth);
    const patched = await call(
      "PATCH",
      `/api/v1/objects/${id}`,
      { baseVersion: version, title: "audited 2" },
      auth,
    );
    expect(patched.status).toBe(200);

    const hist = (await (
      await call("GET", `/api/v1/objects/${id}/history`, undefined, auth)
    ).json()) as {
      events: Array<{
        actor: string | null;
        actor_name: string | null;
        kind: string;
        payload: Record<string, unknown> | null;
      }>;
    };

    // The origin token rides the SAME reason string as a `dashboard#<token>`
    // suffix (events has no origin column and 0026's triggers are shipped), so
    // parseOrigin is the only supported way to read either half back — a bare
    // `reason === "dashboard"` comparison does not match.
    const dashboardEvents = hist.events.filter(
      (e) =>
        typeof e.payload?.reason === "string" &&
        parseOrigin(e.payload.reason as string).reason === "dashboard",
    );
    expect(dashboardEvents.length).toBeGreaterThan(0);
    for (const e of dashboardEvents) {
      expect(e.actor).toBe(memberId);
      expect(e.actor_name).toBe("Member");
      const { origin } = parseOrigin((e.payload as { reason: string }).reason);
      expect(origin).toMatch(/^[0-9a-f]{16}$/);
    }
    // Each REQUEST mints its own token — the create and the patch must not
    // share one, or the collab bridge cannot tell two writes apart. (Events
    // from the same request legitimately share a token, so this counts
    // distinct tokens rather than demanding one per event.)
    const origins = new Set(
      dashboardEvents.map((e) => parseOrigin((e.payload as { reason: string }).reason).origin),
    );
    expect(origins.size).toBeGreaterThanOrEqual(2);
  });
});
