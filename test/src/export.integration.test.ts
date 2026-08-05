import type { Client } from "pg";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaExecutor, auditPrivileges, junctionTableName } from "@brain/schema";
import { Admin, FsStore, Writer, type WriteContext } from "@brain/mcp-tools";
import { exportBrain, importBrain, type BrainExport } from "@brain/cli";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

const SYSTEM = "00000000-0000-0000-0000-000000000000";
const CTX: WriteContext = { actorId: SYSTEM, scopes: ["write"] };

async function count(c: Client, sql: string, params: unknown[] = []): Promise<number> {
  const r = await c.query<{ n: string }>(sql, params);
  return Number(r.rows[0]!.n);
}

/**
 * Count under the txn-local `app.fs_dr` escape (fs_versions is FORCE-RLS, so
 * even brain_owner sees nothing without it). Transaction-local on purpose: a
 * session-level `SET` would leak into importBrain and mask a missing escape.
 */
async function fsDrCount(c: Client, sql: string): Promise<number> {
  await c.query("BEGIN");
  try {
    await c.query("SET LOCAL app.fs_dr = 'on'");
    return await count(c, sql);
  } finally {
    await c.query("COMMIT");
  }
}

/** Every event row as stable text (seq/actor/at preservation is the point). */
async function eventRows(c: Client): Promise<Record<string, string | null>[]> {
  const r = await c.query<Record<string, string | null>>(
    `SELECT seq::text AS seq, actor::text AS actor, at::text AS at, kind, target::text AS target
       FROM events ORDER BY seq`,
  );
  return r.rows;
}

describe("export + round-trip import", () => {
  let source: FreshBrain;
  let target: FreshBrain | undefined;
  let sourcePool: Pool;

  beforeEach(async () => {
    source = await createFreshBrain();
    sourcePool = new Pool(source.appConfig);
  }, 120_000);

  afterEach(async () => {
    await sourcePool?.end();
    await source?.drop();
    await target?.drop();
  });

  it("exports the whole brain and re-hydrates it byte-for-byte into a fresh box", async () => {
    // ---- build a rich source brain --------------------------------------
    const ownerS = await source.connect("owner");
    const exec = new SchemaExecutor(ownerS);
    const writer = new Writer(sourcePool);

    // types: person, and a client that refs person by scalar ref + ref[].
    const person = await exec.defineType({ name: "person" }, SYSTEM);
    await exec.addProperty({ typeId: person.typeId, name: "fullname", kind: "text" }, SYSTEM);
    const client = await exec.defineType({ name: "client" }, SYSTEM);
    await exec.addProperty({ typeId: client.typeId, name: "tier", kind: "text" }, SYSTEM);
    await exec.addProperty(
      { typeId: client.typeId, name: "status", kind: "enum", enumValues: ["open", "won"] },
      SYSTEM,
    );
    await exec.addProperty(
      { typeId: client.typeId, name: "lead", kind: "ref", refTypeName: "person" },
      SYSTEM,
    );
    await exec.addProperty(
      { typeId: client.typeId, name: "members", kind: "ref[]", refTypeName: "person" },
      SYSTEM,
    );

    // data: an untyped note (to be soft-deleted), a person, and a client.
    const note = await writer.write(CTX, { title: "Memo", body: "a memo about bananas" });
    const alice = await writer.write(CTX, {
      type: "person",
      title: "Alice",
      props: { fullname: "Alice Anderson" },
    });
    const acme = await writer.write(CTX, {
      type: "client",
      title: "Acme",
      body: "acme sells pineapples worldwide",
      props: { tier: "gold", status: "open", lead: alice.id },
    });
    // an edit → an 'update' event + a version bump + regenerated ext tsv.
    await writer.edit(CTX, acme.id, { version: acme.version, props: { status: "won" } });

    // a manual edge, a ref[] member, a before_image snapshot (owner-side DML).
    // Under tag governance a bare brain_owner connection holds no tags and the
    // edges/before_image policies ride on objects' visibility, so this raw
    // seeding runs inside the txn-local DR escape (never session-level — that
    // would leak into exportBrain below and mask a missing escape there).
    const membersJunction = junctionTableName(client.physicalName, "members");
    await ownerS.query("BEGIN");
    await ownerS.query("SET LOCAL app.fs_dr = 'on'");
    await ownerS.query(
      "INSERT INTO edges (from_id, rel, to_id, provenance) VALUES ($1, 'relates_to', $2, 'manual')",
      [acme.id, alice.id],
    );
    await ownerS.query(`INSERT INTO ${membersJunction} (from_id, to_id) VALUES ($1, $2)`, [
      acme.id,
      alice.id,
    ]);
    await ownerS.query(
      `INSERT INTO before_image (object_id, version, snapshot, "by")
       VALUES ($1, 1, $2::jsonb, $3)`,
      [acme.id, JSON.stringify({ title: "Acme", status: "open" }), SYSTEM],
    );
    await ownerS.query("COMMIT");

    // soft-delete the note (stays in the spine, deleted_at set).
    await writer.softDelete(CTX, note.id);

    // the brain filesystem (0037): a binary /shared file (NUL + high bytes
    // probe the bytea→text→bytea round-trip) and a PRIVATE home file — home
    // rows sit behind FORCE RLS and are the easy thing for an export to lose.
    const srcStore = new FsStore(sourcePool);
    const blob = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x0a, 0x0d, 0x00]);
    await srcStore.write({ actorId: SYSTEM }, "/shared/dr/probe.bin", blob, "application/pdf");
    const sysSlug = await srcStore.homeSlug(SYSTEM);
    await srcStore.write(
      { actorId: SYSTEM },
      `/home/${sysSlug}/private-note.txt`,
      Buffer.from("home rows must survive DR"),
    );

    // ---- capture source truth -------------------------------------------
    // txn-local escape again: post-0057 a bare owner connection sees no
    // objects/edges rows at all, not just no fs/home rows.
    await ownerS.query("BEGIN");
    await ownerS.query("SET LOCAL app.fs_dr = 'on'");
    const srcCounts = {
      objects: await count(ownerS, "SELECT count(*) n FROM objects"),
      types: await count(ownerS, "SELECT count(*) n FROM types"),
      edges: await count(ownerS, "SELECT count(*) n FROM edges"),
      events: await count(ownerS, "SELECT count(*) n FROM events"),
      before_image: await count(ownerS, "SELECT count(*) n FROM before_image"),
      members: await count(ownerS, `SELECT count(*) n FROM ${membersJunction}`),
    };
    const srcAcmeBody = (
      await ownerS.query<{ body: string }>("SELECT body FROM objects WHERE id = $1", [acme.id])
    ).rows[0]!.body;
    const srcAcmeExt = (
      await ownerS.query<{ tier: string; status: string; lead: string }>(
        "SELECT tier, status, lead::text AS lead FROM client_ext WHERE id = $1",
        [acme.id],
      )
    ).rows[0]!;
    const srcEvents = await eventRows(ownerS);
    const srcFs = {
      entries: await count(ownerS, "SELECT count(*) n FROM fs_entries"),
      homes: await count(ownerS, "SELECT count(*) n FROM fs_homes"),
      usage: await count(ownerS, "SELECT total_bytes n FROM fs_usage"),
    };
    await ownerS.query("COMMIT");

    // ---- export ----------------------------------------------------------
    const live = await exportBrain(ownerS);
    // prove the envelope survives a JSON file round-trip.
    const data: BrainExport = JSON.parse(JSON.stringify(live));
    await ownerS.end();

    // ---- import into a brand-new fresh brain -----------------------------
    target = await createFreshBrain();
    const ownerT = await target.connect("owner");
    try {
      await importBrain(ownerT, data);

      // The import is done, so a session-level escape can no longer mask a
      // missing one inside it — and every raw readback below (objects, edges,
      // fs) needs it now that a bare owner connection holds no tags.
      await ownerT.query("SET app.fs_dr = 'on'");

      // counts match exactly
      expect({
        objects: await count(ownerT, "SELECT count(*) n FROM objects"),
        types: await count(ownerT, "SELECT count(*) n FROM types"),
        edges: await count(ownerT, "SELECT count(*) n FROM edges"),
        events: await count(ownerT, "SELECT count(*) n FROM events"),
        before_image: await count(ownerT, "SELECT count(*) n FROM before_image"),
        members: await count(ownerT, `SELECT count(*) n FROM ${membersJunction}`),
      }).toEqual(srcCounts);

      // the client's body + typed props are byte-identical
      const tgtAcmeBody = (
        await ownerT.query<{ body: string }>("SELECT body FROM objects WHERE id = $1", [acme.id])
      ).rows[0]!.body;
      expect(tgtAcmeBody).toBe(srcAcmeBody);
      const tgtAcmeExt = (
        await ownerT.query<{ tier: string; status: string; lead: string }>(
          "SELECT tier, status, lead::text AS lead FROM client_ext WHERE id = $1",
          [acme.id],
        )
      ).rows[0]!;
      expect(tgtAcmeExt).toEqual(srcAcmeExt);
      expect(tgtAcmeExt.status).toBe("won"); // the edit survived
      expect(tgtAcmeExt.lead).toBe(alice.id); // the ref FK value survived

      // the ref[] member + the manual edge came across
      expect(
        await count(ownerT, `SELECT count(*) n FROM ${membersJunction} WHERE from_id = $1`, [
          acme.id,
        ]),
      ).toBe(1);
      expect(
        await count(
          ownerT,
          "SELECT count(*) n FROM edges WHERE from_id = $1 AND provenance = 'manual'",
          [acme.id],
        ),
      ).toBe(1);

      // the soft-deleted note is still soft-deleted
      const del = await ownerT.query<{ deleted_at: Date | null }>(
        "SELECT deleted_at FROM objects WHERE id = $1",
        [note.id],
      );
      expect(del.rows[0]!.deleted_at).not.toBeNull();

      // every event's seq + actor + at (+ kind/target) is preserved verbatim
      expect(await eventRows(ownerT)).toEqual(srcEvents);

      // before_image snapshot preserved (id preserved via OVERRIDING)
      const bi = await ownerT.query<{ snapshot: string; version: string }>(
        `SELECT snapshot::text AS snapshot, version::text AS version
           FROM before_image WHERE object_id = $1`,
        [acme.id],
      );
      expect(bi.rows[0]!.version).toBe("1");
      expect(JSON.parse(bi.rows[0]!.snapshot)).toEqual({ title: "Acme", status: "open" });

      // tsv preserved: full-text search still finds a body word AND an ext prop
      expect(
        await count(
          ownerT,
          "SELECT count(*) n FROM objects WHERE tsv @@ websearch_to_tsquery('english', 'pineapples')",
        ),
      ).toBe(1);
      expect(
        await count(
          ownerT,
          "SELECT count(*) n FROM client_ext WHERE tsv @@ websearch_to_tsquery('english', 'gold')",
        ),
      ).toBe(1);

      // the privilege model survived the restore (the DR re-assert)
      const audit = await auditPrivileges(ownerT);
      expect(
        audit.ok,
        `privilege violations:\n${audit.violations.map((v) => ` - ${v.name}: ${v.detail}`).join("\n")}`,
      ).toBe(true);

      // the filesystem round-tripped: counts + recomputed usage match…
      expect({
        entries: await count(ownerT, "SELECT count(*) n FROM fs_entries"),
        homes: await count(ownerT, "SELECT count(*) n FROM fs_homes"),
        usage: await count(ownerT, "SELECT total_bytes n FROM fs_usage"),
      }).toEqual(srcFs);

      // and the imported brain is still writable end-to-end (triggers re-armed):
      // a new note gets a fresh event seq beyond the imported max.
      const tgtPool = new Pool(target.appConfig);
      try {
        const w = new Writer(tgtPool);
        const fresh = await w.write(CTX, { body: "post-import write" });
        expect(fresh.version).toBe(1);
        const ev = await count(ownerT, "SELECT count(*) n FROM events WHERE target = $1", [
          fresh.id,
        ]);
        expect(ev).toBe(1);

        // …and the bytes are intact through the real store (RLS path): the
        // binary /shared file and the private home file both read back.
        const tgtStore = new FsStore(tgtPool);
        const shared = await tgtStore.read({ actorId: SYSTEM }, "/shared/dr/probe.bin");
        expect(shared.bytes.equals(blob)).toBe(true);
        expect(shared.meta.mime).toBe("application/pdf");
        const home = await tgtStore.read({ actorId: SYSTEM }, `/home/${sysSlug}/private-note.txt`);
        expect(home.bytes.toString()).toBe("home rows must survive DR");
      } finally {
        await tgtPool.end();
      }
    } finally {
      await ownerT.end();
    }
  });

  /**
   * 0043 regression: the export used to dump ONLY fs_homes + fs_entries, so a
   * DR restore silently threw away every file version, the whole trash (a
   * deleted file's only copy lives in fs_versions), and members' private /home
   * history — a data-loss bug that no count check caught because the live tree
   * still matched. The envelope now carries fs_versions and the import reloads
   * it under the same app.fs_dr escape, with RLS still hiding one member's
   * home snapshots from another.
   */
  it("carries fs_versions through DR: history, trash and locks re-hydrate", async () => {
    const ownerS = await source.connect("owner");
    const admin = new Admin(sourcePool);
    const alice = (await admin.bootstrapOwner({ name: "alice", email: "alice@example.com" })).id;
    const bob = (
      await admin.createUser(alice, { name: "bob", email: "bob@example.com", permission: "member" })
    ).id;
    const srcStore = new FsStore(sourcePool);
    const aliceCtx = { actorId: alice, isOwner: true };
    const bobCtx = { actorId: bob };

    // /shared history: three writes ⇒ two overwrite snapshots (v1, v2).
    await srcStore.write(aliceCtx, "/shared/dr/doc.md", Buffer.from("v1 the first draft"));
    await srcStore.write(aliceCtx, "/shared/dr/doc.md", Buffer.from("v2 the second draft"));
    await srcStore.write(aliceCtx, "/shared/dr/doc.md", Buffer.from("v3 the live one"));
    // /shared trash: the deleted file's ONLY surviving copy is its snapshot.
    await srcStore.write(aliceCtx, "/shared/dr/gone.txt", Buffer.from("deleted but recoverable"));
    await srcStore.rm(aliceCtx, "/shared/dr/gone.txt");
    // a lock (fs_entries columns, already generic — pinned here so DR keeps it).
    await srcStore.write(aliceCtx, "/shared/dr/locked.txt", Buffer.from("hold still"));
    await srcStore.lock(bobCtx, "/shared/dr/locked.txt");
    // A genuinely BINARY trash entry: every one of the 256 byte values, so the
    // ::text round-trip is exercised over NUL, the bytea escape byte (0x5c),
    // quotes and invalid-UTF-8 sequences rather than tidy ASCII. Silent
    // corruption here would be the same data loss wearing a different hat.
    // (An rm snapshots unconditionally; overwrite snapshots are text-ish only,
    // so the trash is the only place binary bytes ever enter fs_versions.)
    const blob = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await srcStore.write(aliceCtx, "/shared/dr/blob.bin", blob);
    await srcStore.rm(aliceCtx, "/shared/dr/blob.bin");
    // bob's PRIVATE home: history + trash behind FORCE RLS.
    const bobSlug = await srcStore.homeSlug(bob);
    await srcStore.write(bobCtx, `/home/${bobSlug}/secret.md`, Buffer.from("bob draft one"));
    await srcStore.write(bobCtx, `/home/${bobSlug}/secret.md`, Buffer.from("bob draft two"));
    await srcStore.write(bobCtx, `/home/${bobSlug}/oops.md`, Buffer.from("bob deleted this"));
    await srcStore.rm(bobCtx, `/home/${bobSlug}/oops.md`);

    await ownerS.query("SET app.fs_dr = 'on'");
    const srcVersions = await count(ownerS, "SELECT count(*) n FROM fs_versions");
    expect(srcVersions).toBe(6); // 2 doc overwrites + gone + blob + secret overwrite + oops

    const data: BrainExport = JSON.parse(JSON.stringify(await exportBrain(ownerS)));
    await ownerS.end();
    expect(Object.keys(data.fs ?? {})).toContain("versions");

    target = await createFreshBrain();
    const ownerT = await target.connect("owner");
    const tgtPool = new Pool(target.appConfig);
    try {
      await importBrain(ownerT, data);
      await ownerT.query("SET app.fs_dr = 'on'");
      expect(await count(ownerT, "SELECT count(*) n FROM fs_versions")).toBe(srcVersions);
      // the FKs to accounts resolve — no orphaned snapshots
      expect(
        await count(
          ownerT,
          `SELECT count(*) n FROM fs_versions v
             WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = v.edited_by)
                OR (v.owner_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = v.owner_id))`,
        ),
      ).toBe(0);

      const tgt = new FsStore(tgtPool);
      // /shared history came back, bytes and all
      expect(
        (await tgt.versionList(aliceCtx, "/shared/dr/doc.md")).map((v) => v.version_no),
      ).toEqual([2, 1]);
      expect((await tgt.versionContent(aliceCtx, "/shared/dr/doc.md", 1)).toString()).toBe(
        "v1 the first draft",
      );
      // the trash is still offered — and restore really un-deletes it
      expect((await tgt.listTrash(aliceCtx)).map((t) => t.path)).toContain("/shared/dr/gone.txt");
      await tgt.restore(aliceCtx, "/shared/dr/gone.txt");
      expect((await tgt.read(aliceCtx, "/shared/dr/gone.txt")).bytes.toString()).toBe(
        "deleted but recoverable",
      );
      // the lock survived
      expect((await tgt.lockInfo(aliceCtx, "/shared/dr/locked.txt"))?.lockedBy).toBe(bob);
      // the BINARY trash entry came back byte-for-byte (all 256 values, NUL included)
      expect((await tgt.listTrash(aliceCtx)).map((t) => t.path)).toContain("/shared/dr/blob.bin");
      await tgt.restore(aliceCtx, "/shared/dr/blob.bin");
      expect(Buffer.compare((await tgt.read(aliceCtx, "/shared/dr/blob.bin")).bytes, blob)).toBe(0);

      // bob's private history + trash survived FOR BOB…
      expect(await tgt.versionList(bobCtx, `/home/${bobSlug}/secret.md`)).toHaveLength(1);
      expect((await tgt.versionContent(bobCtx, `/home/${bobSlug}/secret.md`, 1)).toString()).toBe(
        "bob draft one",
      );
      expect((await tgt.listTrash(bobCtx)).map((t) => t.path)).toContain(
        `/home/${bobSlug}/oops.md`,
      );
      // …and RLS still hides it from everyone else, org owner included.
      expect(await tgt.versionList(aliceCtx, `/home/${bobSlug}/secret.md`)).toEqual([]);
      expect((await tgt.listTrash(aliceCtx)).map((t) => t.path)).not.toContain(
        `/home/${bobSlug}/oops.md`,
      );
    } finally {
      await tgtPool.end();
      await ownerT.end();
    }
  });

  /**
   * 0043 regression, the OTHER half — the fs_homes-FK bug recurring on a new
   * table. importBrain empties fs_entries + fs_homes before `DELETE FROM
   * accounts` precisely because the filesystem hangs off accounts. fs_versions
   * (owner_id + edited_by → accounts) joined that surface in 0043, so it must
   * be emptied too: without it ANY restore target whose filesystem was ever
   * overwritten or deleted from — one snapshot is enough, no objects or events
   * needed — fails the whole import with
   *   update or delete on table "accounts" violates foreign key constraint
   *   "fs_versions_edited_by_fkey" on table "fs_versions"
   * i.e. a box that has merely been USED can no longer be restored into.
   * Deleting (not preserving) the target's rows is the point: the restored
   * brain's accounts replace the target's, so target-side snapshots would be
   * orphaned bytes from a DIFFERENT brain — leaving them is a content leak.
   */
  it("restores into a target whose own filesystem already has version rows", async () => {
    const sysCtx = { actorId: SYSTEM };
    const ownerS = await source.connect("owner");
    const srcStore = new FsStore(sourcePool);
    await srcStore.write(sysCtx, "/shared/dr/keep.md", Buffer.from("source v1"));
    await srcStore.write(sysCtx, "/shared/dr/keep.md", Buffer.from("source v2"));
    const srcVersions = await fsDrCount(ownerS, "SELECT count(*) n FROM fs_versions");
    expect(srcVersions).toBe(1);
    const data: BrainExport = JSON.parse(JSON.stringify(await exportBrain(ownerS)));
    await ownerS.end();

    // The target is a fresh box that has simply been USED: one overwrite and
    // one delete, whose snapshots' edited_by points at ITS OWN accounts.
    target = await createFreshBrain();
    const tgtPool = new Pool(target.appConfig);
    const ownerT = await target.connect("owner");
    try {
      const tgtStore = new FsStore(tgtPool);
      await tgtStore.write(sysCtx, "/shared/target-only.md", Buffer.from("target v1"));
      await tgtStore.write(sysCtx, "/shared/target-only.md", Buffer.from("target v2"));
      await tgtStore.write(sysCtx, "/shared/target-trash.md", Buffer.from("target trash"));
      await tgtStore.rm(sysCtx, "/shared/target-trash.md");
      expect(await fsDrCount(ownerT, "SELECT count(*) n FROM fs_versions")).toBe(2);

      // …and the fs_versions → accounts FK must not block the accounts swap.
      await importBrain(ownerT, data);

      // Exactly the source's history — and none of the target's own rows.
      expect(await fsDrCount(ownerT, "SELECT count(*) n FROM fs_versions")).toBe(srcVersions);
      expect(
        await fsDrCount(
          ownerT,
          "SELECT count(*) n FROM fs_versions WHERE path LIKE '/shared/target-%'",
        ),
      ).toBe(0);
      const tgt = new FsStore(tgtPool);
      expect((await tgt.versionContent(sysCtx, "/shared/dr/keep.md", 1)).toString()).toBe(
        "source v1",
      );
      expect((await tgt.listTrash(sysCtx)).map((t) => t.path)).not.toContain(
        "/shared/target-trash.md",
      );
    } finally {
      await tgtPool.end();
      await ownerT.end();
    }
  });
});
