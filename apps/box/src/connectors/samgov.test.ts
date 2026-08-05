import { afterEach, describe, expect, it, vi } from "vitest";
import { samgovFetch } from "./samgov.js";

/**
 * SAM.gov fetch rails, against a stubbed fetch: the path allowlist (including
 * traversal/host escapes), server-side key injection + scrubbing, the size
 * cap, and param passthrough. No real network anywhere.
 */

type StubResponse = {
  status: number;
  headers?: Record<string, string>;
  text?: string;
};

function stubFetch(script: (url: string) => StubResponse) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const r = script(url);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      text: () => Promise.resolve(r.text ?? "{}"),
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const KEY = "sekret-api-key-40-chars";

describe("samgovFetch (stubbed fetch)", () => {
  it("rejects a path outside the allowlist without any network call", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const r = await samgovFetch(KEY, "/federal-hierarchy/v1/orgs", {});
    expect(r.successful).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects traversal that escapes the allowlisted prefix", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const r = await samgovFetch(KEY, "/opportunities/v2/../../other/api", {});
    expect(r.successful).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects a protocol-relative host escape", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const r = await samgovFetch(KEY, "//evil.com/opportunities/v2/search", {});
    expect(r.successful).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("noticedesc is exact — sibling routes never see the key", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    for (const p of [
      "/prod/opportunities/v1/noticedescriptions",
      "/prod/opportunities/v1/noticedesc/../../../x",
      "/prod/opportunities/v1/noticedesc%2Fdeeper",
    ]) {
      const r = await samgovFetch(KEY, p, {});
      expect(r.successful, p).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts the v1 noticedesc path (a search result's description URL)", async () => {
    const calls = stubFetch(() => ({ status: 200, text: '{"description":"<p>scope</p>"}' }));
    const r = await samgovFetch(KEY, "/prod/opportunities/v1/noticedesc?noticeid=abc123", {});
    expect(r.successful).toBe(true);
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/prod/opportunities/v1/noticedesc");
    expect(url.searchParams.get("noticeid")).toBe("abc123");
    expect(url.searchParams.get("api_key")).toBe(KEY);
  });

  it("hits api.sam.gov with params forwarded and the key injected", async () => {
    const calls = stubFetch(() => ({ status: 200, text: '{"totalRecords":0}' }));
    const r = await samgovFetch(KEY, "/opportunities/v2/search", {
      postedFrom: "01/01/2026",
      postedTo: "07/09/2026",
      limit: "10",
    });
    expect(r).toMatchObject({ successful: true, data: { totalRecords: 0 } });
    const url = new URL(calls[0]!);
    expect(url.origin).toBe("https://api.sam.gov");
    expect(url.pathname).toBe("/opportunities/v2/search");
    expect(url.searchParams.get("postedFrom")).toBe("01/01/2026");
    expect(url.searchParams.get("api_key")).toBe(KEY);
  });

  it("a caller-supplied api_key param never overrides the stored key", async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    await samgovFetch(KEY, "/entity-information/v3/entities", { api_key: "attacker" });
    expect(new URL(calls[0]!).searchParams.get("api_key")).toBe(KEY);
  });

  it("scrubs the key from error bodies", async () => {
    stubFetch(() => ({ status: 429, text: `rate limit exceeded for key ${KEY}` }));
    const r = await samgovFetch(KEY, "/opportunities/v2/search", {});
    expect(r.successful).toBe(false);
    if (!r.successful) {
      expect(r.error).toContain("429");
      expect(r.error).not.toContain(KEY);
      expect(r.error).toContain("[redacted]");
    }
  });

  it("refuses an oversized response", async () => {
    stubFetch(() => ({
      status: 200,
      headers: { "content-length": String(5 * 1024 * 1024) },
    }));
    const r = await samgovFetch(KEY, "/opportunities/v2/search", {});
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("cap");
  });

  it("returns a clean failure on network/redirect errors (no URL echo)", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error(`redirect to https://x?api_key=${KEY}`)));
    const r = await samgovFetch(KEY, "/opportunities/v2/search", {});
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).not.toContain(KEY);
  });
});
