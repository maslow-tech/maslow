// Custom connectors — owner-defined HTTP connectors as DATA (0033). An owner
// describes an external API (base URL, how the credential attaches, optional
// path allowlist, instructions); the box exposes one MCP tool `<slug>_fetch`
// to every member once the org credential is stored in connector_config.
//
// Rails on every request (the only job of this file's executor):
//   - base URL is https and host-pinned; a path can never change the host
//   - redirects refused (a redirect could carry the credential off-host)
//   - optional owner path-prefix allowlist, checked after URL normalization
//   - the credential is injected server-side and scrubbed from every error —
//     the calling agent never sees it
//   - responses size-capped, requests time-capped
//
// Deliberate doctrine deviations (product decision, 2026-07-20): no enable-time
// validation (custom connectors have no bespoke validator; call-time teaching
// errors carry the weight), and all HTTP methods are allowed.

import type { Pool } from "pg";
import { logEvt } from "../log.js";
import { samgovFetch } from "./samgov.js";
import { samgovFetchDoc } from "./samgov-doc.js";
import type { GuardedFetch } from "../net/egress-guard.js";

interface CustomConnectorDef {
  readonly slug: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly authKind: "header" | "query" | "none";
  readonly authName: string | null;
  readonly allowedPrefixes: readonly string[];
  readonly instructions: string;
  readonly description: string;
}

interface CustomFetchArgs {
  readonly path?: string;
  readonly method?: string;
  readonly params?: Record<string, string>;
  readonly body?: string;
}

type CustomResult =
  { successful: true; data: unknown } | { successful: false; data: null; error: string };

const ok = (data: unknown): CustomResult => ({ successful: true, data });
const fail = (error: string): CustomResult => ({ successful: false, data: null, error });

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const SLUG_RE = /^[a-z][a-z0-9_]{1,31}$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/**
 * Definition-time validation. NOTE (PR2a): the request-time SSRF boundary now
 * lives in the egress guard (customFetch routes every request through
 * `guardedFetch`, which resolves + CIDR-blocks + IP-pins + refuses redirects).
 * This string check is therefore a UX HINT — it stops an owner from *saving* an
 * obviously-internal host, with a readable message — not the security boundary
 * (the guard is, and it runs even if a public hostname later rebinds to an
 * internal address). Returns a teaching message or null.
 */
export function validateDefinition(def: {
  slug: string;
  baseUrl: string;
  authKind: string;
  authName: string | null;
  reservedSlugs: ReadonlySet<string>;
}): string | null {
  if (!SLUG_RE.test(def.slug)) {
    return "slug must be 2-32 chars: lowercase letters, digits, underscores, starting with a letter";
  }
  if (def.reservedSlugs.has(def.slug)) {
    return `"${def.slug}" is reserved (built-in provider or existing tool name)`;
  }
  let u: URL;
  try {
    u = new URL(def.baseUrl);
  } catch {
    return "base URL is not a valid URL";
  }
  if (u.protocol !== "https:") return "base URL must be https";
  if (u.username || u.password) return "base URL must not embed credentials";
  const host = u.hostname.toLowerCase();
  // The box runs inside the customer's VPC: an agent-driven fetch must never
  // be steerable at loopback, link-local metadata, or bare-IP internal hosts.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":")
  ) {
    return "base URL must be a public https hostname (no IPs, localhost, or internal domains)";
  }
  if (def.authKind !== "none" && !(def.authName ?? "").trim()) {
    return "auth name (header or query parameter name) is required for this auth kind";
  }
  if (def.authKind === "header" && !/^[A-Za-z0-9-]+$/.test(def.authName ?? "")) {
    return "header name may only contain letters, digits, and dashes";
  }
  return null;
}

interface Row {
  slug: string;
  name: string;
  base_url: string;
  auth_kind: "header" | "query" | "none";
  auth_name: string | null;
  allowed_prefixes: string[];
  instructions: string;
  description: string;
}

const fromRow = (r: Row): CustomConnectorDef => ({
  slug: r.slug,
  name: r.name,
  baseUrl: r.base_url,
  authKind: r.auth_kind,
  authName: r.auth_name,
  allowedPrefixes: r.allowed_prefixes,
  instructions: r.instructions,
  description: r.description,
});

const COLS =
  "slug, name, base_url, auth_kind, auth_name, allowed_prefixes, instructions, description";

export class CustomConnectorStore {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<CustomConnectorDef[]> {
    const r = await this.pool.query<Row>(`SELECT ${COLS} FROM custom_connectors ORDER BY slug`);
    return r.rows.map(fromRow);
  }

  async get(slug: string): Promise<CustomConnectorDef | null> {
    const r = await this.pool.query<Row>(`SELECT ${COLS} FROM custom_connectors WHERE slug = $1`, [
      slug,
    ]);
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }

  /** Create or update a definition (owner-gated at the HTTP layer). */
  async upsert(def: CustomConnectorDef, createdBy: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO custom_connectors
         (slug, name, base_url, auth_kind, auth_name, allowed_prefixes,
          instructions, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, base_url = EXCLUDED.base_url,
         auth_kind = EXCLUDED.auth_kind, auth_name = EXCLUDED.auth_name,
         allowed_prefixes = EXCLUDED.allowed_prefixes,
         instructions = EXCLUDED.instructions, description = EXCLUDED.description,
         updated_at = now()`,
      [
        def.slug,
        def.name,
        def.baseUrl,
        def.authKind,
        def.authName,
        [...def.allowedPrefixes],
        def.instructions,
        def.description,
        createdBy,
      ],
    );
  }

  async delete(slug: string): Promise<void> {
    await this.pool.query("DELETE FROM custom_connectors WHERE slug = $1", [slug]);
  }
}

/**
 * One rails-guarded request for a custom connector. `secret` is the decrypted
 * credential value (null for auth "none" or when the org row is missing —
 * the caller decides whether that's a teaching error first).
 *
 * samgov dispatches to its bespoke rails (GET-only path allowlist + the
 * attachment/OCR pipeline) — the one custom connector that is 95% data and
 * 5% code. Everything else takes the generic path.
 */
export async function customFetch(
  def: CustomConnectorDef,
  secret: string | null,
  args: CustomFetchArgs,
  guardedFetch: GuardedFetch,
): Promise<CustomResult> {
  const path = (args.path ?? "").trim();
  // The teaching surface: an empty call returns the owner's instructions.
  if (path === "") {
    return ok({
      connector: def.slug,
      instructions:
        def.instructions ||
        `No instructions were written for this connector. Base URL: ${def.baseUrl}. ` +
          "Pass a `path` (plus optional method/params/body) to call the API.",
    });
  }

  if (def.slug === "samgov") {
    if ((args.method ?? "GET").toUpperCase() !== "GET") {
      return fail("SAM.gov is read-only: only GET is supported.");
    }
    if (secret === null) return fail("The SAM.gov connector has no stored API key.");
    // Search results embed full URLs (`description` → api.sam.gov's
    // noticedesc, `resourceLinks` → sam.gov attachment downloads); accept
    // them verbatim so the agent never has to rebuild a path by hand.
    if (path.startsWith("https://") || path.startsWith("http://")) {
      let u: URL | null = null;
      try {
        u = new URL(path);
      } catch {
        /* fall through — samgovFetchDoc answers with the teaching error */
      }
      if (u?.origin === "https://api.sam.gov") {
        return samgovFetch(secret, u.pathname + u.search, args.params ?? {});
      }
      return samgovFetchDoc(path);
    }
    return samgovFetch(secret, path, args.params ?? {});
  }

  const method = (args.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) {
    return fail(`Method "${args.method}" is not supported (GET/POST/PUT/PATCH/DELETE/HEAD).`);
  }

  const base = new URL(def.baseUrl);
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    return fail(`Path "${path}" is not a valid URL path.`);
  }
  // A sneaky path ("../..", "//evil.com/") must not escape the host — or the
  // owner's allowlist — after normalization.
  if (url.origin !== base.origin) {
    return fail(`Path "${path}" did not resolve to ${base.origin} — the host is pinned.`);
  }
  if (
    def.allowedPrefixes.length > 0 &&
    !def.allowedPrefixes.some((p) => url.pathname.startsWith(p))
  ) {
    return fail(
      `Path "${url.pathname}" is outside this connector's allowed paths: ` +
        `${def.allowedPrefixes.join(", ")}.`,
    );
  }

  for (const [k, v] of Object.entries(args.params ?? {})) {
    if (def.authKind === "query" && k === def.authName) continue; // ours, always
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (def.authKind === "query" && secret !== null && def.authName) {
    url.searchParams.set(def.authName, secret);
  } else if (def.authKind === "header" && secret !== null && def.authName) {
    headers[def.authName] = secret;
  }
  const hasBody = args.body !== undefined && method !== "GET" && method !== "HEAD";
  if (hasBody) headers["Content-Type"] = "application/json";

  const scrub = (s: string): string =>
    secret === null || secret === "" ? s : s.split(secret).join("[redacted]");

  // Route through the SSRF egress guard (PR2a): it resolves + CIDR-blocks the
  // internal ranges, pins the socket to the validated IP (rebinding-proof), and
  // refuses redirects — so a public hostname that later resolves internal, or a
  // redirect toward metadata, can't reach it. Byte/time caps enforced there too.
  let res: { status: number; text: string };
  try {
    res = await guardedFetch(url.toString(), {
      method,
      headers,
      ...(hasBody && args.body !== undefined ? { body: args.body } : {}),
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
  } catch {
    logEvt("connector_error", { provider: def.slug, op: "fetch", error: "network" }, "warn");
    // no error passthrough — a redirect/DNS message could embed the URL (and credential)
    return fail(`${def.name} request failed (timeout, network error, or refused redirect).`);
  }

  const text = res.text;
  if (text.length > MAX_RESPONSE_BYTES) {
    return fail(`Response exceeds the ${MAX_RESPONSE_BYTES} byte cap.`);
  }

  if (res.status < 200 || res.status >= 300) {
    logEvt("connector_error", { provider: def.slug, op: "fetch", error: res.status }, "warn");
    return fail(`${def.name} returned ${res.status}. ${scrub(text).slice(0, 300)}`);
  }
  try {
    return ok(JSON.parse(text));
  } catch {
    // Non-JSON success bodies pass through (size-capped, scrubbed): plenty of
    // legitimate APIs answer text/csv/xml.
    return ok(scrub(text));
  }
}
