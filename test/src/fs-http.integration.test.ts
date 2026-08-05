import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";
import { FS_MAX_FILE_BYTES } from "@brain/schema";

/**
 * Smoke test for the path-addressed fs HTTP surface:
 * every route responds and maps errors the way the design says
 * (uniform 404 for the invisible, 413 for the cap, 403 for scope). The full
 * three-surface matrix (bash + HTTP + dashboard, RLS proofs, quota) lands in
 * fs.integration.test.ts.
 */

// A real 1x1 PNG (binary, has NUL/high bytes — a good round-trip probe).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

const SECRET = "test-session-secret-please-change";

function cookieValue(res: Response, name: string): string | undefined {
  const raw =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const line of raw) {
    const m = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(line);
    if (m) return m[1];
  }
  return undefined;
}

describe("fs HTTP surface", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let ownerToken: string;
  let ownerId: string;
  let viewerToken: string;
  let bob: { id: string; token: string };
  let carol: { id: string; token: string };

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(path, init));

  const bearer = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });

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
    const boot = await admin.bootstrapOwner({ name: "alice", email: "alice@example.com" });
    ownerToken = boot.token;
    ownerId = boot.id;
    const viewer = await admin.createUser(boot.id, {
      name: "viewer vic",
      email: "vic@example.com",
      permission: "viewer",
    });
    viewerToken = viewer.token;
    // two plain members: locks are a boundary BETWEEN members, so proving one
    // needs two non-owner accounts (an owner can force past it by design).
    bob = await admin.createUser(boot.id, {
      name: "bob",
      email: "bob@example.com",
      permission: "member",
    });
    carol = await admin.createUser(boot.id, {
      name: "carol",
      email: "carol@example.com",
      permission: "member",
    });
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("PUT writes (implicit mkdir -p) and GET returns identical bytes + headers", async () => {
    const put = await req("/api/v1/fs/file?path=/shared/docs/pixel.png", {
      method: "PUT",
      headers: bearer(ownerToken, { "content-type": "image/png" }),
      body: PNG,
    });
    expect(put.status).toBe(200);
    const meta = (await put.json()) as { path: string; size: number; sha256: string; mime: string };
    expect(meta).toMatchObject({
      path: "/shared/docs/pixel.png",
      size: PNG.length,
      sha256: PNG_SHA,
      mime: "image/png",
    });

    const get = await req("/api/v1/fs/file?path=/shared/docs/pixel.png", {
      headers: bearer(ownerToken),
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(get.headers.get("cache-control")).toBe("private, no-store");
    expect(get.headers.get("content-disposition")).toBe('inline; filename="pixel.png"');
    expect(Buffer.from(await get.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("multipart upload lands the file at the given path", async () => {
    const fd = new FormData();
    fd.append("path", "/shared/uploads/");
    fd.append("file", new File([new Uint8Array(PNG)], "logo.png", { type: "image/png" }));
    const up = await req("/api/v1/fs/upload", {
      method: "POST",
      headers: bearer(ownerToken),
      body: fd,
    });
    expect(up.status).toBe(200);
    const meta = (await up.json()) as { path: string; sha256: string };
    expect(meta.path).toBe("/shared/uploads/logo.png");
    expect(meta.sha256).toBe(PNG_SHA);
  });

  it("list returns name/kind/size/mtime/updated_by; mkdir creates dirs", async () => {
    const mk = await req("/api/v1/fs/mkdir", {
      method: "POST",
      headers: bearer(ownerToken, { "content-type": "application/json" }),
      body: JSON.stringify({ path: "/shared/docs/archive" }),
    });
    expect(mk.status).toBe(200);

    const ls = await req("/api/v1/fs/list?path=/shared/docs", { headers: bearer(ownerToken) });
    expect(ls.status).toBe(200);
    const { entries } = (await ls.json()) as {
      entries: { name: string; kind: string; size: number; mtime: string; updated_by: string }[];
    };
    const names = entries.map((e) => `${e.kind}:${e.name}`);
    expect(names).toContain("file:pixel.png");
    expect(names).toContain("dir:archive");
    const pixel = entries.find((e) => e.name === "pixel.png")!;
    expect(pixel.size).toBe(PNG.length);
    expect(new Date(pixel.mtime).getTime()).toBeGreaterThan(0);
    expect(pixel.updated_by).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rename moves the file; delete removes it; both report", async () => {
    const mv = await req("/api/v1/fs/rename", {
      method: "POST",
      headers: bearer(ownerToken, { "content-type": "application/json" }),
      body: JSON.stringify({ from: "/shared/docs/pixel.png", to: "/shared/docs/kept.png" }),
    });
    expect(mv.status).toBe(200);
    expect(
      (await req("/api/v1/fs/file?path=/shared/docs/pixel.png", { headers: bearer(ownerToken) }))
        .status,
    ).toBe(404);
    expect(
      (await req("/api/v1/fs/file?path=/shared/docs/kept.png", { headers: bearer(ownerToken) }))
        .status,
    ).toBe(200);

    const del = await req("/api/v1/fs/delete", {
      method: "POST",
      headers: bearer(ownerToken, { "content-type": "application/json" }),
      body: JSON.stringify({ path: "/shared/docs", recursive: true }),
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { removed: number }).removed).toBeGreaterThanOrEqual(2);
    expect(
      (await req("/api/v1/fs/list?path=/shared/docs", { headers: bearer(ownerToken) })).status,
    ).toBe(404);
  });

  it("a foreign home is a uniform 404 on read AND list (no oracle)", async () => {
    // vic's home exists (createUser companion) — but alice must not see it.
    const file = await req("/api/v1/fs/file?path=/home/viewer-vic/secret.txt", {
      headers: bearer(ownerToken),
    });
    expect(file.status).toBe(404);
    expect(await file.json()).toEqual({ error: "not found" });
    const ls = await req("/api/v1/fs/list?path=/home/viewer-vic", { headers: bearer(ownerToken) });
    expect(ls.status).toBe(404);
    expect(await ls.json()).toEqual({ error: "not found" });
  });

  it("read-scope tokens read but cannot mutate (403 before the store)", async () => {
    const get = await req("/api/v1/fs/file?path=/shared/uploads/logo.png", {
      headers: bearer(viewerToken),
    });
    expect(get.status).toBe(200);
    for (const [method, url, body] of [
      ["PUT", "/api/v1/fs/file?path=/shared/nope.txt", "x"],
      ["POST", "/api/v1/fs/mkdir", JSON.stringify({ path: "/shared/nope" })],
      ["POST", "/api/v1/fs/delete", JSON.stringify({ path: "/shared/uploads/logo.png" })],
    ] as const) {
      const res = await req(url, {
        method,
        headers: bearer(viewerToken, { "content-type": "application/json" }),
        body,
      });
      expect(res.status).toBe(403);
    }
  });

  it("teaches on bad requests: 401 unauthenticated, 400 no path, 413 over-cap", async () => {
    expect((await req("/api/v1/fs/file?path=/shared/x")).status).toBe(401);
    expect((await req("/api/v1/fs/file", { headers: bearer(ownerToken) })).status).toBe(400);
    const big = await req("/api/v1/fs/file?path=/shared/big.bin", {
      method: "PUT",
      headers: bearer(ownerToken),
      body: Buffer.alloc(FS_MAX_FILE_BYTES + 1),
    });
    expect(big.status).toBe(413);
    // scope teaching error (not a 404): a write into another member's home
    const foreign = await req("/api/v1/fs/file?path=/home/viewer-vic/x.txt", {
      method: "PUT",
      headers: bearer(ownerToken),
      body: "hi",
    });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: string }).error).toContain("only /shared");
  });

  // ---- version control, locks, trash (Task 8) -----------------------------

  const NOTES = "/shared/vc/notes.md";

  const putText = (path: string, body: string, token = ownerToken) =>
    req(`/api/v1/fs/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: bearer(token, { "content-type": "text/markdown" }),
      body,
    });

  const postJson = (url: string, body: unknown, token = ownerToken) =>
    req(url, {
      method: "POST",
      headers: bearer(token, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });

  /**
   * The documented raw-ingestion path is a bare `fetch(url, {method:"PUT",
   * body:"…"})`, and WHATWG fetch sets `content-type: text/plain;charset=UTF-8`
   * on a string body all by itself. That header reaches FsStore.write verbatim,
   * so a media type with a parameter MUST still be recognised as text-ish —
   * otherwise the one path the design documents silently produced no history.
   */
  it("a PUT with fetch's default content-type still gets version history", async () => {
    const p = "/shared/vc/fetch-default.md";
    const url = `/api/v1/fs/file?path=${encodeURIComponent(p)}`;
    // No explicit content-type: Request derives `text/plain;charset=UTF-8`.
    const put1 = await req(url, { method: "PUT", headers: bearer(ownerToken), body: "v1" });
    expect(put1.status).toBe(200);
    // The essence is what the store keeps — the charset parameter is dropped.
    expect(((await put1.json()) as { mime: string }).mime).toBe("text/plain");
    await req(url, { method: "PUT", headers: bearer(ownerToken), body: "v2" });

    const res = await req(`/api/v1/fs/history?path=${encodeURIComponent(p)}`, {
      headers: bearer(ownerToken),
    });
    const { versions } = (await res.json()) as { versions: { version_no: number }[] };
    expect(versions.map((v) => v.version_no)).toEqual([1]);
  });

  it("history lists prior snapshots newest-first; version serves their bytes", async () => {
    await putText(NOTES, "v1");
    await putText(NOTES, "v2");
    await putText(NOTES, "v3");

    const res = await req(`/api/v1/fs/history?path=${encodeURIComponent(NOTES)}`, {
      headers: bearer(ownerToken),
    });
    expect(res.status).toBe(200);
    const { versions } = (await res.json()) as {
      versions: {
        version_no: number;
        reason: string;
        size_bytes: number;
        edited_by: string;
        created_at: string;
      }[];
    };
    expect(versions.map((v) => v.version_no)).toEqual([2, 1]);
    expect(versions[0]!.reason).toBe("overwrite");
    expect(versions[0]!.size_bytes).toBe(2);
    expect(versions[0]!.edited_by).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(versions[0]!.created_at).getTime()).toBeGreaterThan(0);

    const v1 = await req(`/api/v1/fs/version?path=${encodeURIComponent(NOTES)}&v=1`, {
      headers: bearer(ownerToken),
    });
    expect(v1.status).toBe(200);
    expect(v1.headers.get("cache-control")).toBe("private, no-store");
    expect(v1.headers.get("x-content-type-options")).toBe("nosniff");
    expect(v1.headers.get("content-security-policy")).toContain("sandbox");
    expect(await v1.text()).toBe("v1");
    expect(
      await (
        await req(`/api/v1/fs/version?path=${encodeURIComponent(NOTES)}&v=2`, {
          headers: bearer(ownerToken),
        })
      ).text(),
    ).toBe("v2");
  });

  it("restore rolls back to a version and is itself undoable", async () => {
    expect((await postJson("/api/v1/fs/restore", { path: NOTES, version: 1 })).status).toBe(200);
    const back = await req(`/api/v1/fs/file?path=${encodeURIComponent(NOTES)}`, {
      headers: bearer(ownerToken),
    });
    expect(await back.text()).toBe("v1");

    // the replaced bytes were snapshotted, so a version-less restore undoes it
    expect((await postJson("/api/v1/fs/restore", { path: NOTES })).status).toBe(200);
    expect(
      await (
        await req(`/api/v1/fs/file?path=${encodeURIComponent(NOTES)}`, {
          headers: bearer(ownerToken),
        })
      ).text(),
    ).toBe("v3");
  });

  it("lock refuses writes with the ELOCKED teaching error until unlocked", async () => {
    expect((await postJson("/api/v1/fs/lock", { path: NOTES })).status).toBe(200);

    const who = await req(`/api/v1/fs/lock?path=${encodeURIComponent(NOTES)}`, {
      headers: bearer(ownerToken),
    });
    expect(who.status).toBe(200);
    expect((await who.json()) as { locked_by_name: string }).toMatchObject({
      locked_by_name: "alice",
    });

    const blocked = await putText(NOTES, "sneaky");
    expect(blocked.status).toBe(423);
    const err = ((await blocked.json()) as { error: string }).error;
    expect(err).toContain("ELOCKED");
    expect(err).toContain("alice");
    expect((await postJson("/api/v1/fs/restore", { path: NOTES, version: 1 })).status).toBe(423);

    expect((await postJson("/api/v1/fs/unlock", { path: NOTES })).status).toBe(200);
    expect(
      (
        (await (
          await req(`/api/v1/fs/lock?path=${encodeURIComponent(NOTES)}`, {
            headers: bearer(ownerToken),
          })
        ).json()) as { locked_by: string | null }
      ).locked_by,
    ).toBeNull();
    expect((await putText(NOTES, "v4")).status).toBe(200);
  });

  it("delete is recoverable: trash lists it, restore brings the bytes back", async () => {
    await putText("/shared/vc/temp.txt", "bye");
    expect((await postJson("/api/v1/fs/delete", { path: "/shared/vc/temp.txt" })).status).toBe(200);

    const trash = await req("/api/v1/fs/trash?prefix=/shared/vc", { headers: bearer(ownerToken) });
    expect(trash.status).toBe(200);
    const { entries } = (await trash.json()) as {
      entries: {
        path: string;
        size_bytes: number;
        deleted_at: string;
        created_at?: unknown;
        edited_by: string;
      }[];
    };
    const gone = entries.find((e) => e.path === "/shared/vc/temp.txt");
    expect(gone).toBeTruthy();
    expect(gone!.size_bytes).toBe(3);
    // the JSON key is deleted_at (created_at is the internal snapshot column)
    expect(new Date(gone!.deleted_at).getTime()).toBeGreaterThan(0);
    expect(gone!.created_at).toBeUndefined();
    expect(gone!.edited_by).toMatch(/^[0-9a-f-]{36}$/);

    expect((await postJson("/api/v1/fs/restore", { path: "/shared/vc/temp.txt" })).status).toBe(
      200,
    );
    expect(
      await (
        await req("/api/v1/fs/file?path=/shared/vc/temp.txt", { headers: bearer(ownerToken) })
      ).text(),
    ).toBe("bye");
    const after = (await (
      await req("/api/v1/fs/trash?prefix=/shared/vc", { headers: bearer(ownerToken) })
    ).json()) as { entries: { path: string }[] };
    expect(after.entries.map((e) => e.path)).not.toContain("/shared/vc/temp.txt");
  });

  it("read tokens see history/version/trash but cannot restore or lock (403)", async () => {
    expect(
      (
        await req(`/api/v1/fs/history?path=${encodeURIComponent(NOTES)}`, {
          headers: bearer(viewerToken),
        })
      ).status,
    ).toBe(200);
    expect(
      (await req("/api/v1/fs/trash?prefix=/shared", { headers: bearer(viewerToken) })).status,
    ).toBe(200);
    expect(
      (
        await req(`/api/v1/fs/version?path=${encodeURIComponent(NOTES)}&v=1`, {
          headers: bearer(viewerToken),
        })
      ).status,
    ).toBe(200);
    for (const url of ["/api/v1/fs/restore", "/api/v1/fs/lock", "/api/v1/fs/unlock"]) {
      expect((await postJson(url, { path: NOTES }, viewerToken)).status).toBe(403);
    }
  });

  it("teaches on bad version-control requests", async () => {
    expect((await req("/api/v1/fs/history", { headers: bearer(ownerToken) })).status).toBe(400);
    expect(
      (
        await req(`/api/v1/fs/version?path=${encodeURIComponent(NOTES)}`, {
          headers: bearer(ownerToken),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(`/api/v1/fs/version?path=${encodeURIComponent(NOTES)}&v=999`, {
          headers: bearer(ownerToken),
        })
      ).status,
    ).toBe(400);
    expect((await postJson("/api/v1/fs/restore", {})).status).toBe(400);
  });

  // The privacy proof needs REAL rows behind it: asserting "empty" against a
  // path that was never written passes on an empty table and would pass with no
  // RLS at all. So seed bob's home with two versions AND a delete-snapshot,
  // prove bob sees them, then prove the OWNER — the most privileged caller —
  // sees nothing and can restore nothing.
  it("a foreign home's versions and trash are invisible even to the owner", async () => {
    const secret = "/home/bob/secret.md";
    expect((await putText(secret, "draft one", bob.token)).status).toBe(200);
    expect((await putText(secret, "draft two", bob.token)).status).toBe(200);

    const encoded = encodeURIComponent(secret);
    const mine = await req(`/api/v1/fs/history?path=${encoded}`, { headers: bearer(bob.token) });
    expect(mine.status).toBe(200);
    const mineJson = (await mine.json()) as { versions: { version_no: number }[] };
    expect(mineJson.versions.map((v) => v.version_no)).toEqual([1]);
    const mineV1 = await req(`/api/v1/fs/version?path=${encoded}&v=1`, {
      headers: bearer(bob.token),
    });
    expect(mineV1.status).toBe(200);
    expect(await mineV1.text()).toBe("draft one");

    // the owner: history empty (absence, not a 403) and the bytes unreachable
    const foreign = await req(`/api/v1/fs/history?path=${encoded}`, {
      headers: bearer(ownerToken),
    });
    expect(foreign.status).toBe(200);
    expect((await foreign.json()) as { versions: unknown[] }).toEqual({ versions: [] });
    const foreignV1 = await req(`/api/v1/fs/version?path=${encoded}&v=1`, {
      headers: bearer(ownerToken),
    });
    expect(foreignV1.status).not.toBe(200);
    expect(await foreignV1.text()).not.toContain("draft one");

    // a delete-snapshot lands in BOB's trash only
    expect((await postJson("/api/v1/fs/delete", { path: secret }, bob.token)).status).toBe(200);
    const bobTrash = (await (
      await req("/api/v1/fs/trash?prefix=/home/bob", { headers: bearer(bob.token) })
    ).json()) as { entries: { path: string }[] };
    expect(bobTrash.entries.map((e) => e.path)).toContain(secret);
    for (const prefix of ["/home/bob", "/"]) {
      const seen = (await (
        await req(`/api/v1/fs/trash?prefix=${encodeURIComponent(prefix)}`, {
          headers: bearer(ownerToken),
        })
      ).json()) as { entries: { path: string }[] };
      expect(
        seen.entries.map((e) => e.path),
        prefix,
      ).not.toContain(secret);
    }

    // and the owner cannot restore what she cannot see; bob still can
    expect((await postJson("/api/v1/fs/restore", { path: secret })).status).not.toBe(200);
    expect((await postJson("/api/v1/fs/restore", { path: secret }, bob.token)).status).toBe(200);
    expect(
      await (await req(`/api/v1/fs/file?path=${encoded}`, { headers: bearer(bob.token) })).text(),
    ).toBe("draft two");
  });

  it("a lock cannot be stolen: re-locking someone else's lock is refused", async () => {
    const p = "/shared/vc/bob-doc.md";
    expect((await putText(p, "bob's draft", bob.token)).status).toBe(200);
    expect((await postJson("/api/v1/fs/lock", { path: p }, bob.token)).status).toBe(200);

    // carol is refused the unlock — and must not be able to launder it into
    // her own lock (re-lock → unlock), which would erase bob's protection.
    expect((await postJson("/api/v1/fs/unlock", { path: p }, carol.token)).status).toBe(400);
    const steal = await postJson("/api/v1/fs/lock", { path: p }, carol.token);
    expect(steal.status).toBe(400);
    expect(((await steal.json()) as { error: string }).error).toContain("locked by bob");

    // the lock still stands, and still blocks her write
    const who = (await (
      await req(`/api/v1/fs/lock?path=${encodeURIComponent(p)}`, { headers: bearer(carol.token) })
    ).json()) as { locked_by_name: string | null };
    expect(who.locked_by_name).toBe("bob");
    expect((await putText(p, "carol was here", carol.token)).status).toBe(423);

    // the holder re-locking is idempotent; an owner may still take it over
    expect((await postJson("/api/v1/fs/lock", { path: p }, bob.token)).status).toBe(200);
    const takeover = await postJson("/api/v1/fs/lock", { path: p });
    expect(takeover.status).toBe(200);
    expect((await takeover.json()) as { locked_by_name: string }).toMatchObject({
      locked_by_name: "alice",
    });
    expect((await postJson("/api/v1/fs/unlock", { path: p })).status).toBe(200);
  });

  it("owner powers come from the DB role, not the session cookie", async () => {
    const p = "/shared/vc/stale-cookie.md";
    expect((await putText(p, "bob's draft", bob.token)).status).toBe(200);
    expect((await postJson("/api/v1/fs/lock", { path: p }, bob.token)).status).toBe(200);

    // alice signs in while she is still an owner; the cookie's role claim
    // lives for a year, so the force-unlock bit must be re-read per request.
    const s = await login(ownerToken);
    const dashPost = (url: string, body: unknown) =>
      req(url, {
        method: "POST",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await ownerClient.query("UPDATE accounts SET role = 'member' WHERE id = $1", [ownerId]);
    try {
      const stale = await dashPost("/api/v1/files/unlock", { path: p });
      expect(stale.status).toBe(400);
      expect(((await stale.json()) as { error: string }).error).toContain("locked by");
      expect(
        (
          (await (
            await req(`/api/v1/fs/lock?path=${encodeURIComponent(p)}`, {
              headers: bearer(bob.token),
            })
          ).json()) as { locked_by_name: string | null }
        ).locked_by_name,
      ).toBe("bob");
    } finally {
      await ownerClient.query("UPDATE accounts SET role = 'owner' WHERE id = $1", [ownerId]);
    }
    // role restored → the SAME cookie force-unlocks: the bit is the DB's
    expect((await dashPost("/api/v1/files/unlock", { path: p })).status).toBe(200);
  });

  it("trash ?prefix is a path prefix, not a string prefix", async () => {
    await putText("/shared/vc/keep.md", "keep");
    await putText("/shared/vconfidential/leak.md", "leak");
    for (const path of ["/shared/vc/keep.md", "/shared/vconfidential/leak.md"]) {
      expect((await postJson("/api/v1/fs/delete", { path })).status).toBe(200);
    }
    const trashed = async (prefix: string): Promise<string[]> => {
      const res = await req(`/api/v1/fs/trash?prefix=${encodeURIComponent(prefix)}`, {
        headers: bearer(ownerToken),
      });
      expect(res.status, prefix).toBe(200);
      return ((await res.json()) as { entries: { path: string }[] }).entries.map((e) => e.path);
    };
    // a sibling FOLDER whose name merely starts with the prefix is not "under" it
    for (const prefix of ["/shared/vc", "/shared/vc/"]) {
      const paths = await trashed(prefix);
      expect(paths, prefix).toContain("/shared/vc/keep.md");
      expect(paths, prefix).not.toContain("/shared/vconfidential/leak.md");
    }
    // the whole tree still sees both, and a bad prefix teaches like every path
    const all = await trashed("/");
    expect(all).toEqual(
      expect.arrayContaining(["/shared/vc/keep.md", "/shared/vconfidential/leak.md"]),
    );
    expect(
      (await req("/api/v1/fs/trash?prefix=../etc", { headers: bearer(ownerToken) })).status,
    ).toBe(400);
  });

  it("the cookie-authed dashboard mirror speaks the same shapes (names, not uuids)", async () => {
    const s = await login(ownerToken);
    const dashGet = (url: string) => req(url, { headers: { cookie: s.cookie } });
    const dashPost = (url: string, body: unknown) =>
      req(url, {
        method: "POST",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const hist = await dashGet(`/api/v1/files/history?path=${encodeURIComponent(NOTES)}`);
    expect(hist.status).toBe(200);
    const { versions } = (await hist.json()) as { versions: { edited_by: string | null }[] };
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]!.edited_by).toBe("alice");

    const v1 = await dashGet(`/api/v1/files/version?path=${encodeURIComponent(NOTES)}&v=1`);
    expect(v1.status).toBe(200);
    expect(await v1.text()).toBe("v1");

    expect((await dashPost("/api/v1/files/lock", { path: NOTES })).status).toBe(200);
    const locked = await dashPost("/api/v1/files/delete", { path: NOTES });
    expect(locked.status).toBe(423);
    expect(((await locked.json()) as { error: string }).error).toContain("ELOCKED");
    expect((await dashPost("/api/v1/files/unlock", { path: NOTES })).status).toBe(200);

    expect((await dashGet("/api/v1/files/trash?prefix=/shared")).status).toBe(200);
    expect((await dashPost("/api/v1/files/restore", { path: NOTES, version: 1 })).status).toBe(200);
  });

  it("the dashboard listing carries every row's lock (the file manager never N+1s)", async () => {
    // one folder, one locked file, one free file — plus a lock on the folder
    // itself, which is what greys the whole listing's write actions.
    await putText("/shared/locks/held.md", "held");
    await putText("/shared/locks/free.md", "free");
    expect((await postJson("/api/v1/fs/lock", { path: "/shared/locks/held.md" })).status).toBe(200);
    expect((await postJson("/api/v1/fs/lock", { path: "/shared/locks" })).status).toBe(200);

    const s = await login(ownerToken);
    const res = await req("/api/v1/files/list?path=/shared/locks", {
      headers: { cookie: s.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lock: { locked_by_name: string | null; locked_at: string | null };
      entries: { name: string; lock: { locked_by_name: string | null } }[];
    };
    // the folder's own lock rides the listing, so no second request is needed
    expect(body.lock.locked_by_name).toBe("alice");
    expect(new Date(body.lock.locked_at ?? "").getTime()).toBeGreaterThan(0);
    const byName = Object.fromEntries(body.entries.map((e) => [e.name, e.lock]));
    // names, not uuids — the human surface's rule, same as updated_by
    expect(byName["held.md"]!.locked_by_name).toBe("alice");
    expect(byName["free.md"]).toEqual({ locked_by: null, locked_by_name: null, locked_at: null });

    await postJson("/api/v1/fs/unlock", { path: "/shared/locks" });
    await postJson("/api/v1/fs/unlock", { path: "/shared/locks/held.md" });
    const after = (await (
      await req("/api/v1/files/list?path=/shared/locks", { headers: { cookie: s.cookie } })
    ).json()) as { lock: { locked_by: string | null } };
    expect(after.lock.locked_by).toBeNull();
  });

  it("a member's home lock never rides another member's listing (RLS)", async () => {
    // bob locks a file in HIS home; carol's listing of /home cannot see the row
    // at all, so nothing about it — least of all its lock — reaches her.
    await putText("/home/bob/private.md", "bob's", bob.token);
    expect(
      (await postJson("/api/v1/fs/lock", { path: "/home/bob/private.md" }, bob.token)).status,
    ).toBe(200);
    const s = await login(carol.token);
    const res = await req("/api/v1/files/list?path=/home", { headers: { cookie: s.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { name: string }[] };
    expect(body.entries.map((e) => e.name)).not.toContain("bob");
    expect(JSON.stringify(body)).not.toContain("bob");
  });

  it("a viewer dashboard session cannot lock (EROFS, like every other mutation)", async () => {
    const s = await login(viewerToken);
    const dashPost = (url: string, body: unknown) =>
      req(url, {
        method: "POST",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // the read-only session's other mutations already refuse — lock/unlock must
    // refuse identically, or a viewer gains a write-blocking side effect.
    for (const [url, body] of [
      ["/api/v1/files/mkdir", { path: "/shared/vc/viewer-dir" }],
      ["/api/v1/files/restore", { path: NOTES, version: 1 }],
      ["/api/v1/files/lock", { path: NOTES }],
      ["/api/v1/files/unlock", { path: NOTES }],
    ] as const) {
      const res = await dashPost(url, body);
      expect(res.status, url).toBe(400);
      expect(((await res.json()) as { error: string }).error, url).toContain("EROFS");
    }

    // and nothing stuck: the owner still writes the path a viewer tried to lock
    expect((await putText(NOTES, "after-viewer")).status).toBe(200);
    expect(
      (
        (await (
          await req(`/api/v1/fs/lock?path=${encodeURIComponent(NOTES)}`, {
            headers: bearer(ownerToken),
          })
        ).json()) as { locked_by: string | null }
      ).locked_by,
    ).toBeNull();
  });

  it("a fixed root is never lockable — /shared cannot be frozen by anyone", async () => {
    for (const root of ["/shared", "/home"]) {
      const res = await postJson("/api/v1/fs/lock", { path: root });
      expect(res.status, root).toBe(400);
      expect(((await res.json()) as { error: string }).error, root).toContain("only /shared");
      expect((await postJson("/api/v1/fs/unlock", { path: root })).status, root).toBe(400);
    }
    // an ancestor lock on /shared would have frozen unrelated paths org-wide
    expect((await putText("/shared/other/x.txt", "still writable")).status).toBe(200);
  });
});
