import { describe, expect, it } from "vitest";

import { EDITOR_POPOVER_WIDTH, editorPopoverPos } from "./popoverPos";

/**
 * The caret-popover clamp shared by the `[[` link menu and the `/` slash menu.
 * The bug it fixes is a popover positioned from the raw caret offset that runs
 * off the right edge of a narrow column; these pin the clamp and the flip.
 */
describe("editorPopoverPos", () => {
  const box = { top: 0, bottom: 800, left: 0, right: 1000 };
  const viewport = { width: 1000, height: 800 };

  it("places the popover at the caret when there is room", () => {
    const caret = { top: 100, bottom: 120, left: 50, right: 52 };
    expect(editorPopoverPos({ caret, box, viewport })).toEqual({ top: 126, left: 50 });
  });

  it("clamps left so the full width stays inside a narrow container", () => {
    // A SidePeek-sized column (440px wide) offset inside the viewport, caret past
    // its horizontal midpoint. Un-clamped, left would be 300 and the 232px
    // popover would spill to 532 — past the 440 container edge.
    const narrow = { top: 0, bottom: 600, left: 100, right: 540 };
    const caret = { top: 200, bottom: 216, left: 400, right: 402 };
    const pos = editorPopoverPos({ caret, box: narrow, viewport: { width: 1200, height: 600 } });
    expect(pos.left).toBe(200); // box-relative
    // The popover's right edge now sits inside the container.
    expect(pos.left + EDITOR_POPOVER_WIDTH).toBeLessThanOrEqual(narrow.right - narrow.left);
  });

  it("flips above the caret when it would overflow the viewport bottom", () => {
    const caret = { top: 560, bottom: 576, left: 50, right: 52 };
    const pos = editorPopoverPos({ caret, box, viewport: { width: 800, height: 600 } });
    // Above the caret, not below it.
    expect(pos.top).toBeLessThan(caret.top);
    expect(pos.top).toBe(266);
  });

  it("never pushes the popover off the left edge", () => {
    const caret = { top: 10, bottom: 26, left: -40, right: -38 };
    const pos = editorPopoverPos({ caret, box, viewport });
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });
});
