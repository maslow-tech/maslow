import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { FS_MAX_FILE_BYTES } from "@brain/schema";
import { BrainError, isBrainError, refusedError, validationError } from "@brain/shared";

/**
 * FsStore — THE single store over `fs_entries` (migration 0037).
 * Path-first: every surface
 * (bash via PgFs, bearer HTTP, dashboard) calls this one class; nothing else
 * queries the fs tables.
 *
 * Security model, restated where it's enforced:
 *  - RLS on fs_entries is the boundary. Every query here runs in a short
 *    transaction with txn-LOCAL GUCs (app.actor_id + statement_timeout —
 *    reader.ts shape), so pooled connections never leak an actor and an
 *    unset GUC fails closed to shared-only.
 *  - `normalizeFsPath` rejects traversal before any SQL sees the path.
 *  - Write scope is checked in code (/shared/** and /home/<caller>/** only —
 *    teaching errors), and Postgres backstops it: fs_pin_owner derives
 *    owner_id from the path BEFORE the policy's WITH CHECK runs, so "write
 *    into /home/alice as bob" dies in the database even if this code lied.
 *  - Reads need no scope check: RLS filters, and anything invisible is a
 *    uniform ENOENT/not_found (foreign homes are indistinguishable from
 *    missing paths — privacy by absence, no permission-denied oracle).
 *
 * Quota is maintained HERE (no usage trigger — see the 0037 header): every
 * size-changing op adjusts fs_usage.total_bytes in the same transaction and
 * rejects with an ENOSPC teaching error when a positive delta would exceed
 * the quota (env BRAIN_FS_QUOTA_BYTES, default 2 GiB).
 *
 * The pool passed in must be a DEDICATED small pool (max 4) built by the
 * caller — never the shared box pool, so a burst of bash file ops can't
 * starve MCP reads (and vice versa).
 */

// Re-exported from the schema package so the store cap and the DB CHECK
// (0037, widened to 100 MB by 0060) are literally the same number. A store cap
// above the DB's turns this file's teaching EFBIG into a raw constraint
// violation surfacing as a 500; a store cap below the DB's makes the database's
// cap dead code. Neither is discoverable by reading one side.
export const MAX_FILE_BYTES = FS_MAX_FILE_BYTES;

const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * The largest version number that can EXIST: `fs_versions.version_no` is an
 * int4 (migration 0040). A version number is caller input on every surface —
 * an HTTP body, a bash operand, a dashboard field — so this is the ceiling
 * every one of those parsers validates against, not a display detail. Handing
 * Postgres a bigger number is not a lookup that misses, it is a type error
 * ("value \"3000000000\" is out of range for type integer") that surfaced as a
 * 500 and leaked the database's wording into an agent's sandbox.
 */
export const MAX_VERSION_NO = 2_147_483_647;

/** Is `n` a number that could name a snapshot at all (a positive int4)? */
export function isVersionNo(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= MAX_VERSION_NO;
}

// Version snapshots capture text-ish files only (a binary diff is useless and
// the bytes are large) up to a hard cap — everything else overwrites silently.
const FS_VERSION_MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * A caller-supplied media type reduced to its RFC 9110 ESSENCE: everything
 * before the first `;`, trimmed and lowercased. `text/plain;charset=UTF-8` and
 * `TEXT/MARKDOWN` name exactly the same media type as `text/plain` and
 * `text/markdown`, but every gate in this store compares the string EXACTLY —
 * so a parameter or a capital letter silently defeated the versionable
 * predicate, and the documented raw-ingestion path handed us both: a WHATWG
 * `fetch(url, { method: "PUT", body: "…" })` sets `text/plain;charset=UTF-8`
 * by default, and `PUT /api/v1/fs/file` passes that header through verbatim.
 * Normalizing ONCE here, at the boundary, is what keeps that from becoming
 * durable — the parameterised string is never stored, so it can't poison later
 * appends or the file's own history either.
 *
 * Returns null for anything that isn't a well-formed `type/subtype` (the token
 * charset is RFC 9110's), so the caller falls back to the extension.
 * Parameters carry nothing this store uses: bytes are stored and served
 * verbatim under `nosniff` + a sandbox CSP, never re-decoded by charset.
 */
const MIME_ESSENCE_RE = /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/;
export function normalizeMime(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const essence = raw.split(";")[0]!.trim().toLowerCase();
  return MIME_ESSENCE_RE.test(essence) ? essence : null;
}

/**
 * Version snapshots capture text-ish files only
 * — decided by the BYTES, with the media type kept only as a veto.
 *
 * It used to be decided by a mime ALLOWLIST, "by mime OR extension", and that
 * failed the only surface an agent actually writes through: `bash` declares no
 * mime at all, so the extension table decided alone — and it knew `.md/.txt/
 * .json/.py` and little else. Every `app.ts`, `deploy.sh`, `schema.sql`,
 * `run.log`, `README`, `Makefile` and `.gitignore` fell through to
 * `application/octet-stream` and was classified BINARY: overwritten with no
 * history, silently, forever. (The allowlist even named `text/x-typescript`,
 * which no code path could produce.) A bigger table only moves that cliff to
 * the next extension nobody listed — an allowlist is the wrong shape for "did
 * the agent just lose its previous draft?".
 *
 * So the bytes decide, and the guarantee is "if it is text and small, you can
 * get it back", whatever the file is called. Text is `file(1)`'s structural
 * test: no NUL, no DEL, no C0 control byte outside the handful real text uses.
 * Deliberately NOT "decodes as UTF-8" — a cp1252 CSV out of Excel or a latin-1
 * export is text a person edits and expects back, and it is exactly the file
 * whose bytes are easiest to destroy by accident.
 *
 * The type is only ever a VETO, never a grant: a declared (or extension-implied)
 * image/audio/video/font/archive is skipped even when its bytes happen to look
 * printable, because history for a wholesale-replaced blob buys nothing and its
 * bytes are the expensive ones. Everything unrecognised — including
 * `application/octet-stream`, which asserts nothing — falls through to the
 * content test.
 */
// C0 bytes that appear in legitimate text: bell, backspace, tab, LF, VT, FF,
// CR, ESC (the last for ANSI-coloured logs).
const TEXT_CONTROL_BYTES = new Set([7, 8, 9, 10, 11, 12, 13, 27]);

function looksTextual(content: Buffer): boolean {
  for (const b of content) {
    if (b === 0 || b === 0x7f || (b < 0x20 && !TEXT_CONTROL_BYTES.has(b))) return false;
  }
  return true;
}

const BINARY_MIME_PREFIXES = ["image/", "audio/", "video/", "font/"];
const BINARY_MIME = new Set([
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/pdf",
  "application/wasm",
  "application/vnd.sqlite3",
  "application/x-sqlite3",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/** A media type we KNOW names a binary container. `+xml`/`+json` never is. */
function isKnownBinaryMime(m: string | null): boolean {
  if (m === null) return false;
  if (m.endsWith("+xml") || m.endsWith("+json")) return false; // image/svg+xml is text
  return BINARY_MIME.has(m) || BINARY_MIME_PREFIXES.some((p) => m.startsWith(p));
}

/** Non-null when the file's NEXT overwrite would snapshot nothing, and why. */
function versionSkip(
  mime: string | null,
  size: number,
  path: string,
  content: Buffer,
): string | null {
  if (size > FS_VERSION_MAX_FILE_BYTES)
    return `over the ${fmtBytes(FS_VERSION_MAX_FILE_BYTES)} snapshot cap`;
  const declared = normalizeMime(mime);
  if (isKnownBinaryMime(declared)) return `binary (${declared})`;
  const byExt = mimeFromPath(path);
  if (isKnownBinaryMime(byExt)) return `binary (${byExt})`;
  return looksTextual(content) ? null : "binary content";
}

function isVersionable(mime: string | null, size: number, path: string, content: Buffer): boolean {
  return versionSkip(mime, size, path, content) === null;
}

// Version history is bounded twice over: at most N snapshots per path, and a
// global byte budget across every path. Both are best-effort cleanup that runs
// after each snapshot INSERT — a live write must never fail because of version
// bloat, so eviction is separate from the quota that gates real files.
const FS_VERSION_KEEP_PER_PATH = (() => {
  const n = Number(process.env.FS_VERSION_KEEP_PER_PATH);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();
const FS_VERSION_BUDGET_BYTES = (() => {
  const n = Number(process.env.FS_VERSION_BUDGET_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 256 * 1024 * 1024; // 256 MiB
})();
// How many times a snapshot INSERT re-allocates version_no before giving up.
// A conflict means another op snapshotted the same path between our max() read
// and our INSERT — which the advisory keys now prevent for every op that takes
// them, so this is the backstop for the two cases they can't cover (a subtree
// past SUBTREE_LOCK_MAX, a file that appeared after the keys were taken). One
// extra attempt is the realistic worst case; the rest is headroom, and
// exhausting them fails the op loudly instead of writing a duplicate
// (path, version_no) or losing a delete snapshot.
const VERSION_INSERT_ATTEMPTS = 4;
// How many descendant files a recursive rm will advisory-lock before it stops
// (see lockSnapshotTargets): advisory locks are shared-memory objects bounded by
// max_locks_per_transaction, so serializing an unbounded subtree would trade a
// rare duplicate for "out of shared memory" on a legitimate `rm -r`.
const SUBTREE_LOCK_MAX = 2000;
const READ_TIMEOUT_MS = 5000;
// Writes include subtree prefix rewrites (rename) and prefix deletes.
const WRITE_TIMEOUT_MS = 15_000;
const MAX_PATH_CHARS = 4096;

export interface FsCtx {
  actorId: string;
  /** read-scope token: every mutation refuses with an EROFS teaching error. */
  readOnly?: boolean;
  /** caller is an org owner — may force-unlock a file another member locked. */
  isOwner?: boolean;
}

export interface FsEntryMeta {
  path: string;
  name: string;
  kind: "dir" | "file";
  size: number;
  mime: string | null;
  sha256: string | null;
  updatedAt: Date;
  updatedBy: string;
}

/**
 * What a restore() actually did. `preserved` is the snapshot taken of the live
 * bytes the restore replaced (null when the path was free or empty — nothing to
 * keep); it is what lets a caller tell a real, undoable roll-back from a no-op.
 */
export interface FsRestoreResult {
  path: string;
  /** the version_no whose bytes are now live */
  restoredFrom: number;
  size_bytes: number;
  preserved: { version_no: number; size_bytes: number } | null;
}

/**
 * What an rm() actually did. `unrecoverable` names the removed files whose
 * delete-snapshot could not be kept inside FS_VERSION_BUDGET_BYTES — they are
 * hard-deleted, NOT in the trash. It is empty unless a single rm's own
 * snapshots outweigh the whole budget, and every surface that shows a delete
 * result must pass it through: an exit-0 silence must never mean "most of that
 * is gone forever".
 */
export interface FsRmResult {
  removed: number;
  unrecoverable: string[];
}

interface MetaRow {
  path: string;
  name: string;
  kind: "dir" | "file";
  size_bytes: string | number;
  mime: string | null;
  sha256: string | null;
  updated_at: Date;
  updated_by: string;
}

const META_COLS = "path, name, kind, size_bytes, mime, sha256, updated_at, updated_by";

function toMeta(r: MetaRow): FsEntryMeta {
  return {
    path: r.path,
    name: r.name,
    kind: r.kind,
    size: Number(r.size_bytes),
    mime: r.mime,
    sha256: r.sha256,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/**
 * Validate + normalize an absolute fs path: strips one trailing slash, then
 * rejects anything that isn't a clean `/seg/seg` shape — relative paths,
 * `.`/`..` segments, empty segments (`//`), control characters, and
 * percent-encoded traversal (`%2e`/`%2f`/`%5c`). Throws validation errors
 * that teach; never silently rewrites beyond the trailing slash.
 */
export function normalizeFsPath(p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw validationError("path must be a non-empty string");
  }
  if (p.length > MAX_PATH_CHARS) {
    throw validationError(`path is too long (max ${MAX_PATH_CHARS} characters)`);
  }
  if (!p.startsWith("/")) {
    throw validationError(`path must be absolute (start with /), got: ${p}`);
  }
  for (const ch of p) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      throw validationError("path contains control characters");
    }
  }
  if (/%2e|%2f|%5c/i.test(p)) {
    throw validationError("path contains percent-encoded traversal sequences — send plain paths");
  }
  if (p === "/") return "/";
  const stripped = p.endsWith("/") ? p.slice(0, -1) : p;
  for (const seg of stripped.split("/").slice(1)) {
    if (seg === "") throw validationError(`path contains an empty segment (//): ${p}`);
    if (seg === "." || seg === "..") {
      throw validationError(`path must not contain . or .. segments: ${p}`);
    }
  }
  return stripped;
}

const parentOf = (p: string): string => (p === "/" ? "" : p.slice(0, p.lastIndexOf("/")) || "/");
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** LIKE pattern matching strict descendants of `p` (%,_,\ in names escaped). */
const likeChildren = (p: string): string => `${p.replace(/[\\%_]/g, (m) => `\\${m}`)}/%`;

/**
 * Extension → media type, for DISPLAY only (the Content-Type the HTTP +
 * dashboard file routes serve, under `nosniff` + a sandbox CSP). Version
 * history no longer consults it — see `isVersionable` — but a code file served
 * as `application/octet-stream` still downloads instead of showing, so the
 * common source/config extensions belong here too.
 */
const EXT_MIME: Record<string, string> = {
  avif: "image/avif",
  bash: "text/x-shellscript",
  bmp: "image/bmp",
  c: "text/x-c",
  cc: "text/x-c++",
  cfg: "text/plain",
  cjs: "text/javascript",
  conf: "text/plain",
  cpp: "text/x-c++",
  css: "text/css",
  csv: "text/csv",
  cts: "text/x-typescript",
  diff: "text/x-diff",
  gif: "image/gif",
  go: "text/x-go",
  h: "text/x-c",
  hpp: "text/x-c++",
  html: "text/html",
  ico: "image/x-icon",
  ini: "text/plain",
  java: "text/x-java",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  jsx: "text/javascript",
  log: "text/plain",
  lua: "text/x-lua",
  md: "text/markdown",
  mjs: "text/javascript",
  mts: "text/x-typescript",
  patch: "text/x-diff",
  pdf: "application/pdf",
  php: "text/x-php",
  png: "image/png",
  properties: "text/plain",
  py: "text/x-python",
  rb: "text/x-ruby",
  rs: "text/x-rust",
  sh: "text/x-shellscript",
  sql: "text/x-sql",
  svg: "image/svg+xml",
  text: "text/plain",
  toml: "text/plain",
  ts: "text/x-typescript",
  tsv: "text/tab-separated-values",
  tsx: "text/x-typescript",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
  zsh: "text/x-shellscript",
};

function mimeFromPath(p: string): string {
  const name = baseName(p);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  return EXT_MIME[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

function fmtBytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)}GB`;
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(1)}MB`;
  if (n >= 2 ** 10) return `${(n / 2 ** 10).toFixed(1)}KB`;
  return `${n}B`;
}

const enoent = (p: string): BrainError =>
  new BrainError("not_found", `ENOENT: no such file or directory: ${p}`);

const eisdir = (p: string): BrainError =>
  validationError(`EISDIR: ${p} is a directory`, { errno: "EISDIR" });

const efbig = (): BrainError =>
  validationError(`EFBIG: file exceeds the ${fmtBytes(MAX_FILE_BYTES)} per-file cap`, {
    errno: "EFBIG",
    maxBytes: MAX_FILE_BYTES,
  });

/**
 * A version number that could not name a snapshot on ANY box — outside the
 * int4 the column is. It gets the same wording `missingVersionError` gives a
 * number nothing ever issued, because that is precisely what it is: no
 * high-water mark can reach past MAX_VERSION_NO, so this can never be the
 * "issued once, since evicted" case that would deserve the other sentence.
 */
const outOfRangeVersionError = (p: string, n: number): BrainError =>
  validationError(`no version ${n} for ${p}`, { errno: "ENOENT" });

/**
 * A version SELECTOR the caller actually supplied, checked before any query
 * runs. Two different wrongs deserve two different answers:
 *
 *  - NOT A VERSION NUMBER AT ALL (0, -1, 2.5, NaN, Infinity) → EINVAL. The
 *    argument is malformed, so "no version 0 for /p" would be a lie dressed as
 *    a lookup miss — nothing was ever numbered 0, and NaN cannot miss.
 *  - a positive integer past MAX_VERSION_NO → ENOENT, per
 *    `outOfRangeVersionError`: a well-formed number for a snapshot no box
 *    could hold.
 *
 * Load-bearing beyond wording: this is what keeps an EXPLICIT selector from
 * ever being silently dropped. `restore`'s optional `versionNo` used to be
 * gated on truthiness (`versionNo ? … : newest`), so `restore(p, 0)` fell
 * through to the implicit "undo the last change" branch and rewrote the live
 * file from a version the caller never asked for. An argument that was PASSED
 * is load-bearing whatever its value; only `undefined` means "not supplied".
 */
function assertVersionSelector(p: string, n: number): void {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw validationError(`EINVAL: version must be a positive integer, got ${n} (${p})`, {
      errno: "EINVAL",
    });
  }
  if (!isVersionNo(n)) throw outOfRangeVersionError(p, n);
}

/**
 * Every retry at allocating a version number lost. Concurrency, not the
 * caller's fault, and nothing has been written — the transaction rolls back —
 * so the op is safe to repeat verbatim.
 */
const versionRaceError = (p: string): BrainError =>
  refusedError(
    `EAGAIN: could not record a version of ${p} — another change to it landed at the same moment`,
    "nothing was changed; run the same command again",
    { errno: "EAGAIN", path: p },
  );

const scopeError = (p: string): BrainError =>
  validationError(
    `cannot write ${p}: only /shared, /home/<you> and /tmp are writable; /tmp is scratch that vanishes when the script ends`,
    { errno: "EACCES" },
  );

/**
 * Translate database backstops into the same teaching errors the code paths
 * throw, so a caller can't tell (and doesn't care) which layer refused.
 */
function mapFsDbError(e: unknown): unknown {
  if (isBrainError(e)) return e;
  const pg = e as { code?: string; constraint?: string; message?: string };
  const msg = pg?.message ?? "";
  if (msg.includes("fs_no_parent:")) {
    return validationError(`ENOTDIR: ${msg.slice(msg.indexOf("fs_no_parent:") + 14)}`, {
      errno: "ENOTDIR",
    });
  }
  // fs_pin_owner (unknown home slug) or the RLS WITH CHECK — either way the
  // caller tried to write outside its scope and the database refused.
  if (msg.includes("fs_no_such_home:") || pg?.code === "42501") {
    return scopeError("that path");
  }
  // The per-file content CHECK (e.g. an append that crossed the cap).
  if (pg?.code === "23514" && (pg?.constraint ?? "").includes("content")) return efbig();
  // 22003 numeric_value_out_of_range — a number too big for the column it was
  // compared against (version_no is int4). The version-taking entry points
  // already bound their argument; this is the net under every OTHER place a
  // caller-supplied number could reach a query, so no surface ever renders a
  // raw DatabaseError as a 500 or prints it into a sandbox.
  if (pg?.code === "22003") {
    return validationError("version number out of range", { errno: "ENOENT" });
  }
  return e;
}

export class FsStore {
  private readonly quotaBytes: number;
  private readonly versionBudgetBytes: number;
  /** slugs are immutable (0037 doctrine) — memoizing per process is safe. */
  private readonly slugCache = new Map<string, string>();
  /**
   * Whether migration 0048's `brain_fs_version_floor(text)` exists — probed
   * once, then remembered (a function does not come and go inside a process's
   * life, and a box that gains it mid-flight simply starts using it after the
   * next restart). Version numbering must degrade to the pre-0048 `max + 1`
   * rather than fail a live write on a box whose migration has not landed:
   * history is never allowed to take a real write down with it.
   */
  private versionFloorFn: boolean | null = null;

  constructor(
    private readonly pool: Pool,
    opts: { quotaBytes?: number; versionBudgetBytes?: number } = {},
  ) {
    const env = Number(process.env.BRAIN_FS_QUOTA_BYTES);
    this.quotaBytes =
      opts.quotaBytes ?? (Number.isFinite(env) && env > 0 ? env : DEFAULT_QUOTA_BYTES);
    this.versionBudgetBytes = opts.versionBudgetBytes ?? FS_VERSION_BUDGET_BYTES;
  }

  /**
   * One fs op = one short transaction with txn-local GUCs (reader.ts shape):
   * actor for RLS, statement_timeout so no op can squat a connection of the
   * small dedicated pool.
   */
  private async txn<T>(
    ctx: FsCtx,
    mode: "read" | "write",
    fn: (c: PoolClient) => Promise<T>,
    opts: { lockPaths?: readonly string[]; lockSubtreeOf?: string } = {},
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query(mode === "read" ? "BEGIN READ ONLY" : "BEGIN");
      await c.query(
        "SELECT set_config('app.actor_id', $1, true), set_config('statement_timeout', $2, true)",
        [ctx.actorId, String(mode === "read" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS)],
      );
      // Serialize concurrent mutations of the SAME path with a txn-scoped
      // advisory lock. Without it, two writers creating one new path both read
      // "no prior row" (FOR UPDATE locks nothing that doesn't exist yet) and
      // each add the full size to fs_usage — the quota counter drifts up until
      // a false ENOSPC — and two concurrent first-appends both INSERT, so the
      // loser raises a raw unique_violation. Keys are sorted so two-path ops
      // (rename) can't deadlock against a concurrent reverse move.
      const keys = [...new Set(opts.lockPaths ?? [])].sort();
      for (const k of keys) {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [k]);
      }
      if (opts.lockSubtreeOf !== undefined) {
        await this.lockSnapshotTargets(c, opts.lockSubtreeOf);
      }
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw mapFsDbError(e);
    } finally {
      c.release();
    }
  }

  /**
   * Take the per-path advisory key of every FILE a recursive rm is about to
   * snapshot — the other half of the version_no allocation, and the reason it
   * lives in the txn PREAMBLE rather than next to the snapshot.
   *
   * A snapshot numbers itself `max(version_no) + 1`, so two snapshotters of one
   * path must be serialized. Single-path ops already are (write/append/restore
   * hold that file's key). An `rm -r` held the DIRECTORY's key only — a
   * different number — so it and a concurrent write to a file underneath both
   * read the same max and both wrote it: one version number, two bodies, on the
   * pair `versionContent`/`restore`/`versionList` key on.
   *
   * Order matters twice over:
   *  - ASCENDING path, which is also ascending against the directory key
   *    already held (a descendant sorts after its parent), so every fs op still
   *    acquires advisory keys in one global order and none can deadlock.
   *  - BEFORE any row lock. Acquiring these late — after the rm's `FOR UPDATE`
   *    on the directory row — is a genuine deadlock: the concurrent write is by
   *    then blocked on that row while holding the file key this wants, and
   *    Postgres shoots one of them. (Measured, not theorized: the retry-time
   *    version of this lost the write to `deadlock detected`.)
   *
   * The fan-out is capped because advisory locks live in shared memory (
   * max_locks_per_transaction), and an `rm -r` of a huge tree must not die with
   * "out of shared memory". Past the cap the subtree is left unlocked and the
   * snapshot INSERT's own defence carries it: the 0047 unique index plus the
   * bounded retry in snapshotRemovedFiles. That path can cost the rm a deadlock
   * or an EAGAIN when a write to the same file lands mid-flight (measured) —
   * loud, rolled back, and retryable, which is the trade being made: a refused
   * `rm -r` of a >2000-file tree beats a version history that quietly holds two
   * different bodies under one number.
   *
   * RLS scopes this exactly like the snapshot that follows (same session, same
   * actor GUC), so it locks precisely the rows that will be captured.
   */
  private async lockSnapshotTargets(c: PoolClient, dir: string): Promise<void> {
    const n = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM fs_entries
        WHERE path LIKE $1 AND kind = 'file' AND content IS NOT NULL`,
      [likeChildren(dir)],
    );
    if (Number(n.rows[0]?.n ?? 0) > SUBTREE_LOCK_MAX) return;
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtext(p))
         FROM (SELECT path AS p FROM fs_entries
                WHERE path LIKE $1 AND kind = 'file' AND content IS NOT NULL
                ORDER BY path) s`,
      [likeChildren(dir)],
    );
  }

  /** The caller's home slug (fs_homes). Throws for accounts without a home. */
  async homeSlug(actorId: string): Promise<string> {
    const slug = await this.homeSlugOrNull(actorId);
    if (!slug) {
      throw refusedError(
        "this account has no filesystem home",
        "only accounts with a /home/<slug> directory can write the filesystem — ask the owner to recreate the account",
      );
    }
    return slug;
  }

  /**
   * The caller's home slug, or null when the account has none — a historical
   * service account provisioned before 0037 is the real case. A home-less caller still
   * gets /shared (org-wide); only /home/<you> is absent. Callers that branch
   * on this (the bash runner mounts shared-only) use it; callers that require
   * a home use homeSlug().
   */
  async homeSlugOrNull(actorId: string): Promise<string | null> {
    const hit = this.slugCache.get(actorId);
    if (hit !== undefined) return hit;
    const slug =
      (await this.txn({ actorId }, "read", async (c) => {
        const r = await c.query<{ slug: string }>("SELECT slug FROM fs_homes WHERE actor_id = $1", [
          actorId,
        ]);
        return r.rows[0]?.slug;
      })) ?? null;
    if (slug !== null) this.slugCache.set(actorId, slug);
    return slug;
  }

  /**
   * Mutations only: read-only tokens get EROFS; paths outside /shared/** and
   * /home/<caller>/** (foreign homes included) get the teaching error. The
   * fixed roots themselves are never writable — you can't rm /shared.
   */
  private async assertWritable(ctx: FsCtx, path: string): Promise<void> {
    if (ctx.readOnly) {
      throw refusedError(
        "EROFS: this token has read-only scope — the brain filesystem cannot be modified",
        "use a token with write scope",
        { errno: "EROFS" },
      );
    }
    if (path.startsWith("/shared/")) return;
    if (path.startsWith("/home/")) {
      const slug = await this.homeSlug(ctx.actorId);
      if (path.startsWith(`/home/${slug}/`)) return;
    }
    throw scopeError(path);
  }

  // ---- reads (RLS does the hiding; misses are uniform ENOENT) -------------

  async read(ctx: FsCtx, path: string): Promise<{ meta: FsEntryMeta; bytes: Buffer }> {
    const p = normalizeFsPath(path);
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<MetaRow & { content: Buffer | null }>(
        `SELECT ${META_COLS}, content FROM fs_entries WHERE path = $1`,
        [p],
      );
      const row = r.rows[0];
      if (!row) throw enoent(p);
      if (row.kind === "dir") throw eisdir(p);
      return { meta: toMeta(row), bytes: row.content ?? Buffer.alloc(0) };
    });
  }

  async stat(ctx: FsCtx, path: string): Promise<FsEntryMeta> {
    const p = normalizeFsPath(path);
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<MetaRow>(`SELECT ${META_COLS} FROM fs_entries WHERE path = $1`, [p]);
      if (!r.rows[0]) throw enoent(p);
      return toMeta(r.rows[0]);
    });
  }

  /** Children of `dir`, name-ordered. Content is never selected in lists. */
  async list(ctx: FsCtx, dir: string): Promise<FsEntryMeta[]> {
    const p = normalizeFsPath(dir);
    return this.txn(ctx, "read", async (c) => {
      const d = await c.query<{ kind: string }>("SELECT kind FROM fs_entries WHERE path = $1", [p]);
      if (!d.rows[0]) throw enoent(p);
      if (d.rows[0].kind !== "dir") {
        throw validationError(`ENOTDIR: ${p} is not a directory`, { errno: "ENOTDIR" });
      }
      const r = await c.query<MetaRow>(
        `SELECT ${META_COLS} FROM fs_entries WHERE parent = $1 ORDER BY name`,
        [p],
      );
      return r.rows.map(toMeta);
    });
  }

  async exists(ctx: FsCtx, path: string): Promise<boolean> {
    const p = normalizeFsPath(path);
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query("SELECT 1 FROM fs_entries WHERE path = $1", [p]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  /** Brain-wide storage use vs the quota — the number every write checks. */
  async usage(ctx: FsCtx): Promise<{ totalBytes: number; quotaBytes: number }> {
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<{ total_bytes: string }>("SELECT total_bytes FROM fs_usage");
      return {
        totalBytes: Number(r.rows[0]?.total_bytes ?? 0),
        quotaBytes: this.quotaBytes,
      };
    });
  }

  /**
   * Prior-version snapshots for a path, newest first. RLS on fs_versions scopes
   * exactly like fs_entries (shared for everyone, home rows owner-only), so a
   * foreign home's history is simply empty. Fuller reader lands in Task 7.
   */
  async history(
    ctx: FsCtx,
    path: string,
  ): Promise<
    Array<{
      version_no: number;
      reason: string;
      content: Buffer;
      size_bytes: number;
      edited_by: string;
      created_at: Date;
    }>
  > {
    const p = normalizeFsPath(path);
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<{
        version_no: number;
        reason: string;
        content: Buffer;
        size_bytes: string;
        edited_by: string;
        created_at: Date;
      }>(
        `SELECT version_no, reason, content, size_bytes, edited_by, created_at
           FROM fs_versions WHERE path = $1
          ORDER BY version_no DESC, created_at DESC, id DESC`,
        [p],
      );
      return r.rows.map((x) => ({ ...x, size_bytes: Number(x.size_bytes) }));
    });
  }

  /**
   * The same rows as history() with the BYTES left in Postgres — what a version
   * LIST (the bash `history` table, the dashboard's history panel) actually
   * needs. history() is for callers that want the content; listing with it
   * dragged up to KEEP_PER_PATH × 1 MiB into the process to print dates.
   */
  async versionList(
    ctx: FsCtx,
    path: string,
  ): Promise<
    Array<{
      version_no: number;
      reason: string;
      size_bytes: number;
      sha256: string | null;
      edited_by: string;
      created_at: Date;
    }>
  > {
    const p = normalizeFsPath(path);
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<{
        version_no: number;
        reason: string;
        size_bytes: string;
        sha256: string | null;
        edited_by: string;
        created_at: Date;
      }>(
        // sha256 rides along so a caller can tell which snapshots differ from
        // the live file (what `diff <path>` picks) without pulling bytes.
        `SELECT version_no, reason, size_bytes, sha256, edited_by, created_at
           FROM fs_versions WHERE path = $1
          ORDER BY version_no DESC, created_at DESC, id DESC`,
        [p],
      );
      return r.rows.map((x) => ({ ...x, size_bytes: Number(x.size_bytes) }));
    });
  }

  /**
   * Why `path`'s NEXT overwrite would take no snapshot — or null when it would
   * take one (and null, too, for a directory or a path that doesn't exist:
   * neither is a file with a broken promise).
   *
   * Skipping is silent by design — history must never be able to fail a live
   * write — so an agent's only way to learn that its file is unprotected is to
   * ask. A bare "no version history" answered that question and the completely
   * different "you just haven't edited it yet" with the same six words, which
   * is how someone overwrites a file believing the old bytes are recoverable.
   *
   * Reads the content only when it is within the snapshot cap (≤ 1 MiB), so
   * asking about a 100 MB blob costs one size read.
   */
  async versionSkipReason(ctx: FsCtx, path: string): Promise<string | null> {
    const p = normalizeFsPath(path);
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<{ size_bytes: string; mime: string | null; content: Buffer | null }>(
        `SELECT size_bytes, mime, CASE WHEN size_bytes <= $2 THEN content END AS content
           FROM fs_entries WHERE path = $1 AND kind = 'file'`,
        [p, FS_VERSION_MAX_FILE_BYTES],
      );
      const row = r.rows[0];
      if (!row) return null;
      return versionSkip(row.mime, Number(row.size_bytes), p, row.content ?? Buffer.alloc(0));
    });
  }

  /**
   * Raw bytes of one snapshot — feeds the dashboard's diff/version viewer.
   * RLS on fs_versions scopes visibility exactly like history(), so a foreign
   * home's version simply isn't found.
   *
   * (path, version_no) is unique since 0047, but a box that carried duplicates
   * from before it (and could not be de-duplicated) must still answer the same
   * bytes every time it is asked, and the same bytes `restore` would put back —
   * so the tiebreak is stated, never left to physical row order. Same reason
   * for the one in history/versionList/listTrash/restore.
   */
  async versionContent(ctx: FsCtx, path: string, versionNo: number): Promise<Buffer> {
    const p = normalizeFsPath(path);
    assertVersionSelector(p, versionNo);
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<{ content: Buffer }>(
        `SELECT content FROM fs_versions WHERE path = $1 AND version_no = $2
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [p, versionNo],
      );
      if (!r.rows[0]) throw await this.missingVersionError(c, p, versionNo);
      return r.rows[0].content;
    });
  }

  // ---- writes --------------------------------------------------------------

  /**
   * Whole-file write: implicit mkdir -p, then a single INSERT … ON CONFLICT
   * UPDATE — never torn, last write wins. Enforces the per-file cap and the
   * quota; maintains fs_usage in the same transaction.
   */
  async write(ctx: FsCtx, path: string, bytes: Buffer, mime?: string): Promise<FsEntryMeta> {
    const p = normalizeFsPath(path);
    if (p === "/") throw eisdir(p);
    await this.assertWritable(ctx, p);
    if (bytes.length > MAX_FILE_BYTES) throw efbig();
    // (the sha is computed inside insertFileRow, alongside the INSERT)
    // Normalize the caller's media type to its essence ONCE, here: an
    // unparseable or absent one falls back to the extension. Only the essence
    // is ever persisted (see normalizeMime).
    const declared = normalizeMime(mime);
    const m = declared ?? mimeFromPath(p);
    return this.txn(
      ctx,
      "write",
      async (c) => {
        await this.assertNotLocked(c, p);
        const prev = await c.query<{ kind: string; size_bytes: string }>(
          "SELECT kind, size_bytes FROM fs_entries WHERE path = $1 FOR UPDATE",
          [p],
        );
        if (prev.rows[0]?.kind === "dir") throw eisdir(p);
        await this.snapshotIfVersionable(c, ctx, p, { next: bytes });
        await this.mkdirChain(c, ctx, parentOf(p));
        await this.bumpUsage(c, bytes.length - Number(prev.rows[0]?.size_bytes ?? 0));
        // A caller that declared nothing (every bash write) must not CLOBBER a
        // media type an earlier caller declared: the fallback is derived from
        // the extension, so one `echo >> report` after an HTTP upload used to
        // reset a known `text/markdown` to `application/octet-stream` forever.
        // Silence keeps what's there; only an explicit declaration replaces it.
        return this.insertFileRow(c, ctx, p, bytes, m, { keepExistingMime: declared === null });
      },
      { lockPaths: [p] },
    );
  }

  /**
   * The single whole-file INSERT … ON CONFLICT UPDATE used by write() and
   * restore(): last-write-wins, sha256 recomputed here so the row is always
   * self-consistent. Callers own the surrounding txn — parent mkdir, usage
   * accounting and the version snapshot are their concern, not this row builder's.
   */
  private async insertFileRow(
    c: PoolClient,
    ctx: FsCtx,
    path: string,
    bytes: Buffer,
    mime: string,
    opts: { keepExistingMime?: boolean } = {},
  ): Promise<FsEntryMeta> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const r = await c.query<MetaRow>(
      `INSERT INTO fs_entries
         (path, parent, name, kind, content, size_bytes, sha256, mime, created_by, updated_by)
       VALUES ($1, $2, $3, 'file', $4, $5, $6, $7, $8, $8)
       ON CONFLICT (path) DO UPDATE SET
         content = EXCLUDED.content, size_bytes = EXCLUDED.size_bytes,
         sha256 = EXCLUDED.sha256,
         mime = ${opts.keepExistingMime ? "coalesce(fs_entries.mime, EXCLUDED.mime)" : "EXCLUDED.mime"},
         updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${META_COLS}`,
      [path, parentOf(path), baseName(path), bytes, bytes.length, sha256, mime, ctx.actorId],
    );
    return toMeta(r.rows[0]!);
  }

  /**
   * Append: one UPDATE (content = content || $n) so a `>>` never rewrites the
   * file through the wire; creates the file when missing. PgFs coalesces
   * consecutive appends on top of this, so this is already the slow path.
   */
  async append(ctx: FsCtx, path: string, bytes: Buffer): Promise<void> {
    const p = normalizeFsPath(path);
    await this.assertWritable(ctx, p);
    if (bytes.length > MAX_FILE_BYTES) throw efbig();
    await this.txn(
      ctx,
      "write",
      async (c) => {
        await this.assertNotLocked(c, p);
        // A zero-byte append leaves the file byte-identical — a non-edit, so it
        // takes no snapshot (the same rule write() applies to identical bytes).
        if (bytes.length > 0) await this.snapshotIfVersionable(c, ctx, p);
        const upd = await c.query(
          `UPDATE fs_entries SET
             content = content || $2, size_bytes = size_bytes + $3,
             sha256 = encode(sha256(content || $2), 'hex'),
             updated_by = $4, updated_at = now()
           WHERE path = $1 AND kind = 'file'`,
          [p, bytes, bytes.length, ctx.actorId],
        );
        if ((upd.rowCount ?? 0) === 0) {
          const existing = await c.query<{ kind: string }>(
            "SELECT kind FROM fs_entries WHERE path = $1",
            [p],
          );
          if (existing.rows[0]?.kind === "dir") throw eisdir(p);
          await this.mkdirChain(c, ctx, parentOf(p));
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          // ON CONFLICT: the advisory lock serializes same-path creators, but
          // belt-and-suspenders — a concurrent create becomes an append, never
          // a raw unique_violation.
          await c.query(
            `INSERT INTO fs_entries
               (path, parent, name, kind, content, size_bytes, sha256, mime, created_by, updated_by)
             VALUES ($1, $2, $3, 'file', $4, $5, $6, $7, $8, $8)
             ON CONFLICT (path) DO UPDATE SET
               content = fs_entries.content || EXCLUDED.content,
               size_bytes = fs_entries.size_bytes + octet_length(EXCLUDED.content),
               sha256 = encode(sha256(fs_entries.content || EXCLUDED.content), 'hex'),
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [
              p,
              parentOf(p),
              baseName(p),
              bytes,
              bytes.length,
              sha256,
              mimeFromPath(p),
              ctx.actorId,
            ],
          );
        }
        await this.bumpUsage(c, bytes.length);
      },
      { lockPaths: [p] },
    );
  }

  /**
   * mkdir -p. Creating a dir that already exists is a success no-op.
   *
   * Like every other mutator this consults locks (assertNotLocked, self +
   * ancestors) BEFORE creating anything. It was once the sole exception, and
   * that was a straight lock bypass: a second member could `mkdir -p
   * /shared/locked/injected/deep` and plant durable rows anywhere inside a
   * locked subtree — bash even scored it exit 0 with a "persisted" tool result
   * and `ls` of the protected folder showed the injected entry beside the
   * content the lock exists to freeze.
   *
   * The already-exists no-op is checked FIRST, and deliberately so: `-p` on a
   * directory that is already there mutates nothing, so it must keep
   * succeeding even when that very directory (or an ancestor) is locked —
   * otherwise a lock would break every unrelated script that idempotently
   * ensures its working directory. The refusal covers only paths that would
   * actually be created.
   */
  async mkdir(ctx: FsCtx, path: string): Promise<void> {
    const p = normalizeFsPath(path);
    // The seeded skeleton (and the caller's own home root) already exists —
    // -p semantics make these no-ops, before any write-scope question arises.
    if (p === "/" || p === "/shared" || p === "/home") return;
    await this.assertWritable(ctx, p);
    await this.txn(
      ctx,
      "write",
      async (c) => {
        const prev = await c.query<{ kind: string }>(
          "SELECT kind FROM fs_entries WHERE path = $1",
          [p],
        );
        if (prev.rows[0]?.kind === "dir") return; // -p no-op: nothing is mutated
        await this.assertNotLocked(c, p);
        await this.mkdirChain(c, ctx, p);
        const r = await c.query<{ kind: string }>("SELECT kind FROM fs_entries WHERE path = $1", [
          p,
        ]);
        if (r.rows[0]?.kind !== "dir") {
          throw validationError(`EEXIST: a file already exists at ${p}`, { errno: "EEXIST" });
        }
      },
      { lockPaths: [p] },
    );
  }

  /**
   * Delete. Files and empty dirs go without `recursive`; a non-empty dir
   * requires it (ENOTEMPTY teaches). Recursive = ONE prefix-scoped DELETE —
   * no orphan window.
   *
   * Returns `{ removed, unrecoverable }`: the number of entries removed, and
   * the paths whose delete-snapshot did NOT fit the global version budget and
   * so are hard-deleted rather than sitting in the trash. `unrecoverable` is
   * empty in every normal case; it is non-empty only when this ONE rm's own
   * snapshots outweigh FS_VERSION_BUDGET_BYTES, and it exists so that surface
   * can never be silent about it (see evictVersions).
   */
  async rm(ctx: FsCtx, path: string, recursive = false): Promise<FsRmResult> {
    const p = normalizeFsPath(path);
    await this.assertWritable(ctx, p);
    return this.txn(
      ctx,
      "write",
      async (c) => {
        // A recursive rm's blast radius is the whole subtree, so a lock ANYWHERE
        // below refuses it (not just on `p` or an ancestor) — before the
        // snapshot INSERT and the DELETE, so nothing is partially removed.
        await this.assertNotLocked(c, p, { subtree: recursive });
        const cur = await c.query<{ kind: string }>(
          "SELECT kind FROM fs_entries WHERE path = $1 FOR UPDATE",
          [p],
        );
        if (!cur.rows[0]) throw enoent(p);
        if (cur.rows[0].kind === "dir" && !recursive) {
          const kids = await c.query("SELECT 1 FROM fs_entries WHERE parent = $1 LIMIT 1", [p]);
          if ((kids.rowCount ?? 0) > 0) {
            throw validationError(
              `ENOTEMPTY: ${p} is not empty — pass recursive to delete a directory and its contents`,
              { errno: "ENOTEMPTY" },
            );
          }
        }
        // Soft-delete: snapshot every FILE being removed before the rows vanish.
        const unrecoverable = await this.snapshotRemovedFiles(c, ctx, p, recursive);
        const del = await c.query<{ kind: string; size_bytes: string }>(
          recursive
            ? "DELETE FROM fs_entries WHERE path = $1 OR path LIKE $2 RETURNING kind, size_bytes"
            : "DELETE FROM fs_entries WHERE path = $1 RETURNING kind, size_bytes",
          recursive ? [p, likeChildren(p)] : [p],
        );
        const freed = del.rows
          .filter((r) => r.kind === "file")
          .reduce((sum, r) => sum + Number(r.size_bytes), 0);
        await this.bumpUsage(c, -freed);
        return { removed: del.rowCount ?? 0, unrecoverable };
      },
      // A recursive rm snapshots the whole subtree, so it must hold the
      // advisory key of every file it will snapshot — not just the directory's.
      // Taken in the preamble, ascending, before any row lock: see
      // lockSnapshotTargets.
      { lockPaths: [p], lockSubtreeOf: recursive ? p : undefined },
    );
  }

  /**
   * Rename/move — a SINGLE prefix rewrite UPDATE over the subtree (the
   * fs_assert_parent trigger fires AFTER, when the whole rewrite is visible).
   * A file may overwrite an existing file (POSIX rename); anything else at
   * the destination is EEXIST. Both ends must be in the caller's write scope.
   */
  async rename(ctx: FsCtx, from: string, to: string): Promise<void> {
    const f = normalizeFsPath(from);
    const t = normalizeFsPath(to);
    if (f === t) return;
    if (t.startsWith(`${f}/`)) {
      throw validationError(`EINVAL: cannot move ${f} inside itself`, { errno: "EINVAL" });
    }
    await this.assertWritable(ctx, f);
    await this.assertWritable(ctx, t);
    await this.txn(
      ctx,
      "write",
      async (c) => {
        // Both ends: a locked source can't be moved away, and a locked
        // destination (or its locked ancestor) can't be overwritten into.
        // A rename rewrites the ENTIRE source subtree, so a lock on any
        // descendant refuses it too — moving a locked file by moving its parent
        // is the same bypass as rm -r'ing its parent. Same on the destination
        // side for whatever the move would clobber.
        await this.assertNotLocked(c, f, { subtree: true });
        await this.assertNotLocked(c, t, { subtree: true });
        const src = await c.query<{ kind: string }>(
          "SELECT kind FROM fs_entries WHERE path = $1 FOR UPDATE",
          [f],
        );
        if (!src.rows[0]) throw enoent(f);
        const dst = await c.query<{ kind: string; size_bytes: string }>(
          "SELECT kind, size_bytes FROM fs_entries WHERE path = $1 FOR UPDATE",
          [t],
        );
        if (dst.rows[0]) {
          if (src.rows[0].kind !== "file" || dst.rows[0].kind !== "file") {
            throw validationError(`EEXIST: ${t} already exists`, { errno: "EEXIST" });
          }
          // A clobbering rename REMOVES the destination file, so it owes the
          // same delete-snapshot rm() takes — otherwise `mv slop.md thesis.md`
          // shreds thesis.md permanently while `rm thesis.md` stays fully
          // recoverable, and the trash guarantee is bypassed by a verb that
          // never says "delete". Recovery is the documented trash flow: free
          // the path (rm/mv the intruder), then `restore <path>`.
          // (Its `unrecoverable` return is dropped here on purpose: a clobber
          // snapshots exactly ONE file, capped at MAX_FILE_BYTES, so it
          // can only be evicted by a budget configured smaller than a single
          // file — not a state a real box can reach. rm's list is the one that
          // matters, because rm -r snapshots a whole subtree at once.)
          await this.snapshotRemovedFiles(c, ctx, t, false);
          await c.query("DELETE FROM fs_entries WHERE path = $1", [t]);
          await this.bumpUsage(c, -Number(dst.rows[0].size_bytes));
        }
        await this.mkdirChain(c, ctx, parentOf(t));
        // The subtree cut is computed in the DB with char_length($1): Postgres
        // substring(... FROM n) counts CHARACTERS, so a JS `.length` offset
        // (UTF-16 code units) would be off by one per astral char (emoji
        // filenames), mis-parenting children. Same offset drives path + parent.
        await c.query(
          `UPDATE fs_entries SET
             path = $2 || substring(path FROM char_length($1) + 1),
             parent = CASE WHEN path = $1 THEN $3
                           ELSE $2 || substring(parent FROM char_length($1) + 1) END,
             name = CASE WHEN path = $1 THEN $4 ELSE name END,
             updated_by = $5, updated_at = now()
           WHERE path = $1 OR path LIKE $6`,
          [f, t, parentOf(t), baseName(t), ctx.actorId, likeChildren(f)],
        );
      },
      { lockPaths: [f, t] },
    );
  }

  /**
   * Recreate a file from a snapshot. Two shapes, chosen by what's at `path`:
   *  - path is FREE → resurrect the newest (or `versionNo`) snapshot into place
   *    (the undo of an `rm`).
   *  - path is a LIVE file → roll it back to an older version; the current bytes
   *    are snapshotted first so the roll-back is itself undoable. A delete-
   *    snapshot may NOT clobber a live path (EEXIST) — trash restores to a free
   *    path only; use an explicit overwrite version to roll a live file back.
   * RLS scopes which snapshots exist for the caller, and assertWritable keeps
   * the target inside the caller's write scope.
   *
   * The preserve snapshot is UNCONDITIONAL (`force`), not filtered by the write
   * path's versionable rule: a restore that silently shreds a 2 MB or binary
   * working copy is a destroy dressed as an undo — the follow-up "undo the
   * restore" then re-applied the SAME old bytes and reported success. Reported
   * back in `preserved` so callers (bash `restore`, HTTP) can say what survived.
   */
  async restore(ctx: FsCtx, path: string, versionNo?: number): Promise<FsRestoreResult> {
    const p = normalizeFsPath(path);
    // "An argument was passed" is not "the argument is truthy": a selector is
    // validated (and refused) the moment it exists, before a single row is
    // read or locked. Everything below may then test `=== undefined` only.
    const named = versionNo !== undefined;
    if (named) assertVersionSelector(p, versionNo);
    await this.assertWritable(ctx, p);
    return this.txn(
      ctx,
      "write",
      async (c) => {
        await this.assertNotLocked(c, p);
        const live = await c.query<{ kind: string; size_bytes: string; sha256: string | null }>(
          "SELECT kind, size_bytes, sha256 FROM fs_entries WHERE path = $1 FOR UPDATE",
          [p],
        );
        if (live.rows[0]?.kind === "dir") throw eisdir(p);
        // Version-less restore = "undo the last change", so it takes the newest
        // snapshot that actually DIFFERS from what is live, not blindly the
        // newest row. A snapshot equal to the live bytes is not an undo, it is
        // a no-op that reports success — and one can still exist (an A→B→A
        // roll-back preserves A on top, and boxes written before the no-op
        // guard above carry duplicate rows). Ordering, not filtering: when
        // every snapshot matches the live file there is genuinely nothing to
        // undo, and this still answers with the newest rather than ENOENT.
        const byNewestDiffering = !named && live.rows[0];
        const snap = await c.query<{
          content: Buffer;
          size_bytes: string;
          mime: string | null;
          reason: string;
          version_no: number;
        }>(
          `SELECT content, size_bytes, mime, reason, version_no FROM fs_versions
            WHERE path = $1 ${named ? "AND version_no = $2" : ""}
            ORDER BY ${byNewestDiffering ? "(sha256 IS DISTINCT FROM $2) DESC, " : ""}version_no DESC,
                     created_at DESC, id DESC
            LIMIT 1`,
          named ? [p, versionNo] : byNewestDiffering ? [p, live.rows[0]!.sha256] : [p],
        );
        const s = snap.rows[0];
        // A NAMED version that is missing gets the honest answer: "evicted" and
        // "never existed" are different facts, and only one of them means the
        // caller's note was right and the bytes are simply gone. (Version-less
        // restore keeps its own wording — nothing was named.)
        if (!s && named) throw await this.missingVersionError(c, p, versionNo!);
        if (!s) throw validationError(`no version to restore for ${p}`, { errno: "ENOENT" });
        let preserved: { version_no: number; size_bytes: number } | null = null;
        if (live.rows[0]) {
          if (s.reason === "delete") {
            throw validationError(
              `EEXIST: ${p} already exists — a deleted file restores only to a free path`,
              { errno: "EEXIST" },
            );
          }
          // Rolling a live file back: preserve the bytes we're about to replace,
          // whatever they are (the SELECT of `s` above already ran, so a second
          // restore still toggles back to them) — unless they ARE the bytes
          // being restored, in which case nothing is being replaced and a
          // preserve row would just be duplicate history. `preserved: null`
          // then tells the caller this restore was a no-op.
          preserved = await this.snapshotIfVersionable(c, ctx, p, {
            force: true,
            next: s.content,
          });
        }
        await this.mkdirChain(c, ctx, parentOf(p));
        await this.bumpUsage(c, Number(s.size_bytes) - Number(live.rows[0]?.size_bytes ?? 0));
        const meta = await this.insertFileRow(
          c,
          ctx,
          p,
          s.content,
          normalizeMime(s.mime) ?? mimeFromPath(p),
        );
        return { path: p, restoredFrom: s.version_no, size_bytes: meta.size, preserved };
      },
      { lockPaths: [p] },
    );
  }

  /**
   * Soft-deleted files recoverable under `prefix` (default the whole tree):
   * the newest delete-snapshot of every path that has no live fs_entries row.
   * RLS on fs_versions scopes this exactly like the live tree, so a foreign
   * home's trash is simply empty.
   *
   * `prefix` is a PATH prefix, normalized like every other path this store
   * takes (so a caller's raw query string can't smuggle traversal in): it
   * matches the path itself plus its strict descendants — `/shared/vc` never
   * drags in the sibling folder `/shared/vconfidential`, which a bare string
   * prefix would.
   */
  async listTrash(
    ctx: FsCtx,
    prefix = "/",
  ): Promise<Array<{ path: string; size_bytes: number; created_at: Date; edited_by: string }>> {
    const p = normalizeFsPath(prefix);
    const wholeTree = p === "/";
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<{
        path: string;
        size_bytes: string;
        created_at: Date;
        edited_by: string;
      }>(
        `SELECT DISTINCT ON (path) path, size_bytes, created_at, edited_by
           FROM fs_versions v
          WHERE reason = 'delete'
            ${wholeTree ? "" : "AND (v.path = $1 OR v.path LIKE $2)"}
            AND NOT EXISTS (SELECT 1 FROM fs_entries e WHERE e.path = v.path)
          ORDER BY path, version_no DESC, created_at DESC, id DESC`,
        wholeTree ? [] : [p, likeChildren(p)],
      );
      return r.rows.map((x) => ({ ...x, size_bytes: Number(x.size_bytes) }));
    });
  }

  // ---- locks ---------------------------------------------------------------

  /**
   * Mark a file or directory as locked by the caller. A lock is a PROTECTION
   * flag, not a privacy boundary — RLS still scopes which rows the caller can
   * see, so locking a path invisible to the caller (a foreign home) simply
   * finds no row and teaches. A locked directory protects its whole subtree
   * (enforced in assertNotLocked, not stored per-descendant).
   *
   * A lock ALREADY HELD BY SOMEONE ELSE is not takeable: re-locking it is
   * refused unless the caller is an org owner (ctx.isOwner), the same rule
   * unlock() enforces. Without this guard the unlock rule is theater — any
   * member could re-lock another member's file to become the holder, then unlock
   * it as themselves and write. Re-locking one's OWN lock stays idempotent
   * (it just re-stamps locked_at).
   *
   * A lock is a MUTATION — it blocks everyone else's writes — so it goes
   * through the same write gate as every other mutator: a read-only ctx gets
   * EROFS, and the fixed roots stay out of write scope (nobody can lock
   * /shared and freeze the whole org's tree by ancestor enforcement).
   */
  async lock(ctx: FsCtx, path: string): Promise<void> {
    const p = normalizeFsPath(path);
    await this.assertWritable(ctx, p);
    return this.txn(
      ctx,
      "write",
      async (c) => {
        const cur = await c.query<{ locked_by: string | null }>(
          "SELECT locked_by FROM fs_entries WHERE path = $1 FOR UPDATE",
          [p],
        );
        if (!cur.rows[0]) {
          throw validationError(`cannot lock: ${p} does not exist (or is not visible to you)`, {
            errno: "ENOENT",
          });
        }
        const heldBy = cur.rows[0].locked_by;
        if (heldBy && heldBy !== ctx.actorId && ctx.isOwner !== true) {
          const who = await c.query<{ name: string }>("SELECT name FROM accounts WHERE id = $1", [
            heldBy,
          ]);
          throw refusedError(
            `${p} is already locked by ${who.rows[0]?.name ?? "another member"} — a lock cannot be taken over`,
            "ask them to unlock it, or ask an owner to clear it",
          );
        }
        await c.query("UPDATE fs_entries SET locked_by = $2, locked_at = now() WHERE path = $1", [
          p,
          ctx.actorId,
        ]);
      },
      { lockPaths: [p] },
    );
  }

  /**
   * Clear a lock. Only the account that set it, or an org owner (ctx.isOwner),
   * may unlock — a member can't quietly steal another member's protection. RLS
   * scopes visibility first: a path the caller can't see (or that isn't locked)
   * is a silent no-op; a path locked by someone else, when the caller is not an
   * owner, teaches rather than lying about success. Like lock(), it is a
   * mutation and passes the same write gate first (read-only ⇒ EROFS).
   */
  async unlock(ctx: FsCtx, path: string): Promise<void> {
    const p = normalizeFsPath(path);
    await this.assertWritable(ctx, p);
    return this.txn(
      ctx,
      "write",
      async (c) => {
        const cur = await c.query<{ locked_by: string | null }>(
          "SELECT locked_by FROM fs_entries WHERE path = $1 FOR UPDATE",
          [p],
        );
        const lockedBy = cur.rows[0]?.locked_by;
        if (!lockedBy) return; // not found (or not locked) → idempotent no-op
        if (lockedBy !== ctx.actorId && ctx.isOwner !== true) {
          throw refusedError(
            `${p} is locked by someone else — only the person who locked it or an owner can unlock it`,
            "ask the person who locked it to unlock it, or unlock it as an owner",
          );
        }
        await c.query("UPDATE fs_entries SET locked_by = NULL, locked_at = NULL WHERE path = $1", [
          p,
        ]);
      },
      { lockPaths: [p] },
    );
  }

  /**
   * Who holds the lock on `path`, or null if unlocked / invisible. RLS scopes
   * fs_entries, so a foreign home's lock reads as null (privacy by absence).
   */
  async lockInfo(
    ctx: FsCtx,
    path: string,
  ): Promise<{ lockedBy: string; lockedByName: string; lockedAt: Date } | null> {
    const p = normalizeFsPath(path);
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<{ locked_by: string; name: string; locked_at: Date }>(
        `SELECT e.locked_by, e.locked_at, a.name
           FROM fs_entries e JOIN accounts a ON a.id = e.locked_by
          WHERE e.path = $1 AND e.locked_by IS NOT NULL`,
        [p],
      );
      const row = r.rows[0];
      if (!row) return null;
      return { lockedBy: row.locked_by, lockedByName: row.name, lockedAt: row.locked_at };
    });
  }

  /**
   * Read-only PROBE of the lock gate a mutation of `path` would hit: throws the
   * SAME ELOCKED as the real mutators when `path` or an ancestor is locked, and
   * returns quietly otherwise. It touches nothing — no advisory lock, no row,
   * no version — so it is cheap enough to run before a write that has not
   * happened yet.
   *
   * It exists for the shell's `>>`. PgFs coalesces consecutive appends, so the
   * bytes of `echo x >> locked.md` reached the store only at the exec-end
   * flush — long after the shell had already scored the redirect a SUCCESS and
   * run the `&&` successor. An agent scripting `echo … >> canon.md && rm
   * draft.md` therefore deleted the draft believing the append had landed.
   * Probing here lets the redirect fail AT the redirect, exactly as `>` does.
   *
   * This is a GATE CHECK, not the enforcement boundary: every mutator re-runs
   * assertNotLocked inside its own transaction, after the advisory lock, and a
   * lock taken between probe and flush is still caught there.
   */
  async assertNotLockedForWrite(ctx: FsCtx, path: string): Promise<void> {
    const p = normalizeFsPath(path);
    await this.txn(ctx, "read", async (c) => {
      await this.assertNotLocked(c, p);
    });
  }

  /**
   * lockInfo for MANY paths in ONE round trip, keyed by path. The file manager
   * shows a lock per row, and asking per row would be an N+1 — one transaction
   * per file on a pool documented at 4 connections. Unlocked (or invisible)
   * paths are simply ABSENT from the map: RLS scopes fs_entries here exactly as
   * it does for lockInfo, so a foreign home's lock can never ride a listing.
   */
  async lockInfoMany(
    ctx: FsCtx,
    paths: readonly string[],
  ): Promise<Map<string, { lockedBy: string; lockedByName: string; lockedAt: Date }>> {
    const ps = paths.map((p) => normalizeFsPath(p));
    const out = new Map<string, { lockedBy: string; lockedByName: string; lockedAt: Date }>();
    if (ps.length === 0) return out;
    return this.txn(ctx, "read", async (c) => {
      const r = await c.query<{ path: string; locked_by: string; name: string; locked_at: Date }>(
        `SELECT e.path, e.locked_by, e.locked_at, a.name
           FROM fs_entries e JOIN accounts a ON a.id = e.locked_by
          WHERE e.path = ANY($1) AND e.locked_by IS NOT NULL`,
        [ps],
      );
      for (const row of r.rows) {
        out.set(row.path, {
          lockedBy: row.locked_by,
          lockedByName: row.name,
          lockedAt: row.locked_at,
        });
      }
      return out;
    });
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Refuse a mutation if the target path OR any ancestor directory is locked.
   * Runs inside the mutator's txn (after the advisory lock), so RLS scopes the
   * lock rows to what the caller can see — a lock in a foreign home is
   * unreachable anyway (that write is refused by scope first). The join to
   * accounts names the locker in the teaching error. ELOCKED is a raw Error
   * with a `code`, distinct from validation/refused so callers can key on it.
   *
   * `subtree: true` additionally refuses when any DESCENDANT of `path` is
   * locked. Ancestor-only checking is right for a single-path mutation (write,
   * append, non-recursive rm, restore), but WRONG for an operation whose blast
   * radius is the whole subtree: `rm -r /shared/proj` and `mv /shared/proj …`
   * both destroy/relocate every row under `path`, so a lock anywhere below must
   * refuse them. Without this, `rm -r` of an UNLOCKED parent silently deleted a
   * locked child (lock row and all) and the attacker could then recreate the
   * protected path with their own bytes — a full lock bypass. The check runs
   * before any snapshot/DELETE in the caller's txn, so a refusal leaves ZERO
   * rows touched. Single-path mutators keep the cheap self+ancestor form.
   */
  private async assertNotLocked(
    c: PoolClient,
    path: string,
    opts: { subtree?: boolean } = {},
  ): Promise<void> {
    // rank 0 = self/ancestor, 1 = descendant: a direct/ancestor lock is the
    // more precise thing to name, so it wins when both exist; within a rank the
    // deepest locked path is reported.
    const r = await c.query<{ path: string; name: string }>(
      `SELECT e.path, a.name
         FROM fs_entries e JOIN accounts a ON a.id = e.locked_by
        WHERE e.locked_by IS NOT NULL
          AND ($1 = e.path OR left($1, char_length(e.path) + 1) = e.path || '/'
               ${opts.subtree ? "OR left(e.path, char_length($1) + 1) = $1 || '/'" : ""})
        ORDER BY (CASE WHEN char_length(e.path) <= char_length($1) THEN 0 ELSE 1 END),
                 length(e.path) DESC
        LIMIT 1`,
      [path],
    );
    const hit = r.rows[0];
    if (hit) {
      const err = new Error(
        `ELOCKED: ${hit.path} is locked by ${hit.name} — ask them to unlock it in the dashboard`,
      ) as Error & { code: string };
      err.code = "ELOCKED";
      throw err;
    }
  }

  /**
   * Snapshot the CURRENT row's bytes into fs_versions BEFORE it is overwritten
   * (called inside the mutation txn, after the advisory lock). Text-ish files
   * under the cap only; a new file (no prior row) or a binary/oversized one
   * snapshots nothing. owner_id is copied from the live row so the snapshot
   * inherits the exact RLS scope of what it captured; version_no is the next
   * per-path integer.
   *
   * A ZERO-BYTE prior row snapshots nothing either, and that guard is
   * load-bearing, not an optimisation. A shell `>` redirect (and `cat > f
   * <<EOF`) is truncate-THEN-write in the sandbox: two FsStore mutations on one
   * path, so a naive snapshot fires twice — once capturing the real prior text,
   * once capturing the 0-byte truncation it just made. The empty row then
   * becomes the NEWEST version, and `restore <path>` with no version
   * (`ORDER BY version_no DESC LIMIT 1`) recreated the file EMPTY — the undo
   * verb destroying the content it exists to recover. `diff <path>` lied the
   * same way ("+everything", as if the file were new) and half of
   * FS_VERSION_KEEP_PER_PATH was spent on 0B rows. Skipping empties collapses a
   * logical shell overwrite back to exactly ONE snapshot holding the real prior
   * bytes, and a brand-new file created by `>` gets no overwrite version at all
   * (there was no prior content). It is the right rule on its own terms too:
   * an empty file has no content to preserve. Genuinely-empty files are still
   * fully recoverable from an `rm` — that snapshot is taken by rm() itself
   * (reason='delete', guarded by `content IS NOT NULL`), which this does not
   * touch.
   *
   * `next` — the exact bytes the file will hold once the caller's mutation
   * lands — turns the same principle on the OTHER end: a write that changes
   * nothing has no prior state worth preserving either, so byte-identical
   * bytes snapshot nothing. Agents re-emit whole files constantly (a formatter
   * that changed nothing, a re-run script, a "save" of untouched text), and
   * every such no-op used to burn a slot: ten of them evicted the last REAL
   * revision out of FS_VERSION_KEEP_PER_PATH and left `history` showing ten
   * copies of the live file, `diff <path>` empty, and `restore <path>` handing
   * back the bytes already on disk. Same rule, same reason as the empty guard:
   * ONE logical edit, ONE snapshot, and a non-edit gets none. (A zero-byte
   * `append` is the same non-edit; append() skips it for the same reason.)
   *
   * `force` drops ONLY the versionable filter (never the "nothing to capture"
   * guards): it is what restore() preserves a live file with. A roll-back
   * REPLACES content the caller is about to lose, so the write path's
   * text-ish/1 MiB filter — a cost heuristic for routine overwrites — must not
   * decide whether those bytes survive; unfiltered is the same rule
   * `snapshotRemovedFiles` applies to an rm, and the per-path + global budget
   * caps bound it the same way. Returns the snapshot it took, or null.
   */
  private async snapshotIfVersionable(
    c: PoolClient,
    ctx: FsCtx,
    path: string,
    opts: { force?: boolean; next?: Buffer } = {},
  ): Promise<{ version_no: number; size_bytes: number } | null> {
    const cur = await c.query<{
      content: Buffer | null;
      size_bytes: string;
      mime: string | null;
      owner_id: string | null;
    }>(
      "SELECT content, size_bytes, mime, owner_id FROM fs_entries WHERE path = $1 AND kind = 'file'",
      [path],
    );
    const row = cur.rows[0];
    if (!row || row.content === null) return null; // new file or dir → nothing prior
    if (row.content.length === 0) return null; // truncation half of `>` → nothing prior
    if (opts.next && row.content.equals(opts.next)) return null; // no-op write → nothing changed
    if (!opts.force && !isVersionable(row.mime, Number(row.size_bytes), path, row.content))
      return null;
    // The newest surviving snapshot AND the path's high-water mark in one trip:
    // the mark is what makes a version_no an identifier rather than a position
    // (see nextVersionNo), and the LATERAL keeps it answerable for a path that
    // has no snapshots left at all — which is exactly the case that matters.
    const head = await c.query<{
      version_no: number | null;
      reason: string | null;
      sha256: string | null;
      floor: number | string | null;
    }>(
      `SELECT h.version_no, h.reason, h.sha256, ${await this.versionFloorSql(c, "$1")} AS floor
         FROM (SELECT 1) AS one
         LEFT JOIN LATERAL (
           SELECT version_no, reason, sha256 FROM fs_versions WHERE path = $1
            ORDER BY version_no DESC, created_at DESC, id DESC LIMIT 1) h ON true`,
      [path],
    );
    const top = head.rows[0];
    const prevSnap =
      top && top.version_no !== null
        ? { version_no: Number(top.version_no), reason: top.reason, sha256: top.sha256 }
        : undefined;
    const floor = Number(top?.floor ?? 0);
    const sha = createHash("sha256").update(row.content).digest("hex");
    // Two CONSECUTIVE overwrite snapshots with the same bytes can only mean the
    // edit between them produced what it started from — a no-op — so the second
    // records a state history already holds. Dropping it is lossless, and it is
    // the only guard that catches a no-op arriving as a shell `>`: that lands as
    // truncate-THEN-append, so the store never sees the final bytes next to the
    // prior ones and `next` above cannot fire. Without it, a dozen re-saves of
    // unchanged text filled all FS_VERSION_KEEP_PER_PATH slots with copies of
    // the live file and EVICTED the last real revision — the retention budget
    // spent on non-edits, exactly like the 0-byte rows before it.
    // `force` (restore's preserve) is exempt: that snapshot is unconditional by
    // doctrine, and its caller reports what it kept.
    if (!opts.force && prevSnap?.reason === "overwrite" && prevSnap.sha256 === sha) return null;
    // The allocation is `max + 1` off a plain read, and the read alone
    // guarantees nothing: this call holds the FILE's advisory lock, an `rm -r`
    // of an ancestor holds the DIRECTORY's — different keys — so both once read
    // the same max and both wrote it. An rm -r now takes those file keys up
    // front (lockSnapshotTargets), and this is the backstop underneath it:
    // `ON CONFLICT DO NOTHING` under 0047's unique (path, version_no) index
    // turns a lost race into zero rows instead of a duplicate, and the retry
    // re-reads the max. Arbiter-less on purpose: a box whose 0047 could not
    // build the index (pre-existing duplicates it refused to renumber) still
    // inserts exactly as before, rather than every write dying on a missing
    // arbiter.
    //
    // `floor` is the other half of the allocation: the max is taken over rows
    // that still EXIST, so without the high-water mark a fully-evicted path
    // restarted at 1 and reissued numbers that already named other bytes.
    let versionNo = Math.max(prevSnap?.version_no ?? 0, floor) + 1;
    let insertedId: string | null = null;
    for (let attempt = 0; insertedId === null && attempt < VERSION_INSERT_ATTEMPTS; attempt++) {
      if (attempt > 0) versionNo = await this.nextVersionNo(c, path, attempt);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO fs_versions
           (path, version_no, reason, content, size_bytes, sha256, mime, owner_id, edited_by)
         VALUES ($1, $2, 'overwrite', $3, $4, $8, $5, $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [path, versionNo, row.content, row.size_bytes, row.mime, row.owner_id, ctx.actorId, sha],
      );
      insertedId = ins.rows[0]?.id ?? null;
    }
    if (insertedId === null) throw versionRaceError(path);
    // Same rule as an rm's trash: the snapshot this call just took is the LAST
    // thing eviction may reclaim, never a victim of its own housekeeping pass.
    // If it was reclaimed anyway (one file bigger than the entire budget), say
    // so by returning null rather than naming a version_no that no longer
    // exists — restore()'s `preserved` is a promise the caller relies on.
    const dropped = await this.evictVersions(c, path, [{ id: insertedId, path }]);
    if (dropped.length > 0) return null;
    return { version_no: versionNo, size_bytes: Number(row.size_bytes) };
  }

  /**
   * The next free version_no for `path`, re-read after a conflict — the retry
   * half of the allocation above.
   *
   * Deliberately LOCK-FREE. Every advisory key an op needs is taken in txn()'s
   * preamble, before a single row lock; grabbing one here, mid-transaction and
   * behind row locks this txn already holds, is how a retry deadlocks (the
   * op that beat us is typically waiting on one of those rows). So the retry
   * waits on nothing, re-reads, and reallocates — and if it keeps losing, the
   * caller refuses loudly with everything rolled back. The short backoff is
   * just politeness towards a winner that has not committed yet.
   *
   * `greatest(max, floor)` — never a bare max. Eviction destroys numbers, and a
   * number that gets destroyed and then handed out AGAIN is not an identifier:
   * `restore <path> 3` typed from yesterday's `history` would quietly bind to
   * whatever v3 means today. The floor (migration 0048's fs_version_seq, written
   * by the reaper itself) is the per-path high-water mark that eviction cannot
   * reach, so the sequence only ever climbs and a gap means "evicted".
   */
  private async nextVersionNo(c: PoolClient, path: string, attempt: number): Promise<number> {
    if (attempt > 1) await c.query("SELECT pg_sleep($1)", [0.02 * (attempt - 1)]);
    const r = await c.query<{ next: number }>(
      `SELECT greatest(coalesce(max(version_no), 0), ${await this.versionFloorSql(c, "$1")}) + 1
              AS next
         FROM fs_versions WHERE path = $1`,
      [path],
    );
    return Number(r.rows[0]?.next ?? 1);
  }

  /**
   * The SQL for "the highest version_no ever ISSUED for this path" — 0048's
   * `brain_fs_version_floor`, or a literal 0 on a box whose 0048 has not landed
   * yet (numbering then behaves exactly as it did before, rather than every
   * write failing on a missing function: history must never be able to fail a
   * live write). The probe is a catalog lookup that returns NULL rather than
   * erroring, and its answer is remembered for the process.
   *
   * Read-only and lock-free by construction — the mark is WRITTEN only by the
   * reaper, inside the savepoint that already makes housekeeping best-effort, so
   * the allocation path never blocks on anybody's row lock to get a number.
   */
  private async versionFloorSql(c: PoolClient, pathArg: string): Promise<string> {
    if (this.versionFloorFn === null) {
      const r = await c.query<{ ok: boolean }>(
        "SELECT to_regprocedure('brain_fs_version_floor(text)') IS NOT NULL AS ok",
      );
      this.versionFloorFn = r.rows[0]?.ok === true;
    }
    return this.versionFloorFn ? `brain_fs_version_floor(${pathArg})` : "0";
  }

  /** The highest version_no ever issued for `path` (0 when nothing ever was). */
  private async versionFloor(c: PoolClient, path: string): Promise<number> {
    const expr = await this.versionFloorSql(c, "$1");
    if (!this.versionFloorFn) return 0; // pre-0048 box: nothing remembers
    const r = await c.query<{ floor: number | string }>(`SELECT ${expr} AS floor`, [path]);
    return Number(r.rows[0]?.floor ?? 0);
  }

  /**
   * Why a named version isn't there. Version numbers are never reused (0048),
   * so the high-water mark separates the two facts a bare "no version 3" used to
   * blur: a number at or below the mark WAS issued and has since aged out of the
   * bounded history — the caller's note was right and those bytes are gone —
   * while anything above it never existed. Telling them apart is the difference
   * between "restore something else instead" and "you typed the wrong number".
   */
  private async missingVersionError(c: PoolClient, p: string, versionNo: number): Promise<Error> {
    const flat = validationError(`no version ${versionNo} for ${p}`, { errno: "ENOENT" });
    // The high-water mark comes from brain_fs_version_floor — SECURITY DEFINER,
    // owned by the BYPASSRLS role — so it answers for paths this caller can NOT
    // see. Branching on it unconditionally turned the wording into an existence
    // AND edit-count oracle over another member's home: "was evicted" vs "no
    // version N" is binary-searchable, and it fired even inside an obo-narrowed
    // session that 0046 had correctly blinded. Every other read here is a
    // uniform ENOENT precisely so absence carries no information; this must
    // match. Only tell the two apart once the caller can already observe
    // SOMETHING at this path under their OWN RLS — a live row or a surviving
    // snapshot. For anything they cannot see, the flat miss is the whole answer.
    const seen = await c.query(
      `SELECT 1 AS v
         WHERE EXISTS (SELECT 1 FROM fs_entries  WHERE path = $1)
            OR EXISTS (SELECT 1 FROM fs_versions WHERE path = $1)`,
      [p],
    );
    if (!seen.rows[0]) return flat;
    const floor = await this.versionFloor(c, p);
    return versionNo <= floor
      ? validationError(
          `version ${versionNo} of ${p} was evicted — history is bounded, so old versions age out; run \`history ${p}\` for what is still kept`,
          { errno: "ENOENT" },
        )
      : flat;
  }

  /**
   * Snapshot every FILE about to be REMOVED at/under `path` (reason='delete'),
   * in the caller's txn, immediately before the fs_entries rows go. Used by
   * BOTH removal paths — `rm` (single or recursive) and the destination-clobber
   * half of `rename` — because the trash guarantee is about bytes disappearing,
   * not about which verb made them disappear.
   *
   * Deliberately unconditional (all types, not just the text-ish/1 MiB set
   * `snapshotIfVersionable` gates OVERWRITES with): a delete must be fully
   * undoable, so binaries are captured too. The only guards are the ones that
   * mean "there is nothing to capture" — kind='file' (dirs carry no bytes) and
   * `content IS NOT NULL`. owner_id is copied from the live row so each
   * snapshot inherits the exact RLS scope of what it captured; version_no is
   * the next per-path integer. Eviction keeps the new rows budget-bounded.
   *
   * This is the side of the version-number race that had NO lock to stand on: a
   * recursive rm held the advisory key of the DIRECTORY only, so a concurrent
   * write to a file underneath (holding that FILE's key) allocated the same
   * `max + 1` and both rows landed — one version number, two different bodies,
   * on the pair `versionContent`/`restore`/`versionList` key on. rm now takes
   * every descendant's key up front (lockSnapshotTargets), which is the actual
   * serialization; what remains here is the backstop for the two cases a lock
   * cannot cover — a subtree past the lock cap, and a file that committed under
   * `path` after the keys were taken:
   *  - 0047's unique (path, version_no) index refuses the duplicate outright;
   *  - `ON CONFLICT DO NOTHING` (arbiter-less on purpose, so a box whose 0047
   *    could not build the index behaves exactly as it did before) turns that
   *    into a skipped row instead of an aborted rm;
   *  - the statement reports its own candidate list, so a skipped path is
   *    retried with a freshly-read number.
   * A delete snapshot IS the trash guarantee, so it is never silently dropped:
   * if a path still cannot be captured, the rm refuses and rolls back with
   * nothing removed.
   */
  private async snapshotRemovedFiles(
    c: PoolClient,
    ctx: FsCtx,
    path: string,
    recursive: boolean,
  ): Promise<string[]> {
    const taken: Array<{ id: string; path: string }> = [];
    const done = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      const donePos = recursive ? 4 : 3;
      const r = await c.query<{
        candidates: string[] | null;
        inserted: Array<{ id: string; path: string }> | null;
      }>(
        // `cand` is referenced twice, so Postgres materializes it: the rows the
        // INSERT consumed are exactly the rows `candidates` reports, and the
        // difference between the two is the set that lost a race.
        `WITH cand AS (
           SELECT e.path,
                  greatest(coalesce((SELECT max(v.version_no) FROM fs_versions v
                                      WHERE v.path = e.path), 0),
                           ${await this.versionFloorSql(c, "e.path")}) + 1 AS version_no,
                  e.content, e.size_bytes, e.sha256, e.mime, e.owner_id
             FROM fs_entries e
            WHERE e.kind = 'file' AND e.content IS NOT NULL
              AND (e.path = $1${recursive ? " OR e.path LIKE $3" : ""})
              AND e.path <> ALL ($${donePos}::text[])),
         ins AS (
           INSERT INTO fs_versions
             (path, version_no, reason, content, size_bytes, sha256, mime, owner_id, edited_by)
           SELECT c.path, c.version_no, 'delete', c.content, c.size_bytes, c.sha256, c.mime,
                  c.owner_id, $2
             FROM cand c
           ON CONFLICT DO NOTHING
           RETURNING id, path)
         SELECT (SELECT array_agg(path) FROM cand) AS candidates,
                (SELECT json_agg(json_build_object('id', id, 'path', path)) FROM ins) AS inserted`,
        recursive
          ? [path, ctx.actorId, likeChildren(path), [...done]]
          : [path, ctx.actorId, [...done]],
      );
      const got = r.rows[0]?.inserted ?? [];
      for (const g of got) {
        taken.push(g);
        done.add(g.path);
      }
      const missing = (r.rows[0]?.candidates ?? []).filter((p) => !done.has(p));
      if (missing.length === 0) break;
      if (attempt >= VERSION_INSERT_ATTEMPTS - 1) throw versionRaceError(missing[0]!);
      // Lock-free, like nextVersionNo: this transaction already holds row locks
      // the winner may be waiting on, so waiting on the winner in turn is a
      // deadlock, not a retry.
      await c.query("SELECT pg_sleep($1)", [0.02 * (attempt + 1)]);
    }
    return this.evictVersions(c, path, taken);
  }

  /**
   * Bound version history after a snapshot INSERT (same txn). Two caps: keep at
   * most FS_VERSION_KEEP_PER_PATH overwrite versions for THIS path, then, if the
   * table's total bytes exceed the global budget, drop the oldest rows across
   * every path until it fits.
   *
   * The work happens inside `brain_fs_evict_versions` (migration 0045), a
   * SECURITY DEFINER function owned by brain_system, and that elevation is the
   * point. fs_versions is FORCE-RLS, and the policy governs a DELETE and an
   * aggregate exactly as it governs a SELECT — so running this on the writer's
   * own brain_app txn scoped BOTH the measurement (`sum(size_bytes)`) and the
   * victim set to shared rows plus that writer's own home. The "global" budget
   * was quietly per-actor: the table grew linearly with headcount, and a
   * member's stale home snapshots were unreclaimable by anyone else because
   * nobody else could see them. Housekeeping is not a read; the budget is a
   * property of the whole table, so it must be evaluated over the whole table.
   * The function discloses nothing in return — its only result is the subset of
   * the ids THIS caller passed in (see 0045).
   *
   * It is also best-effort by contract: history must never be able to fail a
   * live write. The call runs under a SAVEPOINT, so if the reaper errors (or is
   * missing — a box mid-update whose migration has not landed) the failure is
   * rolled back to the savepoint and swallowed, leaving the caller's snapshot
   * and the real write intact. Worst case the table stays briefly over budget
   * and the next write trims it.
   *
   * `ownIds` are the rows THIS operation just inserted, and they are evicted
   * LAST — never in the same pass as everybody else's history. That ordering is
   * the whole point, not a nicety. The global pass ranks victims by age, and a
   * single `rm -r` inserts its entire subtree's trash in ONE statement, so every
   * one of those rows shares the transaction's `now()`: once the op's own bytes
   * exceeded the budget the pass walked straight into the op's OWN trash and
   * hard-deleted most of it — while `rm` returned a plain success and `restore`
   * then failed with "no version to restore". Worse, the tie on `created_at`
   * fell through to the random uuid `id`, so WHICH of your files became
   * unrecoverable was a different coin flip on every run. This is reachable on
   * stock settings: the live quota is 2 GiB against a 256 MiB version budget, so
   * any `rm -r` of a subtree over 256 MiB used to shred part of itself. Now the
   * op's own snapshots survive the first pass unconditionally; only if they
   * ALONE still blow the budget does a second pass trim them — deterministically
   * (path, version_no) and returning every path it dropped, so the caller can
   * say out loud which files are NOT in the trash. Silence never means "most of
   * this is gone".
   *
   * Ordering everywhere is `created_at, path, version_no` — total and stable —
   * so which history ages out is reproducible rather than uuid roulette. The
   * prefix rule deletes through the row that crosses the excess
   * (`running - size_bytes < excess`), not the last one strictly under it, so
   * the table actually lands at-or-under budget instead of hovering above it
   * forever.
   *
   * Returns the paths whose just-taken snapshot could not be retained (empty in
   * every normal case).
   */
  private async evictVersions(
    c: PoolClient,
    path: string,
    own: readonly { id: string; path: string }[] = [],
  ): Promise<string[]> {
    const ownIds = own.map((o) => o.id);
    // The savepoint is what keeps history from ever failing a live write: an
    // error inside a transaction poisons the WHOLE transaction, so a try/catch
    // alone would still take the caller's write down with it.
    await c.query("SAVEPOINT fs_evict");
    try {
      const r = await c.query<{ dropped: string[] | null }>(
        "SELECT brain_fs_evict_versions($1::bigint, $2::text, $3::int, $4::uuid[]) AS dropped",
        [this.versionBudgetBytes, path, FS_VERSION_KEEP_PER_PATH, ownIds],
      );
      await c.query("RELEASE SAVEPOINT fs_evict");
      // The reaper hands back only ids we ourselves passed in; the paths are
      // ours to resolve locally, so nothing about anyone else's rows crosses
      // the function boundary.
      const droppedIds = new Set(r.rows[0]?.dropped ?? []);
      return own
        .filter((o) => droppedIds.has(o.id))
        .map((o) => o.path)
        .sort();
    } catch (err) {
      await c.query("ROLLBACK TO SAVEPOINT fs_evict");
      await c.query("RELEASE SAVEPOINT fs_evict");
      // Nothing was evicted (the rollback undid any partial pass), so report no
      // casualties — the snapshot the caller just took is intact. The table may
      // sit over budget until the next write retries.
      console.warn(
        `fs: version eviction skipped for ${path} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Ensure `dir` and its ancestors exist (idempotent INSERTs), walking up
   * only to the fixed roots — those are seeded by 0037 and never re-created.
   * An ancestor that exists as a file surfaces as the trigger's fs_no_parent
   * on the child insert, mapped to ENOTDIR.
   */
  private async mkdirChain(c: PoolClient, ctx: FsCtx, dir: string): Promise<void> {
    const chain: string[] = [];
    let cur = dir;
    while (cur !== "/" && cur !== "/shared" && cur !== "/home" && !isHomeRoot(cur)) {
      chain.unshift(cur);
      cur = parentOf(cur);
    }
    for (const d of chain) {
      await c.query(
        `INSERT INTO fs_entries (path, parent, name, kind, created_by, updated_by)
         VALUES ($1, $2, $3, 'dir', $4, $4) ON CONFLICT (path) DO NOTHING`,
        [d, parentOf(d), baseName(d), ctx.actorId],
      );
    }
  }

  /**
   * Adjust the usage counter (same txn as the write — the singleton row lock
   * is held only for the tail of the transaction) and enforce the quota on
   * growth. A rejected write rolls back the whole op, counter included.
   */
  private async bumpUsage(c: PoolClient, delta: number): Promise<void> {
    if (delta === 0) return;
    const r = await c.query<{ total_bytes: string }>(
      "UPDATE fs_usage SET total_bytes = total_bytes + $1 WHERE singleton RETURNING total_bytes",
      [delta],
    );
    const total = Number(r.rows[0]?.total_bytes ?? 0);
    if (delta > 0 && total > this.quotaBytes) {
      throw refusedError(
        `ENOSPC: brain filesystem is full (${fmtBytes(total - delta)} of ${fmtBytes(this.quotaBytes)}) — delete files you no longer need`,
        "delete files under /shared or your home that you no longer need, then retry",
        { errno: "ENOSPC" },
      );
    }
  }
}

const isHomeRoot = (p: string): boolean => p.startsWith("/home/") && !p.includes("/", 6);
