import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  TypeView,
  applyFields,
  feedTouchesType,
  filterDefaults,
  maxSeq,
  rowVersion,
  seqGreater,
  type LayoutProps,
  type LiveSubscribe,
} from "./TypeView";
import {
  api,
  ConflictError,
  type FeedEvent,
  type ListItem,
  type PropDef,
  type TypeSummary,
  type Whoami,
} from "../lib/api";
import { defaultConfigFor, writeViewConfig, readViewConfig } from "../lib/viewConfig";

/**
 * What these pin is the SHELL's contract, not any layout's pixels:
 *
 *  - one compiled query reaches the server, and only a change to that WIRE
 *    payload costs a round-trip (hiding a column must not);
 *  - a new row is born matching the view that created it, under one
 *    idempotency key per intent;
 *  - a lost CAS never clobbers — the row is re-read and the member is told;
 *  - the deleted filter and cursor paging still work;
 *  - a live tick refreshes rows in place instead of blanking the page;
 *  - every layout is handed the same six-key bundle.
 */

const prop = (over: Partial<PropDef> & { name: string; kind: string }): PropDef => ({
  required: false,
  deprecated: false,
  ...over,
});

const person: TypeSummary = {
  id: 1,
  name: "person",
  label: "People",
  description: null,
  icon: "",
  deprecated: false,
  count: 2,
  properties: [
    prop({ name: "status", kind: "enum", enum_values: ["open", "won"] }),
    prop({ name: "city", kind: "text" }),
    prop({ name: "owner", kind: "ref", ref_type: "person" }),
    prop({ name: "legacy", kind: "text", deprecated: true }),
  ],
};

const row = (over: Partial<ListItem> & { id: string }): ListItem => ({
  title: "Row",
  version: 3,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  visibility: "org",
  props: { status: "open", city: "Austin" },
  ...over,
});

const member: Whoami = {
  id: "acct-1",
  name: "Alice",
  role: "member",
  scopes: ["read", "write"],
  status: "active",
};

/** A layout that shows the bundle it was handed and can drive every callback. */
function FakeLayout({
  rows,
  propDefs,
  config,
  onConfigChange,
  onPatch,
  onOpen,
  readOnly,
}: LayoutProps) {
  return (
    <div>
      <div data-testid="layout">{config.layout}</div>
      <div data-testid="props">{propDefs.map((p) => p.name).join(",")}</div>
      <div data-testid="readonly">{String(readOnly)}</div>
      {rows.map((r) => (
        <div key={r.id} data-testid={`row-${r.id}`}>
          <span data-testid={`status-${r.id}`}>{String(r.props?.["status"] ?? "")}</span>
          <span data-testid={`version-${r.id}`}>{String(r.version)}</span>
          <button onClick={() => void onPatch(r.id, rowVersion(r), { props: { status: "won" } })}>
            patch {r.id}
          </button>
          <button onClick={() => onOpen(r.id)}>open {r.id}</button>
        </div>
      ))}
      <button onClick={() => onConfigChange({ ...config, sort: [{ prop: "title", dir: "asc" }] })}>
        sort by title
      </button>
      <button
        onClick={() =>
          onConfigChange({ ...config, columns: [{ key: "city", visible: true, width: 240 }] })
        }
      >
        widen a column
      </button>
    </div>
  );
}

/** No live source unless a test asks for one — the default poller owns a timer. */
const noLive: LiveSubscribe = () => () => undefined;

function mount(opts: { user?: Whoami; live?: LiveSubscribe } = {}) {
  return render(
    <MemoryRouter initialEntries={["/t/person"]}>
      <Routes>
        <Route
          path="/t/:type"
          element={
            <TypeView
              user={opts.user ?? member}
              live={opts.live ?? noLive}
              layouts={{ table: FakeLayout }}
            />
          }
        />
        <Route path="/o/:id" element={<div>object page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function stubCatalog(rows: ListItem[] = [row({ id: "o1" }), row({ id: "o2", title: "Two" })]) {
  vi.spyOn(api, "types").mockResolvedValue([person]);
  const list = vi.spyOn(api, "list").mockResolvedValue({ items: rows, nextCursor: null });
  return list;
}

describe("TypeView shell — loading", () => {
  it("compiles the saved config into ONE query and hands the rows to the layout", async () => {
    writeViewConfig("acct-1", "person", {
      ...defaultConfigFor(person),
      filters: [{ prop: "status", op: "eq", value: "open" }],
    });
    const list = stubCatalog();
    mount();

    await screen.findByTestId("row-o1");
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toBe("person");
    expect(list.mock.calls[0]?.[1]).toMatchObject({
      limit: 50,
      where: { field: "status", op: "eq", value: "open" },
      sort: { field: "updated_at", dir: "desc" },
    });
    // The bundle: living properties only, refs included for the layouts that
    // want them, deprecated ones never.
    expect(screen.getByTestId("props")).toHaveTextContent("status,city,owner");
    expect(screen.getByTestId("readonly")).toHaveTextContent("false");
  });

  it("re-fetches when the WIRE query changes and not when a column does", async () => {
    const list = stubCatalog();
    mount();
    await screen.findByTestId("row-o1");
    expect(list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("widen a column"));
    await waitFor(() => expect(screen.getByTestId("row-o1")).toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("sort by title"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list.mock.calls[1]?.[1]).toMatchObject({ sort: { field: "title", dir: "asc" } });
  });

  it("keeps the deleted filter and pages with the cursor", async () => {
    vi.spyOn(api, "types").mockResolvedValue([person]);
    const list = vi
      .spyOn(api, "list")
      .mockResolvedValueOnce({ items: [row({ id: "o1" })], nextCursor: "c1" })
      .mockResolvedValue({ items: [row({ id: "o2" })], nextCursor: null });
    mount();

    await screen.findByTestId("row-o1");
    fireEvent.click(screen.getByText("Load more"));
    await screen.findByTestId("row-o2");
    expect(list.mock.calls[1]?.[1]).toMatchObject({ cursor: "c1", limit: 50 });
    // Both pages are on screen — paging appends, it does not replace.
    expect(screen.getByTestId("row-o1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Trash"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(list.mock.calls[2]?.[1]).toMatchObject({ deleted: true });
  });

  it("persists the layout switch per member and per type", async () => {
    stubCatalog();
    mount();
    await screen.findByTestId("row-o1");

    fireEvent.click(screen.getByRole("button", { name: /gallery/i }));
    await waitFor(() =>
      expect(readViewConfig("acct-1", "person", defaultConfigFor(person)).layout).toBe("gallery"),
    );
  });

  it("shows a retryable error — not 'empty database' — when a fresh load fails", async () => {
    vi.spyOn(api, "types").mockResolvedValue([person]);
    const list = vi
      .spyOn(api, "list")
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ items: [row({ id: "o1" })], nextCursor: null });
    mount();

    // The failure must NOT read as an empty database, and must offer a retry.
    await screen.findByText(/couldn't load these rows/i);
    expect(screen.queryByText(/no .* here yet/i)).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await screen.findByTestId("row-o1");
    expect(screen.queryByText(/couldn't load these rows/i)).toBeNull();
  });
});

describe("TypeView shell — writes", () => {
  it("gives a new row the filter's own value, under one key per intent", async () => {
    writeViewConfig("acct-1", "person", {
      ...defaultConfigFor(person),
      filters: [
        { prop: "status", op: "eq", value: "open" },
        { prop: "city", op: "ilike", value: "Aus" },
      ],
    });
    stubCatalog();
    const create = vi
      .spyOn(api, "createObject")
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ id: "new-1", version: 1 });
    mount();
    await screen.findByTestId("row-o1");

    fireEvent.click(screen.getByRole("button", { name: /new/i }));
    await screen.findByText(/network/i);
    fireEvent.click(screen.getByRole("button", { name: /new/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    const first = create.mock.calls[0]?.[0];
    const second = create.mock.calls[1]?.[0];
    expect(first).toMatchObject({ type: "person", props: { status: "open" } });
    // `ilike` is a range, not a value — it must not become a default.
    expect(first?.props).not.toHaveProperty("city");
    expect(typeof first?.idempotencyKey).toBe("string");
    // The retry is the SAME intent: a lost response cannot become two rows.
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
  });

  it("folds a successful patch in without re-reading the world", async () => {
    stubCatalog([row({ id: "o1" })]);
    const patch = vi.spyOn(api, "patchObject").mockResolvedValue({ id: "o1", version: 4 });
    mount();
    await screen.findByTestId("row-o1");

    fireEvent.click(screen.getByText("patch o1"));
    await waitFor(() => expect(screen.getByTestId("status-o1")).toHaveTextContent("won"));
    expect(screen.getByTestId("version-o1")).toHaveTextContent("4");
    expect(patch).toHaveBeenCalledWith("o1", { baseVersion: 3, props: { status: "won" } });
  });

  it("never clobbers a lost CAS: it re-reads the row and says so", async () => {
    stubCatalog([row({ id: "o1" })]);
    vi.spyOn(api, "patchObject").mockRejectedValue(new ConflictError("conflict", 5, null));
    const read = vi.spyOn(api, "object").mockResolvedValue({
      id: "o1",
      type: "person",
      title: "Row",
      body: null,
      version: 5,
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-03T00:00:00Z",
      deleted_at: null,
      visibility: "org",
      props: { status: "lost", city: "Austin" },
      links: [],
      backlinks: [],
      links_truncated: false,
      backlinks_truncated: false,
      hidden_from_you: 0,
    });
    mount();
    await screen.findByTestId("row-o1");

    fireEvent.click(screen.getByText("patch o1"));
    await screen.findByText(/changed that row first/i);
    expect(read).toHaveBeenCalledWith("o1");
    // The server's value stands — ours is not written over it.
    await waitFor(() => expect(screen.getByTestId("status-o1")).toHaveTextContent("lost"));
    expect(screen.getByTestId("version-o1")).toHaveTextContent("5");
  });

  it("drops a row the re-read can no longer see", async () => {
    stubCatalog([row({ id: "o1" }), row({ id: "o2" })]);
    vi.spyOn(api, "patchObject").mockRejectedValue(new ConflictError("conflict", 5, null));
    vi.spyOn(api, "object").mockRejectedValue(new Error("gone"));
    mount();
    await screen.findByTestId("row-o1");

    fireEvent.click(screen.getByText("patch o1"));
    await waitFor(() => expect(screen.queryByTestId("row-o1")).toBeNull());
    expect(screen.getByTestId("row-o2")).toBeInTheDocument();
  });

  it("shows a viewer no write affordance at all", async () => {
    stubCatalog();
    mount({ user: { ...member, role: "viewer", scopes: ["read"] } });
    await screen.findByTestId("row-o1");

    expect(screen.queryByRole("button", { name: /^new$/i })).toBeNull();
    expect(screen.getByTestId("readonly")).toHaveTextContent("true");
  });
});

describe("TypeView shell — live updates", () => {
  it("refreshes the loaded window in place when the live source fires", async () => {
    vi.spyOn(api, "types").mockResolvedValue([person]);
    const list = vi.spyOn(api, "list").mockResolvedValue({
      items: [row({ id: "o1" })],
      nextCursor: null,
    });
    let fire = (): void => undefined;
    const live: LiveSubscribe = (_type, onChange) => {
      fire = onChange;
      return () => undefined;
    };
    mount({ live });
    await screen.findByTestId("row-o1");

    fire();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    // The rows never went away: a live refresh must not blink the page.
    expect(screen.getByTestId("row-o1")).toBeInTheDocument();
  });

  it("subscribes with the type and tears the subscription down", async () => {
    stubCatalog();
    const stop = vi.fn();
    const live = vi.fn<LiveSubscribe>(() => stop);
    const view = mount({ live });
    await screen.findByTestId("row-o1");
    expect(live).toHaveBeenCalledWith("person", expect.any(Function));

    view.unmount();
    expect(stop).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ helpers */

describe("filterDefaults", () => {
  const defs = person.properties;

  it("takes the value an `eq` filter implies", () => {
    expect(filterDefaults([{ prop: "status", op: "eq", value: "open" }], defs)).toEqual({
      status: "open",
    });
  });

  it("ignores everything that is a range, a link, or not a property", () => {
    expect(
      filterDefaults(
        [
          { prop: "status", op: "ne", value: "won" },
          { prop: "city", op: "ilike", value: "Aus" },
          { prop: "owner", op: "eq", value: "obj-1" },
          { prop: "title", op: "eq", value: "Nope" },
          { prop: "legacy", op: "eq", value: "x" },
          { prop: "status", op: "in", value: ["open", "won"] },
          { prop: "city", op: "is_null" },
        ],
        defs,
      ),
    ).toEqual({});
  });

  it("lets the first of two contradictory equals win", () => {
    expect(
      filterDefaults(
        [
          { prop: "status", op: "eq", value: "open" },
          { prop: "status", op: "eq", value: "won" },
        ],
        defs,
      ),
    ).toEqual({ status: "open" });
  });
});

/* Chip wording used to be tested here, against the shell's own `filterLabel`.
   The shell no longer has one: the toolbar renders `<FilterBar/>`, and what a
   chip says is `filterChipLabel` — covered in FilterBar.test.tsx, in the same
   file as the operator table it has to agree with. */

describe("feed sequencing", () => {
  it("orders sequence numbers past 2^53 by digits, not by float", () => {
    expect(seqGreater("9007199254740993", "9007199254740992")).toBe(true);
    expect(seqGreater("10", "9")).toBe(true);
    expect(seqGreater("9", "10")).toBe(false);
    expect(seqGreater("7", "7")).toBe(false);
    expect(seqGreater("007", "7")).toBe(false);
  });

  it("takes the newest sequence in a feed page", () => {
    expect(maxSeq([event({ seq: "8" }), event({ seq: "12" }), event({ seq: "3" })])).toBe("12");
    expect(maxSeq([])).toBeNull();
  });

  it("wakes on a change to this type, or to a row on screen", () => {
    const shown = new Set(["o9"]);
    expect(
      feedTouchesType([event({ seq: "10", target_type: "person" })], "person", "9", shown),
    ).toBe(true);
    // A row we are showing that was retyped away still has to leave the view.
    expect(
      feedTouchesType(
        [event({ seq: "10", target: "o9", target_type: "deal" })],
        "person",
        "9",
        shown,
      ),
    ).toBe(true);
    expect(
      feedTouchesType(
        [event({ seq: "10", target: "o8", target_type: "deal" })],
        "person",
        "9",
        shown,
      ),
    ).toBe(false);
    // Already seen: not a change.
    expect(
      feedTouchesType([event({ seq: "9", target_type: "person" })], "person", "9", shown),
    ).toBe(false);
  });
});

describe("applyFields", () => {
  const base = row({ id: "o1", props: { status: "open", city: "Austin" } });

  it("applies only what was sent and bumps the version", () => {
    expect(applyFields(base, { props: { status: "won" } }, 4)).toMatchObject({
      version: 4,
      props: { status: "won", city: "Austin" },
    });
  });

  it("treats null inside props as the delete sentinel, leaving siblings alone", () => {
    expect(applyFields(base, { props: { city: null } }, 4).props).toEqual({ status: "open" });
  });

  it("carries a title and a visibility change", () => {
    const next = applyFields(base, { title: null, visibility: "private" }, 4);
    expect(next.title).toBeNull();
    expect(next.visibility).toBe("private");
  });
});

describe("rowVersion", () => {
  it("takes a wire version in either shape", () => {
    expect(rowVersion(row({ id: "o1", version: "7" }))).toBe(7);
    expect(rowVersion(row({ id: "o1", version: 7 }))).toBe(7);
  });
});

function event(over: Partial<FeedEvent> & { seq: string }): FeedEvent {
  return {
    kind: "update",
    at: "2026-07-21T00:00:00Z",
    target: null,
    payload: null,
    actor_name: null,
    target_title: null,
    target_type: null,
    target_deleted: false,
    ...over,
  };
}
