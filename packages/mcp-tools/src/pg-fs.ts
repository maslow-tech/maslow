import { posix } from "node:path";
import { DefenseInDepthBox, InMemoryFs, type FsStat, type IFileSystem } from "just-bash";
import { isBrainError } from "@brain/shared";
import { MAX_FILE_BYTES, type FsCtx, type FsEntryMeta, type FsStore } from "./fs-store.js";

/**
 * PgFs — the write-through IFileSystem adapter that mounts the brain
 * filesystem (FsStore over fs_entries) into just-bash (spike verdict in
 * fs-bridge.spike.test.ts).
 *
 * Shape of the sandbox namespace (assembled by runBash in bash.ts):
 *
 *   MountableFs base   guardedBase()            — /tmp scratch, all else refuses
 *   mounted /shared    PgFs(root "/shared")     — persistent, org-visible
 *   mounted /home      homeStubFs(slug, PgFs(root "/home/<slug>"))
 *                                               — lists ONLY your slug; foreign
 *                                                 homes are absent (ENOENT) and
 *                                                 foreign writes refuse loudly
 *
 * (MountableFs forbids nested mounts, so /home/<slug> cannot be its own mount
 * point under a /home stub — homeStubFs routes the slug subtree instead.)
 *
 * Load-bearing invariants, each proven by the Task 0 spike or the probe runs:
 *
 * - MountableFs hands every mounted fs MOUNT-RELATIVE paths ("/" is the mount
 *   root). PgFs re-prefixes with its root before touching the store, so the
 *   store — and RLS under it — always sees real absolute brain paths.
 * - just-bash's defense-in-depth (ON by default) patches globalThis timers
 *   during exec, and pg-pool schedules timers on connect/idle-release. Every
 *   store round-trip therefore runs under DefenseInDepthBox.runTrustedAsync —
 *   the one documented escape hatch for trusted host extensions.
 * - Live write-through: each writeFile/mkdir/rm/mv IS the persistence (one
 *   short store transaction). The exception is append coalescing: `>>` loops
 *   buffer consecutive appends per path (a 10k-iteration loop becomes a
 *   handful of UPDATEs, not 10k TOAST rewrites) and flush on read-of-path,
 *   any structural op, a 1 MiB high-water mark, or flushAll() at exec end —
 *   which runBash awaits BEFORE reporting, so a returned result never claims
 *   bytes that aren't in Postgres. A path a LOCK already refuses is never
 *   buffered at all (assertAppendable probes once per path per exec): a `>>`
 *   that cannot land has to fail AT the redirect, like `>`, or the script's
 *   `&&` successor runs on a success that never happened. Buffering is per
 *   PATH and so is FAILURE:
 *   a path that cannot flush (locked, over the size cap, a transient store
 *   error) costs that path only — every other queued path is still flushed,
 *   the failing path keeps its bytes buffered, and the reported error names
 *   EVERY path whose bytes did not land ("… — NOT SAVED: a, b").
 * - Per-exec memo caches for stat/readdir (readdir primes the stat cache, so
 *   `ls -l` and `find` cost one list per directory, not one stat per entry),
 *   invalidated on every mutation. PgFs instances live for ONE exec.
 */

/** just-bash doesn't ship security/*.d.ts — type the one member we use. */
const trustedRunner = DefenseInDepthBox as unknown as {
  runTrustedAsync<T>(fn: () => Promise<T>): Promise<T>;
};

type ReadFileArgs = Parameters<IFileSystem["readFile"]>;
type WriteFileOpts = Parameters<IFileSystem["writeFile"]>[2];
type MkdirOpts = Parameters<IFileSystem["mkdir"]>[1];
type RmOpts = Parameters<IFileSystem["rm"]>[1];
type CpOpts = Parameters<IFileSystem["cp"]>[2];
type ByteStr = Awaited<ReturnType<NonNullable<IFileSystem["readFileBytes"]>>>;
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** Coalesce buffered appends up to this size before forcing a flush. */
const APPEND_FLUSH_BYTES = 1024 * 1024;

const WRITABLE_ROOTS_TEACHING =
  "only /shared, /home/<you> and /tmp are writable; /tmp is scratch that vanishes when the script ends";

const enoent = (p: string): Error => new Error(`ENOENT: no such file or directory: ${p}`);

const eacces = (p: string): Error =>
  new Error(`EACCES: cannot write ${p}: ${WRITABLE_ROOTS_TEACHING}`);

const notSupported = (what: string): Error =>
  new Error(
    `ENOTSUP: ${what} are not supported on the brain filesystem — cp the file instead, and reference files by their absolute path`,
  );

const isNotFound = (e: unknown): boolean => isBrainError(e) && e.code === "not_found";

/** One pending path whose buffered bytes did not reach Postgres. */
interface FlushFailure {
  readonly path: string;
  readonly error: unknown;
}

const errCode = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null ? (e as { code?: unknown }).code?.toString() : undefined;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * ONE error naming EVERY path whose buffered bytes did not land. A flush that
 * fails on one path must never be reported as if it were the only casualty:
 * the caller has to be able to tell, from the message alone, exactly which
 * files lost bytes their script believed were written. `code` survives only
 * when every failure agrees on it (so a lone ELOCKED still reads as ELOCKED
 * for the HTTP/tool mappers).
 */
function flushFailureError(failures: readonly FlushFailure[]): Error {
  const messages = [...new Set(failures.map((f) => errMessage(f.error)))];
  const paths = failures.map((f) => f.path);
  const err = new Error(`${messages.join("; ")} — NOT SAVED: ${paths.join(", ")}`) as Error & {
    code?: string;
  };
  const codes = new Set(failures.map((f) => errCode(f.error)));
  const only = codes.size === 1 ? [...codes][0] : undefined;
  if (only !== undefined) err.code = only;
  return err;
}

function metaToStat(meta: FsEntryMeta): FsStat {
  return {
    isFile: meta.kind === "file",
    isDirectory: meta.kind === "dir",
    isSymbolicLink: false,
    mode: meta.kind === "dir" ? 0o755 : 0o644,
    size: meta.size,
    mtime: meta.updatedAt,
  };
}

function toBuffer(content: string | Uint8Array, options?: WriteFileOpts): Buffer {
  if (typeof content !== "string") return Buffer.from(content);
  const enc = typeof options === "string" ? options : (options?.encoding ?? "utf8");
  return Buffer.from(content, enc === "binary" ? "latin1" : enc);
}

export class PgFs implements IFileSystem {
  private readonly store: FsStore;
  private readonly ctx: FsCtx;
  private readonly root: string;

  /** absolute path → buffered append chunks (consecutive `>>` coalescing). */
  private readonly pending = new Map<string, { chunks: Buffer[]; bytes: number }>();
  /** paths whose lock gate a `>>` already cleared this exec (assertAppendable). */
  private readonly lockProbed = new Set<string>();
  /** absolute path → meta (null = known missing). Per-exec; cleared on mutation. */
  private readonly statCache = new Map<string, FsEntryMeta | null>();
  /** absolute dir path → children metas. Per-exec; cleared on mutation. */
  private readonly listCache = new Map<string, FsEntryMeta[]>();

  private readonly wrotePaths = new Set<string>();
  private readonly deletedPaths = new Set<string>();
  /**
   * Paths an `rm` removed WITHOUT a retainable trash snapshot (the store's
   * FsRmResult.unrecoverable — the delete's own snapshots outweighed the global
   * version budget). Surfaced by runBash as a stderr line: a shell `rm -r` that
   * quietly turned "soft delete" into "gone forever" is exactly the silence the
   * trash guarantee exists to prevent.
   */
  private readonly unrecoverablePaths = new Set<string>();

  constructor(store: FsStore, opts: { ctx: FsCtx; root: "/shared" | `/home/${string}` }) {
    this.store = store;
    this.ctx = opts.ctx;
    this.root = opts.root;
  }

  /** For the tool-result trailer: what this exec durably changed. */
  mutatedPaths(): { wrote: string[]; deleted: string[]; unrecoverable: string[] } {
    return {
      wrote: [...this.wrotePaths],
      deleted: [...this.deletedPaths],
      unrecoverable: [...this.unrecoverablePaths],
    };
  }

  /**
   * Persist every buffered append. runBash awaits this before reporting.
   *
   * SETTLE-ALL, never stop-at-first-failure: paths are independent files, so
   * one path's flush blowing up (a lock taken on it, the size cap, a transient
   * store error) must not cost any OTHER path the bytes its `echo … >>` already
   * reported as written. A stop-at-first loop silently discarded every path
   * still queued behind the failure — data loss the caller could not even see,
   * because the error named only the path that threw. Failing paths keep their
   * bytes buffered (flush() semantics) and are reported together in one error
   * naming all of them.
   */
  async flushAll(): Promise<void> {
    const failures = await this.flushSettled();
    if (failures.length > 0) throw flushFailureError(failures);
  }

  /** Flush every pending path, collecting failures instead of aborting. */
  private async flushSettled(): Promise<FlushFailure[]> {
    const failures: FlushFailure[] = [];
    for (const p of [...this.pending.keys()]) {
      try {
        await this.flush(p);
      } catch (error) {
        failures.push({ path: p, error });
      }
    }
    return failures;
  }

  /**
   * The ordering flush an internal op does before it touches the store (a
   * readdir that must list brand-new buffered files, an rm/cp/mv whose queued
   * appends have to land first). Same settle-all rule, and an UNRELATED path's
   * failure never aborts the op: a locked file elsewhere in the tree must not
   * turn `ls /shared/x` into "No such file or directory". Only a failure on a
   * path the op itself is about is rethrown — there, script order really does
   * depend on those bytes landing first. Everything swallowed here stays
   * buffered and resurfaces from the exec-end flushAll().
   */
  private async flushBefore(isOwn: (p: string) => boolean): Promise<void> {
    const failures = await this.flushSettled();
    const own = failures.find((f) => isOwn(f.path));
    if (own) throw own.error;
  }

  /**
   * Reconcile with a store write made OUTSIDE this mount — the in-sandbox
   * `restore` command (fs-vc-commands.ts) goes straight to FsStore. Buffered
   * appends flush FIRST so queued bytes can never land on top of the external
   * write, then the per-exec memos drop so a later stat/ls/cat in the same
   * script sees the new truth. A mutated path under this root also joins the
   * `persisted:` trailer, exactly as if the script had written it.
   */
  async syncExternal(mutated?: string): Promise<void> {
    await this.flushBefore((p) => p === mutated);
    this.invalidateAll();
    if (mutated !== undefined && (mutated === this.root || mutated.startsWith(`${this.root}/`))) {
      this.recordWrite(mutated);
    }
  }

  // ---- plumbing --------------------------------------------------------------

  /** Mount-relative → absolute brain path ("/" is the mount root itself). */
  private abs(rel: string): string {
    return rel === "/" ? this.root : this.root + rel;
  }

  /** Every store round-trip runs trusted — pg-pool timers vs defense-in-depth. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    return trustedRunner.runTrustedAsync(fn);
  }

  private recordWrite(p: string): void {
    this.deletedPaths.delete(p);
    this.wrotePaths.add(p);
  }

  private recordDelete(p: string): void {
    this.wrotePaths.delete(p);
    this.deletedPaths.add(p);
  }

  private invalidate(p: string): void {
    this.statCache.delete(p);
    this.listCache.delete(p);
    this.listCache.delete(posix.dirname(p));
  }

  private invalidateAll(): void {
    this.statCache.clear();
    this.listCache.clear();
  }

  /**
   * The `>>` gate: refuse a buffered append to a path a lock already protects,
   * AT THE REDIRECT, so the observable contract matches `>`.
   *
   * Append coalescing means the store never sees `echo x >> locked.md` until
   * the exec-end flushAll — so the shell scored the redirect a SUCCESS, took
   * the `&&` branch, and only afterwards did the tool result carry an ELOCKED
   * the script had already acted against (`echo … >> canon.md && rm draft.md`
   * deleted the draft). A lock is a stable, human-set flag, not a transient
   * race: probing it costs one cached read per path per exec and turns the
   * common case honest. The pathological window (locked BETWEEN probe and
   * flush) remains, and is still caught by the mutator's own in-txn check and
   * reported by flushAll's NOT SAVED list.
   *
   * Throwing here aborts the exec, because just-bash opens a redirect target
   * with an unguarded `fs.appendFile(path, "", "binary")` — but that is
   * precisely what a refused `>` already does, and a refusal the script cannot
   * misread beats a refusal it acts against. Only ELOCKED gets that treatment:
   * any OTHER probe failure (a transient store error) falls through to
   * buffering, where the real mutation still enforces and flushAll still
   * reports — a flaky read must never become a killed script.
   */
  private async assertAppendable(p: string): Promise<void> {
    if (this.lockProbed.has(p)) return;
    try {
      await this.run(() => this.store.assertNotLockedForWrite(this.ctx, p));
    } catch (e) {
      if (errCode(e) === "ELOCKED") throw e;
    }
    this.lockProbed.add(p);
  }

  private async flush(p: string): Promise<void> {
    const buf = this.pending.get(p);
    if (!buf) return;
    // Clear the buffer only AFTER the append lands. If the store round-trip
    // throws (transient), the pending bytes stay queued for the next flush /
    // flushAll instead of being silently dropped.
    await this.run(() => this.store.append(this.ctx, p, Buffer.concat(buf.chunks)));
    this.pending.delete(p);
    this.recordWrite(p);
    this.invalidate(p);
  }

  /** stat via the per-exec cache; misses (incl. invisible paths) cache as null. */
  private async statAbs(p: string): Promise<FsEntryMeta | null> {
    const hit = this.statCache.get(p);
    if (hit !== undefined) return hit;
    let meta: FsEntryMeta | null;
    try {
      meta = await this.run(() => this.store.stat(this.ctx, p));
    } catch (e) {
      if (!isNotFound(e)) throw e;
      meta = null;
    }
    this.statCache.set(p, meta);
    return meta;
  }

  /** list via the per-exec cache; children prime the stat cache for free. */
  private async listAbs(p: string): Promise<FsEntryMeta[]> {
    const hit = this.listCache.get(p);
    if (hit !== undefined) return hit;
    const entries = await this.run(() => this.store.list(this.ctx, p));
    this.listCache.set(p, entries);
    for (const e of entries) this.statCache.set(e.path, e);
    return entries;
  }

  // ---- reads -----------------------------------------------------------------

  async readFile(rel: ReadFileArgs[0], options?: ReadFileArgs[1]): Promise<string> {
    const enc = typeof options === "string" ? options : (options?.encoding ?? "utf8");
    const bytes = Buffer.from(await this.readFileBuffer(rel));
    return bytes.toString(enc === "binary" ? "latin1" : (enc ?? "utf8"));
  }

  /** ByteString (latin1-shaped) so binary pipes survive — cat/base64/sha256sum. */
  async readFileBytes(rel: string): Promise<ByteStr> {
    const bytes = Buffer.from(await this.readFileBuffer(rel));
    return bytes.toString("latin1") as unknown as ByteStr;
  }

  async readFileBuffer(rel: string): Promise<Uint8Array> {
    const p = this.abs(rel);
    // A flush that cannot land must not make an EXISTING file read as MISSING.
    // Every coreutil renders ANY readFile throw as "No such file or directory"
    // (cat/head/grep/… all `catch { … }` to that one string), so an ordering
    // flush that hit ELOCKED told the script the protected file was gone —
    // the most misleading possible answer about a file a human deliberately
    // locked. Serve the DURABLE bytes instead: the chunk stays buffered
    // (flush() semantics) and the exec-end flushAll still names the path in
    // its NOT SAVED list, so nothing is swallowed — only the lie is. A read
    // whose path genuinely has no row still reports the flush failure, since
    // there the unlanded bytes ARE the whole file.
    let flushError: unknown;
    try {
      await this.flush(p);
    } catch (e) {
      flushError = e;
    }
    try {
      const r = await this.run(() => this.store.read(this.ctx, p));
      return new Uint8Array(r.bytes);
    } catch (e) {
      if (flushError !== undefined && isNotFound(e)) throw flushError;
      throw e;
    }
  }

  async exists(rel: string): Promise<boolean> {
    const p = this.abs(rel);
    if (this.pending.has(p)) return true;
    try {
      return (await this.statAbs(p)) !== null;
    } catch {
      // malformed path (control chars, traversal) — nothing to see, not an error
      return false;
    }
  }

  async stat(rel: string): Promise<FsStat> {
    const p = this.abs(rel);
    const pend = this.pending.get(p);
    const meta = await this.statAbs(p);
    if (!meta && !pend) throw enoent(p);
    if (meta && meta.kind === "dir") return metaToStat(meta);
    // a file with buffered appends stats at its post-flush size
    const size = (meta?.size ?? 0) + (pend?.bytes ?? 0);
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size,
      mtime: pend ? new Date() : (meta as FsEntryMeta).updatedAt,
    };
  }

  async lstat(rel: string): Promise<FsStat> {
    return this.stat(rel); // no symlinks on the brain filesystem
  }

  async readdir(rel: string): Promise<string[]> {
    // buffered brand-new files must appear in listings — but a path that can't
    // flush is a missing entry, never a failed listing (see flushBefore).
    await this.flushBefore(() => false);
    const entries = await this.listAbs(this.abs(rel));
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(rel: string): Promise<DirentEntry[]> {
    await this.flushBefore(() => false);
    const entries = await this.listAbs(this.abs(rel));
    return entries.map((e) => ({
      name: e.name,
      isFile: e.kind === "file",
      isDirectory: e.kind === "dir",
      isSymbolicLink: false,
    }));
  }

  async readlink(rel: string): Promise<string> {
    throw new Error(`EINVAL: ${this.abs(rel)} is not a symbolic link`);
  }

  async realpath(rel: string): Promise<string> {
    if (await this.exists(rel)) return rel === "/" ? "/" : posix.normalize(rel);
    throw enoent(this.abs(rel));
  }

  resolvePath(base: string, path: string): string {
    return posix.resolve(base || "/", path);
  }

  /** Globs walk readdir+stat (probed); nothing needs the full tree. */
  getAllPaths(): string[] {
    return [];
  }

  // ---- writes (each one IS the persistence) -----------------------------------

  async writeFile(
    rel: string,
    content: string | Uint8Array,
    options?: WriteFileOpts,
  ): Promise<void> {
    const p = this.abs(rel);
    this.pending.delete(p); // truncating write supersedes buffered appends
    const meta = await this.run(() => this.store.write(this.ctx, p, toBuffer(content, options)));
    this.invalidateAll();
    this.statCache.set(p, meta);
    this.recordWrite(p);
  }

  async appendFile(
    rel: string,
    content: string | Uint8Array,
    options?: WriteFileOpts,
  ): Promise<void> {
    const p = this.abs(rel);
    if (this.ctx.readOnly) {
      // don't buffer what can never land — surface EROFS on THIS op
      await this.run(() => this.store.append(this.ctx, p, toBuffer(content, options)));
      return;
    }
    // …and for exactly that reason, don't buffer what a LOCK can never let
    // land either. See assertAppendable: without it `>>` scored a locked
    // redirect a success and the script's `&&` successor ran.
    await this.assertAppendable(p);
    const chunk = toBuffer(content, options);
    const buf = this.pending.get(p) ?? { chunks: [], bytes: 0 };
    buf.chunks.push(chunk);
    buf.bytes += chunk.length;
    this.pending.set(p, buf);
    if (buf.bytes >= Math.min(APPEND_FLUSH_BYTES, MAX_FILE_BYTES)) await this.flush(p);
  }

  async mkdir(rel: string, options?: MkdirOpts): Promise<void> {
    const p = this.abs(rel);
    await this.flush(p);
    if (!options?.recursive) {
      if ((await this.statAbs(p)) !== null) {
        throw new Error(`EEXIST: file already exists, mkdir '${p}'`);
      }
      if (p !== this.root && (await this.statAbs(posix.dirname(p))) === null) throw enoent(p);
    }
    await this.run(() => this.store.mkdir(this.ctx, p)); // -p semantics in the store
    this.invalidateAll();
    this.recordWrite(p);
  }

  async rm(rel: string, options?: RmOpts): Promise<void> {
    const p = this.abs(rel);
    // script-order: earlier appends land, then die with the rm. Only THIS
    // path's (or subtree's) flush failure aborts the rm.
    await this.flushBefore(
      (q) => q === p || (options?.recursive === true && q.startsWith(`${p}/`)),
    );
    try {
      const res = await this.run(() => this.store.rm(this.ctx, p, options?.recursive ?? false));
      this.recordDelete(p);
      for (const lost of res.unrecoverable) this.unrecoverablePaths.add(lost);
    } catch (e) {
      if (!(options?.force && isNotFound(e))) throw e;
    }
    this.invalidateAll();
  }

  async cp(src: string, dest: string, options?: CpOpts): Promise<void> {
    const from = this.abs(src);
    const to = this.abs(dest);
    await this.flushBefore((q) => q === from || q === to || q.startsWith(`${from}/`));
    await this.copyTree(from, to, options);
    this.invalidateAll();
    this.recordWrite(to);
  }

  private async copyTree(from: string, to: string, options?: CpOpts): Promise<void> {
    const meta = await this.statAbs(from);
    if (!meta) throw enoent(from);
    if (meta.kind === "file") {
      const r = await this.run(() => this.store.read(this.ctx, from));
      await this.run(() => this.store.write(this.ctx, to, r.bytes, r.meta.mime ?? undefined));
      return;
    }
    if (!options?.recursive) throw new Error(`EISDIR: ${from} is a directory (not copied)`);
    await this.run(() => this.store.mkdir(this.ctx, to));
    for (const child of await this.listAbs(from)) {
      await this.copyTree(child.path, `${to}/${child.name}`, options);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    const from = this.abs(src);
    const to = this.abs(dest);
    await this.flushBefore((q) => q === from || q === to || q.startsWith(`${from}/`));
    await this.run(() => this.store.rename(this.ctx, from, to));
    this.invalidateAll();
    this.recordDelete(from);
    this.recordWrite(to);
  }

  // ---- un-Unix edges ------------------------------------------------------------

  async chmod(_rel: string, _mode: number): Promise<void> {
    // accepted no-op: mode bits don't persist on the brain filesystem
  }

  async utimes(_rel: string, _atime: Date, _mtime: Date): Promise<void> {
    // accepted no-op: mtime is updated_at, maintained by the store
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw notSupported("symlinks");
  }

  async link(_existing: string, _newPath: string): Promise<void> {
    throw notSupported("hard links");
  }
}

/**
 * The /home mount: privacy by absence. Lists ONLY the caller's slug, routes
 * the caller's own subtree into their PgFs home, answers uniform ENOENT for
 * every other name (a foreign home is indistinguishable from a missing path
 * — no permission-denied oracle), and refuses every write outside the
 * caller's home with the teaching error. Nothing here ghost-persists:
 * the only writable route is the real PgFs mount.
 *
 * (MountableFs forbids nested mounts, so the home PgFs is routed through
 * this stub rather than mounted at /home/<slug> directly — the plan's two
 * separate mounts collapsed into one.)
 */
export function homeStubFs(slug: string, home: IFileSystem): IFileSystem {
  const mine = `/${slug}`;
  /** rel-under-/home → rel-under-the-home-fs, or null when foreign. */
  const sub = (rel: string): string | null => {
    if (rel === mine) return "/";
    if (rel.startsWith(`${mine}/`)) return rel.slice(mine.length);
    return null;
  };
  const absOf = (rel: string): string => (rel === "/" ? "/home" : `/home${rel}`);
  const rootStat: FsStat = {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: 0o755,
    size: 0,
    mtime: new Date(),
  };

  return {
    async readFile(rel: ReadFileArgs[0], options?: ReadFileArgs[1]): Promise<string> {
      const s = sub(rel);
      if (s === null) throw enoent(absOf(rel));
      return home.readFile(s, options);
    },
    async readFileBytes(rel: string): Promise<ByteStr> {
      const s = sub(rel);
      if (s === null || !home.readFileBytes) throw enoent(absOf(rel));
      return home.readFileBytes(s);
    },
    async readFileBuffer(rel: string): Promise<Uint8Array> {
      const s = sub(rel);
      if (s === null) throw enoent(absOf(rel));
      return home.readFileBuffer(s);
    },
    async writeFile(rel, content, options?): Promise<void> {
      const s = sub(rel);
      if (s === null) throw eacces(absOf(rel));
      return home.writeFile(s, content, options);
    },
    async appendFile(rel, content, options?): Promise<void> {
      const s = sub(rel);
      if (s === null) throw eacces(absOf(rel));
      return home.appendFile(s, content, options);
    },
    async exists(rel: string): Promise<boolean> {
      if (rel === "/") return true;
      const s = sub(rel);
      return s === null ? false : home.exists(s);
    },
    async stat(rel: string): Promise<FsStat> {
      if (rel === "/") return rootStat;
      const s = sub(rel);
      if (s === null) throw enoent(absOf(rel));
      return home.stat(s);
    },
    async lstat(rel: string): Promise<FsStat> {
      return this.stat(rel);
    },
    async mkdir(rel, options?): Promise<void> {
      if (rel === "/") {
        if (options?.recursive) return;
        throw new Error(`EEXIST: file already exists, mkdir '/home'`);
      }
      const s = sub(rel);
      if (s === null) throw eacces(absOf(rel));
      return home.mkdir(s, options);
    },
    async readdir(rel: string): Promise<string[]> {
      if (rel === "/") return [slug];
      const s = sub(rel);
      if (s === null) throw enoent(absOf(rel));
      return home.readdir(s);
    },
    async readdirWithFileTypes(rel: string): Promise<DirentEntry[]> {
      if (rel === "/") {
        return [{ name: slug, isFile: false, isDirectory: true, isSymbolicLink: false }];
      }
      const s = sub(rel);
      if (s === null || !home.readdirWithFileTypes) throw enoent(absOf(rel));
      return home.readdirWithFileTypes(s);
    },
    async rm(rel, options?): Promise<void> {
      const s = sub(rel);
      if (s === null) throw eacces(absOf(rel));
      return home.rm(s, options);
    },
    async cp(src, dest, options?): Promise<void> {
      const from = sub(src);
      if (from === null) throw enoent(absOf(src)); // read side first: absence, not denial
      const to = sub(dest);
      if (to === null) throw eacces(absOf(dest));
      return home.cp(from, to, options);
    },
    async mv(src, dest): Promise<void> {
      const from = sub(src);
      if (from === null) throw enoent(absOf(src));
      const to = sub(dest);
      if (to === null) throw eacces(absOf(dest));
      return home.mv(from, to);
    },
    resolvePath(base: string, path: string): string {
      return posix.resolve(base || "/", path);
    },
    getAllPaths(): string[] {
      return [];
    },
    async chmod(rel: string, mode: number): Promise<void> {
      const s = sub(rel);
      if (s === null) return; // no-op edge; nothing to reveal
      return home.chmod(s, mode);
    },
    async utimes(rel: string, atime: Date, mtime: Date): Promise<void> {
      const s = sub(rel);
      if (s === null) return;
      return home.utimes(s, atime, mtime);
    },
    async symlink(_target: string, _linkPath: string): Promise<void> {
      throw notSupported("symlinks");
    },
    async link(_existing: string, _newPath: string): Promise<void> {
      throw notSupported("hard links");
    },
    async readlink(rel: string): Promise<string> {
      throw new Error(`EINVAL: ${absOf(rel)} is not a symbolic link`);
    },
    async realpath(rel: string): Promise<string> {
      if (rel === "/") return "/";
      const s = sub(rel);
      if (s === null) throw enoent(absOf(rel));
      await home.realpath(s);
      return posix.normalize(rel);
    },
  };
}

/**
 * The MountableFs base: an ephemeral InMemoryFs where only /tmp accepts
 * writes — everything else teaches the writable roots. Reads pass through
 * (so `ls /` works and startup lookups don't trip), and symlinks are allowed
 * inside /tmp only: they resolve within this in-memory fs, which contains no
 * brain paths, so they cannot alias into /shared or /home.
 */
export function guardedBase(): IFileSystem {
  const inner = new InMemoryFs();
  const inTmp = (p: string): boolean => p === "/tmp" || p.startsWith("/tmp/");
  const guard = (p: string): void => {
    if (!inTmp(p)) throw eacces(p);
  };

  return {
    readFile: (p, o?) => inner.readFile(p, o),
    readFileBytes: (p) => inner.readFileBytes(p),
    readFileBuffer: (p) => inner.readFileBuffer(p),
    exists: (p) => inner.exists(p),
    stat: (p) => inner.stat(p),
    lstat: (p) => inner.lstat(p),
    readdir: (p) => inner.readdir(p),
    readdirWithFileTypes: (p) => inner.readdirWithFileTypes(p),
    readlink: (p) => inner.readlink(p),
    realpath: (p) => inner.realpath(p),
    resolvePath: (b, p) => inner.resolvePath(b, p),
    getAllPaths: () => inner.getAllPaths(),
    chmod: (p, m) => inner.chmod(p, m),
    utimes: (p, a, m) => inner.utimes(p, a, m),
    writeFile: async (p, c, o?) => {
      guard(p);
      return inner.writeFile(p, c, o);
    },
    appendFile: async (p, c, o?) => {
      guard(p);
      return inner.appendFile(p, c, o);
    },
    mkdir: async (p, o?) => {
      guard(p);
      return inner.mkdir(p, o);
    },
    rm: async (p, o?) => {
      guard(p);
      return inner.rm(p, o);
    },
    cp: async (src, dest, o?) => {
      guard(dest);
      return inner.cp(src, dest, o);
    },
    mv: async (src, dest) => {
      guard(src);
      guard(dest);
      return inner.mv(src, dest);
    },
    symlink: async (target, linkPath) => {
      guard(linkPath);
      return inner.symlink(target, linkPath);
    },
    link: async (existing, newPath) => {
      guard(newPath);
      return inner.link(existing, newPath);
    },
  };
}
