#!/bin/sh
# Wires this repo's git hooks by pointing core.hooksPath at .githooks (see
# .githooks/pre-commit). Runs as the root package.json `prepare` script on every
# `pnpm install`.
#
# HARD RULE: this script MUST NEVER exit non-zero. It runs inside `prepare`,
# which runs during `pnpm install` — including the Docker image builds. There is
# NO .git directory in a Docker build context (.dockerignore excludes it), so the
# git config would fail; an unguarded failure here exits 128, no signed bundle is
# produced, and the whole fleet stops self-updating (a production latch failure
# mode). Hence: guard the git call behind a git-dir check, tolerate its failure,
# and end unconditionally with `exit 0`. Keep BOTH guards.
if git rev-parse --git-dir >/dev/null 2>&1; then
  git config core.hooksPath .githooks || true
fi
exit 0
