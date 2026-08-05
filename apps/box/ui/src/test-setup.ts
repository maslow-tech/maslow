// Vitest setup for the dashboard SPA (wired in vite.config.ts as
// `test.setupFiles`). Runs before every test file in the jsdom environment.
//
// Three jobs:
//  1. install the jest-dom matchers (`toBeInTheDocument`, `toHaveTextContent`, …)
//  2. unmount anything React Testing Library rendered, so one test's DOM can
//     never be found by the next one
//  3. hand every test a clean localStorage/sessionStorage — the draft mirror,
//     saved views and the theme/hide-deprecated toggles all persist there, and
//     leaked keys make tests order-dependent.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

function resetStorage(): void {
  localStorage.clear();
  sessionStorage.clear();
}

// jsdom ships matchMedia but not ResizeObserver; the shells and the graph
// canvas measure themselves on mount. Stub only what is missing so a real
// implementation (or a per-test spy) still wins.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
// jsdom has no layout, so it has no `scrollIntoView` — but cmdk (the ⌘K and
// quick-create palettes) calls it on every selection change. Without this any
// test that OPENS a palette dies inside a dependency, which is why the ⌘N gate
// used to be asserted against Shell.tsx's source text instead of by pressing
// the key. A no-op is the honest stub: there is nothing to scroll.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  resetStorage();
});

afterEach(() => {
  cleanup();
  resetStorage();
  vi.restoreAllMocks();
});
