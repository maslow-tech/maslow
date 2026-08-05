import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

/**
 * Two skins: "light" (the paper skin) and "dark" (the aurora skin). BOTH carry
 * type hues — identity is encoded in colour in either skin (see `typeHue` in
 * lib/ui.ts: the paper skin holds the same identities as dark, one register
 * quieter, ink-weight 600/700-band hues on white). So type dots, enum pills and
 * presence avatars are coloured in light too; they are NOT desaturated.
 *
 * `mono` is simply `theme === "light"`, and it gates ONE thing: the aurora
 * background wash (Shell/Login/Home render the radial-gradient glow only when
 * `!mono`). It does NOT collapse any content colour to grayscale — the only
 * always-monochrome element is the null/untyped case, handled in ui.ts, not via
 * `mono`. Do not wire type dots / enum pills / avatars through `mono`.
 *
 * The skin ALWAYS follows the device (`prefers-color-scheme`) and tracks OS
 * changes live — there is no in-app override. (Deprecated-hiding is a
 * separate, still-user-controlled preference and stays.)
 */
export type Theme = "light" | "dark";

// Key from when the in-app flipper could pin a skin; cleared on load so old
// overrides don't keep winning over the device.
const LEGACY_STORE_KEY = "brain-theme";

function deviceTheme(): Theme {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Write the skin onto the root element — the thing every CSS token reads. */
function stampTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

const ThemeCtx = createContext<{
  theme: Theme;
  mono: boolean;
  /** hide deprecated types/props everywhere (sidebar, library, columns). */
  hideDeprecated: boolean;
  toggleDeprecated: () => void;
}>({
  theme: "light",
  mono: true,
  hideDeprecated: true,
  toggleDeprecated: () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(deviceTheme);
  // Default ON — deprecated things are hidden until you opt to see them.
  const [hideDeprecated, setHideDeprecated] = useState<boolean>(
    () => localStorage.getItem("brain-hide-deprecated") !== "0",
  );

  // Follow the OS live.
  useEffect(() => {
    localStorage.removeItem(LEGACY_STORE_KEY);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (): void => {
      const next: Theme = mq.matches ? "dark" : "light";
      // Stamp the DOM BEFORE setState. React flushes CHILD effects before this
      // provider's own [theme] effect in the same commit, and consumers read
      // CSS tokens off the stamped root at effect time — GraphView's canvas
      // palette (`--line`/`--ink-strong`/`--ground` via getComputedStyle) being
      // the load-bearing case. Stamped only in the effect, a live OS flip
      // repainted the graph with the OUTGOING skin's tokens (white ground under
      // the aurora UI) until the route remounted.
      stampTheme(next);
      setTheme(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    // Initial stamp (and any future setTheme path); on a live OS flip the
    // matchMedia listener above has already stamped this exact value.
    stampTheme(theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("brain-hide-deprecated", hideDeprecated ? "1" : "0");
  }, [hideDeprecated]);

  const toggleDeprecated = useCallback(() => setHideDeprecated((v) => !v), []);

  return (
    <ThemeCtx.Provider value={{ theme, mono: theme === "light", hideDeprecated, toggleDeprecated }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeCtx);
}
