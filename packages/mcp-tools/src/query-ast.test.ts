import { describe, expect, it } from "vitest";
import {
  compileWhere,
  coerceWhere,
  Params,
  type FieldResolver,
  type ResolvedField,
  type WhereNode,
} from "./query-ast.js";

// A resolver that treats every name as a plain text column o."<name>".
const resolveAny: FieldResolver = (name: string): ResolvedField => ({
  sqlColumn: `o.${JSON.stringify(name)}`,
  kind: "text",
});

function compile(node: WhereNode): { sql: string; values: unknown[] } {
  const params = new Params();
  const sql = compileWhere(node, resolveAny, params);
  return { sql, values: params.values };
}

describe("coerceWhere shape-vs-key discrimination", () => {
  it("shorthand {field:'email'} (property literally named 'field') is an equality, not an AST leaf", () => {
    // Regression: key-presence classification misparsed this as a malformed AST
    // node. It is the {prop: value} shorthand the tool advertises, on a property
    // that happens to be named "field".
    const node = coerceWhere({ field: "email" });
    expect(node).toEqual({ field: "field", op: "eq", value: "email" });
    const { sql, values } = compile(node);
    expect(sql).toBe('o."field" = $1');
    expect(values).toEqual(["email"]);
  });

  it("shorthand on properties named not/and/or (non-AST value shapes) are equalities", () => {
    expect(coerceWhere({ not: "x" })).toEqual({ field: "not", op: "eq", value: "x" });
    expect(coerceWhere({ and: "x" })).toEqual({ field: "and", op: "eq", value: "x" });
    expect(coerceWhere({ or: 3 })).toEqual({ field: "or", op: "eq", value: 3 });
  });

  it("still parses a genuine leaf AST node (field + op) untouched", () => {
    const node = { field: "stage", op: "eq", value: "won" } as const;
    expect(coerceWhere(node)).toBe(node);
    expect(compile(node).sql).toBe('o."stage" = $1');
  });

  it("still parses genuine and/or/not AST nodes (correct value shapes) untouched", () => {
    const and = { and: [{ field: "stage", op: "eq", value: "won" }] } as const;
    expect(coerceWhere(and)).toBe(and);
    const or = { or: [{ field: "stage", op: "eq", value: "won" }] } as const;
    expect(coerceWhere(or)).toBe(or);
    const not = { not: { field: "stage", op: "eq", value: "won" } } as const;
    expect(coerceWhere(not)).toBe(not);
    expect(compile(not).sql).toBe('(NOT o."stage" = $1)');
  });
});
