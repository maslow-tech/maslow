import type { Context, Hono } from "hono";
import type { Pool } from "pg";
import {
  authenticate,
  AuthError,
  MAX_FILE_BYTES,
  MAX_VERSION_NO,
  type FsCtx,
  type FsStore,
  type JwtVerifyOptions,
} from "@brain/mcp-tools";
import { isBrainError } from "@brain/shared";

/**
 * The path-addressed filesystem HTTP surface. Same-origin as /api and /mcp,
 * same bearer auth; every route is a thin call into the ONE FsStore, so RLS
 * (not this file) is the security boundary and a foreign home is a uniform 404.
 *
 *   GET  /api/v1/fs/file?path=   — read scope; the bytes
 *   PUT  /api/v1/fs/file?path=   — write scope; raw body, implicit mkdir -p
 *   POST /api/v1/fs/upload       — write scope; multipart (path + file part)
 *   GET  /api/v1/fs/list?path=   — read scope; { entries: [...] }
 *   POST /api/v1/fs/mkdir        — write scope; { path }
 *   POST /api/v1/fs/rename       — write scope; { from, to }
 *   POST /api/v1/fs/delete       — write scope; { path, recursive? }  (soft)
 *   GET  /api/v1/fs/history?path= — read scope; { versions: [...] }
 *   GET  /api/v1/fs/version?path=&v= — read scope; one snapshot's bytes
 *   POST /api/v1/fs/restore      — write scope; { path, version? }
 *   GET  /api/v1/fs/lock?path=   — read scope; who holds the lock (or null)
 *   POST /api/v1/fs/lock         — write scope; { path }
 *   POST /api/v1/fs/unlock       — write scope; { path }
 *   GET  /api/v1/fs/trash?prefix= — read scope; { entries: [...] }
 *
 * Bodies are BUFFERED: the per-file cap makes streaming complexity
 * without payoff, and an over-cap Content-Length is refused before
 * the body is read.
 */

interface FsHttpOptions {
  readonly pool: Pool;
  readonly fsStore: FsStore;
  readonly jwt?: JwtVerifyOptions;
}

export function mountFs(app: Hono, opts: FsHttpOptions): void {
  const auth = (c: Context) =>
    authenticate(
      opts.pool,
      c.req.header("authorization"),
      opts.jwt ? { jwt: opts.jwt } : undefined,
    );

  /**
   * Authenticate + build the FsCtx, or produce the error Response. Since the
   * tag-governance model (0057) there is no x-on-behalf-of narrowing; every
   * caller (historical service accounts included) is its own actor.
   */
  const fsCtx = async (
    c: Context,
    scope: "read" | "write",
  ): Promise<{ ctx: FsCtx } | { res: Response }> => {
    let authed;
    try {
      authed = await auth(c);
    } catch (e) {
      return { res: unauthorized(c, e) };
    }
    if (!authed.scopes.includes(scope)) {
      return {
        res: c.json(
          { error: scope === "write" ? "this token cannot write" : "this token cannot read" },
          403,
        ),
      };
    }
    return { ctx: { actorId: authed.actorId, ...ownerFlag(authed.role) } };
  };

  const requirePath = (c: Context): string | null => {
    const p = c.req.query("path");
    return p && p.trim() !== "" ? p : null;
  };

  const jsonBody = async <T>(c: Context): Promise<T | null> =>
    (await c.req.json().catch(() => null)) as T | null;

  app.get("/api/v1/fs/file", async (c) => {
    const r = await fsCtx(c, "read");
    if ("res" in r) return r.res;
    const path = requirePath(c);
    if (!path) return c.json({ error: "path query param is required" }, 400);
    try {
      const { meta, bytes } = await opts.fsStore.read(r.ctx, path);
      c.header("Content-Type", meta.mime ?? "application/octet-stream");
      c.header("Content-Length", String(bytes.length));
      c.header("Cache-Control", "private, no-store");
      c.header("X-Content-Type-Options", "nosniff");
      // The stored mime is caller-controlled, and this route serves inline, so
      // a file written as text/html with a <script> body could otherwise run
      // in this origin. The sandbox CSP neutralizes any active content
      // (scripts, plugins, forms) regardless of the served type — bytes still
      // display, they just can't execute.
      c.header("Content-Security-Policy", "default-src 'none'; sandbox; base-uri 'none'");
      c.header("Referrer-Policy", "no-referrer");
      c.header("Content-Disposition", `inline; filename="${meta.name.replace(/["\\\r\n]/g, "_")}"`);
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      return c.body(ab);
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  /**
   * IN-FLIGHT UPLOAD BUDGET — what makes a 100 MB per-file cap safe to ship.
   *
   * Both upload routes buffer the WHOLE body in Node before the store sees it
   * (`Buffer.from(await …arrayBuffer())`), and the store then hashes it and hands
   * it to the pg driver, which serialises another copy. So one upload's transient
   * peak is a small multiple of the file, and NOTHING bounded how many could be in
   * flight at once. At the old 25 MB cap that was survivable by accident. At 100 MB
   * it is not: a live box has ~1.7 GB available and the app container runs with NO
   * memory limit (`HostConfig.Memory: 0`), so a handful of concurrent large uploads
   * is an OOM — not an attack, just two people and an agent saving files.
   *
   * This admits uploads until the declared bytes in flight would exceed the budget,
   * then refuses with 503 + Retry-After rather than accepting work it cannot hold.
   * Refusing a request is a thing a client can retry; an OOM-killed box is not.
   *
   * Deliberately a byte budget, not a request count: ten 1 MB uploads are fine and
   * two 100 MB ones are not, and a count cannot tell those apart.
   */
  const UPLOAD_BUDGET_BYTES =
    Number(process.env.BRAIN_FS_UPLOAD_BUDGET_BYTES) > 0
      ? Number(process.env.BRAIN_FS_UPLOAD_BUDGET_BYTES)
      : 256 * 1024 * 1024;
  let inFlightBytes = 0;

  /** Reserve `n` bytes, or null when the budget is full. Callers MUST release. */
  function reserveUpload(n: number): (() => void) | null {
    // An unknown length reserves the max: we cannot bound what we cannot measure,
    // and guessing small is how the budget stops being a budget.
    const want = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_FILE_BYTES) : MAX_FILE_BYTES;
    if (inFlightBytes > 0 && inFlightBytes + want > UPLOAD_BUDGET_BYTES) return null;
    inFlightBytes += want;
    let released = false;
    return () => {
      if (released) return; // release must be idempotent — it runs in a finally
      released = true;
      inFlightBytes -= want;
    };
  }

  app.put("/api/v1/fs/file", async (c) => {
    const r = await fsCtx(c, "write");
    if ("res" in r) return r.res;
    const path = requirePath(c);
    if (!path) return c.json({ error: "path query param is required" }, 400);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      return c.json({ error: `file exceeds the ${MAX_FILE_BYTES} byte per-file cap` }, 413);
    }
    const release = reserveUpload(declared);
    if (!release) {
      return c.json({ error: "too many uploads in flight — retry shortly" }, 503, {
        "retry-after": "2",
      });
    }
    try {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(await c.req.arrayBuffer());
      } catch {
        return c.json({ error: "could not read the upload body" }, 400);
      }
      const meta = await opts.fsStore.write(r.ctx, path, bytes, c.req.header("content-type"));
      return c.json({ path: meta.path, size: meta.size, sha256: meta.sha256, mime: meta.mime });
    } catch (e) {
      return fsHttpError(c, e);
    } finally {
      release();
    }
  });

  app.post("/api/v1/fs/upload", async (c) => {
    const r = await fsCtx(c, "write");
    if ("res" in r) return r.res;
    const declaredMultipart = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredMultipart) && declaredMultipart > MAX_FILE_BYTES) {
      return c.json({ error: `file exceeds the ${MAX_FILE_BYTES} byte per-file cap` }, 413);
    }
    const releaseMultipart = reserveUpload(declaredMultipart);
    if (!releaseMultipart) {
      return c.json({ error: "too many uploads in flight — retry shortly" }, 503, {
        "retry-after": "2",
      });
    }
    try {
      let path: string;
      let bytes: Buffer;
      let mime: string | undefined;
      try {
        const body = await c.req.parseBody();
        const f = body["file"];
        if (!(f instanceof File)) {
          return c.json({ error: "multipart upload needs a 'file' field" }, 400);
        }
        const p = body["path"];
        if (typeof p !== "string" || p.trim() === "") {
          return c.json({ error: "multipart upload needs a 'path' field (destination path)" }, 400);
        }
        // A directory destination (trailing slash) takes the uploaded file's own
        // name; otherwise `path` names the file itself.
        path = p.endsWith("/") ? `${p}${f.name.replace(/[/\\]/g, "_")}` : p;
        bytes = Buffer.from(await f.arrayBuffer());
        mime = f.type || undefined;
      } catch {
        return c.json({ error: "could not read the upload body" }, 400);
      }
      try {
        const meta = await opts.fsStore.write(r.ctx, path, bytes, mime);
        return c.json({ path: meta.path, size: meta.size, sha256: meta.sha256, mime: meta.mime });
      } catch (e) {
        return fsHttpError(c, e);
      }
    } finally {
      releaseMultipart();
    }
  });

  app.get("/api/v1/fs/list", async (c) => {
    const r = await fsCtx(c, "read");
    if ("res" in r) return r.res;
    const path = requirePath(c);
    if (!path) return c.json({ error: "path query param is required" }, 400);
    try {
      const entries = await opts.fsStore.list(r.ctx, path);
      return c.json({
        entries: entries.map((e) => ({
          name: e.name,
          kind: e.kind,
          size: e.size,
          mtime: e.updatedAt.toISOString(),
          updated_by: e.updatedBy,
        })),
      });
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  app.post("/api/v1/fs/mkdir", async (c) => {
    const r = await fsCtx(c, "write");
    if ("res" in r) return r.res;
    const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
    if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
    try {
      await opts.fsStore.mkdir(r.ctx, body.path);
      return c.json({ ok: true });
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  app.post("/api/v1/fs/rename", async (c) => {
    const r = await fsCtx(c, "write");
    if ("res" in r) return r.res;
    const body = (await c.req.json().catch(() => null)) as { from?: string; to?: string } | null;
    if (typeof body?.from !== "string" || typeof body?.to !== "string") {
      return c.json({ error: "from and to are required" }, 400);
    }
    try {
      await opts.fsStore.rename(r.ctx, body.from, body.to);
      return c.json({ ok: true });
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  app.post("/api/v1/fs/delete", async (c) => {
    const r = await fsCtx(c, "write");
    if ("res" in r) return r.res;
    const body = (await c.req.json().catch(() => null)) as {
      path?: string;
      recursive?: boolean;
    } | null;
    if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
    try {
      // `unrecoverable` names files whose delete-snapshot blew the version
      // budget — hard-deleted, not in the trash. Always echoed, never dropped.
      const { removed, unrecoverable } = await opts.fsStore.rm(
        r.ctx,
        body.path,
        body.recursive === true,
      );
      return c.json({ removed, unrecoverable });
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  // ---- version control, locks, trash --------------------------------------
  // Every route below is the same thin call into the ONE FsStore: RLS on
  // fs_versions mirrors fs_entries, so a foreign home's history/trash is simply
  // EMPTY rather than a 403 — absence, not an oracle.

  app.get("/api/v1/fs/history", async (c) => {
    const r = await fsCtx(c, "read");
    if ("res" in r) return r.res;
    const path = requirePath(c);
    if (!path) return c.json({ error: "path query param is required" }, 400);
    try {
      const versions = await opts.fsStore.versionList(r.ctx, path);
      return c.json({ versions: versions.map(versionRow) });
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  app.get("/api/v1/fs/version", async (c) => {
    const r = await fsCtx(c, "read");
    if ("res" in r) return r.res;
    const path = requirePath(c);
    if (!path) return c.json({ error: "path query param is required" }, 400);
    const v = versionNo(c.req.query("v"));
    if (v === null) return c.json({ error: "v query param must be a version number" }, 400);
    try {
      const bytes = await opts.fsStore.versionContent(r.ctx, path, v);
      return versionResponse(c, path, bytes);
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  app.post("/api/v1/fs/restore", async (c) => {
    const r = await fsCtx(c, "write");
    if ("res" in r) return r.res;
    const body = await jsonBody<{ path?: string; version?: number }>(c);
    if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
    let version: number | undefined;
    if (body.version !== undefined && body.version !== null) {
      const v = versionNo(body.version);
      if (v === null) return c.json({ error: "version must be a version number" }, 400);
      version = v;
    }
    try {
      // `preserved` names the snapshot of the bytes this restore replaced, so
      // the caller can undo it — a restore never discards live content silently.
      const res = await opts.fsStore.restore(r.ctx, body.path, version);
      return c.json({ ok: true, restored_from: res.restoredFrom, preserved: res.preserved });
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  app.get("/api/v1/fs/lock", async (c) => {
    const r = await fsCtx(c, "read");
    if ("res" in r) return r.res;
    const path = requirePath(c);
    if (!path) return c.json({ error: "path query param is required" }, 400);
    try {
      return c.json(lockRow(await opts.fsStore.lockInfo(r.ctx, path)));
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  app.post("/api/v1/fs/lock", async (c) => {
    const r = await fsCtx(c, "write");
    if ("res" in r) return r.res;
    const body = await jsonBody<{ path?: string }>(c);
    if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
    try {
      await opts.fsStore.lock(r.ctx, body.path);
      return c.json({ ok: true, ...lockRow(await opts.fsStore.lockInfo(r.ctx, body.path)) });
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  app.post("/api/v1/fs/unlock", async (c) => {
    const r = await fsCtx(c, "write");
    if ("res" in r) return r.res;
    const body = await jsonBody<{ path?: string }>(c);
    if (typeof body?.path !== "string") return c.json({ error: "path is required" }, 400);
    try {
      await opts.fsStore.unlock(r.ctx, body.path);
      return c.json({ ok: true, ...lockRow(null) });
    } catch (e) {
      return fsHttpError(c, e);
    }
  });

  app.get("/api/v1/fs/trash", async (c) => {
    const r = await fsCtx(c, "read");
    if ("res" in r) return r.res;
    const prefix = c.req.query("prefix");
    try {
      const entries = await opts.fsStore.listTrash(
        r.ctx,
        prefix && prefix.trim() !== "" ? prefix : undefined,
      );
      return c.json({ entries: entries.map(trashRow) });
    } catch (e) {
      return fsHttpError(c, e);
    }
  });
}

/** owner-ness rides the FsCtx so an owner may clear another member's lock. */
function ownerFlag(role: string): { isOwner?: true } {
  return role === "owner" ? { isOwner: true } : {};
}

/**
 * A version number is a positive int4; anything else teaches (never NaN).
 *
 * The upper bound is not cosmetic: `version_no` is an int4, so a bigger number
 * is a TYPE error in Postgres, not a lookup that misses — unbounded, 3e9 came
 * back as a 500 with the database's own wording instead of the 400 every other
 * unusable version number gets.
 */
export function versionNo(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= MAX_VERSION_NO ? n : null;
}

/** JSON shape of one snapshot (bytes stay in Postgres — see /fs/version). */
export function versionRow(v: {
  version_no: number;
  reason: string;
  size_bytes: number;
  edited_by: string;
  created_at: Date;
}): {
  version_no: number;
  reason: string;
  size_bytes: number;
  edited_by: string;
  created_at: string;
} {
  return {
    version_no: v.version_no,
    reason: v.reason,
    size_bytes: v.size_bytes,
    edited_by: v.edited_by,
    created_at: v.created_at.toISOString(),
  };
}

/** JSON shape of one soft-deleted (recoverable) path. */
export function trashRow(t: {
  path: string;
  size_bytes: number;
  created_at: Date;
  edited_by: string;
}): { path: string; size_bytes: number; deleted_at: string; edited_by: string } {
  return {
    path: t.path,
    size_bytes: t.size_bytes,
    deleted_at: t.created_at.toISOString(),
    edited_by: t.edited_by,
  };
}

/** JSON shape of a lock — always the same keys, null when unlocked. */
export function lockRow(info: { lockedBy: string; lockedByName: string; lockedAt: Date } | null): {
  locked_by: string | null;
  locked_by_name: string | null;
  locked_at: string | null;
} {
  return {
    locked_by: info?.lockedBy ?? null,
    locked_by_name: info?.lockedByName ?? null,
    locked_at: info?.lockedAt.toISOString() ?? null,
  };
}

/**
 * Serve one snapshot's bytes with the SAME hardened block as the live file GET
 * (nosniff + sandbox CSP + no-referrer + no-store). Snapshots are text-ish by
 * construction, and the stored mime is caller-controlled, so this route pins
 * text/plain rather than replaying it — a version viewer never needs to render
 * the bytes as anything else.
 */
export function versionResponse(c: Context, path: string, bytes: Buffer): Response {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/["\\\r\n]/g, "_");
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Content-Length", String(bytes.length));
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "default-src 'none'; sandbox; base-uri 'none'");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Disposition", `inline; filename="${name}"`);
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return c.body(ab);
}

function unauthorized(c: Context, e: unknown): Response {
  const base = e instanceof AuthError ? e.wwwAuthenticate : 'Bearer realm="brain"';
  c.header("WWW-Authenticate", base);
  return c.json({ error: "unauthorized" }, 401);
}

/**
 * Map a BrainError to an HTTP status. not_found → uniform 404 (a foreign home
 * is indistinguishable from a missing path); the per-file cap and the quota →
 * 413 with the store's teaching message; a locked path → 423 Locked (the
 * store's ELOCKED is a plain Error with a `code`, deliberately distinct from
 * validation/refused so callers can key on it); everything else keeps its
 * teaching text at 400. Exported so the dashboard's cookie-authed fs routes
 * speak the exact same error shapes as this bearer surface.
 */
export function fsHttpError(c: Context, e: unknown): Response {
  if (e instanceof Error && (e as Error & { code?: string }).code === "ELOCKED") {
    return c.json(
      { error: e.message, unblock: "ask the person holding the lock to unlock it" },
      423,
    );
  }
  if (isBrainError(e)) {
    if (e.code === "not_found") return c.json({ error: "not found" }, 404);
    const errno = e.details?.errno;
    const status = errno === "EFBIG" || errno === "ENOSPC" ? 413 : 400;
    return c.json(
      { error: e.message, ...(e.unblock !== undefined ? { unblock: e.unblock } : {}) },
      status,
    );
  }
  return c.json({ error: "filesystem operation failed" }, 500);
}
