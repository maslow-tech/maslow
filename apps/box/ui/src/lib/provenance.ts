import type { History } from "./api";
import { diffTokens, wordTokens } from "./diff";

/**
 * Resolves "who changed this word/property, when, and why" from the same
 * before_image + events data `history()` already returns — no backend
 * round-trip per hover. Reuses the same word tokenizer/diff (lib/diff.ts)
 * the rich history dialog uses, so origins and the visible diff always agree.
 */

export type HistoryVersion = History["versions"][number];
export type HistoryEvent = History["events"][number];

export interface Attribution {
  actor: string | null;
  actorName: string | null;
  at: string;
  reason: string | null;
}

function toAttribution(e: HistoryEvent): Attribution {
  const reason = e.payload?.["reason"];
  return {
    actor: e.actor,
    actorName: e.actor_name,
    at: e.at,
    reason: typeof reason === "string" ? reason : null,
  };
}

function buildReasonByVersion(events: readonly HistoryEvent[]): Map<number, Attribution> {
  const map = new Map<number, Attribution>();
  for (const e of events) {
    if (e.kind !== "create" && e.kind !== "update") continue;
    const v = e.payload?.["version"];
    if (typeof v !== "number") continue;
    map.set(v, toAttribution(e));
  }
  return map;
}

/** Who made the edit that produced `version`, and why (from its create/update event). */
export function reasonForVersion(
  version: number,
  events: readonly HistoryEvent[],
): Attribution | null {
  return buildReasonByVersion(events).get(version) ?? null;
}

/** Who set the CURRENT value of property `key`, and why — straight from the
 *  update_props event that changed it (0013/0026 carry old/new + reason). */
export function attributeProp(key: string, events: readonly HistoryEvent[]): Attribution | null {
  const propEvents = events
    .filter((e) => e.kind === "update_props")
    .filter((e) => {
      const changed = e.payload?.["changed"] as Record<string, unknown> | undefined;
      return changed !== undefined && Object.prototype.hasOwnProperty.call(changed, key);
    })
    .sort((a, b) => Number(b.seq) - Number(a.seq));
  if (propEvents.length > 0) return toAttribution(propEvents[0]!);
  const create = events.find((e) => e.kind === "create");
  return create ? toAttribution(create) : null;
}

export interface PropChange {
  key: string;
  old: unknown;
  new: unknown;
}

/**
 * Groups update_props events by the object version their transaction produced,
 * for rendering alongside the title/body diff of the same edit in the history
 * dialog.
 *
 * Since 0027, brain_prop_audit stamps payload.version directly (an exact
 * lookup against objects.version in the same transaction) — use that when
 * present. Events recorded before 0027 don't have it (historical rows are
 * never rewritten), so those fall back to matching the nearest preceding
 * create/update event on the same object by seq — a best-effort heuristic
 * that's not guaranteed correct under concurrent editors, which is exactly
 * why 0027 replaced it going forward.
 */
export function propsChangesByVersion(
  events: readonly HistoryEvent[],
): Map<number, { changes: PropChange[]; attribution: Attribution }> {
  const objectEvents = events
    .filter(
      (e) =>
        (e.kind === "create" || e.kind === "update") && typeof e.payload?.["version"] === "number",
    )
    .sort((a, b) => Number(a.seq) - Number(b.seq));

  const nearestPrecedingVersion = (eSeq: number): number | undefined => {
    let matched: HistoryEvent | null = null;
    for (const oe of objectEvents) {
      if (Number(oe.seq) <= eSeq) matched = oe;
      else break;
    }
    return matched ? (matched.payload!["version"] as number) : undefined;
  };

  const result = new Map<number, { changes: PropChange[]; attribution: Attribution }>();
  for (const e of events) {
    if (e.kind !== "update_props") continue;
    const changed = e.payload?.["changed"] as
      Record<string, { old: unknown; new: unknown }> | undefined;
    if (!changed) continue; // {private: true} redaction — nothing to show

    const stampedVersion = e.payload?.["version"];
    const version =
      typeof stampedVersion === "number" ? stampedVersion : nearestPrecedingVersion(Number(e.seq));
    if (version === undefined) continue;

    const changes = Object.entries(changed).map(([key, { old, new: n }]) => ({ key, old, new: n }));
    const existing = result.get(version);
    if (existing) existing.changes.push(...changes);
    else result.set(version, { changes, attribution: toAttribution(e) });
  }
  return result;
}

/** -1 sentinel = "present since creation" (attribute to the create event). */
const SINCE_CREATION = -1;

// diffTokens is an O(n*m) time+space LCS — a near-1MB body (the write-path
// cap) tokenizes into ~150k+ words, and 150k x 150k is billions of DP cells:
// enough to hang the tab, not just run slowly. Cap the product and fall back
// to a coarse (still correct, just not word-precise) attribution above it.
const MAX_DIFF_CELLS = 25_000_000; // ~5000 tokens/side; comfortably fast, still far above typical bodies

function propagateOrigins(
  oldTokens: readonly string[],
  oldOrigins: readonly number[],
  newTokens: readonly string[],
  transitionVersion: number,
): number[] {
  if (oldTokens.length * newTokens.length > MAX_DIFF_CELLS) {
    // Too large to LCS word-by-word. If the content is byte-identical,
    // origins carry over unchanged; otherwise attribute the whole new body
    // to this transition rather than freezing the tab computing precision
    // nobody asked for on a body this size.
    if (oldTokens.length === newTokens.length && oldTokens.every((t, i) => t === newTokens[i])) {
      return [...oldOrigins];
    }
    return newTokens.map(() => transitionVersion);
  }
  const ops = diffTokens([...oldTokens], [...newTokens]);
  const newOrigins: number[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === "same") {
      newOrigins.push(oldOrigins[oi]!);
      oi++;
    } else if (op.kind === "del") {
      oi++;
    } else {
      newOrigins.push(transitionVersion);
    }
  }
  return newOrigins;
}

/** Per-token attribution for the CURRENT body, oldest content first. */
export function attributeBody(
  currentBody: string | null,
  versions: readonly HistoryVersion[],
  events: readonly HistoryEvent[],
): Array<{ token: string; isWord: boolean; attribution: Attribution | null }> {
  const reasonByVersion = buildReasonByVersion(events);
  // before_image.version is a Postgres bigint — the pg driver (and thus the
  // JSON over the wire) returns it as a string despite the declared `number`
  // type, so every arithmetic use below normalizes with Number() first (a
  // bare `v.version + 1` silently string-concatenates instead of adding).
  const sortedAsc = [...versions]
    .map((v) => ({ ...v, version: Number(v.version) }))
    .sort((a, b) => a.version - b.version);

  let tokens = wordTokens(sortedAsc[0]?.snapshot.body ?? currentBody ?? "");
  let origins: number[] = tokens.map(() => SINCE_CREATION);

  // Exactly one transition per recorded version — the loop is a no-op (and
  // correctly so) when the body has never been edited.
  for (let idx = 0; idx < sortedAsc.length; idx++) {
    const nextBody = idx + 1 < sortedAsc.length ? sortedAsc[idx + 1]!.snapshot.body : currentBody;
    const nextTokens = wordTokens(nextBody ?? "");
    const transitionVersion = sortedAsc[idx]!.version + 1;
    origins = propagateOrigins(tokens, origins, nextTokens, transitionVersion);
    tokens = nextTokens;
  }

  return tokens.map((token, i) => {
    const originVersion = origins[i]!;
    const attribution =
      originVersion === SINCE_CREATION
        ? (reasonByVersion.get(1) ?? null)
        : (reasonByVersion.get(originVersion) ?? null);
    return { token, isWord: token.trim().length > 0, attribution };
  });
}

export interface AttributionRun {
  /** Character offset into the CURRENT body where this run starts. */
  start: number;
  /** Character offset where this run ends (exclusive). */
  end: number;
  text: string;
  attribution: Attribution | null;
}

/**
 * attributeBody's tokens, merged into maximal contiguous runs of the same
 * origin — one hoverable unit per edit that touched a span, not one per word.
 * Reference equality on `attribution` is safe here: attributeBody resolves it
 * from a Map keyed by origin version, so every token from the same edit
 * shares the exact same object.
 */
export function attributionRuns(
  currentBody: string | null,
  versions: readonly HistoryVersion[],
  events: readonly HistoryEvent[],
): AttributionRun[] {
  const tokens = attributeBody(currentBody, versions, events);
  const runs: AttributionRun[] = [];
  let offset = 0;
  for (const t of tokens) {
    const last = runs[runs.length - 1];
    if (last && last.attribution === t.attribution) {
      last.text += t.token;
      last.end += t.token.length;
    } else {
      runs.push({
        start: offset,
        end: offset + t.token.length,
        text: t.token,
        attribution: t.attribution,
      });
    }
    offset += t.token.length;
  }
  return runs;
}
