/**
 * The uniform, teaching-first error taxonomy.
 *
 *   validation · conflict(version) · not_found · refused(refs/scope/budget) · schema
 *
 * Hard rule (teaching-layer injection class): teaching responses reference
 * other objects **by id only**,
 * never echo their title/body/props; any stored string that must be shown is
 * delimited as untrusted; suggestions are capability-generic (never
 * destructive coaching). The teaching layer must not become an injection
 * channel. These constructors are the single place error text is shaped, so
 * that rule is enforceable in one spot.
 */

export const BRAIN_ERROR_CODES = [
  "validation",
  "conflict",
  "not_found",
  "refused",
  "schema",
] as const;

export type BrainErrorCode = (typeof BRAIN_ERROR_CODES)[number];

export interface BrainErrorDetails {
  /** ids only — never stored strings (title/body/props/enum values). */
  readonly [key: string]: string | number | boolean | readonly string[] | undefined;
}

export interface BrainErrorJson {
  readonly code: BrainErrorCode;
  /** Capability-generic teaching message. No stored content. */
  readonly message: string;
  /** For `refused`: the concrete unblock. Also capability-generic. */
  readonly unblock?: string;
  /** ids / counts / flags only. */
  readonly details?: BrainErrorDetails;
}

export class BrainError extends Error {
  readonly code: BrainErrorCode;
  readonly unblock?: string;
  readonly details?: BrainErrorDetails;

  constructor(
    code: BrainErrorCode,
    message: string,
    opts?: { unblock?: string; details?: BrainErrorDetails },
  ) {
    super(message);
    this.name = "BrainError";
    this.code = code;
    if (opts?.unblock !== undefined) this.unblock = opts.unblock;
    if (opts?.details !== undefined) this.details = opts.details;
    Object.setPrototypeOf(this, BrainError.prototype);
  }

  toJSON(): BrainErrorJson {
    const out: {
      code: BrainErrorCode;
      message: string;
      unblock?: string;
      details?: BrainErrorDetails;
    } = {
      code: this.code,
      message: this.message,
    };
    if (this.unblock !== undefined) out.unblock = this.unblock;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function isBrainError(e: unknown): e is BrainError {
  return e instanceof BrainError;
}

/**
 * Wrap a stored (agent-authored, therefore untrusted) string so a downstream
 * reader — human or another agent — can see it is data, not an instruction.
 * The only sanctioned way to surface stored content inside a teaching string.
 * Boundary guillemets and control characters in the content are neutralized so
 * it cannot forge the delimiter or smuggle control bytes; ordinary text (spaces
 * included) is preserved verbatim. Built by code point (not a regex) to avoid
 * control characters in source.
 */
export function delimitUntrusted(stored: string): string {
  let neutralized = "";
  for (const ch of stored) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    neutralized += isControl || ch === "«" || ch === "»" ? "�" : ch;
  }
  return `«untrusted» ${neutralized} «/untrusted»`;
}

export const validationError = (message: string, details?: BrainErrorDetails): BrainError =>
  new BrainError("validation", message, details ? { details } : undefined);

export const conflictError = (currentVersion: number | bigint, targetId?: string): BrainError =>
  new BrainError("conflict", "version conflict: the object changed since you last read it", {
    unblock: "re-read the object with get(id) and retry the edit with the new version",
    details: {
      current_version: typeof currentVersion === "bigint" ? Number(currentVersion) : currentVersion,
      ...(targetId ? { id: targetId } : {}),
    },
  });

export const notFoundError = (id?: string, didYouMean?: readonly string[]): BrainError =>
  new BrainError(
    "not_found",
    "no live object with that id",
    id
      ? {
          details: {
            id,
            // ids only (per the hard rule above) — candidates that share the
            // caller's id prefix, so a truncated/mistyped id can be recovered
            // without a search round trip.
            ...(didYouMean && didYouMean.length > 0 ? { did_you_mean: didYouMean } : {}),
          },
        }
      : undefined,
  );

export const refusedError = (
  message: string,
  unblock: string,
  details?: BrainErrorDetails,
): BrainError => new BrainError("refused", message, details ? { unblock, details } : { unblock });

export const schemaError = (message: string, details?: BrainErrorDetails): BrainError =>
  new BrainError("schema", message, details ? { details } : undefined);
