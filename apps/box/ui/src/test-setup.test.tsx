import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

// Smoke test for the test environment itself (jsdom + setupFiles). If this
// file fails, every other UI unit test in the SPA is running on sand.
describe("ui test environment", () => {
  it("runs in a DOM environment", () => {
    expect(typeof document).toBe("object");
    expect(typeof window.localStorage).toBe("object");
  });

  it("has the jest-dom matchers installed", () => {
    render(<p>hello</p>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("renders and drives React components", async () => {
    function Counter() {
      const [n, setN] = useState(0);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          count {n}
        </button>
      );
    }
    render(<Counter />);
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("count 1");
  });

  // The next two prove the setup file wipes storage between tests: the first
  // writes, the second must not see it (vitest runs a file's tests in order).
  it("can write to localStorage", () => {
    localStorage.setItem("brain-test-leak", "1");
    sessionStorage.setItem("brain-test-leak", "1");
    expect(localStorage.getItem("brain-test-leak")).toBe("1");
  });

  it("starts each test with empty storage", () => {
    expect(localStorage.getItem("brain-test-leak")).toBeNull();
    expect(sessionStorage.getItem("brain-test-leak")).toBeNull();
  });

  it("unmounts the previous test's DOM", () => {
    expect(screen.queryByText("hello")).toBeNull();
  });
});
