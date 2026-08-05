import type { Client } from "pg";
import { junctionTableName } from "./executor.js";

/**
 * The drift reconciler. Compares the live physical
 * schema against the catalog and — only on an UNAMBIGUOUS existence/nullability
 * mismatch — quarantines the offending type (deprecate + event) so the write
 * path stops handing out a broken shape. Runs boot / periodic / post-restore;
 * **post-restore is report-only first** (transient restore state must not
 * trigger quarantines). Runs AFTER migrations on the update path.
 */

export type DriftKind =
  "missing_ext_table" | "missing_column" | "unexpected_not_null" | "missing_junction";

export interface DriftFinding {
  readonly typeId: number;
  readonly typeName: string;
  readonly kind: DriftKind;
  readonly detail: string;
}

export interface DriftResult {
  readonly findings: readonly DriftFinding[];
  readonly quarantined: readonly number[];
}

const SCALAR_KINDS = new Set([
  "text",
  "int",
  "decimal",
  "float",
  "bool",
  "date",
  "timestamp",
  "enum",
  "ref",
]);

/** Detect drift without changing anything. */
export async function driftReport(owner: Client): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = [];

  const types = await owner.query<{
    id: number;
    name: string;
    ext_table: string;
    physical_name: string;
  }>("SELECT id, name, ext_table, physical_name FROM types WHERE NOT deprecated");

  for (const t of types.rows) {
    const extExists = await owner.query<{ v: string | null }>("SELECT to_regclass($1) AS v", [
      t.ext_table,
    ]);
    if (extExists.rows[0]!.v === null) {
      findings.push({
        typeId: t.id,
        typeName: t.name,
        kind: "missing_ext_table",
        detail: `ext table ${t.ext_table} does not exist`,
      });
      continue; // no point checking columns of a missing table
    }

    const props = await owner.query<{ physical_name: string; kind: string }>(
      "SELECT physical_name, kind FROM type_properties WHERE type_id = $1 AND NOT deprecated",
      [t.id],
    );
    const cols = await owner.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = $1",
      [t.ext_table],
    );
    const colMap = new Map(cols.rows.map((c) => [c.column_name, c.is_nullable]));

    for (const p of props.rows) {
      if (SCALAR_KINDS.has(p.kind)) {
        const nullable = colMap.get(p.physical_name);
        if (nullable === undefined) {
          findings.push({
            typeId: t.id,
            typeName: t.name,
            kind: "missing_column",
            detail: `column ${p.physical_name} missing on ${t.ext_table}`,
          });
        } else if (nullable === "NO") {
          // our ext columns are always nullable (required is write-path-enforced)
          findings.push({
            typeId: t.id,
            typeName: t.name,
            kind: "unexpected_not_null",
            detail: `column ${p.physical_name} is unexpectedly NOT NULL`,
          });
        }
      } else if (p.kind === "ref[]") {
        const junction = junctionTableName(t.physical_name, p.physical_name);
        const jExists = await owner.query<{ v: string | null }>("SELECT to_regclass($1) AS v", [
          junction,
        ]);
        if (jExists.rows[0]!.v === null) {
          findings.push({
            typeId: t.id,
            typeName: t.name,
            kind: "missing_junction",
            detail: `junction ${junction} missing`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Reconcile drift. In report mode (default, and always right after a restore)
 * nothing is changed. In quarantine mode, a type with any unambiguous
 * existence/nullability finding is deprecated + an event is written.
 */
export async function reconcileDrift(
  owner: Client,
  opts: { quarantine?: boolean; postRestore?: boolean; actor?: string } = {},
): Promise<DriftResult> {
  const findings = await driftReport(owner);
  const quarantine = opts.quarantine === true && opts.postRestore !== true;
  const quarantined: number[] = [];

  if (quarantine && findings.length > 0) {
    const actor = opts.actor ?? "00000000-0000-0000-0000-000000000000";
    const toQuarantine = [...new Set(findings.map((f) => f.typeId))];
    for (const typeId of toQuarantine) {
      await owner.query("BEGIN");
      try {
        await owner.query("SELECT set_config('app.actor_id', $1, true)", [actor]);
        await owner.query("UPDATE types SET deprecated = true WHERE id = $1", [typeId]);
        await owner.query(
          "INSERT INTO events (actor, kind, target, payload) VALUES ($1, 'quarantine_type', NULL, $2)",
          [actor, JSON.stringify({ type_id: typeId, reason: "schema drift" })],
        );
        await owner.query("COMMIT");
        quarantined.push(typeId);
      } catch (e) {
        await owner.query("ROLLBACK");
        throw e;
      }
    }
  }

  return { findings, quarantined };
}
