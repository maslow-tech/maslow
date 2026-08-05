import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { TableLayout, materializeColumns, sameCellValue } from "./TableLayout";
import { applyFields, type PatchFields } from "../../views/TypeView";
import type { ListItem, PropDef } from "../../lib/api";
import { defaultConfigFor, type ViewConfig } from "../../lib/viewConfig";

/**
 * What these pin is the CONTRACT of an editable grid, not its pixels:
 *
 *  - one cell edit is one field-granular CAS patch against that row's version;
 *  - a lost write REVERTS VISIBLY and says so in the cell — never silently, and
 *    never leaving a dirty cell the member believes is saved;
 *  - a successful write leaves no conflict residue behind;
 *  - Escape cancels, Enter commits, arrows move a cell at a time;
 *  - a viewer gets values, not disabled inputs;
 *  - column show/hide and width are read from — and written back to — the one
 *    shared view config;
 *  - the new row calls the SHELL's create, never the API.
 */

const prop = (over: Partial<PropDef> & { name: string; kind: string }): PropDef => ({
  required: false,
  deprecated: false,
  ...over,
});

const defs: PropDef[] = [
  prop({ name: "city", kind: "text" }),
  prop({ name: "headcount", kind: "int" }),
  prop({ name: "status", kind: "enum", enum_values: ["open", "won"] }),
  prop({ name: "owner", kind: "ref", ref_type: "person" }),
];

const type = {
  id: 1,
  name: "company",
  label: "Companies",
  description: null,
  icon: "",
  deprecated: false,
  count: 2,
  properties: defs,
};

const row = (over: Partial<ListItem> & { id: string }): ListItem => ({
  title: "Acme",
  version: 4,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  visibility: "org",
  props: { city: "Austin", headcount: 12, status: "open" },
  ...over,
});

const baseConfig = (): ViewConfig => defaultConfigFor(type);

/**
 * The shell, in miniature: it owns `rows`, folds a successful patch in before
 * resolving, and on a LOST patch resolves having changed nothing — which is
 * exactly what the real shell does after it re-reads the row (rule 2 of
 * TypeView: `onPatch` never rejects).
 */
function Harness({
  initial = [row({ id: "a" }), row({ id: "b", title: "Beta", props: { city: "Boston" } })],
  outcome = "ok",
  readOnly = false,
  config: startConfig,
  onCreate,
  onPatchSpy,
  onConfigSpy,
}: {
  initial?: ListItem[];
  /** "ok" folds the write in; "lost" is a terminal conflict; "steal" is
   *  someone else's value winning the row. */
  outcome?: "ok" | "lost" | "steal";
  readOnly?: boolean;
  config?: ViewConfig;
  onCreate?: () => void;
  onPatchSpy?: (id: string, base: number, fields: PatchFields) => void;
  onConfigSpy?: (next: ViewConfig) => void;
}) {
  const [rows, setRows] = useState<ListItem[]>(initial);
  const [config, setConfig] = useState<ViewConfig>(startConfig ?? baseConfig());

  const onPatch = async (id: string, base: number, fields: PatchFields): Promise<void> => {
    onPatchSpy?.(id, base, fields);
    await Promise.resolve();
    if (outcome === "ok") {
      setRows((rs) => rs.map((r) => (r.id === id ? applyFields(r, fields, base + 1) : r)));
    } else if (outcome === "steal") {
      setRows((rs) =>
        rs.map((r) => (r.id === id ? { ...r, version: base + 1, props: { city: "Denver" } } : r)),
      );
    }
    // "lost": the CAS was refused, the row re-read, nothing changed here.
  };

  return (
    <MemoryRouter>
      <TableLayout
        rows={rows}
        propDefs={defs}
        config={config}
        onConfigChange={(next) => {
          onConfigSpy?.(next);
          setConfig(next);
        }}
        onPatch={onPatch}
        onOpen={() => {}}
        readOnly={readOnly}
        {...(onCreate ? { onCreate } : {})}
      />
    </MemoryRouter>
  );
}

/** The focusable grid cell for one property of one row. */
const cell = (name: string, title: string) => screen.getByLabelText(`${name} of ${title}`);

describe("sameCellValue", () => {
  it("treats null, undefined and empty string as the same emptiness", () => {
    expect(sameCellValue("text", null, undefined)).toBe(true);
    expect(sameCellValue("text", "", null)).toBe(true);
    expect(sameCellValue("text", "x", null)).toBe(false);
  });

  it('compares numbers numerically, so 3 and "3" are not a conflict', () => {
    expect(sameCellValue("int", 3, "3")).toBe(true);
    expect(sameCellValue("decimal", 3.0, "3.00")).toBe(true);
    expect(sameCellValue("int", 3, 4)).toBe(false);
  });

  it("compares a date by its day and a timestamp by its instant", () => {
    // The server echoes a full timestamp for a date we sent as yyyy-mm-dd;
    // a string compare would call that successful write a conflict.
    expect(sameCellValue("date", "2026-07-02", "2026-07-02T00:00:00.000Z")).toBe(true);
    expect(
      sameCellValue("timestamp", "2026-07-02T00:00:00Z", "2026-07-02T00:00:00.000+00:00"),
    ).toBe(true);
    expect(sameCellValue("date", "2026-07-02", "2026-07-03")).toBe(false);
  });
});

describe("materializeColumns", () => {
  it("lists every non-ref property, marking what the config shows", () => {
    const cfg = { ...baseConfig(), columns: [{ key: "status", visible: true }] };
    const cols = materializeColumns(cfg, defs);
    expect(cols.map((c) => c.key)).toEqual(["status", "city", "headcount"]);
    expect(cols.find((c) => c.key === "status")?.visible).toBe(true);
    expect(cols.find((c) => c.key === "city")?.visible).toBe(false);
  });

  it("never lists a ref — a ref is an edge, not a cell", () => {
    expect(materializeColumns(baseConfig(), defs).map((c) => c.key)).not.toContain("owner");
  });

  it("keeps the width the config already stored", () => {
    const cfg = { ...baseConfig(), columns: [{ key: "city", visible: true, width: 240 }] };
    expect(materializeColumns(cfg, defs).find((c) => c.key === "city")?.width).toBe(240);
  });
});

describe("TableLayout", () => {
  it("renders one cell per visible column and hides the rest", () => {
    render(<Harness config={{ ...baseConfig(), columns: [{ key: "city", visible: true }] }} />);
    expect(cell("city", "Acme")).toBeInTheDocument();
    expect(screen.queryByLabelText("headcount of Acme")).not.toBeInTheDocument();
  });

  it("sends ONE field-granular CAS patch against that row's own version", async () => {
    const patches: Array<[string, number, PatchFields]> = [];
    render(<Harness onPatchSpy={(id, base, fields) => patches.push([id, base, fields])} />);

    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Edit /));
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "Boulder" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual(["a", 4, { props: { city: "Boulder" } }]);
    // Only the one key travels — never the whole props object, which would
    // revert what an agent wrote into this row a second ago.
    expect(Object.keys(patches[0]![2].props ?? {})).toEqual(["city"]);
  });

  it("paints the new value optimistically and keeps it when the write lands", async () => {
    render(<Harness />);
    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Edit /));
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "Boulder" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(cell("city", "Acme")).toHaveTextContent("Boulder");
    await waitFor(() => expect(cell("city", "Acme")).toHaveTextContent("Boulder"));
    // A landed write leaves no residue: no conflict badge, no stuck "saving".
    expect(within(cell("city", "Acme")).queryByText("not saved")).not.toBeInTheDocument();
    expect(cell("city", "Acme")).not.toHaveAttribute("data-saving");
  });

  it("REVERTS VISIBLY and shows an inline conflict affordance when the write is lost", async () => {
    render(<Harness outcome="lost" />);
    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Edit /));
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "Boulder" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(within(cell("city", "Acme")).getByText("not saved")).toBeInTheDocument(),
    );
    // The row is the truth again — the cell shows Austin, NOT the value the
    // member typed, and it says out loud that the edit did not save.
    expect(cell("city", "Acme")).toHaveTextContent("Austin");
    expect(cell("city", "Acme")).toHaveAttribute("aria-invalid", "true");
    expect(within(cell("city", "Acme")).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows the conflict when someone else's value wins the row", async () => {
    render(<Harness outcome="steal" />);
    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Edit /));
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "Boulder" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(within(cell("city", "Acme")).getByText("not saved")).toBeInTheDocument(),
    );
    expect(cell("city", "Acme")).toHaveTextContent("Denver");
  });

  it("retries a lost edit against the row's CURRENT version", async () => {
    const patches: Array<[string, number, PatchFields]> = [];
    // "steal" bumps the version to 5 while refusing our value, so a retry that
    // still used the stale base would 409 forever.
    render(<Harness outcome="steal" onPatchSpy={(id, b, f) => patches.push([id, b, f])} />);

    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Edit /));
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "Boulder" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(within(cell("city", "Acme")).getByText("not saved")).toBeInTheDocument(),
    );
    fireEvent.click(within(cell("city", "Acme")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]![1]).toBe(5);
    expect(patches[1]![2]).toEqual({ props: { city: "Boulder" } });
  });

  it("dismissing a conflict clears the badge and leaves the server's value", async () => {
    render(<Harness outcome="lost" />);
    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Edit /));
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "Boulder" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(within(cell("city", "Acme")).getByText("not saved")).toBeInTheDocument(),
    );
    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Dismiss unsaved /));
    expect(within(cell("city", "Acme")).queryByText("not saved")).not.toBeInTheDocument();
    expect(cell("city", "Acme")).toHaveTextContent("Austin");
  });

  it("Escape cancels the edit: no patch, original value back", async () => {
    const patch = vi.fn();
    render(<Harness onPatchSpy={patch} />);

    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Edit /));
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "Boulder" } });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByDisplayValue("Boulder")).not.toBeInTheDocument());
    expect(patch).not.toHaveBeenCalled();
    expect(cell("city", "Acme")).toHaveTextContent("Austin");
  });

  it("committing the value that is already there is not a write", async () => {
    const patch = vi.fn();
    render(<Harness onPatchSpy={patch} />);

    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Edit /));
    const input = screen.getByDisplayValue("Austin");
    fireEvent.change(input, { target: { value: "Austin" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByDisplayValue("Austin")).not.toBeInTheDocument());
    expect(patch).not.toHaveBeenCalled();
  });

  it("closes an editor abandoned by clicking away, so no cell looks unsaved", async () => {
    render(<Harness />);
    fireEvent.click(within(cell("city", "Acme")).getByLabelText(/^Edit /));
    const input = screen.getByDisplayValue("Austin");

    // Focus leaves the cell entirely — PropField has already committed (or, as
    // here, had nothing to commit); leaving the input up would show a dirty
    // editor over a value that is actually saved.
    fireEvent.blur(input, { relatedTarget: document.body });
    await waitFor(() => expect(screen.queryByDisplayValue("Austin")).not.toBeInTheDocument());
    expect(cell("city", "Acme")).toHaveTextContent("Austin");
  });

  it("Enter opens the editor on the focused cell", async () => {
    render(<Harness />);
    const first = cell("city", "Acme");
    first.focus();
    fireEvent.keyDown(first, { key: "Enter" });
    expect(await screen.findByDisplayValue("Austin")).toBeInTheDocument();
  });

  it("arrow keys move the grid focus one cell at a time", () => {
    render(<Harness />);
    const start = cell("city", "Acme");
    start.focus();
    expect(start).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(cell("headcount", "Acme")).toHaveFocus();

    fireEvent.keyDown(cell("headcount", "Acme"), { key: "ArrowDown" });
    expect(cell("headcount", "Beta")).toHaveFocus();

    fireEvent.keyDown(cell("headcount", "Beta"), { key: "ArrowLeft" });
    expect(cell("city", "Beta")).toHaveFocus();

    fireEvent.keyDown(cell("city", "Beta"), { key: "ArrowUp" });
    expect(cell("city", "Acme")).toHaveFocus();
  });

  it("arrows stop at the edges instead of wrapping into another row", () => {
    render(<Harness />);
    const first = cell("city", "Acme");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(cell("city", "Acme")).toHaveFocus();
    fireEvent.keyDown(cell("city", "Acme"), { key: "ArrowUp" });
    expect(cell("city", "Acme")).toHaveFocus();
  });

  it("exactly one cell is tabbable — the grid is one tab stop, not hundreds", () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('td div[tabindex="0"]')).toHaveLength(1);
  });

  it("gives a viewer values and no editors at all", () => {
    render(<Harness readOnly />);
    expect(screen.getByText("Austin")).toBeInTheDocument();
    expect(screen.queryByLabelText("city of Acme")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Edit /)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New row/ })).not.toBeInTheDocument();
  });

  it("the new row calls the shell's create — the layout never creates itself", () => {
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: /New row/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("has no new row when the shell hands it no create (viewer, trash)", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /New row/ })).not.toBeInTheDocument();
  });

  it("hiding a column writes the WHOLE column list back to the shared config", async () => {
    const changes: ViewConfig[] = [];
    render(<Harness onConfigSpy={(c) => changes.push(c)} />);

    fireEvent.click(screen.getByLabelText("Choose columns"));
    fireEvent.click(await screen.findByRole("switch", { name: /city/ }));

    expect(changes).toHaveLength(1);
    const cols = changes[0]!.columns;
    // Every candidate column is materialized, so an empty saved config cannot
    // silently re-expand to the default six on the next render.
    expect(cols.map((c) => c.key)).toEqual(["city", "headcount", "status"]);
    expect(cols.find((c) => c.key === "city")?.visible).toBe(false);
    expect(cols.find((c) => c.key === "headcount")?.visible).toBe(true);
  });

  it("refuses to hide the last visible column", async () => {
    render(<Harness config={{ ...baseConfig(), columns: [{ key: "city", visible: true }] }} />);
    fireEvent.click(screen.getByLabelText("Choose columns"));
    expect(await screen.findByRole("switch", { name: /city/ })).toBeDisabled();
  });

  it("takes the column width from the config", () => {
    const { container } = render(
      <Harness
        config={{
          ...baseConfig(),
          columns: [
            { key: "city", visible: true, width: 260 },
            { key: "headcount", visible: true },
          ],
        }}
      />,
    );
    const cols = container.querySelectorAll("colgroup col");
    // [title, city, headcount, updated, menu]
    expect((cols[1] as HTMLElement).style.width).toBe("260px");
    expect((cols[2] as HTMLElement).style.width).toBe("");
  });

  it("sorting a column asks the shell for the new order (one query, no local sort)", () => {
    const changes: ViewConfig[] = [];
    render(<Harness onConfigSpy={(c) => changes.push(c)} />);
    fireEvent.click(screen.getByText("city"));
    expect(changes[0]!.sort).toEqual([{ prop: "city", dir: "asc" }]);
  });
});
