import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The SPA's CSP must actually permit the collab WebSocket.
 *
 * The dashboard opens `wss://<this box>/dash/collab` (built from
 * location.origin in apps/box/ui/src/lib/collab.ts). CSP3 says `connect-src
 * 'self'` already covers same-origin ws/wss — but Safari has historically NOT
 * implemented that, and iOS Safari is a required target for this build. Worse,
 * NO existing test can catch the regression: every collab test drives a Node
 * `ws` client, and Node clients do not enforce CSP at all. The bug is invisible
 * until someone opens the dashboard on a phone.
 *
 * So this file asserts the header itself, on both sides:
 *   - it names an origin a browser would accept for the collab socket, and
 *   - it does NOT hand an XSS a wildcard to exfiltrate the brain through.
 *
 * The second half is the point of the first. `connect-src wss:` would also fix
 * Safari, and would let injected script stream the whole brain to any WebSocket
 * server on the internet. The allowance is scoped to the box's own host.
 */
describe("SPA CSP permits the collab WebSocket without opening an exfiltration channel", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: ReturnType<typeof createBox>;
  let uiDir: string;
  const prevDomain = process.env.BRAIN_DOMAIN;

  /** The CSP the box serves for the SPA shell, as a browser would receive it. */
  const cspFor = async (init?: { host?: string; proto?: string }): Promise<string> => {
    const headers: Record<string, string> = {};
    if (init?.host) headers["x-forwarded-host"] = init.host;
    if (init?.proto) headers["x-forwarded-proto"] = init.proto;
    const res = await app.request("/", { headers });
    expect(res.status).toBe(200);
    return res.headers.get("content-security-policy") ?? "";
  };

  /** The directive as a token list — CSP is whitespace-separated, order-free. */
  const connectSrc = (csp: string): string[] => {
    const directive = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d === "connect-src" || d.startsWith("connect-src "));
    expect(directive, `no connect-src in: ${csp}`).toBeDefined();
    return directive!.split(/\s+/).slice(1);
  };

  beforeAll(async () => {
    uiDir = mkdtempSync(join(tmpdir(), "brain-csp-ui-"));
    mkdirSync(join(uiDir, "assets"));
    writeFileSync(
      join(uiDir, "index.html"),
      "<!doctype html><html><body><div id=root>__BRAIN_SPA_SHELL__</div></body></html>",
    );
    writeFileSync(join(uiDir, "assets", "app.js"), "// spa");
    process.env.BRAIN_UI_DIR = uiDir;
    process.env.BRAIN_DOMAIN = "brain.example.com";

    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({ pool, ownerClient });
  }, 120_000);

  afterAll(async () => {
    delete process.env.BRAIN_UI_DIR;
    if (prevDomain === undefined) delete process.env.BRAIN_DOMAIN;
    else process.env.BRAIN_DOMAIN = prevDomain;
    await pool?.end();
    await ownerClient?.end();
    await brain?.drop();
    if (uiDir) rmSync(uiDir, { recursive: true, force: true });
  });

  it("names the box's own wss origin, so Safari/iOS can open /dash/collab", async () => {
    const sources = connectSrc(await cspFor({ host: "brain.example.com", proto: "https" }));
    // What the SPA actually dials.
    expect(sources).toContain("wss://brain.example.com");
    // 'self' stays — the REST/API fetches ride it.
    expect(sources).toContain("'self'");
  });

  it("does NOT allow arbitrary third-party connect targets", async () => {
    const csp = await cspFor({ host: "brain.example.com", proto: "https" });
    const sources = connectSrc(csp);
    // The lazy fixes, each of which would let an XSS stream the brain out.
    for (const wildcard of ["*", "wss:", "ws:", "https:", "http:", "wss://*", "data:", "blob:"]) {
      expect(sources).not.toContain(wildcard);
    }
    // No source may be a bare scheme or contain a wildcard host.
    for (const s of sources) {
      if (s.startsWith("'")) continue; // keywords: 'self'
      expect(s).toMatch(/^wss?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?$/);
      expect(s).not.toContain("*");
    }
    // And an unrelated origin is not reachable.
    expect(csp).not.toContain("evil.example");
  });

  it("a forged Host header cannot smuggle a source or a directive into the CSP", async () => {
    // The Host header is attacker-controlled. A host that is merely a different
    // NAME is uninteresting (that is how virtual hosting works, and the browser
    // still only gets its own origin) — the danger is a value crafted to end the
    // directive and start a new one, or to widen it with a wildcard.
    for (const forged of [
      "brain.example.com; connect-src wss://evil.example",
      "brain.example.com wss://evil.example",
      "*.evil.example",
      "evil.example/*",
      "'unsafe-eval'",
    ]) {
      const csp = await cspFor({ host: forged, proto: "https" });
      expect(csp, forged).not.toContain("evil.example");
      expect(csp, forged).not.toContain("*");
      expect(csp, forged).not.toContain("unsafe-eval");
      expect(csp, forged).not.toMatch(/[\r\n]/);
      // Exactly the directives we wrote, no extras.
      const names = csp.split(";").map((d) => d.trim().split(/\s+/)[0]);
      expect(names, forged).toEqual([
        "default-src",
        "script-src",
        "style-src",
        "img-src",
        "font-src",
        "connect-src",
        "base-uri",
        "frame-ancestors",
      ]);
      // The configured domain still carries the real box.
      expect(connectSrc(csp), forged).toContain("wss://brain.example.com");
    }
  });

  it("allows plaintext ws only for local http development", async () => {
    const dev = connectSrc(await cspFor({ host: "localhost:8080", proto: "http" }));
    expect(dev).toContain("ws://localhost:8080");
    // https requests never carry a plaintext allowance for their own host.
    const prod = connectSrc(await cspFor({ host: "brain.example.com", proto: "https" }));
    expect(prod).not.toContain("ws://brain.example.com");
  });

  it("keeps every other directive exactly as strict as before", async () => {
    const csp = await cspFor({ host: "brain.example.com", proto: "https" });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("leaves the /api JSON surface on its own default-src 'none' CSP", async () => {
    const res = await app.request("/api/v1/version");
    const csp = res.headers.get("content-security-policy") ?? "";
    // The API surface is untouched by the SPA's socket allowance.
    expect(csp).not.toContain("wss://");
    if (csp) expect(csp).toContain("default-src 'none'");
  });
});
