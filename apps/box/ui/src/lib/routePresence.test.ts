import { describe, expect, it } from "vitest";

import { CollabTicketError } from "./collab";
import {
  OFFLINE_PRESENCE,
  PRESENCE_MESSAGE,
  deriveCounts,
  joinRoutePresence,
  readPresenceView,
  routeRoomKey,
  type JoinRoutePresenceOptions,
  type PresenceProvider,
  type PresenceProviderArgs,
  type RoutePeer,
  type RoutePresenceSession,
  type RoutePresenceState,
} from "./routePresence";

/**
 * Route presence is a PRIVACY surface before it is a UI one, so what these pin
 * is the contract with the relay rather than the pixels:
 *
 *  - a route key can never be spelled so as to name an object;
 *  - the client renders only states the server sent, and drops any it cannot
 *    fully parse rather than half-drawing an identity;
 *  - "which object" exists only when the server chose to include it — never
 *    reconstructed, never inferred from a count;
 *  - counts are the server's, or arithmetic over the states the server sent,
 *    and nothing else;
 *  - our outbound payload is POSITION ONLY — no identity keys, ever;
 *  - a dropped socket empties the rail instead of leaving it stale.
 *
 * Everything runs against a fake provider implementing exactly the narrow
 * `PresenceProvider` surface — no websocket, no server, no real timers.
 */

/* ------------------------------------------------------------------ harness */

class FakeProvider implements PresenceProvider {
  readonly sent: string[] = [];
  destroyed = false;
  constructor(readonly args: PresenceProviderArgs) {}
  sendStateless(payload: string): void {
    this.sent.push(payload);
  }
  destroy(): void {
    this.destroyed = true;
  }
  sync(): void {
    this.args.handlers.onSynced();
  }
  frame(message: unknown): void {
    this.args.handlers.onStateless(JSON.stringify(message));
  }
  raw(payload: string): void {
    this.args.handlers.onStateless(payload);
  }
  close(code?: number, reason?: string): void {
    this.args.handlers.onClose({ code, reason });
  }
}

interface Harness {
  session: RoutePresenceSession;
  providers: FakeProvider[];
  tickets: string[];
  timers: Array<{ ms: number; fire: () => void; cancelled: boolean }>;
  states: RoutePresenceState[];
  last(): FakeProvider;
  runTimer(): Promise<void>;
}

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

function harness(over: Partial<JoinRoutePresenceOptions> = {}): Harness {
  const providers: FakeProvider[] = [];
  const tickets: string[] = [];
  const timers: Harness["timers"] = [];
  const states: RoutePresenceState[] = [];
  let minted = 0;

  const session = joinRoutePresence({
    routeKey: "type/deal",
    origin: "https://brain.example.com",
    random: () => 0.5,
    mintTicket: async () => {
      minted += 1;
      const ticket = `t${minted}`;
      tickets.push(ticket);
      return { ticket };
    },
    createProvider: (args) => {
      const provider = new FakeProvider(args);
      providers.push(provider);
      return provider;
    },
    schedule: (fn, ms) => {
      const entry = { ms, fire: fn, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    onState: (state) => states.push(state),
    ...over,
  });

  if (!session) throw new Error("route key was refused");

  return {
    session,
    providers,
    tickets,
    timers,
    states,
    last: () => providers[providers.length - 1]!,
    runTimer: async () => {
      const pending = timers.filter((t) => !t.cancelled).pop();
      if (!pending) throw new Error("no timer scheduled");
      pending.cancelled = true;
      pending.fire();
      await tick();
    },
  };
}

const DANA = {
  clientId: "c1",
  kind: "human",
  actorId: "a-dana",
  name: "Dana Reed",
  color: "presence-3",
  glyph: "DR",
  position: { anchor: 4, head: 4 },
};
const OBJ = "11111111-2222-4333-8444-555555555555";

/* ------------------------------------------------------------- the room key */

describe("routeRoomKey — a room key may never name an object", () => {
  it("normalizes a screen name", () => {
    expect(routeRoomKey("type/Deal")).toBe("route:type/deal");
    expect(routeRoomKey("  search  ")).toBe("route:search");
  });

  it("refuses anything that is not a screen name", () => {
    expect(routeRoomKey("has space")).toBeNull();
    expect(routeRoomKey("")).toBeNull();
    expect(routeRoomKey("x".repeat(200))).toBeNull();
    expect(routeRoomKey("../../etc")).toBeNull();
  });

  it("refuses a key that embeds an object id, in any case", () => {
    // Membership of a route room is unauthenticated by construction, so a key
    // like this would turn "who else is here" into an oracle for the existence
    // of a private object.
    expect(routeRoomKey(`object/${OBJ}`)).toBeNull();
    expect(routeRoomKey(`peek:${OBJ.toUpperCase()}`)).toBeNull();
  });

  it("cannot be spelled so as to land on a doc room", () => {
    expect(routeRoomKey("doc:something")).toBe("route:doc:something");
    expect(routeRoomKey("doc:something")?.startsWith("doc:")).toBe(false);
  });

  it("refuses to join at all when the key is illegal", () => {
    expect(joinRoutePresence({ routeKey: `object/${OBJ}` })).toBeNull();
  });
});

/* ------------------------------------------------------------------ parsing */

describe("readPresenceView — renders only what the server sent", () => {
  it("takes the relay's states and counts verbatim", () => {
    const view = readPresenceView(
      JSON.stringify({
        type: PRESENCE_MESSAGE,
        states: [DANA, { ...DANA, clientId: "c2", actorId: "a-sam", name: "Sam", glyph: "S" }],
        counts: { people: 2, agents: 0, objects: 0, objectsByActor: {} },
      }),
    );
    expect(view?.peers.map((p) => p.name)).toEqual(["Dana Reed", "Sam"]);
    expect(view?.counts).toEqual({ people: 2, agents: 0, objects: 0, objectsByActor: {} });
  });

  it("keeps an objectId ONLY when the server included one", () => {
    const withId = readPresenceView(
      JSON.stringify({
        type: PRESENCE_MESSAGE,
        states: [{ ...DANA, objectId: OBJ.toUpperCase() }],
        counts: { people: 1, agents: 0, objects: 1, objectsByActor: { "a-dana": 1 } },
      }),
    );
    expect(withId?.peers[0]?.objectId).toBe(OBJ);

    // The omission is the privacy mechanism: the person stays, the object does
    // not travel with them, and nothing here invents one.
    const without = readPresenceView(
      JSON.stringify({
        type: PRESENCE_MESSAGE,
        states: [DANA],
        counts: { people: 1, agents: 0, objects: 0, objectsByActor: {} },
      }),
    );
    expect(without?.peers[0]?.objectId).toBeUndefined();
    expect(without?.counts.objects).toBe(0);
  });

  it("drops a malformed objectId rather than rendering it", () => {
    const view = readPresenceView(
      JSON.stringify({
        type: PRESENCE_MESSAGE,
        states: [{ ...DANA, objectId: "not-a-uuid" }],
        counts: { people: 1, agents: 0, objects: 0, objectsByActor: {} },
      }),
    );
    expect(view?.peers[0]?.objectId).toBeUndefined();
  });

  it("drops a state it cannot fully parse, and recounts what survived", () => {
    const view = readPresenceView(
      JSON.stringify({
        type: PRESENCE_MESSAGE,
        // no name, and a colour that is not one of the relay's slots
        states: [DANA, { ...DANA, clientId: "c2", actorId: "a-x", name: "" }, { color: "#ff0000" }],
        counts: { people: 3, agents: 0, objects: 0, objectsByActor: {} },
      }),
    );
    expect(view?.peers.map((p) => p.clientId)).toEqual(["c1"]);
    // The server's 3 no longer describes the screen, so it is not shown.
    expect(view?.counts.people).toBe(1);
  });

  it("keeps only numeric positions — a string on a route is a hiding place", () => {
    const view = readPresenceView(
      JSON.stringify({
        type: PRESENCE_MESSAGE,
        states: [{ ...DANA, position: { anchor: 7, head: "row-" + OBJ, at: OBJ } }],
        counts: { people: 1, agents: 0, objects: 0, objectsByActor: {} },
      }),
    );
    expect(view?.peers[0]?.position).toEqual({ anchor: 7 });
    expect(JSON.stringify(view)).not.toContain(OBJ);
  });

  it("derives counts when the relay sent none", () => {
    const view = readPresenceView(
      JSON.stringify({ type: PRESENCE_MESSAGE, states: [{ ...DANA, objectId: OBJ }] }),
    );
    expect(view?.counts).toEqual({
      people: 1,
      agents: 0,
      objects: 1,
      objectsByActor: { "a-dana": 1 },
    });
  });

  it("ignores messages that are not presence frames", () => {
    expect(readPresenceView(JSON.stringify({ type: "epoch", epoch: 12 }))).toBeNull();
    expect(readPresenceView("not json")).toBeNull();
    expect(readPresenceView(JSON.stringify({ type: PRESENCE_MESSAGE }))).toBeNull();
  });
});

describe("deriveCounts — arithmetic over the intersected states, nothing else", () => {
  const peer = (over: Partial<RoutePeer>): RoutePeer => ({
    clientId: "c",
    kind: "human",
    actorId: "a",
    name: "n",
    color: "presence-1",
    glyph: "N",
    position: {},
    ...over,
  });

  it("counts distinct actors, and objects only where one was included", () => {
    const counts = deriveCounts([
      peer({ clientId: "c1", actorId: "a1", objectId: OBJ }),
      peer({ clientId: "c2", actorId: "a1" }),
      peer({ clientId: "c3", actorId: "a2" }),
      peer({ clientId: "c4", actorId: "agent", kind: "agent", objectId: OBJ }),
    ]);
    expect(counts).toEqual({
      people: 2,
      agents: 1,
      objects: 1,
      objectsByActor: { a1: 1, agent: 1 },
    });
  });
});

/* ------------------------------------------------------------------ session */

describe("joinRoutePresence — the socket lifecycle", () => {
  it("mints a ticket, then joins the ROUTE room with it", async () => {
    const h = harness();
    await tick();
    expect(h.tickets).toEqual(["t1"]);
    expect(h.last().args.name).toBe("route:type/deal");
    expect(h.last().args.url).toBe("wss://brain.example.com/dash/collab?ticket=t1");
  });

  it("publishes POSITION ONLY — never an identity key", async () => {
    const h = harness();
    await tick();
    h.last().sync();
    h.session.setPosition({ anchor: 3, head: 9 });

    for (const payload of h.last().sent) {
      const message = JSON.parse(payload) as Record<string, unknown>;
      expect(message["type"]).toBe(PRESENCE_MESSAGE);
      for (const key of ["kind", "actorId", "name", "color", "glyph"]) {
        expect(message[key]).toBeUndefined();
      }
    }
    expect(JSON.parse(h.last().sent[h.last().sent.length - 1]!)).toEqual({
      type: PRESENCE_MESSAGE,
      position: { anchor: 3, head: 9 },
    });
  });

  it("says nothing before the room is live", async () => {
    const h = harness();
    await tick();
    h.session.setPosition({ anchor: 1 });
    expect(h.last().sent).toEqual([]);
  });

  it("re-publishes on a heartbeat so the relay's TTL does not sweep us", async () => {
    const h = harness({ heartbeatMs: 15_000 });
    await tick();
    h.last().sync();
    expect(h.last().sent).toHaveLength(1);
    await h.runTimer();
    expect(h.last().sent).toHaveLength(2);
  });

  it("exposes the peers the relay sent, and replaces them wholesale", async () => {
    const h = harness();
    await tick();
    h.last().sync();
    h.last().frame({
      type: PRESENCE_MESSAGE,
      states: [DANA, { ...DANA, clientId: "c2", actorId: "a-sam", name: "Sam", glyph: "S" }],
      counts: { people: 2, agents: 0, objects: 0, objectsByActor: {} },
    });
    expect(h.session.state().peers.map((p) => p.name)).toEqual(["Dana Reed", "Sam"]);

    // Sam closed the tab: the next frame simply does not mention him. A merge
    // would keep him on screen forever.
    h.last().frame({
      type: PRESENCE_MESSAGE,
      states: [DANA],
      counts: { people: 1, agents: 0, objects: 0, objectsByActor: {} },
    });
    expect(h.session.state().peers.map((p) => p.name)).toEqual(["Dana Reed"]);
  });

  it("empties the rail when the socket drops — no stale roster, no spinner", async () => {
    const h = harness();
    await tick();
    h.last().sync();
    h.last().frame({
      type: PRESENCE_MESSAGE,
      states: [DANA],
      counts: { people: 1, agents: 0, objects: 0, objectsByActor: {} },
    });
    expect(h.session.state().peers).toHaveLength(1);

    h.last().close(1006, "socket gone");
    const down = h.session.state();
    expect(down.status).toBe("offline");
    expect(down.peers).toEqual([]);
    expect(down.counts).toBeNull();
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it("reconnects with a fresh ticket after a drop", async () => {
    const h = harness();
    await tick();
    h.last().sync();
    h.last().close(1006);
    await h.runTimer();
    expect(h.tickets).toEqual(["t1", "t2"]);
    h.last().sync();
    expect(h.session.state().status).toBe("live");
  });

  it("never retries a refusal that retrying cannot fix", async () => {
    for (const code of [4406, 4404]) {
      const h = harness();
      await tick();
      h.last().close(code, "nope");
      expect(h.session.state().status).toBe("denied");
      expect(h.session.state().peers).toEqual([]);
      expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
    }
  });

  it("gives up after repeated unauthorized closes instead of hot-looping", async () => {
    const h = harness({ maxUnauthorizedRetries: 1 });
    await tick();
    h.last().close(4401);
    await h.runTimer();
    h.last().close(4401);
    expect(h.session.state().status).toBe("denied");
  });

  it("denies without retrying when the ticket route says we are not signed in", async () => {
    const h = harness({
      mintTicket: async () => {
        throw new CollabTicketError(401, "no session");
      },
    });
    await tick();
    expect(h.session.state().status).toBe("denied");
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });

  it("stops publishing and tears the socket down on destroy", async () => {
    const h = harness();
    await tick();
    h.last().sync();
    h.session.destroy();
    expect(h.last().destroyed).toBe(true);
    const before = h.last().sent.length;
    h.session.setPosition({ anchor: 2 });
    expect(h.last().sent).toHaveLength(before);
  });

  it("ignores a late frame from a connection that already died", async () => {
    const h = harness();
    await tick();
    h.last().sync();
    const dead = h.last();
    dead.close(1006);
    dead.frame({
      type: PRESENCE_MESSAGE,
      states: [DANA],
      counts: { people: 1, agents: 0, objects: 0, objectsByActor: {} },
    });
    expect(h.session.state().peers).toEqual([]);
  });
});

describe("OFFLINE_PRESENCE — the shape a screen with no room renders", () => {
  it("is empty, not loading", () => {
    expect(OFFLINE_PRESENCE.peers).toEqual([]);
    expect(OFFLINE_PRESENCE.counts).toBeNull();
  });
});
