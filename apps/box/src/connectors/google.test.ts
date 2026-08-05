import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_SCOPES,
  buildRawMessage,
  gmailRead,
  gmailSearch,
  gmailSend,
  googleApi,
  googleAuthorizeUrl,
  googleDoctrine,
  googleExchange,
  googleRefresh,
  googleValidateClient,
} from "./google.js";

/**
 * Google provider against a stubbed fetch: authorize-URL shape (PKCE +
 * offline access), exchange/refresh contracts (fail closed, keep the refresh
 * token), RFC822 building (CRLF injection, UTF-8 subjects), and the Gmail
 * action rails. No real network anywhere.
 */

type StubResponse = {
  status: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  contentType?: string;
  contentLength?: number;
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
    const bytes = r.bytes ?? new TextEncoder().encode(text);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get: (h: string) =>
          h === "content-type"
            ? (r.contentType ?? null)
            : h === "content-length" && r.contentLength !== undefined
              ? String(r.contentLength)
              : null,
      },
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text)),
      arrayBuffer: () => Promise.resolve(bytes.buffer),
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const CREDS = { clientId: "cid.apps.googleusercontent.com", clientSecret: "csecret" };

describe("googleAuthorizeUrl", () => {
  it("carries PKCE S256, offline access, forced consent, and the scope set", () => {
    const url = new URL(
      googleAuthorizeUrl(CREDS, {
        state: "st4te",
        codeChallenge: "ch4llenge",
        redirectUri: "https://brain.example.com/connect/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CREDS.clientId);
    expect(url.searchParams.get("code_challenge")).toBe("ch4llenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
    // The client secret belongs to the token exchange, never the browser URL.
    expect(url.toString()).not.toContain("csecret");
  });
});

describe("googleExchange", () => {
  it("posts the bound verifier and packs the refresh token into the blob", async () => {
    const calls = stubFetch(() => ({
      status: 200,
      json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "a b" },
    }));
    const r = await googleExchange(CREDS)({
      code: "auth-code",
      codeVerifier: "verifier-xyz",
      redirectUri: "https://brain.example.com/connect/callback",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accessToken).toBe("at-1");
    expect(JSON.parse(r.secretBlob)).toEqual({ v: 1, refreshToken: "rt-1" });
    expect(r.scopes).toEqual(["a", "b"]);
    const form = new URLSearchParams(calls[0]!.body!);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(form.get("code_verifier")).toBe("verifier-xyz");
    expect(form.get("grant_type")).toBe("authorization_code");
  });

  it("fails closed when Google omits the refresh token (unrefreshable secret)", async () => {
    stubFetch(() => ({ status: 200, json: { access_token: "at-1" } }));
    expect(
      (await googleExchange(CREDS)({ code: "c", codeVerifier: "v", redirectUri: "r" })).ok,
    ).toBe(false);
  });

  it("maps a provider error / network throw to ok:false, never a throw", async () => {
    stubFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
    expect(
      (await googleExchange(CREDS)({ code: "c", codeVerifier: "v", redirectUri: "r" })).ok,
    ).toBe(false);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("boom")));
    expect(
      (await googleExchange(CREDS)({ code: "c", codeVerifier: "v", redirectUri: "r" })).ok,
    ).toBe(false);
  });
});

describe("googleRefresh", () => {
  it("keeps the prior refresh token when Google doesn't rotate it", async () => {
    stubFetch(() => ({ status: 200, json: { access_token: "at-2", expires_in: 3600 } }));
    const r = await googleRefresh(CREDS)(JSON.stringify({ v: 1, refreshToken: "rt-1" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.accessToken).toBe("at-2");
    expect(JSON.parse(r.secretBlob)).toEqual({ v: 1, refreshToken: "rt-1" });
  });

  it("a refused token refresh logs a connector_error CLASS (status), never the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() => ({ status: 400, json: { error: "invalid_grant", secret: "SECRET-BODY" } }));
    await googleRefresh(CREDS)(JSON.stringify({ v: 1, refreshToken: "dead" }));
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("connector_error"));
    expect(line).toContain('"provider":"google"');
    expect(line).toContain('"op":"token_post"');
    expect(line).toContain('"error":400');
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-BODY");
    warn.mockRestore();
  });

  it("fails closed on a corrupt/legacy blob or a revoked token", async () => {
    stubFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
    expect((await googleRefresh(CREDS)("not-json")).ok).toBe(false);
    expect((await googleRefresh(CREDS)(JSON.stringify({ v: 1, refreshToken: "dead" }))).ok).toBe(
      false,
    );
  });
});

describe("buildRawMessage", () => {
  const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

  it("builds a decodable RFC822 message with base64 body", () => {
    const msg = decode(buildRawMessage({ to: "a@b.com", subject: "Hi", body: "hello there" }));
    expect(msg).toContain("To: a@b.com");
    expect(msg).toContain("Subject: Hi");
    const b64 = msg.split("\r\n\r\n")[1]!;
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("hello there");
  });

  it("strips CRLF from recipient/subject (header injection)", () => {
    const msg = decode(
      buildRawMessage({
        to: "a@b.com\r\nBcc: evil@x.com",
        subject: "s\r\nX-Evil: 1",
        body: "b",
      }),
    );
    // The CRLF is collapsed, so the payload stays INSIDE the To/Subject value —
    // no line ever STARTS with the injected header.
    const lines = msg.split("\r\n");
    expect(lines.some((l) => l.startsWith("Bcc:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("X-Evil:"))).toBe(false);
    expect(lines.filter((l) => l.startsWith("To:"))).toEqual(["To: a@b.com Bcc: evil@x.com"]);
  });

  it("RFC2047-encodes a non-ASCII subject", () => {
    const msg = decode(buildRawMessage({ to: "a@b.com", subject: "héllo", body: "b" }));
    expect(msg).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("héllo", "utf8").toString("base64")}?=`,
    );
  });
});

describe("googleApi raw proxy (stubbed fetch)", () => {
  it("rejects paths outside the allowlist and disallowed methods, no network call", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const badPath = await googleApi("tok", { path: "/oauth2/v4/token" });
    expect(badPath.successful).toBe(false);
    if (!badPath.successful) expect(badPath.error).toContain("not an allowed");
    const badMethod = await googleApi("tok", { path: "/gmail/v1/users/me/labels", method: "HEAD" });
    expect(badMethod.successful).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("blocks traversal escapes after normalization", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const r = await googleApi("tok", { path: "/gmail/v1/../../admin/directory" });
    expect(r.successful).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("routes each service to its pinned host and passes params/body", async () => {
    const calls = stubFetch(() => ({ status: 200, json: { ok: 1 } }));
    await googleApi("tok", {
      path: "/calendar/v3/calendars/primary/events",
      params: { maxResults: "5" },
    });
    await googleApi("tok", { path: "/drive/v3/files" });
    await googleApi("tok", {
      path: "/gmail/v1/users/me/messages/m1/trash",
      method: "POST",
    });
    expect(calls[0]!.url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=5",
    );
    expect(calls[1]!.url).toBe("https://www.googleapis.com/drive/v3/files");
    expect(calls[2]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/trash");
    expect(calls[2]!.method).toBe("POST");
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("handles a 204/empty body (DELETE) without a JSON parse error", async () => {
    stubFetch(() => ({ status: 204, text: "" }));
    const r = await googleApi("tok", { path: "/gmail/v1/users/me/messages/m1", method: "DELETE" });
    expect(r).toMatchObject({ successful: true, data: { status: 204 } });
  });

  it("a provider 4xx logs connector_error with the status class (else outages are invisible)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() => ({ status: 429, text: '{"error":{"message":"rate limited SECRET-HINT"}}' }));
    await googleApi("tok", { path: "/gmail/v1/users/me/labels" });
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("connector_error"));
    expect(line).toContain('"op":"api"');
    expect(line).toContain('"error":429');
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-HINT");
    warn.mockRestore();
  });

  it("returns a non-JSON text body (Drive export) as {contentType, text}", async () => {
    stubFetch(() => ({
      status: 200,
      text: "Quarterly plan\n\n1. Ship it",
      contentType: "text/plain",
    }));
    const r = await googleApi("tok", {
      path: "/drive/v3/files/f1/export",
      params: { mimeType: "text/plain" },
    });
    expect(r).toMatchObject({
      successful: true,
      data: { status: 200, contentType: "text/plain", text: "Quarterly plan\n\n1. Ship it" },
    });
  });

  it("declared-binary content (image/jpeg) goes base64 even with no NUL bytes", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x42]); // NUL-free
    stubFetch(() => ({ status: 200, bytes: jpeg, contentType: "image/jpeg" }));
    const r = await googleApi("tok", { path: "/drive/v3/files/f1", params: { alt: "media" } });
    expect(r.successful).toBe(true);
    if (r.successful) {
      const d = r.data as { encoding: string; data: string };
      expect(d.encoding).toBe("base64");
      expect(Buffer.from(d.data, "base64")).toEqual(Buffer.from(jpeg));
    }
  });

  it("honors a declared non-UTF-8 charset on text content", async () => {
    // 0xE9 = "é" in windows-1252, invalid as standalone UTF-8.
    const csv = new Uint8Array([0xe9, 0x63, 0x6c, 0x61, 0x69, 0x72]);
    stubFetch(() => ({ status: 200, bytes: csv, contentType: "text/csv; charset=windows-1252" }));
    const r = await googleApi("tok", { path: "/drive/v3/files/f1/export" });
    expect(r).toMatchObject({ successful: true, data: { text: "éclair" } });
  });

  it("parses BOM-prefixed JSON as JSON, not file content", async () => {
    stubFetch(() => ({ status: 200, text: '\uFEFF{"id":"m1"}' }));
    const r = await googleApi("tok", { path: "/gmail/v1/users/me/messages/m1" });
    expect(r).toMatchObject({ successful: true, data: { id: "m1" } });
  });

  it("refuses an over-cap declared content-length before reading the body", async () => {
    stubFetch(() => ({ status: 200, text: "{}", contentLength: 5 * 1024 * 1024 }));
    const r = await googleApi("tok", { path: "/drive/v3/files/f1", params: { alt: "media" } });
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("byte cap");
  });

  it("returns a binary body (alt=media) as base64, not a parse failure", async () => {
    const blob = "PK\u0000\u0000docx-bytes"; // NUL bytes = binary
    stubFetch(() => ({
      status: 200,
      text: blob,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }));
    const r = await googleApi("tok", { path: "/drive/v3/files/f1", params: { alt: "media" } });
    expect(r.successful).toBe(true);
    if (r.successful) {
      const d = r.data as { encoding: string; data: string; contentType: string };
      expect(d.encoding).toBe("base64");
      expect(Buffer.from(d.data, "base64").toString("utf8")).toBe(blob);
    }
  });
});

describe("googleDoctrine", () => {
  it("teaches per state: unconfigured, unconnected, connected", () => {
    const un = googleDoctrine({ configured: false, connected: false, scopes: [] });
    if (un.successful) expect(JSON.stringify(un.data)).toContain("owner");
    const nc = googleDoctrine({ configured: true, connected: false, scopes: [] });
    if (nc.successful) expect(JSON.stringify(nc.data)).toContain("Connect");
    const c = googleDoctrine({
      configured: true,
      connected: true,
      scopes: ["https://mail.google.com/"],
    });
    expect(c.successful).toBe(true);
    if (c.successful) {
      const s = JSON.stringify(c.data);
      expect(s).toContain("/gmail/v1/");
      expect(s).toContain("/calendar/v3/");
      expect(s).toContain("/drive/v3/");
      expect(s).toContain("search_mail");
    }
  });
});

describe("gmail actions (stubbed fetch)", () => {
  it("search lists ids then hydrates headers per hit", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/messages?")) {
        return { status: 200, json: { messages: [{ id: "m1" }, { id: "m2" }] } };
      }
      return {
        status: 200,
        json: {
          id: url.includes("m1") ? "m1" : "m2",
          threadId: "t1",
          snippet: "snip",
          payload: {
            headers: [
              { name: "Subject", value: "S" },
              { name: "From", value: "f@x" },
            ],
          },
        },
      };
    });
    const r = await gmailSearch("tok", "from:acme", 5);
    expect(r.successful).toBe(true);
    if (!r.successful) return;
    const data = r.data as { count: number; messages: Array<{ subject: string | null }> };
    expect(data.count).toBe(2);
    expect(data.messages[0]!.subject).toBe("S");
    expect(calls[0]!.url).toContain("maxResults=5");
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("read decodes a nested text/plain part", async () => {
    stubFetch(() => ({
      status: 200,
      json: {
        id: "m1",
        payload: {
          mimeType: "multipart/alternative",
          headers: [{ name: "Subject", value: "S" }],
          parts: [
            {
              mimeType: "text/html",
              body: { data: Buffer.from("<b>html</b>").toString("base64url") },
            },
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("plain body").toString("base64url") },
            },
          ],
        },
      },
    }));
    const r = await gmailRead("tok", "m1");
    expect(r.successful).toBe(true);
    if (!r.successful) return;
    expect((r.data as { body: string }).body).toBe("plain body");
  });

  it("send posts the raw message; 401 teaches reconnect without leaking the token", async () => {
    const calls = stubFetch(() => ({ status: 200, json: { id: "sent1", threadId: "t9" } }));
    const r = await gmailSend("tok", { to: "a@b.com", subject: "s", body: "b" });
    expect(r).toMatchObject({ successful: true, data: { sent: true, id: "sent1" } });
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toHaveProperty("raw");

    stubFetch(() => ({ status: 401, text: '{"error":{"code":401}}' }));
    const bad = await gmailSend("secret-token", { to: "a@b.com", subject: "s", body: "b" });
    expect(bad.successful).toBe(false);
    if (bad.successful) return;
    expect(bad.error).toContain("re-authorizing");
    expect(bad.error).not.toContain("secret-token");
  });

  it("send NEVER claims success off a 200 with no message id (HTML outage page)", async () => {
    stubFetch(() => ({ status: 200, text: "<html>oops</html>", contentType: "text/html" }));
    const r = await gmailSend("tok", { to: "a@b.com", subject: "s", body: "b" });
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("NOT confirmed");
  });
});

describe("googleValidateClient (stubbed fetch)", () => {
  it("accepts real client creds — bogus-code probe answers invalid_grant", async () => {
    const calls = stubFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
    const r = await googleValidateClient(CREDS);
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
  });

  it("rejects wrong creds — probe answers invalid_client", async () => {
    stubFetch(() => ({ status: 401, json: { error: "invalid_client" } }));
    const r = await googleValidateClient({ clientId: "nope", clientSecret: "wrong" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rejected this OAuth client/);
  });

  it("fails closed when Google is unreachable", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("boom")));
    const r = await googleValidateClient(CREDS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Could not reach Google/);
  });
});
