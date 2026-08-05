/**
 * The graph store: a graphology graph plus the dense index maps every hot path
 * addresses nodes by.
 *
 * graphology carries the things it is genuinely good at — attributes, directed
 * edges with parallel verbs, degree, BFS, connected components — and the dense
 * maps carry the things it is not: a position buffer, a CSR walk and a spatial
 * hash all want `i`, not a uuid.
 *
 * Three rules make this file worth having:
 *
 *  1. **Ingest MERGES a page, it never rebuilds.** The whole-brain load is
 *     cursor-paged (5,000 rows a page) and the client paints progressively, so
 *     page 4 must not invalidate the layout page 1 has been settling for three
 *     seconds. A node already present keeps its dense index forever; only new
 *     nodes append. Rebuilding is exactly what makes homegrown graphs feel
 *     cheap.
 *  2. **An edge naming an unknown node is DROPPED.** Never a synthesized
 *     placeholder node — a placeholder would re-create precisely the
 *     hidden-neighbour hint the visible-only-degree rule exists to prevent
 *     (the server returns an edge only when BOTH endpoints are visible, and
 *     counts degree over visible edges only; a client that drew "something is
 *     over there" would hand back the leak in the UI layer). This is not only a
 *     privacy rule: the server emits each edge on the page carrying its
 *     higher-id endpoint, so under the documented contract both endpoints have
 *     ALREADY arrived and a dangling edge means the row is genuinely gone
 *     (deleted or made private mid-walk) — there is nothing legitimate to draw.
 *     Drops are counted and returned so the UI can surface churn honestly
 *     rather than silently.
 *  3. **Re-ingesting the same page is a no-op.** Pages are retried (network
 *     wobble, a resumed cursor); nodes restate their attributes and edges are
 *     keyed by `from|to|rel`, so a retry never doubles a degree or a line.
 */

import Graph from "graphology";
import type { Attributes } from "graphology-types";

import type { GraphEdge, GraphNode, GraphPage } from "./types";

/** Node attributes held on the graphology graph. */
interface GraphNodeAttributes extends Attributes {
  title: string | null;
  type: string | null;
  /** the SERVER's visible-only degree — see `GraphNode.degree`. */
  degree: number;
}

/** Edge attributes held on the graphology graph. */
interface GraphEdgeAttributes extends Attributes {
  rel: string;
}

/** What one `ingest` call actually did. Every number is surfaceable in the UI. */
interface IngestStats {
  nodesAdded: number;
  /** already present; attributes refreshed, dense index untouched. */
  nodesUpdated: number;
  edgesAdded: number;
  /** already present under the same from|to|rel key — a retry, not a change. */
  edgesRepeated: number;
  /** referenced a node this client was never given (rule 2). */
  edgesDropped: number;
  /** an object linked to itself: nothing to draw, and it would double a degree. */
  selfLoopsDropped: number;
}

function emptyStats(): IngestStats {
  return {
    nodesAdded: 0,
    nodesUpdated: 0,
    edgesAdded: 0,
    edgesRepeated: 0,
    edgesDropped: 0,
    selfLoopsDropped: 0,
  };
}

/**
 * The key an edge is stored under. `from|to|rel` (NUL-separated, since a uuid
 * and a verb both survive it) makes a retry idempotent while still allowing two
 * different verbs between the same pair to be two edges.
 */
function edgeIdOf(e: Pick<GraphEdge, "from" | "to" | "rel">): string {
  return `${e.from}\u0000${e.to}\u0000${e.rel}`;
}

export class GraphStore {
  /**
   * Directed (arrowheads and the rail's in/out toggles need it) and multi
   * (two verbs between the same pair are two edges). Self-loops are refused by
   * the graph itself; `ingest` drops them before they get here, so the option
   * documents the intent rather than throwing at runtime.
   */
  readonly graph: Graph<GraphNodeAttributes, GraphEdgeAttributes>;

  /** uuid → dense index. Stable for the life of a node in this store. */
  readonly idToIndex = new Map<string, number>();

  /** dense index → uuid. Append-only; `indexToId.length` is the node count. */
  readonly indexToId: string[] = [];

  private rev = 0;

  constructor() {
    this.graph = new Graph<GraphNodeAttributes, GraphEdgeAttributes>({
      type: "directed",
      multi: true,
      allowSelfLoops: false,
    });
  }

  /** Node count. */
  get order(): number {
    return this.indexToId.length;
  }

  /** Edge count (parallel verbs counted separately). */
  get size(): number {
    return this.graph.size;
  }

  /**
   * Bumped by any ingest that actually changed something. A `Csr`, a position
   * buffer or a `HighlightSet` computed at revision r is stale at r+1 —
   * indices still resolve (they never move), the derived structure just does
   * not know about the new rows.
   */
  get revision(): number {
    return this.rev;
  }

  has(id: string): boolean {
    return this.idToIndex.has(id);
  }

  /** Dense index of `id`, or undefined if this client was never given it. */
  indexOf(id: string): number | undefined {
    return this.idToIndex.get(id);
  }

  /** uuid at a dense index, or undefined when out of range. */
  idAt(index: number): string | undefined {
    return this.indexToId[index];
  }

  /** The node at a dense index, rebuilt from graph attributes. */
  nodeAt(index: number): GraphNode | undefined {
    const id = this.indexToId[index];
    if (id === undefined) return undefined;
    const a = this.graph.getNodeAttributes(id);
    return { id, title: a.title, type: a.type, degree: a.degree };
  }

  /** The node with this id, or undefined. */
  node(id: string): GraphNode | undefined {
    const index = this.idToIndex.get(id);
    return index === undefined ? undefined : this.nodeAt(index);
  }

  /**
   * Merge one page of `GET /api/v1/graph`.
   *
   * Order within the page does not matter: every node in the page is admitted
   * before any edge is considered, so an edge between two nodes that both
   * arrive in THIS page is kept.
   */
  ingest(page: GraphPage): IngestStats {
    const stats = emptyStats();

    for (const n of page.nodes) {
      const existing = this.idToIndex.get(n.id);
      if (existing === undefined) {
        const index = this.indexToId.length;
        this.idToIndex.set(n.id, index);
        this.indexToId.push(n.id);
        this.graph.addNode(n.id, {
          title: n.title ?? null,
          type: n.type ?? null,
          degree: Number.isFinite(n.degree) ? n.degree : 0,
        });
        stats.nodesAdded += 1;
      } else {
        // A restated node (retry, or the same object seen again): refresh the
        // attributes — degree in particular grows as pages land — and leave the
        // dense index exactly where it is.
        this.graph.mergeNodeAttributes(n.id, {
          title: n.title ?? null,
          type: n.type ?? null,
          degree: Number.isFinite(n.degree) ? n.degree : 0,
        });
        stats.nodesUpdated += 1;
      }
    }

    for (const e of page.edges) {
      if (!this.idToIndex.has(e.from) || !this.idToIndex.has(e.to)) {
        stats.edgesDropped += 1;
        continue;
      }
      if (e.from === e.to) {
        stats.selfLoopsDropped += 1;
        continue;
      }
      const key = edgeIdOf(e);
      if (this.graph.hasEdge(key)) {
        stats.edgesRepeated += 1;
        continue;
      }
      this.graph.addDirectedEdgeWithKey(key, e.from, e.to, { rel: e.rel });
      stats.edgesAdded += 1;
    }

    if (stats.nodesAdded > 0 || stats.nodesUpdated > 0 || stats.edgesAdded > 0) {
      this.rev += 1;
    }
    return stats;
  }

  /**
   * Drop everything. Used when the viewer changes filters (a different visible
   * set entirely) or signs out — never between pages of one walk. Indices from
   * before a clear are meaningless afterwards, hence the revision bump.
   */
  clear(): void {
    this.graph.clear();
    this.idToIndex.clear();
    this.indexToId.length = 0;
    this.rev += 1;
  }
}
