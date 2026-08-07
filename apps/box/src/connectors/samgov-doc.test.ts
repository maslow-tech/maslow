import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { samgovFetchDoc, type SamgovDocData } from "./samgov-doc.js";

/**
 * Attachment-reader rails against a stubbed fetch: the host/path pin, size
 * cap, and the binary→text extraction (PDF text layer, DOCX, plain text,
 * unsupported types). The PDF fixtures are built by hand with correct xref
 * offsets so pdf.js parses them without recovery heuristics. No network.
 */

const GOOD_URL =
  "https://sam.gov/api/prod/opps/v3/opportunities/resources/files/1a034d11f18a4ef5817c51bd2f35315d/download";

type StubDoc = {
  status?: number;
  body?: Uint8Array | string;
  headers?: Record<string, string>;
};

function stubFetch(doc: StubDoc) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL) => {
    calls.push(String(input));
    const body =
      typeof doc.body === "string"
        ? new TextEncoder().encode(doc.body)
        : (doc.body ?? new Uint8Array());
    const status = doc.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => doc.headers?.[k.toLowerCase()] ?? null },
      arrayBuffer: () =>
        Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
    });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

/** A minimal but structurally valid PDF: page 1 shows `text`, plus
 *  `extraPages` additional empty pages (for the page-cap guard). */
function makePdf(text: string, extraPages = 0): Uint8Array {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const pageCount = 1 + extraPages;
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      `/Contents ${3 + pageCount} 0 R /Resources << /Font << /F1 ${4 + pageCount} 0 R >> >> >>`,
    ...Array.from(
      { length: extraPages },
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ),
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function makeDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
    ),
  });
}

/** A docx whose `word/document.xml` body is written verbatim — for payloads
 *  `makeDocx`'s paragraph wrapper cannot express. */
function rawDocx(bodyXml: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document><w:body>${bodyXml}</w:body></w:document>`,
    ),
  });
}

async function docData(url: string): Promise<SamgovDocData> {
  const r = await samgovFetchDoc(url);
  expect(r.successful).toBe(true);
  return (r as { data: SamgovDocData }).data;
}

describe("samgovFetchDoc rails", () => {
  it("rejects a non-sam.gov host without any network call", async () => {
    const calls = stubFetch({});
    const r = await samgovFetchDoc(
      "https://evil.com/api/prod/opps/v3/opportunities/resources/files/x/download",
    );
    expect(r.successful).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects a sam.gov path outside the attachment-download route", async () => {
    const calls = stubFetch({});
    const r = await samgovFetchDoc("https://sam.gov/api/prod/sgs/v1/search");
    expect(r.successful).toBe(false);
    expect(calls).toHaveLength(0);
    if (!r.successful) expect(r.error).toContain("resourceLinks");
  });

  it("rejects an invalid URL cleanly", async () => {
    const r = await samgovFetchDoc("not a url");
    expect(r.successful).toBe(false);
  });

  it("never sends an api_key (the endpoint is public and redirects to S3)", async () => {
    const calls = stubFetch({ body: makePdf("x"), headers: { "content-type": "application/pdf" } });
    await samgovFetchDoc(GOOD_URL);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("api_key");
  });

  it("refuses an oversized attachment", async () => {
    stubFetch({ headers: { "content-length": String(30 * 1024 * 1024) } });
    const r = await samgovFetchDoc(GOOD_URL);
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("cap");
  });

  it("reports a non-OK status as a clean failure", async () => {
    stubFetch({ status: 404 });
    const r = await samgovFetchDoc(GOOD_URL);
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("404");
  });

  it("follows the 303 to a signed https S3 URL (real-world shape), one hop", async () => {
    const calls: string[] = [];
    const body = "Amendment 0002: extended.";
    vi.stubGlobal("fetch", (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://sam.gov/")) {
        return Promise.resolve(
          new Response(null, {
            status: 303,
            headers: {
              location:
                "https://iae-fbo-attachments.s3.amazonaws.com/fbo/files/x.pdf?X-Amz-Expires=9",
            },
          }),
        );
      }
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
      );
    });
    const r = await samgovFetchDoc(GOOD_URL);
    expect(r.successful).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("s3.amazonaws.com");
    expect((r as { data: SamgovDocData }).data.text).toContain("Amendment 0002");
  });

  it.each([
    ["http://iae-fbo-attachments.s3.amazonaws.com/x.pdf", "non-https"],
    ["https://169.254.169.254/latest/meta-data", "IP literal"],
    ["https://postgres.internal/secrets", "internal hostname"],
  ])("refuses an unsafe redirect target (%s — %s)", async (location) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(null, { status: 303, headers: { location } }));
    });
    const r = await samgovFetchDoc(GOOD_URL);
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("unsafe redirect");
    expect(calls).toHaveLength(1); // never followed
  });

  it("caps a streamed body with no content-length header (lying server)", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 25) controller.enqueue(chunk);
        else controller.close();
      },
    });
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(stream, { status: 200, headers: { "content-type": "application/pdf" } }),
      ),
    );
    const r = await samgovFetchDoc(GOOD_URL);
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("cap");
  });

  it("refuses a PDF over the page cap without extracting it", async () => {
    stubFetch({ body: makePdf("x", 500), headers: { "content-type": "application/pdf" } });
    const r = await samgovFetchDoc(GOOD_URL);
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("page cap");
  });
});

describe("samgovFetchDoc extraction", () => {
  it("extracts the text layer of a PDF, with filename from content-disposition", async () => {
    stubFetch({
      body: makePdf(
        "Performance Work Statement for widget modernization services etc etc " +
          "with enough characters to clear the scanned-document threshold easily. " +
          "The contractor shall provide DevSecOps and cloud engineering support.",
      ),
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=PWS+Widget+Modernization.pdf",
      },
    });
    const d = await docData(GOOD_URL);
    expect(d.kind).toBe("pdf");
    expect(d.pages).toBe(1);
    expect(d.text).toContain("Performance Work Statement");
    expect(d.file_name).toBe("PWS Widget Modernization.pdf");
  });

  it("never returns a scanned PDF's emptiness silently — OCR text or an explicit note", async () => {
    stubFetch({ body: makePdf(""), headers: { "content-type": "application/pdf" } });
    const d = await docData(GOOD_URL);
    expect(d.kind).toBe("pdf");
    // With OCR tools installed this is OCR output; without, the flag-a-human
    // note. Either way it must be marked, not a bare empty string.
    expect(Boolean(d.ocr) || /no text layer/.test(d.note ?? "")).toBe(true);
  });

  it("extracts DOCX paragraphs as text lines", async () => {
    stubFetch({ body: makeDocx(["Scope of Work", "Task 1 & scope: engineering"]) });
    const d = await docData(GOOD_URL);
    expect(d.kind).toBe("docx");
    expect(d.text).toContain("Scope of Work\n");
    expect(d.text).toContain("Task 1 & scope: engineering");
  });

  it("keeps tab/break/paragraph layout and decodes entities once", async () => {
    stubFetch({
      body: rawDocx(
        "<w:p><w:r><w:t>Line A</w:t><w:tab/><w:t>col2</w:t><w:br/><w:t>next</w:t></w:r></w:p>" +
          "<w:p><w:r><w:t>R&amp;amp;D &amp;lt;redacted&amp;gt;</w:t></w:r></w:p>",
      ),
    });
    const d = await docData(GOOD_URL);
    expect(d.text).toContain("Line A\tcol2\nnext\n");
    // One decode pass: `&amp;lt;` is the literal text `&lt;`, not a `<`.
    expect(d.text).toContain("R&amp;D &lt;redacted&gt;");
  });

  it("a spliced tag payload leaves no markup in the extracted text", async () => {
    // Attachment bytes are hostile input. Each `replace` pass leaves its
    // neighbours adjacent, so a payload built to be joined by the pass that
    // removes its middle walks out of a chain of passes as live markup.
    stubFetch({
      body: rawDocx(
        "<w:p><w:r><w:t>Scope of Work</w:t></w:r></w:p>" +
          "<w:<w:tab/>p><w:r><w:t>Task 1</w:t></w:r></w:p>" +
          "<w:t<w:br/>>hidden</w:t>",
      ),
    });
    const d = await docData(GOOD_URL);
    expect(d.text).toContain("Scope of Work");
    expect(d.text).toContain("Task 1");
    expect(d.text).not.toMatch(/<[a-zA-Z/][^>]*>/);
  });

  it("refuses a zip that is not a docx (e.g. xlsx) with a teaching error", async () => {
    stubFetch({ body: zipSync({ "xl/workbook.xml": strToU8("<workbook/>") }) });
    const r = await samgovFetchDoc(GOOD_URL);
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("docx");
  });

  it("refuses a docx whose document.xml declares a bomb-sized inflation", async () => {
    // 60MB of one repeated byte deflates to ~60KB on the wire but declares
    // its inflated size in the zip entry — the filter must kill it unread.
    const bomb = zipSync(
      { "word/document.xml": strToU8("<w:p>" + "A".repeat(60 * 1024 * 1024) + "</w:p>") },
      { level: 9 },
    );
    expect(bomb.length).toBeLessThan(1024 * 1024); // it IS a bomb
    stubFetch({ body: bomb });
    const r = await samgovFetchDoc(GOOD_URL);
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("size cap");
  });

  it("passes plain text through", async () => {
    stubFetch({
      body: "Amendment 0003: the response deadline is extended.",
      headers: { "content-type": "text/plain" },
    });
    const d = await docData(GOOD_URL);
    expect(d.kind).toBe("text");
    expect(d.text).toContain("Amendment 0003");
  });

  it("refuses an unsupported binary type with a flag-for-human error", async () => {
    stubFetch({
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      headers: { "content-type": "image/png" },
    });
    const r = await samgovFetchDoc(GOOD_URL);
    expect(r.successful).toBe(false);
    if (!r.successful) expect(r.error).toContain("Unsupported");
  });
});
