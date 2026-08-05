import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createBox, snapshotActivity, snapshotBoxErrors } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Production MCP timing telemetry: every tools/call emits ONE structured
 * stdout line ({evt:"mcp_call", tool, ok, ms} — never args/content) and
 * accumulates per-tool {n, total_ms, max_ms} for the activity heartbeat.
 * The call-audit row still lands even though it is off the critical path.
 */
describe("mcp timing telemetry", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;
  let token: string;

  const mcp = (body: unknown): Promise<Response> =>
    Promise.resolve(
      app.request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({ pool, ownerClient });
    const boot = await new Admin(pool).bootstrapOwner({
      name: "Owner",
      email: "owner@example.com",
    });
    token = boot.token;
    snapshotActivity(); // drop anything counted before this suite's calls
  }, 120_000);

  afterAll(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** mcp_call lines captured by a console.log spy, parsed. */
  function callLines(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
    return spy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null && x["evt"] === "mcp_call");
  }

  it("logs one timing line per call — tool name + outcome + ms, never args", async () => {
    const spy = vi.spyOn(console, "log");
    const res = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "write", arguments: { title: "SECRET-TITLE-MUST-NOT-LOG", body: "x" } },
    });
    expect(res.status).toBe(200);
    const lines = callLines(spy);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line["tool"]).toBe("write");
    expect(line["ok"]).toBe(true);
    expect(typeof line["ms"]).toBe("number");
    expect(line["ms"]).toBeGreaterThanOrEqual(0);
    // the line carries NO argument content
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-TITLE-MUST-NOT-LOG");
  });

  it("the timing line carries attribution (actor) and the write flow, never values", async () => {
    const spy = vi.spyOn(console, "log");
    const res = await mcp({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "write",
        arguments: { type: "note", title: "SECRET-2", body: "x", visibility: "private" },
      },
    });
    expect(res.status).toBe(200);
    const line = callLines(spy).at(-1)!;
    expect(typeof line["actor"]).toBe("string"); // the calling account uuid
    expect(line["obo"]).toBeUndefined(); // no x-on-behalf-of on this call
    const flow = line["flow"] as Record<string, unknown>;
    expect(flow).toMatchObject({ links: 0, visibility: "private" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-2");
  });

  it("search's flow says HOW it searched — mode hit counts + embedder state", async () => {
    const spy = vi.spyOn(console, "log");
    const res = await mcp({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "search", arguments: { query: "SECRET-QUERY-NEVER-LOGGED" } },
    });
    expect(res.status).toBe(200);
    const line = callLines(spy).at(-1)!;
    expect(line["tool"]).toBe("search");
    const flow = line["flow"] as Record<string, unknown>;
    expect(flow["queries"]).toBe(1);
    expect(typeof flow["fts"]).toBe("number");
    // no embedder wired in this rig → the degraded-search case is VISIBLE
    expect(flow["embedder"]).toBe("off");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-QUERY-NEVER-LOGGED");
  });

  it("bash flow carries exit_code + bytes_out — never the command line", async () => {
    const spy = vi.spyOn(console, "log");
    const res = await mcp({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "bash",
        arguments: { script: "printf ok # SECRET-CMD-NEVER-LOGGED" },
      },
    });
    expect(res.status).toBe(200);
    const line = callLines(spy).at(-1)!;
    expect(line["tool"]).toBe("bash");
    const flow = line["flow"] as Record<string, unknown>;
    expect(flow["exit_code"]).toBe(0);
    expect(typeof flow["bytes_out"]).toBe("number");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-CMD-NEVER-LOGGED");
  });

  it("a MISSING bearer is a quiet no_token line, never the fleet channel (OAuth discovery)", async () => {
    snapshotBoxErrors();
    const logSpy = vi.spyOn(console, "log");
    const warnSpy = vi.spyOn(console, "warn");
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 15, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('"reason":"no_token"');
    expect(
      logSpy.mock.calls.some(
        (c) => String(c[0]).includes('"auth_rejected"') && String(c[0]).includes('"no_token"'),
      ),
    ).toBe(true);
    expect(snapshotBoxErrors()).toEqual([]); // routine handshakes never feed the fleet channel
  });

  it("a bad bearer logs auth_rejected {surface:mcp} — and nothing else", async () => {
    const spy = vi.spyOn(console, "warn");
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bogus" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 13, method: "ping" }),
    });
    expect(res.status).toBe(401);
    const evts = spy.mock.calls
      .map((a) => {
        try {
          return JSON.parse(String(a[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
    expect(evts).toContainEqual(
      expect.objectContaining({ evt: "auth_rejected", surface: "mcp", reason: "bad_token" }),
    );
    // and it fed the fleet error channel (heartbeat errors[] → booth box_errors)
    expect(snapshotBoxErrors()).toContainEqual(expect.objectContaining({ code: "auth_rejected" }));
  });

  it("a failing call logs ok:false with the teaching-error code", async () => {
    const spy = vi.spyOn(console, "log");
    const res = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get", arguments: { id: "not-a-uuid" } },
    });
    expect(res.status).toBe(200); // MCP tool errors are isError results, not faults
    const line = callLines(spy).at(-1)!;
    expect(line["tool"]).toBe("get");
    expect(line["ok"]).toBe(false);
    expect(typeof line["code"]).toBe("string");
  });

  it("an UNKNOWN tool name never reaches the log line or the activity rollup", async () => {
    const spy = vi.spyOn(console, "log");
    snapshotActivity();
    const res = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "SECRET-CONTENT-AS-TOOL-NAME", arguments: {} },
    });
    expect(res.status).toBe(200); // isError result, not a fault
    const line = callLines(spy).at(-1)!;
    expect(line["tool"]).toBe("(invalid)");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-CONTENT-AS-TOOL-NAME");
    const snap = snapshotActivity();
    expect(snap.tools["(invalid)"]).toBe(1);
    expect("SECRET-CONTENT-AS-TOOL-NAME" in snap.tools).toBe(false);
  });

  it("accumulates per-tool timings for the heartbeat and resets on snapshot", async () => {
    snapshotActivity(); // clean window
    for (let i = 0; i < 3; i++) {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 10 + i,
        method: "tools/call",
        params: { name: "catalog", arguments: {} },
      });
      expect(res.status).toBe(200);
    }
    const snap = snapshotActivity();
    expect(snap.tools["catalog"]).toBe(3);
    const t = snap.timings["catalog"]!;
    expect(t.n).toBe(3);
    expect(t.total_ms).toBeGreaterThanOrEqual(0);
    expect(t.max_ms).toBeLessThanOrEqual(t.total_ms + 1);
    // window reset: a second snapshot is empty
    const again = snapshotActivity();
    expect(again.calls).toBe(0);
    expect(again.timings).toEqual({});
  });

  it("the call-audit row still lands even though it is off the critical path", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "list", arguments: { type: "note" } },
    });
    expect(res.status).toBe(200);
    // audit is queued, not awaited — poll briefly for the committed event
    const deadline = Date.now() + 5_000;
    let found = false;
    while (!found && Date.now() < deadline) {
      const r = await ownerClient.query("SELECT 1 FROM events WHERE kind = 'call:list' LIMIT 1");
      found = (r.rowCount ?? 0) > 0;
      if (!found) await new Promise((res2) => setTimeout(res2, 50));
    }
    expect(found).toBe(true);
  });
});
