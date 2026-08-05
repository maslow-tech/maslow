/**
 * The dashboard's dropdown.
 *
 * A REAL `<select>` underneath, deliberately. `GraphControls`' own header makes
 * the rule explicit — "plain HTML controls: `<input type=range>`, `<select>`,
 * `<details>` and `<button>` are keyboard-operable, screen-reader-labelled and
 * skin-agnostic for free; a bespoke drag handle is none of those" — and a
 * hand-rolled listbox would be re-implementing type-ahead, Home/End, PageUp,
 * the native mobile picker and the whole a11y tree to gain a chevron.
 *
 * So this styles rather than replaces: the browser's own arrow is removed
 * (`appearance-none`) and one is drawn in the theme's ink, the field gets the
 * same bordered-panel treatment as every other instrument, and the value keeps
 * the page's type scale. Colours are CSS variables only — nothing here invents
 * one, so both skins follow the page.
 */
import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Rendered small and dim, before the field — omit for a bare control. */
  label?: string;
  /** Matches the surrounding density: the graph rail is tighter than a page. */
  dense?: boolean;
}

export function SelectField({ label, dense = false, className, id, ...rest }: SelectFieldProps) {
  const text = dense ? "text-[11.5px]" : "text-[12.5px]";
  const pad = dense ? "py-0.5 pr-6 pl-1.5" : "py-1 pr-7 pl-2";
  return (
    <div className={`flex min-w-0 items-center gap-2 ${className ?? ""}`}>
      {label !== undefined && (
        <label
          htmlFor={id}
          className={`shrink-0 ${dense ? "text-[11.5px]" : "text-[11.5px]"} text-mut`}
        >
          {label}
        </label>
      )}
      <div className="relative min-w-0 flex-1">
        <select
          id={id}
          {...rest}
          className={`w-full appearance-none rounded-none border border-line-soft bg-panel ${pad} ${text} text-ink transition-colors hover:border-[var(--line)] focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-[var(--ink-strong)]`}
        />
        {/* pointer-events-none so the whole field stays one click target. */}
        <ChevronDown
          size={dense ? 12 : 13}
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-dim"
        />
      </div>
    </div>
  );
}
