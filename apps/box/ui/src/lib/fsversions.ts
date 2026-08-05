/**
 * The file manager's version-control brain: the wording,
 * the size guard, and every exchange the History panel, the Trash view and the
 * lock toggle have with the box. The api client is INJECTED (structurally, so
 * `api` itself satisfies each slice) — that keeps the order and the direction
 * of each call testable without a browser, and leaves the components as views.
 */
import { ApiError, type FsLock, type FsTrashEntry, type FsVersion } from "./api";

/**
 * Is this exact path in the store's WRITE scope? Mirrors FsStore.assertWritable
 * (fs-store.ts): only `/shared/**` and `/home/<you>/**` are writable — the fixed
 * roots `/shared` and `/home/<you>` themselves deliberately are NOT (nobody may
 * lock /shared and freeze the whole org's tree by ancestor enforcement). The UI
 * must not offer a control whose ONLY possible outcome is that refusal.
 */
export function isWritablePath(path: string, home: string | null): boolean {
  if (path.startsWith("/shared/")) return true;
  return home !== null && path.startsWith(`${home}/`);
}

/**
 * A path as the file manager shows it: your own home collapses to `~`, exactly
 * as the path bar renders it. The raw `/home/<slug>` is never printed anywhere
 * in this view — the slug is an implementation detail of the store, not an
 * address a human is asked to read or copy.
 */
export function displayPath(path: string, home: string | null): string {
  if (home === null) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Human file size — the same scale the file table has always shown. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/**
 * What a snapshot captured, in words a human reads. The store writes exactly
 * two reasons today (`overwrite`, `delete`); an unknown one passes through
 * verbatim rather than being flattened into a lie.
 */
export function reasonLabel(reason: string): string {
  if (reason === "overwrite") return "before an edit";
  if (reason === "delete") return "before a delete";
  return reason;
}

/**
 * Cap on what a diff will pull into the browser per side. A snapshot can never
 * exceed FS_VERSION_MAX_FILE_BYTES (1 MiB) server-side, so this only ever
 * trips on a large live file — and it trips before the fetch, not after.
 */
export const VERSION_DIFF_MAX = 512 * 1024;

export function tooBigToDiff(aBytes: number, bBytes: number): boolean {
  return aBytes > VERSION_DIFF_MAX || bBytes > VERSION_DIFF_MAX;
}

/**
 * A refusal the server phrased (ApiError) shows the server's own words — those
 * teach (`ELOCKED: … is locked by Alice`, `EEXIST: …`). Anything else (a
 * dropped connection, a parse blow-up) is not a message a human should read,
 * so the caller's fallback stands in.
 */
export function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

// ---- history + diff --------------------------------------------------------

interface HistoryApi {
  fsHistory: (path: string) => Promise<{ versions: FsVersion[] }>;
}

/** Prior snapshots of one file, newest first (the server's order). */
export async function loadHistory(api: HistoryApi, path: string): Promise<FsVersion[]> {
  return (await api.fsHistory(path)).versions;
}

interface DiffUrlApi {
  fsVersionUrl: (path: string, version: number) => string;
  fsFileUrl: (path: string) => string;
}

/**
 * The two sides of a version diff, in the only order that reads correctly:
 * the SNAPSHOT is `from` (what it was) and the live file is `to` (what it is).
 * Flipping these would render every restore as its own inverse.
 */
export function diffUrls(
  api: DiffUrlApi,
  path: string,
  version: number,
): { from: string; to: string } {
  return { from: api.fsVersionUrl(path, version), to: api.fsFileUrl(path) };
}

/** Both sides as text, or nothing — half a diff is worse than none. */
export async function loadDiffPair(
  fetchText: (url: string) => Promise<string>,
  urls: { from: string; to: string },
): Promise<{ from: string; to: string }> {
  const [from, to] = await Promise.all([fetchText(urls.from), fetchText(urls.to)]);
  return { from, to };
}

// ---- restore ---------------------------------------------------------------

interface RestoreApi {
  fsRestore: (path: string, version?: number) => Promise<unknown>;
}

/**
 * Roll a path back (a version number) or resurrect a deleted one (no version),
 * THEN reload. The reload runs only when the write landed — a refused restore
 * (EEXIST at the old path, ELOCKED on a locked file) must never repaint as if
 * it had worked.
 */
export async function restoreAndReload(
  api: RestoreApi,
  path: string,
  version: number | undefined,
  reload: () => void | Promise<void>,
): Promise<void> {
  await api.fsRestore(path, version);
  await reload();
}

// ---- trash -----------------------------------------------------------------

interface TrashApi {
  fsTrash: (prefix?: string) => Promise<{ entries: FsTrashEntry[] }>;
}

/** What is recoverable under `prefix` — the whole visible tree at the root. */
export async function loadTrash(api: TrashApi, prefix: string): Promise<FsTrashEntry[]> {
  return (await api.fsTrash(prefix === "/" ? undefined : prefix)).entries;
}

// ---- locks -----------------------------------------------------------------

/** The shape the server sends for a path nobody holds. */
export const UNLOCKED: FsLock = { locked_by: null, locked_by_name: null, locked_at: null };

interface LockReadApi {
  fsLockInfo: (path: string) => Promise<FsLock>;
}
interface LockWriteApi {
  fsLock: (path: string) => Promise<FsLock>;
  fsUnlock: (path: string) => Promise<FsLock>;
}

/** Display name of whoever holds this lock, or null when it is writable. */
export function lockHolder(lock: FsLock | null | undefined): string | null {
  if (!lock?.locked_by) return null;
  return lock.locked_by_name ?? "someone";
}

/**
 * One path's lock. A read that fails reads as UNLOCKED on purpose: the lock is
 * an affordance, and FsStore.assertNotLocked is the actual boundary — a UI that
 * can't read the flag must not pretend the file is protected (nor block a write
 * the server would have allowed).
 */
export async function loadLock(api: LockReadApi, path: string): Promise<FsLock> {
  try {
    return await api.fsLockInfo(path);
  } catch {
    return UNLOCKED;
  }
}

/** The shape `fsList` returns, as far as lock state is concerned. */
interface FsListing {
  /** the folder's OWN lock — it governs everything beneath it. */
  lock?: FsLock | null;
  entries: readonly { name: string; lock?: FsLock | null }[];
}

/**
 * Lock state for a whole listing, keyed by FULL path — read straight off the
 * list response. The server resolves every row's lock (and the folder's own) in
 * the one query that lists the folder, so navigating a folder costs ONE request
 * instead of one GET per row: an N+1 here would open up to 60 transactions on a
 * pool documented at 4. A row the server sent no lock for is absent from the map
 * rather than guessed at — the store, not this view, is the boundary.
 */
export function locksFromListing(dir: string, res: FsListing): Record<string, FsLock> {
  const out: Record<string, FsLock> = {};
  if (res.lock) out[dir] = res.lock;
  for (const e of res.entries) {
    if (e.lock) out[dir === "/" ? `/${e.name}` : `${dir}/${e.name}`] = e.lock;
  }
  return out;
}

/**
 * Flip a path's lock. Locking is refused by the store when someone else already
 * holds it (a lock cannot be taken over) and unlocking is refused unless you set
 * it or you're an owner — both refusals travel to the caller verbatim.
 */
export async function toggleLock(
  api: LockWriteApi,
  path: string,
  lock: FsLock | null,
): Promise<FsLock> {
  return lockHolder(lock) === null ? api.fsLock(path) : api.fsUnlock(path);
}
