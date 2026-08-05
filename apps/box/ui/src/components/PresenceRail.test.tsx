import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  PresenceRail,
  dedupePeers,
  peerCaption,
  presenceInk,
  presenceSummary,
} from "./PresenceRail";
import { TooltipProvider } from "./ui/tooltip";
import type { RoutePeer, RoutePresenceCounts } from "../lib/routePresence";

/**
 * What these pin is the rail's CONTRACT with the relay, not its pixels:
 *
 *  - nothing on screen when the socket is down (empty peers) — not a spinner,
 *    not the last roster we happened to have;
 *  - an avatar is a link ONLY when the server resolved an object for this
 *    viewer; with no object there is no button at all, because a disabled one
 *    would confirm that something is there;
 *  - the summary reads the relay's counts, which were computed after the
 *    per-recipient intersection;
 *  - overflow collapses to "+N" without dropping anybody from the count.
 */

const OBJ = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const robot = (over: Partial<RoutePeer> & { clientId: string }): RoutePeer => ({
  kind: "agent",
  actorId: "a-claude",
  name: "Claude",
  color: "presence-agent",
  glyph: "robot",
  position: {},
  ...over,
});

const peer = (over: Partial<RoutePeer> & { clientId: string }): RoutePeer => ({
  kind: "human",
  actorId: `a-${over.clientId}`,
  name: `Peer ${over.clientId}`,
  color: "presence-2",
  glyph: "P",
  position: {},
  ...over,
});

const counts = (over: Partial<RoutePresenceCounts> = {}): RoutePresenceCounts => ({
  people: 0,
  agents: 0,
  objects: 0,
  objectsByActor: {},
  ...over,
});

function draw(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/t/deal"]}>
      <TooltipProvider>{ui}</TooltipProvider>
    </MemoryRouter>,
  );
}

/** The peek store IS the URL, so this is how the default open is observed. */
function Url() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function drawWithUrl(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/t/deal"]}>
      <TooltipProvider>{ui}</TooltipProvider>
      <Url />
    </MemoryRouter>,
  );
}

describe("PresenceRail", () => {
  it("renders nothing at all when the socket is down", () => {
    const { container } = draw(<PresenceRail peers={[]} counts={null} label="Deals" />);
    expect(container.textContent).toBe("");
    expect(container.querySelector("[data-slot='presence-rail']")).toBeNull();
  });

  it("draws one avatar per peer and says how many are here", () => {
    draw(
      <PresenceRail
        peers={[peer({ clientId: "c1", name: "Dana" }), peer({ clientId: "c2", name: "Sam" })]}
        counts={counts({ people: 2 })}
        label="Deals"
      />,
    );
    expect(screen.getByLabelText("Dana")).toBeTruthy();
    expect(screen.getByLabelText("Sam")).toBeTruthy();
    expect(screen.getByText("2 people viewing Deals")).toBeTruthy();
  });

  it("collapses the tail into +N", () => {
    draw(
      <PresenceRail
        peers={["c1", "c2", "c3", "c4", "c5"].map((clientId) => peer({ clientId }))}
        counts={counts({ people: 5 })}
        label="Deals"
        max={3}
      />,
    );
    expect(screen.getByLabelText("2 more")).toBeTruthy();
    expect(screen.queryByLabelText("Peer c4")).toBeNull();
    // Nobody is lost from the count just because they are not drawn.
    expect(screen.getByText("5 people viewing Deals")).toBeTruthy();
  });

  it("opens the object the server resolved for this viewer", () => {
    const onOpenObject = vi.fn();
    draw(
      <PresenceRail
        peers={[peer({ clientId: "c1", name: "Dana", objectId: OBJ })]}
        counts={counts({ people: 1, objects: 1, objectsByActor: { "a-c1": 1 } })}
        label="Deals"
        onOpenObject={onOpenObject}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onOpenObject.mock.calls).toEqual([[OBJ]]);
  });

  it("is not clickable when the server sent no object — and says nothing about it", () => {
    draw(
      <PresenceRail
        peers={[peer({ clientId: "c1", name: "Dana" })]}
        counts={counts({ people: 1 })}
        label="Deals"
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    // No "hidden", no "private", no lock — the rail cannot hint that anything
    // is there, because it does not know and must not guess.
    const rail = document.querySelector("[data-slot='presence-rail']");
    expect(rail?.textContent).not.toMatch(/private|hidden|cannot/i);
  });

  it("names the actor, and marks the viewer as themselves", () => {
    draw(
      <PresenceRail
        peers={[peer({ clientId: "c1", name: "Dana", actorId: "me" })]}
        counts={counts({ people: 1 })}
        selfActorId="me"
        label="Deals"
      />,
    );
    expect(screen.getByLabelText("Dana (you)")).toBeTruthy();
  });

  it("counts the agent separately from the people", () => {
    draw(
      <PresenceRail
        peers={[
          peer({ clientId: "c1", name: "Dana" }),
          peer({
            clientId: "c2",
            name: "Claude",
            kind: "agent",
            color: "presence-agent",
            glyph: "robot",
          }),
        ]}
        counts={counts({ people: 1, agents: 1 })}
        label="Deals"
      />,
    );
    expect(screen.getByText("1 person and 1 agent viewing Deals")).toBeTruthy();
  });

  it("skips the summary when the relay sent no counts", () => {
    draw(<PresenceRail peers={[peer({ clientId: "c1" })]} counts={null} />);
    expect(document.querySelector("[data-slot='presence-summary']")).toBeNull();
  });

  it("opens a resolvable entry in side-peek, keeping the table underneath", () => {
    // Not a navigation: "go and look at what Claude is doing" must not throw
    // away the view, its filters or its scroll position.
    drawWithUrl(
      <PresenceRail
        peers={[robot({ clientId: "c1", objectId: OBJ })]}
        counts={counts({ agents: 1, objects: 1, objectsByActor: { "a-claude": 1 } })}
        label="Deals"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("url").textContent).toBe(`/t/deal?peek=${OBJ}`);
  });
});

describe("PresenceRail — the agent is a peer like any other", () => {
  it("draws the robot glyph and the reserved slot, and says so to a reader", () => {
    draw(
      <PresenceRail
        peers={[peer({ clientId: "c1", name: "Dana" }), robot({ clientId: "c2" })]}
        counts={counts({ people: 1, agents: 1 })}
        label="Deals"
      />,
    );
    const claude = screen.getByLabelText("Claude");
    expect(claude.getAttribute("data-kind")).toBe("agent");
    // A machine is marked as a machine by more than its colour.
    expect(claude.querySelector("svg")).toBeTruthy();
    expect((claude as HTMLElement).style.borderStyle).toBe("dashed");
    expect(screen.getByLabelText("Dana").getAttribute("data-kind")).toBe("human");
    expect(screen.getByLabelText("Dana").querySelector("svg")).toBeNull();
    expect(screen.getByText("1 person and 1 agent viewing Deals")).toBeTruthy();
  });

  it("names the agent and its per-viewer object count on hover", () => {
    draw(
      <PresenceRail
        peers={[robot({ clientId: "c1", objectId: OBJ })]}
        counts={counts({ agents: 1, objects: 3, objectsByActor: { "a-claude": 3 } })}
        label="Deals"
      />,
    );
    expect(screen.getByLabelText("Claude is editing 3 objects in Deals")).toBeTruthy();
  });

  it("collapses one robot's several cursors into one avatar, count intact", () => {
    // The relay sends one state per CURSOR — a robot part-way through a table
    // holds several. Three identical robots in a row would say something false;
    // the COUNT is where "3 objects" lives, and it comes from the server.
    draw(
      <PresenceRail
        peers={[
          robot({ clientId: "c1", objectId: OBJ }),
          robot({ clientId: "c2", objectId: OTHER }),
          peer({ clientId: "c3", name: "Dana", actorId: "a-dana" }),
        ]}
        counts={counts({ people: 1, agents: 1, objects: 2, objectsByActor: { "a-claude": 2 } })}
        label="Deals"
      />,
    );
    expect(screen.getAllByLabelText(/Claude/)).toHaveLength(1);
    expect(screen.getByLabelText("Claude is editing 2 objects in Deals")).toBeTruthy();
    expect(screen.getByLabelText("Dana")).toBeTruthy();
    expect(screen.queryByLabelText(/more/)).toBeNull();
  });

  it("says nothing at all about an agent the server sent without an object", () => {
    // The relay drops such an entry outright; if one ever arrives, the rail
    // draws a robot that cannot be clicked and volunteers nothing.
    draw(
      <PresenceRail
        peers={[robot({ clientId: "c1" })]}
        counts={counts({ agents: 1, objectsByActor: { "a-claude": 4 } })}
        label="Deals"
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByLabelText("Claude")).toBeTruthy();
    const rail = document.querySelector("[data-slot='presence-rail']");
    expect(rail?.textContent).not.toMatch(/private|hidden|4/i);
  });
});

describe("dedupePeers", () => {
  it("keeps one entry per actor and prefers the one that can be opened", () => {
    const first = robot({ clientId: "c1" });
    const second = robot({ clientId: "c2", objectId: OBJ });
    const third = robot({ clientId: "c3", objectId: OTHER });
    const kept = dedupePeers([first, second, third]);
    expect(kept).toEqual([second]);
    // Order is the relay's, and an actor holds the position of its first state.
    const dana = peer({ clientId: "c4", name: "Dana", actorId: "a-dana" });
    expect(dedupePeers([first, dana, second]).map((p) => p.actorId)).toEqual([
      "a-claude",
      "a-dana",
    ]);
  });
});

describe("presenceSummary", () => {
  it("gets the plurals right and falls back to 'here' without a label", () => {
    expect(presenceSummary(counts({ people: 1 }), "Deals")).toBe("1 person viewing Deals");
    expect(presenceSummary(counts({ people: 3 }), "Deals")).toBe("3 people viewing Deals");
    expect(presenceSummary(counts({ people: 2 }), null)).toBe("2 people here");
    expect(presenceSummary(counts({ agents: 2 }), "Deals")).toBe("2 agents viewing Deals");
    expect(presenceSummary(counts(), "Deals")).toBe("");
  });
});

describe("peerCaption", () => {
  const dana = peer({ clientId: "c1", name: "Dana", actorId: "a1" });

  it("is just the name when the server resolved no object", () => {
    expect(peerCaption(dana, counts({ people: 1, objectsByActor: { a1: 3 } }), false)).toBe("Dana");
    // Including for the agent: the figure exists, the object does not, and a
    // caption that used it would announce a write this viewer may not see.
    expect(
      peerCaption(robot({ clientId: "c2" }), counts({ objectsByActor: { "a-claude": 3 } }), false),
    ).toBe("Claude");
  });

  it("uses the relay's own per-actor figure when it did", () => {
    const withObject = { ...dana, objectId: OBJ };
    expect(peerCaption(withObject, counts({ objectsByActor: { a1: 3 } }), false)).toBe(
      "Dana — editing 3 objects here",
    );
    expect(peerCaption(withObject, counts({ objectsByActor: { a1: 1 } }), true)).toBe(
      "Dana (you) — open in the editor",
    );
    expect(peerCaption(withObject, counts({ objectsByActor: { a1: 2 } }), false, "Deals")).toBe(
      "Dana — editing 2 objects in Deals",
    );
  });

  it("gives the agent a sentence of its own", () => {
    const claude = robot({ clientId: "c2", objectId: OBJ });
    expect(peerCaption(claude, counts({ objectsByActor: { "a-claude": 3 } }), false, "Deals")).toBe(
      "Claude is editing 3 objects in Deals",
    );
    expect(peerCaption(claude, counts({ objectsByActor: { "a-claude": 1 } }), false)).toBe(
      "Claude is editing one object here",
    );
  });
});

describe("presenceInk — the wire carries a theme token, not a colour", () => {
  it("resolves a slot per skin and never returns undefined", () => {
    expect(presenceInk("presence-1", "light")).not.toBe(presenceInk("presence-1", "dark"));
    expect(presenceInk("presence-agent", "dark")).toBeTruthy();
    // An unknown token is muted, never a crash and never a random colour.
    expect(presenceInk("presence-99", "light")).toBe(presenceInk("presence-agent", "light"));
    expect(presenceInk("#ff0000", "light")).toBeTruthy();
  });
});
