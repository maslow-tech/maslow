import { Buffer } from "node:buffer";
import { logEvt } from "./log.js";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { Client, Pool } from "pg";
import { generateDevKeypair, makeDevSigner, Writer } from "@brain/mcp-tools";
import { stripTrailingSlashes } from "@brain/shared";
import {
  isArchiverWedged,
  lastFullBackupAt,
  lastRestoreDrill,
  pendingWalSegments,
} from "./backup-health.js";
import { createBox, type BoxOptions } from "./box.js";
import { type UpgradeCapableServer } from "./collab/server.js";
import { wireCollab } from "./collab/wire.js";
import { makeDiskGuard } from "./disk-guard.js";
import { initRetrievalStack } from "./retrieval-boot.js";
import { KillSwitchGate } from "./kill-switch.js";
import { initialKillState, type KillClientState } from "./kill-switch-client.js";
import { boothValidate } from "./booth-telephone.js";
import { hasActivity, snapshotActivity } from "./activity.js";
import { snapshotBoxErrors } from "./errors.js";
import { readVitals } from "./vitals.js";
import {
  AUDIT_FLUSH_BUDGET_MS,
  COLLAB_DRAIN_BUDGET_MS,
  COLLAB_FLUSH_BUDGET_MS,
  createShutdown,
  SHUTDOWN_BUDGET_MS,
} from "./shutdown.js";

export { createBox, type BoxOptions } from "./box.js";
export { mountMcp } from "./mcp-http.js";
// SSRF egress guard — exported for the security test matrix (PR2a) and for
// any caller wiring a custom guard.
export {
  guardedFetch,
  makeGuardedFetch,
  isBlockedIp,
  EgressBlocked,
  RequestFailed,
  type GuardedFetch,
  type GuardedResponse,
} from "./net/egress-guard.js";
export {
  beginOAuth,
  completeOAuth,
  TokenVault,
  type EffectiveFingerprint,
  type TokenFingerprint,
} from "./connectors/index.js";
export { hasActivity, snapshotActivity, recordCall, type ToolTiming } from "./activity.js";
export { recordBoxError, snapshotBoxErrors } from "./errors.js";
export { KillSwitchGate, type KillSwitchOptions } from "./kill-switch.js";
export { boothValidate } from "./booth-telephone.js";
export * from "./kill-switch-client.js";
export { chunkObject, startEmbedSweep, type Embedder } from "./embedder.js";
export { markExternal, STANDING_INSTRUCTION } from "./connectors/untrusted.js";
export { chunkBody, CHUNKER_VERSION } from "./chunker.js";
export { LocalEmbedder } from "./local-embedder.js";
export { LocalReranker } from "./local-reranker.js";
export { initRetrievalStack, type RetrievalStack } from "./retrieval-boot.js";
export {
  assertBudgetLadder,
  createShutdown,
  AUDIT_FLUSH_BUDGET_MS,
  COLLAB_DRAIN_BUDGET_MS,
  COLLAB_FLUSH_BUDGET_MS,
  COMPOSE_STOP_GRACE_SECONDS,
  SHUTDOWN_BUDGET_MS,
  type ShutdownHandler,
  type ShutdownOptions,
  type ShutdownStage,
} from "./shutdown.js";
export {
  createCollabServer,
  type AuthorizeCollabRoom,
  type CollabRoomGrant,
  type CollabServer,
  type CollabServerOptions,
  type UpgradeCapableServer,
} from "./collab/server.js";
// The ONE assembly of the collab stack. Exported so the integration suites
// exercise the wiring the box actually ships, rather than a second copy of it
// that can (and did) stay green while production refused every join.
export { wireCollab, type WireCollabOptions, type WiredCollab } from "./collab/wire.js";
export {
  COLLAB_CLOSE,
  COLLAB_PATH,
  COLLAB_TICKET_DEFAULT_TTL_SECONDS,
  COLLAB_TICKET_MAX_TTL_SECONDS,
  collabAllowedHosts,
  deriveCollabTicketKey,
  evictCloseCode,
  handshakeDecision,
  isLoopbackHost,
  mintCollabTicket,
  normalizeOrigin,
  originAllowed,
  signCollabTicket,
  verifyCollabTicket,
  type CollabCloseCode,
  type CollabEvictReason,
  type CollabPrincipal,
  type CollabReadiness,
  type CollabRefusal,
  type CollabRooms,
  type CollabTicketPayload,
  type HandshakeDecision,
  type HandshakeInput,
} from "./collab/types.js";

/**
 * Load persisted kill-switch state from a mounted volume. A MISSING file is a
 * genuine first boot (→ undefined; the gate starts from initialKillState). A
 * present-but-corrupt/unreadable file is NOT fatal: we start fresh with a loud
 * warning — boot is fail-closed anyway (bootDecision), and the booth re-syncs
 * the real kill state within one refresh (~5s), so a fresh start can't leave a
 * killed box serving. Parsed state is merged over the defaults so a file written
 * by an older state shape still loads.
 */
export function loadKillState(file: string): KillClientState | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    console.warn(`kill-switch: state ${file} unreadable (${String(err)}); starting fresh`);
    return undefined;
  }
  try {
    return { ...initialKillState(), ...(JSON.parse(raw) as Partial<KillClientState>) };
  } catch (err) {
    console.warn(`kill-switch: state ${file} corrupt (${String(err)}); starting fresh`);
    return undefined;
  }
}

/** Atomically persist kill-switch state (tmp + rename, 0600). Best-effort: a
 *  write failure warns but never crashes the box — worst case the pin/sticky-off
 *  doesn't survive the next restart (the pre-existing behavior). */
export function saveKillState(file: string, state: KillClientState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    console.warn(`kill-switch: could not persist state to ${file} (${String(err)})`);
  }
}

/**
 * Production entry: wire the brain_app pool + the brain_owner executor
 * connection from the environment (Docker secrets are surfaced as *_URL by the
 * installer) and serve behind caddy. In v1 the box also serves the read-only
 * /api (M5) that a redesigned UI will consume; those mount here as they land.
 */
/**
 * The dashboard session-signing secret, made durable. An explicit env var wins;
 * otherwise it's read from (or minted once into) box_kv so it survives restarts
 * and self-updates instead of logging everyone out on every release. Falls back
 * to a per-process secret if box_kv isn't there yet (pre-0023 mid-migrate).
 */
async function getOrCreateSessionSecret(owner: Client): Promise<string> {
  const fromEnv = process.env.BRAIN_SESSION_SECRET;
  if (fromEnv) return fromEnv;
  try {
    const sel = await owner.query<{ value: string }>(
      "SELECT value FROM box_kv WHERE key = 'session_secret'",
    );
    if (sel.rows[0]?.value) return sel.rows[0].value;
    const secret = randomBytes(32).toString("hex");
    await owner.query(
      "INSERT INTO box_kv (key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING",
      [secret],
    );
    const again = await owner.query<{ value: string }>(
      "SELECT value FROM box_kv WHERE key = 'session_secret'",
    );
    return again.rows[0]?.value ?? secret;
  } catch (err) {
    console.warn("session secret: box_kv unavailable, using an ephemeral secret —", String(err));
    return randomBytes(32).toString("hex");
  }
}

async function main(): Promise<void> {
  const appUrl = process.env.BRAIN_APP_DATABASE_URL;
  const ownerUrl = process.env.BRAIN_OWNER_DATABASE_URL;
  if (!appUrl || !ownerUrl) {
    throw new Error("BRAIN_APP_DATABASE_URL and BRAIN_OWNER_DATABASE_URL are required");
  }
  // THE REQUEST-PATH POOL. Its 'error' handler is not optional: node-pg emits
  // 'error' on this Pool when an IDLE client dies, and an EventEmitter with no
  // 'error' listener THROWS — an uncaught exception that takes the whole box
  // process down. Every ordinary cause of an idle client dying applies here:
  // postgres restarting during a whole-box update, a failover, a network blip,
  // an operator's pg_terminate_backend. The pool itself self-heals; only the
  // missing listener turns that into an outage.
  //
  // This was already known — the ownerKv pool below carries the same handler and
  // a comment calling it mandatory — and the main pool was left bare anyway,
  // which is how a lesson gets learned on the small case and missed on the big
  // one. Surfaced by the scenario suite, where dropping the test database
  // terminates the backends and vitest reported the unhandled error.
  const pool = new Pool({ connectionString: appUrl, max: 10 });
  pool.on("error", (e) => console.warn(`app pool: idle client error (${String(e)})`));
  const ownerClient = new Client({ connectionString: ownerUrl });
  await ownerClient.connect();
  // Dedicated brain_owner pool for request-path box_kv (branding/favicon), split
  // off the executor client so a rolled-back DDL txn can't discard a branding
  // write. A Pool self-heals across a postgres restart (whole-box updates drop
  // idle conns); the 'error' handler is mandatory — an unhandled idle-client
  // error would crash the box on that restart.
  const ownerKv = new Pool({ connectionString: ownerUrl, max: 3 });
  ownerKv.on("error", (e) => console.warn(`owner-kv pool: idle client error (${String(e)})`));

  // Wire the kill-switch to the live booth when configured: the box
  // phones /v1/validate for a signed lease and gates every surface but /healthz.
  // Absent a booth (dev), the box runs ungated.
  const boothUrl = process.env.BRAIN_BOOTH_URL;
  const brainToken = process.env.BRAIN_TOKEN;
  const boothPubB64 = process.env.BRAIN_BOOTH_PUBLIC_KEY_B64;
  let killSwitch: KillSwitchGate | undefined;
  if (boothUrl && brainToken && boothPubB64) {
    const publicKeyPem = Buffer.from(boothPubB64, "base64").toString("utf8");
    // Persist kill-switch state (sticky-off latch + the TOFU box_id pin) on a
    // mounted volume so it SURVIVES container recreation on update/restart —
    // without this the pin resets to null every restart and re-pins on first
    // contact, leaving a narrow post-restart replay window. Mirrors the
    // oauth_state / updater_state volumes.
    const stateFile = process.env.BRAIN_KILLSWITCH_STATE ?? "/var/lib/brain-killswitch/state.json";
    const initialState = loadKillState(stateFile);
    killSwitch = new KillSwitchGate({
      config: { publicKeyPem },
      validate: () => boothValidate(boothUrl, brainToken),
      ...(initialState ? { initialState } : {}),
      persist: (state) => saveKillState(stateFile, state),
    });
    console.log(`kill-switch: gating via booth ${boothUrl} (state ${stateFile})`);
  }

  // Heartbeat reporter: every interval, flush host VITALS (cpu / mem
  // / disk) so the console can see a box's health and flag one heading for
  // trouble — plus the anonymized activity rollup WHEN there is any. Fires even
  // when idle (vitals must stay fresh), so the early-return on no-activity is
  // gone. Tool NAMES + counts + host metrics only — never arguments or brain
  // content. Best-effort.
  if (boothUrl && brainToken) {
    const reportMs = Number(process.env.BRAIN_ACTIVITY_REPORT_MS ?? 60_000);
    const flush = async (): Promise<void> => {
      const vitals = await readVitals();
      // NB: the box reports host VITALS only (cpu/mem/disk) — NOT `healthy`.
      // The updater owns the `healthy` field off its real /canary probe; a
      // hardcoded `true` here would overwrite that signal (booth takes the
      // latest) and defeat the unhealthy alert.
      const body: Record<string, unknown> = {
        cpuPct: vitals.cpuPct,
        memPctUsed: vitals.memPctUsed,
        diskPctUsed: vitals.diskPctUsed,
      };
      // WAL archiver wedged? A failing archiver silently
      // fills pg_wal on the DATA volume faster than any content write — the shed
      // alone can't catch it, so surface it as its own paging signal.
      //
      // This used to be `failed_count > 0 AND …` alone, which made the alert
      // STRUCTURALLY SILENT under the archive-async config we ship: MEASURED
      // 2026-07-29 (locally and on prod) pg_stat_archiver read
      // archived=0 failed=0 last_archived_time=NULL while a .ready segment was
      // queued and the spool already held global.error. The whole alerting path
      // — heartbeat → box_health → monitor.ts "archiver-stuck" — was wired to a
      // signal that does not move in the failure it exists to catch. So the
      // queue depth (from the read-only pgdata mount) is now an INDEPENDENT
      // second input; see backup-health.ts and the backups doctrine.
      // Best-effort throughout: omit the field rather than guess, and the booth
      // holds the prior value.
      try {
        const a = await pool.query<{
          failed_count: number | null;
          failing_now: boolean | null;
          last_archived_age_sec: number | null;
        }>(
          `SELECT failed_count,
                  (last_archived_time IS NULL OR last_failed_time > last_archived_time)
                    AS failing_now,
                  extract(epoch FROM now() - last_archived_time)::int
                    AS last_archived_age_sec
             FROM pg_stat_archiver`,
        );
        const row = a.rows[0];
        if (row) {
          const wedged = isArchiverWedged({
            failedCount: row.failed_count,
            failingNow: row.failing_now === true,
            pending: await pendingWalSegments(),
            lastArchivedAgeSec: row.last_archived_age_sec,
          });
          if (wedged !== null) body.archiverWedged = wedged;
        }
      } catch {
        /* archiver stats unavailable — omit, best-effort */
      }
      // When the scheduler last completed a FULL backup. A healthy archiver says
      // nothing about whether a base backup exists, and a repo holding only WAL
      // is not a backup — so this is the field that makes "are backups actually
      // running?" answerable from the console instead of by SSH-ing to a box.
      // Absent ⇒ unknown (never taken, repo not mounted, unreadable stamp), which
      // the console must show as unproven rather than fine.
      const lastFull = await lastFullBackupAt();
      if (lastFull) body.lastBackupAt = lastFull.toISOString();
      // …and whether that backup has ever been proven RESTORABLE. Taking a
      // backup and being able to restore one are different facts, and only the
      // second one is the promise a backup exists to keep. Absent ⇒
      // unknown; `skipped` is reported as-is so it can never read as a pass.
      const drill = await lastRestoreDrill();
      if (drill) {
        body.lastRestoreDrillAt = drill.at.toISOString();
        body.lastRestoreDrillStatus = drill.status;
      }
      if (hasActivity()) body.activity = snapshotActivity();
      // The closed-enum error rollup (errors.ts) — the booth ingest + console
      // view predate this line; attaching it is what turns them on.
      const errs = snapshotBoxErrors();
      if (errs.length) body.errors = errs;
      try {
        const res = await fetch(`${stripTrailingSlashes(boothUrl)}/v1/heartbeat`, {
          method: "POST",
          headers: { authorization: `Bearer ${brainToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        // A REJECTED heartbeat is a contract bug (e.g. the booth 400s the
        // whole report over one malformed errors[] entry) — the box would
        // otherwise go silently dark on the control-plane console.
        if (!res.ok) logEvt("heartbeat_rejected", { status: res.status }, "warn");
      } catch {
        /* best-effort telemetry — a dropped window is fine, the next continues */
      }
    };
    setInterval(() => void flush(), reportMs).unref();
  }

  // When BRAIN_PUBLIC_URL is set (e.g. https://brain.example.com), the box runs
  // its own OAuth authorization server so claude.ai/Desktop can add it in one
  // click. The token-signing key is loaded from BRAIN_OAUTH_SIGNING_KEY_B64
  // (base64 PEM of an EC P-256 private key) so issued JWTs SURVIVE restarts and
  // validate across replicas; absent it a per-process key is generated and a
  // loud warning is logged (dev only — restarts invalidate outstanding tokens).
  let oauth: BoxOptions["oauth"];
  const publicUrl = process.env.BRAIN_PUBLIC_URL;
  if (publicUrl) {
    const keyB64 = process.env.BRAIN_OAUTH_SIGNING_KEY_B64;
    let keypair: Awaited<ReturnType<typeof generateDevKeypair>>;
    if (keyB64) {
      const pem = Buffer.from(keyB64, "base64").toString("utf8");
      const privateKey = createPrivateKey(pem);
      keypair = { privateKey, publicKey: createPublicKey(privateKey) };
    } else {
      console.warn(
        "oauth: BRAIN_OAUTH_SIGNING_KEY_B64 unset — using an EPHEMERAL signing key; " +
          "issued tokens die on restart and won't validate across replicas (dev only)",
      );
      keypair = await generateDevKeypair();
    }
    const signer = await makeDevSigner(keypair);
    const stateFile = process.env.BRAIN_OAUTH_STATE ?? "/var/lib/brain-oauth/clients.json";
    oauth = { pool, signer, publicUrl, stateFile };
    console.log(`oauth: authorization server enabled for ${publicUrl}`);
  }

  // Semantic search + reranker (retrieval stack v2) are UNCONDITIONAL — the
  // box's own baked-in models, in-process on its own CPUs, no flag (the soak
  // gates are done; Gate 3 deleted BRAIN_EMBEDDINGS/BRAIN_RERANKER and the
  // Bedrock path). initRetrievalStack owns the never-brick rules (probe,
  // self-heal, degrade-to-lexical) — shared with the dev harness so the
  // guarantees can't drift.
  // ONE disk write-shed guard, shared by the Writer (refuse
  // content writes past BRAIN_WRITE_SHED_PCT) and the embed sweep (pause under
  // pressure) — both measure the SAME data filesystem, so shed + telemetry agree.
  const diskGuard = makeDiskGuard(process.env);
  const shouldShed = (): Promise<boolean> =>
    diskGuard()
      .then((g) => g.shed)
      .catch(() => false);

  const { embedQuery, rerank } = await initRetrievalStack({
    ownerClient,
    ownerUrl,
    shouldShed,
  });

  // call:* audit is kept FOREVER (owner decision) — events stays append-only,
  // no retention prune. Content and audit rows alike are the box's permanent
  // history.

  const sessionSecret = await getOrCreateSessionSecret(ownerClient);

  // The collab (Yjs) websocket surface. It hangs off the Node server's
  // `upgrade` event, NOT off Hono, so it re-establishes every gate by hand —
  // kill-switch, Origin allowlist, ticket-only principal (see collab/server.ts).
  // Constructed BEFORE createBox so its live-room set can be handed to the
  // dashboard, which is what makes the phase-1 `open_in_editor` guard real: a
  // direct body/title PATCH of an object with a live room is refused (409)
  // instead of being applied underneath the room's CRDT.
  // Process-wide drain flag. It is READ by `/healthz` (below) and SET by the
  // shutdown sequencer's first synchronous step, so readiness flips even if the
  // collab server has no rooms — or is wedged — when the signal lands.
  let draining = false;

  // `wireCollab` — NOT `createCollabServer` directly. The bare server has no
  // room authorizer and is deliberately fail-closed, so constructing it here
  // would refuse every join on every box while logging one warning nobody
  // reads. The assembly (authorizer, doc store, flush, agent bridge, presence)
  // is `collab/wire.ts`, and it is the SAME assembly dev and the integration
  // suites use.
  const wired = wireCollab({
    pool,
    // The SAME disk write-shed guard as the box's main Writer: collab flushes
    // are real writes (a full body + history snapshot per contributor, every
    // 3-30s per active editor) and were the ONE write path that kept running
    // after the shed engaged, growing PGDATA/WAL until Postgres failed — the
    // outcome the guard exists to prevent. flush.ts already classifies the
    // shed refusal correctly (`refused` taxonomy); this just plumbs the guard.
    writer: new Writer(pool, { diskGuard }),
    server: {
      pool,
      sessionSecret,
      // The per-room flush bound, deliberately INSIDE the drain stage's own
      // bound (shutdown.ts documents the ladder): the collab server closes its
      // sockets itself rather than being cut off by the stage watchdog.
      drainTimeoutMs: COLLAB_FLUSH_BUDGET_MS,
      ...(killSwitch ? { killSwitch } : {}),
      ...(publicUrl ? { publicHost: publicUrl } : {}),
      ...(process.env.BRAIN_COLLAB_ALLOWED_ORIGINS
        ? {
            allowedOrigins: process.env.BRAIN_COLLAB_ALLOWED_ORIGINS.split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
    },
  });
  const collab = wired.collab;

  let boxDeps: import("@brain/mcp-tools").ToolDeps | undefined;
  const app = createBox({
    pool,
    ownerClient,
    ownerKv,
    diskGuard,
    dashboard: { sessionSecret, liveRooms: collab.rooms },
    readiness: () => (draining ? { ready: false, reason: "draining" } : collab.readiness()),
    // The collab half of the updater's post-swap canary. Without it a release
    // that breaks the websocket surface but not HTTP passes the canary and is
    // never rolled back — on every box in the fleet.
    collabProbe: () => collab.probeRoom(),
    ...(killSwitch ? { killSwitch } : {}),
    ...(oauth ? { oauth } : {}),
    ...(embedQuery ? { embedQuery } : {}),
    ...(rerank ? { rerank } : {}),
    onDeps: (d) => {
      boxDeps = d;
    },
  });
  // Delayed owner removal (0058): execute due demotions every 5 minutes. The
  // sweep fn is EXECUTE-granted to brain_owner only (boot path, no actor);
  // to_regclass-guarded so a pre-0058 box just skips. There is no push
  // notification channel (it was removed with the teammate) — the Members-page
  // banner + the org-readable removal ledger remain the signal.
  const removalTick = async (): Promise<void> => {
    try {
      const has = await ownerKv.query<{ ok: boolean }>(
        "SELECT to_regclass('public.owner_removals') IS NOT NULL AS ok",
      );
      if (has.rows[0]?.ok !== true) return;
      const r = await ownerKv.query<{ n: number }>("SELECT brain_owner_removal_sweep() AS n");
      const n = Number(r.rows[0]?.n ?? 0);
      if (n > 0) console.log(`owner-removal: ${n} demotion(s) took effect`);
    } catch (err) {
      console.warn(`owner-removal: sweep failed (${String(err)})`);
    }
  };
  const removalTimer = setInterval(() => void removalTick(), 5 * 60_000);
  removalTimer.unref();
  void removalTick();

  const port = Number(process.env.PORT ?? 8080);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`box listening on :${info.port}`);
  });
  // `serve` returns the Node http server — the ONLY place a websocket upgrade
  // can be seen. Everything Hono guarantees stops at this line.
  collab.attach(server as unknown as UpgradeCapableServer);

  // The SIGTERM drain. Two pieces of state live ONLY in this process's memory:
  // live collab rooms (up to ~30s of typed text in the CRDT — the save queue and
  // the localStorage mirror do not cover it) and queued call-audit writes. The
  // updater recreates this container on every release and on every signed
  // restart op, so an un-drained exit loses the last paragraph of everyone who
  // was typing, on every box, on every release.
  //
  // Sequenced, not raced (shutdown.ts owns the budget ladder + the rationale):
  //   readiness → not-ready, synchronously  (caddy stops routing here first)
  //   → drain rooms: read-only → flush → close   ≤ COLLAB_DRAIN_BUDGET_MS
  //   → flush the audit queue                    ≤ AUDIT_FLUSH_BUDGET_MS
  //   → exit                                     ≤ SHUTDOWN_BUDGET_MS overall
  //
  // Rooms BEFORE audit: a room flush is an attributed write that enqueues audit
  // rows of its own, so flushing the queue first would just leave a new tail.
  const drainAndExit = createShutdown({
    stages: [
      {
        // `drainAll`, not `close`: the only thing that must happen before this
        // process dies is "every room's text is in Postgres". `close` also
        // tears hocuspocus down — a second bounded wait, for work `process.exit`
        // is about to do for free, spent out of the same budget as the flush.
        name: "collab rooms",
        budgetMs: COLLAB_DRAIN_BUDGET_MS,
        run: () => collab.drainAll(),
      },
      {
        name: "call-audit queue",
        budgetMs: AUDIT_FLUSH_BUDGET_MS,
        run: async () => {
          await (boxDeps?.writer.flushAudit() ?? Promise.resolve());
        },
      },
    ],
    totalBudgetMs: SHUTDOWN_BUDGET_MS,
    onDrainStart: () => {
      draining = true;
    },
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", () => drainAndExit("SIGTERM"));
  process.on("SIGINT", () => drainAndExit("SIGINT"));
}

const isMain = typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
