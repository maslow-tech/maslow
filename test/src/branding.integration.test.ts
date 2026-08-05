import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * White-label branding (box_kv): the public GET the login screen reads before
 * auth, the owner-only POST that sets name + favicon, and the /favicon.ico
 * route that serves the stored image across the whole origin. Proves the
 * security shape (owner-only writes) and that a non-owner cannot rebrand.
 */

const SECRET = "test-session-secret-please-change";
// 1x1 transparent PNG.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function cookieValue(res: Response, name: string): string | undefined {
  const all =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const line of all) {
    const m = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(line);
    if (m) return decodeURIComponent(m[1] as string);
  }
  return undefined;
}

describe("white-label branding", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let ownerToken: string;
  let memberToken: string;

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.request(path, init));

  const login = async (token: string): Promise<{ cookie: string; csrf: string }> => {
    const res = await req("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const session = cookieValue(res, "brain_session");
    const csrf = cookieValue(res, "brain_csrf");
    if (!session || !csrf) throw new Error("login did not set both cookies");
    return { cookie: `brain_session=${session}; brain_csrf=${csrf}`, csrf };
  };

  const post = (body: unknown, auth: { cookie: string; csrf: string }): Promise<Response> =>
    req("/api/v1/branding", {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        "content-type": "application/json",
        "x-csrf-token": auth.csrf,
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false },
    });
    const boot = await new Admin(pool).bootstrapOwner({
      name: "Owner",
      email: "owner@example.com",
    });
    ownerToken = boot.token;
    const member = await new Admin(pool).createUser(boot.id, {
      name: "Reader",
      email: "user@example.com",
      permission: "viewer",
    });
    memberToken = member.token;
  }, 180_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("public GET returns defaults on a fresh box (no auth needed)", async () => {
    const res = await req("/api/v1/branding");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: null, hasFavicon: false });
  });

  it("/favicon.ico is 404 until one is set", async () => {
    const res = await req("/favicon.ico");
    expect(res.status).toBe(404);
  });

  it("an owner sets the name; the public GET reflects it", async () => {
    const owner = await login(ownerToken);
    const res = await post({ name: "Acme Federal" }, owner);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("Acme Federal");

    const pub = await req("/api/v1/branding");
    expect(((await pub.json()) as { name: string }).name).toBe("Acme Federal");
  });

  it("an owner uploads a favicon; /favicon.ico serves it with the right type", async () => {
    const owner = await login(ownerToken);
    const set = await post({ faviconDataUrl: PNG_DATA_URL }, owner);
    expect(set.status).toBe(200);
    expect(((await set.json()) as { hasFavicon: boolean }).hasFavicon).toBe(true);

    const fav = await req("/favicon.ico");
    expect(fav.status).toBe(200);
    expect(fav.headers.get("content-type")).toBe("image/png");
    expect((await fav.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("rejects a non-image data URL", async () => {
    const owner = await login(ownerToken);
    const res = await post({ faviconDataUrl: "data:text/html;base64,PHNjcmlwdD4=" }, owner);
    expect(res.status).toBe(400);
  });

  it("a non-owner (viewer) cannot rebrand — 403, and nothing changes", async () => {
    const member = await login(memberToken);
    const res = await post({ name: "Hacked Inc" }, member);
    expect(res.status).toBe(403);

    const pub = await req("/api/v1/branding");
    expect(((await pub.json()) as { name: string }).name).toBe("Acme Federal");
  });

  it("clearing the name falls back to the default (null)", async () => {
    const owner = await login(ownerToken);
    const res = await post({ name: "" }, owner);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string | null }).name).toBeNull();
  });
});
