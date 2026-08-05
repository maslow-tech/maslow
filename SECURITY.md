# Security

## Reporting a vulnerability

Email **security@maslow.tech** with a description and reproduction steps. You
should hear back within 72 hours. Please do not open public issues for
suspected vulnerabilities.

## Threat model

What the box enforces:

- Every MCP and dashboard surface requires authentication. Every tool call is
  audited with its actor.
- Objects are private to their creator by default. Visibility is enforced by
  Postgres row-level security with `FORCE ROW LEVEL SECURITY`, which binds the
  application roles and the table owner alike. The only way to widen
  visibility is the `share` tool, and the server checks its arguments.
- Connector credentials are encrypted at rest with a box-local key
  (`BRAIN_CONNECTOR_TOKEN_KEY`).
- Releases are signed in CI with cosign (keyless). Boxes verify the signature
  identity and pull images by digest. A box never downgrades below its version
  floor.
- Custom connector egress is restricted: the host is pinned, redirects are
  refused, responses are size- and time-capped, and secrets are scrubbed from
  what the model sees.

What the box does not defend against:

- Object contents are stored as plaintext in Postgres. Row-level security does
  not constrain a database superuser, and the superuser password is on the
  box. Anyone with root or SSH on the host can read every member's data with
  `psql`. There is no per-author content encryption.
- The box trusts its host. The disk, the docker socket, and the env files
  belong to whoever administers the machine. `deploy/.env` holds live
  credentials and is written `600 root:root`.
