// Google connector — plain OAuth2 (PKCE) against Google's endpoints plus the
// Gmail v1 actions. No SDK: Google's token endpoints are two form POSTs, and
// gmail.googleapis.com is a JSON REST API — stdlib fetch covers all of it.
//
// Boundary contract (mirrors samgov.ts):
//   - hosts pinned: accounts.google.com / oauth2.googleapis.com for auth,
//     gmail.googleapis.com for actions; GET/POST only, redirects refused
//   - tokens are injected server-side from the vault and scrubbed from every
//     error — the calling agent never sees one
//   - responses are size-capped so a huge mailbox page can't blow up the box
//
// Provider app credentials are INJECTED (GoogleCreds): decrypted from the
// owner-enabled connector_config row. Each org registers its OWN OAuth
// client (Internal for Workspace orgs = no Google review, non-expiring
// tokens). See docs/runbooks/google-oauth.md.
//
// The secretBlob we hand the vault is a versioned envelope holding the raw
// refresh token. Google does not rotate refresh tokens on use, so refresh
// keeps the same blob unless Google someday returns a new one.

import type { ExchangeFn } from "./oauth-flow.js";
import { packEnvelope, unpackEnvelope, type RefreshFn } from "./vault.js";
import { logEvt } from "../log.js";

export const GOOGLE_PROVIDER = "google";

// Max-scope by design (decided 2026-07-09): full Gmail INCLUDING permanent
// delete (the bare mail.google.com URI is the legacy full-mailbox scope —
// gmail.modify would exclude hard delete), settings (filters/vacation; NOT
// settings.sharing — forwarding/delegation is an exfil primitive), full
// Calendar, full Drive. Adding another Google API later = a scope here + an
// allowlist prefix below; users re-consent once via Connect.
export const GOOGLE_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
];

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_CHARS = 50_000;

// The raw-proxy allowlist: path prefix → pinned host. Everything else is
// refused before any network call. (Drive multipart/media upload endpoints
// live under /upload/ and are deliberately NOT allowlisted — metadata-only
// file creation works; binary upload needs its own design.)
const API_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["/gmail/v1/", "https://gmail.googleapis.com"],
  ["/calendar/v3/", "https://www.googleapis.com"],
  ["/drive/v3/", "https://www.googleapis.com"],
];
const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// The versioned refresh-token envelope (packEnvelope/unpackEnvelope) is owned
// by the vault (the blob format is the same for every OAuth connector).

/** The provider app credentials the box injects (config store). */
interface GoogleCreds {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Validate the owner-supplied config fields (catalog keys) into creds;
 *  null when the required pair is missing. */
export function googleCreds(fields: Record<string, string>): GoogleCreds | null {
  const clientId = (fields["clientId"] ?? "").trim();
  const clientSecret = (fields["clientSecret"] ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Prove candidate client creds are REAL before they're stored — a made-up
 * id/secret must not put a dead Connect button on every member's page. Probe
 * the token endpoint with a bogus code and no user interaction: real creds
 * answer invalid_grant (the code is fake, the client is fine); wrong creds
 * answer invalid_client. Network trouble refuses the enable (fail closed).
 */
export async function googleValidateClient(
  creds: GoogleCreds,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let text: string;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "error",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "validation-probe",
        redirect_uri: "http://localhost/unused",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
    });
    text = await res.text();
  } catch {
    logEvt(
      "connector_error",
      { provider: "google", op: "validate_client", error: "network" },
      "warn",
    );
    return {
      ok: false,
      error: "Could not reach Google to verify the OAuth client — try again shortly.",
    };
  }
  if (/invalid_client|unauthorized_client/.test(text)) {
    return {
      ok: false,
      error:
        "Google rejected this OAuth client id/secret — re-copy both from the Cloud console " +
        "(APIs & Services → Credentials).",
    };
  }
  return { ok: true };
}

/** The provider's authorize URL for the connect flow (state + PKCE from
 *  beginOAuth). access_type=offline + prompt=consent force a refresh token on
 *  EVERY connect — without prompt=consent Google omits it on re-consent and
 *  the vault would hold an unrefreshable secret. */
export function googleAuthorizeUrl(
  creds: GoogleCreds,
  args: { state: string; codeChallenge: string; redirectUri: string },
): string {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    response_type: "code",
    redirect_uri: args.redirectUri,
    scope: GOOGLE_SCOPES.join(" "),
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

async function tokenPost(form: Record<string, string>): Promise<TokenResponse | null> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
    });
  } catch {
    logEvt("connector_error", { provider: "google", op: "token_post", error: "network" }, "warn");
    return null;
  }
  if (!res.ok) {
    logEvt("connector_error", { provider: "google", op: "token_post", error: res.status }, "warn");
    return null;
  }
  try {
    return (await res.json()) as TokenResponse;
  } catch {
    logEvt("connector_error", { provider: "google", op: "token_post", error: "non_json" }, "warn");
    return null;
  }
}

/** EXCHANGE_REGISTRY factory: authorization code + bound PKCE verifier →
 *  tokens. Any failure becomes { ok: false } → oauthFlow maps it to a clean
 *  reconnect, never a 500 or a leak. */
export function googleExchange(creds: GoogleCreds): ExchangeFn {
  return async ({ code, codeVerifier, redirectUri }) => {
    const t = await tokenPost({
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    // No refresh token = unrefreshable secret; fail the connect so the user
    // retries (prompt=consent makes this near-impossible, but fail closed).
    if (!t?.access_token || !t.refresh_token) return { ok: false };
    return {
      ok: true,
      accessToken: t.access_token,
      secretBlob: packEnvelope(t.refresh_token),
      ...(t.expires_in ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}),
      scopes: t.scope ? t.scope.split(" ") : [],
    };
  };
}

/** REFRESH_REGISTRY factory: the vault calls the returned hook when the stored
 *  access token is past expiry. A dead/revoked refresh token yields
 *  { ok: false } → typed reauth. */
export function googleRefresh(creds: GoogleCreds): RefreshFn {
  return async (secretBlob) => {
    const env = unpackEnvelope(secretBlob);
    if (!env) return { ok: false };
    const t = await tokenPost({
      grant_type: "refresh_token",
      refresh_token: env.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    if (!t?.access_token) return { ok: false };
    return {
      ok: true,
      accessToken: t.access_token,
      // Google normally keeps the same refresh token; persist a new one if given.
      secretBlob: packEnvelope(t.refresh_token ?? env.refreshToken),
      ...(t.expires_in ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}),
      scopes: t.scope ? t.scope.split(" ") : [],
    };
  };
}

// ------------------------------------------------- the raw allowlisted proxy

export type GmailResult =
  { successful: true; data: unknown } | { successful: false; data: null; error: string };

// Shared GmailResult constructors — also used by microsoft.ts (same result
// shape) so neither file hand-writes the { successful, data, error } literal.
export const ok = (data: unknown): GmailResult => ({ successful: true, data });
export const fail = (error: string): GmailResult => ({ successful: false, data: null, error });

export interface ApiRequest {
  readonly path: string;
  readonly params?: Record<string, string>;
  readonly method?: string;
  readonly body?: unknown;
}

/** One authenticated call against an allowlisted Google API (the samgov
 *  pattern: dumb generic proxy; the routing knowledge lives in the doctrine
 *  and the brain's skill objects). The access token lives only in the
 *  Authorization header — never in a URL, error, or log. */
export async function googleApi(accessToken: string, req: ApiRequest): Promise<GmailResult> {
  const entry = API_PREFIXES.find(([prefix]) => req.path.startsWith(prefix));
  if (!entry) {
    return fail(
      `Path "${req.path}" is not an allowed Google API path. ` +
        `Allowed prefixes: ${API_PREFIXES.map(([p]) => p).join(", ")}.`,
    );
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (!API_METHODS.has(method)) return fail(`Method "${req.method}" is not allowed.`);
  const url = new URL(req.path, entry[1]);
  // A sneaky path ("/gmail/v1/../../x") must not escape the allowlist or the
  // host after normalization.
  if (url.origin !== entry[1] || !url.pathname.startsWith(entry[0])) {
    return fail(`Path "${req.path}" did not resolve to an allowed Google API path.`);
  }
  for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      redirect: "error",
    });
  } catch {
    logEvt("connector_error", { provider: "google", op: "api", error: "network" }, "warn");
    return fail("Google API request failed (network error or refused redirect).");
  }
  // Refuse oversized bodies BEFORE buffering when the server declares a
  // length (file servers do). ponytail: length-less bodies still buffer
  // fully before the cap check — streaming abort only if a real box OOMs.
  if (Number(res.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    return fail(`Response exceeds the ${MAX_RESPONSE_BYTES} byte cap — narrow the query.`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    return fail(`Response exceeds the ${MAX_RESPONSE_BYTES} byte cap — narrow the query.`);
  }
  if (res.status === 401) {
    return fail(
      "Google returned 401 — the connection needs re-authorizing " +
        "(reconnect Google on the dashboard's Connectors page).",
    );
  }
  if (!res.ok) {
    // A provider 4xx/5xx is DATA to the agent ({successful:false}) but a
    // FAILURE to the operator — without this line a Google outage logs as
    // mcp_call ok:true and nothing else.
    logEvt("connector_error", { provider: "google", op: "api", error: res.status }, "warn");
    // Status + a snippet: Google error bodies carry useful hints (bad query,
    // rate limit, missing param). The token is header-only so a body can't
    // contain it.
    return fail(`Google returned ${res.status}. ${buf.toString("utf8").slice(0, 300)}`);
  }
  return decodeContent(res, buf);
}

/** Decode a successful proxy body: JSON when it parses, otherwise file
 *  content (Drive export / alt=media, Graph /content) handed back instead of
 *  dying — reading documents is the whole point of the file scopes. Text vs
 *  binary is decided by content-type first, NUL sniff for vague types.
 *  Shared with microsoft.ts. */
export function decodeContent(res: Response, buf: Buffer): GmailResult {
  if (res.status === 204 || buf.byteLength === 0) return ok({ status: res.status });
  const text = buf.toString("utf8");
  try {
    // Buffer.toString keeps a UTF-8 BOM that Response.text() used to strip —
    // strip it ourselves or BOM'd JSON would take the file-content path.
    return ok(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch {
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const mime = contentType.split(";")[0]!.trim().toLowerCase();
    const texty = /^text\/|[/+](json|xml|csv|javascript)$/.test(mime);
    const binary = /^(image|video|audio|font)\/|\/(pdf|zip|gzip)$/.test(mime);
    // ponytail: vague types (octet-stream, vnd.*) fall back to a NUL sniff;
    // real content detection only if a customer file proves this wrong.
    if (texty || (!binary && !buf.includes(0))) {
      const charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
      try {
        return ok({
          status: res.status,
          contentType,
          text: charset ? new TextDecoder(charset).decode(buf) : text,
        });
      } catch {
        // unknown charset label — fall through to base64, never corrupt
      }
    }
    return ok({
      status: res.status,
      contentType,
      encoding: "base64",
      data: buf.toString("base64"),
    });
  }
}

type MessageMeta = {
  id?: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailPart;
  internalDate?: string;
};
type GmailPart = {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

function headerMap(payload: GmailPart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of payload?.headers ?? []) {
    if (h.name && h.value) out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

/** Search the mailbox (Gmail query syntax) and return id + headers + snippet
 *  per hit — enough to decide what to read_mail in full. */
export async function gmailSearch(
  accessToken: string,
  q: string,
  maxResults: number,
): Promise<GmailResult> {
  const cap = Math.max(1, Math.min(maxResults, 25));
  const list = await googleApi(accessToken, {
    path: "/gmail/v1/users/me/messages",
    params: { q, maxResults: String(cap) },
  });
  if (!list.successful) return list;
  const ids = ((list.data as { messages?: Array<{ id?: string }> }).messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
  const metaQ =
    "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
  const metas = await Promise.all(
    ids.map((id) =>
      googleApi(accessToken, {
        path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${metaQ}`,
      }),
    ),
  );
  const messages = metas.map((r, i) => {
    if (!r.successful) return { id: ids[i], error: r.error };
    const m = r.data as MessageMeta;
    const h = headerMap(m.payload);
    return {
      id: m.id,
      threadId: m.threadId,
      from: h["from"] ?? null,
      to: h["to"] ?? null,
      subject: h["subject"] ?? null,
      date: h["date"] ?? null,
      snippet: m.snippet ?? null,
    };
  });
  return ok({ query: q, count: messages.length, messages });
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

/**
 * HTML → text, in ONE left-to-right scan.
 *
 * A chain of `replace` passes is not a strip: each pass can splice what is left
 * of its neighbours into a NEW tag (`<scr` + `ipt>` after an inner
 * `<script></script>` is removed), so a sender chooses how many passes they
 * survive. The scan drops everything from a `<` to its closing `>` exactly
 * once — `<script>`/`<style>` take their contents with them — and a `<` with no
 * `>` after it is left verbatim because nothing can complete it. The result
 * therefore holds no tag at all, whatever the nesting, and is unchanged if run
 * again — and on a spliced payload it keeps the same text a browser shows,
 * rather than whatever the pass order happened to leave behind.
 */
function stripHtml(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) {
      out += html.slice(lt);
      break;
    }
    const tag = html.slice(lt, gt + 1);
    const raw = tag.endsWith("/>") ? null : /^<\s*(script|style)\b/i.exec(tag);
    out += " ";
    i = gt + 1;
    if (!raw) continue;
    // Raw-text element: its content is CSS/JS, never readable text.
    const close = lower.indexOf(`</${raw[1]!.toLowerCase()}`, i);
    if (close < 0) {
      i = html.length;
      continue;
    }
    const closeEnd = html.indexOf(">", close);
    i = closeEnd < 0 ? html.length : closeEnd + 1;
  }
  return out;
}

/** Depth-first hunt for the best readable body part: text/plain preferred,
 *  text/html (tags stripped) as fallback. */
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  let plain = "";
  let html = "";
  const walk = (p: GmailPart) => {
    const data = p.body?.data;
    if (data && p.mimeType === "text/plain" && !plain) {
      plain = Buffer.from(data, "base64url").toString("utf8");
    } else if (data && p.mimeType === "text/html" && !html) {
      html = Buffer.from(data, "base64url").toString("utf8");
    }
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  if (plain) return plain;
  // ponytail: naive tag strip — enough to read a newsletter; a real HTML-to-text
  // pass only if agents actually complain.
  // Entities decode in ONE pass over the alternation: decoding `&amp;` before
  // `&lt;` means `&amp;lt;` decodes twice and yields a `<` the sender wrote as
  // literal text.
  return stripHtml(html)
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m, e: string) => HTML_ENTITIES[e] ?? m)
    .replace(/\s{3,}/g, "\n")
    .trim();
}

/** Read one message in full: headers + decoded body (text preferred). */
export async function gmailRead(accessToken: string, messageId: string): Promise<GmailResult> {
  const r = await googleApi(accessToken, {
    path: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
    params: { format: "full" },
  });
  if (!r.successful) return r;
  const m = r.data as MessageMeta;
  const h = headerMap(m.payload);
  const body = extractBody(m.payload);
  return ok({
    id: m.id,
    threadId: m.threadId,
    from: h["from"] ?? null,
    to: h["to"] ?? null,
    cc: h["cc"] ?? null,
    subject: h["subject"] ?? null,
    date: h["date"] ?? null,
    snippet: m.snippet ?? null,
    body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…[truncated]` : body,
    truncated: body.length > MAX_BODY_CHARS,
  });
}

interface SendArgs {
  readonly to: string;
  readonly cc?: string;
  readonly subject: string;
  readonly body: string;
}

/** A header value must not smuggle extra headers (CRLF injection). */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 B-encode a header value when it isn't plain ASCII. */
function encodeHeaderWord(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** Build the RFC 822 message gmail.send expects (base64url `raw`). Exported
 *  for tests. */
export function buildRawMessage(args: SendArgs): string {
  const lines = [
    `To: ${headerSafe(args.to)}`,
    ...(args.cc ? [`Cc: ${headerSafe(args.cc)}`] : []),
    `Subject: ${encodeHeaderWord(headerSafe(args.subject))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(args.body, "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** Send a plain-text mail as the connected account. */
export async function gmailSend(accessToken: string, args: SendArgs): Promise<GmailResult> {
  if (!args.to.trim()) return fail("`to` is required.");
  if (!args.subject.trim()) return fail("`subject` is required.");
  const r = await googleApi(accessToken, {
    path: "/gmail/v1/users/me/messages/send",
    method: "POST",
    body: { raw: buildRawMessage(args) },
  });
  if (!r.successful) return r;
  const m = r.data as { id?: string; threadId?: string };
  // No id = no Gmail send receipt (e.g. a 200 HTML outage page took the
  // file-content path) — never report a send we can't prove happened.
  if (!m.id) return fail("Gmail returned no message id — treat this send as NOT confirmed.");
  return ok({ sent: true, id: m.id, threadId: m.threadId ?? null });
}

// ------------------------------------------------------------- the doctrine

/** What the `google` tool returns when called with no (or unrecognized)
 *  arguments: a live usage guide instead of an error. This is the tool's real
 *  documentation — the tools/list description stays one line forever, and an
 *  agent pays for this text only in the session that actually uses Google. */
export function googleDoctrine(status: {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly scopes: readonly string[];
  /** tokens exist but can't be refreshed right now — teach reconnect/retry,
   *  NOT "you never connected". */
  readonly reauth?: boolean;
}): GmailResult {
  if (!status.configured) {
    return ok({
      connected: false,
      teach:
        "The Google connector is not enabled on this box. An owner adds the org's " +
        "OAuth client on the dashboard's Connectors page.",
    });
  }
  if (!status.connected && status.reauth) {
    return ok({
      connected: false,
      teach:
        "Your Google connection exists but needs re-authorizing (or Google's token " +
        "service had a blip). Retry shortly; if it persists, click Connect again on " +
        "the dashboard's Connectors page.",
    });
  }
  if (!status.connected) {
    return ok({
      connected: false,
      teach:
        "You haven't connected a Google account yet. Open the box dashboard → " +
        "Connectors → Google → Connect, approve the consent screen, then call this " +
        "tool again.",
    });
  }
  return ok({
    connected: true,
    scopes: status.scopes,
    teach:
      "You are connected. This one tool is ALL of Google — it is a thin " +
      "authenticated proxy: pass {path, params?, method?, body?} and the box " +
      "injects YOUR OAuth token (you never see it). Allowed paths: /gmail/v1/…, " +
      "/calendar/v3/…, /drive/v3/… (Google's standard REST APIs — anything they " +
      "document works, including hard delete; binary /upload/ endpoints are not " +
      "supported). Responses over 4MB are refused — page and filter. File content " +
      "(Drive export / ?alt=media) comes back as {contentType, text} for text and " +
      "{contentType, encoding:'base64', data} for binary — prefer " +
      "export?mimeType=text/plain for Google Docs.",
    convenience_actions: {
      search_mail:
        '{action:"search_mail", q:"from:someone newer_than:7d", max_results?:1-25} — ' +
        "Gmail query syntax; returns id/from/subject/date/snippet per hit.",
      read_mail:
        '{action:"read_mail", message_id:"<id from search_mail>"} — full headers + ' +
        "the decoded plain-text body (raw Gmail bodies are base64url; this decodes " +
        "them for you).",
      send:
        '{action:"send", to, subject, text, cc?} — sends plain-text mail AS the ' +
        "member. Really sends: confirm recipient + content with the member first.",
    },
    raw_examples: [
      { path: "/gmail/v1/users/me/labels" },
      { path: "/gmail/v1/users/me/messages/MSGID/trash", method: "POST" },
      {
        path: "/calendar/v3/calendars/primary/events",
        params: { timeMin: "2026-07-09T00:00:00Z", singleEvents: "true", maxResults: "20" },
      },
      {
        path: "/calendar/v3/calendars/primary/events",
        method: "POST",
        body: {
          summary: "Sync",
          start: { dateTime: "2026-07-10T15:00:00-04:00" },
          end: { dateTime: "2026-07-10T15:30:00-04:00" },
        },
      },
      { path: "/drive/v3/files", params: { q: "name contains 'proposal'", pageSize: "10" } },
      { path: "/drive/v3/files/FILEID/export", params: { mimeType: "text/plain" } },
    ],
    tip: "Check the brain for a skill object with this org's Google routines before improvising.",
  });
}
