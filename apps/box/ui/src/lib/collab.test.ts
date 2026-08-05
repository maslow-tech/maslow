import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  AGENT_TRAIL_MAX,
  AGENT_TRAIL_MS,
  COLLAB_AGENT_COLOR,
  COLLAB_AGENT_GLYPH,
  COLLAB_CLOSE,
  addTrailMark,
  backoffDelay,
  collabSocketUrl,
  connectRoom,
  isAgentPeer,
  pruneTrail,
  readEpoch,
  readPeerIdentity,
  readRoomContent,
  reapplyDecision,
  trailStrength,
  writeRoomContent,
  RECONNECT_CAP_MS,
  type CollabPersistence,
  type CollabProvider,
  type CollabProviderArgs,
  type CollabSaveQueue,
  type CollabSession,
  type CollabState,
  type ConnectRoomOptions,
  type EditTrailMark,
  type RoomContent,
} from "./collab";

/**
 * The client collab session is where "no duplicated body, no double-written
 * edit, no thundering herd" is actually enforced, so each rule gets a test:
 *
 *  - ticket BEFORE socket, and the ticket in the URL;
 *  - the epoch reset (server authoritative, unacked text re-applied, conflict
 *    when it no longer applies) versus the same-epoch lossless merge;
 *  - the save-queue suspension state machine across drop → retry → sync;
 *  - backoff that grows, caps and jitters;
 *  - the refusals that must NEVER be retried.
 *
 * Everything runs against a fake provider implementing exactly the narrow
 * `CollabProvider` surface — no websocket, no server, no timers of its own.
 */

/* ------------------------------------------------------------------ harness */

class FakeProvider implements CollabProvider {
  readonly awareness = { fake: true };
  destroyed = false;
  constructor(readonly args: CollabProviderArgs) {}
  destroy(): void {
    this.destroyed = true;
  }
  /** the doc this connection syncs into (the session's staging doc) */
  get doc(): Y.Doc {
    return this.args.document;
  }
  epoch(value: number): void {
    this.args.handlers.onStateless(JSON.stringify({ type: "epoch", epoch: value }));
  }
  sync(): void {
    this.args.handlers.onSynced();
  }
  /** the server has acked every local update — the real provider fires this when
   *  `unsyncedChanges` reaches 0. */
  flush(): void {
    this.args.handlers.onFlushed();
  }
  close(code?: number, reason?: string): void {
    this.args.handlers.onClose({ code, reason });
  }
  drop(): void {
    this.args.handlers.onStatus("disconnected");
  }
}

interface Harness {
  session: CollabSession;
  providers: FakeProvider[];
  tickets: string[];
  timers: Array<{ ms: number; fire: () => void; cancelled: boolean }>;
  states: CollabState[];
  queue: {
    suspended: string[][];
    resumed: number;
    /** what `takeRoomContent` returns ONCE (pre-sync CAS body/title); nulled
     *  after it is taken, and `taken` counts the calls. */
    roomContent: Partial<RoomContent> | null;
    taken: number;
  };
  /** run the pending reconnect timer */
  runTimer(): Promise<void>;
  /** fire the pending throttled offline-persist timer */
  flushPersist(): Promise<void>;
  last(): FakeProvider;
}

/** let the async ticket mint settle */
const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

function harness(over: Partial<ConnectRoomOptions> = {}): Harness {
  const providers: FakeProvider[] = [];
  const tickets: string[] = [];
  const timers: Harness["timers"] = [];
  const states: CollabState[] = [];
  const queue: Harness["queue"] = {
    suspended: [] as string[][],
    resumed: 0,
    roomContent: null as Partial<RoomContent> | null,
    taken: 0,
  };
  const saveQueue: CollabSaveQueue = {
    suspend: (fields) => queue.suspended.push([...fields]),
    resume: () => {
      queue.resumed += 1;
    },
    takeRoomContent: () => {
      queue.taken += 1;
      const held = queue.roomContent;
      queue.roomContent = null; // single-use, like the real queue draining pending
      return held;
    },
  };
  let minted = 0;

  const session = connectRoom({
    objectId: "obj-1",
    origin: "https://brain.example.com",
    saveQueue,
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

  return {
    session,
    providers,
    tickets,
    timers,
    states,
    queue,
    last: () => providers[providers.length - 1]!,
    runTimer: async () => {
      const pending = timers.filter((t) => !t.cancelled).pop();
      if (!pending) throw new Error("no reconnect timer scheduled");
      pending.cancelled = true;
      pending.fire();
      await tick();
    },
    /** Fire the pending throttled offline-persist timer (the doc-`update`
     *  observer coalesces a burst into one write; production waits
     *  COLLAB_PERSIST_THROTTLE_MS, tests fire it deterministically). Pre-sync
     *  there is no reconnect timer, so the last pending timer is the persist. */
    flushPersist: async () => {
      const pending = timers.filter((t) => !t.cancelled).pop();
      if (pending) {
        pending.cancelled = true;
        pending.fire();
      }
      await tick();
    },
  };
}

/** Seed a doc the way the SERVER does: markdown into body + title. */
function seed(doc: Y.Doc, content: { title?: string; body?: string }): void {
  writeRoomContent(doc, content);
}

/* ------------------------------------------------------------------- pure */

describe("backoffDelay — grows, caps at ~30s, and is jittered", () => {
  it("grows exponentially and never exceeds the cap", () => {
    const top = (attempt: number): number => backoffDelay(attempt, () => 1);
    expect(top(1)).toBe(500);
    expect(top(2)).toBe(1000);
    expect(top(3)).toBe(2000);
    expect(top(9)).toBe(RECONNECT_CAP_MS);
    expect(top(30)).toBe(RECONNECT_CAP_MS);
  });

  it("keeps half the window as a floor so a long outage is not a hot loop", () => {
    for (const attempt of [1, 4, 12]) {
      const low = backoffDelay(attempt, () => 0);
      const high = backoffDelay(attempt, () => 1);
      expect(low).toBeGreaterThan(0);
      expect(low).toBe(Math.round(high / 2));
    }
  });

  it("spreads two clients that dropped in the same millisecond", () => {
    const a = backoffDelay(5, () => 0.01);
    const b = backoffDelay(5, () => 0.99);
    expect(a).not.toBe(b);
  });
});

describe("reapplyDecision — the epoch reset's three-way decision", () => {
  const base = { title: "T", body: "hello" };

  it("takes the server when nothing was typed while we were away", () => {
    expect(reapplyDecision(base, base, { title: "T", body: "hello there" })).toBe("clean");
  });

  it("re-applies our unacked text when the server did not move", () => {
    expect(reapplyDecision(base, { title: "T", body: "hello you" }, base)).toBe("reapply");
  });

  it("never auto-merges two diverged documents", () => {
    expect(
      reapplyDecision(base, { title: "T", body: "mine" }, { title: "T", body: "theirs" }),
    ).toBe("conflict");
  });

  it("counts the title as content too", () => {
    expect(reapplyDecision(base, { title: "Mine", body: "hello" }, base)).toBe("reapply");
  });

  it("is CLEAN, not conflict, when local already equals the server", () => {
    // The first sync's base is the EMPTY fallback (acked still null) while the
    // offline buffer was seeded into `doc`. If that buffer already reached the
    // server (pagehide beacon) or someone typed the identical text, local and
    // server are equal though both differ from the empty base — that is not a
    // conflict, it is "our edit landed". A phantom banner here reads "what
    // changed: nothing".
    const empty = { title: "", body: "" };
    const same = { title: "T", body: "already delivered" };
    expect(reapplyDecision(empty, same, same)).toBe("clean");
  });
});

describe("readEpoch / collabSocketUrl", () => {
  it("reads an epoch out of a stateless payload and ignores anything else", () => {
    expect(readEpoch(JSON.stringify({ type: "epoch", epoch: 42 }))).toBe(42);
    expect(readEpoch(JSON.stringify({ type: "other" }))).toBeNull();
    expect(readEpoch("not json")).toBeNull();
  });

  it("carries the ticket in the query string over ws/wss", () => {
    expect(collabSocketUrl("abc", "https://brain.example.com")).toBe(
      "wss://brain.example.com/dash/collab?ticket=abc",
    );
    expect(collabSocketUrl("a b", "http://localhost:8080")).toBe(
      "ws://localhost:8080/dash/collab?ticket=a+b",
    );
  });
});

describe("readRoomContent / writeRoomContent — the doc↔markdown bridge", () => {
  it("round-trips a body and a title through the room's Y types", () => {
    const doc = new Y.Doc();
    seed(doc, { title: "Notes", body: "# Heading\n\nsome text" });
    expect(readRoomContent(doc)).toEqual({ title: "Notes", body: "# Heading\n\nsome text" });
  });

  it("reads an untouched room as empty rather than throwing", () => {
    expect(readRoomContent(new Y.Doc())).toEqual({ title: "", body: "" });
  });

  it("re-applies text as a diff, leaving the shared prefix alone", () => {
    const doc = new Y.Doc();
    seed(doc, { title: "Deal alpha", body: "one\n\ntwo" });
    const before = doc.getText("title").toString();
    writeRoomContent(doc, { title: "Deal beta", body: "one\n\ntwo\n\nthree" });
    expect(before).toBe("Deal alpha");
    expect(readRoomContent(doc)).toEqual({ title: "Deal beta", body: "one\n\ntwo\n\nthree" });
  });
});

/* --------------------------------------------------------------- lifecycle */

describe("connectRoom — ticket first, socket second", () => {
  it("mints a ticket BEFORE opening any socket, and puts it in the URL", async () => {
    const h = harness();
    expect(h.providers).toHaveLength(0); // nothing opened before the mint resolves
    await tick();
    expect(h.tickets).toEqual(["t1"]);
    expect(h.providers).toHaveLength(1);
    expect(h.last().args.url).toBe("wss://brain.example.com/dash/collab?ticket=t1");
    expect(h.last().args.name).toBe("obj-1");
  });

  it("suspends body/title while connecting and hands them back once synced", async () => {
    const h = harness();
    await tick();
    expect(h.queue.suspended).toEqual([["body", "title"]]);
    expect(h.queue.resumed).toBe(0);
    expect(h.session.state().status).toBe("connecting");
    expect(h.session.state().pollFeed).toBe(true);

    seed(h.last().doc, { title: "T", body: "server text" });
    h.last().sync();

    const state = h.session.state();
    expect(state.status).toBe("live");
    expect(state.pollFeed).toBe(false);
    expect(h.queue.resumed).toBe(1);
    expect(readRoomContent(state.doc).body).toBe("server text");
  });

  it("carries pre-first-sync CAS body/title into the synced CRDT, not the void", async () => {
    const h = harness();
    await tick();
    // The user typed on open, before the socket synced: the edit is held on the
    // SUSPENDED CAS queue (never sent, never in the pre-sync doc).
    h.queue.roomContent = { title: "My title", body: "text typed on open" };

    // The server doc holds the object's stored (un-edited) content.
    seed(h.last().doc, { title: "Loaded", body: "loaded body" });
    h.last().sync();

    const state = h.session.state();
    expect(state.status).toBe("live");
    // The queue was drained exactly once, and the typed text is now IN the room
    // — it will save over the socket, not vanish and not 409 on resume.
    expect(h.queue.taken).toBe(1);
    expect(readRoomContent(state.doc)).toEqual({ title: "My title", body: "text typed on open" });
  });

  it("does not disturb the synced doc when nothing was typed pre-sync", async () => {
    const h = harness();
    await tick();
    h.queue.roomContent = null; // nothing held

    seed(h.last().doc, { title: "Loaded", body: "loaded body" });
    h.last().sync();

    const state = h.session.state();
    expect(h.queue.taken).toBe(1);
    // The server's content stands untouched.
    expect(readRoomContent(state.doc)).toEqual({ title: "Loaded", body: "loaded body" });
  });
});

describe("socket drop — the Y.Doc is the offline buffer and CAS may not write body", () => {
  it("suspends body/title for the duration and keeps the editor's doc", async () => {
    const h = harness();
    await tick();
    seed(h.last().doc, { body: "server text" });
    h.last().sync();
    const liveDoc = h.session.state().doc;

    h.last().drop();

    const state = h.session.state();
    expect(state.status).toBe("offline");
    // The feed poller is the ONLY liveness fallback while the socket is down.
    expect(state.pollFeed).toBe(true);
    // Same doc identity: the editor keeps typing into it, offline.
    expect(state.doc).toBe(liveDoc);
    // suspend() ran again for the offline window; resume() has NOT.
    expect(h.queue.suspended).toEqual([
      ["body", "title"],
      ["body", "title"],
    ]);
    expect(h.queue.resumed).toBe(1);
    expect(h.providers[0]?.destroyed).toBe(true);
  });

  it("reconnects on a jittered backoff and mints a FRESH ticket each time", async () => {
    const h = harness();
    await tick();
    h.last().sync();
    h.last().drop();

    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(backoffDelay(1, () => 0.5));
    await h.runTimer();
    // Single-use tickets: a replayed one is refused, so every attempt mints.
    expect(h.tickets).toEqual(["t1", "t2"]);
    expect(h.providers).toHaveLength(2);
    expect(h.last().args.url).toContain("ticket=t2");

    // A second failure backs off further.
    h.last().close(1006, "abnormal");
    expect(h.timers[1]?.ms).toBe(backoffDelay(2, () => 0.5));
  });

  it("only opens one socket per drop, even when close AND disconnect both fire", async () => {
    const h = harness();
    await tick();
    h.last().sync();
    const provider = h.last();
    provider.close(1006, "abnormal");
    provider.drop();
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });
});

describe("doc epoch — server state wins, unacked text is re-applied as a diff", () => {
  it("merges losslessly when the epoch is unchanged", async () => {
    const h = harness();
    await tick();
    h.last().epoch(100);
    seed(h.last().doc, { body: "shared" });
    h.last().sync();

    // typed while the socket was up, then the socket dies
    const liveDoc = h.session.state().doc;
    writeRoomContent(liveDoc, { body: "shared\n\nmine" });
    h.last().drop();
    await h.runTimer();

    // The room survived (same epoch), so the server's doc is the SAME lineage
    // it sent us plus whatever we sent it — replay it as a Yjs update, which is
    // what a real re-sync delivers.
    h.last().epoch(100);
    Y.applyUpdate(h.last().doc, Y.encodeStateAsUpdate(liveDoc));
    h.last().sync();

    const state = h.session.state();
    expect(state.status).toBe("live");
    expect(state.conflict).toBeNull();
    // Lossless Yjs merge — the body appears ONCE, not twice.
    expect(readRoomContent(state.doc).body).toBe("shared\n\nmine");
  });

  it("discards local Y state on an epoch change and re-applies unacked text", async () => {
    const h = harness();
    await tick();
    h.last().epoch(100);
    seed(h.last().doc, { title: "Deal", body: "acked text" });
    h.last().sync();
    const staleDoc = h.session.state().doc;

    h.last().drop();
    // Typed into the offline buffer after the drop — unacked by definition.
    writeRoomContent(staleDoc, { body: "acked text\n\noffline paragraph" });
    await h.runTimer();

    // The box was recreated: a NEW epoch, re-seeded from the same markdown.
    h.last().epoch(200);
    seed(h.last().doc, { title: "Deal", body: "acked text" });
    h.last().sync();

    const state = h.session.state();
    expect(state.epoch).toBe(200);
    expect(state.conflict).toBeNull();
    // The stale doc was NOT merged (that would duplicate the body end to end);
    // our unacked paragraph was re-applied on top of server state instead.
    expect(state.doc).not.toBe(staleDoc);
    expect(readRoomContent(state.doc).body).toBe("acked text\n\noffline paragraph");
  });

  it("re-applies edits that were UNACKED at an abrupt drop, not just those typed after it", async () => {
    // The box-self-update case: the socket drops with a Yjs update still unsent,
    // so the last-flushed server blob (what the room re-seeds from) never saw it.
    const h = harness();
    await tick();
    h.last().epoch(100);
    seed(h.last().doc, { title: "Deal", body: "hello" });
    h.last().sync();
    h.last().flush(); // the server has acked exactly "hello"
    const liveDoc = h.session.state().doc;

    // Typed while LIVE, then the socket drops before this update is transmitted —
    // unacked, unsent, unflushed. The offline baseline must remain "hello".
    writeRoomContent(liveDoc, { title: "Deal", body: "hello world" });
    h.last().drop();
    await h.runTimer();

    // The box recreated and re-seeded from the last flushed blob: a new epoch
    // holding only "hello", never the unsent " world".
    h.last().epoch(200);
    seed(h.last().doc, { title: "Deal", body: "hello" });
    h.last().sync();

    const state = h.session.state();
    expect(state.epoch).toBe(200);
    expect(state.conflict).toBeNull();
    // The unsent edit is re-applied on top of the server's state, not silently
    // dropped by a baseline that over-claimed it as already acked.
    expect(readRoomContent(state.doc).body).toBe("hello world");
  });

  it("surfaces a conflict when the re-applied text no longer applies cleanly", async () => {
    const h = harness();
    await tick();
    h.last().epoch(100);
    seed(h.last().doc, { body: "acked text" });
    h.last().sync();
    const staleDoc = h.session.state().doc;

    h.last().drop();
    writeRoomContent(staleDoc, { body: "my offline edit" });
    await h.runTimer();

    // Re-seeded AND someone else's write landed while we were away.
    h.last().epoch(200);
    seed(h.last().doc, { body: "their edit" });
    h.last().sync();

    const state = h.session.state();
    expect(state.status).toBe("live");
    // Server state stands; our text is kept verbatim for the banner.
    expect(readRoomContent(state.doc).body).toBe("their edit");
    expect(state.conflict?.mine.body).toBe("my offline edit");
    expect(state.conflict?.theirs.body).toBe("their edit");

    h.session.keepMine();
    expect(h.session.state().conflict).toBeNull();
    expect(readRoomContent(h.session.state().doc).body).toBe("my offline edit");
  });

  it("takes the server's text without re-applying when nothing was typed offline", async () => {
    const h = harness();
    await tick();
    h.last().epoch(100);
    seed(h.last().doc, { body: "acked text" });
    h.last().sync();

    h.last().drop();
    await h.runTimer();
    h.last().epoch(200);
    seed(h.last().doc, { body: "someone else wrote this" });
    h.last().sync();

    expect(h.session.state().conflict).toBeNull();
    expect(readRoomContent(h.session.state().doc).body).toBe("someone else wrote this");
  });

  it("takes the conservative (markdown) path when the server advertises no epoch", async () => {
    const h = harness();
    await tick();
    seed(h.last().doc, { body: "acked text" });
    h.last().sync();
    const staleDoc = h.session.state().doc;

    h.last().drop();
    writeRoomContent(staleDoc, { body: "acked text\n\nmine" });
    await h.runTimer();
    seed(h.last().doc, { body: "acked text" });
    h.last().sync();

    // No epoch on either side ⇒ never a blind Yjs merge; the body is applied
    // once, not twice.
    expect(readRoomContent(h.session.state().doc).body).toBe("acked text\n\nmine");
  });
});

describe("everSynced — the 'this doc has held server content' latch", () => {
  it("is false until the first sync and latches true across a later denial", async () => {
    const h = harness();
    await tick();
    // Never synced: the doc is only ever an offline buffer, so a host must not
    // read an empty doc as "the body is empty".
    expect(h.session.state().everSynced).toBe(false);

    // A denial before any sync must NOT flip the latch — the doc still never
    // held the object's content (this is exactly what protects ObjectView from
    // wiping the loaded body onto CAS on a pre-sync BAD_ORIGIN/ROOM_FORBIDDEN).
    const denied = harness();
    await tick();
    denied.last().close(COLLAB_CLOSE.ROOM_FORBIDDEN, "not available");
    expect(denied.session.state().status).toBe("denied");
    expect(denied.session.state().everSynced).toBe(false);

    // Once synced it is true, and stays true even after the room is later denied.
    seed(h.last().doc, { body: "server body" });
    h.last().sync();
    expect(h.session.state().everSynced).toBe(true);
    h.last().close(COLLAB_CLOSE.BAD_ORIGIN, "bad origin");
    expect(h.session.state().status).toBe("denied");
    expect(h.session.state().everSynced).toBe(true);
  });
});

describe("refusals — retry the ones a retry can fix, and only those", () => {
  it("never retries a bad Origin, and hands body/title back to CAS", async () => {
    const h = harness();
    await tick();
    h.last().close(COLLAB_CLOSE.BAD_ORIGIN, "bad origin");

    expect(h.session.state().status).toBe("denied");
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
    expect(h.queue.resumed).toBe(1);
  });

  it("never retries a refused room join", async () => {
    const h = harness();
    await tick();
    h.last().close(COLLAB_CLOSE.ROOM_FORBIDDEN, "not available");
    expect(h.session.state().status).toBe("denied");
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });

  it("retries an eviction, a box-off and a drain", async () => {
    for (const code of [COLLAB_CLOSE.EVICTED, COLLAB_CLOSE.BOX_OFF, COLLAB_CLOSE.DRAINING]) {
      const h = harness();
      await tick();
      h.last().close(code, "later");
      expect(h.session.state().status).toBe("offline");
      await h.runTimer();
      expect(h.providers).toHaveLength(2);
    }
  });

  it("retries a stale ticket a few times, then stops rather than hot-looping", async () => {
    const h = harness({ maxUnauthorizedRetries: 2 });
    await tick();
    h.last().close(COLLAB_CLOSE.UNAUTHORIZED, "unauthorized");
    await h.runTimer();
    h.last().close(COLLAB_CLOSE.UNAUTHORIZED, "unauthorized");
    await h.runTimer();
    expect(h.session.state().status).toBe("connecting");
    h.last().close(COLLAB_CLOSE.UNAUTHORIZED, "unauthorized");
    expect(h.session.state().status).toBe("denied");
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });

  it("backs off when the ticket cannot be minted, and never opens a socket", async () => {
    const h = harness({
      mintTicket: () => Promise.reject(new Error("network down")),
    });
    await tick();
    expect(h.providers).toHaveLength(0);
    expect(h.session.state().status).toBe("offline");
    expect(h.timers).toHaveLength(1);
  });
});

describe("teardown", () => {
  it("stops retrying, drops the socket and hands the fields back", async () => {
    const h = harness();
    await tick();
    h.last().drop();
    h.session.destroy();

    expect(h.providers[0]?.destroyed).toBe(true);
    expect(h.timers.every((t) => t.cancelled)).toBe(true);
    expect(h.queue.resumed).toBe(1);
  });

  it("publishes every transition to subscribers", async () => {
    const h = harness();
    const seen: string[] = [];
    h.session.subscribe((state) => seen.push(state.status));
    await tick();
    h.last().sync();
    h.last().drop();
    expect(seen).toContain("live");
    expect(seen).toContain("offline");
  });

  it("runs without a save queue at all (the host may own suspension itself)", async () => {
    const h = harness({ saveQueue: null });
    await tick();
    h.last().sync();
    expect(h.session.state().status).toBe("live");
    expect(h.queue.suspended).toEqual([]);
  });
});

/* ------------------------------------------------------- stamped identity
 *
 * The relay is what makes an identity unforgeable; this reader is what keeps
 * the CLIENT from drawing a robot for anything the relay did not mint. Each
 * refusal below is a payload a browser in the room could publish.
 */

const AGENT_ACTOR = "11111111-2222-4333-8444-555555555555";
const HUMAN_ACTOR = "99999999-8888-4777-8666-555555555555";

function agentStamp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "agent",
    actorId: AGENT_ACTOR,
    name: "Claude",
    color: "presence-agent",
    glyph: "robot",
    ...over,
  };
}

function humanStamp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "human",
    actorId: HUMAN_ACTOR,
    name: "Dana Reed",
    color: "presence-3",
    glyph: "DR",
    ...over,
  };
}

describe("readPeerIdentity", () => {
  it("reads a stamped agent and a stamped human", () => {
    expect(readPeerIdentity(agentStamp())).toEqual({
      kind: "agent",
      actorId: AGENT_ACTOR,
      name: "Claude",
      color: COLLAB_AGENT_COLOR,
      glyph: COLLAB_AGENT_GLYPH,
    });
    expect(readPeerIdentity(humanStamp())?.kind).toBe("human");
    expect(isAgentPeer(readPeerIdentity(agentStamp()))).toBe(true);
    expect(isAgentPeer(readPeerIdentity(humanStamp()))).toBe(false);
  });

  it("refuses a half-stamped agent — the shape a client forging one would have", () => {
    // The reserved slot and the robot glyph are stamped together or not at all.
    expect(readPeerIdentity(agentStamp({ color: "presence-2" }))).toBeNull();
    expect(readPeerIdentity(agentStamp({ glyph: "AI" }))).toBeNull();
    // …and a human may never wear either of them.
    expect(readPeerIdentity(humanStamp({ color: "presence-agent" }))).toBeNull();
    expect(readPeerIdentity(humanStamp({ glyph: "robot" }))).toBeNull();
  });

  it("refuses anything outside the relay's own vocabulary", () => {
    expect(readPeerIdentity(null)).toBeNull();
    expect(readPeerIdentity("Claude")).toBeNull();
    expect(readPeerIdentity([agentStamp()])).toBeNull();
    // the shape a plain, unstamped tiptap client publishes
    expect(readPeerIdentity({ name: "Dana", color: "#ff0000" })).toBeNull();
    expect(readPeerIdentity(humanStamp({ kind: "robot" }))).toBeNull();
    expect(readPeerIdentity(humanStamp({ actorId: "dana" }))).toBeNull();
    expect(readPeerIdentity(humanStamp({ color: "presence-9" }))).toBeNull();
    expect(readPeerIdentity(humanStamp({ color: "#2563eb" }))).toBeNull();
    expect(readPeerIdentity(humanStamp({ name: "   " }))).toBeNull();
    expect(readPeerIdentity(humanStamp({ name: 7 }))).toBeNull();
  });

  it("bounds a label the way the relay bounds a name", () => {
    const long = readPeerIdentity(humanStamp({ name: "d".repeat(400) }));
    expect(long?.name.length).toBe(48);
    const stripped = readPeerIdentity(humanStamp({ name: "Dana" }));
    expect(stripped?.name).toBe("Dana");
    // an uppercase uuid is the same actor
    expect(readPeerIdentity(humanStamp({ actorId: HUMAN_ACTOR.toUpperCase() }))?.actorId).toBe(
      HUMAN_ACTOR,
    );
  });
});

/* ------------------------------------------------------------- edit trail */

const trailMark = (over: Partial<EditTrailMark> = {}): EditTrailMark => ({
  clientId: 7,
  from: 10,
  to: 20,
  at: 1_000,
  color: COLLAB_AGENT_COLOR,
  ...over,
});

describe("edit trail", () => {
  it("decays from full to nothing over the ttl", () => {
    const mark = trailMark();
    expect(trailStrength(mark, 1_000)).toBe(1);
    expect(trailStrength(mark, 1_000 + AGENT_TRAIL_MS / 2)).toBeCloseTo(0.5, 5);
    expect(trailStrength(mark, 1_000 + AGENT_TRAIL_MS)).toBe(0);
    expect(trailStrength(mark, 9_000)).toBe(0);
  });

  it("prunes what has decayed and what a mapping collapsed to nothing", () => {
    const marks = [trailMark(), trailMark({ at: 1_400 }), trailMark({ from: 4, to: 4 })];
    // past the newest mark's ttl — and the empty one was never renderable
    expect(pruneTrail(marks, 1_400 + AGENT_TRAIL_MS)).toEqual([]);
    expect(pruneTrail(marks, 1_100)).toHaveLength(2);
  });

  it("merges one agent's abutting chunks into a single growing highlight", () => {
    // The chunk scheduler walks the document top to bottom, so an animated
    // write arrives as a run of touching ranges.
    let marks: EditTrailMark[] = [];
    marks = addTrailMark(marks, trailMark({ from: 10, to: 20, at: 1_000 }));
    marks = addTrailMark(marks, trailMark({ from: 20, to: 26, at: 1_050 }));
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ from: 10, to: 26, at: 1_050 });
  });

  it("never merges two clients — that would attribute one peer's text to another", () => {
    let marks = addTrailMark([], trailMark({ clientId: 1, from: 10, to: 20 }));
    marks = addTrailMark(marks, trailMark({ clientId: 2, from: 12, to: 22 }));
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.clientId)).toEqual([1, 2]);
  });

  it("keeps disjoint ranges apart and ignores an empty one", () => {
    let marks = addTrailMark([], trailMark({ from: 10, to: 20 }));
    marks = addTrailMark(marks, trailMark({ from: 40, to: 44 }));
    expect(marks).toHaveLength(2);
    expect(addTrailMark(marks, trailMark({ from: 5, to: 5 }))).toHaveLength(2);
  });

  it("caps the live marks, keeping the newest", () => {
    let marks: EditTrailMark[] = [];
    for (let i = 0; i < 60; i += 1) {
      // 2 apart, so nothing touches and nothing merges
      marks = addTrailMark(marks, trailMark({ from: i * 4, to: i * 4 + 2, at: 1_000 + i }));
    }
    expect(marks).toHaveLength(AGENT_TRAIL_MAX);
    expect(marks.at(-1)?.at).toBe(1_059);
  });

  it("prunes as it adds, so a stale mark cannot outlive the ttl", () => {
    const stale = trailMark({ from: 100, to: 110, at: 0 });
    const fresh = trailMark({ from: 10, to: 20, at: AGENT_TRAIL_MS + 10 });
    expect(addTrailMark([stale], fresh, { now: fresh.at })).toEqual([fresh]);
  });
});

/* ------------------------------------------------ offline-buffer persistence */

/**
 * The crash net for the offline buffer (defect: collab body/title never touch
 * the CAS draft mirror, so a reload/close mid-outage lost them). The session
 * SEEDS the initial doc from a persisted buffer, PERSISTS every offline edit,
 * and CLEARS the buffer on a clean sync — but KEEPS it when the sync surfaced a
 * conflict (a reload before the user resolves must still recover the text).
 */
function fakePersistence(initialContent: RoomContent | null = null) {
  const EMPTY: RoomContent = { title: "", body: "" };
  let stored: { content: RoomContent; base: RoomContent } | null = initialContent
    ? { content: initialContent, base: EMPTY }
    : null;
  const persistence: CollabPersistence = {
    load: () => stored,
    save: (room) => {
      stored = { content: { ...room.content }, base: { ...room.base } };
    },
    clear: () => {
      stored = null;
    },
  };
  return {
    persistence,
    /** the persisted CONTENT (what the offline doc held), for the assertions. */
    get: () => stored?.content ?? null,
    /** the whole persisted buffer, content + base. */
    raw: () => stored,
    /** seed a buffer as a previous mount would have left it (a reload). */
    put: (content: RoomContent, base: RoomContent) => {
      stored = { content, base };
    },
  };
}

describe("offline-buffer persistence", () => {
  it("seeds the initial doc from a buffer a previous mount left behind", async () => {
    const p = fakePersistence({ title: "Draft", body: "typed while offline" });
    const h = harness({ persistence: p.persistence });
    await tick();
    // The offline buffer (the doc the editor binds to) already holds the text,
    // before any socket has synced.
    expect(readRoomContent(h.session.state().doc)).toEqual({
      title: "Draft",
      body: "typed while offline",
    });
  });

  it("clears the buffer on a truly clean sync (nothing was typed offline)", async () => {
    const p = fakePersistence();
    const h = harness({ persistence: p.persistence });
    await tick();

    // Nothing typed offline: the server's (empty) doc is authoritative and there
    // is no unacked local text to protect, so the buffer drops at sync.
    h.last().sync();
    await tick();
    expect(p.get()).toBeNull();
    expect(h.session.state().conflict).toBeNull();
  });

  it("session.flushPersist() captures offline text before the throttle window elapses (pagehide)", async () => {
    // The pagehide/tab-close path: React runs no effect cleanup, so `destroy`
    // never fires and the throttled persist timer is still pending. The host
    // calls `session.flushPersist()` from its pagehide handler; without it the
    // final <500ms of offline keystrokes would be lost on the next mount.
    const p = fakePersistence();
    const h = harness({ persistence: p.persistence });
    await tick();

    // Type offline. The persist is only SCHEDULED (throttled) — nothing written
    // yet, and we deliberately do NOT fire the pending timer.
    writeRoomContent(h.session.state().doc, { body: "final burst" });
    await tick();
    expect(p.get()).toBeNull();

    // The pagehide flush writes synchronously, ahead of the throttle window.
    h.session.flushPersist();
    expect(p.get()?.body).toBe("final burst");

    // The pending throttle timer was cancelled by the flush, so it cannot fire a
    // second, redundant write later.
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });

  it("session.flushPersist() is a no-op once the room is live (server holds the text)", async () => {
    const p = fakePersistence();
    const h = harness({ persistence: p.persistence });
    await tick();
    h.last().sync();
    await tick();
    // A clean sync dropped any buffer; a live flushPersist must not resurrect one.
    expect(p.get()).toBeNull();
    writeRoomContent(h.session.state().doc, { body: "typed while live" });
    h.session.flushPersist();
    expect(p.get()).toBeNull();
  });

  it("re-applies offline text but KEEPS the buffer until the server acks it", async () => {
    const p = fakePersistence();
    const h = harness({ persistence: p.persistence });
    await tick();

    // Type into the offline buffer while the socket is not live. The persist is
    // throttled (coalesces a burst into one write), so fire the pending window.
    writeRoomContent(h.session.state().doc, { body: "typed offline" });
    await h.flushPersist();
    expect(p.get()?.body).toBe("typed offline");

    // The server had nothing — reconcile re-applies our text as a LOCAL update
    // that has not been sent yet. Clearing the buffer here would lose it if the
    // socket dropped again before the flush, so it is held.
    h.last().sync();
    await tick();
    expect(h.session.state().conflict).toBeNull();
    expect(p.get()?.body).toBe("typed offline");

    // Only once the server acknowledges the re-applied update is the buffer safe
    // to drop.
    h.last().flush();
    await tick();
    expect(p.get()).toBeNull();
  });

  it("recovers re-applied offline text when the socket re-drops before the flush", async () => {
    const p = fakePersistence();
    const h = harness({ persistence: p.persistence });
    await tick();

    writeRoomContent(h.session.state().doc, { body: "typed offline" });
    // Sync re-applies the text into the live doc, but the box self-updates again
    // and drops the socket BEFORE the re-applied update is acked — no flush.
    h.last().sync();
    await tick();
    h.last().drop();
    await tick();

    // The buffer still holds the text, so a reload (a fresh session seeded from
    // it) recovers rather than silently losing the offline paragraph.
    expect(p.get()?.body).toBe("typed offline");
  });

  it("KEEPS the buffer when the sync surfaces a conflict", async () => {
    const p = fakePersistence();
    const h = harness({ persistence: p.persistence });
    await tick();

    writeRoomContent(h.session.state().doc, { body: "my offline text" });
    await h.flushPersist();
    // The re-seeded server holds DIFFERENT text ⇒ epoch reset conflict.
    seed(h.last().doc, { body: "server moved on" });
    h.last().sync();
    await tick();

    expect(h.session.state().conflict).not.toBeNull();
    // Still recoverable on a reload until the user resolves it.
    expect(p.get()?.body).toBe("my offline text");
  });

  it("keeps the buffer after keep-mine until the re-asserted text is acked", async () => {
    const p = fakePersistence();
    const h = harness({ persistence: p.persistence });
    await tick();
    writeRoomContent(h.session.state().doc, { body: "mine" });
    await h.flushPersist();
    seed(h.last().doc, { body: "theirs" });
    h.last().sync();
    await tick();
    expect(p.get()).not.toBeNull();

    // keep-mine re-applies our text into the live doc as an UNACKED local
    // update. Clearing the buffer now would lose it if the socket dropped before
    // the flush — so it is held (refreshed to exactly what we re-asserted).
    h.session.keepMine();
    expect(h.session.state().conflict).toBeNull();
    expect(p.get()?.body).toBe("mine");

    // Only the flush ack drops it.
    h.last().flush();
    await tick();
    expect(p.get()).toBeNull();
  });

  it("recovers keep-mine text when the socket drops before the flush ack", async () => {
    const p = fakePersistence();
    const h = harness({ persistence: p.persistence });
    await tick();
    writeRoomContent(h.session.state().doc, { body: "mine" });
    seed(h.last().doc, { body: "theirs" });
    h.last().sync();
    await tick();

    h.session.keepMine();
    // The box self-updates again and drops the socket before the ack. Because
    // the buffer was NOT cleared eagerly, a reload seeded from it recovers the
    // re-asserted text rather than losing it.
    h.last().drop();
    await tick();
    expect(p.get()?.body).toBe("mine");
    // The BASE too: the server still holds THEIRS until the re-assertion
    // flushes. A drop that rewrote base=mine would make the next reconcile
    // read localChanged === false and silently re-adopt the server's text the
    // user explicitly rejected.
    expect(p.raw()?.base.body).toBe("theirs");
  });

  it("a drop before the FIRST flush ack keeps the server-held base — folded text is never its own baseline", async () => {
    // A previous mount dropped mid-outage with offline text on base "hello".
    const p = fakePersistence();
    p.put({ title: "", body: "hello world" }, { title: "", body: "hello" });
    const h = harness({ persistence: p.persistence });
    await tick();

    // Reconnect to a flapping box: the server still holds "hello", reconcile
    // re-applies the offline tail (foldedUnacked) — and the socket drops
    // within the ack round-trip, before ANY flush is confirmed.
    seed(h.last().doc, { body: "hello" });
    h.last().sync();
    await tick();
    h.last().drop();
    await tick();

    // The buffer's base must be what the SERVER holds, never the folded doc:
    // {content: "hello world", base: "hello world"} reads as
    // localChanged === false on the next epoch reset and the offline text is
    // gone with no conflict banner.
    expect(p.raw()?.content.body).toBe("hello world");
    expect(p.raw()?.base.body).toBe("hello");

    // And the loss scenario end-to-end: a reload (fresh session seeded from
    // the buffer) against a re-seeded server still recovers the text.
    const h2 = harness({ persistence: p.persistence });
    await tick();
    seed(h2.last().doc, { body: "hello" });
    h2.last().sync();
    await tick();
    expect(h2.session.state().conflict).toBeNull();
    expect(readRoomContent(h2.session.state().doc).body).toBe("hello world");
    h2.session.destroy();
  });

  it("a reload mid-outage reconciles against the persisted base — no phantom conflict", async () => {
    // A previous mount dropped mid-outage: it left the offline doc ("hello
    // world") AND the base the server was known to hold at the drop ("hello").
    // Without persisting that base, the fresh mount would fall back to EMPTY and
    // report a conflict on a routine reconnect where nothing actually diverged.
    const p = fakePersistence();
    p.put({ title: "", body: "hello world" }, { title: "", body: "hello" });

    const h = harness({ persistence: p.persistence });
    await tick();
    expect(readRoomContent(h.session.state().doc).body).toBe("hello world");

    // Reconnect: the server still holds exactly what it did at the drop.
    seed(h.last().doc, { body: "hello" });
    h.last().sync();
    await tick();

    // A clean REAPPLY of the offline edit — the same verdict the un-reloaded
    // session reaches — not a conflict.
    expect(h.session.state().conflict).toBeNull();
    expect(readRoomContent(h.session.state().doc).body).toBe("hello world");
  });

  it("an offline deletion survives a reload — the doc is emptied, not reverted", async () => {
    // The user deleted the whole note offline: content is empty, but the base
    // records what the server still holds. Persisting only the (empty) content
    // would read as "clean" on reconnect and silently re-adopt the server's old
    // text; the base is the deletion's only evidence.
    const p = fakePersistence();
    p.put({ title: "", body: "" }, { title: "", body: "server still has this" });

    const h = harness({ persistence: p.persistence });
    await tick();

    seed(h.last().doc, { body: "server still has this" });
    h.last().sync();
    await tick();

    expect(h.session.state().conflict).toBeNull();
    expect(readRoomContent(h.session.state().doc).body).toBe("");
  });
});
