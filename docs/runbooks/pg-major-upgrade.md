# Postgres major-version upgrade

Move a box from one major Postgres version (PG17, baked in) to the next. App
releases apply themselves; a major Postgres bump does not, and a multi-year
box will eventually need one.

> Scope. This is the one operation that touches the on-disk format of the
> whole brain. It is operator-gated (never auto-applied, unlike app
> releases; the updater refuses cross-major bundles) and snapshot-fenced:
> you take a volume snapshot plus a pgBackRest full before touching PGDATA,
> so the fallback is always a roll back to the pre-upgrade snapshot. If you
> have more than one box, run it on a test/staging box first.

---

## Why a major upgrade needs its own procedure

- The on-disk format changes across majors, so you cannot swap the
  `postgres:NN` image over the same PGDATA; you must `pg_upgrade` (or
  dump/restore).
- Collation is load-bearing. The brain uses the builtin `C.UTF-8` locale
  plus `COLLATE "C"` on identifier columns specifically so collation is
  version-stable across upgrades. A major upgrade is still the moment to
  re-validate it and `REINDEX` anything collation-affected, because a silent
  collation change corrupts unique indexes.
- Roles and grants are cluster-global. `pg_upgrade` preserves them, but the
  privilege audit (`disaster-recovery.md`) must pass afterward or the
  upgrade reopened escalation.

## Preconditions

- A scheduled maintenance window (writes are paused; the box goes read-only
  or down for the swap).
- A fresh volume snapshot and a fresh full backup, completed and
  `verify`-clean. This is the rollback. pgBackRest lives in the container,
  so both run through the `backup` service:

  ```bash
  cd /opt/brain/deploy
  docker compose exec backup /usr/local/bin/brain-backup.sh now
  docker compose run --rm --no-deps --user postgres backup pgbackrest --stanza=brain verify
  ```

- A target image chosen and pinned by digest.
- If you run more than one box: the procedure ran clean on a test box first.

## Procedure (pg_upgrade, in-place, snapshot-fenced)

1. Announce the window and freeze writes.

   ```bash
   docker compose -f deploy/docker-compose.yml stop app updater
   ```

2. Snapshot-fence. Take the volume snapshot and the pgBackRest full now;
   record the snapshot id as the rollback target.

3. Run `pg_upgrade` with both binaries present. Use a container/image that
   has both the old (PG_N) and new (PG_N+1) binaries, with the old PGDATA
   and a new empty PGDATA mounted:

   ```bash
   pg_upgrade \
     --old-datadir /var/lib/postgresql/old \
     --new-datadir /var/lib/postgresql/new \
     --old-bindir  /usr/lib/postgresql/17/bin \
     --new-bindir  /usr/lib/postgresql/NN/bin \
     --link            # hard-link for speed; the snapshot is the safety net
     --check           # FIRST run with --check only; fix every reported issue
   ```

   - Run `--check` first; it reports incompatibilities without touching
     data.
   - Initialize the new cluster with the same builtin `C.UTF-8` locale so
     collation is preserved:
     `initdb --locale-provider=builtin --locale=C.UTF-8 --encoding=UTF8`.

4. Point the stack at the new PGDATA (swap the `pgdata` volume / datadir the
   compose `postgres` service mounts) and start Postgres on the new major.

5. Post-upgrade integrity; do not skip any of these:

   ```bash
   # a) heap/index/collation corruption check (contrib amcheck)
   psql -d brain -c "CREATE EXTENSION IF NOT EXISTS amcheck;"
   # for each btree index: SELECT bt_index_check(index => 'idx'::regclass, heapallindexed => true);

   # b) reindex — pg_upgrade explicitly does NOT rebuild indexes; collation- and
   #    version-sensitive indexes MUST be rebuilt.
   psql -d brain -c "REINDEX (CONCURRENTLY) DATABASE brain;"

   # c) statistics — pg_upgrade drops them; regenerate or queries go slow.
   vacuumdb -d brain --all --analyze-in-stages
   ```

6. Re-validate collation. Confirm the builtin provider and `C.UTF-8`
   survived and no `datcollversion`/`collversion` mismatch is reported:

   ```sql
   SELECT datname, datlocprovider, datcollate, datctype FROM pg_database WHERE datname='brain';
   SELECT collname, collversion FROM pg_collation WHERE collprovider <> 'd';
   -- resolve any mismatch with ALTER DATABASE ... REFRESH COLLATION VERSION
   -- (only after the REINDEX above).
   ```

7. Privilege audit and drift reconciler. Run `auditPrivileges` from
   `@brain/schema` (see `disaster-recovery.md`); the upgrade must not have
   changed the least-privilege model. Then run the drift reconciler in
   report-only mode before reopening.

8. Re-establish backups on the new cluster. The `backup` sidecar does this
   itself: its bootstrap falls back to `stanza-upgrade` when `stanza-create`
   refuses because the cluster moved version, and it takes a full on its
   next cycle. Confirm rather than assume:

   ```bash
   docker compose logs --tail=50 backup
   docker compose run --rm --no-deps --user postgres backup pgbackrest --stanza=brain info
   ```

   To force it immediately:
   `docker compose exec backup /usr/local/bin/brain-backup.sh now`.

9. Reopen.

   ```bash
   docker compose -f deploy/docker-compose.yml start app updater
   ```

## Rollback

If `--check`, amcheck, the audit, or a smoke test fails at any point before
you have accepted the new cluster: stop Postgres, restore the pre-upgrade
volume snapshot / pgBackRest full, start on the old major image, reopen.
Because you fenced with a snapshot and used `--check` first, rollback loses
nothing (the window was read-only).

## Notes

- This runbook does not cover minor upgrades. A long-lived box gets
  base-layer / PG minor patches via a normal digest-pinned release
  (17.x → 17.y is a routine image roll). This runbook is for major bumps
  only.
- Prefer `pg_upgrade --link` for speed on a large brain; the snapshot is the
  safety net that makes `--link` acceptable. Use dump/restore
  (`disaster-recovery.md`, globals-first) only for a cross-arch or
  cross-host move where `pg_upgrade` can't run in place.

## After pg_upgrade: clear the updater's poisoned-version latch

A release bundle that pins a new Postgres major is refused automatically
(the updater fails `verify` with "cross-major swaps are runbook-only") and,
after 3 attempts, latches that version as poisoned. Completing pg_upgrade
does not clear the latch. After the upgrade:

1. SSH into the box, then reset the failed attempts in the updater's state:

   ```bash
   docker exec brain-updater-1 node -e "const f='/var/lib/brain-updater/state.json';const s=require(f);s.attempts={};delete s.latchedVersion;require('fs').writeFileSync(f,JSON.stringify(s,null,2))"
   ```

2. `docker restart brain-updater-1`; the next tick re-verifies the bundle,
   and with the majors now matching, the apply proceeds normally.

## Failure modes

- `--check` reports incompatibilities: fix every one before the real run;
  never run the mutating pass with open findings.
- Skipped REINDEX: a collation change corrupts unique indexes silently, and
  duplicates appear later. Always reindex after a major bump.
- Skipped `vacuumdb --analyze-in-stages`: the planner has no statistics and
  every query is slow. This looks like a broken upgrade but is only missing
  stats.
- Privilege audit fails after upgrade: objects owned by the wrong role, or
  grants drifted. Do not reopen until resolved (`disaster-recovery.md`).
