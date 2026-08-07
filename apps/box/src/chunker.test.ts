import { describe, expect, it } from "vitest";

import { chunkBody, splitSentences } from "./chunker.js";
import { chunkObject } from "./embedder.js";

const para = (words: number, tag: string): string =>
  Array.from({ length: words }, (_, i) => `${tag}${i}`).join(" ");

describe("chunker", () => {
  it("empty and whitespace bodies produce no chunks", () => {
    expect(chunkBody("")).toEqual([]);
    expect(chunkBody("  \n\n  ")).toEqual([]);
  });

  it("a short body is a single chunk, verbatim", () => {
    const chunks = chunkBody("A note about billing ownership.");
    expect(chunks).toEqual([{ ix: 0, text: "A note about billing ownership." }]);
  });

  it("a long body splits into overlapping chunks that cover every word", () => {
    const paras = [para(120, "a"), para(120, "b"), para(120, "c"), para(120, "d")];
    const chunks = chunkBody(paras.join("\n\n"));
    expect(chunks.length).toBeGreaterThan(1);
    // sequential ix
    chunks.forEach((c, i) => expect(c.ix).toBe(i));
    // no content lost: every source word appears in some chunk
    const all = chunks.map((c) => c.text).join(" ");
    for (const p of paras) for (const w of p.split(" ")) expect(all).toContain(w);
    // overlap: some tail words of chunk 0 reappear in chunk 1
    const tail = chunks[0]!.text.split(/\s+/).slice(-10);
    for (const w of tail) expect(chunks[1]!.text).toContain(w);
  });

  it("an oversized single paragraph still splits (sentences, then words)", () => {
    const oneSentence = para(800, "w"); // no sentence delimiters at all
    const chunks = chunkBody(oneSentence);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect((c.text.match(/\S+/g) ?? []).length).toBeLessThanOrEqual(360);
    }
  });

  it("is deterministic", () => {
    const body = `${para(200, "x")}\n\n${para(200, "y")}\n\n${para(200, "z")}`;
    expect(chunkBody(body)).toEqual(chunkBody(body));
  });
});

describe("chunkObject", () => {
  it("a title-only object still gets one chunk (people must be findable)", () => {
    const chunks = chunkObject("Priya Patel", null);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("Priya Patel");
    expect(chunks[0]!.embedInput).toContain("Priya Patel");
  });

  it("prepends the title to every chunk's embed input, not its stored text", () => {
    const chunks = chunkObject("Q3 planning", `${para(120, "a")}\n\n${para(400, "b")}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.embedInput.startsWith("Q3 planning")).toBe(true);
      expect(c.text.startsWith("Q3 planning")).toBe(false);
    }
  });

  it("empty title and body produce nothing", () => {
    expect(chunkObject(null, null)).toEqual([]);
    expect(chunkObject(" ", "")).toEqual([]);
  });
});

/**
 * `splitSentences` replaced a polynomial-backtracking regex. CHUNKER_VERSION
 * pins its output forever (a drift silently re-embeds the whole fleet), so it
 * is asserted against the exact pattern it replaced — including the cases where
 * that pattern dropped characters.
 */
const legacySplit = (paragraph: string): string[] =>
  paragraph.match(/[^.!?\n]+[.!?]+[\s]*|[^.!?\n]+$/g) ?? [paragraph];

describe("splitSentences — byte-identical to the regex it replaced", () => {
  const cases = [
    "",
    " ",
    "One sentence.",
    "One. Two. Three.",
    "One!! Two?? Three...",
    "No terminator at all",
    "Trailing spaces after the dot.   ",
    "  leading space then text.",
    ".leading terminator",
    "!!!",
    "...tail",
    "a.b.c",
    "Ends with a newline.\n",
    "one\ntwo. three.", // a bare newline: the regex dropped "one\n"
    "one\ntwo\nthree", // every run ends at a newline except the last
    "\n\n\n",
    "Sentence one.\nSentence two.",
    "Sentence one. \n\t Sentence two.",
    "unicode — em dash, ellipsis… then a stop.",
    "tabs\tinside a sentence.",
    "http://example.com/a.b path.",
    para(50, "w"),
    `${para(50, "w")}.`,
    `${para(30, "a")}. ${para(30, "b")}!`,
  ];

  for (const s of cases) {
    it(`matches on ${JSON.stringify(s.length > 40 ? s.slice(0, 40) + "…" : s)}`, () => {
      expect(splitSentences(s)).toEqual(legacySplit(s));
    });
  }

  it("falls back to the whole paragraph when nothing matched", () => {
    expect(splitSentences("...")).toEqual(["..."]);
    expect(splitSentences("")).toEqual([""]);
  });

  it("stays linear on a long terminator-free run (the ReDoS shape)", () => {
    const s = "x".repeat(200_000);
    expect(splitSentences(s)).toEqual([s]);
  });

  it("stays linear on a long run that ends at a newline (the no-match branch)", () => {
    const s = `${"x".repeat(200_000)}\n`;
    expect(splitSentences(s)).toEqual([s]);
  });
});
