import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { pendingConfirmation, refusedError, sendToken, validationError } from "@brain/shared";
import {
  composeStart,
  ORG_CONTEXT_TEMPLATE,
  PERSONAL_CONTEXT_TEMPLATE,
  type CatalogSnapshot,
} from "./doctrine.js";
import { deriveTypeIcon } from "@brain/schema";
import type { SchemaExecutor, PropertyKind } from "@brain/schema";
import type { AuthedContext } from "./auth.js";
import type { Scope } from "./write-path.js";
import { requireScope } from "./auth.js";
import type { Reader } from "./reader.js";
import { coerceWhere, type WhereNode } from "./query-ast.js";
import type { Writer, WriteContext } from "./write-path.js";
import type { Admin } from "./admin.js";
import type { FsStore } from "./fs-store.js";
import { runBash, type BashRunCtx } from "./bash.js";

/**
 * The MCP tool surface (v2 — 18 tools), transport-agnostic so it can be
 * exercised directly in tests and mounted on the Streamable HTTP server. Each
 * tool validates its args (zod), enforces scope, and calls the right layer:
 * reads/writes as brain_app, schema ops via the brain_owner executor.
 *
 * With the behavior doctrine out of `start` (being re-derived by testing),
 * the DESCRIPTIONS carry all the teaching — they state each tool's semantics,
 * limits, and the non-obvious rules an agent must know to use it right.
 */
export interface ToolDeps {
  readonly reader: Reader;
  readonly writer: Writer;
  readonly admin: Admin;
  readonly executor: SchemaExecutor;
  /** The brain filesystem (fs_entries behind RLS) — the bash tool's backend
   *  and the source of the caller's /home/<slug> line in start. Required: the
   *  filesystem IS a core surface, not an optional attachment feature. */
  readonly fsStore: FsStore;
  /** Present when the box wires custom connectors (owner-defined HTTP
   *  connectors, apps/box/src/connectors/custom.ts): dispatches a dynamic
   *  `<slug>_fetch` tool call (incl. samgov's bespoke rails). The box does
   *  the config-row gate and throws the teaching error itself; the registry
   *  only synthesizes the tool def so validation + call-audit apply. */
  readonly custom?: {
    fetch(toolName: string, args: CustomFetchToolArgs, accountId: string): Promise<unknown>;
  };
  /** The CALLER's live usable connectors as pre-rendered display lines for
   *  start (same per-caller gating as tools/list visibility: org config rows,
   *  plus this member's own OAuth/personal rows). Absent → start renders no
   *  connectors section. */
  readonly connectors?: (accountId: string) => Promise<readonly string[]>;
  /** Present when the box wires the Google connector: one authenticated
   *  proxy + a few convenience actions, all running as the CALLING account's
   *  connected Google identity (per-member OAuth tokens from the encrypted
   *  vault, refreshed server-side). tools/list visibility is handled by the
   *  box (requires.connector + the catalog), not through these deps. */
  readonly google?: {
    /** empty/unrecognized call → the live usage doctrine. */
    doctrine(accountId: string): Promise<unknown>;
    call(
      accountId: string,
      req: { path: string; params?: Record<string, string>; method?: string; body?: unknown },
    ): Promise<unknown>;
    searchMail(accountId: string, q: string, maxResults: number): Promise<unknown>;
    readMail(accountId: string, messageId: string): Promise<unknown>;
    send(
      accountId: string,
      msg: { to: string; cc?: string; subject: string; text: string },
    ): Promise<unknown>;
  };
  /** Present when the box wires the Microsoft 365 connector: same shape as
   *  google minus the mail helpers (Graph is plain JSON end to end — nothing
   *  needs decoding or RFC822 building). */
  readonly microsoft?: {
    /** empty/unrecognized call → the live usage doctrine. */
    doctrine(accountId: string): Promise<unknown>;
    call(
      accountId: string,
      req: { path: string; params?: Record<string, string>; method?: string; body?: unknown },
      /** the outbound-send confirm token; a sendMail POST previews without it. */
      confirm?: string,
    ): Promise<unknown>;
  };
}

interface ToolDef<A> {
  readonly description: string;
  readonly inputSchema: z.ZodType<A>;
  readonly handler: (deps: ToolDeps, ctx: AuthedContext, args: A) => Promise<unknown>;
  /**
   * Rescue hook, run on the RAW args before schema validation. For arg shapes
   * that stale/sloppy clients demonstrably send and that have exactly one
   * meaning (a JSON-stringified object, a shorthand map), normalize mutates
   * them into the advertised shape instead of letting validation fail the
   * call. Throw a BrainError here for the un-rescuable variants — it reaches
   * the caller verbatim, so make it teach.
   */
  readonly normalize?: (raw: Record<string, unknown>) => void;
  /**
   * Who this tool is advertised to in tools/list. Call-time is still enforced
   * independently (DB role checks + requireScope) — this only stops a caller
   * from SEEING a tool they can't use: `owner` → owners only; `scope` → callers
   * holding that scope; `connector` → callers the provider is USABLE by, as
   * decided by box.ts from the connector catalog: an org-keyed provider
   * (samgov) is usable by everyone once an owner configures it; a per-member
   * OAuth provider (google) additionally needs THIS caller's connected
   * account. The surface never bloats with tools a caller can't use yet.
   * Absent → everyone (the read surface).
   *
   * DOCTRINE: every connector-backed tool MUST declare `connector` with its
   * catalog provider slug — the Connectors dashboard page is the discovery
   * surface, not the tool list.
   */
  readonly requires?: {
    readonly scope?: Scope;
    readonly owner?: boolean;
    readonly connector?: string;
  };
}

function tool<A>(def: ToolDef<A>): ToolDef<A> {
  return def;
}

const wctx = (ctx: AuthedContext): WriteContext => ({
  actorId: ctx.actorId,
  scopes: ctx.scopes,
});

const googleNotEnabled = () =>
  refusedError(
    "the Google connector is not enabled on this box",
    "an owner adds the org's Google OAuth client on the dashboard's Connectors page; " +
      "then each member clicks Connect there to link their own Google account",
  );

const microsoftNotEnabled = () =>
  refusedError(
    "the Microsoft 365 connector is not enabled on this box",
    "an owner adds the org's Entra app registration on the dashboard's Connectors page; " +
      "then each member clicks Connect there to link their own Microsoft account",
  );

const idStr = z.string().uuid();
// get() alone also accepts a truncated id — a real uuid head: the first hex
// group (8 chars) intact, optionally more — and answers a miss with
// did_you_mean. Anything with a dash inside the first 8 chars is malformed
// and stays a crisp validation error, not a bare not_found.
const idOrPrefix = z
  .string()
  .regex(/^[0-9a-fA-F]{8}[0-9a-fA-F-]{0,28}$/, "a full uuid, or at least its first 8 characters");
// z.record(z.unknown()), NOT z.any() — zodToJsonSchema renders bare z.any()
// as an empty {} schema (no "type"), the same bug fixed on the google/
// microsoft `body` param: MCP clients that serialize args off the advertised
// schema stringify a typeless field, so a caller's structured where clause
// went out as a JSON string and compileWhere saw a string, not an object —
// "malformed where clause" on every filtered list() call. The actual where
// AST shape (and/or/not/field+op+value) is validated by compileWhere itself;
// this only needs to advertise "it's an object" so clients stop stringifying.
// Advertised as a plain object ON PURPOSE — advertising string|object teaches
// clients to stringify (the original stale-schema bug). Stale clients that DO
// send a JSON string are rescued before validation by list's `normalize` hook
// (coerceWhere), so the advertised contract stays strict while the runtime is
// tolerant.
const whereSchema = z.record(z.unknown()).optional();
const sortSchema = z
  .object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() })
  .optional();
const PROP_KINDS = [
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

// A body edit op, validated at the edge so a typo'd op is rejected up front
// instead of silently no-op'ing.
const bodyOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append"), text: z.string() }),
  z.object({ op: z.literal("prepend"), text: z.string() }),
  z.object({ op: z.literal("set"), text: z.string() }),
  z.object({
    op: z.literal("find_replace"),
    find: z.string().min(1),
    replace: z.string(),
    expectCount: z.number().int().nonnegative(),
  }),
]);

// An inline edge on write/edit: exactly one of to/from (checked in the write
// path so the error message is consistent across tools).
const linkSchema = z.object({
  rel: z.string(),
  to: idStr.optional(),
  from: idStr.optional(),
});

const propertySchema = z.object({
  name: z.string(),
  kind: z.enum(PROP_KINDS),
  ref_type_name: z.string().optional(),
  required: z.boolean().optional(),
  enum_values: z.array(z.string()).optional(),
});

/** Classify a connector proxy result's payload for flow telemetry — kind
 *  only, never the content. */
function contentKind(r: unknown): "binary" | "text" | "json" {
  const data = (r as { data?: { encoding?: string; text?: string } } | null)?.data;
  return data?.encoding === "base64" ? "binary" : typeof data?.text === "string" ? "text" : "json";
}

export const TOOLS: Record<string, ToolDef<never>> = {
  // ---- orient ----
  start: tool({
    description:
      "Begin a session — call this FIRST. Returns who you are and this brain's current " +
      "catalog: every type with its properties and enum values, all members (name, id, " +
      "role), and the relationship verbs in use.",
    inputSchema: z.object({}),
    handler: async (d, c) => {
      const cat = await d.reader.catalog(c);
      const acct = cat.you as { name: string; role: string };
      // Home-less accounts (service bots) still get start — just no home line.
      // Every lookup below is garnish: each fails to "section absent", never
      // breaking start (no skill type yet, no context file, connector outage).
      const [slug, connectors, skillPage] = await Promise.all([
        d.fsStore.homeSlug(c.actorId).catch(() => undefined),
        d.connectors ? d.connectors(c.actorId).catch(() => []) : [],
        d.reader.list(c, "skill", { limit: 30, props: true }).catch(() => undefined),
      ]);
      // The standing-context files ALWAYS exist: a missing one is seeded with
      // its template by the first write-scoped start, so the sections are
      // discoverable on every box with zero manual setup. Read-only callers
      // never write; a seeding failure (lock, quota) falls back to absent.
      const canSeed = c.scopes.includes("write");
      const readOrSeed = (path: string, template: string): Promise<string | undefined> =>
        d.fsStore.read({ actorId: c.actorId }, path).then(
          (r) => r.bytes.toString("utf8"),
          async () => {
            if (!canSeed) return undefined;
            return d.fsStore
              .write({ actorId: c.actorId }, path, Buffer.from(template, "utf8"))
              .then(
                () => template,
                () => undefined,
              );
          },
        );
      const [orgContext, personalContext] = await Promise.all([
        readOrSeed("/shared/start.md", ORG_CONTEXT_TEMPLATE),
        slug !== undefined
          ? readOrSeed(`/home/${slug}/start.md`, PERSONAL_CONTEXT_TEMPLATE)
          : undefined,
      ]);
      const skills = skillPage?.items.map((it) => {
        const trigger = (it["props"] as Record<string, unknown> | undefined)?.["when_to_run"];
        const title = String(it["title"] ?? "");
        return typeof trigger === "string" && trigger.trim() !== ""
          ? `${title} — ${trigger.trim()}`
          : title;
      });
      return {
        text: composeStart(acct, cat as unknown as CatalogSnapshot, slug, connectors, {
          ...(skills && skills.length > 0
            ? { skills, moreSkills: skillPage!.nextCursor !== null }
            : {}),
          ...(orgContext !== undefined ? { orgContext } : {}),
          ...(personalContext !== undefined ? { personalContext } : {}),
        }),
      };
    },
  }),
  catalog: tool({
    description:
      "The brain's reference data, fresh: you (the calling account), types with their " +
      "properties and enum values, members (name, id, role), and relationship verbs in " +
      "use. Call it mid-session to re-check the schema or look up a member id — cheaper " +
      "than re-calling start.",
    inputSchema: z.object({}),
    handler: (d, c) => d.reader.catalog(c),
  }),

  // ---- find ----
  search: tool({
    description:
      "Find objects by meaning AND words (hybrid semantic + full-text). Plain words " +
      "match stemmed whole words in titles/bodies — NOT substrings: 'northw' will not " +
      "match 'Northwind'; multiple words are ANDed; \"quoted phrases\" and OR work. " +
      "Conceptual queries also work when the box has semantic search: 'who handles " +
      "invoices' can find a billing-ownership doc that never says 'invoices' " +
      "(match:'semantic'). BEST PRACTICE for concept-ish questions: pass queries:[...] " +
      "with the original phrasing FIRST plus 2-3 paraphrases using different " +
      "vocabulary, and combine:true — the paraphrases' results fuse into ONE " +
      "deduplicated ranked list where hits found by several phrasings rise to the " +
      "top. Without combine, queries:[...] returns per-query groups (limit stays a " +
      "shared budget across the batch either way, so the response never balloons). " +
      "Results may also include match:'graph' hits — objects CONNECTED to your strong " +
      "matches (via says through what), useful for multi-hop questions. When full-text " +
      "finds nothing, a fuzzy title pass runs automatically — match:'title_fuzzy' hits " +
      "are approximate. IMPORTANT: semantic/graph hits are RELATED to your question, " +
      "not proof they answer it — semantic search always returns the nearest things it " +
      "has, even when the brain doesn't contain the answer. Read a hit (get) before " +
      "asserting from it; if nothing read actually answers, say the brain doesn't " +
      "have it rather than paraphrasing a near-miss into a claim. Hits render one " +
      "per line: short id (pass it to get — it resolves), type, title, updated " +
      "date, connections, match arm, snippet. " +
      "Zero hits does NOT mean it doesn't exist — try different words or list by type " +
      "before concluding that.",
    inputSchema: z
      .object({
        query: z.string().optional(),
        queries: z.array(z.string()).min(1).max(10).optional(),
        combine: z.boolean().optional(),
        type: z.string().optional(),
        limit: z.number().optional(),
      })
      .refine((a) => (a.query === undefined) !== (a.queries === undefined), {
        message: "pass exactly one of query or queries",
      })
      .refine((a) => a.combine === undefined || a.queries !== undefined, {
        message: "combine requires queries",
      }),
    handler: async (d, c, a) => {
      const opts = { type: a.type, limit: a.limit };
      if (a.queries) {
        return a.combine
          ? d.reader.searchCombined(c, a.queries, opts)
          : d.reader.searchMany(c, a.queries, opts);
      }
      return d.reader.search(c, a.query!, opts);
    },
  }),
  get: tool({
    description:
      "Read objects in full by id — pass ids:[...] to fetch several in one call (e.g., " +
      "following multiple links; returns a list, unknown ids come back as {id, " +
      "not_found}), or id for a single object. Returns title, body, typed props, and " +
      "every link/backlink with its verb plus the target's title and type (capped at " +
      "100 each, truncated flag when over). Batching multiple ids truncates each body " +
      "to 5000 characters (body_truncated:true when it happens) so a batch of large " +
      "documents can't blow up the response — re-fetch one id alone for its full body. " +
      "Also returns hidden_from_you: the count of links pointing here from private " +
      "objects you cannot see — check it (and backlinks) before delete or merge. Short " +
      "ids work: a prefix (8+ chars) matching exactly one object resolves to it; an " +
      "ambiguous or unknown prefix answers not_found with did_you_mean candidates. " +
      "neighbors:true (single id) adds a hop-2 map — what your links link to, one " +
      "compact row each — so one call charts the local graph instead of N follow-ups.",
    inputSchema: z
      .object({
        id: idOrPrefix.optional(),
        ids: z.array(idOrPrefix).min(1).max(25).optional(),
        neighbors: z.boolean().optional(),
      })
      .refine((a) => (a.id === undefined) !== (a.ids === undefined), {
        message: "pass exactly one of id or ids",
      })
      // Only an explicit true demands the single-id form — a client that
      // always sends neighbors:false must not break batch get on a no-op.
      .refine((a) => a.neighbors !== true || a.id !== undefined, {
        message: "neighbors:true requires a single id",
      }),
    handler: async (d, c, a) => {
      if (a.id) return d.reader.get(c, a.id, { neighbors: a.neighbors });
      return d.reader.getMany(c, a.ids!);
    },
  }),
  list: tool({
    description:
      "List objects of a type. where/sort accept the type's own properties plus id, " +
      "title, created_at, updated_at, version; keyset pagination via cursor. " +
      "with_total:true adds the exact count. A TYPED deleted:true list (for restore) " +
      "supports the same where/sort/total; but the whole-trash (deleted:true with NO " +
      "type) and the untyped visibility views are recency-ordered and LIMIT-ONLY — " +
      "where/sort/cursor/with_total there require a type (you get a teaching error). " +
      "visibility:'private' narrows to your own private objects, " +
      "visibility:'shared_with_me' to private objects others shared with you. " +
      "where grammar: a leaf is {field, op, value} with op one of " +
      "eq/ne/lt/lte/gt/gte/like/ilike/in/is_null/is_not_null; combine with " +
      "and/or/not; shorthands {stage:'won'} (eq), {stage:['won','lost']} (any-of), " +
      "{stage:null} (unset). sort is {field, dir:'asc'|'desc'}. " +
      "Always returns {items, nextCursor}. Rows are shallow (no body/props) — use " +
      "get for the full object.",
    inputSchema: z.object({
      type: z.string().optional(),
      where: whereSchema,
      sort: sortSchema,
      limit: z.number().optional(),
      cursor: z.string().optional(),
      with_total: z.boolean().optional(),
      deleted: z.boolean().optional(),
      visibility: z.enum(["private", "shared_with_me"]).optional(),
    }),
    // Live failure data: ~18% of list calls failed, mostly where clauses sent
    // as JSON strings (stale cached schema) or bare equality maps. Both have
    // one meaning — normalize them to the AST instead of failing the call.
    normalize: (raw) => {
      if ("where" in raw && raw.where !== undefined) raw.where = coerceWhere(raw.where);
    },
    handler: async (d, c, a) => {
      // The whole-trash and untyped-visibility views are recency-ordered and
      // limit-only — they have no typed columns/ext table to filter, sort, page,
      // or count. Fail LOUD (teach: add a type) instead of silently ignoring
      // where/sort/cursor/with_total and returning unfiltered/uncounted rows.
      if (
        !a.type &&
        (a.deleted || a.visibility) &&
        (a.where !== undefined || a.sort !== undefined || a.cursor !== undefined || a.with_total)
      ) {
        throw validationError(
          "where/sort/cursor/with_total require a type — the whole-trash and untyped " +
            "visibility views are recency-ordered and limit-only. Pass a type to filter/sort/page/count.",
        );
      }
      // The whole trash (no type) can't go through the typed list machinery —
      // untyped notes have no ext table. Same {items, nextCursor} shape though.
      if (a.deleted && !a.type) {
        const items = await d.reader.listDeleted(c, { limit: a.limit });
        return { items, nextCursor: null };
      }
      // Same story for the untyped visibility listing — most private objects
      // are plain notes.
      if (a.visibility && !a.type) {
        const items = await d.reader.listPrivate(c, a.visibility, { limit: a.limit });
        return { items, nextCursor: null };
      }
      if (!a.type)
        throw validationError(
          "list needs a type (or deleted:true for the trash, or a visibility filter)",
        );
      // The normalize hook already coerced `where` to a real AST node —
      // compileWhere still does field/op validation against the catalog.
      const listOpts = { ...a, where: a.where as WhereNode | undefined };
      const page = await d.reader.list(c, a.type, listOpts);
      if (!a.with_total) return page;
      const total = await d.reader.count(c, a.type, listOpts);
      return { ...page, total };
    },
  }),

  // ---- watch ----
  recent: tool({
    description:
      "The org-wide activity log, newest first: what changed in the brain (creates, " +
      "edits, deletes, notes, schema changes). Page older with since_seq (seq < N). " +
      "To resume FORWARD from a checkpoint (e.g. a dream's high-water mark) pass " +
      "after_seq (seq > N, oldest first) — never both. The call:* audit stream " +
      "(every tool call, reads included) is hidden by default — kinds:'all' includes " +
      "it. Summarized by default: one-line " +
      "events (no payloads) with target_title/target_type/target_deleted stamped on — " +
      "pass summary:false for full raw payloads (call:write args embed whole object " +
      "bodies, so this can be large; only ask for it when you actually need the payload " +
      "content, not just what happened). " +
      "Every response carries max_seq, the newest seq visible to that response. " +
      "Checkpoint protocol: keep paging with after_seq = nextSeq until nextSeq is " +
      "null — only THEN stamp max_seq as your checkpoint (stamping it off a partial " +
      "page would skip everything between your page and the tip). For one object's " +
      "story, use history.",
    inputSchema: z
      .object({
        limit: z.number().optional(),
        since_seq: z.number().int().optional(),
        after_seq: z.number().int().optional(),
        kinds: z.enum(["all", "mutations"]).optional(),
        summary: z.boolean().optional(),
      })
      .refine((a) => a.since_seq === undefined || a.after_seq === undefined, {
        message: "pass at most one of since_seq or after_seq",
      }),
    handler: (d, c, a) =>
      d.reader.recent(c, {
        limit: a.limit,
        sinceSeq: a.since_seq,
        afterSeq: a.after_seq,
        kinds: a.kinds,
        summary: a.summary,
      }),
  }),
  history: tool({
    description:
      "One object's story by id (short ids resolve, like get): its title/body " +
      "revisions (latest 20, snapshots truncated) and its events — who changed " +
      "what, when.",
    inputSchema: z.object({ id: idOrPrefix }),
    handler: (d, c, a) => d.reader.history(c, a.id),
  }),

  // ---- record (brain_app) ----
  write: tool({
    requires: { scope: "write" },
    description:
      "Create a note (title/body) or a typed object (type + props — check the catalog " +
      "for what exists; prefer a fitting type over a loose note). PRIVATE to you by " +
      "default — use the share tool to let others see it; visibility:'org' publishes " +
      "org-wide immediately (only for obviously-shared records). " +
      "links:[{rel, to: id}] or [{rel, from: id}] connects it to existing " +
      "objects in the same transaction — rel is a lowercase verb like 'contact_at'; if " +
      "any link target is missing, the whole create fails and nothing is written. " +
      "Untyped notes cannot carry props. Search before you write — if it already " +
      "exists, edit it instead of duplicating. " +
      "Content derived from connector documents follows one rule: it goes in a NEW " +
      "object (never appended to an existing one), visibility:'private', shared_with " +
      "set to the people who have the source documents, linked to related objects, " +
      "and with sources: [the doc refs] so the provenance is recorded on the row. Pass " +
      "reason — a short phrase on why you're writing this — whenever you can; it's " +
      "shown next to the data later.",
    inputSchema: z.object({
      type: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      props: z.record(z.unknown()).optional(),
      visibility: z.enum(["org", "private"]).optional(),
      shared_with: z.array(idStr).optional(),
      sources: z.array(z.string()).max(50).optional(),
      links: z.array(linkSchema).max(50).optional(),
      reason: z.string().optional(),
    }),
    handler: (d, c, a) => {
      if (c.flow) {
        // caller-controlled string → log it ONLY when it matches the type
        // slug grammar (same move as mcp-http's KNOWN_TOOLS label): an
        // arg-mangled write must not put content in the log line.
        const t = a.type ?? "note";
        c.flow["type"] = /^[a-z][a-z0-9_]{0,31}$/.test(t) ? t : "(invalid)";
        c.flow["links"] = a.links?.length ?? 0;
        c.flow["visibility"] = a.visibility ?? "org";
      }
      return d.writer.write(wctx(c), {
        type: a.type,
        title: a.title,
        body: a.body,
        props: a.props,
        visibility: a.visibility,
        sharedWith: a.shared_with,
        sources: a.sources,
        links: a.links,
        reason: a.reason,
      });
    },
  }),
  edit: tool({
    requires: { scope: "write" },
    description:
      "Change an existing object: title, body_ops (append / prepend / find_replace " +
      "with expectCount / set — prefer append or find_replace; set rewrites the whole " +
      "body and risks losing content). append/prepend concatenate your text " +
      "literally onto the body with no separator — include your own newline(s) if " +
      "you want a new line or paragraph. props (partial patch, null clears a field), " +
      "links (add edges), unlinks (remove edges). Version is REQUIRED for any object " +
      "change except pure appends and link-only edits: pass the version you read. A " +
      "missing OR mismatched version returns a conflict carrying the current version — " +
      "re-read with get(id) and retry with it. Pure appends and links/unlinks-only " +
      "edits skip the version check. edit changes CONTENT only — who can see an " +
      "object changes ONLY through the share tool (creator-only), never here. " +
      "Find what others shared with you: list visibility:'shared_with_me'. " +
      "Never append content derived from connector documents onto an existing object — " +
      "write it as a new object with its sources and link it here. Pass reason — a " +
      "short phrase on why you're making this change — whenever you can; it's shown " +
      "next to the data later.",
    inputSchema: z.object({
      id: idStr,
      version: z.number().optional(),
      title: z.string().optional(),
      body_ops: z.array(bodyOpSchema).optional(),
      props: z.record(z.unknown()).optional(),
      links: z.array(linkSchema).max(50).optional(),
      unlinks: z.array(linkSchema).max(50).optional(),
      reason: z.string().optional(),
    }),
    handler: (d, c, a) =>
      d.writer.edit(wctx(c), a.id, {
        version: a.version,
        title: a.title,
        bodyOps: a.body_ops,
        props: a.props,
        links: a.links,
        unlinks: a.unlinks,
        reason: a.reason,
      }),
  }),
  share: tool({
    requires: { scope: "write" },
    description:
      "Change who can see an object — the ONLY way to widen an audience. who: tag " +
      "slugs (groups you belong to) and/or member emails; require: tag slugs EVERY " +
      "viewer must also hold (e.g. 'us-person'). The creator always keeps access. " +
      "ASK THE PERSON YOU ARE WORKING FOR BEFORE SHARING unless they just told you " +
      "to — state exactly what and to whom. " +
      "Only the object's GOVERNOR (the creator, " +
      "unless transferred) may call this. transfer_to: hand governance to a member " +
      "by email — include them in who too, so they can see what they now govern. " +
      "Returns { id, version, audience } — audience is the RESULTING who-can-see " +
      "rows in this same vocabulary (emails + tag slugs), so you see the effect " +
      "without a second get.",
    inputSchema: z.object({
      id: idStr,
      who: z.array(z.string().min(1)).max(20).optional(),
      require: z.array(z.string().min(1)).max(10).optional(),
      transfer_to: z.string().optional(),
      reason: z.string().optional(),
    }),
    handler: async (d, c, a) => {
      const res = await d.writer.share(wctx(c), a.id, {
        who: a.who,
        require: a.require,
        transferTo: a.transfer_to,
        reason: a.reason,
      });
      // First-class effect: hand back the RESULTING audience in the same
      // vocabulary `who` accepts, so the caller sees exactly what it did
      // without a second get. Absent on a pre-0057 box.
      const audience = await d.reader.audienceOf(c, a.id);
      return audience ? { ...res, audience } : res;
    },
  }),
  // ---- curate ----
  delete: tool({
    requires: { scope: "write" },
    description:
      "Soft-delete an object (tombstone — restore undoes it). Check get first: its " +
      "backlinks and hidden_from_you tell you what will be left pointing at nothing. " +
      "Private objects: creator only.",
    inputSchema: z.object({ id: idStr }),
    handler: (d, c, a) => d.writer.softDelete(wctx(c), a.id),
  }),
  restore: tool({
    requires: { scope: "write" },
    description: "Bring back a soft-deleted object. Find tombstones with list deleted:true.",
    inputSchema: z.object({ id: idStr }),
    handler: (d, c, a) => d.writer.restore(wctx(c), a.id),
  }),
  merge: tool({
    requires: { scope: "write" },
    description:
      "Two objects are the same thing? Merge loser into winner (same type, both live): " +
      "every link and reference pointing at the loser — including ones inside other " +
      "members' private objects that you cannot see — is re-pointed to the winner, the " +
      "loser's body is appended, and the loser becomes a tombstone redirect. Journaled " +
      "and reversible. Always use this over hand-copying + delete: manual cleanup " +
      "cannot see or fix hidden private links; merge can, and refuses when it can't. " +
      "Requires identical sharing: same visibility and the same share list — " +
      "different-audience objects stay separate and linked.",
    inputSchema: z.object({ loser: idStr, winner: idStr }),
    handler: (d, c, a) => d.writer.merge(wctx(c), a.loser, a.winner),
  }),

  // ---- schema (schema-admin scope; set_type is data, so it runs in the Writer) ----
  set_type: tool({
    requires: { scope: "schema-admin" },
    description:
      "Give an object a type, or move it to a different type, in place — it keeps its " +
      "id, links, backlinks, and history. Use this instead of re-creating the object " +
      "under the new type. props supplies the target type's property values (required " +
      "ones must be present, same rules as write). Moving an already-typed object " +
      "additionally requires the version you read with get, and permanently drops the " +
      "old type's prop values (returned back as dropped_props) — links survive.",
    inputSchema: z.object({
      id: idStr,
      type: z.string(),
      props: z.record(z.unknown()).optional(),
      version: z.number().optional(),
      reason: z.string().optional(),
    }),
    handler: async (d, c, a) => {
      requireScope(c, "schema-admin");
      return d.writer.setType(wctx(c), a.id, a.type, {
        props: a.props,
        version: a.version,
        reason: a.reason,
      });
    },
  }),
  define_type: tool({
    requires: { scope: "schema-admin" },
    description:
      "Create a type, or retire/revive an existing one. NEW name → creates it with its " +
      "properties in one call: properties:[{name, kind, required?, enum_values?, " +
      "ref_type_name?}]. Kinds: text, int, decimal, float, bool, date, timestamp, enum, " +
      "ref (points at one object of a type), ref[] (points at many). Names are lowercase " +
      "snake_case; spine columns (id, title, body, version…) and SQL keywords (role, " +
      "user, order, group, key…) are reserved — use job_title, not title. EXISTING name → " +
      "visible:false retires the type (it drops off this catalog so nothing new is filed " +
      "under it, but its objects stay searchable), visible:true (or omitting it) revives " +
      "it. Add fields to an existing type with add_property, not here. Defining a type is " +
      "PERMANENT — retiring only hides it, nothing deletes it — so only define one when " +
      "nothing in the catalog fits.",
    inputSchema: z.object({
      name: z.string(),
      label: z.string().optional(),
      description: z.string().optional(),
      icon: z.string().optional(),
      properties: z.array(propertySchema).max(24).optional(),
      visible: z.boolean().optional(),
    }),
    handler: async (d, c, a) => {
      requireScope(c, "schema-admin");
      // Re-defining an existing name is a visibility toggle, not a re-create.
      const existing = await d.executor.findType(a.name);
      if (existing) {
        if (a.visible === false) {
          if (!existing.deprecated) await d.executor.deprecateType(existing.id, c.actorId);
          return { type_id: existing.id, name: a.name, retired: true };
        }
        if (a.icon) await d.executor.setTypeIcon(existing.id, a.icon, c.actorId);
        if (existing.deprecated) await d.executor.restoreType(existing.id, c.actorId);
        return {
          type_id: existing.id,
          name: a.name,
          revived: existing.deprecated,
          ...((a.properties?.length ?? 0) > 0
            ? { note: "type already exists — add fields with add_property" }
            : {}),
        };
      }
      const t = await d.executor.defineType(
        {
          name: a.name,
          label: a.label,
          description: a.description,
          icon: a.icon ?? deriveTypeIcon(a.name),
        },
        c.actorId,
      );
      const added: string[] = [];
      for (const p of a.properties ?? []) {
        try {
          await d.executor.addProperty(
            {
              typeId: t.typeId,
              name: p.name,
              kind: p.kind as PropertyKind,
              refTypeName: p.ref_type_name,
              required: p.required,
              enumValues: p.enum_values,
            },
            c.actorId,
          );
          added.push(p.name);
        } catch (e) {
          throw refusedError(
            `type "${a.name}" was created (id ${t.typeId}) with properties [${added.join(", ")}], ` +
              `but property "${p.name}" failed: ${(e as Error).message}`,
            "the type already exists — fix this property and add it with add_property",
          );
        }
      }
      if (a.visible === false) await d.executor.deprecateType(t.typeId, c.actorId);
      return { type_id: t.typeId, name: a.name, properties_added: added };
    },
  }),
  delete_type: tool({
    requires: { scope: "schema-admin" },
    description:
      "Permanently delete a type that has NO objects (live or trashed) — the cleanup " +
      "path for schema mistakes; its fields and enum values go with it, for good. " +
      "Refused if any object was ever filed under it (retire those with define_type " +
      "visible:false instead) or another type's ref property targets it.",
    inputSchema: z.object({ name: z.string() }),
    handler: async (d, c, a) => {
      requireScope(c, "schema-admin");
      const t = await d.executor.findType(a.name);
      if (!t) throw validationError(`no such type "${a.name}"`);
      await d.executor.dropType(t.id, c.actorId, { onlyIfEmpty: true });
      return { deleted: a.name };
    },
  }),
  add_property: tool({
    requires: { scope: "schema-admin" },
    description:
      "Add a field to a type, or hide/show an existing field. Adding: give kind (plus " +
      "enum_values / ref_type_name as needed — kinds and naming rules, see define_type); " +
      "existing objects start with it empty. Hiding: visible:false drops the field from " +
      "the catalog (its stored values are kept, just not shown or writable), visible:true " +
      "brings it back. Retiring a field never deletes data — but adding is PERMANENT " +
      "(fields and enum values cannot be removed), so add sparingly.",
    inputSchema: z.object({
      type_id: z.number(),
      name: z.string(),
      kind: z.enum(PROP_KINDS).optional(),
      ref_type_name: z.string().optional(),
      required: z.boolean().optional(),
      enum_values: z.array(z.string()).optional(),
      visible: z.boolean().optional(),
    }),
    handler: async (d, c, a) => {
      requireScope(c, "schema-admin");
      // Visibility toggle on an existing field — no kind needed.
      if (a.visible !== undefined) {
        const prop = await d.executor.findProperty(a.type_id, a.name);
        if (a.visible === false) {
          if (!prop) throw validationError(`no property "${a.name}" on this type to hide`);
          if (!prop.deprecated) await d.executor.deprecateProperty(prop.id, c.actorId);
          return { type_id: a.type_id, name: a.name, hidden: true };
        }
        if (prop) {
          if (prop.deprecated) await d.executor.restoreProperty(prop.id, c.actorId);
          return { type_id: a.type_id, name: a.name, revived: prop.deprecated };
        }
        // visible:true on a field that doesn't exist yet → fall through and add it.
      }
      if (!a.kind) throw validationError("kind is required to add a new property");
      return d.executor.addProperty(
        {
          typeId: a.type_id,
          name: a.name,
          kind: a.kind as PropertyKind,
          refTypeName: a.ref_type_name,
          required: a.required,
          enumValues: a.enum_values,
        },
        c.actorId,
      );
    },
  }),

  // ---- the filesystem ----
  bash: tool({
    requires: { scope: "read" },
    description:
      "Run a bash script over this brain's persistent filesystem — the only way agents " +
      "work with files. /shared is visible to every member; /home/<you> is private to " +
      "you (your shell starts there; other members' homes don't exist in your view); " +
      "/tmp and everything else is scratch that vanishes when the script ends. Every " +
      "completed write under /shared or /home/<you> is durably saved the moment it " +
      "returns and survives across calls, sessions, and members — even on timeout " +
      "(exit 124), files written before the cutoff were saved; the result's " +
      "persisted/deleted fields confirm what landed. Concurrent scripts are " +
      "last-write-wins per file, but a mistake is recoverable: `history <path>` lists " +
      "prior versions, `diff <path> [version]` shows what changed, `restore <path> " +
      "[version]` rolls a file back, and rm is a soft delete — `restore --list " +
      "[prefix]` browses the trash. Only the last few versions of text files are kept " +
      "(undo, not an archive). A human can lock a file or folder from the dashboard: " +
      "writes under it fail with ELOCKED naming who holds it — ask them to unlock it " +
      "rather than writing a copy beside it. Before you rename or rm a /shared file, " +
      "check whether records store its path (search for the path string) — the result " +
      "warns you when they do, and a restore is not a rename. The sandbox has " +
      "NO network and no host access: bash with grep/sed/awk/jq/yq/sqlite3/xan/rg, " +
      "plus python3 and js-exec (JavaScript, or TypeScript from a .ts file or with " +
      "--strip-types); python3 ships an offline " +
      "toolkit — openpyxl (xlsx), pypdf, beautifulsoup4, tabulate, python-dateutil, " +
      "markdown (pure-Python only, so no numpy/pandas). To edit a file, prefer sed -i " +
      "or a python rewrite over echoing the whole thing back. Files cap at 100MB each; " +
      "you can't ingest a file attached to the chat (no network) — ask the human to " +
      "upload it on the dashboard Files page, then read the path they give you. " +
      "In-shell strings/output run into just-bash's ~10MB edges, so process large " +
      "files with streaming tools (grep/awk/python), not $(cat), and the tool result " +
      "caps each stream at 100KB. Default timeout 10s via timeout_ms (max 30000) — it " +
      "bounds python/js too, so give a slow openpyxl/pypdf parse room.",
    inputSchema: z.object({
      script: z.string(),
      timeout_ms: z.number().int().positive().max(30_000).optional(),
    }),
    handler: async (d, c, a) => {
      requireScope(c, "read");
      // homeSlugOrNull, not homeSlug: a home-less HISTORICAL service account
      // (provisioned before 0037; the feature that minted them is gone but
      // rows persist) runs shared-only rather than being refused every call.
      const slug = await d.fsStore.homeSlugOrNull(c.actorId);
      const runCtx: BashRunCtx = {
        actorId: c.actorId,
        slug,
        // Read-scope tokens keep the tool; every write teaches EROFS instead.
        readOnly: !c.scopes.includes("write"),
      };
      const result = await runBash(
        a.script,
        runCtx,
        d.fsStore,
        a.timeout_ms !== undefined ? { timeoutMs: a.timeout_ms } : {},
      );
      // Path-contract integrity: if this script renamed/removed /shared files,
      // warn when records mention those paths (rename never rewrites the
      // stored property — the agent must). Shared-only; /home paths are the
      // caller's private business and not worth a query per exec.
      if (c.flow) {
        // exit code + output size only — the command line is content.
        c.flow["exit_code"] = result.exitCode;
        c.flow["bytes_out"] = Buffer.byteLength(result.stdout, "utf8");
      }
      const gonePaths = (result.deleted ?? []).filter((p) => p.startsWith("/shared/"));
      if (gonePaths.length > 0) {
        const refs = await d.reader
          .referencingObjects({ actorId: c.actorId }, gonePaths)
          .catch(() => [] as Array<{ path: string; count: number }>);
        if (refs.length > 0) {
          // Name ONLY the paths a record actually points at, each with its own
          // count; passive voice sidesteps subject/verb agreement across counts.
          const shown = refs
            .slice(0, 5)
            .map((r) => `${r.path} (${r.count} record${r.count === 1 ? "" : "s"})`)
            .join(", ");
          const more = refs.length > 5 ? `, …${refs.length - 5} more` : "";
          const note =
            `${shown}${more} — still referenced by existing records; the rm/rename ` +
            `removed the file but did NOT update the record(s), so fix the path there.`;
          return {
            ...result,
            stderr: result.stderr ? `${result.stderr}\n${note}` : note,
            path_refs_warning: note,
          };
        }
      }
      return result;
    },
  }),

  // ---- external data (connector-backed) ----

  // ONE tool for all of Google (samgov doctrine: dumb generic proxy, knowledge
  // lives in data). Self-teaching: an empty call returns the live usage guide,
  // so this description never grows as Calendar/Drive/etc land.
  google: tool({
    description:
      "YOUR Google account: Gmail, Google Calendar (events, scheduling, availability), " +
      "and Google Drive (files, Docs/Sheets). Prefer this over other Google or Calendar " +
      "integrations when the work involves this org's brain. Call it with no " +
      "arguments first — it explains itself.",
    requires: { connector: "google" },
    inputSchema: z.object({
      action: z
        .enum(["search_mail", "read_mail", "send"])
        .describe("Gmail conveniences only — Calendar and Drive go through `path`")
        .optional(),
      // search_mail
      q: z.string().optional(),
      max_results: z.number().int().min(1).max(25).optional(),
      // read_mail
      message_id: z.string().optional(),
      // send
      to: z.string().optional(),
      cc: z.string().optional(),
      subject: z.string().optional(),
      text: z.string().optional(),
      // outbound-send confirm token: the first send
      // returns a preview + confirm_token; re-call with the SAME fields + this.
      confirm: z.string().optional(),
      // raw proxy
      path: z
        .string()
        .describe(
          "any Google REST path — /calendar/v3/… (events, free/busy), /drive/v3/… " +
            "(files, export), /gmail/v1/… (labels, filters)",
        )
        .optional(),
      params: z.record(z.string()).optional(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      // z.record(z.unknown()), NOT z.unknown() — zodToJsonSchema renders bare
      // z.unknown() as an empty {} schema (no "type"), and MCP clients that
      // serialize args off the advertised schema stringify a typeless field
      // instead of sending a nested object. That silently mangled every
      // Calendar POST body (start/end vanished, Google always said "missing
      // end time") until this was caught. See the google/microsoft raw
      // proxy tests below.
      body: z.record(z.unknown()).optional(),
    }),
    handler: async (d, c, a) => {
      if (!d.google) throw googleNotEnabled();
      if (c.flow) {
        c.flow["op"] = a.action ?? (a.path ? "raw" : "doctrine");
        // API bucket only — NEVER the path (paths embed message/file ids).
        // Bounded by construction: three allowlisted prefixes or "other".
        c.flow["api"] = a.action
          ? "gmail"
          : a.path?.startsWith("/gmail/")
            ? "gmail"
            : a.path?.startsWith("/calendar/")
              ? "calendar"
              : a.path?.startsWith("/drive/")
                ? "drive"
                : a.path
                  ? "other"
                  : "none";
      }
      if (a.action === "search_mail") {
        if (!a.q) return d.google.doctrine(c.actorId);
        return d.google.searchMail(c.actorId, a.q, a.max_results ?? 10);
      }
      if (a.action === "read_mail") {
        if (!a.message_id) return d.google.doctrine(c.actorId);
        return d.google.readMail(c.actorId, a.message_id);
      }
      if (a.action === "send") {
        if (!a.to || !a.subject || a.text === undefined) return d.google.doctrine(c.actorId);
        // Two-step: preview first, send only on a token that binds these exact
        // fields. Speed bump surfacing outbound content, not an injection boundary.
        const token = sendToken({ to: a.to, cc: a.cc, subject: a.subject, text: a.text });
        if (a.confirm !== token) {
          return pendingConfirmation(
            "google",
            { to: a.to, cc: a.cc, subject: a.subject, text: a.text },
            token,
          );
        }
        return d.google.send(c.actorId, {
          to: a.to,
          ...(a.cc !== undefined ? { cc: a.cc } : {}),
          subject: a.subject,
          text: a.text,
        });
      }
      if (a.path) {
        const r = await d.google.call(c.actorId, {
          path: a.path,
          ...(a.params !== undefined ? { params: a.params } : {}),
          ...(a.method !== undefined ? { method: a.method } : {}),
          ...(a.body !== undefined ? { body: a.body } : {}),
        });
        if (c.flow) c.flow["content_kind"] = contentKind(r);
        return r;
      }
      // Empty or unrecognized → teach, never error.
      return d.google.doctrine(c.actorId);
    },
  }),

  // ONE tool for all of Microsoft 365 (same self-teaching contract as google;
  // no convenience actions — Graph is plain JSON end to end).
  microsoft: tool({
    description:
      "Microsoft 365 (Outlook, Teams, OneDrive/Word/Excel/PowerPoint, SharePoint) as " +
      "YOUR connected account. Call it with no arguments first — it explains itself.",
    requires: { connector: "msgraph" },
    inputSchema: z.object({
      path: z.string().optional(),
      params: z.record(z.string()).optional(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      // z.record(z.unknown()), not bare z.unknown() — see the google tool's
      // body param for why.
      body: z.record(z.unknown()).optional(),
      // outbound-send confirm token: a sendMail POST
      // previews first; re-call with the SAME body + this token to send.
      confirm: z.string().optional(),
    }),
    handler: async (d, c, a) => {
      if (!d.microsoft) throw microsoftNotEnabled();
      if (c.flow) c.flow["op"] = a.path ? "raw" : "doctrine";
      if (a.path) {
        const r = await d.microsoft.call(
          c.actorId,
          {
            path: a.path,
            ...(a.params !== undefined ? { params: a.params } : {}),
            ...(a.method !== undefined ? { method: a.method } : {}),
            ...(a.body !== undefined ? { body: a.body } : {}),
          },
          a.confirm,
        );
        if (c.flow) c.flow["content_kind"] = contentKind(r);
        return r;
      }
      // Empty or unrecognized → teach, never error.
      return d.microsoft.doctrine(c.actorId);
    },
  }),

  // ---- owner admin (DB enforces owner-only) ----
  create_user: tool({
    description:
      "Owner only: create an account at one of three permission tiers and return its " +
      "access token. name, email, and permission are ALL required. permission: " +
      "'owner' = everything incl. managing people; 'member' = read + write + reshape the " +
      "schema; 'viewer' = read-only. The token is shown this once and never again — only " +
      "its hash is stored.",
    requires: { owner: true },
    inputSchema: z.object({
      name: z.string().min(1),
      email: z.string().min(1),
      permission: z.enum(["owner", "member", "viewer"]),
    }),
    handler: (d, c, a) => d.admin.createUser(c.actorId, a),
  }),
  revoke_user: tool({
    description:
      "Owner only: revoke an account; its token dies immediately. Cannot revoke " +
      "yourself or another owner (owners are peers).",
    requires: { owner: true },
    inputSchema: z.object({ id: idStr }),
    handler: async (d, c, a) => {
      await d.admin.revokeAccount(c.actorId, a.id);
      return { ok: true };
    },
  }),
} as unknown as Record<string, ToolDef<never>>;

export function toolNames(): string[] {
  return Object.keys(TOOLS);
}

// ---- custom-connector tools (dynamic, DB-defined on the box) --------------
//
// A custom connector's tool is named `<slug>_fetch`. The DEFINITIONS live on
// the box (custom_connectors table); the registry's job is only to recognize
// the name shape and synthesize a ToolDef for it, so a dynamic tool passes
// through the exact same strict-parse + full call-audit path (0019) as every
// static tool. Visibility is the box's job (tools/list appends descriptors
// for connectors usable by the caller); call-time gating is the box's
// deps.custom.fetch (config-row check → teaching error).

export interface CustomFetchToolArgs {
  readonly path?: string;
  readonly method?: string;
  readonly params?: Record<string, string>;
  readonly body?: string;
}

const CUSTOM_FETCH_SCHEMA = z.object({
  path: z.string().optional(),
  method: z.string().optional(),
  params: z.record(z.string()).optional(),
  body: z.string().optional(),
});

/** Matches `<slug>_fetch` for a valid custom-connector slug — and never a
 *  static tool name (the slug grammar is checked by the DB too). */
export function isCustomFetchName(name: string): boolean {
  if (name in TOOLS) return false;
  return /^[a-z][a-z0-9_]{1,31}_fetch$/.test(name);
}

/** Synthesized def for one dynamic tool call — validation + audit only; the
 *  description is irrelevant here (tools/list descriptors come from the box). */
function customToolDef(name: string): ToolDef<never> {
  return {
    description: `custom connector fetch (${name})`,
    inputSchema: CUSTOM_FETCH_SCHEMA,
    handler: (async (d: ToolDeps, c: AuthedContext, a: CustomFetchToolArgs) => {
      if (!d.custom) {
        throw refusedError(
          "custom connectors are not wired on this box",
          "this box build does not serve owner-defined connectors",
        );
      }
      // The caller's actor id drives personal-vs-org credential resolution.
      return d.custom.fetch(name, a, c.actorId);
    }) as never,
  } as unknown as ToolDef<never>;
}

/**
 * MCP tool annotations (spec 2025-03-26) — hints Claude clients feed into
 * their permission prompting. These MUST stay honest: readOnlyHint only on
 * tools that never mutate; destructiveHint:false only where the brain can
 * undo the change (tombstoned deletes, versioned edits). merge/create_user/
 * revoke_user keep destructiveHint:true — merges and access-control changes
 * aren't cleanly reversible, so a client prompting on them is correct. The
 * same test puts every SCHEMA mutation (define_type/add_property/set_type)
 * in the destructive class: there is no delete_type, properties and enum
 * values are append-only, and "retire" only hides — a schema mistake made
 * under an auto-allow is in the brain permanently, so a client prompting on
 * these is correct too. Do not reclassify them back.
 */
const READ = { readOnlyHint: true, openWorldHint: false } as const;
const REVERSIBLE_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

export const TOOL_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  start: READ,
  catalog: READ,
  search: READ,
  get: READ,
  list: READ,
  recent: READ,
  history: READ,
  write: REVERSIBLE_WRITE,
  edit: REVERSIBLE_WRITE,
  // Widening an audience is publication — recoverable in DATA terms (share
  // again, narrower) but not in DISCLOSURE terms: what a widened audience saw,
  // it saw. The most severe reading wins, same rule as merge.
  share: DESTRUCTIVE,
  delete: REVERSIBLE_WRITE, // tombstone, restorable via `restore`
  restore: REVERSIBLE_WRITE,
  // Schema mutations are irreversible (see the doctrine comment above):
  // nothing can delete a type, remove a property, or drop an enum value, and
  // a retype drops the old type's prop values.
  set_type: DESTRUCTIVE,
  define_type: DESTRUCTIVE,
  add_property: DESTRUCTIVE,
  delete_type: DESTRUCTIVE, // the only true delete in the schema family

  // Writes the persistent filesystem. Still DESTRUCTIVE despite versioning:
  // history is capped and text-only, so a binary overwrite or an evicted
  // version is gone for good.
  bash: DESTRUCTIVE,
  merge: DESTRUCTIVE,
  create_user: DESTRUCTIVE,
  revoke_user: DESTRUCTIVE,
};

/**
 * MCP tools/list descriptors with REAL JSON schemas derived from each tool's
 * zod schema. Advertising `additionalProperties: true` instead (the old stub)
 * made schema-respecting clients send every argument as a string, so any tool
 * with a number/bool param failed validation server-side.
 */
const jsonSchemaCache = new Map<string, ReturnType<typeof zodToJsonSchema>>();

function toolJsonSchema(name: string, def: ToolDef<never>) {
  let s = jsonSchemaCache.get(name);
  if (!s) {
    // zod → JSON schema is pure CPU on static definitions — derive once, not
    // on every tools/list.
    s = zodToJsonSchema(def.inputSchema, { $refStrategy: "none" });
    jsonSchemaCache.set(name, s);
  }
  return s;
}

export function toolDescriptors(caller?: {
  readonly role: string;
  readonly scopes: readonly string[];
  /** provider slugs the CALLER has connected (drives `requires.connector`).
   *  Absent → connector-gated tools are hidden (fail closed). */
  readonly connectors?: ReadonlySet<string>;
}) {
  return Object.entries(TOOLS)
    .filter(([, def]) => {
      if (!def.requires || !caller) return true; // no caller ctx → advertise all
      if (def.requires.owner && caller.role !== "owner") return false;
      if (def.requires.scope && !caller.scopes.includes(def.requires.scope)) return false;
      if (def.requires.connector && !caller.connectors?.has(def.requires.connector)) return false;
      return true;
    })
    .map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: toolJsonSchema(name, def),
      annotations: TOOL_ANNOTATIONS[name],
    }));
}

export async function callTool(
  deps: ToolDeps,
  ctx: AuthedContext,
  name: string,
  rawArgs: unknown,
): Promise<unknown> {
  const def =
    TOOLS[name] ?? (deps.custom && isCustomFetchName(name) ? customToolDef(name) : undefined);
  if (!def) throw validationError(`unknown tool "${name}"`);
  // Rescue pass on the raw args (outside the parse try: a BrainError thrown
  // here is already a teaching message and must reach the caller verbatim).
  if (def.normalize && rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    def.normalize(rawArgs as Record<string, unknown>);
  }
  let args: unknown;
  try {
    // Top-level strictness: every tool advertises additionalProperties: false,
    // and z.object's default is to silently STRIP unknown keys — so a caller
    // passing edit({body}) instead of edit({body_ops}) got a false success
    // that changed nothing. Enforce the advertised contract at runtime.
    const schema =
      def.inputSchema instanceof z.ZodObject ? def.inputSchema.strict() : def.inputSchema;
    args = schema.parse(rawArgs ?? {});
  } catch (e) {
    const unknownKeys =
      e instanceof z.ZodError
        ? e.issues.flatMap((i) => (i.code === "unrecognized_keys" ? i.keys : []))
        : [];
    if (unknownKeys.length > 0) {
      throw validationError(
        `unknown argument(s) for ${name}: ${unknownKeys.map((k) => `"${k}"`).join(", ")} — ` +
          `nothing was changed; check the tool's schema for the supported fields`,
        { detail: `unrecognized keys: ${unknownKeys.join(", ")}`.slice(0, 200) },
      );
    }
    throw validationError(`invalid arguments for ${name}`, {
      detail: (e as Error).message.slice(0, 200),
    });
  }

  // Full tool-call audit (0019): every call — reads included — appends one
  // 'call:<tool>' event so `recent` shows everything, not just mutations.
  // REDACTION happens inside enqueueCallLog before it resolves (call-time
  // object state, so a later visibility flip can never unredact a private
  // edit); the audit TRANSACTION is queued, never awaited — the response must
  // not pay its round-trips (tests await writer.flushAudit()). Best-effort:
  // the catch keeps audit failures from ever failing the call.
  const startedMs = Date.now();
  let ok = true;
  let errCode: string | undefined;
  try {
    const result = await def.handler(deps, ctx, args as never);
    // Connector tools (google/microsoft/samgov_fetch) report failure as DATA
    // — {successful:false, error} — not a thrown error, so the calling agent
    // gets a teaching message instead of a hard MCP error. That means this
    // try/catch never saw it: the audit log showed ok:true on every one of
    // these calls even while a real bug made every Calendar POST fail.
    // Recognize the shape here so the audit trail reflects what actually
    // happened, without changing what the caller receives.
    if (isConnectorFailure(result)) {
      ok = false;
      errCode = result.error.slice(0, 200);
    }
    return result;
  } catch (err) {
    ok = false;
    errCode = (err as { code?: string }).code ?? "error";
    throw err;
  } finally {
    await deps.writer
      .enqueueCallLog(ctx.actorId, name, args, {
        ok,
        ms: Date.now() - startedMs,
        error: errCode,
      })
      .catch(() => undefined);
  }
}

function isConnectorFailure(result: unknown): result is { successful: false; error: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { successful?: unknown }).successful === false &&
    typeof (result as { error?: unknown }).error === "string"
  );
}
