import type { Migration } from "./types.js";

/**
 * Custom connectors (owner-defined HTTP connectors): the DEFINITION half of
 * the connector model, as data. An owner describes an external HTTP API —
 * base URL, how the credential attaches (header / query / none), optional
 * path allowlist, instructions — and the box exposes ONE MCP tool
 * `<slug>_fetch` to every member once the org credential is stored.
 *
 * The credential itself stays in connector_config (0024), one row per slug,
 * encrypted under BRAIN_CONNECTOR_TOKEN_KEY — "enabled" remains a pure
 * row-existence check, identical to catalog providers.
 *
 * Seeds the samgov definition: SAM.gov's catalog entry moves out of code and
 * becomes the first custom connector (its attachment/OCR pipeline stays code,
 * dispatched by slug). ON CONFLICT DO NOTHING — a box where an owner already
 * created a `samgov` custom connector keeps theirs; the seed never overwrites
 * and never throws (migration doctrine: no assumption about box state).
 *
 * No RLS: reached only through the box's CustomConnectorStore (owner-gated
 * writes at the HTTP layer), never through the generic tool surface — same
 * posture as connector_config.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

CREATE TABLE custom_connectors (
  slug              text PRIMARY KEY COLLATE "C"
                      CHECK (slug ~ '^[a-z][a-z0-9_]{1,31}$'),
  name              text NOT NULL,
  base_url          text NOT NULL,
  auth_kind         text NOT NULL CHECK (auth_kind IN ('header','query','none')),
  auth_name         text,
  allowed_prefixes  text[] NOT NULL DEFAULT '{}',
  instructions      text NOT NULL DEFAULT '',
  description       text NOT NULL DEFAULT '',
  created_by        uuid REFERENCES accounts(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_connectors TO brain_app;

INSERT INTO custom_connectors
  (slug, name, base_url, auth_kind, auth_name, allowed_prefixes, description, instructions)
VALUES (
  'samgov',
  'SAM.gov',
  'https://api.sam.gov',
  'query',
  'api_key',
  ARRAY['/opportunities/v2/', '/entity-information/', '/prod/opportunities/v1/noticedesc'],
  'GET any SAM.gov API (the U.S. federal contracting database) and return its raw JSON. Give a path and query params; the box injects the org''s API key — you never handle it. Allowed paths: ''/opportunities/v2/search'' (contract opportunities: postedFrom+postedTo required, MM/dd/yyyy, max 1-year span; filter with title, ncode (NAICS), state, typeOfSetAside, ptype, solnum; limit up to 1000, offset for paging) and ''/entity-information/…'' (''/entity-information/v3/entities'' — registered contractors by ueiSAM, cageCode, or legalBusinessName; ''/entity-information/v4/exclusions'' — debarment checks). To READ a notice, pass URLs from a search result as the path verbatim: its "description" field (the notice''s full description text) and its "resourceLinks" entries (attached documents — the PWS/SOW/solicitation; PDF and DOCX come back as extracted text, scanned PDFs are OCR''d). Budget: ~1,000 requests/day org-wide; one search or document = one request, so prefer few broad, well-filtered searches and fetch documents only for notices that already passed screening. Check the brain for a skill object with the full routine and the org''s interest profile before improvising.',
  'SAM.gov connector. Call with a path under /opportunities/v2/ or /entity-information/, or pass a search result''s description/resourceLinks URL verbatim to read the notice text or an attached document. GET only. Budget ~1,000 requests/day org-wide — search broad and well-filtered, fetch documents only for screened notices.'
)
ON CONFLICT (slug) DO NOTHING;
`;

export const migration0033: Migration = {
  version: "0033",
  name: "custom-connectors",
  sql: SQL,
};
