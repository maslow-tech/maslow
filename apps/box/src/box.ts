import { randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { Pool, type Client } from "pg";
import { SchemaExecutor } from "@brain/schema";
import {
  graphSendPreview,
  graphSendToken,
  isGmailSendPath,
  isGraphSendPath,
  pendingConfirmation,
  refusedError,
  uiPage,
} from "@brain/shared";
import {
  Admin,
  FsStore,
  Reader,
  Writer,
  type JwtVerifyOptions,
  type ToolDeps,
} from "@brain/mcp-tools";
import { getBrandingPublic, getFavicon } from "./branding.js";
import { mountMcp } from "./mcp-http.js";
import { mountFs } from "./fs-http.js";
import { mountDashboard, type DashboardOptions } from "./dashboard.js";
import { announceAccessChange, collabEvictions } from "./collab/rooms.js";
import { guardedFetch as realGuardedFetch, type GuardedFetch } from "./net/egress-guard.js";
import {
  CONNECTOR_CATALOG,
  ConnectorConfigStore,
  CustomConnectorStore,
  customFetch,
  GOOGLE_PROVIDER,
  TokenVault,
  gmailRead,
  gmailSearch,
  gmailSend,
  fail,
  markExternal,
  googleApi,
  googleCreds,
  googleDoctrine,
  googleRefresh,
  loadCreds,
  MICROSOFT_PROVIDER,
  microsoftApi,
  microsoftCreds,
  microsoftDoctrine,
  microsoftRefresh,
  type ApiRequest,
  type GmailResult,
  type RefreshFn,
} from "./connectors/index.js";
import { mcpAudience, mountOAuth, type OAuthOptions } from "./oauth.js";
import type { KillSwitchGate } from "./kill-switch.js";

/**
 * The box app: the single Node/Hono front door. Reads/writes
 * flow through the brain_app pool; schema ops through the brain_owner executor
 * on a dedicated (non-pooled) connection. caddy terminates TLS in front.
 *
 * It serves three surfaces on one origin: `/mcp` (member's Claude — Bearer only,
 * ignores cookies), `/api` (browsers — cookie session, read-only JSON; the UI
 * that consumes it is being redesigned from scratch), and `/healthz`.
 */
export interface DashboardConfig {
  /** HMAC secret that signs the read-only session cookie (env secret in prod). */
  readonly sessionSecret?: string;
  readonly secureCookies?: boolean;
  readonly sessionTtlSeconds?: number;
  readonly appVersion?: string;
  /** Connector-surface seam (tests): env for the vault key + fake exchange
   *  registry for the OAuth callback. */
  readonly connectors?: DashboardOptions["connectors"];
  /** Objects with a LIVE collab room — a direct body/title PATCH of one is
   *  refused (409 open_in_editor) so the room stays the single authoritative
   *  writer of those two fields. Unset in phase 1 (no rooms exist yet); the
   *  phase-2 collab server owns this set. */
  readonly liveRooms?: DashboardOptions["liveRooms"];
}

export interface BoxOptions {
  readonly pool: Pool; // brain_app
  readonly ownerClient: Client; // brain_owner (executor + serial boot-time owner queries)
  /**
   * Dedicated brain_owner pool for request-path box_kv (branding + favicon)
   * ONLY — never member content. Split off the executor's single connection so
   * a rolled-back DDL txn can never enclose/discard a branding write that
   * already returned 200. Optional: falls back to ownerClient in tests where no
   * DDL runs concurrently with branding. The CALLER owns its 'error' handler
   * (mirror retrieval-boot's sweepClient) — an unhandled idle-client error on a
   * postgres restart would crash the box.
   */
  readonly ownerKv?: Pool;
  readonly jwt?: JwtVerifyOptions;
  readonly dashboard?: DashboardConfig;
  /** the kill-switch gate; when present it gates every surface but /healthz. */
  readonly killSwitch?: KillSwitchGate;
  /**
   * Process READINESS, distinct from liveness. On SIGTERM the box drains
   * (apps/box/src/shutdown.ts): live collab rooms are marked read-only,
   * flushed, and closed before exit. `/healthz` must report not-ready as the
   * FIRST step of that drain — synchronously, before the websocket surface
   * stops accepting upgrades — because caddy's active health check
   * (`health_uri /healthz`, 10s) is what stops new sessions being routed at a
   * box that is about to close every socket it holds. Unset ⇒ always ready
   * (the pre-collab behavior).
   *
   * It is NOT the kill-switch: an intentionally-off box is healthy, and
   * /healthz deliberately bypasses the gate so the updater's canary does not
   * misread a suspended box as a broken deploy.
   */
  readonly readiness?: () => { readonly ready: boolean; readonly reason?: string };
  /**
   * The collab half of the updater's post-swap canary: open and close one
   * synthetic in-process room and report whether the machinery worked
   * (`collab.probeRoom()` — apps/box/src/collab/server.ts). Wired by the box
   * entrypoint; unset (tests, the dev harness) `/canary` simply omits
   * `collabOk`, which the updater reads as "not judged" exactly as it reads an
   * older box's canary response.
   *
   * It reports on the BUILD, not on the box's state: it must not consult the
   * kill-switch, because `/canary` bypasses the gate on purpose and a suspended
   * box condemning every release would be far worse than the bug it prevents.
   */
  readonly collabProbe?: () => Promise<boolean>;
  /**
   * When set, the box runs its own OAuth authorization server (MCP auth
   * spec) so claude.ai/Desktop can add it in one click. Its issued JWTs are
   * verified locally on /mcp, aud-bound to `${oauth.publicUrl}/mcp`.
   */
  readonly oauth?: OAuthOptions & { readonly publicUrl: string };
  /** wired when embeddings are enabled — search runs hybrid (lexical + vector). */
  readonly embedQuery?: (query: string) => Promise<number[] | null>;
  /** wired when the cross-encoder reranker is enabled — reorders the head of
   *  fused search results (best-effort; null/throw keeps the fused order). */
  readonly rerank?: (
    query: string,
    candidates: ReadonlyArray<{ id: string; text: string }>,
  ) => Promise<ReadonlyArray<{ id: string; score: number }> | null>;
  /** Disk write-shed signal: when it returns {shed:true}
   *  the shared Writer refuses content writes (reads keep working). One guard is
   *  shared with the embed sweep so shedding + telemetry measure the same FS. */
  readonly diskGuard?: () => Promise<{ shed: boolean }>;
  /** Handed the constructed tool deps — the entrypoint uses this to flush the
   *  queued call-audit writes (writer.flushAudit) on SIGTERM before exit. */
  readonly onDeps?: (deps: ToolDeps) => void;
  /** Egress seam (tests ONLY): overrides the SSRF-guarded fetch used by the
   *  custom-connector executor. Production leaves it unset and always wires the
   *  real `guardedFetch` — there is no way for an agent-reachable call to
   *  weaken the guard (G1.7). */
  readonly net?: {
    readonly guardedFetch?: GuardedFetch;
  };
}

export function createBox(opts: BoxOptions): Hono {
  // box_kv chrome (branding/favicon) handle. A dedicated pool in prod so a
  // rolled-back executor DDL txn can't swallow a branding write; falls back to
  // the executor client in tests (no concurrent DDL there).
  const ownerKv = opts.ownerKv ?? opts.ownerClient;
  const reader = new Reader(opts.pool, {
    ...(opts.embedQuery ? { embedQuery: opts.embedQuery } : {}),
    ...(opts.rerank ? { rerank: opts.rerank } : {}),
  });
  // `onAccountRevoked` is the MCP twin of the dashboard revoke route's
  // same-breath eviction: `revoke_user` is the offboarding path the collab
  // design names as "the case where being wrong is worst", and without this
  // hook the revoked member's already-open websockets keep streaming every
  // keystroke until the ≤60s reauth floor. Rooms stay up — only the revoked
  // account's connections close (collabEvictions.actor, not .object).
  const admin = new Admin(opts.pool, {
    onAccountRevoked: (id) => collabEvictions.actor(id, "access_revoked"),
  });
  const connectorEnv = opts.dashboard?.connectors?.env ?? process.env;
  const configStore = new ConnectorConfigStore(opts.pool, connectorEnv);
  const customStore = new CustomConnectorStore(opts.pool);

  // The SSRF egress guard — real in production, test-overridable via the `net`
  // seam. Custom connectors reach the network ONLY here.
  const gfetch: GuardedFetch = opts.net?.guardedFetch ?? realGuardedFetch;

  // One backend shape for the per-member OAuth connectors (google, microsoft):
  // creds read lazily from the owner-enabled config row (a re-configure applies
  // without a restart), per-member tokens from the encrypted vault with
  // transparent refresh, and a token() helper that resolves vault state into
  // either an access token or a teaching GmailResult (never a thrown 500).
  // The two providers differ only in their strings + which methods they expose:
  // google layers the gmail convenience helpers on top; microsoft is
  // call+doctrine (Graph is plain JSON — see ToolDeps).
  const makeConnectorBackend = <C>(cfg: {
    readonly provider: string;
    readonly parseCreds: (fields: Record<string, string>) => C | null;
    readonly makeRefresh: (creds: C) => RefreshFn;
    readonly api: (accessToken: string, req: ApiRequest) => Promise<GmailResult>;
    readonly doctrineFor: (status: {
      configured: boolean;
      connected: boolean;
      scopes: readonly string[];
      reauth?: boolean;
    }) => GmailResult;
    readonly notConfigured: string;
    readonly notConnected: string;
    readonly reauth: string;
  }) => {
    const creds = () => loadCreds(configStore, cfg.provider, cfg.parseCreds);
    const vault = new TokenVault(
      opts.pool,
      {
        [cfg.provider]: async (blob) => {
          const c = await creds();
          return c ? cfg.makeRefresh(c)(blob) : { ok: false };
        },
      },
      connectorEnv,
    );
    const token = async (accountId: string): Promise<GmailResult | { token: string }> => {
      if (!(await creds())) {
        return { successful: false, data: null, error: cfg.notConfigured };
      }
      const t = await vault.getFreshAccessToken(accountId, cfg.provider);
      if (!t.ok) {
        return {
          successful: false,
          data: null,
          error: t.reason === "not_connected" ? cfg.notConnected : cfg.reauth,
        };
      }
      return { token: t.accessToken };
    };
    const withToken = async (
      accountId: string,
      fn: (accessToken: string) => Promise<GmailResult>,
    ): Promise<GmailResult> => {
      const t = await token(accountId);
      return "token" in t ? fn(t.token) : t;
    };
    return {
      withToken,
      doctrine: async (accountId: string) => {
        const configured = (await creds()) !== null;
        const t = configured ? await vault.getFreshAccessToken(accountId, cfg.provider) : null;
        return cfg.doctrineFor({
          configured,
          connected: t?.ok === true,
          scopes: t?.ok === true ? t.scopes : [],
          // Distinguish "tokens exist but won't refresh" from "never connected"
          // — the teach strings differ (retry/reconnect vs connect-first).
          reauth: t !== null && !t.ok && t.reason === "reauth_required",
        });
      },
      call: async (
        accountId: string,
        req: { path: string; params?: Record<string, string>; method?: string; body?: unknown },
      ) => withToken(accountId, (accessToken) => cfg.api(accessToken, req)),
    };
  };

  // One Writer shared by the MCP tool registry and the dashboard write
  // endpoints, so browser edits go through the exact same write path (scope
  // gate, RLS, versioning, provenance) as agent edits.
  //
  // `onAccessChange` is the collab eviction hook: a committed write that
  // NARROWS an object's audience (org→private, someone dropped from
  // shared_with, trashed, merged away) closes that object's live editor rooms
  // immediately, instead of leaving them streaming until the ≤60s re-check
  // notices. Hooked at the Writer because that is the one seam the MCP tools,
  // the dashboard PATCH and `delete` all already pass through. It is a
  // notification only — never awaited, never able to fail a write.
  const writer = new Writer(opts.pool, {
    onAccessChange: announceAccessChange,
    ...(opts.diskGuard ? { diskGuard: opts.diskGuard } : {}),
  });

  // The filesystem rides its OWN small pool (deliberate connection discipline):
  // max 4 so a burst of bash file ops can never starve MCP reads — and vice
  // versa. Config is derived from the brain_app pool; allowExitOnIdle because
  // nothing owns an explicit end() for it (the box process lives until
  // SIGTERM), so its idle connections must never pin a process open.
  // (password is copied explicitly: pg makes it non-enumerable on `options`,
  // so a bare spread would silently drop it and every fs op would fail auth.)
  const fsPool = new Pool({
    ...opts.pool.options,
    password: opts.pool.options.password,
    max: 4,
    allowExitOnIdle: true,
  });
  // An idle fs connection killed under it (postgres restart, test teardown)
  // must not become an unhandled 'error' event that takes the box down.
  fsPool.on("error", (e) => console.warn(`fs pool: ${String(e)}`));
  const fsStore = new FsStore(fsPool);

  const deps: ToolDeps = {
    reader,
    writer,
    admin,
    executor: new SchemaExecutor(opts.ownerClient),
    fsStore,
    custom: {
      // Dynamic `<slug>_fetch` dispatch. The definition and the credential
      // are read per request (no restart to pick up owner edits); the secret
      // is decrypted in memory only and customFetch scrubs it from every
      // error. samgov's bespoke rails (GET-only allowlist + the attachment
      // pipeline) live inside customFetch, keyed by slug.
      fetch: async (toolName, args, accountId) => {
        const slug = toolName.slice(0, -"_fetch".length);
        const def = await customStore.get(slug);
        if (!def) {
          throw refusedError(
            `no "${slug}" connector exists on this box`,
            "an owner can create it on the dashboard's Connectors page",
          );
        }
        // Personal-first: this member's own credential wins, else the org one.
        const eff = await configStore.getEffective(slug, accountId);
        if (eff === null && def.authKind !== "none") {
          throw refusedError(
            `the ${def.name} connector is not enabled for you on this box`,
            "an owner enables it org-wide, or you add your own credential on the Connectors page",
          );
        }
        // samgov's pre-custom config row stored the key as `apiKey`; custom
        // enables store it as `value`. Accept both.
        const cfg = eff?.creds ?? {};
        const secret = def.authKind === "none" ? null : (cfg.value ?? cfg.apiKey ?? null);
        const result = await customFetch(def, secret, args, gfetch);
        // A path-less call returns the owner's OWN {connector, instructions}
        // (first-party) — don't mark that. A real fetch returns external content.
        return String(args.path ?? "").trim() === ""
          ? result
          : markExternal(def.slug, result as Record<string, unknown>);
      },
    },
    // start's connectors section: the same per-caller visibility set tools/list
    // uses (usableConnectors below — late-bound, only ever called at request
    // time), rendered as display lines here where the catalog/store metadata
    // lives. Row-only queries; start pays them once per session.
    connectors: async (accountId: string) => {
      const usable = await usableConnectors({ actorId: accountId });
      if (usable.size === 0) return [];
      const customs = await customStore.list();
      const lines: string[] = [];
      if (usable.has("google"))
        lines.push("google — YOUR Gmail, Google Calendar, and Drive (google tool)");
      if (usable.has("msgraph"))
        lines.push(
          "Microsoft 365 — YOUR Outlook mail + calendar, Teams, OneDrive/SharePoint (microsoft tool)",
        );
      for (const d of customs)
        if (usable.has(d.slug)) lines.push(`${d.name} (${d.slug}_fetch tool)`);
      return lines;
    },
    google: (() => {
      const b = makeConnectorBackend({
        provider: GOOGLE_PROVIDER,
        parseCreds: googleCreds,
        makeRefresh: googleRefresh,
        api: googleApi,
        doctrineFor: googleDoctrine,
        notConfigured:
          "The Google connector is not enabled on this box — an owner adds the " +
          "OAuth client on the dashboard's Connectors page.",
        notConnected:
          "You haven't connected a Google account — click Connect on the " +
          "dashboard's Connectors page.",
        reauth:
          "Your Google connection needs re-authorizing — click Connect on the " +
          "dashboard's Connectors page.",
      });
      return {
        doctrine: b.doctrine,
        // The raw proxy HARD-REFUSES a gmail send-shaped POST (that single
        // convenience path carries the confirm gate via action:"send"); other
        // results are marked as untrusted external content.
        call: async (accountId: string, req: { path: string; method?: string; body?: unknown }) => {
          if ((req.method ?? "GET").toUpperCase() === "POST" && isGmailSendPath(req.path)) {
            return fail(
              'the raw proxy cannot send mail — route it through action:"send" (it previews, then sends on confirm)',
            );
          }
          return markExternal("google", (await b.call(accountId, req)) as Record<string, unknown>);
        },
        searchMail: async (accountId: string, q: string, maxResults: number) =>
          markExternal(
            "google",
            (await b.withToken(accountId, (t) => gmailSearch(t, q, maxResults))) as Record<
              string,
              unknown
            >,
          ),
        readMail: async (accountId: string, messageId: string) =>
          markExternal(
            "google",
            (await b.withToken(accountId, (t) => gmailRead(t, messageId))) as Record<
              string,
              unknown
            >,
          ),
        send: (
          accountId: string,
          msg: { to: string; cc?: string; subject: string; text: string },
        ) =>
          b.withToken(accountId, (t) =>
            gmailSend(t, {
              to: msg.to,
              ...(msg.cc !== undefined ? { cc: msg.cc } : {}),
              subject: msg.subject,
              body: msg.text,
            }),
          ),
      };
    })(),
    microsoft: (() => {
      // Same backend as google, minus the mail helpers (Microsoft ROTATES
      // refresh tokens — the vault's putTokens persists the new blob on refresh).
      const b = makeConnectorBackend({
        provider: MICROSOFT_PROVIDER,
        parseCreds: microsoftCreds,
        makeRefresh: microsoftRefresh,
        api: microsoftApi,
        doctrineFor: microsoftDoctrine,
        notConfigured:
          "The Microsoft 365 connector is not enabled on this box — an owner adds " +
          "the Entra app registration on the dashboard's Connectors page.",
        notConnected:
          "You haven't connected a Microsoft account — click Connect on the " +
          "dashboard's Connectors page.",
        reauth:
          "Your Microsoft connection needs re-authorizing — click Connect on " +
          "the dashboard's Connectors page.",
      });
      return {
        doctrine: b.doctrine,
        call: async (
          accountId: string,
          req: { path: string; method?: string; body?: unknown },
          confirm?: string,
        ) => {
          // Graph has no convenience send — the confirm gate lives here, inline,
          // on send-shaped POSTs.
          if ((req.method ?? "GET").toUpperCase() === "POST" && isGraphSendPath(req.path)) {
            const token = graphSendToken(req.body);
            if (confirm !== token) {
              return pendingConfirmation("msgraph", graphSendPreview(req.body), token);
            }
            return b.call(accountId, req); // confirmed → send; receipt stays first-party
          }
          return markExternal(
            "microsoft",
            (await b.call(accountId, req)) as Record<string, unknown>,
          );
        },
      };
    })(),
  };
  opts.onDeps?.(deps);
  const app = new Hono();
  // The kill-switch gate runs first, so a killed/unreachable box serves nothing
  // but /healthz — /mcp, /api, and the dashboard all fail closed.
  if (opts.killSwitch) app.use("*", opts.killSwitch.middleware());
  app.get("/healthz", (c) => {
    // A readiness probe must never be cached — by caddy, by a load balancer, or
    // by anything between: a cached 200 during a drain is exactly the stale
    // answer this endpoint exists to prevent.
    c.header("cache-control", "no-store");
    const readiness = opts.readiness?.();
    if (readiness && !readiness.ready) {
      return c.json(
        { ok: false, service: "box", ready: false, reason: readiness.reason ?? "draining" },
        503,
      );
    }
    return c.json({ ok: true, service: "box" });
  });

  // The "how to connect this box" info page. It used to own `/`; now that the
  // dashboard SPA takes the root, it lives at /about — still reachable for
  // anyone who wants the MCP connection string.
  const infoPage = (c: Context) => {
    // hostname chars only — never reflect arbitrary header bytes into the page
    const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "your-brain-domain")
      .replace(/[^a-zA-Z0-9.:-]/g, "")
      .slice(0, 253);
    return c.html(
      uiPage(
        "Maslow brain",
        `<div class="card">
        <div class="card-head">
          <h1>Maslow brain</h1>
          <p class="muted">This is a private company brain. The dashboard is at
          the <a href="/">root</a>; this is an <b>MCP endpoint</b> too.</p>
        </div>
        <p>Connect it in Claude → <b>Settings → Connectors → Add custom connector</b>:</p>
        <pre>https://${host}/mcp</pre>
        <p class="muted" style="margin-top:12px">Authorize with your access token when prompted.
        The brain is running and healthy.</p>
      </div>`,
        { width: "narrow" },
      ),
    );
  };
  app.get("/about", infoPage);

  // Real host details straight off the box — the source of truth for "where is
  // this box actually running". `domain` is the configured public domain
  // (BRAIN_DOMAIN, the same value that rides the heartbeat up to the booth);
  // `hostname` is the OS hostname. Ungated like /healthz so an operator can hit
  // it without a token; carries no secrets.
  app.get("/boxinfo", (c) =>
    c.json({
      service: "box",
      version: opts.dashboard?.appVersion ?? process.env.BRAIN_APP_VERSION ?? "dev",
      domain: process.env.BRAIN_DOMAIN ?? null,
      hostname: osHostname(),
      now: new Date().toISOString(),
    }),
  );

  // Write-path + collab canary for the updater. Two probes, one endpoint:
  //   writeOk  — a real DB round-trip through the least-privilege brain_app
  //              pool: upsert the single canary row + read it back. 200 ⇒ the
  //              write path works (primary writable, WAL, disk, brain_app
  //              grants); 503 ⇒ genuinely broken.
  //   collabOk — an in-process collab room open/close (opts.collabProbe). The
  //              websocket surface is where a release breaks WITHOUT breaking
  //              HTTP, and a write-only canary passes such a build and never
  //              rolls it back. It writes no brain content and creates no
  //              object — this runs on production boxes.
  // Either failing ⇒ 503, so an updater that predates `collabOk` still reads a
  // broken build as a rollback vote; `collabOk` is omitted entirely when no
  // probe is wired ("not judged"), never reported as false.
  // Like /healthz the endpoint bypasses the kill-switch gate (see
  // kill-switch.ts) so an intentionally-off box is not misread as a broken
  // deploy — hence the probe must report on the machinery, not on the gate —
  // and it is blocked at caddy so this unauthenticated DB write is reachable
  // only on the internal compose network (http://app:8080/canary).
  app.get("/canary", async (c) => {
    // The collab probe runs first and never throws: a broken write path must
    // still report the collab verdict, and vice versa.
    let collabOk: boolean | undefined;
    let collabError: string | undefined;
    if (opts.collabProbe) {
      try {
        collabOk = await opts.collabProbe();
      } catch (err) {
        collabOk = false;
        collabError = String(err);
      }
    }
    const collab = {
      ...(collabOk === undefined ? {} : { collabOk }),
      ...(collabError === undefined ? {} : { collabError }),
    };
    try {
      const r = await opts.pool.query<{ beat_at: string }>(
        "INSERT INTO canary (id, beat_at) VALUES (1, now()) " +
          "ON CONFLICT (id) DO UPDATE SET beat_at = excluded.beat_at RETURNING beat_at",
      );
      return c.json(
        {
          ok: collabOk !== false,
          service: "box",
          writeOk: true,
          ...collab,
          beatAt: r.rows[0]?.beat_at ?? null,
        },
        collabOk === false ? 503 : 200,
      );
    } catch (err) {
      return c.json(
        { ok: false, service: "box", writeOk: false, ...collab, error: String(err) },
        503,
      );
    }
  });

  // /mcp verifies OAuth JWTs when the box runs its own authorization server:
  // the verify key is the OAuth signer's public key, aud-bound to `<url>/mcp`.
  const jwt = opts.oauth
    ? { publicKey: opts.oauth.signer.publicKey, canonicalAud: mcpAudience(opts.oauth.publicUrl) }
    : opts.jwt;
  // Connector-tool visibility (CLAUDE.md doctrine), catalog-driven so a new
  // provider gets the right gating from its catalog entry alone: an org-keyed
  // provider is usable once an owner stored its config; an `oauth` provider
  // additionally needs THIS caller's own vault tokens. Row-existence checks
  // only — no decrypt, no network.
  const visibilityVault = new TokenVault(
    opts.pool,
    {},
    opts.dashboard?.connectors?.env ?? process.env,
  );
  const usableConnectors = async (caller: {
    readonly actorId: string;
  }): Promise<ReadonlySet<string>> => {
    // Two row-only queries total (not one per oauth entry): the enabled
    // providers, and THIS caller's connected providers — then membership is
    // tested in memory. Semantics are identical to a per-entry hasTokens loop.
    // The lookups are independent, and tools/list pays them on every
    // request — run them concurrently.
    const [configured, connected, customDefs] = await Promise.all([
      // org credentials + THIS caller's personal ones (scoping, 0034) — a
      // personal credential makes its tool visible to that member only.
      configStore.configuredForCaller(caller.actorId),
      visibilityVault.connectedProviders(caller.actorId),
      customStore.list(),
    ]);
    const usable = new Set<string>();
    for (const entry of CONNECTOR_CATALOG) {
      if (!configured.has(entry.provider)) continue;
      if (entry.oauth && !connected.has(entry.provider)) continue;
      usable.add(entry.provider);
    }
    // Custom connectors are the org-keyed class: a definition whose config
    // row exists (the credential — or the explicit `{}` enable for no-auth
    // connectors) is usable by EVERY member. Row checks only, per doctrine.
    for (const def of customDefs) {
      if (configured.has(def.slug)) usable.add(def.slug);
    }
    return usable;
  };

  mountMcp(app, {
    deps,
    pool: opts.pool,
    connectors: usableConnectors,
    // tools/list descriptors for the caller's usable custom connectors (the
    // usable set is computed once per request and passed in). Descriptions
    // come from the DB definition; samgov keeps its honest read-only hint,
    // everything else is an open-world write-capable fetch.
    customTools: async (usable) => {
      const customs = await customStore.list();
      return customs
        .filter((d) => usable.has(d.slug))
        .map((d) => ({
          name: `${d.slug}_fetch`,
          description:
            d.description ||
            `Call the ${d.name} API (${d.baseUrl}). Call with no arguments to get usage instructions.`,
          annotations:
            d.slug === "samgov"
              ? { readOnlyHint: true, openWorldHint: true }
              : { readOnlyHint: false, openWorldHint: true },
        }));
    },
    ...(jwt ? { jwt } : {}),
    ...(opts.oauth ? { publicUrl: opts.oauth.publicUrl } : {}),
  });

  // The filesystem HTTP surface (same-origin, same bearer auth as /mcp + /api).
  mountFs(app, { pool: opts.pool, fsStore, ...(jwt ? { jwt } : {}) });

  // The OAuth discovery/authorize/token endpoints (registered on the main app
  // BEFORE the dashboard sub-app so its `*` security middleware never touches
  // the sign-in page's own CSP/CORS).
  if (opts.oauth) mountOAuth(app, opts.oauth);

  // The dashboard signs sessions with an env secret; absent one (dev/tests it's
  // passed explicitly), fall back to a per-process random secret so cookies work
  // within a run — a restart invalidates sessions, which is acceptable in v1.
  const sessionSecret =
    opts.dashboard?.sessionSecret ??
    process.env.BRAIN_SESSION_SECRET ??
    randomBytes(32).toString("hex");
  mountDashboard(app, {
    reader,
    admin,
    writer,
    pool: opts.pool,
    fsStore,
    ownerKv,
    sessionSecret,
    ...(opts.dashboard?.secureCookies !== undefined
      ? { secureCookies: opts.dashboard.secureCookies }
      : {}),
    ...(opts.dashboard?.sessionTtlSeconds !== undefined
      ? { sessionTtlSeconds: opts.dashboard.sessionTtlSeconds }
      : {}),
    ...(opts.dashboard?.appVersion !== undefined ? { appVersion: opts.dashboard.appVersion } : {}),
    ...(opts.dashboard?.connectors !== undefined ? { connectors: opts.dashboard.connectors } : {}),
    ...(opts.dashboard?.liveRooms !== undefined ? { liveRooms: opts.dashboard.liveRooms } : {}),
    ...(jwt ? { jwt } : {}),
  });

  // ---- dashboard SPA ------------------------------------------------------
  // The box serves the built read-only dashboard (apps/box/ui) at the root, same
  // origin as /api. BRAIN_UI_DIR overrides the location; default ./ui is where
  // the image copies the vite build (relative to the app cwd, /app). If the
  // build is absent (some tests / bare dev) the root falls back to the info page
  // so the box still answers / with something useful.
  // The customer's favicon, served for the whole origin (dashboard, /mcp,
  // /oauth — any browser tab on the box's domain). Owner-set (box_kv); absent →
  // 404 so the browser falls back to its default. Registered before the SPA
  // catch-all so it never returns index.html.
  app.get("/favicon.ico", async (c) => {
    const fav = await getFavicon(ownerKv).catch(() => null);
    if (!fav) return c.body(null, 404);
    c.header("Content-Type", fav.mime);
    c.header("Cache-Control", "no-cache");
    const ab = fav.bytes.buffer.slice(
      fav.bytes.byteOffset,
      fav.bytes.byteOffset + fav.bytes.byteLength,
    ) as ArrayBuffer;
    return c.body(ab);
  });

  const uiDir = process.env.BRAIN_UI_DIR ?? "./webui";
  const uiIndex = resolve(uiDir, "index.html");
  if (existsSync(uiIndex)) {
    const indexHtml = readFileSync(uiIndex, "utf8");
    // The SPA's own CSP (the /api JSON surface keeps its stricter default-src
    // 'none' from dashboard.ts). Vite emits hashed same-origin JS + inline
    // style; fonts/img are self/data; no framing, no external origins.
    //
    // connect-src carries the collab WebSocket (`wss://<this box>/dash/collab`,
    // built from location.origin in apps/box/ui/src/lib/collab.ts). CSP3 says
    // `'self'` already covers same-origin ws/wss, but SAFARI has historically
    // NOT implemented that, and iOS Safari is a required target — there the
    // socket is blocked outright. Node `ws` clients ignore CSP entirely, so no
    // collab test can see this; only a real phone can. So we name the box's OWN
    // origin explicitly. NOT a bare `wss:` wildcard: that would let an XSS on
    // the dashboard stream the whole brain to any WebSocket server on the
    // internet. Host scoping keeps the exfiltration target set at exactly one.
    const configuredDomain = (process.env.BRAIN_DOMAIN ?? "").trim();
    // A host is only ever interpolated into a header after this check: the Host
    // header is attacker-controlled, and anything outside this alphabet (CR/LF
    // above all) could forge directives or split the response.
    const safeHost = (h: string): boolean =>
      h.length > 0 && h.length <= 255 && /^[A-Za-z0-9._-]+(:\d{1,5})?$/.test(h);
    const spaCsp = (c: Context): string => {
      const reqHost = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "")
        .split(",")[0]!
        .trim();
      // Behind Caddy the browser's scheme is the forwarded one, not the
      // hop-to-Node one. wss is always allowed (it is the production case, and
      // guessing wrong there is a broken phone); plaintext ws is added only
      // when this request is demonstrably NOT https — that is local `vite dev` /
      // bare-node development. A secure page cannot open a ws:// socket anyway
      // (mixed content), so the extra entry never widens a real deployment.
      const proto = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]!.trim().toLowerCase();
      const secure = proto ? proto === "https" : new URL(c.req.url).protocol === "https:";
      const hosts = new Set<string>();
      if (safeHost(reqHost)) hosts.add(reqHost);
      // BRAIN_DOMAIN too: the box's canonical public name, so a proxy that
      // rewrites Host still yields a CSP the real browser origin satisfies.
      if (safeHost(configuredDomain)) hosts.add(configuredDomain);
      const sockets = [...hosts].flatMap((h) =>
        secure ? [`wss://${h}`] : [`wss://${h}`, `ws://${h}`],
      );
      const connect = ["'self'", ...sockets].join(" ");
      return (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        `img-src 'self' data:; font-src 'self'; connect-src ${connect}; base-uri 'none'; ` +
        "frame-ancestors 'none'"
      );
    };
    const serveIndex = (c: Context) => {
      c.header("Content-Security-Policy", spaCsp(c));
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "same-origin");
      return c.html(indexHtml);
    };
    // Hashed, immutable assets straight off disk.
    app.use("/assets/*", serveStatic({ root: uiDir }));
    // PWA install icons (vite copies public/ to the build root, so they sit
    // beside index.html, NOT under /assets — without their own route they would
    // fall through the catch-all and come back as index.html).
    app.use("/icons/*", serveStatic({ root: uiDir }));
    // The web app manifest, with the org's own name folded in so an installed
    // home-screen app is labelled like the brain it points at. The file on disk
    // is the fallback: any read/parse trouble serves it verbatim rather than
    // failing the install, and the name is the only field we rewrite.
    const manifestPath = resolve(uiDir, "manifest.webmanifest");
    if (existsSync(manifestPath)) {
      const manifestRaw = readFileSync(manifestPath, "utf8");
      app.get("/manifest.webmanifest", async (c) => {
        let body = manifestRaw;
        try {
          const name = opts.ownerClient ? (await getBrandingPublic(opts.ownerClient)).name : null;
          if (name) {
            const parsed: Record<string, unknown> = JSON.parse(manifestRaw);
            parsed["name"] = name;
            parsed["short_name"] = name;
            body = JSON.stringify(parsed);
          }
        } catch {
          // Keep the on-disk manifest — a branding hiccup must not break install.
        }
        c.header("Content-Type", "application/manifest+json");
        c.header("Cache-Control", "no-cache");
        return c.body(body);
      });
    }
    // The service worker (apps/box/ui/src/sw.js, emitted to the build root by
    // the vite plugin). It MUST be served from the scope root — a worker's
    // default scope is its own directory, so it cannot live under /assets — and
    // it must never be cached by the browser for long, or a self-updating box
    // could not replace its own worker. Registered before the SPA catch-all,
    // which would otherwise hand back index.html with an HTML content type and
    // make every registration fail.
    const swPath = resolve(uiDir, "sw.js");
    if (existsSync(swPath)) {
      const swSource = readFileSync(swPath, "utf8");
      app.get("/sw.js", (c) => {
        c.header("Content-Type", "text/javascript; charset=utf-8");
        c.header("Cache-Control", "no-cache");
        c.header("X-Content-Type-Options", "nosniff");
        return c.body(swSource);
      });
    }
    app.get("/", serveIndex);
    // The reserved server surfaces — single source of truth for the SPA
    // catch-all guard. A path under one of these belongs to a real handler
    // (registered above); if it reaches the catch-all it is an UNMATCHED
    // sub-path of a mounted surface (e.g. a bogus /.well-known/* probe), so it
    // must 404, NOT fall through to index.html. Prefix match requires an exact
    // hit or a following "/" so "/connect" never swallows the "/connectors" SPA
    // route. `/.well-known` and `/connect` were missing before, letting unknown
    // probes there return 200 + SPA HTML.
    const RESERVED_PREFIXES = [
      "/api",
      "/mcp",
      "/oauth",
      "/assets",
      "/icons",
      "/.well-known",
      "/connect",
    ];
    const RESERVED_EXACT = new Set([
      "/healthz",
      "/boxinfo",
      "/canary",
      "/about",
      "/favicon.ico",
      "/manifest.webmanifest",
      // A build without a worker must 404 here, NOT return the SPA shell: a
      // browser handed HTML at /sw.js fails registration loudly, whereas a
      // "successful" registration of an HTML document is a silent trap.
      "/sw.js",
    ]);
    const isReservedPath = (p: string): boolean =>
      RESERVED_EXACT.has(p) ||
      RESERVED_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));
    // Client-side routes (react-router): any other unclaimed GET returns the
    // shell so deep links / refreshes work. The reserved surfaces are registered
    // above and win; only genuinely-unclaimed paths reach here.
    app.get("*", (c, next) => {
      const p = c.req.path;
      // An unmatched reserved path (a real surface's unknown sub-path) is a 404,
      // not the SPA shell — next() with no further route yields Hono's 404.
      if (isReservedPath(p)) return next();
      // A JSON client that fell through here hit no real API route; hand it a
      // 404 rather than 200 + HTML, so a probe/misroute reads as not-found.
      const accept = c.req.header("accept") ?? "";
      if (accept.includes("application/json")) return c.body(null, 404);
      return serveIndex(c);
    });
  } else {
    // No built UI present → keep the old behavior: info page at the root.
    app.get("/", infoPage);
  }

  return app;
}
