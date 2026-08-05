import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COLLAB_CLOSE,
  COLLAB_TICKET_MAX_TTL_SECONDS,
  collabAllowedHosts,
  evictCloseCode,
  handshakeDecision,
  mintCollabTicket,
  normalizeOrigin,
  originAllowed,
  signCollabTicket,
  verifyCollabTicket,
  type CollabPrincipal,
} from "./types.js";

const SECRET = "s3cr3t-session-signing-key";

function principal(over: Partial<CollabPrincipal> = {}): CollabPrincipal {
  return {
    actorId: "acct-1",
    role: "member",
    scopes: ["read", "write"],
    expiresAt: Date.now() + 30_000,
    ticketId: "tkt-1",
    ...over,
  };
}

describe("collab tickets", () => {
  it("round-trips a minted ticket into a principal", () => {
    const now = 1_800_000_000_000;
    const { ticket } = mintCollabTicket(
      SECRET,
      { actorId: "acct-9", role: "owner", scopes: ["read", "write", "admin"] },
      { now, ttlSeconds: 30, jti: "t-9" },
    );
    const p = verifyCollabTicket(SECRET, ticket, now + 1_000);
    expect(p).toEqual({
      actorId: "acct-9",
      role: "owner",
      scopes: ["read", "write", "admin"],
      expiresAt: (Math.floor(now / 1000) + 30) * 1000,
      ticketId: "t-9",
    });
  });

  it("refuses a ticket signed with another secret", () => {
    const { ticket } = mintCollabTicket(SECRET, { actorId: "a", role: "member", scopes: [] });
    expect(verifyCollabTicket("some-other-secret", ticket)).toBeNull();
  });

  it("refuses a tampered payload", () => {
    const now = 1_800_000_000_000;
    const { ticket } = mintCollabTicket(
      SECRET,
      { actorId: "acct-1", role: "member", scopes: ["read"] },
      { now },
    );
    const [body, sig] = ticket.split(".");
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as {
      sub: string;
    };
    decoded.sub = "acct-owner";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${sig}`;
    expect(verifyCollabTicket(SECRET, forged, now)).toBeNull();
  });

  it("refuses an expired ticket", () => {
    const now = 1_800_000_000_000;
    const { ticket } = mintCollabTicket(
      SECRET,
      { actorId: "a", role: "member", scopes: [] },
      { now, ttlSeconds: 10 },
    );
    expect(verifyCollabTicket(SECRET, ticket, now + 9_000)).not.toBeNull();
    expect(verifyCollabTicket(SECRET, ticket, now + 11_000)).toBeNull();
  });

  it("clamps the minted TTL to the cap", () => {
    const now = 1_800_000_000_000;
    const { payload } = mintCollabTicket(
      SECRET,
      { actorId: "a", role: "member", scopes: [] },
      { now, ttlSeconds: 86_400 },
    );
    expect(payload.exp - payload.iat).toBe(COLLAB_TICKET_MAX_TTL_SECONDS);
  });

  it("refuses a correctly-signed ticket that exceeds the TTL cap", () => {
    // A future minter bug (or a compromised signer) must not be able to issue a
    // long-lived ticket: verification enforces the cap independently of mint.
    const iat = 1_800_000_000;
    const long = signCollabTicket(SECRET, {
      sub: "a",
      role: "member",
      scopes: ["read"],
      iat,
      exp: iat + 86_400,
      jti: "t",
    });
    expect(verifyCollabTicket(SECRET, long, iat * 1000 + 1_000)).toBeNull();
  });

  it("does not accept a session-cookie-shaped token (separate key space)", () => {
    // The session cookie is HMAC'd with the raw secret; the ticket key is
    // derived from it. Neither may be replayed as the other.
    const body = Buffer.from(
      JSON.stringify({
        sub: "a",
        role: "member",
        scopes: ["read"],
        iat: 1_800_000_000,
        exp: 1_800_000_030,
        jti: "t",
      }),
    ).toString("base64url");
    const sessionStyle = `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
    expect(verifyCollabTicket(SECRET, sessionStyle, 1_800_000_000_000)).toBeNull();
  });

  it("refuses empty / malformed input", () => {
    expect(verifyCollabTicket(SECRET, undefined)).toBeNull();
    expect(verifyCollabTicket(SECRET, "")).toBeNull();
    expect(verifyCollabTicket(SECRET, "nodot")).toBeNull();
    expect(verifyCollabTicket(SECRET, ".sig")).toBeNull();
  });
});

describe("origin allowlist", () => {
  it("parses only real origins", () => {
    expect(normalizeOrigin("https://brain.example.com")).toEqual({
      scheme: "https",
      host: "brain.example.com",
    });
    expect(normalizeOrigin("HTTPS://Brain.Example.Com")?.host).toBe("brain.example.com");
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeOrigin("https://evil.tld/path")).toBeNull();
    expect(normalizeOrigin("https://user:pw@brain.example.com")).toBeNull();
  });

  it("builds the host list from a URL or a bare host", () => {
    expect(collabAllowedHosts("https://brain.example.com")).toEqual(["brain.example.com"]);
    expect(collabAllowedHosts("brain.example.com")).toEqual(["brain.example.com"]);
    expect(collabAllowedHosts("https://a.tld", ["https://a.tld", "http://localhost:5180"])).toEqual(
      ["a.tld", "localhost:5180"],
    );
    expect(collabAllowedHosts(undefined, undefined)).toEqual([]);
  });

  it("allows the box's own origin and refuses every other", () => {
    const allowedHosts = ["brain.example.com"];
    expect(originAllowed("https://brain.example.com", { allowedHosts })).toBe(true);
    expect(originAllowed("https://evil.example", { allowedHosts })).toBe(false);
    // the classic near-miss: a subdomain / suffix of our host
    expect(originAllowed("https://brain.example.com.evil.example", { allowedHosts })).toBe(false);
    expect(originAllowed("https://evilbrain.example.com", { allowedHosts })).toBe(false);
    // plaintext off loopback is a downgrade or a forged header
    expect(originAllowed("http://brain.example.com", { allowedHosts })).toBe(false);
    // fail closed on a missing or opaque Origin
    expect(originAllowed(undefined, { allowedHosts })).toBe(false);
    expect(originAllowed("null", { allowedHosts })).toBe(false);
  });

  it("falls back to same-host when nothing is configured", () => {
    const ctx = { allowedHosts: [], requestHost: "brain.example.com" };
    expect(originAllowed("https://brain.example.com", ctx)).toBe(true);
    expect(originAllowed("https://evil.example", ctx)).toBe(false);
    // a loopback origin cannot reach a box that answers on a real hostname
    expect(originAllowed("http://localhost:5180", ctx)).toBe(false);
    expect(originAllowed("https://brain.example.com", { allowedHosts: [] })).toBe(false);
  });

  it("allows loopback→loopback for local dev only", () => {
    const dev = { allowedHosts: [], requestHost: "localhost:8080" };
    expect(originAllowed("http://localhost:5180", dev)).toBe(true);
    expect(originAllowed("http://127.0.0.1:5180", dev)).toBe(true);
    expect(originAllowed("https://evil.example", dev)).toBe(false);
  });
});

describe("handshakeDecision", () => {
  const base = {
    accepting: true,
    boxOn: true,
    origin: "https://brain.example.com",
    requestHost: "brain.example.com",
    allowedHosts: ["brain.example.com"],
    principal: principal(),
  };

  it("accepts a good handshake", () => {
    const d = handshakeDecision(base);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.principal.actorId).toBe("acct-1");
  });

  it("refuses while draining", () => {
    const d = handshakeDecision({ ...base, accepting: false });
    expect(d).toMatchObject({ ok: false, code: COLLAB_CLOSE.DRAINING });
  });

  it("refuses when the box is off — before it looks at anything else", () => {
    // A suspended box must not accept edits into the customer's database while
    // every HTTP surface correctly 503s. Even a perfect ticket loses here.
    const d = handshakeDecision({ ...base, boxOn: false });
    expect(d).toMatchObject({ ok: false, code: COLLAB_CLOSE.BOX_OFF });
    const worse = handshakeDecision({
      ...base,
      boxOn: false,
      origin: "https://evil.example",
      principal: null,
    });
    expect(worse).toMatchObject({ ok: false, code: COLLAB_CLOSE.BOX_OFF });
  });

  it("refuses a cross-site origin even with a valid ticket", () => {
    const d = handshakeDecision({ ...base, origin: "https://evil.example" });
    expect(d).toMatchObject({ ok: false, code: COLLAB_CLOSE.BAD_ORIGIN });
  });

  it("refuses a missing/expired ticket", () => {
    const d = handshakeDecision({ ...base, principal: null });
    expect(d).toMatchObject({ ok: false, code: COLLAB_CLOSE.UNAUTHORIZED });
  });

  it("gives each refusal a distinct code and a short reason", () => {
    const codes = new Set(
      [
        handshakeDecision({ ...base, accepting: false }),
        handshakeDecision({ ...base, boxOn: false }),
        handshakeDecision({ ...base, origin: "https://evil.example" }),
        handshakeDecision({ ...base, principal: null }),
      ].map((d) => (d.ok ? 0 : d.code)),
    );
    expect(codes.size).toBe(4);
    for (const d of [
      handshakeDecision({ ...base, accepting: false }),
      handshakeDecision({ ...base, boxOn: false }),
    ]) {
      if (!d.ok) expect(Buffer.byteLength(d.reason, "utf8")).toBeLessThanOrEqual(123);
    }
  });
});

describe("evictCloseCode", () => {
  it("maps a reason to the code the client should react to", () => {
    expect(evictCloseCode("box_off")).toBe(COLLAB_CLOSE.BOX_OFF);
    expect(evictCloseCode("draining")).toBe(COLLAB_CLOSE.DRAINING);
    expect(evictCloseCode("closing")).toBe(COLLAB_CLOSE.DRAINING);
    expect(evictCloseCode("visibility_changed")).toBe(COLLAB_CLOSE.EVICTED);
    expect(evictCloseCode("unshared")).toBe(COLLAB_CLOSE.EVICTED);
    expect(evictCloseCode("deleted")).toBe(COLLAB_CLOSE.EVICTED);
    expect(evictCloseCode("access_revoked")).toBe(COLLAB_CLOSE.EVICTED);
  });
});
