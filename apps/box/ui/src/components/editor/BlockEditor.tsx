import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Editor, Extensions } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Heading2, Link2, List, ListTodo, Plus, Quote } from "lucide-react";
import type * as Y from "yjs";

import { editorExtensions, getMarkdown } from "./markdown";
import { AgentTrail, collabCaretRenderers } from "./AgentCursor";
import { LINK_TRIGGER, LinkSuggest } from "./LinkSuggest";
import type { LinkSuggestSearch } from "./LinkSuggest";
import { editorPopoverPos } from "./popoverPos";
import { COLLAB_BODY_FIELD } from "@/lib/collab";
import { cn } from "@/lib/utils";
import "./editor.css";

/**
 * The block editor.
 *
 * CONTROLLED and PURE by default: it takes markdown in, hands markdown back,
 * and does nothing else — no fetch, no save queue, no autosave timer. The
 * owning view decides when a change becomes a write. Keeping the network out of
 * here is what lets the round-trip test in markdown.test.ts be the whole
 * correctness story for content fidelity.
 *
 * Markdown is canonical at rest, so `value` is the truth and TipTap is a lens
 * over it. Every emitted string goes through the same serializer the test
 * pins, which means what you see here is what the box stores.
 *
 * COLLAB MODE (`collab` supplied) inverts exactly that one relationship: the
 * Y.Doc becomes the truth and `value`/`onChange` go quiet. See the prop's
 * comment — the two modes must never run at once, or the same edit lands twice.
 */

type BlockEditorProps = {
  /** Markdown body. The editor re-seeds whenever this diverges from its own output. */
  value: string;
  editable?: boolean;
  /** Called with canonical markdown on every document change. */
  onChange?: (md: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  /** Test/embed seam: rendered inside the editor's positioning context. */
  ariaLabel?: string;
  /**
   * Sink for the graph edge a `[[link]]` creates. Supplying it is what TURNS
   * `[[` AUTOCOMPLETE ON — without a sink the popover could only insert a
   * visible link with no edge behind it, which is the one outcome LinkSuggest
   * exists to prevent. The host mints a fresh idempotency key per call (the
   * key belongs to the user intent) and calls `api.linkObject`.
   */
  onLink?: (input: { to: string; rel: string }) => void;
  /** Test/demo seam handed straight to LinkSuggest; defaults to `api.search`. */
  linkSearch?: LinkSuggestSearch;
  /**
   * Live-room binding (phase 2). Supplying it switches the editor from
   * "markdown in, markdown out" to "the CRDT is the document":
   *
   *  - `value` is IGNORED and no re-seed runs. Re-seeding a collaborative doc
   *    from a markdown prop would replay the whole body as fresh insertions on
   *    every render and duplicate it for every other participant.
   *  - `onChange` is NOT called. Body/title travel over the socket, and the CAS
   *    save queue is suspended for them (lib/collab.ts) — a queue fed from here
   *    would land the same edit twice, once via CAS→bridge and once via the
   *    Yjs merge, with no way for Yjs to know they are the same text.
   *  - StarterKit's local undo/redo is disabled: the Collaboration extension
   *    ships a Yjs-aware history, and two histories over one document undo each
   *    other's remote edits.
   *
   * `provider` is only needed for remote carets; it may be null while the
   * socket is down (the editor stays fully usable — the Y.Doc is the offline
   * buffer). `user` labels OUR caret for everyone else; the SERVER stamps the
   * identity that peers actually render, so nothing here is trusted.
   */
  collab?: {
    doc: Y.Doc;
    provider?: { awareness?: unknown } | null;
    user?: { name: string; color: string };
  };
};

/* -------------------------------------------------------------- slash menu */

type SlashCommand = {
  id: string;
  label: string;
  /** Extra words that should match this command; the label is always searched. */
  keywords: string;
  hint: string;
  run: (editor: Editor) => void;
};

/**
 * The block palette. `run` receives an editor whose slash query has ALREADY
 * been deleted, so each command is just "turn this block into X".
 */
const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "h1",
    label: "Heading 1",
    keywords: "h1 title large",
    hint: "#",
    run: (e) => e.chain().focus().setNode("heading", { level: 1 }).run(),
  },
  {
    id: "h2",
    label: "Heading 2",
    keywords: "h2 subtitle medium",
    hint: "##",
    run: (e) => e.chain().focus().setNode("heading", { level: 2 }).run(),
  },
  {
    id: "h3",
    label: "Heading 3",
    keywords: "h3 small",
    hint: "###",
    run: (e) => e.chain().focus().setNode("heading", { level: 3 }).run(),
  },
  {
    id: "bullet",
    label: "Bulleted list",
    keywords: "ul unordered dash point",
    hint: "-",
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: "ordered",
    label: "Numbered list",
    keywords: "ol number ordered",
    hint: "1.",
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "todo",
    label: "To-do list",
    // "todo" must be spelled out: the label is hyphenated, so a substring
    // search for the word every user actually types would otherwise miss.
    keywords: "todo task checkbox check",
    hint: "[ ]",
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: "quote",
    label: "Quote",
    keywords: "blockquote cite",
    hint: ">",
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "code",
    label: "Code block",
    keywords: "pre fence snippet",
    hint: "```",
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: "image",
    label: "Image",
    keywords: "img picture photo media",
    hint: "!",
    // The schema carries images (markdown.ts); the palette is just how you
    // reach one without pasting markdown. The URL is collected by the editor's
    // OWN inline popover (BlockEditor intercepts this id in runCommand /
    // runBlock), NEVER window.prompt: a native modal renders in neither skin,
    // blocks the main thread — freezing collab presence and carets mid-session
    // for every peer — and was the one native-browser dialog in the product.
    run: (e) => e.chain().focus().run(),
  },
  {
    id: "table",
    label: "Table",
    keywords: "grid rows columns",
    hint: "▦",
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: "divider",
    label: "Divider",
    keywords: "hr rule separator line",
    hint: "---",
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
];

/**
 * Match on WORD PREFIXES, not raw substrings.
 *
 * A plain `includes` reads far too much into a short query: "ul" is inside
 * "rule", so typing `/ul` offered Divider alongside Bulleted list. Two-letter
 * queries are exactly the common case for this menu, so the loose matcher is
 * wrong precisely where it is used most. Splitting on non-word characters also
 * makes the hyphen in "To-do" a boundary, so `/do` finds it.
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) =>
    `${c.label} ${c.keywords}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((word) => word.startsWith(q)),
  );
}

/**
 * The live slash query, or null when the menu should be closed.
 *
 * Deliberately NOT @tiptap/suggestion: that package is not a declared
 * dependency, and the rule here is narrow enough to state exactly. A slash
 * opens the menu only at the start of an empty-ish paragraph or after
 * whitespace, so `and/or` in prose never pops a block palette. The query stops
 * at the first space — `/code block` is a search for "code", not an escape
 * hatch into free text.
 *
 * Brackets close the query too, which is what keeps this menu and LinkSuggest
 * MUTUALLY EXCLUSIVE: `/foo[[bar` is a link trigger, not a slash query. Both
 * popovers take Enter in the capture phase, so if both could be open at once a
 * single Enter would run a block command AND insert a link.
 */
export function readSlashQueryFromText(textBefore: string): string | null {
  const match = /(?:^|\s)\/([^\s/[\]]*)$/.exec(textBefore);
  if (!match) return null;
  return match[1] ?? "";
}

/* ------------------------------------------------- touch + the keyboard */

/**
 * Height of the docked formatting bar. Named here AND in editor.css (which
 * cannot read a TS constant); the caret-visibility maths below is the reason
 * it has to be a number — "how much of the screen is not the keyboard" is
 * `visualViewport.height` minus exactly this.
 */
const MOBILE_TOOLBAR_H = 44;

/** Breathing room kept between the caret and whatever is about to cover it. */
const CARET_MARGIN = 12;

/**
 * Ignore anything smaller than this when reading the keyboard's height. On iOS
 * and Chrome-Android the visual viewport also shrinks by a few dozen pixels
 * when the URL bar expands, and treating that as "the keyboard is up" would
 * make the toolbar hop around while someone merely scrolls.
 */
const KEYBOARD_FLOOR = 96;

/**
 * How many pixels of the LAYOUT viewport the on-screen keyboard is covering.
 *
 * `position: fixed` is laid out against the layout viewport, not the visual
 * one, so a bar at `bottom: 0` sits UNDER the keyboard on every phone. The
 * difference between the two viewports is the keyboard (plus browser chrome,
 * hence the floor), and lifting the bar by exactly that much is what docks it.
 *
 * Pure and exported: this is the whole mobile-editor geometry, and it is the
 * one part of it that can be tested without a layout engine.
 */
export function keyboardInset(
  viewport: { height: number; offsetTop: number } | null | undefined,
  innerHeight: number,
): number {
  if (!viewport) return 0;
  const covered = innerHeight - (viewport.height + viewport.offsetTop);
  if (!Number.isFinite(covered) || covered < KEYBOARD_FLOOR) return 0;
  return Math.round(covered);
}

/**
 * The nearest ancestor that actually scrolls, or null for "the window does".
 *
 * The editor never owns its own scroll container — ObjectView, the side peek
 * and the demo harness each put it somewhere different — so the only honest
 * way to move the caret is to find whoever is scrolling and move THEM.
 */
function scrollableAncestor(el: Element | null): Element | null {
  let node: Element | null = el;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const overflow = `${style.overflowY} ${style.overflow}`;
    if (/(auto|scroll|overlay)/.test(overflow) && node.scrollHeight > node.clientHeight)
      return node;
    node = node.parentElement;
  }
  return null;
}

const COARSE_QUERY = "(pointer: coarse)";

/** Stable ids so the editor surface can point aria-controls at the slash listbox
 *  and aria-activedescendant at the highlighted option. */
const SLASH_LISTBOX_ID = "editor-slash-listbox";
const SLASH_OPTION_PREFIX = "editor-slash-opt-";

/**
 * Pointer-primary probe, watched live (a 2-in-1 changes it by folding).
 *
 * A runtime with no `matchMedia` (jsdom, some webviews) is treated as a MOUSE —
 * the frame that has always shipped. Guessing touch would replace the hover
 * affordances with a docked bar for someone who has a trackpad.
 */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(COARSE_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(COARSE_QUERY);
    const onChange = (): void => setCoarse(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

/** Live keyboard height. Off entirely when we are not on a touch surface. */
function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = (): void => setInset(keyboardInset(vv, window.innerHeight));
    sync();
    // `scroll` matters as much as `resize`: iOS scrolls the visual viewport
    // (offsetTop) to reveal a focused field instead of resizing it.
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [enabled]);
  useEffect(() => {
    if (!enabled) setInset(0);
  }, [enabled]);
  return inset;
}

function readSlashQuery(editor: Editor): { query: string; from: number } | null {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty) return null;
  // Code blocks are literal text; a slash there is content, not a command.
  if ($from.parent.type.spec.code) return null;

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, "\n", "\0");
  const query = readSlashQueryFromText(textBefore);
  if (query === null) return null;
  // Position of the "/" itself, in absolute document coordinates.
  const from = $from.pos - query.length - 1;
  return { query, from };
}

/* ------------------------------------------------------------------ editor */

export function BlockEditor({
  value,
  editable = true,
  onChange,
  onBlur,
  placeholder,
  className,
  ariaLabel,
  onLink,
  linkSearch,
  collab,
}: BlockEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * The last markdown this editor produced. A controlled component whose value
   * round-trips through a serializer cannot compare `value` to itself — the
   * parent almost always echoes our own output back, and re-seeding on that
   * echo would reset the cursor on every keystroke. So we compare against what
   * we last EMITTED and re-seed only on a genuinely foreign value.
   */
  const lastEmitted = useRef(value);

  /**
   * What this editor serializes the CURRENT `value` to — which is not always
   * `value` itself. The parser leaves some inline punctuation literal that the
   * serializer escapes (`~$120k` → `\~$120k`, and the same for a stray `*` or
   * `[`), so seeding a stored body can produce markdown that differs from it
   * without anybody typing.
   *
   * That matters because TipTap dispatches transactions of its own on mount
   * (the menu plugins position themselves), and each one reaches `onUpdate`.
   * Emitting there handed the host a body that differed from the one it loaded,
   * the save queue read it as an edit, and merely OPENING an object wrote a
   * version and an audit event in the reader's name — with a backslash added to
   * their prose (found 2026-07-26 via the graph view, fixed alongside the
   * server-side twin in apps/box/src/collab/serialize.ts's `canonicalMarkdown`).
   *
   * So: an emission that equals this is not an edit. A real keystroke always
   * moves the text away from it, and an edit that lands back on it needs no
   * save by definition.
   */
  const seeded = useRef<string | null>(null);

  const [slash, setSlash] = useState<{
    query: string;
    from: number;
    top: number;
    left: number;
  } | null>(null);
  const [active, setActive] = useState(0);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  /** The currently-highlighted slash option's button, so arrow-key navigation
   *  can keep it in view (the list scrolls past ~7 of 11 commands). */
  const activeOptionRef = useRef<HTMLButtonElement | null>(null);

  /* Touch mode. `focused` gates the docked bar: a formatting bar pinned over a
     document nobody is editing is just a smaller document. */
  const coarse = useCoarsePointer();
  const [focused, setFocused] = useState(false);
  const touch = coarse && editable;
  const keyboard = useKeyboardInset(touch && focused);
  const [blockSheet, setBlockSheet] = useState(false);

  const collabDoc = collab?.doc ?? null;
  const collabProvider = collab?.provider ?? null;
  const collabUserName = collab?.user?.name ?? "";
  const collabUserColor = collab?.user?.color ?? "";

  // Read the provider through a ref, NEVER as a `useMemo` dependency. `provider`
  // toggles object→null→object on every ordinary socket drop/resync (see
  // collab.ts `snapshot`: `provider: status === "live" ? provider : null`),
  // independent of any Y.Doc change. If it were a dep, TipTap's `useEditor`
  // would destroy and rebuild the entire ProseMirror view TWICE per reconnect —
  // once when the provider nulls on the drop, once when it returns — discarding
  // the caret, focus and mid-keystroke selection for a blip that changed nothing
  // about the content. A box self-update drops every open socket fleet-wide, so
  // this fired for every member with a document open. The Y.Doc identity, by
  // contrast, changes only on a genuine sync (handleSynced swaps `doc = next`),
  // and THAT rebuild is unavoidable and coincides with the provider returning
  // live — so reading the latest provider off the ref at rebuild time re-adds
  // the caret exactly when the doc-swap rebuild happens anyway, while a lone
  // provider→null drop no longer rebuilds at all.
  const collabProviderRef = useRef(collabProvider);
  collabProviderRef.current = collabProvider;

  const extensions = useMemo((): Extensions => {
    const base = editorExtensions(placeholder === undefined ? {} : { placeholder });
    if (!collabDoc) return base;
    // Re-configure (not re-declare) StarterKit: `configure` merges over the
    // options markdown.ts already set, so the link/codeBlock decisions there
    // survive while the local undo/redo history steps aside for Yjs's.
    const withoutHistory = base.map((extension) =>
      extension.name === "starterKit" ? extension.configure({ undoRedo: false }) : extension,
    );
    const list: Extensions = [
      ...withoutHistory,
      // `field` (not `fragment`) so the doc→fragment lookup matches the box's
      // `doc.getXmlFragment("body")` by NAME, on whatever doc we are handed.
      Collaboration.configure({ document: collabDoc, field: COLLAB_BODY_FIELD }),
    ];
    const provider = collabProviderRef.current;
    if (provider) {
      list.push(
        CollaborationCaret.configure({
          provider,
          user: { name: collabUserName, color: collabUserColor },
          // Peers are drawn from the RELAY'S STAMP or drawn anonymously — an
          // agent gets the robot glyph, the reserved palette slot and a label
          // that stays while it works. See AgentCursor.tsx; nothing here (or
          // in `user` above) can promote anyone to an agent.
          ...collabCaretRenderers(),
        }),
        // The afterimage of an agent's write. Motion, so it is gated on
        // prefers-reduced-motion inside the extension.
        AgentTrail.configure({ provider }),
      );
    }
    return list;
    // `collabProvider` is deliberately absent — see collabProviderRef above.
    // (No eslint-disable: this config does not register react-hooks, and a
    // disable comment for an unregistered rule is itself a lint error.)
  }, [placeholder, collabDoc, collabUserName, collabUserColor]);

  const closeSlash = useCallback(() => {
    setSlash(null);
    setActive(0);
  }, []);

  const editor = useEditor(
    {
      extensions,
      // Under collab the Y.Doc already holds the document; handing TipTap
      // initial content would insert the body a SECOND time, for everyone.
      ...(collabDoc ? {} : { content: value }),
      editable,
      // The dashboard owns the outer scroll container and the focus ring.
      editorProps: {
        attributes: {
          class: "editor-surface md",
          ...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
        },
      },
      onUpdate: ({ editor: e }) => {
        // Collab owns body/title: the room flushes them server-side and the CAS
        // queue is suspended for them. Emitting here would give the host a
        // second, racing writer for the same text.
        if (collabDoc) return;
        const md = getMarkdown(e);
        // Not an edit — this is what the seeded value serializes to (see `seeded`).
        if (md === seeded.current) return;
        // ONE SHOT, cleared by the first genuine edit. Keeping the reference
        // alive would suppress a real change that lands BACK on the seeded text
        // — type a word, save it, delete it again, and the deletion would never
        // be written: the screen would show the original while the database kept
        // the word. Mount echoes all precede the first edit, so clearing here
        // costs the guard nothing.
        seeded.current = null;
        lastEmitted.current = md;
        onChange?.(md);
      },
      onCreate: ({ editor: e }) => {
        // The initial `content: value` above is seeded before any transaction
        // can fire, so this is the earliest and only place its serialization can
        // be recorded. Under collab there is no `value` and nothing to record.
        if (collabDoc) return;
        seeded.current = getMarkdown(e);
      },
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        onBlur?.();
      },
    },
    // `extensions` carries the placeholder AND the collab binding; everything
    // else is read through refs by TipTap, so the editor is rebuilt only when
    // one of those genuinely changes (e.g. a reconnect swaps the Y.Doc).
    [extensions],
  );

  /* Re-seed only when the parent hands us markdown we did not produce — and
     never under collab, where the CRDT is the document and a markdown re-seed
     would replay the whole body as new insertions for every participant. */
  useEffect(() => {
    if (collabDoc) return;
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    // `emitUpdate: false` — re-seeding is not a user edit, and echoing it back
    // through onChange would make the parent's value fight ours.
    editor.commands.setContent(value, { emitUpdate: false });
    // A new seed, so a new "this is not an edit" reference. Read back from the
    // editor rather than assuming `value`: the whole point is that they differ.
    seeded.current = getMarkdown(editor);
  }, [editor, value, collabDoc]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  /* Track the slash query and where to draw its menu. */
  useEffect(() => {
    if (!editor) return;
    const sync = (): void => {
      if (!editable) return closeSlash();
      const found = readSlashQuery(editor);
      if (!found) return closeSlash();
      const box = containerRef.current?.getBoundingClientRect();
      const caret = editor.view.coordsAtPos(found.from);
      // Clamp inside the container/viewport so the menu is not clipped off the
      // right edge in a narrow column (same primitive the `[[` popover uses).
      const pos = box
        ? editorPopoverPos({ caret, box })
        : { top: caret.bottom + 6, left: caret.left };
      setSlash({
        query: found.query,
        from: found.from,
        top: pos.top,
        left: pos.left,
      });
      setActive(0);
    };
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor, editable, closeSlash]);

  const results = useMemo(() => filterSlashCommands(slash?.query ?? ""), [slash?.query]);

  // The slash menu is a combobox popover the editor owns: a screen-reader user
  // whose focus never leaves the contenteditable must still be told the menu
  // opened, and which option Enter will run. We wire the ARIA contract onto the
  // editor's own DOM node (aria-expanded / aria-controls / aria-activedescendant)
  // rather than the popover, because focus stays in the prose.
  const slashOpen = slash !== null && results.length > 0;
  useEffect(() => {
    const dom = editor?.view.dom as HTMLElement | undefined;
    if (!dom) return;
    if (slashOpen) {
      dom.setAttribute("aria-expanded", "true");
      dom.setAttribute("aria-controls", SLASH_LISTBOX_ID);
      dom.setAttribute("aria-haspopup", "listbox");
      dom.setAttribute("aria-activedescendant", `${SLASH_OPTION_PREFIX}${active}`);
    } else {
      dom.removeAttribute("aria-expanded");
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-haspopup");
      dom.removeAttribute("aria-activedescendant");
    }
    return () => {
      dom.removeAttribute("aria-activedescendant");
    };
  }, [editor, slashOpen, active]);

  // The .editor-slash list caps at 288px and scrolls past ~7 of its 11 commands,
  // so ArrowDown/ArrowUp can move the highlight below the fold. aria-activedescendant
  // (above) carries it for screen readers; this keeps the VISIBLE highlight in view
  // for a sighted keyboard user, who would otherwise see the menu freeze on the
  // first items with no selection showing.
  useEffect(() => {
    if (!slashOpen) return;
    activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [slashOpen, active]);

  /* The /image URL popover: the editor's own floating input at the caret,
     positioned with the same primitive the slash menu and `[[` popover use. */
  const [imagePrompt, setImagePrompt] = useState<{ top: number; left: number } | null>(null);
  const [imageUrl, setImageUrl] = useState("");

  const openImagePrompt = useCallback(() => {
    if (!editor) return;
    setImageUrl("");
    let caret: { top: number; bottom: number; left: number; right: number } | null = null;
    try {
      caret = editor.view.coordsAtPos(editor.state.selection.head);
    } catch {
      caret = null; // no layout engine (jsdom) — anchor to the container corner
    }
    const box = containerRef.current?.getBoundingClientRect();
    const pos =
      caret && box
        ? editorPopoverPos({ caret, box })
        : caret
          ? { top: caret.bottom + 6, left: caret.left }
          : { top: 8, left: 8 };
    setImagePrompt(pos);
  }, [editor]);

  const cancelImagePrompt = useCallback(() => {
    setImagePrompt(null);
    setImageUrl("");
    editor?.chain().focus().run();
  }, [editor]);

  const applyImage = useCallback(() => {
    const src = imageUrl.trim();
    setImagePrompt(null);
    setImageUrl("");
    if (!editor) return;
    if (src === "") {
      editor.chain().focus().run();
      return;
    }
    // Only http(s) — the same rule applyLink enforces: any other scheme in a
    // shared body would be an injection surface in a page that renders nothing
    // raw.
    const safe = /^https?:\/\//i.test(src) ? src : `https://${src.replace(/^\/+/, "")}`;
    editor.chain().focus().setImage({ src: safe }).run();
  }, [editor, imageUrl]);

  const runCommand = useCallback(
    (command: SlashCommand) => {
      if (!editor || !slash) return;
      // Delete the "/query" first so the command sees a clean block; one
      // transaction chain keeps it a single undo step.
      editor
        .chain()
        .focus()
        .deleteRange({ from: slash.from, to: slash.from + slash.query.length + 1 })
        .run();
      // Image needs a URL: open the inline popover (after the range delete, so
      // it anchors to the cleaned caret) instead of running a doc mutation.
      if (command.id === "image") openImagePrompt();
      else command.run(editor);
      closeSlash();
    },
    [editor, slash, closeSlash, openImagePrompt],
  );

  /**
   * The menu is keyboard-first, so it must see arrows/enter BEFORE ProseMirror
   * moves the caret. A capture-phase listener on the container is the only
   * place that is reliably true for both the editor and the menu itself.
   */
  const onKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!slash || results.length === 0) {
        if (event.key === "Escape" && slash) {
          event.preventDefault();
          // Consumed here: without stopPropagation the same press would also
          // reach SidePeek's handler and close the peek over the menu.
          event.stopPropagation();
          closeSlash();
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => (i + 1) % results.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => (i - 1 + results.length) % results.length);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = results[Math.min(active, results.length - 1)];
        if (chosen) runCommand(chosen);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSlash();
      }
    },
    [slash, results, active, runCommand, closeSlash],
  );

  /**
   * Scroll the caret out from under the keyboard.
   *
   * The browser does this for a plain `<input>` and does NOT do it reliably for
   * a contenteditable inside a nested scroll container: iOS scrolls whatever it
   * thinks the field is, which for ProseMirror is often the wrong element or
   * the window. So we ask the visual viewport where the floor is, subtract our
   * own docked bar, and move the real scroller by the exact shortfall.
   */
  const ensureCaretVisible = useCallback(() => {
    if (!editor || editor.isDestroyed || !editor.isFocused) return;
    const vv = typeof window === "undefined" ? null : window.visualViewport;
    if (!vv) return;
    let caret: { top: number; bottom: number };
    try {
      caret = editor.view.coordsAtPos(editor.state.selection.head);
    } catch {
      // No layout engine (jsdom) or a stale position mid-transaction. Never
      // throw out of a selection handler — the editor stays usable either way.
      return;
    }
    const floor = vv.offsetTop + vv.height - MOBILE_TOOLBAR_H - CARET_MARGIN;
    const ceiling = vv.offsetTop + CARET_MARGIN;
    const delta =
      caret.bottom > floor ? caret.bottom - floor : caret.top < ceiling ? caret.top - ceiling : 0;
    if (delta === 0) return;
    const scroller = scrollableAncestor(editor.view.dom);
    if (scroller) scroller.scrollTop += delta;
    else window.scrollBy(0, delta);
  }, [editor]);

  useEffect(() => {
    if (!editor || !touch) return;
    let frame = 0;
    const schedule = (): void => {
      if (frame) return;
      // One rAF: the caret's coordinates are only meaningful after the browser
      // has laid out the transaction that moved it.
      frame = requestAnimationFrame(() => {
        frame = 0;
        ensureCaretVisible();
      });
    };
    editor.on("selectionUpdate", schedule);
    editor.on("focus", schedule);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      editor.off("selectionUpdate", schedule);
      editor.off("focus", schedule);
      vv?.removeEventListener("resize", schedule);
    };
  }, [editor, touch, ensureCaretVisible]);

  /* The keyboard coming up is the moment the caret is most likely to be under
     it, and no selection event accompanies that. */
  useEffect(() => {
    if (!touch) return;
    ensureCaretVisible();
  }, [touch, keyboard, ensureCaretVisible]);

  /* A closed keyboard has nothing to dock to, and a sheet left open would sit
     over the document. */
  useEffect(() => {
    if (!touch || !focused) setBlockSheet(false);
  }, [touch, focused]);

  /** Run a block command from the touch sheet: no slash query to clean up. */
  const runBlock = useCallback(
    (command: SlashCommand) => {
      if (!editor) return;
      if (command.id === "image") openImagePrompt();
      else command.run(editor);
      setBlockSheet(false);
    },
    [editor, openImagePrompt],
  );

  /**
   * Select the block the caret is in, as a NODE — the touch equivalent of
   * clicking a drag handle. A node selection is what makes the next tap
   * ("Delete block", or a mark button) act on the whole block, and it is what
   * draws the `.ProseMirror-selectednode` outline so you can SEE what you hit.
   */
  const selectBlock = useCallback(() => {
    if (!editor) return;
    const { $from } = editor.state.selection;
    // Depth 0 is the document itself: there is no block to select, and asking
    // for one would throw out of a tap handler.
    if ($from.depth === 0) return;
    editor.chain().focus().setNodeSelection($from.before($from.depth)).run();
    setBlockSheet(false);
  }, [editor]);

  /** Delete the block the caret is in — the other half of a drag handle's menu. */
  const deleteBlock = useCallback(() => {
    if (!editor) return;
    const { $from } = editor.state.selection;
    if ($from.depth === 0) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: $from.before($from.depth), to: $from.after($from.depth) })
      .run();
    setBlockSheet(false);
  }, [editor]);

  const applyLink = useCallback(() => {
    if (!editor) return;
    const href = (linkDraft ?? "").trim();
    if (href === "") {
      editor.chain().focus().unsetLink().run();
    } else {
      // Only http(s) — a `javascript:` href in a shared body would be a
      // script-injection hole in a surface that otherwise renders nothing raw.
      const safe = /^https?:\/\//i.test(href) ? href : `https://${href.replace(/^\/+/, "")}`;
      editor.chain().focus().setLink({ href: safe }).run();
    }
    setLinkDraft(null);
  }, [editor, linkDraft]);

  if (!editor) return <div className={cn("editor-root", className)} />;

  // `--editor-kb-inset` is the one number the stylesheet cannot work out for
  // itself: how far up from the layout viewport's bottom edge the keyboard
  // starts. Everything docked (bar, block sheet, slash menu, [[link]] popover)
  // is positioned off it.
  const rootStyle = { "--editor-kb-inset": `${keyboard}px` } as React.CSSProperties;

  return (
    <div
      ref={containerRef}
      className={cn(
        "editor-root",
        !editable && "editor-readonly",
        touch && focused && "editor-touch-docked",
        className,
      )}
      style={rootStyle}
      onKeyDownCapture={onKeyDownCapture}
    >
      {/* The drag handle is a HOVER affordance and a DRAG gesture: on a touch
          screen it is invisible, and its long-press would be competing with
          iOS's own text-selection callout for the same gesture on the same
          element. So it does not exist there — the docked bar's "Block" sheet
          is the touch equivalent (select / turn into / delete). */}
      {editable && !coarse && (
        <DragHandle editor={editor}>
          <div className="editor-drag-handle" aria-hidden="true">
            <svg viewBox="0 0 10 16" width="10" height="16" role="presentation">
              <circle cx="2.5" cy="3" r="1.2" />
              <circle cx="7.5" cy="3" r="1.2" />
              <circle cx="2.5" cy="8" r="1.2" />
              <circle cx="7.5" cy="8" r="1.2" />
              <circle cx="2.5" cy="13" r="1.2" />
              <circle cx="7.5" cy="13" r="1.2" />
            </svg>
          </div>
        </DragHandle>
      )}

      {/* Same story as the drag handle: a bubble that follows a selection is a
          bubble that lands under the iOS selection callout (or under the
          magnifier) exactly when the user is trying to read it. On touch the
          docked bar below is always there instead, so the affordance is not
          lost — it stops moving. */}
      {editable && !coarse && (
        <BubbleMenu
          editor={editor}
          className="editor-bubble"
          shouldShow={({ editor: e, from, to }) =>
            from !== to && !e.isActive("codeBlock") && !e.state.selection.empty
          }
        >
          {linkDraft === null ? (
            <>
              <MarkButton editor={editor} mark="bold" label="Bold">
                <b>B</b>
              </MarkButton>
              <MarkButton editor={editor} mark="italic" label="Italic">
                <i>I</i>
              </MarkButton>
              <MarkButton editor={editor} mark="code" label="Inline code">
                <span className="editor-mono">{"<>"}</span>
              </MarkButton>
              <button
                type="button"
                className={cn("editor-bubble-btn", editor.isActive("link") && "is-active")}
                aria-label="Link"
                aria-pressed={editor.isActive("link")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setLinkDraft(String(editor.getAttributes("link")["href"] ?? ""))}
              >
                Link
              </button>
            </>
          ) : (
            <form
              className="editor-link-form"
              onSubmit={(e) => {
                e.preventDefault();
                applyLink();
              }}
            >
              {/* autoFocus is correct here: the field replaced the Link button
                  the user just clicked, so focus is already theirs to keep. */}
              <input
                autoFocus
                className="editor-link-input"
                value={linkDraft}
                placeholder="https://…"
                aria-label="Link URL"
                onChange={(e) => setLinkDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setLinkDraft(null);
                  }
                }}
              />
              <button type="submit" className="editor-bubble-btn">
                Apply
              </button>
            </form>
          )}
        </BubbleMenu>
      )}

      <EditorContent editor={editor} />

      {/* `[[` autocomplete. Gated on `onLink`: with no sink for the edge this
          could only insert a visible link the graph knows nothing about, and
          that half-write is exactly what LinkSuggest exists to prevent. It
          also keeps the editor PURE by default — no `onLink`, no fetch. */}
      {editable && onLink && (
        <LinkSuggest
          editor={editor}
          editable={editable}
          onLink={onLink}
          containerRef={containerRef}
          {...(linkSearch === undefined ? {} : { search: linkSearch })}
        />
      )}

      {slash && results.length > 0 && (
        <div
          id={SLASH_LISTBOX_ID}
          className="editor-slash"
          style={{ top: slash.top, left: slash.left }}
          role="listbox"
          aria-label="Insert block"
        >
          {results.map((command, i) => (
            <button
              key={command.id}
              id={`${SLASH_OPTION_PREFIX}${i}`}
              ref={i === active ? activeOptionRef : null}
              type="button"
              role="option"
              aria-selected={i === active}
              className={cn("editor-slash-item", i === active && "is-active")}
              onMouseEnter={() => setActive(i)}
              {...chromeButtonProps(() => runCommand(command))}
            >
              <span className="editor-slash-hint">{command.hint}</span>
              <span>{command.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* The /image URL popover — the editor's own floating input, in place of
          the app's one former native-browser dialog (window.prompt froze the
          main thread and every collab caret with it, and rendered in neither
          skin). Same positioning primitive as the slash menu; same input
          chrome as the bubble's link form. */}
      {imagePrompt && (
        <div
          className="editor-slash"
          style={{ top: imagePrompt.top, left: imagePrompt.left }}
          role="dialog"
          aria-label="Insert image"
        >
          <form
            className="editor-link-form"
            onSubmit={(e) => {
              e.preventDefault();
              applyImage();
            }}
          >
            {/* autoFocus is correct here: the popover was opened by the user's
                own /image (or Block-sheet) action, so focus is theirs. */}
            <input
              autoFocus
              className="editor-link-input"
              value={imageUrl}
              placeholder="Image URL…"
              aria-label="Image URL"
              onChange={(e) => setImageUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelImagePrompt();
                }
              }}
            />
            <button type="submit" className="editor-bubble-btn">
              Insert
            </button>
          </form>
        </div>
      )}

      {/* ------------------------------------------------ the docked bar ---
          Touch's answer to every hover affordance above. It is PERSISTENT
          while the editor has focus and docked to the top of the keyboard
          (never over it, never under it), so the formatting controls are a
          thumb's reach from the caret and never move. */}
      {touch && focused && (
        <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
          {linkDraft === null ? (
            <>
              <div className="editor-toolbar-scroll">
                <button
                  type="button"
                  className={cn("editor-bubble-btn", blockSheet && "is-active")}
                  aria-label="Block actions"
                  aria-expanded={blockSheet}
                  {...chromeButtonProps(() => setBlockSheet((v) => !v))}
                >
                  <Plus size={17} aria-hidden />
                </button>
                <MarkButton editor={editor} mark="bold" label="Bold">
                  <b>B</b>
                </MarkButton>
                <MarkButton editor={editor} mark="italic" label="Italic">
                  <i>I</i>
                </MarkButton>
                <MarkButton editor={editor} mark="code" label="Inline code">
                  <span className="editor-mono">{"<>"}</span>
                </MarkButton>
                <ToolButton
                  editor={editor}
                  label="Heading"
                  active={editor.isActive("heading", { level: 2 })}
                  run={(e) => e.chain().focus().toggleHeading({ level: 2 }).run()}
                >
                  <Heading2 size={17} aria-hidden />
                </ToolButton>
                <ToolButton
                  editor={editor}
                  label="Bulleted list"
                  active={editor.isActive("bulletList")}
                  run={(e) => e.chain().focus().toggleBulletList().run()}
                >
                  <List size={17} aria-hidden />
                </ToolButton>
                <ToolButton
                  editor={editor}
                  label="To-do list"
                  active={editor.isActive("taskList")}
                  run={(e) => e.chain().focus().toggleTaskList().run()}
                >
                  <ListTodo size={17} aria-hidden />
                </ToolButton>
                <ToolButton
                  editor={editor}
                  label="Quote"
                  active={editor.isActive("blockquote")}
                  run={(e) => e.chain().focus().toggleBlockquote().run()}
                >
                  <Quote size={17} aria-hidden />
                </ToolButton>
                {/* Typing `[[` is a two-key gesture on a phone keyboard that
                    hides brackets behind a modifier page. The button types it
                    for you; LinkSuggest picks the trigger up from the document
                    exactly as it would from a keystroke. */}
                {onLink && (
                  <ToolButton
                    editor={editor}
                    label="Link to an object"
                    active={false}
                    run={(e) => e.chain().focus().insertContent(LINK_TRIGGER).run()}
                  >
                    <span className="editor-mono">{LINK_TRIGGER}</span>
                  </ToolButton>
                )}
                <button
                  type="button"
                  className={cn("editor-bubble-btn", editor.isActive("link") && "is-active")}
                  aria-label="Link"
                  aria-pressed={editor.isActive("link")}
                  {...chromeButtonProps(() =>
                    setLinkDraft(String(editor.getAttributes("link")["href"] ?? "")),
                  )}
                >
                  <Link2 size={17} aria-hidden />
                </button>
              </div>
              {/* The only reliable way to put a phone keyboard away without
                  losing the document you were writing in. */}
              <button
                type="button"
                className="editor-toolbar-done"
                onClick={() => editor.commands.blur()}
              >
                Done
              </button>
            </>
          ) : (
            <form
              className="editor-link-form editor-link-form-docked"
              onSubmit={(e) => {
                e.preventDefault();
                applyLink();
              }}
            >
              <input
                autoFocus
                className="editor-link-input"
                value={linkDraft}
                placeholder="https://…"
                aria-label="Link URL"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setLinkDraft(e.target.value)}
              />
              <button type="submit" className="editor-bubble-btn">
                Apply
              </button>
              <button
                type="button"
                className="editor-bubble-btn"
                onClick={() => setLinkDraft(null)}
              >
                Cancel
              </button>
            </form>
          )}
        </div>
      )}

      {/* Tap-to-select block actions: what a drag handle's menu would offer,
          reachable by thumb and scrollable above the keyboard. */}
      {touch && focused && blockSheet && (
        <div className="editor-sheet" role="menu" aria-label="Block actions">
          <div className="editor-sheet-row">
            <button
              type="button"
              role="menuitem"
              className="editor-slash-item"
              {...chromeButtonProps(selectBlock)}
            >
              Select block
            </button>
            <button
              type="button"
              role="menuitem"
              className="editor-slash-item editor-sheet-danger"
              {...chromeButtonProps(deleteBlock)}
            >
              Delete block
            </button>
          </div>
          <p className="editor-sheet-label">Turn into</p>
          {SLASH_COMMANDS.map((command) => (
            <button
              key={command.id}
              type="button"
              role="menuitem"
              className="editor-slash-item"
              {...chromeButtonProps(() => runBlock(command))}
            >
              <span className="editor-slash-hint">{command.hint}</span>
              <span>{command.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A tap on editor chrome must not blur the editor: blurring drops the
 * selection the command is about to act on AND closes the keyboard, so the bar
 * would dismiss itself on first use. `pointerdown` is the one that matters on
 * touch (focus follows the touch sequence, not the synthesized mousedown);
 * `mousedown` covers the desktop path.
 */
function keepFocus(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

/* ------------------------------------------------------- the WebKit problem */

/**
 * `keepFocus` ALONE MAKES THE ENTIRE TOUCH CHROME INERT ON iOS.
 *
 * Cancelling `pointerdown` is what keeps the editor focused. On Chrome that is
 * the whole story — the compatibility `click` still fires, so an `onClick`
 * handler runs. On WebKit, which is iOS Safari, i.e. the ONLY engine on the
 * device this chrome exists for, cancelling `pointerdown` ALSO cancels the
 * compatibility click. Probed directly: a tap on Bold emits pointerdown,
 * touchstart and touchend, and no click. Every control built on `keepFocus` —
 * the docked bar's marks and block toggles, the "+" sheet, every slash-menu
 * option — therefore drew perfectly and did nothing, on the only device that
 * has them.
 *
 * The fix is to stop waiting for a click that is never coming: a non-mouse
 * pointer runs the command on `pointerup`, and the mouse/keyboard path keeps
 * using `click`. Three details are load-bearing:
 *
 *  - **The release must be ON the control.** Touch sets implicit pointer
 *    capture, so `pointerup` fires on the element the finger STARTED on even
 *    if it has since travelled to the other side of the screen. Dragging off a
 *    button and letting go must cancel, exactly as it does with a mouse, so the
 *    release point is bounds-checked.
 *  - **A click that follows anyway must not double-fire.** Chrome-on-touch does
 *    deliver a click here; the timestamp stamped on the element (an expando, so
 *    each control has its own and no shared ref is needed) swallows it.
 *  - **Keyboard activation still works.** Enter/Space on a focused button emits
 *    a click with no preceding pointer sequence, so it falls through to `run`.
 */
const CLICK_SUPPRESS_MS = 700;

type ChromeButtonEl = HTMLElement & { __chromeActedAt?: number };

function withinBounds(el: HTMLElement, x: number, y: number): boolean {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/**
 * The props every control in the editor's chrome spreads. Replaces the old
 * `onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={run}` triple —
 * which is the shape that was broken.
 */
function chromeButtonProps(run: () => void): {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
} {
  return {
    onPointerDown: keepFocus,
    onMouseDown: keepFocus,
    onPointerUp: (event) => {
      // The mouse keeps its click; only touch and pen need rescuing.
      if (event.pointerType === "mouse") return;
      const el = event.currentTarget as ChromeButtonEl;
      if (!withinBounds(el, event.clientX, event.clientY)) return;
      el.__chromeActedAt = Date.now();
      run();
    },
    onClick: (event) => {
      const el = event.currentTarget as ChromeButtonEl;
      const acted = el.__chromeActedAt;
      if (acted !== undefined && Date.now() - acted < CLICK_SUPPRESS_MS) return;
      run();
    },
  };
}

/** One block-level toggle in the docked bar. */
function ToolButton({
  editor,
  label,
  active,
  run,
  children,
}: {
  editor: Editor;
  label: string;
  active: boolean;
  run: (editor: Editor) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn("editor-bubble-btn", active && "is-active")}
      aria-label={label}
      aria-pressed={active}
      {...chromeButtonProps(() => run(editor))}
    >
      {children}
    </button>
  );
}

function MarkButton({
  editor,
  mark,
  label,
  children,
}: {
  editor: Editor;
  mark: "bold" | "italic" | "code";
  label: string;
  children: React.ReactNode;
}) {
  const isActive = editor.isActive(mark);
  return (
    <button
      type="button"
      className={cn("editor-bubble-btn", isActive && "is-active")}
      aria-label={label}
      aria-pressed={isActive}
      // Keep the selection (focus would collapse it before the command lands)
      // AND survive WebKit cancelling the compatibility click — see
      // `chromeButtonProps`.
      {...chromeButtonProps(() => {
        const chain = editor.chain().focus();
        if (mark === "bold") chain.toggleBold().run();
        else if (mark === "italic") chain.toggleItalic().run();
        else chain.toggleCode().run();
      })}
    >
      {children}
    </button>
  );
}
