import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

/**
 * The TOTAL, deterministic closure of the CSRF class.
 *
 * The server's csrf gate (dashboard csrfOk) compares the x-csrf-token header to
 * the brain_csrf cookie on every non-GET route EXCEPT /api/login + /api/logout.
 * So the client invariant is: every api.* method that issues a non-GET fetch —
 * except {login, logout} — MUST attach x-csrf-token. This test ENUMERATES
 * Object.keys(api), drives each to fetch, and asserts that invariant, so a NEW
 * owner-write added tomorrow without csrfReq is a new key the loop fails on —
 * the closure a single branding-only test lacks. Runs in `pnpm test:unit`, which
 * is already the release gate + PR gate.
 */

const COOKIE = "tok-csrf-xyz";

// Non-GET routes that legitimately carry NO csrf token (server allowlist).
const NON_CSRF_ALLOWLIST = new Set(["login", "logout"]);

// GET reads (no csrf) + the fs*Url pure URL builders (no fetch). These are
// allowed to NOT reach fetch / to record a GET — they carry no write authority.
const READ_OR_NOFETCH = new Set([
  "branding",
  "whoami",
  "members",
  "stats",
  "types",
  "list",
  "object",
  "history",
  "search",
  "feed",
  "untyped",
  "privateObjects",
  "trash",
  "graphSample",
  "recentObjects",
  "timeline",
  "connectors",
  "tags",
  "ownerRemovals",
  "fsList",
  "fsUsage",
  "fsFileUrl",
  // like fsFileUrl: builds the version-download URL, never fetches
  "fsVersionUrl",
]);

// Generous args to drive each method past its own validation into fetch.
const argMap: Record<string, unknown[]> = {
  // a GET read, but `since` is required — without it the method throws before
  // fetch and the completeness sweep (rightly) flags it as never exercised.
  graphChanged: [{ since: "2026-01-01T00:00:00.000Z" }],
  setBranding: [{ name: "x" }],
  createMember: [{ name: "x", email: "a@b.co", permission: "member" }],
  rotateToken: ["id-1"],
  revokeAccount: ["id-1"],
  createTag: ["c-suite"],
  grantTag: ["c-suite", "id-1"],
  revokeTag: ["c-suite", "id-1"],
  shareObject: ["obj-1", { who: ["c-suite"] }],
  initiateOwnerRemoval: ["id-1"],
  cancelOwnerRemoval: ["rem-1"],
  enableConnector: ["google", {}],
  disableConnector: ["google"],
  rescopeConnector: ["google", "org"],
  saveCustomConnector: [{ slug: "s", name: "n", baseUrl: "https://x.co" }],
  deleteCustomConnector: ["s"],
  connectConnector: ["google"],
  disconnectConnector: ["google"],
  fsMkdir: ["/x"],
  fsRename: ["/a", "/b"],
  fsDelete: ["/x", false],
  fsUpload: ["/x", new File(["y"], "y.txt")],
};

describe("CSRF coverage — every non-GET api method attaches x-csrf-token", () => {
  const realFetch = globalThis.fetch;
  const realDoc = (globalThis as { document?: unknown }).document;
  const realFile = globalThis.File;
  let calls: Array<{ path: string; method: string; headers: Record<string, string> }>;

  beforeEach(() => {
    (globalThis as { document?: unknown }).document = { cookie: `brain_csrf=${COOKIE}` };
    if (!globalThis.File) {
      // minimal File shim for the fsUpload FormData path (node without dom File)
      globalThis.File = class {
        constructor(
          public parts: unknown[],
          public name: string,
        ) {}
      } as unknown as typeof File;
    }
    calls = [];
    globalThis.fetch = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({
        path,
        method: (init?.method ?? "GET").toUpperCase(),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { document?: unknown }).document = realDoc;
    globalThis.File = realFile;
    vi.restoreAllMocks();
  });

  it("drives every method and enforces the csrf invariant + completeness", async () => {
    const reached = new Set<string>();
    for (const [name, fn] of Object.entries(api)) {
      if (typeof fn !== "function") continue;
      const before = calls.length;
      try {
        await (fn as (...a: unknown[]) => unknown)(...(argMap[name] ?? []));
      } catch {
        /* a method may still throw after fetch (or a read with odd args) */
      }
      const mine = calls.slice(before);
      if (mine.length > 0) reached.add(name);
      // (a) THE INVARIANT: every non-GET request this method issued (minus the
      // server allowlist) carries the exact csrf cookie value.
      for (const c of mine) {
        if (c.method === "GET" || NON_CSRF_ALLOWLIST.has(name)) continue;
        expect(
          c.headers["x-csrf-token"],
          `api.${name} issued a ${c.method} to ${c.path} WITHOUT x-csrf-token`,
        ).toBe(COOKIE);
      }
    }

    // (b) COMPLETENESS: every write method reached fetch (a method that silently
    // throws before fetching can't false-green); reads/no-fetch/login/logout are
    // documented exemptions.
    for (const name of Object.keys(api)) {
      if (typeof (api as Record<string, unknown>)[name] !== "function") continue;
      if (READ_OR_NOFETCH.has(name) || NON_CSRF_ALLOWLIST.has(name)) continue;
      expect(reached.has(name), `api.${name} never reached fetch — extend argMap`).toBe(true);
    }
  });
});
