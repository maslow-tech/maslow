// Capture real dashboard-API responses from the running dev box (:8080) into a
// single fixtures file the SPA's demo mode serves with no backend. Run with the
// dev box up and the owner token.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "http://localhost:8080";
const TOKEN = process.env.DEMO_TOKEN;
if (!TOKEN) throw new Error("set DEMO_TOKEN to the dev box's owner token");
// Into THIS checkout's demo folder, wherever the script is run from.
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../apps/box/ui/src/demo/fixtures.json");

async function main() {
  // 1) log in → session cookie
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  if (!login.ok || !cookie) throw new Error(`login failed: ${login.status}`);
  const g = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: { cookie } });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  };

  const fx = {};
  fx.whoami = await g("/api/v1/whoami");
  fx.stats = await g("/api/v1/stats");
  fx.members = await g("/api/v1/members");
  fx.types = await g("/api/v1/types");
  fx.feed = await g("/api/v1/feed?limit=40");
  fx.recentObjects = await g("/api/v1/recent-objects?limit=60");
  fx.graphSample = await g("/api/v1/graph-sample?limit=80");
  fx.timeline = await g("/api/v1/timeline?limit=120");
  fx.untyped = await g("/api/v1/untyped?limit=100");
  fx.private = await g("/api/v1/private?limit=100");
  fx.trash = await g("/api/v1/trash?limit=100");

  // per-type lists (with props for the table view)
  fx.lists = {};
  for (const t of fx.types) {
    fx.lists[t.name] = await g(`/api/v1/list?type=${encodeURIComponent(t.name)}&props=1&limit=200`);
  }

  // every live object in full, so clicking/deep-linking any node works
  fx.objects = {};
  const ids = new Set();
  for (const o of fx.recentObjects) ids.add(o.id);
  for (const t of fx.types) for (const it of fx.lists[t.name].items) ids.add(it.id);
  for (const o of fx.untyped) ids.add(o.id);
  for (const o of fx.private) ids.add(o.id);
  for (const id of ids) {
    try {
      fx.objects[id] = await g(`/api/v1/objects/${id}`);
      fx.objects[id].__history = await g(`/api/v1/objects/${id}/history`);
    } catch {
      /* skip */
    }
  }

  // a few canned searches the tour can run; demo mode also does a client-side
  // title filter for anything else. searchesDeep mirrors the page's deep=1
  // settle pass (semantic + graph + rerank) so provenance badges show in demo.
  fx.searches = {};
  fx.searchesDeep = {};
  // Lumina Coffee queries, chosen to exercise every provenance the page can
  // show: exact text, meaning-only, text+meaning, and graph via-trails.
  for (const q of ["Morning Ember", "Highland", "decaf", "unhappy customer", "private label"]) {
    fx.searches[q.toLowerCase()] = await g(`/api/v1/search?q=${encodeURIComponent(q)}`);
    fx.searchesDeep[q.toLowerCase()] = await g(`/api/v1/search?q=${encodeURIComponent(q)}&deep=1`);
  }

  writeFileSync(OUT, JSON.stringify(fx));
  const kb = (JSON.stringify(fx).length / 1024).toFixed(0);
  console.log(
    `captured: ${fx.types.length} types, ${Object.keys(fx.objects).length} objects, ` +
      `${fx.graphSample.nodes.length} graph nodes → ${OUT} (${kb} KB)`,
  );
}
main().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
