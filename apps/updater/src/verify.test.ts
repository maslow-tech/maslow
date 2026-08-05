import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, decodeBoothPublicKey, verifiedControl, verifyEnvelope } from "./verify.js";

/** A real Ed25519 keypair + signer, matching the booth's envelope format. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signEnvelope = (claims: unknown) => ({
    claims,
    sig: edSign(null, Buffer.from(canonicalJson(claims), "utf8"), privateKey).toString("base64"),
  });
  return { publicKeyPem, signEnvelope };
}

const NOW = 1_700_000_000_000;
const CONTROL = {
  v: 1,
  kind: "control",
  box_id: "b-1",
  kill_state: "live",
  kill_generation: 0,
  desired_version: null,
  restart_generation: 4,
  prune_generation: 0,
  issued_at: NOW,
};

describe("verify · operator restart op comes ONLY from the signed, fresh, box-bound control", () => {
  it("accepts a properly signed, fresh control and hands up gen + box_id", () => {
    const { publicKeyPem, signEnvelope } = keypair();
    const body = { kill: "live", desired_version: null, control: signEnvelope(CONTROL) };
    expect(verifiedControl(publicKeyPem, body, NOW + 1000)).toEqual({
      restartGeneration: 4,
      pruneGeneration: 0,
      boxId: "b-1",
    });
  });

  it("hands up prune_generation when the signed control carries one", () => {
    const { publicKeyPem, signEnvelope } = keypair();
    const control = signEnvelope({ ...CONTROL, prune_generation: 7 });
    const body = { kill: "live", desired_version: null, control };
    expect(verifiedControl(publicKeyPem, body, NOW + 1000)?.pruneGeneration).toBe(7);
  });

  it("defaults prune_generation to 0 when an older booth omits it (no surprise prune)", () => {
    const { publicKeyPem, signEnvelope } = keypair();
    const { prune_generation: _omit, ...noPrune } = CONTROL;
    const body = { kill: "live", desired_version: null, control: signEnvelope(noPrune) };
    expect(verifiedControl(publicKeyPem, body, NOW + 1000)?.pruneGeneration).toBe(0);
  });

  it("IGNORES unsigned top-level fields — a forged body cannot restart the app", () => {
    const { publicKeyPem } = keypair();
    expect(verifiedControl(publicKeyPem, { restart_generation: 99 }, NOW)).toBeNull();
    expect(
      verifiedControl(
        publicKeyPem,
        {
          restart_generation: 99,
          control: { claims: { ...CONTROL, restart_generation: 99 }, sig: "AAAA" },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("rejects a TAMPERED envelope (claims edited after signing)", () => {
    const { publicKeyPem, signEnvelope } = keypair();
    const env = signEnvelope(CONTROL);
    const tampered = { control: { claims: { ...CONTROL, restart_generation: 99 }, sig: env.sig } };
    expect(verifiedControl(publicKeyPem, tampered, NOW)).toBeNull();
  });

  it("rejects a signature from the WRONG key", () => {
    const theirs = keypair();
    const ours = keypair();
    expect(
      verifiedControl(ours.publicKeyPem, { control: theirs.signEnvelope(CONTROL) }, NOW),
    ).toBeNull();
  });

  it("rejects a STALE control (issued_at outside the freshness window)", () => {
    const { publicKeyPem, signEnvelope } = keypair();
    const body = { control: signEnvelope(CONTROL) };
    expect(verifiedControl(publicKeyPem, body, NOW + 11 * 60_000)).toBeNull(); // replayed later
    expect(verifiedControl(publicKeyPem, body, NOW - 11 * 60_000)).toBeNull(); // from the future
    expect(verifiedControl(publicKeyPem, body, NOW + 9 * 60_000)).not.toBeNull(); // in window
  });

  it("fails closed: no key, malformed claims, missing box_id, negative gen", () => {
    const { publicKeyPem, signEnvelope } = keypair();
    expect(verifiedControl(undefined, { control: signEnvelope(CONTROL) }, NOW)).toBeNull();
    expect(
      verifiedControl(publicKeyPem, { control: signEnvelope({ ...CONTROL, kind: "lease" }) }, NOW),
    ).toBeNull();
    expect(
      verifiedControl(
        publicKeyPem,
        { control: signEnvelope({ ...CONTROL, restart_generation: -1 }) },
        NOW,
      ),
    ).toBeNull();
    const { box_id: _drop, ...noBoxId } = CONTROL;
    expect(verifiedControl(publicKeyPem, { control: signEnvelope(noBoxId) }, NOW)).toBeNull();
    expect(verifiedControl(publicKeyPem, null, NOW)).toBeNull();
  });

  it("verifyEnvelope round-trips and rejects garbage", () => {
    const { publicKeyPem, signEnvelope } = keypair();
    expect(verifyEnvelope(publicKeyPem, signEnvelope({ a: 1 }))).toBe(true);
    expect(verifyEnvelope(publicKeyPem, { claims: { a: 1 }, sig: 42 })).toBe(false);
    expect(verifyEnvelope("not a pem", signEnvelope({ a: 1 }))).toBe(false);
  });

  it("decodeBoothPublicKey validates, not just decodes", () => {
    const { publicKeyPem } = keypair();
    const b64 = Buffer.from(publicKeyPem, "utf8").toString("base64");
    expect(decodeBoothPublicKey(b64)).toBe(publicKeyPem);
    // raw PEM pasted instead of base64 → invalid, NOT silently accepted
    expect(decodeBoothPublicKey(publicKeyPem)).toBeNull();
    expect(decodeBoothPublicKey("!!!not-base64!!!")).toBeNull();
    expect(decodeBoothPublicKey(undefined)).toBeNull();
    expect(decodeBoothPublicKey("")).toBeNull();
  });
});
