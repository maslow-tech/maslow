/**
 * ONE dimming system, used by all five things that dim the graph.
 *
 * The graph has five features that all want to say "these nodes matter right
 * now, everything else recede": hover neighborhood isolation, shortest path,
 * search, the orphans filter, and the time scrubber. Written five times that is
 * five sets of tween state that fight each other — hover a node while a search
 * is active and you get two competing opacity animations on the same sprite,
 * which is exactly how graph UIs end up feeling broken. So there is one
 * `HighlightSet` type (from `types.ts`), one controller that owns every alpha,
 * and one set of constructors that build the sets. Features choose membership;
 * they never animate.
 *
 * ## Hover neighborhood isolation (the committed behaviour)
 *
 * On hover, members = the node itself + its one-hop neighbours, computed off
 * the CSR (`neighborsOf` is a subarray view — no allocation per mouse move).
 * Non-members tween to **alpha 0.12 over 120–150ms ease-out**, and back up over
 * **200ms**. The asymmetry is deliberate and is the whole feel of the thing:
 * dimming fast makes the neighborhood *snap* into focus, while restoring slowly
 * keeps the graph from strobing as the pointer crosses empty space between two
 * nodes. Equal durations read as twitchy; the reverse reads as sluggish.
 *
 * ## How the tween is implemented (and why it is not per-node tween objects)
 *
 * One `Float32Array` of current alphas, advanced toward each node's target with
 * an exponential approach (`k = 1 - exp(-dt / tau)`), which is:
 *
 *  - **ease-out by construction** — fast at the start, asymptotic at the end;
 *  - **frame-rate independent** — a dropped frame produces the same curve,
 *    where a per-frame constant step silently runs 2× fast at 120Hz;
 *  - **allocation-free** — no tween objects, no per-node closures, nothing for
 *    the GC to collect at 60Hz;
 *  - **interruption-safe** — swapping the highlight set mid-flight just changes
 *    the targets; every node continues from where it actually is, which is why
 *    sweeping the pointer across a dense cluster never snaps.
 *
 * Each node picks its own duration from its own direction of travel (falling =
 * the 140ms enter, rising = the 200ms exit), so the asymmetry holds even when
 * one set replaces another and some nodes go up while others go down.
 *
 * ## Edges
 *
 * Edges inherit `min(alpha(a), alpha(b))` and are additionally knocked down by
 * a single scalar when the active set names its own edges (path, hover), so a
 * path reads as a path rather than as "everything between the lit nodes". The
 * lit/not-lit membership itself swaps instantly on a set change while the
 * scalar tweens — one scalar instead of a per-edge tween map. Edges are hairs;
 * nobody has ever noticed an edge changing class in one frame, and the map
 * would cost an allocation per edge per hover.
 *
 * ## Reduced motion
 *
 * `prefers-reduced-motion: reduce` collapses every duration to 0 (states are
 * still correct, they just arrive immediately) and freezes the scrubber pulse
 * at full strength. It is checked through an injectable predicate because these
 * are canvas pixels, not CSS — a global `* { transition: none }` reset cannot
 * reach them, exactly as with the camera easing in `GraphView`.
 */

import { edgeKey, neighborsOf } from "./csr";
import type { Csr, HighlightKind, HighlightSet } from "./types";

/** Committed: non-members fall this far during hover isolation. */
export const HOVER_DIM_ALPHA = 0.12;

/** Committed: fall over 120–150ms (ease-out), rise back over 200ms. */
export const HIGHLIGHT_ENTER_MS = 140;
export const HIGHLIGHT_EXIT_MS = 200;

/**
 * How far non-members fall, per kind. These are not five arbitrary numbers:
 *
 *  - `hover` / `path` isolate — you asked a question about a subgraph, and the
 *    answer is only readable if everything else gets out of the way (0.12).
 *  - `search` deliberately dims LESS. The old view's "dim to 0.2" hid the
 *    context that makes a match meaningful; a search result you cannot place in
 *    the graph is a list, and we already have lists. Matches carry a halo and a
 *    forced label, so they stand out without erasing their surroundings.
 *  - `changed` (the time scrubber) recedes rather than hides — the point is
 *    watching the brain GROW against its existing shape.
 *  - `selection` barely dims at all: a selection is a thing you are about to
 *    act on, and you need to see what you did NOT select to correct it.
 */
export const DIM_ALPHA: Record<HighlightKind, number> = {
  hover: HOVER_DIM_ALPHA,
  path: HOVER_DIM_ALPHA,
  search: 0.45,
  changed: 0.35,
  selection: 0.55,
};

/** A `HighlightSet` with the right dim alpha for its kind. */
export function makeHighlightSet(
  kind: HighlightKind,
  nodes: ReadonlySet<number>,
  edges: ReadonlySet<number> = new Set<number>(),
  dimAlpha = DIM_ALPHA[kind],
): HighlightSet {
  return { kind, nodes, edges, dimAlpha };
}

// ---------------------------------------------------------------------------
// set constructors — features choose membership, nothing else
// ---------------------------------------------------------------------------

/** The BFS ball around `index`, plus the edges that reached it. */
interface Neighborhood {
  readonly nodes: Set<number>;
  /** `edgeKey(a, b)` for each traversed edge (the tree edges of the BFS). */
  readonly edges: Set<number>;
  /** hop count per member — the rail's radial layout rings ride on this. */
  readonly depth: Map<number, number>;
}

/**
 * Undirected BFS ball of radius `depth` (1 for hover; the rail's local graph
 * runs the same walk at 1–3). `includeInternalEdges` adds the edges BETWEEN
 * members that the tree walk did not traverse — the rail's "show neighbour
 * links" toggle, which is what reveals that two of your neighbours know each
 * other.
 *
 * Costs one queue and two sets; no allocation per neighbour (the CSR hands back
 * a subarray view of its own storage).
 */
export function neighborhood(
  csr: Csr,
  index: number,
  depth = 1,
  includeInternalEdges = false,
): Neighborhood {
  const nodes = new Set<number>();
  const edges = new Set<number>();
  const depths = new Map<number, number>();
  if (index < 0 || index >= csr.n || depth < 0) return { nodes, edges, depth: depths };

  nodes.add(index);
  depths.set(index, 0);
  let frontier: number[] = [index];

  for (let d = 0; d < depth; d += 1) {
    const next: number[] = [];
    for (const u of frontier) {
      const ns = neighborsOf(csr, u);
      for (let k = 0; k < ns.length; k += 1) {
        const v = ns[k]!;
        edges.add(edgeKey(u, v));
        if (nodes.has(v)) continue;
        nodes.add(v);
        depths.set(v, d + 1);
        next.push(v);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  if (includeInternalEdges) {
    for (const u of nodes) {
      const ns = neighborsOf(csr, u);
      for (let k = 0; k < ns.length; k += 1) {
        const v = ns[k]!;
        if (nodes.has(v)) edges.add(edgeKey(u, v));
      }
    }
  }

  return { nodes, edges, depth: depths };
}

/** Hover isolation: the node + its one-hop neighbours, non-members at 0.12. */
export function hoverHighlight(csr: Csr, index: number): HighlightSet | null {
  if (index < 0 || index >= csr.n) return null;
  const hood = neighborhood(csr, index, 1);
  return makeHighlightSet("hover", hood.nodes, hood.edges);
}

/**
 * Shortest path(s): every node on every returned path is lit, every hop is lit,
 * everything else isolates. Takes the paths (as dense-index sequences) rather
 * than computing them — the bidirectional search lives with the other CSR
 * traversals, and this file stays about *dimming*.
 */
export function pathHighlight(paths: readonly (readonly number[])[]): HighlightSet {
  const nodes = new Set<number>();
  const edges = new Set<number>();
  for (const path of paths) {
    for (let i = 0; i < path.length; i += 1) {
      nodes.add(path[i]!);
      if (i > 0) edges.add(edgeKey(path[i - 1]!, path[i]!));
    }
  }
  return makeHighlightSet("path", nodes, edges);
}

/**
 * Search matches: halo + forced label + a gentle dim on everything else. No
 * edge set — a search result is a set of objects, not a subgraph, and lighting
 * the edges between two coincidentally-matching nodes asserts a relationship
 * the query never claimed.
 */
export function searchHighlight(matches: Iterable<number>): HighlightSet {
  return makeHighlightSet("search", new Set(matches));
}

/**
 * The orphans filter: visible degree 0. It rides the "search" kind on purpose —
 * it is a query result, and it wants exactly the search treatment (labels
 * forced on, context still visible), because the whole point is reading off the
 * names of things to go and link.
 *
 * "Orphan" means orphan *as far as this viewer can see*: the CSR is built from
 * the visible subgraph, and an object whose only link is to something private
 * is legitimately an orphan here. The UI copy says so — see the spec's
 * visible-only-degree rule.
 */
export function orphanHighlight(csr: Csr): HighlightSet {
  const nodes = new Set<number>();
  for (let i = 0; i < csr.n; i += 1) {
    if (csr.offsets[i + 1]! - csr.offsets[i]! === 0) nodes.add(i);
  }
  return makeHighlightSet("search", nodes);
}

/**
 * The time scrubber: nodes created/updated inside the window glow and pulse,
 * the rest recede. The caller has already intersected the event feed with the
 * viewer's visible node set (the feed carries no RLS — see the spec), so by the
 * time indices reach here they are all nodes this viewer was given.
 */
export function changedHighlight(indices: Iterable<number>): HighlightSet {
  return makeHighlightSet("changed", new Set(indices));
}

/** Box-select / shift-click. Internal edges are lit so a cluster reads as one. */
export function selectionHighlight(csr: Csr, indices: Iterable<number>): HighlightSet {
  const nodes = new Set(indices);
  const edges = new Set<number>();
  for (const u of nodes) {
    const ns = neighborsOf(csr, u);
    for (let k = 0; k < ns.length; k += 1) {
      const v = ns[k]!;
      if (nodes.has(v)) edges.add(edgeKey(u, v));
    }
  }
  return makeHighlightSet("selection", nodes, edges);
}

/**
 * Which members get their label forced on (see `selectLabels`'s `forced`).
 * Search and selection name things you asked for by name, so they are useless
 * unnamed; hover already shows a tooltip and a path labels its own hops.
 */
export function forcedLabels(set: HighlightSet | null): ReadonlySet<number> | undefined {
  if (set === null) return undefined;
  return set.kind === "search" || set.kind === "selection" ? set.nodes : undefined;
}

// ---------------------------------------------------------------------------
// the controller — the only thing in the app that owns a node alpha
// ---------------------------------------------------------------------------

interface HighlightControllerOptions {
  /** ms for a node falling to its dim alpha (committed 120–150). */
  readonly enterMs?: number | undefined;
  /** ms for a node rising back to full (committed 200). */
  readonly exitMs?: number | undefined;
  /** injectable so tests are deterministic; defaults to the media query. */
  readonly reducedMotion?: (() => boolean) | undefined;
  /** injectable clock; defaults to `performance.now()`. */
  readonly now?: (() => number) | undefined;
}

/** Below this distance from target we snap and call the tween settled. */
const EPSILON = 0.002;

/** Pulse period for the time scrubber's glow, in ms. */
const PULSE_MS = 1600;

function defaultReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Owns every node's current alpha and hands it to the renderer and the label
 * overlay. Drive it from the render loop:
 *
 * ```ts
 * const animating = controller.advance();      // once per frame
 * sprite.alpha = controller.nodeAlpha(i);      // per node
 * ```
 *
 * `advance` returns false once everything has settled, which is what lets a
 * settled graph stop requesting frames and cost ~0% CPU.
 */
export class HighlightController {
  private alpha: Float32Array;
  private active: HighlightSet | null = null;
  /** eased 0→1 toward "the active set's own edge list is authoritative". */
  private edgeMix = 0;
  private settled = true;
  private last: number | null = null;

  private readonly enterMs: number;
  private readonly exitMs: number;
  private readonly reducedMotion: () => boolean;
  private readonly nowFn: () => number;

  constructor(n = 0, options: HighlightControllerOptions = {}) {
    this.alpha = new Float32Array(Math.max(0, n)).fill(1);
    this.enterMs = options.enterMs ?? HIGHLIGHT_ENTER_MS;
    this.exitMs = options.exitMs ?? HIGHLIGHT_EXIT_MS;
    this.reducedMotion = options.reducedMotion ?? defaultReducedMotion;
    this.nowFn = options.now ?? defaultNow;
  }

  /** Node count this controller covers. */
  get size(): number {
    return this.alpha.length;
  }

  get current(): HighlightSet | null {
    return this.active;
  }

  /** True while any alpha is still moving. */
  get animating(): boolean {
    return !this.settled;
  }

  /**
   * Grow (or shrink) to `n` nodes. New nodes start fully lit and then tween
   * down if the active set excludes them — a page landing mid-hover fades in
   * correctly instead of popping to 0.12.
   */
  resize(n: number): void {
    const next = Math.max(0, n);
    if (next === this.alpha.length) return;
    const grown = new Float32Array(next).fill(1);
    grown.set(this.alpha.subarray(0, Math.min(next, this.alpha.length)));
    this.alpha = grown;
    this.settled = false;
  }

  /**
   * Install a set (or `null` to release the dimming entirely). Interrupting a
   * running tween is expected and cheap: only the targets change.
   */
  set(set: HighlightSet | null): void {
    if (set === this.active) return;
    this.active = set;
    this.settled = false;
    if (this.reducedMotion()) this.finish();
  }

  /** Release the dimming (pointer left a node, search cleared). */
  clear(): void {
    this.set(null);
  }

  /** Everything lit, no set, no tween in flight. */
  reset(): void {
    this.active = null;
    this.alpha.fill(1);
    this.edgeMix = 0;
    this.settled = true;
    this.last = null;
  }

  /**
   * Advance the tweens to `now`. Returns true while still animating, so the
   * caller keeps requesting frames only while something is actually moving.
   */
  advance(now: number = this.nowFn()): boolean {
    if (this.settled) {
      this.last = now;
      return false;
    }
    if (this.reducedMotion()) {
      this.finish();
      this.last = now;
      return false;
    }
    const prev = this.last;
    this.last = now;
    // First frame after a set() has no dt yet; do not integrate a bogus one
    // (a large dt from a backgrounded tab would jump straight to the target).
    if (prev === null) return true;
    const dt = Math.min(100, Math.max(0, now - prev));
    if (dt === 0) return true;

    const set = this.active;
    const dim = set === null ? 1 : set.dimAlpha;
    // tau = duration / 3 lands within ~5% of the target at `duration`, which is
    // what "over 140ms" means for an asymptotic curve.
    const kDown = 1 - Math.exp((-dt * 3) / this.enterMs);
    const kUp = 1 - Math.exp((-dt * 3) / this.exitMs);

    let moving = false;
    const a = this.alpha;
    for (let i = 0; i < a.length; i += 1) {
      const target = set === null || set.nodes.has(i) ? 1 : dim;
      const cur = a[i]!;
      const delta = target - cur;
      if (Math.abs(delta) < EPSILON) {
        if (cur !== target) a[i] = target;
        continue;
      }
      a[i] = cur + delta * (delta < 0 ? kDown : kUp);
      moving = true;
    }

    const edgeTarget = set !== null && set.edges.size > 0 ? 1 : 0;
    const edgeDelta = edgeTarget - this.edgeMix;
    if (Math.abs(edgeDelta) < EPSILON) {
      this.edgeMix = edgeTarget;
    } else {
      this.edgeMix += edgeDelta * (edgeDelta > 0 ? kDown : kUp);
      moving = true;
    }

    this.settled = !moving;
    return moving;
  }

  /** Jump every tween to its final value (reduced motion, or a hard cut). */
  finish(): void {
    const set = this.active;
    const dim = set === null ? 1 : set.dimAlpha;
    for (let i = 0; i < this.alpha.length; i += 1) {
      this.alpha[i] = set === null || set.nodes.has(i) ? 1 : dim;
    }
    this.edgeMix = set !== null && set.edges.size > 0 ? 1 : 0;
    this.settled = true;
  }

  /** Current alpha of a node. Out-of-range reads as fully lit, never NaN. */
  nodeAlpha(index: number): number {
    return this.alpha[index] ?? 1;
  }

  /** Is this node in the active set? (No set ⇒ everything is "in".) */
  isMember(index: number): boolean {
    return this.active === null || this.active.nodes.has(index);
  }

  /**
   * Alpha for the undirected edge (a, b): it inherits the dimmer of its two
   * endpoints, and is additionally held DOWN to the dim level when the active
   * set names its own edges and this is not one of them — the path case, where
   * two path nodes joined by an edge that is not a hop must not draw a bright
   * line and claim to be part of the answer.
   *
   * It is a floor (`min`), not a multiplier: multiplying would compound with
   * the endpoint dimming and take the far-away edges to 0.014, erasing the
   * surrounding structure that isolation is supposed to keep as context.
   */
  edgeAlpha(a: number, b: number): number {
    const base = Math.min(this.nodeAlpha(a), this.nodeAlpha(b));
    const set = this.active;
    if (set === null || this.edgeMix <= 0) return base;
    if (set.edges.has(edgeKey(a, b))) return base;
    const knock = 1 + (set.dimAlpha - 1) * this.edgeMix;
    return Math.min(base, knock);
  }

  /**
   * 0→1→0 oscillation for the time scrubber's glow. Frozen at 1 under reduced
   * motion: a pulsing node is the point of the feature, so it becomes a steady
   * glow rather than disappearing.
   */
  pulse(now: number = this.nowFn()): number {
    if (this.reducedMotion()) return 1;
    return 0.5 - 0.5 * Math.cos((2 * Math.PI * (now % PULSE_MS)) / PULSE_MS);
  }
}
