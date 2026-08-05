import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  PEEK_MAX_WIDTH,
  PEEK_MIN_WIDTH,
  SidePeek,
  clampPeekWidth,
  focusablesIn,
  readPeekWidth,
} from "./SidePeek";
import { usePeek } from "../lib/peek";
import {
  api,
  ApiError,
  type BrainObject,
  type History,
  type TypeSummary,
  type Whoami,
} from "../lib/api";

/**
 * What these pin is that the peek is a REAL editor over an untouched caller:
 *
 *  - it renders the same write stack the object page does — title input, block
 *    editor, props — and a viewer gets none of it;
 *  - Escape and click-outside close it, and buffered text is FLUSHED first
 *    (the panel is not allowed to eat the last thing you typed);
 *  - the route underneath never changes, so the table's filters and scroll and
 *    the graph's camera survive;
 *  - focus is trapped while open and restored to whatever opened it;
 *  - the panel is resizable from the keyboard, not only with a pointer.
 */

// TipTap is exercised by BlockEditor's own tests; here it is a plain textarea
// so these assertions are about the PANEL, not about ProseMirror.
vi.mock("./editor/BlockEditor", () => ({
  BlockEditor: ({
    value,
    onChange,
    onBlur,
    ariaLabel,
  }: {
    value: string;
    onChange?: (md: string) => void;
    onBlur?: () => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? "Body"}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      onBlur={onBlur}
    />
  ),
}));

const member: Whoami = {
  id: "acct-1",
  name: "Alice",
  role: "member",
  scopes: ["read", "write"],
  status: "active",
};

const viewer: Whoami = { ...member, id: "acct-2", role: "viewer", scopes: ["read"] };

const object = (over: Partial<BrainObject> = {}): BrainObject => ({
  id: "obj-1",
  type: "deal",
  title: "Acme renewal",
  body: "the body",
  version: 4,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  deleted_at: null,
  visibility: "org",
  props: { stage: "open" },
  links: [],
  backlinks: [],
  links_truncated: false,
  backlinks_truncated: false,
  hidden_from_you: 0,
  ...over,
});

const history: History = { id: "obj-1", versions: [], events: [] };

const dealType: TypeSummary = {
  id: 1,
  name: "deal",
  label: "Deals",
  description: null,
  icon: "",
  deprecated: false,
  count: 1,
  properties: [
    { name: "stage", kind: "enum", required: false, deprecated: false, enum_values: ["open"] },
  ],
};

function stubApi(over: Partial<BrainObject> = {}) {
  const objectSpy = vi.spyOn(api, "object").mockResolvedValue(object(over));
  const historySpy = vi.spyOn(api, "history").mockResolvedValue(history);
  const typesSpy = vi.spyOn(api, "types").mockResolvedValue([dealType]);
  const patchSpy = vi.spyOn(api, "patchObject").mockResolvedValue({ id: "obj-1", version: 5 });
  return { objectSpy, historySpy, typesSpy, patchSpy };
}

/** The caller: a page that opens a peek and reports the URL it is sitting on. */
function Caller({ user }: { user: Whoami }) {
  const { openPeek } = usePeek();
  const loc = useLocation();
  return (
    <>
      <button onClick={() => openPeek("obj-1")}>open row</button>
      <span data-testid="url">{`${loc.pathname}${loc.search}`}</span>
      <SidePeek user={user} />
    </>
  );
}

const mount = (entry: string, user: Whoami = member) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Caller user={user} />
    </MemoryRouter>,
  );

/* --------------------------------------------------------------- pure parts */

describe("clampPeekWidth", () => {
  it("keeps a strip of the caller visible on a narrow viewport", () => {
    expect(clampPeekWidth(900, 700)).toBeLessThan(700);
  });

  it("stays inside the panel's range", () => {
    expect(clampPeekWidth(10, 1600)).toBe(PEEK_MIN_WIDTH);
    expect(clampPeekWidth(5000, 1600)).toBe(PEEK_MAX_WIDTH);
    expect(clampPeekWidth(Number.NaN, 1600)).toBeGreaterThanOrEqual(PEEK_MIN_WIDTH);
  });
});

describe("focusablesIn", () => {
  it("collects tabbable nodes in DOM order and skips tabindex -1", () => {
    const root = document.createElement("div");
    root.innerHTML = `<button>a</button><input /><div tabindex="-1">no</div><a href="/x">b</a>`;
    document.body.appendChild(root);
    expect(focusablesIn(root).map((n) => n.tagName)).toEqual(["BUTTON", "INPUT", "A"]);
    root.remove();
  });
});

/* -------------------------------------------------------------- the panel */

describe("SidePeek", () => {
  it("renders nothing until an object is peeked", () => {
    stubApi();
    mount("/t/deal");
    expect(screen.queryByTestId("side-peek")).toBeNull();
  });

  it("mounts the write stack over an untouched route", async () => {
    stubApi();
    mount("/t/deal?layout=board&peek=obj-1");

    expect(await screen.findByLabelText("Title")).toHaveValue("Acme renewal");
    expect(screen.getByLabelText("Body")).toHaveValue("the body");
    // the caller's own route + params are exactly what they were
    expect(screen.getByTestId("url")).toHaveTextContent("/t/deal?layout=board&peek=obj-1");
    expect(screen.getByRole("dialog", { name: "Object peek" })).toBeInTheDocument();
    expect(screen.getByLabelText("Open full page")).toHaveAttribute("href", "/o/obj-1");
  });

  it("gives a viewer no write affordance", async () => {
    stubApi();
    mount("/t/deal?peek=obj-1", viewer);
    await screen.findByRole("heading", { name: "Acme renewal" });
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.queryByLabelText("Body")).toBeNull();
  });

  it("flushes buffered text before Escape closes it", async () => {
    const { patchSpy } = stubApi();
    mount("/t/deal?peek=obj-1");

    const title = await screen.findByLabelText("Title");
    fireEvent.change(title, { target: { value: "Acme renewal 2027" } });

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Object peek" }), { key: "Escape" });

    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    expect(patchSpy.mock.calls[0]?.[1]).toMatchObject({ title: "Acme renewal 2027" });
    expect(screen.getByTestId("url")).toHaveTextContent("/t/deal");
  });

  it("closes on a click outside", async () => {
    stubApi();
    const { container } = mount("/t/deal?peek=obj-1");
    await screen.findByLabelText("Title");
    const scrim = container.querySelector('[data-testid="side-peek"] > [aria-hidden]');
    fireEvent.mouseDown(scrim!);
    await waitFor(() => expect(screen.getByTestId("url")).toHaveTextContent("/t/deal"));
  });

  it("restores focus to whatever opened it", async () => {
    stubApi();
    mount("/t/deal");
    const row = screen.getByText("open row");
    row.focus();
    fireEvent.click(row);

    const panel = await screen.findByRole("dialog", { name: "Object peek" });
    await waitFor(() => expect(document.activeElement).toBe(panel));

    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("shows how many peeks are stacked behind the top one", async () => {
    stubApi();
    mount("/t/deal?peek=obj-2,obj-1");
    expect(await screen.findByLabelText(/1 behind/)).toBeInTheDocument();
  });

  /**
   * The X is not a second Back button. Opening pushes, so clicking through a few
   * linked graph nodes builds a stack — and an X that popped one revealed the
   * previous object instead of closing, as many times as you had clicked. It
   * looked right only on the first open, where a stack of one makes "pop" and
   * "close" identical (reported 2026-07-26).
   */
  it("the X closes the whole stack, however deep it is", async () => {
    stubApi();
    mount("/t/deal?peek=obj-2,obj-1");
    await screen.findByLabelText("Title");

    fireEvent.click(screen.getByLabelText("Close peek"));

    // EXACT, not toHaveTextContent: that matches substrings, so a URL still
    // carrying `?peek=obj-2` would satisfy "/t/deal" and the assertion would
    // pass against the very behaviour this test exists to forbid.
    await waitFor(() => expect(screen.getByTestId("url").textContent).toBe("/t/deal"));
    // …and it actually leaves the screen. `waitFor`, not a bare assertion: the
    // panel outlives the URL change by its exit transition (PEEK_TRANSITION_MS).
    await waitFor(() => expect(screen.queryByTestId("side-peek")).toBeNull());
  });

  it("…and the back chevron beside it still walks down one at a time", async () => {
    stubApi();
    mount("/t/deal?peek=obj-2,obj-1");
    await screen.findByLabelText("Title");

    fireEvent.click(screen.getByLabelText(/Back to the previous peek/));

    // One layer off, panel still open on what was underneath.
    await waitFor(() => expect(screen.getByTestId("url").textContent).toBe("/t/deal?peek=obj-2"));
    expect(screen.getByRole("dialog", { name: "Object peek" })).toBeInTheDocument();
  });

  it("Escape closes the whole stack too — it is a dismissal, not a step back", async () => {
    stubApi();
    mount("/t/deal?peek=obj-2,obj-1");
    const panel = await screen.findByRole("dialog", { name: "Object peek" });

    fireEvent.keyDown(panel, { key: "Escape" });

    await waitFor(() => expect(screen.getByTestId("url").textContent).toBe("/t/deal"));
  });

  it("resizes from the keyboard and remembers the width", async () => {
    stubApi();
    mount("/t/deal?peek=obj-1");
    const grip = await screen.findByRole("separator", { name: "Resize peek" });
    const before = Number(grip.getAttribute("aria-valuenow"));

    fireEvent.keyDown(grip, { key: "ArrowLeft" });

    const after = Number(
      screen.getByRole("separator", { name: "Resize peek" }).getAttribute("aria-valuenow"),
    );
    expect(after).toBeGreaterThan(before);
    expect(readPeekWidth()).toBe(after);
  });

  it("says so plainly when the object cannot be read (a real 404/403)", async () => {
    vi.spyOn(api, "object").mockRejectedValue(new ApiError(404, "not found"));
    vi.spyOn(api, "history").mockRejectedValue(new ApiError(404, "not found"));
    mount("/t/deal?peek=obj-1");
    expect(await screen.findByText(/permissions don't extend to it/)).toBeInTheDocument();
  });

  it("shows a RETRYABLE error (not the dead-end 'doesn't exist') on a transient load failure", async () => {
    // A 5xx / network drop is NOT a 404: the object is here and visible, so the
    // peek must not claim it "doesn't exist — or your permissions don't extend
    // to it" (false and alarming). It offers a retry instead. The first attempt
    // fails; the retry succeeds and the object renders.
    const { objectSpy } = stubApi();
    // stubApi set a resolved value; make only the FIRST call reject so the retry
    // falls through to the resolved object.
    objectSpy.mockRejectedValueOnce(new ApiError(503, "service unavailable"));

    mount("/t/deal?peek=obj-1");
    const retry = await screen.findByRole("button", { name: /try again/i });
    expect(screen.queryByText(/permissions don't extend to it/)).not.toBeInTheDocument();

    fireEvent.click(retry);
    // The object's editable title input now carries its loaded value.
    expect(await screen.findByDisplayValue("Acme renewal")).toBeInTheDocument();
  });
});
