import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Columns2, Pencil, Rows3 } from "lucide-react";

import { CellValue, rowVersion, type LayoutProps } from "../../views/TypeView";
import type { ListItem, PropDef } from "../../lib/api";
import type { ViewConfig } from "../../lib/viewConfig";
import { fmtRelative, plainSnippet, typeHue } from "../../lib/ui";
import { useIsMobile } from "../../lib/mobile";
import { useTheme } from "../../lib/theme";
import { CreateHint, Empty, PrivateBadge, TypeIcon } from "../bits";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Gallery — the same database as a wall of cards.
 *
 * It implements the shell's `LayoutProps` and nothing else: no fetching, no
 * query building, no paging. `rows` is the truth (TypeView rule 2), so this
 * file keeps NO copy of a row — the one piece of local state is the title
 * DRAFT while a member is typing it, and that is discarded the moment the
 * write settles and the shell hands the row back.
 *
 * The card is deliberately **edit-light**. A gallery is for scanning, so the
 * only thing editable in place is the title (the one field every object has,
 * and the one most often wrong); every other field is read-only here and a
 * click opens the object where the full editor lives. That keeps this layout
 * from growing a second, half-working editor.
 *
 * Two smaller rules the pixels have to keep:
 *
 *  - **Columns come from the container, not the viewport.** `auto-fill` +
 *    `minmax` reflows against the grid's own width, so the gallery is correct
 *    inside a side-peek or a narrowed pane, which a `md:`/`lg:` breakpoint
 *    ladder is not.
 *  - **On a phone the member chooses one column or two.** `auto-fill` alone
 *    would pick one on a 390px screen and never offer the other, and both are
 *    legitimately wanted: one column to read the snippets, two to scan titles
 *    without scrolling for a minute. So the phone gets an explicit 1/2 toggle,
 *    remembered per member (a preference this local does not belong in the
 *    shared view config — it would follow the member to their desktop and
 *    pin the wall to two columns there).
 *  - **The lift is an affordance, not decoration.** Anyone who asked their OS
 *    for less motion gets the shadow change without the translate (the app's
 *    global reduced-motion floor already collapses the duration).
 */

/** Chips are a glance, not a record — three is what fits before a card stops
 *  being scannable. The rest of the object is one click away. */
const MAX_CHIPS = 3;
/** Snippet ceiling in characters. The card also line-clamps; this stops a
 *  50 KB body from riding into the DOM for a two-line preview. */
const SNIPPET_CHARS = 200;
const SKELETON_CARDS = 8;

/** Where the phone's 1-or-2-column choice is kept. Storage is optional
 *  everywhere in this app (Safari private mode, quota), so both sides of this
 *  are wrapped and a refusal simply means the default. */
const MOBILE_COLS_KEY = "brain.gallery.mobileCols";

function readMobileCols(): 1 | 2 {
  try {
    return localStorage.getItem(MOBILE_COLS_KEY) === "2" ? 2 : 1;
  } catch {
    return 1;
  }
}

function writeMobileCols(cols: 1 | 2): void {
  try {
    localStorage.setItem(MOBILE_COLS_KEY, String(cols));
  } catch {
    /* a browser that refuses storage still gets the toggle, just not the memory */
  }
}

/** Refs are links, not values — the table draws them nowhere either. */
const CHIPLESS_KINDS: readonly string[] = ["ref", "ref[]"];

/** Property names that read as "the body of this thing", best first. */
const BODY_NAMES: readonly string[] = [
  "body",
  "summary",
  "description",
  "overview",
  "notes",
  "note",
  "content",
];

export interface GalleryLayoutProps extends LayoutProps {
  /**
   * Presence avatars for ONE card, supplied by the host (the route-level
   * presence rail). It is a slot rather than a prop bag because who is here is
   * the rail's business, not the gallery's.
   *
   * Privacy: the host may only ever hand back peers for a row we were already
   * given — the rows are RLS-filtered per member, so a card cannot leak that a
   * private object exists. This layout never asks for presence by id on its
   * own, and renders nothing at all when the slot returns nothing.
   */
  presenceSlot?: (row: ListItem) => ReactNode;
  /** The shell is loading the first page: draw the skeleton wall. A refresh
   *  WITH rows on screen keeps the rows (and just marks the grid busy). */
  loading?: boolean;
  /** The type these rows belong to; defaults to the `/t/:type` route param. */
  type?: string;
  /** The type's emoji, when the host already has the catalog entry. */
  typeIcon?: string | null;
}

export function GalleryLayout({
  rows,
  propDefs,
  config,
  onPatch,
  onOpen,
  readOnly,
  presenceSlot,
  loading = false,
  type,
  typeIcon = null,
}: GalleryLayoutProps) {
  const params = useParams();
  const resolvedType = type ?? params["type"] ?? null;
  const candidates = chipCandidates(config, propDefs);
  const isMobile = useIsMobile();
  const [mobileCols, setMobileCols] = useState<1 | 2>(() => readMobileCols());
  const pad = isMobile ? "px-4 py-4" : "px-8 py-5";

  if (loading && rows.length === 0) return <GallerySkeleton mobile={isMobile} />;

  if (rows.length === 0) {
    return (
      <div className={isMobile ? "p-4" : "p-8"}>
        <Empty
          {...(!readOnly && config.filters.length === 0
            ? { hint: <CreateHint what="a card" /> }
            : {})}
        >
          {config.filters.length > 0
            ? "No cards match these filters. Drop one to widen the view — the objects are still there."
            : "No cards here yet. Everything of this type shows up as the brain learns it."}
        </Empty>
      </div>
    );
  }

  return (
    <div className={pad}>
      {isMobile && (
        <div className="mb-3 flex items-center justify-end gap-1">
          {([1, 2] as const).map((n) => (
            <Button
              key={n}
              variant={mobileCols === n ? "secondary" : "ghost"}
              size="icon-sm"
              className="touch-target rounded-none text-dim"
              aria-pressed={mobileCols === n}
              aria-label={n === 1 ? "One column" : "Two columns"}
              onClick={() => {
                setMobileCols(n);
                writeMobileCols(n);
              }}
            >
              {n === 1 ? <Rows3 aria-hidden /> : <Columns2 aria-hidden />}
            </Button>
          ))}
        </div>
      )}
      <ul
        role="list"
        aria-busy={loading || undefined}
        data-cols={isMobile ? mobileCols : undefined}
        // auto-fill + minmax = container-driven columns: the grid reflows
        // against its own width, so this is right in a narrow pane too. On a
        // phone the count is the member's, not the container's — 232px would
        // silently force one column and the toggle would do nothing.
        className={`grid list-none gap-3 ${
          isMobile
            ? mobileCols === 2
              ? "grid-cols-2"
              : "grid-cols-1"
            : "grid-cols-[repeat(auto-fill,minmax(232px,1fr))]"
        }`}
      >
        {rows.map((row) => (
          <li key={row.id}>
            <GalleryCard
              row={row}
              propDefs={propDefs}
              candidates={candidates}
              type={resolvedType}
              typeIcon={typeIcon}
              onOpen={onOpen}
              onPatch={onPatch}
              readOnly={readOnly}
              presenceSlot={presenceSlot}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------------- card */

function GalleryCard({
  row,
  propDefs,
  candidates,
  type,
  typeIcon,
  onOpen,
  onPatch,
  readOnly,
  presenceSlot,
}: {
  row: ListItem;
  propDefs: PropDef[];
  candidates: PropDef[];
  type: string | null;
  typeIcon: string | null;
  onOpen: (id: string) => void;
  onPatch: LayoutProps["onPatch"];
  readOnly: boolean;
  presenceSlot?: ((row: ListItem) => ReactNode) | undefined;
}) {
  const { theme } = useTheme();
  const hue = typeHue(type, theme);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // A card can be unmounted by a live refresh while its patch is in flight;
  // settling state on a dead component is a React warning, not a save.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const chips = candidates.filter((p) => hasValue(row.props?.[p.name])).slice(0, MAX_CHIPS);
  const shown = new Set(chips.map((p) => p.name));
  const snippet = cardSnippet(row, propDefs, shown);
  const title = row.title ?? "untitled";
  const presence = presenceSlot?.(row) ?? null;

  const startEdit = () => {
    setDraft(row.title ?? "");
    setEditing(true);
  };

  const commit = async () => {
    if (saving) return;
    const next = draft.trim();
    const current = row.title ?? "";
    // An unchanged title is not a write: a no-op CAS still burns a version and
    // shows up in history as an edit nobody made.
    if (next === current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      // `onPatch` resolves after the shell folds the answer in and never
      // rejects; a refused or conflicted write shows in the notice strip and
      // the row comes back re-read, so we simply stop editing either way.
      await onPatch(row.id, rowVersion(row), { title: next === "" ? null : next });
    } finally {
      if (alive.current) {
        setSaving(false);
        setEditing(false);
      }
    }
  };

  return (
    <Card
      className={[
        "group/card relative h-full gap-0 rounded-none px-3.5 py-3",
        // Reads the shared motion clock (index.css) instead of inventing a
        // duration/lift, so the gallery moves like every other card surface —
        // and reduced motion is inherited, because `--lift-card` collapses to
        // 0px and `--dur-fast` to 1ms there (no bespoke motion-reduce override).
        "transition-[box-shadow,transform] duration-[var(--dur-fast)] ease-out",
        "hover:translate-y-[var(--lift-card)] hover:ring-foreground/25",
      ].join(" ")}
    >
      {/* The cover — what makes a gallery a gallery and not a roomier table.
          With no image field yet, the object's TYPE is the visual: a tinted band
          in the type's hue carrying its glyph, so a wall of cards is scannable by
          colour and icon at a glance (browse the Agencies vs the Opportunities)
          before you read a single title. */}
      <div
        aria-hidden
        className="-mx-3.5 -mt-3 mb-3 flex h-14 items-center justify-center border-b border-line-soft"
        style={{ background: `color-mix(in srgb, ${hue} 12%, var(--panel))` }}
      >
        <TypeIcon icon={typeIcon} type={type} size={26} />
      </div>

      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <TypeIcon icon={typeIcon} type={type} size={13} />
        </span>

        {editing ? (
          <Input
            autoFocus
            value={draft}
            disabled={saving}
            aria-label="Title"
            className="h-7 min-w-0 flex-1 text-[13px]"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <Link
            to={`/o/${row.id}`}
            onClick={(e) => {
              // Plain click is an in-app open; modified clicks stay real-link
              // behaviour (new tab, copy address), exactly as the table does.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              onOpen(row.id);
            }}
            // Stretched hit area: the whole card opens the object, but the
            // thing that is focusable and named is still one link.
            className="min-w-0 flex-1 text-[13.5px] leading-snug font-[550] text-ink after:absolute after:inset-0 hover:underline hover:decoration-[var(--line)]"
          >
            <span className="line-clamp-2">{title}</span>
          </Link>
        )}

        <span className="relative z-10 flex shrink-0 items-center gap-1">
          <PrivateBadge visibility={row.visibility} />
          {!readOnly && !editing && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Rename ${title}`}
              title="Rename"
              // `touch-reveal` (index.css) forces it visible on a coarse
              // pointer: a control that only appears on hover does not exist
              // on a phone.
              className="touch-reveal touch-target text-dim opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100"
              onClick={startEdit}
            >
              <Pencil aria-hidden />
            </Button>
          )}
        </span>
      </div>

      {snippet && (
        <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-mut">{snippet}</p>
      )}

      {chips.length > 0 && (
        // Quiet label + value, no per-field box: the card border is the only
        // frame. Boxes-within-a-box read as clutter; a dim label over an ink
        // value scans the way the side-peek properties already do.
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px]">
          {chips.map((p) => (
            <span key={p.name} className="inline-flex items-baseline gap-1.5">
              <span className="text-dim">{humanProp(p.name)}</span>
              <span className="text-mut">
                <CellValue kind={p.kind} value={row.props?.[p.name]} />
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <span className="text-[11px] text-dim">{fmtRelative(row.updated_at)}</span>
        {presence && (
          <span className="relative z-10 ml-auto flex items-center gap-1" data-slot="presence">
            {presence}
          </span>
        )}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- skeletons */

/**
 * The loading wall. It is the SAME grid with the SAME card padding and the
 * same three stacked blocks, so the first paint of real rows moves nothing —
 * a skeleton that does not match its final layout is a jump cut.
 */
export function GallerySkeleton({
  count = SKELETON_CARDS,
  mobile = false,
}: { count?: number; mobile?: boolean } = {}) {
  return (
    <div className={mobile ? "px-4 py-4" : "px-8 py-5"} aria-busy="true" aria-label="Loading">
      <div
        className={`grid gap-3 ${
          mobile
            ? readMobileCols() === 2
              ? "grid-cols-2"
              : "grid-cols-1"
            : "grid-cols-[repeat(auto-fill,minmax(232px,1fr))]"
        }`}
      >
        {Array.from({ length: count }).map((_, i) => (
          <Card
            key={i}
            className="gap-0 rounded-none px-3.5 py-3"
            data-slot="gallery-skeleton-card"
          >
            <div className="flex items-start gap-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0" />
              <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${80 - ((i * 9) % 30)}%` }} />
            </div>
            <Skeleton className="mt-2.5 h-2.5" />
            <Skeleton className="mt-1.5 h-2.5 w-2/3" />
            <div className="mt-3 flex gap-1.5">
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-10" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- pieces */

function humanProp(name: string): string {
  return name.replace(/_/g, " ");
}

function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

/**
 * The chip pool, in the member's configured column order: what the view says
 * to show, resolved against the LIVE catalog (a saved config can name a
 * property that has since been dropped or deprecated). A card then keeps the
 * first `MAX_CHIPS` of these that it actually has a value for, so a sparse row
 * still shows three facts instead of three empty labels.
 */
export function chipCandidates(config: ViewConfig, propDefs: PropDef[]): PropDef[] {
  const byName = new Map(propDefs.map((p) => [p.name, p] as const));
  const usable = (p: PropDef | undefined): p is PropDef =>
    p !== undefined && !p.deprecated && !CHIPLESS_KINDS.includes(p.kind);
  const chosen = config.columns
    .filter((c) => c.visible)
    .map((c) => byName.get(c.key))
    .filter(usable);
  if (chosen.length > 0) return chosen;
  return propDefs.filter((p) => usable(p));
}

/**
 * The two lines of prose under the title.
 *
 * `api.list` returns the spine plus scalar props — not the body — so the
 * snippet is the object's most body-like TEXT property: a name that reads as a
 * body first, then simply the longest text it has. Anything already shown as a
 * chip is skipped so the card never says the same thing twice. Markdown is
 * flattened (a card is not a document) and the result is capped before it ever
 * reaches the DOM.
 */
export function cardSnippet(
  row: ListItem,
  propDefs: PropDef[],
  exclude: ReadonlySet<string>,
  max = SNIPPET_CHARS,
): string {
  const direct = (row as ListItem & { body?: unknown }).body;
  let raw = typeof direct === "string" ? direct : "";
  if (!raw) {
    let best: { rank: number; text: string } | null = null;
    for (const p of propDefs) {
      if (p.kind !== "text" || p.deprecated || exclude.has(p.name)) continue;
      const v = row.props?.[p.name];
      if (typeof v !== "string" || v.trim() === "") continue;
      const named = BODY_NAMES.indexOf(p.name);
      const rank = named === -1 ? BODY_NAMES.length : named;
      if (
        best === null ||
        rank < best.rank ||
        (rank === best.rank && v.length > best.text.length)
      ) {
        best = { rank, text: v };
      }
    }
    raw = best?.text ?? "";
  }
  return clamp(plainSnippet(raw), max);
}

/** Cut on a word boundary when there is one near the end; never mid-word. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
