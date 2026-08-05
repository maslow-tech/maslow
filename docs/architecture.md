# Architecture

Maslow is a self-hosted team-memory appliance: one box per team, running
Postgres, a Node app (MCP server + dashboard), a backup sidecar, and a
self-updater, behind a Caddy TLS terminator. This document explains how the
pieces fit and why they are shaped the way they are.

## Design principles

1. The box is the product. There is no backend that holds your data; brain
   content never leaves the machine. An optional fleet control plane exists
   for operators running many boxes (release channel, kill-switch, health
   console), but it sees heartbeats and version metadata, never content. The
   code calls this control plane the "booth". A standalone box needs nothing
   but GitHub Releases.

2. Visibility is decided in the database. Every write lands creator-private,
   and who can see what is decided by Postgres row-level security evaluating
   a stored audience against the tags a caller holds. The application never
   filters results itself, and no LLM is trusted to decide what is polite to
   reveal.

3. Everything runs on-box. Semantic search uses embedding and reranking
   models baked into the app image and executed in-process on CPU. No tokens
   leave the machine to index your notes.

4. Updates are designed for boxes nobody can shell into. A box in the field
   updates itself: releases are signed in CI, verified on-box, applied one
   release at a time, canaried against the write path, and rolled back on
   failure. Each failure mode is judged by what it does to a box that will
   never be SSH'd into. A box that stops updating silently is worse than a
   box that refuses an update loudly.

5. Backups are verified by restoring them. The backup system's verification
   is a scheduled restore drill that restores into scratch, starts a
   throwaway Postgres, and reads every heap.

## Topology

```
            member's MCP client ──▶ /mcp   ┐
            member's browser ──▶ dashboard ┘
                                   │
                     ┌─────────────▼─────────────┐
                     │   caddy  (TLS, the ONLY   │
                     │   published ports 80/443) │
                     └─────────────┬─────────────┘
        private compose network    │
   ┌───────────────────────────────▼───────────────────────────────┐
   │                                                               │
   │   app ──────────────▶ postgres ◀────────── backup sidecar     │
   │   (MCP + dashboard    (PG 17 +             (pgBackRest        │
   │    + API, Node/Hono)   pgvector)            scheduler)        │
   │                                                               │
   │   updater ──▶ docker socket (recreates app/postgres/caddy/    │
   │               itself to a signed release bundle)              │
   └───────────────────────────────────────────────────────────────┘
```

Defined in `deploy/docker-compose.yml`:

- **caddy**: the only public surface. Terminates TLS via ACME and reverse
  proxies to the app. The image is digest-pinned in the repo, so a bump is a
  reviewable PR and the release bundle can pin the exact image.
- **app** (`apps/box`): the appliance itself. It contains the MCP
  Streamable-HTTP server, the dashboard SPA and API, its own OAuth 2.1
  authorization server, connectors, local inference, and live-collab rooms.
  It publishes no ports and is reachable only through caddy. It mounts the
  Postgres data volume read-only, only to measure disk usage: past a
  configurable fill percentage it sheds content writes (reads keep working)
  so a full disk can never corrupt Postgres.
- **postgres**: stock `postgres:17` plus pgvector and a pre-created WAL
  archive directory. Everything durable lives here.
- **backup**: a sidecar running the same image as postgres (same pgBackRest
  binary, same uid, same data layout), executing
  `deploy/postgres/backup-scheduler.sh`. It is a compose service rather than
  host cron so that it ships with the release bundle and converges on update
  like everything else. It is written never to exit: the updater applies
  releases with `docker compose up -d --wait`, and a sidecar that exits
  non-zero would fail every future release.
- **updater** (`apps/updater`): a separate container holding the host docker
  socket, so it can recreate the app (and postgres, caddy, and itself)
  without dying with it. Absent any release-feed configuration it idles,
  which keeps the local/dev topology identical to production.
- **migrate** / **reissue-owner-token**: one-off `--profile tools` services.
  The first is the migration runner, which also does first-owner bootstrap.
  The second is a break-glass owner-token reissue that connects as the DDL
  role only, so the capability is gated on host/compose access.

## The brain data model

### Typed objects, events, and roles

The schema (`packages/schema`) is built from append-only, checksummed
migrations, tested against seeded databases; an empty CI database hides an
entire class of live-box failures.

- **Objects** are rows with a title, body, version, and a type from a
  user-extensible catalog (`types` / `type_properties`); typed properties
  land in generated extension tables. Schema changes flow only through a
  dedicated executor. The app's DML role can read the catalog but cannot
  alter it.
- **Events** form an append-only audit trail: monotonic sequence, actor,
  kind, target, payload. Every tool call and every mutation is attributed to
  the account that made it.
- Three database roles, each with minimum privilege
  (`packages/schema/src/roles.ts`):
  - `brain_app`: request-serving DML. `NOBYPASSRLS`, SELECT-only on the
    catalog, cannot self-escalate accounts.
  - `brain_owner`: owns the tables and runs DDL/migrations. `NOBYPASSRLS`,
    and since RLS is forced (below), ownership grants it no read access
    either.
  - `brain_system`: `NOLOGIN BYPASSRLS`, reachable only via `SET ROLE` from
    `brain_owner`. The one legitimate cross-actor reader, used by the embed
    sweep and by migration backfills. BYPASSRLS skips policies, not grants,
    so it holds only the table privileges those jobs need.

### Visibility: tags, audiences, and one widening path

One primitive covers private, org-wide, groups, and person-to-person shares:

- People hold tags: a personal tag per account, an org singleton, and
  owner-created custom group tags (`tags`, `account_tags`).
- Objects carry an audience: a DNF expression stored on the row as a list of
  tag-set rows. You see an object iff you hold every tag in at least one
  row. `brain_can_see(audience)` evaluates this inside the RLS policy, in
  Postgres, on every read.
- Every write lands creator-private: the audience defaults to a single row
  containing the creator's personal tag. Publishing org-wide is an explicit
  act.
- `share` is the only widening path. It shares to groups the caller holds
  (containment is server-enforced) or to named members, optionally AND-ing
  required tags into every row; the creator's row always survives. `edit`
  takes no visibility argument, so widening cannot happen as a side effect.
- Tag governance is restricted to humans: tag create/grant/revoke are
  owner-only `SECURITY DEFINER` functions reachable from the dashboard, and
  no MCP path exists. No request-serving role can mutate `tags` or
  `account_tags` directly; the tables have SELECT-only policies.

### FORCE ROW LEVEL SECURITY

Plain `ENABLE ROW LEVEL SECURITY` still exempts the table owner. Migration
`0040-force-rls` upgrades every content table to `FORCE ROW LEVEL SECURITY`,
so even `brain_owner` is policy-bound: a future wiring mistake that runs a
content query on the owner connection fails closed (sees nothing private)
instead of silently reading everyone's notes. New RLS-bearing tables get
FORCE at birth, and a privilege audit asserts that no request-serving role
holds BYPASSRLS.

### The per-member filesystem

Agents get a persistent filesystem, a shared tree plus a private
`/home/<slug>` per member, reached exclusively through the `bash` MCP tool
and backed by three tables (`0037-filesystem`): `fs_homes` (account ↔
immutable home slug), `fs_entries` (the tree, with bytes inline in the row),
and `fs_usage` (a singleton byte counter maintained by the store).

- RLS on `fs_entries` is the privacy boundary, and it binds the bash tool,
  bearer HTTP, and the dashboard identically: shared rows are visible to
  everyone, home rows only to their owner. A trigger derives the owner from
  the path before the policy's WITH CHECK runs, so a row can never lie about
  whose home it is in. There is no dedup or blob table: dedup would create a
  byte surface outside RLS and a cross-home content-existence oracle.
- Caps: 100 MB per file, enforced twice from one constant
  (`packages/schema/src/migrations/fs-limits.ts`), as a DB CHECK and as the
  store's own EFBIG guard, so the two cannot drift. The brain-wide quota
  defaults to 2 GiB (`BRAIN_FS_QUOTA_BYTES`).
- The cap is conservative because the cost is WAL rather than disk. Bytes
  are inline, so under MVCC every write rewrites the whole file into WAL: a
  new row version, new TOAST chunks. One append to a 100 MB file is ~100 MB
  of WAL, and retained WAL is the entire backup cost (see Backups). Raising
  the cap further requires chunked rows (append becomes one INSERT, reads
  stream), which is a change to the store rather than to a number.

## The MCP surface and dashboard

`packages/mcp-tools` defines a transport-agnostic registry of ~18 core
tools: orientation and reads (`start`, `catalog`, `search`, `get`, `list`,
`recent`, `history`), writes (`write`, `edit`, `share`, `delete`, `restore`,
`merge`), schema administration (`set_type`, `define_type`, `add_property`,
`delete_type`), the `bash` workspace, and owner-only member management
(`create_user`, `revoke_user`). Every tool validates its arguments with zod,
enforces a scope (`read` / `write` / `schema-admin`), and is call-audited.
All mutations funnel through one write front door: authenticate scope, check
write-shed and the per-token budget, `SET LOCAL app.actor_id`, then apply in
one transaction, so RLS always knows who is asking.

Tool *visibility* is computed per caller: tools gated on a scope, on the
owner role, or on a connector the caller cannot use do not appear in that
caller's `tools/list`.

**Auth.** Members are local accounts on the box; no external identity
provider is required. Two paths into `/mcp`:

- a static bearer token issued by the owner, or
- OAuth: the box runs its own OAuth 2.1 authorization server
  (`apps/box/src/oauth.ts`) with protected-resource discovery, dynamic
  client registration, and PKCE, so hosted MCP clients can connect in one
  click. A member proves identity by pasting their member token once; the
  box then issues short-lived JWTs it verifies locally, with rotating,
  sliding refresh tokens. The unauthenticated registration endpoint is
  memory-capped so it cannot be used to exhaust the box.

**Connectors.** Two classes, both surfaced on the dashboard:

- Per-member OAuth catalog connectors (Google, Microsoft): the owner
  configures the OAuth client, each member connects their own account, and
  the tool appears for that member only. Tokens live in an encrypted vault:
  credentials are encrypted at rest with `BRAIN_CONNECTOR_TOKEN_KEY`, a
  box-local key held in the environment rather than the database.
- Custom connectors: an owner describes any HTTP API (base URL, how the
  credential attaches, an optional path allowlist, instructions) and every
  member gets one `<slug>_fetch` tool. Egress is constrained
  (`apps/box/src/connectors/custom.ts` plus the SSRF egress guard): HTTPS
  only; the host is pinned, so a path can never change it; redirects are
  refused, since a redirect could carry the credential off-host; requests
  are resolved and CIDR-blocked with IP pinning, so a public hostname that
  rebinds to an internal address is caught at request time; responses are
  size-capped and time-capped; and the server-injected credential is
  scrubbed from every error, so the calling agent never sees it.

## Search

Retrieval is entirely local (`apps/box/src/retrieval-boot.ts`):

- Embeddings: `nomic-embed-text-v1.5`, int8-quantized ONNX, with weights
  baked into the app image and pinned by upstream revision; transformers.js
  runs local-only, so a missing file can never become a runtime download. A
  background sweep chunks and embeds objects into a pgvector table,
  including private ones (under `brain_system`), so creators can
  semantic-search their own private notes.
- Reranking: `mxbai-rerank-xsmall-v1`, a cross-encoder that reorders only
  the head of the fused lexical + semantic + graph candidate list. It was
  adopted after a retrieval eval and a 2-vCPU soak.
- Failure handling: models preload at boot; a corrupt model or missing
  pgvector disables that stage and the box serves lexical search. Degraded
  retrieval is acceptable; a box that will not boot is not. On-request
  inference is concurrency-limited so a burst of searches cannot starve
  health checks and writes on a small box. Release CI smoke-tests that the
  baked models load on both architectures before anything is signed.

## Releases and self-update

### A release is a signed bundle

`.github/workflows/release.yml` runs only for tags on `main` with fully
green CI. It builds multi-arch app, updater, and postgres images;
smoke-tests that the retrieval models load and that a browser can log in,
save, and read back (before signing, so a broken build can never be
signed); then signs each image keyless with cosign over the digest. No
signing key exists to steal: the signature binds to the CI workflow
identity via GitHub's OIDC issuer, and boxes verify exactly that identity.

Each release also publishes:

- a bundle image (`bundle:<version>`): a signed scratch image carrying
  `bundle.json`, which pins every component (app, updater, postgres, caddy)
  by digest and records the postgres major and a checksummed deploy tarball
  (compose file, configs, scripts). The updater reconciles the whole box to
  it, so config changes ship like code.
- a GitHub Release with a machine-readable `release.json` asset
  (`{version, image_digest, channel}`), which is the standalone release
  feed.

### The update loop

The updater polls a feed and takes at most one step per tick. Two feeds,
one duck type (`apps/updater/src/runtime.ts` cannot tell them apart):

- GitHub Releases (standalone): the desired version is computed locally as
  the newest non-yanked release on the box's channel. Yanking a bad release
  means deleting the GitHub Release. Polls every 15 minutes, budgeted to
  stay inside unauthenticated API rate limits.
- Fleet control plane (optional): tells boxes their desired version,
  carries a kill-switch and signed operator ops (restart, prune); polls
  every 3 minutes.

Decision logic is pure and exhaustively unit-tested
(`decisions.ts`, `versions.ts`). The rules:

- Release order comes from the version tags' own semver, never from feed
  list position. The feed is not signed, so a compromised feed reordering
  its response must not let an old (still validly signed) release
  masquerade as a forward step. A second, ordinal-free floor gate wraps the
  pull as defense in depth.
- One release at a time, never a multi-version jump; migrations and
  compatibility are only ever tested one step wide.
- Anti-rollback floor: desired < current is refused without a signed
  operator downgrade, and never below the box's monotonic floor.
- Poisoned-version latch: a version that fails to apply gets per-version
  exponential backoff and, after three failures, is latched; the box stops
  retrying it rather than crash-looping. Verify and fetch failures are
  classified as transient or definitive (`BundleFetchError`): auth errors
  and transport errors (DNS, TLS, timeouts, 5xx, 429) defer forever without
  counting, because an expired registry credential must never permanently
  latch a box; only a structurally invalid or hostile bundle counts toward
  poison. Unrecognized failures stay definitive on purpose. Deferral counts
  are reported, so a silently deferring box still surfaces as stalled.
- Replay-safe swap journal: the in-flight version is persisted just before
  the point of no return, so a crash mid-swap is counted as a failed
  attempt on restart (the latch still engages across crashes) and the image
  pin heals back.
- Canary, then rollback: after the swap, the updater samples the box's
  `/canary`, a database write probe plus an in-process collab-room probe
  rather than a liveness check. Only samples taken while the box was not
  busy can condemn a release; an all-busy window verdicts "retry", never
  "roll back", so a false red cannot restart-storm a loaded box. On a
  condemning verdict it rolls back to the newest kept image that the
  already-migrated schema still supports (each image declares its minimum
  compatible schema), rather than to the previous tag.
- Bundle trust gates: after the cosign signature, `bundle.json` must be
  shape-valid, name the version that was asked for, and carry the same app
  digest as the feed's release record; a re-tagged but validly signed
  bundle for another version is refused. Image repos are host-allowlisted,
  and every pin is by digest, so a hostile registry can affect
  availability but not integrity. The one hard refusal: a postgres major
  jump is never applied automatically, because the on-disk format changes;
  that path is an operator runbook.

## Backups

pgBackRest takes physical base backups plus continuous WAL archiving, into
a local repo on the same volume (`deploy/postgres/backup-scheduler.sh`,
`deploy/pgbackrest/`).

- The cadence is inverted from the usual advice, on purpose. The base
  backup is nearly free (a database of tens of MB); retained WAL is the
  entire cost (it can run to GBs/day). So: a full every 12 hours, retention
  4, giving a ~48-hour PITR window. Frequent fulls are what let old WAL be
  expired, which keeps the repo small. `expire` runs every cycle.
- The repo budget is a percentage of the volume (default 20%), computed at
  runtime with `df` rather than hardcoded bytes, since boxes are
  provisioned at different sizes. Approaching it steps retention down;
  crossing it refuses to start a backup rather than filling the disk. The
  backup scheduler gates on the same disk-pressure threshold the app's
  write-shed uses, so a single number is enforced at both points.
- A local repo bounds *logical* mistakes (a bad migration, a dropped table,
  an agent scribbling over rows) with PITR at RPO ≈ 60 s. It does not
  survive whole-volume loss; that requires volume-level snapshots or a
  future off-box stage.
- The restore drill is the verification step. Weekly (and on demand), the
  scheduler restores the newest backup into a scratch directory, starts a
  throwaway Postgres on it, and reads every row of every user table,
  forcing a full heap scan so that a torn page fails the drill instead of a
  cluster that merely started. The drill runs with archiving forced off at
  three layers (a promoted drill must never push a bogus timeline into the
  archive the restores depend on), uses its own archive spool, and reports
  its result on the box's health surface. "Skipped" is never a pass.

## Security boundaries

What the RLS story does and does not buy you (see also `SECURITY.md`):

- Holds: creator-private objects are unreadable through every application
  path, as `brain_app`, and as `brain_owner`; `FORCE ROW LEVEL SECURITY`
  closes the table-owner bypass, and no request-serving role holds
  BYPASSRLS. Widening visibility has exactly one server-enforced path.
  Every surface (MCP, HTTP, dashboard, bash) resolves through the same
  policies.
- Does not hold: against a host-level Postgres superuser. RLS, forced or
  not, does not constrain a superuser, and the superuser password lives in
  the box's `deploy/.env` (written `600 root:root`). Anyone with root/SSH
  on the host can `psql` their way to every member's data.
- Content is plaintext at rest. `objects.title`/`body` and filesystem bytes
  are stored unencrypted; the only at-rest encryption is for connector
  credentials (a box-local key held outside the database). Per-author
  content encryption is unbuilt: it collides with semantic search, sharing,
  restore, and lost-token recovery, and would need to be designed as a
  whole.

"Private" is therefore an application/RLS-layer guarantee against
teammates, agents, and application bugs. It is not a guarantee against
whoever administers the host, and should not be represented as one to your
team.
