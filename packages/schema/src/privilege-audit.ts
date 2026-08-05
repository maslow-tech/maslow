import type { Client } from "pg";

/**
 * The privilege-audit. Asserts the exact
 * least-privilege model so a leaked brain_app connection cannot escalate,
 * forge audit rows, or rewrite the schema catalog. Reused by:
 *   - the role-privilege test (fresh box), and
 *   - the DR restore runbook: recovery re-opens escalation if the model
 *     didn't survive the restore, so we re-assert it every time.
 */

export interface AuditCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface AuditResult {
  readonly ok: boolean;
  readonly checks: readonly AuditCheck[];
  readonly violations: readonly AuditCheck[];
}

// `sql` must be a complete statement returning a single boolean column `v`.
async function bool(client: Client, sql: string, params: unknown[] = []): Promise<boolean> {
  const { rows } = await client.query<{ v: boolean }>(sql, params);
  return rows[0]?.v === true;
}

const CATALOG_TABLES = ["types", "type_properties", "enum_option", "physical_name"] as const;

export async function auditPrivileges(client: Client): Promise<AuditResult> {
  const checks: AuditCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // ---- role attributes ---------------------------------------------------
  add(
    "brain_app NOSUPERUSER",
    !(await bool(client, "SELECT rolsuper AS v FROM pg_roles WHERE rolname='brain_app'")),
    "brain_app must not be a superuser",
  );
  add(
    "brain_app NOBYPASSRLS",
    !(await bool(client, "SELECT rolbypassrls AS v FROM pg_roles WHERE rolname='brain_app'")),
    "brain_app must not bypass RLS",
  );
  add(
    "brain_owner NOSUPERUSER",
    !(await bool(client, "SELECT rolsuper AS v FROM pg_roles WHERE rolname='brain_owner'")),
    "brain_owner must not be a superuser",
  );
  // The load-bearing gap FORCE closes: if brain_owner ever gained BYPASSRLS,
  // every content table's FORCE would be silently defeated and private objects
  // would be readable on the executor/branding/owner client.
  add(
    "brain_owner NOBYPASSRLS",
    !(await bool(client, "SELECT rolbypassrls AS v FROM pg_roles WHERE rolname='brain_owner'")),
    "brain_owner must NOT bypass RLS — FORCE depends on it staying RLS-bound",
  );

  // ---- brain_system: the single all-rows role (0039) ---------------------
  // It exists, bypasses RLS (its whole job: embed sweep + edge census), and is
  // NOLOGIN + NOSUPERUSER so it is reachable only via SET ROLE from brain_owner,
  // never as a distributed login credential.
  add(
    "brain_system exists",
    await bool(client, "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='brain_system') AS v"),
    "the all-rows system role must exist once 0039 has applied",
  );
  add(
    "brain_system BYPASSRLS",
    await bool(client, "SELECT rolbypassrls AS v FROM pg_roles WHERE rolname='brain_system'"),
    "brain_system must bypass RLS to embed private objects + count hidden edges",
  );
  add(
    "brain_system NOLOGIN",
    !(await bool(client, "SELECT rolcanlogin AS v FROM pg_roles WHERE rolname='brain_system'")),
    "brain_system must not be a login role — reached only via SET ROLE",
  );
  add(
    "brain_system NOSUPERUSER",
    !(await bool(client, "SELECT rolsuper AS v FROM pg_roles WHERE rolname='brain_system'")),
    "brain_system must not be a superuser",
  );

  // ---- ownership ---------------------------------------------------------
  add(
    "brain_app owns no tables",
    await bool(
      client,
      `SELECT (count(*) = 0) AS v FROM pg_class c JOIN pg_roles r ON c.relowner = r.oid
       WHERE r.rolname='brain_app' AND c.relkind='r'`,
    ),
    "brain_app must not own any table",
  );
  for (const t of ["objects", "events", "accounts", "types"]) {
    add(
      `brain_owner owns ${t}`,
      await bool(
        client,
        `SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON c.relowner=r.oid
         WHERE c.relname=$1 AND r.rolname='brain_owner') AS v`,
        [t],
      ),
      `${t} must be owned by brain_owner`,
    );
  }

  // ---- accounts: no escalation ------------------------------------------
  add(
    "brain_app cannot INSERT accounts",
    !(await bool(client, "SELECT has_table_privilege('brain_app','accounts','INSERT') AS v")),
    "only the SECURITY DEFINER admin fn may create accounts",
  );
  add(
    "brain_app cannot DELETE accounts",
    !(await bool(client, "SELECT has_table_privilege('brain_app','accounts','DELETE') AS v")),
    "brain_app must not delete accounts",
  );
  for (const col of ["role", "status", "token_hash"]) {
    add(
      `brain_app cannot UPDATE accounts.${col}`,
      !(await bool(client, "SELECT has_column_privilege('brain_app','accounts',$1,'UPDATE') AS v", [
        col,
      ])),
      `brain_app updating accounts.${col} would be self-escalation`,
    );
  }
  add(
    "brain_app can SELECT accounts",
    await bool(client, "SELECT has_table_privilege('brain_app','accounts','SELECT') AS v"),
    "brain_app needs to read accounts for auth",
  );
  // The break-glass owner-token minter (0041) must be brain_owner-ONLY — the app
  // pool can never mint an owner token even if SQL-injected.
  add(
    "brain_app cannot EXECUTE brain_reissue_owner_token",
    !(await bool(
      client,
      "SELECT has_function_privilege('brain_app','brain_reissue_owner_token(text,text)','EXECUTE') AS v",
    )),
    "reissue is a brain_owner break-glass primitive, unreachable by the app pool",
  );
  add(
    "brain_owner CAN EXECUTE brain_reissue_owner_token",
    await bool(
      client,
      "SELECT has_function_privilege('brain_owner','brain_reissue_owner_token(text,text)','EXECUTE') AS v",
    ),
    "the tools-profile reissue service connects as brain_owner and must be able to run it",
  );

  // ---- events: append-only, definer-written -----------------------------
  for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
    add(
      `brain_app cannot ${priv} events`,
      !(await bool(client, "SELECT has_table_privilege('brain_app','events',$1) AS v", [priv])),
      "events are written only by the SECURITY DEFINER trigger",
    );
  }
  add(
    "brain_app can SELECT events",
    await bool(client, "SELECT has_table_privilege('brain_app','events','SELECT') AS v"),
    "brain_app reads the timeline",
  );

  // ---- schema catalog: SELECT-only --------------------------------------
  for (const t of CATALOG_TABLES) {
    for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
      add(
        `brain_app cannot ${priv} ${t}`,
        !(await bool(client, "SELECT has_table_privilege('brain_app',$1,$2) AS v", [t, priv])),
        `catalog table ${t} is written only by the executor`,
      );
    }
    add(
      `brain_app can SELECT ${t}`,
      await bool(client, "SELECT has_table_privilege('brain_app',$1,'SELECT') AS v", [t]),
      `brain_app reads ${t}`,
    );
  }

  // ---- base tables ---------------------------------------------------------
  // objects UPDATE is column-scoped (0012): the app writes content columns but
  // may never rewrite created_by — that would let it steal a private object
  // past the RLS WITH CHECK.
  for (const priv of ["SELECT", "INSERT", "DELETE"]) {
    add(
      `brain_app can ${priv} objects`,
      await bool(client, "SELECT has_table_privilege('brain_app','objects',$1) AS v", [priv]),
      `brain_app needs ${priv} on objects`,
    );
  }
  add(
    "brain_app can UPDATE objects columns",
    await bool(client, "SELECT has_any_column_privilege('brain_app','objects','UPDATE') AS v"),
    "brain_app needs column-scoped UPDATE on objects",
  );
  add(
    "brain_app cannot UPDATE objects.created_by",
    !(await bool(
      client,
      "SELECT has_column_privilege('brain_app','objects','created_by','UPDATE') AS v",
    )),
    "rewriting created_by would defeat the private-visibility RLS",
  );

  // ---- private visibility: RLS must be FORCED (0012 enabled, 0039 forced) --
  // ENABLE alone lets the table owner (brain_owner) bypass by ownership; FORCE
  // binds even the owner. Assert BOTH so a regression that drops FORCE is caught.
  for (const t of ["objects", "edges", "before_image", "merge_journal"]) {
    add(
      `${t} has RLS enabled`,
      await bool(client, "SELECT relrowsecurity AS v FROM pg_class WHERE relname = $1", [t]),
      `${t} carries private content/structure — RLS must be enabled`,
    );
    add(
      `${t} has RLS forced`,
      await bool(client, "SELECT relforcerowsecurity AS v FROM pg_class WHERE relname = $1", [t]),
      `${t} must FORCE RLS so the table owner cannot bypass it`,
    );
  }
  // object_chunks only exists where pgvector installed; assert FORCE when present.
  {
    const present = await bool(
      client,
      "SELECT to_regclass('public.object_chunks') IS NOT NULL AS v",
    );
    if (present) {
      add(
        "object_chunks has RLS forced",
        await bool(
          client,
          "SELECT relforcerowsecurity AS v FROM pg_class WHERE relname = 'object_chunks'",
        ),
        "object_chunks embeddings mirror private bodies — FORCE RLS required",
      );
    }
  }

  // The workspace-UI content-bearing tables (0052-0054). Presence-guarded so
  // the audit stays green on a box mid-upgrade, but where a table exists its
  // FORCE flag is re-asserted — the audit's whole job is the DR-restore case,
  // where a restore that dropped FORCE on collab_docs would otherwise expose
  // every private object's full body through the CRDT blob to any brain_owner
  // session, and write_idempotency/saved_views leak ids, titles and filter
  // literals the same way.
  for (const [t, why] of [
    ["write_idempotency", "write_idempotency.result holds object ids/titles"],
    ["collab_docs", "collab_docs.blob holds full document CRDT state"],
    ["saved_views", "saved_views holds filter literals and private object ids/titles"],
  ] as const) {
    const present = await bool(client, "SELECT to_regclass($1) IS NOT NULL AS v", [`public.${t}`]);
    if (!present) continue;
    add(
      `${t} has RLS enabled`,
      await bool(client, "SELECT relrowsecurity AS v FROM pg_class WHERE relname = $1", [t]),
      `${why} — RLS must be enabled`,
    );
    add(
      `${t} has RLS forced`,
      await bool(client, "SELECT relforcerowsecurity AS v FROM pg_class WHERE relname = $1", [t]),
      `${why} — FORCE RLS so the table owner cannot bypass it`,
    );
  }

  // ---- schema create -----------------------------------------------------
  add(
    "brain_app cannot CREATE in public",
    !(await bool(client, "SELECT has_schema_privilege('brain_app','public','CREATE') AS v")),
    "brain_app must not create objects in the public schema",
  );
  add(
    "brain_app can USAGE public",
    await bool(client, "SELECT has_schema_privilege('brain_app','public','USAGE') AS v"),
    "brain_app needs schema usage",
  );

  const violations = checks.filter((c) => !c.ok);
  return { ok: violations.length === 0, checks, violations };
}
