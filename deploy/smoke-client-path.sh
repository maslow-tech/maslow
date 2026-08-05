#!/usr/bin/env bash
#
# smoke-client-path.sh (Layer 2 of the client-path smoke) — stand up the freshly-built box
# image against a throwaway pgvector, then drive a REAL headless-Chromium login →
# save-branding → read-back against it (smoke-client-path.mjs). This catches the
# IMAGE-PACKAGING + production-cookie class the Layer-1 CSRF enumeration unit test
# cannot: SPA not copied into the image, wrong BRAIN_UI_DIR, CSP blocking the
# bundle, and Secure/SameSite cookie flags breaking the double-submit CSRF read
# (Chromium treats http://localhost as a secure context, so it stores + reads the
# Secure brain_csrf cookie without TLS — exercising prod flags verbatim).
#
# Runs PRE-SIGN in release.yml: a red result fails the job before `cosign sign`,
# so a packaging-broken image can never reach a user's box. Throwaway PG only,
# no user data. amd64 only (force --platform; evict the arm64 variant the
# retrieval smoke left under the digest).
#
# Env: IMAGE, DIGEST (the box image@digest to smoke). Requires docker + node +
# a chromium installed by `npx playwright install --with-deps chromium`.

set -euo pipefail

: "${IMAGE:?IMAGE required (ghcr.io/…/box)}"
: "${DIGEST:?DIGEST required (sha256:…)}"

NET="brain-smoke-$$"
PG="brain-smoke-pg-$$"
BOX="brain-smoke-box-$$"
HOST_PORT=18080

# Passwords/creds for the throwaway DB (never user data).
# MUST satisfy roles.ts SAFE_PASSWORD = /^[A-Za-z0-9_]{12,}$/ — buildRolesSql
# refuses anything else, so a hyphen here fails every release at migrate.
SUPERPW="smoke_super_pw_1"
OWNERPW="smoke_owner_pw_1"
APPPW="smoke_app_pw_1234"
EXTPW="smoke_ext_pw_1234"
DB="brain"

cleanup() {
  docker rm -f "$BOX" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "smoke: force amd64 — evict any arm64 variant the retrieval smoke left"
docker image rm -f "${IMAGE}@${DIGEST}" >/dev/null 2>&1 || true
docker pull --platform linux/amd64 "${IMAGE}@${DIGEST}"

docker network create "$NET" >/dev/null

echo "smoke: start throwaway pgvector"
docker run -d --name "$PG" --network "$NET" \
  -e "POSTGRES_PASSWORD=${SUPERPW}" -e "POSTGRES_DB=${DB}" \
  pgvector/pgvector:pg17 >/dev/null

# Wait for postgres to accept connections.
for _ in $(seq 1 30); do
  if docker exec "$PG" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then break; fi
  sleep 1
done

# DB URLs the way docker-compose.yml / install.sh construct them (host = the PG
# container name on the smoke network).
SUPER_URL="postgres://postgres:${SUPERPW}@${PG}:5432/${DB}"
OWNER_URL="postgres://brain_owner:${OWNERPW}@${PG}:5432/${DB}"
APP_URL="postgres://brain_app:${APPPW}@${PG}:5432/${DB}"

echo "smoke: migrate (creates roles + schema) and scrape OWNER_TOKEN"
# ALL SEVEN migrate env vars + the bootstrap owner. If a future workstream adds a
# required boot/migrate env (e.g. a private-vault key), it MUST be added here too
# — this is the ONE place the smoke's env list lives.
# NOTE: capture with `|| rc=$?` so a FAILING migrate still prints its output.
# Plain `MIGRATE_OUT=$(...)` under `set -e` aborts here and throws the diagnosis away.
migrate_rc=0
MIGRATE_OUT=$(docker run --rm --platform linux/amd64 --network "$NET" \
  -e "BRAIN_DB=${DB}" \
  -e "BRAIN_SUPERUSER_DATABASE_URL=${SUPER_URL}" \
  -e "BRAIN_OWNER_DATABASE_URL=${OWNER_URL}" \
  -e "BRAIN_APP_DATABASE_URL=${APP_URL}" \
  -e "BRAIN_OWNER_PASSWORD=${OWNERPW}" \
  -e "BRAIN_APP_PASSWORD=${APPPW}" \
  -e "BRAIN_EXTERNAL_PASSWORD=${EXTPW}" \
  -e "BRAIN_BOOTSTRAP_OWNER_NAME=Smoke Owner" \
  -e "BRAIN_BOOTSTRAP_OWNER_EMAIL=smoke@example.com" \
  "${IMAGE}@${DIGEST}" node dist/migrate.js 2>&1) || migrate_rc=$?
echo "$MIGRATE_OUT" | grep -v 'OWNER_TOKEN=' || true
if [ "$migrate_rc" -ne 0 ]; then
  echo "smoke: migrate FAILED (exit ${migrate_rc}) — output above" >&2
  exit 1
fi
TOKEN=$(printf '%s\n' "$MIGRATE_OUT" | grep -oE 'OWNER_TOKEN=[A-Za-z0-9._-]+' | head -1 | cut -d= -f2-)
[ -n "$TOKEN" ] || { echo "smoke: migrate did not print OWNER_TOKEN" >&2; exit 1; }

echo "smoke: start the box (default BRAIN_UI_DIR=./webui)"
docker run -d --name "$BOX" --platform linux/amd64 --network "$NET" \
  -p "${HOST_PORT}:8080" \
  -e PORT=8080 \
  -e "BRAIN_APP_DATABASE_URL=${APP_URL}" \
  -e "BRAIN_OWNER_DATABASE_URL=${OWNER_URL}" \
  "${IMAGE}@${DIGEST}" node dist/index.js >/dev/null

BASE="http://localhost:${HOST_PORT}"
echo "smoke: wait for /healthz (covers cold model preload, ~120s budget)"
ok=0
for _ in $(seq 1 120); do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || { echo "smoke: box /healthz never came up" >&2; docker logs "$BOX" | tail -40 >&2; exit 1; }

echo "smoke: drive the browser login → save branding → read-back"
node deploy/smoke-client-path.mjs "$BASE" "$TOKEN"
echo "smoke: PASS — real-image login + CSRF-guarded write + read-back all green"
