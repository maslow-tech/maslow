import { describe, expect, it } from "vitest";
import { stripSqlComments } from "./sql-comments.js";

/**
 * The index scan replaced a lazy `[\s\S]*?` block-comment regex. Both linters
 * gate merges on the text it produces, so it must be byte-identical to the
 * pattern it replaced — including the unterminated-comment case, where the
 * regex simply found no match.
 */
const legacy = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

const CASES = [
  "",
  "SELECT 1;",
  "SELECT 1; -- a trailing line comment",
  "-- leading\nSELECT 1;",
  "SELECT /* inline */ 1;",
  "SELECT /* one */ 1 /* two */ , 2;",
  "SELECT /**/ 1;",
  "SELECT /***/ 1;",
  "SELECT /*/ 1;", // an opener that never closes
  "SELECT /* never closed 1;",
  "SELECT */ 1;", // a stray closer with no opener
  "/* outer /* not nested */ still text */",
  "/* multi\nline\ncomment */ SELECT 1;",
  "-- a -- b\nSELECT 1;",
  "SELECT 1; /* c */ -- d\nSELECT 2;",
  "EXECUTE format('%I', x); -- EXECUTE in prose",
  "/* EXECUTE 'raw' */ SELECT 1;",
];

describe("stripSqlComments", () => {
  for (const sql of CASES) {
    it(`matches the replaced regex on ${JSON.stringify(sql)}`, () => {
      expect(stripSqlComments(sql)).toBe(legacy(sql));
    });
  }

  it("blanks a block comment to exactly one space", () => {
    expect(stripSqlComments("a/* x */b")).toBe("a b");
  });

  it("leaves an unterminated opener and everything after it alone", () => {
    expect(stripSqlComments("a/* x b")).toBe("a/* x b");
  });

  it("stays linear on many unterminated openers (the ReDoS shape)", () => {
    const sql = "/* x ".repeat(100_000); // no closer anywhere
    expect(stripSqlComments(sql)).toBe(sql);
    expect(stripSqlComments(sql)).toBe(legacy(sql));
  });
});
