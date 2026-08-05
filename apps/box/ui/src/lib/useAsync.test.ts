import { describe, expect, it } from "vitest";
import { ApiError, shouldSurface, errorMessage } from "./api";

/**
 * The regression net for the four read-path traps the
 * useAsync hook must respect. These are the PURE decision helpers; the hook
 * wiring (stale-guard, mounted ref) is verified in the browser (the box-ui
 * package has no jsdom/RTL harness by design).
 */
describe("shouldSurface — which rejections become a retryable banner", () => {
  it("NEVER surfaces a 401 (the app flips to Login instead)", () => {
    expect(shouldSurface(new ApiError(401, "unauthorized"))).toBe(false);
  });

  it("does not surface an AbortError (superseded/unmounted fetch)", () => {
    expect(shouldSurface(new DOMException("aborted", "AbortError"))).toBe(false);
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(shouldSurface(e)).toBe(false);
  });

  it("suppresses everything while a version-skew reload is in progress", () => {
    // reloadingNow=true → the page is tearing down; a 500 must not flash a banner.
    expect(shouldSurface(new ApiError(500, "boom"), true)).toBe(false);
  });

  it("surfaces real failures (500, network/generic)", () => {
    expect(shouldSurface(new ApiError(500, "boom"))).toBe(true);
    expect(shouldSurface(new Error("network down"))).toBe(true);
  });
});

describe("errorMessage — the human string", () => {
  it("uses the ApiError's server message", () => {
    expect(errorMessage(new ApiError(500, "database is on fire"))).toBe("database is on fire");
  });

  it("falls back to a connection-and-retry hint for a bare error", () => {
    expect(errorMessage(new Error("TypeError: failed to fetch"))).toMatch(/check your connection/i);
    expect(errorMessage("weird")).toMatch(/check your connection/i);
  });
});
