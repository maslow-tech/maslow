# Disk growth, auto-grow, and the write-shed

Keep a long-lived, never-purged box from filling its data volume, and keep a
runaway or injected agent from ballooning your storage bill.

> Scope. Nothing in the brain is physically purged: soft-deletes stay,
> `before_image` history stays, `events` are append-only, backups accumulate.
> Storage only grows. The controls below bound that growth; they do not
> reverse it. A single data volume also means whole-volume loss is a
> residual; cover it with block-level snapshots.

---

## What grows (the disk-growth budget)

| Source                        | Why it grows                                            | Bounded by                                                                                        |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `objects` soft-deletes        | `delete` sets `deleted_at`; the row survives forever    | per-token delete quota + delete-rate monitoring                                                   |
| `before_image`                | history/revert snapshots per edit                       | **capped per object**                                                                             |
| `events`                      | append-only audit, never trimmed                        | closed-enum payloads; retention is a conscious future op                                          |
| `pg_wal`                      | WAL retained until archived                             | archiver health (below); hard-capped by `archive-push-queue-max=4GiB`, which drops WAL loudly rather than filling the volume |
| pgBackRest repo               | base backups + archived WAL, same disk                  | **20% of the volume**, computed at runtime — see below                                            |
| `<type>_ext`, junction tables | real rows for typed records                             | body ≤ 1 MB + per-account write-byte ceiling                                                      |

## The three caps

1. Per-object `body` ≤ 1 MB, enforced at the write path and by a DB CHECK
   (`objects_body_max`). The body column holds notes rather than files, and the cap
   also keeps each `tsvector` under its 1 MB limit.

2. Per-account write-byte ceiling (~250 MB/day, configurable), on top of the
   count/rate mutation budget, as a per-token rolling window. Every
   graph-mass tool (`merge`/`retype`/`set_type`/`link`) decrements it too, so
   a fan-out can't dodge the ceiling.

3. Per-box disk guards, the two that protect the volume itself:
   - Read-only write-shed at ~90% disk (`BRAIN_WRITE_SHED_PCT`). When the
     volume crosses the threshold, the box rejects writes with a teaching
     error while reads keep working. This keeps Postgres from wedging on a
     full disk and gives you (or auto-grow) time to act.
   - A hard auto-grow ceiling (if you automate volume growth; see below):
     expand up to a configured maximum, then stop and alert instead of
     ballooning the bill on non-shrinkable storage. A runaway or injected
     agent can still inflate storage, but the growth is bounded and visible.

## The backup repo's share of the volume

Backups are the line in the budget most likely to surprise you, because the
database is small and the WAL is not. Measured on a live box: a ~50 MB
database, ~10 GB/day of WAL. The base backup is free; the retained WAL is
the entire cost.

The `backup` sidecar (`deploy/postgres/backup-scheduler.sh`) holds the repo
inside a runtime-computed 20% of the volume. The budget is never a hardcoded
byte count, because boxes are provisioned at different sizes:

| Volume | Repo budget | Expected steady state                                 |
| ------ | ----------- | ----------------------------------------------------- |
| 50 G   | ~10 GiB     | ~2.5–5 GiB (12h fulls × 4 ⇒ ~48h of compressed WAL)   |
| 80 G   | ~16 GiB     | same window, same shape                               |

How it stays inside that:

- `expire` runs every cycle (not only after a backup), so old fulls and the
  WAL that depended on them are reclaimed.
- As the repo approaches its budget the scheduler expires harder: retention
  steps `4 → 3 → 2 → 1` full backups at 75% / 90% / 100% of budget. It never
  goes to 0: a repo holding only WAL, with no full to replay it onto,
  restores nothing.
- It refuses to start a backup when the volume is at or over
  `BRAIN_WRITE_SHED_PCT` (the same ~90% knob as the write-shed), when free
  space is under `BRAIN_BACKUP_MIN_FREE_MB`, or when the repo is still over
  budget after expiring. The refusal is logged loudly in
  `docker compose logs backup` instead of filling the disk.

If the repo sits at its budget for weeks, give the box a bigger volume or
shorten the PITR window rather than raising the budget.

## Volume auto-grow (optional, cloud-hosted boxes)

The box cannot grow its own volume, and should not be able to; keep that
capability out of band, under least-privilege IAM. On AWS the shape is:

- **Trigger:** a CloudWatch alarm on disk-used-percent, a disk-headroom
  alarm set well before the archiver can wedge. Emit the metric from the box
  (a small agent) or the CloudWatch Agent.
- **Action:** a Lambda with least-privilege IAM calls `ModifyVolume` to grow
  gp3, then the box's filesystem is grown online (`growpart` +
  `resize2fs`/`xfs_growfs`). gp3 grows without downtime.
- **Cooldown:** EBS allows one resize per volume per 6h; the alarm/Lambda
  must respect that cooldown (don't thrash). This is why the ~90% write-shed
  exists: it holds the line during the cooldown between grows.
- **Ceiling:** stop at a hard maximum (e.g. 10× the initial size) and alert.
  Never grow past it automatically; gp3 does not shrink, so every automatic
  grow is a permanent bill increase.

### Order of operations under pressure

```
disk climbing
  → disk-headroom alarm (early, before the archiver wedges)
    → grow the volume (respect the resize cooldown) → grow the FS online
  → still climbing / in cooldown → box hits ~90% → READ-ONLY WRITE-SHED
    (writes refused with a teaching error, reads OK)
  → reach the hard auto-grow ceiling → STOP auto-grow + ALERT (bill protection)
```

## Archiver health is part of disk health

A wedged WAL archiver (bad `archive_command`, full disk, pgBackRest failure)
makes Postgres retain WAL, and `pg_wal` fills the volume fast. Watch it:

```sql
SELECT last_archived_time, failed_count, last_failed_time FROM pg_stat_archiver;
```

`failed_count` climbing means archiving is broken, but it is not a
sufficient check on its own under async archiving; see `pitr.md` for the
checks that catch async failures. The disk-headroom alarm is the backstop if
the archiver alarm is missed.

## What to do when disk pressure hits

1. Confirm the source. `df -h` the data volume; break down by
   `pg_total_relation_size` on the big tables; check the repo
   (`du -sh /var/lib/pgbackrest` inside the `backup` container, or
   `pgbackrest info`) and the `pg_wal` size. `docker compose logs backup`
   prints the repo size against its budget on every cycle, so start there.
2. If the archiver is wedged: fix `archive_command`, free space, or repair
   pgBackRest so WAL can drain first; that is usually the fast filler. The
   sidecar logs `WAL ARCHIVING IS WEDGED` when `failed_count` is climbing
   and nothing has been archived for an hour.
3. If data growth is approaching the ceiling: raising the ceiling raises
   your bill, so decide it consciously. Shortening the PITR window
   (`BRAIN_BACKUP_RETENTION_FULL`, or a shorter
   `BRAIN_BACKUP_INTERVAL_HOURS`) is the cheapest lever, but it shortens how
   far back a mistake can be undone. Longer term, an `events` retention
   policy is a conscious future operation; nothing is auto-purged today.
4. Do not disable the write-shed to make writes work without headroom; a
   full-disk Postgres is a worse incident than a paused write path.
