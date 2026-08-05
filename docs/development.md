# Development

## Layout

```
apps/box            the appliance: MCP server, dashboard API, box runtime
apps/box/ui         the dashboard SPA (Vite + React)
apps/updater        the self-updater daemon
packages/mcp-tools  MCP tool surface + brain semantics (search, write, share…)
packages/schema     Postgres schema as append-only migrations
packages/shared     shared UI theme + utilities
packages/cli        dev CLI helpers
deploy/             compose topology, installer, Dockerfiles, backup scheduler
test/               cross-package integration / e2e / scenario suites
```

Two naming conventions predate the public release and are kept on purpose.
The box's internal name is `brain`: env vars (`BRAIN_*`), package scope
(`@brain/*`), install paths (`/opt/brain`), and container names
(`brain-app-1`) all use it, and renaming them would break every live box's
on-disk contract. The optional fleet control plane is called the `booth` in
code and env vars.

## Local loop

```bash
pnpm install
pnpm build            # tsc across the workspace + SPA build
pnpm test:unit        # fast, no docker
bash scripts/box-local.sh   # a real dev box on localhost
```

The dev box seeds a fictional org (see `apps/box/dev/seed.ts`) so the
dashboard and MCP tools have data to show.

## Test layers

| Layer | Command | What it proves |
| --- | --- | --- |
| unit | `pnpm test:unit` | pure logic, in-process |
| integration | `pnpm test:integration` | RLS, migrations, and HTTP surfaces against real Postgres 17 (testcontainers) |
| scenarios | `pnpm test:scenarios` | multi-step brain workflows against a seeded database |
| e2e | `pnpm test:e2e` | a full box: container topology plus an MCP client |
| browser e2e | `pnpm --filter @brain/box-ui test:mobile` | Playwright: the WebGL canvas under the box's CSP, mobile gestures |

Integration suites run serially on purpose (one container pool). CI runs
every layer on every PR.

## Migrations

These rules exist because migrations run unattended on self-updating boxes.

1. Append-only. A shipped migration is never edited, because the ledger
   checksums applied migrations per database. Ship a new one.
2. Never throw on state you didn't create. Guard every assumption. On
   surprise, `RAISE NOTICE` and skip the step. A box that keeps old behavior
   can be fixed later; a box that stops updating cannot.
3. Test with data. Empty CI databases hide entire failure classes, such as
   deferred trigger events and RLS-silenced DELETEs. If your migration
   touches rows, extend the migrate-with-data test.
4. Respect RLS. Content tables use `FORCE ROW LEVEL SECURITY`, so the
   migration runner's role is bound too. A step that has to see across actors
   wraps exactly that step in `SET LOCAL ROLE brain_system` … `RESET ROLE`.
   Be aware that a SELECT-only policy set makes a cross-actor `DELETE` match
   zero rows and report success.

## Style

Prettier and eslint run from a pre-commit hook (`pnpm prepare` wires it).
Comments should state constraints and invariants that the code cannot
express. TypeScript is strict everywhere.

## Cutting a release (maintainers)

Tag `vX.Y.Z` on a green main commit. The release workflow refuses anything
else. It builds multi-arch images (box, updater, postgres), smoke-tests both
architectures plus a real-browser login flow, signs everything with cosign,
assembles the digest-pinned bundle, and publishes the GitHub Release with the
`release.json` feed entry that live boxes consume. To yank a bad release,
delete the GitHub Release; boxes never roll back below their floor.
