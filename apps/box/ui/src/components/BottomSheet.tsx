/**
 * A bottom sheet — the phone's answer to a popover.
 *
 * On a desktop, "filter · sort · group · columns" is a row of buttons that open
 * popovers anchored to themselves. On a 390px screen that row wraps to four
 * lines of chrome above the data, and each popover opens somewhere the thumb
 * cannot comfortably reach. The sheet is the same controls, rendered where a
 * thumb already is: pinned to the bottom edge, sized to its content up to a
 * ceiling, scrolling internally past that.
 *
 * It is hand-rolled rather than another primitive because the rules it has to
 * keep are the ones the app already keeps everywhere else, and they are short:
 *
 *  - **A real modal.** `role="dialog"` + `aria-modal`, focus moved in on open,
 *    Tab cycles inside, Escape and a backdrop tap close it, and focus returns
 *    to whatever opened it. A sheet that leaks Tab into the page behind it is
 *    a screen-reader trap, not a convenience.
 *  - **It never covers itself.** `max-height: 85vh` with an internally
 *    scrolling body, and the footer/edge padding clears the home indicator via
 *    `env(safe-area-inset-bottom)`.
 *  - **Motion is a preference.** The slide-up is CSS (`.sheet-panel`), and the
 *    reduced-motion floor in index.css turns it into a jump cut.
 *  - **Nothing is rendered while closed.** No `inert` bookkeeping, no hidden
 *    tab stops — a closed sheet is simply not in the tree.
 *
 * Deliberately NOT a drag-to-dismiss surface: a downward drag inside a sheet
 * whose body scrolls is ambiguous on every platform that ships it, and getting
 * it wrong means a member loses a half-built filter by scrolling.
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Everything in the sheet that can take focus, in DOM order. Mirrors the
 *  side-peek's trap — one definition of "focusable" for the whole app would be
 *  better still, but this one is three lines and has no dependencies. */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Named for the screen reader and shown as the sheet's heading. */
  title: string;
  /** Optional line under the title — what this sheet is FOR, when the title
   *  alone ("View options") does not say it. */
  description?: string;
  /** A trailing control in the header (e.g. "Reset"), left of the close X. */
  action?: ReactNode;
  children: ReactNode;
  /** For tests and for hosts that need to find their own sheet. */
  testId?: string;
}

export function BottomSheet({
  open,
  onClose,
  title,
  description,
  action,
  children,
  testId = "bottom-sheet",
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Focus in on open, back out on close. The ref is captured BEFORE the panel
  // takes focus, or "return focus to what opened it" returns it to the sheet.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement ? active : null;
    const panel = panelRef.current;
    // The first real control, else the panel itself — landing on the close
    // button every time makes the sheet feel like a dead end.
    const first = panel ? focusablesIn(panel)[0] : null;
    (first ?? panel)?.focus();
    return () => {
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      if (back && back.isConnected) back.focus();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        // A menu or popover opened from inside the sheet renders in a PORTAL,
        // but React still bubbles its events through this tree. Escape there
        // means "close the menu", and closing the sheet under it would throw
        // away a half-built filter.
        const root = panelRef.current;
        if (root && e.target instanceof Node && !root.contains(e.target)) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const items = focusablesIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" data-testid={testId}>
      <div
        aria-hidden
        onMouseDown={onClose}
        className="sheet-backdrop absolute inset-0 bg-black/30"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="sheet-panel safe-bottom relative flex max-h-[85vh] flex-col border-t border-line-soft bg-ground shadow-[0_-8px_28px_rgba(0,0,0,0.16)] outline-none"
      >
        {/* The grab handle is a signifier, not a control: it says "this came up
            from the bottom edge" without pretending to be draggable. */}
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-full bg-line-soft" />

        <div className="flex items-start gap-2 px-4 pt-2.5 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-[650] tracking-[-0.01em]">{title}</h2>
            {description && <p className="mt-0.5 text-[12px] text-dim">{description}</p>}
          </div>
          {action}
          <Button
            variant="ghost"
            size="icon-sm"
            className="touch-target -mt-1 shrink-0 text-dim"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-5">
          {children}
        </div>
      </div>
    </div>
  );
}
