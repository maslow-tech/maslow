/**
 * The analysis worker: Brandes betweenness (and the rest of `analyze`) off the
 * main thread.
 *
 * Only ONE thing in `analysis.ts` is heavy enough to need a thread. Brandes is
 * O(n·m) — at the committed 5,000-node / 15,000-edge budget an exact run is
 * ~75M edge visits, which is a multi-second main-thread stall on every filter
 * change, i.e. exactly the frozen-tab feeling the whole engine exists to
 * delete. BFS and shortest-path stay on the main thread on purpose: they run
 * inside pointer handlers where a round trip through `postMessage` would cost
 * more than the walk.
 *
 * Three decisions worth stating:
 *
 *  1. **The CSR is CLONED, never TRANSFERRED.** `postMessage` without a
 *     transfer list structured-clones the typed arrays (~250KB at the budget,
 *     microseconds); transferring them would DETACH the main thread's copy and
 *     silently blank hover isolation, culling and the rail, which all read the
 *     same buffers every frame. There is no version of this worth 250KB.
 *  2. **The engine is a plain class taking its `postMessage`**, with the worker
 *     wiring at the bottom guarded by a real-`WorkerGlobalScope` check — the
 *     same shape as `physics.worker.ts`, and for the same reason: the protocol
 *     is then testable headlessly, in jsdom, with no worker at all.
 *  3. **It never throws at the caller.** A malformed command (a stale message
 *     from a previous view, a hand-rolled test double, a shape the worker did
 *     not create) comes back as an `error` EVENT with the request id, so the
 *     panel shows "analysis unavailable" and the graph keeps running. A worker
 *     that dies on a surprising message takes the panel down until reload.
 *
 * Unlike `physics.worker.ts` this module has no heavy dependency, so importing
 * it from the main thread for the protocol types and the client helpers costs
 * nothing — there is no `analysis-protocol.ts` because there is no d3 to keep
 * out of the main chunk.
 */

import { analyze, type AnalysisOptions, type AnalysisSummary } from "./analysis";
import type { Csr } from "./types";

// ---------------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------------

/** Ask for one analysis. `id` is echoed back so replies can be matched. */
export interface AnalyzeCommand {
  type: "analyze";
  id: number;
  csr: Csr;
  options?: AnalysisOptions;
}

export type AnalysisCommand = AnalyzeCommand;

export interface AnalysisResultEvent {
  type: "result";
  id: number;
  summary: AnalysisSummary;
}

export interface AnalysisErrorEvent {
  type: "error";
  id: number;
  message: string;
}

export type AnalysisEvent = AnalysisResultEvent | AnalysisErrorEvent;

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------

export class AnalysisEngine {
  constructor(private readonly post: (event: AnalysisEvent) => void) {}

  handle(command: unknown): void {
    const cmd = command as Partial<AnalyzeCommand> | null | undefined;
    if (cmd == null || cmd.type !== "analyze") return;
    const id = typeof cmd.id === "number" ? cmd.id : 0;
    try {
      const csr = reviveCsr(cmd.csr);
      this.post({ type: "result", id, summary: analyze(csr, cmd.options ?? {}) });
    } catch (error) {
      this.post({ type: "error", id, message: messageOf(error) });
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "analysis failed";
}

/**
 * Rebuild a `Csr` from a structured-cloned message.
 *
 * Structured clone hands typed arrays back as typed arrays, so this is usually
 * an identity check — but it is a check, because the alternative is Brandes
 * indexing into `undefined` and the worker dying on a shape it did not create.
 * Anything unusable throws here, where `handle` turns it into an error event.
 */
export function reviveCsr(value: unknown): Csr {
  const raw = value as Partial<Csr> | null | undefined;
  if (raw == null || typeof raw !== "object") throw new Error("analysis: no csr");

  const offsets = asInt32(raw.offsets);
  const neighbors = asInt32(raw.neighbors);
  const relIndex = asInt32(raw.relIndex);
  const n = typeof raw.n === "number" && raw.n >= 0 ? Math.floor(raw.n) : offsets.length - 1;

  if (offsets.length !== n + 1) throw new Error("analysis: csr offsets do not match n");
  if (relIndex.length !== neighbors.length) {
    throw new Error("analysis: csr relIndex does not match neighbors");
  }

  const rels = Array.isArray(raw.rels) ? raw.rels.map((r) => (typeof r === "string" ? r : "")) : [];
  const m = typeof raw.m === "number" ? raw.m : neighbors.length / 2;

  return { n, m, offsets, neighbors, relIndex, rels };
}

function asInt32(value: unknown): Int32Array {
  if (value instanceof Int32Array) return value;
  if (Array.isArray(value)) return Int32Array.from(value as number[]);
  throw new Error("analysis: csr array missing");
}

// ---------------------------------------------------------------------------
// the main-thread client
// ---------------------------------------------------------------------------

/** The slice of `Worker` this file uses — a test double is four methods. */
export interface AnalysisWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}

let nextRequestId = 1;

/**
 * Run one analysis on `worker` and resolve with its summary.
 *
 * Each call carries its own id and its own listener, so a slow analysis of the
 * previous filter cannot resolve the current one with stale numbers — the
 * caller simply ignores (or the panel discards) a summary whose request it no
 * longer wants.
 */
export function requestAnalysis(
  worker: AnalysisWorkerLike,
  csr: Csr,
  options: AnalysisOptions = {},
): Promise<AnalysisSummary> {
  const id = nextRequestId;
  nextRequestId += 1;

  return new Promise<AnalysisSummary>((resolve, reject) => {
    const listener = (event: { data: unknown }): void => {
      const data = event.data as AnalysisEvent | null | undefined;
      if (data == null || data.id !== id) return;
      worker.removeEventListener("message", listener);
      if (data.type === "result") resolve(data.summary);
      else reject(new Error(data.message));
    };
    worker.addEventListener("message", listener);
    // No transfer list: see decision 1 in the header.
    worker.postMessage({ type: "analyze", id, csr, options } satisfies AnalyzeCommand);
  });
}

/**
 * The real worker. Vite rewrites `new URL("./analysis.worker.ts",
 * import.meta.url)` into the built worker chunk; the cast is because `Worker`'s
 * overloaded `postMessage` does not structurally match our narrowed interface.
 */
export function createAnalysisWorker(): AnalysisWorkerLike {
  if (typeof Worker === "undefined") {
    throw new Error("analysis: no Worker in this environment — run analyze() inline");
  }
  return new Worker(new URL("./analysis.worker.ts", import.meta.url), {
    type: "module",
    name: "graph-analysis",
  }) as unknown as AnalysisWorkerLike;
}

// ---------------------------------------------------------------------------
// worker wiring
// ---------------------------------------------------------------------------

/**
 * True only inside a real dedicated worker. jsdom (and node) have a `self` but
 * no `WorkerGlobalScope`, so importing this module in a test never installs a
 * message handler.
 */
function isWorkerScope(): boolean {
  const g = globalThis as unknown as {
    self?: unknown;
    WorkerGlobalScope?: new () => unknown;
  };
  return (
    typeof g.WorkerGlobalScope === "function" &&
    g.self !== undefined &&
    g.self instanceof g.WorkerGlobalScope
  );
}

if (isWorkerScope()) {
  const scope = globalThis as unknown as {
    postMessage(message: unknown): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  };
  const engine = new AnalysisEngine((event) => scope.postMessage(event));
  scope.addEventListener("message", (event) => {
    engine.handle(event.data);
  });
}
