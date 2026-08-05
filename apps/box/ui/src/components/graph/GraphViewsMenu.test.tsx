import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DEPTH,
  EMPTY_HIGHLIGHT,
  GRAPH_VIEW_CONFIG_VERSION,
  GraphViewsMenuBody,
  buildGraphViewConfig,
  filtersFromConfig,
  needsRefetch,
  normalizeCamera,
  normalizeDepth,
  normalizeFilters,
  normalizeGraphViewConfig,
  normalizeHighlight,
  roundCamera,
  type GraphViewConfig,
  type GraphViewsMenuProps,
} from "./GraphViewsMenu";
import { GLOBAL_CONTROL_DEFAULTS } from "./GraphControls";
import { resetSavedViewsStore, sameConfig } from "../SavedViews";
import { api, type SavedView } from "../../lib/api";
import { SCALE_MAX, SCALE_MIN } from "../../lib/graph/renderer";
import type { GraphEngine, GraphFilterState } from "../../views/GraphView";
import type { PhysicsHandle } from "../../lib/graph/physics";
import type { CameraState } from "../../lib/graph/types";

/**
 * What these pin is the saved-GRAPH-view contract, not its pixels:
 *
 *  - a config that came back out of jsonb is CLAMPED, never trusted — a NaN
 *    reaching d3 turns every position into NaN and the graph silently vanishes;
 *  - the saved filters are the phase-3 filter model, and a restore only
 *    refetches when they actually changed;
 *  - the camera is restored AFTER the first positions land, because the view
 *    fits the camera on its first tick and would overwrite anything set before;
 *  - a restore that did not refetch does not reheat — nudging a settled layout
 *    would drift every node out from under the camera just restored;
 *  - a focus node the member can no longer see is skipped in SILENCE (saying
 *    "it's gone" would confirm a private object exists);
 *  - `hover` and `selection` are not saveable highlight modes, and there is no
 *    share affordance anywhere.
 */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const filters = (over: Partial<GraphFilterState> = {}): GraphFilterState => ({
  types: new Set<string | null>(),
  recency: "all",
  ...over,
});

const savedView = (over: Partial<SavedView> & { id: string; name: string }): SavedView => ({
  kind: "graph",
  scope: null,
  config: {},
  pinned: false,
  position: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

/* ------------------------------------------------------------------ *
 * a stub engine — <GraphView>'s context means PixiJS, a Worker and the
 * paged endpoint, none of which this control's behaviour depends on
 * ------------------------------------------------------------------ */

interface Stub {
  engine: GraphEngine;
  camera: CameraState;
  cameraSet: ReturnType<typeof vi.fn>;
  setControls: ReturnType<typeof vi.fn>;
  setFilters: ReturnType<typeof vi.fn>;
  setFocus: ReturnType<typeof vi.fn>;
  reheat: ReturnType<typeof vi.fn>;
  /** flip to a buffer to say "the first tick landed". */
  ticked: { latest: unknown };
}

function stubEngine(over: Partial<GraphEngine> = {}, ids: string[] = []): Stub {
  const camera: CameraState = { x: 0, y: 0, scale: 1 };
  const cameraSet = vi.fn((next: Partial<CameraState>) => Object.assign(camera, next));
  const setControls = vi.fn();
  const setFilters = vi.fn();
  const setFocus = vi.fn();
  const reheat = vi.fn();
  const ticked: { latest: unknown } = { latest: { n: 1 } };

  const engine = {
    store: null as never,
    nodes: [],
    csr: null,
    revision: 1,
    renderer: null,
    physics: { positions: ticked, reheat } as unknown as PhysicsHandle,
    camera: {
      get: () => ({ ...camera }),
      set: cameraSet,
      ease: vi.fn(),
      fit: vi.fn(),
      reset: vi.fn(),
      centerOn: vi.fn(),
      invalidate: vi.fn(),
    },
    setHighlight: vi.fn(),
    highlight: null,
    selection: new Set<number>(),
    select: vi.fn(),
    clearSelection: vi.fn(),
    focus: null,
    setFocus,
    hover: null,
    load: {
      phase: "ready",
      nodes: 1,
      edges: 0,
      pages: 1,
      truncated: null,
      droppedEdges: 0,
      error: null,
    },
    reload: vi.fn(),
    filters: filters(),
    setFilters,
    controls: GLOBAL_CONTROL_DEFAULTS,
    setControls,
    indexOf: (id: string) => {
      const i = ids.indexOf(id);
      return i < 0 ? undefined : i;
    },
    idAt: (index: number) => ids[index],
    ...over,
  } as unknown as GraphEngine;

  return { engine, camera, cameraSet, setControls, setFilters, setFocus, reheat, ticked };
}

const renderMenu = (engine: GraphEngine, props: Partial<GraphViewsMenuProps> = {}) =>
  render(
    <MemoryRouter>
      <GraphViewsMenuBody engine={engine} accountId={ACCOUNT} {...props} />
    </MemoryRouter>,
  );

beforeEach(() => {
  resetSavedViewsStore();
});

afterEach(() => {
  resetSavedViewsStore();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------ normalization */

describe("normalizeGraphViewConfig", () => {
  it("answers a whole config for junk of any shape", () => {
    for (const junk of [undefined, null, "graph", 7, [], { filters: "all" }]) {
      const out = normalizeGraphViewConfig(junk);
      expect(out.v).toBe(GRAPH_VIEW_CONFIG_VERSION);
      expect(out.filters).toEqual({ types: [], recency: "all" });
      expect(out.controls).toEqual(GLOBAL_CONTROL_DEFAULTS);
      expect(out.camera).toEqual({ x: 0, y: 0, scale: 1 });
      expect(out.focus).toBeNull();
      expect(out.depth).toBe(DEFAULT_DEPTH);
      expect(out.highlight).toEqual(EMPTY_HIGHLIGHT);
    }
  });

  it("clamps the sliders rather than handing d3 whatever was stored", () => {
    const out = normalizeGraphViewConfig({
      controls: { repel: 5_000, linkDistance: Number.NaN, center: -3 },
    });
    expect(out.controls.repel).toBe(200);
    expect(out.controls.linkDistance).toBe(GLOBAL_CONTROL_DEFAULTS.linkDistance);
    expect(out.controls.center).toBe(0);
  });

  it("keeps a good config intact", () => {
    const out = normalizeGraphViewConfig({
      filters: { types: ["person"], recency: "30d" },
      controls: { ...GLOBAL_CONTROL_DEFAULTS, repel: 80 },
      camera: { x: 12.34, y: -8, scale: 2 },
      focus: "obj-1",
      depth: 2,
      highlight: { mode: "search", query: "acme" },
    });
    expect(out.filters).toEqual({ types: ["person"], recency: "30d" });
    expect(out.controls.repel).toBe(80);
    expect(out.camera).toEqual({ x: 12.3, y: -8, scale: 2 });
    expect(out.focus).toBe("obj-1");
    expect(out.depth).toBe(2);
    expect(out.highlight).toEqual({ mode: "search", query: "acme", path: null, since: null });
  });
});

describe("normalizeCamera", () => {
  it("clamps the scale to what the wheel could have produced", () => {
    expect(normalizeCamera({ x: 0, y: 0, scale: 10_000 }).scale).toBe(SCALE_MAX);
    expect(normalizeCamera({ x: 0, y: 0, scale: 0 }).scale).toBe(SCALE_MIN);
    expect(normalizeCamera({ x: 0, y: 0, scale: "big" }).scale).toBe(1);
  });

  it("refuses a non-finite position instead of losing the graph", () => {
    expect(normalizeCamera({ x: Number.NaN, y: Infinity, scale: 1 })).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });

  it("rounds, so sub-pixel drift is not a change", () => {
    expect(roundCamera({ x: 1.04999, y: -2.0501, scale: 1.000009 })).toEqual({
      x: 1,
      y: -2.1,
      scale: 1,
    });
  });
});

describe("normalizeDepth", () => {
  it("holds the rail's 1–3 range", () => {
    expect(normalizeDepth(0)).toBe(1);
    expect(normalizeDepth(9)).toBe(3);
    expect(normalizeDepth(2.4)).toBe(2);
    expect(normalizeDepth("2")).toBe(2);
    expect(normalizeDepth(undefined)).toBe(DEFAULT_DEPTH);
  });
});

describe("normalizeFilters", () => {
  it("keeps the untyped bucket, drops junk, dedupes and sorts", () => {
    expect(
      normalizeFilters({ types: ["task", null, "task", 7, "", "person", null], recency: "7d" }),
    ).toEqual({ types: [null, "person", "task"], recency: "7d" });
  });

  it("falls back to any-time for a recency this release does not know", () => {
    expect(normalizeFilters({ types: [], recency: "since-tuesday" }).recency).toBe("all");
  });

  it("caps a type list that is junk rather than a legend", () => {
    const many = Array.from({ length: 500 }, (_, i) => `t${i}`);
    expect(normalizeFilters({ types: many }).types.length).toBeLessThanOrEqual(200);
  });

  it("sorts, so the same filter clicked in two orders is not 'dirty'", () => {
    expect(normalizeFilters({ types: ["b", "a"] })).toEqual(
      normalizeFilters({ types: ["a", "b"] }),
    );
  });
});

describe("normalizeHighlight", () => {
  it("never restores hover or selection — they are not view state", () => {
    expect(normalizeHighlight({ mode: "hover" })).toEqual(EMPTY_HIGHLIGHT);
    expect(normalizeHighlight({ mode: "selection" })).toEqual(EMPTY_HIGHLIGHT);
    expect(normalizeHighlight({ mode: "whatever-comes-next" })).toEqual(EMPTY_HIGHLIGHT);
  });

  it("drops a mode whose input is missing", () => {
    expect(normalizeHighlight({ mode: "search", query: "  " })).toEqual(EMPTY_HIGHLIGHT);
    expect(normalizeHighlight({ mode: "path", path: { from: "a" } })).toEqual(EMPTY_HIGHLIGHT);
    expect(normalizeHighlight({ mode: "changed" })).toEqual(EMPTY_HIGHLIGHT);
  });

  it("keeps ONLY the input its mode uses", () => {
    expect(
      normalizeHighlight({
        mode: "path",
        path: { from: "a", to: "b" },
        query: "leftover",
        since: "2026-07-01T00:00:00.000Z",
      }),
    ).toEqual({ mode: "path", path: { from: "a", to: "b" }, query: "", since: null });
  });
});

/* ------------------------------------------------------------ the live config */

describe("buildGraphViewConfig", () => {
  const built = (): GraphViewConfig =>
    buildGraphViewConfig({
      filters: filters({ types: new Set(["task", null]), recency: "7d" }),
      controls: { ...GLOBAL_CONTROL_DEFAULTS, repel: 40 },
      camera: { x: 5, y: 6, scale: 1.5 },
      focus: "obj-9",
      depth: 3,
      highlight: { mode: "search", query: "acme", path: null, since: null },
    });

  it("captures the filters, forces, camera, focus, depth and highlight mode", () => {
    expect(built()).toEqual({
      v: GRAPH_VIEW_CONFIG_VERSION,
      filters: { types: [null, "task"], recency: "7d" },
      controls: { ...GLOBAL_CONTROL_DEFAULTS, repel: 40 },
      camera: { x: 5, y: 6, scale: 1.5 },
      focus: "obj-9",
      depth: 3,
      highlight: { mode: "search", query: "acme", path: null, since: null },
    });
  });

  it("survives the jsonb round trip, so a restored view is not instantly dirty", () => {
    const live = built();
    const readBack = normalizeGraphViewConfig(JSON.parse(JSON.stringify(live)));
    expect(sameConfig(live, readBack)).toBe(true);
  });
});

describe("needsRefetch", () => {
  const config = (over: Partial<GraphViewConfig["filters"]>): GraphViewConfig =>
    normalizeGraphViewConfig({ filters: { types: [], recency: "all", ...over } });

  it("is false when the filter is the same set in another order", () => {
    expect(
      needsRefetch(config({ types: ["b", "a"] }), filters({ types: new Set(["a", "b"]) })),
    ).toBe(false);
  });

  it("is true when a type or the recency actually changed", () => {
    expect(needsRefetch(config({ types: ["a"] }), filters())).toBe(true);
    expect(needsRefetch(config({ recency: "30d" }), filters())).toBe(true);
  });

  it("hands the filters back as the engine's own state", () => {
    const state = filtersFromConfig(config({ types: ["a", null], recency: "90d" }));
    expect([...state.types].sort()).toEqual([null, "a"].sort());
    expect(state.recency).toBe("90d");
  });
});

/* ------------------------------------------------------------- the control */

async function openMenu(views: SavedView[], stub: Stub, props: Partial<GraphViewsMenuProps> = {}) {
  vi.spyOn(api, "views").mockResolvedValue(views);
  renderMenu(stub.engine, props);
  const trigger = await screen.findByRole("button", { name: /saved views|saved view:/i });
  fireEvent.click(trigger);
}

describe("<GraphViewsMenu />", () => {
  it("saves what is on screen as a GRAPH view, global scope", async () => {
    const create = vi
      .spyOn(api, "createView")
      .mockResolvedValue(savedView({ id: "new", name: "Hubs" }));
    const stub = stubEngine(
      {
        filters: filters({ types: new Set(["person"]), recency: "30d" }),
        controls: { ...GLOBAL_CONTROL_DEFAULTS, repel: 60 },
        focus: 0,
      },
      ["obj-a"],
    );
    await openMenu([], stub, { extras: { depth: 2 } });

    fireEvent.change(await screen.findByLabelText("new view name"), { target: { value: "Hubs" } });
    fireEvent.click(screen.getByRole("button", { name: /save this view/i }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({
      kind: "graph",
      scope: null,
      name: "Hubs",
      config: {
        filters: { types: ["person"], recency: "30d" },
        controls: { ...GLOBAL_CONTROL_DEFAULTS, repel: 60 },
        camera: { x: 0, y: 0, scale: 1 },
        focus: "obj-a",
        depth: 2,
        highlight: EMPTY_HIGHLIGHT,
      },
    });
  });

  it("offers no way to share a graph view with anyone", async () => {
    await openMenu([savedView({ id: "a", name: "Mine" })], stubEngine());
    await screen.findByText("Mine");
    expect(screen.queryByText(/share/i)).toBeNull();
    expect(screen.getByText(/yours alone/i)).toBeInTheDocument();
  });

  it("restores forces, filters, extras, camera and focus", async () => {
    const stub = stubEngine({}, ["obj-a", "obj-b"]);
    const onRestoreExtras = vi.fn();
    await openMenu(
      [
        savedView({
          id: "a",
          name: "Won deals",
          config: {
            filters: { types: ["deal"], recency: "7d" },
            controls: { ...GLOBAL_CONTROL_DEFAULTS, repel: 30 },
            camera: { x: 40, y: -12, scale: 2 },
            focus: "obj-b",
            depth: 3,
            highlight: { mode: "search", query: "acme" },
          },
        }),
      ],
      stub,
      { onRestoreExtras },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Won deals" }));

    expect(stub.setControls).toHaveBeenCalledWith(
      expect.objectContaining({ repel: 30, linkDistance: GLOBAL_CONTROL_DEFAULTS.linkDistance }),
    );
    expect(onRestoreExtras).toHaveBeenCalledWith({
      depth: 3,
      highlight: { mode: "search", query: "acme", path: null, since: null },
    });
    // the filters changed, so the paged walk is re-run …
    const applied = stub.setFilters.mock.calls[0]![0] as GraphFilterState;
    expect([...applied.types]).toEqual(["deal"]);
    expect(applied.recency).toBe("7d");
    // … and the camera + focus land after it, with a GENTLE nudge, never 1.
    await waitFor(() => expect(stub.cameraSet).toHaveBeenCalledWith({ x: 40, y: -12, scale: 2 }));
    expect(stub.setFocus).toHaveBeenCalledWith(1);
    expect(stub.reheat).toHaveBeenCalledWith(0.3);
  });

  it("does not refetch or reheat when only the camera moved", async () => {
    const stub = stubEngine({}, ["obj-a"]);
    await openMenu(
      [
        savedView({
          id: "a",
          name: "Same filter",
          config: { camera: { x: 9, y: 9, scale: 1.25 } },
        }),
      ],
      stub,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Same filter" }));

    expect(stub.setFilters).not.toHaveBeenCalled();
    await waitFor(() => expect(stub.cameraSet).toHaveBeenCalledWith({ x: 9, y: 9, scale: 1.25 }));
    // Reheating a settled layout would drift every node out from under the
    // camera we just restored — the exact jarring thing this avoids.
    expect(stub.reheat).not.toHaveBeenCalled();
  });

  it("waits for the first positions before setting the camera", async () => {
    const stub = stubEngine({}, []);
    stub.ticked.latest = null;
    await openMenu(
      [savedView({ id: "a", name: "Later", config: { camera: { x: 3, y: 4, scale: 1 } } })],
      stub,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    // The view fits the camera on its first tick; setting it now would be lost.
    expect(stub.cameraSet).not.toHaveBeenCalled();

    stub.ticked.latest = { n: 1 };
    await waitFor(() => expect(stub.cameraSet).toHaveBeenCalledWith({ x: 3, y: 4, scale: 1 }));
  });

  it("skips a focus node it can no longer see, in silence", async () => {
    const stub = stubEngine({}, ["obj-a"]);
    await openMenu([savedView({ id: "a", name: "Gone", config: { focus: "obj-private" } })], stub);

    fireEvent.click(await screen.findByRole("button", { name: "Gone" }));
    await waitFor(() => expect(stub.cameraSet).toHaveBeenCalled());
    expect(stub.setFocus).not.toHaveBeenCalled();
    expect(screen.queryByText(/obj-private/)).toBeNull();
  });

  it("abandons the camera restore when the load failed", async () => {
    const stub = stubEngine({
      load: {
        phase: "error",
        nodes: 0,
        edges: 0,
        pages: 0,
        truncated: null,
        droppedEdges: 0,
        error: "the graph could not be loaded",
      },
    });
    await openMenu(
      [savedView({ id: "a", name: "Nope", config: { camera: { x: 1, y: 1, scale: 1 } } })],
      stub,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Nope" }));
    expect(stub.cameraSet).not.toHaveBeenCalled();
  });

  it("shows no affordance at all on a box without the views endpoint", async () => {
    vi.spyOn(api, "views").mockRejectedValue(new Error("not_found"));
    renderMenu(stubEngine().engine);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /saved views/i })).toBeNull();
    });
  });
});
