import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphPageResponse } from "../lib/api";
import type { CameraState, Csr, GraphNode, PositionBuffer } from "../lib/graph/types";
import { makeHighlightSet } from "../lib/graph/highlight";

/**
 * What these pin is the view's DATA path and its honesty, not its pixels
 * (WebGL and a layout worker do not exist in jsdom — both are stubbed, which
 * is exactly the seam the engine was built with):
 *
 *  - the whole brain arrives PAGED, page one paints before page two is asked
 *    for, and every later page MERGES rather than rebuilding (dense indices
 *    never move) and reheats to 0.5;
 *  - `truncated` is said out loud in plain words with the filters attached,
 *    and no cursor is followed past it — the one thing this endpoint must
 *    never do is sample silently;
 *  - an edge naming a node the client was never given is DROPPED, never drawn
 *    against a placeholder (that placeholder is the hidden-neighbour hint the
 *    visible-only-degree rule exists to prevent);
 *  - a filter change reloads from page one against the server, because the
 *    truncation copy tells you to filter to see the REST — which a client-side
 *    filter over a truncated set cannot deliver;
 *  - a failed page is an error with a retry, not an empty graph.
 */

const hoisted = vi.hoisted(() => ({
  renderers: [] as Array<{
    graphs: Array<{ nodes: readonly GraphNode[]; csr: Csr | null }>;
    highlights: Array<unknown>;
    /** camera operations, in order — the keyboard's observable effect. */
    ops: string[];
    destroyed: boolean;
  }>,
  physics: [] as Array<{
    data: Array<{ nodeCount: number; links: Int32Array }>;
    reheats: number[];
    disposed: boolean;
    /** the view's position subscriber, so a test can emit a physics tick. */
    emit: ((buffer: PositionBuffer) => void) | null;
  }>,
}));

vi.mock("../lib/graph/renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/graph/renderer")>();
  return {
    ...actual,
    createGraphRenderer: vi.fn(async () => {
      const state = {
        graphs: [],
        highlights: [],
        ops: [],
        destroyed: false,
      } as (typeof hoisted.renderers)[number];
      hoisted.renderers.push(state);
      const camera: CameraState = { x: 0, y: 0, scale: 1 };
      return {
        setGraph: (nodes: readonly GraphNode[], csr: Csr | null) =>
          state.graphs.push({ nodes, csr }),
        setPositions: (_: PositionBuffer) => undefined,
        setHighlight: (h: unknown) => state.highlights.push(h),
        setNodeSizeScale: () => undefined,
        setLinkDistance: () => undefined,
        setTheme: () => undefined,
        getCamera: () => ({ ...camera }),
        setCamera: () => state.ops.push("setCamera"),
        fit: () => state.ops.push("fit"),
        screenToWorld: () => ({ x: 0, y: 0 }),
        worldToScreen: () => ({ x: 0, y: 0 }),
        hitTest: () => null,
        hash: () => ({}) as never,
        positions: () => new Float32Array(0),
        radiusAt: () => 3,
        visibleNodes: () => new Int32Array(0),
        size: () => ({ width: 800, height: 600 }),
        invalidate: () => undefined,
        destroy: () => {
          state.destroyed = true;
        },
      } as unknown as import("../lib/graph/renderer").GraphRenderer;
    }),
  };
});

vi.mock("../lib/graph/physics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/graph/physics")>();
  class FakePhysicsHandle {
    readonly positions = new actual.PositionStore();
    private readonly state: (typeof hoisted.physics)[number];
    constructor() {
      this.state = { data: [], reheats: [], disposed: false, emit: null };
      hoisted.physics.push(this.state);
    }
    subscribe(fn: (store: unknown, event: unknown) => void): () => void {
      // Real handles push a buffer into the store and then notify. The idle
      // breath waits on a SETTLED tick, so a test has to be able to deliver
      // one — hence the store push here rather than a bare callback.
      this.state.emit = (buffer: PositionBuffer) => {
        this.positions.push(buffer);
        fn(this.positions, { settled: buffer.settled } as never);
      };
      return () => {
        this.state.emit = null;
      };
    }
    start(): void {}
    stop(): void {}
    updateData(data: { nodeCount: number; links: Int32Array }): void {
      this.state.data.push({ nodeCount: data.nodeCount, links: data.links });
    }
    setForces(): void {}
    pin(): void {}
    unpin(): void {}
    reheat(alpha?: number): void {
      this.state.reheats.push(alpha ?? 0.5);
    }
    dispose(): void {
      this.state.disposed = true;
    }
  }
  return { ...actual, PhysicsHandle: FakePhysicsHandle };
});

const { api } = await import("../lib/api");
const {
  GraphView,
  GRAPH_PAGE_SIZE,
  filterKey,
  graphWhere,
  resolveHighlight,
  truncationCopy,
  typeCounts,
} = await import("./GraphView");

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: id,
  type: "note",
  degree: 1,
  ...over,
});

const page = (over: Partial<GraphPageResponse> = {}): GraphPageResponse => ({
  nodes: [],
  edges: [],
  nextCursor: null,
  watermark: "2026-07-21T00:00:00.000Z",
  truncated: null,
  ...over,
});

function graphPageMock(pages: GraphPageResponse[]) {
  const calls: Array<Parameters<typeof api.graphPage>[0]> = [];
  const fn = vi.fn(async (opts: Parameters<typeof api.graphPage>[0] = {}) => {
    calls.push(opts);
    const next = pages[calls.length - 1];
    if (next === undefined) throw new Error("graphPage called more times than the test allows");
    return next;
  });
  vi.spyOn(api, "graphPage").mockImplementation(fn as unknown as typeof api.graphPage);
  return calls;
}

function renderGraph() {
  return render(
    <MemoryRouter>
      <GraphView />
    </MemoryRouter>,
  );
}

/** The status line is split across elements — read the whole left rail. */
function statusText(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  hoisted.renderers.length = 0;
  hoisted.physics.length = 0;
  vi.spyOn(api, "types").mockResolvedValue([]);
  // jsdom has no 2D context; the label overlay already degrades to "not
  // available", this only keeps the not-implemented noise out of the output.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pure helpers", () => {
  it("says truncation out loud, in the committed words", () => {
    expect(truncationCopy({ shown: 5000, total: 41208 })).toBe(
      "showing the 5,000 most-connected of 41,208 objects; " +
        "filter by type or date to see the rest",
    );
  });

  it("compiles the filter state into the phase-3 where AST", () => {
    const now = Date.parse("2026-07-21T00:00:00.000Z");
    expect(graphWhere({ types: new Set(), recency: "all" }, now)).toBeUndefined();
    expect(graphWhere({ types: new Set(["note"]), recency: "all" }, now)).toEqual({
      field: "type",
      op: "eq",
      value: "note",
    });
    expect(graphWhere({ types: new Set([null]), recency: "all" }, now)).toEqual({
      field: "type",
      op: "is_null",
    });
    expect(graphWhere({ types: new Set(["note", "person"]), recency: "7d" }, now)).toEqual({
      and: [
        { field: "type", op: "in", value: ["note", "person"] },
        { field: "updated_at", op: "gte", value: "2026-07-14T00:00:00.000Z" },
      ],
    });
  });

  it("keys a filter state stably regardless of set order", () => {
    expect(filterKey({ types: new Set(["b", "a"]), recency: "30d" })).toBe(
      filterKey({ types: new Set(["a", "b"]), recency: "30d" }),
    );
    expect(filterKey({ types: new Set(["a"]), recency: "30d" })).not.toBe(
      filterKey({ types: new Set(["a"]), recency: "7d" }),
    );
  });

  it("counts types for the legend, most-populous first, untyped included", () => {
    expect(
      typeCounts([
        node("1", { type: "note" }),
        node("2", { type: null }),
        node("3", { type: "note" }),
      ]),
    ).toEqual([
      { type: "note", count: 2 },
      { type: null, count: 1 },
    ]);
  });

  it("resolves highlight layers by a fixed priority, ignoring empty ones", () => {
    const hover = makeHighlightSet("hover", new Set([1]));
    const path = makeHighlightSet("path", new Set([2]));
    const emptySearch = makeHighlightSet("search", new Set());
    expect(resolveHighlight({ hover, path })).toBe(path);
    expect(resolveHighlight({ hover, search: emptySearch })).toBe(hover);
    expect(resolveHighlight({})).toBeNull();
  });
});

describe("<GraphView> progressive load", () => {
  it("paints page one, then merges page two and reheats", async () => {
    const calls = graphPageMock([
      page({
        nodes: [node("a"), node("b")],
        edges: [{ from: "a", to: "b", rel: "mentions" }],
        nextCursor: "cursor-1",
      }),
      page({ nodes: [node("c")], edges: [{ from: "b", to: "c", rel: "mentions" }] }),
    ]);

    renderGraph();

    await waitFor(() => expect(calls.length).toBe(2));
    // page one asks for the default page size and carries no cursor …
    expect(calls[0]).toEqual({ limit: GRAPH_PAGE_SIZE });
    // … page two feeds the cursor back AND pins page one's watermark, so the
    // whole walk is served against one snapshot.
    expect(calls[1]).toEqual({
      limit: GRAPH_PAGE_SIZE,
      after: "cursor-1",
      watermark: "2026-07-21T00:00:00.000Z",
    });

    await waitFor(() => expect(statusText()).toContain("3"));
    const renderer = hoisted.renderers[0]!;
    // Page one painted on its own before page two landed.
    const counts = renderer.graphs.map((g) => g.nodes.length);
    expect(counts).toContain(2);
    expect(counts[counts.length - 1]).toBe(3);

    const physics = hoisted.physics[0]!;
    expect(physics.data.map((d) => d.nodeCount)).toEqual([2, 3]);
    // Never alpha(1): a later page reheats an almost-correct layout to 0.5.
    expect(physics.reheats).toContain(0.5);
    expect(physics.reheats).not.toContain(1);
  });

  it("stops at `truncated`, says so in plain words, and follows no cursor", async () => {
    const calls = graphPageMock([
      page({
        nodes: [node("a")],
        // A truncated response hands back no cursor — this one is a trap: even
        // if the server sent one, the client must not walk past the sample.
        nextCursor: "should-not-be-followed",
        truncated: { shown: 5000, total: 41208, reason: "size" },
      }),
    ]);

    renderGraph();

    await waitFor(() =>
      expect(
        screen.getByText(
          "showing the 5,000 most-connected of 41,208 objects; " +
            "filter by type or date to see the rest",
        ),
      ).toBeInTheDocument(),
    );
    expect(calls.length).toBe(1);
  });

  it("drops an edge whose endpoint never arrived instead of drawing a placeholder", async () => {
    graphPageMock([
      page({
        nodes: [node("a"), node("b")],
        edges: [
          { from: "a", to: "b", rel: "mentions" },
          // "ghost" was deleted or made private mid-walk. There is nothing
          // legitimate to draw, and a placeholder would point at it.
          { from: "a", to: "ghost", rel: "mentions" },
        ],
      }),
    ]);

    renderGraph();

    await waitFor(() => expect(hoisted.renderers[0]?.graphs.length).toBeGreaterThan(0));
    const last = hoisted.renderers[0]!.graphs.at(-1)!;
    expect(last.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(last.csr?.n).toBe(2);
    expect(last.csr?.m).toBe(1);
  });

  it("shows the empty state when the visible brain has nothing in it", async () => {
    graphPageMock([page()]);
    renderGraph();
    await waitFor(() =>
      expect(screen.getByText(/the graph appears as objects get linked/i)).toBeInTheDocument(),
    );
  });

  it("surfaces a failed page with a retry rather than an empty graph", async () => {
    vi.spyOn(api, "graphPage").mockRejectedValue(new Error("boom"));
    renderGraph();
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
  });

  it("re-asks the SERVER when the legend filters a type, and restarts the layout", async () => {
    const calls = graphPageMock([
      page({ nodes: [node("a", { type: "note" }), node("b", { type: "person" })] }),
      page({ nodes: [node("a", { type: "note" })] }),
    ]);

    renderGraph();
    await waitFor(() => expect(screen.getByRole("button", { name: /note/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /note/i }));

    // The truncation copy tells you to filter to see the REST, so the filter
    // has to reach the server — a client-side filter over a truncated set
    // cannot deliver what the sentence promises.
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toEqual({
      limit: GRAPH_PAGE_SIZE,
      where: { field: "type", op: "eq", value: "note" },
    });
    // A different visible set means different dense indices, so the worker is
    // replaced rather than inheriting the old graph's positions.
    await waitFor(() => expect(hoisted.physics.length).toBe(2));
    expect(hoisted.physics[0]?.disposed).toBe(true);
  });

  it("drives the camera from the keyboard, and only from the canvas surface", async () => {
    graphPageMock([page({ nodes: [node("a")] })]);
    renderGraph();
    await waitFor(() => expect(hoisted.renderers.length).toBe(1));
    const renderer = hoisted.renderers[0]!;

    const surface = screen.getByRole("application");
    fireEvent.keyDown(surface, { key: "f" });
    expect(renderer.ops).toContain("fit");

    renderer.ops.length = 0;
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(renderer.ops).toContain("setCamera");

    // A key pressed in the search box is the search box's, never the camera's.
    renderer.ops.length = 0;
    fireEvent.keyDown(screen.getByLabelText("Find a node by title"), { key: "ArrowRight" });
    expect(renderer.ops).toEqual([]);
  });

  it("tears the renderer and the worker down on unmount", async () => {
    graphPageMock([page({ nodes: [node("a")] })]);
    const view = renderGraph();
    await waitFor(() => expect(hoisted.renderers.length).toBe(1));
    view.unmount();
    expect(hoisted.renderers[0]?.destroyed).toBe(true);
    expect(hoisted.physics[0]?.disposed).toBe(true);
  });
});

/**
 * The idle breath. A settled force layout is a still image; the breath keeps
 * it drifting so the map reads as alive. Two things must hold, and both are
 * load-bearing enough to pin here rather than trust:
 *
 *  - it waits for a SETTLED tick. A continuous breath means the simulation
 *    never reports settled again, so breathing before the first real rest
 *    would leave auto-fit armed forever and the CAMERA would re-frame on
 *    every breath — a map that quietly zooms itself.
 *  - `prefers-reduced-motion` turns it off. A decorative animation with no end
 *    is the clearest case that query exists for, and it is what keeps "wait
 *    for the graph to stop moving" satisfiable for the mobile e2e.
 */
describe("the idle breath", () => {
  const tick = (settled: boolean): PositionBuffer => ({
    n: 1,
    xy: new Float32Array([0, 0]),
    tick: 1,
    alpha: settled ? 0.0009 : 0.4,
    settled,
  });

  function reducedMotion(reduce: boolean): void {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) =>
        ({
          matches: reduce && q.includes("prefers-reduced-motion"),
          media: q,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
  }

  /** Long enough to clear the idle gate and land several breath periods. */
  const IDLE_AND_A_FEW_BREATHS = 20_000;

  it("breathes once the layout has come to rest, and not before", async () => {
    reducedMotion(false);
    graphPageMock([page({ nodes: [node("a")] })]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderGraph();
      await vi.waitFor(() => expect(hoisted.physics[0]?.emit).toBeTruthy());
      const physics = hoisted.physics[0]!;
      const nudges = () => physics.reheats.filter((a) => a > 0 && a < 0.1).length;

      // Still laying out: idle time alone must not start it.
      physics.emit!(tick(false));
      await vi.advanceTimersByTimeAsync(IDLE_AND_A_FEW_BREATHS);
      expect(nudges()).toBe(0);

      // Come to rest — now it breathes.
      physics.emit!(tick(true));
      await vi.advanceTimersByTimeAsync(IDLE_AND_A_FEW_BREATHS);
      expect(nudges()).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays perfectly still under prefers-reduced-motion", async () => {
    reducedMotion(true);
    graphPageMock([page({ nodes: [node("a")] })]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderGraph();
      await vi.waitFor(() => expect(hoisted.physics[0]?.emit).toBeTruthy());
      const physics = hoisted.physics[0]!;
      physics.emit!(tick(true));
      await vi.advanceTimersByTimeAsync(IDLE_AND_A_FEW_BREATHS);
      expect(physics.reheats.filter((a) => a > 0 && a < 0.1)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
