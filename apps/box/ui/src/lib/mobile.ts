/**
 * "Is this a phone?" — asked once, in one place.
 *
 * The app shell established the breakpoint (below 768px the sidebar stops being
 * furniture and becomes a drawer); the database layouts need the SAME answer,
 * because a board that pages one column at a time while the sidebar still
 * thinks it is a desktop is two different products on one screen. So the query
 * and the hook live here and every surface imports them.
 *
 * It is a media query, not a user-agent sniff and not `window.innerWidth` read
 * once: a rotated phone, a resized desktop window and a split-screen iPad all
 * change the answer while the app is running, and a layout that only measured
 * on mount would be wrong for the rest of the session.
 *
 * `pointer: coarse` is deliberately NOT folded in. Touch and width are separate
 * facts — a touchscreen laptop is wide (it wants the desktop board with drag)
 * and a phone with a Bluetooth mouse is narrow (it still wants one column at a
 * time). Where a decision is genuinely about the INPUT rather than the width —
 * "is HTML5 drag trustworthy here" — ask `useCoarsePointer` instead.
 */
import { useEffect, useState } from "react";

/** Phone width. Kept in sync with the `@media (max-width: 767px)` blocks in
 *  index.css — the CSS and the JS must agree on where the phone starts. */
const MOBILE_QUERY = "(max-width: 767px)";

/** A finger, not a mouse: no hover, no precise pointer. */
const COARSE_QUERY = "(pointer: coarse)";

/**
 * Watch one media query. Guarded at every step: a runtime without `matchMedia`
 * (jsdom in some configurations, an ancient webview) answers `false` and the
 * surface renders its desktop form, which is a worse layout and never a crash.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = (): void => setMatches(mq.matches);
    // Re-read on subscribe: between the initial state and this effect the
    // viewport may already have changed (a rotation during hydration).
    onChange();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    return;
  }, [query]);

  return matches;
}

/** The phone frame. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** A coarse pointer — the reason a drag needs a non-drag alternative. */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_QUERY);
}
