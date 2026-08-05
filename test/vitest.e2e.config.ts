import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// e2e: a real box + a scripted MCP client against ephemeral PG17.
export default defineConfig({
  resolve: {
    // The e2e suites drive the SPA's OWN client modules over the booted box
    // (see workspace.e2e / graph-e2e). Those modules import their siblings
    // through the `@` alias the dashboard's vite config declares, so this
    // config declares the same one — otherwise a client module that happens to
    // sit under a component (the graph's controls, the shadcn primitives)
    // cannot be resolved and the import fails.
    alias: { "@": fileURLToPath(new URL("../apps/box/ui/src", import.meta.url)) },
  },
  test: {
    // Both spellings: `<name>.e2e.test.ts` and `<name>-e2e.test.ts`.
    include: ["src/**/*.e2e.test.ts", "src/**/*-e2e.test.ts"],
    globalSetup: ["./src/support/global-setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
