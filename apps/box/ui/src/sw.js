/*
 * THE SERVICE WORKER. Page side: src/lib/sw-register.ts. Emitted to /sw.js by
 * the `serviceWorker()` plugin in vite.config.ts, which substitutes BUILD_ID
 * with the same value the app bundle is compiled with (__APP_BUILD_ID__).
 *
 * This file is plain JS on purpose: it is NOT part of the app bundle (a worker
 * has no DOM, no React, and must be byte-stable at a fixed URL so the browser
 * can byte-compare it to detect an update). It is copied, not compiled.
 *
 * THE ONE RULE THIS FILE EXISTS TO OBEY: the box SELF-UPDATES. A service worker
 * that precaches an app shell pins whatever version happened to be live when
 * someone last opened the tab, and the box has no way to reach in and evict it
 * — a stale SW is a customer stuck on an old brain forever, with no support
 * path but "clear site data". So:
 *
 *  - index.html / navigations are NETWORK-FIRST, with `cache: "no-store"` on
 *    the network leg so the HTTP cache cannot serve an old shell either. The
 *    cached copy is a FALLBACK for being offline, never the fast path.
 *  - /assets/* is cache-first, and only because those filenames are CONTENT
 *    HASHED — `index-a1b2c3.js` is immutable by construction, so serving it
 *    from cache can never be stale. A new build means new filenames, which the
 *    freshly-fetched index.html asks for by name.
 *  - /api (and every other server surface) is NEVER cached and never even
 *    intercepted. Brain content does not go in a cache the app cannot reason
 *    about, and a cached API response is a lie about someone else's data.
 *
 * Because of that shape, the SW never has to be "invalidated" — it is already
 * showing whatever the box currently serves. The version banner (see
 * sw-register.ts) is only about the JS ALREADY RUNNING in an open tab.
 */

/* global self, caches, fetch, Request, Response, URL */

const BUILD_ID = "__APP_BUILD_ID__";

/** Shell cache is per-build: a new build gets a new one and drops the old. */
const SHELL_CACHE = `brain-shell-${BUILD_ID}`;
/** Assets are content-hashed, so ONE cache outlives every build. Deliberate:
 *  a tab still running the OLD bundle may lazy-load an old chunk after the box
 *  updated, and by then the box no longer serves that filename. Keeping the old
 *  hashed entries is what stops an update from breaking an open tab. */
const ASSET_CACHE = "brain-assets-v1";
/** Ceiling on the asset cache so many deploys cannot grow it without bound. */
const ASSET_CACHE_MAX = 160;

/** The scope root — the URL every navigation falls back to (SPA shell). */
const SHELL_URL = new URL("./", self.registration.scope).toString();

/**
 * Server surfaces. Nothing here is ever cached or intercepted; the request goes
 * straight to the network exactly as if no worker existed. `/api` is the live
 * brain; the rest are real handlers on the box (see the reserved-prefix list in
 * apps/box/src/box.ts) whose responses are per-request and often per-actor.
 */
const NEVER = [
  "/api",
  "/dash",
  "/mcp",
  "/oauth",
  "/connect",
  "/resolve",
  "/.well-known",
  "/collab",
];
const NEVER_EXACT = new Set(["/healthz", "/boxinfo", "/canary", "/about"]);

function isServerSurface(pathname) {
  if (NEVER_EXACT.has(pathname)) return true;
  return NEVER.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Hashed build output. Vite emits everything under <base>assets/. */
function isHashedAsset(pathname) {
  return pathname.includes("/assets/");
}

/** Small, rarely-changing extras that live beside index.html (icons, fonts). */
function isStaticExtra(pathname) {
  return /\.(png|svg|ico|webmanifest|woff2?|css)$/.test(pathname);
}

self.addEventListener("install", (event) => {
  // Take over as soon as we are installed rather than idling in `waiting`
  // until every old tab closes. Safe here precisely BECAUSE nothing is pinned:
  // an old tab that keeps running gets its old hashed chunks from ASSET_CACHE,
  // and its next navigation gets the new shell off the network.
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        await cache.add(new Request(SHELL_URL, { cache: "reload" }));
      } catch {
        // A cold install with no network still installs — the shell warms on
        // the first successful navigation instead.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("brain-shell-") && n !== SHELL_CACHE)
          .map((n) => caches.delete(n)),
      );
      await trimAssetCache();
      await self.clients.claim();
      // Tell every open tab which build now controls it. A tab whose own build
      // id differs is running stale JS and says so (see sw-register.ts).
      await broadcastBuildId();
    })(),
  );
});

async function trimAssetCache() {
  try {
    const cache = await caches.open(ASSET_CACHE);
    const keys = await cache.keys();
    if (keys.length <= ASSET_CACHE_MAX) return;
    // Cache keys come back in insertion order, so the head is the oldest.
    await Promise.all(keys.slice(0, keys.length - ASSET_CACHE_MAX).map((k) => cache.delete(k)));
  } catch {
    // Trimming is hygiene, never correctness.
  }
}

async function broadcastBuildId() {
  const all = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of all) client.postMessage({ type: "BUILD_ID", buildId: BUILD_ID });
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "BUILD_ID") {
    // Answer the asker directly when we can; fall back to a broadcast.
    if (event.source && typeof event.source.postMessage === "function") {
      event.source.postMessage({ type: "BUILD_ID", buildId: BUILD_ID });
    } else {
      event.waitUntil(broadcastBuildId());
    }
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (isServerSurface(url.pathname)) return;

  if (req.mode === "navigate") {
    event.respondWith(navigate(req));
    return;
  }
  if (isHashedAsset(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (isStaticExtra(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/**
 * Network-first, and the network leg bypasses the HTTP cache. On success the
 * shell is refreshed for the offline case; on failure we serve the last shell
 * we saw, and only if we have never seen one do we render the offline card.
 */
async function navigate(req) {
  try {
    const fresh = await fetch(
      new Request(req.url, { cache: "no-store", credentials: "same-origin" }),
    );
    if (fresh && fresh.ok) {
      const copy = fresh.clone();
      caches
        .open(SHELL_CACHE)
        .then((c) => c.put(SHELL_URL, copy))
        .catch(() => undefined);
    }
    return fresh;
  } catch {
    const cached = (await caches.match(SHELL_URL)) ?? (await caches.match(req));
    if (cached) return cached;
    return offlineCard();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => undefined);
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => undefined);
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  const res = await network;
  return res ?? Response.error();
}

/**
 * Last resort: offline with no cached shell at all (first ever visit made while
 * offline). Says so plainly instead of a blank page, in both skins, and offers
 * the only useful action.
 */
function offlineCard() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Offline</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#18181b;
font:400 14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:22rem;padding:1.5rem;border:1px solid #e4e4e7}
h1{margin:0 0 .5rem;font-size:15px;font-weight:600}
p{margin:0;color:#71717a}
@media (prefers-color-scheme:dark){body{background:#060608;color:#fafafa}
.card{border-color:#27272a}p{color:#a1a1aa}}
</style></head><body><div class="card"><h1>You're offline</h1>
<p>This device has never loaded the dashboard, so there is nothing stored to show.
Reconnect and reload.</p></div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
