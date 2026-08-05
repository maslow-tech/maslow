import { describe, expect, it } from "vitest";

import { canonicalizeMd, docToMd, mdToDoc } from "./markdown";
import { codeFence, normalizeMd } from "./normalize";

/**
 * The markdown round-trip contract.
 *
 * Markdown is canonical at rest. TipTap is one producer of it; MCP `write`,
 * imports and pasting humans are the others. Phase 2's collab flush decides
 * whether to CAS-write by comparing the serialized CRDT against
 * `normalizeMd(stored)` — so if those two disagree on a body nobody edited,
 * every flush cycle writes a spurious version, forever.
 *
 * Hence the two properties below:
 *
 *   1. AGREEMENT — `docToMd(mdToDoc(x)) === normalizeMd(x)` over a fixture
 *      corpus. Every markdown construct we expect in a body is here; a node
 *      type the serializer silently drops fails HERE rather than eating a
 *      customer's content on their first save.
 *   2. STABILITY — canonical output is a fixed point of BOTH producers. This
 *      is the property that actually prevents the flush loop, and it must hold
 *      even for the inputs where agreement does not (the known gaps): those
 *      may cost ONE settling version, never an unbounded stream of them.
 */

/** Fixtures where the parse/serialize round trip must equal `normalizeMd`. */
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
  // taskList and bulletList are distinct node types: a mixed list parses as
  // three adjacent lists and MUST serialize that way.
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
  // The fence must outgrow any backtick run inside, or the block closes early
  // and the remainder silently becomes prose.
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
  // Regression: as a BLOCK node an inline image is hoisted out of its
  // paragraph, splitting the sentence around it. Images are configured inline.
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
};

/**
 * Measured divergences we accept. Each costs at most ONE settling version (the
 * stability suite proves that), and each is a limit of the serializer, not of
 * `normalizeMd`. They are pinned so a library upgrade that changes any of them
 * shows up as a failure to re-triage rather than as silent behaviour drift.
 *
 * Every entry here is `normalizeMd` UNDER-claiming — it preserves something
 * the serializer rewrites. The opposite direction (normalizeMd claiming a
 * rewrite the serializer would not make) reports "no change" for a body that in
 * fact changes, and is the bug this file exists to prevent.
 *
 * "Under-claiming is safe" was ONLY EVER TRUE OF THIS FILE, and reading it as a
 * general licence cost us a real bug (2026-07-26): under-claiming means
 * `normalizeMd(x) !== canonicalizeMd(x)`, so anything that answered "did the
 * document change?" by comparing a serialized document against `normalizeMd`
 * read an untouched body as edited. Opening an object whose prose contained a
 * lone `~` wrote a version, a history row and an audit event in the READER's
 * name, and put a backslash in their sentence. The fix, both sides: compare
 * against parse-then-serialize (`canonicalizeMd` here, `canonicalMarkdown` in
 * apps/box/src/collab/serialize.ts) — never against a normalizer that is
 * allowed to under-claim.
 */
const KNOWN_GAPS: Record<string, { input: string; roundTrip: string; normalized: string }> = {
  // ProseMirror's `code` mark excludes other marks, so the link is dropped
  // outright. This is real content loss on parse — the only one in the corpus,
  // and the reason it is written down rather than merely tolerated.
  "link wrapping only inline code": {
    input: "[`c`](https://x.test)",
    roundTrip: "`c`",
    normalized: "[`c`](https://x.test)",
  },
  "emphasis spelling is normalized to asterisks": {
    input: "_em_ and __strong__",
    roundTrip: "*em* and **strong**",
    normalized: "_em_ and __strong__",
  },
  "html entities are decoded": {
    input: "a &amp; b",
    roundTrip: "a & b",
    normalized: "a &amp; b",
  },
  "trailing backslash is escaped": {
    input: "one\\",
    roundTrip: "one\\\\",
    normalized: "one\\",
  },
  // `-` and `*` open DIFFERENT lists in CommonMark; the serializer renders both
  // with `-` and separates them with a blank line it then over-counts.
  "adjacent lists with different markers": {
    input: "- a\n\n* b",
    roundTrip: "- a\n\n\n- b",
    normalized: "- a\n\n- b",
  },
  "byte order mark defeats a heading": {
    input: "﻿# t",
    roundTrip: "﻿\\# t",
    normalized: "﻿# t",
  },
  // The one that shipped. A lone `~` cannot open a strikethrough (that needs
  // `~~`), so the parser leaves it as text — and the serializer escapes it
  // anyway, because it escapes the whole punctuation set unconditionally. Plain
  // prose, no exotic markup: "enumerate the divergences" was never going to be
  // a defence, which is why the fix compares against canonicalizeMd instead.
  "a lone tilde in prose is escaped": {
    input: "B&P for an IDIQ volume set is ~$120k.",
    roundTrip: "B&P for an IDIQ volume set is \\~$120k.",
    normalized: "B&P for an IDIQ volume set is ~$120k.",
  },
};

describe("markdown round trip", () => {
  it.each(Object.entries(CORPUS))("%s", (_name, md) => {
    expect(docToMd(mdToDoc(md))).toBe(normalizeMd(md));
  });

  it("canonicalizeMd is the same function as parse-then-serialize", () => {
    for (const md of Object.values(CORPUS)) {
      expect(canonicalizeMd(md)).toBe(docToMd(mdToDoc(md)));
    }
  });
});

describe("known gaps", () => {
  it.each(Object.entries(KNOWN_GAPS))("%s", (_name, { input, roundTrip, normalized }) => {
    expect(docToMd(mdToDoc(input))).toBe(roundTrip);
    expect(normalizeMd(input)).toBe(normalized);
  });
});

describe("stability", () => {
  /**
   * The property the flush actually depends on. For every input — INCLUDING
   * the known gaps — repeatedly canonicalizing must reach a fixed point that
   * `normalizeMd` also agrees is canonical. If it did not, the flush would
   * write a new version on every cycle for a document nobody is editing.
   *
   * Two rounds are allowed because the serializer itself is not idempotent in
   * one case (adjacent lists with different markers): it emits a doubled blank
   * separator that re-parses as a single loose list. It settles on the second
   * pass, and `normalizeMd` predicts exactly where.
   */
  const settle = (md: string): string => canonicalizeMd(canonicalizeMd(md));

  const all = {
    ...CORPUS,
    ...Object.fromEntries(Object.entries(KNOWN_GAPS).map(([k, v]) => [k, v.input])),
  };

  it.each(Object.entries(all))("%s reaches a fixed point", (_name, md) => {
    const settled = settle(md);
    // The serializer no longer changes it...
    expect(canonicalizeMd(settled)).toBe(settled);
    // ...and normalizeMd agrees, so the flush sees "no change" and writes
    // nothing. This is the assertion that forbids the spurious-version loop.
    expect(normalizeMd(settled)).toBe(settled);
  });
});

describe("codeFence", () => {
  it("uses three backticks when the body has none", () => {
    expect(codeFence(["const x = 1;"])).toBe("```");
  });

  it("outgrows a fence inside the body", () => {
    expect(codeFence(["```"])).toBe("````");
    expect(codeFence(["a", "`````", "b"])).toBe("``````");
  });

  it("ignores backticks that are not at the start of a line", () => {
    expect(codeFence(["a ``` b"])).toBe("```");
  });

  it("keeps a fenced block containing a fence intact through a round trip", () => {
    const md = "````\n```\ninner\n```\n````";
    const back = docToMd(mdToDoc(md));
    // The inner fence must still be CONTENT, not a block terminator.
    expect(mdToDoc(back)).toEqual(mdToDoc(md));
    expect(back).toContain("inner");
  });
});

describe("html is never nodes", () => {
  // The dashboard's render boundary treats untrusted markdown as text. The
  // editor runs `html: false`, so raw HTML in a body
  // survives as escaped text rather than becoming a script-bearing node.
  it("escapes raw html to text", () => {
    const doc = mdToDoc("<script>alert(1)</script>");
    const json = JSON.stringify(doc);
    expect(json).not.toContain('"type":"script"');
    expect(docToMd(doc)).toContain("script");
  });
});
