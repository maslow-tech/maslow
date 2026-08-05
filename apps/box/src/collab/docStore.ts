import type { Pool, PoolClient } from "pg";
import * as Y from "yjs";
import { SEED_ORIGIN, canonicalMarkdown, docToMarkdown, seedDocFromMarkdown } from "./serialize.js";
import type { CollabEvictReason } from "./types.js";

/**
 * The doc store: `collab_docs` + the in-memory Y.Doc per object.
 *
 * ONE Y.Doc per object, holding body as a Y.XmlFragment and title as a Y.Text
 * (serialize.ts owns that shape). Everything else — props, links, visibility —
 * stays on CAS. Markdown in `objects.body` remains the single source of truth
 * AT REST; a row in `collab_docs` is disposable in-flight state.
 *
 * This module owns four things the spec calls out by name, each of which is a
 * data-loss bug when it is left to "whatever hocuspocus does":
 *
 *  1. SEEDING IS ONE RULE (`planSeed`, below). Resume the blob only when it is
 *     reconciled to the object's CURRENT version; otherwise rebase it onto the
 *     current markdown; never resume over a newer version, never silently drop
 *     unflushed text.
 *  2. EPOCH. Every re-seed changes the doc's identity, and a client that merges
 *     its pre-restart Y.Doc into a re-seeded server doc duplicates the body end
 *     to end (Yjs sees two independent insert sequences under two client ids).
 *     The epoch is advertised in the handshake so the client discards local
 *     state instead.
 *  3. COMPACTION. Every persist writes a SNAPSHOT and the update log is dropped
 *     by construction (one `blob` column, always overwritten). Mandatory twice
 *     over: an append-only log grows monotonically on a volume shared with
 *     PGDATA, the WAL archive and the pgBackRest repo; and a log retains text
 *     the author later deleted, which neither the body nor history retain
 *     (cf. 0028-redact-connector-history).
 *  4. LIFECYCLE. Teardown is atomic — mark draining, make joins WAIT, final
 *     flush commits, then drop memory and delete the row. A join that seeded
 *     from pre-flush markdown would lose the tail of the previous session and
 *     then flush that loss back over it.
 *  5. ANIMATING (phase 5). While an agent write is applied in chunks the row is
 *     marked `animating` with the target `objects.version`, flushes are
 *     SUSPENDED, and a resume IGNORES the blob and re-seeds from markdown. The
 *     MCP write has already committed and been acknowledged; for up to ~1.2s
 *     the blob holds only a PREFIX of it, and flushing (or resuming) that
 *     prefix would delete the rest of a write the agent was told succeeded.
 *     Teardown FORCE-COMPLETES the animation before its final flush.
 *
 * Everything here runs under the SAME request-serving role and actor as any
 * other write (`brain_app` with `app.actor_id` set) — never `brain_system`,
 * never a BYPASSRLS path. `collab_docs`'s row predicate is the OBJECT's
 * visibility (0053), so any member who may join the room may legitimately read
 * and write its blob.
 */

/* ========================================================================== *
 * Budget constants                                                            *
 * ========================================================================== */

/**
 * Idle rooms tear down after ~2min. A room costs a Y.Doc in the app process
 * AND a `collab_docs` row; neither is worth keeping for a tab someone left
 * open on a document they stopped typing into three hours ago.
 */
const ROOM_IDLE_TTL_MS = 120_000;

/** How often idleness / the memory ceiling are re-evaluated. */
const ROOM_SWEEP_MS = 15_000;

/**
 * The stated memory ceiling, sized for a t3-class instance.
 *
 * A box is a t3.small-ish appliance whose app container also holds the local
 * embedder and reranker; the collab engine is a guest there, not the tenant.
 * 48 MiB of ESTIMATED doc state is roughly 60-100 concurrently open documents
 * of ordinary size, which is far more simultaneous editing than a company that
 * fits on one box will ever do — and it is a ceiling, not a target: rooms are
 * evicted LRU when it is crossed, they are not refused.
 */
const ROOM_MEMORY_CEILING_BYTES = 48 * 1024 * 1024;

/**
 * In-memory bytes per encoded-snapshot byte. A Y.Doc's live representation
 * (item structs, the XML element tree, the doc's index) is several times its
 * encoded update; 8× is a deliberately pessimistic estimate, because the
 * failure mode of under-estimating is an OOM-killed app container on a
 * customer's box and the failure mode of over-estimating is one extra eviction.
 */
const ROOM_MEMORY_OVERHEAD = 8;

/** Hard cap on live rooms, independent of size — bounds timers and sockets. */
const MAX_ROOMS = 100;

/**
 * Blob persistence cadence. This is NOT the flush cadence (that writes markdown
 * to `objects` and lives in the flush task): it is how much typing a `docker
 * kill -9` can cost. 1s after the last keystroke, and at most 5s into a
 * continuous burst.
 */
const PERSIST_DEBOUNCE_MS = 1_000;
const PERSIST_MAX_MS = 5_000;

/** Bound every store query; a wedged database must not wedge a room. */
const STORE_TIMEOUT_MS = 5_000;

/**
 * Postgres refuses a non-uuid literal for a uuid column with 22P02.
 *
 * CANONICAL LOWERCASE ONLY (no /i) — the same rule as the join gate in
 * auth.ts, restated here because `rooms` keys on this string: an uppercase
 * spelling that got through would build a second, divergent room bound to the
 * same `collab_docs` row as the canonical one. See auth.ts UUID_RE.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* ========================================================================== *
 * Records — the `collab_docs` row and the reads a seed needs                  *
 * ========================================================================== */

/** Lifecycle flag on the row (0053's CHECK constraint). */
export type CollabDocState = "idle" | "draining" | "animating";

/** One `collab_docs` row, with bigints already narrowed to numbers. */
export interface CollabDocRow {
  readonly objectId: string;
  readonly blob: Uint8Array;
  readonly epoch: number;
  readonly lastFlushedVersion: number;
  readonly state: CollabDocState;
  readonly animatingTargetVersion: number | null;
}

/** The object as the joining actor may see it. */
export interface ObjectSnapshot {
  readonly version: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly deleted: boolean;
}

/**
 * The body/title an object HAD at a given version, recovered from
 * `before_image` — the base a rebase diffs the blob's unflushed delta against.
 *
 *  - `exact`     the pre-image of the first spine change at or after that
 *                version, i.e. the body as the last flush left it;
 *  - `unchanged` no `before_image` row at or after that version, so no spine
 *                change has happened since (a version bump from a props or
 *                visibility edit writes no before-image) and the object's
 *                CURRENT body is still the base;
 *  - `unavailable` the read failed. Never guessed at: guessing here reverts an
 *                acknowledged agent write.
 */
export type BaseBody =
  | { readonly kind: "exact"; readonly title: string | null; readonly body: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "unavailable" };

/**
 * Every database touch the store makes, behind one seam so the lifecycle can be
 * unit-tested without a Postgres (and so there is exactly one place that knows
 * the SQL). The default implementation is `createSqlDocRecords`.
 */
export interface DocRecords {
  /** The object + its collab row, read as `actorId` in one RLS-bound txn. */
  load(
    actorId: string,
    objectId: string,
  ): Promise<{ readonly object: ObjectSnapshot | null; readonly row: CollabDocRow | null }>;
  /** The body at `version`, for a rebase. */
  baseBody(actorId: string, objectId: string, version: number): Promise<BaseBody>;
  /** Upsert the row — always a full snapshot, never an appended update. */
  save(actorId: string, row: CollabDocRow): Promise<void>;
  /** Purge the row. Returns false when nothing was deleted (already gone). */
  remove(actorId: string, objectId: string): Promise<boolean>;
}

/* ========================================================================== *
 * The seeding rule                                                            *
 * ========================================================================== */

type SeedPlan =
  | { readonly kind: "seed" }
  | { readonly kind: "resume" }
  | { readonly kind: "rebase" }
  | {
      readonly kind: "reseed";
      readonly reason: "animating" | "version_regressed" | "blob_unreadable";
    };

/**
 * ONE rule, decided as a pure function so it can be tested without a room.
 *
 * `animating` (phase 5) comes FIRST: while an agent write is being applied in
 * chunks, the stored markdown already contains the whole committed write, so a
 * crash mid-animation must re-seed from markdown rather than resume a blob that
 * holds half of it.
 */
export function planSeed(row: CollabDocRow | null, object: ObjectSnapshot): SeedPlan {
  if (!row) return { kind: "seed" };
  if (row.state === "animating") return { kind: "reseed", reason: "animating" };
  if (row.blob.byteLength === 0) return { kind: "reseed", reason: "blob_unreadable" };
  if (row.lastFlushedVersion === object.version) return { kind: "resume" };
  // A blob reconciled to a version NEWER than the object's is impossible on a
  // box we created (versions only go up) — a restore-from-backup or a rollback
  // could produce it. Never throw on box state you didn't create: re-seed from
  // what the database says is true and move on.
  if (row.lastFlushedVersion > object.version) {
    return { kind: "reseed", reason: "version_regressed" };
  }
  return { kind: "rebase" };
}

/* ========================================================================== *
 * The store's public surface                                                  *
 * ========================================================================== */

/** How the room's content came to be, for logs and for the client's banner. */
type SeedOutcome =
  | "seed"
  | "resume"
  | "rebase"
  | "reseed_animating"
  | "reseed_version_regressed"
  | "reseed_blob_unreadable"
  | "rebase_unmerged";

export interface JoinedRoom {
  readonly objectId: string;
  readonly doc: Y.Doc;
  /** Advertised in the sync handshake; a change means "discard local Y state". */
  readonly epoch: number;
  /** The `objects.version` this room's content is reconciled to (its CAS base). */
  readonly baseVersion: number;
  readonly seeded: SeedOutcome;
  /**
   * Set only when a rebase could not be completed (no diff bridge wired, or the
   * base body was unrecoverable). The room is seeded from the CURRENT markdown
   * — the agent write is never reverted — and the blob's text is handed up here
   * so the caller can surface it as a conflict/recovery draft. Unflushed text is
   * never silently dropped; when it cannot be merged it is escalated.
   */
  readonly unmerged?: string;
}

/** A live room, as everything outside this module may see it. */
export interface RoomView {
  readonly objectId: string;
  readonly doc: Y.Doc;
  readonly epoch: number;
  readonly baseVersion: number;
  readonly state: "idle" | "draining";
  readonly connections: number;
  readonly lastActorId: string;
  /**
   * Non-null while an agent write is being applied in chunks — the
   * `objects.version` the doc will hold once the last chunk lands.
   *
   * It is on the view and not just in the row because every other writer has to
   * see it: the flush pipeline SUSPENDS while it is set (a flush of a
   * half-applied doc writes a prefix of the agent's write over a row that
   * already holds all of it), and nothing else may push into the doc for the
   * same reason. Orthogonal to `state`, which stays `idle` — an animating room
   * is a perfectly normal room that people may join and type in.
   */
  readonly animatingTargetVersion: number | null;
}

/** What the flush hook (the CRDT → markdown CAS write) is handed. */
export interface FlushTarget {
  readonly objectId: string;
  readonly doc: Y.Doc;
  readonly baseVersion: number;
  /** The last actor to touch the room — the attribution fallback, not the rule. */
  readonly actorId: string;
  /** Why the flush was asked for; a drain flush may not be deferred. */
  readonly reason: "teardown" | "drain" | "evict";
}

/**
 * The old→new markdown diff bridge (the agent-write bridge's own primitive).
 * Applies the change between two markdown revisions into a LIVE doc that may
 * have diverged from both, in one transaction with `origin`. Returns false when
 * it cannot be applied cleanly — the caller must then escalate, never guess.
 */
export type ApplyMarkdownDiff = (args: {
  readonly doc: Y.Doc;
  readonly from: string;
  readonly to: string;
  readonly title?: string | null;
  readonly origin: unknown;
}) => boolean;

/**
 * End an in-flight animation NOW, because the room is going away.
 *
 * Registered with `setAnimating` by whoever is driving the chunks (the
 * agent-write bridge), because only the driver knows which hunks are left.
 *
 *  - `"teardown"` — apply EVERY remaining hunk in ONE transaction, before the
 *    room's final flush runs. The flush must see the whole agent write, not a
 *    prefix of it.
 *  - `"cancel"`   — apply nothing and stop: the doc is about to be destroyed
 *    (the object was trashed, or its visibility narrowed). Writing into a doc
 *    the store is destroying resurrects content the user just removed.
 *
 * It must not throw; if it does, the room stays marked `animating` and the next
 * process re-seeds from markdown rather than trusting a half-applied blob.
 */
export type ForceCompleteAnimation = (reason: "teardown" | "cancel") => void | Promise<void>;

interface DocStoreOptions {
  /** brain_app pool. Ignored when `records` is supplied (tests). */
  readonly pool?: Pool | undefined;
  readonly records?: DocRecords | undefined;
  /** CRDT → markdown CAS write. Absent ⇒ teardown drops the room without one. */
  readonly flush?: ((target: FlushTarget) => Promise<void>) | undefined;
  /** The rebase bridge. Absent ⇒ a rebase escalates instead of merging. */
  readonly applyMarkdownDiff?: ApplyMarkdownDiff | undefined;
  /** Told when a room goes away so the server can close its sockets. */
  readonly onEvict?: ((objectId: string, reason: CollabEvictReason) => void) | undefined;
  readonly idleTtlMs?: number | undefined;
  readonly sweepMs?: number | undefined;
  readonly memoryCeilingBytes?: number | undefined;
  readonly maxRooms?: number | undefined;
  readonly persistDebounceMs?: number | undefined;
  readonly persistMaxMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface DocStore {
  /**
   * Join a room, seeding/resuming/rebasing per `planSeed`. Returns null when
   * the object is not visible to this actor or is trashed — the caller gives
   * ONE answer for "cannot see it" and "does not exist".
   *
   * A join that arrives while the room is draining WAITS for the final flush
   * and then seeds from the post-flush markdown.
   */
  join(objectId: string, actorId: string): Promise<JoinedRoom | null>;
  /** A connection left. Idle rooms are torn down by the sweep, not here. */
  leave(objectId: string): void;
  /** Mark activity (a message, an update) so the idle sweep leaves it alone. */
  touch(objectId: string, actorId?: string): void;
  /** The live room, or undefined. NEVER creates one — the bridge relies on that. */
  get(objectId: string): RoomView | undefined;
  has(objectId: string): boolean;
  readonly size: number;
  /** Persist the compacted snapshot now (the debounce's forced form). */
  persist(objectId: string): Promise<void>;
  /**
   * Record a successful flush: the room's content is now reconciled to
   * `version`. Writes a fresh SNAPSHOT in the same breath — compaction happens
   * on every flush, not on a schedule.
   */
  markFlushed(objectId: string, version: number): Promise<void>;
  /**
   * Enter the animating window: the row is marked `animating` with the target
   * `objects.version` and FLUSHES ARE SUSPENDED until it is left.
   *
   * AWAIT THIS BEFORE APPLYING THE FIRST CHUNK. The row write is what makes a
   * crash mid-animation legible; a chunk applied before it can be persisted by
   * the blob debounce under `state = 'idle'`, and then a resume trusts a
   * half-applied blob — the one outcome this whole mechanism exists to prevent.
   *
   * `forceComplete` is how the room is emptied of its remaining hunks if it
   * tears down mid-animation; a driver that cannot do that omits it and accepts
   * that the window's keystrokes are lost on teardown (never the agent write —
   * `objects` already holds all of it).
   */
  setAnimating(
    objectId: string,
    targetVersion: number,
    forceComplete?: ForceCompleteAnimation,
  ): Promise<void>;
  /**
   * Leave it: the doc now holds the whole write, so the room's CAS base becomes
   * the animation's target version (that IS the version its content is
   * reconciled to) and flushes resume. `version` defaults to the target.
   */
  endAnimating(objectId: string, version?: number): Promise<void>;
  /** Atomic teardown: draining → refuse/queue joins → final flush → drop + purge. */
  teardown(objectId: string, reason?: CollabEvictReason): Promise<void>;
  /**
   * Drop a room WITHOUT flushing and delete its row: object delete/trash, and
   * visibility narrowing. Flushing here would write content back into an object
   * the user just trashed, or under a visibility that no longer holds.
   *
   * `actorId` is the actor of the write that triggered the purge — the row is
   * deleted under THAT actor's RLS, like every other write on this box. Omitted
   * (an internal eviction), the room's last actor is used; with neither there is
   * no actor to write as and only the in-memory room is dropped.
   */
  purge(objectId: string, reason: CollabEvictReason, actorId?: string): Promise<void>;
  /** Idle + budget sweep. Called by the interval; exposed for tests. */
  sweep(): Promise<void>;
  /** SIGTERM: tear every room down, flushing each. */
  drainAll(): Promise<void>;
  /** drainAll + stop the sweep timer. */
  close(): Promise<void>;
  stats(): { readonly rooms: number; readonly estimatedBytes: number };
}

/* ========================================================================== *
 * Implementation                                                              *
 * ========================================================================== */

interface LiveRoom {
  readonly objectId: string;
  doc: Y.Doc;
  epoch: number;
  baseVersion: number;
  state: "idle" | "draining";
  animatingTargetVersion: number | null;
  /** Registered by the animation's driver; see `ForceCompleteAnimation`. */
  forceComplete?: ForceCompleteAnimation | undefined;
  connections: number;
  lastActiveAt: number;
  lastActorId: string;
  /** Bytes of the last snapshot we encoded — the memory-ceiling proxy. */
  snapshotBytes: number;
  dirty: boolean;
  observer?: (update: Uint8Array, origin: unknown) => void;
  debounce?: NodeJS.Timeout | undefined;
  maxWait?: NodeJS.Timeout | undefined;
  /** Serializes the row writes for this room. */
  writing: Promise<void>;
  /** Set once teardown starts; a join awaits it and then re-seeds. */
  drain?: Promise<void> | undefined;
}

/**
 * The epoch is milliseconds-since-epoch, bumped monotonically — NOT a counter
 * starting at 1.
 *
 * Teardown deletes the row, so a per-row counter restarts at 1 on the next
 * join; a client that reconnects after an idle teardown would then see the same
 * epoch it held, keep its stale Y.Doc, and merge it into a freshly seeded doc —
 * exactly the end-to-end body duplication the epoch exists to prevent. Wall
 * clock survives the row; `previous + 1` covers a clock that stepped backwards.
 */
function nextEpoch(previous: number | undefined, now: number): number {
  return Math.max((previous ?? 0) + 1, now);
}

export function createDocStore(opts: DocStoreOptions): DocStore {
  const records = opts.records ?? (opts.pool ? createSqlDocRecords(opts.pool) : undefined);
  if (!records) throw new Error("docStore: one of `pool` or `records` is required");
  const now = opts.now ?? ((): number => Date.now());
  const idleTtlMs = opts.idleTtlMs ?? ROOM_IDLE_TTL_MS;
  const memoryCeilingBytes = opts.memoryCeilingBytes ?? ROOM_MEMORY_CEILING_BYTES;
  const maxRooms = opts.maxRooms ?? MAX_ROOMS;
  const persistDebounceMs = opts.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
  const persistMaxMs = opts.persistMaxMs ?? PERSIST_MAX_MS;

  const rooms = new Map<string, LiveRoom>();
  /** In-flight joins, so two connections to one object share one seed. */
  const joining = new Map<string, Promise<JoinedRoom | null>>();
  let closed = false;

  const estimatedBytes = (): number => {
    let total = 0;
    for (const room of rooms.values()) total += room.snapshotBytes * ROOM_MEMORY_OVERHEAD;
    return total;
  };

  // ------------------------------------------------------------- persistence

  const snapshot = (room: LiveRoom): Uint8Array => {
    // COMPACTION. `encodeStateAsUpdate` of a gc:true doc is a full snapshot
    // with deleted content already collected — writing it to the single `blob`
    // column IS the log drop. Nothing in this module ever appends an update.
    const bytes = Y.encodeStateAsUpdate(room.doc);
    room.snapshotBytes = bytes.byteLength;
    return bytes;
  };

  /**
   * The state to persist for this room right now.
   *
   * `animating` OUTRANKS every settled state. A resume decides whether the blob
   * can be trusted from this column alone (`planSeed`), so writing `idle` or
   * `draining` over a room that is still mid-animation — a debounced persist, a
   * flush that landed anyway, a teardown whose force-completion failed — tells
   * the next process a half-applied blob is reconciled. That is the exact byte
   * loss the column exists to prevent, and it is one ternary to make impossible.
   */
  const stateFor = (room: LiveRoom, settled: CollabDocState): CollabDocState =>
    room.animatingTargetVersion === null ? settled : "animating";

  const rowOf = (room: LiveRoom, state: CollabDocState): CollabDocRow => ({
    objectId: room.objectId,
    blob: snapshot(room),
    epoch: room.epoch,
    lastFlushedVersion: room.baseVersion,
    state,
    animatingTargetVersion: room.animatingTargetVersion,
  });

  /**
   * Queue a row write behind this room's other row writes.
   *
   * `actor` is who the `collab_docs` upsert runs as. It defaults to the room's
   * last joiner — right for ordinary persistence — but teardown OVERRIDES it
   * with the visibility-retaining actor of the write that triggered the
   * eviction: `collab_docs`'s row predicate is the OBJECT's visibility (0053),
   * so a narrowing that dropped the last joiner would make an upsert as that
   * joiner fail RLS. The draining marker and the keep-blob fallback must land as
   * an actor who can still see the object, for the same reason the flush does.
   */
  const write = (
    room: LiveRoom,
    state: CollabDocState,
    actor: string = room.lastActorId,
  ): Promise<void> => {
    const next = room.writing.then(async () => {
      try {
        await records.save(actor, rowOf(room, state));
        room.dirty = false;
      } catch (err) {
        // A failed blob write costs durability of the last keystrokes, not the
        // room: the doc is still live in memory and the next persist retries.
        console.warn("collab: persisting room state failed —", String(err));
      }
    });
    room.writing = next;
    return next;
  };

  const clearTimers = (room: LiveRoom): void => {
    if (room.debounce) clearTimeout(room.debounce);
    if (room.maxWait) clearTimeout(room.maxWait);
    room.debounce = undefined;
    room.maxWait = undefined;
  };

  const schedulePersist = (room: LiveRoom): void => {
    if (room.state === "draining" || closed) return;
    if (room.debounce) clearTimeout(room.debounce);
    room.debounce = setTimeout(() => {
      room.debounce = undefined;
      if (room.maxWait) clearTimeout(room.maxWait);
      room.maxWait = undefined;
      void write(room, stateFor(room, "idle"));
    }, persistDebounceMs);
    room.debounce.unref?.();
    if (!room.maxWait) {
      room.maxWait = setTimeout(() => {
        room.maxWait = undefined;
        if (room.debounce) clearTimeout(room.debounce);
        room.debounce = undefined;
        void write(room, stateFor(room, "idle"));
      }, persistMaxMs);
      room.maxWait.unref?.();
    }
  };

  const observe = (room: LiveRoom): void => {
    const observer = (_update: Uint8Array, origin: unknown): void => {
      // A seed/re-seed is the database talking to itself: it must not mark the
      // room dirty (that would persist — and later flush — content that came
      // FROM the object body, on a document nobody touched).
      if (origin === SEED_ORIGIN) return;
      room.dirty = true;
      room.lastActiveAt = now();
      schedulePersist(room);
    };
    room.observer = observer;
    room.doc.on("update", observer);
  };

  const unobserve = (room: LiveRoom): void => {
    if (room.observer) room.doc.off("update", room.observer);
    room.observer = undefined;
  };

  // -------------------------------------------------------------------- join

  const seedRoom = async (
    objectId: string,
    actorId: string,
    object: ObjectSnapshot,
    row: CollabDocRow | null,
  ): Promise<{ room: LiveRoom; seeded: SeedOutcome; unmerged?: string }> => {
    const plan = planSeed(row, object);
    const body = object.body ?? "";
    const startedAt = now();

    const fresh = (
      seeded: SeedOutcome,
      unmerged?: string,
    ): { room: LiveRoom; seeded: SeedOutcome; unmerged?: string } => {
      const doc = seedDocFromMarkdown(body, { title: object.title });
      const room = newRoom(
        objectId,
        actorId,
        doc,
        nextEpoch(row?.epoch, startedAt),
        object.version,
      );
      return unmerged === undefined ? { room, seeded } : { room, seeded, unmerged };
    };

    if (plan.kind === "seed") return fresh("seed");
    if (plan.kind === "reseed") {
      const seeded: SeedOutcome =
        plan.reason === "animating"
          ? "reseed_animating"
          : plan.reason === "version_regressed"
            ? "reseed_version_regressed"
            : "reseed_blob_unreadable";
      return fresh(seeded);
    }

    if (plan.kind === "resume") {
      // The whole point of the rule: the persisted blob is reconciled to the
      // object's CURRENT version, so it is the object's content PLUS up to a
      // few seconds of keystrokes that were never flushed. Resuming keeps them
      // (and keeps the epoch — a reconnecting client may merge safely).
      const doc = new Y.Doc({ gc: true });
      try {
        Y.applyUpdate(doc, row!.blob, SEED_ORIGIN);
      } catch (err) {
        console.warn("collab: stored blob is unreadable — re-seeding from markdown", String(err));
        doc.destroy();
        return fresh("reseed_blob_unreadable");
      }
      const room = newRoom(objectId, actorId, doc, row!.epoch, row!.lastFlushedVersion);
      return { room, seeded: "resume" };
    }

    // ------------------------------------------------------------- rebase
    // An MCP/CAS write landed while this room was down. The object's markdown
    // is authoritative (it is an acknowledged write and it may have been read
    // by anyone), so it is what the room is re-seeded from; the blob's
    // unflushed delta is then re-applied on top through the same old→new diff
    // bridge the agent-write path uses.
    const blobDoc = new Y.Doc({ gc: true });
    let blobMd: string;
    try {
      Y.applyUpdate(blobDoc, row!.blob, SEED_ORIGIN);
      blobMd = docToMarkdown(blobDoc);
    } catch (err) {
      console.warn("collab: unreadable blob on rebase — re-seeding", String(err));
      blobDoc.destroy();
      return fresh("reseed_blob_unreadable");
    } finally {
      blobDoc.destroy();
    }

    const base = await records
      .baseBody(actorId, objectId, row!.lastFlushedVersion)
      .catch((err: unknown) => {
        console.warn("collab: base-body read failed —", String(err));
        return { kind: "unavailable" } as BaseBody;
      });

    const baseMd =
      base.kind === "exact"
        ? canonicalMarkdown(base.body)
        : base.kind === "unchanged"
          ? canonicalMarkdown(body)
          : null;

    const bridge = opts.applyMarkdownDiff;
    const seeded = fresh("rebase");
    if (baseMd === null || !bridge) {
      // Cannot merge. Do NOT guess: keep the authoritative markdown as the
      // room's content and hand the unmergeable text up as a conflict.
      return { room: seeded.room, seeded: "rebase_unmerged", unmerged: blobMd };
    }
    if (baseMd === blobMd) return { room: seeded.room, seeded: "rebase" }; // nothing unflushed

    const applied = bridge({
      doc: seeded.room.doc,
      from: baseMd,
      to: blobMd,
      title: object.title,
      origin: SEED_ORIGIN,
    });
    if (!applied) {
      return { room: seeded.room, seeded: "rebase_unmerged", unmerged: blobMd };
    }
    // The rebased doc is NOT reconciled to the object's version any more (it
    // carries the unflushed delta), but its CAS base is: the next flush writes
    // the merged text against the current version.
    seeded.room.dirty = true;
    return { room: seeded.room, seeded: "rebase" };
  };

  const newRoom = (
    objectId: string,
    actorId: string,
    doc: Y.Doc,
    epoch: number,
    baseVersion: number,
  ): LiveRoom => ({
    objectId,
    doc,
    epoch,
    baseVersion,
    state: "idle",
    animatingTargetVersion: null,
    connections: 0,
    lastActiveAt: now(),
    lastActorId: actorId,
    snapshotBytes: 0,
    dirty: false,
    writing: Promise.resolve(),
  });

  const joinOnce = async (objectId: string, actorId: string): Promise<JoinedRoom | null> => {
    // Bounded retry loop. The top-of-loop drain gate only covers the window
    // BEFORE the awaited RLS read below; a teardown can still begin DURING that
    // read (idle sweep, budget eviction, or a narrowing purge — none of which
    // pass through the per-object `joining` queue). Seeding into that window
    // builds a fresh room the in-flight `dropRoom` then deletes, orphaning the
    // connection: the flush pipeline and the bridge both look the room up by id,
    // find nothing, and every keystroke the joiner types is silently dropped. So
    // when we observe a teardown after the read, we wait it out and re-read the
    // post-flush markdown instead of seeding. The guard bounds the (convergent)
    // loop against a pathological teardown storm.
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = rooms.get(objectId);
      if (existing?.drain) {
        // Teardown is atomic and joins are serialized against it: WAIT for the
        // final flush, then seed from the post-flush markdown. Seeding now would
        // read pre-flush markdown, lose the tail of the previous session, and
        // then flush that loss back over it.
        await existing.drain.catch(() => undefined);
      }

      // EVERY joiner is read as ITSELF, including one attaching to a room somebody
      // else already opened. THE ROOM IS SHARED; THE AUTHORIZATION IS NOT. Reusing
      // the first joiner's read would let a second actor into a private object's
      // room — and presence in that room would then reveal to them that the object
      // exists, which is the one thing a room may never do. `records.load` is an
      // RLS-bound read AS this actor, so it fails closed by construction.
      const { object, row } = await records.load(actorId, objectId);
      // One answer for "cannot see it", "does not exist" and "is trashed".
      if (!object || object.deleted) return null;

      const live = rooms.get(objectId);
      if (live?.state === "draining") {
        // A teardown began WHILE we were reading — the drain gate above only
        // covers the pre-read window. Do NOT seed: the in-flight `dropRoom`
        // would delete the room we'd build (and `records.remove` could delete
        // the blob we'd just written), orphaning this connection. Wait the
        // teardown out (when it exposed a drain promise; the object-destroying
        // purge path sets `draining` without one, but then the next read returns
        // null) and re-loop to seed from the settled, post-flush markdown.
        if (live.drain) await live.drain.catch(() => undefined);
        continue;
      }
      if (live && live.state === "idle") {
        live.connections += 1;
        live.lastActiveAt = now();
        live.lastActorId = actorId;
        return {
          objectId,
          doc: live.doc,
          epoch: live.epoch,
          baseVersion: live.baseVersion,
          seeded: "resume",
        };
      }

      const { room, seeded, unmerged } = await seedRoom(objectId, actorId, object, row);
      room.connections = 1;
      room.lastActiveAt = now();
      rooms.set(objectId, room);
      observe(room);
      // Persist immediately so a restart between now and the first keystroke
      // resumes rather than re-seeds (a re-seed costs every open client its
      // local state through the epoch).
      await write(room, "idle");
      await enforceBudget(objectId);

      return {
        objectId,
        doc: room.doc,
        epoch: room.epoch,
        baseVersion: room.baseVersion,
        seeded,
        ...(unmerged === undefined ? {} : { unmerged }),
      };
    }
    // A teardown kept racing our read on every attempt (should never happen —
    // once we seed a connections>0 room the sweep and budget eviction both skip
    // it). Give up this join rather than spin; the client reconnects.
    console.warn(`collab: join for ${objectId} kept racing teardown — giving up`);
    return null;
  };

  /**
   * Joins for ONE object run one at a time, queued rather than shared.
   *
   * Queued, not shared, because a join is two things at once: a seed (which must
   * happen exactly once — two concurrent seeds would build two Y.Docs and one
   * would win `rooms.set`, silently discarding the other's clients) and an
   * AUTHORIZATION (which is per-actor and must never be inherited). Serializing
   * gives the first property without giving up the second: the second joiner
   * waits, then runs its own RLS-bound read and attaches to the room the first
   * one built.
   */
  const join = async (objectId: string, actorId: string): Promise<JoinedRoom | null> => {
    if (closed) return null;
    if (!actorId || !UUID_RE.test(objectId)) return null;
    const previous = joining.get(objectId) ?? Promise.resolve(null);
    const pending = previous.then(
      () => joinOnce(objectId, actorId),
      () => joinOnce(objectId, actorId),
    );
    // The queue tail never rejects; a failed join must not poison the next one.
    const tail = pending.catch((): JoinedRoom | null => null);
    joining.set(objectId, tail);
    try {
      return await pending;
    } finally {
      if (joining.get(objectId) === tail) joining.delete(objectId);
    }
  };

  // --------------------------------------------------------------- lifecycle

  const dropRoom = (room: LiveRoom, reason: CollabEvictReason): void => {
    clearTimers(room);
    unobserve(room);
    // Identity-guard the map deletion: delete the key ONLY when THIS room is
    // still the one mapped there. A blind `rooms.delete(objectId)` would evict a
    // REPLACEMENT room that a concurrent path installed at the same key while
    // this one drained — the mechanism that turns a join/teardown race into an
    // orphaned, connected-but-untracked room. With joinOnce now waiting drains
    // out this shouldn't arise, but the guard makes the deletion safe against
    // any future replacement path. When we did NOT own the mapping we also skip
    // `onEvict`: firing it signals "the object's room is gone" and would tear
    // down the live replacement's document.
    const owned = rooms.get(room.objectId) === room;
    if (owned) rooms.delete(room.objectId);
    // Destroy only THIS room's own Y.Doc — a replacement is a different LiveRoom
    // with a different doc, so this frees the retired doc without touching a live
    // replacement's state.
    room.doc.destroy();
    if (owned) opts.onEvict?.(room.objectId, reason);
  };

  /**
   * End an in-flight animation because the room is going away.
   *
   * On `teardown` the driver applies every hunk it has left in ONE transaction,
   * and the room then settles to the animation's TARGET version: the doc holds
   * exactly the write that produced it, so that is the version its content is
   * reconciled to, and the final flush is a no-op instead of a partial rewrite.
   *
   * If there is no driver, or the driver fails, the room stays `animating` —
   * every subsequent write of the row therefore says `animating` (`stateFor`),
   * the flush pipeline refuses to reconcile it, and a resume re-seeds from
   * markdown. The cost of that path is the keystrokes typed during the window;
   * the cost of the alternative is deleting half of an acknowledged agent
   * write, which is not a trade.
   */
  const completeAnimation = async (
    room: LiveRoom,
    reason: "teardown" | "cancel",
  ): Promise<void> => {
    const target = room.animatingTargetVersion;
    if (target === null) return;
    const complete = room.forceComplete;
    room.forceComplete = undefined;
    if (complete) {
      try {
        await complete(reason);
      } catch (err) {
        console.error("collab: force-completing an animation failed —", String(err));
        // A cancelled room's doc is destroyed either way, so there is no
        // half-applied blob left to protect against; a teardown keeps the mark.
        if (reason === "cancel") room.animatingTargetVersion = null;
        return;
      }
      if (room.animatingTargetVersion === null) return; // the driver settled it
      room.animatingTargetVersion = null;
      if (reason === "teardown" && target > room.baseVersion) room.baseVersion = target;
      return;
    }
    // Nobody registered a completer: the single-transaction fallback, or a
    // driver that died. Nothing to apply, so a teardown must keep the mark.
    if (reason === "cancel") room.animatingTargetVersion = null;
  };

  const teardown = async (
    objectId: string,
    reason: CollabEvictReason = "closing",
    // The actor the final flush and the row delete run as. Defaults to the
    // room's last editor (idle/closing/SIGTERM have no other candidate). The
    // access-narrowing eviction path (`purge`) overrides it with the actor of
    // the write that narrowed the object, which is guaranteed to still be able
    // to SEE the object — the flush's RLS-bound base read must succeed, or the
    // flush would silently no-op and the row would then be deleted with the
    // unflushed text never written.
    actorOverride?: string,
  ): Promise<void> => {
    const room = rooms.get(objectId);
    if (!room) return;
    if (room.drain) return room.drain;

    const actor = actorOverride ?? room.lastActorId;
    room.state = "draining";
    clearTimers(room);
    const drain = (async (): Promise<void> => {
      // A room torn down MID-ANIMATION applies everything it has left first, in
      // one transaction. The final flush must serialize the WHOLE agent write:
      // a prefix of it would be written over an `objects` row that already
      // holds all of it, deleting the rest of a write the agent was told
      // succeeded. This runs before the row write below so the state that
      // lands is the settled one whenever completion worked.
      await completeAnimation(room, "teardown");
      // Mark the row draining BEFORE the flush, so a process death between the
      // two is legible: the next join sees `draining` with a stale
      // last_flushed_version and rebases, rather than assuming a clean stop.
      // Still-animating rooms keep that mark instead (`stateFor`): a rebase off
      // a half-applied blob is exactly what must not happen. Written as `actor`,
      // not the room's last joiner: on a narrowing eviction the joiner may have
      // just lost visibility, and the `collab_docs` upsert would then fail RLS.
      await write(room, stateFor(room, "draining"), actor);
      let flushed = true;
      if (opts.flush) {
        try {
          await opts.flush({
            objectId,
            doc: room.doc,
            baseVersion: room.baseVersion,
            actorId: actor,
            reason: reason === "draining" ? "drain" : reason === "closing" ? "teardown" : "evict",
          });
        } catch (err) {
          flushed = false;
          console.error("collab: final flush failed —", String(err));
        }
      } else if (room.dirty) {
        // No flush hook wired: the blob is the only copy of the unflushed
        // text, so it must survive the teardown.
        flushed = false;
      }

      if (flushed) {
        // Purge on teardown (0053's stated lifecycle): the row is in-flight
        // state, and the object's markdown now holds everything it held.
        const removed = await records.remove(actor, objectId).catch((err: unknown) => {
          console.warn("collab: purging collab_docs row failed —", String(err));
          return false;
        });
        if (!removed) console.warn(`collab: no collab_docs row to purge for ${objectId}`);
      } else {
        // Keep the blob: it is the only remaining copy of text the object's
        // body does not have. The next join rebases it onto current markdown
        // — unless the room never left the animating window, in which case the
        // mark stays and the next join re-seeds instead. As `actor` (see the
        // draining write above): the last joiner may no longer pass the row's
        // RLS predicate, and losing this blob is losing the only copy.
        await write(room, stateFor(room, "idle"), actor);
      }
      dropRoom(room, reason);
    })();
    room.drain = drain;
    return drain;
  };

  const purge = async (
    objectId: string,
    reason: CollabEvictReason,
    actorId?: string,
  ): Promise<void> => {
    const room = rooms.get(objectId);

    // Does this reason leave the OBJECT in place? A visibility narrowing to
    // private and a dropped shared reader both KEEP the object — and with it
    // the still-authorized editors (the creator, any remaining shared readers)
    // whose unflushed body edits are legitimate content bound for
    // `objects.body`. Those MUST be flushed before the room is dropped, exactly
    // as an idle teardown does, or every open editor silently loses the text
    // typed since the last flush. The client cannot recover it either: on the
    // EVICTED close its `handleDown` records the unflushed text as its `acked`
    // baseline, so the reconnect's three-way reconcile sees local==base and
    // adopts the stale re-seed as authoritative — the lost paragraph never
    // comes back and no conflict is shown. So flush-then-drop for these
    // reasons. The flush runs as the TRIGGERING actor (`actorId`), who just
    // wrote the object and can therefore still see it — the flush's RLS-bound
    // base read must succeed or the flush no-ops silently and the row delete
    // below would drop the only copy of the unflushed text.
    //
    // A reason that DESTROYS the object ('deleted') keeps the no-flush path:
    // flushing there would resurrect content into a trashed object.
    const preservesObject = reason === "visibility_changed" || reason === "unshared";
    if (preservesObject && room && (opts.flush || room.dirty)) {
      return teardown(objectId, reason, actorId);
    }

    if (room) {
      // No flush: the object was trashed/deleted. Writing the CRDT back would
      // resurrect content into an object the user just deleted.
      room.state = "draining";
      clearTimers(room);
      // An animation in flight is CANCELLED, not completed: applying its
      // remaining hunks would push text into a doc this call is about to
      // destroy, on an object the user just trashed. The driver's timers have
      // to stop either way, or they fire into a destroyed doc.
      await completeAnimation(room, "cancel");
      dropRoom(room, reason);
    }
    // The actor of the WRITE that triggered the purge, when there is one: the
    // row is deleted under that actor's RLS like every other write on this box.
    // Falling back to the room's last actor covers an internal eviction; with
    // neither there is no actor to write as, and the object's own delete cascade
    // (0053's FK) covers the delete case.
    const writer = actorId ?? room?.lastActorId;
    if (!writer) return;
    await records.remove(writer, objectId).catch((err: unknown) => {
      // Never throw out of the write path that triggered this: a failed purge
      // leaves a disposable row behind, not a correctness problem — the row's
      // RLS predicate follows the object's visibility, so a narrowed object's
      // blob is already unreadable to everyone it was narrowed away from.
      console.warn("collab: purge failed —", String(err));
      return false;
    });
  };

  /** Evict the least-recently-active room, preferring ones nobody is in. */
  const evictOne = async (protectObjectId?: string): Promise<boolean> => {
    let victim: LiveRoom | undefined;
    for (const room of rooms.values()) {
      if (room.objectId === protectObjectId || room.state === "draining") continue;
      if (!victim) {
        victim = room;
        continue;
      }
      const better =
        (victim.connections > 0 && room.connections === 0) ||
        (victim.connections > 0 === room.connections > 0 &&
          room.lastActiveAt < victim.lastActiveAt);
      if (better) victim = room;
    }
    if (!victim) return false;
    await teardown(victim.objectId, "closing");
    return true;
  };

  const enforceBudget = async (protectObjectId?: string): Promise<void> => {
    let guard = rooms.size + 1;
    while (
      guard-- > 0 &&
      (rooms.size > maxRooms || estimatedBytes() > memoryCeilingBytes) &&
      (await evictOne(protectObjectId))
    ) {
      /* evict until under the ceiling, or until nothing is evictable */
    }
  };

  const sweep = async (): Promise<void> => {
    if (closed) return;
    const cutoff = now() - idleTtlMs;
    for (const room of [...rooms.values()]) {
      if (room.state === "draining") continue;
      if (room.connections === 0 && room.lastActiveAt <= cutoff) {
        await teardown(room.objectId, "closing").catch((err: unknown) => {
          console.warn("collab: idle teardown failed —", String(err));
        });
      }
    }
    await enforceBudget();
  };

  const sweepTimer = setInterval(() => {
    void sweep().catch((err: unknown) => console.warn("collab: sweep failed —", String(err)));
  }, opts.sweepMs ?? ROOM_SWEEP_MS);
  sweepTimer.unref?.();

  const drainAll = async (): Promise<void> => {
    await Promise.allSettled([...rooms.keys()].map((id) => teardown(id, "draining")));
  };

  return {
    join,
    leave: (objectId: string): void => {
      const room = rooms.get(objectId);
      if (!room) return;
      room.connections = Math.max(0, room.connections - 1);
      room.lastActiveAt = now();
    },
    touch: (objectId: string, actorId?: string): void => {
      const room = rooms.get(objectId);
      if (!room) return;
      room.lastActiveAt = now();
      if (actorId) room.lastActorId = actorId;
    },
    get: (objectId: string): RoomView | undefined => {
      const room = rooms.get(objectId);
      return room
        ? {
            objectId: room.objectId,
            doc: room.doc,
            epoch: room.epoch,
            baseVersion: room.baseVersion,
            state: room.state,
            connections: room.connections,
            lastActorId: room.lastActorId,
            animatingTargetVersion: room.animatingTargetVersion,
          }
        : undefined;
    },
    has: (objectId: string): boolean => rooms.has(objectId),
    get size(): number {
      return rooms.size;
    },
    persist: async (objectId: string): Promise<void> => {
      const room = rooms.get(objectId);
      if (!room) return;
      clearTimers(room);
      await write(room, stateFor(room, "idle"));
    },
    markFlushed: async (objectId: string, version: number): Promise<void> => {
      const room = rooms.get(objectId);
      if (!room) return;
      // Never backwards — same guard as endAnimating: versions only go up, and
      // a CAS base that regressed would make the next flush lose on purpose.
      // The caller this protects against is the bridge, whose ingest runs on a
      // RoomView snapshot: a flush cycle can commit v(N+1) and markFlushed it
      // inside the awaits of an ingest that read the object at vN, and the
      // ingest's trailing markFlushed(vN) must not roll the base back under
      // the committed row. The blob is still recompacted below either way.
      if (version > room.baseVersion) room.baseVersion = version;
      room.dirty = false;
      clearTimers(room);
      // Compaction on EVERY flush, not on a schedule: this rewrites `blob` with
      // a fresh snapshot, which is what drops both the accumulated log and the
      // text the author deleted since the last one.
      //
      // `stateFor`, not a literal `idle`: the bridge marks a room flushed when
      // it ingests an external write, and one arriving mid-animation must not
      // clear the mark — the blob being compacted here is still a prefix.
      await write(room, stateFor(room, "idle"));
    },
    setAnimating: async (
      objectId: string,
      targetVersion: number,
      forceComplete?: ForceCompleteAnimation,
    ): Promise<void> => {
      const room = rooms.get(objectId);
      if (!room) return;
      room.animatingTargetVersion = targetVersion;
      room.forceComplete = forceComplete;
      clearTimers(room);
      // Awaited by the caller BEFORE the first chunk (see the interface): the
      // row write is what makes a crash mid-animation legible.
      await write(room, "animating");
    },
    endAnimating: async (objectId: string, version?: number): Promise<void> => {
      const room = rooms.get(objectId);
      if (!room) return;
      const settled = version ?? room.animatingTargetVersion ?? room.baseVersion;
      room.animatingTargetVersion = null;
      room.forceComplete = undefined;
      // The doc now holds the whole write, so the target IS the version its
      // content is reconciled to. Never backwards: versions only go up, and a
      // CAS base that regressed would make the next flush lose on purpose.
      if (settled > room.baseVersion) room.baseVersion = settled;
      clearTimers(room);
      await write(room, "idle");
    },
    teardown,
    purge,
    sweep,
    drainAll,
    close: async (): Promise<void> => {
      closed = true;
      clearInterval(sweepTimer);
      await drainAll();
    },
    stats: (): { rooms: number; estimatedBytes: number } => ({
      rooms: rooms.size,
      estimatedBytes: estimatedBytes(),
    }),
  };
}

/* ========================================================================== *
 * The SQL implementation                                                      *
 * ========================================================================== */

/** bigint arrives from `pg` as a string; narrow it without inventing a value. */
function toNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toState(raw: unknown): CollabDocState {
  return raw === "draining" || raw === "animating" ? raw : "idle";
}

/**
 * Every statement runs in ONE transaction with a transaction-local
 * `app.actor_id` (the `true`), exactly like every other write on this box: RLS,
 * the audit trigger and attribution are all single-actor, and a session-level
 * GUC would leak this actor into the next borrower of a pooled connection.
 * `app.on_behalf_of` is cleared for the same reason the Reader clears it.
 */
async function asActor<T>(
  pool: Pool,
  actorId: string,
  fn: (c: PoolClient) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query(
      "SELECT set_config('app.actor_id', $1, true), set_config('app.on_behalf_of', '', true), set_config('statement_timeout', $2, true)",
      [actorId, String(STORE_TIMEOUT_MS)],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function createSqlDocRecords(pool: Pool): DocRecords {
  return {
    async load(actorId, objectId) {
      if (!UUID_RE.test(objectId)) return { object: null, row: null };
      return asActor(
        pool,
        actorId,
        async (c) => {
          const obj = await c.query<{
            version: string | number;
            title: string | null;
            body: string | null;
            deleted: boolean;
          }>(
            "SELECT version, title, body, (deleted_at IS NOT NULL) AS deleted FROM objects WHERE id = $1",
            [objectId],
          );
          const o = obj.rows[0];
          if (!o) return { object: null, row: null };
          const doc = await c.query<{
            blob: Buffer;
            epoch: string | number;
            last_flushed_version: string | number;
            state: string;
            animating_target_version: string | number | null;
          }>(
            `SELECT blob, epoch, last_flushed_version, state, animating_target_version
             FROM collab_docs WHERE object_id = $1`,
            [objectId],
          );
          const d = doc.rows[0];
          return {
            object: {
              version: toNumber(o.version, 0),
              title: o.title,
              body: o.body,
              deleted: o.deleted === true,
            },
            row: d
              ? {
                  objectId,
                  blob: new Uint8Array(d.blob),
                  epoch: toNumber(d.epoch, 1),
                  lastFlushedVersion: toNumber(d.last_flushed_version, -1),
                  state: toState(d.state),
                  animatingTargetVersion:
                    d.animating_target_version === null
                      ? null
                      : toNumber(d.animating_target_version, 0),
                }
              : null,
          };
        },
        true,
      );
    },

    async baseBody(actorId, objectId, version) {
      if (!UUID_RE.test(objectId)) return { kind: "unavailable" };
      try {
        return await asActor(
          pool,
          actorId,
          async (c) => {
            // The FIRST before-image at or after the flushed version is the
            // pre-image of the next spine change, i.e. the body as that flush
            // left it. No such row ⇒ no spine change since (a props-only edit
            // bumps `version` without writing one), so the CURRENT body is
            // still the base.
            const { rows } = await c.query<{ title: string | null; body: string | null }>(
              `SELECT snapshot->>'title' AS title, snapshot->>'body' AS body
               FROM before_image
               WHERE object_id = $1 AND version >= $2
               ORDER BY version ASC LIMIT 1`,
              [objectId, version],
            );
            const row = rows[0];
            if (!row) return { kind: "unchanged" } as BaseBody;
            return { kind: "exact", title: row.title, body: row.body ?? "" } as BaseBody;
          },
          true,
        );
      } catch (err) {
        console.warn("collab: before-image read failed —", String(err));
        return { kind: "unavailable" };
      }
    },

    async save(actorId, row) {
      await asActor(pool, actorId, async (c) => {
        // ONE row per object, always fully overwritten — the compaction
        // contract. There is no INSERT-append path here on purpose.
        await c.query(
          `INSERT INTO collab_docs
             (object_id, blob, epoch, last_flushed_version, state, animating_target_version, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (object_id) DO UPDATE SET
             blob = EXCLUDED.blob,
             epoch = EXCLUDED.epoch,
             last_flushed_version = EXCLUDED.last_flushed_version,
             state = EXCLUDED.state,
             animating_target_version = EXCLUDED.animating_target_version,
             updated_at = now()`,
          [
            row.objectId,
            Buffer.from(row.blob),
            row.epoch,
            row.lastFlushedVersion,
            row.state,
            row.animatingTargetVersion,
          ],
        );
      });
    },

    async remove(actorId, objectId) {
      if (!UUID_RE.test(objectId)) return false;
      return asActor(pool, actorId, async (c) => {
        const { rowCount } = await c.query("DELETE FROM collab_docs WHERE object_id = $1", [
          objectId,
        ]);
        return (rowCount ?? 0) > 0;
      });
    },
  };
}
