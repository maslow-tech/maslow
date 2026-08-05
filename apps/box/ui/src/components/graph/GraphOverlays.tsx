/**
 * The phase-6 graph overlays, composed as CHILDREN of `<GraphView>`.
 *
 * `GraphView` is "a mount point, not a monolith" (its module header, rule 4):
 * the insight panel, time scrubber, deep search, box-select bar, saved-views
 * menu, node presence and the peek bridge each plug in through the exported
 * engine contract (`useGraphEngine`) and render as children, so none of them
 * edits `GraphView` to exist. That composition had NEVER been written — the
 * route mounted `<GraphView />` childless — so every one of these built,
 * unit-tested components was tree-shaken dead and none of phases p6-t9…t16
 * actually rendered. This file is that composition.
 *
 * Placement:
 *  - `NodePresence`, `NodePeekBridge`, `InsightPanel` and `SelectionSurface`
 *    self-position over the canvas (`absolute inset-0` / `top-3 right-3` /
 *    `bottom-3`), each with `pointer-events-none` roots that re-enable only
 *    their interactive chrome, so the camera underneath stays live.
 *  - The scrubber is host-positioned (it renders a plain flow box) into the
 *    bottom-right corner on desktop, and into a top-centre column on compact,
 *    where the bottom edge is already the insight sheet and the selection bar.
 *
 * Neither search NOR the saved-views menu is here — both are RAIL chrome now.
 * Search has exactly one owner (`useGraphSearch`, hoisted into GraphView and
 * surfaced through the controls rail's own search box) so the "search" highlight
 * layer has a single writer; it used to ALSO be a standalone `<GraphSearch>`
 * overlay in the top-centre column, which meant two owners and the empty rail box
 * wiped the overlay's highlight on every page landing. The views menu made the
 * same move for a layout reason rather than a correctness one: a saved view is a
 * snapshot of the rail's own state, so it belongs at the top of the rail (via
 * GraphView's `rail` slot, filled in AuthedApp) rather than in a chip floating
 * over the middle of the map. With both gone the desktop column is empty, so it
 * does not render at all and the map is clear between its four edge panels.
 */
import type { Whoami } from "../../lib/api";
import { useGraphEngine } from "../../views/GraphView";
import { InsightPanel } from "./InsightPanel";
import { TimeScrubber } from "./TimeScrubber";
import { NodePeekBridge } from "./NodePeekBridge";
import { NodePresence } from "./NodePresence";
import { SelectionSurface } from "./SelectionBar";

export function GraphOverlays({ user }: { user: Whoami }) {
  const { compact } = useGraphEngine();
  return (
    <>
      {/* self-positioning overlays (each pins itself over the canvas) */}
      <NodePresence selfActorId={user.id} />
      <NodePeekBridge />
      <InsightPanel />
      <SelectionSurface user={user} />

      {/* "What changed" is a reading panel, not a toolbar — it belongs in the
          quiet bottom-right corner, not floating over the middle of the map.
          Desktop bottom-right is free there (the insight panel pins top-right,
          the selection/path bars are bottom-CENTRE). The wrapper is
          non-interactive; the panel re-enables its own pointer events.

          COMPACT keeps it in the top-centre column instead: a phone's bottom
          edge is already the insight sheet and the selection bar. That column
          stays at top-16, but the controls rail — which also pins at top-16 when
          opened — is z-30, above this z-20, so the opaque open sheet occludes it
          rather than floating over the sheet's own controls. */}
      {compact ? (
        <div className="pointer-events-none absolute top-16 left-1/2 z-20 flex w-[min(26rem,calc(100%-1.5rem))] -translate-x-1/2 flex-col items-center gap-2">
          <TimeScrubber />
        </div>
      ) : (
        <div className="pointer-events-none absolute right-3 bottom-3 z-20 flex w-[min(22rem,calc(100%-1.5rem))] flex-col items-end">
          <TimeScrubber />
        </div>
      )}
    </>
  );
}
