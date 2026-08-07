import type { Migration } from "./migrations/types.js";
import { stripSqlComments } from "./sql-comments.js";

/**
 * The migration linter — a merge-gate.
 *
 * Two jobs:
 *  1. Block **destructive** DDL (DROP TABLE/COLUMN, type change, rename,
 *     TRUNCATE) unless the migration explicitly opts in via `allowDestructive`,
 *     which asserts the author has followed expand→migrate→contract across ≥2
 *     releases (behavioral changes lag columns by a release).
 *  2. Block CREATE INDEX CONCURRENTLY placed in the transactional `sql` — CIC
 *     cannot run inside a transaction; it belongs in `concurrent[]`.
 *
 * This is a static, conservative check: false positives are cheap (add the
 * ack + reason), a false negative can brick a live box.
 */

export interface LintFinding {
  readonly version: string;
  readonly rule: string;
  readonly message: string;
  readonly statement: string;
}

interface Rule {
  readonly rule: string;
  readonly re: RegExp;
  readonly message: string;
  /** If true, an explicit `allowDestructive` acknowledgment silences it. */
  readonly ackable: boolean;
}

const DESTRUCTIVE_RULES: readonly Rule[] = [
  {
    rule: "drop-table",
    re: /\bDROP\s+TABLE\b/i,
    message: "DROP TABLE is destructive",
    ackable: true,
  },
  {
    rule: "drop-column",
    re: /\bDROP\s+COLUMN\b/i,
    message: "DROP COLUMN is destructive",
    ackable: true,
  },
  {
    rule: "column-type-change",
    re: /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i,
    message: "ALTER COLUMN ... TYPE rewrites/narrows data",
    ackable: true,
  },
  {
    rule: "drop-constraint",
    re: /\bDROP\s+CONSTRAINT\b/i,
    message: "DROP CONSTRAINT can silently admit invalid data",
    ackable: true,
  },
  {
    rule: "rename",
    re: /\bRENAME\s+(COLUMN\b|TO\b)/i,
    message: "RENAME breaks code still using the old name (use surrogate ids)",
    ackable: true,
  },
  { rule: "truncate", re: /\bTRUNCATE\b/i, message: "TRUNCATE is destructive", ackable: true },
];

// Non-ackable structural mistakes.
const STRUCTURAL_RULES: readonly Rule[] = [
  {
    rule: "cic-in-txn",
    re: /\bCREATE\s+INDEX\s+CONCURRENTLY\b/i,
    message: "CREATE INDEX CONCURRENTLY cannot run in a txn — move it to concurrent[]",
    ackable: false,
  },
];

/** Split a SQL blob into statements, stripping line/block comments first. */
function statements(sql: string): string[] {
  const noComments = stripSqlComments(sql);
  return noComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function lintMigration(m: Migration): LintFinding[] {
  const findings: LintFinding[] = [];
  const acks = m.allowDestructive ?? [];
  const usedAcks = new Set<number>();

  // An ack silences ONE rule on ONE statement: same rule slug AND its `match`
  // present (case-insensitive) in this comment-stripped/semicolon-split
  // statement. It only SILENCES if it also carries a non-empty reason — but a
  // reason-less ack that matches real destructive text still counts as "used"
  // (so it doesn't also trip stale-ack; the destructive finding stands).
  const acked = (ruleSlug: string, stmt: string): boolean => {
    const lower = stmt.toLowerCase();
    let silence = false;
    acks.forEach((ack, i) => {
      if (ack.rule === ruleSlug && lower.includes(ack.match.toLowerCase())) {
        usedAcks.add(i);
        if (ack.reason.trim().length > 0) silence = true;
      }
    });
    return silence;
  };

  // The transactional part is checked for both structural + destructive rules.
  for (const stmt of statements(m.sql)) {
    for (const r of STRUCTURAL_RULES) {
      if (r.re.test(stmt)) {
        findings.push({ version: m.version, rule: r.rule, message: r.message, statement: stmt });
      }
    }
    for (const r of DESTRUCTIVE_RULES) {
      if (r.re.test(stmt) && !(r.ackable && acked(r.rule, stmt))) {
        findings.push({
          version: m.version,
          rule: r.rule,
          message: `${r.message} — set allowDestructive with a per-statement ack {rule, match, reason} after an expand→contract cycle`,
          statement: stmt,
        });
      }
    }
  }

  // The concurrent part may legitimately DROP INDEX (idempotent CIC pattern),
  // so only the destructive-beyond-index rules apply there.
  for (const stmt of m.concurrent ?? []) {
    for (const r of DESTRUCTIVE_RULES) {
      if (r.rule === "drop-constraint") continue;
      if (/\bDROP\s+INDEX\b/i.test(stmt)) continue; // the resumable-CIC idiom
      if (r.re.test(stmt) && !(r.ackable && acked(r.rule, stmt))) {
        findings.push({
          version: m.version,
          rule: r.rule,
          message: `${r.message} (in concurrent[])`,
          statement: stmt,
        });
      }
    }
  }

  // Any ack that matched no destructive statement is stale — a silent
  // double-failure risk (the DROP it meant to cover stays flagged AND the ack
  // is dead). Flag it loudly with the matching semantics spelled out.
  acks.forEach((ack, i) => {
    if (!usedAcks.has(i)) {
      findings.push({
        version: m.version,
        rule: "stale-ack",
        message:
          `allowDestructive ack {rule:'${ack.rule}', match:'${ack.match}'} matched no destructive ` +
          "statement — match is a case-insensitive substring tested against each comment-stripped, " +
          "semicolon-split statement; fix the match or remove the ack",
        statement: ack.match,
      });
    }
  });

  return findings;
}

export function lintMigrations(ms: readonly Migration[]): LintFinding[] {
  return ms.flatMap(lintMigration);
}
