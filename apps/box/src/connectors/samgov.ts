import { logEvt } from "../log.js";

// SAM.gov connector — one deliberately dumb, generic GET. The agent supplies
// a path + query params; the box supplies the API key. All SAM.gov routing
// knowledge (which endpoint answers what, param formats, budget discipline)
// lives in the brain's skill objects, NOT here — so the capability grows by
// editing data, never by shipping code.
//
// Rails (the only job of this file):
//   - host pinned to api.sam.gov, GET only, redirects refused
//   - path must sit under an allowlisted API prefix
//   - the api_key is injected server-side and scrubbed from every error —
//     the calling agent never sees it
//   - responses are size-capped so a huge page can't blow up the box

const SAM_BASE = "https://api.sam.gov";
const ALLOWED_PATH_PREFIXES = [
  "/opportunities/v2/", // Get Opportunities (search)
  "/entity-information/", // entities v3, exclusions v4
];
// Exact endpoints (matched on the FULL resolved pathname, never as a prefix —
// the injected key must not ride to sibling routes like noticedesc-anything).
const ALLOWED_EXACT_PATHS = [
  // A search result's `description` field is a URL to this v1 endpoint (there
  // is no v2 equivalent) — the notice's full description text.
  "/prod/opportunities/v1/noticedesc",
];
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type SamgovResult =
  { successful: true; data: unknown } | { successful: false; data: null; error: string };

const ok = (data: unknown): SamgovResult => ({ successful: true, data });
const fail = (error: string): SamgovResult => ({ successful: false, data: null, error });

/** One allowlisted GET against api.sam.gov with the stored key injected. */
export async function samgovFetch(
  apiKey: string,
  path: string,
  params: Record<string, string>,
): Promise<SamgovResult> {
  const rawAllowed =
    ALLOWED_PATH_PREFIXES.some((p) => path.startsWith(p)) ||
    ALLOWED_EXACT_PATHS.some((p) => path === p || path.startsWith(p + "?"));
  if (!rawAllowed) {
    return fail(
      `Path "${path}" is not an allowed SAM.gov API path. ` +
        `Allowed: ${[...ALLOWED_PATH_PREFIXES, ...ALLOWED_EXACT_PATHS].join(", ")}.`,
    );
  }
  const url = new URL(path, SAM_BASE);
  // A sneaky path ("/opportunities/v2/../../x", "//evil.com/") must not escape
  // the allowlist or the host after normalization.
  if (
    url.origin !== SAM_BASE ||
    !(
      ALLOWED_PATH_PREFIXES.some((p) => url.pathname.startsWith(p)) ||
      ALLOWED_EXACT_PATHS.includes(url.pathname)
    )
  ) {
    return fail(`Path "${path}" did not resolve to an allowed SAM.gov API path.`);
  }
  for (const [k, v] of Object.entries(params)) {
    if (k === "api_key") continue; // ours, always
    url.searchParams.set(k, v);
  }
  url.searchParams.set("api_key", apiKey);

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error" });
  } catch {
    logEvt("connector_error", { provider: "samgov", op: "api", error: "network" }, "warn");
    // no error passthrough — a redirect/DNS failure message could embed the URL (and key)
    return fail("SAM.gov request failed (network error or refused redirect).");
  }

  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_RESPONSE_BYTES) {
    return fail(
      `Response is ${len} bytes — over the ${MAX_RESPONSE_BYTES} byte cap. ` +
        `Narrow the query (smaller limit, tighter filters).`,
    );
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    return fail(
      `Response exceeds the ${MAX_RESPONSE_BYTES} byte cap. ` +
        `Narrow the query (smaller limit, tighter filters).`,
    );
  }

  if (!res.ok) {
    logEvt("connector_error", { provider: "samgov", op: "api", error: res.status }, "warn");
    // status + a scrubbed snippet: SAM.gov error bodies carry useful hints
    // (rate limit exceeded, bad date format) but must never echo the key.
    const snippet = text.split(apiKey).join("[redacted]").slice(0, 300);
    return fail(`SAM.gov returned ${res.status}. ${snippet}`);
  }
  try {
    return ok(JSON.parse(text));
  } catch {
    logEvt("connector_error", { provider: "samgov", op: "api", error: "non_json" }, "warn");
    return fail(`SAM.gov returned ${res.status} with a non-JSON body.`);
  }
}
