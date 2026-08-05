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
  type ReadContext,
  type WriteContext,
} from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const RCTX: ReadContext = { actorId: SYSTEM };
const WCTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };

/**
 * The 2026-07-09 dream findings on the tool surface:
 *  - recent: after_seq forward pagination (the dream resumes from a high-water mark)
 *  - recent: kinds:'mutations' filter + max_seq (self-pollution-proof high-water mark)
 *  - recent: summary mode + target title/type on mutation events
 *  - get: short-id prefix resolution + did-you-mean hint on not_found
 */
describe("dream findings · recent pagination + summary, get did-you-mean", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let owner: Client;
  let deps: ToolDeps;
  let ctx: AuthedContext;
  let reader: Reader;
  let writer: Writer;
  let watcher: ReadContext; // a second member — must not see private content
  let taskId: string;
  let noteId: string;
  let privateId: string;

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    owner = await brain.connect("owner");
    reader = new Reader(pool);
    writer = new Writer(pool);
    const admin = new Admin(pool);
    deps = {
      reader,
      writer,
      admin,
      executor: new SchemaExecutor(owner),
      fsStore: new FsStore(pool),
    };
    ctx = { actorId: SYSTEM, scopes: ["read", "write", "schema-admin"], role: "owner" };

    const alice = await admin.bootstrapOwner({ name: "alice", email: "owner@example.com" });
    const m = await admin.createUser(alice.id, {
      name: "Watcher",
      email: "watcher@example.com",
      permission: "member",
    });
    watcher = { actorId: m.id };

    await deps.executor.defineType({ name: "task" }, SYSTEM);
    // Explicitly org: the watcher opens this object in the hop-2 test, and
    // default-private (tag governance wave 2) would 404 it for them.
    taskId = (
      await writer.write(WCTX, {
        type: "task",
        title: "ship the fix",
        body: "soon",
        visibility: "org",
      })
    ).id;
    noteId = (await writer.write(WCTX, { title: "plain note", body: "org-visible text" })).id;
    for (let i = 0; i < 6; i++) {
      await writer.write(WCTX, { title: `filler ${i}`, body: `filler body ${i}` });
    }
    privateId = (
      await writer.write(WCTX, { title: "secret plan", body: "sssh", visibility: "private" })
    ).id;

    // One real audited call so the feed contains a 'call:*' event.
    await callTool(deps, ctx, "search", { query: "filler" });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  // ---- after_seq: forward pagination ------------------------------------

  it("after_seq pages forward in chronological order and resumes past the page", async () => {
    const p1 = await reader.recent(RCTX, { afterSeq: 0, limit: 5 });
    const seqs1 = p1.events.map((e) => Number(e.seq));
    expect(seqs1).toHaveLength(5);
    expect(seqs1).toEqual([...seqs1].sort((a, b) => a - b));
    expect(seqs1[0]).toBeGreaterThan(0);
    expect(p1.nextSeq).toBe(seqs1[4]);

    const p2 = await reader.recent(RCTX, { afterSeq: p1.nextSeq!, limit: 5 });
    const seqs2 = p2.events.map((e) => Number(e.seq));
    expect(seqs2.length).toBeGreaterThan(0);
    expect(Math.min(...seqs2)).toBeGreaterThan(seqs1[4]!);
  });

  it("after_seq at the tip returns no events and a null nextSeq", async () => {
    const tipSeq = (await reader.recent(RCTX, { limit: 1 })).max_seq as number;
    const tip = await reader.recent(RCTX, { afterSeq: tipSeq, limit: 5 });
    expect(tip.events).toHaveLength(0);
    expect(tip.nextSeq).toBeNull();
  });

  it("rejects since_seq and after_seq together", async () => {
    await expect(reader.recent(RCTX, { sinceSeq: 10, afterSeq: 1 })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      callTool(deps, ctx, "recent", { since_seq: 10, after_seq: 1 }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  // ---- kinds filter + max_seq --------------------------------------------

  it("call:* audit events are opt-in via kinds:'all' (the default excludes them)", async () => {
    const all = await reader.recent(RCTX, { kinds: "all", limit: 200 });
    expect(all.events.some((e) => String(e.kind).startsWith("call:"))).toBe(true);

    const muts = await reader.recent(RCTX, { limit: 200 });
    expect(muts.events.length).toBeGreaterThan(0);
    expect(muts.events.some((e) => String(e.kind).startsWith("call:"))).toBe(false);
    expect(muts.events.some((e) => e.kind === "create")).toBe(true);
  });

  it("returns max_seq as an authoritative high-water mark on every page", async () => {
    const r = await reader.recent(RCTX, { limit: 1 });
    expect(typeof r.max_seq).toBe("number");
    expect(r.max_seq).toBeGreaterThanOrEqual(Number(r.events[0]!.seq));

    // A deep backward page still reports the same current tip.
    const paged = await reader.recent(RCTX, { sinceSeq: 5, limit: 1 });
    expect(paged.max_seq).toBe(r.max_seq);
  });

  // ---- mutation-event enrichment ------------------------------------------

  it("stamps target_title and target_type on mutation events", async () => {
    const muts = await reader.recent(RCTX, { kinds: "mutations", limit: 200 });
    const created = muts.events.find((e) => e.kind === "create" && e.target === taskId);
    expect(created).toBeDefined();
    expect(created!.target_title).toBe("ship the fix");
    expect(created!.target_type).toBe("task");

    const note = muts.events.find((e) => e.kind === "create" && e.target === noteId);
    expect(note).toBeDefined();
    expect(note!.target_title).toBe("plain note");
    expect(note!.target_type).toBeNull();
  });

  it("stamps schema_type on schema events so the feed says WHICH type changed", async () => {
    const muts = await reader.recent(RCTX, { kinds: "mutations", limit: 200 });
    const defined = muts.events.find((e) => e.kind === "define_type");
    expect(defined).toBeDefined();
    expect(defined!.schema_type).toBe("task");
    // ...and only schema events carry the field — no null noise elsewhere.
    const created = muts.events.find((e) => e.kind === "create");
    expect(created).toBeDefined();
    expect("schema_type" in created!).toBe(false);
  });

  it("never leaks a private object's title through event enrichment", async () => {
    const mine = await reader.recent(RCTX, { kinds: "mutations", limit: 200 });
    const myEv = mine.events.find((e) => e.kind === "create" && e.target === privateId);
    expect(myEv).toBeDefined();
    expect(myEv!.target_title).toBe("secret plan"); // creator sees it

    const theirs = await reader.recent(watcher, { kinds: "mutations", limit: 200 });
    const theirEv = theirs.events.find((e) => e.kind === "create" && e.target === privateId);
    expect(theirEv).toBeDefined(); // the event row itself is org-visible…
    expect(theirEv!.target_title).toBeNull(); // …but the private title is not
    expect(theirEv!.target_type).toBeNull();
  });

  // ---- summary mode --------------------------------------------------------

  it("summary:true drops payloads and keeps one-line triage fields", async () => {
    // kinds:'all' — the call:* triage fields under test are on audit rows,
    // which the default (content-only) view hides.
    const s = await reader.recent(RCTX, { summary: true, kinds: "all", limit: 200 });
    expect(s.events.length).toBeGreaterThan(0);
    expect(s.events.every((e) => !("payload" in e))).toBe(true);

    const call = s.events.find((e) => String(e.kind).startsWith("call:"));
    expect(call).toBeDefined();
    expect(call!.ok).toBe(true);
    expect(typeof call!.ms).toBe("number");

    const created = s.events.find((e) => e.kind === "create" && e.target === taskId);
    expect(created).toBeDefined();
    expect(created!.target_title).toBe("ship the fix");
    expect(created!.target_type).toBe("task");
  });

  // ---- get: short ids + did-you-mean ---------------------------------------

  it("getMany on an unambiguous truncated id RESOLVES to the one object", async () => {
    const trunc = taskId.slice(0, 13);
    const got = await reader.getMany(RCTX, [trunc]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: taskId, title: "ship the fix" });
  });

  it("a truncated id of NOTHING still answers not_found (no hint to give)", async () => {
    // 12 hex chars sharing no live object's prefix — resolution finds zero.
    const ghost = "ffffffffffff";
    await expect(reader.get(RCTX, ghost)).rejects.toMatchObject({ code: "not_found" });
  });

  it("getMany on a full-but-wrong uuid hints ids sharing the prefix", async () => {
    const wrong = taskId.slice(0, -1) + (taskId.endsWith("0") ? "1" : "0");
    const misses = await reader.getMany(RCTX, [wrong]);
    expect(misses[0]!.not_found).toBe(true);
    expect(misses[0]!.did_you_mean).toContain(taskId);
  });

  it("single get on an unambiguous truncated id resolves to the full object", async () => {
    const trunc = taskId.slice(0, 13);
    const got = await reader.get(RCTX, trunc);
    expect(got).toMatchObject({ id: taskId, title: "ship the fix" });
  });

  it("prefix resolution is RLS-scoped: a private id never resolves for others", async () => {
    const trunc = privateId.slice(0, 13);
    const mine = await reader.getMany(RCTX, [trunc]);
    expect(mine[0]).toMatchObject({ id: privateId, title: "secret plan" }); // creator resolves

    // For anyone else the prefix resolves to nothing AND hints nothing — a
    // short id must not confirm a private object exists.
    const theirs = await reader.getMany(watcher, [trunc]);
    expect(theirs[0]!.not_found).toBe(true);
    const hinted = (theirs[0]!.did_you_mean ?? []) as string[];
    expect(hinted).not.toContain(privateId);
  });

  // ---- review hardening (PR #70 code-review findings) ----------------------

  it("rejects fractional seq params as validation errors, not SQL errors", async () => {
    await expect(callTool(deps, ctx, "recent", { after_seq: 10.5 })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(callTool(deps, ctx, "recent", { since_seq: 3.7 })).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("rejects prefixes that are not a real uuid head (dashes inside the first 8)", async () => {
    await expect(callTool(deps, ctx, "get", { id: "a1b2-c3d4" })).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("stamps target_deleted so a tombstoned target is not mistaken for live", async () => {
    const doomed = await writer.write(WCTX, { title: "doomed", body: "soon gone" });
    await writer.softDelete(WCTX, doomed.id);
    const r = await reader.recent(RCTX, { kinds: "mutations", limit: 200 });
    const ev = r.events.find((e) => e.kind === "create" && e.target === doomed.id);
    expect(ev).toBeDefined();
    expect(ev!.target_deleted).toBe(true);
    expect(ev!.target_title).toBe("doomed");
    const live = r.events.find((e) => e.kind === "create" && e.target === taskId);
    expect(live!.target_deleted).toBe(false);
  });

  it("get neighbors:true maps hop 2 in one call, RLS-scoped", async () => {
    // Chain: task ← about ← mid ← about ← far. get(task, neighbors) must
    // surface far (hop 2) attributed via mid, without a second call.
    const mid = await writer.write(WCTX, {
      title: "mid node",
      visibility: "org",
      links: [{ rel: "about", to: taskId }],
    });
    const far = await writer.write(WCTX, {
      title: "far node",
      visibility: "org",
      links: [{ rel: "about", to: mid.id }],
    });
    const secret = await writer.write(WCTX, {
      title: "secret hop2",
      visibility: "private",
      links: [{ rel: "about", to: mid.id }],
    });

    const got = (await callTool(deps, ctx, "get", { id: taskId, neighbors: true })) as {
      neighborhood: Array<{ id: string; via: string; rels: string[] }>;
    };
    const hop2 = got.neighborhood.find((n) => n.id === far.id);
    expect(hop2).toBeDefined();
    expect(hop2!.via).toBe(mid.id);
    expect(hop2!.rels).toContain("about");

    // The watcher can't see the private hop-2 object — it must not join.
    const theirs = (await callTool(deps, { ...ctx, actorId: watcher.actorId }, "get", {
      id: taskId,
      neighbors: true,
    })) as { neighborhood: Array<{ id: string }> };
    expect(theirs.neighborhood.some((n) => n.id === secret.id)).toBe(false);

    // Batch + neighbors is a teaching error, not a silent ignore.
    await expect(
      callTool(deps, ctx, "get", { ids: [taskId], neighbors: true }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("history resolves a short id like get does (A/B agent-eval papercut)", async () => {
    const got = (await callTool(deps, ctx, "history", { id: taskId.slice(0, 13) })) as {
      id: string;
      events: unknown[];
    };
    expect(got.id).toBe(taskId);
    expect(got.events.length).toBeGreaterThan(0);
  });

  it("the get tool resolves truncated ids and rejects garbage", async () => {
    const trunc = taskId.slice(0, 13);
    const res = (await callTool(deps, ctx, "get", { ids: [trunc] })) as Array<
      Record<string, unknown>
    >;
    expect(res[0]!.id).toBe(taskId);
    expect(res[0]!.not_found).toBeUndefined();

    await expect(callTool(deps, ctx, "get", { id: "abc" })).rejects.toMatchObject({
      code: "validation",
    });
  });
});
