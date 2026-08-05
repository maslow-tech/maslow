import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api, ApiError, setUnauthorizedHandler, type Branding, type Whoami } from "./lib/api";
import { applyBranding, DEFAULT_BRAND } from "./lib/branding";
import { clearAllDrafts, purgeForeignDrafts } from "./lib/draftMirror";
import { clearRecents, purgeForeignChrome } from "./lib/favorites";
import { resetObjectMetaCache } from "./components/Breadcrumbs";
import { Login } from "./views/Login";
import { AppStatus } from "./components/AppStatus";

// The ENTIRE signed-in application is one lazy chunk, loaded only after `whoami`
// succeeds. The entry chunk this file compiles into is therefore just the auth
// gate + the login screen: an unauthenticated /login downloads and parses none
// of the authed shell — not TypeView and its four database layouts, not
// react-markdown, not the editor or the graph. See `AuthedApp` for the further
// splits (editor/pixi) that live INSIDE that chunk.
const AuthedApp = lazy(() => import("./AuthedApp").then((m) => ({ default: m.AuthedApp })));

/** Session gate: try the cookie; 401 → login; success → the app shell. */
export function App() {
  const [user, setUser] = useState<Whoami | null>(null);
  const [checking, setChecking] = useState(true);
  const [brand, setBrand] = useState<Branding>({ name: null, hasFavicon: false });

  // Sign-out is also the 401/session-expiry path: nothing typed survives the
  // session that typed it, so the local draft mirror goes with it.
  const signOut = useCallback(() => {
    clearAllDrafts();
    // Where you have been is a session artifact, and the cached crumb titles
    // are brain content. Favorites are a durable preference and stay — still
    // account-keyed, still purged the moment another account signs in below.
    clearRecents();
    resetObjectMetaCache();
    setUser(null);
  }, []);
  const loadBranding = useCallback(() => {
    api
      .branding()
      .then((b) => {
        setBrand(b);
        applyBranding(b);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
    loadBranding();
    api
      .whoami()
      .then((me) => {
        // Before anything renders: another member's drafts must not survive on
        // this browser, let alone be shown.
        purgeForeignDrafts(me.id);
        // Same rule for the sidebar's chrome: a favorite is an object id and a
        // recent is a title, both content when the object is private.
        purgeForeignChrome(me.id);
        setUser(me);
      })
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setChecking(false));
  }, [signOut, loadBranding]);

  const brandName = brand.name ?? DEFAULT_BRAND;

  if (checking) return <div className="h-full bg-ground" />;
  if (!user) {
    return (
      <>
        <Login
          brandName={brandName}
          onSignedIn={() => {
            api.whoami().then(setUser).catch(console.error);
          }}
        />
        {/* Offline at the login screen is the case most likely to look like a
            broken box — sign-in is the one thing that cannot work from cache. */}
        <AppStatus />
      </>
    );
  }

  return (
    <Suspense fallback={<div className="h-full bg-ground" />}>
      <AuthedApp
        user={user}
        onSignOut={signOut}
        brandName={brandName}
        brand={brand}
        loadBranding={loadBranding}
      />
    </Suspense>
  );
}
