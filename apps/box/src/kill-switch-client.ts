/**
 * Box-side kill-switch client.
 *
 * This is the security-critical half of the telephone: it verifies the booth's
 * signed liveness lease and decides whether the box may serve. It is a pure,
 * self-contained state machine (no imports from other apps/box files; only
 * `node:crypto`) so it is fully unit-testable with an injected clock and injected
 * booth responses. The parent wires it into the request path; this file never
 * does I/O.
 *
 * The rules, and where each lives:
 *  - **Fail-CLOSED only on an explicit `off`.** `applyLease`: a verified `off`
 *    lease → block, always (even if the lease is otherwise expired).
 *  - **Fail-OPEN on *unreachable* for a G = 6h grace window.** `applyUnreachable`
 *    / `grace`: no fresh live lease → allow only while `now < grace_deadline`.
 *  - **A received `off` is sticky (persisted).** `sticky_off` latches and is only
 *    cleared by a strictly-newer-generation live signal (an operator re-enable).
 *  - **Boots fail-closed if the last-verified lease is stale.** `bootDecision`
 *    runs the grace check against persisted state before any network call.
 *  - **The dead-man is strictly monotonic (an NTP rollback can't extend it).**
 *    Every evaluation advances `max_wall_seen`; the effective clock is
 *    `max(now, max_wall_seen)`, so a backward jump can never push the deadline
 *    out. The caller MUST persist the returned state after every evaluation.
 *  - **Signed per-flip with a `kill_generation` counter (bounds replay).** A
 *    signal whose generation is below the highest seen is rejected as a replay,
 *    so a captured older-generation *live* lease can never override a newer flip.
 *  - **Monotonic version floor (no signed-downgrade)** + update-starvation alarm:
 *    `updateVersionFloor` / `updateStarvationAlarm`.
 */
import { Buffer } from "node:buffer";
import { createPublicKey, verify as edVerify } from "node:crypto";

export type KillState = "live" | "off";
export type Decision = "allow" | "block";

/** The signed liveness lease from `/v1/validate` (mirror of the booth's type). */
export interface LeaseClaims {
  readonly v: 1;
  readonly kind: "lease";
  readonly box_id: string;
  readonly kill_state: KillState;
  readonly kill_generation: number;
  readonly issued_at: number;
  readonly expires_at: number;
}

/** The signed control from `/v1/heartbeat`. */
export interface ControlClaims {
  readonly v: 1;
  readonly kind: "control";
  readonly box_id: string;
  readonly kill_state: KillState;
  readonly kill_generation: number;
  readonly desired_version: string | null;
  readonly issued_at: number;
}

export interface Signed<TClaims> {
  readonly claims: TClaims;
  readonly sig: string;
}
export type SignedLease = Signed<LeaseClaims>;
export type SignedControl = Signed<ControlClaims>;

/** Persisted across reboots (e.g. a small on-disk file). Treat as opaque. */
export interface KillClientState {
  /** a received `off` latches this; only a newer-generation live clears it. */
  readonly sticky_off: boolean;
  /** highest verified generation seen — the replay floor. */
  readonly generation: number;
  /** effective-now after which, with no fresh live lease, the box fails closed. */
  readonly grace_deadline: number | null;
  /** monotonic guard: the clock never runs backwards below this. */
  readonly max_wall_seen: number;
  /** last effective-now at which a fresh live lease was verified. */
  readonly last_verified_live_at: number | null;
  /** monotonic version floor (anti-signed-downgrade). */
  readonly version_floor: string | null;
  /**
   * TOFU-pinned box_id: set from the FIRST valid lease/control this box
   * ever accepts, then persisted. One fleet-wide booth signing key means a
   * genuine lease minted for a DIFFERENT box would otherwise verify here — the
   * pin binds every subsequent signal to THIS box, so a cross-box replay can't
   * un-kill it. Mirrors the updater's `state.boxId` TOFU (runtime.ts).
   */
  readonly pinned_box_id: string | null;
}

export interface KillClientConfig {
  /** booth public key (baked into the image), SPKI PEM. */
  readonly publicKeyPem: string;
  /** fail-open grace window on unreachable. Default G = 6h. */
  readonly graceMs?: number;
}

export const GRACE_MS_DEFAULT = 6 * 60 * 60 * 1000; // G = 6h

export function initialKillState(): KillClientState {
  return {
    sticky_off: false,
    generation: 0,
    grace_deadline: null,
    max_wall_seen: 0,
    version_floor: null,
    last_verified_live_at: null,
    pinned_box_id: null,
  };
}

export interface Evaluation {
  readonly state: KillClientState;
  readonly decision: Decision;
  readonly reason: string;
}

// ---- crypto (self-contained; must match the booth byte-for-byte) -----------

/** Deterministic JSON: sorted keys, arrays in order, no insignificant space. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** Verify a `{claims, sig}` Ed25519 envelope. False on any error (fail-closed). */
export function verifyEnvelope(
  publicKeyPem: string,
  env: { claims: unknown; sig: unknown },
): boolean {
  try {
    if (typeof env.sig !== "string") return false;
    const key = createPublicKey(publicKeyPem);
    const bytes = Buffer.from(canonicalJson(env.claims), "utf8");
    const sig = Buffer.from(env.sig, "base64");
    return edVerify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

function isLeaseClaims(x: unknown): x is LeaseClaims {
  if (typeof x !== "object" || x === null) return false;
  const c = x as Record<string, unknown>;
  return (
    c.kind === "lease" &&
    typeof c.box_id === "string" &&
    (c.kill_state === "live" || c.kill_state === "off") &&
    typeof c.kill_generation === "number" &&
    Number.isFinite(c.kill_generation) &&
    typeof c.expires_at === "number" &&
    Number.isFinite(c.expires_at)
  );
}

function isControlClaims(x: unknown): x is ControlClaims {
  if (typeof x !== "object" || x === null) return false;
  const c = x as Record<string, unknown>;
  return (
    c.kind === "control" &&
    typeof c.box_id === "string" &&
    (c.kill_state === "live" || c.kill_state === "off") &&
    typeof c.kill_generation === "number" &&
    Number.isFinite(c.kill_generation)
  );
}

// ---- the state machine -----------------------------------------------------

/** Advance the monotonic clock guard; return the effective now + base state. */
function tick(state: KillClientState, now: number): { eNow: number; base: KillClientState } {
  const eNow = Math.max(now, state.max_wall_seen);
  return { eNow, base: { ...state, max_wall_seen: eNow } };
}

/**
 * The decision when there is NO fresh live lease (unreachable / expired /
 * tampered / replay). Sticky-off always blocks; otherwise fail-open only while
 * still inside the grace window measured on the monotonic clock.
 */
function grace(base: KillClientState, eNow: number, reason: string): Evaluation {
  if (base.sticky_off) return { state: base, decision: "block", reason: `${reason}+sticky_off` };
  if (base.grace_deadline !== null && eNow < base.grace_deadline) {
    return { state: base, decision: "allow", reason: `${reason}+within_grace` };
  }
  return { state: base, decision: "block", reason: `${reason}+grace_expired` };
}

/**
 * Apply a lease fetched from `/v1/validate`. The heart of the kill switch.
 */
export function applyLease(
  state: KillClientState,
  lease: { claims: unknown; sig: unknown },
  cfg: KillClientConfig,
  now: number,
): Evaluation {
  const graceMs = cfg.graceMs ?? GRACE_MS_DEFAULT;
  const { eNow, base } = tick(state, now);

  if (!verifyEnvelope(cfg.publicKeyPem, lease)) return grace(base, eNow, "tampered");
  if (!isLeaseClaims(lease.claims)) return grace(base, eNow, "malformed");
  const claims = lease.claims;

  // Cross-box replay: once pinned (TOFU), a validly-signed lease minted for a
  // DIFFERENT fleet box (same booth key) is rejected — it must never move this
  // box's state (e.g. un-kill it). First contact pins below and proceeds.
  if (base.pinned_box_id !== null && claims.box_id !== base.pinned_box_id) {
    return grace(base, eNow, "foreign_box_id");
  }

  // Replay: an older-generation signal can never move the state.
  if (claims.kill_generation < base.generation) {
    return grace(base, eNow, "replay_old_generation");
  }

  // An explicit off is honoured unconditionally and latches sticky-off.
  if (claims.kill_state === "off") {
    const next: KillClientState = {
      ...base,
      sticky_off: true,
      generation: claims.kill_generation,
      pinned_box_id: claims.box_id,
    };
    return { state: next, decision: "block", reason: "off" };
  }

  // Live, but only a NON-EXPIRED live lease proves liveness. An expired live
  // lease (e.g. a replay of the last one the box ever saw) can extend life by at
  // most the grace window, never indefinitely.
  if (claims.expires_at <= eNow) {
    return grace(base, eNow, "expired_lease");
  }

  const next: KillClientState = {
    ...base,
    sticky_off: false,
    generation: claims.kill_generation,
    grace_deadline: eNow + graceMs,
    last_verified_live_at: eNow,
    pinned_box_id: claims.box_id,
  };
  return { state: next, decision: "allow", reason: "live" };
}

/** Booth unreachable / 500 / timeout / malformed HTTP: fall to the grace check. */
export function applyUnreachable(
  state: KillClientState,
  _cfg: KillClientConfig,
  now: number,
  reason = "unreachable",
): Evaluation {
  const { eNow, base } = tick(state, now);
  return grace(base, eNow, reason);
}

/** Outcome of a validate attempt (transport is the caller's concern). */
export type ValidateOutcome =
  | { readonly ok: true; readonly lease: { claims: unknown; sig: unknown } }
  | { readonly ok: false; readonly reason?: string };

/** Single entry point per validate cycle: dispatch on reachability. */
export function handleValidateOutcome(
  state: KillClientState,
  outcome: ValidateOutcome,
  cfg: KillClientConfig,
  now: number,
): Evaluation {
  return outcome.ok
    ? applyLease(state, outcome.lease, cfg, now)
    : applyUnreachable(state, cfg, now, outcome.reason ?? "unreachable");
}

/**
 * The boot-time gate: decide BEFORE any network call, from persisted state.
 * A stale last-verified lease (grace already expired) or a sticky-off both fail
 * closed — a reboot into blocked egress cannot resurrect a killed box.
 */
export function bootDecision(
  state: KillClientState,
  _cfg: KillClientConfig,
  now: number,
): Evaluation {
  const { eNow, base } = tick(state, now);
  return grace(base, eNow, "boot");
}

/**
 * Apply a heartbeat control (`{kill, desired_version}`). Latches sticky-off,
 * advances the generation, and updates the version floor. It does NOT refresh
 * the liveness grace window — only a fresh validate lease can do that (so a
 * replayed heartbeat cannot keep a box alive).
 */
export function applyControl(
  state: KillClientState,
  control: { claims: unknown; sig: unknown },
  cfg: KillClientConfig,
  now: number,
): {
  state: KillClientState;
  decision: Decision;
  accepted: boolean;
  desiredVersion: string | null;
} {
  const { eNow, base } = tick(state, now);

  const reject = (): {
    state: KillClientState;
    decision: Decision;
    accepted: boolean;
    desiredVersion: string | null;
  } => ({
    state: base,
    decision: base.sticky_off ? "block" : "allow",
    accepted: false,
    desiredVersion: null,
  });

  if (!verifyEnvelope(cfg.publicKeyPem, control)) return reject();
  if (!isControlClaims(control.claims)) return reject();
  const claims = control.claims;
  // Cross-box replay: reject a validly-signed control minted for another box
  // once we've pinned (TOFU) — same bind as applyLease. First contact pins.
  if (base.pinned_box_id !== null && claims.box_id !== base.pinned_box_id) return reject();
  if (claims.kill_generation < base.generation) return reject();

  if (claims.kill_state === "off") {
    const next: KillClientState = {
      ...base,
      sticky_off: true,
      generation: claims.kill_generation,
      pinned_box_id: claims.box_id,
    };
    return {
      state: next,
      decision: "block",
      accepted: true,
      desiredVersion: claims.desired_version,
    };
  }

  // live control at >= generation: an operator re-enable clears sticky-off, but
  // the box still needs a fresh lease before it actually serves.
  const floor = updateVersionFloor(base.version_floor, claims.desired_version);
  const next: KillClientState = {
    ...base,
    sticky_off: false,
    generation: claims.kill_generation,
    version_floor: floor,
    pinned_box_id: claims.box_id,
  };
  return {
    state: next,
    decision: next.grace_deadline !== null && next.grace_deadline > eNow ? "allow" : "block",
    accepted: true,
    desiredVersion: claims.desired_version,
  };
}

// ---- version floor + update-starvation -------------------------------------

/** Parse a dotted numeric version into a comparable tuple. Non-numeric → null. */
function parseVersion(v: string): number[] | null {
  const parts = v.split(".");
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return nums.length > 0 ? nums : null;
}

/** -1 | 0 | 1, or null if either side is non-comparable. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Monotonic floor: never lowers. A signed-downgrade attempt is ignored. */
export function updateVersionFloor(floor: string | null, candidate: string | null): string | null {
  if (candidate === null) return floor;
  if (floor === null) return candidate;
  const cmp = compareVersions(candidate, floor);
  // keep the higher; if non-comparable, keep the existing floor (fail-safe).
  return cmp === 1 ? candidate : floor;
}

/** True if `desired < floor` — a downgrade the box must refuse. */
export function isSignedDowngrade(floor: string | null, desired: string | null): boolean {
  if (floor === null || desired === null) return false;
  return compareVersions(desired, floor) === -1;
}

/**
 * Update-starvation alarm: a compromised booth stealth-freezing the fleet on a
 * vulnerable version shows up as `desired_version` lagging the published latest
 * for too long. Returns true once the lag has persisted past `maxLagMs`.
 */
export function updateStarvationAlarm(input: {
  readonly desiredVersion: string | null;
  readonly publishedLatest: string | null;
  readonly laggingSince: number | null;
  readonly now: number;
  readonly maxLagMs: number;
}): boolean {
  const { desiredVersion, publishedLatest, laggingSince, now, maxLagMs } = input;
  if (desiredVersion === null || publishedLatest === null) return false;
  const cmp = compareVersions(desiredVersion, publishedLatest);
  if (cmp === null || cmp >= 0) return false; // not behind
  if (laggingSince === null) return false;
  return now - laggingSince >= maxLagMs;
}
