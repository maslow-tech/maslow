import { loadavg, cpus, totalmem, freemem } from "node:os";
import { statfs, readFile } from "node:fs/promises";

/**
 * Host vitals for the fleet heartbeat: CPU pressure, memory, and disk —
 * so the console can show whether a box is healthy and flag one heading for
 * trouble BEFORE it wedges. All percents are 0–100 integers; every reading is
 * best-effort and independently null-able (a box that can't read one still
 * reports the others). No brain content — pure host metrics.
 */
interface Vitals {
  /** 1-minute load average as a percent of core count (100 = fully loaded;
   *  can exceed 100 when the run-queue is backed up). Null if unreadable. */
  readonly cpuPct: number | null;
  /** used memory percent, from /proc/meminfo MemAvailable (os fallback). */
  readonly memPctUsed: number | null;
  /** root-filesystem used percent (matches `df` Capacity). */
  readonly diskPctUsed: number | null;
}

function clampPct(n: number, max = 100): number | null {
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), max);
}

function cpuPct(): number | null {
  const cores = cpus().length || 1;
  const load1 = loadavg()[0] ?? 0;
  // load can exceed cores (overloaded) — cap at 999 so a spike is visible
  // without overflowing the column.
  return clampPct((load1 / cores) * 100, 999);
}

async function memPctUsed(): Promise<number | null> {
  try {
    // MemAvailable is the kernel's own estimate of reclaimable+free — far more
    // honest than MemFree (which excludes cache). Prefer it; fall back to os.
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const total = /MemTotal:\s+(\d+)/.exec(meminfo)?.[1];
    const avail = /MemAvailable:\s+(\d+)/.exec(meminfo)?.[1];
    if (total && avail && Number(total) > 0) {
      return clampPct((1 - Number(avail) / Number(total)) * 100);
    }
  } catch {
    /* /proc unavailable — fall through to os */
  }
  const t = totalmem();
  return t > 0 ? clampPct((1 - freemem() / t) * 100) : null;
}

/** The filesystem the box measures for disk pressure. The app container mounts
 *  the postgres `pgdata` named volume read-only here (docker-compose), so this is
 *  provably the SAME filesystem Postgres writes to — the write-shed and the
 *  heartbeat both measure it, so telemetry and shedding can never disagree. */
const DEFAULT_DATA_PATH = "/var/lib/brain-pgdata";
export function dataPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRAIN_DATA_PATH ?? DEFAULT_DATA_PATH;
}

/** Used percent of the filesystem at `path` (matches `df` Capacity). Best-effort
 *  — null on statfs error (a box that can't read it still reports other vitals,
 *  and the write-shed fails OPEN on null). Exported so disk-guard shares it. */
export async function diskUsedPct(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    const used = Number(s.blocks) - Number(s.bfree);
    const availTotal = used + Number(s.bavail);
    // Matches `df` Capacity: used / (used + available-to-unprivileged).
    return availTotal > 0 ? clampPct((used / availTotal) * 100) : null;
  } catch {
    return null;
  }
}

/** Read all vitals concurrently; each field is independently best-effort. */
export async function readVitals(): Promise<Vitals> {
  const [mem, disk] = await Promise.all([memPctUsed(), diskUsedPct(dataPath())]);
  return { cpuPct: cpuPct(), memPctUsed: mem, diskPctUsed: disk };
}
