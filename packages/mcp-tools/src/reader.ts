import type { Pool, PoolClient } from "pg";
import { isBrainError, notFoundError, quoteIdentifier, validationError } from "@brain/shared";
import { junctionTableName } from "@brain/schema";
import { loadTypeById, loadTypeByName, type LoadedType } from "./catalog.js";
import {
  compileSort,
  compileWhere,
  decodeCursor,
  encodeCursor,
  keysetPredicate,
  Params,
  type FieldResolver,
  type ScalarValue,
  type SortSpec,
  type WhereNode,
} from "./query-ast.js";

/**
 * The read tools. Runs as brain_app (SELECT).
 * Every read txn sets app.actor_id so Postgres RLS (migration 0012) scopes
 * private objects to their creator + shared_with — the queries themselves
 * never filter by visibility. Every list/query is keyset-paginated,
 * hard-capped, and statement-timed; agent field names are whitelisted through
 * the catalog (query-ast.ts), never interpolated.
 */

export interface ReadContext {
  readonly actorId: string;
  /** per-call flow bag (see AuthedContext.flow) — search drops mode/hit
   *  metadata here so the mcp_call log line can say HOW it searched. */
  flow?: Record<string, unknown>;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const SEARCH_DEFAULT_LIMIT = 20;
const EDGE_CAP = 100;
const READ_TIMEOUT_MS = 5000;
const EXT_TABLE_CACHE_MS = 30_000;
// getMany's body cap: a single deliberate get(id) returns the full body (that's
// the point), but getMany allows up to 25 ids — 25 x an unbounded body (up to
// the 1MB write cap each) is a real "too much output" failure, not a
// hypothetical one. Only applied when actually batching (>1 id).
const GET_MANY_BODY_TRUNCATE_CHARS = 5000;

function clampLimit(limit: number | undefined, def = DEFAULT_LIMIT): number {
  if (limit === undefined) return def;
  if (!Number.isFinite(limit) || limit < 1) return def;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** A full 8-4-4-4-12 uuid — anything shorter is treated as an id prefix. */
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One line per event: enough to triage without the payload (call:write args
 * embed whole bodies, so 120 raw events ≈ 54KB — a dream sweep's whole token
 * budget). Call events keep their outcome; content stays behind get().
 */
function summarizeEvent(
  row: Record<string, unknown> & { seq: string },
): Record<string, unknown> & { seq: string } {
  const { payload, ...rest } = row;
  // schema_type is only meaningful on schema events — a null on every other
  // row is exactly the spelled-out-negative noise the summary exists to cut.
  if (rest.schema_type == null) delete rest.schema_type;
  if (typeof rest.kind === "string" && rest.kind.startsWith("call:")) {
    const p = (payload ?? {}) as Record<string, unknown>;
    return { ...rest, ok: p.ok, ms: p.ms, ...(p.error !== undefined ? { error: p.error } : {}) };
  }
  return rest;
}

/**
 * The one target-enrichment join for event feeds — recent() and activityFeed()
 * share it so they can never drift (target_deleted was once missing from one).
 * RLS-scoped by construction: a private target joins to nothing for anyone
 * outside its visibility, so enrichment can never surface what the objects
 * table itself withholds.
 */
const EVENT_TARGET_JOIN_SQL = `LEFT JOIN objects o ON o.id = ev.target
         LEFT JOIN types ty ON ty.id = o.type_id`;
const EVENT_TARGET_FIELDS_SQL = `o.title AS target_title, ty.name AS target_type,
                (o.deleted_at IS NOT NULL) AS target_deleted`;
// The one actor-enrichment join for event feeds — recent(), history(), and
// activityFeed() share it so a human name always rides alongside the raw
// actor id (an agent reading `recent`/`history` should see "Ishaan", not a
// uuid). Kept next to the target helper so the two enrichments never drift.
const EVENT_ACTOR_JOIN_SQL = `LEFT JOIN accounts act ON act.id = ev.actor`;
const EVENT_ACTOR_FIELDS_SQL = `act.name AS actor_name`;
// Schema events (define_type/add_property/deprecate_type/…) have no object
// target — they carry {type_id} in the payload, which used to render as an
// event with a null target ("Alice define_type" touching WHAT?). Resolve the
// type name at read time so the feed says which type the schema op touched.
// Current name on purpose: a renamed type reads by its live name.
const EVENT_SCHEMA_JOIN_SQL = `LEFT JOIN types tsch
           ON ev.target IS NULL
          AND (ev.payload->>'type_id') ~ '^[0-9]+$'
          AND tsch.id = (ev.payload->>'type_id')::int`;
const EVENT_SCHEMA_FIELDS_SQL = `tsch.name AS schema_type`;

/** Visible-edge degree of an object — how linked-in a search hit is. */
const connectionsSql = (alias: string): string =>
  `(SELECT count(*)::int FROM edges e2 WHERE e2.from_id = ${alias}.id OR e2.to_id = ${alias}.id)`;

/** Minimum cosine similarity for a semantic hit. Below this, nearest-neighbor
 * results are noise — without a floor, ANY query "matches" something and
 * zero-hit results (and the fuzzy fallback) become impossible.
 * ponytail: 0.45 is the retrieval eval's pick for the local model (2026-07) —
 * retune if the embedder changes. */
const SEMANTIC_SIMILARITY_FLOOR = 0.45;

/** How many nearest CHUNKS the HNSW scan pulls before best-per-object
 * pooling — several chunks of one long doc must not crowd out other docs. */
const SEMANTIC_CHUNK_FAN = 6;

/** Graph arm bounds: how many fused seeds we walk from, and how many
 * neighbors each hop may contribute to the graph arm's ranked list. */
const GRAPH_SEEDS = 5;
const GRAPH_HOP1_CAP = 24;
const GRAPH_HOP2_CAP = 16;
/** The graph arm's RRF vote weight. 1.0 lets connected-but-wordless
 * neighbors outvote direct matches (measured: -7.6 P@5 on the eval corpus);
 * this keeps the arm a corroborator/tie-breaker — a hit found by text AND
 * edges beats its text-only peer, a graph-only hit fills gaps, never the
 * head. 0.3 chosen by the 2026-07 ablation sweep. */
const GRAPH_ARM_WEIGHT = 0.3;

/** Candidates handed to the (optional) cross-encoder reranker. */
const RERANK_WINDOW = 20;

/** No single type may fill more than this share of a result page when other
 * types also matched (GBrain-style diversity cap). */
const TYPE_DIVERSITY_SHARE = 0.6;

/**
 * TITLE TIERS — how a hit's TITLE beats a hit's CONTENT, absolutely.
 *
 * This was a bounded 1.5× multiplier, and a multiplier is always beatable:
 * `ts_rank_cd` SUMS occurrences, so a document naming someone six times scored
 * 1.5908 against that person's own profile at 1.5000 (measured, 2026-07-26).
 * Typing a full name therefore RANKED THE PERSON BELOW a note about them —
 * and typing half the name did better than typing all of it, which is the
 * complaint that started this.
 *
 * No multiplier fixes that, because content scores are unbounded above. So the
 * title is a TIER, compared before the score: a lower tier can never outrank a
 * higher one however many times it repeats the words.
 *
 *   EXACT    the title IS the query          "Meenakshi Sharma"
 *   PREFIX   the title STARTS WITH it        "Meenakshi Sharma — call notes",
 *                                            and every prefix of a name while
 *                                            it is still being typed
 *   CONTAINS the query is a token run in it  "Intro to Meenakshi Sharma"
 *   NONE     the words are in the body only
 *
 * Within a tier the fused score decides, so connectedness still breaks the tie
 * between two things with the same title — a person with 18 links beats a
 * stray note named after them, which is the right answer for the same reason.
 *
 * Deliberately NOT type-aware: "a person wins" would be wrong in a brain whose
 * canonical thing is a client or a deal, and types are per-brain. Where the
 * name SITS is the signal; what the object IS is not this layer's business.
 */
const TITLE_TIER = { exact: 3, prefix: 2, contains: 1, none: 0 } as const;

/**
 * How much a hit's own CONNECTEDNESS may lift it, at most (+15%).
 *
 * Typing a person's name should land on the person, not on a meeting note that
 * mentions them — and what makes the person the answer is that the brain hangs
 * off them. Nothing in the stack knew that: the graph arm uses edges to FIND
 * related objects, never to rank a hit by how connected it is.
 *
 * Deliberately small, and deliberately applied last. A well-connected hub that
 * barely matches the words must never outrank the thing you actually named, so
 * this reorders WITHIN a tier rather than across tiers — it is a tie-break for
 * "several things match this equally", which is exactly the ambiguous-query
 * case ("meenakshi" matching a person, a 1:1 and a note that mentions her).
 */
const DEGREE_BOOST_MAX = 0.15;

export interface ReaderOptions {
  /**
   * Embed a search query for hybrid semantic search. Returns null (or throws)
   * when the embedder is unavailable — search then degrades to lexical-only.
   */
  readonly embedQuery?: (query: string) => Promise<number[] | null>;
  /**
   * Optional cross-encoder reranker: scores query+candidate jointly for the
   * top RERANK_WINDOW fused hits. Returns null (or throws) to skip — search
   * then keeps the fused order. Wired the same way as embedQuery so the
   * whole stage is one nullable dependency.
   */
  readonly rerank?: (
    query: string,
    candidates: ReadonlyArray<{ id: string; text: string }>,
  ) => Promise<ReadonlyArray<{ id: string; score: number }> | null>;
}

/** Spine columns exposed to where/sort, in addition to a type's own props. */
function baseResolver(): FieldResolver {
  const spine: Record<string, { sqlColumn: string; kind: string }> = {
    id: { sqlColumn: 'o."id"', kind: "id" },
    title: { sqlColumn: 'o."title"', kind: "text" },
    created_at: { sqlColumn: "o.created_at", kind: "timestamp" },
    updated_at: { sqlColumn: "o.updated_at", kind: "timestamp" },
    version: { sqlColumn: "o.version", kind: "int" },
  };
  return (name) => spine[name] ?? null;
}

function typeResolver(t: LoadedType): FieldResolver {
  const base = baseResolver();
  const props = new Map(
    t.properties
      .filter((p) => !p.deprecated)
      .map((p) =>
        p.kind === "ref[]"
          ? [p.name, { sqlColumn: "", kind: p.kind, refRel: p.name }]
          : [p.name, { sqlColumn: `e.${quoteIdentifier(p.physicalName)}`, kind: p.kind }],
      ),
  );
  return (name) => base(name) ?? props.get(name) ?? null;
}

/** The objects-spine row every get()/getMany() reads. `true_in` rides along
 *  (definer edge census) so the hidden_from_you signal costs no extra round-trip. */
interface ObjectRow {
  id: string;
  type_id: number | null;
  title: string | null;
  body: string | null;
  version: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  visibility: string;
  shared_with: string[];
  created_by: string;
  true_in: number;
}

interface EdgeRef {
  rel: string;
  id: string;
  provenance: string;
  target_deleted: boolean;
  target_title: string | null;
  target_type: string | null;
  required?: boolean;
}

interface EdgeListResult {
  edges: EdgeRef[];
  truncated: boolean;
}

/**
 * The hard ceiling on the whole-brain graph (`graphFull`). It EQUALS the gating
 * performance number the graph engine is benchmarked at (5,000 nodes /
 * ~15,000 edges), not a larger aspirational one: shipping 25,000 would serve
 * every brain between 5k and 25k a graph five times past the only size anyone
 * ever tests, on a production box we cannot profile, while the UI asserts nothing
 * was truncated. It moves only when the gating benchmark moves with it.
 */
export const GRAPH_FULL_MAX = 5000;

/** Cap on `filters.types` entries — a filter list, not a bulk id channel. */
const GRAPH_FILTER_TYPES_MAX = 200;

export interface GraphFullNode {
  id: string;
  title: string | null;
  type: string | null;
  /** degree over the VISIBLE subgraph only (see graphFull). */
  degree: number;
}

export interface GraphFullEdge {
  from: string;
  to: string;
  /** the relationship verb — shortest-path labels every hop with it. */
  rel: string;
}

export interface GraphFullFilters {
  /** type names to keep; `null` in the list means "untyped objects". */
  types?: ReadonlyArray<string | null>;
  /** only objects updated at/after this instant (ISO-8601). */
  since?: string;
  /** only objects updated at/before this instant (ISO-8601). */
  until?: string;
}

export interface GraphFullResult {
  nodes: GraphFullNode[];
  edges: GraphFullEdge[];
  /** opaque; feed back as `after`. null ⇒ this was the last page. */
  nextCursor: string | null;
  /** the snapshot every page of this walk is served against (ISO-8601). */
  watermark: string;
  /** set only when the visible brain is larger than GRAPH_FULL_MAX. */
  truncated: { shown: number; total: number; reason: "size" } | null;
}

interface GraphCursor {
  /** last id of the previous page (keyset). */
  readonly id: string;
  /** the watermark recorded on page 1, carried so later pages agree with it. */
  readonly wm: string;
}

function encodeGraphCursor(c: GraphCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Accepts an opaque cursor or a bare uuid (the documented `?after=<id>`). */
function decodeGraphCursor(s: string): { id: string; wm?: string } {
  if (FULL_UUID.test(s)) return { id: s };
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Partial<GraphCursor>;
    if (typeof c !== "object" || c === null || !FULL_UUID.test(String(c.id))) {
      throw new Error("bad cursor");
    }
    const wm = typeof c.wm === "string" && Number.isFinite(Date.parse(c.wm)) ? c.wm : undefined;
    return wm !== undefined ? { id: c.id as string, wm } : { id: c.id as string };
  } catch {
    throw validationError("invalid graph cursor");
  }
}

function parseWatermark(s: string, what: string): string {
  if (typeof s !== "string" || !Number.isFinite(Date.parse(s))) {
    throw validationError(`${what} must be an ISO-8601 timestamp`);
  }
  return s;
}

export class Reader {
  private readonly embedQuery?: (query: string) => Promise<number[] | null>;
  private readonly rerank?: ReaderOptions["rerank"];
  /** whether the object_chunks table exists (checked once, cached). */
  private hasEmbeddings?: boolean;
  /** healthy ext tables (type has a live tsv column) for unscoped fulltext,
   *  memoized with a short TTL: define_type creates ext tables at runtime, so
   *  this can't be a once-cache like hasEmbeddings. */
  private extTsvTables?: { at: number; tables: string[] };

  constructor(
    private readonly pool: Pool,
    opts: ReaderOptions = {},
  ) {
    if (opts.embedQuery) this.embedQuery = opts.embedQuery;
    if (opts.rerank) this.rerank = opts.rerank;
  }

  private async readTxn<T>(
    ctx: ReadContext,
    fn: (c: PoolClient) => Promise<T>,
    opts: { singleSnapshot?: boolean } = {},
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      // REPEATABLE READ pins every statement to one snapshot. recent() needs
      // it so max_seq is the tip of the SAME snapshot the page came from —
      // under READ COMMITTED a concurrent commit between the two statements
      // would inflate max_seq past what the page could see, and a caller
      // checkpointing on it would silently skip those events forever.
      if (opts.singleSnapshot) await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      // RLS (0057 tag governance) keys on app.actor_id: an object resolves iff
      // the actor holds every tag in one of its audience rows. Txn-local, so
      // pooled connections never leak an actor. Both GUCs in one round-trip.
      await c.query(
        "SELECT set_config('app.actor_id', $1, true), set_config('statement_timeout', $2, true)",
        [ctx.actorId, String(READ_TIMEOUT_MS)],
      );
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  // ---- get --------------------------------------------------------------
  /**
   * The object's audience translated into the SHARE vocabulary — people as
   * their emails, groups/org as tag slugs — rows preserving the DNF shape
   * ([who, ...require] per row). This is what makes sharing first-class on
   * the MCP wire: an agent reads exactly the strings `share` accepts.
   * null on a pre-0057 box (no tags table) or when the object has no
   * audience column value; callers omit the field then.
   */
  private async audienceVocab(c: PoolClient, objectId: string): Promise<string[][] | null> {
    const has = await c.query<{ ok: boolean }>(
      "SELECT to_regclass('public.tags') IS NOT NULL AS ok",
    );
    if (has.rows[0]?.ok !== true) return null;
    const r = await c.query<{ audience: string[][] | null }>(
      "SELECT audience FROM objects WHERE id = $1",
      [objectId],
    );
    const aud = r.rows[0]?.audience;
    if (!Array.isArray(aud) || aud.length === 0) return null;
    const ids = [...new Set(aud.flat())];
    if (ids.length === 0) return null;
    const rows = await c.query<{ id: string; slug: string; kind: string; email: string | null }>(
      `SELECT t.id, t.slug, t.kind, a.email
         FROM tags t
         LEFT JOIN account_tags h ON h.tag_id = t.id AND t.kind = 'personal'
         LEFT JOIN accounts a ON a.id = h.account_id
        WHERE t.id = ANY($1)`,
      [ids],
    );
    const vocab = new Map(
      rows.rows.map((x) => [x.id, x.kind === "personal" ? (x.email ?? x.slug) : x.slug] as const),
    );
    return aud.map((row) => row.map((t) => vocab.get(t) ?? t));
  }

  /** audienceVocab in its own read txn — the share tool's read-back. */
  async audienceOf(ctx: ReadContext, id: string): Promise<string[][] | null> {
    return this.readTxn(ctx, (c) => this.audienceVocab(c, id));
  }

  async get(
    ctx: ReadContext,
    id: string,
    opts: { neighbors?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return this.readTxn(ctx, async (c) => {
      const obj = await this.getOne(c, ctx, id);
      const aud = await this.audienceVocab(c, obj["id"] as string);
      if (aud) obj["audience"] = aud;
      if (!opts.neighbors) return obj;
      // Hop 2 on demand: what the object's links link to — one bounded,
      // RLS-scoped aggregate query, so a single get maps the local graph.
      const hop1 = new Set<string>();
      for (const key of ["links", "backlinks"] as const) {
        for (const e of (obj[key] as Array<{ id: string }> | undefined) ?? []) hop1.add(e.id);
      }
      obj["neighborhood"] = await this.hop2(c, [...hop1], obj["id"] as string);
      // A hub past the seed cap (or with truncated edges) gets a MAP, not the
      // map — say so, or the agent reads partial coverage as complete.
      if (
        hop1.size > Reader.HOP2_SEEDS ||
        obj["links_truncated"] === true ||
        obj["backlinks_truncated"] === true
      ) {
        obj["neighborhood_partial"] = true;
      }
      return obj;
    });
  }

  /** Hop-2 caps: how many hop-1 neighbors seed the expansion, and how many
   *  hop-2 rows return. Small on purpose — this is a map, not a dump. */
  private static readonly HOP2_SEEDS = 20;
  private static readonly HOP2_CAP = 24;

  /**
   * The neighbors-of-my-neighbors aggregate behind get(neighbors:true): one
   * row per hop-2 object with its DISTINCT rels and the hop-1 neighbor that
   * reaches it (corroborated first, then recency). Same shape of bounded
   * edge-walk as the search graph arm, but lean — no snippet, no degree
   * census. Runs under the caller's RLS: invisible objects don't join.
   */
  private async hop2(
    c: PoolClient,
    hop1Ids: readonly string[],
    selfId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const seeds = hop1Ids.slice(0, Reader.HOP2_SEEDS);
    if (seeds.length === 0) return [];
    const exclude = [selfId, ...hop1Ids];
    const r = await c.query(
      `SELECT o.id, ty.name AS type, o.title, n.rels, n.seed_count, n.best_seed_pos
       FROM (
         SELECT e.nid, count(DISTINCT e.seed_pos) AS seed_count,
                min(e.seed_pos) AS best_seed_pos,
                array_agg(DISTINCT e.rel) AS rels
         FROM (
           SELECT CASE WHEN g.from_id = s.id THEN g.to_id ELSE g.from_id END AS nid,
                  s.pos AS seed_pos, g.rel
           FROM unnest($1::uuid[]) WITH ORDINALITY AS s(id, pos)
           JOIN edges g ON g.from_id = s.id OR g.to_id = s.id
         ) e
         GROUP BY e.nid
       ) n
       JOIN objects o ON o.id = n.nid
       LEFT JOIN types ty ON ty.id = o.type_id
       WHERE o.deleted_at IS NULL AND NOT (o.id = ANY($2::uuid[]))
       ORDER BY n.seed_count DESC, n.best_seed_pos ASC, o.updated_at DESC
       LIMIT ${Reader.HOP2_CAP}`,
      [seeds, exclude],
    );
    return r.rows.map((row: Record<string, unknown>) => ({
      id: row["id"],
      type: row["type"],
      title: row["title"],
      rels: row["rels"],
      // pg returns bigint aggregates as strings — coerce before indexing.
      via: seeds[Number(row["best_seed_pos"]) - 1],
    }));
  }

  /** Batch fetch: one txn, one entry per unique id; a miss becomes {id, not_found}.
   *  A shared type memo means N objects of one type load that type ONCE. */
  async getMany(ctx: ReadContext, ids: readonly string[]): Promise<Record<string, unknown>[]> {
    return this.readTxn(ctx, async (c) => {
      const typeMemo = new Map<number, LoadedType>();
      const uniqueIds = [...new Set(ids)];
      // A single id in a batch reads the same as a plain get() (full body);
      // truncation only kicks in once actually batching multiple documents.
      const truncateBody = uniqueIds.length > 1;

      // Set-based prefetch (a 25-id batch was 100+ serial round-trips): one
      // object-row query for the whole batch, one edge query per direction over
      // every id, scalar props one query per distinct type. Every query still
      // runs INSIDE this readTxn, so RLS (app.actor_id) scopes them exactly as
      // the per-id path did — an id that resolves to nothing here is a miss. A
      // miss (short/bad id, RLS-hidden, or truly absent) falls back to getOne
      // so its not_found + did_you_mean hint stays byte-identical to get().
      const validIds = uniqueIds.filter((id) => FULL_UUID.test(id));
      const objRows = validIds.length
        ? (
            await c.query<ObjectRow>(
              "SELECT id, type_id, title, body, version, created_at, updated_at, deleted_at, visibility, shared_with, created_by, brain_edge_count(id, true) AS true_in FROM objects WHERE id = ANY($1)",
              [validIds],
            )
          ).rows
        : [];
      const byId = new Map(objRows.map((r) => [r.id, r]));
      // Load each distinct type ONCE — the same shared memo the per-id path used.
      for (const r of objRows) {
        if (r.type_id !== null && !typeMemo.has(r.type_id)) {
          typeMemo.set(r.type_id, await loadTypeById(c, r.type_id));
        }
      }
      const propsById = await this.readPropsBatch(c, objRows, typeMemo);
      const outById = await this.edgeListBatch(c, validIds, "out");
      const inById = await this.edgeListBatch(c, validIds, "in");

      const out: Record<string, unknown>[] = [];
      for (const id of uniqueIds) {
        const row = byId.get(id);
        if (!row) {
          // Miss: reuse getOne so the not_found + did_you_mean hint is identical.
          try {
            out.push(await this.getOne(c, ctx, id, typeMemo, { truncateBody }));
          } catch (e) {
            if (isBrainError(e) && e.code === "not_found") {
              const dym = e.details?.did_you_mean;
              out.push({
                id,
                not_found: true,
                ...(dym !== undefined ? { did_you_mean: dym } : {}),
              });
            } else throw e;
          }
          continue;
        }
        const typeName = row.type_id !== null ? (typeMemo.get(row.type_id)?.name ?? null) : null;
        const props = propsById.get(row.id) ?? {};
        const links = outById.get(row.id) ?? { edges: [], truncated: false };
        const backlinks = inById.get(row.id) ?? { edges: [], truncated: false };
        out.push(
          await this.assembleObject(c, ctx, row, typeName, props, links, backlinks, {
            truncateBody,
          }),
        );
      }
      return out;
    });
  }

  /**
   * A miss teaches: live ids sharing the caller's first-8-char prefix (the
   * RLS-scoped view, so private ids are never hinted to outsiders). Agents
   * often carry truncated or mistyped ids from event displays — the hint
   * saves the search round trip. Ids only, never titles.
   */
  private async didYouMean(c: PoolClient, id: string): Promise<readonly string[]> {
    const prefix = id.slice(0, 8).toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(prefix)) return [];
    // Expressed as a pkey range so the btree serves it — a function-wrapped
    // predicate (left(id::text, 8) = …) would seq-scan objects on every miss,
    // and a batched get of 25 stale ids would run 25 table scans.
    const r = await c.query<{ id: string }>(
      `SELECT id FROM objects
       WHERE id >= $1::uuid AND id <= $2::uuid AND deleted_at IS NULL LIMIT 4`,
      [`${prefix}-0000-0000-0000-000000000000`, `${prefix}-ffff-ffff-ffff-ffffffffffff`],
    );
    // More than 3 candidates is noise, not a hint.
    return r.rows.length <= 3 ? r.rows.map((x) => x.id) : [];
  }

  /**
   * Resolve a short id (8+ hex chars, dashes optional) to the ONE live object
   * it unambiguously prefixes, or null. Same btree range scan as didYouMean —
   * and the same RLS scoping, so a prefix can never confirm the existence of
   * an object the caller can't see. Ambiguity (2+ matches) resolves to null:
   * the caller falls through to not_found + did_you_mean candidates.
   */
  private async resolveIdPrefix(c: PoolClient, id: string): Promise<string | null> {
    const hex = id.toLowerCase().replace(/-/g, "");
    if (!/^[0-9a-f]{8,32}$/.test(hex)) return null;
    const canon = (fill: string): string => {
      const s = hex + fill.repeat(32 - hex.length);
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    };
    const r = await c.query<{ id: string }>(
      `SELECT id FROM objects
       WHERE id >= $1::uuid AND id <= $2::uuid AND deleted_at IS NULL LIMIT 2`,
      [canon("0"), canon("f")],
    );
    return r.rows.length === 1 ? r.rows[0]!.id : null;
  }

  private async getOne(
    c: PoolClient,
    ctx: ReadContext,
    id: string,
    typeMemo?: Map<number, LoadedType>,
    opts: { truncateBody?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    // A truncated id must not reach the uuid cast — a bad literal would abort
    // the whole (possibly batched) transaction. A prefix matching exactly ONE
    // live object resolves and proceeds; anything else goes to the hint.
    if (!FULL_UUID.test(id)) {
      const resolved = await this.resolveIdPrefix(c, id);
      if (!resolved) throw notFoundError(id, await this.didYouMean(c, id));
      id = resolved;
    }
    // true_in rides the object row: the TRUE inbound edge count (definer fn,
    // RLS-blind) feeds the hidden_from_you census without its own round-trip.
    const o = await c.query<ObjectRow>(
      "SELECT id, type_id, title, body, version, created_at, updated_at, deleted_at, visibility, shared_with, created_by, brain_edge_count(id, true) AS true_in FROM objects WHERE id = $1",
      [id],
    );
    if (o.rowCount === 0) throw notFoundError(id, await this.didYouMean(c, id));
    const row = o.rows[0]!;

    let typeName: string | null = null;
    let props: Record<string, unknown> = {};
    if (row.type_id !== null) {
      let t = typeMemo?.get(row.type_id);
      if (!t) {
        t = await loadTypeById(c, row.type_id);
        typeMemo?.set(row.type_id, t);
      }
      typeName = t.name;
      props = await this.readProps(c, t, id);
    }

    const links = await this.edgeList(c, id, "out");
    const backlinks = await this.edgeList(c, id, "in");
    return this.assembleObject(c, ctx, row, typeName, props, links, backlinks, opts);
  }

  /**
   * The shared tail of get()/getMany(): both fetch the object row, its type,
   * props, and edges (per-id or set-based) and hand them here so the returned
   * shape can NEVER drift between the two paths.
   */
  private async assembleObject(
    c: PoolClient,
    ctx: ReadContext,
    row: ObjectRow,
    typeName: string | null,
    props: Record<string, unknown>,
    links: EdgeListResult,
    backlinks: EdgeListResult,
    opts: { truncateBody?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    // Referrers census: true inbound (from the object row) minus what this
    // caller can see = links hidden inside private objects. The pre-delete/
    // merge blast-radius signal. The visible count comes free from the
    // backlinks fetch unless it was truncated.
    let visibleIn = backlinks.edges.length;
    if (backlinks.truncated) {
      const visIn = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM edges WHERE to_id = $1",
        [row.id],
      );
      visibleIn = visIn.rows[0]!.n;
    }

    const bodyTruncated =
      !!opts.truncateBody && row.body !== null && row.body.length > GET_MANY_BODY_TRUNCATE_CHARS;

    return {
      id: row.id,
      type: typeName,
      title: row.title,
      body: bodyTruncated ? row.body!.slice(0, GET_MANY_BODY_TRUNCATE_CHARS) : row.body,
      ...(bodyTruncated ? { body_truncated: true } : {}),
      version: Number(row.version),
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
      visibility: row.visibility,
      // who else it is shared with is the creator's business only
      shared_with: row.created_by === ctx.actorId ? row.shared_with : undefined,
      props,
      links: links.edges,
      links_truncated: links.truncated,
      backlinks: backlinks.edges,
      backlinks_truncated: backlinks.truncated,
      // true_in rides the FIRST statement; visible backlinks are counted a few
      // statements later (READ COMMITTED) — an edge inserted in that window
      // would otherwise push this negative. Clamp: never report < 0 hidden.
      hidden_from_you: Math.max(0, row.true_in - visibleIn),
    };
  }

  private async readProps(
    c: PoolClient,
    t: LoadedType,
    id: string,
  ): Promise<Record<string, unknown>> {
    const scalarCols = t.properties.filter((p) => !p.deprecated && p.kind !== "ref[]");
    const props: Record<string, unknown> = {};
    if (scalarCols.length > 0) {
      const cols = scalarCols.map((p) => quoteIdentifier(p.physicalName)).join(", ");
      const r = await c.query(`SELECT ${cols} FROM ${quoteIdentifier(t.extTable)} WHERE id = $1`, [
        id,
      ]);
      const extRow = (r.rows[0] ?? {}) as Record<string, unknown>;
      for (const p of scalarCols) props[p.name] = extRow[p.physicalName] ?? null;
    }
    // ref[] props come from their junction tables
    for (const p of t.properties.filter((x) => !x.deprecated && x.kind === "ref[]")) {
      const junction = junctionTableName(t.physicalName, p.physicalName);
      const r = await c.query<{ to_id: string }>(
        `SELECT to_id FROM ${quoteIdentifier(junction)} WHERE from_id = $1`,
        [id],
      );
      props[p.name] = r.rows.map((x) => x.to_id);
    }
    return props;
  }

  /**
   * Set-based readProps for getMany: scalar ext columns fetch in ONE query per
   * distinct type (WHERE id = ANY), producing the SAME per-id flat prop map as
   * readProps. ref[] junctions stay per-id — their SELECT carries no ORDER BY,
   * so batching them could reorder a ref array vs the per-id path; kept
   * identical instead. Returns a map only for TYPED rows (untyped → no entry,
   * assembled as {} exactly as getOne does).
   */
  private async readPropsBatch(
    c: PoolClient,
    rows: ObjectRow[],
    typeMemo: Map<number, LoadedType>,
  ): Promise<Map<string, Record<string, unknown>>> {
    const result = new Map<string, Record<string, unknown>>();
    const idsByType = new Map<number, string[]>();
    for (const r of rows) {
      if (r.type_id === null) continue;
      let ids = idsByType.get(r.type_id);
      if (!ids) {
        ids = [];
        idsByType.set(r.type_id, ids);
      }
      ids.push(r.id);
      result.set(r.id, {});
    }
    for (const [typeId, ids] of idsByType) {
      const t = typeMemo.get(typeId)!;
      const scalarCols = t.properties.filter((p) => !p.deprecated && p.kind !== "ref[]");
      if (scalarCols.length > 0) {
        const cols = scalarCols.map((p) => quoteIdentifier(p.physicalName)).join(", ");
        const r = await c.query<Record<string, unknown> & { id: string }>(
          `SELECT id, ${cols} FROM ${quoteIdentifier(t.extTable)} WHERE id = ANY($1)`,
          [ids],
        );
        const extById = new Map(r.rows.map((row) => [row.id, row]));
        for (const id of ids) {
          const extRow = (extById.get(id) ?? {}) as Record<string, unknown>;
          const props = result.get(id)!;
          for (const p of scalarCols) props[p.name] = extRow[p.physicalName] ?? null;
        }
      }
      // ref[] props: one junction query per id (identical query = identical order).
      const refCols = t.properties.filter((x) => !x.deprecated && x.kind === "ref[]");
      for (const id of ids) {
        const props = result.get(id)!;
        for (const p of refCols) {
          const junction = junctionTableName(t.physicalName, p.physicalName);
          const r = await c.query<{ to_id: string }>(
            `SELECT to_id FROM ${quoteIdentifier(junction)} WHERE from_id = $1`,
            [id],
          );
          props[p.name] = r.rows.map((x) => x.to_id);
        }
      }
    }
    return result;
  }

  private async edgeList(
    c: PoolClient,
    id: string,
    dir: "out" | "in",
    cap = EDGE_CAP,
  ): Promise<{
    edges: Array<{
      rel: string;
      id: string;
      provenance: string;
      target_deleted: boolean;
      target_title: string | null;
      target_type: string | null;
      required?: boolean;
    }>;
    truncated: boolean;
  }> {
    const col = dir === "out" ? "from_id" : "to_id";
    const other = dir === "out" ? "to_id" : "from_id";
    // Inbound edges also say whether a REQUIRED ref property depends on this
    // object (the old referrers() fact — deleting it would break that ref).
    const requiredJoin =
      dir === "in"
        ? `LEFT JOIN type_properties tp
             ON tp.type_id = o.type_id AND e.provenance = 'ref:' || tp.physical_name`
        : "";
    const requiredSelect = dir === "in" ? ", tp.required AS required" : "";
    const r = await c.query<{
      rel: string;
      other: string;
      provenance: string;
      deleted: boolean;
      title: string | null;
      type_name: string | null;
      required?: boolean | null;
    }>(
      `SELECT e.rel, e.${other} AS other, e.provenance, (o.deleted_at IS NOT NULL) AS deleted,
              o.title, ty.name AS type_name${requiredSelect}
       FROM edges e JOIN objects o ON o.id = e.${other}
       LEFT JOIN types ty ON ty.id = o.type_id
       ${requiredJoin}
       WHERE e.${col} = $1
       ORDER BY e.rel, e.${other}
       LIMIT ${cap + 1}`,
      [id],
    );
    const truncated = r.rows.length > cap;
    const rows = truncated ? r.rows.slice(0, cap) : r.rows;
    return {
      edges: rows.map((x) => ({
        rel: x.rel,
        id: x.other,
        provenance: x.provenance,
        target_deleted: x.deleted,
        target_title: x.title,
        target_type: x.type_name,
        ...(dir === "in" ? { required: x.required === true } : {}),
      })),
      truncated,
    };
  }

  /**
   * Set-based edgeList for getMany: ONE query per direction over the whole
   * batch. row_number() is computed AFTER the RLS-scoped objects join (a target
   * hidden by RLS drops before the count, exactly as the per-id LIMIT did) and
   * ordered by (rel, other) — so each id's window (cap+1) rows, order, and
   * truncated flag match edgeList byte-for-byte. Ids with no visible edges get
   * no entry (assembled as an empty edge list, as getOne's empty fetch is).
   */
  private async edgeListBatch(
    c: PoolClient,
    ids: readonly string[],
    dir: "out" | "in",
    cap = EDGE_CAP,
  ): Promise<Map<string, EdgeListResult>> {
    const map = new Map<string, EdgeListResult>();
    if (ids.length === 0) return map;
    const col = dir === "out" ? "from_id" : "to_id";
    const other = dir === "out" ? "to_id" : "from_id";
    const requiredJoin =
      dir === "in"
        ? `LEFT JOIN type_properties tp
             ON tp.type_id = o.type_id AND e.provenance = 'ref:' || tp.physical_name`
        : "";
    const requiredSelect = dir === "in" ? ", tp.required AS required" : "";
    const r = await c.query<{
      self: string;
      rel: string;
      other: string;
      provenance: string;
      deleted: boolean;
      title: string | null;
      type_name: string | null;
      required?: boolean | null;
    }>(
      `SELECT * FROM (
         SELECT e.${col} AS self, e.rel, e.${other} AS other, e.provenance,
                (o.deleted_at IS NOT NULL) AS deleted, o.title, ty.name AS type_name${requiredSelect},
                row_number() OVER (PARTITION BY e.${col} ORDER BY e.rel, e.${other}) AS rn
         FROM edges e JOIN objects o ON o.id = e.${other}
         LEFT JOIN types ty ON ty.id = o.type_id
         ${requiredJoin}
         WHERE e.${col} = ANY($1)
       ) sub
       WHERE sub.rn <= ${cap + 1}
       ORDER BY sub.self, sub.rn`,
      [ids],
    );
    for (const x of r.rows) {
      let g = map.get(x.self);
      if (!g) {
        g = { edges: [], truncated: false };
        map.set(x.self, g);
      }
      g.edges.push({
        rel: x.rel,
        id: x.other,
        provenance: x.provenance,
        target_deleted: x.deleted,
        target_title: x.title,
        target_type: x.type_name,
        ...(dir === "in" ? { required: x.required === true } : {}),
      });
    }
    // Per-id truncation: the window pulled cap+1, so a full cap+1 group means
    // "more exist" — trim to cap and flag, mirroring edgeList's LIMIT cap+1.
    for (const g of map.values()) {
      if (g.edges.length > cap) {
        g.truncated = true;
        g.edges.length = cap;
      }
    }
    return map;
  }

  // ---- list / count -----------------------------------------------------
  async list(
    ctx: ReadContext,
    typeName: string,
    opts: {
      where?: WhereNode;
      sort?: SortSpec;
      limit?: number;
      cursor?: string;
      /** list tombstones of this type instead of live objects (the trash). */
      deleted?: boolean;
      /** 'private' = my private objects; 'shared_with_me' = private objects
       *  others shared with me (RLS already limits rows to what I can see,
       *  so creator != me is sufficient). */
      visibility?: "private" | "shared_with_me";
      /** include scalar ext props on each item (dashboard tables; ref[] omitted). */
      props?: boolean;
    } = {},
  ): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null }> {
    return this.readTxn(ctx, async (c) => {
      const t = await loadTypeByName(c, typeName);
      const resolve = typeResolver(t);
      const params = new Params([t.id]);
      const conds = [
        "o.type_id = $1",
        opts.deleted ? "o.deleted_at IS NOT NULL" : "o.deleted_at IS NULL",
      ];
      if (opts.visibility) conds.push(this.visibilityCond(opts.visibility, ctx, params));
      if (opts.where) conds.push(compileWhere(opts.where, resolve, params));
      const sort = compileSort(opts.sort, resolve);
      if (opts.cursor) conds.push(keysetPredicate(sort, decodeCursor(opts.cursor), params));

      const limit = clampLimit(opts.limit);
      const sortSelect =
        sort.column.kind === "id" ? "o.id" : `${sort.column.sqlColumn} AS __sortval`;
      // Scalar props ride the existing ext join; ref[] needs junctions → omitted.
      const propCols = opts.props
        ? t.properties.filter((p) => !p.deprecated && p.kind !== "ref[]")
        : [];
      const propSelect = propCols
        .map((p) => `, e.${quoteIdentifier(p.physicalName)} AS ${quoteIdentifier(`p__${p.name}`)}`)
        .join("");
      const sql = `SELECT o.id, o.title, o.version, o.created_at, o.updated_at, o.visibility, ${sortSelect}${propSelect}
        FROM objects o JOIN ${quoteIdentifier(t.extTable)} e ON e.id = o.id
        WHERE ${conds.join(" AND ")}
        ORDER BY ${sort.orderBy}
        LIMIT ${limit + 1}`;
      const r = await c.query(sql, params.values);
      const rows = r.rows as Array<Record<string, unknown>>;

      let nextCursor: string | null = null;
      if (rows.length > limit) {
        const last = rows[limit - 1]!;
        const v = (sort.column.kind === "id" ? last["id"] : last["__sortval"]) as ScalarValue;
        nextCursor = encodeCursor({ v, id: last["id"] as string });
        rows.length = limit;
      }
      for (const row of rows) {
        delete row["__sortval"];
        if (propCols.length > 0) {
          const props: Record<string, unknown> = {};
          for (const p of propCols) {
            props[p.name] = row[`p__${p.name}`] ?? null;
            delete row[`p__${p.name}`];
          }
          row["props"] = props;
        }
      }
      return { items: rows, nextCursor };
    });
  }

  async count(
    ctx: ReadContext,
    typeName: string,
    opts: {
      where?: WhereNode;
      deleted?: boolean;
      visibility?: "private" | "shared_with_me";
    } = {},
  ): Promise<number> {
    return this.readTxn(ctx, async (c) => {
      const t = await loadTypeByName(c, typeName);
      const resolve = typeResolver(t);
      const params = new Params([t.id]);
      const conds = [
        "o.type_id = $1",
        opts.deleted ? "o.deleted_at IS NOT NULL" : "o.deleted_at IS NULL",
      ];
      if (opts.visibility) conds.push(this.visibilityCond(opts.visibility, ctx, params));
      if (opts.where) conds.push(compileWhere(opts.where, resolve, params));
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM objects o
         JOIN ${quoteIdentifier(t.extTable)} e ON e.id = o.id WHERE ${conds.join(" AND ")}`,
        params.values,
      );
      return Number(r.rows[0]!.n);
    });
  }

  // ---- graph ------------------------------------------------------------
  async neighbors(
    ctx: ReadContext,
    id: string,
    opts: { rel?: string; direction?: "out" | "in" | "both" } = {},
  ): Promise<Array<{ rel: string; id: string; direction: string; target_deleted: boolean }>> {
    return this.readTxn(ctx, async (c) => {
      const dir = opts.direction ?? "both";
      const out: Array<{ rel: string; id: string; direction: string; target_deleted: boolean }> =
        [];
      // ponytail: 1000 cap (was unbounded) — the rel filter runs after the
      // fetch, so the cap must comfortably exceed any real hub's degree
      if (dir === "out" || dir === "both") {
        for (const e of (await this.edgeList(c, id, "out", 1000)).edges) {
          if (!opts.rel || e.rel === opts.rel) out.push({ ...e, direction: "out" });
        }
      }
      if (dir === "in" || dir === "both") {
        for (const e of (await this.edgeList(c, id, "in", 1000)).edges) {
          if (!opts.rel || e.rel === opts.rel) out.push({ ...e, direction: "in" });
        }
      }
      return out;
    });
  }

  // (the old referrers() lives on inside getOne: backlinks carry `required`,
  //  and hidden_from_you is the definer-side census — one blast-radius surface)

  // ---- catalog / meta ---------------------------------------------------
  async listTypes(ctx: ReadContext): Promise<Array<Record<string, unknown>>> {
    return this.readTxn(ctx, (c) => this.listTypesIn(c));
  }

  /** All types WITH their properties + enum values inline (one catalog read). */
  private async listTypesIn(c: PoolClient): Promise<Array<Record<string, unknown>>> {
    // Annotate each type with its live (non-deleted) object count so the
    // dashboard can show at a glance how populated each type is.
    const types = await c.query<{ id: number }>(
      `SELECT t.id, t.name, t.label, t.description, t.deprecated, t.icon,
              COALESCE(oc.n, 0)::int AS count
         FROM types t
         LEFT JOIN (
           SELECT type_id, count(*) AS n
             FROM objects
            WHERE deleted_at IS NULL AND type_id IS NOT NULL
            GROUP BY type_id
         ) oc ON oc.type_id = t.id
        ORDER BY t.name`,
    );
    const props = await c.query<{
      id: number;
      type_id: number;
      name: string;
      kind: string;
      required: boolean;
      deprecated: boolean;
      ref_type: string | null;
    }>(
      `SELECT tp.id, tp.type_id, tp.name, tp.kind, tp.required, tp.deprecated,
              rt.name AS ref_type
         FROM type_properties tp
         LEFT JOIN types rt ON rt.id = tp.ref_type_id
        ORDER BY tp.type_id, tp.position, tp.id`,
    );
    const enums = await c.query<{ property_id: number; value: string }>(
      "SELECT property_id, value FROM enum_option WHERE NOT deprecated ORDER BY property_id, value",
    );
    const enumsByProp = new Map<number, string[]>();
    for (const e of enums.rows) {
      const list = enumsByProp.get(e.property_id) ?? [];
      list.push(e.value);
      enumsByProp.set(e.property_id, list);
    }
    return types.rows.map((t) => ({
      ...t,
      properties: props.rows
        .filter((p) => p.type_id === t.id)
        .map((p) => ({
          name: p.name,
          kind: p.kind,
          required: p.required,
          deprecated: p.deprecated,
          ...(p.ref_type ? { ref_type: p.ref_type } : {}),
          ...(p.kind === "enum" ? { enum_values: enumsByProp.get(p.id) ?? [] } : {}),
        })),
    }));
  }

  /**
   * Everything reference-shaped in one call: who you are, the types (with
   * properties), the members, the relationship verbs in use. Feeds both the
   * `catalog` tool and the `start` composition.
   */
  async catalog(ctx: ReadContext): Promise<{
    you: Record<string, unknown>;
    types: Array<Record<string, unknown>>;
    members: Array<Record<string, unknown>>;
    rels: string[];
  }> {
    return this.readTxn(ctx, async (c) => ({
      you: await this.whoamiIn(c, ctx),
      // Retired types stay out of the agent surface (start already filtered
      // them; catalog paying tokens for dead schema every session was the
      // bug). The dashboard reads listTypes and still sees them, and
      // define_type visible:true revives one by name without the catalog.
      types: (await this.listTypesIn(c)).filter((t) => !t["deprecated"]),
      members: await this.membersIn(c),
      rels: await this.listRelsIn(c),
    }));
  }

  async describeType(ctx: ReadContext, name: string): Promise<Record<string, unknown>> {
    return this.readTxn(ctx, async (c) => {
      const t = await loadTypeByName(c, name);
      const enums = await c.query<{ property_id: number; value: string; deprecated: boolean }>(
        `SELECT property_id, value, deprecated FROM enum_option
         WHERE type_id = $1 ORDER BY property_id, value`,
        [t.id],
      );
      return {
        id: t.id,
        name: t.name,
        physical_name: t.physicalName,
        deprecated: t.deprecated,
        properties: t.properties.map((p) => ({
          name: p.name,
          kind: p.kind,
          required: p.required,
          deprecated: p.deprecated,
          ref_type_id: p.refTypeId,
          enum_values: enums.rows.filter((e) => e.property_id === p.id).map((e) => e.value),
        })),
      };
    });
  }

  /** WHERE fragment for the list/count visibility filter. 'shared_with_me'
   *  needs no shared_with check: RLS already hides private rows I'm not on,
   *  so "private AND not mine" IS "shared with me". */
  private visibilityCond(
    mode: "private" | "shared_with_me",
    ctx: ReadContext,
    params: Params,
  ): string {
    const actor = params.push(ctx.actorId);
    return mode === "private"
      ? `o.visibility = 'private' AND o.created_by = ${actor}`
      : `o.visibility = 'private' AND o.created_by <> ${actor}`;
  }

  /** Untyped visibility listing (mirrors the untyped trash): all my private
   *  objects, or everything shared with me, plain recency order. */
  async listPrivate(
    ctx: ReadContext,
    mode: "private" | "shared_with_me",
    opts: { limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    return this.readTxn(ctx, async (c) => {
      const limit = clampLimit(opts.limit);
      const params = new Params();
      const r = await c.query(
        `SELECT o.id, o.title, ty.name AS type, o.created_by, o.updated_at
           FROM objects o LEFT JOIN types ty ON ty.id = o.type_id
          WHERE o.deleted_at IS NULL AND ${this.visibilityCond(mode, ctx, params)}
          ORDER BY o.updated_at DESC LIMIT ${limit}`,
        params.values,
      );
      return r.rows as Array<Record<string, unknown>>;
    });
  }

  async listDeleted(
    ctx: ReadContext,
    opts: { type?: string; limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    return this.readTxn(ctx, async (c) => {
      const limit = clampLimit(opts.limit);
      if (opts.type) {
        const t = await loadTypeByName(c, opts.type);
        const r = await c.query(
          `SELECT id, title, deleted_at FROM objects
           WHERE deleted_at IS NOT NULL AND type_id = $1 ORDER BY deleted_at DESC LIMIT ${limit}`,
          [t.id],
        );
        return r.rows as Array<Record<string, unknown>>;
      }
      const r = await c.query(
        `SELECT id, title, type_id, deleted_at FROM objects
         WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ${limit}`,
      );
      return r.rows as Array<Record<string, unknown>>;
    });
  }

  async listRels(ctx: ReadContext): Promise<string[]> {
    return this.readTxn(ctx, (c) => this.listRelsIn(c));
  }

  private async listRelsIn(c: PoolClient): Promise<string[]> {
    const r = await c.query<{ rel: string }>("SELECT DISTINCT rel FROM edges ORDER BY rel");
    return r.rows.map((x) => x.rel);
  }

  /**
   * Which of these paths are still mentioned by VISIBLE records, and by how
   * many each — the backlink check behind the filesystem's rename/rm warning.
   * Returns ONE entry per referenced path (count > 0), so the warning names
   * exactly the paths a record points at, not every path the script deleted.
   * RLS-scoped (counts only what the caller can see); best-effort over the
   * spine title/body (where agents write file paths, per doctrine), not every
   * typed text property. Bounded: caps the needle set at 20.
   */
  async referencingObjects(
    ctx: ReadContext,
    needles: readonly string[],
  ): Promise<Array<{ path: string; count: number }>> {
    const terms = [...new Set(needles.filter((n) => n.length >= 3))].slice(0, 20);
    if (terms.length === 0) return [];
    return this.readTxn(ctx, async (c) => {
      // unnest pairs each ORIGINAL path with its escaped LIKE pattern; the
      // LEFT JOIN keeps a 0 count for unreferenced paths (dropped below). RLS
      // on `objects` filters the join, so counts stay per-caller-visibility.
      const patterns = terms.map(
        (t) => `%${t.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
      );
      const r = await c.query<{ path: string; n: string }>(
        `SELECT nd.path, count(o.id)::text AS n
           FROM unnest($1::text[], $2::text[]) AS nd(path, pat)
           LEFT JOIN objects o
             ON o.deleted_at IS NULL AND (o.title LIKE nd.pat OR o.body LIKE nd.pat)
          GROUP BY nd.path`,
        [terms, patterns],
      );
      return r.rows
        .map((row) => ({ path: row.path, count: Number(row.n) }))
        .filter((row) => row.count > 0);
    });
  }

  async recent(
    ctx: ReadContext,
    opts: {
      limit?: number;
      sinceSeq?: number;
      afterSeq?: number;
      kinds?: "all" | "mutations";
      summary?: boolean;
    } = {},
  ): Promise<{ events: Array<Record<string, unknown>>; nextSeq: number | null; max_seq: number }> {
    if (opts.sinceSeq !== undefined && opts.afterSeq !== undefined)
      throw validationError(
        "pass at most one of since_seq (older events, newest first) or after_seq (newer events, oldest first)",
      );
    return this.readTxn(
      ctx,
      async (c) => {
        const limit = clampLimit(opts.limit);
        const forward = opts.afterSeq !== undefined;
        const params: unknown[] = [];
        const where: string[] = [];
        if (opts.sinceSeq !== undefined) {
          params.push(opts.sinceSeq);
          where.push(`ev.seq < $${params.length}`);
        }
        if (opts.afterSeq !== undefined) {
          params.push(opts.afterSeq);
          where.push(`ev.seq > $${params.length}`);
        }
        // Content is the default: live data showed call:* audit rows were 66%
        // of the table and drowned "what happened lately". The audit stream
        // stays fully readable — kinds:'all' opts in.
        if (opts.kinds !== "all") where.push("ev.kind NOT LIKE 'call:%'");
        const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const r = await c.query<{ seq: string }>(
          `SELECT ev.seq, ev.at, ev.actor, ${EVENT_ACTOR_FIELDS_SQL}, ev.kind, ev.target, ev.payload,
                ${EVENT_TARGET_FIELDS_SQL}, ${EVENT_SCHEMA_FIELDS_SQL}
         FROM events ev
         ${EVENT_ACTOR_JOIN_SQL}
         ${EVENT_TARGET_JOIN_SQL}
         ${EVENT_SCHEMA_JOIN_SQL}
         ${whereSql}
         ORDER BY ev.seq ${forward ? "ASC" : "DESC"} LIMIT ${limit + 1}`,
          params,
        );
        const rows = r.rows as Array<Record<string, unknown> & { seq: string }>;
        let nextSeq: number | null = null;
        if (rows.length > limit) {
          nextSeq = Number(rows[limit - 1]!.seq);
          rows.length = limit;
        }
        // The high-water mark, from the SAME snapshot as the page (the txn is
        // REPEATABLE READ via singleSnapshot) — it is a valid checkpoint only
        // once the caller has drained forward to nextSeq: null. Residual
        // caveat, accepted: seqs are assigned at insert but become visible at
        // commit, so an event from a write txn in flight at snapshot time can
        // carry seq ≤ max_seq and land after — closing that fully needs a
        // commit-ordered cursor (xid8 column + migration), not worth it while
        // write txns are milliseconds and sweeps are weekly.
        const tip = await c.query<{ m: string }>(
          "SELECT coalesce(max(seq), 0)::bigint AS m FROM events",
        );
        // Summarized by default: raw rows carry full payloads (call:write
        // args embed whole bodies — see summarizeEvent's comment), so an
        // ordinary recent() call with no options was returning up to 200 full
        // payloads unless the caller already knew to opt into summary:true.
        // Pass summary:false explicitly when the raw payload is actually needed.
        return {
          events: (opts.summary ?? true) ? rows.map(summarizeEvent) : rows,
          nextSeq,
          max_seq: Number(tip.rows[0]!.m),
        };
      },
      { singleSnapshot: true },
    );
  }

  async history(ctx: ReadContext, id: string): Promise<Record<string, unknown>> {
    return this.readTxn(ctx, async (c) => {
      // Short ids resolve here exactly as in get — history is read-only, so
      // the full-uuid safety rule for mutations doesn't apply, and the A/B
      // agent eval showed agents naturally feed rendered short ids to it.
      if (!FULL_UUID.test(id)) {
        const resolved = await this.resolveIdPrefix(c, id);
        if (!resolved) throw notFoundError(id, await this.didYouMean(c, id));
        id = resolved;
      }
      // Latest 20 revisions, snapshot bodies truncated: an object edited 100
      // times with a large body must not return megabytes here.
      const versions = await c.query(
        `SELECT bi.version, bi.at, bi."by", acc.name AS by_name,
                jsonb_build_object(
                  'title', bi.snapshot->>'title',
                  'body', left(bi.snapshot->>'body', 500)
                ) AS snapshot
         FROM before_image bi
         LEFT JOIN accounts acc ON acc.id = bi."by"
         WHERE bi.object_id = $1 ORDER BY bi.version DESC LIMIT 20`,
        [id],
      );
      const events = await c.query(
        `SELECT ev.seq, ev.at, ev.actor, ${EVENT_ACTOR_FIELDS_SQL}, ev.kind, ev.payload
         FROM events ev ${EVENT_ACTOR_JOIN_SQL}
         WHERE ev.target = $1 ORDER BY ev.seq DESC LIMIT 200`,
        [id],
      );
      return { id, versions: versions.rows, events: events.rows };
    });
  }

  async whoami(ctx: ReadContext): Promise<Record<string, unknown>> {
    return this.readTxn(ctx, (c) => this.whoamiIn(c, ctx));
  }

  private async whoamiIn(c: PoolClient, ctx: ReadContext): Promise<Record<string, unknown>> {
    const r = await c.query("SELECT id, name, role, scopes, status FROM accounts WHERE id = $1", [
      ctx.actorId,
    ]);
    if (r.rowCount === 0) throw notFoundError(ctx.actorId);
    return r.rows[0] as Record<string, unknown>;
  }

  async members(ctx: ReadContext): Promise<Array<Record<string, unknown>>> {
    return this.readTxn(ctx, (c) => this.membersIn(c));
  }

  private async membersIn(c: PoolClient): Promise<Array<Record<string, unknown>>> {
    const r = await c.query(
      `SELECT id, name, email, role, status, scopes FROM accounts
       WHERE role IN ('owner', 'member', 'viewer') ORDER BY role, name`,
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  // ---- dashboard aggregates (read-only enrichments) -----------------------

  /** Headline counts for the home masthead stats strip. */
  async stats(ctx: ReadContext): Promise<Record<string, number>> {
    return this.readTxn(ctx, async (c) => {
      const r = await c.query<{
        entities: string;
        untyped: string;
        relationships: string;
        events_today: string;
        types: string;
        members: string;
        owners: string;
      }>(
        `SELECT
           (SELECT count(*) FROM objects WHERE deleted_at IS NULL) AS entities,
           (SELECT count(*) FROM objects WHERE deleted_at IS NULL AND type_id IS NULL) AS untyped,
           (SELECT count(*) FROM edges) AS relationships,
           (SELECT count(*) FROM events WHERE at >= date_trunc('day', now())) AS events_today,
           (SELECT count(*) FROM types) AS types,
           (SELECT count(*) FROM accounts WHERE role IN ('owner','member','viewer') AND status = 'active') AS members,
           (SELECT count(*) FROM accounts WHERE role = 'owner' AND status = 'active') AS owners`,
      );
      const x = r.rows[0]!;
      return {
        entities: Number(x.entities),
        untyped: Number(x.untyped),
        relationships: Number(x.relationships),
        eventsToday: Number(x.events_today),
        types: Number(x.types),
        members: Number(x.members),
        owners: Number(x.owners),
      };
    });
  }

  /** Recent events, enriched with target title/type + actor name for the feed. */
  async activityFeed(
    ctx: ReadContext,
    opts: { limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    return this.readTxn(ctx, async (c) => {
      const limit = clampLimit(opts.limit);
      const r = await c.query(
        // 'call:*' tool-call audit rows (0019) are excluded from this human
        // feed: they fire on every read, have no target (would render as
        // "<actor> call:get the schema"), and duplicate the lifecycle events
        // for writes. The complete tool-call audit lives in the `recent` tool.
        `SELECT ev.seq, ev.kind, ev.at, ev.target, ev.payload,
                ${EVENT_ACTOR_FIELDS_SQL}, ${EVENT_TARGET_FIELDS_SQL}, ${EVENT_SCHEMA_FIELDS_SQL}
         FROM events ev
         ${EVENT_ACTOR_JOIN_SQL}
         ${EVENT_TARGET_JOIN_SQL}
         ${EVENT_SCHEMA_JOIN_SQL}
         WHERE ev.kind NOT LIKE 'call:%'
         ORDER BY ev.seq DESC LIMIT ${limit}`,
      );
      return r.rows as Array<Record<string, unknown>>;
    });
  }

  /** A sample of the most-connected live objects + the edges among them (home graph). */
  async graphSample(
    ctx: ReadContext,
    opts: { limit?: number } = {},
  ): Promise<{
    nodes: Array<{ id: string; title: string | null; type: string | null; degree: number }>;
    edges: Array<{ from: string; to: string }>;
  }> {
    return this.readTxn(ctx, async (c) => {
      // Cap matches the UI's MAX_SAMPLE (GraphView.tsx) — the force sim is
      // O(n²)/frame past this. Was hardcoded to 80 while the "load more"
      // button already stepped up to 320: every click past the first just
      // re-requested the same top-80 nodes and got them back, so "load
      // more" silently did nothing past the initial page.
      const limit = Math.min(Math.max(opts.limit ?? 24, 1), 320);
      const nodesR = await c.query<{
        id: string;
        title: string | null;
        type: string | null;
        degree: string;
      }>(
        `SELECT o.id, o.title, ty.name AS type,
                (SELECT count(*) FROM edges e WHERE e.from_id = o.id OR e.to_id = o.id) AS degree
         FROM objects o
         LEFT JOIN types ty ON ty.id = o.type_id
         WHERE o.deleted_at IS NULL
         ORDER BY degree DESC, o.updated_at DESC
         LIMIT ${limit}`,
      );
      const nodes = nodesR.rows.map((n) => ({
        id: n.id,
        title: n.title,
        type: n.type,
        degree: Number(n.degree),
      }));
      const ids = nodes.map((n) => n.id);
      let edges: Array<{ from: string; to: string }> = [];
      if (ids.length > 0) {
        const edgesR = await c.query<{ from_id: string; to_id: string }>(
          `SELECT DISTINCT from_id, to_id FROM edges
           WHERE from_id = ANY($1) AND to_id = ANY($1)`,
          [ids],
        );
        edges = edgesR.rows.map((e) => ({ from: e.from_id, to: e.to_id }));
      }
      return { nodes, edges };
    });
  }

  /**
   * The CTEs every `graphFull` statement shares, all inside the RLS read txn:
   *
   * - `vis` — the visible node set: alive AS OF the watermark, filtered.
   * - `ve`  — the visible edge set: `objects` is joined TWICE (once per
   *   endpoint, through `vis`), so an edge is returned only when BOTH
   *   endpoints are visible. Never fetch-then-filter in JS. RLS on `edges`
   *   (0012: "visible iff both endpoints are") is the second, independent
   *   layer; this join additionally excludes soft-deleted and
   *   filtered-out endpoints, which RLS does not.
   * - `deg` — degree over `ve` ONLY. graphSample counts every row in `edges`
   *   touching an object; a degree that includes a link the viewer cannot see
   *   tells them a private object exists and points at it. Degree, hub ranking
   *   and the orphans filter therefore all read the visible subgraph, which is
   *   why "orphan" means "orphan as far as you can see".
   */
  private graphFullCtes(p: Params, wm: string, filters?: GraphFullFilters): string {
    const wmp = `${p.push(wm)}::timestamptz`;
    // "alive as of the watermark": created before it and not yet deleted at it.
    // This is what keeps page 4 consistent with page 1 — an object deleted
    // mid-walk still resolves, so its already-delivered edges never dangle.
    const conds = [`o.created_at <= ${wmp}`, `(o.deleted_at IS NULL OR o.deleted_at > ${wmp})`];
    if (filters?.types !== undefined) {
      const types = filters.types;
      if (!Array.isArray(types)) throw validationError("filters.types must be an array");
      if (types.length > GRAPH_FILTER_TYPES_MAX) {
        throw validationError(`filters.types accepts at most ${GRAPH_FILTER_TYPES_MAX} entries`);
      }
      const names: string[] = [];
      let untyped = false;
      for (const t of types) {
        if (t === null) untyped = true;
        else if (typeof t === "string") names.push(t);
        else throw validationError("filters.types entries must be a type name or null (untyped)");
      }
      // an empty list is "no type filter", not "match nothing" — a UI that
      // clears every chip should show the graph, not a blank canvas.
      const or: string[] = [];
      if (names.length > 0) {
        or.push(`o.type_id IN (SELECT id FROM types WHERE name = ANY(${p.push(names)}::text[]))`);
      }
      if (untyped) or.push("o.type_id IS NULL");
      if (or.length > 0) conds.push(`(${or.join(" OR ")})`);
    }
    if (filters?.since !== undefined) {
      conds.push(
        `o.updated_at >= ${p.push(parseWatermark(filters.since, "filters.since"))}::timestamptz`,
      );
    }
    if (filters?.until !== undefined) {
      conds.push(
        `o.updated_at <= ${p.push(parseWatermark(filters.until, "filters.until"))}::timestamptz`,
      );
    }
    return `WITH vis AS (
        SELECT o.id, o.title, o.type_id, o.updated_at
        FROM objects o
        WHERE ${conds.join(" AND ")}
      ),
      ve AS (
        SELECT e.from_id, e.to_id, e.rel
        FROM edges e
        JOIN vis a ON a.id = e.from_id
        JOIN vis b ON b.id = e.to_id
        WHERE e.created_at <= ${wmp}
      ),
      deg AS (
        SELECT id, count(*) AS d
        FROM (SELECT from_id AS id FROM ve UNION ALL SELECT to_id AS id FROM ve) u
        GROUP BY id
      )`;
  }

  /**
   * The WHOLE visible brain as a graph, keyset-paged — the data path behind the
   * graph view. `graphSample` above stays exactly as it is: it is the fallback
   * path for brains larger than GRAPH_FULL_MAX, so it must not drift.
   *
   * Privacy (a graph leaks differently from a table — both rules are SQL, never
   * JS): an edge needs BOTH endpoints visible, and `degree` counts only visible
   * edges. See graphFullCtes.
   *
   * Paging is snapshot-consistent: page 1 records a watermark (the read txn's
   * `now()`), returns it, and carries it inside `nextCursor`; every later page
   * is served AS OF that instant. Without it, an object deleted between page 1
   * and page 4 leaves edges whose other endpoint never arrives. RLS is always
   * evaluated live — an object made private mid-walk simply disappears, and the
   * client drops edges referencing an unknown node (never a placeholder node,
   * which would recreate exactly the hidden-neighbour hint rule 2 prevents).
   *
   * Each edge is emitted exactly once, on the page carrying its higher-id
   * endpoint, so both of its endpoints have always already been delivered.
   *
   * Nothing here moves brain content off the box.
   */
  async graphFull(
    ctx: ReadContext,
    opts: {
      after?: string;
      limit?: number;
      watermark?: string;
      filters?: GraphFullFilters;
      /**
       * Force the top-degree sample path (one page, no cursor) even when the
       * visible brain is at or below GRAPH_FULL_MAX. The client asks for this
       * when a DEVICE cap will stop the walk before the server's own >MAX
       * threshold would: an ascending-uuid keyset slice cut short at the device
       * budget keeps an ARBITRARY subset and discards the hubs, whereas the
       * degree-ordered sample keeps exactly the most-connected `limit` nodes —
       * the same ranking a >MAX brain already gets. Ignored once paging has a
       * cursor (a sample never hands one out).
       */
      sample?: boolean;
      /**
       * Which nodes the sample keeps when it cannot keep them all. The default,
       * `"degree"`, keeps the most-connected nodes — right for drawing a graph,
       * where dropping the hubs shreds the picture. `"recency"` keeps the most
       * recently UPDATED nodes — right for a "what changed since T" read
       * (`/graph/changed`), where the nodes of interest are precisely the
       * fresh, often low-degree ones a degree sample systematically drops.
       * Sampling changes ORDER only, never membership rules: both orders rank
       * the same RLS-bound visible set, so no hidden node can appear.
       */
      sampleOrder?: "degree" | "recency";
    } = {},
  ): Promise<GraphFullResult> {
    const raw = opts.limit;
    const limit =
      raw === undefined || !Number.isFinite(raw) || raw < 1
        ? GRAPH_FULL_MAX
        : Math.min(Math.floor(raw), GRAPH_FULL_MAX);
    const cursor = opts.after ? decodeGraphCursor(opts.after) : null;
    const pinned =
      opts.watermark !== undefined ? parseWatermark(opts.watermark, "watermark") : cursor?.wm;
    return this.readTxn(
      ctx,
      async (c) => {
        // REPEATABLE READ pins THIS page's statements to one snapshot; the
        // watermark pins the whole WALK across independent transactions.
        const wm =
          pinned ??
          (await c.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString();
        const filters = opts.filters;

        // Only page 1 pays for the census — later pages are already committed
        // to the full path (a truncated response never hands out a cursor).
        if (cursor === null) {
          const cp = new Params();
          const totalR = await c.query<{ n: string }>(
            `${this.graphFullCtes(cp, wm, filters)} SELECT count(*) AS n FROM vis`,
            cp.values,
          );
          const total = Number(totalR.rows[0]!.n);
          if (total > GRAPH_FULL_MAX || opts.sample === true) {
            const sample = await this.graphFullSampleIn(
              c,
              wm,
              limit,
              filters,
              opts.sampleOrder ?? "degree",
            );
            return {
              ...sample,
              nextCursor: null,
              watermark: wm,
              // Only truncated when the sample could not hold everything. A
              // device-anticipated sample of a brain that fits shows it all, so
              // it says nothing was left out.
              truncated:
                total > sample.nodes.length
                  ? { shown: sample.nodes.length, total, reason: "size" as const }
                  : null,
            };
          }
        }

        const np = new Params();
        const afterP = cursor ? `${np.push(cursor.id)}::uuid` : null;
        const nodesR = await c.query<{
          id: string;
          title: string | null;
          type: string | null;
          degree: string;
        }>(
          `${this.graphFullCtes(np, wm, filters)}
           SELECT v.id, v.title, ty.name AS type, COALESCE(d.d, 0) AS degree
           FROM vis v
           LEFT JOIN types ty ON ty.id = v.type_id
           LEFT JOIN deg d ON d.id = v.id
           ${afterP ? `WHERE v.id > ${afterP}` : ""}
           ORDER BY v.id
           LIMIT ${limit + 1}`,
          np.values,
        );
        const more = nodesR.rows.length > limit;
        const rows = more ? nodesR.rows.slice(0, limit) : nodesR.rows;
        const nodes: GraphFullNode[] = rows.map((n) => ({
          id: n.id,
          title: n.title,
          type: n.type,
          degree: Number(n.degree),
        }));

        let edges: GraphFullEdge[] = [];
        const last = nodes.length > 0 ? nodes[nodes.length - 1]!.id : null;
        if (last !== null) {
          const ep = new Params();
          const ctes = this.graphFullCtes(ep, wm, filters);
          const lastP = `${ep.push(last)}::uuid`;
          // both endpoints delivered by this page or an earlier one, and at
          // least one of them new in this page ⇒ exactly-once delivery.
          const where = [`ve.from_id <= ${lastP}`, `ve.to_id <= ${lastP}`];
          if (cursor) {
            const aP = `${ep.push(cursor.id)}::uuid`;
            where.push(`(ve.from_id > ${aP} OR ve.to_id > ${aP})`);
          }
          const edgesR = await c.query<{ from_id: string; to_id: string; rel: string }>(
            `${ctes} SELECT ve.from_id, ve.to_id, ve.rel FROM ve WHERE ${where.join(" AND ")}`,
            ep.values,
          );
          edges = edgesR.rows.map((e) => ({ from: e.from_id, to: e.to_id, rel: e.rel }));
        }

        return {
          nodes,
          edges,
          nextCursor: more && last !== null ? encodeGraphCursor({ id: last, wm }) : null,
          watermark: wm,
          truncated: null,
        };
      },
      { singleSnapshot: true },
    );
  }

  /**
   * The >GRAPH_FULL_MAX fallback: the same top-degree sample `graphSample`
   * serves the home page, sized to the graph budget and computed over the
   * VISIBLE subgraph (so the sample cannot leak a degree the full path
   * refuses to). One page, no cursor — sampling and paging do not mix.
   * `degree` is the node's degree in the whole visible graph, not within the
   * sample, which is why a sampled node can show a degree higher than the
   * edges returned beside it.
   */
  private async graphFullSampleIn(
    c: PoolClient,
    wm: string,
    limit: number,
    filters?: GraphFullFilters,
    order: "degree" | "recency" = "degree",
  ): Promise<{ nodes: GraphFullNode[]; edges: GraphFullEdge[] }> {
    const np = new Params();
    // Both orders rank the SAME visible set (same CTEs, same RLS) — the choice
    // only decides which visible nodes survive the cut. See `sampleOrder`.
    const rank =
      order === "recency"
        ? "v.updated_at DESC, COALESCE(d.d, 0) DESC, v.id"
        : "COALESCE(d.d, 0) DESC, v.updated_at DESC, v.id";
    const nodesR = await c.query<{
      id: string;
      title: string | null;
      type: string | null;
      degree: string;
    }>(
      `${this.graphFullCtes(np, wm, filters)}
       SELECT v.id, v.title, ty.name AS type, COALESCE(d.d, 0) AS degree
       FROM vis v
       LEFT JOIN types ty ON ty.id = v.type_id
       LEFT JOIN deg d ON d.id = v.id
       ORDER BY ${rank}
       LIMIT ${limit}`,
      np.values,
    );
    const nodes: GraphFullNode[] = nodesR.rows.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type,
      degree: Number(n.degree),
    }));
    if (nodes.length === 0) return { nodes, edges: [] };
    const ep = new Params();
    const ctes = this.graphFullCtes(ep, wm, filters);
    const idsP = `${ep.push(nodes.map((n) => n.id))}::uuid[]`;
    const edgesR = await c.query<{ from_id: string; to_id: string; rel: string }>(
      `${ctes} SELECT ve.from_id, ve.to_id, ve.rel FROM ve
       WHERE ve.from_id = ANY(${idsP}) AND ve.to_id = ANY(${idsP})`,
      ep.values,
    );
    return {
      nodes,
      edges: edgesR.rows.map((e) => ({ from: e.from_id, to: e.to_id, rel: e.rel })),
    };
  }

  /** Live objects with no type — free-form notes outside every database. */
  async untypedObjects(
    ctx: ReadContext,
    opts: { limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    return this.readTxn(ctx, async (c) => {
      const limit = clampLimit(opts.limit);
      const r = await c.query(
        `SELECT o.id, o.title, o.version, o.updated_at, o.visibility,
                left(o.body, 160) AS snippet,
                (SELECT count(*) FROM edges e WHERE e.from_id = o.id OR e.to_id = o.id) AS degree
         FROM objects o
         WHERE o.deleted_at IS NULL AND o.type_id IS NULL
         ORDER BY o.updated_at DESC, o.id
         LIMIT ${limit}`,
      );
      return r.rows as Array<Record<string, unknown>>;
    });
  }

  /** The caller's private world: their own private objects + ones shared with
   *  them. RLS already restricts rows; `mine` splits the two groups. */
  async privateObjects(
    ctx: ReadContext,
    opts: { limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    return this.readTxn(ctx, async (c) => {
      const limit = clampLimit(opts.limit);
      const r = await c.query(
        `SELECT o.id, o.title, o.version, o.updated_at, ty.name AS type,
                left(o.body, 160) AS snippet,
                (o.created_by = $1) AS mine,
                a.name AS owner_name
         FROM objects o
         LEFT JOIN types ty ON ty.id = o.type_id
         LEFT JOIN accounts a ON a.id = o.created_by
         WHERE o.deleted_at IS NULL AND o.visibility = 'private'
         ORDER BY o.updated_at DESC, o.id
         LIMIT ${limit}`,
        [ctx.actorId],
      );
      return r.rows as Array<Record<string, unknown>>;
    });
  }

  /** Global trash: every tombstone the caller can see, across all types.
   *  Soft-delete keeps rows forever, so this is a real recycle bin. */
  async deletedObjects(
    ctx: ReadContext,
    opts: { limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    return this.readTxn(ctx, async (c) => {
      const limit = clampLimit(opts.limit);
      const r = await c.query(
        `SELECT o.id, o.title, o.deleted_at, ty.name AS type,
                left(o.body, 160) AS snippet,
                a.name AS deleted_by_name
         FROM objects o
         LEFT JOIN types ty ON ty.id = o.type_id
         LEFT JOIN accounts a ON a.id = o.deleted_by
         WHERE o.deleted_at IS NOT NULL
         ORDER BY o.deleted_at DESC, o.id
         LIMIT ${limit}`,
      );
      return r.rows as Array<Record<string, unknown>>;
    });
  }

  /** Most recently touched live objects, with a body snippet + relationship degree. */
  async recentObjects(
    ctx: ReadContext,
    opts: { limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    return this.readTxn(ctx, async (c) => {
      const limit = clampLimit(opts.limit);
      const r = await c.query(
        `SELECT o.id, o.title, o.version, o.updated_at, ty.name AS type,
                left(o.body, 160) AS snippet,
                (SELECT count(*) FROM edges e WHERE e.from_id = o.id OR e.to_id = o.id) AS degree
         FROM objects o
         LEFT JOIN types ty ON ty.id = o.type_id
         WHERE o.deleted_at IS NULL
         ORDER BY o.updated_at DESC, o.id
         LIMIT ${limit}`,
      );
      return r.rows as Array<Record<string, unknown>>;
    });
  }

  // ---- search -----------------------------------------------------------
  /**
   * Hybrid find-by-words, GBrain-shaped: gather → fuse → boost → graph →
   * rerank → diversify.
   *
   * Gather arms: lexical full-text always runs; a fuzzy title pass runs only
   * when full-text finds nothing (an ILIKE substring hit is far weaker signal
   * — blending it in unconditionally made results noisier than documented);
   * semantic (pgvector over body CHUNKS, pooled best-chunk-per-object) joins
   * when an embedder is wired AND the box has the chunks table, floored on
   * similarity so garbage queries still return zero hits. Arms fuse via RRF.
   *
   * Post-fusion: a bounded title boost lets the named thing win; graph
   * augmentation walks typed edges from the top seeds so factually-connected
   * objects surface even with zero word overlap (the arm embeddings can't
   * cover); an optional cross-encoder reranker reorders the head of the list;
   * a type-diversity cap stops one type from monopolizing the page.
   *
   * Pass semantic:false to skip the embed round-trip (dashboard search wants
   * lexical latency); graph:false skips the edge walk the same way.
   */
  async search(
    ctx: ReadContext,
    query: string,
    opts: {
      type?: string;
      limit?: number;
      semantic?: boolean;
      graph?: boolean;
      rerank?: boolean;
    } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const limit = clampLimit(opts.limit, SEARCH_DEFAULT_LIMIT);
    const fused = await this.gatherFused(ctx, query, opts, limit);
    // rerank:false skips the cross-encoder the same way semantic:false skips
    // the embed — the dashboard's as-you-type pass can't afford either.
    const reranked = opts.rerank === false ? fused : await this.applyRerank(query, fused);
    // LAST, on purpose. The title tier is an absolute rule, and every stage
    // above it re-sorts: the cross-encoder reorders its whole window by its own
    // score and knows nothing about titles, so tiering before it would simply
    // be undone on any box where the reranker actually loads (ours does; a dev
    // box with no model does not — which is exactly how this nearly shipped).
    return diversifyByType(applyTitleTiers(reranked, query), limit);
  }

  /**
   * Combined multi-query search: every paraphrase runs the full gather stack,
   * then the per-query rankings fuse via RRF into ONE deduplicated list — a
   * hit found by several phrasings collects several votes (GBrain's query
   * expansion, with the CALLER supplying the expansions for free). The
   * reranker scores the head once against the FIRST query, so callers pass
   * the user's original phrasing first, paraphrases after.
   */
  async searchCombined(
    ctx: ReadContext,
    queries: readonly string[],
    opts: {
      type?: string;
      limit?: number;
      semantic?: boolean;
      graph?: boolean;
      rerank?: boolean;
    } = {},
  ): Promise<Array<Record<string, unknown>>> {
    if (queries.length === 0) throw validationError("search needs at least one query");
    const limit = clampLimit(opts.limit, SEARCH_DEFAULT_LIMIT);
    const lists = await Promise.all(queries.map((q) => this.gatherFused(ctx, q, opts, limit)));
    const K = 60;
    const acc = new Map<string, { hit: Record<string, unknown>; score: number }>();
    for (const rows of lists) {
      rows.forEach((h, i) => {
        const id = h["id"] as string;
        const e = acc.get(id) ?? { hit: h, score: 0 };
        e.score += 1 / (K + i + 1);
        acc.set(id, e);
      });
    }
    const combined = [...acc.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 2)
      // keep each hit's own match/via provenance; only the rank is re-fused
      .map((e) => ({ ...e.hit, rank: e.score }));
    const reranked =
      opts.rerank === false ? combined : await this.applyRerank(queries[0]!, combined);
    // The user's own phrasing is queries[0]; paraphrases must not decide what
    // counts as "you named this thing".
    return diversifyByType(applyTitleTiers(reranked, queries[0]!), limit);
  }

  /** The gather stack shared by search()/searchCombined(): arms → RRF →
   * graph arm → title boost. Returns a limit*2-wide list so downstream
   * stages (rerank, diversity, cross-query fusion) have headroom. */
  private async gatherFused(
    ctx: ReadContext,
    query: string,
    opts: { type?: string; semantic?: boolean; graph?: boolean },
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (typeof query !== "string" || query.trim() === "") {
      throw validationError("search needs a non-empty query");
    }
    // Kick the embedding off CONCURRENTLY with the lexical txn (never inside
    // it — a slow embedder must not pin a pooled connection, and lexical must
    // not wait on the model). Best-effort: any failure degrades to lexical.
    const vecPromise: Promise<number[] | null> =
      opts.semantic !== false && this.embedQuery
        ? this.embeddingsReady()
            .then((ok) => (ok ? this.embedQuery!(query) : null))
            .catch(() => null)
        : Promise.resolve(null);
    const [lex, fuzzy] = await this.readTxn(ctx, async (c) => {
      const lexRows = await this.lexicalSearch(c, query, opts, limit);
      const fuzzyRows =
        lexRows.length === 0 ? await this.fuzzyTitleSearch(c, query, opts, limit) : [];
      return [lexRows, fuzzyRows];
    });
    const qvec = await vecPromise;
    const sem = qvec
      ? await this.readTxn(ctx, (c) => this.semanticSearch(c, qvec, opts, limit))
      : [];
    // Flow telemetry (counts and states only — never the query): makes
    // "search silently degraded to keywords" visible in the mcp_call line.
    const f = ctx.flow;
    if (f) {
      const add = (k: string, n: number) => (f[k] = ((f[k] as number) ?? 0) + n);
      add("queries", 1);
      add("fts", lex.length);
      add("semantic", sem.length);
      add("fuzzy", fuzzy.length);
      // "on" is sticky across a multi-query call; skipped = caller opted out.
      f["embedder"] =
        opts.semantic === false
          ? (f["embedder"] ?? "skipped")
          : qvec
            ? "on"
            : f["embedder"] === "on"
              ? "on"
              : "off";
    }
    const arms = [
      { rows: lex, mode: "fulltext" },
      { rows: sem, mode: "semantic" },
      { rows: fuzzy, mode: "title_fuzzy" },
    ];
    // Fuse wider than the page (headroom for boost/rerank/diversity to move
    // things), then narrow to `limit` only after every stage has voted.
    let fused = fuseRrf(arms, limit * 2);
    if (opts.graph !== false && fused.length > 0) {
      // The graph is a fourth ARM, not a post-hoc appendage: a preliminary
      // fusion picks the strongest seeds, the edge walk ranks their
      // neighborhood, and the walk's list re-fuses WITH the text arms. A hit
      // corroborated by both meaning and connectedness collects two votes
      // and climbs; a connected-only hit still surfaces on one.
      const graphRows = await this.graphArm(ctx, fused, opts);
      if (f) f["graph"] = ((f["graph"] as number) ?? 0) + graphRows.length;
      if (graphRows.length > 0) {
        fused = fuseRrf(
          [...arms, { rows: graphRows, mode: "graph", weight: GRAPH_ARM_WEIGHT }],
          limit * 2,
        );
      }
    }
    return this.applyDegreeBoostFrom(ctx, fused);
  }

  /**
   * Look up the DEGREE of each candidate and hand it to `applyDegreeBoost`.
   *
   * The count runs under the caller's RLS like every other read here, so it is
   * the degree you can SEE — an object held up by edges to things you cannot
   * read does not get to look like a hub to you. That matches the same
   * visible-only-degree rule the graph endpoints follow.
   */
  private async applyDegreeBoostFrom(
    ctx: ReadContext,
    fused: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const ids = fused.map((h) => h["id"]).filter((id): id is string => typeof id === "string");
    if (ids.length < 2) return fused;
    const rows = await this.readTxn(ctx, (c) =>
      c.query<{ id: string; degree: string }>(
        `SELECT o.id,
                (SELECT count(*) FROM edges e WHERE e.from_id = o.id OR e.to_id = o.id) AS degree
           FROM objects o
          WHERE o.id = ANY($1::uuid[]) AND o.deleted_at IS NULL`,
        [ids],
      ),
    );
    const degrees = new Map<string, number>();
    for (const r of rows.rows) degrees.set(r.id, Number(r.degree) || 0);
    return applyDegreeBoost(fused, degrees);
  }

  /**
   * Run several queries in one call, sharing ONE combined result budget
   * (MAX_LIMIT) across all of them — without this, a caller passing
   * `limit:200` with 10 queries would get up to 2000 hits back in a single
   * response (each query's limit applied independently), which is exactly
   * the "tool call fails because it returns too much output" failure mode.
   */
  async searchMany(
    ctx: ReadContext,
    queries: readonly string[],
    opts: {
      type?: string;
      limit?: number;
      semantic?: boolean;
      graph?: boolean;
      rerank?: boolean;
    } = {},
  ): Promise<Array<{ query: string; hits: Array<Record<string, unknown>> }>> {
    const requested = clampLimit(opts.limit, SEARCH_DEFAULT_LIMIT);
    const perQueryLimit = Math.max(1, Math.min(requested, Math.floor(MAX_LIMIT / queries.length)));
    return Promise.all(
      queries.map(async (q) => ({
        query: q,
        hits: await this.search(ctx, q, { ...opts, limit: perQueryLimit }),
      })),
    );
  }

  private async embeddingsReady(): Promise<boolean> {
    if (this.hasEmbeddings === undefined) {
      const r = await this.pool.query<{ ok: boolean }>(
        "SELECT to_regclass('public.object_chunks') IS NOT NULL AS ok",
      );
      this.hasEmbeddings = r.rows[0]!.ok;
    }
    return this.hasEmbeddings;
  }

  /**
   * The graph arm: walk typed edges outward from the strongest fused hits
   * and return the neighborhood as a RANKED LIST for reciprocal-rank fusion
   * with the text arms. This is the arm that finds "the customer of the
   * project Priya leads" when no words overlap — embeddings capture
   * similarity, edges capture facts. Ranking within the arm: neighbors
   * reached from MORE seeds first (corroborated connectedness), then by the
   * strength of the seed that reached them; hop 2 after hop 1. Bounded
   * everywhere (seed count, per-hop caps, two hops max) so a hub object
   * can't blow up a search. Runs under the caller's RLS.
   */
  private async graphArm(
    ctx: ReadContext,
    fused: Array<Record<string, unknown>>,
    opts: { type?: string },
  ): Promise<Array<Record<string, unknown>>> {
    const seeds = fused.slice(0, GRAPH_SEEDS).map((h) => ({
      id: h["id"] as string,
      title: (h["title"] as string) ?? "",
    }));
    const seedIds = new Set(seeds.map((s) => s.id));
    return this.readTxn(ctx, async (c) => {
      const hop1 = await this.graphNeighbors(c, seeds, seedIds, opts, GRAPH_HOP1_CAP);
      const rows: Array<Record<string, unknown>> = hop1.map((n) => this.graphRow(n));
      if (hop1.length > 0) {
        const exclude = new Set([...seedIds, ...hop1.map((n) => n.id)]);
        const hop1Seeds = hop1.map((n) => ({ id: n.id, title: n.title ?? "" }));
        const hop2 = await this.graphNeighbors(c, hop1Seeds, exclude, opts, GRAPH_HOP2_CAP);
        rows.push(...hop2.map((n) => this.graphRow(n)));
      }
      return rows;
    });
  }

  private graphRow(n: GraphNeighbor): Record<string, unknown> {
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      version: n.version,
      updated_at: n.updated_at,
      connections: n.connections,
      snippet: n.snippet,
      rank: 0,
      via: n.via,
    };
  }

  /** One hop of bounded neighbor expansion. Runs under the caller's RLS —
   * invisible objects simply don't join. */
  private async graphNeighbors(
    c: PoolClient,
    seeds: ReadonlyArray<{ id: string; title: string }>,
    exclude: ReadonlySet<string>,
    opts: { type?: string },
    cap: number,
  ): Promise<GraphNeighbor[]> {
    if (seeds.length === 0) return [];
    const params: unknown[] = [seeds.map((s) => s.id), [...exclude]];
    let typeCond = "";
    if (opts.type) {
      const t = await loadTypeByName(c, opts.type);
      params.push(t.id);
      typeCond = "AND o.type_id = $3";
    }
    const r = await c.query(
      `SELECT o.id, ty.name AS type, o.title, o.version::int AS version, o.updated_at,
              ${connectionsSql("o")} AS connections,
              left(coalesce(o.body, ''), 200) AS snippet,
              n.seed_count, n.best_seed_pos, n.rels
       FROM (
         SELECT e.nid, count(DISTINCT e.seed_pos) AS seed_count,
                min(e.seed_pos) AS best_seed_pos,
                array_agg(DISTINCT e.rel) AS rels
         FROM (
           SELECT CASE WHEN g.from_id = s.id THEN g.to_id ELSE g.from_id END AS nid,
                  s.pos AS seed_pos, g.rel
           FROM unnest($1::uuid[]) WITH ORDINALITY AS s(id, pos)
           JOIN edges g ON g.from_id = s.id OR g.to_id = s.id
         ) e
         GROUP BY e.nid
       ) n
       JOIN objects o ON o.id = n.nid
       LEFT JOIN types ty ON ty.id = o.type_id
       WHERE o.deleted_at IS NULL AND NOT (o.id = ANY($2::uuid[])) ${typeCond}
       ORDER BY n.seed_count DESC, n.best_seed_pos ASC, o.updated_at DESC
       LIMIT ${cap}`,
      params,
    );
    return r.rows.map((row: Record<string, unknown>) => {
      const seed = seeds[(row["best_seed_pos"] as number) - 1] ?? seeds[0]!;
      return {
        id: row["id"] as string,
        type: row["type"] as string | null,
        title: row["title"] as string | null,
        version: row["version"] as number,
        updated_at: row["updated_at"],
        connections: row["connections"] as number,
        snippet: row["snippet"] as string,
        via: { seed: seed.title, rels: row["rels"] as string[] },
      };
    });
  }

  /** Optional cross-encoder pass over the head of the fused list. The
   * reranker reads query+candidate jointly — hybrid ranking is locally
   * optimal per arm but globally suboptimal, and this is the stage that
   * fixes the ordering. Best-effort: null/throw keeps the fused order. */
  private async applyRerank(
    query: string,
    fused: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.rerank || fused.length < 2) return fused;
    const head = fused.slice(0, RERANK_WINDOW);
    const tail = fused.slice(RERANK_WINDOW);
    try {
      const scored = await this.rerank(
        query,
        head.map((h) => ({
          id: h["id"] as string,
          text: `${(h["title"] as string) ?? ""}\n${(h["snippet"] as string) ?? ""}`.trim(),
        })),
      );
      if (!scored) return fused;
      const byId = new Map(scored.map((s) => [s.id, s.score]));
      const reordered = [...head].sort(
        (a, b) =>
          (byId.get(b["id"] as string) ?? -Infinity) - (byId.get(a["id"] as string) ?? -Infinity),
      );
      return [...reordered, ...tail];
    } catch {
      return fused;
    }
  }

  /**
   * The healthy ext tables whose typed-field text should feed unscoped search:
   * a live (NOT deprecated) type whose ext table still has a `tsv` column. The
   * information_schema.columns probe proves BOTH table and column exist in one
   * shot — a box with a missing_ext_table / missing_column drift (drift.ts) is
   * silently skipped, never fatal. Memoized 30s (define_type adds tables live).
   */
  private async listExtTsvTables(c: PoolClient): Promise<string[]> {
    const cached = this.extTsvTables;
    if (cached && Date.now() - cached.at < EXT_TABLE_CACHE_MS) return cached.tables;
    const { rows } = await c.query<{ ext_table: string }>(
      `SELECT t.ext_table FROM types t
        WHERE t.ext_table IS NOT NULL AND NOT t.deprecated
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public'
               AND col.table_name = t.ext_table
               AND col.column_name = 'tsv')`,
    );
    const tables = rows.map((r) => r.ext_table);
    this.extTsvTables = { at: Date.now(), tables };
    return tables;
  }

  private async lexicalSearch(
    c: PoolClient,
    query: string,
    opts: { type?: string },
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    // Type-scoped: match title/body (objects.tsv) OR the typed text/enum
    // fields (ext.tsv), ranked by the better of the two. Unscoped: objects.tsv
    // (title/body across everything). A body over cap is bounded by the tsv
    // trigger's left(text, N), so oversized bodies are handled.
    //
    // Rank+LIMIT run in an inner subquery; ts_headline (a full text parse) and
    // the connections census decorate ONLY the surviving rows — computed in
    // the outer target list they'd otherwise run for EVERY tsv match before
    // the sort, turning a broad term on a big brain into seconds of CPU.
    const decorate = `SELECT h.id, h.type, h.title, h.version, h.updated_at, h.rank,
              ts_headline('english', left(coalesce(h.body, ''), 4000),
                          websearch_to_tsquery('english', $1),
                          'MaxWords=25, MinWords=8, MaxFragments=1') AS snippet,
              ${connectionsSql("h")} AS connections`;
    if (opts.type) {
      const t = await loadTypeByName(c, opts.type);
      const r = await c.query(
        `${decorate}
         FROM (
           SELECT o.id, ty.name AS type, o.title, o.body, o.version::int AS version,
                  o.updated_at,
                  greatest(
                    ts_rank_cd(coalesce(o.tsv, ''::tsvector), q),
                    ts_rank_cd(coalesce(e.tsv, ''::tsvector), q)
                  ) AS rank
           FROM objects o
             JOIN ${quoteIdentifier(t.extTable)} e ON e.id = o.id
             LEFT JOIN types ty ON ty.id = o.type_id,
             websearch_to_tsquery('english', $1) q
           WHERE o.deleted_at IS NULL AND o.type_id = $2
             AND (o.tsv @@ q OR e.tsv @@ q)
           ORDER BY rank DESC, o.id LIMIT ${limit}
         ) h
         ORDER BY h.rank DESC, h.id`,
        [query, t.id],
      );
      return r.rows as Array<Record<string, unknown>>;
    }
    // Unscoped: fuse objects.tsv (title/body) with every HEALTHY type's ext.tsv
    // (typed field text), so a plain search('aerospace') finds a client whose
    // industry='aerospace' even though the term is in no title/body. Each arm
    // carries its own ORDER BY rank LIMIT so fan-out is bounded to (N+1)*limit
    // rows regardless of term breadth; the final INNER JOIN back to objects is
    // the load-bearing visibility + deletion gate (deleted_at IS NULL). Drifted
    // / deprecated ext tables are skipped by listExtTsvTables, never fatal.
    const extTables = await this.listExtTsvTables(c);
    if (extTables.length === 0) {
      // Type-less brain: the exact objects-only query as before (plan-identical).
      const r = await c.query(
        `${decorate}
         FROM (
           SELECT o.id, ty.name AS type, o.title, o.body, o.version::int AS version,
                  o.updated_at, ts_rank_cd(o.tsv, q) AS rank
           FROM objects o
             LEFT JOIN types ty ON ty.id = o.type_id,
             websearch_to_tsquery('english', $1) q
           WHERE o.deleted_at IS NULL AND o.tsv @@ q
           ORDER BY rank DESC, o.id LIMIT ${limit}
         ) h
         ORDER BY h.rank DESC, h.id`,
        [query],
      );
      return r.rows as Array<Record<string, unknown>>;
    }
    const objectsArm = `(SELECT o.id, ts_rank_cd(o.tsv, q) AS rank
        FROM objects o, websearch_to_tsquery('english', $1) q
        WHERE o.deleted_at IS NULL AND o.tsv @@ q
        ORDER BY rank DESC, o.id LIMIT ${limit})`;
    const extArms = extTables.map(
      (ext) =>
        `(SELECT e.id, ts_rank_cd(e.tsv, q) AS rank
          FROM ${quoteIdentifier(ext)} e, websearch_to_tsquery('english', $1) q
          WHERE e.tsv @@ q
          ORDER BY rank DESC, e.id LIMIT ${limit})`,
    );
    const r = await c.query(
      `WITH matches AS (
         ${[objectsArm, ...extArms].join("\n         UNION ALL\n         ")}
       ),
       best AS (
         SELECT id, max(rank) AS rank FROM matches GROUP BY id
         ORDER BY rank DESC, id LIMIT ${limit}
       )
       ${decorate}
       FROM (
         SELECT o.id, ty.name AS type, o.title, o.body, o.version::int AS version,
                o.updated_at, best.rank
         FROM best
           JOIN objects o ON o.id = best.id
           LEFT JOIN types ty ON ty.id = o.type_id
         WHERE o.deleted_at IS NULL
       ) h
       ORDER BY h.rank DESC, h.id`,
      [query],
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  private async semanticSearch(
    c: PoolClient,
    qvec: number[],
    opts: { type?: string },
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    // Chunk-level nearest neighbors, pooled to the best chunk per OBJECT
    // before the limit — several chunks of one long doc must not fill the
    // page. The inner scan is the HNSW-ordered pass (fan-out gives pooling
    // room); DISTINCT ON keeps each object's closest chunk; the outer query
    // applies visibility, freshness, floor, and the page limit.
    //
    // source_version must match: a stale vector describes content the object
    // no longer has. Freshness lag = one sweep tick; lexical still covers the
    // gap, so hiding stale vectors beats ranking by outdated meaning. The
    // matched CHUNK text is the snippet — the passage that actually matched,
    // not the document head.
    const vec = `[${qvec.join(",")}]`;
    const params: unknown[] = [vec];
    let typeCond = "";
    if (opts.type) {
      const t = await loadTypeByName(c, opts.type);
      params.push(t.id);
      typeCond = "AND o.type_id = $2";
    }
    // The similarity floor keeps nearest-neighbor noise out: without it, ANY
    // query returns `limit` hits and zero-hit results become impossible.
    const r = await c.query(
      `SELECT o.id, ty.name AS type, o.title, o.version::int AS version, o.updated_at,
              ${connectionsSql("o")} AS connections,
              left(best.text, 200) AS snippet,
              best.sim::float4 AS rank
       FROM (
         SELECT DISTINCT ON (nn.object_id)
                nn.object_id, nn.text, nn.sim, nn.source_version
         FROM (
           SELECT ch.object_id, ch.text, ch.source_version,
                  1 - (ch.embedding <=> $1::vector) AS sim
           FROM object_chunks ch
           ORDER BY ch.embedding <=> $1::vector
           LIMIT ${limit * SEMANTIC_CHUNK_FAN}
         ) nn
         ORDER BY nn.object_id, nn.sim DESC
       ) best
         JOIN objects o ON o.id = best.object_id AND best.source_version = o.version
         LEFT JOIN types ty ON ty.id = o.type_id
       WHERE o.deleted_at IS NULL ${typeCond}
         AND best.sim >= ${SEMANTIC_SIMILARITY_FLOOR}
       ORDER BY best.sim DESC, o.id LIMIT ${limit}`,
      params,
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  /** Substring match on titles — catches typos and partial words. */
  private async fuzzyTitleSearch(
    c: PoolClient,
    query: string,
    opts: { type?: string },
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    // ponytail: ILIKE seq-scan on titles — add pg_trgm indexing if brains get big
    const raw = query.trim();
    const pattern = `%${raw.replace(/([\\%_])/g, "\\$1")}%`;
    const params: unknown[] = [pattern, raw];
    let typeCond = "";
    if (opts.type) {
      const t = await loadTypeByName(c, opts.type);
      params.push(t.id);
      typeCond = "AND o.type_id = $3";
    }
    // ORDERED BY MATCH QUALITY, NOT RECENCY.
    //
    // This used to be `ORDER BY o.updated_at DESC` — which is not a ranking of
    // anything, and it decides which rows exist: with `LIMIT n` over every
    // title containing the string, the BEST match can sort last, or fall off
    // the end and never reach the fusion at all. No downstream boost can
    // rescue a row that was never returned. Exact first, then prefix, then the
    // tightest title (a name in a 16-char title answers the query harder than
    // the same name inside a 90-char document heading), and recency only as
    // the final tie-break.
    const r = await c.query(
      `SELECT o.id, ty.name AS type, o.title, o.version::int AS version, o.updated_at,
              ${connectionsSql("o")} AS connections,
              left(coalesce(o.body, ''), 160) AS snippet, 0 AS rank
       FROM objects o LEFT JOIN types ty ON ty.id = o.type_id
       WHERE o.deleted_at IS NULL AND o.title ILIKE $1 ${typeCond}
       ORDER BY (lower(o.title) = lower($2)) DESC,
                (lower(o.title) LIKE lower($2) || '%') DESC,
                length(o.title) ASC,
                o.updated_at DESC, o.id
       LIMIT ${limit}`,
      params,
    );
    return r.rows as Array<Record<string, unknown>>;
  }
}

/** Everything a graph hop needs to become a result row. */
interface GraphNeighbor {
  id: string;
  type: string | null;
  title: string | null;
  version: number;
  updated_at: unknown;
  connections: number;
  snippet: string;
  via: { seed: string; rels: string[] };
}

/** How strongly a title answers this query. See `TITLE_TIER`. */
export function titleTier(title: string | null | undefined, query: string): number {
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
  const t = norm(title ?? "");
  const q = norm(query);
  if (t === "" || q === "") return TITLE_TIER.none;
  if (t === q) return TITLE_TIER.exact;
  // Prefix, so the tier EXISTS WHILE TYPING. The old rule needed the whole
  // query as a completed token run, so "meenakshi sharm" scored nothing and
  // the person you were mid-way through naming had no advantage at all until
  // the final keystroke — the worst moment to have none.
  if (t.startsWith(q)) return TITLE_TIER.prefix;
  // Token-run containment, padded so "ora" never matches inside "orange".
  if (` ${t} `.includes(` ${q} `)) return TITLE_TIER.contains;
  return TITLE_TIER.none;
}

/**
 * Order by title tier first, fused score second.
 *
 * A STABLE sort on a list that is already score-ordered, so within a tier the
 * existing order (RRF + degree) is preserved exactly — this only lifts whole
 * tiers past each other, it never reshuffles peers.
 */
function applyTitleTiers(
  fused: Array<Record<string, unknown>>,
  query: string,
): Array<Record<string, unknown>> {
  if (fused.length < 2) return fused;
  const tiers = new Map<unknown, number>();
  let lifted = false;
  for (const h of fused) {
    const tier = titleTier(h["title"] as string | null, query);
    tiers.set(h, tier);
    if (tier > TITLE_TIER.none) lifted = true;
  }
  // Nothing matched by title: leave the list exactly as the arms ranked it.
  if (!lifted) return fused;
  const sorted = [...fused].sort((a, b) => (tiers.get(b) ?? 0) - (tiers.get(a) ?? 0));
  // Restate `rank` so the NUMBER explains the ORDER. Sorting by tier alone
  // leaves a hit at 1.0 above one at 1.59, which reads as a bug to anything
  // that displays the score — and would silently undo the tiering in any
  // consumer that re-sorts by it. One tier is worth more than the whole score
  // range below it, so the separation is exact; within a tier the original
  // spacing (RRF + degree) is preserved, because that is still the real signal.
  const span = fused.reduce((m, h) => Math.max(m, (h["rank"] as number) ?? 0), 0) + 1;
  return sorted.map((h) => {
    const rank = h["rank"];
    if (typeof rank !== "number") return h;
    return { ...h, rank: rank + (tiers.get(h) ?? 0) * span };
  });
}

/**
 * Bounded connectedness boost, applied AFTER the title boost.
 *
 * `log1p(deg)/log1p(maxDeg)` rather than `deg/maxDeg`: degree is heavy-tailed,
 * so a linear ratio hands almost the whole boost to one super-hub and leaves
 * every ordinary object indistinguishable. The log spreads the middle, which is
 * where the actual ties are.
 *
 * Degrees come from the caller (one query over the candidate ids) so this stays
 * pure and testable, and an id we have no degree for scores 0 rather than
 * throwing — a hit that arrived from an arm the degree query did not cover must
 * not vanish from the results.
 */
export function applyDegreeBoost(
  fused: Array<Record<string, unknown>>,
  degrees: ReadonlyMap<string, number>,
): Array<Record<string, unknown>> {
  if (fused.length < 2 || degrees.size === 0) return fused;
  let maxDeg = 0;
  for (const d of degrees.values()) if (d > maxDeg) maxDeg = d;
  if (maxDeg <= 0) return fused;
  const denom = Math.log1p(maxDeg);
  const out = fused.map((h) => {
    const rank = h["rank"];
    const id = h["id"];
    if (typeof rank !== "number" || typeof id !== "string") return h;
    const deg = degrees.get(id) ?? 0;
    return { ...h, rank: rank * (1 + DEGREE_BOOST_MAX * (Math.log1p(deg) / denom)) };
  });
  return out.sort((a, b) => ((b["rank"] as number) ?? 0) - ((a["rank"] as number) ?? 0));
}

/**
 * Type-diversity cap: when several types matched, no single type may take
 * more than TYPE_DIVERSITY_SHARE of the page — a brain full of meeting notes
 * shouldn't answer every query with ONLY meeting notes when a person and a
 * decision also matched. Deferred hits backfill remaining slots at the end,
 * so the page is never left short when candidates exist.
 */
function diversifyByType(
  fused: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  const types = new Set(fused.map((h) => (h["type"] as string | null) ?? "note"));
  if (fused.length <= limit || types.size < 2) return fused.slice(0, limit);
  const cap = Math.max(1, Math.ceil(limit * TYPE_DIVERSITY_SHARE));
  const perType = new Map<string, number>();
  const page: Array<Record<string, unknown>> = [];
  const deferred: Array<Record<string, unknown>> = [];
  for (const h of fused) {
    if (page.length >= limit) break;
    const t = (h["type"] as string | null) ?? "note";
    const n = perType.get(t) ?? 0;
    if (n >= cap) {
      deferred.push(h);
      continue;
    }
    perType.set(t, n + 1);
    page.push(h);
  }
  for (const h of deferred) {
    if (page.length >= limit) break;
    page.push(h);
  }
  return page;
}

/**
 * Reciprocal-rank fusion across the search arms. One non-empty arm passes
 * through untouched (native ranks); with several, positions fuse via RRF.
 * The match flag reports the strongest provenance: title_fuzzy only when a
 * hit was found by NOTHING but the fuzzy pass — so "approximate" stays an
 * honest signal.
 */
function fuseRrf(
  lists: Array<{ rows: Array<Record<string, unknown>>; mode: string; weight?: number }>,
  limit: number,
): Array<Record<string, unknown>> {
  const active = lists.filter((l) => l.rows.length > 0);
  if (active.length === 0) return [];
  if (active.length === 1) {
    return active[0]!.rows.slice(0, limit).map((h) => ({ ...h, match: active[0]!.mode }));
  }
  const K = 60;
  const acc = new Map<string, { hit: Record<string, unknown>; score: number; modes: string[] }>();
  for (const { rows, mode, weight } of active) {
    rows.forEach((h, i) => {
      const id = h["id"] as string;
      const e = acc.get(id) ?? { hit: h, score: 0, modes: [] };
      e.score += (weight ?? 1) / (K + i + 1);
      e.modes.push(mode);
      // a graph row carries the via annotation; keep it on the merged hit so
      // "how is this connected" survives even when a text arm found it first
      if (h["via"] !== undefined && e.hit["via"] === undefined) {
        e.hit = { ...e.hit, via: h["via"] };
      }
      acc.set(id, e);
    });
  }
  const label = (modes: string[]): string => {
    const ft = modes.includes("fulltext");
    const sem = modes.includes("semantic");
    if (ft && sem) return "both";
    if (ft) return "fulltext";
    if (sem) return "semantic";
    if (modes.includes("graph")) return "graph";
    return "title_fuzzy";
  };
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => ({ ...e.hit, rank: e.score, match: label(e.modes) }));
}
