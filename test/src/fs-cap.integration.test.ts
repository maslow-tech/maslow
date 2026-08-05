import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, FS_MAX_FILE_BYTES } from "@brain/schema";
import { Admin, FsStore, type FsCtx } from "@brain/mcp-tools";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The per-file cap is enforced in TWO places — a DB CHECK and the store's EFBIG
 * guard — and they must agree. A store cap above the DB's turns a teaching
 * error into a raw constraint violation surfacing as a 500; a store cap below
 * the DB's makes the database's cap dead code. Neither is visible from one side.
 *
 * 0060 raises the DB side from 25 MB to 100 MB, and it does so by finding
 * 0037's UNNAMED inline CHECK by its definition. That lookup is the part worth
 * testing against a brain that actually has the old constraint: on an empty
 * CI database the widen would "work" no matter what it matched.
 */
describe("fs per-file cap: 0060 widens the CHECK the store believes in", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ctx: FsCtx;
  let fs: FsStore;

  beforeAll(async () => {
    // Seed at 0059 so the OLD 25 MB inline CHECK from 0037 is really present.
    const upTo = MIGRATIONS.slice(
      0,
      MIGRATIONS.findIndex((m) => m.version === "0060"),
    );
    brain = await createFreshBrain(upTo);
    pool = new Pool(brain.appConfig);
    const admin = new Admin(pool);
    const owner = await admin.bootstrapOwner({ name: "olive", email: "olive@test.brain" });
    ctx = { actorId: owner.id };

    const su = await brain.connect("superuser");
    try {
      const before = await su.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'fs_entries'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%octet_length(content)%'`,
      );
      expect(before.rows[0]?.def, "the 25 MB CHECK must exist before 0060").toContain("26214400");
    } finally {
      await su.end();
    }

    const owner2 = await brain.connect("owner");
    try {
      const { runMigrations } = await import("@brain/schema");
      // 0060 and everything after it, so the next appended migration does not
      // break this test the way 0060 broke 0059's.
      expect(await runMigrations(owner2, MIGRATIONS)).toEqual(
        MIGRATIONS.slice(MIGRATIONS.findIndex((m) => m.version === "0060")).map((m) => m.version),
      );
    } finally {
      await owner2.end();
    }
    fs = new FsStore(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await brain?.drop();
  });

  it("leaves exactly ONE content cap, at the new bound, and it is named", async () => {
    const su = await brain.connect("superuser");
    try {
      const caps = await su.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'fs_entries'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%octet_length(content)%'`,
      );
      // Exactly one: a widen that ADDED without dropping would leave the old
      // 25 MB bound in force and the raise would be a silent no-op.
      expect(caps.rows).toHaveLength(1);
      expect(caps.rows[0]!.conname).toBe("fs_entries_content_max_bytes");
      expect(caps.rows[0]!.def).toContain(String(FS_MAX_FILE_BYTES));
    } finally {
      await su.end();
    }
  });

  it("stores a file LARGER than the old cap, and reads the exact bytes back", async () => {
    // 30 MB: over 25, well under 100. Random-ish so TOAST cannot compress it to
    // nothing and quietly make the test prove less than it claims.
    const size = 30 * 1024 * 1024;
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4096) buf.writeUInt32LE((i * 2654435761) >>> 0, i);
    await fs.write(ctx, "/shared/big.bin", buf, "application/octet-stream");
    const { bytes: back, meta } = await fs.read(ctx, "/shared/big.bin");
    expect(meta.size).toBe(size);
    expect(back.length).toBe(size);
    // Ends, not the whole buffer: a torn TOAST read shows up at a boundary, and
    // comparing 30 MB twice buys nothing over comparing the edges plus the size.
    expect(back.subarray(0, 4096).equals(buf.subarray(0, 4096))).toBe(true);
    expect(back.subarray(size - 4096).equals(buf.subarray(size - 4096))).toBe(true);
  }, 180_000);

  it("still refuses past the NEW cap, with the teaching error and not a 500", async () => {
    const over = Buffer.alloc(FS_MAX_FILE_BYTES + 1);
    await expect(fs.write(ctx, "/shared/toobig.bin", over)).rejects.toThrow(/EFBIG/);
  }, 180_000);
});
