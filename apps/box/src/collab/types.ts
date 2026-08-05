import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * The collab (Yjs / Hocuspocus) CONTRACT module: close codes, the connection
 * principal, the ticket crypto, and the PURE handshake decision.
 *
 * Deliberately imports nothing but `node:crypto` — no hocuspocus, no `pg`, no
 * `ws`. Two reasons:
 *
 *  - the ticket MINTER lives on the HTTP side (an authenticated dashboard
 *    route) and must be able to sign a ticket without pulling the whole
 *    websocket stack into that module;
 *  - the handshake rules are the security boundary of a surface that Hono
 *    never sees, so they are unit-testable on their own, with no server, no
 *    database and no sockets.
 *
 * Design invariant: auth is three checks, not one.
 */

/** The websocket path the box's collab server owns. */
export const COLLAB_PATH = "/dash/collab";

/**
 * Close codes. 4000-4999 is the application-private range; 4401/4403/4404/4205
 * are already used by `@hocuspocus/common` (Unauthorized / Forbidden /
 * ConnectionTimeout / ResetConnection), so ours either reuse the hocuspocus
 * meaning EXACTLY (4401) or stay out of its way.
 *
 * These exist so a client can tell the three refusals apart and react
 * correctly: "box off" is a wait-and-retry, "unauthorized" means fetch a new
 * ticket, "bad origin" is a bug or an attack and must NOT be retried.
 */
export const COLLAB_CLOSE = {
  /** no ticket, or a ticket that is invalid/expired/over the TTL cap. */
  UNAUTHORIZED: 4401,
  /** the `Origin` header is missing or not the box's own host. */
  BAD_ORIGIN: 4406,
  /** the principal may not open THIS room (join check; not this task). */
  ROOM_FORBIDDEN: 4404,
  /** access changed under a live socket — rejoin to find out if you still may. */
  EVICTED: 4410,
  /** the kill-switch says this box is off (or the control plane is unreachable). */
  BOX_OFF: 4503,
  /** the process is shutting down / draining; reconnect after the restart. */
  DRAINING: 4504,
} as const;

export type CollabCloseCode = (typeof COLLAB_CLOSE)[keyof typeof COLLAB_CLOSE];

/** A refusal, carried to the client as the websocket close frame. */
export interface CollabRefusal {
  readonly code: CollabCloseCode;
  /** kept short — a websocket close reason may not exceed 123 UTF-8 bytes. */
  readonly reason: string;
}

/**
 * Why a live room was torn down. Mapped to a close code by `evictCloseCode`.
 * The reason is for the SERVER's log and the client's retry decision; it never
 * carries brain content and never names an object the receiver cannot see.
 */
export type CollabEvictReason =
  | "visibility_changed"
  | "unshared"
  | "deleted"
  | "access_revoked"
  | "box_off"
  | "draining"
  | "closing";

export function evictCloseCode(reason: CollabEvictReason): CollabCloseCode {
  if (reason === "box_off") return COLLAB_CLOSE.BOX_OFF;
  if (reason === "draining" || reason === "closing") return COLLAB_CLOSE.DRAINING;
  return COLLAB_CLOSE.EVICTED;
}

/**
 * WHO is on the other end of a socket. Established ONLY by verifying a
 * short-lived ticket minted by an authenticated HTTP request — never from
 * anything the websocket client asserts about itself.
 *
 * It is an IDENTITY, not an authorization: hocuspocus multiplexes many
 * documents over one socket and takes the document name from the message
 * payload, not the URL, so which rooms this principal may open is decided
 * per-document at join time by an RLS-bound read as this actor. `scopes` here
 * is the snapshot AT MINT TIME and is likewise re-read from the database at
 * join and on the periodic re-check — it is a hint, never the write gate.
 */
export interface CollabPrincipal {
  readonly actorId: string;
  readonly role: string;
  readonly scopes: readonly string[];
  /** epoch ms; the socket outlives it (the ticket is spent at handshake). */
  readonly expiresAt: number;
  /** ticket id — the seam a single-use ticket store keys on. */
  readonly ticketId: string;
}

/** The signed body of a ticket. Times are epoch SECONDS (compact, like the session cookie). */
export interface CollabTicketPayload {
  readonly sub: string;
  readonly role: string;
  readonly scopes: readonly string[];
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

/**
 * Hard cap on a ticket's lifetime, enforced at VERIFY as well as at mint. A
 * ticket rides in the websocket URL's query string (browsers cannot set
 * headers on a `new WebSocket(...)`), so it lands in proxy access logs; a
 * short life is what makes that acceptable. Verifying the cap too means a bug
 * in a future minter cannot quietly issue a day-long ticket.
 */
export const COLLAB_TICKET_MAX_TTL_SECONDS = 120;
export const COLLAB_TICKET_DEFAULT_TTL_SECONDS = 30;

/**
 * The ticket HMAC key is DERIVED from the dashboard session secret rather than
 * being the session secret itself, so the two token families live in separate
 * key spaces: a stolen session cookie can never be replayed as a collab ticket
 * (different key), and a leaked ticket can never be replayed as a session
 * cookie. Same secret at rest, no new env var, no cross-protocol confusion.
 */
const TICKET_KEY_INFO = "brain-collab-ticket-v1";

export function deriveCollabTicketKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update(TICKET_KEY_INFO).digest();
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign `<payload>.<hmac>`; the HMAC covers the payload segment only. */
export function signCollabTicket(sessionSecret: string, payload: CollabTicketPayload): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", deriveCollabTicketKey(sessionSecret)).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

/**
 * Mint a ticket for an already-authenticated account. The caller is
 * responsible for having authenticated the request; this only packages the
 * result. `ttlSeconds` is clamped to the cap above.
 */
export function mintCollabTicket(
  sessionSecret: string,
  who: { readonly actorId: string; readonly role: string; readonly scopes: readonly string[] },
  opts?: { readonly ttlSeconds?: number; readonly now?: number; readonly jti?: string },
): { readonly ticket: string; readonly payload: CollabTicketPayload } {
  const nowMs = opts?.now ?? Date.now();
  const iat = Math.floor(nowMs / 1000);
  const ttl = Math.min(
    Math.max(1, Math.floor(opts?.ttlSeconds ?? COLLAB_TICKET_DEFAULT_TTL_SECONDS)),
    COLLAB_TICKET_MAX_TTL_SECONDS,
  );
  const payload: CollabTicketPayload = {
    sub: who.actorId,
    role: who.role,
    scopes: [...who.scopes],
    iat,
    exp: iat + ttl,
    jti: opts?.jti ?? randomUUID(),
  };
  return { ticket: signCollabTicket(sessionSecret, payload), payload };
}

/**
 * Verify signature (constant-time), shape, expiry AND the TTL cap. Returns
 * null on anything at all wrong — the caller turns that into one close code,
 * so a probe learns nothing about WHICH check failed.
 */
export function verifyCollabTicket(
  sessionSecret: string,
  raw: string | undefined | null,
  nowMs: number = Date.now(),
): CollabPrincipal | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", deriveCollabTicketKey(sessionSecret)).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: CollabTicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CollabTicketPayload;
  } catch {
    return null;
  }
  if (
    typeof payload?.sub !== "string" ||
    payload.sub.length === 0 ||
    typeof payload.role !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    typeof payload.jti !== "string" ||
    !Array.isArray(payload.scopes) ||
    payload.scopes.some((s) => typeof s !== "string")
  ) {
    return null;
  }
  if (payload.exp <= payload.iat) return null;
  if (payload.exp - payload.iat > COLLAB_TICKET_MAX_TTL_SECONDS) return null;
  if (payload.exp * 1000 <= nowMs) return null;
  // A ticket from the future is a clock skew or a forgery attempt; allow a
  // small skew, refuse the rest (it would otherwise extend the effective TTL).
  if (payload.iat * 1000 > nowMs + 60_000) return null;

  return {
    actorId: payload.sub,
    role: payload.role,
    scopes: [...payload.scopes],
    expiresAt: payload.exp * 1000,
    ticketId: payload.jti,
  };
}

// ------------------------------------------------------------------- origin

/** A parsed `Origin` header, lowercased. `host` includes the port when present. */
interface ParsedOrigin {
  readonly scheme: string;
  readonly host: string;
}

export function normalizeOrigin(raw: string | undefined | null): ParsedOrigin | null {
  if (!raw) return null;
  const value = raw.trim();
  // "null" is what a sandboxed iframe / a data: document sends. Never allowed.
  if (value === "" || value.toLowerCase() === "null") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // An Origin is scheme + host + port and nothing else; anything with a path,
  // query or credentials is not one.
  if (url.pathname !== "/" || url.search !== "" || url.username !== "" || url.password !== "") {
    return null;
  }
  return { scheme: url.protocol.slice(0, -1), host: url.host.toLowerCase() };
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/:\d+$/, "");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]" || bare === "::1";
}

/**
 * Build the allowlist from whatever the box knows about itself. Accepts either
 * a full URL (`BRAIN_PUBLIC_URL`) or a bare host, plus any extra origins an
 * operator configured. Returns lowercased hosts (with port when given).
 */
export function collabAllowedHosts(
  publicHost?: string | undefined,
  extra?: readonly string[] | undefined,
): string[] {
  const out: string[] = [];
  const push = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const parsed = normalizeOrigin(trimmed);
    if (parsed) {
      out.push(parsed.host);
      return;
    }
    // bare host (possibly with a port) — reject anything with a slash or space
    if (/^[a-z0-9.:_-]+$/i.test(trimmed)) out.push(trimmed.toLowerCase());
  };
  push(publicHost);
  for (const value of extra ?? []) push(value);
  return [...new Set(out)];
}

/**
 * The `Origin` gate. Websocket handshakes are NOT subject to CORS and cannot
 * be defended with a double-submit header (the browser sends no custom headers
 * on a websocket open), so with a `SameSite` cookie this is the only control
 * against cross-site websocket hijacking — without it any page the user visits
 * could open a socket carrying their session and both read and mutate every
 * object they can see.
 *
 * Fail closed: a missing or unparseable Origin is refused.
 *
 *  - allowlist configured  → the origin's host must be on it (the production
 *    path; `BRAIN_PUBLIC_URL` is always set on a real box);
 *  - nothing configured    → the origin's host must equal the request's own
 *    `Host`. A browser sets `Host` itself and page JavaScript cannot override
 *    it, so same-host is a genuine check, not a formality;
 *  - loopback              → allowed only when the request ALSO arrived on a
 *    loopback host, i.e. a developer's machine. This is what lets the vite dev
 *    server on :5180 talk to the dev box on :8080 without weakening any box
 *    that is reachable by a real hostname.
 *
 * Plaintext `http` is refused off loopback: a box is served over TLS, so an
 * `http://` origin means either a downgrade or a forged header.
 */
export function originAllowed(
  origin: string | undefined | null,
  ctx: { readonly allowedHosts: readonly string[]; readonly requestHost?: string | undefined },
): boolean {
  const parsed = normalizeOrigin(origin);
  if (!parsed) return false;
  const secureEnough = parsed.scheme === "https" || isLoopbackHost(parsed.host);
  if (!secureEnough) return false;

  if (ctx.allowedHosts.length > 0) return ctx.allowedHosts.includes(parsed.host);

  const requestHost = ctx.requestHost?.trim().toLowerCase();
  if (!requestHost) return false;
  if (parsed.host === requestHost) return true;
  return isLoopbackHost(parsed.host) && isLoopbackHost(requestHost);
}

// -------------------------------------------------------------- upgrade gate

export interface HandshakeInput {
  /** false once the process is draining/closing — see `/healthz` readiness. */
  readonly accepting: boolean;
  /** the SAME kill-switch answer the Hono middleware gates every request with. */
  readonly boxOn: boolean;
  readonly origin?: string | undefined;
  readonly requestHost?: string | undefined;
  readonly allowedHosts: readonly string[];
  /** result of verifying the ticket; null when absent/invalid/expired. */
  readonly principal: CollabPrincipal | null;
}

export type HandshakeDecision =
  | { readonly ok: true; readonly principal: CollabPrincipal }
  | ({ readonly ok: false } & CollabRefusal);

/**
 * The whole upgrade-path gate, as one pure function.
 *
 * ORDER IS DELIBERATE. The kill-switch is evaluated BEFORE credentials: a box
 * the booth has suspended must not so much as look at a ticket, and must
 * certainly not open a socket that would flush edits into the customer's
 * database while every HTTP surface correctly 503s. Origin comes before the
 * ticket so a cross-site page gets a distinct, non-retryable answer and never
 * has its (stolen-session-derived) credential evaluated at all.
 */
export function handshakeDecision(input: HandshakeInput): HandshakeDecision {
  if (!input.accepting) {
    return { ok: false, code: COLLAB_CLOSE.DRAINING, reason: "box restarting; reconnect shortly" };
  }
  if (!input.boxOn) {
    return { ok: false, code: COLLAB_CLOSE.BOX_OFF, reason: "box is off or unreachable" };
  }
  if (!originAllowed(input.origin, input)) {
    return { ok: false, code: COLLAB_CLOSE.BAD_ORIGIN, reason: "origin not allowed" };
  }
  if (!input.principal) {
    return { ok: false, code: COLLAB_CLOSE.UNAUTHORIZED, reason: "missing or expired ticket" };
  }
  return { ok: true, principal: input.principal };
}

// ------------------------------------------------------------- server shapes

/**
 * The live-room set handed to the dashboard as `liveRooms`, making the phase-1
 * `open_in_editor` guard real. `has` must be a cheap in-memory lookup: the
 * dashboard calls it on every body/title patch.
 */
export interface CollabRooms {
  has(objectId: string): boolean;
  /** number of live rooms — logging/limits only, never a per-object signal. */
  readonly size: number;
}

/** `/healthz` readiness, owned by the collab server's accept state. */
export interface CollabReadiness {
  readonly ready: boolean;
  readonly reason?: string;
}
