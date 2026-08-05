/**
 * THE SCALE SEED — 5,000 nodes / 15,000 edges, on demand.
 *
 * The performance budget:
 *
 *   "5,000 nodes / 15,000 edges — sustained ≥ 55fps median (no frame > 33ms at
 *    the 95th percentile) during a continuous 10s pan+zoom … Enforced by test,
 *    not by eyeballing."
 *
 * The demo seed is 44 objects and 38 links. Forty-four nodes prove that the
 * renderer draws; they prove nothing whatsoever about the budget, and a graph
 * measured at 44 nodes and shipped against a 5,000-node promise is a promise
 * nobody checked. So: an OPT-IN bulk seed, driven by `BRAIN_DEV_GRAPH_SCALE`,
 * that the browser perf run points at.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS WRITES SQL DIRECTLY, WHICH IS OTHERWISE FORBIDDEN
 *
 * Every mutation on a box goes through the `Writer` — that is how attribution,
 * versioning, the audit trail and the tsvector stay true. This does not, and
 * the reason is arithmetic: 5,000 writes through the full path is minutes of
 * wall clock per dev-box start, which means nobody runs it, which means the
 * budget goes unmeasured again.
 *
 * The compensating constraints:
 *
 *  - it runs ONLY against the local dev database, and refuses (loudly) to do
 *    anything unless `BRAIN_DEV_GRAPH_SCALE` is set. There is no code path from
 *    a box to this file — it is not imported by `src/`, only by `dev/`;
 *  - the rows it writes are marked as synthetic in their titles, so a human
 *    looking at a dev brain can tell the difference at a glance;
 *  - it runs as `brain_owner`, WHICH OWNS THE TABLES, and it verifies the rows
 *    landed rather than assuming they did. See the note on `seedScale` — the
 *    first draft reached for `SET LOCAL ROLE brain_system` out of migration
 *    habit and failed outright, which was the good outcome;
 *  - every object is `visibility = 'org'`. A synthetic private object would put
 *    fake rows inside the one boundary the whole product is about.
 */
import type { Client } from "pg";

interface ScaleSeedOptions {
  /** the account every synthetic object is created by. */
  readonly ownerId: string;
  readonly nodes: number;
  readonly edges: number;
}

/**
 * How big a scale seed the environment is asking for, or null for none.
 *
 * `BRAIN_DEV_GRAPH_SCALE=5000` seeds the committed budget's node count and
 * three edges per node (the budgeted 15,000). `BRAIN_DEV_GRAPH_SCALE=5000x20000`
 * names both.
 */
export function scaleFromEnv(env: NodeJS.ProcessEnv = process.env): ScaleSeedOptions | null {
  const raw = env["BRAIN_DEV_GRAPH_SCALE"]?.trim();
  if (!raw) return null;
  const match = /^(\d+)(?:x(\d+))?$/.exec(raw);
  if (!match) {
    console.warn(`dev-box: ignoring BRAIN_DEV_GRAPH_SCALE=${raw} (want "5000" or "5000x15000")`);
    return null;
  }
  const nodes = Number(match[1]);
  const edges = match[2] === undefined ? nodes * 3 : Number(match[2]);
  if (nodes <= 0) return null;
  return { ownerId: "", nodes, edges };
}

/** Insert in chunks; one 5,000-row VALUES list is a query nobody should send. */
const CHUNK = 500;

/**
 * WHICH ROLE THIS RUNS AS, and why it is not `brain_system`.
 *
 * The migration doctrine says a cross-actor BACKFILL must `SET LOCAL ROLE
 * brain_system` (the NOLOGIN BYPASSRLS role) because content tables are FORCE
 * ROW LEVEL SECURITY, which binds even the table owner. The first draft of this
 * file did that by reflex and died with `relation "objects" does not exist` —
 * `brain_system` holds BYPASSRLS and NO GRANTS, not even USAGE on `public`, so
 * the schema is skipped during search-path resolution and every table vanishes.
 * BYPASSRLS is not access; it is an exemption from a check you must first be
 * allowed to reach.
 *
 * This is not a migration and it is not a backfill: it is a dev-only seeder
 * inserting NEW rows as `brain_owner`, which OWNS these tables. That is
 * sufficient today. If FORCE ROW LEVEL SECURITY is ever enabled on `objects`
 * here, owner-as-owner stops being enough — so the insert is VERIFIED rather
 * than assumed, and this fails loudly instead of reporting a seed that silently
 * wrote nothing and a perf number taken against an empty graph.
 */
export async function seedScale(owner: Client, opts: ScaleSeedOptions): Promise<void> {
  const started = Date.now();
  await owner.query("BEGIN");
  try {
    /**
     * ATTRIBUTION IS NOT OPTIONAL, even for a dev seeder.
     *
     * `brain_audit_event` (0003) fires on every insert into `objects` and
     * raises "app.actor_id is not set — refusing to write an unattributed
     * event". That is the box working correctly: there is no such thing as a
     * write nobody made, and the seeder does not get an exemption from the rule
     * every other write path obeys. Transaction-local (the `true`), so a
     * pooled connection never carries this actor into the next borrower.
     */
    await owner.query("SELECT set_config('app.actor_id', $1, true)", [opts.ownerId]);

    const ids: string[] = [];
    for (let start = 0; start < opts.nodes; start += CHUNK) {
      const size = Math.min(CHUNK, opts.nodes - start);
      const values: string[] = [];
      const params: unknown[] = [opts.ownerId];
      for (let i = 0; i < size; i += 1) {
        const n = start + i;
        params.push(`Synthetic node ${n}`, `Generated by seed-scale for the graph perf budget.`);
        // audience stamped like the Writer would (0057: the policy reads
        // audience, and a raw '[]' row is creator-only — invisible to the
        // members this perf fixture exists for).
        values.push(
          `($${params.length - 1}, $${params.length}, $1, 'org',
            (SELECT jsonb_build_array(jsonb_build_array(id::text)) FROM tags WHERE kind = 'org'))`,
        );
      }
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO objects (title, body, created_by, visibility, audience)
         VALUES ${values.join(", ")}
         RETURNING id`,
        params,
      );
      for (const r of rows) ids.push(r.id);
    }

    /**
     * A RING plus chords, not a uniform random graph.
     *
     * Random edges produce a hairball with no structure, which is both
     * unrealistic and unfairly EASY on the layout — everything settles into an
     * even blob. A ring guarantees the graph is connected (so the layout has to
     * do real work) and the chords give it the long-range links that make
     * force-directed layout expensive, which is the case the budget is about.
     */
    const pairs = new Set<string>();
    const edgeRows: Array<[string, string]> = [];
    const push = (a: number, b: number): void => {
      if (a === b) return;
      const from = ids[a];
      const to = ids[b];
      if (!from || !to) return;
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      if (pairs.has(key)) return;
      pairs.add(key);
      edgeRows.push([from, to]);
    };
    for (let i = 0; i < ids.length && edgeRows.length < opts.edges; i += 1)
      push(i, (i + 1) % ids.length);
    /**
     * Deterministic chords, so two runs produce the same graph and a perf
     * number is comparable to the one before it.
     *
     * xorshift32 — shifts and xors only — NOT the textbook LCG
     * `state * 1103515245 + 12345`. In JS that multiply exceeds 2^53, so the
     * low bits are silently lost, the generator collapses onto a very short
     * cycle, and `push` then rejects duplicate after duplicate while the
     * `while` below never reaches its target: an infinite loop that presented
     * as the dev box "hanging" forever during seeding. xorshift stays in 32-bit
     * integer arithmetic throughout, where every operation is exact.
     */
    let state = 0x2545f491;
    const next = (): number => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    };
    // And a hard bound regardless: a generator that somehow still degenerates
    // must produce a smaller graph, never an unkillable process. Ten tries per
    // wanted edge is generous for a graph this sparse.
    const maxAttempts = Math.max(1000, opts.edges * 10);
    let attempts = 0;
    while (edgeRows.length < opts.edges && ids.length > 2 && attempts < maxAttempts) {
      attempts += 1;
      push(next() % ids.length, next() % ids.length);
    }
    if (edgeRows.length < opts.edges) {
      console.warn(
        `dev-box: scale seed could only place ${edgeRows.length} of ${opts.edges} edges`,
      );
    }

    for (let start = 0; start < edgeRows.length; start += CHUNK) {
      const slice = edgeRows.slice(start, start + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      for (const [from, to] of slice) {
        params.push(from, to);
        values.push(`($${params.length - 1}, 'relates_to', $${params.length}, 'manual')`);
      }
      await owner.query(
        `INSERT INTO edges (from_id, rel, to_id, provenance)
         VALUES ${values.join(", ")}
         ON CONFLICT DO NOTHING`,
        params,
      );
    }

    // Prove it, do not assume it. A silent zero here would hand the perf test a
    // 44-node graph wearing a 5,000-node label.
    if (ids.length < opts.nodes) {
      throw new Error(
        `seed-scale: asked for ${opts.nodes} objects, inserted ${ids.length}. ` +
          `If FORCE ROW LEVEL SECURITY is now on \`objects\`, this seeder needs a role that can ` +
          `reach the table (BYPASSRLS alone is not enough — it needs GRANTs too).`,
      );
    }
    await owner.query("COMMIT");
    console.log(
      `dev-box: scale seed wrote ${ids.length} objects and ${edgeRows.length} edges in ${Date.now() - started}ms`,
    );
  } catch (err) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
