/**
 * The CLIENT half of the collab engine: ticket → socket → Y.Doc, and the state
 * machine that decides who owns `body`/`title` at any instant.
 *
 * The server half lives in `apps/box/src/collab/*` (Hocuspocus on the Node
 * upgrade path). Nothing is imported across that boundary — this module
 * re-states the contract it needs (close codes, field names, the ticket route)
 * and says so at each site.
 *
 * Four behaviours, each of which the design pins for a reason:
 *
 *  - **Ticket first, socket second.** The connection principal is never
 *    asserted by the client: `POST /api/v1/collab/ticket` is an authenticated,
 *    CSRF-protected request that mints a 30s SINGLE-USE ticket, and the socket
 *    carries it in the query string (a browser cannot set headers on
 *    `new WebSocket`). Single-use is why the provider's own retry loop is
 *    disabled: a replayed ticket is refused, so every reconnect MUST mint a
 *    fresh one, which only this module can do.
 *
 *  - **A FRESH Y.Doc per connection, always.** A Y.Doc held across an app
 *    recreate must never be merged into a server doc that was re-seeded from
 *    markdown: Yjs sees two independent insert sequences and duplicates the
 *    body end to end. That hazard does not need an edit to trigger — identical
 *    text with different item ids is enough. So each attempt syncs a fresh doc
 *    and the previous one is folded in only AFTER the epoch verdict is known:
 *    same epoch ⇒ a lossless Yjs merge; changed (or unknown) epoch ⇒ server
 *    state is authoritative and unacked local text is re-applied as an explicit
 *    diff, surfacing a conflict if it no longer applies cleanly.
 *
 *  - **The room owns body/title; the CAS queue is suspended for them.** While
 *    the socket is down the Y.Doc is the offline buffer and
 *    `saveQueue.suspend(["body", "title"])` holds those two fields back (props
 *    and links keep flowing on CAS). Letting the queue write `body` while local
 *    Yjs updates accumulate lands the same edit twice — once via CAS→bridge,
 *    once via the Yjs merge — and Yjs cannot know they are the same text.
 *
 *  - **Exponential backoff + jitter, cap ~30s.** Caddy health-checks a single
 *    upstream every 10s, so an app recreate drops every socket in the company
 *    at once and keeps failing for ~10s past actual recovery. Lockstep retries
 *    after every self-update are a self-inflicted thundering herd, and each
 *    retry runs the server's room seeding path.
 *
 * Feed polling is the fallback while the socket is down and ONLY then — the
 * session publishes `pollFeed` so the host has one flag to read, never its own
 * idea of "is collab up".
 */
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

// The CRDT body is a ProseMirror fragment and markdown is canonical at rest, so
// the client's doc↔markdown spelling has to be the EDITOR's spelling — the same
// serializer markdown.test.ts pins. A second spelling here would rewrite every
// body on the first epoch reset.
import { docToMd, editorExtensions, mdToDoc } from "../components/editor/markdown";

/* ------------------------------------------------------------------ contract
 *
 * The wire/transport half (close codes, backoff, socket URL, ticket mint) lives
 * in `./collabTransport` — a leaf with NO editor imports, so route presence can
 * reach it eagerly without pulling TipTap onto the shell. Re-exported here so
 * this module's callers are unchanged.
 *
 * The rest are mirrors of `apps/box/src/collab/types.ts` and `serialize.ts`,
 * copied because the SPA and the box app are separate bundles; each constant
 * names the server file it must agree with.
 */
import {
  COLLAB_CLOSE,
  RECONNECT_CAP_MS,
  backoffDelay,
  collabSocketUrl,
  CollabTicketError,
  mintCollabTicket,
} from "./collabTransport";
import type { CollabTicket } from "./collabTransport";

// Re-exported so this module's callers are unchanged after the transport split.
export { COLLAB_CLOSE, RECONNECT_CAP_MS, backoffDelay, collabSocketUrl, CollabTicketError };
export type { CollabTicket };

/** `doc.getXmlFragment("body")` — collab/serialize.ts BODY_FRAGMENT. */
export const COLLAB_BODY_FIELD = "body";
/** `doc.getText("title")` — collab/serialize.ts TITLE_TEXT. */
export const COLLAB_TITLE_FIELD = "title";
/** The save-queue paths a live room owns. Everything else stays on CAS. */
const COLLAB_OWNED_FIELDS = ["body", "title"];

/* ------------------------------------------------------- doc ↔ markdown ---- */

export interface RoomContent {
  title: string;
  body: string;
}

/** The baseline for a room we have never synced: we have seen nothing. */
const EMPTY_CONTENT: RoomContent = { title: "", body: "" };

/**
 * How long an offline burst of keystrokes coalesces before the Y.Doc is
 * serialized + written to localStorage once. Persisting per keystroke (as this
 * used to) re-serializes the WHOLE body to ProseMirror JSON + markdown and does
 * a synchronous localStorage write on every stroke — main-thread cost that
 * scales with document size, felt exactly during the fleet-wide reconnect window
 * a box self-update opens, when many members are offline and typing at once. A
 * short window bounds that to one write per window while still capturing the
 * current doc each time it fires (a drop flushes it immediately — see
 * `scheduleReconnect`). Mirrors the CAS save queue's own debounce.
 */
const COLLAB_PERSIST_THROTTLE_MS = 500;

function contentEquals(a: RoomContent, b: RoomContent): boolean {
  return a.title === b.title && a.body === b.body;
}

let schemaCache: ReturnType<typeof getSchema> | null = null;
function roomSchema(): ReturnType<typeof getSchema> {
  schemaCache ??= getSchema(editorExtensions());
  return schemaCache;
}

/** Canonical markdown for a room's Y.Doc — the same spelling the box stores. */
export function readRoomContent(doc: Y.Doc): RoomContent {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_BODY_FIELD)) as JSONContent;
  const empty = !Array.isArray(json.content) || json.content.length === 0;
  return {
    title: doc.getText(COLLAB_TITLE_FIELD).toString(),
    // An empty fragment is not a valid ProseMirror doc (`content: "block+"`),
    // so it never reaches the serializer — a fresh room is "" by definition.
    body: empty ? "" : docToMd(json),
  };
}

/**
 * Write markdown into a live room's Y.Doc as an EXPLICIT DIFF.
 *
 * `prosemirrorJSONToYXmlFragment` runs y-prosemirror's `updateYFragment` — the
 * same minimal-diff updater the sync plugin uses — so re-applying text touches
 * only what actually changed instead of replacing the body wholesale (which
 * would delete and re-insert every other participant's paragraphs). The title
 * gets the same treatment by hand: splice the middle, keep the shared prefix
 * and suffix.
 */
export function writeRoomContent(doc: Y.Doc, content: Partial<RoomContent>): void {
  doc.transact(() => {
    if (content.body !== undefined) {
      const json = mdToDoc(content.body);
      prosemirrorJSONToYXmlFragment(roomSchema(), json, doc.getXmlFragment(COLLAB_BODY_FIELD));
    }
    if (content.title !== undefined) {
      const text = doc.getText(COLLAB_TITLE_FIELD);
      spliceText(text, content.title);
    }
  });
}

function spliceText(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = current.length - prefix - suffix;
  if (removed > 0) text.delete(prefix, removed);
  const inserted = next.slice(prefix, next.length - suffix);
  if (inserted !== "") text.insert(prefix, inserted);
}

/* ------------------------------------------------------------ epoch verdict */

type ReapplyVerdict = "clean" | "reapply" | "conflict";

/**
 * The three-way decision an EPOCH RESET forces, in the same shape the save
 * queue's `classifyConflict` uses — because it is the same question asked of a
 * different transport.
 *
 *   local == base   → nothing was typed while we were away; take the server's.
 *   server == base  → the server did not move; re-apply our unacked text.
 *   otherwise       → both moved. NEVER auto-merge two markdown documents:
 *                     take the server's (it is authoritative after a re-seed)
 *                     and surface the conflict with our text intact.
 *
 * `base` is the content the server was known to hold when the socket went down
 * — captured at that moment, not guessed — so "unacked" means exactly "typed
 * into the offline buffer".
 */
export function reapplyDecision(
  base: RoomContent,
  local: RoomContent,
  server: RoomContent,
): ReapplyVerdict {
  const localChanged = local.body !== base.body || local.title !== base.title;
  if (!localChanged) return "clean";
  // Our local content already IS the server's. The offline edit reached the
  // server (e.g. via the pagehide beacon) and merely was not cleared from the
  // buffer, or someone typed the identical text. There is nothing to reapply
  // and nothing in conflict — adopt the server's (they are equal) and let the
  // buffer clear. This is classifyConflict's "landed" case: without it, a first
  // sync whose base is the EMPTY fallback (acked still null) reports `conflict`
  // whenever both local and server are non-empty, surfacing a phantom banner
  // ("what changed: nothing") on a routine reconnect.
  if (contentEquals(local, server)) return "clean";
  const serverChanged = server.body !== base.body || server.title !== base.title;
  return serverChanged ? "conflict" : "reapply";
}

/* ------------------------------------------------- server-stamped identity
 *
 * Mirrors of `apps/box/src/collab/presence.ts` (`PresenceIdentity`,
 * `presenceColor`, `presenceGlyph`, `PRESENCE_IDENTITY_KEYS`). Copied rather
 * than imported for the same reason as the close codes above — the SPA and the
 * box app are separate bundles — so each constant names the server symbol it
 * must agree with.
 *
 * ONE REFUSAL LIVES HERE: a caret is drawn from the server's stamp, or it is
 * drawn anonymously.
 *
 * `kind`, `actorId`, `name`, `color` and `glyph` are exactly the keys the relay
 * OVERWRITES from the connection's authenticated principal and reports as a
 * violation when a client tries to author them. Unforgeability is therefore the
 * relay's, server-side; this reader is what keeps the CLIENT from drawing a
 * robot — or a named person — for anything the relay did not mint. A payload
 * that does not match the stamp's own vocabulary (an unknown palette slot, an
 * `agent` wearing a human colour, an actor id that is not a uuid) is not
 * half-rendered under a plausible name: it renders as an anonymous caret, with
 * no name and no glyph, because "Claude wrote this" must never be a claim a
 * browser can make.
 */

/** presence.ts `PresenceKind`. */
export type CollabPeerKind = "human" | "agent";

/** presence.ts PRESENCE_PALETTE_SIZE — the human colour slots the skins define. */
export const COLLAB_PALETTE_SIZE = 8;

/** presence.ts `presenceColor` — the agent's reserved slot, disjoint from the
 *  human ones so a robot is never mistaken for a person. */
export const COLLAB_AGENT_COLOR = "presence-agent";

/** presence.ts `presenceGlyph` — the agent's glyph. Never a person's initials. */
export const COLLAB_AGENT_GLYPH = "robot";

/** The ONLY colour tokens the relay ever stamps (presence.ts `presenceColor`). */
const COLLAB_COLOR_TOKEN_RE = new RegExp(`^presence-(agent|[1-${COLLAB_PALETTE_SIZE}])$`);

/** presence.ts UUID_RE — a stamped actor id is always a uuid. */
const COLLAB_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** presence.ts MAX_NAME_LENGTH. The server bounds it; so do we, for a label. */
const COLLAB_MAX_NAME = 48;

/** presence.ts `PresenceIdentity`, as it arrives on a doc room. */
export interface CollabPeerIdentity {
  readonly kind: CollabPeerKind;
  readonly actorId: string;
  readonly name: string;
  /** a THEME TOKEN (`presence-3`, `presence-agent`), never an ink. */
  readonly color: string;
  /** initials, or `robot` for the agent. */
  readonly glyph: string;
}

/**
 * Read one peer's awareness `user` field as a server stamp, or refuse it.
 *
 * Every refusal is the rule above, spelled out:
 *
 *  - not an object / unknown `kind` ⇒ nothing to render;
 *  - `actorId` that is not a uuid ⇒ an avatar with no real actor behind it;
 *  - a colour outside the relay's slots ⇒ a payload we do not understand, and
 *    half-rendering an identity is worse than dropping it (the same rule
 *    `routePresence.readPeer` applies to the rail);
 *  - an `agent` not wearing the reserved slot AND the robot glyph, or a `human`
 *    wearing the agent's slot ⇒ a half-stamped identity, i.e. exactly the shape
 *    a client would produce if it tried to promote itself to a robot.
 */
export function readPeerIdentity(raw: unknown): CollabPeerIdentity | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const kind = r["kind"];
  if (kind !== "human" && kind !== "agent") return null;

  const actorId = r["actorId"];
  if (typeof actorId !== "string" || !COLLAB_UUID_RE.test(actorId)) return null;

  const color = r["color"];
  if (typeof color !== "string" || !COLLAB_COLOR_TOKEN_RE.test(color)) return null;

  // Initials (two characters) or the literal `robot`; the bound is a bound, the
  // agent/human coherence check below is the rule.
  const glyph = r["glyph"];
  if (typeof glyph !== "string" || glyph === "" || glyph.length > 8) return null;

  const name = sanitizePeerName(r["name"]);
  if (name === null) return null;

  // The agent's slot and glyph are stamped together or not at all.
  if (kind === "agent" && (color !== COLLAB_AGENT_COLOR || glyph !== COLLAB_AGENT_GLYPH)) {
    return null;
  }
  if (kind === "human" && (color === COLLAB_AGENT_COLOR || glyph === COLLAB_AGENT_GLYPH)) {
    return null;
  }

  return { kind, actorId: actorId.toLowerCase(), name, color, glyph };
}

/**
 * Bound a stamped name for a floating label. The server already sanitized it
 * (presence.ts `sanitizeName`), so this is a bound and not a trust boundary —
 * but a caret label is drawn over somebody's document, and one 4KB name would
 * be a room-wide layout accident on every peer's screen.
 */
function sanitizePeerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let kept = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    kept += ch;
  }
  const value = kept.trim().slice(0, COLLAB_MAX_NAME);
  return value === "" ? null : value;
}

/** True for a peer the relay stamped as an agent. The one place that asks. */
export function isAgentPeer(identity: CollabPeerIdentity | null): boolean {
  return identity !== null && identity.kind === "agent";
}

/* ------------------------------------------------------------- edit trail
 *
 * The agent's animated write (server side: `apps/box/src/collab/animate.ts`)
 * arrives as a short sequence of remote transactions, each preceded by the
 * agent's cursor moving onto the range it is about to touch. The trail is the
 * afterimage of that: the ranges it just rewrote, held briefly so a reader can
 * see WHAT changed and not merely that something did.
 *
 * The arithmetic lives here — pure, no DOM, no ProseMirror — for the same
 * reason the server's scheduler does: everything that can be got wrong is
 * arithmetic, and arithmetic belongs in a unit test rather than smeared through
 * a plugin that needs a live room to exercise.
 */

/** How long one mark lives. The spec's ~1.5s decay. */
export const AGENT_TRAIL_MS = 1_500;

/**
 * A ceiling on live marks. A 400-hunk rewrite merges into far fewer than this
 * (adjacent ranges coalesce), but a document being rearranged end to end must
 * not turn into hundreds of decorations racing a 1.5s timer.
 */
export const AGENT_TRAIL_MAX = 24;

/** One range an agent recently rewrote, in CURRENT document coordinates. */
export interface EditTrailMark {
  /** the awareness client the range is attributed to. */
  readonly clientId: number;
  readonly from: number;
  readonly to: number;
  /** when it landed, `Date.now()`-style. */
  readonly at: number;
  /** the peer's stamped colour TOKEN (`presence-agent`), never an ink. */
  readonly color: string;
}

/** Do two ranges touch at all? Adjacency counts — consecutive chunks abut. */
function trailRangesTouch(
  a: { from: number; to: number },
  b: { from: number; to: number },
): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** 1 at the instant it landed, 0 once it has fully decayed. */
export function trailStrength(mark: EditTrailMark, now: number, ttlMs = AGENT_TRAIL_MS): number {
  if (ttlMs <= 0) return 0;
  const age = now - mark.at;
  if (age <= 0) return 1;
  if (age >= ttlMs) return 0;
  return 1 - age / ttlMs;
}

/** Drop what has decayed, and anything a mapping collapsed to nothing. */
export function pruneTrail(
  marks: readonly EditTrailMark[],
  now: number,
  ttlMs = AGENT_TRAIL_MS,
): EditTrailMark[] {
  return marks.filter((mark) => mark.to > mark.from && trailStrength(mark, now, ttlMs) > 0);
}

/**
 * Add one range to the trail.
 *
 * Marks from the SAME client that touch are merged into their union and take
 * the newer timestamp: the chunk scheduler walks the document top to bottom, so
 * an animated write is a run of abutting ranges and the honest picture of it is
 * one growing highlight, not thirty stacked ones. Two different clients are
 * never merged — a merged range would attribute one peer's text to another.
 */
export function addTrailMark(
  marks: readonly EditTrailMark[],
  mark: EditTrailMark,
  opts: { now?: number; ttlMs?: number; max?: number } = {},
): EditTrailMark[] {
  const now = opts.now ?? mark.at;
  const ttlMs = opts.ttlMs ?? AGENT_TRAIL_MS;
  const max = opts.max ?? AGENT_TRAIL_MAX;
  if (mark.to <= mark.from) return pruneTrail(marks, now, ttlMs);

  const kept: EditTrailMark[] = [];
  let merged = { ...mark };
  for (const existing of pruneTrail(marks, now, ttlMs)) {
    if (existing.clientId === merged.clientId && trailRangesTouch(existing, merged)) {
      merged = {
        clientId: merged.clientId,
        from: Math.min(existing.from, merged.from),
        to: Math.max(existing.to, merged.to),
        at: Math.max(existing.at, merged.at),
        color: merged.color,
      };
      continue;
    }
    kept.push(existing);
  }
  kept.push(merged);
  // Newest wins when the ceiling bites: an old, nearly-faded mark is the one a
  // reader misses least.
  return kept.length <= max ? kept : kept.slice(kept.length - max);
}

/* ------------------------------------------------------------------ provider */

type CollabSocketStatus = "connecting" | "connected" | "disconnected";

/** The provider surface this module drives. Narrow ON PURPOSE: the whole state
 *  machine is unit-testable against a fake that implements exactly this. */
export interface CollabProvider {
  /** the y-protocols Awareness, handed to the caret extension. */
  readonly awareness?: unknown;
  destroy(): void;
}

export interface CollabProviderHandlers {
  onStatus(status: CollabSocketStatus): void;
  onSynced(): void;
  onClose(event: { code?: number | undefined; reason?: string | undefined }): void;
  /** the server's out-of-band channel; carries the doc epoch. */
  onStateless(payload: string): void;
  /** the client has NOTHING unsent left — every local update (including any the
   *  session re-applied at sync) is acknowledged by the server. Only now is the
   *  offline buffer safe to drop for a merge/reapply that folded unacked text
   *  into the live doc. */
  onFlushed(): void;
}

export interface CollabProviderArgs {
  url: string;
  /** the room name — the object id. */
  name: string;
  document: Y.Doc;
  handlers: CollabProviderHandlers;
}

export type CollabProviderFactory = (args: CollabProviderArgs) => CollabProvider;

/**
 * The epoch arrives as a stateless message, `{"type":"epoch","epoch":<ms>}`.
 *
 * An UNKNOWN epoch is not a failure: a server that has not (yet) advertised one
 * lands on the conservative path — markdown three-way instead of a Yjs merge —
 * which can never duplicate a body. Only an epoch we have seen on BOTH sides
 * unlocks the lossless merge.
 */
export function readEpoch(payload: string): number | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as { epoch?: unknown }).epoch;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

const hocuspocusFactory: CollabProviderFactory = ({ url, name, document, handlers }) => {
  // `maxAttempts: 1` — the provider's own retry loop would replay a SPENT
  // ticket and be refused every time. Reconnection is this module's job
  // precisely because a fresh ticket has to be minted for each attempt.
  const socket = new HocuspocusProviderWebsocket({ url, maxAttempts: 1, quiet: true });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document,
    quiet: true,
    onStatus: ({ status }) => handlers.onStatus(status as CollabSocketStatus),
    onSynced: () => handlers.onSynced(),
    onClose: ({ event }) => handlers.onClose({ code: event?.code, reason: event?.reason }),
    onDisconnect: ({ event }) => handlers.onClose({ code: event?.code, reason: event?.reason }),
    onAuthenticationFailed: ({ reason }) =>
      handlers.onClose({ code: COLLAB_CLOSE.UNAUTHORIZED, reason }),
    onStateless: ({ payload }) => handlers.onStateless(payload),
  });
  // `unsyncedChanges` counts outgoing updates the server has not yet acked; it
  // hits 0 once everything the client produced — including anything the session
  // re-applied after an epoch reset — is confirmed. That is the ONLY moment a
  // merge/reapply may safely drop the offline buffer.
  provider.on("unsyncedChanges", (count: number) => {
    if (count === 0) handlers.onFlushed();
  });
  return {
    get awareness(): unknown {
      return provider.awareness;
    },
    destroy(): void {
      provider.destroy();
      socket.destroy();
    },
  };
};

/* ------------------------------------------------------------------ session */

export type CollabStatus =
  /** minting a ticket / opening a socket; the previous doc is still editable */
  | "connecting"
  /** socket up and synced — the room owns body/title */
  | "live"
  /** socket down, retry scheduled; the Y.Doc is the offline buffer */
  | "offline"
  /** terminal: refused in a way retrying cannot fix (bad origin, no access) */
  | "denied";

export interface CollabConflict {
  /** our unacked text, kept verbatim so "keep mine" is possible */
  mine: RoomContent;
  /** what the re-seeded server doc holds */
  theirs: RoomContent;
}

export interface CollabState {
  status: CollabStatus;
  /** the doc the editor binds to. Its IDENTITY changes when a connection syncs
   *  — hosts must re-key the editor on it. */
  doc: Y.Doc;
  /** non-null only while live; the caret extension binds to its awareness. */
  provider: CollabProvider | null;
  /** the server's doc epoch, when it advertises one. */
  epoch: number | null;
  /**
   * Has this session synced with the server AT LEAST ONCE? Until it has, `doc`
   * holds only what was typed offline (or the seeded buffer) — never the
   * object's stored content — so a host must not treat an empty never-synced doc
   * as "the body is empty". Latches true on the first `handleSynced` and stays
   * true across later drops/denials.
   */
  everSynced: boolean;
  /** consecutive failed connection attempts (0 while live). */
  attempt: number;
  /** poll the feed ONLY while this is true. */
  pollFeed: boolean;
  /** set when an epoch reset could not re-apply local text cleanly. */
  conflict: CollabConflict | null;
  /** why we are offline/denied, for the banner. Never brain content. */
  reason: string | null;
}

/** The slice of the save queue a session drives. Kept structural so a test (and
 *  a host that owns the queue differently) needs no real queue. */
export interface CollabSaveQueue {
  suspend(fields: string[]): void;
  resume(): void;
  /**
   * Remove and return the body/title the CAS queue is holding for the room —
   * the edits a user typed BEFORE the first sync, which `partition` routes to
   * `held` (never sent) because body/title are suspended from the moment we
   * intend to connect. The session calls this at the first sync and seeds them
   * into the just-synced CRDT (see `handleSynced`), so they persist over the
   * socket instead of being (a) discarded when reconcile adopts the server doc
   * and (b) flushed as a doomed 409 `open_in_editor` PATCH once `resume` clears
   * the suspension. Returns null when nothing is held. Optional so a test fake
   * (or a host with a different queue) need not implement it — a session with
   * no such queue simply cannot carry pre-sync CAS text, exactly as before.
   */
  takeRoomContent?(): Partial<RoomContent> | null;
}

export interface ConnectRoomOptions {
  objectId: string;
  /** the object's CAS save queue. The session suspends body/title on it. */
  saveQueue?: CollabSaveQueue | null;
  /** http(s) origin override; the ws/wss URL is derived from it. */
  origin?: string;
  mintTicket?: () => Promise<CollabTicket>;
  createProvider?: CollabProviderFactory;
  onState?: (state: CollabState) => void;
  random?: () => number;
  /** injectable timer: returns its own canceller. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** consecutive 4401s before we stop trying (a clock skew must not hot-loop). */
  maxUnauthorizedRetries?: number;
  /**
   * A crash net for the offline buffer. While the socket is down the Y.Doc is
   * the ONLY copy of typed body/title (they do not travel through the CAS save
   * queue), so a reload or tab-close mid-outage loses them. When provided, the
   * session persists the buffer's content on every offline edit and SEEDS it
   * back into the room's initial doc on the next mount, so the text survives.
   * `null`/omitted ⇒ no persistence, exactly as before.
   */
  persistence?: CollabPersistence | null;
}

/**
 * A persisted offline buffer: the offline `content` AND the `base` the server
 * was known to hold when the socket dropped. The base is what a fresh mount
 * reconciles against after a reload — without it the reconcile falls back to
 * EMPTY and either raises a phantom conflict (offline edits ≠ EMPTY ≠ server) or
 * silently drops an offline deletion (empty ≈ EMPTY ⇒ "clean" ⇒ re-adopt
 * server). See `reconcile` and `lib/draftMirror`'s `CollabBuffer`.
 */
export interface PersistedRoom {
  content: RoomContent;
  base: RoomContent;
}

/**
 * The store behind the offline-buffer crash net. Deliberately tiny and
 * injectable: the host wires it to `lib/draftMirror`'s account-scoped collab
 * buffer (so the same privacy purge covers it), and a test hands in a fake.
 */
export interface CollabPersistence {
  /** the buffer persisted by a previous mount, or null. */
  load(): PersistedRoom | null;
  /** persist the current offline content and the base it diverged from (called
   *  on every offline edit). */
  save(room: PersistedRoom): void;
  /** drop it — the server now holds the text. */
  clear(): void;
}

export interface CollabSession {
  readonly objectId: string;
  state(): CollabState;
  subscribe(listener: (state: CollabState) => void): () => void;
  /** conflict resolution: re-apply OUR text over the server's, as a diff. */
  keepMine(): void;
  /** conflict resolution: drop our text, the server's already stands. */
  takeTheirs(): void;
  /** retry now, ignoring the backoff timer (the banner's "try again"). */
  reconnectNow(): void;
  /**
   * Run any pending throttled offline-buffer persist NOW. A page-lifecycle
   * flush the host wires to `pagehide`/`visibilitychange:hidden`: React runs
   * NO effect cleanup on a tab close/reload/bfcache background, so `destroy`
   * (which also flushes) never fires there, and the last <500ms of offline
   * body/title keystrokes would sit in the un-elapsed throttle window and be
   * lost. A no-op while live (the server holds the text) or without
   * persistence.
   */
  flushPersist(): void;
  /** hand body/title back to CAS and stop reconnecting. */
  destroy(): void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

export function connectRoom(opts: ConnectRoomOptions): CollabSession {
  const random = opts.random ?? Math.random;
  const schedule = opts.schedule ?? defaultSchedule;
  const mint = opts.mintTicket ?? mintCollabTicket;
  const createProvider = opts.createProvider ?? hocuspocusFactory;
  const queue = opts.saveQueue ?? null;
  const maxUnauthorized = opts.maxUnauthorizedRetries ?? 3;
  const persistence = opts.persistence ?? null;

  /** the doc the EDITOR is bound to — also the offline buffer. */
  let doc = new Y.Doc();
  /** the fresh doc this attempt's provider syncs into; folded in at sync. */
  let staging: Y.Doc | null = null;
  let provider: CollabProvider | null = null;
  let status: CollabStatus = "connecting";
  let epoch: number | null = null;
  /** the epoch `doc` was last synced under — the merge-safety key. */
  let docEpoch: number | null = null;
  let attempt = 0;
  let unauthorized = 0;
  let conflict: CollabConflict | null = null;
  let reason: string | null = null;
  let destroyed = false;
  let cancelTimer: (() => void) | null = null;
  /** what the server was known to hold when we last had a socket. */
  let acked: RoomContent | null = null;
  /**
   * The last content a flush CONFIRMED the server holds (the doc state at the
   * moment `unsyncedChanges` last hit 0 while live), or the server's content at
   * a truly clean sync. This — NOT the current doc — is the honest offline
   * baseline at an abrupt drop: anything typed after the last flush is unacked
   * by definition, and folding it into the baseline would make `reconcile` read
   * those edits as "already the server's" and silently discard them. Null until
   * the first confirmation of this connection; a drop before then falls back to
   * the doc (the buffer/reload net still recovers it — see `handleSynced`).
   */
  let flushedContent: RoomContent | null = null;
  /** latched true on the first successful sync — see CollabState.everSynced. */
  let everSynced = false;
  /**
   * Bumped on every attempt AND on every terminal event, so a late callback
   * from a dead connection (hocuspocus fires onClose and onDisconnect for the
   * same drop) can never drive the machine twice.
   */
  let generation = 0;

  const listeners = new Set<(state: CollabState) => void>();

  function snapshot(): CollabState {
    return {
      status,
      doc,
      provider: status === "live" ? provider : null,
      epoch,
      everSynced,
      attempt,
      // The feed poller is the liveness fallback and runs ONLY while the
      // socket is not carrying updates.
      pollFeed: status !== "live",
      conflict,
      reason,
    };
  }

  function emit(): void {
    const state = snapshot();
    opts.onState?.(state);
    for (const listener of [...listeners]) listener(state);
  }

  /* --- offline-buffer crash net (opts.persistence) --------------------------
   *
   * While the socket is NOT live the Y.Doc is the only copy of typed body/title.
   * Persist its content on every offline edit so a reload/close cannot lose it;
   * on a clean sync the server holds the text, so drop the buffer. */
  let observedDoc: Y.Doc | null = null;
  /** Cancel handle for a scheduled (throttled) persist; also the "a write is
   *  already pending this window" flag. */
  let cancelPersist: (() => void) | null = null;

  function persistBuffer(): void {
    if (!persistence || status === "live") return;
    try {
      // Persist the base too: it is what a reload reconciles against, and
      // without it the fresh mount would fall back to EMPTY (phantom conflict,
      // or a lost offline deletion). `acked` is the server's known content at
      // the drop; before any sync it is null and EMPTY is the honest baseline.
      persistence.save({ content: readRoomContent(doc), base: acked ?? EMPTY_CONTENT });
    } catch {
      /* storage full/blocked — the in-memory doc is still the truth */
    }
  }

  /**
   * The throttled entry point wired to the doc's `update` event. It coalesces an
   * offline burst into one write per `COLLAB_PERSIST_THROTTLE_MS` window instead
   * of serializing + persisting the whole body on every keystroke. Trailing by
   * construction: when the timer fires it reads the CURRENT doc, so the last
   * keystroke of the window is always captured, and continuous typing still
   * persists once per window rather than once per stroke.
   */
  function schedulePersist(): void {
    if (!persistence || status === "live" || cancelPersist) return;
    cancelPersist = schedule(() => {
      cancelPersist = null;
      persistBuffer();
    }, COLLAB_PERSIST_THROTTLE_MS);
  }

  /** Run any pending throttled persist NOW (and cancel the timer). Used where a
   *  guaranteed-current buffer matters more than coalescing — a socket drop and
   *  teardown — so the debounce window can never swallow the latest offline
   *  text at exactly the moment it must survive. A no-op while live (the server
   *  holds the text) or without persistence. */
  function flushPersist(): void {
    if (cancelPersist) {
      cancelPersist();
      cancelPersist = null;
    }
    persistBuffer();
  }

  /** Follow the CURRENT `doc` (its identity changes on every epoch swap). */
  function observeForPersist(next: Y.Doc): void {
    if (!persistence || observedDoc === next) return;
    if (observedDoc) observedDoc.off("update", schedulePersist);
    observedDoc = next;
    next.on("update", schedulePersist);
  }

  function stopObservingPersist(): void {
    if (observedDoc) observedDoc.off("update", schedulePersist);
    observedDoc = null;
    if (cancelPersist) {
      cancelPersist();
      cancelPersist = null;
    }
  }

  /** The room owns body/title from the moment we intend to connect: while a
   *  room is live the box refuses a CAS body/title patch with 409
   *  `open_in_editor`, and while it is down the Y.Doc is the buffer. */
  function suspendFields(): void {
    queue?.suspend([...COLLAB_OWNED_FIELDS]);
  }

  /** Only when the fields go back to CAS: a synced socket (the editor writes
   *  through the CRDT from here) or a terminal refusal (CAS is all that's
   *  left). Never while a retry is pending.
   *
   *  `SaveQueue.resume()` clears EVERY suspension, not just ours — it is the
   *  queue's only un-suspend — so a host that suspends fields for its own
   *  reasons must re-assert them after a collab state change. */
  function resumeFields(): void {
    queue?.resume();
  }

  function clearTimer(): void {
    if (cancelTimer) cancelTimer();
    cancelTimer = null;
  }

  function teardownProvider(): void {
    if (provider) {
      try {
        provider.destroy();
      } catch {
        /* already gone */
      }
    }
    provider = null;
    // A staging doc that never synced holds nothing anyone typed (the editor is
    // bound to `doc` until the swap), so dropping it loses nothing.
    staging = null;
  }

  function deny(why: string): void {
    generation += 1;
    clearTimer();
    teardownProvider();
    status = "denied";
    reason = why;
    // Hand body/title back: with no room to own them, CAS is the only path the
    // user's typing has. If a room IS live for someone else the box answers
    // 409 `open_in_editor` and the queue surfaces `locked` — enforcement stays
    // server-side, as it must.
    resumeFields();
    emit();
  }

  function scheduleReconnect(why: string): void {
    generation += 1;
    teardownProvider();
    status = "offline";
    reason = why;
    attempt += 1;
    suspendFields();
    // A drop is exactly when the throttle window must not swallow the latest
    // offline text: the reload/recovery the buffer exists for may follow at
    // once. Persist the current doc synchronously now (status is already
    // "offline", so `persistBuffer` runs) instead of waiting for the pending
    // window to elapse.
    flushPersist();
    emit();
    clearTimer();
    cancelTimer = schedule(
      () => {
        cancelTimer = null;
        void open();
      },
      backoffDelay(attempt, random),
    );
  }

  /**
   * Fold the previous doc into the freshly synced one — the whole epoch rule,
   * in one place. Returns `true` when it carried UNACKED local text into `next`
   * (a lossless merge of unflushed offline edits, or an explicit `reapply`): the
   * caller must then keep the offline buffer until the server confirms the flush,
   * because those updates live only in memory until then. Returns `false` when
   * the server already holds everything (`clean`, or a re-seed we merely observed)
   * — the buffer is safe to drop at once. A surfaced `conflict` also returns
   * `false`; the buffer is retained on the separate `conflict !== null` signal.
   */
  function reconcile(previous: Y.Doc, previousEpoch: number | null, next: Y.Doc): boolean {
    const sameEpoch = previousEpoch !== null && epoch !== null && previousEpoch === epoch;
    if (sameEpoch) {
      // Same lineage: Yjs dedupes by (client, clock), so this is lossless and
      // keeps every character-level merge the CRDT already computed.
      Y.applyUpdate(next, Y.encodeStateAsUpdate(previous));
      // If `previous` still matches what the server last acked, the merge added
      // nothing the server lacks and the buffer is safe now; otherwise unflushed
      // offline edits are riding on `next` and only a confirmed flush clears it.
      return !contentEquals(readRoomContent(previous), acked ?? EMPTY_CONTENT);
    }
    // The room was re-seeded (or the server advertises no epoch, which we treat
    // the same way): server state is authoritative and the old Y state is
    // DISCARDED — merging it would duplicate the body end to end.
    const mine = readRoomContent(previous);
    const theirs = readRoomContent(next);
    // Never synced ⇒ we have never seen what the server holds, and the honest
    // baseline is "nothing". An empty never-synced doc then reads as `clean`
    // (take the server's), while text typed before the first sync is still
    // offered back rather than silently dropped.
    const base = acked ?? EMPTY_CONTENT;
    const verdict = reapplyDecision(base, mine, theirs);
    if (verdict === "reapply") {
      writeRoomContent(next, mine);
      return true;
    }
    if (verdict === "conflict") conflict = { mine, theirs };
    return false;
  }

  function handleSynced(gen: number): void {
    if (destroyed || gen !== generation || staging === null) return;
    const next = staging;
    staging = null;
    const previous = doc;
    const previousEpoch = docEpoch;
    // What the SERVER holds, captured BEFORE reconcile can fold local text into
    // `next`. This — not the folded doc — is the honest `acked` baseline when
    // the sync carries unacked edits: recording the folded doc would mark text
    // the server has never confirmed as "already the server's", and a drop
    // before the flush ack would then persist a buffer whose base equals its
    // content — silently discarding the offline text on the next epoch reset
    // or reload (reapplyDecision reads localChanged === false → "clean").
    const serverHeld = readRoomContent(next);
    const foldedUnacked = reconcile(previous, previousEpoch, next);
    // Carry the PRE-FIRST-SYNC CAS edits into the synced doc. Before the first
    // sync the host keeps body/title on CAS (the editor shows the loaded server
    // body rather than an empty CRDT), so a user who types on open lands text in
    // the SUSPENDED queue — held, never sent, and NOT in `previous` (the pre-sync
    // editor never wrote the CRDT). reconcile just adopted the server doc, so
    // without this those edits are lost, and `resume` below would flush them as a
    // doomed 409 `open_in_editor`. Take them off the queue and write them into
    // `next` as an explicit diff (keep-mine), so they save over the socket and
    // stay on screen. Only the first sync ever holds them — once `everSynced`
    // latches the host owns body/title on the CRDT (true even while offline), so
    // no later body/title reaches CAS and this is a no-op on every re-sync.
    const carried = queue?.takeRoomContent?.() ?? null;
    const carriedUnacked =
      carried != null && (carried.body !== undefined || carried.title !== undefined);
    if (carriedUnacked) writeRoomContent(next, carried);
    // The old doc is NOT destroyed: the editor is still bound to it until this
    // state reaches React. Dropping the reference is enough; GC does the rest.
    doc = next;
    docEpoch = epoch;
    // `acked` is what the server actually holds — the pre-fold synced content.
    // On a clean sync it equals the doc; when the sync folded/carried unacked
    // text the doc holds MORE than the server has, and `acked` must exclude
    // that text until `handleFlushed` confirms it (see `serverHeld` above).
    acked = serverHeld;
    everSynced = true;
    attempt = 0;
    unauthorized = 0;
    status = "live";
    reason = null;
    // Follow the NEW doc for offline persistence (identity just changed). The
    // buffer may drop ONLY when the server already holds everything: a `clean`
    // reconcile (nothing typed offline) or a re-seed we merely observed. When
    // reconcile FOLDED unacked offline edits into this doc (a lossless merge or
    // a `reapply`), those updates live only in memory until the server acks
    // them — `handleFlushed` clears the buffer then, so a re-drop before the
    // flush (the box self-updating twice in a row) still recovers on reload. A
    // surviving `conflict` likewise keeps the buffer until the user resolves it.
    observeForPersist(doc);
    // Carried pre-sync text lives only in memory (and the CAS draft mirror the
    // host still holds) until the server acks it — treat it like folded unacked
    // edits and keep the buffer until `handleFlushed` clears it on the ack.
    if (conflict === null && !foldedUnacked && !carriedUnacked) {
      persistence?.clear();
    }
    // The server-held synced content is confirmed BY DEFINITION — the server
    // just sent it — so it is the drop-time baseline until the next flush ack
    // moves it (`handleFlushed`). On a clean sync it equals the doc; when
    // unacked text was folded/carried in it is the PRE-FOLD content, which is
    // exactly what a drop before the ack must reconcile against. Seeding it on
    // every sync also clears any stale confirmation left over from a previous
    // connection of this session.
    flushedContent = serverHeld;
    // Synced: body/title now travel over the socket, so the queue may hold
    // everything it is asked to hold again.
    resumeFields();
    emit();
  }

  /** Every local update — including anything `reconcile` re-applied at sync — is
   *  now acknowledged by the server, so the offline buffer that kept it
   *  recoverable across a re-drop has done its job. Guarded on `live` (a flush
   *  signal that races ahead of `handleSynced` must not clear a buffer we still
   *  need) and on no pending `conflict` (that keeps the buffer until resolved). */
  function handleFlushed(gen: number): void {
    if (destroyed || gen !== generation || status !== "live" || conflict !== null) return;
    // The server now holds everything the doc holds: record it as the confirmed
    // offline baseline so a later abrupt drop reconciles against what was ACKED,
    // not against edits typed after this flush.
    flushedContent = readRoomContent(doc);
    persistence?.clear();
  }

  function handleDown(gen: number, why: string): void {
    if (destroyed || gen !== generation) return;
    if (status === "live") {
      // The offline baseline is what the server last CONFIRMED (the last flush),
      // NOT the current doc. A socket can drop with Yjs updates still unsent —
      // exactly the box-self-update case this machine targets — and those edits
      // are unacked. Setting the baseline to the current doc would make them
      // read as "already the server's": `reapplyDecision` would see
      // localChanged === false and adopt the re-seeded server doc, dropping the
      // unsent edit with no conflict banner. The last-flushed content excludes
      // it, so it is re-applied (or surfaced as a conflict) instead of lost.
      //
      // `flushedContent` is null when NOTHING has been confirmed since this
      // connection synced — exactly the first-connection-that-folded-unacked-
      // text case (and keep-mine before its ack). The honest fallback there is
      // the EXISTING `acked` — the server-held content handleSynced/keepMine
      // recorded — never the current doc, which already contains the very
      // unacked text the baseline exists to exclude.
      acked = flushedContent ?? acked ?? readRoomContent(doc);
    }
    scheduleReconnect(why);
  }

  function handleClose(gen: number, code: number | undefined, why: string | undefined): void {
    if (destroyed || gen !== generation) return;
    const detail = why && why !== "" ? why : "connection closed";
    if (code === COLLAB_CLOSE.BAD_ORIGIN) {
      // A bug or an attack. Retrying cannot fix either, and a retry loop on a
      // hijack attempt is free amplification.
      deny(detail);
      return;
    }
    if (code === COLLAB_CLOSE.ROOM_FORBIDDEN) {
      // "cannot see it" and "does not exist" are one answer by design; the host
      // falls back to a read-only view with an explanation.
      deny(detail);
      return;
    }
    if (code === COLLAB_CLOSE.UNAUTHORIZED) {
      unauthorized += 1;
      if (unauthorized > maxUnauthorized) {
        deny("collab authorization refused");
        return;
      }
      handleDown(gen, detail);
      return;
    }
    // EVICTED (rejoin and find out), BOX_OFF, DRAINING, 1006 and friends: all
    // wait-and-retry.
    handleDown(gen, detail);
  }

  async function open(): Promise<void> {
    if (destroyed) return;
    generation += 1;
    const gen = generation;
    // Defensive: every caller tears the old socket down first, but a second
    // live provider would race this one into the same doc.
    teardownProvider();
    status = "connecting";
    // Suspended for the whole window, not just the drop: an in-flight PATCH
    // carrying body while the room comes up is the double-write this prevents.
    suspendFields();
    emit();

    let ticket: CollabTicket;
    try {
      ticket = await mint();
    } catch (err) {
      if (destroyed || gen !== generation) return;
      const status_ = err instanceof CollabTicketError ? err.status : null;
      if (status_ === 401 || status_ === 403) {
        deny("not signed in");
        return;
      }
      handleDown(gen, "could not mint a collab ticket");
      return;
    }
    if (destroyed || gen !== generation) return;

    // A FRESH doc for this connection. See the module header: a doc held across
    // an app recreate must never be merged into a re-seeded room, and identical
    // text with different item ids is enough to duplicate the whole body.
    epoch = null;
    const next = new Y.Doc();
    staging = next;
    provider = createProvider({
      url: collabSocketUrl(ticket.ticket, opts.origin),
      name: opts.objectId,
      document: next,
      handlers: {
        onStatus: (socketStatus) => {
          if (socketStatus === "disconnected") handleDown(gen, "socket disconnected");
        },
        onSynced: () => handleSynced(gen),
        onFlushed: () => handleFlushed(gen),
        onClose: (event) => handleClose(gen, event.code, event.reason),
        onStateless: (payload) => {
          const value = readEpoch(payload);
          if (value !== null) epoch = value;
        },
      },
    });
  }

  // Seed the initial doc from a buffer a previous mount left behind (a reload or
  // tab-close during an outage), so offline text is on screen immediately and,
  // on the first sync, offered back to the server by reconcile. Then follow the
  // doc so every subsequent offline edit is persisted.
  if (persistence) {
    const saved = persistence.load();
    if (saved) {
      if (saved.content.title !== "" || saved.content.body !== "") {
        writeRoomContent(doc, saved.content);
      }
      // Restore the pre-outage base so the FIRST reconcile after this reload uses
      // the real baseline (what the server last held) rather than the EMPTY
      // fallback. Without this a routine reconnect raises a phantom conflict for
      // ordinary offline edits, and silently reverts an offline deletion to the
      // server's old content. Seeding empty content is a no-op on the doc, but
      // the base must still be restored — that IS the deletion's evidence.
      acked = saved.base;
    }
    observeForPersist(doc);
  }

  void open();

  return {
    objectId: opts.objectId,

    state: snapshot,

    subscribe(listener: (state: CollabState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    keepMine(): void {
      if (!conflict) return;
      const mine = conflict.mine;
      const theirs = conflict.theirs;
      // An explicit diff over the server's text, not a wholesale replace — the
      // same updater the sync plugin uses, so co-editors keep their paragraphs.
      writeRoomContent(doc, mine);
      // The server still holds THEIRS until our re-assertion flushes — so that
      // is the acked baseline, mirroring the persisted base below. Recording
      // the just-written doc (mine) instead would poison a drop-before-ack:
      // `handleDown` falls back to `acked`, `persistBuffer` would write
      // {content: mine, base: mine}, and a reload would silently re-adopt the
      // server's text the user explicitly rejected.
      acked = theirs;
      conflict = null;
      // The re-asserted text lives ONLY in memory until the server acks the
      // flush. Do NOT clear the buffer here: a socket drop in the window before
      // the ack (the box self-updating again), followed by a reload with no
      // further keystroke, would lose it — `persistBuffer` is a no-op while live
      // and cannot restore what was cleared. Keep it (refreshed to exactly what
      // we re-applied) and let `handleFlushed` clear it on the ack, the same way
      // the reconcile/reapply path retains its buffer via `foldedUnacked`. The
      // persisted base is `theirs` — the content the server actually holds until
      // our re-assertion flushes — so a reload before the ack reconciles as a
      // clean `reapply` of our text, never a re-adoption of the server's.
      try {
        persistence?.save({ content: mine, base: theirs });
      } catch {
        /* storage full/blocked — the in-memory doc is still the truth */
      }
      emit();
    },

    takeTheirs(): void {
      if (!conflict) return;
      conflict = null;
      // The user dropped their offline text for the server's; the buffer holding
      // it must not resurface it on the next load.
      persistence?.clear();
      emit();
    },

    reconnectNow(): void {
      if (destroyed || status === "live") return;
      clearTimer();
      attempt = 0;
      unauthorized = 0;
      void open();
    },

    flushPersist(): void {
      // No teardown here — the page may be frozen into the bfcache and later
      // restored, where the session keeps running. Just harden the buffer.
      flushPersist();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      clearTimer();
      teardownProvider();
      // Unmount/close while offline is a recovery moment too: capture the latest
      // buffered text before we stop observing, rather than dropping the pending
      // throttle window. A no-op while live or without persistence.
      flushPersist();
      stopObservingPersist();
      listeners.clear();
      // The room no longer owns anything: whatever the host does next goes
      // through CAS.
      resumeFields();
    },
  };
}
