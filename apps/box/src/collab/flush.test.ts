import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  FLUSH_IDLE_MS,
  FLUSH_MAX_MS,
  FLUSH_ORIGIN,
  createFlushPipeline,
  createWriterFlushWrite,
  type FlushConflictReason,
  type FlushContributor,
  type FlushPipeline,
  type FlushWrite,
  type FlushWriteOutcome,
} from "./flush.js";
import type { ApplyMarkdownDiff, ObjectSnapshot, RoomView } from "./docStore.js";
import {
  BODY_FRAGMENT,
  applyMarkdownToDoc,
  docToMarkdown,
  seedDocFromMarkdown,
} from "./serialize.js";
import { VersionConflictError } from "@brain/mcp-tools";

/**
 * What this file is actually asserting, in the order the spec states it:
 *
 *  1. ONE WRITE, ONE ACTOR — a co-edited window produces one transaction per
 *     contributor, in order, each carrying only that contributor's ranges.
 *  2. A REFUSED contributor's ranges are REVERTED out of the live doc and their
 *     client evicted — never persisted under someone else, never left in the
 *     doc for the next flush to carry in.
 *  3. CAS FAILURE IS NEVER A BLIND RETRY — re-read, rebase through the bridge,
 *     then retry; if the rebase cannot apply, surface a conflict and write
 *     NOTHING.
 *  4. ZERO CHURN — an idle open document writes no version at all.
 *  5. Every write carries the room's origin token, and the token is still
 *     recognisable as ours after the room is gone.
 */

const OBJ = "11111111-1111-4111-8111-111111111111";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Let every queued microtask (the fakes are all async) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/** Append a paragraph as `origin` — one contributor typing one thing. */
function type(doc: Y.Doc, text: string, origin: unknown): void {
  doc.transact(() => {
    const frag = doc.getXmlFragment(BODY_FRAGMENT);
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    frag.insert(frag.length, [p]);
  }, origin);
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
  view: RoomView | undefined;
  readonly writes: FlushWrite[] = [];
  readonly flushed: number[] = [];
  readonly evictions: { objectId: string; actorId: string; why: string }[] = [];
  readonly conflicts: FlushConflictReason[] = [];
  readonly bridgeCalls: { from: string; to: string }[] = [];
  readonly contributors = new Map<unknown, FlushContributor>();
  readonly writers = new Set<string>([ALICE, BOB]);
  /** Queued outcomes that pre-empt the real CAS (one per write). */
  readonly scripted: FlushWriteOutcome[] = [];
  bridgeFails = false;
  bridge: ApplyMarkdownDiff | undefined;
  visible = true;
  pipeline!: FlushPipeline;

  constructor(body: string, title: string | null = "T", version = 4) {
    this.stored = { version, title, body, deleted: false };
    this.doc = seedDocFromMarkdown(body, { title });
    this.view = {
      objectId: OBJ,
      doc: this.doc,
      epoch: 1,
      baseVersion: version,
      state: "idle",
      connections: 1,
      lastActorId: ALICE,
      animatingTargetVersion: null,
    };
    // A deliberately simple stand-in for the agent-write bridge: an
    // append-shaped external change MERGES on top of whatever the doc now
    // holds, anything else is a straight replace (which is what a revert is).
    this.bridge = ({ doc, from, to, title: t }): boolean => {
      this.bridgeCalls.push({ from, to });
      if (this.bridgeFails) return false;
      const cur = docToMarkdown(doc);
      const merged =
        to.startsWith(from) && cur.startsWith(from) && to !== from
          ? cur + to.slice(from.length)
          : to;
      applyMarkdownToDoc(doc, merged, t ?? null);
      return true;
    };
  }

  /** A connection belonging to `actorId`, usable as a transaction origin. */
  conn(actorId: string, canWrite = true): object {
    const origin = { actorId, canWrite };
    this.contributors.set(origin, { actorId, canWrite });
    return origin;
  }

  build(over: Partial<Parameters<typeof createFlushPipeline>[0]> = {}): FlushPipeline {
    this.pipeline = createFlushPipeline({
      rooms: {
        get: (id: string): RoomView | undefined => (id === OBJ ? this.view : undefined),
        markFlushed: async (id: string, version: number): Promise<void> => {
          this.flushed.push(version);
          if (this.view && id === OBJ) this.view = { ...this.view, baseVersion: version };
        },
      },
      write: async (w: FlushWrite): Promise<FlushWriteOutcome> => {
        this.writes.push(w);
        const scripted = this.scripted.shift();
        if (scripted) return scripted;
        if (w.baseVersion !== this.stored.version) {
          return { ok: false, kind: "conflict", currentVersion: this.stored.version };
        }
        this.stored.version += 1;
        this.stored.body = w.body;
        this.stored.title = w.title;
        return { ok: true, version: this.stored.version };
      },
      readObject: async (_actorId: string, id: string): Promise<ObjectSnapshot | null> => {
        if (id !== OBJ || !this.visible) return null;
        return {
          version: this.stored.version,
          title: this.stored.title,
          body: this.stored.body,
          deleted: this.stored.deleted,
        };
      },
      canWrite: async (actorId: string): Promise<boolean> => this.writers.has(actorId),
      resolveContributor: (origin: unknown): FlushContributor | null =>
        this.contributors.get(origin) ?? null,
      applyMarkdownDiff: this.bridge,
      onConflict: (_id: string, reason: FlushConflictReason): void => {
        this.conflicts.push(reason);
      },
      evictActor: (objectId: string, actorId: string, why: string): void => {
        this.evictions.push({ objectId, actorId, why });
      },
      ...over,
    });
    return this.pipeline;
  }

  /** The room enters the animating window (the doc store's `setAnimating`). */
  animating(targetVersion: number): void {
    if (this.view) this.view = { ...this.view, animatingTargetVersion: targetVersion };
  }

  /**
   * …and leaves it. The doc now holds the whole agent write and the room's CAS
   * base has moved to the version that write produced (`endAnimating`).
   */
  settled(version?: number): void {
    if (!this.view) return;
    this.view = {
      ...this.view,
      animatingTargetVersion: null,
      baseVersion: version ?? this.view.baseVersion,
    };
  }

  /**
   * One chunk of an agent write, as the bridge applies it: the transaction
   * carries `FLUSH_ORIGIN`, which this module treats as non-contributory (the
   * agent's text is already committed to `objects`; it is not a run to write).
   */
  agentApplies(md: string, title: string | null = "T"): void {
    this.doc.transact(() => applyMarkdownToDoc(this.doc, md, title), FLUSH_ORIGIN);
  }

  /** attach + let the attach-time (base-resolving) flush complete. */
  async open(actorId = ALICE): Promise<FlushPipeline> {
    const pipe = this.pipeline ?? this.build();
    pipe.attach(OBJ, actorId);
    await settle();
    return pipe;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("zero churn", () => {
  it("writes nothing at all for an open document nobody touched", async () => {
    const h = new Harness("hello world");
    const pipe = await h.open();
    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(h.flushed).toEqual([]);
    expect(h.stored.version).toBe(4);
  });

  it("does not re-canonicalize a hand-written body into a new version", async () => {
    // Stored markdown an agent wrote by hand: extra blank lines, trailing
    // spaces. `docToMarkdown` always emits the CANONICAL spelling, so comparing
    // raw bytes would version-bump every such object the moment it is opened.
    const h = new Harness("hello\n\n\n\nworld   \n");
    const pipe = await h.open();
    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(h.stored.version).toBe(4);
  });

  it("does not write for a body whose INLINE spelling is not canonical", async () => {
    // The regression this test exists for. A lone `~` is left literal by the
    // parser and escaped by the printer, so the room serializes to `\~` while
    // `normalizeMarkdown` (which canonicalizes blocks only) says `~` — and the
    // flush read that as "the reader changed this document", writing a version,
    // a history row and an audit event in their name, and putting a backslash
    // in their prose. Whatever the two spellings are, an untouched room writes
    // NOTHING, which is what comparing against `canonicalMarkdown` guarantees.
    const h = new Harness("B&P for an IDIQ volume set is ~$120k.");
    const pipe = await h.open();
    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(h.stored.version).toBe(4);
    expect(h.stored.body).toBe("B&P for an IDIQ volume set is ~$120k.");
  });

  it("skips a run whose text was typed and deleted again", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    const alice = h.conn(ALICE);
    const frag = h.doc.getXmlFragment(BODY_FRAGMENT);
    type(h.doc, "scratch", alice);
    h.doc.transact(() => frag.delete(frag.length - 1, 1), alice);
    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(h.stored.body).toBe("base");
  });
});

describe("one write, one actor", () => {
  it("writes a single contributor's text as that contributor, CAS'd on the room's base", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    type(h.doc, "mine", h.conn(ALICE));
    await pipe.flush(OBJ);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({
      objectId: OBJ,
      actorId: ALICE,
      baseVersion: 4,
      body: "base\n\nmine",
    });
    expect(h.stored.version).toBe(5);
    expect(h.flushed).toEqual([5]);
  });

  it("splits a co-edited window into one transaction per contributor, in order", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    const alice = h.conn(ALICE);
    const bob = h.conn(BOB);

    type(h.doc, "from alice", alice);
    type(h.doc, "from bob", bob);
    type(h.doc, "alice again", alice);
    await pipe.flush(OBJ);

    // Three runs, three actors in document order, each CAS'd on the version the
    // previous one produced. Never one write carrying everyone's text.
    expect(h.writes.map((w) => [w.actorId, w.baseVersion, w.body])).toEqual([
      [ALICE, 4, "base\n\nfrom alice"],
      [BOB, 5, "base\n\nfrom alice\n\nfrom bob"],
      [ALICE, 6, "base\n\nfrom alice\n\nfrom bob\n\nalice again"],
    ]);
    expect(h.stored.version).toBe(7);
    expect(h.flushed).toEqual([7]);
  });

  it("merges one contributor's consecutive edits into a single transaction", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    const alice = h.conn(ALICE);
    type(h.doc, "one", alice);
    type(h.doc, "two", alice);
    await pipe.flush(OBJ);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.body).toBe("base\n\none\n\ntwo");
  });

  it("stamps this room's origin token on every write, and keeps it after teardown", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    const token = pipe.originToken(OBJ);
    expect(token).toMatch(/^[0-9a-f]{16}$/);

    type(h.doc, "mine", h.conn(ALICE));
    await pipe.flush(OBJ);
    expect(h.writes[0]!.originToken).toBe(token);
    expect(pipe.isOwnFlush(token)).toBe(true);

    // The feed watcher can see our event AFTER the room is gone.
    pipe.detach(OBJ);
    expect(pipe.isOwnFlush(token)).toBe(true);
    expect(pipe.isOwnFlush("deadbeefdeadbeef")).toBe(false);
    expect(pipe.isOwnFlush(null)).toBe(false);
  });
});

describe("a refused contributor is reverted and evicted", () => {
  it("refuses a read-only connection's content and takes it back out of the doc", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    const viewer = h.conn(BOB, false);

    type(h.doc, "viewer text", viewer);
    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(h.stored.body).toBe("base");
    expect(docToMarkdown(h.doc)).toBe("base");
    expect(h.evictions).toEqual([
      { objectId: OBJ, actorId: BOB, why: "connection had no write scope" },
    ]);
  });

  it("refuses an account the database no longer says may write", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    h.writers.delete(BOB); // demoted member → viewer while the socket was open

    type(h.doc, "stale member", h.conn(BOB));
    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(docToMarkdown(h.doc)).toBe("base");
    expect(h.evictions[0]?.actorId).toBe(BOB);
  });

  it("refuses unattributed content rather than writing it under a convenient actor", async () => {
    const h = new Harness("base");
    const pipe = await h.open();

    type(h.doc, "from nowhere", { unregistered: true });
    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(docToMarkdown(h.doc)).toBe("base");
    expect(h.evictions).toEqual([]);
  });

  it("keeps the writes that already committed and unwinds only from there", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    const alice = h.conn(ALICE);
    const viewer = h.conn(BOB, false);

    type(h.doc, "alice ok", alice);
    type(h.doc, "viewer text", viewer);
    await pipe.flush(OBJ);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.actorId).toBe(ALICE);
    expect(h.stored.body).toBe("base\n\nalice ok");
    // The doc is back to the last state that was actually persisted.
    expect(docToMarkdown(h.doc)).toBe("base\n\nalice ok");
    expect(h.evictions[0]?.actorId).toBe(BOB);
  });

  it("escalates when there is no bridge to revert with", async () => {
    const h = new Harness("base");
    h.build({ applyMarkdownDiff: undefined });
    const pipe = await h.open();

    type(h.doc, "viewer text", h.conn(BOB, false));
    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(h.conflicts).toContain("write_refused");
  });
});

describe("CAS failure is never a blind retry", () => {
  it("retries against the new version when the content did not change", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    type(h.doc, "mine", h.conn(ALICE));

    // Someone patched a PROP: the version moved, the body did not. There is
    // nothing to rebase onto — the same bytes go in against the new version.
    h.stored.version = 9;
    await pipe.flush(OBJ);

    expect(h.writes.map((w) => w.baseVersion)).toEqual([4, 9]);
    expect(h.bridgeCalls).toEqual([]);
    expect(h.stored.body).toBe("base\n\nmine");
    expect(h.stored.version).toBe(10);
  });

  it("rebases the live room and the pending run onto an external write, then retries", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    type(h.doc, "mine", h.conn(ALICE));

    // An MCP write the bridge watcher never ingested.
    h.stored.body = "base\n\nfrom the agent";
    h.stored.version = 9;
    await pipe.flush(OBJ);

    // The agent's paragraph is in the live doc (open editors see it)…
    expect(docToMarkdown(h.doc)).toContain("from the agent");
    // …and the retried write carries BOTH, against the version we re-read.
    const last = h.writes.at(-1)!;
    expect(last.baseVersion).toBe(9);
    expect(last.body).toContain("mine");
    expect(last.body).toContain("from the agent");
    expect(h.stored.version).toBe(10);
  });

  it("rebases every contributor still queued behind the one that lost", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    type(h.doc, "alice", h.conn(ALICE));
    type(h.doc, "bob", h.conn(BOB));

    h.stored.body = "base\n\nagent";
    h.stored.version = 9;
    await pipe.flush(OBJ);

    // Bob's sub-write must still be Bob's, and must sit on the rebased base —
    // never a revert of the agent's acknowledged write.
    const bobWrite = h.writes.filter((w) => w.actorId === BOB).at(-1)!;
    expect(bobWrite.body).toContain("agent");
    expect(bobWrite.body).toContain("bob");
    expect(h.stored.body).toContain("agent");
  });

  it("writes NOTHING when the rebase cannot be applied cleanly", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    type(h.doc, "mine", h.conn(ALICE));

    h.stored.body = "totally different";
    h.stored.version = 9;
    h.bridgeFails = true;
    await pipe.flush(OBJ);

    // One losing attempt, then a conflict — never a second write.
    expect(h.writes).toHaveLength(1);
    expect(h.stored.body).toBe("totally different");
    expect(h.conflicts).toContain("rebase_failed");
  });

  it("gives up after the bounded number of attempts instead of spinning", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    type(h.doc, "mine", h.conn(ALICE));

    // A busy object: every attempt loses, and the content never settles.
    h.scripted.push(
      { ok: false, kind: "conflict" },
      { ok: false, kind: "conflict" },
      { ok: false, kind: "conflict" },
    );
    await pipe.flush(OBJ);

    expect(h.writes).toHaveLength(3);
    expect(h.conflicts).toContain("cas_exhausted");
  });

  it("stops without writing when the object went away under us", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    type(h.doc, "mine", h.conn(ALICE));

    h.scripted.push({ ok: false, kind: "conflict" });
    h.visible = false; // trashed, or narrowed away from this actor
    await pipe.flush(OBJ);

    expect(h.writes).toHaveLength(1);
    expect(h.conflicts).toContain("object_gone");
  });
});

describe("a transient failure is not a refusal", () => {
  it("keeps the text, evicts nobody, and retries on the next cycle", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    type(h.doc, "mine", h.conn(ALICE));

    h.scripted.push({ ok: false, kind: "error", reason: "connection terminated" });
    await pipe.flush(OBJ);

    expect(h.evictions).toEqual([]);
    expect(h.conflicts).toEqual([]);
    expect(docToMarkdown(h.doc)).toBe("base\n\nmine");
    expect(h.stored.body).toBe("base");

    await pipe.flush(OBJ);
    expect(h.stored.body).toBe("base\n\nmine");
    expect(h.writes.at(-1)!.actorId).toBe(ALICE);
  });
});

describe("carry-over from a previous process", () => {
  it("flushes unflushed blob text under the joiner, once, before anyone types", async () => {
    // A resumed room: the doc holds text the object's body does not.
    const h = new Harness("base");
    applyMarkdownToDoc(h.doc, "base\n\nrecovered", "T");
    const pipe = await h.open(BOB);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ actorId: BOB, baseVersion: 4, body: "base\n\nrecovered" });

    // …and it is not written a second time.
    await pipe.flush(OBJ);
    expect(h.writes).toHaveLength(1);
  });

  it("leaves carry-over intact when the fallback joiner is not a writer — no revert, no eviction", async () => {
    // A resumed room whose FIRST opener is a viewer (a legal read-only join).
    // The carry-over belongs to a departed writer, not to this viewer, so it
    // must not be reverted out of the doc and the viewer must not be evicted.
    const h = new Harness("base");
    applyMarkdownToDoc(h.doc, "base\n\nrecovered", "T");
    h.writers.delete(BOB);
    const pipe = await h.open(BOB);

    expect(h.writes).toEqual([]);
    expect(h.evictions).toEqual([]);
    // The unflushed text is still in the doc, waiting for a writer.
    expect(docToMarkdown(h.doc)).toBe("base\n\nrecovered");

    // A writer joins (attach updates the joiner). Once they type, the carry-over
    // rides along and is flushed under them — never lost.
    pipe.attach(OBJ, ALICE);
    type(h.doc, "and more", h.conn(ALICE));
    await pipe.flush(OBJ);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ actorId: ALICE, body: "base\n\nrecovered\n\nand more" });
    expect(h.evictions).toEqual([]);
  });
});

describe("titles", () => {
  it("does not churn a null title into an empty string", async () => {
    const h = new Harness("base", null);
    const pipe = await h.open();
    await pipe.flush(OBJ);
    expect(h.writes).toEqual([]);
  });

  it("carries the title alongside the body on a real edit", async () => {
    const h = new Harness("base", "Title");
    const pipe = await h.open();
    type(h.doc, "mine", h.conn(ALICE));
    await pipe.flush(OBJ);
    expect(h.writes[0]!.title).toBe("Title");
  });
});

describe("cadence", () => {
  it("flushes ~3s after the last keystroke and at most 30s into a burst", async () => {
    vi.useFakeTimers();
    const h = new Harness("base");
    const pipe = h.build();
    pipe.attach(OBJ, ALICE);
    await vi.advanceTimersByTimeAsync(0);
    await settle();

    const alice = h.conn(ALICE);
    type(h.doc, "one", alice);
    await vi.advanceTimersByTimeAsync(FLUSH_IDLE_MS - 500);
    expect(h.writes).toEqual([]); // still typing

    // Keep typing just under the idle window: the debounce keeps sliding, and
    // only the 30s ceiling stops it.
    for (let elapsed = 0; elapsed < FLUSH_MAX_MS; elapsed += FLUSH_IDLE_MS - 500) {
      type(h.doc, `x${elapsed}`, alice);
      await vi.advanceTimersByTimeAsync(FLUSH_IDLE_MS - 500);
    }
    expect(h.writes.length).toBeGreaterThan(0);
    const burstWrites = h.writes.length;

    // Stop typing: the idle timer lands the tail.
    type(h.doc, "tail", alice);
    await vi.advanceTimersByTimeAsync(FLUSH_IDLE_MS + 10);
    await settle();
    expect(h.writes.length).toBeGreaterThan(burstWrites);
  });
});

describe("noteExternalWrite (the bridge just ingested a write)", () => {
  it("rebases already-CLOSED runs onto the ingested base — a clean CAS must not revert the agent's write", async () => {
    const h = new Harness("base");
    const pipe = await h.open();

    // Two contributors in one window: bob's first keystroke CLOSES alice's run,
    // freezing its full-body snapshot at "base + alice" — without the agent's
    // paragraph, which has not landed yet.
    type(h.doc, "from alice", h.conn(ALICE));
    type(h.doc, "from bob", h.conn(BOB));

    // An MCP write commits externally (v5→v6) and the bridge ingests it: the
    // live doc gains the agent's paragraph under FLUSH_ORIGIN (non-contributory),
    // the room's CAS base moves to 6, and the pipeline is notified.
    type(h.doc, "agent paragraph", FLUSH_ORIGIN);
    h.stored.version = 6;
    h.stored.body = "base\n\nagent paragraph";
    h.view = { ...h.view!, baseVersion: 6 };
    pipe.noteExternalWrite(OBJ, "base\n\nagent paragraph", "T");

    await pipe.flush(OBJ, "manual");

    // Alice's frozen snapshot was rebased onto the new base before writing, so
    // her sub-write CARRIES the agent's paragraph instead of deleting it with a
    // clean CAS at the bridge-advanced base version.
    expect(h.conflicts).toEqual([]);
    const aliceWrite = h.writes.find((w) => w.actorId === ALICE);
    expect(aliceWrite).toBeDefined();
    expect(aliceWrite!.baseVersion).toBe(6);
    expect(aliceWrite!.body).toContain("agent paragraph");
    expect(aliceWrite!.body).toContain("from alice");
    // …and the final stored body holds everyone's text, agent included.
    expect(h.stored.body).toContain("agent paragraph");
    expect(h.stored.body).toContain("from alice");
    expect(h.stored.body).toContain("from bob");
  });

  it("drops (and escalates) queued runs it cannot rebase, instead of writing them stale", async () => {
    const h = new Harness("base");
    const pipe = await h.open();

    type(h.doc, "from alice", h.conn(ALICE));
    type(h.doc, "from bob", h.conn(BOB)); // closes alice's run

    // The bridge merged the agent's write into the LIVE doc (that always
    // precedes onIngest) and advanced the CAS base…
    type(h.doc, "agent paragraph", FLUSH_ORIGIN);
    h.stored.version = 6;
    h.stored.body = "base\n\nagent paragraph";
    h.view = { ...h.view!, baseVersion: 6 };
    h.bridgeFails = true; // …but the queued snapshots cannot be rebased
    pipe.noteExternalWrite(OBJ, "base\n\nagent paragraph", "T");

    // The stale snapshot must NOT go out: writing it wholesale at base 6 would
    // delete the acknowledged agent paragraph with a CAS that succeeds.
    expect(h.conflicts).toContain("rebase_failed");
    h.bridgeFails = false;
    await pipe.flush(OBJ, "manual");
    for (const w of h.writes.filter((x) => x.actorId === ALICE || x.actorId === BOB)) {
      expect(w.body).toContain("agent paragraph");
    }
    expect(h.stored.body).toContain("agent paragraph");
  });
});

describe("a queued flush re-run keeps the STRONGEST reason", () => {
  it("re-runs a teardown that queued behind an idle cycle as a terminal cycle", async () => {
    const h = new Harness("base");
    // A slow write, so the teardown request arrives while the idle cycle runs.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pipe = h.build({
      write: async (w: FlushWrite): Promise<FlushWriteOutcome> => {
        h.writes.push(w);
        await gate;
        h.stored.version += 1;
        h.stored.body = w.body;
        h.stored.title = w.title;
        return { ok: true, version: h.stored.version };
      },
    });
    pipe.attach(OBJ, ALICE);
    await settle();

    type(h.doc, "mine", h.conn(ALICE));
    const idle = pipe.flush(OBJ, "idle");
    await Promise.resolve();
    // A teardown queues behind the running idle cycle…
    type(h.doc, "more", h.conn(ALICE));
    const terminal = pipe.flush(OBJ, "teardown");
    release!();
    await idle;
    await terminal;
    await settle();

    // …and its re-run is TERMINAL: only the idle cycle's own markFlushed fires
    // — none for the teardown re-run (the room is about to be dropped, and on
    // a narrowing eviction that compaction would run as an actor the narrowing
    // may have just stripped). Re-running as "idle" fired it twice.
    expect(h.flushed).toHaveLength(1);
    expect(h.stored.body).toContain("mine");
    expect(h.stored.body).toContain("more");
  });
});

describe("the doc store hook", () => {
  it("flushes and detaches on teardown", async () => {
    const h = new Harness("base");
    const pipe = h.build();
    type(h.doc, "mine", h.conn(ALICE));

    await pipe.hook({
      objectId: OBJ,
      doc: h.doc,
      baseVersion: 4,
      actorId: ALICE,
      reason: "teardown",
    });

    expect(h.stored.body).toBe("base\n\nmine");
    expect(pipe.originToken(OBJ)).toBeUndefined();
    expect(pipe.size).toBe(0);
  });

  it("flushes every attached room on a drain", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    type(h.doc, "mine", h.conn(ALICE));
    await pipe.flushAll("drain");
    expect(h.stored.body).toBe("base\n\nmine");
  });
});

describe("suspended while an agent write animates in", () => {
  /**
   * The window this protects: the MCP write has already committed to `objects`
   * and returned success, and for up to ~1.2s the room holds only the hunks
   * applied so far. Anything written from the room in that window is a PREFIX
   * of the agent's write landing on top of a row that already holds all of it.
   */
  it("writes nothing at all while the room is animating", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    // Half the agent's hunks are in, and a human typed while watching.
    h.agentApplies("base\n\nhalf of the agent");
    type(h.doc, "mine", h.conn(ALICE));
    h.animating(9);

    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(h.stored.version).toBe(4);
    expect(h.stored.body).toBe("base");
  });

  it("lands what a human typed during the window once it ends", async () => {
    const h = new Harness("base");
    const pipe = await h.open();
    h.animating(9);
    type(h.doc, "mine", h.conn(ALICE));
    await pipe.flush(OBJ);
    expect(h.writes).toEqual([]);

    // The animation finished; the agent's write is in `objects` already.
    h.stored.body = "base\n\nfrom the agent";
    h.stored.version = 5;
    h.agentApplies("base\n\nfrom the agent\n\nmine");
    h.settled(5);
    await pipe.flush(OBJ);

    // ONE write, attributed to the human, carrying the agent's text underneath
    // it rather than reverting it.
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ actorId: ALICE, baseVersion: 5 });
    expect(h.stored.body).toBe("base\n\nfrom the agent\n\nmine");
  });

  it("does not write the agent's own text back as a churn version", async () => {
    // The base the pipeline held describes the document BEFORE the agent write.
    // Keeping it across the window would make the animated text look like a
    // local contribution and write it back — a version, a history row and an
    // audit event in the joiner's name for text the agent already committed.
    const h = new Harness("base");
    const pipe = await h.open();

    h.animating(5);
    h.stored.body = "base\n\nfrom the agent";
    h.stored.version = 5;
    h.agentApplies("base\n\nfrom the agent");
    await pipe.flush(OBJ);
    h.settled(5);

    await pipe.flush(OBJ);

    expect(h.writes).toEqual([]);
    expect(h.stored.version).toBe(5);
  });

  it("refuses to reconcile a still-animating room at teardown", async () => {
    // The doc store force-completes an animation before its final flush, so
    // getting here means completion was impossible (no driver, or it failed)
    // and the doc is a prefix. `objects` holds the whole write and the row
    // keeps its `animating` mark; the cost is the window's keystrokes.
    const h = new Harness("base");
    const pipe = h.build();
    type(h.doc, "mine", h.conn(ALICE));
    h.animating(9);

    await pipe.hook({
      objectId: OBJ,
      doc: h.doc,
      baseVersion: 4,
      actorId: ALICE,
      reason: "teardown",
    });

    expect(h.writes).toEqual([]);
    expect(h.stored.body).toBe("base");
    expect(h.stored.version).toBe(4);
    expect(pipe.size).toBe(0);
  });

  it("resumes on its own timer, without waiting for another keystroke", async () => {
    vi.useFakeTimers();
    const h = new Harness("base");
    const pipe = h.build();
    pipe.attach(OBJ, ALICE);
    await vi.advanceTimersByTimeAsync(0);
    await settle();

    h.animating(9);
    type(h.doc, "mine", h.conn(ALICE));
    await vi.advanceTimersByTimeAsync(FLUSH_IDLE_MS + 10);
    await settle();
    expect(h.writes).toEqual([]);

    h.settled();
    await vi.advanceTimersByTimeAsync(FLUSH_IDLE_MS + 10);
    await settle();

    expect(h.writes).toHaveLength(1);
    expect(h.stored.body).toBe("base\n\nmine");
  });
});

describe("createWriterFlushWrite", () => {
  const write: FlushWrite = {
    objectId: OBJ,
    actorId: ALICE,
    baseVersion: 4,
    title: "T",
    body: "b",
    originToken: "abc123",
  };

  it("calls the same core editFields every other write uses, with the origin token", async () => {
    const editFields = vi.fn().mockResolvedValue({ id: OBJ, version: 5 });
    const fn = createWriterFlushWrite({ editFields });
    await expect(fn(write)).resolves.toEqual({ ok: true, version: 5 });
    expect(editFields).toHaveBeenCalledWith(
      { actorId: ALICE, scopes: ["write"] },
      OBJ,
      expect.objectContaining({ baseVersion: 4, title: "T", body: "b", originToken: "abc123" }),
    );
  });

  it("maps a version conflict to `conflict`, not to a refusal", async () => {
    const editFields = vi
      .fn()
      .mockRejectedValue(
        new VersionConflictError(
          9,
          { title: null, body: null, props: {}, updated_at: "", actor_name: null },
          OBJ,
        ),
      );
    const fn = createWriterFlushWrite({ editFields });
    await expect(fn(write)).resolves.toEqual({ ok: false, kind: "conflict", currentVersion: 9 });
  });

  it("maps an infrastructure failure to `error`, so nobody is evicted for a dead pool", async () => {
    const editFields = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const fn = createWriterFlushWrite({ editFields });
    const out = await fn(write);
    expect(out).toMatchObject({ ok: false, kind: "error" });
  });
});
