import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConflictBanner, changedProps } from "./ConflictBanner";

/**
 * The banner's whole job is to NOT decide. These tests pin that: it offers two
 * named choices and a diff, calls nothing on its own, and says something
 * different (with no keep/take at all) when the live editor holds the field.
 */
const THEIRS = { title: "Q3 plan", body: "one\ntwo", props: { stage: "won" } };
const MINE = { title: "Q3 plan (draft)", body: "one\nthree", props: { stage: "open" } };

describe("ConflictBanner", () => {
  it("names who won and keeps both choices on offer", () => {
    const keep = vi.fn();
    const take = vi.fn();
    render(
      <ConflictBanner
        variant="conflict"
        actorName="Marcus Webb"
        when={new Date().toISOString()}
        fields={["body"]}
        theirs={THEIRS}
        mine={MINE}
        onKeepMine={keep}
        onTakeTheirs={take}
      />,
    );
    expect(screen.getByText(/Marcus Webb/)).toBeInTheDocument();
    // Nothing is resolved by rendering — the human decides.
    expect(keep).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(keep).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Take theirs" }));
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("hides the diff until asked, then shows title, body and prop changes", () => {
    render(
      <ConflictBanner
        variant="conflict"
        actorName="Marcus Webb"
        theirs={THEIRS}
        mine={MINE}
        onKeepMine={() => undefined}
        onTakeTheirs={() => undefined}
      />,
    );
    expect(screen.queryByText("Body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "view diff" }));
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
    expect(screen.getByText("Properties")).toBeInTheDocument();
    expect(screen.getByText("three")).toBeInTheDocument();
  });

  it("says nothing changed rather than rendering an empty diff", () => {
    render(
      <ConflictBanner
        variant="conflict"
        theirs={THEIRS}
        mine={{ ...THEIRS, props: { ...THEIRS.props } }}
        onKeepMine={() => undefined}
        onTakeTheirs={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "view diff" }));
    expect(screen.getByText("No visible difference.")).toBeInTheDocument();
  });

  it("renders a distinct message for open_in_editor, with no keep/take", () => {
    render(<ConflictBanner variant="locked" reason="open_in_editor" fields={["body"]} />);
    expect(screen.getByText(/open in the live editor/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep mine" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take theirs" })).not.toBeInTheDocument();
  });

  it("offers a stale draft as restore/discard, not as a merge", () => {
    render(
      <ConflictBanner
        variant="recovery"
        when={new Date(Date.now() - 60_000).toISOString()}
        theirs={THEIRS}
        mine={MINE}
        onKeepMine={() => undefined}
        onTakeTheirs={() => undefined}
      />,
    );
    expect(screen.getByText(/unsaved edits/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeInTheDocument();
  });

  // A "your edit did not save" message reaches an assistive-tech user through
  // aria-live. `polite` queues behind ongoing typing feedback and can be missed
  // while the user keeps editing; the lost-work variants must interrupt.
  it("announces the conflict and locked variants assertively (role=alert)", () => {
    const { unmount } = render(
      <ConflictBanner
        variant="conflict"
        actorName="Marcus Webb"
        theirs={THEIRS}
        mine={MINE}
        onKeepMine={() => undefined}
        onTakeTheirs={() => undefined}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    unmount();

    render(<ConflictBanner variant="locked" reason="open_in_editor" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps the passive recovery offer polite (role=status, not alert)", () => {
    render(
      <ConflictBanner
        variant="recovery"
        when={new Date(Date.now() - 60_000).toISOString()}
        theirs={THEIRS}
        mine={MINE}
        onKeepMine={() => undefined}
        onTakeTheirs={() => undefined}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("changedProps", () => {
  it("treats absent and null as the same absence", () => {
    expect(changedProps({ a: null }, {})).toEqual([]);
    expect(changedProps({}, { a: null })).toEqual([]);
  });

  it("reports both sides of every real change, sorted", () => {
    expect(changedProps({ b: 1, a: "x" }, { b: 2, a: "x", c: true })).toEqual([
      { key: "b", from: 1, to: 2 },
      { key: "c", from: null, to: true },
    ]);
  });

  it("compares structured values by content", () => {
    expect(changedProps({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(changedProps({ a: [1] }, { a: [2] })).toHaveLength(1);
  });
});
