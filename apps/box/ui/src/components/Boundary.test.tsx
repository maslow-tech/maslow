/**
 * The containment guarantee: a component that throws costs its own subtree and
 * nothing else. Without this, one widget reading a field off the wrong shape
 * unmounts the whole application — which is exactly how /demo went white.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Boundary } from "./Boundary";

function Boom(): never {
  throw new Error("boom");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Boundary", () => {
  // React logs every caught render error itself; the test's own console must
  // not fill with it, and the SPY is also how we prove the crash was reported.
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

  it("renders its children when nothing throws", () => {
    render(
      <Boundary>
        <div>alive</div>
      </Boundary>,
    );
    expect(screen.getByText("alive")).toBeInTheDocument();
  });

  it("swallows a throwing child to NOTHING by default, leaving its siblings up", () => {
    quiet();
    render(
      <div>
        <span>sibling</span>
        <Boundary>
          <Boom />
        </Boundary>
      </div>,
    );
    expect(screen.getByText("sibling")).toBeInTheDocument();
  });

  it("shows the fallback where a hole would read as a broken page", () => {
    quiet();
    render(
      <Boundary fallback={<div>this screen stopped</div>}>
        <Boom />
      </Boundary>,
    );
    expect(screen.getByText("this screen stopped")).toBeInTheDocument();
  });

  it("reports the crash, labelled — a contained bug must still be findable", () => {
    const spy = quiet();
    render(
      <Boundary label="HeaderWidget">
        <Boom />
      </Boundary>,
    );
    expect(spy.mock.calls.some((c) => String(c[0]).includes("HeaderWidget"))).toBe(true);
  });
});
