import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

/**
 * Regression guard for the CSRF bug: owner-write calls must carry the
 * double-submit `x-csrf-token` header (read from the brain_csrf cookie) or the
 * server rejects them with "csrf check failed". setBranding shipped without it
 * once; this pins that it goes through the csrfReq path like every other write.
 */
describe("api.setBranding CSRF header", () => {
  const realFetch = globalThis.fetch;
  const realDoc = (globalThis as { document?: unknown }).document;

  beforeEach(() => {
    (globalThis as { document?: unknown }).document = { cookie: "brain_csrf=tok-123" };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { document?: unknown }).document = realDoc;
    vi.restoreAllMocks();
  });

  it("POSTs the branding update with the x-csrf-token from the cookie", async () => {
    const fetchMock = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ name: "Maslow", hasFavicon: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await api.setBranding({ name: "Maslow" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    if (!init) throw new Error("fetch called without an init object");
    expect(path).toBe("/api/v1/branding");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe("tok-123");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Maslow" });
  });
});
