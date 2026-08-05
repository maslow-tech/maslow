import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Admin.liveAuthz: callers must be authorized against
 * their LIVE role+scopes from the DB, not the role baked into an OAuth JWT
 * (stale for up to ACCESS_TTL) or a session cookie.
 * This proves the re-read: a demotion downgrades immediately, a revoke fails
 * closed to null, and a promotion is reflected without re-login.
 */
describe("Admin.liveAuthz — live role/scopes from the DB", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let su: Client; // superuser — only role brain_app is forbidden from mutating accounts.role
  let admin: Admin;
  let alice: string; // owner
  let bob: string; // member

  const setTier = (id: string, role: string, scopes: string[]): Promise<unknown> =>
    su.query("UPDATE accounts SET role = $2, scopes = $3::text[] WHERE id = $1", [
      id,
      role,
      scopes,
    ]);

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    su = await brain.connect("superuser");
    admin = new Admin(pool);
    alice = (await admin.bootstrapOwner({ name: "alice", email: "alice@example.com" })).id;
    bob = (
      await admin.createUser(alice, { name: "bob", email: "bob@example.com", permission: "member" })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await su?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("returns live role + scopes for an active member", async () => {
    const live = await admin.liveAuthz(bob);
    expect(live).not.toBeNull();
    expect(live!.role).toBe("member");
    // a member is write-capable (exact scope set is a product detail; the
    // authz that matters is role + the presence of write)
    expect(live!.scopes).toContain("read");
    expect(live!.scopes).toContain("write");
  });

  it("reflects a demotion immediately (member → viewer) — the stale-JWT hole", async () => {
    await setTier(bob, "viewer", ["read"]);
    const live = await admin.liveAuthz(bob);
    expect(live!.role).toBe("viewer");
    expect(live!.scopes).toEqual(["read"]);
  });

  it("reflects a promotion immediately (viewer → member) — no re-login needed", async () => {
    await setTier(bob, "member", ["read", "write"]);
    const live = await admin.liveAuthz(bob);
    expect(live!.role).toBe("member");
    expect(live!.scopes).toContain("write");
  });

  it("fails closed to null for a revoked account", async () => {
    await admin.revokeAccount(alice, bob);
    expect(await admin.liveAuthz(bob)).toBeNull();
  });

  it("fails closed to null for an unknown account id", async () => {
    expect(await admin.liveAuthz("99999999-9999-4999-8999-999999999999")).toBeNull();
  });
});
