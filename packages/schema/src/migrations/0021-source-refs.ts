import type { Migration } from "./types.js";

/**
 * Sourced-write provenance (connector groundwork).
 *
 *   source_refs jsonb — the connector doc refs (e.g. "msgraph:…") a write
 *                       declared its content derives from. Permanent
 *                       provenance: "everything derived from doc X" stays a
 *                       query. NULL = not a sourced write (every pre-existing
 *                       object, and all normal writes).
 *
 * Deliberately provenance-ONLY: scoping a derived page (new page, private,
 * shared with the doc's people, linked — never appended to an existing page)
 * is agent doctrine carried by the write tool's description; the box records
 * the citation but does not compute or enforce audiences. (Events are
 * trigger-emitted and brain_app has no INSERT on events, so provenance lives
 * on the row.)
 *
 * Nullable, no default, no backfill, no trigger or grant changes — a box
 * with rows migrates without touching anything; INSERT is covered by 0001's
 * table-level grant. The write path references the column only when a write
 * actually declares sources, so plain writes keep working against a
 * previous-schema brain (the migrate-with-data seed).
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

ALTER TABLE objects ADD COLUMN source_refs jsonb;
`;

export const migration0021: Migration = {
  version: "0021",
  name: "source-refs-provenance",
  sql: SQL,
};
