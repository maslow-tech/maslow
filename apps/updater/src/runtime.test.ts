import { describe, expect, it } from "vitest";
import type { BoothClient, BoothHeartbeat } from "./booth-client.js";
import { BundleFetchError, type BoxHost } from "./host.js";
import { runTick } from "./runtime.js";
import type { CanarySample } from "./decisions.js";
import type { PersistedState, ReleaseEntry } from "./versions.js";

const rel = (version: string, opts: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  version,
  imageDigest: `sha256:${version.replace(/\W/g, "").padEnd(64, "0").slice(0, 64)}`,
  channel: "stable",
  yanked: false,
  ...opts,
});

/** A host that records what the loop tried to do; every effect is a no-op. */
function fakeHost(overrides: Partial<Record<keyof BoxHost, unknown>> = {}) {
  const calls = {
    verified: [] as string[],
    pulled: [] as string[],
    migrated: 0,
    saved: [] as PersistedState[],
    pruneKeeps: [] as string[][],
  };
  const host = {
    verify: (digest: string) => {
      calls.verified.push(digest);
      return Promise.resolve(true); // pretend cosign always passes
    },
    pull: (digest: string) => {
      calls.pulled.push(digest);
      return Promise.resolve();
    },
    pinImage: () => {},
    migrate: () => {
      calls.migrated++;
      return Promise.resolve();
    },
    restartApp: () => Promise.resolve(),
    forceRestartApp: () => Promise.resolve(),
    pruneImages: (keep: readonly string[] = []) => {
      calls.pruneKeeps.push([...keep]);
      return Promise.resolve();
    },
    diskPctUsed: () => Promise.resolve(null),
    canary: (): Promise<CanarySample[]> => Promise.resolve([{ writeOk: true, busy: false }]),
    probe: (): Promise<boolean> => Promise.resolve(true),
    rollbackApp: () => Promise.resolve(),
    saveState: (s: PersistedState) => {
      calls.saved.push(s);
    },
    // Bundle surface — legacy-safe defaults: no bundle exists, no
    // snapshot pending, so every pre-bundle test keeps exercising the app-only
    // path byte-for-byte.
    fetchBundle: () => Promise.resolve(null),
    snapshotVersion: () => null,
    snapshotDeploy: () => {},
    restoreDeploySnapshot: () => {},
    clearDeploySnapshot: () => {},
    applyDeployTree: () => Promise.resolve(),
    fileSha256: () => Promise.resolve(""),
    readEnvVar: () => undefined,
    pinEnv: () => {},
    verifyRef: () => Promise.resolve(true),
    pullRef: () => Promise.resolve(),
    upPostgresWait: () => Promise.resolve(),
    upInfraWait: () => Promise.resolve(),
    currentPgMajor: () => Promise.resolve(null),
    currentServiceImage: () => Promise.resolve(null),
    recreateUpdaterSelf: () => Promise.resolve(),
    ...overrides,
  } as unknown as BoxHost;
  return { host, calls };
}

function fakeBooth(
  releases: ReleaseEntry[],
  desired: string | null,
  restartGeneration: number | null = null,
  boxId = "box-1",
  pruneGeneration: number | null = null,
): BoothClient {
  const control =
    restartGeneration === null && pruneGeneration === null
      ? null
      : { restartGeneration: restartGeneration ?? 0, pruneGeneration: pruneGeneration ?? 0, boxId };
  return {
    listReleases: () => Promise.resolve(releases),
    heartbeat: (): Promise<BoothHeartbeat> =>
      Promise.resolve({ kill: "live", desiredVersion: desired, control }),
  } as unknown as BoothClient;
}

const noop = () => {};

describe("runtime · anti-rollback floor gate (booth-independent)", () => {
  it("REFUSES a reordered-list downgrade to a validly-signed older release", async () => {
    // Box runs v0.2.0, floor v0.2.0. A compromised booth reorders its response
    // so v0.1.0 looks like the forward step, and points desired at it.
    const state: PersistedState = {
      currentVersion: "v0.2.0",
      floorVersion: "v0.2.0",
      attempts: {},
      keptVersions: ["v0.2.0"],
    };
    const booth = fakeBooth([rel("v0.2.0"), rel("v0.1.0")], "v0.1.0");
    const { host, calls } = fakeHost();

    const result = await runTick(booth, host, state, noop);

    // The floor gate fails verify → nothing is pulled, migrated, or downgraded.
    expect(calls.pulled).toEqual([]);
    expect(calls.migrated).toBe(0);
    expect(result.state.currentVersion).toBe("v0.2.0");
  });

  it("a cosign failure DEFERS (not latches) — the anti-brick path", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    // cosign returns false (Sigstore/registry outage) — NOT a bad signature we
    // can distinguish. This must defer, never poison.
    const { host, calls } = fakeHost({ verify: () => Promise.resolve(false) });

    const result = await runTick(booth, host, state, noop);

    expect(result.outcome.kind).toBe("verify_deferred");
    expect(calls.pulled).toEqual([]); // never pulled the unverified image
    expect(calls.migrated).toBe(0);
    expect(result.state.currentVersion).toBe("v0.1.0"); // stays on known-good
    expect(result.state.attempts).toEqual({}); // NOT poisoned toward the latch
    expect(result.state.verifyDeferrals?.["v0.2.0"]).toBe(1); // tracked separately
  });

  /**
   * The 2026-07-30 latch bug, end to end. fetchBundle threw a PLAIN Error for
   * every non-missing pull failure, and an untagged throw is DEFINITIVE — so an
   * expired GHCR credential bumped attempts on each poll and latched the box on
   * the third. It then stayed latched after the credential was fixed, because
   * only a runbook clears a latch. This is the regression that must never come
   * back: a registry that will not let us in is a condition of the WORLD, not a
   * property of the release.
   */
  it("an AUTH failure fetching the bundle DEFERS — an expired credential is not a poisoned release", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    const { host, calls } = fakeHost({
      fetchBundle: () =>
        Promise.reject(
          new BundleFetchError(
            "bundle pull failed (auth): Error response from daemon: denied: denied",
            true,
          ),
        ),
    });

    const result = await runTick(booth, host, state, noop);

    expect(result.outcome.kind).toBe("verify_deferred");
    expect(result.state.attempts).toEqual({}); // the whole point: never poisoned
    expect(result.state.currentVersion).toBe("v0.1.0");
    expect(calls.pulled).toEqual([]);
  });

  it("never latches an auth failure no matter how many polls it takes", async () => {
    // Walk past maxFailuresBeforeLatch. A definitive classification would have
    // latched by the third tick; a transient one defers forever and recovers the
    // moment the credential is fixed, with no runbook and no operator.
    let state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    const denied = fakeHost({
      fetchBundle: () =>
        Promise.reject(new BundleFetchError("bundle pull failed (auth): denied", true)),
    });
    for (let i = 0; i < 8; i++) {
      const r = await runTick(booth, denied.host, state, noop);
      expect(r.outcome.kind).toBe("verify_deferred");
      expect(r.state.attempts).toEqual({});
      state = r.state;
    }
    expect(state.verifyDeferrals?.["v0.2.0"]).toBe(8);

    // Credential fixed → the very next poll converges, unaided.
    const healed = fakeHost();
    const r = await runTick(booth, healed.host, state, noop);
    expect(r.outcome.kind).toBe("applied");
    expect(r.state.currentVersion).toBe("v0.2.0");
  });

  it("a STRUCTURALLY bad bundle still poisons toward the latch", async () => {
    // The other half of the split: transient must not become "never latch
    // anything". A hostile or malformed bundle is definitive and still counts.
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    const { host } = fakeHost({
      fetchBundle: () =>
        Promise.reject(new BundleFetchError("bundle deploy tarball hash mismatch", false)),
    });

    const result = await runTick(booth, host, state, noop);

    expect(result.outcome.kind).toBe("verify_failed");
    expect(result.state.attempts["v0.2.0"]).toBe(1);
  });

  it("still applies a genuine forward step", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    const { host, calls } = fakeHost();

    const result = await runTick(booth, host, state, noop);

    expect(calls.migrated).toBe(1);
    expect(result.state.currentVersion).toBe("v0.2.0");
    expect(result.state.floorVersion).toBe("v0.2.0"); // high-water mark rose
  });

  it("prunes after applying, keeping the retained rollback targets by digest", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0", "v0.2.0"], // both retained → both must be kept on disk
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    const { host, calls } = fakeHost();

    const result = await runTick(booth, host, state, noop);

    expect(result.state.currentVersion).toBe("v0.2.0");
    expect(calls.pruneKeeps).toHaveLength(1); // pruned exactly once, on apply
    const keep = calls.pruneKeeps[0]!;
    expect(keep).toContain(rel("v0.1.0").imageDigest); // rollback target kept
    expect(keep).toContain(rel("v0.2.0").imageDigest); // current kept
  });

  it("skips a yanked intermediate release instead of latching on it", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
    };
    // v0.2.0 yanked (bad), v0.3.0 is the fix; desired is the fix.
    const booth = fakeBooth(
      [rel("v0.1.0"), rel("v0.2.0", { yanked: true }), rel("v0.3.0")],
      "v0.3.0",
    );
    const { host, calls } = fakeHost();

    const result = await runTick(booth, host, state, noop);

    // Stepped straight to v0.3.0 — the yanked v0.2.0 was never a target.
    expect(result.state.currentVersion).toBe("v0.3.0");
    expect(calls.migrated).toBe(1);
  });
});

describe("runtime · replay-safe swap journal", () => {
  const digestOf = (v: string) => rel(v).imageDigest;

  it("journals the swap before the pin, and clears it on success", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    const { host, calls } = fakeHost();

    const result = await runTick(booth, host, state, noop);

    // First persisted write is the journal — BEFORE any migrate/restart ran.
    expect(calls.saved[0]?.attempting).toBe("v0.2.0");
    // ... and the end-of-tick save cleared it.
    expect(result.state.attempting).toBeUndefined();
    expect(result.state.currentVersion).toBe("v0.2.0");
  });

  it("counts a mid-swap death as a failed attempt and heals the pin first", async () => {
    // A previous tick died between the pin and the end-of-tick save.
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
      attempting: "v0.2.0",
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    const pins: string[] = [];
    const { host, calls } = fakeHost({
      pinImage: (digest: string) => {
        pins.push(digest);
      },
    });

    const result = await runTick(booth, host, state, noop);

    // Heal: the FIRST pin restores the persisted current version.
    expect(pins[0]).toBe(digestOf("v0.1.0"));
    // The crash was recorded before the re-attempt (visible in the heal save)...
    expect(calls.saved[0]?.attempts["v0.2.0"]).toBe(1);
    expect(calls.saved[0]?.attempting).toBeUndefined();
    // ...and the re-attempt then succeeded normally (green canary).
    expect(result.state.currentVersion).toBe("v0.2.0");
    expect(result.state.attempts["v0.2.0"]).toBeUndefined();
  });

  it("a THROWN migrate is accounted on the NEXT tick — no process restart needed", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    const { host, calls } = fakeHost({
      migrate: () => Promise.reject(new Error("compose blew up")),
      // the real loop reads the state file back; the fake replays the last save
      loadState: () => calls.saved[calls.saved.length - 1] ?? null,
    });

    // Tick 1: migrate throws. runTick must NOT throw — it returns the RELOADED
    // journaled state so the surviving process carries `attempting` forward.
    const r1 = await runTick(booth, host, state, noop);
    expect(r1.outcome.kind).toBe("skipped");
    expect(r1.state.attempting).toBe("v0.2.0");

    // Tick 2 (same process, healthy host): the resume block counts the failure.
    const h2 = fakeHost();
    const r2 = await runTick(booth, h2.host, r1.state, noop);
    expect(h2.calls.saved[0]?.attempts["v0.2.0"]).toBe(1);
    expect(h2.calls.saved[0]?.attempting).toBeUndefined();
    expect(r2.state.currentVersion).toBe("v0.2.0"); // healthy re-attempt applied
  });

  it("RETAINS the journal when the heal itself fails (docker wedged) — and still heartbeats", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
      attempting: "v0.2.0",
    };
    let heartbeats = 0;
    const booth = {
      listReleases: () => Promise.resolve([rel("v0.1.0"), rel("v0.2.0")]),
      heartbeat: (): Promise<BoothHeartbeat> => {
        heartbeats++;
        return Promise.resolve({ kill: "live", desiredVersion: null, control: null });
      },
    } as unknown as BoothClient;
    const { host, calls } = fakeHost({
      restartApp: () => Promise.reject(new Error("docker daemon wedged")),
    });

    const result = await runTick(booth, host, state, noop);

    // Journal NOT cleared, failure NOT double-booked — the resume replays next
    // tick; and the box still reported in (no false 'offline' page).
    expect(result.state.attempting).toBe("v0.2.0");
    expect(result.state.attempts["v0.2.0"]).toBeUndefined();
    expect(heartbeats).toBeGreaterThan(0);
    expect(calls.saved.every((s) => s.attempts["v0.2.0"] === undefined)).toBe(true);
  });

  it("the heal's own restart satisfies a pending restart op — no second bounce", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: {},
      keptVersions: ["v0.1.0"],
      attempting: "v0.2.0",
      honoredRestartGeneration: 3,
      boxId: "box-1",
    };
    // Pending restart op (gen 4) arrives on the same tick as the journal resume.
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], null, 4);
    const { host } = fakeHost({
      forceRestartApp: () => Promise.reject(new Error("must not double-bounce after the heal")),
    });

    const result = await runTick(booth, host, state, noop);
    expect(result.state.honoredRestartGeneration).toBe(4); // satisfied by the heal
  });

  it("a THROWN migrate surfaces failures for backoff AND still honors a restart op", async () => {
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: { "v0.2.0": 1 },
      keptVersions: ["v0.1.0"],
      honoredRestartGeneration: 3,
      boxId: "box-1",
    };
    let forced = 0;
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0", 4);
    const { host } = fakeHost({
      migrate: () => Promise.reject(new Error("boom")),
      forceRestartApp: () => {
        forced++;
        return Promise.resolve();
      },
    });

    const result = await runTick(booth, host, state, noop);

    expect(result.outcome.kind).toBe("skipped");
    expect(result.failures).toBe(2); // pending count → main's backoff engages
    expect(forced).toBe(1); // the op still fired during the failing-swap window
    expect(result.state.honoredRestartGeneration).toBe(4);
    expect(result.state.attempting).toBe("v0.2.0");
  });

  it("a version that keeps killing the updater latches across deaths", async () => {
    // Two prior failures + one more mid-swap death = the latch threshold (3).
    const state: PersistedState = {
      currentVersion: "v0.1.0",
      floorVersion: "v0.1.0",
      attempts: { "v0.2.0": 2 },
      keptVersions: ["v0.1.0"],
      attempting: "v0.2.0",
    };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0");
    const { host, calls } = fakeHost();

    const result = await runTick(booth, host, state, noop);

    // Poisoned: held at v0.1.0, nothing pulled or migrated this tick.
    expect(result.state.currentVersion).toBe("v0.1.0");
    expect(result.state.attempts["v0.2.0"]).toBe(3);
    expect(calls.pulled).toEqual([]);
    expect(calls.migrated).toBe(0);
  });
});

describe("runtime · operator restart op (operator op)", () => {
  const upToDate: PersistedState = {
    currentVersion: "v0.1.0",
    floorVersion: "v0.1.0",
    attempts: {},
    keptVersions: ["v0.1.0"],
  };
  // The op must use the FORCE restart (compose `restart`): `up -d` no-ops on an
  // unchanged image — exactly the wedged-app case. Count both paths separately.
  const restartCountingHost = () => {
    let force = 0;
    let swaps = 0;
    const { host, calls } = fakeHost({
      forceRestartApp: () => {
        force++;
        return Promise.resolve();
      },
      restartApp: () => {
        swaps++;
        return Promise.resolve();
      },
    });
    return { host, calls, force: () => force, swaps: () => swaps };
  };

  it("ADOPTS the current generation without restarting when the state has no mark", async () => {
    const booth = fakeBooth([rel("v0.1.0")], "v0.1.0", 3);
    const h = restartCountingHost();

    const result = await runTick(booth, h.host, upToDate, noop);

    expect(h.force()).toBe(0); // an updater upgrade must not surprise-restart
    expect(result.state.honoredRestartGeneration).toBe(3);
  });

  it("FORCE-restarts the app ONCE when the generation rises past the persisted mark", async () => {
    const state = { ...upToDate, honoredRestartGeneration: 3 };
    const booth = fakeBooth([rel("v0.1.0")], "v0.1.0", 4);
    const h = restartCountingHost();

    const result = await runTick(booth, h.host, state, noop);
    expect(h.force()).toBe(1); // compose `restart`, not the lazy `up -d`
    expect(h.swaps()).toBe(0);
    expect(result.state.honoredRestartGeneration).toBe(4);

    // Replay of the SAME generation is a no-op (idempotent honor).
    const again = await runTick(booth, h.host, result.state, noop);
    expect(h.force()).toBe(1);
    expect(again.state.honoredRestartGeneration).toBe(4);
  });

  it("does not bounce a freshly-applied update a second time", async () => {
    const state = { ...upToDate, honoredRestartGeneration: 3 };
    // Coincident: a forward step AND a pending restart op in the same tick.
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0", 4);
    const h = restartCountingHost();

    const result = await runTick(booth, h.host, state, noop);

    expect(result.state.currentVersion).toBe("v0.2.0");
    expect(h.swaps()).toBe(1); // the swap's own restart satisfied the op...
    expect(h.force()).toBe(0); // ...no second bounce
    expect(result.state.honoredRestartGeneration).toBe(4);
  });

  it("does not bounce after a busy-canary tick either (the swap restarted the app)", async () => {
    const state = { ...upToDate, honoredRestartGeneration: 3 };
    const booth = fakeBooth([rel("v0.1.0"), rel("v0.2.0")], "v0.2.0", 4);
    const h = restartCountingHost();
    // canary inconclusive → busy_retry; the app was still restarted pre-canary.
    const { host } = fakeHost({
      forceRestartApp: () => {
        throw new Error("must not force-restart during an inconclusive canary");
      },
      canary: (): Promise<CanarySample[]> => Promise.resolve([{ writeOk: false, busy: true }]),
      saveState: (s: PersistedState) => h.calls.saved.push(s),
    });

    const result = await runTick(booth, host, state, noop);
    expect(result.state.honoredRestartGeneration).toBe(4); // satisfied, marked
  });

  it("NEVER adopts without a verified control — no key ≠ generation 0", async () => {
    // Booth key unconfigured for a while (control: null) — the mark must stay
    // ABSENT, so the later key rollout adopts instead of surprise-restarting.
    const booth = fakeBooth([rel("v0.1.0")], "v0.1.0", null);
    const h = restartCountingHost();

    const result = await runTick(booth, h.host, upToDate, noop);
    expect(result.state.honoredRestartGeneration).toBeUndefined();
    expect(h.force()).toBe(0);

    // Key deployed later, booth already at gen 2: adopt, still no restart.
    const withKey = fakeBooth([rel("v0.1.0")], "v0.1.0", 2);
    const after = await runTick(withKey, h.host, result.state, noop);
    expect(after.state.honoredRestartGeneration).toBe(2);
    expect(h.force()).toBe(0);
  });

  it("adopts DOWN when the booth counter regressed (DB restore) instead of going deaf", async () => {
    const state = { ...upToDate, honoredRestartGeneration: 7, boxId: "box-1" };
    const booth = fakeBooth([rel("v0.1.0")], "v0.1.0", 1); // restored booth: gen 1 < 7
    const h = restartCountingHost();

    const result = await runTick(booth, h.host, state, noop);
    expect(h.force()).toBe(0); // regression itself never restarts
    expect(result.state.honoredRestartGeneration).toBe(1);

    // The very next operator click works again.
    const clicked = fakeBooth([rel("v0.1.0")], "v0.1.0", 2);
    const after = await runTick(clicked, h.host, result.state, noop);
    expect(h.force()).toBe(1);
    expect(after.state.honoredRestartGeneration).toBe(2);
  });

  it("pins box_id on first verified control and IGNORES a cross-box replay", async () => {
    const state = { ...upToDate, honoredRestartGeneration: 3, boxId: "box-1" };
    // A validly-signed control from ANOTHER box with a huge generation.
    const booth = fakeBooth([rel("v0.1.0")], "v0.1.0", 50, "box-OTHER");
    const h = restartCountingHost();

    const result = await runTick(booth, h.host, state, noop);
    expect(h.force()).toBe(0); // not restarted...
    expect(result.state.honoredRestartGeneration).toBe(3); // ...and not mark-poisoned
  });

  it("honors the op on the DEGRADED early-return path too (release list down)", async () => {
    const state = { ...upToDate, honoredRestartGeneration: 3, boxId: "box-1" };
    const h = restartCountingHost();
    const booth = {
      listReleases: () => Promise.reject(new Error("booth 500")),
      heartbeat: (): Promise<BoothHeartbeat> =>
        Promise.resolve({
          kill: "live",
          desiredVersion: null,
          control: { restartGeneration: 4, pruneGeneration: 0, boxId: "box-1" },
        }),
    } as unknown as BoothClient;

    const result = await runTick(booth, h.host, state, noop);
    expect(result.outcome.kind).toBe("skipped"); // tick held, but...
    expect(h.force()).toBe(1); // ...the wedged box still got its restart
    expect(result.state.honoredRestartGeneration).toBe(4);
  });
});

describe("runtime · operator reclaim-disk op (prune on demand)", () => {
  const upToDate: PersistedState = {
    currentVersion: "v0.1.0",
    floorVersion: "v0.1.0",
    attempts: {},
    keptVersions: ["v0.1.0"],
  };

  it("ADOPTS the prune generation without pruning when the state has no mark", async () => {
    const booth = fakeBooth([rel("v0.1.0")], "v0.1.0", null, "box-1", 2);
    const { host, calls } = fakeHost();
    const result = await runTick(booth, host, upToDate, noop);
    expect(calls.pruneKeeps).toHaveLength(0); // shipping the op must not surprise-prune
    expect(result.state.honoredPruneGeneration).toBe(2);
  });

  it("PRUNES once when the generation rises past the mark, keeping rollback digests", async () => {
    const state = { ...upToDate, honoredPruneGeneration: 2 };
    const booth = fakeBooth([rel("v0.1.0")], "v0.1.0", null, "box-1", 3);
    const { host, calls } = fakeHost();

    const result = await runTick(booth, host, state, noop);
    expect(calls.pruneKeeps).toHaveLength(1); // pruned exactly once, on demand
    expect(calls.pruneKeeps[0]).toContain(rel("v0.1.0").imageDigest); // keeps current
    expect(result.state.honoredPruneGeneration).toBe(3);

    // Replay of the SAME generation is idempotent — no second prune.
    const again = await runTick(booth, host, result.state, noop);
    expect(calls.pruneKeeps).toHaveLength(1);
    expect(again.state.honoredPruneGeneration).toBe(3);
  });

  it("an unsigned/absent control never triggers a prune", async () => {
    const booth = fakeBooth([rel("v0.1.0")], "v0.1.0"); // control === null
    const { host, calls } = fakeHost();
    const result = await runTick(booth, host, upToDate, noop);
    expect(calls.pruneKeeps).toHaveLength(0);
    expect(result.state.honoredPruneGeneration).toBeUndefined();
  });
});

// ---------------------------------------------------------------- bundles

/** valid-shaped digest */
const d64 = (c: string): string => `sha256:${c.repeat(64)}`;

function bundleJson(version: string, appDigest: string): string {
  return JSON.stringify({
    bundle_schema: 1,
    version,
    postgres_major: "17",
    deploy_sha256: "e".repeat(64),
    images: {
      app: { repo: "ghcr.io/org/brain/box", digest: appDigest },
      updater: { repo: "ghcr.io/org/brain/updater", digest: d64("b") },
      postgres: { repo: "ghcr.io/org/brain/postgres", digest: d64("c") },
      caddy: { repo: "docker.io/library/caddy", digest: d64("d") },
    },
  });
}

/** same, but carrying a stray images.harness pin — the shape every
 *  PRE-REMOVAL bundle (the rollback target's) still has. */
function bundleJsonH(version: string, appDigest: string): string {
  const b = JSON.parse(bundleJson(version, appDigest)) as { images: Record<string, unknown> };
  b.images.harness = { repo: "ghcr.io/org/brain/harness", digest: d64("7") };
  return JSON.stringify(b);
}

/** A fake host that records CALL ORDER — apply-sequence assertions need it. */
function bundleHost(opts: {
  rawJson: string;
  canaryOk?: boolean;
  pgMajor?: string | null;
  fetchRejects?: boolean;
  presetSnapshotVersion?: string;
  canarySeq?: ("ok" | "busy" | "broken")[];
}) {
  const order: string[] = [];
  let snapVersion: string | null = opts.presetSnapshotVersion ?? null;
  let canaryCall = 0;
  const rec =
    (name: string, ret?: unknown) =>
    (..._a: unknown[]) => {
      order.push(name);
      return ret instanceof Promise ? ret : Promise.resolve(ret);
    };
  const host = {
    verify: rec("verify", true),
    verifyRef: rec("verifyRef", true),
    pull: rec("pull"),
    pullRef: rec("pullRef"),
    pinImage: (..._a: unknown[]) => void order.push("pinImage"),
    pinEnv: (name: string) => void order.push(`pinEnv:${name}`),
    readEnvVar: () => undefined, // nothing pinned yet → everything changes
    currentPgMajor: () => Promise.resolve(opts.pgMajor === undefined ? "17" : opts.pgMajor),
    currentServiceImage: () => Promise.resolve(null),
    fetchBundle: () =>
      opts.fetchRejects
        ? Promise.reject(new Error("bundle pull failed (not a missing tag): GHCR 503"))
        : Promise.resolve({ rawJson: opts.rawJson, tarPath: "/dev/null" }),
    fileSha256: () => Promise.resolve("e".repeat(64)),
    snapshotDeploy: (version: string) => {
      order.push(`snapshotDeploy:${version}`);
      snapVersion = version;
    },
    snapshotVersion: () => snapVersion,
    restoreDeploySnapshot: () => void order.push("restoreDeploySnapshot"),
    clearDeploySnapshot: () => {
      order.push("clearDeploySnapshot");
      snapVersion = null;
    },
    applyDeployTree: rec("applyDeployTree"),
    upPostgresWait: rec("upPostgresWait"),
    upInfraWait: rec("upInfraWait"),
    migrate: rec("migrate"),
    restartApp: rec("restartApp"),
    forceRestartApp: rec("forceRestartApp"),
    recreateUpdaterSelf: (ref: string) => {
      order.push(`recreateUpdaterSelf:${ref.slice(0, 24)}`);
      return Promise.resolve();
    },
    canary: () => {
      const verdict = opts.canarySeq?.[canaryCall++] ?? (opts.canaryOk !== false ? "ok" : "broken");
      const sample: CanarySample =
        verdict === "ok"
          ? { writeOk: true, busy: false }
          : verdict === "busy"
            ? { writeOk: false, busy: true }
            : { writeOk: false, busy: false };
      return Promise.resolve([sample]);
    },
    probe: () => Promise.resolve(true),
    saveState: (_s: PersistedState) => void order.push("saveState"),
  } as unknown as BoxHost;
  return { host, order, snapshotVersion: () => snapVersion };
}

const V1 = "v0.1.0";
const V2 = "v0.2.0";

function bundleState(): PersistedState {
  return { currentVersion: V1, floorVersion: V1, attempts: {}, keptVersions: [V1] };
}

describe("runtime · whole-box bundle apply", () => {
  it("applies in the safe order and self-updates LAST, after the state save", async () => {
    const appDigest = d64("9");
    const booth = fakeBooth([rel(V1), rel(V2, { imageDigest: appDigest })], V2);
    const { host, order } = bundleHost({ rawJson: bundleJson(V2, appDigest) });

    const result = await runTick(booth, host, bundleState(), noop);

    expect(result.outcome.kind).toBe("applied");
    expect(result.state.currentVersion).toBe(V2);
    const idx = (n: string) => order.indexOf(n);
    // snapshot before ANY mutation; configs before pins; postgres up before
    // migrate; whole-topology up before canary (canary isn't in `order` — it
    // has its own recorder — but upAllWait precedes clearDeploySnapshot which
    // precedes the self-update pair, which is LAST after saveState).
    expect(idx(`snapshotDeploy:${V2}`)).toBeGreaterThan(-1);
    expect(idx(`snapshotDeploy:${V2}`)).toBeLessThan(idx("applyDeployTree"));
    expect(idx("applyDeployTree")).toBeLessThan(idx("pinEnv:BRAIN_POSTGRES_IMAGE"));
    expect(idx("upPostgresWait")).toBeGreaterThan(idx("pinEnv:BRAIN_POSTGRES_IMAGE"));
    expect(idx("upPostgresWait")).toBeLessThan(idx("migrate"));
    expect(idx("migrate")).toBeLessThan(idx("upInfraWait"));
    expect(idx("clearDeploySnapshot")).toBeGreaterThan(idx("upInfraWait"));
    expect(idx("pinEnv:BRAIN_UPDATER_IMAGE")).toBeGreaterThan(order.lastIndexOf("saveState"));
    expect(order[order.length - 1]!.startsWith("recreateUpdaterSelf:")).toBe(true);
  });

  it("NEVER pins the removed harness component — a pre-removal bundle's stray pin is ignored, not fatal", async () => {
    const appDigest = d64("9");
    const withH = bundleHost({ rawJson: bundleJsonH(V2, appDigest) });
    const rH = await runTick(
      fakeBooth([rel(V1), rel(V2, { imageDigest: appDigest })], V2),
      withH.host,
      bundleState(),
      noop,
    );
    expect(rH.outcome.kind).toBe("applied");
    expect(withH.order).not.toContain("pinEnv:BRAIN_HARNESS_IMAGE");
  });

  it("a failed canary rolls the WHOLE shape back and never self-updates", async () => {
    const appDigest = d64("9");
    const booth = fakeBooth([rel(V1), rel(V2, { imageDigest: appDigest })], V2);
    const { host, order } = bundleHost({
      rawJson: bundleJson(V2, appDigest),
      canaryOk: false,
    });

    const result = await runTick(booth, host, bundleState(), noop);

    expect(result.outcome.kind).toBe("rolled_back");
    expect(order).toContain("restoreDeploySnapshot");
    expect(order.indexOf("restoreDeploySnapshot")).toBeLessThan(order.lastIndexOf("upInfraWait"));
    expect(order).not.toContain("pinEnv:BRAIN_UPDATER_IMAGE");
    expect(order.some((o) => o.startsWith("recreateUpdaterSelf:"))).toBe(false);
  });

  it("a bundle whose version/app-digest cross-checks fail is REFUSED (verify_failed)", async () => {
    const appDigest = d64("9");
    const booth = fakeBooth([rel(V1), rel(V2, { imageDigest: appDigest })], V2);
    // bundle names a DIFFERENT app digest than the booth record
    const { host, order } = bundleHost({ rawJson: bundleJson(V2, d64("7")) });

    const result = await runTick(booth, host, bundleState(), noop);

    expect(result.outcome.kind).toBe("verify_failed");
    expect(order).not.toContain("migrate");
    expect(order).not.toContain("applyDeployTree");
  });

  it("REFUSES a cross-major postgres bundle (verify_failed → latch, runbook-only)", async () => {
    const appDigest = d64("9");
    const booth = fakeBooth([rel(V1), rel(V2, { imageDigest: appDigest })], V2);
    const { host, order } = bundleHost({
      rawJson: bundleJson(V2, appDigest),
      pgMajor: "16", // box runs 16; bundle pins 17
    });

    const result = await runTick(booth, host, bundleState(), noop);

    expect(result.outcome.kind).toBe("verify_failed");
    expect(order.some((o) => o.startsWith("snapshotDeploy"))).toBe(false);
    expect(order).not.toContain("upPostgresWait");
  });

  it("a release with NO bundle takes the legacy app-only path untouched", async () => {
    const booth = fakeBooth([rel(V1), rel(V2)], V2);
    const { host, calls } = fakeHost(); // fetchBundle → null
    const result = await runTick(booth, host, bundleState(), noop);
    expect(result.outcome.kind).toBe("applied");
    expect(calls.migrated).toBe(1);
  });

  it("a bundle TRANSPORT failure fails verify — never a silent app-only downgrade", async () => {
    const appDigest = d64("9");
    const booth = fakeBooth([rel(V1), rel(V2, { imageDigest: appDigest })], V2);
    const { host, order } = bundleHost({ rawJson: bundleJson(V2, appDigest), fetchRejects: true });

    const result = await runTick(booth, host, bundleState(), noop);

    expect(result.outcome.kind).toBe("verify_failed"); // retried w/ backoff, latches eventually
    expect(order).not.toContain("migrate");
    expect(result.state.currentVersion).toBe(V1); // version did NOT advance without the infra
  });

  it("a busy-canary retry REUSES the original pre-swap snapshot as the rollback baseline", async () => {
    const appDigest = d64("9");
    const booth = fakeBooth([rel(V1), rel(V2, { imageDigest: appDigest })], V2);
    const { host, order, snapshotVersion } = bundleHost({
      rawJson: bundleJson(V2, appDigest),
      canarySeq: ["busy", "broken"],
    });

    // Tick 1: apply completes, canary inconclusive → busy_retry, snapshot kept.
    const t1 = await runTick(booth, host, bundleState(), noop);
    expect(t1.outcome.kind).toBe("busy_retry");
    expect(snapshotVersion()).toBe(V2);
    const snapshotsAfterT1 = order.filter((o) => o.startsWith("snapshotDeploy")).length;

    // Tick 2: retry — must NOT re-snapshot the already-mutated shape.
    const t2 = await runTick(booth, host, t1.state, noop);
    expect(t2.outcome.kind).toBe("rolled_back");
    const snapshotsAfterT2 = order.filter((o) => o.startsWith("snapshotDeploy")).length;
    expect(snapshotsAfterT2).toBe(snapshotsAfterT1); // baseline preserved
    expect(order).toContain("restoreDeploySnapshot");
  });

  it("the swap-journal heal DISCARDS a stale snapshot from another version instead of restoring it", async () => {
    const booth = fakeBooth([rel(V1), rel(V2)], V2);
    // journaled attempt for V2, but the snapshot on disk is from old V1 days
    const { host, order } = bundleHost({
      rawJson: bundleJson(V2, rel(V2).imageDigest),
      presetSnapshotVersion: "v0.0.9",
    });
    const state: PersistedState = { ...bundleState(), attempting: V2 };

    await runTick(booth, host, state, noop);

    // stale snapshot cleared WITHOUT being restored
    const restoreIdx = order.indexOf("restoreDeploySnapshot");
    const clearIdx = order.indexOf("clearDeploySnapshot");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(restoreIdx === -1 || restoreIdx > clearIdx).toBe(true);
  });

  it("an up_to_date tick reconciles a stale updater self-pin via the detached recreate", async () => {
    const booth = fakeBooth([rel(V1)], V1); // nothing to step to
    const pinnedRef = `ghcr.io/org/brain/updater@${d64("b")}`;
    const order: string[] = [];
    const { host } = fakeHost({
      readEnvVar: (name: string) => (name === "BRAIN_UPDATER_IMAGE" ? pinnedRef : undefined),
      currentServiceImage: () => Promise.resolve("ghcr.io/org/brain/updater@sha256:old"),
      verifyRef: () => Promise.resolve(true),
      recreateUpdaterSelf: (ref: string) => {
        order.push(`recreate:${ref}`);
        return Promise.resolve();
      },
    });

    const result = await runTick(booth, host, bundleState(), noop);

    expect(result.outcome.kind).toBe("up_to_date");
    expect(order).toEqual([`recreate:${pinnedRef}`]);
  });
});
