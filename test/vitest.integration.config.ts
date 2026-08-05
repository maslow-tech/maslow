import { defineConfig } from "vitest/config";

// Integration suites spin a real ephemeral PG17 via testcontainers, so they run
// serially (one container pool) with generous timeouts.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["./src/support/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
