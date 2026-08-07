/**
 * The %I/%L quoting lint — a CI merge gate.
 *
 * The corrected guarantee (the earlier "%I forces the extended protocol"
 * rationale was wrong): every dynamic-DDL `EXECUTE` site must build its SQL with
 * `format()` using `%I` for identifiers and `%L` for literals — never a bare
 * `%s`, never string concatenation of a variable into the executed text. This
 * static check runs over the executor + trigger PL/pgSQL bodies in CI so a new
 * EXECUTE site can't quietly reintroduce an injection surface.
 */

import { stripSqlComments } from "./sql-comments.js";

export interface QuotingFinding {
  readonly rule: "no-percent-s" | "execute-must-use-format";
  readonly message: string;
  readonly excerpt: string;
}

function excerptAt(sql: string, index: number, span = 60): string {
  const start = Math.max(0, index - 10);
  return sql
    .slice(start, start + span)
    .replace(/\s+/g, " ")
    .trim();
}

export function lintQuoting(rawSql: string): QuotingFinding[] {
  const findings: QuotingFinding[] = [];
  // Strip comments first so a stray word like "execute" in prose can't be
  // mistaken for a dynamic EXECUTE statement.
  const sql = stripSqlComments(rawSql);

  // Rule A: no bare %s format specifier (%%s escaped-percent is fine).
  const percentS = /(^|[^%])%[0-9]*\$?s/g;
  for (let m = percentS.exec(sql); m !== null; m = percentS.exec(sql)) {
    findings.push({
      rule: "no-percent-s",
      message: "bare %s in a format string — identifiers must use %I, literals %L",
      excerpt: excerptAt(sql, m.index),
    });
  }

  // Rule B: every dynamic EXECUTE must call format(). Skip the GRANT/REVOKE
  // EXECUTE privilege keyword (recognized by a following ON/ ... reference).
  const execRe = /\bEXECUTE\b/gi;
  for (let m = execRe.exec(sql); m !== null; m = execRe.exec(sql)) {
    const after = sql.slice(m.index + "EXECUTE".length).replace(/^\s+/, "");
    if (/^ON\b/i.test(after)) continue; // GRANT/REVOKE EXECUTE ON ...
    if (/^(FUNCTION|PROCEDURE)\b/i.test(after)) continue; // CREATE TRIGGER … EXECUTE FUNCTION …
    if (/^format\s*\(/i.test(after)) continue; // the sanctioned form
    findings.push({
      rule: "execute-must-use-format",
      message: "EXECUTE must build its SQL via format() with %I/%L quoting",
      excerpt: excerptAt(sql, m.index),
    });
  }

  return findings;
}

export function lintQuotingAll(sqls: readonly { name: string; sql: string }[]): QuotingFinding[] {
  return sqls.flatMap((s) =>
    lintQuoting(s.sql).map((f) => ({ ...f, message: `${s.name}: ${f.message}` })),
  );
}
