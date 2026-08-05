# Point-in-time recovery (PITR)

Recover the brain to a specific timestamp: the fix for a logical mistake (a
bad bulk edit, a wrong `drop_type`, a bad migration, an injected agent
scribbling over rows). The mechanism is pgBackRest: a physical base backup
plus continuously archived WAL, replayed up to a target time.

> Scope. PITR bounds logical mistakes to about `archive_timeout` (~60s of
> possible data loss, the RPO). It does not protect against losing the disk
> itself: the base backup and WAL live on the same volume as PGDATA (no
> separate WAL volume, no off-box copy). A whole-volume loss is bounded only
> by your last block-level volume snapshot. Use PITR for corrupted data; use
> the volume snapshot for a lost disk.

---

## How it is set up

|                 |                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Archiving       | `archive_mode = on`, `archive_command = 'pgbackrest --stanza=brain archive-push %p'` (`deploy/postgres/postgresql.conf`) |
| RPO             | `archive_timeout = 60s`                                                                               |
| WAL compression | `wal_compression = zstd` at the source, then zstd-3 again in the repo                                 |
| Repo            | LOCAL, `/var/lib/pgbackrest` (named volume `pgbackrest_repo`), same volume as PGDATA                  |
| Full backups    | every **12h**, by the `backup` compose sidecar                                                        |
| Retention       | **4 fulls** ⇒ a **~48h PITR window**; `expire` runs every cycle                                       |
| Repo budget     | **20% of the volume**, computed at runtime (~10 GiB on a 50 G volume, ~16 GiB on 80 G)                |
| Wedge fuse      | `archive-push-queue-max=4GiB` — a broken archiver drops WAL **loudly** instead of filling the disk    |

The scheduler is `deploy/postgres/backup-scheduler.sh`, running as the
`backup` service. It bootstraps the stanza idempotently, takes the fulls,
runs `expire` every cycle, and refuses to start a backup when the volume is
at the write-shed threshold (`BRAIN_WRITE_SHED_PCT`, the same knob the box
app uses to stop content writes) or when the repo is at its budget. It never
exits: a sidecar that exits would fail `compose up --wait` and break the
updater's apply.

Everything below runs through that service, because `pgbackrest` lives in
the container, not on the host:

```bash
cd /opt/brain/deploy
docker compose run --rm --no-deps --user postgres backup pgbackrest --stanza=brain info
```

pgBackRest's config parsing has two traps to know about when editing
`deploy/pgbackrest/pgbackrest.conf`. Trailing inline comments are not
stripped: `start-fast=y  # why` parses as the literal value `y  # why` and
fails, so every comment must sit on its own line. And repo-only commands
(`expire`, `info`) reject the `pg-*` options (`option 'pg-port' not valid
for command 'expire'` is a hard error), which is why the scheduler keeps a
separate helper for repo-only invocations.

## Health-check the archiver continuously

If WAL isn't being archived you have no PITR window, and unarchived WAL
piles up until the fuse drops it.

```bash
# the scheduler logs archiver health every cycle
docker compose logs --tail=50 backup | grep -E 'archiver|WEDGED|REFUSING'
```

```sql
SELECT last_archived_wal, last_archived_time, failed_count, last_failed_time
FROM pg_stat_archiver;
```

```bash
docker compose run --rm --no-deps --user postgres backup pgbackrest --stanza=brain check
docker compose run --rm --no-deps --user postgres backup pgbackrest --stanza=brain info
```

`failed_count` climbing, `check` failing, or a `WAL ARCHIVING IS WEDGED`
line in the sidecar log means archiving is broken; treat it as an incident.
`check` forces a WAL switch, so do not put it in a tight loop; that is why
the scheduler does not poll with it.

> `failed_count` alone is not a sufficient health check. With
> `archive-async=y`, `archive-push` hands the segment to a background worker
> and returns. When that worker fails, it records the error in the spool,
> and the foreground only surfaces it on a later invocation. Measured on a
> box with a missing stanza: `archived_count=0`, `failed_count=0`,
> `last_failed_wal=NULL`, while a `.ready` segment sat queued and
> `/var/spool/pgbackrest/archive/brain/out/global.error` had already been
> written. A clean `pg_stat_archiver` is therefore compatible with archiving
> being completely broken. The checks that do work:
>
> ```bash
> # 1. the async worker's own verdict — present means archiving is failing NOW
> docker compose exec backup ls -l /var/spool/pgbackrest/archive/brain/out/
> # 2. segments queued and not yet archived (a growing count is the fuse burning)
> docker compose exec postgres \
>   sh -c 'ls -1 /var/lib/postgresql/data/pg_wal/archive_status/*.ready 2>/dev/null | wc -l'
> # 3. pgBackRest's own check (forces a WAL switch — not for tight loops)
> docker compose run --rm --no-deps --user postgres backup pgbackrest --stanza=brain check
> ```
>
> Treat `failed_count > 0` as sufficient to alarm, never as necessary.

## Taking backups on demand

```bash
# Take a full NOW (subject to the space guards) — do this before any risky
# operation, migration, or hand-run SQL.
docker compose exec backup /usr/local/bin/brain-backup.sh now

# Verify the repo is internally consistent (schedule periodically).
docker compose run --rm --no-deps --user postgres backup pgbackrest --stanza=brain verify
```

`brain-backup.sh now` takes a container-local `flock`, so it cannot race the
scheduler's own backup.

---

## Restore to a timestamp

You are rewinding the whole cluster. This is destructive to the current
PGDATA: you are replacing "now" with "then". Take a volume snapshot first
(belt and braces), and expect to run the post-restore reconciliation
(`disaster-recovery.md`), because a rewind undoes token/auth changes made
after the target time.

1. Freeze writes and stop everything that touches PGDATA, including the
   backup sidecar (a scheduled `expire` must not run against the repo you
   are restoring from):

   ```bash
   cd /opt/brain/deploy
   docker compose stop app updater backup
   ```

2. Pick the target time `T`, just before the mistake. Timestamps are UTC.
   Example: `2030-01-15 14:03:00+00`. Confirm `T` is inside the window the
   repo covers; `pgbackrest info` prints it.

3. Stop Postgres (pgBackRest restores into a stopped cluster):

   ```bash
   docker compose stop postgres
   ```

4. Restore the base and configure the recovery target. pgBackRest writes the
   `restore_command` and recovery settings for you:

   ```bash
   docker compose run --rm --no-deps --user postgres backup \
     pgbackrest --stanza=brain \
       --type=time --target="2030-01-15 14:03:00+00" \
       --target-action=promote \
       --delta \
       restore
   ```

   - `--type=time --target=T` → replay WAL and stop at the last commit ≤ `T`
     (`recovery_target_inclusive` is on by default).
   - `--target-action=promote` → end recovery and open read/write once `T`
     is reached.
   - `--delta` → only overwrite files that differ (much faster than a full
     wipe).
   - `--no-deps` matters: without it `compose run` would start `postgres`
     again, which is the one thing that must stay down.
   - `--user postgres` matters just as much: the `backup` service
     intentionally starts as root (it heals the repo volume's ownership
     once, then re-execs itself under `gosu postgres`), so a raw
     `pgbackrest` invocation through it would otherwise run as root and
     restore PGDATA full of root-owned files, a cluster Postgres cannot
     start.

   To restore beside the live cluster instead of over it (the safe way to
   ask "what did this look like at T" without rewinding production), add
   `--pg1-path=/var/lib/postgresql/restore` and start that directory on
   another port.

5. Start Postgres. It enters archive recovery, replays WAL from the base up
   to `T`, then promotes:

   ```bash
   docker compose start postgres
   docker compose logs -f postgres | grep -Ei 'recovery|consistent|promote'
   ```

6. Verify you landed where you meant to.

   ```sql
   SELECT max(seq), max(at) FROM events;          -- newest surviving event ≤ T
   SELECT count(*) FROM objects WHERE deleted_at IS NULL;
   ```

7. Re-assert the privilege model and reconcile auth state. A rewind can
   revive tokens revoked after `T`. Run `disaster-recovery.md` from the
   "Post-restore auth reconciliation" section (re-mint tokens, force OAuth
   re-auth, run the privilege audit). Do not reopen the box to members until
   that is done.

8. Bring the box back up:

   ```bash
   docker compose start app updater backup
   ```

9. Take a fresh full backup immediately; recovery started a new timeline,
   and you want a clean base on it:

   ```bash
   docker compose exec backup /usr/local/bin/brain-backup.sh now
   ```

---

## Why the cadence is 12 hours

Measured on a live box: a ~50 MB database writing ~10 GB/day of WAL. A base
backup is close to free, and the retained WAL is the entire cost of the
window. Every full is a point past which older WAL can be dropped, so
frequent fulls keep the repo small, the opposite of the usual "weekly full,
daily diff" advice.

- 12h × 4 fulls ⇒ a 36–48h PITR window.
- 20% of a 50 G volume = 10 GiB of budget; 20% of 80 G = 16 GiB.
- Most of that ~10 GB/day is `archive_timeout` forcing mostly-empty 16 MB
  segments closed every 60s, and those compress very hard. Expect ~2.5–5 GiB
  steady state on a 50 G volume. The pessimistic case (dense, poorly
  compressible WAL at the full 10 GB/day, only ~2× compression ⇒ ~10 GiB
  over 48h) lands at the budget, which is when the scheduler steps retention
  down 4 → 3 → 2 → 1 so the repo does not crowd out the database.

Tune with `BRAIN_BACKUP_INTERVAL_HOURS`, `BRAIN_BACKUP_RETENTION_FULL`,
`BRAIN_BACKUP_REPO_BUDGET_PCT` in `deploy/.env`, then recreate `backup`.

## If PITR can't reach your target

- Target older than the oldest base backup / expired WAL: PITR cannot reach
  it; fall back to the nearest volume snapshot and accept its coarser RPO.
  `pgbackrest info` prints the reachable range.
- The archiver had been failing: recovery stops at the last contiguous
  segment before the gap. If the gap came from `archive-push-queue-max`
  dropping segments, the sidecar logged an ERROR at the time; everything
  before the gap is restorable, nothing after it is.
- The box predates backups being enabled: there is no repo at all. Use the
  volume snapshot.

## The wedge fuse

Postgres will not recycle WAL it has not archived, so a broken
`archive_command` fills the volume. `archive-push-queue-max=4GiB` bounds
that: past 4 GiB of un-archived WAL, pgBackRest tells Postgres the segment
was archived, drops it, and logs an ERROR. That deliberately sacrifices the
PITR window to keep the box alive. `max_wal_size` is 2 GB, so healthy
operation never approaches the fuse; if it ever blows, the archiver was
already broken and should have alarmed long before.
