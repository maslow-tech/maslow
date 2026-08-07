import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_STOP_TIMEOUT_SECONDS,
  BoxHost,
  classifyPullFailure,
  isTransientPullFailure,
  readCanaryBody,
  type Exec,
  type HostConfig,
} from "./host.js";

/**
 * The restart op's stop timeout is a number in three places that have no type
 * relationship: this module, the compose file, and the box's own shutdown
 * budgets. Nothing fails loudly when they disagree — the box just gets SIGKILLed
 * mid-flush and the last paragraph of everyone who was typing disappears with no
 * error anywhere. So the agreement is asserted here, against the files.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("forced app restart honours the drain budget", () => {
  it("uses the same stop timeout compose gives the app", () => {
    const compose = readFileSync(join(repoRoot, "deploy", "docker-compose.yml"), "utf8");
    const grace = /^\s{4}stop_grace_period:\s*(\d+)s\s*$/m.exec(compose);
    expect(grace?.[1]).toBe(String(APP_STOP_TIMEOUT_SECONDS));
  });

  it("covers the box's hard shutdown ceiling", () => {
    const shutdown = readFileSync(join(repoRoot, "apps", "box", "src", "shutdown.ts"), "utf8");
    const ceiling = /export const SHUTDOWN_BUDGET_MS = ([\d_]+);/.exec(shutdown);
    expect(ceiling?.[1]).toBeDefined();
    const ceilingMs = Number(ceiling![1].replace(/_/g, ""));
    // Docker's 10s default is less than a single room-flush budget; the timeout
    // has to outlast the whole drain or the restart op eats unflushed text.
    expect(APP_STOP_TIMEOUT_SECONDS * 1000).toBeGreaterThan(ceilingMs);
  });
});

describe("readCanaryBody — write/collab halves read from the body, not the status", () => {
  const asRes = (body: unknown) => ({ json: () => Promise.resolve(body) });

  it("reads an explicit writeOk:true on a collab-only 503 (so the verdict can be collab_broken)", async () => {
    // box.ts returns HTTP 503 when ONLY collab failed, but its body says
    // writeOk:true. Sampling off the status would mislabel this write_broken.
    expect(await readCanaryBody(asRes({ ok: false, writeOk: true, collabOk: false }))).toEqual({
      writeOk: true,
      collabOk: false,
    });
  });

  it("reads writeOk:false when the write path is what broke", async () => {
    expect(await readCanaryBody(asRes({ ok: false, writeOk: false, collabOk: false }))).toEqual({
      writeOk: false,
      collabOk: false,
    });
  });

  it("omits an absent field so the caller falls back (older box, no writeOk/collabOk)", async () => {
    expect(await readCanaryBody(asRes({ ok: true }))).toEqual({});
  });

  it("returns nothing for an unparseable body (a caller then trusts the HTTP status)", async () => {
    expect(await readCanaryBody({ json: () => Promise.reject(new Error("not json")) })).toEqual({});
  });
});

/**
 * The latch bug of 2026-07-30, as tests.
 *
 * BundleFetchError existed from the start to split "the registry would not let
 * us in" (defer) from "this bundle is hostile" (latch) — and was never thrown,
 * so every registry failure took the definitive path. Three polls later the box
 * latched and stopped updating for good, which is what a GHCR credential expiry
 * did to the fleet. These are the exact stderr strings the daemon emits.
 */
describe("classifyPullFailure — a credential problem is not a poisoned release", () => {
  const auth = [
    "Error response from daemon: denied: denied",
    "Error response from daemon: unauthorized: unauthorized",
    "Error response from daemon: unauthorized: authentication required",
    "denied: permission_denied: The token provided does not match expected scopes.",
    'Error response from daemon: Head "https://ghcr.io/v2/x/bundle/manifests/v1.0.0": denied',
  ];
  for (const msg of auth) {
    it(`reads as auth: ${msg.slice(0, 52)}`, () => {
      expect(classifyPullFailure(msg)).toBe("auth");
      expect(isTransientPullFailure(msg)).toBe(true);
    });
  }

  it("reads docker's both-at-once message as auth, NOT as a missing tag", () => {
    // The trap. This one string names a permission problem AND a missing
    // repository, because registries hide existence from unauthorized callers.
    // Read as "missing", fetchBundle returns null, the app-only path applies the
    // release and SILENTLY DROPS its infra half — configs, postgres and caddy
    // never converge, and the bundle is never looked at again for that version.
    const msg =
      "Error response from daemon: pull access denied for ghcr.io/maslow-tech/bundle, repository does not exist or may require 'docker login'";
    expect(classifyPullFailure(msg)).toBe("auth");
  });

  const transport = [
    'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: i/o timeout',
    'Error response from daemon: Get "https://ghcr.io/v2/": net/http: TLS handshake timeout',
    "Error response from daemon: received unexpected HTTP status: 503 Service Unavailable",
    "Error response from daemon: toomanyrequests: 429 Too Many Requests",
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    'Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host',
  ];
  for (const msg of transport) {
    it(`reads as transport: ${msg.slice(0, 52)}`, () => {
      expect(classifyPullFailure(msg)).toBe("transport");
      expect(isTransientPullFailure(msg)).toBe(true);
    });
  }

  it("still reads a genuinely absent tag as missing (the pre-bundle path)", () => {
    expect(classifyPullFailure("Error response from daemon: manifest unknown")).toBe("missing");
    expect(
      classifyPullFailure("manifest for ghcr.io/x/bundle:v0.1.0 not found: manifest unknown"),
    ).toBe("missing");
    expect(isTransientPullFailure("Error response from daemon: manifest unknown")).toBe(false);
  });

  it("keeps reading the bare `manifest for <ref> not found` wording as missing", () => {
    // The `manifest for .* not found` alternative was dropped (polynomial
    // backtracking); "not found" alone already covers every string it matched,
    // including one with no other missing-ish wording anywhere in it.
    for (const msg of [
      "manifest for ghcr.io/maslowtech/bundle:v0.9.9 not found",
      "Error response from daemon: manifest for ghcr.io/x/box:v1 not found",
      "no such manifest: ghcr.io/x/box@sha256:deadbeef",
    ]) {
      expect(classifyPullFailure(msg)).toBe("missing");
      expect(isTransientPullFailure(msg)).toBe(false);
    }
  });

  it("auth still wins over missing on the ambiguous docker wording", () => {
    // The one message that names both; reading it as "missing" would silently
    // apply a release's app half and drop its infra half.
    const msg =
      "pull access denied for ghcr.io/x/bundle, repository does not exist or may require 'docker login'";
    expect(classifyPullFailure(msg)).toBe("auth");
    expect(isTransientPullFailure(msg)).toBe(true);
  });

  it("leaves an unrecognised failure DEFINITIVE — latch loudly beats loop silently", () => {
    // Deliberate: an unnameable failure may be a hostile payload or a bug here,
    // and those must not retry forever unseen.
    expect(classifyPullFailure("something nobody has ever seen")).toBe("unknown");
    expect(isTransientPullFailure("something nobody has ever seen")).toBe(false);
  });
});

/**
 * The test that would have caught the latch bug, on the seam that had none.
 *
 * classifyPullFailure being right is necessary but NOT sufficient: the shipped
 * bug was that fetchBundle never threw a BundleFetchError at all, so the
 * classification it produced went nowhere. These drive the real method with a
 * registry that refuses us.
 */
describe("fetchBundle tags its throws so the updater can tell world from release", () => {
  const cfg = (exec: Exec): HostConfig => ({
    deployDir: "/tmp/brain-test-deploy",
    imageRepo: "ghcr.io/x/box",
    bundleRepo: "ghcr.io/x/bundle",
    cosignIdentityRegexp: ".*",
    cosignIssuer: "https://token.actions.githubusercontent.com",
    stateFile: "/tmp/brain-test-state.json",
    canaryUrl: "http://app:8080/healthz",
    exec,
  });
  const failWith =
    (stderr: string): Exec =>
    () =>
      Promise.reject(Object.assign(new Error("exit 1"), { stderr }));

  it("an auth failure throws BundleFetchError{transient:true} — DEFER, never latch", async () => {
    const host = new BoxHost(cfg(failWith("Error response from daemon: denied: denied")));
    await expect(host.fetchBundle("v1.2.3")).rejects.toMatchObject({
      name: "BundleFetchError",
      transient: true,
    });
  });

  it("a registry 503 throws BundleFetchError{transient:true}", async () => {
    const host = new BoxHost(
      cfg(failWith("Error response from daemon: received unexpected HTTP status: 503")),
    );
    await expect(host.fetchBundle("v1.2.3")).rejects.toMatchObject({ transient: true });
  });

  it("a genuinely missing tag still returns null (the legal pre-bundle release)", async () => {
    const host = new BoxHost(cfg(failWith("Error response from daemon: manifest unknown")));
    await expect(host.fetchBundle("v1.2.3")).resolves.toBeNull();
  });

  it("does NOT read docker's 'access denied … may require docker login' as a missing tag", async () => {
    // Reading this as missing returns null, and null means "pre-bundle release"
    // — the app-only path applies and the infra half of the release is dropped
    // on the floor with nothing logged as wrong.
    const host = new BoxHost(
      cfg(
        failWith(
          "Error response from daemon: pull access denied for ghcr.io/x/bundle, repository does not exist or may require 'docker login'",
        ),
      ),
    );
    await expect(host.fetchBundle("v1.2.3")).rejects.toMatchObject({ transient: true });
  });

  it("an unrecognised failure stays DEFINITIVE", async () => {
    const host = new BoxHost(cfg(failWith("the bundle is shaped wrong in a novel way")));
    await expect(host.fetchBundle("v1.2.3")).rejects.toMatchObject({ transient: false });
  });

  it("a malformed version never reaches docker argv at all", async () => {
    let called = false;
    const host = new BoxHost(
      cfg(() => {
        called = true;
        return Promise.resolve({ stdout: "", stderr: "" });
      }),
    );
    await expect(host.fetchBundle("v1.2.3; rm -rf /")).rejects.toMatchObject({ transient: false });
    expect(called).toBe(false);
  });
});
