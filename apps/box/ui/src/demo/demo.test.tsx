/**
 * The demo bundle's contract with the components that run on it.
 *
 * hosted-demo once rendered a BLANK PAGE on every route: a component's
 * endpoint had no branch in `demoResponse`, the fallthrough answered `{}`, and
 * `{}` is TRUTHY — so the component's `state === null` guard passed and a
 * nested field read threw inside render with nothing above it to catch. Every
 * check in CI was green; nobody had loaded the build.
 *
 * So the tests here are deliberately NOT assertions about a JSON blob. They
 * pin the rules that keep the next one from shipping: a read with no fixture
 * FAILS rather than lying, and every first-paint read is answered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoResponse, DemoNotFound, DemoUnhandled } from "./index";
import { api, ApiError } from "../lib/api";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("demo fallthrough", () => {
  it("REFUSES a read it has no fixture for instead of answering {}", async () => {
    await expect(demoResponse("/api/v1/not/a/real/endpoint")).rejects.toBeInstanceOf(DemoUnhandled);
  });

  it("names the endpoint it is missing, as a 501", async () => {
    const err = await demoResponse("/api/v1/unfixtured").catch((e: unknown) => e);
    expect((err as DemoUnhandled).status).toBe(501);
    expect((err as DemoUnhandled).message).toContain("/api/v1/unfixtured");
  });

  it("reaches the caller as an ordinary ApiError through api.ts's choke point", async () => {
    vi.stubEnv("VITE_DEMO", "1");
    // A read the demo refuses on purpose (below) — same choke point, same
    // translation: components see the failure they already handle, not a shape.
    await expect(api.views()).rejects.toBeInstanceOf(ApiError);
  });

  it("keeps WRITES the harmless no-ops the demo has always answered", async () => {
    // No backend can persist them, and a click that was never going to stick
    // must not grow an error banner over a page nobody can act on anyway.
    await expect(
      demoResponse<{ ok: boolean }>("/api/v1/connectors/google/config", { method: "PUT" }),
    ).resolves.toEqual({ ok: true });
  });

  it("serves every read the signed-in surfaces make on first paint", async () => {
    // The endpoints the shell, Home and the nav views ask for before a visitor
    // touches anything. Each must answer or 404 — never fall through.
    const firstPaint = [
      "/api/v1/whoami",
      "/api/v1/branding",
      "/api/v1/stats",
      "/api/v1/types",
      "/api/v1/feed",
      "/api/v1/recent-objects",
      "/api/v1/connectors",
      "/api/v1/files/list?path=/",
      "/api/v1/files/usage",
      "/api/v1/graph-sample",
      "/api/v1/graph",
      "/api/v1/timeline",
    ];
    for (const path of firstPaint) {
      await expect(demoResponse(path), path).resolves.toBeTruthy();
    }
    // Saved views are the deliberate exception: a 404 parks the feature, which
    // is what the store is written for (see loadSavedViews).
    await expect(demoResponse("/api/v1/views")).rejects.toBeInstanceOf(DemoNotFound);
  });
});
