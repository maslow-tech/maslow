import { describe, expect, it } from "vitest";
import type { Attribution } from "./provenance";
import { rehypeAttributionSpans, type HastNode } from "./rehypeAttributionSpans";

function attribution(reason: string): Attribution {
  return { actor: "alice", actorName: "alice", at: "2026-01-01T00:00:00Z", reason };
}

function textNode(value: string, start: number): HastNode {
  return {
    type: "text",
    value,
    position: { start: { offset: start }, end: { offset: start + value.length } },
  };
}

function root(children: HastNode[]): HastNode {
  return { type: "root", children };
}

describe("rehypeAttributionSpans", () => {
  it("leaves a text node untouched when no run overlaps it", () => {
    const tree = root([textNode("hello", 0)]);
    rehypeAttributionSpans([])(tree);
    expect(tree.children).toEqual([textNode("hello", 0)]);
  });

  it("wraps a text node fully covered by one attributed run in a single span", () => {
    const a = attribution("start");
    const tree = root([textNode("hello", 0)]);
    rehypeAttributionSpans([{ start: 0, end: 5, text: "hello", attribution: a }])(tree);
    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "span",
        properties: { id: "run-0" },
        children: [{ type: "text", value: "hello" }],
      },
    ]);
  });

  it("splits a text node that straddles two runs into two spans, no per-word granularity beyond the runs", () => {
    const a = attribution("start");
    const b = attribution("added greeting");
    // "hello world" as ONE hast text node (e.g. inside a <p>), split at the run boundary.
    const tree = root([textNode("hello world", 0)]);
    rehypeAttributionSpans([
      { start: 0, end: 5, text: "hello", attribution: a },
      { start: 5, end: 11, text: " world", attribution: b },
    ])(tree);
    expect(tree.children).toHaveLength(2);
    expect(tree.children![0]).toEqual({
      type: "element",
      tagName: "span",
      properties: { id: "run-0" },
      children: [{ type: "text", value: "hello" }],
    });
    expect(tree.children![1]).toEqual({
      type: "element",
      tagName: "span",
      properties: { id: "run-1" },
      children: [{ type: "text", value: " world" }],
    });
  });

  it("does not wrap the portion of a run with a null attribution", () => {
    const tree = root([textNode("hello", 0)]);
    rehypeAttributionSpans([{ start: 0, end: 5, text: "hello", attribution: null }])(tree);
    expect(tree.children).toEqual([{ type: "text", value: "hello" }]);
  });

  it("recurses into element children (e.g. a <strong> inside a <p>) and preserves structure", () => {
    const a = attribution("start");
    // Source: "plain **bold**" — position offsets point at the STRIPPED text
    // span inside <strong> ("bold", offset 8-12), not the raw "**bold**".
    const tree: HastNode = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [
            textNode("plain ", 0),
            {
              type: "element",
              tagName: "strong",
              children: [textNode("bold", 8)],
            },
          ],
        },
      ],
    };
    rehypeAttributionSpans([{ start: 0, end: 12, text: "plain **bold**", attribution: a }])(tree);
    const p = tree.children![0]!;
    expect(p.tagName).toBe("p");
    expect(p.children![0]).toEqual({
      type: "element",
      tagName: "span",
      properties: { id: "run-0" },
      children: [{ type: "text", value: "plain " }],
    });
    const strong = p.children![1]!;
    expect(strong.tagName).toBe("strong");
    expect(strong.children![0]).toEqual({
      type: "element",
      tagName: "span",
      properties: { id: "run-0" },
      children: [{ type: "text", value: "bold" }],
    });
  });

  it("a text node with no position info is left as-is instead of crashing", () => {
    const tree = root([{ type: "text", value: "no position" }]);
    rehypeAttributionSpans([
      { start: 0, end: 11, text: "no position", attribution: attribution("x") },
    ])(tree);
    expect(tree.children).toEqual([{ type: "text", value: "no position" }]);
  });
});
