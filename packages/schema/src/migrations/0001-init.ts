import type { Migration } from "./types.js";

/**
 * The frozen infra schema, baked into the initial migration.
 * Run as brain_owner. Everything an unrecoverable state depends on is here:
 * the objects spine, the schema catalog, append-only events, the recovery
 * tables, and — critically — the brain_app grant/revoke model.
 *
 * Collation: the database is initialized with the PG17 builtin C.UTF-8
 * locale; identifier-ish columns additionally carry COLLATE "C" for pure-byte,
 * version-stable comparison.
 */

const SQL = `
-- ------------------------------------------------------------------ schema lockdown
-- Nobody creates objects in public except the owner (executor). PG15+ already
-- drops the world CREATE, but we are explicit.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO brain_app;

-- ------------------------------------------------------------------ accounts
-- Members are local accounts. Only the SECURITY DEFINER admin fn INSERTs here;
-- brain_app cannot INSERT, and cannot UPDATE role/status (no self-escalation).
CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text,
  role        text NOT NULL DEFAULT 'member' COLLATE "C"
                CHECK (role IN ('owner', 'member', 'operator', 'system')),
  scopes      text[] NOT NULL DEFAULT '{}'
                CHECK (scopes <@ ARRAY['read','write','schema-admin']::text[]),
  token_hash  text COLLATE "C",
  status      text NOT NULL DEFAULT 'active' COLLATE "C"
                CHECK (status IN ('active', 'revoked', 'disabled')),
  revoked_at  timestamptz,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_email_uniq ON accounts (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX accounts_token_hash_uniq ON accounts (token_hash) WHERE token_hash IS NOT NULL;

-- ------------------------------------------------------------------ schema catalog
-- SELECT-only for brain_app (M1). Writes flow exclusively through the executor.
CREATE TABLE types (
  id            smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- surrogate → cheap rename
  name          text NOT NULL COLLATE "C" UNIQUE,                   -- logical, renamable
  physical_name text NOT NULL COLLATE "C" UNIQUE,                   -- sanitized table base
  label         text,
  description   text,
  deprecated    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE type_properties (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_id       smallint NOT NULL REFERENCES types(id),
  name          text NOT NULL COLLATE "C",
  physical_name text NOT NULL COLLATE "C",
  kind          text NOT NULL COLLATE "C"
                  CHECK (kind IN ('text','int','decimal','float','bool','date',
                                  'timestamp','enum','ref','ref[]')),
  ref_type_id   smallint REFERENCES types(id),      -- for kind in (ref, ref[])
  required      boolean NOT NULL DEFAULT false,
  default_value jsonb,                               -- catalog-only; applied in the write path
  deprecated    boolean NOT NULL DEFAULT false,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type_id, name),
  UNIQUE (type_id, physical_name),
  -- a ref/ref[] property must name its target type; a non-ref must not
  CHECK ((kind IN ('ref','ref[]')) = (ref_type_id IS NOT NULL))
);

CREATE TABLE enum_option (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_id     smallint NOT NULL REFERENCES types(id),
  property_id integer NOT NULL REFERENCES type_properties(id),
  value       text NOT NULL COLLATE "C",
  deprecated  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, value)
);

-- Global registry of every generated physical relation/index name so two
-- derived names can never silently collide. The executor writes here under the
-- advisory lock; brain_app reads only.
CREATE TABLE physical_name (
  name       text PRIMARY KEY COLLATE "C",
  kind       text NOT NULL COLLATE "C" CHECK (kind IN ('table','index','trigger','constraint','sequence')),
  type_id    smallint REFERENCES types(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ objects spine
CREATE TABLE objects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id    smallint REFERENCES types(id),            -- NULL = note
  title      text,
  body       text,
  tsv        tsvector,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    bigint NOT NULL DEFAULT 1,                -- the single optimistic-lock domain
  deleted_at timestamptz,
  deleted_by uuid REFERENCES accounts(id),
  -- body cap: a note is not a file store; also bounds the tsvector.
  CONSTRAINT objects_body_max CHECK (body IS NULL OR octet_length(body) <= 1048576)
);
CREATE INDEX objects_type_live      ON objects (type_id) WHERE deleted_at IS NULL;
CREATE INDEX objects_created_live   ON objects (created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX objects_updated_live   ON objects (updated_at, id) WHERE deleted_at IS NULL;
CREATE INDEX objects_tsv_gin        ON objects USING gin (tsv);

-- ------------------------------------------------------------------ edges (the graph)
CREATE TABLE edges (
  from_id    uuid NOT NULL REFERENCES objects(id),
  rel        text NOT NULL COLLATE "C",
  to_id      uuid NOT NULL REFERENCES objects(id),
  -- 'manual' (from link()) or 'ref:<col>' (kept in sync with a ref column, D.2)
  provenance text NOT NULL COLLATE "C"
               CHECK (provenance = 'manual' OR provenance LIKE 'ref:%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, rel, to_id),
  CHECK (from_id <> to_id)
);
CREATE INDEX edges_to_rel ON edges (to_id, rel);   -- backlinks / neighbors

-- ------------------------------------------------------------------ events (append-only audit)
CREATE TABLE events (
  seq     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- monotonic order, NOT wall-clock
  at      timestamptz NOT NULL DEFAULT now(),
  actor   uuid NOT NULL REFERENCES accounts(id),            -- from app.actor_id (D.3)
  kind    text NOT NULL COLLATE "C",
  target  uuid,                                             -- object id when applicable
  payload jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX events_target ON events (target) WHERE target IS NOT NULL;
CREATE INDEX events_actor  ON events (actor);

-- ------------------------------------------------------------------ durable queues / recovery
CREATE TABLE pending_ops (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL COLLATE "C",
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' COLLATE "C"
                 CHECK (status IN ('pending','confirmed','rejected','applied','failed')),
  requested_by uuid NOT NULL REFERENCES accounts(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid REFERENCES accounts(id),
  confirmed_at timestamptz,
  result       jsonb
);
CREATE INDEX pending_ops_status ON pending_ops (status) WHERE status = 'pending';

CREATE TABLE idempotency (
  account_id uuid NOT NULL REFERENCES accounts(id),
  key        text NOT NULL COLLATE "C",
  status     text NOT NULL DEFAULT 'reserved' COLLATE "C"
               CHECK (status IN ('reserved','done')),
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
CREATE INDEX idempotency_created ON idempotency (created_at);   -- TTL sweep

CREATE TABLE before_image (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES objects(id),
  version   bigint NOT NULL,
  snapshot  jsonb NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  by        uuid NOT NULL REFERENCES accounts(id)
);
CREATE INDEX before_image_object ON before_image (object_id, version DESC);

-- Note: the schema_migrations ledger is owned + created by the migration
-- runner (bootstrap.ts), not by a migration, so the runner can evolve its own
-- bookkeeping (e.g. the pending_concurrent status) independently.

-- ================================================================== brain_app grants
-- Base tables: full DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON objects     TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON edges       TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pending_ops TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency TO brain_app;
GRANT SELECT, INSERT, DELETE          ON before_image TO brain_app;  -- append + trim, never mutate

-- accounts: SELECT + a narrow column-level UPDATE. NO insert/delete, and
-- crucially NO update of role/status/token_hash (no self-escalation, M1).
GRANT SELECT ON accounts TO brain_app;
GRANT UPDATE (name, email) ON accounts TO brain_app;

-- events: append-only, written ONLY by the SECURITY DEFINER trigger (M6).
GRANT SELECT ON events TO brain_app;

-- schema catalog: SELECT-only (M1). Writes only via the executor (brain_owner).
GRANT SELECT ON types           TO brain_app;
GRANT SELECT ON type_properties TO brain_app;
GRANT SELECT ON enum_option     TO brain_app;
GRANT SELECT ON physical_name   TO brain_app;

-- ================================================================== seed
-- A distinguished 'system' account so bootstrap/migration/operator events have
-- a valid, well-known actor (D.3 requires a non-null actor).
INSERT INTO accounts (id, name, role, status, scopes)
VALUES ('00000000-0000-0000-0000-000000000000', 'system', 'system', 'active', '{}')
ON CONFLICT (id) DO NOTHING;
`;

export const migration0001: Migration = {
  version: "0001",
  name: "init",
  sql: SQL,
};
