# Self-hosting maslow

This page covers what the box needs, what the installer writes, and how you
operate it. The step-by-step installer procedure is in
[runbooks/install.md](runbooks/install.md).

## Requirements

- A Linux host, amd64 or arm64. 2+ vCPU, 4 GB+ RAM, and 50 GB+ disk are
  recommended.
- Docker with Compose v2.
- A DNS name pointed at the host. Caddy provisions TLS automatically.
- Ports 80 and 443 reachable.

## Install

```bash
curl -fsSL https://github.com/maslow-tech/maslow/releases/latest/download/install.sh \
  -o install.sh
sudo BRAIN_BOOTSTRAP_OWNER_NAME="Your Name" \
     BRAIN_BOOTSTRAP_OWNER_EMAIL="you@yourdomain.com" \
     bash install.sh brain.yourdomain.com
```

The installer:

1. writes `/opt/brain/deploy/` (compose file, configs) and a `600 root:root`
   `.env` with generated Postgres passwords and box keys,
2. starts the five services: `postgres`, `app`, `caddy`, `backup`, `updater`,
3. prints the first owner's login for `https://brain.yourdomain.com`.

Re-running the installer is safe. It preserves existing credentials and image
pins (repair mode).

## The services

| Service    | Role                                                         |
| ---------- | ------------------------------------------------------------ |
| `app`      | MCP server, dashboard, API                                   |
| `postgres` | all state, with pgvector                                     |
| `caddy`    | TLS termination and reverse proxy                            |
| `backup`   | pgBackRest scheduler: full backups every 12 h, WAL archiving |
| `updater`  | follows the release feed, verifies signatures, applies updates |

## Configuration

All configuration lives in `/opt/brain/deploy/.env`. Most values are
generated at install time. The knobs you might set yourself:

| Variable | Meaning |
| --- | --- |
| `BRAIN_DOMAIN` | the box's public DNS name |
| `BRAIN_PUBLIC_URL` | canonical origin, e.g. `https://brain.example.com`; enables the box's own OAuth server so MCP clients can connect with a sign-in flow |
| `BRAIN_RELEASES_REPO` | GitHub repo the updater follows (default `maslow-tech/maslow`) |
| `BRAIN_RELEASE_CHANNEL` | `stable` (default) or `canary` |
| `BRAIN_UPDATER_POLL_MS` | release-feed poll interval (default 15 min standalone) |
| `BRAIN_FS_QUOTA_BYTES` | brain filesystem quota (default 2 GiB) |
| `BRAIN_WRITE_SHED_PCT` | disk-usage percent at which writes shed and backups refuse |
| `BRAIN_BOOTH_URL` | optional fleet control plane; leave unset to run standalone |

After editing `.env`, recreate the affected service:
`docker compose --project-directory /opt/brain/deploy up -d <service>`.
Do not append to `.env` with `echo >>`. If the last line lacks a trailing
newline, the appended text glues onto the previous value. Use an editor.

## Updates

A standalone box follows GitHub Releases. The updater polls the feed, picks
the newest release on its channel, verifies the image digest's cosign
signature against this repository's CI identity, snapshots the deploy state,
migrates, swaps, probes the write path, and rolls back if the probe fails. It
applies one release per tick and never moves below the version floor.

- Check what is running: `curl -s https://<your-box>/boxinfo`
- Watch the updater: `docker logs -f brain-updater-1`
- A release that fails verification three times is latched and never retried.
  Transient failures (registry outage, DNS) defer instead of latching.
- Postgres major-version upgrades are refused by the updater; see
  [runbooks/pg-major-upgrade.md](runbooks/pg-major-upgrade.md).

## Backups

See [runbooks/restore-drill.md](runbooks/restore-drill.md),
[runbooks/pitr.md](runbooks/pitr.md), and
[runbooks/disaster-recovery.md](runbooks/disaster-recovery.md). In summary:

- pgBackRest takes a full backup every 12 hours and archives WAL
  continuously. Point-in-time recovery covers roughly a 48-hour window with
  an RPO of about a minute.
- The backup repository lives on the same volume, budgeted at 20% of it. This
  protects against logical mistakes (a bad migration, operator error), not
  against losing the volume. Take volume-level snapshots too if your platform
  offers them.
- A weekly drill restores the newest backup into a scratch directory and
  counts every row of every table. A passing `pgbackrest verify` alone does
  not prove a backup restores.

## Connecting MCP clients

Members sign in on the dashboard and add `https://<your-box>/mcp` in Claude
or any MCP client. With `BRAIN_PUBLIC_URL` set, the box runs its own OAuth
authorization server: paste the URL, sign in, done. Google and Microsoft
connectors are set up per [runbooks/google-oauth.md](runbooks/google-oauth.md)
and [runbooks/microsoft-entra.md](runbooks/microsoft-entra.md).

## Getting data out

[runbooks/export-import.md](runbooks/export-import.md) covers full export and
import between boxes.
