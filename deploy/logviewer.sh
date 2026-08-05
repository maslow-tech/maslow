#!/usr/bin/env bash
# Forced-command SSH wrapper for the `logviewer` user (observability Stage 3):
# read-only `docker logs` over an allowlisted container set — no shell, no
# other docker verbs, no filesystem. authorized_keys pins this script with
# command="…",no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding
# (written by install.sh), and sudoers scopes the user to `docker logs` ONLY —
# NEVER the docker group, which is root-equivalent.
#
#   ssh logviewer@<box> <container> [--tail N] [--since T] [--until T]
#                                   [--timestamps|-t] [--follow|-f]
set -euo pipefail
set -f # no glob expansion — SSH_ORIGINAL_COMMAND is attacker-typed text

usage() {
  echo "usage: <container> [--tail N] [--since T] [--until T] [--timestamps] [--follow]" >&2
  echo "containers: brain-caddy-1 brain-app-1 brain-postgres-1 brain-updater-1" >&2
  exit 2
}

CMD="${SSH_ORIGINAL_COMMAND:-}"
[[ -n "${CMD}" ]] || usage
# shellcheck disable=SC2206 # word-splitting is the parse; values are validated below
ARGS=(${CMD})

CONTAINER="${ARGS[0]}"
case "${CONTAINER}" in
  brain-caddy-1 | brain-app-1 | brain-postgres-1 | brain-updater-1) ;;
  *) usage ;;
esac

FLAGS=()
i=1
while [[ ${i} -lt ${#ARGS[@]} ]]; do
  a="${ARGS[${i}]}"
  case "${a}" in
    --timestamps | -t | --follow | -f)
      FLAGS+=("${a}")
      ;;
    --tail | --since | --until)
      v="${ARGS[$((i + 1))]:-}"
      # docker duration/RFC3339/line-count values only — nothing shell-ish.
      [[ "${v}" =~ ^[A-Za-z0-9:.TZ+-]+$ ]] || usage
      FLAGS+=("${a}" "${v}")
      i=$((i + 1))
      ;;
    *) usage ;;
  esac
  i=$((i + 1))
done

exec sudo /usr/bin/docker logs "${FLAGS[@]+"${FLAGS[@]}"}" "${CONTAINER}"
