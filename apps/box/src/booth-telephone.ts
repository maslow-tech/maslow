import type { ValidateOutcome } from "./kill-switch-client.js";

/**
 * The box→booth telephone transport. POSTs the box's
 * brain token to the booth's `/v1/validate` and returns a ValidateOutcome for
 * the kill-switch state machine. Any non-200 / network error becomes an
 * `{ ok: false }` (the state machine then applies fail-open-within-grace /
 * fail-closed-after). The booth reply body IS the signed lease `{claims, sig}`.
 */
export async function boothValidate(
  boothUrl: string,
  brainToken: string,
  timeoutMs = 4000,
): Promise<ValidateOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${boothUrl.replace(/\/+$/, "")}/v1/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${brainToken}`, "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    if (res.status !== 200) return { ok: false, reason: `status_${res.status}` };
    const lease = (await res.json()) as { claims: unknown; sig: unknown };
    return { ok: true, lease };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
