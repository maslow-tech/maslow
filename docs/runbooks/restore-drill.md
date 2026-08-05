# Restore drill

A box can take pgBackRest backups on schedule and expire them correctly
without ever proving that one restores. The drill closes that gap.

Every box runs a restore drill: it restores the newest backup into a scratch
directory, starts a throwaway Postgres on it, reads every heap, and deletes
the lot. Weekly by default, and on demand.

## What it proves

| Signal                 | Answers                                        |
| ---------------------- | ---------------------------------------------- |
| `.brain-last-full` age | a backup was **taken**                         |
| archiver health        | WAL is **reaching** the repo                   |
| `pgbackrest verify`    | the repo **checksums** clean                   |
| **the drill**          | the repo **restores, starts, and reads back**  |

The first three can all be green while the fourth fails: a lost WAL segment,
a `pg_control` the cluster refuses, a `restore_command` that no longer
works. Only a restore finds that out, which is why the drill starts a server
and scans every table instead of stopping at "verify passed".

Counting every row of every user table forces a sequential scan of every
heap page, so a torn page or a missing relation file surfaces as an error
instead of as a cluster that merely started. It reads counts only, never
content.

It counts across every database, and fails when it finds no tables at all.
Both halves matter. A drill that connects only to the `postgres` bootstrap
database, where the brain has no tables, sums zero rows and reports a pass
having inspected nothing. A proof that succeeds while inspecting nothing is
worse than no proof, because it tells you the backups are fine. So the drill
walks every connectable database and reports each one, and a restored
cluster with no user tables anywhere is a failure. A healthy run looks like:

```
drill: brain    — 57 user table(s), 25618 row(s)
drill: postgres —  0 user table(s),     0 row(s)
drill PASSED: read 25618 row(s) across 57 user table(s) in 2 database(s)
```

## Running one by hand

```sh
docker compose --project-directory /opt/brain/deploy exec backup \
  brain-backup.sh drill
```

Takes a couple of minutes on a small database. Watch for `drill PASSED`. Do
this before any risky migration, and after any restore or volume move.

## Reading the result

The scheduler writes `<repo>/.brain-last-drill` as `<epoch> <status> <detail>`:

- `ok`: restored, started, every heap read. The only value that counts as
  proof.
- `fail`: the drill ran and the backup did not come back. This is the alarm.
- `skipped`: preconditions refused (no space, disk at the write-shed
  threshold). The drill did not run, so the result proves nothing either
  way.

Surface this file in whatever monitoring you run, and treat "no successful
drill within ~2 missed weekly runs" the same as a failure. `skipped` never
counts as a pass; a box that keeps skipping for space is unproven.

## How the drill is kept from hurting production

Two hazards are guarded in code.

1. Restoring over PGDATA. `assert_drill_path_safe` refuses a target that is
   empty, `/`, PGDATA, inside PGDATA, or an ancestor of PGDATA, and the
   restore is passed an explicit `--pg1-path`. The guard lives in the
   function that runs `rm -rf`, rather than only at the drill entry point,
   because the orphan reclaim in the scheduler's cycle deletes that path on
   ordinary scheduled cycles with no drill involved.

2. The drill archiving into the live repo. The restored PGDATA carries
   production's `postgresql.conf` verbatim: `archive_mode=on`,
   `archive_command` pointed at the live stanza. A promoted drill instance
   honouring that would push a bogus timeline into the archive every
   production restore depends on. Three layers guard it: `--archive-mode=off`
   on the restore (written into the restored config), `-c archive_mode=off`
   on the command line (which beats the config file), and a runtime
   assertion that `SHOW archive_mode` is `off`; anything else aborts the
   drill immediately. The drill also uses its own spool path
   (`--spool-path`); sharing the live one puts a recovering scratch instance
   and the live archive-async worker on the same queue, which measurably
   disturbs live archiving.

## Things that look like bugs and aren't

- `max_connections` is not lowered on the drill instance. Postgres refuses
  to finish recovery when it is below the primary's value
  (`recovery aborted because of insufficient parameter settings`), so a
  thriftier drill is a drill that always fails. The same applies to
  `max_worker_processes` and `max_locks_per_transaction`. `shared_buffers`
  has no such constraint and is the only setting trimmed.
- An orphaned drill directory is deleted, never `pg_ctl stop`ped.
  `pg_ctl -m immediate stop` SIGQUITs whatever pid is in `postmaster.pid`;
  in an orphan that pid was written by a process in a dead container, and
  container pids are small and heavily reused. Signalling it can land on a
  live Postgres backend, and the live postmaster then terminates every other
  backend and enters crash recovery: the box's own database briefly stops
  serving because a backup drill tidied up. Only an instance the current
  invocation started is ever signalled.
- The scratch copy is excluded from the repo `du`. It lives inside the repo
  volume but is not repo content; counting it would push the repo over
  budget mid-drill and start refusing backups for space about to be handed
  back. `df` still sees it, which is the reading that protects the volume.

## Knobs

| Env                                 | Default          | Meaning                                 |
| ----------------------------------- | ---------------- | --------------------------------------- |
| `BRAIN_RESTORE_DRILL_ENABLED`       | `1`              | set `0` to disable                      |
| `BRAIN_RESTORE_DRILL_INTERVAL_HOURS`| `168`            | weekly                                  |
| `BRAIN_RESTORE_DRILL_PATH`          | `<repo>/.drill`  | scratch target (guarded)                |
| `BRAIN_RESTORE_DRILL_PORT`          | `5433`           | drill instance port                     |
| `BRAIN_RESTORE_DRILL_SPACE_FACTOR`  | `3`              | free space required, × database size    |

## Limits

The repo is local, on the same volume as PGDATA. The drill proves the repo
restores; it does not make the repo survive losing the volume. Whole-volume
loss is still the job of block-level snapshots (e.g. cloud volume snapshots)
or an off-box copy. What the drill removes is the other failure: believing a
backup is good because it exists.
