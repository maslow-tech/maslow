import type { KeptImage, VersionAttempts } from "./decisions.js";
import type { UpdaterState } from "./updater.js";

/**
 * Version-string ↔ ordinal mapping.
 *
 * The decision library reasons over MONOTONIC INTEGER ordinals; the booth and
 * humans use version strings ("v0.1.0"). The bridge is an INTRINSIC semver
 * ordering of the releases — NOT the booth's list position. This matters for
 * security: `GET /v1/releases` is not signed, so a compromised booth could
 * reorder its response; if ordinals came from list position, reordering would
 * let an old (still validly CI-signed) release masquerade as a forward step and
 * defeat anti-rollback. Sorting by the version tag's own semver makes the order
 * booth-independent. `runtime.ts` adds a second, ordinal-free floor gate on the
 * resolved target as defense in depth. Everything here is pure/unit-tested.
 */

export interface ReleaseEntry {
  readonly version: string;
  readonly imageDigest: string;
  readonly channel: string;
  readonly yanked: boolean;
}

/** What the updater persists across restarts (version STRINGS, never ordinals). */
export interface PersistedState {
  readonly currentVersion: string;
  /** monotonic floor: never signed-downgraded below this. */
  readonly floorVersion: string;
  /** per-version failure counts (poisoned-version latch). */
  readonly attempts: Readonly<Record<string, number>>;
  /** versions whose images are still on disk — rollback candidates. */
  readonly keptVersions: readonly string[];
  /**
   * Last operator restart_generation honored (the operator restart op). Absent
   * on state files written before the restart op existed; the loop then ADOPTS
   * the current generation without restarting, so an updater upgrade never
   * causes a surprise restart.
   */
  readonly honoredRestartGeneration?: number;
  /** Last operator prune_generation honored. Absent → adopt current without
   *  pruning, so shipping this op never triggers a surprise prune. */
  readonly honoredPruneGeneration?: number;
  /**
   * TOFU pin of this box's identity: the box_id from the first VERIFIED
   * control. One fleet-wide signing key means another box's control verifies
   * here too — the pin is what stops a replayed cross-box control from
   * restarting (or mark-poisoning) this box.
   */
  readonly boxId?: string;
  /**
   * Swap journal (replay-safe rollback): the version whose swap is in
   * flight, persisted just before the point-of-no-return (the image pin).
   * Present at tick start = a previous tick died mid-swap; the loop then
   * counts the failed attempt (so the poisoned-version latch still engages
   * across crashes) and heals the pin back to `currentVersion`.
   */
  readonly attempting?: string;
  /** transient verify-defer counts, version-keyed. Separate from `attempts` —
   *  never feeds the poison latch. Emitted only when
   *  non-empty (keeps state files minimal + back-compatible). */
  readonly verifyDeferrals?: Readonly<Record<string, number>>;
}

// ---- intrinsic semver order (booth-independent) -----------------------------

/** [major, minor, patch, prereleaseRank] — a FINAL release ranks 1, a pre-release 0. */
export type Semver = readonly [number, number, number, number];

/**
 * Parse `vMAJOR.MINOR.PATCH` with an OPTIONAL pre-release suffix. The whole tag
 * must match (anchored) — a looser string returns null so the caller can skip
 * it. Pre-release ordering is coarse-but-correct for anti-rollback: any
 * `-suffix` ranks BELOW the same final release (semver §11), so a `-rc` build is
 * never treated as newer than — or equal to — its final release.
 */
export function parseSemver(version: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(version);
  if (m === null) return null;
  const prereleaseRank = m[4] === undefined ? 1 : 0;
  return [Number(m[1]), Number(m[2]), Number(m[3]), prereleaseRank];
}

export function compareSemver(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

/** True iff a's version tag orders strictly below b's. Unparseable → false (safe). */
export function isBelow(aVersion: string, bVersion: string): boolean {
  const a = parseSemver(aVersion);
  const b = parseSemver(bVersion);
  if (a === null || b === null) return false;
  return compareSemver(a, b) < 0;
}

/**
 * The canonical, steppable release order: releases sorted by intrinsic semver,
 * with YANKED releases removed (except the one the box is currently running, so
 * it can still be located and stepped OFF). A release with an unparseable
 * version is SKIPPED, not fatal — one malformed publish must not freeze the
 * whole channel. (The booth also rejects non-semver tags at publish, so in
 * practice this only guards a legacy/hand-inserted row.) Returns null only if
 * the box's OWN current version can't be parsed — then it can't be placed.
 */
export function canonicalOrder(
  releases: readonly ReleaseEntry[],
  currentVersion: string,
): readonly ReleaseEntry[] | null {
  if (parseSemver(currentVersion) === null) return null;
  const kept = releases.filter((r) => !r.yanked || r.version === currentVersion);
  const decorated: { rel: ReleaseEntry; sv: Semver }[] = [];
  for (const rel of kept) {
    const sv = parseSemver(rel.version);
    if (sv !== null) decorated.push({ rel, sv });
  }
  decorated.sort((x, y) => compareSemver(x.sv, y.sv) || x.rel.version.localeCompare(y.rel.version));
  return decorated.map((d) => d.rel);
}

// ---- ordinal helpers over a canonical list ----------------------------------

/** 1-based position of a version in an already-canonical list, or null. */
export function ordinalOf(canonical: readonly ReleaseEntry[], version: string): number | null {
  const i = canonical.findIndex((r) => r.version === version);
  return i === -1 ? null : i + 1;
}

/**
 * Parse + SHAPE-CHECK a persisted state file. A truncated/invalid file throws
 * via JSON.parse (routed to main's idle path). Then reject JSON `null` and any
 * malformed-but-valid-JSON body (missing/blank core fields) — the blind cast it
 * replaces let a `null` body fall through to a silent re-bootstrap/downgrade.
 * Returns the PARSED OBJECT AS-IS so the optional fields (attempting, boxId,
 * honored*Generation) survive — reconstructing a 4-field literal would drop them
 * and reopen the journal bypass / TOFU reset / re-fire a shipped op.
 */
export function parsePersistedState(raw: string): PersistedState {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `persisted state is not a plain object (got ${parsed === null ? "null" : typeof parsed})`,
    );
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.currentVersion !== "string" || o.currentVersion.length === 0)
    throw new Error("persisted state: currentVersion must be a non-empty string");
  if (typeof o.floorVersion !== "string" || o.floorVersion.length === 0)
    throw new Error("persisted state: floorVersion must be a non-empty string");
  if (typeof o.attempts !== "object" || o.attempts === null || Array.isArray(o.attempts))
    throw new Error("persisted state: attempts must be a plain object");
  if (!Array.isArray(o.keptVersions))
    throw new Error("persisted state: keptVersions must be an array");
  return parsed as PersistedState;
}

/**
 * If `currentVersion` has vanished from the release list (e.g. its booth row was
 * deleted) but the box is running it, synthesize its entry at the correct semver
 * position with the running app's real digest, so the box isn't stalled by a
 * missing self. Caller MUST gate this on `attempting === undefined` and a
 * validated digest — see runtime.ts. No-op when the version is already present.
 */
export function ensureCurrent(
  canonical: readonly ReleaseEntry[],
  currentVersion: string,
  currentDigest: string,
): readonly ReleaseEntry[] {
  if (canonical.some((r) => r.version === currentVersion)) return canonical;
  if (parseSemver(currentVersion) === null) return canonical;
  const out = [
    ...canonical,
    { version: currentVersion, imageDigest: currentDigest, channel: "", yanked: false },
  ];
  out.sort((x, y) => {
    const a = parseSemver(x.version);
    const b = parseSemver(y.version);
    if (a === null || b === null) return x.version.localeCompare(y.version);
    return compareSemver(a, b) || x.version.localeCompare(y.version);
  });
  return out;
}

export function releaseAt(
  canonical: readonly ReleaseEntry[],
  ordinal: number,
): ReleaseEntry | null {
  return canonical[ordinal - 1] ?? null;
}

/**
 * The desired ordinal for this tick. A null/unknown/yanked desired version
 * holds at current (a booth that forgot us — or advertises an unpublished or
 * yanked version — must not stall OR surprise-update the box).
 */
export function desiredOrdinal(
  canonical: readonly ReleaseEntry[],
  desiredVersion: string | null,
  currentOrdinal: number,
): { readonly ordinal: number; readonly held: boolean } {
  if (desiredVersion === null) return { ordinal: currentOrdinal, held: true };
  const ord = ordinalOf(canonical, desiredVersion);
  if (ord === null) return { ordinal: currentOrdinal, held: true };
  return { ordinal: ord, held: false };
}

/**
 * Persisted strings → the library's ordinal state, over a canonical order.
 * Returns an error instead of guessing when the current version is not in the
 * canonical list — updating from an unknown baseline is how a box bricks itself.
 * NB: floor is NOT clamped to current (that would make a signed downgrade
 * unreachable); it maps the persisted floorVersion independently.
 */
export function toLibState(
  persisted: PersistedState,
  canonical: readonly ReleaseEntry[],
):
  | { readonly ok: true; readonly state: UpdaterState }
  | { readonly ok: false; readonly error: string } {
  const current = ordinalOf(canonical, persisted.currentVersion);
  if (current === null) {
    return {
      ok: false,
      error: `current version ${persisted.currentVersion} is not in the canonical release list`,
    };
  }
  const floorOrd = ordinalOf(canonical, persisted.floorVersion);
  const attempts: Record<number, number> = {};
  for (const [version, count] of Object.entries(persisted.attempts)) {
    const ord = ordinalOf(canonical, version);
    if (ord !== null) attempts[ord] = count;
  }
  const deferrals: Record<number, number> = {};
  for (const [version, count] of Object.entries(persisted.verifyDeferrals ?? {})) {
    const ord = ordinalOf(canonical, version);
    if (ord !== null) deferrals[ord] = count;
  }
  // Conservative schema expectation: an image needs its own release's schema.
  // Combined with expand→contract ("behavioral changes lag columns by a
  // release"), a one-release-back image is always compatible with the
  // one-release-forward schema — which is exactly the rollback the loop takes.
  const kept: KeptImage[] = [];
  for (const version of persisted.keptVersions) {
    const ord = ordinalOf(canonical, version);
    if (ord !== null) kept.push({ version: ord, minCompatibleSchema: ord });
  }
  return {
    ok: true,
    state: {
      current,
      floor: floorOrd ?? 1,
      attempts: attempts as VersionAttempts,
      deferrals: deferrals as VersionAttempts,
      kept,
    },
  };
}

/** The library's ordinal state → persisted strings. Floor is the semver high-water mark. */
export function fromLibState(
  state: UpdaterState,
  canonical: readonly ReleaseEntry[],
  prev: PersistedState,
): PersistedState {
  const currentVersion = releaseAt(canonical, state.current)?.version ?? prev.currentVersion;
  // The floor only ever RISES, and only to a version we have actually run — so a
  // reordered/omitted booth list can never lower it below where we've been.
  const floorVersion = isBelow(prev.floorVersion, currentVersion)
    ? currentVersion
    : prev.floorVersion;
  const attempts: Record<string, number> = {};
  for (const [ord, count] of Object.entries(state.attempts)) {
    const version = releaseAt(canonical, Number(ord))?.version;
    if (version !== undefined) attempts[version] = count;
  }
  const verifyDeferrals: Record<string, number> = {};
  for (const [ord, count] of Object.entries(state.deferrals)) {
    const version = releaseAt(canonical, Number(ord))?.version;
    if (version !== undefined) verifyDeferrals[version] = count;
  }
  const keptVersions = state.kept
    .map((k) => releaseAt(canonical, k.version)?.version)
    .filter((v): v is string => v !== undefined);
  // The image we now run is always a rollback candidate; keep at most the
  // newest two (by semver) so disk + choice both stay bounded.
  const withCurrent = [...new Set([...keptVersions, currentVersion])]
    .sort((a, b) => (isBelow(a, b) ? 1 : -1))
    .slice(0, 2);
  // Operator-op fields the lib doesn't model round-trip from `prev` HERE — the one
  // place lib-state becomes persisted state — so no caller can silently drop
  // them. (`attempting` deliberately does NOT round-trip: reaching this line
  // means the tick completed, which is exactly what clears the swap journal.)
  return {
    currentVersion,
    floorVersion,
    attempts,
    keptVersions: withCurrent,
    ...(Object.keys(verifyDeferrals).length > 0 ? { verifyDeferrals } : {}),
    ...(prev.honoredRestartGeneration !== undefined
      ? { honoredRestartGeneration: prev.honoredRestartGeneration }
      : {}),
    ...(prev.honoredPruneGeneration !== undefined
      ? { honoredPruneGeneration: prev.honoredPruneGeneration }
      : {}),
    ...(prev.boxId !== undefined ? { boxId: prev.boxId } : {}),
  };
}
