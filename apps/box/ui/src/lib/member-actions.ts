import type { Member, Whoami } from "./api";

interface ActionAvailability {
  /** true only when the server will actually accept the action. */
  enabled: boolean;
  /** Tooltip copy: what the action does, or why it isn't on offer. */
  reason: string;
}

/**
 * Whether the viewer may revoke this member — mirroring, one for one, the
 * guards baked into `brain_revoke_account` (migration 0015): only an owner may
 * revoke, never themselves, and never another owner (owners are peers).
 *
 * The DB stays the boundary; this exists so the UI never OFFERS a revoke the
 * DB will refuse. Before this, an owner row rendered a live destructive button
 * that walked the operator through a confirm dialog and then failed with
 * "owners are peers — an owner cannot revoke another owner", leaving a
 * bot/service account created as an owner with no removal path in the product
 * at all. An action you cannot take should not look available.
 */
export function revokeAvailability(m: Member, viewer: Whoami): ActionAvailability {
  if (viewer.role !== "owner") return { enabled: false, reason: "Only an owner can revoke access" };
  if (m.id === viewer.id) return { enabled: false, reason: "You can't revoke your own account" };
  if (m.role === "owner")
    return { enabled: false, reason: "Owners are peers — an owner can't revoke another owner" };
  if (m.status !== "active") return { enabled: false, reason: "Already revoked" };
  return { enabled: true, reason: "Revoke access" };
}
