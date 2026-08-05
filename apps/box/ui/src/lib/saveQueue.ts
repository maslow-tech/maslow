/**
 * Per-object save queue: the client half of the CAS write path.
 *
 * Pure logic — no React, no direct fetch on the normal path. The transport is
 * injected (`save`, and `sendBeacon` for the tab-close case) so every rule below
 * is unit-testable without a server.
 *
 * The rules, each of which the design spec pins for a reason:
 *
 *  - **Debounced ~1s, flushed on blur/navigate.** `flushBeacon()` is the
 *    tab-close path and CANNOT observe a response: the page is gone before a
 *    409 could be read, and `keepalive` is capped at 64KB per origin, so a long
 *    body plus props is rejected outright. Hence **mirror first, then send** —
 *    the draft is in local storage BEFORE the fetch is issued, and delivery is
 *    never assumed. Reconciliation happens at next load via draftMirror.
 *  - **One in-flight save per object.** Edits during flight coalesce into the
 *    next patch instead of racing it.
 *  - **Field-granular.** Only changed fields are sent (props key by key), so two
 *    people editing disjoint fields merge cleanly. CAS is still object-scoped,
 *    which is why the rebase below exists.
 *  - **409 with a version ⇒ automatic rebase.** Compare OUR changed fields
 *    across base-vs-server. Untouched on the server ⇒ reapply on the new
 *    baseVersion and retry (jittered backoff). Server already holds our value ⇒
 *    the save landed and the response was lost; treat as success. Someone else
 *    changed a field WE changed ⇒ stop immediately, keep the local draft, emit
 *    `conflict`; never auto-merge, never clobber.
 *  - **Rebase exhaustion is explicit.** After `maxRebaseAttempts` we emit BOTH
 *    `conflict` and `reverted` — the caller shows the banner AND visibly rolls
 *    the optimistic change back (the dragged card snaps home). Never a silent
 *    revert; never a card the user believes is saved but isn't.
 *  - **409 with `reason` (phase 2's `open_in_editor`) ⇒ do NOT rebase.** The
 *    live room owns those fields; retrying the same patch just loses again. We
 *    surface a distinct `locked` state and stop.
 *  - **`suspend(fields)` / `resume()`** for exactly that case: while a collab
 *    room owns body/title, the queue holds those fields back and keeps saving
 *    everything else.
 */
import {
  ConflictError,
  type ConflictSnapshot,
  type PatchObjectInput,
  type WriteResult,
} from "./api";
import type { DraftFields } from "./draftMirror";

export type { DraftFields };

/** What we believe the server holds for the fields we care about — the snapshot
 *  a rebase compares against. */
export interface BaseSnapshot {
  title: string | null;
  body: string | null;
  props: Record<string, unknown>;
}

export type SaveEvent =
  /** nothing pending, nothing in flight — safe to navigate */
  | { kind: "idle" }
  /** local changes buffered, not yet sent */
  | { kind: "dirty"; fields: string[] }
  | { kind: "saving"; fields: string[]; attempt: number }
  | { kind: "saved"; version: number }
  /** a 409 was rebased onto a newer version and will be retried */
  | { kind: "rebasing"; baseVersion: number; attempt: number }
  /** someone else owns a field we changed (or we ran out of rebases). The local
   *  draft is KEPT — the caller shows keep-mine / take-theirs / diff. */
  | {
      kind: "conflict";
      current: ConflictSnapshot | null;
      currentVersion: number | null;
      fields: string[];
    }
  /** always paired with `conflict` on rebase exhaustion: roll the optimistic UI
   *  back to these (server) values. */
  | { kind: "reverted"; fields: DraftFields }
  /** 409 `{ reason }` — the collab room owns the field, route through the editor */
  | { kind: "locked"; reason: string; fields: string[] }
  | { kind: "error"; status: number | null; message: string };

export type ConflictEvent = Extract<SaveEvent, { kind: "conflict" }>;

export interface SaveQueueMirror {
  write(fields: DraftFields, baseVersion: number): void;
  clear(): void;
}

export interface BeaconRequest {
  objectId: string;
  patch: PatchObjectInput;
}

export interface SaveQueueOptions {
  objectId: string;
  /** the version our current field values were read at */
  baseVersion: number;
  /** server values for the fields we may touch; rebase compares against it */
  base?: Partial<BaseSnapshot>;
  save(patch: PatchObjectInput, baseVersion: number): Promise<WriteResult>;
  /** tab-close transport. Called AFTER the mirror write, always. */
  sendBeacon?(req: BeaconRequest): void;
  onState?(event: SaveEvent): void;
  onConflict?(event: ConflictEvent): void;
  /** local draft mirror; omitted in tests that only exercise the wire */
  mirror?: SaveQueueMirror;
  debounceMs?: number;
  /** rebase retries after the first 409 (default 3) */
  maxRebaseAttempts?: number;
  /** injectable for tests: backoff sleep */
  wait?(ms: number): Promise<void>;
  /** injectable for tests: jitter source */
  random?(): number;
}

export interface SaveQueue {
  /** buffer a field-granular change and (re)start the debounce */
  change(fields: DraftFields): void;
  /** send now; resolves when the queue is drained or has stopped on a conflict */
  flush(): Promise<void>;
  /** tab-close/pagehide: mirror first, then a best-effort keepalive send */
  flushBeacon(): void;
  /** phase 2: the collab room owns these fields — hold them back */
  suspend(fields: string[]): void;
  resume(): void;
  /** phase 2: remove and return the buffered body/title so the collab session
   *  can hand a user's pre-first-sync edits to the CRDT instead of letting
   *  `resume` flush them as a doomed 409 `open_in_editor`. Null when neither is
   *  buffered. Props/visibility are left untouched. */
  takeRoomContent(): { title?: string; body?: string } | null;
  /** adopt a server version we learned about elsewhere (feed poll, re-read) */
  rebaseOnto(version: number, snapshot: Partial<BaseSnapshot>): void;
  /** drop buffered changes without sending (caller took "take theirs") */
  discard(): void;
  hasPending(): boolean;
  baseVersion(): number;
  pendingFields(): string[];
  dispose(): void;
}

// ---- field paths ---------------------------------------------------------
// "title" | "body" | "visibility" | "props.<key>" — the granularity a rebase
// reasons about, so two people editing different props do not read as a
// same-field conflict just because both touched `props`.

function pathsOf(fields: DraftFields): string[] {
  const out: string[] = [];
  if ("title" in fields) out.push("title");
  if ("body" in fields) out.push("body");
  if ("visibility" in fields) out.push("visibility");
  for (const k of Object.keys(fields.props ?? {})) out.push(`props.${k}`);
  return out;
}

function valueAt(
  source: Partial<BaseSnapshot> | ConflictSnapshot | DraftFields,
  path: string,
): unknown {
  if (path.startsWith("props.")) {
    const props = (source as { props?: Record<string, unknown> }).props;
    return props ? props[path.slice(6)] : undefined;
  }
  return (source as Record<string, unknown>)[path];
}

/** A missing key and an explicit null are the same absence: `props: { x: null }`
 *  DELETES x, and the server then reports x as absent. */
function same(a: unknown, b: unknown): boolean {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === nb) return true;
  if (na === null || nb === null) return false;
  if (typeof na === "object" || typeof nb === "object") {
    try {
      return JSON.stringify(na) === JSON.stringify(nb);
    } catch {
      return false;
    }
  }
  return false;
}

function mergeFields(into: DraftFields, from: DraftFields): DraftFields {
  const out: DraftFields = { ...into, ...from };
  if (into.props || from.props) out.props = { ...(into.props ?? {}), ...(from.props ?? {}) };
  return out;
}

function isEmpty(fields: DraftFields): boolean {
  return pathsOf(fields).length === 0;
}

/** Split off the fields a collab room currently owns. */
function partition(
  fields: DraftFields,
  suspended: Set<string>,
): { send: DraftFields; held: DraftFields } {
  if (suspended.size === 0) return { send: fields, held: {} };
  const send: DraftFields = {};
  const held: DraftFields = {};
  for (const path of pathsOf(fields)) {
    const target = suspended.has(path) ? held : send;
    if (path.startsWith("props.")) {
      const key = path.slice(6);
      target.props = { ...(target.props ?? {}), [key]: fields.props?.[key] };
    } else {
      (target as Record<string, unknown>)[path] = valueAt(fields, path);
    }
  }
  return { send, held };
}

function toPatch(fields: DraftFields, baseVersion: number): PatchObjectInput {
  const patch: PatchObjectInput = { baseVersion };
  if ("title" in fields) patch.title = fields.title ?? null;
  if ("body" in fields) patch.body = fields.body ?? "";
  if ("visibility" in fields) patch.visibility = fields.visibility;
  if (fields.props) patch.props = { ...fields.props };
  return patch;
}

type Verdict = "landed" | "rebase" | "conflict";

/**
 * The whole rebase decision, per field:
 *   server == ours  → that field already holds our value (our save landed and
 *                     the response was lost, or someone typed the same thing)
 *   server == base  → nobody touched it; safe to reapply on the new version
 *   otherwise       → a TRUE same-field conflict: stop, keep the draft, ask.
 */
function classifyConflict(
  ours: DraftFields,
  base: Partial<BaseSnapshot>,
  current: ConflictSnapshot,
): Verdict {
  let allLanded = true;
  for (const path of pathsOf(ours)) {
    const mine = valueAt(ours, path);
    const theirs = valueAt(current, path);
    if (same(theirs, mine)) continue;
    allLanded = false;
    if (same(theirs, valueAt(base, path))) continue;
    return "conflict";
  }
  return allLanded ? "landed" : "rebase";
}

function defaultBeacon(req: BeaconRequest): void {
  // Duplicated (rather than imported) csrf read: api.ts's helper is private and
  // this is the one request that must not go through its response handling —
  // there is no response to handle.
  const csrf =
    typeof document !== "undefined"
      ? (document.cookie.match(/(?:^|; )brain_csrf=([^;]*)/)?.[1] ?? "")
      : "";
  try {
    void fetch(`/api/v1/objects/${req.objectId}`, {
      method: "PATCH",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(req.patch),
    }).catch(() => {
      // Over the 64KB keepalive cap, or the page died mid-flight. The mirror
      // already has the text — that is the whole point of writing it first.
    });
  } catch {
    /* same */
  }
}

export function createSaveQueue(opts: SaveQueueOptions): SaveQueue {
  const debounceMs = opts.debounceMs ?? 1000;
  const maxRebaseAttempts = opts.maxRebaseAttempts ?? 3;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const beacon = opts.sendBeacon ?? defaultBeacon;

  let baseVersion = opts.baseVersion;
  let base: Partial<BaseSnapshot> = { ...(opts.base ?? {}) };
  let pending: DraftFields = {};
  let inflight: DraftFields | null = null;
  const suspended = new Set<string>();
  /** set when we stop on a conflict/lock/error — cleared by the next edit, so a
   *  user who keeps typing after "keep mine" resumes saving. */
  let blocked = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pumping: Promise<void> | null = null;

  function emit(event: SaveEvent): void {
    opts.onState?.(event);
    if (event.kind === "conflict") opts.onConflict?.(event);
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function unsentFields(): DraftFields {
    return inflight ? mergeFields(inflight, pending) : pending;
  }

  function hasPending(): boolean {
    return !isEmpty(unsentFields());
  }

  function mirrorNow(): void {
    const fields = unsentFields();
    if (isEmpty(fields)) return;
    opts.mirror?.write(fields, baseVersion);
  }

  function applyToBase(fields: DraftFields): void {
    if ("title" in fields) base.title = fields.title ?? null;
    if ("body" in fields) base.body = fields.body ?? "";
    if (fields.props) base.props = { ...(base.props ?? {}), ...fields.props };
  }

  function baseValuesFor(fields: DraftFields): DraftFields {
    const out: DraftFields = {};
    for (const path of pathsOf(fields)) {
      if (path.startsWith("props.")) {
        const key = path.slice(6);
        out.props = { ...(out.props ?? {}), [key]: base.props?.[key] ?? null };
      } else if (path === "title") {
        out.title = base.title ?? null;
      } else if (path === "body") {
        out.body = base.body ?? "";
      }
    }
    return out;
  }

  function backoff(attempt: number): number {
    // 60ms, 120ms, 240ms … with ±50% jitter, so two clients fighting over the
    // same object do not retry in lockstep forever.
    const flat = 60 * 2 ** (attempt - 1);
    return Math.round(flat * (0.5 + random()));
  }

  function ack(version: number): void {
    baseVersion = version;
    if (inflight) applyToBase(inflight);
    inflight = null;
    emit({ kind: "saved", version });
    if (!hasPending()) {
      opts.mirror?.clear();
      emit({ kind: "idle" });
    }
  }

  async function attemptOnce(): Promise<void> {
    let attempt = 0;
    for (;;) {
      if (disposed || inflight === null) return;
      emit({ kind: "saving", fields: pathsOf(inflight), attempt: attempt + 1 });
      try {
        const res = await opts.save(toPatch(inflight, baseVersion), baseVersion);
        ack(res.version);
        return;
      } catch (err) {
        if (disposed) return;
        if (!(err instanceof ConflictError)) {
          const status =
            err instanceof Error && "status" in err
              ? Number((err as { status: unknown }).status)
              : null;
          // Never a blind retry: the caller re-reads and rebases. The draft
          // (and its mirror) stay exactly as they are.
          blocked = true;
          emit({
            kind: "error",
            status: Number.isFinite(status) ? status : null,
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        const fields = inflight ? pathsOf(inflight) : [];
        if (err.reason) {
          // open_in_editor: the room owns the field. Nothing to rebase onto.
          blocked = true;
          emit({ kind: "locked", reason: err.reason, fields });
          return;
        }
        if (err.currentVersion === null || err.current === null) {
          blocked = true;
          emit({
            kind: "conflict",
            current: err.current,
            currentVersion: err.currentVersion,
            fields,
          });
          return;
        }
        const verdict = classifyConflict(inflight ?? {}, base, err.current);
        if (verdict === "landed") {
          // Our write is already on the server; the lost response was the only
          // failure. Adopt the version and treat it as the success it was.
          ack(err.currentVersion);
          return;
        }
        if (verdict === "conflict") {
          blocked = true;
          emit({
            kind: "conflict",
            current: err.current,
            currentVersion: err.currentVersion,
            fields,
          });
          return;
        }
        attempt += 1;
        if (attempt > maxRebaseAttempts) {
          // Exhausted. BOTH events, always: the banner AND the visible rollback.
          const reverted = baseValuesFor(inflight ?? {});
          blocked = true;
          emit({
            kind: "conflict",
            current: err.current,
            currentVersion: err.currentVersion,
            fields,
          });
          emit({ kind: "reverted", fields: reverted });
          inflight = null;
          pending = {};
          return;
        }
        baseVersion = err.currentVersion;
        base = {
          title: err.current.title,
          body: err.current.body,
          props: { ...err.current.props },
        };
        emit({ kind: "rebasing", baseVersion, attempt });
        await wait(backoff(attempt));
        if (disposed) return;
        // Coalesce anything typed while we were losing.
        if (!isEmpty(pending)) {
          inflight = mergeFields(inflight ?? {}, pending);
          pending = {};
        }
      }
    }
  }

  async function pump(): Promise<void> {
    while (!disposed && !blocked && (inflight !== null || !isEmpty(pending))) {
      if (inflight === null) {
        const { send, held } = partition(pending, suspended);
        pending = held;
        if (isEmpty(send)) return; // everything suspended — the room owns it
        inflight = send;
      } else if (!isEmpty(pending)) {
        // A retry after the user kept typing (or after a conflict they typed
        // through): coalesce rather than send a stale patch.
        const { send, held } = partition(mergeFields(inflight, pending), suspended);
        pending = held;
        inflight = isEmpty(send) ? null : send;
        if (inflight === null) return;
      }
      await attemptOnce();
    }
  }

  function kick(): Promise<void> {
    if (!pumping) {
      pumping = pump().finally(() => {
        pumping = null;
      });
    }
    return pumping;
  }

  function schedule(): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void kick();
    }, debounceMs);
  }

  return {
    change(fields: DraftFields): void {
      if (disposed || isEmpty(fields)) return;
      pending = mergeFields(pending, fields);
      // A fresh edit clears a stopped queue: the user made a new decision.
      blocked = false;
      mirrorNow();
      emit({ kind: "dirty", fields: pathsOf(unsentFields()) });
      schedule();
    },

    async flush(): Promise<void> {
      clearTimer();
      // Loop: a change that arrives between the pump's last check and its
      // resolution would otherwise sit until the next debounce.
      for (let guard = 0; guard < 100; guard += 1) {
        if (disposed || blocked) return;
        if (inflight === null && isEmpty(pending)) return;
        await kick();
      }
    },

    flushBeacon(): void {
      clearTimer();
      const fields = unsentFields();
      if (isEmpty(fields)) return;
      // MIRROR FIRST, THEN SEND. The page is about to die and keepalive is
      // capped at 64KB per origin, so this fetch may never be issued at all.
      // The mirror is the only thing guaranteed to survive; it is reconciled at
      // next load and is never cleared here, because delivery is never assumed.
      opts.mirror?.write(fields, baseVersion);
      const { send } = partition(fields, suspended);
      if (isEmpty(send)) return;
      beacon({ objectId: opts.objectId, patch: toPatch(send, baseVersion) });
    },

    suspend(fields: string[]): void {
      for (const f of fields) suspended.add(f);
    },

    resume(): void {
      suspended.clear();
      if (hasPending()) schedule();
    },

    takeRoomContent(): { title?: string; body?: string } | null {
      const merged = unsentFields();
      const out: { title?: string; body?: string } = {};
      let any = false;
      // A cleared title is `null` on the wire; the CRDT title is a plain string,
      // so map the delete sentinel to "" for `writeRoomContent`.
      if ("title" in merged) {
        out.title = merged.title ?? "";
        any = true;
      }
      if ("body" in merged) {
        out.body = merged.body ?? "";
        any = true;
      }
      if (!any) return null;
      // Strip body/title from BOTH buffers so `resume` cannot flush them: the
      // room owns them now, and the box would 409 the PATCH. Suspended fields
      // never reach `inflight` (partition holds them in `pending`), but strip it
      // too for safety. Props/visibility ride along in `pending` untouched.
      const strip = (fields: DraftFields | null): DraftFields | null => {
        if (!fields) return fields;
        const { title: _title, body: _body, ...rest } = fields;
        return rest;
      };
      pending = strip(pending) ?? {};
      inflight = strip(inflight);
      // The body/title we just handed to the collab session were ALSO written to
      // the CAS draft mirror by the earlier `change()`/`flushBeacon` call (the
      // mirror always holds `unsentFields`). Ownership of them now transfers to
      // the collab buffer — so rewrite the mirror WITHOUT them. Left behind, that
      // stale `{body,title}` (stamped at the pre-sync baseVersion) is never acked
      // and never cleared once the queue goes idle: on the next mount its version
      // has advanced, so `applicability` returns "offer" and a phantom "unsaved
      // changes" banner appears for text that is already saved — and Restore
      // would revert newer edits. Keep whatever else is still pending (props /
      // visibility); clear the mirror entirely when nothing is.
      const remaining = unsentFields();
      if (isEmpty(remaining)) opts.mirror?.clear();
      else opts.mirror?.write(remaining, baseVersion);
      return out;
    },

    rebaseOnto(version: number, snapshot: Partial<BaseSnapshot>): void {
      baseVersion = version;
      base = { ...base, ...snapshot, props: { ...(base.props ?? {}), ...(snapshot.props ?? {}) } };
      blocked = false;
    },

    discard(): void {
      clearTimer();
      pending = {};
      inflight = null;
      blocked = false;
      opts.mirror?.clear();
      emit({ kind: "idle" });
    },

    hasPending,
    baseVersion: () => baseVersion,
    pendingFields: () => pathsOf(unsentFields()),

    dispose(): void {
      disposed = true;
      clearTimer();
    },
  };
}
