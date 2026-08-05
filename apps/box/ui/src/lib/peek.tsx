/**
 * Side-peek store — the URL is the store.
 *
 * A peek is "this object, open over whatever I was already looking at". The
 * only place that state lives is the `?peek=<id>[,<id>…]` search param on the
 * CURRENT route, which buys four things no component-local state can:
 *
 *  1. **It is linkable.** Paste the URL to a coworker and they land on the same
 *     table, same filters, same object open beside it.
 *  2. **It survives reload** without changing the underlying route — the table
 *     underneath re-renders from its own params, so nothing about the caller's
 *     scroll/camera is expressed here and nothing about it is disturbed.
 *  3. **Back closes it.** Opening PUSHES a history entry; closing REPLACES the
 *     current one. So `A → open → close` leaves one entry per view state and
 *     Back from an open peek lands exactly where the peek was opened from.
 *  4. **It is a stack.** Phase 6's "open all" over a graph selection pushes
 *     several ids at once; the peek shows the top and keeps the rest behind it,
 *     so closing walks back down instead of losing the pile.
 *
 * Hostile-URL rules, because this param is user-suppliable: ids are validated
 * against a conservative token shape (no commas, no path/quote characters) and
 * the stack is capped at `MAX_PEEK_DEPTH`. Nothing here reads brain content, so
 * an id that does not exist (or that the caller may not see) is just a peek
 * that renders "you can't see this" — the box's RLS-bound read is, as always,
 * the boundary; this file is chrome.
 *
 * Dirty state is flushed BEFORE a peek closes. The panel registers its save
 * queue's flush here (`registerPeekFlush`) and `closePeek()` kicks it. The
 * kick is deliberately not awaited: the queue outlives the unmount (it is
 * disposed only after its own flush settles, exactly as the object page does),
 * so making the UI wait on the network to close a panel would buy nothing.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";

/** The search param that carries the stack. */
export const PEEK_PARAM = "peek";

/** A URL cannot be allowed to mount an unbounded number of live editors. */
export const MAX_PEEK_DEPTH = 8;

/** Conservative id shape — object ids are uuids; anything else is ignored. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* --------------------------------------------------------------- pure parts */

/** Read the stack (bottom → top) out of a search string or params. */
export function parsePeekStack(search: string | URLSearchParams): readonly string[] {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const raw = params.get(PEEK_PARAM);
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!ID_RE.test(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_PEEK_DEPTH) break;
  }
  return out;
}

/** The param value for a stack — empty string means "no param at all". */
export function serializePeekStack(stack: readonly string[]): string {
  return stack.join(",");
}

/** Push an id: an id already in the stack MOVES to the top rather than
 *  appearing twice (two live editors on one object would fight each other). */
export function pushPeek(stack: readonly string[], id: string): readonly string[] {
  if (!ID_RE.test(id)) return stack;
  const next = stack.filter((x) => x !== id);
  next.push(id);
  return next.length > MAX_PEEK_DEPTH ? next.slice(next.length - MAX_PEEK_DEPTH) : next;
}

/** Pop the top of the stack. */
export function popPeek(stack: readonly string[]): readonly string[] {
  return stack.slice(0, Math.max(0, stack.length - 1));
}

/** Apply a stack to a set of params, leaving every OTHER param untouched. */
export function withPeekStack(params: URLSearchParams, stack: readonly string[]): URLSearchParams {
  const next = new URLSearchParams(params);
  const value = serializePeekStack(stack);
  if (value) next.set(PEEK_PARAM, value);
  else next.delete(PEEK_PARAM);
  return next;
}

/* --------------------------------------------------------- flush registry */

type PeekFlush = () => void | Promise<void>;

const flushes = new Map<string, Set<PeekFlush>>();

/**
 * Register a "there may be unsaved text here" flush for an object open in a
 * peek. Returns the unregister function; call it on unmount.
 */
export function registerPeekFlush(objectId: string, flush: PeekFlush): () => void {
  const set = flushes.get(objectId) ?? new Set<PeekFlush>();
  set.add(flush);
  flushes.set(objectId, set);
  return () => {
    const current = flushes.get(objectId);
    if (!current) return;
    current.delete(flush);
    if (current.size === 0) flushes.delete(objectId);
  };
}

/** Kick every registered flush for one object. Never throws at the caller. */
export function flushPeek(objectId: string | null): void {
  if (!objectId) return;
  for (const flush of flushes.get(objectId) ?? []) {
    try {
      void flush();
    } catch {
      /* a flush that cannot even be started must not block closing */
    }
  }
}

/** Kick every registered flush, whatever object it belongs to. */
export function flushAllPeeks(): void {
  for (const id of [...flushes.keys()]) flushPeek(id);
}

/** Test seam: drop every registration (the module store is process-wide). */
export function resetPeekFlushes(): void {
  flushes.clear();
}

/* -------------------------------------------------------------- the store */

interface PeekApi {
  /** bottom → top; the last entry is what the panel shows */
  stack: readonly string[];
  /** the object currently on screen in the peek, or null */
  top: string | null;
  depth: number;
  isOpen: boolean;
  isPeeking(id: string): boolean;
  /** open one object over the current route (pushes a history entry) */
  openPeek(id: string): void;
  /** phase 6's "open all": push a whole selection at once, last one on top */
  openPeekAll(ids: readonly string[]): void;
  /** close the top one, flushing it first */
  closePeek(): void;
  /** close the whole stack, flushing all of it first */
  closeAllPeeks(): void;
}

const PeekContext = createContext<PeekApi | null>(null);

function usePeekStore(): PeekApi {
  const [params, setParams] = useSearchParams();
  const location = useLocation();

  const stack = useMemo(() => parsePeekStack(params), [params]);

  const apply = useCallback(
    (next: readonly string[], replace: boolean) => {
      setParams((prev) => withPeekStack(prev, next), { replace });
    },
    [setParams],
  );

  const openPeek = useCallback(
    (id: string) => {
      // Peeking the page you are already on is a no-op, not a doubled editor:
      // the graph and the tables both hand ids in blind.
      if (location.pathname === `/o/${id}`) return;
      apply(pushPeek(parsePeekStack(params), id), false);
    },
    [apply, location.pathname, params],
  );

  const openPeekAll = useCallback(
    (ids: readonly string[]) => {
      let next = parsePeekStack(params);
      for (const id of ids) {
        if (location.pathname === `/o/${id}`) continue;
        next = pushPeek(next, id);
      }
      if (next.length === 0) return;
      apply(next, false);
    },
    [apply, location.pathname, params],
  );

  const closePeek = useCallback(() => {
    const current = parsePeekStack(params);
    if (current.length === 0) return;
    flushPeek(current[current.length - 1] ?? null);
    apply(popPeek(current), true);
  }, [apply, params]);

  const closeAllPeeks = useCallback(() => {
    const current = parsePeekStack(params);
    if (current.length === 0) return;
    for (const id of current) flushPeek(id);
    apply([], true);
  }, [apply, params]);

  const isPeeking = useCallback((id: string) => stack.includes(id), [stack]);

  return useMemo(
    () => ({
      stack,
      top: stack.length > 0 ? (stack[stack.length - 1] ?? null) : null,
      depth: stack.length,
      isOpen: stack.length > 0,
      isPeeking,
      openPeek,
      openPeekAll,
      closePeek,
      closeAllPeeks,
    }),
    [stack, isPeeking, openPeek, openPeekAll, closePeek, closeAllPeeks],
  );
}

/**
 * Optional provider. The store derives from the URL, so `usePeek()` works with
 * or without it; mounting the provider high up just means one subscription
 * instead of one per consumer.
 */
export function PeekProvider({ children }: { children: ReactNode }) {
  const api = usePeekStore();
  return <PeekContext.Provider value={api}>{children}</PeekContext.Provider>;
}

/** The peek store. Must be called under a router; a provider is optional. */
export function usePeek(): PeekApi {
  // Both are unconditional on purpose — a hook cannot be called behind an `if`.
  const own = usePeekStore();
  const shared = useContext(PeekContext);
  return shared ?? own;
}
