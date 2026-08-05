import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILTIN_LAYOUTS,
  TypeView,
  type LayoutComponent,
  type LayoutProps,
  type LiveSubscribe,
  type PatchFields,
} from "../../views/TypeView";
import {
  api,
  ConflictError,
  type ListItem,
  type PropDef,
  type TypeSummary,
  type Whoami,
} from "../../lib/api";
import {
  defaultConfigFor,
  writeViewConfig,
  type Layout,
  type ViewConfig,
} from "../../lib/viewConfig";

/**
 * The four layouts, tested through the ONE contract they share.
 *
 * These do not import Table/Board/Gallery/Calendar by module name: they resolve
 * each layout out of `BUILTIN_LAYOUTS`, which is the shell's documented
 * substitution point ("the dedicated layout modules replace an entry here and
 * need no other change to the shell"). A layout that is registered is tested;
 * renaming or moving its module cannot silently drop it out of coverage, and
 * four layouts written in parallel are held to one interface rather than four.
 *
 * What is pinned here — all of it about WRITES, because that is what phase 3
 * added and what a bug here costs:
 *
 *  - a table cell commit is exactly one `onPatch(id, thatRow'sVersion, {props:{
 *    onlyTheChangedKey }})` — not the whole row, not a stale version, and
 *    nothing at all when the value did not change;
 *  - a board drag is ONE patch of the group property, and when the shell
 *    refuses it (a terminal CAS conflict) the card is back in the column the
 *    server says it is in — a layout may not keep a private optimistic copy
 *    that outlives a rejected write — and the member is told;
 *  - a calendar drag writes the dropped cell's own date, as a plain
 *    `YYYY-MM-DD`, with no timezone re-interpretation in either direction;
 *  - the view config decides the rendered set (hidden columns are not drawn,
 *    a removed filter re-queries and the rows change);
 *  - a viewer gets NO editor in ANY layout: no input, no draggable card, and no
 *    gesture that reaches `onPatch`. (Enforcement is the server's; this is the
 *    UX half, and it is the half a screenshot shows.)
 *
 * WRITTEN AHEAD OF THE LAYOUTS (phase 3 built them in parallel). The
 * conventions a layout must meet to satisfy these, all of them forced by jsdom
 * rather than invented:
 *
 *   - an editable table cell opens an editor on click, double-click or Enter,
 *     and the table draws a menu whose button is named "columns";
 *   - a board column's heading is the group value's own text;
 *   - a calendar day cell is identifiable as `data-date="YYYY-MM-DD"` (or an
 *     aria-label containing it).
 *
 * DRAG IS NOT ONE MECHANISM, and this file no longer pretends it is. It was
 * written expecting HTML5 drag-and-drop everywhere, on the reasoning that jsdom
 * has no layout engine (every `getBoundingClientRect()` is zeros) so a pointer
 * drag could not be driven at all. That is true of a pointer-sensor LIBRARY
 * (dnd-kit and friends) and false of a hand-rolled one: the board reads
 * `clientX/clientY` against its own drop zones, and stubbing those zones' rects
 * drives it exactly as a browser would — which is how BoardLayout.test.tsx
 * covers it. So the two shipped layouts legitimately differ:
 *
 *   - the CALENDAR uses HTML5 drag-and-drop (`draggable="true"` + dragOver/drop);
 *   - the BOARD uses pointer events, deliberately: HTML5 drag-and-drop does not
 *     fire on touch, and a board that cannot be dragged on a tablet is a board
 *     half its users cannot operate.
 *
 * `dragOnto` therefore drives whichever gesture the layout actually offers. It
 * does NOT let a layout offer neither: a layout with no draggable item and no
 * pointer handler emits no patch, and the DRAG_HINT failure says so. (Unifying
 * the two on the pointer path — so the calendar works on touch too — is a real
 * follow-up; it is a product change, not a test change, and it is not made
 * here.)
 */

/* ------------------------------------------------------------------ fixtures */

const def = (over: Partial<PropDef> & { name: string; kind: string }): PropDef => ({
  required: false,
  deprecated: false,
  ...over,
});

const PROP_DEFS: PropDef[] = [
  def({ name: "status", kind: "enum", enum_values: ["open", "won", "lost"] }),
  def({ name: "city", kind: "text" }),
  def({ name: "due", kind: "date" }),
  def({ name: "owner", kind: "ref", ref_type: "person" }),
];

const person: TypeSummary = {
  id: 1,
  name: "person",
  label: "People",
  description: null,
  icon: "",
  deprecated: false,
  count: 2,
  properties: PROP_DEFS,
};

const alpha: ListItem = {
  id: "o1",
  title: "Alpha",
  version: 3,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  visibility: "org",
  props: { status: "open", city: "Austin", due: "2026-07-15" },
};

const beta: ListItem = {
  id: "o2",
  title: "Beta",
  version: 7,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-03T00:00:00Z",
  visibility: "org",
  props: { status: "won", city: "Dallas", due: "2026-07-02" },
};

const member: Whoami = {
  id: "acct-1",
  name: "Alice",
  role: "member",
  scopes: ["read", "write"],
  status: "active",
};

const viewer: Whoami = {
  id: "acct-2",
  name: "Reader",
  role: "viewer",
  scopes: ["read"],
  status: "active",
};

function baseConfig(over: Partial<ViewConfig> = {}): ViewConfig {
  return { ...defaultConfigFor(person), groupBy: "status", dateProp: "due", ...over };
}

/* ------------------------------------------------------------- render helpers */

interface Harness {
  patches: Array<{ id: string; baseVersion: number; fields: PatchFields }>;
  configs: ViewConfig[];
  opened: string[];
  container: HTMLElement;
  /** Re-render with a different bundle (used to prove a layout re-reads rows). */
  update(next: Partial<LayoutProps>): void;
}

/** Render one registered layout against stub props. Everything the layout can
 *  call is recorded; nothing is mocked out from under it. */
function renderLayout(name: Layout, over: Partial<LayoutProps> = {}): Harness {
  const Layout: LayoutComponent | undefined = BUILTIN_LAYOUTS[name];
  if (!Layout) throw new Error(`no layout registered for "${name}"`);

  const patches: Harness["patches"] = [];
  const configs: ViewConfig[] = [];
  const opened: string[] = [];

  const props = (extra: Partial<LayoutProps>): LayoutProps => ({
    rows: [alpha, beta],
    propDefs: PROP_DEFS,
    config: baseConfig({ layout: name }),
    onConfigChange: (next) => configs.push(next),
    onPatch: async (id, baseVersion, fields) => {
      patches.push({ id, baseVersion, fields });
    },
    onOpen: (id) => opened.push(id),
    readOnly: false,
    ...over,
    ...extra,
  });

  const { container, rerender } = render(
    <MemoryRouter>
      <Layout {...props({})} />
    </MemoryRouter>,
  );

  return {
    patches,
    configs,
    opened,
    container,
    update(next) {
      rerender(
        <MemoryRouter>
          <Layout {...props(next)} />
        </MemoryRouter>,
      );
    },
  };
}

/** The row element (a `<tr>`, a card, a chip) that carries this title. */
function elementFor(container: HTMLElement, title: string): HTMLElement {
  const hit = within(container).getAllByText(new RegExp(`^\\s*${title}\\s*$`))[0];
  if (!hit) throw new Error(`nothing rendered for "${title}"`);
  const el = hit.closest("tr,[data-row-id],[draggable],li,article,div");
  return (el ?? hit) as HTMLElement;
}

/* ------------------------------------------------------------- edit gestures */

/** Every gesture a table cell might use to enter edit mode, tried in order. A
 *  layout only has to answer ONE of them. */
function openEditor(cell: HTMLElement): HTMLElement {
  const editorIn = (): HTMLElement | null =>
    cell.querySelector("input,textarea,select,[contenteditable='true'],[role='textbox']");

  const gestures: Array<() => void> = [
    () => fireEvent.click(cell),
    () => fireEvent.doubleClick(cell),
    () => fireEvent.keyDown(cell, { key: "Enter" }),
    () => {
      const button = cell.querySelector("button");
      if (button) fireEvent.click(button);
    },
  ];
  for (const gesture of gestures) {
    gesture();
    const editor = editorIn();
    if (editor) return editor;
  }
  throw new Error(
    `no editor opened in this cell — an editable table cell must respond to a ` +
      `click, a double-click or Enter (cell was: ${cell.innerHTML.slice(0, 120)})`,
  );
}

/** Column index of a header whose text matches, so a cell can be found without
 *  knowing a layout's markup. */
function columnIndex(container: HTMLElement, label: RegExp): number {
  const heads = Array.from(container.querySelectorAll("th"));
  const i = heads.findIndex((h) => label.test(h.textContent ?? ""));
  if (i < 0) {
    throw new Error(`no column header matched ${label} (saw: ${heads.map((h) => h.textContent)})`);
  }
  return i;
}

function cellFor(container: HTMLElement, title: string, label: RegExp): HTMLElement {
  const row = elementFor(container, title).closest("tr");
  if (!row) throw new Error(`"${title}" is not in a table row`);
  const cell = row.querySelectorAll("td")[columnIndex(container, label)];
  if (!cell) throw new Error(`row "${title}" has no cell under ${label}`);
  return cell as HTMLElement;
}

/** Type into whatever kind of editor opened and commit it. */
function commit(editor: HTMLElement, value: string): void {
  if (editor instanceof HTMLSelectElement) {
    fireEvent.change(editor, { target: { value } });
    fireEvent.blur(editor);
    return;
  }
  fireEvent.change(editor, { target: { value } });
  fireEvent.keyDown(editor, { key: "Enter" });
  fireEvent.keyUp(editor, { key: "Enter" });
  fireEvent.blur(editor);
}

/**
 * Show/hide one column through whatever menu the table draws for it. Driven
 * with user-event, not fireEvent, because a shadcn/base-ui menu opens on a
 * pointer sequence rather than a bare click.
 */
async function toggleColumn(name: string): Promise<void> {
  const user = userEvent.setup();
  const named = (el: Element): string =>
    `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`;
  const trigger = screen.queryAllByRole("button").find((b) => /column/i.test(named(b)));
  if (!trigger) {
    throw new Error(
      "the table layout must offer a columns menu (a button whose name mentions " +
        '"columns") — column show/hide is how a member narrows a wide type',
    );
  }
  await user.click(trigger);

  // The name has to be matched to the MENU control, not to any element that
  // happens to read "due" — a table showing that column also has a `<th>` whose
  // sort control (a real <button>) carries exactly that text and sits earlier in
  // the document than the portalled menu, so clicking it would sort the table
  // instead of hiding the column. Matching only the menu's own roles (switch /
  // menuitem / checkbox), never a bare <button>, is what tells the two apart.
  const label = new RegExp(`^\\s*${name}\\s*$`, "i");
  const item = (await screen.findAllByText(label))
    .map((el) =>
      el.closest(
        "[role='menuitem'],[role='menuitemcheckbox'],[role='switch'],[role='option'],[role='checkbox'],label",
      ),
    )
    .find((el): el is HTMLElement => el instanceof HTMLElement);
  if (!item) {
    throw new Error(
      `the columns menu offers no control for "${name}" — an entry must be a ` +
        `button or a checkbox/switch/menuitem, not plain text`,
    );
  }
  await user.click(item);
}

/* ------------------------------------------------------------------ dragging */

/** jsdom has no DataTransfer; this is the whole of the surface a drag handler
 *  legitimately uses. */
function dataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    dropEffect: "move",
    effectAllowed: "move",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    get types(): readonly string[] {
      return [...store.keys()];
    },
    setData(format: string, data: string) {
      store.set(format, data);
    },
    getData(format: string) {
      return store.get(format) ?? "";
    },
    clearData() {
      store.clear();
    },
    setDragImage() {},
  } as unknown as DataTransfer;
}

/**
 * jsdom ships no PointerEvent, so `fireEvent.pointerDown` would fall back to a
 * bare Event and silently drop clientX/clientY — every pointer drag would look
 * like a zero-distance press that never crossed the threshold. A MouseEvent
 * subclass carries the coordinates, which is all a hand-rolled drag reads.
 */
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

/** Drag `source` onto `target` as HTML5 drag-and-drop, carrying one shared
 *  DataTransfer through the whole sequence exactly as a browser does. */
function html5DragOnto(source: HTMLElement, target: HTMLElement): void {
  const dt = dataTransfer();
  const draggable = source.closest("[draggable='true']") ?? source;
  fireEvent.dragStart(draggable, { dataTransfer: dt });
  fireEvent.dragEnter(target, { dataTransfer: dt });
  fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
  fireEvent.dragEnd(draggable, { dataTransfer: dt });
}

/**
 * Drag `source` onto `target` with pointer events.
 *
 * jsdom gives every element a 0×0 rect, so first lay the drop zones out for
 * real: 100px-wide strips left to right in document order. A pointer drag reads
 * coordinates against those rects, so with them stubbed the gesture is the same
 * one a browser performs — press on the card, move past the drag threshold to
 * the target column's centre, release there.
 */
function pointerDragOnto(source: HTMLElement, target: HTMLElement): void {
  const zones = Array.from(document.querySelectorAll<HTMLElement>("[data-column-key]"));
  const laid = zones.length > 0 ? zones : [target];
  laid.forEach((el, i) => {
    const left = i * 100;
    const right = left + 100;
    el.getBoundingClientRect = () =>
      ({ left, right, top: 0, bottom: 400, width: 100, height: 400, x: left, y: 0 }) as DOMRect;
  });

  const zone =
    target.querySelector<HTMLElement>("[data-column-key]") ??
    target.closest<HTMLElement>("[data-column-key]") ??
    target;
  const r = zone.getBoundingClientRect();
  const x = (r.left + r.right) / 2;
  const y = 10;

  const handle = source.closest<HTMLElement>("[data-card-id]") ?? source;
  fireEvent.pointerDown(handle, { clientX: 0, clientY: y, button: 0 });
  fireEvent.pointerMove(handle, { clientX: x, clientY: y });
  fireEvent.pointerUp(handle, { clientX: x, clientY: y });
}

/**
 * Move `source` onto `target` with whichever gesture this layout ships. A
 * `draggable="true"` ancestor means HTML5 drag-and-drop; anything else is
 * driven as a pointer drag. Neither is assumed to work — if the layout handles
 * neither, no patch is emitted and DRAG_HINT explains it.
 */
function dragOnto(source: HTMLElement, target: HTMLElement): void {
  if (source.closest("[draggable='true']")) {
    html5DragOnto(source, target);
    return;
  }
  pointerDragOnto(source, target);
}

/** A board column, found by its heading text (the enum value it holds). */
function boardColumn(container: HTMLElement, value: string): HTMLElement {
  const heading = within(container).getAllByText(new RegExp(`^\\s*${value}\\s*$`, "i"))[0];
  if (!heading) throw new Error(`no board column headed "${value}"`);
  const col =
    heading.closest("[data-column],[data-group],section,li") ??
    heading.parentElement?.parentElement;
  if (!col) throw new Error(`board column "${value}" has no container element`);
  return col as HTMLElement;
}

/** Which board column is this card in? Answered by walking up to the column
 *  whose heading names an enum value — no test ids required of the layout. */
function columnOf(container: HTMLElement, title: string): string {
  for (const value of ["open", "won", "lost"]) {
    const col = boardColumn(container, value);
    if (within(col).queryAllByText(new RegExp(`^\\s*${title}\\s*$`)).length > 0) return value;
  }
  throw new Error(`"${title}" is not in any board column`);
}

/** A calendar day cell for an ISO date. Layouts differ on markup; every one of
 *  these is a reasonable way to say "this box is 2026-07-20". */
function dayCell(container: HTMLElement, iso: string): HTMLElement {
  const byData = container.querySelector(
    `[data-date="${iso}"],[data-day="${iso}"],[data-iso="${iso}"]`,
  );
  if (byData) return byData as HTMLElement;
  const labelled = Array.from(container.querySelectorAll("[aria-label]")).find((el) =>
    (el.getAttribute("aria-label") ?? "").includes(iso),
  );
  if (labelled) return labelled as HTMLElement;
  throw new Error(
    `no calendar cell for ${iso} — a day cell must be identifiable by ` +
      `data-date="YYYY-MM-DD" or an aria-label containing it`,
  );
}

const DRAG_HINT =
  'the drag emitted no patch — a draggable item must set draggable="true" and its ' +
  "drop target must handle dragOver + drop (HTML5 drag-and-drop; jsdom cannot drive a pointer sensor)";

/* ---------------------------------------------------------------------- table */

describe("table layout", () => {
  it("commits a cell as exactly one patch: the changed prop and THAT row's version", async () => {
    const h = renderLayout("table");
    const editor = openEditor(cellFor(h.container, "Alpha", /city/i));
    commit(editor, "Dallas");

    await waitFor(() => expect(h.patches).toHaveLength(1));
    expect(h.patches[0]).toEqual({
      id: "o1",
      baseVersion: 3,
      fields: { props: { city: "Dallas" } },
    });
    // Nothing else rides along: not the title, not the untouched props, and
    // never a baseVersion smuggled into the fields half.
    expect(Object.keys(h.patches[0]!.fields)).toEqual(["props"]);
    expect(Object.keys(h.patches[0]!.fields.props ?? {})).toEqual(["city"]);
  });

  it("uses each row's own version, not the first row's", async () => {
    const h = renderLayout("table");
    commit(openEditor(cellFor(h.container, "Beta", /city/i)), "Houston");
    await waitFor(() => expect(h.patches).toHaveLength(1));
    expect(h.patches[0]).toMatchObject({ id: "o2", baseVersion: 7 });
  });

  it("writes nothing when the value did not change", async () => {
    const h = renderLayout("table");
    commit(openEditor(cellFor(h.container, "Alpha", /city/i)), "Austin");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.patches).toEqual([]);
  });

  it("abandons the edit on Escape without writing", async () => {
    const h = renderLayout("table");
    const editor = openEditor(cellFor(h.container, "Alpha", /city/i));
    fireEvent.change(editor, { target: { value: "Nope" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.patches).toEqual([]);
  });

  it("draws the columns the config shows and not the ones it hides", () => {
    const h = renderLayout("table", {
      config: baseConfig({
        layout: "table",
        columns: [
          { key: "city", visible: true },
          { key: "status", visible: false },
          { key: "due", visible: false },
        ],
      }),
    });
    const heads = Array.from(h.container.querySelectorAll("th")).map((t) => t.textContent ?? "");
    expect(heads.some((t) => /city/i.test(t))).toBe(true);
    expect(heads.some((t) => /status/i.test(t))).toBe(false);
    // A hidden column's VALUES go with it — hiding is not just a header trick.
    expect(within(h.container).queryByText("Austin")).not.toBeNull();
    expect(within(h.container).queryByText("2026-07-15")).toBeNull();
  });

  it("its column menu emits a WHOLE next config, and the hidden column stops rendering", async () => {
    const h = renderLayout("table", {
      config: baseConfig({
        layout: "table",
        columns: [
          { key: "city", visible: true },
          { key: "due", visible: true },
          { key: "status", visible: true },
        ],
      }),
    });
    await toggleColumn("due");

    expect(h.configs).toHaveLength(1);
    const next = h.configs[0]!;
    expect(next.columns).toEqual([
      { key: "city", visible: true },
      { key: "due", visible: false },
      { key: "status", visible: true },
    ]);
    // The whole config comes back, not a columns-shaped fragment: the shell
    // stores one object per view, and a partial would drop the filters.
    expect(next.filters).toEqual(baseConfig().filters);
    expect(next.sort).toEqual(baseConfig().sort);
    expect(next.groupBy).toBe("status");

    // The shell is the one that persists it; feeding it back is what a member
    // sees, and the column is gone.
    h.update({ config: next });
    await waitFor(() =>
      expect(
        Array.from(h.container.querySelectorAll("th")).some((t) =>
          /due/i.test(t.textContent ?? ""),
        ),
      ).toBe(false),
    );
  });
});

/* ---------------------------------------------------------------------- board */

describe("board layout", () => {
  it("a drag between columns is ONE patch of the group property", async () => {
    const h = renderLayout("board");
    expect(columnOf(h.container, "Alpha")).toBe("open");

    dragOnto(elementFor(h.container, "Alpha"), boardColumn(h.container, "won"));

    await waitFor(() => expect(h.patches, DRAG_HINT).toHaveLength(1));
    expect(h.patches[0]).toEqual({
      id: "o1",
      baseVersion: 3,
      fields: { props: { status: "won" } },
    });
  });

  it("a drop back into the same column writes nothing", async () => {
    const h = renderLayout("board");
    dragOnto(elementFor(h.container, "Alpha"), boardColumn(h.container, "open"));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.patches).toEqual([]);
  });

  it("keeps no private copy: rows the shell did not change stay where they were", async () => {
    // The terminal case, at the layout's own seam. `onPatch` resolves (it never
    // rejects) and `rows` come back UNCHANGED, which is exactly what the shell
    // hands down after a conflict it could not rebase. The card must be back in
    // its original column, because the layout renders rows and nothing else.
    const h = renderLayout("board");
    dragOnto(elementFor(h.container, "Alpha"), boardColumn(h.container, "won"));
    await waitFor(() => expect(h.patches, DRAG_HINT).toHaveLength(1));

    h.update({ rows: [alpha, beta] });
    await waitFor(() => expect(columnOf(h.container, "Alpha")).toBe("open"));
  });
});

/* ------------------------------------------------------------------- calendar */

describe("calendar layout", () => {
  beforeEach(() => {
    // Pin "today" so the calendar opens on July 2026 wherever this runs. Local
    // noon, so a machine in UTC+13 and one in UTC-11 are on the same day.
    // `shouldAdvanceTime` keeps timers real-time: everything below awaits, and
    // a frozen clock would hang those awaits instead of failing them.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 6, 10, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a drag writes the dropped cell's own date, with no timezone shift", async () => {
    const h = renderLayout("calendar");
    dragOnto(elementFor(h.container, "Alpha"), dayCell(h.container, "2026-07-20"));

    await waitFor(() => expect(h.patches, DRAG_HINT).toHaveLength(1));
    expect(h.patches[0]).toEqual({
      id: "o1",
      baseVersion: 3,
      fields: { props: { due: "2026-07-20" } },
    });
    // The value is a plain calendar date. A Date round-trip (`toISOString()` on
    // a local midnight) is how a due date silently moves a day west of UTC —
    // so the string must carry no time and no zone at all.
    const written = String(h.patches[0]!.fields.props?.["due"]);
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("writes the same date at the far edges of the month", async () => {
    const h = renderLayout("calendar", {
      rows: [{ ...alpha, props: { ...alpha.props, due: "2026-07-15" } }],
    });
    dragOnto(elementFor(h.container, "Alpha"), dayCell(h.container, "2026-07-01"));
    await waitFor(() => expect(h.patches, DRAG_HINT).toHaveLength(1));
    expect(h.patches[0]!.fields.props).toEqual({ due: "2026-07-01" });
  });

  it("a drop onto the day it already sits on writes nothing", async () => {
    const h = renderLayout("calendar");
    dragOnto(elementFor(h.container, "Alpha"), dayCell(h.container, "2026-07-15"));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.patches).toEqual([]);
  });
});

/* -------------------------------------------------------------- viewer sweeps */

const EVERY_LAYOUT: Layout[] = ["table", "board", "gallery", "calendar"];

describe("a viewer gets no editor anywhere", () => {
  for (const name of EVERY_LAYOUT) {
    it(`${name}: no input, no draggable, no gesture that reaches onPatch`, async () => {
      const h = renderLayout(name, { readOnly: true });

      expect(h.container.querySelectorAll("input,textarea,select")).toHaveLength(0);
      expect(h.container.querySelectorAll("[contenteditable='true']")).toHaveLength(0);
      expect(h.container.querySelectorAll("[draggable='true']")).toHaveLength(0);

      // And the gestures themselves are inert: clicking a cell/card and
      // dragging one produce no write.
      const card = elementFor(h.container, "Alpha");
      fireEvent.click(card);
      fireEvent.doubleClick(card);
      fireEvent.keyDown(card, { key: "Enter" });
      const target = h.container.querySelector("td,[data-date],[data-column]") ?? h.container;
      dragOnto(card, target as HTMLElement);

      await new Promise((r) => setTimeout(r, 0));
      expect(h.patches).toEqual([]);
      expect(h.container.querySelectorAll("input,textarea,select")).toHaveLength(0);
    });
  }
});

/* ------------------------------------- the config decides the rendered set */

const noLive: LiveSubscribe = () => () => undefined;

function mountShell(user: Whoami = member) {
  return render(
    <MemoryRouter initialEntries={["/t/person"]}>
      <Routes>
        <Route path="/t/:type" element={<TypeView user={user} live={noLive} />} />
        <Route path="/o/:id" element={<div>object page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("view config drives the rendered set", () => {
  it("a filter narrows the rows, and dropping it re-queries and widens them", async () => {
    writeViewConfig(
      "acct-1",
      "person",
      baseConfig({ filters: [{ prop: "status", op: "eq", value: "open" }] }),
    );
    vi.spyOn(api, "types").mockResolvedValue([person]);
    const list = vi
      .spyOn(api, "list")
      .mockResolvedValueOnce({ items: [alpha], nextCursor: null })
      .mockResolvedValue({ items: [alpha, beta], nextCursor: null });

    mountShell();
    await screen.findByText("Alpha");
    expect(screen.queryByText("Beta")).toBeNull();
    expect(list.mock.calls[0]?.[1]).toMatchObject({
      where: { field: "status", op: "eq", value: "open" },
    });

    fireEvent.click(screen.getByRole("button", { name: /remove filter/i }));

    await screen.findByText("Beta");
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[1]).not.toHaveProperty("where");
  });

  it("a terminal conflict on a board drag puts the card back and tells the member", async () => {
    writeViewConfig("acct-1", "person", baseConfig({ layout: "board" }));
    vi.spyOn(api, "types").mockResolvedValue([person]);
    vi.spyOn(api, "list").mockResolvedValue({ items: [alpha, beta], nextCursor: null });
    vi.spyOn(api, "patchObject").mockRejectedValue(new ConflictError("conflict", 9, null));
    // The re-read is the truth, and the truth is that nothing moved.
    vi.spyOn(api, "object").mockResolvedValue({
      id: "o1",
      type: "person",
      title: "Alpha",
      body: null,
      version: 9,
      created_at: alpha.created_at,
      updated_at: "2026-07-04T00:00:00Z",
      deleted_at: null,
      visibility: "org",
      props: { status: "open", city: "Austin", due: "2026-07-15" },
      links: [],
      backlinks: [],
      links_truncated: false,
      backlinks_truncated: false,
      hidden_from_you: 0,
    });

    const { container } = mountShell();
    await screen.findByText("Alpha");
    dragOnto(elementFor(container, "Alpha"), boardColumn(container, "won"));

    await screen.findByText(/changed that row first/i);
    await waitFor(() => expect(columnOf(container, "Alpha")).toBe("open"));
  });

  it("a viewer sees the rows and no New button", async () => {
    writeViewConfig("acct-2", "person", baseConfig());
    vi.spyOn(api, "types").mockResolvedValue([person]);
    vi.spyOn(api, "list").mockResolvedValue({ items: [alpha], nextCursor: null });

    mountShell(viewer);
    await screen.findByText("Alpha");
    expect(screen.queryByRole("button", { name: /^new$/i })).toBeNull();
  });
});
