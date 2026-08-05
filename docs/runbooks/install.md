# Provisioning and install

Install maslow on a fresh Linux host (amd64 or arm64) with Docker, a DNS name
pointed at it, and ports 80/443 open. Everything below runs as root on the
box itself.

## One-line install (fresh box)

The installer fetches a pinned, sha256-verified deploy bundle, renders a
root-only `.env`, migrates the database, bootstraps the first owner, and
brings the stack up:

```bash
export BRAIN_VERSION=<release-tag>           # the release tag to install
export BRAIN_BUNDLE_SHA256=<sha256>          # integrity of brain-deploy-<v>.tar.gz — set it in prod
export BRAIN_BOOTSTRAP_OWNER_NAME="Jane Owner"
export BRAIN_BOOTSTRAP_OWNER_EMAIL="jane@example.com"
curl -fsSL "https://github.com/maslow-tech/maslow/releases/download/$BRAIN_VERSION/install.sh" \
  | bash -s -- brain.example.com
```

Both the owner name and email are required: the first owner account is
created at migrate time, and `validate_prereqs` fails fast if either is
missing.

What runs, in order (`main`): `require_time_sync` → `preflight` →
`ensure_docker` → `fetch_bundle` (download + sha256-verify + extract to
`/opt/brain/deploy`) → `render_env` (generate-once secrets + a
self-generated EC P-256 OAuth signing key → a 0600 `.env`) → `run_migrate`
(create roles, migrate, bootstrap the first owner, print `OWNER_TOKEN` once)
→ `docker compose up -d`. Re-running is safe (see "Repair" below).

Env knobs:

| Env | Meaning |
| --- | --- |
| `BRAIN_VERSION` / `BRAIN_BUNDLE_URL` | bundle source (release tag, or an explicit tarball URL) |
| `BRAIN_BUNDLE_SHA256` | bundle integrity — **required in production**; `BRAIN_ALLOW_UNVERIFIED_BUNDLE=1` is for local dev only |
| `BRAIN_SKIP_FETCH=1` | run from a local checkout instead of fetching |
| `BRAIN_FORCE_FETCH=1` | re-extract over an existing deploy dir |
| `BRAIN_IMAGE` / `BRAIN_UPDATER_IMAGE` | digest pins for the app / updater images |

## `install.sh` guarantees

- Idempotent, with an install-vs-repair split. `detect_mode` returns
  `repair` iff PGDATA already exists, so a re-run reconciles the stack
  without re-initializing the database or secrets. `install` mode is only
  for a truly fresh box.
- Generate-once secrets. `generate_secret_once` writes the superuser / app /
  owner / external DB passwords plus the box token to `${BRAIN_SECRETS_DIR}`
  (root-only, 0600) only if absent, and `generate_oauth_key_once` writes an
  EC P-256 OAuth signing key (so issued MCP client tokens survive restarts).
  `render_env` composes these into a 0600 `deploy/.env`; re-runs reproduce
  the same file.
- NTP is a hard step. `require_time_sync` fails the install if the clock is
  not synchronized (chrony or systemd-timesyncd); a skewed clock breaks
  token expiry.
- Preflight: DNS resolution (best-effort) plus a reminder that the firewall
  must allow inbound 443 for TLS-ALPN-01 (Caddy retries ACME with backoff).
- First-owner bootstrap. Calls `brain_bootstrap_owner`, which guards itself
  on zero-owner, so a second run is refused. The one-time owner token is
  printed once.

## Reissue owner token (break-glass, before first login)

If the first-owner token is lost before an owner logs in, mint a fresh one
over SSH on the box:

```bash
cd /opt/brain/deploy
docker compose --profile tools run --rm \
  -e BRAIN_REISSUE_OWNER_EMAIL=owner@example.com \
  reissue-owner-token
```

It prints a fresh `OWNER_TOKEN` once; capture it to a 0600 file, sign in,
then `shred` the file. It connects as `brain_owner` (host/compose access
only), never the app pool. Once an owner has logged in, prefer in-app token
rotation; further owner changes go through the normal admin path.

## Repair a running box

Re-run `install.sh <domain>`. It detects `repair`, keeps PGDATA + secrets,
runs `docker compose up -d --no-recreate`, and the drift reconciler runs
post-boot in report mode.

## Auto-update (the updater)

After install, a box keeps itself on the right release; no operator SSH is
part of the update path. The `updater` container
(`deploy/Dockerfile.updater`):

1. polls the release feed for the desired version (GitHub Releases for a
   standalone box: `BRAIN_RELEASES_REPO` / `BRAIN_RELEASE_CHANNEL`; or your
   own endpoint if you run the optional fleet control plane),
2. resolves version → digest (publish-ordered),
3. cosign-verifies the digest (keyless: the repo's CI workflow identity +
   OIDC issuer),
4. pulls by digest, pins `BRAIN_IMAGE` in `deploy/.env`,
5. runs migrations (`docker compose --profile tools run --rm migrate`),
6. recreates `app`, runs a post-swap canary, and rolls back to the newest
   schema-compatible kept image if the box comes up broken.

The updater applies one release step at a time, enforces an anti-rollback
floor, and latches poisoned versions; all of it lives in `apps/updater`
(unit-tested pure decisions plus a thin runtime).

Env it needs in `deploy/.env` (see `.env.example`): `BRAIN_CURRENT_VERSION`
(first-boot baseline; install.sh writes the installed release tag),
`BRAIN_IMAGE_REPO`, `BRAIN_HOST_DEPLOY_DIR` (the deploy dir's host path; the
updater mounts it at the same path so compose-resolved bind mounts stay
valid on the host daemon).

If the images are pulled from a private registry, the updater also needs
registry credentials: cosign runs inside the updater container and mounts
`/root/.docker/config.json:ro`, so the host must have run
`docker login ghcr.io` (a read-only token) before `compose up`. A public
registry needs no login.

## Failure modes

- Clock not synced: the install refuses at `require_time_sync`. Fix NTP
  (chrony/timesyncd) and re-run; do not bypass it.
- Port 443 blocked: Caddy cannot complete ACME; the site stays on a
  self-signed cert while it retries. Open 443 inbound and wait.
- Re-running install on a live box is safe by design; it enters repair mode.
  If it does not detect repair (PGDATA missing), stop: you are about to
  initialize a fresh database.
