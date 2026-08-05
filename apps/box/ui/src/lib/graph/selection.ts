/**
 * The graph's selection surface — the geometry that builds a selection, and
 * the CAS write driver that mutates one.
 *
 * Selecting a visible cluster is the one thing only the graph can express: a
 * table can filter, but it cannot say "these fourteen, the ones bunched around
 * that hub". This file is the half of that which is pure and testable — the
 * marquee maths and the bulk write driver. `components/graph/SelectionBar.tsx`
 * is its UI.
 *
 * Four rules run through the whole file, each one load-bearing:
 *
 *  1. **One transaction per object, with that object's OWN baseVersion.**
 *     There is no bulk endpoint and there must not be one: a batch that shares
 *     a version, or that half-applies inside one server-side transaction, has
 *     no honest way to report which object it lost. So a property set is a
 *     read (this object's current version) followed by that object's own
 *     `PATCH` — the same phase-1 CAS path the editor uses, fourteen times.
 *  2. **Links carry an idempotency key, and it is minted ONCE per row.** A
 *     link edit does not bump the object's version, so it can never lose a CAS
 *     and can never 409 — which is exactly why the key is required rather than
 *     optional here: a lost response on a retried row is otherwise a second
 *     write with no version to protect it. The key belongs to the user's
 *     intent ("link these fourteen to that"), so it is minted when the rows are
 *     planned and REUSED by every retry of that row. Re-minting per attempt
 *     would defeat the entire mechanism.
 *  3. **Partial success is reported, never swallowed.** Every row ends in its
 *     own terminal state with its own message; a 409 on object #7 is object
 *     #7's 409, shown on object #7's row, retryable on its own. The batch has
 *     no "it worked" — it has a count of what did.
 *  4. **A viewer may select.** Selection is a read surface: it highlights, it
 *     opens, it never writes. The mutating actions are gated here AND refused
 *     server-side; this gate is UX, the box's role check is the boundary.
 */

import {
  ApiError,
  ConflictError,
  api,
  newIdempotencyKey,
  type LinkObjectInput,
  type PatchObjectInput,
  type Whoami,
} from "../api";
import { isDemo } from "../../demo";
import { forEachInRect, type SpatialHash } from "./renderer";

/* ------------------------------------------------------------------ *
 * marquee geometry
 * ------------------------------------------------------------------ */

/**
 * A drag shorter than this in BOTH axes is a click that wobbled, not a
 * marquee. Without it, every alt-click would replace the selection with the
 * empty set, which reads as "the app lost my selection".
 */
export const MARQUEE_MIN_PX = 4;

/** A rectangle in the graph container's own pixel space (origin: its top-left). */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The normalized rect between two points, in either drag direction. */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): ScreenRect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/** Did the drag travel far enough to mean a marquee? */
export function isMarqueeRect(rect: ScreenRect): boolean {
  return rect.width >= MARQUEE_MIN_PX || rect.height >= MARQUEE_MIN_PX;
}

/** How a completed marquee folds into the existing selection. */
export type SelectionMode = "replace" | "add" | "toggle";

/** Just the modifier flags — a real PointerEvent, a KeyboardEvent, or a fake. */
interface ModifierState {
  altKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

/**
 * The marquee modifier is **Alt/Option**, deliberately not Shift.
 *
 * Shift-click already toggles one node into the selection (the renderer's
 * `onPick`), and a layer that swallowed pointer events whenever Shift was held
 * would break that gesture for the sake of this one. Meta is reserved for
 * ⌘-click ("path to…"), and Ctrl is a right-click on macOS. That leaves Alt:
 * alt-drag replaces the selection, alt+shift-drag adds to it.
 */
export function marqueeMode(event: ModifierState): SelectionMode | null {
  if (!event.altKey) return null;
  if (event.metaKey === true || event.ctrlKey === true) return null;
  return event.shiftKey ? "add" : "replace";
}

/** Is the marquee layer armed right now (i.e. should it take pointer events)? */
export function marqueeArmed(event: ModifierState): boolean {
  return marqueeMode(event) !== null;
}

/**
 * Every node whose drawn position falls inside a screen rect, as dense
 * indices, ascending.
 *
 * The rect's two corners are converted to world space by the caller's
 * projection (the renderer's `screenToWorld`) and the candidates come from the
 * spatial hash, so this is O(cells + hits) rather than O(n) — the same
 * primitive `forEachInRect` was built for.
 */
export function indicesInScreenRect(
  hash: SpatialHash,
  positions: Float32Array,
  rect: ScreenRect,
  toWorld: (sx: number, sy: number) => { x: number; y: number },
): number[] {
  const a = toWorld(rect.x, rect.y);
  const b = toWorld(rect.x + rect.width, rect.y + rect.height);
  const out: number[] = [];
  forEachInRect(hash, positions, a.x, a.y, b.x, b.y, (i) => out.push(i));
  out.sort((p, q) => p - q);
  return out;
}

/**
 * Fold indices into a selection. Mirrors `GraphEngine.select` exactly — it
 * exists separately so the fold can be tested without mounting the engine, and
 * so the two can never quietly disagree about what "toggle" means.
 */
export function nextSelection(
  prev: ReadonlySet<number>,
  indices: Iterable<number>,
  mode: SelectionMode = "replace",
): Set<number> {
  const next = mode === "replace" ? new Set<number>() : new Set(prev);
  for (const i of indices) {
    if (mode === "toggle" && next.has(i)) next.delete(i);
    else next.add(i);
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * what a bulk action may do
 * ------------------------------------------------------------------ */

/**
 * The most objects one bulk action may write to.
 *
 * Every object is its own round trip (a read plus a PATCH, for a property
 * set), so "select the whole graph and set a property" is thousands of
 * requests against a box that is also serving MCP traffic. The cap is a
 * product decision, not a technical one: past a couple of hundred objects the
 * honest answer is a filter or an agent, not a bar with a progress row.
 */
export const BULK_MAX = 200;

/** One selected object, as the bar needs it. */
export interface BulkTarget {
  /** dense index in the store — what the selection actually holds. */
  index: number;
  id: string;
  title: string | null;
  type: string | null;
}

/** Link every selected object to one target with one verb. */
export interface BulkLinkIntent {
  kind: "link";
  /** the object every selected object gets linked TO. */
  to: string;
  toTitle: string | null;
  /** the relationship verb, e.g. "about". */
  rel: string;
}

/** Set (or clear) one property on every selected object. */
export interface BulkPropIntent {
  kind: "prop";
  key: string;
  /** `null` DELETES the key — the patch route's documented meaning. */
  value: unknown;
}

export type BulkIntent = BulkLinkIntent | BulkPropIntent;

/**
 * A row's state.
 *
 * `conflict` is split out from `error` because the two mean different things
 * to the person reading the row: a conflict is "someone else changed this
 * while you were deciding — retrying applies your change on top of theirs",
 * and an error is "this did not happen and retrying may not help".
 */
export type BulkRowState = "queued" | "running" | "done" | "conflict" | "error" | "skipped";

export interface BulkRow {
  id: string;
  title: string | null;
  state: BulkRowState;
  /** what to show on the row when it did not succeed. */
  message: string | null;
  /** the version the server said was current, when a 409 carried one. */
  currentVersion: number | null;
  /**
   * Minted ONCE, when the rows are planned, and reused by every retry of THIS
   * row. See rule 2 in the header — re-minting per attempt is the bug this
   * field exists to prevent.
   */
  idempotencyKey: string;
  attempts: number;
}

/** A row that failed in a way retrying can plausibly fix. */
export function isRetryable(row: BulkRow): boolean {
  return row.state === "conflict" || row.state === "error";
}

/** A terminal row — the driver never touches it again. */
function isSettled(row: BulkRow): boolean {
  return row.state === "done" || row.state === "skipped";
}

/**
 * Plan the rows for one user intent. The idempotency keys are minted HERE, so
 * they survive every retry of the resulting batch.
 */
export function planBulkRows(
  targets: readonly BulkTarget[],
  mint: () => string = newIdempotencyKey,
): BulkRow[] {
  const seen = new Set<string>();
  const rows: BulkRow[] = [];
  for (const t of targets) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    rows.push({
      id: t.id,
      title: t.title,
      state: "queued",
      message: null,
      currentVersion: null,
      idempotencyKey: mint(),
      attempts: 0,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * property values
 * ------------------------------------------------------------------ */

/**
 * How the bar asks for a value. The kind is EXPLICIT rather than sniffed out
 * of the text: guessing that "0912" is a number, or that "false" is a boolean,
 * silently writes something the person did not type, and a brain full of
 * quietly-coerced values is worse than one extra select.
 */
export type BulkValueKind = "text" | "number" | "boolean" | "clear";

interface BulkValueResult {
  ok: boolean;
  value: unknown;
  /** why it was rejected, for the field's error text. */
  error: string | null;
}

export function coerceBulkValue(kind: BulkValueKind, raw: string): BulkValueResult {
  if (kind === "clear") return { ok: true, value: null, error: null };
  if (kind === "number") {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: false, value: null, error: "enter a number" };
    const n = Number(trimmed);
    if (!Number.isFinite(n))
      return { ok: false, value: null, error: `"${trimmed}" is not a number` };
    return { ok: true, value: n, error: null };
  }
  if (kind === "boolean") {
    const t = raw.trim().toLowerCase();
    if (t === "true" || t === "yes") return { ok: true, value: true, error: null };
    if (t === "false" || t === "no") return { ok: true, value: false, error: null };
    return { ok: false, value: null, error: "type true or false" };
  }
  return { ok: true, value: raw, error: null };
}

/** Property names are identifiers on the box; reject the shapes it will. */
export function isValidPropKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(key.trim());
}

/** A relationship verb, same shape the link routes accept. */
export function isValidRel(rel: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(rel.trim());
}

/* ------------------------------------------------------------------ *
 * the CAS driver
 * ------------------------------------------------------------------ */

/** How an error ends up on a row. */
interface BulkFailure {
  state: "conflict" | "error";
  message: string;
  currentVersion: number | null;
}

/**
 * Turn one object's thrown error into that object's row state.
 *
 * A 404 is deliberately NOT a conflict: the write routes answer 404 (never
 * 409) for an object the caller may no longer read, precisely so a 409's
 * version cannot confirm that a now-private object exists. Reporting it as
 * "changed underneath you" would leak the same fact in prose.
 */
export function classifyBulkError(e: unknown): BulkFailure {
  if (e instanceof ConflictError) {
    if (e.currentVersion !== null) {
      return {
        state: "conflict",
        message: `changed by someone else (now v${e.currentVersion}) — retry applies yours on top`,
        currentVersion: e.currentVersion,
      };
    }
    if (e.reason === "open_in_editor") {
      return {
        state: "error",
        message: "someone has this open in the editor — that live room owns it",
        currentVersion: null,
      };
    }
    return { state: "error", message: e.message, currentVersion: null };
  }
  if (e instanceof ApiError) {
    if (e.status === 404) {
      return { state: "error", message: "gone, or no longer visible to you", currentVersion: null };
    }
    if (e.status === 403) {
      return { state: "error", message: "you may not write to this object", currentVersion: null };
    }
    return { state: "error", message: e.message, currentVersion: null };
  }
  return {
    state: "error",
    message: e instanceof Error ? e.message : "failed",
    currentVersion: null,
  };
}

/**
 * The write surface the driver needs, as an interface so tests (and the demo
 * bundle) can hand it fakes. `defaultBulkWriter` is the real one.
 */
export interface BulkWriter {
  /** this object's CURRENT version — read immediately before its own PATCH. */
  readVersion: (id: string) => Promise<number>;
  patch: (id: string, patch: PatchObjectInput) => Promise<unknown>;
  link: (id: string, input: LinkObjectInput) => Promise<unknown>;
}

const defaultBulkWriter: BulkWriter = {
  readVersion: async (id) => (await api.object(id)).version,
  patch: (id, patch) => api.patchObject(id, patch),
  link: (id, input) => api.linkObject(id, input),
};

interface RunBulkOptions {
  writer?: BulkWriter;
  /** called after every row state change, with the whole array (a new one). */
  onProgress?: (rows: readonly BulkRow[]) => void;
  /**
   * How many objects are in flight at once. Small on purpose: this is a
   * customer's own box, usually one small instance also serving MCP traffic,
   * and four concurrent writes finish a realistic selection fast enough.
   */
  concurrency?: number;
  /** cooperative cancel — checked before each row starts. */
  shouldStop?: () => boolean;
}

/** Apply one row. Exported for the tests that pin the CAS shape. */
export async function applyBulkRow(
  intent: BulkIntent,
  row: BulkRow,
  writer: BulkWriter,
): Promise<BulkRow> {
  const attempts = row.attempts + 1;
  if (intent.kind === "link" && intent.to === row.id) {
    // The link target is very often IN the selection (you box-selected the
    // cluster including its hub). Skipping is honest; asking the server to
    // refuse it fourteen times is not.
    return {
      ...row,
      state: "skipped",
      message: "this is the link target",
      currentVersion: null,
      attempts: row.attempts,
    };
  }
  try {
    if (intent.kind === "link") {
      await writer.link(row.id, {
        to: intent.to,
        rel: intent.rel,
        // The row's key, not a fresh one — see rule 2.
        idempotencyKey: row.idempotencyKey,
      });
    } else {
      // This object's own baseVersion, read for this object, used by this
      // object's transaction and no other's. A retry re-reads, which is what
      // makes retrying a 409 apply on top of the winner.
      const baseVersion = await writer.readVersion(row.id);
      await writer.patch(row.id, { baseVersion, props: { [intent.key]: intent.value } });
    }
    return { ...row, state: "done", message: null, currentVersion: null, attempts };
  } catch (e) {
    const failure = classifyBulkError(e);
    return {
      ...row,
      state: failure.state,
      message: failure.message,
      currentVersion: failure.currentVersion,
      attempts,
    };
  }
}

/**
 * Run a batch. Rows that are already settled are left alone, so calling this
 * again with the previous result is exactly "retry the failed rows" — the
 * successes are not re-written and the failures keep their keys.
 *
 * Never rejects: a row's failure is that row's state, and one object's 409 has
 * no business aborting the other thirteen.
 */
export async function runBulk(
  intent: BulkIntent,
  input: readonly BulkRow[],
  options: RunBulkOptions = {},
): Promise<BulkRow[]> {
  const writer = options.writer ?? defaultBulkWriter;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const rows: BulkRow[] = input.map((r) =>
    isSettled(r) ? { ...r } : { ...r, state: "queued", message: null },
  );
  const emit = (): void => options.onProgress?.(rows.slice());
  emit();

  const queue: number[] = [];
  for (let i = 0; i < rows.length; i += 1) if (!isSettled(rows[i]!)) queue.push(i);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.shouldStop?.() === true) return;
      const at = cursor;
      cursor += 1;
      if (at >= queue.length) return;
      const i = queue[at]!;
      rows[i] = { ...rows[i]!, state: "running", message: null };
      emit();
      rows[i] = await applyBulkRow(intent, rows[i]!, writer);
      emit();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return rows;
}

/* ------------------------------------------------------------------ *
 * reporting
 * ------------------------------------------------------------------ */

interface BulkSummary {
  total: number;
  done: number;
  conflicts: number;
  failed: number;
  skipped: number;
  pending: number;
  /** every row reached a terminal state. */
  finished: boolean;
}

export function summarizeBulk(rows: readonly BulkRow[]): BulkSummary {
  let done = 0;
  let conflicts = 0;
  let failed = 0;
  let skipped = 0;
  let pending = 0;
  for (const r of rows) {
    if (r.state === "done") done += 1;
    else if (r.state === "conflict") conflicts += 1;
    else if (r.state === "error") failed += 1;
    else if (r.state === "skipped") skipped += 1;
    else pending += 1;
  }
  return {
    total: rows.length,
    done,
    conflicts,
    failed,
    skipped,
    pending,
    finished: pending === 0,
  };
}

/**
 * The sentence under the progress rows. It always leads with the count that
 * actually landed — "12 of 14" is the true statement, and a bar that said
 * "done" over two failures would be lying about a write.
 */
export function bulkSummaryLine(summary: BulkSummary): string {
  const parts: string[] = [`${summary.done} of ${summary.total} written`];
  if (summary.conflicts > 0) {
    parts.push(`${summary.conflicts} changed underneath you`);
  }
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.pending > 0) parts.push(`${summary.pending} still going`);
  return parts.join(" · ");
}

/** What the confirm step says out loud before anything is written. */
export function confirmLine(intent: BulkIntent, count: number): string {
  const objects = `${count} object${count === 1 ? "" : "s"}`;
  if (intent.kind === "link") {
    const target = intent.toTitle ?? intent.to;
    return `Link ${objects} to “${target}” with the verb “${intent.rel}”. One write each; nothing is undone automatically.`;
  }
  if (intent.value === null) {
    return `Clear “${intent.key}” on ${objects}. One write each, each against its own version; nothing is undone automatically.`;
  }
  return `Set “${intent.key}” to ${JSON.stringify(intent.value)} on ${objects}. One write each, each against its own version; nothing is undone automatically.`;
}

/* ------------------------------------------------------------------ *
 * who may do what
 * ------------------------------------------------------------------ */

/**
 * A viewer sees the selection and may open it; the mutating actions are not
 * rendered at all. A disabled button that explains a viewer cannot press it
 * is worse than no button — it advertises an action their account will never
 * have. The demo bundle has no backend to write to, so it is read-only too.
 */
export function canBulkMutate(user: Pick<Whoami, "role"> | null | undefined): boolean {
  if (!user) return false;
  if (isDemo()) return false;
  return user.role !== "viewer";
}
