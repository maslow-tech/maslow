/**
 * Side-peek — the object editor as a slide-over.
 *
 * Clicking a row in any database layout (and, in phase 6, a node in the graph)
 * opens the object HERE rather than navigating: the table underneath keeps its
 * filters, its scroll offset and — for the graph — its camera, because the peek
 * only ever adds `?peek=<id>` to the current route (see `lib/peek.tsx`).
 *
 * The point of the panel is that it is not a lesser editor. It mounts the same
 * stack the object page mounts — `useObjectEditor` below — so a peek gets the
 * per-object CAS save queue, the local draft mirror with its version rule, the
 * conflict / recovery / locked banners, BlockEditor with `[[link]]`
 * autocomplete, PropsPanel with typed editors, links and history. Nothing about
 * writing is weaker here than on the page.
 *
 * `useObjectEditor` is exported so the object page can adopt it verbatim and
 * leave exactly ONE implementation of this wiring — including the collab room,
 * when the page mounts one: the room belongs in this hook, so the page and the
 * peek can never diverge on which fields the room owns and which the save queue
 * still carries. (The page's own refactor is deliberately left out of this
 * change, which touches no file another parallel task is editing.)
 *
 * Panel rules, each of which is a real complaint about slide-overs:
 *
 *  - **Escape and click-outside close it, flushing first.** A panel that eats
 *    the last sentence you typed because you clicked the table behind it is
 *    worse than no panel. The dismissal kicks the registered flush before the
 *    URL changes, and the queue is disposed only after its own flush settles.
 *  - **It is a stack, but dismissing is not going back.** "Open all" from a
 *    graph selection pushes several, and the header shows how many are behind —
 *    yet the X, Escape and the scrim all close the WHOLE panel. Popping one per
 *    click made the X a second Back button (see `dismissPeek` below). BACK still
 *    walks the stack down, which is why the stack lives in the URL.
 *  - **It is resizable and it remembers.** 520px is a default, not a law;
 *    drag the edge (or use the arrow keys on the separator, because a resize
 *    that only a pointer can do is a resize a keyboard user cannot do).
 *  - **Focus is trapped and restored.** Tab cycles inside the panel while it is
 *    open; on close, focus returns to the row that opened it.
 *  - **Motion is a preference.** `prefers-reduced-motion` collapses the slide
 *    to an instant swap rather than a shorter animation.
 *  - **On a phone it is a full-screen sheet.** A 520px panel that must leave
 *    120px of caller visible has nowhere to be on a 390px screen. Below
 *    `MOBILE_QUERY` the peek covers the viewport, rises from the BOTTOM edge
 *    (the direction a sheet comes from on a phone, and the direction a thumb
 *    can dismiss), keeps its safe-area padding clear of the home indicator, and
 *    drops the resize separator entirely — there is nothing to resize, and a
 *    1.5px drag target beside the screen edge is a trap, not a control.
 *    Everything else — the stack, the focus trap, flush-before-close — is
 *    unchanged, because none of it was ever about width.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link, useLocation } from "react-router";
import { ChevronLeft, ExternalLink, History as HistoryIcon, X } from "lucide-react";

import {
  api,
  ApiError,
  newIdempotencyKey,
  type BrainObject,
  type History,
  type PropDef,
  type Whoami,
} from "../lib/api";
import {
  createSaveQueue,
  type ConflictEvent,
  type SaveEvent,
  type SaveQueue,
} from "../lib/saveQueue";
import {
  applicability,
  clearCollabBuffer,
  clearDraft,
  purgeForeignDrafts,
  readCollabBuffer,
  readDraft,
  writeCollabBuffer,
  writeDraft,
  type CollabBuffer,
  type DraftFields,
  type StoredDraft,
} from "../lib/draftMirror";
import { registerPeekFlush, usePeek } from "../lib/peek";
import { useIsMobile } from "../lib/mobile";
import {
  applySnapshot,
  collabConflictFields,
  diffKeys,
  fieldNames,
  saveLabel,
  saveToneClass,
  type Snapshot,
} from "../views/ObjectView";
import { BlockEditor } from "./editor/BlockEditor";
import { ConflictBanner } from "./ConflictBanner";
import { HistoryDialog } from "./HistoryDialog";
import { Markdown } from "./Markdown";
import { PropsPanel } from "./PropsPanel";
import { EdgeGroup, Empty, PrivateBadge, Spinner, TypePill } from "./bits";
import { Button, buttonVariants } from "./ui/button";
import { fmtDate, fmtRelative } from "../lib/ui";
import { useCollabRoom, useCollabTitle, type UseCollabRoom } from "../lib/useCollab";
import { isDemo } from "../demo";
import {
  PEEK_DEFAULT_WIDTH,
  PEEK_MAX_WIDTH,
  PEEK_MIN_WIDTH,
  clampPeekWidth,
  readPeekWidth,
  writePeekWidth,
} from "../lib/peekWidth";

/* ------------------------------------------------------------------ width */

// Lives in lib/peekWidth so the GRAPH can ask how wide the peek is without
// importing this file (and with it the block editor + prosemirror). Re-exported
// because this module is still the peek's public face.
export { PEEK_MAX_WIDTH, PEEK_MIN_WIDTH, clampPeekWidth, readPeekWidth } from "../lib/peekWidth";

/* ----------------------------------------------------------------- motion */

/** OS-level motion preference, watched live. A runtime without matchMedia is
 *  treated as "motion is fine", never as a crash. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    return;
  }, []);
  return reduced;
}

const PEEK_TRANSITION_MS = 180;

/* ----------------------------------------------------------- editor stack */

interface ObjectEditor {
  obj: BrainObject | null;
  hist: History | null;
  defs: PropDef[];
  draft: Snapshot | null;
  version: number;
  save: SaveEvent;
  conflict: ConflictEvent | null;
  locked: { reason: string; fields: string[] } | null;
  recovery: StoredDraft | null;
  /** a real 404/403 — the object is gone or not permitted to this member. */
  missing: boolean;
  /**
   * A TRANSIENT load failure (5xx / network drop, most often the box self-
   * updating its app container) — NOT "missing". Distinct so the copy and
   * affordance differ: `missing` is a dead end, `loadError` is retryable via
   * `retry`. Mirrors ObjectView, whose comment calls conflating the two "a lie
   * the user cannot recover from without a full reload".
   */
  loadError: boolean;
  /** re-run the load (the load-error state's "Try again"). */
  retry(): void;
  /**
   * The live room, or null when collab is not in play (a viewer, the demo
   * build, a trashed object, or before the save queue exists). Null is the
   * single-player path, not an error: the editor stays fully usable.
   */
  collab: UseCollabRoom | null;
  /** may this member write to THIS object right now (UX only — the endpoints
   *  refuse independently, which is where the boundary actually is) */
  editable: boolean;
  online: boolean;
  /** send whatever is buffered now (blur, close, navigation) */
  flush(): void;
  onTitle(value: string): void;
  onBody(md: string): void;
  onProp(name: string, value: unknown): void;
  onLink(input: { to: string; rel: string }): void;
  keepMine(): void;
  takeTheirs(): void;
  restoreDraft(): void;
  discardDraft(): void;
  dismissLocked(): void;
}

/**
 * The whole write-side of an object view: read it, hold an editable draft
 * beside the server's copy, and run every keystroke through a per-object save
 * queue that debounces, patches field-granularly, rebases its own 409s and
 * STOPS (never merges) on a true same-field conflict.
 *
 * This is the object page's behaviour, lifted so the peek cannot drift from it.
 */
function useObjectEditor(id: string, user: Whoami): ObjectEditor {
  const [obj, setObj] = useState<BrainObject | null>(null);
  const [hist, setHist] = useState<History | null>(null);
  const [defs, setDefs] = useState<PropDef[]>([]);
  const [missing, setMissing] = useState(false);
  // A TRANSIENT load failure (500/502/network, most often the box self-updating)
  // is not "missing" — it is retryable, and must not masquerade as "doesn't
  // exist". Distinct from `missing` (a real 404/403). `reloadNonce` re-runs the
  // load effect on demand.
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const retry = useCallback(() => setReloadNonce((n) => n + 1), []);

  const [draft, setDraft] = useState<Snapshot | null>(null);
  const draftRef = useRef<Snapshot | null>(null);
  draftRef.current = draft;
  /**
   * The user's draft captured when a rebase-exhaustion `reverted` rolls the
   * visible edit back to the server's values — so `keepMine` restores what the
   * user typed, not the server text the revert just wrote. Cleared on resolve or
   * on a fresh edit. (See the identical guard in ObjectView.)
   */
  const revertedDraftRef = useRef<Snapshot | null>(null);

  const [version, setVersion] = useState(0);
  const [save, setSave] = useState<SaveEvent>({ kind: "idle" });
  const [conflict, setConflict] = useState<ConflictEvent | null>(null);
  const [locked, setLocked] = useState<{ reason: string; fields: string[] } | null>(null);
  const [recovery, setRecovery] = useState<StoredDraft | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);

  const queueRef = useRef<SaveQueue | null>(null);
  /** The live collab session, read at pagehide time to flush its offline buffer
   *  (assigned below once `collab` exists). */
  const collabRef = useRef<UseCollabRoom | null>(null);
  /** Routes a title edit into the live room's CRDT; `false` ⇒ no room, use CAS. */
  const writeRoomTitleRef = useRef<(value: string) => boolean>(() => false);
  /**
   * The same queue as `queueRef`, as STATE — the live room has to be told about
   * it, and a ref does not re-render. The room is joined only once the queue
   * exists: `connectRoom` suspends body/title on it, and joining first would
   * leave a window where the CRDT and the CAS queue both own the body.
   */
  const [queue, setQueue] = useState<SaveQueue | null>(null);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  // Tab close: mirror first, then a best-effort keepalive send — in that order,
  // because the page dies before a response could be read.
  //
  // Also flush the collab OFFLINE BUFFER here. React runs NO effect cleanup on a
  // tab close/reload/bfcache background, so the session's `destroy` (which also
  // flushes) never fires on this path — the last <500ms of offline body/title
  // keystrokes would sit in the un-elapsed persist throttle window and be lost
  // on the next mount, defeating the buffer's crash-net guarantee. In collab
  // mode body/title live ONLY in the Y.Doc (the CAS queue has them suspended),
  // so `flushBeacon` carries nothing for them — the buffer is their only offline
  // home. `visibilitychange:hidden` covers mobile, where a tab backgrounded into
  // the bfcache may not fire `pagehide`; `flushPersist` is a cheap idempotent
  // localStorage write (a no-op while live) so firing it there costs nothing.
  useEffect(() => {
    const bye = () => {
      queueRef.current?.flushBeacon();
      collabRef.current?.flushPersist();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") collabRef.current?.flushPersist();
    };
    window.addEventListener("pagehide", bye);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", bye);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setObj(null);
    setHist(null);
    setDraft(null);
    setMissing(false);
    setLoadError(false);
    setSave({ kind: "idle" });
    setConflict(null);
    setLocked(null);
    setRecovery(null);
    revertedDraftRef.current = null;

    // A draft that is not ours is never read, and never survives.
    purgeForeignDrafts(user.id);

    api
      .object(id)
      .then((o) => {
        if (cancelled) return;
        setObj(o);
        setVersion(o.version);
        const base: Snapshot = { title: o.title, body: o.body ?? "", props: { ...o.props } };
        setDraft(base);

        const writable = user.role !== "viewer" && !isDemo() && !o.deleted_at;
        if (!writable) return;

        const queue = createSaveQueue({
          objectId: id,
          baseVersion: o.version,
          base: { title: base.title, body: base.body, props: { ...base.props } },
          save: (patch) => api.patchObject(id, patch),
          mirror: {
            write: (fields, baseVersion) => writeDraft(user.id, id, fields, baseVersion),
            clear: () => clearDraft(user.id, id),
          },
          onState: (event) => {
            if (cancelled) return;
            setSave(event);
            if (event.kind === "saved") {
              setVersion(event.version);
              setConflict(null);
              setLocked(null);
              revertedDraftRef.current = null;
            }
            if (event.kind === "locked") setLocked({ reason: event.reason, fields: event.fields });
            // Rebase exhaustion: roll the optimistic edit back visibly — but
            // capture the user's pre-revert draft first so keepMine restores it.
            if (event.kind === "reverted") {
              revertedDraftRef.current = draftRef.current;
              applyFieldsTo(setDraft, event.fields);
            }
          },
          onConflict: (event) => {
            if (!cancelled) setConflict(event);
          },
        });
        queueRef.current = queue;
        setQueue(queue);

        const stored = readDraft(user.id, id);
        if (!stored) return;
        if (applicability(stored, o.version) === "auto") {
          applyFieldsTo(setDraft, stored.fields);
          queue.change(stored.fields);
        } else {
          setRecovery(stored);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Only a real 404 (gone) or 403 (not permitted) is "doesn't exist". Any
        // other failure — a 5xx or a network drop while the box recreates its
        // app container — is transient and retryable; showing "doesn't exist"
        // there is a lie the user cannot recover from without a full reload.
        const status = err instanceof ApiError ? err.status : null;
        if (status === 404 || status === 403) setMissing(true);
        else setLoadError(true);
      });

    api
      .history(id)
      .then((h) => {
        if (!cancelled) setHist(h);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      const q = queueRef.current;
      queueRef.current = null;
      setQueue(null);
      // Closing a peek is a flush, not a drop: send what is buffered, then let
      // go. The queue outlives this component until its own flush settles.
      if (q) void q.flush().finally(() => q.dispose());
    };
  }, [id, user.id, user.role, reloadNonce]);

  useEffect(() => {
    let cancelled = false;
    const type = obj?.type;
    if (!type) {
      setDefs([]);
      return;
    }
    api
      .types()
      .then((ts) => {
        if (!cancelled) setDefs(ts.find((t) => t.name === type)?.properties ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [obj?.type]);

  const flush = useCallback(() => {
    void queueRef.current?.flush();
  }, []);

  const onTitle = useCallback((value: string) => {
    revertedDraftRef.current = null;
    setDraft((d) => (d ? { ...d, title: value } : d));
    // A live (or offline-buffering) room owns the title: write it into the CRDT
    // and skip CAS, which the box would refuse with 409 `open_in_editor`.
    if (writeRoomTitleRef.current(value)) return;
    queueRef.current?.change({ title: value === "" ? null : value });
  }, []);

  const onBody = useCallback((md: string) => {
    revertedDraftRef.current = null;
    setDraft((d) => (d ? { ...d, body: md } : d));
    queueRef.current?.change({ body: md });
  }, []);

  const onProp = useCallback((name: string, value: unknown) => {
    revertedDraftRef.current = null;
    setDraft((d) => (d ? { ...d, props: { ...d.props, [name]: value } } : d));
    // One field, one patch — never the whole props object.
    queueRef.current?.change({ props: { [name]: value ?? null } });
  }, []);

  const onLink = useCallback(
    (input: { to: string; rel: string }) => {
      api
        .linkObject(id, { ...input, idempotencyKey: newIdempotencyKey() })
        .then(() => api.object(id))
        .then(setObj)
        .catch(() => undefined);
    },
    [id],
  );

  const refetch = useCallback(() => {
    api
      .object(id)
      .then((o) => {
        setObj(o);
        setVersion(o.version);
      })
      .catch(() => undefined);
    api
      .history(id)
      .then(setHist)
      .catch(() => undefined);
  }, [id]);

  const keepMine = useCallback(() => {
    const q = queueRef.current;
    const c = conflict;
    // Prefer the pre-revert draft (the user's edit), not the reverted server
    // values now on screen — see ObjectView.keepMine for the full rationale.
    const reverted = revertedDraftRef.current;
    const d = reverted ?? draftRef.current;
    if (!q || !c || !d || c.currentVersion === null) return;
    const theirs = {
      title: c.current?.title ?? null,
      body: c.current?.body ?? "",
      props: { ...(c.current?.props ?? {}) },
    };
    q.rebaseOnto(c.currentVersion, theirs);
    setVersion(c.currentVersion);
    if (reverted) setDraft(reverted);
    const fields: DraftFields = { title: d.title, body: d.body ?? "" };
    const changed = diffKeys(theirs.props, d.props);
    if (changed.length > 0) {
      const props: Record<string, unknown> = {};
      for (const k of changed) props[k] = d.props[k] ?? null;
      fields.props = props;
    }
    revertedDraftRef.current = null;
    setConflict(null);
    q.change(fields);
    void q.flush();
  }, [conflict]);

  const takeTheirs = useCallback(() => {
    const q = queueRef.current;
    const c = conflict;
    if (!q || !c) return;
    revertedDraftRef.current = null;
    q.discard();
    if (c.current) {
      const theirs: Snapshot = {
        title: c.current.title,
        body: c.current.body ?? "",
        props: { ...c.current.props },
      };
      setDraft(theirs);
      if (c.currentVersion !== null) {
        q.rebaseOnto(c.currentVersion, theirs);
        setVersion(c.currentVersion);
      }
    }
    setConflict(null);
    refetch();
  }, [conflict, refetch]);

  const restoreDraft = useCallback(() => {
    const q = queueRef.current;
    const stored = recovery;
    if (!q || !stored) return;
    applyFieldsTo(setDraft, stored.fields);
    q.change(stored.fields);
    setRecovery(null);
  }, [recovery]);

  const discardDraft = useCallback(() => {
    clearDraft(user.id, id);
    setRecovery(null);
  }, [user.id, id]);

  const dismissLocked = useCallback(() => setLocked(null), []);

  const editable = user.role !== "viewer" && !isDemo() && obj !== null && !obj.deleted_at;

  /**
   * THE LIVE ROOM, for the peek exactly as for the full page — a peek is a real
   * editor, and an edit made in one must be the same edit a peer sees. Null
   * whenever collab is not in play, and the editor then falls back to the CAS
   * path unchanged.
   */
  // The offline-buffer crash net — see ObjectView; the peek is a real editor and
  // must not lose offline body/title on a reload any more than the full page.
  const collabPersistence = useMemo(
    () => ({
      load: () => readCollabBuffer(user.id, id),
      save: (room: CollabBuffer) => writeCollabBuffer(user.id, id, room),
      clear: () => clearCollabBuffer(user.id, id),
    }),
    [user.id, id],
  );

  const collab = useCollabRoom({
    objectId: id,
    enabled: editable && queue !== null,
    saveQueue: queue,
    user: { id: user.id, name: user.name },
    persistence: collabPersistence,
  });

  // The title is room-owned (COLLAB_OWNED_FIELDS) but, unlike the body, has no
  // editor binding — bind it to the CRDT and reflect peers' edits back into the
  // draft, or it 409s ("locked by the editor") and is lost once the socket is up.
  writeRoomTitleRef.current = useCollabTitle(collab, (title) =>
    setDraft((d) => (d && d.title !== title ? { ...d, title } : d)),
  );

  // Read at pagehide/visibilitychange time (see the tab-close effect above) to
  // flush the collab offline buffer on the one teardown path React effect
  // cleanup does not cover.
  collabRef.current = collab;

  return {
    obj,
    collab,
    hist,
    defs,
    draft,
    version,
    save,
    conflict,
    locked,
    recovery,
    missing,
    loadError,
    retry,
    editable,
    online,
    flush,
    onTitle,
    onBody,
    onProp,
    onLink,
    keepMine,
    takeTheirs,
    restoreDraft,
    discardDraft,
    dismissLocked,
  };
}

function applyFieldsTo(
  set: React.Dispatch<React.SetStateAction<Snapshot | null>>,
  fields: DraftFields,
): void {
  set((d) => (d ? applySnapshot(d, fields) : d));
}

/* -------------------------------------------------------------- the panel */

/**
 * Everything focusable inside the panel, in DOM order.
 *
 * Deliberately NOT filtered on `offsetParent`/layout: the panel is inside a
 * positioned, animating container, and a layout-derived visibility test is
 * exactly the kind of thing that silently returns nothing and leaves the trap
 * cycling into the page behind. `hidden`/`aria-hidden` subtrees are the honest
 * signal, and they are the only ones this panel ever produces.
 */
export function focusablesIn(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]',
  );
  return [...nodes].filter((n) => !n.hidden && !n.closest("[hidden],[aria-hidden='true']"));
}

export function SidePeek({ user }: { user: Whoami }) {
  const { top, depth, closePeek, closeAllPeeks } = usePeek();

  /**
   * DISMISSING IS NOT GOING BACK.
   *
   * Every gesture that means "get this panel off my screen" — the X, Escape,
   * the scrim — closes the WHOLE stack, not the top of it.
   *
   * It used to pop one. Opening pushes, so clicking through a few linked nodes
   * in the graph builds a stack, and X then revealed the previous object: a
   * second Back button wearing a close icon, needing as many clicks as you had
   * made. It looked correct only on the first open, where a stack of one made
   * "pop" and "close" the same thing (reported 2026-07-26).
   *
   * Back is untouched and still walks the stack down one entry at a time — that
   * is Back's job, and the reason the stack lives in the URL. Nothing is lost by
   * dismissing: every peek is one history entry behind you.
   */
  const dismissPeek = closeAllPeeks;
  const reduced = usePrefersReducedMotion();

  // The id being RENDERED lags `top` by one exit animation, so the panel can
  // slide out instead of vanishing.
  const [renderId, setRenderId] = useState<string | null>(top);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (top) {
      setRenderId(top);
      if (reduced) {
        setShown(true);
        return;
      }
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    if (reduced) {
      setRenderId(null);
      return;
    }
    const t = setTimeout(() => setRenderId(null), PEEK_TRANSITION_MS);
    return () => clearTimeout(t);
  }, [top, reduced]);

  /* width + resize */
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  /**
   * On the GRAPH the scrim takes no clicks.
   *
   * The map is a surface you keep working while the peek is open — clicking a
   * lit neighbour should go to that neighbour — but a full-viewport scrim sits
   * over the canvas and ate the first click of every one of those, so picking a
   * neighbour took two clicks: one to dismiss the panel, one to hit the node.
   * The graph already handles its own click-outside (empty canvas closes the
   * peek and clears the halo), so the scrim there is redundant as well as
   * harmful. Everywhere else it keeps its click-to-close.
   */
  const clickThrough = pathname.startsWith("/graph");
  const [width, setWidth] = useState(() => readPeekWidth());
  useEffect(() => {
    const onResize = () => setWidth((w) => clampPeekWidth(w, window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [width],
  );
  const onResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // The panel is anchored right: dragging LEFT makes it wider.
    setWidth(clampPeekWidth(drag.startWidth + (drag.startX - e.clientX), window.innerWidth));
  }, []);
  const onResizeEnd = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      writePeekWidth(width);
    },
    [width],
  );
  const onResizeKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 24;
    let next: number | null = null;
    if (e.key === "ArrowLeft")
      next = clampPeekWidth(readWidthOf(e.currentTarget) + step, window.innerWidth);
    if (e.key === "ArrowRight")
      next = clampPeekWidth(readWidthOf(e.currentTarget) - step, window.innerWidth);
    if (e.key === "Home") next = clampPeekWidth(PEEK_MAX_WIDTH, window.innerWidth);
    if (e.key === "End") next = PEEK_MIN_WIDTH;
    if (next === null) return;
    e.preventDefault();
    setWidth(next);
    writePeekWidth(next);
  }, []);

  /* focus trap + restoration */
  const panelRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!renderId) return;
    if (!returnFocusRef.current) {
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement ? active : null;
    }
    panelRef.current?.focus();
    return () => {
      // Only on the LAST close, not when the stack swaps its top card.
      if (top) return;
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      if (back && back.isConnected) back.focus();
    };
  }, [renderId, top]);

  const onPanelKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key === "Escape") {
        // A menu or popover opened from inside the peek renders in a PORTAL
        // (Radix Select in PropsPanel, etc.) — its events still bubble through
        // the React tree to here. Escape there dismisses just that layer, not
        // the whole peek stack: the portal target sits outside the panel, so
        // the containment check below skips it. Inline consumers (the slash
        // menu, the link/image popovers) stopPropagation instead. What this
        // must NOT check is defaultPrevented: prosemirror-view's
        // captureKeyDown returns true for every bare Escape (its keydown
        // handler then preventDefaults it), so that flag is always set when
        // focus is in the editor — the peek's most common close path.
        const root = panelRef.current;
        if (root && e.target instanceof Node && !root.contains(e.target)) return;
        e.stopPropagation();
        dismissPeek();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const items = focusablesIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [dismissPeek],
  );

  // Escape while focus has wandered outside the panel (a portalled menu, the
  // page behind) must still close it.
  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An open layer (a portalled Select/menu) that consumed this Escape to
      // close ITSELF preventDefaults it — that press was aimed at the menu,
      // not the peek. Radix's document-level listener runs before window ones,
      // so the flag is already set by the time we see the event.
      if (e.defaultPrevented) return;
      if (panelRef.current?.contains(document.activeElement)) return;
      dismissPeek();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, dismissPeek]);

  if (!renderId) return null;

  const duration = reduced ? 0 : PEEK_TRANSITION_MS;

  return (
    // The WRAPPER has to go transparent too, not just the scrim: it is itself a
    // full-viewport `inset-0` box, so with only the scrim disabled the wrapper
    // kept swallowing every click over the canvas. The panel re-enables pointer
    // events for itself below.
    <div
      className={`fixed inset-0 z-40 ${clickThrough ? "pointer-events-none" : ""}`}
      data-testid="side-peek"
    >
      {/* the scrim: click-outside closes (and flushes). Deliberately light —
          the caller stays legible, which is the whole point of a peek.

          On the GRAPH it does not take clicks at all. The map is a surface you
          keep working while the peek is open — clicking a lit neighbour should
          go to that neighbour — but the scrim sits over the canvas and ate the
          first click of every one of those, so selecting a neighbour took two
          clicks: one to dismiss the panel, one to actually hit the node. The
          graph handles its own click-outside (empty canvas closes the peek and
          clears the highlight), so the scrim there is redundant as well as
          harmful. `pointer-events-none` keeps the tint and drops the trap. */}
      <div
        aria-hidden
        {...(clickThrough ? {} : { onMouseDown: dismissPeek })}
        // Darker behind a full-screen sheet: there is no caller left to keep
        // legible, and the scrim is the only thing saying "this is over that".
        className={`absolute inset-0 ${isMobile ? "bg-black/30" : "bg-black/10"} ${
          clickThrough ? "pointer-events-none" : ""
        }`}
        style={{ opacity: shown ? 1 : 0, transition: `opacity ${duration}ms ease-out` }}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Object peek"
        tabIndex={-1}
        data-mobile={isMobile ? "true" : undefined}
        onKeyDown={onPanelKeyDown}
        className={
          isMobile
            ? // safe-top too: the sheet is full-screen (inset-0) under a
              // translucent status bar + viewport-fit=cover, so without it the
              // header (close X, breadcrumb) paints under the notch.
              "pointer-events-auto safe-top safe-bottom absolute inset-0 flex flex-col border-t border-line-soft bg-ground shadow-[0_-8px_28px_rgba(0,0,0,0.16)] outline-none"
            : "pointer-events-auto absolute inset-y-0 right-0 flex flex-col border-l border-line-soft bg-ground shadow-[-8px_0_28px_rgba(0,0,0,0.10)] outline-none"
        }
        style={
          isMobile
            ? {
                transform: shown ? "translateY(0)" : "translateY(100%)",
                transition: `transform ${duration}ms cubic-bezier(0.32, 0.72, 0, 1)`,
              }
            : {
                width,
                transform: shown ? "translateX(0)" : "translateX(100%)",
                transition: `transform ${duration}ms cubic-bezier(0.32, 0.72, 0, 1)`,
              }
        }
      >
        {/* Nothing to resize when the panel IS the screen. */}
        {!isMobile && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize peek"
            aria-valuenow={width}
            aria-valuemin={PEEK_MIN_WIDTH}
            aria-valuemax={PEEK_MAX_WIDTH}
            tabIndex={0}
            data-width={width}
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            onKeyDown={onResizeKey}
            className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize bg-transparent hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
          />
        )}
        <PeekBody
          key={renderId}
          id={renderId}
          user={user}
          depth={depth}
          onClose={dismissPeek}
          onBack={closePeek}
        />
      </aside>
    </div>
  );
}

/** The separator carries the current width so the keyboard handler needs no
 *  closure over state that a fast key-repeat could have staled. */
function readWidthOf(el: HTMLElement): number {
  const n = Number(el.dataset.width);
  return Number.isFinite(n) ? n : PEEK_DEFAULT_WIDTH;
}

/* ---------------------------------------------------------------- content */

function PeekBody({
  id,
  user,
  depth,
  onClose,
  onBack,
}: {
  id: string;
  user: Whoami;
  depth: number;
  onClose: () => void;
  /** pop ONE peek — the header's back chevron only. Never the X. */
  onBack: () => void;
}) {
  const editor = useObjectEditor(id, user);
  const [histOpen, setHistOpen] = useState(false);

  // Closing from anywhere (Escape, the scrim, the X, Back) flushes this
  // object's buffered edits first.
  useEffect(() => registerPeekFlush(id, editor.flush), [id, editor.flush]);

  const { obj, draft, hist, defs, editable } = editor;

  const refProps = useMemo(
    () =>
      new Set(
        (obj?.links ?? [])
          .filter((l) => l.provenance.startsWith("ref:"))
          .map((l) => l.provenance.slice(4)),
      ),
    [obj],
  );
  const singleRefKeys = useMemo(
    () => new Set(defs.filter((d) => d.kind === "ref").map((d) => d.name)),
    [defs],
  );
  const refTitles = useMemo(() => {
    const out: Record<string, { title: string | null; type: string | null }> = {};
    for (const l of obj?.links ?? []) {
      if (!l.provenance.startsWith("ref:")) continue;
      const key = l.provenance.slice(4);
      if (singleRefKeys.has(key)) out[key] = { title: l.target_title, type: l.target_type };
    }
    return out;
  }, [obj, singleRefKeys]);

  const state = saveLabel(
    editor.save,
    editor.online,
    editor.conflict !== null,
    editor.locked !== null,
    editor.collab ? editor.collab.state.status : null,
  );

  if (editor.missing) {
    return (
      <>
        <PeekHeader
          id={id}
          obj={null}
          depth={depth}
          onClose={onClose}
          onBack={onBack}
          onHistory={null}
        />
        <div className="p-6">
          <Empty>
            This object doesn't exist — or your permissions don't extend to it. Nothing here is
            hidden from you by accident.
          </Empty>
        </div>
      </>
    );
  }

  // A transient load failure (5xx / network, most often the box self-updating)
  // is NOT "missing": the object is here and visible — say so, and offer a
  // retry, rather than the alarming (and false) "doesn't exist / no permission".
  if (editor.loadError && !obj) {
    return (
      <>
        <PeekHeader
          id={id}
          obj={null}
          depth={depth}
          onClose={onClose}
          onBack={onBack}
          onHistory={null}
        />
        <div className="p-6">
          <Empty
            action={
              <Button variant="outline" size="sm" onClick={editor.retry}>
                Try again
              </Button>
            }
          >
            Couldn't load this object — a hiccup, most likely while the box reconnects. It's still
            here.
          </Empty>
        </div>
      </>
    );
  }

  if (!obj || !draft) {
    return (
      <>
        <PeekHeader
          id={id}
          obj={null}
          depth={depth}
          onClose={onClose}
          onBack={onBack}
          onHistory={null}
        />
        <div className="p-6">
          <Spinner rows={4} />
        </div>
      </>
    );
  }

  const current: Snapshot = { title: obj.title, body: obj.body ?? "", props: { ...obj.props } };
  const recovered = editor.recovery ? applySnapshot(current, editor.recovery.fields) : null;
  const manualLinks = obj.links.filter((l) => l.provenance === "manual");
  const refLinks = obj.links.filter(
    (l) => l.provenance.startsWith("ref:") && !singleRefKeys.has(l.provenance.slice(4)),
  );
  const readOnlyValues = Object.fromEntries(
    Object.entries(draft.props).filter(
      ([k, v]) => !refProps.has(k) && !(Array.isArray(v) && refProps.size > 0),
    ),
  );

  return (
    <>
      <PeekHeader
        id={id}
        obj={obj}
        depth={depth}
        onClose={onClose}
        onBack={onBack}
        onHistory={hist ? () => setHistOpen(true) : null}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-10">
        {obj.deleted_at && (
          <div className="mb-4 border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
            Deleted {fmtDate(obj.deleted_at)} — kept forever as a tombstone.
          </div>
        )}

        {editor.conflict && (
          <ConflictBanner
            variant="conflict"
            actorName={editor.conflict.current?.actor_name ?? null}
            when={editor.conflict.current?.updated_at ?? null}
            fields={editor.conflict.fields}
            theirs={
              editor.conflict.current
                ? {
                    title: editor.conflict.current.title,
                    body: editor.conflict.current.body,
                    props: editor.conflict.current.props,
                  }
                : null
            }
            mine={draft}
            onKeepMine={editor.keepMine}
            onTakeTheirs={editor.takeTheirs}
          />
        )}
        {/* The COLLAB epoch-reset conflict — its own banner, wired to the room's
            keep/take. Without it the reconnect drops our offline edits silently. */}
        {editor.collab?.state.conflict && (
          <ConflictBanner
            variant="conflict"
            actorName={null}
            when={null}
            fields={collabConflictFields(editor.collab.state.conflict)}
            theirs={{
              title: editor.collab.state.conflict.theirs.title,
              body: editor.collab.state.conflict.theirs.body,
              props: {},
            }}
            mine={{
              title: editor.collab.state.conflict.mine.title,
              body: editor.collab.state.conflict.mine.body,
              props: {},
            }}
            onKeepMine={editor.collab.keepMine}
            onTakeTheirs={editor.collab.takeTheirs}
          />
        )}
        {editor.locked && (
          <ConflictBanner
            variant="locked"
            reason={editor.locked.reason}
            fields={editor.locked.fields}
            onDismiss={editor.dismissLocked}
          />
        )}
        {editor.recovery && recovered && (
          <ConflictBanner
            variant="recovery"
            when={new Date(editor.recovery.savedAt).toISOString()}
            fields={fieldNames(editor.recovery.fields)}
            theirs={current}
            mine={recovered}
            onKeepMine={editor.restoreDraft}
            onTakeTheirs={editor.discardDraft}
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <TypePill type={obj.type} />
          <PrivateBadge visibility={obj.visibility} />
          <span className="ml-auto flex items-center gap-2.5 text-[11.5px] text-dim">
            {editable && state && (
              <span role="status" aria-live="polite" className={saveToneClass(state.tone)}>
                {state.text}
              </span>
            )}
            <span>
              updated {fmtRelative(obj.updated_at)} · v{editor.version || obj.version}
            </span>
          </span>
        </div>

        {editable ? (
          <input
            value={draft.title ?? ""}
            onChange={(e) => editor.onTitle(e.target.value)}
            onBlur={editor.flush}
            aria-label="Title"
            placeholder="untitled"
            spellCheck={false}
            className="mt-3 mb-3 w-full border-0 bg-transparent p-0 text-[21px] leading-tight font-[680] tracking-[-0.02em] text-ink outline-none placeholder:text-dim"
          />
        ) : (
          <h2 className="mt-3 mb-3 text-[21px] leading-tight font-[680] tracking-[-0.02em]">
            {draft.title ?? "untitled"}
          </h2>
        )}

        {editable ? (
          <BlockEditor
            // Re-keyed on the room's epoch: an epoch reset hands back a NEW
            // Y.Doc, and an editor bound to the old one types into a document
            // nobody is listening to.
            key={editor.collab ? `collab-${editor.collab.state.epoch ?? "none"}` : "cas"}
            value={draft.body ?? ""}
            onChange={editor.onBody}
            onBlur={editor.flush}
            onLink={editor.onLink}
            ariaLabel="Body"
            placeholder="Write something, or press / for blocks"
            {...(editor.collab ? { collab: editor.collab.binding } : {})}
          />
        ) : draft.body ? (
          <Markdown body={draft.body} />
        ) : (
          <p className="text-[13.5px] text-dim italic">This object has no body text.</p>
        )}

        <div className="mt-8 flex flex-col gap-6 border-t border-line-soft pt-6">
          {editable ? (
            <PropsPanel
              defs={defs}
              values={draft.props}
              refTitles={refTitles}
              onChange={editor.onProp}
            />
          ) : (
            <PropsPanel defs={defs} values={readOnlyValues} readOnly />
          )}
          <EdgeGroup label="Links" edges={[...refLinks, ...manualLinks]} />
          <EdgeGroup label="Linked from" edges={obj.backlinks} />
          {obj.hidden_from_you > 0 && (
            <p className="border border-line-soft bg-hover px-3 py-2 text-[12px] text-dim">
              {obj.hidden_from_you} linked object{obj.hidden_from_you === 1 ? " is" : "s are"}{" "}
              private and not visible to you.
            </p>
          )}
        </div>
      </div>

      {hist && (
        <HistoryDialog
          open={histOpen}
          onOpenChange={setHistOpen}
          history={hist}
          title={draft.title ?? "untitled"}
          currentTitle={draft.title}
          currentBody={draft.body}
          refPropKeys={refProps}
        />
      )}
    </>
  );
}

function PeekHeader({
  id,
  obj,
  depth,
  onClose,
  onBack,
  onHistory,
}: {
  id: string;
  obj: BrainObject | null;
  depth: number;
  onClose: () => void;
  /** pop ONE — the chevron. The X calls `onClose`, which closes the panel. */
  onBack: () => void;
  onHistory: (() => void) | null;
}) {
  return (
    <header className="touch-chrome flex shrink-0 items-center gap-1.5 border-b border-line-soft px-4 py-2.5">
      {depth > 1 && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label={`Back to the previous peek (${depth - 1} behind)`}
          title={`${depth - 1} more behind this one`}
        >
          <ChevronLeft />
        </Button>
      )}
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1 truncate text-[12px] text-dim">
        {obj?.type ? (
          <>
            <Link to={`/t/${obj.type}`} className="text-mut hover:text-ink">
              {obj.type}
            </Link>
            <span className="px-1.5">/</span>
          </>
        ) : (
          <>
            <Link to="/notes" className="text-mut hover:text-ink">
              notes
            </Link>
            <span className="px-1.5">/</span>
          </>
        )}
        <span className="text-ink">{obj?.title ?? "untitled"}</span>
      </nav>
      {onHistory && (
        <Button variant="ghost" size="icon-sm" onClick={onHistory} aria-label="History">
          <HistoryIcon />
        </Button>
      )}
      {/* The link drops the ?peek param with the route change, so following it
          closes the panel — one place decides that, the URL. */}
      <Link
        to={`/o/${id}`}
        aria-label="Open full page"
        title="Open full page"
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <ExternalLink />
      </Link>
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close peek">
        <X />
      </Button>
    </header>
  );
}
