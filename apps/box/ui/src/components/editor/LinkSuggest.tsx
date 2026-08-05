import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Editor } from "@tiptap/core";

import { api } from "@/lib/api";
import { typeName } from "@/lib/ui";
import { TypeIcon } from "@/components/bits";
import { cn } from "@/lib/utils";
import { editorPopoverPos } from "./popoverPos";

/**
 * `[[` autocomplete: link a body to another object in the brain.
 *
 * TWO THINGS LAND, NOT ONE. Choosing a hit inserts a visible markdown link
 * (`[Title](/o/<id>)`, carried as a link MARK so the canonical serializer in
 * markdown.ts spells it) AND emits `onLink({ to, rel: "references" })` so the
 * owning view calls `api.linkObject` with a fresh idempotency key. The prose
 * link is what a reader sees; the edge is what the graph, search and the
 * object page read. A body that says "see [Acme](/o/…)" with no edge behind it
 * is a lie to every other surface, so neither half is optional.
 *
 * Hand-rolled rather than @tiptap/suggestion — that package is not a declared
 * dependency, and the trigger rule here is narrow enough to state exactly
 * (same call BlockEditor's slash menu makes). The state machine below is pure
 * and framework-free: trigger detection, debounce, abort, keyboard selection
 * and the two payloads are all testable without mounting an editor
 * (linkSuggest.test.ts), which is the point of splitting it out.
 */

/* ------------------------------------------------------- pure state machine */

export const LINK_TRIGGER = "[[";

/** Combobox wiring, mirrored from the slash menu: the editor's contenteditable
 *  points `aria-controls`/`aria-activedescendant` at these while the popover is
 *  open, so a screen-reader user whose focus never leaves the prose is still
 *  told the menu appeared and which option Enter/Tab will insert. */
const LINK_LISTBOX_ID = "editor-link-listbox";
const LINK_OPTION_PREFIX = "editor-link-opt-";

/** How many hits the popover asks for and shows. */
const LINK_RESULT_LIMIT = 8;

/** Debounce before a keystroke becomes a search. */
export const LINK_DEBOUNCE_MS = 150;

/** The relationship a `[[link]]` creates. */
const LINK_REL = "references";

/** Longest query we keep the popover open for; past this it is prose, not a search. */
const MAX_QUERY = 64;

export type LinkHit = {
  id: string;
  title: string | null;
  type?: string | null;
};

type LinkTrigger = {
  /** Text typed after `[[`. May contain single spaces — titles have them. */
  query: string;
  /** Offset of the `[` that opens the trigger, within the text handed in. */
  start: number;
};

/**
 * Read the live `[[` trigger out of the text before the caret, or null.
 *
 * Spaces are allowed (object titles have them) but TWO IN A ROW cancel: it is
 * the only signal available that the user has stopped naming a thing and gone
 * back to writing prose, and without it a stray `[[` earlier in a paragraph
 * keeps a popover open over everything typed after it. A `]` or a newline
 * cancels too — the run is closed or the block ended.
 */
export function readLinkTrigger(textBefore: string): LinkTrigger | null {
  const start = textBefore.lastIndexOf(LINK_TRIGGER);
  if (start === -1) return null;
  const query = textBefore.slice(start + LINK_TRIGGER.length);
  if (/[[\]\n]/.test(query)) return null;
  if (query.includes("  ")) return null;
  if (query.length > MAX_QUERY) return null;
  return { query, start };
}

type LinkSelection = {
  /** Visible link text (the object's title). */
  text: string;
  /** Href the link mark carries — the dashboard's own object route. */
  href: string;
  /** Canonical markdown the serializer will produce for this insert. */
  markdown: string;
  /** The graph edge the host must create alongside the visible link. */
  link: { to: string; rel: string };
};

/** Markdown link text is delimited by brackets; a title containing them must escape. */
function escapeLinkText(s: string): string {
  return s.replace(/([[\]\\])/g, "\\$1");
}

/** Both halves of choosing a hit: what to insert, and what edge to create. */
export function linkSelection(hit: LinkHit): LinkSelection {
  const text = (hit.title ?? "").trim() || "Untitled";
  const href = `/o/${hit.id}`;
  return {
    text,
    href,
    markdown: `[${escapeLinkText(text)}](${href})`,
    link: { to: hit.id, rel: LINK_REL },
  };
}

type LinkSuggestState = {
  open: boolean;
  query: string;
  loading: boolean;
  hits: LinkHit[];
  active: number;
};

const CLOSED: LinkSuggestState = { open: false, query: "", loading: false, hits: [], active: 0 };

/** Injected so tests (and the demo bundle) can stub it; see `defaultLinkSearch`. */
export type LinkSuggestSearch = (query: string, signal: AbortSignal) => Promise<LinkHit[]>;

type LinkSuggestController = {
  readonly state: LinkSuggestState;
  /** Feed the trigger read from the document; null closes. */
  update(trigger: LinkTrigger | null): void;
  /** Move the highlight; returns false when there is nothing to move. */
  move(delta: number): boolean;
  setActive(index: number): void;
  close(): void;
  /** Choose a hit (default: the active one). Returns both payloads, or null. */
  choose(index?: number): LinkSelection | null;
  destroy(): void;
};

/**
 * The suggestion state machine.
 *
 * Debounced at 150ms and ABORTING: every new query aborts the previous
 * request and bumps a sequence number, so a slow answer to "ac" can never
 * repaint the list a user has already narrowed to "acme". Dropping the stale
 * response is the part that matters for correctness; the abort is what stops
 * the box serving searches nobody will read.
 */
export function createLinkSuggest(opts: {
  search: LinkSuggestSearch;
  onState: (state: LinkSuggestState) => void;
  debounceMs?: number;
  limit?: number;
}): LinkSuggestController {
  const debounceMs = opts.debounceMs ?? LINK_DEBOUNCE_MS;
  const limit = opts.limit ?? LINK_RESULT_LIMIT;

  let state: LinkSuggestState = CLOSED;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let seq = 0;

  const emit = (patch: Partial<LinkSuggestState>): void => {
    state = { ...state, ...patch };
    opts.onState(state);
  };

  /** Drop the pending search AND invalidate any answer already on its way. */
  const cancelPending = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (inflight) {
      inflight.abort();
      inflight = null;
    }
    seq += 1;
  };

  return {
    get state() {
      return state;
    },

    update(trigger) {
      if (!trigger) {
        if (state.open || timer !== null || inflight) {
          cancelPending();
          emit({ ...CLOSED });
        }
        return;
      }
      // Caret moves and unrelated edits re-fire this; only a changed query is
      // a new search, otherwise every transaction would restart the debounce.
      if (state.open && state.query === trigger.query) return;

      cancelPending();
      const query = trigger.query;
      if (query.trim() === "") {
        // `[[` with nothing after it: open, but there is nothing to search for.
        emit({ open: true, query, loading: false, hits: [], active: 0 });
        return;
      }
      emit({ open: true, query, loading: true, active: 0 });

      const mine = seq;
      timer = setTimeout(() => {
        timer = null;
        const ac = new AbortController();
        inflight = ac;
        void opts.search(query, ac.signal).then(
          (hits) => {
            if (mine !== seq) return;
            inflight = null;
            emit({ hits: hits.slice(0, limit), loading: false, active: 0 });
          },
          () => {
            // A failed lookup is not an error the writer should be shouted at
            // for — the popover just has nothing to offer.
            if (mine !== seq) return;
            inflight = null;
            emit({ hits: [], loading: false, active: 0 });
          },
        );
      }, debounceMs);
    },

    move(delta) {
      if (!state.open || state.hits.length === 0) return false;
      const n = state.hits.length;
      emit({ active: (((state.active + delta) % n) + n) % n });
      return true;
    },

    setActive(index) {
      if (!state.open || index < 0 || index >= state.hits.length) return;
      emit({ active: index });
    },

    close() {
      cancelPending();
      emit({ ...CLOSED });
    },

    choose(index) {
      if (!state.open) return null;
      const hit = state.hits[index ?? state.active];
      if (!hit) return null;
      const selection = linkSelection(hit);
      cancelPending();
      emit({ ...CLOSED });
      return selection;
    },

    destroy() {
      cancelPending();
    },
  };
}

/**
 * The real lookup: the EXISTING search endpoint, nothing new on the box.
 * `api.search` owns its own fetch, so the signal is honoured by the controller
 * dropping the stale answer rather than by cancelling the socket.
 */
const defaultLinkSearch: LinkSuggestSearch = async (query) => {
  const hits = await api.search(query, { limit: LINK_RESULT_LIMIT });
  return hits.map((h) => ({ id: h.id, title: h.title, type: h.type }));
};

/* ----------------------------------------------------------------- editor */

/** Text before the caret in the current block, in the same shape BlockEditor reads. */
function textBeforeCaret(editor: Editor): string | null {
  const { $from, empty } = editor.state.selection;
  if (!empty) return null;
  // A `[[` inside a code block is literal content, not a link trigger.
  if ($from.parent.type.spec.code) return null;
  return $from.parent.textBetween(0, $from.parentOffset, "\n", "\0");
}

type LinkSuggestProps = {
  editor: Editor | null;
  editable?: boolean;
  /**
   * Called with the edge to create when a hit is chosen. The host mints a
   * FRESH idempotency key per call and hands it to `api.linkObject` — the key
   * belongs to the user intent, so it is minted here-ish and never reused
   * across two different `[[` picks.
   */
  onLink?: (input: { to: string; rel: string }) => void;
  /** Test/demo seam. */
  search?: LinkSuggestSearch;
  /** Positioning context; defaults to the editor's own DOM. */
  containerRef?: RefObject<HTMLElement | null>;
  debounceMs?: number;
};

export function LinkSuggest({
  editor,
  editable = true,
  onLink,
  search,
  containerRef,
  debounceMs,
}: LinkSuggestProps) {
  const [state, setState] = useState<LinkSuggestState>(CLOSED);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  /** Absolute document range of the live `[[query` run. */
  const rangeRef = useRef<{ from: number; to: number } | null>(null);

  const searchRef = useRef<LinkSuggestSearch>(search ?? defaultLinkSearch);
  const onLinkRef = useRef<LinkSuggestProps["onLink"]>(onLink);
  useEffect(() => {
    searchRef.current = search ?? defaultLinkSearch;
    onLinkRef.current = onLink;
  }, [search, onLink]);

  const controller = useMemo(
    () =>
      createLinkSuggest({
        search: (q, signal) => searchRef.current(q, signal),
        onState: setState,
        ...(debounceMs === undefined ? {} : { debounceMs }),
      }),
    [debounceMs],
  );

  useEffect(() => () => controller.destroy(), [controller]);

  /* Follow the caret: read the trigger, remember its range, place the popover. */
  useEffect(() => {
    if (!editor) return;
    const sync = (): void => {
      if (!editable || editor.isDestroyed) {
        rangeRef.current = null;
        controller.update(null);
        return;
      }
      const before = textBeforeCaret(editor);
      const trigger = before === null ? null : readLinkTrigger(before);
      if (!trigger) {
        rangeRef.current = null;
        controller.update(null);
        return;
      }
      const { $from } = editor.state.selection;
      const from = $from.pos - trigger.query.length - LINK_TRIGGER.length;
      rangeRef.current = { from, to: $from.pos };
      const box = (containerRef?.current ?? editor.view.dom).getBoundingClientRect();
      const caret = editor.view.coordsAtPos(from);
      // Clamp inside the container/viewport — a raw caret offset clips the
      // popover off the right edge in a narrow column (SidePeek, reading column).
      setPos(editorPopoverPos({ caret, box }));
      controller.update(trigger);
    };
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor, editable, controller, containerRef]);

  const apply = useCallback(
    (index?: number) => {
      const range = rangeRef.current;
      const selection = controller.choose(index);
      if (!editor || !range || !selection) return;
      rangeRef.current = null;
      // ONE chain = one undo step: the `[[query` run becomes a linked title
      // plus a plain space, so typing on does not extend the link mark.
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: "text",
            text: selection.text,
            marks: [{ type: "link", attrs: { href: selection.href } }],
          },
          { type: "text", text: " " },
        ])
        .run();
      onLinkRef.current?.(selection.link);
    },
    [editor, controller],
  );

  /**
   * Keys are taken in the CAPTURE phase on the editor's own DOM node, so the
   * popover sees arrows/enter before ProseMirror moves the caret or splits a
   * block. Doing it here rather than in the host means dropping this component
   * into an editor is the whole integration.
   */
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onKeyDown = (event: KeyboardEvent): void => {
      const s = controller.state;
      if (!s.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        controller.close();
        return;
      }
      if (s.hits.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        controller.move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        controller.move(-1);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        apply();
      }
    };
    dom.addEventListener("keydown", onKeyDown, true);
    return () => {
      dom.removeEventListener("keydown", onKeyDown, true);
    };
  }, [editor, controller, apply]);

  // Mirror the slash menu's combobox contract onto the editor's own DOM node:
  // focus stays in the prose, so the popover itself announcing nothing would
  // leave a screen-reader user unaware the menu even opened.
  const linkOpen = state.open && state.hits.length > 0;
  useEffect(() => {
    const dom = editor?.view.dom as HTMLElement | undefined;
    if (!dom) return;
    if (linkOpen) {
      dom.setAttribute("aria-expanded", "true");
      dom.setAttribute("aria-controls", LINK_LISTBOX_ID);
      dom.setAttribute("aria-haspopup", "listbox");
      dom.setAttribute("aria-activedescendant", `${LINK_OPTION_PREFIX}${state.active}`);
    } else {
      dom.removeAttribute("aria-expanded");
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-haspopup");
      dom.removeAttribute("aria-activedescendant");
    }
    return () => {
      dom.removeAttribute("aria-activedescendant");
    };
  }, [editor, linkOpen, state.active]);

  if (!state.open || state.hits.length === 0) return null;

  return (
    <div
      id={LINK_LISTBOX_ID}
      className="editor-slash"
      style={{ top: pos.top, left: pos.left }}
      role="listbox"
      aria-label="Link to an object"
    >
      {state.hits.map((hit, i) => (
        <button
          key={hit.id}
          id={`${LINK_OPTION_PREFIX}${i}`}
          type="button"
          role="option"
          aria-selected={i === state.active}
          className={cn("editor-slash-item", i === state.active && "is-active")}
          // Keep the caret: focus would collapse the range we are replacing.
          // On touch, focus follows POINTERDOWN — without that one the tap
          // dismisses the keyboard (and the docked bar) before the insert.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => controller.setActive(i)}
          onClick={() => apply(i)}
        >
          <TypeIcon type={hit.type} size={13} />
          <span className="min-w-0 flex-1 truncate">{(hit.title ?? "").trim() || "Untitled"}</span>
          {hit.type && (
            <span className="text-muted-foreground shrink-0 text-[11px]">{typeName(hit.type)}</span>
          )}
        </button>
      ))}
    </div>
  );
}
