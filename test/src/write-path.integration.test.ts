import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor } from "@brain/schema";
import {
  VersionConflictError,
  Writer,
  attachOrigin,
  parseOrigin,
  type WriteContext,
} from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const CTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };

/** Verification read on an owner client. Since 0057 a bare brain_owner sees no
 *  objects/ext/edges rows (audience RLS); the txn-local DR escape is the
 *  sanctioned way for brain_owner to read everything. */
async function withDr<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL app.fs_dr = 'on'");
    const r = await fn();
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

describe("write middleware", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let writer: Writer;

  beforeEach(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    writer = new Writer(pool);
  }, 120_000);

  afterEach(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("writes a note and bumps version from 1", async () => {
    const r = await writer.write(CTX, { title: "hi", body: "a searchable note" });
    expect(r.version).toBe(1);
    const owner = await brain.connect("owner");
    try {
      const ev = await owner.query("SELECT 1 FROM events WHERE target = $1 AND kind = 'create'", [
        r.id,
      ]);
      expect(ev.rowCount).toBe(1);
    } finally {
      await owner.end();
    }
  });

  it("writes a typed object with props (ext row populated)", async () => {
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "seats", kind: "int" }, SYSTEM);
    try {
      const r = await writer.write(CTX, {
        type: "client",
        title: "Acme",
        props: { tier: "gold", seats: 42 },
      });
      const ext = await withDr(owner, () =>
        owner.query<{ tier: string; seats: string }>(
          "SELECT tier, seats FROM client_ext WHERE id = $1",
          [r.id],
        ),
      );
      expect(ext.rows[0]).toMatchObject({ tier: "gold", seats: "42" });
    } finally {
      await owner.end();
    }
  });

  it("enforces required props at the write path (teaching error)", async () => {
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty(
      { typeId: t.typeId, name: "tier", kind: "text", required: true },
      SYSTEM,
    );
    await owner.end();
    await expect(writer.write(CTX, { type: "client", props: {} })).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("append is version-free; set/find_replace are version-guarded", async () => {
    const w = await writer.write(CTX, { body: "a" });
    const a = await writer.edit(CTX, w.id, { bodyOps: [{ op: "append", text: "b" }] });
    expect(a.version).toBe(2);
    const owner = await brain.connect("owner");
    try {
      const b = await withDr(owner, () =>
        owner.query<{ body: string }>("SELECT body FROM objects WHERE id = $1", [w.id]),
      );
      // append concatenates literally — no separator injected
      expect(b.rows[0]!.body).toBe("ab");
    } finally {
      await owner.end();
    }
    // set with the right version works; stale version conflicts
    await writer.edit(CTX, w.id, { version: 2, bodyOps: [{ op: "set", text: "Z" }] });
    await expect(
      writer.edit(CTX, w.id, { version: 2, bodyOps: [{ op: "set", text: "Y" }] }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("lost update: concurrent edits at the same base version — one conflicts", async () => {
    const w = await writer.write(CTX, { body: "base" });
    const [r1, r2] = await Promise.allSettled([
      writer.edit(CTX, w.id, { version: 1, bodyOps: [{ op: "set", text: "one" }] }),
      writer.edit(CTX, w.id, { version: 1, bodyOps: [{ op: "set", text: "two" }] }),
    ]);
    const outcomes = [r1.status, r2.status].sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
  });

  it("edit(props) is a partial patch — other fields stay byte-identical", async () => {
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "a", kind: "text" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "b", kind: "text" }, SYSTEM);
    try {
      const r = await writer.write(CTX, { type: "client", props: { a: "x", b: "y" } });
      await writer.edit(CTX, r.id, { version: r.version, props: { a: "z" } });
      const ext = await withDr(owner, () =>
        owner.query<{ a: string; b: string }>("SELECT a, b FROM client_ext WHERE id = $1", [r.id]),
      );
      expect(ext.rows[0]).toEqual({ a: "z", b: "y" }); // b unchanged
    } finally {
      await owner.end();
    }
  });

  it("find_replace guards the occurrence count", async () => {
    const w = await writer.write(CTX, { body: "foo foo bar" });
    await expect(
      writer.edit(CTX, w.id, {
        version: 1,
        bodyOps: [{ op: "find_replace", find: "foo", replace: "baz", expectCount: 1 }],
      }),
    ).rejects.toMatchObject({ code: "validation" });
    const ok = await writer.edit(CTX, w.id, {
      version: 1,
      bodyOps: [{ op: "find_replace", find: "foo", replace: "baz", expectCount: 2 }],
    });
    expect(ok.version).toBe(2);
  });

  it("idempotency: a replay returns the stored result and does NOT re-execute", async () => {
    const r1 = await writer.write({ ...CTX, idempotencyKey: "k1" }, { body: "once" });
    const r2 = await writer.write({ ...CTX, idempotencyKey: "k1" }, { body: "once" });
    expect(r2).toEqual(r1);
    const owner = await brain.connect("owner");
    try {
      const cnt = await withDr(owner, () =>
        owner.query("SELECT count(*)::int AS n FROM objects WHERE body = 'once'"),
      );
      expect(cnt.rows[0]!.n).toBe(1); // exactly one, not two
    } finally {
      await owner.end();
    }
  });

  it("per-token budget trips with a teaching error", async () => {
    const tight = new Writer(pool, {
      budget: {
        maxMutationsPerWindow: 2,
        windowSeconds: 60,
        maxBodyBytes: 1_048_576,
        maxTitleBytes: 4_096,
      },
    });
    await tight.write(CTX, { body: "1" });
    await tight.write(CTX, { body: "2" });
    await expect(tight.write(CTX, { body: "3" })).rejects.toMatchObject({ code: "refused" });
  });

  it("write-shed rejects writes while reads keep working", async () => {
    const shed = new Writer(pool, { diskGuard: async () => ({ shed: true }) });
    await expect(shed.write(CTX, { body: "nope" })).rejects.toMatchObject({ code: "refused" });
  });

  it("a read-only token cannot write", async () => {
    const ro: WriteContext = { actorId: SYSTEM, scopes: ["read"] };
    await expect(writer.write(ro, { body: "x" })).rejects.toMatchObject({ code: "refused" });
  });

  it("soft-delete then restore; editing a tombstone is not_found", async () => {
    const w = await writer.write(CTX, { body: "doomed" });
    await writer.softDelete(CTX, w.id);
    const owner = await brain.connect("owner");
    try {
      const d = await withDr(owner, () =>
        owner.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM objects WHERE id = $1", [
          w.id,
        ]),
      );
      expect(d.rows[0]!.deleted_at).not.toBeNull();
    } finally {
      await owner.end();
    }
    await expect(
      writer.edit(CTX, w.id, { version: 2, bodyOps: [{ op: "set", text: "x" }] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await writer.restore(CTX, w.id);
    const okEdit = await writer.edit(CTX, w.id, { bodyOps: [{ op: "append", text: "!" }] });
    expect(okEdit.version).toBeGreaterThan(2);
  });

  // ------------------------------------------------------------------ p1-t2
  // Workspace UI write core: typed CAS conflict, origin tokens, client-minted
  // idempotency keys, field-granular edit.

  /** A second live member, so cross-actor behaviour is tested for real (RLS is
   *  the boundary here — not an application check we could stub). */
  async function makeMember(name: string): Promise<string> {
    const owner = await brain.connect("owner");
    try {
      const r = await owner.query<{ id: string }>(
        `INSERT INTO accounts (name, role, scopes, status)
         VALUES ($1, 'member', ARRAY['read','write']::text[], 'active') RETURNING id`,
        [name],
      );
      return r.rows[0]!.id;
    } finally {
      await owner.end();
    }
  }

  it("a version mismatch throws VersionConflictError carrying the current values", async () => {
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "tier", kind: "text" }, SYSTEM);
    await owner.end();

    const w = await writer.write(CTX, {
      type: "client",
      title: "before",
      body: "base",
      props: { tier: "gold" },
    });
    // someone else's write lands first
    await writer.edit(CTX, w.id, {
      version: 1,
      title: "after",
      bodyOps: [{ op: "set", text: "winner" }],
    });

    const err = await writer
      .edit(CTX, w.id, { version: 1, bodyOps: [{ op: "set", text: "loser" }] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(VersionConflictError);
    const conflict = err as VersionConflictError;
    expect(conflict.code).toBe("conflict"); // still the shipped taxonomy
    expect(conflict.currentVersion).toBe(2);
    expect(conflict.current.title).toBe("after");
    expect(conflict.current.body).toBe("winner");
    expect(conflict.current.props).toEqual({ tier: "gold" });
    expect(Date.parse(conflict.current.updated_at)).not.toBeNaN();
    expect(conflict.current.actor_name).toBe("system");
    // the snapshot rides its own field, never the teaching details
    expect(JSON.stringify(conflict.toJSON())).not.toContain("winner");
  });

  it("a version mismatch on an object the actor cannot see is not_found, never conflict", async () => {
    const mallory = await makeMember("mallory");
    const secret = await writer.write(CTX, { body: "mine", visibility: "private" });
    await writer.edit(CTX, secret.id, { version: 1, bodyOps: [{ op: "set", text: "mine v2" }] });

    // A stale version AND an invisible object: answering 409 would confirm both
    // that it exists and how fast it is changing.
    const err = await writer
      .edit({ actorId: mallory, scopes: ["write"] }, secret.id, {
        version: 1,
        bodyOps: [{ op: "set", text: "peek" }],
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toMatchObject({ code: "not_found" });
    expect(err).not.toBeInstanceOf(VersionConflictError);
  });

  it("editFields: a null prop value deletes that key and leaves its siblings alone", async () => {
    const owner = await brain.connect("owner");
    const exec = new SchemaExecutor(owner);
    const t = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "a", kind: "text" }, SYSTEM);
    await exec.addProperty({ typeId: t.typeId, name: "b", kind: "text" }, SYSTEM);
    try {
      const r = await writer.write(CTX, { type: "client", props: { a: "x", b: "y" } });
      const after = await writer.editFields(CTX, r.id, {
        baseVersion: 1,
        props: { a: null },
      });
      expect(after.version).toBe(2);
      const ext = await withDr(owner, () =>
        owner.query<{ a: string | null; b: string | null }>(
          "SELECT a, b FROM client_ext WHERE id = $1",
          [r.id],
        ),
      );
      expect(ext.rows[0]).toEqual({ a: null, b: "y" }); // b untouched
    } finally {
      await owner.end();
    }
  });

  it("editFields: body is version-guarded (a stale baseVersion loses)", async () => {
    const w = await writer.write(CTX, { body: "one" });
    await writer.editFields(CTX, w.id, { baseVersion: 1, body: "two" });
    await expect(
      writer.editFields(CTX, w.id, { baseVersion: 1, body: "three" }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("a replayed idempotencyKey returns the stored result without a second write", async () => {
    const key = randomUUID();
    const first = await writer.write(CTX, { body: "intent", idempotencyKey: key });
    const replay = await writer.write(CTX, { body: "intent", idempotencyKey: key });
    expect(replay).toEqual(first);

    const owner = await brain.connect("owner");
    try {
      const n = await withDr(owner, () =>
        owner.query<{ n: number }>("SELECT count(*)::int AS n FROM objects WHERE body = 'intent'"),
      );
      expect(n.rows[0]!.n).toBe(1);
      // no second version bump: the replay performed no write at all
      const v = await withDr(owner, () =>
        owner.query<{ version: string }>("SELECT version FROM objects WHERE id = $1", [first.id]),
      );
      expect(Number(v.rows[0]!.version)).toBe(1);
      const ev = await owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM events WHERE target = $1 AND kind = 'create'",
        [first.id],
      );
      expect(ev.rows[0]!.n).toBe(1);
    } finally {
      await owner.end();
    }
  });

  it("a replayed idempotencyKey short-circuits BEFORE the write budget (an aggressive retry is never refused)", async () => {
    // A tight budget whose ceiling the first write alone reaches: one create
    // event >= maxMutationsPerWindow. This is the exact scenario the key exists
    // for — the client retries an already-committed write after a lost response,
    // and the retry must return the ORIGINAL result, not 'write budget exceeded'.
    const tight = new Writer(pool, {
      budget: {
        maxMutationsPerWindow: 1,
        windowSeconds: 60,
        maxBodyBytes: 1_048_576,
        maxTitleBytes: 4_096,
      },
    });
    const key = randomUUID();
    const first = await tight.write(CTX, { body: "retry-me", idempotencyKey: key });
    // The budget is now spent: a genuinely NEW write is refused, proving the
    // ceiling is truly reached (so the replay below is not passing by luck).
    await expect(tight.write(CTX, { body: "brand new" })).rejects.toMatchObject({
      code: "refused",
    });
    // The replay is a pure read, not a mutation — it returns the recorded result
    // rather than being gated by (or counting against) the budget.
    const replay = await tight.write(CTX, { body: "retry-me", idempotencyKey: key });
    expect(replay).toEqual(first);

    const owner = await brain.connect("owner");
    try {
      const n = await withDr(owner, () =>
        owner.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM objects WHERE body = 'retry-me'",
        ),
      );
      expect(n.rows[0]!.n).toBe(1); // exactly one, the replay wrote nothing
    } finally {
      await owner.end();
    }
  });

  it("the same idempotency key from a DIFFERENT actor never returns the first actor's result", async () => {
    const key = randomUUID();
    const mine = await writer.write(CTX, { body: "mine", idempotencyKey: key });
    const mallory = await makeMember("mallory");
    const theirs = await writer.write(
      { actorId: mallory, scopes: ["write"] },
      { body: "theirs", idempotencyKey: key },
    );
    // RLS makes the other actor's dedupe row invisible: a MISS, not a read.
    expect(theirs.id).not.toBe(mine.id);

    const owner = await brain.connect("owner");
    try {
      // cross-actor verification read — only the DR escape sees both rows
      const rows = await withDr(owner, () =>
        owner.query<{ body: string; created_by: string }>(
          "SELECT body, created_by FROM objects WHERE id = ANY($1) ORDER BY body",
          [[mine.id, theirs.id]],
        ),
      );
      expect(rows.rows.map((r) => r.body)).toEqual(["mine", "theirs"]);
    } finally {
      await owner.end();
    }
    // write_idempotency is FORCE RLS, so even brain_owner sees nothing without
    // an actor GUC — read the dedupe row as the superuser to prove exactly one
    // exists and that it belongs to the FIRST writer.
    const su = await brain.connect("superuser");
    try {
      const idem = await su.query<{ actor_id: string }>(
        "SELECT actor_id FROM write_idempotency WHERE key = $1",
        [key],
      );
      expect(idem.rows).toHaveLength(1);
      expect(idem.rows[0]!.actor_id).toBe(SYSTEM);
    } finally {
      await su.end();
    }
  });

  it("a replayed idempotencyKey on link returns the stored result and one edge", async () => {
    const a = await writer.write(CTX, { body: "a" });
    const b = await writer.write(CTX, { body: "b" });
    const key = randomUUID();
    const first = await writer.link(CTX, a.id, "mentions", b.id, { idempotencyKey: key });
    const replay = await writer.link(CTX, a.id, "mentions", b.id, { idempotencyKey: key });
    expect(replay).toEqual(first);
    const owner = await brain.connect("owner");
    try {
      const n = await withDr(owner, () =>
        owner.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM edges WHERE from_id = $1 AND to_id = $2",
          [a.id, b.id],
        ),
      );
      expect(n.rows[0]!.n).toBe(1);
    } finally {
      await owner.end();
    }
  });

  it("an originToken round-trips through the audit event's reason", async () => {
    const token = "room-42";
    const w = await writer.write(CTX, {
      body: "flushed",
      reason: "collab flush",
      originToken: token,
    });
    const owner = await brain.connect("owner");
    try {
      const ev = await owner.query<{ payload: { reason?: string } }>(
        "SELECT payload FROM events WHERE target = $1 AND kind = 'create'",
        [w.id],
      );
      const stored = ev.rows[0]!.payload.reason!;
      // the bridge recognises its OWN write from this value alone — never by
      // comparing content, which is what causes the echo loop
      expect(parseOrigin(stored)).toEqual({ reason: "collab flush", origin: token });
    } finally {
      await owner.end();
    }
  });

  it("parseOrigin returns a null origin for a plain reason, and rejects bad tokens", () => {
    expect(parseOrigin("just a reason")).toEqual({ reason: "just a reason", origin: null });
    expect(parseOrigin("")).toEqual({ reason: "", origin: null });
    expect(attachOrigin(undefined, "tok")).toBe("dashboard#tok");
    expect(parseOrigin(attachOrigin(undefined, "tok"))).toEqual({ reason: "", origin: "tok" });
    expect(() => attachOrigin("why", "not a token")).toThrow();
    expect(() => attachOrigin("why", "x".repeat(65))).toThrow();
  });
});
