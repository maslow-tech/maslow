/**
 * `useCollabRoom` — the ONE way a view joins a live document room.
 *
 * `lib/collab.ts` owns the session machine (ticket, socket, epoch resets,
 * conflict, backoff). This is the React binding, and it exists because the
 * session machine had NO CALLER: `connectRoom` was reachable only from its own
 * unit test, so every editor on the box was a single-player editor and two
 * browsers on the same object silently diverged.
 *
 * Three rules, all of them about not breaking the single-player path:
 *
 *  1. **Collab is opt-in per mount and never a precondition for editing.**
 *     `enabled: false` (a viewer, the demo build, a trashed object, a body the
 *     user cannot write) returns `null`, and the host renders exactly what it
 *     rendered before this file existed — a CAS-backed markdown editor.
 *  2. **A refused or dead room does not disable the editor.** The session's
 *     `doc` is the offline buffer; the host keeps binding to it and the text
 *     stays typeable. Only `provider` (remote carets) is nulled while down.
 *  3. **The save queue is the session's to suspend, not the host's.** The queue
 *     is handed in and `connectRoom` suspends body/title on it for as long as
 *     the room owns them. A host that also fed those fields into the queue
 *     would land every edit twice.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  COLLAB_TITLE_FIELD,
  connectRoom,
  writeRoomContent,
  type CollabPersistence,
  type CollabSaveQueue,
  type CollabState,
  type CollabSession,
} from "./collab";

/** The caret colours the two skins define, mirroring `PresenceRail.PRESENCE_INK`. */
const CARET_COLORS = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#4f46e5",
] as const;

/**
 * OUR caret's colour, only. Peers' colours are stamped by the server and
 * arrive over the wire — this is the label we publish about ourselves, which
 * is precisely the claim the server refuses to take from us for anyone else.
 */
function caretColor(actorId: string): string {
  let hash = 0;
  for (let i = 0; i < actorId.length; i += 1) hash = (hash * 31 + actorId.charCodeAt(i)) >>> 0;
  return CARET_COLORS[hash % CARET_COLORS.length] as string;
}

interface UseCollabRoomOptions {
  /** the object whose room to join. Empty ⇒ no room. */
  objectId: string;
  /** false ⇒ no socket at all, and the host stays on the CAS path. */
  enabled: boolean;
  /** the object's CAS save queue; the session suspends body/title on it. */
  saveQueue: CollabSaveQueue | null;
  /** our own caret label. The server stamps what peers actually render. */
  user: { id: string; name: string };
  /** the offline-buffer crash net (lib/draftMirror collab buffer). Omitted ⇒
   *  no persistence, so offline body/title survive only in memory. */
  persistence?: CollabPersistence | null;
}

export interface UseCollabRoom {
  readonly state: CollabState;
  /** what `BlockEditor`'s `collab` prop wants. */
  readonly binding: {
    doc: CollabState["doc"];
    provider: CollabState["provider"];
    user: { name: string; color: string };
  };
  keepMine(): void;
  takeTheirs(): void;
  reconnectNow(): void;
  /** Flush the offline buffer NOW — the host wires this to `pagehide`, the one
   *  teardown path React effect cleanup does NOT cover. */
  flushPersist(): void;
}

export function useCollabRoom(opts: UseCollabRoomOptions): UseCollabRoom | null {
  const { objectId, enabled } = opts;
  const [state, setState] = useState<CollabState | null>(null);
  const sessionRef = useRef<CollabSession | null>(null);

  // Read through refs, never listed as dependencies: a fresh object literal on
  // every render would tear the socket down and re-mint a ticket every render.
  const queueRef = useRef(opts.saveQueue);
  queueRef.current = opts.saveQueue;
  const userRef = useRef(opts.user);
  userRef.current = opts.user;
  // Read through a ref: a fresh persistence object literal every render must not
  // re-mint the socket. Its identity is irrelevant — only its methods are used.
  const persistenceRef = useRef(opts.persistence);
  persistenceRef.current = opts.persistence;

  useEffect(() => {
    setState(null);
    sessionRef.current = null;
    if (!enabled || !objectId) return;

    let live = true;
    const session = connectRoom({
      objectId,
      saveQueue: queueRef.current,
      persistence: persistenceRef.current ?? null,
      onState: (next) => {
        if (live) setState(next);
      },
    });
    sessionRef.current = session;
    setState(session.state());

    return () => {
      live = false;
      sessionRef.current = null;
      session.destroy();
    };
  }, [objectId, enabled]);

  if (!state) return null;
  const user = userRef.current;
  return {
    state,
    binding: {
      doc: state.doc,
      provider: state.provider,
      user: { name: user.name || "Member", color: caretColor(user.id) },
    },
    keepMine: () => sessionRef.current?.keepMine(),
    takeTheirs: () => sessionRef.current?.takeTheirs(),
    reconnectNow: () => sessionRef.current?.reconnectNow(),
    flushPersist: () => sessionRef.current?.flushPersist(),
  };
}

/**
 * Bind the TITLE to the room's CRDT, exactly as `BlockEditor` binds the body.
 *
 * `COLLAB_OWNED_FIELDS` names `title` alongside `body`: once a room exists the
 * box refuses a CAS `{title}` patch with 409 `open_in_editor`, so the title MUST
 * travel over the socket, not the save queue. Unlike the body it has no TipTap
 * binding (it is a plain `<input>`), so without this the title becomes read-only
 * the instant the socket connects — every keystroke 409s and shows "locked by
 * the editor", and the edit is lost. This closes that gap:
 *
 *  - the returned writer splices the value into `doc.getText("title")` ONLY once
 *    the room has synced at least once (`everSynced`) — exactly the gate the body
 *    uses via `roomOwnsBody`. After the first sync a live room syncs to peers +
 *    the server flush, and an offline room's Y.Doc is the buffer that `reconcile`
 *    re-applies on the next sync; the writer returns `true` so the host skips CAS.
 *  - the effect reflects the CRDT title back into the host's draft so a peer's
 *    (or an agent's) title edit appears live — but ONLY once the room is `live`.
 *    Before the first sync the doc is an empty buffer whose title is "", and
 *    seeding from it would wipe the loaded title.
 *
 * BEFORE the first sync the writer returns `false` and the title stays on CAS —
 * the same rule the body follows (`ObjectView.roomOwnsBody`, gated on
 * `everSynced`). The pre-sync Y.Doc is an EMPTY buffer, never the object's stored
 * content: routing the title into it would leave `readRoomContent(buffer)` at
 * `{ title: <typed>, body: "" }`, and on first sync `reconcile` would see
 * base=EMPTY / mine=<typed> / server=<real> and raise a SPURIOUS conflict whose
 * "keep mine" wipes the real body. Keeping the title on CAS until the room owns it
 * closes that hole (commit 31c1e02 established the same guard for the body).
 *
 * When no room is in play the writer returns `false` and the host keeps its
 * single-player CAS behaviour unchanged.
 */
export function useCollabTitle(
  collab: UseCollabRoom | null,
  reflect: (title: string) => void,
): (value: string) => boolean {
  const docRef = useRef<CollabState["doc"] | null>(null);
  // The room owns the title only once it has SYNCED (`everSynced`) and is not
  // DENIED. Before the first sync the Y.Doc is an empty buffer — writing the
  // title into it makes reconcile see base=EMPTY / server=<real> and raise a
  // spurious conflict (the body avoids this with the same `everSynced` gate).
  // A DENIED room owns nothing either — `deny()` hands body/title back to CAS
  // (resumeFields). In both cases treat it as "no room" and fall to CAS.
  docRef.current =
    collab && collab.state.status !== "denied" && collab.state.everSynced ? collab.state.doc : null;

  const reflectRef = useRef(reflect);
  reflectRef.current = reflect;

  const live = collab?.state.status === "live";
  const doc = collab?.state.doc ?? null;

  useEffect(() => {
    if (!live || !doc) return;
    const title = doc.getText(COLLAB_TITLE_FIELD);
    const sync = (): void => reflectRef.current(title.toString());
    // Seed from the just-synced doc (server title, or our offline text that
    // reconcile re-applied), then track every later change.
    sync();
    title.observe(sync);
    return () => title.unobserve(sync);
  }, [live, doc]);

  return useCallback((value: string): boolean => {
    const d = docRef.current;
    if (!d) return false;
    writeRoomContent(d, { title: value });
    return true;
  }, []);
}
