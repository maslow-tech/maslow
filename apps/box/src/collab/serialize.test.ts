import { describe, expect, it } from "vitest";
import * as Y from "yjs";

// The CLIENT's normalization, imported deliberately across the package
// boundary: this test is the drift detector between the two copies of the
// markdown contract (see the header of serialize.ts for why the server cannot
// import it at runtime). If either side changes, it fails HERE rather than in a
// customer's version history.
import { normalizeMd } from "../../ui/src/components/editor/normalize.js";

import {
  BODY_FRAGMENT,
  TITLE_TEXT,
  canonicalMarkdown,
  docTitle,
  docToMarkdown,
  normalizeMarkdown,
  parseInline,
  seedDocFromMarkdown,
  serializeInline,
} from "./serialize.js";

/**
 * The markdown ↔ Yjs round trip.
 *
 * The flush decides whether to CAS-write by comparing the serialized CRDT
 * against `normalizeMarkdown(stored)`. If those disagree on a document nobody
 * touched, every flush cycle writes a spurious version, a history row and an
 * audit event — on every open object, forever. So:
 *
 *   1. ROUND TRIP — `docToMarkdown(seedDocFromMarkdown(x)) === normalizeMd(x)`
 *      over the same fixture corpus the client's markdown.test.ts uses, with
 *      `normalizeMd` being the CLIENT's function.
 *   2. AGREEMENT — the server's `normalizeMarkdown` and the client's
 *      `normalizeMd` are byte-identical on every fixture.
 *   3. STABILITY — canonical output is a fixed point, so even the inputs that
 *      cost one settling version never cost two.
 */

/** Copied from apps/box/ui/src/components/editor/markdown.test.ts. */
const CORPUS: Record<string, string> = {
  // --- headings ---
  "heading h1": "# Title",
  "heading h1-h3": "# One\n\n## Two\n\n### Three",
  "heading h6": "###### six",
  "heading with closing sequence": "# One #",
  "heading with extra space": "#  One",
  "heading setext": "Title\n=====\n\nSub\n---",
  "heading with bold": "# a **b**",
  "heading with inline code": "# a `b`",

  // --- paragraphs and breaks ---
  paragraph: "hello world",
  "two paragraphs": "one\n\ntwo",
  "soft break joins lines": "line1\nline2",
  "soft break across three lines": "aaa bbb ccc\nddd eee fff\nggg",
  "hard break backslash": "line one\\\nline two",
  "hard break two spaces": "one  \ntwo",
  "hard break repeated": "a\\\nb\\\nc",

  // --- lists ---
  "bullet list": "- a\n- b\n- c",
  "bullet list nested": "- a\n  - b\n    - c\n- d",
  "bullet list nested deeply": "- a\n  - b\n    - c\n      - d",
  "bullet list with tabs": "-\ta\n-\tb",
  "bullet list empty item": "- \n- b",
  "bullet list loose": "- a\n\n- b",
  "bullet list item with paragraph": "- a\n\n  second\n- b",
  "bullet list item with multiple paragraphs": "- a\n\n  b\n\n- c",
  "ordered list": "1. a\n2. b",
  "ordered list custom start": "3. a\n4. b",
  "ordered list widening numbers": "9. a\n10. b\n11. c",
  "ordered list paren delimiter": "1) a\n2) b",
  "ordered list nested": "1. a\n   1. b\n2. c",
  "ordered inside bullet": "- a\n  1. b",
  "bullet inside ordered": "1. a\n   - b",
  "mixed nesting": "1. a\n   - b\n     1. c",
  "list then paragraph": "- a\n- b\n\nafter",
  "paragraph then list": "before\n- a",

  // --- task lists ---
  "task list": "- [ ] a\n- [x] b",
  "task list nested": "- [ ] a\n  - [x] b",
  "task list loose": "- [ ] a\n\n- [x] b",
  "task list mixed with plain items": "- [ ] a\n- plain\n- [x] b",

  // --- quotes ---
  quote: "> quoted",
  "quote multiline": "> one\n> two",
  "quote nested": "> outer\n>\n> > inner",
  "quote containing list": "> - a\n> - b",
  "quote containing nested list": "> - a\n>   - b",
  "quote containing code": "> ```\n> x\n> ```",
  "quote inside list item": "- a\n  > q",

  // --- code ---
  "code fence with language": "```ts\nconst x = 1;\n```",
  "code fence plain": "```\nplain\n```",
  "code fence tilde": "~~~js\nx\n~~~",
  "code fence empty": "```ts\n```",
  "code fence with blank line inside": "```\na\n\nb\n```",
  "code fence containing a fence": "````\n```\n````",
  "code fence containing a language fence": "````\n```js\nx\n```\n````",
  "code indented becomes fenced": "    code here",
  "code inside list item": "- a\n  ```\n  x\n  ```",

  // --- rules ---
  "thematic break": "a\n\n---\n\nb",
  "thematic break alternate spellings": "a\n\n***\n\nb\n\n___\n\nc",
  "thematic break adjacent": "---\n---",
  "thematic break alone": "---",

  // --- inline ---
  link: "see [docs](https://x.test/docs) now",
  "link with title": '[x](https://x.test "T")',
  autolink: "<https://x.test>",
  "inline code": "use `foo()` here",
  "bold and italic": "**bold** and *italic*",
  strikethrough: "~~gone~~",
  "escaped asterisk": "a \\* b",

  // --- images ---
  image: "![alt](https://x.test/i.png)",
  "image with title": '![a](https://x.test/i.png "T")',
  "image inside a paragraph": "text ![a](https://x.test/i.png) text",

  // --- tables ---
  table: "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "table mid document": "before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter",
  "table empty cell": "| a | b |\n| --- | --- |\n|  | 2 |",
  "table ragged row": "| a | b |\n| --- | --- |\n| 1 |",
  "table with inline marks": "| a |\n| --- |\n| **b** |",

  // --- whitespace and degenerate input ---
  empty: "",
  "whitespace only": "   \n\t\n",
  "trailing whitespace": "hello   \n",
  "trailing blank lines": "hello\n\n\n",
  "leading blank lines": "\n\nhello",
  "crlf line endings": "a\r\nb",
  "cr line endings": "a\rb",
  "empty heading": "#",
  "code fence trailing blank line": "```\na\n\n```",

  // --- a realistic body ---
  "mixed document":
    "# T\n\nintro para\n\n- one\n- two\n\n```js\nx\n```\n\n> q\n\n| a |\n| --- |\n| 1 |",

  // --- inline shapes the client corpus does not reach, but a body will ---
  "link inside emphasis": "*see [docs](https://x.test)*",
  "bold inside a list item": "- **a** b",
  "code span containing a backtick": "a `` ` `` b",
  "underscore inside a word": "snake_case_name stays one word",
  "html is never markup": "<script>alert(1)</script>",
  "link text with punctuation": "[a b](https://x.test/p)",
};

/**
 * Inputs where the ROUND TRIP is allowed to differ from `normalizeMd`, with the
 * measured value pinned. Each costs at most ONE settling version (the stability
 * suite proves that); each is written down so a change shows up as a failure to
 * re-triage rather than as silent drift.
 *
 * Fewer entries than the client's `KNOWN_GAPS` because this module parses
 * markdown itself instead of going through markdown-it: entity decoding and the
 * doubled blank line between adjacent lists with different markers do not
 * happen here. Where the client has a gap and this module does not, the flush
 * simply writes one fewer settling version.
 */
const KNOWN_GAPS: Record<string, { input: string; roundTrip: string }> = {
  // ProseMirror's `code` mark excludes every other mark, so the link is lost —
  // matched here on purpose (see MARK_ORDER in serialize.ts): storing a mark
  // combination the client's schema cannot represent would lose it on the first
  // keystroke instead, and flush it back as a change nobody made.
  "link wrapping only inline code": {
    input: "[`c`](https://x.test)",
    roundTrip: "`c`",
  },
  // Emphasis spelling is normalized to asterisks, exactly as the client's
  // serializer does.
  "emphasis spelling is normalized to asterisks": {
    input: "_em_ and __strong__",
    roundTrip: "*em* and **strong**",
  },
  // A trailing backslash is literal text and comes back escaped.
  "trailing backslash is escaped": {
    input: "one\\",
    roundTrip: "one\\\\",
  },
};

describe("markdown ↔ Yjs round trip", () => {
  it.each(Object.entries(CORPUS))("%s", (_name, md) => {
    expect(docToMarkdown(seedDocFromMarkdown(md))).toBe(normalizeMd(md));
  });
});

describe("the two normalizations agree", () => {
  const all = {
    ...CORPUS,
    ...Object.fromEntries(Object.entries(KNOWN_GAPS).map(([k, v]) => [k, v.input])),
  };

  it.each(Object.entries(all))("%s", (_name, md) => {
    expect(normalizeMarkdown(md)).toBe(normalizeMd(md));
  });
});

describe("known gaps", () => {
  it.each(Object.entries(KNOWN_GAPS))("%s", (_name, { input, roundTrip }) => {
    expect(docToMarkdown(seedDocFromMarkdown(input))).toBe(roundTrip);
  });
});

/**
 * `canonicalMarkdown` is what the flush compares a serialized room against, and
 * the ONLY property that matters is that an untouched room never looks changed.
 * It holds for EVERY input — including the KNOWN_GAPS above, which is the point:
 * `normalizeMarkdown` costs a gap input one spurious version, this costs zero.
 *
 * The `~` case is the one that shipped: prose containing `~$120k` normalized to
 * itself but serialized to `\~$120k`, so opening the object (from the graph, or
 * anywhere) wrote a version in the reader's name and put a backslash in their
 * sentence. It is a plain lone escapable character — nothing exotic — which is
 * why "enumerate the gaps" was never going to be enough.
 */
describe("canonicalMarkdown is what an untouched room serializes to", () => {
  const CHURN_BAIT: Record<string, string> = {
    ...CORPUS,
    ...Object.fromEntries(Object.entries(KNOWN_GAPS).map(([k, v]) => [k, v.input])),
    "a lone tilde in prose": "B&P for an IDIQ volume set is ~$120k.",
    "a lone tilde in a table cell": "| a | b |\n| --- | --- |\n| ~60% draft | x |",
    "a lone tilde in a list item": "- roughly ~30% as sub",
    "a lone tilde in a heading": "## ~$1M ceiling",
    "an unmatched asterisk": "5 * 3 is fifteen",
    "an unmatched bracket": "see [1] below",
    "an unmatched underscore": "_leading underscore",
  };

  it.each(Object.entries(CHURN_BAIT))("%s does not look changed", (_name, md) => {
    const doc = seedDocFromMarkdown(md, { title: "t" });
    // What the flush would write vs what it compares against. Equal ⇒ no write.
    expect(docToMarkdown(doc)).toBe(canonicalMarkdown(md));
    doc.destroy();
  });

  it.each(Object.entries(CHURN_BAIT))("%s is a fixed point", (_name, md) => {
    const once = canonicalMarkdown(md);
    expect(canonicalMarkdown(once)).toBe(once);
  });

  it("is the case normalizeMarkdown gets wrong", () => {
    // The regression, stated as the inequality that caused it. If this ever
    // becomes equal the two normalizations have converged and the distinction
    // could be retired — until then, `canonicalMarkdown` is load-bearing.
    const md = "B&P for an IDIQ volume set is ~$120k.";
    expect(normalizeMarkdown(md)).toBe(md);
    expect(canonicalMarkdown(md)).toBe("B&P for an IDIQ volume set is \\~$120k.");
  });
});

describe("stability", () => {
  /**
   * The property the flush actually depends on: re-seeding from the serialized
   * output must reach a fixed point that `normalizeMarkdown` also calls
   * canonical. Without it an open, untouched document writes a version on every
   * flush cycle.
   */
  const settle = (md: string): string => docToMarkdown(seedDocFromMarkdown(md));

  const all = {
    ...CORPUS,
    ...Object.fromEntries(Object.entries(KNOWN_GAPS).map(([k, v]) => [k, v.input])),
  };

  it.each(Object.entries(all))("%s reaches a fixed point", (_name, md) => {
    const once = settle(md);
    expect(settle(once)).toBe(once);
    expect(normalizeMarkdown(once)).toBe(once);
    expect(normalizeMd(once)).toBe(once);
  });
});

describe("inline round trip", () => {
  const INLINE = [
    "plain text",
    "**bold**",
    "*italic*",
    "***both***",
    "`code`",
    "~~struck~~",
    "[label](https://x.test)",
    '[label](https://x.test "T")',
    "<https://x.test>",
    "a **b** c *d* e",
    "**bold with [link](https://x.test)**",
    "a \\* b",
    "a \\_ b",
    "snake_case_name",
  ];

  it.each(INLINE)("%s", (src) => {
    expect(serializeInline(parseInline(src))).toBe(src);
  });

  it("escapes a bare asterisk in prose, exactly as prosemirror-markdown does", () => {
    // Not emphasis (the opener is followed by a space), so it is literal text
    // and comes back escaped — one settling version, then stable.
    expect(serializeInline(parseInline("1 * 2 * 3"))).toBe("1 \\* 2 \\* 3");
    expect(serializeInline(parseInline("1 \\* 2 \\* 3"))).toBe("1 \\* 2 \\* 3");
  });

  it("keeps marks out of a code span (ProseMirror's code mark excludes others)", () => {
    const nodes = parseInline("[`c`](https://x.test)");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "text", text: "c", marks: [{ type: "code" }] });
  });
});

describe("the doc shape", () => {
  it("holds the body as an XmlFragment and the title as a Y.Text", () => {
    const doc = seedDocFromMarkdown("# T\n\nbody", { title: "The title" });
    expect(doc.getXmlFragment(BODY_FRAGMENT).length).toBe(2);
    expect(doc.getText(TITLE_TEXT).toString()).toBe("The title");
    expect(docTitle(doc)).toBe("The title");
  });

  it("writes node attrs the way y-prosemirror reads them", () => {
    const doc = seedDocFromMarkdown("## h\n\n1. a\n\n- [x] done\n\n```ts\nx\n```");
    const [heading, list, tasks, code] = doc.getXmlFragment(BODY_FRAGMENT).toArray();
    expect((heading as Y.XmlElement).nodeName).toBe("heading");
    // A NUMBER, not "2": ProseMirror validates heading.level against the schema.
    expect((heading as Y.XmlElement).getAttribute("level")).toBe(2);
    expect((list as Y.XmlElement).nodeName).toBe("orderedList");
    expect((list as Y.XmlElement).getAttribute("start")).toBe(1);
    expect((tasks as Y.XmlElement).nodeName).toBe("taskList");
    const item = (tasks as Y.XmlElement).toArray()[0] as Y.XmlElement;
    expect(item.nodeName).toBe("taskItem");
    expect(item.getAttribute("checked")).toBe(true);
    expect((code as Y.XmlElement).getAttribute("language")).toBe("ts");
  });

  it("stores marks as y-prosemirror formatting attributes", () => {
    const doc = seedDocFromMarkdown("a **b** [c](https://x.test/d)");
    const para = doc.getXmlFragment(BODY_FRAGMENT).toArray()[0] as Y.XmlElement;
    const text = para.toArray()[0] as Y.XmlText;
    const delta = text.toDelta() as { insert: string; attributes?: Record<string, unknown> }[];
    expect(delta[0]).toMatchObject({ insert: "a " });
    expect(delta[1]).toMatchObject({ insert: "b", attributes: { bold: {} } });
    expect(delta[3]).toMatchObject({
      insert: "c",
      attributes: { link: { href: "https://x.test/d" } },
    });
  });

  it("garbage-collects deleted text out of the persisted snapshot", () => {
    // Compaction's second reason (0028-redact-connector-history): a Yjs update
    // log retains text the author deleted, which neither the body nor history
    // retain. gc + snapshot is what drops it.
    const doc = seedDocFromMarkdown("keep SECRETSECRET keep");
    const para = doc.getXmlFragment(BODY_FRAGMENT).toArray()[0] as Y.XmlElement;
    const text = para.toArray()[0] as Y.XmlText;
    text.delete(5, "SECRETSECRET ".length);
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc));
    expect(docToMarkdown(doc)).toBe("keep keep");
    expect(snapshot.toString("latin1")).not.toContain("SECRETSECRET");
  });

  it("survives an update round trip through the wire format", () => {
    const doc = seedDocFromMarkdown("# T\n\n- a\n- b", { title: "t" });
    const copy = new Y.Doc({ gc: true });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    expect(docToMarkdown(copy)).toBe(docToMarkdown(doc));
    expect(docTitle(copy)).toBe("t");
  });

  it("ignores a node type it does not know rather than inventing markdown", () => {
    const doc = seedDocFromMarkdown("a");
    const alien = new Y.XmlElement("mermaidDiagram");
    doc.getXmlFragment(BODY_FRAGMENT).insert(1, [alien]);
    expect(docToMarkdown(doc)).toBe("a");
  });
});
