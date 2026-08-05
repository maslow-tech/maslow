import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PropsPanel, propLabel, propLabels, toDateInput, undeclaredKeys } from "./PropsPanel";
import type { PropDef } from "../lib/api";

const def = (over: Partial<PropDef> & { name: string; kind: string }): PropDef => ({
  required: false,
  deprecated: false,
  ...over,
});

/**
 * What these pin is the write CONTRACT, not the widgets: one field edit is one
 * field-granular change, clearing is `null` (the delete sentinel) and never
 * `""`, a typo is not a value, and read-only means no inputs at all.
 */
describe("PropsPanel", () => {
  it("emits one field, one change, on blur", () => {
    const onChange = vi.fn();
    render(
      <PropsPanel
        defs={[def({ name: "city", kind: "text" }), def({ name: "notes", kind: "text" })]}
        values={{ city: "Austin", notes: "hi" }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "Denver" } });
    fireEvent.blur(input);
    expect(onChange.mock.calls).toEqual([["city", "Denver"]]);
  });

  it("clears with null, never with an empty string", () => {
    const onChange = vi.fn();
    render(
      <PropsPanel
        defs={[def({ name: "city", kind: "text" })]}
        values={{ city: "Austin" }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("city", null);
  });

  it("does not fire when nothing was typed", () => {
    const onChange = vi.fn();
    render(
      <PropsPanel
        defs={[def({ name: "city", kind: "text" })]}
        values={{ city: "Austin" }}
        onChange={onChange}
      />,
    );
    fireEvent.blur(screen.getByDisplayValue("Austin"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("parses ints as ints and refuses a typo rather than deleting the key", () => {
    const onChange = vi.fn();
    render(
      <PropsPanel
        defs={[def({ name: "bags", kind: "int" })]}
        values={{ bags: 12 }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue("12");
    fireEvent.change(input, { target: { value: "30.7" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("bags", 30);

    onChange.mockClear();
    fireEvent.change(input, { target: { value: "not a number" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps bool tri-state so 'never set' is not silently written as false", () => {
    const onChange = vi.fn();
    render(
      <PropsPanel defs={[def({ name: "signed", kind: "bool" })]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onChange).toHaveBeenCalledWith("signed", true);
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(onChange).toHaveBeenCalledWith("signed", false);
    fireEvent.click(screen.getByRole("button", { name: "—" }));
    expect(onChange).toHaveBeenCalledWith("signed", null);
  });

  it("edits a date as a date", () => {
    const onChange = vi.fn();
    render(
      <PropsPanel
        defs={[def({ name: "due", kind: "date" })]}
        values={{ due: "2026-07-21" }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue("2026-07-21");
    fireEvent.change(input, { target: { value: "2026-08-01" } });
    expect(onChange).toHaveBeenCalledWith("due", "2026-08-01");
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("due", null);
  });

  it("never edits a ref[] here — those are edges", () => {
    render(
      <PropsPanel
        defs={[def({ name: "orders", kind: "ref[]" })]}
        values={{ orders: ["a", "b"] }}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText("2 linked")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("renders read-only with no write affordance at all", () => {
    render(
      <PropsPanel
        defs={[
          def({ name: "city", kind: "text" }),
          def({ name: "signed", kind: "bool" }),
          def({ name: "stage", kind: "enum", enum_values: ["open", "won"] }),
        ]}
        values={{ city: "Austin", signed: true, stage: "won" }}
        readOnly
      />,
    );
    expect(screen.getByText("Austin")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps a deprecated property visible only while it still holds a value", () => {
    const { rerender } = render(
      <PropsPanel
        defs={[def({ name: "legacy", kind: "text", deprecated: true })]}
        values={{ legacy: "still here" }}
        readOnly
      />,
    );
    // The label is humanized — the raw snake_case identifier is never shown.
    expect(screen.getByText("Legacy")).toBeInTheDocument();
    rerender(
      <PropsPanel
        defs={[def({ name: "legacy", kind: "text", deprecated: true })]}
        values={{}}
        readOnly
      />,
    );
    expect(screen.queryByText("Legacy")).not.toBeInTheDocument();
  });

  it("renders nothing when there is nothing to show", () => {
    const { container } = render(<PropsPanel defs={[]} values={{}} readOnly />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("propLabels", () => {
  it("strips a unit suffix when the base label is unambiguous", () => {
    expect(propLabel("ceiling_usd")).toBe("Ceiling");
    const labels = propLabels(["ceiling_usd", "due_date"]);
    expect(labels.get("ceiling_usd")).toBe("Ceiling");
    expect(labels.get("due_date")).toBe("Due date");
  });

  it("keeps a disambiguating hint when two fields would collapse to one label", () => {
    const labels = propLabels(["fee_usd", "fee_pct", "value_usd", "value_eur"]);
    // Without this, `fee_usd` and `fee_pct` both render as "Fee" and a user can
    // edit the dollar amount thinking it is the percentage.
    expect(labels.get("fee_usd")).toBe("Fee (USD)");
    expect(labels.get("fee_pct")).toBe("Fee (%)");
    expect(labels.get("value_usd")).toBe("Value (USD)");
    expect(labels.get("value_eur")).toBe("Value (EUR)");
  });

  it("falls back to the raw identifier when a collision is not a unit suffix", () => {
    const labels = propLabels(["due_date", "due date"]);
    expect(labels.get("due_date")).toBe("due_date");
    expect(labels.get("due date")).toBe("due date");
  });

  it("renders the collision-safe labels in the panel, with the raw name on hover", () => {
    render(
      <PropsPanel
        defs={[def({ name: "fee_usd", kind: "number" }), def({ name: "fee_pct", kind: "number" })]}
        values={{ fee_usd: 100, fee_pct: 5 }}
        readOnly
      />,
    );
    const usd = screen.getByText("Fee (USD)");
    const pct = screen.getByText("Fee (%)");
    expect(usd).toBeInTheDocument();
    expect(pct).toBeInTheDocument();
    expect(usd).toHaveAttribute("title", "fee_usd");
    expect(pct).toHaveAttribute("title", "fee_pct");
  });
});

describe("undeclaredKeys", () => {
  it("surfaces keys the type never declared, sorted", () => {
    expect(
      undeclaredKeys([def({ name: "city", kind: "text" })], { city: "x", zip: 1, aa: 2 }),
    ).toEqual(["aa", "zip"]);
  });
});

describe("toDateInput", () => {
  it("trims a timestamp down to a date for date fields", () => {
    expect(toDateInput("2026-07-21T10:11:12Z", "date")).toBe("2026-07-21");
    expect(toDateInput(null, "date")).toBe("");
    expect(toDateInput("nonsense", "timestamp")).toBe("");
  });
});
