import type { Awareness } from "y-protocols/awareness";

import { presenceIdentity, type PresenceIdentity } from "./presence.js";

/**
 * SERVER-STAMPED IN-EDITOR CARET IDENTITY.
 *
 * `presence.ts` stamps identity for the presence RAIL, on a custom stateless
 * channel the server fully controls. The in-editor carets are a SECOND identity
 * channel and a separate transport: stock y-protocols Yjs awareness, driven by
 * `@tiptap/extension-collaboration-caret` and relayed by hocuspocus VERBATIM to
 * every peer in a doc room. Nothing else in this codebase touches that awareness
 * `user` field, so without this a member could open the console and run
 *
 *   provider.awareness.setLocalStateField("user",
 *     { kind:"agent", actorId:"…", name:"Claude", color:"presence-agent", glyph:"robot" })
 *
 * and every other editor in the room would draw a robot "Claude" caret at their
 * cursor (`readPeerIdentity` accepts a fully-forged agent), or impersonate a named
 * colleague. The rail's whole "IDENTITY IS STAMPED BY THE SERVER, NEVER AUTHORED
 * BY THE CLIENT" invariant (presence.ts) does not hold for the editor caret until
 * the server stamps this channel too — which is what this module does.
 *
 * A SOCKET CONNECTION IS ALWAYS A HUMAN. Agents have no socket; they reach the
 * editor through the agent-write bridge + presence relay, never stock awareness.
 * So every awareness `user` a connection publishes is overwritten with that
 * connection's authenticated principal as a `kind:"human"` stamp — the exact
 * shape `apps/box/ui/src/lib/collab.ts readPeerIdentity` accepts (kind, actorId,
 * name, a `presence-N` colour TOKEN, glyph). That kills agent-impersonation and
 * human-impersonation in one move, and — a bonus — makes honest carets render
 * NAMED, since the honest client publishes a raw hex colour that `readPeerIdentity`
 * rejects (so today's honest carets are anonymous).
 */

/** What the server knows about the principal behind a doc-room connection. */
export interface CaretPrincipal {
  readonly actorId: string;
  /** the account's display name, read server-side. `undefined` ⇒ a generic label. */
  readonly name?: string | undefined;
}

/**
 * Overwrite ONE stored awareness state's identity `user` with the server stamp.
 *
 * - a resolvable principal ⇒ the state's `user` becomes the server-derived human
 *   identity, no matter what the client authored;
 * - no principal (a client-origin update we cannot attribute) ⇒ the client's
 *   `user` claim is STRIPPED, so the caret renders anonymous rather than as a
 *   named/robot peer. Fail closed: an unattributable caret is nameless, never a
 *   plausible stranger.
 *
 * `position`/`cursor` and every other awareness key the client set are left
 * untouched — a caret's POSITION is the one thing a client legitimately authors.
 */
export function stampCaretState(
  state: Record<string, unknown> | null | undefined,
  principal: CaretPrincipal | null,
): void {
  if (!state || typeof state !== "object") return;
  if (!principal) {
    delete (state as { user?: unknown }).user;
    return;
  }
  const identity: PresenceIdentity = presenceIdentity({
    kind: "human",
    actorId: principal.actorId,
    name: principal.name,
  });
  (state as { user?: unknown }).user = identity;
}

/**
 * Resolve the principal behind an awareness update's `origin`, or classify it as
 * server-local.
 *
 * y-protocols passes the ORIGIN of the awareness change to every `update`
 * listener. For a client message hocuspocus passes the connection's
 * `webSocket` (an object); for its own local sets it passes the string
 * `"local"`, and TTL/disconnect removals pass `null`. So an object origin is a
 * client connection whose `user` must be stamped-or-stripped; a non-object
 * origin is a server-side change carrying no forgeable identity.
 */
type CaretResolver = (origin: unknown) => CaretPrincipal | null;

/**
 * Install the stamp on a doc room's stock Yjs awareness so the caret's identity
 * is the connection's authenticated principal, never the client's `user` blob.
 *
 * ORDERING IS THE WHOLE TRICK. hocuspocus registers its own awareness `update`
 * listener in the `Document` constructor — the one that re-encodes and
 * BROADCASTS the changed states to every peer. If our stamp ran after it, the
 * forged state would already be on the wire. y-protocols has no "prepend", so we
 * lift the existing `update` observers off, install ours FIRST, then put them
 * back: our stamp mutates `awareness.states.get(clientId).user` in place, and the
 * broadcaster (running next, reading the same `states` map) sends the stamped
 * value. Call this once, in `afterLoadDocument`, after the constructor's listener
 * exists and before hocuspocus adds its `onAwarenessUpdate`-hook listener.
 */
export function installCaretIdentityStamp(awareness: Awareness, resolve: CaretResolver): void {
  /**
   * clientId → the connection that first published it. The awareness protocol
   * applies any (clientId, clock, state) entry whose clock is newer — the
   * sender is never required to BE that clientId — so re-stamping alone still
   * lets one client OVERWRITE another's stored entry (move/erase the victim's
   * caret) and poison its clock with a far-future value. An entry for a
   * clientId some OTHER connection already owns is therefore REFUSED, not
   * re-stamped: the forged state is deleted from `states` before the
   * broadcaster (running next, reading the same map) encodes it, so what fans
   * out is at worst a removal — never the attacker's position under the
   * victim's id — and the poisoned clock meta is dropped after the broadcast
   * so the victim's own next update is accepted rather than rejected as old.
   * Ownership is released when the owner's entry is removed (its own removal,
   * or a server-side TTL/disconnect sweep), so a reconnecting client with a
   * fresh connection can claim a fresh clientId — its Y.Doc mints a new one
   * per session, so a stale claim never locks anyone out.
   */
  const owners = new Map<number, unknown>();

  const stamp = (
    payload: { added?: number[]; updated?: number[]; removed?: number[] } | undefined,
    origin: unknown,
  ): void => {
    // A non-object origin is a server-side change (local set, TTL/disconnect
    // removal): nothing a client could forge, so leave the states alone — but
    // release ownership for what it removed, or a dead connection's claim
    // would shadow that clientId forever.
    if (origin === null || typeof origin !== "object") {
      for (const clientId of payload?.removed ?? []) owners.delete(clientId);
      return;
    }
    let principal: CaretPrincipal | null = null;
    try {
      principal = resolve(origin);
    } catch {
      principal = null; // an unresolvable origin fails closed to "strip identity"
    }
    const changed = [...(payload?.added ?? []), ...(payload?.updated ?? [])];
    for (const clientId of changed) {
      try {
        const owner = owners.get(clientId);
        if (owner === undefined) {
          owners.set(clientId, origin);
        } else if (owner !== origin) {
          // A foreign entry: refuse it (see the map comment above).
          awareness.states.delete(clientId);
          const meta = (awareness as unknown as { meta?: Map<number, unknown> }).meta;
          if (meta) {
            // After the synchronous observer chain (the broadcaster included),
            // so the removal still goes out under the bumped clock and lands
            // on every peer — then the poisoned clock is forgotten.
            queueMicrotask(() => {
              try {
                meta.delete(clientId);
              } catch {
                /* already gone */
              }
            });
          }
          continue;
        }
        stampCaretState(awareness.states.get(clientId), principal);
      } catch {
        /* one bad state must never break the relay */
      }
    }
    // A client's own removal releases its claim (a reconnect gets a fresh id).
    for (const clientId of payload?.removed ?? []) {
      if (owners.get(clientId) === origin) owners.delete(clientId);
    }
  };

  // Lift hocuspocus's broadcaster off, put our stamp in front of it, restore it.
  const observable = awareness as unknown as {
    _observers?: Map<string, Set<(...args: unknown[]) => void>>;
  };
  const existing = observable._observers?.get("update");
  const restore = existing ? [...existing] : [];
  for (const fn of restore) awareness.off("update", fn as never);
  awareness.on("update", stamp as never);
  for (const fn of restore) awareness.on("update", fn as never);
}
