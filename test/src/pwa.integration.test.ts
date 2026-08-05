import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * PHASE 7 ACCEPTANCE — **the box is installable, and its worker can never pin a
 * stale app.**
 *
 * The jsdom suite in `apps/box/ui/src/lib/sw-register.test.ts` covers the PAGE
 * half of the worker (the build-id state machine) against a hand-written
 * container. `box-spa.integration.test.ts` proves the routes for a manifest and
 * an icon exist, using a stand-in three-field manifest it wrote itself. Neither
 * of them ever runs `apps/box/ui/src/sw.js`, and neither of them looks at the
 * manifest and icons WE ACTUALLY SHIP — so "installable" was, until this file,
 * an assertion rather than a fact.
 *
 * This file boots a real box over a ui dir assembled the way vite assembles the
 * build — the REAL `public/` (manifest + icon PNGs), the REAL `index.html`, and
 * the REAL `src/sw.js` with `__APP_BUILD_ID__` substituted, which is precisely
 * what `serviceWorker()` in vite.config.ts emits — and then:
 *
 *   1. asks the box for the manifest and every icon it names, over HTTP;
 *   2. reads the iOS meta tags out of the shell the box serves (iOS ignores the
 *      manifest entirely — those tags ARE the install on a phone);
 *   3. EXECUTES sw.js in a worker-shaped sandbox whose `fetch` is the booted
 *      box, and drives a **version bump underneath it**: the box starts serving
 *      a different build while the worker holds a warm cache of the old one.
 *      The box self-updates and has no way to reach into a browser and evict a
 *      worker, so a worker that answered that navigation from cache would be a
 *      user pinned to an old brain with no support path. That is the case
 *      this file exists to make impossible.
 *
 * The device-side half of phase 7 — drawer, keyboard, slash menu, board swipe,
 * graph pinch, 390px overflow and 44px tap targets — is Playwright on a real
 * iPhone profile: `apps/box/ui/e2e/mobile.spec.ts`.
 */

const UI_ROOT = fileURLToPath(new URL("../../apps/box/ui/", import.meta.url));

/* --------------------------------------------------------- worker sandbox -- */

/** A `Cache`, keyed by URL exactly as the real one is for GET requests. */
class FakeCache {
  readonly entries = new Map<string, Response>();
  private readonly fetcher: (input: unknown) => Promise<Response>;

  constructor(fetcher: (input: unknown) => Promise<Response>) {
    this.fetcher = fetcher;
  }

  static urlOf(input: unknown): string {
    if (typeof input === "string") return input;
    return String((input as { url?: string }).url ?? "");
  }

  async add(input: unknown): Promise<void> {
    const res = await this.fetcher(input);
    if (!res.ok) throw new Error(`cache.add: ${res.status}`);
    this.entries.set(FakeCache.urlOf(input), res);
  }

  async put(input: unknown, res: Response): Promise<void> {
    this.entries.set(FakeCache.urlOf(input), res);
  }

  async match(input: unknown): Promise<Response | undefined> {
    const hit = this.entries.get(FakeCache.urlOf(input));
    return hit ? hit.clone() : undefined;
  }

  async keys(): Promise<string[]> {
    return [...this.entries.keys()];
  }

  async delete(input: unknown): Promise<boolean> {
    return this.entries.delete(FakeCache.urlOf(input));
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  private readonly fetcher: (input: unknown) => Promise<Response>;

  constructor(fetcher: (input: unknown) => Promise<Response>) {
    this.fetcher = fetcher;
  }

  async open(name: string): Promise<FakeCache> {
    const existing = this.caches.get(name);
    if (existing) return existing;
    const made = new FakeCache(this.fetcher);
    this.caches.set(name, made);
    return made;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  async match(input: unknown): Promise<Response | undefined> {
    for (const c of this.caches.values()) {
      const hit = await c.match(input);
      if (hit) return hit;
    }
    return undefined;
  }
}

/** The subset of a request the worker reads. Deliberately a plain object: a
 *  real `Request` cannot be constructed with `mode: "navigate"` (the fetch spec
 *  forbids it), and `mode` is the ONE bit the worker routes on. */
interface ReqShim {
  url: string;
  method: string;
  mode: "navigate" | "no-cors" | "cors";
}

const nav = (url: string): ReqShim => ({ url, method: "GET", mode: "navigate" });
const sub = (url: string): ReqShim => ({ url, method: "GET", mode: "no-cors" });

interface Sandbox {
  /** Dispatch `install` and await its waitUntil. */
  install(): Promise<void>;
  /** Dispatch `activate` and await its waitUntil. */
  activate(): Promise<void>;
  /** Dispatch `fetch`; null means the worker did NOT call respondWith (the
   *  request went to the network untouched, as if no worker existed). */
  handle(req: ReqShim): Promise<Response | null>;
  /** Everything the worker posted to its clients. */
  readonly posted: unknown[];
  readonly storage: FakeCacheStorage;
}

/**
 * Run `apps/box/ui/src/sw.js` — the shipped file, not a copy — with the globals
 * a ServiceWorkerGlobalScope would give it. `origin` is the box's own origin so
 * the worker's same-origin test behaves; `fetchImpl` is where a caller wires in
 * the live box (or an offline failure).
 */
function makeSandbox(opts: {
  buildId: string;
  origin: string;
  fetchImpl: (input: unknown) => Promise<Response>;
  storage?: FakeCacheStorage;
}): Sandbox {
  const source = readFileSync(join(UI_ROOT, "src", "sw.js"), "utf8").replaceAll(
    "__APP_BUILD_ID__",
    opts.buildId,
  );

  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const posted: unknown[] = [];
  const fetcher = (input: unknown): Promise<Response> => opts.fetchImpl(input);
  const storage = opts.storage ?? new FakeCacheStorage(fetcher);

  const client = {
    postMessage: (message: unknown): void => {
      posted.push(message);
    },
  };
  const selfStub = {
    location: { origin: opts.origin },
    registration: { scope: `${opts.origin}/` },
    clients: {
      matchAll: async () => [client],
      claim: async () => undefined,
    },
    skipWaiting: async () => undefined,
    addEventListener: (type: string, fn: (event: unknown) => void): void => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
  };

  // Indirect eval with the worker globals as parameters: the file is plain JS
  // by design (it is copied, not compiled), so this is the same text the
  // browser gets.
  const factory = new Function(
    "self",
    "caches",
    "fetch",
    "Request",
    "Response",
    "URL",
    `"use strict";\n${source}`,
  );
  factory(selfStub, storage, fetcher, Request, Response, URL);

  const lifecycle = async (type: "install" | "activate"): Promise<void> => {
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners.get(type) ?? []) {
      fn({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    }
    await Promise.all(waits);
  };

  return {
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    async handle(req: ReqShim): Promise<Response | null> {
      let answered: Promise<Response> | Response | null = null;
      const waits: Promise<unknown>[] = [];
      for (const fn of listeners.get("fetch") ?? []) {
        fn({
          request: req,
          respondWith: (r: Promise<Response> | Response) => {
            answered = r;
          },
          waitUntil: (p: Promise<unknown>) => waits.push(p),
        });
      }
      await Promise.all(waits);
      if (answered === null) return null;
      return await answered;
    },
    posted,
    storage,
  };
}

/* ------------------------------------------------------------------ suite -- */

describe("the box is installable and its service worker cannot pin a stale app", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: ReturnType<typeof createBox>;
  let uiDir: string;

  const ORIGIN = "http://localhost";
  const get = (path: string) => app.request(`${ORIGIN}${path}`);

  /** Assemble a ui dir the way `vite build` does. */
  const buildUiDir = (marker: string, assetName: string, buildId: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "brain-pwa-ui-"));
    // vite copies public/ to the build ROOT — the real manifest and the real
    // icon PNGs, byte for byte.
    cpSync(join(UI_ROOT, "public"), dir, { recursive: true });
    // The real shell. Only the module script differs in a build (hashed asset
    // instead of /src/main.tsx), so that one tag is rewritten and every meta
    // tag — the whole iOS install surface — is the shipped one.
    const shell = readFileSync(join(UI_ROOT, "index.html"), "utf8").replace(
      '<script type="module" src="/src/main.tsx"></script>',
      `<script type="module" src="/assets/${assetName}"></script><!--${marker}-->`,
    );
    writeFileSync(join(dir, "index.html"), shell);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", assetName), `/* ${marker} */ export const build = 1;`);
    // Exactly what the vite plugin emits: sw.js at the scope root with the
    // build id substituted.
    writeFileSync(
      join(dir, "sw.js"),
      readFileSync(join(UI_ROOT, "src", "sw.js"), "utf8").replaceAll("__APP_BUILD_ID__", buildId),
    );
    return dir;
  };

  beforeAll(async () => {
    uiDir = buildUiDir("BUILD_ONE", "index-aaa111.js", "build-one");
    process.env.BRAIN_UI_DIR = uiDir;

    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({ pool, ownerClient });
  }, 180_000);

  afterAll(async () => {
    delete process.env.BRAIN_UI_DIR;
    await pool?.end();
    await ownerClient?.end();
    await brain?.drop();
    if (uiDir) rmSync(uiDir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------ manifest -- */

  describe("installability", () => {
    it("serves the shipped manifest with the manifest content type, and it parses", async () => {
      const res = await get("/manifest.webmanifest");
      expect(res.status).toBe(200);
      // Chrome refuses a manifest served as text/plain or as JSON with the
      // wrong type; this header IS the install on Android.
      expect(res.headers.get("content-type")).toContain("application/manifest+json");
      // The box may fold the org's name in, so it must never be cached hard.
      expect(res.headers.get("cache-control")).toContain("no-cache");

      const body = (await res.json()) as Record<string, unknown>;
      // The fields a browser requires before it will offer "install".
      expect(typeof body["name"]).toBe("string");
      expect(typeof body["short_name"]).toBe("string");
      expect(body["start_url"]).toBe("/");
      expect(body["scope"]).toBe("/");
      expect(body["display"]).toBe("standalone");
      expect(Array.isArray(body["icons"])).toBe(true);
    });

    it("declares the icon sizes an install prompt requires, including a maskable one", async () => {
      const body = (await (await get("/manifest.webmanifest")).json()) as {
        icons: { src: string; sizes: string; type: string; purpose?: string }[];
      };
      const bySize = new Map(body.icons.map((i) => [i.sizes, i]));
      // 192 and 512 are the pair Chrome checks for; without both there is no
      // install prompt at all.
      expect([...bySize.keys()]).toEqual(expect.arrayContaining(["192x192", "512x512"]));
      for (const icon of body.icons) expect(icon.type).toBe("image/png");
      // Maskable: Android crops to a circle/squircle, and a non-maskable icon
      // gets a white plate around it that looks broken next to native apps.
      const maskable = body.icons.filter((i) => (i.purpose ?? "").includes("maskable"));
      expect(maskable.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    });

    it("every icon the manifest names resolves over HTTP as a real PNG", async () => {
      const body = (await (await get("/manifest.webmanifest")).json()) as {
        icons: { src: string; sizes: string }[];
      };
      expect(body.icons.length).toBeGreaterThan(0);
      for (const icon of body.icons) {
        const res = await get(icon.src);
        expect(res.status, `${icon.src} must resolve`).toBe(200);
        const bytes = new Uint8Array(await res.arrayBuffer());
        // PNG magic — a route that quietly returned index.html would pass a
        // status check and fail an install.
        expect([...bytes.slice(0, 4)], `${icon.src} must be a PNG`).toEqual([137, 80, 78, 71]);
        // The declared pixel size is in the IHDR (bytes 16..24, big-endian).
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const width = view.getUint32(16);
        const height = view.getUint32(20);
        const [declaredW, declaredH] = icon.sizes.split("x").map(Number);
        expect({ width, height }, `${icon.src} must be ${icon.sizes}`).toEqual({
          width: declaredW,
          height: declaredH,
        });
      }
    });

    it("serves the apple-touch-icon the shell links, at 180x180", async () => {
      const shell = await (await get("/")).text();
      const href = /<link rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(shell)?.[1];
      expect(href, "the shell must link an apple-touch-icon").toBeTruthy();
      const res = await get(href!);
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual([137, 80, 78, 71]);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([180, 180]);
    });

    it("the shell carries the iOS meta tags — the manifest does nothing there", async () => {
      const shell = await (await get("/")).text();
      const meta = (name: string): string | undefined =>
        new RegExp(`<meta name="${name}"[^>]*content="([^"]*)"`).exec(shell)?.[1];

      // Add-to-home-screen on iOS reads these and ignores the manifest.
      expect(meta("apple-mobile-web-app-capable")).toBe("yes");
      // The standards-track spelling, for every other browser.
      expect(meta("mobile-web-app-capable")).toBe("yes");
      expect(meta("apple-mobile-web-app-status-bar-style")).toBe("black-translucent");
      expect(meta("apple-mobile-web-app-title")).toBeTruthy();
      expect(shell).toContain('<link rel="manifest" href="/manifest.webmanifest"');

      // `black-translucent` paints under the notch, which is only correct
      // together with viewport-fit=cover — otherwise the chrome overlaps the
      // app's own header on every notched phone.
      const viewport = meta("viewport") ?? "";
      expect(viewport).toContain("width=device-width");
      expect(viewport).toContain("viewport-fit=cover");

      // One theme-color per skin, so the OS chrome follows --ground rather
      // than guessing.
      const themes = [...shell.matchAll(/<meta name="theme-color"[^>]*>/g)].map((m) => m[0]);
      expect(themes.length).toBe(2);
      expect(themes.some((t) => t.includes("prefers-color-scheme: light"))).toBe(true);
      expect(themes.some((t) => t.includes("prefers-color-scheme: dark"))).toBe(true);
    });

    it("serves /sw.js as JavaScript at the scope root, uncacheable and sniff-proof", async () => {
      const res = await get("/sw.js");
      expect(res.status).toBe(200);
      // A worker served as text/html fails registration outright.
      expect(res.headers.get("content-type")).toMatch(/javascript/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      // The box self-updates; a long-lived worker script is how a box loses the
      // ability to replace its own worker.
      expect(res.headers.get("cache-control")).toContain("no-cache");
      const body = await res.text();
      expect(body).toContain("addEventListener");
      // The build id must have been substituted at build time, or every tab
      // would compare against the literal placeholder and never converge.
      expect(body).not.toContain("__APP_BUILD_ID__");
      expect(body).toContain("build-one");
    });

    it("the SPA CSP permits a same-origin worker (no worker-src, default-src 'self')", async () => {
      const csp = (await get("/")).headers.get("content-security-policy") ?? "";
      // worker-src falls back to child-src and then default-src. There is no
      // worker-src directive here, so `default-src 'self'` is what decides —
      // and a stricter default would silently kill registration in the browser
      // while every server-side test stayed green.
      expect(csp).not.toContain("worker-src");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
    });
  });

  /* ------------------------------------------------- the worker's promise -- */

  describe("the service worker over a self-updating box", () => {
    /** Route the worker's fetch at the live box, with an offline switch. */
    const wireFetch = () => {
      const state = { offline: false, app };
      const fetchImpl = async (input: unknown): Promise<Response> => {
        if (state.offline) throw new TypeError("Failed to fetch");
        const url = FakeCache.urlOf(input);
        return await state.app.request(url);
      };
      return { state, fetchImpl };
    };

    it("installs by warming exactly one entry — the shell — and nothing else", async () => {
      const { fetchImpl } = wireFetch();
      const sw = makeSandbox({ buildId: "build-one", origin: ORIGIN, fetchImpl });
      await sw.install();

      const names = await sw.storage.keys();
      expect(names).toEqual(["brain-shell-build-one"]);
      const shell = await sw.storage.open("brain-shell-build-one");
      expect(await shell.keys()).toEqual([`${ORIGIN}/`]);
    });

    it("NEVER answers a navigation from cache after the box updates underneath it", async () => {
      const { state, fetchImpl } = wireFetch();
      const sw = makeSandbox({ buildId: "build-one", origin: ORIGIN, fetchImpl });
      await sw.install();

      // A warm worker on the old build: the shell is cached and being served.
      const first = await sw.handle(nav(`${ORIGIN}/`));
      expect(first).not.toBeNull();
      expect(await first!.text()).toContain("BUILD_ONE");

      // …and now the box self-updates. A new release lands, the updater
      // recreates the app, and the origin starts serving a different shell that
      // asks for a different hashed bundle. Nothing told the worker.
      const nextDir = buildUiDir("BUILD_TWO", "index-bbb222.js", "build-two");
      const previous = process.env.BRAIN_UI_DIR;
      process.env.BRAIN_UI_DIR = nextDir;
      const pool2 = new Pool(brain.appConfig);
      const owner2 = await brain.connect("owner");
      try {
        state.app = createBox({ pool: pool2, ownerClient: owner2 });

        // THE ASSERTION THIS FILE EXISTS FOR. Network-first means the very next
        // navigation is the new shell — a cache-first worker would hand back
        // BUILD_ONE here and pin this device on the old brain forever.
        const after = await sw.handle(nav(`${ORIGIN}/`));
        expect(after).not.toBeNull();
        const html = await after!.text();
        expect(html).toContain("BUILD_TWO");
        expect(html).not.toContain("BUILD_ONE");
        expect(html).toContain("/assets/index-bbb222.js");

        // The refreshed shell replaced the cached one, so even the OFFLINE
        // fallback has moved forward — a device that goes offline after an
        // update does not travel back to the old build.
        state.offline = true;
        const offline = await sw.handle(nav(`${ORIGIN}/`));
        expect(await offline!.text()).toContain("BUILD_TWO");
        state.offline = false;
      } finally {
        await pool2.end();
        await owner2.end();
        if (previous === undefined) delete process.env.BRAIN_UI_DIR;
        else process.env.BRAIN_UI_DIR = previous;
        rmSync(nextDir, { recursive: true, force: true });
      }
    });

    it("serves hashed assets from cache — including one the updated box no longer has", async () => {
      const { state, fetchImpl } = wireFetch();
      const sw = makeSandbox({ buildId: "build-one", origin: ORIGIN, fetchImpl });
      await sw.install();

      const assetUrl = `${ORIGIN}/assets/index-aaa111.js`;
      const cold = await sw.handle(sub(assetUrl));
      expect(cold).not.toBeNull();
      expect(await cold!.text()).toContain("BUILD_ONE");

      // Content-hashed filenames are immutable by construction, so cache-first
      // can never be stale — and keeping them is what stops a mid-session box
      // update from breaking an OPEN tab that lazy-loads an old chunk.
      let served = 0;
      state.app = {
        request: async (_url: string) => {
          served += 1;
          return new Response("gone", { status: 404 });
        },
      } as unknown as typeof app;

      const warm = await sw.handle(sub(assetUrl));
      expect(await warm!.text()).toContain("BUILD_ONE");
      expect(served, "a cached hashed asset must not touch the network").toBe(0);
    });

    it("never intercepts a brain surface — /api, /dash, /mcp go straight to the network", async () => {
      const { fetchImpl } = wireFetch();
      const sw = makeSandbox({ buildId: "build-one", origin: ORIGIN, fetchImpl });
      await sw.install();

      // A cached API response is a lie about someone else's data, and a cached
      // /dash response would be one member's rows answered to another.
      for (const path of [
        "/api/v1/version",
        "/api/v1/objects",
        "/dash/collab",
        "/mcp",
        "/oauth/authorize",
        "/healthz",
        "/boxinfo",
      ]) {
        const answered = await sw.handle(sub(`${ORIGIN}${path}`));
        expect(answered, `${path} must not be intercepted`).toBeNull();
      }
      // Nothing about a brain surface may end up in a cache.
      for (const name of await sw.storage.keys()) {
        const c = await sw.storage.open(name);
        for (const key of await c.keys()) {
          expect(key).not.toContain("/api/");
          expect(key).not.toContain("/dash");
        }
      }
      // A cross-origin request is not ours to answer either.
      expect(await sw.handle(sub("https://example.com/x.js"))).toBeNull();
      // Neither is a write.
      expect(await sw.handle({ ...sub(`${ORIGIN}/`), method: "POST" })).toBeNull();
    });

    it("activating a new build drops the old shell cache and tells every open tab", async () => {
      const { fetchImpl } = wireFetch();
      const storage = new FakeCacheStorage(fetchImpl);
      const one = makeSandbox({ buildId: "build-one", origin: ORIGIN, fetchImpl, storage });
      await one.install();
      expect(await storage.keys()).toContain("brain-shell-build-one");

      // The updated box's worker takes over the SAME CacheStorage the old one
      // left behind — that is the real shape of an update on a device.
      const two = makeSandbox({ buildId: "build-two", origin: ORIGIN, fetchImpl, storage });
      await two.install();
      await two.activate();

      const names = await storage.keys();
      expect(names).toContain("brain-shell-build-two");
      expect(names, "the old build's shell cache must be dropped").not.toContain(
        "brain-shell-build-one",
      );
      // The banner in sw-register.ts is driven by this message, and only this
      // message: a tab running old JS learns it is old because the build ids
      // differ, never from a lifecycle event.
      expect(two.posted).toContainEqual({ type: "BUILD_ID", buildId: "build-two" });
    });

    it("answers a first-ever offline visit with the offline card, not a blank page", async () => {
      const { state, fetchImpl } = wireFetch();
      const sw = makeSandbox({ buildId: "build-one", origin: ORIGIN, fetchImpl });
      // No install, no warm shell: the device has genuinely never loaded it.
      state.offline = true;
      const res = await sw.handle(nav(`${ORIGIN}/`));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      const html = await res!.text();
      expect(html).toContain("offline");
      expect(res!.headers.get("cache-control")).toContain("no-store");
    });
  });
});
