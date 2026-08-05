import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ConflictError,
  type ConflictSnapshot,
  type PatchObjectInput,
  type WriteResult,
} from "./api";
import { createSaveQueue, type SaveEvent, type SaveQueueOptions } from "./saveQueue";

/**
 * The save queue is where "never clobber, never lose typed text" is actually
 * enforced, so each rule gets a test: single-flight + coalescing, field-granular
 * patches, rebase on a disjoint-field 409, the explicit terminal state when
 * rebases run out (conflict AND revert), the short-circuits that must never
 * retry (same-field, open_in_editor), and mirror-before-send on tab close.
 */

function snapshot(over: Partial<ConflictSnapshot> = {}): ConflictSnapshot {
  return {
    title: "T",
    body: "B",
    props: {},
    updated_at: "2026-07-21T00:00:00.000Z",
    actor_name: "Ada",
    ...over,
  };
}

interface Harness {
  calls: Array<{ patch: PatchObjectInput; baseVersion: number }>;
  save: SaveQueueOptions["save"];
  resolve(i: number, version: number): void;
  reject(i: number, err: unknown): void;
}

/** Manual-gate transport: each save is held open until the test resolves it, so
 *  "what happened while a save was in flight" is observable. */
function harness(): Harness {
  const calls: Harness["calls"] = [];
  const resolvers: Array<(r: WriteResult) => void> = [];
  const rejecters: Array<(e: unknown) => void> = [];
  return {
    calls,
    save: (patch, baseVersion) => {
      calls.push({ patch, baseVersion });
      return new Promise<WriteResult>((res, rej) => {
        resolvers.push(res);
        rejecters.push(rej);
      });
    },
    resolve: (i, version) => resolvers[i]!({ id: "o1", version }),
    reject: (i, err) => rejecters[i]!(err),
  };
}

/** let queued microtasks (the pump's continuations) run */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function baseOpts(over: Partial<SaveQueueOptions> = {}): SaveQueueOptions {
  return {
    objectId: "o1",
    baseVersion: 1,
    base: { title: "T", body: "B", props: {} },
    save: async () => ({ id: "o1", version: 2 }),
    debounceMs: 0,
    wait: async () => {},
    random: () => 0.5,
    ...over,
  };
}

describe("save queue — flight control", () => {
  it("keeps at most one save in flight and coalesces edits made during it", async () => {
    const h = harness();
    const q = createSaveQueue(baseOpts({ save: h.save }));

    q.change({ title: "a" });
    const flushed = q.flush();
    expect(h.calls).toHaveLength(1);

    // Two more edits land while the first save is still open.
    q.change({ body: "b1" });
    q.change({ body: "b2" });
    expect(h.calls).toHaveLength(1);

    h.resolve(0, 2);
    await tick();

    // One follow-up patch, carrying only the coalesced latest value, on the
    // version the first save produced.
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.patch).toEqual({ baseVersion: 2, body: "b2" });
    expect(h.calls[1]!.baseVersion).toBe(2);

    h.resolve(1, 3);
    await flushed;
    expect(q.hasPending()).toBe(false);
    expect(q.baseVersion()).toBe(3);
    q.dispose();
  });

  it("sends only the changed fields, props key by key", async () => {
    const h = harness();
    const q = createSaveQueue(
      baseOpts({ save: h.save, base: { title: "T", body: "B", props: { owner: "x" } } }),
    );

    q.change({ props: { status: "done", owner: null } });
    const flushed = q.flush();

    expect(h.calls[0]!.patch).toEqual({ baseVersion: 1, props: { status: "done", owner: null } });
    h.resolve(0, 2);
    await flushed;
    q.dispose();
  });

  it("clears the local mirror only once the server has acked", async () => {
    const h = harness();
    const mirror = { write: vi.fn(), clear: vi.fn() };
    const q = createSaveQueue(baseOpts({ save: h.save, mirror }));

    q.change({ body: "typed" });
    expect(mirror.write).toHaveBeenCalledWith({ body: "typed" }, 1);

    const flushed = q.flush();
    expect(mirror.clear).not.toHaveBeenCalled();

    h.resolve(0, 2);
    await flushed;
    expect(mirror.clear).toHaveBeenCalledTimes(1);
    q.dispose();
  });
});

describe("save queue — 409 handling", () => {
  it("rebases and retries when the server did not touch our fields", async () => {
    const h = harness();
    const states: SaveEvent[] = [];
    const q = createSaveQueue(
      baseOpts({
        save: h.save,
        onState: (e) => states.push(e),
        base: { title: "T", body: "B", props: {} },
      }),
    );

    q.change({ props: { status: "done" } });
    const flushed = q.flush();

    // Someone else edited the BODY; our prop is untouched.
    h.reject(0, new ConflictError("conflict", 5, snapshot({ body: "their body" })));
    await tick();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.patch).toEqual({ baseVersion: 5, props: { status: "done" } });

    h.resolve(1, 6);
    await flushed;

    expect(states.map((s) => s.kind)).toContain("rebasing");
    expect(states.at(-1)).toEqual({ kind: "idle" });
    expect(q.baseVersion()).toBe(6);
    q.dispose();
  });

  it("treats a 409 whose server value already equals ours as the success it was", async () => {
    // Retry safety: the save landed, the response was lost, the retry 409s.
    const h = harness();
    const states: SaveEvent[] = [];
    const q = createSaveQueue(baseOpts({ save: h.save, onState: (e) => states.push(e) }));

    q.change({ title: "mine" });
    const flushed = q.flush();
    h.reject(0, new ConflictError("conflict", 4, snapshot({ title: "mine" })));
    await flushed;

    expect(h.calls).toHaveLength(1);
    expect(states).toContainEqual({ kind: "saved", version: 4 });
    expect(states.some((s) => s.kind === "conflict")).toBe(false);
    q.dispose();
  });

  it("short-circuits a same-field conflict: one attempt, draft kept, never merged", async () => {
    const h = harness();
    const states: SaveEvent[] = [];
    const conflicts: SaveEvent[] = [];
    const mirror = { write: vi.fn(), clear: vi.fn() };
    const q = createSaveQueue(
      baseOpts({
        save: h.save,
        mirror,
        onState: (e) => states.push(e),
        onConflict: (e) => conflicts.push(e),
      }),
    );

    q.change({ title: "mine" });
    const flushed = q.flush();
    h.reject(0, new ConflictError("conflict", 4, snapshot({ title: "theirs" })));
    await flushed;

    expect(h.calls).toHaveLength(1); // no rebase, no retry
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: "conflict", currentVersion: 4, fields: ["title"] });
    // the local draft survives for keep-mine / take-theirs / diff
    expect(q.hasPending()).toBe(true);
    expect(mirror.clear).not.toHaveBeenCalled();
    expect(states.some((s) => s.kind === "reverted")).toBe(false);
    q.dispose();
  });

  it("emits BOTH conflict and reverted when rebases are exhausted", async () => {
    let version = 4;
    const calls: PatchObjectInput[] = [];
    const states: SaveEvent[] = [];
    const q = createSaveQueue(
      baseOpts({
        base: { title: "T", body: "B", props: { status: "todo" } },
        onState: (e) => states.push(e),
        save: async (patch) => {
          calls.push(patch);
          // Always lost, always on a field that is not ours: rebaseable forever.
          version += 1;
          throw new ConflictError(
            "conflict",
            version,
            snapshot({ body: `body ${version}`, props: { status: "todo" } }),
          );
        },
      }),
    );

    q.change({ props: { status: "done" } });
    await q.flush();

    // initial attempt + the 3 rebase retries
    expect(calls).toHaveLength(4);

    const kinds = states.map((s) => s.kind);
    const ci = kinds.indexOf("conflict");
    const ri = kinds.indexOf("reverted");
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(ri).toBeGreaterThan(ci); // banner first, then the visible rollback
    expect(states[ri]).toEqual({ kind: "reverted", fields: { props: { status: "todo" } } });
    // nothing left claiming to be saved-but-dirty
    expect(q.hasPending()).toBe(false);
    q.dispose();
  });

  it("does not rebase a 409 that carries a reason — the room owns the field", async () => {
    const calls: PatchObjectInput[] = [];
    const states: SaveEvent[] = [];
    const q = createSaveQueue(
      baseOpts({
        onState: (e) => states.push(e),
        save: async (patch) => {
          calls.push(patch);
          throw new ConflictError("open in editor", null, null, "open_in_editor");
        },
      }),
    );

    q.change({ body: "typed into the card" });
    await q.flush();

    expect(calls).toHaveLength(1);
    expect(states.at(-1)).toEqual({ kind: "locked", reason: "open_in_editor", fields: ["body"] });
    expect(states.some((s) => s.kind === "reverted")).toBe(false);
    expect(q.hasPending()).toBe(true); // the text is not thrown away
    q.dispose();
  });

  it("never blind-retries a non-conflict failure", async () => {
    const calls: PatchObjectInput[] = [];
    const states: SaveEvent[] = [];
    const q = createSaveQueue(
      baseOpts({
        onState: (e) => states.push(e),
        save: async (patch) => {
          calls.push(patch);
          throw new ApiError(503, "unavailable");
        },
      }),
    );

    q.change({ body: "x" });
    await q.flush();

    expect(calls).toHaveLength(1);
    expect(states.at(-1)).toEqual({ kind: "error", status: 503, message: "unavailable" });
    expect(q.hasPending()).toBe(true);
    q.dispose();
  });
});

describe("save queue — beacon flush", () => {
  it("mirrors BEFORE it sends, and never treats the send as delivered", () => {
    const order: string[] = [];
    let beaconed: PatchObjectInput | null = null;
    const q = createSaveQueue(
      baseOpts({
        mirror: {
          write: () => order.push("mirror"),
          clear: () => order.push("clear"),
        },
        sendBeacon: (req) => {
          order.push("send");
          beaconed = req.patch;
        },
      }),
    );

    q.change({ body: "a very long body that will blow the 64KB keepalive cap" });
    order.length = 0;
    q.flushBeacon();

    expect(order).toEqual(["mirror", "send"]);
    expect(beaconed).toEqual({
      baseVersion: 1,
      body: "a very long body that will blow the 64KB keepalive cap",
    });
    // the mirror is NOT cleared — a keepalive fetch cannot be observed, so the
    // draft has to survive to be reconciled at next load
    expect(order).not.toContain("clear");
    q.dispose();
  });

  it("does nothing when there is nothing dirty", () => {
    const sendBeacon = vi.fn();
    const q = createSaveQueue(baseOpts({ sendBeacon }));
    q.flushBeacon();
    expect(sendBeacon).not.toHaveBeenCalled();
    q.dispose();
  });
});

describe("save queue — suspend/resume", () => {
  it("holds suspended fields back and sends the rest, then releases them", async () => {
    const h = harness();
    const q = createSaveQueue(baseOpts({ save: h.save }));

    q.suspend(["body", "title"]);
    q.change({ body: "room owns this", props: { status: "done" } });
    const flushed = q.flush();

    expect(h.calls[0]!.patch).toEqual({ baseVersion: 1, props: { status: "done" } });
    h.resolve(0, 2);
    await flushed;
    expect(q.pendingFields()).toEqual(["body"]);

    q.resume();
    const second = q.flush();
    expect(h.calls[1]!.patch).toEqual({ baseVersion: 2, body: "room owns this" });
    h.resolve(1, 3);
    await second;
    expect(q.hasPending()).toBe(false);
    q.dispose();
  });

  it("takeRoomContent drains held body/title (so resume can't 409) and leaves props", async () => {
    const h = harness();
    const q = createSaveQueue(baseOpts({ save: h.save }));

    q.suspend(["body", "title"]);
    q.change({ title: "typed on open", body: "text typed on open", props: { status: "done" } });

    // The collab session takes the room's fields at first sync.
    expect(q.takeRoomContent()).toEqual({ title: "typed on open", body: "text typed on open" });
    // Body/title are gone from the queue; the prop still rides on CAS.
    expect(q.pendingFields()).toEqual(["props.status"]);

    // Resume + flush now sends ONLY the prop — no body/title PATCH to 409.
    q.resume();
    const flushed = q.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.patch).toEqual({ baseVersion: 1, props: { status: "done" } });
    h.resolve(0, 2);
    await flushed;
    expect(q.hasPending()).toBe(false);
    q.dispose();
  });

  it("takeRoomContent returns null when no body/title is buffered", () => {
    const q = createSaveQueue(baseOpts());
    q.change({ props: { status: "done" } });
    expect(q.takeRoomContent()).toBeNull();
    expect(q.pendingFields()).toEqual(["props.status"]);
    q.dispose();
  });

  it("takeRoomContent maps a cleared title (null) to the CRDT's empty string", () => {
    const q = createSaveQueue(baseOpts());
    q.suspend(["title"]);
    q.change({ title: null });
    expect(q.takeRoomContent()).toEqual({ title: "" });
    q.dispose();
  });

  it("takeRoomContent rewrites the CAS mirror without the fields it hands to the CRDT", () => {
    const mirror = { write: vi.fn(), clear: vi.fn() };
    const q = createSaveQueue(baseOpts({ mirror }));

    q.suspend(["body", "title"]);
    // change() mirrors body+title+props into the CAS draft.
    q.change({ title: "typed on open", body: "text typed on open", props: { status: "done" } });
    expect(mirror.write).toHaveBeenLastCalledWith(
      { title: "typed on open", body: "text typed on open", props: { status: "done" } },
      1,
    );
    mirror.write.mockClear();

    q.takeRoomContent();
    // Ownership of body/title moved to the collab buffer, so the mirror is
    // rewritten with ONLY what's still on CAS — no stale {body,title} left to
    // resurface as a phantom recovery draft once the version advances.
    expect(mirror.clear).not.toHaveBeenCalled();
    expect(mirror.write).toHaveBeenCalledWith({ props: { status: "done" } }, 1);
    q.dispose();
  });

  it("takeRoomContent clears the CAS mirror when it took the only buffered fields", () => {
    const mirror = { write: vi.fn(), clear: vi.fn() };
    const q = createSaveQueue(baseOpts({ mirror }));

    q.suspend(["body", "title"]);
    q.change({ title: "typed on open", body: "text typed on open" });
    q.takeRoomContent();
    // Nothing else was pending, so the whole draft is removed rather than left
    // behind stamped at the pre-sync baseVersion.
    expect(mirror.clear).toHaveBeenCalledTimes(1);
    q.dispose();
  });
});
