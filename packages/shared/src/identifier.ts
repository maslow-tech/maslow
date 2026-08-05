/**
 * The identifier sanitizer — the shared dependency
 * that every DDL-adjacent code path (executor AND generic triggers) leans on.
 *
 * Pipeline (order matters):
 *   NFC-normalize → `^[a-z][a-z0-9_]*$` → ≤63 bytes → reserved denylist
 *   → (UNIQUE `physical_name` registry, enforced DB-side) → `%I` quoting.
 *
 * Homoglyphs / NUL / emoji / combining marks all fail the ASCII charset gate
 * *after* NFC normalization. Derived identifiers (junction/FK/index/trigger
 * names that concatenate two 63-byte ids) are hash-suffixed and registered to
 * avoid silent-truncation collisions.
 *
 * This module does NOT quote — quoting is `format('%I')` server-side. It only
 * decides whether a candidate identifier is legal, and derives collision-free
 * names. No attacker literal should ever reach DDL; this is the first gate.
 */

import { createHash } from "node:crypto";

export const MAX_IDENTIFIER_BYTES = 63;

const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Reserved denylist: our own infra table/column names, the `pg_` namespace,
 * a core of SQL keywords, and the internal suffixes we generate. Kept
 * deliberately broad — a rejected-but-legal name costs the agent a rename;
 * an accepted collision corrupts the catalog.
 */
const RESERVED = new Set<string>([
  // the fixed infra spine tables
  "objects",
  "edges",
  "accounts",
  "events",
  "types",
  "type_properties",
  "enum_option",
  "pending_ops",
  "idempotency",
  "before_image",
  "schema_migrations",
  "physical_name",
  // reserved column names on the spine
  "id",
  "type_id",
  "title",
  "body",
  "tsv",
  "created_by",
  "created_at",
  "updated_at",
  "version",
  "deleted_at",
  "deleted_by",
  "from_id",
  "to_id",
  "rel",
  "provenance",
  // roles
  "brain_owner",
  "brain_app",
  "brain_external",
  // SQL / pg keywords most likely to be attempted
  "select",
  "insert",
  "update",
  "delete",
  "drop",
  "table",
  "column",
  "index",
  "trigger",
  "constraint",
  "user",
  "role",
  "grant",
  "revoke",
  "public",
  "primary",
  "foreign",
  "key",
  "null",
  "true",
  "false",
  "default",
  "check",
  "unique",
  "references",
  "cascade",
  "order",
  "group",
  "where",
  "from",
  "into",
  "values",
  "returning",
  "current_setting",
  "set_config",
  "session_user",
  "current_user",
]);

/** Suffixes/prefixes the schema layer reserves for generated objects. */
const RESERVED_SUFFIXES = ["_ext"];
const RESERVED_PREFIXES = ["pg_", "brain_", "_"];

export type SanitizeFailure =
  | "empty"
  | "not_string"
  | "charset"
  | "too_long"
  | "reserved"
  | "reserved_prefix"
  | "reserved_suffix";

export type SanitizeResult =
  | { readonly ok: true; readonly identifier: string }
  | { readonly ok: false; readonly reason: SanitizeFailure };

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Validate a single agent-supplied identifier candidate. Returns the accepted
 * (NFC-normalized) identifier or a machine-readable failure reason. Uniqueness
 * against the live `physical_name` registry is a separate, DB-side check.
 */
export function sanitizeIdentifier(raw: unknown): SanitizeResult {
  if (typeof raw !== "string") return { ok: false, reason: "not_string" };
  if (raw.length === 0) return { ok: false, reason: "empty" };

  // Step 1: NFC-normalize. Any non-ASCII (homoglyph, combining mark, emoji)
  // survives normalization only to be rejected by the ASCII charset gate.
  const normalized = raw.normalize("NFC");

  // Step 2: charset — leading lowercase letter, then [a-z0-9_]. This also
  // rejects NUL, whitespace, quotes, semicolons, and every non-ASCII glyph.
  if (!IDENTIFIER_RE.test(normalized)) return { ok: false, reason: "charset" };

  // Step 3: byte length (post-charset it is pure ASCII, so bytes == chars,
  // but we measure bytes to stay correct if the charset ever widens).
  if (byteLength(normalized) > MAX_IDENTIFIER_BYTES) return { ok: false, reason: "too_long" };

  // Step 4: reserved denylist (exact, prefix, suffix).
  if (RESERVED.has(normalized)) return { ok: false, reason: "reserved" };
  for (const p of RESERVED_PREFIXES) {
    if (normalized.startsWith(p)) return { ok: false, reason: "reserved_prefix" };
  }
  for (const s of RESERVED_SUFFIXES) {
    if (normalized.endsWith(s)) return { ok: false, reason: "reserved_suffix" };
  }

  return { ok: true, identifier: normalized };
}

/** True iff `raw` is an already-legal identifier (no derivation applied). */
export function isValidIdentifier(raw: unknown): boolean {
  return sanitizeIdentifier(raw).ok;
}

/**
 * Double-quote a catalog-sourced identifier for use in DML built Node-side
 * (the write path's props UPDATE/INSERT, which is DML — not DDL). This checks
 * only the CHARSET + byte length — NOT the reserved denylist — because the
 * names it quotes are our own generated relation/column names (e.g. the
 * `client_ext` table, a junction), which intentionally use forms the user-input
 * sanitizer forbids (the `_ext` suffix). The charset gate alone makes an
 * embedded quote impossible, which is all injection-safety requires here. DDL
 * still goes exclusively through the server-side %I primitives.
 */
export function quoteIdentifier(name: string): string {
  if (
    typeof name !== "string" ||
    !IDENTIFIER_RE.test(name) ||
    byteLength(name) > MAX_IDENTIFIER_BYTES
  ) {
    throw new Error(`refusing to quote unsafe identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/**
 * Deterministically derive a collision-free identifier from already-sanitized
 * parts (e.g. a `ref[]` junction name from two type/property physical names).
 * If the natural join fits in 63 bytes it is used verbatim; otherwise it is
 * truncated and a stable hash suffix of the *full logical name* is appended,
 * so two different logical names can never silently truncate to the same
 * physical name. The caller still registers the result in `physical_name`.
 *
 * Every input part must already be a valid identifier; the joined natural form
 * (letter-led, `[a-z0-9_]` only) therefore stays a valid identifier, and the
 * hash suffix (`_` + 10 hex) preserves that.
 */
export function deriveIdentifier(
  parts: readonly string[],
  opts?: { separator?: string; maxBytes?: number },
): string {
  const separator = opts?.separator ?? "_";
  const maxBytes = opts?.maxBytes ?? MAX_IDENTIFIER_BYTES;

  for (const p of parts) {
    if (!IDENTIFIER_RE.test(p)) {
      throw new Error(`deriveIdentifier: part is not a sanitized identifier: ${JSON.stringify(p)}`);
    }
  }
  const logical = parts.join(separator);
  if (byteLength(logical) <= maxBytes) return logical;

  // 10 hex chars ~ 40 bits: collision-resistant enough for per-box identifier
  // derivation, and short enough to leave room for a meaningful prefix.
  const hash = createHash("sha256").update(logical).digest("hex").slice(0, 10);
  const suffix = `_${hash}`;
  const room = maxBytes - suffix.length;
  if (room < 1) {
    // Degenerate config; suffix alone still starts with '_' which is illegal,
    // so lead with the first part's initial letter to stay a valid identifier.
    return `${logical[0]}${suffix}`.slice(0, maxBytes);
  }
  // Inputs are ASCII, so a character slice is a byte slice.
  return `${logical.slice(0, room)}${suffix}`;
}
