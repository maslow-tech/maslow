import type { Pool } from "pg";
import type { DocRecords, RoomView } from "./docStore.js";
// TYPE-ONLY, deliberately: `INGEST_ORIGIN` below needs the flush's origin
// constant for a compile-time equality proof and nothing else. A runtime import
// would drag the whole write path (`@brain/mcp-tools`, `pg`) into a module whose
// job is to read a feed and call a pure diff.
import type { FLUSH_ORIGIN } from "./flush.js";
import { planAnimation, positionFor } from "./animate.js";
import { BRIDGE_ORIGIN, applyMarkdownDiff, changedBlockRanges } from "./mdDiff.js";
import { docRoom, type AgentPresence, type AgentPresenceSession } from "./presence.js";
import { canonicalMarkdown } from "./serialize.js";

/**
 * The AGENT-WRITE BRIDGE: a watcher over the event feed that notifies LIVE
 * rooms of external writes (an MCP `edit`, a CAS `PATCH`, a merge) so an agent's
 * edit APPEARS in open editors instead of colliding with them at flush time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONSTRAINED BY CONSTRUCTION, BECAUSE THE FEED CARRIES NO RLS
 *
 * `events` has no row-level security — a documented ceiling since 0012: the feed
 * shows "actor X updated <uuid>" for objects the reader cannot get, which is why
 * its payloads carry versions and never content. This watcher therefore reads
 * PRIVILEGED (unscoped) and is fenced in by construction rather than by care:
 *
 *  - it may push a diff ONLY INTO A ROOM THAT ALREADY EXISTS. It never creates
 *    one, never joins one, never asks the doc store to open one. Rooms exist
 *    only because an authorized member joined (an RLS-bound read as that actor),
 *    so "a room exists" is itself the authorization the feed cannot provide;
 *  - the CONTENT it pushes is never read from the feed. It is re-read from
 *    `objects` as a member who is IN the room, under that actor's own RLS —
 *    if that read comes back empty the bridge does nothing at all;
 *  - the presence it emits (phase 5, below) is published ONLY into a room that
 *    already has members, and only about an object it just re-read as a member
 *    of that room. An object with no room produces no signal of any kind, so
 *    nothing here can reveal that a private object exists, or was written to,
 *    to anyone who cannot already see it;
 *  - it carries no raw feed data — no actor, no target id, no title — into a
 *    route-level room. What it hands outward is `onConflict(objectId)` and one
 *    agent identity, both into the OBJECT's own room, whose members are by the
 *    same argument already authorized to see that the object exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ECHO SAFETY IS THE WHOLE REASON THIS FILE IS CAREFUL
 *
 * The flush is itself a CAS write through the core write fn, so it emits the
 * same feed event an agent's write does. Dropping those events is not an
 * optimization; without it the bridge eats its own tail:
 *
 *   12:00:00  the flush serializes state S1 and commits it
 *   12:00:01  the user types on, and the doc is now at S2
 *   12:00:02  the flush's own feed event reaches the watcher
 *             → the bridge applies diff(old → S1) into a doc at S2, re-inserting
 *               text the user deleted and re-deleting text they typed
 *
 * At best that is jitter; at worst it is a stable loop that rewrites every open
 * object on every cycle, forever. So an event is dropped when its ORIGIN TOKEN —
 * minted per room by the flush pipeline, carried on the write, round-tripped
 * through the audit event's `reason` and recovered with `parseOrigin` — belongs
 * to a room's own flush. Recognition is by TOKEN and never by comparing content:
 * a content comparison at 12:00:02 says "S1 ≠ S2, therefore somebody else's",
 * which is precisely backwards.
 *
 * The version check below (`already reconciled`) is a cheap second line, NOT a
 * substitute: a flush's event can arrive before its own `markFlushed` lands, and
 * then only the token knows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE 5: THE WRITE HAS A NAME
 *
 * An ingested write used to appear as a silent text mutation — paragraphs
 * arriving from nowhere. Before applying one, the bridge now joins the object's
 * presence room under a SYNTHETIC AWARENESS CLIENT for the write's REAL ACTOR
 * (an agent token's actor, an MCP caller, a cron — read from the audit event,
 * never invented here) and releases it after an idle linger, so the room sees a
 * named robot cursor arrive, write, and leave the way a person's does.
 *
 * The identity on that client is STAMPED BY THE RELAY from the principal the
 * bridge hands it (`presence.ts`, refusal 2) and is not settable by any
 * connected client — "this text came from Claude" must not be a claim a browser
 * can forge. And it is published only where the write itself is: into a room
 * that already exists, holding people who already passed the RLS join read for
 * this object. An agent editing a private object still produces no avatar and
 * no count anywhere a non-creator can see.
 *
 * Design invariants: the flush must not re-enter through its own bridge;
 * agents carry a named awareness identity.
 */

/* ========================================================================== *
 * Cadence                                                                     *
 * ========================================================================== */

/**
 * How often the feed is polled. A second is well inside "appears live" for a
 * write a human did not make, and it is one indexed range scan against a table
 * the box writes to constantly — cheaper than LISTEN/NOTIFY plumbing that would
 * have to survive a connection drop to be trustworthy anyway.
 */
const BRIDGE_POLL_MS = 1_000;

/** Events read per poll. A backlog drains over several polls rather than in one. */
const BRIDGE_BATCH = 200;

/**
 * The event kinds that can change a room's content.
 *
 * `update_props` is deliberately absent: props stay on CAS and are not in the
 * CRDT, so a prop edit has nothing to push. `create` cannot have a room yet.
 * `delete` is NOT handled here — trashing an object purges its room through the
 * write path that trashed it, and a watcher that "helpfully" reacted to a delete
 * would be writing box state it did not create.
 */
const BODY_KINDS = ["update", "restore"] as const;

/**
 * The origin every ingested write carries into the doc.
 *
 * It is DELIBERATELY the flush pipeline's own origin, and the annotation is a
 * compile-time proof the two constants have not drifted apart. The flush
 * recognises exactly two non-contributory origins (`SEED_ORIGIN`,
 * `FLUSH_ORIGIN`) and treats every other transaction as a human contribution:
 * to be attributed, and — finding no account behind it — REFUSED, reverted back
 * out of the live doc and escalated as `unattributed`. A bridge write under a
 * private origin would therefore be undone by the very next flush cycle, which
 * is the opposite of this module's job.
 *
 * The two are the same class of transaction — the database talking to itself,
 * content that came OUT of `objects` and must not be scheduled to go back in —
 * so they share one origin.
 *
 * PHASE 5 DELIBERATELY DOES NOT CHANGE THIS. The agent's identity travels on
 * the AWARENESS client (which is what the room actually renders), not on the
 * Yjs origin, because the origin is read by exactly one consumer — flush.ts —
 * and there it is a statement about whether the text needs writing BACK to
 * `objects`. An ingested write is already committed there; labelling it with an
 * agent origin flush.ts does not yet recognise would make the flush treat the
 * agent's own paragraph as an unattributed human contribution, refuse it, and
 * revert it out of the doc. `originFor` is the seam for the day flush.ts learns
 * to attribute an agent (the two must land together); until then the default is
 * the constant flush.ts already knows.
 */
const INGEST_ORIGIN: typeof FLUSH_ORIGIN = BRIDGE_ORIGIN;

/* ========================================================================== *
 * Seams                                                                       *
 * ========================================================================== */

/** One feed row, narrowed. It carries NO content — by construction, see above. */
export interface BridgeEvent {
  readonly seq: number;
  readonly kind: string;
  readonly objectId: string;
  /** `events.payload->>'reason'`; the origin token rides it (`parseOrigin`). */
  readonly reason: string | null;
  /** `events.payload->>'version'` — the version the write produced, if known. */
  readonly version: number | null;
  /**
   * `events.actor` — WHO wrote it, and the only identity phase 5 ever publishes.
   * It is an actor id and nothing else: no name, no role, no content.
   *
   * Optional, and absent means NO AVATAR: an unnamed robot cursor would be a
   * presence claim with nothing behind it, so the write simply lands silently.
   */
  readonly actor?: string | null | undefined;
}

/**
 * The feed read, behind one seam so the watcher can be unit-tested without a
 * Postgres and so exactly one place knows the SQL.
 */
export interface BridgeFeed {
  /** Events after `seq`, oldest first, at most `limit`. */
  since(seq: number, limit: number): Promise<BridgeEvent[]>;
  /** The current high-water mark — where a fresh watcher starts. */
  tip(): Promise<number>;
}

/**
 * The room-facing slice of the doc store. `get` MUST NOT create a room; the doc
 * store's own contract says so in as many words, and this module's authorization
 * argument rests on it.
 */
export interface BridgeRooms {
  get(objectId: string): RoomView | undefined;
  /** Advances the room's CAS base AND compacts the blob — one call, both jobs. */
  markFlushed(objectId: string, version: number): Promise<void>;
}

/** Why a live room could not ingest an external write. */
export type BridgeConflictReason = "merge_failed" | "base_unavailable";

export interface BridgeOptions {
  readonly feed: BridgeFeed;
  readonly rooms: BridgeRooms;
  /**
   * The RLS-bound object read and the before-image read — the doc store's own
   * `createSqlDocRecords(pool)` in production, so there is one SQL definition of
   * "the object as this actor may see it".
   */
  readonly records: Pick<DocRecords, "load" | "baseBody">;
  /** "Did WE write this?" — the flush pipeline's `isOwnFlush`. Round-tripped
   *  origin token, never a content comparison. Absent ⇒ nothing is ever ours,
   *  which is the ECHO LOOP; the wiring must supply it. */
  readonly isOwnFlush?: ((token: string | null | undefined) => boolean) | undefined;
  /** Recover the origin token from an event reason — p1-t2's `parseOrigin`. */
  readonly parseOrigin: (reason: string) => { reason: string; origin: string | null };
  /** Tell connected clients an external write could not be merged in. */
  readonly onConflict?: ((objectId: string, reason: BridgeConflictReason) => void) | undefined;
  /**
   * Called after a room successfully ingested an external write, with the
   * markdown/title/version it is now reconciled to.
   *
   * The seam exists because the flush pipeline caches its own idea of the
   * object's stored content (`baseMd`) and this module cannot reach it: until
   * that cache is refreshed, the NEXT flush of an otherwise idle room writes one
   * redundant version whose body is byte-identical to what the agent already
   * committed. One extra version, never lost text — and the hook is where a
   * later task hands the new base to the flush rather than paying it.
   */
  readonly onIngest?:
    | ((update: {
        readonly objectId: string;
        readonly body: string;
        readonly title: string | null;
        readonly version: number;
      }) => void)
    | undefined;
  /**
   * Where an agent's cursor is published (phase 5). Absent ⇒ the bridge behaves
   * exactly as it did in phase 2: the write lands, silently. Presence is a
   * presentation of a write, never a precondition for one.
   */
  readonly agents?: Pick<AgentPresence, "enter"> | undefined;
  /**
   * The writing actor's display name, read server-side from `accounts` —
   * `createSqlActorNames(pool)` in production.
   *
   * It must never be read from the feed or from anything a client sends: the
   * name is half of an identity claim the room renders as true. Unresolvable
   * (no wiring, a revoked account, a database hiccup) is not fatal — the relay
   * falls back to "Agent", which is honest.
   */
  readonly actorName?: ((actorId: string) => Promise<string | null> | string | null) | undefined;
  /**
   * The Yjs transaction origin for an ingested write, given the agent client
   * publishing it (`null` when there is none).
   *
   * Defaults to the flush's own origin constant and SHOULD stay there until
   * flush.ts can attribute an agent origin — see `INGEST_ORIGIN` above for what
   * breaks otherwise.
   */
  readonly originFor?:
    | ((agent: { readonly actorId: string; readonly clientId: string } | null) => unknown)
    | undefined;
  readonly pollMs?: number | undefined;
  readonly batch?: number | undefined;
}

export interface BridgeStats {
  /** The last feed seq this watcher has consumed. */
  readonly cursor: number;
  /** External writes merged into a live room. */
  readonly ingested: number;
  /** Events recognised as one of our own flushes (the echo gate). */
  readonly ownFlush: number;
  /** Events for an object with no live room — dropped before anything is read. */
  readonly noRoom: number;
  /** Rooms that could not ingest a write and were escalated instead. */
  readonly conflicts: number;
  /** Agent cursors published — ingests where a named client reached the room. */
  readonly cursors: number;
  /** Poll cycles that failed outright (feed unreadable). */
  readonly errors: number;
}

export interface AgentWriteBridge {
  /** Position the cursor at the feed tip and begin polling. Idempotent. */
  start(): Promise<void>;
  /** One poll cycle. Exposed for tests and for a drain; never throws. */
  poll(): Promise<void>;
  stop(): void;
  stats(): BridgeStats;
}

/* ========================================================================== *
 * The watcher                                                                 *
 * ========================================================================== */

export function createAgentWriteBridge(opts: BridgeOptions): AgentWriteBridge {
  const pollMs = opts.pollMs ?? BRIDGE_POLL_MS;
  const batch = Math.max(1, opts.batch ?? BRIDGE_BATCH);

  let cursor = 0;
  let started = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;
  const counts = { ingested: 0, ownFlush: 0, noRoom: 0, conflicts: 0, cursors: 0, errors: 0 };

  const conflict = (objectId: string, reason: BridgeConflictReason): void => {
    counts.conflicts += 1;
    opts.onConflict?.(objectId, reason);
  };

  /**
   * Join the object's presence room as the actor who made this write.
   *
   * Everything that can go wrong here answers `null`, and `null` means the write
   * still lands — silently, exactly as it did before phase 5. The refusals that
   * matter (no room, the actor is a person who is already present, the room is
   * full) live in `createAgentPresence`; this only resolves the name and asks.
   */
  const enterAsAgent = async (
    objectId: string,
    actorId: string | null | undefined,
  ): Promise<AgentPresenceSession | null> => {
    const agents = opts.agents;
    if (!agents || !actorId) return null;
    const room = docRoom(objectId);
    if (!room) return null;
    // The name comes from `accounts`, server-side, never from the feed row.
    let name: string | null = null;
    try {
      name = (await opts.actorName?.(actorId)) ?? null;
    } catch (err) {
      console.warn("collab bridge: actor name lookup failed —", String(err));
    }
    try {
      return agents.enter(room, { actorId, name: name ?? undefined });
    } catch (err) {
      // A presence relay must never be able to stop a write from landing.
      console.warn("collab bridge: agent presence failed —", String(err));
      return null;
    }
  };

  /**
   * PHASE 5's TRAVELLING CURSOR. The write has ALREADY landed in one transaction
   * (see `ingest`), so this is pure presentation: it moves the agent's named
   * cursor across the ranges the write touched, on the chunk scheduler's
   * timeline, so remote peers watch the robot work the range instead of seeing a
   * static caret blink on next to text that appeared from nowhere.
   *
   * This is the design's stated presentation-only path ("apply the full diff in
   * one transaction and animate only the awareness cursor travelling over
   * already-applied text; animation is presentation, never a precondition"). It
   * never touches the Y.Doc — the content path above owns that — so a
   * partial/half-applied document is never persisted and the `animating`
   * flush-suspension machinery is not needed here. `planAnimation` collapses to
   * a single hop for a small edit, reduced motion, or a room with no human
   * viewers (`humanViewers` is the room's live connection count); a big rewrite
   * still finishes inside the ~1.2s cap. Every failure is swallowed: a cursor
   * that cannot be animated is never a reason a landed write is unseen.
   */
  const animateAgentCursor = (
    agent: AgentPresenceSession,
    room: RoomView,
    from: string,
  ): boolean => {
    try {
      const ranges = changedBlockRanges(room.doc, from);
      if (ranges.length === 0) return false;
      const plan = planAnimation(ranges, { humanViewers: room.connections });
      if (plan.chunks.length === 0) return false;
      for (const chunk of plan.chunks) {
        const move = (): void => agent.moveTo(positionFor(chunk.range));
        if (chunk.atMs <= 0) {
          move();
        } else {
          // Unref'd: the animation is a nicety and must never hold the process
          // open past a drain. `moveTo` is a no-op once the cursor is released.
          const timer = setTimeout(move, chunk.atMs);
          timer.unref?.();
        }
      }
      return true;
    } catch (err) {
      console.warn("collab bridge: agent cursor animation failed —", String(err));
      return false;
    }
  };

  /**
   * Merge ONE object's current stored state into its live room.
   *
   * Everything this reads is read as `room.lastActorId` — a member who is
   * already in the room — so the privileged feed read never widens what is
   * fetched. A read that comes back empty (revoked, narrowed, trashed) is left
   * strictly alone: evicting or purging is the write path's job, not a watcher's.
   */
  const ingest = async (objectId: string, room: RoomView, writer: string | null): Promise<void> => {
    // A draining room is mid-teardown: its final flush is committing right now
    // and its blob is about to be dropped. Pushing into it would race the flush
    // and could flip the row's state back to idle underneath the teardown.
    if (room.state !== "idle") return;

    // An ANIMATING room is mid-agent-write: only a PREFIX of the previous write
    // has been applied to the doc, while `objects` already holds all of it. A
    // second write ingested now would be diffed from the pre-animation base into
    // that half-applied doc — and worse, `markFlushed` below would move the CAS
    // base past a version the doc does not contain. Leave it: the driver settles
    // the animation (or force-completes it at teardown), and the next feed event
    // or the flush's own re-read-and-rebase picks this write up correctly.
    if (room.animatingTargetVersion !== null) return;

    const actorId = room.lastActorId;
    if (!actorId) return;

    const loaded = await opts.records.load(actorId, objectId).catch((err: unknown) => {
      console.warn("collab bridge: object read failed —", String(err));
      return null;
    });
    const object = loaded?.object;
    // Not visible to this actor any more, or gone. Say nothing, do nothing.
    if (!object || object.deleted) return;

    // Already reconciled: our own flush (whose event the token gate normally
    // catches first), a re-delivered event, or a batch we coalesced.
    if (object.version <= room.baseVersion) return;

    const to = canonicalMarkdown(object.body ?? "");
    const title = object.title;

    // The `from` side is the body as of the version the ROOM is reconciled to —
    // never the live doc (which is a third state) and never a guess.
    const base = await opts.records.baseBody(actorId, objectId, room.baseVersion);
    if (base.kind === "unavailable") {
      // Never invent a base: diffing against the wrong `from` reverts an
      // acknowledged agent write. Leave the room where it is — the next flush's
      // CAS will lose and go through the flush's own re-read-and-rebase path,
      // which handles exactly this case correctly.
      console.warn(`collab bridge: no recoverable base for ${objectId}; leaving it to the flush`);
      conflict(objectId, "base_unavailable");
      return;
    }

    if (base.kind === "unchanged") {
      // A props / link / visibility edit: the version moved, the spine did not.
      // Nothing to merge — just move the room's CAS base so the next flush does
      // not lose a CAS it was always going to lose.
      await opts.rooms.markFlushed(objectId, object.version).catch((err: unknown) => {
        console.warn("collab bridge: markFlushed failed —", String(err));
      });
      return;
    }

    const from = canonicalMarkdown(base.body);

    // The named client joins BEFORE the transaction and lingers after it: a
    // cursor that appeared only once the text had already changed would explain
    // nothing. It is entered here — after the RLS-bound read proved this room's
    // member may see the object, and only for a write that has real content to
    // apply — so a props-only or unreadable write never produces an avatar.
    const agent = await enterAsAgent(objectId, writer);
    const origin = opts.originFor
      ? opts.originFor(
          agent ? { actorId: agent.identity.actorId, clientId: agent.handle.clientId } : null,
        )
      : INGEST_ORIGIN;

    let merged = false;
    try {
      merged = applyMarkdownDiff(room.doc, from, to, { title, origin });
    } catch (err) {
      console.warn("collab bridge: diff threw —", String(err));
      merged = false;
    }
    if (!merged) {
      // The write cannot be merged into what the room now holds (overlapping
      // edits in the same paragraph). Surface it; never half-apply, never pick a
      // winner. The room keeps its base, so the next flush re-reads and rebases.
      // The cursor goes with it: an agent that changed nothing was never here.
      agent?.release();
      conflict(objectId, "merge_failed");
      return;
    }

    counts.ingested += 1;
    if (agent) {
      counts.cursors += 1;
      // Phase 5's travelling cursor: move the named robot across the ranges this
      // write touched, on the scheduler's timeline. When there is nothing to
      // travel (a delete left no new block), fall back to re-arming the linger
      // from the moment the text changed, so the ~5s is time a reader had to see
      // WHO wrote it rather than time spent reading Postgres.
      if (!animateAgentCursor(agent, room, from)) agent.touch();
    }
    // The room's content is now reconciled to this version: its CAS base moves
    // and the blob is compacted in the same call.
    //
    // Re-read the LIVE room first. This whole ingest ran on a RoomView
    // SNAPSHOT captured at the top of the poll cycle, and nothing serializes
    // it against the flush pipeline: a flush can lose its CAS, re-read, rebase
    // and commit a NEWER version inside our awaits. `markFlushed` is monotonic
    // (docStore refuses to regress), but `onIngest` → noteExternalWrite would
    // still reset the flush's cached base to THIS (now stale) body while
    // `objects` holds the newer one — poisoning the next flush into a phantom
    // `rebase_failed`. When the live base has already passed this version,
    // both calls are stale: skip them.
    const live = opts.rooms.get(objectId);
    if (!live || live.baseVersion >= object.version) return;
    await opts.rooms.markFlushed(objectId, object.version).catch((err: unknown) => {
      console.warn("collab bridge: markFlushed failed —", String(err));
    });
    opts.onIngest?.({ objectId, body: to, title, version: object.version });
  };

  /**
   * One cycle: read a batch, decide per event, then ingest ONCE per object.
   *
   * Coalescing is safe and deliberate — the content is re-read from `objects`
   * either way, so N events for one object cost one read. It is also careful:
   * an object is ingested when ANY of its events in the batch is external, so a
   * batch holding both our own flush and an agent's write still ingests.
   */
  const cycle = async (): Promise<boolean> => {
    const events = await opts.feed.since(cursor, batch);
    if (events.length === 0) return false;

    /**
     * object id → the highest version seen for it in this batch (or null), and
     * the actor of the LAST external event for it — the one whose cursor the
     * room sees, because coalescing means the doc lands on that writer's text.
     */
    const pending = new Map<string, { version: number | null; actor: string | null }>();
    let maxSeq = cursor;

    for (const event of events) {
      if (event.seq > maxSeq) maxSeq = event.seq;
      if (!BODY_KINDS.includes(event.kind as (typeof BODY_KINDS)[number])) continue;

      // ROOM FIRST. An object with no live room is dropped here, before its
      // content is read, before anything at all is emitted about it.
      const room = opts.rooms.get(event.objectId);
      if (!room) {
        counts.noRoom += 1;
        continue;
      }

      // ECHO GATE. By token, round-tripped through the audit event — never by
      // comparing content (see the header).
      const origin = event.reason === null ? null : opts.parseOrigin(event.reason).origin;
      if (opts.isOwnFlush?.(origin) === true) {
        counts.ownFlush += 1;
        continue;
      }

      // null means "at least one of this object's events did not say which
      // version it produced", which disables the version pre-filter for it —
      // an unknown version must never be read as an old one and skipped.
      const known = pending.get(event.objectId);
      const version =
        event.version === null || known?.version === null
          ? null
          : known === undefined
            ? event.version
            : Math.max(known.version, event.version);
      pending.set(event.objectId, { version, actor: event.actor ?? null });
    }

    // The cursor advances for the WHOLE batch, including events that failed to
    // ingest. A poison event that stalled the cursor would stop the watcher for
    // every room on the box, which is a far worse failure than one unmerged
    // write (whose room the flush's rebase path still reconciles correctly).
    cursor = maxSeq;

    for (const [objectId, { version, actor }] of pending) {
      const room = opts.rooms.get(objectId);
      if (!room) {
        counts.noRoom += 1;
        continue;
      }
      // Cheap pre-filter: the event's own version says the room already has it.
      if (version !== null && version <= room.baseVersion) continue;
      try {
        await ingest(objectId, room, actor);
      } catch (err) {
        // A watcher must never take the process down over one room.
        console.warn(`collab bridge: ingest failed for ${objectId} —`, String(err));
      }
    }

    return events.length >= batch;
  };

  const poll = async (): Promise<void> => {
    if (running) {
      await running;
      return;
    }
    const run = (async (): Promise<void> => {
      try {
        // Drain a backlog over a few cycles, bounded so one busy box cannot keep
        // the loop from yielding.
        for (let i = 0; i < 5; i += 1) {
          if (stopped) return;
          if (!(await cycle())) return;
        }
      } catch (err) {
        counts.errors += 1;
        // The cursor is NOT advanced on a failed read: the batch is retried next
        // tick. A database hiccup must not silently skip agent writes.
        console.warn("collab bridge: poll failed —", String(err));
      } finally {
        running = null;
      }
    })();
    running = run;
    await run;
  };

  return {
    start: async (): Promise<void> => {
      if (started || stopped) return;
      started = true;
      // Start at the TIP. Replaying history would push long-superseded writes
      // into rooms that are already current, and no room can predate the boot.
      cursor = await opts.feed.tip().catch((err: unknown): number => {
        console.warn("collab bridge: could not read the feed tip —", String(err));
        return 0;
      });
      timer = setInterval(() => {
        void poll();
      }, pollMs);
      timer.unref?.();
    },
    poll,
    stop: (): void => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    stats: (): BridgeStats => ({ cursor, ...counts }),
  };
}

/* ========================================================================== *
 * The SQL feed                                                                *
 * ========================================================================== */

/** Bound every feed query; a wedged database must not wedge the watcher. */
const FEED_TIMEOUT_MS = 5_000;

/** Postgres refuses a non-uuid literal for a uuid column; pre-filter here too. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The privileged (unscoped) feed read.
 *
 * `events` carries no RLS — the 0012 ceiling — so this is a plain read as the
 * request-serving role with NO actor set, and it is deliberately narrow: seq,
 * kind, target and the two payload scalars the watcher needs. It never selects
 * content, and every row it returns is filtered against the LIVE ROOM SET before
 * anything else happens to it.
 */
export function createSqlBridgeFeed(pool: Pool): BridgeFeed {
  const read = async <T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(FEED_TIMEOUT_MS),
      ]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  return {
    async since(seq, limit) {
      return read(async (c) => {
        const { rows } = await c.query<{
          seq: string;
          kind: string;
          target: string | null;
          actor: string | null;
          reason: string | null;
          version: string | null;
        }>(
          `SELECT seq, kind, target, actor,
                  payload->>'reason' AS reason,
                  payload->>'version' AS version
           FROM events
           WHERE seq > $1 AND kind = ANY($2::text[]) AND target IS NOT NULL
           ORDER BY seq ASC
           LIMIT $3`,
          [seq, [...BODY_KINDS], limit],
        );
        const out: BridgeEvent[] = [];
        for (const row of rows) {
          if (!row.target) continue;
          out.push({
            seq: Number(row.seq),
            kind: row.kind,
            objectId: row.target,
            actor: row.actor,
            reason: row.reason,
            version: row.version === null ? null : Number(row.version),
          });
        }
        return out;
      });
    },

    async tip() {
      return read(async (c) => {
        const { rows } = await c.query<{ m: string }>(
          "SELECT coalesce(max(seq), 0)::bigint AS m FROM events",
        );
        return Number(rows[0]?.m ?? 0);
      });
    },
  };
}

/* ========================================================================== *
 * Actor names                                                                 *
 * ========================================================================== */

/** How long a resolved display name is reused. A rename is not urgent news. */
const NAME_TTL_MS = 300_000;
/** Bound the cache: a box's `accounts` is small, a runaway map is still a bug. */
const NAME_CACHE_MAX = 500;

/**
 * "Who is this actor?", answered from `accounts` — the ONLY source phase 5 will
 * take a name from.
 *
 * The read is privileged and content-free by construction: one column, one row,
 * an id the bridge already holds from the audit event. `accounts` carries no
 * RLS (names are how a rail is legible at all — every member sees every
 * member's name today, on every avatar and in every history entry), and nothing
 * here reaches an object, a body or a title.
 *
 * A miss (revoked, deleted, unreadable) answers `null` and the relay draws the
 * honest fallback rather than a guess.
 */
export function createSqlActorNames(pool: Pool): (actorId: string) => Promise<string | null> {
  const cache = new Map<string, { name: string | null; expiresAt: number }>();

  return async (actorId: string): Promise<string | null> => {
    if (!UUID_RE.test(actorId)) return null;
    const now = Date.now();
    const hit = cache.get(actorId);
    if (hit && hit.expiresAt > now) return hit.name;

    let name: string | null = null;
    try {
      const { rows } = await pool.query<{ name: string | null }>(
        "SELECT name FROM accounts WHERE id = $1",
        [actorId],
      );
      name = rows[0]?.name ?? null;
    } catch (err) {
      console.warn("collab bridge: actor name read failed —", String(err));
      return null; // not cached: a hiccup must not stick for five minutes
    }

    if (cache.size >= NAME_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(actorId, { name, expiresAt: now + NAME_TTL_MS });
    return name;
  };
}
