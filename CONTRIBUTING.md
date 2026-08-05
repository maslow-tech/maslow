# Contributing

Thanks for helping build maslow.

## Setup

Install Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), and Docker. Docker is
needed for the integration tests and the local box. Then:

```bash
pnpm install
pnpm build
```

## Tests

| Command                                              | What it runs                               | Needs   |
| ---------------------------------------------------- | ------------------------------------------ | ------- |
| `pnpm test:unit`                                     | fast pure-logic suites across packages     | nothing |
| `pnpm test:integration`                              | real Postgres via testcontainers, serially | Docker  |
| `pnpm test:e2e`                                      | end-to-end box flows                       | Docker  |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | static gates                               | nothing |

CI runs all of the above. PRs need a green run.

## Ground rules

Migrations are append-only. A shipped migration is never edited; ship a new
one instead. Migrations run unattended on live boxes, against data you have
never seen, so guard every assumption. When a migration hits a state it does
not expect, it should `RAISE NOTICE` and skip the step. A box that keeps its
old behavior can be fixed later; a box that stops updating cannot.

If a migration reads or mutates rows, extend the migrate-with-data test. An
empty CI database hides silent failures, such as a cross-actor `DELETE` that
row-level security filters down to zero rows while reporting success.

Content tables use `FORCE ROW LEVEL SECURITY`. A migration step that has to
read across actors wraps that one step in `SET LOCAL ROLE brain_system` and
resets afterward. Never grant `BYPASSRLS` to a request-serving role.

The updater must never crash-loop. When it hits surprising state it idles
with a loud log or skips the tick. Verification failures are classified as
transient (defer and retry) or definitive (latch the version); an auth outage
must never latch a box.

Prettier and eslint are enforced by hooks (`pnpm prepare` installs them).
Comments should state constraints the code cannot express, and skip narration.

## Pull requests

Keep PRs focused, and describe the behavior change before the implementation.
New behavior needs a test at the right layer: unit for pure logic, integration
for anything that touches Postgres or an HTTP surface.

Live boxes update themselves from this repository. If a change touches
migrations, env vars, the `deploy/` layout, or the release bundle shape, call
that out explicitly in the PR description.
