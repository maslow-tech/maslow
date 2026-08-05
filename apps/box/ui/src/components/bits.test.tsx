/**
 * The shared primitives every workspace surface leans on. These tests pin the
 * three things the beauty pass is actually FOR — a written empty state, a
 * skeleton shaped like what it is standing in for, and a keyboard affordance
 * that reads the same everywhere — plus the back-compat the rest of the app
 * depends on (`<Spinner />` and `<Empty>text</Empty>` still mean what they
 * meant).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { CreateHint, Empty, Kbd, Spinner, TypeIcon } from "./bits";

/* Everything here renders inside a router (Empty sits on Card, TypeIcon can
   land inside a Link). MemoryRouter is written out at each call site rather
   than wrapped in a helper: react-router still ships React 18 types, and a
   helper that names `ReactNode` picks a fight between the two @types/react in
   the tree. */

describe("Empty", () => {
  it("keeps the old one-child call shape working", () => {
    render(
      <MemoryRouter>
        <Empty>The trash is empty.</Empty>
      </MemoryRouter>,
    );
    expect(screen.getByText("The trash is empty.")).toBeInTheDocument();
  });

  it("carries a hint under the message when there is something to do", () => {
    render(
      <MemoryRouter>
        <Empty hint={<CreateHint what="a Deal" />}>
          No Deal objects here yet — they'll appear.
        </Empty>
      </MemoryRouter>,
    );
    expect(screen.getByText(/No Deal objects here yet/)).toBeInTheDocument();
    expect(screen.getByText("⌘N")).toBeInTheDocument();
    expect(screen.getByText(/to make a Deal/)).toBeInTheDocument();
  });

  it("says nothing about keystrokes when no hint is given", () => {
    const { container } = render(
      <MemoryRouter>
        <Empty>Nothing here.</Empty>
      </MemoryRouter>,
    );
    expect(container.querySelectorAll("kbd")).toHaveLength(0);
  });

  it("puts an action below the message", () => {
    render(
      <MemoryRouter>
        <Empty hint="Ask an owner to enable one." action={<button>Open connectors</button>}>
          No connectors available.
        </Empty>
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Open connectors" })).toBeInTheDocument();
    expect(screen.getByText("Ask an owner to enable one.")).toBeInTheDocument();
  });
});

describe("Kbd", () => {
  it("is a real <kbd>, so it reads as a key to a screen reader too", () => {
    const { container } = render(
      <MemoryRouter>
        <Kbd>⌘K</Kbd>
      </MemoryRouter>,
    );
    const kbd = container.querySelector("kbd");
    expect(kbd).not.toBeNull();
    expect(kbd?.textContent).toBe("⌘K");
  });
});

describe("Spinner", () => {
  it("still defaults to the list skeleton with the row count asked for", () => {
    const { container } = render(
      <MemoryRouter>
        <Spinner rows={3} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(9);
  });

  it("announces itself as busy in every variant", () => {
    for (const variant of ["list", "table", "cards", "board", "text"] as const) {
      const { unmount } = render(
        <MemoryRouter>
          <Spinner variant={variant} />
        </MemoryRouter>,
      );
      expect(screen.getByLabelText("Loading")).toHaveAttribute("aria-busy", "true");
      unmount();
    }
  });

  it("draws a header band plus one band per row for the table variant", () => {
    const { container } = render(
      <MemoryRouter>
        <Spinner variant="table" rows={4} />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll(".border-line-soft").length).toBe(5);
  });

  it("draws four columns for the board variant", () => {
    const { container } = render(
      <MemoryRouter>
        <Spinner variant="board" rows={3} />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll(".w-\\[260px\\]").length).toBe(4);
  });
});

describe("TypeIcon", () => {
  it("is decorative by default — the type name is written next to it", () => {
    const { container } = render(
      <MemoryRouter>
        <TypeIcon icon="🎯" type="deal" />
      </MemoryRouter>,
    );
    expect(container.querySelector("span")).toHaveAttribute("aria-hidden");
  });

  it("takes a name when it is the only thing identifying the row", () => {
    render(
      <MemoryRouter>
        <TypeIcon icon="🎯" type="deal" label="Deal" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("img", { name: "Deal" })).toBeInTheDocument();
  });

  it("carries the shared hover class so a row nudge is opt-in, not re-invented", () => {
    const { container } = render(
      <MemoryRouter>
        <TypeIcon icon="🎯" type="deal" />
      </MemoryRouter>,
    );
    expect(container.querySelector(".type-icon")).not.toBeNull();
  });

  it("falls back to the dot — which behaves the same — when there is no glyph", () => {
    const { container } = render(
      <MemoryRouter>
        <TypeIcon type="nothing_registered" />
      </MemoryRouter>,
    );
    expect(container.querySelector(".type-icon.rounded-full")).not.toBeNull();
  });
});
