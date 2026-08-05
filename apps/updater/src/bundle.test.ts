import { describe, expect, it } from "vitest";
import { imageRef, parseBundleJson, planInfra, PIN_VARS, type BundleManifest } from "./bundle.js";

/** valid-shaped digests, one hex letter repeated. */
const dig = (c: string): string => `sha256:${c.repeat(64)}`;

const APP = dig("a");
const UPD = dig("b");
const PG = dig("c");
const CADDY = dig("d");

function rawBundle(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    bundle_schema: 1,
    version: "v1.2.3",
    postgres_major: "17",
    deploy_sha256: "e".repeat(64),
    images: {
      app: { repo: "ghcr.io/org/repo/box", digest: APP },
      updater: { repo: "ghcr.io/org/repo/updater", digest: UPD },
      postgres: { repo: "ghcr.io/org/repo/postgres", digest: PG },
      caddy: { repo: "docker.io/library/caddy", digest: CADDY },
    },
    ...overrides,
  });
}

const EXPECTED = { version: "v1.2.3", appDigest: APP };

describe("parseBundleJson — the trust gate behind the signature", () => {
  it("accepts a well-formed bundle that matches the booth record", () => {
    const r = parseBundleJson(rawBundle(), EXPECTED);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bundle.postgresMajor).toBe("17");
      expect(r.bundle.images.caddy.digest).toBe(CADDY);
      expect(imageRef(r.bundle.images.app)).toBe(`ghcr.io/org/repo/box@${APP}`);
    }
  });

  it("rejects non-JSON and non-object payloads", () => {
    expect(parseBundleJson("not json{", EXPECTED).ok).toBe(false);
    expect(parseBundleJson('"a string"', EXPECTED).ok).toBe(false);
  });

  it("rejects an unknown bundle_schema", () => {
    expect(parseBundleJson(rawBundle({ bundle_schema: 2 }), EXPECTED).ok).toBe(false);
  });

  it("rejects a version mismatch (re-tagged bundle from another release)", () => {
    const r = parseBundleJson(rawBundle({ version: "v9.9.9" }), EXPECTED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version/);
  });

  it("rejects an app digest that disagrees with the booth record", () => {
    const r = parseBundleJson(rawBundle(), { version: "v1.2.3", appDigest: dig("f") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/booth record/);
  });

  it("rejects malformed digests, repos, majors, and tarball hashes", () => {
    const badDigest = rawBundle({
      images: {
        app: { repo: "ghcr.io/org/repo/box", digest: "sha256:short" },
        updater: { repo: "ghcr.io/org/repo/updater", digest: UPD },
        postgres: { repo: "ghcr.io/org/repo/postgres", digest: PG },
        caddy: { repo: "docker.io/library/caddy", digest: CADDY },
      },
    });
    expect(parseBundleJson(badDigest, EXPECTED).ok).toBe(false);
    const badRepo = rawBundle({
      images: {
        app: { repo: "ghcr.io/org/repo/box; rm -rf /", digest: APP },
        updater: { repo: "ghcr.io/org/repo/updater", digest: UPD },
        postgres: { repo: "ghcr.io/org/repo/postgres", digest: PG },
        caddy: { repo: "docker.io/library/caddy", digest: CADDY },
      },
    });
    expect(parseBundleJson(badRepo, EXPECTED).ok).toBe(false);
    expect(parseBundleJson(rawBundle({ postgres_major: "seventeen" }), EXPECTED).ok).toBe(false);
    expect(parseBundleJson(rawBundle({ deploy_sha256: "xyz" }), EXPECTED).ok).toBe(false);
  });

  it("rejects a missing component pin", () => {
    const missing = rawBundle({
      images: {
        app: { repo: "ghcr.io/org/repo/box", digest: APP },
        updater: { repo: "ghcr.io/org/repo/updater", digest: UPD },
        postgres: { repo: "ghcr.io/org/repo/postgres", digest: PG },
      },
    });
    expect(parseBundleJson(missing, EXPECTED).ok).toBe(false);
  });
});

function bundle(): BundleManifest {
  const r = parseBundleJson(rawBundle(), EXPECTED);
  if (!r.ok) throw new Error(r.error);
  return r.bundle;
}

describe("planInfra — component diff + the cross-major refusal", () => {
  const allPinned = {
    app: `ghcr.io/org/repo/box@${APP}`,
    updater: `ghcr.io/org/repo/updater@${UPD}`,
    postgres: `ghcr.io/org/repo/postgres@${PG}`,
    caddy: `docker.io/library/caddy@${CADDY}`,
  };

  it("a fully converged box plans zero changes", () => {
    const r = planInfra(bundle(), allPinned, "17");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.changed).toEqual([]);
      expect(r.plan.postgresChanged).toBe(false);
      expect(r.plan.updaterChanged).toBe(false);
    }
  });

  it("unpinned components (fresh box, pre-bundle install) all change", () => {
    const r = planInfra(bundle(), { app: allPinned.app }, "17");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.changed).toEqual(["postgres", "caddy"]);
      expect(r.plan.postgresChanged).toBe(true);
      expect(r.plan.updaterChanged).toBe(true);
    }
  });

  it("REFUSES a cross-major postgres jump (runbook-only)", () => {
    const r = planInfra(bundle(), allPinned, "16");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refuse).toMatch(/cross-major|pg_upgrade/);
  });

  it("an absent postgres container (null major) is not guarded", () => {
    expect(planInfra(bundle(), allPinned, null).ok).toBe(true);
  });

  it("PIN_VARS names the compose env pins", () => {
    expect(PIN_VARS.app).toBe("BRAIN_IMAGE");
    expect(PIN_VARS.postgres).toBe("BRAIN_POSTGRES_IMAGE");
    expect(PIN_VARS.caddy).toBe("BRAIN_CADDY_IMAGE");
    expect(PIN_VARS.updater).toBe("BRAIN_UPDATER_IMAGE");
  });
});

describe("pre-removal bundles — the teammate/harness component is gone", () => {
  it("a bundle carrying a stray images.harness pin (the ROLLBACK TARGET's shape) still parses, ignored", () => {
    const r = parseBundleJson(
      rawBundle({
        images: {
          app: { repo: "ghcr.io/org/repo/box", digest: APP },
          updater: { repo: "ghcr.io/org/repo/updater", digest: UPD },
          postgres: { repo: "ghcr.io/org/repo/postgres", digest: PG },
          caddy: { repo: "docker.io/library/caddy", digest: CADDY },
          harness: { repo: "ghcr.io/org/repo/harness", digest: dig("9") },
        },
      }),
      EXPECTED,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.bundle.images as Record<string, unknown>)["harness"]).toBeUndefined();
      // …and the plan never names it as a component.
      const plan = planInfra(r.bundle, {}, "17");
      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.plan.changed).toEqual(["app", "postgres", "caddy"]);
    }
  });
});
