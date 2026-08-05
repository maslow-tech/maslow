import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Check, Copy, Share2, Trash2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  ApiError,
  errorMessage,
  newIdempotencyKey,
  type AudienceTag,
  type BrainObject,
  type History,
  type Member,
  type PropDef,
  type TagRow,
  type Whoami,
} from "../lib/api";
import { Markdown } from "../components/Markdown";
import { LocalGraph } from "../components/LocalGraph";
import { HistoryDialog } from "../components/HistoryDialog";
import { ConflictBanner } from "../components/ConflictBanner";
import { PropsPanel } from "../components/PropsPanel";
import { BlockEditor } from "../components/editor/BlockEditor";
import { EdgeGroup, Empty, EnumPill, PrivateBadge, Spinner, TypePill } from "../components/bits";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import {
  attributeProp,
  attributionRuns,
  type Attribution,
  type AttributionRun,
} from "../lib/provenance";
import { rehypeAttributionSpans } from "../lib/rehypeAttributionSpans";
import { fmtDate, fmtDateTime, fmtNumber, fmtRelative } from "../lib/ui";
import { useIsMobile } from "../lib/mobile";
import { useTheme, type Theme } from "../lib/theme";
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
import { useCollabRoom, useCollabTitle } from "../lib/useCollab";
import { readRoomContent, writeRoomContent } from "../lib/collab";
import type { CollabConflict, CollabStatus, RoomContent } from "../lib/collab";
import { isDemo } from "../demo";

/**
 * One object: the markdown body as the hero, everything known about it beside
 * it — and, for anyone who may write, all of it editable in place.
 *
 * The write path is the phase-1 CAS path and nothing else. Every keystroke goes
 * into a per-object `createSaveQueue`, which debounces, sends field-granular
 * patches, rebases its own 409s, and STOPS (never merges) on a true same-field
 * conflict. This view owns none of that logic; it owns the surface:
 *
 *  - the draft mirror is applied by draftMirror's OWN rule — auto only when the
 *    version still matches, otherwise a recovery banner with a diff;
 *  - a conflict is a banner with keep-mine / take-theirs / view-diff, never an
 *    automatic resolution;
 *  - a viewer sees no write affordance at all, while the endpoints keep
 *    refusing viewers independently — this is UX, not the security boundary;
 *  - edits flush on blur and on route change, and mirror-then-send on tab close.
 *
 * Provenance mode, the history dialog and the rail's local-graph mount
 * (`LocalGraph`, which replaced `MiniMap`) are untouched by the write path.
 */

export interface Snapshot {
  title: string | null;
  body: string | null;
  props: Record<string, unknown>;
}

export function ObjectView({ user }: { user: Whoami }) {
  const { id = "" } = useParams();
  const { theme } = useTheme();
  // The SAME 767px switch every other primary view uses (Home documents it as
  // the invariant). CSS `lg:` breakpoints alone put this page out of register
  // with the list pages in the 768-1023px band: a database list at px-8 opened
  // into an object at px-4, jumping the content's left edge on every
  // list→object navigation.
  const isMobile = useIsMobile();
  const [obj, setObj] = useState<BrainObject | null>(null);
  const [hist, setHist] = useState<History | null>(null);
  const [defs, setDefs] = useState<PropDef[]>([]);
  const [missing, setMissing] = useState(false);
  // A TRANSIENT load failure (500/502/network, most often the box self-updating)
  // is not "missing" — it is retryable, and must not masquerade as "doesn't
  // exist". Distinct from `missing` (a real 404/403) so the copy and affordance
  // differ. `reloadNonce` re-runs the load effect on demand.
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [histOpen, setHistOpen] = useState(false);
  const [provenanceMode, setProvenanceMode] = useState(false);

  // The editable draft (what is on screen) is separate from `obj` (what we
  // last read), so a background refresh of links or history never eats
  // keystrokes.
  const [draft, setDraft] = useState<Snapshot | null>(null);
  const draftRef = useRef<Snapshot | null>(null);
  draftRef.current = draft;
  /**
   * The user's draft captured at the instant a rebase-exhaustion `reverted`
   * event rolls the visible edit back to the server's values. Without it,
   * `keepMine` would read `draftRef` — which now holds the SERVER values the
   * revert just wrote — and "keep mine" would re-assert the server's text, the
   * exact opposite of what the button says. Cleared once the user resolves the
   * conflict or types something new.
   */
  const revertedDraftRef = useRef<Snapshot | null>(null);

  const [version, setVersion] = useState(0);
  const [save, setSave] = useState<SaveEvent>({ kind: "idle" });
  const [conflict, setConflict] = useState<ConflictEvent | null>(null);
  const [locked, setLocked] = useState<{ reason: string; fields: string[] } | null>(null);
  const [recovery, setRecovery] = useState<StoredDraft | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);

  const queueRef = useRef<SaveQueue | null>(null);
  /** Routes a title edit into the live room's CRDT; `false` ⇒ no room, use CAS. */
  const writeRoomTitleRef = useRef<(value: string) => boolean>(() => false);
  /**
   * The same queue as `queueRef`, as STATE — the live room needs to be told
   * about it, and a ref does not re-render. The room is joined only once the
   * queue exists, because `connectRoom` suspends body/title on it: joining
   * first would leave a window in which both the CRDT and the CAS queue own the
   * body, which lands every keystroke twice.
   */
  const [queue, setQueue] = useState<SaveQueue | null>(null);

  // A viewer gets no write affordance; neither does the canned demo build,
  // which has no server behind it to write to.
  const canWrite = user.role !== "viewer" && !isDemo();
  /** Two-step trash: armed by the first click, fired by the second. */
  const [armTrash, setArmTrash] = useState(false);
  // Disarm on a timer rather than on blur. Blur fires when the button itself
  // loses focus between the two clicks, which silently re-armed instead of
  // firing — the button said "Confirm" forever and nothing was ever trashed.
  useEffect(() => {
    if (!armTrash) return;
    const t = window.setTimeout(() => setArmTrash(false), 4000);
    return () => window.clearTimeout(t);
  }, [armTrash]);
  const [trashing, setTrashing] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);

  const loadErrorRef = useRef(false);
  loadErrorRef.current = loadError;
  const retryLoad = useCallback(() => setReloadNonce((n) => n + 1), []);
  useEffect(() => {
    const up = () => {
      setOnline(true);
      // Coming back online while a transient load failed: retry automatically so
      // the object appears without a manual reload.
      if (loadErrorRef.current) setReloadNonce((n) => n + 1);
    };
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
    setHistOpen(false);
    setProvenanceMode(false);
    setSave({ kind: "idle" });
    setConflict(null);
    setLocked(null);
    setRecovery(null);
    revertedDraftRef.current = null;

    // Before anything touches storage: a draft that is not ours is never read,
    // and never survives.
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
            // Rebase exhaustion: roll the optimistic edit back visibly, never
            // silently — paired with the conflict banner, always. Capture the
            // user's pre-revert draft FIRST so keepMine can restore what they
            // actually typed, not the server values this revert is about to show.
            if (event.kind === "reverted") {
              revertedDraftRef.current = draftRef.current;
              applyFields(setDraft, event.fields);
            }
          },
          onConflict: (event) => {
            if (!cancelled) setConflict(event);
          },
        });
        queueRef.current = queue;
        setQueue(queue);

        // The local draft mirror. draftMirror decides whether it may be applied
        // at all; a stale draft is OFFERED, never reapplied over newer writes.
        const stored = readDraft(user.id, id);
        if (!stored) return;
        if (applicability(stored, o.version) === "auto") {
          applyFields(setDraft, stored.fields);
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
      // A route change is a flush, not a drop: send what is buffered, then let go.
      if (q) void q.flush().finally(() => q.dispose());
    };
  }, [id, user.id, user.role, reloadNonce]);

  /**
   * THE LIVE ROOM. Null whenever collab is not in play (a viewer, the demo
   * build, a trashed object, or before the save queue exists) — and the editor
   * below then renders exactly as it did before multiplayer: markdown in,
   * markdown out, over the CAS queue. Collab is never a precondition for
   * editing.
   */
  // The offline-buffer crash net for the room's body/title: they travel over
  // the socket, never the CAS draft mirror, so without this a reload/close while
  // the socket is down loses them. Account-scoped, purged with the CAS drafts.
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
    enabled: canWrite && queue !== null && !obj?.deleted_at,
    saveQueue: queue,
    user: { id: user.id, name: user.name },
    persistence: collabPersistence,
  });

  // The title is a room-owned field (COLLAB_OWNED_FIELDS) but, unlike the body,
  // has no editor binding — so bind it to the CRDT here and reflect peers' edits
  // back into the draft. Without this the title 409s ("locked by the editor")
  // and the edit is lost the instant the socket connects.
  writeRoomTitleRef.current = useCollabTitle(collab, (title) =>
    setDraft((d) => (d && d.title !== title ? { ...d, title } : d)),
  );

  // `roomOwnsBody` gates the editor's collab binding: when true the editor binds
  // the CRDT and IGNORES its markdown `value`; when false it is a plain CAS
  // editor bound to `draft.body`.
  //
  // It must stay FALSE until the room has synced AT LEAST ONCE (`everSynced`).
  // Before the first sync the room's Y.Doc holds only the offline buffer (or
  // nothing) — never the object's just-loaded server body — so binding to it
  // then would blank the visible body on every open (a connecting flash), and
  // keep it blank for the whole backoff window while a box self-updates
  // (connecting/offline, never synced). Worse, typing into that empty pre-sync
  // doc makes reconcile see base=EMPTY, mine=<typed>, server=<real body> and
  // raise a spurious conflict. `everSynced` LATCHES true on the first sync and
  // stays true across later drops/denials, so this only holds the body on CAS
  // during the pre-first-sync window; once the CRDT actually carries the server
  // content the body moves onto it. A DENIED room also owns nothing (its
  // never-synced doc is dead), and the denial effect below carries any offline
  // edits back to CAS.
  const roomOwnsBody =
    collab != null && collab.state.status !== "denied" && collab.state.everSynced;
  const denied = collab?.state.status === "denied";
  const collabRef = useRef(collab);
  collabRef.current = collab;
  useEffect(() => {
    // On the denial transition, carry the room's current body/title (which may
    // hold offline edits the CRDT owned) into the CAS draft so the rebuilt editor
    // keeps showing them, and push them through the now-live queue so they are
    // actually saved rather than only kept in the offline buffer. If CAS refuses
    // (a read-only object, or a 401 session expiry), the queue surfaces the
    // honest error — but the text is no longer stranded in a dead Y.Doc.
    if (!denied) return;
    const session = collabRef.current;
    const doc = session?.state.doc;
    if (!doc) return;
    const content = readRoomContent(doc);
    // GUARD AGAINST WIPING THE LOADED BODY. If the room was denied BEFORE it ever
    // synced (BAD_ORIGIN, ROOM_FORBIDDEN, the fail-closed authorizeRoom skeleton,
    // repeated UNAUTHORIZED), the CRDT never received the object's content — it
    // holds only offline edits, or nothing. Carrying an EMPTY never-synced doc
    // into the draft and the CAS queue would PATCH an empty body over the real
    // note (server==base ⇒ classifyConflict reapplies it and it wins), silently
    // destroying title+body on screen and in Postgres. `carryDeniedRoomContent`
    // is the guard: carry only when the doc can stand for the object's content.
    if (!carryDeniedRoomContent(session.state.everSynced, content)) return;
    setDraft((d) => (d ? { ...d, title: content.title, body: content.body } : d));
    queueRef.current?.change({
      title: content.title === "" ? null : content.title,
      body: content.body,
    });
  }, [denied]);

  // Property definitions drive the typed editors — the same list the type pages
  // already read, so a `date` is a date and an `enum` can only hold its values.
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
    // A new keystroke is a fresh decision: any pre-revert draft kept for keepMine
    // no longer describes what the user wants.
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
    // One field, one patch — never the whole props object. Clearing sends null,
    // which is the delete sentinel, and leaves every sibling key alone.
    queueRef.current?.change({ props: { [name]: value ?? null } });
  }, []);

  // A `[[link]]` picked in the editor is a real edge. Link edits do not bump the
  // version, so they carry an idempotency key instead of a baseVersion.
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

  /** Keep mine: re-assert exactly our values on top of the version that beat us. */
  const keepMine = useCallback(() => {
    const q = queueRef.current;
    const c = conflict;
    // Prefer the pre-revert draft: on rebase exhaustion the visible draft was
    // rolled back to the server's values, and re-asserting THOSE would be the
    // opposite of "keep mine". Fall back to the live draft on the plain-conflict
    // path (no revert happened there, so it still holds the user's edit).
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
    // Put the user's edit back on screen when a revert had hidden it.
    if (reverted) setDraft(reverted);
    const fields: DraftFields = {};
    // While the room owns body/title (synced at least once, not denied) they
    // must NEVER ride this CAS patch: the box refuses ANY body/title patch for
    // a live room with 409 `open_in_editor`, the queue re-merges the pending
    // fields on every retry, and the whole patch — including the prop the user
    // chose to keep — wedges behind a misleading "locked by the editor" banner
    // forever. The room-owned fields need no re-assertion here anyway: the
    // title is bound to the CRDT (useCollabTitle) and `draft.body` under
    // collab is the STALE load-time value (BlockEditor suppresses onChange),
    // so a live-room CAS conflict is about props/visibility only.
    const session = collabRef.current;
    const roomOwns =
      session != null && session.state.status !== "denied" && session.state.everSynced;
    if (!roomOwns) {
      fields.title = d.title;
      fields.body = d.body ?? "";
    }
    const changed = diffKeys(theirs.props, d.props);
    if (changed.length > 0) {
      const props: Record<string, unknown> = {};
      for (const k of changed) props[k] = d.props[k] ?? null;
      fields.props = props;
    }
    revertedDraftRef.current = null;
    setConflict(null);
    if (Object.keys(fields).length > 0) q.change(fields);
    void q.flush();
  }, [conflict]);

  /** Take theirs: drop our buffered text, adopt the server's, re-read the page. */
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
    applyFields(setDraft, stored.fields);
    // While the room owns body/title, route those two into the CRDT — an
    // explicit diff, so co-editors keep their paragraphs — and send only the
    // rest (props/visibility) through CAS. Pushing them through the queue
    // instead would 409 `open_in_editor` and wedge every retry (the queue
    // re-merges pending fields), stranding the recovered draft AND the props.
    const session = collabRef.current;
    const roomOwns =
      session != null && session.state.status !== "denied" && session.state.everSynced;
    if (roomOwns) {
      const { title, body, ...rest } = stored.fields;
      const roomPatch: Partial<RoomContent> = {};
      if (title !== undefined) roomPatch.title = title ?? "";
      if (body !== undefined) roomPatch.body = body;
      if (roomPatch.title !== undefined || roomPatch.body !== undefined) {
        writeRoomContent(session.state.doc, roomPatch);
      }
      if (Object.keys(rest).length > 0) q.change(rest);
    } else {
      q.change(stored.fields);
    }
    setRecovery(null);
  }, [recovery]);

  const discardDraft = useCallback(() => {
    clearDraft(user.id, id);
    setRecovery(null);
  }, [user.id, id]);

  if (missing) {
    return (
      <div className="p-8">
        <Empty>
          This object doesn't exist — or your permissions don't extend to it. Nothing here is hidden
          from you by accident.
        </Empty>
      </div>
    );
  }
  if (loadError && !obj) {
    return (
      <div className="p-8">
        <Empty
          action={
            <Button variant="outline" size="sm" onClick={retryLoad}>
              Try again
            </Button>
          }
        >
          Couldn't load this object — a hiccup, most likely while the box reconnects. It's still
          here.
        </Empty>
      </div>
    );
  }
  if (!obj || !draft) return <Spinner />;

  const editable = canWrite && !obj.deleted_at;

  // ref-kind props already ride the links with provenance "ref:<prop>". A
  // SINGLE ref is now edited as a property, so it leaves the Links group; a
  // `ref[]` stays there, because it IS the edges.
  const refProps = new Set(
    obj.links.filter((l) => l.provenance.startsWith("ref:")).map((l) => l.provenance.slice(4)),
  );
  const singleRefKeys = new Set(defs.filter((d) => d.kind === "ref").map((d) => d.name));
  const refTitles: Record<string, { title: string | null; type: string | null }> = {};
  for (const l of obj.links) {
    if (!l.provenance.startsWith("ref:")) continue;
    const key = l.provenance.slice(4);
    if (singleRefKeys.has(key)) refTitles[key] = { title: l.target_title, type: l.target_type };
  }
  const manualLinks = obj.links.filter((l) => l.provenance === "manual");
  const refLinks = obj.links.filter(
    (l) => l.provenance.startsWith("ref:") && !singleRefKeys.has(l.provenance.slice(4)),
  );

  // The read-only rail keeps its old shape exactly: ref values render as chips
  // in the Links group, not as raw uuids beside the properties.
  const readOnlyValues = Object.fromEntries(
    Object.entries(draft.props).filter(
      ([k, v]) => !refProps.has(k) && !(Array.isArray(v) && refProps.size > 0),
    ),
  );

  const current: Snapshot = { title: obj.title, body: obj.body ?? "", props: { ...obj.props } };
  const recovered: Snapshot | null = recovery ? applySnapshot(current, recovery.fields) : null;

  // Mobile-first; `lg:` restores the two-column desk. On a phone the rail
  // cannot be a 420px column beside a document, so it stacks under it.
  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      {/* the document. The tall bottom padding on small screens is scroll room
          for the editor's docked formatting bar (BlockEditor): the bar is
          `position: fixed` above the keyboard, so without it the last
          paragraph of a body is a line you can see and never reach. */}
      <article className={`min-w-0 flex-1 ${isMobile ? "px-4 py-6 pb-32" : "px-8 py-8 pb-8"}`}>
        <div className="mx-auto max-w-[760px]">
          {obj.deleted_at && (
            <div className="mb-5 rounded-none border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive">
              Deleted {fmtDate(obj.deleted_at)} — kept forever as a tombstone; an owner can restore
              it from the MCP side.
            </div>
          )}

          {/* On rebase exhaustion the visible `draft` was rolled back to the
              server's values, but `keepMine` re-asserts the PRE-REVERT edit
              (revertedDraftRef). Show that same text as "mine" so the diff the
              banner draws is the decision the buttons actually act on — not a
              blank diff (mine==theirs) hiding what "keep mine" will restore. */}
          {conflict && (
            <ConflictBanner
              variant="conflict"
              actorName={conflict.current?.actor_name ?? null}
              when={conflict.current?.updated_at ?? null}
              fields={conflict.fields}
              theirs={
                conflict.current
                  ? {
                      title: conflict.current.title,
                      body: conflict.current.body,
                      props: conflict.current.props,
                    }
                  : null
              }
              mine={revertedDraftRef.current ?? draft}
              onKeepMine={keepMine}
              onTakeTheirs={takeTheirs}
            />
          )}
          {/* The COLLAB epoch-reset conflict: a reconnect under a changed epoch
              (the box self-updating) re-seeded the room and our offline edits no
              longer applied cleanly. Its own banner, wired to the room's own
              keep/take — without this the conflict is computed and then dropped,
              and the offline text vanishes with no way back. */}
          {collab?.state.conflict && (
            <ConflictBanner
              variant="conflict"
              actorName={null}
              when={null}
              fields={collabConflictFields(collab.state.conflict)}
              theirs={{
                title: collab.state.conflict.theirs.title,
                body: collab.state.conflict.theirs.body,
                props: {},
              }}
              mine={{
                title: collab.state.conflict.mine.title,
                body: collab.state.conflict.mine.body,
                props: {},
              }}
              onKeepMine={collab.keepMine}
              onTakeTheirs={collab.takeTheirs}
            />
          )}
          {locked && (
            <ConflictBanner
              variant="locked"
              reason={locked.reason}
              fields={locked.fields}
              onDismiss={() => setLocked(null)}
            />
          )}
          {recovery && recovered && (
            <ConflictBanner
              variant="recovery"
              when={new Date(recovery.savedAt).toISOString()}
              fields={fieldNames(recovery.fields)}
              theirs={current}
              mine={recovered}
              onKeepMine={restoreDraft}
              onTakeTheirs={discardDraft}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <TypePill type={obj.type} />
            <PrivateBadge
              visibility={obj.visibility}
              shared={(obj.audience ?? []).some((row) => !(row.length === 1 && row[0]!.governor))}
            />
            {obj.audience && <AudienceChips audience={obj.audience} />}
            <span className="ml-auto flex items-center gap-2.5 text-[12px] text-dim">
              {editable && (
                <SaveIndicator
                  save={save}
                  online={online}
                  conflicted={conflict !== null}
                  locked={locked !== null}
                  collab={collab ? collab.state.status : null}
                />
              )}
              <span>
                updated {fmtRelative(obj.updated_at)} · v{version || obj.version}
              </span>
            </span>
          </div>

          {editable ? (
            <input
              value={draft.title ?? ""}
              onChange={(e) => onTitle(e.target.value)}
              onBlur={flush}
              aria-label="Title"
              placeholder="untitled"
              spellCheck={false}
              className="mt-3 mb-3 w-full border-0 bg-transparent p-0 text-[28px] leading-tight font-[680] tracking-[-0.025em] text-ink outline-none placeholder:text-dim"
            />
          ) : (
            <h1 className="mt-3 mb-3 text-[28px] leading-tight font-[680] tracking-[-0.025em]">
              {draft.title ?? "untitled"}
            </h1>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2">
            {hist && (
              <Button
                size="sm"
                variant={provenanceMode ? "default" : "outline"}
                onClick={() => setProvenanceMode((v) => !v)}
              >
                {provenanceMode ? "Hide provenance" : "Show provenance"}
              </Button>
            )}
            {/* Visible to everyone on purpose — the server refuses non-creators
                with a message written to be shown, and hiding the button would
                make "ask the creator to share it" undiscoverable. */}
            {!obj.deleted_at && (
              <ShareSheet objectId={obj.id} audience={obj.audience} onShared={refetch} />
            )}
            {/* There was no delete affordance on this page at all — the soft
                delete and the whole /trash route existed, but nothing in the UI
                could reach them. Two-step on purpose: the first click only ARMS
                it. A single click between "Show provenance" and the editor,
                landing an object in the trash, is the sort of thing done by
                accident on a dense page. */}
            {editable && (
              <Button
                size="sm"
                variant={armTrash ? "default" : "outline"}
                disabled={trashing}
                onClick={() => {
                  if (!armTrash) {
                    setArmTrash(true);
                    return;
                  }
                  setTrashing(true);
                  api
                    .deleteObject(obj.id)
                    .then(() => {
                      setArmTrash(false);
                      // Drop the local draft BEFORE re-reading. The delete
                      // succeeds server-side either way, but the draft mirror
                      // holds a copy of this object and wins over the reload —
                      // so without this the page cheerfully kept rendering a
                      // live document that no longer existed, and the click
                      // looked like it had done nothing at all.
                      clearDraft(user.id, obj.id);
                      retryLoad(); // comes back as the tombstone this page renders
                    })
                    .catch((e: unknown) => {
                      // The route answers 404 for BOTH "no such object" and
                      // "yours to read, not yours to trash" — a private object
                      // you were merely shared on. That is deliberate (a 403
                      // would confirm the id exists), but "no live object with
                      // that id" reads as a bug to the person looking at the
                      // object on screen. Say the thing that is actually true
                      // for them.
                      const msg =
                        e instanceof ApiError && e.status === 404
                          ? "this one isn't yours to trash — only whoever created it can"
                          : errorMessage(e);
                      setTrashError(msg);
                    })
                    .finally(() => setTrashing(false));
                }}
              >
                <Trash2 size={13} aria-hidden />
                {trashing ? "Moving…" : armTrash ? "Confirm — move to trash" : "Move to trash"}
              </Button>
            )}
            {trashError !== null && (
              <span className="text-[12px] text-dim" role="status">
                Couldn't move it: {trashError}
              </span>
            )}
          </div>

          {provenanceMode && hist ? (
            <ProvenanceBody body={draft.body} hist={hist} />
          ) : editable ? (
            <BlockEditor
              // Re-keyed on the doc's IDENTITY: an epoch reset hands back a
              // NEW Y.Doc, and a TipTap editor bound to the old one would keep
              // typing into a document nobody is listening to. Keyed on
              // `roomOwnsBody`, NOT merely `collab != null`: while the room is
              // still connecting (pre-first-sync) the editor is a plain CAS
              // editor, so it holds a stable "cas" key and only re-keys into
              // collab mode when it actually binds the synced CRDT.
              key={roomOwnsBody ? `collab-${collab!.state.epoch ?? "none"}` : "cas"}
              value={draft.body ?? ""}
              onChange={onBody}
              onBlur={flush}
              onLink={onLink}
              ariaLabel="Body"
              placeholder="Write something, or press / for blocks"
              {...(roomOwnsBody ? { collab: collab!.binding } : {})}
            />
          ) : draft.body ? (
            <Markdown body={draft.body} />
          ) : (
            <p className="text-[14px] text-dim italic">This object has no body text.</p>
          )}

          {obj.hidden_from_you > 0 && (
            <p className="mt-8 rounded-none border border-line-soft bg-hover px-3.5 py-2.5 text-[12.5px] text-dim">
              {obj.hidden_from_you} linked object{obj.hidden_from_you === 1 ? " is" : "s are"}{" "}
              private and not visible to you.
            </p>
          )}
        </div>
      </article>

      {/* the rail: connections map, props, links, history.
          Width is BREAKPOINT-STEPPED so the document — the hero — is never the
          smaller half. The two-column split lives inside <main> (viewport minus
          the 248px sidebar), so at a 1024px viewport with the sidebar open the
          content pane is only ~776px; a fixed 420px rail would leave the reading
          column ~276px, NARROWER than the metadata beside it. So the rail is
          320px from `lg` and only widens to 420px at `xl` (≥1280), where the pane
          is wide enough for the document to dominate. */}
      {/* Stacked (below lg) the rail shares the ARTICLE's left edge — the same
          padX it carries — and only takes its own side-rail padding once it
          becomes a column at lg. Its old flat px-5 sat 4px off the article's
          px-4 on phones (the defect class Home's rail already fixed). */}
      <aside
        className={`w-full shrink-0 border-t border-line-soft py-7 lg:w-[320px] lg:border-t-0 lg:border-l lg:px-6 lg:py-8 xl:w-[420px] ${
          isMobile ? "px-4" : "px-8"
        }`}
      >
        <div className="flex flex-col gap-7">
          {!obj.deleted_at && <LocalGraph object={obj} />}

          {editable ? (
            <PropsPanel defs={defs} values={draft.props} refTitles={refTitles} onChange={onProp} />
          ) : (
            <PropsPanel
              defs={defs}
              values={readOnlyValues}
              readOnly
              renderValue={(key, value) =>
                hist ? (
                  <ProvenancePropValue propKey={key} value={value} events={hist.events} />
                ) : (
                  <PropValue value={value} />
                )
              }
            />
          )}

          <EdgeGroup label="Links" edges={[...refLinks, ...manualLinks]} />
          <EdgeGroup label="Linked from" edges={obj.backlinks} />

          {hist && hist.events.length > 0 && (
            <div>
              <div className="mb-2.5 flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-semibold tracking-wide text-dim uppercase">
                  History
                </span>
                <div className="flex items-baseline gap-2.5">
                  <span className="font-mono text-[11px] text-dim">
                    {hist.versions.length} version{hist.versions.length === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setHistOpen(true)}
                    className="cursor-pointer text-[11px] font-medium text-mut transition-colors hover:text-ink"
                  >
                    Full history →
                  </button>
                </div>
              </div>
              <ul className="flex flex-col gap-2.5">
                {coalesceHistory(hist.events)
                  .slice(0, 16)
                  .map((row) => (
                    <li key={row.key} className="flex gap-2.5 text-[12.5px] leading-snug">
                      <span
                        aria-hidden
                        className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: histTint(row.kind, theme) }}
                      />
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-ink">{row.actorName ?? "someone"}</span>{" "}
                        <span className="text-mut">{histVerb(row.kind)}</span>
                        {row.count > 1 && <span className="text-dim"> · {row.count} edits</span>}
                        <span className="mt-0.5 block text-[11px] text-dim">
                          {fmtDateTime(row.at)}
                        </span>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="border-t border-line-soft pt-4 text-[11px] leading-relaxed text-dim">
            <div className="flex justify-between">
              <span>created</span>
              <span>{fmtDate(obj.created_at)}</span>
            </div>
            {/* The raw UUID is a machine detail, not something to read — kept
                behind a copy control for the moments an operator needs it,
                never printed inline. */}
            <div className="mt-1 flex items-center justify-between gap-3">
              <span>id</span>
              <CopyIdButton id={obj.id} />
            </div>
          </div>
        </div>
      </aside>

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
    </div>
  );
}

/* --------------------------------------------------- audience + share sheet */

/** One audience row as readable text: "only you", "only Maya Chen",
 *  "everyone", or "you + pricing + us-person" — a row is an AND, the chips
 *  together are an OR. Labels come pre-resolved from the server; slugs stay in
 *  the tooltip for anyone debugging tags. */
export function audienceRowText(row: AudienceTag[]): string {
  const seg = (t: AudienceTag) => (t.you ? "you" : t.label);
  if (row.length === 1 && row[0]!.kind === "personal")
    return `only ${row[0]!.you ? "you" : seg(row[0]!)}`;
  return row.map(seg).join(" + ");
}

function AudienceChips({ audience }: { audience: AudienceTag[][] }) {
  if (audience.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" aria-label="Audience">
      {audience.map((row) => (
        <span
          key={row.map((t) => t.slug).join("+")}
          title={`visible to holders of: ${row.map((t) => t.slug).join(" + ")}`}
          className={`inline-flex items-center rounded-full border border-line-soft bg-hover px-2 py-0.5 text-[10.5px] text-mut ${
            row.every((t) => t.kind === "custom") ? "font-mono" : ""
          }`}
        >
          {audienceRowText(row)}
        </span>
      ))}
    </span>
  );
}

/** One toggleable chip in the share sheet — picked state carried on
 *  aria-pressed, so tests and screen readers read the same truth. */
function PickChip({
  picked,
  onToggle,
  children,
}: {
  picked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onToggle}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors ${
        picked
          ? "border-line bg-hover-strong text-ink"
          : "border-line-soft bg-hover text-mut hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The share sheet (task 14). WHO mixes group tags (org + custom, submitted as
 * slugs) and members (shown by name, SUBMITTED BY EMAIL — the server's person
 * vocabulary); REQUIRE is custom AND-tags only. The server enforces
 * creator-only + containment and its errors are shown verbatim — this sheet is
 * vocabulary, not the gate.
 */
function ShareSheet({
  objectId,
  audience,
  onShared,
}: {
  objectId: string;
  audience?: AudienceTag[][] | undefined;
  onShared: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<TagRow[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  /** tag slugs and member emails, exactly what the server accepts. */
  const [who, setWho] = useState<string[]>([]);
  const [require, setRequire] = useState<string[]>([]);
  /** wave 5: the member (by email) governance is handed to, or null. */
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** transient confirmation after a successful submit ("Shared ✓" / "Now
   *  private ✓") — the only feedback the closed sheet leaves behind besides
   *  the chips changing. */
  const [done, setDone] = useState<string | null>(null);

  // The audience rows this sheet EDITS — everything beyond the bare governor
  // row (that one is kept by the server no matter what).
  const currentRows = useMemo(
    () => (audience ?? []).filter((row) => !(row.length === 1 && row[0]!.governor === true)),
    [audience],
  );

  // Vocabulary loads on first open, not on page load — most visits never share.
  useEffect(() => {
    if (!open || tags !== null) return;
    api
      .tags()
      .then((r) => setTags(r.tags))
      .catch(() => setTags([]));
    api
      .members()
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [open, tags]);

  // PREFILL on every open: share REPLACES the audience, so the sheet must
  // start from the current state — submitting an empty sheet would quietly
  // unshare everyone. Rows are [who-entry, ...require] by construction, so
  // the head of each row is a WHO pick (people by email) and the tail of any
  // row is the shared require set.
  useEffect(() => {
    if (!open) return;
    const w: string[] = [];
    for (const row of currentRows) {
      const head = row[0];
      if (!head) continue;
      const key = head.kind === "personal" ? (head.email ?? head.slug) : head.slug;
      if (!w.includes(key)) w.push(key);
    }
    const req = [
      ...new Set(
        (currentRows[0] ?? [])
          .slice(1)
          .filter((t) => t.kind === "custom")
          .map((t) => t.slug),
      ),
    ];
    setWho(w);
    setRequire(req);
    setTransferTo(null);
    setReason("");
    setError(null);
  }, [open, currentRows]);

  const toggle = (list: string[], set: (v: string[]) => void, key: string) =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  const groupTags = (tags ?? []).filter((t) => t.kind === "custom" || t.kind === "org");
  const customTags = (tags ?? []).filter((t) => t.kind === "custom");
  const people = (members ?? []).filter((m) => m.status === "active" && m.email);
  // Governance can only be handed to a person — the server refuses service
  // accounts, so the picker never offers one.

  /** Picking a transferee auto-includes them in WHO (the server requires the
   *  new governor to be able to see the object); picking them again clears. */
  const pickTransfer = (email: string) => {
    if (transferTo === email) {
      setTransferTo(null);
      return;
    }
    setTransferTo(email);
    setWho((w) => (w.includes(email) ? w : [...w, email]));
  };

  const submitWith = (w: string[], r: string[], withTransfer: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api
      .shareObject(objectId, {
        who: w,
        require: r,
        ...(withTransfer && transferTo !== null ? { transfer_to: transferTo } : {}),
        ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
      })
      .then(() => {
        setOpen(false);
        setWho([]);
        setRequire([]);
        setTransferTo(null);
        setReason("");
        setDone(w.length === 0 ? "Now private ✓" : "Shared ✓");
        window.setTimeout(() => setDone(null), 2500);
        onShared();
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const submit = () => submitWith(who, require, true);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button size="sm" variant="outline">
              <Share2 size={13} aria-hidden />
              Share
            </Button>
          }
        />
        <PopoverContent align="start" className="w-[340px] p-3.5">
          {error && (
            <div className="rounded-none border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">
              {error}
            </div>
          )}
          <div>
            <div className="mb-1.5 text-[10.5px] font-semibold tracking-wide text-dim uppercase">
              Who can see it
            </div>
            {tags === null || members === null ? (
              <p className="text-[12px] text-dim">Loading…</p>
            ) : groupTags.length === 0 && people.length === 0 ? (
              <p className="text-[12px] text-dim">No tags or members to share with yet.</p>
            ) : (
              <div role="group" aria-label="Who" className="flex flex-wrap gap-1.5">
                {groupTags.map((t) => (
                  <PickChip
                    key={`tag-${t.slug}`}
                    picked={who.includes(t.slug)}
                    onToggle={() => toggle(who, setWho, t.slug)}
                  >
                    <span className="font-mono">{t.slug}</span>
                  </PickChip>
                ))}
                {people.map((m) => (
                  <PickChip
                    key={`member-${m.id}`}
                    picked={who.includes(m.email ?? "")}
                    onToggle={() => toggle(who, setWho, m.email ?? "")}
                  >
                    {m.name}
                  </PickChip>
                ))}
              </div>
            )}
          </div>
          {customTags.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-semibold tracking-wide text-dim uppercase">
                Only if they also hold
              </div>
              <div role="group" aria-label="Require" className="flex flex-wrap gap-1.5">
                {customTags.map((t) => (
                  <PickChip
                    key={`require-${t.slug}`}
                    picked={require.includes(t.slug)}
                    onToggle={() => toggle(require, setRequire, t.slug)}
                  >
                    <span className="font-mono">{t.slug}</span>
                  </PickChip>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-dim">
                Everyone shared with must also hold these tags.
              </p>
            </div>
          )}
          {people.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-semibold tracking-wide text-dim uppercase">
                Hand control to
              </div>
              <div
                role="group"
                aria-label="Transfer governance to"
                className="flex flex-wrap gap-1.5"
              >
                {people.map((m) => (
                  <PickChip
                    key={`transfer-${m.id}`}
                    picked={transferTo === (m.email ?? "")}
                    onToggle={() => pickTransfer(m.email ?? "")}
                  >
                    {m.name}
                  </PickChip>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-dim">
                The new governor controls sharing from then on — they're added to Who so they can
                see it.
              </p>
            </div>
          )}
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            aria-label="Reason"
            className="h-8 text-[12.5px]"
          />
          <div className="flex items-center justify-between gap-2">
            {/* The way BACK is as visible as the way out — otherwise "unshare"
              only exists as the unguessable trick of submitting an empty
              sheet. Rendered only when something IS shared. */}
            {currentRows.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => submitWith([], [], false)}
              >
                Make private again
              </Button>
            ) : (
              <span className="text-[11px] text-dim">Only you can see this now.</span>
            )}
            <Button size="sm" disabled={busy} onClick={submit}>
              {busy ? "Sharing…" : "Share"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {done !== null && (
        <span aria-live="polite" className="text-[11.5px] text-mut">
          {done}
        </span>
      )}
    </>
  );
}

/* ------------------------------------------------------------- save state */

/** saving / saved / conflict / offline, in that order of urgency. "Offline"
 *  outranks everything, because it explains every other state.
 *
 *  `collab` is the live room's socket status when a room is in play, and it is
 *  what makes the indicator honest under multiplayer: while a room owns
 *  body/title the CAS queue is SUSPENDED for them, so `save` alone would sit at
 *  idle and show nothing even as the user types. A down socket (the box
 *  self-updating) is also invisible to `online`, which only reflects the device
 *  network. So a live room reads as "synced", and a room that is connecting or
 *  buffering offline reads as "reconnecting — kept locally". `null` ⇒ no room,
 *  the single-player CAS behaviour is unchanged. */
export function saveLabel(
  save: SaveEvent,
  online: boolean,
  conflicted: boolean,
  locked: boolean,
  collab?: CollabStatus | null,
): { text: string; tone: "quiet" | "warn" | "danger" } | null {
  // Two tones above "quiet": `danger` (red) means something is WRONG and work
  // may be at risk — a conflict, a lock, a failed save. `warn` (amber) is the
  // calmer "heads up, but your work is safe" — the offline/reconnecting states
  // below all say "kept locally" and must NOT wear the alarm colour, or a
  // routine box self-update reads as data loss.
  if (!online) return { text: "offline — kept locally", tone: "warn" };
  if (conflicted) return { text: "conflict", tone: "danger" };
  if (locked) return { text: "locked by the editor", tone: "danger" };
  // The room owns body/title; its socket state outranks the CAS states below,
  // which now only describe props (and single-player body/title).
  if (collab === "offline" || collab === "connecting")
    return { text: "reconnecting — kept locally", tone: "warn" };
  // A DENIED room owns nothing: body/title are back on CAS, so the CAS save
  // state below is the honest signal — NOT a bare "disconnected" that hides
  // whether the work is saving. (Fall through.)
  switch (save.kind) {
    case "saving":
    case "rebasing":
      return { text: "saving…", tone: "quiet" };
    case "dirty":
      return { text: "unsaved", tone: "quiet" };
    case "saved":
      return { text: "saved", tone: "quiet" };
    case "error":
      return { text: "not saved — kept locally", tone: "danger" };
    default:
      // A live room persists body/title over the socket even when the CAS queue
      // is idle — say so rather than showing nothing.
      return collab === "live" ? { text: "synced", tone: "quiet" } : null;
  }
}

/** Save-indicator tone → text colour. `danger` is the alarm red (something is
 *  wrong); `warn` is amber (heads up, work is safe); `quiet` is dim. Shared by
 *  the ObjectView indicator and the SidePeek status span so the two never drift. */
export function saveToneClass(tone: "quiet" | "warn" | "danger"): string {
  if (tone === "danger") return "text-destructive";
  if (tone === "warn") return "text-warn";
  return "text-dim";
}

function SaveIndicator({
  save,
  online,
  conflicted,
  locked,
  collab,
}: {
  save: SaveEvent;
  online: boolean;
  conflicted: boolean;
  locked: boolean;
  collab?: CollabStatus | null;
}) {
  const state = saveLabel(save, online, conflicted, locked, collab);
  if (!state) return null;
  return (
    <span role="status" aria-live="polite" className={saveToneClass(state.tone)}>
      {state.text}
    </span>
  );
}

/* ----------------------------------------------------------------- drafts */

/** Apply a field-granular draft onto a snapshot. `null` inside props deletes. */
export function applySnapshot(base: Snapshot, fields: DraftFields): Snapshot {
  const out: Snapshot = { ...base, props: { ...base.props } };
  if ("title" in fields) out.title = fields.title ?? null;
  if ("body" in fields) out.body = fields.body ?? "";
  for (const [k, v] of Object.entries(fields.props ?? {})) {
    if (v === null) delete out.props[k];
    else out.props[k] = v;
  }
  return out;
}

function applyFields(
  set: React.Dispatch<React.SetStateAction<Snapshot | null>>,
  fields: DraftFields,
): void {
  set((d) => (d ? applySnapshot(d, fields) : d));
}

/** Which room fields differ between our offline text and the re-seeded server's
 *  — the collab conflict banner's "what changed" hint. */
export function collabConflictFields(conflict: CollabConflict): string[] {
  const out: string[] = [];
  if (conflict.mine.title !== conflict.theirs.title) out.push("title");
  if (conflict.mine.body !== conflict.theirs.body) out.push("body");
  return out;
}

/**
 * On a room DENIAL, may the doc's content be carried into the CAS draft + queue?
 *
 * Yes when the doc can actually stand for the object's stored content — the room
 * synced at least once (so it held the server's body), OR there is genuine text
 * to rescue (offline edits typed into the CRDT before it was denied). NO when the
 * room was denied before ever syncing AND the doc is empty: that doc never held
 * the object's body, and carrying its `{title:"", body:""}` into CAS would PATCH
 * an empty body over the real note and destroy it (see the effect that calls
 * this). The loaded draft — which does hold the real body — is left untouched.
 */
export function carryDeniedRoomContent(everSynced: boolean, content: RoomContent): boolean {
  const hasContent = content.title !== "" || content.body !== "";
  return everSynced || hasContent;
}

/** Field paths a stored draft carries, for the banner's "what changed" line. */
export function fieldNames(fields: DraftFields): string[] {
  const out: string[] = [];
  if ("title" in fields) out.push("title");
  if ("body" in fields) out.push("body");
  for (const k of Object.keys(fields.props ?? {})) out.push(`props.${k}`);
  return out;
}

/** Keys whose values differ between two prop maps (absent === null). */
export function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const x = a[k] ?? null;
    const y = b[k] ?? null;
    if (x === y) continue;
    if (
      x !== null &&
      y !== null &&
      typeof x === "object" &&
      typeof y === "object" &&
      JSON.stringify(x) === JSON.stringify(y)
    )
      continue;
    out.push(k);
  }
  return out;
}

function PropValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "")
    return <span className="text-dim">—</span>;
  if (Array.isArray(value)) return <span className="text-dim">{value.length} linked</span>;
  const s = String(value);
  // enum-ish short lowercase strings get the pill treatment
  if (/^[a-z][a-z0-9_-]{1,18}$/.test(s)) return <EnumPill value={s} />;
  if (/^\d+$/.test(s)) return <span className="font-mono text-[12.5px]">{fmtNumber(s)}</span>;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return <span>{fmtDate(s)}</span>;
  return <span className="break-words">{s}</span>;
}

/**
 * The body, rendered as real markdown, with each contiguous same-origin span
 * (a "run" — everything one edit touched together, not one span per word)
 * hoverable to show who wrote it, when, and why.
 */
function ProvenanceBody({ body, hist }: { body: string | null; hist: History }) {
  const runs = useMemo(() => attributionRuns(body, hist.versions, hist.events), [body, hist]);
  const rehypePlugins = useMemo(() => [() => rehypeAttributionSpans(runs)], [runs]);
  const components = useMemo<Components>(
    () => ({ span: (p) => <RunSpan {...p} runs={runs} /> }),
    [runs],
  );
  if (!body) return <p className="text-[14px] text-dim italic">This object has no body text.</p>;
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
        skipHtml
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

/** One attribution run's rendered span — injected only where rehypeAttributionSpans found an attributed run. */
function RunSpan({
  id,
  children,
  runs,
}: {
  id?: string | undefined;
  children?: React.ReactNode | undefined;
  runs: readonly AttributionRun[];
}) {
  const idx = id?.startsWith("run-") ? Number(id.slice(4)) : NaN;
  const run = Number.isNaN(idx) ? undefined : runs[idx];
  if (!run) return <span>{children}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-help rounded-sm decoration-dotted underline-offset-4 hover:bg-hover hover:underline" />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        <AttributionText attribution={run.attribution} />
      </TooltipContent>
    </Tooltip>
  );
}

/** A property value, hoverable to show who set it, when, and why. */
function ProvenancePropValue({
  propKey,
  value,
  events,
}: {
  propKey: string;
  value: unknown;
  events: History["events"];
}) {
  const attribution = useMemo(() => attributeProp(propKey, events), [propKey, events]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-help decoration-dotted underline-offset-4 hover:underline" />
        }
      >
        <PropValue value={value} />
      </TooltipTrigger>
      <TooltipContent>
        <AttributionText attribution={attribution} />
      </TooltipContent>
    </Tooltip>
  );
}

function AttributionText({ attribution }: { attribution: Attribution | null }) {
  if (!attribution) return <span>no history recorded</span>;
  return (
    <span>
      {attribution.actorName ?? attribution.actor ?? "someone"} · {fmtRelative(attribution.at)}
      {attribution.reason ? ` — ${attribution.reason}` : " — no reason given"}
    </span>
  );
}

/** Copies the object's id to the clipboard on click, with a brief confirmation.
 *  The UUID itself is never shown — it is a machine handle, not page content. */
function CopyIdButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(id);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="inline-flex items-center gap-1 font-mono text-dim transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)] focus-visible:outline-offset-2"
      aria-label={copied ? "Object id copied" : "Copy object id"}
    >
      {copied ? (
        <>
          <Check size={11} aria-hidden /> Copied
        </>
      ) : (
        <>
          <Copy size={11} aria-hidden /> Copy ID
        </>
      )}
    </button>
  );
}

interface HistRow {
  key: string;
  actorName: string | null;
  kind: string;
  /** newest timestamp in the run (events arrive newest-first) */
  at: string;
  /** how many raw events collapsed into this row */
  count: number;
}

/** Collapse a burst of same-author, same-kind edits within the same minute into
 *  one entry ("Sam Rivera edited it · 20 edits") — the rail otherwise repeats a
 *  byte-identical row per save, which buries the one event that matters (the
 *  create) under log spew. */
function coalesceHistory(events: History["events"]): HistRow[] {
  const minute = (iso: string): number => Math.floor(new Date(iso).getTime() / 60000);
  const rows: HistRow[] = [];
  for (const e of events) {
    const actorName = e.actor_name ?? e.actor ?? null;
    const last = rows[rows.length - 1];
    if (
      last &&
      last.kind === e.kind &&
      last.actorName === actorName &&
      minute(last.at) === minute(e.at)
    ) {
      last.count += 1;
      continue;
    }
    rows.push({ key: e.seq, actorName, kind: e.kind, at: e.at, count: 1 });
  }
  return rows;
}

function histVerb(kind: string): string {
  switch (kind) {
    case "create":
      return "created this";
    case "edit":
      return "edited it";
    case "delete":
      return "deleted it";
    case "restore":
      return "restored it";
    case "link":
      return "added a link";
    case "unlink":
      return "removed a link";
    default:
      return kind;
  }
}

/** History-dot hue per skin. The paper skin gets the muted 600/700-band register
 *  (lib/ui.ts LIGHT_TYPE_HUES / PresenceRail PRESENCE_INK.light) so these dots
 *  read as coloured ink on white, not the saturated aurora hues tuned for
 *  near-black; the dark skin keeps the aurora hues. */
function histTint(kind: string, theme: Theme = "dark"): string {
  const light = theme === "light";
  switch (kind) {
    case "create":
      return light ? "#047857" : "#34d399";
    case "edit":
      return light ? "#1d4ed8" : "#4aa8ff";
    case "delete":
      return light ? "#be123c" : "#fb7185";
    case "restore":
      return light ? "#b45309" : "#fbbf24";
    case "link":
    case "unlink":
      return light ? "#6d28d9" : "#a78bfa";
    default:
      return light ? "#52525b" : "#9aa0aa";
  }
}
