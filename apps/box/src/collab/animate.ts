/**
 * THE CHUNK SCHEDULER: how an agent write is PERFORMED, never how it lands.
 *
 * Phase 2 applies an external write as one Yjs transaction and the text simply
 * appears. Phase 5 makes the agent a collaborator you can watch: the same total
 * edit, cut into a short sequence of transactions on a timer, each one preceded
 * by an awareness update that moves the agent's cursor/selection onto the range
 * it is about to touch. Remote peers see the named robot cursor travel through
 * the document, inserting and deleting as it goes.
 *
 * This module does the arithmetic and nothing else — no Yjs, no timers, no
 * awareness, no I/O. It answers one question: given these hunks and this room,
 * WHICH hunks go in which chunk, WHERE does the cursor sit for each, and HOW
 * far apart do they run. Everything that can be got wrong here is arithmetic,
 * so it is arithmetic in a pure function with unit tests rather than arithmetic
 * smeared through a driver that needs a live room to exercise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DURATION CAP IS THE POINT
 *
 * The naive scheduler is "one chunk per hunk, 60ms apart", and it is a bug the
 * first time an agent rewrites a document: 400 hunks × 60ms is twenty-four
 * seconds of a document visibly rearranging itself, twenty-four seconds during
 * which the room's flushes are suspended (the `animating` state exists so a
 * crash mid-animation cannot revert an acknowledged write) and twenty-four
 * seconds in which a human is watching text move rather than typing.
 *
 * So the cap is on the TOTAL, not on the step: the number of chunks is bounded
 * first (`ANIMATION_TOTAL_CAP_MS / ANIMATION_MIN_GAP_MS` steps is all a 1.2s
 * budget buys at the fastest legible rate), and hunks are merged into those
 * chunks as needed. A 3-hunk edit gets 3 chunks at a leisurely 90ms; a 400-hunk
 * rewrite gets 31 chunks of ~13 hunks each and still finishes in 1.2s. The
 * cursor still travels — it just takes bigger strides.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO FAST PATHS, AND WHY BOTH COLLAPSE TO ONE CHUNK
 *
 *  - `prefersReducedMotion`, signalled by the room's connected clients. Motion
 *    a viewer has asked their operating system not to show them is not a
 *    feature; it is an accessibility defect with a nice name.
 *  - zero live human viewers. Nobody is watching, so the performance has no
 *    audience — and paying for it anyway means holding the room in `animating`,
 *    with flushes suspended, to entertain no one.
 *
 * Both return exactly one chunk holding every hunk, i.e. the phase-2 behaviour:
 * one transaction, no timer. THE ANIMATION IS A PRESENTATION OF THE WRITE AND
 * NEVER A PRECONDITION FOR IT — every path through this module produces a plan
 * whose chunks, concatenated, are the input diff exactly. Dropping a hunk to
 * make the budget, or duplicating one across two chunks, would corrupt a write
 * the agent has already been told succeeded; the unit tests assert the union
 * property directly for that reason.
 *
 * Design invariant: the diff animates as a moving cursor.
 */

import type { PresencePosition } from "./presence.js";

/* ========================================================================== *
 * Timing                                                                      *
 * ========================================================================== */

/**
 * The fastest two chunks may be apart. Below this the cursor reads as a flicker
 * rather than as somebody typing, and every step still costs a transaction and
 * an awareness broadcast to every peer.
 */
export const ANIMATION_MIN_GAP_MS = 40;

/** The slowest. Beyond this a short edit feels like the box is thinking. */
export const ANIMATION_MAX_GAP_MS = 90;

/**
 * The whole animation, first chunk to last, whatever the hunk count. The room's
 * flushes are suspended for this window, so it is a latency budget as much as a
 * motion one.
 */
export const ANIMATION_TOTAL_CAP_MS = 1_200;

export interface AnimationTiming {
  readonly minGapMs: number;
  readonly maxGapMs: number;
  readonly totalCapMs: number;
}

const DEFAULT_ANIMATION_TIMING: AnimationTiming = {
  minGapMs: ANIMATION_MIN_GAP_MS,
  maxGapMs: ANIMATION_MAX_GAP_MS,
  totalCapMs: ANIMATION_TOTAL_CAP_MS,
};

/** How many chunks a budget buys at the fastest legible rate. */
export function maxChunksFor(timing: AnimationTiming = DEFAULT_ANIMATION_TIMING): number {
  return Math.floor(timing.totalCapMs / timing.minGapMs) + 1;
}

/* ========================================================================== *
 * Inputs and outputs                                                          *
 * ========================================================================== */

/**
 * The only thing the scheduler needs to know about a hunk: where it is.
 *
 * `anchor`/`head` are the document offsets the agent's cursor takes while the
 * hunk is applied — the same two scalars a human's caret publishes through the
 * presence relay (`PresencePosition`), so a robot's position is the same kind of
 * fact as a person's and needs no second rendering path.
 *
 * Callers carry their own payload on top (the bridge's block edit, the text
 * run, whatever) — hence the type parameter. This module never reads it, never
 * reorders its contents and never merges two payloads together; it only decides
 * which chunk each one rides in.
 */
export interface AnimationHunk {
  /** Start of the hunk's range in the document. The ordering key. */
  readonly anchor: number;
  /** End of the hunk's range (>= anchor); the cursor head while applying. */
  readonly head: number;
}

/** The awareness range the agent cursor moves to BEFORE the chunk is applied. */
interface AwarenessRange {
  readonly anchor: number;
  readonly head: number;
}

export interface AnimationChunk<H extends AnimationHunk> {
  /** In document order. Never empty. */
  readonly hunks: readonly H[];
  /**
   * Where the cursor/selection goes before applying — the union of this chunk's
   * hunk ranges, so a merged chunk selects the whole span it is about to
   * rewrite rather than pretending to be a caret at one of them.
   */
  readonly range: AwarenessRange;
  /** Wait this long after the previous chunk. 0 for the first. */
  readonly delayMs: number;
  /** Offset from the start of the animation. `atMs[i] === i * gap`. */
  readonly atMs: number;
}

/**
 * Why the plan looks the way it does. Not decoration: the driver marks the room
 * `animating` (suspending flushes) only for `animated`, and the fast-path modes
 * are exactly the cases where that window must not be opened at all.
 */
export type AnimationMode = "animated" | "reduced-motion" | "no-viewers" | "empty";

export interface AnimationPlan<H extends AnimationHunk> {
  readonly chunks: readonly AnimationChunk<H>[];
  /** First chunk to last. `0` for a single chunk, and always <= the cap. */
  readonly totalMs: number;
  readonly mode: AnimationMode;
  /** The gap between consecutive chunks, `0` when there is only one. */
  readonly gapMs: number;
}

interface AnimationOptions {
  /**
   * Any connected client in the room asked for reduced motion. One is enough:
   * a room is a shared screen, and there is no way to animate for some peers and
   * not others without lying to somebody's CRDT.
   */
  readonly prefersReducedMotion?: boolean | undefined;
  /**
   * Live HUMAN viewers of the room. Agents do not count — an agent watching an
   * agent type is nobody watching.
   *
   * DEFAULTS TO 0, i.e. to the single-transaction path. A caller that forgets to
   * pass it degrades to the boring, correct behaviour rather than to a 1.2s
   * window with the room's flushes suspended for an audience that may not exist.
   */
  readonly humanViewers?: number | undefined;
  readonly timing?: Partial<AnimationTiming> | undefined;
}

/* ========================================================================== *
 * Planning                                                                    *
 * ========================================================================== */

function positiveInt(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const value = Math.trunc(raw);
  return value > 0 ? value : fallback;
}

function offset(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const value = Math.trunc(raw);
  return value > 0 ? value : 0;
}

function resolveTiming(raw: Partial<AnimationTiming> | undefined): AnimationTiming {
  const minGapMs = positiveInt(raw?.minGapMs, ANIMATION_MIN_GAP_MS);
  const maxGapMs = Math.max(minGapMs, positiveInt(raw?.maxGapMs, ANIMATION_MAX_GAP_MS));
  const totalCapMs = Math.max(minGapMs, positiveInt(raw?.totalCapMs, ANIMATION_TOTAL_CAP_MS));
  return { minGapMs, maxGapMs, totalCapMs };
}

/**
 * Document order, deterministically.
 *
 * Hunks reach us in whatever order the diff produced them — the markdown bridge
 * walks its plan DESCENDING so that indices stay valid as it mutates, which is
 * exactly backwards for a cursor that is supposed to read like a person working
 * top to bottom. Ties (two hunks at one anchor: a delete and the insert that
 * replaces it) fall back to the narrower range first and then to arrival order,
 * so the same input always yields the same plan.
 */
function inDocumentOrder<H extends AnimationHunk>(hunks: readonly H[]): H[] {
  return hunks
    .map((hunk, index) => ({ hunk, index }))
    .sort((a, b) => {
      const anchor = offset(a.hunk.anchor) - offset(b.hunk.anchor);
      if (anchor !== 0) return anchor;
      const head = offset(a.hunk.head) - offset(b.hunk.head);
      if (head !== 0) return head;
      return a.index - b.index;
    })
    .map((entry) => entry.hunk);
}

function rangeOf<H extends AnimationHunk>(hunks: readonly H[]): AwarenessRange {
  let anchor = Number.POSITIVE_INFINITY;
  let head = 0;
  for (const hunk of hunks) {
    const from = offset(hunk.anchor);
    const to = Math.max(from, offset(hunk.head));
    if (from < anchor) anchor = from;
    if (to > head) head = to;
  }
  if (!Number.isFinite(anchor)) anchor = 0;
  return { anchor, head: Math.max(anchor, head) };
}

/**
 * Sizes for `count` chunks over `total` hunks, as even as division allows, the
 * remainder going to the earliest chunks. Every size is >= 1 because the caller
 * never asks for more chunks than there are hunks — an empty chunk would be a
 * cursor move with no edit behind it, i.e. a robot twitching at nothing.
 */
function split(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const extra = total % count;
  const sizes: number[] = [];
  for (let i = 0; i < count; i += 1) sizes.push(base + (i < extra ? 1 : 0));
  return sizes;
}

function single<H extends AnimationHunk>(
  hunks: readonly H[],
  mode: AnimationMode,
): AnimationPlan<H> {
  return {
    chunks: [{ hunks, range: rangeOf(hunks), delayMs: 0, atMs: 0 }],
    totalMs: 0,
    mode,
    gapMs: 0,
  };
}

/**
 * Order the hunks and schedule them.
 *
 * Invariants every returned plan satisfies, in the order they matter:
 *
 *  1. concatenating `chunks[*].hunks` yields the input hunks, each exactly once
 *     — this is the write, and the write is not negotiable;
 *  2. `totalMs <= timing.totalCapMs`, whatever the hunk count;
 *  3. consecutive chunks are `minGapMs..maxGapMs` apart;
 *  4. hunks are in document order, and so are the chunks' ranges;
 *  5. the fast paths return exactly one chunk.
 */
export function planAnimation<H extends AnimationHunk>(
  hunks: readonly H[],
  opts: AnimationOptions = {},
): AnimationPlan<H> {
  const ordered = inDocumentOrder(hunks);
  if (ordered.length === 0) {
    return { chunks: [], totalMs: 0, mode: "empty", gapMs: 0 };
  }

  // Reduced motion wins over viewer count: it is a stated preference, and the
  // only way to honour it in a shared room is not to move.
  if (opts.prefersReducedMotion === true) return single(ordered, "reduced-motion");
  const viewers = typeof opts.humanViewers === "number" ? Math.trunc(opts.humanViewers) : 0;
  if (!(viewers > 0)) return single(ordered, "no-viewers");

  const timing = resolveTiming(opts.timing);
  const count = Math.min(ordered.length, maxChunksFor(timing));
  if (count <= 1) return single(ordered, "animated");

  // The widest gap that both reads as typing and fits the budget. `count` is
  // already bounded by the budget, so this can never fall under `minGapMs`.
  const gapMs = Math.max(
    timing.minGapMs,
    Math.min(timing.maxGapMs, Math.floor(timing.totalCapMs / (count - 1))),
  );

  const chunks: AnimationChunk<H>[] = [];
  let cursor = 0;
  let index = 0;
  for (const size of split(ordered.length, count)) {
    const slice = ordered.slice(cursor, cursor + size);
    cursor += size;
    chunks.push({
      hunks: slice,
      range: rangeOf(slice),
      delayMs: index === 0 ? 0 : gapMs,
      atMs: index * gapMs,
    });
    index += 1;
  }

  return { chunks, totalMs: (chunks.length - 1) * gapMs, mode: "animated", gapMs };
}

/**
 * The chunk's range as a presence position, ready to publish through the relay.
 *
 * Deliberately the identity function over two scalars rather than something
 * cleverer: `PresencePosition`'s third field (`at`, the block key) is
 * client-authored document-local state, and an agent that guessed at it would be
 * inventing position data the relay has no way to check.
 */
export function positionFor(range: AwarenessRange): PresencePosition {
  return { anchor: range.anchor, head: range.head };
}
