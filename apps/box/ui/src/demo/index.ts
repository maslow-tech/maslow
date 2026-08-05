/**
 * Demo mode: serve the real dashboard on canned data, no backend, no login.
 *
 * Built into the SPA when VITE_DEMO=1 (the hosted-demo bundle). api.ts's
 * single req() choke point calls demoResponse() instead of fetch(), returning
 * fixtures captured from a real seeded brain (fixtures.json). The whole UI —
 * library, tables, object pages, graph, search, timeline — runs verbatim.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

// Lazy-loaded so the 169 KB fixture set is code-split into its own chunk and
// only ever fetched in the demo build — the real box dashboard never loads it.
let fxCache: any = null;
async function loadFx(): Promise<any> {
  if (!fxCache) fxCache = (await import("./fixtures.json")).default;
  return fxCache;
}

/** The canned queries with real captured deep-pass results (searchesDeep in
 *  fixtures.json — keep in sync with test/capture-demo-fixtures.mjs). The
 *  search page offers these as suggestions so demo visitors land on queries
 *  that showcase provenance instead of the title-filter fallback. */
export const DEMO_SEARCH_SUGGESTIONS = [
  "morning ember",
  "unhappy customer",
  "decaf",
  "highland",
  "private label",
] as const;

export function isDemo(): boolean {
  return import.meta.env.VITE_DEMO === "1";
}

function qs(path: string): URLSearchParams {
  const i = path.indexOf("?");
  return new URLSearchParams(i >= 0 ? path.slice(i + 1) : "");
}

/** The write bodies the demo answers are JSON strings; a non-JSON body (an
 *  upload's FormData) simply has no fields to read. */
function readJsonBody(init?: RequestInit): Record<string, unknown> | null {
  if (typeof init?.body !== "string") return null;
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Locks the demo visitor set, this page load only — no backend behind them. */
const demoLocks = new Map<
  string,
  { locked_by: string; locked_by_name: string; locked_at: string }
>();
const UNLOCKED_DEMO = { locked_by: null, locked_by_name: null, locked_at: null };

/** Resolve a dashboard API path to its canned response. */
export async function demoResponse<T>(path: string, init?: RequestInit): Promise<T> {
  const fx = await loadFx();
  const method = (init?.method ?? "GET").toUpperCase();
  const p = path.split("?")[0]!;

  // ---- auth (auto-signed-in) ----
  if (p === "/api/login")
    return {
      ok: true,
      role: fx.whoami?.role ?? "owner",
      csrfToken: "demo",
      appVersion: "demo",
    } as T;
  if (p === "/api/logout") return { ok: true } as T;
  if (p === "/api/v1/whoami") return { ...fx.whoami, appVersion: "demo" } as T;
  if (p === "/api/v1/version") return { appVersion: "demo", apiVersion: "v1" } as T;
  // Unbranded, like a box nobody has customized — the demo header says
  // "Company brain" and always has. Explicit because a read must never fall
  // through to the throw below just because its answer is the boring one.
  if (p === "/api/v1/branding") return { name: null, hasFavicon: false } as T;

  // ---- collections ----
  if (p === "/api/v1/members") return fx.members as T;
  if (p === "/api/v1/stats") return fx.stats as T;
  if (p === "/api/v1/types") return fx.types as T;
  if (p === "/api/v1/feed") return fx.feed as T;
  if (p === "/api/v1/recent-objects") return fx.recentObjects as T;
  if (p === "/api/v1/graph-sample") return fx.graphSample as T;
  // The phase-6 whole-brain page, served off the same fixture: the demo brain
  // is 45 objects, so ONE page is the whole visible graph — no cursor, no
  // truncation. `rel` is synthesized because the sample fixture predates it;
  // the shortest-path hop labels read "related" in the demo and nothing else
  // changes.
  if (p === "/api/v1/graph") {
    const sample = fx.graphSample ?? { nodes: [], edges: [] };
    return {
      nodes: sample.nodes ?? [],
      edges: (sample.edges ?? []).map((e: any) => ({ rel: "related", ...e })),
      nextCursor: null,
      watermark: new Date(0).toISOString(),
      truncated: null,
    } as T;
  }
  // The time scrubber's window. The fixture brain is frozen at capture, so
  // "what changed in the last 7 days" is honestly EMPTY — and an empty window
  // is a state the scrubber draws (it dims nothing and says so), where a
  // missing fixture would put an error in its place.
  if (p === "/api/v1/graph/changed") {
    return {
      since: qs(path).get("since") ?? new Date(0).toISOString(),
      watermark: new Date(0).toISOString(),
      ids: [],
      count: 0,
      byKind: {},
      truncated: null,
      feedTruncated: false,
    } as T;
  }
  if (p === "/api/v1/timeline") return fx.timeline as T;
  if (p === "/api/v1/untyped") return fx.untyped as T;
  if (p === "/api/v1/private") return fx.private as T;
  if (p === "/api/v1/trash") return fx.trash as T;
  if (p === "/api/v1/connectors") return (fx.connectors ?? []) as T;

  // Saved views are DELIBERATELY absent, not merely unfixtured: they are the
  // visitor's own chrome, and there is no backend to keep them in — a list here
  // would light up Save/Pin/reorder affordances whose writes evaporate. A 404 is
  // what the store is written for ("an older box with no /api/v1/views, the demo
  // bundle's fixture 404"): the feature parks itself and shows nothing.
  if (p === "/api/v1/views") throw new DemoNotFound();

  // ---- files (the brain filesystem; fixtures keyed by path) ----
  if (p === "/api/v1/files/list") {
    const fsPath = qs(path).get("path") ?? "/";
    const listing = (fx.fs?.[fsPath] ?? { entries: [] }) as { entries: { name: string }[] };
    // The real server resolves the folder's own lock and every row's in the
    // one query that lists the folder (no N+1) — mirror that shape here, or a
    // demo lock would vanish the moment the listing reloaded.
    const lockAt = (fp: string) => demoLocks.get(fp) ?? UNLOCKED_DEMO;
    return {
      lock: lockAt(fsPath),
      entries: listing.entries.map((e) => ({
        ...e,
        lock: lockAt(fsPath === "/" ? `/${e.name}` : `${fsPath}/${e.name}`),
      })),
    } as T;
  }
  // Storage used, summed from the fixture tree itself rather than invented, so
  // the meter agrees with the files the visitor can actually see. The quota is
  // the box default (fs-store.ts DEFAULT_QUOTA_BYTES, 2 GiB).
  if (p === "/api/v1/files/usage") {
    const total = Object.values(fx.fs ?? {}).reduce(
      (sum: number, dir: any) =>
        sum + (dir.entries ?? []).reduce((n: number, e: any) => n + (e.size ?? 0), 0),
      0,
    );
    return { total_bytes: total, quota_bytes: 2 * 1024 * 1024 * 1024 } as T;
  }
  // Version control has no captured fixtures — the demo tree is inert, so
  // history/trash read as "nothing here" rather than as a 404. LOCKS are the
  // exception: the dashboard is their only surface, so the demo keeps them in
  // memory (per page load) and the toggle really flips, instead of clicking
  // into a hardcoded "unlocked" and looking broken.
  if (p === "/api/v1/files/history") return { versions: [] } as T;
  if (p === "/api/v1/files/trash") return { entries: [] } as T;
  if (p === "/api/v1/files/lock" && method === "POST") {
    const lockPath = (readJsonBody(init)?.path ?? "") as string;
    const lock = {
      locked_by: fx.whoami?.id ?? "demo",
      locked_by_name: fx.whoami?.name ?? "You",
      locked_at: new Date().toISOString(),
    };
    demoLocks.set(lockPath, lock);
    return { ok: true, ...lock } as T;
  }
  if (p === "/api/v1/files/unlock" && method === "POST") {
    demoLocks.delete((readJsonBody(init)?.path ?? "") as string);
    return { ok: true, ...UNLOCKED_DEMO } as T;
  }
  if (p === "/api/v1/files/lock")
    return (demoLocks.get(qs(path).get("path") ?? "") ?? UNLOCKED_DEMO) as T;
  if (p.startsWith("/api/v1/files/") && method === "POST") {
    // mkdir/rename/delete/upload are harmless no-ops in the demo
    return { ok: true, removed: 1 } as T;
  }

  // ---- list by type ----
  if (p === "/api/v1/list") {
    const type = qs(path).get("type") ?? "";
    const canned = fx.lists?.[type];
    if (canned) return canned as T;
    return { items: [], nextCursor: null } as T;
  }

  // ---- one object (+ history) ----
  const hist = p.match(/^\/api\/v1\/objects\/([^/]+)\/history$/);
  if (hist)
    return (fx.objects?.[hist[1]!]?.__history ?? { id: hist[1], versions: [], events: [] }) as T;
  const obj = p.match(/^\/api\/v1\/objects\/([^/]+)$/);
  if (obj) {
    const o = fx.objects?.[obj[1]!];
    if (o) return o as T;
    throw new DemoNotFound();
  }

  // ---- search: canned queries, else client-side title filter ----
  if (p === "/api/v1/search") {
    const q = (qs(path).get("q") ?? "").trim().toLowerCase();
    // Two-stage contract: deep=1 serves the captured hybrid results when the
    // fixture has them, else the quick hits stand in (page stays coherent).
    if (qs(path).get("deep") === "1" && fx.searchesDeep?.[q]) return fx.searchesDeep[q] as T;
    if (fx.searches?.[q]) return fx.searches[q] as T;
    const hits = (fx.recentObjects ?? [])
      .filter((o: any) => (o.title ?? "").toLowerCase().includes(q) && q.length > 0)
      .slice(0, 20)
      .map((o: any) => ({
        id: o.id,
        type: o.type ?? null,
        title: o.title,
        snippet: o.snippet ?? "",
        match: "title_fuzzy",
        connections: o.degree ?? 0,
        version: 1,
        updated_at: o.updated_at ?? new Date().toISOString(),
      }));
    return hits as T;
  }

  // ---- admin writes: harmless no-ops in the demo ----
  if (method === "POST" && p.startsWith("/api/v1/admin/")) {
    if (p.endsWith("/rotate")) return { token: "brain_user_demo_read_only_token" } as T;
    return { ok: true } as T;
  }

  // ---- writes with no fixture: harmless no-ops, like the two families above --
  // There is no backend, so a write cannot mean anything either way; answering
  // `{ ok: true }` is what the demo already did (as a bare `{}`) for object
  // edits and connector config, and it keeps a click that was
  // never going to persist from growing an error banner.
  if (method !== "GET") return { ok: true } as T;

  // ---- a READ with no fixture is a BUG in this file, not an empty page ------
  // The old fallthrough returned `{}` for these. `{}` is TRUTHY and passes every
  // null guard a component has, so the component walks into it and reads a
  // nested field off `undefined` — which once threw inside render and blanked
  // the WHOLE demo on every route. Failing puts the caller
  // on the error path it already has for a dead box, and names the gap out loud
  // instead of handing over a shape that only looks like an answer.
  throw new DemoUnhandled(p);
}

/** Thrown for a missing object so api.ts surfaces the same not-found path. */
export class DemoNotFound extends Error {
  readonly status = 404;
  constructor() {
    super("not_found");
  }
}

/** Thrown for a READ this file has no fixture for — see the fallthrough above.
 *  api.ts turns it into a 501 ApiError, so callers take their existing failure
 *  path and the missing endpoint is one console line, not a blank page. */
export class DemoUnhandled extends Error {
  readonly status = 501;
  constructor(readonly path: string) {
    super(`demo: no fixture for ${path}`);
  }
}
