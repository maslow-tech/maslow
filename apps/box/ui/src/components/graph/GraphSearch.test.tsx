import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphNode, HighlightSet } from "../../lib/graph/types";
import type { GraphEngine } from "../../views/GraphView";
import {
  DEEP_DEBOUNCE_MS,
  GraphSearchPanel,
  SEARCH_DEBOUNCE_MS,
  fitToIndices,
  matchGraphNodes,
  matchSummary,
  mergeDeepMatches,
  scoreNode,
} from "./GraphSearch";

/**
 * What these pin is the search's PROMISE, not its pixels:
 *
 *  - it HIGHLIGHTS, it never filters — the layer it installs is `kind:
 *    "search"` (dim 0.45, the gentle one), and nothing in the component ever
 *    touches the engine's filters or its node set. The old view's "dim to 0.2"
 *    is the regression this exists to prevent;
 *  - the camera is not moved by typing. Only Enter, Fit and the explicit
 *    follow toggle move it, which is the same promise the peek keeps on click;
 *  - the deep pass MERGES into the same highlight and counts what is not on
 *    the map. A hit the client was never given is never drawn — a synthesized
 *    node would be exactly the hidden-neighbour hint the visible-only-degree
 *    rule exists to prevent;
 *  - unmounting releases the dimming, because a stuck dim with nothing driving
 *    it cannot be recovered from without a reload.
 */

const searchMock = vi.fn(async (..._args: unknown[]) => [] as Array<{ id: string }>);

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      search: (...args: unknown[]) => searchMock(...args),
    },
  };
});

function node(id: string, title: string | null, type: string | null, degree = 1): GraphNode {
  return { id, title, type, degree };
}

interface Stub {
  engine: GraphEngine;
  highlights: Array<{ source: string; set: HighlightSet | null }>;
  cameraOps: string[];
}

function stubEngine(nodes: readonly GraphNode[], over: Partial<GraphEngine> = {}): Stub {
  const highlights: Stub["highlights"] = [];
  const cameraOps: string[] = [];
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i));

  const engine = {
    store: null as never,
    nodes,
    csr: null,
    revision: 1,
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
    focus: null,
    setFocus: () => undefined,
    hover: null,
    load: {
      phase: "ready",
      nodes: nodes.length,
      edges: 0,
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
    indexOf: (id: string) => index.get(id),
    idAt: (i: number) => nodes[i]?.id,
    ...over,
  } as unknown as GraphEngine;

  return { engine, highlights, cameraOps };
}

const NODES = [
  node("a", "Alpha release", "project", 9),
  node("b", "Beta of alpha", "project", 2),
  node("c", "Gamma", "person", 40),
  node("d", null, "alpha_type", 1),
];

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scoreNode", () => {
  it("ranks a title prefix above a title substring above a type match", () => {
    expect(scoreNode(NODES[0]!, "alpha")).toBe(0);
    expect(scoreNode(NODES[1]!, "alpha")).toBe(1);
    expect(scoreNode(NODES[3]!, "alpha")).toBe(2);
  });

  it("is null for a node that does not match at all", () => {
    expect(scoreNode(NODES[2]!, "alpha")).toBeNull();
  });

  it("never reads a null title as an empty match", () => {
    expect(scoreNode(node("x", null, null), "a")).toBeNull();
  });
});

describe("matchGraphNodes", () => {
  it("returns nothing for an empty query rather than everything", () => {
    expect(matchGraphNodes(NODES, "   ").indices).toEqual([]);
  });

  it("ranks by score, then by visible degree", () => {
    const out = matchGraphNodes(NODES, "alpha");
    expect(out.indices).toEqual([0, 1, 3]);
    expect(out.set.has(2)).toBe(false);
  });

  it("caps at the END, so the cap drops the worst matches and not the last page", () => {
    const out = matchGraphNodes(NODES, "alpha", 1);
    expect(out.indices).toEqual([0]);
    expect(out.total).toBe(3);
    expect(out.capped).toBe(true);
  });

  it("matches case-insensitively on the type as well as the title", () => {
    expect(matchGraphNodes(NODES, "PERSON").indices).toEqual([2]);
  });
});

describe("mergeDeepMatches", () => {
  it("appends deep hits that are on the map and counts the ones that are not", () => {
    const local = matchGraphNodes(NODES, "gamma");
    const merged = mergeDeepMatches(local, ["a", "not-loaded"], (id) =>
      id === "a" ? 0 : undefined,
    );
    expect(merged.indices).toEqual([2, 0]);
    expect(merged.offMap).toBe(1);
  });

  it("never double-counts a hit the local pass already found", () => {
    const local = matchGraphNodes(NODES, "alpha");
    const merged = mergeDeepMatches(local, ["a"], (id) => (id === "a" ? 0 : undefined));
    expect(merged.indices).toEqual([0, 1, 3]);
    expect(merged.offMap).toBe(0);
  });
});

describe("fitToIndices", () => {
  const positions = new Float32Array([0, 0, 100, 0, 100, 100, 0, 100]);

  it("centers on the match bounding box", () => {
    const cam = fitToIndices(positions, [0, 2], { width: 800, height: 600 }, 0);
    expect(cam).not.toBeNull();
    expect(cam!.x).toBeCloseTo(50);
    expect(cam!.y).toBeCloseTo(50);
  });

  it("never zooms past the ceiling for a tight (or single) match set", () => {
    const cam = fitToIndices(positions, [0], { width: 800, height: 600 }, 0);
    expect(cam!.scale).toBeLessThanOrEqual(1.6);
  });

  it("is null when nothing in the set has a position yet", () => {
    expect(fitToIndices(new Float32Array(0), [0, 1], { width: 800, height: 600 })).toBeNull();
    expect(
      fitToIndices(new Float32Array([Number.NaN, Number.NaN]), [0], { width: 800, height: 600 }),
    ).toBeNull();
  });
});

describe("matchSummary", () => {
  it("says the map was not filtered when nothing matched", () => {
    const copy = matchSummary({ matches: [], total: 0, capped: false, offMap: 0 });
    expect(copy).toMatch(/nothing was filtered away/i);
  });

  it("says matches are highlighted IN PLACE, and counts what is off the map", () => {
    const copy = matchSummary({ matches: [1, 2], total: 2, capped: false, offMap: 3 });
    expect(copy).toMatch(/highlighted in place/);
    expect(copy).toMatch(/3 more elsewhere in your brain/);
  });
});

describe("<GraphSearchPanel>", () => {
  it("installs the gentle search layer and never filters the graph", () => {
    vi.useFakeTimers();
    const { engine, highlights, cameraOps } = stubEngine(NODES);
    const setFilters = vi.fn();
    render(<GraphSearchPanel engine={{ ...engine, setFilters }} deep={false} />);

    fireEvent.change(screen.getByLabelText("Find on the map"), { target: { value: "alpha" } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 1);
    });

    const last = highlights.at(-1);
    expect(last?.source).toBe("search");
    expect(last?.set?.kind).toBe("search");
    // 0.45, not the old view's 0.2 and not hover isolation's 0.12: the context
    // around a match is what makes the match mean anything.
    expect(last?.set?.dimAlpha).toBe(0.45);
    expect([...(last?.set?.nodes ?? [])]).toEqual([0, 1, 3]);
    // Highlighting, not filtering — and not a camera move either.
    expect(setFilters).not.toHaveBeenCalled();
    expect(cameraOps).toEqual([]);
  });

  it("moves the camera only when asked — Enter steps, Fit frames", () => {
    vi.useFakeTimers();
    const { engine, cameraOps } = stubEngine(NODES);
    render(<GraphSearchPanel engine={engine} deep={false} />);

    const input = screen.getByLabelText("Find on the map");
    fireEvent.change(input, { target: { value: "alpha" } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 1);
    });
    expect(cameraOps).toEqual([]);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(cameraOps).toEqual(["centerOn"]);

    // No renderer in this stub, so Fit degrades to centering on the first
    // match rather than throwing.
    fireEvent.click(screen.getByTitle("Frame every match"));
    expect(cameraOps).toEqual(["centerOn", "centerOn"]);
  });

  it("merges deep hits into the same highlight and counts the ones off the map", async () => {
    searchMock.mockResolvedValue([{ id: "c" }, { id: "somewhere-else" }]);
    const { engine, highlights } = stubEngine(NODES);
    render(<GraphSearchPanel engine={engine} />);

    fireEvent.change(screen.getByLabelText("Find on the map"), { target: { value: "alpha" } });
    await screen.findByText(/highlighted in place/);
    await screen.findByText(/1 more elsewhere in your brain/, undefined, { timeout: 3000 });

    const last = highlights.at(-1);
    expect(last?.set?.nodes.has(2)).toBe(true);
    expect(searchMock).toHaveBeenCalled();
  });

  it("leaves the local matches standing when the deep pass fails", async () => {
    searchMock.mockRejectedValue(new Error("embedder warming"));
    const { engine, highlights } = stubEngine(NODES);
    render(<GraphSearchPanel engine={engine} />);

    fireEvent.change(screen.getByLabelText("Find on the map"), { target: { value: "alpha" } });
    await screen.findByText(/3 matches highlighted in place/);
    await act(async () => {
      await new Promise((r) => setTimeout(r, DEEP_DEBOUNCE_MS + 40));
    });

    expect(highlights.at(-1)?.set?.nodes.size).toBe(3);
  });

  it("releases the dimming when it unmounts", () => {
    vi.useFakeTimers();
    const { engine, highlights } = stubEngine(NODES);
    const view = render(<GraphSearchPanel engine={engine} deep={false} />);
    fireEvent.change(screen.getByLabelText("Find on the map"), { target: { value: "alpha" } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 1);
    });
    view.unmount();
    expect(highlights.at(-1)).toEqual({ source: "search", set: null });
  });
});
