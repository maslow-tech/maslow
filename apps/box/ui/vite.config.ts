import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { configDefaults } from "vitest/config";

/**
 * One stamp per build, compiled into BOTH the app bundle (`__APP_BUILD_ID__`)
 * and the emitted service worker. The page compares the two to decide whether
 * the JS it is running is what this origin now serves — see src/lib/sw-register.ts.
 * BRAIN_APP_VERSION (set by the release build) keeps it meaningful in a log;
 * otherwise any per-build-unique string does the job.
 */
const BUILD_ID = process.env.BRAIN_APP_VERSION ?? `b${Date.now().toString(36)}`;

/**
 * Emit src/sw.js verbatim (minus the build-id substitution) to /sw.js.
 *
 * Hand-rolled rather than vite-plugin-pwa/workbox, deliberately: workbox's
 * reason to exist is a revisioned PRECACHE, and precaching an app shell is the
 * one thing a self-updating box must never do — every workbox recipe here would
 * be spent switching that off. The worker we need is ~120 lines of network-first
 * with two runtime caches, and it costs no dependency, no generated code we do
 * not read, and no build-time coupling to a plugin's idea of a manifest.
 *
 * It is emitted (not left in public/) so the build id is substituted, and it
 * must land at the SCOPE ROOT: a worker's default scope is its own directory,
 * so /assets/sw.js could never control /.
 */
function serviceWorker(): Plugin {
  const src = path.resolve(import.meta.dirname, "./src/sw.js");
  return {
    name: "brain-service-worker",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: readFileSync(src, "utf8").replaceAll("__APP_BUILD_ID__", BUILD_ID),
      });
    },
  };
}

// The dashboard SPA. In dev, /api proxies to the local seeded box
// (`pnpm --filter @brain/box dev:box`); in prod the box serves the built
// assets itself at / (same origin as /api).
export default defineConfig({
  // Box serves at "/"; the hosted-demo bundle sets VITE_BASE=/demo/ so
  // assets + the router basename resolve under that subpath.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss(), serviceWorker()],
  define: {
    __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    port: 5180,
    proxy: {
      "/api": process.env.BRAIN_DEV_API ?? "http://localhost:8080",
      // The collab room lives on a WEBSOCKET, so it needs its own entry with
      // `ws: true` — without it a dev session shows "reconnecting — kept
      // locally" forever and no server-side flush behaviour is testable.
      "/dash/collab": { target: process.env.BRAIN_DEV_API ?? "http://localhost:8080", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Do NOT hoist a dynamic import's transitive deps into the entry.
        // Rollup's default (true) makes the entry chunk STATICALLY import every
        // transitive dependency of its lazy imports "to preload them" — which
        // would pull the TipTap/ProseMirror stack (a dep of the lazy
        // ObjectView/SidePeek) onto the entry and thus onto an unauthenticated
        // /login (~260 KB gzip the route never uses). With it off, that stack
        // loads only when a lazy editor-bearing view does.
        hoistTransitiveImports: false,
        // Exactly ONE forced vendor chunk: `collab` (Yjs + Hocuspocus + their
        // deps), the presence TRANSPORT the shell's route-presence rail needs
        // EAGERLY on every screen. It rides the entry deliberately (~37 KB gzip);
        // the lightweight collab constants the eager path uses live in
        // lib/collabTransport.ts, a leaf with NO editor import, so pulling this
        // does not drag TipTap along.
        //
        // The editor stack (TipTap/ProseMirror/markdown + the Yjs↔ProseMirror
        // bridge) is deliberately NOT a manualChunk: a NAMED editor chunk gets
        // hoisted onto the entry even with hoistTransitiveImports off, defeating
        // the split. Left to Rollup's automatic dynamic-import splitting it
        // becomes a shared async chunk that ObjectView and SidePeek both import
        // (no duplication) and that loads ONLY with them — off /login and every
        // non-editor route. react-markdown stays out of it too: the plain
        // Markdown renderer is used on eager paths (e.g. the gallery layout).
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](yjs|y-protocols|@hocuspocus|lib0)[\\/]/.test(id)) {
            return "collab";
          }
          return undefined;
        },
      },
    },
  },
  test: {
    // jsdom, not node: the unit tests render React components and read
    // localStorage (draft mirror, saved views). A node environment makes those
    // throw at import time rather than fail usefully.
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // e2e/ belongs to Playwright (playwright.config.ts testDir), and its specs
    // match vitest's default `**/*.spec.ts` glob. Collecting one under vitest
    // fails at import — `@playwright/test` is not a vitest runner — so the two
    // runners are kept to disjoint trees: vitest owns src/, Playwright owns e2e/.
    exclude: [...configDefaults.exclude, "e2e/**"],
    // The gating graph benchmark (src/lib/graph/perf.bench.test.ts) settles a
    // real 5,000-node layout and replays a 10s pan+zoom, which the 5s default
    // kills mid-measurement — and a benchmark that times out is a benchmark
    // nobody keeps. Each benchmark case still declares its own tighter
    // per-test timeout; this is only the floor that lets it get that far.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Timings are only meaningful when the measuring process is not fighting
    // N sibling workers for the same cores. `fileParallelism: false` runs one
    // test FILE at a time, so the benchmark's numbers are the machine's, not
    // the scheduler's. It costs the suite wall-clock time; the alternative is
    // a perf gate that flaps on a loaded runner and gets disabled within a
    // week, which is worse than a slower suite.
    fileParallelism: false,
  },
});
