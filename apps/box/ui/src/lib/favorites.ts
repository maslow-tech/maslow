/**
 * Sidebar chrome state: this member's FAVORITES and their RECENTS.
 *
 * ## Where this lives, and why
 *
 * Two homes were available (phase 4 spec): a reserved scope in the server-side
 * `saved_views` table (kind `database`, FORCE-RLS per member), or a dedicated
 * localStorage key per account. **This picks localStorage**, for four reasons:
 *
 *  1. **Recents cannot go to the server anyway.** A recents list is a per-BROWSER
 *     navigation history — it would mean a write on every navigation, and the
 *     same member on two machines would get one shuffled list. Splitting the two
 *     sidebar sections across two stores would give them different lifecycles,
 *     different purge rules and different failure modes, in the one place where
 *     they must behave identically.
 *  2. **`saved_views.scope` is contractually a TYPE NAME** — `savedViewHref()`
 *     builds `/t/<scope>` out of it. A reserved scope would be a value every
 *     routing/labelling helper has to special-case, i.e. a lie in a shared
 *     contract to save a table.
 *  3. **Chrome must not depend on a box being new enough.** `/api/v1/views`
 *     (migration 0045) is missing on older boxes and in the demo bundle;
 *     `<SavedViews>` correctly degrades to "no affordance at all" there. That is
 *     fine for saved views and wrong for the sidebar's own navigation.
 *  4. A star toggle should be instant. Storage is; a round trip is not.
 *
 * ## The price, paid in full
 *
 * A favorite is an object id plus its title, and a recent is the same — for a
 * private object that is CONTENT, sitting in a browser profile that may be
 * shared. So the purge rule is mandatory, not optional, and it is exactly the
 * draft mirror's:
 *
 *  - keys are `brain.fav.<accountId>` / `brain.recent.<accountId>`;
 *  - reading is a gate: every key whose account id is not the caller's is
 *    DELETED, not ignored (`purgeForeignChrome`, called from App.tsx before the
 *    first render and again on every load here);
 *  - recents are cleared on sign-out and on 401 — a browsing history belongs to
 *    the session that browsed. Favorites are a durable preference and survive,
 *    still account-keyed and still purged the instant another account appears;
 *  - storage can be absent or throw (private mode, quota, policy). Every access
 *    is guarded: chrome we cannot persist is a degraded sidebar, never a broken
 *    one — the in-memory store still drives this session.
 *
 * The store is module-level so the star in the header, the sidebar sections and
 * the ⌘K palette all see one list without prop-drilling through the shell.
 */
import { useEffect, useSyncExternalStore } from "react";

const FAV_PREFIX = "brain.fav.";
const RECENT_PREFIX = "brain.recent.";

/** Long enough to be a real shelf, short enough that the sidebar stays a
 *  sidebar (and that one member's storage stays small). */
export const MAX_FAVORITES = 30;

/** The spec's number. Recents are a "take me back", not a log. */
export const MAX_RECENTS = 10;

/** The two things worth starring: an object, or a whole database (type). */
export type FavoriteKind = "object" | "type";

export interface Favorite {
  kind: FavoriteKind;
  /** object id, or type name */
  key: string;
  /** what the sidebar shows */
  label: string;
  /** the object's type (for its icon); null for an untyped object */
  type: string | null;
  /** epoch ms the star was clicked */
  at: number;
}

export interface Recent {
  kind: FavoriteKind;
  key: string;
  label: string;
  type: string | null;
  at: number;
}

/** Where a favorite/recent points. The only route shapes chrome ever builds. */
export function chromeHref(entry: { kind: FavoriteKind; key: string }): string {
  return entry.kind === "type"
    ? `/t/${encodeURIComponent(entry.key)}`
    : `/o/${encodeURIComponent(entry.key)}`;
}

/* ------------------------------------------------------------------- keys */

export function favoritesKey(accountId: string): string {
  return `${FAV_PREFIX}${accountId}`;
}

export function recentsKey(accountId: string): string {
  return `${RECENT_PREFIX}${accountId}`;
}

/** Split a chrome key back into (which list, whose). Anything that does not
 *  parse is treated as foreign and purged rather than trusted. */
export function parseChromeKey(
  key: string,
): { list: "favorites" | "recents"; accountId: string } | null {
  if (key.startsWith(FAV_PREFIX)) {
    const accountId = key.slice(FAV_PREFIX.length);
    return accountId ? { list: "favorites", accountId } : null;
  }
  if (key.startsWith(RECENT_PREFIX)) {
    const accountId = key.slice(RECENT_PREFIX.length);
    return accountId ? { list: "recents", accountId } : null;
  }
  return null;
}

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function allChromeKeys(s: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const k = s.key(i);
    if (k !== null && (k.startsWith(FAV_PREFIX) || k.startsWith(RECENT_PREFIX))) keys.push(k);
  }
  return keys;
}

/* ------------------------------------------------------------ the shape */

function isKind(v: unknown): v is FavoriteKind {
  return v === "object" || v === "type";
}

/** A stored row is a row an OLDER release wrote — treat it as hostile-shaped,
 *  exactly as the view configs and drafts are. */
function normalizeEntry(v: unknown): Favorite | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  const kind = e["kind"];
  const key = e["key"];
  const label = e["label"];
  if (!isKind(kind)) return null;
  if (typeof key !== "string" || !key) return null;
  if (typeof label !== "string") return null;
  const type = typeof e["type"] === "string" ? (e["type"] as string) : null;
  const at = typeof e["at"] === "number" && Number.isFinite(e["at"]) ? (e["at"] as number) : 0;
  return { kind, key, label, type, at };
}

function normalizeList(raw: unknown, cap: number): Favorite[] {
  if (!Array.isArray(raw)) return [];
  const out: Favorite[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = normalizeEntry(item);
    if (!entry) continue;
    const id = `${entry.kind}:${entry.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
    if (out.length >= cap) break;
  }
  return out;
}

/* ------------------------------------------------------------------ store */

interface ChromeState {
  /** whose chrome this is; "" before anything is loaded */
  accountId: string;
  favorites: readonly Favorite[];
  recents: readonly Recent[];
}

const EMPTY: ChromeState = { accountId: "", favorites: [], recents: [] };

let state: ChromeState = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function snapshot(): ChromeState {
  return state;
}

function readList(s: Storage, key: string, cap: number): Favorite[] {
  try {
    const raw = s.getItem(key);
    if (raw === null) return [];
    return normalizeList(JSON.parse(raw) as unknown, cap);
  } catch {
    // Corrupt JSON is not recoverable preference — and it may be content.
    try {
      s.removeItem(key);
    } catch {
      /* storage gone; nothing else to do */
    }
    return [];
  }
}

function persist(accountId: string): void {
  const s = store();
  if (!s || !accountId) return;
  try {
    s.setItem(favoritesKey(accountId), JSON.stringify(state.favorites));
    s.setItem(recentsKey(accountId), JSON.stringify(state.recents));
  } catch {
    // Quota or private mode: the session still has the in-memory list.
  }
}

/**
 * Load one account's chrome into the store (purging everyone else's first).
 * Idempotent: re-loading the account already in the store is a no-op, so it is
 * safe to call from an effect on every render pass.
 */
export function loadChrome(accountId: string, force = false): ChromeState {
  if (!accountId) return state;
  if (state.accountId === accountId && !force) return state;
  purgeForeignChrome(accountId);
  const s = store();
  const favorites = s ? readList(s, favoritesKey(accountId), MAX_FAVORITES) : [];
  const recents = s ? readList(s, recentsKey(accountId), MAX_RECENTS) : [];
  state = { accountId, favorites, recents };
  emit();
  return state;
}

/** Test seam / account change: drop the in-memory copy without touching disk. */
export function resetChromeStore(): void {
  state = EMPTY;
  emit();
}

function setState(next: ChromeState): void {
  state = next;
  persist(next.accountId);
  emit();
}

/* -------------------------------------------------------------- mutations */

export function isFavorite(accountId: string, kind: FavoriteKind, key: string): boolean {
  const s = loadChrome(accountId);
  return s.favorites.some((f) => f.kind === kind && f.key === key);
}

export function addFavorite(accountId: string, fav: Omit<Favorite, "at">, at = Date.now()): void {
  if (!accountId || !fav.key) return;
  const s = loadChrome(accountId);
  const rest = s.favorites.filter((f) => !(f.kind === fav.kind && f.key === fav.key));
  // Newest first: the thing you just starred is the thing you are working on.
  const favorites = [{ ...fav, at }, ...rest].slice(0, MAX_FAVORITES);
  setState({ ...s, accountId, favorites });
}

export function removeFavorite(accountId: string, kind: FavoriteKind, key: string): void {
  if (!accountId) return;
  const s = loadChrome(accountId);
  const favorites = s.favorites.filter((f) => !(f.kind === kind && f.key === key));
  if (favorites.length === s.favorites.length) return;
  setState({ ...s, accountId, favorites });
}

/** The star. Returns the state it left behind, so a caller can announce it. */
export function toggleFavorite(
  accountId: string,
  fav: Omit<Favorite, "at">,
  at = Date.now(),
): boolean {
  if (isFavorite(accountId, fav.kind, fav.key)) {
    removeFavorite(accountId, fav.kind, fav.key);
    return false;
  }
  addFavorite(accountId, fav, at);
  return true;
}

/**
 * Note a visit. Deduped by (kind, key) with the newest first, capped at
 * `MAX_RECENTS`; a re-visit MOVES the entry up rather than doubling it, and
 * refreshes its label (a renamed object must not linger under its old title).
 * Entries with no label are not recorded — a "…" row is worse than no row.
 */
export function recordRecent(accountId: string, entry: Omit<Recent, "at">, at = Date.now()): void {
  if (!accountId || !entry.key || !entry.label.trim()) return;
  const s = loadChrome(accountId);
  const head = s.recents[0];
  if (
    head &&
    head.kind === entry.kind &&
    head.key === entry.key &&
    head.label === entry.label &&
    head.type === entry.type
  ) {
    return; // already at the top, unchanged — nothing to write
  }
  const rest = s.recents.filter((r) => !(r.kind === entry.kind && r.key === entry.key));
  const recents = [{ ...entry, at }, ...rest].slice(0, MAX_RECENTS);
  setState({ ...s, accountId, recents });
}

/** Sign-out and 401: a navigation history is a session artifact. Favorites are
 *  a durable preference and deliberately survive — still account-keyed, still
 *  purged the moment another account signs in on this browser. */
export function clearRecents(): number {
  const s = store();
  let removed = 0;
  if (s) {
    try {
      for (const key of allChromeKeys(s)) {
        if (parseChromeKey(key)?.list === "recents") {
          s.removeItem(key);
          removed += 1;
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (state.recents.length > 0) state = { ...state, recents: [] };
  emit();
  return removed;
}

/** Everything, both lists, every account — the blunt instrument (a shared
 *  machine being handed over, a test resetting itself). */
export function clearAllChrome(): number {
  const s = store();
  let removed = 0;
  if (s) {
    try {
      for (const key of allChromeKeys(s)) {
        s.removeItem(key);
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  state = EMPTY;
  emit();
  return removed;
}

/**
 * Wipe every favorites/recents list that does NOT belong to `currentAccountId`,
 * so member B signing in on member A's browser never sees — and never links to —
 * A's objects. An empty/unknown current account wipes everything: if we cannot
 * prove a list is ours, it is not ours.
 */
export function purgeForeignChrome(currentAccountId: string): number {
  const s = store();
  if (state.accountId && state.accountId !== currentAccountId) state = EMPTY;
  if (!s) return 0;
  try {
    let removed = 0;
    for (const key of allChromeKeys(s)) {
      const parsed = parseChromeKey(key);
      if (!currentAccountId || parsed === null || parsed.accountId !== currentAccountId) {
        s.removeItem(key);
        removed += 1;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------------- hooks */

/** This account's chrome, live. Loading happens in an effect (never during
 *  render), so the first paint is empty rather than wrong. */
export function useChrome(accountId: string): ChromeState {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    loadChrome(accountId);
  }, [accountId]);
  return s.accountId === accountId ? s : EMPTY;
}

/** Is THIS thing starred? Re-renders with the store, so the header star and the
 *  sidebar row can never disagree. */
export function useIsFavorite(accountId: string, kind: FavoriteKind, key: string | null): boolean {
  const { favorites } = useChrome(accountId);
  if (!key) return false;
  return favorites.some((f) => f.kind === kind && f.key === key);
}
