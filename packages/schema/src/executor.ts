import type { Client } from "pg";
import {
  BrainError,
  deriveIdentifier,
  isBrainError,
  notFoundError,
  refusedError,
  sanitizeIdentifier,
  schemaError,
  validationError,
} from "@brain/shared";

export const PROPERTY_KINDS = [
  "text",
  "int",
  "decimal",
  "float",
  "bool",
  "date",
  "timestamp",
  "enum",
  "ref",
  "ref[]",
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

export interface SchemaBudget {
  readonly maxTypes: number;
  readonly maxPropertiesPerType: number;
  readonly maxEnumValues: number;
}
export const DEFAULT_SCHEMA_BUDGET: SchemaBudget = {
  maxTypes: 200,
  maxPropertiesPerType: 100,
  maxEnumValues: 100,
};

/**
 * The schema executor. ONE code path, on a dedicated
 * brain_owner connection, wraps DDL + catalog + event per change, serialized by
 * pg_advisory_xact_lock. It never emits DDL text itself — it calls the
 * brain_owner PL/pgSQL primitives (migration 0002) with sanitized identifier
 * parameters. Attacker literals never reach DDL: the sanitizer rejects them
 * Node-side, and %I quoting fences them server-side.
 *
 * The mechanics + a minimal internal define_type came first; the agent-facing
 * surface (define_type public, add_property, set_type, enum, budgets, cyclic
 * ordering) and the operator ops layer on top of them.
 */

const EXECUTOR_ADVISORY_LOCK = 4243434343;

/** Deterministic derived names (collision-free, registered). */
export function extTableName(physical: string): string {
  return deriveIdentifier([physical, "ext"]);
}
export function refConstraintName(physical: string, prop: string): string {
  return deriveIdentifier([physical, prop, "fk"]);
}
export function numericCheckName(physical: string, prop: string): string {
  return deriveIdentifier([physical, prop, "numchk"]);
}
export function junctionTableName(physical: string, prop: string): string {
  return deriveIdentifier([physical, prop, "j"]);
}

export interface DefineTypeInput {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  /** an emoji icon; if omitted, one is derived from the name. */
  readonly icon?: string;
}

/** Name-keyword → emoji, mirroring migration 0022's backfill, so a type
 *  defined after the migration gets a fitting icon instead of the fallback. */
export function deriveTypeIcon(name: string): string {
  const n = name.toLowerCase();
  const table: ReadonlyArray<[RegExp, string]> = [
    [/person|people|contact|member|employee|teammate|user|lead/, "👤"],
    [/client|customer|account|company|organization|org|vendor|partner/, "🏢"],
    [/agency|agencies|government/, "🏛️"],
    [/deal|opportunity|pipeline|sale/, "🤝"],
    [/contract|award|agreement/, "📜"],
    [/task|todo|to_do|action|ticket|work_item|issue|bug/, "✅"],
    [/decision/, "⚖️"],
    [/meeting|interaction|call|event|touchpoint|conversation/, "📅"],
    [/doc|document|file|attachment|template/, "📄"],
    [/report|status|summary|dream/, "📊"],
    [/note|memo/, "📝"],
    [/skill|routine|playbook|process|sop/, "🛠️"],
    [/product|blend|item|sku/, "📦"],
    [/project|initiative|program/, "🗂️"],
    [/risk|threat/, "⚠️"],
    [/goal|objective|okr|target/, "🎯"],
    [/metric|kpi|number|finance|invoice|payment|budget/, "💰"],
    [/location|site|place|region/, "📍"],
    [/idea|feature/, "💡"],
  ];
  for (const [re, emoji] of table) if (re.test(n)) return emoji;
  return "🗂️";
}

export interface DefinedType {
  readonly typeId: number;
  readonly physicalName: string;
  readonly extTable: string;
}

export interface AddPropertyInput {
  readonly typeId: number;
  readonly name: string;
  readonly kind: PropertyKind;
  /** target type NAME for kind 'ref' / 'ref[]'. */
  readonly refTypeName?: string;
  readonly required?: boolean;
  /** for kind 'enum' — the initial permitted values. */
  readonly enumValues?: readonly string[];
  /** catalog-only default (applied in the write path; never a SQL DEFAULT). */
  readonly defaultValue?: unknown;
  readonly position?: number;
}

export interface AddedProperty {
  readonly propertyId: number;
  readonly physicalName: string;
}

export class SchemaExecutor {
  constructor(
    private readonly owner: Client,
    private readonly budget: SchemaBudget = DEFAULT_SCHEMA_BUDGET,
  ) {}

  /**
   * Create a new type: sanitize the name, register the ext relation name,
   * CREATE the ext table via the primitive, grant the app DML, insert the
   * catalog row, and attribute an event — all under one advisory-locked txn.
   */
  async defineType(input: DefineTypeInput, actor: string): Promise<DefinedType> {
    const s = sanitizeIdentifier(input.name);
    if (!s.ok) {
      throw schemaError("invalid type name", { reason: s.reason });
    }
    const physical = s.identifier;
    const extTable = extTableName(physical);

    return this.inLockedTxn(actor, async (c) => {
      const { rows: cnt } = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM types");
      if (Number(cnt[0]!.n) >= this.budget.maxTypes) {
        throw refusedError(
          "schema budget: too many types on this box",
          "deprecate or drop an unused type before defining a new one",
          { limit: this.budget.maxTypes },
        );
      }
      await c.query("INSERT INTO physical_name (name, kind) VALUES ($1, 'table')", [extTable]);
      await c.query("SELECT brain_create_ext_table($1)", [extTable]);
      await c.query("SELECT brain_grant_app($1)", [extTable]);
      // Reference the icon column ONLY when an icon is supplied, so defineType
      // keeps working against a brain one migration behind (icon lands in 0022;
      // the migrate-with-data seed defines types on the previous schema). When
      // omitted, the column's DEFAULT fills it post-0022. The app always passes
      // one (see the define_type tool), which by then runs after 0022.
      const cols = ["name", "physical_name", "label", "description", "ext_table"];
      const vals: unknown[] = [
        physical,
        physical,
        input.label ?? null,
        input.description ?? null,
        extTable,
      ];
      if (input.icon !== undefined) {
        cols.push("icon");
        vals.push(input.icon);
      }
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO types (${cols.join(", ")}) VALUES (${placeholders}) RETURNING id`,
        vals,
      );
      const typeId = rows[0]!.id;
      await c.query("UPDATE physical_name SET type_id = $1 WHERE name = $2", [typeId, extTable]);
      // Attach the generic invariant triggers (D.1 ext side, D.5 tsv) — the
      // executor emits only CREATE TRIGGER … EXECUTE FUNCTION <generic_fn>.
      await c.query("SELECT brain_attach_ext_triggers($1, $2)", [extTable, typeId]);
      await this.writeEvent(c, actor, "define_type", null, { type_id: typeId });
      return { typeId, physicalName: physical, extTable };
    });
  }

  /** Run `fn` inside the executor's serialized, actor-attributed transaction. */
  async inLockedTxn<T>(actor: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = this.owner;
    await c.query("BEGIN");
    try {
      await c.query("SELECT pg_advisory_xact_lock($1)", [EXECUTOR_ADVISORY_LOCK]);
      // D.3 / M6: every writer sets app.actor_id. Also lets any trigger that
      // fires during DDL attribute correctly.
      await c.query("SELECT set_config('app.actor_id', $1, true)", [actor]);
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK");
      throw mapExecutorError(err);
    }
  }

  async writeEvent(
    c: Client,
    actor: string,
    kind: string,
    target: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await c.query("INSERT INTO events (actor, kind, target, payload) VALUES ($1, $2, $3, $4)", [
      actor,
      kind,
      target,
      JSON.stringify(payload),
    ]);
  }

  private async lookupType(
    c: Client,
    typeId: number,
  ): Promise<{ id: number; physical: string; extTable: string }> {
    const { rows } = await c.query<{ physical_name: string; ext_table: string }>(
      "SELECT physical_name, ext_table FROM types WHERE id = $1",
      [typeId],
    );
    if (rows.length === 0) throw notFoundError();
    return { id: typeId, physical: rows[0]!.physical_name, extTable: rows[0]!.ext_table };
  }

  private async lookupTypeByName(
    c: Client,
    name: string,
  ): Promise<{ id: number; physical: string; extTable: string }> {
    const { rows } = await c.query<{ id: number; physical_name: string; ext_table: string }>(
      "SELECT id, physical_name, ext_table FROM types WHERE name = $1",
      [name],
    );
    if (rows.length === 0) throw validationError("no such target type");
    return { id: rows[0]!.id, physical: rows[0]!.physical_name, extTable: rows[0]!.ext_table };
  }

  /**
   * Add a property to a type. Additive and instant: a nullable column (+ a
   * numeric NaN/Inf CHECK for decimal/float), a ref uuid column with a NOT VALID
   * FK later VALIDATEd in its own txn, or a ref[] junction table. Enum values
   * are catalog rows; `required` is write-path-enforced (never a retro NOT NULL).
   * Refs are added post-creation so cyclic types work.
   */
  async addProperty(input: AddPropertyInput, actor: string): Promise<AddedProperty> {
    const s = sanitizeIdentifier(input.name);
    if (!s.ok) throw schemaError("invalid property name", { reason: s.reason });
    const prop = s.identifier;
    if (!PROPERTY_KINDS.includes(input.kind)) throw schemaError("unknown property kind");

    const isEnum = input.kind === "enum";
    if (isEnum && (!input.enumValues || input.enumValues.length === 0)) {
      throw validationError("an enum property needs at least one value");
    }
    if (isEnum && (input.enumValues?.length ?? 0) > this.budget.maxEnumValues) {
      throw validationError("an enum has too many values", { limit: this.budget.maxEnumValues });
    }
    for (const v of input.enumValues ?? []) {
      if (typeof v !== "string") throw validationError("enum values must be strings");
    }

    const result = await this.inLockedTxn(actor, async (c) => {
      const type = await this.lookupType(c, input.typeId);
      const extTable = type.extTable;

      let refTypeId: number | null = null;
      let targetExt: string | null = null;
      if (input.kind === "ref" || input.kind === "ref[]") {
        if (!input.refTypeName) throw validationError("a ref property needs a target type");
        const target = await this.lookupTypeByName(c, input.refTypeName);
        refTypeId = target.id;
        targetExt = target.extTable;
      }

      const { rows: cnt } = await c.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM type_properties WHERE type_id = $1",
        [input.typeId],
      );
      if (Number(cnt[0]!.n) >= this.budget.maxPropertiesPerType) {
        throw refusedError(
          "schema budget: this type has too many properties",
          "deprecate an unused property before adding more",
          { limit: this.budget.maxPropertiesPerType },
        );
      }

      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO type_properties
           (type_id, name, physical_name, kind, ref_type_id, required, default_value, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          input.typeId,
          prop,
          prop,
          input.kind,
          refTypeId,
          input.required ?? false,
          input.defaultValue !== undefined ? JSON.stringify(input.defaultValue) : null,
          input.position ?? 0,
        ],
      );
      const propertyId = rows[0]!.id;

      if (input.kind === "ref[]") {
        const junction = junctionTableName(type.physical, prop);
        await c.query("INSERT INTO physical_name (name, kind, type_id) VALUES ($1, 'table', $2)", [
          junction,
          input.typeId,
        ]);
        await c.query("SELECT brain_create_junction($1, $2, $3)", [junction, extTable, targetExt]);
        await c.query("SELECT brain_grant_app($1)", [junction]);
      } else {
        await c.query("SELECT brain_add_column($1, $2, $3)", [extTable, prop, input.kind]);
        if (input.kind === "decimal" || input.kind === "float") {
          await c.query("SELECT brain_add_numeric_check($1, $2, $3)", [
            extTable,
            prop,
            numericCheckName(type.physical, prop),
          ]);
        }
        if (input.kind === "ref") {
          await c.query("SELECT brain_add_ref_fk($1, $2, $3, $4)", [
            extTable,
            refConstraintName(type.physical, prop),
            prop,
            targetExt,
          ]);
        }
        if (isEnum) {
          for (const v of input.enumValues!) {
            await c.query(
              "INSERT INTO enum_option (type_id, property_id, value) VALUES ($1, $2, $3)",
              [input.typeId, propertyId, v],
            );
          }
        }
      }
      await this.writeEvent(c, actor, "add_property", null, {
        type_id: input.typeId,
        property_id: propertyId,
      });
      return {
        propertyId,
        physicalName: prop,
        extTable,
        kind: input.kind,
        physical: type.physical,
      };
    });

    // VALIDATE the ref FK in its OWN txn — instant on a new type.
    if (input.kind === "ref") {
      await this.owner.query("SELECT brain_validate_constraint($1, $2)", [
        result.extTable,
        refConstraintName(result.physical, result.physicalName),
      ]);
    }
    return { propertyId: result.propertyId, physicalName: result.physicalName };
  }

  // set_type lives in the Writer (packages/mcp-tools/src/write-path.ts): it is
  // a DATA op (RLS-bound, version-guarded, prop-validating), not DDL — the
  // operator-only retype/demote below stay here for recovery use.

  async deprecateProperty(propertyId: number, actor: string): Promise<void> {
    await this.setPropertyDeprecated(propertyId, true, actor);
  }
  async restoreProperty(propertyId: number, actor: string): Promise<void> {
    await this.setPropertyDeprecated(propertyId, false, actor);
  }
  private async setPropertyDeprecated(
    propertyId: number,
    deprecated: boolean,
    actor: string,
  ): Promise<void> {
    await this.inLockedTxn(actor, async (c) => {
      const upd = await c.query("UPDATE type_properties SET deprecated = $1 WHERE id = $2", [
        deprecated,
        propertyId,
      ]);
      if (upd.rowCount !== 1) throw notFoundError();
      await this.writeEvent(
        c,
        actor,
        deprecated ? "deprecate_property" : "restore_property",
        null,
        {
          property_id: propertyId,
        },
      );
    });
  }

  async deprecateType(typeId: number, actor: string): Promise<void> {
    await this.setTypeDeprecated(typeId, true, actor);
  }
  async restoreType(typeId: number, actor: string): Promise<void> {
    await this.setTypeDeprecated(typeId, false, actor);
  }
  /** Set a type's emoji icon. */
  async setTypeIcon(typeId: number, icon: string, actor: string): Promise<void> {
    await this.inLockedTxn(actor, async (c) => {
      const upd = await c.query("UPDATE types SET icon = $1 WHERE id = $2", [icon, typeId]);
      if (upd.rowCount !== 1) throw notFoundError();
      await this.writeEvent(c, actor, "set_type_icon", null, { type_id: typeId });
    });
  }
  private async setTypeDeprecated(
    typeId: number,
    deprecated: boolean,
    actor: string,
  ): Promise<void> {
    await this.inLockedTxn(actor, async (c) => {
      const upd = await c.query("UPDATE types SET deprecated = $1 WHERE id = $2", [
        deprecated,
        typeId,
      ]);
      if (upd.rowCount !== 1) throw notFoundError();
      await this.writeEvent(c, actor, deprecated ? "deprecate_type" : "restore_type", null, {
        type_id: typeId,
      });
    });
  }

  /** Look up a type by name (sanitized) for the define_type upsert path; null if none. */
  async findType(name: string): Promise<{ id: number; deprecated: boolean } | null> {
    const s = sanitizeIdentifier(name);
    if (!s.ok) return null;
    const { rows } = await this.owner.query<{ id: number; deprecated: boolean }>(
      "SELECT id, deprecated FROM types WHERE name = $1",
      [s.identifier],
    );
    return rows[0] ?? null;
  }

  /** Look up a property of a type by name (sanitized), for the add_property toggle; null if none. */
  async findProperty(
    typeId: number,
    name: string,
  ): Promise<{ id: number; deprecated: boolean } | null> {
    const s = sanitizeIdentifier(name);
    if (!s.ok) return null;
    const { rows } = await this.owner.query<{ id: number; deprecated: boolean }>(
      "SELECT id, deprecated FROM type_properties WHERE type_id = $1 AND name = $2",
      [typeId, s.identifier],
    );
    return rows[0] ?? null;
  }

  // ==================================================================
  // Operator schema ops. Same locked path; destructive.
  // ==================================================================

  /** Rename a type. Touches types.name only (surrogate id → no whole-brain rewrite). */
  async renameType(typeId: number, newName: string, actor: string): Promise<void> {
    const s = sanitizeIdentifier(newName);
    if (!s.ok) throw schemaError("invalid type name", { reason: s.reason });
    await this.inLockedTxn(actor, async (c) => {
      const upd = await c.query("UPDATE types SET name = $1 WHERE id = $2", [s.identifier, typeId]);
      if (upd.rowCount !== 1) throw notFoundError();
      await this.writeEvent(c, actor, "rename_type", null, { type_id: typeId });
    });
  }

  /** Demote a typed object back to a note (drops its ext row). */
  async demote(objectId: string, actor: string): Promise<void> {
    await this.inLockedTxn(actor, async (c) => {
      const r = await c.query<{ type_id: number | null }>(
        "SELECT type_id FROM objects WHERE id = $1 AND deleted_at IS NULL",
        [objectId],
      );
      if (r.rowCount === 0) throw notFoundError(objectId);
      const typeId = r.rows[0]!.type_id;
      if (typeId === null) throw refusedError("already a note", "nothing to demote");
      const type = await this.lookupType(c, typeId);
      // note-first, then drop the ext row (biconditional checked at commit).
      await c.query(
        "UPDATE objects SET type_id = NULL, version = version + 1, updated_at = now() WHERE id = $1",
        [objectId],
      );
      await c.query("SELECT brain_delete_ext_row($1, $2)", [type.extTable, objectId]);
      await this.writeEvent(c, actor, "demote", objectId, { from_type: typeId });
    });
  }

  /** Change an object's type: drop the old ext row, create the new (empty) one. */
  async retype(objectId: string, newTypeName: string, actor: string): Promise<void> {
    await this.inLockedTxn(actor, async (c) => {
      const target = await this.lookupTypeByName(c, newTypeName);
      const r = await c.query<{ type_id: number | null }>(
        "SELECT type_id FROM objects WHERE id = $1 AND deleted_at IS NULL",
        [objectId],
      );
      if (r.rowCount === 0) throw notFoundError(objectId);
      const oldTypeId = r.rows[0]!.type_id;
      if (oldTypeId === target.id) return;
      if (oldTypeId !== null) {
        const oldType = await this.lookupType(c, oldTypeId);
        await c.query("SELECT brain_delete_ext_row($1, $2)", [oldType.extTable, objectId]);
      }
      await c.query(
        "UPDATE objects SET type_id = $1, version = version + 1, updated_at = now() WHERE id = $2",
        [target.id, objectId],
      );
      await c.query("SELECT brain_promote_ext($1, $2)", [target.extTable, objectId]);
      await this.writeEvent(c, actor, "retype", objectId, {
        from_type: oldTypeId,
        to_type: target.id,
      });
    });
  }

  /**
   * Drop a type. Nulls type_id + deletes the ext rows in the SAME txn (else the
   * biconditional aborts forever), catalog last; then DROPs the tables in a
   * SEPARATE txn (keeps the heavy lock out of the data txn). Refuses if other
   * types still reference this one.
   *
   * `onlyIfEmpty` is the agent-facing guard (delete_type tool): refuse unless
   * ZERO objects were ever filed under the type (tombstones count — they hold
   * data), and widen the inbound-ref check to DEPRECATED ref properties too —
   * a deprecated ref prop still holds a physical FK, and with the catalog rows
   * already deleted a failing DROP TABLE would strand a poison half-state.
   */
  async dropType(
    typeId: number,
    actor: string,
    opts: { readonly onlyIfEmpty?: boolean } = {},
  ): Promise<void> {
    const junctions = await this.inLockedTxn(actor, async (c) => {
      const type = await this.lookupType(c, typeId);
      // Tag governance (0057): objects RLS is audience-based and this txn runs
      // as brain_owner, which holds no tags — without the DR escape the
      // emptiness count below sees ZERO rows for a type whose objects belong
      // to (or are private to) other members, and the detach UPDATE matches
      // nothing, so the catalog DELETE aborts on the objects→types FK with a
      // raw 23503 instead of the teaching refusal. Emptiness is a fact about
      // the TYPE, not about what the caller may read (the count it discloses
      // is metadata, same accepted ceiling as the events timeline); the escape
      // is txn-local and reachable only by the owner role.
      await c.query("SET LOCAL app.fs_dr = 'on'");

      const inbound = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM type_properties
         WHERE ref_type_id = $1 AND kind IN ('ref', 'ref[]')${opts.onlyIfEmpty ? "" : " AND NOT deprecated"}`,
        [typeId],
      );
      if (Number(inbound.rows[0]!.n) > 0) {
        throw refusedError(
          "other types still reference this one",
          "deprecate or drop the referencing properties first (get shows backlinks)",
          { referencing_properties: Number(inbound.rows[0]!.n) },
        );
      }

      if (opts.onlyIfEmpty) {
        // Objects.type_id FKs types(id), so a write racing this txn fails
        // cleanly on the catalog DELETE below — the count cannot go stale.
        const objs = await c.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM objects WHERE type_id = $1",
          [typeId],
        );
        if (Number(objs.rows[0]!.n) > 0) {
          throw refusedError(
            "this type has objects (live or trashed), so it cannot be deleted",
            "retire it instead: define_type visible:false hides it while its objects stay searchable",
            { objects: Number(objs.rows[0]!.n) },
          );
        }
      }

      const jrows = await c.query<{ name: string }>(
        "SELECT name FROM physical_name WHERE type_id = $1 AND name <> $2 AND kind = 'table'",
        [typeId, type.extTable],
      );

      // Consistent state within the txn: notes + no ext rows.
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      await c.query(
        "UPDATE objects SET type_id = NULL, version = version + 1, updated_at = now() WHERE type_id = $1",
        [typeId],
      );
      await c.query("SELECT brain_delete_ext_all($1)", [type.extTable]);

      await c.query("DELETE FROM enum_option WHERE type_id = $1", [typeId]);
      await c.query("DELETE FROM type_properties WHERE type_id = $1", [typeId]);
      await c.query("DELETE FROM physical_name WHERE type_id = $1", [typeId]);
      await c.query("DELETE FROM types WHERE id = $1", [typeId]);
      await this.writeEvent(c, actor, "drop_type", null, { type_id: typeId });
      return [type.extTable, ...jrows.rows.map((r) => r.name)];
    });

    // Separate txn: the DROP TABLEs (never in the same txn as the DELETE).
    for (const rel of junctions) {
      await this.owner.query("SELECT brain_drop_relation($1)", [rel]);
    }
  }
}

/** Map a Postgres error from a schema op into the teaching taxonomy. */
export function mapExecutorError(err: unknown): BrainError {
  if (isBrainError(err)) return err;
  const e = err as { code?: string };
  switch (e.code) {
    case "23505": // unique_violation
      return validationError("that name is already taken");
    case "42P07": // duplicate_table
      return schemaError("that structure already exists");
    case "23503": // foreign_key_violation
      return validationError("a referenced object or type does not exist");
    case "22P02": // invalid_text_representation
      return validationError("a value had the wrong shape");
    default:
      return schemaError("schema operation failed");
  }
}
