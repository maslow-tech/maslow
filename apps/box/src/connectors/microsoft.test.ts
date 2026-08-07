import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MICROSOFT_SCOPES,
  microsoftApi,
  microsoftAuthorizeUrl,
  microsoftDoctrine,
  microsoftExchange,
  microsoftRefresh,
  microsoftValidateClient,
} from "./microsoft.js";

/**
 * Microsoft provider against a stubbed fetch: tenant-scoped authorize URL
 * (PKCE), exchange/refresh contracts (refresh-token ROTATION — Microsoft
 * rotates, unlike Google), the Graph proxy rails, and the enable-time
 * credential probe. No real network anywhere.
 */

type StubResponse = {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  location?: string;
};
type Recorded = { url: string; method: string; body: string | null; auth: string | null };

function stubFetch(script: (url: string, init?: RequestInit) => StubResponse): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      auth: headers["Authorization"] ?? null,
    });
    const r = script(url, init);
    const text = r.text ?? JSON.stringify(r.json ?? {});
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get: (h: string) =>
          h === "content-type"
            ? (r.contentType ?? null)
            : h === "location"
              ? (r.location ?? null)
              : null,
      },
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text)),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

/**
 * Host EQUALITY, not `url.includes("graph.microsoft.com")`: a look-alike
 * (`graph.microsoft.com.evil.test`, `evil.test/?graph.microsoft.com`) contains
 * that substring, so a stub routing on it would answer AS Graph and hide
 * exactly the redirect-target bug these tests exist to catch.
 */
function isGraphUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "graph.microsoft.com";
  } catch {
    return false;
  }
}

const CREDS = { clientId: "app-id", clientSecret: "csecret", tenantId: "tenant-123" };

describe("microsoftAuthorizeUrl", () => {
  it("targets the customer tenant with PKCE S256 and the full scope set", () => {
    const url = new URL(
      microsoftAuthorizeUrl(CREDS, {
        state: "st4te",
        codeChallenge: "ch4llenge",
        redirectUri: "https://brain.example.com/connect/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/tenant-123/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(CREDS.clientId);
    expect(url.searchParams.get("code_challenge")).toBe("ch4llenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
    expect(url.searchParams.get("scope")).toContain("offline_access");
    // The client secret belongs to the token exchange, never the browser URL.
    expect(url.toString()).not.toContain("csecret");
  });

  it("sanitizes a hostile tenant id out of the URL", () => {
    const url = new URL(
      microsoftAuthorizeUrl(
        { ...CREDS, tenantId: "evil.com/../x#?@y" },
        { state: "s", codeChallenge: "c", redirectUri: "r" },
      ),
    );
    // Path/fragment/query/userinfo metachars are stripped, so the tenant can
    // never escape its single path segment or redirect the authority.
    expect(url.host).toBe("login.microsoftonline.com");
    expect(url.pathname).toBe("/evil.com..xy/oauth2/v2.0/authorize");
  });
});

describe("microsoftExchange / microsoftRefresh", () => {
  it("exchanges the code at the tenant endpoint and packs the refresh token", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "a b" },
    }));
    const r = await microsoftExchange(CREDS)({
      code: "auth-code",
      codeVerifier: "verifier-xyz",
      redirectUri: "https://brain.example.com/connect/callback",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accessToken).toBe("at-1");
    expect(JSON.parse(r.secretBlob)).toEqual({ v: 1, refreshToken: "rt-1" });
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token");
    const form = new URLSearchParams(calls[0]!.body!);
    expect(form.get("code_verifier")).toBe("verifier-xyz");
  });

  it("fails closed when the refresh token is missing", async () => {
    stubFetch(() => ({ status: 200, json: { access_token: "at-1" } }));
    expect(
      (await microsoftExchange(CREDS)({ code: "c", codeVerifier: "v", redirectUri: "r" })).ok,
    ).toBe(false);
  });

  it("persists the ROTATED refresh token Microsoft returns", async () => {
    stubFetch(() => ({
      status: 200,
      json: { access_token: "at-2", refresh_token: "rt-2-rotated", expires_in: 3600 },
    }));
    const r = await microsoftRefresh(CREDS)(JSON.stringify({ v: 1, refreshToken: "rt-1" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(r.secretBlob)).toEqual({ v: 1, refreshToken: "rt-2-rotated" });
  });

  it("a refused token refresh logs a connector_error CLASS (status), never the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() => ({ status: 400, json: { error: "invalid_grant", secret: "SECRET-MS-BODY" } }));
    await microsoftRefresh(CREDS)(JSON.stringify({ v: 1, refreshToken: "dead" }));
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("connector_error"));
    expect(line).toContain('"provider":"msgraph"');
    expect(line).toContain('"op":"token_post"');
    expect(line).toContain('"error":400');
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-MS-BODY");
    warn.mockRestore();
  });

  it("fails closed on a corrupt blob or a revoked token, never a throw", async () => {
    stubFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
    expect((await microsoftRefresh(CREDS)("not-json")).ok).toBe(false);
    expect((await microsoftRefresh(CREDS)(JSON.stringify({ v: 1, refreshToken: "dead" }))).ok).toBe(
      false,
    );
    vi.stubGlobal("fetch", () => Promise.reject(new Error("boom")));
    expect(
      (await microsoftExchange(CREDS)({ code: "c", codeVerifier: "v", redirectUri: "r" })).ok,
    ).toBe(false);
  });
});

describe("microsoftValidateClient (enable-time probe)", () => {
  it("passes real creds (invalid_grant = fake code, fine client)", async () => {
    stubFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
    expect(await microsoftValidateClient(CREDS)).toEqual({ ok: true });
  });

  it("rejects a bad secret, an unknown app, and an unknown tenant with distinct teaching", async () => {
    stubFetch(() => ({ status: 401, json: { error: "invalid_client" } }));
    const badSecret = await microsoftValidateClient(CREDS);
    expect(badSecret.ok).toBe(false);
    if (!badSecret.ok) expect(badSecret.error).toContain("client secret");

    stubFetch(() => ({ status: 400, text: '{"error_description":"AADSTS90002: not found"}' }));
    const badTenant = await microsoftValidateClient(CREDS);
    expect(badTenant.ok).toBe(false);
    if (!badTenant.ok) expect(badTenant.error).toContain("tenant");
  });

  it("fails closed on network trouble", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("boom")));
    expect((await microsoftValidateClient(CREDS)).ok).toBe(false);
  });

  it("fails CLOSED on an unexpected response (5xx outage page, unlisted AADSTS)", async () => {
    stubFetch(() => ({ status: 503, text: "<html>Service Unavailable</html>" }));
    expect((await microsoftValidateClient(CREDS)).ok).toBe(false);
    stubFetch(() => ({ status: 400, text: '{"error_description":"AADSTS50194: something"}' }));
    expect((await microsoftValidateClient(CREDS)).ok).toBe(false);
  });
});

describe("microsoftApi raw proxy (stubbed fetch)", () => {
  it("rejects non-/v1.0/ paths, bad methods, and traversal — no network call", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    expect((await microsoftApi("tok", { path: "/beta/me" })).successful).toBe(false);
    expect((await microsoftApi("tok", { path: "/v1.0/me", method: "HEAD" })).successful).toBe(
      false,
    );
    expect((await microsoftApi("tok", { path: "/v1.0/../admin" })).successful).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("proxies to graph.microsoft.com with the bearer token and params", async () => {
    const calls = stubFetch(() => ({ status: 200, json: { value: [] } }));
    const r = await microsoftApi("tok", {
      path: "/v1.0/me/messages",
      params: { $top: "10" },
    });
    expect(r.successful).toBe(true);
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages?%24top=10");
    expect(calls[0]!.auth).toBe("Bearer tok");
  });

  it("follows a GET 302 (file /content download) WITHOUT the bearer token", async () => {
    const calls = stubFetch((url) =>
      isGraphUrl(url)
        ? { status: 302, text: "", location: "https://tenant.sharepoint.com/presigned" }
        : { status: 200, text: "meeting notes", contentType: "text/plain" },
    );
    const r = await microsoftApi("tok", { path: "/v1.0/me/drive/root:/notes.txt:/content" });
    expect(r).toMatchObject({
      successful: true,
      data: { contentType: "text/plain", text: "meeting notes" },
    });
    expect(calls[0]!.auth).toBe("Bearer tok");
    expect(calls[1]!.url).toBe("https://tenant.sharepoint.com/presigned");
    expect(calls[1]!.auth).toBeNull(); // the pre-signed URL never sees the token
  });

  it("carries no token to a Graph LOOK-ALIKE redirect host", async () => {
    // The hop is followed (any https Location is), but the token is stripped —
    // and the stub answers this host as NOT Graph, which a substring check on
    // "graph.microsoft.com" would get wrong.
    const evil = "https://graph.microsoft.com.evil.test/x";
    expect(isGraphUrl(evil)).toBe(false);
    const calls = stubFetch((url) =>
      isGraphUrl(url)
        ? { status: 302, text: "", location: evil }
        : { status: 200, text: "stolen?", contentType: "text/plain" },
    );
    await microsoftApi("secret-token", { path: "/v1.0/me/drive/root:/notes.txt:/content" });
    expect(calls[1]!.url).toBe(evil);
    expect(calls[1]!.auth).toBeNull();
  });

  it("a redirect without an https Location (or on a non-GET) fails, not follows", async () => {
    stubFetch(() => ({ status: 302, text: "" }));
    const r = await microsoftApi("tok", { path: "/v1.0/me/drive/root:/report.docx:/content" });
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("redirect");

    stubFetch(() => ({ status: 302, text: "", location: "https://evil.example.com/x" }));
    const post = await microsoftApi("tok", { path: "/v1.0/me/sendMail", method: "POST", body: {} });
    expect(post.successful).toBe(false);
  });

  it("a string body is sent RAW (text upload), an object body as JSON", async () => {
    const calls = stubFetch(() => ({ status: 200, json: { id: "f1" } }));
    await microsoftApi("tok", {
      path: "/v1.0/me/drive/root:/notes.txt:/content",
      method: "PUT",
      body: "hello\nworld",
    });
    await microsoftApi("tok", { path: "/v1.0/me/sendMail", method: "POST", body: { a: 1 } });
    expect(calls[0]!.body).toBe("hello\nworld"); // no JSON quotes/escapes
    expect(calls[1]!.body).toBe('{"a":1}');
  });

  it("caps by UTF-8 BYTES, not UTF-16 code units", async () => {
    // 2M "€" chars = 2M code units but 6MB utf-8 — must trip the 4MB cap.
    stubFetch(() => ({ status: 200, text: "€".repeat(2_000_000) }));
    const r = await microsoftApi("tok", { path: "/v1.0/me/messages" });
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("byte cap");
  });

  it("204/empty (DELETE) succeeds; 401 teaches reconnect without leaking the token", async () => {
    stubFetch(() => ({ status: 204, text: "" }));
    expect(
      await microsoftApi("tok", { path: "/v1.0/me/messages/m1", method: "DELETE" }),
    ).toMatchObject({ successful: true, data: { status: 204 } });

    stubFetch(() => ({ status: 401, text: "{}" }));
    const bad = await microsoftApi("secret-token", { path: "/v1.0/me" });
    expect(bad.successful).toBe(false);
    if (bad.successful) return;
    expect(bad.error).toContain("re-authorizing");
    expect(bad.error).not.toContain("secret-token");
  });
});

describe("microsoftDoctrine", () => {
  it("teaches per state: unconfigured, unconnected, connected", () => {
    const un = microsoftDoctrine({ configured: false, connected: false, scopes: [] });
    if (un.successful) expect(JSON.stringify(un.data)).toContain("owner");
    const nc = microsoftDoctrine({ configured: true, connected: false, scopes: [] });
    if (nc.successful) expect(JSON.stringify(nc.data)).toContain("Connect");
    const c = microsoftDoctrine({ configured: true, connected: true, scopes: ["Mail.ReadWrite"] });
    expect(c.successful).toBe(true);
    if (c.successful) {
      const s = JSON.stringify(c.data);
      expect(s).toContain("/v1.0/");
      expect(s).toContain("sendMail");
      expect(s).toContain("joinedTeams");
    }
  });
});
