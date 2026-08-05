/**
 * The closed-enum box→booth wire format.
 *
 * Box→booth is a **closed enum `{code, count, non-content-string}`, enforced
 * at booth ingest** (reject/quarantine non-matching). Postgres `detail/where/
 * hint` are stripped upstream (they embed row values → PII); schema errors are
 * reported by surrogate `type_id`/`property_id`, never by agent-authored names
 * (names *are* content). This module is the shared contract both sides import
 * so the box can't emit — and the booth can't accept — a code outside the set.
 */

export const BOX_ERROR_CODES = [
  "db_unique_violation",
  "db_foreign_key_violation",
  "db_check_violation",
  "db_not_null_violation",
  "db_serialization_failure",
  "db_deadlock",
  "db_statement_timeout",
  "db_disk_full",
  "db_connection_error",
  "write_conflict",
  "budget_exceeded",
  "write_shed_disk",
  "auth_rejected",
  "booth_unreachable",
  "schema_drift_quarantine",
  "executor_error",
  "migration_error",
  "internal_error",
] as const;

export type BoxErrorCode = (typeof BOX_ERROR_CODES)[number];

const BOX_ERROR_CODE_SET: ReadonlySet<string> = new Set(BOX_ERROR_CODES);

export function isBoxErrorCode(x: unknown): x is BoxErrorCode {
  return typeof x === "string" && BOX_ERROR_CODE_SET.has(x);
}

/** Max length of the non-content note; a note is a fixed label, never a value. */
export const MAX_BOX_ERROR_NOTE = 120;

export interface BoxErrorReport {
  readonly code: BoxErrorCode;
  readonly count: number;
  /**
   * A non-content string: a short, fixed operator-facing label (e.g. a
   * surrogate id like "type_id=7"). NEVER an agent-authored name or a row
   * value. Validated at booth ingest.
   */
  readonly note?: string;
}

/**
 * Map a Postgres SQLSTATE to a fixed box error code. Unknown states collapse to
 * `internal_error` — the booth never learns the raw SQLSTATE, only the code.
 * (SQLSTATE class references: 23xxx integrity, 40xxx txn rollback, 53xxx
 * insufficient resources, 08xxx connection, 57014 query canceled.)
 */
export function sqlstateToBoxCode(sqlstate: string | undefined): BoxErrorCode {
  switch (sqlstate) {
    case "23505":
      return "db_unique_violation";
    case "23503":
      return "db_foreign_key_violation";
    case "23514":
      return "db_check_violation";
    case "23502":
      return "db_not_null_violation";
    case "40001":
      return "db_serialization_failure";
    case "40P01":
      return "db_deadlock";
    case "57014":
      return "db_statement_timeout";
    case "53100": // disk full
    case "53200": // out of memory
    case "53300": // too many connections
      return sqlstate === "53100" ? "db_disk_full" : "db_connection_error";
    case "08000":
    case "08003":
    case "08006":
      return "db_connection_error";
    default:
      return "internal_error";
  }
}

/**
 * Booth-ingest validator: accept a report ONLY if it matches the closed shape.
 * Anything else is rejected (the caller quarantines it) so a compromised or
 * buggy box can't smuggle content out through the error channel.
 */
export function validateBoxErrorReport(x: unknown): x is BoxErrorReport {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (!isBoxErrorCode(r.code)) return false;
  if (typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 0) return false;
  if (r.note !== undefined) {
    if (typeof r.note !== "string") return false;
    if (r.note.length > MAX_BOX_ERROR_NOTE) return false;
    // A note is a fixed label: printable ASCII, no control chars, no newlines.
    if (!/^[\x20-\x7e]*$/.test(r.note)) return false;
  }
  const allowed = new Set(["code", "count", "note"]);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return false;
  return true;
}
