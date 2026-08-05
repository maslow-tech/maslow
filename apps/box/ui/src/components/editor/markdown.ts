import { Extension } from "@tiptap/core";
import type { Extensions, JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import CodeBlock from "@tiptap/extension-code-block";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";

import { codeFence } from "./normalize";

/**
 * Markdown is the canonical at-rest format for an object body (MCP writes it,
 * the box stores it, this editor is one of several producers). TipTap is a
 * lens over it: parse on the way in, serialize on the way out, and the
 * serializer's spelling is the canonical one — see ./normalize.ts for the
 * contract the phase-2 collab flush shares with this module.
 *
 * No node type may be added here without a fixture in markdown.test.ts: an
 * extension the serializer does not know about silently deletes content on the
 * first save (that is how the image case was caught — StarterKit parses no
 * images, so `![alt](url)` round-tripped to the empty string until
 * @tiptap/extension-image was added).
 */

/**
 * tiptap-markdown's `tightLists` option only reaches bulletList/orderedList,
 * so a task list serializes loose (`- [ ] a\n\n- [x] b`) while every other
 * list serializes tight. That inconsistency would rewrite every todo list a
 * agent ever wrote on its first flush. Giving taskList the same `tight`
 * attribute the other two get puts it back on the tight path
 * (prosemirror-markdown's renderList reads `node.attrs.tight`).
 */
const TightTaskList = Extension.create({
  name: "tightTaskList",
  addGlobalAttributes() {
    return [
      {
        types: ["taskList"],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute("data-tight") === "true" || !element.querySelector("p"),
            renderHTML: (attributes: { tight?: boolean }) => ({
              "data-tight": attributes.tight ? "true" : null,
            }),
          },
        },
      },
    ];
  },
});

/**
 * tiptap-markdown hardcodes a three-backtick fence for code blocks, so a code
 * block whose CONTENT contains a ``` line serializes to markdown that closes
 * early — the rest of the block silently becomes prose on the next parse. That
 * is real content loss on a body that documents markdown (we write plenty).
 * The fix is the CommonMark rule: the fence must be longer than any
 * line-leading backtick run inside it. `codeFence` is shared with normalizeMd
 * so both producers spell the same block the same way.
 */
const FencedCodeBlock = CodeBlock.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            text: (s: string, escape: boolean) => void;
            ensureNewLine: () => void;
            closeBlock: (node: unknown) => void;
          },
          node: { attrs: { language?: string | null }; textContent: string },
        ) {
          const fence = codeFence(node.textContent.split("\n"));
          state.write(`${fence}${node.attrs.language || ""}\n`);
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write(fence);
          state.closeBlock(node);
        },
      },
    };
  },
});

type EditorExtensionOptions = {
  /** Placeholder shown in an empty document. */
  placeholder?: string;
};

/**
 * The ONE extension list. The editor component, the headless helpers below and
 * (phase 2) the server-side Yjs schema must all be built from this exact set —
 * a schema mismatch between the browser doc and the flushing doc is silent
 * content loss, not an error.
 */
export function editorExtensions(options: EditorExtensionOptions = {}): Extensions {
  return [
    StarterKit.configure({
      // The dashboard renders links itself; keep parsing/serialization but no
      // click-through-to-anywhere behaviour beyond the default renderer.
      link: { openOnClick: false, autolink: false },
      // Replaced by FencedCodeBlock below (fence-length-aware serializer).
      codeBlock: false,
      // `undoRedo` is replaced by the Yjs history in phase 2; until the collab
      // engine lands the local history is the right one.
    }),
    FencedCodeBlock,
    TaskList,
    TaskItem.configure({ nested: true }),
    TightTaskList,
    // `inline: true` matters for fidelity, not layout: as a block node an
    // image inside a sentence is hoisted out of its paragraph, splitting the
    // prose around it. allowBase64 stays off — a pasted data: URI would inline
    // megabytes into the object body.
    Image.configure({ inline: true, allowBase64: false }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({
      placeholder: options.placeholder ?? "Write something, or press / for blocks",
      showOnlyWhenEditable: true,
    }),
    Markdown.configure({
      // Raw HTML never becomes nodes: the dashboard's render boundary treats
      // untrusted markdown as text, and this editor must not
      // be the hole in it. HTML in a body round-trips as escaped text.
      html: false,
      tightLists: true,
      bulletListMarker: "-",
      linkify: false,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
  ];
}

/** Parse markdown into a ProseMirror JSON document. */
export function mdToDoc(md: string): JSONContent {
  return withHeadlessEditor(md, (editor) => editor.getJSON());
}

/** Serialize a ProseMirror JSON document back to canonical markdown. */
export function docToMd(doc: JSONContent): string {
  return withHeadlessEditor(doc, (editor) => getMarkdown(editor));
}

/** The canonical markdown for an arbitrary input — parse, then serialize. */
export function canonicalizeMd(md: string): string {
  return withHeadlessEditor(md, (editor) => getMarkdown(editor));
}

/**
 * Read the markdown serialization of a live editor.
 *
 * tiptap-markdown does not augment TipTap's `Storage` interface, so the lookup
 * is untyped by necessity; it is guarded rather than asserted because a
 * missing storage slot means the Markdown extension was dropped from
 * `editorExtensions`, and returning "" beats throwing inside an onUpdate.
 */
export function getMarkdown(editor: Editor): string {
  const storage = (editor.storage as unknown as Record<string, unknown>)["markdown"];
  const get = (storage as { getMarkdown?: () => string } | undefined)?.getMarkdown;
  return typeof get === "function" ? get.call(storage) : "";
}

function withHeadlessEditor<T>(content: string | JSONContent, fn: (editor: Editor) => T): T {
  const editor = new Editor({ extensions: editorExtensions(), content, editable: false });
  try {
    return fn(editor);
  } finally {
    editor.destroy();
  }
}
