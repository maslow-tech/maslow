import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { ObjectView } from "./ObjectView";
import {
  api,
  ApiError,
  type AudienceTag,
  type BrainObject,
  type History,
  type Member,
  type TagRow,
  type Whoami,
} from "../lib/api";

/**
 * The object page's SHARING surface (tag governance, wave 3): the audience
 * renders as chip rows, and the share sheet submits exactly the vocabulary the
 * member picked — tag slugs and member EMAILS, never account ids. Everything
 * heavy on this page (TipTap, the live room, the local graph) is exercised by
 * its own tests; here it is stubbed so these assertions are about the sheet.
 */

// TipTap is exercised by BlockEditor's own tests; a textarea stands in, exactly
// as SidePeek's tests do.
vi.mock("../components/editor/BlockEditor", () => ({
  BlockEditor: ({
    value,
    onChange,
    onBlur,
    ariaLabel,
  }: {
    value: string;
    onChange?: (md: string) => void;
    onBlur?: () => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? "Body"}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      onBlur={onBlur}
    />
  ),
}));

// No live room in these tests: body/title stay on the CAS queue.
vi.mock("../lib/useCollab", () => ({
  useCollabRoom: () => null,
  useCollabTitle: () => () => false,
}));

// The rail's canvas mount — pixels, not sharing.
vi.mock("../components/LocalGraph", () => ({ LocalGraph: () => null }));

const member: Whoami = {
  id: "acct-1",
  name: "Alice",
  role: "member",
  scopes: ["read", "write"],
  status: "active",
};

const object = (over: Partial<BrainObject> = {}): BrainObject => ({
  id: "obj-1",
  type: null,
  title: "Board packet",
  body: "the body",
  version: 4,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  deleted_at: null,
  visibility: "private",
  props: {},
  links: [],
  backlinks: [],
  links_truncated: false,
  backlinks_truncated: false,
  hidden_from_you: 0,
  ...over,
});

const history: History = { id: "obj-1", versions: [], events: [] };

const TAGS: TagRow[] = [
  { slug: "org", kind: "org", account_id: null, holders: ["acct-1", "acct-2", "acct-bot"] },
  { slug: "c-suite", kind: "custom", account_id: null, holders: ["acct-1"] },
  { slug: "us-person", kind: "custom", account_id: null, holders: ["acct-2"] },
  { slug: "alice-personal", kind: "personal", account_id: "acct-1", holders: ["acct-1"] },
];

const MEMBERS: Member[] = [
  {
    id: "acct-2",
    name: "Dana",
    role: "member",
    status: "active",
    scopes: ["read", "write"],
    email: "dana@co.example",
  },
  {
    // HISTORICAL service account (the feature that minted these is gone, but
    id: "acct-bot",
    name: "Legacy Service",
    role: "member",
    status: "active",
    scopes: ["read", "write"],
    email: "bot@co.example",
  },
];

/** The viewer's own personal-tag audience row, as the server labels it — the
 *  bare governor row every restricted object keeps. */
const AUD_YOU: AudienceTag[] = [
  { slug: "alice-personal", label: "Alice", kind: "personal", you: true, governor: true },
];

/** A shared state: governor row + a group AND-row + a person row (share
 *  compiles rows as [who-entry, ...require]). */
const AUD_SHARED: AudienceTag[][] = [
  AUD_YOU,
  [
    { slug: "c-suite", label: "c-suite", kind: "custom" },
    { slug: "us-person", label: "us-person", kind: "custom" },
  ],
  [
    { slug: "dana-personal", label: "Dana", kind: "personal", email: "dana@co.example" },
    { slug: "us-person", label: "us-person", kind: "custom" },
  ],
];

function stub(over: Partial<BrainObject> = {}) {
  const objectSpy = vi.spyOn(api, "object").mockResolvedValue(object(over));
  vi.spyOn(api, "history").mockResolvedValue(history);
  vi.spyOn(api, "types").mockResolvedValue([]);
  vi.spyOn(api, "tags").mockResolvedValue({ tags: TAGS });
  vi.spyOn(api, "members").mockResolvedValue(MEMBERS);
  const share = vi.spyOn(api, "shareObject").mockResolvedValue({ id: "obj-1", version: 5 });
  return { objectSpy, share };
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/o/obj-1"]}>
      <Routes>
        <Route path="/o/:id" element={<ObjectView user={member} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("<ObjectView /> audience", () => {
  it("renders the audience as HUMAN chips — 'only you', names, slugs joined with +", async () => {
    stub({
      audience: [
        AUD_YOU,
        [
          { slug: "c-suite", label: "c-suite", kind: "custom" },
          { slug: "us-person", label: "us-person", kind: "custom" },
        ],
        [{ slug: "dana-personal", label: "Dana", kind: "personal" }],
        [{ slug: "org", label: "everyone", kind: "org" }],
      ],
    });
    mount();

    const chips = await screen.findByLabelText("Audience");
    // the viewer's own personal row reads as "only you", never a raw slug
    expect(within(chips).getByText("only you")).toBeInTheDocument();
    expect(within(chips).queryByText("alice-personal")).not.toBeInTheDocument();
    // an AND-row of custom tags keeps slugs, readably joined
    expect(within(chips).getByText("c-suite + us-person")).toBeInTheDocument();
    // someone else's personal row is their NAME; org reads as everyone
    expect(within(chips).getByText("only Dana")).toBeInTheDocument();
    expect(within(chips).getByText("everyone")).toBeInTheDocument();
    // the raw slugs survive in the tooltip for debugging
    expect(within(chips).getByText("only you")).toHaveAttribute(
      "title",
      "visible to holders of: alice-personal",
    );
  });

  it("shows no audience chips on a pre-migration object", async () => {
    stub();
    mount();
    await screen.findByText("the body");
    expect(screen.queryByLabelText("Audience")).not.toBeInTheDocument();
  });

  it("the badge reads 'shared' once the audience extends beyond the governor", async () => {
    stub({ audience: AUD_SHARED });
    mount();
    await screen.findByText("the body");
    expect(screen.getByText("shared")).toBeInTheDocument();
    expect(screen.queryByText("private")).not.toBeInTheDocument();
  });

  it("the badge reads 'private' while only the governor row exists", async () => {
    stub({ audience: [AUD_YOU] });
    mount();
    await screen.findByText("the body");
    expect(screen.getByText("private")).toBeInTheDocument();
  });
});

describe("<ObjectView /> share sheet", () => {
  it("opens PRE-FILLED with the current audience — share edits, never silently replaces", async () => {
    stub({ audience: AUD_SHARED });
    mount();
    await screen.findByText("the body");

    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    const who = await screen.findByRole("group", { name: "Who" });
    const require = screen.getByRole("group", { name: "Require" });
    // the group row's head and the person row's head are pre-picked…
    expect(within(who).getByRole("button", { name: "c-suite" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(who).getByRole("button", { name: "Dana" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // …the shared require tail is pre-picked…
    expect(within(require).getByRole("button", { name: "us-person" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // …and the governor's bare row is NOT offered as a pick.
    expect(within(who).getByRole("button", { name: "org" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("'Make private again' resets the audience with one click", async () => {
    const { share } = stub({ audience: AUD_SHARED });
    mount();
    await screen.findByText("the body");

    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    await screen.findByRole("group", { name: "Who" });
    fireEvent.click(screen.getByRole("button", { name: "Make private again" }));
    await waitFor(() => expect(share).toHaveBeenCalledWith("obj-1", { who: [], require: [] }));
    expect(await screen.findByText("Now private ✓")).toBeInTheDocument();
  });

  it("a fully private object offers no reset — just says so", async () => {
    stub({ audience: [AUD_YOU] });
    mount();
    await screen.findByText("the body");

    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    await screen.findByRole("group", { name: "Who" });
    expect(screen.queryByRole("button", { name: "Make private again" })).not.toBeInTheDocument();
    expect(screen.getByText("Only you can see this now.")).toBeInTheDocument();
  });

  it("submits the picked who/require, then re-reads the object", async () => {
    const { objectSpy, share } = stub({ audience: [AUD_YOU] });
    mount();
    await screen.findByText("the body");

    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));

    // WHO offers group tags AND members (by name); REQUIRE offers custom only.
    const who = await screen.findByRole("group", { name: "Who" });
    const require = screen.getByRole("group", { name: "Require" });
    expect(within(who).getByRole("button", { name: "org" })).toBeInTheDocument();
    expect(within(require).queryByRole("button", { name: "org" })).not.toBeInTheDocument();

    fireEvent.click(within(who).getByRole("button", { name: "c-suite" }));
    fireEvent.click(within(who).getByRole("button", { name: "Dana" }));
    fireEvent.click(within(require).getByRole("button", { name: "us-person" }));
    expect(within(who).getByRole("button", { name: "c-suite" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const reads = objectSpy.mock.calls.length;
    // While the popover is up there are two "Share" buttons (trigger + submit)
    // — the submit is the one inside the sheet, the LAST match.
    const buttons = screen.getAllByRole("button", { name: /^Share$/ });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith("obj-1", {
        who: ["c-suite", "dana@co.example"],
        require: ["us-person"],
      }),
    );
    // …and the page re-reads the object so the new audience shows.
    await waitFor(() => expect(objectSpy.mock.calls.length).toBeGreaterThan(reads));
  });

  it("hands governance over — picking a transferee joins WHO and submits transfer_to", async () => {
    const { share } = stub({ audience: [AUD_YOU] });
    mount();
    await screen.findByText("the body");

    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    const transfer = await screen.findByRole("group", { name: "Transfer governance to" });
    // Every active member is a candidate governor. The picker used to hide
    // service accounts; 0059 retired the last of them, so there is no longer a
    // class of member the server would refuse here.
    expect(within(transfer).getByRole("button", { name: "Legacy Service" })).toBeInTheDocument();

    fireEvent.click(within(transfer).getByRole("button", { name: "Dana" }));
    // auto-included in WHO so the new governor can see the object
    const who = screen.getByRole("group", { name: "Who" });
    expect(within(who).getByRole("button", { name: "Dana" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const buttons = screen.getAllByRole("button", { name: /^Share$/ });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith("obj-1", {
        who: ["dana@co.example"],
        require: [],
        transfer_to: "dana@co.example",
      }),
    );
  });

  it("clears a picked transferee on a second click — no transfer_to submitted", async () => {
    const { share } = stub({ audience: [AUD_YOU] });
    mount();
    await screen.findByText("the body");

    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    const transfer = await screen.findByRole("group", { name: "Transfer governance to" });
    fireEvent.click(within(transfer).getByRole("button", { name: "Dana" }));
    fireEvent.click(within(transfer).getByRole("button", { name: "Dana" }));
    expect(within(transfer).getByRole("button", { name: "Dana" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const buttons = screen.getAllByRole("button", { name: /^Share$/ });
    fireEvent.click(buttons[buttons.length - 1]!);
    // Dana stays in WHO (the pick added them; unpicking transfer keeps the share)
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith("obj-1", { who: ["dana@co.example"], require: [] }),
    );
  });

  it("surfaces the server's refusal verbatim inside the sheet", async () => {
    const { share } = stub({ audience: [AUD_YOU] });
    share.mockRejectedValue(
      new ApiError(400, "only the creator may change an object's visibility or sharing"),
    );
    mount();
    await screen.findByText("the body");

    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    await screen.findByRole("group", { name: "Who" });
    const buttons = screen.getAllByRole("button", { name: /^Share$/ });
    fireEvent.click(buttons[buttons.length - 1]!);

    expect(
      await screen.findByText("only the creator may change an object's visibility or sharing"),
    ).toBeInTheDocument();
  });
});
