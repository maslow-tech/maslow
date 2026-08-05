import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import * as Y from "yjs";
import { isBrainError } from "@brain/shared";
import { VersionConflictError, type Writer } from "@brain/mcp-tools";
import { connectionMode, isActive, readScopes } from "./auth.js";
import type { ApplyMarkdownDiff, FlushTarget, ObjectSnapshot, RoomView } from "./docStore.js";
import {
  SEED_ORIGIN,
  canonicalMarkdown,
  docTitle,
  docToMarkdown,
  seedDocFromMarkdown,
} from "./serialize.js";

/**
 * The flush pipeline: CRDT → markdown → the SAME Writer core fn every other
 * write on this box goes through.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE WRITE, ONE ACTOR — SO A CO-EDITED FLUSH IS N WRITES.
 *
 * Every mutation on this box runs in one transaction with ONE
 * `set_config('app.actor_id', …, true)`. RLS, the audit trigger, and
 * version/history attribution are all single-actor; there is no such thing as a
 * multi-actor write. So "the actor is the flush's contributors" is not
 * implementable, and picking one contributor is actively wrong twice over: it
 * attributes other people's sentences to them in Timeline/History, and it
 * evaluates THEIR RLS and scopes against someone else's bytes — which is
 * exactly how a viewer's, or a since-revoked member's, characters would ride
 * into the brain on a valid member's actor.
 *
 * The flush therefore SPLITS: one transaction per contributor, in document
 * order, each carrying only the ranges that contributor authored. Yjs
 * attributes every insertion to a client id and the collab server binds client
 * ids to authenticated accounts at connect, so the attribution exists; this
 * module is what refuses to throw it away. Accepted consequence: a document two
 * people co-edited across one flush window produces two versions rather than
 * one. That is the correct trade — history that says who wrote what is the
 * point of having history.
 *
 * A contributor whose sub-write is REFUSED (demoted, revoked, RLS narrowed, a
 * read-only connection that somehow got an update through) has their ranges
 * REVERTED out of the live doc and their client evicted. Their text is never
 * persisted under someone else, and it is never silently kept in a doc that
 * everyone else's flushes then carry into the database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CAS FAILURE IS NEVER A BLIND RETRY.
 *
 * Re-serializing the in-memory CRDT against whatever version now exists is
 * last-write-wins with extra steps: it destroys every write the agent-write
 * bridge did not ingest — watcher lag or failure, a write from another process,
 * a restore-from-trash, a merge, an MCP write racing inside the poll interval.
 * On CAS failure this module re-reads the object, REBASES (diffs the current
 * markdown into the live doc through the same old→new bridge the agent-write
 * path uses, and onto every not-yet-written contributor snapshot), and only
 * then re-serializes and retries. If the rebase cannot apply cleanly it
 * surfaces a conflict to connected clients rather than writing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO MORE INVARIANTS THAT ARE CHEAP HERE AND EXPENSIVE ANYWHERE ELSE.
 *
 *  - EVERY flush write carries this room's ORIGIN TOKEN, so the bridge watcher
 *    drops its own events. Without it: the flush serializes S1 at 12:00:00, the
 *    user types on to S2, the flush's own feed event arrives at 12:00:02, and
 *    the bridge applies diff(old → S1) into a doc at S2 — re-inserting deleted
 *    text and re-deleting new text. At best jitter, at worst a stable echo loop
 *    that rewrites every open object forever.
 *  - A write is SKIPPED ENTIRELY when the serialized markdown is identical to
 *    the stored body's canonical spelling. An idle open document must produce
 *    zero version churn: no version, no history row, no audit event, no feed
 *    event for a document nobody touched. (Compared against
 *    `canonicalMarkdown(body)`, not the raw bytes — `docToMarkdown` always
 *    emits canonical markdown, so comparing raw would re-canonicalize, and
 *    version-bump, every object whose body an agent wrote by hand. And NOT
 *    against `normalizeMarkdown`, which canonicalizes blocks but not inline
 *    text: that mismatch made opening an object with a lone `~` in it write a
 *    version in the reader's name. See `canonicalMarkdown`.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FLUSHES ARE SUSPENDED WHILE AN AGENT WRITE ANIMATES IN (phase 5).
 *
 * The animated agent write is the one case where the live doc is KNOWN to hold
 * an incomplete document: the MCP write has already committed to `objects` and
 * returned success, and for up to ~1.2s the room holds only the hunks applied
 * so far. Reconciling in that window writes a PREFIX of the agent's write over
 * a row that already holds all of it — deleting the rest of a write the agent
 * was told succeeded. So while `RoomView.animatingTargetVersion` is set this
 * module writes nothing at all; see `suspend` for what it does instead.
 *
 * Design invariants: flush attribution is one write, one actor; a crash
 * mid-animation must not revert an acknowledged agent write.
 */

/* ========================================================================== *
 * Cadence                                                                     *
 * ========================================================================== */

/** ~3s after the last keystroke. */
export const FLUSH_IDLE_MS = 3_000;
/** …and at most 30s into a continuous burst, so a fast typist still lands. */
export const FLUSH_MAX_MS = 30_000;

/**
 * How many times ONE contributor's sub-write may lose the CAS and be rebased
 * before we stop and surface a conflict. Three, not "until it wins": a busy
 * object (several editors plus an agent) can starve a writer indefinitely, and
 * an endless rebase loop is a hot spin against the customer's database.
 */
const FLUSH_MAX_ATTEMPTS = 3;

/**
 * The transaction origin the flush uses for its OWN writes into a live doc
 * (rebases, and the revert of a refused contributor's ranges).
 *
 * It must be distinguishable from a user transaction, or the pipeline would
 * attribute its own rebase to whoever typed last and then flush the agent's
 * text back under their name.
 */
export const FLUSH_ORIGIN = "collab:flush";

/**
 * How long a torn-down room's origin token stays recognisable.
 *
 * The bridge watcher polls the event feed, so a flush that commits immediately
 * before teardown emits an event the watcher sees AFTER the room is gone.
 * Forgetting the token at teardown would make that event look external. It
 * cannot do harm (the watcher may only push a diff into a room that already
 * exists), but "my own write looks like someone else's" is precisely the class
 * of bug this token exists to remove, so the memory outlives the room.
 */
const TOKEN_GRACE_MS = 5 * 60_000;

/* ========================================================================== *
 * Seams                                                                       *
 * ========================================================================== */

/** Who is behind one Yjs transaction, resolved from its origin. */
export interface FlushContributor {
  readonly actorId: string;
  /**
   * Did the connection that produced this transaction hold `write` at the time?
   * A read-only connection's updates are already rejected upstream
   * (`beforeHandleMessage`/`onChange`); this is the flush's independent refusal
   * — "UX is not the security boundary" applies to the transport too.
   */
  readonly canWrite: boolean;
}

/**
 * Map a Yjs transaction origin to its author.
 *
 * Hocuspocus applies a client's update with the `Connection` as the transaction
 * origin, and the collab server holds the connection→principal binding, so the
 * server supplies this. Returning null means "I do not know who did this" —
 * which is NOT treated as a free pass: unattributed content is refused, never
 * written under a convenient actor. See `UNATTRIBUTED`.
 */
type ResolveContributor = (origin: unknown) => FlushContributor | null | undefined;

/** The room-facing slice of the doc store this module needs. */
export interface FlushRooms {
  /**
   * The live room. Its `animatingTargetVersion` is what suspends this module —
   * a room that reports one is holding a partial agent write.
   */
  get(objectId: string): RoomView | undefined;
  /** Records the flush AND compacts the blob — one call, both jobs. */
  markFlushed(objectId: string, version: number): Promise<void>;
}

/** One contributor's sub-write, as handed to the core write fn. */
export interface FlushWrite {
  readonly objectId: string;
  readonly actorId: string;
  /** The `objects.version` this content is reconciled to — the CAS base. */
  readonly baseVersion: number;
  readonly title: string | null;
  readonly body: string;
  /** This room's token, round-tripped through the audit event's reason. */
  readonly originToken: string;
}

/**
 * The outcome of one sub-write, as a value rather than an exception, because
 * the three failure modes are three DIFFERENT recoveries and collapsing them
 * into `catch` is how a refusal becomes a retry:
 *
 *  - `conflict` → re-read, rebase, retry (never a blind retry);
 *  - `refused`  → revert this contributor's ranges, evict their client;
 *  - `error`    → transient (database down, timeout). Keep the text, change
 *                 nothing, try again on the next cycle. A dropped connection
 *                 must never look like a revoked member.
 */
export type FlushWriteOutcome =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly kind: "conflict"; readonly currentVersion?: number }
  | { readonly ok: false; readonly kind: "refused"; readonly reason: string }
  | { readonly ok: false; readonly kind: "error"; readonly reason: string };

type WriteFlush = (write: FlushWrite) => Promise<FlushWriteOutcome>;

/** Is this account allowed to write RIGHT NOW — read from the database, always. */
type FlushAccessCheck = (actorId: string) => Promise<boolean>;

/** Why the room could not be reconciled; surfaced to connected clients. */
export type FlushConflictReason =
  "rebase_failed" | "cas_exhausted" | "unattributed" | "write_refused" | "object_gone";

export type FlushReason = "idle" | "burst" | "attach" | "manual" | "teardown" | "drain" | "evict";

interface FlushPipelineOptions {
  readonly rooms: FlushRooms;
  /** The core write fn — `createWriterFlushWrite(writer)` in production. */
  readonly write: WriteFlush;
  /** RLS-bound object read AS an actor (the doc store's `records.load` half). */
  readonly readObject: (
    actorId: string,
    objectId: string,
  ) => Promise<ObjectSnapshot | null | undefined>;
  /** Current scopes + status, from the database. `poolAccessCheck(pool)` in prod. */
  readonly canWrite: FlushAccessCheck;
  /** Which account is behind a transaction. Absent ⇒ everything is unattributed. */
  readonly resolveContributor?: ResolveContributor | undefined;
  /** The old→new markdown bridge. Absent ⇒ a rebase or a revert escalates. */
  readonly applyMarkdownDiff?: ApplyMarkdownDiff | undefined;
  /** Tell connected clients the room could not be reconciled. */
  readonly onConflict?: ((objectId: string, reason: FlushConflictReason) => void) | undefined;
  /** Drop ONE actor's connections to a room (a refused contributor). */
  readonly evictActor?: ((objectId: string, actorId: string, reason: string) => void) | undefined;
  readonly idleMs?: number | undefined;
  readonly maxMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface FlushPipeline {
  /**
   * Start attributing this room's transactions. Idempotent; `actorId` is the
   * joiner, kept as the fallback author for carry-over (see `takeRuns`).
   */
  attach(objectId: string, actorId: string): void;
  /** Stop attributing and forget the room's timers. Does NOT flush. */
  detach(objectId: string): void;
  /** This room's origin token, minted on attach. */
  originToken(objectId: string): string | undefined;
  /**
   * Refresh a room's cached stored-content base after the AGENT-WRITE BRIDGE
   * merged an external write into its live doc. The bridge applies that write
   * under `FLUSH_ORIGIN`, which the flush observer ignores — so without this the
   * cached `baseMd` stays at the pre-ingest text and the next idle/teardown
   * flush re-persists the agent's write as a redundant, FALSELY-ATTRIBUTED
   * version. Wired to the bridge's `onIngest` in `wire.ts`.
   */
  noteExternalWrite(objectId: string, body: string, title: string | null): void;
  /** Did WE write the audit event carrying this token? (the bridge's own gate) */
  isOwnFlush(token: string | null | undefined): boolean;
  /** Reconcile the room now. Serialized per room; safe to call concurrently. */
  flush(objectId: string, reason?: FlushReason): Promise<void>;
  /** The doc store's `flush` hook — teardown, eviction and SIGTERM drain. */
  readonly hook: (target: FlushTarget) => Promise<void>;
  /** Flush every attached room (drain). */
  flushAll(reason?: FlushReason): Promise<void>;
  /** Clear timers and detach everything. Does not flush — call `flushAll` first. */
  close(): void;
  readonly size: number;
}

/* ========================================================================== *
 * The production write fn                                                     *
 * ========================================================================== */

/**
 * The SAME core write every other mutation on this box goes through: no
 * parallel write logic, no second SQL path, so version bump + history snapshot
 * + audit event are byte-identical to an agent's write and Timeline shows human
 * edits with attribution for free.
 *
 * `editFields` CAS-guards on `baseVersion` — which for a flush IS the room's
 * `last_flushed_version` — and takes `originToken`, so the whole contract of
 * this module reduces to one call plus a careful error classification.
 *
 * ORDERING NOTE (accepted, and deliberately in the safe direction): the object
 * write commits first and `collab_docs.last_flushed_version` is updated after,
 * by `rooms.markFlushed`. Folding the row update into the Writer's transaction
 * would mean widening the Writer's public surface, which this task does not
 * own. The crash window between the two is self-healing: the row keeps the OLD
 * `last_flushed_version`, so the next join sees version drift and REBASES
 * (`planSeed`) instead of resuming — re-applying an already-persisted delta as
 * a no-op diff. The reverse ordering would not be safe, which is why it is not
 * the one used.
 */
export function createWriterFlushWrite(
  writer: Pick<Writer, "editFields">,
  opts: { readonly reason?: string } = {},
): WriteFlush {
  const reason = opts.reason ?? "live editor";
  return async (w: FlushWrite): Promise<FlushWriteOutcome> => {
    try {
      const result = await writer.editFields(
        // Scopes are re-read from the database by the pipeline before we get
        // here (`canWrite`); this is the Writer's own belt-and-braces gate.
        { actorId: w.actorId, scopes: ["write"] },
        w.objectId,
        {
          baseVersion: w.baseVersion,
          title: w.title,
          body: w.body,
          reason,
          originToken: w.originToken,
        },
      );
      return { ok: true, version: result.version };
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return { ok: false, kind: "conflict", currentVersion: err.currentVersion };
      }
      if (isBrainError(err)) {
        // `conflict` is the CAS; everything else the taxonomy can produce here
        // — not_found (trashed, or invisible to THIS actor), refused (scope,
        // budget, write-shed, creator-only), validation, schema — is a refusal
        // of this actor's content and must not be retried under anyone.
        if (err.code === "conflict") return { ok: false, kind: "conflict" };
        return { ok: false, kind: "refused", reason: `${err.code}: ${err.message}` };
      }
      // Anything else is infrastructure: a dead pool, a statement timeout, a
      // network blip. Never an eviction — the text stays in the doc and the
      // next cycle tries again.
      return { ok: false, kind: "error", reason: String(err) };
    }
  };
}

/**
 * The production `canWrite`: the account's CURRENT scopes and status, read
 * fresh from the database on every flush.
 *
 * Not the ticket's snapshot, not the connection's flag: a member demoted to
 * viewer, suspended, or revoked while their laptop sits open on a document must
 * not have the next flush cycle persist what they typed after the demotion.
 * Fail closed — an unreadable account is not a writable one.
 */
export function poolAccessCheck(pool: Pool): FlushAccessCheck {
  return async (actorId: string): Promise<boolean> => {
    try {
      const access = await readScopes(pool, actorId);
      return isActive(access) && connectionMode(access?.scopes ?? []) === "rw";
    } catch (err) {
      console.warn("collab: flush access check failed —", String(err));
      return false;
    }
  };
}

/* ========================================================================== *
 * Internals                                                                   *
 * ========================================================================== */

/**
 * The run key for a transaction nobody claims.
 *
 * Reachable two ways: a transaction whose origin the server does not recognise,
 * and a room attached before the server wired `resolveContributor`. Both are
 * bugs, and both are refused rather than written — an unattributed byte written
 * under a convenient actor is the exact failure the split exists to prevent.
 */
const UNATTRIBUTED = "\u0000unattributed";

/** One contributor's contiguous stretch of edits, with the doc state it ended at. */
interface FlushRun {
  /** null ⇒ unattributed (refused). */
  readonly actorId: string | null;
  readonly canWrite: boolean;
  /**
   * True for the SYNTHESIZED carry-over run: text a previous process persisted
   * to the blob but never flushed, attributed to the room's joiner as a fallback
   * (never a real contributor). If that joiner turns out not to be a writer this
   * must NOT be treated as a refused live edit — see `flushOnce`.
   */
  readonly carryOver?: boolean;
  /** Canonical markdown of the WHOLE body at the end of this run. */
  md: string;
  title: string | null;
}

interface OpenRun {
  readonly key: string;
  readonly actorId: string | null;
  readonly canWrite: boolean;
}

interface FlushRoom {
  readonly objectId: string;
  readonly doc: Y.Doc;
  readonly originToken: string;
  /** The joiner — the documented fallback author, used for carry-over only. */
  actorId: string;
  runs: FlushRun[];
  open: OpenRun | null;
  /**
   * The content the object is believed to hold right now, canonical. Undefined
   * until the first flush reads it: guessing it is how an idle room either
   * writes spuriously (guessing "different") or loses carry-over text (guessing
   * "same").
   */
  baseMd: string | undefined;
  baseTitle: string | null;
  dirty: boolean;
  debounce: NodeJS.Timeout | undefined;
  maxWait: NodeJS.Timeout | undefined;
  running: Promise<void> | null;
  again: boolean;
  /**
   * The strongest reason queued while a cycle ran. A teardown/evict flush that
   * queues behind an in-flight idle cycle must RE-RUN AS ITSELF: re-running as
   * "idle" computes `terminal === false`, so markFlushed compaction executes on
   * a narrowing eviction as the room's last joiner — exactly the actor the
   * narrowing may have just stripped — and the upsert trips 0053's RLS check.
   */
  againReason: FlushReason | undefined;
  beforeTx: ((tr: Y.Transaction) => void) | undefined;
  onUpdate: ((update: Uint8Array, origin: unknown) => void) | undefined;
}

/**
 * `beforeTransaction` is how a run BOUNDARY is caught at the only moment the
 * information exists: the doc still holds the previous contributor's final
 * state, and the incoming transaction's origin says a different one is about to
 * write. Afterwards the two are indistinguishable.
 *
 * Declared locally because yjs's `Doc` event map does not type this listener's
 * argument for us; the cast is confined to these two lines rather than smeared
 * across the module.
 */
interface TransactionEvents {
  on(event: "beforeTransaction", cb: (tr: Y.Transaction) => void): void;
  off(event: "beforeTransaction", cb: (tr: Y.Transaction) => void): void;
}

/** "" is not a title. Normalizing both sides is what keeps null==="" from churning. */
function normalizeTitle(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim() === "" ? null : raw!;
  return value;
}

/**
 * Which of two flush reasons must win a queued re-run. Ordered by how much is
 * at stake when the cycle runs as the WEAKER one: a terminal reason
 * (evict/teardown/drain) skips markFlushed compaction and timer re-arming,
 * both of which are wrong on a room that is about to be dropped.
 */
const REASON_RANK: Record<FlushReason, number> = {
  idle: 0,
  burst: 1,
  attach: 2,
  manual: 3,
  evict: 4,
  teardown: 5,
  drain: 6,
};

function strongerReason(a: FlushReason | undefined, b: FlushReason): FlushReason {
  if (a === undefined) return b;
  return REASON_RANK[a] >= REASON_RANK[b] ? a : b;
}

export function createFlushPipeline(opts: FlushPipelineOptions): FlushPipeline {
  const now = opts.now ?? ((): number => Date.now());
  const idleMs = opts.idleMs ?? FLUSH_IDLE_MS;
  const maxMs = opts.maxMs ?? FLUSH_MAX_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? FLUSH_MAX_ATTEMPTS);

  const rooms = new Map<string, FlushRoom>();
  /** token → the epoch ms after which it may be forgotten (undefined = live). */
  const tokens = new Map<string, number | undefined>();

  const conflict = (objectId: string, reason: FlushConflictReason): void => {
    console.warn(`collab: flush conflict on ${objectId} (${reason})`);
    opts.onConflict?.(objectId, reason);
  };

  const sweepTokens = (): void => {
    const cutoff = now();
    for (const [token, expires] of tokens) {
      if (expires !== undefined && expires <= cutoff) tokens.delete(token);
    }
  };

  // ------------------------------------------------------------------ timers

  const clearTimers = (room: FlushRoom): void => {
    if (room.debounce) clearTimeout(room.debounce);
    if (room.maxWait) clearTimeout(room.maxWait);
    room.debounce = undefined;
    room.maxWait = undefined;
  };

  const fire = (room: FlushRoom, reason: FlushReason): void => {
    clearTimers(room);
    void flush(room.objectId, reason).catch((err: unknown) => {
      console.warn(`collab: flush of ${room.objectId} failed —`, String(err));
    });
  };

  /** ~3s idle, and no later than 30s into a continuous burst. */
  const schedule = (room: FlushRoom): void => {
    if (room.debounce) clearTimeout(room.debounce);
    room.debounce = setTimeout(() => {
      room.debounce = undefined;
      fire(room, "idle");
    }, idleMs);
    room.debounce.unref?.();
    if (!room.maxWait) {
      room.maxWait = setTimeout(() => {
        room.maxWait = undefined;
        fire(room, "burst");
      }, maxMs);
      room.maxWait.unref?.();
    }
  };

  // ------------------------------------------------------------- attribution

  const closeRun = (room: FlushRoom): void => {
    const open = room.open;
    room.open = null;
    if (!open) return;
    room.runs.push({
      actorId: open.actorId,
      canWrite: open.canWrite,
      md: docToMarkdown(room.doc),
      title: normalizeTitle(docTitle(room.doc)),
    });
  };

  const observe = (room: FlushRoom): void => {
    const beforeTx = (tr: Y.Transaction): void => {
      const origin = tr.origin;
      // A seed and our own rebase/revert are the database talking to itself.
      // Counting them as contributions would attribute an agent's text to
      // whoever typed last, and then flush it back under their name.
      if (origin === SEED_ORIGIN || origin === FLUSH_ORIGIN) return;
      const who = opts.resolveContributor?.(origin) ?? null;
      const key = who ? who.actorId : UNATTRIBUTED;
      if (room.open && room.open.key !== key) closeRun(room);
      if (!room.open) {
        room.open = { key, actorId: who?.actorId ?? null, canWrite: who?.canWrite === true };
      }
    };
    const onUpdate = (_update: Uint8Array, origin: unknown): void => {
      if (origin === SEED_ORIGIN || origin === FLUSH_ORIGIN) return;
      room.dirty = true;
      schedule(room);
    };
    (room.doc as unknown as TransactionEvents).on("beforeTransaction", beforeTx);
    room.doc.on("update", onUpdate);
    room.beforeTx = beforeTx;
    room.onUpdate = onUpdate;
  };

  const unobserve = (room: FlushRoom): void => {
    if (room.beforeTx)
      (room.doc as unknown as TransactionEvents).off("beforeTransaction", room.beforeTx);
    if (room.onUpdate) room.doc.off("update", room.onUpdate);
    room.beforeTx = undefined;
    room.onUpdate = undefined;
  };

  /**
   * Close the open run and hand back everything pending, oldest first.
   *
   * CARRY-OVER. A room resumed from a `collab_docs` blob, or rebased onto one,
   * already holds text that was never flushed — typed in a PREVIOUS process, by
   * clients whose id→account binding died with it. There is no contributor left
   * to attribute it to, and the alternative to a fallback is deleting someone's
   * paragraph. So it is written under the room's joiner (`FlushTarget.actorId`,
   * which the doc store already labels "the attribution fallback, not the
   * rule") — evaluated, like every other sub-write, under THAT actor's own RLS
   * and scopes, so the fallback can never widen what a person may write.
   *
   * It is emitted as its OWN leading run, before any live contribution, which
   * is why `attach` schedules an immediate flush: on a freshly seeded room the
   * result is byte-identical and costs nothing, and on a resumed one the
   * carry-over lands before anyone can type on top of it and inherit it.
   */
  const takeRuns = (room: FlushRoom): FlushRun[] => {
    closeRun(room);
    const runs = room.runs;
    room.runs = [];
    if (runs.length === 0 && room.baseMd !== undefined) {
      const md = docToMarkdown(room.doc);
      const title = normalizeTitle(docTitle(room.doc));
      if (md !== room.baseMd || title !== room.baseTitle) {
        return [{ actorId: room.actorId, canWrite: true, carryOver: true, md, title }];
      }
    }
    return runs;
  };

  // ----------------------------------------------------------------- rebase

  /**
   * Apply an external write (old → new markdown) into a doc through the SAME
   * bridge the agent-write path uses. Returns false when it cannot be applied
   * cleanly — the caller must then escalate, never guess.
   */
  const applyDiff = (doc: Y.Doc, from: string, to: string, title: string | null): boolean => {
    const bridge = opts.applyMarkdownDiff;
    if (!bridge) return false;
    try {
      return bridge({ doc, from, to, title, origin: FLUSH_ORIGIN });
    } catch (err) {
      console.warn("collab: markdown diff bridge threw —", String(err));
      return false;
    }
  };

  /** Rebase one pending snapshot onto a new base, via a throwaway doc. */
  const rebaseSnapshot = (
    run: FlushRun,
    from: string,
    to: string,
    title: string | null,
  ): boolean => {
    const tmp = seedDocFromMarkdown(run.md, { title: run.title });
    try {
      if (!applyDiff(tmp, from, to, title)) return false;
      run.md = docToMarkdown(tmp);
      run.title = normalizeTitle(docTitle(tmp));
      return true;
    } finally {
      tmp.destroy();
    }
  };

  // ---------------------------------------------------------------- refusal

  /**
   * A contributor's sub-write was refused. Their ranges come OUT of the live
   * doc and their client is evicted.
   *
   * The revert takes the doc back to the last state we actually persisted,
   * which also unwinds anything typed on top of the refused text inside the
   * same window. That is not collateral damage to be avoided: those edits are
   * causally built on bytes the database refused, they cannot be separated from
   * them by any CRDT operation, and the alternative is persisting refused
   * content under whoever typed next. Clients see the revert live and can
   * retype; nobody's name ends up on somebody else's sentence.
   *
   * With no bridge wired the doc cannot be reverted at all — then the whole
   * room is escalated (conflict + eviction) rather than left holding content
   * the next cycle would try to write again.
   */
  const refuse = (
    room: FlushRoom,
    run: FlushRun,
    baseMd: string,
    baseTitle: string | null,
    why: string,
  ): void => {
    const liveMd = docToMarkdown(room.doc);
    const reverted = liveMd === baseMd || applyDiff(room.doc, liveMd, baseMd, baseTitle);
    if (run.actorId) {
      console.warn(`collab: flush refused for ${run.actorId} on ${room.objectId} — ${why}`);
      opts.evictActor?.(room.objectId, run.actorId, why);
    } else {
      console.warn(`collab: unattributed content on ${room.objectId} — refusing to persist it`);
    }
    // Everything still queued sat on top of the refused text; it went out with
    // the revert, so it must not be written.
    room.runs = [];
    room.open = null;
    if (!reverted) conflict(room.objectId, run.actorId ? "write_refused" : "unattributed");
  };

  // -------------------------------------------------------------- suspension

  /**
   * The room is mid-animation: reconcile NOTHING.
   *
   * Two different situations, and they end differently:
   *
   *  - An ordinary cycle (idle, burst, attach, manual) just defers. The room's
   *    BASE is dropped on the way out, because it describes the document as it
   *    was BEFORE the agent write and the object row has moved on: keeping it
   *    would make the next cycle read the animated text as a local contribution
   *    and write it back — a version, a history row and an audit event, in
   *    somebody's name, for text the agent already committed. Undefined instead
   *    means the next cycle re-reads the object and compares against what is
   *    actually stored, which is zero churn. Anything a HUMAN typed during the
   *    window is untouched: it lives in `room.runs`, attributed, and lands on
   *    top of the agent's write on the next cycle.
   *
   *  - A teardown/drain/evict cycle is the room's last, so there is nothing to
   *    defer to. It writes nothing either — the doc store force-completes an
   *    animation before its final flush, so reaching here means completion was
   *    impossible (no driver, or the driver failed) and the doc is a prefix.
   *    `objects` already holds the whole agent write and `collab_docs` keeps
   *    its `animating` mark, so the cost is the keystrokes typed during the
   *    window; the cost of writing would be half of an acknowledged write.
   */
  const suspend = (room: FlushRoom, reason: FlushReason): void => {
    if (reason === "teardown" || reason === "drain" || reason === "evict") {
      console.warn(
        `collab: ${room.objectId} is still animating at ${reason} — not reconciling a partial doc`,
      );
      return;
    }
    room.baseMd = undefined;
    room.baseTitle = null;
    room.dirty = true;
    schedule(room);
  };

  // ------------------------------------------------------------------ flush

  const flushOnce = async (room: FlushRoom, reason: FlushReason): Promise<void> => {
    const view = opts.rooms.get(room.objectId);
    if (!view) return; // the room is gone; nothing to reconcile it against

    // SUSPENDED. Not a "skip this cycle" optimisation — the one state in which
    // the doc is known to be an incomplete document (see the header).
    if (view.animatingTargetVersion !== null) {
      suspend(room, reason);
      return;
    }

    // The CAS base is the doc store's, not ours: it owns `last_flushed_version`
    // and moves it on markFlushed/endAnimating.
    let baseVersion = view.baseVersion;

    if (room.baseMd === undefined) {
      // Never guess the stored content. An RLS-bound read as the room's actor
      // is the only source; a failure defers the whole cycle rather than
      // inventing a base to diff against.
      const object = await opts
        .readObject(room.actorId, room.objectId)
        .catch((err: unknown): null => {
          console.warn("collab: flush base read failed —", String(err));
          return null;
        });
      if (!object) {
        room.dirty = true;
        return;
      }
      if (object.deleted) {
        conflict(room.objectId, "object_gone");
        return;
      }
      room.baseMd = canonicalMarkdown(object.body ?? "");
      room.baseTitle = normalizeTitle(object.title);
      baseVersion = object.version;
    }

    const runs = takeRuns(room);
    if (runs.length === 0) {
      room.dirty = false;
      return;
    }

    let prevMd = room.baseMd;
    let prevTitle = room.baseTitle;
    let wrote = false;
    /** Why the cycle stopped early, if it did — the three are three recoveries. */
    let halted: "refused" | "transient" | "exhausted" | null = null;

    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i]!;

      // ZERO CHURN. A run that changed nothing the serializer can see — a
      // formatting no-op, a cursor move, text typed and deleted again — writes
      // nothing at all. No version, no history row, no audit event.
      if (run.md === prevMd && run.title === prevTitle) continue;

      if (!run.actorId || !run.canWrite) {
        refuse(
          room,
          run,
          prevMd,
          prevTitle,
          run.actorId ? "connection had no write scope" : "no attributable author",
        );
        halted = "refused";
        break;
      }
      // The account's CURRENT rights, read from the database — not the ticket's
      // snapshot and not the connection's flag.
      const allowed = await opts.canWrite(run.actorId).catch((): boolean => false);
      if (!allowed) {
        if (run.carryOver) {
          // ORPHANED CARRY-OVER, not a refused live contributor. This is text a
          // previous process persisted to the blob, whose author is gone; the
          // fallback attribution landed on the room's FIRST joiner, who may be a
          // mere VIEWER (a legal read-only join). Reverting it would DELETE a
          // departed writer's unflushed paragraphs, and evicting would boot an
          // innocent viewer who only opened the doc. So do neither: leave the
          // carry-over intact in the doc for a subsequent writer to flush (or to
          // inherit by editing on top of it — `takeRuns` regenerates it each
          // cycle from the doc), and end this cycle without a refusal.
          console.warn(
            `collab: carry-over on ${room.objectId} cannot be flushed by fallback actor ` +
              `${run.actorId} (not a writer) — leaving it intact for a writer`,
          );
          room.runs = [];
          room.open = null;
          halted = "refused"; // "stop the cycle, wrote nothing" — but NOTHING was reverted
          break;
        }
        refuse(room, run, prevMd, prevTitle, "account is not an active writer");
        halted = "refused";
        break;
      }

      let committed = false;
      for (let attempt = 0; attempt < maxAttempts && !committed; attempt += 1) {
        const outcome = await opts.write({
          objectId: room.objectId,
          actorId: run.actorId,
          baseVersion,
          title: run.title,
          body: run.md,
          originToken: room.originToken,
        });

        if (outcome.ok) {
          baseVersion = outcome.version;
          prevMd = run.md;
          prevTitle = run.title;
          wrote = true;
          committed = true;
          break;
        }

        if (outcome.kind === "refused") {
          refuse(room, run, prevMd, prevTitle, outcome.reason);
          halted = "refused";
          break;
        }

        if (outcome.kind === "error") {
          // Transient. Put back everything not yet written, keep the base where
          // it is, and let the next cycle retry. NOTHING is reverted and nobody
          // is evicted: a database hiccup is not a revoked member.
          console.warn(`collab: flush write errored on ${room.objectId} —`, outcome.reason);
          room.runs = [...runs.slice(i), ...room.runs];
          room.dirty = true;
          halted = "transient";
          break;
        }

        // ---- CAS conflict: re-read, REBASE, then retry ---------------------
        // Never re-serialize against the new version and hope. Whatever landed
        // between our base and now is an acknowledged write that somebody may
        // already have read.
        const object = await opts
          .readObject(run.actorId, room.objectId)
          .catch((err: unknown): null => {
            console.warn("collab: flush re-read failed —", String(err));
            return null;
          });
        if (!object) {
          // Gone, trashed, or no longer visible to this actor. Do not write.
          conflict(room.objectId, "object_gone");
          room.runs = [];
          room.open = null;
          return;
        }
        if (object.deleted) {
          conflict(room.objectId, "object_gone");
          room.runs = [];
          room.open = null;
          return;
        }

        const currentMd = canonicalMarkdown(object.body ?? "");
        const currentTitle = normalizeTitle(object.title);
        baseVersion = object.version;

        if (currentMd === prevMd && currentTitle === prevTitle) {
          // The version moved but the CONTENT did not: a props, link or
          // visibility edit. There is nothing to rebase onto — retry against
          // the new version with the same bytes.
          continue;
        }

        // A real external content change. Bring the LIVE room to it first, so
        // open editors see the agent's write instead of silently losing it…
        if (!applyDiff(room.doc, prevMd, currentMd, currentTitle)) {
          conflict(room.objectId, "rebase_failed");
          room.runs = [];
          room.open = null;
          return;
        }
        // …then rebase this run and every run still queued behind it, so each
        // contributor's sub-write carries their ranges ON TOP of the new base
        // rather than reverting it.
        let rebased = true;
        for (const pending of runs.slice(i)) {
          if (!rebaseSnapshot(pending, prevMd, currentMd, currentTitle)) {
            rebased = false;
            break;
          }
        }
        if (!rebased) {
          conflict(room.objectId, "rebase_failed");
          room.runs = [];
          room.open = null;
          return;
        }
        prevMd = currentMd;
        prevTitle = currentTitle;
      }

      if (!committed) {
        if (halted === null) {
          // Attempts exhausted (not refused, not transient): a busy object —
          // several editors plus an agent — starved this writer. Say so and
          // put the text back, rather than spinning against the database.
          halted = "exhausted";
          room.runs = [...runs.slice(i), ...room.runs];
          conflict(room.objectId, "cas_exhausted");
        }
        break;
      }
    }

    room.baseMd = prevMd;
    room.baseTitle = prevTitle;
    // On a TERMINAL cycle the doc store drops the room and DELETES its
    // `collab_docs` row the instant this returns, so the compaction below is
    // wasted work — and on a narrowing eviction it is worse than wasted: the
    // store would write the compacted row as the room's last joiner, who may be
    // exactly the member the narrowing just shorn of visibility, and trip the
    // row's RLS predicate (the object's visibility, 0053). The object write
    // above already carries the text; the row is about to vanish. So compact
    // only on a cycle the room survives.
    const terminal = reason === "teardown" || reason === "drain" || reason === "evict";
    if (wrote && !terminal) {
      // Records the flush AND compacts the blob to a snapshot — which is what
      // drops both the accumulated update log and the text the author deleted.
      await opts.rooms.markFlushed(room.objectId, baseVersion).catch((err: unknown) => {
        console.warn("collab: markFlushed failed —", String(err));
      });
    }
    room.dirty = room.runs.length > 0;
    // A drain/teardown is the last cycle this room gets; re-arming a timer
    // there would keep the process alive past the stop grace for nothing.
    if (reason !== "teardown" && reason !== "drain" && room.runs.length > 0) schedule(room);
  };

  /** One flush at a time per room; a request during one re-arms it after. */
  const flush = async (objectId: string, reason: FlushReason = "manual"): Promise<void> => {
    const room = rooms.get(objectId);
    if (!room) return;
    if (room.running) {
      room.again = true;
      // The re-run must carry the STRONGEST queued reason, not the original
      // cycle's: a teardown that queues behind an idle cycle re-running as
      // "idle" would compact-and-markFlushed a room the store is about to
      // drop — as an actor a narrowing eviction may have just stripped.
      room.againReason = strongerReason(room.againReason, reason);
      await room.running;
      return;
    }
    clearTimers(room);
    const running = (async (): Promise<void> => {
      try {
        await flushOnce(room, reason);
        // A flush requested WHILE one ran is re-run once it finishes, not
        // dropped and not run concurrently: two cycles against one room would
        // race on the same CAS base and the loser would rebase over the winner.
        // Bounded, so a room that dirties itself on every cycle cannot spin.
        for (let extra = 0; room.again && extra < 2; extra += 1) {
          room.again = false;
          const rerunReason = room.againReason ?? reason;
          room.againReason = undefined;
          await flushOnce(room, rerunReason);
        }
      } finally {
        room.again = false;
        room.againReason = undefined;
        room.running = null;
      }
    })();
    room.running = running;
    await running;
  };

  // --------------------------------------------------------------- lifecycle

  const attach = (objectId: string, actorId: string): void => {
    const existing = rooms.get(objectId);
    const view = opts.rooms.get(objectId);
    if (!view) return;
    if (existing) {
      if (existing.doc === view.doc) {
        // A second joiner. Do NOT reset the base or the pending runs.
        existing.actorId = actorId;
        return;
      }
      // The doc store re-seeded (a new epoch): the old doc is dead and its
      // pending runs describe a document that no longer exists.
      unobserve(existing);
      clearTimers(existing);
      rooms.delete(objectId);
      tokens.set(existing.originToken, now() + TOKEN_GRACE_MS);
    }
    const room: FlushRoom = {
      objectId,
      doc: view.doc,
      originToken: randomBytes(8).toString("hex"),
      actorId,
      runs: [],
      open: null,
      baseMd: undefined,
      baseTitle: null,
      dirty: false,
      debounce: undefined,
      maxWait: undefined,
      running: null,
      again: false,
      againReason: undefined,
      beforeTx: undefined,
      onUpdate: undefined,
    };
    rooms.set(objectId, room);
    tokens.set(room.originToken, undefined);
    sweepTokens();
    observe(room);
    // Resolve the base (and land any carry-over) before anyone can type on top
    // of it. A freshly seeded room is byte-identical here and writes nothing.
    fire(room, "attach");
  };

  const detach = (objectId: string): void => {
    const room = rooms.get(objectId);
    if (!room) return;
    unobserve(room);
    clearTimers(room);
    rooms.delete(objectId);
    tokens.set(room.originToken, now() + TOKEN_GRACE_MS);
    sweepTokens();
  };

  /**
   * The bridge just ingested an external write into this room's live doc and
   * advanced the doc store's CAS base; bring our cached content base to the
   * newly-stored text so an otherwise-idle flush is a genuine no-op.
   *
   * Only acts when a base is already cached: with `baseMd` undefined the next
   * flush re-reads the object fresh (which now holds the agent's write), so
   * there is nothing stale to correct — and blindly seeding a base here could
   * mask genuine carry-over the fresh read is meant to surface.
   */
  const noteExternalWrite = (objectId: string, body: string, title: string | null): void => {
    const room = rooms.get(objectId);
    if (!room || room.baseMd === undefined) return;
    const from = room.baseMd;
    const fromTitle = room.baseTitle;
    const to = canonicalMarkdown(body);
    const toTitle = normalizeTitle(title);

    // REBASE THE QUEUED RUNS TOO — exactly as the CAS-conflict path does.
    // A CLOSED run's `md` is a full-body snapshot serialized at close time,
    // i.e. WITHOUT the content the bridge just merged into the live doc.
    // Advancing only the base would make the next flush write that stale
    // snapshot wholesale at the NEW base version — a clean CAS that deletes
    // the agent's acknowledged paragraph in the closing contributor's name
    // (and, if a later run is refused, `refuse()` reverts the live doc to that
    // stale state, durably reverting the ingested write from both `objects`
    // and the room — the exact failure the module header forbids). The OPEN
    // run needs nothing: its snapshot is serialized later, from the live doc,
    // which already holds the ingested content.
    if (from !== to || fromTitle !== toTitle) {
      let rebased = true;
      for (const pending of room.runs) {
        if (!rebaseSnapshot(pending, from, to, toTitle)) {
          rebased = false;
          break;
        }
      }
      if (!rebased) {
        // A stale run that cannot be carried onto the new base must not be
        // written. Escalate exactly as the CAS path does: the text still lives
        // in the live doc, so the next cycle regenerates it as a carry-over.
        conflict(room.objectId, "rebase_failed");
        room.runs = [];
        room.open = null;
      }
    }

    room.baseMd = to;
    room.baseTitle = toTitle;
  };

  const hook = async (target: FlushTarget): Promise<void> => {
    // The doc store calls this on teardown, eviction and SIGTERM drain. A room
    // it knows about that we do not is one nobody attached — attach it now so
    // its text is not dropped on the floor.
    if (!rooms.has(target.objectId)) attach(target.objectId, target.actorId);
    const room = rooms.get(target.objectId);
    if (room) room.actorId = target.actorId;
    await flush(target.objectId, target.reason);
    if (target.reason === "teardown" || target.reason === "evict") detach(target.objectId);
  };

  return {
    attach,
    detach,
    originToken: (objectId: string): string | undefined => rooms.get(objectId)?.originToken,
    noteExternalWrite,
    isOwnFlush: (token: string | null | undefined): boolean => {
      if (!token) return false;
      sweepTokens();
      return tokens.has(token);
    },
    flush,
    hook,
    flushAll: async (reason: FlushReason = "drain"): Promise<void> => {
      await Promise.allSettled([...rooms.keys()].map((id) => flush(id, reason)));
    },
    close: (): void => {
      for (const room of [...rooms.values()]) {
        unobserve(room);
        clearTimers(room);
      }
      rooms.clear();
    },
    get size(): number {
      return rooms.size;
    },
  };
}
