import { defineConfig } from "vitest/config";

// The box package's own unit tests live in src/ (Node). The dashboard SPA in
// ui/ is a separate workspace member (@brain/box-ui) with its own vite config
// (jsdom + the `@` alias), run by its own `test` script — scope this runner to
// src/ so it never globs into ui/ (where `@/…` aliases wouldn't resolve here).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
