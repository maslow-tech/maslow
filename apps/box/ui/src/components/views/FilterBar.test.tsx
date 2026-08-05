import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  FilterBar,
  buildFilter,
  columnEntries,
  filterChipLabel,
  filterableProps,
  fallbackDefaults,
  groupableProps,
  isDirty,
  opsForKind,
  relativeSince,
  sortableProps,
  withAddedSort,
  withAllColumns,
  withColumnVisible,
  withFilterAt,
  withGroupBy,
  withSortDirAt,
  withoutFilterAt,
  withoutSortAt,
} from "./FilterBar";
import type { PropDef } from "../../lib/api";
import type { ViewConfig } from "../../lib/viewConfig";

/**
 * What these pin is the contract the bar owes the rest of phase 3:
 *
 *  - it never offers an operator the box's query AST would refuse (the `ref[]`
 *    case is the one that actually bites — it takes eq/in and nothing else);
 *  - a draft becomes a `Filter` with the RIGHT VALUE TYPE (numbers as numbers,
 *    booleans as booleans) or it stays null, so a malformed clause cannot be
 *    added at all;
 *  - every control emits a whole new config and mutates nothing;
 *  - the degenerate configs a real box produces — a saved filter on a dropped
 *    property, a column list naming a deprecated prop, a type with no
 *    properties at all — render rather than throw.
 */

const prop = (over: Partial<PropDef> & { name: string; kind: string }): PropDef => ({
  required: false,
  deprecated: false,
  ...over,
});

const propDefs: PropDef[] = [
  prop({ name: "status", kind: "enum", enum_values: ["open", "won", "lost"] }),
  prop({ name: "city", kind: "text" }),
  prop({ name: "score", kind: "int" }),
  prop({ name: "due", kind: "date" }),
  prop({ name: "active", kind: "bool" }),
  prop({ name: "owner", kind: "ref", ref_type: "person" }),
  prop({ name: "claimed_by", kind: "ref[]", ref_type: "person" }),
  prop({ name: "legacy", kind: "text", deprecated: true }),
];

const baseConfig: ViewConfig = {
  layout: "table",
  filters: [],
  sort: [{ prop: "updated_at", dir: "desc" }],
  groupBy: "status",
  dateProp: "due",
  columns: [
    { key: "status", visible: true },
    { key: "city", visible: true, width: 220 },
    { key: "score", visible: false },
  ],
};

const cfg = (over: Partial<ViewConfig> = {}): ViewConfig => ({ ...baseConfig, ...over });

/** The button primitive may express "off" natively or through ARIA depending on
 *  how it renders; either is a correct disabled control, and the test should
 *  not care which. */
function isOff(el: HTMLElement): boolean {
  return (
    (el as HTMLButtonElement).disabled ||
    el.getAttribute("aria-disabled") === "true" ||
    el.hasAttribute("data-disabled")
  );
}

/* ------------------------------------------------------------- operator sets */

describe("opsForKind", () => {
  it("offers ref[] only the two operators the server compiles", () => {
    // compileRefListWhere: eq (one id) or in (ids). ne/is_null are a 400.
    expect(opsForKind("ref[]").map((o) => o.op)).toEqual(["eq", "in"]);
  });

  it("offers presence tests on every kind that has a real column", () => {
    for (const kind of ["text", "enum", "int", "date", "timestamp", "bool", "ref"]) {
      expect(opsForKind(kind).map((o) => o.op)).toContain("is_null");
    }
  });

  it("keeps contains off non-text kinds and multi-select on enums", () => {
    expect(opsForKind("bool").map((o) => o.op)).not.toContain("ilike");
    expect(opsForKind("int").map((o) => o.op)).not.toContain("ilike");
    expect(opsForKind("enum").map((o) => o.op)).toContain("in");
  });

  it("treats an unknown kind as not filterable rather than guessing", () => {
    expect(opsForKind("geo_point")).toEqual([]);
  });
});

/* ---------------------------------------------------------- property pickers */

describe("property universes", () => {
  it("adds the spine to the filter picker and drops deprecated props", () => {
    const names = filterableProps(propDefs).map((p) => p.name);
    expect(names).toContain("title");
    expect(names).toContain("updated_at");
    expect(names).not.toContain("legacy");
  });

  it("lets a type's own property win over the spine name", () => {
    const own = [prop({ name: "title", kind: "enum", enum_values: ["a"] })];
    const titles = filterableProps(own).filter((p) => p.name === "title");
    expect(titles).toHaveLength(1);
    expect(titles[0]!.kind).toBe("enum");
  });

  it("refuses to sort by a list property", () => {
    const names = sortableProps(propDefs).map((p) => p.name);
    expect(names).toContain("owner");
    expect(names).not.toContain("claimed_by");
  });

  it("restricts grouping to low-cardinality axes", () => {
    const names = groupableProps(propDefs).map((p) => p.name);
    expect(names).toEqual(["status", "active"]);

    const soup = [
      prop({
        name: "tag",
        kind: "enum",
        enum_values: Array.from({ length: 13 }, (_, i) => `t${i}`),
      }),
    ];
    expect(groupableProps(soup)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ columns */

describe("columnEntries", () => {
  it("keeps the saved order, drops dead keys, and appends new props hidden", () => {
    const config = cfg({
      columns: [
        { key: "city", visible: true },
        { key: "gone", visible: true },
        { key: "status", visible: false },
      ],
    });
    expect(columnEntries(config, propDefs)).toEqual([
      { key: "city", label: "city", visible: true },
      { key: "status", label: "status", visible: false },
      { key: "score", label: "score", visible: false },
      { key: "due", label: "due", visible: false },
      { key: "active", label: "active", visible: false },
    ]);
  });

  it("never lists a ref as a column", () => {
    const keys = columnEntries(cfg({ columns: [] }), propDefs).map((c) => c.key);
    expect(keys).not.toContain("owner");
    expect(keys).not.toContain("claimed_by");
  });
});

/* -------------------------------------------------------------- chip labels */

describe("filterChipLabel", () => {
  it("reads in the property's own kind", () => {
    expect(filterChipLabel({ prop: "status", op: "eq", value: "open" }, propDefs)).toBe(
      "status is open",
    );
    expect(filterChipLabel({ prop: "city", op: "ilike", value: "aus" }, propDefs)).toBe(
      "city contains aus",
    );
    expect(filterChipLabel({ prop: "active", op: "eq", value: true }, propDefs)).toBe(
      "active is yes",
    );
  });

  it("joins an any-of and drops the value for a presence test", () => {
    expect(filterChipLabel({ prop: "status", op: "in", value: ["open", "won"] }, propDefs)).toBe(
      "status is any of open, won",
    );
    expect(filterChipLabel({ prop: "city", op: "is_null" }, propDefs)).toBe("city is empty");
  });

  it("still says something true about a property the catalog lost", () => {
    expect(filterChipLabel({ prop: "dropped_prop", op: "gte", value: 3 }, propDefs)).toBe(
      "dropped prop ≥ 3",
    );
  });
});

/* ------------------------------------------------------------ draft building */

describe("buildFilter", () => {
  const p = (name: string) => propDefs.find((x) => x.name === name)!;

  it("coerces to the type the query AST checks for", () => {
    expect(buildFilter(p("score"), "gte", { text: "12", values: [] })).toEqual({
      prop: "score",
      op: "gte",
      value: 12,
    });
    expect(buildFilter(p("active"), "eq", { text: "false", values: [] })).toEqual({
      prop: "active",
      op: "eq",
      value: false,
    });
    expect(buildFilter(p("city"), "ilike", { text: "  austin ", values: [] })).toEqual({
      prop: "city",
      op: "ilike",
      value: "austin",
    });
  });

  it("returns null instead of a half-filter", () => {
    expect(buildFilter(p("city"), "eq", { text: "   ", values: [] })).toBeNull();
    expect(buildFilter(p("score"), "eq", { text: "twelve", values: [] })).toBeNull();
    expect(buildFilter(p("status"), "in", { text: "", values: [] })).toBeNull();
  });

  it("takes enum any-of from the multi-select and ref any-of from a list", () => {
    expect(buildFilter(p("status"), "in", { text: "", values: ["open", "won"] })).toEqual({
      prop: "status",
      op: "in",
      value: ["open", "won"],
    });
    expect(buildFilter(p("claimed_by"), "in", { text: "id-1, id-2 ,", values: [] })).toEqual({
      prop: "claimed_by",
      op: "in",
      value: ["id-1", "id-2"],
    });
  });

  it("drops the value entirely for a presence test", () => {
    expect(buildFilter(p("city"), "is_null", { text: "typed then switched", values: [] })).toEqual({
      prop: "city",
      op: "is_null",
    });
  });
});

describe("relativeSince", () => {
  it("materializes a concrete date, day-granular", () => {
    expect(relativeSince(7, new Date("2026-07-21T13:45:00Z"))).toBe("2026-07-14");
    expect(relativeSince(30, new Date("2026-01-05T00:00:00Z"))).toBe("2025-12-06");
  });
});

/* ----------------------------------------------------------------- reducers */

describe("reducers", () => {
  it("add / replace / remove a filter without mutating the input", () => {
    const config = cfg({ filters: [{ prop: "city", op: "eq", value: "Austin" }] });
    const before = JSON.stringify(config);

    const added = withFilterAt(config, null, { prop: "score", op: "gt", value: 3 });
    expect(added.filters).toHaveLength(2);

    const replaced = withFilterAt(config, 0, { prop: "city", op: "eq", value: "Denver" });
    expect(replaced.filters).toEqual([{ prop: "city", op: "eq", value: "Denver" }]);

    expect(withoutFilterAt(config, 0).filters).toEqual([]);
    expect(JSON.stringify(config)).toBe(before);
  });

  it("keeps sort keys unique and flips one direction at a time", () => {
    const two = withAddedSort(cfg({ sort: [{ prop: "status", dir: "asc" }] }), "city");
    expect(two.sort).toEqual([
      { prop: "status", dir: "asc" },
      { prop: "city", dir: "asc" },
    ]);
    expect(withAddedSort(two, "city").sort).toHaveLength(2);
    expect(withSortDirAt(two, 1, "desc").sort[0]).toEqual({ prop: "status", dir: "asc" });
    expect(withSortDirAt(two, 1, "desc").sort[1]).toEqual({ prop: "city", dir: "desc" });
    expect(withoutSortAt(two, 0).sort).toEqual([{ prop: "city", dir: "asc" }]);
  });

  it("clears grouping with null rather than an empty string", () => {
    expect(withGroupBy(cfg(), null).groupBy).toBeNull();
    expect(withGroupBy(cfg(), "active").groupBy).toBe("active");
  });

  it("resolves the whole column list on the first toggle and keeps widths", () => {
    const next = withColumnVisible(cfg(), propDefs, "score", true);
    expect(next.columns.map((c) => c.key)).toEqual(["status", "city", "score", "due", "active"]);
    expect(next.columns.find((c) => c.key === "score")!.visible).toBe(true);
    expect(next.columns.find((c) => c.key === "city")!.width).toBe(220);
  });

  it("refuses to hide the last visible column", () => {
    const one = cfg({
      columns: [
        { key: "status", visible: true },
        { key: "city", visible: false },
      ],
    });
    expect(withColumnVisible(one, propDefs, "status", false)).toBe(one);
  });

  it("shows everything without losing widths", () => {
    const all = withAllColumns(cfg(), propDefs);
    expect(all.columns.every((c) => c.visible)).toBe(true);
    expect(all.columns.find((c) => c.key === "city")!.width).toBe(220);
  });

  it("knows when there is nothing to reset", () => {
    expect(isDirty(cfg(), cfg())).toBe(false);
    expect(isDirty(cfg({ filters: [{ prop: "city", op: "eq", value: "x" }] }), cfg())).toBe(true);
    // A width dragged in the table is not "a view to reset".
    const wider = cfg({ columns: baseConfig.columns.map((c) => ({ ...c, width: 400 })) });
    expect(isDirty(wider, cfg())).toBe(false);
  });

  it("falls back to a filter-free, recency-ordered view when no defaults are given", () => {
    const fb = fallbackDefaults(cfg({ filters: [{ prop: "city", op: "eq", value: "x" }] }));
    expect(fb.filters).toEqual([]);
    expect(fb.sort).toEqual([{ prop: "updated_at", dir: "desc" }]);
    expect(fb.groupBy).toBe("status");
  });
});

/* --------------------------------------------------------------- the rendered bar */

describe("<FilterBar />", () => {
  it("renders a chip per filter and removes one without mutating the config", () => {
    const config = cfg({
      filters: [
        { prop: "status", op: "eq", value: "open" },
        { prop: "score", op: "gte", value: 10 },
      ],
    });
    const before = JSON.stringify(config);
    const onChange = vi.fn();
    render(<FilterBar propDefs={propDefs} config={config} onChange={onChange} />);

    expect(screen.getByText("status is open")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "remove filter score ≥ 10" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].filters).toEqual([
      { prop: "status", op: "eq", value: "open" },
    ]);
    expect(JSON.stringify(config)).toBe(before);
  });

  it("offers clear-all only once a second filter exists", () => {
    const one = cfg({ filters: [{ prop: "city", op: "eq", value: "Austin" }] });
    const onChange = vi.fn();
    const { rerender } = render(<FilterBar propDefs={propDefs} config={one} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();

    rerender(
      <FilterBar
        propDefs={propDefs}
        config={cfg({
          filters: [
            { prop: "city", op: "eq", value: "Austin" },
            { prop: "score", op: "gt", value: 1 },
          ],
        })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(onChange.mock.calls[0]![0].filters).toEqual([]);
  });

  it("resets to the supplied defaults, and is inert when there is nothing to reset", () => {
    const defaults = cfg();
    const onChange = vi.fn();
    const { rerender } = render(
      <FilterBar propDefs={propDefs} config={cfg()} onChange={onChange} defaults={defaults} />,
    );
    expect(isOff(screen.getByRole("button", { name: /reset/i }))).toBe(true);

    rerender(
      <FilterBar
        propDefs={propDefs}
        config={cfg({ filters: [{ prop: "city", op: "eq", value: "Austin" }] })}
        onChange={onChange}
        defaults={defaults}
      />,
    );
    const reset = screen.getByRole("button", { name: /reset/i });
    expect(isOff(reset)).toBe(false);
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith(defaults);
    expect(onChange.mock.calls[0]![0]).not.toBe(defaults);
  });

  it("summarizes the sort and counts hidden columns", () => {
    render(
      <FilterBar
        propDefs={propDefs}
        config={cfg({
          sort: [
            { prop: "updated_at", dir: "desc" },
            { prop: "city", dir: "asc" },
          ],
        })}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /updated at ↓ \+1/ })).toBeInTheDocument();
    // status + city visible, score hidden, due/active not in the saved list yet.
    expect(screen.getByRole("button", { name: /3 hidden/ })).toBeInTheDocument();
  });

  it("says why grouping is unavailable instead of offering an empty picker", () => {
    const flat = [prop({ name: "city", kind: "text" })];
    render(<FilterBar propDefs={flat} config={cfg({ groupBy: null })} onChange={vi.fn()} />);
    const group = screen.getByRole("button", { name: /group/i });
    expect(isOff(group)).toBe(true);
    expect(group.getAttribute("title") ?? "").toContain("enum");
  });

  it("renders a type with no properties at all", () => {
    const empty = cfg({ filters: [], columns: [], groupBy: null });
    render(<FilterBar propDefs={[]} config={empty} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /filter/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /columns/i })).toBeInTheDocument();
  });

  it("hides the pickers a layout has no use for", () => {
    render(
      <FilterBar
        propDefs={propDefs}
        config={cfg()}
        onChange={vi.fn()}
        showGroupBy={false}
        showColumns={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /columns/i })).toBeNull();
    expect(screen.queryByLabelText("group by")).toBeNull();
  });
});

/**
 * The interactive path, driven the way a member drives it: open the control,
 * choose, commit. These are the tests that would have caught the menu-label
 * crash and the trigger showing a raw `ilike` where the label belongs.
 */
describe("<FilterBar /> interactions", () => {
  it("builds a filter from property → operator → value", () => {
    const onChange = vi.fn();
    render(<FilterBar propDefs={propDefs} config={cfg()} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /^filter$/i }));
    fireEvent.click(screen.getByLabelText("filter property"));
    fireEvent.click(screen.getByRole("option", { name: /^status/ }));

    // The closed trigger reads the operator's LABEL, never the stored value.
    expect(screen.getByLabelText("operator").textContent).toContain("is");

    fireEvent.click(screen.getByLabelText("value"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "open",
      "won",
      "lost",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "open" }));
    fireEvent.click(screen.getByRole("button", { name: /add filter/i }));

    expect(onChange.mock.calls[0]![0].filters).toEqual([
      { prop: "status", op: "eq", value: "open" },
    ]);
  });

  it("edits an existing chip from its current value", () => {
    const onChange = vi.fn();
    const config = cfg({ filters: [{ prop: "city", op: "eq", value: "Austin" }] });
    render(<FilterBar propDefs={propDefs} config={config} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "edit filter city is Austin" }));
    const value = screen.getByLabelText("value");
    expect((value as HTMLInputElement).value).toBe("Austin");
    fireEvent.change(value, { target: { value: "Denver" } });
    fireEvent.click(screen.getByRole("button", { name: /update filter/i }));

    expect(onChange.mock.calls[0]![0].filters).toEqual([
      { prop: "city", op: "eq", value: "Denver" },
    ]);
  });

  it("toggles a column from the menu and resolves the whole list", () => {
    const onChange = vi.fn();
    render(<FilterBar propDefs={propDefs} config={cfg()} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /columns/i }));
    expect(screen.getAllByRole("menuitemcheckbox").map((i) => i.textContent)).toEqual([
      "status",
      "city",
      "score",
      "due",
      "active",
    ]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "city" }));

    expect(onChange.mock.calls[0]![0].columns).toEqual([
      { key: "status", visible: true },
      { key: "city", visible: false, width: 220 },
      { key: "score", visible: false },
      { key: "due", visible: false },
      { key: "active", visible: false },
    ]);
  });

  it("flips a sort direction from the sort popover", () => {
    const onChange = vi.fn();
    render(<FilterBar propDefs={propDefs} config={cfg()} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /updated at ↓/ }));
    fireEvent.click(screen.getByRole("button", { name: "sort updated at ascending" }));

    expect(onChange.mock.calls[0]![0].sort).toEqual([{ prop: "updated_at", dir: "asc" }]);
  });
});
