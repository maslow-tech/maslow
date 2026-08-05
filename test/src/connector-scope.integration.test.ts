import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations } from "@brain/schema";
import { Admin } from "@brain/mcp-tools";
import { createBox } from "@brain/box";
import { ConnectorConfigStore } from "@brain/box/dist/connectors/index.js";
import { encrypt, vaultKey } from "@brain/box/dist/connectors/crypto.js";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Connector credential SCOPING (0034, PR1). The load-bearing test is the
 * live-box one: a credential written by a PRE-0034 box (org, legacy AAD) must
 * survive the scope migration and decrypt with ZERO re-encryption — this runs
 * on every box in the field with real keys. Then the new behavior:
 * personal-first resolution, configuredForCaller visibility, in-place rescope,
 * and the end-to-end dashboard "bring your own key" flow.
 */

const ENV = { BRAIN_CONNECTOR_TOKEN_KEY: randomBytes(32).toString("base64") };
const SESSION = "test-session-secret-scope";

function cookieValue(res: Response, name: string): string | undefined {
  const all =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const line of all) {
    const m = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(line);
    if (m) return decodeURIComponent(m[1] as string);
  }
  return undefined;
}

describe("connector credential scoping (0034)", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerId: string;
  let ownerToken: string;
  let appOwnerClient: Client | undefined;

  const upTo0033 = MIGRATIONS.filter((m) => m.version <= "0033");

  beforeAll(async () => {
    // Bring the box up to JUST BEFORE 0034, then plant a legacy org credential
    // exactly as a pre-scoping box wrote it: no scope/owner columns, AAD is the
    // bare `connector_config:<provider>` literal.
    brain = await createFreshBrain(upTo0033);
    pool = new Pool(brain.appConfig);
    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    ownerId = boot.id;
    ownerToken = boot.token;

    const legacy = encrypt(
      vaultKey(ENV),
      JSON.stringify({ apiKey: "legacy-org-key" }),
      "connector_config:samgov",
    );
    await pool.query(
      `INSERT INTO connector_config (provider, ciphertext, iv, auth_tag, enabled_by)
       VALUES ('samgov', $1, $2, $3, $4)`,
      [legacy.ciphertext, legacy.iv, legacy.authTag, ownerId],
    );
  }, 180_000);

  afterAll(async () => {
    await appOwnerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  it("0034 backfills the legacy row to ('org', NULL) and it decrypts UNCHANGED (no re-encryption)", async () => {
    const owner = await brain.connect("owner");
    try {
      const applied = await runMigrations(owner, MIGRATIONS);
      expect(applied).toContain("0034");
    } finally {
      await owner.end();
    }

    const row = await pool.query<{ scope: string; owner_account: string | null }>(
      "SELECT scope, owner_account FROM connector_config WHERE provider = 'samgov'",
    );
    expect(row.rows[0]).toEqual({ scope: "org", owner_account: null });

    const store = new ConnectorConfigStore(pool, ENV);
    // The whole point: the pre-0034 ciphertext decrypts under the unchanged
    // org AAD — the migration never touched the encrypted bytes.
    expect(await store.getConfig("samgov")).toEqual({ apiKey: "legacy-org-key" });
  });

  it("resolution is personal-first, and the two tiers coexist under partial unique indexes", async () => {
    const store = new ConnectorConfigStore(pool, ENV);
    const alice = "11111111-1111-1111-1111-111111111111";
    // Seed a second real account so the personal FK holds.
    const admin = new Admin(pool);
    const aliceId = (
      await admin.createUser(ownerId, {
        name: "Alice",
        email: "alice@example.com",
        permission: "member",
      })
    ).id;

    // Org row exists (from the legacy seed). Alice has no personal → org wins.
    const beforePersonal = await store.getEffective("samgov", aliceId);
    expect(beforePersonal).toEqual({ creds: { apiKey: "legacy-org-key" }, scope: "org" });

    // Alice adds her own personal key → hers wins for HER calls.
    await store.putConfig("samgov", { apiKey: "alice-key" }, aliceId, {
      scope: "personal",
      ownerAccount: aliceId,
    });
    expect(await store.getEffective("samgov", aliceId)).toEqual({
      creds: { apiKey: "alice-key" },
      scope: "personal",
    });
    // A different account still gets the org row (personal is per-member).
    expect(await store.getConfig("samgov", { scope: "personal", ownerAccount: alice })).toBeNull();

    // Both rows coexist — the org PK is gone, partial unique indexes hold.
    const rows = await pool.query<{ scope: string }>(
      "SELECT scope FROM connector_config WHERE provider = 'samgov' ORDER BY scope",
    );
    expect(rows.rows.map((r) => r.scope)).toEqual(["org", "personal"]);

    // configuredForCaller sees the provider for Alice (org + her personal).
    expect(await store.configuredForCaller(aliceId)).toContain("samgov");
  });

  it("rescope flips a personal credential to org in place, refusing to clobber an existing org row", async () => {
    const store = new ConnectorConfigStore(pool, ENV);
    const admin = new Admin(pool);
    const bobId = (
      await admin.createUser(ownerId, {
        name: "Bob",
        email: "bob@example.com",
        permission: "member",
      })
    ).id;
    await store.putConfig("weathersvc", { value: "bob-personal" }, bobId, {
      scope: "personal",
      ownerAccount: bobId,
    });

    // No org row for weathersvc yet → flip personal→org succeeds in place.
    const ok = await store.rescope(
      "weathersvc",
      { scope: "personal", ownerAccount: bobId },
      { scope: "org" },
      ownerId,
      () => pool.connect(),
    );
    expect(ok).toEqual({ ok: true });
    expect(await store.getConfig("weathersvc")).toEqual({ value: "bob-personal" });
    expect(
      await store.getConfig("weathersvc", { scope: "personal", ownerAccount: bobId }),
    ).toBeNull();

    // Now an org row exists; flipping another personal into org must REFUSE
    // rather than clobber the shared credential.
    await store.putConfig("weathersvc", { value: "carol-personal" }, bobId, {
      scope: "personal",
      ownerAccount: bobId,
    });
    const refused = await store.rescope(
      "weathersvc",
      { scope: "personal", ownerAccount: bobId },
      { scope: "org" },
      ownerId,
      () => pool.connect(),
    );
    expect(refused.ok).toBe(false);
    // The org credential is untouched.
    expect(await store.getConfig("weathersvc")).toEqual({ value: "bob-personal" });
  });

  it("end-to-end: a member's personal custom-connector key serves THEIR calls; org key untouched", async () => {
    appOwnerClient = await brain.connect("owner");
    // custom.ts routes through the injected SSRF guard now — record requests at
    // that seam instead of stubbing the global fetch.
    const seen: string[] = [];
    const app: Hono = createBox({
      pool,
      ownerClient: appOwnerClient,
      dashboard: { sessionSecret: SESSION, secureCookies: false, connectors: { env: ENV } },
      net: {
        guardedFetch: (u) => {
          seen.push(String(u));
          return Promise.resolve({ status: 200, headers: new Headers(), text: "{}" });
        },
      },
    });
    const admin = new Admin(pool);
    const carol = await admin.createUser(ownerId, {
      name: "Carol",
      email: "carol@example.com",
      permission: "member",
    });

    const login = async (token: string): Promise<{ cookie: string; csrf: string }> => {
      const res = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const session = cookieValue(res, "brain_session")!;
      const csrf = cookieValue(res, "brain_csrf")!;
      return { cookie: `brain_session=${session}; brain_csrf=${csrf}`, csrf };
    };
    const carolSess = await login(carol.token);
    const ownerSess = await login(ownerToken);

    // Owner defines a custom connector (org has NO credential for it).
    const mk = await app.request("/api/v1/connectors/custom", {
      method: "POST",
      headers: {
        cookie: ownerSess.cookie,
        "x-csrf-token": ownerSess.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: "weatherapi",
        name: "Weather",
        baseUrl: "https://api.weather.example",
        authKind: "query",
        authName: "key",
      }),
    });
    expect(mk.status).toBe(200);

    // Carol brings her OWN key (personal) — a member, no owner rights needed.
    const set = await app.request("/api/v1/connectors/weatherapi/config", {
      method: "PUT",
      headers: {
        cookie: carolSess.cookie,
        "x-csrf-token": carolSess.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: "carol-weather-key", scope: "personal" }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ scope: "personal" });

    // Her call injects HER key (recorded by the injected guard above).
    const call = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${carol.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "weatherapi_fetch", arguments: { path: "/v1/now" } },
      }),
    });
    expect(call.status).toBe(200);
    expect(new URL(seen[0]!).searchParams.get("key")).toBe("carol-weather-key");
  });
});
