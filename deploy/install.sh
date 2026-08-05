#!/usr/bin/env bash
# The Brain — box installer.
#
# IDEMPOTENT: a re-run must never brick a live box. It splits install-vs-repair,
# generates secrets ONCE, makes NTP/chrony a HARD step, does DNS/SG/ACME
# preflight, runs the initial migration, and does a one-time first-owner
# bootstrap guarded on zero-owner (with a reissue-owner-token path). The install
# bundle (brain token) is single-use and self-destructs.
#
# Functions are sourceable for testing: `BRAIN_INSTALL_LIB=1 source install.sh`
# runs nothing; the CLI entrypoint is only reached when executed directly.
set -Eeuo pipefail

: "${BRAIN_HOME:=/opt/brain}"
: "${BRAIN_SECRETS_DIR:=${BRAIN_HOME}/secrets}"
: "${BRAIN_PGDATA:=${BRAIN_HOME}/pgdata}"
: "${BRAIN_BUNDLE:=${BRAIN_HOME}/install-bundle.env}"
# Where the compose stack + rendered .env live on the box. The updater mounts
# this dir at the SAME host path, so keep it absolute.
: "${BRAIN_DEPLOY_DIR:=${BRAIN_HOME}/deploy}"
# Docker config dir the GHCR login writes to. MUST be /root/.docker in prod —
# the updater bind-mounts /root/.docker/config.json:ro for in-container cosign.
# Overridable only so tests can run login without root.
: "${BRAIN_DOCKER_CONFIG_DIR:=/root/.docker}"
: "${BRAIN_ENV_FILE:=${BRAIN_DEPLOY_DIR}/.env}"
# Release-bundle source. Distribution model (operator-delegated decision): each
# release publishes deploy/ as a versioned tarball `brain-deploy-<v>.tar.gz`.
: "${BRAIN_BUNDLE_BASE_URL:=https://github.com/maslow-tech/maslow/releases/download}"
# Optional fleet control plane ("booth"). Empty = standalone: the box serves
# ungated and the updater follows GitHub Releases.
: "${BRAIN_BOOTH_URL:=}"
# Compose-plugin heal: AL2023's `docker` dnf
# package omits the Compose v2 plugin, so `docker compose` dies. When it's
# missing we download the pinned binary from docker's PUBLIC GitHub releases and
# verify it against these per-arch sha256 pins (from that release's
# checksums.txt). Bump the version + BOTH shas together; a stale sha fails loud.
: "${BRAIN_COMPOSE_VERSION:=v2.32.4}"
: "${BRAIN_COMPOSE_SHA256_X86_64:=ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b}"
: "${BRAIN_COMPOSE_SHA256_AARCH64:=0c4591cf3b1ed039adcd803dbbeddf757375fc08c11245b0154135f838495a2f}"

log() { printf '[install] %s\n' "$*" >&2; }
die() { printf '[install] FATAL: %s\n' "$*" >&2; exit 1; }

# Single-quote escaper for safe interpolation into shell/heredoc contexts:
# wraps in single quotes and turns each embedded ' into '\''.
shq() {
  local quoted=${1//\'/\'\\\'\'}
  printf "'%s'" "${quoted}"
}

# ---- generate-once secrets ------------------------------------------------
# Write a secret file only if it does not already exist (so a re-run keeps the
# existing value). Returns the value on stdout. Root-only perms.
generate_secret_once() {
  local name="$1" file="${BRAIN_SECRETS_DIR}/$1"
  mkdir -p "${BRAIN_SECRETS_DIR}"
  chmod 700 "${BRAIN_SECRETS_DIR}"
  if [[ ! -s "${file}" ]]; then
    # ALPHANUMERIC ONLY. These values become DB-role passwords, and the role
    # bootstrap (packages/schema buildRolesSql) rejects anything outside
    # ^[A-Za-z0-9_]{12,}$ — base64url's '-' would fail EVERY fresh install at
    # migrate ("unsafe owner password"). Also keeps them URL/shell-safe.
    local val
    val="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
    umask 077
    printf '%s' "${val}" > "${file}"
    chmod 600 "${file}"
  fi
  cat "${file}"
}

# ---- install vs repair ----------------------------------------------------
# A box is in 'repair' mode iff PGDATA already exists; otherwise 'install'.
detect_mode() {
  if [[ -d "${BRAIN_PGDATA}" && -n "$(ls -A "${BRAIN_PGDATA}" 2>/dev/null)" ]]; then
    printf 'repair'
  else
    printf 'install'
  fi
}

# ---- NTP is a hard step ---------------------------------------------------
require_time_sync() {
  # Accept chrony or systemd-timesyncd; fail the install if the clock is not
  # synchronized (a skewed clock breaks the dead-man + token expiry).
  if command -v timedatectl >/dev/null 2>&1; then
    if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qx yes; then
      return 0
    fi
    die "clock is not NTP-synchronized (timedatectl). Refusing to install."
  fi
  if command -v chronyc >/dev/null 2>&1; then
    chronyc tracking >/dev/null 2>&1 || die "chrony is not tracking a source. Refusing to install."
    return 0
  fi
  die "no NTP daemon (chrony/timesyncd) found. NTP is a hard requirement."
}

# ---- preflight ------------------------------------------------------------
preflight() {
  local domain="${1:-}"
  [[ -n "${domain}" ]] || die "usage: install.sh <domain>"
  # DNS: the domain should resolve to this host (best-effort; warn if not).
  if command -v getent >/dev/null 2>&1; then
    getent hosts "${domain}" >/dev/null 2>&1 || log "WARN: ${domain} does not resolve yet (ACME will retry)"
  fi
  # SG/ACME: 443 must be reachable for TLS-ALPN-01; 80 optional. We only warn —
  # caddy retries ACME with backoff.
  log "preflight: ensure the security group allows inbound 443 for ACME."
}

# ---- first-owner bootstrap (guarded on zero-owner) ------------------------
# Prints the one-time owner token; the caller ships it to the operator ONCE.
bootstrap_first_owner() {
  local psql_url="$1" name="${2:-owner}"
  # brain_bootstrap_owner self-guards on an existing owner (migration 0008).
  psql "${psql_url}" -tAc \
    "SELECT (regexp_matches(current_setting('x', true), '.*'))[1]" >/dev/null 2>&1 || true
  local token
  token="$(generate_secret_once owner_bootstrap_token)"
  # The DB call is idempotent: a second owner is refused, so re-run is safe.
  if psql "${psql_url}" -v ON_ERROR_STOP=1 -tAc \
      "SELECT brain_bootstrap_owner('${name//\'/}', encode(sha256('${token}'::bytea),'hex'))" >/dev/null 2>&1; then
    printf '%s' "${token}"
  else
    log "an owner already exists (bootstrap is one-time). Use reissue-owner-token to rotate."
    return 3
  fi
}

self_destruct_bundle() {
  if [[ -f "${BRAIN_BUNDLE}" ]]; then
    shred -u "${BRAIN_BUNDLE}" 2>/dev/null || rm -f "${BRAIN_BUNDLE}"
    log "install bundle self-destructed."
  fi
}

# ---- docker is a hard requirement -----------------------------------------
# Verify docker + the compose plugin are present and the daemon is up. On a
# fresh box we best-effort install docker via the platform package manager; if
# that isn't possible we fail with guidance rather than limp along.
ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log "docker not found — attempting install…"
    if command -v dnf >/dev/null 2>&1; then dnf install -y docker >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then yum install -y docker >/dev/null 2>&1 || true
    elif command -v apt-get >/dev/null 2>&1; then apt-get update -y >/dev/null 2>&1 && apt-get install -y docker.io >/dev/null 2>&1 || true
    fi
  fi
  command -v docker >/dev/null 2>&1 || die "docker is required and could not be installed automatically. Install Docker Engine + the compose plugin, then re-run."
  systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "the docker daemon is not running."
  # Heal the AL2023 missing-compose-plugin dead-end ONLY when it's actually
  # missing — a box that already has it (every box in the field) never enters this path.
  docker compose version >/dev/null 2>&1 || ensure_compose_plugin
}

# Install the pinned Compose v2 plugin binary from docker's PUBLIC GitHub
# releases, verified against the per-arch sha256 pin. Never installs an
# unverified binary onto a user's box.
ensure_compose_plugin() {
  log "docker compose plugin missing — installing pinned ${BRAIN_COMPOSE_VERSION}…"
  local arch asset sha
  case "$(uname -m)" in
    x86_64) arch="x86_64"; sha="${BRAIN_COMPOSE_SHA256_X86_64}" ;;
    aarch64 | arm64) arch="aarch64"; sha="${BRAIN_COMPOSE_SHA256_AARCH64}" ;;
    *) die "unsupported arch $(uname -m) for the compose-plugin auto-install; install docker-compose-plugin manually." ;;
  esac
  asset="docker-compose-linux-${arch}"
  local url="https://github.com/docker/compose/releases/download/${BRAIN_COMPOSE_VERSION}/${asset}"
  local tmp; tmp="$(mktemp)"
  curl -fsSL --retry 3 -o "${tmp}" "${url}" || { rm -f "${tmp}"; die "could not download the compose plugin from ${url}"; }
  printf '%s  %s\n' "${sha}" "${tmp}" | sha256sum -c - >/dev/null 2>&1 \
    || { rm -f "${tmp}"; die "compose plugin sha256 mismatch (expected ${sha}) — refusing to install an unverified binary."; }
  local dir="/usr/local/lib/docker/cli-plugins"
  mkdir -p "${dir}"
  install -m 0755 "${tmp}" "${dir}/docker-compose"
  rm -f "${tmp}"
  docker compose version >/dev/null 2>&1 \
    || die "installed the compose plugin but 'docker compose' still fails — install docker-compose-plugin manually and re-run."
  log "compose plugin installed + verified."
}

# ---- one-code enrollment ---------------------------------------------------
# BRAIN_ENROLL_CODE + BRAIN_BOOTH_URL → exchange the single-use code at
# /v1/enroll for the box's brain token, its release channel, the booth's
# public key, and GHCR pull credentials — no other secret handling by the
# person installing. Exports the values the rest of the install (ghcr_login,
# render_env) already consumes, so enrollment slots in transparently and the
# legacy bundle-delivered-token path keeps working when no code is set.
# Atomically persist ALL enrollment fields. The
# single-use code is consumed exactly once; if a crash after the exchange left
# only brain_token on disk, a re-run would skip the exchange and PERMANENTLY lose
# the GHCR creds (private-pull 401 → brick) + booth key (kill-switch ungated).
# Writing all six here, before anything downstream can fail, closes that.
write_enrollment_env() {
  local token="$1" box_id="$2" channel="$3" booth_key="$4" g_user="$5" g_token="$6"
  local dst="${BRAIN_SECRETS_DIR}/enrollment.env" tmp
  mkdir -p "${BRAIN_SECRETS_DIR}"; chmod 700 "${BRAIN_SECRETS_DIR}"
  tmp="$(umask 077; mktemp "${BRAIN_SECRETS_DIR}/enrollment.env.XXXXXX")"
  {
    printf 'export BRAIN_TOKEN=%s\n' "$(shq "${token}")"
    printf 'export BRAIN_BOX_ID=%s\n' "$(shq "${box_id}")"
    printf 'export BRAIN_CHANNEL=%s\n' "$(shq "${channel}")"
    printf 'export BRAIN_BOOTH_PUBLIC_KEY_B64=%s\n' "$(shq "${booth_key}")"
    printf 'export BRAIN_GHCR_USER=%s\n' "$(shq "${g_user}")"
    printf 'export BRAIN_GHCR_TOKEN=%s\n' "$(shq "${g_token}")"
  } > "${tmp}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${dst}"
}

# Rehydrate a prior run's enrollment (six fields), so the single-use code is
# never re-exchanged after a crash. Tolerant of absence (legacy boxes have none).
load_enrollment() {
  local src="${BRAIN_SECRETS_DIR}/enrollment.env"
  [[ -s "${src}" ]] || return 0
  set -a
  # shellcheck disable=SC1090  # sourcing our own 0600 file of `export VAR='...'`
  . "${src}"
  set +a
  BRAIN_ENROLL_CREDS_CACHED=1; export BRAIN_ENROLL_CREDS_CACHED
  log "rehydrated enrollment from disk (box_id=${BRAIN_BOX_ID:-?})"
}

# Fail EARLY (before enroll burns the code) on a fresh install missing what it
# needs: the first-owner name+email AND a resolvable bundle source. No-op in
# repair mode (an existing box already has both). Mirrors fetch_bundle's FULL
# source predicate — not bundle_url's subset.
validate_prereqs() {
  local mode="$1"
  [[ "${mode}" == "install" ]] || return 0
  [[ -n "${BRAIN_BOOTSTRAP_OWNER_NAME:-}" && -n "${BRAIN_BOOTSTRAP_OWNER_EMAIL:-}" ]] \
    || die "a fresh install needs BRAIN_BOOTSTRAP_OWNER_NAME and BRAIN_BOOTSTRAP_OWNER_EMAIL (the first owner)."
  if [[ "${BRAIN_SKIP_FETCH:-0}" == "1" ]] \
    || [[ -n "${BRAIN_BUNDLE_LOCAL:-}" && -f "${BRAIN_BUNDLE_LOCAL}" ]] \
    || [[ -f "${BRAIN_DEPLOY_DIR}/docker-compose.yml" ]] \
    || [[ -n "${BRAIN_BUNDLE_URL:-}" ]] \
    || [[ -n "${BRAIN_VERSION:-}" ]]; then
    return 0
  fi
  die "no deploy bundle source: set BRAIN_VERSION (or BRAIN_BUNDLE_URL / BRAIN_BUNDLE_LOCAL, or BRAIN_SKIP_FETCH=1)."
}

enroll_box() {
  local domain="$1" code="${BRAIN_ENROLL_CODE:-}"
  [[ -n "${code}" ]] || return 0
  [[ -n "${BRAIN_BOOTH_URL:-}" ]] || die "BRAIN_ENROLL_CODE set but BRAIN_BOOTH_URL is not"
  # Durability: once we hold a brain token (this run OR a prior run that got
  # past enrollment before dying), never re-exchange — the code is single-use.
  local token_file="${BRAIN_SECRETS_DIR}/brain_token"
  if [[ -n "${BRAIN_TOKEN:-}" ]]; then
    log "already enrolled (BRAIN_TOKEN present) — skipping code exchange."
    return 0
  fi
  if [[ -s "${token_file}" ]]; then
    BRAIN_TOKEN="$(cat "${token_file}")"; export BRAIN_TOKEN
    log "already enrolled (token on disk) — skipping code exchange."
    return 0
  fi
  # JSON body built by python (argv-fed, never shell-interpolated — a weird
  # domain cannot break out of the request body).
  local body
  body="$(BRAIN_CODE="${code}" BRAIN_HOST="${domain}" python3 -c 'import json,os; print(json.dumps({"code":os.environ["BRAIN_CODE"],"hostname":os.environ["BRAIN_HOST"]}))')" \
    || die "could not build enrollment request"
  log "enrolling with the booth…"
  local resp
  # NO --retry: /v1/enroll is a single-use, non-idempotent exchange — an
  # auto-replay after a 5xx (where the claim may have committed) would burn the
  # code and then fail. Capture the status so 409 (hostname taken) is distinct.
  local http_code
  resp="$(curl -sS -w '\n%{http_code}' -X POST "${BRAIN_BOOTH_URL}/v1/enroll" \
    -H 'content-type: application/json' --data "${body}")" \
    || die "enrollment request failed (booth unreachable)"
  http_code="$(printf '%s' "${resp}" | tail -n1)"
  resp="$(printf '%s' "${resp}" | sed '$d')"
  case "${http_code}" in
    200) : ;;
    409) die "enrollment refused: this hostname is already enrolled. Retire the stale box at ${BRAIN_BOOTH_URL}/admin, or install with a fresh hostname." ;;
    *) die "enrollment failed (HTTP ${http_code}): the code is invalid, used, or expired." ;;
  esac
  # mapfile parse — trailing empty optional fields never trip errexit the way
  # six sequential `read`s off a newline-stripped $() would.
  local fields=()
  mapfile -t fields < <(printf '%s' "${resp}" | python3 -c '
import json,sys
d = json.load(sys.stdin)
for k in ("brain_token","box_id","channel","booth_public_key_b64","ghcr_user","ghcr_token","version"):
    print(d.get(k, ""))
') || die "enrollment response was not valid JSON"
  local token="${fields[0]:-}" box_id="${fields[1]:-}" channel="${fields[2]:-}"
  local booth_key="${fields[3]:-}" g_user="${fields[4]:-}" g_token="${fields[5]:-}"
  local enroll_version="${fields[6]:-}"
  # Evergreen version: adopt the channel head the booth
  # returned as BRAIN_VERSION when the caller didn't pin one — so a Launch that
  # omits Version installs the channel's current release. An explicit
  # BRAIN_VERSION always wins.
  if [[ -z "${BRAIN_VERSION:-}" && -n "${enroll_version}" ]]; then
    export BRAIN_VERSION="${enroll_version}"
    log "enroll: adopting channel version ${enroll_version} (BRAIN_VERSION was unset)"
  fi
  [[ -n "${token}" ]] || die "enrollment response carried no brain_token"
  # Persist BEFORE anything downstream can fail — the code is now burned. Write
  # ALL six fields atomically FIRST (item 2), then the legacy brain_token file
  # (a pre-change box has no enrollment.env, so that path stays unchanged).
  write_enrollment_env "${token}" "${box_id}" "${channel}" "${booth_key}" "${g_user}" "${g_token}"
  mkdir -p "${BRAIN_SECRETS_DIR}"; chmod 700 "${BRAIN_SECRETS_DIR}"
  ( umask 077; printf '%s' "${token}" > "${token_file}" ); chmod 600 "${token_file}"
  export BRAIN_TOKEN="${token}"
  # `if` blocks, not `&& export`: a false [[ ]] as the left of && returns 1 and
  # can trip errexit depending on bash version — never risk it in the installer.
  if [[ -n "${booth_key}" ]]; then export BRAIN_BOOTH_PUBLIC_KEY_B64="${booth_key}"; fi
  if [[ -n "${g_user}" ]]; then export BRAIN_GHCR_USER="${g_user}"; fi
  if [[ -n "${g_token}" ]]; then export BRAIN_GHCR_TOKEN="${g_token}"; fi
  log "enrolled: box_id=${box_id:-?} channel=${channel:-stable}"
  return 0
}

# ---- GHCR auth (private image pull + in-updater cosign) -------------------
# The box + updater images live in a PRIVATE GHCR repo. Two consumers need auth:
#   1. the host docker daemon, to `pull` the images (migrate + compose up);
#   2. cosign, which runs as a process INSIDE the updater container and makes
#      its OWN registry calls — the updater bind-mounts /root/.docker/config.json
#      read-only for exactly this.
# CRITICAL: this must run BEFORE any `docker pull` / `compose up`. If the config
# file does not exist when compose starts, Docker creates the bind-mount source
# as a *directory*, and cosign then fails every verify (401) — the silent bug
# that blocked hands-off updates. `docker login` creates the file, fixing both.
# Idempotent: a re-login just refreshes the entry. Token from the install bundle
# (read:packages PAT); absent it, we skip with a warning (local/dev installs run
# public/local images and don't need GHCR).
ghcr_login() {
  local token="${BRAIN_GHCR_TOKEN:-}" user="${BRAIN_GHCR_USER:-}"
  # Allow the token to be delivered as a file path too (bundle convention).
  if [[ -z "${token}" && -n "${BRAIN_GHCR_TOKEN_FILE:-}" && -s "${BRAIN_GHCR_TOKEN_FILE}" ]]; then
    token="$(cat "${BRAIN_GHCR_TOKEN_FILE}")"
  fi
  if [[ -z "${token}" ]]; then
    log "no BRAIN_GHCR_TOKEN — images are public; skipping GHCR login."
    # The updater bind-mounts ${BRAIN_DOCKER_CONFIG_DIR}/config.json:ro for
    # in-container cosign. Ensure a REAL file exists even without a login, or
    # docker will auto-create a DIRECTORY at that path and break the mount.
    mkdir -p "${BRAIN_DOCKER_CONFIG_DIR}"
    [[ -f "${BRAIN_DOCKER_CONFIG_DIR}/config.json" ]] || printf '{}' > "${BRAIN_DOCKER_CONFIG_DIR}/config.json"
    return 0
  fi
  [[ -n "${user}" ]] || die "BRAIN_GHCR_TOKEN is set but BRAIN_GHCR_USER is empty (GHCR needs the PAT owner's username)."
  # Ensure the config dir exists so the bind mount targets a real file, not a
  # docker-created directory, even if login were to no-op.
  mkdir -p "${BRAIN_DOCKER_CONFIG_DIR}"
  # Does this box ALREADY hold a working ghcr.io auth entry? (item 2) If so, a
  # login failure on a repair re-run is a ROTATED shared PAT — WARN and KEEP the
  # existing creds rather than bricking a live box; only a FRESH box dies.
  local had_ghcr_auth=""
  if [[ -s "${BRAIN_DOCKER_CONFIG_DIR}/config.json" ]] \
    && grep -q 'ghcr\.io' "${BRAIN_DOCKER_CONFIG_DIR}/config.json" 2>/dev/null; then
    had_ghcr_auth=1
  fi
  log "ghcr: docker login ghcr.io as ${user}"
  if ! printf '%s' "${token}" | DOCKER_CONFIG="${BRAIN_DOCKER_CONFIG_DIR}" \
    docker login ghcr.io -u "${user}" --password-stdin >/dev/null 2>&1; then
    if [[ -n "${had_ghcr_auth}" ]]; then
      log "WARNING: cached GHCR token rejected — the shared org PAT may have rotated. Keeping the existing working creds; re-enroll to refresh."
      return 0
    fi
    die "docker login ghcr.io failed — check BRAIN_GHCR_USER / BRAIN_GHCR_TOKEN (needs read:packages)."
  fi
  [[ -s "${BRAIN_DOCKER_CONFIG_DIR}/config.json" ]] \
    || die "ghcr: login reported success but ${BRAIN_DOCKER_CONFIG_DIR}/config.json is missing — the updater mount would break."
  log "ghcr: login ok (${BRAIN_DOCKER_CONFIG_DIR}/config.json present for the updater mount)."
}

# ---- release bundle (versioned tarball) -----------------------------------
# Resolve the tarball URL: explicit BRAIN_BUNDLE_URL wins, else derive from the
# release tag BRAIN_VERSION against the base URL.
bundle_url() {
  if [[ -n "${BRAIN_BUNDLE_URL:-}" ]]; then printf '%s' "${BRAIN_BUNDLE_URL}"; return 0; fi
  [[ -n "${BRAIN_VERSION:-}" ]] || return 1
  printf '%s/%s/brain-deploy-%s.tar.gz' "${BRAIN_BUNDLE_BASE_URL}" "${BRAIN_VERSION}" "${BRAIN_VERSION}"
}

# Fetch + verify + extract the deploy bundle into ${BRAIN_DEPLOY_DIR}. Skipped
# when compose is already present (running from a checkout / re-run) unless
# BRAIN_FORCE_FETCH=1, or entirely via BRAIN_SKIP_FETCH=1.
fetch_bundle() {
  if [[ "${BRAIN_SKIP_FETCH:-0}" == "1" ]]; then log "fetch: skipped (BRAIN_SKIP_FETCH=1)"; return 0; fi
  if [[ -f "${BRAIN_DEPLOY_DIR}/docker-compose.yml" && "${BRAIN_FORCE_FETCH:-0}" != "1" ]]; then
    log "fetch: compose already present in ${BRAIN_DEPLOY_DIR} — skipping"; return 0
  fi
  mkdir -p "${BRAIN_DEPLOY_DIR}"
  local tgz
  if [[ -n "${BRAIN_BUNDLE_LOCAL:-}" && -f "${BRAIN_BUNDLE_LOCAL}" ]]; then
    # pre-fetched bundle (e.g. CloudFormation user-data pulled it via the
    # GitHub API — private-repo asset URLs need auth curl can't carry here)
    tgz="$(mktemp)"; cp "${BRAIN_BUNDLE_LOCAL}" "${tgz}"
    log "fetch: using local bundle ${BRAIN_BUNDLE_LOCAL}"
  else
    local url; url="$(bundle_url)" || die "no bundle source: set BRAIN_VERSION (or BRAIN_BUNDLE_URL, or BRAIN_SKIP_FETCH=1)"
    tgz="$(mktemp)"
    log "fetch: downloading ${url}"
    curl -fsSL --retry 3 --retry-delay 2 -o "${tgz}" "${url}" || die "bundle download failed: ${url}"
  fi
  # FAIL-CLOSED on integrity: a bundle reaches here only
  # after a remote fetch OR a BRAIN_BUNDLE_LOCAL copy — both are untrusted bytes.
  # Refuse to extract without a verified sha256, so a copy-paste that drops the
  # sha (or a public-origin/CFN install) can never silently install unverified
  # code. An explicit BRAIN_ALLOW_UNVERIFIED_BUNDLE=1 is the ONLY dev escape.
  if [[ -n "${BRAIN_BUNDLE_SHA256:-}" ]]; then
    printf '%s  %s\n' "${BRAIN_BUNDLE_SHA256}" "${tgz}" | sha256sum -c - >/dev/null 2>&1 \
      || { rm -f "${tgz}"; die "bundle checksum mismatch — refusing to install a tampered/incomplete bundle."; }
    log "fetch: sha256 verified"
  elif [[ "${BRAIN_ALLOW_UNVERIFIED_BUNDLE:-0}" == "1" ]]; then
    log "WARN: BRAIN_BUNDLE_SHA256 unset AND BRAIN_ALLOW_UNVERIFIED_BUNDLE=1 — installing an UNVERIFIED bundle (dev/local only)."
  else
    rm -f "${tgz}"
    die "refusing an unverified bundle: set BRAIN_BUNDLE_SHA256 (from the release notes / one-liner), or BRAIN_ALLOW_UNVERIFIED_BUNDLE=1 for local dev."
  fi
  # Convention: the tarball wraps the deploy/ dir → strip it into BRAIN_DEPLOY_DIR.
  tar -xzf "${tgz}" -C "${BRAIN_DEPLOY_DIR}" --strip-components=1 \
    || die "bundle extract failed"
  rm -f "${tgz}"
  log "fetch: extracted deploy bundle to ${BRAIN_DEPLOY_DIR}"
}

# ---- generate-once OAuth signing key --------------------------------------
# EC P-256 private key (base64 of the PEM) that signs OAuth access tokens. Kept
# on the box so issued tokens SURVIVE restarts (a per-process key would silently
# invalidate every connected claude.ai client on each recreate — the class of
# bug that broke connect before). Generated once; stable across re-runs.
generate_oauth_key_once() {
  local file="${BRAIN_SECRETS_DIR}/oauth_signing_key.pem"
  mkdir -p "${BRAIN_SECRETS_DIR}"; chmod 700 "${BRAIN_SECRETS_DIR}"
  if [[ ! -s "${file}" ]]; then
    umask 077
    openssl ecparam -name prime256v1 -genkey -noout -out "${file}" 2>/dev/null \
      || die "openssl EC P-256 keygen failed (is openssl installed?)"
    chmod 600 "${file}"
  fi
  base64 < "${file}" | tr -d '\n'
}

# The connector vault key: AES-256, so EXACTLY base64 of 32 raw bytes — the
# alphanumeric generate_secret_once format would be rejected at decrypt time.
generate_connector_key_once() {
  local file="${BRAIN_SECRETS_DIR}/connector_token_key"
  mkdir -p "${BRAIN_SECRETS_DIR}"; chmod 700 "${BRAIN_SECRETS_DIR}"
  if [[ ! -s "${file}" ]]; then
    umask 077
    head -c 32 /dev/urandom | base64 | tr -d '\n' > "${file}"
    chmod 600 "${file}"
  fi
  cat "${file}"
}

# ---- render deploy/.env ----------------------------------------------------
# Compose the full .env the stack needs from generate-once secrets + the
# provisioning inputs (domain, booth URL/key, brain token, image pins). Written
# atomically at 0600. Re-runs reproduce the SAME file (secrets are stable), so
# this is safe in repair mode.
render_env() {
  local domain="$1"
  mkdir -p "${BRAIN_DEPLOY_DIR}"
  local superpw apppw ownerpw extpw oauthkey brain_token public_url acme
  superpw="$(generate_secret_once db_password)"        # superuser pw (existing secret name)
  apppw="$(generate_secret_once app_password)"
  ownerpw="$(generate_secret_once owner_password)"
  extpw="$(generate_secret_once external_password)"
  oauthkey="$(generate_oauth_key_once)"
  # The brain token is ISSUED BY THE BOOTH and delivered in the install bundle;
  # fall back to a generated one only for booth-less dev installs.
  brain_token="${BRAIN_TOKEN:-$(generate_secret_once brain_token)}"
  public_url="${BRAIN_PUBLIC_URL:-https://${domain}}"
  acme="${ACME_EMAIL:-ops@${domain#*.}}"

  # Booth public key: the env var (from a fresh enroll) wins; otherwise PRESERVE
  # it from the existing .env. A repair-mode re-run has no enroll code to
  # re-fetch it — blanking it would ungate the kill-switch on the next recreate.
  local booth_key="${BRAIN_BOOTH_PUBLIC_KEY_B64:-}"
  if [[ -z "${booth_key}" && -f "${BRAIN_ENV_FILE}" ]]; then
    booth_key="$(grep -E '^BRAIN_BOOTH_PUBLIC_KEY_B64=' "${BRAIN_ENV_FILE}" | head -1 | cut -d= -f2- || true)"
  fi

  umask 077
  local tmp="${BRAIN_ENV_FILE}.tmp"
  {
    printf '# GENERATED by install.sh — do NOT edit by hand.\n'
    printf '# Secrets live (root-only, 0600) in %s\n' "${BRAIN_SECRETS_DIR}"
    printf 'BRAIN_DOMAIN=%s\n' "${domain}"
    printf 'ACME_EMAIL=%s\n' "${acme}"
    printf 'POSTGRES_SUPERUSER=postgres\n'
    printf 'POSTGRES_SUPERUSER_PASSWORD=%s\n' "${superpw}"
    printf 'BRAIN_DB=brain\n'
    printf 'BRAIN_APP_DATABASE_URL=postgres://brain_app:%s@postgres:5432/brain\n' "${apppw}"
    printf 'BRAIN_OWNER_DATABASE_URL=postgres://brain_owner:%s@postgres:5432/brain\n' "${ownerpw}"
    printf 'BRAIN_SUPERUSER_DATABASE_URL=postgres://postgres:%s@postgres:5432/brain\n' "${superpw}"
    printf 'BRAIN_OWNER_PASSWORD=%s\n' "${ownerpw}"
    printf 'BRAIN_APP_PASSWORD=%s\n' "${apppw}"
    printf 'BRAIN_EXTERNAL_PASSWORD=%s\n' "${extpw}"
    printf 'BRAIN_BOOTH_URL=%s\n' "${BRAIN_BOOTH_URL:-}"
    # Standalone (no booth): follow GitHub Releases for updates. A booth, when
    # configured, takes precedence inside the updater.
    printf 'BRAIN_RELEASES_REPO=%s\n' "${BRAIN_RELEASES_REPO:-maslow-tech/maslow}"
    printf 'BRAIN_TOKEN=%s\n' "${brain_token}"
    printf 'BRAIN_BOOTH_PUBLIC_KEY_B64=%s\n' "${booth_key}"
    printf 'BRAIN_PUBLIC_URL=%s\n' "${public_url}"
    printf 'BRAIN_OAUTH_SIGNING_KEY_B64=%s\n' "${oauthkey}"
    printf 'BRAIN_CONNECTOR_TOKEN_KEY=%s\n' "$(generate_connector_key_once)"
    printf 'BRAIN_CURRENT_VERSION=%s\n' "${BRAIN_VERSION:-}"
    printf 'BRAIN_IMAGE_REPO=%s\n' "${BRAIN_IMAGE_REPO:-ghcr.io/maslow-tech/maslow/box}"
    printf 'BRAIN_HOST_DEPLOY_DIR=%s\n' "${BRAIN_DEPLOY_DIR}"
    # Image pins: the env var wins; otherwise PRESERVE whatever pin the
    # updater last wrote into the existing .env — a repair-mode re-run must
    # never strip a bundle-converged box back to floating :local tags.
    local pin
    for pin in BRAIN_IMAGE BRAIN_UPDATER_IMAGE BRAIN_POSTGRES_IMAGE BRAIN_CADDY_IMAGE; do
      if [[ -n "${!pin:-}" ]]; then
        printf '%s=%s\n' "${pin}" "${!pin}"
      elif [[ -f "${BRAIN_ENV_FILE}" ]] && grep -qE "^${pin}=" "${BRAIN_ENV_FILE}"; then
        grep -E "^${pin}=" "${BRAIN_ENV_FILE}"
      elif [[ -n "${BRAIN_VERSION:-}" ]]; then
        # Fresh one-code install: no env pin, no prior .env. DERIVE from the
        # published (public) registry so compose never falls back to the
        # non-existent brain/*:local dev tags and the pull fails.
        case "${pin}" in
          BRAIN_IMAGE) printf 'BRAIN_IMAGE=ghcr.io/maslow-tech/maslow/box:%s\n' "${BRAIN_VERSION}" ;;
          BRAIN_UPDATER_IMAGE) printf 'BRAIN_UPDATER_IMAGE=ghcr.io/maslow-tech/maslow/updater:%s\n' "${BRAIN_VERSION}" ;;
          BRAIN_POSTGRES_IMAGE) printf 'BRAIN_POSTGRES_IMAGE=ghcr.io/maslow-tech/maslow/postgres:%s\n' "${BRAIN_VERSION}" ;;
          BRAIN_CADDY_IMAGE) : ;; # caddy uses a public upstream image (compose default)
        esac
      fi
    done
  } > "${tmp}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${BRAIN_ENV_FILE}"
  log "wrote ${BRAIN_ENV_FILE} (0600)"
}

# ---- compose helpers -------------------------------------------------------
# Always run compose from the deploy dir so its relative bind mounts + auto .env
# resolve correctly.
compose() { ( cd "${BRAIN_DEPLOY_DIR}" && docker compose "$@" ); }

# Run the one-off migrate service: creates roles, runs infra migrations, and —
# when owner_name is passed — does the one-time first-owner bootstrap (self-
# guarded on zero-owner), printing OWNER_TOKEN once. Surfaces that token loudly.
run_migrate() {
  local owner_name="${1:-}" owner_email="${2:-}"
  log "migrations: running the one-off migrate service…"
  local out rc=0
  out="$(cd "${BRAIN_DEPLOY_DIR}" \
        && BRAIN_BOOTSTRAP_OWNER_NAME="${owner_name}" \
           BRAIN_BOOTSTRAP_OWNER_EMAIL="${owner_email}" \
        docker compose --profile tools run --rm migrate 2>&1)" || rc=$?
  # Do NOT echo the raw migrate output — it contains OWNER_TOKEN=..., and the
  # CloudFormation user-data tees stdout/stderr to a log file on the box.
  printf '%s\n' "${out}" | grep -v 'OWNER_TOKEN=' || true
  [[ ${rc} -eq 0 ]] || die "migrate failed (rc=${rc})"
  local tok; tok="$(printf '%s\n' "${out}" | grep -oE 'OWNER_TOKEN=[A-Za-z0-9._-]+' | head -1 | cut -d= -f2-)"
  if [[ -n "${tok}" ]]; then
    # Write to a root-only file rather than any captured stream, so a one-click
    # (CFN) install never leaves the owner token in a readable log.
    local owner_file="${BRAIN_SECRETS_DIR}/owner_token"
    mkdir -p "${BRAIN_SECRETS_DIR}"; ( umask 077; printf '%s' "${tok}" > "${owner_file}" ); chmod 600 "${owner_file}"
    log "=================================================================="
    log "ONE-TIME OWNER TOKEN written to ${owner_file} (root-only, 0600)."
    log "Retrieve it over your own SSH (box access is SSH key-only — no SSM),"
    log "store it in your password manager, then shred the file. It is derived"
    log "once and never shown again. If lost before first login, mint a fresh"
    log "one with the reissue-owner-token tools service."
    log "=================================================================="
  fi
}

# Read-only fleet log access (observability Stage 3): a `logviewer` SSH user
# whose every connection is forced through deploy/logviewer.sh (docker logs
# over an allowlisted container set — no shell). Operator PUBLIC keys arrive
# via BRAIN_LOGVIEWER_PUBKEYS (newline-separated); unset = skip with a note,
# never a failure — migration doctrine: a box without keys keeps installing.
# Idempotent: reruns rewrite authorized_keys to exactly the provided set.
provision_logviewer() {
  if [[ -z "${BRAIN_LOGVIEWER_PUBKEYS:-}" ]]; then
    log "logviewer: BRAIN_LOGVIEWER_PUBKEYS unset — skipping log-access user"
    return 0
  fi
  id logviewer >/dev/null 2>&1 || useradd -m logviewer
  local ssh_dir=/home/logviewer/.ssh
  mkdir -p "${ssh_dir}"
  : >"${ssh_dir}/authorized_keys.tmp"
  local key
  while IFS= read -r key; do
    [[ -n "${key}" ]] || continue
    printf 'command="%s/logviewer.sh",no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding %s\n' \
      "${BRAIN_DEPLOY_DIR}" "${key}" >>"${ssh_dir}/authorized_keys.tmp"
  done <<<"${BRAIN_LOGVIEWER_PUBKEYS}"
  mv "${ssh_dir}/authorized_keys.tmp" "${ssh_dir}/authorized_keys"
  chown -R logviewer:logviewer "${ssh_dir}"
  chmod 700 "${ssh_dir}"
  chmod 600 "${ssh_dir}/authorized_keys"
  chmod 0755 "${BRAIN_DEPLOY_DIR}/logviewer.sh"
  # docker logs ONLY — the docker group would be root-equivalent.
  printf 'logviewer ALL=(root) NOPASSWD: /usr/bin/docker logs *\n' >/etc/sudoers.d/logviewer
  chmod 440 /etc/sudoers.d/logviewer
  log "logviewer: provisioned (forced-command docker-logs access)"
}

main() {
  local domain="${1:-}"
  local mode; mode="$(detect_mode)"
  log "mode: ${mode}"

  # Rehydrate a prior run's enrollment BEFORE enroll_box, so the existing
  # BRAIN_TOKEN-present guard skips a burned single-use code (item 2).
  load_enrollment

  require_time_sync
  preflight "${domain}"
  ensure_docker
  validate_prereqs "${mode}" # fail fast (before enroll burns the code) on a fresh box
  enroll_box "${domain}"     # one-code join (no-op when BRAIN_ENROLL_CODE unset)
  ghcr_login                 # MUST precede any private image pull / compose up
  fetch_bundle
  provision_logviewer        # after fetch: the wrapper script ships in the bundle
  render_env "${domain}"

  if [[ "${mode}" == "install" ]]; then
    log "fresh install: migrate + bootstrap owner, then bring up the stack."
    # The first owner needs a real name + email — there is NO nameless default.
    [[ -n "${BRAIN_BOOTSTRAP_OWNER_NAME:-}" && -n "${BRAIN_BOOTSTRAP_OWNER_EMAIL:-}" ]] \
      || die "fresh install needs BRAIN_BOOTSTRAP_OWNER_NAME and BRAIN_BOOTSTRAP_OWNER_EMAIL (the first owner's name + email)."
    # migrate starts postgres (compose dependency) and waits for health, creates
    # roles, runs migrations, and bootstraps the first owner (prints its token).
    run_migrate "${BRAIN_BOOTSTRAP_OWNER_NAME}" "${BRAIN_BOOTSTRAP_OWNER_EMAIL}"
    compose up -d
    log "stack up. verify: curl -fsS https://${domain}/healthz"
  else
    log "repair: reconcile config + apply pending migrations WITHOUT re-init."
    run_migrate ""                     # idempotent; no owner bootstrap on repair
    compose up -d --no-recreate
  fi

  self_destruct_bundle
  log "done. (${mode})"
}

# Only run the CLI when executed directly, not when sourced for tests.
if [[ "${BRAIN_INSTALL_LIB:-0}" != "1" ]]; then
  main "$@"
fi
