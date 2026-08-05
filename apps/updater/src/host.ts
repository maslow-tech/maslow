import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { CanarySample } from "./decisions.js";
import { parsePersistedState, type PersistedState } from "./versions.js";

const execFileAsync = promisify(execFile);

/**
 * The one process-spawning seam. Everything in this module shells out through
 * `run`, and it stayed a module-level const for a long time — which is exactly
 * why fetchBundle's failure classification had no test and shipped broken: there
 * was no way to hand it a registry that says "denied" without a docker daemon.
 * HostConfig.exec overrides it in tests; production never passes one.
 */
export type Exec = (
  file: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const run: Exec = (file, args, opts) =>
  execFileAsync(file, args, opts) as Promise<{ stdout: string; stderr: string }>;

/**
 * The box-host side effects behind the updater adapters: docker pulls,
 * cosign verification, the compose-managed app swap, and the persisted state
 * file. The updater runs as a SEPARATE container with the docker socket and the
 * deploy directory mounted, so it can restart `app` without restarting itself.
 *
 * Every process invocation is execFile (argv array, no shell), so a version or
 * digest string can never be interpreted by a shell — and both are shape-checked
 * before they get here anyway (booth-side VERSION_SHAPE/DIGEST_SHAPE).
 */

/**
 * A bundle fetch/verify failure carrying whether it is TRANSIENT (a
 * pull-transport / registry / Sigstore blip → the updater DEFERS and retries)
 * or DEFINITIVE (a structural / hostile bundle → poison toward the latch).
 */
export class BundleFetchError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "BundleFetchError";
  }
}

/**
 * How a `docker pull` (or any docker CLI call) failed, read off stderr.
 *
 *   auth      — the registry refused our credentials (401/403/denied). A
 *               CREDENTIAL problem, never a property of the release.
 *   transport — network/DNS/TLS/timeout/5xx/429. The registry is unreachable
 *               or unwell.
 *   missing   — the tag genuinely does not exist (a pre-bundle release).
 *   unknown   — anything we cannot name.
 *
 * WHY THIS EXISTS (2026-07-30). `fetchBundle` used to throw a plain Error for
 * every non-missing pull failure, and runtime.ts classifies any throw that is
 * not a BundleFetchError as DEFINITIVE — so an expired GHCR credential poisoned
 * the version and, after `maxFailuresBeforeLatch` polls, LATCHED the box: it
 * stopped updating entirely and stayed stopped after the credential was fixed,
 * because the latch is sticky and only a runbook clears it. BundleFetchError
 * existed for exactly this split but was never once thrown, so the transient
 * path was dead code. An expired password is not a poisoned release.
 *
 * The classifier is a pure function on the message precisely so it can be
 * tested against real registry stderr without a docker daemon.
 */
export type PullFailureKind = "auth" | "transport" | "missing" | "unknown";

// Ordered deliberately: AUTH IS TESTED FIRST. Docker's canonical auth failure is
// "pull access denied for <ref>, repository does not exist or may require
// 'docker login'" — a single string that names BOTH a permission problem and a
// missing repository, because registries hide existence from unauthorized
// callers. Matching `missing` first would read that as a legal pre-bundle
// release, return null, and let the app-only path apply the release while
// SILENTLY DROPPING its infra half (the exact failure fetchBundle's doc warns
// about). When a message is ambiguous, the safe reading is "we are not allowed
// to look", not "it isn't there".
const AUTH_RE =
  /\b(denied|unauthorized|authentication required|forbidden|access to the requested resource is not authorized|401|403)\b|requires ['"]?docker login|authorization failed/i;
const TRANSPORT_RE =
  /\b(timeout|timed out|connection refused|connection reset|reset by peer|network is unreachable|no route to host|no such host|temporary failure in name resolution|dial tcp|i\/o timeout|EOF|TLS handshake|certificate|context deadline exceeded|too many requests|429|500|502|503|504|server error|service unavailable|internal server error|registry is unavailable|cannot connect to the docker daemon|is the docker daemon running)\b/i;
const MISSING_RE = /manifest unknown|manifest for .* not found|not found|no such manifest/i;

export function classifyPullFailure(message: string): PullFailureKind {
  if (AUTH_RE.test(message)) return "auth";
  if (TRANSPORT_RE.test(message)) return "transport";
  if (MISSING_RE.test(message)) return "missing";
  return "unknown";
}

/**
 * Is this failure the registry's fault (or the network's) rather than the
 * release's? Both `auth` and `transport` are conditions that a later poll can
 * find resolved with the bundle byte-identical, so both DEFER forever instead of
 * counting toward the latch. `unknown` stays DEFINITIVE on purpose: an
 * unrecognised failure could be a hostile payload or a bug in this code, and
 * latching loudly beats looping silently.
 */
export function isTransientPullFailure(message: string): boolean {
  const kind = classifyPullFailure(message);
  return kind === "auth" || kind === "transport";
}

export interface HostConfig {
  /** the mounted deploy dir holding docker-compose.yml + .env (/opt/brain/deploy). */
  readonly deployDir: string;
  /** image repo the fleet pulls from, e.g. ghcr.io/maslow-tech/maslow/box. */
  readonly imageRepo: string;
  /** cosign keyless identity: the exact CI workflow allowed to have signed. */
  readonly cosignIdentityRegexp: string;
  readonly cosignIssuer: string;
  /** persisted updater state (own volume — survives app swaps). */
  readonly stateFile: string;
  /** the box liveness probe on the compose network (http://app:8080/healthz). */
  readonly canaryUrl: string;
  readonly canarySamples?: number;
  readonly canaryIntervalMs?: number;
  /** how long to give the app to come up before the first canary sample. */
  readonly canaryWarmupMs?: number;
  /** the release-bundle repo (whole-box bundle updates), e.g. ghcr.io/maslow-tech/maslow/bundle. */
  readonly bundleRepo?: string;
  /** TEST SEAM ONLY — overrides process spawning. Production never sets it. */
  readonly exec?: Exec;
}

/** Booth-side VERSION_SHAPE mirrored here as a belt: tag names reach docker argv. */
const VERSION_SHAPE = /^v[0-9A-Za-z.-]+$/;
/** deploy-tree entries the bundle may replace; .env is NEVER one of them. */
const DEPLOY_TREE_ENTRIES = [
  "docker-compose.yml",
  "Caddyfile",
  "postgres",
  "pgbackrest",
  "logviewer.sh",
];
const SNAPSHOT_DIR = ".rollback-snapshot";
const STAGING_DIR = ".bundle-staging";

const DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/;

/**
 * Seconds the `app` container gets between SIGTERM and SIGKILL on a forced
 * restart. MUST equal `stop_grace_period` on the `app` service in
 * `deploy/docker-compose.yml` — host.test.ts reads that file and asserts it, so
 * tuning the drain budget in one place cannot silently leave the other behind.
 */
export const APP_STOP_TIMEOUT_SECONDS = 45;

export class BoxHost {
  constructor(private readonly cfg: HostConfig) {}

  /** Every shell-out in this class goes through here, so a test can stand in a
   *  registry that refuses us without needing a docker daemon. */
  private get run(): Exec {
    return this.cfg.exec ?? run;
  }

  private imageRef(digest: string): string {
    if (!DIGEST_SHAPE.test(digest)) throw new Error(`refusing malformed digest: ${digest}`);
    return `${this.cfg.imageRepo}@${digest}`;
  }

  private async compose(...args: string[]): Promise<void> {
    await this.run("docker", ["compose", "--project-directory", this.cfg.deployDir, ...args], {
      timeout: 10 * 60_000,
    });
  }

  /**
   * cosign keyless verify: the signature over the DIGEST, bound to OUR
   * release workflow's OIDC identity (cert-identity-regexp) and issuer. Only the
   * release workflow could have produced this signature for this exact digest —
   * that is the load-bearing supply-chain guarantee.
   *
   * We deliberately do NOT `cosign verify-attestation` here. The release attaches
   * SLSA provenance via docker/build-push-action `provenance: mode=max` — a
   * BUILDKIT OCI attestation-manifest, NOT a `cosign attest` — so
   * verify-attestation finds "no matching attestations" and would reject EVERY
   * real release (it did: the whole self-update path was silently blocked until
   * this was found by running it end-to-end). Requiring it bought nothing the
   * signature doesn't already give: the identity+digest-bound signature defeats a
   * forged image, and an OLD signature can't be replayed forward because the
   * updater only ever applies the digest the booth's release list names, gated by
   * the anti-rollback floor (runtime.ts `verify` adapter). The provenance stays
   * attached to the image for audit; gating on a cosign attestation the pipeline
   * never produces was the bug, not the security.
   */
  async verify(digest: string): Promise<boolean> {
    return this.verifyRef(this.imageRef(digest));
  }

  async pull(digest: string): Promise<void> {
    await this.run("docker", ["pull", this.imageRef(digest)], { timeout: 10 * 60_000 });
  }

  /**
   * Pin BRAIN_IMAGE in the deploy .env to an exact digest ref. Written via a
   * temp file + rename so a crash mid-write can't leave a torn .env (the file
   * also carries the DB URLs — it must never be half-written).
   */
  pinImage(digest: string): void {
    this.pinEnv("BRAIN_IMAGE", this.imageRef(digest));
  }

  /** Run the one-off migrate service from the (already pinned) release image. */
  async migrate(): Promise<void> {
    await this.compose("--profile", "tools", "run", "--rm", "migrate");
  }

  /** Recreate `app` on the pinned image. Compose only recreates on change. */
  async restartApp(): Promise<void> {
    await this.compose("up", "-d", "--no-deps", "app");
  }

  /**
   * Host root-disk usage percent, read via `df` on the host-mounted deploy dir
   * (/opt/brain/deploy is a bind mount, so this reflects the HOST filesystem
   * docker stores images on — not the updater container's overlay). Null if it
   * can't be read. Feeds the booth's low-disk warning so a filling box is
   * visible BEFORE a full disk wedges its `docker pull`s.
   */
  async diskPctUsed(): Promise<number | null> {
    try {
      const { stdout } = await this.run("df", ["-P", this.cfg.deployDir], { timeout: 10_000 });
      // POSIX `df -P`: the data line's 5th column is capacity, e.g. "82%".
      const line = stdout.trim().split("\n").pop() ?? "";
      const m = /(\d+)%/.exec(line);
      if (!m) return null;
      const pct = Number(m[1]);
      return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
    } catch {
      return null;
    }
  }

  /** Run a docker maintenance command, swallowing failure (best-effort). */
  private async tryDocker(args: string[]): Promise<string> {
    try {
      const { stdout } = await this.run("docker", args, { timeout: 2 * 60_000 });
      return stdout;
    } catch (err) {
      console.warn(`docker ${args.join(" ")} failed (non-fatal): ${String(err)}`);
      return "";
    }
  }

  /**
   * Reclaim images the fleet has moved past so the box disk can't fill and
   * silently wedge future updates (a full disk fails `docker pull`, and
   * the box stalls one version behind while the updater loops on ENOSPC).
   *
   * Removes the box images superseded by this swap, KEEPING: the running image
   * (docker refuses to remove an in-use image — a natural guard, so the live
   * app/postgres/caddy/updater are never touched even if omitted from
   * keepDigests) and every rollback target the updater still retains
   * (keepDigests). Also clears truly-dangling images and the build cache.
   *
   * NEVER touches volumes — those hold the Postgres data. Best-effort by
   * contract: every step swallows its own failure, so a prune can neither fail
   * nor delay the swap that triggered it beyond its own timeout.
   */
  async pruneImages(keepDigests: readonly string[] = []): Promise<void> {
    // Dangling images + build cache: always safe, reclaims the bulk of churn.
    await this.tryDocker(["image", "prune", "-f"]);
    await this.tryDocker(["builder", "prune", "-f"]);
    // Box images pulled by digest are NOT dangling, so remove the superseded
    // ones explicitly. `docker image rm` refuses an in-use image, so the
    // running version is protected without us having to identify it.
    const keep = new Set(keepDigests);
    const listed = await this.tryDocker([
      "images",
      "--no-trunc",
      "--format",
      "{{.ID}}\t{{.Digest}}",
      this.cfg.imageRepo,
    ]);
    const seenId = new Set<string>();
    let removed = 0;
    for (const line of listed.split("\n")) {
      const [id, digest] = line.split("\t");
      if (!id || !digest || digest === "<none>") continue;
      if (keep.has(digest) || seenId.has(id)) continue;
      seenId.add(id);
      const out = await this.tryDocker(["image", "rm", id]);
      if (out !== "") removed += 1; // rm on the in-use image returns "" (failed) → skipped
    }
    console.log(JSON.stringify({ evt: "image_prune", repo: this.cfg.imageRepo, removed }));
  }

  /**
   * Actually bounce `app` (the operator restart op). `up -d` is deliberately lazy —
   * it recreates only on image/config change, which makes it a NO-OP for the
   * op's exact target: a wedged app on an unchanged image. `restart` stops and
   * starts the container unconditionally (SIGTERM, then SIGKILL on timeout).
   *
   * `--timeout` is passed EXPLICITLY and is not decoration. The box drains live
   * collab rooms on SIGTERM (apps/box/src/shutdown.ts: 20s rooms + 5s audit,
   * 30s hard ceiling) — text that exists nowhere but memory until it flushes.
   * Compose is *supposed* to default this to the service's `stop_grace_period`
   * (45s, deploy/docker-compose.yml), and current v2 does, but older v2 defaults
   * to 10s and would SIGKILL mid-drain. We do not control which compose a box
   * that enrolled a year ago is running, so we state the number rather than
   * inherit it. An explicit timeout can only ever lengthen the window, never
   * shorten it.
   */
  async forceRestartApp(): Promise<void> {
    await this.compose("restart", "--timeout", String(APP_STOP_TIMEOUT_SECONDS), "app");
  }

  /**
   * Sample the box after a swap. `canaryUrl` points at the box's /canary, which
   * probes BOTH halves of the app (box.ts): a real DB round-trip via the
   * brain_app pool (`writeOk`) and an in-process collab room open/close
   * (`collabOk`), so a release that breaks the write path OR the websocket
   * surface — not just liveness — is caught. Failure classification is what
   * makes this safe AND useful: only OUR request timeout counts as `busy`
   * (inconclusive — a slow cold start must not trigger a rollback storm). A
   * definitive failure — connection refused, DNS error, or a non-2xx status (a
   * crash-looping app, or /canary's 503 on a broken write path or a failed
   * collab probe) — counts as `busy:false`, i.e. a real rollback vote.
   */
  async canary(): Promise<CanarySample[]> {
    const samples = this.cfg.canarySamples ?? 5;
    const interval = this.cfg.canaryIntervalMs ?? 5_000;
    await sleep(this.cfg.canaryWarmupMs ?? 20_000);
    const out: CanarySample[] = [];
    for (let i = 0; i < samples; i++) {
      if (i > 0) await sleep(interval);
      out.push(await this.sampleOnce());
    }
    return out;
  }

  /**
   * A single steady-state probe for the periodic heartbeat's `healthy` field
   * (booth health monitoring) — NOT the post-swap rollback verdict. It never sleeps and
   * never throws. A definitive failure (503 / connection refused, or a box
   * reporting `collabOk:false`) reports `false`; our own request timeout is
   * inconclusive (`busy`) and reports `true`, so a transient blip doesn't page
   * an on-call. The booth turns a run of `false`s into an alert.
   */
  async probe(): Promise<boolean> {
    const s = await this.sampleOnce();
    return (s.writeOk && s.collabOk !== false) || s.busy;
  }

  private async sampleOnce(): Promise<CanarySample> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(this.cfg.canaryUrl, { signal: controller.signal });
      // Read BOTH halves from the body, not the HTTP status: box.ts returns 503
      // when EITHER half fails, so `res.ok` alone cannot tell a broken write
      // path (writeOk:false) from a broken collab surface (writeOk:true,
      // collabOk:false) — and mapping res.ok → writeOk would mislabel every
      // collab-only failure as `write_broken` (the collab_broken verdict would
      // be unreachable). The body's explicit `writeOk` is authoritative; we fall
      // back to `res.ok` only when it is absent (an older box, or an unparseable
      // response such as a Caddy 502 during a crash-loop), which reads a
      // definitively-down app as a write failure exactly as before.
      const body = await readCanaryBody(res);
      return { writeOk: body.writeOk ?? res.ok, collabOk: body.collabOk, busy: false };
    } catch (err) {
      // Our own abort = inconclusive (busy). Any other error (ECONNREFUSED,
      // DNS, socket reset) = the app is genuinely down → a real failure vote.
      const aborted = err instanceof Error && err.name === "AbortError";
      return { writeOk: false, collabOk: aborted ? undefined : false, busy: aborted };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- bundle + whole-box infra (bundle updates) ----------------------------

  /** cosign keyless verify for ANY first-party ref (same identity binding). */
  async verifyRef(ref: string): Promise<boolean> {
    try {
      await this.run(
        "cosign",
        [
          "verify",
          "--certificate-identity-regexp",
          this.cfg.cosignIdentityRegexp,
          "--certificate-oidc-issuer",
          this.cfg.cosignIssuer,
          ref,
        ],
        { timeout: 2 * 60_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  async pullRef(ref: string): Promise<void> {
    await this.run("docker", ["pull", ref], { timeout: 10 * 60_000 });
  }

  /**
   * Fetch the release bundle for `version`: pull by tag, resolve the digest,
   * cosign-verify it, then extract bundle.json + the deploy tarball via
   * docker create/cp (a scratch image has nothing to run). Returns null ONLY
   * for a definitive manifest-unknown (a genuine pre-bundle release) — any
   * OTHER pull failure (network, auth, registry 5xx) THROWS, because failing
   * open here would silently strip the infra half of a release: the app-only
   * path would apply, currentVersion would advance, and the bundle would
   * never be looked at again for that version.
   *
   * Every throw is a BundleFetchError carrying its own transient flag, so the
   * caller can tell "the registry would not let us in" (defer forever) from
   * "this bundle is structurally wrong" (poison toward the latch). See
   * classifyPullFailure.
   */
  async fetchBundle(version: string): Promise<{ rawJson: string; tarPath: string } | null> {
    const repo = this.cfg.bundleRepo;
    if (repo === undefined) return null;
    if (!VERSION_SHAPE.test(version))
      throw new BundleFetchError(`refusing malformed version: ${version}`, false);
    const tagRef = `${repo}:${version}`;
    // Any docker CLI call can fail because the daemon is restarting or the
    // registry is unwell; those are transient exactly like the pull is.
    const docker = async (args: string[], opts?: { timeout: number }) => {
      try {
        return await this.run("docker", args, opts);
      } catch (err) {
        const msg = String((err as { stderr?: string }).stderr ?? err);
        throw new BundleFetchError(
          `docker ${args[0]} failed: ${msg.slice(0, 300)}`,
          isTransientPullFailure(msg),
        );
      }
    };
    try {
      await this.run("docker", ["pull", tagRef], { timeout: 5 * 60_000 });
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr ?? err);
      const kind = classifyPullFailure(msg);
      if (kind === "missing") return null; // pre-bundle release
      throw new BundleFetchError(
        `bundle pull failed (${kind}): ${msg.slice(0, 300)}`,
        kind === "auth" || kind === "transport",
      );
    }
    const { stdout } = await docker([
      "image",
      "inspect",
      tagRef,
      "--format",
      "{{json .RepoDigests}}",
    ]);
    let repoDigests: string[];
    try {
      repoDigests = JSON.parse(stdout.trim()) as string[];
    } catch {
      throw new BundleFetchError(`unparseable repo digests for ${tagRef}`, false);
    }
    const entry = repoDigests.find((d) => d.startsWith(`${repo}@`));
    if (entry === undefined) throw new BundleFetchError(`no repo digest for ${tagRef}`, false);
    const digest = entry.slice(repo.length + 1);
    if (!DIGEST_SHAPE.test(digest))
      throw new BundleFetchError(`malformed bundle digest: ${digest}`, false);
    const ref = `${repo}@${digest}`;
    // TRANSIENT, not definitive: cosign reaches the registry, Fulcio and Rekor,
    // so this returns false for a signing-infrastructure outage or a credential
    // problem just as readily as for an unsigned image. runtime.ts already
    // treats every OTHER cosign call that way (a bad image simply never
    // applies); this one call disagreeing is what made an outage look hostile.
    if (!(await this.verifyRef(ref)))
      throw new BundleFetchError(`bundle signature verify failed: ${ref}`, true);

    const staging = join(this.cfg.deployDir, STAGING_DIR);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const { stdout: cid } = await docker(["create", ref, "noop"]);
    const container = cid.trim();
    try {
      await docker(["cp", `${container}:/bundle.json`, join(staging, "bundle.json")]);
      await docker([
        "cp",
        `${container}:/brain-deploy.tar.gz`,
        join(staging, "brain-deploy.tar.gz"),
      ]);
    } finally {
      await this.run("docker", ["rm", "-f", container]).catch(() => undefined);
    }
    // Size caps: both files are CI-authored and small; anything huge is wrong
    // (or hostile) and must not be slurped into memory.
    for (const f of ["bundle.json", "brain-deploy.tar.gz"]) {
      const size = statSync(join(staging, f)).size;
      if (size > 64 * 1024 * 1024)
        throw new BundleFetchError(`${f} exceeds the 64MiB cap (${size})`, false);
    }
    return {
      rawJson: readFileSync(join(staging, "bundle.json"), "utf8"),
      tarPath: join(staging, "brain-deploy.tar.gz"),
    };
  }

  /** Streamed sha256 of a file — binds the tarball to the signed manifest. */
  async fileSha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    return hash.digest("hex");
  }

  readEnvVar(name: string): string | undefined {
    const re = new RegExp(`^\\s*${name}=`);
    const line = readFileSync(`${this.cfg.deployDir}/.env`, "utf8")
      .split("\n")
      .find((l) => re.test(l));
    return line?.slice(line.indexOf("=") + 1);
  }

  /**
   * Pin any env var — the ONE torn-write-safe .env mutation (pinImage
   * delegates here). Only an ACTIVE assignment counts; a commented template
   * line is left alone and a real line appended.
   */
  pinEnv(name: string, value: string): void {
    const envPath = `${this.cfg.deployDir}/.env`;
    const re = new RegExp(`^\\s*${name}=`);
    const lines = readFileSync(envPath, "utf8").split("\n");
    const idx = lines.findIndex((l) => re.test(l));
    if (idx === -1) lines.push(`${name}=${value}`);
    else lines[idx] = `${name}=${value}`;
    const tmp = `${envPath}.updater-tmp`;
    writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
    renameSync(tmp, envPath);
  }

  /**
   * Snapshot everything a bundle apply may touch (.env + the deploy tree),
   * STAMPED with the version being attempted: every restore path checks the
   * stamp against the journaled attempt, so a stale snapshot (orphaned by a
   * crash after success) can never restore an old shape under a later
   * release, and a busy-canary retry of the SAME version keeps its original
   * pre-swap baseline instead of re-snapshotting the mutated shape.
   */
  snapshotDeploy(version: string): void {
    const snap = join(this.cfg.deployDir, SNAPSHOT_DIR);
    rmSync(snap, { recursive: true, force: true });
    mkdirSync(snap, { recursive: true });
    for (const entry of [".env", ...DEPLOY_TREE_ENTRIES]) {
      const src = join(this.cfg.deployDir, entry);
      if (existsSync(src)) cpSync(src, join(snap, entry), { recursive: true });
    }
    writeFileSync(join(snap, "VERSION"), version, { mode: 0o600 });
  }

  /** The stamped version of the current snapshot, or null when absent. */
  snapshotVersion(): string | null {
    try {
      return readFileSync(join(this.cfg.deployDir, SNAPSHOT_DIR, "VERSION"), "utf8").trim();
    } catch {
      return null;
    }
  }

  /** REPLACE the deploy shape from the snapshot (delete-then-copy, no merge —
   * files a newer tree ADDED must not survive a restore). */
  restoreDeploySnapshot(): void {
    const snap = join(this.cfg.deployDir, SNAPSHOT_DIR);
    for (const entry of [".env", ...DEPLOY_TREE_ENTRIES]) {
      const src = join(snap, entry);
      if (!existsSync(src)) continue;
      const dst = join(this.cfg.deployDir, entry);
      rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst, { recursive: true });
    }
  }

  clearDeploySnapshot(): void {
    rmSync(join(this.cfg.deployDir, SNAPSHOT_DIR), { recursive: true, force: true });
  }

  /**
   * Lay the bundle's deploy tree (compose/Caddyfile/postgres/pgbackrest confs)
   * over the deploy dir — REPLACE per entry, never merge, and NEVER .env
   * (that carries the box's secrets and pins). The tarball hash is re-checked
   * against the signed manifest at apply time (defense in depth vs the
   * verify-time check minutes earlier), and copied entries must be regular
   * files/dirs — a symlink smuggled into a tree that host-side compose or
   * postgres would later dereference is refused.
   */
  async applyDeployTree(tarPath: string, expectedSha256: string): Promise<void> {
    if ((await this.fileSha256(tarPath)) !== expectedSha256) {
      throw new Error("deploy tarball hash mismatch at apply time");
    }
    const staging = join(this.cfg.deployDir, STAGING_DIR, "tree");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    await this.run("tar", ["-xzf", tarPath, "-C", staging]);
    for (const entry of DEPLOY_TREE_ENTRIES) {
      const src = join(staging, "deploy", entry);
      if (!existsSync(src)) continue;
      const st = lstatSync(src);
      if (!st.isFile() && !st.isDirectory()) {
        throw new Error(`deploy tree entry ${entry} is not a regular file/dir`);
      }
      const dst = join(this.cfg.deployDir, entry);
      rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst, { recursive: true });
    }
  }

  /** compose services minus the updater itself (see upInfraWait). */
  private async infraServices(): Promise<string[]> {
    const { stdout } = await this.run("docker", [
      "compose",
      "--project-directory",
      this.cfg.deployDir,
      "config",
      "--services",
    ]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "" && s !== "updater");
  }

  /** Recreate postgres on its (already pinned) image and wait for healthy. */
  async upPostgresWait(): Promise<void> {
    await this.compose("up", "-d", "--no-deps", "--wait", "postgres");
  }

  /**
   * Bring the topology to the current config — EXCEPT the updater service.
   * A whole-topology up would recreate `updater` whenever the new compose
   * changes its stanza, SIGTERMing the very process driving this command
   * mid-tick (and an API-stopped container is NOT resurrected by
   * restart:unless-stopped — the box would be left with no updater at all).
   * The updater's own stanza + pin converge together in the detached
   * self-recreate, which runs last.
   */
  async upInfraWait(): Promise<void> {
    const services = await this.infraServices();
    await this.compose("up", "-d", "--wait", ...services);
  }

  /**
   * PG_MAJOR of the postgres container (running OR stopped — a crash-looping
   * postgres must still be guarded). null ONLY when the container genuinely
   * does not exist; a docker error THROWS — the cross-major refusal is the
   * one hard safety gate and must fail CLOSED, not open.
   * (Residual: a container someone `docker rm`ed while its 17-format data
   * volume persists reads as absent — acceptable, that state is operator-made.)
   */
  async currentPgMajor(): Promise<string | null> {
    const { stdout } = await this.run("docker", [
      "compose",
      "--project-directory",
      this.cfg.deployDir,
      "ps",
      "-aq",
      "postgres",
    ]);
    const cid = stdout.trim().split("\n")[0];
    if (cid === undefined || cid === "") return null;
    const { stdout: envOut } = await this.run("docker", [
      "inspect",
      cid,
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
    ]);
    const line = envOut.split("\n").find((l) => l.startsWith("PG_MAJOR="));
    return line ? line.slice("PG_MAJOR=".length).trim() : null;
  }

  /** The image ref a compose service's CURRENT container was created from,
   * or null when the container doesn't exist. */
  async currentServiceImage(service: string): Promise<string | null> {
    const { stdout } = await this.run("docker", [
      "compose",
      "--project-directory",
      this.cfg.deployDir,
      "ps",
      "-aq",
      service,
    ]);
    const cid = stdout.trim().split("\n")[0];
    if (cid === undefined || cid === "") return null;
    const { stdout: img } = await this.run("docker", [
      "inspect",
      cid,
      "--format",
      "{{.Config.Image}}",
    ]);
    return img.trim() || null;
  }

  /**
   * Recreate the updater itself — via a DETACHED helper container, never
   * in-process: compose stopping `updater` kills this very process before
   * the replacement is created, leaving the box with no updater at all. The
   * helper runs the NEW updater image (already pulled + cosign-verified) with
   * the host socket + deploy dir, waits out our death, and brings `updater`
   * up on the new pin/stanza.
   */
  async recreateUpdaterSelf(newUpdaterRef: string): Promise<void> {
    await this.run("docker", [
      "run",
      "-d",
      "--rm",
      "--entrypoint",
      "sh",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${this.cfg.deployDir}:${this.cfg.deployDir}`,
      "-v",
      "/root/.docker/config.json:/root/.docker/config.json:ro",
      newUpdaterRef,
      "-c",
      `sleep 3 && docker compose --project-directory ${this.cfg.deployDir} up -d updater`,
    ]);
  }

  // ---- persisted state ------------------------------------------------------

  /**
   * Load persisted state. A MISSING file is genuine first boot (→ null). A file
   * that exists but is unreadable or corrupt is NOT treated as first boot —
   * re-bootstrapping to BRAIN_CURRENT_VERSION could silently downgrade a box, so
   * we throw and let the tick fail loudly instead of quietly resetting.
   */
  loadState(): PersistedState | null {
    let raw: string;
    try {
      raw = readFileSync(this.cfg.stateFile, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
    // A present-but-corrupt/`null`/malformed body must THROW (routes to main's
    // idle-loudly-for-operator), never fall through to a first-boot re-bootstrap
    // that would silently downgrade to BRAIN_CURRENT_VERSION.
    return parsePersistedState(raw);
  }

  saveState(state: PersistedState): void {
    mkdirSync(dirname(this.cfg.stateFile), { recursive: true });
    const tmp = `${this.cfg.stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.cfg.stateFile);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Both judged halves of a /canary response — `writeOk` and `collabOk`.
 *
 * ABSENCE IS NOT FAILURE, and this is the whole reason the fields are optional: a
 * box whose app predates a field answers without it, and so does any response we
 * cannot parse. `collabOk` missing ⇒ "not judged" (only an explicit `false`
 * condemns — reading absence as broken would roll back the very release that
 * adds the probe on a box mid-upgrade). `writeOk` missing ⇒ the caller falls
 * back to the HTTP status, so a definitively-down app still votes to roll back.
 */
export async function readCanaryBody(res: {
  json(): Promise<unknown>;
}): Promise<{ writeOk?: boolean; collabOk?: boolean }> {
  try {
    const body = (await res.json()) as { writeOk?: unknown; collabOk?: unknown } | null;
    return {
      ...(typeof body?.writeOk === "boolean" ? { writeOk: body.writeOk } : {}),
      ...(typeof body?.collabOk === "boolean" ? { collabOk: body.collabOk } : {}),
    };
  } catch {
    return {}; // not JSON, empty, or already consumed — no verdict either way
  }
}
