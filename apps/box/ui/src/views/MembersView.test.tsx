import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { isPendingRemoval, MembersView } from "./MembersView";
import { api, ApiError, type Member, type OwnerRemoval, type Whoami } from "../lib/api";

/**
 * Owner removal (tag governance, wave 5): an owner row carries a delayed
 * "Remove owner" affordance, a pending removal renders a veto banner any owner
 * can cancel, and the server's refusals — written to be shown — surface
 * verbatim. The server re-checks everything; these pin the surface.
 */

const OWNER: Whoami = {
  id: "acct-olive",
  name: "Olive",
  role: "owner",
  scopes: ["read", "write", "admin"],
  status: "active",
};

const MEMBERS: Member[] = [
  {
    id: "acct-olive",
    name: "Olive",
    role: "owner",
    status: "active",
    scopes: ["read", "write", "admin"],
    email: "olive@co.example",
  },
  {
    id: "acct-priya",
    name: "Priya",
    role: "owner",
    status: "active",
    scopes: ["read", "write", "admin"],
    email: "priya@co.example",
  },
  {
    id: "acct-dana",
    name: "Dana",
    role: "member",
    status: "active",
    scopes: ["read", "write"],
    email: "dana@co.example",
  },
];

const PENDING: OwnerRemoval = {
  id: "rem-1",
  target_id: "acct-priya",
  target_name: "Priya",
  initiated_by: "acct-olive",
  initiated_by_name: "Olive",
  effective_at: "2026-08-01T12:00:00Z",
  cancelled_at: null,
  executed_at: null,
};

const CANCELLED: OwnerRemoval = {
  ...PENDING,
  id: "rem-0",
  cancelled_at: "2026-07-20T00:00:00Z",
};

function stub(removals: OwnerRemoval[] = []) {
  vi.spyOn(api, "members").mockResolvedValue(MEMBERS);
  vi.spyOn(api, "tags").mockResolvedValue({ tags: [] });
  const removalsSpy = vi.spyOn(api, "ownerRemovals").mockResolvedValue({ removals });
  return { removalsSpy };
}

describe("<MembersView /> owner removal", () => {
  it("offers Remove owner on owner rows only, and initiates via the confirm dialog", async () => {
    stub();
    const initiate = vi.spyOn(api, "initiateOwnerRemoval").mockResolvedValue({ ok: true });
    render(<MembersView user={OWNER} />);
    await screen.findByText("Priya");

    // owner rows (self included) carry the affordance; a plain member's doesn't
    expect(screen.getByRole("button", { name: "Remove owner Olive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove owner Dana" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove owner Priya" }));
    expect(await screen.findByText("Remove Priya as an owner?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove owner" }));
    await waitFor(() => expect(initiate).toHaveBeenCalledWith("acct-priya"));
  });

  it("surfaces the server's refusal verbatim (already pending)", async () => {
    stub();
    vi.spyOn(api, "initiateOwnerRemoval").mockRejectedValue(
      new ApiError(400, "a removal for this owner is already pending"),
    );
    render(<MembersView user={OWNER} />);
    await screen.findByText("Priya");

    fireEvent.click(screen.getByRole("button", { name: "Remove owner Priya" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove owner" }));

    expect(
      await screen.findByText("a removal for this owner is already pending"),
    ).toBeInTheDocument();
  });

  it("renders the pending banner — not for settled removals — and lets any owner cancel", async () => {
    const { removalsSpy } = stub([PENDING, CANCELLED]);
    const cancel = vi.spyOn(api, "cancelOwnerRemoval").mockResolvedValue({ ok: true });
    render(<MembersView user={OWNER} />);

    // one banner (the cancelled removal renders nothing), naming the target
    const banner = await screen.findByRole("status", {
      name: "Owner removal pending for Priya",
    });
    expect(banner).toHaveTextContent(/Owner removal pending/);
    expect(screen.getAllByRole("status", { name: /Owner removal pending for/ })).toHaveLength(1);

    // the target's row swaps the affordance for a pending marker
    expect(screen.queryByRole("button", { name: "Remove owner Priya" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Owner removal pending" })).toBeInTheDocument();

    const reads = removalsSpy.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Cancel removal of Priya" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("rem-1"));
    // …and the removals re-read so the banner clears
    await waitFor(() => expect(removalsSpy.mock.calls.length).toBeGreaterThan(reads));
  });

  it("surfaces a cancel refusal verbatim", async () => {
    stub([PENDING]);
    vi.spyOn(api, "cancelOwnerRemoval").mockRejectedValue(
      new ApiError(400, "this removal has already been cancelled"),
    );
    render(<MembersView user={OWNER} />);
    await screen.findByRole("status", { name: "Owner removal pending for Priya" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel removal of Priya" }));
    expect(await screen.findByText("this removal has already been cancelled")).toBeInTheDocument();
  });

  it("shows a non-owner no removal affordances and no banner", async () => {
    stub([PENDING]);
    render(<MembersView user={{ ...OWNER, id: "acct-dana", name: "Dana", role: "member" }} />);
    await screen.findByText("Priya");

    expect(screen.queryByRole("button", { name: /^Remove owner / })).not.toBeInTheDocument();
    expect(screen.queryByText(/Owner removal pending/)).not.toBeInTheDocument();
  });
});

describe("isPendingRemoval", () => {
  it("is pending only while neither cancelled nor executed", () => {
    expect(isPendingRemoval(PENDING)).toBe(true);
    expect(isPendingRemoval(CANCELLED)).toBe(false);
    expect(isPendingRemoval({ ...PENDING, executed_at: "2026-08-01T12:00:00Z" })).toBe(false);
  });
});
