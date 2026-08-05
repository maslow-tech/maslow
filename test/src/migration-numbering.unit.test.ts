import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "@brain/schema";

// Migrations are APPEND-ONLY and their numbers are the ledger's identity: the
// runner checksums an applied version, and a live box replays by version order.
// Two files sharing a prefix, or an array out of order, is not a style nit — it
// is a box that migrates the wrong thing or stops updating. Rebases across
// long-lived feature branches are how collisions get introduced (two branches
// each grab "the next free number"), so this guard runs in normal CI: a
// collision fails the build loudly instead of being silently renumbered later.
//
// GAPS ARE LEGAL BY DESIGN. 0035 is reserved (unified-integrations client_id)
// and absent from disk on purpose. The invariant is uniqueness + ordering, not
// density — never "fix" a gap by renumbering a shipped migration.

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../packages/schema/src/migrations/", import.meta.url),
);

const FILE_RE = /^(\d{4})-([a-z0-9-]+)\.ts$/;

interface MigrationFile {
  readonly file: string;
  readonly prefix: string;
}

/** Every `00NN-*.ts` on disk, in readdir order (deliberately NOT pre-sorted).
 *  The dir also holds NON-migration modules (index.ts, types.ts, shared
 *  helpers like fs-rls.ts): anything that does not START with a digit is one
 *  of those and is skipped. Anything that DOES start with a digit is claiming
 *  to be a migration and must match the full 00NN-name.ts shape exactly. */
function migrationFiles(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".ts") && /^\d/.test(f))
    .map((file) => {
      const prefix = FILE_RE.exec(file)?.[1];
      if (!prefix) throw new Error(`migration filename does not match 00NN-name.ts: ${file}`);
      return { file, prefix } satisfies MigrationFile;
    });
}

/** The 4-digit prefixes index.ts actually imports (`from "./0037-filesystem.js"`). */
function importedPrefixes(): string[] {
  const src = readFileSync(`${MIGRATIONS_DIR}index.ts`, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+"\.\/(\d{4})-[a-z0-9-]+\.js"/g)) {
    const prefix = m[1];
    if (prefix) out.push(prefix);
  }
  return out;
}

describe("migration numbering", () => {
  it("actually found the migration set (no vacuous pass)", () => {
    // Guards against a silently-empty scan turning every assertion below into a
    // green no-op. 38 had shipped when this guard was written; it only grows.
    expect(migrationFiles().length).toBeGreaterThanOrEqual(38);
    expect(MIGRATIONS.length).toBe(migrationFiles().length);
  });

  it("(a) no two migration files share a numeric prefix", () => {
    const byPrefix = new Map<string, string[]>();
    for (const { file, prefix } of migrationFiles()) {
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
    }
    const collisions = [...byPrefix.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([prefix, files]) => `${prefix}: ${files.sort().join(", ")}`);
    expect(collisions, "two migrations claim the same number — renumber the NEW one").toEqual([]);
  });

  it("(b) MIGRATIONS is strictly ascending with no duplicate versions", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    for (const v of versions) {
      expect(v, `version must be exactly 4 digits: ${v}`).toMatch(/^\d{4}$/);
    }

    const outOfOrder: string[] = [];
    for (let i = 1; i < versions.length; i++) {
      const prev = versions[i - 1] ?? "";
      const cur = versions[i] ?? "";
      if (Number(cur) <= Number(prev)) outOfOrder.push(`${prev} -> ${cur}`);
    }
    expect(outOfOrder, "MIGRATIONS must be append-only ascending").toEqual([]);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("(c) every file on disk is registered in index.ts, and vice versa", () => {
    const onDisk = new Set(migrationFiles().map((f) => f.prefix));
    const imported = importedPrefixes();
    const inArray = new Set(MIGRATIONS.map((m) => m.version));

    // No duplicate imports (a rebase can leave two import lines for one file).
    expect(new Set(imported).size, "duplicate import lines in index.ts").toBe(imported.length);

    const sorted = (s: Iterable<string>) => [...s].sort();
    expect(sorted(imported), "index.ts imports must match the files on disk").toEqual(
      sorted(onDisk),
    );
    expect(sorted(inArray), "every imported migration must be pushed into MIGRATIONS").toEqual(
      sorted(onDisk),
    );
  });

  it("(d) each migration's declared version matches its filename prefix", () => {
    const mismatches: string[] = [];
    for (const { file, prefix } of migrationFiles()) {
      const src = readFileSync(`${MIGRATIONS_DIR}${file}`, "utf8");
      const declared = /\bversion:\s*"(\d+)"/.exec(src)?.[1];
      if (declared !== prefix) mismatches.push(`${file} declares version ${declared ?? "<none>"}`);

      // The exported symbol is part of the identity too — `migration0037` in
      // 0037-filesystem.ts. A copy-pasted new migration that forgot to rename
      // its export silently re-registers the one it was copied from.
      if (!new RegExp(`export const migration${prefix}\\b`).test(src)) {
        mismatches.push(`${file} does not export migration${prefix}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("tolerates gaps — the set need not be contiguous", () => {
    // 0035 is reserved (unified-integrations client_id) and absent from disk, so
    // the numbering IS sparse today. This asserts the invariant is uniqueness +
    // ordering only: a gap is legal, and closing one by renumbering a shipped
    // migration would be the actual violation (append-only, checksummed ledger).
    // Deliberately no assertion on WHICH numbers are missing — filling 0035
    // later is allowed and must not fail CI.
    const numbers = MIGRATIONS.map((m) => Number(m.version));
    const first = numbers[0] ?? 0;
    const last = numbers[numbers.length - 1] ?? 0;
    expect(numbers.length).toBeLessThanOrEqual(last - first + 1);
    expect(Math.max(...numbers)).toBe(last);
  });
});
