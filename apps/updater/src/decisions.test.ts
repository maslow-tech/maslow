import { describe, expect, it } from "vitest";
import { backoffMs, canaryVerdict, decideStep, isPoisoned, rollbackTarget } from "./decisions.js";

describe("decideStep", () => {
  it("holds when up to date", () => {
    expect(decideStep({ current: 3, desired: 3, floor: 1 }).action).toBe("hold");
  });
  it("steps one release at a time (no multi-version jump)", () => {
    const d = decideStep({ current: 1, desired: 5, floor: 1 });
    expect(d).toMatchObject({ action: "apply", toVersion: 2 });
  });
  it("applies straight to desired when it is the next release", () => {
    expect(decideStep({ current: 4, desired: 5, floor: 1 })).toMatchObject({
      action: "apply",
      toVersion: 5,
    });
  });
  it("refuses a downgrade without a signed operator flag", () => {
    expect(decideStep({ current: 5, desired: 3, floor: 1 }).action).toBe("refuse");
  });
  it("allows a signed downgrade but not below the floor", () => {
    expect(decideStep({ current: 5, desired: 3, floor: 1, signedDowngrade: true })).toMatchObject({
      action: "apply",
      toVersion: 3,
    });
    expect(decideStep({ current: 5, desired: 1, floor: 2, signedDowngrade: true }).action).toBe(
      "refuse",
    );
  });
});

describe("poisoned-version latch + backoff", () => {
  it("latches after K failures", () => {
    expect(isPoisoned({ 7: 2 }, 7, 3)).toBe(false);
    expect(isPoisoned({ 7: 3 }, 7, 3)).toBe(true);
  });
  it("backs off exponentially, capped", () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(100)).toBe(3_600_000);
  });
});

describe("canaryVerdict (multi-sample quiet window)", () => {
  it("healthy when every quiet sample writes ok", () => {
    expect(
      canaryVerdict([
        { writeOk: true, busy: false },
        { writeOk: false, busy: true },
        { writeOk: true, busy: false },
      ]),
    ).toBe("healthy");
  });
  it("write_broken when a QUIET sample fails", () => {
    expect(
      canaryVerdict([
        { writeOk: true, busy: false },
        { writeOk: false, busy: false },
      ]),
    ).toBe("write_broken");
  });
  it("busy (inconclusive, no restart-storm) when all failures coincide with load", () => {
    expect(
      canaryVerdict([
        { writeOk: false, busy: true },
        { writeOk: false, busy: true },
      ]),
    ).toBe("busy");
  });
});

/**
 * The collab half of the canary. A release that breaks the websocket surface
 * without breaking HTTP used to pass the canary and was never rolled back —
 * these are the cases that make it condemn instead, WITHOUT weakening the
 * quiet-window rule that keeps a busy box from restart-storming.
 */
describe("canaryVerdict · collab probe", () => {
  it("promotes when both halves are ok", () => {
    expect(
      canaryVerdict([
        { writeOk: true, collabOk: true, busy: false },
        { writeOk: true, collabOk: true, busy: false },
      ]),
    ).toBe("healthy");
  });
  it("condemns when a QUIET sample's collab connect failed, write path fine", () => {
    const verdict = canaryVerdict([
      { writeOk: true, collabOk: true, busy: false },
      { writeOk: true, collabOk: false, busy: false },
    ]);
    expect(verdict).toBe("collab_broken");
    // condemnation is what the updater acts on: anything but healthy/busy rolls back
    expect(verdict).not.toBe("healthy");
    expect(verdict).not.toBe("busy");
  });
  it("condemns when the write path failed even though collab is ok", () => {
    const verdict = canaryVerdict([
      { writeOk: true, collabOk: true, busy: false },
      { writeOk: false, collabOk: true, busy: false },
    ]);
    expect(verdict).toBe("write_broken");
    expect(verdict).not.toBe("healthy");
    expect(verdict).not.toBe("busy");
  });
  it("reports write_broken (not collab_broken) when both halves failed", () => {
    // A dead write path explains a dead room; the operator log should say so.
    expect(canaryVerdict([{ writeOk: false, collabOk: false, busy: false }])).toBe("write_broken");
  });
  it("stays busy when the only collab failures are NOISY samples", () => {
    // The quiet-window semantics are unchanged: a busy verdict must stay busy
    // rather than become a false RED that rolls back a healthy release.
    expect(
      canaryVerdict([
        { writeOk: false, collabOk: false, busy: true },
        { writeOk: true, collabOk: false, busy: true },
      ]),
    ).toBe("busy");
  });
  it("ignores a noisy collab failure when the quiet samples are clean", () => {
    expect(
      canaryVerdict([
        { writeOk: true, collabOk: true, busy: false },
        { writeOk: true, collabOk: false, busy: true },
        { writeOk: true, collabOk: true, busy: false },
      ]),
    ).toBe("healthy");
  });
  it("treats an ABSENT collabOk as not-judged, never as a failure", () => {
    // An older box's /canary has no such field — and the release being canaried
    // may be the one that adds it. Absence must never condemn.
    expect(
      canaryVerdict([
        { writeOk: true, busy: false },
        { writeOk: true, collabOk: undefined, busy: false },
      ]),
    ).toBe("healthy");
  });
});

describe("rollbackTarget", () => {
  const kept = [
    { version: 1, minCompatibleSchema: 1 },
    { version: 2, minCompatibleSchema: 2 },
    { version: 3, minCompatibleSchema: 4 },
  ];
  it("picks the newest kept image the migrated schema still supports", () => {
    expect(rollbackTarget(kept, 3)).toBe(2); // v3 needs schema 4; v2 ok
  });
  it("returns null when nothing is compatible", () => {
    expect(rollbackTarget(kept, 0)).toBeNull();
  });
});
