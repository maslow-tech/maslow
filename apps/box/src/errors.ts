/**
 * In-memory closed-enum error rollup for the fleet channel.
 * The booth side — /v1/heartbeat errors[] ingest, the box_errors table, and
 * the console fleet-errors view — has been deployed since the contract
 * shipped; this file is the box half that was never wired, so the console
 * queried an empty table. Same shape as activity.ts: record → merge counts →
 * snapshot on heartbeat.
 *
 * Reports are self-validated before send: ONE malformed entry 400s the WHOLE
 * heartbeat at the booth (telephone.ts ingest), so validation here is
 * mandatory, not defensive decoration.
 */

import { validateBoxErrorReport, type BoxErrorReport } from "@brain/shared";

type Mutable = { code: BoxErrorReport["code"]; count: number; note?: string };

let reports = new Map<string, Mutable>();
/** far above the 18-code enum × few surrogate notes — bounds the map even if
 *  a bug floods distinct notes. */
const MAX_KEYS = 64;

/** Merge one report into the window (keyed code|note). */
export function recordBoxError(report: BoxErrorReport): void {
  const key = `${report.code}|${report.note ?? ""}`;
  const existing = reports.get(key);
  if (existing) {
    existing.count += report.count;
    return;
  }
  if (reports.size >= MAX_KEYS) return;
  reports.set(key, {
    code: report.code,
    count: report.count,
    ...(report.note !== undefined ? { note: report.note } : {}),
  });
}

/** Drain the window, dropping anything the booth would 400 the whole
 *  heartbeat over. */
export function snapshotBoxErrors(): BoxErrorReport[] {
  const out = [...reports.values()].filter((r) => validateBoxErrorReport(r));
  reports = new Map();
  return out;
}
