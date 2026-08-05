import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CONTROL_SPECS,
  GLOBAL_CONTROL_DEFAULTS,
  GraphControls,
  RAIL_CONTROL_DEFAULTS,
  controlSpec,
  controlsStorageKey,
  forcesFrom,
  loadControls,
  normalizeControls,
  recencySince,
  saveControls,
  useGraphControls,
  type GraphControlValues,
  type GraphControlsProps,
} from "./GraphControls";

/**
 * What these pin is the controls' CONTRACT, not their pixels:
 *
 *  - a slider value that came back out of storage is clamped, never trusted
 *    (a NaN reaching d3 turns every position into NaN and the graph silently
 *    disappears);
 *  - `repel` is a positive magnitude in the UI and a NEGATIVE charge in the
 *    force bag — a positive charge collapses the layout into a point;
 *  - the global view and the rail keep SEPARATE persisted values, which is the
 *    whole reason the hook takes a scope;
 *  - the legend IS the type filter, and it is keyboard-operable;
 *  - the search box hands matches back rather than filtering, and the rail
 *    (compact) has no search or legend at all.
 */

const props = (over: Partial<GraphControlsProps> = {}): GraphControlsProps => ({
  values: GLOBAL_CONTROL_DEFAULTS,
  onChange: vi.fn(),
  onResetForces: vi.fn(),
  ...over,
});

describe("normalizeControls", () => {
  it("clamps every slider into its own range", () => {
    const out = normalizeControls({
      center: 99,
      repel: -40,
      linkStrength: 12,
      linkDistance: 0,
      nodeSize: 100,
      labelThreshold: -3,
    });
    for (const spec of CONTROL_SPECS) {
      expect(out[spec.key]).toBeGreaterThanOrEqual(spec.min);
      expect(out[spec.key]).toBeLessThanOrEqual(spec.max);
    }
  });

  it("drops non-numbers and NaN rather than passing them on", () => {
    const out = normalizeControls({
      repel: Number.NaN,
      linkDistance: "80" as unknown as number,
    });
    expect(out.repel).toBe(GLOBAL_CONTROL_DEFAULTS.repel);
    expect(out.linkDistance).toBe(GLOBAL_CONTROL_DEFAULTS.linkDistance);
  });

  it("falls back to the base it was handed, so the rail keeps rail defaults", () => {
    expect(normalizeControls(null, RAIL_CONTROL_DEFAULTS)).toEqual(RAIL_CONTROL_DEFAULTS);
  });
});

describe("forcesFrom", () => {
  it("turns the repel magnitude into a negative charge", () => {
    expect(forcesFrom({ ...GLOBAL_CONTROL_DEFAULTS, repel: 200 }).chargeStrength).toBe(-200);
    expect(forcesFrom({ ...GLOBAL_CONTROL_DEFAULTS, repel: 0 }).chargeStrength).toBe(-0);
  });

  it("passes the other three forces through under the worker's names", () => {
    const forces = forcesFrom({
      ...GLOBAL_CONTROL_DEFAULTS,
      center: 0.1,
      linkStrength: 1.5,
      linkDistance: 120,
    });
    expect(forces).toMatchObject({
      centerStrength: 0.1,
      linkStrength: 1.5,
      linkDistance: 120,
    });
  });

  it("does not carry node size or the label threshold into the worker", () => {
    const forces = forcesFrom(GLOBAL_CONTROL_DEFAULTS) as Record<string, unknown>;
    expect(forces["nodeSize"]).toBeUndefined();
    expect(forces["labelThreshold"]).toBeUndefined();
  });
});

describe("persistence", () => {
  it("keys storage by scope so global and rail never share a value", () => {
    saveControls("global", { ...GLOBAL_CONTROL_DEFAULTS, repel: 30 });
    saveControls("rail", { ...RAIL_CONTROL_DEFAULTS, repel: 10 });
    expect(controlsStorageKey("global")).not.toBe(controlsStorageKey("rail"));
    expect(loadControls("global").repel).toBe(30);
    expect(loadControls("rail", RAIL_CONTROL_DEFAULTS).repel).toBe(10);
  });

  it("returns the defaults for a scope that was never saved", () => {
    expect(loadControls("never-saved")).toEqual(GLOBAL_CONTROL_DEFAULTS);
  });

  it("survives a corrupt blob rather than throwing", () => {
    localStorage.setItem(controlsStorageKey("global"), "{not json");
    expect(loadControls("global")).toEqual(GLOBAL_CONTROL_DEFAULTS);
    localStorage.setItem(controlsStorageKey("global"), JSON.stringify([1, 2, 3]));
    expect(loadControls("global")).toEqual(GLOBAL_CONTROL_DEFAULTS);
  });

  it("clamps a persisted out-of-range value on the way back in", () => {
    localStorage.setItem(controlsStorageKey("global"), JSON.stringify({ repel: 9999 }));
    expect(loadControls("global").repel).toBe(controlSpec("repel").max);
  });
});

function Harness({ scope, base }: { scope: string; base?: GraphControlValues }) {
  const { values, set, reset } = useGraphControls(scope, base ?? GLOBAL_CONTROL_DEFAULTS);
  return (
    <div>
      <span data-testid="repel">{values.repel}</span>
      <button onClick={() => set({ repel: 25 })}>set</button>
      <button onClick={reset}>reset</button>
    </div>
  );
}

describe("useGraphControls", () => {
  it("persists a change and reloads it for the same scope", () => {
    const first = render(<Harness scope="global" />);
    fireEvent.click(screen.getByText("set"));
    expect(screen.getByTestId("repel")).toHaveTextContent("25");
    first.unmount();

    render(<Harness scope="global" />);
    expect(screen.getByTestId("repel")).toHaveTextContent("25");
  });

  it("keeps a second scope on its own defaults", () => {
    render(<Harness scope="global" />);
    fireEvent.click(screen.getByText("set"));
    expect(loadControls("rail", RAIL_CONTROL_DEFAULTS).repel).toBe(RAIL_CONTROL_DEFAULTS.repel);
  });

  it("reset drops the stored blob and goes back to the scope's base", () => {
    render(<Harness scope="rail" base={RAIL_CONTROL_DEFAULTS} />);
    fireEvent.click(screen.getByText("set"));
    expect(localStorage.getItem(controlsStorageKey("rail"))).not.toBeNull();
    fireEvent.click(screen.getByText("reset"));
    expect(localStorage.getItem(controlsStorageKey("rail"))).toBeNull();
    expect(screen.getByTestId("repel")).toHaveTextContent(String(RAIL_CONTROL_DEFAULTS.repel));
  });
});

describe("recencySince", () => {
  it('is null for "any time"', () => {
    expect(recencySince("all")).toBeNull();
  });

  it("is an ISO instant that many days back", () => {
    const now = Date.parse("2026-07-21T00:00:00.000Z");
    expect(recencySince("7d", now)).toBe("2026-07-14T00:00:00.000Z");
  });
});

describe("<GraphControls>", () => {
  it("renders one labelled, keyboard-operable range per control", () => {
    render(<GraphControls {...props()} defaultForcesOpen />);
    for (const spec of CONTROL_SPECS) {
      const input = screen.getByLabelText(spec.label);
      expect(input).toHaveAttribute("type", "range");
      expect(input).toHaveAttribute("min", String(spec.min));
      expect(input).toHaveAttribute("max", String(spec.max));
    }
  });

  it("reports a moved slider as a patch under that control's key", () => {
    const onChange = vi.fn();
    render(<GraphControls {...props({ onChange })} defaultForcesOpen />);
    fireEvent.change(screen.getByLabelText("Link distance"), { target: { value: "150" } });
    expect(onChange).toHaveBeenCalledWith({ linkDistance: 150 });
  });

  it("shows the legend with counts and filters by type on click", () => {
    const onToggleType = vi.fn();
    render(
      <GraphControls
        {...props({
          types: [
            { type: "person", count: 12 },
            { type: null, count: 3 },
          ],
          activeTypes: new Set<string | null>(["person"]),
          onToggleType,
        })}
      />,
    );
    const person = screen.getByRole("button", { name: /person/i });
    expect(person).toHaveAttribute("aria-pressed", "true");
    expect(person).toHaveTextContent("12");
    fireEvent.click(screen.getByRole("button", { name: /untyped/i }));
    expect(onToggleType).toHaveBeenCalledWith(null);
  });

  it("offers the recency filter inline, labelled for what it DOES", () => {
    const onRecencyChange = vi.fn();
    render(<GraphControls {...props({ recency: "all", onRecencyChange })} />);
    // "Only show", not "Recency": this control removes objects from the graph,
    // where the scrubber's "Highlight changes since" only dims. The old pair of
    // interchangeable nouns made two opposite mechanics indistinguishable.
    fireEvent.change(screen.getByLabelText("Only show"), { target: { value: "30d" } });
    expect(onRecencyChange).toHaveBeenCalledWith("30d");
  });

  it("submits the search on Enter and clears it on Escape", () => {
    const onQueryChange = vi.fn();
    const onQuerySubmit = vi.fn();
    render(<GraphControls {...props({ query: "ember", onQueryChange, onQuerySubmit })} />);
    const box = screen.getByLabelText("Find a node by title");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onQuerySubmit).toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onQueryChange).toHaveBeenCalledWith("");
  });

  it("says matches are highlighted in place, never filtered away", () => {
    render(<GraphControls {...props({ query: "ember", onQueryChange: vi.fn(), matchCount: 4 })} />);
    expect(screen.getByRole("status")).toHaveTextContent("4 matches highlighted in place.");
  });

  it("wires fit — and offers no reset-camera beside it", () => {
    const onFitCamera = vi.fn();
    render(<GraphControls {...props({ onFitCamera })} />);
    fireEvent.click(screen.getByRole("button", { name: /fit/i }));
    expect(onFitCamera).toHaveBeenCalled();
    // "Reset camera" eased to world (0,0) at scale 1 — NOT the default view,
    // which is the auto-fit. It was an arbitrary spot that merely looked
    // central because the layout centres on the origin, and Fit beats it at
    // everything it was for. "Reset layout" (the forces) is a different
    // control and stays.
    expect(screen.queryByRole("button", { name: /reset camera/i })).not.toBeInTheDocument();
  });

  it("compact (the rail) drops the search box and the legend, keeps the sliders", () => {
    render(
      <GraphControls
        {...props({
          compact: true,
          query: "x",
          onQueryChange: vi.fn(),
          types: [{ type: "person", count: 2 }],
        })}
        defaultForcesOpen
      />,
    );
    expect(screen.queryByLabelText("Find a node by title")).toBeNull();
    expect(screen.queryByRole("button", { name: /person/i })).toBeNull();
    expect(screen.getByLabelText("Repel")).toBeInTheDocument();
  });
});
