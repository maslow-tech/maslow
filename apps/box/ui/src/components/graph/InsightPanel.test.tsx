import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  INSIGHT_LIST_LIMIT,
  InsightPanelView,
  MAX_FIT_SCALE,
  PROVISIONAL_NOTE,
  VISIBILITY_NOTE,
  cameraFor,
  orphanIndices,
  orphanRows,
  topHubs,
  type InsightPanelViewProps,
  type InsightRow,
} from "./InsightPanel";
import type { GraphNode } from "../../lib/graph/types";

/**
 * What these pin is the panel's ANSWERS and its honesty, not its pixels:
 *
 *  - hubs read off the server's VISIBLE degree (never the CSR's, which lags
 *    mid-load), and never list an orphan; the broker ranking itself is Brandes,
 *    and lives in lib/graph/analysis.test.ts now that the panel runs the SHARED
 *    engine through the worker rather than a second in-panel copy;
 *  - "orphan" is read off the server's VISIBLE degree, and the panel says so in
 *    words on screen — a rank or an orphan count that shipped without
 *    `VISIBILITY_NOTE` next to it would be a quiet lie about what the viewer
 *    can see;
 *  - a row hands its dense index back on hover, on keyboard focus and on click,
 *    because that is the whole contract with the graph engine.
 */

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */
const idAt = (i: number): string | undefined => `id-${String(i).padStart(3, "0")}`;

/* ------------------------------------------------------------------ *
 * the three lists
 * ------------------------------------------------------------------ */

describe("topHubs", () => {
  it("ranks by the server's visible degree and never lists an orphan", () => {
    const nodes: GraphNode[] = [
      { id: "id-000", title: "Alpha", type: null, degree: 4 },
      { id: "id-001", title: "Bravo", type: null, degree: 9 },
      { id: "id-002", title: "Charlie", type: null, degree: 0 },
    ];
    const rows = topHubs(nodes, idAt);
    expect(rows.map((r) => r.title)).toEqual(["Bravo", "Alpha"]);
    expect(rows[0]?.value).toBe(9);
    expect(rows[0]?.index).toBe(1);
  });

  it("breaks ties on title then id, so the list does not reshuffle", () => {
    const nodes: GraphNode[] = [
      { id: "id-000", title: "Zulu", type: null, degree: 3 },
      { id: "id-001", title: "Alpha", type: null, degree: 3 },
    ];
    expect(topHubs(nodes, idAt).map((r) => r.title)).toEqual(["Alpha", "Zulu"]);
  });

  it("honours the limit", () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      id: `id-${String(i).padStart(3, "0")}`,
      title: `n${i}`,
      type: null,
      degree: i + 1,
    }));
    expect(topHubs(nodes, idAt).length).toBe(INSIGHT_LIST_LIMIT);
    expect(topHubs(nodes, idAt, 3).length).toBe(3);
  });
});

describe("orphans", () => {
  const nodes: GraphNode[] = [
    { id: "id-000", title: "Linked", type: null, degree: 2 },
    { id: "id-001", title: null, type: null, degree: 0 },
    { id: "id-002", title: "Stranded", type: null, degree: 0 },
  ];

  it("is visible degree 0, read off the server's count rather than the CSR", () => {
    // Mid-load the CSR only holds the pages that landed, so an object whose
    // neighbour is on page four would look stranded; the server's degree is
    // the whole visible truth the moment the node arrives.
    expect(orphanIndices(nodes)).toEqual([1, 2]);
  });

  it("lists orphans alphabetically by what the graph actually labels them", () => {
    const rows = orphanRows(nodes, idAt);
    expect(rows.map((r) => r.index)).toEqual([1, 2]);
    expect(rows.every((r) => r.value === 0)).toBe(true);
  });

  it("caps the listing but not the count", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `id-${String(i).padStart(3, "0")}`,
      title: `n${i}`,
      type: null,
      degree: 0,
    }));
    expect(orphanIndices(many).length).toBe(80);
    expect(orphanRows(many, idAt).length).toBe(50);
  });
});

/* ------------------------------------------------------------------ *
 * camera framing
 * ------------------------------------------------------------------ */

describe("cameraFor", () => {
  it("centers on the set and caps how far it will zoom in", () => {
    const positions = new Float32Array([0, 0, 100, 0, 900, 900]);
    const out = cameraFor(positions, { width: 800, height: 600 }, [0, 1]);
    expect(out).not.toBeNull();
    expect(out?.x).toBe(50);
    expect(out?.y).toBe(0);
    expect(out?.scale).toBe(MAX_FIT_SCALE);
  });

  it("frames a wide set below the cap", () => {
    const positions = new Float32Array([0, 0, 1000, 500]);
    const out = cameraFor(positions, { width: 800, height: 600 }, [0, 1], 80);
    expect(out?.x).toBe(500);
    expect(out?.y).toBe(250);
    // 640 / 1000 is tighter than 440 / 500, so the width wins.
    expect(out?.scale).toBeCloseTo(0.64, 5);
  });

  it("returns null when nothing in the set has a position yet", () => {
    expect(cameraFor(new Float32Array(0), { width: 800, height: 600 }, [0, 1])).toBeNull();
    expect(
      cameraFor(new Float32Array([Number.NaN, Number.NaN]), { width: 800, height: 600 }, [0]),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * the panel
 * ------------------------------------------------------------------ */

const row = (over: Partial<InsightRow> = {}): InsightRow => ({
  index: 0,
  id: "id-000",
  title: "Alpha",
  type: null,
  value: 7,
  ...over,
});

const props = (over: Partial<InsightPanelViewProps> = {}): InsightPanelViewProps => ({
  open: true,
  onOpenChange: vi.fn(),
  hubs: [row(), row({ index: 1, id: "id-001", title: "Bravo", value: 3 })],
  brokers: [row({ index: 2, id: "id-002", title: "Bridge", value: 12.5 })],
  orphans: [row({ index: 3, id: "id-003", title: "Stranded", value: 0 })],
  orphanCount: 1,
  brokerPhase: "ready",
  brokersExact: true,
  loading: false,
  sampled: false,
  onHoverRow: vi.fn(),
  onOpenRow: vi.fn(),
  orphansIsolated: false,
  onToggleOrphans: vi.fn(),
  ...over,
});

function section(name: RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("InsightPanelView", () => {
  it("says the visibility rule out loud, next to the numbers", () => {
    render(<InsightPanelView {...props()} />);
    expect(screen.getByText(VISIBILITY_NOTE)).toBeTruthy();
  });

  it("calls a rank provisional while pages are still landing", () => {
    const { rerender } = render(<InsightPanelView {...props({ loading: true })} />);
    expect(screen.getByText(PROVISIONAL_NOTE)).toBeTruthy();
    rerender(<InsightPanelView {...props({ loading: false })} />);
    expect(screen.queryByText(PROVISIONAL_NOTE)).toBeNull();
  });

  it("collapses to a single affordance and back", () => {
    const onOpenChange = vi.fn();
    render(<InsightPanelView {...props({ open: false, onOpenChange })} />);
    expect(screen.queryByText(VISIBILITY_NOTE)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /what matters here/i }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("is a top-right floating card on desktop and a bottom sheet on compact", () => {
    // Desktop: pinned top-right. Compact: a full-width bottom sheet, like the
    // rail/legend/peek, so it does not paint over the phone's top status strip
    // and the top-centre menu/search/scrubber column.
    const desktop = render(<InsightPanelView {...props()} />);
    const wide = desktop.getByRole("complementary");
    expect(wide.className).toContain("top-3");
    expect(wide.className).toContain("right-3");
    expect(wide.className).not.toContain("bottom-3");
    desktop.unmount();

    render(<InsightPanelView {...props({ compact: true })} />);
    const sheet = screen.getByRole("complementary");
    expect(sheet.className).toContain("bottom-3");
    expect(sheet.className).toContain("inset-x-3");
    expect(sheet.className).not.toContain("top-3");
  });

  it("puts the closed trigger bottom-right on compact, clear of the top strip", () => {
    const { rerender } = render(<InsightPanelView {...props({ open: false })} />);
    const deskWrap = screen.getByRole("button", { name: /what matters here/i }).parentElement;
    expect(deskWrap?.className).toContain("top-3");
    rerender(<InsightPanelView {...props({ open: false, compact: true })} />);
    const compactWrap = screen.getByRole("button", { name: /what matters here/i }).parentElement;
    expect(compactWrap?.className).toContain("bottom-3");
    expect(compactWrap?.className).not.toContain("top-3");
  });

  it("hands a hub row's dense index back on hover, on focus and on click", () => {
    const onHoverRow = vi.fn();
    const onOpenRow = vi.fn();
    render(<InsightPanelView {...props({ onHoverRow, onOpenRow })} />);

    const bravo = screen.getByRole("button", { name: /Bravo/ });
    fireEvent.pointerOver(bravo);
    expect(onHoverRow).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }), "hubs");

    onHoverRow.mockClear();
    bravo.focus();
    expect(onHoverRow).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }), "hubs");
    bravo.blur();
    expect(onHoverRow).toHaveBeenLastCalledWith(null, "hubs");

    fireEvent.click(bravo);
    expect(onOpenRow).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }), "hubs");
  });

  it("keeps brokers a separate, differently-labelled list", () => {
    render(<InsightPanelView {...props()} />);
    const header = section(/Brokers — objects joining clusters/);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Bridge/ })).toBeTruthy();
    expect(screen.getByText(/betweenness/i)).toBeTruthy();
  });

  it("says when a broker score is an estimate rather than the exact answer", () => {
    render(<InsightPanelView {...props({ brokersExact: false })} />);
    fireEvent.click(section(/Brokers/));
    expect(screen.getByText(/sampled pivots/i)).toBeTruthy();
  });

  it("explains itself instead of showing an empty broker list mid-load", () => {
    render(<InsightPanelView {...props({ brokerPhase: "waiting", brokers: [] })} />);
    fireEvent.click(section(/Brokers/));
    expect(screen.getByText(/once the whole graph has landed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Bridge/ })).toBeNull();
  });

  it("makes the orphans filter one click, and says what it did", () => {
    const onToggleOrphans = vi.fn();
    const { rerender } = render(
      <InsightPanelView {...props({ orphanCount: 12, onToggleOrphans })} />,
    );
    fireEvent.click(section(/Orphans/));
    const isolate = screen.getByRole("button", { name: /Isolate 12/ });
    expect(isolate.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(isolate);
    expect(onToggleOrphans).toHaveBeenCalledTimes(1);

    // The section's open/closed state lives in the view, so a rerender keeps
    // it open — only the label flips.
    rerender(
      <InsightPanelView {...props({ orphanCount: 12, onToggleOrphans, orphansIsolated: true })} />,
    );
    expect(screen.getByRole("button", { name: /show everything again/i })).toBeTruthy();
  });

  it("offers the link shortcut only when something can receive it", () => {
    const onLinkOrphans = vi.fn();
    const first = render(<InsightPanelView {...props()} />);
    fireEvent.click(section(/Orphans/));
    expect(screen.queryByRole("button", { name: /link selected to/i })).toBeNull();
    first.unmount();

    render(<InsightPanelView {...props({ onLinkOrphans })} />);
    fireEvent.click(section(/Orphans/));
    fireEvent.click(screen.getByRole("button", { name: /link selected to/i }));
    expect(onLinkOrphans).toHaveBeenCalledTimes(1);
  });

  it("does not pretend the listed orphans are all of them", () => {
    render(<InsightPanelView {...props({ orphanCount: 90 })} />);
    fireEvent.click(section(/Orphans/));
    expect(screen.getByText(/89 more not listed/)).toBeTruthy();
  });

  it("disables the filter when there is nothing stranded", () => {
    render(<InsightPanelView {...props({ orphanCount: 0, orphans: [] })} />);
    fireEvent.click(section(/Orphans/));
    const isolate = screen.getByRole("button", { name: /Isolate 0/ });
    expect(
      isolate.hasAttribute("disabled") || isolate.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(screen.getByText(/every object you can see has at least one link/i)).toBeTruthy();
  });

  it("suppresses orphans on a sampled graph instead of asserting there are none", () => {
    // On a top-degree sample the orphans (degree 0) are the first nodes dropped,
    // so orphanCount ≈ 0 is "not loaded", never "none exist". The section must
    // not present an authoritative empty to-do list or offer its actions.
    render(<InsightPanelView {...props({ sampled: true, orphanCount: 0, orphans: [] })} />);
    fireEvent.click(section(/Orphans/));
    expect(screen.getByText(/can't be computed on a sampled graph/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Isolate/ })).toBeNull();
    // ...and the misleading "0" count is not shown as the section total.
    expect(screen.queryByText(/every object you can see has at least one link/i)).toBeNull();
  });

  it("caveats brokers on a sampled graph", () => {
    render(<InsightPanelView {...props({ sampled: true })} />);
    fireEvent.click(section(/Brokers/));
    expect(screen.getByText(/not the whole brain/i)).toBeTruthy();
  });

  it("keeps a collapsed section's rows out of the accessibility tree", () => {
    render(<InsightPanelView {...props()} />);
    // Hubs open by default, brokers and orphans closed.
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Stranded/ })).toBeNull();
    fireEvent.click(section(/Orphans/));
    expect(screen.getByRole("button", { name: /Stranded/ })).toBeTruthy();
  });

  it("labels itself so the panel is findable by a screen reader", () => {
    render(<InsightPanelView {...props()} />);
    const panel = screen.getByRole("complementary", { name: /hubs, brokers and orphans/i });
    expect(within(panel).getByText(VISIBILITY_NOTE)).toBeTruthy();
  });
});
