// Microsoft 365 connector — plain OAuth2 (PKCE) against the customer's Entra
// tenant plus one raw allowlisted Microsoft Graph proxy. No MSAL: the v2
// endpoints are two form POSTs and Graph is a JSON REST API, exactly like
// google.ts (the file this mirrors).
//
// Boundary contract:
//   - hosts pinned: login.microsoftonline.com for auth, graph.microsoft.com
//     for actions; redirects refused — except Graph's own 302 to a pre-signed
//     file-download URL, followed once with the bearer token STRIPPED
//   - tokens are injected server-side from the vault and scrubbed from every
//     error — the calling agent never sees one
//   - responses are size-capped so a huge drive listing can't blow up the box
//
// Provider app credentials are INJECTED (MicrosoftCreds): decrypted from the
// owner-enabled connector_config row. Each org registers its OWN
// single-tenant app in ITS Entra tenant (no Microsoft review, ever). See
// docs/runbooks/microsoft-entra.md.
//
// Unlike Google, Microsoft ROTATES refresh tokens on every refresh — the new
// one MUST be persisted (the vault re-encrypts the returned secretBlob), and
// each use extends the 90-day sliding window, so an active member never
// re-signs in.

import type { ExchangeFn } from "./oauth-flow.js";
import { packEnvelope, unpackEnvelope, type RefreshFn } from "./vault.js";
import { ok, fail, decodeContent, type GmailResult, type ApiRequest } from "./google.js";
import { logEvt } from "../log.js";

export const MICROSOFT_PROVIDER = "msgraph";

// Max delegated scope by design (decided 2026-07-09), covering Outlook mail +
// calendar + contacts, OneDrive/Word/Excel/PowerPoint (Office files ARE Drive
// items in Graph), SharePoint, and Teams (chats, channels, meetings).
// offline_access is what makes Microsoft return a refresh token at all.
// ChannelMessage.* need a one-time admin consent in the org's tenant — the
// runbook's registration grants it while creating the app.
export const MICROSOFT_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/MailboxSettings.ReadWrite",
  "https://graph.microsoft.com/Calendars.ReadWrite",
  "https://graph.microsoft.com/Contacts.ReadWrite",
  "https://graph.microsoft.com/Files.ReadWrite.All",
  "https://graph.microsoft.com/Sites.ReadWrite.All",
  "https://graph.microsoft.com/Chat.ReadWrite",
  "https://graph.microsoft.com/ChannelMessage.Read.All",
  "https://graph.microsoft.com/ChannelMessage.Send",
  "https://graph.microsoft.com/Team.ReadBasic.All",
  "https://graph.microsoft.com/Channel.ReadBasic.All",
  "https://graph.microsoft.com/OnlineMeetings.ReadWrite",
];

// Refresh asks for everything already consented on Graph (the ".default"
// idiom) — the scope set is chosen at the INITIAL exchange; refresh never
// widens it.
const REFRESH_SCOPE = "https://graph.microsoft.com/.default offline_access";

const GRAPH_BASE = "https://graph.microsoft.com";
// Graph v1.0 only (/beta churns). File-content DOWNLOADS (…:/content GETs)
// answer with a 302 to a pre-signed URL — followed once, token stripped;
// small text UPLOADS work (string body → sent raw). Binary UPLOAD is out of
// scope.
const GRAPH_PREFIX = "/v1.0/";
const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// The versioned refresh-token envelope (packEnvelope/unpackEnvelope) is owned
// by the vault (the blob format is the same for every OAuth connector).

/** The provider app credentials the box injects (config store). */
interface MicrosoftCreds {
  readonly clientId: string;
  readonly clientSecret: string;
  /** the org's Entra tenant (single-tenant app per the runbook). */
  readonly tenantId: string;
}

/** Validate the owner-supplied config fields (catalog keys) into creds;
 *  null when a required field is missing. */
export function microsoftCreds(fields: Record<string, string>): MicrosoftCreds | null {
  const clientId = (fields["clientId"] ?? "").trim();
  const clientSecret = (fields["clientSecret"] ?? "").trim();
  const tenantId = (fields["tenantId"] ?? "").trim();
  if (!clientId || !clientSecret || !tenantId) return null;
  return { clientId, clientSecret, tenantId };
}

function authority(creds: MicrosoftCreds): string {
  // tenant id chars only — this string lands inside a URL we fetch.
  const tenant = creds.tenantId.replace(/[^a-zA-Z0-9.-]/g, "");
  return `https://login.microsoftonline.com/${tenant || "organizations"}`;
}

/** The provider's authorize URL for the connect flow (state + PKCE from
 *  beginOAuth). */
export function microsoftAuthorizeUrl(
  creds: MicrosoftCreds,
  args: { state: string; codeChallenge: string; redirectUri: string },
): string {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    response_type: "code",
    redirect_uri: args.redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${authority(creds)}/oauth2/v2.0/authorize?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

async function tokenPost(
  creds: MicrosoftCreds,
  form: Record<string, string>,
): Promise<TokenResponse | null> {
  let res: Response;
  try {
    res = await fetch(`${authority(creds)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
    });
  } catch {
    logEvt("connector_error", { provider: "msgraph", op: "token_post", error: "network" }, "warn");
    return null;
  }
  if (!res.ok) {
    logEvt("connector_error", { provider: "msgraph", op: "token_post", error: res.status }, "warn");
    return null;
  }
  try {
    return (await res.json()) as TokenResponse;
  } catch {
    logEvt("connector_error", { provider: "msgraph", op: "token_post", error: "non_json" }, "warn");
    return null;
  }
}

/** EXCHANGE_REGISTRY factory: authorization code + bound PKCE verifier →
 *  tokens. Any failure becomes { ok: false } → oauthFlow maps it to a clean
 *  reconnect, never a 500 or a leak. */
export function microsoftExchange(creds: MicrosoftCreds): ExchangeFn {
  return async ({ code, codeVerifier, redirectUri }) => {
    const t = await tokenPost(creds, {
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      scope: MICROSOFT_SCOPES.join(" "),
    });
    // offline_access makes a refresh token mandatory; its absence means the
    // consent went wrong — fail the connect so the user retries.
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

/** REFRESH_REGISTRY factory. Microsoft rotates the refresh token — always
 *  persist the returned one. A dead/revoked token yields { ok: false } →
 *  typed reauth. */
export function microsoftRefresh(creds: MicrosoftCreds): RefreshFn {
  return async (secretBlob) => {
    const env = unpackEnvelope(secretBlob);
    if (!env) return { ok: false };
    const t = await tokenPost(creds, {
      grant_type: "refresh_token",
      refresh_token: env.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: REFRESH_SCOPE,
    });
    if (!t?.access_token) return { ok: false };
    return {
      ok: true,
      accessToken: t.access_token,
      secretBlob: packEnvelope(t.refresh_token ?? env.refreshToken),
      ...(t.expires_in ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}),
      scopes: t.scope ? t.scope.split(" ") : [],
    };
  };
}

/**
 * The enable-time credential check (anti-smurf gate, mirrors
 * googleValidateClient): probe the tenant's token endpoint with a bogus code —
 * real creds answer invalid_grant (the code is fake, the client is fine);
 * wrong creds answer invalid_client / unauthorized_client; a wrong tenant id
 * answers with an AADSTS tenant error. Network trouble refuses the enable
 * (fail closed).
 */
export async function microsoftValidateClient(
  creds: MicrosoftCreds,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let text: string;
  try {
    const res = await fetch(`${authority(creds)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "error",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "validation-probe",
        redirect_uri: "http://localhost/unused",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    });
    text = await res.text();
  } catch {
    logEvt(
      "connector_error",
      { provider: "msgraph", op: "validate_client", error: "network" },
      "warn",
    );
    return {
      ok: false,
      error: "Could not reach Microsoft to verify the app registration — try again shortly.",
    };
  }
  if (/AADSTS90002|invalid_tenant/.test(text)) {
    return {
      ok: false,
      error:
        "Microsoft does not recognize this tenant ID — re-copy the Directory (tenant) ID " +
        "from the Entra app registration's Overview page.",
    };
  }
  if (/invalid_client|unauthorized_client|AADSTS700016|AADSTS7000215/.test(text)) {
    return {
      ok: false,
      error:
        "Microsoft rejected this application ID / client secret — re-copy both from the " +
        "Entra app registration (a secret's VALUE, not its ID, and secrets expire).",
    };
  }
  // FAIL CLOSED: ok only on the probe's expected outcome (the fake code is
  // rejected but the client authenticated). Anything else — a 5xx/HTML outage
  // page, an unlisted AADSTS error — must not store unproven creds.
  if (/invalid_grant|invalid_request|AADSTS70000|AADSTS9002313/.test(text)) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      "Microsoft returned an unexpected response while verifying the app registration — " +
      "double-check all three values and try again shortly.",
  };
}

// ------------------------------------------------- the raw allowlisted proxy

/** One authenticated call against Microsoft Graph v1.0 (the samgov pattern:
 *  dumb generic proxy; the routing knowledge lives in the doctrine and the
 *  brain's skill objects). The access token lives only in the Authorization
 *  header — never in a URL, error, or log. */
export async function microsoftApi(accessToken: string, req: ApiRequest): Promise<GmailResult> {
  if (!req.path.startsWith(GRAPH_PREFIX)) {
    return fail(
      `Path "${req.path}" is not an allowed Microsoft Graph path — use ${GRAPH_PREFIX}….`,
    );
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (!API_METHODS.has(method)) {
    return fail(`Method "${req.method}" is not allowed.`);
  }
  const url = new URL(req.path, GRAPH_BASE);
  // A sneaky path ("/v1.0/../admin") must not escape the allowlist or the
  // host after normalization.
  if (url.origin !== GRAPH_BASE || !url.pathname.startsWith(GRAPH_PREFIX)) {
    return fail(`Path "${req.path}" did not resolve to an allowed Microsoft Graph path.`);
  }
  for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);

  // A string body is sent raw (text file uploads via PUT …:/content); an
  // object body is JSON. Binary uploads are not supported.
  const rawBody = typeof req.body === "string";
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(req.body !== undefined
          ? { "content-type": rawBody ? "text/plain" : "application/json" }
          : {}),
      },
      ...(req.body !== undefined
        ? { body: rawBody ? (req.body as string) : JSON.stringify(req.body) }
        : {}),
      // Manual so a Graph 302 (file /content downloads answer with a redirect
      // to a pre-authed URL) is handled below instead of auto-followed with
      // the bearer token attached.
      redirect: "manual",
    });
  } catch {
    logEvt("connector_error", { provider: "msgraph", op: "api", error: "network" }, "warn");
    return fail("Microsoft Graph request failed (network error).");
  }
  if (res.status >= 300 && res.status < 400) {
    // A GET 302 is Graph handing us a pre-signed download URL (file /content).
    // Follow it WITHOUT the token — the URL carries its own auth, and the
    // bearer token must never reach a non-pinned host (samgov's S3 pattern).
    const location = res.headers.get("location");
    if (method !== "GET" || !location?.startsWith("https://")) {
      return fail(`Graph answered ${res.status} (an unexpected redirect).`);
    }
    try {
      // ONE hop only — a pre-signed URL serves bytes directly; a chain could
      // downgrade to http or wander, so any further redirect is an error.
      res = await fetch(location, { redirect: "error" });
    } catch {
      logEvt("connector_error", { provider: "msgraph", op: "download", error: "network" }, "warn");
      return fail("The file download behind Graph's redirect failed (network error).");
    }
  }
  // Refuse oversized bodies BEFORE buffering when the server declares a
  // length (file servers do). ponytail: length-less bodies still buffer
  // fully before the cap check — streaming abort only if a real box OOMs.
  if (Number(res.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    return fail(
      `Response exceeds the ${MAX_RESPONSE_BYTES} byte cap — narrow the query ($top, $select, $filter).`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    return fail(
      `Response exceeds the ${MAX_RESPONSE_BYTES} byte cap — narrow the query ($top, $select, $filter).`,
    );
  }
  if (res.status === 401) {
    return fail(
      "Microsoft returned 401 — the connection needs re-authorizing " +
        "(reconnect Microsoft 365 on the dashboard's Connectors page).",
    );
  }
  if (!res.ok) {
    logEvt("connector_error", { provider: "msgraph", op: "api", error: res.status }, "warn");
    // Status + a snippet: Graph error bodies carry useful hints (bad $filter,
    // missing permission name, throttling). Token is header-only.
    return fail(`Graph returned ${res.status}. ${buf.toString("utf8").slice(0, 300)}`);
  }
  return decodeContent(res, buf);
}

// ------------------------------------------------------------- the doctrine

/** What the `microsoft` tool returns when called with no (or unrecognized)
 *  arguments: a live usage guide instead of an error (same self-teaching
 *  contract as the google tool). */
export function microsoftDoctrine(status: {
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
        "The Microsoft 365 connector is not enabled on this box. An owner adds the " +
        "org's Entra app registration on the dashboard's Connectors page.",
    });
  }
  if (!status.connected && status.reauth) {
    return ok({
      connected: false,
      teach:
        "Your Microsoft connection exists but needs re-authorizing (or Microsoft's " +
        "token service had a blip). Retry shortly; if it persists, click Connect " +
        "again on the dashboard's Connectors page.",
    });
  }
  if (!status.connected) {
    return ok({
      connected: false,
      teach:
        "You haven't connected a Microsoft account yet. Open the box dashboard → " +
        "Connectors → Microsoft 365 → Connect, approve the consent screen, then call " +
        "this tool again.",
    });
  }
  return ok({
    connected: true,
    scopes: status.scopes,
    teach:
      "You are connected. This one tool is ALL of Microsoft 365 — a thin " +
      "authenticated proxy over Microsoft Graph: pass {path, params?, method?, body?} " +
      "and the box injects YOUR OAuth token (you never see it). Allowed paths: " +
      "/v1.0/… (anything Graph documents: Outlook mail + calendar, OneDrive files " +
      "incl. Word/Excel/PowerPoint, SharePoint sites, Teams chats + channels). " +
      "Use $select/$top/$filter to stay under the 4MB response cap. File content " +
      "(GET …:/content) comes back as {contentType, text} for text files and " +
      "{contentType, encoding:'base64', data} for binary (Office docs, PDFs). " +
      "A small TEXT file can be uploaded by passing a plain string as body on " +
      "PUT …:/content (binary upload is not supported).",
    raw_examples: [
      { path: "/v1.0/me/messages", params: { $search: '"from:someone"', $top: "10" } },
      {
        path: "/v1.0/me/sendMail",
        method: "POST",
        body: {
          message: {
            subject: "Hi",
            body: { contentType: "Text", content: "hello" },
            toRecipients: [{ emailAddress: { address: "a@b.com" } }],
          },
        },
      },
      { path: "/v1.0/me/calendarview", params: { startDateTime: "…", endDateTime: "…" } },
      { path: "/v1.0/me/drive/root/children" },
      { path: "/v1.0/me/drive/root:/notes.txt:/content", method: "PUT", body: "plain text" },
      { path: "/v1.0/sites?search=proposals" },
      { path: "/v1.0/me/joinedTeams" },
      { path: "/v1.0/me/chats", params: { $top: "20" } },
    ],
    tip: "Check the brain for a skill object with this org's Microsoft routines before improvising.",
  });
}
