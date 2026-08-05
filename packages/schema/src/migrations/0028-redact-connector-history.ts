import type { Migration } from "./types.js";

/**
 * One-time backfill for a real privacy leak: before this release, redactForAudit
 * had no case for connector tool calls (google/microsoft/samgov_fetch), so their
 * args — mailbox content, calendar event details, external-API query text — were
 * written to events.payload in full. events.payload is read verbatim by every
 * viewer (recent with summary:false), so any member could read another member's
 * Gmail/Calendar content off the org-wide activity feed. Confirmed live on
 * brain.example.com: a home address and a full personal itinerary were sitting
 * in plaintext in the events table.
 *
 * The code fix (CONNECTOR_CONTENT_FIELDS in write-path.ts) stops new leaks; this
 * migration redacts what's already there. Same field lists as the write path,
 * kept in sync by hand (SQL migrations can't import TS). path/method/action are
 * left alone — legitimate audit trail, never the leak.
 *
 * Only touches rows where payload->'args' is a JSON object (guards against any
 * unexpected shape) and only overwrites keys that are actually present, so a
 * call that never had e.g. `body` doesn't gain a spurious redacted key.
 */
const SQL = `
SET LOCAL lock_timeout = '5s';

UPDATE events e
SET payload = jsonb_set(
  e.payload,
  '{args}',
  COALESCE(
    (
      SELECT jsonb_object_agg(
        kv.key,
        CASE
          WHEN e.kind = 'call:google'
               AND kv.key IN ('q', 'message_id', 'to', 'cc', 'subject', 'text', 'params', 'body')
            THEN '"[redacted: connector]"'::jsonb
          WHEN e.kind = 'call:microsoft' AND kv.key IN ('params', 'body')
            THEN '"[redacted: connector]"'::jsonb
          WHEN e.kind = 'call:samgov_fetch' AND kv.key IN ('params')
            THEN '"[redacted: connector]"'::jsonb
          ELSE kv.value
        END
      )
      FROM jsonb_each(e.payload->'args') AS kv(key, value)
    ),
    e.payload->'args'
  )
)
WHERE e.kind IN ('call:google', 'call:microsoft', 'call:samgov_fetch')
  AND jsonb_typeof(e.payload->'args') = 'object';
`;

export const migration0028: Migration = {
  version: "0028",
  name: "redact-connector-history",
  sql: SQL,
};
