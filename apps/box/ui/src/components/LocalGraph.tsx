import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router";

import { api, type BrainObject, type Edge } from "../lib/api";
import { typeHue } from "../lib/ui";
import { useTheme } from "../lib/theme";
import { GraphStore } from "../lib/graph/store";
import { buildCsr, relOf, unpackEdgeKey } from "../lib/graph/csr";
import {
  bfs,
  buildOrientation,
  internalEdges,
  treeEdges,
  type TraversalDirection,
} from "../lib/graph/analysis";
import { fitText, labelTextFor } from "../lib/graph/labels";
import { PhysicsHandle } from "../lib/graph/physics";
import { forcesFrom, useGraphControls, RAIL_CONTROL_DEFAULTS } from "./graph/GraphControls";
import type { GraphPage } from "../lib/graph/types";

/**
 * The object page's LOCAL GRAPH — what replaced `MiniMap.tsx`.
 *
 * The old component was not a graph. It was a static two-column rail (incoming
 * left, outgoing right) on a fixed 34px row pitch, one hop only, hard-capped at
 * nine per side with everything past that collapsed into "+N more". It could
 * not express that two of your neighbours know each other, it never moved, and
 * it truncated the moment an object got interesting — i.e. exactly when you
 * needed it.
 *
 * This is a real BFS ball in the phase-6 engine (`lib/graph/store`, `/csr`,
 * `/analysis`, `/physics`, `/labels`), sized for a ~300px rail. Six rules carry
 * the whole file, and each one is the answer to a specific way local graphs go
 * wrong:
 *
 *  1. **Depth is the user's, not ours.** BFS to depth 1–3 (default 1),
 *     undirected, with separate in/out toggles and a "neighbour links" toggle:
 *     ON draws every edge with BOTH endpoints in the set — the true local
 *     density, the thing the old rail structurally could not show — OFF draws
 *     the BFS-TREE edges only, a clean radial hierarchy. Auto-ON for d ≤ 2,
 *     because at d = 3 the density is noise in 300px.
 *  2. **Capped at 80 nodes, kept by degree, ancestors closed.** An uncapped
 *     depth-3 ball on a hub is 400 nodes in a 300px rail, which is the old
 *     truncation problem in a new costume. Past the cap we keep the
 *     highest-degree members (with every kept node's BFS ancestors, so the
 *     tree never breaks) and say "+N more" with a chip that opens the FULL
 *     graph focused here — the overflow is a door, not a dead end.
 *  3. **Forces scaled to the rail, never borrowed from the global view.**
 *     `railScale = sqrt(railArea / referenceArea)`; the rail's own defaults
 *     (link distance 20, repel −60, center 0.08 — `RAIL_CONTROL_DEFAULTS`)
 *     live under their own control scope, so a −120 charge tuned on a 1400px
 *     canvas can never reach a 300px one. The focus node is PINNED at the rail
 *     centre so the picture is radially organised and nothing drifts.
 *  4. **At d ≤ 2 there is no physics at all.** A deterministic radial layout
 *     (ring radius `hop × 70px`, rail-scaled; angle allocated by subtree size)
 *     is always legible, never jitters, and settles in zero frames. Force runs
 *     only at d = 3, and even then it merely supplies TARGETS to the same
 *     animation engine below.
 *  5. **Navigation is animated, because "static" was the complaint.** An
 *     object change is debounced ~180ms, the new set is DIFFED against the old
 *     (`diffLayout`), and survivors KEEP their x/y — the graph is never rebuilt
 *     from scratch, which is the tell of a cheap local graph. New nodes spawn
 *     at their BFS parent's position plus ≤8px of deterministic jitter and
 *     scale/fade in over 200ms; removed nodes fade over 150ms and are only then
 *     released; everything else tweens to its new home over 300ms on
 *     `cubic-bezier(.4,0,.2,1)` while the old focus is unpinned and the new one
 *     is pinned. The graph RE-CENTERS; it is not replaced.
 *  6. **The privacy rule, client-side half.** Depth ≥ 2 is assembled from
 *     `GET /api/v1/objects/:id` on the frontier, which is RLS-scoped: an
 *     invisible neighbour 404s and is DROPPED, never drawn as a placeholder,
 *     and a deleted edge target is dropped the same way. Nothing here infers,
 *     reconstructs or hints at an object the server declined to hand over.
 *
 * The relationship verbs survive — they were the one thing the old rail did
 * well — on the focus node's direct edges always, and on hover for everything
 * else. Text is measured with `fitText` in the page's real font (the shared
 * measurer from `lib/graph/labels`, which is what the note there asked whoever
 * deleted MiniMap to reuse), never guessed by character count.
 */

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** Hard node cap for the rail. Past this we keep degree and offer the door. */
export const LOCAL_NODE_CAP = 80;

/** Ring radius per hop, in world units, before the rail scale is applied. */
export const RING_RADIUS = 70;

/** The rail the forces and the ring radius were tuned against, in CSS px. */
const RAIL_REFERENCE_AREA = 320 * 320;

/** Debounce on an object change before the rail recomputes (spec: 150–250ms). */
const NAV_DEBOUNCE_MS = 180;

/** New nodes scale/fade in over this. */
export const ENTER_MS = 200;
/** Removed nodes fade over this, and are released at the end of it. */
export const EXIT_MS = 150;
/** The re-centering tween when the focus object changes. */
export const RECENTER_MS = 300;
/** Max spawn offset from the BFS parent, in world units. */
export const SPAWN_JITTER = 8;

/** Depth above which we stop drawing every internal edge by default. */
const DENSE_EDGE_DEPTH = 2;

/** Depth at or above which the force simulation takes over from the rings. */
const PHYSICS_DEPTH = 3;

/**
 * How many frontier objects one navigation may fetch. Depth ≥ 2 walks the
 * frontier one GET at a time (there is no server-side neighbourhood endpoint,
 * and inventing one would be a bigger change than this task); the budget is
 * what stops a hub object from firing four hundred requests at a rail nobody
 * is looking at. When it runs out we render what we have and say so.
 */
const EXPAND_BUDGET = 64;

/** Frontier fetches in flight at once. */
const EXPAND_CONCURRENCY = 4;

const TITLE_FS = 12.5;
const VERB_FS = 10.5;
const FOCUS_R = 10.5;

/**
 * Below this rail width the picture stops being readable rather than merely
 * small: 80 nodes with 12.5px labels do not fit a 390px phone, and shrinking
 * them further produces a decorative smear that claims to be information. At
 * or under it the rail COLLAPSES to a named entry point instead — "view
 * connections (12)" — which is an honest thing to tap, unlike a graph you
 * cannot read. 360 is the widest common phone rail (a 390px viewport less the
 * page's own gutters).
 */
export const RAIL_LEGIBLE_MIN_PX = 360;

/** Invisible tap padding per node on a coarse pointer. A 4px circle is not a
 *  target; the ring around it is what a thumb actually hits. */
const TOUCH_HIT_R = 22;

/* ------------------------------------------------------------------ *
 * adjacency — the partial neighbourhood we have actually been given
 * ------------------------------------------------------------------ */

/** One half of an edge, as an object payload hands it over. */
interface LocalLink {
  readonly id: string;
  readonly rel: string;
}

/**
 * One object in the local neighbourhood.
 *
 * `expanded` is the load-bearing field: a record we FETCHED knows all of its
 * own visible edges, and a record we only learned about as somebody else's
 * edge target (a "stub") knows only the edges that named it. BFS may therefore
 * only traverse THROUGH an expanded record — walking through a stub would
 * silently present an incomplete neighbourhood as a complete one.
 */
interface LocalRecord {
  readonly id: string;
  readonly title: string | null;
  readonly type: string | null;
  readonly expanded: boolean;
  readonly out: LocalLink[];
  readonly in: LocalLink[];
  /** distinct neighbours we know about — the cap's ranking key. */
  readonly degree: number;
}

type LocalAdjacency = ReadonlyMap<string, LocalRecord>;

function emptyRecord(id: string, title: string | null, type: string | null): LocalRecord {
  return { id, title, type, expanded: false, out: [], in: [], degree: 0 };
}

/**
 * Fold one fetched object into an adjacency, creating stubs for its edge
 * targets. A deleted target is dropped (the old rail did this too) and a
 * self-edge is dropped — neither is a neighbourhood. Degrees are NOT updated
 * here; call `recomputeDegrees` once the batch is in.
 */
function mergeObject(adj: Map<string, LocalRecord>, object: BrainObject): void {
  const out: LocalLink[] = [];
  const inn: LocalLink[] = [];
  const touch = (e: Edge, list: LocalLink[]) => {
    if (e.target_deleted || e.id === object.id) return;
    list.push({ id: e.id, rel: e.rel });
    const prev = adj.get(e.id);
    if (prev === undefined) {
      adj.set(e.id, emptyRecord(e.id, e.target_title, e.target_type));
    } else if (!prev.expanded && prev.title === null && e.target_title !== null) {
      adj.set(e.id, { ...prev, title: e.target_title, type: e.target_type ?? prev.type });
    }
  };
  for (const e of object.links) touch(e, out);
  for (const e of object.backlinks) touch(e, inn);

  adj.set(object.id, {
    id: object.id,
    title: object.title,
    type: object.type,
    expanded: true,
    out,
    in: inn,
    degree: 0,
  });
}

/**
 * Distinct-neighbour degree for every record, over the edges we have actually
 * been given.
 *
 * A STUB's degree is therefore only what the expanded side declared, which
 * systematically under-counts it — and that bias is wanted: the 80-node cap
 * ranks by this number, so an inner node we know a lot about outranks an outer
 * one we know almost nothing about, which is the right thing to keep in 300px.
 * It is never presented as the object's true degree anywhere.
 */
function recomputeDegrees(adj: Map<string, LocalRecord>): void {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    let set = neighbours.get(a);
    if (set === undefined) {
      set = new Set<string>();
      neighbours.set(a, set);
    }
    set.add(b);
  };
  for (const r of adj.values()) {
    for (const l of [...r.out, ...r.in]) {
      if (!adj.has(l.id)) continue;
      link(r.id, l.id);
      link(l.id, r.id);
    }
  }
  for (const [id, record] of adj) {
    adj.set(id, { ...record, degree: neighbours.get(id)?.size ?? 0 });
  }
}

/** An adjacency seeded from one or more fetched objects, degrees computed. */
export function adjacencyFrom(objects: Iterable<BrainObject>): Map<string, LocalRecord> {
  const adj = new Map<string, LocalRecord>();
  for (const o of objects) mergeObject(adj, o);
  recomputeDegrees(adj);
  return adj;
}

/**
 * The adjacency as an engine page. Edges are emitted once per (from, to, rel)
 * and only when BOTH endpoints are known, which is the same rule
 * `GraphStore.ingest` enforces on the whole-brain walk — an edge naming a node
 * we were never given is dropped, never drawn against a synthesized one.
 */
function pageFromAdjacency(adj: LocalAdjacency): GraphPage {
  const nodes = [...adj.values()].map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    degree: r.degree,
  }));
  const edges: Array<{ from: string; to: string; rel: string }> = [];
  const seen = new Set<string>();
  const push = (from: string, to: string, rel: string) => {
    if (from === to || !adj.has(from) || !adj.has(to)) return;
    const key = `${from}\u0000${to}\u0000${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, rel });
  };
  for (const r of adj.values()) {
    for (const l of r.out) push(r.id, l.id, l.rel);
    // The `in` half matters: when the other endpoint is a stub, this is the
    // only place that edge is ever declared.
    for (const l of r.in) push(l.id, r.id, l.rel);
  }
  return { nodes, edges };
}

/**
 * Hop distance from `focusId` over the adjacency, traversing expanded records
 * only — and only along `direction`, so the frontier walk agrees with what
 * `buildLocalSet` will actually draw. An undirected walk here wasted the
 * 64-fetch expansion budget on branches the user's in/out toggles hide (an
 * outgoing-only ball spending its whole budget expanding a high-in-degree
 * hub's incoming side) and made the "partially expanded" caption describe the
 * undirected ball rather than the displayed one.
 */
function hopsWithin(
  adj: LocalAdjacency,
  focusId: string,
  depth: number,
  direction: TraversalDirection = "both",
): Map<string, number> {
  const hops = new Map<string, number>();
  if (!adj.has(focusId)) return hops;
  hops.set(focusId, 0);
  let frontier = [focusId];
  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const record = adj.get(id);
      if (record === undefined || !record.expanded) continue;
      const links =
        direction === "out"
          ? record.out
          : direction === "in"
            ? record.in
            : [...record.out, ...record.in];
      for (const l of links) {
        if (hops.has(l.id)) continue;
        hops.set(l.id, hop + 1);
        next.push(l.id);
      }
    }
    frontier = next;
  }
  return hops;
}

/* ------------------------------------------------------------------ *
 * the BFS ball, the cap, and the edge set
 * ------------------------------------------------------------------ */

export interface LocalGraphNode {
  readonly id: string;
  readonly title: string | null;
  readonly type: string | null;
  /** BFS hop from the focus; 0 is the focus itself. */
  readonly hop: number;
  /** BFS parent id; null for the focus. New nodes spawn HERE. */
  readonly parent: string | null;
  /** the verb on the edge that discovered it; "" when untyped. */
  readonly rel: string;
  readonly degree: number;
}

export interface LocalGraphEdge {
  readonly a: string;
  readonly b: string;
  readonly rel: string;
  /** "out" = a→b, "in" = b→a, "both" = linked each way. */
  readonly dir: "out" | "in" | "both";
  /** touches the focus node — these verbs are always drawn. */
  readonly atFocus: boolean;
}

export interface LocalGraphSet {
  readonly focus: string;
  /** focus first, then BFS order. */
  readonly nodes: LocalGraphNode[];
  readonly edges: LocalGraphEdge[];
  /** reached by the BFS but dropped by the cap. */
  readonly overflow: number;
}

interface LocalGraphOptions {
  depth: number;
  incoming: boolean;
  outgoing: boolean;
  neighborLinks: boolean;
  cap?: number;
}

const EMPTY_SET: LocalGraphSet = { focus: "", nodes: [], edges: [], overflow: 0 };

/** 1–3, integral. Anything else (a persisted preference) becomes 1. */
export function clampDepth(depth: unknown): number {
  const d = typeof depth === "number" && Number.isFinite(depth) ? Math.round(depth) : 1;
  return d < 1 ? 1 : d > 3 ? 3 : d;
}

/**
 * Trim a BFS ball to `cap`, keeping the highest-degree members.
 *
 * Two rules beyond "sort by degree":
 *
 *  - the SOURCE is always kept — a local graph without its focus is not one;
 *  - a candidate is admitted together with its BFS ANCESTORS, or not at all.
 *    Degree alone would happily keep a hop-3 node whose hop-2 parent lost the
 *    tie-break, leaving a node with nothing to attach to and no place on a
 *    ring. Admitting the chain keeps the tree connected and still respects the
 *    cap exactly (a chain that does not fit is skipped, and scanning
 *    continues — a cheaper candidate later may still fit).
 */
export function capReached(
  order: ArrayLike<number>,
  levels: ArrayLike<number>,
  parents: ArrayLike<number>,
  degreeOf: (index: number) => number,
  cap: number,
): { kept: Set<number>; overflow: number } {
  const reached: number[] = [];
  for (let i = 0; i < order.length; i += 1) reached.push(order[i]!);
  const kept = new Set<number>();
  if (reached.length === 0) return { kept, overflow: 0 };
  const source = reached[0]!;
  kept.add(source);
  const limit = Math.max(1, Math.floor(cap));
  if (reached.length <= limit) {
    for (const i of reached) kept.add(i);
    return { kept, overflow: 0 };
  }

  const ranked = reached.slice(1).sort((a, b) => {
    const d = degreeOf(b) - degreeOf(a);
    if (d !== 0) return d;
    const l = (levels[a] ?? 0) - (levels[b] ?? 0);
    if (l !== 0) return l;
    return a - b;
  });

  for (const candidate of ranked) {
    if (kept.size >= limit) break;
    if (kept.has(candidate)) continue;
    const chain: number[] = [];
    let walk = candidate;
    let ok = true;
    while (!kept.has(walk)) {
      chain.push(walk);
      const parent = parents[walk] ?? -1;
      if (parent < 0) {
        // Unreachable from a kept node — cannot happen for a BFS ball rooted
        // at a kept source, but never trust a shape you did not build.
        ok = false;
        break;
      }
      walk = parent;
    }
    if (!ok || kept.size + chain.length > limit) continue;
    for (const i of chain) kept.add(i);
  }
  return { kept, overflow: reached.length - kept.size };
}

/** The traversal direction the two toggles add up to. */
function directionOf(incoming: boolean, outgoing: boolean): TraversalDirection {
  if (incoming && outgoing) return "both";
  if (outgoing) return "out";
  if (incoming) return "in";
  return "both";
}

/**
 * The local graph: a BFS ball over the adjacency, capped, with either every
 * internal edge or just the BFS tree.
 *
 * It builds a real `GraphStore` + `Csr` and runs the shared `bfs` /
 * `internalEdges` / `treeEdges` rather than a bespoke walk, so the rail and the
 * whole-brain view agree on what a neighbourhood is by construction.
 */
export function buildLocalSet(
  adj: LocalAdjacency,
  focusId: string,
  options: LocalGraphOptions,
): LocalGraphSet {
  const cap = options.cap ?? LOCAL_NODE_CAP;
  const store = new GraphStore();
  store.ingest(pageFromAdjacency(adj));
  const source = store.indexOf(focusId);
  if (source === undefined) return { ...EMPTY_SET, focus: focusId };

  const csr = buildCsr(store);
  const direction = directionOf(options.incoming, options.outgoing);
  // Both toggles off is "just me" rather than an error or a silent "both".
  const depth = !options.incoming && !options.outgoing ? 0 : clampDepth(options.depth);
  const orientation = direction === "both" ? null : buildOrientation(store, csr);
  const walk = bfs(csr, source, depth, { direction, orientation });

  const { kept, overflow } = capReached(
    walk.order,
    walk.levels,
    walk.parents,
    (i) => store.nodeAt(i)?.degree ?? 0,
    cap,
  );

  const nodes: LocalGraphNode[] = [];
  for (let k = 0; k < walk.order.length; k += 1) {
    const i = walk.order[k]!;
    if (!kept.has(i)) continue;
    const node = store.nodeAt(i);
    const id = store.idAt(i);
    if (node === undefined || id === undefined) continue;
    const parentIndex = walk.parents[i] ?? -1;
    const parent = parentIndex >= 0 ? (store.idAt(parentIndex) ?? null) : null;
    const slot = walk.parentSlots[i] ?? -1;
    nodes.push({
      id,
      title: node.title,
      type: node.type,
      hop: walk.levels[i] ?? 0,
      parent,
      rel: slot >= 0 ? (relOf(csr, slot) ?? "") : "",
      degree: node.degree,
    });
  }

  const keys = options.neighborLinks ? internalEdges(csr, kept) : treeEdges(walk);
  const edges: LocalGraphEdge[] = [];
  for (const key of keys) {
    const [i, j] = unpackEdgeKey(key);
    if (!kept.has(i) || !kept.has(j)) continue;
    const a = store.idAt(i);
    const b = store.idAt(j);
    if (a === undefined || b === undefined) continue;
    const forward = store.graph.hasDirectedEdge(a, b);
    const backward = store.graph.hasDirectedEdge(b, a);
    edges.push({
      a,
      b,
      rel: relBetween(csr, i, j),
      dir: forward && backward ? "both" : backward ? "in" : "out",
      atFocus: i === source || j === source,
    });
  }

  return { focus: focusId, nodes, edges, overflow };
}

function relBetween(csr: ReturnType<typeof buildCsr>, i: number, j: number): string {
  const end = csr.offsets[i + 1] ?? 0;
  for (let s = csr.offsets[i] ?? 0; s < end; s += 1) {
    if (csr.neighbors[s] === j) return relOf(csr, s) ?? "";
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * layout — deterministic rings at d ≤ 2, forces at d = 3
 * ------------------------------------------------------------------ */

export interface Point {
  x: number;
  y: number;
}

/** `sqrt(railArea / referenceArea)`, clamped so a collapsed rail cannot zero it. */
export function railScale(width: number, height: number): number {
  const area = Math.max(1, width * height);
  const scale = Math.sqrt(area / RAIL_REFERENCE_AREA);
  return scale < 0.55 ? 0.55 : scale > 1.8 ? 1.8 : scale;
}

/** The rail's force bag: the rail control scope, scaled to the actual rail. */
function railForces(
  controls: Parameters<typeof forcesFrom>[0],
  scale: number,
): ReturnType<typeof forcesFrom> {
  const base = forcesFrom(controls);
  return {
    ...base,
    linkDistance: (base.linkDistance ?? RAIL_CONTROL_DEFAULTS.linkDistance) * scale,
  };
}

/**
 * The deterministic radial layout: hop rings, angle allocated by SUBTREE SIZE
 * so a bushy branch gets the room it needs and a lone one does not hog a
 * quadrant. Focus at the origin (the rail centre); zero settle time, no jitter,
 * identical for the same set every time — which is exactly what makes the
 * navigation diff below meaningful.
 */
export function radialLayout(set: LocalGraphSet, ringRadius = RING_RADIUS): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (set.nodes.length === 0) return positions;

  const children = new Map<string, string[]>();
  const byId = new Map(set.nodes.map((n) => [n.id, n]));
  for (const n of set.nodes) {
    if (n.parent === null || !byId.has(n.parent)) continue;
    const list = children.get(n.parent);
    if (list === undefined) children.set(n.parent, [n.id]);
    else list.push(n.id);
  }

  const weights = new Map<string, number>();
  const weigh = (id: string): number => {
    const cached = weights.get(id);
    if (cached !== undefined) return cached;
    const kids = children.get(id);
    weights.set(id, 1); // cycle guard: a malformed parent chain terminates
    const w =
      kids === undefined || kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + weigh(kid), 0);
    weights.set(id, w);
    return w;
  };

  positions.set(set.focus, { x: 0, y: 0 });
  const place = (id: string, a0: number, a1: number) => {
    const kids = children.get(id);
    if (kids === undefined || kids.length === 0) return;
    const total = kids.reduce((sum, kid) => sum + weigh(kid), 0) || 1;
    let cursor = a0;
    for (const kid of kids) {
      const span = ((a1 - a0) * weigh(kid)) / total;
      const angle = cursor + span / 2;
      const hop = byId.get(kid)?.hop ?? 1;
      positions.set(kid, {
        x: Math.cos(angle) * ringRadius * hop,
        y: Math.sin(angle) * ringRadius * hop,
      });
      place(kid, cursor, cursor + span);
      cursor += span;
    }
  };
  // Start at −90° so the first branch sits at the top, which is where the eye
  // starts on a vertical rail.
  place(set.focus, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2);
  for (const n of set.nodes) if (!positions.has(n.id)) positions.set(n.id, { x: 0, y: 0 });
  return positions;
}

/** The undirected link list for the d = 3 simulation, over the SET's own indices. */
export function physicsLinks(set: LocalGraphSet): Int32Array {
  const index = new Map(set.nodes.map((n, i) => [n.id, i]));
  const out = new Int32Array(set.edges.length * 2);
  let k = 0;
  for (const e of set.edges) {
    const a = index.get(e.a);
    const b = index.get(e.b);
    if (a === undefined || b === undefined || a === b) continue;
    out[k] = a;
    out[k + 1] = b;
    k += 2;
  }
  return k === out.length ? out : out.slice(0, k);
}

/* ------------------------------------------------------------------ *
 * the animation engine — the whole answer to "it never moves"
 * ------------------------------------------------------------------ */

/**
 * A cubic-bezier timing function, Newton-solved. Written out rather than
 * approximated because `cubic-bezier(.4,0,.2,1)` is the exact curve the spec
 * names for the re-centering tween, and "close enough" easing is what makes
 * motion feel bought rather than designed.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) break;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(t < 0 ? 0 : t > 1 ? 1 : t);
  };
}

/** The re-centering curve, exactly as specified. */
const STANDARD_EASE = cubicBezier(0.4, 0, 0.2, 1);
/** The entrance curve — decelerating, so a new node arrives rather than lands. */
const EASE_OUT = cubicBezier(0, 0, 0.2, 1);

type NodePhase = "entering" | "steady" | "leaving";

/**
 * One node as the rail actually draws it: where it IS, where it is heading,
 * and how far through its fade it is. `x`/`y` are the drawn position and are
 * never recomputed from the layout — they are only ever advanced along a tween,
 * which is what lets a surviving node keep its place across a navigation.
 */
export interface PlacedNode {
  readonly id: string;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** ms timestamp the position tween started. */
  tweenAt: number;
  /** tween duration; 0 means "already there". */
  tweenMs: number;
  alpha: number;
  /** alpha when the current phase began — a re-entering node resumes, not restarts. */
  alpha0: number;
  phase: NodePhase;
  phaseAt: number;
  /** the focus node, held at the rail centre (and `pin`ned in the d = 3 sim). */
  pinned: boolean;
}

export interface LocalLayout {
  readonly focus: string;
  readonly nodes: Map<string, PlacedNode>;
  /** nothing is tweening or fading — the render loop may stop. */
  readonly settled: boolean;
}

const EMPTY_LAYOUT: LocalLayout = { focus: "", nodes: new Map(), settled: true };

/**
 * A node's spawn offset from its BFS parent: deterministic in its id, never
 * `Math.random()`. Two identical navigations therefore draw identically (a
 * random offset makes a re-render look like a nudge), and the magnitude is
 * bounded by construction so "≈8px jitter" is a guarantee rather than a mean.
 */
export function spawnJitter(id: string, magnitude = SPAWN_JITTER): Point {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = (h >>> 0) / 4294967296;
  const v = ((h >>> 9) & 1023) / 1023;
  const angle = u * Math.PI * 2;
  const radius = magnitude * (0.35 + 0.65 * v);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

interface DiffOptions {
  /** the re-centering duration; 0 under `prefers-reduced-motion`. */
  recenterMs?: number;
  enterMs?: number;
  jitter?: (id: string) => Point;
}

/**
 * Diff a new local set against the layout on screen.
 *
 * This is the function the whole "animated navigation" requirement reduces to,
 * and its contract is exactly four sentences:
 *
 *  - a node in BOTH keeps its `x`/`y` — it tweens to its new home from where it
 *    stands, and is NEVER rebuilt from the layout;
 *  - a node only in the new set spawns at its BFS parent's CURRENT position
 *    (falling back to the parent's target, then the centre) plus bounded
 *    jitter, at alpha 0;
 *  - a node only in the old layout goes to `leaving`, freezes in place, and is
 *    released by `advanceLayout` once its fade is done — not before, or it
 *    would pop;
 *  - the new focus is pinned and the old one is not, so the picture re-centers
 *    instead of being replaced.
 */
export function diffLayout(
  prev: LocalLayout | null,
  set: LocalGraphSet,
  targets: ReadonlyMap<string, Point>,
  now: number,
  options: DiffOptions = {},
): LocalLayout {
  const recenterMs = Math.max(0, options.recenterMs ?? RECENTER_MS);
  const enterMs = Math.max(0, options.enterMs ?? ENTER_MS);
  const jitter = options.jitter ?? spawnJitter;
  const centre: Point = { x: 0, y: 0 };
  const nodes = new Map<string, PlacedNode>();

  for (const n of set.nodes) {
    const target = targets.get(n.id) ?? centre;
    const before = prev?.nodes.get(n.id);
    if (before !== undefined) {
      const reviving = before.phase === "leaving" || before.alpha < 1;
      nodes.set(n.id, {
        ...before,
        // The survivor rule, stated as code: x/y are copied, not recomputed.
        x: before.x,
        y: before.y,
        fromX: before.x,
        fromY: before.y,
        toX: target.x,
        toY: target.y,
        tweenAt: now,
        tweenMs: recenterMs,
        phase: reviving ? "entering" : "steady",
        phaseAt: reviving ? now : before.phaseAt,
        alpha0: reviving ? before.alpha : 1,
        pinned: n.id === set.focus,
      });
      continue;
    }

    const parentPlaced = n.parent === null ? undefined : prev?.nodes.get(n.parent);
    const parentTarget = n.parent === null ? undefined : targets.get(n.parent);
    const anchor: Point =
      parentPlaced !== undefined
        ? { x: parentPlaced.x, y: parentPlaced.y }
        : (parentTarget ?? centre);
    const offset = jitter(n.id);
    const x = anchor.x + offset.x;
    const y = anchor.y + offset.y;
    nodes.set(n.id, {
      id: n.id,
      x,
      y,
      fromX: x,
      fromY: y,
      toX: target.x,
      toY: target.y,
      tweenAt: now,
      tweenMs: prev === null ? 0 : recenterMs,
      alpha: enterMs === 0 ? 1 : 0,
      alpha0: 0,
      phase: enterMs === 0 ? "steady" : "entering",
      phaseAt: now,
      pinned: n.id === set.focus,
    });
  }

  if (prev !== null) {
    for (const [id, before] of prev.nodes) {
      if (nodes.has(id)) continue;
      nodes.set(
        id,
        before.phase === "leaving"
          ? before
          : {
              ...before,
              fromX: before.x,
              fromY: before.y,
              toX: before.x,
              toY: before.y,
              tweenAt: now,
              tweenMs: 0,
              alpha0: before.alpha,
              phase: "leaving",
              phaseAt: now,
              pinned: false,
            },
      );
    }
  }

  return { focus: set.focus, nodes, settled: false };
}

/**
 * Point a settled layout at new targets — the d = 3 simulation's tick path.
 *
 * A node that is still mid-tween is LEFT ALONE: retargeting it every physics
 * tick would restart its navigation animation thirty times a second and the
 * re-centering would never visibly complete. Leaving nodes are never
 * retargeted at all; they are fading in place.
 */
export function retargetLayout(
  layout: LocalLayout,
  targets: ReadonlyMap<string, Point>,
  now: number,
  tweenMs = 0,
): LocalLayout {
  const nodes = new Map<string, PlacedNode>();
  let changed = false;
  for (const [id, node] of layout.nodes) {
    const target = targets.get(id);
    const midTween = node.tweenMs > 0 && now - node.tweenAt < node.tweenMs;
    if (target === undefined || node.phase === "leaving" || midTween) {
      nodes.set(id, node);
      continue;
    }
    if (node.toX === target.x && node.toY === target.y && node.tweenMs === tweenMs) {
      nodes.set(id, node);
      continue;
    }
    changed = true;
    nodes.set(id, {
      ...node,
      fromX: node.x,
      fromY: node.y,
      toX: target.x,
      toY: target.y,
      tweenAt: now,
      tweenMs,
    });
  }
  return { focus: layout.focus, nodes, settled: changed ? false : layout.settled };
}

/**
 * One frame: advance every tween and fade, and RELEASE the leaving nodes whose
 * fade has finished. Pure, so the render loop is a call and the behaviour is a
 * test rather than a stopwatch and a squint.
 */
export function advanceLayout(layout: LocalLayout, now: number): LocalLayout {
  const nodes = new Map<string, PlacedNode>();
  let settled = true;
  for (const [id, node] of layout.nodes) {
    if (node.phase === "leaving" && now - node.phaseAt >= EXIT_MS) continue; // released

    const pt = node.tweenMs > 0 ? clamp01((now - node.tweenAt) / node.tweenMs) : 1;
    const e = STANDARD_EASE(pt);
    const x = node.fromX + (node.toX - node.fromX) * e;
    const y = node.fromY + (node.toY - node.fromY) * e;

    let alpha = node.alpha;
    let phase = node.phase;
    if (phase === "entering") {
      const at = clamp01((now - node.phaseAt) / ENTER_MS);
      alpha = node.alpha0 + (1 - node.alpha0) * EASE_OUT(at);
      if (at >= 1) {
        alpha = 1;
        phase = "steady";
      }
    } else if (phase === "leaving") {
      alpha = node.alpha0 * (1 - clamp01((now - node.phaseAt) / EXIT_MS));
    } else {
      alpha = 1;
    }

    if (phase !== "steady" || pt < 1) settled = false;
    nodes.set(id, { ...node, x, y, alpha, phase });
  }
  return { focus: layout.focus, nodes, settled };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* ------------------------------------------------------------------ *
 * preferences + the full-graph handoff
 * ------------------------------------------------------------------ */

interface LocalGraphPrefs {
  depth: number;
  incoming: boolean;
  outgoing: boolean;
  /** null = follow the depth (on for d ≤ 2); a boolean once the user decides. */
  neighborLinks: boolean | null;
}

const DEFAULT_LOCAL_PREFS: LocalGraphPrefs = {
  depth: 1,
  incoming: true,
  outgoing: true,
  neighborLinks: null,
};

const PREFS_KEY = "brain:graph:local";

export function normalizeLocalPrefs(raw: unknown): LocalGraphPrefs {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_LOCAL_PREFS };
  }
  const p = raw as Partial<LocalGraphPrefs>;
  return {
    depth: clampDepth(p.depth),
    incoming: typeof p.incoming === "boolean" ? p.incoming : true,
    outgoing: typeof p.outgoing === "boolean" ? p.outgoing : true,
    neighborLinks: typeof p.neighborLinks === "boolean" ? p.neighborLinks : null,
  };
}

/** The toggle's effective value: explicit if the user set it, else on for d ≤ 2. */
export function neighborLinksOn(prefs: LocalGraphPrefs): boolean {
  return prefs.neighborLinks ?? prefs.depth <= DENSE_EDGE_DEPTH;
}

function loadPrefs(): LocalGraphPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw === null ? { ...DEFAULT_LOCAL_PREFS } : normalizeLocalPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LOCAL_PREFS };
  }
}

function savePrefs(prefs: LocalGraphPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // A preference we cannot store is not worth an error boundary.
  }
}

/**
 * The "full graph →" handoff, which PRESERVES FOCUS. The global view reads
 * these back and centres its camera on the object, selects the same local ball
 * and highlights it, so crossing over never costs you your place.
 */
export function fullGraphHref(focusId: string, depth: number): string {
  const params = new URLSearchParams({ focus: focusId, depth: String(clampDepth(depth)) });
  return `/graph?${params.toString()}`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A finger, not a mouse — watched live, because the same browser window can
 * change its mind (a detachable keyboard, a plugged-in mouse). No `matchMedia`
 * means "mouse", which is the frame this component has always shipped with.
 */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: coarse)");
    const onChange = (): void => setCoarse(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

/**
 * Does this rail have room to draw a legible graph? Pure so the rule is
 * testable without a layout: a mouse rail always does (it is 420px and you can
 * hover for detail); a touch rail does only above `RAIL_LEGIBLE_MIN_PX`.
 */
export function railIsLegible(widthPx: number, coarsePointer: boolean): boolean {
  if (!coarsePointer) return true;
  return widthPx >= RAIL_LEGIBLE_MIN_PX;
}

/* ------------------------------------------------------------------ *
 * frontier loading
 * ------------------------------------------------------------------ */

interface AdjacencyState {
  adj: LocalAdjacency;
  loading: boolean;
  /** the budget ran out before the ball was fully expanded — say so. */
  partial: boolean;
}

/**
 * Depth 1 needs ZERO fetches: the object payload already carries its links and
 * backlinks, which is why the rail's first paint is immediate. Depth ≥ 2 walks
 * the frontier with `GET /api/v1/objects/:id`, four at a time, under
 * `EXPAND_BUDGET`. Every fetch is RLS-scoped, so a neighbour the viewer cannot
 * see simply never arrives — and is never drawn.
 */
function useLocalAdjacency(
  object: BrainObject,
  depth: number,
  direction: TraversalDirection,
): AdjacencyState {
  const [state, setState] = useState<AdjacencyState>(() => ({
    adj: adjacencyFrom([object]),
    loading: false,
    partial: false,
  }));

  useEffect(() => {
    let cancelled = false;
    const base = adjacencyFrom([object]);
    setState({ adj: base, loading: depth > 1, partial: false });
    if (depth <= 1) return () => {};

    void (async () => {
      const work = new Map(base);
      let budget = EXPAND_BUDGET;
      for (let hop = 1; hop < depth; hop += 1) {
        // Direction-aware, so the budget is spent on branches the toggles
        // will actually draw — see hopsWithin.
        const hops = hopsWithin(work, object.id, depth, direction);
        const frontier = [...hops.entries()]
          .filter(([id, h]) => h === hop && work.get(id)?.expanded === false)
          .map(([id]) => id)
          .sort((a, b) => (work.get(b)?.degree ?? 0) - (work.get(a)?.degree ?? 0));
        if (frontier.length === 0) continue;

        for (let i = 0; i < frontier.length && budget > 0; i += EXPAND_CONCURRENCY) {
          const batch = frontier.slice(i, i + EXPAND_CONCURRENCY).slice(0, budget);
          budget -= batch.length;
          const fetched = await Promise.all(batch.map((id) => api.object(id).catch(() => null)));
          if (cancelled) return;
          for (const o of fetched) if (o !== null) mergeObject(work, o);
          recomputeDegrees(work);
          setState({ adj: new Map(work), loading: true, partial: false });
        }
      }
      if (cancelled) return;
      // Computed over the DIRECTED hops, so "partially expanded" describes
      // the ball the rail displays, not the undirected one.
      const remaining = [...hopsWithin(work, object.id, depth, direction).entries()].some(
        ([id, h]) => h < depth && work.get(id)?.expanded === false,
      );
      setState({ adj: new Map(work), loading: false, partial: remaining });
    })();

    return () => {
      cancelled = true;
    };
    // `version` is in the deps because an edit that adds a link must redraw.
  }, [object, object.id, object.version, depth, direction]);

  return state;
}

/** Debounce a changing value — the navigation debounce, 150–250ms per spec. */
function useDebounced<T>(value: T, ms: number): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    if (ms <= 0) {
      setHeld(value);
      return () => {};
    }
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}

/* ------------------------------------------------------------------ *
 * the component
 * ------------------------------------------------------------------ */

export function LocalGraph({ object }: { object: BrainObject }) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);

  const [prefs, setPrefsState] = useState<LocalGraphPrefs>(loadPrefs);
  const setPrefs = useCallback((patch: Partial<LocalGraphPrefs>) => {
    setPrefsState((prev) => {
      const next = normalizeLocalPrefs({ ...prev, ...patch });
      savePrefs(next);
      return next;
    });
  }, []);

  const [size, setSize] = useState({ w: 340, h: 240 });
  const [fontFamily, setFontFamily] = useState("ui-sans-serif, system-ui, sans-serif");
  const [hover, setHover] = useState<string | null>(null);
  const [, setFrame] = useState(0);

  const reduced = prefersReducedMotion();
  const coarse = useCoarsePointer();
  /** Opened by hand on a phone. Never sticky: the rail is not the page. */
  const [opened, setOpened] = useState(false);
  const collapsed = !railIsLegible(size.w, coarse) && !opened;
  const { values: controls } = useGraphControls("rail", RAIL_CONTROL_DEFAULTS);

  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const measure = () => {
      const w = el.clientWidth || 340;
      setSize({ w, h: Math.round(Math.min(340, Math.max(220, w * 0.86))) });
      setFontFamily(getComputedStyle(el).fontFamily || "ui-sans-serif, system-ui, sans-serif");
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // The navigation debounce: rapid hops through the brain compute ONE set.
  const focusObject = useDebounced(object, reduced ? 0 : NAV_DEBOUNCE_MS);
  // A collapsed rail stays at depth 1 — which costs ZERO fetches (the object
  // payload already carries its own links) — so a phone never walks the
  // frontier for a picture nobody has asked to see.
  const depth = collapsed ? 1 : clampDepth(prefs.depth);
  // Both toggles off draws "just me" (buildLocalSet depth 0) — no point
  // walking a frontier for a picture with no neighbours in it.
  const bothOff = !prefs.incoming && !prefs.outgoing;
  const { adj, loading, partial } = useLocalAdjacency(
    focusObject,
    bothOff ? 1 : depth,
    directionOf(prefs.incoming, prefs.outgoing),
  );

  const set = useMemo(
    () =>
      buildLocalSet(adj, focusObject.id, {
        depth,
        incoming: prefs.incoming,
        outgoing: prefs.outgoing,
        neighborLinks: neighborLinksOn(prefs),
      }),
    [adj, focusObject.id, depth, prefs],
  );

  const scale = railScale(size.w, size.h);
  const targets = useMemo(() => radialLayout(set, RING_RADIUS * scale), [set, scale]);

  // The drawn layout lives in a ref: the render loop mutates it 60 times a
  // second and a `useState` per frame would re-run every memo above.
  const layoutRef = useRef<LocalLayout>(EMPTY_LAYOUT);
  const rafRef = useRef<number | null>(null);

  const pump = useCallback(() => {
    if (rafRef.current !== null) return;
    const step = () => {
      rafRef.current = null;
      layoutRef.current = advanceLayout(layoutRef.current, performance.now());
      setFrame((f) => f + 1);
      if (!layoutRef.current.settled) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // The diff. This is the navigation animation: nothing here rebuilds.
  useEffect(() => {
    const prev = layoutRef.current.nodes.size === 0 ? null : layoutRef.current;
    layoutRef.current = diffLayout(prev, set, targets, performance.now(), {
      recenterMs: reduced ? 0 : RECENTER_MS,
      enterMs: reduced ? 0 : ENTER_MS,
    });
    setFrame((f) => f + 1);
    pump();
  }, [set, targets, reduced, pump]);

  // d = 3 only: the force simulation supplies targets to the same engine.
  //
  // The Worker's lifetime is keyed on DEPTH ALONE — one spawn on entering depth
  // 3, one dispose on leaving. Progressive neighbourhood expansion gives `set`
  // and `targets` a fresh identity per fetched batch; feeding those in through
  // `updateData` (which is built to MERGE a later page into the running layout,
  // reheating to alpha 0.5 rather than restarting) keeps the same physics worker
  // instead of spawning and terminating one per batch.
  const physicsRef = useRef<PhysicsHandle | null>(null);
  // The subscribe callback below runs for the life of the worker, so it reads
  // the CURRENT node id order from a ref rather than closing over one batch's.
  const physicsIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (depth < PHYSICS_DEPTH) return () => {};
    let handle: PhysicsHandle;
    try {
      handle = new PhysicsHandle({ forces: railForces(controls, scale) });
    } catch {
      return () => {}; // no Worker (jsdom, or a browser without one): keep the rings
    }
    physicsRef.current = handle;
    const stop = handle.subscribe((store) => {
      const latest = store.latest;
      if (latest === null) return;
      const ids = physicsIdsRef.current;
      const next = new Map<string, Point>();
      for (let i = 0; i < ids.length && i < latest.n; i += 1) {
        next.set(ids[i]!, { x: latest.xy[2 * i]!, y: latest.xy[2 * i + 1]! });
      }
      layoutRef.current = retargetLayout(layoutRef.current, next, performance.now(), 0);
      pump();
    });
    handle.start();
    return () => {
      stop();
      handle.dispose();
      physicsRef.current = null;
      physicsIdsRef.current = [];
    };
    // controls/scale are read once for the INITIAL forces; later changes flow
    // through the setForces effect below without respawning the worker.
  }, [depth, pump]);

  // Force sliders and rail scale move the SAME worker, never recreate it.
  useEffect(() => {
    if (depth < PHYSICS_DEPTH) return;
    physicsRef.current?.setForces(railForces(controls, scale));
  }, [depth, controls, scale]);

  // Feed each neighbourhood — including every progressive-expansion batch — into
  // the running simulation. `updateData` merges into the layout on screen, so
  // this is a reseed, not a Worker restart.
  useEffect(() => {
    const handle = physicsRef.current;
    if (!handle || depth < PHYSICS_DEPTH || set.nodes.length === 0) return;
    const ids = set.nodes.map((n) => n.id);
    const seed = new Float32Array(ids.length * 2);
    ids.forEach((id, i) => {
      const p = targets.get(id) ?? { x: 0, y: 0 };
      seed[2 * i] = p.x;
      seed[2 * i + 1] = p.y;
    });
    physicsIdsRef.current = ids;
    handle.updateData({ nodeCount: ids.length, links: physicsLinks(set), seed });
    const focusIndex = ids.indexOf(set.focus);
    if (focusIndex >= 0) handle.pin(focusIndex, 0, 0); // pinned WITHOUT drag: it still settles
  }, [depth, set, targets]);

  const layout = layoutRef.current;
  const hue = (t: string | null) => typeHue(t, theme);
  const titleFont = `${TITLE_FS}px ${fontFamily}`;
  const verbFont = `${VERB_FS}px ${fontFamily}`;
  const cx = size.w / 2;
  const cy = size.h / 2;

  // Fit the drawn extent into the rail rather than clipping it — the rings are
  // sized for the reference rail, and a narrow one must shrink, not truncate.
  let extent = 1;
  for (const n of layout.nodes.values()) extent = Math.max(extent, Math.hypot(n.x, n.y));
  const fit = Math.min(1, (Math.min(size.w, size.h) / 2 - 30) / extent);
  const at = (n: PlacedNode) => ({ x: cx + n.x * fit, y: cy + n.y * fit });

  const byId = useMemo(() => new Map(set.nodes.map((n) => [n.id, n])), [set]);
  const radiusOf = (id: string): number => {
    if (id === set.focus) return FOCUS_R;
    const d = byId.get(id)?.degree ?? 0;
    return Math.min(9, 4.2 + Math.sqrt(d) * 0.9);
  };
  // At the rail's thumbnail size a dense neighbourhood cannot carry a label per
  // node without the titles piling into mush. So when there are more neighbours
  // than fit legibly, only the focus and whatever is hovered are named — the
  // rest stay reachable by their `<title>` tooltip and by hovering. A sparse
  // neighbourhood still labels its immediate ring.
  const dense = set.nodes.length - 1 > 8;
  const labelled = (id: string): boolean =>
    id === set.focus || hover === id || (!dense && (byId.get(id)?.hop ?? 9) <= 1);

  // The phone rail. Rather than draw an unreadable 340px graph and call it
  // responsive, say what is there and let a thumb ask for it — an explicit
  // entry point, sized like something you are meant to hit.
  if (collapsed) {
    const count = Math.max(0, set.nodes.length - 1);
    return (
      <div ref={wrapRef} className="touch-chrome">
        <div className="mb-2 text-[11px] font-semibold tracking-wide text-dim uppercase">
          Connections
        </div>
        <button
          type="button"
          onClick={() => setOpened(true)}
          aria-expanded={false}
          className="touch-target flex w-full items-center justify-between gap-3 rounded-none border border-line-soft bg-hover px-3.5 py-3 text-left text-[13px] text-ink"
        >
          <span>View connections</span>
          <span className="text-[12px] text-dim">
            {loading && count === 0 ? "…" : count === 0 ? "none yet" : count}
          </span>
        </button>
        <button
          type="button"
          onClick={() => navigate(fullGraphHref(object.id, clampDepth(prefs.depth)))}
          className="touch-target mt-1.5 w-full text-left text-[12px] text-dim"
        >
          or open the full graph →
        </button>
      </div>
    );
  }

  if (set.nodes.length <= 1 && !loading) {
    return (
      <div ref={wrapRef}>
        <Header
          depth={depth}
          prefs={prefs}
          setPrefs={setPrefs}
          onFullGraph={() => navigate(fullGraphHref(object.id, depth))}
        />
        <div className="rounded-none border border-line-soft bg-hover px-4 py-4 text-[12.5px] text-dim">
          No links yet — link this to another object and the map draws itself.
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={coarse ? "touch-chrome" : undefined}>
      <Header
        depth={depth}
        prefs={prefs}
        setPrefs={setPrefs}
        onFullGraph={() => navigate(fullGraphHref(object.id, depth))}
        {...(opened ? { onCollapse: () => setOpened(false) } : {})}
      />

      <svg
        viewBox={`0 0 ${size.w} ${size.h}`}
        width={size.w}
        height={size.h}
        style={{ width: "100%", height: size.h, maxWidth: "100%" }}
        className="select-none"
        role="img"
        aria-label={`Local graph: ${set.nodes.length - 1} connected objects within ${depth} hop${depth === 1 ? "" : "s"}`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <marker
            id="lg-arrow"
            viewBox="0 0 8 8"
            refX="6.5"
            refY="4"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
          </marker>
        </defs>

        {set.edges.map((e) => {
          const a = layout.nodes.get(e.a);
          const b = layout.nodes.get(e.b);
          if (a === undefined || b === undefined) return null;
          const from = e.dir === "in" ? at(b) : at(a);
          const to = e.dir === "in" ? at(a) : at(b);
          const tint = hue(byId.get(e.dir === "in" ? e.a : e.b)?.type ?? null);
          const alpha = Math.min(a.alpha, b.alpha);
          const lit = e.atFocus || hover === e.a || hover === e.b;
          // Verbs only on hover, never for every focus edge at once: two edges
          // leaving the focus node put their midpoint labels side by side and
          // they collide into a single run ("motivated bycustomer"). Hovering an
          // endpoint reveals that one edge's verb, cleanly.
          const showVerb = e.rel !== "" && (hover === e.a || hover === e.b);
          const [ex, ey] = shorten(
            from.x,
            from.y,
            to.x,
            to.y,
            radiusOf(e.dir === "in" ? e.a : e.b) + 3,
          );
          return (
            <g key={`${e.a}|${e.b}|${e.rel}`} opacity={alpha}>
              <line
                x1={from.x}
                y1={from.y}
                x2={ex}
                y2={ey}
                stroke={tint}
                strokeWidth={lit ? 1.5 : 1}
                strokeOpacity={lit ? 0.55 : 0.24}
                markerEnd="url(#lg-arrow)"
              />
              {showVerb && (
                <text
                  x={(from.x + to.x) / 2}
                  y={(from.y + to.y) / 2 - 3}
                  textAnchor="middle"
                  className="fill-[var(--dim)]"
                  style={{ fontSize: VERB_FS }}
                >
                  {fitText(e.rel.replace(/_/g, " "), 88, verbFont)}
                </text>
              )}
            </g>
          );
        })}

        {[...layout.nodes.values()].map((n) => {
          const node = byId.get(n.id);
          const p = at(n);
          const r = radiusOf(n.id);
          const isFocus = n.id === set.focus;
          return (
            <g
              key={n.id}
              opacity={n.alpha}
              transform={`translate(${p.x} ${p.y}) scale(${0.6 + 0.4 * n.alpha})`}
              className={isFocus ? "" : "focus-ring cursor-pointer"}
              // A connected object is a link, so it is reachable and operable by
              // keyboard, not pointer-only: Enter/Space opens it, exactly as a
              // click does. The focus node is the current page — not a target.
              {...(isFocus
                ? {}
                : {
                    tabIndex: 0,
                    role: "link",
                    "aria-label": `Open ${labelTextFor(node?.title ?? null, n.id)}`,
                    onKeyDown: (e: ReactKeyboardEvent<SVGGElement>) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/o/${n.id}`);
                      }
                    },
                  })}
              onMouseEnter={() => setHover(n.id)}
              onClick={() => {
                if (isFocus) return;
                // Touch has no hover, so the first tap does what hovering did
                // — name the node and light its verbs — and the second one
                // navigates. One tap taking you off the page you are reading,
                // to something you could not read the label of, is the way
                // touch graphs lose people.
                if (coarse && hover !== n.id) {
                  setHover(n.id);
                  return;
                }
                navigate(`/o/${n.id}`);
              }}
            >
              {coarse && !isFocus && (
                <circle cx={0} cy={0} r={TOUCH_HIT_R} fill="transparent" aria-hidden />
              )}
              <circle
                cx={0}
                cy={0}
                r={r}
                fill={hue(node?.type ?? null)}
                stroke={isFocus ? "var(--panel)" : "transparent"}
                strokeWidth={isFocus ? 2.5 : 0}
              />
              {labelled(n.id) && node !== undefined && (
                <text
                  x={0}
                  y={r + TITLE_FS}
                  textAnchor="middle"
                  className="fill-[var(--ink)]"
                  style={{ fontSize: TITLE_FS, fontWeight: isFocus ? 600 : 400 }}
                >
                  {fitText(labelTextFor(node.title, node.id), 118, titleFont)}
                </text>
              )}
              <title>{labelTextFor(node?.title ?? null, n.id)}</title>
            </g>
          );
        })}
      </svg>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-dim">
        <span>
          {set.nodes.length - 1} within {depth} hop{depth === 1 ? "" : "s"}
        </span>
        <span className="opacity-50">·</span>
        <span>{set.edges.length} links</span>
        {loading && <span className="opacity-70">· expanding…</span>}
        {partial && !loading && <span className="opacity-70">· partially expanded</span>}
        {set.overflow > 0 && (
          <button
            type="button"
            onClick={() => navigate(fullGraphHref(object.id, depth))}
            className="rounded-none border border-line-soft px-1.5 py-px transition-colors hover:text-ink"
            title="Open the full graph focused on this object"
          >
            +{set.overflow} more
          </button>
        )}
      </div>
    </div>
  );
}

function Header({
  depth,
  prefs,
  setPrefs,
  onFullGraph,
  onCollapse,
}: {
  depth: number;
  prefs: LocalGraphPrefs;
  setPrefs: (patch: Partial<LocalGraphPrefs>) => void;
  onFullGraph: () => void;
  /** Present only on a phone rail the reader opened by hand — the way back. */
  onCollapse?: () => void;
}) {
  const chip = (active: boolean) =>
    [
      "rounded-none border px-1.5 py-px text-[11px] transition-colors",
      active ? "border-line-strong bg-hover text-ink" : "border-line-soft text-dim hover:text-ink",
    ].join(" ");

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] font-semibold tracking-wide text-dim uppercase">
          Connections
        </div>
        <div className="flex items-center gap-3">
          {onCollapse !== undefined && (
            <button
              type="button"
              onClick={onCollapse}
              className="touch-target text-[11px] text-dim transition-colors hover:text-ink"
            >
              hide
            </button>
          )}
          <button
            type="button"
            onClick={onFullGraph}
            className="text-[11px] text-dim transition-colors hover:text-ink"
          >
            full graph →
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-[11px] text-dim">depth</span>
        {[1, 2, 3].map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={depth === d}
            onClick={() => setPrefs({ depth: d })}
            className={chip(depth === d)}
          >
            {d}
          </button>
        ))}
        <span className="mx-1 opacity-40">·</span>
        <button
          type="button"
          aria-pressed={prefs.outgoing}
          onClick={() => setPrefs({ outgoing: !prefs.outgoing })}
          className={chip(prefs.outgoing)}
          title="Follow links out of this object"
        >
          out
        </button>
        <button
          type="button"
          aria-pressed={prefs.incoming}
          onClick={() => setPrefs({ incoming: !prefs.incoming })}
          className={chip(prefs.incoming)}
          title="Follow links into this object"
        >
          in
        </button>
        <button
          type="button"
          aria-pressed={neighborLinksOn(prefs)}
          onClick={() => setPrefs({ neighborLinks: !neighborLinksOn(prefs) })}
          className={chip(neighborLinksOn(prefs))}
          title="Draw links between neighbours, not just back to this object"
        >
          neighbour links
        </button>
      </div>
    </div>
  );
}

function shorten(x1: number, y1: number, x2: number, y2: number, pad: number): [number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  return [x2 - (dx / len) * pad, y2 - (dy / len) * pad];
}
