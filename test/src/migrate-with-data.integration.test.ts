import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, SchemaExecutor } from "@brain/schema";
import { Admin, Writer, type WriteContext } from "@brain/mcp-tools";
import { TokenVault } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The newest migration must apply over a brain WITH DATA, not just the empty
 * DBs every other test migrates. Empty-DB runs skip whole failure classes —
 * 0018's backfill ALTER TABLE died on "pending trigger events" on any box
 * with rows, after sailing through CI green. This is the forever-regression:
 * seed on everything BEFORE 0022 (type-icons — the oldest migration this
 * test deliberately excludes from the seed), then apply 0022 through
 * whatever the newest migration is over real rows (typed + untyped objects,
 * links, an edit — enough to arm the deferred triggers).
 *
 * Found by NAME, not a trailing slice(-N): a hardcoded count silently drifts
 * every time a new migration is appended that has nothing to do with this
 * test's actual concern (0022-0025's data backfills) — exactly the kind of
 * assumption this file exists to catch elsewhere, so it shouldn't carry one
 * itself. (This bit a real PR: two new unrelated migrations landed and a
 * hardcoded -4 silently started seeding THROUGH 0022 instead of before it,
 * so the icon backfill ran with no "client" type yet to backfill.)
 */
const FIRST_MIGRATION_UNDER_TEST = "0022";
const splitIndex = MIGRATIONS.findIndex((m) => m.version === FIRST_MIGRATION_UNDER_TEST);
if (splitIndex < 1) {
  throw new Error(`migration ${FIRST_MIGRATION_UNDER_TEST} not found in MIGRATIONS`);
}

/** Run `fn` in a txn with app.actor_id set, exactly as the write path does. */
async function withActor<T>(client: Client, actorId: string, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    const r = await fn();
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/**
 * Run a SHIPPED migration's SQL a second time, straight at the database. The
 * ledger would skip it, which is precisely why this bypasses the ledger: the
 * case being reproduced is the canary rollback, where the migration applied,
 * the app was rolled back to a build predating the table, and the next update
 * runs the whole file again against a box that already has everything in it.
 * Returns the NOTICEs raised, because "skip with a RAISE NOTICE" (doctrine
 * rule 1) is the assertion — a silent success would not prove the guards ran.
 */
async function reapply(client: Client, version: string): Promise<string[]> {
  const m = MIGRATIONS.find((x) => x.version === version);
  if (!m) throw new Error(`migration ${version} not found in MIGRATIONS`);
  const notices: string[] = [];
  const onNotice = (n: { message: string | undefined }): void => {
    if (n.message) notices.push(n.message);
  };
  client.on("notice", onNotice);
  try {
    await client.query("BEGIN");
    await client.query(m.sql);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.removeListener("notice", onNotice);
  }
  return notices;
}

describe("newest migration applies over a seeded brain", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let eventsBeforeMigration: number;
  /** phase-2 fixtures (0052/0053): two members, a private object and a shared one. */
  let memberA: string;
  let memberB: string;
  let privateOfA: string;
  let sharedWithB: string;

  beforeAll(async () => {
    // seed on everything up to (but not including) 0022; the test bodies
    // below apply 0022..newest over these real rows.
    brain = await createFreshBrain(MIGRATIONS.slice(0, splitIndex));
    pool = new Pool(brain.appConfig);
    const admin = new Admin(pool);
    const writer = new Writer(pool);
    const alice = (await admin.bootstrapOwner({ name: "alice", email: "a@example.com" })).id;
    const wctx: WriteContext = { actorId: alice, scopes: ["read", "write"] };

    // Accounts that stress 0037's home-slug backfill: a name collision (two
    // spellings that slugify identically), an all-symbol name, and a reserved
    // name. Created pre-0037, so the createUser fs-home companion no-ops
    // (fs_homes doesn't exist yet) and the MIGRATION must slug them all.
    const bob = await admin.createUser(alice, {
      name: "Bob Smith",
      email: "bob@example.com",
      permission: "member",
    });
    await admin.createUser(alice, {
      name: "bob-smith",
      email: "bob2@example.com",
      permission: "member",
    });
    await admin.createUser(alice, { name: "!!!", email: "sym@example.com", permission: "viewer" });
    await admin.createUser(alice, {
      name: "shared",
      email: "res@example.com",
      permission: "member",
    });
    // Two more members for the phase-2 RLS shapes (0052 write_idempotency,
    // 0053 collab_docs). Neither name collides with the slug pairs above, so
    // the 0037 backfill assertions are untouched.
    memberA = (
      await admin.createUser(alice, {
        name: "carol",
        email: "carol@example.com",
        permission: "member",
      })
    ).id;
    memberB = (
      await admin.createUser(alice, {
        name: "dave",
        email: "dave@example.com",
        permission: "member",
      })
    ).id;

    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    try {
      const t = await exec.defineType({ name: "client" }, alice);
      await exec.addProperty({ typeId: t.typeId, name: "industry", kind: "text" }, alice);
    } finally {
      await owner.end();
    }
    // Explicit publish: wave-2 writes default PRIVATE, and the 0057 test below
    // needs a genuinely org-visible seed row (its audience must backfill to
    // [[orgTag]], and members B/C must see it post-migration).
    const c = await writer.write(wctx, {
      type: "client",
      title: "Acme Corp",
      props: { industry: "aerospace" },
      visibility: "org",
    });
    const note = await writer.write(wctx, {
      title: "kickoff notes",
      body: "met with Acme about the pilot",
      links: [{ rel: "about", to: c.id }],
    });
    await writer.edit(wctx, note.id, { bodyOps: [{ op: "append", text: " — follow up friday" }] });
    await writer.write(wctx, { title: "scratch", visibility: "private" });
    // 0057 seed: a private note explicitly shared with Bob — the audience
    // backfill must compile it to [[creator],[bob]] behavior-preservingly.
    await writer.write(wctx, {
      title: "shared scratch",
      visibility: "private",
      sharedWith: [bob.id],
    });

    // The rows 0052/0053's policies land on: one object only carol can see,
    // one carol deliberately shared with dave. Both predate BOTH migrations —
    // an empty CI database never has an object for a room policy to point at.
    const actx: WriteContext = { actorId: memberA, scopes: ["read", "write"] };
    privateOfA = (
      await writer.write(actx, {
        title: "carol's private page",
        body: "creator-only",
        visibility: "private",
      })
    ).id;
    sharedWithB = (
      await writer.write(actx, {
        title: "carol + dave",
        body: "shared means shared",
        visibility: "private",
        sharedWith: [memberB],
      })
    ).id;

    const owner2 = await brain.connect("owner");
    try {
      // Seed a pre-0029 object_embeddings row (0014 shape, 1024 dims): 0029
      // must drop the superseded sidecar even when it holds rows — derived
      // data, rebuilt by the sweep. This is the with-rows case no empty CI
      // database would ever exercise.
      await owner2.query(
        `INSERT INTO object_embeddings (object_id, embedding, source_version)
         SELECT id, ('[' || repeat('0,', 1023) || '1]')::vector, version
         FROM objects LIMIT 1`,
      );
      // Simulate a call:google event written before CONNECTOR_CONTENT_FIELDS
      // (and before migration 0028's backfill) existed — full args, unredacted,
      // exactly what was actually sitting in the live events table.
      await owner2.query(
        `INSERT INTO events (actor, kind, target, payload)
         VALUES ($1, 'call:google', NULL, $2::jsonb)`,
        [
          alice,
          JSON.stringify({
            ok: true,
            ms: 118,
            args: {
              action: "send",
              to: "leaky-seed-marker@example.com",
              subject: "pre-0028 seed row",
              text: "should be redacted by the backfill",
              path: "/gmail/v1/users/me/messages/send",
              method: "POST",
            },
          }),
        ],
      );
      const ev = await owner2.query<{ n: string }>("SELECT count(*)::text AS n FROM events");
      eventsBeforeMigration = Number(ev.rows[0]!.n);
    } finally {
      await owner2.end();
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("applies the newest migrations over live rows", async () => {
    const owner = await brain.connect("owner");
    try {
      const { runMigrations } = await import("@brain/schema");
      const applied = await runMigrations(owner, MIGRATIONS);
      expect(applied).toEqual(MIGRATIONS.slice(splitIndex).map((m) => m.version));
    } finally {
      await owner.end();
    }
  });

  it("0029 swaps the populated object_embeddings sidecar for object_chunks", async () => {
    const owner = await brain.connect("owner");
    try {
      const r = await owner.query<{ old_gone: boolean; chunks_ok: boolean }>(
        `SELECT to_regclass('public.object_embeddings') IS NULL AS old_gone,
                to_regclass('public.object_chunks') IS NOT NULL AS chunks_ok`,
      );
      expect(r.rows[0]!.old_gone).toBe(true);
      expect(r.rows[0]!.chunks_ok).toBe(true);
    } finally {
      await owner.end();
    }
  });

  it("0037 backfills unique home slugs and seeds the filesystem skeleton", async () => {
    // Superuser: fs_entries has FORCE RLS, and home dirs are owner-scoped —
    // the assertions below need to see every row regardless of actor.
    const su = await brain.connect("superuser");
    try {
      const homes = await su.query<{ slug: string; name: string }>(
        "SELECT h.slug, a.name FROM fs_homes h JOIN accounts a ON a.id = h.actor_id",
      );
      const byName = new Map(homes.rows.map((r) => [r.name, r.slug]));
      expect(byName.get("alice")).toBe("alice");
      // the collision pair got the base slug + a -2 suffix (order by creation)
      expect(byName.get("Bob Smith")).toBe("bob-smith");
      expect(byName.get("bob-smith")).toBe("bob-smith-2");
      // pathological (all-symbol) and reserved names fall back to user-<first8>
      expect(byName.get("!!!")).toMatch(/^user-[0-9a-f]{8}$/);
      expect(byName.get("shared")).toMatch(/^user-[0-9a-f]{8}$/);

      // every HUMAN account got a home; slugs are unique. The teammate service
      // account (auto-provisioned by 0057, retired by 0059) never received an
      // fs home from any path — exclude it by the email 0057 provisioned it
      // under, since 0059 has already dropped the flag that identified it.
      const counts = await su.query<{ accounts: string; homes: string; slugs: string }>(
        `SELECT (SELECT count(*)::text FROM accounts
                  WHERE lower(email) IS DISTINCT FROM 'teammate@service.brain') AS accounts,
                (SELECT count(*)::text FROM fs_homes) AS homes,
                (SELECT count(DISTINCT slug)::text FROM fs_homes) AS slugs`,
      );
      expect(counts.rows[0]!.homes).toBe(counts.rows[0]!.accounts);
      expect(counts.rows[0]!.slugs).toBe(counts.rows[0]!.homes);

      // the skeleton: /, /shared, /home, the rules README
      const skel = await su.query<{ path: string; kind: string }>(
        "SELECT path, kind FROM fs_entries WHERE path IN ('/', '/shared', '/home', '/shared/README.md')",
      );
      const byPath = new Map(skel.rows.map((r) => [r.path, r.kind]));
      expect(byPath.get("/")).toBe("dir");
      expect(byPath.get("/shared")).toBe("dir");
      expect(byPath.get("/home")).toBe("dir");
      expect(byPath.get("/shared/README.md")).toBe("file");

      // a home dir per slug, owner_id trigger-pinned to the account
      const dirs = await su.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM fs_homes h
         JOIN fs_entries e ON e.path = '/home/' || h.slug
         WHERE e.kind = 'dir' AND e.owner_id = h.actor_id`,
      );
      expect(dirs.rows[0]!.n).toBe(counts.rows[0]!.homes);

      // the usage counter matches the seeded bytes (just the README)
      const usage = await su.query<{ total: string; files: string }>(
        `SELECT (SELECT total_bytes::text FROM fs_usage) AS total,
                (SELECT coalesce(sum(size_bytes), 0)::text FROM fs_entries WHERE kind = 'file') AS files`,
      );
      expect(usage.rows[0]!.total).toBe(usage.rows[0]!.files);
      expect(Number(usage.rows[0]!.total)).toBeGreaterThan(0);
    } finally {
      await su.end();
    }
  });

  it("0043 adds fs_versions + lock columns and applies on a seeded brain", async () => {
    // Superuser: fs_versions has FORCE RLS; the assertions below inspect
    // catalog state that must be visible regardless of actor.
    const su = await brain.connect("superuser");
    try {
      const t = await su.query<{ tbl: string | null }>(
        "SELECT to_regclass('public.fs_versions')::text AS tbl",
      );
      expect(t.rows[0]!.tbl).toBe("fs_versions");

      const cols = await su.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'fs_entries' AND column_name IN ('locked_by','locked_at')`,
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["locked_at", "locked_by"]);

      const rls = await su.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE relname = 'fs_versions'",
      );
      expect(rls.rows[0]!.relrowsecurity).toBe(true);
    } finally {
      await su.end();
    }
  });

  it("0058: backfills governed_by = created_by over the seeded rows; owner_removals is FORCE RLS", async () => {
    const su = await brain.connect("superuser");
    try {
      const mismatch = await su.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM objects
          WHERE governed_by IS DISTINCT FROM created_by`,
      );
      expect(mismatch.rows[0]!.n).toBe(0);
      const rls = await su.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = 'owner_removals'`,
      );
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    } finally {
      await su.end();
    }
  });

  it("0057: backfills audience behavior-preservingly and swaps the policy", async () => {
    // Everything catalog-ish is read as superuser (RLS-free); the actual
    // visibility matrix is driven through the app role with app.actor_id set —
    // the exact path every reader query takes.
    const su = await brain.connect("superuser");
    let orgNoteId: string;
    let privateNoteId: string;
    let sharedNoteId: string;
    let accountA: string;
    let accountB: string;
    let accountC: string;
    try {
      const obj = async (title: string) =>
        (await su.query<{ id: string }>("SELECT id FROM objects WHERE title = $1", [title]))
          .rows[0]!.id;
      orgNoteId = await obj("Acme Corp");
      privateNoteId = await obj("scratch");
      sharedNoteId = await obj("shared scratch");
      const acct = async (email: string) =>
        (await su.query<{ id: string }>("SELECT id FROM accounts WHERE lower(email) = $1", [email]))
          .rows[0]!.id;
      accountA = await acct("a@example.com"); // alice, the creator
      accountB = await acct("bob@example.com"); // shared with
      accountC = await acct("bob2@example.com"); // bystander

      // tags minted: the org singleton + a personal tag per existing account
      const org = await su.query<{ id: string }>("SELECT id FROM tags WHERE kind = 'org'");
      expect(org.rows).toHaveLength(1);
      const personal = await su.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tags WHERE kind = 'personal'",
      );
      expect(personal.rows[0]!.n).toBeGreaterThanOrEqual(5);

      // 0057 auto-provisioned a teammate service account here and granted it
      // the org tag. 0059 retires that whole class, so by the time these
      // assertions run the column, the functions and the row are all gone —
      // and, because the run is 0022..newest in one pass, this is the ONLY
      // place that ordering is exercised over real rows.
      const col = await su.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'accounts' AND column_name = 'is_service'`,
      );
      expect(col.rows, "0059 must drop accounts.is_service").toHaveLength(0);
      // The row itself survives — it can be the actor of real audit events, and
      // a trail that cannot name who wrote something is worse than one naming a
      // retired account. What must be gone is its ability to act: no token, no
      // active status, and no tags.
      const teammate = await su.query<{ id: string; status: string; token_hash: string | null }>(
        "SELECT id, status, token_hash FROM accounts WHERE lower(email) = 'teammate@service.brain'",
      );
      expect(teammate.rows).toHaveLength(1);
      expect(teammate.rows[0]).toMatchObject({ status: "revoked", token_hash: null });
      const stillHolds = await su.query("SELECT 1 FROM account_tags WHERE account_id = $1", [
        teammate.rows[0]!.id,
      ]);
      expect(stillHolds.rows, "a retired account must hold no tags").toHaveLength(0);

      // the backfill compiled the legacy columns to DNF audience rows
      const aud = async (id: string) =>
        (
          await su.query<{ audience: string[][] }>("SELECT audience FROM objects WHERE id = $1", [
            id,
          ])
        ).rows[0]!.audience;
      const orgAud = await aud(orgNoteId);
      expect(orgAud).toEqual([[org.rows[0]!.id]]);
      const privAud = await aud(privateNoteId);
      expect(privAud).toHaveLength(1); // [[creator]]
      const sharedAud = await aud(sharedNoteId);
      expect(sharedAud).toHaveLength(2); // [[creator],[bob]]

      // the policy actually swapped: it reads audience, not the legacy columns
      const pol = await su.query<{ qual: string }>(
        "SELECT qual FROM pg_policies WHERE tablename = 'objects' AND policyname = 'brain_visibility'",
      );
      expect(pol.rows[0]!.qual).toContain("brain_can_see");
    } finally {
      await su.end();
    }

    const seen = async (actor: string): Promise<string[]> => {
      const app = await brain.connect("app");
      try {
        await app.query("SELECT set_config('app.actor_id', $1, false)", [actor]);
        const r = await app.query<{ id: string }>("SELECT id FROM objects");
        return r.rows.map((x) => x.id);
      } finally {
        await app.end();
      }
    };

    // as A (creator) → sees all three
    const aSeen = await seen(accountA);
    expect(aSeen).toContain(orgNoteId);
    expect(aSeen).toContain(privateNoteId);
    expect(aSeen).toContain(sharedNoteId);
    // as B (shared with) → org + shared, not A's private
    const bSeen = await seen(accountB);
    expect(bSeen).toContain(orgNoteId);
    expect(bSeen).toContain(sharedNoteId);
    expect(bSeen).not.toContain(privateNoteId);
    // as C (bystander) → org only
    const cSeen = await seen(accountC);
    expect(cSeen).toContain(orgNoteId);
    expect(cSeen).not.toContain(sharedNoteId);
    expect(cSeen).not.toContain(privateNoteId);
  });

  it("0039 forces RLS on content tables over the seeded brain (owner loses ownership bypass)", async () => {
    // FORCE must take hold on a brain that already has rows — including the
    // seeded private 'scratch' object (created by alice above). This is the
    // exact live-box case: empty CI databases would apply the ALTERs fine but
    // never prove the owner-bypass is actually gone against real private data.
    const owner = await brain.connect("owner");
    try {
      for (const t of ["objects", "edges", "before_image", "merge_journal", "object_chunks"]) {
        const r = await owner.query<{ forced: boolean | null }>(
          "SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = $1",
          [t],
        );
        expect(r.rows[0]?.forced, `${t} must be FORCE'd after 0039`).toBe(true);
      }

      // the seeded private object is invisible to the RLS-bound owner…
      const hidden = await owner.query(
        "SELECT id FROM objects WHERE title = 'scratch' AND visibility = 'private'",
      );
      expect(hidden.rowCount, "owner cannot see the seeded private object").toBe(0);

      // …but brain_system (the sweep's role) sees it, so it still gets embedded.
      await owner.query("SET ROLE brain_system");
      const seen = await owner.query(
        "SELECT id FROM objects WHERE title = 'scratch' AND visibility = 'private'",
      );
      expect(seen.rowCount, "brain_system reads the private object for embedding").toBe(1);
      await owner.query("RESET ROLE");
    } finally {
      await owner.end();
    }
  });

  it("0041 break-glass brain_reissue_owner_token: rotates the addressed owner, audits, case-insensitive, RAISEs on unknown", async () => {
    const owner = await brain.connect("owner");
    try {
      const before = await owner.query<{ id: string; token_hash: string }>(
        "SELECT id, token_hash FROM accounts WHERE role = 'owner' AND lower(btrim(email)) = 'a@example.com'",
      );
      const ownerId = before.rows[0]!.id;

      // Rotate — the return is the owner id; token_hash changes; one audit event
      // lands with actor = the owner (break-glass never sets app.actor_id).
      const r = await owner.query<{ v: string }>(
        "SELECT brain_reissue_owner_token($1::text, $2::text) AS v",
        ["a@example.com", "hash_one"],
      );
      expect(r.rows[0]!.v).toBe(ownerId);
      const after = await owner.query<{ token_hash: string }>(
        "SELECT token_hash FROM accounts WHERE id = $1",
        [ownerId],
      );
      expect(after.rows[0]!.token_hash).toBe("hash_one");
      const ev = await owner.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM events WHERE kind = 'reissue_owner_token' AND actor = $1",
        [ownerId],
      );
      expect(ev.rows[0]!.n).toBe("1");

      // Case-insensitive match (the storage is btrim, not lowercased).
      await owner.query("SELECT brain_reissue_owner_token($1::text, $2::text)", [
        "A@Example.COM ",
        "hash_two",
      ]);
      const after2 = await owner.query<{ token_hash: string }>(
        "SELECT token_hash FROM accounts WHERE id = $1",
        [ownerId],
      );
      expect(after2.rows[0]!.token_hash).toBe("hash_two");

      // Unknown owner → RAISE (an explicit operator action on a nonexistent owner).
      await expect(
        owner.query("SELECT brain_reissue_owner_token($1::text, $2::text)", [
          "nobody@example.com",
          "x",
        ]),
      ).rejects.toThrow(/no active owner/);

      // These tests share one seeded brain; don't leave the 2 audit events for a
      // later exact-event-count assertion (0018) to trip on.
      await owner.query("DELETE FROM events WHERE kind = 'reissue_owner_token'");
    } finally {
      await owner.end();
    }
  });

  it("0022 backfills a non-null icon on the seeded type + 0023 makes box_kv", async () => {
    const owner = await brain.connect("owner");
    try {
      // the client type was created before 0022 ran; the backfill must fill it
      const r = await owner.query<{ icon: string | null }>(
        "SELECT icon FROM types WHERE name = 'client'",
      );
      expect(r.rows[0]!.icon).toBe("🏢");
      // and no type may be left without one (NOT NULL took hold)
      const nulls = await owner.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM types WHERE icon IS NULL",
      );
      expect(Number(nulls.rows[0]!.n)).toBe(0);
      // box_kv exists (0023)
      const kv = await owner.query<{ t: string | null }>(
        "SELECT to_regclass('public.box_kv')::text AS t",
      );
      expect(kv.rows[0]!.t).toBe("box_kv");
      // connector_config exists (0024)
      const cc = await owner.query<{ t: string | null }>(
        "SELECT to_regclass('public.connector_config')::text AS t",
      );
      expect(cc.rows[0]!.t).toBe("connector_config");
      // connector vault tables exist (0025)
      for (const table of ["connector_secrets", "connector_oauth_state"]) {
        const v = await owner.query<{ t: string | null }>(
          `SELECT to_regclass('public.${table}')::text AS t`,
        );
        expect(v.rows[0]!.t).toBe(table);
      }
    } finally {
      await owner.end();
    }
  });

  it("0038 adds the token-fingerprint + provenance columns and keeps a seeded org OAuth token serving", async () => {
    const owner = await brain.connect("owner");
    try {
      // the fingerprint columns exist on the LIVE connector_secrets table
      const cols = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'connector_secrets'
            AND column_name IN ('client_id','token_endpoint_host','server_url_host')`,
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
        "client_id",
        "server_url_host",
        "token_endpoint_host",
      ]);
      // the OAuth provenance columns exist on connector_oauth_state
      const st = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'connector_oauth_state' AND column_name IN ('issuer','resource')`,
      );
      expect(st.rows.length).toBe(2);
    } finally {
      await owner.end();
    }

    // A SEEDED org OAuth token (legacy all-NULL fingerprint) must keep
    // decrypting AND serving after 0038 — it only reauths on a fingerprint
    // MISMATCH, never a broken refresh.
    const env = { BRAIN_CONNECTOR_TOKEN_KEY: randomBytes(32).toString("base64") };
    const vault = new TokenVault(pool, {}, env);
    const alice = (await pool.query<{ id: string }>("SELECT id FROM accounts WHERE name = 'alice'"))
      .rows[0]!.id;
    await vault.putTokens({
      accountId: alice,
      provider: "seed_oauth_org",
      accessToken: "seed-access-token",
      secretBlob: JSON.stringify({ v: 1, refreshToken: "seed-refresh" }),
      expiresAt: Date.now() + 3_600_000,
    });
    // legacy path (no effective — google/microsoft shape) → serves
    expect((await vault.getFreshAccessToken(alice, "seed_oauth_org")).ok).toBe(true);
    // an ORG client (personal:false, all-NULL effective) → still serves
    expect(
      (
        await vault.getFreshAccessToken(alice, "seed_oauth_org", {
          clientId: null,
          tokenEndpointHost: null,
          serverUrlHost: null,
          personal: false,
        })
      ).ok,
    ).toBe(true);
    // a PERSONAL client against a NULL-fingerprint row → reauth_required (G5.3)
    const personal = await vault.getFreshAccessToken(alice, "seed_oauth_org", {
      clientId: "personal-client",
      tokenEndpointHost: null,
      serverUrlHost: null,
      personal: true,
    });
    expect(personal.ok).toBe(false);
    if (!personal.ok) expect(personal.reason).toBe("reauth_required");
  });

  it("0028 redacts connector-call content already written to the events table", async () => {
    const owner = await brain.connect("owner");
    try {
      const r = await owner.query<{ payload: { args: Record<string, unknown> } }>(
        `SELECT payload FROM events WHERE kind = 'call:google'
         AND payload->'args'->>'subject' = '[redacted: connector]'`,
      );
      expect(r.rows).toHaveLength(1);
      const args = r.rows[0]!.payload.args;
      expect(args.to).toBe("[redacted: connector]");
      expect(args.text).toBe("[redacted: connector]");
      // path/method/action are audit trail, not content — left alone
      expect(args.path).toBe("/gmail/v1/users/me/messages/send");
      expect(args.method).toBe("POST");
      expect(args.action).toBe("send");
      // the seed marker itself must not survive anywhere in the row
      expect(JSON.stringify(r.rows[0])).not.toContain("leaky-seed-marker@example.com");
    } finally {
      await owner.end();
    }
  });

  it("0018 backfill weighted existing rows without flooding the timeline", async () => {
    const owner = await brain.connect("owner");
    try {
      // Post-0057 the objects policy is audience-based and fails closed with
      // no actor — even org rows need the org tag held. Read as alice.
      await owner.query(
        "SELECT set_config('app.actor_id', a.id::text, false) FROM accounts a WHERE a.name = 'alice'",
      );
      // every live row re-chewed: title lexemes stamped A
      const r = await owner.query<{ tsv: string }>(
        "SELECT tsv::text AS tsv FROM objects WHERE title = 'Acme Corp'",
      );
      expect(r.rows[0]!.tsv).toContain("'acm':1A"); // english stemmer: acme → acm
      // the backfill wrote NO events (audit trigger disabled around it)
      const ev = await owner.query<{ n: string }>("SELECT count(*)::text AS n FROM events");
      expect(Number(ev.rows[0]!.n)).toBe(eventsBeforeMigration);
    } finally {
      await owner.end();
    }
  });

  it("createUser on the migrated brain gets a home from the companion, not the backfill", async () => {
    const admin = new Admin(pool);
    const alice = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE name = 'alice'");
    // collides with the backfilled pair → the companion must pick -3
    const late = await admin.createUser(alice.rows[0]!.id, {
      name: "Bob Smith",
      email: "bob3@example.com",
      permission: "member",
    });
    const su = await brain.connect("superuser");
    try {
      const h = await su.query<{ slug: string }>("SELECT slug FROM fs_homes WHERE actor_id = $1", [
        late.id,
      ]);
      expect(h.rows[0]!.slug).toBe("bob-smith-3");
      const d = await su.query<{ kind: string; owner_id: string }>(
        "SELECT kind, owner_id FROM fs_entries WHERE path = '/home/bob-smith-3'",
      );
      expect(d.rows[0]!.kind).toBe("dir");
      expect(d.rows[0]!.owner_id).toBe(late.id);
    } finally {
      await su.end();
    }
  });

  // ------------------------------------------------------------------------
  // Phase 2 of the workspace UI: 0052 (write_idempotency) + 0053 (collab_docs).
  // The blocks below run IN ORDER — they land rows through the real policies
  // first, and only then re-apply both migrations, so the canary-rollback
  // re-run is exercised against a table WITH DATA rather than an empty one.
  // (Phase 4's 0054/saved_views coverage is a separate block appended by
  // p4-t3; keep the two phases' assertions apart.)
  // ------------------------------------------------------------------------

  it("0052 + 0053 apply over the seeded brain", async () => {
    const owner = await brain.connect("owner");
    try {
      const led = await owner.query<{ version: string; status: string }>(
        `SELECT version, status FROM schema_migrations
          WHERE version IN ('0052', '0053') ORDER BY version`,
      );
      expect(led.rows).toEqual([
        { version: "0052", status: "done" },
        { version: "0053", status: "done" },
      ]);
      const t = await owner.query<{ idem: string | null; collab: string | null }>(
        `SELECT to_regclass('public.write_idempotency')::text AS idem,
                to_regclass('public.collab_docs')::text AS collab`,
      );
      expect(t.rows[0]!.idem).toBe("write_idempotency");
      expect(t.rows[0]!.collab).toBe("collab_docs");
    } finally {
      await owner.end();
    }
  });

  it("0052 + 0053 tables are FORCE RLS with a NON-NULL with_check", async () => {
    // The specific shape defect these two must not inherit from 0012's derived
    // tables: a USING-only policy (with_check NULL) governs reads but lets a
    // member INSERT a row stamped for someone else. Both tables are written to
    // DIRECTLY — there is no base table behind them re-checking the write — so
    // the identical predicate has to appear as WITH CHECK too.
    const owner = await brain.connect("owner");
    try {
      for (const table of ["write_idempotency", "collab_docs"]) {
        const rls = await owner.query<{ enabled: boolean; forced: boolean }>(
          `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
             FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
          [table],
        );
        expect(rls.rows).toHaveLength(1);
        expect(rls.rows[0]!.enabled).toBe(true);
        expect(rls.rows[0]!.forced).toBe(true); // brain_owner is bound too

        const pol = await owner.query<{ qual: string | null; with_check: string | null }>(
          `SELECT qual, with_check FROM pg_policies
            WHERE schemaname = 'public' AND tablename = $1`,
          [table],
        );
        expect(pol.rows).toHaveLength(1);
        expect(pol.rows[0]!.qual).not.toBeNull();
        expect(pol.rows[0]!.with_check).not.toBeNull();
      }
    } finally {
      await owner.end();
    }
  });

  it("0053 collab_docs follows the OBJECT's visibility, not the blob's creator", async () => {
    const app = await brain.connect("app");
    try {
      // dave may not open a room for carol's private object — a room he could
      // write into (or see) would announce that the object exists at all.
      await expect(
        withActor(app, memberB, () =>
          app.query(
            `INSERT INTO collab_docs (object_id, blob, last_flushed_version)
             VALUES ($1, '\\x00'::bytea, 1)`,
            [privateOfA],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);

      // …but the object carol SHARED with him is joinable: a per-creator policy
      // would break multiplayer exactly where multiplayer starts.
      await withActor(app, memberB, () =>
        app.query(
          `INSERT INTO collab_docs (object_id, blob, last_flushed_version)
           VALUES ($1, '\\x01'::bytea, 1)`,
          [sharedWithB],
        ),
      );
      const daveSees = await withActor(app, memberB, () =>
        app.query<{ object_id: string }>("SELECT object_id FROM collab_docs ORDER BY object_id"),
      );
      expect(daveSees.rows.map((r) => r.object_id)).toEqual([sharedWithB]);

      // carol owns both rooms: her own private one, plus the shared one dave
      // just created — the row's author is irrelevant to who may read it.
      await withActor(app, memberA, () =>
        app.query(
          `INSERT INTO collab_docs (object_id, blob, last_flushed_version)
           VALUES ($1, '\\x02'::bytea, 1)`,
          [privateOfA],
        ),
      );
      const carolSees = await withActor(app, memberA, () =>
        app.query<{ object_id: string }>("SELECT object_id FROM collab_docs"),
      );
      expect(carolSees.rows.map((r) => r.object_id).sort()).toEqual(
        [privateOfA, sharedWithB].sort(),
      );

      // and carol's private room stays invisible to dave (the privacy
      // invariant: presence must never reveal a private object exists).
      const leak = await withActor(app, memberB, () =>
        app.query("SELECT 1 FROM collab_docs WHERE object_id = $1", [privateOfA]),
      );
      expect(leak.rowCount).toBe(0);
    } finally {
      await app.end();
    }
  });

  it("0052 write_idempotency rows are invisible cross-actor and cannot be forged", async () => {
    const app = await brain.connect("app");
    const key = `seed-${randomUUID()}`;
    try {
      await withActor(app, memberA, () =>
        app.query(
          "INSERT INTO write_idempotency (key, actor_id, result) VALUES ($1, $2, $3::jsonb)",
          [key, memberA, JSON.stringify({ id: privateOfA, version: 1 })],
        ),
      );
      const mine = await withActor(app, memberA, () =>
        app.query("SELECT result FROM write_idempotency WHERE key = $1", [key]),
      );
      expect(mine.rowCount).toBe(1);

      // a second actor presenting the SAME key reads nothing — the key
      // namespace is global, the results are not.
      const theirs = await withActor(app, memberB, () =>
        app.query("SELECT result FROM write_idempotency WHERE key = $1", [key]),
      );
      expect(theirs.rowCount).toBe(0);

      // and dave cannot stamp a row with carol's actor_id to read her results
      // back out of it — that is the WITH CHECK, not the USING.
      await expect(
        withActor(app, memberB, () =>
          app.query(
            "INSERT INTO write_idempotency (key, actor_id, result) VALUES ($1, $2, '{}'::jsonb)",
            [`${key}-forged`, memberA],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await app.end();
    }
  });

  it("0052 dedupes one actor's retry and never serves it to another", async () => {
    const writer = new Writer(pool);
    const key = randomUUID();
    const a: WriteContext = { actorId: memberA, scopes: ["read", "write"] };
    const b: WriteContext = { actorId: memberB, scopes: ["read", "write"] };

    const first = await writer.write(a, { title: "idempotent create", idempotencyKey: key });
    const retry = await writer.write(a, { title: "idempotent create", idempotencyKey: key });
    expect(retry.id).toBe(first.id); // one intent, one object

    // The documented ceiling of the global key namespace: a colliding key from
    // ANOTHER actor degrades to "not deduped" — its own write, never a window
    // into carol's result.
    const other = await writer.write(b, { title: "dave's own create", idempotencyKey: key });
    expect(other.id).not.toBe(first.id);
  });

  it("re-applying 0052 + 0053 over those rows is a NOTICE, not an error", async () => {
    // Counted as superuser: both tables are FORCE RLS, so brain_owner sees
    // only what a policy lets it see and could not tell "purged" from "hidden".
    const su = await brain.connect("superuser");
    const owner = await brain.connect("owner");
    try {
      const counts = async (): Promise<{ idem: string; collab: string }> => {
        const r = await su.query<{ idem: string; collab: string }>(
          `SELECT (SELECT count(*)::text FROM write_idempotency) AS idem,
                  (SELECT count(*)::text FROM collab_docs) AS collab`,
        );
        return r.rows[0]!;
      };
      const before = await counts();
      expect(Number(before.idem)).toBeGreaterThan(0);
      expect(Number(before.collab)).toBeGreaterThan(0);

      const idem = (await reapply(owner, "0052")).join("\n");
      expect(idem).toMatch(/0052: write_idempotency_created_at_idx already present/);
      expect(idem).toMatch(/0052: write_idempotency already ENABLE\+FORCE RLS/);
      expect(idem).toMatch(/0052: policy write_idempotency_owner already present/);

      const collab = (await reapply(owner, "0053")).join("\n");
      expect(collab).toMatch(/0053: collab_docs_state_check already present/);
      expect(collab).toMatch(/0053: collab_docs already ENABLE\+FORCE RLS/);
      expect(collab).toMatch(/0053: policy collab_docs_visibility already present/);

      // the re-run touched nothing: same rows, still one policy per table,
      // still FORCE (a re-run that silently dropped either would be worse
      // than one that threw).
      const still = await owner.query<{ tbl: string; forced: boolean; policies: string }>(
        `SELECT c.relname AS tbl, c.relforcerowsecurity AS forced,
                (SELECT count(*)::text FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace
            AND c.relname IN ('write_idempotency', 'collab_docs')
          ORDER BY c.relname`,
      );
      expect(still.rows).toEqual([
        { tbl: "collab_docs", forced: true, policies: "1" },
        { tbl: "write_idempotency", forced: true, policies: "1" },
      ]);

      expect(await counts()).toEqual(before);
    } finally {
      await owner.end();
      await su.end();
    }
  });

  // ------------------------------------------------------------------------
  // Phase 4 of the workspace UI: 0054 (saved_views).
  //
  // Same running order as the phase-2 block above and for the same reason: land
  // rows through the REAL policy first, then re-apply the migration, so the
  // canary-rollback re-run (migration applied → app rolled back to a build
  // predating the table → next update runs the whole file again) is exercised
  // against a table WITH DATA. Everything here is SQL-level; the HTTP surface
  // and the full cross-member story live in saved-views.integration.test.ts.
  // ------------------------------------------------------------------------

  /** carol's row; created by the first phase-4 block, read by the later ones. */
  let carolViewId: string;

  it("0054 applies over the seeded brain and creates saved_views", async () => {
    const owner = await brain.connect("owner");
    try {
      const led = await owner.query<{ version: string; status: string }>(
        "SELECT version, status FROM schema_migrations WHERE version = '0054'",
      );
      expect(led.rows).toEqual([{ version: "0054", status: "done" }]);
      const t = await owner.query<{ views: string | null }>(
        "SELECT to_regclass('public.saved_views')::text AS views",
      );
      expect(t.rows[0]!.views).toBe("saved_views");

      // The uniqueness expression, not just "an index exists": a plain
      // four-column index would leave the GLOBAL (scope IS NULL) case undeduped
      // because SQL NULLs are distinct — ten identical sidebar entries, all
      // called the same thing.
      const idx = await owner.query<{ def: string }>(
        `SELECT indexdef AS def FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'saved_views_member_kind_scope_name_idx'`,
      );
      expect(idx.rows).toHaveLength(1);
      expect(idx.rows[0]!.def).toContain("UNIQUE");
      expect(idx.rows[0]!.def).toContain("COALESCE(scope");
    } finally {
      await owner.end();
    }
  });

  it("0054 saved_views is FORCE RLS with a NON-NULL with_check", async () => {
    // The defect this table must not inherit from 0012's derived tables: a
    // USING-only policy (with_check NULL) governs reads but lets a member
    // INSERT — or UPDATE — a row stamped with SOMEONE ELSE'S member_id. There
    // is no base table behind saved_views re-checking the write, and a planted
    // pinned view is a click-target injection into another member's sidebar,
    // so the identical predicate has to appear as WITH CHECK too.
    const owner = await brain.connect("owner");
    try {
      const rls = await owner.query<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class WHERE relname = 'saved_views' AND relnamespace = 'public'::regnamespace`,
      );
      expect(rls.rows).toHaveLength(1);
      expect(rls.rows[0]!.enabled).toBe(true);
      expect(rls.rows[0]!.forced).toBe(true); // brain_owner is bound too

      const pol = await owner.query<{ qual: string | null; with_check: string | null }>(
        `SELECT qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'saved_views'`,
      );
      expect(pol.rows).toHaveLength(1);
      expect(pol.rows[0]!.qual).not.toBeNull();
      expect(pol.rows[0]!.with_check).not.toBeNull();
      // and the two are the SAME predicate — a WITH CHECK that merely exists
      // but reads differently from the USING would be a second, weaker rule.
      expect(pol.rows[0]!.with_check).toBe(pol.rows[0]!.qual);
      expect(pol.rows[0]!.qual).toContain("app.actor_id");
    } finally {
      await owner.end();
    }
  });

  it("0054 saved_views rows are per-member and cannot be stamped for another", async () => {
    const app = await brain.connect("app");
    try {
      // carol's view config carries what makes this table content-bearing: a
      // filter literal plus the id of an object only she can see.
      const inserted = await withActor(app, memberA, () =>
        app.query<{ id: string }>(
          `INSERT INTO saved_views (member_id, kind, scope, name, config)
           VALUES ($1, 'database', 'client', 'carol pipeline', $2::jsonb)
           RETURNING id`,
          [memberA, JSON.stringify({ layout: "board", focus: privateOfA })],
        ),
      );
      carolViewId = inserted.rows[0]!.id;

      await withActor(app, memberB, () =>
        app.query(
          `INSERT INTO saved_views (member_id, kind, scope, name, config)
           VALUES ($1, 'database', 'client', 'dave pipeline', '{}'::jsonb)`,
          [memberB],
        ),
      );

      // dave's list is his own row and nothing else — carol's name, scope and
      // the object id inside her config are all invisible to him.
      const daveSees = await withActor(app, memberB, () =>
        app.query<{ name: string }>("SELECT name FROM saved_views ORDER BY name"),
      );
      expect(daveSees.rows.map((r) => r.name)).toEqual(["dave pipeline"]);

      // …and naming her row directly changes nothing: the USING clause, not a
      // member_id comparison somebody remembered to write in TypeScript.
      const stolen = await withActor(app, memberB, () =>
        app.query("UPDATE saved_views SET name = 'mine now' WHERE id = $1", [carolViewId]),
      );
      expect(stolen.rowCount).toBe(0);
      const dropped = await withActor(app, memberB, () =>
        app.query("DELETE FROM saved_views WHERE id = $1", [carolViewId]),
      );
      expect(dropped.rowCount).toBe(0);

      // The WITH CHECK: dave may not plant a pinned view in carol's sidebar.
      await expect(
        withActor(app, memberB, () =>
          app.query(
            `INSERT INTO saved_views (member_id, kind, name, config, pinned)
             VALUES ($1, 'database', 'planted', '{}'::jsonb, true)`,
            [memberA],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);

      const carolSees = await withActor(app, memberA, () =>
        app.query<{ name: string }>("SELECT name FROM saved_views ORDER BY name"),
      );
      expect(carolSees.rows.map((r) => r.name)).toEqual(["carol pipeline"]);
    } finally {
      await app.end();
    }
  });

  it("re-applying 0054 over those rows is a NOTICE, not an error", async () => {
    // Counted as superuser: saved_views is FORCE RLS, so brain_owner sees only
    // what the policy lets it see (with no app.actor_id set, that is nothing)
    // and could not tell "purged" from "hidden".
    const su = await brain.connect("superuser");
    const owner = await brain.connect("owner");
    try {
      const count = async (): Promise<number> => {
        const r = await su.query<{ n: string }>("SELECT count(*)::text AS n FROM saved_views");
        return Number(r.rows[0]!.n);
      };
      const before = await count();
      expect(before).toBeGreaterThan(0);

      const notices = (await reapply(owner, "0054")).join("\n");
      expect(notices).toMatch(/0054: saved_views_kind_check already present/);
      expect(notices).toMatch(/0054: saved_views_member_kind_scope_name_idx already present/);
      expect(notices).toMatch(/0054: saved_views already ENABLE\+FORCE RLS/);
      expect(notices).toMatch(/0054: policy saved_views_owner already present/);

      // the re-run touched nothing: same rows, still exactly one policy, still
      // FORCE. A re-run that silently dropped either would be worse than one
      // that threw — it would leave every member's saved views readable.
      const still = await owner.query<{ forced: boolean; policies: string }>(
        `SELECT c.relforcerowsecurity AS forced,
                (SELECT count(*)::text FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'saved_views') AS policies
           FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'saved_views'`,
      );
      expect(still.rows).toEqual([{ forced: true, policies: "1" }]);
      expect(await count()).toBe(before);

      // and the rows themselves survived intact — the guards skipped, they did
      // not re-create the table out from under the data.
      const mine = await su.query<{ name: string }>("SELECT name FROM saved_views WHERE id = $1", [
        carolViewId,
      ]);
      expect(mine.rows.map((r) => r.name)).toEqual(["carol pipeline"]);
    } finally {
      await owner.end();
      await su.end();
    }
  });
});

/**
 * 0059 (contract the teammate + remote-MCP schema) over a brain that actually
 * HOLDS the rows it retires.
 *
 * This needs its own brain because the suite above applies 0022..newest in one
 * pass — there is no point in that run where 0058 has landed and 0059 has not,
 * which is exactly the state the interesting rows can only be created in
 * (`accounts.is_service` and `remote_mcp_server` exist only between 0030/0036
 * and 0059). An empty database would apply 0059 perfectly and prove none of it:
 * every branch worth testing is a branch over data.
 *
 * What it pins, each a way this could go wrong on a box we have never seen:
 *   - a service account with NOTHING of its own is deleted outright;
 *   - a service account that WROTE something is revoked in place, never
 *     deleted, because deleting it would take a real object's author with it;
 *   - a remote server's encrypted credential is swept BEFORE the table holding
 *     the only copy of its slug is dropped — get this order wrong and the row
 *     is unattributable forever;
 *   - an unrelated connector keeps its credential (the sweep is targeted, not a
 *     wipe of connector_config);
 *   - brain_tag_grant still works after the column it used to read is gone —
 *     plpgsql does not resolve column references until runtime, so this is the
 *     failure that would otherwise surface on a user's box weeks later;
 *   - re-applying the whole migration is a no-op that NOTICEs rather than
 *     throws (the canary-rollback case).
 */
describe("0059 contracts a brain that holds teammate + remote-MCP rows", () => {
  const upTo0058 = MIGRATIONS.slice(
    0,
    MIGRATIONS.findIndex((m) => m.version === "0059"),
  );
  let brain: FreshBrain;
  let pool: Pool;
  let ownerId: string;
  let cleanSvc: string;
  let busySvc: string;

  beforeAll(async () => {
    if (upTo0058.length === MIGRATIONS.length) throw new Error("0059 not found in MIGRATIONS");
    brain = await createFreshBrain(upTo0058);
    pool = new Pool(brain.appConfig);
    const admin = new Admin(pool);
    const writer = new Writer(pool);
    ownerId = (await admin.bootstrapOwner({ name: "olive", email: "olive@test.brain" })).id;

    const a = await admin.createUser(ownerId, {
      name: "Clean Bot",
      email: "clean@service.brain",
      permission: "member",
    });
    const b = await admin.createUser(ownerId, {
      name: "Busy Bot",
      email: "busy@service.brain",
      permission: "member",
    });
    cleanSvc = a.id;
    busySvc = b.id;

    const su = await brain.connect("superuser");
    try {
      await su.query("UPDATE accounts SET is_service = true WHERE id = ANY($1)", [
        [cleanSvc, busySvc],
      ]);
      // A remote MCP server plus the credential it keyed, in the two separate
      // tables production kept them in.
      await su.query(
        `INSERT INTO remote_mcp_server (slug, name, url, auth_kind, auth_name, created_by)
         VALUES ('acme_remote', 'Acme', 'https://mcp.acme.example', 'bearer', 'Authorization', $1)`,
        [ownerId],
      );
      for (const [provider, label] of [
        ["acme_remote", "the remote server's own credential"],
        ["google", "an unrelated connector that must survive"],
      ]) {
        await su.query(
          `INSERT INTO connector_config (provider, ciphertext, iv, auth_tag, enabled_by)
           VALUES ($1, $2, 'iv', 'tag', $3)`,
          [provider, label, ownerId],
        );
      }
    } finally {
      await su.end();
    }
    // The busy service account authored a real object — the thing that must
    // make 0059 choose revoke over delete.
    await writer.write({ actorId: busySvc, scopes: ["read", "write"] }, { title: "bot digest" });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("revokes every service account and strips its tags, without deleting the row", async () => {
    const owner = await brain.connect("owner");
    const su = await brain.connect("superuser");
    try {
      const { runMigrations } = await import("@brain/schema");
      // 0059 and everything appended after it — a literal ["0059"] here broke
      // main the day 0060 landed, which is exactly the drift the seed-split
      // comment at the top of this file warns about.
      expect(await runMigrations(owner, MIGRATIONS)).toEqual(
        MIGRATIONS.slice(MIGRATIONS.findIndex((m) => m.version === "0059")).map((m) => m.version),
      );

      // BOTH are revoked in place with their token cleared — that is what
      // actually stops them authenticating. Neither row is deleted: an account
      // can be the author of objects and the actor of audit events, and a
      // trail that cannot say who wrote something is worse than one naming a
      // retired account.
      const rows = await su.query<{ id: string; status: string; token_hash: string | null }>(
        "SELECT id, status, token_hash FROM accounts WHERE id = ANY($1) ORDER BY email",
        [[cleanSvc, busySvc]],
      );
      expect(rows.rows).toHaveLength(2);
      for (const r of rows.rows) {
        expect(r, `${r.id} must be revoked and tokenless`).toMatchObject({
          status: "revoked",
          token_hash: null,
        });
      }
      // …and the object the busy one authored is untouched.
      expect(
        (await su.query("SELECT 1 FROM objects WHERE created_by = $1", [busySvc])).rows.length,
        "its objects must survive — those rows are content, the account is not",
      ).toBeGreaterThan(0);

      // Neither holds tags any more: a retired account holds no capability,
      // even though its row and its history survive.
      expect(
        (
          await su.query("SELECT 1 FROM account_tags WHERE account_id = ANY($1)", [
            [cleanSvc, busySvc],
          ])
        ).rows,
      ).toHaveLength(0);

      // The column and both provisioning functions are gone.
      expect(
        (
          await su.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = 'accounts' AND column_name = 'is_service'`,
          )
        ).rows,
      ).toHaveLength(0);
      const fns = await su.query<{ proname: string }>(
        `SELECT proname FROM pg_proc
          WHERE proname IN ('brain_provision_teammate', 'brain_teammate_token')`,
      );
      expect(fns.rows).toHaveLength(0);
    } finally {
      await owner.end();
      await su.end();
    }
  }, 120_000);

  it("sweeps the remote credential before the table naming it is dropped", async () => {
    const su = await brain.connect("superuser");
    try {
      const providers = await su.query<{ provider: string }>(
        "SELECT provider FROM connector_config ORDER BY provider",
      );
      // The remote server's credential is gone; the unrelated one is untouched.
      // If the drop had come first, 'acme_remote' would still be sitting here
      // as an encrypted blob nothing could ever attribute.
      expect(providers.rows.map((r) => r.provider)).toEqual(["google"]);

      for (const t of ["remote_mcp_server", "remote_mcp_tools_cache", "remote_mcp_member_ack"]) {
        const reg = await su.query<{ oid: string | null }>("SELECT to_regclass($1) AS oid", [t]);
        expect(reg.rows[0]!.oid, `${t} must be dropped`).toBeNull();
      }
    } finally {
      await su.end();
    }
  });

  it("brain_tag_grant still runs after the column its body used to read is gone", async () => {
    // plpgsql resolves column references at RUNTIME. Dropping is_service without
    // replacing this function would leave it compiling fine and failing the
    // first time an owner granted a custom tag — on a box, silently, long after
    // this migration reported success.
    const owner = await brain.connect("owner");
    try {
      await owner.query("SELECT set_config('app.actor_id', $1, false)", [ownerId]);
      await owner.query("SELECT brain_tag_create('pricing')");
      await owner.query("SELECT brain_tag_grant('pricing', $1)", [ownerId]);
      const held = await owner.query(
        `SELECT 1 FROM account_tags at JOIN tags t ON t.id = at.tag_id
          WHERE t.slug = 'pricing' AND at.account_id = $1`,
        [ownerId],
      );
      expect(held.rows).toHaveLength(1);
      // Its surviving refusal still bites.
      await expect(
        owner.query("SELECT brain_tag_grant('olive-personal', $1)", [ownerId]),
      ).rejects.toThrow();
    } finally {
      await owner.end();
    }
  });

  it("re-applying 0059 is a guarded no-op (the canary-rollback case)", async () => {
    const su = await brain.connect("superuser");
    try {
      const notices = await reapply(su, "0059");
      // Every step must announce that it skipped rather than silently succeed —
      // a quiet re-run cannot tell "guard held" from "guard never ran".
      expect(notices.join("\n")).toMatch(/remote_mcp_server is already gone/i);
      expect(notices.join("\n")).toMatch(/is_service already dropped/i);
      // …and it did not resurrect anything or eat the surviving connector.
      const providers = await su.query<{ provider: string }>(
        "SELECT provider FROM connector_config",
      );
      expect(providers.rows.map((r) => r.provider)).toEqual(["google"]);
    } finally {
      await su.end();
    }
  });
});
