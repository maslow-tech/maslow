/**
 * NODE PRESENCE — collaborator and agent avatars riding ON the graph nodes
 * being edited right now — live presence.
 *
 * The rail answers "who is on this screen"; this answers "what are they
 * touching", which is the thing only the graph can show: a robot parked on a
 * cluster of deals, two people converging on the same hub, the brain visibly
 * being worked on. It is the phase-2 route room and the phase-5 agent
 * identities, projected through the phase-6 camera.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PRIVACY RULE, which is the whole design of this file
 *
 * Presence entries arrive ALREADY INTERSECTED per recipient: the relay
 * (`apps/box/src/collab/presence.ts`) resolves "which object is this person in"
 * against THAT recipient's own RLS read and omits `objectId` otherwise. So:
 *
 *  1. **The client never resolves an unknown object id into a node.** An entry
 *     whose `objectId` is not already in the loaded, visible node set is simply
 *     NOT DRAWN — not at the graph's centre, not at the last known position,
 *     not in an "elsewhere" pile in the corner. A placeholder position is
 *     exactly the leak the server-side intersection exists to prevent: it would
 *     say "there is an object here you cannot see, and someone is editing it".
 *  2. **No `objectId` ⇒ no badge.** That peer is in the presence rail, which is
 *     where a person with nothing resolvable belongs. Nothing here says why —
 *     no ghost avatar, no "hidden" chip, no count of the difference.
 *  3. **Nothing is derived from anything but the states we were given.** No
 *     object lookup by id, no join against a cache, no counting.
 *
 * `clusterPresence` below is where all three live, which is why it is a pure
 * function with its own tests: the projection is decoration, the filter is the
 * boundary.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A DOM LAYER AND NOT THE LABEL CANVAS
 *
 * The label overlay (`lib/graph/labels.ts`) is a hot path: it clears and
 * repaints every label every frame, and it is owned end to end by the view's
 * frame callback. Avatars are a handful of elements, not hundreds of strings —
 * and they want a tooltip, a focus ring and a click target, all of which a
 * canvas has to reinvent badly. So they are absolutely-positioned DOM, moved by
 * `transform` from `renderer.worldToScreen` on the same rAF cadence, which
 * keeps them glued to their node through pan, zoom and settle without a single
 * React re-render per frame (a `setState` per frame is precisely the cost the
 * whole engine exists to avoid).
 *
 * De-duplication differs from the rail's ON PURPOSE. The rail keeps one avatar
 * per ACTOR, because "how many browser tabs Dana has open" is not a fact anyone
 * wants. Here the unit is (actor, node): an agent holding three objects is
 * genuinely three cursors in three places, and that is the picture. Two tabs on
 * the SAME node still collapse to one badge.
 */

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { Bot } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "../../lib/theme";
import { labelTextFor } from "../../lib/graph/labels";
import type { GraphRenderer } from "../../lib/graph/renderer";
import type { GraphNode } from "../../lib/graph/types";
import { presenceInk } from "../PresenceRail";
import { useRoutePresence, type RoutePeer, type RoutePresenceState } from "../../lib/routePresence";
import { useGraphEngine } from "../../views/GraphView";

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/**
 * The whole-brain graph's route room. A route key may never embed an object id
 * (`routeRoomKey` refuses one), and this one is a screen name like every other.
 */
const GRAPH_ROUTE_KEY = "graph";

/** Avatars drawn on one node before the rest collapse into a `+N` chip. */
export const MAX_BADGES_PER_NODE = 3;

/** Gap in CSS px between the node's screen edge and the badge row's bottom. */
const BADGE_GAP = 6;

/** How far off-screen a cluster may sit before it stops being laid out at all. */
const OFFSCREEN_MARGIN = 64;

/* ------------------------------------------------------------------ *
 * the filter (pure — this is the privacy boundary)
 * ------------------------------------------------------------------ */

/** The badges that ride on one node. `index` is a DENSE INDEX into the store. */
interface NodePresenceCluster {
  readonly index: number;
  /** the object this node IS — already visible to this viewer, by construction */
  readonly objectId: string;
  /** drawn, in the order the relay sent them */
  readonly peers: readonly RoutePeer[];
  /** deduped peers past the cap — the `+N` chip, never dropped from the tooltip */
  readonly overflow: readonly RoutePeer[];
}

/**
 * Presence states → node clusters, dropping everything this viewer has no node
 * for.
 *
 * `indexOf` is the store's `id → dense index` map and is the ONLY resolution
 * step: an id it does not know is an object that is not on this client's graph
 * (never loaded, filtered out, or — the case that matters — never visible to
 * this viewer at all). All three end the same way, with nothing drawn, because
 * distinguishing them on screen is itself the leak.
 *
 * One badge per (actor, node): the first state that actor sent for that node
 * wins, so Dana with two tabs on the same object is one avatar, while an agent
 * holding three different objects is three.
 */
export function clusterPresence(
  peers: readonly RoutePeer[],
  indexOf: (id: string) => number | undefined,
  max: number = MAX_BADGES_PER_NODE,
): NodePresenceCluster[] {
  const buckets = new Map<number, { objectId: string; seen: Set<string>; peers: RoutePeer[] }>();
  for (const peer of peers) {
    const objectId = peer.objectId;
    // Rule 2: a peer the server resolved nothing for rides on no node. The rail
    // still shows them; this layer says nothing at all.
    if (objectId === undefined || objectId === "") continue;
    const index = indexOf(objectId);
    // Rule 1: unknown id ⇒ no node, and no fallback position either.
    if (index === undefined || !Number.isInteger(index) || index < 0) continue;
    let bucket = buckets.get(index);
    if (bucket === undefined) {
      bucket = { objectId, seen: new Set<string>(), peers: [] };
      buckets.set(index, bucket);
    }
    if (bucket.seen.has(peer.actorId)) continue;
    bucket.seen.add(peer.actorId);
    bucket.peers.push(peer);
  }
  const cap = Math.max(1, Math.floor(Number.isFinite(max) ? max : MAX_BADGES_PER_NODE));
  // Ascending index: a stable DOM order across frames, so focus does not hop
  // when an unrelated peer joins.
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, bucket]) => ({
      index,
      objectId: bucket.objectId,
      peers: bucket.peers.slice(0, cap),
      overflow: bucket.peers.slice(cap),
    }));
}

/**
 * What one badge says. The object's TITLE is fair game — this viewer has the
 * node, so they can already read it off the label overlay — but nothing else
 * is: no count, no id, no "and 2 more you can't see".
 */
export function nodePeerCaption(peer: RoutePeer, label: string, isSelf: boolean): string {
  const who = isSelf ? `${peer.name} (you)` : peer.name;
  const where = label.trim() === "" ? "this object" : label.trim();
  return peer.kind === "agent" ? `${who} is editing ${where}` : `${who} — editing ${where}`;
}

/* ------------------------------------------------------------------ *
 * the layer
 * ------------------------------------------------------------------ */

/**
 * The slice of the graph engine this layer needs. Deliberately narrow (the full
 * `GraphEngine` is satisfied structurally) so a test can hand it four fields
 * instead of mounting a WebGL canvas.
 */
export interface NodePresenceEngineLike {
  readonly renderer: Pick<
    GraphRenderer,
    "positions" | "worldToScreen" | "radiusAt" | "size" | "getCamera" | "onFrameTick"
  > | null;
  /** bumps when a page lands — clusters are recomputed against it. */
  readonly revision: number;
  /** dense-index-ordered; only the title is read, and only for the caption. */
  readonly nodes: readonly Pick<GraphNode, "title">[];
  indexOf: (id: string) => number | undefined;
}

export interface NodePresenceLayerProps {
  engine: NodePresenceEngineLike;
  /** exactly the states the relay sent THIS viewer. Empty when not live. */
  peers: readonly RoutePeer[];
  /** the viewer's own actor id, so their own badge reads "(you)" */
  selfActorId?: string | null | undefined;
  max?: number | undefined;
  /** clicking a badge — the node is already visible, so this leaks nothing. */
  onSelect?: ((index: number, objectId: string) => void) | undefined;
}

/**
 * The badges, positioned from the camera every frame.
 *
 * Renders `null` when there is nothing to draw — no empty container, no
 * skeleton. `peers` is empty whenever the presence session is not live (see
 * `routePresence.ts`, "down means gone"), so a dropped socket lands here and
 * the avatars simply leave the nodes.
 */
export function NodePresenceLayer({
  engine,
  peers,
  selfActorId,
  max,
  onSelect,
}: NodePresenceLayerProps) {
  const { theme } = useTheme();
  const skin = theme === "dark" ? "dark" : "light";

  const clusters = useMemo(
    () => clusterPresence(peers, engine.indexOf, max ?? MAX_BADGES_PER_NODE),
    // The store is mutated in place as pages land, so `indexOf` reads through
    // to state this memo cannot observe; `revision` is the signal that a
    // previously-unknown id may now resolve to a node.
    [peers, engine.indexOf, engine.revision, max],
  );

  const elements = useRef(new Map<number, HTMLDivElement>());
  /** last applied transform per cluster (or `hidden`) — skips redundant writes */
  const applied = useRef(new Map<number, string>());

  const renderer = engine.renderer;

  const place = useCallback(() => {
    if (renderer === null) return;
    const { width, height } = renderer.size();
    const xy = renderer.positions();
    const scale = renderer.getCamera().scale;
    for (const cluster of clusters) {
      const el = elements.current.get(cluster.index);
      if (el === undefined) continue;
      const wx = xy[2 * cluster.index];
      const wy = xy[2 * cluster.index + 1];
      // A node the worker has not placed yet (a page that just landed) has no
      // position. It gets no badge THIS frame and one on a later frame — never
      // a guessed one.
      if (
        wx === undefined ||
        wy === undefined ||
        !Number.isFinite(wx) ||
        !Number.isFinite(wy) ||
        !Number.isFinite(scale)
      ) {
        apply(applied.current, cluster.index, el, null);
        continue;
      }
      const screen = renderer.worldToScreen(wx, wy);
      const radius = Math.max(0, renderer.radiusAt(cluster.index)) * scale;
      const x = Math.round(screen.x);
      const y = Math.round(screen.y - radius - BADGE_GAP);
      if (
        x < -OFFSCREEN_MARGIN ||
        y < -OFFSCREEN_MARGIN ||
        x > width + OFFSCREEN_MARGIN ||
        y > height + OFFSCREEN_MARGIN
      ) {
        apply(applied.current, cluster.index, el, null);
        continue;
      }
      apply(
        applied.current,
        cluster.index,
        el,
        `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`,
      );
    }
  }, [clusters, renderer]);

  // Layout effect, not effect: the first placement happens BEFORE paint, so a
  // badge never flashes at the top-left corner on the frame it appears.
  //
  // Placement then RIDES THE RENDERER'S FRAME LOOP (`onFrameTick`) rather than a
  // self-perpetuating rAF. The renderer stops drawing the instant the graph
  // settles and the camera stops (renderer.ts rule 3 / the perf bench's "idle
  // CPU ≈ 0% once settled"); an independent 60fps loop here would keep both
  // tabs awake forever whenever a peer badge is shown — exactly the multiplayer
  // idle case this feature exists for. Riding the loop means we recompute
  // positions only while the graph is actually moving. The one synchronous
  // `place()` below covers a badge that appears while the graph is already
  // settled (no frame is coming to place it).
  useLayoutEffect(() => {
    if (renderer === null || clusters.length === 0) return;
    place();
    return renderer.onFrameTick(place);
  }, [clusters, place, renderer]);

  // Cluster set changed ⇒ the index→element map may be stale in either
  // direction; drop the memo of what was applied so the next pass writes.
  useLayoutEffect(() => {
    const live = new Set(clusters.map((c) => c.index));
    for (const index of [...applied.current.keys()]) {
      if (!live.has(index)) applied.current.delete(index);
    }
  }, [clusters]);

  if (renderer === null || clusters.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      data-slot="graph-node-presence"
      role="group"
      aria-label="Who is editing right now"
    >
      {clusters.map((cluster) => (
        <div
          key={cluster.index}
          data-slot="graph-node-presence-cluster"
          data-index={cluster.index}
          ref={(el) => {
            if (el === null) {
              elements.current.delete(cluster.index);
              applied.current.delete(cluster.index);
            } else {
              elements.current.set(cluster.index, el);
            }
          }}
          className="absolute top-0 left-0 flex items-center will-change-transform"
        >
          {cluster.peers.map((peer) => (
            <NodeAvatar
              key={`${peer.actorId}:${peer.clientId}`}
              peer={peer}
              ink={presenceInk(peer.color, skin)}
              caption={nodePeerCaption(
                peer,
                labelTextFor(engine.nodes[cluster.index]?.title, cluster.objectId),
                peer.actorId === selfActorId,
              )}
              onOpen={onSelect ? () => onSelect(cluster.index, cluster.objectId) : null}
            />
          ))}
          {cluster.overflow.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    aria-label={`${cluster.overflow.length} more`}
                    className="pointer-events-auto -ml-1.5 inline-flex h-5 min-w-5 cursor-default items-center justify-center border border-line bg-panel2 px-1 font-mono text-[9px] text-mut ring-1 ring-ground"
                  />
                }
              >
                +{cluster.overflow.length}
              </TooltipTrigger>
              <TooltipContent>
                {cluster.overflow
                  .map((p) => (p.actorId === selfActorId ? `${p.name} (you)` : p.name))
                  .join(", ")}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      ))}
    </div>
  );
}

/** Write a transform (or hide) only when it actually changed. */
function apply(
  memo: Map<number, string>,
  index: number,
  el: HTMLDivElement,
  transform: string | null,
): void {
  const key = transform ?? "hidden";
  if (memo.get(index) === key) return;
  memo.set(index, key);
  if (transform === null) {
    el.style.visibility = "hidden";
    return;
  }
  el.style.transform = transform;
  el.style.visibility = "";
}

/**
 * One avatar. Same box for a person and a robot — the machine is drawn by the
 * same code path a human is, exactly as in the rail, because it arrives over
 * the same wire with the same per-recipient filtering. Only the mark (lucide
 * `Bot` vs the relay's initials) and the dashed edge differ, so the machine
 * reads as a machine without relying on colour alone.
 */
function NodeAvatar({
  peer,
  ink,
  caption,
  onOpen,
}: {
  peer: RoutePeer;
  ink: string;
  caption: string;
  onOpen: (() => void) | null;
}) {
  const isAgent = peer.kind === "agent" || peer.glyph === "robot";
  const shell =
    "pointer-events-auto -ml-1.5 inline-flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[9px] shadow-sm ring-1 ring-ground transition-transform first:ml-0 hover:z-10";
  const tint = {
    color: ink,
    borderColor: `${ink}55`,
    background: `${ink}1f`,
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
        <span
          aria-hidden
          className="inline-flex h-full w-full items-center justify-center leading-none"
        >
          {isAgent ? <Bot aria-hidden className="size-3" /> : peer.glyph.slice(0, 2)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{caption}</TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ *
 * mounted inside <GraphView>
 * ------------------------------------------------------------------ */

interface NodePresenceProps {
  /** the screen's room. Defaults to the whole-brain graph. */
  routeKey?: string | undefined;
  /** injected by tests; live code lets the hook join the real socket. */
  presence?: RoutePresenceState | undefined;
  selfActorId?: string | null | undefined;
  max?: number | undefined;
  /**
   * Overrides the default click, which focuses the node and eases the camera
   * onto it — "go and look at what Claude is doing" without leaving the map.
   */
  onSelect?: ((index: number, objectId: string) => void) | undefined;
}

/**
 * `<GraphView><NodePresence /></GraphView>` — the whole mount. It takes the
 * engine from context rather than props, which is what keeps it out of
 * `GraphView.tsx`.
 */
export function NodePresence({
  routeKey = GRAPH_ROUTE_KEY,
  presence,
  selfActorId,
  max,
  onSelect,
}: NodePresenceProps = {}) {
  const engine = useGraphEngine();
  const live = useRoutePresence(presence ? null : routeKey);
  const state = presence ?? live;

  const handleSelect = useCallback(
    (index: number, objectId: string) => {
      if (onSelect) {
        onSelect(index, objectId);
        return;
      }
      engine.setFocus(index);
      engine.camera.centerOn(index);
    },
    [engine, onSelect],
  );

  return (
    <NodePresenceLayer
      engine={engine}
      peers={state.peers}
      selfActorId={selfActorId}
      max={max}
      onSelect={handleSelect}
    />
  );
}
