import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { TokenVault, beginOAuth, completeOAuth } from "@brain/box/dist/connectors/index.js";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * Native connector foundation (0025): AES-256-GCM token vault (encrypt at
 * rest, transparent refresh, typed reauth — never a throw) and the PKCE/CSRF
 * OAuth connect flow (single-use state, bound verifier, typed outcomes).
 */
describe("connector vault + oauth flow (0025)", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let alice: string;

  const env = { BRAIN_CONNECTOR_TOKEN_KEY: randomBytes(32).toString("base64") };
  const badEnv = { BRAIN_CONNECTOR_TOKEN_KEY: randomBytes(32).toString("base64") };

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    const admin = new Admin(pool);
    alice = (await admin.bootstrapOwner({ name: "alice", email: "a@example.com" })).id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  // ---- vault ---------------------------------------------------------------

  it("round-trips tokens through the vault; only ciphertext lands in the DB", async () => {
    const vault = new TokenVault(pool, {}, env);
    await vault.putTokens({
      accountId: alice,
      provider: "msgraph",
      accessToken: "tok-secret-123",
      secretBlob: "msal-cache-blob",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["Files.Read.All"],
    });
    const fresh = await vault.getFreshAccessToken(alice, "msgraph");
    expect(fresh).toMatchObject({ ok: true, accessToken: "tok-secret-123" });

    const raw = await pool.query(
      "SELECT ciphertext, iv, auth_tag, scopes FROM connector_secrets WHERE account_id = $1 AND provider = 'msgraph'",
      [alice],
    );
    const row = raw.rows[0]!;
    expect(row.ciphertext).not.toContain("tok-secret-123");
    expect(row.ciphertext).not.toContain("msal-cache-blob");
    expect(row.scopes).toEqual(["Files.Read.All"]); // non-sensitive stays clear
  });

  it("a wrong-key decrypt logs the incident-class alarm, never key material", async () => {
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn");
    const badEnv = { BRAIN_CONNECTOR_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64") };
    const wrongKey = new TokenVault(pool, {}, badEnv);
    await wrongKey.getFreshAccessToken(alice, "msgraph");
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("connector_error"));
    expect(line).toContain('"op":"decrypt"');
    expect(line).toContain('"error":"decrypt_failed"');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(badEnv.BRAIN_CONNECTOR_TOKEN_KEY);
    warn.mockRestore();
  });

  it("unknown provider → not_connected; wrong key → reauth_required (never a throw)", async () => {
    const vault = new TokenVault(pool, {}, env);
    expect(await vault.getFreshAccessToken(alice, "gmail")).toEqual({
      ok: false,
      reason: "not_connected",
    });
    const wrongKey = new TokenVault(pool, {}, badEnv);
    expect(await wrongKey.getFreshAccessToken(alice, "msgraph")).toEqual({
      ok: false,
      reason: "reauth_required",
    });
  });

  it("AAD binds a token blob to its row — a spliced ciphertext fails closed", async () => {
    const vault = new TokenVault(pool, {}, env);
    await vault.putTokens({
      accountId: alice,
      provider: "msgraph",
      accessToken: "alice-tok",
      secretBlob: "blob",
    });
    // Create a second account and splice alice's encrypted blob into its row.
    const admin = new Admin(pool);
    const mallory = (
      await admin.createUser(alice, {
        name: "mallory",
        email: "m@example.com",
        permission: "member",
      })
    ).id;
    const enc = await pool.query(
      "SELECT ciphertext, iv, auth_tag FROM connector_secrets WHERE account_id = $1 AND provider = 'msgraph'",
      [alice],
    );
    const e = enc.rows[0]!;
    await pool.query(
      `INSERT INTO connector_secrets (account_id, provider, ciphertext, iv, auth_tag)
       VALUES ($1, 'msgraph', $2, $3, $4)`,
      [mallory, e.ciphertext, e.iv, e.auth_tag],
    );
    // Same key, valid GCM tag — but the AAD (account:provider) no longer matches,
    // so decrypt fails and mallory gets a reconnect, not alice's token.
    expect(await vault.getFreshAccessToken(mallory, "msgraph")).toEqual({
      ok: false,
      reason: "reauth_required",
    });
    await vault.deleteTokens(alice, "msgraph");
    await vault.deleteTokens(mallory, "msgraph");
  });

  it("expired token refreshes through the provider hook and re-persists", async () => {
    const vault0 = new TokenVault(pool, {}, env);
    await vault0.putTokens({
      accountId: alice,
      provider: "msgraph",
      accessToken: "stale",
      secretBlob: "refresh-me",
      expiresAt: Date.now() - 1000,
    });
    let refreshedWith = "";
    const vault = new TokenVault(
      pool,
      {
        msgraph: (blob) => {
          refreshedWith = blob;
          return Promise.resolve({
            ok: true,
            accessToken: "fresh-tok",
            secretBlob: "new-blob",
            expiresAt: Date.now() + 3_600_000,
          });
        },
      },
      env,
    );
    expect(await vault.getFreshAccessToken(alice, "msgraph")).toMatchObject({
      ok: true,
      accessToken: "fresh-tok",
    });
    expect(refreshedWith).toBe("refresh-me");
    // persisted: a plain vault (no refresh hook) now sees the fresh token
    expect(await vault0.getFreshAccessToken(alice, "msgraph")).toMatchObject({
      ok: true,
      accessToken: "fresh-tok",
    });
  });

  it("expired with no refresh hook → reauth_required; delete → not_connected", async () => {
    const vault = new TokenVault(pool, {}, env);
    await vault.putTokens({
      accountId: alice,
      provider: "github",
      accessToken: "x",
      secretBlob: "y",
      expiresAt: Date.now() - 1000,
    });
    expect(await vault.getFreshAccessToken(alice, "github")).toEqual({
      ok: false,
      reason: "reauth_required",
    });
    await vault.deleteTokens(alice, "github");
    expect(await vault.getFreshAccessToken(alice, "github")).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  // ---- oauth flow ------------------------------------------------------------

  it("begin → complete stores tokens; the state is single-use", async () => {
    const vault = new TokenVault(pool, {}, env);
    const begun = await beginOAuth(pool, {
      accountId: alice,
      provider: "msgraph",
      redirectUri: "https://box.example/connect/callback",
    });
    expect(begun.codeChallenge).not.toBe("");

    let sawVerifier = "";
    const exchange = {
      msgraph: (p: { code: string; codeVerifier: string; redirectUri: string }) => {
        sawVerifier = p.codeVerifier;
        return Promise.resolve({
          ok: true as const,
          accessToken: "exchanged-tok",
          secretBlob: "cache",
          scopes: ["Files.Read.All"],
        });
      },
    };
    const done = await completeOAuth(pool, vault, exchange, {
      state: begun.state,
      code: "auth-code",
      expectedAccountId: null,
    });
    expect(done).toEqual({ ok: true, accountId: alice, provider: "msgraph" });
    expect(sawVerifier).not.toBe(""); // the BOUND verifier reached the exchange
    expect(await vault.getFreshAccessToken(alice, "msgraph")).toMatchObject({
      ok: true,
      accessToken: "exchanged-tok",
    });

    // replayed callback: state already consumed
    const replay = await completeOAuth(pool, vault, exchange, {
      state: begun.state,
      code: "auth-code",
      expectedAccountId: null,
    });
    expect(replay).toEqual({ ok: false, reason: "unknown_state" });
  });

  it("binds the consume to the initiating account", async () => {
    const vault = new TokenVault(pool, {}, env);
    const bob = (
      await new Admin(pool).createUser(alice, {
        name: "bob",
        email: "bob-bind@example.com",
        permission: "member",
      })
    ).id;
    const exchange = {
      msgraph: async () => ({
        ok: true as const,
        accessToken: "tok",
        secretBlob: JSON.stringify({ v: 1 }),
        expiresAt: Date.now() + 3_600_000,
      }),
    };
    const aliceFlow = await beginOAuth(pool, {
      accountId: alice,
      provider: "msgraph",
      redirectUri: "https://box.example/connect/callback",
    });

    // A cross-member callback: the flow cookie names bob, but the state row is
    // alice's → NO row matches, alice's state is PRESERVED, reason unknown_state.
    const stolen = await completeOAuth(pool, vault, exchange, {
      state: aliceFlow.state,
      code: "c",
      expectedAccountId: bob,
    });
    expect(stolen).toEqual({ ok: false, reason: "unknown_state" });

    // Alice's legitimate completion still works afterward (no DoS).
    const legit = await completeOAuth(pool, vault, exchange, {
      state: aliceFlow.state,
      code: "c",
      expectedAccountId: alice,
    });
    expect(legit).toEqual({ ok: true, accountId: alice, provider: "msgraph" });
  });

  it("unknown state, unknown provider, failed exchange → typed reasons, no tokens stored", async () => {
    const vault = new TokenVault(pool, {}, env);
    expect(
      await completeOAuth(pool, vault, {}, { state: "forged", code: "c", expectedAccountId: null }),
    ).toEqual({
      ok: false,
      reason: "unknown_state",
    });

    const b1 = await beginOAuth(pool, {
      accountId: alice,
      provider: "unregistered",
      redirectUri: "https://box.example/cb",
    });
    expect(
      await completeOAuth(pool, vault, {}, { state: b1.state, code: "c", expectedAccountId: null }),
    ).toEqual({
      ok: false,
      reason: "unknown_provider",
    });

    const b2 = await beginOAuth(pool, {
      accountId: alice,
      provider: "gmail",
      redirectUri: "https://box.example/cb",
    });
    const failing = { gmail: () => Promise.resolve({ ok: false as const }) };
    expect(
      await completeOAuth(pool, vault, failing, {
        state: b2.state,
        code: "c",
        expectedAccountId: null,
      }),
    ).toEqual({
      ok: false,
      reason: "exchange_failed",
    });
    expect(await vault.getFreshAccessToken(alice, "gmail")).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });

  it("expired state is refused; the next begin sweeps expired rows", async () => {
    const vault = new TokenVault(pool, {}, env);
    const b = await beginOAuth(pool, {
      accountId: alice,
      provider: "msgraph",
      redirectUri: "https://box.example/cb",
    });
    await pool.query(
      "UPDATE connector_oauth_state SET created_at = now() - interval '11 minutes' WHERE state = $1",
      [b.state],
    );
    expect(
      await completeOAuth(pool, vault, {}, { state: b.state, code: "c", expectedAccountId: null }),
    ).toEqual({
      ok: false,
      reason: "expired_state",
    });
    const b2 = await beginOAuth(pool, {
      accountId: alice,
      provider: "msgraph",
      redirectUri: "https://box.example/cb",
    });
    await pool.query(
      "UPDATE connector_oauth_state SET created_at = now() - interval '11 minutes' WHERE state = $1",
      [b2.state],
    );
    // beginOAuth folds the sweep in: any new begin deletes expired rows.
    await beginOAuth(pool, {
      accountId: alice,
      provider: "msgraph",
      redirectUri: "https://box.example/cb",
    });
    const left = await pool.query("SELECT 1 FROM connector_oauth_state WHERE state = $1", [
      b2.state,
    ]);
    expect(left.rowCount).toBe(0);
  });
});
