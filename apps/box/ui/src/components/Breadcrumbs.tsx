/**
 * The header trail: **type → object → peek → peek**, every segment navigable,
 * with the star for whatever the trail currently points at.
 *
 * Three rules shape this file:
 *
 *  1. **The URL is the trail.** The route gives the first segments and the
 *     `?peek=` stack gives the rest, so a pasted link reproduces the same header
 *     — and a peek segment's link is the same route with the stack TRUNCATED to
 *     that depth, which is exactly what closing peeks above it does.
 *  2. **Titles are fetched once, per account.** The object page and the peek
 *     panel both already read the object; this file keeps a small id → {title,
 *     type} cache so the header does not re-read on every navigation, and it
 *     DROPS that cache the moment the account changes — a cached title is brain
 *     content, and content does not outlive the member who could see it.
 *  3. **A read we are not allowed to make is not an error.** An id in the URL
 *     that does not exist, or that this member may not see, renders as a plain
 *     "untitled" crumb. RLS is the boundary; the header is chrome, and chrome
 *     never claims to know what the box refused to tell it.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight, Star } from "lucide-react";

import { api, type TypeSummary } from "../lib/api";
import { typeLabel, typeName } from "../lib/ui";
import { withPeekStack } from "../lib/peek";
import { recordRecent, toggleFavorite, useIsFavorite, type FavoriteKind } from "../lib/favorites";
import { TypeIcon } from "./bits";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/* ------------------------------------------------------------- pure parts */

export interface ObjectMeta {
  title: string | null;
  type: string | null;
}

interface Crumb {
  /** stable react key */
  id: string;
  label: string;
  /** where clicking goes; null means "you are here" */
  to: string | null;
  /** the type whose icon this crumb wears, when it has one */
  type?: string | null;
}

/** The one thing the star can act on for the current route, or null when the
 *  route is not a starrable place (search, settings, the home page). */
interface FavoriteTarget {
  kind: FavoriteKind;
  key: string;
  label: string;
  type: string | null;
}

/** Named pages, in the sidebar's own words. Anything not listed gets no crumb
 *  beyond Home rather than a guessed one. */
const PAGES: Record<string, string> = {
  "/search": "Search",
  "/timeline": "Timeline",
  "/graph": "Graph",
  "/files": "Files",
  "/private": "Private",
  "/members": "Members",
  "/access": "Access",
  "/connectors": "Connectors",
  "/branding": "Branding",
  "/notes": "Notes",
  "/trash": "Trash",
};

function objectIdOf(pathname: string): string | null {
  const m = /^\/o\/([^/]+)\/?$/.exec(pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function typeOf(pathname: string): string | null {
  const m = /^\/t\/([^/]+)\/?$/.exec(pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

interface CrumbInput {
  pathname: string;
  /** the current search string, so peek crumbs keep every other param */
  search: string;
  /** bottom → top */
  peek: readonly string[];
  /** what we know about an object id, or null while it is still loading */
  meta: (id: string) => ObjectMeta | null;
  /** display name for a type name */
  label: (type: string) => string;
}

/**
 * The trail for a route + peek stack. Pure: the component only renders it.
 *
 * The LAST crumb is where you are (`to === null`); every earlier one is a link.
 * An untyped object hangs off Notes, matching the peek panel's own header.
 */
export function buildCrumbs({ pathname, search, peek, meta, label }: CrumbInput): Crumb[] {
  const crumbs: Crumb[] = [{ id: "home", label: "Home", to: "/" }];

  const type = typeOf(pathname);
  const objectId = objectIdOf(pathname);

  if (type) {
    crumbs.push({
      id: `t:${type}`,
      label: label(type),
      to: `/t/${encodeURIComponent(type)}`,
      type,
    });
  } else if (objectId) {
    const m = meta(objectId);
    if (m?.type) {
      crumbs.push({
        id: `t:${m.type}`,
        label: label(m.type),
        to: `/t/${encodeURIComponent(m.type)}`,
        type: m.type,
      });
    } else if (m) {
      crumbs.push({ id: "notes", label: "Notes", to: "/notes" });
    }
    crumbs.push({
      id: `o:${objectId}`,
      label: m ? m.title?.trim() || "untitled" : "…",
      to: `/o/${encodeURIComponent(objectId)}`,
      type: m?.type ?? null,
    });
  } else {
    const page = PAGES[pathname];
    if (page) crumbs.push({ id: `p:${pathname}`, label: page, to: pathname });
  }

  // Peek depth: each open peek is one more crumb, and clicking one truncates
  // the stack to that depth (the peeks above it close, which is what the trail
  // is showing you).
  const params = new URLSearchParams(search);
  peek.forEach((id, i) => {
    const m = meta(id);
    const stack = peek.slice(0, i + 1);
    const q = withPeekStack(params, stack).toString();
    crumbs.push({
      id: `peek:${id}`,
      label: m ? m.title?.trim() || "untitled" : "…",
      to: `${pathname}${q ? `?${q}` : ""}`,
      type: m?.type ?? null,
    });
  });

  // Wherever you actually are is text, not a link to itself.
  const last = crumbs[crumbs.length - 1];
  if (last) last.to = null;
  return crumbs;
}

/** What the star acts on: the peeked object if one is open, else the route's
 *  own object or type. Search/settings pages have nothing to star. */
export function favoriteTargetFor({
  pathname,
  peek,
  meta,
  label,
}: Omit<CrumbInput, "search">): FavoriteTarget | null {
  const top = peek.length > 0 ? peek[peek.length - 1] : null;
  const objectId = top ?? objectIdOf(pathname);
  if (objectId) {
    const m = meta(objectId);
    if (!m) return null; // nothing known yet — starring a "…" would store "…"
    return {
      kind: "object",
      key: objectId,
      label: m.title?.trim() || "untitled",
      type: m.type,
    };
  }
  const type = typeOf(pathname);
  if (type) return { kind: "type", key: type, label: label(type), type };
  return null;
}

/* ----------------------------------------------------------- title cache */

let cacheAccount = "";
const metaCache = new Map<string, ObjectMeta>();
const inFlight = new Map<string, Promise<void>>();
const metaListeners = new Set<() => void>();

function metaEmit(): void {
  for (const l of metaListeners) l();
}

/** Titles are content: another member must never inherit this cache. */
export function resetObjectMetaCache(accountId = ""): void {
  cacheAccount = accountId;
  metaCache.clear();
  inFlight.clear();
  metaEmit();
}

function fetchMeta(id: string): void {
  if (metaCache.has(id) || inFlight.has(id)) return;
  const p = api
    .object(id)
    .then((o) => {
      metaCache.set(id, { title: o.title, type: o.type });
    })
    .catch(() => {
      // Gone, or not ours to see. Remember that so the header does not retry on
      // every render — the crumb simply reads "untitled".
      metaCache.set(id, { title: null, type: null });
    })
    .finally(() => {
      inFlight.delete(id);
      metaEmit();
    });
  inFlight.set(id, p);
}

/** Resolve every id the header needs, and re-render when they land. */
function useObjectMeta(
  accountId: string,
  ids: readonly string[],
): (id: string) => ObjectMeta | null {
  const [, bump] = useState(0);

  useEffect(() => {
    const l = () => bump((n) => n + 1);
    metaListeners.add(l);
    return () => {
      metaListeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (cacheAccount !== accountId) resetObjectMetaCache(accountId);
    for (const id of ids) fetchMeta(id);
  }, [accountId, ids]);

  return (id: string) => metaCache.get(id) ?? null;
}

/* ------------------------------------------------------------- component */

interface BreadcrumbsProps {
  /** whose favorites the star writes to */
  accountId: string;
  pathname: string;
  search: string;
  /** the peek stack, bottom → top */
  peek: readonly string[];
  /** the live type catalog, for real labels and icons */
  types?: readonly TypeSummary[];
  className?: string;
  /**
   * Chrome pinned to the RIGHT end of the trail bar (e.g. the presence rail).
   * It rides INSIDE this bar's single flex row so it aligns to the right edge —
   * the trail's `nav` is `flex-1`, so anything here is pushed flush right rather
   * than orphaned onto a second full-width strip below the bar.
   */
  end?: ReactNode;
}

export function Breadcrumbs({
  accountId,
  pathname,
  search,
  peek,
  types = [],
  className = "",
  end,
}: BreadcrumbsProps) {
  const ids = useMemo(() => {
    const out = [...peek];
    const own = objectIdOf(pathname);
    if (own && !out.includes(own)) out.push(own);
    return out;
  }, [pathname, peek]);

  const meta = useObjectMeta(accountId, ids);

  const label = useMemo(() => {
    const byName = new Map(types.map((t) => [t.name, t]));
    return (name: string) => {
      const t = byName.get(name);
      return t ? typeLabel(t) : typeName(name);
    };
  }, [types]);

  const crumbs = buildCrumbs({ pathname, search, peek, meta, label });
  const target = favoriteTargetFor({ pathname, peek, meta, label });
  const starred = useIsFavorite(accountId, target?.kind ?? "object", target?.key ?? null);

  // Visiting IS the recents list. Recording here (rather than in each view)
  // keeps one definition of "where I have been", and the guard inside
  // recordRecent means a label we do not have yet is never written.
  useEffect(() => {
    if (!target) return;
    recordRecent(accountId, {
      kind: target.kind,
      key: target.key,
      label: target.label,
      type: target.type,
    });
  }, [accountId, target?.kind, target?.key, target?.label, target?.type]);

  return (
    <div
      className={`flex h-10 shrink-0 items-center gap-1 border-b border-line-soft bg-panel/60 px-4 ${className}`}
    >
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-[12.5px]">
        {crumbs.map((c, i) => (
          <span key={c.id} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight size={12} aria-hidden className="shrink-0 text-dim" />}
            {c.type ? <TypeIcon type={c.type} size={13} /> : null}
            {c.to === null ? (
              <span aria-current="page" className="max-w-[28ch] truncate text-ink">
                {c.label}
              </span>
            ) : (
              <Link to={c.to} className="max-w-[22ch] truncate text-mut hover:text-ink">
                {c.label}
              </Link>
            )}
          </span>
        ))}
      </nav>

      {target && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={starred}
                aria-label={starred ? `Unfavorite ${target.label}` : `Favorite ${target.label}`}
                onClick={() => toggleFavorite(accountId, target)}
                // touch-target: this ~28px icon button mounts into the mobile
                // top bar, which is not `.touch-chrome`, so it would otherwise
                // fall below the 44px coarse-pointer floor every other chrome
                // control upholds — favoriting from a phone would be a mis-tap.
                className={`touch-target ${starred ? "text-ink" : "text-dim hover:text-ink"}`}
              />
            }
          >
            <Star aria-hidden className={starred ? "fill-current" : undefined} />
          </TooltipTrigger>
          <TooltipContent>{starred ? "Remove from favorites" : "Add to favorites"}</TooltipContent>
        </Tooltip>
      )}

      {end != null && <div className="flex min-w-0 shrink items-center pl-2">{end}</div>}
    </div>
  );
}
