// Per-worktree dev database naming. Each linked git worktree
// gets its OWN database inside the one shared brain-dev-pg container, so two
// `dev:box` runs from different worktrees can't DROP each other's brain. Pure
// (unit-testable without docker/git) except resolveDevDb().
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, join } from "node:path";

const MAIN_DB = "brain_dev";
const PREFIX = "brain_dev_";
const NAMEDATALEN = 63; // pg identifier limit, in BYTES

/** Lowercase; non-[a-z0-9_] → "_"; collapse repeats; trim. Pure ASCII → 1 byte/char. */
export function sanitizeSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** A safe, unquoted-DDL-injection-proof postgres identifier. */
export function isValidDevDbIdent(name) {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

/**
 * Pure name derivation.
 * - override (BRAIN_DEV_DB): returned verbatim IFF valid, else THROW (never
 *   sanitize — the verify skill pins an exact name, and this closes the
 *   unquoted-DDL injection path).
 * - main checkout: unchanged "brain_dev" (verify skill + docs keep working).
 * - linked worktree: brain_dev_<slug>_<4hex(sha1(toplevel))>, hash RESERVED
 *   before truncation so collision-safety and the <=63-byte cap both always hold.
 * @param {{ override?: string, isLinkedWorktree?: boolean, toplevel?: string }} opts
 *   override alone determines the result; the other two only matter when no
 *   override is set (isLinkedWorktree false/absent → the main "brain_dev").
 * @returns {string}
 */
export function devDbName({ override, isLinkedWorktree, toplevel }) {
  if (override !== undefined && override !== "") {
    if (!isValidDevDbIdent(override)) {
      throw new Error(
        `BRAIN_DEV_DB=${JSON.stringify(override)} is not a valid postgres identifier ` +
          "(^[a-z_][a-z0-9_]{0,62}$)",
      );
    }
    return override;
  }
  if (!isLinkedWorktree) return MAIN_DB;
  const hash4 = createHash("sha1").update(String(toplevel)).digest("hex").slice(0, 4);
  const suffix = `_${hash4}`; // 5 bytes
  const budget = NAMEDATALEN - PREFIX.length - suffix.length; // 63-10-5 = 48
  const body = sanitizeSlug(basename(String(toplevel))).slice(0, budget) || "wt";
  return `${PREFIX}${body}${suffix}`;
}

/** Impure resolver shared by dev-box.ts and seed-demo.mjs so they can never
 *  target different DBs for the same working directory. Falls back to
 *  "brain_dev" when git is absent or a stat fails. */
export function resolveDevDb() {
  const override = process.env.BRAIN_DEV_DB;
  if (override) return devDbName({ override });
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    // A linked worktree's `.git` is a FILE (gitdir pointer); the main checkout's
    // is a directory.
    const isLinkedWorktree = statSync(join(toplevel, ".git")).isFile();
    return devDbName({ isLinkedWorktree, toplevel });
  } catch {
    return MAIN_DB;
  }
}
