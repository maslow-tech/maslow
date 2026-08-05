import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Reader,
  Writer,
  Admin,
  FsStore,
  callTool,
  toolNames,
  type ToolDeps,
  type AuthedContext,
} from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";

/** 768-dim unit-ish vector with all weight on one axis — cheap cosine anchors. */
function axis(i: number): string {
  const v = new Array(768).fill(0);
  v[i] = 1;
  return `[${v.join(",")}]`;
}

describe("tool-surface v2 · collapsed tools, enriched search, inline links", () => {
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
    ctx = { actorId: SYSTEM, scopes: ["read", "write", "schema-admin"], role: "owner" };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    await brain?.drop();
  });

  it("the surface is exactly the v2 tools", () => {
    expect(toolNames().sort()).toEqual(
      [
        "start",
        "catalog",
        "search",
        "get",
        "list",
        "recent",
        "history",
        "write",
        "edit",
        "share",
        "delete",
        "restore",
        "merge",
        "set_type",
        "define_type",
        "delete_type",
        "add_property",
        "bash",
        "google",
        "microsoft",
        "create_user",
        "revoke_user",
      ].sort(),
    );
  });

  it("connector-gated tools are advertised only to callers the provider is usable by", async () => {
    const { toolDescriptors } = await import("@brain/mcp-tools");
    const caller = { role: "member", scopes: ["read", "write"] };
    const names = (c: Parameters<typeof toolDescriptors>[0]) =>
      toolDescriptors(c).map((t) => t.name);
    // provider not usable (and connectors absent = fail closed) → hidden.
    // Custom connectors (samgov included since its de-hardcoding) are NOT in
    // the static registry — their tools/list gating is covered by the
    // custom-connectors integration suite over /mcp.
    for (const gated of ["google", "microsoft"]) {
      expect(names(caller)).not.toContain(gated);
      expect(names({ ...caller, connectors: new Set<string>() })).not.toContain(gated);
    }
    // usable → advertised
    expect(names({ ...caller, connectors: new Set(["google"]) })).toContain("google");
    expect(names({ ...caller, connectors: new Set(["msgraph"]) })).toContain("microsoft");
    // ungated tools unaffected either way
    expect(names(caller)).toContain("search");
  });

  it("google/microsoft body param advertises an explicit object type", async () => {
    // Regression: body was z.unknown().optional(), which zodToJsonSchema
    // renders as an empty {} schema — no "type" at all. MCP clients that
    // serialize a tool call's args off the advertised schema fall back to
    // JSON-stringifying a field with no declared type, so a caller's
    // {start:{...}, end:{...}} went out as a STRING. The box then
    // JSON.stringify'd that string again before forwarding to Google/Graph
    // (double-encoding), so every Calendar POST failed with Google's
    // "Missing end time" regardless of payload shape. z.record(z.unknown())
    // fixes it by giving clients an explicit type:"object" hint.
    const { toolDescriptors } = await import("@brain/mcp-tools");
    const caller = {
      role: "member",
      scopes: ["read", "write"],
      connectors: new Set(["google", "msgraph"]),
    };
    const descs = toolDescriptors(caller);
    for (const name of ["google", "microsoft"]) {
      const schema = descs.find((t) => t.name === name)!.inputSchema as {
        properties: Record<string, { type?: string }>;
      };
      expect(schema.properties["body"]?.type).toBe("object");
    }
  });

  it("list's where param advertises an explicit object type", async () => {
    // Same bug, different tool: whereSchema was z.any().optional(), also an
    // empty {} schema. Confirmed live: a where clause sent through the
    // connected client came back "malformed where clause" — the where AST
    // went out stringified, same mechanism as the body bug above.
    const { toolDescriptors } = await import("@brain/mcp-tools");
    const descs = toolDescriptors();
    const schema = descs.find((t) => t.name === "list")!.inputSchema as {
      properties: Record<string, { type?: string }>;
    };
    expect(schema.properties["where"]?.type).toBe("object");
  });

  it("props.<ref[]-field>: [ids] is sugar for links — the single biggest cause of write failures", async () => {
    await callTool(deps, ctx, "define_type", {
      name: "todo",
      properties: [
        { name: "done", kind: "bool" },
        { name: "claimed_by", kind: "ref[]", ref_type_name: "todo" },
      ],
    });
    const p1 = (await callTool(deps, ctx, "write", { title: "Assignee One" })) as { id: string };
    const p2 = (await callTool(deps, ctx, "write", { title: "Assignee Two" })) as { id: string };

    // write: props.claimed_by as a plain array of ids must succeed, not throw
    // "is a list — attach members with links on write/edit".
    const t = (await callTool(deps, ctx, "write", {
      type: "todo",
      title: "Ship the thing",
      props: { done: false, claimed_by: [p1.id, p2.id] },
    })) as { id: string };
    const got = (await callTool(deps, ctx, "get", { id: t.id })) as {
      props: Record<string, unknown>;
      links: Array<{ rel: string; id: string }>;
    };
    // ref[] props are never surfaced via get().props (they read from an
    // unwired junction table — pre-existing, separate from this fix); the
    // real relationship data is get().links, same as if the caller had used
    // links:[{rel:"claimed_by", to:...}] by hand
    const claimedIds = got.links.filter((l) => l.rel === "claimed_by").map((l) => l.id);
    expect(claimedIds.sort()).toEqual([p1.id, p2.id].sort());

    // edit: same sugar, additive with any explicit links passed alongside
    const p3 = (await callTool(deps, ctx, "write", { title: "Assignee Three" })) as { id: string };
    const other = (await callTool(deps, ctx, "write", { title: "Related" })) as { id: string };
    const tv = (await callTool(deps, ctx, "get", { id: t.id })) as { version: number };
    await callTool(deps, ctx, "edit", {
      id: t.id,
      version: tv.version,
      props: { claimed_by: [p3.id] },
      links: [{ rel: "about", to: other.id }],
    });
    const got2 = (await callTool(deps, ctx, "get", { id: t.id })) as {
      links: Array<{ rel: string; id: string }>;
    };
    expect(got2.links.some((l) => l.rel === "claimed_by" && l.id === p3.id)).toBe(true);
    expect(got2.links.some((l) => l.rel === "about" && l.id === other.id)).toBe(true);

    // a non-array or non-string-array value still gets the original clear error
    await expect(
      callTool(deps, ctx, "write", {
        type: "todo",
        title: "Bad assignee shape",
        props: { done: false, claimed_by: "not-an-array" },
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      callTool(deps, ctx, "write", {
        type: "todo",
        title: "Bad assignee element",
        props: { done: false, claimed_by: [123] },
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("define_type creates properties inline; a bad property names the fix", async () => {
    const t = (await callTool(deps, ctx, "define_type", {
      name: "project",
      properties: [
        { name: "stage", kind: "enum", enum_values: ["active", "done"] },
        { name: "kickoff", kind: "date" },
      ],
    })) as { type_id: number; properties_added: string[] };
    expect(t.properties_added).toEqual(["stage", "kickoff"]);

    // reserved name mid-list: type survives, error teaches add_property
    await expect(
      callTool(deps, ctx, "define_type", {
        name: "gadget",
        properties: [
          { name: "size", kind: "int" },
          { name: "title", kind: "text" }, // reserved spine column
        ],
      }),
    ).rejects.toMatchObject({ code: "refused" });
    const cat = (await callTool(deps, ctx, "catalog", {})) as {
      types: Array<{ name: string; properties: Array<{ name: string }> }>;
    };
    const gadget = cat.types.find((x) => x.name === "gadget");
    expect(gadget).toBeDefined();
    expect(gadget!.properties.map((p) => p.name)).toEqual(["size"]);
  });

  it("define_type retires/revives a type; retired drops from start, objects stay searchable", async () => {
    await callTool(deps, ctx, "define_type", {
      name: "gizmo",
      properties: [{ name: "serial", kind: "text" }],
    });
    const obj = (await callTool(deps, ctx, "write", {
      type: "gizmo",
      title: "Gizmo Alpha",
      props: { serial: "SN-1" },
    })) as { id: string };

    // retire it
    const ret = (await callTool(deps, ctx, "define_type", { name: "gizmo", visible: false })) as {
      retired?: boolean;
    };
    expect(ret.retired).toBe(true);

    // retired types drop out of the whole agent surface — catalog AND start
    const cat = (await callTool(deps, ctx, "catalog", {})) as {
      types: Array<{ name: string; deprecated?: boolean }>;
    };
    expect(cat.types.find((t) => t.name === "gizmo")).toBeUndefined();
    const start = (await callTool(deps, ctx, "start", {})) as { text: string };
    expect(start.text).not.toContain("gizmo");

    // INVARIANT: an object of a retired type is still searchable
    const hits = (await callTool(deps, ctx, "search", { query: "Gizmo Alpha" })) as Array<{
      id: string;
    }>;
    expect(hits.some((h) => h.id === obj.id)).toBe(true);

    // new writes under a retired type are refused; editing the existing object still works
    await expect(
      callTool(deps, ctx, "write", { type: "gizmo", title: "Gizmo Beta" }),
    ).rejects.toMatchObject({ code: "validation" });
    const ov = (await callTool(deps, ctx, "get", { id: obj.id })) as { version: number };
    await callTool(deps, ctx, "edit", {
      id: obj.id,
      version: ov.version,
      title: "Gizmo Alpha (edited)",
    });

    // revive: back on the menu and writable again
    const rev = (await callTool(deps, ctx, "define_type", { name: "gizmo" })) as {
      revived?: boolean;
    };
    expect(rev.revived).toBe(true);
    const start2 = (await callTool(deps, ctx, "start", {})) as { text: string };
    expect(start2.text).toContain("gizmo");
    const beta = (await callTool(deps, ctx, "write", { type: "gizmo", title: "Gizmo Beta" })) as {
      id: string;
    };
    expect(beta.id).toBeTruthy();

    // the toggle is audited on the timeline
    const ev = await owner.query<{ kind: string }>(
      "SELECT kind FROM events WHERE kind IN ('deprecate_type','restore_type')",
    );
    expect(ev.rows.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["deprecate_type", "restore_type"]),
    );
  });

  it("add_property hides/shows a field; hiding keeps stored values (revive restores them)", async () => {
    const wt = (await callTool(deps, ctx, "define_type", {
      name: "widget",
      properties: [{ name: "color", kind: "text" }],
    })) as { type_id: number };
    const w = (await callTool(deps, ctx, "write", {
      type: "widget",
      title: "W1",
      props: { color: "red" },
    })) as { id: string };

    const hidden = (await callTool(deps, ctx, "add_property", {
      type_id: wt.type_id,
      name: "color",
      visible: false,
    })) as { hidden?: boolean };
    expect(hidden.hidden).toBe(true);

    // catalog flags the field; get no longer surfaces the value; new writes to it are refused
    const cat = (await callTool(deps, ctx, "catalog", {})) as {
      types: Array<{ name: string; properties: Array<{ name: string; deprecated?: boolean }> }>;
    };
    const colorProp = cat.types
      .find((t) => t.name === "widget")!
      .properties.find((p) => p.name === "color");
    expect(colorProp?.deprecated).toBe(true);
    let got = (await callTool(deps, ctx, "get", { id: w.id })) as {
      props: Record<string, unknown>;
    };
    expect(got.props.color).toBeUndefined();
    await expect(
      callTool(deps, ctx, "write", { type: "widget", title: "W2", props: { color: "blue" } }),
    ).rejects.toMatchObject({ code: "validation" });

    // revive: the value was never lost
    const shown = (await callTool(deps, ctx, "add_property", {
      type_id: wt.type_id,
      name: "color",
      visible: true,
    })) as { revived?: boolean };
    expect(shown.revived).toBe(true);
    got = (await callTool(deps, ctx, "get", { id: w.id })) as { props: Record<string, unknown> };
    expect(got.props.color).toBe("red");

    // hiding a field that doesn't exist is a clear error
    await expect(
      callTool(deps, ctx, "add_property", { type_id: wt.type_id, name: "nope", visible: false }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("write attaches links inline (both directions), atomically", async () => {
    const a = (await callTool(deps, ctx, "write", { title: "Anchor" })) as { id: string };
    const b = (await callTool(deps, ctx, "write", {
      title: "Satellite",
      links: [
        { rel: "orbits", to: a.id },
        { rel: "watches", from: a.id },
      ],
    })) as { id: string };

    const got = (await callTool(deps, ctx, "get", { id: b.id })) as {
      links: Array<{ rel: string; id: string }>;
      backlinks: Array<{ rel: string; id: string }>;
      hidden_from_you: number;
    };
    expect(got.links.some((l) => l.rel === "orbits" && l.id === a.id)).toBe(true);
    expect(got.backlinks.some((l) => l.rel === "watches" && l.id === a.id)).toBe(true);
    expect(got.hidden_from_you).toBe(0);

    // a dead link target fails the WHOLE create — nothing is written
    await expect(
      callTool(deps, ctx, "write", {
        title: "Ghost rider",
        links: [{ rel: "haunts", to: "00000000-0000-0000-0000-00000000dead" }],
      }),
    ).rejects.toMatchObject({ code: "validation" });
    const hits = (await callTool(deps, ctx, "search", { query: "Ghost rider" })) as unknown[];
    expect(hits.length).toBe(0);
  });

  it("edit adds and removes edges via links/unlinks — WITHOUT bumping the version", async () => {
    const x = (await callTool(deps, ctx, "write", { title: "X node" })) as {
      id: string;
      version: number;
    };
    const y = (await callTool(deps, ctx, "write", { title: "Y node" })) as { id: string };
    const afterLink = (await callTool(deps, ctx, "edit", {
      id: x.id,
      links: [{ rel: "pairs_with", to: y.id }],
    })) as { version: number };
    // edges are not object state: a links-only edit must not version-conflict
    // concurrent editors of the object
    expect(afterLink.version).toBe(x.version);
    let got = (await callTool(deps, ctx, "get", { id: x.id })) as {
      links: Array<{ rel: string }>;
      version: number;
    };
    expect(got.links.some((l) => l.rel === "pairs_with")).toBe(true);
    expect(got.version).toBe(x.version);
    await callTool(deps, ctx, "edit", { id: x.id, unlinks: [{ rel: "pairs_with", to: y.id }] });
    got = (await callTool(deps, ctx, "get", { id: x.id })) as {
      links: Array<{ rel: string }>;
      version: number;
    };
    expect(got.links.some((l) => l.rel === "pairs_with")).toBe(false);
  });

  it("get batches ids in one call; unknown ids come back as not_found rows", async () => {
    const a = (await callTool(deps, ctx, "write", { title: "Batch A" })) as { id: string };
    const b = (await callTool(deps, ctx, "write", { title: "Batch B" })) as { id: string };
    const rows = (await callTool(deps, ctx, "get", {
      ids: [a.id, b.id, "00000000-0000-0000-0000-00000000beef"],
    })) as Array<{ id: string; title?: string; not_found?: boolean }>;
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.not_found)).toHaveLength(1);
    expect(rows.find((r) => r.id === a.id)?.title).toBe("Batch A");
  });

  it("search hits carry type/snippet/connections/version; multi-query groups", async () => {
    await callTool(deps, ctx, "write", {
      title: "Northwind Dental",
      body: "A twelve-location dental group in Columbus switching software in November.",
    });
    const hits = (await callTool(deps, ctx, "search", { query: "dental Columbus" })) as Array<{
      type: string | null;
      title: string;
      snippet: string;
      connections: number;
      version: number;
      match: string;
    }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toMatch(/dental|Columbus/i);
    expect(hits[0]!.match).toBe("fulltext");
    expect(typeof hits[0]!.connections).toBe("number");
    expect(typeof hits[0]!.version).toBe("number");

    const grouped = (await callTool(deps, ctx, "search", {
      queries: ["Northwind", "no_such_word_anywhere_xyz"],
    })) as Array<{ query: string; hits: unknown[] }>;
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.hits.length).toBeGreaterThan(0);
  });

  it("zero full-text hits falls back to fuzzy title match, flagged", async () => {
    // 'Northwin' is a substring, not a word — FTS misses, fuzzy catches
    const hits = (await callTool(deps, ctx, "search", { query: "Northwin" })) as Array<{
      title: string;
      match: string;
    }>;
    expect(hits.some((h) => h.title === "Northwind Dental")).toBe(true);
    expect(hits[0]!.match).toBe("title_fuzzy");
  });

  it("semantic arm: vector-close objects surface without sharing words", async () => {
    const w = (await callTool(deps, ctx, "write", {
      title: "Tooth clinic operations",
      body: "Practice management and patient intake.",
    })) as { id: string };
    const far = (await callTool(deps, ctx, "write", {
      title: "Rocket telemetry",
      body: "Downlink parsing for launch vehicles.",
    })) as { id: string };
    // The real embed sweep writes object_chunks as brain_system (retrieval-boot
    // SET ROLE brain_system), because a raw owner connection holds no tags and
    // — since the 0057 tag model — cannot satisfy object_chunks' EXISTS-on-
    // objects WITH CHECK for any object (org is no longer an unconditional
    // visible flag). Mirror that here rather than relying on the old semantics.
    await owner.query("SET ROLE brain_system");
    await owner.query(
      `INSERT INTO object_chunks (object_id, chunk_ix, text, embedding, source_version, chunker_version)
       VALUES ($1, 0, 'Practice management and patient intake.', $2::vector, 1, 1)`,
      [w.id, axis(3)],
    );
    await owner.query(
      `INSERT INTO object_chunks (object_id, chunk_ix, text, embedding, source_version, chunker_version)
       VALUES ($1, 0, 'Downlink parsing for launch vehicles.', $2::vector, 1, 1)`,
      [far.id, axis(700)],
    );
    await owner.query("RESET ROLE");
    const semanticReader = new Reader(pool, {
      embedQuery: () => Promise.resolve(JSON.parse(axis(3)) as number[]),
    });
    const hits = await semanticReader.search(
      { actorId: SYSTEM },
      "dentistry", // no lexical overlap with either object
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!["id"]).toBe(w.id);
    expect(hits[0]!["match"]).toBe("semantic");
  });

  it("list folds count (with_total) and the trash (deleted:true)", async () => {
    const n = (await callTool(deps, ctx, "write", {
      type: "project",
      title: "Doomed project",
      props: { stage: "active" },
    })) as { id: string };
    const page = (await callTool(deps, ctx, "list", {
      type: "project",
      with_total: true,
    })) as { items: unknown[]; total: number };
    expect(page.total).toBeGreaterThanOrEqual(1);

    await callTool(deps, ctx, "delete", { id: n.id });
    // whole trash (untyped path) and typed trash both use the page shape
    const trash = (await callTool(deps, ctx, "list", { deleted: true })) as {
      items: Array<{ id: string }>;
    };
    expect(trash.items.some((t) => t.id === n.id)).toBe(true);
    const typedTrash = (await callTool(deps, ctx, "list", {
      type: "project",
      deleted: true,
      with_total: true,
    })) as { items: Array<{ id: string }>; total: number };
    expect(typedTrash.items.some((t) => t.id === n.id)).toBe(true);
    expect(typedTrash.total).toBeGreaterThanOrEqual(1);
    await callTool(deps, ctx, "restore", { id: n.id });
  });

  it("fails loud when where/sort/total is sent to an untyped trash/visibility view", async () => {
    // The whole-trash and untyped-visibility views are recency/limit-only — a
    // where/sort/cursor/with_total there used to be silently ignored (unfiltered
    // rows). Now it teaches "add a type" instead of returning wrong data.
    await expect(
      callTool(deps, ctx, "list", {
        deleted: true,
        where: { field: "title", op: "eq", value: "x" },
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      callTool(deps, ctx, "list", { visibility: "private", sort: { field: "title", dir: "asc" } }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      callTool(deps, ctx, "list", { deleted: true, with_total: true }),
    ).rejects.toMatchObject({ code: "validation" });
    // …but the plain untyped forms still work (recency, limit-only).
    const trash = (await callTool(deps, ctx, "list", { deleted: true })) as { items: unknown[] };
    expect(Array.isArray(trash.items)).toBe(true);
    const mine = (await callTool(deps, ctx, "list", { visibility: "private" })) as {
      items: unknown[];
    };
    expect(Array.isArray(mine.items)).toBe(true);
  });

  it("list/count where can filter a ref[] field — the single biggest cause of list failures", async () => {
    // Regression: ref[] properties (task.claimed_by, work_item.claimed_by) were
    // simply absent from the where/sort resolver, so "list my tasks" (filter
    // by claimed_by) always threw "unknown or non-filterable field" — the
    // dominant cause of `list` failures in a live 21h sample. Same family as
    // the write-side ref[]-via-props fix: the catalog shows claimed_by right
    // alongside scalar props, so filtering by it is the obvious thing to try.
    await callTool(deps, ctx, "define_type", {
      name: "chore",
      properties: [{ name: "claimed_by", kind: "ref[]", ref_type_name: "chore" }],
    });
    const alice = (await callTool(deps, ctx, "write", { title: "Alice" })) as { id: string };
    const bob = (await callTool(deps, ctx, "write", { title: "Bob" })) as { id: string };
    const aliceChore = (await callTool(deps, ctx, "write", {
      type: "chore",
      title: "Alice's chore",
      props: { claimed_by: [alice.id] },
    })) as { id: string };
    const bobChore = (await callTool(deps, ctx, "write", {
      type: "chore",
      title: "Bob's chore",
      props: { claimed_by: [bob.id] },
    })) as { id: string };
    const unclaimedChore = (await callTool(deps, ctx, "write", {
      type: "chore",
      title: "Nobody's chore",
    })) as { id: string };

    const eqPage = (await callTool(deps, ctx, "list", {
      type: "chore",
      where: { field: "claimed_by", op: "eq", value: alice.id },
    })) as { items: Array<{ id: string }> };
    expect(eqPage.items.map((i) => i.id)).toEqual([aliceChore.id]);

    const inPage = (await callTool(deps, ctx, "list", {
      type: "chore",
      where: { field: "claimed_by", op: "in", value: [alice.id, bob.id] },
    })) as { items: Array<{ id: string }> };
    expect(inPage.items.map((i) => i.id).sort()).toEqual([aliceChore.id, bobChore.id].sort());

    // list's with_total uses the same count() path as the standalone tool did
    const withTotal = (await callTool(deps, ctx, "list", {
      type: "chore",
      where: { field: "claimed_by", op: "eq", value: alice.id },
      with_total: true,
    })) as { total: number };
    expect(withTotal.total).toBe(1);

    // unclaimed/other chores never match
    expect(eqPage.items.some((i) => i.id === unclaimedChore.id)).toBe(false);
    expect(eqPage.items.some((i) => i.id === bobChore.id)).toBe(false);

    // sorting by a ref[] field is still a clear error, not a crash
    await expect(
      callTool(deps, ctx, "list", { type: "chore", sort: { field: "claimed_by" } }),
    ).rejects.toMatchObject({ code: "validation" });
    // a bad op/value shape on a ref[] field is still a clear error
    await expect(
      callTool(deps, ctx, "list", {
        type: "chore",
        where: { field: "claimed_by", op: "gt", value: alice.id },
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("history caps revisions at 20 with truncated snapshots", async () => {
    const n = (await callTool(deps, ctx, "write", {
      title: "Busy note",
      body: "start ".repeat(200), // > 500 chars so truncation is observable
    })) as { id: string };
    for (let i = 0; i < 24; i++) {
      await callTool(deps, ctx, "edit", {
        id: n.id,
        body_ops: [{ op: "append", text: `line ${i}\n` }],
      });
    }
    const h = (await callTool(deps, ctx, "history", { id: n.id })) as {
      versions: Array<{ snapshot: { body: string } }>;
    };
    expect(h.versions.length).toBeLessThanOrEqual(20);
    expect(h.versions[0]!.snapshot.body.length).toBeLessThanOrEqual(500);
  });
});
