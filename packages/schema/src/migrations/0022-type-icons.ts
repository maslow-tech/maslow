import type { Migration } from "./types.js";

/**
 * Every type carries an emoji icon.
 *
 *   types.icon text NOT NULL DEFAULT '🗂️' — a single emoji shown wherever a
 *   type is presented (dashboard sidebar, cards, pills, headers) and returned
 *   in the catalog so agents see it too.
 *
 * Backfill is name-keyword heuristic → a fitting emoji, with a generic
 * fallback, so a box with real types (person, client, deal, …) lights up
 * immediately without any operator action. New types get the DEFAULT unless
 * defineType supplies one (it computes the same heuristic).
 *
 * Safe on a live box with data: ADD COLUMN IF NOT EXISTS, a pure UPDATE that
 * fills only NULLs, then DEFAULT + NOT NULL (every row is backfilled first, so
 * SET NOT NULL never fails). No triggers, no grants, no assumptions about which
 * types exist — an unknown box just gets the fallback on its own types.
 */

const SQL = `
SET LOCAL lock_timeout = '5s';

ALTER TABLE types ADD COLUMN IF NOT EXISTS icon text;

UPDATE types SET icon = CASE
  WHEN name ~ 'person|people|contact|member|employee|teammate|user|lead' THEN '👤'
  WHEN name ~ 'client|customer|account|company|organization|org|vendor|partner' THEN '🏢'
  WHEN name ~ 'agency|agencies|government' THEN '🏛️'
  WHEN name ~ 'deal|opportunity|pipeline|sale' THEN '🤝'
  WHEN name ~ 'contract|award|agreement' THEN '📜'
  WHEN name ~ 'task|todo|to_do|action|ticket|work_item|issue|bug' THEN '✅'
  WHEN name ~ 'decision' THEN '⚖️'
  WHEN name ~ 'meeting|interaction|call|event|touchpoint|conversation' THEN '📅'
  WHEN name ~ 'doc|document|file|attachment|template' THEN '📄'
  WHEN name ~ 'report|status|summary|dream' THEN '📊'
  WHEN name ~ 'note|memo' THEN '📝'
  WHEN name ~ 'skill|routine|playbook|process|sop' THEN '🛠️'
  WHEN name ~ 'product|blend|item|sku' THEN '📦'
  WHEN name ~ 'project|initiative|program' THEN '🗂️'
  WHEN name ~ 'risk|threat' THEN '⚠️'
  WHEN name ~ 'goal|objective|okr|target' THEN '🎯'
  WHEN name ~ 'metric|kpi|number|finance|invoice|payment|budget' THEN '💰'
  WHEN name ~ 'location|site|place|region' THEN '📍'
  WHEN name ~ 'idea|feature' THEN '💡'
  ELSE '🗂️'
END
WHERE icon IS NULL;

ALTER TABLE types ALTER COLUMN icon SET DEFAULT '🗂️';
ALTER TABLE types ALTER COLUMN icon SET NOT NULL;
`;

export const migration0022: Migration = {
  version: "0022",
  name: "type-icons",
  sql: SQL,
};
