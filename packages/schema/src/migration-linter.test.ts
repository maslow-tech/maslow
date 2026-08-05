import { describe, expect, it } from "vitest";
import { lintMigration, lintMigrations } from "./migration-linter.js";
import { MIGRATIONS } from "./migrations/index.js";
import type { Migration } from "./migrations/types.js";

const base = (over: Partial<Migration>): Migration => ({
  version: "9000",
  name: "t",
  sql: "",
  ...over,
});

describe("migration linter", () => {
  it("passes the real infra migration set clean", () => {
    expect(lintMigrations(MIGRATIONS)).toEqual([]);
  });

  it("flags DROP COLUMN without an ack", () => {
    const f = lintMigration(base({ sql: "ALTER TABLE client_ext DROP COLUMN nickname;" }));
    expect(f.map((x) => x.rule)).toContain("drop-column");
  });

  it("silences an acked destructive change (per-statement ack)", () => {
    const f = lintMigration(
      base({
        sql: "ALTER TABLE client_ext DROP COLUMN nickname;",
        allowDestructive: [{ rule: "drop-column", match: "client_ext", reason: "test" }],
      }),
    );
    expect(f).toEqual([]);
  });

  it("does NOT silence an UNACKED destructive statement in an otherwise-acked file", () => {
    // the acceptance criterion: one ack covers ONE statement, not the file
    const f = lintMigration(
      base({
        sql: "ALTER TABLE t DROP CONSTRAINT ok_ck; DROP TABLE surprise;",
        allowDestructive: [{ rule: "drop-constraint", match: "ok_ck", reason: "expand-only" }],
      }),
    );
    const rules = f.map((x) => x.rule);
    expect(rules).toContain("drop-table"); // the un-acked DROP still flags
    expect(rules).not.toContain("drop-constraint"); // the acked one is silenced
    expect(rules).not.toContain("stale-ack"); // the ack matched real text
  });

  it("flags a stale ack whose match hits no destructive statement", () => {
    const f = lintMigration(
      base({
        sql: "DROP TABLE t;",
        allowDestructive: [{ rule: "drop-table", match: "wrong_name", reason: "x" }],
      }),
    );
    const rules = f.map((x) => x.rule);
    expect(rules).toContain("drop-table"); // still flagged (ack didn't match)
    expect(rules).toContain("stale-ack"); // and the dead ack is called out
  });

  it("an empty-reason ack still flags the DROP but is NOT stale (it matched real text)", () => {
    const f = lintMigration(
      base({
        sql: "DROP TABLE t;",
        allowDestructive: [{ rule: "drop-table", match: "t", reason: "  " }],
      }),
    );
    const rules = f.map((x) => x.rule);
    expect(rules).toContain("drop-table"); // blank reason does not silence
    expect(rules).not.toContain("stale-ack"); // but the ack matched, so not stale
  });

  it("flags DROP TABLE, rename, type change, truncate", () => {
    expect(lintMigration(base({ sql: "DROP TABLE client_ext;" })).length).toBe(1);
    expect(lintMigration(base({ sql: "ALTER TABLE t RENAME TO t2;" })).length).toBe(1);
    expect(lintMigration(base({ sql: "ALTER TABLE t ALTER COLUMN a TYPE bigint;" })).length).toBe(
      1,
    );
    expect(lintMigration(base({ sql: "TRUNCATE objects;" })).length).toBe(1);
  });

  it("flags CREATE INDEX CONCURRENTLY in the transactional sql (non-ackable)", () => {
    // an ack silences only its own destructive statement, never a structural one
    const f = lintMigration(
      base({
        sql: "CREATE INDEX CONCURRENTLY foo ON objects(title); DROP TABLE junk;",
        allowDestructive: [{ rule: "drop-table", match: "junk", reason: "test" }],
      }),
    );
    const rules = f.map((x) => x.rule);
    expect(rules).toContain("cic-in-txn"); // structural error still flagged
    expect(rules).not.toContain("drop-table"); // the acked DROP is silenced
    expect(rules).not.toContain("stale-ack");
  });

  it("allows the resumable-CIC idiom in concurrent[]", () => {
    const f = lintMigration(
      base({
        sql: "ALTER TABLE objects ADD COLUMN foo int;",
        concurrent: [
          "DROP INDEX IF EXISTS objects_foo_ix",
          "CREATE INDEX CONCURRENTLY objects_foo_ix ON objects(foo)",
        ],
      }),
    );
    expect(f).toEqual([]);
  });

  it("ignores destructive keywords inside comments", () => {
    const f = lintMigration(base({ sql: "-- this used to DROP TABLE objects\nSELECT 1;" }));
    expect(f).toEqual([]);
  });
});
