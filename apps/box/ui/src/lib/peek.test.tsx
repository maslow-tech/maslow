import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_PEEK_DEPTH,
  PEEK_PARAM,
  PeekProvider,
  flushAllPeeks,
  flushPeek,
  parsePeekStack,
  popPeek,
  pushPeek,
  registerPeekFlush,
  resetPeekFlushes,
  serializePeekStack,
  usePeek,
  withPeekStack,
} from "./peek";

/**
 * What these pin is the peek CONTRACT, not the panel's pixels:
 *
 *  - the URL is the store: a peek is linkable, survives reload, and never
 *    changes the route underneath it (pathname and every other param survive);
 *  - it is a stack, deduped, and bounded — a hostile `?peek=` cannot mount an
 *    unbounded number of live editors, nor two editors on one object;
 *  - opening pushes a history entry and closing replaces one, so Back from an
 *    open peek lands where it was opened from;
 *  - closing flushes the object's buffered edits BEFORE the URL changes.
 */

afterEach(() => {
  resetPeekFlushes();
});

/* --------------------------------------------------------------- pure parts */

describe("parsePeekStack", () => {
  it("reads an ordered, deduped stack", () => {
    expect(parsePeekStack("?peek=a,b,c")).toEqual(["a", "b", "c"]);
    expect(parsePeekStack("?peek=a,b,a")).toEqual(["a", "b"]);
  });

  it("is empty without the param", () => {
    expect(parsePeekStack("?q=hello")).toEqual([]);
    expect(parsePeekStack("")).toEqual([]);
  });

  it("drops ids that are not id-shaped", () => {
    expect(parsePeekStack("?peek=../etc,ok-1,%20,'x'")).toEqual(["ok-1"]);
  });

  it("caps a hostile URL at MAX_PEEK_DEPTH", () => {
    const many = Array.from({ length: 40 }, (_, i) => `id${i}`).join(",");
    expect(parsePeekStack(`?peek=${many}`)).toHaveLength(MAX_PEEK_DEPTH);
  });
});

describe("pushPeek / popPeek", () => {
  it("moves an id already open to the top instead of duplicating it", () => {
    expect(pushPeek(["a", "b"], "a")).toEqual(["b", "a"]);
  });

  it("refuses a malformed id", () => {
    expect(pushPeek(["a"], "b,c")).toEqual(["a"]);
  });

  it("drops the bottom of the stack at the depth cap", () => {
    const full = Array.from({ length: MAX_PEEK_DEPTH }, (_, i) => `id${i}`);
    const next = pushPeek(full, "new");
    expect(next).toHaveLength(MAX_PEEK_DEPTH);
    expect(next[next.length - 1]).toBe("new");
    expect(next).not.toContain("id0");
  });

  it("pops the top", () => {
    expect(popPeek(["a", "b"])).toEqual(["a"]);
    expect(popPeek([])).toEqual([]);
  });
});

describe("withPeekStack", () => {
  it("leaves every other param alone", () => {
    const params = new URLSearchParams("q=deals&layout=board");
    const next = withPeekStack(params, ["a"]);
    expect(next.get("q")).toBe("deals");
    expect(next.get("layout")).toBe("board");
    expect(next.get(PEEK_PARAM)).toBe("a");
  });

  it("removes the param entirely when the stack empties", () => {
    const next = withPeekStack(new URLSearchParams("peek=a&q=x"), []);
    expect(next.has(PEEK_PARAM)).toBe(false);
    expect(next.get("q")).toBe("x");
  });

  it("serializes a stack top-last", () => {
    expect(serializePeekStack(["a", "b"])).toBe("a,b");
    expect(serializePeekStack([])).toBe("");
  });
});

/* ------------------------------------------------------------- flush hooks */

describe("flush registry", () => {
  it("kicks only the registered object's flush, and unregisters", () => {
    const a = vi.fn();
    const b = vi.fn();
    const off = registerPeekFlush("a", a);
    registerPeekFlush("b", b);

    flushPeek("a");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    off();
    flushPeek("a");
    expect(a).toHaveBeenCalledTimes(1);

    flushAllPeeks();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not let a throwing flush block closing", () => {
    registerPeekFlush("a", () => {
      throw new Error("no network");
    });
    expect(() => flushPeek("a")).not.toThrow();
  });
});

/* -------------------------------------------------------------- the store */

function Probe() {
  const peek = usePeek();
  const loc = useLocation();
  return (
    <div>
      <span data-testid="stack">{peek.stack.join("|")}</span>
      <span data-testid="top">{peek.top ?? ""}</span>
      <span data-testid="depth">{peek.depth}</span>
      <span data-testid="url">{`${loc.pathname}${loc.search}`}</span>
      <button onClick={() => peek.openPeek("obj-1")}>open one</button>
      <button onClick={() => peek.openPeek("obj-2")}>open two</button>
      <button onClick={() => peek.openPeekAll(["obj-3", "obj-4"])}>open all</button>
      <button onClick={() => peek.closePeek()}>close</button>
      <button onClick={() => peek.closeAllPeeks()}>close all</button>
    </div>
  );
}

const mount = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <PeekProvider>
        <Probe />
      </PeekProvider>
    </MemoryRouter>,
  );

const url = () => screen.getByTestId("url").textContent;

describe("usePeek", () => {
  it("opens over the current route without changing it", () => {
    mount("/t/deal?layout=board");
    fireEvent.click(screen.getByText("open one"));
    expect(url()).toBe("/t/deal?layout=board&peek=obj-1");
    expect(screen.getByTestId("top")).toHaveTextContent("obj-1");
  });

  it("reads a stack straight out of the URL, so a peek is linkable", () => {
    mount("/t/deal?peek=obj-1,obj-2");
    expect(screen.getByTestId("stack")).toHaveTextContent("obj-1|obj-2");
    expect(screen.getByTestId("top")).toHaveTextContent("obj-2");
    expect(screen.getByTestId("depth")).toHaveTextContent("2");
  });

  it("stacks, and pops back down one at a time", () => {
    mount("/graph");
    fireEvent.click(screen.getByText("open one"));
    fireEvent.click(screen.getByText("open two"));
    expect(screen.getByTestId("stack")).toHaveTextContent("obj-1|obj-2");

    fireEvent.click(screen.getByText("close"));
    expect(screen.getByTestId("stack")).toHaveTextContent("obj-1");
    fireEvent.click(screen.getByText("close"));
    expect(url()).toBe("/graph");
  });

  it("opens a whole selection at once (phase 6 'open all')", () => {
    mount("/graph");
    fireEvent.click(screen.getByText("open all"));
    expect(screen.getByTestId("stack")).toHaveTextContent("obj-3|obj-4");
  });

  it("closes the whole stack at once", () => {
    mount("/t/deal?peek=obj-1,obj-2&q=x");
    fireEvent.click(screen.getByText("close all"));
    expect(url()).toBe("/t/deal?q=x");
  });

  it("never peeks the object whose page you are already on", () => {
    mount("/o/obj-1");
    fireEvent.click(screen.getByText("open one"));
    expect(screen.getByTestId("stack").textContent).toBe("");
    expect(url()).toBe("/o/obj-1");
  });

  it("flushes the top object before it closes it", () => {
    const order: string[] = [];
    mount("/t/deal?peek=obj-1");
    registerPeekFlush("obj-1", () => {
      order.push("flush");
    });
    fireEvent.click(screen.getByText("close"));
    order.push("closed");
    expect(order).toEqual(["flush", "closed"]);
  });

  it("works without a provider (the URL is the store)", () => {
    render(
      <MemoryRouter initialEntries={["/t/deal?peek=obj-9"]}>
        <Probe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("top")).toHaveTextContent("obj-9");
  });
});
