import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const SYSTEM = "00000000-0000-0000-0000-000000000000";

/**
 * 0019 full tool-call audit: EVERY call (reads included) appends one
 * 'call:<tool>' event, so the activity log shows everything. The one hard rule
 * is that a private object's content must never leak into the org-wide feed —
 * its args are redacted while org-visible work is logged in full.
 */
describe("call audit (0019) — logs every tool, redacts private content", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let deps: ToolDeps;
  let ctx: AuthedContext;
  let aliceId: string;

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
      // Present so dynamic `<slug>_fetch` names synthesize a def (validation
      // + audit run); the fetch itself is not under test here.
      custom: {
        fetch: async () => {
          throw new Error("custom connector not wired in this harness");
        },
      },
    };
    aliceId = (await deps.admin.bootstrapOwner({ name: "alice", email: "a@example.com" })).id;
    ctx = { actorId: SYSTEM, scopes: ["read", "write", "schema-admin"], role: "owner" };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  async function callEvents(): Promise<Array<{ kind: string; payload: Record<string, unknown> }>> {
    // Audit writes are queued off the call's critical path — settle them
    // before reading the feed.
    await (deps.writer as Writer).flushAudit();
    const r = await pool.query<{ kind: string; payload: Record<string, unknown> }>(
      "SELECT kind, payload FROM events WHERE kind LIKE 'call:%' ORDER BY seq",
    );
    return r.rows;
  }

  it("a read (start) is logged as a call event", async () => {
    await callTool(deps, ctx, "start", {});
    const ev = await callEvents();
    expect(ev.some((e) => e.kind === "call:start")).toBe(true);
  });

  it("an org-visible write logs its content in full", async () => {
    await callTool(deps, ctx, "write", {
      title: "Q3 roadmap",
      body: "ship the fleet console",
      visibility: "org",
    });
    const ev = await callEvents();
    const w = ev.reverse().find((e) => e.kind === "call:write")!;
    const args = w.payload.args as Record<string, unknown>;
    expect(args.title).toBe("Q3 roadmap");
    expect(args.body).toBe("ship the fleet console"); // org content kept
    expect(w.payload.ok).toBe(true);
  });

  it("a PRIVATE write redacts content, sharing list, and links from the feed", async () => {
    const other = (await callTool(deps, ctx, "write", {
      title: "colleague",
      visibility: "org",
    })) as {
      id: string;
    };
    await callTool(deps, ctx, "write", {
      title: "my therapy notes",
      body: "deeply personal contents",
      visibility: "private",
      shared_with: [aliceId],
      links: [{ rel: "about", to: other.id }],
    });
    const ev = await callEvents();
    const w = ev
      .reverse()
      .find((e) => e.kind === "call:write" && (e.payload.args as any).visibility === "private")!;
    const args = w.payload.args as Record<string, unknown>;
    expect(args.title).toBe("[redacted: private]");
    expect(args.body).toBe("[redacted: private]");
    expect(args.shared_with).toBe("[redacted: private]"); // sharing graph is private too
    expect(args.links).toBe("[redacted: private]"); // relationships are private too
    // and none of it appears anywhere in the org-wide feed
    const all = JSON.stringify(await callEvents());
    expect(all).not.toContain("deeply personal contents");
    expect(all).not.toContain("my therapy notes");
  });

  it("search query text and list where-filters are dropped from the feed", async () => {
    await callTool(deps, ctx, "search", { query: "secret acquisition target" });
    await callTool(deps, ctx, "list", {
      type: "note",
      where: { field: "title", op: "contains", value: "confidential codename" },
    }).catch(() => undefined); // type may not exist; we only care about what got logged
    const all = JSON.stringify(await callEvents());
    expect(all).not.toContain("secret acquisition target");
    expect(all).not.toContain("confidential codename");
    const ev = await callEvents();
    const s = ev.reverse().find((e) => e.kind === "call:search")!;
    expect((s.payload.args as Record<string, unknown>).query).toBe("[redacted]");
  });

  it("create_user does not log the new member's email", async () => {
    await callTool(deps, ctx, "create_user", {
      name: "Dana",
      email: "dana@example.com",
      permission: "member",
    }).catch(() => undefined);
    const all = JSON.stringify(await callEvents());
    expect(all).not.toContain("dana@example.com");
  });

  it("editing an already-private object also redacts (no visibility arg needed)", async () => {
    const res = (await callTool(deps, ctx, "write", {
      title: "secret plan",
      body: "v1",
      visibility: "private",
    })) as { id: string };
    await callTool(deps, ctx, "edit", {
      id: res.id,
      body_ops: [{ op: "append", text: "SENSITIVE APPENDED TEXT" }],
    });
    const all = JSON.stringify(await callEvents());
    expect(all).not.toContain("SENSITIVE APPENDED TEXT");
  });

  it("google/microsoft/samgov_fetch calls redact connector content, keep path/method", async () => {
    // The connector isn't wired into this test harness (no d.google/microsoft/
    // samgov), so each call throws — but logCall runs in callTool's `finally`
    // regardless of success, which is exactly what we're testing: the audit
    // trail for a member's mailbox/calendar/query content, not whether the
    // call itself succeeds.
    await callTool(deps, ctx, "google", {
      action: "send",
      to: "someone@example.com",
      subject: "confidential merger memo",
      text: "the acquisition closes friday",
    }).catch(() => undefined);
    await callTool(deps, ctx, "google", {
      path: "/calendar/v3/calendars/primary/events",
      method: "POST",
      body: { summary: "board meeting", start: { dateTime: "2026-08-01T10:00:00-04:00" } },
    }).catch(() => undefined);
    await callTool(deps, ctx, "microsoft", {
      path: "/me/events",
      method: "POST",
      body: { subject: "layoffs planning" },
    }).catch(() => undefined);
    await callTool(deps, ctx, "samgov_fetch", {
      path: "/opportunities/v2/search",
      params: { title: "classified contract codename" },
    }).catch(() => undefined);

    const ev = await callEvents();
    const all = JSON.stringify(ev);
    expect(all).not.toContain("someone@example.com");
    expect(all).not.toContain("confidential merger memo");
    expect(all).not.toContain("the acquisition closes friday");
    expect(all).not.toContain("board meeting");
    expect(all).not.toContain("layoffs planning");
    expect(all).not.toContain("classified contract codename");

    const send = ev.find(
      (e) =>
        e.kind === "call:google" && (e.payload.args as Record<string, unknown>).action === "send",
    )!;
    const sendArgs = send.payload.args as Record<string, unknown>;
    expect(sendArgs.to).toBe("[redacted: connector]");
    expect(sendArgs.subject).toBe("[redacted: connector]");
    expect(sendArgs.text).toBe("[redacted: connector]");

    const cal = ev.find(
      (e) =>
        e.kind === "call:google" &&
        typeof (e.payload.args as Record<string, unknown>).path === "string" &&
        ((e.payload.args as Record<string, unknown>).path as string).includes("calendar"),
    )!;
    const calArgs = cal.payload.args as Record<string, unknown>;
    expect(calArgs.body).toBe("[redacted: connector]");
    expect(calArgs.path).toBe("/calendar/v3/calendars/primary/events"); // endpoint stays — audit trail
    expect(calArgs.method).toBe("POST");

    const ms = ev.find((e) => e.kind === "call:microsoft")!;
    expect((ms.payload.args as Record<string, unknown>).body).toBe("[redacted: connector]");
    expect((ms.payload.args as Record<string, unknown>).path).toBe("/me/events");

    const sg = ev.find((e) => e.kind === "call:samgov_fetch")!;
    expect((sg.payload.args as Record<string, unknown>).params).toBe("[redacted: connector]");
    expect((sg.payload.args as Record<string, unknown>).path).toBe("/opportunities/v2/search");
  });

  it("a connector call that fails as DATA (not a throw) is logged with ok:false + error", async () => {
    // google/microsoft/samgov_fetch report failure as {successful:false,
    // error} instead of throwing (so the caller gets a teaching message, not
    // a hard MCP error) — so without this mapping, call:google never shows
    // ok:false even while a bug makes every Calendar POST fail. Stub a
    // google connector that fails this way and confirm the audit log now
    // catches it.
    const failingDeps: ToolDeps = {
      ...deps,
      google: {
        doctrine: async () => ({ successful: true, data: {} }),
        call: async () => ({
          successful: false,
          data: null,
          error: "Google returned 400. Missing end time.",
        }),
        searchMail: async () => ({ successful: true, data: {} }),
        readMail: async () => ({ successful: true, data: {} }),
        send: async () => ({ successful: true, data: {} }),
      },
    };
    await callTool(failingDeps, ctx, "google", {
      path: "/calendar/v3/calendars/primary/events/ok-flag-marker",
      method: "POST",
      body: { summary: "x" },
    });
    const ev = await callEvents();
    const failed = ev.find(
      (e) =>
        e.kind === "call:google" &&
        (e.payload.args as Record<string, unknown>).path ===
          "/calendar/v3/calendars/primary/events/ok-flag-marker",
    )!;
    expect(failed.payload.ok).toBe(false);
    expect(String(failed.payload.error)).toContain("Missing end time");

    // a connector call that DOES succeed as data still logs ok:true
    await callTool(failingDeps, ctx, "google", { action: "search_mail", q: "x" });
    const ev2 = await callEvents();
    const succeeded = ev2.find(
      (e) =>
        e.kind === "call:google" &&
        (e.payload.args as Record<string, unknown>).action === "search_mail",
    )!;
    expect(succeeded.payload.ok).toBe(true);
  });

  it("a well-formed call that fails at runtime is logged with ok:false + error", async () => {
    // valid args (type is any string) but the type does not exist → handler throws.
    await expect(
      callTool(deps, ctx, "write", { type: "does_not_exist", title: "x" }),
    ).rejects.toThrow();
    const ev = await callEvents();
    const failed = ev.reverse().find((e) => e.kind === "call:write" && e.payload.ok === false);
    expect(failed).toBeTruthy();
    expect(typeof failed!.payload.error).toBe("string");
  });
});
