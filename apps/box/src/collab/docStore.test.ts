import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  createDocStore,
  planSeed,
  type ApplyMarkdownDiff,
  type BaseBody,
  type CollabDocRow,
  type DocRecords,
  type DocStore,
  type FlushTarget,
  type ObjectSnapshot,
} from "./docStore.js";
import { docToMarkdown, seedDocFromMarkdown } from "./serialize.js";

/**
 * The doc store's four load-bearing behaviours, each of which is silent data
 * loss when it is left to "whatever hocuspocus does":
 *
 *  1. SEEDING IS ONE RULE — resume only at the object's current version, rebase
 *     otherwise, never resume over a newer version, never drop unflushed text.
 *  2. EPOCH — every re-seed changes the doc's identity, monotonically, across a
 *     teardown that deleted the row.
 *  3. COMPACTION — every persist writes a full SNAPSHOT; nothing ever appends.
 *  4. LIFECYCLE — teardown is atomic and a mid-drain join WAITS for the flush.
 *
 * Plus the boundary the room shares with the rest of the box: authorization is
 * per-actor even though the room is shared.
 */

const OBJ = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface FakeObject {
  version: number;
  title: string | null;
  body: string | null;
  deleted: boolean;
  /** Undefined ⇒ org-visible. Otherwise the exact set of actors who may see it. */
  visibleTo?: Set<string>;
  /** version → the body the object HAD at that version (the before-image). */
  history: Map<number, { title: string | null; body: string }>;
}

/** An in-memory stand-in for `objects` + `before_image` + `collab_docs`. */
class FakeRecords implements DocRecords {
  readonly objects = new Map<string, FakeObject>();
  readonly rows = new Map<string, CollabDocRow>();
  readonly saves: { actorId: string; row: CollabDocRow }[] = [];
  readonly removes: { actorId: string; objectId: string }[] = [];
  readonly loads: { actorId: string; objectId: string }[] = [];
  baseBodyFails = false;

  put(objectId: string, obj: Partial<FakeObject> & { body: string }): FakeObject {
    const full: FakeObject = {
      version: obj.version ?? 1,
      title: obj.title ?? "T",
      body: obj.body,
      deleted: obj.deleted ?? false,
      history: obj.history ?? new Map(),
      ...(obj.visibleTo ? { visibleTo: obj.visibleTo } : {}),
    };
    this.objects.set(objectId, full);
    return full;
  }

  private visible(actorId: string, objectId: string): FakeObject | undefined {
    const obj = this.objects.get(objectId);
    if (!obj) return undefined;
    if (obj.visibleTo && !obj.visibleTo.has(actorId)) return undefined;
    return obj;
  }

  async load(
    actorId: string,
    objectId: string,
  ): Promise<{ object: ObjectSnapshot | null; row: CollabDocRow | null }> {
    this.loads.push({ actorId, objectId });
    const obj = this.visible(actorId, objectId);
    if (!obj) return { object: null, row: null };
    return {
      object: { version: obj.version, title: obj.title, body: obj.body, deleted: obj.deleted },
      row: this.rows.get(objectId) ?? null,
    };
  }

  async baseBody(actorId: string, objectId: string, version: number): Promise<BaseBody> {
    if (this.baseBodyFails) return { kind: "unavailable" };
    const obj = this.visible(actorId, objectId);
    if (!obj) return { kind: "unavailable" };
    const at = [...obj.history.keys()].filter((v) => v >= version).sort((a, b) => a - b)[0];
    if (at === undefined) return { kind: "unchanged" };
    const snap = obj.history.get(at);
    return { kind: "exact", title: snap?.title ?? null, body: snap?.body ?? "" };
  }

  async save(actorId: string, row: CollabDocRow): Promise<void> {
    this.saves.push({ actorId, row: { ...row, blob: new Uint8Array(row.blob) } });
    this.rows.set(row.objectId, { ...row, blob: new Uint8Array(row.blob) });
  }

  async remove(actorId: string, objectId: string): Promise<boolean> {
    this.removes.push({ actorId, objectId });
    return this.rows.delete(objectId);
  }
}

/**
 * A `FakeRecords` whose NEXT `load` suspends on a gate, so a test can freeze a
 * join in the exact window AFTER its pre-read drain check and BEFORE it seeds —
 * the window a concurrent teardown races.
 */
class GatedLoadRecords extends FakeRecords {
  private loadGate: Promise<void> | null = null;
  private releaseLoadGate: (() => void) | null = null;
  private startedResolve: (() => void) | null = null;
  /** Resolves once the gated `load` has actually begun (the join is suspended). */
  loadStarted: Promise<void> = Promise.resolve();

  gateNextLoad(): void {
    this.loadGate = new Promise<void>((r) => (this.releaseLoadGate = r));
    this.loadStarted = new Promise<void>((r) => (this.startedResolve = r));
  }

  releaseLoad(): void {
    this.releaseLoadGate?.();
  }

  override async load(
    actorId: string,
    objectId: string,
  ): Promise<{ object: ObjectSnapshot | null; row: CollabDocRow | null }> {
    const gate = this.loadGate;
    if (gate) {
      this.loadGate = null; // only the immediately-next load is gated
      this.startedResolve?.();
      await gate;
    }
    return super.load(actorId, objectId);
  }
}

/** The blob a previous session would have left behind for `md`. */
function blobOf(md: string, title: string | null = "T"): Uint8Array {
  const doc = seedDocFromMarkdown(md, { title });
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function row(over: Partial<CollabDocRow> & { objectId: string; blob: Uint8Array }): CollabDocRow {
  return {
    epoch: 1,
    lastFlushedVersion: 1,
    state: "idle",
    animatingTargetVersion: null,
    ...over,
  };
}

const stores: DocStore[] = [];

function makeStore(
  records: FakeRecords,
  over: Partial<Parameters<typeof createDocStore>[0]> = {},
): DocStore {
  const store = createDocStore({
    records,
    sweepMs: 1_000_000,
    persistDebounceMs: 5,
    persistMaxMs: 10,
    ...over,
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  while (stores.length) await stores.pop()?.close();
  vi.useRealTimers();
});

const OBJECT: ObjectSnapshot = { version: 7, title: "T", body: "b", deleted: false };

describe("planSeed — seeding is ONE rule", () => {
  it("seeds from markdown when there is no blob", () => {
    expect(planSeed(null, OBJECT)).toEqual({ kind: "seed" });
  });

  it("resumes a blob reconciled to the object's CURRENT version", () => {
    const stored = row({ objectId: OBJ, blob: blobOf("x"), lastFlushedVersion: 7 });
    expect(planSeed(stored, OBJECT)).toEqual({ kind: "resume" });
  });

  it("rebases a blob whose version is behind the object", () => {
    const stored = row({ objectId: OBJ, blob: blobOf("x"), lastFlushedVersion: 6 });
    expect(planSeed(stored, OBJECT)).toEqual({ kind: "rebase" });
  });

  it("NEVER resumes over a newer object version", () => {
    // Only reachable via a restore-from-backup or a rollback; re-seed from what
    // the database says is true rather than reverting an acknowledged write.
    const stored = row({ objectId: OBJ, blob: blobOf("x"), lastFlushedVersion: 9 });
    expect(planSeed(stored, OBJECT)).toEqual({ kind: "reseed", reason: "version_regressed" });
  });

  it("ignores an animating blob even at the matching version", () => {
    const stored = row({
      objectId: OBJ,
      blob: blobOf("half of an agent write"),
      lastFlushedVersion: 7,
      state: "animating",
    });
    expect(planSeed(stored, OBJECT)).toEqual({ kind: "reseed", reason: "animating" });
  });

  it("re-seeds an empty blob rather than opening an empty document", () => {
    const stored = row({ objectId: OBJ, blob: new Uint8Array(), lastFlushedVersion: 7 });
    expect(planSeed(stored, OBJECT)).toEqual({ kind: "reseed", reason: "blob_unreadable" });
  });
});

describe("join — seeding in practice", () => {
  it("seeds a fresh room from the object's markdown", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "# T\n\nhello", version: 3 });
    const store = makeStore(records);

    const joined = await store.join(OBJ, ALICE);
    expect(joined?.seeded).toBe("seed");
    expect(joined?.baseVersion).toBe(3);
    expect(docToMarkdown(joined!.doc)).toBe("# T\n\nhello");
  });

  it("RESUMES unflushed keystrokes across a process restart", async () => {
    // The whole point of the resume branch: the blob is the object's content
    // PLUS up to a few seconds of typing that was never flushed. Discarding it
    // would silently eat the last paragraph of whoever was typing.
    const records = new FakeRecords();
    records.put(OBJ, { body: "stored", version: 4 });
    records.rows.set(
      OBJ,
      row({
        objectId: OBJ,
        blob: blobOf("stored plus unflushed"),
        lastFlushedVersion: 4,
        epoch: 99,
      }),
    );
    const store = makeStore(records);

    const joined = await store.join(OBJ, ALICE);
    expect(joined?.seeded).toBe("resume");
    expect(docToMarkdown(joined!.doc)).toBe("stored plus unflushed");
    // A resume keeps the epoch: a reconnecting client may merge safely.
    expect(joined?.epoch).toBe(99);
  });

  it("REBASES an out-of-date blob through the diff bridge", async () => {
    const records = new FakeRecords();
    const obj = records.put(OBJ, { body: "agent wrote this", version: 5 });
    obj.history.set(4, { title: "T", body: "old body" });
    records.rows.set(
      OBJ,
      row({ objectId: OBJ, blob: blobOf("old body typed on"), lastFlushedVersion: 4 }),
    );
    const calls: { from: string; to: string }[] = [];
    const bridge: ApplyMarkdownDiff = ({ from, to }) => {
      calls.push({ from, to });
      return true;
    };
    const store = makeStore(records, { applyMarkdownDiff: bridge });

    const joined = await store.join(OBJ, ALICE);
    expect(joined?.seeded).toBe("rebase");
    // Re-seeded from the CURRENT markdown — the agent write is never reverted —
    // with the unflushed delta re-applied on top by the bridge.
    expect(calls).toEqual([{ from: "old body", to: "old body typed on" }]);
    expect(joined?.baseVersion).toBe(5);
  });

  it("escalates rather than dropping unflushed text when it cannot rebase", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "agent wrote this", version: 5 });
    records.rows.set(
      OBJ,
      row({ objectId: OBJ, blob: blobOf("never flushed"), lastFlushedVersion: 4 }),
    );
    records.baseBodyFails = true;
    const store = makeStore(records); // no bridge wired

    const joined = await store.join(OBJ, ALICE);
    expect(joined?.seeded).toBe("rebase_unmerged");
    // The authoritative markdown is the room's content...
    expect(docToMarkdown(joined!.doc)).toBe("agent wrote this");
    // ...and the unmergeable text is handed UP, never silently dropped.
    expect(joined?.unmerged).toBe("never flushed");
  });

  it("re-seeds from markdown when the stored blob is an animating one", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "the whole agent write", version: 6 });
    records.rows.set(
      OBJ,
      row({
        objectId: OBJ,
        blob: blobOf("half an agent wri"),
        lastFlushedVersion: 6,
        state: "animating",
      }),
    );
    const store = makeStore(records);

    const joined = await store.join(OBJ, ALICE);
    expect(joined?.seeded).toBe("reseed_animating");
    expect(docToMarkdown(joined!.doc)).toBe("the whole agent write");
  });

  it("re-seeds from markdown when the blob is corrupt", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "readable", version: 2 });
    records.rows.set(
      OBJ,
      row({ objectId: OBJ, blob: Uint8Array.from([9, 9, 9, 9, 9]), lastFlushedVersion: 2 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = makeStore(records);

    const joined = await store.join(OBJ, ALICE);
    expect(joined?.seeded).toBe("reseed_blob_unreadable");
    expect(docToMarkdown(joined!.doc)).toBe("readable");
    warn.mockRestore();
  });
});

describe("authorization is per-actor even though the room is shared", () => {
  it("refuses a joiner who cannot see the object, room or no room", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "private", version: 1, visibleTo: new Set([ALICE]) });
    const store = makeStore(records);

    expect(await store.join(OBJ, ALICE)).not.toBeNull();
    // Bob arrives at a LIVE room. Inheriting Alice's read would put him in a
    // private object's room — and presence there would tell him it exists.
    expect(await store.join(OBJ, BOB)).toBeNull();
    expect(records.loads.some((l) => l.actorId === BOB)).toBe(true);
  });

  it("gives one answer for missing, invisible and trashed", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "gone", version: 1, deleted: true });
    const store = makeStore(records);

    expect(await store.join(OBJ, ALICE)).toBeNull(); // trashed
    expect(await store.join(OTHER, ALICE)).toBeNull(); // missing
    expect(await store.join("not-a-uuid", ALICE)).toBeNull();
  });

  it("seeds exactly once when two authorized actors join at the same time", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "shared", version: 1 });
    const store = makeStore(records);

    const [a, b] = await Promise.all([store.join(OBJ, ALICE), store.join(OBJ, BOB)]);
    expect(a?.doc).toBe(b?.doc);
    expect(store.size).toBe(1);
    expect(store.get(OBJ)?.connections).toBe(2);
    // Both were read as themselves; only one seed happened.
    expect(records.loads).toHaveLength(2);
  });
});

describe("epoch", () => {
  it("changes on every re-seed and never repeats after a teardown", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    let clock = 1_000;
    const store = makeStore(records, { now: () => clock });

    const first = await store.join(OBJ, ALICE);
    // Teardown deletes the row, so a per-row counter would restart at 1 here and
    // a reconnecting client would keep its stale Y.Doc and duplicate the body.
    await store.teardown(OBJ);
    clock = 2_000;
    const second = await store.join(OBJ, ALICE);

    expect(second!.epoch).toBeGreaterThan(first!.epoch);
  });

  it("still advances when the wall clock steps backwards", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    let clock = 5_000;
    const store = makeStore(records, { now: () => clock });

    const first = await store.join(OBJ, ALICE);
    expect(first!.epoch).toBe(5_000);
    await store.teardown(OBJ);

    clock = 10; // NTP stepped the box backwards
    // A blob survived the teardown (its flush failed, say) carrying the OLD,
    // higher epoch. Wall clock alone would now hand a re-seeded doc a LOWER
    // epoch, and a client holding the previous one would not see a change.
    records.rows.set(
      OBJ,
      row({ objectId: OBJ, blob: blobOf("a"), lastFlushedVersion: 0, epoch: first!.epoch }),
    );
    const second = await store.join(OBJ, ALICE);

    expect(second!.seeded).toBe("rebase_unmerged"); // re-seeded, so a new epoch
    expect(second!.epoch).toBeGreaterThan(first!.epoch);
  });
});

describe("compaction", () => {
  it("writes a full snapshot every time and never appends", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "one", version: 1 });
    const store = makeStore(records);
    const joined = await store.join(OBJ, ALICE);

    const para = joined!.doc.getXmlFragment("body").toArray()[0] as Y.XmlElement;
    (para.toArray()[0] as Y.XmlText).insert(3, " two");
    await store.persist(OBJ);

    const last = records.saves[records.saves.length - 1];
    expect(records.saves.length).toBeGreaterThan(1);
    // Each save stands ALONE: applying only the newest blob to an empty doc
    // reproduces the whole document. An append-only log would need every
    // earlier update to do that.
    const fresh = new Y.Doc({ gc: true });
    Y.applyUpdate(fresh, last!.row.blob);
    expect(docToMarkdown(fresh)).toBe("one two");
    // ...and there is one row, rewritten, not a growing log.
    expect(records.rows.size).toBe(1);
  });

  it("compacts on every flush, not on a schedule", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const store = makeStore(records);
    await store.join(OBJ, ALICE);
    const before = records.saves.length;

    await store.markFlushed(OBJ, 2);

    expect(records.saves.length).toBe(before + 1);
    expect(records.rows.get(OBJ)?.lastFlushedVersion).toBe(2);
    expect(store.get(OBJ)?.baseVersion).toBe(2);
  });

  it("never regresses the CAS base — a stale markFlushed is a compaction, not a rollback", async () => {
    // The bridge's ingest runs on a RoomView snapshot: a flush can commit and
    // markFlushed a NEWER version inside the ingest's awaits, and the ingest's
    // trailing markFlushed with its older version must not roll the base back
    // under the committed row (the next flush would lose on purpose and rebase
    // against a poisoned base). Same guard endAnimating already carries.
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const store = makeStore(records);
    await store.join(OBJ, ALICE);

    await store.markFlushed(OBJ, 7);
    await store.markFlushed(OBJ, 6); // stale — arrived late from a snapshot

    expect(store.get(OBJ)?.baseVersion).toBe(7);
    expect(records.rows.get(OBJ)?.lastFlushedVersion).toBe(7);
  });

  it("does not persist a seed as if it were a keystroke", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "untouched", version: 1 });
    const store = makeStore(records, { persistDebounceMs: 1, persistMaxMs: 2 });
    await store.join(OBJ, ALICE);
    const after = records.saves.length;

    await new Promise((r) => setTimeout(r, 20));
    // A seed is the database talking to itself: it must not mark the room dirty
    // and schedule a write of content that came FROM the object body.
    expect(records.saves.length).toBe(after);
  });
});

describe("lifecycle", () => {
  it("teardown flushes, then purges the row", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const flushed: FlushTarget[] = [];
    const store = makeStore(records, {
      flush: async (t) => {
        flushed.push(t);
      },
    });
    await store.join(OBJ, ALICE);

    await store.teardown(OBJ);

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.reason).toBe("teardown");
    expect(records.rows.has(OBJ)).toBe(false);
    expect(store.has(OBJ)).toBe(false);
    // The row was marked draining BEFORE the flush, so a process death between
    // the two is legible to the next join.
    expect(records.saves.some((s) => s.row.state === "draining")).toBe(true);
  });

  it("a join arriving mid-drain WAITS for the flush instead of racing it", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "old", version: 1 });
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const store = makeStore(records, {
      flush: async () => {
        await gate;
        // The flush is what makes the object's markdown current.
        const obj = records.objects.get(OBJ)!;
        obj.body = "old plus the tail of the session";
        obj.version = 2;
      },
    });
    await store.join(OBJ, ALICE);

    const draining = store.teardown(OBJ);
    const rejoin = store.join(OBJ, ALICE);
    // Seeding now would read PRE-flush markdown, lose the tail of the previous
    // session, and then flush that loss back over it.
    release();
    await draining;
    const joined = await rejoin;

    expect(docToMarkdown(joined!.doc)).toBe("old plus the tail of the session");
    expect(joined?.baseVersion).toBe(2);
  });

  it("a teardown firing DURING a join's read does not orphan the seeded room", async () => {
    // The pre-read drain gate only covers the window before the RLS read. Here
    // the teardown begins WHILE the join is suspended in `records.load`. The old
    // code resumed, saw a `draining` (not `idle`) room, and seeded a fresh room
    // anyway — which the in-flight `dropRoom` then blindly deleted from the map,
    // leaving the new connection holding a Y.Doc the server no longer tracks
    // (every keystroke silently dropped). The join must instead wait the drain
    // out and re-seed a room that survives.
    const records = new GatedLoadRecords();
    records.put(OBJ, { body: "current", version: 3 });
    const evicted: string[] = [];
    let releaseFlush = (): void => undefined;
    const flushGate = new Promise<void>((r) => (releaseFlush = r));
    const store = makeStore(records, {
      flush: async () => {
        await flushGate; // hold the teardown open across the join's resume
      },
      onEvict: (id, reason) => evicted.push(`${id}:${reason}`),
    });

    // A room that is idle (joined then left) — eligible for teardown.
    await store.join(OBJ, ALICE);
    store.leave(OBJ);

    // The rejoin's RLS read suspends mid-flight.
    records.gateNextLoad();
    const rejoin = store.join(OBJ, ALICE);
    await records.loadStarted;

    // A teardown fires in exactly that window (idle sweep / budget evict /
    // narrowing purge — none pass through the join queue).
    const draining = store.teardown(OBJ);

    // Let the read finish; the join must NOT seed a doomed room. Yield a macro-
    // task so any (buggy) seed-then-clobber interleaving would have happened.
    records.releaseLoad();
    await new Promise((r) => setTimeout(r, 0));
    releaseFlush();
    await draining;
    const joined = await rejoin;

    // The rejoin holds a LIVE, tracked room — the one in the map, with its
    // connection counted — not an orphan the flush pipeline and bridge ignore.
    expect(joined).not.toBeNull();
    expect(store.has(OBJ)).toBe(true);
    expect(store.get(OBJ)?.doc).toBe(joined!.doc);
    expect(store.get(OBJ)?.connections).toBe(1);
    // Seeded from the settled, post-flush markdown.
    expect(docToMarkdown(joined!.doc)).toBe("current");
  });

  it("keeps the blob when the final flush fails — it is the only copy", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = makeStore(records, {
      flush: async () => {
        throw new Error("CAS conflict");
      },
    });
    await store.join(OBJ, ALICE);

    await store.teardown(OBJ);

    expect(records.rows.has(OBJ)).toBe(true);
    expect(records.removes).toHaveLength(0);
    err.mockRestore();
  });

  it("purge on a DELETE drops the room WITHOUT flushing, under the triggering actor", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const flushed: FlushTarget[] = [];
    const evicted: string[] = [];
    const store = makeStore(records, {
      flush: async (t) => {
        flushed.push(t);
      },
      onEvict: (id, reason) => evicted.push(`${id}:${reason}`),
    });
    await store.join(OBJ, ALICE);

    // The object was trashed; flushing here would resurrect its content. The
    // row is deleted under BOB's RLS (the actor of the delete).
    await store.purge(OBJ, "deleted", BOB);

    expect(flushed).toHaveLength(0);
    expect(records.removes).toEqual([{ actorId: BOB, objectId: OBJ }]);
    expect(evicted).toEqual([`${OBJ}:deleted`]);
    expect(store.has(OBJ)).toBe(false);
  });

  it("purge on an audience NARROWING flushes first, then drops the row", async () => {
    // The object stays; the creator and any remaining shared readers are still
    // authorized, and the text they typed since the last flush is legitimate
    // body content. It MUST be flushed before the room is dropped — losing it
    // is exactly the "one person's change becomes everyone's lost paragraph"
    // failure the eviction path exists to avoid. Both narrowing reasons flush.
    for (const reason of ["visibility_changed", "unshared"] as const) {
      const records = new FakeRecords();
      records.put(OBJ, { body: "a", version: 2 });
      const flushed: FlushTarget[] = [];
      const evicted: string[] = [];
      const store = makeStore(records, {
        flush: async (t) => {
          flushed.push(t);
        },
        onEvict: (id, r) => evicted.push(`${id}:${r}`),
      });
      await store.join(OBJ, ALICE);

      // Bob is the actor of the narrowing write — guaranteed to still see the
      // object, so the flush's RLS-bound base read succeeds.
      await store.purge(OBJ, reason, BOB);

      expect(flushed).toHaveLength(1);
      expect(flushed[0]?.reason).toBe("evict");
      expect(flushed[0]?.actorId).toBe(BOB);
      // Only after a successful flush is the in-flight row deleted, under the
      // triggering actor.
      expect(records.removes).toEqual([{ actorId: BOB, objectId: OBJ }]);
      expect(evicted).toEqual([`${OBJ}:${reason}`]);
      expect(store.has(OBJ)).toBe(false);
      await store.close();
    }
  });

  it("a narrowing whose flush FAILS keeps the blob — it is the only copy", async () => {
    // If the flush cannot land (its RLS-bound base read failed, a CAS it cannot
    // win), the room's blob is the last remaining copy of the unflushed text,
    // so the row must survive rather than being deleted out from under it.
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 2 });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = makeStore(records, {
      flush: async () => {
        throw new Error("CAS conflict");
      },
    });
    await store.join(OBJ, ALICE);

    await store.purge(OBJ, "unshared", BOB);

    expect(records.rows.has(OBJ)).toBe(true);
    expect(records.removes).toHaveLength(0);
    expect(store.has(OBJ)).toBe(false);
    err.mockRestore();
  });

  it("tears down idle rooms after the TTL, and leaves busy ones alone", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    records.put(OTHER, { body: "b", version: 1 });
    let clock = 0;
    const store = makeStore(records, { now: () => clock, idleTtlMs: 100 });
    await store.join(OBJ, ALICE);
    await store.join(OTHER, ALICE);
    store.leave(OBJ); // nobody left in OBJ; OTHER still has a connection

    clock = 1_000;
    await store.sweep();

    expect(store.has(OBJ)).toBe(false);
    expect(store.has(OTHER)).toBe(true);
  });

  it("evicts LRU against the room cap", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    records.put(OTHER, { body: "b", version: 1 });
    let clock = 0;
    const store = makeStore(records, { now: () => clock, maxRooms: 1 });

    await store.join(OBJ, ALICE);
    store.leave(OBJ);
    clock = 10;
    await store.join(OTHER, ALICE);

    // The newly joined room is protected; the idle one goes.
    expect(store.has(OTHER)).toBe(true);
    expect(store.has(OBJ)).toBe(false);
    expect(store.stats().rooms).toBe(1);
  });

  it("evicts against the memory ceiling", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a".repeat(200), version: 1 });
    records.put(OTHER, { body: "b".repeat(200), version: 1 });
    let clock = 0;
    const store = makeStore(records, { now: () => clock, memoryCeilingBytes: 1 });

    await store.join(OBJ, ALICE);
    store.leave(OBJ);
    clock = 10;
    await store.join(OTHER, ALICE);

    expect(store.stats().rooms).toBe(1);
    expect(store.has(OTHER)).toBe(true);
  });

  it("drainAll flushes every live room (the SIGTERM path)", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    records.put(OTHER, { body: "b", version: 1 });
    const flushed: FlushTarget[] = [];
    const store = makeStore(records, {
      flush: async (t) => {
        flushed.push(t);
      },
    });
    await store.join(OBJ, ALICE);
    await store.join(OTHER, ALICE);

    await store.drainAll();

    expect(flushed.map((f) => f.reason)).toEqual(["drain", "drain"]);
    expect(store.size).toBe(0);
  });

  it("refuses joins once closed", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const store = makeStore(records);
    await store.close();
    expect(await store.join(OBJ, ALICE)).toBeNull();
  });

  it("never creates a room from get/has — the agent bridge relies on that", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const store = makeStore(records);
    expect(store.get(OBJ)).toBeUndefined();
    expect(store.has(OBJ)).toBe(false);
    expect(store.size).toBe(0);
  });
});

describe("animating (the phase-5 seam)", () => {
  it("suspends the room in animating state and comes back to idle", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const store = makeStore(records);
    await store.join(OBJ, ALICE);

    await store.setAnimating(OBJ, 4);
    expect(records.rows.get(OBJ)?.state).toBe("animating");
    expect(records.rows.get(OBJ)?.animatingTargetVersion).toBe(4);

    await store.endAnimating(OBJ, 4);
    expect(records.rows.get(OBJ)?.state).toBe("idle");
    expect(records.rows.get(OBJ)?.animatingTargetVersion).toBeNull();
    expect(store.get(OBJ)?.baseVersion).toBe(4);
  });

  it("publishes the target on the room view — that is what suspends the flush", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const store = makeStore(records);
    await store.join(OBJ, ALICE);

    expect(store.get(OBJ)?.animatingTargetVersion).toBeNull();
    await store.setAnimating(OBJ, 9);
    expect(store.get(OBJ)?.animatingTargetVersion).toBe(9);
    // Orthogonal to the lifecycle state: people may still join and type.
    expect(store.get(OBJ)?.state).toBe("idle");

    await store.endAnimating(OBJ);
    expect(store.get(OBJ)?.animatingTargetVersion).toBeNull();
    // `version` defaults to the target the animation was entered with.
    expect(store.get(OBJ)?.baseVersion).toBe(9);
  });

  it("never lets the CAS base go backwards", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 5 });
    const store = makeStore(records);
    await store.join(OBJ, ALICE);
    await store.markFlushed(OBJ, 7);

    await store.setAnimating(OBJ, 9);
    await store.endAnimating(OBJ, 3);

    expect(store.get(OBJ)?.baseVersion).toBe(7);
  });

  it("a debounced persist mid-animation still writes `animating`", async () => {
    // The blob written here holds a PREFIX of the agent's write. Persisting it
    // under `idle` would tell the next process it is reconciled, and a resume
    // would then flush half a write back over a row that holds all of it.
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const store = makeStore(records, { persistDebounceMs: 1, persistMaxMs: 2 });
    const joined = await store.join(OBJ, ALICE);
    await store.setAnimating(OBJ, 4);

    const para = joined!.doc.getXmlFragment("body").toArray()[0] as Y.XmlElement;
    (para.toArray()[0] as Y.XmlText).insert(1, " chunk one");
    await new Promise((r) => setTimeout(r, 20));

    expect(records.rows.get(OBJ)?.state).toBe("animating");
    expect(records.rows.get(OBJ)?.animatingTargetVersion).toBe(4);
  });

  it("the bridge marking a room flushed mid-animation does NOT clear the mark", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const store = makeStore(records);
    await store.join(OBJ, ALICE);
    await store.setAnimating(OBJ, 4);

    await store.markFlushed(OBJ, 2);

    expect(records.rows.get(OBJ)?.state).toBe("animating");
    expect(store.get(OBJ)?.animatingTargetVersion).toBe(4);
  });

  it("teardown FORCE-COMPLETES the animation before the final flush", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const order: string[] = [];
    const store = makeStore(records, {
      flush: async (t) => {
        order.push(`flush:${t.baseVersion}`);
      },
    });
    await store.join(OBJ, ALICE);
    await store.setAnimating(OBJ, 6, (reason) => {
      order.push(`complete:${reason}`);
    });

    await store.teardown(OBJ);

    // The remaining hunks land FIRST, in one transaction, and the flush that
    // follows therefore serializes the WHOLE agent write at its target version.
    expect(order).toEqual(["complete:teardown", "flush:6"]);
    expect(records.rows.has(OBJ)).toBe(false);
  });

  it("keeps the animating mark when force-completion is impossible", async () => {
    // No driver registered (or one that died): nothing can apply the rest of
    // the hunks, so the row must NOT say draining/idle — a resume that rebased
    // off this blob would delete the tail of an acknowledged agent write.
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const statesAtFlush: (string | undefined)[] = [];
    const store = makeStore(records, {
      flush: async () => {
        statesAtFlush.push(records.rows.get(OBJ)?.state);
        throw new Error("still animating — refusing to reconcile a partial doc");
      },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await store.join(OBJ, ALICE);
    await store.setAnimating(OBJ, 6);

    await store.teardown(OBJ);

    expect(statesAtFlush).toEqual(["animating"]);
    // The flush refused, so the blob survives — still marked animating, which
    // is what makes the next join re-seed from markdown.
    expect(records.rows.get(OBJ)?.state).toBe("animating");
    err.mockRestore();
  });

  it("a driver that throws leaves the room animating rather than pretending", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = makeStore(records, {
      flush: async () => {
        throw new Error("refusing to flush a partial doc");
      },
    });
    await store.join(OBJ, ALICE);
    await store.setAnimating(OBJ, 6, () => {
      throw new Error("driver is gone");
    });

    await store.teardown(OBJ);

    expect(records.rows.get(OBJ)?.state).toBe("animating");
    expect(records.rows.get(OBJ)?.animatingTargetVersion).toBe(6);
    err.mockRestore();
  });

  it("a driver that settles the room itself is not double-settled", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const bases: number[] = [];
    const store = makeStore(records, {
      flush: async (t) => {
        bases.push(t.baseVersion);
      },
    });
    await store.join(OBJ, ALICE);
    await store.setAnimating(OBJ, 6, async () => {
      // The real driver applies its remaining hunks and then reports the
      // version it actually reconciled to.
      await store.endAnimating(OBJ, 5);
    });

    await store.teardown(OBJ);

    expect(bases).toEqual([5]);
  });

  it("purge CANCELS the animation — nothing is applied into a doomed doc", async () => {
    const records = new FakeRecords();
    records.put(OBJ, { body: "a", version: 1 });
    const reasons: string[] = [];
    const flushed: FlushTarget[] = [];
    const store = makeStore(records, {
      flush: async (t) => {
        flushed.push(t);
      },
    });
    await store.join(OBJ, ALICE);
    await store.setAnimating(OBJ, 6, (reason) => {
      reasons.push(reason);
    });

    await store.purge(OBJ, "deleted", ALICE);

    expect(reasons).toEqual(["cancel"]);
    expect(flushed).toEqual([]);
    expect(store.has(OBJ)).toBe(false);
    expect(records.rows.has(OBJ)).toBe(false);
  });

  it("re-seeds from markdown after a crash mid-animation", async () => {
    // The end-to-end shape of the invariant: the process died holding a blob
    // with half the agent's hunks, at the object's CURRENT version (which is
    // exactly when `resume` would otherwise fire).
    const records = new FakeRecords();
    records.put(OBJ, { body: "the whole agent write", version: 4 });
    records.rows.set(
      OBJ,
      row({
        objectId: OBJ,
        blob: blobOf("the whole agent"),
        lastFlushedVersion: 4,
        state: "animating",
        animatingTargetVersion: 4,
      }),
    );
    const store = makeStore(records);

    const joined = await store.join(OBJ, ALICE);

    expect(joined?.seeded).toBe("reseed_animating");
    expect(docToMarkdown(joined!.doc)).toBe("the whole agent write");
    expect(store.get(OBJ)?.animatingTargetVersion).toBeNull();
  });
});
