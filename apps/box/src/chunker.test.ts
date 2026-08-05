import { describe, expect, it } from "vitest";

import { chunkBody } from "./chunker.js";
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
