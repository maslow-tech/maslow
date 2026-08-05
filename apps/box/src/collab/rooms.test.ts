import { describe, expect, it, vi } from "vitest";
import {
  announceAccessChange,
  closeActorConnections,
  CollabEvictionHub,
  collabEvictions,
  evictReasonFor,
  liveCollabConnections,
  type CollabEvictionSink,
  type RoomConnection,
  type RoomIndexSource,
} from "./rooms.js";
import { COLLAB_CLOSE } from "./types.js";

/**
 * The eviction path is what makes "offboarding takes effect now" true instead
 * of "within a minute", so the assertions here are about the two ways it could
 * be quietly useless: an announcement that reaches nobody, and an announcement
 * that takes down more than it should.
 */

interface FakeConnection extends RoomConnection {
  readonly closes: { code: number; reason: string }[];
}

function fakeConnection(actorId: string | null, readOnly = false): FakeConnection {
  const closes: { code: number; reason: string }[] = [];
  return {
    readOnly,
    context: actorId ? { principal: { actorId, role: "member", scopes: [] } } : {},
    close(event) {
      if (event) closes.push(event);
    },
    closes,
  };
}

function source(rooms: Record<string, FakeConnection[]>): RoomIndexSource {
  return {
    documents: new Map(
      Object.entries(rooms).map(([name, conns]) => [name, { getConnections: () => conns }]),
    ),
  };
}

/* ---------------------------------------------------------------- the hub */

describe("CollabEvictionHub", () => {
  it("is a no-op when nothing is bound", () => {
    // No collab server ⇒ no rooms ⇒ nothing to evict. A write path must not
    // care whether anybody has an editor open.
    const hub = new CollabEvictionHub();
    expect(hub.bound).toBe(false);
    expect(() => hub.object("obj-1", "deleted")).not.toThrow();
    expect(() => hub.actor("acct-1", "access_revoked")).not.toThrow();
    expect(() => hub.all("box_off")).not.toThrow();
  });

  it("routes each announcement to the bound sink", () => {
    const hub = new CollabEvictionHub();
    const sink: CollabEvictionSink = {
      evictObject: vi.fn(),
      evictActor: vi.fn(),
      evictAll: vi.fn(),
    };
    hub.bind(sink);
    // The triggering actor is threaded through to the sink — it is what lets a
    // narrowing eviction flush the still-authorized editors' text as an actor
    // who can still see the object.
    hub.object("obj-1", "visibility_changed", "acct-writer");
    hub.actor("acct-1", "access_revoked");
    hub.all("box_off");
    expect(sink.evictObject).toHaveBeenCalledWith("obj-1", "visibility_changed", "acct-writer");
    expect(sink.evictActor).toHaveBeenCalledWith("acct-1", "access_revoked");
    expect(sink.evictAll).toHaveBeenCalledWith("box_off");
  });

  it("swallows a throwing sink — the write has already committed", () => {
    // Surfacing a websocket problem as a failed `edit` could make a caller
    // retry a write that succeeded.
    const hub = new CollabEvictionHub();
    hub.bind({
      evictObject: () => {
        throw new Error("socket exploded");
      },
      evictActor: () => undefined,
      evictAll: () => undefined,
    });
    expect(() => hub.object("obj-1", "deleted")).not.toThrow();
  });

  it("unbinds only its own binding", () => {
    const hub = new CollabEvictionHub();
    const first: CollabEvictionSink = {
      evictObject: vi.fn(),
      evictActor: vi.fn(),
      evictAll: vi.fn(),
    };
    const second: CollabEvictionSink = {
      evictObject: vi.fn(),
      evictActor: vi.fn(),
      evictAll: vi.fn(),
    };
    const unbindFirst = hub.bind(first);
    hub.bind(second);
    // An out-of-order teardown must not silently unhook the live server.
    unbindFirst();
    hub.object("obj-1", "deleted");
    expect(second.evictObject).toHaveBeenCalledTimes(1);
    expect(first.evictObject).not.toHaveBeenCalled();
  });

  it("ignores an empty id rather than fanning out to everything", () => {
    const hub = new CollabEvictionHub();
    const sink: CollabEvictionSink = {
      evictObject: vi.fn(),
      evictActor: vi.fn(),
      evictAll: vi.fn(),
    };
    hub.bind(sink);
    hub.object("", "deleted");
    hub.actor("", "access_revoked");
    expect(sink.evictObject).not.toHaveBeenCalled();
    expect(sink.evictActor).not.toHaveBeenCalled();
  });
});

describe("announceAccessChange", () => {
  it("hands the Writer's change to the process-wide hub", () => {
    const sink: CollabEvictionSink = {
      evictObject: vi.fn(),
      evictActor: vi.fn(),
      evictAll: vi.fn(),
    };
    const unbind = collabEvictions.bind(sink);
    try {
      announceAccessChange({ objectId: "obj-9", reason: "unshared", actorId: "acct-w" });
      expect(sink.evictObject).toHaveBeenCalledWith("obj-9", "unshared", "acct-w");
    } finally {
      unbind();
    }
  });

  it("maps every Writer reason into the collab vocabulary", () => {
    // The interesting assertion is the one the compiler makes on the signature;
    // this pins the runtime identity so a future "translation" cannot drift.
    expect(evictReasonFor("visibility_changed")).toBe("visibility_changed");
    expect(evictReasonFor("unshared")).toBe("unshared");
    expect(evictReasonFor("deleted")).toBe("deleted");
  });
});

/* ------------------------------------------------------------ the adapter */

describe("liveCollabConnections", () => {
  it("pairs every connection with its room and its principal", () => {
    const a = fakeConnection("acct-1");
    const b = fakeConnection("acct-2");
    const c = fakeConnection("acct-1");
    const live = liveCollabConnections(source({ "obj-1": [a, b], "obj-2": [c] }));
    expect(live.map((x) => [x.objectId, x.actorId])).toEqual([
      ["obj-1", "acct-1"],
      ["obj-1", "acct-2"],
      ["obj-2", "acct-1"],
    ]);
  });

  it("skips a connection with no principal instead of evicting it", () => {
    // The upgrade gate cannot produce one (no verified ticket, no socket), so
    // if it exists it is a hocuspocus internal, not a browser we can make a
    // statement about.
    const live = liveCollabConnections(source({ "obj-1": [fakeConnection(null)] }));
    expect(live).toEqual([]);
  });

  it("writes readOnly straight through to the underlying connection", () => {
    const a = fakeConnection("acct-1");
    const [live] = liveCollabConnections(source({ "obj-1": [a] }));
    expect(live?.readOnly).toBe(false);
    if (live) live.readOnly = true;
    expect(a.readOnly).toBe(true);
    expect(live?.readOnly).toBe(true);
  });

  it("keys the connection identity on the underlying object, not the wrapper", () => {
    // The re-check loop's unconfirmed window is held against `ref`; a fresh key
    // every pass would reset the grace forever and never close anything.
    const a = fakeConnection("acct-1");
    const src = source({ "obj-1": [a] });
    expect(liveCollabConnections(src)[0]?.ref).toBe(liveCollabConnections(src)[0]?.ref);
  });
});

describe("closeActorConnections", () => {
  it("closes only that account's connections and leaves the rooms up", () => {
    // Offboarding one person must not interrupt everyone else's editor.
    const leaver = fakeConnection("acct-1");
    const stays = fakeConnection("acct-2");
    const elsewhere = fakeConnection("acct-1");
    const src = source({ "obj-1": [leaver, stays], "obj-2": [elsewhere] });

    expect(closeActorConnections(src, "acct-1", "access_revoked")).toBe(2);
    expect(leaver.closes).toEqual([{ code: COLLAB_CLOSE.EVICTED, reason: "access_revoked" }]);
    expect(elsewhere.closes).toEqual([{ code: COLLAB_CLOSE.EVICTED, reason: "access_revoked" }]);
    expect(stays.closes).toEqual([]);
    expect(src.documents.size).toBe(2);
  });

  it("takes write away before closing", () => {
    const leaver = fakeConnection("acct-1");
    closeActorConnections(source({ "obj-1": [leaver] }), "acct-1", "access_revoked");
    expect(leaver.readOnly).toBe(true);
  });

  it("is a no-op for an account with nothing open, and for an empty id", () => {
    const other = fakeConnection("acct-2");
    const src = source({ "obj-1": [other] });
    expect(closeActorConnections(src, "acct-1", "access_revoked")).toBe(0);
    expect(closeActorConnections(src, "", "access_revoked")).toBe(0);
    expect(other.closes).toEqual([]);
  });
});
