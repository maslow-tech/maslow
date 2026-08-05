import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LINK_DEBOUNCE_MS,
  createLinkSuggest,
  linkSelection,
  readLinkTrigger,
  type LinkHit,
  type LinkSuggestSearch,
} from "./LinkSuggest";

/**
 * The `[[` state machine, with no editor mounted.
 *
 * Everything that can go wrong with this feature is in here: which text opens
 * a popover, which text closes it, that a slow answer to an old query cannot
 * overwrite a newer one, and that choosing a hit yields BOTH the markdown the
 * reader sees and the edge the graph needs. The React shell around it only
 * moves ProseMirror positions about.
 */

const hit = (id: string, title: string, type: string | null = "person"): LinkHit => ({
  id,
  title,
  type,
});

describe("readLinkTrigger", () => {
  it("opens on `[[` and extracts everything typed after it", () => {
    expect(readLinkTrigger("[[")).toEqual({ query: "", start: 0 });
    expect(readLinkTrigger("see [[acme")).toEqual({ query: "acme", start: 4 });
  });

  it("allows single spaces — object titles have them", () => {
    expect(readLinkTrigger("[[acme corp")).toEqual({ query: "acme corp", start: 0 });
  });

  it("cancels on space-space: the writer went back to prose", () => {
    expect(readLinkTrigger("[[acme  and then")).toBeNull();
    expect(readLinkTrigger("[[  ")).toBeNull();
  });

  it("cancels on a closing bracket or a newline", () => {
    expect(readLinkTrigger("[[acme]")).toBeNull();
    expect(readLinkTrigger("[[acme\nnext")).toBeNull();
  });

  it("returns nothing when there is no trigger at all", () => {
    expect(readLinkTrigger("")).toBeNull();
    expect(readLinkTrigger("just prose with a [ bracket")).toBeNull();
  });

  it("tracks the LAST trigger, not the first", () => {
    expect(readLinkTrigger("[[one]] then [[tw")).toEqual({ query: "tw", start: 13 });
  });

  it("gives up once the query is longer than any title", () => {
    expect(readLinkTrigger(`[[${"a".repeat(65)}`)).toBeNull();
  });
});

describe("linkSelection", () => {
  it("produces the markdown link and the edge payload together", () => {
    expect(linkSelection(hit("obj-1", "Acme Corp"))).toEqual({
      text: "Acme Corp",
      href: "/o/obj-1",
      markdown: "[Acme Corp](/o/obj-1)",
      link: { to: "obj-1", rel: "references" },
    });
  });

  it("escapes brackets in a title so the markdown link cannot break", () => {
    expect(linkSelection(hit("obj-2", "Q3 [draft]")).markdown).toBe("[Q3 \\[draft\\]](/o/obj-2)");
  });

  it("never emits an empty link label", () => {
    expect(linkSelection(hit("obj-3", "   ")).text).toBe("Untitled");
    expect(linkSelection({ id: "obj-4", title: null }).markdown).toBe("[Untitled](/o/obj-4)");
  });
});

describe("createLinkSuggest", () => {
  const track = (search: LinkSuggestSearch) => createLinkSuggest({ search, onState: () => {} });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces: typing three characters runs one search", async () => {
    const search = vi.fn<LinkSuggestSearch>(async () => [hit("a", "Acme")]);
    const c = track(search);

    c.update({ query: "a", start: 0 });
    c.update({ query: "ac", start: 0 });
    c.update({ query: "acm", start: 0 });
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toBe("acm");
    expect(c.state.hits).toEqual([hit("a", "Acme")]);
    expect(c.state.loading).toBe(false);
  });

  it("opens with no search for a bare `[[`", async () => {
    const search = vi.fn(async () => []);
    const c = track(search);
    c.update({ query: "", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS * 2);
    expect(search).not.toHaveBeenCalled();
    expect(c.state.open).toBe(true);
    expect(c.state.loading).toBe(false);
  });

  it("aborts the previous request and ignores its answer", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(hits: LinkHit[]) => void> = [];
    const c = track((_q, signal) => {
      signals.push(signal);
      return new Promise<LinkHit[]>((resolve) => resolvers.push(resolve));
    });

    c.update({ query: "ac", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    c.update({ query: "acme", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    // The stale answer lands last and must not repaint the narrowed list.
    resolvers[1]?.([hit("new", "Acme Corp")]);
    resolvers[0]?.([hit("old", "Accounting")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state.hits.map((h) => h.id)).toEqual(["new"]);
  });

  it("does not restart the search when the query has not changed", async () => {
    const search = vi.fn(async () => [hit("a", "Acme")]);
    const c = track(search);
    c.update({ query: "ac", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    // A caret move re-fires the same trigger.
    c.update({ query: "ac", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("closes on a null trigger and forgets its hits", async () => {
    const c = track(async () => [hit("a", "Acme")]);
    c.update({ query: "ac", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    expect(c.state.open).toBe(true);

    c.update(null);
    expect(c.state).toEqual({ open: false, query: "", loading: false, hits: [], active: 0 });
  });

  it("swallows a failed lookup instead of surfacing it", async () => {
    const c = track(async () => {
      throw new Error("offline");
    });
    c.update({ query: "ac", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    expect(c.state).toMatchObject({ open: true, loading: false, hits: [] });
  });

  it("wraps the keyboard highlight in both directions", async () => {
    const c = track(async () => [hit("a", "A"), hit("b", "B"), hit("c", "C")]);
    c.update({ query: "x", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);

    expect(c.move(1)).toBe(true);
    expect(c.state.active).toBe(1);
    c.move(1);
    c.move(1);
    expect(c.state.active).toBe(0);
    c.move(-1);
    expect(c.state.active).toBe(2);
  });

  it("has nothing to move while closed", () => {
    const c = track(async () => []);
    expect(c.move(1)).toBe(false);
  });

  it("choosing yields the markdown insert AND the edge, then closes", async () => {
    const c = track(async () => [hit("a", "Acme"), hit("b", "Beta", "project")]);
    c.update({ query: "a", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);

    c.move(1);
    const selection = c.choose();
    expect(selection).toEqual({
      text: "Beta",
      href: "/o/b",
      markdown: "[Beta](/o/b)",
      link: { to: "b", rel: "references" },
    });
    expect(c.state.open).toBe(false);
  });

  it("can choose an explicit index (mouse click)", async () => {
    const c = track(async () => [hit("a", "Acme"), hit("b", "Beta")]);
    c.update({ query: "a", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    expect(c.choose(0)?.link).toEqual({ to: "a", rel: "references" });
  });

  it("choosing nothing changes nothing — the `[[` stays as typed", async () => {
    const c = track(async () => []);
    // Never opened.
    expect(c.choose()).toBeNull();

    // Opened, but no hits to take.
    c.update({ query: "zzz", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    expect(c.state.hits).toEqual([]);
    expect(c.choose()).toBeNull();

    // Typing on past a double space cancels the trigger; nothing was inserted.
    expect(readLinkTrigger("[[zzz  more prose")).toBeNull();
    c.update(null);
    expect(c.state.open).toBe(false);
  });

  it("caps results at the popover's limit", async () => {
    const many = Array.from({ length: 20 }, (_, i) => hit(`o${i}`, `Object ${i}`));
    const c = track(async () => many);
    c.update({ query: "o", start: 0 });
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS);
    expect(c.state.hits).toHaveLength(8);
  });

  it("destroy cancels a pending search", async () => {
    const search = vi.fn(async () => []);
    const c = track(search);
    c.update({ query: "ac", start: 0 });
    c.destroy();
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS * 2);
    expect(search).not.toHaveBeenCalled();
  });
});
