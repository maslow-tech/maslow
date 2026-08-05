/**
 * The release BUNDLE (whole-box bundle updates) — pure parsing/validation/planning.
 *
 * A release ships ghcr.io/…/bundle:<version>: a cosign-signed scratch image
 * carrying bundle.json (every box component pinned by digest + the postgres
 * major) and the SAME deploy tarball the installer uses. This module owns the
 * decisions with no side effects, so every rule is unit-tested:
 *
 *   parseBundleJson — trust gate #2 (after the cosign signature): the payload
 *     must be shape-valid, name the version we asked for, and name the SAME
 *     app digest the booth's release record carries. A validly-SIGNED bundle
 *     that fails these is treated as hostile/corrupt, never "best effort".
 *
 *   planInfra — which component pins change, and the ONE hard refusal: a
 *     postgres MAJOR jump (on-disk format change → pg_upgrade runbook, never
 *     automatic).
 *
 * A release with NO bundle at all is legal (pre-bundle releases) — the caller
 * falls back to the app-only update path.
 */

const DIGEST_SHAPE = /^sha256:[0-9a-f]{64}$/;
/**
 * ghcr.io/org/repo — lowercase, no tag/digest, no shell metacharacters, and
 * host-ALLOWLISTED: the bundle is CI-authored + signed and every pin is by
 * digest (a hostile registry can affect availability, never integrity), but
 * narrowing the hosts means a bundle-authoring bug can't point the fleet's
 * pulls at an arbitrary server.
 */
const REPO_SHAPE = /^(ghcr\.io|docker\.io)(\/[a-z0-9._-]+)+$/;

export interface ImagePin {
  readonly repo: string;
  readonly digest: string;
}

export interface BundleManifest {
  readonly version: string;
  readonly postgresMajor: string;
  readonly deploySha256: string;
  readonly images: {
    readonly app: ImagePin;
    readonly updater: ImagePin;
    readonly postgres: ImagePin;
    readonly caddy: ImagePin;
  };
}

type ParseResult =
  | { readonly ok: true; readonly bundle: BundleManifest }
  | { readonly ok: false; readonly error: string };

function pin(v: unknown, name: string): ImagePin | string {
  if (typeof v !== "object" || v === null) return `images.${name} missing`;
  const o = v as { repo?: unknown; digest?: unknown };
  if (typeof o.repo !== "string" || !REPO_SHAPE.test(o.repo)) {
    return `images.${name}.repo malformed`;
  }
  if (typeof o.digest !== "string" || !DIGEST_SHAPE.test(o.digest)) {
    return `images.${name}.digest malformed`;
  }
  return { repo: o.repo, digest: o.digest };
}

/**
 * Validate a bundle.json AGAINST what we independently know: the version we
 * resolved from the booth's release list and that release's app digest. The
 * cross-checks bind the by-tag-fetched bundle to the booth record — a
 * re-tagged (even validly signed) bundle for another version, or one whose
 * app pin disagrees with the booth, is refused.
 */
export function parseBundleJson(
  raw: string,
  expected: { readonly version: string; readonly appDigest: string },
): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "bundle.json is not valid JSON" };
  }
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "bundle.json is not an object" };
  }
  const b = data as Record<string, unknown>;
  if (b["bundle_schema"] !== 1) {
    return { ok: false, error: `unsupported bundle_schema: ${String(b["bundle_schema"])}` };
  }
  if (b["version"] !== expected.version) {
    return {
      ok: false,
      error: `bundle names version ${String(b["version"])}, expected ${expected.version}`,
    };
  }
  if (typeof b["postgres_major"] !== "string" || !/^[0-9]+$/.test(b["postgres_major"])) {
    return { ok: false, error: "postgres_major malformed" };
  }
  if (typeof b["deploy_sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(b["deploy_sha256"])) {
    return { ok: false, error: "deploy_sha256 malformed" };
  }
  const images = b["images"];
  if (typeof images !== "object" || images === null) {
    return { ok: false, error: "images missing" };
  }
  const im = images as Record<string, unknown>;
  const out: Partial<BundleManifest["images"]> = {};
  for (const name of ["app", "updater", "postgres", "caddy"] as const) {
    const p = pin(im[name], name);
    if (typeof p === "string") return { ok: false, error: p };
    (out as Record<string, ImagePin>)[name] = p;
  }
  // NB: an `images.harness` pin (the removed teammate sidecar; pre-removal
  // bundles carry one, so the ROLLBACK TARGET's bundle still does) is
  // deliberately IGNORED, not refused — unknown image entries never block a
  // parse, so an old bundle stays convergeable.
  const appPin = out.app!;
  if (appPin.digest !== expected.appDigest) {
    return {
      ok: false,
      error: `bundle app digest ${appPin.digest} disagrees with the booth record ${expected.appDigest}`,
    };
  }
  return {
    ok: true,
    bundle: {
      version: expected.version,
      postgresMajor: b["postgres_major"],
      deploySha256: b["deploy_sha256"],
      images: out as BundleManifest["images"],
    },
  };
}

/** The env pins the updater reconciles (deploy/.env — compose reads them). */
export const PIN_VARS = {
  app: "BRAIN_IMAGE",
  updater: "BRAIN_UPDATER_IMAGE",
  postgres: "BRAIN_POSTGRES_IMAGE",
  caddy: "BRAIN_CADDY_IMAGE",
} as const;

export type Component = keyof typeof PIN_VARS;

export interface InfraPlan {
  /** components (excluding the updater itself) whose .env pin must change. */
  readonly changed: readonly Exclude<Component, "updater">[];
  /** postgres pin changes → up postgres (wait) BEFORE migrations run. */
  readonly postgresChanged: boolean;
  /** the updater pin changed → self-recreate LAST, after success is persisted. */
  readonly updaterChanged: boolean;
}

type PlanResult =
  { readonly ok: true; readonly plan: InfraPlan } | { readonly ok: false; readonly refuse: string };

export function imageRef(p: ImagePin): string {
  return `${p.repo}@${p.digest}`;
}

/**
 * Diff the bundle against the box's current .env pins. `currentPins` values
 * are the raw .env values (repo@digest) or undefined when unpinned (fresh
 * install pre-bundle, local dev). `runningPgMajor` is read off the live
 * postgres container; null = container absent (nothing to guard).
 */
export function planInfra(
  bundle: BundleManifest,
  currentPins: Readonly<Partial<Record<Component, string>>>,
  runningPgMajor: string | null,
): PlanResult {
  if (runningPgMajor !== null && runningPgMajor !== bundle.postgresMajor) {
    return {
      ok: false,
      refuse:
        `bundle pins postgres major ${bundle.postgresMajor} but the box runs ` +
        `${runningPgMajor} — cross-major swaps are runbook-only (pg_upgrade)`,
    };
  }
  const changed: Exclude<Component, "updater">[] = [];
  for (const c of ["app", "postgres", "caddy"] as const) {
    if (currentPins[c] !== imageRef(bundle.images[c])) changed.push(c);
  }
  return {
    ok: true,
    plan: {
      changed,
      postgresChanged: changed.includes("postgres"),
      updaterChanged: currentPins.updater !== imageRef(bundle.images.updater),
    },
  };
}
