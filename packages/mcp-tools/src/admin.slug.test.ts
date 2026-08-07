import { describe, expect, it } from "vitest";
import { slugifyHomeName } from "./admin.js";

/**
 * The slug picks `/home/<slug>` for a brand-new account, so it must keep
 * producing exactly what the regex chain it replaced produced — a drift here
 * silently changes where a member's private home lands.
 */
const legacy = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");

const NAMES = [
  "",
  "   ",
  "-",
  "----",
  "Priya Patel",
  "priya",
  "Priya   Patel",
  "  Priya Patel  ",
  "O'Brien, Sean",
  "user@example.com",
  "--leading",
  "trailing--",
  "--both--",
  "a-b-c",
  "a--b",
  "123",
  "Ünïcödé Nàme",
  "日本語",
  "emoji 🙂 name",
  "a".repeat(80),
  `${"a".repeat(62)} tail`, // the 63-char cut lands on the separator
  `${"a".repeat(63)} tail`,
  `${"a".repeat(61)}--b`,
  "x".repeat(63) + "-",
  "!!!",
  "a!!!b",
];

describe("slugifyHomeName", () => {
  for (const name of NAMES) {
    it(`matches the replaced regex chain on ${JSON.stringify(name)}`, () => {
      expect(slugifyHomeName(name)).toBe(legacy(name));
    });
  }

  it("collapses runs, trims both ends, and caps at 63", () => {
    expect(slugifyHomeName("  Priya  Patel!! ")).toBe("priya-patel");
    expect(slugifyHomeName("a".repeat(80))).toHaveLength(63);
  });

  it("never leaves a trailing dash after the 63-char cut", () => {
    const cut = slugifyHomeName(`${"a".repeat(62)} tail`);
    expect(cut.endsWith("-")).toBe(false);
    expect(cut).toBe("a".repeat(62));
  });

  it("stays linear on a long separator run (the ReDoS shape)", () => {
    expect(slugifyHomeName("-".repeat(200_000))).toBe("");
    expect(slugifyHomeName(`a${" ".repeat(200_000)}`)).toBe("a");
  });
});
