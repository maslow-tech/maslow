import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BlockEditor,
  filterSlashCommands,
  keyboardInset,
  readSlashQueryFromText,
} from "./BlockEditor";
import { readLinkTrigger } from "./LinkSuggest";
import * as Y from "yjs";

import { writeRoomContent } from "@/lib/collab";

/**
 * Mount-level checks for the editor shell. Content FIDELITY is not tested here
 * — markdown.test.ts owns that, against the same serializer this component
 * calls. What this file pins is the wiring that test cannot see: that the
 * component mounts at all, that it is genuinely controlled, and that the
 * block palette matches the words a user types.
 *
 * Simulated typing is deliberately absent: ProseMirror's DOM observer calls
 * `getClientRects`/`posAtCoords`, which jsdom does not implement, so a typing
 * test here would assert on a layout engine that isn't running. The keystroke
 * path is browser-verified instead.
 */
describe("BlockEditor", () => {
  it("mounts and renders the seeded markdown", () => {
    render(<BlockEditor value={"# Title\n\n- a\n- b"} ariaLabel="Body" />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByLabelText("Body").textContent).toContain("a");
  });

  it("re-seeds when the parent hands it a foreign value", () => {
    const { rerender } = render(<BlockEditor value="one" ariaLabel="Body" />);
    rerender(<BlockEditor value="two" ariaLabel="Body" />);
    expect(screen.getByLabelText("Body").textContent).toContain("two");
  });

  it("is read-only when editable is false", () => {
    render(<BlockEditor value="locked" editable={false} ariaLabel="Body" />);
    expect(screen.getByLabelText("Body")).toHaveAttribute("contenteditable", "false");
  });

  describe("slash palette", () => {
    it("offers every block with no query", () => {
      expect(filterSlashCommands("").map((c) => c.id)).toEqual([
        "h1",
        "h2",
        "h3",
        "bullet",
        "ordered",
        "todo",
        "quote",
        "code",
        "image",
        "table",
        "divider",
      ]);
    });

    it("matches on the label", () => {
      expect(filterSlashCommands("head").map((c) => c.id)).toEqual(["h1", "h2", "h3"]);
      expect(filterSlashCommands("divider").map((c) => c.id)).toEqual(["divider"]);
    });

    /** The label is "To-do list"; the word users type is "todo". */
    it("matches the words users type, not just the label spelling", () => {
      expect(filterSlashCommands("todo").map((c) => c.id)).toEqual(["todo"]);
      expect(filterSlashCommands("checkbox").map((c) => c.id)).toEqual(["todo"]);
      expect(filterSlashCommands("ul").map((c) => c.id)).toEqual(["bullet"]);
      expect(filterSlashCommands("hr").map((c) => c.id)).toEqual(["divider"]);
    });

    it("is case-insensitive and returns nothing for a miss", () => {
      expect(filterSlashCommands("QUOTE").map((c) => c.id)).toEqual(["quote"]);
      expect(filterSlashCommands("zzz")).toHaveLength(0);
    });
  });

  /**
   * The slash menu and LinkSuggest both take Enter in the capture phase, so
   * they must never both be open. The two trigger rules are the whole defence:
   * a bracket closes the slash query, and LinkSuggest only fires on `[[`.
   */
  describe("slash / link trigger exclusivity", () => {
    it("opens the slash menu on a real slash query", () => {
      expect(readSlashQueryFromText("/head")).toBe("head");
      expect(readSlashQueryFromText("write /quote")).toBe("quote");
      expect(readSlashQueryFromText("/")).toBe("");
    });

    it("closes the slash query at a bracket, so a link trigger owns the keys", () => {
      expect(readSlashQueryFromText("/foo[[bar")).toBeNull();
      expect(readSlashQueryFromText("/foo[[")).toBeNull();
      expect(readSlashQueryFromText("[[acme")).toBeNull();
    });

    it("never both: no text yields a slash query and a link trigger at once", () => {
      const samples = [
        "/head",
        "/foo[[bar",
        "[[acme",
        "see /quote and [[thing",
        "plain prose",
        "and/or",
        "/",
        "[[",
      ];
      for (const text of samples) {
        const slash = readSlashQueryFromText(text);
        const link = readLinkTrigger(text);
        expect(slash !== null && link !== null, `both fired on ${JSON.stringify(text)}`).toBe(
          false,
        );
      }
    });
  });
});

/**
 * Collab mode. The extension wiring is the whole risk here: `Collaboration`
 * takes the document over, so a mistake does not fail loudly — it duplicates a
 * body or silently ignores remote edits. These mount-level checks pin the three
 * inversions the prop documents.
 */
describe("BlockEditor — collab mode", () => {
  it("renders the Y.Doc, not the `value` prop", () => {
    const doc = new Y.Doc();
    writeRoomContent(doc, { body: "# From the room\n\ncrdt text" });
    render(<BlockEditor value="markdown that must be ignored" ariaLabel="Body" collab={{ doc }} />);
    expect(screen.getByRole("heading", { name: "From the room" })).toBeInTheDocument();
    expect(screen.getByLabelText("Body").textContent).toContain("crdt text");
    expect(screen.getByLabelText("Body").textContent).not.toContain("must be ignored");
  });

  it("never re-seeds from `value` — that would replay the body for everyone", () => {
    const doc = new Y.Doc();
    writeRoomContent(doc, { body: "crdt text" });
    const { rerender } = render(<BlockEditor value="one" ariaLabel="Body" collab={{ doc }} />);
    rerender(<BlockEditor value="two" ariaLabel="Body" collab={{ doc }} />);
    expect(screen.getByLabelText("Body").textContent).toBe("crdt text");
  });

  it("shows a remote edit and does not echo it back through onChange", () => {
    const doc = new Y.Doc();
    writeRoomContent(doc, { body: "first" });
    const changes: string[] = [];
    render(
      <BlockEditor
        value=""
        ariaLabel="Body"
        collab={{ doc }}
        onChange={(md) => changes.push(md)}
      />,
    );
    writeRoomContent(doc, { body: "first\n\nfrom an agent" });
    expect(screen.getByLabelText("Body").textContent).toContain("from an agent");
    // The CAS queue is suspended for body/title while a room owns them; an
    // onChange here would be a second writer for the same text.
    expect(changes).toEqual([]);
  });
});

/**
 * Touch. jsdom has no layout and no on-screen keyboard, so what these pin is
 * the CONTRACT the mobile editor is built on — that hover-only affordances are
 * replaced rather than merely hidden, that the replacement is docked off a
 * measured keyboard height, and that the block actions a drag handle used to
 * offer are reachable by tap. The geometry itself lives in editor.css and is
 * verified on a device.
 */
describe("BlockEditor on a touch screen", () => {
  /** Answer `(pointer: coarse)` with true and every other query with false. */
  function mockCoarsePointer(coarse: boolean): void {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: coarse && query.includes("pointer: coarse"),
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("keyboardInset", () => {
    it("is zero with no visual viewport to measure", () => {
      expect(keyboardInset(null, 844)).toBe(0);
      expect(keyboardInset(undefined, 844)).toBe(0);
    });

    it("is the slice of the layout viewport the keyboard covers", () => {
      expect(keyboardInset({ height: 480, offsetTop: 0 }, 844)).toBe(364);
    });

    /** iOS scrolls the visual viewport instead of resizing it; offsetTop is
     *  part of the answer, not a separate case. */
    it("counts a scrolled visual viewport", () => {
      expect(keyboardInset({ height: 480, offsetTop: 60 }, 844)).toBe(304);
    });

    /** A collapsing URL bar shrinks the visual viewport by a few dozen pixels;
     *  treating that as a keyboard would make the bar hop while scrolling. */
    it("ignores browser chrome below the keyboard floor", () => {
      expect(keyboardInset({ height: 800, offsetTop: 0 }, 844)).toBe(0);
    });

    it("never goes negative when the viewport is taller than the layout", () => {
      expect(keyboardInset({ height: 900, offsetTop: 0 }, 844)).toBe(0);
    });
  });

  it("shows no docked bar on a pointer that can hover", () => {
    mockCoarsePointer(false);
    render(<BlockEditor value="text" ariaLabel="Body" />);
    fireEvent.focus(screen.getByLabelText("Body"));
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
  });

  it("docks a persistent formatting bar once the editor has focus", () => {
    mockCoarsePointer(true);
    render(<BlockEditor value="text" ariaLabel="Body" />);
    // Nothing over the document until someone is actually editing it.
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();

    fireEvent.focus(screen.getByLabelText("Body"));
    const bar = screen.getByRole("toolbar", { name: "Formatting" });
    for (const name of ["Bold", "Italic", "Inline code", "Bulleted list", "To-do list", "Link"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(bar).toContainElement(screen.getByRole("button", { name: "Done" }));

    fireEvent.blur(screen.getByLabelText("Body"));
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
  });

  it("offers the [[link]] trigger only when there is a sink for the edge", () => {
    mockCoarsePointer(true);
    const { rerender } = render(<BlockEditor value="text" ariaLabel="Body" />);
    fireEvent.focus(screen.getByLabelText("Body"));
    expect(screen.queryByRole("button", { name: "Link to an object" })).not.toBeInTheDocument();

    rerender(<BlockEditor value="text" ariaLabel="Body" onLink={() => {}} />);
    fireEvent.focus(screen.getByLabelText("Body"));
    expect(screen.getByRole("button", { name: "Link to an object" })).toBeInTheDocument();
  });

  it("puts the drag handle's menu behind a tap instead", () => {
    mockCoarsePointer(true);
    render(<BlockEditor value="text" ariaLabel="Body" />);
    fireEvent.focus(screen.getByLabelText("Body"));

    const trigger = screen.getByRole("button", { name: "Block actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const sheet = screen.getByRole("menu", { name: "Block actions" });
    expect(sheet).toContainElement(screen.getByRole("menuitem", { name: "Select block" }));
    expect(sheet).toContainElement(screen.getByRole("menuitem", { name: "Delete block" }));
    // The whole block palette, tappable — no slash query to type on a phone.
    for (const label of ["Heading 1", "Bulleted list", "Code block"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("publishes the measured keyboard inset the docked chrome is positioned from", () => {
    mockCoarsePointer(true);
    render(<BlockEditor value="text" ariaLabel="Body" />);
    fireEvent.focus(screen.getByLabelText("Body"));
    const root = screen.getByLabelText("Body").closest(".editor-root") as HTMLElement | null;
    // jsdom has no visualViewport, so the measurement is 0 — the point is that
    // the variable EXISTS and the stylesheet's max() fallback has something to
    // read. A missing var would silently dock everything to `bottom: 0`.
    expect(root?.style.getPropertyValue("--editor-kb-inset")).toBe("0px");
    expect(root?.className).toContain("editor-touch-docked");
  });
});
