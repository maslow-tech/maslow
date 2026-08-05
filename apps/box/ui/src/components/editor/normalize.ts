/**
 * `normalizeMd` — THE markdown normalization contract.
 *
 * Markdown is canonical at rest (the `objects.body` column). Two very
 * different producers write it:
 *
 *   1. the TipTap editor, which serializes a ProseMirror doc through
 *      tiptap-markdown (`docToMd` in ./markdown.ts), and
 *   2. everything else — MCP `write`/`edit`, imports, humans pasting — which
 *      writes whatever markdown it likes.
 *
 * Phase 2's collab flush serializes the CRDT to markdown and CAS-writes it. If
 * it cannot tell "the serializer's spelling of the stored body" from "a real
 * edit", every flush cycle writes a new version for a document nobody touched.
 * `normalizeMd(stored)` is how it tells: flush writes only when the serialized
 * output differs from `normalizeMd(stored)`.
 *
 * THE INVARIANT (asserted by markdown.test.ts, and the reason this file is
 * pure and dependency-free so the box server can import it too):
 *
 *     normalizeMd MUST NEVER CLAIM MORE THAN THE SERIALIZER DOES.
 *
 * Under-normalizing is safe — the flush writes one extra version the first
 * time a non-canonical body is opened, and the document is stable from then
 * on. Over-normalizing is NOT safe: it would report "no change" for a body the
 * serializer would in fact rewrite, and the two producers would fight forever.
 * So every rule below is one that was measured against the real serializer and
 * pinned by a fixture; anything unmeasured is deliberately left alone.
 *
 * Known deliberate non-rules (measured divergences, documented in
 * markdown.test.ts under "known gaps"): inline emphasis spelling (`_x_` vs
 * `*x*`), inline escaping (a bare `*` in prose comes back `\*`), raw HTML
 * (escaped to text because the editor runs `html: false`), table column
 * alignment and code-fence info strings past the language (both dropped by the
 * serializer). Those all cost at most one settling version.
 *
 * This module is intentionally standalone: no React, no TipTap, no
 * ProseMirror, no markdown-it. `apps/box/src` can import it directly.
 */

type Block =
  | { k: "para"; lines: string[] }
  | { k: "heading"; level: number; text: string }
  | { k: "code"; info: string; lines: string[] }
  | { k: "hr" }
  | { k: "quote"; blocks: Block[] }
  | { k: "list"; ordered: boolean; start: number; loose: boolean; items: Item[] }
  | { k: "table"; rows: string[][] }
  | { k: "raw"; lines: string[] };

type Item = { task: "unchecked" | "checked" | null; blocks: Block[] };

const RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RE_FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*(.*)$/;
const RE_BULLET = /^([ \t]*)([-*+])([ \t]+|$)(.*)$/;
const RE_ORDERED = /^([ \t]*)(\d{1,9})([.)])([ \t]+|$)(.*)$/;
const RE_TASK = /^\[([ xX])\](?:[ \t]+|$)(.*)$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

/**
 * Trim MARKDOWN whitespace — space, tab, CR, LF and nothing else.
 *
 * `String.prototype.trim()` also strips U+00A0 (nbsp), U+FEFF (BOM) and the
 * other Unicode space separators, which markdown treats as ordinary text and
 * the serializer therefore preserves. Using it on content would delete a
 * character the serializer keeps — an over-claim, and the one failure mode
 * this module must never have.
 */
const trimMd = (s: string): string => s.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");

const isBlank = (l: string): boolean => trimMd(l) === "";
const indentOf = (l: string): number => l.length - l.replace(/^[ \t]*/, "").length;

/** Normalize `md` into the exact spelling the TipTap serializer emits. */
export function normalizeMd(md: string): string {
  // NOTE: a leading BOM is deliberately NOT stripped. The serializer keeps it
  // (and escapes the `#` behind it, since the BOM stops the line being a
  // heading); claiming it away here would over-normalize.
  const src = md.replace(/\r\n?/g, "\n");
  const blocks = parseBlocks(src.split("\n"));
  const out = renderBlocks(blocks);
  // A table is the one block the serializer terminates with its own newline,
  // which only shows at the end of the document (mid-document it is absorbed
  // by the paragraph separator).
  const last = blocks[blocks.length - 1];
  return last && last.k === "table" && out !== "" ? `${out}\n` : out;
}

/**
 * The opening/closing fence for a code block whose body is `lines`.
 *
 * CommonMark closes a fenced block on a line-leading run of the same character
 * at least as long as the opener, so a body containing a ``` line needs a
 * longer fence or the block ends early and the remainder silently becomes
 * prose. Exported because the TipTap serializer uses this exact function (see
 * FencedCodeBlock in ./markdown.ts) — the two must agree byte for byte.
 */
export function codeFence(lines: string[]): string {
  let need = 3;
  for (const l of lines) {
    const run = /^ {0,3}(`+)/.exec(l);
    if (run?.[1] && run[1].length + 1 > need) need = run[1].length + 1;
  }
  return "`".repeat(need);
}

/* ------------------------------------------------------------------ parsing */

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = RE_FENCE.exec(line);
    if (fence && indentOf(line) < 4) {
      const [, , marker = "```", info = ""] = fence;
      const close = new RegExp(
        `^[ \\t]*${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`,
      );
      const body: string[] = [];
      const strip = indentOf(line);
      i++;
      while (i < lines.length && !close.test(lines[i] ?? "")) {
        body.push(dedent(lines[i] ?? "", strip));
        i++;
      }
      if (i < lines.length) i++; // closing fence
      // A code node's textContent has no trailing newline, so trailing blank
      // lines inside the fence do not survive the round trip.
      while (body.length && isBlank(body[body.length - 1] ?? "")) body.pop();
      blocks.push({ k: "code", info: trimMd(info).split(/\s+/)[0] ?? "", lines: body });
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push({ k: "hr" });
      i++;
      continue;
    }

    const atx = RE_ATX.exec(line);
    if (atx) {
      const level = (atx[1] ?? "#").length;
      // Closing sequence (`## Title ##`) is decoration, not content.
      const text = trimMd((atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, ""));
      blocks.push({ k: "heading", level, text });
      i++;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(/^ {0,3}>[ ]?/, ""));
        i++;
        // Lazy continuation: an unprefixed, non-blank line keeps the quote.
        while (
          i < lines.length &&
          !isBlank(lines[i] ?? "") &&
          !/^ {0,3}>/.test(lines[i] ?? "") &&
          !startsNewBlock(lines[i] ?? "")
        ) {
          inner.push(lines[i] ?? "");
          i++;
        }
      }
      blocks.push({ k: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const rows: string[][] = [];
      while (i < lines.length && /^[ \t]*\|/.test(lines[i] ?? "")) {
        const raw = lines[i] ?? "";
        i++;
        if (RE_TABLE_DELIM.test(raw) && raw.includes("-")) continue; // delimiter row
        rows.push(splitRow(raw));
      }
      blocks.push({ k: "table", rows });
      continue;
    }

    const listStart = RE_BULLET.exec(line) ?? RE_ORDERED.exec(line);
    if (listStart && indentOf(line) < 4) {
      const consumed = parseList(lines, i);
      blocks.push(consumed.block);
      i = consumed.next;
      continue;
    }

    if (indentOf(line) >= 4 && line.startsWith("    ")) {
      // Indented code block — the serializer only knows fences.
      const body: string[] = [];
      while (i < lines.length && (isBlank(lines[i] ?? "") || (lines[i] ?? "").startsWith("    "))) {
        body.push((lines[i] ?? "").replace(/^ {4}/, ""));
        i++;
      }
      while (body.length && isBlank(body[body.length - 1] ?? "")) body.pop();
      blocks.push({ k: "code", info: "", lines: body });
      continue;
    }

    // Paragraph — runs until a blank line or a line that opens another block.
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i] ?? "")) {
      const next = lines[i] ?? "";
      const setext = RE_SETEXT.exec(next);
      if (setext && para.length >= 1) {
        blocks.push({
          k: "heading",
          level: (setext[1] ?? "=").startsWith("=") ? 1 : 2,
          text: para.map(trimMd).join(" "),
        });
        i++;
        para.length = 0;
        break;
      }
      if (startsNewBlock(next)) break;
      para.push(next);
      i++;
    }
    if (para.length) blocks.push({ k: "para", lines: para });
  }
  return blocks;
}

/** Does this line open a block that interrupts a paragraph? */
function startsNewBlock(line: string): boolean {
  if (indentOf(line) >= 4) return false;
  if (RE_HR.test(line)) return true;
  if (RE_ATX.test(line)) return true;
  if (RE_FENCE.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (RE_BULLET.test(line)) return true;
  // Only `1.`-style ordered items interrupt a paragraph (CommonMark).
  const ord = RE_ORDERED.exec(line);
  if (ord && ord[2] === "1") return true;
  return false;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i] ?? "";
  const delim = lines[i + 1] ?? "";
  return (
    /^[ \t]*\|/.test(head) &&
    /^[ \t]*\|?[ \t]*:?-/.test(delim) &&
    RE_TABLE_DELIM.test(delim) &&
    delim.includes("-")
  );
}

function splitRow(raw: string): string[] {
  const trimmed = trimMd(raw).replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(trimMd);
}

function dedent(line: string, n: number): string {
  let out = line;
  for (let k = 0; k < n && (out.startsWith(" ") || out.startsWith("\t")); k++) out = out.slice(1);
  return out;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = lines[start] ?? "";
  const ordered = RE_ORDERED.test(first) && !RE_BULLET.test(first);
  let baseIndent = indentOf(first);
  const items: Item[] = [];
  let loose = false;
  let listStart = 1;
  let i = start;
  let sawBlank = false;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isBlank(line)) {
      // A blank line only continues the list if the next non-blank line is
      // still inside it; either way it makes the list loose.
      let j = i;
      while (j < lines.length && isBlank(lines[j] ?? "")) j++;
      const after = lines[j];
      if (after === undefined) break;
      const cont =
        indentOf(after) > baseIndent ||
        (indentOf(after) <= baseIndent && matchesMarker(after, ordered));
      if (!cont) break;
      sawBlank = true;
      i = j;
      continue;
    }
    const m = matchesMarker(line, ordered);
    // An ordered list whose numbers widen mid-run is RIGHT-ALIGNED by the
    // serializer (` 9.` / `10.`), so a sibling item can be LESS indented than
    // the first one. Treating that as a dedent ends the list early and the
    // remainder re-parses as a second, loose list — which is a flush loop,
    // because that is the serializer's own output being mis-read. A line that
    // carries a sibling marker is a sibling; the list's base indent is the
    // narrowest one seen.
    if (!m) break;
    if (indentOf(line) < baseIndent) baseIndent = indentOf(line);

    if (items.length === 0 && ordered) listStart = Number(m.number ?? "1");
    if (sawBlank) loose = true;

    // Collect this item's lines: the remainder of the marker line plus every
    // following line indented past the marker (or lazily continuing it).
    const contentIndent = baseIndent + m.markerWidth;
    const body: string[] = [m.rest];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (isBlank(next)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j] ?? "")) j++;
        const after = lines[j];
        if (after === undefined) break;
        if (indentOf(after) >= contentIndent) {
          loose = true;
          for (let k = i; k < j; k++) body.push("");
          i = j;
          continue;
        }
        break;
      }
      if (indentOf(next) >= contentIndent) {
        body.push(dedent(next, contentIndent));
        i++;
        continue;
      }
      if (!matchesMarker(next, ordered) && !startsNewBlock(next) && indentOf(next) >= baseIndent) {
        body.push(trimMd(next)); // lazy continuation
        i++;
        continue;
      }
      break;
    }

    const taskMatch = RE_TASK.exec(body[0] ?? "");
    let task: Item["task"] = null;
    if (!ordered && taskMatch) {
      task = (taskMatch[1] ?? " ").toLowerCase() === "x" ? "checked" : "unchecked";
      body[0] = taskMatch[2] ?? "";
    }
    // Looseness comes from blank lines only. A sublist that follows its
    // parent's paragraph without a blank line makes the item multi-block but
    // NOT loose — the serializer keeps `- a\n  - b` tight, and claiming loose
    // here would rewrite every nested list on its first flush.
    const blocks = parseBlocks(body);
    items.push({ task, blocks });
    sawBlank = false;
  }

  return { block: { k: "list", ordered, start: listStart, loose, items }, next: i };
}

function matchesMarker(
  line: string,
  ordered: boolean,
): { markerWidth: number; rest: string; number?: string } | null {
  if (ordered) {
    const m = RE_ORDERED.exec(line);
    if (!m) return null;
    const spaces = (m[4] ?? " ").length || 1;
    return {
      markerWidth: (m[2] ?? "").length + 1 + spaces,
      rest: m[5] ?? "",
      ...(m[2] !== undefined ? { number: m[2] } : {}),
    };
  }
  const m = RE_BULLET.exec(line);
  if (!m) return null;
  const spaces = (m[3] ?? " ").length || 1;
  return { markerWidth: 1 + spaces, rest: m[4] ?? "" };
}

/* ----------------------------------------------------------------- printing */

function renderBlocks(blocks: Block[]): string {
  return blocks
    .map(renderBlock)
    .filter((s) => s !== "")
    .join("\n\n");
}

/**
 * A list item's own blocks. Same as renderBlocks except that a tight sublist
 * hugs the paragraph above it (`- a\n  - b`, no blank line) — that is what the
 * serializer emits, and a blank line here would rewrite every nested list.
 */
function renderItemBlocks(blocks: Block[]): string {
  let out = "";
  let prev: Block | undefined;
  for (const b of blocks) {
    const text = renderBlock(b);
    if (text === "") continue;
    if (out !== "") out += prev && b.k === "list" && !b.loose ? "\n" : "\n\n";
    out += text;
    prev = b;
  }
  return out;
}

function renderBlock(b: Block): string {
  switch (b.k) {
    case "para":
      return renderPara(b.lines);
    case "heading":
      // No trimEnd: an empty heading serializes as `# ` (marker + separator),
      // and trimming to `#` would over-claim against the serializer.
      return `${"#".repeat(b.level)} ${b.text}`;
    case "code": {
      const fence = codeFence(b.lines);
      return [`${fence}${b.info}`, ...b.lines, fence].join("\n");
    }
    case "hr":
      return "---";
    case "quote":
      return renderBlocks(b.blocks)
        .split("\n")
        .map((l) => (l === "" ? ">" : `> ${l}`))
        .join("\n");
    case "list":
      return renderList(b);
    case "table":
      return renderTable(b.rows);
    case "raw":
      return b.lines.join("\n");
  }
}

function renderPara(lines: string[]): string {
  const parts: string[] = [];
  lines.forEach((raw, idx) => {
    const last = idx === lines.length - 1;
    const hard = !last && (/ {2,}$/.test(raw) || /\\$/.test(raw.trimEnd()));
    // Only strip the backslash when it actually IS a hard break. A trailing
    // backslash on the final line is literal text (the serializer escapes it
    // to `\\`), so dropping it here would delete a character.
    const text = hard ? trimMd(raw).replace(/\\$/, "") : trimMd(raw);
    parts.push(text + (last ? "" : hard ? "\\\n" : " "));
  });
  return parts.join("").trimEnd();
}

function renderList(b: Extract<Block, { k: "list" }>): string {
  // taskList and bulletList are different node types, so a markdown list that
  // mixes `- [ ] todo` with plain `- item` parses as SEVERAL adjacent lists
  // and serializes with a blank line between each run. Segment here or every
  // mixed list gets rewritten on its first flush.
  if (!b.ordered) {
    const runs: Item[][] = [];
    for (const item of b.items) {
      const last = runs[runs.length - 1];
      if (last && (last[0]?.task === null) === (item.task === null)) last.push(item);
      else runs.push([item]);
    }
    if (runs.length > 1) return runs.map((items) => renderList({ ...b, items })).join("\n\n");
  }

  const width = b.ordered ? String(b.start + b.items.length - 1).length : 0;
  const rendered = b.items.map((item, idx) => {
    let marker: string;
    let indent: number;
    if (b.ordered) {
      const n = String(b.start + idx);
      marker = `${" ".repeat(width - n.length)}${n}. `;
      indent = width + 2;
    } else {
      marker = "- ";
      indent = 2;
    }
    const check = item.task ? `[${item.task === "checked" ? "x" : " "}] ` : "";
    const body = renderItemBlocks(item.blocks);
    if (body === "") return `${marker}${check}`.trimEnd() + (check ? "" : " ");
    const pad = " ".repeat(indent);
    const [head = "", ...rest] = `${check}${body}`.split("\n");
    return [`${marker}${head}`, ...rest.map((l) => (l === "" ? "" : `${pad}${l}`))].join("\n");
  });
  return rendered.join(b.loose ? "\n\n" : "\n");
}

function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]): string => {
    const padded = [...cells];
    while (padded.length < cols) padded.push("");
    return `| ${padded.join(" | ")} |`;
  };
  const [head = [], ...body] = rows;
  return [
    line(head),
    `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}
