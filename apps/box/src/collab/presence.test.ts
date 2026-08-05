import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PRESENCE_IDLE_MS,
  createAgentPresence,
  createPresenceRelay,
  docRoom,
  filterForRecipient,
  isDocRoom,
  presenceIdentity,
  roomObjectId,
  routeRoom,
  routeRoomFromName,
  sanitizePosition,
  stampPresenceState,
  type DocRoomKey,
  type PresenceEntry,
  type PresenceRoomKey,
  type PresenceView,
  type RouteRoomKey,
} from "./presence.js";

/**
 * Two properties, and every assertion here is one of them:
 *
 *  - a peer cannot say who it is (identity is stamped from the connection's
 *    authenticated principal, and the client-authored half is an allowlist);
 *  - a route room cannot say that a private object exists — not through an
 *    entry, and not through a COUNT, which is the leak that survives a naive
 *    "just hide the id" fix.
 */

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CLAUDE = "33333333-3333-4333-8333-333333333333";
const PUBLIC_OBJ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIVATE_OBJ = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_OBJ = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const DEALS = routeRoom("type/deal") as RouteRoomKey;

function entry(
  clientId: string,
  who: { actorId: string; kind?: "human" | "agent"; name?: string },
  objectId: string | null,
): PresenceEntry {
  return {
    clientId,
    identity: presenceIdentity({
      kind: who.kind ?? "human",
      actorId: who.actorId,
      name: who.name ?? "Someone",
    }),
    position: { anchor: 4, head: 9 },
    objectId,
  };
}

/* ------------------------------------------------------------- room keys */

describe("room keys", () => {
  it("builds a doc room from a uuid and refuses anything else", () => {
    expect(docRoom(PUBLIC_OBJ)).toBe(`doc:${PUBLIC_OBJ}`);
    expect(docRoom(PUBLIC_OBJ.toUpperCase())).toBe(`doc:${PUBLIC_OBJ}`);
    expect(docRoom("not-a-uuid")).toBeNull();
    expect(docRoom("")).toBeNull();
  });

  it("normalizes a route key and refuses one that is not a screen name", () => {
    expect(routeRoom("type/Deal")).toBe("route:type/deal");
    expect(routeRoom("  search  ")).toBe("route:search");
    expect(routeRoom("has space")).toBeNull();
    expect(routeRoom("")).toBeNull();
    expect(routeRoom("x".repeat(200))).toBeNull();
    expect(routeRoom("../../etc")).toBeNull();
  });

  it("refuses a route key that embeds an object id", () => {
    // Route rooms are joinable by anyone, so a key like this would make room
    // MEMBERSHIP the oracle: join it, and somebody else being there tells you a
    // private object exists and is being read.
    expect(routeRoom(`object/${PRIVATE_OBJ}`)).toBeNull();
    expect(routeRoom(`peek:${PRIVATE_OBJ.toUpperCase()}`)).toBeNull();
  });

  it("keeps the two namespaces disjoint", () => {
    // A route can be named "doc:whatever" and still cannot land on a doc room.
    expect(routeRoom(`doc:${PUBLIC_OBJ}`)).toBeNull();
    expect(routeRoom("doc:something")).toBe("route:doc:something");
    expect(routeRoom("doc:something")).not.toBe(docRoom(PUBLIC_OBJ));
    expect(isDocRoom(docRoom(PUBLIC_OBJ) as DocRoomKey)).toBe(true);
    expect(isDocRoom(DEALS)).toBe(false);
    expect(roomObjectId(docRoom(PUBLIC_OBJ) as DocRoomKey)).toBe(PUBLIC_OBJ);
  });

  it("validates a RAW route document name through routeRoom's full contract", () => {
    // The join gate and the presence room-key derivation both run the raw
    // hocuspocus document name through this, NOT a bare `route:` prefix match —
    // otherwise `route:<uuid>` and unbounded/arbitrary-charset keys are admitted
    // straight into a presence room (an insider oracle + memory-growth vector).
    expect(routeRoomFromName("route:type/deal")).toBe("route:type/deal");
    expect(routeRoomFromName("route:doc:something")).toBe("route:doc:something");

    // Not a route name at all → null (a doc name, or junk).
    expect(routeRoomFromName(`doc:${PUBLIC_OBJ}`)).toBeNull();
    expect(routeRoomFromName(PUBLIC_OBJ)).toBeNull();

    // A uuid ANYWHERE in the key is refused — the whole point of the invariant.
    expect(routeRoomFromName(`route:object/${PRIVATE_OBJ}`)).toBeNull();
    expect(routeRoomFromName(`route:${PRIVATE_OBJ}`)).toBeNull();

    // Charset / length bounds hold — a route key is a narrow screen name.
    expect(routeRoomFromName("route:has space")).toBeNull();
    expect(routeRoomFromName(`route:${"x".repeat(200)}`)).toBeNull();
    expect(routeRoomFromName("route:")).toBeNull();

    // Only the ALREADY-NORMALIZED form is accepted: `route:Deals` would
    // validate to `route:deals`, a different room, so it is refused rather than
    // silently re-homed. (Legitimate clients send the normalized key.)
    expect(routeRoomFromName("route:Deals")).toBeNull();
    expect(routeRoomFromName("route:type/Deal")).toBeNull();
  });
});

/* ------------------------------------------------------- server-stamped id */

describe("presenceIdentity", () => {
  it("gives an actor a stable colour slot and the agent a reserved one", () => {
    const once = presenceIdentity({ kind: "human", actorId: ALICE, name: "Alice Adams" });
    const again = presenceIdentity({ kind: "human", actorId: ALICE, name: "Alice Adams" });
    expect(once.color).toBe(again.color);
    expect(once.color).toMatch(/^presence-[1-8]$/);
    expect(once.glyph).toBe("AA");

    const agent = presenceIdentity({ kind: "agent", actorId: CLAUDE, name: "Claude" });
    expect(agent.color).toBe("presence-agent");
    expect(agent.glyph).toBe("robot");
  });

  it("bounds a name and strips what would draw as markup", () => {
    const id = presenceIdentity({ kind: "human", actorId: BOB, name: "<script>Bob" });
    expect(id.name).toBe("scriptBob");
    expect(presenceIdentity({ kind: "human", actorId: BOB, name: "" }).name).toBe("Member");
    expect(
      presenceIdentity({ kind: "human", actorId: BOB, name: "x".repeat(200) }).name,
    ).toHaveLength(48);
  });

  it("takes the glyph by code POINT, never a lone surrogate half", () => {
    // An astral first character (emoji or an out-of-BMP script) is a UTF-16
    // surrogate PAIR; indexing by code unit would return a broken half that
    // renders as a replacement box. The client draws this glyph verbatim.
    const emoji = presenceIdentity({ kind: "human", actorId: ALICE, name: "🦊 Fox" });
    // The whole fox survives (a two-word name takes each word's first glyph).
    expect([...emoji.glyph]).toEqual(["🦊", "F"]);
    expect(emoji.glyph.startsWith("🦊")).toBe(true);

    const single = presenceIdentity({ kind: "human", actorId: BOB, name: "😀" });
    expect(single.glyph).toBe("😀");
    // Never a lone surrogate: every code unit is part of a whole code point.
    for (const ch of [emoji.glyph, single.glyph]) {
      expect([...ch].join("")).toBe(ch);
    }
  });
});

describe("stampPresenceState", () => {
  const alice = { kind: "human", actorId: ALICE, name: "Alice" } as const;

  it("overwrites every identity key from the principal and reports the attempt", () => {
    const stamped = stampPresenceState(
      alice,
      { actorId: BOB, name: "Bob", color: "presence-agent", glyph: "robot", anchor: 3 },
      { room: DEALS },
    );
    expect(stamped.identity.actorId).toBe(ALICE);
    expect(stamped.identity.name).toBe("Alice");
    expect(stamped.identity.color).not.toBe("presence-agent");
    expect(stamped.identity.glyph).toBe("A");
    expect(stamped.spoofed).toBe(true);
    expect(stamped.rejected).toEqual(expect.arrayContaining(["actorId", "name", "color", "glyph"]));
    // The one thing a client may author survives.
    expect(stamped.position).toEqual({ anchor: 3 });
  });

  it("refuses to let a client become the agent", () => {
    const stamped = stampPresenceState(alice, { kind: "agent" }, { room: DEALS });
    expect(stamped.identity.kind).toBe("human");
    expect(stamped.identity.glyph).not.toBe("robot");
    expect(stamped.spoofed).toBe(true);
  });

  it("drops any key that is not on the position allowlist", () => {
    // The allowlist is the point: a denylist of the five identity keys would
    // still relay `objectId`/`title` verbatim to every peer on the route.
    const stamped = stampPresenceState(
      alice,
      { objectId: PRIVATE_OBJ, title: "Acme renewal", nested: { anchor: 1 }, anchor: 7 },
      { room: DEALS },
    );
    expect(stamped.position).toEqual({ anchor: 7 });
    expect(stamped.rejected).toEqual(expect.arrayContaining(["objectId", "title", "nested"]));
    expect(JSON.stringify(stamped)).not.toContain(PRIVATE_OBJ);
    expect(JSON.stringify(stamped)).not.toContain("Acme");
    // Unknown keys are not an identity spoof — noisy client, not a hostile one.
    expect(stamped.spoofed).toBe(false);
  });

  it("allows a document-local string key in a doc room and never on a route", () => {
    const room = docRoom(PUBLIC_OBJ) as DocRoomKey;
    expect(stampPresenceState(alice, { at: "body", anchor: 1 }, { room }).position).toEqual({
      at: "body",
      anchor: 1,
    });
    // On a table route the natural thing to put in `at` is the ROW key — and a
    // row key is an object id.
    const onRoute = stampPresenceState(alice, { at: PRIVATE_OBJ, anchor: 1 }, { room: DEALS });
    expect(onRoute.position).toEqual({ anchor: 1 });
    expect(onRoute.rejected).toContain("at");
  });

  it("survives a payload that is not an object at all", () => {
    for (const junk of [null, undefined, 42, "hello", [1, 2, 3]]) {
      const stamped = stampPresenceState(alice, junk, { room: DEALS });
      expect(stamped.position).toEqual({});
      expect(stamped.identity.actorId).toBe(ALICE);
    }
  });

  it("refuses nonsense offsets rather than relaying them", () => {
    expect(
      sanitizePosition({ anchor: -1, head: Number.NaN }, { allowStrings: true }).position,
    ).toEqual({});
    expect(sanitizePosition({ anchor: 1e12 }, { allowStrings: true }).position).toEqual({});
    expect(sanitizePosition({ anchor: 4.7 }, { allowStrings: true }).position).toEqual({
      anchor: 4,
    });
  });
});

/* ------------------------------------------------------- per-recipient view */

describe("filterForRecipient", () => {
  const states: PresenceEntry[] = [
    entry("c-alice", { actorId: ALICE, name: "Alice" }, PUBLIC_OBJ),
    entry("c-bob", { actorId: BOB, name: "Bob" }, PRIVATE_OBJ),
  ];

  it("carries an object id only to a recipient whose own read returned it", () => {
    const mine = filterForRecipient(states, [PUBLIC_OBJ, PRIVATE_OBJ]);
    expect(mine.states.map((s) => s.objectId)).toEqual([PUBLIC_OBJ, PRIVATE_OBJ]);
  });

  it("keeps a human whose object is invisible, minus the object", () => {
    // Dropping them would be worse: an avatar that blinks out the moment its
    // owner opens something private IS the announcement.
    const view = filterForRecipient(states, [PUBLIC_OBJ]);
    expect(view.states.map((s) => s.actorId)).toEqual([ALICE, BOB]);
    const bob = view.states.find((s) => s.actorId === BOB);
    expect(bob?.objectId).toBeUndefined();
    expect(Object.hasOwn(bob as object, "objectId")).toBe(false);
    expect(JSON.stringify(view)).not.toContain(PRIVATE_OBJ);
  });

  it("removes the private object's contribution to every count", () => {
    const view = filterForRecipient(states, [PUBLIC_OBJ]);
    expect(view.counts.objects).toBe(1);
    expect(view.counts.people).toBe(2);
    expect(view.counts.objectsByActor).toEqual({ [ALICE]: 1 });
    expect(view.counts.objectsByActor[BOB]).toBeUndefined();
  });

  it("gives two recipients different counts from the same room state", () => {
    // Correct, not a bug: each count is a statement about what THAT person may
    // see. A count computed before the intersection is the side-channel.
    const insider = filterForRecipient(states, [PUBLIC_OBJ, PRIVATE_OBJ]);
    const outsider = filterForRecipient(states, [PUBLIC_OBJ]);
    expect(insider.counts.objects).toBe(2);
    expect(outsider.counts.objects).toBe(1);
  });

  it("drops an agent entirely when its object is invisible", () => {
    // An agent's presence IS the write; with no visible object it is nothing but
    // the announcement that an invisible write happened.
    const withAgent = [
      ...states,
      entry("c-claude", { actorId: CLAUDE, kind: "agent", name: "Claude" }, PRIVATE_OBJ),
    ];
    const outsider = filterForRecipient(withAgent, [PUBLIC_OBJ]);
    expect(outsider.states.map((s) => s.actorId)).toEqual([ALICE, BOB]);
    expect(outsider.counts.agents).toBe(0);
    expect(outsider.counts.objects).toBe(1);

    const insider = filterForRecipient(withAgent, [PUBLIC_OBJ, PRIVATE_OBJ]);
    expect(insider.counts.agents).toBe(1);
    expect(insider.states.find((s) => s.kind === "agent")?.objectId).toBe(PRIVATE_OBJ);
  });

  it("drops an agent that is editing nothing at all", () => {
    const view = filterForRecipient(
      [entry("c-claude", { actorId: CLAUDE, kind: "agent" }, null)],
      [PUBLIC_OBJ],
    );
    expect(view.states).toEqual([]);
    expect(view.counts.agents).toBe(0);
  });

  it("counts an agent's visible objects after the intersection", () => {
    // "Claude is editing 3 objects in Deals" — for someone who can see three.
    const agentStates = [
      entry("c-1", { actorId: CLAUDE, kind: "agent" }, PUBLIC_OBJ),
      entry("c-2", { actorId: CLAUDE, kind: "agent" }, OTHER_OBJ),
      entry("c-3", { actorId: CLAUDE, kind: "agent" }, PRIVATE_OBJ),
    ];
    expect(
      filterForRecipient(agentStates, [PUBLIC_OBJ, OTHER_OBJ, PRIVATE_OBJ]).counts,
    ).toMatchObject({ agents: 1, objects: 3, objectsByActor: { [CLAUDE]: 3 } });
    expect(filterForRecipient(agentStates, [PUBLIC_OBJ, OTHER_OBJ]).counts).toMatchObject({
      agents: 1,
      objects: 2,
      objectsByActor: { [CLAUDE]: 2 },
    });
  });

  it("keeps a human who has nothing open, and counts one person per actor", () => {
    const view = filterForRecipient(
      [
        entry("tab-1", { actorId: ALICE }, PUBLIC_OBJ),
        entry("tab-2", { actorId: ALICE }, PUBLIC_OBJ),
        entry("tab-3", { actorId: BOB }, null),
      ],
      [PUBLIC_OBJ],
    );
    expect(view.states).toHaveLength(3);
    expect(view.counts.people).toBe(2);
    expect(view.counts.objects).toBe(1);
  });

  it("accepts a Set or an array of visible ids", () => {
    const asSet = filterForRecipient(states, new Set([PUBLIC_OBJ]));
    const asArray = filterForRecipient(states, [PUBLIC_OBJ]);
    expect(asSet).toEqual(asArray);
    // No visible ids at all is a normal answer, not a reason to hide the room.
    const none = filterForRecipient(states, []);
    expect(none.states).toHaveLength(2);
    expect(none.counts.objects).toBe(0);
  });
});

/* ------------------------------------------------------------- the relay */

interface Harness {
  readonly sent: Map<string, PresenceView>;
  readonly relay: ReturnType<typeof createPresenceRelay>;
  readonly visibleTo: ReturnType<typeof vi.fn>;
}

function harness(
  visible: Record<string, readonly string[]>,
  opts: { fail?: boolean; widen?: boolean } = {},
): Harness {
  const sent = new Map<string, PresenceView>();
  const visibleTo = vi.fn(async (actorId: string, ids: readonly string[]) => {
    if (opts.fail) throw new Error("pool exhausted");
    if (opts.widen) return [...ids, "ffffffff-ffff-4fff-8fff-ffffffffffff"];
    const mine = new Set(visible[actorId] ?? []);
    return ids.filter((id) => mine.has(id));
  });
  const relay = createPresenceRelay({
    send: (recipient, view) => sent.set(recipient.clientId, view),
    visibleTo,
  });
  return { sent, relay, visibleTo };
}

describe("createPresenceRelay", () => {
  it("joins, sizes and leaves a room", () => {
    const { relay } = harness({});
    const a = relay.join(DEALS, { kind: "human", actorId: ALICE, name: "Alice" });
    const b = relay.join(DEALS, { kind: "human", actorId: BOB, name: "Bob" });
    expect(relay.size(DEALS)).toBe(2);
    relay.leave(a as { room: PresenceRoomKey; clientId: string });
    expect(relay.size(DEALS)).toBe(1);
    relay.leave(b as { room: PresenceRoomKey; clientId: string });
    expect(relay.size(DEALS)).toBe(0);
    expect(relay.stats().rooms).toBe(0);
  });

  it("refuses a join past the ceiling rather than growing without bound", () => {
    const relay = createPresenceRelay({ send: () => undefined, maxMembers: 1 });
    expect(relay.join(DEALS, { kind: "human", actorId: ALICE })).not.toBeNull();
    expect(relay.join(DEALS, { kind: "human", actorId: BOB })).toBeNull();
    expect(relay.size(DEALS)).toBe(1);
  });

  it("stamps every update and reports an identity spoof", () => {
    const onViolation = vi.fn();
    const relay = createPresenceRelay({ send: () => undefined, onViolation });
    const handle = relay.join(
      DEALS,
      { kind: "human", actorId: ALICE, name: "Alice" },
      {
        clientId: "c-alice",
      },
    );
    relay.update(handle!, { actorId: BOB, kind: "agent", anchor: 2 });
    const [held] = relay.entries(DEALS);
    expect(held?.identity.actorId).toBe(ALICE);
    expect(held?.identity.kind).toBe("human");
    expect(held?.position).toEqual({ anchor: 2 });
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(relay.stats().violations).toBe(1);
  });

  it("never takes the current object from a client payload", () => {
    const { relay } = harness({});
    const handle = relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    relay.update(handle!, { objectId: PRIVATE_OBJ });
    expect(relay.entries(DEALS)[0]?.objectId).toBeNull();
    // It comes from the doc room the actor actually joined — an RLS-bound read
    // already said yes — and the server sets it.
    relay.focus(handle!, PRIVATE_OBJ);
    expect(relay.entries(DEALS)[0]?.objectId).toBe(PRIVATE_OBJ);
    relay.focus(handle!, "not-a-uuid");
    expect(relay.entries(DEALS)[0]?.objectId).toBeNull();
  });

  it("route-broadcasts a different view to each recipient, resolved per actor", async () => {
    const { relay, sent, visibleTo } = harness({
      [ALICE]: [PUBLIC_OBJ, PRIVATE_OBJ],
      [BOB]: [PUBLIC_OBJ],
    });
    const alice = relay.join(
      DEALS,
      { kind: "human", actorId: ALICE, name: "Alice" },
      {
        clientId: "c-alice",
      },
    )!;
    const aliceTab2 = relay.join(
      DEALS,
      { kind: "human", actorId: ALICE, name: "Alice" },
      {
        clientId: "c-alice-2",
      },
    )!;
    const bob = relay.join(
      DEALS,
      { kind: "human", actorId: BOB, name: "Bob" },
      {
        clientId: "c-bob",
      },
    )!;
    relay.focus(alice, PRIVATE_OBJ);
    relay.focus(aliceTab2, PUBLIC_OBJ);
    relay.focus(bob, PUBLIC_OBJ);

    await relay.broadcast(DEALS);

    const toAlice = sent.get("c-alice");
    expect(toAlice?.counts.objects).toBe(2);

    const toBob = sent.get("c-bob");
    expect(toBob?.states).toHaveLength(3);
    expect(toBob?.counts.objects).toBe(1);
    expect(toBob?.counts.people).toBe(2);
    expect(JSON.stringify(toBob)).not.toContain(PRIVATE_OBJ);

    // One read per ACTOR, not per connection: Alice's two tabs cost one.
    expect(visibleTo).toHaveBeenCalledTimes(2);
    expect(relay.stats().resolves).toBe(2);
  });

  it("resolves nothing for a doc room — the room IS the boundary", async () => {
    const room = docRoom(PUBLIC_OBJ) as DocRoomKey;
    const { relay, sent, visibleTo } = harness({});
    relay.join(room, { kind: "human", actorId: ALICE, name: "Alice" }, { clientId: "c-alice" });
    relay.join(room, { kind: "human", actorId: BOB, name: "Bob" }, { clientId: "c-bob" });
    await relay.broadcast(room);
    expect(visibleTo).not.toHaveBeenCalled();
    expect(sent.get("c-bob")?.states.map((s) => s.objectId)).toEqual([PUBLIC_OBJ, PUBLIC_OBJ]);
    expect(sent.get("c-bob")?.counts.objects).toBe(1);
  });

  it("fails closed when the visibility read fails", async () => {
    const { relay, sent } = harness({ [BOB]: [PUBLIC_OBJ] }, { fail: true });
    const alice = relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" })!;
    relay.join(DEALS, { kind: "human", actorId: BOB }, { clientId: "c-bob" });
    relay.focus(alice, PUBLIC_OBJ);
    await relay.broadcast(DEALS);
    // Avatars survive an outage; object identity does not travel on the strength
    // of Postgres having hiccuped.
    expect(sent.get("c-bob")?.states).toHaveLength(2);
    expect(sent.get("c-bob")?.counts.objects).toBe(0);
    // One failed read per recipient — nobody is given somebody else's answer.
    expect(relay.stats().resolveErrors).toBe(2);
  });

  it("fails closed when no visibility reader is wired at all", async () => {
    const sent = new Map<string, PresenceView>();
    const relay = createPresenceRelay({ send: (r, v) => sent.set(r.clientId, v) });
    const alice = relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" })!;
    relay.focus(alice, PRIVATE_OBJ);
    await relay.broadcast(DEALS);
    expect(sent.get("c-alice")?.counts.objects).toBe(0);
    expect(JSON.stringify([...sent.values()])).not.toContain(PRIVATE_OBJ);
  });

  it("never lets a visibility reader inject an id nobody in the room is editing", async () => {
    const { relay, sent } = harness({}, { widen: true });
    const alice = relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" })!;
    relay.focus(alice, PUBLIC_OBJ);
    await relay.broadcast(DEALS);
    expect(sent.get("c-alice")?.counts.objects).toBe(1);
    expect(JSON.stringify(sent.get("c-alice"))).not.toContain("ffffffff");
  });

  it("publishes an agent to the room but never sends to one", async () => {
    const { relay, sent } = harness({ [BOB]: [PUBLIC_OBJ] });
    const agent = relay.join(
      DEALS,
      { kind: "agent", actorId: CLAUDE, name: "Claude" },
      {
        clientId: "c-claude",
      },
    )!;
    relay.join(DEALS, { kind: "human", actorId: BOB, name: "Bob" }, { clientId: "c-bob" });
    relay.focus(agent, PUBLIC_OBJ);
    await relay.broadcast(DEALS);
    expect(sent.has("c-claude")).toBe(false);
    expect(sent.get("c-bob")?.counts.agents).toBe(1);
    expect(sent.get("c-bob")?.states.find((s) => s.kind === "agent")?.glyph).toBe("robot");
  });

  it("hides an agent editing a private object from everyone who cannot see it", async () => {
    // The privacy invariant, at the route level: no entry, no count, nothing.
    const { relay, sent } = harness({ [ALICE]: [PRIVATE_OBJ], [BOB]: [] });
    const agent = relay.join(
      DEALS,
      { kind: "agent", actorId: CLAUDE, name: "Claude" },
      {
        clientId: "c-claude",
      },
    )!;
    relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    relay.join(DEALS, { kind: "human", actorId: BOB }, { clientId: "c-bob" });
    relay.focus(agent, PRIVATE_OBJ);
    await relay.broadcast(DEALS);

    expect(sent.get("c-alice")?.counts.agents).toBe(1);
    const toBob = sent.get("c-bob");
    expect(toBob?.states.some((s) => s.kind === "agent")).toBe(false);
    expect(toBob?.counts.agents).toBe(0);
    expect(toBob?.counts.objects).toBe(0);
    expect(JSON.stringify(toBob)).not.toContain(PRIVATE_OBJ);
  });

  it("does not re-point a doc room member's object", () => {
    const room = docRoom(PUBLIC_OBJ) as DocRoomKey;
    const { relay } = harness({});
    const handle = relay.join(room, { kind: "human", actorId: ALICE }, { clientId: "c-alice" })!;
    expect(relay.entries(room)[0]?.objectId).toBe(PUBLIC_OBJ);
    relay.focus(handle, PRIVATE_OBJ);
    expect(relay.entries(room)[0]?.objectId).toBe(PUBLIC_OBJ);
  });

  it("sweeps a connection that stopped talking", () => {
    let clock = 1_000;
    const relay = createPresenceRelay({
      send: () => undefined,
      ttlMs: 10_000,
      now: () => clock,
    });
    relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const bob = relay.join(DEALS, { kind: "human", actorId: BOB }, { clientId: "c-bob" })!;
    clock += 9_000;
    relay.update(bob, { anchor: 1 });
    clock += 2_000;
    expect(relay.sweep()).toBe(1);
    expect(relay.entries(DEALS).map((e) => e.identity.actorId)).toEqual([BOB]);
    clock += 20_000;
    expect(relay.sweep()).toBe(1);
    expect(relay.stats().rooms).toBe(0);
  });

  it("ignores update, focus and leave for a connection that is gone", () => {
    const { relay } = harness({});
    const ghost = { room: DEALS, clientId: "c-ghost" };
    expect(() => relay.update(ghost, { anchor: 1 })).not.toThrow();
    expect(() => relay.focus(ghost, PUBLIC_OBJ)).not.toThrow();
    expect(() => relay.leave(ghost)).not.toThrow();
    expect(relay.size(DEALS)).toBe(0);
  });

  it("broadcasting an empty or unknown room is a no-op", async () => {
    const { relay, visibleTo } = harness({});
    await expect(relay.broadcast(DEALS)).resolves.toBeUndefined();
    expect(visibleTo).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------- agent clients (phase 5) */

/**
 * The identity a room shows for an external write is the one thing here nobody
 * can forge: it is built from an ACTOR, stamped by the relay, and published
 * only where the write's own room already is.
 */
describe("createAgentPresence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const DOC = docRoom(PUBLIC_OBJ) as DocRoomKey;

  it("publishes a named robot into a room that already has people", async () => {
    const { relay, sent } = harness({});
    relay.join(DOC, { kind: "human", actorId: ALICE, name: "Alice" }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });

    const session = agents.enter(DOC, { actorId: CLAUDE, name: "Claude" });
    expect(session).not.toBeNull();
    expect(session?.identity).toMatchObject({
      kind: "agent",
      actorId: CLAUDE,
      name: "Claude",
      color: "presence-agent",
      glyph: "robot",
    });

    await relay.broadcast(DOC);
    const toAlice = sent.get("c-alice");
    const robot = toAlice?.states.find((s) => s.kind === "agent");
    expect(robot?.actorId).toBe(CLAUDE);
    expect(robot?.name).toBe("Claude");
    // The reserved slot is what keeps a robot from being read as a person.
    expect(toAlice?.states.every((s) => (s.color === "presence-agent") === (s.kind === "agent")));
  });

  it("never creates a room — an agent alone in an empty one is a leak", () => {
    const { relay } = harness({});
    const agents = createAgentPresence({ relay });
    expect(agents.enter(DOC, { actorId: CLAUDE, name: "Claude" })).toBeNull();
    // Nothing was created, so nothing exists to be observed or counted.
    expect(relay.size(DOC)).toBe(0);
    expect(relay.stats().rooms).toBe(0);
    expect(agents.size()).toBe(0);
  });

  it("refuses an actor id that is not an actor", () => {
    const { relay } = harness({});
    relay.join(DOC, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    expect(agents.enter(DOC, { actorId: "claude" })).toBeNull();
    expect(agents.enter(DOC, { actorId: "" })).toBeNull();
    expect(relay.size(DOC)).toBe(1);
  });

  it("does not redraw a person who is already in the room as a robot", () => {
    // A cron running as Alice's actor while Alice is editing: her real avatar
    // is already there, and a second one wearing a robot glyph would be a lie.
    const { relay } = harness({});
    relay.join(DOC, { kind: "human", actorId: ALICE, name: "Alice" }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    expect(agents.enter(DOC, { actorId: ALICE.toUpperCase(), name: "Alice" })).toBeNull();
    expect(relay.size(DOC)).toBe(1);
  });

  it("reuses one client for a second write while the cursor is still lingering", () => {
    const { relay } = harness({});
    relay.join(DOC, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    const first = agents.enter(DOC, { actorId: CLAUDE, name: "Claude" });
    const second = agents.enter(DOC, { actorId: CLAUDE, name: "Claude" });
    expect(second?.handle.clientId).toBe(first?.handle.clientId);
    expect(agents.size()).toBe(1);
    expect(relay.size(DOC)).toBe(2); // Alice + one robot, never two
  });

  it("lingers, then leaves the way a human's cursor does", async () => {
    vi.useFakeTimers();
    const { relay, sent } = harness({});
    relay.join(DOC, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    const session = agents.enter(DOC, { actorId: CLAUDE, name: "Claude" })!;

    await vi.advanceTimersByTimeAsync(AGENT_PRESENCE_IDLE_MS - 1);
    expect(relay.size(DOC)).toBe(2);

    // Every move re-arms the linger, so a working agent stays put…
    session.moveTo({ anchor: 12, head: 20 });
    await vi.advanceTimersByTimeAsync(AGENT_PRESENCE_IDLE_MS - 1);
    expect(relay.entries(DOC).find((e) => e.identity.kind === "agent")?.position).toEqual({
      anchor: 12,
      head: 20,
    });

    // …and ~5s after the last one it is gone, and the room is told.
    await vi.advanceTimersByTimeAsync(2);
    expect(relay.size(DOC)).toBe(1);
    expect(agents.size()).toBe(0);
    expect(sent.get("c-alice")?.states.some((s) => s.kind === "agent")).toBe(false);

    // Everything on a released session is inert; nothing rejoins by accident.
    session.moveTo({ anchor: 3 });
    session.touch();
    session.release();
    expect(relay.size(DOC)).toBe(1);
  });

  it("releases on demand and releases everything on shutdown", () => {
    const { relay } = harness({});
    const other = docRoom(OTHER_OBJ) as DocRoomKey;
    relay.join(DOC, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    relay.join(other, { kind: "human", actorId: BOB }, { clientId: "c-bob" });
    const agents = createAgentPresence({ relay });
    const one = agents.enter(DOC, { actorId: CLAUDE, name: "Claude" })!;
    agents.enter(other, { actorId: CLAUDE, name: "Claude" });
    expect(agents.size()).toBe(2);

    one.release();
    one.release(); // idempotent
    expect(agents.size()).toBe(1);
    expect(relay.size(DOC)).toBe(1);

    agents.releaseAll();
    expect(agents.size()).toBe(0);
    expect(relay.size(other)).toBe(1);
  });

  it("refuses when the room is at its ceiling rather than evicting a person", () => {
    const relay = createPresenceRelay({ send: () => undefined, maxMembers: 1 });
    relay.join(DOC, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    expect(agents.enter(DOC, { actorId: CLAUDE, name: "Claude" })).toBeNull();
    expect(relay.size(DOC)).toBe(1);
  });

  it("keeps an agent editing a private object invisible on a route room", async () => {
    // The privacy invariant, through the phase-5 path rather than a hand-built
    // entry: Bob cannot see the object, so there is no avatar and no count.
    const { relay, sent } = harness({ [ALICE]: [PRIVATE_OBJ], [BOB]: [] });
    relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    relay.join(DEALS, { kind: "human", actorId: BOB }, { clientId: "c-bob" });
    const agents = createAgentPresence({ relay });
    agents.enter(DEALS, { actorId: CLAUDE, name: "Claude" }, { objectId: PRIVATE_OBJ });

    await relay.broadcast(DEALS);
    expect(sent.get("c-alice")?.counts.agents).toBe(1);
    const toBob = sent.get("c-bob");
    expect(toBob?.states.some((s) => s.kind === "agent")).toBe(false);
    expect(toBob?.counts.agents).toBe(0);
    expect(toBob?.counts.objects).toBe(0);
    expect(JSON.stringify(toBob)).not.toContain(PRIVATE_OBJ);
  });

  it("refuses a route room with no object — nobody could ever be shown it", () => {
    // Refusal 4: `filterForRecipient` drops an agent with no visible object, so
    // an unpointed robot on a route is an entry that exists only to occupy a
    // slot under the ceiling and to tempt somebody into showing it.
    const { relay } = harness({ [ALICE]: [PUBLIC_OBJ] });
    relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    expect(agents.enter(DEALS, { actorId: CLAUDE, name: "Claude" })).toBeNull();
    expect(agents.enter(DEALS, { actorId: CLAUDE }, { objectId: "not-a-uuid" })).toBeNull();
    expect(agents.enter(DEALS, { actorId: CLAUDE }, { objectId: null })).toBeNull();
    expect(relay.size(DEALS)).toBe(1);
    expect(agents.size()).toBe(0);
  });

  it("is pointed at its object before the first frame anyone receives", async () => {
    // Not cosmetic: an entry published unpointed and focused a tick later is a
    // robot that appears and vanishes in every rail on the route, including the
    // rails of people who may not see what it went on to edit.
    const { relay, sent } = harness({ [ALICE]: [PUBLIC_OBJ] });
    relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    agents.enter(DEALS, { actorId: CLAUDE, name: "Claude" }, { objectId: PUBLIC_OBJ });

    await relay.broadcast(DEALS);
    const robot = sent.get("c-alice")?.states.find((s) => s.kind === "agent");
    expect(robot?.objectId).toBe(PUBLIC_OBJ);
    expect(sent.get("c-alice")?.counts.objectsByActor[CLAUDE]).toBe(1);
  });

  it("holds one cursor per row it is still writing, and one identity", async () => {
    // "Claude is editing 3 objects in Deals" is a count of CURSORS, so a robot
    // part-way through a table holds one per row it is still on — and remains
    // one collaborator: three entries, one actor, one avatar's worth of name.
    const { relay, sent } = harness({ [ALICE]: [PUBLIC_OBJ, OTHER_OBJ] });
    relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    const first = agents.enter(
      DEALS,
      { actorId: CLAUDE, name: "Claude" },
      { objectId: PUBLIC_OBJ },
    )!;
    const second = agents.enter(
      DEALS,
      { actorId: CLAUDE, name: "Claude" },
      { objectId: OTHER_OBJ },
    )!;
    expect(second.handle.clientId).not.toBe(first.handle.clientId);
    // A repeat write to a row it is ALREADY on is the same cursor, not a third.
    const again = agents.enter(
      DEALS,
      { actorId: CLAUDE, name: "Claude" },
      { objectId: PUBLIC_OBJ },
    )!;
    expect(again.handle.clientId).toBe(first.handle.clientId);
    expect(agents.size()).toBe(2);

    await relay.broadcast(DEALS);
    const view = sent.get("c-alice");
    expect(view?.counts.agents).toBe(1);
    expect(view?.counts.objectsByActor[CLAUDE]).toBe(2);
  });

  it("caps the cursors one robot may hold in a route room", async () => {
    // A forty-row bulk write must not fill a room people are trying to join,
    // and forty is not a number anybody reads. The oldest cursor gives way.
    const { relay, sent } = harness({ [ALICE]: [PUBLIC_OBJ, OTHER_OBJ, PRIVATE_OBJ] });
    relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay, maxRouteClients: 2 });
    const first = agents.enter(DEALS, { actorId: CLAUDE }, { objectId: PUBLIC_OBJ })!;
    agents.enter(DEALS, { actorId: CLAUDE }, { objectId: OTHER_OBJ });
    agents.enter(DEALS, { actorId: CLAUDE }, { objectId: PRIVATE_OBJ });
    expect(agents.size()).toBe(2);
    // The person in the room is untouched; only the robot's own oldest went.
    expect(relay.size(DEALS)).toBe(3);

    await relay.broadcast(DEALS);
    const objects = (sent.get("c-alice")?.states ?? [])
      .filter((s) => s.kind === "agent")
      .map((s) => s.objectId);
    expect(new Set(objects)).toEqual(new Set([OTHER_OBJ, PRIVATE_OBJ]));
    expect(sent.get("c-alice")?.counts.objectsByActor[CLAUDE]).toBe(2);
    // The retired cursor is gone from the room, not merely from the registry.
    expect(relay.entries(DEALS).some((e) => e.clientId === first.handle.clientId)).toBe(false);
  });

  it("re-files a cursor that was moved, so the next write reuses it", () => {
    // `focus` is the lower-level move; the registry must follow it, or an
    // `enter` for the row the robot is ALREADY on publishes a second robot.
    const { relay } = harness({ [ALICE]: [PUBLIC_OBJ, OTHER_OBJ] });
    relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    const session = agents.enter(DEALS, { actorId: CLAUDE }, { objectId: PUBLIC_OBJ })!;
    session.focus(OTHER_OBJ);
    const again = agents.enter(DEALS, { actorId: CLAUDE }, { objectId: OTHER_OBJ })!;
    expect(again.handle.clientId).toBe(session.handle.clientId);
    expect(agents.size()).toBe(1);
    expect(relay.entries(DEALS).filter((e) => e.identity.kind === "agent")).toHaveLength(1);
  });

  it("lets a doc room keep its own object whatever the caller passes", () => {
    const { relay } = harness({});
    relay.join(DOC, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    expect(agents.enter(DOC, { actorId: CLAUDE }, { objectId: PRIVATE_OBJ })).not.toBeNull();
    const robot = relay.entries(DOC).find((e) => e.identity.kind === "agent");
    expect(robot?.objectId).toBe(PUBLIC_OBJ);
    // …and a second write to that room is still one robot, not one per object.
    agents.enter(DOC, { actorId: CLAUDE }, { objectId: OTHER_OBJ });
    expect(agents.size()).toBe(1);
  });

  it("gives two people on the same screen different figures for one robot", async () => {
    // The rail's "Claude is editing 3 objects in Deals" is THIS arithmetic. Two
    // viewers legitimately disagree, because each count is a statement about
    // what that viewer may see — computed after the intersection, never before.
    const { relay, sent } = harness({
      [ALICE]: [PUBLIC_OBJ, OTHER_OBJ, PRIVATE_OBJ],
      [BOB]: [PUBLIC_OBJ],
    });
    relay.join(DEALS, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    relay.join(DEALS, { kind: "human", actorId: BOB }, { clientId: "c-bob" });
    const agents = createAgentPresence({ relay });
    for (const objectId of [PUBLIC_OBJ, OTHER_OBJ, PRIVATE_OBJ]) {
      expect(agents.enter(DEALS, { actorId: CLAUDE, name: "Claude" }, { objectId })).not.toBeNull();
    }

    await relay.broadcast(DEALS);
    expect(sent.get("c-alice")?.counts.objectsByActor[CLAUDE]).toBe(3);
    expect(sent.get("c-bob")?.counts.objectsByActor[CLAUDE]).toBe(1);
    // One robot, however many rows it is touching.
    expect(sent.get("c-alice")?.counts.agents).toBe(1);
    expect(sent.get("c-bob")?.counts.agents).toBe(1);
    // Bob is told about the one row he can see and nothing else — not the ids,
    // and not the fact that there were two more.
    expect(sent.get("c-bob")?.states.filter((s) => s.kind === "agent")).toHaveLength(1);
    expect(JSON.stringify(sent.get("c-bob"))).not.toContain(PRIVATE_OBJ);
    expect(JSON.stringify(sent.get("c-bob"))).not.toContain(OTHER_OBJ);
  });

  it("survives a relay that throws on broadcast", () => {
    const relay = createPresenceRelay({
      send: () => {
        throw new Error("socket is gone");
      },
    });
    relay.join(DOC, { kind: "human", actorId: ALICE }, { clientId: "c-alice" });
    const agents = createAgentPresence({ relay });
    expect(agents.enter(DOC, { actorId: CLAUDE, name: "Claude" })).not.toBeNull();
  });
});
