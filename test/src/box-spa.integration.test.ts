import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The box serves the built dashboard SPA at the root. The SPA + its API
 * shipped first without wiring the box to serve it; this covers that wiring:
 * `/` returns the SPA shell, deep links fall back to it, /assets are served,
 * /about keeps the MCP info page, and /api keeps its strict JSON CSP.
 */
describe("box serves the dashboard SPA at the root", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: ReturnType<typeof createBox>;
  let uiDir: string;

  const req = (path: string) => Promise.resolve(app.request(path));

  beforeAll(async () => {
    // A stand-in built SPA: index.html with a recognizable marker + one asset.
    uiDir = mkdtempSync(join(tmpdir(), "brain-ui-"));
    mkdirSync(join(uiDir, "assets"));
    writeFileSync(
      join(uiDir, "index.html"),
      '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head>' +
        "<body><div id=root>__BRAIN_SPA_SHELL__</div></body></html>",
    );
    writeFileSync(join(uiDir, "assets", "app.js"), 'console.log("brain-spa-asset")');
    // The PWA assets: vite copies public/ to the build ROOT, so these sit beside
    // index.html rather than under /assets and need their own routes.
    mkdirSync(join(uiDir, "icons"));
    writeFileSync(join(uiDir, "icons", "apple-touch-icon.png"), "__BRAIN_ICON_BYTES__");
    writeFileSync(
      join(uiDir, "manifest.webmanifest"),
      JSON.stringify({ name: "Company brain", short_name: "Brain", start_url: "/" }),
    );
    process.env.BRAIN_UI_DIR = uiDir;

    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({ pool, ownerClient });
  }, 120_000);

  afterAll(async () => {
    delete process.env.BRAIN_UI_DIR;
    await pool?.end();
    await ownerClient?.end();
    await brain?.drop();
    if (uiDir) rmSync(uiDir, { recursive: true, force: true });
  });

  it("GET / returns the SPA shell with the SPA CSP", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("__BRAIN_SPA_SHELL__");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("default-src 'none'"); // not the JSON CSP
  });

  it("a client-side deep link falls back to the SPA shell", async () => {
    const res = await req("/o/some-object-id");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("__BRAIN_SPA_SHELL__");
  });

  it("GET /assets/app.js is served from disk", async () => {
    const res = await req("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("brain-spa-asset");
  });

  it("GET /manifest.webmanifest serves the manifest, not the SPA shell", async () => {
    const res = await req("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const body = (await res.json()) as { name: string; start_url: string };
    // Unbranded box → the on-disk defaults survive untouched.
    expect(body).toMatchObject({ name: "Company brain", start_url: "/" });
  });

  it("GET /icons/apple-touch-icon.png is served from disk, not as index.html", async () => {
    const res = await req("/icons/apple-touch-icon.png");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("__BRAIN_ICON_BYTES__");
    expect(body).not.toContain("__BRAIN_SPA_SHELL__");
  });

  it("an unknown path under /icons 404s rather than returning the SPA shell", async () => {
    const res = await req("/icons/nope.png");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("__BRAIN_SPA_SHELL__");
  });

  it("GET /about still serves the MCP info page (not the SPA)", async () => {
    const res = await req("/about");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("MCP endpoint");
    expect(body).not.toContain("__BRAIN_SPA_SHELL__");
  });

  it("GET /api/v1/version keeps the strict JSON CSP, not the SPA one", async () => {
    const res = await req("/api/v1/version");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("/healthz is unaffected by the SPA catch-all", async () => {
    const res = await req("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "box" });
  });
});
