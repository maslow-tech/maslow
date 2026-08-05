/**
 * Local draft mirror — dirty edits kept in browser storage so a crash, a tab
 * close or a failed flush cannot lose typed text.
 *
 * This is the one place where brain content — INCLUDING private-object bodies —
 * leaves the RLS boundary and lands on what may be a shared machine, and the
 * session cookie lasts a year. So the rules here are hard, and every one of them
 * is tested:
 *
 *  - keyed `brain.draft.<accountId>.<objectId>`, stored with the `baseVersion`
 *    it was typed against;
 *  - cleared on ack, on logout, on 401/session expiry, and whenever the
 *    logged-in account id does not match the key. `purgeForeignDrafts` runs from
 *    App.tsx BEFORE anything renders, so a second member signing in on the same
 *    browser wipes the first one's drafts rather than showing them;
 *  - never restored blind: `applicability` returns "auto" ONLY when the object's
 *    current version still equals the draft's `baseVersion`. Anything else is
 *    "offer" — an explicit recovery banner with a diff. A stale draft silently
 *    reapplying would clobber newer agent and human writes on the next save.
 *
 * Storage can throw (Safari private mode, quota, storage disabled by policy).
 * Every access is guarded: a mirror we cannot write is a degraded feature, never
 * a broken page.
 */

const PREFIX = "brain.draft.";
/**
 * The COLLAB offline buffer — a parallel namespace to the CAS draft above, for
 * the one gap it cannot cover. Under a live room the body and title travel over
 * the socket, NOT the save queue, so they never reach the CAS draft mirror; when
 * the socket is down the Y.Doc is the only buffer, and it is in-memory, so a
 * reload/close mid-outage loses the typed text. This persists that buffer's
 * content (title + body markdown) so it survives, seeded back into the room's
 * doc on next load.
 *
 * It rides the SAME privacy regime as the CAS draft (account-scoped key, purged
 * cross-account before render, wiped on logout) — see `purgeForeignDrafts` and
 * `clearAllDrafts`, which both scan this prefix too.
 */
const COLLAB_PREFIX = "brain.collab.";

/** The field-granular shape the save queue writes: only what changed. Inside
 *  `props`, `null` means "delete this key" (matching PatchObjectInput). */
export interface DraftFields {
  title?: string | null;
  body?: string;
  visibility?: "org" | "private";
  props?: Record<string, unknown>;
}

export interface StoredDraft {
  fields: DraftFields;
  /** the object version this text was typed against */
  baseVersion: number;
  /** epoch ms, for the recovery banner's "typed 4 minutes ago" */
  savedAt: number;
}

export function draftKey(accountId: string, objectId: string): string {
  return `${PREFIX}${accountId}.${objectId}`;
}

/** Split a stored key back into its parts. Account ids and object ids are uuids
 *  (no dots), so the FIRST dot after the prefix separates them. Anything that
 *  does not parse is treated as foreign and purged rather than trusted. */
export function parseDraftKey(key: string): { accountId: string; objectId: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const accountId = rest.slice(0, dot);
  const objectId = rest.slice(dot + 1);
  if (!accountId || !objectId) return null;
  return { accountId, objectId };
}

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function allDraftKeys(s: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const k = s.key(i);
    if (k !== null && k.startsWith(PREFIX)) keys.push(k);
  }
  return keys;
}

/** Every browser-stored brain key (CAS draft AND collab buffer), for the purge
 *  and logout wipes that must cover both namespaces. */
function allBrainKeys(s: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const k = s.key(i);
    if (k !== null && (k.startsWith(PREFIX) || k.startsWith(COLLAB_PREFIX))) keys.push(k);
  }
  return keys;
}

/** The account id embedded in a CAS-draft OR collab-buffer key, or null. */
function accountOfKey(key: string): string | null {
  const prefix = key.startsWith(PREFIX)
    ? PREFIX
    : key.startsWith(COLLAB_PREFIX)
      ? COLLAB_PREFIX
      : null;
  if (prefix === null) return null;
  const rest = key.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const accountId = rest.slice(0, dot);
  return accountId || null;
}

function isDraft(v: unknown): v is StoredDraft {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  if (typeof d["baseVersion"] !== "number" || !Number.isInteger(d["baseVersion"])) return false;
  if (typeof d["savedAt"] !== "number") return false;
  const f = d["fields"];
  return !!f && typeof f === "object" && !Array.isArray(f);
}

/** Read this account's draft for one object.
 *
 *  Reading is also a gate: a key whose account id is not `accountId` is not just
 *  ignored, it is DELETED — the caller asked as this account, so anything else
 *  under that object belongs to someone who used this browser before. */
export function readDraft(accountId: string, objectId: string): StoredDraft | null {
  const s = store();
  if (!s || !accountId) return null;
  purgeForeignDrafts(accountId);
  try {
    const raw = s.getItem(draftKey(accountId, objectId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isDraft(parsed)) {
      s.removeItem(draftKey(accountId, objectId));
      return null;
    }
    return parsed;
  } catch {
    // Corrupt JSON is not recoverable content — drop it rather than keep
    // unreadable brain text sitting in storage forever.
    try {
      s.removeItem(draftKey(accountId, objectId));
    } catch {
      /* storage gone; nothing else to do */
    }
    return null;
  }
}

export function writeDraft(
  accountId: string,
  objectId: string,
  fields: DraftFields,
  baseVersion: number,
  savedAt: number = Date.now(),
): void {
  const s = store();
  if (!s || !accountId || !objectId) return;
  const draft: StoredDraft = { fields, baseVersion, savedAt };
  try {
    s.setItem(draftKey(accountId, objectId), JSON.stringify(draft));
  } catch {
    // Quota or private mode. The in-memory queue still holds the text; the
    // mirror is the crash net, not the source of truth.
  }
}

/** Called on ack — the server has the text, the local copy must not outlive it. */
export function clearDraft(accountId: string, objectId: string): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(draftKey(accountId, objectId));
  } catch {
    /* ignore */
  }
}

/** Logout and 401/session-expiry: nothing typed survives the session that typed
 *  it. Not scoped to an account on purpose — we may not know who we were. */
export function clearAllDrafts(): number {
  const s = store();
  if (!s) return 0;
  try {
    // Both namespaces: a logout must not leave a collab offline buffer behind
    // any more than a CAS draft.
    const keys = allBrainKeys(s);
    for (const k of keys) s.removeItem(k);
    return keys.length;
  } catch {
    return 0;
  }
}

/**
 * Wipe every draft that does NOT belong to `currentAccountId`. App.tsx calls
 * this before the first render, so member B signing in on member A's browser
 * never renders — and never re-saves — A's text.
 *
 * An empty/unknown current account wipes everything: if we cannot prove a draft
 * is ours, it is not ours.
 */
export function purgeForeignDrafts(currentAccountId: string): number {
  const s = store();
  if (!s) return 0;
  try {
    let removed = 0;
    // Both namespaces: member B must not inherit member A's collab buffer any
    // more than A's CAS draft.
    for (const key of allBrainKeys(s)) {
      const account = accountOfKey(key);
      if (!currentAccountId || account === null || account !== currentAccountId) {
        s.removeItem(key);
        removed += 1;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Every draft this account still holds, for the "unsaved work" recovery list. */
export function listDrafts(accountId: string): Array<{ objectId: string; draft: StoredDraft }> {
  const s = store();
  if (!s || !accountId) return [];
  const out: Array<{ objectId: string; draft: StoredDraft }> = [];
  for (const key of allDraftKeys(s)) {
    const parsed = parseDraftKey(key);
    if (!parsed || parsed.accountId !== accountId) continue;
    const draft = readDraft(accountId, parsed.objectId);
    if (draft) out.push({ objectId: parsed.objectId, draft });
  }
  return out;
}

/**
 * May this draft be reapplied without asking?
 *
 * "auto" ONLY when the object has not moved since the draft was typed. Any
 * other version — including a LOWER one, which means we are looking at a stale
 * read — is "offer": show the recovery banner with a diff and let the human
 * decide. This is the rule that stops a week-old tab from silently overwriting
 * everything an agent wrote in between.
 */
export function applicability(draft: StoredDraft, currentVersion: number): "auto" | "offer" {
  return draft.baseVersion === currentVersion ? "auto" : "offer";
}

/* ------------------------------------------------------------- collab buffer */

/** A room's content snapshot, exactly the two fields a room owns. */
export interface CollabBufferContent {
  title: string;
  body: string;
}

/**
 * The persisted offline room buffer.
 *
 * It carries the offline `content` (what the user has in the doc) AND the
 * `base` the server was known to hold when the socket dropped. The base is
 * load-bearing: on a reload mid-outage the in-memory `acked` baseline is gone,
 * and without a persisted base the reconcile on reconnect falls back to EMPTY —
 * which raises a phantom conflict on a routine reconnect (offline edits ≠ EMPTY
 * ≠ server) and, for an offline deletion, silently re-adopts the server's old
 * content. Persisting the base lets a fresh mount reconcile against the real
 * baseline, exactly as the same session would have.
 */
export interface CollabBuffer {
  content: CollabBufferContent;
  base: CollabBufferContent;
}

interface StoredCollabBuffer extends CollabBuffer {
  savedAt: number;
}

export function collabBufferKey(accountId: string, objectId: string): string {
  return `${COLLAB_PREFIX}${accountId}.${objectId}`;
}

function coerceContent(v: unknown): CollabBufferContent | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return typeof o["title"] === "string" && typeof o["body"] === "string"
    ? { title: o["title"], body: o["body"] }
    : null;
}

const EMPTY_CONTENT: CollabBufferContent = { title: "", body: "" };

function contentIsEmpty(c: CollabBufferContent): boolean {
  return c.title === "" && c.body === "";
}

/** Parse a stored buffer, tolerating the legacy content-only shape (`{title,
 *  body, savedAt}`) a browser may still hold from before the base was added —
 *  it reads as content with an EMPTY base (the pre-fix behaviour for that one
 *  buffer, never a crash). */
function readStoredBuffer(v: unknown): CollabBuffer | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const content = coerceContent(b["content"]) ?? coerceContent(b);
  if (!content) return null;
  const base = coerceContent(b["base"]) ?? EMPTY_CONTENT;
  return { content, base };
}

/**
 * Read this account's persisted offline room buffer for one object. Like
 * `readDraft`, a key belonging to another account is DELETED, not merely
 * ignored — reading as this account proves anything else is a prior user's.
 */
export function readCollabBuffer(accountId: string, objectId: string): CollabBuffer | null {
  const s = store();
  if (!s || !accountId) return null;
  // Same gate as readDraft: reading as this account is proof that anything under
  // another account is a prior user's — purge it (both namespaces) on the way.
  purgeForeignDrafts(accountId);
  const key = collabBufferKey(accountId, objectId);
  try {
    const raw = s.getItem(key);
    if (raw === null) return null;
    const parsed = readStoredBuffer(JSON.parse(raw));
    if (!parsed) {
      s.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    try {
      s.removeItem(key);
    } catch {
      /* storage gone */
    }
    return null;
  }
}

export function writeCollabBuffer(
  accountId: string,
  objectId: string,
  buffer: CollabBuffer,
  savedAt: number = Date.now(),
): void {
  const s = store();
  if (!s || !accountId || !objectId) return;
  // Nothing to represent: empty content AND an empty base is the genuine ABSENCE
  // of a buffer (a never-synced room with nothing typed), and persisting it
  // would reload as an empty note stomping a freshly-seeded room. But an empty
  // content with a NON-empty base is a real event — an offline deletion of a
  // note the server still holds — and MUST be kept, or the deletion is lost on
  // reload (it reads as "clean" and re-adopts the server's content).
  if (contentIsEmpty(buffer.content) && contentIsEmpty(buffer.base)) {
    clearCollabBuffer(accountId, objectId);
    return;
  }
  const stored: StoredCollabBuffer = {
    content: buffer.content,
    base: buffer.base,
    savedAt,
  };
  try {
    s.setItem(collabBufferKey(accountId, objectId), JSON.stringify(stored));
  } catch {
    // Quota / private mode. The in-memory Y.Doc still holds the text; this is
    // the crash net, not the source of truth.
  }
}

export function clearCollabBuffer(accountId: string, objectId: string): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(collabBufferKey(accountId, objectId));
  } catch {
    /* ignore */
  }
}
