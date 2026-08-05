import type { PoolClient, Client } from "pg";
import { notFoundError, validationError } from "@brain/shared";

/** A loaded type + its live properties, read from the catalog (brain_app SELECT). */
export interface LoadedProperty {
  readonly id: number;
  readonly name: string;
  readonly physicalName: string;
  readonly kind: string;
  readonly refTypeId: number | null;
  readonly required: boolean;
  readonly deprecated: boolean;
}

export interface LoadedType {
  readonly id: number;
  readonly name: string;
  readonly physicalName: string;
  readonly extTable: string;
  readonly deprecated: boolean;
  readonly properties: readonly LoadedProperty[];
}

type Queryable = PoolClient | Client;

interface TypeRow {
  id: number;
  name: string;
  physical_name: string;
  ext_table: string;
  deprecated: boolean;
  properties: Array<{
    id: number;
    name: string;
    physical_name: string;
    kind: string;
    ref_type_id: number | null;
    required: boolean;
    deprecated: boolean;
  }>;
}

/** Type row + its properties aggregated inline — ONE round-trip, not two. */
const TYPE_SELECT = `
  SELECT t.id, t.name, t.physical_name, t.ext_table, t.deprecated,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', tp.id, 'name', tp.name, 'physical_name', tp.physical_name,
               'kind', tp.kind, 'ref_type_id', tp.ref_type_id,
               'required', tp.required, 'deprecated', tp.deprecated
             ) ORDER BY tp.position, tp.id
           ) FILTER (WHERE tp.id IS NOT NULL), '[]'::jsonb
         ) AS properties
  FROM types t LEFT JOIN type_properties tp ON tp.type_id = t.id`;

const TYPE_GROUP_BY = "GROUP BY t.id, t.name, t.physical_name, t.ext_table, t.deprecated";

function toLoadedType(t: TypeRow): LoadedType {
  return {
    id: t.id,
    name: t.name,
    physicalName: t.physical_name,
    extTable: t.ext_table,
    deprecated: t.deprecated,
    properties: t.properties.map((p) => ({
      id: p.id,
      name: p.name,
      physicalName: p.physical_name,
      kind: p.kind,
      refTypeId: p.ref_type_id,
      required: p.required,
      deprecated: p.deprecated,
    })),
  };
}

/** Small edit-distance for did-you-mean on type names (both sides are short). */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = prev[j]!;
      prev[j] = next;
    }
  }
  return prev[b.length]!;
}

export async function loadTypeByName(c: Queryable, name: string): Promise<LoadedType> {
  const { rows } = await c.query<TypeRow>(`${TYPE_SELECT} WHERE t.name = $1 ${TYPE_GROUP_BY}`, [
    name,
  ]);
  const t = rows[0];
  if (!t) {
    // An error message is the only schema a stale client is guaranteed to
    // read (live data: agents guess type names like "meeting"/"project"
    // and got a bare "no such type"). Teach: live list + did-you-mean.
    const live = await c.query<{ name: string }>(
      "SELECT name FROM types WHERE NOT deprecated ORDER BY name",
    );
    const names = live.rows.map((r) => r.name);
    const close = names
      .map((n) => ({ n, d: editDistance(name.toLowerCase(), n.toLowerCase()) }))
      .filter((x) => x.d <= Math.max(2, Math.floor(name.length / 3)))
      .sort((a, b) => a.d - b.d)[0]?.n;
    throw validationError(
      `no such type "${name}"` +
        (close ? ` — did you mean "${close}"?` : "") +
        (names.length > 0
          ? ` This brain's types: ${names.join(", ")}.`
          : " This brain has no types yet — define_type creates one."),
    );
  }
  return toLoadedType(t);
}

export async function loadTypeById(c: Queryable, id: number): Promise<LoadedType> {
  const { rows } = await c.query<TypeRow>(`${TYPE_SELECT} WHERE t.id = $1 ${TYPE_GROUP_BY}`, [id]);
  const t = rows[0];
  if (!t) throw notFoundError();
  return toLoadedType(t);
}
