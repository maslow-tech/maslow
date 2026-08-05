import type { Migration } from "./types.js";

/**
 * Group scoping for the teammate bot: `app.on_behalf_of` may now carry a
 * COMMA-SEPARATED list of account uuids (a channel/group conversation). A
 * private row is visible only when EVERY listed account could see it —
 * the true intersection, so nothing leaks into a group that any one member
 * couldn't already see. Deliberately no org-visible shortcut: orgs that share
 * little org-wide still get their real common ground.
 *
 *   ''                    → off, actor's normal view
 *   '<uuid>'              → single-requester intersection (0030, unchanged —
 *                            a one-element list)
 *   '<uuid>,<uuid>,…'     → group intersection (every member must see the row)
 *   'none' / anything else → org-visible floor (fail closed)
 *
 * WITH CHECK carries the same conjunct: while serving a group, a private write
 * must be shared_with the whole group.
 *
 * Same CASE-guard rationale as 0030 (Postgres may evaluate branches in any
 * order; CASE guarantees the regex runs before any uuid cast). Policy swap
 * only — no data touched; safe on live boxes (migration doctrine). Scaling
 * note: the per-row check is an unnest over ≤32 ids — if group chat ever hits
 * a 100k-object brain, add a GIN accessors index; not before.
 *
 * Lock posture: 5s lock_timeout on the ACCESS EXCLUSIVE policy swap — the same
 * accepted risk 0012/0018/0030 shipped with (a busy box throws, the runner
 * retries next poll; MCP transactions are short so contention is transient).
 * If a fleet box ever latches on 55P03 here, the fix is updater-side (classify
 * lock timeouts as busy-retry, not poison), not a longer timeout.
 */

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const LIST_RE = `^${UUID}(,${UUID})*$`;

const OBO_CONJUNCT = `(
      coalesce(current_setting('app.on_behalf_of', true), '') = ''
      OR visibility = 'org'
      OR CASE WHEN current_setting('app.on_behalf_of', true) ~ '${LIST_RE}'
           THEN NOT EXISTS (
             SELECT 1
             FROM unnest(string_to_array(current_setting('app.on_behalf_of', true), ',')) AS obo(u)
             WHERE NOT (created_by = obo.u::uuid OR obo.u::uuid = ANY(shared_with))
           )
           ELSE false END)`;

const SQL = `
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS brain_visibility ON objects;
CREATE POLICY brain_visibility ON objects
  USING (
    (visibility = 'org'
      OR created_by = nullif(current_setting('app.actor_id', true), '')::uuid
      OR nullif(current_setting('app.actor_id', true), '')::uuid = ANY(shared_with))
    AND ${OBO_CONJUNCT})
  WITH CHECK (
    (visibility = 'org'
      OR created_by = nullif(current_setting('app.actor_id', true), '')::uuid
      OR nullif(current_setting('app.actor_id', true), '')::uuid = ANY(shared_with))
    AND ${OBO_CONJUNCT});
`;

export const migration0032: Migration = {
  version: "0032",
  name: "group-on-behalf-of",
  sql: SQL,
};
