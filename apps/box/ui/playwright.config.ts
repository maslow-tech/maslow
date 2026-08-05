import { defineConfig, devices } from "@playwright/test";

/**
 * Device e2e for the dashboard — the ONLY suite in this repo that runs a real
 * browser. Everything else about the SPA is jsdom (components) or a booted box
 * with a fetch shim (`test/src/*.e2e.test.ts`), and neither can see the things
 * phase 7 is about: a viewport that overflows at 390px, a tap target smaller
 * than a fingertip, a service worker that never registers.
 *
 * It is deliberately NOT part of `pnpm test`. It needs docker (the seeded dev
 * box), a vite BUILD (the worker and the manifest only exist in a build) and
 * downloaded browser binaries, so CI opts in rather than out:
 *
 *   pnpm --filter @brain/box-ui exec playwright install webkit
 *   pnpm --filter @brain/box-ui test:mobile
 *
 * The server it drives is the REAL box serving the REAL build over :8080 —
 * `vite dev` emits no sw.js and no hashed assets, so a PWA assertion there
 * would be testing a different application. Point `BRAIN_E2E_BASE_URL` at an
 * already-running box (or a live one) to skip the webServer entirely.
 */
const baseURL = process.env.BRAIN_E2E_BASE_URL ?? "http://localhost:8080";

export default defineConfig({
  testDir: "./e2e",
  // A phone suite is inherently serial: it drives one seeded brain and writes
  // to it. Parallel workers would fight over the same rows.
  workers: 1,
  fullyParallel: false,
  // A device test that "passes on the third try" is not evidence.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    // Service workers are the subject, not noise to be silenced.
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      /**
       * DESKTOP CHROMIUM — added when the multiplayer, board-drag, side-peek
       * and graph flows needed a real browser and the only real-browser suite
       * in the repo was the phone one. Two of the bugs those flows hid (the
       * graph never starting under the box's CSP; no view ever opening a collab
       * socket) were desktop bugs that a phone-only suite happened to catch
       * sideways, and one of them it could not have caught at all: a second
       * browser CONTEXT is what makes "two people in one document" observable.
       */
      name: "desktop",
      testMatch: /workspace\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "iphone",
      testMatch: /mobile\.spec\.ts/,
      // iPhone 15 where the installed Playwright knows it, iPhone 14 otherwise
      // — the two share a 393x852 viewport, so the assertions hold either way.
      // WebKit, because iOS Safari is the browser this doctrine exists for:
      // it is the one that ignores the manifest, the one whose CSP historically
      // did not accept `'self'` for a same-origin socket, and the one whose
      // keyboard changes the visual viewport instead of the layout viewport.
      use: { ...(devices["iPhone 15"] ?? devices["iPhone 14"]) },
    },
  ],
  ...(process.env.BRAIN_E2E_BASE_URL
    ? {}
    : {
        webServer: {
          // Build the SPA, then serve it from the box itself — same origin for
          // the app, the manifest, the worker and /api, exactly as a customer's
          // box does it.
          command: 'pnpm build && BRAIN_UI_DIR="$PWD/dist" pnpm --filter @brain/box dev:box',
          url: `${baseURL}/healthz`,
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
          stdout: "pipe",
          stderr: "pipe",
        },
      }),
});
