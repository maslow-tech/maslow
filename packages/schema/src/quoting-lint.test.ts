import { describe, expect, it } from "vitest";
import { lintQuoting, lintQuotingAll } from "./quoting-lint.js";
import { migration0002 } from "./migrations/0002-executor.js";
import { MIGRATIONS } from "./migrations/index.js";

describe("quoting lint (%I/%L gate)", () => {
  it("passes over the executor primitives (migration 0002)", () => {
    expect(lintQuoting(migration0002.sql)).toEqual([]);
  });

  it("passes over the whole infra migration set", () => {
    const findings = lintQuotingAll(MIGRATIONS.map((m) => ({ name: m.version, sql: m.sql })));
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it("flags a bare %s", () => {
    const f = lintQuoting("EXECUTE format('CREATE TABLE %I (x %s)', a, b);");
    expect(f.map((x) => x.rule)).toContain("no-percent-s");
  });

  it("flags EXECUTE that concatenates instead of using format()", () => {
    const f = lintQuoting("EXECUTE 'CREATE TABLE ' || quote_ident(a);");
    expect(f.map((x) => x.rule)).toContain("execute-must-use-format");
  });

  it("accepts %I and %L", () => {
    expect(lintQuoting("EXECUTE format('INSERT INTO %I VALUES (%L)', t, v);")).toEqual([]);
  });

  it("does not flag the GRANT/REVOKE EXECUTE privilege keyword", () => {
    expect(lintQuoting("REVOKE EXECUTE ON FUNCTION foo(text) FROM PUBLIC;")).toEqual([]);
  });

  it("treats %%s (escaped percent) as safe", () => {
    expect(lintQuoting("EXECUTE format('SELECT ''100%%s''');")).toEqual([]);
  });
});
