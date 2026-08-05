# Export and round-trip import

`exportBrain` emits the whole brain as structured JSON; `importBrain`
re-hydrates it into a freshly provisioned box byte-for-byte. Use it to
offboard a box, move hosts, or keep a portable, inspectable copy alongside
the physical backups.

---

## What export captures

`exportBrain(ownerClient)` returns a `BrainExport`: a single JSON-safe
envelope holding every row of the brain, read on a `brain_owner` connection
inside a read-only `REPEATABLE READ` snapshot (internally consistent under
concurrent writes). Every value is read cast to `::text`, so the pg driver's
type parsers never reshape it (no timestamptz-to-millisecond truncation, no
numeric reshaping); timestamps, `events.seq`, `tsv`, and `jsonb` round-trip
exactly.

It includes:

- `objects`, including soft-deleted rows (`deleted_at`/`deleted_by`
  preserved).
- `edges`: the graph (`provenance` `manual` / `ref:<col>`).
- `events`: the append-only audit log with `seq`, `actor`, and `at`
  preserved.
- `before_image`: the history/revert snapshots (`id` preserved).
- the schema catalog: `types`, `type_properties`, `enum_option`,
  `physical_name`.
- `accounts`: local members.
- per-type `<physical>_ext` rows (discovered from `types.ext_table`) and
  every `ref[]` junction table's rows (discovered from the `ref[]`
  properties).
- the filesystem: `fs_homes` (each member's home slug) and `fs_entries` (the
  whole tree: `/shared` plus every member's private `/home`, contents, sizes
  and locks). `fs_usage` is not dumped; `total_bytes` is recomputed from the
  reloaded entries on import.
- file version history and the recoverable trash: `fs_versions`, i.e. every
  prior revision of every file and every soft-deleted file. This one is not
  derivable from anything else: a deleted file's only surviving copy is its
  delete snapshot, so an export that skipped it would destroy the whole
  trash. Present as `fs.versions`; an export from an older schema omits the
  key and imports with the table left empty.

> Both filesystem dumps are read under the `app.fs_dr` escape the exporter
> sets for the duration of the snapshot. `fs_entries`/`fs_versions` carry
> FORCE RLS, which binds even `brain_owner`, so without the escape members'
> private `/home` rows and snapshots would silently vanish from the export.
> The import re-hydrates them under the same escape. RLS applies normally
> afterwards: on the restored box a member still cannot see another member's
> home history.

## Operator flow

1. Export (source box, owner connection over the local socket):

   ```ts
   import { exportBrain } from "@brain/cli";
   const data = await exportBrain(ownerClient);
   fs.writeFileSync("brain-export.json", JSON.stringify(data));
   ```

   A self-contained `pg_dump` may be taken alongside as a belt-and-braces
   physical copy; the JSON export is the portable, inspectable form.

2. Provision a fresh box the normal way: roles bootstrapped and infra
   migrations applied (`objects`/catalog/events/recovery tables exist), but
   no user types defined yet. This is what `createFreshBrain()` produces.

3. Import (target box, owner connection):

   ```ts
   import { importBrain } from "@brain/cli";
   await importBrain(ownerClient, JSON.parse(fs.readFileSync("brain-export.json", "utf8")));
   ```

   In one transaction, `importBrain`:

   - recreates the schema catalog rows preserving ids
     (`INSERT … OVERRIDING SYSTEM VALUE`);
   - recreates each `<type>_ext` table, its triggers, columns, ref FKs, and
     `ref[]` junctions exclusively through the server-side executor
     primitives (`brain_create_ext_table`, `brain_grant_app`,
     `brain_attach_ext_triggers`, `brain_add_column`,
     `brain_add_numeric_check`, `brain_add_ref_fk` +
     `brain_validate_constraint`, `brain_create_junction`); no DDL text is
     ever assembled in Node. Refs and junctions are created after all ext
     tables exist, so cyclic types work;
   - quiesces the generic invariant triggers, bulk-loads every relation
     preserving ids/`seq`/`actor`/timestamps/`tsv` verbatim, then re-arms
     the triggers and advances the identity sequences past the imported max.

4. Verify the restore re-asserts the least-privilege model:

   ```ts
   import { auditPrivileges } from "@brain/schema";
   const audit = await auditPrivileges(ownerClient);
   if (!audit.ok) throw new Error("privilege model did not survive the restore");
   ```

   A restore that silently reopens escalation is a security bug.

---

## Implementation note: how triggers are disabled

The import needs a triggers-disabled bulk load so the
audit/tsv/biconditional/enum invariant triggers don't fire and
`seq`/`actor`/timestamps/`tsv` are written verbatim. The canonical Postgres
mechanism for that is `SET session_replication_role = replica`.

That GUC is superuser-only. The import is deliberately owner-run (a
`brain_owner`, `NOSUPERUSER` connection) so that the ext tables it
(re)creates are owned by `brain_owner` and the privilege model survives;
running the DDL primitives as a superuser would leave the ext tables owned
by `postgres` and break the ownership invariant. A `NOSUPERUSER` role cannot
set `session_replication_role`, nor `DISABLE TRIGGER ALL` (both are
superuser-gated).

`importBrain` instead uses `ALTER TABLE … DISABLE TRIGGER USER` on `objects`
and every `<type>_ext` table (an operation the table owner may perform)
around the bulk load, then `ENABLE TRIGGER USER`. This disables the entire
generic invariant set (biconditional, audit, enum, tsv, soft-delete, and the
deletion mirror) while keeping the load owner-run.

The trade-off: the foreign-key constraint triggers stay armed (only a
superuser could disable those). `importBrain` therefore loads data in
dependency order (`accounts → objects → ext → edges → junctions → events →
before_image → fs_homes → fs_entries → fs_versions`) and fills `ref` columns
in a second pass after all ext rows exist, so even cyclic or
self-referential types load without a transient FK violation.

The filesystem tail is ordered for the same reason, and its triggers stay
armed throughout (they are cheap and keep the tree self-consistent):
`fs_homes` first so `fs_pin_owner` can resolve slugs, then `fs_entries` in
`path` order so a parent always precedes its children for
`fs_assert_parent`, then `fs_versions`, which has no FK to `fs_entries` (a
delete snapshot deliberately outlives its row) but does reference
`accounts`, already loaded. Symmetrically, the pre-load clear must
`DELETE FROM fs_versions` before `DELETE FROM accounts`, or its `edited_by`
/ `owner_id` FKs block the accounts swap.

---

## Export is not a redaction tool

Export/import moves the brain wholesale. There is no per-subject erasure:
`before_image` history and backups retain content, and an export carries
every soft-deleted row and every historical snapshot with it. This mechanism
gives no GDPR/CCPA deletion guarantee. If you need a subset or a redacted
export, that is a separate capability; do not represent the whole-brain
export as satisfying a right-to-erasure request.
