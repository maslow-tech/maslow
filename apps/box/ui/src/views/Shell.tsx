import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  Cable,
  Clock,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Home,
  Lock,
  LogOut,
  Menu,
  Palette,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Search,
  Tags,
  Trash2,
  Users,
  Waypoints,
  X,
} from "lucide-react";
import { api, type TypeSummary, type Whoami } from "../lib/api";
import { registerTypeIcons, typeLabel, typeName } from "../lib/ui";
import { Empty, TypeIcon } from "../components/bits";
import { Boundary } from "../components/Boundary";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { CommandK, type PaletteEntry } from "../components/CommandK";
import { PinnedViews } from "../components/SavedViews";
import { QuickCreate, isTypingTarget } from "../components/QuickCreate";
import { chromeHref, useChrome, type Favorite, type Recent } from "../lib/favorites";
import { usePeek } from "../lib/peek";
import { RoutePresenceRail } from "../components/PresenceRail";
import { routeKeyForPath } from "../lib/routePresence";
// Phone width lives in lib/mobile — below `MOBILE_QUERY` the sidebar stops
// being furniture and becomes a drawer: a 54px rail on a 390px screen is 14%
// of the viewport spent on icons nobody can hit. The database layouts import
// the SAME hook, so the shell and the views can never disagree about where
// the phone starts.
import { useIsMobile } from "../lib/mobile";
import { useTheme } from "../lib/theme";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** How far in from the left edge a touch may start and still mean "open the
 *  drawer" — wide enough to be reachable, narrow enough that it never steals
 *  a horizontal drag inside the page. */
const EDGE_ZONE_PX = 28;
/** Horizontal travel that commits a swipe. */
const SWIPE_MIN_PX = 56;

/**
 * The app frame: a fixed sidebar and a full-bleed content pane. Databases in
 * the sidebar are the live type catalog — counts included. The aurora glow
 * exists only in the dark skin; the light skin is plain paper.
 *
 * **Two frames, one tree.** On a desktop the sidebar is a column that can
 * collapse to a 54px rail. Under `MOBILE_QUERY` that same `<aside>` becomes an
 * off-canvas drawer — hamburger or edge-swipe to open, backdrop/Escape/swipe or
 * any navigation to dismiss, focus trapped while it is up — and the four
 * destinations people actually reach for move into a persistent bottom bar.
 * Nothing forks into a second component: the mobile branch only changes
 * position and sizing, so a feature added to the sidebar lands on both.
 */
export function Shell({
  user,
  onSignOut,
  brandName,
}: {
  user: Whoami;
  onSignOut: () => void;
  brandName: string;
}) {
  const { mono, hideDeprecated, toggleDeprecated } = useTheme();
  const [types, setTypes] = useState<TypeSummary[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // Viewers can read the whole brain and write none of it — quick-create is
  // hidden for them entirely (the server refuses anyway; this keeps the UI
  // from offering a door that never opens).
  const canWrite = user.role !== "viewer";
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem("brain-sidebar");
    if (stored) return stored === "collapsed";
    // No explicit preference yet — default collapsed on narrow screens so the
    // 248px sidebar doesn't crush the content into an unreadable sliver.
    return window.innerWidth < 768;
  });
  const navigate = useNavigate();
  const location = useLocation();
  const peek = usePeek();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  // The rail is a DESKTOP state. On a phone the drawer is either all the way
  // open or not there at all — a 54px rail sliding in would be the worst of
  // both frames.
  const railed = !isMobile && collapsed;
  /**
   * The screen's human name for the rail's summary line ("3 people viewing
   * Deals"). Derived from the SAME type list the sidebar already read — never
   * from an object, whose title is content the rail must not carry.
   */
  const presenceLabel = useMemo(() => {
    const segments = location.pathname.split("/").filter(Boolean);
    if (segments[0] === "t" && segments[1]) {
      const slug = segments[1].toLowerCase();
      // The HUMAN name, same as every other surface (typeLabel Title-Cases a
      // labelless identifier) — never the raw snake_case `name`/slug, which
      // ui.ts says to never show and which this always-visible trail-bar
      // caption was the one daily string still leaking.
      const t = types.find((t) => t.name.toLowerCase() === slug);
      return t ? typeLabel(t) : typeName(slug);
    }
    if (segments.length === 0) return "Home";
    return null;
  }, [location.pathname, types]);
  // Favorites and recents are one per-account store (lib/favorites), read here
  // for the sidebar and handed to ⌘K as its two local sources.
  const { favorites, recents } = useChrome(user.id);

  useEffect(() => {
    localStorage.setItem("brain-sidebar", collapsed ? "collapsed" : "open");
  }, [collapsed]);

  useEffect(() => {
    api
      .types()
      .then((ts) => {
        registerTypeIcons(ts);
        setTypes(ts);
      })
      .catch(console.error);
  }, []);

  // One window listener owns both global shortcuts, so ⌘K and ⌘N can never
  // fight over the same keystroke. ⌘N additionally yields to whatever has
  // focus when that thing is a text surface (input, textarea, block editor)
  // and stays shut while the search palette is up.
  //
  // Chrome added later (breadcrumbs, the star, favorites/recents) deliberately
  // registers NO key handler of its own: a second window listener is how two
  // shortcuts start swallowing each other's events. Anything global goes here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (key === "n" && canWrite) {
        if (paletteOpen || createOpen || isTypingTarget(e.target)) return;
        e.preventDefault();
        setCreateOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canWrite, paletteOpen, createOpen]);

  // Navigating IS the drawer's dismiss — every link inside it changes the
  // route, so no link needs an onClick of its own to close the thing.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);

  // A rotation into desktop width drops the drawer rather than leaving an
  // orphaned overlay floating over a sidebar that is now permanently visible.
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  // While the drawer is up it owns the keyboard: Escape closes it (and hands
  // focus back to the button that opened it) and Tab cycles inside it. Capture
  // phase, so a page-level Escape handler underneath never eats the key first.
  useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const panel = drawerRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDrawerOpen(false);
        menuRef.current?.focus();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = focusableWithin(panel);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const outside = !panel.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isMobile, drawerOpen]);

  // Opening moves focus into the drawer and freezes the page behind it, so a
  // scroll gesture on the backdrop cannot drag the content underneath.
  useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    focusableWithin(drawerRef.current)[0]?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isMobile, drawerOpen]);

  // Edge-swipe right opens; swipe left anywhere closes. A gesture that is more
  // vertical than horizontal is a scroll and is abandoned immediately —
  // stealing those is how a drawer starts fighting the page.
  useEffect(() => {
    if (!isMobile) return;
    let startX = 0;
    let startY = 0;
    let intent: "open" | "close" | null = null;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      intent = drawerOpen ? "close" : t.clientX <= EDGE_ZONE_PX ? "open" : null;
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!intent || !t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dy) > Math.abs(dx)) {
        intent = null;
        return;
      }
      if (intent === "open" && dx > SWIPE_MIN_PX) {
        setDrawerOpen(true);
        intent = null;
      } else if (intent === "close" && dx < -SWIPE_MIN_PX) {
        setDrawerOpen(false);
        intent = null;
      }
    };
    const onEnd = () => {
      intent = null;
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [isMobile, drawerOpen]);

  // Touch rows are taller and set in a size a thumb can aim at; the desktop row
  // keeps the 13.5px density the sidebar was drawn for.
  const navItem = `flex items-center gap-2.5 rounded-none transition-colors ${
    isMobile
      ? "min-h-11 px-3 py-2.5 text-[15px]"
      : `py-1.5 text-[13.5px] ${railed ? "justify-center px-0" : "px-2.5"}`
  }`;
  const navIdle = "text-mut hover:bg-hover hover:text-ink";
  const navActive = "bg-hover-strong text-ink";

  // ⌘K's local sources: the two lists the member built by starring and by
  // walking around. Favorites win a duplicate — the same object starred and
  // recently visited is one row, not two.
  const paletteFavorites: PaletteEntry[] = useMemo(
    () => favorites.map(toPaletteEntry),
    [favorites],
  );
  const paletteRecents: PaletteEntry[] = useMemo(() => {
    const taken = new Set(favorites.map((f) => `${f.kind}:${f.key}`));
    return recents.filter((r) => !taken.has(`${r.kind}:${r.key}`)).map(toPaletteEntry);
  }, [favorites, recents]);

  return (
    <div className="flex h-full bg-ground">
      {/* First focusable thing on every page: a keyboard user should not have
          to tab through 20-40 sidebar stops to reach the content. Off-screen
          until focused, then it parks at the top-left and jumps to <main>. */}
      <a
        href="#main-content"
        className="sr-only z-[60] rounded-none bg-ground px-3 py-2 text-[13px] font-medium text-ink underline focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:outline-2 focus:outline-[var(--ink-strong)]"
      >
        Skip to content
      </a>
      {isMobile && drawerOpen && (
        // Dismiss-by-tapping-outside. Deliberately hidden from assistive tech
        // and from the tab order: it is a redundant fourth way out (Escape,
        // the close button and the swipe are the other three), and a second
        // control announcing "close navigation" is noise in the trap.
        <div
          aria-hidden
          onClick={() => setDrawerOpen(false)}
          className="drawer-backdrop fixed inset-0 z-40 bg-black/50"
        />
      )}
      <aside
        id="app-sidebar"
        ref={drawerRef}
        role={isMobile ? "dialog" : undefined}
        aria-modal={isMobile ? true : undefined}
        aria-label={isMobile ? "Navigation" : undefined}
        data-open={isMobile ? (drawerOpen ? "true" : "false") : undefined}
        // A closed drawer is off-screen but still in the tree (that is what
        // lets it slide rather than appear). `inert` is what keeps its links
        // out of the tab order and out of the accessibility tree — a
        // transform alone hides it from eyes only.
        inert={isMobile ? !drawerOpen : undefined}
        className={
          isMobile
            ? // `bg-panel` is translucent in the dark skin — fine for the desktop
              // rail (content sits beside it), but as a full-height OVERLAY the
              // page underneath ghosts through and collides with the menu labels.
              // `bg-panel2` is opaque in both skins, so the drawer reads as a
              // solid surface, not text-on-text.
              "mobile-drawer touch-chrome safe-top safe-bottom fixed inset-y-0 left-0 z-50 flex w-[min(86vw,300px)] flex-col overflow-y-auto overscroll-contain border-r border-line-soft bg-panel2"
            : `relative flex shrink-0 flex-col border-r border-line-soft bg-panel transition-[width] duration-200 ${
                railed ? "w-[54px]" : "w-[248px]"
              }`
        }
      >
        {!mono && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-40"
            style={{
              background:
                "radial-gradient(80% 90% at 30% 0%, rgba(74,108,245,.14), transparent 70%)",
            }}
          />
        )}

        <div
          className={`relative flex items-center gap-2 pt-4 pb-3 ${railed ? "justify-center px-0" : "px-4"}`}
        >
          {!railed && (
            <div className="min-w-0 flex-1">
              <div className="truncate font-pixel text-[13px] tracking-tight">{brandName}</div>
              <div className="truncate font-mono text-[11px] text-dim">
                {user.appVersion ?? "dev"}
              </div>
            </div>
          )}
          {isMobile ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setDrawerOpen(false);
                menuRef.current?.focus();
              }}
              aria-label="Close navigation"
              className="touch-target shrink-0 text-dim"
            >
              <X aria-hidden />
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setCollapsed((v) => !v)}
                    aria-label={railed ? "Open sidebar" : "Collapse sidebar"}
                    className="shrink-0 text-dim hover:text-ink"
                  />
                }
              >
                {railed ? <PanelLeft aria-hidden /> : <PanelLeftClose aria-hidden />}
              </TooltipTrigger>
              <TooltipContent>{railed ? "Open sidebar" : "Collapse sidebar"}</TooltipContent>
            </Tooltip>
          )}
        </div>

        {canWrite && (
          <Button
            onClick={() => setCreateOpen(true)}
            className={`mx-3 mb-2 text-[13px] ${railed ? "justify-center px-0" : "justify-start"} ${
              isMobile ? "touch-target" : ""
            }`}
            aria-label="New object"
          >
            <Plus aria-hidden />
            {!railed && <span className="flex-1 text-left">New</span>}
            {!railed && !isMobile && (
              <kbd className="rounded border border-current/20 px-1 py-px font-mono text-[10px] opacity-70">
                ⌘N
              </kbd>
            )}
          </Button>
        )}

        <Button
          variant="outline"
          onClick={() => navigate("/search")}
          className={`mx-3 mb-3 text-[13px] font-normal text-dim ${
            railed ? "justify-center px-0" : "justify-start"
          } ${isMobile ? "touch-target" : ""}`}
          aria-label="Search"
        >
          <Search aria-hidden />
          {!railed && <span className="flex-1 text-left">Search…</span>}
          {!railed && !isMobile && (
            <kbd className="rounded border border-line-soft bg-hover px-1 py-px font-mono text-[10px]">
              ⌘K
            </kbd>
          )}
        </Button>

        <nav className="relative flex flex-col gap-0.5 px-3">
          {/* When railed the visible label is dropped, so the icon-only link
              carries its name in `title` (accessible name + hover tooltip),
              exactly as the Favorites/Recents rows do below. */}
          <NavLink
            to="/"
            end
            title={railed ? "Home" : undefined}
            className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
          >
            <Home size={14} aria-hidden /> {!railed && "Home"}
          </NavLink>
          <NavLink
            to="/graph"
            title={railed ? "Graph" : undefined}
            className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
          >
            <Waypoints size={14} aria-hidden /> {!railed && "Graph"}
          </NavLink>
          <NavLink
            to="/timeline"
            title={railed ? "Timeline" : undefined}
            className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
          >
            <Clock size={14} aria-hidden /> {!railed && "Timeline"}
          </NavLink>
          <NavLink
            to="/files"
            title={railed ? "Files" : undefined}
            className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
          >
            <FolderOpen size={14} aria-hidden /> {!railed && "Files"}
          </NavLink>
          <NavLink
            to="/private"
            title={railed ? "Private" : undefined}
            className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
          >
            <Lock size={14} aria-hidden /> {!railed && "Private"}
          </NavLink>
          <NavLink
            to="/members"
            title={railed ? "Members" : undefined}
            className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
          >
            <Users size={14} aria-hidden /> {!railed && "Members"}
          </NavLink>
          <NavLink
            to="/connectors"
            title={railed ? "Connectors" : undefined}
            className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
          >
            <Cable size={14} aria-hidden /> {!railed && "Connectors"}
          </NavLink>
          {user.role === "owner" && (
            <NavLink
              to="/access"
              title={railed ? "Access" : undefined}
              className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
            >
              <Tags size={14} aria-hidden /> {!railed && "Access"}
            </NavLink>
          )}
          {user.role === "owner" && (
            <NavLink
              to="/branding"
              title={railed ? "Branding" : undefined}
              className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
            >
              <Palette size={14} aria-hidden /> {!railed && "Branding"}
            </NavLink>
          )}
        </nav>

        {/* ponytail: no Favorites shelf either — the rail is nav + Databases,
            and the databases are what it is for. Starring still works from the
            breadcrumb header and still ranks ⌘K; `ChromeSection` went with the
            shelf, since Favorites was its last caller. */}

        <PinnedViews
          accountId={user.id}
          collapsed={railed}
          itemClassName={navItem}
          idleClassName={navIdle}
          activeClassName={navActive}
        />

        {!railed && (
          <div className="mt-5 mb-1.5 px-5 text-[10.5px] font-semibold tracking-[.08em] text-dim uppercase">
            Databases
          </div>
        )}
        {railed && <div className="mt-5 mb-1.5 border-t border-line-soft" />}
        <nav
          className={`flex flex-col gap-0.5 px-3 pb-3 ${
            // The drawer is one scroller; the desktop column gives its spare
            // height to this list and scrolls it alone.
            isMobile ? "" : "min-h-0 flex-1 overflow-y-auto"
          }`}
        >
          {types
            .filter((t) => !hideDeprecated || !t.deprecated)
            .map((t) => (
              <NavLink
                key={t.name}
                to={`/t/${t.name}`}
                title={railed ? typeLabel(t) : undefined}
                className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
              >
                {/* Railed ⇒ the glyph is the only content, so give it a name. */}
                <TypeIcon
                  icon={t.icon}
                  type={t.name}
                  {...(railed ? { label: typeLabel(t) } : {})}
                />
                {!railed && (
                  <span
                    className={`flex-1 truncate ${t.deprecated ? "line-through opacity-60" : ""}`}
                  >
                    {typeLabel(t)}
                  </span>
                )}
                {!railed && <span className="font-mono text-[11px] text-dim">{t.count}</span>}
              </NavLink>
            ))}
          <NavLink
            to="/notes"
            title={railed ? "Notes" : undefined}
            className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
          >
            <FileText size={14} aria-hidden />
            {!railed && <span className="flex-1 truncate">Notes</span>}
          </NavLink>
          <NavLink
            to="/trash"
            title={railed ? "Trash" : undefined}
            className={({ isActive }) => `${navItem} ${isActive ? navActive : navIdle}`}
          >
            <Trash2 size={14} aria-hidden />
            {!railed && <span className="flex-1 truncate">Trash</span>}
          </NavLink>
        </nav>

        {/* ponytail: no Recents rail — Home's "Jump back in" is the recents
            surface; in the sidebar it stole the Databases list's height.
            `recents` still feeds ⌘K. */}

        <div className={`border-t border-line-soft py-3 ${railed ? "px-0" : "px-4"}`}>
          <div className={`flex items-center gap-2.5 ${railed ? "justify-center" : ""}`}>
            <div
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-[650]"
              // Theme-derived, not hardcoded: --btn-from/--btn-to are the aurora
              // purple→blue in the dark skin and near-black in the paper skin, so
              // the avatar stays in register with primary buttons in BOTH skins
              // instead of being the one saturated element on a muted page.
              style={{
                background: "linear-gradient(135deg,var(--btn-from),var(--btn-to))",
                color: "var(--btn-fg)",
              }}
            >
              {user.name.slice(0, 1).toUpperCase()}
            </div>
            {!railed && (
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{user.name}</div>
                <div className="text-[11px] text-dim">{user.role}</div>
              </div>
            )}
            {!railed && (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={toggleDeprecated}
                        aria-label={
                          hideDeprecated ? "Show deprecated types" : "Hide deprecated types"
                        }
                        className={`${hideDeprecated ? "text-dim hover:text-ink" : "text-ink"} ${
                          isMobile ? "touch-target" : ""
                        }`}
                      />
                    }
                  >
                    {hideDeprecated ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  </TooltipTrigger>
                  <TooltipContent>
                    {hideDeprecated ? "Show deprecated types" : "Hide deprecated types"}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          api.logout().finally(onSignOut);
                        }}
                        aria-label="Sign out"
                        className={`text-dim hover:text-ink ${isMobile ? "touch-target" : ""}`}
                      />
                    }
                  >
                    <LogOut aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent>Sign out</TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {/* `contents` on desktop: the wrapper exists only so a phone can put a
            hamburger beside the trail, and vanishes from the box tree on every
            other screen rather than adding a layout row nobody asked for. */}
        <div
          className={
            isMobile
              ? "safe-top flex shrink-0 items-center border-b border-line-soft bg-ground/85 pr-2 backdrop-blur-lg"
              : "contents"
          }
        >
          {isMobile && (
            <Button
              ref={menuRef}
              variant="ghost"
              size="icon"
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              aria-controls="app-sidebar"
              onClick={() => setDrawerOpen(true)}
              className="touch-target shrink-0 text-mut"
            >
              <Menu aria-hidden />
            </Button>
          )}
          {/* "3 people viewing Deals". The rail draws exactly what the relay
              sent THIS viewer and derives nothing of its own; an empty roster
              renders nothing at all, so a screen with nobody on it looks the
              way it always did. It rides in the trail bar's own `end` slot so
              it aligns to the RIGHT edge of that single row on every screen —
              on desktop the wrapper here collapses to `contents`, so a rail
              placed as a sibling would orphan onto a second full-width strip
              below the bar instead of tucking into it. The summary is dropped
              on mobile (it would overflow, and "1 person viewing Home" is just
              you). */}
          <Breadcrumbs
            accountId={user.id}
            pathname={location.pathname}
            search={location.search}
            peek={peek.stack}
            types={types}
            className={isMobile ? "min-w-0 flex-1 border-b-0! bg-transparent! px-1!" : ""}
            end={
              <RoutePresenceRail
                routeKey={routeKeyForPath(location.pathname)}
                label={presenceLabel}
                selfActorId={user.id}
                max={isMobile ? 2 : 4}
                showSummary={!isMobile}
              />
            }
          />
        </div>
        <div
          id="main-content"
          tabIndex={-1}
          className={`min-h-0 flex-1 overflow-y-auto outline-none ${isMobile ? "pad-bottom-bar" : ""}`}
        >
          <div key={location.pathname} className="page-in h-full">
            {/* The backstop for everything the per-widget boundaries do not
                wrap: a view that throws mid-render costs you THAT view, with
                the shell, the nav and every other route still standing. The
                key on the wrapper above is the reset — a new route mounts a
                new boundary, so one bad screen never latches the next one. */}
            <Boundary label={`route ${location.pathname}`} fallback={<ViewCrashed />}>
              <Outlet />
            </Boundary>
          </div>
        </div>
      </main>

      {/* The bottom bar carries only what a thumb reaches for constantly.
          Everything else stays one hamburger away in the drawer — a tab bar
          that tries to hold the whole sidebar holds nothing well. */}
      {isMobile && (
        <nav
          aria-label="Primary"
          // `--panel` is translucent in the dark skin, so scrolled content
          // (a code block, a stray row) ghosts up THROUGH the bar and it reads
          // as a rendering bug. `bg-ground` is opaque in both skins, so content
          // terminates cleanly behind it; the blur is a frosted nicety where
          // supported and a no-op (still opaque) where it isn't.
          className="touch-chrome safe-bottom fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-line-soft bg-ground backdrop-blur-lg"
        >
          <BottomLink to="/" end icon={Home} label="Home" />
          <BottomLink to="/search" icon={Search} label="Search" />
          <BottomLink to="/graph" icon={Waypoints} label="Graph" />
          {canWrite && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex min-h-11 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-[10.5px] text-mut transition-colors active:bg-hover"
            >
              <Plus size={20} aria-hidden />
              New
            </button>
          )}
        </nav>
      )}

      {paletteOpen && (
        <CommandK
          favorites={paletteFavorites}
          recents={paletteRecents}
          onClose={() => setPaletteOpen(false)}
          onPick={(id) => {
            setPaletteOpen(false);
            navigate(`/o/${id}`);
          }}
          onGo={(path) => {
            setPaletteOpen(false);
            navigate(path);
          }}
          onSeeAll={(q) => {
            setPaletteOpen(false);
            navigate(`/search?q=${encodeURIComponent(q)}`);
          }}
        />
      )}

      {createOpen && canWrite && (
        <QuickCreate
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            // Land in the editor — quick-create's whole point is that the
            // next keystroke goes into the new object.
            navigate(`/o/${id}`);
          }}
        />
      )}
    </div>
  );
}

/** Tabbable elements inside a container, in document order — the focus trap's
 *  whole world. Anything explicitly removed from the tab order (`tabindex=-1`,
 *  `disabled`, `inert` subtree) is not a stop. */
function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const nodes = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(nodes).filter((el) => !el.hasAttribute("inert") && el.tabIndex !== -1);
}

/** One destination in the phone's bottom bar: a 44px-tall column of icon over
 *  label, sharing the row's width equally with its siblings. */
function BottomLink({
  to,
  end = false,
  icon: Icon,
  label,
}: {
  to: string;
  /** Match this path exactly — Home would otherwise light up everywhere. */
  end?: boolean;
  icon: typeof Home;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex min-h-11 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-[10.5px] transition-colors ${
          isActive ? "text-ink" : "text-mut"
        }`
      }
    >
      <Icon size={20} aria-hidden />
      {label}
    </NavLink>
  );
}

/** What the route boundary shows when a view throws. It says what is true —
 *  this screen stopped, the app did not — and offers the only recovery a client
 *  crash has. Deliberately unstyled beyond the shared Empty card: it should
 *  read as an app that noticed, not as a crash report. */
function ViewCrashed() {
  return (
    <div className="px-8 py-10">
      <Empty
        hint="Nothing was lost — the rest of the app still works."
        action={
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      >
        This screen hit a problem and stopped drawing.
      </Empty>
    </div>
  );
}

/** A favorite/recent as a palette row. Both lists share one shape, so ⌘K needs
 *  no knowledge of which list a row came from beyond its group heading. */
function toPaletteEntry(entry: Favorite | Recent): PaletteEntry {
  return {
    id: `${entry.kind}:${entry.key}`,
    path: chromeHref(entry),
    label: entry.label,
    type: entry.type,
    kind: entry.kind,
  };
}
