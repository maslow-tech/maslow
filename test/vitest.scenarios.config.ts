import { defineConfig } from "vitest/config";

// The red-team scenario suite — the required merge gate. A
// scenario regression blocks merge. Cross-package conformance lives here so a
// parallel change can't weaken half an invariant.
export default defineConfig({
  test: {
    include: ["src/**/*.scenario.test.ts"],
    globalSetup: ["./src/support/global-setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
