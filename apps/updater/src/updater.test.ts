import { describe, expect, it } from "vitest";
import { Updater, type Heartbeat, type UpdaterAdapters, type UpdaterState } from "./updater.js";
import type { CanarySample } from "./decisions.js";

interface Recorder {
  verified: number[];
  pulled: number[];
  migrated: number[];
  restarts: number;
  rolledBackTo: number[];
  prunes: number;
}

function makeAdapters(opts: {
  hb: Heartbeat;
  verify?: import("./updater.js").VerifyResult;
  schemaVersion?: number;
  canary?: readonly CanarySample[];
  pruneThrows?: boolean;
}): { adapters: UpdaterAdapters; rec: Recorder } {
  const rec: Recorder = {
    verified: [],
    pulled: [],
    migrated: [],
    restarts: 0,
    rolledBackTo: [],
    prunes: 0,
  };
  const adapters: UpdaterAdapters = {
    heartbeat: async () => opts.hb,
    verify: async (v) => {
      rec.verified.push(v);
      return opts.verify ?? { ok: true };
    },
    pullByDigest: async (v) => {
      rec.pulled.push(v);
    },
    migrate: async (v) => {
      rec.migrated.push(v);
      return { schemaVersion: opts.schemaVersion ?? v };
    },
    restart: async () => {
      rec.restarts += 1;
    },
    writeCanary: async () => opts.canary ?? [{ writeOk: true, busy: false }],
    rollbackApp: async (v) => {
      rec.rolledBackTo.push(v);
    },
    report: async () => undefined,
    pruneImages: async () => {
      rec.prunes += 1;
      if (opts.pruneThrows) throw new Error("disk busy");
    },
  };
  return { adapters, rec };
}

const baseState = (over: Partial<UpdaterState> = {}): UpdaterState => ({
  current: 1,
  floor: 1,
  attempts: {},
  deferrals: {},
  kept: [
    { version: 1, minCompatibleSchema: 1 },
    { version: 2, minCompatibleSchema: 2 },
  ],
  ...over,
});

describe("Updater.tick", () => {
  it("applies N→N+1 on a healthy canary", async () => {
    const { adapters, rec } = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
    });
    const { state, outcome } = await new Updater(adapters).tick(baseState());
    expect(outcome).toEqual({ kind: "applied", version: 2 });
    expect(state.current).toBe(2);
    expect(rec.migrated).toEqual([2]);
    expect(rec.restarts).toBe(1);
  });

  it("only steps one release toward a far desired version", async () => {
    const { adapters } = makeAdapters({ hb: { desiredVersion: 9, kill: "live", schemaFloor: 1 } });
    const { state, outcome } = await new Updater(adapters).tick(baseState({ current: 1 }));
    expect(outcome).toMatchObject({ kind: "applied", version: 2 });
    expect(state.current).toBe(2);
  });

  it("refuses a downgrade (no signed flag) without touching anything", async () => {
    const { adapters, rec } = makeAdapters({
      hb: { desiredVersion: 1, kill: "live", schemaFloor: 1 },
    });
    const { outcome } = await new Updater(adapters).tick(baseState({ current: 3 }));
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(rec.verified).toEqual([]);
  });

  it("rolls back to the newest schema-compatible image when the write path is broken", async () => {
    const { adapters, rec } = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      schemaVersion: 2,
      canary: [{ writeOk: false, busy: false }],
    });
    const { state, outcome } = await new Updater(adapters).tick(baseState({ current: 1 }));
    expect(outcome).toMatchObject({ kind: "rolled_back", from: 2, to: 2 });
    expect(rec.rolledBackTo).toEqual([2]);
    expect(state.attempts[2]).toBe(1);
  });

  it("a false-RED (busy) canary does NOT roll back or restart-storm", async () => {
    const { adapters, rec } = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      canary: [{ writeOk: false, busy: true }],
    });
    const start = baseState({ current: 1 });
    const { state, outcome } = await new Updater(adapters).tick(start);
    expect(outcome).toMatchObject({ kind: "busy_retry" });
    expect(rec.rolledBackTo).toEqual([]);
    expect(state.current).toBe(1); // unchanged
    expect(state.attempts).toEqual({}); // not counted as a failure
  });

  it("latches a poisoned version after K failures (no further verify)", async () => {
    const { adapters, rec } = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
    });
    const { outcome } = await new Updater(adapters, { maxFailuresBeforeLatch: 3 }).tick(
      baseState({ current: 1, attempts: { 2: 3 } }),
    );
    expect(outcome).toEqual({ kind: "latched", version: 2 });
    expect(rec.verified).toEqual([]); // did not even try
  });

  it("counts a verify failure toward the latch", async () => {
    const { adapters } = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      verify: { ok: false, transient: false },
    });
    const { state, outcome } = await new Updater(adapters).tick(baseState({ current: 1 }));
    expect(outcome).toMatchObject({ kind: "verify_failed", version: 2 });
    expect(state.attempts[2]).toBe(1);
  });

  it("ANTI-BRICK: a TRANSIENT verify failure defers and NEVER latches", async () => {
    // A cosign/registry/Sigstore outage returns transient:true. It must retry
    // forever without ever poisoning the version — the box stays on current.
    const { adapters, rec } = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      verify: { ok: false, transient: true },
    });
    const updater = new Updater(adapters, { maxFailuresBeforeLatch: 3 });
    let state = baseState({ current: 1 });
    for (let i = 0; i < 5; i++) {
      const r = await updater.tick(state);
      expect(r.outcome).toEqual({ kind: "verify_deferred", version: 2 });
      state = r.state;
      expect(state.attempts).toEqual({}); // NEVER bumped → isPoisoned never trips
      expect(state.current).toBe(1); // stays on known-good
    }
    expect(state.deferrals[2]).toBe(5); // tracked separately (drives observability)
    expect(rec.pulled).toEqual([]); // never pulled the unverified image
  });

  it("a DEFINITIVE verify failure after transient defers clears deferrals and bumps attempts", async () => {
    const defer = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      verify: { ok: false, transient: true },
    });
    let state = (await new Updater(defer.adapters).tick(baseState({ current: 1 }))).state;
    expect(state.deferrals[2]).toBe(1);
    // now the same version turns definitively bad
    const def = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      verify: { ok: false, transient: false },
    });
    state = (await new Updater(def.adapters).tick(state)).state;
    expect(state.attempts[2]).toBe(1); // now poisons
    expect(state.deferrals[2]).toBeUndefined(); // deferral cleared
  });

  it("prunes superseded images after a successful swap (reclaims disk)", async () => {
    const { adapters, rec } = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
    });
    const { outcome } = await new Updater(adapters).tick(baseState());
    expect(outcome).toEqual({ kind: "applied", version: 2 });
    expect(rec.prunes).toBe(1);
  });

  it("does NOT prune when the swap did not apply (verify fail, rollback, busy)", async () => {
    const verifyFail = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      verify: { ok: false, transient: false },
    });
    await new Updater(verifyFail.adapters).tick(baseState({ current: 1 }));
    expect(verifyFail.rec.prunes).toBe(0);

    const rolledBack = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      schemaVersion: 2,
      canary: [{ writeOk: false, busy: false }],
    });
    await new Updater(rolledBack.adapters).tick(baseState());
    expect(rolledBack.rec.prunes).toBe(0);

    const busy = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      canary: [{ writeOk: false, busy: true }],
    });
    await new Updater(busy.adapters).tick(baseState());
    expect(busy.rec.prunes).toBe(0);
  });

  it("a prune failure never turns an applied swap into a failure", async () => {
    const { adapters, rec } = makeAdapters({
      hb: { desiredVersion: 2, kill: "live", schemaFloor: 1 },
      pruneThrows: true,
    });
    const { state, outcome } = await new Updater(adapters).tick(baseState());
    expect(outcome).toEqual({ kind: "applied", version: 2 }); // still applied
    expect(state.current).toBe(2);
    expect(rec.prunes).toBe(1); // it was attempted, and its throw was swallowed
  });
});
