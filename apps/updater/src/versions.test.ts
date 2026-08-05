import { describe, expect, it } from "vitest";
import {
  canonicalOrder,
  compareSemver,
  desiredOrdinal,
  ensureCurrent,
  fromLibState,
  isBelow,
  ordinalOf,
  parsePersistedState,
  parseSemver,
  toLibState,
  type PersistedState,
  type ReleaseEntry,
} from "./versions.js";

const rel = (version: string, opts: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  version,
  imageDigest: `sha256:${"0".repeat(64)}`,
  channel: "stable",
  yanked: false,
  ...opts,
});

const BASE: PersistedState = {
  currentVersion: "v0.9.0",
  floorVersion: "v0.9.0",
  attempts: {},
  keptVersions: ["v0.9.0"],
};

describe("versions · intrinsic semver order", () => {
  it("parses and compares semver, tolerating a leading v and ranking pre-releases below", () => {
    expect(parseSemver("v0.10.1")).toEqual([0, 10, 1, 1]); // final → rank 1
    expect(parseSemver("1.2.3-rc.1")).toEqual([1, 2, 3, 0]); // pre-release → rank 0
    expect(parseSemver("nope")).toBeNull();
    expect(parseSemver("v1.2")).toBeNull(); // anchored — partial is not semver
    expect(compareSemver([0, 10, 0, 1], [0, 9, 9, 1])).toBeGreaterThan(0);
    expect(isBelow("v0.9.0", "v0.10.0")).toBe(true); // NOT lexicographic
    expect(isBelow("v0.10.0", "v0.9.0")).toBe(false);
    // A pre-release sorts strictly BELOW its final release (anti-rollback safe).
    expect(isBelow("v1.2.3-rc.1", "v1.2.3")).toBe(true);
    expect(isBelow("v1.2.3", "v1.2.3-rc.1")).toBe(false);
  });

  it("orders by semver regardless of the booth's list order (anti-reorder)", () => {
    // Booth returns them shuffled + lexicographically misleading.
    const shuffled = [rel("v0.10.0"), rel("v0.9.0"), rel("v0.10.1")];
    const canon = canonicalOrder(shuffled, "v0.9.0")!;
    expect(canon.map((r) => r.version)).toEqual(["v0.9.0", "v0.10.0", "v0.10.1"]);
    expect(ordinalOf(canon, "v0.10.0")).toBe(2);
  });

  it("excludes yanked releases from the steppable order (except current)", () => {
    const releases = [rel("v0.9.0"), rel("v0.10.0", { yanked: true }), rel("v0.11.0")];
    const canon = canonicalOrder(releases, "v0.9.0")!;
    // v0.10.0 is yanked → a box on v0.9.0 steps straight to v0.11.0.
    expect(canon.map((r) => r.version)).toEqual(["v0.9.0", "v0.11.0"]);
    // …but a box currently RUNNING the yanked one can still locate it to step off.
    const canonOnYanked = canonicalOrder(releases, "v0.10.0")!;
    expect(canonOnYanked.map((r) => r.version)).toEqual(["v0.9.0", "v0.10.0", "v0.11.0"]);
  });

  it("skips an unparseable release rather than freezing the channel", () => {
    // 'weird' is dropped; the box still steps among the valid releases.
    const canon = canonicalOrder([rel("v1.0.0"), rel("weird"), rel("v1.1.0")], "v1.0.0")!;
    expect(canon.map((r) => r.version)).toEqual(["v1.0.0", "v1.1.0"]);
  });

  it("holds (null) only when the box's OWN current version is unparseable", () => {
    expect(canonicalOrder([rel("v1.0.0")], "not-semver")).toBeNull();
  });
});

describe("versions · desired ordinal", () => {
  const canon = canonicalOrder([rel("v0.9.0"), rel("v0.10.0"), rel("v0.10.1")], "v0.9.0")!;
  it("holds at current for a null / unpublished / yanked desired version", () => {
    expect(desiredOrdinal(canon, null, 1)).toEqual({ ordinal: 1, held: true });
    expect(desiredOrdinal(canon, "v9.9.9", 1)).toEqual({ ordinal: 1, held: true });
    expect(desiredOrdinal(canon, "v0.10.1", 1)).toEqual({ ordinal: 3, held: false });
  });
});

describe("versions · persisted ↔ library state", () => {
  const canon = canonicalOrder([rel("v0.9.0"), rel("v0.10.0"), rel("v0.10.1")], "v0.10.0")!;

  it("round-trips current/floor/attempts/kept without clamping floor to current", () => {
    const persisted: PersistedState = {
      currentVersion: "v0.10.0",
      floorVersion: "v0.9.0",
      attempts: { "v0.10.1": 2 },
      keptVersions: ["v0.9.0", "v0.10.0"],
    };
    const lib = toLibState(persisted, canon);
    expect(lib.ok).toBe(true);
    if (!lib.ok) return;
    // floor maps to v0.9.0's ordinal (1), NOT clamped up to current (2) — so a
    // signed downgrade to v0.9.0 stays reachable.
    expect(lib.state).toMatchObject({ current: 2, floor: 1, attempts: { 3: 2 } });
    expect(lib.state.kept).toEqual([
      { version: 1, minCompatibleSchema: 1 },
      { version: 2, minCompatibleSchema: 2 },
    ]);
    const back = fromLibState(lib.state, canon, persisted);
    expect(back.currentVersion).toBe("v0.10.0");
    expect(back.attempts).toEqual({ "v0.10.1": 2 });
  });

  it("raises the floor to current as a monotonic high-water mark", () => {
    const lib = toLibState(BASE, canonicalOrder([rel("v0.9.0"), rel("v0.10.0")], "v0.10.0")!);
    if (!lib.ok) throw new Error("expected ok");
    // Simulate having advanced to v0.10.0.
    const advanced = { ...lib.state, current: 2 };
    const back = fromLibState(
      advanced,
      canonicalOrder([rel("v0.9.0"), rel("v0.10.0")], "v0.10.0")!,
      BASE,
    );
    expect(back.floorVersion).toBe("v0.10.0"); // rose from v0.9.0
  });

  it("refuses to derive a state when the current version is not canonical", () => {
    expect(toLibState({ ...BASE, currentVersion: "ghost" }, canon).ok).toBe(false);
  });

  it("keeps at most the newest two images (by semver) as rollback candidates", () => {
    const c = canonicalOrder([rel("v0.9.0"), rel("v0.10.0"), rel("v0.10.1")], "v0.10.1")!;
    const lib = toLibState(
      { ...BASE, currentVersion: "v0.10.1", keptVersions: ["v0.9.0", "v0.10.0", "v0.10.1"] },
      c,
    );
    if (!lib.ok) throw new Error("expected ok");
    const back = fromLibState(lib.state, c, {
      ...BASE,
      currentVersion: "v0.10.1",
      floorVersion: "v0.10.1",
    });
    expect(back.keptVersions).toEqual(["v0.10.1", "v0.10.0"]);
  });

  it("drops attempts for versions no longer in the canonical list", () => {
    const lib = toLibState({ ...BASE, attempts: { ghost: 5, "v0.10.0": 1 } }, canon);
    if (!lib.ok) throw new Error("expected ok");
    expect(lib.state.attempts).toEqual({ 2: 1 });
  });
});

describe("parsePersistedState — reject null/malformed, preserve optional fields", () => {
  const valid = {
    currentVersion: "v0.4.0",
    floorVersion: "v0.3.0",
    attempts: { "v0.4.1": 2 },
    keptVersions: ["v0.4.0", "v0.3.0"],
    // optional operator-op fields that MUST survive round-trip (no reconstruction)
    attempting: "v0.4.1",
    boxId: "box-abc",
    honoredRestartGeneration: 3,
    honoredPruneGeneration: 1,
  };

  it("accepts a full valid file and returns it AS-IS (optional fields intact)", () => {
    const out = parsePersistedState(JSON.stringify(valid));
    expect(out).toEqual(valid);
    expect(out.attempting).toBe("v0.4.1"); // the journal marker survives
    expect(out.boxId).toBe("box-abc"); // the TOFU pin survives
    expect(out.honoredRestartGeneration).toBe(3);
  });

  it("throws on JSON null and non-object primitives", () => {
    expect(() => parsePersistedState("null")).toThrow(/not a plain object.*null/);
    expect(() => parsePersistedState("42")).toThrow(/not a plain object/);
    expect(() => parsePersistedState('"x"')).toThrow(/not a plain object/);
    expect(() => parsePersistedState("[]")).toThrow(/not a plain object/);
  });

  it("throws on a truncated/invalid file (via JSON.parse)", () => {
    expect(() => parsePersistedState("{ not json")).toThrow();
  });

  it("throws on missing/blank core fields", () => {
    expect(() => parsePersistedState("{}")).toThrow(/currentVersion/);
    expect(() => parsePersistedState(JSON.stringify({ ...valid, currentVersion: "" }))).toThrow(
      /currentVersion/,
    );
    const { floorVersion: _f, ...noFloor } = valid;
    expect(() => parsePersistedState(JSON.stringify(noFloor))).toThrow(/floorVersion/);
    expect(() => parsePersistedState(JSON.stringify({ ...valid, attempts: [] }))).toThrow(
      /attempts/,
    );
    expect(() => parsePersistedState(JSON.stringify({ ...valid, keptVersions: {} }))).toThrow(
      /keptVersions/,
    );
  });
});

describe("ensureCurrent — synthesize a vanished current at its semver slot", () => {
  const D = `sha256:${"a".repeat(64)}`;

  it("is a no-op when the version is already present", () => {
    const canon = [rel("v0.3.0"), rel("v0.4.0")];
    expect(ensureCurrent(canon, "v0.4.0", D)).toBe(canon);
  });

  it("inserts at the correct semver position and preserves the digest", () => {
    const canon = [rel("v0.3.0"), rel("v0.5.0")];
    const out = ensureCurrent(canon, "v0.4.0", D);
    expect(out.map((r) => r.version)).toEqual(["v0.3.0", "v0.4.0", "v0.5.0"]);
    const inserted = out.find((r) => r.version === "v0.4.0")!;
    expect(inserted.imageDigest).toBe(D);
    expect(inserted.yanked).toBe(false);
  });

  it("inserts a below-floor and an above-newest version at the right ends", () => {
    const canon = [rel("v0.4.0")];
    expect(ensureCurrent(canon, "v0.3.0", D).map((r) => r.version)).toEqual(["v0.3.0", "v0.4.0"]);
    expect(ensureCurrent(canon, "v0.9.0", D).map((r) => r.version)).toEqual(["v0.4.0", "v0.9.0"]);
  });
});
