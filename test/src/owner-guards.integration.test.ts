import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import {
  toolDescriptors,
  Admin,
  FsStore,
  authenticate,
  callTool,
  Reader,
  Writer,
  type AuthedContext,
  type ToolDeps,
} from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

// Migration 0015: permission tiers (owner/member/viewer) + owner guardrails.
describe("permission tiers + owner guards", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Awaited<ReturnType<FreshBrain["connect"]>>;
  let deps: ToolDeps;
  let ownerCtx: AuthedContext;
  let ownerId: string;

  beforeEach(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    deps = {
      reader: new Reader(pool),
      writer: new Writer(pool),
      admin: new Admin(pool),
      executor: new SchemaExecutor(ownerClient),
      fsStore: new FsStore(pool),
    };
    const boot = await deps.admin.bootstrapOwner({ name: "Owner One", email: "o1@example.com" });
    ownerId = boot.id;
    ownerCtx = await authenticate(pool, `Bearer ${boot.token}`);
  }, 120_000);

  afterEach(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  const mk = (permission: "owner" | "member" | "viewer", name: string) =>
    callTool(deps, ownerCtx, "create_user", {
      name,
      email: `${name.replace(/\s+/g, "").toLowerCase()}@example.com`,
      permission,
    }) as Promise<{ id: string; token: string }>;

  it("create_user requires name, email, and a valid permission", async () => {
    await expect(mk("member", "")).rejects.toThrow(/name is required|invalid/i);
    await expect(
      callTool(deps, ownerCtx, "create_user", {
        name: "No Email",
        email: "",
        permission: "member",
      }),
    ).rejects.toThrow(/email is required|invalid/i);
    await expect(
      callTool(deps, ownerCtx, "create_user", {
        name: "Bad",
        email: "b@x.com",
        permission: "root" as unknown as "member",
      }),
    ).rejects.toThrow();
  });

  it("tiers derive scopes: owner+member both get read+write+schema-admin, viewer=read", async () => {
    // members reshape the schema too (migration 0016) — the only owner-exclusive
    // power is managing people (create_user/revoke_user), gated on the role.
    const owner = await mk("owner", "Owner Two");
    const member = await mk("member", "Member");
    const viewer = await mk("viewer", "Viewer");
    const full = ["read", "write", "schema-admin"];
    expect((await authenticate(pool, `Bearer ${owner.token}`)).scopes).toEqual(full);
    expect((await authenticate(pool, `Bearer ${member.token}`)).scopes).toEqual(full);
    expect((await authenticate(pool, `Bearer ${viewer.token}`)).scopes).toEqual(["read"]);
  });

  it("an owner cannot revoke their own account", async () => {
    await expect(callTool(deps, ownerCtx, "revoke_user", { id: ownerId })).rejects.toThrow(
      /cannot revoke their own account/i,
    );
  });

  it("owners are peers — one owner cannot revoke another owner", async () => {
    const o2 = await mk("owner", "Owner Two");
    await expect(callTool(deps, ownerCtx, "revoke_user", { id: o2.id })).rejects.toThrow(
      /cannot revoke another owner/i,
    );
  });

  it("revoking a non-existent account raises (not a silent success)", async () => {
    await expect(
      callTool(deps, ownerCtx, "revoke_user", { id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }),
    ).rejects.toThrow(/no such account/i);
  });

  it("an owner CAN revoke a member", async () => {
    const m = await mk("member", "Member");
    const res = (await callTool(deps, ownerCtx, "revoke_user", { id: m.id })) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it("only an owner may create users", async () => {
    const member = await mk("member", "Member");
    const mctx = await authenticate(pool, `Bearer ${member.token}`);
    await expect(
      callTool(deps, mctx, "create_user", {
        name: "Sneaky",
        email: "s@example.com",
        permission: "owner",
      }),
    ).rejects.toThrow(/only an owner may create users|refused/i);
  });
});

describe("tools/list is filtered by permission", () => {
  const names = (caller: { role: string; scopes: string[] }) =>
    toolDescriptors(caller).map((t) => t.name);
  const owner = { role: "owner", scopes: ["read", "write", "schema-admin"] };
  const member = { role: "member", scopes: ["read", "write", "schema-admin"] };
  const viewer = { role: "viewer", scopes: ["read"] };

  it("org-admin tools (create_user/revoke_user) are owner-only", () => {
    expect(names(owner)).toEqual(expect.arrayContaining(["create_user", "revoke_user"]));
    expect(names(member)).not.toContain("create_user");
    expect(names(member)).not.toContain("revoke_user");
    expect(names(viewer)).not.toContain("create_user");
  });

  it("members see write + schema tools; viewers see only the read surface", () => {
    expect(names(member)).toEqual(expect.arrayContaining(["write", "define_type", "add_property"]));
    expect(names(viewer)).not.toContain("write");
    expect(names(viewer)).not.toContain("define_type");
    expect(names(viewer)).toEqual(expect.arrayContaining(["search", "get", "catalog", "start"]));
  });
});
