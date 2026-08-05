/**
 * Deterministic body chunker for chunk-level semantic search.
 *
 * One embedding per OBJECT under-serves long bodies: a 1 MB document (the
 * body cap) squashed into a single vector loses everything past the embed
 * input cap, and even mid-size docs blur multiple topics into one point in
 * space. Chunking embeds each ~300-word window separately, so a query lands
 * on the passage that actually answers it.
 *
 * Deterministic and LLM-free by design: the sweep re-chunks whenever
 * `chunker_version` changes, so the algorithm must produce identical output
 * for identical input, forever, on every box. Bump CHUNKER_VERSION for ANY
 * behavior change — the sweep treats a version mismatch as staleness and
 * rebuilds that object's chunks.
 *
 * Shape: greedy paragraph packing toward TARGET_WORDS, splitting oversized
 * paragraphs at sentence boundaries (then hard word splits as a last resort),
 * with the tail of each chunk carried into the next as overlap so a fact
 * straddling a boundary is embedded whole at least once.
 */

export const CHUNKER_VERSION = 1;

/** Words per chunk we aim for — GBrain-class recursive chunking territory. */
const TARGET_WORDS = 300;
/** Tail words of a chunk repeated at the head of the next. */
const OVERLAP_WORDS = 50;
/** A body within this many words stays a single chunk (no overlap noise). */
const SINGLE_CHUNK_MAX = 340;

interface Chunk {
  readonly ix: number;
  readonly text: string;
}

const words = (s: string): number => (s.match(/\S+/g) ?? []).length;

/** Sentence-ish split that never loses characters (keeps delimiters). */
function splitSentences(paragraph: string): string[] {
  const out = paragraph.match(/[^.!?\n]+[.!?]+[\s]*|[^.!?\n]+$/g);
  return out ?? [paragraph];
}

/** Hard-split a run of text into ≤ TARGET_WORDS word windows. */
function splitByWords(text: string, cap: number): string[] {
  const ws = text.match(/\S+\s*/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < ws.length; i += cap) out.push(ws.slice(i, i + cap).join(""));
  return out;
}

/**
 * Chunk a body. The title is NOT included here — the sweep prepends it to
 * each chunk's EMBED input (title context helps retrieval) while the stored
 * chunk text stays pure body content (what a reranker should judge and what
 * a snippet should show).
 */
export function chunkBody(body: string): Chunk[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  if (words(trimmed) <= SINGLE_CHUNK_MAX) return [{ ix: 0, text: trimmed }];

  // Units: paragraphs, oversized ones broken to sentences, oversized
  // sentences (minified text, tables) hard-split by words.
  const units: string[] = [];
  for (const para of trimmed.split(/\n{2,}/)) {
    const p = para.trim();
    if (p === "") continue;
    if (words(p) <= TARGET_WORDS) {
      units.push(p);
      continue;
    }
    for (const s of splitSentences(p)) {
      const t = s.trim();
      if (t === "") continue;
      if (words(t) <= TARGET_WORDS) units.push(t);
      else units.push(...splitByWords(t, TARGET_WORDS).map((w) => w.trim()));
    }
  }

  const chunks: Chunk[] = [];
  let cur: string[] = [];
  let curWords = 0;
  const flush = (): void => {
    if (cur.length === 0) return;
    const text = cur.join("\n").trim();
    chunks.push({ ix: chunks.length, text });
    // Overlap: seed the next chunk with this one's last OVERLAP_WORDS words.
    const tailWs = text.match(/\S+\s*/g) ?? [];
    const tail = tailWs
      .slice(Math.max(0, tailWs.length - OVERLAP_WORDS))
      .join("")
      .trim();
    cur = tail === "" ? [] : [tail];
    curWords = words(tail);
  };
  for (const u of units) {
    const w = words(u);
    if (curWords > 0 && curWords + w > TARGET_WORDS + OVERLAP_WORDS) flush();
    cur.push(u);
    curWords += w;
  }
  // Final flush without seeding another overlap chunk.
  if (cur.length > 0) {
    const text = cur.join("\n").trim();
    // An all-overlap tail chunk adds no new content — only emit if it grew.
    if (chunks.length === 0 || words(text) > OVERLAP_WORDS) {
      chunks.push({ ix: chunks.length, text });
    }
  }
  return chunks;
}
