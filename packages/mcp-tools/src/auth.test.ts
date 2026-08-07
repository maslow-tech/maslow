import { describe, expect, it } from "vitest";
import { AuthError, authenticate, parseBearerToken } from "./auth.js";

/**
 * `parseBearerToken` replaced `/^Bearer\s+(.+)$/i` (polynomial backtracking on a
 * whitespace run). The front door must accept and reject EXACTLY what it did, so
 * every case below is also checked against the original pattern.
 */
const legacyParse = (header: string): string | null => {
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
};

const ACCEPTED: Array<[string, string]> = [
  ["Bearer brain_sk_abc", "brain_sk_abc"],
  ["bearer brain_sk_abc", "brain_sk_abc"],
  ["BEARER brain_sk_abc", "brain_sk_abc"],
  ["BeArEr brain_sk_abc", "brain_sk_abc"],
  ["Bearer    brain_sk_abc", "brain_sk_abc"], // multiple spaces collapse
  ["Bearer\tbrain_sk_abc", "brain_sk_abc"],
  ["Bearer \t\t brain_sk_abc", "brain_sk_abc"],
  ["   Bearer brain_sk_abc   ", "brain_sk_abc"], // header itself is trimmed
  ["Bearer a.b.c", "a.b.c"], // JWT shape
  ["Bearer token with spaces", "token with spaces"], // inner spaces survive
  ["Bearer x", "x"],
];

// `\s` includes line terminators, so they are legal SEPARATORS…
const ACCEPTED_NEWLINE_SEPARATED: Array<[string, string]> = [
  ["Bearer\nbrain_sk_abc", "brain_sk_abc"],
  ["Bearer \n brain_sk_abc", "brain_sk_abc"],
];

const REJECTED = [
  "",
  "   ",
  "Bearer",
  "Bearer ",
  "Bearer\t",
  "Bearer   \n  ",
  "Bearerbrain_sk_abc", // no separator
  "Bearerr token",
  "Basic dXNlcjpwYXNz",
  "Token brain_sk_abc",
  "brain_sk_abc",
  " Bearer", // trims to the bare scheme
  "Bearer to\nken", // `.` never matches a line terminator
  "Bearer token\ntrailer",
  "Bearer to\rken",
  "Bearer to\u2028ken",
  "Bearer to\u2029ken",
];

describe("parseBearerToken", () => {
  for (const [header, token] of [...ACCEPTED, ...ACCEPTED_NEWLINE_SEPARATED]) {
    it(`accepts ${JSON.stringify(header)} → ${JSON.stringify(token)}`, () => {
      expect(parseBearerToken(header)).toBe(token);
      expect(parseBearerToken(header)).toBe(legacyParse(header));
    });
  }

  for (const header of REJECTED) {
    it(`rejects ${JSON.stringify(header)}`, () => {
      expect(parseBearerToken(header)).toBeNull();
      expect(legacyParse(header)).toBeNull();
    });
  }

  it("is linear on a long whitespace run (the ReDoS shape)", () => {
    const header = `Bearer${" ".repeat(200_000)}!`;
    expect(parseBearerToken(header)).toBe("!");
  });

  it("is linear on a long non-matching header", () => {
    // The trailing newline would be trimmed off, so it has to sit INSIDE.
    const header = `Bearer ${"a".repeat(200_000)}\nz`;
    expect(parseBearerToken(header)).toBeNull();
    expect(legacyParse(header)).toBeNull();
  });
});

describe("authenticate — header-shape failures never reach the pool", () => {
  // A pool that explodes if touched: every case here must be refused by the
  // header parse alone.
  const pool = {
    query: () => {
      throw new Error("pool must not be queried for a malformed header");
    },
  } as never;

  it("a missing header keeps the Bearer realm challenge", async () => {
    await expect(authenticate(pool, undefined)).rejects.toMatchObject({
      message: "missing Authorization header",
      wwwAuthenticate: 'Bearer realm="brain"',
    });
  });

  it("an empty header is 'missing', not 'malformed' (falsy short-circuit)", async () => {
    await expect(authenticate(pool, "")).rejects.toMatchObject({
      message: "missing Authorization header",
      wwwAuthenticate: 'Bearer realm="brain"',
    });
  });

  for (const header of ["   ", "Bearer", "Bearer ", "Basic abc", "Bearer to\nken"]) {
    it(`refuses ${JSON.stringify(header)} as malformed, with the invalid_token challenge`, async () => {
      const err = await authenticate(pool, header).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect(err).toMatchObject({
        message: "malformed Authorization header",
        wwwAuthenticate: 'Bearer error="invalid_token"',
      });
    });
  }
});
