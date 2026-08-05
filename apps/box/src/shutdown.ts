/**
 * The box's SIGTERM drain — sequenced, budgeted, and impossible to outlive the
 * compose stop grace.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT "just process.exit(0)".
 *
 * Two kinds of state live only in this process's memory:
 *
 *  - LIVE COLLAB ROOMS. The flush cadence means a room can hold up to ~30s of
 *    typed text in the CRDT and nowhere else. Neither the dashboard's save
 *    queue nor the editor's localStorage mirror protects it — the text was
 *    never a pending save, it was a Yjs update.
 *  - QUEUED CALL-AUDIT WRITES. Dropping the tail of the audit trail silently
 *    breaks "recent shows everything".
 *
 * And the box is restarted CONSTANTLY: the updater recreates the app container
 * on every release and on every signed restart op, inside Docker's default 10s
 * SIGTERM window. So an un-drained exit does not lose data rarely — it loses
 * the last paragraph of everyone who was typing, on every box, on every
 * release.
 *
 * THE ORDER MATTERS, and it is: readiness goes not-ready FIRST (synchronously,
 * before a single `await`), so `/healthz` answers 503 and caddy's health check
 * marks this upstream down before any socket is closed; then rooms are drained
 * (mark read-only → flush → close); then the audit queue is flushed; then exit.
 * Rooms before audit, because a room flush is itself an attributed write that
 * ENQUEUES audit rows — flushing the queue first would just leave a new tail.
 *
 * THE BUDGETS ARE A LADDER, and every rung must be strictly smaller than the
 * one outside it, or the outer bound is the only one that ever fires:
 *
 *   per-room flush (collab drainTimeoutMs, 15s)
 *     < collab drain stage (20s)
 *       < overall shutdown budget (30s)
 *         < compose `stop_grace_period` for the app service (45s)
 *           < the customer's patience, and SIGKILL
 *
 * A wedged database is the case this exists for: it must cost a slow restart,
 * never a SIGKILL mid-flush (which is exactly the data loss the drain was
 * added to prevent). `assertBudgetLadder` is asserted by the unit test so the
 * ordering cannot rot when someone tunes one number.
 */

/** Inner bound handed to the collab server (`drainTimeoutMs`) for its flushes. */
export const COLLAB_FLUSH_BUDGET_MS = 15_000;
/** Outer bound on the whole "drain every live room" stage. */
export const COLLAB_DRAIN_BUDGET_MS = 20_000;
/** Bound on flushing the queued call-audit writes. */
export const AUDIT_FLUSH_BUDGET_MS = 5_000;
/** Hard ceiling on the entire shutdown: past this the process exits regardless. */
export const SHUTDOWN_BUDGET_MS = 30_000;
/**
 * MUST match `stop_grace_period` on the `app` service in
 * `deploy/docker-compose.yml` (the unit test asserts the file agrees). Docker's
 * default is 10s, which is less than a single room flush budget — leaving the
 * default would SIGKILL the box mid-drain on every release.
 */
export const COMPOSE_STOP_GRACE_SECONDS = 45;

/** One drain step: a name for the log, its own bound, and the work. */
export interface ShutdownStage {
  readonly name: string;
  readonly budgetMs: number;
  readonly run: () => Promise<void>;
}

export interface ShutdownOptions {
  /** run in order; a stage that fails or times out never blocks the next one. */
  readonly stages: readonly ShutdownStage[];
  /** hard ceiling on all stages together. Defaults to SHUTDOWN_BUDGET_MS. */
  readonly totalBudgetMs?: number | undefined;
  /**
   * Called SYNCHRONOUSLY, before any stage — this is what flips `/healthz` to
   * not-ready. It must not await: the point is that the next health probe sees
   * the drain even if every stage is stuck.
   */
  readonly onDrainStart?: (() => void) | undefined;
  /** injected so the sequencer is testable without killing the test runner. */
  readonly exit: (code: number) => void;
  readonly log?: ((message: string) => void) | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}

/** What the process's signal handlers call. */
export type ShutdownHandler = (signal: string) => void;

type StageOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "timeout" };

const unref = (timer: NodeJS.Timeout): void => {
  // A drain timer must never be the reason the event loop stays alive; under a
  // fake-timer test runner `unref` may not exist at all.
  (timer as unknown as { unref?: () => void }).unref?.();
};

/**
 * Run one stage under its own bound. A rejection is CAPTURED (not raced), so a
 * stage that blows up after its timeout cannot surface as an unhandled
 * rejection during shutdown.
 */
async function runStage(stage: ShutdownStage, budgetMs: number): Promise<StageOutcome> {
  const settled: Promise<StageOutcome> = stage.run().then(
    (): StageOutcome => ({ kind: "done" }),
    (error: unknown): StageOutcome => ({ kind: "failed", error }),
  );
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<StageOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), budgetMs);
    unref(timer);
  });
  try {
    return await Promise.race([settled, bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build the signal handler. Idempotent by construction: the first signal starts
 * the drain, a SECOND one means "now" (a human hitting ctrl-C twice, or an
 * impatient supervisor) and exits immediately, and `exit` is called at most
 * once no matter which path gets there first.
 */
export function createShutdown(opts: ShutdownOptions): ShutdownHandler {
  const log = opts.log ?? ((message: string): void => console.log(message));
  const warn = opts.warn ?? ((message: string): void => console.warn(message));
  const totalBudgetMs = opts.totalBudgetMs ?? SHUTDOWN_BUDGET_MS;

  let draining = false;
  let exited = false;
  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    opts.exit(code);
  };

  return (signal: string): void => {
    if (draining) {
      warn(`${signal}: already draining — exiting now`);
      exitOnce(0);
      return;
    }
    draining = true;

    // FIRST, synchronously, before anything can await: /healthz goes not-ready
    // so caddy stops routing new sessions here BEFORE the socket stops
    // accepting them. A drain that closed sockets first would hand every
    // in-flight reconnect a 502 from an upstream caddy still believes in.
    opts.onDrainStart?.();

    log(`${signal}: draining before exit (${opts.stages.map((s) => s.name).join(" → ")})`);

    // The floor under every per-stage bound: even if a stage's own timer is
    // wrong, or a stage returns a promise that never settles AND never times
    // out, the process still exits well inside the compose stop grace.
    const watchdog = setTimeout(() => {
      warn(`shutdown: exceeded the ${totalBudgetMs}ms budget — exiting anyway`);
      exitOnce(0);
    }, totalBudgetMs);
    unref(watchdog);

    const deadline = Date.now() + totalBudgetMs;
    void (async (): Promise<void> => {
      for (const stage of opts.stages) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          warn(`shutdown: no budget left for ${stage.name} — skipped`);
          continue;
        }
        const outcome = await runStage(stage, Math.min(stage.budgetMs, remaining));
        if (outcome.kind === "done") {
          log(`shutdown: ${stage.name} drained`);
        } else if (outcome.kind === "failed") {
          // Never fatal, and never a `break`: the audit queue must still be
          // flushed when the room drain fails, and vice versa.
          warn(`shutdown: ${stage.name} failed — ${String(outcome.error)}`);
        } else {
          warn(`shutdown: ${stage.name} exceeded ${stage.budgetMs}ms — moving on`);
        }
      }
    })().finally(() => {
      clearTimeout(watchdog);
      exitOnce(0);
    });
  };
}

/**
 * The ladder invariant, as code so the unit test can assert it: every bound is
 * strictly inside the next one out, and the whole shutdown fits in the compose
 * stop grace with room to spare. Returns the violations (empty ⇒ sound).
 */
export function assertBudgetLadder(
  budgets: {
    readonly collabFlushMs: number;
    readonly collabDrainMs: number;
    readonly auditFlushMs: number;
    readonly totalMs: number;
    readonly stopGraceSeconds: number;
  } = {
    collabFlushMs: COLLAB_FLUSH_BUDGET_MS,
    collabDrainMs: COLLAB_DRAIN_BUDGET_MS,
    auditFlushMs: AUDIT_FLUSH_BUDGET_MS,
    totalMs: SHUTDOWN_BUDGET_MS,
    stopGraceSeconds: COMPOSE_STOP_GRACE_SECONDS,
  },
): readonly string[] {
  const problems: string[] = [];
  if (!(budgets.collabFlushMs < budgets.collabDrainMs)) {
    problems.push("the per-room flush bound must be strictly inside the collab drain stage");
  }
  if (!(budgets.collabDrainMs + budgets.auditFlushMs <= budgets.totalMs)) {
    problems.push("the stages together must fit inside the overall shutdown budget");
  }
  if (!(budgets.totalMs < budgets.stopGraceSeconds * 1000)) {
    problems.push("the shutdown budget must be strictly inside the compose stop grace");
  }
  return problems;
}
