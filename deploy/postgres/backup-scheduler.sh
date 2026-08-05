#!/usr/bin/env bash
# The Brain — pgBackRest backup scheduler.
#
# Runs as the `backup` compose sidecar, from the SAME image as postgres (so the
# pgbackrest binary, the uid, and PGDATA's layout are identical) with the repo,
# PGDATA and the postgres unix socket mounted in. Its whole job:
#
#   1. bootstrap the stanza (idempotent, safe on a box that already has one)
#   2. take a FULL backup every BRAIN_BACKUP_INTERVAL_HOURS (default 12)
#   3. run `expire` EVERY cycle so old backups AND their dependent WAL are
#      reclaimed. Unbounded archive growth has filled production
#      disks before, forcing WAL archiving off entirely
#   4. hold the repo inside a runtime-computed budget (default 20% of the
#      volume), expiring harder as it approaches and REFUSING to start a backup
#      rather than filling the disk
#   5. run a RESTORE DRILL every BRAIN_RESTORE_DRILL_INTERVAL_HOURS (default
#      168 = weekly) — an actual restore into scratch, proving the repo can be
#      read back and not merely written to
#
# ------------------------------------------------------------------ never exit
# THE MOST IMPORTANT PROPERTY OF THIS SCRIPT: in `loop` mode it never exits on
# an error, and no failure mode makes the container exit. The updater converges
# a box with `docker compose up -d --wait <every service>`; a sidecar that exits
# non-zero fails that command, which fails the release apply, which — after
# three attempts — LATCHES the updater and silently stops the box from ever
# updating again (a production latch incident). A box with no backup is recoverable. A
# fleet that has stopped updating is not. So: warn, sleep, retry, forever.
#
# ------------------------------------------------------------------ honest posture
# The repo is LOCAL, on the same EBS volume as PGDATA (by design). This bounds
# LOGICAL mistakes — a bad migration, a dropped table, an operator or agent
# scribbling over rows — with PITR at RPO ≈ archive_timeout (~60s). It does NOT
# survive whole-volume loss. Off-box copies are a deliberate later stage.
#
# Modes:  brain-backup.sh [loop|once|now|drill]
#   loop  (default) forever: one cycle, sleep BRAIN_BACKUP_POLL_SECONDS, repeat
#   once  a single scheduled cycle (backs up only if one is due) then exit 0
#   now   a single cycle that takes a full backup regardless of the schedule,
#         subject to the space guards. This is the pre-risky-operation hook:
#         `docker compose exec backup brain-backup.sh now`
#   drill run the RESTORE DRILL now, regardless of its schedule: restore the
#         newest backup into a scratch dir, start a throwaway postgres on it,
#         read every heap, tear it down. Proves the backup is restorable
#         rather than merely present. Never touches PGDATA or the live repo.

set -uo pipefail # deliberately NOT -e: see "never exit" above

STANZA="${BRAIN_BACKUP_STANZA:-brain}"
REPO="${BRAIN_BACKUP_REPO_PATH:-/var/lib/pgbackrest}"
PG_SOCKET_DIR="${BRAIN_PG_SOCKET_DIR:-/var/run/postgresql}"
PG_PORT="${BRAIN_PG_PORT:-5432}"

# How often to take a FULL. Fulls are cheap here (the database is tens of MB;
# the WAL between them is the real cost), so a SHORT cadence is what keeps the
# retained-WAL window — and therefore the repo — small. See the budget note.
INTERVAL_HOURS="${BRAIN_BACKUP_INTERVAL_HOURS:-12}"
# Fulls to keep. 4 × 12h ⇒ a ~48h PITR window.
RETENTION_FULL="${BRAIN_BACKUP_RETENTION_FULL:-4}"
# Repo budget as a percentage of the WHOLE filesystem, computed at runtime —
# never hardcoded bytes, because boxes are provisioned at different sizes
# (20% ⇒ ~10 GiB on a 50 G volume, ~16 GiB on an 80 G one).
BUDGET_PCT="${BRAIN_BACKUP_REPO_BUDGET_PCT:-20}"
# THE SAME knob and the same measurement the box app's write-shed uses
# (apps/box/src/disk-guard.ts + vitals.ts: used/(used+available), i.e. `df`
# Capacity). Deliberately not a second threshold: when the box is shedding
# writes because the volume is nearly full, a backup is the last thing that
# should be adding to it. One number, one meaning, two enforcement points.
SHED_PCT="${BRAIN_WRITE_SHED_PCT:-90}"
# Absolute floor of free space required before starting a backup.
MIN_FREE_MB="${BRAIN_BACKUP_MIN_FREE_MB:-2048}"
POLL_SECONDS="${BRAIN_BACKUP_POLL_SECONDS:-300}"

# ------------------------------------------------------- the restore drill
# A backup nobody has ever restored is a hypothesis, not a backup. Every knob
# here is about making the drill impossible to confuse with production.
#
# The drill restores the newest backup into a SCRATCH directory, starts a
# throwaway postgres on it, reads every heap, and deletes it. It never touches
# PGDATA, never writes to the repo, and never runs while a backup is running
# (it shares the cycle flock).
DRILL_ENABLED="${BRAIN_RESTORE_DRILL_ENABLED:-1}"
# Weekly. The drill costs a full copy of the database in scratch space plus WAL
# replay; the base backup it validates only changes every 12h, and a repo that
# restored on Monday does not usually stop restoring on Tuesday.
DRILL_INTERVAL_HOURS="${BRAIN_RESTORE_DRILL_INTERVAL_HOURS:-168}"
# Lives INSIDE the repo volume (like .brain-last-full) so it needs no new mount
# and `df` accounts for it automatically. It is excluded from the repo `du` on
# purpose — a scratch copy is not repo content, and counting it would make the
# budget guard refuse backups for space the drill is about to give back.
DRILL_DIR="${BRAIN_RESTORE_DRILL_PATH:-$REPO/.drill}"
DRILL_PORT="${BRAIN_RESTORE_DRILL_PORT:-5433}"
DRILL_SOCKET_DIR="/tmp/brain-drill-sock"
# The drill's OWN archive spool. Never the live one: pgBackRest bakes the spool
# path into the restore_command of the restored cluster, so sharing it puts a
# recovering scratch instance and the live archive-async worker on the same
# queue.
DRILL_SPOOL_DIR="/tmp/brain-drill-spool"
DRILL_STATE_FILE="$REPO/.brain-last-drill"
# Multiplier on the restored database size for the free-space precondition.
DRILL_SPACE_FACTOR="${BRAIN_RESTORE_DRILL_SPACE_FACTOR:-3}"

STATE_FILE="$REPO/.brain-last-full"
LOCK_FILE="/tmp/brain-backup.lock"
# Read-only inputs to the archiver health check. Both must match
# pgbackrest.conf (spool-path) and postgresql.conf (PGDATA) — they are the two
# places that tell the TRUTH about archiving when pg_stat_archiver does not.
SPOOL_PATH="${BRAIN_BACKUP_SPOOL_PATH:-/var/spool/pgbackrest}"
PG_DATA="${BRAIN_PG_DATA:-/var/lib/postgresql/data}"

log() { printf '%s [brain-backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# --------------------------------------------------------------- run as postgres
# EVERYTHING pgBackRest does must run as the `postgres` uid. Running as root
# would leave root-owned files in the repo that the server's own archive-push
# (which runs as postgres) could never write to again — a repo that poisons
# itself on the first cycle.
#
# But we must ENTER as root exactly once, because of a paid-for lesson: Docker
# creates a named volume's mountpoint ROOT-OWNED when the path does not exist in
# the image. `pgbackrest_repo` has been declared in docker-compose.yml since long
# before the image created /var/lib/pgbackrest, so on every box already in the
# field that volume EXISTS and is root-owned — and postgres, running as uid
# `postgres`, cannot write to it. That is precisely how the first box's
# `pgwal_archive` volume silently failed every archive_command for weeks.
#
# So: if we are root, heal the ownership (best-effort, never fatal) and re-exec
# ourselves as postgres. Putting it HERE rather than in the compose `command`
# means every entry point is safe — the sidecar's own loop, an operator's
# `docker compose exec backup brain-backup.sh now`, and a `compose run`.
if [ "$(id -u)" = "0" ]; then
  chown postgres:postgres "$REPO" 2>/dev/null || true
  chmod 0750 "$REPO" 2>/dev/null || true
  for d in /var/spool/pgbackrest /var/log/pgbackrest; do
    [ -d "$d" ] && { chown postgres:postgres "$d" 2>/dev/null || true; }
  done
  if command -v gosu >/dev/null 2>&1; then
    log "started as root — healed ownership of $REPO and dropping to the postgres user"
    exec gosu postgres "$0" "$@"
  fi
  log "WARN running as root and gosu is missing; continuing as root, which will leave root-owned files in $REPO"
fi

# pgbackrest with the connection overrides this container needs. Everything else
# (repo path, retention, compression, async archiving) comes from
# /etc/pgbackrest/pgbackrest.conf, which is the SAME file postgres archives with.
# repo1-path is passed EXPLICITLY, not just inherited from pgbackrest.conf, so
# the path this script measures (df/du/budget/state) and the path pgBackRest
# writes to can never silently diverge — a guard watching the wrong filesystem
# is worse than no guard.
pgbr() {
  pgbackrest --stanza="$STANZA" \
    --repo1-path="$REPO" \
    --pg1-socket-path="$PG_SOCKET_DIR" --pg1-port="$PG_PORT" \
    --log-level-console=info "$@"
}

# Repo-only commands (expire, info) REJECT the pg-* options outright:
# `option 'pg-port' not valid for command 'expire'` is a hard error, so the
# connection overrides must not be passed to them.
pgbr_repo() {
  pgbackrest --stanza="$STANZA" \
    --repo1-path="$REPO" \
    --log-level-console=info "$@"
}

psql_q() {
  psql -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U postgres -d postgres -qtAX -c "$1" 2>/dev/null
}

pg_ready() { pg_isready -q -h "$PG_SOCKET_DIR" -p "$PG_PORT" >/dev/null 2>&1; }

# The stanza's two info files are written by stanza-create and are the cheapest
# honest existence check there is. Deliberately NOT `pgbackrest check`, which
# forces a WAL switch: at a 5-minute poll that would manufacture ~288 extra
# 16 MB segments a day, i.e. the scheduler would become a leading cause of the
# very WAL volume it exists to bound.
stanza_exists() {
  [ -f "$REPO/archive/$STANZA/archive.info" ] && [ -f "$REPO/backup/$STANZA/backup.info" ]
}

# --------------------------------------------------------------- disk readings
# All three come from ONE `df` call so they can never disagree with each other.
# Sets: FS_TOTAL_KB, FS_AVAIL_KB, FS_USED_PCT, REPO_KB, BUDGET_KB.
read_disk() {
  local line
  line="$(df -Pk "$REPO" 2>/dev/null | awk 'NR==2 {print $2, $3, $4}')"
  FS_TOTAL_KB="$(echo "$line" | awk '{print $1+0}')"
  local used_kb
  used_kb="$(echo "$line" | awk '{print $2+0}')"
  FS_AVAIL_KB="$(echo "$line" | awk '{print $3+0}')"
  if [ "$((used_kb + FS_AVAIL_KB))" -gt 0 ]; then
    FS_USED_PCT="$(((used_kb * 100 + (used_kb + FS_AVAIL_KB) - 1) / (used_kb + FS_AVAIL_KB)))"
  else
    FS_USED_PCT=0
  fi
  # The drill's scratch copy sits inside $REPO but is NOT repo content: counting
  # it would push the budget over mid-drill and refuse backups for space that is
  # about to be handed straight back. `df` above still sees it, which is the
  # reading that actually protects the volume.
  REPO_KB="$(du -sk --exclude=".drill" "$REPO" 2>/dev/null | awk '{print $1+0}')"
  [ -n "${REPO_KB:-}" ] || REPO_KB=0
  BUDGET_KB="$((FS_TOTAL_KB * BUDGET_PCT / 100))"
}

# --------------------------------------------------------------- the budget guard
# Retention LADDER: the configured retention is what we want; as the repo eats
# into its budget we keep fewer fulls (and therefore a shorter WAL tail, which
# is where the bytes actually are) rather than letting the repo win a race with
# the box's own data for the volume. Floor is 1 — never 0, because a repo with
# no full backup is not a backup, it is just WAL nobody can replay.
effective_retention() {
  local pct=$1
  if [ "$pct" -ge 100 ]; then
    echo 1
  elif [ "$pct" -ge 90 ]; then
    echo 2
  elif [ "$pct" -ge 75 ]; then
    echo 3
  else
    echo "$RETENTION_FULL"
  fi
}

# Expire is run EVERY cycle, before anything else that consumes space. Ordering
# is deliberate (the same lesson as pruning before writing): the moment you most
# need to free space is the moment you can least afford to write first.
guard_expire() {
  read_disk
  local budget_pct_used=0
  [ "$BUDGET_KB" -gt 0 ] && budget_pct_used="$((REPO_KB * 100 / BUDGET_KB))"
  local keep
  keep="$(effective_retention "$budget_pct_used")"
  if [ "$keep" -lt "$RETENTION_FULL" ]; then
    log "WARN repo ${REPO_KB}K is ${budget_pct_used}% of its ${BUDGET_KB}K budget (${BUDGET_PCT}% of ${FS_TOTAL_KB}K volume) — expiring HARDER: keeping ${keep} full(s) instead of ${RETENTION_FULL}"
  fi
  if ! pgbr_repo --repo1-retention-full="$keep" --repo1-retention-archive="$keep" expire; then
    log "WARN expire failed (continuing; the next cycle retries)"
    return 1
  fi
  return 0
}

# --------------------------------------------------------------- space refusal
# Refuse LOUDLY rather than fill the disk. Three independent reasons, each
# logged with the numbers that produced it so an operator never has to guess.
space_ok() {
  read_disk
  if [ "$FS_USED_PCT" -ge "$SHED_PCT" ]; then
    log "ERROR REFUSING backup: volume is ${FS_USED_PCT}% used, at/over the write-shed threshold (${SHED_PCT}%). The box is already shedding writes; a backup would make it worse. Free space or grow the volume (docs/runbooks/disk-and-growth.md)."
    return 1
  fi
  if [ "$((FS_AVAIL_KB / 1024))" -lt "$MIN_FREE_MB" ]; then
    log "ERROR REFUSING backup: only $((FS_AVAIL_KB / 1024)) MB free, below the ${MIN_FREE_MB} MB floor."
    return 1
  fi
  if [ "$BUDGET_KB" -gt 0 ] && [ "$REPO_KB" -ge "$BUDGET_KB" ]; then
    log "ERROR REFUSING backup: repo is ${REPO_KB}K, at/over its ${BUDGET_KB}K budget (${BUDGET_PCT}% of a ${FS_TOTAL_KB}K volume) even after expiring. Retention is already at its floor — this box needs a bigger volume or a shorter PITR window."
    return 1
  fi
  return 0
}

# --------------------------------------------------------------- bootstrap
# Idempotent by construction and NEVER fatal. On a box that already has a
# stanza this does nothing; on a fresh volume it creates one; on a cluster whose
# version/layout moved under an existing stanza it upgrades. Any other outcome
# is a warning and a retry next cycle — a box we cannot bootstrap keeps running,
# it does not stop booting.
bootstrap() {
  log "stanza '$STANZA' not initialised in $REPO — running stanza-create"
  if pgbr stanza-create; then
    log "stanza-create OK; verifying the archive round-trip (pgbackrest check)"
    if pgbr check; then
      log "archive round-trip OK — PITR is live"
    else
      log "WARN pgbackrest check failed right after stanza-create; archiving may not be flowing yet (postgres retries archive_command). Will re-check next cycle."
    fi
    return 0
  fi
  log "WARN stanza-create failed — trying stanza-upgrade (existing repo, moved cluster)"
  if pgbr stanza-upgrade; then
    log "stanza-upgrade OK"
    return 0
  fi
  log "WARN could not initialise the stanza. NOT failing the container; retrying in ${POLL_SECONDS}s. Until this succeeds there are NO backups and WAL will queue (bounded by archive-push-queue-max, see pgbackrest.conf)."
  return 1
}

# --------------------------------------------------------------- archiver health
# A wedged archiver is the fast disk-filler: postgres refuses to recycle
# WAL it has not archived. Log it every cycle so `docker logs brain-backup-1`
# is enough to diagnose it without a psql session.
report_archiver() {
  local row failed last_ok_age
  row="$(psql_q "SELECT coalesce(archived_count,0) || ' archived, ' || coalesce(failed_count,0) || ' failed, last=' || coalesce(last_archived_wal,'none') || ' at ' || coalesce(last_archived_time::text,'never') FROM pg_stat_archiver")"
  [ -n "$row" ] && log "archiver: $row"
  # Numeric-only, defaulted: psql can return empty (connection lost mid-cycle)
  # and an empty string in a [ -gt ] test is a shell error, not a diagnosis.
  failed="$(psql_q "SELECT coalesce(failed_count,0) FROM pg_stat_archiver" | awk '{print $1+0}')"
  last_ok_age="$(psql_q "SELECT coalesce(extract(epoch from now()-last_archived_time)::bigint, -1) FROM pg_stat_archiver" | awk '{print $1+0}')"
  [ -n "${failed:-}" ] || failed=0
  [ -n "${last_ok_age:-}" ] || last_ok_age=-1

  # Two INDEPENDENT signals, because failed_count is not trustworthy on its own.
  # MEASURED 2026-07-29, locally and on the prod box: with archive-async=y and a
  # missing/broken stanza, archive-push hands the segment to a background worker
  # and returns 0 — so pg_stat_archiver reports archived=0 failed=0
  # last_archived_time=NULL while archiving is comprehensively broken. Gating the
  # alarm on `failed > 0` (as this did) makes it silent in exactly the case that
  # has nearly filled production disks.
  #
  #  (a) the async worker's own verdict, written into the spool. Present = the
  #      last push attempt FAILED, regardless of what postgres thinks.
  #  (b) segments queued in archive_status with no recent archive success. This
  #      catches the async blind spot: nothing is flowing and WAL is piling up.
  local spool_err=0 pending=0
  [ -d "$SPOOL_PATH/archive/$STANZA/out" ] &&
    spool_err="$(find "$SPOOL_PATH/archive/$STANZA/out" -name '*.error' 2>/dev/null | wc -l | awk '{print $1+0}')"
  pending="$(find "$PG_DATA/pg_wal/archive_status" -name '*.ready' 2>/dev/null | wc -l | awk '{print $1+0}')"
  [ -n "${spool_err:-}" ] || spool_err=0
  [ -n "${pending:-}" ] || pending=0
  log "archiver detail: ${pending} segment(s) queued, ${spool_err} spool error(s)"

  local stale=0
  { [ "$last_ok_age" -lt 0 ] || [ "$last_ok_age" -gt 3600 ]; } && stale=1

  if [ "$spool_err" -gt 0 ] ||
    { [ "$failed" -gt 0 ] && [ "$stale" -eq 1 ]; } ||
    { [ "$pending" -gt 2 ] && [ "$stale" -eq 1 ]; }; then
    log "ERROR WAL ARCHIVING IS WEDGED (failed_count=${failed}, ${pending} queued, ${spool_err} spool error(s), last success ${last_ok_age}s ago). pg_wal will grow until archive-push-queue-max drops segments LOUDLY. See docs/runbooks/pitr.md."
  fi
}

# --------------------------------------------------------------- schedule
due() {
  [ ! -f "$STATE_FILE" ] && return 0
  local last now
  last="$(cat "$STATE_FILE" 2>/dev/null | awk '{print $1+0}')"
  [ "${last:-0}" -gt 0 ] || return 0
  now="$(date +%s)"
  # A marker in the FUTURE means the clock moved backwards (NTP correction on a
  # long-lived box, a restored volume carrying an old marker, a bad write). Left
  # alone, `now - last` stays negative forever and this box silently never takes
  # another backup — the worst failure this script can have, because everything
  # else keeps looking healthy. Treat it as due and let take_full re-stamp it.
  if [ "$last" -gt "$now" ]; then
    log "WARN $STATE_FILE is $((last - now))s in the FUTURE (clock moved backwards?) — taking a full and re-stamping it"
    return 0
  fi
  [ "$((now - last))" -ge "$((INTERVAL_HOURS * 3600))" ]
}

take_full() {
  log "taking a FULL backup (stanza=$STANZA)"
  if pgbr --type=full backup; then
    date +%s >"$STATE_FILE" 2>/dev/null || log "WARN could not write $STATE_FILE (schedule falls back to backing up every cycle)"
    read_disk
    log "full backup OK — repo now ${REPO_KB}K of a ${BUDGET_KB}K budget; volume ${FS_USED_PCT}% used"
    return 0
  fi
  log "WARN full backup FAILED — retrying next cycle (see /var/log/pgbackrest)"
  return 1
}

# =============================================================== restore drill
#
# "A restore you have never done is not a backup." Everything above proves we
# WROTE something; only this proves we can READ it back. It is deliberately a
# real restore and a real postgres, not `pgbackrest verify` alone — verify
# checksums the repo, which cannot catch a base backup that is internally
# consistent but unusable (wrong pg version, missing tablespace, a WAL segment
# the archive lost, a restore_command that no longer works).
#
# THE TWO WAYS THIS COULD HURT PRODUCTION, and how each is closed:
#
#  1. Restoring over PGDATA. `assert_drill_path_safe` refuses unless the target
#     is a non-empty path that is neither PGDATA nor an ancestor of it, and the
#     restore is passed an explicit --pg1-path. A drill that cannot prove where
#     it is pointing does not run.
#  2. The restored cluster archiving ITS WAL into the real repo. The restored
#     PGDATA carries production's postgresql.conf verbatim — archive_mode=on and
#     an archive_command pointing at our stanza — so a promoted drill instance
#     would push a bogus timeline into the archive every real restore
#     depends on. `-c archive_mode=off` on the command line overrides the config
#     file, and startup then ASSERTS `SHOW archive_mode` = off and aborts if it
#     is anything else. This is the one failure here that would damage rather
#     than merely fail.
#
# Like everything else in this file it can only ever warn: a failed drill is
# loud, recorded, and reported to the booth, but it never exits the container.

# Refuse any drill path that could collide with the live cluster.
assert_drill_path_safe() {
  case "$DRILL_DIR" in
    "" | "/" | "/var/lib/postgresql" | "$PG_DATA" | "$PG_DATA"/*)
      log "ERROR REFUSING drill: BRAIN_RESTORE_DRILL_PATH ('$DRILL_DIR') is empty, root, or inside PGDATA ('$PG_DATA')"
      return 1
      ;;
  esac
  # Also refuse an ANCESTOR of PGDATA (rm -rf on it would take the live cluster).
  case "$PG_DATA" in
    "$DRILL_DIR"/*)
      log "ERROR REFUSING drill: drill path '$DRILL_DIR' contains PGDATA '$PG_DATA'"
      return 1
      ;;
  esac
  return 0
}

# The pid of the scratch postmaster THIS invocation forked, or empty. It is a
# DIRECT CHILD of this shell — never a daemon, never resolved from a pid file.
# See the header on drill_stop for why that distinction is load-bearing.
DRILL_PID=""

# Delete the scratch tree. NEVER signals anything — see drill_stop.
#
# The path guard lives HERE, not only in restore_drill, because this is what
# actually runs `rm -rf`, and it has a second caller (the orphan reclaim in
# cycle()) reached on ordinary scheduled cycles with no drill involved.
# Asserting only at the drill entry point would leave a box where pointing
# BRAIN_RESTORE_DRILL_PATH at PGDATA makes a routine backup cycle delete the
# live cluster. A destructive helper validates its own target.
drill_reclaim() {
  assert_drill_path_safe || return 1
  rm -rf "$DRILL_DIR" "$DRILL_SOCKET_DIR" "$DRILL_SPOOL_DIR" 2>/dev/null || true
  return 0
}

# Stop ONLY the instance this invocation forked, then reclaim.
#
# WHY THIS SIGNALS A CHILD PID AND NEVER A PID FILE (measured 2026-08-02).
#
# The drill used to start its scratch cluster with `pg_ctl start` and stop it
# with `pg_ctl -m immediate stop`, which resolves the target from
# $DRILL_DIR/postmaster.pid. Two ways that bites, both real:
#
#   1. A pid file is a CLAIM about a pid, not a handle on a process. For an
#      ORPHANED drill dir — left by a container killed mid-drill — the pid was
#      recorded by a process in a DEAD container, and container pids are small
#      and heavily reused. Signalling it can land on an unrelated live process.
#
#   2. Worse, and the one that was actually reproduced: `pg_ctl start`
#      DAEMONISES. The scratch postmaster's parent exits, so the kernel
#      re-parents it to PID 1 of whatever container the drill is running in.
#      In the `backup` sidecar PID 1 is this script, which is fine. But the
#      scheduler ships in the POSTGRES image too, so `docker compose exec
#      postgres brain-backup.sh drill` puts it in a container where PID 1 is the
#      LIVE POSTMASTER. The live postmaster then reaps a child it never forked,
#      cannot tell it from a crashed backend, and does what a crashed backend
#      demands: "terminating any other active server processes" — it kills every
#      connection and crash-recovers the live database. Confirmed by
#      running it: 4 drills, 4 crash-recovery cycles, the live cluster refusing
#      connections each time. A BACKUP DRILL took the database down.
#
# Forking the postmaster as a direct child of this shell closes both. It is
# never orphaned, so no PID 1 anywhere can inherit it; and we signal the pid we
# ourselves forked, so there is no window in which it means someone else.
# `wait` then reaps it here, which is the whole point — the process is accounted
# for by its real parent instead of by whatever init happens to be nearby.
drill_stop() {
  if [ -n "$DRILL_PID" ]; then
    # SIGQUIT = postgres immediate shutdown. It is going in the bin either way.
    kill -QUIT "$DRILL_PID" 2>/dev/null || true
    # Reap it HERE. Without this the postmaster lingers as a zombie on this
    # shell, and on the `loop` path this shell is PID 1 of the sidecar.
    wait "$DRILL_PID" 2>/dev/null || true
    DRILL_PID=""
  fi
  drill_reclaim
}

# Wait for the scratch postmaster to accept connections, failing fast if it dies
# instead of burning the full timeout. `pg_ctl -w` did this for us; doing it by
# hand is the cost of not daemonising, and it is a low price.
drill_wait_ready() {
  local waited=0
  while [ "$waited" -lt 120 ]; do
    if ! kill -0 "$DRILL_PID" 2>/dev/null; then return 1; fi # died during startup
    if pg_isready -q -h "$DRILL_SOCKET_DIR" -p "$DRILL_PORT" 2>/dev/null; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

drill_due() {
  [ "$DRILL_ENABLED" = "1" ] || return 1
  [ ! -f "$DRILL_STATE_FILE" ] && return 0
  local last now
  last="$(awk '{print $1+0}' "$DRILL_STATE_FILE" 2>/dev/null)"
  [ "${last:-0}" -gt 0 ] || return 0
  now="$(date +%s)"
  # Same future-marker trap as the full-backup schedule: a clock that moved
  # backwards must not silently disable drills forever.
  if [ "$last" -gt "$now" ]; then
    log "WARN $DRILL_STATE_FILE is in the FUTURE — treating the drill as due"
    return 0
  fi
  [ "$((now - last))" -ge "$((DRILL_INTERVAL_HOURS * 3600))" ]
}

record_drill() {
  local status="$1" detail="$2"
  printf '%s %s %s\n' "$(date +%s)" "$status" "$detail" >"$DRILL_STATE_FILE" 2>/dev/null ||
    log "WARN could not write $DRILL_STATE_FILE"
}

# The proof query, run PER DATABASE. Counting every row of every user table
# forces a sequential scan of every heap page, so a torn page or a lost relation
# file surfaces as an error rather than as a cluster that merely STARTED. It
# reads counts, never content.
#
# PER DATABASE is the whole point, and getting it wrong shipped a false green
# (caught on the canary box 2026-07-31, first real run). The brain's tables live
# in the `brain` database, not `postgres`; the drill connected to `postgres`,
# found no user tables there, summed zero, and reported "drill PASSED: read 0
# rows" on a box holding ~11k objects. A proof that passes when it inspected
# NOTHING is worse than no proof. Hence both fixes below: walk every connectable
# database, and FAIL when the restored cluster has no user tables anywhere.
DRILL_COUNT_SQL="SELECT coalesce(sum(cnt), 0) FROM (
  SELECT (xpath('/row/c/text()',
      query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename),
                   false, true, '')))[1]::text::bigint AS cnt
  FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) t;"
DRILL_TABLE_SQL="SELECT count(*) FROM pg_tables
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema');"
DRILL_DB_SQL="SELECT datname FROM pg_database
  WHERE datistemplate = false AND datallowconn ORDER BY datname;"

restore_drill() {
  assert_drill_path_safe || return 1
  if ! stanza_exists; then
    log "drill skipped: no stanza yet"
    return 1
  fi

  # Precondition: enough free space for a whole copy of the database. Read the
  # newest backup's size straight from the repo rather than guessing.
  local db_kb=0
  db_kb="$(pgbr_repo --output=json info 2>/dev/null |
    sed -n 's/.*"database":{"size":\([0-9]*\).*/\1/p' | tail -1 | awk '{print int($1/1024)}')"
  [ -n "${db_kb:-}" ] || db_kb=0
  read_disk
  local need_kb=$((db_kb * DRILL_SPACE_FACTOR))
  if [ "$db_kb" -gt 0 ] && [ "$FS_AVAIL_KB" -lt "$need_kb" ]; then
    log "WARN drill skipped: needs ~${need_kb}K free (${DRILL_SPACE_FACTOR}x a ${db_kb}K database), only ${FS_AVAIL_KB}K available"
    record_drill skipped "insufficient-space"
    return 1
  fi
  if [ "$FS_USED_PCT" -ge "$SHED_PCT" ]; then
    log "WARN drill skipped: volume ${FS_USED_PCT}% used, at/over the write-shed threshold"
    record_drill skipped "disk-pressure"
    return 1
  fi

  log "restore drill starting (scratch=$DRILL_DIR, port=$DRILL_PORT)"
  drill_reclaim # clear any orphan from a killed container (delete only)
  mkdir -p "$DRILL_DIR" "$DRILL_SOCKET_DIR" 2>/dev/null
  chmod 700 "$DRILL_DIR" 2>/dev/null

  # 1. Repo integrity. `verify` is newer than some pgbackrest builds in the
  #    field, so its ABSENCE is a notice, not a failure.
  if pgbackrest help verify >/dev/null 2>&1; then
    if pgbr_repo verify; then
      log "drill: repo verify OK"
    else
      log "ERROR drill FAILED at verify — the repo does not checksum clean"
      record_drill fail "verify"
      drill_reclaim
      return 1
    fi
  else
    log "drill: this pgbackrest has no 'verify' command — skipping that step"
  fi

  # 2. The real restore. --type=immediate stops the moment the cluster reaches
  #    consistency: that still requires fetching WAL through restore_command, so
  #    the ARCHIVE is exercised, without replaying a day of it on a prod box.
  # --spool-path is its OWN, not the live one. pgBackRest bakes the spool path
  # into the restore_command it writes into the restored postgresql.auto.conf,
  # so a drill sharing the production spool has its recovering instance's
  # archive-get working the same queue the live archive-async worker is pushing
  # through — which measurably disturbed live archiving (the integration suite
  # caught it as archived_count stuck at 0 in an unrelated, earlier test).
  # --archive-mode=off is the same belt as the `-c archive_mode=off` at startup:
  # pgBackRest writes it into the restored config, so the instance cannot archive
  # even if it were started by something other than this script.
  rm -rf "$DRILL_SPOOL_DIR" 2>/dev/null
  mkdir -p "$DRILL_SPOOL_DIR" 2>/dev/null
  if ! pgbackrest --stanza="$STANZA" --repo1-path="$REPO" --pg1-path="$DRILL_DIR" \
    --spool-path="$DRILL_SPOOL_DIR" --archive-mode=off \
    --log-level-console=info --type=immediate --target-action=promote restore; then
    log "ERROR drill FAILED at restore — the newest backup did not reconstitute"
    record_drill fail "restore"
    drill_reclaim
    return 1
  fi
  log "drill: restore OK — starting a throwaway postgres on it"

  # 3. Start it. archive_mode=off is NOT optional (see the header): the restored
  #    config is production's, and a promoted instance would otherwise archive a
  #    bogus timeline into the repo every real restore depends on. listen_addresses
  #    empty = no TCP at all; a private socket dir + its own port mean nothing on
  #    this box can reach it by accident.
  #
  #    Do NOT lower max_connections / max_worker_processes / max_locks_per_
  #    transaction here to shrink the footprint. Postgres refuses to finish
  #    recovery when any of them is below the value the PRIMARY had —
  #    "recovery aborted because of insufficient parameter settings" — so a
  #    thriftier drill is a drill that always fails. shared_buffers has no such
  #    constraint, which is why it is the only one trimmed. (Caught by the
  #    integration test, not by review.)
  # Forked as a DIRECT CHILD of this shell, deliberately not `pg_ctl start` —
  # see drill_stop's header. A daemonised scratch postmaster gets re-parented to
  # PID 1, and in the postgres image PID 1 is the live postmaster, which reads
  # the death of a process it did not fork as a backend crash and restarts the
  # whole database. DRILL_PID is assigned before the readiness wait so a
  # half-started instance is still ours to kill.
  postgres -D "$DRILL_DIR" -c archive_mode=off -c listen_addresses='' \
    -c port="$DRILL_PORT" -c unix_socket_directories="$DRILL_SOCKET_DIR" \
    -c shared_buffers=64MB >>"$DRILL_DIR/drill.log" 2>&1 &
  DRILL_PID=$!
  if ! drill_wait_ready; then
    log "ERROR drill FAILED: the restored cluster did not start"
    [ -f "$DRILL_DIR/drill.log" ] && tail -20 "$DRILL_DIR/drill.log" | while read -r l; do log "  drill-pg: $l"; done
    record_drill fail "start"
    drill_stop
    return 1
  fi

  local dq="psql -h $DRILL_SOCKET_DIR -p $DRILL_PORT -U postgres -d postgres -qtAX -c"
  # 3a. THE assertion that keeps this drill from damaging production.
  local am
  am="$($dq 'SHOW archive_mode' 2>/dev/null | tr -d '[:space:]')"
  if [ "$am" != "off" ]; then
    log "ERROR drill ABORTED: restored cluster reports archive_mode='$am', expected 'off' — refusing to let a drill archive into the live repo"
    record_drill fail "archive-mode-not-off"
    drill_stop
    return 1
  fi

  # 4. Read every heap, in EVERY database. `postgres` is just the bootstrap
  #    database — the brain's tables live elsewhere — so a single-database scan
  #    proves nothing about the data anyone cares about.
  local dbs rows tables total_rows=0 total_tables=0 db
  dbs="$($dq "$DRILL_DB_SQL" 2>/dev/null)"
  if [ -z "${dbs:-}" ]; then
    log "ERROR drill FAILED: the restored cluster lists no connectable databases"
    record_drill fail "no-databases"
    drill_stop
    return 1
  fi
  for db in $dbs; do
    rows="$(psql -h "$DRILL_SOCKET_DIR" -p "$DRILL_PORT" -U postgres -d "$db" -qtAX \
      -c "$DRILL_COUNT_SQL" 2>/dev/null | tr -d '[:space:]')"
    tables="$(psql -h "$DRILL_SOCKET_DIR" -p "$DRILL_PORT" -U postgres -d "$db" -qtAX \
      -c "$DRILL_TABLE_SQL" 2>/dev/null | tr -d '[:space:]')"
    if ! printf '%s' "${rows:-}" | grep -Eq '^[0-9]+$' ||
      ! printf '%s' "${tables:-}" | grep -Eq '^[0-9]+$'; then
      log "ERROR drill FAILED: the restored cluster started but database '$db' could not be read"
      record_drill fail "read:$db"
      drill_stop
      return 1
    fi
    log "drill: $db — ${tables} user table(s), ${rows} row(s)"
    total_rows=$((total_rows + rows))
    total_tables=$((total_tables + tables))
  done

  # THE GUARD THAT MAKES THIS HONEST. A restored cluster with no user tables in
  # any database is not a successful restore — it is a check that inspected
  # nothing and would otherwise report success. This is the assertion that turns
  # the 2026-07-31 false green into a loud failure.
  if [ "$total_tables" -eq 0 ]; then
    log "ERROR drill FAILED: the restored cluster has NO user tables in any database — nothing was actually verified"
    record_drill fail "no-user-tables"
    drill_stop
    return 1
  fi

  log "drill PASSED: restored, started, and read ${total_rows} row(s) across ${total_tables} user table(s) in $(printf '%s' "$dbs" | wc -w | tr -d ' ') database(s)"
  record_drill ok "rows=${total_rows} tables=${total_tables}"
  drill_stop
  return 0
}

# --------------------------------------------------------------- one cycle
cycle() {
  local mode="$1"
  # An orphaned drill directory means a previous drill was killed mid-flight
  # (container stop, OOM). It holds a whole copy of the database, so leaving it
  # costs real volume — reclaim it BEFORE the disk reading, so what we log and
  # act on is the space we actually have. Safe here: drills only run under this
  # same flock, so nothing can be using it.
  if [ "$mode" != "drill" ] && [ -d "$DRILL_DIR" ]; then
    log "WARN reclaiming an orphaned restore-drill directory at $DRILL_DIR"
    drill_reclaim
  fi
  read_disk
  log "cycle(${mode}): volume ${FS_USED_PCT}% used, ${FS_TOTAL_KB}K total, $((FS_AVAIL_KB / 1024))MB free; repo ${REPO_KB}K / ${BUDGET_KB}K budget (${BUDGET_PCT}%)"

  # Reclaim FIRST, unconditionally — this is the one useful thing we can do
  # even when postgres is down and the disk is tight.
  if stanza_exists; then guard_expire; fi

  if ! pg_ready; then
    log "postgres is not accepting connections on $PG_SOCKET_DIR:$PG_PORT — waiting (this is normal during a release or a restart)"
    return 0
  fi

  if ! stanza_exists; then
    bootstrap || return 0
  fi

  report_archiver

  # An explicit `drill` run is about the drill, not the schedule — it must not
  # be swallowed by the "no full due" early return below.
  if [ "$mode" = "drill" ]; then
    restore_drill || true
    return 0
  fi

  if [ "$mode" != "forced" ] && ! due; then
    local last remain
    last="$(awk '{print $1+0}' "$STATE_FILE" 2>/dev/null)"
    [ -n "${last:-}" ] || last=0
    remain="$(((INTERVAL_HOURS * 3600 - ($(date +%s) - last)) / 60))"
    log "no full due (interval ${INTERVAL_HOURS}h, next in ~${remain}m)"
    # A due drill still runs on a cycle with no due full — otherwise the drill
    # cadence would be silently rounded up to the backup cadence.
    if drill_due; then restore_drill || true; fi
    return 0
  fi

  space_ok || return 0
  take_full || return 0
  # A fresh full may have made the oldest one expirable — reclaim immediately
  # rather than carrying the extra full (and its WAL) for another 12h.
  guard_expire

  # The drill runs AFTER the full, never instead of one. Order matters: a box
  # tight on space should spend it on HAVING a backup, not on proving last
  # week's still restores. Its failure is non-fatal by construction.
  if drill_due; then restore_drill || true; fi
  return 0
}

# One cycle at a time, per container. `docker compose exec backup
# brain-backup.sh now` runs in the SAME container as the loop, so a plain flock
# on a container-local path is enough to stop an operator's manual backup from
# racing the scheduler's (concurrent pgbackrest backups on one stanza are a
# repo-corruption hazard).
guarded_cycle() {
  local mode="$1"
  # NB: a SUBSHELL redirect, never `exec 9>…` — a failed `exec` redirect makes a
  # non-interactive bash EXIT, which is precisely the container death this whole
  # script is built to avoid.
  if ! : >>"$LOCK_FILE" 2>/dev/null; then
    log "WARN cannot open $LOCK_FILE — running unguarded"
    cycle "$mode"
    return 0
  fi
  (
    if ! flock -n 9; then
      log "another backup cycle is already running in this container — skipping"
      exit 0
    fi
    cycle "$mode"
  ) 9>>"$LOCK_FILE"
  return 0
}

main() {
  local mode="${1:-loop}"
  case "$mode" in
    once)
      guarded_cycle scheduled
      exit 0
      ;;
    now)
      guarded_cycle forced
      exit 0
      ;;
    drill)
      guarded_cycle drill
      exit 0
      ;;
    loop) ;;
    *)
      log "unknown mode '$mode' — expected loop|once|now|drill. Idling rather than exiting."
      mode=loop
      ;;
  esac

  log "scheduler starting: full every ${INTERVAL_HOURS}h, keep ${RETENTION_FULL} full(s) (~$((INTERVAL_HOURS * RETENTION_FULL))h PITR window), repo budget ${BUDGET_PCT}% of the volume, poll ${POLL_SECONDS}s"
  # Exit promptly on compose stop/recreate: bash only runs traps between
  # commands, so sleep must be backgrounded and waited on.
  trap 'log "SIGTERM — stopping"; exit 0' TERM INT
  while true; do
    guarded_cycle scheduled
    sleep "$POLL_SECONDS" &
    wait $! || true
  done
}

# `BRAIN_BACKUP_LIB_ONLY=1 source brain-backup.sh` defines the functions without
# running anything — how the integration suite exercises the budget arithmetic
# (effective_retention, space_ok) against real filesystems of a known size,
# deterministically, instead of trying to fill a CI runner's disk.
if [ "${BRAIN_BACKUP_LIB_ONLY:-0}" != "1" ]; then
  main "$@"
fi
