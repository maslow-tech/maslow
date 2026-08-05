/**
 * Backup + WAL-archive health, read from the filesystem rather than asked of
 * Postgres.
 *
 * Why not just query `pg_stat_archiver`: under `archive-async=y` (which is what
 * `deploy/pgbackrest/pgbackrest.conf` ships) `archive-push` hands the segment to
 * a background worker and returns 0. The worker's failure lands in the spool and
 * only surfaces to Postgres on a LATER push. MEASURED 2026-07-29, locally and on
 * prod: with a missing stanza, `pg_stat_archiver` read
 * `archived_count=0 failed_count=0 last_archived_time=NULL` while a `.ready`
 * segment sat queued and the spool already held `global.error`. So a wedge
 * detector gated on `failed_count > 0` is silent in exactly the case that nearly
 * filled two production disks in July. See the backups doctrine in CLAUDE.md.
 *
 * The two signals here do not have that blind spot, and the app can read both
 * without new privileges:
 *
 *  - `pendingWalSegments()` counts `pg_wal/archive_status/*.ready` — segments
 *    Postgres has finished and is waiting to have archived. It is IDLE-SAFE by
 *    construction: an idle box produces no `.ready` files, so it cannot false-
 *    positive the way "last_archived_time is old" does. The app already mounts
 *    the postgres `pgdata` volume read-only for the write-shed, so this is the
 *    same filesystem Postgres writes to.
 *  - `lastFullBackupAt()` reads the scheduler's `.brain-last-full` stamp from the
 *    pgBackRest repo. This is what makes "are backups actually running?"
 *    answerable from the control-plane console (when one is configured) instead of by SSH. Note that
 *    a healthy archiver says nothing about whether a FULL was ever taken, and a
 *    repo with only WAL and no base backup is not a backup at all.
 *
 * Everything here is best-effort and returns null on any error: a box that
 * cannot read these paths must still report its other vitals, and an absent
 * field means "unknown" (the booth holds the prior value) rather than "fine".
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Default matches the app's read-only mount of the postgres `pgdata` volume. */
const DEFAULT_DATA_PATH = "/var/lib/brain-pgdata";
/** Default matches the app's read-only mount of the `pgbackrest_repo` volume. */
const DEFAULT_REPO_PATH = "/var/lib/brain-pgbackrest";

export function archiveStatusDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.BRAIN_DATA_PATH ?? DEFAULT_DATA_PATH, "pg_wal", "archive_status");
}

export function backupRepoPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRAIN_BACKUP_REPO_VIEW_PATH ?? DEFAULT_REPO_PATH;
}

/**
 * Count of WAL segments finished and queued for archiving. 0 is healthy; a
 * number that stays high across heartbeats means archiving is not draining.
 * null = the directory could not be read (not mounted, pre-archiver box).
 */
export async function pendingWalSegments(dir: string = archiveStatusDir()): Promise<number | null> {
  try {
    const names = await readdir(dir);
    return names.reduce((n, f) => (f.endsWith(".ready") ? n + 1 : n), 0);
  } catch {
    return null;
  }
}

/**
 * When the backup scheduler last completed a FULL backup, from the
 * `.brain-last-full` stamp it writes into the repo. null = never taken, repo not
 * mounted, or the stamp is unreadable/nonsense — all of which are equally "we
 * cannot prove a backup exists", which is what the console should show.
 *
 * A stamp in the FUTURE is treated as unknown rather than recent: the scheduler
 * has its own recovery for that case (a backwards clock step), and reporting it
 * as a fresh backup would hide the very condition we want visible.
 */
export async function lastFullBackupAt(
  repoPath: string = backupRepoPath(),
  now: number = Date.now(),
): Promise<Date | null> {
  try {
    const raw = await readFile(join(repoPath, ".brain-last-full"), "utf8");
    const epoch = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(epoch) || epoch <= 0) return null;
    const at = epoch * 1000;
    if (at > now + 60_000) return null;
    return new Date(at);
  } catch {
    return null;
  }
}

/**
 * The last restore DRILL, read from the scheduler's `.brain-last-drill` marker
 * (`<epoch> <ok|fail|skipped> <detail>`).
 *
 * This is a different question from "did a backup happen". A box can be taking
 * perfect backups on schedule and archiving WAL flawlessly while none of it
 * actually restores — a lost WAL segment, a repo that no longer checksums, a
 * pg_control the cluster refuses. Only the drill knows, so only the drill's
 * result is worth reporting.
 *
 * Three outcomes, kept distinct on purpose:
 *   ok      — restored, started, every heap read
 *   fail    — the drill ran and the backup did NOT come back. This is the alarm.
 *   skipped — preconditions said no (no space, disk pressure). NOT a failure,
 *             but it does mean the drill stamp is not evidence of anything, so
 *             it must not read as a pass.
 * A future stamp is `null` (unknown), same rule as lastFullBackupAt.
 */
export interface DrillResult {
  readonly at: Date;
  readonly status: "ok" | "fail" | "skipped";
  readonly detail: string;
}

export async function lastRestoreDrill(
  repoPath: string = backupRepoPath(),
  now: number = Date.now(),
): Promise<DrillResult | null> {
  try {
    const raw = (await readFile(join(repoPath, ".brain-last-drill"), "utf8")).trim();
    const [epochRaw, statusRaw, ...rest] = raw.split(/\s+/);
    const epoch = Number.parseInt(epochRaw ?? "", 10);
    if (!Number.isFinite(epoch) || epoch <= 0) return null;
    const at = epoch * 1000;
    if (at > now + 60_000) return null;
    // An unrecognised status is NOT optimistically read as a pass. A marker we
    // cannot parse is a marker we cannot trust.
    if (statusRaw !== "ok" && statusRaw !== "fail" && statusRaw !== "skipped") return null;
    return { at: new Date(at), status: statusRaw, detail: rest.join(" ") };
  } catch {
    return null;
  }
}

/** Inputs to the wedge decision, so the rule itself is pure and testable. */
export interface ArchiverSample {
  /** pg_stat_archiver.failed_count */
  readonly failedCount: number | null;
  /** true when the newest failure is newer than the newest success */
  readonly failingNow: boolean;
  /** segments queued in archive_status (null = unknown) */
  readonly pending: number | null;
  /** seconds since the last SUCCESSFUL archive; null = never archived */
  readonly lastArchivedAgeSec: number | null;
}

/** Segments allowed to sit queued before we call it wedged. Postgres can have a
 *  couple in flight legitimately between a switch and the async push draining. */
const PENDING_WEDGE_THRESHOLD = 3;
/** How stale a last-success may be before a queue backlog counts as wedged. */
const STALE_ARCHIVE_SEC = 900;

/**
 * Is WAL archiving wedged? Two INDEPENDENT paths, deliberately OR-ed:
 *
 *  1. Postgres itself reports pushes failing — the classic signal, still valid
 *     when it fires. It just cannot be relied on ALONE (see the header).
 *  2. Segments are piling up in archive_status and nothing has been archived
 *     recently. This is the async blind spot, and it is idle-safe: no queue
 *     means no alarm, however long the box has been quiet.
 *
 * Returns null ⇒ not enough information to judge; the field is omitted from the
 * heartbeat and the booth holds whatever it knew before.
 */
export function isArchiverWedged(s: ArchiverSample): boolean | null {
  const postgresSaysFailing = (s.failedCount ?? 0) > 0 && s.failingNow;
  if (postgresSaysFailing) return true;

  if (s.pending === null) {
    // No filesystem view: fall back to what Postgres alone can tell us, and be
    // explicit that a clean pg_stat_archiver here is NOT proof of health.
    return s.failedCount === null ? null : postgresSaysFailing;
  }

  const staleOrNever = s.lastArchivedAgeSec === null || s.lastArchivedAgeSec > STALE_ARCHIVE_SEC;
  if (s.pending >= PENDING_WEDGE_THRESHOLD && staleOrNever) return true;
  return false;
}
