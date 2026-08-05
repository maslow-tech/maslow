import { describe, expect, it } from "vitest";
import { ingestBoxErrorReport, redactPgError, toBoxErrorReport } from "./observability.js";

describe("closed-enum egress", () => {
  it("maps a pg error to a code and NEVER carries detail/where/hint (PII)", () => {
    const pgErr = {
      code: "23505",
      detail: "Key (email)=(ceo@secret-customer.example) already exists.",
      where: "SQL statement ...",
      hint: "a secret hint",
      message: "duplicate key value violates unique constraint ...",
      constraint: "accounts_email_uniq",
    };
    const report = toBoxErrorReport(pgErr);
    expect(report.code).toBe("db_unique_violation");
    expect(report.count).toBe(1);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/secret-customer|secret hint|accounts_email_uniq|Key \(/);
  });

  it("reports schema errors by SURROGATE id, never by name", () => {
    const report = toBoxErrorReport({ code: "23514" }, { typeId: 7 });
    expect(report).toEqual({ code: "db_check_violation", count: 1, note: "type_id=7" });
    // the note is a fixed surrogate label, printable ASCII, no content
    expect(report.note).toBe("type_id=7");
  });

  it("unknown SQLSTATE collapses to internal_error", () => {
    expect(toBoxErrorReport({ code: "XX999" }).code).toBe("internal_error");
    expect(toBoxErrorReport({}).code).toBe("internal_error");
  });

  it("redactPgError keeps only the code", () => {
    expect(redactPgError({ code: "40001", detail: "secret" })).toEqual({ code: "40001" });
  });

  it("booth ingest rejects a non-enum / content-bearing payload", () => {
    expect(ingestBoxErrorReport({ code: "db_unique_violation", count: 1 })).not.toBeNull();
    // an invented code
    expect(ingestBoxErrorReport({ code: "leak_customer_data", count: 1 })).toBeNull();
    // a note carrying content (newline / non-ASCII / too long)
    expect(
      ingestBoxErrorReport({ code: "internal_error", count: 1, note: "ceo@secret.com\n<script>" }),
    ).toBeNull();
    // an extra field trying to smuggle content
    expect(
      ingestBoxErrorReport({ code: "internal_error", count: 1, payload: "secret row value" }),
    ).toBeNull();
  });
});
