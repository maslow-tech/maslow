/**
 * The ONE definition of the filesystem's `on_behalf_of` narrowing conjunct.
 *
 * It lives here, not inside a migration file, because it has to appear
 * VERBATIM in every RLS policy that scopes filesystem bytes. It did not, once:
 * 0037 gave `fs_entries` the conjunct, 0043 hand-copied the rest of that policy
 * onto `fs_versions` and dropped it — so a narrowed session (a service account
 * acting for a member, `x-on-behalf-of`) got ENOENT reading its own principal's
 * home file while `history`, `versionContent` and `listTrash` handed back that
 * same file's CONTENT out of the snapshot log. 0046 restores the conjunct;
 * this module is why the two policies cannot drift apart again.
 *
 * Editing this string changes the SQL text of every migration that embeds it,
 * and applied migrations are checksum-immutable — so it is FROZEN. A future
 * change in narrowing semantics ships as a new migration that DROP/CREATEs the
 * policies with a NEW constant, never as an edit to this one.
 */

// Same uuid-list shape as 0032's group on_behalf_of policy: '' = off,
// '<uuid>[,<uuid>…]' = narrow to the intersection, garbage = fail closed.
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const LIST_RE = `^${UUID}(,${UUID})*$`;

// on_behalf_of narrowing conjunct (0032 shape, adapted: fs_entries has no
// visibility column — "shared" is owner_id IS NULL). Unset ⇒ true; a home row
// is visible while serving a group only if EVERY listed account owns it (an
// intersection: for >1 distinct member that's only ever shared rows); any
// non-list value ⇒ shared-only (the CASE guards the uuid cast — Postgres does
// not short-circuit booleans, CASE guarantees the regex runs first).
export const FS_OBO_CONJUNCT = `(
      coalesce(current_setting('app.on_behalf_of', true), '') = ''
      OR owner_id IS NULL
      OR CASE WHEN current_setting('app.on_behalf_of', true) ~ '${LIST_RE}'
           THEN NOT EXISTS (
             SELECT 1
             FROM unnest(string_to_array(current_setting('app.on_behalf_of', true), ',')) AS obo(u)
             WHERE NOT (owner_id = obo.u::uuid)
           )
           ELSE false END)`;
