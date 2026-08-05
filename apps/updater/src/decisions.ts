/**
 * The updater decision logic, kept PURE so it can
 * be exhaustively unit-tested without Docker/registry/DB. Versions are release
 * ordinals (monotonic integers).
 *
 * Rules encoded here:
 *  - one-release stepping (never a multi-version jump);
 *  - anti-rollback floor (refuse desired < current without a signed downgrade);
 *  - the box's monotonic version floor;
 *  - a poisoned-version latch with per-version exponential backoff (H5);
 *  - a multi-sample quiet-window canary verdict over BOTH halves of the box's
 *    /canary (the HTTP write path and the in-process collab room probe) that
 *    separates "broken" (roll back) from "box busy" (retry, no roll back), so a
 *    false-RED canary never restart-storms;
 *  - schema-floor rollback: pick the NEWEST kept image the migrated schema still
 *    supports (min_compatible_app_version), not blindly the previous tag.
 */

export interface StepInput {
  readonly current: number;
  readonly desired: number;
  /** the box's monotonic version floor (no signed-downgrade below this). */
  readonly floor: number;
  readonly signedDowngrade?: boolean;
}

export type StepAction =
  | { readonly action: "hold"; readonly reason: string }
  | { readonly action: "refuse"; readonly reason: string }
  | { readonly action: "apply"; readonly toVersion: number; readonly reason: string };

export function decideStep(input: StepInput): StepAction {
  const { current, desired, floor } = input;
  if (desired === current) return { action: "hold", reason: "up to date" };
  if (desired < current) {
    if (input.signedDowngrade) {
      if (desired < floor) return { action: "refuse", reason: "below the monotonic version floor" };
      return { action: "apply", toVersion: desired, reason: "signed operator downgrade" };
    }
    return {
      action: "refuse",
      reason: "anti-rollback: desired < current without a signed downgrade",
    };
  }
  // moving forward: one release at a time (no multi-version jump)
  const next = current + 1;
  return {
    action: "apply",
    toVersion: next,
    reason: next === desired ? "step to desired" : "one-release step toward desired",
  };
}

// ---- poisoned-version latch + backoff (H5) --------------------------------

export type VersionAttempts = Record<number, number>; // version → failure count

export function isPoisoned(
  attempts: VersionAttempts,
  version: number,
  maxFailures: number,
): boolean {
  return (attempts[version] ?? 0) >= maxFailures;
}

/** Per-version exponential backoff, capped at 1h. */
export function backoffMs(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, failures), 3_600_000);
}

// ---- canary verdict (multi-sample quiet window, H5) ------------------------

export interface CanarySample {
  readonly writeOk: boolean;
  /**
   * The box's in-process COLLAB room probe (`/canary`'s `collabOk`): a release
   * that breaks the websocket surface without breaking HTTP has to be caught
   * here, or a build with broken collab passes the canary and is never rolled
   * back.
   *
   * `undefined` = NOT JUDGED, never a vote either way: an older box's `/canary`
   * has no such field, and a response we could not parse tells us nothing. Only
   * an explicit `false` condemns.
   */
  readonly collabOk?: boolean;
  /** true if the box was under load when sampled (a failure here is inconclusive). */
  readonly busy: boolean;
}

export type CanaryVerdict = "healthy" | "write_broken" | "collab_broken" | "busy";

/**
 * The quiet-window rule, unchanged: only samples taken while the box was NOT
 * busy can condemn a release, and if none of them were quiet the verdict is
 * `busy` (retry, never roll back — a false RED must not restart-storm).
 *
 * Both broken verdicts condemn identically at the call site (updater.ts rolls
 * back on anything that is neither `healthy` nor `busy`); they are separate
 * strings only so the operator log says which half failed. `write_broken`
 * outranks `collab_broken` because a dead write path explains a dead room.
 */
export function canaryVerdict(samples: readonly CanarySample[]): CanaryVerdict {
  const quiet = samples.filter((s) => !s.busy);
  if (quiet.length === 0) return "busy"; // never got a conclusive quiet sample
  if (quiet.some((s) => !s.writeOk)) return "write_broken"; // a quiet failure is real
  if (quiet.some((s) => s.collabOk === false)) return "collab_broken";
  return "healthy";
}

// ---- schema-floor rollback target -----------------------------------------

export interface KeptImage {
  readonly version: number;
  /** the minimum app version the image's schema expectations tolerate. */
  readonly minCompatibleSchema: number;
}

/**
 * The newest kept image whose min-compatible-schema is ≤ the (already-migrated)
 * schema version — never blindly the previous tag.
 */
export function rollbackTarget(kept: readonly KeptImage[], migratedSchema: number): number | null {
  const compatible = kept
    .filter((k) => k.minCompatibleSchema <= migratedSchema)
    .sort((a, b) => b.version - a.version);
  return compatible[0]?.version ?? null;
}
