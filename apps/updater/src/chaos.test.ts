import { describe, expect, it } from "vitest";
import type { BoothClient, BoothHeartbeat } from "./booth-client.js";
import type { BoxHost } from "./host.js";
import { runTick } from "./runtime.js";
import type { CanarySample } from "./decisions.js";
import type { PersistedState, ReleaseEntry } from "./versions.js";

/**
 * Chaos matrix — the stress harness behind the whole-box bundle updater.
 *
 * A FakeBox models everything the real BoxHost mutates: .env pins, the deploy
 * tree, the containers each compose op would (re)create, the snapshot, and
 * the persisted state file. The harness then KILLS the updater (an async host
 * call that never returns — exactly what process death looks like from the
 * state's perspective) at EVERY async boundary of the bundle apply, both
 * BEFORE and AFTER the call's effect lands, and lets fresh ticks recover.
 *
 * The one invariant under test: the box always ends WHOLE — either fully
 * converged to the new release (every pin, container, and config on the new
 * shape; no snapshot; no journal) or, when the canary condemns the release,
 * fully restored to the old shape. Never a mix.
 */

const dig = (c: string): string => `sha256:${c.repeat(64)}`;
const V1 = "v0.1.0";
const V2 = "v0.2.0";
const APP_V1 = dig("1");
const APP_V2 = dig("2");
const UPD_V2 = dig("b");
const PG_V2 = dig("c");
const CADDY_V2 = dig("d");

const REPO = "ghcr.io/org/brain";
const APP_V1_REF = `${REPO}/box@${APP_V1}`;
const APP_V2_REF = `${REPO}/box@${APP_V2}`;
const PG_V2_REF = `${REPO}/postgres@${PG_V2}`;
const CADDY_V2_REF = `docker.io/library/caddy@${CADDY_V2}`;
const UPD_V2_REF = `${REPO}/updater@${UPD_V2}`;

const RELEASES: ReleaseEntry[] = [
  { version: V1, imageDigest: APP_V1, channel: "stable", yanked: false },
  { version: V2, imageDigest: APP_V2, channel: "stable", yanked: false },
];

const BUNDLE_JSON = JSON.stringify({
  bundle_schema: 1,
  version: V2,
  postgres_major: "17",
  deploy_sha256: "e".repeat(64),
  images: {
    app: { repo: `${REPO}/box`, digest: APP_V2 },
    updater: { repo: `${REPO}/updater`, digest: UPD_V2 },
    postgres: { repo: `${REPO}/postgres`, digest: PG_V2 },
    caddy: { repo: "docker.io/library/caddy", digest: CADDY_V2 },
  },
});

const booth: BoothClient = {
  listReleases: () => Promise.resolve(RELEASES),
  heartbeat: (): Promise<BoothHeartbeat> =>
    Promise.resolve({ kill: "live", desiredVersion: V2, control: null }),
} as unknown as BoothClient;

/** A promise that never settles — the updater process died mid-await. */
const DEATH = new Promise<never>(() => {});

interface BoxWorld {
  env: Map<string, string>;
  deployTree: string; // which release's configs are laid down
  containers: { app: string; postgres: string; caddy: string; updater: string };
  snapshot: { version: string; env: Map<string, string>; deployTree: string } | null;
  state: PersistedState;
  canaryHealthy: boolean;
}

// compose fallbacks when a pin is absent (a real box built/pulled these at
// install): postgres falls back to the locally-built image, caddy to the
// in-repo pin of whichever deploy tree is laid down.
const PG_FALLBACK = "brain/postgres:local";
const caddyFallback = (tree: string): string => `caddy-fallback-${tree}`;

function freshWorld(canaryHealthy: boolean): BoxWorld {
  return {
    env: new Map([["BRAIN_IMAGE", APP_V1_REF]]),
    deployTree: V1,
    containers: {
      app: APP_V1_REF,
      postgres: PG_FALLBACK,
      caddy: caddyFallback(V1),
      updater: "upd-v1",
    },
    snapshot: null,
    state: { currentVersion: V1, floorVersion: V1, attempts: {}, keptVersions: [V1] },
    canaryHealthy,
  };
}

/**
 * Build a BoxHost over the world. `kill` names one async call site and a
 * phase: "before" (die before the effect lands) or "after" (effect lands,
 * then die). Armed once; after firing, subsequent ticks run normally —
 * modeling the container restarting after the crash.
 */
function makeHost(world: BoxWorld, kill?: { at: string; phase: "before" | "after" }) {
  let armed = kill !== undefined;
  const maybeKill = async <T>(site: string, effect: () => T): Promise<T> => {
    if (armed && kill!.at === site && kill!.phase === "before") {
      armed = false;
      return DEATH as Promise<T>;
    }
    const r = effect();
    if (armed && kill!.at === site && kill!.phase === "after") {
      armed = false;
      return DEATH as Promise<T>;
    }
    return r;
  };
  const infraUp = () => {
    // compose up -d --wait, updater EXCLUDED: containers CONVERGE to the pins,
    // or to the compose fallbacks when a pin is absent (compose recreates on
    // any diff — an unpinned service does not keep a previously-pinned image).
    world.containers.app = world.env.get("BRAIN_IMAGE") ?? world.containers.app;
    world.containers.postgres = world.env.get("BRAIN_POSTGRES_IMAGE") ?? PG_FALLBACK;
    world.containers.caddy = world.env.get("BRAIN_CADDY_IMAGE") ?? caddyFallback(world.deployTree);
  };
  const host = {
    verify: () => Promise.resolve(true),
    verifyRef: () => Promise.resolve(true),
    pull: (d: string) => maybeKill("pull", () => void d),
    pullRef: (r: string) => maybeKill("pullRef", () => void r),
    fetchBundle: () => maybeKill("fetchBundle", () => ({ rawJson: BUNDLE_JSON, tarPath: "/t" })),
    fileSha256: () => Promise.resolve("e".repeat(64)),
    readEnvVar: (n: string) => world.env.get(n),
    currentPgMajor: () => Promise.resolve("17"),
    currentServiceImage: () => Promise.resolve(world.containers.updater),
    pinImage: (d: string) => world.env.set("BRAIN_IMAGE", `${REPO}/box@${d}`),
    pinEnv: (n: string, v: string) => world.env.set(n, v),
    snapshotDeploy: (version: string) => {
      world.snapshot = { version, env: new Map(world.env), deployTree: world.deployTree };
    },
    snapshotVersion: () => world.snapshot?.version ?? null,
    restoreDeploySnapshot: () => {
      if (world.snapshot === null) throw new Error("no snapshot");
      world.env = new Map(world.snapshot.env);
      world.deployTree = world.snapshot.deployTree;
    },
    clearDeploySnapshot: () => {
      world.snapshot = null;
    },
    applyDeployTree: () => maybeKill("applyDeployTree", () => void (world.deployTree = V2)),
    upPostgresWait: () =>
      maybeKill("upPostgresWait", () => {
        world.containers.postgres = world.env.get("BRAIN_POSTGRES_IMAGE")!;
      }),
    migrate: () => maybeKill("migrate", () => undefined),
    upInfraWait: () => maybeKill("upInfraWait", infraUp),
    restartApp: () =>
      maybeKill("restartApp", () => {
        world.containers.app = world.env.get("BRAIN_IMAGE")!;
      }),
    forceRestartApp: () => Promise.resolve(),
    recreateUpdaterSelf: (ref: string) =>
      maybeKill("recreateUpdaterSelf", () => {
        world.containers.updater = ref;
      }),
    canary: () =>
      maybeKill("canary", (): CanarySample[] => [{ writeOk: world.canaryHealthy, busy: false }]),
    probe: () => Promise.resolve(true),
    saveState: (s: PersistedState) => {
      world.state = s;
    },
    loadState: () => world.state,
  } as unknown as BoxHost;
  return host;
}

const noop = () => {};

/** Run one tick; if the kill fires, the tick never settles — abandon it. */
async function tickOrDie(world: BoxWorld, kill?: { at: string; phase: "before" | "after" }) {
  const host = makeHost(world, kill);
  const result = await Promise.race([
    runTick(booth, host, world.state, noop).then((r) => ({ died: false as const, r })),
    new Promise<{ died: true }>((resolve) => setTimeout(() => resolve({ died: true }), 25)),
  ]);
  if (!result.died) world.state = result.r.state;
  return result;
}

function assertFullyConverged(world: BoxWorld, label: string) {
  expect(world.state.currentVersion, label).toBe(V2);
  expect(world.env.get("BRAIN_IMAGE"), label).toBe(APP_V2_REF);
  expect(world.env.get("BRAIN_POSTGRES_IMAGE"), label).toBe(PG_V2_REF);
  expect(world.env.get("BRAIN_CADDY_IMAGE"), label).toBe(CADDY_V2_REF);
  expect(world.deployTree, label).toBe(V2);
  expect(world.containers.app, label).toBe(APP_V2_REF);
  expect(world.containers.postgres, label).toBe(PG_V2_REF);
  expect(world.containers.caddy, label).toBe(CADDY_V2_REF);
  expect(world.snapshot, label).toBeNull();
  expect(world.state.attempting, label).toBeUndefined();
  // the updater itself either converged (recreate ran) or has a verified pin
  // pending the detached recreate — both are supervised end-states
  if (world.containers.updater !== UPD_V2_REF) {
    expect(world.env.get("BRAIN_UPDATER_IMAGE"), label).toBe(UPD_V2_REF);
  }
}

function assertFullyRestored(world: BoxWorld, label: string) {
  expect(world.state.currentVersion, label).toBe(V1);
  expect(world.env.get("BRAIN_IMAGE"), label).toBe(APP_V1_REF);
  // infra pins either never landed or were restored to the V1 absence
  expect(world.env.get("BRAIN_POSTGRES_IMAGE"), label).toBeUndefined();
  expect(world.env.get("BRAIN_CADDY_IMAGE"), label).toBeUndefined();
  expect(world.deployTree, label).toBe(V1);
  expect(world.containers.postgres, label).toBe(PG_FALLBACK);
  expect(world.containers.caddy, label).toBe(caddyFallback(V1));
  expect(world.snapshot, label).toBeNull();
}

const KILL_SITES = [
  "fetchBundle",
  "pull",
  "pullRef",
  "applyDeployTree",
  "upPostgresWait",
  "migrate",
  "upInfraWait",
  "canary",
  "recreateUpdaterSelf",
] as const;

describe("chaos · process death at every async boundary (healthy release)", () => {
  for (const at of KILL_SITES) {
    for (const phase of ["before", "after"] as const) {
      it(`kill ${phase} ${at} → box converges whole within 4 ticks`, async () => {
        const world = freshWorld(true);
        await tickOrDie(world, { at, phase }); // the killed tick
        for (let i = 0; i < 4 && world.state.currentVersion !== V2; i++) {
          const r = await tickOrDie(world); // recovery ticks, no kill
          expect(r.died).toBe(false);
        }
        // one extra settled tick lets the self-pin reconcile run on up_to_date
        await tickOrDie(world);
        assertFullyConverged(world, `kill ${phase} ${at}`);
      });
    }
  }
});

describe("chaos · process death + a genuinely BROKEN release", () => {
  for (const at of ["applyDeployTree", "upPostgresWait", "migrate", "upInfraWait"] as const) {
    it(`kill after ${at}, then canary condemns → box fully restored to V1`, async () => {
      const world = freshWorld(false); // canary will vote write_broken
      await tickOrDie(world, { at, phase: "after" });
      // recovery ticks: heal + re-attempt + rollback; then latch/backoff holds
      for (let i = 0; i < 6; i++) await tickOrDie(world);
      assertFullyRestored(world, `broken release, kill after ${at}`);
    });
  }

  it("no kill, broken release → clean whole-shape rollback, attempts counted", async () => {
    const world = freshWorld(false);
    const r = await tickOrDie(world);
    expect(r.died).toBe(false);
    if (!r.died) expect(r.r.outcome.kind).toBe("rolled_back");
    assertFullyRestored(world, "clean rollback");
    expect(world.state.attempts[V2]).toBe(1);
  });
});
