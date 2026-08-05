import { describe, expect, it } from "vitest";
import { readVitals } from "./vitals.js";

/**
 * readVitals reads real host metrics (/proc + statfs) on the test machine.
 * It can't assert exact numbers, but every field must be either null or a
 * sane percent — the contract the booth ingest relies on.
 */
describe("readVitals", () => {
  it("returns null-or-sane percents for cpu, mem, disk", async () => {
    const v = await readVitals();
    for (const [name, val, max] of [
      ["cpuPct", v.cpuPct, 999],
      ["memPctUsed", v.memPctUsed, 100],
      ["diskPctUsed", v.diskPctUsed, 100],
    ] as const) {
      if (val !== null) {
        expect(Number.isInteger(val), `${name} integer`).toBe(true);
        expect(val, `${name} >= 0`).toBeGreaterThanOrEqual(0);
        expect(val, `${name} <= ${max}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("reads disk and memory on a normal host (not both null)", async () => {
    const v = await readVitals();
    // On any real machine at least one of disk/mem is readable; a box that
    // reports neither would be suspicious, so guard against a total-null regression.
    expect(v.diskPctUsed !== null || v.memPctUsed !== null).toBe(true);
  });
});
