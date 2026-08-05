/**
 * The graph's navigation gestures, wired to the phase-4 side-peek.
 *
 * A force layout you can only *look* at is a poster. This bridge is what makes
 * it a working surface, and every rule in it exists to protect one thing: your
 * place on the map.
 *
 *  - **Single click opens the object in the SIDE-PEEK** (`lib/peek.tsx` →
 *    `<SidePeek>`): the full editor, the same per-object CAS save queue, the
 *    same drafts, the same collab room. Not a summary card — you read *and
 *    edit* from the graph. The peek only adds `?peek=<id>` to the current
 *    route, so the route, the filters and — the part this file is responsible
 *    for — the CAMERA are untouched. Nothing here calls `camera.*`. Ever. (The
 *    test asserts exactly that, because "opens a panel" is easy to get right
 *    and "did not quietly re-center the graph" is what people actually notice.)
 *  - **Double click navigates to the full object page.** `GraphView` already
 *    owns that (`onOpen` → `navigate("/o/:id")`); this file's job is to get out
 *    of its way. A dblclick CANCELS the pending peek open, which is why the
 *    open is scheduled {@link PEEK_OPEN_DELAY_MS} after the click rather than
 *    during it: mounting the editor for 200ms would fetch the object, spin up
 *    a save queue and join — then leave — the object's collab room, flickering
 *    your presence in front of everyone else editing it.
 *  - **⌘-click (or ctrl-click) sets the second endpoint of a shortest path.**
 *    The first endpoint is whatever you were already on (the peeked node); the
 *    request is handed to the shortest-path feature, which owns the BFS and the
 *    verb labelling. If nothing was focused, the ⌘-click becomes the FIRST
 *    endpoint and the hint bar says so.
 *  - **The peek header carries "Path to…"** — the spec's second entry point to
 *    the same feature, for people who never learn a modifier. It is portalled
 *    into the live peek header rather than adding a slot to `SidePeek.tsx`
 *    (which several parallel tasks share); if the header is not there, the
 *    action falls back to the graph's own bar, so it can never simply vanish.
 *  - **Hovering an edge shows its relationship verb** — the CSR carries the
 *    interned `rel` per half-edge, so this is a nearest-segment scan over the
 *    nodes already on screen, throttled to one probe per frame and skipped
 *    entirely while the pointer is over a node (a node hover always wins).
 *
 * Decoupling: the shortest-path overlay is a separate task and a separate
 * file, so the endpoints are handed over either through the `onPathRequest`
 * prop or, when nobody passed one, as a window `CustomEvent`
 * ({@link GRAPH_PATH_REQUEST_EVENT}). Neither side imports the other.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Route } from "lucide-react";

import { Button } from "@/components/ui/button";
import { slotRange } from "../../lib/graph/csr";
import type { GraphStore } from "../../lib/graph/store";
import type { Csr } from "../../lib/graph/types";
import { usePeek } from "../../lib/peek";
import { useGraphEngine, type GraphEngine } from "../../views/GraphView";

/* ------------------------------------------------------------------ *
 * tuning
 * ------------------------------------------------------------------ */

/**
 * How long a click waits before it becomes a peek. Long enough for the second
 * click of a double-click to cancel it, short enough that a single click still
 * feels like a click.
 */
const PEEK_OPEN_DELAY_MS = 180;

/** A pointer gesture's modifiers only speak for the click they belong to. */
const GESTURE_WINDOW_MS = 800;

/**
 * Every event of one click gesture, in the order a browser fires them.
 *
 * All three are watched rather than just `pointerdown` because the modifier
 * must be read from whichever event actually produced the focus change, and
 * that is not always the first one: a renderer may commit selection on `click`,
 * and ⌘ can be pressed between the press and the release. Reading the newest
 * one inside {@link GESTURE_WINDOW_MS} answers "was this click held with ⌘"
 * correctly in every case. (It also happens to be what makes this testable —
 * jsdom has no `PointerEvent`, so a synthetic `pointerdown` carries no
 * modifiers at all.)
 */
const GESTURE_EVENTS = ["pointerdown", "mousedown", "click"] as const;

/** Screen-space slop for hitting an edge. Edges are hairs; be generous. */
const EDGE_HIT_PX = 6;

/** Half-edge slots one probe may look at before it gives up. */
const EDGE_SCAN_BUDGET = 40_000;

/* ------------------------------------------------------------------ *
 * the shortest-path handoff
 * ------------------------------------------------------------------ */

export interface GraphPathEndpoint {
  /** dense index, valid against the store revision that produced it. */
  index: number;
  id: string;
}

export interface GraphPathRequest {
  from: GraphPathEndpoint;
  to: GraphPathEndpoint;
}

/**
 * "Trace a path between these two objects." Dispatched on `window` when no
 * `onPathRequest` handler was passed, so the shortest-path overlay can listen
 * without either file importing the other.
 */
export const GRAPH_PATH_REQUEST_EVENT = "brain:graph-path-request";

function emitGraphPathRequest(detail: GraphPathRequest): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<GraphPathRequest>(GRAPH_PATH_REQUEST_EVENT, { detail }));
}

/* ------------------------------------------------------------------ *
 * edge hit testing (pure)
 * ------------------------------------------------------------------ */

/** Distance from a point to the segment a→b, all in screen pixels. */
export function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

interface EdgeHit {
  /** dense indices of the two endpoints, in CSR order (not direction). */
  a: number;
  b: number;
  /** the interned relationship verb from the CSR. */
  rel: string;
  distance: number;
}

/**
 * The nearest edge to a screen point among the edges incident to `candidates`
 * (in practice `renderer.visibleNodes()`), or null.
 *
 * Candidates are the nodes ON SCREEN rather than the whole graph: an edge that
 * passes near the pointer with both endpoints offscreen is culled by the
 * renderer too, so it is not on screen to be hovered. `budget` bounds the walk
 * on a pathological hub so a pointer move can never stall a frame.
 */
export function nearestEdge(
  csr: Csr,
  candidates: Iterable<number>,
  project: (index: number) => { x: number; y: number } | null,
  point: { x: number; y: number },
  maxPx: number = EDGE_HIT_PX,
  budget: number = EDGE_SCAN_BUDGET,
): EdgeHit | null {
  let best: EdgeHit | null = null;
  let spent = 0;
  // Screen positions are re-used across a node's whole slot range and across
  // both directions of every edge, so one projection per node per probe.
  const cache = new Map<number, { x: number; y: number } | null>();

  const at = (index: number): { x: number; y: number } | null => {
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const p = project(index);
    cache.set(index, p);
    return p;
  };

  for (const u of candidates) {
    if (u < 0 || u >= csr.n) continue;
    const pu = at(u);
    if (pu === null) continue;
    const [start, end] = slotRange(csr, u);
    for (let slot = start; slot < end; slot += 1) {
      if (spent >= budget) return best;
      spent += 1;
      const v = csr.neighbors[slot]!;
      if (v === u) continue;
      const pv = at(v);
      if (pv === null) continue;
      const distance = pointSegmentDistance(point.x, point.y, pu.x, pu.y, pv.x, pv.y);
      if (distance > maxPx) continue;
      // Every edge is reached twice (once per endpoint) and the two half-edges
      // are the same segment, so keeping the strict minimum settles it without
      // a seen-set: the second visit ties and loses.
      if (best !== null && distance >= best.distance) continue;
      best = { a: u, b: v, rel: csr.rels[csr.relIndex[slot]!] ?? "", distance };
    }
  }
  return best;
}

/**
 * Which way round the hovered edge actually points. The CSR is undirected (a
 * verb reads the same from either end for traversal), but "mentions" is a
 * claim about a direction, so the tooltip must not invent one.
 */
export function orientEdge(
  store: GraphStore,
  aId: string,
  bId: string,
  rel: string,
): [string, string] {
  let out: [string, string] = [aId, bId];
  let found = false;
  const scan = (from: string, to: string): void => {
    if (found || !store.graph.hasNode(from)) return;
    store.graph.forEachOutEdge(from, (_edge, attrs, _source, target) => {
      if (found) return;
      if (target !== to) return;
      if ((attrs.rel ?? "") !== rel) return;
      out = [from, to];
      found = true;
    });
  };
  scan(aId, bId);
  scan(bId, aId);
  return out;
}

interface EdgeLabel {
  from: string;
  rel: string;
  to: string;
}

/** The tooltip's three strings, or null when either endpoint has gone away. */
export function edgeLabel(engine: GraphEngine, hit: EdgeHit): EdgeLabel | null {
  const aId = engine.idAt(hit.a);
  const bId = engine.idAt(hit.b);
  if (aId === undefined || bId === undefined) return null;
  const [fromId, toId] = orientEdge(engine.store, aId, bId, hit.rel);
  const title = (id: string): string => {
    const index = engine.indexOf(id);
    const node = index === undefined ? undefined : engine.nodes[index];
    return node?.title ?? "untitled";
  };
  return { from: title(fromId), rel: hit.rel === "" ? "linked to" : hit.rel, to: title(toId) };
}

/* ------------------------------------------------------------------ *
 * the peek header slot
 * ------------------------------------------------------------------ */

/**
 * A mount point inside the LIVE side-peek header, or null when the panel is
 * not on screen.
 *
 * Portalling rather than adding a prop to `SidePeek.tsx` is deliberate: that
 * file is shared by every phase-4/6 surface, and one graph-only action is not
 * worth a shared edit. The element is created and removed by this hook, so
 * React never has to reconcile it.
 */
function usePeekHeaderSlot(active: boolean): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!active || typeof document === "undefined") {
      setSlot(null);
      return;
    }
    let mount: HTMLElement | null = null;

    const attach = (): void => {
      const header = document.querySelector<HTMLElement>('[data-testid="side-peek"] header');
      if (header === null) return;
      if (mount !== null && mount.parentElement === header) return;
      mount?.remove();
      mount = document.createElement("span");
      mount.setAttribute("data-graph-path-slot", "");
      const openLink = header.querySelector('a[aria-label="Open full page"]');
      if (openLink !== null) header.insertBefore(mount, openLink);
      else header.appendChild(mount);
      setSlot(mount);
    };

    attach();
    const observer =
      typeof MutationObserver === "function" ? new MutationObserver(() => attach()) : null;
    observer?.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      mount?.remove();
      mount = null;
      setSlot(null);
    };
  }, [active]);

  return slot;
}

/* ------------------------------------------------------------------ *
 * the bridge
 * ------------------------------------------------------------------ */

interface NodePeekBridgeProps {
  engine: GraphEngine;
  /**
   * Where a completed pair of endpoints goes. Omit it and the pair is
   * dispatched as {@link GRAPH_PATH_REQUEST_EVENT} instead.
   */
  onPathRequest?: (request: GraphPathRequest) => void;
  /** override the dblclick grace period (tests use 0). */
  openDelayMs?: number;
  /**
   * The graph surface's rect, for turning client coords into canvas coords.
   * Defaults to this overlay's own box (it is `inset-0` over the canvas);
   * jsdom has no layout, so tests inject one.
   */
  rectOf?: () => { left: number; top: number } | null;
}

interface HoveredEdge extends EdgeLabel {
  x: number;
  y: number;
  key: string;
}

export function NodePeekBridgePanel({
  engine,
  onPathRequest,
  openDelayMs = PEEK_OPEN_DELAY_MS,
  rectOf,
}: NodePeekBridgeProps) {
  const { openPeek, top: peekTop } = usePeek();
  const rootRef = useRef<HTMLDivElement | null>(null);

  /** the node a path will start FROM once a second endpoint is picked. */
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const awaitingRef = useRef<number | null>(awaiting);
  awaitingRef.current = awaiting;

  /** the last node opened plainly — the implicit first endpoint. */
  const anchorRef = useRef<number | null>(null);
  /** the id we have already acted on, so a re-render never re-opens it. */
  const handledRef = useRef<string | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const gestureRef = useRef<{ path: boolean; at: number }>({ path: false, at: 0 });

  const [edge, setEdge] = useState<HoveredEdge | null>(null);

  const engineRef = useRef(engine);
  engineRef.current = engine;

  const cancelPendingOpen = useCallback(() => {
    if (openTimerRef.current === null) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  /* ---------------- the path handoff ---------------- */

  const requestPath = useCallback(
    (from: number, to: number): void => {
      const current = engineRef.current;
      const fromId = current.idAt(from);
      const toId = current.idAt(to);
      if (fromId === undefined || toId === undefined) return;
      const request: GraphPathRequest = {
        from: { index: from, id: fromId },
        to: { index: to, id: toId },
      };
      if (onPathRequest) onPathRequest(request);
      else emitGraphPathRequest(request);
    },
    [onPathRequest],
  );

  /** A node was picked while a path was being built (⌘-click, or "Path to…"). */
  const takeEndpoint = useCallback(
    (index: number): void => {
      const from = awaitingRef.current ?? anchorRef.current;
      if (from === null || from === index) {
        setAwaiting(index);
        return;
      }
      setAwaiting(null);
      requestPath(from, index);
    },
    [requestPath],
  );

  /* ---------------- gesture capture ---------------- */

  // CAPTURE phase, and before the renderer's own listeners: by the time React
  // has re-rendered on the resulting focus change, the modifier that produced
  // it is long gone from the event system. Capture still runs before the
  // target's own handler, so `gestureRef` is always current when the focus
  // effect reads it.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const surface = root.parentElement;

    const inside = (target: EventTarget | null): boolean =>
      surface === null || (target instanceof Node && surface.contains(target));

    const onGesture = (event: Event): void => {
      if (!inside(event.target)) return;
      const modifiers = event as Partial<MouseEvent>;
      gestureRef.current = {
        path: modifiers.metaKey === true || modifiers.ctrlKey === true,
        at: Date.now(),
      };
    };
    const onDoubleClick = (): void => {
      // The full page is opening (GraphView owns that navigation); a peek that
      // mounts an editor for 200ms only to unmount it is pure presence noise.
      cancelPendingOpen();
      handledRef.current = null;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (awaitingRef.current === null) return;
      setAwaiting(null);
    };

    for (const name of GESTURE_EVENTS) window.addEventListener(name, onGesture, true);
    window.addEventListener("dblclick", onDoubleClick, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      for (const name of GESTURE_EVENTS) window.removeEventListener(name, onGesture, true);
      window.removeEventListener("dblclick", onDoubleClick, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [cancelPendingOpen]);

  /* ---------------- focus → peek (or path endpoint) ---------------- */

  const focus = engine.focus;

  useEffect(() => {
    if (focus === null) {
      handledRef.current = null;
      return;
    }
    const id = engineRef.current.idAt(focus);
    if (id === undefined) return;
    if (handledRef.current === id) return;
    handledRef.current = id;

    const gesture = gestureRef.current;
    const withModifier = gesture.path && Date.now() - gesture.at < GESTURE_WINDOW_MS;
    if (withModifier || awaitingRef.current !== null) {
      takeEndpoint(focus);
      return;
    }

    anchorRef.current = focus;
    if (peekTop === id) return;

    cancelPendingOpen();
    // NOT cleared by this effect's own cleanup: `openPeek` changes identity on
    // every URL change, and an unrelated param landing inside the 180ms window
    // would otherwise cancel a click you did make. `handledRef` is what keeps
    // a re-run from scheduling twice; the dblclick handler and unmount are the
    // only things allowed to cancel.
    const timer = window.setTimeout(() => {
      openTimerRef.current = null;
      openPeek(id);
    }, openDelayMs);
    openTimerRef.current = timer;
  }, [focus, peekTop, openPeek, openDelayMs, takeEndpoint, cancelPendingOpen]);

  // Walking the peek stack (or landing on a shared `?peek=` URL) moves the
  // graph's ring to match. It never moves the camera — the node may well be
  // off screen, and yanking the view is precisely what this file exists to
  // avoid; the halo is there when you pan back.
  const peekIndex = peekTop === null ? undefined : engine.indexOf(peekTop);
  const { setFocus } = engine;
  // Only when the PEEK ITSELF changed — not whenever focus drifts away from it.
  //
  // Keyed on `focus`, this effect force-synced focus back to whatever the peek
  // was showing, which made the peek↔focus binding a trap: clicking a lit
  // neighbour set focus to the new node, this immediately snapped it back to
  // the open peek, and the 180ms open-timer then saw the OLD focus and never
  // opened the new one. Selecting a neighbour was impossible while a peek was
  // up — the first click appeared to do nothing and only a second, after the
  // peek had been dismissed, worked. Walking the stack and landing on a shared
  // `?peek=` URL still move the ring, which is all this was ever for.
  const syncedPeekRef = useRef<string | null>(null);
  useEffect(() => {
    if (peekTop === null) {
      syncedPeekRef.current = null;
      return;
    }
    if (syncedPeekRef.current === peekTop) return;
    syncedPeekRef.current = peekTop;
    if (peekIndex === undefined || focus === peekIndex) return;
    handledRef.current = peekTop;
    setFocus(peekIndex);
    // `focus` is deliberately NOT a dependency — see above.
  }, [peekIndex, peekTop, focus, setFocus]);

  useEffect(() => cancelPendingOpen, [cancelPendingOpen]);

  /* ---------------- edge hover ---------------- */

  const probe = useCallback(
    (client: { x: number; y: number }): void => {
      const current = engineRef.current;
      const renderer = current.renderer;
      const csr = current.csr;
      if (renderer === null || csr === null) {
        setEdge(null);
        return;
      }
      const rect = rectOf?.() ?? rootRef.current?.getBoundingClientRect() ?? null;
      if (rect === null) {
        setEdge(null);
        return;
      }
      const x = client.x - rect.left;
      const y = client.y - rect.top;
      // A node under the pointer always wins: hover isolation is the stronger
      // signal, and an edge tooltip over a node reads as the node's label.
      if (renderer.hitTest(x, y) !== null) {
        setEdge(null);
        return;
      }
      const positions = renderer.positions();
      const project = (index: number): { x: number; y: number } | null => {
        const wx = positions[2 * index];
        const wy = positions[2 * index + 1];
        if (wx === undefined || wy === undefined) return null;
        if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
        return renderer.worldToScreen(wx, wy);
      };
      const hit = nearestEdge(csr, renderer.visibleNodes(), project, { x, y });
      if (hit === null) {
        setEdge(null);
        return;
      }
      const label = edgeLabel(current, hit);
      if (label === null) {
        setEdge(null);
        return;
      }
      const key = `${Math.min(hit.a, hit.b)}:${Math.max(hit.a, hit.b)}:${hit.rel}`;
      setEdge((prev) =>
        prev !== null && prev.key === key && prev.x === x && prev.y === y
          ? prev
          : { ...label, x, y, key },
      );
    },
    [rectOf],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const surface = root.parentElement;
    let frame = 0;
    let pending: { x: number; y: number } | null = null;

    const onMove = (event: PointerEvent): void => {
      const target = event.target;
      const inside = surface === null || (target instanceof Node && surface.contains(target));
      if (!inside) {
        setEdge(null);
        return;
      }
      pending = { x: event.clientX, y: event.clientY };
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const point = pending;
        pending = null;
        if (point !== null) probe(point);
      });
    };
    const onLeave = (): void => setEdge(null);

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [probe]);

  /* ---------------- the "Path to…" action ---------------- */

  const slot = usePeekHeaderSlot(peekTop !== null && peekIndex !== undefined);

  const startPath = useCallback(() => {
    const from = peekIndex ?? anchorRef.current;
    if (from === undefined || from === null) return;
    setAwaiting(from);
  }, [peekIndex]);

  const awaitingTitle = useMemo(() => {
    if (awaiting === null) return null;
    return engine.nodes[awaiting]?.title ?? "untitled";
  }, [awaiting, engine.nodes]);

  const pathButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={startPath}
      aria-label="Path to another object"
      title="Path to… — then click the object to trace a path to (⌘-click works anywhere on the map)"
    >
      <Route />
    </Button>
  );

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-30">
      {slot !== null && peekIndex !== undefined && createPortal(pathButton, slot)}

      {slot === null && peekIndex !== undefined && (
        <div className="pointer-events-auto absolute top-3 right-3 flex items-center gap-1 border border-line-soft bg-panel px-1.5 py-1 shadow-sm">
          {pathButton}
        </div>
      )}

      {awaiting !== null && (
        <div
          role="status"
          className="pointer-events-auto absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 border border-line-soft bg-panel px-3 py-1.5 text-[11.5px] text-dim shadow-md"
        >
          <Route size={13} aria-hidden />
          <span>
            Tracing from <b className="text-ink">{awaitingTitle}</b> — click (or ⌘-click) the object
            to trace a path to.
          </span>
          <Button size="xs" variant="ghost" onClick={() => setAwaiting(null)}>
            Cancel
          </Button>
        </div>
      )}

      {edge !== null && (
        <div
          role="status"
          style={{ left: edge.x + 12, top: edge.y + 12 }}
          className="pointer-events-none absolute max-w-[22rem] border border-line-soft bg-panel px-2 py-1 text-[11.5px] text-dim shadow-md"
        >
          <span className="text-ink">{edge.from}</span>
          <span className="px-1 font-mono text-[10.5px] text-dim">— {edge.rel} →</span>
          <span className="text-ink">{edge.to}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Mounted as a child of `<GraphView>`; reads the engine from context. The
 * panel takes it explicitly so it stays testable without a live view.
 */
export function NodePeekBridge(props: Omit<NodePeekBridgeProps, "engine">) {
  const engine = useGraphEngine();
  return <NodePeekBridgePanel engine={engine} {...props} />;
}
