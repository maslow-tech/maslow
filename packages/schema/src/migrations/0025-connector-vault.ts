import type { Migration } from "./types.js";

/**
 * Native connector OAuth storage (build-own decision, 2026-07-08: Composio's
 * managed mode fails the in-boundary bar — tokens + raw tool I/O transit and
 * are retained in their cloud — and self-host keeps the cost while killing
 * the convenience; the needed set is ~3 providers via Google + Graph + GitHub).
 *
 *   connector_secrets      — per (account, provider) OAuth tokens, encrypted
 *                            at rest with AES-256-GCM under a key held OUTSIDE
 *                            the database (env; owner-held at install) — a
 *                            leaked DB row is useless alone. Access token and
 *                            the provider's opaque secret blob (e.g. the
 *                            refresh token envelope) live only inside the
 *                            ciphertext; only non-sensitive expiry + scopes
 *                            are clear so the read path can skip a decrypt
 *                            while valid.
 *
 *   connector_oauth_state  — single-use CSRF state rows for in-flight OAuth
 *                            connect flows, holding the PKCE verifier server-
 *                            side (it never leaves the box). Short-lived:
 *                            consumed at the callback or swept after expiry.
 *
 * No RLS: these tables are reached only through the box's connector module
 * (vault + oauth flow), never through the generic read/write tool surface,
 * and the callback route runs before any brain actor exists — rows are always
 * filtered by account_id/state in the query itself.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

CREATE TABLE connector_secrets (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider    text NOT NULL COLLATE "C",
  ciphertext  text NOT NULL,
  iv          text NOT NULL,
  auth_tag    text NOT NULL,
  expires_at  timestamptz,
  scopes      text[] NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider)
);

CREATE TABLE connector_oauth_state (
  state          text PRIMARY KEY COLLATE "C",
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider       text NOT NULL COLLATE "C",
  code_verifier  text NOT NULL,
  redirect_uri   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_secrets     TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_oauth_state TO brain_app;
`;

export const migration0025: Migration = {
  version: "0025",
  name: "connector-vault",
  sql: SQL,
};
