# The Brain — box Postgres image.
#
# Stock postgres:17 (pgvector build) plus two things the appliance needs:
#
#  1. **pgBackRest** — the physical base backup + WAL archive that make real
#     PITR possible. Without it installed, `archive_command` has nothing to run;
#     that is exactly why the box shipped for months with `archive_mode = off`
#     and NO whole-database backups at all.
#  2. **Pre-created, postgres-owned directories** for every path a named volume
#     mounts over. Docker copies the image directory's ownership into an EMPTY
#     volume on first mount, so a directory that does not exist in the image
#     mounts ROOT-owned — and the server, which runs as uid `postgres`, then
#     cannot write there. Not hypothetical: on the first box the `pgwal_archive`
#     volume mounted root-owned and EVERY `archive_command` failed silently
#     (pg_stat_archiver failed_count in the thousands, archived_count 0, pg_wal
#     unable to recycle → a latent disk-fill).
#
# Base is the official pgvector build of postgres:17 (semantic search,
# migration 0014). On a box still running a pre-pgvector image, 0014 no-ops
# and search stays lexical until the postgres image is updated.
# Digest-pinned: the base is a community image and the release pipeline signs
# whatever this resolves to — a mutable tag would launder a compromised
# upstream into a first-party-trusted, fleet-converged database image. Bumps
# are deliberate PR-reviewed events.
FROM pgvector/pgvector:pg17@sha256:dd467f03ca5c5581222490e5217e48a262864ccb659be559f8491bbafdc97da0

# ------------------------------------------------------------------ pgBackRest
# Installed from the PGDG apt repo the official postgres image already carries.
#
# Deliberately NOT pinned to an exact `pgbackrest=<version>`: PGDG *removes*
# superseded versions from the pool, so an exact apt pin is a time bomb that
# fails every image build — and therefore every release, and therefore fleet
# self-updates — the day upstream rotates. The reproducibility boundary that
# actually matters is one layer up: this image is built once per release and
# pinned BY DIGEST into the signed bundle, so every box converges to the
# byte-identical artifact regardless of what apt resolved at build time.
#
# `pgbackrest version` at the end is a build-time smoke test: a broken or
# missing install fails the BUILD rather than shipping an image whose
# archive_command silently errors on every WAL segment.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends pgbackrest; \
  rm -rf /var/lib/apt/lists/*; \
  pgbackrest version

# Directories that named volumes / bind mounts land on. Ownership here is what a
# FRESH volume inherits (see the header) — get this wrong and archiving silently
# fails on every new box.
#   /var/lib/pgbackrest          the local repo (named volume `pgbackrest_repo`)
#   /var/spool/pgbackrest        archive-async spool (container-local, by design)
#   /var/log/pgbackrest          pgBackRest's own log files
#   /var/lib/postgresql/archive  legacy `cp` archive dir (volume `pgwal_archive`)
#   /var/run/postgresql          the unix socket dir, SHARED with the backup
#                                sidecar (pgBackRest has no TCP option for the
#                                local cluster — it connects over the socket)
#   /etc/pgbackrest, /etc/postgresql   config bind-mount targets
# 0750 on the repo keeps full copies of the brain off world-readable.
RUN set -eux; \
  mkdir -p \
    /var/lib/pgbackrest \
    /var/spool/pgbackrest \
    /var/log/pgbackrest \
    /var/lib/postgresql/archive \
    /var/run/postgresql \
    /etc/pgbackrest \
    /etc/postgresql; \
  chown postgres:postgres \
    /var/lib/pgbackrest \
    /var/spool/pgbackrest \
    /var/log/pgbackrest \
    /var/lib/postgresql/archive \
    /var/run/postgresql; \
  chmod 0750 \
    /var/lib/pgbackrest \
    /var/spool/pgbackrest \
    /var/log/pgbackrest; \
  rm -f /etc/pgbackrest.conf

# The scheduler the `backup` compose sidecar runs (12-hourly fulls, expire, the
# repo-budget guard, idempotent stanza bootstrap). Baked into the image rather
# than bind-mounted from the deploy tree: a bind mount of a path that does not
# exist yet becomes an empty DIRECTORY, which would make the sidecar crash-loop
# and take `compose up --wait` — and therefore the whole self-update — with it.
COPY backup-scheduler.sh /usr/local/bin/brain-backup.sh
RUN chmod 0755 /usr/local/bin/brain-backup.sh

# pgvector into template1 at initdb (fresh volumes only) — see the .sql header.
COPY initdb-pgvector.sql /docker-entrypoint-initdb.d/10-pgvector.sql
