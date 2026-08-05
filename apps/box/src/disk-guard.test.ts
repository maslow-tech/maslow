import { afterEach, describe, expect, it, vi } from "vitest";

// vitals.diskUsedPct is the one statfs helper; mock it so the guard's caching +
// threshold + fail-open logic is tested without touching a real filesystem.
const diskUsedPct = vi.fn<(path: string) => Promise<number | null>>();
vi.mock("./vitals.js", () => ({
  diskUsedPct: (p: string) => diskUsedPct(p),
  dataPath: () => "/var/lib/brain-pgdata",
  DEFAULT_DATA_PATH: "/var/lib/brain-pgdata",
}));

const { makeDiskGuard } = await import("./disk-guard.js");

afterEach(() => {
  diskUsedPct.mockReset();
  vi.restoreAllMocks();
});

describe("makeDiskGuard", () => {
  it("sheds at/over the threshold, allows below (boundary 89 vs 90)", async () => {
    diskUsedPct.mockResolvedValueOnce(89);
    expect((await makeDiskGuard({}, () => 0)()).shed).toBe(false);
    diskUsedPct.mockResolvedValueOnce(90);
    expect((await makeDiskGuard({}, () => 0)()).shed).toBe(true);
    diskUsedPct.mockResolvedValueOnce(95);
    expect((await makeDiskGuard({}, () => 0)()).shed).toBe(true);
  });

  it("honours BRAIN_WRITE_SHED_PCT override", async () => {
    diskUsedPct.mockResolvedValue(80);
    const guard = makeDiskGuard({ BRAIN_WRITE_SHED_PCT: "75" }, () => 0);
    expect((await guard()).shed).toBe(true); // 80 >= 75
  });

  it("caches within the TTL (a single statfs across rapid calls), refreshes after", async () => {
    diskUsedPct.mockResolvedValue(50);
    let clock = 1000;
    const guard = makeDiskGuard({}, () => clock);
    await guard();
    await guard();
    await guard();
    expect(diskUsedPct).toHaveBeenCalledTimes(1); // cached
    clock += 6000; // past the 5s TTL
    await guard();
    expect(diskUsedPct).toHaveBeenCalledTimes(2); // refreshed
  });

  it("FAILS OPEN on a statfs error (null) and warns exactly once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    diskUsedPct.mockResolvedValue(null);
    let clock = 0;
    const guard = makeDiskGuard({}, () => clock);
    const a = await guard();
    expect(a.shed).toBe(false); // fail open — writes allowed
    expect(a.pct).toBeNull();
    clock += 6000;
    await guard(); // second real read, still null
    expect(warn).toHaveBeenCalledTimes(1); // warned ONCE, not every read
  });
});
