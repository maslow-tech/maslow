import type { Migration } from "./types.js";

/**
 * Requester-scoped reads for service accounts (the teammate bot).
 *
 * When the bot answers a human, the harness sets `app.on_behalf_of` alongside
 * `app.actor_id` (session-level, never a tool argument — the model cannot set
 * or see it). Visibility then becomes the INTERSECTION of the actor's view and
 * the requester's view, so a requester can never extract via the bot what they
 * could not already see themselves. The GUC can only NARROW access:
 *
 *   ''            → off, actor's normal view (every existing caller)
 *   '<uuid>'      → actor's view ∩ that account's view
 *   'none'        → actor's view ∩ org-visible (requester is not a member;
 *                    any non-uuid value degrades to this floor — fail closed)
 *
 * Only the objects policy changes: every derived policy (before_image,
 * merge_journal, edges, ext/junction via brain_attach_visibility) is
 * EXISTS-on-objects and composes automatically (0012's design).
 *
 * WITH CHECK carries the same conjunct, deliberately: while serving a
 * requester the bot cannot create/repoint private rows the requester couldn't
 * see — but CAN write a private object shared_with the requester.
 *
 * accounts.is_service marks who may use this (the box HTTP layer rejects the
 * header from anyone else). No tool mints it in v1 — set at install time:
 *   UPDATE accounts SET is_service = true WHERE id = '<bot account id>';
 */

const UUID_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const SQL = `
SET LOCAL lock_timeout = '5s';

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_service boolean NOT NULL DEFAULT false;

-- Swap the spine policy (ACCESS EXCLUSIVE on objects; 5s lock_timeout above
-- fails fast on a busy box and the runner retries — same posture as 0012).
-- The uuid cast is guarded by CASE, not AND: Postgres does NOT short-circuit
-- boolean expressions (the planner may evaluate the cast branch first), but
-- CASE guarantees the regex check runs before the cast. Any non-uuid value
-- ('none' included) therefore degrades to the org-visible floor — fail closed.
DROP POLICY IF EXISTS brain_visibility ON objects;
CREATE POLICY brain_visibility ON objects
  USING (
    (visibility = 'org'
      OR created_by = nullif(current_setting('app.actor_id', true), '')::uuid
      OR nullif(current_setting('app.actor_id', true), '')::uuid = ANY(shared_with))
    AND (
      coalesce(current_setting('app.on_behalf_of', true), '') = ''
      OR visibility = 'org'
      OR CASE WHEN current_setting('app.on_behalf_of', true) ~ '${UUID_RE}'
           THEN created_by = current_setting('app.on_behalf_of', true)::uuid
             OR current_setting('app.on_behalf_of', true)::uuid = ANY(shared_with)
           ELSE false END))
  WITH CHECK (
    (visibility = 'org'
      OR created_by = nullif(current_setting('app.actor_id', true), '')::uuid
      OR nullif(current_setting('app.actor_id', true), '')::uuid = ANY(shared_with))
    AND (
      coalesce(current_setting('app.on_behalf_of', true), '') = ''
      OR visibility = 'org'
      OR CASE WHEN current_setting('app.on_behalf_of', true) ~ '${UUID_RE}'
           THEN created_by = current_setting('app.on_behalf_of', true)::uuid
             OR current_setting('app.on_behalf_of', true)::uuid = ANY(shared_with)
           ELSE false END));
`;

export const migration0030: Migration = {
  version: "0030",
  name: "on-behalf-of",
  sql: SQL,
};
