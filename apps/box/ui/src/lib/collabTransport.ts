/**
 * The collab TRANSPORT leaf: close codes, backoff, the socket URL, and the
 * single-use ticket mint — everything the wire needs and NOTHING that touches
 * the editor.
 *
 * It exists as its own module for a build reason. Route presence
 * (`lib/routePresence.ts`, mounted on the shell of every screen) needs a handful
 * of these constants EAGERLY, and it used to reach them through `lib/collab.ts`.
 * But `collab.ts` imports `@tiptap/core`, `y-prosemirror` and the editor's
 * markdown serializer at module scope, so importing one close code from it
 * dragged the whole ~260 KB TipTap/ProseMirror graph onto the eager shell — and
 * onto the unauthenticated `/login`, which has no editor at all.
 *
 * So the ~5 things the eager presence path needs live HERE, with no tiptap /
 * prosemirror / markdown import anywhere in the module graph. `collab.ts`
 * re-exports them, so its own callers are unchanged; the transport chunk
 * (`yjs` + `@hocuspocus/provider` + this leaf) can now ride eagerly without the
 * editor chunk following it (see vite.config.ts manualChunks).
 *
 * These constants MIRROR `apps/box/src/collab/*` (the SPA and the box app are
 * separate bundles); each names the server file it must agree with.
 */

/** The websocket path the box's collab server owns (collab/types.ts). */
export const COLLAB_PATH = "/dash/collab";
/** The ticket minter (dashboard.ts). Authenticated + CSRF + active-status. */
export const COLLAB_TICKET_PATH = "/api/v1/collab/ticket";

/**
 * Close codes (collab/types.ts COLLAB_CLOSE). They exist so the client can tell
 * the refusals apart: "box off" is wait-and-retry, "unauthorized" means fetch a
 * new ticket, "bad origin" is a bug or an attack and must NEVER be retried.
 */
export const COLLAB_CLOSE = {
  UNAUTHORIZED: 4401,
  BAD_ORIGIN: 4406,
  ROOM_FORBIDDEN: 4404,
  EVICTED: 4410,
  BOX_OFF: 4503,
  DRAINING: 4504,
} as const;

/* -------------------------------------------------------------------- backoff */

/** First retry window. Small enough that a 1s blip feels instant. */
export const RECONNECT_BASE_MS = 500;
/** The cap the design states (~30s). */
export const RECONNECT_CAP_MS = 30_000;

/**
 * Equal-jitter backoff: a delay drawn uniformly from the top half of an
 * exponentially growing window, capped at ~30s.
 *
 * The jitter is the point, not the growth. Every tab in the company drops at
 * the same instant when the updater recreates the app container, so an
 * un-jittered schedule reconnects them all in the same millisecond — and each
 * reconnect runs the server's room seeding path. Half the window is kept as a
 * floor so a persistent outage cannot degenerate into a hot loop.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const window = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(window / 2 + random() * (window / 2));
}

/** Build the socket URL. The ticket rides in the query string because a browser
 *  cannot set headers on `new WebSocket(...)`; that is why its TTL is 30s. */
export function collabSocketUrl(ticket: string, origin?: string): string {
  const base = origin ?? (typeof location !== "undefined" ? location.origin : "http://localhost");
  const url = new URL(COLLAB_PATH, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

/* -------------------------------------------------------------------- ticket */

export interface CollabTicket {
  ticket: string;
  expiresInMs?: number;
}

export class CollabTicketError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "CollabTicketError";
  }
}

/** The CSRF cookie is deliberately JS-readable (double-submit). Duplicated from
 *  api.ts rather than imported for the same reason saveQueue's beacon does: this
 *  request must not go through api.ts's shared response handling. */
function csrfToken(): string {
  return typeof document === "undefined"
    ? ""
    : (document.cookie.match(/(?:^|; )brain_csrf=([^;]*)/)?.[1] ?? "");
}

export async function mintCollabTicket(): Promise<CollabTicket> {
  const res = await fetch(COLLAB_TICKET_PATH, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken() },
  });
  if (!res.ok) throw new CollabTicketError(res.status, `collab ticket refused (${res.status})`);
  const body = (await res.json()) as Partial<CollabTicket>;
  if (typeof body.ticket !== "string" || body.ticket === "") {
    throw new CollabTicketError(null, "collab ticket response had no ticket");
  }
  return body.expiresInMs === undefined
    ? { ticket: body.ticket }
    : { ticket: body.ticket, expiresInMs: body.expiresInMs };
}
