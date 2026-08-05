import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { GalleryLayout, GallerySkeleton, cardSnippet, chipCandidates } from "./GalleryLayout";
import type { GalleryLayoutProps } from "./GalleryLayout";
import type { ListItem, PropDef } from "../../lib/api";
import type { ViewConfig } from "../../lib/viewConfig";

/**
 * What these pin is the gallery's CONTRACT, not its pixels:
 *
 *  - a card is a scan target: title, type icon, a flattened snippet, at most
 *    three configured props that actually have values;
 *  - clicking opens (and a modified click stays a real link);
 *  - the ONE editable thing is the title, and it commits through `onPatch`
 *    with the row's own version — never a second write path;
 *  - an unchanged title is not a write, Escape is not a write, and a viewer
 *    gets no rename affordance at all;
 *  - loading shows the skeleton wall, empty says something written, and the
 *    hover lift is dropped for reduced motion.
 */

const prop = (over: Partial<PropDef> & { name: string; kind: string }): PropDef => ({
  required: false,
  deprecated: false,
  ...over,
});

const propDefs: PropDef[] = [
  prop({ name: "status", kind: "enum", enum_values: ["open", "won"] }),
  prop({ name: "city", kind: "text" }),
  prop({ name: "stage", kind: "text" }),
  prop({ name: "summary", kind: "text" }),
  prop({ name: "owner", kind: "ref", ref_type: "person" }),
  prop({ name: "legacy", kind: "text", deprecated: true }),
];

const config = (over: Partial<ViewConfig> = {}): ViewConfig => ({
  layout: "gallery",
  filters: [],
  sort: [{ prop: "updated_at", dir: "desc" }],
  groupBy: null,
  dateProp: null,
  columns: [
    { key: "status", visible: true },
    { key: "city", visible: true },
    { key: "stage", visible: true },
    { key: "summary", visible: false },
    { key: "owner", visible: true },
  ],
  ...over,
});

const row = (over: Partial<ListItem> & { id: string }): ListItem => ({
  title: "Acme deal",
  version: 4,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  visibility: "org",
  props: { status: "open", city: "Austin", stage: "pilot", summary: "A **big** one." },
  ...over,
});

function draw(over: Partial<GalleryLayoutProps> = {}) {
  const onPatch = vi.fn<GalleryLayoutProps["onPatch"]>().mockResolvedValue(undefined);
  const onOpen = vi.fn();
  const onConfigChange = vi.fn();
  const props: GalleryLayoutProps = {
    rows: [row({ id: "a" })],
    propDefs,
    config: config(),
    onConfigChange,
    onPatch,
    onOpen,
    readOnly: false,
    type: "deal",
    ...over,
  };
  const view = render(
    <MemoryRouter>
      <GalleryLayout {...props} />
    </MemoryRouter>,
  );
  return { ...view, onPatch, onOpen, onConfigChange };
}

describe("GalleryLayout cards", () => {
  it("draws one card per row, with its title as the link that opens it", () => {
    const { onOpen } = draw({
      rows: [row({ id: "a", title: "Acme deal" }), row({ id: "b", title: "Beta deal" })],
    });

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const link = screen.getByRole("link", { name: /Acme deal/ });
    expect(link).toHaveAttribute("href", "/o/a");

    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("leaves a modified click alone — that is a real link, not an in-app open", () => {
    const { onOpen } = draw();
    // The click must reach the browser untouched; swallow it at the document
    // AFTER the card has had its say, so jsdom does not try to navigate.
    const swallow = (e: Event) => e.preventDefault();
    document.addEventListener("click", swallow);
    try {
      fireEvent.click(screen.getByRole("link", { name: /Acme deal/ }), { metaKey: true });
    } finally {
      document.removeEventListener("click", swallow);
    }
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("titles an untitled row rather than drawing an empty link", () => {
    draw({ rows: [row({ id: "a", title: null })] });
    expect(screen.getByRole("link", { name: /untitled/ })).toBeInTheDocument();
  });

  it("marks a private row private", () => {
    draw({ rows: [row({ id: "a", visibility: "private" })] });
    expect(screen.getByText("private")).toBeInTheDocument();
  });

  it("shows at most three configured props, skipping the ones with no value", () => {
    draw({
      rows: [row({ id: "a", props: { status: "open", city: "", stage: "pilot" } })],
    });
    // status + stage are the two with values; city is empty so it is not a chip.
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("stage")).toBeInTheDocument();
    expect(screen.queryByText("city")).not.toBeInTheDocument();
  });

  it("never draws more than three chips even when more are configured", () => {
    const wide = config({
      columns: [
        { key: "status", visible: true },
        { key: "city", visible: true },
        { key: "stage", visible: true },
        { key: "summary", visible: true },
      ],
    });
    draw({ config: wide });
    const names = ["status", "city", "stage", "summary"].filter(
      (n) => screen.queryByText(n) !== null,
    );
    expect(names).toHaveLength(3);
  });

  it("renders the presence slot the host supplies, and nothing when it supplies none", () => {
    const { rerender } = draw({
      presenceSlot: (r) => <span>here: {r.id}</span>,
    });
    expect(screen.getByText(/here: a/)).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <GalleryLayout
          rows={[row({ id: "a" })]}
          propDefs={propDefs}
          config={config()}
          onConfigChange={vi.fn()}
          onPatch={vi.fn().mockResolvedValue(undefined)}
          onOpen={vi.fn()}
          readOnly={false}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/here: a/)).not.toBeInTheDocument();
  });

  it("lifts on hover through the shared motion tokens, not a hardcoded duration", () => {
    draw();
    const card = screen.getByRole("listitem").firstElementChild!;
    // The lift reads `--lift-card`, which the reduced-motion media collapses to
    // 0px — so the token IS the reduced-motion handling, and no bespoke
    // `motion-reduce:` override (or a stray 150ms) is invented alongside it.
    expect(card.className).toContain("hover:translate-y-[var(--lift-card)]");
    expect(card.className).toContain("duration-[var(--dur-fast)]");
    expect(card.className).not.toContain("hover:-translate-y-0.5");
    expect(card.className).not.toContain("duration-150");
  });
});

describe("GalleryLayout inline title edit", () => {
  it("commits through onPatch with the row's own version", async () => {
    const { onPatch } = draw();

    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    const input = screen.getByLabelText("Title");
    fireEvent.change(input, { target: { value: "Acme deal v2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onPatch).toHaveBeenCalledWith("a", 4, { title: "Acme deal v2" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());
  });

  it("reads a string version off the wire as a number CAS base", async () => {
    const { onPatch } = draw({ rows: [row({ id: "a", version: "9" })] });

    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter" });

    await waitFor(() => expect(onPatch).toHaveBeenCalledWith("a", 9, { title: "Renamed" }));
  });

  it("commits on blur — clicking away is not a way to lose typing", async () => {
    const { onPatch } = draw();
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Blurred" } });
    fireEvent.blur(screen.getByLabelText("Title"));
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith("a", 4, { title: "Blurred" }));
  });

  it("writes nothing when the title did not change", async () => {
    const { onPatch } = draw();
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter" });

    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("writes nothing on Escape, and puts the row's own title back", async () => {
    const { onPatch } = draw();
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "typed but abandoned" } });
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Escape" });

    expect(onPatch).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Acme deal/ })).toBeInTheDocument();
  });

  it("clears a title to null rather than writing an empty string", async () => {
    const { onPatch } = draw();
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } });
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter" });
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith("a", 4, { title: null }));
  });

  it("shows the row again after the write settles — the card keeps no copy", async () => {
    const { onPatch, rerender } = draw();
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Optimistic" } });
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter" });
    await waitFor(() => expect(onPatch).toHaveBeenCalled());

    // The shell refused it: the row comes back unchanged, and that is what the
    // card must show — no local echo of the rejected draft.
    rerender(
      <MemoryRouter>
        <GalleryLayout
          rows={[row({ id: "a", title: "Acme deal" })]}
          propDefs={propDefs}
          config={config()}
          onConfigChange={vi.fn()}
          onPatch={onPatch}
          onOpen={vi.fn()}
          readOnly={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /Acme deal/ })).toBeInTheDocument();
    expect(screen.queryByText("Optimistic")).not.toBeInTheDocument();
  });

  it("gives a viewer no rename affordance", () => {
    draw({ readOnly: true });
    expect(screen.queryByRole("button", { name: /Rename/ })).not.toBeInTheDocument();
  });
});

describe("GalleryLayout states", () => {
  it("draws the skeleton wall while the first page loads", () => {
    draw({ rows: [], loading: true });
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("keeps the rows on screen during a refresh instead of blanking them", () => {
    draw({ loading: true });
    expect(screen.getByRole("link", { name: /Acme deal/ })).toBeInTheDocument();
    expect(screen.getByRole("list")).toHaveAttribute("aria-busy", "true");
  });

  it("says something written when the view is empty, and how to fix it", () => {
    draw({ rows: [] });
    expect(screen.getByText(/No cards here yet/)).toBeInTheDocument();
    // The empty state is an invitation: it names the keystroke that fills it.
    expect(screen.getByText("⌘N")).toBeInTheDocument();
  });

  it("does not tell a viewer to press a key they cannot use", () => {
    draw({ rows: [], readOnly: true });
    expect(screen.getByText(/No cards here yet/)).toBeInTheDocument();
    expect(screen.queryByText("⌘N")).not.toBeInTheDocument();
  });

  it("offers no keystroke when the emptiness is the filters' doing", () => {
    draw({ rows: [], config: config({ filters: [{ prop: "status", op: "eq", value: "won" }] }) });
    expect(screen.queryByText("⌘N")).not.toBeInTheDocument();
  });

  it("blames the filters when there are filters to blame", () => {
    draw({ rows: [], config: config({ filters: [{ prop: "status", op: "eq", value: "won" }] }) });
    expect(screen.getByText(/No cards match these filters/)).toBeInTheDocument();
  });

  it("skeleton cards match the card count asked for", () => {
    const { container } = render(<GallerySkeleton count={3} />);
    expect(container.querySelectorAll('[data-slot="gallery-skeleton-card"]')).toHaveLength(3);
  });
});

describe("chipCandidates", () => {
  it("follows the configured column order and drops refs and deprecated props", () => {
    const names = chipCandidates(
      config({
        columns: [
          { key: "owner", visible: true },
          { key: "legacy", visible: true },
          { key: "city", visible: true },
          { key: "status", visible: true },
        ],
      }),
      propDefs,
    ).map((p) => p.name);
    expect(names).toEqual(["city", "status"]);
  });

  it("ignores a saved column naming a property the catalog no longer has", () => {
    const names = chipCandidates(
      config({
        columns: [
          { key: "gone", visible: true },
          { key: "city", visible: true },
        ],
      }),
      propDefs,
    ).map((p) => p.name);
    expect(names).toEqual(["city"]);
  });

  it("falls back to the catalog when the config shows nothing", () => {
    const names = chipCandidates(
      config({ columns: [{ key: "city", visible: false }] }),
      propDefs,
    ).map((p) => p.name);
    expect(names).toEqual(["status", "city", "stage", "summary"]);
  });
});

describe("cardSnippet", () => {
  const empty = new Set<string>();

  it("prefers a body-shaped property and flattens its markdown", () => {
    const r = row({ id: "a", props: { summary: "## Big **deal** here", city: "Austin" } });
    expect(cardSnippet(r, propDefs, empty)).toBe("Big deal here");
  });

  it("skips anything already shown as a chip", () => {
    const r = row({ id: "a", props: { summary: "shown as a chip", stage: "the long way round" } });
    expect(cardSnippet(r, propDefs, new Set(["summary"]))).toBe("the long way round");
  });

  it("takes the longest text when nothing is body-shaped", () => {
    const r = row({ id: "a", props: { city: "Austin", stage: "a much longer stage note" } });
    expect(cardSnippet(r, propDefs, new Set(["summary"]))).toBe("a much longer stage note");
  });

  it("caps on a word boundary rather than mid-word", () => {
    const r = row({ id: "a", props: { summary: `${"word ".repeat(40)}tail` } });
    const out = cardSnippet(r, propDefs, empty, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toContain("wor…");
  });

  it("is empty when the row has no text to preview", () => {
    const r = row({ id: "a", props: { status: "open" } });
    expect(cardSnippet(r, propDefs, empty)).toBe("");
  });

  it("uses a body field when a row carries one", () => {
    const r = { ...row({ id: "a", props: {} }), body: "straight from the object" };
    expect(cardSnippet(r, propDefs, empty)).toBe("straight from the object");
  });

  it("renders the snippet on the card", () => {
    draw({ rows: [row({ id: "a", props: { summary: "A **big** one." } })] });
    const card = screen.getByRole("listitem");
    expect(within(card).getByText("A big one.")).toBeInTheDocument();
  });
});
