/**
 * Disk write-shed guard. When the data filesystem
 * crosses BRAIN_WRITE_SHED_PCT (default 90), the box REFUSES content writes so a
 * full disk can never corrupt Postgres or wedge the box — reads always keep
 * working. The signal is a ~5s-TTL-cached statfs of the SAME path the heartbeat
 * measures (vitals.dataPath), so shedding and telemetry never disagree.
 *
 * FAIL-OPEN on a statfs error (return {shed:false}) — a measurement failure must
 * not brick writes — but log a ONE-TIME loud warning so a mount/path misconfig
 * is visible instead of a silent no-op (the "fail-open masks misconfig" trap).
 */
import { diskUsedPct, dataPath } from "./vitals.js";

interface DiskGuardState {
  /** true ⇒ refuse content writes (disk at/over the shed threshold). */
  readonly shed: boolean;
  /** the reading that drove the decision (null on statfs error → fail-open). */
  readonly pct: number | null;
}

const DEFAULT_SHED_PCT = 90;
const TTL_MS = 5_000;

function shedPct(env: NodeJS.ProcessEnv): number {
  const n = Number(env.BRAIN_WRITE_SHED_PCT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHED_PCT;
}

/**
 * Build a cached disk-guard. Returns an async `()=>DiskGuardState` that statfs's
 * the data path at most once per TTL. `now` is injectable for tests.
 */
export function makeDiskGuard(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): () => Promise<DiskGuardState> {
  const path = dataPath(env);
  const threshold = shedPct(env);
  let cached: DiskGuardState | null = null;
  let cachedAt = -Infinity;
  let warned = false;

  return async function guard(): Promise<DiskGuardState> {
    const t = now();
    if (cached !== null && t - cachedAt < TTL_MS) return cached;
    const pct = await diskUsedPct(path);
    if (pct === null && !warned) {
      warned = true;
      // ONE loud warning: a persistent null means the measurement is broken
      // (bad BRAIN_DATA_PATH / missing mount), which would silently disable the
      // shed — surface it rather than fail-open forever in the dark.
      console.warn(
        `[disk-guard] cannot statfs data path "${path}" — write-shed is FAILING OPEN (writes allowed). Check BRAIN_DATA_PATH / the pgdata mount.`,
      );
    }
    // null (unreadable) → fail OPEN (shed=false). A real reading shed's at/over
    // the threshold.
    const state: DiskGuardState = { shed: pct !== null && pct >= threshold, pct };
    cached = state;
    cachedAt = t;
    return state;
  };
}
