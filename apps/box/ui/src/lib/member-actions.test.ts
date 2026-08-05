import { describe, expect, it } from "vitest";
import { revokeAvailability } from "./member-actions";
import type { Member, Whoami } from "./api";

const owner: Whoami = {
  id: "u-owner",
  name: "Alice",
  role: "owner",
  scopes: ["read", "write", "schema-admin"],
  status: "active",
};

function member(over: Partial<Member> = {}): Member {
  return {
    id: "u-other",
    name: "Someone",
    role: "member",
    status: "active",
    scopes: ["read", "write"],
    ...over,
  };
}

describe("revokeAvailability", () => {
  it("offers revoke on an active non-owner", () => {
    expect(revokeAvailability(member(), owner)).toEqual({
      enabled: true,
      reason: "Revoke access",
    });
  });

  it("never offers revoke on another owner — the DB refuses it (owners are peers)", () => {
    const r = revokeAvailability(member({ id: "u-peer", role: "owner" }), owner);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/peers/i);
  });

  it("never offers revoke on yourself", () => {
    const r = revokeAvailability(member({ id: owner.id, role: "owner" }), owner);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/your own account/i);
  });

  it("says 'yourself' before 'peers' when you are the owner in question", () => {
    // Both rules match an owner looking at their own row; the self message is
    // the one that tells them something they can act on.
    expect(revokeAvailability(member({ id: owner.id, role: "owner" }), owner).reason).toMatch(
      /your own account/i,
    );
  });

  it("does not offer revoke on an already-revoked account", () => {
    const r = revokeAvailability(member({ status: "revoked" }), owner);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/already revoked/i);
  });

  it("offers nothing to a non-owner viewer", () => {
    const viewer: Whoami = { ...owner, id: "u-viewer", role: "member", scopes: ["read", "write"] };
    const r = revokeAvailability(member(), viewer);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/only an owner/i);
  });

  it("an owner whose own account is somehow inactive is still refused on peers", () => {
    // Defense in depth: the row rules do not depend on the viewer's status.
    const r = revokeAvailability(member({ role: "owner" }), { ...owner, status: "revoked" });
    expect(r.enabled).toBe(false);
  });
});
