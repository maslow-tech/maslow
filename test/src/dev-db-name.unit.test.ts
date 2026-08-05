import { describe, expect, it } from "vitest";
import { devDbName, isValidDevDbIdent, sanitizeSlug } from "../../apps/box/dev/dev-db-name.mjs";

/**
 * Per-worktree dev database naming. Pure derivation — no docker,
 * no git, no DB — mirroring the backfill-*.unit.test.ts style.
 */
describe("sanitizeSlug", () => {
  it("lowercases, replaces non-[a-z0-9_], collapses repeats, trims", () => {
    expect(sanitizeSlug("Feature/Foo-Bar!!")).toBe("feature_foo_bar");
    expect(sanitizeSlug("__a..b__")).toBe("a_b");
    expect(sanitizeSlug("ALLCAPS")).toBe("allcaps");
  });
});

describe("devDbName", () => {
  it("returns brain_dev unchanged for the main checkout", () => {
    expect(devDbName({ isLinkedWorktree: false, toplevel: "/repo/brain" })).toBe("brain_dev");
  });

  it("derives brain_dev_<slug>_<4hex> for a linked worktree, within 63 bytes", () => {
    const name = devDbName({
      isLinkedWorktree: true,
      toplevel: "/repo/brain/.claude/worktrees/denchclaw",
    });
    expect(name).toMatch(/^brain_dev_denchclaw_[0-9a-f]{4}$/);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  });

  it("truncates a very long basename but KEEPS the full hash suffix", () => {
    const long = "/repo/brain/.claude/worktrees/" + "z".repeat(200);
    const name = devDbName({ isLinkedWorktree: true, toplevel: long });
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(name).toMatch(/_[0-9a-f]{4}$/); // suffix survived the truncation
  });

  it("falls back to 'wt' for an empty/all-punctuation basename, still uniquified", () => {
    const a = devDbName({ isLinkedWorktree: true, toplevel: "/repo/---" });
    const b = devDbName({ isLinkedWorktree: true, toplevel: "/other/---" });
    expect(a).toMatch(/^brain_dev_wt_[0-9a-f]{4}$/);
    expect(b).toMatch(/^brain_dev_wt_[0-9a-f]{4}$/);
    expect(a).not.toBe(b); // distinct toplevel paths → distinct hashes
  });

  it("passes a valid BRAIN_DEV_DB override through verbatim", () => {
    expect(devDbName({ override: "brain_dev" })).toBe("brain_dev");
    expect(devDbName({ override: "my_scratch_db" })).toBe("my_scratch_db");
  });

  it("throws on an invalid override (never sanitizes → no DDL injection)", () => {
    for (const bad of ["has space", 'quote"', "semi;colon", "1leading", "a".repeat(64)]) {
      expect(() => devDbName({ override: bad })).toThrow(/not a valid postgres identifier/);
    }
  });
});

describe("isValidDevDbIdent", () => {
  it("accepts safe identifiers and rejects unsafe ones", () => {
    expect(isValidDevDbIdent("brain_dev")).toBe(true);
    expect(isValidDevDbIdent("_x1")).toBe(true);
    expect(isValidDevDbIdent("1x")).toBe(false);
    expect(isValidDevDbIdent("a b")).toBe(false);
    expect(isValidDevDbIdent("a".repeat(64))).toBe(false);
  });
});
