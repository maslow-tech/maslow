import { defineConfig } from "vitest/config";

// Unit suites in this package are pure (no testcontainers, no DB) — they read
// source files off disk or exercise pure modules, so they run in the normal
// `pnpm test:unit` CI job alongside the per-package unit tests.
export default defineConfig({
  test: {
    include: ["src/**/*.unit.test.ts"],
  },
});
