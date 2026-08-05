import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import BoardLayout, {
  UNCATEGORIZED,
  boardColumns,
  columnAtPoint,
  columnKeyFor,
  groupValue,
} from "./BoardLayout";
import type { PatchFields } from "../../views/TypeView";
import type { ListItem, PropDef } from "../../lib/api";
import { defaultConfigFor } from "../../lib/viewConfig";
import type { TypeSummary } from "../../lib/api";

/**
 * What these pin is the board's CONTRACT, not its pixels:
 *
 *  - a drag between columns is EXACTLY ONE patch, of exactly one property,
 *    against the row's own version — and no patch at all when the card lands
 *    where it started;
 *  - the card moves optimistically, and when the write does not land it SNAPS
 *    BACK visibly and the conflict banner appears (the terminal state is never
 *    a card sitting in a column the server never agreed to);
 *  - the keyboard alternative goes through the same single write path;
 *  - a viewer gets no write affordance at all;
 *  - columns follow the enum's declared order, and a value the enum no longer
 *    declares still gets a column instead of vanishing.
 */

// jsdom ships no PointerEvent (a real browser always has one), so
// `fireEvent.pointerDown` would fall back to a bare Event and silently drop
// clientX/clientY — every drag would look like a zero-distance press. A
// MouseEvent subclass is enough: it carries the coordinates and the buttons,
// and the board only ever reads clientX/clientY/pointerId/pointerType/button.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}
if (typeof window.PointerEvent !== "function") {
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}

const prop = (over: Partial<PropDef> & { name: string; kind: string }): PropDef => ({
  required: false,
  deprecated: false,
  ...over,
});

const deal: TypeSummary = {
  id: 7,
  name: "deal",
  label: "Deals",
  description: null,
  icon: "",
  deprecated: false,
  count: 3,
  properties: [
    prop({ name: "stage", kind: "enum", enum_values: ["new", "in_progress", "won"] }),
    prop({ name: "amount", kind: "int" }),
    prop({ name: "owner", kind: "ref", ref_type: "person" }),
  ],
};

const propDefs = deal.properties;

const row = (over: Partial<ListItem> & { id: string }): ListItem => ({
  title: `Deal ${over.id}`,
  version: 4,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  visibility: "org",
  props: { stage: "new", amount: 10 },
  ...over,
});

function config() {
  return { ...defaultConfigFor(deal), layout: "board" as const, groupBy: "stage" };
}

function applyProps(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown | null> | undefined,
): Record<string, unknown> {
  const next = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

interface HarnessProps {
  initial: ListItem[];
  /** "apply" = the write landed; "refuse" = CAS lost, the shell re-read and the
   *  row is unchanged (what the board must treat as terminal). */
  outcome?: "apply" | "refuse";
  readOnly?: boolean;
  onOpen?: (id: string) => void;
  calls: Array<{ id: string; baseVersion: number; fields: PatchFields }>;
  /** when set, the patch does not settle until this resolves */
  gate?: Promise<void>;
}

/** Stands in for the TypeView shell: it owns `rows`, and it folds the server's
 *  answer in BEFORE the patch promise resolves — exactly as the real shell
 *  does, which is the whole reason the board can tell landed from refused. */
function Harness({ initial, outcome = "apply", readOnly, onOpen, calls, gate }: HarnessProps) {
  const [rows, setRows] = useState(initial);
  const onPatch = useCallback(
    async (id: string, baseVersion: number, fields: PatchFields) => {
      calls.push({ id, baseVersion, fields });
      if (gate) await gate;
      else await Promise.resolve();
      if (outcome === "apply") {
        setRows((prev) =>
          prev.map((r) =>
            r.id === id
              ? { ...r, version: Number(r.version) + 1, props: applyProps(r.props, fields.props) }
              : r,
          ),
        );
      }
    },
    [calls, gate, outcome],
  );
  return (
    <BoardLayout
      rows={rows}
      propDefs={propDefs}
      config={config()}
      onConfigChange={() => {}}
      onPatch={onPatch}
      onOpen={onOpen ?? (() => {})}
      readOnly={readOnly ?? false}
    />
  );
}

/** jsdom has no layout, so drop zones measure as 0×0. Give each column a real
 *  rect: 100px-wide strips laid out left to right, in render order. */
function layOutColumns(): Map<string, { left: number; right: number }> {
  const boxes = new Map<string, { left: number; right: number }>();
  const zones = document.querySelectorAll<HTMLElement>("[data-column-key]");
  zones.forEach((el, i) => {
    const left = i * 100;
    const right = left + 100;
    boxes.set(el.dataset["columnKey"] ?? "", { left, right });
    el.getBoundingClientRect = () =>
      ({ left, right, top: 0, bottom: 400, width: 100, height: 400, x: left, y: 0 }) as DOMRect;
  });
  return boxes;
}

function card(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
  if (!el) throw new Error(`no card ${id}`);
  return el;
}

/** The column a card is rendered in, by its section's accessible name. */
function columnOf(id: string): string {
  const section = card(id).closest("section");
  return section?.getAttribute("aria-label") ?? "";
}

function dragCardTo(id: string, x: number): void {
  const el = card(id);
  fireEvent.pointerDown(el, { clientX: 0, clientY: 10, button: 0 });
  fireEvent.pointerMove(el, { clientX: x, clientY: 10 });
  fireEvent.pointerUp(el, { clientX: x, clientY: 10 });
}

describe("pure grouping", () => {
  it("normalizes a row's group value; unset, empty and non-scalar are Uncategorized", () => {
    expect(groupValue(row({ id: "a", props: { stage: "won" } }), "stage")).toBe("won");
    expect(groupValue(row({ id: "a", props: {} }), "stage")).toBeNull();
    expect(groupValue(row({ id: "a", props: { stage: "" } }), "stage")).toBeNull();
    expect(groupValue(row({ id: "a", props: { stage: ["x"] } }), "stage")).toBeNull();
    expect(groupValue(row({ id: "a", props: { stage: 3 } }), "stage")).toBe("3");
    expect(groupValue(row({ id: "a" }), null)).toBeNull();
  });

  it("orders columns by the enum, appends undeclared values, ends with Uncategorized", () => {
    const rows = [
      row({ id: "1", props: { stage: "won" } }),
      row({ id: "2", props: { stage: "legacy_value" } }),
      row({ id: "3", props: {} }),
    ];
    const cols = boardColumns(rows, propDefs[0] ?? null, "stage");
    expect(cols.map((c) => c.value)).toEqual(["new", "in_progress", "won", "legacy_value", null]);
    expect(cols.map((c) => c.key)).toEqual([
      "v:new",
      "v:in_progress",
      "v:won",
      "v:legacy_value",
      UNCATEGORIZED,
    ]);
    expect(cols.at(-1)?.label).toBe("Uncategorized");
  });

  it("sorts the values it found when the property declares no enum", () => {
    const rows = [row({ id: "1", props: { stage: "b" } }), row({ id: "2", props: { stage: "a" } })];
    const cols = boardColumns(rows, null, "stage");
    expect(cols.map((c) => c.key)).toEqual(["v:a", "v:b", UNCATEGORIZED]);
  });

  it("keys columns in their own namespace, so no value can collide with unset", () => {
    const rows = [row({ id: "1", props: { stage: UNCATEGORIZED } })];
    const cols = boardColumns(rows, null, "stage");
    expect(cols.map((c) => c.key)).toEqual([columnKeyFor(UNCATEGORIZED), UNCATEGORIZED]);
    expect(new Set(cols.map((c) => c.key)).size).toBe(cols.length);
  });

  it("keeps an empty Uncategorized column only where something can be dropped in it", () => {
    const rows = [row({ id: "1", props: { stage: "won" } })];
    expect(boardColumns(rows, propDefs[0] ?? null, "stage", false).map((c) => c.key)).not.toContain(
      UNCATEGORIZED,
    );
    expect(boardColumns(rows, propDefs[0] ?? null, "stage", true).map((c) => c.key)).toContain(
      UNCATEGORIZED,
    );
  });

  it("hit-tests a point against the drop zones", () => {
    const zones = [
      { key: "a", rect: { left: 0, right: 100, top: 0, bottom: 400 } },
      { key: "b", rect: { left: 100, right: 200, top: 0, bottom: 400 } },
    ];
    expect(columnAtPoint(zones, 50, 10)).toBe("a");
    expect(columnAtPoint(zones, 150, 10)).toBe("b");
    expect(columnAtPoint(zones, 150, 900)).toBeNull();
    expect(columnAtPoint(zones, 900, 10)).toBeNull();
  });
});

describe("rendering", () => {
  it("puts every card in its column, in the enum's order", () => {
    const calls: HarnessProps["calls"] = [];
    render(
      <Harness
        calls={calls}
        initial={[
          row({ id: "1", props: { stage: "won" } }),
          row({ id: "2", props: { stage: "new" } }),
          row({ id: "3", props: {} }),
        ]}
      />,
    );
    const labels = screen.getAllByRole("region").map((s) => s.getAttribute("aria-label"));
    expect(labels?.[0]).toMatch(/^new,/);
    expect(labels?.[1]).toMatch(/^in_progress,/);
    expect(labels?.[2]).toMatch(/^won,/);
    expect(labels?.[3]).toMatch(/^Uncategorized,/);
    expect(columnOf("1")).toMatch(/^won,/);
    expect(columnOf("2")).toMatch(/^new,/);
    expect(columnOf("3")).toMatch(/^Uncategorized,/);
  });

  it("says so instead of blanking when the view has nothing to group by", () => {
    const calls: HarnessProps["calls"] = [];
    render(
      <BoardLayout
        rows={[row({ id: "1" })]}
        propDefs={propDefs}
        config={{ ...config(), groupBy: null }}
        onConfigChange={() => {}}
        onPatch={async (id, v, f) => {
          calls.push({ id, baseVersion: v, fields: f });
        }}
        onOpen={() => {}}
        readOnly={false}
      />,
    );
    expect(screen.getByText(/nothing to group by/i)).toBeInTheDocument();
  });
});

describe("drag = one patch", () => {
  it("sends exactly one patch of one property against the row's version", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} initial={[row({ id: "1", version: 9 })]} />);
    layOutColumns();
    dragCardTo("1", 250); // third column: "won"

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      id: "1",
      baseVersion: 9,
      fields: { props: { stage: "won" } },
    });
    await waitFor(() => expect(columnOf("1")).toMatch(/^won,/));
  });

  it("clears the property with null when dropped in Uncategorized", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} initial={[row({ id: "1" })]} />);
    layOutColumns();
    dragCardTo("1", 350); // fourth column: Uncategorized

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.fields).toEqual({ props: { stage: null } });
  });

  it("writes nothing when the card is dropped in the column it came from", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} initial={[row({ id: "1" })]} />);
    layOutColumns();
    dragCardTo("1", 50); // first column: where it already is

    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("writes nothing when the drop lands outside every column", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} initial={[row({ id: "1" })]} />);
    layOutColumns();
    dragCardTo("1", 5000);

    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("commits even when the pointer is released off the card", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} initial={[row({ id: "1" })]} />);
    layOutColumns();
    fireEvent.pointerDown(card("1"), { clientX: 0, clientY: 10, button: 0 });
    // move + release land on the document, as they do once the card is left
    // behind and pointer capture is unavailable
    fireEvent.pointerMove(document.body, { clientX: 250, clientY: 10 });
    fireEvent.pointerUp(document.body, { clientX: 250, clientY: 10 });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.fields).toEqual({ props: { stage: "won" } });
  });

  it("abandons the drag on Escape without writing or opening", async () => {
    const calls: HarnessProps["calls"] = [];
    const onOpen = vi.fn();
    render(<Harness calls={calls} initial={[row({ id: "1" })]} onOpen={onOpen} />);
    layOutColumns();
    fireEvent.pointerDown(card("1"), { clientX: 0, clientY: 10, button: 0 });
    fireEvent.pointerMove(document.body, { clientX: 250, clientY: 10 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(document.body, { clientX: 250, clientY: 10 });
    fireEvent.click(card("1"));

    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
    expect(columnOf("1")).toMatch(/^new,/);
  });

  it("treats a press that never moved as a click that opens the object", async () => {
    const calls: HarnessProps["calls"] = [];
    const onOpen = vi.fn();
    render(<Harness calls={calls} initial={[row({ id: "1" })]} onOpen={onOpen} />);
    layOutColumns();
    fireEvent.pointerDown(card("1"), { clientX: 40, clientY: 10, button: 0 });
    fireEvent.pointerMove(document.body, { clientX: 41, clientY: 10 });
    fireEvent.pointerUp(document.body, { clientX: 41, clientY: 10 });
    fireEvent.click(card("1"));

    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(onOpen).toHaveBeenCalledWith("1");
  });

  it("moves the card before the server answers, and opens nothing on drop", async () => {
    const calls: HarnessProps["calls"] = [];
    const onOpen = vi.fn();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    render(<Harness calls={calls} initial={[row({ id: "1" })]} onOpen={onOpen} gate={gate} />);
    layOutColumns();
    dragCardTo("1", 250);

    // optimistic: already in the target column with the write still in flight
    await waitFor(() => expect(columnOf("1")).toMatch(/^won,/));
    expect(within(card("1")).getByText(/saving/i)).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(columnOf("1")).toMatch(/^won,/));
  });
});

describe("a refused write is terminal and visible", () => {
  it("snaps the card back and raises the conflict banner", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} outcome="refuse" initial={[row({ id: "1" })]} />);
    layOutColumns();
    dragCardTo("1", 250);

    await waitFor(() => expect(calls).toHaveLength(1));
    // back where it started — never left sitting in a column the server never
    // agreed to
    await waitFor(() => expect(columnOf("1")).toMatch(/^new,/));
    expect(await screen.findByText(/your version is still here/i)).toBeInTheDocument();
    expect(within(card("1")).getByText(/didn’t save/i)).toBeInTheDocument();
    // and it is announced, not only coloured
    expect(screen.getByText(/did not move to won/i)).toBeInTheDocument();
  });

  it("does not raise the banner when the write lands", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} initial={[row({ id: "1" })]} />);
    layOutColumns();
    dragCardTo("1", 250);

    await waitFor(() => expect(columnOf("1")).toMatch(/^won,/));
    expect(screen.queryByText(/your version is still here/i)).not.toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("retries the same one-property patch when the member keeps theirs", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} outcome="refuse" initial={[row({ id: "1" })]} />);
    layOutColumns();
    dragCardTo("1", 250);

    await screen.findByText(/your version is still here/i);
    fireEvent.click(screen.getByRole("button", { name: /keep mine/i }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.fields).toEqual({ props: { stage: "won" } });
  });

  it("drops the banner when the member takes theirs", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} outcome="refuse" initial={[row({ id: "1" })]} />);
    layOutColumns();
    dragCardTo("1", 250);

    await screen.findByText(/your version is still here/i);
    fireEvent.click(screen.getByRole("button", { name: /take theirs/i }));
    await waitFor(() =>
      expect(screen.queryByText(/your version is still here/i)).not.toBeInTheDocument(),
    );
    expect(calls).toHaveLength(1);
  });
});

describe("keyboard alternative", () => {
  it("moves a card with a modifier + arrow, through the same single write path", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} initial={[row({ id: "1", version: 2 })]} />);
    fireEvent.keyDown(card("1"), { key: "ArrowRight", altKey: true });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      id: "1",
      baseVersion: 2,
      fields: { props: { stage: "in_progress" } },
    });
    await waitFor(() => expect(columnOf("1")).toMatch(/^in_progress,/));
  });

  it("does not write on a bare arrow — that only moves focus", async () => {
    const calls: HarnessProps["calls"] = [];
    render(
      <Harness
        calls={calls}
        initial={[row({ id: "1" }), row({ id: "2", props: { stage: "in_progress" } })]}
      />,
    );
    fireEvent.keyDown(card("1"), { key: "ArrowRight" });
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(document.activeElement).toBe(card("2"));
  });

  it("stops at the ends of the board", async () => {
    const calls: HarnessProps["calls"] = [];
    render(<Harness calls={calls} initial={[row({ id: "1" })]} />);
    fireEvent.keyDown(card("1"), { key: "ArrowLeft", shiftKey: true });
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("opens the object on Enter", () => {
    const calls: HarnessProps["calls"] = [];
    const onOpen = vi.fn();
    render(<Harness calls={calls} initial={[row({ id: "1" })]} onOpen={onOpen} />);
    fireEvent.keyDown(card("1"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("1");
  });
});

describe("read-only", () => {
  it("draws no drag affordance and refuses both write paths", async () => {
    const calls: HarnessProps["calls"] = [];
    const onOpen = vi.fn();
    render(<Harness calls={calls} readOnly initial={[row({ id: "1" })]} onOpen={onOpen} />);
    layOutColumns();
    dragCardTo("1", 250);
    fireEvent.keyDown(card("1"), { key: "ArrowRight", altKey: true });

    await Promise.resolve();
    expect(calls).toHaveLength(0);
    // a viewer can still open a card
    fireEvent.click(card("1"));
    expect(onOpen).toHaveBeenCalledWith("1");
  });
});
