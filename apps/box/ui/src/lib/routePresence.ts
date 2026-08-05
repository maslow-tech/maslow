/**
 * ROUTE PRESENCE — the client half of "3 people viewing Deals".
 *
 * A route room is the lightweight awareness room keyed by a SCREEN (`type/deal`,
 * `search`, `home`) rather than by an object. The server half is
 * `apps/box/src/collab/presence.ts`; nothing is imported across that boundary
 * (the SPA and the box app are separate bundles), so this module RE-STATES the
 * contract it needs and names the server file at each site — the same
 * discipline `collab.ts` uses for the doc-room protocol.
 *
 * Three rules from the design spec (phase 2, "Presence") are load-bearing here,
 * and every one of them is a rule about what this file must NOT do:
 *
 *  1. **Identity is the server's, never ours and never a peer's.** `kind`,
 *     `actorId`, `name`, `color` and `glyph` are stamped by the relay from the
 *     connection's authenticated principal. This client publishes POSITION ONLY
 *     (`{ anchor, head }` — numbers; strings are refused on a route because the
 *     natural string to put there is a row key, and a row key is an object id).
 *     An identity key in our outbound payload would be logged as a protocol
 *     violation, and rightly.
 *
 *  2. **Route-level presence carries no object identity the recipient cannot
 *     see.** The relay resolves "which object is this person in" per recipient
 *     against THAT recipient's own RLS read and omits it otherwise. So this
 *     module renders exactly what arrived: it never asks for an object list,
 *     never joins a peer to anything it happens to have cached, and never
 *     re-derives a figure from anything but the already-intersected states the
 *     server sent. Presence must never reveal that a private object exists.
 *
 *  3. **Down means gone, not stale.** The socket dropping is not a loading
 *     state and not a reason to keep drawing the last roster — a rail that
 *     keeps showing "Dana is here" after Dana closed her laptop is worse than
 *     an empty rail. Anything but `live` publishes an empty peer list and null
 *     counts, and the rail renders nothing at all.
 *
 * Presence is also a NICETY: it may never be the reason someone cannot type. No
 * failure in here throws outward, and a refused room is simply a rail that is
 * not there.
 */
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

// From the transport LEAF, not `./collab`: this module is imported EAGERLY by
// the shell's presence rail, and `./collab` pulls the whole TipTap/ProseMirror
// editor graph at module scope. The leaf has no editor import, so the eager
// presence path stays off the 260 KB editor chunk (see vite.config.ts).
import {
  COLLAB_CLOSE,
  CollabTicketError,
  backoffDelay,
  collabSocketUrl,
  mintCollabTicket,
  type CollabTicket,
} from "./collabTransport";

/* ------------------------------------------------------------------ contract
 *
 * Mirrors of `apps/box/src/collab/presence.ts`. Copied, not imported.
 */

/** `route:<key>` — presence.ts `RouteRoomKey`. Disjoint from `doc:` by design. */
export type RouteRoomKey = `route:${string}`;

/** presence.ts ROUTE_KEY_RE — a screen name, deliberately narrow. */
const ROUTE_KEY_RE = /^[a-z0-9][a-z0-9/:_.-]{0,119}$/;
/** presence.ts UUID_ANYWHERE_RE — a route key may never embed an object id. */
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** presence.ts PRESENCE_PALETTE_SIZE — the human colour slots the skins define. */
const PRESENCE_PALETTE_SIZE = 8;
/** The colour tokens the relay is allowed to stamp. A theme token, not a colour. */
const COLOR_TOKEN_RE = new RegExp(`^presence-(agent|[1-${PRESENCE_PALETTE_SIZE}])$`);

/** The stateless payload type, in BOTH directions (server relay ⇄ client). */
export const PRESENCE_MESSAGE = "presence";

/**
 * presence.ts PRESENCE_TTL_MS is 45s and the relay sweeps on it, so a tab that
 * says nothing for a minute drops out of everyone else's rail. Re-publish well
 * inside that window: one tiny stateless frame per client per 15s.
 */
const PRESENCE_HEARTBEAT_MS = 15_000;

/**
 * Normalize a route key into a room key, or refuse it.
 *
 * Mirror of presence.ts `routeRoom`, and it refuses for the same reason: route
 * rooms are unauthenticated by construction (anyone may name any route and see
 * who else is there), so a key like `object/<uuid>` would make membership an
 * oracle for the existence of an object. Object-scoped presence has its own,
 * RLS-gated room type.
 *
 * Refusing here as well as on the server is not belt-and-braces theatre: it
 * keeps us from ever putting an object id on the wire in the first place.
 */
export function routeRoomKey(routeKey: string): RouteRoomKey | null {
  const key = routeKey.trim().toLowerCase();
  if (!ROUTE_KEY_RE.test(key)) return null;
  if (UUID_ANYWHERE_RE.test(key)) return null;
  return `route:${key}`;
}

export type PresenceKind = "human" | "agent";

/** presence.ts `PresencePosition` — on a route, numbers only. */
export interface PresencePosition {
  readonly anchor?: number;
  readonly head?: number;
}

/**
 * One participant, exactly as this recipient was allowed to receive them —
 * presence.ts `PresenceWireState`.
 *
 * `objectId` is present ONLY when the server's per-recipient RLS read returned
 * it. Its absence is the mechanism, not a gap to fill in: the person stays in
 * the rail, whatever they have open does not travel with them.
 */
export interface RoutePeer {
  readonly clientId: string;
  readonly kind: PresenceKind;
  readonly actorId: string;
  readonly name: string;
  /** a theme token (`presence-3`, `presence-agent`), never an ink. */
  readonly color: string;
  /** initials, or `robot` for the agent. Never free text. */
  readonly glyph: string;
  readonly position: PresencePosition;
  readonly objectId?: string;
}

/** presence.ts `PresenceCounts` — every figure computed AFTER the intersection. */
export interface RoutePresenceCounts {
  readonly people: number;
  readonly agents: number;
  readonly objects: number;
  readonly objectsByActor: Readonly<Record<string, number>>;
}

interface RoutePresenceView {
  readonly peers: readonly RoutePeer[];
  readonly counts: RoutePresenceCounts;
}

/* ----------------------------------------------------------------- decoding */

function readPeer(raw: unknown): RoutePeer | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];
  if (kind !== "human" && kind !== "agent") return null;
  const clientId = r["clientId"];
  const actorId = r["actorId"];
  const name = r["name"];
  const color = r["color"];
  const glyph = r["glyph"];
  if (typeof clientId !== "string" || clientId === "") return null;
  if (typeof actorId !== "string" || actorId === "") return null;
  if (typeof name !== "string" || name === "") return null;
  // A colour that is not one of the relay's slots is a payload we do not
  // understand; half-rendering an unknown identity is worse than dropping it.
  if (typeof color !== "string" || !COLOR_TOKEN_RE.test(color)) return null;
  if (typeof glyph !== "string" || glyph === "") return null;

  const objectId = r["objectId"];
  const position = readPosition(r["position"]);
  return {
    clientId,
    kind,
    actorId,
    name,
    color,
    glyph,
    position,
    // Only a well-formed id, and only when the server chose to include it.
    ...(typeof objectId === "string" && UUID_RE.test(objectId)
      ? { objectId: objectId.toLowerCase() }
      : {}),
  };
}

function readPosition(raw: unknown): PresencePosition {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: { anchor?: number; head?: number } = {};
  // Strings are dropped on purpose (see the module header): the relay refuses
  // them on a route, and this side must not start rendering one either.
  if (typeof r["anchor"] === "number" && Number.isFinite(r["anchor"])) out.anchor = r["anchor"];
  if (typeof r["head"] === "number" && Number.isFinite(r["head"])) out.head = r["head"];
  return out;
}

function readCounts(raw: unknown): RoutePresenceCounts | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const nums = ["people", "agents", "objects"] as const;
  for (const key of nums) {
    const value = r[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  }
  const byActor: Record<string, number> = {};
  const rawBy = r["objectsByActor"];
  if (rawBy !== undefined) {
    if (rawBy === null || typeof rawBy !== "object" || Array.isArray(rawBy)) return null;
    for (const [actorId, value] of Object.entries(rawBy as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
      byActor[actorId] = value;
    }
  }
  return {
    people: r["people"] as number,
    agents: r["agents"] as number,
    objects: r["objects"] as number,
    objectsByActor: byActor,
  };
}

/**
 * Counts from the peers we actually received.
 *
 * Used only when the server sent none, or when a state had to be dropped as
 * malformed (in which case the server's totals no longer describe what is on
 * screen). The input is the server's ALREADY-INTERSECTED list, so this adds no
 * knowledge — it is arithmetic over what we were allowed to be told, which is
 * the only thing a client may ever count.
 */
export function deriveCounts(peers: readonly RoutePeer[]): RoutePresenceCounts {
  const people = new Set<string>();
  const agents = new Set<string>();
  const objects = new Set<string>();
  const byActor = new Map<string, Set<string>>();
  for (const peer of peers) {
    if (peer.kind === "agent") agents.add(peer.actorId);
    else people.add(peer.actorId);
    if (peer.objectId) {
      objects.add(peer.objectId);
      let mine = byActor.get(peer.actorId);
      if (!mine) {
        mine = new Set<string>();
        byActor.set(peer.actorId, mine);
      }
      mine.add(peer.objectId);
    }
  }
  const objectsByActor: Record<string, number> = {};
  for (const [actorId, ids] of byActor) objectsByActor[actorId] = ids.size;
  return { people: people.size, agents: agents.size, objects: objects.size, objectsByActor };
}

/**
 * Parse one relay frame: `{"type":"presence","states":[…],"counts":{…}}`.
 *
 * Returns `null` for anything that is not a presence frame (the same socket
 * carries the doc epoch and whatever the server adds later), so an unknown
 * message can never blank the rail.
 */
export function readPresenceView(payload: string): RoutePresenceView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const message = parsed as Record<string, unknown>;
  if (message["type"] !== PRESENCE_MESSAGE) return null;
  const rawStates = message["states"];
  if (!Array.isArray(rawStates)) return null;

  const peers: RoutePeer[] = [];
  let dropped = false;
  for (const raw of rawStates) {
    const peer = readPeer(raw);
    if (peer) peers.push(peer);
    else dropped = true;
  }
  const sent = readCounts(message["counts"]);
  // The server's counts describe the states the server sent. If we could not
  // render all of them, they no longer describe the screen — recount from what
  // survived rather than showing a number the rail cannot account for.
  const counts = sent && !dropped ? sent : deriveCounts(peers);
  return { peers, counts };
}

/* ------------------------------------------------------------------ provider */

/** The provider surface a route room needs. Narrow so a fake is trivial. */
export interface PresenceProvider {
  /** publish our position on the relay's out-of-band channel. */
  sendStateless(payload: string): void;
  destroy(): void;
}

export interface PresenceProviderHandlers {
  onSynced(): void;
  onClose(event: { code?: number | undefined; reason?: string | undefined }): void;
  onStateless(payload: string): void;
}

export interface PresenceProviderArgs {
  url: string;
  /** the room name — a `route:` key, never an object id. */
  name: RouteRoomKey;
  handlers: PresenceProviderHandlers;
}

export type PresenceProviderFactory = (args: PresenceProviderArgs) => PresenceProvider;

const hocuspocusFactory: PresenceProviderFactory = ({ url, name, handlers }) => {
  // A route room carries NO document — only awareness frames. Hocuspocus still
  // wants a Y.Doc per connection, so it gets an empty one that nothing ever
  // writes to; it exists to satisfy the transport, not to hold state.
  const document = new Y.Doc();
  // `maxAttempts: 1` for the same reason as the doc rooms: a collab ticket is
  // SINGLE-USE, so the provider's own retry loop would replay a spent ticket
  // and be refused forever. Reconnection is this module's job.
  const socket = new HocuspocusProviderWebsocket({ url, maxAttempts: 1, quiet: true });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document,
    quiet: true,
    onSynced: () => handlers.onSynced(),
    onClose: ({ event }) => handlers.onClose({ code: event?.code, reason: event?.reason }),
    onDisconnect: ({ event }) => handlers.onClose({ code: event?.code, reason: event?.reason }),
    onAuthenticationFailed: ({ reason }) =>
      handlers.onClose({ code: COLLAB_CLOSE.UNAUTHORIZED, reason }),
    onStateless: ({ payload }) => handlers.onStateless(payload),
  });
  return {
    sendStateless(payload: string): void {
      provider.sendStateless(payload);
    },
    destroy(): void {
      provider.destroy();
      socket.destroy();
      document.destroy();
    },
  };
};

/* ------------------------------------------------------------------- session */

export type RoutePresenceStatus = "connecting" | "live" | "offline" | "denied";

export interface RoutePresenceState {
  readonly status: RoutePresenceStatus;
  /**
   * The last view the server sent — and EMPTY whenever the status is not
   * `live`. A rail is a claim about who is here right now; a disconnected tab
   * has nothing to claim.
   */
  readonly peers: readonly RoutePeer[];
  /** null unless live, for the same reason. */
  readonly counts: RoutePresenceCounts | null;
  /** why we are not live, for diagnostics. Never brain content. */
  readonly reason: string | null;
}

export const OFFLINE_PRESENCE: RoutePresenceState = {
  status: "offline",
  peers: [],
  counts: null,
  reason: null,
};

export interface JoinRoutePresenceOptions {
  /** the screen, e.g. `type/deal`. Refused if it is not a legal route key. */
  routeKey: string;
  origin?: string;
  mintTicket?: () => Promise<CollabTicket>;
  createProvider?: PresenceProviderFactory;
  onState?: (state: RoutePresenceState) => void;
  random?: () => number;
  /** injectable timer: returns its own canceller. */
  schedule?: (fn: () => void, ms: number) => () => void;
  heartbeatMs?: number;
  maxUnauthorizedRetries?: number;
}

export interface RoutePresenceSession {
  readonly room: RouteRoomKey;
  state(): RoutePresenceState;
  subscribe(listener: (state: RoutePresenceState) => void): () => void;
  /** publish an ephemeral caret position. Position only — never identity. */
  setPosition(position: PresencePosition): void;
  destroy(): void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

/**
 * Join a route room and keep it joined.
 *
 * Returns `null` for a route key the room grammar refuses — an illegal key is a
 * caller bug, and presence is not important enough to guess on someone's
 * behalf. The caller renders no rail.
 */
export function joinRoutePresence(opts: JoinRoutePresenceOptions): RoutePresenceSession | null {
  const key = routeRoomKey(opts.routeKey);
  if (!key) return null;
  // Bound after the guard so the room key is non-null inside the closures below
  // (a hoisted function declaration does not inherit the narrowing).
  const room: RouteRoomKey = key;

  const random = opts.random ?? Math.random;
  const schedule = opts.schedule ?? defaultSchedule;
  const mint = opts.mintTicket ?? mintCollabTicket;
  const createProvider = opts.createProvider ?? hocuspocusFactory;
  const heartbeatMs = opts.heartbeatMs ?? PRESENCE_HEARTBEAT_MS;
  const maxUnauthorized = opts.maxUnauthorizedRetries ?? 3;

  let provider: PresenceProvider | null = null;
  let status: RoutePresenceStatus = "connecting";
  let peers: readonly RoutePeer[] = [];
  let counts: RoutePresenceCounts | null = null;
  let reason: string | null = null;
  let position: PresencePosition = {};
  let attempt = 0;
  let unauthorized = 0;
  let destroyed = false;
  let cancelTimer: (() => void) | null = null;
  let cancelHeartbeat: (() => void) | null = null;
  /**
   * Bumped on every attempt AND every terminal event: hocuspocus fires
   * `onClose` and `onDisconnect` for a single drop, and a late callback from a
   * dead connection must never drive the machine twice.
   */
  let generation = 0;

  const listeners = new Set<(state: RoutePresenceState) => void>();

  function snapshot(): RoutePresenceState {
    return {
      status,
      // The one place the "down means gone" rule is enforced. Everything else
      // just has to avoid contradicting it.
      peers: status === "live" ? peers : [],
      counts: status === "live" ? counts : null,
      reason,
    };
  }

  function emit(): void {
    const state = snapshot();
    opts.onState?.(state);
    for (const listener of [...listeners]) listener(state);
  }

  function publish(): void {
    if (!provider || status !== "live") return;
    try {
      // Position ONLY. An identity key here would be stamped over by the relay
      // and logged as a protocol violation — correctly, since a peer does not
      // get to assert who it is.
      provider.sendStateless(JSON.stringify({ type: PRESENCE_MESSAGE, position }));
    } catch {
      /* a dead socket is the reconnect path's problem, not the caller's */
    }
  }

  function stopHeartbeat(): void {
    if (cancelHeartbeat) cancelHeartbeat();
    cancelHeartbeat = null;
  }

  /** Keep our entry alive: the relay sweeps anything quiet for PRESENCE_TTL_MS. */
  function beat(): void {
    stopHeartbeat();
    cancelHeartbeat = schedule(() => {
      cancelHeartbeat = null;
      publish();
      if (status === "live") beat();
    }, heartbeatMs);
  }

  function clearTimer(): void {
    if (cancelTimer) cancelTimer();
    cancelTimer = null;
  }

  function teardownProvider(): void {
    stopHeartbeat();
    if (provider) {
      try {
        provider.destroy();
      } catch {
        /* already gone */
      }
    }
    provider = null;
  }

  /** Terminal: the rail is simply not there for this session. */
  function deny(why: string): void {
    generation += 1;
    clearTimer();
    teardownProvider();
    status = "denied";
    reason = why;
    peers = [];
    counts = null;
    emit();
  }

  function scheduleReconnect(why: string): void {
    generation += 1;
    teardownProvider();
    status = "offline";
    reason = why;
    // Dropped, not remembered: this is what makes the rail disappear instead of
    // going stale.
    peers = [];
    counts = null;
    attempt += 1;
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

  function handleClose(gen: number, code: number | undefined, why: string | undefined): void {
    if (destroyed || gen !== generation) return;
    const detail = why && why !== "" ? why : "connection closed";
    // A bad origin is a bug or an attack; a refused room means this member may
    // not have presence here. Retrying fixes neither.
    if (code === COLLAB_CLOSE.BAD_ORIGIN || code === COLLAB_CLOSE.ROOM_FORBIDDEN) {
      deny(detail);
      return;
    }
    if (code === COLLAB_CLOSE.UNAUTHORIZED) {
      unauthorized += 1;
      if (unauthorized > maxUnauthorized) {
        deny("collab authorization refused");
        return;
      }
    }
    scheduleReconnect(detail);
  }

  async function open(): Promise<void> {
    if (destroyed) return;
    generation += 1;
    const gen = generation;
    teardownProvider();
    status = "connecting";
    peers = [];
    counts = null;
    emit();

    let ticket: CollabTicket;
    try {
      ticket = await mint();
    } catch (err) {
      if (destroyed || gen !== generation) return;
      const code = err instanceof CollabTicketError ? err.status : null;
      if (code === 401 || code === 403) {
        deny("not signed in");
        return;
      }
      scheduleReconnect("could not mint a collab ticket");
      return;
    }
    if (destroyed || gen !== generation) return;

    provider = createProvider({
      url: collabSocketUrl(ticket.ticket, opts.origin),
      name: room,
      handlers: {
        onSynced: () => {
          if (destroyed || gen !== generation) return;
          status = "live";
          reason = null;
          attempt = 0;
          unauthorized = 0;
          emit();
          // Announce ourselves immediately so peers see us without waiting a
          // heartbeat; the relay stamps the identity onto this frame.
          publish();
          beat();
        },
        onClose: (event) => handleClose(gen, event.code, event.reason),
        onStateless: (payload) => {
          if (destroyed || gen !== generation) return;
          const view = readPresenceView(payload);
          if (!view) return;
          // Wholesale replace, never merge: a peer who left is absent from the
          // next frame, and a merge would keep them on screen forever.
          peers = view.peers;
          counts = view.counts;
          emit();
        },
      },
    });
  }

  void open();

  return {
    room,
    state: snapshot,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPosition(next): void {
      position = {
        ...(next.anchor === undefined ? {} : { anchor: next.anchor }),
        ...(next.head === undefined ? {} : { head: next.head }),
      };
      publish();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      clearTimer();
      teardownProvider();
      listeners.clear();
    },
  };
}

/* ---------------------------------------------------------------------- hook */

/**
 * Route presence for one screen, as React state.
 *
 * `routeKey` of `null` (or an illegal key) is a legitimate answer — a screen
 * that has no room — and yields the offline state, which renders no rail.
 */
export function useRoutePresence(
  routeKey: string | null,
  opts?: Omit<JoinRoutePresenceOptions, "routeKey" | "onState">,
): RoutePresenceState {
  const [state, setState] = useState<RoutePresenceState>(OFFLINE_PRESENCE);

  // `opts` is a seam for tests and for a host with its own origin. It is read
  // through a ref, NOT listed as a dependency: a fresh object literal on every
  // render would tear the socket down and re-mint a ticket on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    setState(OFFLINE_PRESENCE);
    if (!routeKey) return;
    const session = joinRoutePresence({ ...(optsRef.current ?? {}), routeKey, onState: setState });
    if (!session) return;
    return () => session.destroy();
  }, [routeKey]);

  return state;
}

/* ------------------------------------------------------- screen → route key */

/**
 * The SPA's pathname reduced to a route-room key.
 *
 * This is a deliberately LOSSY map, and the loss is the point. A route key may
 * never embed an object id (`routeRoomKey` refuses one, mirroring the server's
 * `routeRoom`), because route rooms are joinable by anyone: a key like
 * `object/<uuid>` would make membership an oracle — join it, and the fact that
 * somebody else is there tells you a private object exists and is being read.
 * So every object page collapses to the single screen name `object`, and
 * "who is on THIS object" is answered by the object's own DOC room, which is
 * gated by an RLS join read.
 *
 * `null` for a screen that has no room (login, the OAuth hand-off) — a rail is
 * a nicety and a screen is allowed not to have one.
 */
export function routeKeyForPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "").toLowerCase();
  if (path === "" || path === "/") return "home";
  const segments = path.split("/").filter(Boolean);
  const head = segments[0] ?? "";
  switch (head) {
    case "search":
      return "search";
    case "graph":
      return "graph";
    case "files":
      return "files";
    case "private":
      return "private";
    case "members":
      return "members";
    case "connectors":
      return "connectors";
    case "branding":
      return "branding";
    // A TYPE is a screen and a shared vocabulary — never an object id.
    case "t": {
      const type = segments[1];
      return type && ROUTE_KEY_RE.test(type) && !UUID_ANYWHERE_RE.test(type)
        ? `type/${type}`
        : "type";
    }
    // Every object page is ONE screen. See the note above: the uuid must not
    // travel into a room key.
    case "o":
      return "object";
    case "login":
      return null;
    default:
      return null;
  }
}
