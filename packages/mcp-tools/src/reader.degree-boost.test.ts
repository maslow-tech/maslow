import { describe, expect, it } from "vitest";

import { applyDegreeBoost } from "./reader";

/**
 * Ranking by how connected a hit is.
 *
 * The case this exists for: typing a person's name should land on the PERSON,
 * not on a meeting note that mentions them. Nothing in the stack knew that —
 * the graph arm uses edges to FIND related objects, never to rank a hit by how
 * connected it is — so an ambiguous query fell back to raw fusion order.
 */
const hit = (id: string, rank: number, title = id): Record<string, unknown> => ({
  id,
  rank,
  title,
});

describe("applyDegreeBoost", () => {
  it("breaks a tie toward the hub", () => {
    const out = applyDegreeBoost(
      [hit("note", 1), hit("person", 1)],
      new Map([
        ["note", 1],
        ["person", 40],
      ]),
    );
    expect(out[0]!["id"]).toBe("person");
  });

  it("cannot outrank a clearly better match — it is a tie-break, not a lever", () => {
    // The person is 40× better connected, the note matched the words far
    // better. The words have to win: a hub that barely matches must never
    // leapfrog the thing you actually named.
    const out = applyDegreeBoost(
      [hit("note", 1.5), hit("person", 1)],
      new Map([
        ["note", 0],
        ["person", 40],
      ]),
    );
    expect(out[0]!["id"]).toBe("note");
    expect(out[0]!["rank"]).toBe(1.5);
  });

  it("is bounded by DEGREE_BOOST_MAX", () => {
    const out = applyDegreeBoost([hit("a", 1), hit("b", 1)], new Map([["a", 10_000]]));
    const top = out[0]!["rank"] as number;
    expect(top).toBeGreaterThan(1);
    expect(top).toBeLessThanOrEqual(1.15 + 1e-9);
  });

  it("uses log scale, so the middle of a heavy tail still separates", () => {
    const ranked = applyDegreeBoost(
      [hit("a", 1), hit("b", 1), hit("c", 1)],
      new Map([
        ["a", 2],
        ["b", 12],
        ["c", 1_000],
      ]),
    );
    // Linear would hand nearly the whole boost to `c` and leave a/b identical.
    const rank = (id: string): number => ranked.find((h) => h["id"] === id)!["rank"] as number;
    expect(rank("b")).toBeGreaterThan(rank("a"));
    expect(rank("b") - rank("a")).toBeGreaterThan(0.01);
  });

  it("leaves a hit with no known degree in the list rather than dropping it", () => {
    const out = applyDegreeBoost([hit("a", 1), hit("ghost", 2)], new Map([["a", 5]]));
    expect(out.map((h) => h["id"])).toContain("ghost");
    expect(out[0]!["id"]).toBe("ghost");
  });
});
