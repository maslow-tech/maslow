import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  BRIDGE_ORIGIN,
  applyMarkdownDiff,
  changedBlockRanges,
  markdownDiffBridge,
} from "./mdDiff.js";
import {
  BODY_FRAGMENT,
  TITLE_TEXT,
  docTitle,
  docToMarkdown,
  normalizeMarkdown,
  seedDocFromMarkdown,
} from "./serialize.js";

/**
 * What this file asserts, in the order the spec states it:
 *
 *  1. EXACTNESS — over a fixture corpus (insert-at-start, delete-at-end,
 *     mid-paragraph replace, list reordering, no-op and friends), applying the
 *     diff to a doc seeded from `oldMd` and serializing yields EXACTLY the
 *     canonical spelling of `newMd`. Anything less and the next flush writes a
 *     body nobody typed.
 *  2. MINIMALITY — an unrelated block is not rewritten. Asserted by IDENTITY:
 *     the untouched `Y.XmlElement` is the same object afterwards, which is what
 *     keeps remote cursors, selections and marks alive in paragraphs the write
 *     never touched.
 *  3. THREE-WAY — the live doc is neither `from` nor `to`. Disjoint local edits
 *     survive and merge; overlapping ones are REFUSED (false) rather than
 *     arbitrated, because a silently mis-applied merge is how an acknowledged
 *     agent write gets reverted by the next flush.
 *  4. IDEMPOTENCE — re-running a diff that is already in the doc changes
 *     nothing. The flush's rebase re-runs the very diff the bridge applied.
 */

const frag = (doc: Y.Doc): Y.XmlFragment => doc.getXmlFragment(BODY_FRAGMENT);
const blocks = (doc: Y.Doc): (Y.XmlElement | Y.XmlText | Y.XmlHook)[] => frag(doc).toArray();

/* ========================================================================== *
 * 1. Exactness over the fixture corpus                                        *
 * ========================================================================== */

interface Fixture {
  readonly from: string;
  readonly to: string;
}

const CORPUS: Record<string, Fixture> = {
  "no-op": { from: "alpha\n\nbeta", to: "alpha\n\nbeta" },

  "insert at start": { from: "alpha\n\nbeta", to: "zero\n\nalpha\n\nbeta" },
  "insert heading at start": { from: "alpha\n\nbeta", to: "# Title\n\nalpha\n\nbeta" },
  "insert in the middle": { from: "alpha\n\nbeta", to: "alpha\n\nmiddle\n\nbeta" },
  "insert at end": { from: "alpha\n\nbeta", to: "alpha\n\nbeta\n\ngamma" },
  "insert into an empty body": { from: "", to: "first paragraph" },

  "delete at end": { from: "alpha\n\nbeta\n\ngamma", to: "alpha\n\nbeta" },
  "delete at start": { from: "alpha\n\nbeta\n\ngamma", to: "beta\n\ngamma" },
  "delete in the middle": { from: "alpha\n\nbeta\n\ngamma", to: "alpha\n\ngamma" },
  "delete everything": { from: "alpha\n\nbeta", to: "" },

  "mid-paragraph replace": {
    from: "the quick brown fox jumps over the lazy dog",
    to: "the quick RED fox jumps over the lazy dog",
  },
  "mid-paragraph insert": {
    from: "the quick brown fox",
    to: "the quick brown and rather smug fox",
  },
  "mid-paragraph delete": {
    from: "the quick brown fox jumps",
    to: "the quick fox jumps",
  },
  "paragraph replaced wholesale": {
    from: "alpha\n\nbeta\n\ngamma",
    to: "alpha\n\ncompletely different text here\n\ngamma",
  },
  "inline mark added mid-paragraph": {
    from: "the quick brown fox",
    to: "the quick **brown** fox",
  },
  "inline mark removed": {
    from: "the quick **brown** fox",
    to: "the quick brown fox",
  },
  "link added": {
    from: "see the docs for more",
    to: "see the [docs](https://example.com/d) for more",
  },
  "heading level changed": { from: "# Title\n\nbody", to: "## Title\n\nbody" },
  "heading text changed": { from: "# Title\n\nbody", to: "# Titles\n\nbody" },
  "paragraph becomes a heading": { from: "alpha\n\nbeta", to: "# alpha\n\nbeta" },

  "list reordering": {
    from: "- one\n- two\n- three",
    to: "- three\n- one\n- two",
  },
  "list reordering with a stable neighbour": {
    from: "intro\n\n- one\n- two\n- three\n\noutro",
    to: "intro\n\n- two\n- three\n- one\n\noutro",
  },
  "list item appended": { from: "- one\n- two", to: "- one\n- two\n- three" },
  "list item removed": { from: "- one\n- two\n- three", to: "- one\n- three" },
  "list item edited": { from: "- one\n- two\n- three", to: "- one\n- TWO\n- three" },
  "ordered list renumbered": { from: "1. one\n2. two", to: "1. one\n2. two\n3. three" },
  "task toggled": { from: "- [ ] ship it", to: "- [x] ship it" },
  "bullets become a paragraph": { from: "- one\n- two", to: "one and two" },

  "code block edited": {
    from: "```ts\nconst a = 1;\n```",
    to: "```ts\nconst a = 2;\n```",
  },
  "code block added": {
    from: "before\n\nafter",
    to: "before\n\n```sh\nls -la\n```\n\nafter",
  },
  "quote edited": { from: "> quoted\n\nrest", to: "> quoted text\n\nrest" },
  "table cell edited": {
    from: "| a | b |\n| --- | --- |\n| 1 | 2 |",
    to: "| a | b |\n| --- | --- |\n| 1 | 3 |",
  },
  "hr inserted": { from: "alpha\n\nbeta", to: "alpha\n\n---\n\nbeta" },

  "whole body rewritten": {
    from: "alpha\n\nbeta\n\ngamma",
    to: "# New\n\nnothing in common at all\n\n- a\n- b",
  },
  "agent appends a section": {
    from: "# Notes\n\nexisting paragraph",
    to: "# Notes\n\nexisting paragraph\n\n## Findings\n\none\n\ntwo",
  },
};

describe("applyMarkdownDiff — the diff reproduces `to` exactly", () => {
  for (const [name, { from, to }] of Object.entries(CORPUS)) {
    it(name, () => {
      const doc = seedDocFromMarkdown(from);
      expect(applyMarkdownDiff(doc, from, to)).toBe(true);
      expect(docToMarkdown(doc)).toBe(normalizeMarkdown(to));
    });
  }

  it("is exact in the reverse direction too", () => {
    for (const [name, { from, to }] of Object.entries(CORPUS)) {
      const doc = seedDocFromMarkdown(to);
      const applied = applyMarkdownDiff(doc, to, from);
      expect(applied, `${name} (reversed) should apply`).toBe(true);
      expect(docToMarkdown(doc), `${name} (reversed)`).toBe(normalizeMarkdown(from));
    }
  });

  it("takes the caller's origin, so the flush can tell the database from a human", () => {
    const doc = seedDocFromMarkdown("alpha");
    const marker = { who: "the caller" };
    const origins: unknown[] = [];
    doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
    applyMarkdownDiff(doc, "alpha", "alpha\n\nbeta", { origin: marker });
    expect(origins).toEqual([marker]);
  });

  it("defaults the origin to BRIDGE_ORIGIN", () => {
    const doc = seedDocFromMarkdown("alpha");
    const origins: unknown[] = [];
    doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));
    applyMarkdownDiff(doc, "alpha", "alpha\n\nbeta");
    expect(origins).toEqual([BRIDGE_ORIGIN]);
  });

  it("defaults to an origin the flush pipeline treats as non-contributory", () => {
    // flush.ts's FLUSH_ORIGIN, spelled out rather than imported (importing it
    // would drag the write path into this module's test). If that constant ever
    // changes, bridge.ts's `INGEST_ORIGIN` annotation fails to typecheck and
    // this assertion says why it mattered: a bridge write under an origin the
    // flush does not recognise is refused, reverted out of the live doc, and
    // escalated as `unattributed` — the agent's write undone.
    expect(BRIDGE_ORIGIN).toBe("collab:flush");
  });

  it("emits ONE transaction for a multi-block change", () => {
    const doc = seedDocFromMarkdown("alpha\n\nbeta\n\ngamma");
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    expect(applyMarkdownDiff(doc, "alpha\n\nbeta\n\ngamma", "zero\n\nalpha\n\nBETA")).toBe(true);
    expect(updates).toBe(1);
  });
});

/* ========================================================================== *
 * 2. Minimality — an unrelated block is not rewritten                         *
 * ========================================================================== */

describe("applyMarkdownDiff — minimality", () => {
  it("leaves untouched blocks as the SAME Yjs nodes (cursors survive)", () => {
    const from = "alpha\n\nbeta\n\ngamma";
    const doc = seedDocFromMarkdown(from);
    const [a, b, c] = blocks(doc);
    expect(applyMarkdownDiff(doc, from, "alpha\n\nBETA changed\n\ngamma")).toBe(true);
    const after = blocks(doc);
    expect(after[0]).toBe(a);
    expect(after[2]).toBe(c);
    // …and the CHANGED one is edited in place rather than replaced, so a cursor
    // sitting in that paragraph is preserved too.
    expect(after[1]).toBe(b);
    expect(docToMarkdown(doc)).toBe(normalizeMarkdown("alpha\n\nBETA changed\n\ngamma"));
  });

  it("does not touch the blocks around an insertion", () => {
    const from = "alpha\n\nbeta";
    const doc = seedDocFromMarkdown(from);
    const [a, b] = blocks(doc);
    expect(applyMarkdownDiff(doc, from, "alpha\n\nmiddle\n\nbeta")).toBe(true);
    const after = blocks(doc);
    expect(after[0]).toBe(a);
    expect(after[2]).toBe(b);
  });

  it("edits a paragraph's text in place, keeping the surviving characters", () => {
    const from = "the quick brown fox";
    const doc = seedDocFromMarkdown(from);
    const el = blocks(doc)[0] as Y.XmlElement;
    const text = el.toArray()[0] as Y.XmlText;
    expect(applyMarkdownDiff(doc, from, "the quick RED fox")).toBe(true);
    expect((blocks(doc)[0] as Y.XmlElement).toArray()[0]).toBe(text);
    expect(docToMarkdown(doc)).toBe("the quick RED fox");
  });
});

/* ========================================================================== *
 * 3. Three-way — the live doc is a third state                                *
 * ========================================================================== */

describe("applyMarkdownDiff — three-way merge", () => {
  it("keeps a local edit in an UNRELATED paragraph", () => {
    const from = "alpha\n\nbeta";
    const doc = seedDocFromMarkdown(from);
    // the user types into `alpha` while the agent rewrites `beta`
    const el = blocks(doc)[0] as Y.XmlElement;
    (el.toArray()[0] as Y.XmlText).insert(5, " typed");
    expect(docToMarkdown(doc)).toBe("alpha typed\n\nbeta");

    expect(applyMarkdownDiff(doc, from, "alpha\n\nbeta rewritten")).toBe(true);
    expect(docToMarkdown(doc)).toBe("alpha typed\n\nbeta rewritten");
  });

  it("keeps a locally APPENDED paragraph the external write never saw", () => {
    const from = "alpha";
    const doc = seedDocFromMarkdown(from);
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, "mine");
    p.insert(0, [t]);
    frag(doc).insert(1, [p]);

    expect(applyMarkdownDiff(doc, from, "alpha edited")).toBe(true);
    expect(docToMarkdown(doc)).toBe("alpha edited\n\nmine");
  });

  it("merges disjoint edits INSIDE one paragraph", () => {
    const from = "one two three four";
    const doc = seedDocFromMarkdown(from);
    const text = (blocks(doc)[0] as Y.XmlElement).toArray()[0] as Y.XmlText;
    text.insert(from.length, " five"); // local edit at the END
    expect(applyMarkdownDiff(doc, from, "ONE two three four")).toBe(true); // external at the START
    expect(docToMarkdown(doc)).toBe("ONE two three four five");
  });

  it("REFUSES overlapping edits inside one paragraph rather than arbitrating", () => {
    const from = "the quick brown fox";
    const doc = seedDocFromMarkdown(from);
    const text = (blocks(doc)[0] as Y.XmlElement).toArray()[0] as Y.XmlText;
    text.delete(4, 5); // the user is editing "quick"…
    text.insert(4, "slow");
    expect(applyMarkdownDiff(doc, from, "the QUICK brown fox")).toBe(false); // …so is the agent
    // Refused means UNCHANGED: a false must never leave a half-applied document.
    expect(docToMarkdown(doc)).toBe("the slow brown fox");
  });

  it("REFUSES to delete a paragraph somebody is typing into", () => {
    const from = "alpha\n\nbeta";
    const doc = seedDocFromMarkdown(from);
    const text = (blocks(doc)[1] as Y.XmlElement).toArray()[0] as Y.XmlText;
    text.insert(4, " being edited right now");
    expect(applyMarkdownDiff(doc, from, "alpha")).toBe(false);
    expect(docToMarkdown(doc)).toBe("alpha\n\nbeta being edited right now");
  });

  it("applies a delete whose paragraph the room never had (convergent)", () => {
    const doc = seedDocFromMarkdown("alpha");
    expect(applyMarkdownDiff(doc, "alpha\n\nbeta", "alpha")).toBe(true);
    expect(docToMarkdown(doc)).toBe("alpha");
  });
});

/* ========================================================================== *
 * 4. Idempotence                                                              *
 * ========================================================================== */

describe("applyMarkdownDiff — idempotence", () => {
  it("is a no-op when the room already holds `to`", () => {
    const from = "alpha\n\nbeta";
    const to = "alpha\n\nbeta\n\ngamma";
    const doc = seedDocFromMarkdown(from);
    expect(applyMarkdownDiff(doc, from, to)).toBe(true);

    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    expect(applyMarkdownDiff(doc, from, to)).toBe(true);
    expect(updates).toBe(0);
    expect(docToMarkdown(doc)).toBe(normalizeMarkdown(to));
  });

  it("does not duplicate an inserted block when the diff is re-run over the corpus", () => {
    for (const [name, { from, to }] of Object.entries(CORPUS)) {
      const doc = seedDocFromMarkdown(from);
      expect(applyMarkdownDiff(doc, from, to), name).toBe(true);
      expect(applyMarkdownDiff(doc, from, to), `${name} (re-run)`).toBe(true);
      expect(docToMarkdown(doc), `${name} (re-run)`).toBe(normalizeMarkdown(to));
    }
  });

  it("writes nothing at all when from === to and no title is given", () => {
    const doc = seedDocFromMarkdown("alpha");
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    expect(applyMarkdownDiff(doc, "alpha", "alpha")).toBe(true);
    expect(updates).toBe(0);
  });
});

/* ========================================================================== *
 * 5. Title                                                                    *
 * ========================================================================== */

describe("applyMarkdownDiff — title", () => {
  it("leaves the title alone when none is given", () => {
    const doc = seedDocFromMarkdown("alpha", { title: "Kept" });
    expect(applyMarkdownDiff(doc, "alpha", "beta")).toBe(true);
    expect(docTitle(doc)).toBe("Kept");
  });

  it("applies a minimal character edit to the title", () => {
    const doc = seedDocFromMarkdown("alpha", { title: "Quarterly plan" });
    const text = doc.getText(TITLE_TEXT);
    expect(applyMarkdownDiff(doc, "alpha", "alpha", { title: "Quarterly plans" })).toBe(true);
    expect(docTitle(doc)).toBe("Quarterly plans");
    expect(doc.getText(TITLE_TEXT)).toBe(text);
  });

  it("clears the title on null", () => {
    const doc = seedDocFromMarkdown("alpha", { title: "Gone" });
    expect(applyMarkdownDiff(doc, "alpha", "alpha", { title: null })).toBe(true);
    expect(docTitle(doc)).toBe("");
  });

  it("updates the title alongside a body change, in one transaction", () => {
    const doc = seedDocFromMarkdown("alpha", { title: "Old" });
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    expect(applyMarkdownDiff(doc, "alpha", "alpha\n\nbeta", { title: "New" })).toBe(true);
    expect(updates).toBe(1);
    expect(docTitle(doc)).toBe("New");
    expect(docToMarkdown(doc)).toBe("alpha\n\nbeta");
  });
});

/* ========================================================================== *
 * 6. The seam docStore/flush already speak                                    *
 * ========================================================================== */

describe("markdownDiffBridge", () => {
  it("is the named-argument form of the same function", () => {
    const doc = seedDocFromMarkdown("alpha", { title: "T" });
    expect(
      markdownDiffBridge({
        doc,
        from: "alpha",
        to: "alpha\n\nbeta",
        title: "T2",
        origin: "collab:flush",
      }),
    ).toBe(true);
    expect(docToMarkdown(doc)).toBe("alpha\n\nbeta");
    expect(docTitle(doc)).toBe("T2");
  });

  it("returns false (never throws) on a merge it cannot make", () => {
    const from = "the quick brown fox";
    const doc = seedDocFromMarkdown(from);
    const text = (blocks(doc)[0] as Y.XmlElement).toArray()[0] as Y.XmlText;
    text.delete(4, 5);
    expect(markdownDiffBridge({ doc, from, to: "the QUICK brown fox", origin: null })).toBe(false);
  });
});

describe("changedBlockRanges — where phase 5's agent cursor travels", () => {
  it("returns one range per block the write ADDED, in document order", () => {
    const from = "alpha";
    const doc = seedDocFromMarkdown(from);
    // Apply the write, then ask which ranges it touched — the production order.
    expect(applyMarkdownDiff(doc, from, "alpha\n\nbeta\n\ngamma")).toBe(true);
    const ranges = changedBlockRanges(doc, from);
    expect(ranges.length).toBe(2); // beta, gamma — alpha was untouched
    // Document order: each successive range sits further down the document.
    expect(ranges[0]!.anchor).toBeGreaterThan(0);
    expect(ranges[1]!.anchor).toBeGreaterThan(ranges[0]!.anchor);
    // A range points INSIDE its block: head is at or past the anchor.
    for (const r of ranges) expect(r.head).toBeGreaterThanOrEqual(r.anchor);
  });

  it("returns nothing when the write changed no block the room now holds", () => {
    const from = "alpha\n\nbeta";
    const doc = seedDocFromMarkdown(from);
    // An idempotent re-apply leaves the doc identical to `from`.
    expect(applyMarkdownDiff(doc, from, from)).toBe(true);
    expect(changedBlockRanges(doc, from)).toEqual([]);
  });

  it("flags a rewritten block, not just an inserted one", () => {
    const from = "alpha\n\nbeta";
    const doc = seedDocFromMarkdown(from);
    expect(applyMarkdownDiff(doc, from, "alpha\n\nbeta rewritten")).toBe(true);
    const ranges = changedBlockRanges(doc, from);
    // Only the second block changed; the first (identical) is left out.
    expect(ranges.length).toBe(1);
    expect(ranges[0]!.anchor).toBeGreaterThan(1);
  });
});
