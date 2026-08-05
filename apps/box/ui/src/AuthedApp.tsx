import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import type { Branding, Whoami } from "./lib/api";
import { BrandingView } from "./views/BrandingView";
import { Shell } from "./views/Shell";
import { Home } from "./views/Home";
import { TypeView } from "./views/TypeView";
import { SearchView } from "./views/SearchView";
import { Timeline } from "./views/Timeline";
import { MembersView } from "./views/MembersView";
import { AccessView } from "./views/AccessView";
import { ConnectorsView } from "./views/ConnectorsView";
import { FilesView } from "./views/FilesView";
import { PrivateView } from "./views/PrivateView";
import { UntypedView } from "./views/UntypedView";
import { TrashView } from "./views/TrashView";
import { DemoTourMount } from "./demo/DemoTour";
import { PeekProvider } from "./lib/peek";
import { AppStatus } from "./components/AppStatus";

// The whole authed application lives behind ONE lazy boundary at the auth gate
// (App loads this only after `whoami` succeeds), so an unauthenticated /login —
// the entry chunk — downloads and parses none of it: not TypeView and its four
// database layouts, not react-markdown, not the eleven nav views. Sign-in is the
// one thing that cannot work from cache, so paying for the shell only after it
// succeeds is free to the user who is stuck on the login screen.
//
// WITHIN this chunk the editor and graph stacks (TipTap/Yjs/ProseMirror, PixiJS)
// stay split off again: they are the biggest dependencies in the app and are used
// by exactly these surfaces, so they load when you first open an object or the
// graph, not on the first authed paint. SidePeek carries the editor too and
// mounts on the shell, so it is lazy for the same reason.
const ObjectView = lazy(() =>
  import("./views/ObjectView").then((m) => ({ default: m.ObjectView })),
);
const GraphView = lazy(() => import("./views/GraphView").then((m) => ({ default: m.GraphView })));
const GraphOverlays = lazy(() =>
  import("./components/graph/GraphOverlays").then((m) => ({ default: m.GraphOverlays })),
);
// Rail chrome, not an overlay — it fills GraphView's `rail` slot. Lazy for the
// same reason as its neighbours: it is only ever on /graph.
const GraphViewsMenu = lazy(() =>
  import("./components/graph/GraphViewsMenu").then((m) => ({ default: m.GraphViewsMenu })),
);
const SidePeek = lazy(() => import("./components/SidePeek").then((m) => ({ default: m.SidePeek })));

interface AuthedAppProps {
  user: Whoami;
  onSignOut: () => void;
  brandName: string;
  brand: Branding;
  loadBranding: () => void;
}

/** The signed-in application: the shell, the routed views and the side-peek.
 *  Split into its own chunk so the login screen never pays for it. */
export function AuthedApp({ user, onSignOut, brandName, brand, loadBranding }: AuthedAppProps) {
  return (
    // The side-peek lives OUTSIDE <Routes> on purpose: it renders over whatever
    // route is mounted, driven only by `?peek=<id>`, so opening an object never
    // unmounts the table (or the graph) underneath it.
    <PeekProvider>
      <Suspense fallback={<div className="h-full bg-ground" />}>
        <Routes>
          <Route element={<Shell user={user} onSignOut={onSignOut} brandName={brandName} />}>
            <Route path="/" element={<Home user={user} />} />
            <Route path="/t/:type" element={<TypeView user={user} />} />
            <Route path="/o/:id" element={<ObjectView user={user} />} />
            <Route path="/search" element={<SearchView />} />
            <Route path="/timeline" element={<Timeline />} />
            <Route
              path="/graph"
              element={
                <GraphView rail={<GraphViewsMenu accountId={user.id} />}>
                  <GraphOverlays user={user} />
                </GraphView>
              }
            />
            <Route path="/members" element={<MembersView user={user} />} />
            <Route path="/access" element={<AccessView user={user} />} />
            <Route path="/connectors" element={<ConnectorsView user={user} />} />
            {user.role === "owner" && (
              <Route
                path="/branding"
                element={<BrandingView brand={brand} onChange={loadBranding} />}
              />
            )}
            <Route path="/files" element={<FilesView />} />
            <Route path="/private" element={<PrivateView />} />
            <Route path="/notes" element={<UntypedView />} />
            <Route path="/trash" element={<TrashView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
      {/* Its own boundary so the editor chunk loading never blanks the route
          underneath — the peek is an overlay, and null while it resolves. */}
      <Suspense fallback={null}>
        <SidePeek user={user} />
      </Suspense>
      <DemoTourMount />
      {/* Inside the Shell, which draws the mobile bottom tab bar — reserve its
          height so the pill floats above it, not on it. */}
      <AppStatus bottomBar />
    </PeekProvider>
  );
}
