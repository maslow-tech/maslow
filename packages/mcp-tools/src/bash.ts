import { Bash, MountableFs } from "just-bash";
import type { FsCtx, FsStore } from "./fs-store.js";
import { fsVersionCommands } from "./fs-vc-commands.js";
import { PgFs, guardedBase, homeStubFs } from "./pg-fs.js";
import { pythonToolkitCommand, toolkitFs } from "./sandbox-packages.js";

/**
 * The persistent bash runner.
 * Runs a script in vercel-labs just-bash — an in-process TypeScript
 * reimplementation of bash + coreutils (grep/sed/awk/jq/yq/sqlite) — with the
 * brain filesystem mounted write-through:
 *
 *   /shared        persistent, visible to every member      (PgFs)
 *   /home/<slug>   persistent, private to the caller        (PgFs via homeStubFs)
 *   /tmp           scratch, gone when the script ends       (guarded InMemoryFs)
 *
 * cwd starts in the caller's home; HOME/USER match. Other members' homes are
 * absent from the namespace (privacy by absence); writes anywhere else teach
 * the writable roots. Every completed write IS persisted (live write-through
 * plus append coalescing — see pg-fs.ts), so a timed-out or crashed script
 * keeps the files it finished writing, exactly like a real filesystem.
 *
 * Security posture unchanged from the 2026-07-15 runner: network OFF (curl
 * doesn't exist without an allowlist), python/JS/sqlite ON (WASM sandboxes),
 * bounded by just-bash's execution limits + an AbortSignal timeout. The
 * sandbox reaches Postgres ONLY through FsStore, which sets the actor GUCs
 * on a dedicated pool — RLS stays the boundary no matter what the script does.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
// Cap each stream in the response so a `cat`-of-a-100MB-file can't blow up the
// MCP payload. The script still ran; only what we echo back is bounded.
const MAX_OUTPUT_BYTES = 100_000;
// The persisted/deleted trailer names at most this many paths.
const MAX_TRAILER_PATHS = 20;

export interface BashRunCtx {
  actorId: string;
  /**
   * The caller's home slug, or null for an account with no /home (a historical
   * service account provisioned before 0037). A null slug gets /shared only — cwd /shared,
   * no /home mount — so the flagship agent can still read the org tree.
   */
  slug: string | null;
  /** read-scope token: mounts stay readable, every write teaches EROFS. */
  readOnly: boolean;
}

export interface BashResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly stdout_truncated?: boolean;
  readonly stderr_truncated?: boolean;
  readonly timed_out?: boolean;
  /** absolute paths durably written this exec (first 20 — see persisted_note). */
  readonly persisted?: string[];
  /** absolute paths durably deleted this exec (first 20 — see persisted_note). */
  readonly deleted?: string[];
  /** human trailer: `persisted: wrote a, b; deleted c` (+ `…and N more`). */
  readonly persisted_note?: string;
}

export async function runBash(
  script: string,
  ctx: BashRunCtx,
  store: FsStore,
  opts: { timeoutMs?: number } = {},
): Promise<BashResult> {
  const timeout = Math.min(
    Math.max(Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1),
    MAX_TIMEOUT_MS,
  );
  // A home-less caller (a pre-0037 historical service account) runs shared-only: cwd /shared,
  // no /home mount, USER falls back to the fixed "shared".
  const hasHome = ctx.slug !== null;
  const home = hasHome ? `/home/${ctx.slug}` : "/shared";
  const fsCtx: FsCtx = {
    actorId: ctx.actorId,
    ...(ctx.readOnly ? { readOnly: true } : {}),
  };

  const sharedFs = new PgFs(store, { ctx: fsCtx, root: "/shared" });
  const homeFs = hasHome ? new PgFs(store, { ctx: fsCtx, root: `/home/${ctx.slug}` }) : null;
  const fs = new MountableFs({ base: guardedBase() });
  fs.mount("/shared", sharedFs);
  if (homeFs) fs.mount("/home", homeStubFs(ctx.slug as string, homeFs));
  // The offline package toolkit (openpyxl/pypdf/bs4/…): one read-only fs
  // shared by every exec, importable because the python3 shadow puts
  // /host/opt/python on sys.path (see sandbox-packages.ts).
  fs.mount("/opt/python", await toolkitFs());
  await fs.mkdir("/tmp", { recursive: true });

  const bash = new Bash({
    fs,
    cwd: home,
    env: { HOME: home, USER: ctx.slug ?? "shared" },
    python: true,
    javascript: true,
    // history/diff/restore reach fs_versions through the SAME store (RLS-scoped
    // identically); `sync` keeps the write-through mounts honest because those
    // commands mutate behind the mount's back.
    customCommands: [
      pythonToolkitCommand(),
      ...fsVersionCommands(store, fsCtx, {
        sync: async (mutated) => {
          await sharedFs.syncExternal(mutated);
          if (homeFs) await homeFs.syncExternal(mutated);
        },
      }),
    ],
    // just-bash caps python/js/sqlite sub-interpreters at 10s by default
    // (offline mode), independent of the AbortSignal wall clock — so a heavy
    // openpyxl/pypdf parse under a requested 30s would die at 10s. Raise them
    // to the resolved per-call timeout; the AbortSignal is still the ceiling.
    executionLimits: {
      maxPythonTimeoutMs: timeout,
      maxJsTimeoutMs: timeout,
      maxSqliteTimeoutMs: timeout,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let raw: { stdout: string; stderr: string; exitCode: number } | undefined;
  let execError: unknown;
  try {
    raw = await bash.exec(script, { signal: controller.signal });
  } catch (e) {
    execError = e;
  } finally {
    clearTimeout(timer);
  }

  // Buffered appends land BEFORE we report anything — a returned result never
  // claims bytes that aren't in Postgres. Runs after abort too: that is the
  // "files written before the timeout were saved" guarantee.
  // Flush both mounts INDEPENDENTLY: a throwing /shared flush must never skip
  // the /home flush (or vice versa) — that would silently drop bytes a
  // completed write already returned to the script, breaking durability.
  // Both mounts report: stderr names EVERY path whose bytes did not land (each
  // mount's flushAll already aggregates its own), so the caller can never
  // conclude that only the first-named file was affected.
  const flushErrors: string[] = [];
  const flushes = await Promise.allSettled([
    sharedFs.flushAll(),
    ...(homeFs ? [homeFs.flushAll()] : []),
  ]);
  for (const f of flushes) {
    if (f.status === "rejected") {
      flushErrors.push(f.reason instanceof Error ? f.reason.message : String(f.reason));
    }
  }

  const timedOut = controller.signal.aborted;
  const stdout = raw?.stdout ?? "";
  let stderr = raw?.stderr ?? "";
  let exitCode = raw?.exitCode ?? 0;
  if (execError && !timedOut) {
    stderr = appendLine(stderr, `bash: ${(execError as Error).message}`);
    exitCode = exitCode === 0 ? 1 : exitCode;
  }
  if (timedOut) {
    stderr = appendLine(
      stderr,
      `bash: timed out after ${timeout}ms — files written before the timeout were saved`,
    );
    exitCode = 124;
  }
  if (flushErrors.length > 0) {
    stderr = appendLine(stderr, `bash: fs flush failed: ${flushErrors.join("; ")}`);
    exitCode = exitCode === 0 ? 1 : exitCode;
  }

  const shared = sharedFs.mutatedPaths();
  const own = homeFs?.mutatedPaths() ?? { wrote: [], deleted: [], unrecoverable: [] };
  const wrote = [...new Set([...shared.wrote, ...own.wrote])];
  const deleted = [...new Set([...shared.deleted, ...own.deleted])];
  // A delete whose trash snapshot did not fit the version budget is a HARD
  // delete. The script exits 0 either way, so the only thing standing between
  // the caller and a silent permanent loss is this line.
  const lost = [...new Set([...shared.unrecoverable, ...own.unrecoverable])];
  if (lost.length > 0) {
    const shown = lost.slice(0, MAX_TRAILER_PATHS);
    const more = lost.length - shown.length;
    stderr = appendLine(
      stderr,
      `bash: rm: version budget exceeded — NOT recoverable from the trash: ${shown.join(", ")}` +
        (more > 0 ? ` …and ${more} more` : ""),
    );
  }

  const out = capOutput(stdout);
  const err = capOutput(stderr);
  return {
    stdout: out.text,
    stderr: err.text,
    exitCode,
    ...(out.truncated ? { stdout_truncated: true } : {}),
    ...(err.truncated ? { stderr_truncated: true } : {}),
    ...(timedOut ? { timed_out: true } : {}),
    ...(wrote.length > 0 ? { persisted: wrote.slice(0, MAX_TRAILER_PATHS) } : {}),
    ...(deleted.length > 0 ? { deleted: deleted.slice(0, MAX_TRAILER_PATHS) } : {}),
    ...(wrote.length + deleted.length > 0
      ? { persisted_note: persistedTrailer(wrote, deleted) }
      : {}),
  };
}

/**
 * `persisted: wrote /shared/x, /home/t/y; deleted /home/t/z …and N more` —
 * the positive durability confirmation appended to the tool result.
 */
export function persistedTrailer(wrote: readonly string[], deleted: readonly string[]): string {
  const parts: string[] = [];
  const shown = { n: 0 };
  const take = (paths: readonly string[]): string[] => {
    const room = Math.max(MAX_TRAILER_PATHS - shown.n, 0);
    const taken = paths.slice(0, room);
    shown.n += taken.length;
    return taken;
  };
  const w = take(wrote);
  if (w.length > 0) parts.push(`wrote ${w.join(", ")}`);
  const d = take(deleted);
  if (d.length > 0) parts.push(`deleted ${d.join(", ")}`);
  const more = wrote.length + deleted.length - shown.n;
  return `persisted: ${parts.join("; ")}${more > 0 ? ` …and ${more} more` : ""}`;
}

function appendLine(s: string, line: string): string {
  if (s === "") return `${line}\n`;
  return s.endsWith("\n") ? `${s}${line}\n` : `${s}\n${line}\n`;
}

function capOutput(s: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= MAX_OUTPUT_BYTES) return { text: s, truncated: false };
  return {
    text: `${buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n…[output truncated]`,
    truncated: true,
  };
}
