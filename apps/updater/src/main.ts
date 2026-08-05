import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { BoothClient, type ReleaseFeed } from "./booth-client.js";
import { GithubReleasesClient } from "./github-releases-client.js";
import { decodeBoothPublicKey } from "./verify.js";
import { backoffMs } from "./decisions.js";
import { BoxHost, sleep } from "./host.js";
import { runTick } from "./runtime.js";
import type { PersistedState } from "./versions.js";

/**
 * The updater entrypoint: poll the booth every ~10 minutes, one release
 * step per tick. Configuration is env-only (set by docker-compose.yml); the
 * brain token comes from a mounted secret FILE by preference, never a build
 * arg. First boot (no state file) bootstraps `current` from
 * BRAIN_CURRENT_VERSION, written by install.sh — the updater refuses to guess
 * what a box is running.
 */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

function brainToken(): string {
  const file = env("BRAIN_TOKEN_FILE");
  if (file !== undefined) return readFileSync(file, "utf8").trim();
  return requireEnv("BRAIN_TOKEN");
}

function log(line: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
}

async function main(): Promise<void> {
  const boothUrl = env("BRAIN_BOOTH_URL");
  const releasesRepo = env("BRAIN_RELEASES_REPO");
  if (boothUrl === undefined && releasesRepo === undefined) {
    // Local/dev without any release feed: keep the compose topology real but
    // inert (mirrors the box, which "runs ungated" absent booth config).
    log({ msg: "no BRAIN_BOOTH_URL or BRAIN_RELEASES_REPO configured — updater idle" });
    for (;;) await sleep(3_600_000);
  }
  // Booth mode polls every 3 min: one HTTPS GET to a server we run, so a tight
  // loop is effectively free and rollouts land fleet-wide in minutes. GitHub
  // mode polls every 15 min: the unauthenticated API allows 60 req/h/IP and a
  // tick can spend several of them on release.json assets.
  const defaultPollMs = boothUrl !== undefined ? 180_000 : 900_000;
  const pollRaw = Number(env("BRAIN_UPDATER_POLL_MS") ?? defaultPollMs);
  const pollMs = Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : defaultPollMs;

  const host = new BoxHost({
    deployDir: env("BRAIN_DEPLOY_DIR") ?? "/opt/brain/deploy",
    imageRepo: env("BRAIN_IMAGE_REPO") ?? "ghcr.io/maslow-tech/maslow/box",
    // Bundle updates: defaulted HERE like imageRepo, not only in compose — a
    // transition-era box runs the new updater under the OLD compose stanza
    // (configs ship via bundles), so a compose-only default never reaches it
    // and every release silently degrades to app-only. Live-drill finding.
    bundleRepo: env("BRAIN_BUNDLE_REPO") ?? "ghcr.io/maslow-tech/maslow/bundle",
    cosignIdentityRegexp:
      env("BRAIN_COSIGN_IDENTITY_REGEXP") ??
      "^https://github\\.com/maslow-tech/maslow/\\.github/workflows/release\\.yml@refs/tags/v",
    cosignIssuer: env("BRAIN_COSIGN_ISSUER") ?? "https://token.actions.githubusercontent.com",
    stateFile: env("BRAIN_UPDATER_STATE") ?? "/var/lib/brain-updater/state.json",
    // Post-swap canary hits the box's write-path probe (real DB round-trip),
    // not mere liveness — a broken write path is what a bad release looks like.
    canaryUrl: env("BRAIN_CANARY_URL") ?? "http://app:8080/canary",
  });
  // Booth public key (same env the box's kill-switch client uses): needed to
  // verify the signed control that carries the operator restart op. Absent → the
  // updater still updates, but ignores restart ops (fail closed). A key that
  // is SET but malformed is called out separately: fail-closed verification
  // produces no errors, so without this log a bad key is indistinguishable
  // from "no restart ops pending", forever.
  let booth: ReleaseFeed;
  if (boothUrl !== undefined) {
    const boothPubB64 = env("BRAIN_BOOTH_PUBLIC_KEY_B64");
    const boothPublicKeyPem = decodeBoothPublicKey(boothPubB64);
    if (boothPubB64 === undefined) {
      log({ warn: "BRAIN_BOOTH_PUBLIC_KEY_B64 unset — operator restart ops will be ignored" });
    } else if (boothPublicKeyPem === null) {
      log({
        error:
          "BRAIN_BOOTH_PUBLIC_KEY_B64 is set but not a valid base64-encoded public key — operator restart ops will be ignored",
      });
    }
    booth = new BoothClient(boothUrl, brainToken(), boothPublicKeyPem ?? undefined);
  } else {
    // Standalone: follow GitHub Releases. No fleet token, no operator ops —
    // desired version is computed locally as the channel head.
    const channel = env("BRAIN_RELEASE_CHANNEL") ?? "stable";
    booth = new GithubReleasesClient(releasesRepo as string, channel);
    log({ msg: "release feed: GitHub Releases", repo: releasesRepo, channel });
  }

  let state: PersistedState | null;
  try {
    state = host.loadState();
  } catch (err) {
    // A corrupt (as opposed to missing) state file must NOT crash-loop under
    // `restart: unless-stopped` — that buries the cause in restart spam and
    // silently drops the box off the channel. Idle loudly for an operator.
    log({ error: `unreadable updater state — idle; inspect the state file: ${String(err)}` });
    for (;;) await sleep(3_600_000);
  }
  if (state === null) {
    const current = env("BRAIN_CURRENT_VERSION");
    if (current === undefined) {
      // Misconfigured fresh box (no state, no baseline). Idle with a loud log
      // rather than crash-loop under `restart: unless-stopped` — a restart
      // storm would bury the actual cause.
      log({
        error: "no updater state and BRAIN_CURRENT_VERSION unset — idle; fix config and restart",
      });
      for (;;) await sleep(3_600_000);
    }
    state = {
      currentVersion: current,
      floorVersion: current,
      attempts: {},
      keptVersions: [current],
    };
    host.saveState(state);
    log({ msg: "bootstrapped state", current });
  }

  // Heal a pre-connector-era .env: boxes installed before the vault existed
  // have no BRAIN_CONNECTOR_TOKEN_KEY, which bricks the Connectors surface
  // ("not configured on this box"). Generate-once here, exactly like a fresh
  // install.sh would; NEVER touch an existing non-empty value — the key is
  // escrowed + non-rotatable, overwriting it orphans every stored token.
  try {
    const existing = host.readEnvVar("BRAIN_CONNECTOR_TOKEN_KEY");
    if (existing === undefined || existing.trim() === "") {
      host.pinEnv("BRAIN_CONNECTOR_TOKEN_KEY", randomBytes(32).toString("base64"));
      await host.restartApp();
      log({ msg: "healed missing BRAIN_CONNECTOR_TOKEN_KEY in deploy .env" });
    }
  } catch (err) {
    // Migration doctrine: a surprise on box state never stops updates.
    log({ warn: `connector key heal failed (will retry next start): ${String(err)}` });
  }

  log({ msg: "updater started", boothUrl, pollMs, current: state.currentVersion });
  for (;;) {
    let waitMs = pollMs;
    try {
      const result = await runTick(booth, host, state, log);
      state = result.state;
      // After a failed attempt, back off exponentially on THAT version's own
      // failure count (H5) instead of re-hammering it every poll.
      if (result.failures > 0) {
        waitMs = Math.max(pollMs, backoffMs(result.failures));
        log({ msg: "backing off failed version", failures: result.failures, waitMs });
      }
    } catch (err) {
      // A booth blip / docker hiccup skips the tick; the loop never dies.
      log({ error: String(err) });
    }
    await sleep(waitMs);
  }
}

const isMain = typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
