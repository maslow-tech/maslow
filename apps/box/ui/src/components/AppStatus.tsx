/**
 * The two things the app must say out loud about ITSELF, rather than letting
 * the user infer them from broken-looking screens:
 *
 *  - "you are offline"  — so an empty list reads as "not loaded" and not as
 *    "your brain is empty", which is the failure this exists to prevent.
 *  - "there is a new version" — the box self-updates underneath open tabs; the
 *    service worker refuses to pin an old app (src/sw.js) but it also refuses
 *    to yank the page out from under someone mid-sentence. So: an offer.
 *
 * Deliberately a pill at the bottom, above the safe-area inset: it is chrome
 * for the whole app, must not push layout, and on a phone the bottom is the
 * reachable edge.
 */
import { RefreshCw, WifiOff } from "lucide-react";
import { getServiceWorkerController, useAppStatus, type SwController } from "@/lib/sw-register";
import { useIsMobile } from "@/lib/mobile";
import { Button } from "./ui/button";

export function AppStatus({
  controller,
  bottomBar = false,
}: {
  controller?: SwController | null;
  /**
   * True only where a mobile bottom tab bar is actually rendered beneath us —
   * i.e. inside the authed Shell. The Login screen mounts AppStatus with NO
   * Shell (App.tsx), so there is no bar to clear; reserving its height there
   * would float the pill ~44px above an empty gap instead of at the reachable
   * bottom edge. Defaults false so the barless (login) mount is the safe case.
   */
  bottomBar?: boolean;
}) {
  const { sw, offline } = useAppStatus();
  const isMobile = useIsMobile();
  const ctl = controller ?? getServiceWorkerController();
  const showUpdate = sw === "update-ready";
  if (!offline && !showUpdate) return null;

  // On a phone the Shell renders a 44px (min-h-11) primary bottom bar at
  // bottom-0/z-30; a centered z-50 pill would sit ON it and — being
  // pointer-events-auto — swallow taps to the Search/Graph tabs beneath. Clear
  // the bar's height (plus the safe-area inset the bar itself pads by) so the
  // pill floats just above it instead of over it. But ONLY when that bar is
  // actually present (`bottomBar`) — on the barless Login screen the same
  // clearance would strand the pill above an empty gap.
  const paddingBottom =
    isMobile && bottomBar
      ? "calc(0.75rem + 2.75rem + env(safe-area-inset-bottom))"
      : "calc(0.75rem + env(safe-area-inset-bottom))";

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-3 pb-3"
      style={{ paddingBottom }}
    >
      {offline && (
        <div
          role="status"
          aria-live="polite"
          // bg-panel2 (not bg-panel): --panel is translucent in the dark skin, so
          // scrolled content would ghost up through a fixed overlay; --panel2 is
          // opaque in both skins.
          className="pointer-events-auto flex items-center gap-2 border border-line-soft bg-panel2 px-3 py-2 text-[12.5px] text-ink shadow-sm"
        >
          <WifiOff aria-hidden className="size-3.5 shrink-0 text-mut" />
          <span>Offline — showing what was already loaded. Nothing is saving right now.</span>
        </div>
      )}
      {showUpdate && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-auto flex items-center gap-3 border border-line-soft bg-panel2 px-3 py-2 text-[12.5px] text-ink shadow-sm"
        >
          <RefreshCw aria-hidden className="size-3.5 shrink-0 text-mut" />
          <span>A new version of this brain is available.</span>
          <Button size="sm" variant="outline" onClick={() => ctl?.applyUpdate()}>
            Reload
          </Button>
        </div>
      )}
    </div>
  );
}
