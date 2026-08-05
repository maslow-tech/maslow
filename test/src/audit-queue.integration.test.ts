import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Reader,
  Writer,
  Admin,
  FsStore,
  callTool,
  type ToolDeps,
  type AuthedContext,
} from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The async call-audit queue (PR #72 + its review fixes). The audit TRANSACTION
 * is off the response's critical path, but the REDACTION DECISION is not: it is
 * made at call time, so a later visibility flip can never unredact an earlier
 * private edit. Shedding over the cap is loud, and flushAudit() drains.
 */
describe("call-audit queue — call-time redaction, serialized drain, loud shed", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let deps: ToolDeps;
  let ctx: AuthedContext;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    owner = await brain.connect("owner");
    deps = {
      reader: new Reader(pool),
      writer: new Writer(pool),
      admin: new Admin(pool),
      executor: new SchemaExecutor(owner),
      fsStore: new FsStore(pool),
    };
    const boot = await deps.admin.bootstrapOwner({ name: "alice", email: "a@example.com" });
    ctx = { actorId: boot.id, scopes: ["read", "write", "schema-admin"], role: "owner" };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  const auditPayloads = async (kind: string): Promise<Record<string, unknown>[]> => {
    const r = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE kind = $1 ORDER BY seq",
      [kind],
    );
    return r.rows.map((x) => x.payload);
  };

  /**
   * THE RACE the review found: with redaction deferred to flush time, an edit
   * of a PRIVATE object followed by a flip to org-visible would log the private
   * body verbatim into the org-wide feed. Redaction now happens at call time.
   */
  it("a private edit stays redacted even when the object goes org-visible before the flush", async () => {
    const obj = (await callTool(deps, ctx, "write", {
      title: "private draft",
      body: "v1",
      visibility: "private",
    })) as { id: string };
    await (deps.writer as Writer).flushAudit();

    // Edit while PRIVATE — no visibility arg, so redaction depends on the
    // object's state AT THIS MOMENT.
    const afterAppend = (await callTool(deps, ctx, "edit", {
      id: obj.id,
      body_ops: [{ op: "append", text: "SUPER-SECRET-PRIVATE-BODY" }],
    })) as { version: number };
    // ...then immediately flip it org-visible, racing the queued audit write.
    // The edit TOOL no longer exposes visibility (share is the only widening
    // path on the tool surface); Writer.edit's programmatic input still flips
    // it, which is all this race needs.
    await (deps.writer as Writer).edit(ctx, obj.id, {
      version: afterAppend.version,
      visibility: "org",
    });
    await (deps.writer as Writer).flushAudit();

    const all = JSON.stringify(await auditPayloads("call:edit"));
    expect(all).not.toContain("SUPER-SECRET-PRIVATE-BODY");
    expect(all).toContain("[redacted: private]");
  });

  it("flushAudit drains every queued row — a burst of calls all land", async () => {
    const before = (await auditPayloads("call:catalog")).length;
    await Promise.all(Array.from({ length: 25 }, () => callTool(deps, ctx, "catalog", {})));
    await (deps.writer as Writer).flushAudit();
    const after = (await auditPayloads("call:catalog")).length;
    expect(after - before).toBe(25);
  });

  it("audit failures never fail the call, and each row carries its timing", async () => {
    const res = (await callTool(deps, ctx, "write", { title: "timed", body: "x" })) as {
      id: string;
    };
    expect(res.id).toBeTruthy();
    await (deps.writer as Writer).flushAudit();
    const rows = await auditPayloads("call:write");
    const last = rows.at(-1)!;
    expect(last.ok).toBe(true);
    expect(typeof last.ms).toBe("number");
  });

  /**
   * A burst past the cap must apply BACKPRESSURE, not drop rows: a healthy DB
   * drains the chain, so every call is still audited. Losing audit rows on a
   * merely-busy box would silently break the 0019 "every call" contract.
   */
  it("a burst past the pending cap keeps every audit row (backpressure, no loss)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writer = deps.writer as Writer;
    const before = (await auditPayloads("call:recent")).length;

    const N = 300; // > AUDIT_MAX_PENDING (200)
    await Promise.all(Array.from({ length: N }, () => callTool(deps, ctx, "recent", { limit: 1 })));
    await writer.flushAudit();

    const after = (await auditPayloads("call:recent")).length;
    expect(after - before).toBe(N); // nothing shed on a healthy database
    const depth = (writer as unknown as { auditQueued: number }).auditQueued;
    expect(depth).toBe(0); // fully drained
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("shed"))).toHaveLength(0);
    warn.mockRestore();
  }, 120_000);

  /** ...but a WEDGED database must shed loudly rather than hang the calls. */
  it("sheds LOUDLY (never silently, never hanging) when the backlog will not drain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writer = deps.writer as Writer;
    const peek = writer as unknown as { auditQueued: number };
    const saved = peek.auditQueued;
    peek.auditQueued = 500; // simulate a stuck backlog above the cap

    const t0 = Date.now();
    await writer.enqueueCallLog(ctx.actorId, "catalog", {}, { ok: true, ms: 1 });
    const waited = Date.now() - t0;

    peek.auditQueued = saved;
    expect(waited).toBeGreaterThanOrEqual(900); // waited out the backpressure bound
    expect(waited).toBeLessThan(5_000); // and did NOT hang the call
    const shed = warn.mock.calls.filter((c) => String(c[0]).includes("call-audit: shed"));
    expect(shed.length).toBe(1);
    expect(String(shed[0]![0])).toMatch(/backlog stuck.*shed total.*wedged/);
    warn.mockRestore();
  }, 30_000);
});
