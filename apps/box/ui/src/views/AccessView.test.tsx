import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AccessView, TAG_SLUG_RE } from "./AccessView";
import { api, ApiError, type Member, type TagRow, type Whoami } from "../lib/api";

/**
 * The owner's tag-governance page: the tag table renders from the API, the
 * create form refuses a bad slug BEFORE any round-trip, and holder management
 * calls the grant/revoke routes. The server re-checks everything — these pin
 * the surface, not the gate.
 */

const OWNER: Whoami = {
  id: "acct-owner",
  name: "Olive",
  role: "owner",
  scopes: ["read", "write", "admin"],
  status: "active",
};

const MEMBERS: Member[] = [
  {
    id: "acct-owner",
    name: "Olive",
    role: "owner",
    status: "active",
    scopes: ["read", "write", "admin"],
    email: "olive@co.example",
  },
  {
    id: "acct-dana",
    name: "Dana",
    role: "member",
    status: "active",
    scopes: ["read", "write"],
    email: "dana@co.example",
  },
  {
    id: "acct-bot",
    name: "Legacy Service",
    role: "member",
    status: "active",
    scopes: ["read", "write"],
    email: "bot@co.example",
  },
];

const TAGS: TagRow[] = [
  { slug: "org", kind: "org", account_id: null, holders: ["acct-owner", "acct-dana", "acct-bot"] },
  { slug: "c-suite", kind: "custom", account_id: null, holders: ["acct-dana"] },
  { slug: "olive-personal", kind: "personal", account_id: "acct-owner", holders: ["acct-owner"] },
];

function stub(tags: TagRow[] = TAGS) {
  const tagsSpy = vi.spyOn(api, "tags").mockResolvedValue({ tags });
  const membersSpy = vi.spyOn(api, "members").mockResolvedValue(MEMBERS);
  return { tagsSpy, membersSpy };
}

describe("<AccessView />", () => {
  it("leads with GROUPS; personal identity tags collapse into an expandable footnote", async () => {
    stub();
    render(<AccessView user={OWNER} />);

    expect(await screen.findByText("c-suite")).toBeInTheDocument();
    // "org" is both the slug cell and the kind badge on the same row
    expect(screen.getAllByText("org")).toHaveLength(2);
    expect(screen.getByText("custom")).toBeInTheDocument();
    // the custom tag's holder is a name, not an account id
    expect(screen.getByText("Dana")).toBeInTheDocument();
    expect(screen.queryByText("acct-dana")).not.toBeInTheDocument();
    // org rows are inert — no remove affordance on them
    expect(screen.getByText(/everyone \(3\)/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);

    // personal tags stay OUT of the table until expanded…
    expect(screen.queryByText("olive-personal")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show personal tags \(1\)/ }));
    // …then render as "holder name — slug" lines
    expect(screen.getByText("olive-personal")).toBeInTheDocument();
    expect(screen.getByText("Olive")).toBeInTheDocument();
  });

  it("hides personal tags whose holder is revoked or unknown (the system actor)", async () => {
    stub([
      ...TAGS,
      // revoked member's tag + the internal system actor's tag: never shown
      { slug: "person-gone", kind: "personal", account_id: "acct-gone", holders: ["acct-gone"] },
      { slug: "person-00000000", kind: "personal", account_id: "sys", holders: ["sys"] },
    ]);
    render(<AccessView user={OWNER} />);
    await screen.findByText("c-suite");

    fireEvent.click(screen.getByRole("button", { name: /Show personal tags \(1\)/ }));
    expect(screen.queryByText("person-gone")).not.toBeInTheDocument();
    expect(screen.queryByText("person-00000000")).not.toBeInTheDocument();
  });

  it("counts and shows only ACTIVE holders — revoked accounts don't inflate 'everyone'", async () => {
    stub([
      {
        slug: "org",
        kind: "org",
        account_id: null,
        // two ghosts: revoked accounts still holding their org-tag rows
        holders: ["acct-owner", "acct-dana", "acct-bot", "acct-ghost1", "acct-ghost2"],
      },
      { slug: "c-suite", kind: "custom", account_id: null, holders: ["acct-dana", "acct-ghost1"] },
    ]);
    render(<AccessView user={OWNER} />);
    await screen.findByText("c-suite");

    expect(screen.getByText(/everyone \(3\)/)).toBeInTheDocument();
    // the revoked holder's chip is gone too — one live holder, one remove button
    expect(screen.getByText("Dana")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
  });

  it("lets the owner create a tag and reloads the table", async () => {
    const { tagsSpy } = stub();
    const create = vi.spyOn(api, "createTag").mockResolvedValue({ ok: true });
    render(<AccessView user={OWNER} />);
    await screen.findByText("c-suite");

    fireEvent.change(screen.getByLabelText("Tag slug"), { target: { value: "us-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith("us-person"));
    // the table re-reads after the write
    await waitFor(() => expect(tagsSpy.mock.calls.length).toBeGreaterThan(1));
  });

  it("refuses a bad slug client-side — no request is made", async () => {
    stub();
    const create = vi.spyOn(api, "createTag").mockResolvedValue({ ok: true });
    render(<AccessView user={OWNER} />);
    await screen.findByText("c-suite");

    fireEvent.change(screen.getByLabelText("Tag slug"), { target: { value: "Not A Slug!" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/slug must be lowercase/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("removes a holder via the chip's × and surfaces the server's error verbatim", async () => {
    stub();
    const revoke = vi
      .spyOn(api, "revokeTag")
      .mockRejectedValue(new ApiError(400, "only the owner may govern tags"));
    render(<AccessView user={OWNER} />);
    await screen.findByText("c-suite");

    fireEvent.click(screen.getByRole("button", { name: "Remove Dana from c-suite" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("c-suite", "acct-dana"));
    expect(await screen.findByText("only the owner may govern tags")).toBeInTheDocument();
  });

  it("teaches the loop when no custom groups exist yet", async () => {
    stub([
      { slug: "org", kind: "org", account_id: null, holders: ["acct-owner"] },
      {
        slug: "olive-personal",
        kind: "personal",
        account_id: "acct-owner",
        holders: ["acct-owner"],
      },
    ]);
    render(<AccessView user={OWNER} />);
    await screen.findByText(/everyone/);
    expect(screen.getByText(/No groups yet/)).toBeInTheDocument();
  });

  it("offers a non-owner no create form and no holder management", async () => {
    stub();
    render(<AccessView user={{ ...OWNER, id: "acct-dana", name: "Dana", role: "member" }} />);
    await screen.findByText("c-suite");

    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
  });
});

describe("TAG_SLUG_RE", () => {
  it("matches the server's shape exactly", () => {
    expect(TAG_SLUG_RE.test("c-suite")).toBe(true);
    expect(TAG_SLUG_RE.test("a")).toBe(true);
    expect(TAG_SLUG_RE.test("-leading")).toBe(false);
    expect(TAG_SLUG_RE.test("Upper")).toBe(false);
    expect(TAG_SLUG_RE.test("has space")).toBe(false);
    expect(TAG_SLUG_RE.test("a".repeat(64))).toBe(false);
    expect(TAG_SLUG_RE.test("a".repeat(63))).toBe(true);
  });
});
