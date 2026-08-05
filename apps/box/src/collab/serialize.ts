import * as Y from "yjs";

/**
 * markdown ↔ Yjs, the round-trip contract of the collab engine.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 *
 * Markdown in `objects.body` is the single source of truth AT REST; a live room
 * holds the same content as a CRDT. Every flush serializes the CRDT back to
 * markdown and CAS-writes it — but ONLY when the result differs from the stored
 * body's canonical spelling. So the two directions have to be exact inverses:
 *
 *     docToMarkdown(seedDocFromMarkdown(x)) === normalizeMarkdown(x)
 *
 * If they disagree by so much as a space, every flush cycle writes a new
 * version, a new history row and a new audit event for a document NOBODY
 * touched — on every open object, forever. That is the failure this module is
 * built to make impossible, and `serialize.test.ts` asserts the identity over
 * the same fixture corpus the client's `markdown.test.ts` uses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT DOES NOT IMPORT THE CLIENT'S markdown.ts
 *
 * The client canonicalizes through TipTap (`docToMd(mdToDoc(x))`, which needs
 * ProseMirror and a DOM-ish environment) and predicts that spelling with the
 * pure `normalizeMd` (apps/box/ui/src/components/editor/normalize.ts). The box
 * server has neither TipTap nor a DOM, and `apps/box/tsconfig.json` pins
 * `rootDir: src`, so it cannot import across into `ui/`.
 *
 * So the BLOCK grammar below is a deliberate, faithful port of that
 * `normalize.ts` — same parse, same printer, same measured quirks — and
 * `serialize.test.ts` imports the client module to assert byte-for-byte
 * agreement on every fixture. That test is the drift detector: if either copy
 * changes, it fails there rather than in a customer's version history.
 *
 * The INLINE layer (marks, links, images, escaping) is new: `normalize.ts`
 * passes inline text through untouched because it only has to PREDICT the
 * serializer, whereas a Yjs doc must hold real `bold`/`italic`/`code`/`strike`/
 * `link` marks or the editor would show a member their own `**asterisks**`.
 * Its rules are prosemirror-markdown's (escape set, `isPlainURL` autolinks,
 * `code` excluding every other mark), so the two producers spell inline
 * markdown the same way.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DOC SHAPE (spec, phase 2 "CRDT scope")
 *
 * ONE Y.Doc per object: `body` as a Y.XmlFragment (the TipTap binding) and
 * `title` as a Y.Text. Everything else — props, links, visibility — stays on
 * CAS, because single-value fields do not want CRDT semantics and keeping them
 * out keeps the audit trail readable.
 *
 * The fragment is written in y-prosemirror's shape (one Y.XmlElement per
 * ProseMirror node, node attrs as element attributes, runs of inline text as
 * one Y.XmlText with marks as formatting attributes), because the client binds
 * it with y-prosemirror. A different shape would not error — it would render as
 * an empty document.
 */

/** The Y.Doc keys. Both sides must agree; they are part of the wire contract. */
export const BODY_FRAGMENT = "body";
export const TITLE_TEXT = "title";

/* ========================================================================== *
 * Block grammar — ported from apps/box/ui/src/components/editor/normalize.ts *
 * ========================================================================== */

type Block =
  | { k: "para"; text: string }
  | { k: "heading"; level: number; text: string }
  | { k: "code"; info: string; lines: string[] }
  | { k: "hr" }
  | { k: "quote"; blocks: Block[] }
  | { k: "list"; ordered: boolean; start: number; loose: boolean; items: Item[] }
  | { k: "table"; rows: string[][] };

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
 * `String.prototype.trim()` also strips U+00A0 and U+FEFF, which markdown
 * treats as ordinary text; using it here would delete a character the
 * serializer keeps.
 */
const trimMd = (s: string): string => s.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");

const isBlank = (l: string): boolean => trimMd(l) === "";
const indentOf = (l: string): number => l.length - l.replace(/^[ \t]*/, "").length;

/**
 * The canonical markdown for an arbitrary body — the server-side twin of the
 * client's `normalizeMd`. The flush compares its serialized CRDT against THIS,
 * not against the raw stored bytes, and writes only on a real difference.
 */
export function normalizeMarkdown(md: string): string {
  // NOTE: a leading BOM is deliberately NOT stripped (see normalize.ts).
  const src = md.replace(/\r\n?/g, "\n");
  return renderDocument(parseBlocks(src.split("\n")));
}

/**
 * The opening/closing fence for a code block whose body is `lines`. CommonMark
 * closes a fenced block on a line-leading run of the same character at least as
 * long as the opener, so a body containing a ``` line needs a longer fence or
 * the block ends early and the remainder silently becomes prose.
 */
function codeFence(lines: string[]): string {
  let need = 3;
  for (const l of lines) {
    const run = /^ {0,3}(`+)/.exec(l);
    if (run?.[1] && run[1].length + 1 > need) need = run[1].length + 1;
  }
  return "`".repeat(need);
}

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
      // A code node's textContent has no trailing newline.
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
    // Unlike normalize.ts this folds the paragraph's lines into their FINAL
    // spelling here (soft breaks become spaces, hard breaks `\` + newline),
    // because the fragment builder needs one inline string per paragraph and
    // the printer must stay a pure function of the block tree.
    if (para.length) blocks.push({ k: "para", text: renderPara(para) });
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
    // printer (` 9.` / `10.`), so a sibling item can be LESS indented than the
    // first one; treating that as a dedent would end the list early and the
    // remainder would re-parse as a second, loose list — a flush loop.
    if (!m) break;
    if (indentOf(line) < baseIndent) baseIndent = indentOf(line);

    if (items.length === 0 && ordered) listStart = Number(m.number ?? "1");
    if (sawBlank) loose = true;

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
    // Looseness comes from blank lines only: `- a\n  - b` stays tight.
    items.push({ task, blocks: parseBlocks(body) });
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

function renderDocument(blocks: Block[]): string {
  const out = renderBlocks(blocks);
  // A table is the one block the serializer terminates with its own newline,
  // which only shows at the end of the document.
  const last = blocks[blocks.length - 1];
  return last && last.k === "table" && out !== "" ? `${out}\n` : out;
}

function renderBlocks(blocks: Block[]): string {
  return blocks
    .map(renderBlock)
    .filter((s) => s !== "")
    .join("\n\n");
}

/**
 * A list item's own blocks. Same as renderBlocks except that a tight sublist
 * hugs the paragraph above it (`- a\n  - b`, no blank line).
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
      return b.text;
    case "heading":
      // No trimEnd: an empty heading serializes as `# ` (marker + separator).
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
  }
}

function renderPara(lines: string[]): string {
  const parts: string[] = [];
  lines.forEach((raw, idx) => {
    const last = idx === lines.length - 1;
    const hard = !last && (/ {2,}$/.test(raw) || /\\$/.test(raw.trimEnd()));
    // Only strip the backslash when it actually IS a hard break: a trailing
    // backslash on the final line is literal text.
    const text = hard ? trimMd(raw).replace(/\\$/, "") : trimMd(raw);
    parts.push(text + (last ? "" : hard ? "\\\n" : " "));
  });
  return parts.join("").trimEnd();
}

/** Split a bullet list into runs of task / non-task items (see renderList). */
function listRuns(items: Item[]): Item[][] {
  const runs: Item[][] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last && (last[0]?.task === null) === (item.task === null)) last.push(item);
    else runs.push([item]);
  }
  return runs;
}

function renderList(b: Extract<Block, { k: "list" }>): string {
  // taskList and bulletList are different node types, so a markdown list that
  // mixes `- [ ] todo` with plain `- item` is SEVERAL adjacent lists.
  if (!b.ordered) {
    const runs = listRuns(b.items);
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

/* ========================================================================== *
 * Inline grammar — marks, links, images, escaping                            *
 * ========================================================================== */

type InlineMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "code" }
  | { type: "strike" }
  | { type: "link"; href: string; title?: string };

type InlineNode =
  | { kind: "text"; text: string; marks: InlineMark[] }
  | { kind: "image"; src: string; alt: string; title?: string }
  /** A hard break — `\` + newline in markdown, a `hardBreak` node in the doc. */
  | { kind: "break" };

/**
 * ProseMirror's `code` mark excludes every other mark (TipTap's Code sets
 * `excludes: "_"`), so a code span inside a link keeps the code and loses the
 * link. Matching that HERE rather than storing a richer doc is deliberate: a
 * mark combination the client's schema cannot represent would be silently
 * dropped the first time a member typed in the room, and the next flush would
 * write it back as a "change" nobody made.
 */
const MARK_ORDER: InlineMark["type"][] = ["link", "bold", "italic", "strike", "code"];

function canonicalMarks(marks: readonly InlineMark[]): InlineMark[] {
  const code = marks.find((m) => m.type === "code");
  if (code) return [code];
  const out: InlineMark[] = [];
  for (const type of MARK_ORDER) {
    const found = marks.find((m) => m.type === type);
    if (found) out.push(found);
  }
  return out;
}

function sameMark(a: InlineMark, b: InlineMark): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "link" && b.type === "link") return a.href === b.href && a.title === b.title;
  return true;
}

/** Punctuation a backslash may escape (CommonMark's ASCII punctuation set). */
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * Parse one run of inline markdown into nodes. Deliberately conservative: a
 * construct is only recognized when `serializeInline` can spell it back
 * byte-identically, so anything ambiguous stays literal text rather than
 * becoming a mark that rewrites the body on the next flush.
 */
export function parseInline(src: string): InlineNode[] {
  const out: InlineNode[] = [];
  walkInline(src, [], out);
  return out;
}

function walkInline(src: string, marks: InlineMark[], out: InlineNode[]): void {
  let buf = "";
  let i = 0;
  const flush = (): void => {
    if (buf === "") return;
    out.push({ kind: "text", text: buf, marks: canonicalMarks(marks) });
    buf = "";
  };

  while (i < src.length) {
    const ch = src[i] ?? "";

    if (ch === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) {
      buf += src[i + 1] ?? "";
      i += 2;
      continue;
    }

    if (ch === "`") {
      const span = matchCodeSpan(src, i);
      if (span) {
        flush();
        out.push({
          kind: "text",
          text: span.content,
          marks: canonicalMarks([...marks, { type: "code" }]),
        });
        i = span.end;
        continue;
      }
    }

    if (ch === "<") {
      const auto = /^<([a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]*)>/.exec(src.slice(i));
      if (auto?.[1]) {
        flush();
        const href = auto[1];
        out.push({
          kind: "text",
          text: href,
          marks: canonicalMarks([...marks, { type: "link", href }]),
        });
        i += auto[0].length;
        continue;
      }
    }

    if (ch === "!" && src[i + 1] === "[") {
      const link = matchLink(src, i + 1);
      if (link) {
        flush();
        out.push({
          kind: "image",
          src: link.href,
          alt: plainText(parseInline(link.label)),
          ...(link.title !== undefined ? { title: link.title } : {}),
        });
        i = link.end;
        continue;
      }
    }

    if (ch === "[") {
      const link = matchLink(src, i);
      if (link) {
        flush();
        walkInline(
          link.label,
          [
            ...marks,
            {
              type: "link",
              href: link.href,
              ...(link.title !== undefined ? { title: link.title } : {}),
            },
          ],
          out,
        );
        i = link.end;
        continue;
      }
    }

    if (ch === "~" && src[i + 1] === "~") {
      const run = matchDelimited(src, i, "~~");
      if (run) {
        flush();
        walkInline(run.content, [...marks, { type: "strike" }], out);
        i = run.end;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const strong = src[i + 1] === ch ? matchEmphasis(src, i, ch.repeat(2)) : null;
      if (strong) {
        flush();
        walkInline(strong.content, [...marks, { type: "bold" }], out);
        i = strong.end;
        continue;
      }
      const em = matchEmphasis(src, i, ch);
      if (em) {
        flush();
        walkInline(em.content, [...marks, { type: "italic" }], out);
        i = em.end;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
}

/** `` `code` `` — N backticks, closed by a run of exactly N. */
function matchCodeSpan(src: string, at: number): { content: string; end: number } | null {
  const open = /^`+/.exec(src.slice(at))?.[0] ?? "";
  const rest = src.slice(at + open.length);
  const close = new RegExp(`(?<!\`)${open}(?!\`)`).exec(rest);
  if (!close || close.index === 0) return null;
  let content = rest.slice(0, close.index);
  // CommonMark strips ONE leading and trailing space when both are present.
  if (content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
    content = content.slice(1, -1);
  }
  return { content, end: at + open.length + close.index + open.length };
}

/** `[label](href "title")` starting at the `[`. Nested brackets are balanced. */
function matchLink(
  src: string,
  at: number,
): { label: string; href: string; title?: string; end: number } | null {
  if (src[at] !== "[") return null;
  let depth = 0;
  let i = at;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || src[i] !== "]") return null;
  const label = src.slice(at + 1, i);
  if (src[i + 1] !== "(") return null;
  let j = i + 2;
  let parens = 1;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "(") parens++;
    else if (ch === ")") {
      parens--;
      if (parens === 0) break;
    }
  }
  if (parens !== 0) return null;
  const target = src.slice(i + 2, j);
  const withTitle = /^(\S*)\s+"([^"]*)"$/.exec(target);
  const href = (withTitle?.[1] ?? target).trim();
  if (href === "" && !withTitle) return null;
  const title = withTitle?.[2];
  return {
    label,
    href: href.replace(/^<(.*)>$/, "$1"),
    ...(title !== undefined ? { title } : {}),
    end: j + 1,
  };
}

/** A simple symmetric delimiter run (`~~`). */
function matchDelimited(
  src: string,
  at: number,
  delim: string,
): { content: string; end: number } | null {
  const from = at + delim.length;
  const close = src.indexOf(delim, from);
  if (close < 0 || close === from) return null;
  return { content: src.slice(from, close), end: close + delim.length };
}

/**
 * `*em*` / `**strong**` / `_em_` / `__strong__`.
 *
 * Flanking rules kept minimal but strict enough to be safe: the opener may not
 * be followed by whitespace, the closer may not be preceded by it, and an
 * underscore run may not sit inside a word (`snake_case_name` is one word, not
 * emphasis — getting that wrong would turn identifiers in a body into italics).
 */
function matchEmphasis(
  src: string,
  at: number,
  delim: string,
): { content: string; end: number } | null {
  if (!src.startsWith(delim, at)) return null;
  const char = delim[0] ?? "*";
  if (char === "_") {
    const before = src[at - 1] ?? "";
    if (/\w/.test(before)) return null;
  }
  const from = at + delim.length;
  if (from >= src.length || /\s/.test(src[from] ?? "")) return null;
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src.startsWith(delim, i) && src[i + delim.length] !== char) {
      const prev = src[i - 1] ?? "";
      if (/\s/.test(prev)) {
        i++;
        continue;
      }
      if (char === "_" && /\w/.test(src[i + delim.length] ?? "")) {
        i++;
        continue;
      }
      const content = src.slice(from, i);
      if (content === "") return null;
      return { content, end: i + delim.length };
    }
    i++;
  }
  return null;
}

/** The text of an inline run with every mark dropped (image alt text). */
function plainText(nodes: readonly InlineNode[]): string {
  return nodes.map((n) => (n.kind === "text" ? n.text : "")).join("");
}

/**
 * prosemirror-markdown's escape set, so both producers spell inline text the
 * same way. `_` inside a word is left alone (it is not emphasis there, and
 * escaping it would rewrite every snake_case identifier in every body).
 */
function esc(text: string, startOfLine: boolean): string {
  let out = text.replace(/[`*\\~[\]_]/g, (m, offset: number, whole: string) =>
    m === "_" &&
    offset > 0 &&
    offset + 1 < whole.length &&
    /\w/.test(whole[offset - 1] ?? "") &&
    /\w/.test(whole[offset + 1] ?? "")
      ? m
      : `\\${m}`,
  );
  if (startOfLine) {
    out = out.replace(/^[:#\-*+]/, "\\$&").replace(/^(\s*\d+)\./, "$1\\.");
  }
  return out;
}

/** A link target, wrapped in `<>` when it contains anything that would break `(...)`. */
function linkTarget(href: string, title?: string): string {
  const target = /[\s()<>]/.test(href) ? `<${href}>` : href;
  return title === undefined || title === "" ? target : `${target} "${title}"`;
}

/**
 * prosemirror-markdown's `isPlainURL`: a link whose text IS its href, with no
 * title, is written as an autolink (`<https://x.test>`) rather than
 * `[https://x.test](https://x.test)`.
 */
function isPlainUrl(node: InlineNode, mark: InlineMark): boolean {
  return (
    node.kind === "text" &&
    mark.type === "link" &&
    mark.title === undefined &&
    node.text === mark.href &&
    /^[a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]*$/.test(mark.href)
  );
}

function openToken(mark: InlineMark, node: InlineNode): string {
  switch (mark.type) {
    case "bold":
      return "**";
    case "italic":
      return "*";
    case "strike":
      return "~~";
    case "link":
      return isPlainUrl(node, mark) ? "<" : "[";
    case "code":
      return "";
  }
}

function closeToken(mark: InlineMark, node: InlineNode | undefined): string {
  switch (mark.type) {
    case "bold":
      return "**";
    case "italic":
      return "*";
    case "strike":
      return "~~";
    case "link":
      return node && isPlainUrl(node, mark) ? ">" : `](${linkTarget(mark.href, mark.title)})`;
    case "code":
      return "";
  }
}

/**
 * Inline nodes → markdown. The exact inverse of `parseInline` for everything
 * `parseInline` recognizes; `serialize.test.ts` asserts that over the corpus.
 */
export function serializeInline(nodes: readonly InlineNode[]): string {
  let out = "";
  let open: InlineMark[] = [];
  /** The node each currently-open mark was opened for (autolink spelling). */
  let openedFor: (InlineNode | undefined)[] = [];

  const closeThrough = (keep: number): void => {
    for (let i = open.length - 1; i >= keep; i--) {
      const mark = open[i];
      if (mark) out += closeToken(mark, openedFor[i]);
    }
    open = open.slice(0, keep);
    openedFor = openedFor.slice(0, keep);
  };

  for (const node of nodes) {
    if (node.kind === "break") {
      closeThrough(0);
      out += "\\\n";
      continue;
    }
    if (node.kind === "image") {
      closeThrough(0);
      out += `![${esc(node.alt, false)}](${linkTarget(node.src, node.title)})`;
      continue;
    }

    const code = node.marks.some((m) => m.type === "code");
    if (code) {
      closeThrough(0);
      out += codeSpan(node.text);
      continue;
    }

    // Marks already open stay OUTER, in the order they were opened; only the
    // new ones are appended in canonical order. Without this, `**a [b](u)**`
    // would close bold to open the link and reopen it inside — valid markdown
    // that re-parses to the same doc, but a different spelling, so the flush
    // would write a version for a document nobody edited.
    const want = orderForOpen(canonicalMarks(node.marks), open);

    let keep = 0;
    while (keep < open.length && keep < want.length) {
      const a = open[keep];
      const b = want[keep];
      if (!a || !b || !sameMark(a, b)) break;
      // An autolink cannot span two text nodes — its spelling IS its text.
      if (a.type === "link" && (isPlainUrl(node, a) || isPlainUrl(openedFor[keep] ?? node, a)))
        break;
      keep++;
    }
    closeThrough(keep);
    for (const mark of want.slice(keep)) {
      out += openToken(mark, node);
      open.push(mark);
      openedFor.push(node);
    }
    // `startOfLine` escaping applies to the first thing on a line only; a mark
    // opener already precedes anything later in the run.
    out += isPlainUrl(node, open[0] ?? { type: "bold" }) ? node.text : esc(node.text, out === "");
  }
  closeThrough(0);
  return out;
}

/** Keep the marks that are already open outermost; append the rest canonically. */
function orderForOpen(want: readonly InlineMark[], open: readonly InlineMark[]): InlineMark[] {
  const ordered: InlineMark[] = [];
  for (const mark of open) {
    const match = want.find((w) => sameMark(w, mark));
    if (!match) break;
    ordered.push(match);
  }
  for (const mark of want) {
    if (!ordered.some((m) => sameMark(m, mark))) ordered.push(mark);
  }
  return ordered;
}

/** A code span whose fence outgrows any backtick run in the content. */
function codeSpan(text: string): string {
  let need = 1;
  for (const run of text.match(/`+/g) ?? []) if (run.length >= need) need = run.length + 1;
  const fence = "`".repeat(need);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/* ========================================================================== *
 * Block tree ↔ Y.XmlFragment (y-prosemirror's shape)                         *
 * ========================================================================== */

/**
 * y-prosemirror writes node attrs as Yjs element attributes VERBATIM — numbers
 * for `level`, booleans for `checked` — and reads them back the same way into
 * `schema.node(name, attrs)`. Yjs stores any JSON value there; only the
 * typings insist on `string`, because the DOM binding happens to write strings.
 * Writing a stringy `"1"` here instead would hand ProseMirror an invalid
 * `heading.level` on the client.
 */
function setAttr(el: Y.XmlElement, name: string, value: string | number | boolean): void {
  el.setAttribute(name, value as unknown as string);
}

function getAttr(el: Y.XmlElement, name: string): unknown {
  return (el.getAttribute(name) as unknown) ?? undefined;
}

function element(
  name: string,
  attrs: Record<string, string | number | boolean> = {},
): Y.XmlElement {
  const el = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) setAttr(el, k, v);
  return el;
}

/** Marks → the formatting attributes y-prosemirror uses (`{bold: {}, link: {…}}`). */
function markAttributes(marks: readonly InlineMark[]): Record<string, Record<string, unknown>> {
  const attrs: Record<string, Record<string, unknown>> = {};
  for (const mark of canonicalMarks(marks)) {
    if (mark.type === "link") {
      attrs["link"] = { href: mark.href, title: mark.title ?? null };
    } else {
      attrs[mark.type] = {};
    }
  }
  return attrs;
}

function attributesToMarks(attrs: Record<string, unknown> | undefined): InlineMark[] {
  if (!attrs) return [];
  const marks: InlineMark[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (name === "link") {
      const v = value as { href?: unknown; title?: unknown };
      const href = typeof v.href === "string" ? v.href : "";
      const title = typeof v.title === "string" && v.title !== "" ? v.title : undefined;
      marks.push({ type: "link", href, ...(title !== undefined ? { title } : {}) });
    } else if (name === "bold" || name === "italic" || name === "code" || name === "strike") {
      marks.push({ type: name });
    }
    // Unknown formatting attributes are ignored rather than guessed at: an
    // extension we do not know about must not become text we then rewrite.
  }
  return canonicalMarks(marks);
}

/** Inline nodes → the children of one text block (runs of text share a Y.XmlText). */
function inlineChildren(nodes: readonly InlineNode[]): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  let text: Y.XmlText | undefined;
  // The insert offset is tracked by hand: a Y.XmlText that is not yet
  // integrated into a document reports `length === 0` no matter how much has
  // been written into its pending buffer, so `insert(text.length, …)` would
  // stack every run at index 0 and reverse the whole paragraph.
  let offset = 0;
  for (const node of nodes) {
    if (node.kind === "text") {
      if (node.text === "") continue;
      if (!text) {
        text = new Y.XmlText();
        out.push(text);
        offset = 0;
      }
      text.insert(offset, node.text, markAttributes(node.marks));
      offset += node.text.length;
      continue;
    }
    text = undefined;
    if (node.kind === "break") {
      out.push(element("hardBreak"));
    } else {
      out.push(
        element("image", {
          src: node.src,
          alt: node.alt,
          ...(node.title !== undefined ? { title: node.title } : {}),
        }),
      );
    }
  }
  return out;
}

function childrenToInline(
  children: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[],
): InlineNode[] {
  const out: InlineNode[] = [];
  for (const child of children) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as {
        insert?: unknown;
        attributes?: Record<string, unknown>;
      }[]) {
        if (typeof op.insert !== "string") continue;
        out.push({ kind: "text", text: op.insert, marks: attributesToMarks(op.attributes) });
      }
      continue;
    }
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === "hardBreak") {
      out.push({ kind: "break" });
      continue;
    }
    if (child.nodeName === "image") {
      const title = getAttr(child, "title");
      out.push({
        kind: "image",
        src: String(getAttr(child, "src") ?? ""),
        alt: String(getAttr(child, "alt") ?? ""),
        ...(typeof title === "string" && title !== "" ? { title } : {}),
      });
    }
  }
  return out;
}

/** The inline source of a text block, split back out into hard-break segments. */
function textToInline(text: string): InlineNode[] {
  const segments = text.split("\\\n");
  const out: InlineNode[] = [];
  segments.forEach((segment, idx) => {
    if (idx > 0) out.push({ kind: "break" });
    out.push(...parseInline(segment));
  });
  return out;
}

function textBlock(
  name: string,
  text: string,
  attrs: Record<string, string | number> = {},
): Y.XmlElement {
  const el = element(name, attrs);
  const children = inlineChildren(textToInline(text));
  if (children.length > 0) el.insert(0, children);
  return el;
}

function blockToElement(block: Block): Y.XmlElement[] {
  switch (block.k) {
    case "para":
      return [textBlock("paragraph", block.text)];
    case "heading":
      return [textBlock("heading", block.text, { level: block.level })];
    case "code": {
      const el = element("codeBlock", block.info ? { language: block.info } : {});
      const body = block.lines.join("\n");
      if (body !== "") {
        const text = new Y.XmlText();
        text.insert(0, body);
        el.insert(0, [text]);
      }
      return [el];
    }
    case "hr":
      return [element("horizontalRule")];
    case "quote": {
      const el = element("blockquote");
      const children = block.blocks.flatMap(blockToElement);
      if (children.length > 0) el.insert(0, children);
      return [el];
    }
    case "table": {
      const el = element("table");
      const rows = block.rows.map((cells, rowIdx) => {
        const row = element("tableRow");
        const cols = Math.max(...block.rows.map((r) => r.length));
        const padded = [...cells];
        while (padded.length < cols) padded.push("");
        const cellEls = padded.map((cell) =>
          cellElement(rowIdx === 0 ? "tableHeader" : "tableCell", cell),
        );
        if (cellEls.length > 0) row.insert(0, cellEls);
        return row;
      });
      if (rows.length > 0) el.insert(0, rows);
      return [el];
    }
    case "list":
      return listToElements(block);
  }
}

function cellElement(name: string, text: string): Y.XmlElement {
  const cell = element(name);
  cell.insert(0, [textBlock("paragraph", text)]);
  return cell;
}

/**
 * A markdown list becomes ONE ProseMirror list per run of same-kind items:
 * `taskList` and `bulletList` are different node types, so a list that mixes
 * `- [ ] todo` with `- item` is several adjacent lists — exactly what the
 * printer emits, so the round trip stays byte-stable.
 */
function listToElements(block: Extract<Block, { k: "list" }>): Y.XmlElement[] {
  if (!block.ordered) {
    const runs = listRuns(block.items);
    if (runs.length > 1) return runs.flatMap((items) => listToElements({ ...block, items }));
  }
  const task = !block.ordered && block.items[0]?.task !== null && block.items.length > 0;
  const name = block.ordered ? "orderedList" : task ? "taskList" : "bulletList";
  const attrs: Record<string, string | number | boolean> = { tight: !block.loose };
  if (block.ordered) attrs["start"] = block.start;
  const list = element(name, attrs);
  const items = block.items.map((item) => {
    const el = element(
      task ? "taskItem" : "listItem",
      task ? { checked: item.task === "checked" } : {},
    );
    const children = item.blocks.flatMap(blockToElement);
    // An empty item still needs its paragraph, or the client's schema drops it.
    el.insert(0, children.length > 0 ? children : [element("paragraph")]);
    return el;
  });
  if (items.length > 0) list.insert(0, items);
  return [list];
}

function elementToBlock(el: Y.XmlElement): Block | null {
  const children = el.toArray();
  switch (el.nodeName) {
    case "paragraph":
      return { k: "para", text: serializeInline(childrenToInline(children)) };
    case "heading": {
      const level = Number(getAttr(el, "level") ?? 1);
      return {
        k: "heading",
        level: Number.isFinite(level) ? Math.min(6, Math.max(1, Math.trunc(level))) : 1,
        text: serializeInline(childrenToInline(children)),
      };
    }
    case "codeBlock": {
      const language = getAttr(el, "language");
      const body = children.map((c) => (c instanceof Y.XmlText ? c.toString() : "")).join("");
      return {
        k: "code",
        info: typeof language === "string" ? language : "",
        lines: body === "" ? [] : body.split("\n"),
      };
    }
    case "horizontalRule":
      return { k: "hr" };
    case "blockquote":
      return { k: "quote", blocks: elementsToBlocks(children) };
    case "table": {
      const rows: string[][] = [];
      for (const row of children) {
        if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow") continue;
        rows.push(
          row
            .toArray()
            .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
            .map((cell) =>
              elementsToBlocks(cell.toArray())
                .map((b) => (b.k === "para" ? b.text : renderBlock(b)))
                .join(" "),
            ),
        );
      }
      return { k: "table", rows };
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const ordered = el.nodeName === "orderedList";
      const start = Number(getAttr(el, "start") ?? 1);
      const items: Item[] = [];
      for (const item of children) {
        if (!(item instanceof Y.XmlElement)) continue;
        const checked = getAttr(item, "checked");
        items.push({
          task:
            el.nodeName === "taskList"
              ? checked === true || checked === "true"
                ? "checked"
                : "unchecked"
              : null,
          blocks: elementsToBlocks(item.toArray()),
        });
      }
      return {
        k: "list",
        ordered,
        start: Number.isFinite(start) ? Math.trunc(start) : 1,
        loose: getAttr(el, "tight") === false,
        items,
      };
    }
    default:
      // An unknown node is skipped rather than guessed at. It cannot come from
      // this module; it could only come from a client running a newer schema,
      // and inventing markdown for it would delete the real content on flush.
      return null;
  }
}

function elementsToBlocks(children: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[]): Block[] {
  const out: Block[] = [];
  for (const child of children) {
    if (!(child instanceof Y.XmlElement)) continue;
    const block = elementToBlock(child);
    if (block) out.push(block);
  }
  return out;
}

/* ========================================================================== *
 * The public surface                                                          *
 * ========================================================================== */

/**
 * A fresh Y.Doc seeded from an object's markdown body (+ title).
 *
 * `gc: true` (Yjs's default, stated here because it is load-bearing) is half of
 * the compaction story: with garbage collection on, a deleted item's CONTENT is
 * dropped from the doc's state, so `Y.encodeStateAsUpdate` — what docStore
 * persists on every flush — does not carry text the author deleted. Turning it
 * off would quietly turn `collab_docs` into a verbatim keystroke log.
 */
export function seedDocFromMarkdown(md: string, opts?: { readonly title?: string | null }): Y.Doc {
  const doc = new Y.Doc({ gc: true });
  applyMarkdownToDoc(doc, md, opts?.title ?? null);
  return doc;
}

/** Fill an EMPTY doc's body/title. Exported for the re-seed paths in docStore. */
export function applyMarkdownToDoc(doc: Y.Doc, md: string, title: string | null): void {
  const fragment = doc.getXmlFragment(BODY_FRAGMENT);
  const titleText = doc.getText(TITLE_TEXT);
  doc.transact(() => {
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    if (titleText.length > 0) titleText.delete(0, titleText.length);
    const blocks = parseBlocks(normalizeMarkdown(md).split("\n"));
    const elements = blocks.flatMap(blockToElement);
    if (elements.length > 0) fragment.insert(0, elements);
    if (title) titleText.insert(0, title);
  }, SEED_ORIGIN);
}

/**
 * The transaction origin every seed/re-seed carries. The flush watcher drops
 * its own writes by origin token (spec: "flush must not re-enter through its
 * own bridge"), and a seed is likewise not a user edit — it must never mark the
 * room dirty and schedule a flush of content that came FROM the database.
 */
export const SEED_ORIGIN = "collab:seed";

/** The object body this doc currently represents, in canonical markdown. */
export function docToMarkdown(doc: Y.Doc): string {
  return renderDocument(elementsToBlocks(doc.getXmlFragment(BODY_FRAGMENT).toArray()));
}

/** The object title this doc currently represents. */
export function docTitle(doc: Y.Doc): string {
  return doc.getText(TITLE_TEXT).toString();
}

/**
 * A stored body's spelling AS A ROOM WILL SERIALIZE IT — i.e. exactly what a
 * flush of an UNTOUCHED document produces. This, not `normalizeMarkdown`, is
 * what "has the content changed?" must compare against.
 *
 * The two differ, and the difference is a bug factory. `normalizeMarkdown` is
 * the BLOCK layer only: it must agree byte-for-byte with the client's
 * `normalizeMd`, which merely PREDICTS the serializer, so it passes inline text
 * through untouched. The round trip below also canonicalizes INLINE text —
 * emphasis spelling, autolinks, and prosemirror-markdown's escape set. So they
 * disagree on any body containing inline punctuation the parser leaves literal
 * but the printer escapes: a lone `~`, `*`, `[`. `~$120k` normalizes to itself
 * and serializes to `\~$120k`.
 *
 * Comparing a serialized room against `normalizeMarkdown` therefore read
 * "changed" for a document NOBODY TOUCHED — so merely opening such an object
 * wrote a version, a history row and an audit event in the READER's name, and
 * injected backslashes into their prose (found 2026-07-26: opening a node in
 * the graph view reported "you updated this"). `serialize.test.ts`'s KNOWN_GAPS
 * priced that at "one settling version" per gap; the correct price is zero, and
 * comparing like with like is what makes it zero for EVERY input rather than
 * for the inputs someone remembered to enumerate.
 *
 * Defined AS the round trip, so it can never drift from what the flush writes.
 */
export function canonicalMarkdown(md: string): string {
  const doc = seedDocFromMarkdown(md);
  try {
    return docToMarkdown(doc);
  } finally {
    doc.destroy();
  }
}
