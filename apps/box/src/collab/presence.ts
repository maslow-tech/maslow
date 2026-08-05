import { randomUUID } from "node:crypto";

/**
 * THE PRESENCE RELAY: who is here, where their cursor is — and nothing else.
 *
 * Stock y-protocols awareness satisfies NEITHER property this design needs, so
 * both are enforced here, server-side, on the way out of the relay.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. IDENTITY IS STAMPED BY THE SERVER, NEVER AUTHORED BY THE CLIENT
 *
 * Awareness state is client-set in stock awareness: every peer publishes an
 * arbitrary blob and every other peer renders it. So any connected member could
 * publish a state claiming another member's `actorId` and name — or claiming to
 * be the agent — and the rail would draw it as real, next to genuine avatars,
 * with no way for a viewer to tell the difference. "Dana is editing this" is a
 * claim about a person; a person is not a thing a peer gets to assert.
 *
 * `stampPresenceState` therefore OVERWRITES `kind`, `actorId`, `name`, `color`
 * and `glyph` from the connection's authenticated principal, and reports any
 * client attempt to set them as a violation the caller can log and close on.
 *
 * The client-authored half is an ALLOWLIST, not a denylist, and that is the
 * load-bearing choice: a denylist of the five identity keys still lets a client
 * smuggle `objectId`, `title`, `path` or any other key of its invention through
 * the relay and onto every peer's screen — which is exactly the leak rule 2 is
 * about. Clients may author three scalar position fields and nothing else.
 * Unknown keys are dropped, nested values are dropped (a nested object is a
 * smuggling channel with a friendlier shape).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. PRESENCE IS FILTERED PER RECIPIENT, WHICH STOCK AWARENESS CANNOT DO
 *
 * Stock awareness relays each client's state VERBATIM to every peer in the room.
 * Doc rooms survive that, because a doc room is sharded to the visibility
 * boundary: everyone in it passed an RLS-bound join read for that one object, so
 * the room's own key is the answer to "may you see this".
 *
 * ROUTE ROOMS ARE NOT. The room key is the ROUTE ("the Deals table"), not the
 * object, so the members of one route room have no visibility relationship to
 * each other's open objects at all. A member with a private object open in
 * side-peek would, under verbatim relay, broadcast that object's id — and, once
 * the rail resolved it, its title — to everyone else on the route.
 *
 * The rule is therefore: **route-level awareness carries NO object identity on
 * the wire.** It carries human identity and position only. "Current object" is
 * server-side state (set from the doc room the actor actually joined, never from
 * anything the client says), resolved PER RECIPIENT against that recipient's own
 * RLS read, and omitted when they cannot see it. Every derived figure — the
 * avatar count, "Claude is editing 3 objects in Deals" — is computed AFTER that
 * intersection, never before, because a count computed before it is a
 * side-channel that says "something you cannot see exists".
 *
 * Two consequences, both intended:
 *
 *  - two people looking at the same view can see different counts. That is
 *    correct: each count is a statement about what THAT person may see;
 *  - a HUMAN whose current object a recipient cannot see stays in the rail,
 *    minus the object. Dropping them would be worse than useless — an avatar
 *    that blinks out the moment its owner opens something private is itself the
 *    announcement that they opened something private. An AGENT in the same
 *    position is dropped entirely: an agent has no independent reason to be on a
 *    route, its presence IS the write, so an agent entry with no visible object
 *    is nothing but a signal that an invisible write happened.
 *
 * Design invariants: presence rail parity; the privacy invariant holds
 * unchanged.
 */

/* ========================================================================== *
 * Room keys                                                                   *
 * ========================================================================== */

/** A room whose members all passed the RLS join read for ONE object. */
export type DocRoomKey = `doc:${string}`;
/** A room keyed by a ROUTE. Members share a screen, not a visibility boundary. */
export type RouteRoomKey = `route:${string}`;
export type PresenceRoomKey = DocRoomKey | RouteRoomKey;

/** Postgres refuses a non-uuid literal for a uuid column; pre-filter here too. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A route key is a SCREEN, and screens are a small closed vocabulary: a view
 * name, a type slug, a tab. It is deliberately narrow — lowercase, no spaces,
 * no percent-escapes — so that a room key cannot become a place to hide data.
 */
const ROUTE_KEY_RE = /^[a-z0-9][a-z0-9/:_.-]{0,119}$/;

/** Any uuid-shaped segment anywhere in a route key. */
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The room for one object's document. `null` for a non-uuid — a malformed id is
 * a definite refusal, not something to hash into a room name.
 *
 * The `doc:` / `route:` prefixes are what keep the two namespaces disjoint: no
 * route key can ever be spelled so as to land on a doc room (they differ in the
 * first character), so a member cannot reach an object-scoped room — which is
 * gated by the RLS join read — by asking for a route.
 */
export function docRoom(objectId: string): DocRoomKey | null {
  if (!UUID_RE.test(objectId)) return null;
  return `doc:${objectId.toLowerCase()}`;
}

/**
 * The room for one route.
 *
 * A key that EMBEDS AN OBJECT ID IS REFUSED. Route rooms are unauthenticated by
 * construction — anyone may name any route and see who else is in it — so a room
 * key like `object/<uuid>` would turn membership itself into an oracle: join it,
 * and the fact that somebody else is there tells you a private object exists and
 * is being read. Object-scoped presence has a room type of its own, and it is
 * gated (`docRoom`).
 */
export function routeRoom(routeKey: string): RouteRoomKey | null {
  const key = routeKey.trim().toLowerCase();
  if (!ROUTE_KEY_RE.test(key)) return null;
  if (UUID_ANYWHERE_RE.test(key)) return null;
  return `route:${key}`;
}

export function isDocRoom(room: PresenceRoomKey): room is DocRoomKey {
  return room.startsWith("doc:");
}

/**
 * Validate a RAW hocuspocus document name that claims to be a route room, and
 * return the `RouteRoomKey` only if it survives `routeRoom`'s full contract:
 * the narrow charset, the 119-char bound, and — the load-bearing one — the
 * refusal of any uuid-embedding key. Any wire name that is not already the
 * normalized form `routeRoom` would produce is refused (returns null).
 *
 * The client (`routePresence.ts routeRoomKey`) mirrors `routeRoom` exactly, so
 * a legitimate route name always passes; this is the SERVER's enforcement of
 * the same invariant, without which `isRouteRoomName` alone would admit
 * `route:<uuid>` or an unbounded/arbitrary-charset key straight into a presence
 * room — an insider oracle + memory-growth vector. Both the join authorizer and
 * the presence room-key derivation must go through this, not `isRouteRoomName`.
 */
export function routeRoomFromName(documentName: string): RouteRoomKey | null {
  if (!isRouteRoomName(documentName)) return null;
  const validated = routeRoom(documentName.slice("route:".length));
  // Require the wire name to already BE the normalized key: `routeRoom` trims
  // and lowercases, so `route:Deals` would validate to `route:deals` — a
  // mismatch we refuse rather than silently re-home onto a different room.
  return validated === documentName ? validated : null;
}

/**
 * Is this raw hocuspocus document name a ROUTE (presence-only) room?
 *
 * A route room has no object to authorize against — its join gate checks the
 * account only (`authorizeRoom` in wire.ts skips `canJoin` for it). Any surface
 * that re-derives authorization from a document name (the reauth loop) MUST use
 * this to avoid running the object-visibility probe against a non-uuid name,
 * which the probe reads as "denied" and would evict every presence connection.
 */
export function isRouteRoomName(documentName: string): boolean {
  return documentName.startsWith("route:");
}

/** The object a doc room is sharded to — the room's own visibility answer. */
export function roomObjectId(room: DocRoomKey): string {
  return room.slice("doc:".length);
}

/* ========================================================================== *
 * Identity — server-stamped                                                   *
 * ========================================================================== */

export type PresenceKind = "human" | "agent";

/**
 * The identity half of a presence state. EVERY field here is written by the
 * server from the connection's authenticated principal; none of it is ever read
 * from the client's payload.
 */
export interface PresenceIdentity {
  readonly kind: PresenceKind;
  readonly actorId: string;
  readonly name: string;
  /**
   * A THEME TOKEN, not a colour. The dashboard renders in two skins, so the
   * server has no business choosing an ink — it chooses a stable slot and the
   * skin decides what that looks like.
   */
  readonly color: string;
  /** `robot` for the agent; otherwise the member's initials. Never free text. */
  readonly glyph: string;
}

/** What the caller knows about the principal behind a connection. */
export interface PresencePrincipal {
  readonly kind: PresenceKind;
  readonly actorId: string;
  /** the account's display name, read server-side. Bounded here regardless. */
  readonly name?: string | undefined;
}

/** The keys a client may never author. Overwritten, and reported when present. */
const PRESENCE_IDENTITY_KEYS = ["kind", "actorId", "name", "color", "glyph"] as const;

/** How many human colour slots the skins define. */
const PRESENCE_PALETTE_SIZE = 8;

const MAX_NAME_LENGTH = 48;
const MAX_AT_LENGTH = 64;
/** A caret offset in a document that is capped at a few MB. Anything beyond is noise. */
const MAX_POSITION = 100_000_000;

/**
 * Drop control characters and anything that would let a name draw as markup.
 *
 * The name is server-supplied (it comes from `accounts`), so this is not a trust
 * boundary — it is a bound. A presence state is rendered by every peer in the
 * room, and one 4KB display name would be a room-wide layout accident.
 */
function sanitizeName(raw: string | undefined, fallback: string): string {
  let kept = "";
  for (const ch of raw ?? "") {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (ch === "<" || ch === ">") continue;
    kept += ch;
  }
  const value = kept.trim();
  if (!value) return fallback;
  return value.slice(0, MAX_NAME_LENGTH);
}

/** FNV-1a — a stable slot per actor, so an avatar keeps its colour across reloads. */
function hashSlot(value: string, buckets: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
}

/** The agent has one reserved slot; nobody else can land on it. */
function presenceColor(principal: PresencePrincipal): string {
  if (principal.kind === "agent") return "presence-agent";
  return `presence-${hashSlot(principal.actorId, PRESENCE_PALETTE_SIZE) + 1}`;
}

function presenceGlyph(kind: PresenceKind, name: string): string {
  if (kind === "agent") return "robot";
  // Index by CODE POINT, never UTF-16 code unit: an astral first character (an
  // emoji, or a script outside the BMP) is a surrogate PAIR, and `part[0]` /
  // `name.slice(0,1)` would return a lone half-surrogate that renders as a
  // replacement box. This is the server-side twin of the client caret fix
  // (AgentCursor.initialOf, `Array.from(name)[0]`); the client renders this
  // glyph verbatim and never recomputes it, so the whole-code-point read must
  // happen here.
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0] ?? "")
    .join("");
  return (initials || [...name][0] || "?").toUpperCase();
}

/** Build the stamp. The ONE place a presence identity is allowed to come from. */
export function presenceIdentity(principal: PresencePrincipal): PresenceIdentity {
  const name = sanitizeName(principal.name, principal.kind === "agent" ? "Agent" : "Member");
  return {
    kind: principal.kind,
    actorId: principal.actorId,
    name,
    color: presenceColor(principal),
    glyph: presenceGlyph(principal.kind, name),
  };
}

/* ========================================================================== *
 * Position — the only thing a client authors                                  *
 * ========================================================================== */

/**
 * Ephemeral position, flat and scalar. `anchor`/`head` are caret offsets;
 * `at` is a document-local field key (which block the caret is in).
 */
export interface PresencePosition {
  readonly anchor?: number;
  readonly head?: number;
  readonly at?: string;
}

function finiteOffset(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const value = Math.trunc(raw);
  if (value < 0 || value > MAX_POSITION) return undefined;
  return value;
}

/**
 * Reduce whatever the client sent to the allowlist.
 *
 * `allowStrings` is FALSE FOR ROUTE ROOMS, and that is not fussiness: `at` is a
 * document-local key inside a doc room, but on a route — a table — the natural
 * thing for a client to put there is the ROW key, and a row key is an object id.
 * Strings on a route are a place to hide identity, so route positions are
 * numbers only. Nothing renders worse for it: the rail draws avatars, and
 * "which object" comes from the server's per-recipient resolution.
 */
export function sanitizePosition(
  raw: unknown,
  opts: { readonly allowStrings: boolean },
): { readonly position: PresencePosition; readonly dropped: readonly string[] } {
  const dropped: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { position: {}, dropped };
  }
  const source = raw as Record<string, unknown>;
  const position: { anchor?: number; head?: number; at?: string } = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "anchor" || key === "head") {
      const offset = finiteOffset(value);
      if (offset === undefined) {
        dropped.push(key);
        continue;
      }
      position[key] = offset;
      continue;
    }
    if (key === "at") {
      if (!opts.allowStrings || typeof value !== "string" || value.length === 0) {
        dropped.push(key);
        continue;
      }
      position.at = value.slice(0, MAX_AT_LENGTH);
      continue;
    }
    dropped.push(key);
  }
  return { position, dropped };
}

/* ========================================================================== *
 * The stamp                                                                   *
 * ========================================================================== */

interface StampedPresence {
  readonly identity: PresenceIdentity;
  readonly position: PresencePosition;
  /** every client key that did not survive — identity spoofs and unknown keys. */
  readonly rejected: readonly string[];
  /**
   * true when the client tried to author an IDENTITY key. A well-behaved client
   * never does, so this is a protocol violation worth logging (and, repeated,
   * worth closing on) rather than a harmless stray field.
   */
  readonly spoofed: boolean;
}

/**
 * Take one client-published awareness payload and return what the relay will
 * actually hold: the server's identity, the allowlisted position, and the list
 * of everything discarded.
 */
export function stampPresenceState(
  principal: PresencePrincipal,
  clientState: unknown,
  opts: { readonly room: PresenceRoomKey },
): StampedPresence {
  const identity = presenceIdentity(principal);
  const isDoc = isDocRoom(opts.room);
  const rejected: string[] = [];
  let spoofed = false;

  let payload: Record<string, unknown> = {};
  if (clientState !== null && typeof clientState === "object" && !Array.isArray(clientState)) {
    payload = clientState as Record<string, unknown>;
  }
  for (const key of PRESENCE_IDENTITY_KEYS) {
    if (Object.hasOwn(payload, key)) {
      spoofed = true;
      rejected.push(key);
    }
  }
  const positionSource: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if ((PRESENCE_IDENTITY_KEYS as readonly string[]).includes(key)) continue;
    positionSource[key] = value;
  }
  const { position, dropped } = sanitizePosition(positionSource, { allowStrings: isDoc });
  rejected.push(...dropped);

  return { identity, position, rejected, spoofed };
}

/* ========================================================================== *
 * The per-recipient filter                                                    *
 * ========================================================================== */

/**
 * What the relay holds about one participant. `objectId` is SERVER-SIDE TRUTH
 * and never leaves this process unless the per-recipient filter keeps it.
 */
export interface PresenceEntry {
  readonly clientId: string;
  readonly identity: PresenceIdentity;
  readonly position: PresencePosition;
  /** the doc room this actor is actually in, as OBSERVED by the server. */
  readonly objectId: string | null;
}

/** One participant, as one recipient is allowed to see them. */
export interface PresenceWireState {
  readonly clientId: string;
  readonly kind: PresenceKind;
  readonly actorId: string;
  readonly name: string;
  readonly color: string;
  readonly glyph: string;
  readonly position: PresencePosition;
  /** present ONLY when this recipient's own RLS read returned the object. */
  readonly objectId?: string;
}

/** Every figure here is computed AFTER the intersection. That is the point. */
export interface PresenceCounts {
  /** distinct human actors this recipient may be told about. */
  readonly people: number;
  /** distinct agent actors, counted only where they have a visible object. */
  readonly agents: number;
  /** distinct objects being edited that THIS recipient can see. */
  readonly objects: number;
  /** per actor — "Claude is editing 3 objects in Deals", after the intersection. */
  readonly objectsByActor: Readonly<Record<string, number>>;
}

export interface PresenceView {
  readonly states: readonly PresenceWireState[];
  readonly counts: PresenceCounts;
}

/**
 * Reduce the room's server-side entries to what ONE recipient may receive.
 *
 * `recipientVisibleIds` is the result of THAT RECIPIENT's own RLS read — never
 * the publisher's, and never a cached answer for someone else. It is a subset of
 * the ids the room is holding, so an empty set is a perfectly normal answer
 * (nobody in the room has anything this recipient can see) and never a reason to
 * suppress the room.
 */
export function filterForRecipient(
  states: readonly PresenceEntry[],
  recipientVisibleIds: ReadonlySet<string> | readonly string[],
): PresenceView {
  const visible: ReadonlySet<string> = Array.isArray(recipientVisibleIds)
    ? new Set(recipientVisibleIds)
    : (recipientVisibleIds as ReadonlySet<string>);

  const out: PresenceWireState[] = [];
  const people = new Set<string>();
  const agents = new Set<string>();
  const objects = new Set<string>();
  const byActor = new Map<string, Set<string>>();

  for (const entry of states) {
    const seen = entry.objectId !== null && visible.has(entry.objectId);
    // THE ONE PLACE `kind` IS CONSULTED, AND IT ONLY EVER SUBTRACTS.
    //
    // An agent's presence IS the write. With no object this recipient can see,
    // an agent entry is nothing but the announcement that an invisible write
    // happened — so it does not exist for them, and it counts for nothing.
    //
    // Note the direction: every agent entry goes through the SAME `visible`
    // intersection a human's does, and the kind check can only take an entry
    // AWAY. There is no branch anywhere in this function that lets an agent
    // carry an object id, or contribute to a count, on any grounds other than
    // this recipient's own read — a shortcut of that shape ("it's only the
    // agent, publish it to the room") is exactly how the privacy invariant
    // would be lost, and it would be lost silently.
    if (entry.identity.kind === "agent" && !seen) continue;

    const state: PresenceWireState = {
      clientId: entry.clientId,
      kind: entry.identity.kind,
      actorId: entry.identity.actorId,
      name: entry.identity.name,
      color: entry.identity.color,
      glyph: entry.identity.glyph,
      position: entry.position,
      // The omission is the whole mechanism: a human stays in the rail, their
      // private object does not travel with them.
      ...(seen && entry.objectId ? { objectId: entry.objectId } : {}),
    };
    out.push(state);

    if (state.kind === "agent") agents.add(state.actorId);
    else people.add(state.actorId);

    if (seen && entry.objectId) {
      objects.add(entry.objectId);
      let mine = byActor.get(state.actorId);
      if (!mine) {
        mine = new Set<string>();
        byActor.set(state.actorId, mine);
      }
      mine.add(entry.objectId);
    }
  }

  const objectsByActor: Record<string, number> = {};
  for (const [actorId, ids] of byActor) objectsByActor[actorId] = ids.size;

  return {
    states: out,
    counts: {
      people: people.size,
      agents: agents.size,
      objects: objects.size,
      objectsByActor,
    },
  };
}

/* ========================================================================== *
 * The relay                                                                   *
 * ========================================================================== */

/** A stale entry is a socket that died without saying goodbye. */
const PRESENCE_TTL_MS = 45_000;

/**
 * A ceiling on one room. Presence is a fan-out: N members means N views built
 * and N sends per broadcast, and a route room is joinable by anyone. The cap
 * bounds that on a box where "everyone opened the Deals tab" is a normal Monday.
 */
const PRESENCE_MAX_MEMBERS = 200;

export interface PresenceHandle {
  readonly room: PresenceRoomKey;
  readonly clientId: string;
}

/**
 * Which of `objectIds` may `actorId` see? MUST be an RLS-bound read as that
 * actor (the same read `probeJoin` does), never a predicate re-implemented in
 * application code — there is one visibility rule and it lives in Postgres.
 */
type PresenceVisibility = (
  actorId: string,
  objectIds: readonly string[],
) => Promise<readonly string[]> | readonly string[];

interface PresenceRelayOptions {
  /** deliver one recipient's view. Must not throw; a bad socket is not our problem. */
  readonly send: (recipient: PresenceHandle, view: PresenceView) => void;
  /**
   * Absent ⇒ FAIL CLOSED: no route-room entry ever carries an object id. The
   * relay still works (avatars, cursors), it simply resolves nothing.
   */
  readonly visibleTo?: PresenceVisibility | undefined;
  /** a client that authored an identity key. Logging / closing, never the client. */
  readonly onViolation?: ((handle: PresenceHandle, keys: readonly string[]) => void) | undefined;
  /**
   * Called for EACH member `sweep()` drops (a socket that died without an
   * `onDisconnect`). The relay reaps its own member map; this is where a caller
   * reaps whatever it keyed on the same connection — the wiring's socket sink
   * and handle maps — so a stale entry does not outlive the member it mirrored.
   */
  readonly onReap?: ((handle: PresenceHandle) => void) | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxMembers?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface PresenceStats {
  readonly rooms: number;
  readonly members: number;
  /** client payloads that tried to author an identity key. */
  readonly violations: number;
  /** per-recipient visibility reads issued. */
  readonly resolves: number;
  /** visibility reads that failed and were treated as "sees nothing". */
  readonly resolveErrors: number;
}

export interface PresenceRelay {
  /**
   * Add a connection to a room. `null` when the room is at its ceiling — the
   * caller refuses the presence channel and leaves the editor alone; presence is
   * a nicety and must never be the reason somebody cannot type.
   */
  join(
    room: PresenceRoomKey,
    principal: PresencePrincipal,
    opts?: { readonly clientId?: string },
  ): PresenceHandle | null;
  /** Remove one connection. Idempotent; drops the room when it empties. */
  leave(handle: PresenceHandle): void;
  /** Apply a client-published payload: stamped, allowlisted, never trusted. */
  update(handle: PresenceHandle, clientState: unknown): void;
  /**
   * Record which object this connection is actually editing.
   *
   * SERVER-OBSERVED ONLY. The caller passes the object whose DOC ROOM this actor
   * has joined — which means an RLS-bound read already said yes. It is never
   * taken from a client payload (`objectId` is not on the position allowlist for
   * precisely that reason), so a client cannot claim to be editing something.
   */
  focus(handle: PresenceHandle, objectId: string | null): void;
  /** Build and deliver one view per recipient. Never throws. */
  broadcast(room: PresenceRoomKey): Promise<void>;
  /** The room's server-side entries — diagnostics and tests, never the wire. */
  entries(room: PresenceRoomKey): PresenceEntry[];
  /** Drop entries whose connection stopped talking. Returns how many. */
  sweep(): number;
  size(room: PresenceRoomKey): number;
  stats(): PresenceStats;
}

interface MemberRecord {
  readonly clientId: string;
  readonly principal: PresencePrincipal;
  identity: PresenceIdentity;
  position: PresencePosition;
  objectId: string | null;
  touchedAt: number;
}

export function createPresenceRelay(opts: PresenceRelayOptions): PresenceRelay {
  const now = opts.now ?? ((): number => Date.now());
  const ttlMs = opts.ttlMs ?? PRESENCE_TTL_MS;
  const maxMembers = opts.maxMembers ?? PRESENCE_MAX_MEMBERS;
  const rooms = new Map<PresenceRoomKey, Map<string, MemberRecord>>();
  const counts = { violations: 0, resolves: 0, resolveErrors: 0 };

  const toEntry = (member: MemberRecord): PresenceEntry => ({
    clientId: member.clientId,
    identity: member.identity,
    position: member.position,
    objectId: member.objectId,
  });

  const memberOf = (handle: PresenceHandle): MemberRecord | undefined =>
    rooms.get(handle.room)?.get(handle.clientId);

  /**
   * One recipient's own answer to "which of these may I see".
   *
   * Fail closed on an unreadable database: an unresolvable set is treated as
   * EMPTY, so the rail loses object identity for a poll and keeps its avatars.
   * The alternative — assuming visible — publishes a private object's id on the
   * strength of Postgres having hiccuped.
   */
  const resolveVisible = async (
    actorId: string,
    candidates: readonly string[],
  ): Promise<ReadonlySet<string>> => {
    if (candidates.length === 0 || !opts.visibleTo) return new Set<string>();
    counts.resolves += 1;
    try {
      const allowed = await opts.visibleTo(actorId, candidates);
      // Never widen: an implementation that returned ids we did not ask about
      // must not be able to inject one.
      const asked = new Set(candidates);
      return new Set(allowed.filter((id) => asked.has(id)));
    } catch (err) {
      counts.resolveErrors += 1;
      console.warn("collab presence: visibility read failed —", String(err));
      return new Set<string>();
    }
  };

  const deliver = (room: PresenceRoomKey, member: MemberRecord, view: PresenceView): void => {
    // An agent has no socket in the room; its entry is published on its behalf.
    if (member.identity.kind === "agent") return;
    try {
      opts.send({ room, clientId: member.clientId }, view);
    } catch (err) {
      console.warn("collab presence: send failed —", String(err));
    }
  };

  return {
    join(room, principal, joinOpts): PresenceHandle | null {
      let members = rooms.get(room);
      if (!members) {
        members = new Map<string, MemberRecord>();
        rooms.set(room, members);
      }
      const clientId = joinOpts?.clientId ?? randomUUID();
      if (!members.has(clientId) && members.size >= maxMembers) {
        if (members.size === 0) rooms.delete(room);
        return null;
      }
      members.set(clientId, {
        clientId,
        principal,
        identity: presenceIdentity(principal),
        position: {},
        // A doc room's member is, by definition, editing that room's object —
        // and got in only by passing the join read for it.
        objectId: isDocRoom(room) ? roomObjectId(room) : null,
        touchedAt: now(),
      });
      return { room, clientId };
    },

    leave(handle): void {
      const members = rooms.get(handle.room);
      if (!members) return;
      members.delete(handle.clientId);
      if (members.size === 0) rooms.delete(handle.room);
    },

    update(handle, clientState): void {
      const member = memberOf(handle);
      if (!member) return;
      const stamped = stampPresenceState(member.principal, clientState, { room: handle.room });
      // The identity is re-stamped every time, not merged: a payload cannot
      // erode it one key at a time either.
      member.identity = stamped.identity;
      member.position = stamped.position;
      member.touchedAt = now();
      if (stamped.spoofed) {
        counts.violations += 1;
        try {
          opts.onViolation?.(handle, stamped.rejected);
        } catch {
          /* an observer must never break the relay */
        }
      }
    },

    focus(handle, objectId): void {
      const member = memberOf(handle);
      if (!member) return;
      // A doc room's object is the room's own; nothing may re-point it.
      if (isDocRoom(handle.room)) return;
      member.objectId = objectId && UUID_RE.test(objectId) ? objectId.toLowerCase() : null;
      member.touchedAt = now();
    },

    async broadcast(room): Promise<void> {
      const members = rooms.get(room);
      if (!members || members.size === 0) return;
      const entries = [...members.values()].map(toEntry);

      // A doc room IS the visibility boundary — every member passed the RLS join
      // read for exactly this object — so there is one answer for everybody and
      // no per-recipient read at all.
      if (isDocRoom(room)) {
        const visible = new Set([roomObjectId(room)]);
        const view = filterForRecipient(entries, visible);
        for (const member of members.values()) deliver(room, member, view);
        return;
      }

      const candidates = [
        ...new Set(entries.map((e) => e.objectId).filter((id): id is string => id !== null)),
      ];
      // One read per ACTOR, not per connection: three tabs cost one read.
      const perActor = new Map<string, Promise<ReadonlySet<string>>>();
      await Promise.all(
        [...members.values()].map(async (member) => {
          if (member.identity.kind === "agent") return;
          const actorId = member.identity.actorId;
          let pending = perActor.get(actorId);
          if (!pending) {
            pending = resolveVisible(actorId, candidates);
            perActor.set(actorId, pending);
          }
          deliver(room, member, filterForRecipient(entries, await pending));
        }),
      );
    },

    entries(room): PresenceEntry[] {
      const members = rooms.get(room);
      return members ? [...members.values()].map(toEntry) : [];
    },

    sweep(): number {
      const cutoff = now() - ttlMs;
      let dropped = 0;
      for (const [room, members] of rooms) {
        for (const [clientId, member] of members) {
          if (member.touchedAt <= cutoff) {
            members.delete(clientId);
            dropped += 1;
            if (opts.onReap) {
              try {
                opts.onReap({ room, clientId });
              } catch {
                /* a reap observer must never break the sweep */
              }
            }
          }
        }
        if (members.size === 0) rooms.delete(room);
      }
      return dropped;
    },

    size(room): number {
      return rooms.get(room)?.size ?? 0;
    },

    stats(): PresenceStats {
      let members = 0;
      for (const room of rooms.values()) members += room.size;
      return {
        rooms: rooms.size,
        members,
        violations: counts.violations,
        resolves: counts.resolves,
        resolveErrors: counts.resolveErrors,
      };
    },
  };
}

/* ========================================================================== *
 * Agent clients — the synthetic presence behind an external write (phase 5)   *
 * ========================================================================== */

/**
 * How long an agent's cursor lingers after its last move before it leaves.
 *
 * Long enough that a person who looked up at the wrong moment still sees WHO
 * wrote the paragraph that just appeared; short enough that a robot avatar is
 * never sitting in the rail claiming to be present when nothing is happening.
 * A human's cursor disappears when their socket goes; an agent has no socket,
 * so idleness is the only thing that can stand in for one.
 */
export const AGENT_PRESENCE_IDLE_MS = 5_000;

/** The real actor behind an external write: an agent token, an MCP caller, a cron. */
export interface AgentActor {
  readonly actorId: string;
  /** the account's display name, read server-side from `accounts`. */
  readonly name?: string | undefined;
}

/**
 * The relay surface an agent client needs. `createPresenceRelay(...)` satisfies
 * it structurally; a test can supply a stub.
 */
type AgentPresenceRelay = Pick<
  PresenceRelay,
  "join" | "leave" | "update" | "focus" | "broadcast" | "size" | "entries"
>;

/** One live agent client. Every method is a no-op once it has been released. */
export interface AgentPresenceSession {
  readonly handle: PresenceHandle;
  /** what the room will show — server-stamped, exactly as a human's is. */
  readonly identity: PresenceIdentity;
  /** Move the cursor/selection (phase 5's travelling cursor) and re-arm the idle timer. */
  moveTo(position: PresencePosition): void;
  /**
   * Route rooms only: which object this agent is editing (SERVER-OBSERVED — the
   * object the caller is actually writing to, never anything a client said).
   * A doc room's object is the room's own and cannot be re-pointed.
   */
  focus(objectId: string | null): void;
  /** Re-arm the idle timer without moving — "still working here". */
  touch(): void;
  /** Leave now. Idempotent. */
  release(): void;
}

/**
 * How many objects one agent may be visibly holding in ONE route room.
 *
 * A robot writing forty rows of a table is a real thing that happens, and each
 * row it is still lingering on is one more client in that room. Two reasons the
 * number is small: a route room has a ceiling (`PRESENCE_MAX_MEMBERS`) and a
 * bulk write must never be the reason a PERSON cannot join the rail; and "Claude
 * is editing 6 objects" is already the whole message — 40 would be a number
 * nobody reads. Past the cap the OLDEST cursor gives way to the newest write, so
 * the figure understates a big write and never overstates one.
 */
const AGENT_MAX_ROUTE_CLIENTS = 6;

interface AgentPresenceOptions {
  readonly relay: AgentPresenceRelay;
  readonly idleMs?: number | undefined;
  /** route rooms only; defaults to `AGENT_MAX_ROUTE_CLIENTS`. */
  readonly maxRouteClients?: number | undefined;
}

/** What the caller knows about WHERE the write is landing. */
export interface AgentEnterOptions {
  /**
   * The object this write is about, as the SERVER observed it (the row the
   * caller is writing). REQUIRED for a route room — see refusal 4 — and ignored
   * for a doc room, whose object is the room's own and cannot be re-pointed.
   */
  readonly objectId?: string | null;
}

export interface AgentPresence {
  /**
   * Publish an agent into a room that ALREADY has members. `null` when it must
   * not appear at all — see `enter`'s refusals below; a caller treats `null` as
   * "apply the write silently", never as an error.
   */
  enter(
    room: PresenceRoomKey,
    actor: AgentActor,
    opts?: AgentEnterOptions,
  ): AgentPresenceSession | null;
  /** Live agent clients across all rooms. Diagnostics and tests. */
  size(): number;
  /** Release every agent client (process shutdown). */
  releaseAll(): void;
}

interface AgentRecord {
  /** `room \0 actor \0 object` — mutable, because a cursor may be re-pointed. */
  key: string;
  readonly room: PresenceRoomKey;
  readonly actorId: string;
  readonly handle: PresenceHandle;
  readonly identity: PresenceIdentity;
  /** the object this client is pointed at. The relay holds the authoritative copy. */
  objectId: string | null;
  /** monotonic entry order, so the cap can retire the oldest cursor. */
  readonly seq: number;
  session: AgentPresenceSession | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  released: boolean;
}

/**
 * The agent's side of the relay: a SYNTHETIC awareness client, joined on an
 * agent's behalf for the length of one external write.
 *
 * Three refusals, and each of them is the privacy invariant rather than
 * fussiness:
 *
 *  1. AN AGENT NEVER CREATES A ROOM. `enter` refuses a room with no members,
 *     so an agent writing to an object nobody has open produces no room, no
 *     entry and no count — the same rule the bridge already obeys against the
 *     doc store, enforced again here because presence rooms are a second,
 *     independent set of rooms. An agent's presence IS the write, so a room
 *     conjured for it would itself be the announcement that a write happened.
 *  2. IDENTITY IS NOT AN ARGUMENT. The caller passes an actor, never a `kind`:
 *     the principal is built here as `kind: "agent"`, and the relay stamps
 *     colour and glyph from it (`presence-agent`, `robot` — a palette slot
 *     disjoint from the human one, so a robot is never mistaken for a person).
 *     Nothing reachable from a socket can construct one of these.
 *  3. A PERSON WHO IS HERE IS NOT REDRAWN AS A ROBOT. If the writing actor
 *     already has a human client in the room (a cron running as somebody's
 *     actor while they are editing), no agent client is published: their real
 *     avatar is already in the rail, and a second robot avatar wearing their
 *     name would be a lie about who is at the keyboard.
 *  4. ON A ROUTE, AN AGENT WITHOUT AN OBJECT IS NOT PUBLISHED AT ALL. A route
 *     room's agent entry earns its place only through `filterForRecipient`,
 *     which drops an agent with no visible object — so an agent entered with no
 *     object is an entry NOBODY can ever be shown: it occupies a slot under the
 *     room ceiling, costs a fan-out per broadcast, and exists only as a
 *     temptation to "just show it" the day somebody reads the filter too
 *     quickly. The object is passed to `enter` and applied BEFORE the first
 *     broadcast, so the first frame a viewer sees is already the resolved one
 *     rather than an unpointed robot that vanishes a tick later. (A doc room is
 *     exempt: its object is the room's own key, and every member passed the RLS
 *     join read for it.)
 *
 * A robot writing several rows of one table therefore holds one client PER
 * OBJECT in that route room — which is what makes "Claude is editing 3 objects
 * in Deals" a true sentence rather than a guess, since the figure is
 * `filterForRecipient`'s count of the objects THIS viewer can see among them.
 * The clients are capped (`AGENT_MAX_ROUTE_CLIENTS`) and each expires on its own
 * linger, so the number decays back to nothing on its own.
 *
 * What is NOT here is as load-bearing: nothing in this file publishes an agent
 * on a path of its own. It joins the same relay, gets the same server stamp, and
 * reaches a viewer only through the same per-recipient intersection a human goes
 * through — the rail's "Claude is editing 3 objects in Deals" is that filter's
 * arithmetic, not a figure computed here.
 *
 * Design invariants: named awareness identity; presence rail parity.
 */
export function createAgentPresence(opts: AgentPresenceOptions): AgentPresence {
  const relay = opts.relay;
  const idleMs = opts.idleMs ?? AGENT_PRESENCE_IDLE_MS;
  const maxRouteClients = Math.max(1, opts.maxRouteClients ?? AGENT_MAX_ROUTE_CLIENTS);
  const live = new Map<string, AgentRecord>();
  let seq = 0;

  /**
   * The registry key: ONE live client per (room, actor, object).
   *
   * A doc room collapses to one per actor — its object is the room itself. A
   * route room does not, and must not: a robot holding three rows of a table is
   * three cursors, which is precisely what makes "editing 3 objects" a count of
   * something real rather than a number this file made up.
   */
  const keyFor = (room: PresenceRoomKey, actorId: string, objectId: string | null): string =>
    `${room}\0${actorId}\0${isDocRoom(room) ? "" : (objectId ?? "")}`;

  const publish = (room: PresenceRoomKey): void => {
    void Promise.resolve(relay.broadcast(room)).catch((err: unknown) => {
      console.warn("collab presence: agent broadcast failed —", String(err));
    });
  };

  const release = (record: AgentRecord): void => {
    if (record.released) return;
    record.released = true;
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    if (live.get(record.key) === record) live.delete(record.key);
    relay.leave(record.handle);
    publish(record.room);
  };

  /** (Re)start the linger. Called on every move, so a busy agent stays put. */
  const arm = (record: AgentRecord): void => {
    if (record.released) return;
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      record.timer = undefined;
      release(record);
    }, idleMs);
    record.timer.unref?.();
  };

  /**
   * Move a live client onto another object, keeping the registry honest.
   *
   * Without this, a cursor re-pointed through `session.focus` would still be
   * filed under the object it ENTERED on, and the next `enter` for the object it
   * actually sits on would publish a second robot wearing the same name.
   */
  const rekey = (record: AgentRecord, objectId: string | null): void => {
    // Normalized exactly as the relay normalizes it, so the registry and the
    // room can never disagree about which object a cursor is on.
    const id =
      typeof objectId === "string" && UUID_RE.test(objectId) ? objectId.toLowerCase() : null;
    const next = keyFor(record.room, record.actorId, id);
    record.objectId = id;
    if (next === record.key) return;
    // One client per object: whatever was filed here gives way rather than
    // being silently orphaned in a room nobody will ever release it from.
    const holder = live.get(next);
    if (holder && holder !== record) release(holder);
    if (live.get(record.key) === record) live.delete(record.key);
    record.key = next;
    live.set(next, record);
  };

  const sessionFor = (record: AgentRecord): AgentPresenceSession => {
    if (record.session) return record.session;
    const session: AgentPresenceSession = {
      handle: record.handle,
      identity: record.identity,
      moveTo(position): void {
        if (record.released) return;
        // Through the relay's own update path, so the agent's position is
        // allowlisted exactly like a client's and its identity re-stamped.
        relay.update(record.handle, { ...position });
        arm(record);
        publish(record.room);
      },
      focus(objectId): void {
        if (record.released) return;
        relay.focus(record.handle, objectId);
        // A doc room ignores the move (its object is its key), so mirror what
        // the relay actually did rather than what we were asked to do.
        rekey(record, isDocRoom(record.room) ? record.objectId : objectId);
        arm(record);
        publish(record.room);
      },
      touch(): void {
        arm(record);
      },
      release(): void {
        release(record);
      },
    };
    record.session = session;
    return session;
  };

  return {
    enter(room, actor, enterOpts): AgentPresenceSession | null {
      // A malformed actor id is a definite refusal: an avatar with no real
      // actor behind it is exactly the unforgeable claim this file exists for.
      if (!UUID_RE.test(actor.actorId)) return null;
      const actorId = actor.actorId.toLowerCase();
      const isDoc = isDocRoom(room);

      // Refusal 4 (see the header): a doc room's object is its own key; a route
      // room's must be supplied, because an agent that is nowhere is an entry no
      // recipient can ever be shown.
      const raw = enterOpts?.objectId;
      const focusId = typeof raw === "string" && UUID_RE.test(raw) ? raw.toLowerCase() : null;
      if (!isDoc && focusId === null) return null;

      const key = keyFor(room, actorId, focusId);

      const existing = live.get(key);
      if (existing && !existing.released) {
        // A second write to the same object while the cursor is still lingering
        // is the same collaborator, not a second robot: re-arm and reuse.
        arm(existing);
        return sessionFor(existing);
      }

      // Refusal 1: never create a room (see the header).
      if (relay.size(room) === 0) return null;
      // Refusal 3: never redraw a person who is present as a robot.
      for (const entry of relay.entries(room)) {
        if (entry.identity.kind !== "human") continue;
        if (entry.identity.actorId.toLowerCase() === actorId) return null;
      }

      // The cap: a bulk write may not eat a route room, and a number nobody
      // reads is not worth a slot. The OLDEST cursor gives way — never a
      // person's, and never the write that is landing right now.
      if (!isDoc) {
        const mine: AgentRecord[] = [];
        for (const record of live.values()) {
          if (record.released || record.room !== room || record.actorId !== actorId) continue;
          mine.push(record);
        }
        const oldest = mine.reduce<AgentRecord | null>(
          (worst, record) => (worst === null || record.seq < worst.seq ? record : worst),
          null,
        );
        if (mine.length >= maxRouteClients && oldest) release(oldest);
      }

      const principal: PresencePrincipal = { kind: "agent", actorId, name: actor.name };
      const handle = relay.join(room, principal);
      // The room is at its ceiling. Presence is a nicety and must never be the
      // reason a write does not land, so the caller applies it silently.
      if (!handle) return null;

      seq += 1;
      const record: AgentRecord = {
        key,
        room,
        actorId,
        handle,
        identity: presenceIdentity(principal),
        objectId: isDoc ? roomObjectId(room) : null,
        seq,
        session: undefined,
        timer: undefined,
        released: false,
      };
      // BEFORE the first publish, so no recipient ever receives a frame in
      // which the robot is here but pointed at nothing (a doc room's member is
      // already pointed at the room's own object; `focus` is a no-op there).
      if (focusId !== null && !isDoc) {
        relay.focus(handle, focusId);
        record.objectId = focusId;
      }
      live.set(key, record);
      arm(record);
      publish(room);
      return sessionFor(record);
    },

    size(): number {
      return live.size;
    },

    releaseAll(): void {
      for (const record of [...live.values()]) release(record);
    },
  };
}
