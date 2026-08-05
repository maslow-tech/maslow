/**
 * The three DB roles — the load-bearing privilege model.
 *
 *   brain_owner    owns all tables; only DDL; NOSUPERUSER, NOBYPASSRLS. Used
 *                  ONLY by the schema-executor over a local socket, never
 *                  distributed. Under FORCE ROW LEVEL SECURITY (0039) it no
 *                  longer bypasses RLS by table ownership — see brain_system.
 *   brain_app      DML on base tables, but SELECT-only on the schema catalog,
 *                  no INSERT on accounts (+ no role/status UPDATE), no
 *                  INSERT/UPDATE/DELETE on events, no ownership, no TRIGGER.
 *   brain_external phase 2: DML on views only. Created NOLOGIN in v1.
 *   brain_system   NOLOGIN, BYPASSRLS. The ONE role permitted to read across
 *                  actors for legitimate all-rows system work (the embed sweep,
 *                  the brain_edge_count census, and any future migration
 *                  backfill). Never LOGIN and never distributed: it is reached
 *                  only via `SET ROLE brain_system` from brain_owner, which is
 *                  granted membership. BYPASSRLS is a role attribute and is NOT
 *                  inherited through membership, so brain_owner itself stays
 *                  RLS-bound (0039's tests prove this) — only an explicit
 *                  SET ROLE crosses the boundary. This keeps the privacy
 *                  invariant (no cross-actor content path) structural: no
 *                  request-serving connection can become brain_system.
 *
 * Roles are cluster-wide, so this runs as the superuser during bootstrap
 * (install.sh / DR restore), BEFORE the initial migration hands table
 * ownership to brain_owner. Passwords are generated secrets in production
 * (Docker secrets on the box's data volume); tests pass known-safe values.
 */

export const DB_ROLES = {
  owner: "brain_owner",
  app: "brain_app",
  external: "brain_external",
  /** NOLOGIN BYPASSRLS; reached only via `SET ROLE` from brain_owner (0039). */
  system: "brain_system",
} as const;

export interface RolePasswords {
  readonly owner: string;
  readonly app: string;
  readonly external: string;
}

// Generated secrets only; keeps the password out of any injection surface and
// lets us dollar-quote it safely below.
const SAFE_PASSWORD = /^[A-Za-z0-9_]{12,}$/;
const SAFE_DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Convenience for tests / local dev. NEVER used in production. */
export const DEV_PASSWORDS: RolePasswords = {
  owner: "dev_brain_owner_pw",
  app: "dev_brain_app_pw",
  external: "dev_brain_external_pw",
};

function dollarQuote(s: string): string {
  // s is validated to [A-Za-z0-9_], which cannot contain the tag → safe.
  return `$pw$${s}$pw$`;
}

/**
 * SQL that (idempotently) creates the three roles and hands the database +
 * public schema to brain_owner. Run as the cluster superuser.
 */
export function buildRolesSql(opts: { database: string; passwords: RolePasswords }): string {
  const { database, passwords } = opts;
  if (!SAFE_DB_NAME.test(database))
    throw new Error(`unsafe database name: ${JSON.stringify(database)}`);
  for (const key of ["owner", "app", "external"] as const) {
    if (!SAFE_PASSWORD.test(passwords[key])) {
      throw new Error(`unsafe ${key} password (need ^[A-Za-z0-9_]{12,}$)`);
    }
  }
  const owner = dollarQuote(passwords.owner);
  const app = dollarQuote(passwords.app);
  const external = dollarQuote(passwords.external);

  return `
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_owner') THEN
    CREATE ROLE brain_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    CREATE ROLE brain_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_external') THEN
    CREATE ROLE brain_external NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- brain_system: the all-rows system role (embed sweep, edge census, backfills).
  -- NOLOGIN + BYPASSRLS: reachable only via SET ROLE from brain_owner, never a
  -- distributed credential. Attributes are ensured every migrate (idempotent),
  -- so a box that predates this heals on its next update.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_system') THEN
    CREATE ROLE brain_system NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  ELSE
    ALTER ROLE brain_system NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
  -- brain_owner may become brain_system (SET ROLE) and reassign objects to it,
  -- but does NOT inherit BYPASSRLS from the membership (attributes never are).
  GRANT brain_system TO brain_owner;
END
$bootstrap$;

-- Passwords (operator-rotatable).
ALTER ROLE brain_owner    WITH PASSWORD ${owner};
ALTER ROLE brain_app      WITH PASSWORD ${app};
ALTER ROLE brain_external WITH PASSWORD ${external};

-- brain_external is phase 2 (the DATABASE_URL path); it cannot connect in v1.
ALTER ROLE brain_external NOLOGIN;
ALTER ROLE brain_external SET statement_timeout = '15s';
ALTER ROLE brain_external CONNECTION LIMIT 10;

-- Ownership: brain_owner owns the database + public schema so the executor can
-- run DDL; nobody else can create objects in it.
ALTER DATABASE ${database} OWNER TO brain_owner;
ALTER SCHEMA public OWNER TO brain_owner;
GRANT CONNECT ON DATABASE ${database} TO brain_owner, brain_app;
REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC;
`;
}
