import type { Migration } from "./types.js";

/**
 * A distinguished 'operator' actor. On-box operator work goes
 * through the logged packages/cli wrapper, which attributes every mutation to
 * this account in `events` (per-person attribution comes from the SSM session
 * recording layered on top). role='operator' so members() never lists it and
 * it is not a company member.
 */

const OPERATOR_ID = "00000000-0000-0000-0000-0000000000ff";

const SQL = `
INSERT INTO accounts (id, name, role, status, scopes)
VALUES ('${OPERATOR_ID}', 'operator', 'operator', 'active',
        ARRAY['read','write','schema-admin']::text[])
ON CONFLICT (id) DO NOTHING;
`;

export const migration0010: Migration = {
  version: "0010",
  name: "operator-account",
  sql: SQL,
};
