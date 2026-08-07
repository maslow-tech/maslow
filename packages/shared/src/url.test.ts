import { describe, expect, it } from "vitest";
import { stripTrailingSlashes } from "./url.js";

describe("stripTrailingSlashes — matches replace(/\\/+$/, '') exactly", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["/", ""],
    ["///", ""],
    ["https://booth.example.com", "https://booth.example.com"],
    ["https://booth.example.com/", "https://booth.example.com"],
    ["https://booth.example.com///", "https://booth.example.com"],
    ["https://booth.example.com/base/", "https://booth.example.com/base"],
    ["https://booth.example.com/a//b", "https://booth.example.com/a//b"],
    ["https://booth.example.com/ ", "https://booth.example.com/ "],
  ];
  for (const [input, want] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => {
      expect(stripTrailingSlashes(input)).toBe(want);
      expect(stripTrailingSlashes(input)).toBe(input.replace(/\/+$/, ""));
    });
  }

  it("stays linear on a long slash run (the ReDoS shape)", () => {
    const s = `https://x/${"/".repeat(200_000)}`;
    expect(stripTrailingSlashes(s)).toBe("https://x");
  });
});
