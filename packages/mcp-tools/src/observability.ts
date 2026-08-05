import {
  isBoxErrorCode,
  sqlstateToBoxCode,
  validateBoxErrorReport,
  type BoxErrorReport,
} from "@brain/shared";

/**
 * Box→booth observability egress. The box may only
 * emit the closed enum `{code, count, non-content-string}`. Postgres
 * `detail/where/hint` embed row VALUES (PII) and are stripped entirely; schema
 * errors are reported by SURROGATE `type_id`/`property_id`, never by
 * agent-authored names (names are content). The booth rejects anything else at
 * ingest.
 */

export interface SurrogateContext {
  readonly typeId?: number;
  readonly propertyId?: number;
}

/**
 * Map a Postgres/app error to a closed-enum report, keeping ONLY the SQLSTATE
 * class (→ a fixed code) and an optional surrogate-id note. Never carries
 * detail/where/hint/message/constraint text.
 */
export function toBoxErrorReport(err: unknown, ctx: SurrogateContext = {}): BoxErrorReport {
  const e = err as { code?: string };
  const code = sqlstateToBoxCode(e.code);
  let note: string | undefined;
  if (ctx.typeId !== undefined) note = `type_id=${ctx.typeId}`;
  else if (ctx.propertyId !== undefined) note = `property_id=${ctx.propertyId}`;
  return note !== undefined ? { code, count: 1, note } : { code, count: 1 };
}

/**
 * Strip a raw pg error down to a PII-free shape for local logging (the box's
 * own logs still must not leak row values). detail/where/hint/message are gone.
 */
export function redactPgError(err: unknown): { code: string } {
  const e = err as { code?: string };
  return { code: typeof e.code === "string" ? e.code : "unknown" };
}

/**
 * Booth ingest: accept a report ONLY if it matches the closed shape (delegates
 * to the shared validator); otherwise the caller quarantines it.
 */
export function ingestBoxErrorReport(raw: unknown): BoxErrorReport | null {
  return validateBoxErrorReport(raw) ? (raw as BoxErrorReport) : null;
}

export { isBoxErrorCode };
