import {
  backoffMs,
  canaryVerdict,
  decideStep,
  isPoisoned,
  rollbackTarget,
  type CanarySample,
  type KeptImage,
  type VersionAttempts,
} from "./decisions.js";

/**
 * The updater loop. A separate, independently-versioned component that
 * polls the booth and drives one release step at a time:
 *   verify signature+provenance → pull-by-digest → migrate → restart →
 *   write-canary → schema-floor rollback on a broken write path → report.
 * All side effects go through injected adapters so the whole loop is testable.
 */

export interface Heartbeat {
  readonly desiredVersion: number;
  readonly kill: "live" | "off";
  readonly schemaFloor: number;
  readonly signedDowngrade?: boolean;
}

/**
 * A verify outcome. DEFINITIVE failures (transient:
 * false) poison the version toward the latch — a truly bad release must stop.
 * TRANSIENT failures (transient: true — a cosign/registry/Sigstore outage) DEFER:
 * they retry forever and NEVER latch, because a box that can't verify simply
 * stays on its known-good version. The default for an UNKNOWN throw is DEFINITIVE
 * (latch loudly) so a programming bug or hostile payload never loops forever.
 */
export type VerifyResult = { ok: true } | { ok: false; transient: boolean };

export interface UpdaterAdapters {
  heartbeat(): Promise<Heartbeat>;
  /** signature + SLSA provenance verification (verify key baked in the image). */
  verify(version: number): Promise<VerifyResult>;
  pullByDigest(version: number): Promise<void>;
  /** apply migrations; returns the resulting schema version. */
  migrate(version: number): Promise<{ schemaVersion: number }>;
  restart(): Promise<void>;
  writeCanary(): Promise<readonly CanarySample[]>;
  rollbackApp(version: number): Promise<void>;
  report(outcome: UpdateOutcome): Promise<void>;
  /**
   * Reclaim superseded images after a successful swap so the box disk can't
   * fill and silently wedge future updates (a full disk fails `docker pull`
   * and the box stalls one version behind). Optional + best-effort by
   * contract — it never runs on a failed swap and never fails the update.
   */
  pruneImages?(): Promise<void>;
}

export type UpdateOutcome =
  | { kind: "up_to_date" }
  | { kind: "refused"; reason: string }
  | { kind: "latched"; version: number }
  | { kind: "verify_failed"; version: number }
  | { kind: "verify_deferred"; version: number }
  | { kind: "applied"; version: number }
  | { kind: "busy_retry"; version: number }
  | { kind: "rolled_back"; from: number; to: number | null };

export interface UpdaterState {
  readonly current: number;
  readonly floor: number;
  readonly attempts: VersionAttempts;
  /** transient verify-defer counts, SEPARATE from `attempts` — never feeds
   *  isPoisoned, so an outage retries forever without ever latching. */
  readonly deferrals: VersionAttempts;
  readonly kept: readonly KeptImage[];
  readonly latchedVersion?: number;
}

export interface UpdaterPolicy {
  readonly maxFailuresBeforeLatch: number;
}

export const DEFAULT_POLICY: UpdaterPolicy = { maxFailuresBeforeLatch: 3 };

function bumpFailure(attempts: VersionAttempts, version: number): VersionAttempts {
  return { ...attempts, [version]: (attempts[version] ?? 0) + 1 };
}
function clearFailure(attempts: VersionAttempts, version: number): VersionAttempts {
  const next = { ...attempts };
  delete next[version];
  return next;
}
// deferrals share the shape but are tracked/cleared separately from attempts.
const bumpDeferral = bumpFailure;
const clearDeferral = clearFailure;

export class Updater {
  constructor(
    private readonly adapters: UpdaterAdapters,
    private readonly policy: UpdaterPolicy = DEFAULT_POLICY,
  ) {}

  /** One poll → decision → (maybe) apply. Returns the next state + the outcome. */
  async tick(state: UpdaterState): Promise<{ state: UpdaterState; outcome: UpdateOutcome }> {
    const hb = await this.adapters.heartbeat();
    // (The kill-switch gates request surfaces elsewhere; the updater still polls.)

    const decision = decideStep({
      current: state.current,
      desired: hb.desiredVersion,
      floor: Math.max(state.floor, hb.schemaFloor),
      ...(hb.signedDowngrade !== undefined ? { signedDowngrade: hb.signedDowngrade } : {}),
    });

    if (decision.action === "hold") {
      const outcome: UpdateOutcome = { kind: "up_to_date" };
      await this.adapters.report(outcome);
      return { state, outcome };
    }
    if (decision.action === "refuse") {
      const outcome: UpdateOutcome = { kind: "refused", reason: decision.reason };
      await this.adapters.report(outcome);
      return { state, outcome };
    }

    const v = decision.toVersion;
    if (isPoisoned(state.attempts, v, this.policy.maxFailuresBeforeLatch)) {
      const outcome: UpdateOutcome = { kind: "latched", version: v };
      await this.adapters.report(outcome);
      return { state: { ...state, latchedVersion: v }, outcome };
    }

    const vr = await this.adapters.verify(v);
    if (!vr.ok && vr.transient) {
      // TRANSIENT (cosign/registry/Sigstore outage): DEFER — retry next poll,
      // NEVER bump attempts, NEVER latch. The box stays on its known-good
      // version; the deferral count drives loud "stalled" observability + backoff.
      const outcome: UpdateOutcome = { kind: "verify_deferred", version: v };
      await this.adapters.report(outcome);
      return { state: { ...state, deferrals: bumpDeferral(state.deferrals, v) }, outcome };
    }
    if (!vr.ok) {
      // DEFINITIVE (bad signature / structural): poison toward the latch.
      const outcome: UpdateOutcome = { kind: "verify_failed", version: v };
      await this.adapters.report(outcome);
      return {
        state: {
          ...state,
          attempts: bumpFailure(state.attempts, v),
          deferrals: clearDeferral(state.deferrals, v),
        },
        outcome,
      };
    }

    await this.adapters.pullByDigest(v);
    const { schemaVersion } = await this.adapters.migrate(v);
    await this.adapters.restart();
    const verdict = canaryVerdict(await this.adapters.writeCanary());

    if (verdict === "healthy") {
      const outcome: UpdateOutcome = { kind: "applied", version: v };
      await this.adapters.report(outcome);
      // Only place a prune belongs: a swap just succeeded, so the images it
      // superseded are now safe to reclaim. Best-effort — try/catch (not
      // .catch) so a SYNCHRONOUS throw from the adapter is swallowed too; a
      // prune failure must never turn an applied swap into anything else.
      try {
        await this.adapters.pruneImages?.();
      } catch {
        /* prune is best-effort; never fail the applied swap */
      }
      return {
        state: {
          ...state,
          current: v,
          attempts: clearFailure(state.attempts, v),
          deferrals: clearDeferral(state.deferrals, v),
        },
        outcome,
      };
    }

    if (verdict === "busy") {
      // false-RED: do NOT roll back or bump the failure counter (no restart-storm).
      const outcome: UpdateOutcome = { kind: "busy_retry", version: v };
      await this.adapters.report(outcome);
      return { state, outcome };
    }

    // write_broken | collab_broken → roll the app back to the newest
    // schema-compatible kept image. Both are real post-swap breakage: a dead
    // write path or a dead collab room surface each condemn the release.
    const to = rollbackTarget(state.kept, schemaVersion);
    await this.adapters.rollbackApp(to ?? state.current);
    const outcome: UpdateOutcome = { kind: "rolled_back", from: v, to };
    await this.adapters.report(outcome);
    return {
      state: {
        ...state,
        current: to ?? state.current,
        attempts: bumpFailure(state.attempts, v),
      },
      outcome,
    };
  }
}

export { backoffMs };
