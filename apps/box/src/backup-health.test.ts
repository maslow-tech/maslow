import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isArchiverWedged,
  lastFullBackupAt,
  lastRestoreDrill,
  pendingWalSegments,
} from "./backup-health.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "brain-backup-health-"));
}

describe("isArchiverWedged", () => {
  // THE REGRESSION. This is the whole reason the function exists: the alert used
  // to be `failed_count > 0 AND …`, and under archive-async=y that is exactly the
  // reading a comprehensively-broken archiver produces. Measured 2026-07-29 on
  // the shipped image, locally and on prod: archived=0 failed=0
  // last_archived_time=NULL with a .ready segment queued and global.error already
  // in the spool. If this test ever goes green-by-returning-false, the fleet's
  // archiver alarm is silent again.
  it("fires on a queue backlog even though failed_count is 0 (the async blind spot)", () => {
    expect(
      isArchiverWedged({
        failedCount: 0,
        failingNow: false,
        pending: 7,
        lastArchivedAgeSec: null, // never archived anything
      }),
    ).toBe(true);
  });

  it("still fires on the classic signal when Postgres does report failures", () => {
    expect(
      isArchiverWedged({ failedCount: 12, failingNow: true, pending: 0, lastArchivedAgeSec: 30 }),
    ).toBe(true);
  });

  // Idle-safety is why queue depth was chosen over "last archive is old". A box
  // nobody touched for a week archives nothing and is perfectly healthy; alarming
  // on staleness alone would page on every quiet production box every weekend.
  it("does NOT fire on an idle box with an empty queue, however stale the last archive", () => {
    expect(
      isArchiverWedged({
        failedCount: 0,
        failingNow: false,
        pending: 0,
        lastArchivedAgeSec: 60 * 60 * 24 * 7,
      }),
    ).toBe(false);
  });

  it("does NOT fire on a couple of segments mid-flight with archiving flowing", () => {
    expect(
      isArchiverWedged({ failedCount: 0, failingNow: false, pending: 2, lastArchivedAgeSec: 5 }),
    ).toBe(false);
  });

  it("does NOT fire on a backlog that is actively draining", () => {
    // Queue is deep, but something was archived seconds ago — that is catch-up,
    // not a wedge. Paging here would fire on every burst of writes.
    expect(
      isArchiverWedged({ failedCount: 0, failingNow: false, pending: 50, lastArchivedAgeSec: 10 }),
    ).toBe(false);
  });

  it("returns null when it cannot judge, so the field is omitted rather than guessed", () => {
    expect(
      isArchiverWedged({
        failedCount: null,
        failingNow: false,
        pending: null,
        lastArchivedAgeSec: null,
      }),
    ).toBeNull();
  });

  it("falls back to the Postgres signal alone when the filesystem view is missing", () => {
    // No pgdata mount (older box): we can still honour a real failure report, but
    // a clean pg_stat_archiver here is NOT proof of health — it is just all we have.
    expect(
      isArchiverWedged({
        failedCount: 3,
        failingNow: true,
        pending: null,
        lastArchivedAgeSec: 999,
      }),
    ).toBe(true);
    expect(
      isArchiverWedged({
        failedCount: 0,
        failingNow: false,
        pending: null,
        lastArchivedAgeSec: 10,
      }),
    ).toBe(false);
  });
});

describe("pendingWalSegments", () => {
  it("counts only .ready files", async () => {
    const dir = join(await scratch(), "archive_status");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "000000010000000000000001.ready"), "");
    await writeFile(join(dir, "000000010000000000000002.ready"), "");
    await writeFile(join(dir, "000000010000000000000003.done"), "");
    expect(await pendingWalSegments(dir)).toBe(2);
  });

  it("is 0 for an empty queue and null when the path is unreadable", async () => {
    const dir = join(await scratch(), "archive_status");
    await mkdir(dir, { recursive: true });
    expect(await pendingWalSegments(dir)).toBe(0);
    // null, NOT 0 — "I cannot see the queue" must not read as "the queue is empty".
    expect(await pendingWalSegments(join(dir, "nope"))).toBeNull();
  });
});

describe("lastFullBackupAt", () => {
  it("reads the scheduler's epoch stamp", async () => {
    const repo = await scratch();
    const when = 1_800_000_000;
    await writeFile(join(repo, ".brain-last-full"), `${when}\n`);
    expect((await lastFullBackupAt(repo, when * 1000 + 1000))?.getTime()).toBe(when * 1000);
  });

  it("is null when there is no stamp — never a fabricated recent time", async () => {
    expect(await lastFullBackupAt(await scratch())).toBeNull();
  });

  it("treats a garbage stamp as unknown", async () => {
    const repo = await scratch();
    await writeFile(join(repo, ".brain-last-full"), "not-a-number\n");
    expect(await lastFullBackupAt(repo)).toBeNull();
  });

  // A future stamp is the fingerprint of the backwards-clock bug the scheduler
  // recovers from. Reporting it as a fresh backup would hide the exact condition
  // that stops backups, so it reads as unknown instead.
  it("treats a FUTURE stamp as unknown, not as a fresh backup", async () => {
    const repo = await scratch();
    const now = 1_800_000_000_000;
    await writeFile(join(repo, ".brain-last-full"), `${Math.floor(now / 1000) + 86_400}\n`);
    expect(await lastFullBackupAt(repo, now)).toBeNull();
  });
});

describe("lastRestoreDrill — the marker that says a backup was actually read back", () => {
  it("parses a passing drill", async () => {
    const repo = await scratch();
    const when = 1_700_000_000;
    await writeFile(join(repo, ".brain-last-drill"), `${when} ok rows=11003\n`);
    const r = await lastRestoreDrill(repo, when * 1000 + 1000);
    expect(r).toEqual({ at: new Date(when * 1000), status: "ok", detail: "rows=11003" });
  });

  it("parses a FAILED drill — the alarm case", async () => {
    const repo = await scratch();
    const when = 1_700_000_000;
    await writeFile(join(repo, ".brain-last-drill"), `${when} fail restore\n`);
    expect((await lastRestoreDrill(repo, when * 1000 + 1000))?.status).toBe("fail");
  });

  it("reports SKIPPED as skipped, never as a pass", async () => {
    // The scheduler writes `skipped` when preconditions refuse (no space, disk
    // pressure). Collapsing that into ok/fail would let a box that has not
    // drilled in months look proven.
    const repo = await scratch();
    const when = 1_700_000_000;
    await writeFile(join(repo, ".brain-last-drill"), `${when} skipped insufficient-space\n`);
    expect((await lastRestoreDrill(repo, when * 1000 + 1000))?.status).toBe("skipped");
  });

  it("treats an unrecognised status as unknown rather than optimistically ok", async () => {
    const repo = await scratch();
    const when = 1_700_000_000;
    await writeFile(join(repo, ".brain-last-drill"), `${when} weird whatever\n`);
    expect(await lastRestoreDrill(repo, when * 1000 + 1000)).toBeNull();
  });

  it("treats a FUTURE stamp as unknown (a backwards clock must not look fresh)", async () => {
    const repo = await scratch();
    const when = 1_700_000_000;
    await writeFile(join(repo, ".brain-last-drill"), `${when + 86_400} ok rows=1\n`);
    expect(await lastRestoreDrill(repo, when * 1000)).toBeNull();
  });

  it("is null when no drill has ever run", async () => {
    expect(await lastRestoreDrill(await scratch())).toBeNull();
  });
});
