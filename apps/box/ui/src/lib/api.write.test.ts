import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ConflictError, api, newIdempotencyKey } from "./api";

/**
 * The write path's error contract, pinned client-side.
 *
 * A 409 means two different things and the save queue branches on which: a lost
 * CAS (rebase onto `current`) vs a refusal like `open_in_editor` (nothing to
 * rebase — route through the editor). And a 404 must NOT become a conflict: the
 * server answers 404 for an object we may no longer read precisely so the
 * client cannot learn that it exists.
 */
describe("write path api client", () => {
  const realFetch = globalThis.fetch;
  const realDoc = (globalThis as { document?: unknown }).document;
  let calls: Array<[string, RequestInit | undefined]> = [];

  function respond(status: number, body: unknown) {
    const mock = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = mock as unknown as typeof fetch;
  }

  beforeEach(() => {
    calls = [];
    (globalThis as { document?: unknown }).document = { cookie: "brain_csrf=tok-abc" };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { document?: unknown }).document = realDoc;
    vi.restoreAllMocks();
  });

  it("sends the CSRF header and the field-granular patch body", async () => {
    respond(200, { id: "o1", version: 8 });

    const out = await api.patchObject("o1", {
      baseVersion: 7,
      title: "New",
      props: { owner: null },
    });

    expect(out).toEqual({ id: "o1", version: 8 });
    const [path, init] = calls[0]!;
    expect(path).toBe("/api/v1/objects/o1");
    expect(init?.method).toBe("PATCH");
    expect((init?.headers as Record<string, string>)["x-csrf-token"]).toBe("tok-abc");
    // An explicit null must survive serialization — it DELETES that prop key.
    expect(JSON.parse(init?.body as string)).toEqual({
      baseVersion: 7,
      title: "New",
      props: { owner: null },
    });
  });

  it("turns a 409 with a currentVersion into a ConflictError carrying the snapshot", async () => {
    respond(409, {
      code: "conflict",
      message: "version conflict: the object changed since you last read it",
      currentVersion: 9,
      current: {
        title: "Theirs",
        body: "their body",
        props: { stage: "won" },
        updated_at: "2026-07-21T10:00:00.000Z",
        actor_name: "Ada",
      },
    });

    const err = await api.patchObject("o1", { baseVersion: 7, body: "mine" }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ConflictError).status).toBe(409);
    expect((err as ConflictError).currentVersion).toBe(9);
    expect((err as ConflictError).current?.actor_name).toBe("Ada");
    expect((err as ConflictError).reason).toBeUndefined();
    expect((err as ConflictError).message).toContain("version conflict");
  });

  it("distinguishes the open_in_editor refusal by `reason` (no version to rebase on)", async () => {
    respond(409, {
      code: "conflict",
      reason: "open_in_editor",
      message: "this object is open in the collaborative editor",
      unblock: "open it in the editor and type there",
    });

    const err = await api.patchObject("o1", { baseVersion: 7, body: "mine" }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).reason).toBe("open_in_editor");
    expect((err as ConflictError).currentVersion).toBeNull();
    expect((err as ConflictError).current).toBeNull();
  });

  it("leaves a 404 a plain ApiError — never a conflict", async () => {
    respond(404, { code: "not_found", message: "no such object" });

    const err = await api.patchObject("gone", { baseVersion: 3, body: "x" }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe("no such object");
  });

  it("posts create and link with their idempotency keys, and DELETEs a link by body", async () => {
    const key = newIdempotencyKey();
    expect(key.length).toBeGreaterThan(8);

    respond(200, { id: "o2", version: 1 });
    await api.createObject({ type: "note", title: "Draft", idempotencyKey: key });
    expect(calls[0]![0]).toBe("/api/v1/objects");
    expect(JSON.parse(calls[0]![1]?.body as string).idempotencyKey).toBe(key);

    respond(200, { from: "o2", rel: "about", to: "o1" });
    await api.linkObject("o2", { to: "o1", rel: "about", idempotencyKey: key });
    expect(calls[1]![0]).toBe("/api/v1/objects/o2/links");
    expect(calls[1]![1]?.method).toBe("POST");

    respond(200, { from: "o2", rel: "about", to: "o1", removed: true });
    await api.unlinkObject("o2", { to: "o1", rel: "about" });
    expect(calls[2]![0]).toBe("/api/v1/objects/o2/links");
    expect(calls[2]![1]?.method).toBe("DELETE");
    expect(JSON.parse(calls[2]![1]?.body as string)).toEqual({ to: "o1", rel: "about" });

    respond(200, { id: "o2", version: 2 });
    await api.deleteObject("o2");
    expect(calls[3]![0]).toBe("/api/v1/objects/o2");
    expect(calls[3]![1]?.method).toBe("DELETE");
  });
});
