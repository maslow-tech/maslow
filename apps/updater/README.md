# @brain/updater

A separate, independently-versioned component that keeps a box on the right
release. Each tick drives one release step:

```
verify signature → pull-by-digest → migrate → restart →
write-canary → (schema-floor rollback on a broken write path) → report
```

## Release feeds

The updater reads releases from one of two feeds:

- Standalone (the default): GitHub Releases of `BRAIN_RELEASES_REPO`. The
  desired version is computed locally as the newest release on the box's
  channel that carries a `release.json` asset.
- Fleet mode: a control plane ("booth") set via `BRAIN_BOOTH_URL`, which
  answers heartbeats with a desired version and can carry signed operator
  ops. When both are set, the booth wins.

With neither configured the updater idles (local dev).

## Why the logic is pure

`src/decisions.ts` is side-effect-free so every rule is unit-tested without
Docker, a registry, or a database:

- one-release stepping: never a multi-version jump;
- anti-rollback floor: refuse `desired < current` without a signed operator
  downgrade, and never below the box's monotonic version floor;
- poisoned-version latch: after K definitive failures on a version, hold, with
  per-version exponential backoff. Verify failures are classified first:
  transient causes (registry outage, auth, DNS) defer and never count toward
  the latch;
- write-canary verdict: a multi-sample quiet-window vote that separates
  "write path broken" (roll back) from "box busy" (retry), so a false-RED
  canary never restart-storms;
- schema-floor rollback: roll the app back to the newest kept image the
  migrated schema still supports (`min_compatible_app_version`), not blindly
  the previous tag.

`src/updater.ts` is the orchestration loop; all effects (heartbeat, verify,
pull, migrate, restart, canary, rollback, report) are injected adapters.

## Releases

`.github/workflows/release.yml` builds, signs keyless (cosign + GitHub OIDC,
no signing secret in CI), publishes to GHCR, and publishes the GitHub Release
with its `release.json` feed entry. Boxes pull by digest and verify the
signature's identity (this repository's release workflow) before applying.
Verification is signature-only on purpose: buildkit's provenance attestation
is not the cosign-attest format, so `verify-attestation` would reject every
release.

## The runtime

`src/{versions,booth-client,github-releases-client,host,runtime,main}.ts`
wire the pure loop to the real world; `deploy/Dockerfile.updater` packages it
(docker CLI + compose + cosign + node) and `deploy/docker-compose.yml` runs
it with the host docker socket and the deploy dir mounted at its host path.

- `versions.ts`: the string↔ordinal bridge. The decision library reasons over
  monotonic integers; feeds speak version strings. Ordinals come from the
  tags' own semver order, never from feed list position, so a compromised or
  reordered feed cannot make an old release look like a forward step. State
  persists as strings (`/var/lib/brain-updater/state.json`).
- `host.ts`: the box-host side effects: `cosign verify`, `docker pull` by
  digest, an atomic `BRAIN_IMAGE` pin into `deploy/.env`,
  `compose run --rm migrate`, `compose up -d --no-deps app`, and the
  post-swap canary. All process calls are `execFile` (argv, no shell).
- `runtime.ts`: one tick: releases + heartbeat → ordinals → `Updater.tick` →
  persist. A yanked release never verifies; an unknown desired version holds
  at current; an unknown current refuses to act (never update from a guessed
  baseline).
- `main.ts`: env-configured poll loop (3 min in booth mode, 15 min on the
  GitHub feed) with exponential per-version backoff after failures. First
  boot bootstraps `current` from `BRAIN_CURRENT_VERSION` (written by
  install.sh).

## Whole-box bundle updates

A release converges every component, not just the app image. The updater
pulls `ghcr.io/…/bundle:<version>` (cosign-verified; version and app digest
cross-checked against the feed record), then applies: snapshot → deploy
configs (compose/Caddyfile/postgres/pgbackrest) → image pins
(app/postgres/caddy) → postgres first (`--wait`) → migrations →
whole-topology up (never the updater service itself) → write-canary. A failed
canary or mid-swap death restores the whole previous shape from the
version-stamped snapshot. The updater's own pin converges last via a detached
helper container, because an in-process recreate would SIGTERM the process
driving it. Cross-major postgres bundles are refused; see
docs/runbooks/pg-major-upgrade.md. A release with no bundle artifact updates
app-only (legacy path).
