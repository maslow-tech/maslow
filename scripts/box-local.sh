#!/usr/bin/env bash
# Run the REAL box stack (Caddy + box + postgres) on your laptop with
# locally-built images — no merge, no release, no fleet converge. The last-mile
# staging environment before anything ships to a real box.
#
#   ./scripts/box-local.sh            # build images + up
#   ./scripts/box-local.sh down       # tear down (keeps volumes)
#   ./scripts/box-local.sh nuke       # tear down + delete volumes
#
# Caddy binds 80/443 (compose is the real box stack); the console answers on
# https://localhost (self-signed local TLS — accept the warning).
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=deploy/.env.local
COMPOSE=(docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.yml -p brain-local)

if [[ "${1:-}" == "down" ]]; then "${COMPOSE[@]}" down; exit 0; fi
if [[ "${1:-}" == "nuke" ]]; then "${COMPOSE[@]}" down -v; rm -f "$ENV_FILE"; exit 0; fi

# ---- one-time env: the canonical template with local values -----------------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "generating $ENV_FILE from deploy/.env.example (first run)"
  APP_PW=$(openssl rand -hex 24); OWNER_PW=$(openssl rand -hex 24)
  EXT_PW=$(openssl rand -hex 24); SUPER_PW=$(openssl rand -hex 24)
  sed -e "s/change_me_app_pw/$APP_PW/g" \
      -e "s/change_me_owner_pw/$OWNER_PW/g" \
      -e "s/change_me_external_pw/$EXT_PW/g" \
      -e "s/change_me_generated_secret/$SUPER_PW/g" \
      -e "s/^BRAIN_DOMAIN=.*/BRAIN_DOMAIN=localhost/" \
      -e "s/^ACME_EMAIL=.*/ACME_EMAIL=/" \
      deploy/.env.example > "$ENV_FILE"
  {
    echo "BRAIN_BOOTSTRAP_OWNER_NAME=Local Owner"
    echo "BRAIN_BOOTSTRAP_OWNER_EMAIL=owner@localhost"
    echo "BRAIN_CONNECTOR_TOKEN_KEY=$(openssl rand -hex 24)"
  } >> "$ENV_FILE"
fi

# ---- build the branch's images ----------------------------------------------
docker build -t brain/box:local -f deploy/Dockerfile .
docker build -t brain/postgres:local deploy/postgres
# the updater is deliberately NOT run locally (it would try to converge you
# onto a signed release — the opposite of testing local images).

"${COMPOSE[@]}" config -q
"${COMPOSE[@]}" up -d caddy box postgres
echo
echo "box up: http://localhost:8080  (owner token: check 'docker compose -p brain-local logs box' for bootstrap output)"
