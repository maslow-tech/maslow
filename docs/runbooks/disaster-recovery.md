# Disaster recovery restore

Rebuild a box from a logical dump or a cross-version restore, or complete a
PITR rewind (`pitr.md`). The invariant this runbook protects: recovery must
not reopen privilege escalation, and must not resurrect auth state (tokens)
that was revoked after the restore point.

> Scope. For a logical mistake, prefer PITR (`pitr.md`, RPO ~60s); a
> pgBackRest repo sits behind it, with fulls taken every 12h by the `backup`
> compose sidecar. This runbook covers a rebuild from a dump (physical repo
> unusable, cross-version move) and the auth reconciliation half of any
> restore. Whole-volume loss is bounded by your last block-level volume
> snapshot; an off-box copy is a deliberate extra stage if you build one.

---

## Order matters: globals first, then the database, then the audit

A `pg_dump` of the `brain` database carries table ownership and grants (the
entire least-privilege model), but it does not carry the roles themselves;
roles are cluster-global. Restore them first, or the database restore's
`ALTER ... OWNER TO brain_owner` and `GRANT ... TO brain_app` fail and you
end up with objects owned by the superuser, which silently reopens
escalation.

### 1. Capture the dumps (on the source box, or from your backup artifacts)

```bash
# Roles + grants + role attributes (the "globals") — cluster-wide.
pg_dumpall -U postgres --globals-only > globals.sql

# The brain database itself, with ownership + ACLs. --create so the restore
# recreates the DB owned by brain_owner on the fresh cluster.
pg_dump -U postgres --create --format=plain -d brain > brain.sql
```

> `-U postgres` is load-bearing. Content tables are `FORCE ROW LEVEL
> SECURITY`, so a dump taken as `brain_owner` either errors with _"query
> would be affected by row-level security policy"_ or, on the tables where it
> does not error, silently produces a partial brain. Only the superuser (or a
> `SET ROLE brain_system` inside one transaction, which `pg_dump` will not do
> for you) sees every row.
>
> `globals.sql` contains role password hashes. Treat the dump as a secret: it
> is your team's data plus credentials. It must never leave the box, and it
> must never be swept into a deploy tarball, a bundle, or a docker image.

(For a physical/pgBackRest restore instead of a logical dump, follow
`pitr.md` to stand the cluster up, then skip to step 4. The reconciliation
and audit apply to every restore, logical or physical.)

Before any risky operation, take a physical full instead of hand-rolling a
dump. It is faster, it is verified by the same machinery that will restore
it, and it is what the PITR window is anchored on:

```bash
cd /opt/brain/deploy && docker compose exec backup /usr/local/bin/brain-backup.sh now
```

### 2. Restore the globals into the fresh cluster, before the database

```bash
psql -U postgres -f globals.sql
```

This recreates `brain_owner`, `brain_app`, `brain_external` with their exact
attributes (`NOSUPERUSER`, `NOBYPASSRLS`, `brain_external NOLOGIN`, etc.).

### 3. Restore the database into brain_owner ownership

```bash
psql -U postgres -f brain.sql
```

Because globals ran first, every `ALTER TABLE ... OWNER TO brain_owner` and
`GRANT ... TO brain_app` resolves. The catalog tables land SELECT-only for
`brain_app`, `accounts` keeps its column-level REVOKEs, and `events` stays
INSERT-less for `brain_app` (written only by the `SECURITY DEFINER` trigger).

> The brain's own executor/import path (`packages/cli` import) deliberately
> runs DDL as `brain_owner` so recreated `<type>_ext` tables are owned by
> `brain_owner` (see `export-import.md`). A superuser-run restore would leave
> ext tables owned by `postgres` and break the ownership invariant; the audit
> in step 5 catches that.

### 4. Post-restore auth reconciliation, before reopening the box

A restore rewinds auth state. Anything done to auth after the restore point
must be re-applied, or a revoked credential comes back to life. Fail closed
for auth: when in doubt, invalidate.

1. Establish the restore point `R`: the wall-clock time the restored data
   reflects (the PITR target, or the dump's snapshot time). Use UTC.

2. Re-mint all member tokens and force OAuth re-auth. Treat every member
   credential as suspect after a restore. Rotate them from the dashboard
   (owner member-admin), and invalidate live OAuth refresh families so MCP
   client sessions must re-authenticate. A token that existed at `R` may
   since have been legitimately rotated; the restore doesn't know that, so
   re-mint rather than trust the restored `token_hash`.

3. Re-assert any revocations made after `R`. If you revoked a member or a
   token between `R` and now, revoke it again on the restored box; the
   restore resurrected it. Check your own records (audit log exports, admin
   notes) for anything auth-related in that window:

   ```sql
   -- for each credential known to be revoked after R:
   UPDATE accounts
      SET status = 'revoked', revoked_at = greatest(revoked_at, :revocation_ts)
    WHERE token_hash = :revoked_token_hash;
   ```

4. If you run the optional fleet control plane, re-apply its state as well:
   pull its revocation ledger for entries after `R`, re-sync the
   anti-rollback version floor (`effective_floor = max(local, control-plane)`),
   and re-read its kill/enable state. A restore must never resurrect a box
   that was deliberately disabled. Do not reopen to members while the control
   plane is unreachable.

### 5. Re-assert the least-privilege model: the audit is the gate

The restore is finished only when the privilege model is proven intact. Run
`auditPrivileges` from `@brain/schema` on a superuser connection to the
restored `brain`:

```ts
import { Client } from "pg";
import { auditPrivileges } from "@brain/schema";

const su = new Client({ host, port, user: "postgres", password, database: "brain" });
await su.connect();
const audit = await auditPrivileges(su);
if (!audit.ok) {
  // recovery re-opened escalation — do NOT reopen the box.
  throw new Error(
    "privilege model did not survive the restore:\n" +
      audit.violations.map((v) => ` - ${v.name}: ${v.detail}`).join("\n"),
  );
}
await su.end();
```

`auditPrivileges` asserts the exact model: `brain_app` is
`NOSUPERUSER`/`NOBYPASSRLS`, owns no tables; cannot `INSERT`/`DELETE accounts`
nor `UPDATE accounts.{role,status,token_hash}`; cannot
`INSERT/UPDATE/DELETE events`; is SELECT-only on the schema catalog
(`types`, `type_properties`, `enum_option`, `physical_name`); has full DML on
`objects`; and cannot `CREATE` in `public`. If any check fails, the restore
silently reopened escalation. Stop and fix ownership/grants before the box
takes traffic.

### 6. Reopen

Only after 4 (reconciliation) and 5 (audit green): start `app` + `updater`,
run the drift reconciler in report-only mode first, then let members back in.

---

## Failure modes / gotchas

- Database restored before globals: objects owned by `postgres`, and
  `auditPrivileges` fails its "owned by brain_owner" checks. Re-run in order.
- Superuser-run object DDL: ext tables owned by `postgres`; same audit
  failure. The restore must resolve ownership to `brain_owner`.
- Skipped reconciliation: a token you revoked yesterday works again. Do not
  skip step 4.
- Dump taken as `brain_owner`: a silently partial brain (FORCE RLS hides
  rows from the owner). Take dumps with `-U postgres`, always.
