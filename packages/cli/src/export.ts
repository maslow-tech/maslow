import type { Client } from "pg";
import { quoteIdentifier } from "@brain/shared";
import { MIGRATIONS, junctionTableName, numericCheckName, refConstraintName } from "@brain/schema";

/**
 * Export + round-trip import. The offboarding
 * exit door: an owner/operator emits the WHOLE brain as structured JSON and can
 * re-hydrate it into a FRESH box byte-for-byte.
 *
 * The import target: owner-run, triggers-disabled,
 * seq/actor/timestamp-preserving, includes before_image.
 *
 * Two load-bearing choices:
 *  - Every value is read cast to `::text` and re-inserted as a text parameter,
 *    letting each column's input function coerce it back. This bypasses the pg
 *    driver's type parsers entirely (which would, e.g., truncate a timestamptz
 *    to millisecond Date precision or reshape numerics), so timestamps/seq/tsv/
 *    jsonb round-trip verbatim.
 *  - Triggers are quiesced with `ALTER TABLE … DISABLE TRIGGER USER` (an
 *    owner-capable operation) rather than `SET session_replication_role =
 *    replica` (which is superuser-only, and the import runs as the NOSUPERUSER
 *    brain_owner so ext tables it creates stay owned by brain_owner and the
 *    privilege model survives — see runbook). USER triggers cover the whole
 *    generic invariant set (D.1/D.3/D.4/D.5/D.7 + the deletion mirror); the FK
 *    constraint triggers stay armed, so data is loaded in dependency order and
 *    ref columns are filled in a second pass (cyclic types can't self-block).
 *
 * DDL is never assembled in Node: ext tables / columns / FKs / junctions are
 * (re)created purely through the executor's server-side %I primitives. Only DML
 * uses `quoteIdentifier`.
 */

/** A generic, JSON-safe dump of one relation: column names + text|null cells. */
export interface TableDump {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
}

/** The whole-brain export envelope. All cells are text|null → JSON-safe. */
export interface BrainExport {
  readonly formatVersion: 1;
  readonly exportedAt: string;
  /** The schema catalog — drives both DDL recreation and catalog-row insertion. */
  readonly catalog: {
    readonly types: TableDump;
    readonly type_properties: TableDump;
    readonly enum_option: TableDump;
    readonly physical_name: TableDump;
  };
  readonly accounts: TableDump;
  readonly objects: TableDump;
  /** Per-type `<physical>_ext` rows, keyed by ext-table name. */
  readonly ext: Record<string, TableDump>;
  readonly edges: TableDump;
  /** Per-`ref[]` junction rows, keyed by junction-table name. */
  readonly junctions: Record<string, TableDump>;
  readonly events: TableDump;
  readonly before_image: TableDump;
  /** The brain filesystem (0037). Absent when exported from a pre-0037 brain;
   *  fs_usage is not dumped — total_bytes is recomputed from entries on import. */
  readonly fs?: {
    readonly homes: TableDump;
    readonly entries: TableDump;
    /**
     * File version history + trash (0043). Optional so a pre-0043 export still
     * imports (the table is simply left empty). It is NOT derivable from
     * `entries`: a soft-deleted file's ONLY surviving copy is its delete
     * snapshot, so dropping this table silently destroys the whole trash and
     * every prior revision — including members' private /home history, which
     * only the app.fs_dr escape makes visible to the dump.
     */
    readonly versions?: TableDump;
  };
  /**
   * Tag governance (0057). Absent when exported from a pre-0057 brain — the
   * import then mints default tags for the loaded accounts and backfills
   * `objects.audience` from the legacy visibility columns, exactly as the
   * migration does. NOT derivable from accounts once custom tags/grants exist,
   * and every stamped `audience` row references these uuids — dropping them
   * fails the whole restored brain closed.
   */
  readonly tags?: {
    readonly tags: TableDump;
    readonly account_tags: TableDump;
  };
}

// --------------------------------------------------------------------------- read helpers

/** Live (non-dropped, non-generated) columns of a public table, in attnum order. */
async function tableColumns(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT a.attname AS name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY a.attnum`,
    [table],
  );
  return rows.map((r) => r.name);
}

/**
 * Dump a whole relation. Each column is cast to `::text` so the pg driver hands
 * us the exact text representation (no type-parser reshaping); NULL stays null.
 */
async function dumpTable(
  client: Client,
  table: string,
  orderBy: readonly string[],
): Promise<TableDump> {
  const columns = await tableColumns(client, table);
  const selectList = columns
    .map((c) => `(${quoteIdentifier(c)})::text AS ${quoteIdentifier(c)}`)
    .join(", ");
  const order = orderBy.length > 0 ? ` ORDER BY ${orderBy.map(quoteIdentifier).join(", ")}` : "";
  const { rows } = await client.query<Record<string, string | null>>(
    `SELECT ${selectList} FROM ${quoteIdentifier(table)}${order}`,
  );
  return { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) };
}

// --------------------------------------------------------------------------- export

/**
 * Emit the entire brain. Runs in a read-only REPEATABLE READ snapshot so the
 * dump is internally consistent even under concurrent writes. `ownerClient`
 * must be a brain_owner connection (owner sees every row — no RLS, and
 * soft-deleted rows are included).
 */
export async function exportBrain(ownerClient: Client): Promise<BrainExport> {
  await ownerClient.query("BEGIN");
  try {
    await ownerClient.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    // Deterministic, offset-stable timestamp text in the export.
    await ownerClient.query("SET TIME ZONE 'UTC'");
    // fs_entries has FORCE RLS, which binds even brain_owner — members' home
    // rows would silently vanish from the dump (and row_security=off ERRORS
    // for the owner of a FORCE table). The 0037 policy carves one explicit
    // escape for exactly this: brain_owner + app.fs_dr, txn-local.
    await ownerClient.query("SET LOCAL app.fs_dr = 'on'");

    const catalog = {
      types: await dumpTable(ownerClient, "types", ["id"]),
      type_properties: await dumpTable(ownerClient, "type_properties", ["id"]),
      enum_option: await dumpTable(ownerClient, "enum_option", ["id"]),
      physical_name: await dumpTable(ownerClient, "physical_name", ["name"]),
    };

    // Discover ext tables (types.ext_table) and junctions (ref[] properties).
    const types = asRecords(catalog.types);
    const props = asRecords(catalog.type_properties);
    const physByType = new Map<string, string>(); // type_id -> physical_name
    for (const t of types) physByType.set(req(t.id), req(t.physical_name));

    const ext: Record<string, TableDump> = {};
    for (const t of types) {
      const extTable = req(t.ext_table);
      ext[extTable] = await dumpTable(ownerClient, extTable, ["id"]);
    }

    const junctions: Record<string, TableDump> = {};
    for (const p of props) {
      if (p.kind !== "ref[]") continue;
      const junction = junctionTableName(physByType.get(req(p.type_id))!, req(p.physical_name));
      junctions[junction] = await dumpTable(ownerClient, junction, ["from_id", "to_id"]);
    }

    // Guarded: a pre-0037 brain has no filesystem to dump, and a pre-0043 one
    // has no version history table.
    const { rows: fsReg } = await ownerClient.query<{ ok: boolean; vc: boolean }>(
      `SELECT to_regclass('public.fs_entries') IS NOT NULL AS ok,
              to_regclass('public.fs_versions') IS NOT NULL AS vc`,
    );
    const hasFs = fsReg[0]?.ok === true;
    const hasFsVersions = fsReg[0]?.vc === true;
    // Guarded: a pre-0057 brain has no tag governance tables.
    const { rows: tagReg } = await ownerClient.query<{ ok: boolean }>(
      `SELECT to_regclass('public.tags') IS NOT NULL AS ok`,
    );
    const hasTags = tagReg[0]?.ok === true;

    const out: BrainExport = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      catalog,
      accounts: await dumpTable(ownerClient, "accounts", ["created_at", "id"]),
      objects: await dumpTable(ownerClient, "objects", ["created_at", "id"]),
      ext,
      edges: await dumpTable(ownerClient, "edges", ["from_id", "rel", "to_id"]),
      junctions,
      events: await dumpTable(ownerClient, "events", ["seq"]),
      before_image: await dumpTable(ownerClient, "before_image", ["id"]),
      ...(hasFs
        ? {
            fs: {
              homes: await dumpTable(ownerClient, "fs_homes", ["slug"]),
              // path order (COLLATE "C") = parent-first — the import relies on it
              entries: await dumpTable(ownerClient, "fs_entries", ["path"]),
              // 0043 history/trash. `content bytea` casts to the `\x…` hex
              // literal, which bytea's input function re-parses on reload, so
              // the generic ::text dump round-trips binary snapshots verbatim
              // (same path fs_entries.content already takes). The app.fs_dr
              // escape set above is what makes members' home snapshots
              // visible here — without it FORCE RLS would drop them silently.
              ...(hasFsVersions
                ? { versions: await dumpTable(ownerClient, "fs_versions", ["path", "version_no"]) }
                : {}),
            },
          }
        : {}),
      ...(hasTags
        ? {
            tags: {
              tags: await dumpTable(ownerClient, "tags", ["slug"]),
              account_tags: await dumpTable(ownerClient, "account_tags", ["tag_id", "account_id"]),
            },
          }
        : {}),
    };
    await ownerClient.query("COMMIT");
    return out;
  } catch (err) {
    await ownerClient.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

// --------------------------------------------------------------------------- import helpers

/** Turn a TableDump into keyed records for structured (catalog) access. */
function asRecords(dump: TableDump): Record<string, string | null>[] {
  return dump.rows.map((row) => {
    const o: Record<string, string | null> = {};
    dump.columns.forEach((c, i) => {
      o[c] = row[i] ?? null;
    });
    return o;
  });
}

/** A required text cell (catalog fields we know are non-null). */
function req(v: string | null | undefined): string {
  if (v === null || v === undefined) {
    throw new Error("export: unexpected null in a required catalog field");
  }
  return v;
}

/** Insert every dumped row (one prepared statement, reused per row). */
async function insertRows(
  client: Client,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
  overriding: boolean,
): Promise<void> {
  if (rows.length === 0 || columns.length === 0) return;
  const colList = columns.map(quoteIdentifier).join(", ");
  const ov = overriding ? " OVERRIDING SYSTEM VALUE" : "";
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${colList})${ov} VALUES (${placeholders})`;
  for (const row of rows) {
    await client.query(sql, row as unknown[]);
  }
}

interface CatalogType {
  readonly id: number;
  readonly physicalName: string;
  readonly extTable: string;
}
interface CatalogProp {
  readonly id: number;
  readonly typeId: number;
  readonly physicalName: string;
  readonly kind: string;
  readonly refTypeId: number | null;
}

/** All GENERATED ALWAYS AS IDENTITY columns in the target DB → {table: [cols]}. */
async function identityColumns(client: Client): Promise<Map<string, string[]>> {
  const { rows } = await client.query<{ tbl: string; col: string }>(
    `SELECT c.relname AS tbl, a.attname AS col
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND a.attidentity = 'a'
        AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.tbl, [...(m.get(r.tbl) ?? []), r.col]);
  return m;
}

// --------------------------------------------------------------------------- import

/**
 * Re-hydrate an export into a FRESH brain (infra migrations already applied, no
 * user types yet). `ownerClient` must be a brain_owner connection. One
 * transaction: recreate the catalog + DDL, quiesce user triggers, bulk-load
 * every relation preserving ids/seq/actor/timestamps/tsv, then re-arm triggers
 * and advance the identity sequences.
 */
export async function importBrain(ownerClient: Client, data: BrainExport): Promise<void> {
  const identity = await identityColumns(ownerClient);
  const hasIdentity = (t: string): boolean => (identity.get(t)?.length ?? 0) > 0;

  // Parse the catalog into the structures the DDL recreation needs.
  const typeById = new Map<number, CatalogType>();
  for (const t of asRecords(data.catalog.types)) {
    const id = Number(req(t.id));
    typeById.set(id, { id, physicalName: req(t.physical_name), extTable: req(t.ext_table) });
  }
  const propsByType = new Map<number, CatalogProp[]>();
  for (const p of asRecords(data.catalog.type_properties)) {
    const typeId = Number(req(p.type_id));
    const refType = p.ref_type_id;
    const prop: CatalogProp = {
      id: Number(req(p.id)),
      typeId,
      physicalName: req(p.physical_name),
      kind: req(p.kind),
      refTypeId: refType === null || refType === undefined ? null : Number(refType),
    };
    propsByType.set(typeId, [...(propsByType.get(typeId) ?? []), prop]);
  }
  const typeOrder = [...typeById.values()].sort((a, b) => a.id - b.id);
  const extTables = typeOrder.map((t) => t.extTable);

  await ownerClient.query("BEGIN");
  try {
    await ownerClient.query("SET TIME ZONE 'UTC'");
    // fs_entries has FORCE RLS; brain_owner must see, delete, and re-insert
    // members' home rows during the reload — the 0037 DR escape, txn-local.
    await ownerClient.query("SET LOCAL app.fs_dr = 'on'");

    // ---- 1. catalog rows (FK-safe order, ids preserved) -------------------
    await insertRows(
      ownerClient,
      "types",
      data.catalog.types.columns,
      data.catalog.types.rows,
      hasIdentity("types"),
    );
    await insertRows(
      ownerClient,
      "type_properties",
      data.catalog.type_properties.columns,
      data.catalog.type_properties.rows,
      hasIdentity("type_properties"),
    );
    await insertRows(
      ownerClient,
      "enum_option",
      data.catalog.enum_option.columns,
      data.catalog.enum_option.rows,
      hasIdentity("enum_option"),
    );
    await insertRows(
      ownerClient,
      "physical_name",
      data.catalog.physical_name.columns,
      data.catalog.physical_name.rows,
      hasIdentity("physical_name"),
    );

    // ---- 2. ext tables + scalar/enum/ref columns (via %I primitives) ------
    for (const t of typeOrder) {
      await ownerClient.query("SELECT brain_create_ext_table($1)", [t.extTable]);
      await ownerClient.query("SELECT brain_grant_app($1)", [t.extTable]);
      await ownerClient.query("SELECT brain_attach_ext_triggers($1, $2)", [t.extTable, t.id]);
      for (const p of sortById(propsByType.get(t.id))) {
        if (p.kind === "ref[]") continue; // junction, no column
        // ref → uuid column now; its FK is added in phase 3 (after all ext tables).
        await ownerClient.query("SELECT brain_add_column($1, $2, $3)", [
          t.extTable,
          p.physicalName,
          p.kind,
        ]);
        if (p.kind === "decimal" || p.kind === "float") {
          await ownerClient.query("SELECT brain_add_numeric_check($1, $2, $3)", [
            t.extTable,
            p.physicalName,
            numericCheckName(t.physicalName, p.physicalName),
          ]);
        }
      }
    }

    // ---- 3. refs + junctions (all ext tables now exist → cyclic-safe) -----
    for (const t of typeOrder) {
      for (const p of sortById(propsByType.get(t.id))) {
        const targetExt = p.refTypeId === null ? null : typeById.get(p.refTypeId)?.extTable;
        if (p.kind === "ref") {
          const fk = refConstraintName(t.physicalName, p.physicalName);
          await ownerClient.query("SELECT brain_add_ref_fk($1, $2, $3, $4)", [
            t.extTable,
            fk,
            p.physicalName,
            targetExt,
          ]);
          await ownerClient.query("SELECT brain_validate_constraint($1, $2)", [t.extTable, fk]);
        } else if (p.kind === "ref[]") {
          const junction = junctionTableName(t.physicalName, p.physicalName);
          await ownerClient.query("SELECT brain_create_junction($1, $2, $3)", [
            junction,
            t.extTable,
            targetExt,
          ]);
          await ownerClient.query("SELECT brain_grant_app($1)", [junction]);
        }
      }
    }

    // ---- 4. quiesce user triggers on objects + edges + every ext table ----
    // (audit D.3, tsv D.5, enum D.4, biconditional D.1, soft-delete D.7,
    // deletion mirror, and the D.2 ref-edge guard on `edges` — the export
    // includes ref:% edges verbatim, so the guard must not reject the reload).
    // FK constraint triggers stay armed → dependency order. `accounts` is in
    // the list for 0057's mint-default-tags trigger: the source's tag rows
    // load verbatim below, and letting the trigger mint fresh-uuid tags for
    // every reloaded account would collide with them on slug.
    const quiesced = ["accounts", "objects", "edges", ...extTables];
    for (const tbl of quiesced) {
      await ownerClient.query(`ALTER TABLE ${quoteIdentifier(tbl)} DISABLE TRIGGER USER`);
    }

    // ---- 5. bulk-load data, preserving everything verbatim ----------------
    // The filesystem hangs off accounts (fs_homes.actor_id, fs_entries
    // created_by/updated_by): the fresh box's 0037-seeded tree must go before
    // the accounts swap, and the source's tree reloads in step 5b. Guarded —
    // a pre-0037 target has no filesystem tables.
    const { rows: fsReg } = await ownerClient.query<{ ok: boolean; vc: boolean }>(
      `SELECT to_regclass('public.fs_entries') IS NOT NULL AS ok,
              to_regclass('public.fs_versions') IS NOT NULL AS vc`,
    );
    const hasFs = fsReg[0]?.ok === true;
    const hasFsVersions = fsReg[0]?.vc === true;
    if (hasFs) {
      // fs_versions.edited_by/owner_id are FKs to accounts — it must be
      // emptied before the accounts swap below or the DELETE is blocked.
      if (hasFsVersions) await ownerClient.query("DELETE FROM fs_versions");
      await ownerClient.query("DELETE FROM fs_entries");
      await ownerClient.query("DELETE FROM fs_homes");
    }
    // Tag governance (0057): tags.account_id is a non-cascading FK to
    // accounts, so the target's minted tags must go before the accounts swap.
    // Writes on the tag tables have NO RLS policy (governance-fn-only by
    // design), so the reload runs as brain_system (BYPASSRLS + granted DML) —
    // the same role the migration's own mint step uses.
    const { rows: tagReg } = await ownerClient.query<{ ok: boolean }>(
      `SELECT to_regclass('public.tags') IS NOT NULL AS ok`,
    );
    const hasTags = tagReg[0]?.ok === true;
    if (hasTags) {
      await ownerClient.query("SET LOCAL ROLE brain_system");
      await ownerClient.query("DELETE FROM account_tags");
      await ownerClient.query("DELETE FROM tags");
      await ownerClient.query("RESET ROLE");
    }
    // accounts: the fresh brain seeds a 'system' row; drop it so the source's
    // accounts (incl. that same system id) load faithfully.
    await ownerClient.query("DELETE FROM accounts");
    await insertRows(
      ownerClient,
      "accounts",
      data.accounts.columns,
      data.accounts.rows,
      hasIdentity("accounts"),
    );
    await insertRows(
      ownerClient,
      "objects",
      data.objects.columns,
      data.objects.rows,
      hasIdentity("objects"),
    );
    if (hasTags) {
      await ownerClient.query("SET LOCAL ROLE brain_system");
      if (data.tags) {
        await insertRows(ownerClient, "tags", data.tags.tags.columns, data.tags.tags.rows, false);
        await insertRows(
          ownerClient,
          "account_tags",
          data.tags.account_tags.columns,
          data.tags.account_tags.rows,
          false,
        );
      } else {
        // A pre-0057 dump restoring into a post-0057 target: mint default tags
        // for the loaded accounts and compile the legacy visibility columns to
        // audience — the same SQL as the migration's mint + backfill (which the
        // ledger will never re-run here). Without this every restored row fails
        // closed: no one holds any tag. objects' user triggers are quiesced, so
        // the backfill UPDATE cannot flood the timeline.
        await ownerClient.query(
          `INSERT INTO tags (slug, kind) VALUES ('maslow-org', 'org') ON CONFLICT DO NOTHING`,
        );
        await ownerClient.query(
          `INSERT INTO tags (slug, kind, account_id)
             SELECT 'person-' || left(a.id::text, 8), 'personal', a.id FROM accounts a
             ON CONFLICT DO NOTHING`,
        );
        await ownerClient.query(
          `INSERT INTO account_tags (tag_id, account_id)
             SELECT t.id, t.account_id FROM tags t WHERE t.kind = 'personal'
             ON CONFLICT DO NOTHING`,
        );
        await ownerClient.query(
          `INSERT INTO account_tags (tag_id, account_id)
             SELECT (SELECT id FROM tags WHERE kind = 'org'), a.id FROM accounts a
             ON CONFLICT DO NOTHING`,
        );
        await ownerClient.query(
          `UPDATE objects o SET audience = jsonb_build_array(jsonb_build_array(
               (SELECT id::text FROM tags WHERE kind = 'org')))
             WHERE o.visibility = 'org' AND o.audience = '[]'::jsonb`,
        );
        await ownerClient.query(
          `UPDATE objects o SET audience = COALESCE((
               SELECT jsonb_agg(jsonb_build_array(t.id::text))
               FROM tags t
               WHERE t.kind = 'personal'
                 AND (t.account_id = o.created_by OR t.account_id = ANY(o.shared_with))
             ), '[]'::jsonb)
             WHERE o.visibility = 'private' AND o.audience = '[]'::jsonb`,
        );
      }
      await ownerClient.query("RESET ROLE");
    }

    // ext rows in two passes so ref columns (real FKs) can point anywhere,
    // including cyclic/self references: pass 1 loads every non-ref column,
    // pass 2 fills the ref columns once all ext rows exist.
    const refColsByExt = new Map<string, Set<string>>();
    for (const t of typeOrder) {
      const refCols = new Set(
        sortById(propsByType.get(t.id))
          .filter((p) => p.kind === "ref")
          .map((p) => p.physicalName),
      );
      refColsByExt.set(t.extTable, refCols);
    }
    for (const t of typeOrder) {
      const dump = data.ext[t.extTable];
      if (!dump) continue;
      const refCols = refColsByExt.get(t.extTable)!;
      const keep = dump.columns.map((c, i) => ({ c, i })).filter((x) => !refCols.has(x.c));
      await insertRows(
        ownerClient,
        t.extTable,
        keep.map((x) => x.c),
        dump.rows.map((row) => keep.map((x) => row[x.i] ?? null)),
        false,
      );
    }
    for (const t of typeOrder) {
      const dump = data.ext[t.extTable];
      if (!dump) continue;
      const refCols = refColsByExt.get(t.extTable)!;
      const refIdx = dump.columns.map((c, i) => ({ c, i })).filter((x) => refCols.has(x.c));
      if (refIdx.length === 0) continue;
      const idIdx = dump.columns.indexOf("id");
      for (const row of dump.rows) {
        const sets = refIdx.map((x, k) => `${quoteIdentifier(x.c)} = $${k + 2}`).join(", ");
        await ownerClient.query(
          `UPDATE ${quoteIdentifier(t.extTable)} SET ${sets} WHERE "id" = $1`,
          [row[idIdx] ?? null, ...refIdx.map((x) => row[x.i] ?? null)],
        );
      }
    }

    await insertRows(
      ownerClient,
      "edges",
      data.edges.columns,
      data.edges.rows,
      hasIdentity("edges"),
    );
    for (const [junction, dump] of Object.entries(data.junctions)) {
      await insertRows(ownerClient, junction, dump.columns, dump.rows, hasIdentity(junction));
    }
    // events + before_image: preserve seq / id via OVERRIDING SYSTEM VALUE.
    await insertRows(
      ownerClient,
      "events",
      data.events.columns,
      data.events.rows,
      hasIdentity("events"),
    );
    await insertRows(
      ownerClient,
      "before_image",
      data.before_image.columns,
      data.before_image.rows,
      hasIdentity("before_image"),
    );

    // ---- 5b. the filesystem ----------------------------------------------
    // fs triggers stay armed throughout: homes load first (fs_pin_owner
    // resolves slugs against them) and entries arrive in path order, so a
    // parent always precedes its children for fs_assert_parent.
    if (hasFs) {
      if (data.fs) {
        await insertRows(ownerClient, "fs_homes", data.fs.homes.columns, data.fs.homes.rows, false);
        await insertRows(
          ownerClient,
          "fs_entries",
          data.fs.entries.columns,
          data.fs.entries.rows,
          false,
        );
        // History/trash last: fs_versions has no FK to fs_entries (a delete
        // snapshot outlives its row by design) but it does reference accounts,
        // which are already in. Still inside the app.fs_dr escape — FORCE RLS
        // would otherwise reject every home-owned snapshot. Absent key = a
        // pre-0043 export: leave the table empty rather than erroring.
        if (hasFsVersions && data.fs.versions) {
          await insertRows(
            ownerClient,
            "fs_versions",
            data.fs.versions.columns,
            data.fs.versions.rows,
            false,
          );
        }
        await ownerClient.query(
          `UPDATE fs_usage SET total_bytes =
             coalesce((SELECT sum(size_bytes) FROM fs_entries WHERE kind = 'file'), 0)`,
        );
      } else {
        // A pre-0037 export: re-run 0037's guarded backfill + seed (idempotent
        // by migration doctrine) so the imported accounts get home slugs and
        // the /shared skeleton comes back.
        const mFs = MIGRATIONS.find((m) => m.version === "0037");
        if (mFs) await ownerClient.query(mFs.sql);
      }
    }

    // ---- 6. re-arm triggers + advance identity sequences past the max -----
    for (const tbl of quiesced) {
      await ownerClient.query(`ALTER TABLE ${quoteIdentifier(tbl)} ENABLE TRIGGER USER`);
    }
    for (const [tbl, cols] of identity) {
      for (const col of cols) {
        await ownerClient.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), s.mx)
             FROM (SELECT max(${quoteIdentifier(col)}) AS mx FROM ${quoteIdentifier(tbl)}) s
            WHERE s.mx IS NOT NULL`,
          [tbl, col],
        );
      }
    }

    await ownerClient.query("COMMIT");
  } catch (err) {
    await ownerClient.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

/** Stable property order (creation order == ascending id). */
function sortById(props: CatalogProp[] | undefined): CatalogProp[] {
  return [...(props ?? [])].sort((a, b) => a.id - b.id);
}
