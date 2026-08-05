import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { yCursorPluginKey } from "@tiptap/y-tiptap";

import {
  CARET_LABEL_HOLD_MS,
  buildCollabCaret,
  buildCollabSelection,
  caretPositions,
  changedRanges,
  collabCaretRenderers,
  ownerOfRange,
  stampedAgents,
} from "./AgentCursor";
import { editorExtensions } from "./markdown";
import { presenceInk } from "@/components/PresenceRail";
import { COLLAB_PALETTE_SIZE } from "@/lib/collab";

/**
 * What an agent cursor must and must not draw.
 *
 * The interesting cases are all refusals: identity is the relay's, so the two
 * ways this file could go wrong are drawing a robot for a payload the relay
 * never stamped, and drawing a NAME for one. Both are asserted directly.
 *
 * The trail's arithmetic lives in lib/collab.ts (unit-tested there); what is
 * tested here is the ProseMirror-facing half — which ranges a transaction
 * reports, and which agent caret, if any, owns one.
 */

const AGENT_ACTOR = "11111111-2222-4333-8444-555555555555";
const HUMAN_ACTOR = "99999999-8888-4777-8666-555555555555";

/** vitest runs with the SPA package as its root; the stylesheet sits beside us. */
function cssPath(): string {
  return path.join(process.cwd(), "src/components/editor/editor.css");
}

const agentUser = {
  kind: "agent",
  actorId: AGENT_ACTOR,
  name: "Claude",
  color: "presence-agent",
  glyph: "robot",
};

const humanUser = {
  kind: "human",
  actorId: HUMAN_ACTOR,
  name: "Dana Reed",
  color: "presence-3",
  glyph: "DR",
};

/* ------------------------------------------------------------------ caret */

describe("buildCollabCaret", () => {
  it("draws an agent with the robot glyph, the reserved slot and a label that stays", () => {
    const caret = buildCollabCaret(agentUser);
    expect(caret.getAttribute("data-kind")).toBe("agent");
    expect(caret.style.getPropertyValue("--collab-ink")).toBe("var(--presence-agent)");
    const label = caret.querySelector(".collab-caret-label");
    expect(label?.getAttribute("data-persistent")).toBe("true");
    expect(label?.querySelector("svg.collab-caret-glyph")).not.toBeNull();
    expect(caret.querySelector(".collab-caret-name")?.textContent).toBe("Claude");
  });

  it("draws a human with their slot, no glyph and a label that fades", () => {
    const caret = buildCollabCaret(humanUser);
    expect(caret.getAttribute("data-kind")).toBe("human");
    expect(caret.style.getPropertyValue("--collab-ink")).toBe("var(--presence-3)");
    const label = caret.querySelector(".collab-caret-label");
    expect(label?.hasAttribute("data-persistent")).toBe(false);
    expect(label?.querySelector("svg")).toBeNull();
    expect(caret.querySelector(".collab-caret-name")?.textContent).toBe("Dana Reed");
  });

  it("renders an UNSTAMPED payload anonymously — no name, no glyph, no kind", () => {
    // What a hand-rolled tiptap client publishes, and what a forgery looks like.
    for (const forged of [
      { name: "Claude", color: "#52525b" },
      { ...agentUser, color: "presence-2" },
      { ...humanUser, kind: "agent" },
      null,
      "Claude",
    ]) {
      const caret = buildCollabCaret(forged);
      expect(caret.getAttribute("data-kind")).toBe("unknown");
      expect(caret.querySelector(".collab-caret-label")).toBeNull();
      expect(caret.textContent).toBe("");
      expect(caret.style.getPropertyValue("--collab-ink")).toBe("var(--dim)");
    }
  });

  it("never lets a name become markup", () => {
    const caret = buildCollabCaret({ ...humanUser, name: "<img src=x onerror=1>" });
    expect(caret.querySelector("img")).toBeNull();
    expect(caret.querySelector(".collab-caret-name")?.textContent).toContain("<img");
  });

  it("hands the two builders to CollaborationCaret under the names it wants", () => {
    const renderers = collabCaretRenderers();
    expect(typeof renderers.render).toBe("function");
    expect(typeof renderers.selectionRender).toBe("function");
    expect(renderers.render(agentUser).getAttribute("data-kind")).toBe("agent");
  });
});

describe("buildCollabSelection", () => {
  it("tints the band with the stamped slot, and mutes an unstamped one", () => {
    expect(buildCollabSelection(agentUser)).toEqual({
      class: "collab-selection",
      style: "--collab-ink: var(--presence-agent)",
      "data-kind": "agent",
    });
    expect(buildCollabSelection({ name: "Claude" })).toMatchObject({
      style: "--collab-ink: var(--dim)",
      "data-kind": "unknown",
    });
  });
});

/* ---------------------------------------------------------------- palette */

describe("the presence palette", () => {
  it("agrees, slot for slot, with the rail's inks in both skins", () => {
    // editor.css is where the caret gets its colour and PresenceRail.tsx is
    // where the avatar gets its; a drift between them would show the same peer
    // in two colours on one screen.
    const css = readFileSync(cssPath(), "utf8");
    const darkAt = css.indexOf(':root[data-theme="dark"]');
    expect(darkAt).toBeGreaterThan(0);
    const light = css.slice(0, darkAt);
    const dark = css.slice(darkAt);

    const read = (block: string, token: string): string | undefined =>
      new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1];

    const tokens = ["presence-agent"];
    for (let i = 1; i <= COLLAB_PALETTE_SIZE; i += 1) tokens.push(`presence-${i}`);
    for (const token of tokens) {
      expect(read(light, token)).toBe(presenceInk(token, "light"));
      expect(read(dark, token)).toBe(presenceInk(token, "dark"));
    }
  });

  it("holds a human's label for the documented moment before fading it", () => {
    const css = readFileSync(cssPath(), "utf8");
    expect(css).toContain(`${CARET_LABEL_HOLD_MS}ms forwards`);
    // …and never fades the agent's while it is here.
    expect(css).toContain('.collab-caret-label[data-persistent="true"]');
    // The trail is created only when motion is welcome; this is the floor.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.collab-trail/);
  });

  it("under reduced motion a human's label lands hidden, uncovering the identity dot", () => {
    const css = readFileSync(cssPath(), "utf8");
    const reduceAt = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(reduceAt).toBeGreaterThan(0);
    const reduce = css.slice(reduceAt);
    // `animation: none` alone would freeze the label fully OPEN — a permanent
    // name flag covering the dot for exactly the users who asked for calm. The
    // reduce block must jump it to the fade's end state instead…
    expect(reduce).toMatch(/\.collab-caret-label\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*0/);
    // …while an agent's persistent label (which has no dot beneath it) stays.
    expect(reduce).toMatch(/\.collab-caret-label\[data-persistent="true"\]\s*\{[^}]*opacity:\s*1/);
  });
});

/* ------------------------------------------------------------------ trail */

const schema = getSchema(editorExtensions());

function stateWith(text: string): EditorState {
  return EditorState.create({
    doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]),
  });
}

describe("changedRanges", () => {
  it("reports an insertion in the coordinates of the doc it produced", () => {
    const state = stateWith("hello world");
    const tr = state.tr.insertText("XY", 6);
    expect(changedRanges(tr)).toEqual([{ from: 6, to: 8 }]);
  });

  it("carries an early range forward through the steps that follow it", () => {
    const state = stateWith("hello world");
    // Two edits in one transaction; the first one's coordinates move.
    const tr = state.tr.insertText("!", 12).insertText("ABC", 1);
    const ranges = changedRanges(tr);
    expect(ranges).toHaveLength(2);
    expect(ranges[1]).toEqual({ from: 1, to: 4 });
    // "!" landed at 12 and is pushed right by the three characters inserted
    // ahead of it.
    expect(ranges[0]).toEqual({ from: 15, to: 16 });
  });

  it("gives a pure deletion an empty range — there is nothing left to highlight", () => {
    const state = stateWith("hello world");
    const tr = state.tr.delete(1, 6);
    expect(changedRanges(tr)).toEqual([{ from: 1, to: 1 }]);
  });
});

describe("stampedAgents", () => {
  it("lists only peers the relay stamped as agents", () => {
    const states = new Map<number, Record<string, unknown> | null | undefined>([
      [1, { user: agentUser }],
      [2, { user: humanUser }],
      // a client claiming to be an agent without the stamp
      [3, { user: { ...agentUser, actorId: "claude" } }],
      [4, { user: { name: "Claude", color: "#52525b" } }],
      [5, null],
    ]);
    const agents = stampedAgents({ getStates: () => states });
    expect([...agents.keys()]).toEqual([1]);
    expect(agents.get(1)).toBe("presence-agent");
  });

  it("is empty, never throwing, when there is no awareness at all", () => {
    expect(stampedAgents(null).size).toBe(0);
    expect(
      stampedAgents({
        getStates: () => {
          throw new Error("socket died mid-read");
        },
      }).size,
    ).toBe(0);
  });
});

describe("caretPositions", () => {
  it("reads the cursor plugin's keyed widgets, and only for the clients asked for", () => {
    const state = stateWith("hello world");
    const decorations = DecorationSet.create(state.doc, [
      Decoration.widget(4, () => document.createElement("span"), { key: "1", side: 10 }),
      Decoration.widget(8, () => document.createElement("span"), { key: "2", side: 10 }),
      // the selection band carries no client id — it must not be mistaken for one
      Decoration.inline(2, 6, { class: "collab-selection" }),
    ]);
    // `PluginKey.getState` reads `state[key]`; installing the real cursor
    // plugin would need a live provider, so the same slot is filled directly.
    const key = (yCursorPluginKey as unknown as { key: string }).key;
    (state as unknown as Record<string, unknown>)[key] = decorations;

    expect(caretPositions(state, new Set([1]))).toEqual([{ clientId: 1, pos: 4 }]);
    expect(
      caretPositions(state, new Set([1, 2]))
        .map((c) => c.pos)
        .sort((a, b) => a - b),
    ).toEqual([4, 8]);
    expect(caretPositions(state, new Set([9]))).toEqual([]);
  });

  it("is empty when the cursor plugin is not installed", () => {
    expect(caretPositions(stateWith("hello"), new Set([1]))).toEqual([]);
  });
});

describe("ownerOfRange", () => {
  const carets = [
    { clientId: 1, pos: 12 },
    { clientId: 2, pos: 40 },
  ];

  it("attributes a range to the caret sitting in it", () => {
    expect(ownerOfRange({ from: 10, to: 20 }, carets)?.clientId).toBe(1);
    expect(ownerOfRange({ from: 38, to: 44 }, carets)?.clientId).toBe(2);
  });

  it("allows one position of slack — a replacement collapses onto the boundary", () => {
    expect(ownerOfRange({ from: 13, to: 20 }, carets)?.clientId).toBe(1);
    expect(ownerOfRange({ from: 5, to: 11 }, carets)?.clientId).toBe(1);
  });

  it("attributes nothing when no agent is near — a human's edit gets no trail", () => {
    expect(ownerOfRange({ from: 20, to: 30 }, carets)).toBeNull();
    expect(ownerOfRange({ from: 10, to: 20 }, [])).toBeNull();
  });
});
