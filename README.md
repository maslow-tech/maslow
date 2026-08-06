# maslow

[![ci](https://github.com/maslow-tech/maslow/actions/workflows/ci.yml/badge.svg)](https://github.com/maslow-tech/maslow/actions/workflows/ci.yml)
[![license: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

A self-hosted memory appliance for teams that work with AI agents.

Maslow runs on a machine you own: Postgres, a Node app, and a self-updater.
Team members and their AI agents read and write one shared, structured memory
over [MCP](https://modelcontextprotocol.io). Privacy rules are enforced by the
database. Search runs on the box. Updates arrive signed. Nothing is sent to a
vendor.

## Features

- An MCP server at `https://<your-box>/mcp`. Connect Claude or any MCP client
  and you get tools for typed objects, search, sharing, history, a per-member
  filesystem, and a persistent `bash` workspace.
- A web dashboard for browsing and editing the same data: members, tags,
  connectors, files, live collaboration.
- Every write starts private to its creator. Widening visibility takes an
  explicit `share`, and Postgres row-level security enforces the rules
  (`FORCE ROW LEVEL SECURITY`, so even the table owner is bound).
- Semantic search uses embedding and reranking models baked into the image.
  Your notes are never sent anywhere to be embedded.
- Per-member Google and Microsoft OAuth connectors, plus owner-defined custom
  HTTP connectors. Credentials are encrypted at rest.
- Scheduled pgBackRest backups (physical base backups plus WAL archiving) and
  a weekly restore drill that restores the newest backup and counts every row.
- Self-updates: CI builds each release, signs it with cosign, and publishes it
  on GitHub Releases. The updater verifies the signature, pulls by digest,
  migrates, probes the write path, and rolls back if the probe fails.

## Quick start

You need a Linux host (amd64 or arm64) with Docker and Docker Compose, a DNS
name pointed at it, and ports 80 and 443 open.

```bash
curl -fsSL https://github.com/maslow-tech/maslow/releases/latest/download/install.sh \
  -o install.sh
sudo BRAIN_BOOTSTRAP_OWNER_NAME="Your Name" \
     BRAIN_BOOTSTRAP_OWNER_EMAIL="you@yourdomain.com" \
     bash install.sh brain.yourdomain.com
```

The installer brings up Postgres, the app, Caddy (automatic TLS), the backup
sidecar, and the updater, then prints the first owner login. Open
`https://brain.yourdomain.com`, sign in, and add
`https://brain.yourdomain.com/mcp` as a connector in Claude.

For local development:

```bash
pnpm install
pnpm build
bash scripts/box-local.sh   # dev box against a local postgres
```

## Architecture

```
┌────────────────────────── your host ──────────────────────────┐
│  caddy (TLS) ── app (MCP + dashboard + API) ── postgres       │
│                       │                          │            │
│                  updater (signed releases)   backup sidecar   │
└───────────────────────────────────────────────────────────────┘
```

| Path                 | Contents                                                      |
| -------------------- | ------------------------------------------------------------- |
| `apps/box`           | the appliance: MCP server, dashboard API, SPA (`apps/box/ui`) |
| `apps/updater`       | the self-updater                                              |
| `packages/mcp-tools` | the MCP tool surface                                          |
| `packages/schema`    | append-only, checksummed migrations                           |
| `deploy/`            | compose topology, installer, backup scheduler, Dockerfiles    |

## Updates and releases

A release pins every component (app, updater, postgres, caddy, configs) by
digest in a signed bundle and is published as a GitHub Release with a
`release.json` feed entry. Boxes poll the feed, verify the cosign signature
against this repository's CI identity, and step one release at a time. A box
never moves backward past its version floor. To yank a bad release, delete the
GitHub Release.

## Security

Every MCP and dashboard surface requires authentication, and every tool call
is audited. Object contents are stored as plaintext in Postgres, so anyone
with root on the host can read the database. `SECURITY.md` describes the
threat model and how to report vulnerabilities.

## Documentation

- [Architecture](docs/architecture.md)
- [Self-hosting guide](docs/self-hosting.md)
- [Runbooks](docs/runbooks/) (backups, restore drills, PITR, disaster
  recovery, Postgres major upgrades, OAuth setup)
- [Development](docs/development.md)

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). You need Node 22, pnpm, and Docker.
`pnpm test:unit` gives fast feedback; the integration tests start ephemeral
Postgres containers.

## License

[GNU AGPL-3.0](LICENSE). Copyright (C) 2026 Maslow Technologies.

You can run, study, modify, and redistribute this software. If you modify it
and let other people use it over a network, AGPL section 13 requires you to
offer those users the source of your modified version. Running an unmodified
box for your own team carries no such obligation, and nothing here restricts
what you do with the data in your brain.

Third-party components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
