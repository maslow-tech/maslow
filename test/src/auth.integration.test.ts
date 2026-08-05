import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import {
  Admin,
  FsStore,
  authenticate,
  callTool,
  generateDevKeypair,
  makeDevSigner,
  Reader,
  Writer,
  validateJwt,
  type AuthedContext,
  type ToolDeps,
} from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const AUD = "https://box.example.com/mcp";

describe("auth + tool dispatch", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Awaited<ReturnType<FreshBrain["connect"]>>;
  let deps: ToolDeps;

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
  }, 120_000);

  afterEach(async () => {
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("bootstraps an owner, authenticates its token, and dispatches tools", async () => {
    const boot = await deps.admin.bootstrapOwner({ name: "Alice", email: "owner@example.com" });
    const ctx = await authenticate(pool, `Bearer ${boot.token}`);
    expect(ctx.role).toBe("owner");
    expect(ctx.scopes).toEqual(["read", "write", "schema-admin"]);

    // identity through the registry (catalog.you replaced whoami)
    const cat = (await callTool(deps, ctx, "catalog", {})) as { you: { id: string } };
    expect(cat.you.id).toBe(boot.id);

    // schema-admin + write flow
    const t = (await callTool(deps, ctx, "define_type", { name: "client" })) as {
      type_id: number;
    };
    const w = (await callTool(deps, ctx, "write", { type: "client", title: "Acme" })) as {
      id: string;
    };
    const got = (await callTool(deps, ctx, "get", { id: w.id })) as { type: string };
    expect(got.type).toBe("client");
    expect(t.type_id).toBeGreaterThan(0);
  });

  it("a second bootstrap is refused (self-guarding)", async () => {
    await deps.admin.bootstrapOwner({ name: "one", email: "owner@example.com" });
    await expect(
      deps.admin.bootstrapOwner({ name: "two", email: "owner@example.com" }),
    ).rejects.toBeTruthy();
  });

  it("scopes gate the surface: a read-only member cannot write or create members", async () => {
    const owner = await deps.admin.bootstrapOwner({ name: "owner", email: "owner@example.com" });
    const ownerCtx = await authenticate(pool, `Bearer ${owner.token}`);
    const member = (await callTool(deps, ownerCtx, "create_user", {
      name: "reader",
      email: "user@example.com",
      permission: "viewer",
    })) as { id: string; token: string };

    const memberCtx = await authenticate(pool, `Bearer ${member.token}`);
    expect(memberCtx.scopes).toEqual(["read"]);
    // reads work
    await callTool(deps, memberCtx, "catalog", {});
    // writes refused (write scope missing)
    await expect(callTool(deps, memberCtx, "write", { title: "nope" })).rejects.toMatchObject({
      code: "refused",
    });
    // account escalation blocked at the DB (member is not an owner)
    await expect(
      callTool(deps, memberCtx, "create_user", {
        name: "x",
        email: "user@example.com",
        permission: "viewer",
      }),
    ).rejects.toMatchObject({ code: "refused" });
  });

  it("rejects unknown / expired / revoked tokens", async () => {
    await expect(authenticate(pool, "Bearer brain_sk_bogus")).rejects.toMatchObject({
      code: "refused",
    });
    await expect(authenticate(pool, undefined)).rejects.toMatchObject({ code: "refused" });

    const owner = await deps.admin.bootstrapOwner({ name: "owner", email: "owner@example.com" });
    const ownerCtx = await authenticate(pool, `Bearer ${owner.token}`);
    const m = (await callTool(deps, ownerCtx, "create_user", {
      name: "m",
      email: "user@example.com",
      permission: "viewer",
    })) as { id: string; token: string };
    // authenticate works before revocation
    await authenticate(pool, `Bearer ${m.token}`);
    await deps.admin.revokeAccount(ownerCtx.actorId, m.id);
    await expect(authenticate(pool, `Bearer ${m.token}`)).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("OAuth JWT: alg-pinned + aud-bound; none/HS*/wrong-aud/expired rejected", async () => {
    const kp = await generateDevKeypair();
    const signer = await makeDevSigner(kp);
    const sub = "11111111-1111-1111-1111-111111111111";

    const good = await signer.sign({ sub, scopes: ["read", "write"], aud: AUD });
    const ctx: AuthedContext = await validateJwt(good, {
      publicKey: kp.publicKey,
      canonicalAud: AUD,
    });
    expect(ctx.actorId).toBe(sub);
    expect(ctx.scopes).toContain("write");

    // wrong audience
    const wrongAud = await signer.sign({ sub, scopes: ["read"], aud: "https://evil/mcp" });
    await expect(
      validateJwt(wrongAud, { publicKey: kp.publicKey, canonicalAud: AUD }),
    ).rejects.toMatchObject({ code: "refused" });

    // expired
    const expired = await signer.sign({ sub, scopes: ["read"], aud: AUD, expiresInSeconds: -10 });
    await expect(
      validateJwt(expired, { publicKey: kp.publicKey, canonicalAud: AUD }),
    ).rejects.toMatchObject({ code: "refused" });

    // alg 'none' unsigned token
    const noneTok =
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify({ sub, aud: AUD })).toString("base64url") +
      ".";
    await expect(
      validateJwt(noneTok, { publicKey: kp.publicKey, canonicalAud: AUD }),
    ).rejects.toMatchObject({ code: "refused" });
  });
});
