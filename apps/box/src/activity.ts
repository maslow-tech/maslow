/**
 * In-memory anonymized activity counters for fleet visibility. Records
 * ONLY tool names + counts + call durations — never arguments, titles, or any
 * brain content — so the rollup shipped to the booth on the heartbeat carries
 * no private data. The box app increments on every MCP tools/call; a reporter
 * flushes a snapshot to the booth periodically and resets the window.
 */

export interface ToolTiming {
  /** calls measured in this window. */
  n: number;
  total_ms: number;
  max_ms: number;
}

let tools: Record<string, number> = {};
let timings: Record<string, ToolTiming> = {};
let calls = 0;
let errors = 0;
let windowStart = Date.now();

/** The tool surface is ~18 names (mcp-http maps unknown ones to "(invalid)")
 *  — a key cap far above that bounds the maps even if a caller finds a way
 *  to inject arbitrary labels. */
const MAX_KEYS = 64;

/** Count one tool call (name only), whether it errored, and how long it took.
 *  Totals always count; per-tool maps stop growing NEW keys at the cap. */
export function recordCall(tool: string, isError: boolean, ms?: number): void {
  if (typeof tool !== "string" || tool === "") return;
  calls += 1;
  if (isError) errors += 1;
  const keyed = tool in tools || Object.keys(tools).length < MAX_KEYS;
  if (!keyed) return;
  tools[tool] = (tools[tool] ?? 0) + 1;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) {
    const t = (timings[tool] ??= { n: 0, total_ms: 0, max_ms: 0 });
    t.n += 1;
    t.total_ms += Math.round(ms);
    if (ms > t.max_ms) t.max_ms = Math.round(ms);
  }
}

export function hasActivity(): boolean {
  return calls > 0;
}

/** Return the accumulated window and reset the counters. */
export function snapshotActivity(): {
  tools: Record<string, number>;
  timings: Record<string, ToolTiming>;
  calls: number;
  errors: number;
  windowMs: number;
} {
  const now = Date.now();
  const snap = { tools, timings, calls, errors, windowMs: now - windowStart };
  tools = {};
  timings = {};
  calls = 0;
  errors = 0;
  windowStart = now;
  return snap;
}
