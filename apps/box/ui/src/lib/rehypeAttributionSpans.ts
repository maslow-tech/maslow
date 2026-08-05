import type { AttributionRun } from "./provenance";

/**
 * Minimal structural shape we need from a hast tree — deliberately not the
 * real `hast` package types (not a direct dependency here; react-markdown
 * pulls it in transitively). We only read/write `type`, `children`, `value`,
 * and `position.*.offset`, so a narrow local type is safer than reaching for
 * a package that may not resolve under pnpm's strict workspace linking.
 */
export interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/**
 * A rehype plugin (factory, per unified's convention) that wraps the parts of
 * rendered text overlapping an attribution run in a `<span id="run-N">` — real
 * markdown stays real markdown (headings, bold, lists, links all render), and
 * hover granularity is one span per contiguous same-origin run, not per word.
 *
 * Relies on remark/rehype's default behavior of keeping `position.*.offset`
 * on text nodes, which are offsets into the ORIGINAL markdown source string
 * (the same string `attributionRuns` tokenized) — so a run's [start, end) and
 * a text node's [start, end) share one coordinate space and can be overlapped
 * directly, even though the text node's VALUE has already had markdown syntax
 * (`**`, `#`, …) stripped by the parser. One known imprecision: escaped
 * characters/entities (`\*`, `&amp;`) shift a node's value length out of sync
 * with its source span, which can nudge a run boundary by a character or two
 * inside that node — rare, and self-correcting since the split still stays
 * inside the same node.
 */
export function rehypeAttributionSpans(runs: readonly AttributionRun[]) {
  const indexOf = new Map<AttributionRun, number>(runs.map((r, i) => [r, i]));

  return (tree: HastNode) => {
    walk(tree);
  };

  function walk(node: HastNode): void {
    if (!node.children) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "text") {
        next.push(...splitText(child));
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  }

  function splitText(textNode: HastNode): HastNode[] {
    const start = textNode.position?.start?.offset;
    const end = textNode.position?.end?.offset;
    const value = textNode.value ?? "";
    if (start === undefined || end === undefined || runs.length === 0) return [textNode];

    const overlapping = runs.filter((r) => r.start < end && r.end > start);
    if (overlapping.length === 0) return [textNode];

    const pieces: HastNode[] = [];
    let cursor = start;
    for (const run of overlapping) {
      const segStart = Math.max(cursor, run.start);
      const segEnd = Math.min(end, run.end);
      if (segStart >= segEnd) continue;
      const segText = value.slice(segStart - start, segEnd - start);
      if (!segText) continue;
      pieces.push(
        run.attribution
          ? {
              type: "element",
              tagName: "span",
              properties: { id: `run-${indexOf.get(run)}` },
              children: [{ type: "text", value: segText }],
            }
          : { type: "text", value: segText },
      );
      cursor = segEnd;
    }
    if (cursor < end) pieces.push({ type: "text", value: value.slice(cursor - start) });
    return pieces;
  }
}
