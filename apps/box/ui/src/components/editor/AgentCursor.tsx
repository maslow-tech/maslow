/**
 * AGENT CURSORS — the robot you can watch, drawn ONLY from the server's stamp.
 *
 * Phase 2 gave the editor remote carets: `CollaborationCaret` renders one
 * widget per peer from that peer's awareness `user` field. This module is the
 * phase-5 half of it — everything that makes an AGENT read as an agent rather
 * than as one more anonymous coloured bar:
 *
 *  - the robot glyph and the reserved `presence-agent` palette slot;
 *  - a name label that PERSISTS while the agent is active (a human's label
 *    fades after a moment — a person is at their keyboard for hours, a robot is
 *    there for a second and a half and you want to know whose it is);
 *  - a subtle trailing highlight over the range it just rewrote, decaying over
 *    ~1.5s, so a reader sees WHAT changed and not merely that something did.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE RULES, ALL OF THEM ABOUT WHAT THIS FILE MAY NOT DO
 *
 * 1. **Identity comes from the relay or it does not come at all.** Every field
 *    this module draws — kind, name, colour, glyph — is read through
 *    `readPeerIdentity` (lib/collab.ts), which refuses anything outside the
 *    vocabulary `apps/box/src/collab/presence.ts` stamps. An unparseable or
 *    half-stamped payload renders as an ANONYMOUS caret: no name, no glyph, a
 *    muted ink. It is never guessed at, and a client-authored `kind` never
 *    reaches the screen — otherwise "Claude wrote this" is a claim any browser
 *    in the room could make.
 *
 * 2. **Colour is a theme token, never an ink.** The relay stamps `presence-3`
 *    or `presence-agent`; the two skins decide what that looks like, in CSS
 *    (`editor.css`, mirroring `PresenceRail.PRESENCE_INK` — a unit test pins
 *    them together). Nothing here reads the theme, so switching skins repaints
 *    carets without rebuilding the editor.
 *
 * 3. **A cursor is information; the trail is motion.** Carets always render,
 *    for viewers included — this is a read surface and it writes nothing. The
 *    trailing highlight is decoration, so it is gated on
 *    `prefers-reduced-motion` and simply does not exist when a viewer asked
 *    their operating system not to be shown movement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WIRE CONTRACT THIS EXPECTS
 *
 * A doc room's y-protocols awareness carries, per client, `{ user, cursor }` —
 * `user` holding the relay's stamp (`apps/box/src/collab/presence.ts`
 * `PresenceIdentity`: kind, actorId, name, colour SLOT, glyph) and `cursor`
 * holding y-prosemirror's relative anchor/head. An agent is a SYNTHETIC
 * awareness client published server-side for the length of one external write
 * (`createAgentPresence`), which is why nothing here has an agent-specific
 * transport: a robot's position is the same kind of fact as a person's.
 *
 * One known wart: y-tiptap validates `user.color` as `#RRGGBB` and logs a
 * console warning for anything else, so a palette SLOT trips it. The slot is
 * the doctrine (the server may not choose an ink for two skins it cannot see);
 * the warning is cosmetic and is not worth trading that for.
 *
 * Design invariant: agent cursors are visible collaborators.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { DecorationAttrs } from "@tiptap/pm/view";
import { ySyncPluginKey, yCursorPluginKey } from "@tiptap/y-tiptap";

import {
  AGENT_TRAIL_MAX,
  AGENT_TRAIL_MS,
  addTrailMark,
  pruneTrail,
  readPeerIdentity,
  type CollabPeerIdentity,
  type EditTrailMark,
} from "@/lib/collab";

/* ========================================================================== *
 * The caret                                                                   *
 * ========================================================================== */

/** How long a HUMAN's label sits before it fades (CSS owns the fade itself). */
export const CARET_LABEL_HOLD_MS = 2_400;

/** The ink for a payload we could not read as a stamp. Muted, and nameless. */
const ANONYMOUS_INK = "var(--dim)";

/** `presence-3` → `var(--presence-3)`. The token is validated before it lands. */
function inkVar(identity: CollabPeerIdentity | null): string {
  return identity ? `var(--${identity.color})` : ANONYMOUS_INK;
}

/** First letter of a peer's name, for the persistent human identity dot.
 *  Iterated by code point, not UTF-16 unit, so a name that begins with an emoji
 *  or astral character (e.g. "🦊 Fox") yields a whole grapheme rather than a
 *  lone surrogate that renders as a broken glyph. */
function initialOf(name: string): string {
  const ch = Array.from(name.trim())[0];
  return ch ? ch.toUpperCase() : "•";
}

/** lucide `bot`, the same mark the presence rail draws for `glyph === "robot"`. */
const ROBOT_PATHS = ["M12 8V4H8", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"] as const;

function robotGlyph(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "collab-caret-glyph");
  const body = document.createElementNS(ns, "rect");
  body.setAttribute("width", "16");
  body.setAttribute("height", "12");
  body.setAttribute("x", "4");
  body.setAttribute("y", "8");
  body.setAttribute("rx", "2");
  svg.appendChild(body);
  for (const d of ROBOT_PATHS) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Build one remote caret.
 *
 * `user` is the peer's awareness payload, i.e. whatever arrived over the wire.
 * It is READ, never trusted: everything drawn comes back out of
 * `readPeerIdentity`, and a refusal produces the anonymous caret rather than a
 * plausible-looking stranger.
 */
export function buildCollabCaret(user: unknown): HTMLElement {
  const identity = readPeerIdentity(user);
  const caret = document.createElement("span");
  caret.className = "collab-caret";
  caret.setAttribute("data-kind", identity?.kind ?? "unknown");
  caret.style.setProperty("--collab-ink", inkVar(identity));
  // A caret is drawn over somebody else's text; it must never eat their clicks.
  caret.setAttribute("aria-hidden", "true");

  // No stamp ⇒ no label. A bar with no name is honest; a bar with a name we
  // could not verify is the forgery this whole module exists to refuse.
  if (!identity) return caret;

  // The label sits ON the ink, so it needs a foreground picked for that ink's
  // luminance — the companion `--presence-<slot>-on` token (editor.css), never a
  // hardcoded white that goes illegible on the bright slots.
  caret.style.setProperty("--collab-fg", `var(--${identity.color}-on)`);

  const label = document.createElement("span");
  label.className = "collab-caret-label";
  // The agent's label persists while it is here (see the header); a person's
  // fades. CSS keys off the attribute so the behaviour is one selector, not a
  // timer we would have to cancel.
  if (identity.kind === "agent") label.setAttribute("data-persistent", "true");
  if (identity.kind === "agent") label.appendChild(robotGlyph());

  const name = document.createElement("span");
  name.className = "collab-caret-name";
  // createTextNode, not innerHTML: the name is server-sanitized already, and
  // this keeps it that way no matter what the relay is asked to stamp next.
  name.appendChild(document.createTextNode(identity.name));
  label.appendChild(name);
  caret.appendChild(label);

  // A human's full name label gets out of the way after a moment (they are at
  // the keyboard for hours) — but "whose selection is this" must still be
  // answerable at a static glance, or the flagship collaboration surface reads
  // as single-player. So a human keeps a small PERSISTENT identity dot (their
  // initial, in their hue) once the name has faded. An agent already carries a
  // persistent glyph label, so it needs no dot.
  if (identity.kind !== "agent") {
    const dot = document.createElement("span");
    dot.className = "collab-caret-dot";
    dot.setAttribute("data-persistent", "true");
    dot.setAttribute("aria-hidden", "true");
    dot.appendChild(document.createTextNode(initialOf(identity.name)));
    caret.appendChild(dot);
  }
  return caret;
}

/** The selection band behind a remote caret's range. Same token, softer. */
export function buildCollabSelection(user: unknown): DecorationAttrs {
  const identity = readPeerIdentity(user);
  return {
    class: "collab-selection",
    style: `--collab-ink: ${inkVar(identity)}`,
    "data-kind": identity?.kind ?? "unknown",
  };
}

/**
 * The two builders `CollaborationCaret.configure` wants, in one object.
 *
 * `render`/`selectionRender` are called by y-tiptap's cursor plugin with
 * `(user, clientId)`; the clientId is deliberately unused — it is an awareness
 * transport number, not an identity, and nothing on screen may be derived from
 * it.
 */
export function collabCaretRenderers(): {
  render: (user: Record<string, unknown>) => HTMLElement;
  selectionRender: (user: Record<string, unknown>) => DecorationAttrs;
} {
  return { render: buildCollabCaret, selectionRender: buildCollabSelection };
}

/* ========================================================================== *
 * The trail                                                                   *
 * ========================================================================== */

/** The awareness surface the trail needs: who is here, as the relay stamped it. */
interface TrailAwareness {
  getStates(): Map<number, Record<string, unknown> | null | undefined>;
}

/** A peer whose caret is currently on screen, in document coordinates. */
interface CaretPosition {
  readonly clientId: number;
  readonly pos: number;
}

/**
 * The agents in the room, `clientId → colour token`.
 *
 * Only peers whose awareness payload survives `readPeerIdentity` as an agent
 * are here, so a browser publishing `{kind:"agent"}` by hand is absent and its
 * edits get no trail — the same refusal the caret makes, applied to the
 * decoration.
 */
export function stampedAgents(awareness: TrailAwareness | null): Map<number, string> {
  const out = new Map<number, string>();
  if (!awareness || typeof awareness.getStates !== "function") return out;
  let states: Map<number, Record<string, unknown> | null | undefined>;
  try {
    states = awareness.getStates();
  } catch {
    // Presence is a nicety; it may never be the reason someone cannot type.
    return out;
  }
  states.forEach((state, clientId) => {
    if (!state || typeof state !== "object") return;
    const identity = readPeerIdentity((state as { user?: unknown }).user);
    if (!identity || identity.kind !== "agent") return;
    out.set(clientId, identity.color);
  });
  return out;
}

/**
 * Where the given clients' carets sit, read from the cursor plugin's own
 * decorations.
 *
 * y-tiptap draws one WIDGET decoration per remote caret, keyed by awareness
 * clientId (`Decoration.widget(head, …, { key: String(clientId) })`), and a
 * separate inline decoration for the selection band. The widget's key is the
 * discriminator: it is the only one that carries a client id, and reading it
 * beats re-deriving absolute positions from relative ones — the plugin already
 * did that work, correctly, for this exact document state.
 */
export function caretPositions(state: EditorState, clients: ReadonlySet<number>): CaretPosition[] {
  const set = yCursorPluginKey.getState(state) as DecorationSet | undefined;
  if (!set || typeof set.find !== "function") return [];
  const out: CaretPosition[] = [];
  for (const deco of set.find()) {
    const key = (deco.spec as { key?: unknown } | undefined)?.key;
    if (typeof key !== "string") continue;
    const clientId = Number(key);
    if (!Number.isInteger(clientId) || !clients.has(clientId)) continue;
    out.push({ clientId, pos: deco.from });
  }
  return out;
}

/**
 * The ranges a transaction touched, in the coordinates of the document it
 * produced.
 *
 * Each step map reports its change in the coordinates of the doc that step
 * produced, so every range is carried forward through the maps that follow it —
 * a two-step transaction whose first change sits before its second would
 * otherwise highlight the wrong text. A step that only deletes yields an empty
 * range and is dropped downstream: there is nothing left to highlight.
 */
export function changedRanges(tr: Transaction): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const maps = tr.mapping.maps;
  for (let i = 0; i < maps.length; i += 1) {
    const rest = tr.mapping.slice(i + 1);
    maps[i]?.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      out.push({ from: rest.map(newFrom, -1), to: rest.map(newTo, 1) });
    });
  }
  return out;
}

/**
 * Which caret, if any, owns a changed range.
 *
 * The server moves an agent's cursor ONTO the range immediately before applying
 * the chunk (`apps/box/src/collab/animate.ts`), so "the agent's caret is in the
 * range that just changed" is the contract, not a guess — and a remote change
 * nowhere near any agent caret gets NO trail rather than being attributed to
 * whichever robot happens to be in the room. One position of slack: a
 * replacement collapses the caret onto the boundary of the range it replaced.
 */
export function ownerOfRange(
  range: { from: number; to: number },
  carets: readonly CaretPosition[],
): CaretPosition | null {
  for (const caret of carets) {
    if (caret.pos >= range.from - 1 && caret.pos <= range.to + 1) return caret;
  }
  return null;
}

/** A live runtime's motion preference. No matchMedia ⇒ motion is fine. */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

interface AgentTrailOptions {
  /** the collab provider; only its `awareness` is read. */
  provider: { awareness?: unknown } | null;
  ttlMs: number;
  max: number;
  now: () => number;
  /** injected by tests; live code asks the OS every time it matters. */
  reducedMotion: () => boolean;
}

interface TrailState {
  readonly marks: readonly EditTrailMark[];
  readonly deco: DecorationSet;
}

const agentTrailKey = new PluginKey<TrailState>("brainAgentTrail");

function buildDecorations(doc: EditorState["doc"], marks: readonly EditTrailMark[]): DecorationSet {
  if (marks.length === 0) return DecorationSet.empty;
  const size = doc.content.size;
  const decorations = marks
    .filter((mark) => mark.from < mark.to && mark.to <= size)
    .map((mark) =>
      Decoration.inline(mark.from, mark.to, {
        class: "collab-trail",
        // The token was validated by `readPeerIdentity` before it got here, so
        // it can only ever be `presence-agent` or `presence-<n>`.
        style: `--collab-ink: var(--${mark.color})`,
      }),
    );
  return DecorationSet.create(doc, decorations);
}

function awarenessOf(provider: { awareness?: unknown } | null): TrailAwareness | null {
  const awareness = provider?.awareness;
  if (!awareness || typeof awareness !== "object") return null;
  const candidate = awareness as TrailAwareness;
  return typeof candidate.getStates === "function" ? candidate : null;
}

/**
 * The trailing highlight, as a ProseMirror plugin.
 *
 * Attribution runs on REMOTE transactions only (`ySyncPluginKey`'s
 * `isChangeOrigin`) — your own typing is not somebody else's afterimage — and
 * only for clients the relay stamped as agents. Everything the decoration needs
 * beyond that is arithmetic, and the arithmetic lives in lib/collab.ts under
 * unit test.
 */
export const AgentTrail = Extension.create<AgentTrailOptions>({
  name: "agentTrail",

  addOptions() {
    return {
      provider: null,
      ttlMs: AGENT_TRAIL_MS,
      max: AGENT_TRAIL_MAX,
      now: () => Date.now(),
      reducedMotion: prefersReducedMotion,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin<TrailState>({
        key: agentTrailKey,

        state: {
          init: () => ({ marks: [], deco: DecorationSet.empty }),

          apply(tr, prev, oldState, newState): TrailState {
            const now = options.now();
            const before = prev.marks;
            // Marks follow the text they mark: an insertion above must not
            // leave a highlight sitting over the wrong paragraph.
            let marks: EditTrailMark[] = pruneTrail(
              before.map((mark) => ({
                ...mark,
                from: tr.mapping.map(mark.from, -1),
                to: tr.mapping.map(mark.to, 1),
              })),
              now,
              options.ttlMs,
            );
            let added = false;

            const remote = ySyncPluginKey.getState(newState)?.isChangeOrigin === true;
            if (tr.docChanged && remote && !options.reducedMotion()) {
              const agents = stampedAgents(awarenessOf(options.provider));
              if (agents.size > 0) {
                // Caret positions are read from the doc BEFORE the change (the
                // agent moved there first) and carried into the new doc.
                const carets = caretPositions(oldState, new Set(agents.keys())).map((caret) => ({
                  clientId: caret.clientId,
                  pos: tr.mapping.map(caret.pos, 1),
                }));
                for (const range of changedRanges(tr)) {
                  if (range.to <= range.from) continue;
                  const owner = ownerOfRange(range, carets);
                  const color = owner ? agents.get(owner.clientId) : undefined;
                  if (!owner || color === undefined) continue;
                  marks = addTrailMark(
                    marks,
                    { clientId: owner.clientId, from: range.from, to: range.to, at: now, color },
                    { now, ttlMs: options.ttlMs, max: options.max },
                  );
                  added = true;
                }
              }
            }

            // Nothing moved, nothing expired, nothing arrived: keep the object
            // identity so ProseMirror can skip the decoration diff entirely.
            if (!added && !tr.docChanged && marks.length === before.length) return prev;
            return { marks, deco: buildDecorations(newState.doc, marks) };
          },
        },

        props: {
          decorations(state): DecorationSet | undefined {
            return agentTrailKey.getState(state)?.deco;
          },
        },

        /**
         * Marks expire on a clock, and ProseMirror only recomputes state when a
         * transaction arrives — so one is scheduled for the moment the oldest
         * mark dies. The dispatch carries no steps and changes nothing but this
         * plugin's own state; when the last mark goes, so does the timer.
         */
        view(view) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let destroyed = false;
          const schedule = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            if (destroyed) return;
            const marks = agentTrailKey.getState(view.state)?.marks ?? [];
            if (marks.length === 0) return;
            let oldest = Number.POSITIVE_INFINITY;
            for (const mark of marks) oldest = Math.min(oldest, mark.at);
            const delay = Math.max(16, oldest + options.ttlMs - options.now());
            timer = setTimeout(() => {
              timer = undefined;
              if (destroyed) return;
              view.dispatch(view.state.tr.setMeta(agentTrailKey, "prune"));
            }, delay);
          };
          schedule();
          return {
            update: schedule,
            destroy(): void {
              destroyed = true;
              if (timer !== undefined) clearTimeout(timer);
              timer = undefined;
            },
          };
        },
      }),
    ];
  },
});
