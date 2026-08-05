import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { buildCsr } from "../../lib/graph/csr";
import { GraphStore } from "../../lib/graph/store";
import type { GraphNode, HighlightSet } from "../../lib/graph/types";
import type { GraphEngine } from "../../views/GraphView";
import {
  GRAPH_PATH_REQUEST_EVENT,
  NodePeekBridgePanel,
  edgeLabel,
  nearestEdge,
  orientEdge,
  pointSegmentDistance,
  type GraphPathRequest,
} from "./NodePeekBridge";

/**
 * What these pin is the navigation CONTRACT:
 *
 *  - a click opens the phase-4 side-peek (`?peek=<id>` on the current route)
 *    and does NOT touch the camera — the whole point of peeking from a graph
 *    is that you keep your place;
 *  - a double click is the full-page gesture, so the pending peek is cancelled
 *    rather than mounting an editor (and joining a collab room) for 200ms;
 *  - ⌘-click builds the two endpoints of a shortest path and hands them off,
 *    without opening anything;
 *  - "Path to…" in the peek header is the same feature's second entry point,
 *    and it survives the header not being there;
 *  - hovering an edge names the relationship, in the direction it was actually
 *    written.
 */

function node(id: string, title: string | null, degree = 1): GraphNode {
  return { id, title, type: "thing", degree };
}

const NODES = [node("a", "Alpha"), node("b", "Beta"), node("c", "Gamma")];

interface Stub {
  engineOf: (focus: number | null, setFocus: (i: number | null) => void) => GraphEngine;
  cameraOps: string[];
  highlights: Array<{ source: string; set: HighlightSet | null }>;
  store: GraphStore;
}

function stub(over: Partial<GraphEngine> = {}): Stub {
  const cameraOps: string[] = [];
  const highlights: Stub["highlights"] = [];
  const store = new GraphStore();
  store.ingest({
    nodes: NODES,
    edges: [
      { from: "a", to: "b", rel: "depends on" },
      { from: "c", to: "b", rel: "mentions" },
    ],
  });
  const csr = buildCsr(store);

  const engineOf = (focus: number | null, setFocus: (i: number | null) => void): GraphEngine =>
    ({
      store,
      nodes: NODES,
      csr,
      revision: store.revision,
      renderer: null,
      physics: null,
      camera: {
        get: () => ({ x: 0, y: 0, scale: 1 }),
        set: () => cameraOps.push("set"),
        ease: () => cameraOps.push("ease"),
        fit: () => cameraOps.push("fit"),
        reset: () => cameraOps.push("reset"),
        centerOn: () => cameraOps.push("centerOn"),
        invalidate: () => undefined,
      },
      setHighlight: (source: string, set: HighlightSet | null) => highlights.push({ source, set }),
      highlight: null,
      selection: new Set<number>(),
      select: () => undefined,
      clearSelection: () => undefined,
      focus,
      setFocus,
      hover: null,
      load: {
        phase: "ready",
        nodes: NODES.length,
        edges: 2,
        pages: 1,
        truncated: null,
        droppedEdges: 0,
        error: null,
      },
      reload: () => undefined,
      filters: { types: new Set<string | null>(), recency: "all" },
      setFilters: () => undefined,
      controls: {} as never,
      setControls: () => undefined,
      indexOf: (id: string) => store.indexOf(id),
      idAt: (i: number) => store.idAt(i),
      ...over,
    }) as unknown as GraphEngine;

  return { engineOf, cameraOps, highlights, store };
}

/**
 * A ⌘-click, as a browser fires it: the modifier rides EVERY event of the
 * gesture, not just the first. jsdom has no `PointerEvent` at all (a synthetic
 * `pointerdown` degrades to a plain `Event` and drops `metaKey`), which is one
 * of the reasons the bridge reads the modifier off the whole gesture.
 */
function metaClick(el: HTMLElement): void {
  fireEvent.pointerDown(el, { metaKey: true });
  fireEvent.mouseDown(el, { metaKey: true });
  fireEvent.click(el, { metaKey: true });
}

function Loc() {
  const location = useLocation();
  return <span data-testid="loc">{location.search}</span>;
}

function Harness({
  engineOf,
  onPathRequest,
  openDelayMs = 5,
}: {
  engineOf: Stub["engineOf"];
  onPathRequest?: (r: GraphPathRequest) => void;
  openDelayMs?: number;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  return (
    <MemoryRouter initialEntries={["/graph"]}>
      <div>
        <NodePeekBridgePanel
          engine={engineOf(focus, setFocus)}
          {...(onPathRequest ? { onPathRequest } : {})}
          openDelayMs={openDelayMs}
        />
        <button type="button" onClick={() => setFocus(0)}>
          pick-a
        </button>
        <button type="button" onClick={() => setFocus(1)}>
          pick-b
        </button>
        <Loc />
      </div>
    </MemoryRouter>
  );
}

describe("pointSegmentDistance", () => {
  it("measures to the segment, not to the infinite line", () => {
    expect(pointSegmentDistance(50, 10, 0, 0, 100, 0)).toBeCloseTo(10);
    // past the end: the distance is to the endpoint
    expect(pointSegmentDistance(150, 0, 0, 0, 100, 0)).toBeCloseTo(50);
  });

  it("handles a degenerate (zero-length) segment", () => {
    expect(pointSegmentDistance(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });
});

describe("nearestEdge", () => {
  const { store } = stub();
  const csr = buildCsr(store);
  // a(0) at (0,0), b(1) at (100,0), c(2) at (100,100)
  const screen2 = new Map<number, { x: number; y: number }>([
    [0, { x: 0, y: 0 }],
    [1, { x: 100, y: 0 }],
    [2, { x: 100, y: 100 }],
  ]);
  const project = (i: number) => screen2.get(i) ?? null;

  it("finds the edge under the pointer and names its verb", () => {
    const hit = nearestEdge(csr, [0, 1, 2], project, { x: 50, y: 2 });
    expect(hit).not.toBeNull();
    expect(new Set([hit!.a, hit!.b])).toEqual(new Set([0, 1]));
    expect(hit!.rel).toBe("depends on");
  });

  it("is null when nothing is within the slop", () => {
    expect(nearestEdge(csr, [0, 1, 2], project, { x: 50, y: 40 })).toBeNull();
  });

  it("prefers the closer of two edges", () => {
    const hit = nearestEdge(csr, [0, 1, 2], project, { x: 100, y: 60 });
    expect(hit!.rel).toBe("mentions");
  });

  it("stops at its budget rather than stalling a frame", () => {
    expect(nearestEdge(csr, [0, 1, 2], project, { x: 50, y: 0 }, 6, 0)).toBeNull();
  });

  it("skips a node with no position yet instead of projecting NaN", () => {
    expect(nearestEdge(csr, [0, 1, 2], () => null, { x: 50, y: 0 })).toBeNull();
  });
});

describe("orientEdge / edgeLabel", () => {
  it("reads the verb in the direction it was written", () => {
    const { store, engineOf } = stub();
    expect(orientEdge(store, "b", "a", "depends on")).toEqual(["a", "b"]);
    const engine = engineOf(null, () => undefined);
    const label = edgeLabel(engine, { a: 1, b: 0, rel: "depends on", distance: 0 });
    expect(label).toEqual({ from: "Alpha", rel: "depends on", to: "Beta" });
  });

  it("falls back to a neutral verb rather than an empty arrow", () => {
    const { engineOf } = stub();
    const engine = engineOf(null, () => undefined);
    expect(edgeLabel(engine, { a: 0, b: 1, rel: "", distance: 0 })?.rel).toBe("linked to");
  });
});

describe("<NodePeekBridgePanel>", () => {
  it("opens the object in the side-peek on click, and leaves the camera alone", async () => {
    const { engineOf, cameraOps } = stub();
    render(<Harness engineOf={engineOf} />);

    fireEvent.click(screen.getByText("pick-a"));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("peek=a"));
    // The whole promise of peeking from a graph.
    expect(cameraOps).toEqual([]);
  });

  it("yields to the double-click: the full page opens, no peek is mounted", async () => {
    const { engineOf } = stub();
    render(<Harness engineOf={engineOf} openDelayMs={60} />);

    fireEvent.click(screen.getByText("pick-a"));
    fireEvent.dblClick(screen.getByText("pick-a"));
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.getByTestId("loc")).toHaveTextContent("");
    expect(screen.getByTestId("loc").textContent).toBe("");
  });

  it("⌘-click builds both endpoints and hands them off without opening anything", async () => {
    const { engineOf } = stub();
    const onPathRequest = vi.fn();
    render(<Harness engineOf={engineOf} onPathRequest={onPathRequest} />);

    metaClick(screen.getByText("pick-a"));
    // The first ⌘-click is the FIRST endpoint, and it says so.
    await screen.findByText(/Tracing from/);

    metaClick(screen.getByText("pick-b"));

    await waitFor(() => expect(onPathRequest).toHaveBeenCalledTimes(1));
    expect(onPathRequest.mock.calls[0]![0]).toEqual({
      from: { index: 0, id: "a" },
      to: { index: 1, id: "b" },
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.getByTestId("loc").textContent).toBe("");
  });

  it("falls back to a window event when nobody passed a handler", async () => {
    const { engineOf } = stub();
    const seen: GraphPathRequest[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<GraphPathRequest>).detail);
    window.addEventListener(GRAPH_PATH_REQUEST_EVENT, listener);
    try {
      render(<Harness engineOf={engineOf} />);
      metaClick(screen.getByText("pick-a"));
      metaClick(screen.getByText("pick-b"));
      await waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]!.to.id).toBe("b");
    } finally {
      window.removeEventListener(GRAPH_PATH_REQUEST_EVENT, listener);
    }
  });

  it("puts 'Path to…' in the live peek header, and starts the pick there", async () => {
    const { engineOf } = stub();
    const peek = document.createElement("div");
    peek.setAttribute("data-testid", "side-peek");
    const header = document.createElement("header");
    const openLink = document.createElement("a");
    openLink.setAttribute("aria-label", "Open full page");
    header.append(openLink);
    peek.append(header);
    document.body.append(peek);
    try {
      const onPathRequest = vi.fn();
      render(<Harness engineOf={engineOf} onPathRequest={onPathRequest} />);
      fireEvent.click(screen.getByText("pick-a"));
      await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("peek=a"));

      const action = await waitFor(() => {
        const el = peek.querySelector<HTMLElement>('button[aria-label="Path to another object"]');
        expect(el).not.toBeNull();
        return el!;
      });
      fireEvent.click(action);
      await screen.findByText(/Tracing from/);

      fireEvent.click(screen.getByText("pick-b"));
      await waitFor(() => expect(onPathRequest).toHaveBeenCalledTimes(1));
      expect(onPathRequest.mock.calls[0]![0].from.id).toBe("a");
    } finally {
      peek.remove();
    }
  });

  it("still offers the action when the peek header is not there to portal into", async () => {
    const { engineOf } = stub();
    render(<Harness engineOf={engineOf} />);
    fireEvent.click(screen.getByText("pick-a"));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("peek=a"));
    expect(await screen.findByLabelText("Path to another object")).toBeInTheDocument();
  });

  it("escape abandons a half-built path", async () => {
    const { engineOf } = stub();
    render(<Harness engineOf={engineOf} />);
    metaClick(screen.getByText("pick-a"));
    await screen.findByText(/Tracing from/);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText(/Tracing from/)).toBeNull());
  });
});
