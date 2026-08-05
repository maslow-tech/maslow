/**
 * Where to draw an editor caret popover so it stays on screen.
 *
 * The `[[`-link popover and the `/`-slash menu are both a fixed-width
 * `.editor-slash` box positioned ABSOLUTELY inside the caret's offset parent.
 * Positioning them from the raw caret coordinate alone (`left = caret.left -
 * box.left`) clips them off the right edge in a narrow column — a SidePeek panel
 * or a reading column — where the caret sits past the horizontal midpoint: the
 * type-name labels and long titles run outside the panel, unreadable and, past
 * the panel edge, unhittable by mouse. This is the clamp a real popover
 * primitive applies, hoisted into one pure, tested function both call sites use.
 */

/** The `.editor-slash` box in editor.css: a 232px column, up to 288px tall. */
export const EDITOR_POPOVER_WIDTH = 232;
const EDITOR_POPOVER_MAX_HEIGHT = 288;

interface PopoverRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface EditorPopoverArgs {
  /** the caret, in viewport coordinates (`coordsAtPos`). */
  caret: PopoverRect;
  /** the offset parent the popover is positioned within, in viewport coords. */
  box: PopoverRect;
  /** viewport size; defaults to `window` when omitted. */
  viewport?: { width: number; height: number };
  width?: number;
  maxHeight?: number;
  margin?: number;
}

/**
 * Returns `{top,left}` as offsets from `box`'s top-left (what an absolutely
 * positioned popover inside `box` wants).
 *
 * Both `caret` and `box` are viewport rects, so the clamp is computed in
 * viewport space — keeping the popover inside BOTH the container and the visible
 * viewport — then converted back to box-relative offsets. Horizontally the left
 * edge is pulled in so the full width plus a margin fits; vertically the popover
 * sits below the caret but flips above it when it would overflow the viewport
 * bottom and there is more room above.
 */
export function editorPopoverPos(args: EditorPopoverArgs): { top: number; left: number } {
  const width = args.width ?? EDITOR_POPOVER_WIDTH;
  const maxHeight = args.maxHeight ?? EDITOR_POPOVER_MAX_HEIGHT;
  const margin = args.margin ?? 8;
  const vw =
    args.viewport?.width ?? (typeof window !== "undefined" ? window.innerWidth : args.box.right);
  const vh =
    args.viewport?.height ?? (typeof window !== "undefined" ? window.innerHeight : args.box.bottom);

  // Horizontal: keep the left edge inside the container AND the viewport, with
  // room for the full width plus a margin on the right.
  const minLeft = Math.max(args.box.left, 0) + margin;
  const maxRight = Math.min(args.box.right, vw) - margin;
  let left = args.caret.left;
  if (left + width > maxRight) left = maxRight - width;
  if (left < minLeft) left = minLeft;

  // Vertical: below the caret, flipping above it when the popover would overflow
  // the viewport bottom and there is genuinely more room above.
  const below = args.caret.bottom + 6;
  const spaceBelow = vh - below;
  const spaceAbove = args.caret.top - 6;
  const flip = spaceBelow < maxHeight && spaceAbove > spaceBelow;
  const top = flip ? Math.max(margin, args.caret.top - 6 - maxHeight) : below;

  return { top: top - args.box.top, left: left - args.box.left };
}
