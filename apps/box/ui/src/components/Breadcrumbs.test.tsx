import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  Breadcrumbs,
  buildCrumbs,
  favoriteTargetFor,
  resetObjectMetaCache,
  type ObjectMeta,
} from "./Breadcrumbs";
import { api, type BrainObject } from "../lib/api";
import { isFavorite, loadChrome, resetChromeStore } from "../lib/favorites";

/**
 * The trail is a pure function of the URL, so most of this file tests that
 * function directly: a peek crumb links to the SAME route with the stack
 * truncated (clicking it closes the peeks above it), the place you are standing
 * is text rather than a link to itself, and an object we have not read yet
 * never gets a guessed title.
 *
 * The component tests cover the two side effects the header owns: starring the
 * thing on screen, and writing the recents list.
 */

const ACCOUNT = "acct-aaaa";

// On the way IN: the shared setup wipes localStorage between tests, and both
// module caches deliberately outlive a single render.
beforeEach(() => {
  resetChromeStore();
  resetObjectMetaCache();
});

const label = (name: string) => (name === "deal" ? "Deals" : name);

const metaOf =
  (map: Record<string, ObjectMeta>) =>
  (id: string): ObjectMeta | null =>
    map[id] ?? null;

const object = (over: Partial<BrainObject> = {}): BrainObject => ({
  id: "o1",
  type: "deal",
  title: "Acme renewal",
  body: null,
  version: 3,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  deleted_at: null,
  visibility: "org",
  props: {},
  links: [],
  backlinks: [],
  links_truncated: false,
  backlinks_truncated: false,
  hidden_from_you: 0,
  ...over,
});

describe("buildCrumbs", () => {
  it("puts a database under Home and stops there", () => {
    const crumbs = buildCrumbs({
      pathname: "/t/deal",
      search: "",
      peek: [],
      meta: metaOf({}),
      label,
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Home", "Deals"]);
    expect(crumbs[0]?.to).toBe("/");
    // where you are is not a link to itself
    expect(crumbs[1]?.to).toBeNull();
  });

  it("hangs a typed object off its database", () => {
    const crumbs = buildCrumbs({
      pathname: "/o/o1",
      search: "",
      peek: [],
      meta: metaOf({ o1: { title: "Acme renewal", type: "deal" } }),
      label,
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Home", "Deals", "Acme renewal"]);
    expect(crumbs[1]?.to).toBe("/t/deal");
  });

  it("hangs an untyped object off Notes and names an empty title", () => {
    const crumbs = buildCrumbs({
      pathname: "/o/o9",
      search: "",
      peek: [],
      meta: metaOf({ o9: { title: "  ", type: null } }),
      label,
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Home", "Notes", "untitled"]);
  });

  it("shows a placeholder — never a guess — before the read lands", () => {
    const crumbs = buildCrumbs({
      pathname: "/o/o1",
      search: "",
      peek: [],
      meta: metaOf({}),
      label,
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Home", "…"]);
  });

  it("adds one crumb per open peek, each truncating the stack", () => {
    const crumbs = buildCrumbs({
      pathname: "/t/deal",
      search: "?view=v1&peek=a,b",
      peek: ["a", "b"],
      meta: metaOf({ a: { title: "First", type: null }, b: { title: "Second", type: null } }),
      label,
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Home", "Deals", "First", "Second"]);
    // the deeper crumb is now a link (the trail's own route is still /t/deal)
    expect(crumbs[1]?.to).toBe("/t/deal");
    // clicking "First" keeps every other param and drops the peek above it
    const first = new URL(`http://x${crumbs[2]?.to ?? ""}`);
    expect(first.pathname).toBe("/t/deal");
    expect(first.searchParams.get("peek")).toBe("a");
    expect(first.searchParams.get("view")).toBe("v1");
    expect(crumbs[3]?.to).toBeNull();
  });

  it("names known pages and leaves unknown ones at Home", () => {
    const at = (pathname: string) =>
      buildCrumbs({ pathname, search: "", peek: [], meta: metaOf({}), label }).map((c) => c.label);
    expect(at("/timeline")).toEqual(["Home", "Timeline"]);
    expect(at("/")).toEqual(["Home"]);
    expect(at("/nowhere")).toEqual(["Home"]);
  });
});

describe("favoriteTargetFor", () => {
  it("stars the object on an object page", () => {
    expect(
      favoriteTargetFor({
        pathname: "/o/o1",
        peek: [],
        meta: metaOf({ o1: { title: "Acme renewal", type: "deal" } }),
        label,
      }),
    ).toEqual({ kind: "object", key: "o1", label: "Acme renewal", type: "deal" });
  });

  it("stars the database on a type page", () => {
    expect(favoriteTargetFor({ pathname: "/t/deal", peek: [], meta: metaOf({}), label })).toEqual({
      kind: "type",
      key: "deal",
      label: "Deals",
      type: "deal",
    });
  });

  it("stars the peeked object, not the page under it", () => {
    expect(
      favoriteTargetFor({
        pathname: "/t/deal",
        peek: ["a", "b"],
        meta: metaOf({ b: { title: "Peeked", type: null } }),
        label,
      }),
    ).toEqual({ kind: "object", key: "b", label: "Peeked", type: null });
  });

  it("offers nothing on a page with nothing to star, or before a read lands", () => {
    expect(
      favoriteTargetFor({ pathname: "/search", peek: [], meta: metaOf({}), label }),
    ).toBeNull();
    expect(favoriteTargetFor({ pathname: "/o/o1", peek: [], meta: metaOf({}), label })).toBeNull();
  });
});

describe("<Breadcrumbs />", () => {
  const renderAt = (pathname: string, peek: readonly string[] = []) =>
    render(
      <MemoryRouter>
        <Breadcrumbs accountId={ACCOUNT} pathname={pathname} search="" peek={peek} />
      </MemoryRouter>,
    );

  it("reads the object once and renders its trail", async () => {
    const spy = vi.spyOn(api, "object").mockResolvedValue(object());
    const { rerender } = renderAt("/o/o1");

    expect(await screen.findByText("Acme renewal")).toBeInTheDocument();
    expect(screen.getByText("Deal")).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <Breadcrumbs accountId={ACCOUNT} pathname="/o/o1" search="" peek={[]} />
      </MemoryRouter>,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("renders an unreadable id as untitled rather than an error", async () => {
    vi.spyOn(api, "object").mockRejectedValue(new Error("nope"));
    renderAt("/o/ghost");
    expect(await screen.findByText("untitled")).toBeInTheDocument();
  });

  it("stars and unstars what is on screen", async () => {
    vi.spyOn(api, "object").mockResolvedValue(object());
    renderAt("/o/o1");

    const star = await screen.findByRole("button", { name: "Favorite Acme renewal" });
    star.click();
    await waitFor(() => expect(isFavorite(ACCOUNT, "object", "o1")).toBe(true));

    const lit = await screen.findByRole("button", { name: "Unfavorite Acme renewal" });
    lit.click();
    await waitFor(() => expect(isFavorite(ACCOUNT, "object", "o1")).toBe(false));
  });

  it("records the visit once the title is known, never before", async () => {
    vi.spyOn(api, "object").mockResolvedValue(object());
    renderAt("/o/o1");

    await waitFor(() => {
      const { recents } = loadChrome(ACCOUNT);
      expect(recents).toHaveLength(1);
      expect(recents[0]).toMatchObject({ kind: "object", key: "o1", label: "Acme renewal" });
    });
  });

  it("has nothing to star on a page that is not a thing", () => {
    renderAt("/search");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Search")).toBeInTheDocument();
  });
});
