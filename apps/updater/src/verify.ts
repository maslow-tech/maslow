/**
 * Signed-control verification for the updater (the operator restart op).
 *
 * The heartbeat's TOP-LEVEL body is convenience only — it is not signed. Any
 * field that drives a SIDE EFFECT on the box must come out of the Ed25519
 * `control` envelope instead, verified against the booth public key baked into
 * the box's env. Self-contained on node:crypto (like the box's kill-switch
 * client — the canonical JSON must match the booth byte-for-byte).
 *
 * Beyond the signature, the claims are BOUND before they may drive a restart:
 *   - box_id: one fleet-wide signing key means box A's control verifies on
 *     box B; the caller pins the first verified box_id (TOFU) and this module
 *     hands it up so a replayed/misrouted control can't restart the wrong box.
 *   - issued_at freshness: the control rides the very HTTPS response it was
 *     minted for, so a generous window (10 min) costs nothing and kills
 *     long-stale replays.
 *
 * (kill/desired_version may still be read from the body: the kill-switch is
 * enforced by the BOX's own verifying client, and a forged desired_version
 * cannot apply anything — cosign + the anti-rollback floor gate the image.)
 */
import { createPublicKey, verify as edVerify } from "node:crypto";

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

/** What a verified control is allowed to tell the updater. */
export interface VerifiedControl {
  readonly restartGeneration: number;
  /** operator reclaim-disk op: prune old images when this rises past its mark.
   *  0 when an older booth doesn't send it — a no-op, never a surprise prune. */
  readonly pruneGeneration: number;
  /** the box the booth signed this FOR — callers pin it (TOFU) to scope the fleet key. */
  readonly boxId: string;
}

const ISSUED_AT_WINDOW_MS = 10 * 60_000;

/**
 * Extract the operator-op fields from a heartbeat body — ONLY out of a VERIFIED,
 * fresh control envelope. `null` (no op) when the booth key is not configured,
 * the envelope is missing/tampered, the claims are not a control message, or
 * the control is stale. Fail closed: a forged heartbeat can never restart an
 * app, and "cannot verify" is distinguishable from "generation 0" so the
 * caller never adopts a mark it didn't verify.
 */
export function verifiedControl(
  publicKeyPem: string | undefined,
  body: unknown,
  now = Date.now(),
): VerifiedControl | null {
  if (publicKeyPem === undefined) return null;
  if (typeof body !== "object" || body === null) return null;
  const control = (body as { control?: unknown }).control;
  if (typeof control !== "object" || control === null) return null;
  const env = control as { claims?: unknown; sig?: unknown };
  if (!verifyEnvelope(publicKeyPem, { claims: env.claims, sig: env.sig })) return null;
  const claims = env.claims as Record<string, unknown>;
  const gen = claims.restart_generation;
  const issued = claims.issued_at;
  if (claims.kind !== "control" || typeof claims.box_id !== "string") return null;
  if (typeof gen !== "number" || !Number.isFinite(gen) || gen < 0) return null;
  if (typeof issued !== "number" || Math.abs(now - issued) > ISSUED_AT_WINDOW_MS) return null;
  // prune_generation is optional on the wire (older booths omit it) → 0 = no op.
  const pruneGen = claims.prune_generation;
  const pruneGeneration =
    typeof pruneGen === "number" && Number.isFinite(pruneGen) && pruneGen >= 0 ? pruneGen : 0;
  return { restartGeneration: gen, pruneGeneration, boxId: claims.box_id };
}

/**
 * Decode + VALIDATE the booth public key env (base64 of a PEM). `null` on a
 * malformed value — the caller logs loudly, because a bad key would otherwise
 * be indistinguishable from "no restart ops pending" forever (fail-closed
 * verification produces no errors, only silence).
 */
export function decodeBoothPublicKey(b64: string | undefined): string | null {
  if (b64 === undefined || b64 === "") return null;
  try {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    createPublicKey(pem); // throws on garbage — validation, not just decoding
    return pem;
  } catch {
    return null;
  }
}
