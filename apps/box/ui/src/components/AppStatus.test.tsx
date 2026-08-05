import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AppStatus } from "./AppStatus";

/**
 * The offline pill reserves bottom-bar clearance so it floats above the mobile
 * tab bar rather than swallowing taps to it. But that bar only exists inside the
 * authed Shell — the Login screen (App.tsx) mounts AppStatus with NO Shell, so
 * on the login route the clearance would strand the pill ~44px above an empty
 * gap. These tests pin that the extra clearance is applied ONLY when a bar is
 * actually present (`bottomBar`), and only on a phone.
 */

const mobile = { value: true };
const status = { sw: "ready" as const, offline: true };

vi.mock("@/lib/mobile", () => ({ useIsMobile: () => mobile.value }));
vi.mock("@/lib/sw-register", () => ({
  useAppStatus: () => status,
  getServiceWorkerController: () => null,
}));

afterEach(() => {
  cleanup();
  mobile.value = true;
  status.offline = true;
});

function paddingBottom(container: HTMLElement): string {
  const el = container.querySelector<HTMLElement>("[role='status']")!.parentElement!;
  return el.style.paddingBottom;
}

// jsdom folds the constant `0.75rem + 2.75rem` sum to `3.5rem` when it
// serializes the inline style; the barless form keeps its single `0.75rem`.
const BAR = "calc(3.5rem + env(safe-area-inset-bottom))";
const NO_BAR = "calc(0.75rem + env(safe-area-inset-bottom))";

describe("AppStatus bottom-bar clearance", () => {
  it("reserves the tab-bar height on mobile WHEN a bottom bar is present", () => {
    const { container } = render(<AppStatus bottomBar />);
    expect(paddingBottom(container)).toBe(BAR);
  });

  it("does NOT reserve tab-bar height on the barless login mount (default)", () => {
    const { container } = render(<AppStatus />);
    expect(paddingBottom(container)).toBe(NO_BAR);
  });

  it("never reserves tab-bar height on desktop, even with a bar", () => {
    mobile.value = false;
    const { container } = render(<AppStatus bottomBar />);
    expect(paddingBottom(container)).toBe(NO_BAR);
  });

  it("renders nothing when neither offline nor an update is pending", () => {
    status.offline = false;
    const { container } = render(<AppStatus bottomBar />);
    expect(container.querySelector("[role='status']")).toBeNull();
  });
});
