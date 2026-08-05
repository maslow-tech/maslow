import * as Y from "yjs";
import type { AnimationHunk } from "./animate.js";
import type { ApplyMarkdownDiff } from "./docStore.js";
import {
  BODY_FRAGMENT,
  TITLE_TEXT,
  docToMarkdown,
  normalizeMarkdown,
  seedDocFromMarkdown,
} from "./serialize.js";

/**
 * The old→new markdown diff bridge: the primitive every path that has to put
 * SOMEONE ELSE'S write into a LIVE Yjs doc goes through.
 *
 * Three callers, one function:
 *
 *  - the agent-write bridge (bridge.ts) — an MCP edit or a CAS patch landed, and
 *    open editors must SEE it rather than fight it;
 *  - the flush pipeline's rebase (flush.ts) — a CAS write lost, and the room has
 *    to be brought onto the winner's content before anything is re-serialized;
 *  - the doc store's blob rebase (docStore.ts) — a process restart left an
 *    unflushed delta that has to be re-applied on top of newer markdown.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A DIFF AND NOT A RE-SEED
 *
 * Replacing the doc's content wholesale converges on the right text and is still
 * wrong three times over: every remote cursor jumps to the top, every mark and
 * every selection in an UNRELATED paragraph is destroyed, and — because Yjs sees
 * a delete of everything followed by an insert of everything — a peer that was
 * mid-keystroke loses the character it just typed. So the change is applied at
 * BLOCK level first (an untouched paragraph is not touched at all) and then at
 * INLINE level inside the one block that actually changed, as ONE transaction
 * carrying the caller's origin.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LIVE DOC IS NOT `from`, AND THAT IS THE WHOLE PROBLEM
 *
 * `from`/`to` are two revisions of the stored markdown. The doc in front of us
 * is a THIRD state: someone has been typing into it since. So this is a
 * three-way merge, not a patch, and it states its outcomes rather than guessing:
 *
 *  - a hunk whose target is ALREADY in the live doc is convergent — skipped, not
 *    re-applied. This is what makes the bridge idempotent, and it is load-
 *    bearing: the flush's rebase re-runs the very diff the bridge already
 *    applied, and a second application would duplicate the agent's paragraph;
 *  - a hunk whose source block is untouched locally is applied exactly;
 *  - a hunk whose source block was edited locally is merged INSIDE the block
 *    when the two edits are disjoint, and REFUSED when they overlap;
 *  - anything else returns false. Never "best effort, close enough": the callers
 *    treat false as "surface a conflict", and a silently mis-applied merge is
 *    how an acknowledged agent write gets reverted by the next flush.
 *
 * Design invariant: a flush CAS failure is never a blind retry.
 */

/**
 * The transaction origin every bridge/diff application carries by default.
 *
 * It must be distinguishable from a human's transaction: this content came OUT
 * of the database, so the flush pipeline must neither attribute it to whoever
 * typed last nor schedule a write to put it back where it already is.
 *
 * ITS VALUE IS `FLUSH_ORIGIN`'s, DELIBERATELY. flush.ts recognises exactly two
 * non-contributory origins — `SEED_ORIGIN` and `FLUSH_ORIGIN` — and treats every
 * other transaction as a human contribution to attribute; finding no account
 * behind this one it would REFUSE it, revert it back out of the live doc and
 * escalate the room as `unattributed`, i.e. undo the agent write this module
 * exists to deliver. The two really are one class of transaction (the database
 * talking to itself), so they share one origin rather than one of them
 * special-casing the other. bridge.ts pins the equality at compile time
 * (`INGEST_ORIGIN`), and phase 5 replaces it with a named agent identity at the
 * same time as flush.ts learns to attribute one.
 *
 * The string is spelled out rather than imported from flush.ts on purpose: this
 * module must stay importable without the write path (flush.ts pulls in
 * `@brain/mcp-tools` and `pg`), so its unit tests need no build of either.
 */
export const BRIDGE_ORIGIN = "collab:flush";

interface MarkdownDiffOptions {
  /**
   * The title the object now has. `undefined` leaves the doc's title alone;
   * `null` clears it (an empty title is null on the row, "" in the CRDT).
   */
  readonly title?: string | null | undefined;
  /** Yjs transaction origin; defaults to BRIDGE_ORIGIN. */
  readonly origin?: unknown;
}

/* ========================================================================== *
 * Structural specs — the diff's unit of comparison                            *
 * ========================================================================== */

type Attrs = Record<string, unknown>;

interface DeltaOp {
  readonly insert: string;
  readonly attributes?: Attrs;
}

/**
 * A block (or inline run) as PLAIN JSON.
 *
 * Everything the diff compares, hashes and re-materializes goes through this
 * shape rather than through Y types, for two reasons that are both bugs
 * otherwise. `Y.XmlElement.clone()` copies only STRING attributes — serialize.ts
 * deliberately stores `level`, `checked`, `tight` and `start` as numbers and
 * booleans (y-prosemirror reads them back verbatim), so cloning a heading would
 * hand the client a heading with no level. And a Y type that is already
 * integrated into one document cannot be inserted into another, so the "build it
 * from the new markdown, then splice it in" path needs a document-free
 * description anyway.
 */
type Spec =
  | {
      readonly t: "el";
      readonly name: string;
      readonly attrs: [string, unknown][];
      readonly children: Spec[];
    }
  | { readonly t: "text"; readonly ops: DeltaOp[] };

function sortedAttrs(raw: Attrs): [string, unknown][] {
  return Object.entries(raw)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function describe(node: Y.XmlElement | Y.XmlText | Y.XmlHook): Spec | null {
  if (node instanceof Y.XmlText) {
    const ops: DeltaOp[] = [];
    for (const op of node.toDelta() as { insert?: unknown; attributes?: Attrs }[]) {
      if (typeof op.insert !== "string" || op.insert === "") continue;
      const attributes = op.attributes ? normalizeAttrs(op.attributes) : undefined;
      ops.push(
        attributes === undefined ? { insert: op.insert } : { insert: op.insert, attributes },
      );
    }
    return { t: "text", ops };
  }
  if (node instanceof Y.XmlElement) {
    const children: Spec[] = [];
    for (const child of node.toArray()) {
      const spec = describe(child);
      if (spec) children.push(spec);
    }
    return {
      t: "el",
      name: node.nodeName,
      attrs: sortedAttrs(node.getAttributes() as unknown as Attrs),
      children,
    };
  }
  // Y.XmlHook is never produced by serialize.ts; skipping it keeps an unknown
  // node from becoming markdown nobody wrote.
  return null;
}

/** Mark attributes with their keys ordered, so equal marks hash equal. */
function normalizeAttrs(raw: Attrs): Attrs | undefined {
  const entries = sortedAttrs(raw);
  if (entries.length === 0) return undefined;
  const out: Attrs = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}

function materialize(spec: Spec): Y.XmlElement | Y.XmlText {
  if (spec.t === "text") {
    const text = new Y.XmlText();
    // The offset is tracked by hand: an un-integrated Y.XmlText reports
    // `length === 0` however much has been written into its pending buffer, so
    // `insert(text.length, …)` would stack every run at 0 (serialize.ts hits
    // the same edge and solves it the same way).
    let offset = 0;
    for (const op of spec.ops) {
      text.insert(offset, op.insert, op.attributes as Record<string, unknown> | undefined);
      offset += op.insert.length;
    }
    return text;
  }
  const el = new Y.XmlElement(spec.name);
  for (const [k, v] of spec.attrs) el.setAttribute(k, v as unknown as string);
  const children = spec.children.map(materialize);
  if (children.length > 0) el.insert(0, children);
  return el;
}

/** Deterministic identity of a block — the diff's equality test. */
function keyOf(spec: Spec): string {
  return JSON.stringify(spec);
}

/** The top-level blocks of a markdown revision, via a throwaway doc. */
function blockSpecs(md: string): Spec[] {
  const doc = seedDocFromMarkdown(md);
  try {
    return fragmentSpecs(doc);
  } finally {
    doc.destroy();
  }
}

function fragmentSpecs(doc: Y.Doc): Spec[] {
  const out: Spec[] = [];
  for (const child of doc.getXmlFragment(BODY_FRAGMENT).toArray()) {
    const spec = describe(child);
    if (spec) out.push(spec);
  }
  return out;
}

/* ========================================================================== *
 * Alignment                                                                   *
 * ========================================================================== */

/**
 * Above this many DP cells the LCS is skipped and the middle is treated as
 * wholly changed. A body big enough to blow this budget is one where a
 * block-accurate diff stops mattering; a quadratic loop on the box's single
 * shared process is a real cost, and an unbounded one is an availability bug.
 */
const LCS_CELL_CAP = 250_000;

/**
 * For each index of `a`, the index of `b` it is identical to, or null.
 *
 * Common prefix/suffix are matched directly (which is the whole story for
 * insert-at-start and delete-at-end) and the LCS runs only on what is left.
 */
function alignment(a: readonly string[], b: readonly string[]): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(a.length).fill(null);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    out[head] = head;
    head += 1;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    out[a.length - 1 - tail] = b.length - 1 - tail;
    tail += 1;
  }

  const aFrom = head;
  const aTo = a.length - tail;
  const bFrom = head;
  const bTo = b.length - tail;
  const n = aTo - aFrom;
  const m = bTo - bFrom;
  if (n <= 0 || m <= 0 || n * m > LCS_CELL_CAP) return out;

  // dp[i][j] = LCS length of a[aFrom+i..] and b[bFrom+j..]
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[aFrom + i] === b[bFrom + j]
          ? (dp[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[aFrom + i] === b[bFrom + j]) {
      out[aFrom + i] = bFrom + j;
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

/**
 * For each UNMATCHED index of `a`, the unmatched index of `b` sitting in the
 * same gap — "this is probably the same block, edited".
 *
 * It is a candidate, never a conclusion: `similar()` decides whether the pair is
 * close enough to merge, and everything else is refused.
 */
function gapCandidates(match: readonly (number | null)[], bLength: number): (number | null)[] {
  const cand: (number | null)[] = new Array<number | null>(match.length).fill(null);
  let i = 0;
  let bCursor = 0;
  while (i < match.length) {
    const here = match[i];
    if (here !== null && here !== undefined) {
      bCursor = here + 1;
      i += 1;
      continue;
    }
    let end = i;
    while (end < match.length && (match[end] === null || match[end] === undefined)) end += 1;
    const nextMatch = end < match.length ? match[end] : null;
    const bEnd = nextMatch === null || nextMatch === undefined ? bLength : nextMatch;
    for (let k = 0; i + k < end && bCursor + k < bEnd; k += 1) cand[i + k] = bCursor + k;
    bCursor = bEnd;
    i = end;
  }
  return cand;
}

/* ========================================================================== *
 * Inline (character-level) diffing                                            *
 * ========================================================================== */

interface Tok {
  readonly ch: string;
  /** the mark set this character carries, as a comparable key */
  readonly mark: string;
  readonly attrs: Attrs | undefined;
}

function tokens(spec: Spec | undefined): Tok[] | null {
  if (!spec || spec.t !== "text") return null;
  const out: Tok[] = [];
  for (const op of spec.ops) {
    const mark = op.attributes ? JSON.stringify(op.attributes) : "";
    for (const ch of splitUnits(op.insert)) out.push({ ch, mark, attrs: op.attributes });
  }
  return out;
}

/** UTF-16 code units, which is what Y.Text indexes by. */
function splitUnits(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charAt(i));
  return out;
}

function sameTok(a: Tok | undefined, b: Tok | undefined): boolean {
  return a !== undefined && b !== undefined && a.ch === b.ch && a.mark === b.mark;
}

/** Do not cut a surrogate pair in half — half a pair is a corrupt document. */
function safeBoundary(toks: readonly Tok[], at: number): number {
  const prev = toks[at - 1]?.ch ?? "";
  const next = toks[at]?.ch ?? "";
  const isHigh = prev.length === 1 && prev.charCodeAt(0) >= 0xd800 && prev.charCodeAt(0) <= 0xdbff;
  const isLow = next.length === 1 && next.charCodeAt(0) >= 0xdc00 && next.charCodeAt(0) <= 0xdfff;
  return isHigh && isLow ? at - 1 : at;
}

interface Hunk {
  /** first changed index (same in both sides) */
  readonly start: number;
  /** end of the changed range in `a` (exclusive) */
  readonly aEnd: number;
  /** end of the changed range in `b` (exclusive) */
  readonly bEnd: number;
}

/**
 * The single changed range between two token runs, as common-prefix /
 * common-suffix. One hunk, deliberately: it is exact (applying it reproduces
 * `b`), it is what a human edit actually looks like, and it keeps the
 * three-way overlap test below to one interval comparison.
 */
function hunkOf(a: readonly Tok[], b: readonly Tok[]): Hunk | null {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && sameTok(a[p], b[p])) p += 1;
  let s = 0;
  while (s < max - p && sameTok(a[a.length - 1 - s], b[b.length - 1 - s])) s += 1;
  if (p === a.length && p === b.length) return null; // identical
  const start = Math.min(safeBoundary(a, p), safeBoundary(b, p));
  const aEnd = a.length - s;
  const bEnd = b.length - s;
  return { start, aEnd: Math.max(start, aEnd), bEnd: Math.max(start, bEnd) };
}

interface TextRun {
  readonly text: string;
  readonly attributes: Attrs | undefined;
}

interface TextEdit {
  readonly index: number;
  readonly remove: number;
  readonly insert: TextRun[];
}

/** Consecutive tokens with the same marks become one insert call. */
function runsOf(toks: readonly Tok[]): TextRun[] {
  const out: TextRun[] = [];
  let mark: string | undefined;
  let buffer = "";
  let attrs: Attrs | undefined;
  for (const tok of toks) {
    if (mark === undefined || tok.mark !== mark) {
      if (buffer !== "") out.push({ text: buffer, attributes: attrs });
      mark = tok.mark;
      attrs = tok.attrs;
      buffer = tok.ch;
      continue;
    }
    buffer += tok.ch;
  }
  if (buffer !== "") out.push({ text: buffer, attributes: attrs });
  return out;
}

/**
 * The live block is byte-identical to `from`'s: apply the change exactly.
 * Returns null when the two blocks are not a single-text-child pair (a list, a
 * table, a paragraph with a hard break) — the caller then replaces the block.
 */
function exactTextEdit(oldSpec: Spec, newSpec: Spec): TextEdit | null {
  if (!sameShell(oldSpec, newSpec)) return null;
  const a = tokens(soleText(oldSpec));
  const b = tokens(soleText(newSpec));
  if (!a || !b) return null;
  const hunk = hunkOf(a, b);
  if (!hunk) return { index: 0, remove: 0, insert: [] };
  return {
    index: hunk.start,
    remove: hunk.aEnd - hunk.start,
    insert: runsOf(b.slice(hunk.start, hunk.bEnd)),
  };
}

/**
 * THE THREE-WAY CASE: the live block was edited locally too.
 *
 * Merged only when the two edits do not overlap — a local edit before the
 * external one shifts it, a local edit after it does not, and an edit inside it
 * is a genuine same-text conflict that this module refuses rather than
 * arbitrates. "Never clobber, never auto-merge a same-field conflict" is the
 * design's rule for the CAS path; the CRDT path does not get a weaker one.
 */
function threeWayTextEdit(oldSpec: Spec, newSpec: Spec, liveSpec: Spec): TextEdit | null {
  if (!sameShell(oldSpec, newSpec) || !sameShell(oldSpec, liveSpec)) return null;
  const base = tokens(soleText(oldSpec));
  const next = tokens(soleText(newSpec));
  const live = tokens(soleText(liveSpec));
  if (!base || !next || !live) return null;

  const external = hunkOf(base, next);
  if (!external) return { index: 0, remove: 0, insert: [] };
  const local = hunkOf(base, live);
  if (!local) {
    // The live block is identical to the base after all (different marks
    // elsewhere would have shown up as a hunk) — apply exactly.
    return {
      index: external.start,
      remove: external.aEnd - external.start,
      insert: runsOf(next.slice(external.start, external.bEnd)),
    };
  }

  let index: number;
  if (external.aEnd <= local.start) {
    index = external.start; // the local edit is after ours: coordinates hold
  } else if (local.aEnd <= external.start) {
    index = external.start + (live.length - base.length); // shifted by the local edit
  } else {
    return null; // overlapping edits — a real conflict
  }
  if (index < 0 || index + (external.aEnd - external.start) > live.length) return null;
  return {
    index,
    remove: external.aEnd - external.start,
    insert: runsOf(next.slice(external.start, external.bEnd)),
  };
}

/** Same element type and attributes — a paragraph is never merged into a heading. */
function sameShell(a: Spec, b: Spec): boolean {
  if (a.t !== "el" || b.t !== "el") return false;
  return a.name === b.name && JSON.stringify(a.attrs) === JSON.stringify(b.attrs);
}

/** The block's single inline run, when it has exactly one and nothing else. */
function soleText(spec: Spec): Spec | undefined {
  if (spec.t !== "el" || spec.children.length !== 1) return undefined;
  const only = spec.children[0];
  return only?.t === "text" ? only : undefined;
}

/**
 * Is this live block plausibly a local edit OF that old block, rather than an
 * unrelated block the user added?
 *
 * Half of the OLD block's characters have to survive at the boundaries — the
 * ratio is measured against the old block, never against the longer of the two.
 * A local edit is usually typing, so the live block is routinely several times
 * the length of the base ("beta" → "beta being edited right now" is a 15%
 * overlap by the longer measure and a 100% one by this measure), and calling
 * that pair unrelated is the dangerous direction: the block would then read as
 * "already gone from the room", an external delete would be silently treated as
 * convergent, and the next flush would write the user's paragraph straight back
 * over the agent's delete.
 *
 * Without a test like this at all, a user's newly typed paragraph sitting in the
 * same gap would be paired with a paragraph the agent deleted, and its text
 * merged into the wrong block.
 */
function similar(oldSpec: Spec, liveSpec: Spec): boolean {
  if (!sameShell(oldSpec, liveSpec)) return false;
  const a = tokens(soleText(oldSpec));
  const b = tokens(soleText(liveSpec));
  if (!a || !b) return false;
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  const hunk = hunkOf(a, b);
  if (!hunk) return true;
  const shared = hunk.start + (a.length - hunk.aEnd);
  return shared > 0 && shared * 2 >= a.length;
}

/* ========================================================================== *
 * The plan                                                                    *
 * ========================================================================== */

interface Plan {
  readonly deletes: Set<number>;
  readonly inserts: Map<number, Spec[]>;
  readonly texts: Map<number, TextEdit>;
}

function emptyPlan(): Plan {
  return { deletes: new Set<number>(), inserts: new Map(), texts: new Map() };
}

function planIsEmpty(plan: Plan): boolean {
  return plan.deletes.size === 0 && plan.inserts.size === 0 && plan.texts.size === 0;
}

function addInsert(plan: Plan, at: number, spec: Spec): void {
  const existing = plan.inserts.get(at);
  if (existing) existing.push(spec);
  else plan.inserts.set(at, [spec]);
}

/**
 * Turn (from, to, live) into the ops to run against the live fragment, or null
 * when the merge cannot be made cleanly. Pure: nothing is mutated until the
 * whole plan exists, so a refusal never leaves a half-applied document.
 */
function buildPlan(oldB: Spec[], newB: Spec[], liveB: Spec[]): Plan | null {
  const oldK = oldB.map(keyOf);
  const newK = newB.map(keyOf);
  const liveK = liveB.map(keyOf);

  const newOfOld = alignment(oldK, newK);
  const liveOfOld = alignment(oldK, liveK);
  const candOfOld = gapCandidates(liveOfOld, liveK.length);
  const liveOfNew = alignment(newK, liveK);

  // Live blocks that already correspond to a block of `from` cannot also be
  // evidence that a NEW block has already been applied — otherwise a re-inserted
  // duplicate paragraph would read as "already there" and be dropped.
  const claimed = new Set<number>();
  for (const j of liveOfOld) if (j !== null && j !== undefined) claimed.add(j);
  const alreadyApplied = (ni: number): boolean => {
    const j = liveOfNew[ni];
    return j !== null && j !== undefined && !claimed.has(j);
  };

  let lastClaimed = -1;
  for (const j of claimed) if (j > lastClaimed) lastClaimed = j;
  const endAnchor = lastClaimed >= 0 ? lastClaimed + 1 : liveB.length;

  const plan = emptyPlan();

  const replace = (oi: number, ni: number): boolean => {
    if (alreadyApplied(ni)) return true; // convergent: the write is already in
    const exact = liveOfOld[oi];
    if (exact !== null && exact !== undefined) {
      const edit = exactTextEdit(oldB[oi]!, newB[ni]!);
      if (edit) {
        plan.texts.set(exact, edit);
        return true;
      }
      plan.deletes.add(exact);
      addInsert(plan, exact, newB[ni]!);
      return true;
    }
    const cand = candOfOld[oi];
    if (cand !== null && cand !== undefined && similar(oldB[oi]!, liveB[cand]!)) {
      const edit = threeWayTextEdit(oldB[oi]!, newB[ni]!, liveB[cand]!);
      if (!edit) return false; // overlapping edits, or a shape we cannot merge
      plan.texts.set(cand, edit);
      return true;
    }
    // The block this write changed is not in the room in any recognisable form.
    // Inserting the new one would resurrect text the user deleted; skipping it
    // would let the next flush revert an acknowledged write. Refuse.
    return false;
  };

  const remove = (oi: number): boolean => {
    const exact = liveOfOld[oi];
    if (exact !== null && exact !== undefined) {
      plan.deletes.add(exact);
      return true;
    }
    const cand = candOfOld[oi];
    if (cand !== null && cand !== undefined && similar(oldB[oi]!, liveB[cand]!)) {
      // Somebody is editing the paragraph this write deleted. Dropping their
      // text silently is exactly what "never clobber" forbids.
      return false;
    }
    return true; // already gone from the room — convergent
  };

  const anchorFor = (oldIndex: number): number => {
    if (oldIndex >= oldB.length) return endAnchor;
    const j = liveOfOld[oldIndex];
    return j === null || j === undefined ? endAnchor : j;
  };

  // Walk the old→new script gap by gap: everything between two blocks that
  // survived unchanged is a run of replaces, then deletes or inserts.
  let oi = 0;
  let ni = 0;
  while (oi < oldB.length || ni < newB.length) {
    const matched = oi < oldB.length ? newOfOld[oi] : null;
    if (oi < oldB.length && matched !== null && matched !== undefined) {
      if (ni < matched) {
        const anchor = anchorFor(oi);
        for (; ni < matched; ni += 1) if (!alreadyApplied(ni)) addInsert(plan, anchor, newB[ni]!);
      }
      oi += 1;
      ni += 1;
      continue;
    }

    // A gap: old blocks up to the next survivor, new blocks up to its partner.
    let oEnd = oi;
    while (oEnd < oldB.length && (newOfOld[oEnd] === null || newOfOld[oEnd] === undefined)) {
      oEnd += 1;
    }
    const nEnd = oEnd < oldB.length ? (newOfOld[oEnd] as number) : newB.length;
    const anchor = anchorFor(oEnd);

    const pairs = Math.min(oEnd - oi, nEnd - ni);
    for (let k = 0; k < pairs; k += 1) if (!replace(oi + k, ni + k)) return null;
    for (let k = pairs; k < oEnd - oi; k += 1) if (!remove(oi + k)) return null;
    for (let k = pairs; k < nEnd - ni; k += 1) {
      if (!alreadyApplied(ni + k)) addInsert(plan, anchor, newB[ni + k]!);
    }
    oi = oEnd;
    ni = nEnd;
  }

  return plan;
}

/* ========================================================================== *
 * Application                                                                 *
 * ========================================================================== */

function applyTextEdit(fragment: Y.XmlFragment, index: number, edit: TextEdit): void {
  const el = fragment.toArray()[index];
  if (!(el instanceof Y.XmlElement)) return;
  const text = el.toArray()[0];
  if (!(text instanceof Y.XmlText)) return;
  if (edit.remove > 0) text.delete(edit.index, edit.remove);
  let at = edit.index;
  for (const run of edit.insert) {
    text.insert(at, run.text, run.attributes as Record<string, unknown> | undefined);
    at += run.text.length;
  }
}

/** Minimal character edit on the title, for the same reason as the body. */
function applyTitle(doc: Y.Doc, title: string | null): void {
  const text = doc.getText(TITLE_TEXT);
  const current = text.toString();
  const want = title ?? "";
  if (current === want) return;
  const max = Math.min(current.length, want.length);
  let p = 0;
  while (p < max && current.charAt(p) === want.charAt(p)) p += 1;
  let s = 0;
  while (
    s < max - p &&
    current.charAt(current.length - 1 - s) === want.charAt(want.length - 1 - s)
  ) {
    s += 1;
  }
  const removeLen = current.length - p - s;
  if (removeLen > 0) text.delete(p, removeLen);
  const insert = want.slice(p, want.length - s);
  if (insert !== "") text.insert(p, insert);
}

/**
 * Apply the change between two markdown revisions into a live Yjs doc.
 *
 * Returns false when it cannot be applied cleanly — the caller escalates
 * (surfaces a conflict / keeps the unmerged text), it never guesses.
 */
export function applyMarkdownDiff(
  doc: Y.Doc,
  oldMd: string,
  newMd: string,
  opts: MarkdownDiffOptions = {},
): boolean {
  const origin = opts.origin ?? BRIDGE_ORIGIN;
  const titleGiven = opts.title !== undefined;
  const title = opts.title ?? null;

  const from = normalizeMarkdown(oldMd);
  const to = normalizeMarkdown(newMd);

  const applyTitleOnly = (): boolean => {
    if (!titleGiven) return true;
    const text = doc.getText(TITLE_TEXT);
    if (text.toString() === (title ?? "")) return true;
    doc.transact(() => applyTitle(doc, title), origin);
    return true;
  };

  // Nothing changed in the body — the write was a title, props, link or
  // visibility edit. Touching the fragment here would churn the room for a
  // change that never reached the body.
  if (from === to) return applyTitleOnly();
  // The room is already at the target: a re-delivered feed event, or the flush's
  // rebase re-running the diff the bridge already applied. Idempotent by design.
  if (docToMarkdown(doc) === to) return applyTitleOnly();

  const plan = buildPlan(blockSpecs(from), blockSpecs(to), fragmentSpecs(doc));
  if (!plan) return false;
  if (planIsEmpty(plan)) return applyTitleOnly();

  doc.transact(() => {
    const fragment = doc.getXmlFragment(BODY_FRAGMENT);
    const indices = [
      ...new Set<number>([...plan.deletes, ...plan.inserts.keys(), ...plan.texts.keys()]),
    ].sort((a, b) => b - a);
    // Descending, so every index is still valid in ORIGINAL live coordinates
    // when its turn comes; delete-then-insert at the same index is a replace.
    for (const at of indices) {
      const edit = plan.texts.get(at);
      if (edit) applyTextEdit(fragment, at, edit);
      if (plan.deletes.has(at)) fragment.delete(at, 1);
      const specs = plan.inserts.get(at);
      if (specs) fragment.insert(at, specs.map(materialize));
    }
    if (titleGiven) applyTitle(doc, title);
  }, origin);

  return true;
}

/**
 * The `ApplyMarkdownDiff` seam docStore and flush already speak — same function,
 * named-argument shape. Wire THIS into `createDocStore`/`createFlushPipeline`.
 */
export const markdownDiffBridge: ApplyMarkdownDiff = ({ doc, from, to, title, origin }) =>
  applyMarkdownDiff(doc, from, to, { title, origin });

/* ========================================================================== *
 * Changed ranges — where phase 5's agent cursor travels                       *
 * ========================================================================== */

/** ProseMirror node size: a text leaf is its length; a node is 2 + its children. */
function nodeSize(spec: Spec): number {
  if (spec.t === "text") {
    let n = 0;
    for (const op of spec.ops) n += op.insert.length;
    return n;
  }
  let n = 2; // the open + close boundary tokens
  for (const child of spec.children) n += nodeSize(child);
  return n;
}

/**
 * The document ranges an old→new write TOUCHED, as `AnimationHunk`s the phase-5
 * chunk scheduler orders and paces.
 *
 * Computed AFTER `applyMarkdownDiff` has landed the write, by comparing the live
 * doc's top-level blocks against the ones `from` had (by structural key): a
 * block the room now holds that `from` did not is one this write inserted or
 * rewrote, and its position is a place the agent's cursor should be seen to
 * work. The offsets are ProseMirror-style document positions — advisory, since
 * the presence caret is a rendering hint, not an edit coordinate — so an
 * approximate cumulative position is exactly the right precision.
 *
 * A pure read: it never opens a transaction (so the flush observer sees no
 * phantom author), and it must run on an already-materialized fragment — which
 * `applyMarkdownDiff` guarantees by having just read the same fragment.
 */
export function changedBlockRanges(doc: Y.Doc, fromMd: string): AnimationHunk[] {
  const fromKeys = new Set(blockSpecs(normalizeMarkdown(fromMd)).map(keyOf));
  const ranges: AnimationHunk[] = [];
  let pos = 0; // the document position immediately before the current block
  for (const child of doc.getXmlFragment(BODY_FRAGMENT).toArray()) {
    const spec = describe(child);
    const size = spec ? nodeSize(spec) : 2;
    if (!spec || !fromKeys.has(keyOf(spec))) {
      // The caret sits INSIDE the block: [pos+1, pos+size-1].
      const anchor = pos + 1;
      ranges.push({ anchor, head: Math.max(anchor, pos + size - 1) });
    }
    pos += size;
  }
  return ranges;
}
