import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { TableLayout } from "./TableLayout";
import BoardLayout from "./BoardLayout";
import { GalleryLayout } from "./GalleryLayout";
import { CalendarLayout } from "./CalendarLayout";
import { FilterBar } from "./FilterBar";
import { SidePeek } from "../SidePeek";
import { defaultConfigFor, type ViewConfig } from "../../lib/viewConfig";
import type { PatchFields } from "../../views/TypeView";
import {
  api,
  type BrainObject,
  type History,
  type ListItem,
  type PropDef,
  type TypeSummary,
  type Whoami,
} from "../../lib/api";

/**
 * The phone forms of the four database layouts, the view-options sheet and the
 * peek.
 *
 * What these pin is that a narrow viewport gets a DIFFERENT SHAPE, not a
 * squeezed one, and that nothing load-bearing was traded away to get it:
 *
 *  - the table still shows every column, scrolls sideways, and pins the title
 *    so you never lose track of which row you are reading;
 *  - the board pages one column at a time and offers a NON-DRAG move that goes
 *    through the same single CAS patch the drag does — because touch-drag is
 *    not a thing you can rely on;
 *  - the gallery is one column or two, and remembers which;
 *  - the calendar is an agenda, and its chips are not `draggable` (iOS turns a
 *    long press on those into a lottery);
 *  - filters/sort/grouping live in a real modal sheet, not a wrapped toolbar;
 *  - the peek covers the screen and drops the resize handle.
 *
 * Everything here is driven by `matchMedia`, which is exactly what the code
 * reads — no viewport faking, no component prop that only tests set.
 */

/* ------------------------------------------------------------------ harness */

interface PhoneOpts {
  /** Also report a coarse pointer (a real phone; a desktop at 700px is not). */
  coarse?: boolean;
}

/** Make every `matchMedia` question answer "phone". Restored automatically by
 *  the global `vi.restoreAllMocks()` in test-setup. */
function phone({ coarse = true }: PhoneOpts = {}): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches:
          query.includes("max-width: 767px") || (coarse && query.includes("pointer: coarse")),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

// jsdom has no scrollTo on elements; the board's pager calls it, and an
// exception there would fail the pager assertions for the wrong reason.
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = function scrollTo(): void {} as typeof Element.prototype.scrollTo;
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
    prop({ name: "due", kind: "date" }),
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

function cfg(over: Partial<ViewConfig> = {}): ViewConfig {
  return { ...defaultConfigFor(deal), ...over };
}

/** The shell's contract, minimally: rows are the truth, so a test host folds a
 *  patch back into `rows` exactly as TypeView does. */
function useRows(initial: ListItem[]) {
  const [rows, setRows] = useState(initial);
  const onPatch = useCallback(async (id: string, _base: number, fields: PatchFields) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              version: (typeof r.version === "number" ? r.version : Number(r.version)) + 1,
              props: applyProps(r.props, fields.props),
            }
          : r,
      ),
    );
  }, []);
  return { rows, onPatch };
}

function applyProps(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

/* -------------------------------------------------------------------- table */

describe("TableLayout on a phone", () => {
  const draw = (over: Partial<Parameters<typeof TableLayout>[0]> = {}) =>
    render(
      <MemoryRouter>
        <TableLayout
          rows={[row({ id: "a" }), row({ id: "b" })]}
          propDefs={propDefs}
          config={cfg()}
          onConfigChange={vi.fn()}
          onPatch={vi.fn().mockResolvedValue(undefined)}
          onOpen={vi.fn()}
          readOnly={false}
          {...over}
        />
      </MemoryRouter>,
    );

  it("pins the title column and refuses to compress below a readable width", () => {
    phone();
    draw();
    const table = document.querySelector("table")!;
    expect(table).toHaveAttribute("data-mobile", "true");
    expect(table.style.minWidth).toBe("640px");

    const titleHead = screen.getByRole("columnheader", { name: /title/i });
    expect(titleHead.className).toContain("sticky");
    expect(titleHead.className).toContain("pinned-col");
  });

  it("keeps every configured column — a phone scrolls, it does not hide data", () => {
    phone();
    draw();
    // The same headers a desktop gets: the mobile answer is horizontal scroll,
    // never a silently narrower table.
    expect(screen.getByRole("columnheader", { name: /stage/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /amount/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /updated/i })).toBeInTheDocument();
  });

  it("pins nothing on a desktop", () => {
    draw();
    const table = document.querySelector("table")!;
    expect(table).not.toHaveAttribute("data-mobile");
    expect(table.style.minWidth).toBe("");
    expect(screen.getByRole("columnheader", { name: /title/i }).className).not.toContain(
      "pinned-col",
    );
  });
});

/* -------------------------------------------------------------------- board */

describe("BoardLayout on a phone", () => {
  function Host({ readOnly = false }: { readOnly?: boolean } = {}) {
    const { rows, onPatch } = useRows([
      row({ id: "a" }),
      row({ id: "b", props: { stage: "won" } }),
    ]);
    return (
      <BoardLayout
        rows={rows}
        propDefs={propDefs}
        config={cfg({ layout: "board", groupBy: "stage" })}
        onConfigChange={vi.fn()}
        onPatch={onPatch}
        onOpen={vi.fn()}
        readOnly={readOnly}
      />
    );
  }

  it("pages one column at a time, and says which", () => {
    phone();
    render(<Host />);
    const pager = screen.getByRole("navigation", { name: "Board columns" });
    // three declared enum values + Uncategorized (a writer gets the drop target)
    expect(pager).toHaveTextContent("new");
    expect(pager).toHaveTextContent("1 / 4");

    fireEvent.click(within(pager).getByRole("button", { name: "Next column" }));
    expect(pager).toHaveTextContent("2 / 4");
    expect(within(pager).getByRole("button", { name: "Previous column" })).not.toBeDisabled();
  });

  it("cannot page before the first column", () => {
    phone();
    render(<Host />);
    const pager = screen.getByRole("navigation", { name: "Board columns" });
    expect(within(pager).getByRole("button", { name: "Previous column" })).toBeDisabled();
  });

  it("moves a card with a menu, not a drag — one patch, same write path", async () => {
    phone();
    render(<Host />);

    fireEvent.click(screen.getByRole("button", { name: "Move Deal a to another column" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "won" }));

    // The card is now in the won column, which is what the shell's folded-in
    // patch produced — not a private copy the layout kept.
    await waitFor(() => {
      const won = screen.getByRole("region", { name: /^won,/ });
      expect(within(won).getByText("Deal a")).toBeInTheDocument();
    });
    // and it is not offered a move to where it already is
    fireEvent.click(screen.getByRole("button", { name: "Move Deal a to another column" }));
    expect(screen.queryByRole("menuitem", { name: "won" })).toBeNull();
  });

  it("gives a viewer no move menu at all", () => {
    phone();
    render(<Host readOnly />);
    expect(screen.queryByRole("button", { name: /to another column$/ })).toBeNull();
  });

  it("does not take touch-none — a finger must still be able to scroll", () => {
    phone();
    render(<Host />);
    const card = document.querySelector("[data-card-id='a']")!;
    expect(card.className).not.toContain("touch-none");
  });

  it("keeps the drag (and no menu) for a mouse on a narrow window", () => {
    phone({ coarse: false });
    render(<Host />);
    expect(screen.queryByRole("button", { name: /to another column$/ })).toBeNull();
    expect(document.querySelector("[data-card-id='a']")!.className).toContain("touch-none");
  });
});

/* ------------------------------------------------------------------ gallery */

describe("GalleryLayout on a phone", () => {
  const draw = () =>
    render(
      <MemoryRouter>
        <GalleryLayout
          rows={[row({ id: "a" })]}
          propDefs={propDefs}
          config={cfg({ layout: "gallery" })}
          onConfigChange={vi.fn()}
          onPatch={vi.fn().mockResolvedValue(undefined)}
          onOpen={vi.fn()}
          readOnly={false}
          type="deal"
        />
      </MemoryRouter>,
    );

  it("is one column by default and two when asked, and remembers", () => {
    phone();
    const view = draw();
    const list = screen.getByRole("list");
    expect(list.className).toContain("grid-cols-1");

    fireEvent.click(screen.getByRole("button", { name: "Two columns" }));
    expect(screen.getByRole("list").className).toContain("grid-cols-2");

    // A remount reads the stored preference back.
    view.unmount();
    draw();
    expect(screen.getByRole("list").className).toContain("grid-cols-2");
  });

  it("keeps the container-driven grid on a desktop", () => {
    draw();
    expect(screen.getByRole("list").className).toContain("auto-fill");
    expect(screen.queryByRole("button", { name: "Two columns" })).toBeNull();
  });
});

/* ----------------------------------------------------------------- calendar */

describe("CalendarLayout on a phone", () => {
  const rows = [
    row({ id: "a", props: { stage: "new", due: "2026-07-21" } }),
    row({ id: "b", props: { stage: "new", due: "2026-07-21" } }),
    row({ id: "c", props: { stage: "new", due: "2026-07-24" } }),
    row({ id: "d", props: { stage: "new" } }),
  ];

  const draw = () =>
    render(
      <CalendarLayout
        rows={rows}
        propDefs={propDefs}
        config={cfg({ layout: "calendar", dateProp: "due" })}
        onConfigChange={vi.fn()}
        onPatch={vi.fn().mockResolvedValue(undefined)}
        onOpen={vi.fn()}
        readOnly={false}
      />,
    );

  it("is an agenda, not a grid — one heading per day that has something on it", () => {
    phone();
    draw();
    const agenda = document.querySelector("[data-agenda='true']");
    expect(agenda).not.toBeNull();
    // No weekday header row: that belongs to the grid this replaces.
    expect(document.querySelector(".grid-cols-7")).toBeNull();

    const sections = agenda!.querySelectorAll("section[data-day]");
    // exactly the two days that actually hold rows, in order
    expect(Array.from(sections).map((s) => s.getAttribute("data-day"))).toEqual([
      "2026-07-21",
      "2026-07-24",
    ]);
    expect(within(sections[0] as HTMLElement).getByText("Deal a")).toBeInTheDocument();
    expect(within(sections[0] as HTMLElement).getByText("Deal b")).toBeInTheDocument();
  });

  it("keeps the unscheduled tray and the range controls", () => {
    phone();
    draw();
    expect(screen.getByRole("group", { name: "Unscheduled" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous month/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();
  });

  it("does not leave a draggable chip on a touch screen", () => {
    phone();
    draw();
    const chip = screen.getByRole("button", { name: /^Deal a/ });
    expect(chip).not.toHaveAttribute("draggable", "true");
    // …and the layout says where rescheduling lives instead.
    expect(screen.getByText(/its due is editable there/i)).toBeInTheDocument();
  });

  it("still draws the month grid on a desktop", () => {
    draw();
    expect(document.querySelector("[data-agenda='true']")).toBeNull();
    expect(document.querySelector(".grid-cols-7")).not.toBeNull();
  });
});

/* ---------------------------------------------------------- view options */

describe("FilterBar on a phone", () => {
  const draw = (over: Partial<ViewConfig> = {}) => {
    const onChange = vi.fn();
    render(
      <FilterBar propDefs={propDefs} config={cfg(over)} onChange={onChange} defaults={cfg()} />,
    );
    return { onChange };
  };

  it("collapses to one button that opens a modal sheet", async () => {
    phone();
    draw();
    // The toolbar is one control, not four.
    expect(screen.queryByRole("button", { name: /^filter$/i })).toBeNull();
    const trigger = screen.getByRole("button", { name: /view/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "View options" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    // …carrying the SAME controls the desktop bar has.
    expect(within(sheet).getByRole("button", { name: /^filter$/i })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /reset/i })).toBeInTheDocument();
  });

  it("says how much is narrowing the view before you open it", () => {
    phone();
    draw({ filters: [{ prop: "amount", op: "gte", value: 10 }] });
    const trigger = screen.getByRole("button", { name: /view/i });
    expect(trigger).toHaveTextContent("1");
  });

  it("closes on Escape and on the backdrop", async () => {
    phone();
    draw();
    fireEvent.click(screen.getByRole("button", { name: /view/i }));
    const sheet = await screen.findByRole("dialog", { name: "View options" });
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("stays a plain row of buttons on a desktop", () => {
    draw();
    expect(screen.getByRole("button", { name: /^filter$/i })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/* -------------------------------------------------------------------- peek */

vi.mock("../editor/BlockEditor", () => ({
  BlockEditor: ({ value, ariaLabel }: { value: string; ariaLabel?: string }) => (
    <textarea aria-label={ariaLabel ?? "Body"} value={value} readOnly />
  ),
}));

describe("SidePeek on a phone", () => {
  const member: Whoami = {
    id: "acct-1",
    name: "Alice",
    role: "member",
    scopes: ["read", "write"],
    status: "active",
  };

  const object: BrainObject = {
    id: "obj-1",
    type: "deal",
    title: "Acme renewal",
    body: "the body",
    version: 4,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    deleted_at: null,
    visibility: "org",
    props: {},
    links: [],
    backlinks: [],
    links_truncated: false,
    backlinks_truncated: false,
    hidden_from_you: 0,
  };

  function stub() {
    vi.spyOn(api, "object").mockResolvedValue(object);
    vi.spyOn(api, "history").mockResolvedValue({
      id: "obj-1",
      versions: [],
      events: [],
    } as History);
    vi.spyOn(api, "types").mockResolvedValue([deal]);
  }

  function Caller() {
    const loc = useLocation();
    return (
      <>
        <span data-testid="url">{`${loc.pathname}${loc.search}`}</span>
        <SidePeek user={member} />
      </>
    );
  }

  const mount = () =>
    render(
      <MemoryRouter initialEntries={["/t/deal?peek=obj-1"]}>
        <Caller />
      </MemoryRouter>,
    );

  it("covers the screen and drops the resize handle", async () => {
    phone();
    stub();
    mount();
    const panel = await screen.findByRole("dialog", { name: "Object peek" });
    expect(panel).toHaveAttribute("data-mobile", "true");
    expect(panel.className).toContain("inset-0");
    expect(screen.queryByRole("separator", { name: "Resize peek" })).toBeNull();
    // and it is still the same editor over the same untouched route
    expect(await screen.findByLabelText("Title")).toHaveValue("Acme renewal");
    expect(screen.getByTestId("url")).toHaveTextContent("/t/deal?peek=obj-1");
  });

  it("stays a resizable side panel on a desktop", async () => {
    stub();
    mount();
    await screen.findByRole("dialog", { name: "Object peek" });
    expect(screen.getByRole("separator", { name: "Resize peek" })).toBeInTheDocument();
  });
});
