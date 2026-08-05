import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalGraph, RAIL_LEGIBLE_MIN_PX, railIsLegible } from "./LocalGraph";
import type { BrainObject, Edge } from "../lib/api";

/**
 * The rail on a phone.
 *
 * The rule this pins is the honest one rather than the flattering one: a
 * 340px-wide rail cannot draw 80 nodes with 12.5px labels, so below
 * `RAIL_LEGIBLE_MIN_PX` it does NOT draw a smaller, prettier, unreadable
 * version — it collapses to a named entry point you can actually tap, and the
 * graph appears only once someone asks for it. The second half of that promise
 * matters as much: while collapsed the rail stays at depth 1, which costs zero
 * network (the object payload already carries its own links), so a phone never
 * walks the frontier for a picture nobody has looked at.
 *
 * `api` is mocked to throw on any frontier fetch, so "no fetch" is asserted by
 * construction and not by a spy that could quietly pass on a typo.
 */

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      object: vi.fn(() => {
        throw new Error("the collapsed rail must not walk the frontier");
      }),
    },
  };
});

function edge(id: string, rel = "mentions"): Edge {
  return {
    rel,
    id,
    provenance: "manual",
    target_deleted: false,
    target_title: id.toUpperCase(),
    target_type: "note",
  };
}

function object(id: string, links: Edge[] = []): BrainObject {
  return {
    id,
    type: "note",
    title: id.toUpperCase(),
    body: null,
    version: 1,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    deleted_at: null,
    visibility: "org",
    props: {},
    links,
    backlinks: [],
    links_truncated: false,
    backlinks_truncated: false,
    hidden_from_you: 0,
  };
}

/** Force `(pointer: coarse)` on or off for one test. */
function setPointer(coarse: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("pointer: coarse") ? coarse : false,
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

function renderRail(obj: BrainObject) {
  return render(
    <MemoryRouter>
      <LocalGraph object={obj} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("railIsLegible", () => {
  it("never collapses a mouse rail — you can hover it for detail", () => {
    expect(railIsLegible(200, false)).toBe(true);
    expect(railIsLegible(RAIL_LEGIBLE_MIN_PX - 100, false)).toBe(true);
  });

  it("collapses a touch rail narrower than a phone can read", () => {
    expect(railIsLegible(RAIL_LEGIBLE_MIN_PX - 1, true)).toBe(false);
    expect(railIsLegible(320, true)).toBe(false);
  });

  it("keeps a touch rail that has the room", () => {
    expect(railIsLegible(RAIL_LEGIBLE_MIN_PX, true)).toBe(true);
    expect(railIsLegible(768, true)).toBe(true);
  });
});

describe("LocalGraph on a phone", () => {
  const focus = object("focus", [edge("a"), edge("b"), edge("c")]);

  it("offers an explicit entry point instead of an unreadable graph", () => {
    setPointer(true);
    renderRail(focus);

    const open = screen.getByRole("button", { name: /view connections/i });
    expect(open).toBeInTheDocument();
    expect(open).toHaveAttribute("aria-expanded", "false");
    // The count is the point of the entry: "view connections" with no number
    // is a door with nothing written on it.
    expect(open).toHaveTextContent("3");
    expect(document.querySelector("svg")).toBeNull();
  });

  it("still offers the full graph as a way out", () => {
    setPointer(true);
    renderRail(focus);
    expect(screen.getByRole("button", { name: /full graph/i })).toBeInTheDocument();
  });

  it("says so plainly when there is nothing to see", () => {
    setPointer(true);
    renderRail(object("lonely"));
    expect(screen.getByRole("button", { name: /view connections/i })).toHaveTextContent(
      /none yet/i,
    );
  });

  it("draws the graph once asked, with a way back", async () => {
    setPointer(true);
    renderRail(focus);

    fireEvent.click(screen.getByRole("button", { name: /view connections/i }));

    await screen.findByRole("img", { name: /local graph/i });
    expect(screen.getByRole("button", { name: /^hide$/i })).toBeInTheDocument();
  });

  it("draws immediately on a mouse rail — nothing here changes the desktop", () => {
    setPointer(false);
    renderRail(focus);
    expect(screen.queryByRole("button", { name: /view connections/i })).toBeNull();
    expect(screen.getByRole("img", { name: /local graph/i })).toBeInTheDocument();
  });
});
