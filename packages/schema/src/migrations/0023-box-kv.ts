import type { Migration } from "./types.js";

/**
 * A tiny owner-owned key/value table for box-local persistent settings.
 *
 * First use: the dashboard session-signing secret. It was minted fresh on every
 * process start, so every self-update (which recreates the app container) threw
 * out all sessions and forced everyone to log in again — painful on a box that
 * updates often. Persisting the secret here (read once at boot, generated once
 * if absent) makes sessions survive restarts and updates.
 *
 * Owner-only: nothing granted to brain_app — only the boot path (brain_owner)
 * reads it, and it's not brain content. Safe on a live box: CREATE TABLE IF NOT
 * EXISTS, no data assumptions, no triggers, no grants.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS box_kv (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const migration0023: Migration = {
  version: "0023",
  name: "box-kv",
  sql: SQL,
};
