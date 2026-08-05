import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  createAgentWriteBridge,
  type BridgeConflictReason,
  type BridgeEvent,
  type BridgeFeed,
  type BridgeOptions,
  type BridgeRooms,
} from "./bridge.js";
import type { BaseBody, CollabDocRow, DocRecords, ObjectSnapshot, RoomView } from "./docStore.js";
import { ANIMATION_MAX_GAP_MS } from "./animate.js";
import {
  AGENT_PRESENCE_IDLE_MS,
  createAgentPresence,
  createPresenceRelay,
  docRoom,
  type DocRoomKey,
  type PresenceView,
} from "./presence.js";
import { BRIDGE_ORIGIN } from "./mdDiff.js";
import { docTitle, docToMarkdown, seedDocFromMarkdown } from "./serialize.js";

/**
 * What this file asserts:
 *
 *  1. THE ROOM IS THE AUTHORIZATION. An event for an object with no live room is
 *     dropped before anything about it is read or emitted — the feed carries no
 *     RLS, so "a room exists" is the only proof the watcher has that somebody
 *     authorized is looking at this object.
 *  2. ECHO SAFETY. An event carrying THIS room's flush origin token is dropped,
 *     recognised by the token alone — the case that matters is the one where the
 *     content differs (the user typed on), because that is exactly when a
 *     content comparison would say "not mine" and start the loop.
 *  3. An external write is merged into the live doc, and the room's CAS base
 *     moves with it.
 *  4. Refusals are stated, never guessed: an unmergeable write escalates, an
 *     unrecoverable base leaves the room alone for the flush's rebase path.
 *
 * `parseOrigin` is passed in exactly as production passes p1-t2's, so the
 * round-trip through the audit event's `reason` is the thing under test rather
 * than a re-implementation of it.
 */

const OBJ = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAUDE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** The production shape (`packages/mcp-tools/src/write-path.ts`), copied so this
 *  unit test needs no build of the write path. */
const ORIGIN_SUFFIX_RE = /^([\s\S]*?)\s*dashboard#([A-Za-z0-9_.:-]{1,64})$/;
function parseOrigin(reason: string): { reason: string; origin: string | null } {
  const m = ORIGIN_SUFFIX_RE.exec(reason);
  if (!m) return { reason, origin: null };
  return { reason: m[1]!, origin: m[2]! };
}

interface Stored {
  version: number;
  title: string | null;
  body: string;
  deleted: boolean;
}

class Harness {
  readonly stored: Stored;
  readonly doc: Y.Doc;
  room: RoomView | undefined;
  readonly events: BridgeEvent[] = [];
  readonly conflicts: { objectId: string; reason: BridgeConflictReason }[] = [];
  readonly flushed: { objectId: string; version: number }[] = [];
  readonly ingested: { objectId: string; version: number }[] = [];
  readonly loads: { actorId: string; objectId: string }[] = [];
  /** Body at each version, as `before_image` would hand it back. */
  readonly history = new Map<number, string>();
  ownTokens = new Set<string>();
  baseUnavailable = false;
  seq = 0;

  constructor(body: string, version = 4, title: string | null = "T") {
    this.stored = { version, title, body, deleted: false };
    this.history.set(version, body);
    this.doc = seedDocFromMarkdown(body, { title });
    this.room = {
      objectId: OBJ,
      doc: this.doc,
      epoch: 1,
      baseVersion: version,
      state: "idle",
      connections: 1,
      lastActorId: ALICE,
      animatingTargetVersion: null,
    };
  }

  /** An external write landing in `objects` + its feed event. */
  write(
    body: string,
    opts: { reason?: string; title?: string | null; actor?: string | null } = {},
  ): void {
    this.history.set(this.stored.version, this.stored.body);
    this.stored.version += 1;
    this.stored.body = body;
    if (opts.title !== undefined) this.stored.title = opts.title;
    this.seq += 1;
    this.events.push({
      seq: this.seq,
      kind: "update",
      objectId: OBJ,
      actor: opts.actor === undefined ? CLAUDE : opts.actor,
      reason: opts.reason ?? null,
      version: this.stored.version,
    });
  }

  /** A feed event for an object that has no room here. */
  foreign(): void {
    this.seq += 1;
    this.events.push({
      seq: this.seq,
      kind: "update",
      objectId: OTHER,
      actor: CLAUDE,
      reason: null,
      version: 9,
    });
  }

  get feed(): BridgeFeed {
    return {
      since: async (seq, limit) => this.events.filter((e) => e.seq > seq).slice(0, limit),
      tip: async () => this.seq,
    };
  }

  get rooms(): BridgeRooms {
    return {
      get: (objectId) => (objectId === OBJ ? this.room : undefined),
      markFlushed: async (objectId, version) => {
        this.flushed.push({ objectId, version });
        if (this.room) this.room = { ...this.room, baseVersion: version };
      },
    };
  }

  get records(): Pick<DocRecords, "load" | "baseBody"> {
    return {
      load: async (
        actorId: string,
        objectId: string,
      ): Promise<{ object: ObjectSnapshot | null; row: CollabDocRow | null }> => {
        this.loads.push({ actorId, objectId });
        if (objectId !== OBJ) return { object: null, row: null };
        return { object: { ...this.stored }, row: null };
      },
      baseBody: async (_actorId: string, _objectId: string, version: number): Promise<BaseBody> => {
        if (this.baseUnavailable) return { kind: "unavailable" };
        const body = this.history.get(version);
        if (body === undefined) return { kind: "unavailable" };
        if (body === this.stored.body) return { kind: "unchanged" };
        return { kind: "exact", title: this.stored.title, body };
      },
    };
  }

  bridge(extra: Partial<BridgeOptions> = {}): ReturnType<typeof createAgentWriteBridge> {
    return createAgentWriteBridge({
      feed: this.feed,
      rooms: this.rooms,
      records: this.records,
      parseOrigin,
      isOwnFlush: (token) => (token ? this.ownTokens.has(token) : false),
      onConflict: (objectId, reason) => this.conflicts.push({ objectId, reason }),
      onIngest: ({ objectId, version }) => this.ingested.push({ objectId, version }),
      ...extra,
    });
  }
}

/**
 * The real relay and the real agent-presence registry, with one person already
 * in the object's room — the wiring production uses, so what these tests assert
 * about identity is what a browser would actually be sent.
 */
function presence(opts: { member?: boolean } = {}): {
  relay: ReturnType<typeof createPresenceRelay>;
  agents: ReturnType<typeof createAgentPresence>;
  room: DocRoomKey;
  sent: PresenceView[];
} {
  const room = docRoom(OBJ) as DocRoomKey;
  const sent: PresenceView[] = [];
  const relay = createPresenceRelay({ send: (_recipient, view) => sent.push(view) });
  if (opts.member !== false) {
    relay.join(room, { kind: "human", actorId: ALICE, name: "Alice" }, { clientId: "c-alice" });
  }
  return { relay, agents: createAgentPresence({ relay }), room, sent };
}

describe("agent-write bridge — the room is the authorization", () => {
  it("drops an event for an object with no live room, reading nothing about it", async () => {
    const h = new Harness("alpha");
    h.foreign();
    const bridge = h.bridge();
    await bridge.poll();
    expect(h.loads).toEqual([]); // nothing read, nothing emitted
    expect(h.ingested).toEqual([]);
    expect(bridge.stats().noRoom).toBe(1);
  });

  it("never pushes into a draining room (its final flush is committing)", async () => {
    const h = new Harness("alpha");
    h.room = { ...h.room!, state: "draining" };
    h.write("alpha\n\nagent wrote this");
    await h.bridge().poll();
    expect(docToMarkdown(h.doc)).toBe("alpha");
    expect(h.flushed).toEqual([]);
  });

  it("never pushes into an animating room (the doc holds only a prefix)", async () => {
    const h = new Harness("alpha");
    // A previous agent write is still being applied in chunks: `objects` has all
    // of it, the doc has a prefix. A second write must not be diffed into that.
    h.room = { ...h.room!, animatingTargetVersion: 5 };
    h.write("alpha\n\nagent wrote this");
    await h.bridge().poll();
    expect(docToMarkdown(h.doc)).toBe("alpha");
    // Critically, the CAS base must NOT move past a version the doc lacks.
    expect(h.flushed).toEqual([]);
    expect(h.conflicts).toEqual([]);
  });

  it("does nothing when the room's actor can no longer read the object", async () => {
    const h = new Harness("alpha");
    h.write("alpha\n\nagent wrote this");
    h.stored.deleted = true;
    await h.bridge().poll();
    expect(docToMarkdown(h.doc)).toBe("alpha");
    expect(h.flushed).toEqual([]);
    expect(h.conflicts).toEqual([]);
  });

  it("ignores kinds that cannot change a room's content", async () => {
    const h = new Harness("alpha");
    h.seq += 1;
    h.events.push({ seq: h.seq, kind: "update_props", objectId: OBJ, reason: null, version: 99 });
    h.seq += 1;
    h.events.push({ seq: h.seq, kind: "delete", objectId: OBJ, reason: null, version: 100 });
    const bridge = h.bridge();
    await bridge.poll();
    expect(h.loads).toEqual([]);
    expect(bridge.stats().cursor).toBe(h.seq); // …but the cursor still advances
  });
});

describe("agent-write bridge — echo safety", () => {
  it("drops our own flush's event even though the doc has moved on since", async () => {
    const h = new Harness("alpha");
    h.ownTokens.add("deadbeefcafe0001");
    // The flush serialized S1 and committed it…
    h.write("alpha\n\nflushed S1", { reason: "editor dashboard#deadbeefcafe0001" });
    // …and the user typed on to S2 before the event arrived. A content
    // comparison would call this "somebody else's write" — the echo loop.
    const el = h.doc.getXmlFragment("body").toArray()[0] as Y.XmlElement;
    (el.toArray()[0] as Y.XmlText).insert(5, " typed on");
    const before = docToMarkdown(h.doc);

    const bridge = h.bridge();
    await bridge.poll();

    expect(docToMarkdown(h.doc)).toBe(before);
    expect(bridge.stats().ownFlush).toBe(1);
    expect(bridge.stats().ingested).toBe(0);
    expect(h.flushed).toEqual([]);
  });

  it("still ingests when a batch holds our flush AND an external write", async () => {
    const h = new Harness("alpha");
    h.ownTokens.add("deadbeefcafe0001");
    h.write("alpha\n\nflushed S1", { reason: "editor dashboard#deadbeefcafe0001" });
    h.write("alpha\n\nflushed S1\n\nagent added this");
    const bridge = h.bridge();
    await bridge.poll();
    expect(docToMarkdown(h.doc)).toBe("alpha\n\nflushed S1\n\nagent added this");
    expect(bridge.stats().ownFlush).toBe(1);
    expect(bridge.stats().ingested).toBe(1);
  });

  it("treats an unrecognised token as external (a reason is not a credential)", async () => {
    const h = new Harness("alpha");
    h.ownTokens.add("deadbeefcafe0001");
    h.write("alpha\n\nagent wrote this", { reason: "mcp edit dashboard#0123456789abcdef" });
    await h.bridge().poll();
    expect(docToMarkdown(h.doc)).toBe("alpha\n\nagent wrote this");
  });
});

describe("agent-write bridge — ingesting an external write", () => {
  it("merges the write into the live doc and moves the room's CAS base", async () => {
    const h = new Harness("alpha\n\nbeta");
    h.write("alpha\n\nbeta\n\nagent added this", { reason: "mcp edit" });
    const bridge = h.bridge();
    await bridge.poll();
    expect(docToMarkdown(h.doc)).toBe("alpha\n\nbeta\n\nagent added this");
    expect(h.flushed).toEqual([{ objectId: OBJ, version: 5 }]);
    expect(h.ingested).toEqual([{ objectId: OBJ, version: 5 }]);
    expect(bridge.stats().cursor).toBe(1);
  });

  it("keeps what the user was typing (three-way, not a re-seed)", async () => {
    const h = new Harness("alpha\n\nbeta");
    const el = h.doc.getXmlFragment("body").toArray()[0] as Y.XmlElement;
    (el.toArray()[0] as Y.XmlText).insert(5, " typed");
    h.write("alpha\n\nbeta rewritten by an agent");
    await h.bridge().poll();
    expect(docToMarkdown(h.doc)).toBe("alpha typed\n\nbeta rewritten by an agent");
  });

  it("applies the title alongside the body", async () => {
    const h = new Harness("alpha");
    h.write("alpha edited", { title: "New title" });
    await h.bridge().poll();
    expect(docTitle(h.doc)).toBe("New title");
  });

  it("advances the base without touching the doc for a props-only write", async () => {
    const h = new Harness("alpha");
    // version moves, body does not — `before_image` has no row, so baseBody
    // answers `unchanged`.
    h.stored.version += 1;
    h.seq += 1;
    h.events.push({ seq: h.seq, kind: "update", objectId: OBJ, reason: null, version: 5 });
    let updates = 0;
    h.doc.on("update", () => {
      updates += 1;
    });
    await h.bridge().poll();
    expect(updates).toBe(0);
    expect(h.flushed).toEqual([{ objectId: OBJ, version: 5 }]);
  });

  it("skips an event the room is already reconciled to", async () => {
    const h = new Harness("alpha");
    h.seq += 1;
    h.events.push({ seq: h.seq, kind: "update", objectId: OBJ, reason: null, version: 4 });
    await h.bridge().poll();
    expect(h.loads).toEqual([]); // the version pre-filter costs no read at all
    expect(h.flushed).toEqual([]);
  });
});

describe("agent-write bridge — refusals are stated, never guessed", () => {
  it("escalates a write it cannot merge, leaving the doc untouched", async () => {
    const h = new Harness("the quick brown fox");
    const el = h.doc.getXmlFragment("body").toArray()[0] as Y.XmlElement;
    const text = el.toArray()[0] as Y.XmlText;
    text.delete(4, 5); // the user is editing "quick"…
    text.insert(4, "slow");
    h.write("the QUICK brown fox"); // …and so is the agent
    await h.bridge().poll();
    expect(docToMarkdown(h.doc)).toBe("the slow brown fox");
    expect(h.conflicts).toEqual([{ objectId: OBJ, reason: "merge_failed" }]);
    expect(h.flushed).toEqual([]); // the base does NOT move on a refusal
  });

  it("leaves an unrecoverable base to the flush's own rebase path", async () => {
    const h = new Harness("alpha");
    h.baseUnavailable = true;
    h.write("alpha\n\nagent wrote this");
    await h.bridge().poll();
    expect(docToMarkdown(h.doc)).toBe("alpha");
    expect(h.conflicts).toEqual([{ objectId: OBJ, reason: "base_unavailable" }]);
    expect(h.flushed).toEqual([]);
  });

  it("advances the cursor past an event it could not apply (no poison stall)", async () => {
    const h = new Harness("the quick brown fox");
    const text = (
      h.doc.getXmlFragment("body").toArray()[0] as Y.XmlElement
    ).toArray()[0] as Y.XmlText;
    text.delete(4, 5);
    text.insert(4, "slow");
    h.write("the QUICK brown fox");
    const bridge = h.bridge();
    await bridge.poll();
    expect(bridge.stats().cursor).toBe(1);
    // A second poll sees no work rather than retrying the same failure forever.
    await bridge.poll();
    expect(h.conflicts).toHaveLength(1);
  });

  it("does not advance the cursor when the feed itself fails", async () => {
    const h = new Harness("alpha");
    h.write("alpha\n\nagent wrote this");
    const bridge = createAgentWriteBridge({
      feed: {
        since: async () => {
          throw new Error("database is down");
        },
        tip: async () => 0,
      },
      rooms: h.rooms,
      records: h.records,
      parseOrigin,
      isOwnFlush: () => false,
    });
    await bridge.poll();
    expect(bridge.stats().cursor).toBe(0);
    expect(bridge.stats().errors).toBe(1);
  });
});

describe("agent-write bridge — lifecycle", () => {
  it("starts at the feed tip rather than replaying history", async () => {
    const h = new Harness("alpha");
    h.write("alpha\n\nwritten before this process existed");
    const bridge = h.bridge();
    await bridge.start();
    expect(bridge.stats().cursor).toBe(1);
    await bridge.poll();
    expect(docToMarkdown(h.doc)).toBe("alpha");
    bridge.stop();
  });

  it("drains a batch-sized backlog over several cycles", async () => {
    const h = new Harness("alpha");
    for (let i = 0; i < 5; i += 1) h.foreign();
    h.write("alpha\n\nagent added this");
    const bridge = createAgentWriteBridge({
      feed: h.feed,
      rooms: h.rooms,
      records: h.records,
      parseOrigin,
      isOwnFlush: () => false,
      batch: 2,
    });
    await bridge.poll();
    expect(bridge.stats().cursor).toBe(6);
    expect(docToMarkdown(h.doc)).toBe("alpha\n\nagent added this");
  });
});

describe("agent-write bridge — the write has a name (phase 5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes the write's REAL actor, named from accounts, as a robot", async () => {
    const h = new Harness("alpha");
    const { relay, agents, room, sent } = presence();
    h.write("alpha\n\nagent added this", { actor: CLAUDE });

    const bridge = h.bridge({ agents, actorName: () => "Claude" });
    await bridge.poll();

    expect(docToMarkdown(h.doc)).toBe("alpha\n\nagent added this");
    const robot = relay.entries(room).find((e) => e.identity.kind === "agent");
    expect(robot?.identity).toMatchObject({
      kind: "agent",
      actorId: CLAUDE,
      name: "Claude",
      color: "presence-agent",
      glyph: "robot",
    });
    expect(bridge.stats().cursors).toBe(1);
    // …and the person in the room was told, without being asked anything.
    const last = sent.at(-1);
    expect(last?.states.some((s) => s.kind === "agent" && s.actorId === CLAUDE)).toBe(true);
  });

  it("leaves after the idle linger, the way a human's cursor does", async () => {
    vi.useFakeTimers();
    const h = new Harness("alpha");
    const { relay, agents, room } = presence();
    h.write("alpha\n\nagent added this");
    await h.bridge({ agents, actorName: () => "Claude" }).poll();
    expect(relay.size(room)).toBe(2);

    await vi.advanceTimersByTimeAsync(AGENT_PRESENCE_IDLE_MS + 1);
    expect(relay.size(room)).toBe(1);
    expect(relay.entries(room).some((e) => e.identity.kind === "agent")).toBe(false);
  });

  it("falls back to an honest name rather than guessing one", async () => {
    const h = new Harness("alpha");
    const { relay, agents, room } = presence();
    h.write("alpha\n\nagent added this");
    // A revoked account, a rename in flight, a hiccup: no name, still a cursor.
    await h
      .bridge({
        agents,
        actorName: () => {
          throw new Error("pool exhausted");
        },
      })
      .poll();
    expect(docToMarkdown(h.doc)).toBe("alpha\n\nagent added this");
    expect(relay.entries(room).find((e) => e.identity.kind === "agent")?.identity.name).toBe(
      "Agent",
    );
  });

  it("applies the write silently when there is no room to publish into", async () => {
    // The doc store has a room (the bridge's authorization); the PRESENCE room
    // is empty — nobody is watching. No client is created for an audience of
    // nobody, and the write still lands.
    const h = new Harness("alpha");
    const { relay, agents, room } = presence({ member: false });
    h.write("alpha\n\nagent added this");
    const bridge = h.bridge({ agents, actorName: () => "Claude" });
    await bridge.poll();
    expect(docToMarkdown(h.doc)).toBe("alpha\n\nagent added this");
    expect(relay.size(room)).toBe(0);
    expect(relay.stats().rooms).toBe(0);
    expect(bridge.stats().cursors).toBe(0);
  });

  it("publishes nothing when the event does not say who wrote it", async () => {
    const h = new Harness("alpha");
    const { relay, agents, room } = presence();
    h.write("alpha\n\nagent added this", { actor: null });
    const bridge = h.bridge({ agents, actorName: () => "Claude" });
    await bridge.poll();
    expect(docToMarkdown(h.doc)).toBe("alpha\n\nagent added this");
    expect(relay.size(room)).toBe(1); // Alice, alone
    expect(bridge.stats().cursors).toBe(0);
  });

  it("publishes no cursor for a props-only write — nothing was written here", async () => {
    const h = new Harness("alpha");
    const { relay, agents, room } = presence();
    h.stored.version += 1;
    h.seq += 1;
    h.events.push({
      seq: h.seq,
      kind: "update",
      objectId: OBJ,
      actor: CLAUDE,
      reason: null,
      version: 5,
    });
    await h.bridge({ agents, actorName: () => "Claude" }).poll();
    expect(relay.size(room)).toBe(1);
  });

  it("takes the cursor away again when the write could not be merged", async () => {
    const h = new Harness("the quick brown fox");
    const { relay, agents, room } = presence();
    const text = (
      h.doc.getXmlFragment("body").toArray()[0] as Y.XmlElement
    ).toArray()[0] as Y.XmlText;
    text.delete(4, 5);
    text.insert(4, "slow");
    h.write("the QUICK brown fox");

    await h.bridge({ agents, actorName: () => "Claude" }).poll();
    expect(h.conflicts).toEqual([{ objectId: OBJ, reason: "merge_failed" }]);
    // An agent that changed nothing was never here.
    expect(relay.size(room)).toBe(1);
    expect(relay.entries(room).some((e) => e.identity.kind === "agent")).toBe(false);
  });

  it("keeps the flush's origin by default, and honours a wiring that changes it", async () => {
    const h = new Harness("alpha");
    const { agents } = presence();
    const origins: unknown[] = [];
    h.doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
    h.write("alpha\n\nagent added this");
    await h.bridge({ agents, actorName: () => "Claude" }).poll();
    // Anything flush.ts does not recognise is treated as a human contribution,
    // refused for having no account behind it, and reverted back out.
    expect(origins).toEqual([BRIDGE_ORIGIN]);

    const h2 = new Harness("alpha");
    const seen: unknown[] = [];
    h2.doc.on("update", (_u: Uint8Array, origin: unknown) => seen.push(origin));
    const p2 = presence();
    h2.write("alpha\n\nagent added this");
    await h2
      .bridge({
        agents: p2.agents,
        actorName: () => "Claude",
        originFor: (agent) => ({ kind: "agent", ...agent }),
      })
      .poll();
    expect(seen).toEqual([{ kind: "agent", actorId: CLAUDE, clientId: expect.any(String) }]);
  });

  it("lands the write even when presence itself throws", async () => {
    const h = new Harness("alpha");
    h.write("alpha\n\nagent added this");
    const bridge = h.bridge({
      agents: {
        enter: () => {
          throw new Error("relay exploded");
        },
      },
      actorName: () => "Claude",
    });
    await bridge.poll();
    expect(docToMarkdown(h.doc)).toBe("alpha\n\nagent added this");
    expect(bridge.stats().ingested).toBe(1);
    expect(bridge.stats().cursors).toBe(0);
  });

  it("travels the robot cursor across the ranges the write touched", async () => {
    // Phase 5's moving cursor, wired through `planAnimation`: a multi-block write
    // with a live human viewer is paced into a short sequence of cursor hops, so
    // the robot is seen to work its way DOWN the document rather than blinking on
    // statically. The content itself lands in one transaction — the animation is
    // presentation only, never a precondition — so this asserts the CURSOR moves,
    // not the text.
    vi.useFakeTimers();
    const h = new Harness("alpha");
    const { relay, agents, room } = presence(); // one human viewer (Alice) present
    h.write("alpha\n\nbeta\n\ngamma"); // two NEW blocks → two ranges to visit

    await h.bridge({ agents, actorName: () => "Claude" }).poll();
    // The whole write is already applied — the animation never touched the doc.
    expect(docToMarkdown(h.doc)).toBe("alpha\n\nbeta\n\ngamma");

    const agentPos = (): { anchor?: number; head?: number } | undefined =>
      relay.entries(room).find((e) => e.identity.kind === "agent")?.position;

    // First hop landed synchronously with the ingest.
    const first = agentPos();
    expect(first?.anchor).toBeGreaterThan(0);

    // A later hop moves the cursor FORWARD, to the next range — the travel.
    await vi.advanceTimersByTimeAsync(ANIMATION_MAX_GAP_MS + 1);
    const second = agentPos();
    expect(second?.anchor).toBeGreaterThan(first!.anchor!);
  });
});
