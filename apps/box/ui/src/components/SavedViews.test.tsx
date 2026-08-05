import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PinnedViews,
  SavedViews,
  type PinnedViewsProps,
  type SavedViewsProps,
  loadSavedViews,
  migrateLocalViewConfigs,
  migratedViewName,
  resetSavedViewsStore,
  sameConfig,
  savedViewHref,
  sortViews,
  stableStringify,
  suggestViewName,
} from "./SavedViews";
import { api, ApiError, type SavedView } from "../lib/api";
import { viewConfigKey } from "../lib/viewConfig";

/**
 * What these pin is the saved-views contract, not its pixels:
 *
 *  - a view is per member and there is NO share affordance anywhere;
 *  - the localStorage configs migrate exactly once, only for the signed-in
 *    account, and the cache SURVIVES as the unsaved working state;
 *  - a member switching browsers with someone else's leftovers never uploads
 *    them (the purge runs before the migration reads);
 *  - a box without the endpoint (older release, demo bundle) shows no
 *    affordance at all rather than an error or a broken toolbar;
 *  - reorder sends the whole pinned list and snaps back when the box refuses;
 *  - dirty-checking survives key reordering, which is what a jsonb round-trip
 *    does to every saved config.
 */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const view = (over: Partial<SavedView> & { id: string; name: string }): SavedView => ({
  kind: "database",
  scope: "person",
  config: { layout: "table" },
  pinned: false,
  position: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  resetSavedViewsStore();
});

afterEach(() => {
  resetSavedViewsStore();
});

// Rendered through prop objects rather than a `(ui: ReactNode)` helper on
// purpose: react-router resolves the hoisted @types/react 18, and handing
// it a React-19-typed node through a variable is a type error the inline JSX
// below does not have.
const renderToolbar = (props: SavedViewsProps) =>
  render(
    <MemoryRouter>
      <SavedViews {...props} />
    </MemoryRouter>,
  );

const renderPinned = (props: PinnedViewsProps) =>
  render(
    <MemoryRouter>
      <PinnedViews {...props} />
    </MemoryRouter>,
  );

/* --------------------------------------------------------------- pure parts */

describe("config comparison", () => {
  it("ignores key order, which is all a jsonb round-trip changes", () => {
    expect(sameConfig({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
  });

  it("does not ignore ARRAY order — there, order is the meaning", () => {
    expect(sameConfig({ sort: ["a", "b"] }, { sort: ["b", "a"] })).toBe(false);
  });

  it("treats a dropped key as a change, and undefined as absent", () => {
    expect(sameConfig({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(sameConfig({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it("serializes nested structures deterministically", () => {
    expect(stableStringify({ z: { y: 1, x: 2 }, a: null })).toBe('{"a":null,"z":{"x":2,"y":1}}');
  });
});

describe("sidebar ordering", () => {
  it("puts pinned first, then position, then creation order", () => {
    const out = sortViews([
      view({ id: "c", name: "c", position: 5, createdAt: "2026-01-03T00:00:00.000Z" }),
      view({ id: "a", name: "a", pinned: true, position: 9 }),
      view({ id: "b", name: "b", position: 5, createdAt: "2026-01-01T00:00:00.000Z" }),
    ]).map((v) => v.id);
    expect(out).toEqual(["a", "b", "c"]);
  });
});

describe("routing + naming", () => {
  it("links a database view at its type and a graph view at the graph", () => {
    expect(savedViewHref(view({ id: "v1", name: "n", scope: "person" }))).toBe("/t/person?view=v1");
    expect(savedViewHref(view({ id: "v2", name: "n", kind: "graph", scope: null }))).toBe(
      "/graph?view=v2",
    );
  });

  it("refuses to invent a route for a scopeless database view", () => {
    expect(savedViewHref(view({ id: "v3", name: "n", scope: null }))).toBeNull();
  });

  it("suggests a name the unique index will accept", () => {
    const existing = [
      view({ id: "a", name: "People view" }),
      view({ id: "b", name: "People view 2" }),
    ];
    expect(suggestViewName(existing, "People view")).toBe("People view 3");
    expect(suggestViewName([], "People view")).toBe("People view");
  });

  it("names a migrated config after its database", () => {
    expect(migratedViewName("sales_opportunity")).toBe("Sales Opportunity view");
  });
});

/* ---------------------------------------------------------------- migration */

describe("localStorage → saved_views migration", () => {
  it("migrates this account's configs once and KEEPS the cache", async () => {
    localStorage.setItem(viewConfigKey(ACCOUNT, "person"), JSON.stringify({ layout: "board" }));
    localStorage.setItem(viewConfigKey(ACCOUNT, "task"), JSON.stringify({ layout: "table" }));
    const create = vi
      .spyOn(api, "createView")
      .mockImplementation((input) =>
        Promise.resolve(
          view({ id: `id-${input.scope}`, name: input.name, scope: input.scope ?? null }),
        ),
      );

    const made = await migrateLocalViewConfigs(ACCOUNT);
    expect(made).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map((c) => c[0].scope).sort()).toEqual(["person", "task"]);
    expect(create.mock.calls[0]![0].kind).toBe("database");

    // The cache is now the unsaved working state — migration is not a move.
    expect(localStorage.getItem(viewConfigKey(ACCOUNT, "person"))).not.toBeNull();

    // Second pass is a no-op: the flag is set.
    create.mockClear();
    expect(await migrateLocalViewConfigs(ACCOUNT)).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("never uploads another account's leftover config — the purge runs first", async () => {
    localStorage.setItem(viewConfigKey(OTHER, "person"), JSON.stringify({ layout: "board" }));
    const create = vi.spyOn(api, "createView");

    expect(await migrateLocalViewConfigs(ACCOUNT)).toBe(0);
    expect(create).not.toHaveBeenCalled();
    // …and the foreign config is gone, not merely ignored.
    expect(localStorage.getItem(viewConfigKey(OTHER, "person"))).toBeNull();
  });

  it("skips a refused config but keeps going, and still finishes", async () => {
    localStorage.setItem(viewConfigKey(ACCOUNT, "aaa"), JSON.stringify({ layout: "table" }));
    localStorage.setItem(viewConfigKey(ACCOUNT, "bbb"), JSON.stringify({ layout: "table" }));
    vi.spyOn(api, "createView").mockImplementation((input) =>
      input.scope === "aaa"
        ? Promise.reject(new ApiError(400, "name is required"))
        : Promise.resolve(view({ id: "ok", name: input.name, scope: input.scope ?? null })),
    );

    expect(await migrateLocalViewConfigs(ACCOUNT)).toBe(1);
  });

  it("does not latch the flag when the box is unreachable", async () => {
    localStorage.setItem(viewConfigKey(ACCOUNT, "person"), JSON.stringify({ layout: "table" }));
    const create = vi.spyOn(api, "createView").mockRejectedValue(new Error("network down"));

    expect(await migrateLocalViewConfigs(ACCOUNT)).toBe(0);
    create.mockResolvedValue(view({ id: "later", name: "People view" }));
    // The whole pass is retried rather than lost.
    expect(await migrateLocalViewConfigs(ACCOUNT)).toBe(1);
  });

  it("ignores a corrupt cache entry instead of throwing", async () => {
    localStorage.setItem(viewConfigKey(ACCOUNT, "person"), "{not json");
    const create = vi.spyOn(api, "createView");
    expect(await migrateLocalViewConfigs(ACCOUNT)).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------- store */

describe("loading", () => {
  it("parks the feature as unavailable when the box has no views endpoint", async () => {
    vi.spyOn(api, "views").mockRejectedValue(new ApiError(404, "not_found"));
    const onApply = vi.fn();
    renderToolbar({ accountId: ACCOUNT, scope: "person", config: {}, onApply });

    // No affordance at all — never a broken toolbar.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /saved views/i })).toBeNull();
    });
  });

  it("loads once per account", async () => {
    const views = vi.spyOn(api, "views").mockResolvedValue([]);
    await loadSavedViews(ACCOUNT);
    await loadSavedViews(ACCOUNT);
    expect(views).toHaveBeenCalledTimes(1);
  });
});

/* ----------------------------------------------------------------- toolbar */

async function openPicker(views: SavedView[], config: Record<string, unknown> = {}) {
  vi.spyOn(api, "views").mockResolvedValue(views);
  const onApply = vi.fn();
  renderToolbar({ accountId: ACCOUNT, scope: "person", config, onApply });
  const trigger = await screen.findByRole("button", { name: /saved views|saved view:/i });
  fireEvent.click(trigger);
  return { onApply };
}

describe("<SavedViews /> toolbar", () => {
  it("saves the config on screen under a name", async () => {
    const create = vi
      .spyOn(api, "createView")
      .mockResolvedValue(view({ id: "new", name: "Pipeline" }));
    await openPicker([], { layout: "board", filters: [] });

    fireEvent.change(await screen.findByLabelText("new view name"), {
      target: { value: "Pipeline" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save this view/i }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({
      kind: "database",
      scope: "person",
      name: "Pipeline",
      config: { layout: "board", filters: [] },
    });
  });

  it("offers no way to share a view with anyone", async () => {
    await openPicker([view({ id: "a", name: "Mine" })]);
    await screen.findByText("Mine");
    expect(screen.queryByText(/share/i)).toBeNull();
    expect(screen.getByText(/yours alone/i)).toBeInTheDocument();
  });

  it("applies a picked view's config and selects it in the URL", async () => {
    const { onApply } = await openPicker([
      view({ id: "a", name: "Won deals", config: { layout: "board" } }),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Won deals" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]![0]).toEqual({ layout: "board" });
  });

  it("only lists views for this kind and scope", async () => {
    await openPicker([
      view({ id: "a", name: "Mine" }),
      view({ id: "b", name: "Other type", scope: "task" }),
      view({ id: "c", name: "A graph", kind: "graph", scope: "person" }),
    ]);
    await screen.findByText("Mine");
    expect(screen.queryByText("Other type")).toBeNull();
    expect(screen.queryByText("A graph")).toBeNull();
  });

  it("pins and unpins without touching anything else", async () => {
    const patch = vi
      .spyOn(api, "patchView")
      .mockResolvedValue(view({ id: "a", name: "Mine", pinned: true }));
    await openPicker([view({ id: "a", name: "Mine" })]);

    fireEvent.click(await screen.findByRole("button", { name: "pin Mine" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { pinned: true }));
  });

  it("renames in place", async () => {
    const patch = vi.spyOn(api, "patchView").mockResolvedValue(view({ id: "a", name: "Renamed" }));
    await openPicker([view({ id: "a", name: "Mine" })]);

    fireEvent.click(await screen.findByRole("button", { name: "rename Mine" }));
    fireEvent.change(screen.getByLabelText("rename Mine"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "save name" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("a", { name: "Renamed" }));
  });

  it("asks before deleting", async () => {
    const del = vi.spyOn(api, "deleteView").mockResolvedValue({ ok: true });
    await openPicker([view({ id: "a", name: "Mine" })]);

    fireEvent.click(await screen.findByRole("button", { name: "delete Mine" }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("a"));
  });

  it("surfaces a refusal instead of swallowing it", async () => {
    vi.spyOn(api, "createView").mockRejectedValue(
      new ApiError(400, "you already have a view with that name — pick another name"),
    );
    await openPicker([]);
    fireEvent.change(await screen.findByLabelText("new view name"), { target: { value: "Dup" } });
    fireEvent.click(screen.getByRole("button", { name: /save this view/i }));
    expect(await screen.findByText(/already have a view with that name/i)).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------- sidebar */

describe("<PinnedViews />", () => {
  it("renders nothing when nothing is pinned", async () => {
    vi.spyOn(api, "views").mockResolvedValue([view({ id: "a", name: "Mine" })]);
    const { container } = renderPinned({ accountId: ACCOUNT });
    await waitFor(() => expect(api.views).toHaveBeenCalled());
    expect(container.querySelector("nav")).toBeNull();
  });

  it("lists pinned views as links to their view", async () => {
    vi.spyOn(api, "views").mockResolvedValue([
      view({ id: "a", name: "Won deals", pinned: true }),
      view({ id: "b", name: "Not pinned" }),
    ]);
    renderPinned({ accountId: ACCOUNT });
    const link = await screen.findByRole("link", { name: /Won deals/ });
    expect(link.getAttribute("href")).toBe("/t/person?view=a");
    expect(screen.queryByText("Not pinned")).toBeNull();
  });

  it("reorders on drop, sending the whole pinned list", async () => {
    vi.spyOn(api, "views").mockResolvedValue([
      view({ id: "a", name: "First", pinned: true, position: 0 }),
      view({ id: "b", name: "Second", pinned: true, position: 1 }),
    ]);
    const reorder = vi
      .spyOn(api, "reorderViews")
      .mockResolvedValue([
        view({ id: "b", name: "Second", pinned: true, position: 0 }),
        view({ id: "a", name: "First", pinned: true, position: 1 }),
      ]);
    renderPinned({ accountId: ACCOUNT });

    const second = await screen.findByRole("link", { name: /Second/ });
    fireEvent.dragStart(second);
    fireEvent.dragOver(screen.getByRole("link", { name: /First/ }));
    fireEvent.drop(screen.getByRole("link", { name: /First/ }));

    await waitFor(() => expect(reorder).toHaveBeenCalledWith(["b", "a"]));
  });

  it("reorders from the keyboard too", async () => {
    vi.spyOn(api, "views").mockResolvedValue([
      view({ id: "a", name: "First", pinned: true, position: 0 }),
      view({ id: "b", name: "Second", pinned: true, position: 1 }),
    ]);
    const reorder = vi.spyOn(api, "reorderViews").mockResolvedValue([]);
    renderPinned({ accountId: ACCOUNT });

    const second = await screen.findByRole("link", { name: /Second/ });
    fireEvent.keyDown(second, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(["b", "a"]));
  });

  it("snaps back when the box refuses the reorder", async () => {
    vi.spyOn(api, "views").mockResolvedValue([
      view({ id: "a", name: "First", pinned: true, position: 0 }),
      view({ id: "b", name: "Second", pinned: true, position: 1 }),
    ]);
    vi.spyOn(api, "reorderViews").mockRejectedValue(new ApiError(404, "not_found"));
    renderPinned({ accountId: ACCOUNT });

    const second = await screen.findByRole("link", { name: /Second/ });
    fireEvent.keyDown(second, { key: "ArrowUp", altKey: true });

    await waitFor(() => {
      const names = screen.getAllByRole("link").map((l) => l.textContent);
      expect(names).toEqual(["First", "Second"]);
    });
  });
});
