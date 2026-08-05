import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Shell } from "./Shell";
import { api, type TypeSummary, type Whoami } from "../lib/api";
import { addFavorite, recordRecent, resetChromeStore } from "../lib/favorites";
import { resetObjectMetaCache } from "../components/Breadcrumbs";

/**
 * A smoke test for the frame itself: the chrome sections appear where they
 * belong, they show THIS account's rows, and the header trail rides above the
 * routed page rather than replacing it. The details of each piece are tested in
 * favorites.test.ts and Breadcrumbs.test.tsx.
 */

const USER: Whoami = {
  id: "acct-aaaa",
  name: "Ada",
  role: "member",
  appVersion: "v0.0.0-test",
} as Whoami;

const types: TypeSummary[] = [
  {
    id: 1,
    name: "deal",
    label: "Deals",
    description: null,
    icon: "",
    deprecated: false,
    count: 4,
    properties: [],
  },
];

// BEFORE, not after: the shared setup wipes localStorage between tests, and a
// module store that already holds an account keeps serving it (that cache is
// the point in the browser). Resetting on the way IN makes each test start from
// the storage it just cleared.
beforeEach(() => {
  resetChromeStore();
  resetObjectMetaCache();
});

function renderShell(at = "/t/deal", user: Whoami = USER) {
  vi.spyOn(api, "types").mockResolvedValue(types);
  // An older box with no /api/v1/views: the pinned block must simply not
  // appear, and the rest of the sidebar must not notice.
  vi.spyOn(api, "views").mockRejectedValue(new Error("no saved views on this box"));
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route element={<Shell user={user} onSignOut={() => {}} brandName="Brain" />}>
          <Route path="/t/:type" element={<div>the page</div>} />
          {/* A second destination, so a test can navigate WITHIN the shell.
              A pathless layout route only renders while some child matches —
              route to an unknown path and the Shell unmounts, which looks
              exactly like a bug in the shell itself. */}
          <Route path="/timeline" element={<div>the timeline</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * THE ⌘N GATE, AS BEHAVIOUR.
 *
 * This used to be asserted in `test/src/workspace.e2e.test.ts` as a REGEX OVER
 * SHELL.TSX'S SOURCE TEXT (`/const canWrite = user\.role !== "viewer"/`), with
 * the note "pinned as a narrow source read, since this file has no DOM". A
 * source read passes whether or not the app does anything with the line it
 * matched — rename the variable and it goes red for no reason; keep the name
 * and delete its use and it stays green while a viewer gets a create dialog.
 * This file HAS a DOM, so the gate is tested by pressing the key.
 */
describe("<Shell /> quick-create is gated on the role, not just on buttons", () => {
  const VIEWER = { ...USER, role: "viewer" } as Whoami;

  it("opens the create dialog for a member", async () => {
    renderShell();
    expect(await screen.findByText("the page")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    // The negative below means nothing unless the positive works.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("does nothing for a viewer — the affordance is never offered", async () => {
    renderShell("/t/deal", VIEWER);
    expect(await screen.findByText("the page")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    // …and no button offers it either.
    expect(screen.queryByRole("button", { name: /^new$/i })).not.toBeInTheDocument();
  });
});

describe("<Shell /> chrome", () => {
  it("keeps the routed page under a breadcrumb header", async () => {
    renderShell();
    expect(await screen.findByText("the page")).toBeInTheDocument();
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(trail).toHaveTextContent("Home");
    expect(trail).toHaveTextContent("Deals");
  });

  it("keeps favorites AND recents off the rail — the sidebar is nav and databases", async () => {
    addFavorite(USER.id, { kind: "type", key: "deal", label: "Deals", type: "deal" });
    recordRecent(USER.id, { kind: "object", key: "o1", label: "Acme renewal", type: "deal" });
    renderShell();
    await screen.findByText("the page");

    // Both shelves used to sit around the Databases list and cap its height.
    // They live on Home ("Jump back in"), in ⌘K, and — for favorites — on the
    // header star. Never in the sidebar.
    expect(screen.queryByRole("navigation", { name: "Favorites" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Recents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Acme renewal/ })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Star an object or a database to keep it here."),
    ).not.toBeInTheDocument();
  });

  it("stars the database on screen from the header", async () => {
    renderShell();
    const star = await screen.findByRole("button", { name: "Favorite Deals" });
    star.click();
    // The shelf is gone, so the STAR ITSELF is the feedback that it stuck —
    // it flips to the un-favorite affordance and the entry is persisted.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unfavorite Deals" })).toBeInTheDocument(),
    );
  });

  it("keeps the sidebar in the page on a desktop viewport", async () => {
    renderShell();
    await screen.findByText("the page");
    // No drawer chrome at all: the sidebar is furniture, not an overlay.
    expect(screen.queryByRole("button", { name: "Open navigation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });
});

/**
 * The phone frame. jsdom has no layout, so these assert the CONTRACT the
 * mobile shell is built on — the drawer is a modal dialog that starts closed
 * and inert, the hamburger and the bottom bar exist, Escape/backdrop dismiss —
 * rather than pixel geometry, which lives in index.css and is verified by eye.
 */
describe("<Shell /> on a phone", () => {
  /** Answer the shell's own media query with `true` and every other query
   *  (prefers-color-scheme, prefers-reduced-motion) with `false`. */
  function mockPhoneViewport(): void {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("max-width: 767px"),
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

  beforeEach(mockPhoneViewport);

  it("hides the sidebar behind a hamburger and shows a bottom bar", async () => {
    renderShell();
    await screen.findByText("the page");

    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
    // The desktop rail toggle has no meaning here — there is no rail.
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();

    const bottom = screen.getByRole("navigation", { name: "Primary" });
    for (const label of ["Home", "Search", "Graph"]) {
      expect(within(bottom).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(within(bottom).getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("starts closed and inert, and opens as a modal dialog", async () => {
    renderShell();
    await screen.findByText("the page");

    const drawer = document.getElementById("app-sidebar");
    expect(drawer).not.toBeNull();
    expect(drawer).toHaveAttribute("data-open", "false");
    expect(drawer).toHaveAttribute("inert");
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(drawer).toHaveAttribute("role", "dialog");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    await waitFor(() => expect(drawer).toHaveAttribute("data-open", "true"));
    // Not inert any more — its links are reachable by tab and by screen reader.
    expect(drawer).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("closes on Escape, on the backdrop, and on navigation", async () => {
    renderShell();
    await screen.findByText("the page");
    const drawer = document.getElementById("app-sidebar");
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    open();
    await waitFor(() => expect(drawer).toHaveAttribute("data-open", "true"));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(drawer).toHaveAttribute("data-open", "false"));
    // Focus goes back to the control that opened it, never to nothing.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open navigation" }));

    open();
    await waitFor(() => expect(drawer).toHaveAttribute("data-open", "true"));
    const backdrop = document.querySelector(".drawer-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    await waitFor(() => expect(drawer).toHaveAttribute("data-open", "false"));

    open();
    await waitFor(() => expect(drawer).toHaveAttribute("data-open", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    await waitFor(() => expect(drawer).toHaveAttribute("data-open", "false"));

    open();
    await waitFor(() => expect(drawer).toHaveAttribute("data-open", "true"));
    // Every link inside the drawer is a route change, and a route change is
    // the dismiss — no link carries an onClick of its own.
    fireEvent.click(within(drawer as HTMLElement).getByRole("link", { name: /Timeline/ }));
    await waitFor(() => expect(drawer).toHaveAttribute("data-open", "false"));
  });

  it("moves focus into the drawer and traps Tab there", async () => {
    renderShell();
    await screen.findByText("the page");
    const drawer = document.getElementById("app-sidebar") as HTMLElement;

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));

    // Tab off the last stop wraps to the first rather than escaping to the
    // page behind the modal.
    const stops = drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
    const last = stops[stops.length - 1];
    last?.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    await waitFor(() => expect(document.activeElement).toBe(stops[0]));
  });
});
