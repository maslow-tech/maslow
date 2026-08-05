import type { Hono } from "hono";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "@brain/mcp-tools";
import { SchemaExecutor } from "@brain/schema";
import { createBox } from "@brain/box";
import { createFreshBrain, type FreshBrain } from "./support/brain.js";

/**
 * The workspace acceptance run (design phase 4): a real box on a real Postgres,
 * driven the way a member's browser drives it.
 *
 * The SPA's jsdom tests render components against a stubbed `api`; the box's
 * integration tests exercise the endpoints with hand-built requests. Both can be
 * green while the product is broken, because neither one runs the code that
 * joins them: the client modules that decide WHAT to send. So this file boots
 * the box and then drives the SPA's OWN modules over it —
 *
 *   - `lib/api.ts`         the typed client, verbatim (cookies, CSRF, envelope)
 *   - `lib/saveQueue.ts`   the editor's write path (debounce, coalesce, flush)
 *   - `lib/draftMirror.ts` the crash net the queue mirrors into
 *   - `lib/viewConfig.ts`  the filter model and its account-scoped persistence
 *   - `lib/peek.tsx`       the side-peek store (the URL IS the store)
 *
 * — through a browser shim thin enough to be obviously correct: a cookie jar, a
 * Map-backed storage pair, and a `fetch` that hands the request to `app.request`
 * and absorbs the Set-Cookie it answers with. Nothing about the wire is faked;
 * `document.cookie`, `localStorage` and the session all belong to whichever
 * `Session` is active, so a member and a viewer are two browsers, not two
 * variables.
 *
 * What is deliberately NOT here: pixels. React rendering, drag gestures and
 * disabled-button sweeps live in the jsdom suites (`layouts.test.tsx`,
 * `SidePeek.test.tsx`, `SavedViews.test.tsx`, `QuickCreate.test.tsx`) where the
 * DOM exists. Each case below therefore states the gesture it stands in for and
 * asserts the thing a rendering test cannot see: what the server ended up
 * holding, and how many requests it took to get there.
 *
 * Client modules are imported through NON-LITERAL specifiers, exactly as
 * `dashboard-views.integration.test.ts` does: they are browser modules, and a
 * static import would drag the SPA's DOM-typed sources into this package's
 * node-typed tsc program. Vitest resolves and transforms them at runtime; tsc
 * never follows them, so the shapes below are restated structurally.
 */

const API_MODULE = "../../apps/box/ui/src/lib/api.js";
const SAVE_QUEUE_MODULE = "../../apps/box/ui/src/lib/saveQueue.js";
const DRAFT_MIRROR_MODULE = "../../apps/box/ui/src/lib/draftMirror.js";
const VIEW_CONFIG_MODULE = "../../apps/box/ui/src/lib/viewConfig.js";
const PEEK_MODULE = "../../apps/box/ui/src/lib/peek";
const SECRET = "test-session-secret-please-change";

/* ------------------------------------------------------------ client shapes */
// Restated structurally (see the note above). Only the members this file uses.

type Scalar = string | number | boolean | null;
type FilterOp =
  "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "like" | "ilike" | "in" | "is_null" | "is_not_null";

interface Filter {
  prop: string;
  op: FilterOp;
  value?: Scalar | Scalar[];
}

interface ViewConfig {
  layout: "table" | "board" | "gallery" | "calendar";
  filters: Filter[];
  sort: Array<{ prop: string; dir: "asc" | "desc" }>;
  groupBy: string | null;
  dateProp: string | null;
  columns: Array<{ key: string; visible: boolean; width?: number }>;
}

interface ListQuery {
  where?: unknown;
  sort?: { field: string; dir: "asc" | "desc" };
}

interface DraftFields {
  title?: string | null;
  body?: string;
  visibility?: "org" | "private";
  props?: Record<string, unknown>;
}

interface StoredDraft {
  fields: DraftFields;
  baseVersion: number;
  savedAt: number;
}

interface WriteResult {
  id: string;
  version: number;
}

interface ListItem {
  id: string;
  title: string | null;
  version: string | number;
  updated_at: string;
  props?: Record<string, unknown>;
}

interface BrainObject {
  id: string;
  type: string | null;
  title: string | null;
  body: string | null;
  version: number;
  visibility: "org" | "private";
  props: Record<string, unknown>;
}

interface SavedView {
  id: string;
  kind: "database" | "graph";
  scope: string | null;
  name: string;
  config: Record<string, unknown>;
  pinned: boolean;
  position: number;
}

interface PatchInput {
  baseVersion: number;
  title?: string | null;
  body?: string;
  props?: Record<string, unknown>;
  visibility?: "org" | "private";
}

interface DashApi {
  login(token: string): Promise<{ ok: boolean; role: string; appVersion: string }>;
  whoami(): Promise<{ id: string; name: string; role: string; scopes: string[] }>;
  types(): Promise<Array<{ id: number; name: string; count: number; properties: unknown[] }>>;
  list(
    type: string,
    opts?: { limit?: number; where?: unknown; sort?: unknown },
  ): Promise<{ items: ListItem[]; nextCursor: string | null }>;
  object(id: string): Promise<BrainObject>;
  createObject(input: {
    type?: string;
    title?: string;
    body?: string;
    props?: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<WriteResult>;
  patchObject(id: string, patch: PatchInput): Promise<WriteResult>;
  deleteObject(id: string): Promise<WriteResult>;
  linkObject(
    id: string,
    input: { to: string; rel: string; idempotencyKey: string },
  ): Promise<unknown>;
  setBranding(body: { name?: string | null }): Promise<unknown>;
  createMember(input: { name: string; email: string; permission: string }): Promise<unknown>;
  views(opts?: { kind?: string; scope?: string | null }): Promise<SavedView[]>;
  createView(input: {
    kind?: string;
    scope?: string | null;
    name: string;
    config: Record<string, unknown>;
    pinned?: boolean;
  }): Promise<SavedView>;
  deleteView(id: string): Promise<{ ok: boolean }>;
  fsMkdir(path: string): Promise<{ ok: boolean }>;
  fsList(path: string): Promise<{ entries: Array<{ name: string; kind: string }> }>;
}

interface SaveQueue {
  change(fields: DraftFields): void;
  flush(): Promise<void>;
  flushBeacon(): void;
  hasPending(): boolean;
  baseVersion(): number;
  dispose(): void;
}

interface SaveQueueOptions {
  objectId: string;
  baseVersion: number;
  base?: { title?: string | null; body?: string | null; props?: Record<string, unknown> };
  save(patch: PatchInput, baseVersion: number): Promise<WriteResult>;
  sendBeacon?(req: { objectId: string; patch: PatchInput }): void;
  mirror?: { write(fields: DraftFields, baseVersion: number): void; clear(): void };
  onState?(event: { kind: string; [k: string]: unknown }): void;
  debounceMs?: number;
}

/* ------------------------------------------------------------ browser shim */

/** The three storage methods every client module actually calls, plus the
 *  index pair the purge loops walk. */
class MemoryStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  /** Everything under a prefix — used to assert what a session left behind. */
  keysWithPrefix(prefix: string): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

/**
 * One browser. The cookie jar is the session (HttpOnly `brain_session` plus the
 * JS-readable `brain_csrf` the double-submit needs), and storage is per browser
 * because that is what "member B signs in where member A was" means.
 */
class Session {
  readonly cookies = new Map<string, string>();
  readonly local = new MemoryStorage();
  readonly sessionStorage = new MemoryStorage();

  constructor(readonly label: string) {}

  /** What the browser sends, and what `document.cookie` reads. */
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(setCookie: string): void {
    const [pair] = setCookie.split(";");
    const eq = (pair ?? "").indexOf("=");
    if (eq <= 0) return;
    const name = (pair ?? "").slice(0, eq).trim();
    const value = (pair ?? "").slice(eq + 1).trim();
    if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(setCookie)) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}

interface WireEntry {
  method: string;
  path: string;
  session: string;
}

/** Every request the client modules issued, in order. The counts matter: "one
 *  drag is one patch" and "opening a peek refetches nothing" are both claims
 *  about how many requests happened, which only a shim at this level can see. */
const wire: WireEntry[] = [];

let active: Session;
let reloads = 0;

function setCookies(res: Response): string[] {
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

/** The real one, kept so teardown can put it back: the e2e suite runs every
 *  file in ONE fork, and a global `fetch` left pointing at a dropped database
 *  would break whatever runs next. */
const realFetch = globalThis.fetch;

function installBrowser(app: Hono): void {
  const g = globalThis as unknown as Record<string, unknown>;

  g["fetch"] = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    const cookie = active.header();
    if (cookie) headers.set("cookie", cookie);
    wire.push({ method: (init?.method ?? "GET").toUpperCase(), path, session: active.label });
    const res = await app.request(path, { ...init, headers });
    for (const line of setCookies(res)) active.absorb(line);
    return res;
  };

  // `document.cookie` is how api.ts reads the CSRF token (double-submit); it
  // must follow the active session, not be captured once.
  g["document"] = {
    get cookie(): string {
      return active.header();
    },
    set cookie(v: string) {
      active.absorb(v);
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => active.local,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get: () => active.sessionStorage,
  });
  // api.ts's version-skew fail-safe. Never expected to fire in one process
  // against one app — asserted at the end, because a reload here would mean the
  // client and the box disagree about what version is serving the page.
  g["location"] = {
    href: "http://box.test/",
    reload: () => {
      reloads += 1;
    },
  };
}

function uninstallBrowser(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g["fetch"] = realFetch;
  delete g["document"];
  delete g["location"];
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "sessionStorage");
}

/** Run as one browser. Every client call inside sees that session's cookies and
 *  that session's storage. */
async function as<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  const previous = active;
  active = session;
  try {
    return await fn();
  } finally {
    active = previous;
  }
}

/** A cursor into the wire log, so a case can assert what IT caused. */
function mark(): number {
  return wire.length;
}
function since(from: number, match?: (e: WireEntry) => boolean): WireEntry[] {
  return wire.slice(from).filter((e) => (match ? match(e) : true));
}
const isWrite = (e: WireEntry): boolean => e.method !== "GET";
const isList = (e: WireEntry): boolean => e.path.startsWith("/api/v1/list");

describe("e2e · the workspace dashboard, driven as a member", () => {
  let brain: FreshBrain;
  let pool: Pool;
  let ownerClient: Client;
  let app: Hono;

  let api: DashApi;
  let ApiError: new (...args: never[]) => Error;
  let ConflictError: new (...args: never[]) => Error;
  let newIdempotencyKey: () => string;
  let createSaveQueue: (opts: SaveQueueOptions) => SaveQueue;
  let writeDraft: (a: string, o: string, f: DraftFields, v: number) => void;
  let readDraft: (a: string, o: string) => StoredDraft | null;
  let clearDraft: (a: string, o: string) => void;
  let applicability: (d: StoredDraft, v: number) => "auto" | "offer";
  let defaultConfigFor: (t: unknown) => ViewConfig;
  let normalizeConfig: (raw: unknown, fallback: ViewConfig) => ViewConfig;
  let toListQuery: (c: ViewConfig) => ListQuery;
  let readViewConfig: (a: string, t: string, f: ViewConfig) => ViewConfig;
  let writeViewConfig: (a: string, t: string, c: ViewConfig) => void;
  let viewConfigKey: (a: string, t: string) => string;
  let parsePeekStack: (search: string | URLSearchParams) => readonly string[];
  let pushPeek: (stack: readonly string[], id: string) => readonly string[];
  let popPeek: (stack: readonly string[]) => readonly string[];
  let withPeekStack: (p: URLSearchParams, stack: readonly string[]) => URLSearchParams;
  let registerPeekFlush: (id: string, flush: () => void | Promise<void>) => () => void;
  let flushPeek: (id: string | null) => void;

  const member = new Session("member");
  const viewer = new Session("viewer");
  let memberId: string;
  let dealType: { name: string; properties: unknown[] } | undefined;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    brain = await createFreshBrain();
    pool = new Pool(brain.appConfig);
    ownerClient = await brain.connect("owner");
    app = createBox({
      pool,
      ownerClient,
      dashboard: { sessionSecret: SECRET, secureCookies: false },
    });

    // The shim must exist before api.ts is imported: its module body is inert,
    // but nothing in it may be tempted to read a global that is not there yet.
    active = member;
    installBrowser(app);

    const apiMod = (await import(API_MODULE)) as {
      api: DashApi;
      ApiError: new (...args: never[]) => Error;
      ConflictError: new (...args: never[]) => Error;
      newIdempotencyKey: () => string;
    };
    ({ api, ApiError, ConflictError, newIdempotencyKey } = apiMod);
    ({ createSaveQueue } = (await import(SAVE_QUEUE_MODULE)) as {
      createSaveQueue: typeof createSaveQueue;
    });
    ({ writeDraft, readDraft, clearDraft, applicability } = (await import(DRAFT_MIRROR_MODULE)) as {
      writeDraft: typeof writeDraft;
      readDraft: typeof readDraft;
      clearDraft: typeof clearDraft;
      applicability: typeof applicability;
    });
    ({
      defaultConfigFor,
      normalizeConfig,
      toListQuery,
      readViewConfig,
      writeViewConfig,
      viewConfigKey,
    } = (await import(VIEW_CONFIG_MODULE)) as {
      defaultConfigFor: typeof defaultConfigFor;
      normalizeConfig: typeof normalizeConfig;
      toListQuery: typeof toListQuery;
      readViewConfig: typeof readViewConfig;
      writeViewConfig: typeof writeViewConfig;
      viewConfigKey: typeof viewConfigKey;
    });
    ({ parsePeekStack, pushPeek, popPeek, withPeekStack, registerPeekFlush, flushPeek } =
      (await import(PEEK_MODULE)) as {
        parsePeekStack: typeof parsePeekStack;
        pushPeek: typeof pushPeek;
        popPeek: typeof popPeek;
        withPeekStack: typeof withPeekStack;
        registerPeekFlush: typeof registerPeekFlush;
        flushPeek: typeof flushPeek;
      });

    const admin = new Admin(pool);
    const boot = await admin.bootstrapOwner({ name: "Owner", email: "owner@example.com" });
    const memberToken = (
      await admin.createUser(boot.id, {
        name: "Mira",
        email: "mira@example.com",
        permission: "member",
      })
    ).token;
    const viewerToken = (
      await admin.createUser(boot.id, {
        name: "Vic",
        email: "vic@example.com",
        permission: "viewer",
      })
    ).token;

    // One type with a board axis (enum), a date, and scalars to filter and sort
    // on — the shape every layout in phase 3 renders.
    const exec = new SchemaExecutor(ownerClient);
    const t = await exec.defineType({ name: "deal" }, boot.id);
    await exec.addProperty(
      { typeId: t.typeId, name: "stage", kind: "enum", enumValues: ["open", "won", "lost"] },
      boot.id,
    );
    await exec.addProperty({ typeId: t.typeId, name: "city", kind: "text" }, boot.id);
    await exec.addProperty({ typeId: t.typeId, name: "amount", kind: "int" }, boot.id);
    await exec.addProperty({ typeId: t.typeId, name: "due", kind: "date" }, boot.id);

    await as(member, async () => {
      const login = await api.login(memberToken);
      expect(login.role).toBe("member");
      memberId = (await api.whoami()).id;
      dealType = (await api.types()).find((x) => x.name === "deal") as typeof dealType;

      const make = async (title: string, props: Record<string, unknown>): Promise<void> => {
        const r = await api.createObject({
          type: "deal",
          title,
          props,
          idempotencyKey: newIdempotencyKey(),
        });
        ids[title] = r.id;
      };
      await make("Alpha", { stage: "open", city: "Austin", amount: 10, due: "2026-07-15" });
      await make("Beta", { stage: "open", city: "Dallas", amount: 40, due: "2026-07-02" });
      await make("Gamma", { stage: "won", city: "Austin", amount: 25, due: "2026-07-09" });
    });

    await as(viewer, async () => {
      const login = await api.login(viewerToken);
      expect(login.role).toBe("viewer");
    });
  }, 180_000);

  afterAll(async () => {
    uninstallBrowser();
    await ownerClient?.end();
    await pool?.end();
    await brain?.drop();
  });

  /* ------------------------------------------------------------------ ⌘N */

  describe("⌘N", () => {
    /**
     * QuickCreate mints ONE idempotency key per intent and reuses it for every
     * submission of that intent (the busy flag stops the second click; the
     * error path keeps the key so "Retry" is the same intent). The rule only
     * matters if the box honours it, which is what this asserts: pressing
     * Create twice — the double-submit, and its uglier twin, the retry after a
     * response we never saw — leaves ONE object.
     */
    it("a double-submitted create leaves exactly one object", async () => {
      await as(member, async () => {
        const key = newIdempotencyKey();
        const first = await api.createObject({
          type: "deal",
          title: "Kickoff",
          idempotencyKey: key,
        });
        const second = await api.createObject({
          type: "deal",
          title: "Kickoff",
          idempotencyKey: key,
        });

        expect(second.id).toBe(first.id);
        expect(second.version).toBe(first.version);

        const found = await api.list("deal", {
          where: { field: "title", op: "eq", value: "Kickoff" },
          limit: 50,
        });
        expect(found.items).toHaveLength(1);
        expect(found.items[0]?.id).toBe(first.id);
        ids["Kickoff"] = first.id;
      });
    });

    it("changing the intent mints a new key, and that IS a second object", async () => {
      // The other half of the rule: retitling in the dialog clears the key
      // (`retitle()` sets keyRef to null), so it must not collapse onto the
      // first object. An over-eager idempotency window would eat real creates.
      await as(member, async () => {
        const a = await api.createObject({
          type: "deal",
          title: "Retro",
          idempotencyKey: newIdempotencyKey(),
        });
        const b = await api.createObject({
          type: "deal",
          title: "Retro (Q3)",
          idempotencyKey: newIdempotencyKey(),
        });
        expect(b.id).not.toBe(a.id);
        const found = await api.list("deal", {
          where: { field: "title", op: "ilike", value: "%Retro%" },
          limit: 50,
        });
        expect(found.items).toHaveLength(2);
      });
    });

    it("the created object is the one the editor then opens", async () => {
      // ⌘N navigates to /o/<id> on the response; a create that answered an id
      // the object route cannot read would land the member on a blank page.
      await as(member, async () => {
        const o = await api.object(ids["Kickoff"] as string);
        expect(o.type).toBe("deal");
        expect(o.title).toBe("Kickoff");
        expect(o.version).toBe(1);
      });
    });
  });

  /* -------------------------------------------------------- block editor */

  describe("the block editor", () => {
    /** The peek panel's and the object page's own wiring, verbatim. */
    const editorQueue = (
      id: string,
      o: BrainObject,
      onState?: (e: { kind: string; [k: string]: unknown }) => void,
    ): SaveQueue =>
      createSaveQueue({
        objectId: id,
        baseVersion: o.version,
        base: { title: o.title, body: o.body ?? "", props: { ...o.props } },
        save: (patch) => api.patchObject(id, patch),
        mirror: {
          write: (fields, baseVersion) => writeDraft(memberId, id, fields, baseVersion),
          clear: () => clearDraft(memberId, id),
        },
        // The debounce is real in the browser; here the flush is what the test
        // is about (blur, navigate, close-the-peek), so it is kept short so a
        // stray timer cannot outlive the case.
        debounceMs: 5,
        ...(onState ? { onState } : {}),
      });

    it("typing persists across a reload, in ONE patch", async () => {
      await as(member, async () => {
        const id = ids["Alpha"] as string;
        const before = await api.object(id);
        const states: string[] = [];
        const queue = editorQueue(id, before, (e) => states.push(e.kind));

        const at = mark();
        // Keystrokes: the editor emits the whole document on every change, and
        // the queue coalesces them. Three "keystrokes" must not be three writes.
        queue.change({ body: "# Alpha\n\nkick" });
        queue.change({ body: "# Alpha\n\nkickoff notes" });
        queue.change({ body: "# Alpha\n\nkickoff notes — signed" });
        await queue.flush();
        queue.dispose();

        const patches = since(at, (e) => e.method === "PATCH");
        expect(patches).toHaveLength(1);
        expect(states).toContain("saved");
        expect(states).toContain("idle");

        // Reload: a fresh read is all the editor has on next mount.
        const after = await api.object(id);
        expect(after.body).toBe("# Alpha\n\nkickoff notes — signed");
        expect(after.version).toBe(before.version + 1);
        // …and the mirror is empty, so the reloaded editor shows the server's
        // text rather than offering a recovery banner for text already saved.
        expect(readDraft(memberId, id)).toBeNull();
      });
    });

    it("text typed but never sent survives the tab closing", async () => {
      await as(member, async () => {
        const id = ids["Beta"] as string;
        const o = await api.object(id);
        // The tab-close transport is the one thing injected here, because the
        // contract under test is its ORDER — mirror first, then send — and the
        // real one is deliberately unobservable (it cannot read a response).
        const beacons: Array<{ objectId: string; patch: PatchInput }> = [];
        const queue = createSaveQueue({
          objectId: id,
          baseVersion: o.version,
          base: { title: o.title, body: o.body ?? "", props: { ...o.props } },
          save: (patch) => api.patchObject(id, patch),
          sendBeacon: (req) => beacons.push(req),
          mirror: {
            write: (fields, baseVersion) => writeDraft(memberId, id, fields, baseVersion),
            clear: () => clearDraft(memberId, id),
          },
          debounceMs: 60_000, // the debounce must not be what saves this
        });

        const at = mark();
        queue.change({ body: "half a thought" });
        expect(since(at, isWrite), "typing must not hit the wire").toHaveLength(0);

        // The draft is in storage BEFORE anything is sent.
        const stored = readDraft(memberId, id);
        expect(stored?.fields.body).toBe("half a thought");
        expect(stored?.baseVersion).toBe(o.version);
        // Same version ⇒ the next load applies it silently; a moved object
        // would offer it instead of overwriting whoever moved it.
        expect(applicability(stored as StoredDraft, o.version)).toBe("auto");

        // pagehide.
        queue.flushBeacon();
        queue.dispose();
        expect(beacons).toHaveLength(1);
        expect(beacons[0]?.patch).toEqual({ baseVersion: o.version, body: "half a thought" });
        // Delivery is never assumed, so the mirror is NOT cleared here.
        expect(readDraft(memberId, id)?.fields.body).toBe("half a thought");

        // And what the beacon would have sent is what the box accepts.
        const r = await api.patchObject(id, beacons[0]?.patch as PatchInput);
        expect(r.version).toBe(o.version + 1);
        expect((await api.object(id)).body).toBe("half a thought");
        clearDraft(memberId, id);
      });
    });

    it("an edit onto a stale version stops rather than clobbering", async () => {
      await as(member, async () => {
        const id = ids["Gamma"] as string;
        const o = await api.object(id);
        // Someone else (an agent over MCP, another tab) moves it first.
        await api.patchObject(id, { baseVersion: o.version, body: "written by someone else" });

        const conflicts: Array<{ kind: string }> = [];
        const queue = editorQueue(id, o, (e) => conflicts.push(e));
        queue.change({ body: "mine" });
        await queue.flush();
        queue.dispose();

        expect(conflicts.map((c) => c.kind)).toContain("conflict");
        expect((await api.object(id)).body).toBe("written by someone else");
        // The draft is KEPT: the member's text is never thrown away to resolve
        // a conflict for them.
        expect(readDraft(memberId, id)?.fields.body).toBe("mine");
        clearDraft(memberId, id);
      });
    });
  });

  /* ---------------------------------------------------------- board drag */

  describe("a board drag", () => {
    /** What the board renders from: its group property compiled through the
     *  one filter model, exactly as TypeView asks for it. */
    const boardConfig = (over: Partial<ViewConfig> = {}): ViewConfig => ({
      ...defaultConfigFor(dealType),
      layout: "board",
      groupBy: "stage",
      sort: [{ prop: "title", dir: "asc" }],
      filters: [],
      ...over,
    });

    const column = async (stage: string): Promise<string[]> => {
      const cfg = boardConfig({ filters: [{ prop: "stage", op: "eq", value: stage }] });
      const q = toListQuery(cfg);
      const res = await api.list("deal", { limit: 50, ...q });
      return res.items.map((i) => i.title ?? "");
    };

    it("dropping a card is one patch of one prop and one version", async () => {
      await as(member, async () => {
        const id = ids["Beta"] as string;
        const before = await api.object(id);
        expect(before.props["stage"]).toBe("open");

        const at = mark();
        // TypeView.onPatch, verbatim: the changed prop and the row's version.
        const r = await api.patchObject(id, {
          baseVersion: before.version,
          props: { stage: "won" },
        });

        // One drop, one request. A layout that also "refreshed" would double
        // the write and race itself.
        expect(since(at, isWrite)).toHaveLength(1);
        expect(r.version).toBe(before.version + 1);

        const after = await api.object(id);
        expect(after.props["stage"]).toBe("won");
        // Field-granular: the drag moved the group property and nothing else.
        expect(after.props["city"]).toBe(before.props["city"]);
        expect(after.props["amount"]).toBe(before.props["amount"]);
        expect(after.title).toBe(before.title);
        expect(after.body).toBe(before.body);
      });
    });

    it("the card is in the column the board now reads", async () => {
      await as(member, async () => {
        expect(await column("won")).toContain("Beta");
        expect(await column("open")).not.toContain("Beta");
      });
    });

    it("re-dropping on the version it already spent is refused, not re-applied", async () => {
      await as(member, async () => {
        const id = ids["Beta"] as string;
        const o = await api.object(id);
        await expect(
          api.patchObject(id, { baseVersion: o.version - 1, props: { stage: "lost" } }),
        ).rejects.toBeInstanceOf(ConflictError);
        const after = await api.object(id);
        expect(after.version).toBe(o.version);
        expect(after.props["stage"]).toBe("won");
      });
    });
  });

  /* ------------------------------------------------------------ side-peek */

  describe("the side-peek", () => {
    /**
     * A peek is "this object, open over what I was already looking at". The URL
     * is the whole store, and that is precisely what keeps the table underneath
     * intact: opening one only adds `?peek=<id>` to the CURRENT route, so react
     * -router never changes the matched path, the table never remounts, and its
     * scroll container is never rebuilt. Scroll offsets are a DOM fact that no
     * server can see — what a server CAN prove is the two conditions that would
     * destroy them: a route change, or a refetch of the list. Both are asserted.
     */
    it("open → edit → close leaves the route, the filters and the list untouched", async () => {
      await as(member, async () => {
        const cfg: ViewConfig = {
          ...defaultConfigFor(dealType),
          layout: "table",
          filters: [{ prop: "city", op: "eq", value: "Austin" }],
          sort: [{ prop: "title", dir: "asc" }],
        };
        writeViewConfig(memberId, "deal", cfg);
        const storedBefore = active.local.getItem(viewConfigKey(memberId, "deal"));

        // The table the member is looking at, scrolled deep into a long list.
        // Its own URL state — the params react-router matches the route on —
        // is everything except `peek`.
        const params = new URLSearchParams({ tab: "table", cursor: "row-40" });
        const at = mark();
        const rowsBefore = (await api.list("deal", { limit: 50, ...toListQuery(cfg) })).items;
        expect(rowsBefore.map((r) => r.title)).toEqual(["Alpha", "Gamma"]);

        // ---- open ------------------------------------------------------
        const id = ids["Gamma"] as string;
        const opened = withPeekStack(params, pushPeek(parsePeekStack(params), id));
        expect(opened.get("peek")).toBe(id);
        // Opening added ONE param and rewrote none: the route is matched on
        // what is left, so nothing under the panel unmounts.
        expect([...opened.keys()].sort()).toEqual(["cursor", "peek", "tab"]);
        expect(opened.get("tab")).toBe("table");
        expect(opened.get("cursor")).toBe("row-40");

        // The panel loads its own object. That is the ONLY read a peek costs —
        // no list request, which is what would reset the scroll position.
        const o = await api.object(id);
        expect(since(at, isList)).toHaveLength(1); // the one from before the peek

        // ---- edit ------------------------------------------------------
        const queue = createSaveQueue({
          objectId: id,
          baseVersion: o.version,
          base: { title: o.title, body: o.body ?? "", props: { ...o.props } },
          save: (patch) => api.patchObject(id, patch),
          mirror: {
            write: (fields, baseVersion) => writeDraft(memberId, id, fields, baseVersion),
            clear: () => clearDraft(memberId, id),
          },
          // Long enough that the debounce CANNOT be what saves it — the close
          // is.
          debounceMs: 60_000,
        });
        const unregister = registerPeekFlush(id, () => queue.flush());
        queue.change({ title: "Gamma renamed in the peek" });
        expect(queue.hasPending()).toBe(true);

        // ---- close -----------------------------------------------------
        // closePeek() kicks the registered flush and then pops the stack.
        flushPeek(id);
        await queue.flush();
        unregister();
        queue.dispose();
        const closed = withPeekStack(opened, popPeek(parsePeekStack(opened)));

        // The edit landed…
        expect((await api.object(id)).title).toBe("Gamma renamed in the peek");
        // …and closing put the URL back exactly as it was, param for param, so
        // the table underneath was never remounted and its scroll offset is
        // still the member's.
        expect(closed.get("peek")).toBeNull();
        expect(closed.toString()).toBe(params.toString());
        // …the saved filters are byte-identical…
        expect(active.local.getItem(viewConfigKey(memberId, "deal"))).toBe(storedBefore);
        expect(readViewConfig(memberId, "deal", defaultConfigFor(dealType))).toEqual(cfg);
        // …and nothing re-listed behind the panel.
        expect(since(at, isList)).toHaveLength(1);
      });
    });

    it("the row the peek edited is the row the table would now show", async () => {
      // The table is not refetched on close, but a member who does refresh must
      // see the peek's edit — the write went through the same CAS path the
      // table's own inline edit uses, not a side channel.
      await as(member, async () => {
        const cfg: ViewConfig = {
          ...defaultConfigFor(dealType),
          filters: [{ prop: "city", op: "eq", value: "Austin" }],
          sort: [{ prop: "title", dir: "asc" }],
        };
        const rows = (await api.list("deal", { limit: 50, ...toListQuery(cfg) })).items;
        expect(rows.map((r) => r.title)).toEqual(["Alpha", "Gamma renamed in the peek"]);
      });
    });

    it("a peek stack never mounts the same object twice, and is capped", async () => {
      // The URL is user-suppliable; two live editors on one object would fight.
      const hostile = new URLSearchParams({ peek: [ids["Alpha"], ids["Alpha"]].join(",") });
      expect(parsePeekStack(hostile)).toEqual([ids["Alpha"]]);
      expect(parsePeekStack(new URLSearchParams({ peek: "../etc/passwd" }))).toEqual([]);
    });
  });

  /* --------------------------------------------------------- saved views */

  describe("a pinned saved view", () => {
    let saved: SavedView;

    it("pins to the sidebar and comes back in sidebar order", async () => {
      await as(member, async () => {
        const cfg: ViewConfig = {
          ...defaultConfigFor(dealType),
          layout: "board",
          groupBy: "stage",
          filters: [{ prop: "city", op: "eq", value: "Austin" }],
          sort: [{ prop: "amount", dir: "desc" }],
        };
        saved = await api.createView({
          kind: "database",
          scope: "deal",
          name: "Austin pipeline",
          config: cfg as unknown as Record<string, unknown>,
          pinned: true,
        });
        expect(saved.pinned).toBe(true);

        // What the sidebar asks for: every scope, in the server's order.
        const all = await api.views();
        const row = all.find((v) => v.id === saved.id);
        expect(row, "the pinned view is not in the sidebar list").toBeTruthy();
        expect(all.filter((v) => v.pinned).map((v) => v.id)).toContain(saved.id);
        expect(all.findIndex((v) => v.id === saved.id)).toBe(0); // pinned ride first
      });
    });

    it("restores its filters on a browser that has never seen this type", async () => {
      await as(member, async () => {
        // A different machine: no local working state at all.
        active.local.clear();
        expect(readViewConfig(memberId, "deal", defaultConfigFor(dealType)).filters).toEqual([]);

        const row = (await api.views({ kind: "database", scope: "deal" })).find(
          (v) => v.id === saved.id,
        ) as SavedView;
        // The host normalizes what comes back — a saved config is a config an
        // older release wrote, treated exactly as hostile-shaped as storage.
        const restored = normalizeConfig(row.config, defaultConfigFor(dealType));
        expect(restored.layout).toBe("board");
        expect(restored.groupBy).toBe("stage");
        expect(restored.filters).toEqual([{ prop: "city", op: "eq", value: "Austin" }]);
        expect(restored.sort).toEqual([{ prop: "amount", dir: "desc" }]);

        // And it MEANS the same thing to the server it meant when it was saved.
        const res = await api.list("deal", { limit: 50, ...toListQuery(restored) });
        expect(res.items.map((i) => i.title)).toEqual(["Gamma renamed in the peek", "Alpha"]);
      });
    });

    it("belongs to the member who saved it and to nobody else", async () => {
      // The row can embed a private object's id or title in a filter literal,
      // which is why 0053 is per-member FORCE RLS. The boundary is proven at
      // the SQL level in saved-views.integration.test.ts; this is the session
      // -level restatement: another browser, signed in as someone else, does
      // not see it anywhere in the sidebar.
      await as(viewer, async () => {
        const theirs = await api.views();
        expect(theirs.map((v) => v.id)).not.toContain(saved.id);
        for (const v of theirs) expect(v.name).not.toBe("Austin pipeline");
      });
    });
  });

  /* -------------------------------------------------------------- viewer */

  describe("a viewer session", () => {
    /**
     * The read-only UI is UX; the boundary is the server, which re-reads the
     * account's real scopes per request rather than trusting the cookie. So the
     * claim "no write affordances anywhere" is tested from both ends: the role
     * every layout gates `canWrite` on, and then every write the dashboard
     * could possibly issue, refused.
     */
    it("whoami says viewer — the flag every write affordance is gated on", async () => {
      await as(viewer, async () => {
        const me = await api.whoami();
        expect(me.role).toBe("viewer");
        expect(me.scopes).toEqual(["read"]);
      });
    });

    /*
     * The ⌘N affordance gate USED TO BE ASSERTED HERE, as two regexes over
     * Shell.tsx's SOURCE TEXT. That is not a test of behaviour: it passes
     * whether or not the app does anything with the line it matched, it goes
     * red on a rename that changes nothing, and it stays green if the gate's
     * only USE is deleted. It has moved to `apps/box/ui/src/views/Shell.test.tsx`
     * ("quick-create is gated on the role, not just on buttons"), which has a
     * DOM and therefore presses the key: a member gets the dialog, a viewer
     * gets nothing. This file keeps what it is actually good at — proving the
     * SERVER refuses every write a viewer could issue, which is where the
     * boundary really is.
     */

    it("every write the dashboard offers is refused, and changes nothing", async () => {
      const id = ids["Alpha"] as string;
      const before = await as(member, () => api.object(id));

      // Every affordance the SPA hides from a viewer, attempted anyway. All but
      // one are the write gate (403, scopes re-read from the DB per request);
      // the file manager's boundary is the FsStore itself, which refuses a
      // read-only ctx with its EROFS teaching error — a different status for a
      // different (and equally closed) door, pinned so a silently-succeeding
      // mkdir cannot hide behind "it errored somehow".
      const refusals: Array<{ affordance: string; status: number; go: () => Promise<unknown> }> = [
        {
          affordance: "⌘N / New row",
          status: 403,
          go: () => api.createObject({ type: "deal", title: "V", idempotencyKey: "v1" }),
        },
        {
          affordance: "inline cell edit / board drag",
          status: 403,
          go: () => api.patchObject(id, { baseVersion: before.version, props: { stage: "lost" } }),
        },
        {
          affordance: "block editor",
          status: 403,
          go: () => api.patchObject(id, { baseVersion: before.version, body: "viewer text" }),
        },
        { affordance: "delete to trash", status: 403, go: () => api.deleteObject(id) },
        {
          affordance: "link picker",
          status: 403,
          go: () =>
            api.linkObject(id, {
              to: ids["Gamma"] as string,
              rel: "related",
              idempotencyKey: "v2",
            }),
        },
        {
          affordance: "branding",
          status: 403,
          go: () => api.setBranding({ name: "Viewer Co" }),
        },
        {
          affordance: "member admin",
          status: 403,
          go: () => api.createMember({ name: "X", email: "x@example.com", permission: "member" }),
        },
        {
          affordance: "file manager",
          status: 400,
          go: () => api.fsMkdir("/shared/viewer-made-this"),
        },
      ];

      await as(viewer, async () => {
        for (const { affordance, status, go } of refusals) {
          let err: unknown;
          try {
            await go();
          } catch (e) {
            err = e;
          }
          expect(err, `${affordance} was NOT refused`).toBeInstanceOf(ApiError);
          expect((err as { status: number }).status, affordance).toBe(status);
        }
        // The file manager's refusal says WHY, because a viewer who cannot tell
        // a permission wall from a bug files the wrong ticket.
        await expect(api.fsMkdir("/shared/viewer-made-this")).rejects.toThrow(/read-only/i);
        // And it really did not create the directory.
        const listed = await api.fsList("/shared");
        expect(listed.entries.some((e) => e.name === "viewer-made-this")).toBe(false);
      });

      // Nothing moved: a refusal that had already written would be worse than
      // no refusal at all.
      const after = await as(member, () => api.object(id));
      expect(after.version).toBe(before.version);
      expect(after.props).toEqual(before.props);
      expect(after.body).toBe(before.body);
      const deals = await as(member, () => api.list("deal", { limit: 100 }));
      expect(deals.items.some((i) => i.title === "V")).toBe(false);
    });

    it("but a viewer still owns their own chrome — saved views are not brain content", async () => {
      // The deliberate deviation: saved-view mutations ride memberRoute, not
      // the write gate. A viewer arranges their own sidebar; the rows are
      // theirs and RLS keeps them theirs.
      await as(viewer, async () => {
        const own = await api.createView({
          scope: "deal",
          name: "What I watch",
          config: { layout: "table", filters: [] },
          pinned: true,
        });
        expect(own.pinned).toBe(true);
        expect((await api.views()).map((v) => v.id)).toContain(own.id);
        await api.deleteView(own.id);
      });
    });
  });

  it("never tripped the version-skew fail-safe", () => {
    // api.ts reloads the page once when the box starts answering with a
    // different app version. One box, one process: a reload here would mean the
    // header handling itself is wrong.
    expect(reloads).toBe(0);
  });
});
