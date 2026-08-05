/**
 * Typed client for the box's read-only dashboard API (/api/v1).
 *
 * - Session is a cookie; the brain token is posted ONCE at login and never
 *   stored client-side.
 * - Every response carries X-Brain-App-Version; a skew vs the version we
 *   booted with forces one fail-safe reload.
 * - 401 anywhere flips the app to the login screen via the `unauthorized`
 *   callback.
 */

import { isDemo, demoResponse, DemoNotFound, DemoUnhandled } from "../demo";
// Type-only (erased at build): the graph reuses the phase-3 filter AST rather
// than inventing a second filter language, and `viewConfig` imports only types
// back out of this file, so nothing circular exists at runtime.
import type { WhereNode } from "./viewConfig";

export interface Branding {
  /** null when unset — the UI shows its built-in default label. */
  name: string | null;
  hasFavicon: boolean;
}

export interface Whoami {
  id: string;
  name: string;
  role: "owner" | "member" | "viewer";
  scopes: string[];
  status: string;
  /** The box's app version (e.g. "v1.2.3"), echoed from the whoami response.
   *  Optional so older/other callers of this type stay valid. */
  appVersion?: string;
}

export interface PropDef {
  name: string;
  kind: string;
  required: boolean;
  deprecated: boolean;
  ref_type?: string | null;
  enum_values?: string[];
}

export interface TypeSummary {
  id: number;
  name: string;
  label: string | null;
  description: string | null;
  /** A single emoji chosen for the type. May be absent/empty (older boxes,
   *  demo fixtures) — always render through <TypeIcon>, which falls back. */
  icon: string;
  deprecated: boolean;
  count: number;
  properties: PropDef[];
}

export interface ListItem {
  id: string;
  title: string | null;
  version: string | number;
  created_at: string;
  updated_at: string;
  visibility: "org" | "private";
  props?: Record<string, unknown>;
}

export interface Edge {
  rel: string;
  id: string;
  provenance: string;
  target_deleted: boolean;
  target_title: string | null;
  target_type: string | null;
  required?: boolean;
  direction?: "in" | "out";
}

export interface BrainObject {
  id: string;
  type: string | null;
  title: string | null;
  body: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  visibility: "org" | "private";
  props: Record<string, unknown>;
  links: Edge[];
  backlinks: Edge[];
  links_truncated: boolean;
  backlinks_truncated: boolean;
  hidden_from_you: number;
  /** Tag governance: the audience as rows of LABELED tags — an OR of AND-rows.
   *  The server pre-resolves labels (org → "everyone", personal → the holder's
   *  name with `you` set for the viewer, custom → its slug) so the chips read
   *  as people, never as `person-45a33741`. Absent on a pre-0057 box. */
  audience?: AudienceTag[][];
}

/** One labeled tag inside an audience row (see BrainObject.audience).
 *  `email` (personal tags) is the share vocabulary for that person — the
 *  sheet prefills it back into WHO because share REPLACES the audience.
 *  `governor` marks the always-kept bare row the sheet must not offer. */
export interface AudienceTag {
  slug: string;
  label: string;
  kind: "org" | "personal" | "custom" | string;
  you?: boolean;
  email?: string;
  governor?: boolean;
}

export interface SearchHit {
  id: string;
  type: string | null;
  title: string | null;
  version: number;
  updated_at: string;
  rank: number;
  snippet: string | null;
  connections: number;
  /** strongest provenance: fulltext | semantic | both | graph | title_fuzzy
   *  ("both" = fulltext AND semantic agreed; graph/title_fuzzy only when no
   *  text arm found it) */
  match: string;
  /** graph-arm provenance: which seed hit and relationships surfaced this */
  via?: { seed: string; rels: string[] };
}

export interface FeedEvent {
  seq: string;
  kind: string;
  at: string;
  target: string | null;
  payload: Record<string, unknown> | null;
  actor_name: string | null;
  target_title: string | null;
  target_type: string | null;
  target_deleted: boolean;
}

export interface RecentObject {
  id: string;
  title: string | null;
  version: string | number;
  updated_at: string;
  type: string | null;
  snippet: string | null;
  degree: string | number;
}

export interface Stats {
  entities: number;
  relationships: number;
  eventsToday: number;
  types: number;
  members: number;
  [k: string]: number;
}

export interface Member {
  id: string;
  name: string;
  role: string;
  status: string;
  scopes: string[];
  /** the member's email — what the share sheet submits for a person-share.
   *  Optional so older fixtures/boxes without it stay valid. */
  email?: string;
}

/** One owner-removal row from GET /api/v1/owner-removals (tag governance,
 *  wave 5). A removal is PENDING while both `cancelled_at` and `executed_at`
 *  are null: it takes effect at `effective_at` unless any owner — the target
 *  included — cancels it first (the two-person veto window). */
export interface OwnerRemoval {
  id: string;
  target_id: string;
  target_name: string;
  initiated_by: string;
  initiated_by_name: string;
  effective_at: string;
  cancelled_at: string | null;
  executed_at: string | null;
}

/** One tag from GET /api/v1/tags (tag governance, wave 3). `holders` are
 *  account ids — resolve them to names via the members list. */
export interface TagRow {
  slug: string;
  kind: "personal" | "org" | "custom";
  /** the identity a personal tag stands for; null for org/custom tags. */
  account_id: string | null;
  holders: string[];
}

export interface History {
  id: string;
  versions: Array<{
    version: number;
    at: string;
    by: string | null;
    /** the actor's display name (by is the raw id / join key). */
    by_name: string | null;
    snapshot: { title: string | null; body: string | null };
  }>;
  events: Array<{
    seq: string;
    at: string;
    actor: string | null;
    actor_name: string | null;
    kind: string;
    payload: Record<string, unknown> | null;
  }>;
}

export interface ConnectorField {
  key: string;
  label: string;
  secret?: boolean;
}

export interface ConnectorAccessRow {
  app: string;
  allows: string;
}

export interface ConnectorSetup {
  intro: string;
  /** steps may contain the literal token {{redirectUri}}. */
  steps: string[];
}

export interface ConnectorStatus {
  provider: string;
  name: string;
  fields: ConnectorField[];
  /** an org-wide credential exists (owner-set, every member uses it). */
  orgEnabled: boolean;
  /** the CALLING member's own personal credential exists. */
  myPersonalEnabled: boolean;
  /** a member can bring their own credential (api-key/custom connectors). */
  selfAdoptable?: boolean;
  /** member-facing "what it can access" rows + raw scopes. */
  access: ConnectorAccessRow[];
  scopes?: string[];
  /** present only for owners. */
  setup?: ConnectorSetup;
  /** OAuth providers only: whether the CALLING account has connected, and the
   *  redirect URI the owner registers in the provider's console. */
  oauth?: boolean;
  connected?: boolean;
  redirectUri?: string | null;
  /** Owner-defined custom connector (0033). `definition` is present for
   *  owners only — the edit surface; the secret is never echoed back. */
  custom?: boolean;
  definition?: CustomConnectorDefinition;
}

export interface CustomConnectorDefinition {
  baseUrl: string;
  authKind: "header" | "query" | "none";
  authName: string | null;
  allowedPrefixes: string[];
  instructions: string;
  description: string;
}

/** One row of a filesystem directory listing (the dashboard file manager).
 *  `updated_by` arrives as a display name — the server resolves the uuid. */
export interface FsEntry {
  name: string;
  kind: "dir" | "file";
  size: number;
  mtime: string;
  updated_by: string | null;
  /** this row's lock, resolved by the SAME query that listed the folder —
   *  every field null when it is unlocked (absent only on an older box). */
  lock?: FsLock | null;
}

/** One prior snapshot of a file (fs_versions), newest first from the server.
 *  `edited_by` arrives as a display name, like `updated_by` on a listing. */
export interface FsVersion {
  version_no: number;
  /** what the snapshot captured: "overwrite" | "delete" (see reasonLabel). */
  reason: string;
  size_bytes: number;
  edited_by: string | null;
  created_at: string;
}

/** Who holds a file/folder lock — every field null when it is unlocked. */
export interface FsLock {
  locked_by: string | null;
  locked_by_name: string | null;
  locked_at: string | null;
}

/** One soft-deleted (recoverable) path, from the filesystem's trash. */
export interface FsTrashEntry {
  path: string;
  size_bytes: number;
  deleted_at: string;
  edited_by: string | null;
}

/**
 * A per-member saved view (migration 0054, `apps/box/src/saved-views.ts`).
 *
 * A saved view is the member's OWN chrome: a named snapshot of a view's
 * configuration, pinnable to their sidebar. Rows are per member and are never
 * shared — there is deliberately no share affordance anywhere in the client.
 *
 * `config` is deliberately opaque here. Phase 4 stores the database
 * `ViewConfig` (filter/sort/group/layout/columns) and phase 6 stores a graph
 * view (filters, forces, camera, focus) under `kind: "graph"` in the same
 * table; the client that owns a kind is the client that knows its shape, and it
 * normalizes what comes back (a saved config is a config an older release
 * wrote, so it is treated as hostile-shaped exactly like the localStorage one).
 *
 * A config CAN carry brain content — a filter literal or a saved focus can
 * embed a private object's id or title. That is why the table is FORCE RLS
 * per-member and why nothing in the UI offers to hand one to someone else.
 */
export interface SavedView {
  id: string;
  kind: SavedViewKind;
  /** The view's subject: a type name for a database view, null for a global one. */
  scope: string | null;
  name: string;
  config: Record<string, unknown>;
  pinned: boolean;
  /** Sidebar order within the member's own list (server-assigned). */
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors 0054's CHECK constraint. `graph` exists already so phase 6 needs no
 *  second live-box migration. */
export type SavedViewKind = "database" | "graph";

/**
 * One page of `GET /api/v1/graph` — `Reader.graphFull`'s payload verbatim.
 *
 * `edges` carry `rel` (the sample endpoint does not) because shortest-path
 * labels every hop with its verb, and an edge is returned only when BOTH
 * endpoints are visible to the viewer — `degree` likewise counts visible edges
 * only. The client's matching half of that rule lives in `GraphStore.ingest`:
 * an edge naming a node it was never given is DROPPED, never drawn against a
 * synthesized placeholder.
 */
export interface GraphPageResponse {
  nodes: Array<{ id: string; title: string | null; type: string | null; degree: number }>;
  edges: Array<{ from: string; to: string; rel: string }>;
  /** opaque; feed back as `after`. null ⇒ this was the last page. */
  nextCursor: string | null;
  /** the snapshot every page of this walk is served against (ISO-8601). */
  watermark: string;
  /** set only when the visible brain is larger than the server's cap. */
  truncated: { shown: number; total: number; reason: "size" } | null;
}

interface GraphPageQuery {
  after?: string;
  watermark?: string;
  limit?: number;
  /**
   * The phase-3 filter AST, narrowed server-side to `type` (eq/in/is_null) and
   * `updated_at` (gt/gte/lt/lte) combined with `{and:[…]}`. Anything else is
   * refused with a 400 rather than dropped — a silently ignored term would show
   * the viewer nodes they had filtered out.
   */
  where?: WhereNode;
  /**
   * Ask for the server's degree-ordered top-`limit` sample (one page, no cursor)
   * instead of the ascending-uuid keyset walk. Set by the graph view when a
   * device budget below the server cap would otherwise stop the walk on an
   * arbitrary uuid slice and drop the brain's hubs.
   */
  sample?: boolean;
}

/**
 * `GET /api/v1/graph/changed` — the time scrubber's "what changed since T".
 *
 * IDS ONLY, and only ids the viewer already has: the route intersects the
 * changed set with the viewer's visible node set (the same RLS-bound SQL that
 * decides which nodes `graphFull` hands out) and computes `count`/`byKind`
 * AFTER that intersection. The event feed itself carries no RLS — a raw
 * changed-count, or a pulse keyed on a target id, would leak private-object
 * activity and its uuid — so no feed row ever reaches the client and nothing
 * in the UI may be derived from one.
 */
export interface GraphChangedResponse {
  /** the window start the server actually used (ISO-8601). */
  since: string;
  /** the snapshot the visible set was read at. */
  watermark: string;
  /** changed object ids, most-recently-changed first. */
  ids: string[];
  /** `ids.length`, restated by the server — the ONLY count the UI may show. */
  count: number;
  /** event kind → count, over the intersected rows only. */
  byKind: Record<string, number>;
  /** the visible set was sampled, so this window may be missing changes. */
  truncated: { shown: number; total: number; reason: "size" } | null;
  /** the feed scan hit its cap before reaching `since`. */
  feedTruncated: boolean;
}

export interface SavedViewInput {
  /** defaults to "database" server-side. */
  kind?: SavedViewKind;
  /** omit (or null) for a GLOBAL view. */
  scope?: string | null;
  name: string;
  config: Record<string, unknown>;
  pinned?: boolean;
}

/** Rename / re-save / pin. `kind` and `scope` are NOT patchable — the server
 *  refuses them rather than ignoring them, so this type cannot carry them. */
export interface SavedViewPatch {
  name?: string;
  config?: Record<string, unknown>;
  pinned?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---- write path (CAS) ----------------------------------------------------

/** What the server left behind when our compare-and-set lost.
 *
 *  Read INSIDE the losing transaction as the caller, so it is RLS-bound and can
 *  only contain content this account may already read. `props` carries SCALAR
 *  properties only — ref[] properties are edges and never bump the version. */
export interface ConflictSnapshot {
  title: string | null;
  body: string | null;
  props: Record<string, unknown>;
  updated_at: string;
  /** display name of whoever produced `currentVersion`, or null when the
   *  attribution event is not visible to this caller. */
  actor_name: string | null;
}

/**
 * A 409 from a write route. Two distinct causes share the status code, and the
 * save queue treats them differently:
 *
 *  - **version conflict** — `currentVersion` + `current` are set; rebase our
 *    changed fields onto the winner and retry (or surface the banner).
 *  - **refusal** — `reason` is set (e.g. `"open_in_editor"`, phase 2: the live
 *    room owns body/title). There is nothing to rebase onto; retrying the same
 *    patch just loses again, so the caller must route through the editor.
 *
 * An object the caller can no longer read never produces a 409 — the server
 * answers 404, because a 409 carries a version and would confirm both that the
 * object exists and how fast it changes. So a 404 stays a plain ApiError.
 */
export class ConflictError extends ApiError {
  constructor(
    message: string,
    readonly currentVersion: number | null,
    readonly current: ConflictSnapshot | null,
    readonly reason?: string,
  ) {
    super(409, message);
    this.name = "ConflictError";
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

export interface WriteResult {
  id: string;
  version: number;
}

interface LinkResult {
  from: string;
  rel: string;
  to: string;
}

interface UnlinkResult extends LinkResult {
  removed: boolean;
}

/** Create. `idempotencyKey` is minted ONCE per user intent (⌘N) and reused
 *  across retries — a create has no baseVersion to conflict on, so without it a
 *  lost response makes a second object ("the UI creates ghost duplicates"). */
export interface CreateObjectInput {
  type?: string;
  title?: string;
  body?: string;
  props?: Record<string, unknown>;
  visibility?: "org" | "private";
  idempotencyKey: string;
}

/** Field-granular patch: send ONLY the fields that changed, so disjoint-field
 *  edits by two people merge cleanly. Inside `props`, an explicit `null` DELETES
 *  that key and leaves its siblings alone — never send the whole props object
 *  back, that reverts fields this client never touched. */
export interface PatchObjectInput {
  baseVersion: number;
  title?: string | null;
  body?: string;
  props?: Record<string, unknown | null>;
  visibility?: "org" | "private";
}

/** Link edits do not bump the version, so they can never lose a CAS and can
 *  never 409 — they carry an idempotency key instead. */
export interface LinkObjectInput {
  to: string;
  rel: string;
  idempotencyKey: string;
}

interface UnlinkObjectInput {
  to: string;
  rel: string;
  idempotencyKey?: string;
}

/** One key per user intent — mint it where the intent starts, NOT per attempt. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  // Non-secure contexts (and ancient webviews) have no randomUUID. Any
  // unguessable-enough unique string works — the server only compares it.
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let bootVersion: string | null = null;
let onUnauthorized: (() => void) | null = null;
let reloading = false;

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function checkVersion(res: Response): void {
  const v = res.headers.get("x-brain-app-version");
  if (!v) return;
  if (bootVersion === null) {
    bootVersion = v;
    return;
  }
  if (v !== bootVersion && sessionStorage.getItem("brain-skew-reload") !== v) {
    // One fail-safe reload per new version — never a reload loop.
    sessionStorage.setItem("brain-skew-reload", v);
    reloading = true; // suppress load-error banners while the page reloads
    location.reload();
  }
}

/**
 * Should this rejection surface a retryable error banner? PURE — the regression
 * net for the four read-path traps:
 *  - a 401 is NEVER surfaced (api already called onUnauthorized → the app flips
 *    to Login; a banner would race that);
 *  - an AbortError (superseded/unmounted fetch) is not a real failure;
 *  - nothing surfaces once a version-skew reload has begun (isReloading()).
 * Everything else (500, network, generic) is a real, retryable error.
 */
export function shouldSurface(err: unknown, reloadingNow: boolean = reloading): boolean {
  if (reloadingNow) return false;
  if (err instanceof ApiError && err.status === 401) return false;
  if (err instanceof DOMException && err.name === "AbortError") return false;
  if (err instanceof Error && err.name === "AbortError") return false;
  return true;
}

/** Human message for a surfaced error. ApiError carries a server message; a bare
 *  network/unknown error gets a connection-and-retry hint. PURE. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Couldn’t load — check your connection and retry.";
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Demo mode (hosted-demo): no backend — serve captured fixtures so the
  // real dashboard runs verbatim on canned data.
  if (isDemo()) {
    try {
      return await demoResponse<T>(path, init);
    } catch (e) {
      if (e instanceof DemoNotFound) throw new ApiError(404, "not_found");
      // A read the demo has no fixture for: a real defect in the demo layer, so
      // it becomes a real API failure the caller already knows how to handle —
      // and one console line naming the endpoint, which is how it gets fixed.
      if (e instanceof DemoUnhandled) {
        console.error(e.message);
        throw new ApiError(e.status, e.message);
      }
      throw e;
    }
  }
  const res = await fetch(path, { credentials: "same-origin", ...init });
  checkVersion(res);
  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, "unauthorized");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw errorFor(res.status, body);
  }
  return body as T;
}

/** Read routes answer `{ error }`; write routes answer the BrainError shape
 *  `{ code, message, unblock, details }`. Both must produce a usable message.
 *  (Distinct from the exported `errorMessage(err)` above, which renders a
 *  THROWN error for a banner — this one parses a response BODY.) */
function bodyMessage(body: Record<string, unknown>): string {
  if (typeof body["error"] === "string") return body["error"];
  if (typeof body["message"] === "string") return body["message"];
  return "error";
}

/** A 409 that carries a version (CAS lost) or a reason (a refusal like
 *  `open_in_editor`) becomes a ConflictError the save queue can branch on.
 *  Everything else — including 404 for an object we may no longer read — stays
 *  a plain ApiError. */
function errorFor(status: number, body: Record<string, unknown>): ApiError {
  if (status === 409) {
    const raw = body["currentVersion"];
    const currentVersion = typeof raw === "number" && Number.isInteger(raw) ? raw : null;
    const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
    if (currentVersion !== null || reason !== undefined) {
      const c = body["current"];
      const current =
        c && typeof c === "object" && !Array.isArray(c) ? (c as unknown as ConflictSnapshot) : null;
      return new ConflictError(bodyMessage(body), currentVersion, current, reason);
    }
  }
  return new ApiError(status, bodyMessage(body));
}

export const api = {
  login: (token: string) =>
    req<{ ok: boolean; role: string; csrfToken: string; appVersion: string }>("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  logout: () => req<{ ok: boolean }>("/api/logout", { method: "POST" }),
  branding: () => req<Branding>("/api/v1/branding"),
  setBranding: (body: { name?: string | null; faviconDataUrl?: string | null }) =>
    csrfReq<Branding>("/api/v1/branding", "POST", body),
  whoami: () => req<Whoami>("/api/v1/whoami"),
  members: () => req<Member[]>("/api/v1/members"),
  stats: () => req<Stats>("/api/v1/stats"),
  types: () => req<TypeSummary[]>("/api/v1/types"),
  list: (
    type: string,
    opts: {
      limit?: number;
      cursor?: string;
      sort?: unknown;
      where?: unknown;
      deleted?: boolean;
    } = {},
  ) => {
    const q = new URLSearchParams({ type, props: "1" });
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.sort) q.set("sort", JSON.stringify(opts.sort));
    if (opts.where) q.set("where", JSON.stringify(opts.where));
    if (opts.deleted) q.set("deleted", "1");
    return req<{ items: ListItem[]; nextCursor: string | null }>(`/api/v1/list?${q}`);
  },
  object: (id: string) => req<BrainObject>(`/api/v1/objects/${id}`),
  history: (id: string) => req<History>(`/api/v1/objects/${id}/history`),
  search: (q: string, opts: { type?: string; limit?: number; deep?: boolean } = {}) => {
    const p = new URLSearchParams({ q });
    if (opts.type) p.set("type", opts.type);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.deep) p.set("deep", "1");
    return req<SearchHit[]>(`/api/v1/search?${p}`);
  },
  feed: (limit = 40) => req<FeedEvent[]>(`/api/v1/feed?limit=${limit}`),
  untyped: (limit = 100) =>
    req<
      Array<{
        id: string;
        title: string | null;
        version: string | number;
        updated_at: string;
        visibility: "org" | "private";
        snippet: string | null;
        degree: string | number;
      }>
    >(`/api/v1/untyped?limit=${limit}`),
  privateObjects: (limit = 100) =>
    req<
      Array<{
        id: string;
        title: string | null;
        version: string | number;
        updated_at: string;
        type: string | null;
        snippet: string | null;
        mine: boolean;
        owner_name: string | null;
      }>
    >(`/api/v1/private?limit=${limit}`),
  trash: (limit = 100) =>
    req<
      Array<{
        id: string;
        title: string | null;
        deleted_at: string;
        type: string | null;
        snippet: string | null;
        deleted_by_name: string | null;
      }>
    >(`/api/v1/trash?limit=${limit}`),
  graphSample: (limit = 32) =>
    req<{
      nodes: Array<{ id: string; title: string | null; type: string | null; degree: number }>;
      edges: Array<{ from: string; to: string }>;
    }>(`/api/v1/graph-sample?limit=${limit}`),
  /**
   * ONE page of the whole visible brain (phase 6). The caller assembles pages
   * behind a progress indicator: `nextCursor` is fed back as `after`, and
   * `watermark` is carried so every page of one walk is served against page
   * one's snapshot. `truncated` is never null-and-sampled — a truncated
   * response hands back no cursor and says so out loud in the UI.
   */
  graphPage: (opts: GraphPageQuery = {}) => {
    const p = new URLSearchParams();
    if (opts.after !== undefined) p.set("after", opts.after);
    if (opts.watermark !== undefined) p.set("watermark", opts.watermark);
    if (opts.limit !== undefined) p.set("limit", String(opts.limit));
    if (opts.where !== undefined) p.set("where", JSON.stringify(opts.where));
    if (opts.sample === true) p.set("sample", "1");
    const qs = p.toString();
    return req<GraphPageResponse>(`/api/v1/graph${qs === "" ? "" : `?${qs}`}`);
  },
  /**
   * The time scrubber's window (phase 6). `where` is the SAME filter the view
   * is loaded with, so the intersection is taken against the nodes actually on
   * screen; the server narrows the window to the later of the two bounds.
   */
  graphChanged: (opts: { since: string; where?: WhereNode }) => {
    const p = new URLSearchParams();
    p.set("since", opts.since);
    if (opts.where !== undefined) p.set("where", JSON.stringify(opts.where));
    return req<GraphChangedResponse>(`/api/v1/graph/changed?${p.toString()}`);
  },
  recentObjects: (limit = 12) => req<RecentObject[]>(`/api/v1/recent-objects?limit=${limit}`),
  timeline: (opts: { limit?: number; sinceSeq?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.sinceSeq !== undefined) p.set("since_seq", String(opts.sinceSeq));
    return req<{ events: Array<Record<string, unknown>>; nextSeq: number | null }>(
      `/api/v1/timeline?${p}`,
    );
  },

  // ---- object writes (CAS; CSRF double-submit; scope re-read server-side) --
  // Every one of these rides the same writeRoute gate as the MCP tools' Writer:
  // the actor is the logged-in member, RLS scopes the write, and history +
  // audit ride along. A lost CAS throws ConflictError (rebase or banner); an
  // object we may no longer read throws a plain 404 ApiError.
  createObject: (input: CreateObjectInput) =>
    csrfReq<WriteResult>("/api/v1/objects", "POST", input),
  patchObject: (id: string, patch: PatchObjectInput) =>
    csrfReq<WriteResult>(`/api/v1/objects/${id}`, "PATCH", patch),
  linkObject: (id: string, input: LinkObjectInput) =>
    csrfReq<LinkResult>(`/api/v1/objects/${id}/links`, "POST", input),
  unlinkObject: (id: string, input: UnlinkObjectInput) =>
    csrfReq<UnlinkResult>(`/api/v1/objects/${id}/links`, "DELETE", input),
  /** Trash it — the existing restore path is the undo. */
  deleteObject: (id: string) => csrfReq<WriteResult>(`/api/v1/objects/${id}`, "DELETE"),

  // ---- owner member-admin (CSRF double-submit; server re-checks owner) ----
  createMember: (input: { name: string; email: string; permission: string }) =>
    adminPost<{ id: string; token: string }>("/api/v1/admin/members", input),
  rotateToken: (id: string) => adminPost<{ token: string }>(`/api/v1/admin/members/${id}/rotate`),
  revokeAccount: (id: string) => adminPost<{ ok: boolean }>(`/api/v1/admin/members/${id}/revoke`),

  // ---- tag governance (wave 3; reads are session-level, mutations owner-only
  // server-side — this UI is convenience, not the gate) ----------------------
  tags: () => req<{ tags: TagRow[] }>("/api/v1/tags"),
  createTag: (slug: string) => csrfReq<{ ok: boolean }>("/api/v1/tags", "POST", { slug }),
  grantTag: (slug: string, accountId: string) =>
    csrfReq<{ ok: boolean }>(`/api/v1/tags/${encodeURIComponent(slug)}/grant`, "POST", {
      accountId,
    }),
  revokeTag: (slug: string, accountId: string) =>
    csrfReq<{ ok: boolean }>(`/api/v1/tags/${encodeURIComponent(slug)}/revoke`, "POST", {
      accountId,
    }),
  /** The share sheet (task 14): `who` mixes group tag slugs + member emails;
   *  `require` is custom AND-tags only. `transfer_to` (wave 5) hands the
   *  object's governance to that member (by email) — the server refuses
   *  non-governors and service accounts. Creator-only + containment are
   *  enforced server-side — errors come back written to be shown. */
  shareObject: (
    id: string,
    input: { who?: string[]; require?: string[]; reason?: string; transfer_to?: string },
  ) => csrfReq<WriteResult>(`/api/v1/objects/${id}/share`, "POST", input),

  // ---- owner removals (wave 5; session-level read, owner-only writes with a
  // veto window — any owner, the target included, may cancel) ----------------
  ownerRemovals: () => req<{ removals: OwnerRemoval[] }>("/api/v1/owner-removals"),
  initiateOwnerRemoval: (accountId: string) =>
    csrfReq<{ ok: boolean }>(`/api/v1/owners/${accountId}/removal`, "POST"),
  cancelOwnerRemoval: (removalId: string) =>
    csrfReq<{ ok: boolean }>(`/api/v1/owner-removals/${removalId}/cancel`, "POST"),

  // ---- connectors (enable/disable = owner-only server-side) ----------------
  connectors: () => req<ConnectorStatus[]>("/api/v1/connectors"),
  enableConnector: (
    provider: string,
    fields: Record<string, string>,
    scope: "org" | "personal" = "org",
  ) =>
    csrfReq<{ ok: boolean }>(`/api/v1/connectors/${provider}/config`, "PUT", { ...fields, scope }),
  disableConnector: (provider: string, scope: "org" | "personal" = "org") =>
    csrfReq<{ ok: boolean }>(
      `/api/v1/connectors/${provider}/config${scope === "personal" ? "?scope=personal" : ""}`,
      "DELETE",
    ),
  rescopeConnector: (provider: string, to: "org" | "personal") =>
    csrfReq<{ ok: boolean }>(`/api/v1/connectors/${provider}/config/rescope`, "POST", { to }),
  saveCustomConnector: (
    def: Partial<CustomConnectorDefinition> & { slug: string; name: string; secret?: string },
  ) => csrfReq<{ ok: boolean; slug: string }>("/api/v1/connectors/custom", "POST", def),
  deleteCustomConnector: (slug: string) =>
    csrfReq<{ ok: boolean }>(`/api/v1/connectors/custom/${slug}`, "DELETE"),
  connectConnector: (provider: string) =>
    csrfReq<{ consentUrl: string }>(`/api/v1/connectors/${provider}/connect`, "POST"),
  disconnectConnector: (provider: string) =>
    csrfReq<{ ok: boolean }>(`/api/v1/connectors/${provider}`, "DELETE"),

  // ---- saved views (per-member sidebar chrome; design phase 4) ------------
  // Mutations ride the box's memberRoute (session + CSRF + active account), not
  // the write gate: a saved view is the member's own chrome, not brain content,
  // so a VIEWER saves and pins their own views. The boundary is the 0054 RLS
  // policy — a foreign id is a uniform 404 out of the RLS-bound statement.
  //
  // These four unwrap the response envelope on purpose: every caller wants the
  // list (or the row), and the sidebar and the toolbar must not each re-derive
  // "which key holds it".

  /** The member's own views in sidebar order (pinned first, then position).
   *  `scope: null` selects the GLOBAL views; omitting `scope` selects every
   *  scope, which is what the sidebar wants. */
  views: (opts: { kind?: SavedViewKind; scope?: string | null } = {}) => {
    const p = new URLSearchParams();
    if (opts.kind) p.set("kind", opts.kind);
    // Present-but-empty means "the global ones"; absent means "all of them".
    if ("scope" in opts) p.set("scope", opts.scope ?? "");
    const q = p.toString();
    return req<{ views: SavedView[] }>(`/api/v1/views${q ? `?${q}` : ""}`).then((r) => r.views);
  },
  createView: (input: SavedViewInput) => csrfReq<SavedView>("/api/v1/views", "POST", input),
  patchView: (id: string, patch: SavedViewPatch) =>
    csrfReq<SavedView>(`/api/v1/views/${encodeURIComponent(id)}`, "PATCH", patch),
  deleteView: (id: string) =>
    csrfReq<{ ok: boolean }>(`/api/v1/views/${encodeURIComponent(id)}`, "DELETE"),
  /** Whole-list reorder: `ids` in the order they should sit. Every id must be
   *  the caller's own or the server rolls the whole thing back (404) — a drag
   *  never leaves half the sidebar renumbered. Answers the re-sorted list. */
  reorderViews: (ids: string[]) =>
    csrfReq<{ views: SavedView[] }>("/api/v1/views/reorder", "POST", { ids }).then((r) => r.views),

  // ---- files (the brain filesystem; cookie mirror of the bearer fs API) ---
  /** The listing carries the folder's OWN lock plus one per row, so the file
   *  manager never asks for lock state row by row (see locksFromListing). */
  fsList: (path: string) =>
    req<{ entries: FsEntry[]; lock?: FsLock | null }>(
      `/api/v1/files/list?path=${encodeURIComponent(path)}`,
    ),
  fsUsage: () => req<{ total_bytes: number; quota_bytes: number }>("/api/v1/files/usage"),
  fsMkdir: (path: string) => csrfReq<{ ok: boolean }>("/api/v1/files/mkdir", "POST", { path }),
  fsRename: (from: string, to: string) =>
    csrfReq<{ ok: boolean }>("/api/v1/files/rename", "POST", { from, to }),
  /** `unrecoverable`: paths whose trash snapshot blew the version budget — those
   *  are HARD deleted, so the UI must say so rather than imply an undo exists. */
  fsDelete: (path: string, recursive = false) =>
    csrfReq<{ removed: number; unrecoverable?: string[] }>("/api/v1/files/delete", "POST", {
      path,
      recursive,
    }),
  /** Multipart upload into a DIRECTORY — the file keeps its own name (the
   *  trailing slash tells the server "dir destination"). */
  fsUpload: (dir: string, file: File) => {
    const form = new FormData();
    form.set("path", dir.endsWith("/") ? dir : `${dir}/`);
    form.set("file", file);
    // Not csrfReq: the body is FormData (the browser sets the multipart
    // boundary itself — a manual content-type would break the upload).
    return req<{ path: string; size: number; sha256: string | null; mime: string | null }>(
      "/api/v1/files/upload",
      { method: "POST", headers: { "x-csrf-token": csrfToken() }, body: form },
    );
  },
  /** Download URL for a file — an <a href> target, not a fetch. */
  fsFileUrl: (path: string) => `/api/v1/files/file?path=${encodeURIComponent(path)}`,

  // ---- files · version control, locks, trash ------------------------------
  /** Prior snapshots of one file, newest first (empty when it has no history). */
  fsHistory: (path: string) =>
    req<{ versions: FsVersion[] }>(`/api/v1/files/history?path=${encodeURIComponent(path)}`),
  /** Bytes of ONE snapshot — fetched as text for the diff, never a JSON body. */
  fsVersionUrl: (path: string, version: number) =>
    `/api/v1/files/version?path=${encodeURIComponent(path)}&v=${version}`,
  /** Roll a live file back to a snapshot, or resurrect a deleted path (no
   *  version = the newest snapshot, which for a deleted path is its last bytes). */
  fsRestore: (path: string, version?: number) =>
    csrfReq<{ ok: boolean }>("/api/v1/files/restore", "POST", {
      path,
      ...(version !== undefined ? { version } : {}),
    }),
  fsLockInfo: (path: string) => req<FsLock>(`/api/v1/files/lock?path=${encodeURIComponent(path)}`),
  fsLock: (path: string) =>
    csrfReq<{ ok: boolean } & FsLock>("/api/v1/files/lock", "POST", { path }),
  fsUnlock: (path: string) =>
    csrfReq<{ ok: boolean } & FsLock>("/api/v1/files/unlock", "POST", { path }),
  /** What is recoverable under a prefix (the whole tree when omitted). */
  fsTrash: (prefix?: string) =>
    req<{ entries: FsTrashEntry[] }>(
      `/api/v1/files/trash${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`,
    ),
};

/** The CSRF cookie is deliberately JS-readable (double-submit pattern). */
function csrfToken(): string {
  return document.cookie.match(/(?:^|; )brain_csrf=([^;]*)/)?.[1] ?? "";
}

function csrfReq<T>(path: string, method: string, body?: unknown): Promise<T> {
  return req<T>(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken(),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function adminPost<T>(path: string, body?: unknown): Promise<T> {
  return csrfReq<T>(path, "POST", body);
}
