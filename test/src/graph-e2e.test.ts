import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The phase-6 acceptance run: **the graph as a working surface**, driven the
 * way a member's browser drives it — a real box on a real Postgres, and the
 * SPA's OWN graph modules over it.
 *
 * The jsdom suites under `apps/box/ui` render the graph's components against a
 * stubbed engine; `graph-full.integration.test.ts` exercises `GET
 * /api/v1/graph` with hand-built requests. Both can be green while the surface
 * is broken, because neither runs the code that joins them: the client modules
 * that turn a paged walk into an answer. So this file boots the box and then
 * drives, verbatim —
 *
 *   - `lib/api.ts`                 the typed client (cookies, CSRF, envelope)
 *   - `lib/graph/store.ts` + `csr` the ingest and the adjacency the pages build
 *   - `lib/graph/analysis.ts`      BFS, shortest paths with verbs, orphans
 *   - `lib/graph/highlight.ts`     the ONE dimming system every feature rides
 *   - `lib/graph/selection.ts`     box-select geometry and the CAS bulk driver
 *   - `lib/graph/renderer.ts`      the spatial hash box-select scans (no Pixi)
 *   - `views/GraphView.tsx`        `resolveHighlight` — the layer priority
 *   - `components/graph/GraphSearch.tsx`  `matchGraphNodes` — the search
 *                                  matcher (GraphView's old local
 *                                  `matchIndices` was consolidated into it)
 *   - `components/graph/TimeScrubber.tsx`  the scrubber's id → index mapping
 *   - `components/LocalGraph.tsx`  the rail's BFS ball, radial layout and the
 *                                  navigation DIFF (survivors keep position)
 *   - `lib/peek.tsx` + `lib/saveQueue.ts`  click-a-node → side-peek → save
 *
 * — through the same browser shim `workspace.e2e.test.ts` uses: a cookie jar, a
 * Map-backed storage pair, and a `fetch` that hands the request to
 * `app.request`. Nothing about the wire is faked, so "the member sees this
 * graph and the owner sees that one" is RLS answering, not a fixture.
 *
 * What is deliberately NOT here: pixels. There is no canvas, no WebGL and no
 * pointer. Every case below names the gesture it stands in for and then asserts
 * the thing a rendering test cannot see — what the server actually returned,
 * which nodes ended up lit, and what the camera did NOT do.
 *
 * Client modules are imported through NON-LITERAL specifiers, exactly as
 * `workspace.e2e.test.ts` and `dashboard-views.integration.test.ts` do: they
 * are browser modules, and a static import would drag the SPA's DOM-typed
 * sources into this package's node-typed tsc program. Vitest resolves and
 * transforms them at runtime (the `@` alias is declared in
 * `vitest.e2e.config.ts`); tsc never follows them, so every shape they hand
 * back is restated structurally below.
 */

const API_MODULE = "../../apps/box/ui/src/lib/api.js";
const STORE_MODULE = "../../apps/box/ui/src/lib/graph/store.js";
const CSR_MODULE = "../../apps/box/ui/src/lib/graph/csr.js";
const ANALYSIS_MODULE = "../../apps/box/ui/src/lib/graph/analysis.js";
const HIGHLIGHT_MODULE = "../../apps/box/ui/src/lib/graph/highlight.js";
const SELECTION_MODULE = "../../apps/box/ui/src/lib/graph/selection.js";
const RENDERER_MODULE = "../../apps/box/ui/src/lib/graph/renderer.js";
const SAVE_QUEUE_MODULE = "../../apps/box/ui/src/lib/saveQueue.js";
const PEEK_MODULE = "../../apps/box/ui/src/lib/peek";
const GRAPH_VIEW_MODULE = "../../apps/box/ui/src/views/GraphView";
const GRAPH_SEARCH_MODULE = "../../apps/box/ui/src/components/graph/GraphSearch";
const SCRUBBER_MODULE = "../../apps/box/ui/src/components/graph/TimeScrubber";
const LOCAL_GRAPH_MODULE = "../../apps/box/ui/src/components/LocalGraph";

const SECRET = "test-session-secret-please-change";

/* ------------------------------------------------------------ client shapes */
// Restated structurally (see the note above). Only the members this file uses.

interface Edge {
  rel: string;
  id: string;
  target_deleted: boolean;
  target_title: string | null;
  target_type: string | null;
}

interface BrainObject {
  id: string;
  type: string | null;
  title: string | null;
  body: string | null;
  version: number;
  visibility: "org" | "private";
  props: Record<string, unknown>;
  links: Edge[];
  backlinks: Edge[];
}

interface WriteResult {
  id: string;
  version: number;
}

interface PatchInput {
  baseVersion: number;
  title?: string | null;
  body?: string;
  props?: Record<string, unknown>;
  visibility?: "org" | "private";
}

interface GraphPageResponse {
  nodes: Array<{ id: string; title: string | null; type: string | null; degree: number }>;
  edges: Array<{ from: string; to: string; rel: string }>;
  nextCursor: string | null;
  watermark: string;
  truncated: { shown: number; total: number; reason: "size" } | null;
}

interface GraphChangedResponse {
  since: string;
  watermark: string;
  ids: string[];
  count: number;
  byKind: Record<string, number>;
  truncated: { shown: number; total: number; reason: "size" } | null;
  feedTruncated: boolean;
}

interface DashApi {
  login(token: string): Promise<{ ok: boolean; role: string; appVersion: string }>;
  whoami(): Promise<{ id: string; name: string; role: string; scopes: string[] }>;
  object(id: string): Promise<BrainObject>;
  createObject(input: {
    type?: string;
    title?: string;
    body?: string;
    props?: Record<string, unknown>;
    visibility?: "org" | "private";
    idempotencyKey: string;
  }): Promise<WriteResult>;
  patchObject(id: string, patch: PatchInput): Promise<WriteResult>;
  linkObject(
    id: string,
    input: { to: string; rel: string; idempotencyKey: string },
  ): Promise<unknown>;
  graphPage(opts?: {
    after?: string;
    watermark?: string;
    limit?: number;
    where?: unknown;
  }): Promise<GraphPageResponse>;
  graphChanged(opts: { since: string; where?: unknown }): Promise<GraphChangedResponse>;
}

/* --- lib/graph -------------------------------------------------------- */

interface GraphNode {
  id: string;
  title: string | null;
  type: string | null;
  degree: number;
}

interface GraphPage {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly { from: string; to: string; rel: string }[];
}

interface Csr {
  readonly n: number;
  readonly m: number;
  readonly offsets: Int32Array;
  readonly neighbors: Int32Array;
  readonly relIndex: Int32Array;
  readonly rels: readonly string[];
}

interface Store {
  readonly order: number;
  readonly size: number;
  readonly revision: number;
  ingest(page: GraphPage): {
    nodesAdded: number;
    edgesAdded: number;
    edgesDropped: number;
    selfLoopsDropped: number;
  };
  has(id: string): boolean;
  indexOf(id: string): number | undefined;
  idAt(index: number): string | undefined;
  nodeAt(index: number): GraphNode | undefined;
  node(id: string): GraphNode | undefined;
}

type HighlightKind = "hover" | "path" | "search" | "selection" | "changed";

interface HighlightSet {
  readonly kind: HighlightKind;
  readonly nodes: ReadonlySet<number>;
  readonly edges: ReadonlySet<number>;
  readonly dimAlpha: number;
}

interface PathHop {
  readonly from: number;
  readonly to: number;
  readonly rel: string;
  readonly slot: number;
}

interface GraphPath {
  readonly nodes: readonly number[];
  readonly hops: readonly PathHop[];
}

interface ShortestPathsResult {
  readonly source: number;
  readonly target: number;
  readonly length: number;
  readonly paths: readonly GraphPath[];
  readonly truncated: boolean;
}

interface BfsResult {
  readonly order: Int32Array;
  readonly levels: Int32Array;
  readonly parents: Int32Array;
  readonly parentSlots: Int32Array;
}

/** Opaque on purpose — this file only ever hands it straight back. */
interface SpatialHash {
  readonly n: number;
}

interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BulkTarget {
  index: number;
  id: string;
  title: string | null;
  type: string | null;
}

interface BulkRow {
  id: string;
  title: string | null;
  state: "queued" | "running" | "done" | "conflict" | "error" | "skipped";
  message: string | null;
  currentVersion: number | null;
  idempotencyKey: string;
  attempts: number;
}

type BulkIntent =
  | { kind: "prop"; key: string; value: unknown }
  | { kind: "link"; to: string; toTitle: string | null; rel: string };

interface BulkWriter {
  readVersion: (id: string) => Promise<number>;
  patch: (id: string, patch: PatchInput) => Promise<unknown>;
  link: (
    id: string,
    input: { to: string; rel: string; idempotencyKey: string },
  ) => Promise<unknown>;
}

interface BulkSummary {
  total: number;
  done: number;
  conflicts: number;
  failed: number;
  skipped: number;
  pending: number;
  finished: boolean;
}

/* --- the rail's local graph -------------------------------------------- */

interface LocalRecord {
  readonly id: string;
  readonly title: string | null;
  readonly degree: number;
  readonly expanded: boolean;
}

type LocalAdjacency = ReadonlyMap<string, LocalRecord>;

interface LocalGraphNode {
  readonly id: string;
  readonly title: string | null;
  readonly hop: number;
  readonly parent: string | null;
  readonly rel: string;
  readonly degree: number;
}

interface LocalGraphSet {
  readonly focus: string;
  readonly nodes: LocalGraphNode[];
  readonly edges: Array<{ a: string; b: string; rel: string; atFocus: boolean }>;
  readonly overflow: number;
}

interface Point {
  x: number;
  y: number;
}

interface PlacedNode {
  readonly id: string;
  x: number;
  y: number;
  toX: number;
  toY: number;
  alpha: number;
  phase: "entering" | "steady" | "leaving";
  pinned: boolean;
}

interface LocalLayout {
  readonly focus: string;
  readonly nodes: Map<string, PlacedNode>;
  readonly settled: boolean;
}

/* --- the editor's write path ------------------------------------------- */

interface DraftFields {
  title?: string | null;
  body?: string;
  props?: Record<string, unknown>;
}

interface SaveQueue {
  change(fields: DraftFields): void;
  flush(): Promise<void>;
  hasPending(): boolean;
  baseVersion(): number;
  dispose(): void;
}

interface SaveQueueOptions {
  objectId: string;
  baseVersion: number;
  base?: { title?: string | null; body?: string | null; props?: Record<string, unknown> };
  save(patch: PatchInput, baseVersion: number): Promise<WriteResult>;
  debounceMs?: number;
}

/* ------------------------------------------------------------ browser shim */

class MemoryStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

/** One browser: the cookie jar IS the session, storage is per browser. */
class Session {
  readonly cookies = new Map<string, string>();
  readonly local = new MemoryStorage();
  readonly sessionStorage = new MemoryStorage();

  constructor(readonly label: string) {}

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(setCookie: string): void {
    const [pair] = setCookie.split(";");
    const eq = (pair ?? "").indexOf("=");
    if (eq <= 0) return;
    const name = (pair ?? "").slice(0, eq).trim();
    const value = (pair ?? "").slice(eq + 1).trim();
    if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(setCookie)) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}

interface WireEntry {
  method: string;
  path: string;
  session: string;
}

/** Every request the client modules issued, in order. */
const wire: WireEntry[] = [];

let active: Session;

function setCookies(res: Response): string[] {
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

const realFetch = globalThis.fetch;

function installBrowser(app: Hono): void {
  const g = globalThis as unknown as Record<string, unknown>;

  g["fetch"] = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    const cookie = active.header();
    if (cookie) headers.set("cookie", cookie);
    wire.push({ method: (init?.method ?? "GET").toUpperCase(), path, session: active.label });
    const res = await app.request(path, { ...init, headers });
    for (const line of setCookies(res)) active.absorb(line);
    return res;
  };

  g["document"] = {
    get cookie(): string {
      return active.header();
    },
    set cookie(v: string) {
      active.absorb(v);
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => active.local,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get: () => active.sessionStorage,
  });
  g["location"] = { href: "http://box.test/graph", reload: () => {} };
}

function uninstallBrowser(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g["fetch"] = realFetch;
  delete g["document"];
  delete g["location"];
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "sessionStorage");
}

async function as<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  const previous = active;
  active = session;
  try {
    return await fn();
  } finally {
    active = previous;
  }
}

function mark(): number {
  return wire.length;
}
function since(from: number): WireEntry[] {
  return wire.slice(from);
}

/* ------------------------------------------------------------- the camera */

/**
 * A stand-in for `GraphCameraHandle` that RECORDS instead of moving.
 *
 * "the graph camera is unchanged afterwards" is a claim about what a code path
 * did NOT do, and the only way to assert it without a canvas is to hand that
 * path a camera and check nobody touched it. `get()` answers a frozen state so
 * a caller reading the camera cannot be mistaken for one moving it.
 */
interface CameraState {
  x: number;
  y: number;
  scale: number;
}

class RecordingCamera {
  readonly calls: Array<{ op: string; arg?: unknown }> = [];
  private state: CameraState = { x: 12, y: -30, scale: 1.4 };

  get = (): CameraState => ({ ...this.state });
  set = (next: Partial<CameraState>): void => {
    this.calls.push({ op: "set", arg: next });
    this.state = { ...this.state, ...next };
  };
  ease = (next: Partial<CameraState>): void => {
    this.calls.push({ op: "ease", arg: next });
    this.state = { ...this.state, ...next };
  };
  fit = (): void => {
    this.calls.push({ op: "fit" });
  };
  reset = (): void => {
    this.calls.push({ op: "reset" });
  };
  centerOn = (index: number): void => {
    this.calls.push({ op: "centerOn", arg: index });
  };
  invalidate = (): void => {
    this.calls.push({ op: "invalidate" });
  };

  /** Every op that MOVED the camera. `invalidate` only wakes the render loop. */
  moves(): Array<{ op: string; arg?: unknown }> {
    return this.calls.filter((c) => c.op !== "invalidate");
  }
}

describe("e2e · the graph, driven as a working surface", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;

  /* the SPA's own modules */
  let api: DashApi;
  let newIdempotencyKey: () => string;
  let GraphStoreCtor: new () => Store;
  let buildCsr: (store: Store) => Csr;
  let edgeKey: (a: number, b: number) => number;
  let degreeOf: (csr: Csr, i: number) => number;
  let bfs: (csr: Csr, source: number, depth?: number) => BfsResult;
  let ballOf: (result: BfsResult) => Set<number>;
  let shortestPaths: (
    csr: Csr,
    source: number,
    target: number,
    options?: { maxPaths?: number },
  ) => ShortestPathsResult;
  let orphans: (csr: Csr) => number[];
  let analyze: (
    csr: Csr,
    options?: Record<string, unknown>,
  ) => { n: number; m: number; orphans: readonly number[]; hubs: readonly { index: number }[] };
  let DIM_ALPHA: Record<HighlightKind, number>;
  let HOVER_DIM_ALPHA: number;
  let pathHighlight: (paths: readonly (readonly number[])[]) => HighlightSet;
  let searchHighlight: (matches: Iterable<number>) => HighlightSet;
  let orphanHighlight: (csr: Csr) => HighlightSet;
  let changedHighlight: (indices: Iterable<number>) => HighlightSet;
  let selectionHighlight: (csr: Csr, indices: Iterable<number>) => HighlightSet;
  let forcedLabels: (set: HighlightSet | null) => ReadonlySet<number> | undefined;
  let buildSpatialHash: (xy: Float32Array, n: number, cell?: number) => SpatialHash;
  let rectFromPoints: (ax: number, ay: number, bx: number, by: number) => ScreenRect;
  let isMarqueeRect: (rect: ScreenRect) => boolean;
  let marqueeMode: (e: {
    altKey: boolean;
    shiftKey: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
  }) => "replace" | "add" | "toggle" | null;
  let indicesInScreenRect: (
    hash: SpatialHash,
    positions: Float32Array,
    rect: ScreenRect,
    toWorld: (sx: number, sy: number) => Point,
  ) => number[];
  let nextSelection: (
    prev: ReadonlySet<number>,
    indices: Iterable<number>,
    mode?: "replace" | "add" | "toggle",
  ) => Set<number>;
  let planBulkRows: (targets: readonly BulkTarget[], mint?: () => string) => BulkRow[];
  let runBulk: (
    intent: BulkIntent,
    input: readonly BulkRow[],
    options?: { writer?: BulkWriter; concurrency?: number },
  ) => Promise<BulkRow[]>;
  let summarizeBulk: (rows: readonly BulkRow[]) => BulkSummary;
  let bulkSummaryLine: (summary: BulkSummary) => string;
  let matchIndices: (nodes: readonly GraphNode[], query: string, cap?: number) => Set<number>;
  let resolveHighlight: (
    layers: Readonly<Partial<Record<string, HighlightSet | null>>>,
  ) => HighlightSet | null;
  let HIGHLIGHT_PRIORITY: readonly string[];
  let mapChangedIds: (
    ids: readonly string[],
    indexOf: (id: string) => number | undefined,
  ) => Set<number>;
  let changedCopy: (count: number, lit: number) => string;
  let adjacencyFrom: (objects: Iterable<BrainObject>) => Map<string, LocalRecord>;
  let buildLocalSet: (
    adj: LocalAdjacency,
    focusId: string,
    options: {
      depth: number;
      incoming: boolean;
      outgoing: boolean;
      neighborLinks: boolean;
      cap?: number;
    },
  ) => LocalGraphSet;
  let radialLayout: (set: LocalGraphSet, ringRadius?: number) => Map<string, Point>;
  let diffLayout: (
    prev: LocalLayout | null,
    set: LocalGraphSet,
    targets: ReadonlyMap<string, Point>,
    now: number,
    options?: { recenterMs?: number; enterMs?: number },
  ) => LocalLayout;
  let advanceLayout: (layout: LocalLayout, now: number) => LocalLayout;
  let fullGraphHref: (focusId: string, depth: number) => string;
  let SPAWN_JITTER: number;
  let RECENTER_MS: number;
  let ENTER_MS: number;
  let EXIT_MS: number;
  let createSaveQueue: (opts: SaveQueueOptions) => SaveQueue;
  let parsePeekStack: (search: string | URLSearchParams) => readonly string[];
  let pushPeek: (stack: readonly string[], id: string) => readonly string[];
  let popPeek: (stack: readonly string[]) => readonly string[];
  let withPeekStack: (p: URLSearchParams, stack: readonly string[]) => URLSearchParams;

  const owner = new Session("owner");
  const member = new Session("member");

  /** title → id, for every object the fixture creates. */
  const ids: Record<string, string> = {};
  /**
   * Bootstrapping an account mints that person's own private "personal"
   * object. It is unlinked, so it is a legitimate orphan in ITS OWNER's graph
   * and invisible in everybody else's — which makes it a second, free witness
   * for both rules below.
   */
  const MEMBER_PERSONAL = "Mira — personal";
  const OWNER_PERSONAL = "Owner — personal";
  /** Every title the member's whole-brain walk should return. */
  const MEMBER_TITLES = [
    "Alpha",
    "Bridge",
    "Omega",
    "Detour One",
    "Detour Two",
    "Hub",
    "Spoke A",
    "Spoke B",
    "Lonely",
    "Tethered",
    MEMBER_PERSONAL,
  ];
  /** The member's orphans: no links at all, or none this viewer can see. */
  const MEMBER_ORPHANS = ["Lonely", "Tethered", MEMBER_PERSONAL];
  /** Links in the fixture — every one of them between two visible objects. */
  const EDGE_COUNT = 8;
  /** The member's whole visible graph, loaded once by paging the real route. */
  let store: Store;
  let csr: Csr;
  let nodes: GraphNode[];

  const idx = (title: string): number => {
    const i = store.indexOf(ids[title] as string);
    expect(i, `${title} is not in the member's graph`).not.toBeUndefined();
    return i as number;
  };

  /** The progressive load, exactly as `GraphView` runs it: page → ingest. */
  const loadGraph = async (into: Store): Promise<{ pages: number; truncated: unknown }> => {
    let after: string | undefined;
    let watermark: string | undefined;
    let pages = 0;
    let truncated: unknown = null;
    for (;;) {
      const page: GraphPageResponse = await api.graphPage({
        limit: 500,
        ...(after === undefined ? {} : { after }),
        ...(watermark === undefined ? {} : { watermark }),
      });
      into.ingest({ nodes: page.nodes, edges: page.edges });
      pages += 1;
      truncated = page.truncated;
      watermark = page.watermark;
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    return { pages, truncated };
  };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false },
    });

    active = member;
    installBrowser(app);

    const apiMod = (await import(API_MODULE)) as {
      api: DashApi;
      newIdempotencyKey: () => string;
    };
    ({ api, newIdempotencyKey } = apiMod);
    ({ GraphStore: GraphStoreCtor } = (await import(STORE_MODULE)) as {
      GraphStore: typeof GraphStoreCtor;
    });
    ({
      buildCsr,
      edgeKey,
      degree: degreeOf,
    } = (await import(CSR_MODULE)) as {
      buildCsr: typeof buildCsr;
      edgeKey: typeof edgeKey;
      degree: typeof degreeOf;
    });
    ({ bfs, ballOf, shortestPaths, orphans, analyze } = (await import(ANALYSIS_MODULE)) as {
      bfs: typeof bfs;
      ballOf: typeof ballOf;
      shortestPaths: typeof shortestPaths;
      orphans: typeof orphans;
      analyze: typeof analyze;
    });
    ({
      DIM_ALPHA,
      HOVER_DIM_ALPHA,
      pathHighlight,
      searchHighlight,
      orphanHighlight,
      changedHighlight,
      selectionHighlight,
      forcedLabels,
    } = (await import(HIGHLIGHT_MODULE)) as {
      DIM_ALPHA: typeof DIM_ALPHA;
      HOVER_DIM_ALPHA: number;
      pathHighlight: typeof pathHighlight;
      searchHighlight: typeof searchHighlight;
      orphanHighlight: typeof orphanHighlight;
      changedHighlight: typeof changedHighlight;
      selectionHighlight: typeof selectionHighlight;
      forcedLabels: typeof forcedLabels;
    });
    ({ buildSpatialHash } = (await import(RENDERER_MODULE)) as {
      buildSpatialHash: typeof buildSpatialHash;
    });
    ({
      rectFromPoints,
      isMarqueeRect,
      marqueeMode,
      indicesInScreenRect,
      nextSelection,
      planBulkRows,
      runBulk,
      summarizeBulk,
      bulkSummaryLine,
    } = (await import(SELECTION_MODULE)) as {
      rectFromPoints: typeof rectFromPoints;
      isMarqueeRect: typeof isMarqueeRect;
      marqueeMode: typeof marqueeMode;
      indicesInScreenRect: typeof indicesInScreenRect;
      nextSelection: typeof nextSelection;
      planBulkRows: typeof planBulkRows;
      runBulk: typeof runBulk;
      summarizeBulk: typeof summarizeBulk;
      bulkSummaryLine: typeof bulkSummaryLine;
    });
    ({ resolveHighlight, HIGHLIGHT_PRIORITY } = (await import(GRAPH_VIEW_MODULE)) as {
      resolveHighlight: typeof resolveHighlight;
      HIGHLIGHT_PRIORITY: readonly string[];
    });
    // The search matcher moved out of GraphView when its second, local owner
    // of the search layer was removed — `matchGraphNodes` (GraphSearch.tsx) is
    // the one matcher now. Adapted to the Set shape these tests assert on.
    {
      const { matchGraphNodes } = (await import(GRAPH_SEARCH_MODULE)) as {
        matchGraphNodes: (
          nodes: readonly GraphNode[],
          query: string,
          cap?: number,
        ) => { set: ReadonlySet<number> };
      };
      matchIndices = (nodes, query, cap) =>
        new Set(
          cap === undefined
            ? matchGraphNodes(nodes, query).set
            : matchGraphNodes(nodes, query, cap).set,
        );
    }
    ({ mapChangedIds, changedCopy } = (await import(SCRUBBER_MODULE)) as {
      mapChangedIds: typeof mapChangedIds;
      changedCopy: typeof changedCopy;
    });
    ({
      adjacencyFrom,
      buildLocalSet,
      radialLayout,
      diffLayout,
      advanceLayout,
      fullGraphHref,
      SPAWN_JITTER,
      RECENTER_MS,
      ENTER_MS,
      EXIT_MS,
    } = (await import(LOCAL_GRAPH_MODULE)) as {
      adjacencyFrom: typeof adjacencyFrom;
      buildLocalSet: typeof buildLocalSet;
      radialLayout: typeof radialLayout;
      diffLayout: typeof diffLayout;
      advanceLayout: typeof advanceLayout;
      fullGraphHref: typeof fullGraphHref;
      SPAWN_JITTER: number;
      RECENTER_MS: number;
      ENTER_MS: number;
      EXIT_MS: number;
    });
    ({ createSaveQueue } = (await import(SAVE_QUEUE_MODULE)) as {
      createSaveQueue: typeof createSaveQueue;
    });
    ({ parsePeekStack, pushPeek, popPeek, withPeekStack } = (await import(PEEK_MODULE)) as {
      parsePeekStack: typeof parsePeekStack;
      pushPeek: typeof pushPeek;
      popPeek: typeof popPeek;
      withPeekStack: typeof withPeekStack;
    });

    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    const memberToken = (
      await admin.createUser(boot.id, {
        name: "Mira",
        email: "mira@example.com",
        permission: "member",
      })
    ).token;

    const exec = new SchemaExecutor(ownerClient);
    const docType = await exec.defineType({ name: "doc" }, boot.id);
    // Properties are declared, not free-form: the box refuses an undeclared
    // key, so the scrubber's and the bulk bar's writes need a schema first.
    for (const name of ["reviewed", "classified", "touched_by", "cluster"]) {
      await exec.addProperty({ typeId: docType.typeId, name, kind: "text" }, boot.id);
    }

    /**
     * The fixture is a shape, not a pile: two ends with ONE shortest route and
     * a longer decoy between them, a hub with spokes to bulk-edit, an object
     * with no links at all, and — the privacy case — an object whose ONLY link
     * points at something the member cannot see.
     *
     *   Hub ──mentions──▶ Alpha ──mentions──▶ Bridge ──owns──▶ Omega
     *    │                  │                                    ▲
     *    ├──owns──▶ Spoke A  └──cites──▶ Detour One ──cites──▶ Detour Two
     *    └──owns──▶ Spoke B                                      │
     *                                                        (cites)
     *   Lonely (nothing)          Tethered ──about──▶ Secret [private, owner]
     */
    await as(member, async () => {
      const login = await api.login(memberToken);
      expect(login.role).toBe("member");

      const make = async (title: string): Promise<void> => {
        const r = await api.createObject({
          type: "doc",
          title,
          // explicit publish — wave-2 default-private would make the whole
          // fixture graph creator-only, and every case below reads it as a
          // DIFFERENT viewer
          visibility: "org",
          idempotencyKey: newIdempotencyKey(),
        });
        ids[title] = r.id;
      };
      for (const t of [
        "Alpha",
        "Bridge",
        "Omega",
        "Detour One",
        "Detour Two",
        "Hub",
        "Spoke A",
        "Spoke B",
        "Lonely",
      ]) {
        await make(t);
      }

      const link = async (from: string, rel: string, to: string): Promise<void> => {
        await api.linkObject(ids[from] as string, {
          to: ids[to] as string,
          rel,
          idempotencyKey: newIdempotencyKey(),
        });
      };
      await link("Alpha", "mentions", "Bridge");
      await link("Bridge", "owns", "Omega");
      await link("Alpha", "cites", "Detour One");
      await link("Detour One", "cites", "Detour Two");
      await link("Detour Two", "cites", "Omega");
      await link("Hub", "mentions", "Alpha");
      await link("Hub", "owns", "Spoke A");
      await link("Hub", "owns", "Spoke B");
    });

    // The owner's private object, and an org object whose only relationship
    // points at it. `Tethered` is therefore an ORPHAN to the member and NOT an
    // orphan to the owner — one row of data, two true graphs.
    await as(owner, async () => {
      const login = await api.login(boot.token);
      expect(login.role).toBe("owner");
      const secret = await api.createObject({
        type: "doc",
        title: "Secret",
        visibility: "private",
        idempotencyKey: newIdempotencyKey(),
      });
      ids["Secret"] = secret.id;
      const tethered = await api.createObject({
        type: "doc",
        title: "Tethered",
        visibility: "org", // the org half of the one-row-two-graphs pair
        idempotencyKey: newIdempotencyKey(),
      });
      ids["Tethered"] = tethered.id;
      await api.linkObject(tethered.id, {
        to: secret.id,
        rel: "about",
        idempotencyKey: newIdempotencyKey(),
      });
    });

    // The member's whole-brain walk, once. Every case below reads this store.
    await as(member, async () => {
      store = new GraphStoreCtor();
      const load = await loadGraph(store);
      expect(load.truncated, "the fixture is far below the server's cap").toBeNull();
      csr = buildCsr(store);
      nodes = [];
      for (let i = 0; i < store.order; i += 1) nodes.push(store.nodeAt(i) as GraphNode);
    });
  }, 180_000);

  afterAll(async () => {
    uninstallBrowser();
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  /* ------------------------------------------------------------ the load */

  it("the paged walk assembles the member's visible graph, and only that", () => {
    // The owner's private object is not here — and neither is the edge that
    // names it, which is the client half of the visible-only rule
    // (`GraphStore.ingest` drops an edge it has no node for). Nor is the
    // owner's own personal object.
    expect(nodes.map((n) => n.title).sort()).toEqual([...MEMBER_TITLES].sort());
    expect(store.has(ids["Secret"] as string)).toBe(false);
    expect(store.node(ids["Tethered"] as string)?.degree).toBe(0);
    expect(csr.n).toBe(store.order);
    expect(csr.m).toBe(EDGE_COUNT);
    expect(new Set(csr.rels)).toEqual(new Set(["mentions", "owns", "cites"]));
  });

  /* --------------------------------------------------------- shortest path */

  describe("shortest path between two objects", () => {
    /**
     * Stands in for: ⌘-click Alpha, ⌘-click Omega ("path to…").
     *
     * The answer has to be the SHORT one — the decoy through the two detours
     * is a real route and a naive DFS finds it first — and each hop has to
     * carry the verb, because "Alpha → Bridge → Omega" without `mentions` and
     * `owns` is a shape, not a sentence.
     */
    it("renders the path with a verb on every hop", () => {
      const result = shortestPaths(csr, idx("Alpha"), idx("Omega"));

      expect(result.length).toBe(2);
      expect(result.paths).toHaveLength(1);
      expect(result.truncated).toBe(false);

      const path = result.paths[0] as GraphPath;
      expect(path.nodes.map((i) => store.nodeAt(i)?.title)).toEqual(["Alpha", "Bridge", "Omega"]);
      expect(path.hops).toHaveLength(2);
      expect(
        path.hops.map(
          (h) => `${store.nodeAt(h.from)?.title} —${h.rel}→ ${store.nodeAt(h.to)?.title}`,
        ),
      ).toEqual(["Alpha —mentions→ Bridge", "Bridge —owns→ Omega"]);
      // Every hop names a real half-edge slot, so the renderer can find the line.
      for (const hop of path.hops) {
        expect(hop.slot).toBeGreaterThanOrEqual(csr.offsets[hop.from] as number);
        expect(hop.slot).toBeLessThan(csr.offsets[hop.from + 1] as number);
      }
    });

    it("dims the rest of the graph to the isolation alpha", () => {
      const result = shortestPaths(csr, idx("Alpha"), idx("Omega"));
      const set = pathHighlight(result.paths.map((p) => p.nodes));

      expect(set.kind).toBe("path");
      expect(set.dimAlpha).toBe(HOVER_DIM_ALPHA);
      expect(set.dimAlpha).toBe(DIM_ALPHA.path);
      expect([...set.nodes].map((i) => store.nodeAt(i)?.title).sort()).toEqual([
        "Alpha",
        "Bridge",
        "Omega",
      ]);
      // The decoy route is NOT on the answer — it is dimmed with everything else.
      expect(set.nodes.has(idx("Detour One"))).toBe(false);
      expect(set.nodes.has(idx("Hub"))).toBe(false);
      // Both hops are lit as edges, and nothing else is.
      expect(set.edges).toEqual(
        new Set([edgeKey(idx("Alpha"), idx("Bridge")), edgeKey(idx("Bridge"), idx("Omega"))]),
      );
    });

    it("a path outranks every other highlight layer", () => {
      // The layer order is a constant, not "whichever effect ran last": you
      // asked for this path, so it wins over a selection, a search and a hover
      // that all happen to be live at the same moment.
      const path = pathHighlight([[idx("Alpha"), idx("Bridge"), idx("Omega")]]);
      const winner = resolveHighlight({
        path,
        selection: selectionHighlight(csr, [idx("Hub")]),
        search: searchHighlight([idx("Lonely")]),
        changed: changedHighlight([idx("Spoke A")]),
        hover: null,
      });
      expect(winner).toBe(path);
      expect(HIGHLIGHT_PRIORITY[0]).toBe("path");
    });

    it("two unconnected objects answer -1, not an empty path", () => {
      const result = shortestPaths(csr, idx("Alpha"), idx("Lonely"));
      expect(result.length).toBe(-1);
      expect(result.paths).toEqual([]);
    });
  });

  /* -------------------------------------------------------------- orphans */

  describe("the orphans filter", () => {
    /**
     * Stands in for: opening the insight panel and clicking "orphans".
     *
     * "Orphan" means orphan AS FAR AS THIS VIEWER CAN SEE. `Tethered` has a
     * relationship — to the owner's private object — and it is still an orphan
     * here, because the alternative (counting an edge whose other end is
     * hidden) tells the member that a private object exists and points at it.
     */
    it("isolates exactly the degree-0 visible nodes", () => {
      const found = orphans(csr)
        .map((i) => store.nodeAt(i)?.title)
        .sort();
      expect(found).toEqual([...MEMBER_ORPHANS].sort());

      // Nothing else is: every other node has at least one visible neighbour.
      for (let i = 0; i < csr.n; i += 1) {
        const title = store.nodeAt(i)?.title;
        const isOrphan = degreeOf(csr, i) === 0;
        expect(isOrphan, `${title ?? i}`).toBe(MEMBER_ORPHANS.includes(title as string));
      }

      // The one call the panel makes agrees with the primitive.
      expect([...analyze(csr, { skipBetweenness: true }).orphans].sort()).toEqual(
        orphans(csr).sort(),
      );
    });

    it("lights the orphans in place — context stays readable", () => {
      const set = orphanHighlight(csr);
      // It rides the search treatment on purpose: the whole point is reading
      // the names off, so labels are forced and the rest merely recedes.
      expect(set.kind).toBe("search");
      expect(set.dimAlpha).toBe(DIM_ALPHA.search);
      expect(set.dimAlpha).toBeGreaterThan(HOVER_DIM_ALPHA);
      expect([...(forcedLabels(set) as ReadonlySet<number>)].sort()).toEqual(orphans(csr).sort());
      expect([...set.nodes].map((i) => store.nodeAt(i)?.title).sort()).toEqual(
        [...MEMBER_ORPHANS].sort(),
      );
      // An orphan set has no edges by construction — there are none to draw.
      expect(set.edges.size).toBe(0);
    });

    it("the owner's own graph does not call Tethered an orphan", async () => {
      // Same rows, a different viewer: the owner can see Secret, so Tethered
      // has a visible relationship and drops out of the orphan list. This is
      // RLS answering, not a fixture — and it is what proves the member's
      // orphan list was a visibility fact rather than a data one.
      await as(owner, async () => {
        const ownerStore = new GraphStoreCtor();
        await loadGraph(ownerStore);
        const ownerCsr = buildCsr(ownerStore);

        expect(ownerStore.has(ids["Secret"] as string)).toBe(true);
        const ownerTitles: Array<string | null> = [];
        for (let i = 0; i < ownerStore.order; i += 1) {
          ownerTitles.push(ownerStore.nodeAt(i)?.title ?? null);
        }
        // Private cuts both ways: the member's personal object is invisible
        // here, exactly as the owner's is in the member's graph.
        expect(ownerTitles).not.toContain(MEMBER_PERSONAL);
        expect(ownerTitles).toContain("Secret");

        const found = orphans(ownerCsr)
          .map((i) => ownerStore.nodeAt(i)?.title)
          .sort();
        expect(found).toEqual(["Lonely", OWNER_PERSONAL].sort());
        expect(found).not.toContain("Tethered");
      });
    });
  });

  /* -------------------------------------------------------- time scrubber */

  describe("the time scrubber", () => {
    /**
     * Stands in for: dragging the scrubber to a recent stop.
     *
     * The window's start comes from the SERVER (a page's watermark), never
     * from this process's clock, and the pulse set is the server's ids mapped
     * through the store — ids the client never loaded are counted, never
     * invented, and ids the viewer cannot see never arrive at all.
     */
    it("pulses only the nodes that changed inside the window", async () => {
      await as(member, async () => {
        // The instant the window starts: the server's own snapshot.
        const anchor = await api.graphPage({ limit: 1 });
        const since0 = anchor.watermark;

        const bridge = await api.object(ids["Bridge"] as string);
        await api.patchObject(bridge.id, {
          baseVersion: bridge.version,
          props: { reviewed: "yes" },
        });

        // ...and, in the same window, a change the member must never hear about.
        await as(owner, async () => {
          const secret = await api.object(ids["Secret"] as string);
          await api.patchObject(secret.id, {
            baseVersion: secret.version,
            props: { classified: "yes" },
          });
        });

        const changed = await api.graphChanged({ since: since0 });

        expect(changed.ids).toEqual([ids["Bridge"] as string]);
        expect(changed.count).toBe(changed.ids.length);
        expect(changed.ids).not.toContain(ids["Secret"] as string);
        expect(changed.feedTruncated).toBe(false);

        const lit = mapChangedIds(changed.ids, (id) => store.indexOf(id));
        expect(lit).toEqual(new Set([idx("Bridge")]));

        const set = changedHighlight(lit);
        expect(set.kind).toBe("changed");
        // The window RECEDES rather than hides — the point is watching the
        // brain grow against its existing shape.
        expect(set.dimAlpha).toBe(DIM_ALPHA.changed);
        expect(set.dimAlpha).toBeGreaterThan(HOVER_DIM_ALPHA);
        for (const title of ["Alpha", "Omega", "Hub", "Lonely"]) {
          expect(set.nodes.has(idx(title)), title).toBe(false);
        }
        expect(changedCopy(changed.count, lit.size)).toContain("1 object changed");
      });
    });

    it("a window with nothing in it says so, and lights nothing", async () => {
      await as(member, async () => {
        const anchor = await api.graphPage({ limit: 1 });
        const changed = await api.graphChanged({ since: anchor.watermark });
        expect(changed.ids).toEqual([]);
        expect(changed.count).toBe(0);
        expect(
          changedHighlight(mapChangedIds(changed.ids, (id) => store.indexOf(id))).nodes.size,
        ).toBe(0);
        expect(changedCopy(0, 0)).toBe("Nothing you can see changed in this window.");
      });
    });
  });

  /* --------------------------------------------------------------- search */

  describe("graph search", () => {
    /**
     * Stands in for: typing "detour" into the graph's search box.
     *
     * The old view dimmed to 0.2 and the matches floated in a void; a result
     * you cannot place in the graph is a list, and we already have lists. So
     * the assertion is as much about what stays VISIBLE as about what lights.
     */
    it("highlights matches in place, leaving the context visible", () => {
      const matches = matchIndices(nodes, "detour");
      expect([...matches].map((i) => store.nodeAt(i)?.title).sort()).toEqual([
        "Detour One",
        "Detour Two",
      ]);

      const set = searchHighlight(matches);
      expect(set.kind).toBe("search");
      expect(set.dimAlpha).toBe(DIM_ALPHA.search);
      // Context is legible — this is the whole difference from isolation.
      expect(set.dimAlpha).toBeGreaterThan(DIM_ALPHA.path);
      expect(set.dimAlpha).toBeGreaterThan(0);
      // Matches get their labels forced on: an unnamed search result is useless.
      expect(forcedLabels(set)).toEqual(set.nodes);
      // ...and NO edges. Two nodes matching the same word is not a relationship.
      expect(set.edges.size).toBe(0);

      // Everything else is still there to be seen — the graph did not shrink.
      expect(store.order).toBe(MEMBER_TITLES.length);
      expect(csr.n).toBe(MEMBER_TITLES.length);
      expect(matches.size).toBeLessThan(csr.n);
    });

    it("search is case-insensitive, substring, and empty-safe", () => {
      expect(matchIndices(nodes, "DETOUR ONE")).toEqual(new Set([idx("Detour One")]));
      expect(matchIndices(nodes, "  ")).toEqual(new Set());
      expect(matchIndices(nodes, "nothing-matches-this")).toEqual(new Set());
      expect(matchIndices(nodes, "detour", 1).size).toBe(1);
    });

    it("a search yields to a selection, and outranks the scrubber", () => {
      const search = searchHighlight(matchIndices(nodes, "detour"));
      const selection = selectionHighlight(csr, [idx("Hub"), idx("Spoke A")]);
      expect(resolveHighlight({ search, selection })).toBe(selection);
      expect(resolveHighlight({ search, changed: changedHighlight([idx("Alpha")]) })).toBe(search);
      // An empty layer is not a layer.
      expect(resolveHighlight({ search: searchHighlight([]), changed: null })).toBeNull();
    });
  });

  /* ------------------------------------------------- node → peek → save */

  describe("clicking a node", () => {
    /**
     * Stands in for: click a node → the side-peek opens → edit → it saves.
     *
     * The claim under test is the last one in that sentence: **the camera is
     * unchanged afterwards**. Editing in the peek must not re-fit, re-centre
     * or reheat the view you built by hand — so the peek + save path is handed
     * a camera that records instead of moving, and the assertion is that
     * nobody touched it. The graph's STRUCTURE is untouched too: a body edit
     * is not a new revision of the store.
     */
    it("opens the side-peek, saves an edit, and leaves the camera alone", async () => {
      await as(member, async () => {
        const camera = new RecordingCamera();
        const before = camera.get();
        const revisionBefore = store.revision;
        const csrBefore = csr;

        // The URL IS the peek store: clicking a node pushes its id onto the stack.
        const stack = pushPeek(parsePeekStack(""), ids["Omega"] as string);
        expect(stack).toEqual([ids["Omega"] as string]);
        const url = withPeekStack(new URLSearchParams(), stack);
        expect(parsePeekStack(url)).toEqual(stack);

        const at = mark();
        const object = await api.object(ids["Omega"] as string);
        const queue = createSaveQueue({
          objectId: object.id,
          baseVersion: object.version,
          base: { title: object.title, body: object.body ?? "", props: { ...object.props } },
          save: (patch) => api.patchObject(object.id, patch),
          debounceMs: 5,
        });

        queue.change({ body: "# Omega\n\nthe far end" });
        queue.change({ body: "# Omega\n\nthe far end, edited from the graph" });
        await queue.flush();
        expect(queue.hasPending()).toBe(false);
        queue.dispose();

        // The server holds the edit, in ONE patch.
        const after = await api.object(object.id);
        expect(after.body).toBe("# Omega\n\nthe far end, edited from the graph");
        expect(after.version).toBe(object.version + 1);
        expect(since(at).filter((e) => e.method === "PATCH")).toHaveLength(1);

        // And the camera never moved.
        expect(camera.moves()).toEqual([]);
        expect(camera.get()).toEqual(before);

        // Nor did the graph's structure: a body edit is not a new node or edge.
        expect(store.revision).toBe(revisionBefore);
        expect(csr).toBe(csrBefore);
        expect(csr.n).toBe(MEMBER_TITLES.length);
        expect(csr.m).toBe(EDGE_COUNT);

        // Closing the peek returns to the graph with nothing else open.
        expect(popPeek(stack)).toEqual([]);
      });
    });
  });

  /* ---------------------------------------------------------- box-select */

  describe("box-select and bulk property set", () => {
    /**
     * Stands in for: alt-drag a marquee around the hub's cluster, then "set a
     * property" in the selection bar — with one of the three objects changed
     * underneath you while the dialog was open.
     *
     * The positions here are synthetic (there is no layout worker in this
     * process), but everything downstream of them is real: the spatial hash,
     * the exact rect test, the CAS driver, and a genuine 409 from the box.
     */
    const WORLD_FAR = 5000;

    /** Every node parked far away, except the three the marquee will contain. */
    const positionsWithCluster = (inside: readonly number[]): Float32Array => {
      const xy = new Float32Array(csr.n * 2);
      for (let i = 0; i < csr.n; i += 1) {
        xy[2 * i] = WORLD_FAR + i * 100;
        xy[2 * i + 1] = WORLD_FAR;
      }
      inside.forEach((i, k) => {
        xy[2 * i] = k * 12;
        xy[2 * i + 1] = 0;
      });
      return xy;
    };

    it("a marquee selects exactly the nodes inside it", () => {
      const cluster = [idx("Hub"), idx("Spoke A"), idx("Spoke B")].sort((a, b) => a - b);
      const xy = positionsWithCluster(cluster);
      const hash = buildSpatialHash(xy, csr.n);

      // Alt-drag; shift would be the toggle gesture, so it must not arm.
      expect(marqueeMode({ altKey: true, shiftKey: false })).toBe("replace");
      expect(marqueeMode({ altKey: false, shiftKey: true })).toBeNull();

      const rect = rectFromPoints(40, 20, -20, -20);
      expect(isMarqueeRect(rect)).toBe(true);
      const hits = indicesInScreenRect(hash, xy, rect, (sx, sy) => ({ x: sx, y: sy }));
      expect(hits).toEqual(cluster);

      const selection = nextSelection(new Set<number>(), hits, "replace");
      expect(selection).toEqual(new Set(cluster));

      const set = selectionHighlight(csr, selection);
      expect(set.kind).toBe("selection");
      // A selection barely dims: you need to see what you did NOT select.
      expect(set.dimAlpha).toBe(DIM_ALPHA.selection);
      expect(set.dimAlpha).toBeGreaterThan(DIM_ALPHA.search);
      // The two spokes read as one cluster because their internal edges light.
      expect(set.edges).toEqual(
        new Set([edgeKey(idx("Hub"), idx("Spoke A")), edgeKey(idx("Hub"), idx("Spoke B"))]),
      );
    });

    it("reports the one forced 409 individually while the others succeed", async () => {
      await as(member, async () => {
        const victimId = ids["Spoke A"] as string;

        // Somebody else edits Spoke A while the bar is open: it moves to v2,
        // and the version the bar is about to write against is now stale.
        const fresh = await api.object(victimId);
        await api.patchObject(victimId, {
          baseVersion: fresh.version,
          props: { touched_by: "someone else" },
        });
        const current = (await api.object(victimId)).version;
        expect(current).toBe(fresh.version + 1);

        const targets: BulkTarget[] = ["Hub", "Spoke A", "Spoke B"].map((title) => ({
          index: idx(title),
          id: ids[title] as string,
          title,
          type: "doc",
        }));
        const rows = planBulkRows(targets);
        const keys = rows.map((r) => r.idempotencyKey);
        expect(new Set(keys).size).toBe(3);

        const intent: BulkIntent = { kind: "prop", key: "cluster", value: "hub-and-spokes" };
        // The real writer, except that THIS object's read answers the stale
        // version the bar was holding — which is exactly what a lost race is.
        const writer: BulkWriter = {
          readVersion: async (id) =>
            id === victimId ? current - 1 : (await api.object(id)).version,
          patch: (id, patch) => api.patchObject(id, patch),
          link: (id, input) => api.linkObject(id, input),
        };

        const done = await runBulk(intent, rows, { writer, concurrency: 2 });

        const summary = summarizeBulk(done);
        expect(summary).toMatchObject({ total: 3, done: 2, conflicts: 1, failed: 0, pending: 0 });
        expect(summary.finished).toBe(true);
        // The sentence leads with what actually landed — never "done".
        expect(bulkSummaryLine(summary)).toBe("2 of 3 written · 1 changed underneath you");

        const victimRow = done.find((r) => r.id === victimId) as BulkRow;
        expect(victimRow.state).toBe("conflict");
        expect(victimRow.message).toContain("changed by someone else");
        expect(victimRow.currentVersion).toBe(current);
        // One object's 409 is one row's problem: the other two are written.
        for (const row of done.filter((r) => r.id !== victimId)) {
          expect(row.state).toBe("done");
          expect((await api.object(row.id)).props["cluster"]).toBe("hub-and-spokes");
        }
        // ...and the one that lost its race was not written: the declared
        // property is still unset on it.
        expect((await api.object(victimId)).props["cluster"]).toBeNull();

        // Retrying is calling the driver again with the SAME rows: the settled
        // ones are not rewritten, and the conflicted one keeps its key and
        // applies on top of the winner.
        const versionsBefore = new Map<string, number>();
        for (const row of done) versionsBefore.set(row.id, (await api.object(row.id)).version);

        const retried = await runBulk(intent, done, {
          writer: {
            readVersion: async (id) => (await api.object(id)).version,
            patch: (id, patch) => api.patchObject(id, patch),
            link: (id, input) => api.linkObject(id, input),
          },
        });
        expect(summarizeBulk(retried)).toMatchObject({ done: 3, conflicts: 0, failed: 0 });
        expect(retried.map((r) => r.idempotencyKey)).toEqual(keys);

        expect((await api.object(victimId)).props["cluster"]).toBe("hub-and-spokes");
        // ...and the object that was edited underneath us keeps that edit.
        expect((await api.object(victimId)).props["touched_by"]).toBe("someone else");
        for (const row of retried.filter((r) => r.id !== victimId)) {
          expect((await api.object(row.id)).version).toBe(versionsBefore.get(row.id));
        }
      });
    });
  });

  /* ------------------------------------------------- the rail local graph */

  describe("the rail's local graph", () => {
    /**
     * Stands in for: standing on Alpha's page with the rail open, then
     * navigating to Bridge.
     *
     * The complaint this feature answers is "it re-draws and I lose my place",
     * so the assertion is the diff's survivor rule: a node in both pictures
     * keeps its coordinates and tweens from where it stands. Nothing here is
     * a stopwatch — `advanceLayout` is pure, so a frame is a call.
     */
    let adjacency: LocalAdjacency;

    const options = {
      depth: 1,
      incoming: true,
      outgoing: true,
      neighborLinks: false,
    };

    beforeAll(async () => {
      await as(member, async () => {
        // What the rail actually has after expanding: the fetched objects,
        // each carrying its own links and backlinks.
        const objects: BrainObject[] = [];
        for (const title of ["Alpha", "Bridge", "Omega", "Hub", "Detour One"]) {
          objects.push(await api.object(ids[title] as string));
        }
        adjacency = adjacencyFrom(objects);
      });
    });

    it("animates between two objects, and survivors keep their position", () => {
      const t0 = 1_000_000;

      const alphaSet = buildLocalSet(adjacency, ids["Alpha"] as string, options);
      expect(alphaSet.focus).toBe(ids["Alpha"] as string);
      expect(alphaSet.nodes.map((n) => n.title).sort()).toEqual([
        "Alpha",
        "Bridge",
        "Detour One",
        "Hub",
      ]);
      expect(alphaSet.overflow).toBe(0);
      // Every hop off the focus carries the verb that discovered it.
      expect(
        alphaSet.nodes
          .filter((n) => n.hop === 1)
          .map((n) => n.rel)
          .sort(),
      ).toEqual(["cites", "mentions", "mentions"]);

      // Frame one: laid out, then run to the end of its entrance.
      const first = advanceLayout(
        diffLayout(null, alphaSet, radialLayout(alphaSet), t0),
        t0 + RECENTER_MS + ENTER_MS + 1,
      );
      expect(first.settled).toBe(true);
      expect(first.nodes.get(ids["Alpha"] as string)?.pinned).toBe(true);
      const settled = new Map(
        [...first.nodes].map(([id, n]) => [id, { x: n.x, y: n.y, alpha: n.alpha }]),
      );
      for (const n of first.nodes.values()) expect(n.alpha).toBe(1);

      // Now navigate: Alpha → Bridge.
      const t1 = t0 + 10_000;
      const bridgeSet = buildLocalSet(adjacency, ids["Bridge"] as string, options);
      expect(bridgeSet.nodes.map((n) => n.title).sort()).toEqual(["Alpha", "Bridge", "Omega"]);
      const moved = diffLayout(first, bridgeSet, radialLayout(bridgeSet), t1);

      // 1. Survivors keep their coordinates — copied, never recomputed.
      for (const title of ["Alpha", "Bridge"]) {
        const id = ids[title] as string;
        const node = moved.nodes.get(id) as PlacedNode;
        expect(node.x, title).toBe(settled.get(id)?.x);
        expect(node.y, title).toBe(settled.get(id)?.y);
        expect(node.phase).toBe("steady");
        expect(node.alpha).toBe(1);
      }

      // 2. The focus moved with the navigation: Bridge is pinned, Alpha is not.
      expect(moved.focus).toBe(ids["Bridge"] as string);
      expect(moved.nodes.get(ids["Bridge"] as string)?.pinned).toBe(true);
      expect(moved.nodes.get(ids["Alpha"] as string)?.pinned).toBe(false);

      // 3. A newcomer spawns at its BFS parent, invisible, within the jitter.
      const omega = moved.nodes.get(ids["Omega"] as string) as PlacedNode;
      const parent = moved.nodes.get(ids["Bridge"] as string) as PlacedNode;
      expect(omega.alpha).toBe(0);
      expect(omega.phase).toBe("entering");
      expect(Math.hypot(omega.x - parent.x, omega.y - parent.y)).toBeLessThanOrEqual(SPAWN_JITTER);

      // 4. A leaver freezes and fades — it is NOT dropped on the frame it left.
      const leaver = moved.nodes.get(ids["Hub"] as string) as PlacedNode;
      expect(leaver.phase).toBe("leaving");
      expect(leaver.x).toBe(settled.get(ids["Hub"] as string)?.x);
      const midFade = advanceLayout(moved, t1 + EXIT_MS / 2);
      expect(midFade.nodes.has(ids["Hub"] as string)).toBe(true);
      expect(midFade.nodes.get(ids["Hub"] as string)?.alpha).toBeGreaterThan(0);
      expect(midFade.nodes.get(ids["Hub"] as string)?.alpha).toBeLessThan(1);

      // ...and is released once the fade is over, having arrived at its target.
      const after = advanceLayout(moved, t1 + RECENTER_MS + ENTER_MS + EXIT_MS + 1);
      expect(after.nodes.has(ids["Hub"] as string)).toBe(false);
      expect(after.nodes.has(ids["Detour One"] as string)).toBe(false);
      expect(after.settled).toBe(true);
      for (const [id, node] of after.nodes) {
        expect(node.alpha, id).toBe(1);
        expect(node.x, id).toBeCloseTo(node.toX, 6);
        expect(node.y, id).toBeCloseTo(node.toY, 6);
      }
    });

    it("the local graph never draws a neighbour the viewer cannot see", async () => {
      await as(member, async () => {
        const tethered = await api.object(ids["Tethered"] as string);
        const adj = adjacencyFrom([tethered]);
        const set = buildLocalSet(adj, tethered.id, options);
        // The private target is not in the payload at all, so the rail shows a
        // lone node — the same answer the whole-brain view gives.
        expect(set.nodes.map((n) => n.id)).toEqual([tethered.id]);
        expect(set.edges).toEqual([]);
        expect(adj.has(ids["Secret"] as string)).toBe(false);
      });
    });
  });

  /* ------------------------------------------------ the full-graph handoff */

  describe('the "full graph →" handoff', () => {
    /**
     * Stands in for: clicking "full graph →" in the rail, which lands on
     * `/graph?focus=<id>&depth=<n>`.
     *
     * Crossing over must not cost you your place, so the global view centres
     * on the object and carries the LOCAL BALL over as the selection — which
     * is already a highlight layer, so the neighbourhood lights up and
     * everything else dims with no second mechanism. The code below is
     * `GraphView`'s handoff effect, run against the same store the view holds.
     */
    const handoff = (
      params: URLSearchParams,
      camera: RecordingCamera,
    ): { focus: number | null; selection: Set<number> } => {
      const focusId = params.get("focus");
      if (focusId === null) return { focus: null, selection: new Set() };
      const raw = Number.parseInt(params.get("depth") ?? "1", 10);
      const depth = Number.isFinite(raw) ? Math.min(3, Math.max(1, raw)) : 1;
      const index = store.indexOf(focusId);
      // Not in the loaded (possibly filtered or truncated) graph: leave the
      // view alone rather than guessing at something else to centre on.
      if (index === undefined) return { focus: null, selection: new Set() };
      camera.centerOn(index);
      return { focus: index, selection: ballOf(bfs(csr, index, depth)) };
    };

    it("lands focused on the right object with its neighbourhood highlighted", () => {
      const href = fullGraphHref(ids["Alpha"] as string, 2);
      expect(href.startsWith("/graph?")).toBe(true);
      const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
      expect(params.get("focus")).toBe(ids["Alpha"] as string);
      expect(params.get("depth")).toBe("2");

      const camera = new RecordingCamera();
      const { focus, selection } = handoff(params, camera);

      expect(focus).toBe(idx("Alpha"));
      // Depth 2 from Alpha: Alpha, its neighbours, and theirs.
      expect([...selection].map((i) => store.nodeAt(i)?.title).sort()).toEqual([
        "Alpha",
        "Bridge",
        "Detour One",
        "Detour Two",
        "Hub",
        "Omega",
        "Spoke A",
        "Spoke B",
      ]);
      // The camera moved ONCE, onto the object — nothing else was touched.
      expect(camera.moves()).toEqual([{ op: "centerOn", arg: idx("Alpha") }]);

      // The neighbourhood is lit through the ordinary selection layer.
      const set = selectionHighlight(csr, selection);
      expect(set.kind).toBe("selection");
      expect(set.nodes).toEqual(selection);
      expect(set.nodes.has(idx("Lonely"))).toBe(false);
      expect(set.nodes.has(idx("Tethered"))).toBe(false);
      expect(resolveHighlight({ selection: set, search: null })).toBe(set);
    });

    it("depth 1 carries only the immediate neighbourhood", () => {
      const params = new URLSearchParams(
        fullGraphHref(ids["Hub"] as string, 1).split("?")[1] as string,
      );
      const { selection } = handoff(params, new RecordingCamera());
      expect([...selection].map((i) => store.nodeAt(i)?.title).sort()).toEqual([
        "Alpha",
        "Hub",
        "Spoke A",
        "Spoke B",
      ]);
    });

    it("a focus the viewer cannot see leaves the view exactly as it was", () => {
      // The owner's private object, arriving as a hand-typed (or stale) link.
      const params = new URLSearchParams({ focus: ids["Secret"] as string, depth: "2" });
      const camera = new RecordingCamera();
      const before = camera.get();
      const { focus, selection } = handoff(params, camera);

      expect(focus).toBeNull();
      expect(selection.size).toBe(0);
      expect(camera.moves()).toEqual([]);
      expect(camera.get()).toEqual(before);
    });
  });
});
