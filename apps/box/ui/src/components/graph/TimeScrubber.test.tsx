import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphChangedResponse } from "../../lib/api";
import type { GraphEngine } from "../../views/GraphView";
import { DIM_ALPHA } from "../../lib/graph/highlight";
import type { HighlightSet } from "../../lib/graph/types";

/**
 * What these pin is the scrubber's CONTRACT — which is mostly a privacy
 * contract:
 *
 *  - the ONLY data source is `/api/v1/graph/changed`; nothing in this
 *    component may touch the (RLS-less) event feed, so the fetch surface is
 *    asserted, not just the output;
 *  - only ids the server returned are lit, ids the client never loaded are
 *    dropped rather than invented, and every count on screen is a count of
 *    THOSE ids;
 *  - the glow rides ONE highlight layer (`changed`) through `highlight.ts`,
 *    and the pulse is an alternating `dimAlpha` on that same layer, not a
 *    second animation system;
 *  - `prefers-reduced-motion` keeps the glow and drops the alternation;
 *  - leaving the scrubber (unmount, or "all time") never leaves the graph
 *    dimmed;
 *  - the window is stated in words, and the server's truncation flags are said
 *    out loud rather than implying the window was complete.
 */

const hoisted = vi.hoisted(() => ({
  graphChanged: vi.fn(),
  otherCalls: [] as string[],
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  const trap = (name: string) => (): never => {
    hoisted.otherCalls.push(name);
    throw new Error(`the scrubber must not call api.${name}`);
  };
  return {
    ...actual,
    api: {
      ...actual.api,
      graphChanged: hoisted.graphChanged,
      // The RLS-less feed surfaces. Touching one is a test failure by
      // construction, which is the point.
      timeline: trap("timeline"),
      feed: trap("feed"),
    },
  };
});

// The engine contract is mocked rather than mounting <GraphView> (WebGL and a
// layout worker do not exist in jsdom) — the scrubber's whole dependency is
// `useGraphEngine`, so that is the seam.
const engineState = {
  installed: [] as Array<{ source: string; set: HighlightSet | null }>,
  indexById: new Map<string, number>(),
  revision: 1,
  filters: { types: new Set<string | null>(), recency: "all" as const },
};

vi.mock("../../views/GraphView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../views/GraphView")>();
  return {
    ...actual,
    useGraphEngine: (): GraphEngine =>
      ({
        indexOf: (id: string) => engineState.indexById.get(id),
        revision: engineState.revision,
        filters: engineState.filters,
        setHighlight: (source: string, set: HighlightSet | null) => {
          engineState.installed.push({ source, set });
        },
      }) as unknown as GraphEngine,
  };
});

import {
  ALL_TIME_INDEX,
  PULSE_DIM_LOW,
  PULSE_PERIOD_MS,
  SCRUBBER_STOPS,
  SCRUB_DEBOUNCE_MS,
  TimeScrubber,
  changedCopy,
  kindSummary,
  mapChangedIds,
  sinceForStop,
  stopAt,
  stopIndexOf,
  windowCopy,
} from "./TimeScrubber";

const NOW = Date.parse("2026-07-21T18:00:00.000Z");
const clock = () => NOW;

function response(over: Partial<GraphChangedResponse> = {}): GraphChangedResponse {
  return {
    since: new Date(NOW - 7 * 86_400_000).toISOString(),
    watermark: new Date(NOW).toISOString(),
    ids: [],
    count: 0,
    byKind: {},
    truncated: null,
    feedTruncated: false,
    ...over,
  };
}

/** The last set installed on a layer, or undefined if that layer never was. */
function lastOn(source: string): HighlightSet | null | undefined {
  for (let i = engineState.installed.length - 1; i >= 0; i -= 1) {
    const row = engineState.installed[i]!;
    if (row.source === source) return row.set;
  }
  return undefined;
}

/**
 * Under fake timers, `waitFor` cannot help: the debounce is a timer and the
 * response is a microtask. Advance past the debounce, then flush.
 */
async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(SCRUB_DEBOUNCE_MS);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function setReducedMotion(reduce: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  hoisted.graphChanged.mockReset();
  hoisted.graphChanged.mockResolvedValue(response());
  hoisted.otherCalls.length = 0;
  engineState.installed.length = 0;
  engineState.indexById = new Map();
  engineState.revision = 1;
  engineState.filters = { types: new Set<string | null>(), recency: "all" };
  setReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * pure helpers
 * ------------------------------------------------------------------ */

describe("the stops", () => {
  it("runs narrow → wide and ends at all-time, so dragging right grows the set", () => {
    const hours = SCRUBBER_STOPS.map((s) => s.hours);
    const windows = hours.slice(0, -1);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]!).toBeGreaterThan(windows[i - 1]!);
    }
    expect(hours[hours.length - 1]).toBe(0);
    expect(ALL_TIME_INDEX).toBe(SCRUBBER_STOPS.length - 1);
  });

  it("resolves the four presets to real stops", () => {
    for (const key of ["24h", "7d", "30d", "all"]) {
      expect(SCRUBBER_STOPS[stopIndexOf(key)]!.key).toBe(key);
    }
  });

  it("falls back to all-time for an unknown key rather than throwing", () => {
    expect(stopIndexOf("not-a-stop")).toBe(ALL_TIME_INDEX);
  });

  it("clamps a slider value instead of reading off the end", () => {
    expect(stopAt(-5).key).toBe(SCRUBBER_STOPS[0]!.key);
    expect(stopAt(9999).key).toBe("all");
    expect(stopAt(Number.NaN).key).toBe("all");
  });
});

describe("sinceForStop", () => {
  it("is that many hours back", () => {
    const since = sinceForStop(stopAt(stopIndexOf("7d")), NOW);
    expect(since).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
  });

  it("is null for all-time — the scrubber off, nothing dimmed", () => {
    expect(sinceForStop(stopAt(ALL_TIME_INDEX), NOW)).toBeNull();
  });
});

describe("windowCopy", () => {
  it("names the instant AND the window", () => {
    const stop = stopAt(stopIndexOf("7d"));
    const copy = windowCopy(stop, sinceForStop(stop, NOW));
    expect(copy).toMatch(/^Showing changes since /);
    expect(copy).toContain("the last 7 days");
  });

  it("says plainly that all-time dims nothing", () => {
    expect(windowCopy(stopAt(ALL_TIME_INDEX), null)).toContain("nothing is dimmed");
  });
});

describe("mapChangedIds", () => {
  it("keeps only ids the client actually holds — never invents a node", () => {
    const index = new Map([
      ["a", 0],
      ["c", 4],
    ]);
    const out = mapChangedIds(["a", "b", "c"], (id) => index.get(id));
    expect([...out].sort()).toEqual([0, 4]);
  });
});

describe("kindSummary", () => {
  it("merges kinds onto the timeline's own verbs, most-frequent first", () => {
    expect(kindSummary({ create: 3, update: 5, update_props: 4 })).toBe("9 updated · 3 created");
  });

  it("is empty for an empty histogram", () => {
    expect(kindSummary({})).toBe("");
  });
});

describe("changedCopy", () => {
  it("counts the SERVER's ids, and says how many are off-view", () => {
    expect(changedCopy(10, 10)).toContain("10 objects changed");
    expect(changedCopy(10, 4)).toContain("4 glowing here");
    expect(changedCopy(10, 0)).toContain("none of them");
    expect(changedCopy(0, 0)).toBe("Nothing you can see changed in this window.");
  });
});

/* ------------------------------------------------------------------ *
 * the component
 * ------------------------------------------------------------------ */

describe("<TimeScrubber>", () => {
  it("mounts on all-time: no request, no dimming", () => {
    render(<TimeScrubber now={clock} />);
    expect(hoisted.graphChanged).not.toHaveBeenCalled();
    expect(screen.getByText(/Showing all time/)).toBeTruthy();
    expect(lastOn("changed")).toBeNull();
  });

  it("a preset asks the server for that window and nothing else", async () => {
    render(<TimeScrubber now={clock} />);
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(hoisted.graphChanged).toHaveBeenCalledTimes(1));
    expect(hoisted.graphChanged.mock.calls[0]![0]).toEqual({
      since: new Date(NOW - 7 * 86_400_000).toISOString(),
    });
    // The feed is never touched — that is the whole privacy rule.
    expect(hoisted.otherCalls).toEqual([]);
  });

  it("sends the view's own filter so the intersection matches what is on screen", async () => {
    engineState.filters = { types: new Set(["person"]), recency: "all" };
    render(<TimeScrubber now={clock} />);
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() => expect(hoisted.graphChanged).toHaveBeenCalled());
    expect(hoisted.graphChanged.mock.calls[0]![0].where).toEqual({
      field: "type",
      op: "eq",
      value: "person",
    });
  });

  it("lights ONLY the ids the server returned that this client holds", async () => {
    engineState.indexById = new Map([
      ["a", 0],
      ["b", 1],
    ]);
    hoisted.graphChanged.mockResolvedValue(
      response({ ids: ["a", "b", "never-loaded"], count: 3, byKind: { create: 3 } }),
    );
    render(<TimeScrubber now={clock} />);
    fireEvent.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() => expect(lastOn("changed")).toBeTruthy());
    const set = lastOn("changed")!;
    expect(set.kind).toBe("changed");
    expect([...set.nodes].sort()).toEqual([0, 1]);
    expect(set.dimAlpha).toBe(DIM_ALPHA.changed);
    // the count is the server's ids, and the shortfall is stated, not hidden
    expect(await screen.findByText(/3 objects changed/)).toBeTruthy();
    expect(screen.getByText(/2 glowing here/)).toBeTruthy();
  });

  it("says the server's truncation flags out loud", async () => {
    hoisted.graphChanged.mockResolvedValue(
      response({
        ids: [],
        count: 0,
        truncated: { shown: 5000, total: 41208, reason: "size" },
        feedTruncated: true,
      }),
    );
    render(<TimeScrubber now={clock} />);
    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    expect(await screen.findByText(/most-connected of/)).toBeTruthy();
    expect(screen.getByText(/older changes inside this window are not shown/)).toBeTruthy();
  });

  it("debounces a drag into ONE request", async () => {
    vi.useFakeTimers();
    render(<TimeScrubber now={clock} />);
    const slider = screen.getByLabelText("Changed since");
    for (const value of ["3", "5", "7", "9"]) {
      fireEvent.change(slider, { target: { value } });
      act(() => {
        vi.advanceTimersByTime(SCRUB_DEBOUNCE_MS - 50);
      });
    }
    act(() => {
      vi.advanceTimersByTime(SCRUB_DEBOUNCE_MS);
    });
    expect(hoisted.graphChanged).toHaveBeenCalledTimes(1);
    expect(hoisted.graphChanged.mock.calls[0]![0].since).toBe(
      sinceForStop(stopAt(9), NOW) as string,
    );
  });

  it("pulses by alternating the layer's dimAlpha — one set, not a second system", async () => {
    vi.useFakeTimers();
    engineState.indexById = new Map([["a", 0]]);
    hoisted.graphChanged.mockResolvedValue(response({ ids: ["a"], count: 1 }));
    render(<TimeScrubber now={clock} />);
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await settle();
    expect(lastOn("changed")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(PULSE_PERIOD_MS / 2);
    });
    expect(lastOn("changed")!.dimAlpha).toBe(PULSE_DIM_LOW);
    await act(async () => {
      vi.advanceTimersByTime(PULSE_PERIOD_MS / 2);
    });
    expect(lastOn("changed")!.dimAlpha).toBe(DIM_ALPHA.changed);
    // every pulse is the same membership, on the same layer
    for (const row of engineState.installed) {
      expect(row.source).toBe("changed");
      if (row.set !== null) expect([...row.set.nodes]).toEqual([0]);
    }
  });

  it("under prefers-reduced-motion the glow is steady — lit, never alternating", async () => {
    setReducedMotion(true);
    vi.useFakeTimers();
    engineState.indexById = new Map([["a", 0]]);
    hoisted.graphChanged.mockResolvedValue(response({ ids: ["a"], count: 1 }));
    render(<TimeScrubber now={clock} />);
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await settle();
    expect(lastOn("changed")).toBeTruthy();

    const installs = engineState.installed.length;
    await act(async () => {
      vi.advanceTimersByTime(PULSE_PERIOD_MS * 4);
    });
    expect(engineState.installed.length).toBe(installs);
    expect(lastOn("changed")!.dimAlpha).toBe(DIM_ALPHA.changed);
    expect(lastOn("changed")!.nodes.has(0)).toBe(true);
  });

  it("clearing back to all-time releases the dimming", async () => {
    engineState.indexById = new Map([["a", 0]]);
    hoisted.graphChanged.mockResolvedValue(response({ ids: ["a"], count: 1 }));
    render(<TimeScrubber now={clock} />);
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(lastOn("changed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Clear the since-window" }));
    await waitFor(() => expect(lastOn("changed")).toBeNull());
  });

  it("unmounting releases the dimming rather than leaving the graph dark", async () => {
    engineState.indexById = new Map([["a", 0]]);
    hoisted.graphChanged.mockResolvedValue(response({ ids: ["a"], count: 1 }));
    const view = render(<TimeScrubber now={clock} />);
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(lastOn("changed")).toBeTruthy());
    view.unmount();
    expect(lastOn("changed")).toBeNull();
  });

  it("a failed read dims nothing and says so", async () => {
    hoisted.graphChanged.mockRejectedValue(new Error("boom"));
    render(<TimeScrubber now={clock} />);
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(await screen.findByText(/Could not read what changed/)).toBeTruthy();
    expect(lastOn("changed")).toBeNull();
  });
});
