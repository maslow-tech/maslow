/**
 * Comment stripping shared by the two SQL linters. Both must see the same text,
 * or a rule that fires in one would be silently dodged in the other.
 */

/**
 * Replace every C-style block comment and every `--` line comment with a single
 * space, exactly as the lazy block-comment regex this replaced did.
 *
 * The block half is an index scan, not a regex: a lazy `[\s\S]*?` body rescans
 * from every opener when the comment is never closed, which is quadratic
 * (CodeQL js/polynomial-redos) on a large migration. Semantics are unchanged —
 * no nesting, no string/dollar-quote awareness, and an unterminated opener
 * leaves the rest of the blob untouched, just as the regex did. The unit test
 * pins both halves against the original pattern.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = sql.indexOf("/*", i);
    if (open === -1) break;
    const close = sql.indexOf("*/", open + 2);
    if (close === -1) break; // unterminated: the regex found no match either
    out += sql.slice(i, open) + " ";
    i = close + 2;
  }
  out += sql.slice(i);
  return out.replace(/--[^\n]*/g, " ");
}
