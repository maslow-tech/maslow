/**
 * Saved views — the member's own named view configs, and the pinned ones that
 * ride in the sidebar.
 *
 * Two surfaces, one store:
 *
 *  - `<SavedViews>` sits in the TypeView toolbar: save the view on screen under
 *    a name, pick a saved one, rename it, pin it, delete it.
 *  - `<PinnedViews>` is the sidebar block (mounted by the chrome task) listing
 *    the pinned ones, drag- and keyboard-reorderable.
 *
 * Five rules earn their keep:
 *
 *  1. **The config is opaque here.** This file never looks inside a view's
 *     config. Phase 4 stores a database `ViewConfig`; phase 6 stores a graph
 *     view (filters, forces, camera, focus) in the SAME table under
 *     `kind: "graph"` — so this component is reused verbatim by passing
 *     `kind="graph"`, and the host that owns the shape is the one that
 *     normalizes what comes back. Dirty-checking is therefore a structural
 *     comparison (`sameConfig`), not a field-by-field one.
 *  2. **Per member, never shared.** There is no share affordance and there will
 *     not be one: the server's rows are FORCE-RLS'd to the owner (migration
 *     0045) precisely because a config can embed a private object's id or
 *     title. A UI that offered to hand one over would be offering something the
 *     box refuses anyway; offering it and failing teaches the wrong model.
 *  3. **localStorage becomes a cache, once.** The phase-3 per-type configs in
 *     `brain.view.<account>.<type>` are migrated into `saved_views` on first
 *     load (once per account per browser, guarded by a flag key), and are then
 *     kept ONLY as the unsaved working state — what you were fiddling with when
 *     you navigated away. The account-mismatch purge still runs on that cache,
 *     and it runs BEFORE the migration reads it, so another member's leftover
 *     config can never be uploaded into this member's saved views.
 *  4. **Storage and the endpoint can both be missing.** Safari private mode,
 *     quota, an older box that predates `/api/v1/views`, the canned demo
 *     bundle: every one of those degrades to "no saved-views affordance at
 *     all", never a broken toolbar or an exception on render.
 *  5. **Dragging is not the only way to reorder.** Pinned rows move with
 *     Alt/Option + ↑/↓ as well as with a pointer, the same rule the board
 *     layout follows — a sidebar that can only be operated by dragging is a
 *     sidebar a keyboard user cannot rearrange.
 *
 * The store is module-level on purpose: the toolbar and the sidebar are in
 * different subtrees of the app, and a pin toggled in one must appear in the
 * other without a refetch or a prop drilled through the whole shell.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import {
  Bookmark,
  Check,
  GripVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

import {
  api,
  ApiError,
  type SavedView,
  type SavedViewInput,
  type SavedViewKind,
  type SavedViewPatch,
} from "../lib/api";
import { parseViewConfigKey, purgeForeignViewConfigs } from "../lib/viewConfig";
import { typeName } from "../lib/ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/* --------------------------------------------------------------- comparison */

/**
 * Deterministic serialization of an arbitrary config, so "is what is on screen
 * still what was saved?" is one string compare.
 *
 * Key ORDER is not meaning: a config built by clicking filters into place and
 * the same config read back from jsonb differ in key order all the time, and a
 * naive `JSON.stringify` compare would call every view dirty the moment it was
 * applied. Arrays keep their order — there, order IS meaning (sort keys,
 * columns). `undefined` members are dropped, matching what JSON would do.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export function sameConfig(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/* -------------------------------------------------------------------- store */

type SavedViewsStatus = "loading" | "ready" | "unavailable";

interface SavedViewsState {
  /** Whose views these are. A different account never sees a stale list. */
  accountId: string;
  views: SavedView[];
  status: SavedViewsStatus;
  /** Last mutation failure, in the member's words; cleared by the next success. */
  error: string | null;
}

const INITIAL: SavedViewsState = { accountId: "", views: [], status: "loading", error: null };

let state: SavedViewsState = INITIAL;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<SavedViewsState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function snapshot(): SavedViewsState {
  return state;
}

/** Sidebar order, mirrored from the server's own ORDER BY so an optimistic
 *  local insert sits where the next refetch will put it: pinned first, then the
 *  member's position, then creation order as a stable tiebreak. */
export function sortViews(views: readonly SavedView[]): SavedView[] {
  return [...views].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.position !== b.position) return a.position - b.position;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return "something went wrong";
}

/** A refusal that is about THIS request (bad name, duplicate, gone) rather than
 *  about the box being unreachable. The migration skips those and keeps going;
 *  anything else aborts it so it can be retried whole later. */
function isClientRefusal(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401;
}

let loadedFor: string | null = null;
let inFlight: Promise<void> | null = null;
let lastFailureAt = 0;
/** After a failure, don't re-probe on every route change. */
const RETRY_AFTER_MS = 15_000;

/**
 * Load this account's views once. A failure — an older box with no
 * `/api/v1/views`, the demo bundle's fixture 404, a dead network — parks the
 * feature as `unavailable` (every affordance disappears) and is retried on a
 * later mount, not in a loop.
 */
export function loadSavedViews(accountId: string, force = false): Promise<void> {
  if (!accountId) return Promise.resolve();
  if (accountId !== loadedFor) {
    // A different member is signed in: drop the old list before anything can
    // render it. Their configs are content — not ours to keep on screen.
    loadedFor = accountId;
    state = { accountId, views: [], status: "loading", error: null };
    emit();
  } else if (inFlight) {
    return inFlight;
  } else if (!force) {
    if (state.status === "ready") return Promise.resolve();
    if (state.status === "unavailable" && Date.now() - lastFailureAt < RETRY_AFTER_MS) {
      return Promise.resolve();
    }
    setState({ status: "loading" });
  }

  const run = (async () => {
    try {
      const views = await api.views();
      if (loadedFor !== accountId) return;
      setState({ accountId, views: sortViews(views), status: "ready", error: null });
      await migrateLocalViewConfigs(accountId);
    } catch (e) {
      if (loadedFor !== accountId) return;
      lastFailureAt = Date.now();
      setState({ accountId, views: [], status: "unavailable", error: messageOf(e) });
    }
  })().finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

/** Every mutation funnels through here: a failure is reported in the picker,
 *  never thrown at a render, and never leaves an optimistic row behind. */
async function mutate<T>(accountId: string, fn: () => Promise<T>): Promise<T | null> {
  if (state.accountId !== accountId) return null;
  try {
    const out = await fn();
    if (state.accountId !== accountId) return null;
    if (state.error !== null) setState({ error: null });
    return out;
  } catch (e) {
    if (state.accountId === accountId) setState({ error: messageOf(e) });
    return null;
  }
}

function replaceView(next: SavedView): void {
  setState({ views: sortViews(state.views.map((v) => (v.id === next.id ? next : v))) });
}

async function createSavedView(
  accountId: string,
  input: SavedViewInput,
): Promise<SavedView | null> {
  const created = await mutate(accountId, () => api.createView(input));
  if (created) setState({ views: sortViews([...state.views, created]) });
  return created;
}

async function patchSavedView(
  accountId: string,
  id: string,
  patch: SavedViewPatch,
): Promise<SavedView | null> {
  const next = await mutate(accountId, () => api.patchView(id, patch));
  if (next) replaceView(next);
  return next;
}

async function deleteSavedView(accountId: string, id: string): Promise<boolean> {
  const res = await mutate(accountId, () => api.deleteView(id));
  if (!res) return false;
  setState({ views: state.views.filter((v) => v.id !== id) });
  return true;
}

/**
 * Reorder by id. The server renumbers every id it is handed inside ONE
 * statement and answers with the whole re-sorted list, so the local optimistic
 * order is replaced by the server's — a rejected drag snaps back rather than
 * leaving the sidebar in an order the box never agreed to.
 */
async function reorderSavedViews(accountId: string, ids: string[]): Promise<boolean> {
  const before = state.views;
  const rank = new Map(ids.map((id, i) => [id, i]));
  // Only the SLOTS held by the reordered ids are rewritten; every other view
  // keeps its place. A comparator that returns 0 for the untouched ones would
  // be free to shuffle them, and the picker would jump for no reason.
  const ranked = before
    .filter((v) => rank.has(v.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  let slot = 0;
  setState({ views: before.map((v) => (rank.has(v.id) ? (ranked[slot++] ?? v) : v)) });
  const views = await mutate(accountId, () => api.reorderViews(ids));
  if (!views) {
    if (state.accountId === accountId) setState({ views: before });
    return false;
  }
  setState({ views: sortViews(views) });
  return true;
}

/** Tests only: the store outlives a single render tree by design. */
export function resetSavedViewsStore(): void {
  state = INITIAL;
  loadedFor = null;
  inFlight = null;
  lastFailureAt = 0;
  emit();
}

/* --------------------------------------------------------------- the hooks */

/** The whole store, loading this account's views on first use. */
function useSavedViews(accountId: string): SavedViewsState {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    void loadSavedViews(accountId);
  }, [accountId]);
  // A list belonging to someone else is never handed to a caller, even for the
  // frame between "account changed" and "the effect ran".
  return s.accountId === accountId ? s : { ...s, accountId, views: [], status: "loading" };
}

/** The views for one subject: a kind + a scope (a type name, or null for the
 *  global ones). */
function useScopedSavedViews(
  accountId: string,
  kind: SavedViewKind,
  scope: string | null,
): { state: SavedViewsState; views: SavedView[] } {
  const s = useSavedViews(accountId);
  const views = useMemo(
    () => s.views.filter((v) => v.kind === kind && v.scope === scope),
    [s.views, kind, scope],
  );
  return { state: s, views };
}

/* ------------------------------------------------- localStorage → saved_views */

const MIGRATED_PREFIX = "brain.savedviews.migrated.";
/** A browser with more per-type configs than this is not a member's history,
 *  it is a fixture — migrate the first slice and leave the rest as cache. */
const MAX_MIGRATED = 50;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The name a migrated config gets: the database it belongs to, so it reads
 *  correctly both in that type's picker and (once pinned) in the sidebar. */
export function migratedViewName(typeKey: string): string {
  const label = typeName(typeKey);
  return label ? `${label} view` : "Saved view";
}

/**
 * One-time lift of the phase-3 per-type localStorage configs into
 * `saved_views`, for THIS account only.
 *
 * The cache is not deleted afterwards: it is now the unsaved working state (the
 * config you were mid-fiddle with), which is a different thing from a view you
 * named. The account-mismatch purge runs first, so a config left behind by
 * whoever used this browser before is destroyed rather than uploaded.
 *
 * Resolves to the number of views created. Never throws: a member who cannot
 * migrate still gets a working saved-views feature going forward.
 */
export async function migrateLocalViewConfigs(accountId: string): Promise<number> {
  const s = storage();
  if (!s || !accountId) return 0;

  const flag = `${MIGRATED_PREFIX}${accountId}`;
  try {
    if (s.getItem(flag) !== null) return 0;
  } catch {
    return 0;
  }

  // The purge is the gate, and it runs BEFORE we read a single config.
  purgeForeignViewConfigs(accountId);

  const mine: Array<{ typeKey: string; config: Record<string, unknown> }> = [];
  try {
    for (let i = 0; i < s.length; i += 1) {
      const key = s.key(i);
      if (key === null) continue;
      const parsed = parseViewConfigKey(key);
      if (!parsed || parsed.accountId !== accountId) continue;
      const raw = s.getItem(key);
      if (raw === null) continue;
      try {
        const config: unknown = JSON.parse(raw);
        if (!config || typeof config !== "object" || Array.isArray(config)) continue;
        mine.push({ typeKey: parsed.typeName, config: config as Record<string, unknown> });
      } catch {
        // Corrupt cache: the reader drops these on its own; nothing to migrate.
      }
    }
  } catch {
    return 0;
  }

  mine.sort((a, b) => (a.typeKey < b.typeKey ? -1 : 1));

  let created = 0;
  let aborted = false;
  for (const entry of mine.slice(0, MAX_MIGRATED)) {
    // Someone else signed in mid-pass: stop. Their session must not finish this
    // member's migration, and the flag stays unset so this one resumes later.
    if (loadedFor !== null && loadedFor !== accountId) return created;
    // A scope that already has a saved view was migrated before (or the member
    // saved one by hand) — never make a second copy of it.
    if (
      state.accountId === accountId &&
      state.views.some((v) => v.kind === "database" && v.scope === entry.typeKey)
    ) {
      continue;
    }
    try {
      const view = await api.createView({
        kind: "database",
        scope: entry.typeKey,
        name: migratedViewName(entry.typeKey),
        config: entry.config,
      });
      // The store may not be loaded at all (a migration run on its own); the
      // created view is still real, it just has no list to join yet.
      if (state.accountId === accountId) setState({ views: sortViews([...state.views, view]) });
      created += 1;
    } catch (e) {
      if (isClientRefusal(e)) continue;
      // The box is unreachable or the session is gone: stop, leave the flag
      // unset, and let a later load try the whole pass again.
      aborted = true;
      break;
    }
  }

  if (!aborted) {
    try {
      s.setItem(flag, new Date().toISOString());
      // Another member's migration flag is not ours to keep around either.
      for (let i = s.length - 1; i >= 0; i -= 1) {
        const key = s.key(i);
        if (key !== null && key.startsWith(MIGRATED_PREFIX) && key !== flag) s.removeItem(key);
      }
    } catch {
      // Unwritable storage: the flag is an optimization, and a second pass is a
      // no-op anyway (every scope already has its view).
    }
  }
  return created;
}

/* ------------------------------------------------------------------ routing */

/** Where a pinned view lives. A database view opens its type's page with the
 *  view selected; a graph view (phase 6) opens the graph the same way. A
 *  database view with no scope has no page to open — it is not linkable, and
 *  the sidebar skips it rather than inventing a route. */
export function savedViewHref(view: SavedView): string | null {
  const q = `?view=${encodeURIComponent(view.id)}`;
  if (view.kind === "graph") return `/graph${q}`;
  return view.scope ? `/t/${encodeURIComponent(view.scope)}${q}` : null;
}

/** "Sales view", "Sales view 2", … — a name the server will accept on the
 *  first try, since duplicates inside one scope are refused by the unique
 *  index. */
export function suggestViewName(existing: readonly SavedView[], base: string): string {
  const taken = new Set(existing.map((v) => v.name.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/* ---------------------------------------------------------- toolbar control */

export interface SavedViewsProps {
  accountId: string;
  /** The subject: a type name, or null for a global view. */
  scope: string | null;
  /** "database" today; phase 6 passes "graph" and reuses this file verbatim. */
  kind?: SavedViewKind;
  /** The configuration on screen right now — what "Save this view" captures. */
  config: Record<string, unknown>;
  /** Hand a saved config back to the host, which normalizes it for its kind. */
  onApply: (config: Record<string, unknown>, view: SavedView) => void;
  /** Seed for a new view's name; defaults to the scope's label. */
  nameBase?: string;
  className?: string;
}

export function SavedViews({
  accountId,
  scope,
  kind = "database",
  config,
  onApply,
  nameBase,
  className,
}: SavedViewsProps) {
  const { state: s, views } = useScopedSavedViews(accountId, kind, scope);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const activeId = params.get("view");
  const active = useMemo(() => views.find((v) => v.id === activeId) ?? null, [views, activeId]);
  const dirty = active !== null && !sameConfig(active.config, config);

  // The apply callback is read through a ref so the effect below depends on the
  // VIEW, not on whether the host happened to re-create its handler.
  const applyRef = useRef(onApply);
  applyRef.current = onApply;

  // `?view=<id>` is the source of truth for "which view am I looking at" — a
  // pinned sidebar link is just a link. Applying happens once per view: the
  // member's later edits are theirs, and re-running this on every render would
  // fight them for the config.
  const appliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active) {
      appliedRef.current = null;
      return;
    }
    if (appliedRef.current === active.id) return;
    appliedRef.current = active.id;
    applyRef.current(active.config, active);
  }, [active]);

  const setActive = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params);
      if (id) next.set("view", id);
      else next.delete("view");
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const suggested = suggestViewName(views, nameBase ?? `${typeName(scope) || "New"} view`.trim());

  // An older box (no /api/v1/views) or the demo bundle: no affordance at all.
  // A feature we cannot persist is a degraded feature, never a broken toolbar.
  if (s.status === "unavailable") return null;

  const pick = (v: SavedView) => {
    appliedRef.current = v.id;
    applyRef.current(v.config, v);
    setActive(v.id);
    setOpen(false);
  };

  const saveNew = async () => {
    const chosen = name.trim() || suggested;
    setBusy(true);
    const created = await createSavedView(accountId, {
      kind,
      scope,
      name: chosen,
      config,
    });
    setBusy(false);
    if (created) {
      setName("");
      appliedRef.current = created.id;
      setActive(created.id);
      setOpen(false);
    }
  };

  const updateActive = async () => {
    if (!active) return;
    setBusy(true);
    const next = await patchSavedView(accountId, active.id, { config });
    setBusy(false);
    if (next) appliedRef.current = next.id;
  };

  const commitRename = async () => {
    if (!renaming) return;
    const trimmed = renaming.name.trim();
    if (!trimmed) return;
    setBusy(true);
    const next = await patchSavedView(accountId, renaming.id, { name: trimmed });
    setBusy(false);
    if (next) setRenaming(null);
  };

  const remove = async (v: SavedView) => {
    setBusy(true);
    const ok = await deleteSavedView(accountId, v.id);
    setBusy(false);
    setConfirming(null);
    if (ok && activeId === v.id) setActive(null);
  };

  const label = active ? active.name : "Views";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={`text-mut ${className ?? ""}`}
            aria-label={active ? `Saved view: ${active.name}` : "Saved views"}
          >
            <Bookmark aria-hidden />
            <span className="max-w-[160px] truncate">{label}</span>
            {dirty && (
              <span className="text-[11px] text-dim" title="Unsaved changes to this view">
                •
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[320px] p-0">
        <div className="max-h-[280px] overflow-y-auto p-2">
          {s.status === "loading" && <p className="px-1 py-1.5 text-[12px] text-dim">Loading…</p>}
          {s.status === "ready" && views.length === 0 && (
            <p className="px-1 py-1.5 text-[12px] text-dim">
              No saved views here yet. Save the filters, sort and layout on screen and they&apos;ll
              be one click away — for you only.
            </p>
          )}
          {views.map((v) => (
            <div
              key={v.id}
              className={`group flex items-center gap-1 rounded-none px-1 py-1 ${
                v.id === activeId ? "bg-hover" : ""
              }`}
            >
              {renaming?.id === v.id ? (
                <>
                  <Input
                    autoFocus
                    value={renaming.name}
                    aria-label={`rename ${v.name}`}
                    className="h-7 flex-1 text-[12.5px]"
                    onChange={(e) => setRenaming({ id: v.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                  <IconButton label="save name" onClick={() => void commitRename()} disabled={busy}>
                    <Check size={13} aria-hidden />
                  </IconButton>
                  <IconButton label="cancel rename" onClick={() => setRenaming(null)}>
                    <X size={13} aria-hidden />
                  </IconButton>
                </>
              ) : confirming === v.id ? (
                <>
                  <span className="flex-1 truncate text-[12.5px] text-mut">Delete {v.name}?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7"
                    disabled={busy}
                    onClick={() => void remove(v)}
                  >
                    Delete
                  </Button>
                  <IconButton label="cancel delete" onClick={() => setConfirming(null)}>
                    <X size={13} aria-hidden />
                  </IconButton>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => pick(v)}
                    className="flex-1 cursor-pointer truncate px-1 text-left text-[12.5px] hover:text-foreground"
                  >
                    {v.name}
                  </button>
                  <IconButton
                    label={v.pinned ? `unpin ${v.name}` : `pin ${v.name}`}
                    title={v.pinned ? "Remove from the sidebar" : "Pin to the sidebar"}
                    active={v.pinned}
                    disabled={busy}
                    onClick={() => void patchSavedView(accountId, v.id, { pinned: !v.pinned })}
                  >
                    {v.pinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}
                  </IconButton>
                  <IconButton
                    label={`rename ${v.name}`}
                    onClick={() => setRenaming({ id: v.id, name: v.name })}
                  >
                    <Pencil size={13} aria-hidden />
                  </IconButton>
                  <IconButton label={`delete ${v.name}`} onClick={() => setConfirming(v.id)}>
                    <Trash2 size={13} aria-hidden />
                  </IconButton>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 border-t border-line-soft p-2.5">
          {active && dirty && (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                className="flex-1"
                disabled={busy}
                onClick={() => void updateActive()}
              >
                <Check aria-hidden /> Update &ldquo;{active.name}&rdquo;
              </Button>
              <IconButton
                label="discard changes"
                title="Back to the saved configuration"
                onClick={() => applyRef.current(active.config, active)}
              >
                <RotateCcw size={13} aria-hidden />
              </IconButton>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Input
              value={name}
              placeholder={suggested}
              aria-label="new view name"
              className="h-8 flex-1 text-[12.5px]"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveNew();
              }}
            />
            <Button size="sm" disabled={busy} onClick={() => void saveNew()}>
              <Plus aria-hidden /> Save this view
            </Button>
          </div>
          {active && (
            <button
              type="button"
              className="cursor-pointer text-left text-[11.5px] text-dim hover:text-mut"
              onClick={() => {
                appliedRef.current = null;
                setActive(null);
                setOpen(false);
              }}
            >
              Stop using &ldquo;{active.name}&rdquo; (keeps what&apos;s on screen)
            </button>
          )}
          <p className="text-[11px] text-dim">
            Saved views are yours alone — nobody else sees them.
          </p>
          {s.error && <p className="text-[11.5px] text-destructive">{s.error}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function IconButton({
  label,
  title,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-none hover:bg-hover disabled:cursor-default disabled:opacity-50 ${
        active ? "text-foreground" : "text-dim hover:text-mut"
      }`}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------- sidebar block */

export interface PinnedViewsProps {
  accountId: string;
  /** The collapsed sidebar shows icons only — the same contract the type list
   *  follows. */
  collapsed?: boolean;
  label?: string;
  /** The shell's own nav item classes, so a pinned view looks like every other
   *  sidebar row without this file duplicating them. */
  itemClassName?: string;
  activeClassName?: string;
  idleClassName?: string;
}

const FALLBACK_ITEM =
  "flex items-center gap-2 rounded-none px-2 py-1.5 text-[13px] no-underline transition-colors";

/**
 * Pinned views in the sidebar, in the member's own order.
 *
 * Reordering is optimistic and then reconciled with the server's answer; the
 * whole pinned list is sent, so a drag is one statement server-side and can
 * never renumber half of it.
 */
export function PinnedViews({
  accountId,
  collapsed = false,
  label = "Pinned views",
  itemClassName = FALLBACK_ITEM,
  activeClassName = "bg-hover text-foreground",
  idleClassName = "text-mut hover:bg-hover hover:text-foreground",
}: PinnedViewsProps) {
  const s = useSavedViews(accountId);
  const location = useLocation();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const pinned = useMemo(
    () => s.views.filter((v) => v.pinned && savedViewHref(v) !== null),
    [s.views],
  );

  const move = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const ids = pinned.map((v) => v.id);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(toId);
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ...ids.splice(from, 1));
      void reorderSavedViews(accountId, ids);
    },
    [accountId, pinned],
  );

  /** Alt/Option + ↑/↓ — the keyboard's drag. Pinned rows must be rearrangeable
   *  without a pointer. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLAnchorElement>, index: number) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const next = index + (e.key === "ArrowUp" ? -1 : 1);
    const target = pinned[next];
    const self = pinned[index];
    if (!target || !self) return;
    e.preventDefault();
    move(self.id, target.id);
  };

  if (pinned.length === 0) return null;

  const activeViewId = new URLSearchParams(location.search).get("view");

  return (
    <div className="mt-4">
      {!collapsed && (
        <div className="mb-1.5 px-5 text-[10.5px] font-semibold tracking-[.08em] text-dim uppercase">
          {label}
        </div>
      )}
      {collapsed && <div className="mb-1.5 border-t border-line-soft" />}
      <nav aria-label={label} className="flex flex-col gap-0.5 px-3">
        {pinned.map((v, i) => {
          const href = savedViewHref(v);
          if (href === null) return null;
          const isActive =
            activeViewId === v.id && location.pathname === href.slice(0, href.indexOf("?"));
          return (
            <Link
              key={v.id}
              to={href}
              draggable
              aria-label={`${v.name} (pinned view)`}
              title={collapsed ? v.name : undefined}
              onDragStart={(e: ReactDragEvent<HTMLAnchorElement>) => {
                setDragging(v.id);
                // jsdom (and a synthetic drag) has no dataTransfer; the id we
                // actually use is the one in state, so this is decoration for
                // native drag feedback only.
                e.dataTransfer?.setData("text/plain", v.id);
              }}
              onDragOver={(e: ReactDragEvent<HTMLAnchorElement>) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(v.id);
              }}
              onDrop={(e: ReactDragEvent<HTMLAnchorElement>) => {
                e.preventDefault();
                if (dragging) move(dragging, v.id);
                setDragging(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onKeyDown={(e: ReactKeyboardEvent<HTMLAnchorElement>) => onKeyDown(e, i)}
              className={`${itemClassName} ${isActive ? activeClassName : idleClassName} ${
                over === v.id && dragging !== v.id ? "border-t border-foreground/40" : ""
              } ${dragging === v.id ? "opacity-50" : ""}`}
            >
              <GripVertical size={13} aria-hidden className="shrink-0 text-dim" />
              {!collapsed && <span className="flex-1 truncate">{v.name}</span>}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
