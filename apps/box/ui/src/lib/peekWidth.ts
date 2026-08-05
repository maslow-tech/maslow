/**
 * The side peek's WIDTH, on its own.
 *
 * Extracted out of `components/SidePeek` so a consumer can ask how wide the
 * peek is without importing the peek itself. SidePeek pulls in the block
 * editor, and through it prosemirror + tiptap — which is exactly why
 * `AuthedApp` lazy-loads it. A single `import { readPeekWidth }` from
 * `GraphView` was enough to defeat that: it dragged the whole editor into the
 * graph route's bundle and took the graph e2e suite down at module scope
 * (prosemirror touching `.style` where there is no DOM).
 *
 * This module is pure and DOM-free apart from `localStorage`, which every
 * caller here already tolerates failing.
 */

export const PEEK_DEFAULT_WIDTH = 520;
export const PEEK_MIN_WIDTH = 380;
export const PEEK_MAX_WIDTH = 900;
const WIDTH_KEY = "brain.peek.width";
/** the caller must never be fully covered — always leave a strip of context */
const KEEP_VISIBLE = 120;

/** Clamp a width to the panel's range AND to what this viewport can spare. */
export function clampPeekWidth(width: number, viewport: number): number {
  const max = Math.max(PEEK_MIN_WIDTH, Math.min(PEEK_MAX_WIDTH, viewport - KEEP_VISIBLE));
  if (!Number.isFinite(width)) return Math.min(PEEK_DEFAULT_WIDTH, max);
  return Math.round(Math.max(PEEK_MIN_WIDTH, Math.min(max, width)));
}

/** Storage is optional everywhere in this app (Safari private mode, quota). */
export function readPeekWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (!raw) return PEEK_DEFAULT_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) ? n : PEEK_DEFAULT_WIDTH;
  } catch {
    return PEEK_DEFAULT_WIDTH;
  }
}

export function writePeekWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* a browser that refuses storage still gets a resizable panel */
  }
}
