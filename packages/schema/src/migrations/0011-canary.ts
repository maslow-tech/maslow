import type { Migration } from "./types.js";

/**
 * The write-path canary target (the updater's post-swap
 * canary). A single-row table the box's `/canary` endpoint upserts + reads via
 * the least-privilege `brain_app` pool, so the updater verifies the REAL write
 * path after a version swap — primary is writable, WAL flows, disk has room, and
 * brain_app's DML grants are intact — instead of mere `/healthz` liveness. The
 * endpoint is internal-only (blocked at caddy; bypasses the kill-switch gate so
 * an intentionally-off box is not mistaken for a broken deploy).
 *
 * A single fixed row (id = 1) keeps the table bounded; the endpoint only ever
 * UPDATEs its beat_at, so this never grows.
 */

const SQL = `
CREATE TABLE IF NOT EXISTS canary (
  id       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  beat_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO canary (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- brain_app upserts + reads the single row (the write-path probe). No DELETE:
-- the row is permanent, the endpoint only touches beat_at.
GRANT SELECT, INSERT, UPDATE ON canary TO brain_app;
`;

export const migration0011: Migration = {
  version: "0011",
  name: "canary",
  sql: SQL,
};
