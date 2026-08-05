import { createHash } from "node:crypto";

/**
 * Outbound-email confirm gate + send-path detection.
 *
 * HONEST SCOPE: the confirm token is a human-surfacing SPEED BUMP, not an
 * injection boundary — a determined autonomous injection can read the token
 * from the preview and re-call (a two-shot exfil). Its real value is (a)
 * consolidation (no raw-proxy send bypass on either provider) and (b) forcing
 * outbound content into a human-reviewable preview + an audit record. True
 * protection against autonomous two-shot exfil needs out-of-band owner approval.
 */

/** Normalize a recipient list: lowercase, trim, drop blanks, sort (order- and
 *  cc-drift-proof). A missing list is treated identically to an empty one. */
function normRecipients(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return arr
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter(Boolean)
    .sort();
}

/**
 * A content-bound confirm token over the exact fields that will be sent. Uses a
 * JSON-canonical form (sorted/normalized recipients, absent === null) so cc
 * reordering or absent-vs-empty can't drift the token, and any change to
 * to/cc/subject/text yields a different token.
 */
export function sendToken(fields: {
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  text?: unknown;
}): string {
  const canonical = JSON.stringify({
    to: normRecipients(fields.to),
    cc: normRecipients(fields.cc),
    subject: typeof fields.subject === "string" ? fields.subject : null,
    text: typeof fields.text === "string" ? fields.text : null,
  });
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 12);
}

/** Pull recipients/subject/body-preview out of a Graph sendMail/message payload,
 *  defensively (never throws on an odd shape). */
export function graphSendPreview(body: unknown): {
  to: string[];
  cc: string[];
  subject: string | null;
  text: string | null;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const msg = (b.message ?? b) as Record<string, unknown>;
  const addrs = (list: unknown): string[] =>
    Array.isArray(list)
      ? list
          .map((r) => {
            const a = (r as Record<string, unknown>)?.emailAddress as
              Record<string, unknown> | undefined;
            return typeof a?.address === "string" ? a.address : "";
          })
          .filter(Boolean)
      : [];
  const content = (msg.body as Record<string, unknown>)?.content;
  return {
    to: addrs(msg.toRecipients),
    cc: addrs(msg.ccRecipients),
    subject: typeof msg.subject === "string" ? msg.subject : null,
    text: typeof content === "string" ? content.slice(0, 500) : null,
  };
}

/** The confirm token for a Graph sendMail/message payload. */
export function graphSendToken(body: unknown): string {
  const p = graphSendPreview(body);
  return sendToken({ to: p.to, cc: p.cc, subject: p.subject, text: p.text });
}

/** Normalize a path via new URL (the SAME normalization google/microsoftApi use)
 *  so `messages/../messages/send`, double slashes, and %2e can't dodge the regex. */
function normPath(path: string): string {
  try {
    return new URL(path, "https://x.invalid").pathname.toLowerCase();
  } catch {
    return String(path).toLowerCase();
  }
}

/** A Gmail SEND-shaped path (the convenience send the raw proxy must refuse). */
export function isGmailSendPath(path: string): boolean {
  const p = normPath(path);
  return /\/messages\/send$|\/drafts\/send$/.test(p);
}

/** A Graph SEND-shaped path (sendMail, or messages/{id}/send). */
export function isGraphSendPath(path: string): boolean {
  const p = normPath(path);
  return /\/sendmail$|\/messages\/[^/]+\/send$/.test(p);
}

/** The standard pending_confirmation envelope: nothing was sent; the agent
 *  re-calls with `confirm: <token>` and the EXACT echoed fields. */
export function pendingConfirmation(
  provider: string,
  wouldSend: unknown,
  token: string,
): { successful: true; data: Record<string, unknown> } {
  return {
    successful: true,
    data: {
      pending_confirmation: true,
      provider,
      would_send: wouldSend,
      confirm_token: token,
      note:
        "Nothing was sent. Review would_send, then call again with the SAME fields plus " +
        "confirm: <confirm_token>. If your client can't pass a confirm arg, an admin reconnects " +
        "the connector to refresh its schema.",
    },
  };
}
