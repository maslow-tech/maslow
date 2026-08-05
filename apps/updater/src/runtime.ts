import type { ReleaseFeed } from "./booth-client.js";
import { BundleFetchError, type BoxHost } from "./host.js";
import type { VerifiedControl } from "./verify.js";
import {
  imageRef,
  parseBundleJson,
  planInfra,
  PIN_VARS,
  type BundleManifest,
  type InfraPlan,
} from "./bundle.js";
import { Updater, type UpdateOutcome, type UpdaterAdapters } from "./updater.js";
import {
  canonicalOrder,
  desiredOrdinal,
  ensureCurrent,
  fromLibState,
  isBelow,
  ordinalOf,
  releaseAt,
  toLibState,
  type PersistedState,
  type ReleaseEntry,
} from "./versions.js";

/**
 * One poll of the real loop: fetch the booth's release list + control,
 * order it by INTRINSIC semver, run the pure `Updater.tick`, and persist the
 * result. The pure library owns every decision rule; this file wires its
 * adapter slots to the booth transport and the box host, and adds one
 * booth-independent backstop (the semver floor gate) around the pull.
 */

export interface TickResult {
  readonly state: PersistedState;
  readonly outcome: UpdateOutcome | { kind: "skipped"; reason: string };
  /** the failed version's own attempt count, for per-version backoff (0 if n/a). */
  readonly failures: number;
}

/**
 * Operator restart op: honor a VERIFIED restart op against the persisted mark. Runs on EVERY
 * heartbeat path — including the degraded early returns, where a wedged box
 * most needs its one remote lever. Rules, in order:
 *   - one fleet-wide signing key → pin the first verified box_id (TOFU) and
 *     ignore controls signed for any other box (a replayed cross-box control
 *     must not restart — or mark-poison — this one);
 *   - ABSENT mark, or a booth counter BELOW the mark (booth DB restored from
 *     backup, box row re-registered): adopt the current generation WITHOUT
 *     restarting — a stale op must never surprise-bounce a healthy app, and a
 *     regressed counter must not deafen the box until it climbs back;
 *   - generation above the mark: force-restart (unless this very tick already
 *     bounced the app) and persist the mark.
 * Saves iff the state changed. Returns the state to carry forward.
 */
async function honorRestartOp(
  host: BoxHost,
  state: PersistedState,
  control: VerifiedControl | null,
  restartedThisTick: boolean,
  log: (line: Record<string, unknown>) => void,
): Promise<PersistedState> {
  if (control === null) return state; // nothing VERIFIED — never adopt, never act
  if (state.boxId !== undefined && control.boxId !== state.boxId) {
    log({ warn: "verified control names a different box — restart op ignored" });
    return state;
  }
  let next = state.boxId === undefined ? { ...state, boxId: control.boxId } : state;
  const gen = control.restartGeneration;
  const honored = next.honoredRestartGeneration;
  if (honored === undefined || gen < honored) {
    next = { ...next, honoredRestartGeneration: gen }; // adopt, no restart
  } else if (gen > honored) {
    if (!restartedThisTick) {
      // forceRestartApp, not restartApp: `up -d` is a no-op on an unchanged
      // image — exactly the wedged-app case this op exists for.
      log({ msg: "operator restart op — restarting app", generation: gen });
      await host.forceRestartApp();
    }
    next = { ...next, honoredRestartGeneration: gen };
  }
  if (next !== state) host.saveState(next);
  return next;
}

/**
 * Honor the operator reclaim-disk op — same shape as the restart op: adopt a
 * lower/first generation WITHOUT pruning (shipping the op never surprise-prunes
 * a box), prune once when it rises past the mark. The prune keeps the running +
 * rollback images and never touches volumes; it is best-effort (host.pruneImages
 * swallows its own failure), so it can neither fail nor stall the tick.
 */
async function honorPruneOp(
  host: BoxHost,
  state: PersistedState,
  control: VerifiedControl | null,
  keepDigests: () => string[],
  log: (line: Record<string, unknown>) => void,
): Promise<PersistedState> {
  if (control === null) return state;
  if (state.boxId !== undefined && control.boxId !== state.boxId) return state;
  let next = state.boxId === undefined ? { ...state, boxId: control.boxId } : state;
  const gen = control.pruneGeneration;
  const honored = next.honoredPruneGeneration;
  if (honored === undefined || gen < honored) {
    next = { ...next, honoredPruneGeneration: gen }; // adopt, no prune
  } else if (gen > honored) {
    log({ msg: "operator reclaim-disk op — pruning images", generation: gen });
    await host.pruneImages(keepDigests());
    next = { ...next, honoredPruneGeneration: gen };
  }
  if (next !== state) host.saveState(next);
  return next;
}

export async function runTick(
  booth: ReleaseFeed,
  host: BoxHost,
  persisted: PersistedState,
  log: (line: Record<string, unknown>) => void,
): Promise<TickResult> {
  // Fetch the release list, but a malformed/failed list must NOT swallow the
  // heartbeat — otherwise a booth data glitch makes healthy boxes look offline
  // in the console. Report first, then hold on the bad list. Each early return
  // still honors a pending operator restart op — the degraded-release-pipeline
  // window is precisely when an operator reaches for the restart button.
  let releases;
  try {
    releases = await booth.listReleases();
  } catch (err) {
    const hb = await booth.heartbeat({ currentVersion: persisted.currentVersion, healthy: true });
    return {
      state: await honorRestartOp(host, persisted, hb.control, false, log),
      outcome: { kind: "skipped", reason: `release list: ${String(err)}` },
      failures: 0,
    };
  }
  let canonical = canonicalOrder(releases, persisted.currentVersion);
  if (canonical === null) {
    const hb = await booth.heartbeat({ currentVersion: persisted.currentVersion, healthy: true });
    return {
      state: await honorRestartOp(host, persisted, hb.control, false, log),
      outcome: { kind: "skipped", reason: "unparseable version in release list" },
      failures: 0,
    };
  }
  // Replay-safe swap journal. `attempting` is persisted just before the
  // point-of-no-return (the image pin, in the migrate adapter below). Finding
  // it here means a previous tick died mid-swap or mid-rollback:
  //  - count the failed attempt FIRST — without this, a version that crashes
  //    the updater dodges the poisoned-version latch/backoff forever;
  //  - heal the pin back to the persisted current version and `compose up` it
  //    (a no-op when the pin already matches) — the stranded un-canaried pin
  //    is otherwise brought live by the next unrelated compose up, and an app
  //    left running the bad image is rolled back by the same recreate.
  // The journal is cleared ONLY once the heal actually ran: if the release
  // list can't resolve the current version, or docker itself is wedged, the
  // journal is RETAINED (no bump, no clear) and the resume replays next tick —
  // clearing it early would strand the un-canaried pin forever, the exact
  // bypass the journal exists to close. Heal-then-save ordering means a crash during
  // the heal also replays it (the extra count is safe-side: latches sooner).
  let healRestarted = false;
  if (persisted.attempting !== undefined) {
    const v = persisted.attempting;
    const cur = canonical.find((r) => r.version === persisted.currentVersion);
    if (cur === undefined) {
      log({ warn: "journal retained — current version missing from release list", version: v });
    } else {
      log({ warn: "mid-swap death detected — recording failed attempt + healing pin", version: v });
      try {
        // A bundle-era swap snapshots the WHOLE deploy shape (.env pins +
        // compose + configs), STAMPED with the attempt's version. Restore it
        // ONLY when the stamp matches this journaled attempt — a stale
        // snapshot (orphaned by a crash after an unrelated success) restoring
        // an old shape under a later release is exactly what the stamp
        // prevents; stale snapshots are deleted, never trusted. The infra up
        // is NOT best-effort: clearing markers after a failed restore would
        // record a heal that never ran (invariant 5).
        const snapVersion = host.snapshotVersion();
        if (snapVersion !== null && snapVersion !== v) {
          log({ warn: "stale deploy snapshot discarded", snapshot: snapVersion, attempt: v });
          host.clearDeploySnapshot();
        }
        if (snapVersion === v) {
          host.restoreDeploySnapshot();
          host.pinImage(cur.imageDigest);
          await host.restartApp();
          await host.upInfraWait(); // old infra back — must succeed to clear
          host.clearDeploySnapshot();
        } else {
          host.pinImage(cur.imageDigest);
          await host.restartApp();
        }
        healRestarted = true;
      } catch (err) {
        // Docker wedged: keep the journal for the next tick and DON'T throw —
        // the heartbeat below must still run (the booth would otherwise page
        // this box as offline, and a pending operator restart op would be dropped).
        log({ warn: `journal retained — heal failed: ${String(err)}`, version: v });
      }
      if (healRestarted) {
        const { attempting: _drop, ...rest } = persisted;
        persisted = {
          ...rest,
          attempts: { ...persisted.attempts, [v]: (persisted.attempts[v] ?? 0) + 1 },
        };
        host.saveState(persisted);
      }
    }
  }

  // Vanished-current heal: currentVersion is missing from the release list (its
  // booth row was deleted) but the box is running it. GATED on attempting===
  // undefined — a mid-swap death must fall through to the journal-hold above and
  // NEVER pin the un-canaried new image. With no swap in flight, the last
  // completed swap pinned the current version's real digest, so ensureCurrent
  // synthesizes with a truthful digest. A missing/tag/malformed pin holds.
  if (
    persisted.attempting === undefined &&
    ordinalOf(canonical, persisted.currentVersion) === null
  ) {
    let pin: string | undefined;
    try {
      pin = host.readEnvVar(PIN_VARS.app);
    } catch (err) {
      log({ error: `could not read app pin to heal vanished current: ${String(err)}` });
    }
    const at = pin === undefined ? -1 : pin.indexOf("@");
    const digest = at === -1 ? undefined : pin!.slice(at + 1);
    if (digest !== undefined && /^sha256:[0-9a-f]{64}$/.test(digest)) {
      canonical = ensureCurrent(canonical, persisted.currentVersion, digest);
      log({
        warn: "currentVersion absent from release list — synthesized from running app pin",
        version: persisted.currentVersion,
      });
    } else {
      log({
        error: `currentVersion ${persisted.currentVersion} absent and app pin is not a digest (${pin ?? "unset"}) — holding`,
      });
    }
  }

  const lib = toLibState(persisted, canonical);
  if (!lib.ok) {
    // Never guess a baseline: report ourselves via heartbeat and hold.
    const hb = await booth.heartbeat({ currentVersion: persisted.currentVersion, healthy: true });
    return {
      state: await honorRestartOp(host, persisted, hb.control, false, log),
      outcome: { kind: "skipped", reason: lib.error },
      failures: 0,
    };
  }

  const resolve = (ordinal: number): ReleaseEntry => {
    const rel = releaseAt(canonical, ordinal);
    if (rel === null) throw new Error(`no release at ordinal ${ordinal}`);
    return rel;
  };

  // Image digests the prune must KEEP: the running version + retained rollback
  // targets. Docker's in-use guard protects the running image regardless;
  // a version that no longer resolves to a release is simply skipped (nothing
  // to keep for it). Shared by the post-swap prune and the operator prune op.
  const keepDigests = (): string[] => {
    const keep: string[] = [];
    for (const v of [lib.state.current, ...lib.state.kept.map((k) => k.version)]) {
      try {
        keep.push(resolve(v).imageDigest);
      } catch {
        /* version dropped from the release list */
      }
    }
    return keep;
  };

  // Operator restart op: captured off the tick's one heartbeat, honored
  // after the tick (below) so the updater — the component with the docker
  // socket — performs it, not the box.
  let seenControl: VerifiedControl | null = null;
  // In-memory mirror of the on-disk swap journal (set by the migrate
  // adapter), so a THROWN tick can hand the journaled state to the caller.
  let journaledVersion: string | undefined;
  // The verified bundle for the version being applied this tick (null =
  // pre-bundle release → legacy app-only path). Set by the verify adapter.
  type PendingBundle = {
    readonly bundle: BundleManifest;
    readonly tarPath: string;
    readonly plan: InfraPlan;
  } | null;
  let pendingBundle: PendingBundle = null;

  const adapters: UpdaterAdapters = {
    heartbeat: async () => {
      // Report the REAL write-path health (a single /canary probe), not a
      // hardcoded `true` — this is the signal the booth's health monitor alerts on. The
      // probe never throws and treats an inconclusive timeout as healthy, so a
      // transient blip doesn't page; only a genuine 503/refused reports false.
      const writeOk = await host.probe();
      // Ride disk usage up so the booth can flag a filling box before a full
      // disk wedges its updates. Best-effort — a telemetry read must never
      // throw the heartbeat (try/catch also tolerates an older host with no
      // diskPctUsed); null (unreadable) is omitted from the report.
      let diskPctUsed: number | null = null;
      try {
        diskPctUsed = await host.diskPctUsed();
      } catch {
        /* disk telemetry is best-effort */
      }
      // Surface a transient verify-stall so a deferring box reads as
      // "stalled: vX" in the console — NOT unhealthy, and NOT silently behind. A
      // box only ever defers its single next step, so the non-zero deferral
      // entry (from the PRIOR tick) names the version it's stuck verifying. One-
      // poll lag is negligible vs a multi-hour outage.
      const stalledEntry = Object.entries(lib.state.deferrals).find(([, n]) => n > 0);
      const stalledVersion = stalledEntry
        ? releaseAt(canonical, Number(stalledEntry[0]))?.version
        : undefined;
      // Ride the deferral COUNT up too, not just the boolean. A transient defer
      // retries forever by design, so "stalled" alone cannot distinguish a
      // 5-minute Sigstore blip from a box that has been unable to reach the
      // registry for a week — and without that distinction, making registry
      // failures transient would only trade a loud latch for a silent stall.
      // Deferrals do not back off (only `attempts` do), so this count is a
      // clock: one per poll.
      const stalledPolls = stalledEntry ? stalledEntry[1] : undefined;
      const hb = await booth.heartbeat({
        currentVersion: persisted.currentVersion,
        healthy: writeOk,
        ...(diskPctUsed !== null ? { diskPctUsed } : {}),
        updateStalled: stalledEntry !== undefined,
        ...(stalledVersion !== undefined ? { updateStalledVersion: stalledVersion } : {}),
        ...(stalledPolls !== undefined ? { updateStalledPolls: stalledPolls } : {}),
      });
      seenControl = hb.control;
      const desired = desiredOrdinal(canonical, hb.desiredVersion, lib.state.current);
      if (desired.held && hb.desiredVersion !== null) {
        log({ warn: "desired version not steppable; holding", desired: hb.desiredVersion });
      }
      return {
        desiredVersion: desired.ordinal,
        kill: hb.kill,
        schemaFloor: lib.state.floor,
      };
    },
    // Two gates before an image is trusted, both booth-independent:
    //  1. the target's own version tag must not be BELOW our persisted floor
    //     (a reordered/omitted booth list can't roll us back — anti-rollback);
    //  2. cosign keyless-verify the digest (a compromised booth can't forge one).
    // A yanked release never verifies (yank = fleet-wide "do not apply").
    verify: async (v) => {
      // DEFINITIVE = poison toward the latch; TRANSIENT = defer + retry forever.
      // A cosign/registry/Sigstore failure is ALWAYS transient (a bad image
      // simply never applies — the box stays on its known-good version), so we
      // never latch the fleet on an outage. Only cosign-independent, definitive
      // causes (yanked, below-floor, bundle-invalid, hash/digest mismatch,
      // cross-major pg) poison.
      const rel = resolve(v);
      if (rel.yanked) return { ok: false, transient: false };
      if (isBelow(rel.version, persisted.floorVersion)) {
        log({
          refused: "target below monotonic floor",
          target: rel.version,
          floor: persisted.floorVersion,
        });
        return { ok: false, transient: false };
      }
      if (!(await host.verify(rel.imageDigest))) return { ok: false, transient: true };

      // Acquire + validate the release bundle. A missing bundle is a
      // legal pre-bundle release (legacy app-only path); a PRESENT bundle
      // that fails ANY check (signature inside fetchBundle, version/app-digest
      // cross-checks, tarball hash, component signatures, cross-major guard)
      // fails the whole verify — a signed-but-wrong bundle is hostile, and
      // the poisoned-version latch caps the retries.
      pendingBundle = null;
      let fetched;
      try {
        fetched = await host.fetchBundle(rel.version);
      } catch (err) {
        // A tagged BundleFetchError carries its own transient/definitive flag;
        // an UNKNOWN throw defaults to DEFINITIVE (latch loudly rather than loop
        // forever on a programming bug / hostile payload).
        const transient = err instanceof BundleFetchError ? err.transient : false;
        log({ refused: `bundle fetch/verify failed: ${String(err)}`, version: rel.version });
        return { ok: false, transient };
      }
      if (fetched === null) return { ok: true }; // legacy release — app-only update
      const parsed = parseBundleJson(fetched.rawJson, {
        version: rel.version,
        appDigest: rel.imageDigest,
      });
      if (!parsed.ok) {
        log({ refused: `bundle invalid: ${parsed.error}`, version: rel.version });
        return { ok: false, transient: false };
      }
      const bundle = parsed.bundle;
      if ((await host.fileSha256(fetched.tarPath)) !== bundle.deploySha256) {
        log({ refused: "bundle deploy tarball hash mismatch", version: rel.version });
        return { ok: false, transient: false };
      }
      // First-party components are individually cosign-verified before any
      // pin references them (caddy is third-party — the signed bundle pinning
      // its digest IS its trust).
      for (const c of ["updater", "postgres"] as const) {
        if (!(await host.verifyRef(imageRef(bundle.images[c])))) {
          log({ refused: `${c} image signature verify failed`, version: rel.version });
          return { ok: false, transient: true }; // cosign → never authoritative for latch
        }
      }
      const plan = planInfra(
        bundle,
        {
          app: host.readEnvVar(PIN_VARS.app),
          updater: host.readEnvVar(PIN_VARS.updater),
          postgres: host.readEnvVar(PIN_VARS.postgres),
          caddy: host.readEnvVar(PIN_VARS.caddy),
        },
        await host.currentPgMajor(),
      );
      if (!plan.ok) {
        // Cross-major postgres: a PERMANENT condition, not a flake — the
        // latch (after maxFailures) is what stops the retry storm; clearing
        // it is the runbook's job after pg_upgrade.
        log({ refused: plan.refuse, version: rel.version });
        return { ok: false, transient: false };
      }
      pendingBundle = { bundle, tarPath: fetched.tarPath, plan: plan.plan };
      return { ok: true };
    },
    pullByDigest: async (v) => {
      await host.pull(resolve(v).imageDigest);
      if (pendingBundle !== null) {
        const { bundle, plan } = pendingBundle;
        for (const c of plan.changed) {
          if (c !== "app") await host.pullRef(imageRef(bundle.images[c]));
        }
        if (plan.updaterChanged) await host.pullRef(imageRef(bundle.images.updater));
      }
    },
    migrate: async (v) => {
      // Pin so the migrate one-off and the app swap run the SAME image. If the
      // migration THROWS, restore the previous pin before propagating — else a
      // failed migration would leave deploy/.env pointing at an un-canaried
      // image that the next `compose up` (operator/redeploy) would bring live,
      // bypassing the whole canary/rollback safety net.
      const prev = resolve(lib.state.current).imageDigest;
      // Journal the swap BEFORE the pin — from here to the end-of-tick save,
      // a death (crash OR a thrown migrate/restart) is detected and accounted
      // for on the next tick. The end-of-tick save clears it (fromLibState
      // rebuilds the state without `attempting`). `journaledVersion` mirrors
      // the on-disk journal so the catch below can reconstruct it in memory.
      journaledVersion = resolve(v).version;
      host.saveState({ ...persisted, attempting: journaledVersion });
      try {
        if (pendingBundle !== null) {
          // Whole-box bundle apply. Snapshot BEFORE any mutation, stamped with
          // the target version — and REUSED on a retry of the same version
          // (a busy-canary retry runs with the new shape already live;
          // re-snapshotting would capture the mutated shape as the rollback
          // baseline and reduce the whole-shape rollback to app-only). Then:
          // configs → pins → postgres first (the migrations that follow may
          // need the NEW postgres, e.g. pgvector).
          const target = resolve(v).version;
          if (host.snapshotVersion() !== target) host.snapshotDeploy(target);
          await host.applyDeployTree(pendingBundle.tarPath, pendingBundle.bundle.deploySha256);
          host.pinImage(resolve(v).imageDigest);
          host.pinEnv(PIN_VARS.postgres, imageRef(pendingBundle.bundle.images.postgres));
          host.pinEnv(PIN_VARS.caddy, imageRef(pendingBundle.bundle.images.caddy));
          if (pendingBundle.plan.postgresChanged) {
            await host.upPostgresWait();
          }
        } else {
          host.pinImage(resolve(v).imageDigest);
        }
        await host.migrate();
      } catch (err) {
        // Bring the WHOLE previous shape back, not just the app pin: a throw
        // after the postgres swap must not strand new postgres + old app.
        // NOT best-effort: if the restore-up fails, RETAIN snapshot + journal
        // so the next tick's heal replays it (clearing after a failed restore
        // would record a rollback that never happened).
        if (pendingBundle !== null && host.snapshotVersion() === resolve(v).version) {
          host.restoreDeploySnapshot();
          await host.upInfraWait();
          host.clearDeploySnapshot();
        }
        host.pinImage(prev);
        throw err;
      }
      return { schemaVersion: v };
    },
    restart: async () => {
      // Same guard as migrate: a throw here (compose failure) must not strand
      // a new pin that a later `compose up` would silently apply un-canaried.
      try {
        if (pendingBundle !== null) {
          // Whole-topology up — EXCEPT the updater itself: recreating the
          // service this process lives in would SIGTERM the tick mid-flight
          // (and an API-stopped container is not resurrected by
          // restart:unless-stopped). The updater converges last, detached.
          await host.upInfraWait();
        } else {
          await host.restartApp();
        }
      } catch (err) {
        if (pendingBundle !== null && host.snapshotVersion() !== null) {
          host.restoreDeploySnapshot();
          await host.upInfraWait();
          host.clearDeploySnapshot();
        }
        host.pinImage(resolve(lib.state.current).imageDigest);
        throw err;
      }
    },
    writeCanary: () => host.canary(),
    rollbackApp: async (v) => {
      // A failed canary rolls back the WHOLE shape (configs, postgres,
      // caddy) via the snapshot, then re-asserts the app pin on the rollback
      // TARGET — which the schema-floor logic may pick older than the
      // snapshot's own app pin. A throw here retains snapshot + journal for
      // the next tick's heal.
      if (pendingBundle !== null && host.snapshotVersion() !== null) {
        host.restoreDeploySnapshot();
        host.pinImage(resolve(v).imageDigest);
        await host.upInfraWait();
        host.clearDeploySnapshot();
      } else {
        host.pinImage(resolve(v).imageDigest);
        await host.restartApp();
      }
    },
    report: (outcome) => {
      log({ outcome });
      return Promise.resolve();
    },
    pruneImages: () => host.pruneImages(keepDigests()),
  };

  const updater = new Updater(adapters);
  let ticked;
  try {
    ticked = await updater.tick(lib.state);
  } catch (err) {
    // A THROWN migrate/restart leaves `attempting` journaled on DISK, but
    // the caller (main.ts) keeps looping with its in-memory state — which
    // predates the journal. Reconstruct the journaled state IN MEMORY (it is
    // exactly what the migrate adapter saved; no disk round-trip whose own
    // failure would silently drop the journal) and return it instead of
    // throwing, so the very next tick's resume block counts the failure and
    // heals the pin without needing the updater process to die first. The
    // pending attempt count is surfaced as `failures` so main's per-version
    // backoff (H5) engages for the throw failure mode exactly like a rollback,
    // and a pending operator restart op captured by the heartbeat is still honored
    // — a swap that throws every tick is precisely the wedged window the op
    // exists for.
    log({ error: `tick failed: ${String(err)}` });
    let state =
      journaledVersion === undefined ? persisted : { ...persisted, attempting: journaledVersion };
    state = await honorRestartOp(host, state, seenControl, false, log);
    return {
      state,
      outcome: { kind: "skipped", reason: `tick failed: ${String(err)}` },
      failures:
        journaledVersion === undefined ? 0 : (persisted.attempts[journaledVersion] ?? 0) + 1,
    };
  }
  const { state: nextLib, outcome } = ticked;
  let next: PersistedState = fromLibState(nextLib, canonical, persisted);
  // A journal the resume block RETAINED (heal couldn't run — docker wedged)
  // must survive the end-of-tick save: this tick held without re-attempting the
  // journaled swap, so clearing here would strand the un-canaried pin after
  // all. A journal written THIS tick (journaledVersion) keeps the normal
  // completion-clears-it semantics.
  if (persisted.attempting !== undefined && journaledVersion === undefined) {
    next = { ...next, attempting: persisted.attempting };
  }
  // Persist the tick's result BEFORE honoring a restart op: a compose failure
  // below must not lose an applied-version bump (replay would re-step it). A
  // crash between the op's restart and its save re-restarts next tick:
  // harmless, and better than marking an op honored that never ran.
  host.saveState(next);

  // Restart op: an applied/rolled_back/busy_retry tick already bounced the app (the
  // swap restart runs BEFORE the canary, so busy counts too), and so did the
  // journal's resume heal — the op is satisfied without a second bounce.
  const restartedThisTick =
    healRestarted ||
    outcome.kind === "applied" ||
    outcome.kind === "rolled_back" ||
    outcome.kind === "busy_retry";
  next = await honorRestartOp(host, next, seenControl, restartedThisTick, log);
  // Honor the operator reclaim-disk op on the healthy end-of-tick (keepDigests
  // needs a resolvable release list; the degraded-pipeline early returns above
  // skip it — a reclaim can wait for a good tick).
  next = await honorPruneOp(host, next, seenControl, keepDigests, log);
  // The attempt count for the SPECIFIC version that just failed (verify or a
  // rollback), read straight off the resulting state — not a max across all.
  const failedOrdinal =
    outcome.kind === "verify_failed"
      ? outcome.version
      : outcome.kind === "rolled_back"
        ? outcome.from
        : null;
  const failures = failedOrdinal === null ? 0 : (nextLib.attempts[failedOrdinal] ?? 0);

  // A successful bundle apply retires its snapshot, and the updater's
  // OWN pin converges as the tick's very LAST act — everything above is
  // already persisted + reported. The recreate is DETACHED (a helper
  // container running the new, verified updater image): an in-process
  // compose up would stop this container and die before the replacement
  // exists. (Read through a closure: pendingBundle is assigned inside
  // adapter closures, which TS flow analysis can't see from here.)
  const appliedBundle = ((): PendingBundle => pendingBundle)();
  if (outcome.kind === "applied" && appliedBundle !== null) {
    host.clearDeploySnapshot();
    if (appliedBundle.plan.updaterChanged) {
      const ref = imageRef(appliedBundle.bundle.images.updater);
      host.pinEnv(PIN_VARS.updater, ref);
      log({ msg: "self-update: detached recreate on the bundle's updater pin" });
      await host
        .recreateUpdaterSelf(ref)
        .catch((err) => log({ warn: `self-update recreate: ${String(err)}` }));
    }
  } else if (outcome.kind === "up_to_date") {
    // Self-pin reconcile: a crash (or failed detached recreate) can leave the
    // .env pinning a NEW updater while the OLD container keeps running — and
    // nothing else ever converges it (verify only runs when stepping). The
    // pin was cosign-verified before it was written; re-verify anyway before
    // acting on it, then finish the recreate. Without this, the stale pin
    // also booby-traps any later compose up into an unsupervised recreate.
    const pinned = host.readEnvVar(PIN_VARS.updater);
    if (pinned !== undefined && pinned !== "") {
      const running = await host.currentServiceImage("updater").catch(() => null);
      if (running !== null && running !== pinned) {
        if (await host.verifyRef(pinned)) {
          log({ msg: "reconciling stale updater self-pin", pinned, running });
          await host
            .recreateUpdaterSelf(pinned)
            .catch((err) => log({ warn: `self-pin reconcile: ${String(err)}` }));
        } else {
          log({ warn: "updater self-pin fails verification — leaving container as-is", pinned });
        }
      }
    }
  }
  return { state: next, outcome, failures };
}
