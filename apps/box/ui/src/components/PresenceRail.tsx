/**
 * THE PRESENCE RAIL — "3 people viewing Deals", and nothing more than that.
 *
 * It draws exactly what the relay sent for THIS viewer
 * (`lib/routePresence.ts`, mirroring `apps/box/src/collab/presence.ts`) and
 * derives nothing of its own:
 *
 *  - **name / colour / glyph are server-stamped.** A peer cannot author its own
 *    identity, so the rail never falls back to a client-supplied name and never
 *    invents an avatar for a state it could not parse.
 *  - **"which object" is present only when the server resolved it against THIS
 *    viewer's own RLS read.** No `objectId` ⇒ the avatar is not a link, full
 *    stop — not a disabled link, not a "you can't see this" tooltip, both of
 *    which would confirm that something is there. A person stays in the rail;
 *    whatever they have open does not travel with them.
 *  - **counts come from the intersected view.** The rail reads `counts`, which
 *    the relay computed after filtering; it never counts a local object list.
 *  - **socket down ⇒ nothing.** `peers` is empty whenever the session is not
 *    live, and an empty rail renders `null`: no spinner, no skeleton, no stale
 *    roster. A rail is a claim about who is here right now, and a disconnected
 *    tab has no such claim to make.
 *
 * Colour is a THEME TOKEN on the wire (`presence-3`, `presence-agent`); the ink
 * is chosen here, per skin, exactly as `typeHue` does for type dots — the
 * server has no business picking a colour for two skins it cannot see.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AGENT PARITY (phase 5)
 *
 * A robot is drawn by the SAME code path as a person — same avatar box, same
 * tooltip, same "is this clickable" rule — because it arrives over the same wire
 * as a person: `apps/box/src/collab/presence.ts` stamps `kind: "agent"`, the
 * reserved `presence-agent` slot and the `robot` glyph, and runs the entry
 * through the one per-recipient filter every human goes through. Nothing here
 * asks "is this the agent?" in order to decide what a viewer may KNOW; it asks
 * only in order to decide what to DRAW:
 *
 *  - the lucide `Bot` mark instead of initials, plus a dashed border, so the
 *    machine reads as a machine without relying on colour alone;
 *  - agent phrasing in the hover card ("Claude is editing 3 objects in Deals"),
 *    where the figure is the relay's own per-recipient count — so two people on
 *    the same screen can legitimately see different numbers, and that is
 *    correct rather than a bug to reconcile.
 *
 * The privacy rule is identical for both kinds and is enforced upstream: an
 * agent whose object this viewer cannot see never arrives at all (the relay
 * drops it — an agent's presence IS the write), and an avatar with no
 * `objectId` is simply not clickable. The rail never says why.
 */
import { useMemo } from "react";
import { Bot } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "../lib/theme";
import { usePeek } from "../lib/peek";
import {
  useRoutePresence,
  type RoutePeer,
  type RoutePresenceCounts,
  type RoutePresenceState,
} from "../lib/routePresence";

/* ------------------------------------------------------------------ palette */

/** Slot → ink, per skin. Index 0 is the agent's reserved slot. */
const PRESENCE_INK = {
  light: [
    "#52525b", // agent — graphite: the machine reads as machine, not as a person
    "#2563eb",
    "#059669",
    "#d97706",
    "#db2777",
    "#7c3aed",
    "#0891b2",
    "#e11d48",
    "#4d7c0f",
  ],
  dark: [
    "#8b8b98",
    "#4aa8ff",
    "#34d399",
    "#fbbf24",
    "#f472b6",
    "#a78bfa",
    "#22d3ee",
    "#fb7185",
    "#a3e635",
  ],
} as const;

/** `presence-agent` | `presence-1..8` → an ink for this skin. Unknown ⇒ muted. */
export function presenceInk(color: string, theme: "light" | "dark"): string {
  const pool = PRESENCE_INK[theme];
  if (color === "presence-agent") return pool[0];
  const slot = /^presence-([1-9][0-9]*)$/.exec(color);
  if (!slot) return theme === "light" ? "#52525b" : "#8b8b98";
  const index = Number(slot[1]);
  return pool[index] ?? pool[0];
}

/* -------------------------------------------------------------------- copy */

/** "3 people viewing Deals" / "Claude is here". Plural rules, nothing clever. */
export function presenceSummary(counts: RoutePresenceCounts, label?: string | null): string {
  const where = label && label.trim() ? ` viewing ${label.trim()}` : " here";
  const parts: string[] = [];
  if (counts.people > 0) {
    parts.push(`${counts.people} ${counts.people === 1 ? "person" : "people"}`);
  }
  if (counts.agents > 0) {
    parts.push(`${counts.agents} ${counts.agents === 1 ? "agent" : "agents"}`);
  }
  if (parts.length === 0) return "";
  return `${parts.join(" and ")}${where}`;
}

/**
 * What the hover card says about one peer. Never a title, never an id — a route
 * room carries no object identity, and the count is the server's own
 * per-recipient figure.
 *
 * Two shapes, one rule. A person reads "Dana — editing 3 objects in Deals"; the
 * agent gets a sentence of its own ("Claude is editing 3 objects in Deals")
 * because a robot is a thing that acts, not a thing that is sitting there. Both
 * numbers are `counts.objectsByActor`, i.e. what the relay resolved for THIS
 * viewer — the rail has no object list of its own to count and must not acquire
 * one.
 *
 * With no `objectId` the caption is the name and nothing else: no "hidden", no
 * "1 object", no ellipsis. There is nothing to say, and anything said here would
 * be a hint that something is there.
 */
export function peerCaption(
  peer: RoutePeer,
  counts: RoutePresenceCounts | null,
  isSelf: boolean,
  label?: string | null,
): string {
  const who = isSelf ? `${peer.name} (you)` : peer.name;
  const where = label && label.trim() ? ` in ${label.trim()}` : " here";
  const objects = counts?.objectsByActor[peer.actorId] ?? 0;
  if (!peer.objectId) return who;
  if (peer.kind === "agent") {
    return objects > 1
      ? `${who} is editing ${objects} objects${where}`
      : `${who} is editing one object${where}`;
  }
  return objects > 1
    ? `${who} — editing ${objects} objects${where}`
    : `${who} — open in the editor`;
}

/**
 * One avatar per ACTOR, not per connection.
 *
 * The wire carries one state per CLIENT, and a client is a socket: Dana with
 * three tabs open is three states, and a robot part-way through a table is one
 * cursor per row it is still holding (`AGENT_MAX_ROUTE_CLIENTS` of them). Drawn
 * verbatim that is three identical Danas and a queue of identical robots, which
 * says something false — "how many browsers" is not a fact anybody wants.
 *
 * The kept entry is the first one the relay sent for that actor, upgraded to a
 * RESOLVABLE one if a later state has an object this viewer may open: an avatar
 * that can be clicked is strictly more useful, and it leaks nothing, because
 * every `objectId` present here already survived the server's own read. The
 * COUNT is untouched — `counts.objectsByActor` still says three objects, which
 * is why the hover card can read "Claude is editing 3 objects in Deals" beside
 * a single robot avatar.
 */
export function dedupePeers(peers: readonly RoutePeer[]): RoutePeer[] {
  const byActor = new Map<string, RoutePeer>();
  for (const peer of peers) {
    const prev = byActor.get(peer.actorId);
    if (!prev) {
      byActor.set(peer.actorId, peer);
      continue;
    }
    if (!prev.objectId && peer.objectId) byActor.set(peer.actorId, peer);
  }
  return [...byActor.values()];
}

/* -------------------------------------------------------------------- rail */

interface PresenceRailProps {
  /** exactly the states the relay sent this viewer, in the order it sent them */
  peers: readonly RoutePeer[];
  /** the relay's own counts. Absent ⇒ the summary line is skipped. */
  counts?: RoutePresenceCounts | null;
  /** the screen's human name, for "… viewing Deals" */
  label?: string | null;
  /** the viewer's own actor id, so their avatar reads "(you)" */
  selfActorId?: string | null;
  /** avatars drawn before the overflow chip takes over */
  max?: number;
  /**
   * Draw the "N people viewing …" caption after the avatars. Off on a phone,
   * where the header has no room for it (it would overflow the right edge) and
   * where "1 person viewing Home" is just the viewer reading their own screen.
   */
  showSummary?: boolean;
  /**
   * Open the object a peer has resolvable. The default is phase 4's SIDE-PEEK:
   * "go and look at what Claude is doing" must not throw away the table, its
   * filters or its scroll position — the peek opens over them and Back closes
   * it. An override exists for hosts that want something else.
   */
  onOpenObject?: (objectId: string) => void;
}

export function PresenceRail({
  peers,
  counts,
  label,
  selfActorId,
  max = 4,
  showSummary: showSummaryProp = true,
  onOpenObject,
}: PresenceRailProps) {
  const { theme } = useTheme();
  const { openPeek } = usePeek();

  const roster = useMemo(() => dedupePeers(peers), [peers]);
  const shown = roster.slice(0, Math.max(1, max));
  const overflow = roster.slice(shown.length);
  const summary = useMemo(() => (counts ? presenceSummary(counts, label) : ""), [counts, label]);

  // The whole "degrades to nothing" rule, in one line. `peers` is empty
  // whenever the session is not live, so a dropped socket lands here.
  if (peers.length === 0) return null;

  const open = (objectId: string): void => {
    if (onOpenObject) onOpenObject(objectId);
    else openPeek(objectId);
  };

  return (
    <div className="flex min-w-0 items-center gap-2" data-slot="presence-rail">
      {/* "Who", not "people": a robot in this group is a first-class member of
          it, and a screen reader should not be told otherwise. */}
      <div className="flex items-center" role="group" aria-label="Who is here">
        {shown.map((peer) => {
          const objectId = peer.objectId;
          return (
            <Avatar
              key={peer.clientId}
              peer={peer}
              caption={peerCaption(peer, counts ?? null, peer.actorId === selfActorId, label)}
              ink={presenceInk(peer.color, theme === "dark" ? "dark" : "light")}
              onOpen={objectId ? () => open(objectId) : null}
            />
          );
        })}
        {overflow.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-label={`${overflow.length} more`}
                  className="presence-avatar -ml-1.5 inline-flex h-6 min-w-6 cursor-default items-center justify-center border border-line bg-panel2 px-1 font-mono text-[10px] text-mut ring-1 ring-ground"
                />
              }
            >
              +{overflow.length}
            </TooltipTrigger>
            <TooltipContent>
              {overflow
                .map((p) => (p.actorId === selfActorId ? `${p.name} (you)` : p.name))
                .join(", ")}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {showSummaryProp && summary && (
        <span className="min-w-0 truncate text-[11.5px] text-dim" data-slot="presence-summary">
          {summary}
        </span>
      )}
    </div>
  );
}

function Avatar({
  peer,
  caption,
  ink,
  onOpen,
}: {
  peer: RoutePeer;
  caption: string;
  ink: string;
  onOpen: (() => void) | null;
}) {
  // The relay stamps `robot` for every agent and initials for everybody else,
  // so the two agree; either one alone is enough to draw the machine.
  const isAgent = peer.kind === "agent" || peer.glyph === "robot";
  const body = (
    <span
      aria-hidden
      className="inline-flex h-full w-full items-center justify-center leading-none"
    >
      {isAgent ? <Bot aria-hidden className="size-3.5" /> : peer.glyph.slice(0, 2)}
    </span>
  );

  // Same box either way; only the affordance differs. An avatar with no
  // resolvable object is not a link — there is nothing to open, and pretending
  // otherwise would leak the fact that something is there.
  // `presence-avatar` is the coarse-pointer hook (index.css): a tappable avatar
  // ("go see what Claude is editing") is a real control, so on a finger it meets
  // the app's 44px target floor and drops the negative overlap that makes a 24px
  // pile a mis-tap machine. Fine pointers keep the tight overlapping pile.
  const shell =
    "presence-avatar -ml-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center border font-mono text-[10px] ring-1 ring-ground transition-transform first:ml-0 hover:z-10";
  const tint = {
    // The initials sit at 10px on a ~12%-alpha tint of the ink; the raw hue
    // fails contrast on the saturated light-skin slots (amber, cyan). Pulling
    // the glyph toward `--ink-strong` (black on paper, white on aurora — the
    // max-contrast colour for each ground) keeps the person's hue while making
    // the letters legible, in both skins. The border and fill stay the pure ink,
    // so identity-by-colour is untouched.
    color: `color-mix(in srgb, var(--ink-strong) 42%, ${ink})`,
    borderColor: `${ink}55`,
    background: `${ink}1f`,
    // A second, non-colour signal that this is a machine: the graphite slot
    // reads as "muted person" in a monochrome skin, a dashed edge does not.
    ...(isAgent ? { borderStyle: "dashed" as const } : {}),
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              aria-label={caption}
              data-kind={peer.kind}
              className={`${shell} cursor-pointer hover:-translate-y-px`}
              style={tint}
            />
          ) : (
            <span
              tabIndex={0}
              aria-label={caption}
              data-kind={peer.kind}
              className={`${shell} cursor-default`}
              style={tint}
            />
          )
        }
      >
        {body}
      </TooltipTrigger>
      <TooltipContent>{caption}</TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------- route-bound */

interface RoutePresenceRailProps extends Omit<PresenceRailProps, "peers" | "counts"> {
  /** the screen, e.g. `type/deal`. `null` on a screen with no room. */
  routeKey: string | null;
  /** injected by tests; live code lets the hook join the real socket. */
  presence?: RoutePresenceState;
}

/**
 * The rail wired to a route room. One line for a page to adopt presence:
 * `<RoutePresenceRail routeKey={`type/${type}`} label="Deals" />`.
 */
export function RoutePresenceRail({ routeKey, presence, ...rest }: RoutePresenceRailProps) {
  const live = useRoutePresence(presence ? null : routeKey);
  const state = presence ?? live;
  return <PresenceRail {...rest} peers={state.peers} counts={state.counts} />;
}
