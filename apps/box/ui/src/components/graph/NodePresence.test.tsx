import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_BADGES_PER_NODE,
  NodePresenceLayer,
  clusterPresence,
  nodePeerCaption,
  type NodePresenceEngineLike,
  type NodePresenceLayerProps,
} from "./NodePresence";
import { TooltipProvider } from "../ui/tooltip";
import type { RoutePeer } from "../../lib/routePresence";

/**
 * What these pin is the layer's PRIVACY CONTRACT and its projection, not its
 * pixels:
 *
 *  - a presence entry the server resolved no object for draws NOTHING — no
 *    ghost badge, no "somewhere else" pile (the rail is where that person is);
 *  - a presence entry naming an object this client has no node for draws
 *    NOTHING, and above all not at a placeholder position: the relay already
 *    intersected per recipient, and a badge at the graph's centre would hand
 *    back exactly what the intersection prevented;
 *  - a badge rides on ITS node — positioned from `worldToScreen` plus the
 *    node's screen radius — and leaves when the socket does (empty peers);
 *  - an agent is the same code path as a person, with the robot mark;
 *  - one badge per (actor, node): two tabs on one object collapse, one actor on
 *    two objects does not.
 */

const A = "11111111-2222-4333-8444-555555555555";
const B = "66666666-7777-4888-8999-aaaaaaaaaaaa";
/** never handed to the store — the object this viewer cannot see. */
const HIDDEN = "99999999-8888-4777-8666-555555555555";

const peer = (over: Partial<RoutePeer> & { clientId: string }): RoutePeer => ({
  kind: "human",
  actorId: `a-${over.clientId}`,
  name: `Peer ${over.clientId}`,
  color: "presence-2",
  glyph: "P",
  position: {},
  ...over,
});

const robot = (over: Partial<RoutePeer> & { clientId: string }): RoutePeer => ({
  kind: "agent",
  actorId: "a-claude",
  name: "Claude",
  color: "presence-agent",
  glyph: "robot",
  position: {},
  ...over,
});

/** ids the client actually holds: A at index 0, B at index 1. HIDDEN is absent. */
const INDEX_OF = (id: string): number | undefined => (id === A ? 0 : id === B ? 1 : undefined);

/** node 0 at world (10, 20) with radius 8; node 1 at world (−40, 0), radius 4. */
function makeEngine(): NodePresenceEngineLike {
  return {
    revision: 1,
    nodes: [{ title: "Acme Corp" }, { title: null }],
    indexOf: INDEX_OF,
    renderer: {
      positions: () => new Float32Array([10, 20, -40, 0]),
      radiusAt: (i: number) => (i === 0 ? 8 : 4),
      getCamera: () => ({ x: 0, y: 0, scale: 2 }),
      size: () => ({ width: 800, height: 600 }),
      // the same maths as renderer.worldToScreen under the camera above
      worldToScreen: (x: number, y: number) => ({ x: x * 2 + 400, y: y * 2 + 300 }),
      // No live render loop in jsdom — placement runs from the synchronous
      // `place()` in the layout effect; the subscription is a no-op here.
      onFrameTick: () => () => undefined,
    },
  };
}

function draw(props: Partial<NodePresenceLayerProps> & { peers: readonly RoutePeer[] }) {
  return render(
    <TooltipProvider>
      <NodePresenceLayer engine={makeEngine()} {...props} />
    </TooltipProvider>,
  );
}

describe("clusterPresence", () => {
  it("drops a peer the server resolved no object for", () => {
    expect(clusterPresence([peer({ clientId: "1" })], INDEX_OF)).toEqual([]);
  });

  it("drops a peer whose object this client has no node for — no placeholder", () => {
    const clusters = clusterPresence([peer({ clientId: "1", objectId: HIDDEN })], INDEX_OF);
    // Not a cluster at index -1, not a cluster at 0, not anything.
    expect(clusters).toEqual([]);
  });

  it("keeps the visible ones and drops the hidden one from the same frame", () => {
    const clusters = clusterPresence(
      [
        peer({ clientId: "1", objectId: A }),
        peer({ clientId: "2", objectId: HIDDEN }),
        peer({ clientId: "3", objectId: B }),
      ],
      INDEX_OF,
    );
    expect(clusters.map((c) => c.index)).toEqual([0, 1]);
    expect(clusters.flatMap((c) => c.peers.map((p) => p.clientId))).toEqual(["1", "3"]);
  });

  it("collapses one actor's several tabs on the SAME node to one badge", () => {
    const clusters = clusterPresence(
      [
        peer({ clientId: "tab-1", actorId: "a-dana", objectId: A }),
        peer({ clientId: "tab-2", actorId: "a-dana", objectId: A }),
      ],
      INDEX_OF,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.peers.map((p) => p.clientId)).toEqual(["tab-1"]);
  });

  it("keeps one actor on TWO nodes as two badges — that is the picture", () => {
    const clusters = clusterPresence(
      [robot({ clientId: "c1", objectId: A }), robot({ clientId: "c2", objectId: B })],
      INDEX_OF,
    );
    expect(clusters.map((c) => c.index)).toEqual([0, 1]);
    expect(clusters.every((c) => c.peers.length === 1)).toBe(true);
  });

  it("caps a node's badges and keeps the rest as overflow", () => {
    const many = ["1", "2", "3", "4", "5"].map((n) => peer({ clientId: n, objectId: A }));
    const [cluster] = clusterPresence(many, INDEX_OF, 2);
    expect(cluster?.peers).toHaveLength(2);
    expect(cluster?.overflow.map((p) => p.clientId)).toEqual(["3", "4", "5"]);
  });

  it("defaults the cap to MAX_BADGES_PER_NODE and never below one", () => {
    const many = Array.from({ length: 6 }, (_, i) => peer({ clientId: String(i), objectId: A }));
    expect(clusterPresence(many, INDEX_OF)[0]?.peers).toHaveLength(MAX_BADGES_PER_NODE);
    expect(clusterPresence(many, INDEX_OF, 0)[0]?.peers).toHaveLength(1);
  });

  it("orders clusters by dense index, so the DOM order is stable", () => {
    const clusters = clusterPresence(
      [peer({ clientId: "1", objectId: B }), peer({ clientId: "2", objectId: A })],
      INDEX_OF,
    );
    expect(clusters.map((c) => c.index)).toEqual([0, 1]);
  });
});

describe("nodePeerCaption", () => {
  it("names the object, and the viewer's own badge says so", () => {
    expect(nodePeerCaption(peer({ clientId: "1" }), "Acme Corp", false)).toBe(
      "Peer 1 — editing Acme Corp",
    );
    expect(nodePeerCaption(peer({ clientId: "1" }), "Acme Corp", true)).toBe(
      "Peer 1 (you) — editing Acme Corp",
    );
  });

  it("gives the agent a sentence of its own", () => {
    expect(nodePeerCaption(robot({ clientId: "c1" }), "Acme Corp", false)).toBe(
      "Claude is editing Acme Corp",
    );
  });
});

describe("<NodePresenceLayer>", () => {
  it("renders nothing when the socket is down (no peers)", () => {
    const { container } = draw({ peers: [] });
    expect(container.querySelector("[data-slot='graph-node-presence']")).toBeNull();
  });

  it("renders nothing at all for an object this viewer cannot see", () => {
    const { container } = draw({ peers: [peer({ clientId: "1", objectId: HIDDEN })] });
    expect(container.querySelector("[data-slot='graph-node-presence']")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // and nothing that could hint at it, either
    expect(container.textContent ?? "").toBe("");
  });

  it("draws one badge on the node being edited, captioned with the title", () => {
    const { container } = draw({ peers: [peer({ clientId: "1", objectId: A })] });
    expect(screen.getByLabelText("Peer 1 — editing Acme Corp")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-slot='graph-node-presence-cluster']")).toHaveLength(1);
  });

  it("positions the cluster from worldToScreen, above the node's screen radius", () => {
    const { container } = draw({ peers: [peer({ clientId: "1", objectId: A })] });
    const cluster = container.querySelector<HTMLElement>(
      "[data-slot='graph-node-presence-cluster']",
    );
    // node 0 is world (10, 20) → screen (420, 340); radius 8 at scale 2 = 16px,
    // so the row sits 16 + 6 above it.
    expect(cluster?.style.transform).toBe("translate3d(420px, 318px, 0) translate(-50%, -100%)");
  });

  it("hides a cluster whose node has no position yet rather than guessing one", () => {
    const engine = makeEngine();
    const blank: NodePresenceEngineLike = {
      ...engine,
      renderer: {
        ...engine.renderer!,
        positions: () => new Float32Array([Number.NaN, Number.NaN]),
      },
    };
    const { container } = render(
      <TooltipProvider>
        <NodePresenceLayer engine={blank} peers={[peer({ clientId: "1", objectId: A })]} />
      </TooltipProvider>,
    );
    const cluster = container.querySelector<HTMLElement>(
      "[data-slot='graph-node-presence-cluster']",
    );
    expect(cluster?.style.visibility).toBe("hidden");
    expect(cluster?.style.transform).toBe("");
  });

  it("draws the agent through the same path, with the robot mark", () => {
    const { container } = draw({ peers: [robot({ clientId: "c1", objectId: A })] });
    const badge = screen.getByLabelText("Claude is editing Acme Corp");
    expect(badge).toHaveAttribute("data-kind", "agent");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders no engine layer when the canvas never started", () => {
    const engine = makeEngine();
    const { container } = render(
      <TooltipProvider>
        <NodePresenceLayer
          engine={{ ...engine, renderer: null }}
          peers={[peer({ clientId: "1", objectId: A })]}
        />
      </TooltipProvider>,
    );
    expect(container.querySelector("[data-slot='graph-node-presence']")).toBeNull();
  });

  it("is a button only when a click handler exists, and hands back index + id", () => {
    const onSelect = vi.fn();
    draw({ peers: [peer({ clientId: "1", objectId: B })], onSelect });
    fireEvent.click(screen.getByLabelText("Peer 1 — editing 66666666"));
    expect(onSelect).toHaveBeenCalledWith(1, B);
  });

  it("is not a link without a handler — nothing to open, nothing to imply", () => {
    draw({ peers: [peer({ clientId: "1", objectId: A })] });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByLabelText("Peer 1 — editing Acme Corp").tagName).toBe("SPAN");
  });

  it("collapses past the cap into a +N chip that still names everybody", () => {
    draw({
      peers: ["1", "2", "3", "4"].map((n) => peer({ clientId: n, objectId: A })),
      max: 2,
    });
    expect(screen.getByLabelText("2 more")).toBeInTheDocument();
  });

  it("marks the viewer's own badge", () => {
    draw({
      peers: [peer({ clientId: "1", actorId: "a-me", objectId: A })],
      selfActorId: "a-me",
    });
    expect(screen.getByLabelText("Peer 1 (you) — editing Acme Corp")).toBeInTheDocument();
  });
});
