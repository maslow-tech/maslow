// SAM.gov attachment reader — fetches ONE attachment from a search result's
// resourceLinks URL and returns its text, so an agent can read the PWS/SOW
// the way a human capture analyst does. Companion to samgov.ts (the JSON
// rails): same "dumb GET, knowledge lives in skill objects" doctrine,
// different rails because attachments are public binaries behind a redirect:
//
//   - host pinned to sam.gov, path pinned to the opportunity-attachment
//     download route (the agent passes a resourceLinks URL verbatim)
//   - NO api key on any request in this flow — the endpoint is public, and
//     the download 303s to a short-lived signed S3 URL. Redirects are
//     followed MANUALLY: https only, hostnames only (no IP literals or
//     localhost), two hops max — no credential to leak, and no ride into
//     a customer-internal address either.
//   - attachment bytes are untrusted input: the download is streamed with a
//     hard byte cap, PDFs are page-capped and destroyed after use, DOCX
//     inflation is filtered to the one member we read (zip bombs die at the
//     filter), and OCR runs one-at-a-time with raster-size caps and a global
//     deadline.
//   - a scanned PDF (no text layer) falls back to tesseract OCR when
//     pdftoppm/tesseract are present (box image ships them; degrades to a
//     clear note when they're absent, e.g. dev laptops)

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { unzipSync, strFromU8 } from "fflate";
import type { SamgovResult } from "./samgov.js";

const execFileP = promisify(execFile);

const DOC_HOST = "https://sam.gov";
const DOC_PATH =
  /^\/api\/prod\/opps\/v3\/opportunities\/resources\/files\/[A-Za-z0-9-]+\/download\/?$/;
const MAX_REDIRECTS = 2;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
const MAX_PDF_PAGES = 500;
// The one zip member we read; a bomb declaring a huge inflated size never
// gets inflated at all (fflate's filter sees originalSize before extraction).
const MAX_DOCX_XML_BYTES = 50 * 1024 * 1024;
// ponytail: 25 pages at 150dpi keeps worst-case OCR under the global
// deadline; raise only if real scanned PWS docs turn out longer.
const MAX_OCR_PAGES = 25;
const OCR_DEADLINE_MS = 180_000;
// Under this many characters a "PDF" text layer is cover-page noise or
// nothing at all — treat the document as scanned and OCR it.
const SCANNED_TEXT_THRESHOLD = 200;
// Below this many chars/page the text layer is suspiciously thin — the doc
// may be partially scanned. We return what we have, honestly flagged.
const SPARSE_CHARS_PER_PAGE = 100;

const ok = (data: unknown): SamgovResult => ({ successful: true, data });
const fail = (error: string): SamgovResult => ({ successful: false, data: null, error });

export type SamgovDocData = {
  file_name: string | null;
  kind: "pdf" | "docx" | "text";
  pages?: number;
  ocr?: true;
  text: string;
  truncated?: true;
  note?: string;
};

/** Fetch one sam.gov opportunity attachment and return its extracted text. */
export async function samgovFetchDoc(url: string): Promise<SamgovResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail(`"${url}" is not a valid URL.`);
  }
  if (parsed.origin !== DOC_HOST || !DOC_PATH.test(parsed.pathname)) {
    return fail(
      "Only SAM.gov attachment downloads can be fetched: a resourceLinks URL from " +
        "an /opportunities/v2/search result, like " +
        "https://sam.gov/api/prod/opps/v3/opportunities/resources/files/<id>/download.",
    );
  }

  const res = await fetchWithGuardedRedirects(`${DOC_HOST}${parsed.pathname}`);
  if (typeof res === "string") return fail(res);
  if (!res.ok) {
    return fail(
      `SAM.gov returned ${res.status} for this attachment. ` +
        "Non-public attachments (controlled/explicit access) cannot be fetched.",
    );
  }
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_DOC_BYTES) {
    return fail(`Attachment is ${len} bytes — over the ${MAX_DOC_BYTES} byte cap.`);
  }
  const buf = await readBodyCapped(res);
  if (buf === null) {
    return fail(`Attachment exceeds the ${MAX_DOC_BYTES} byte cap.`);
  }

  // Filename rides the final (S3) response's content-disposition.
  const disposition = res.headers.get("content-disposition") ?? "";
  const file_name = /filename=["']?([^"';]+)/.exec(disposition)?.[1]?.replaceAll("+", " ") ?? null;

  try {
    if (buf.subarray(0, 5).toString("latin1") === "%PDF-") {
      return ok(await extractPdf(buf, file_name));
    }
    if (buf.subarray(0, 4).toString("latin1") === "PK\x03\x04") {
      return ok(extractDocx(buf, file_name));
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (/text\/|json|xml/.test(contentType) || looksLikeText(buf)) {
      return ok(capText({ file_name, kind: "text", text: buf.toString("utf8") }));
    }
    return fail(
      `Unsupported attachment type${file_name ? ` (${file_name})` : ""} — only PDF, ` +
        "DOCX, and plain-text attachments can be extracted. Flag it for a human.",
    );
  } catch (e) {
    return fail(`Could not extract text from this attachment (${(e as Error).message}).`);
  }
}

/**
 * GET with redirects handled by hand: each hop must be https to a real
 * hostname (an IP literal, localhost, or *.internal target is refused — a
 * compromised upstream must not be able to point the box at itself or its
 * neighbors). Returns the final Response, or an error string.
 */
async function fetchWithGuardedRedirects(url: string): Promise<Response | string> {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      return "SAM.gov attachment download failed (network error or timeout).";
    }
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get("location");
    if (!location) return "SAM.gov redirected without a location.";
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return "SAM.gov redirected to an invalid URL.";
    }
    if (next.protocol !== "https:" || isIP(next.hostname) || forbiddenHost(next.hostname)) {
      return "Refused an unsafe redirect from SAM.gov (non-https or non-public destination).";
    }
    url = next.href;
  }
  return "Too many redirects from SAM.gov.";
}

function forbiddenHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")
  );
}

/** Stream the body with a running byte cap. null = over the cap. */
async function readBodyCapped(res: Response): Promise<Buffer | null> {
  if (!res.body?.getReader) {
    // No stream (test stubs) — buffer, then enforce the same cap.
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_DOC_BYTES ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DOC_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 1024);
  let printable = 0;
  for (const b of sample) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  return sample.length > 0 && printable / sample.length > 0.9;
}

function capText<T extends SamgovDocData>(data: T): T {
  if (data.text.length > MAX_TEXT_CHARS) {
    return { ...data, text: data.text.slice(0, MAX_TEXT_CHARS), truncated: true as const };
  }
  return data;
}

async function extractPdf(buf: Buffer, file_name: string | null): Promise<SamgovDocData> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  try {
    const totalPages = pdf.numPages;
    if (totalPages > MAX_PDF_PAGES) {
      throw new Error(`PDF has ${totalPages} pages — over the ${MAX_PDF_PAGES}-page cap`);
    }
    const { text } = await extractText(pdf, { mergePages: true });
    if (text.trim().length >= SCANNED_TEXT_THRESHOLD) {
      // ponytail: doc-level heuristic; a partially-scanned doc keeps its text
      // layer and gets flagged instead of per-page OCR merging.
      const sparse = totalPages >= 3 && text.trim().length / totalPages < SPARSE_CHARS_PER_PAGE;
      return capText({
        file_name,
        kind: "pdf",
        pages: totalPages,
        text,
        ...(sparse && {
          note:
            "The text layer is unusually thin for the page count — parts of this " +
            "document may be scanned images. If it reads incomplete, flag it for a human.",
        }),
      });
    }
    // No usable text layer → a scanned document. OCR it if the tools exist.
    const ocr = await withOcrLock(() => ocrPdf(buf, totalPages));
    if (ocr === null) {
      return {
        file_name,
        kind: "pdf",
        pages: totalPages,
        text: text.trim(),
        note:
          "This PDF has no text layer (scanned document) and OCR tools are not " +
          "available on this box — flag it for a human to read.",
      };
    }
    const note =
      totalPages > MAX_OCR_PAGES || ocr.partial
        ? `OCR of a scanned document; only the first ${ocr.pagesRead} of ${totalPages} pages were read.`
        : undefined;
    return capText({ file_name, kind: "pdf", pages: totalPages, ocr: true, text: ocr.text, note });
  } finally {
    // unpdf ≥1.8 (pdfjs 5.x): document teardown moved off the proxy onto its
    // loading task — proxy.destroy() no longer exists.
    await pdf.loadingTask.destroy();
  }
}

// One OCR at a time per box — tesseract is CPU-hungry and the appliance
// shares cores with Postgres. ponytail: a promise chain, not a queue lib.
let ocrTurn: Promise<unknown> = Promise.resolve();
function withOcrLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = ocrTurn.then(fn, fn);
  ocrTurn = run.catch(() => undefined);
  return run;
}

/** Rasterize + tesseract a scanned PDF. null = OCR tools not on this host. */
async function ocrPdf(
  buf: Buffer,
  totalPages: number,
): Promise<{ text: string; pagesRead: number; partial: boolean } | null> {
  const deadline = Date.now() + OCR_DEADLINE_MS;
  const dir = await mkdtemp(join(tmpdir(), "samgov-ocr-"));
  try {
    await writeFile(join(dir, "doc.pdf"), buf);
    // -scale-to bounds the raster size no matter what the page's MediaBox
    // claims — a poster-sized "page" can't balloon memory or disk.
    await execFileP(
      "pdftoppm",
      [
        "-r",
        "150",
        "-scale-to",
        "2200",
        "-gray",
        "-png",
        "-f",
        "1",
        "-l",
        String(Math.min(totalPages, MAX_OCR_PAGES)),
        "doc.pdf",
        "page",
      ],
      { cwd: dir, timeout: 120_000 },
    );
    const pages = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    let out = "";
    let pagesRead = 0;
    for (const page of pages) {
      if (Date.now() > deadline || out.length > MAX_TEXT_CHARS) break;
      const { stdout } = await execFileP("tesseract", [join(dir, page), "stdout", "-l", "eng"], {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      out += stdout + "\n";
      pagesRead++;
    }
    return { text: out, pagesRead, partial: pagesRead < pages.length };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // tools not installed
    throw new Error(`OCR failed: ${(e as Error).message.slice(0, 200)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const DOCX_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

/**
 * WordprocessingML → text, in ONE left-to-right scan.
 *
 * A chain of `replace` passes is not a strip: each pass can splice what is left
 * of its neighbours into a NEW tag (`<w:` + `p>`), so the document chooses how
 * many passes it survives. The scan drops everything from a `<` to its closing
 * `>` exactly once — mapping the three tags that carry layout — and leaves a
 * `<` with no `>` after it verbatim, because nothing can complete it. The
 * result therefore holds no tag at all, whatever the nesting, and is unchanged
 * if run again.
 */
function docxXmlToText(xml: string): string {
  let out = "";
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      out += xml.slice(i);
      break;
    }
    out += xml.slice(i, lt);
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) {
      out += xml.slice(lt);
      break;
    }
    const tag = xml.slice(lt, gt + 1);
    out += /^<w:tab[^>]*\/>$/.test(tag)
      ? "\t"
      : /^<w:br[^>]*\/>$/.test(tag)
        ? "\n"
        : tag === "</w:p>"
          ? "\n"
          : "";
    i = gt + 1;
  }
  return out;
}

function extractDocx(buf: Buffer, file_name: string | null): SamgovDocData {
  let files: Record<string, Uint8Array>;
  try {
    // Inflate ONLY word/document.xml, and only if its declared inflated size
    // is sane — every other member (and any zip bomb) stays compressed.
    files = unzipSync(new Uint8Array(buf), {
      filter: (f) => f.name === "word/document.xml" && f.originalSize <= MAX_DOCX_XML_BYTES,
    });
  } catch {
    throw new Error("not a readable zip archive");
  }
  const doc = files["word/document.xml"];
  if (!doc) {
    throw new Error(
      "zip archive without a readable word/document.xml — only .docx (not .xlsx/.zip) " +
        "is supported, and its document.xml must be under the size cap",
    );
  }
  const text = docxXmlToText(strFromU8(doc))
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, e: string) => DOCX_ENTITIES[e] ?? m)
    .replace(/\n{3,}/g, "\n\n");
  return capText({ file_name, kind: "docx", text });
}
