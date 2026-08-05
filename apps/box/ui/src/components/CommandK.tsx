import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, type SearchHit } from "../lib/api";
import { Snippet, TypeDot } from "./bits";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** A local (non-search) palette row: a favorite or a recent, already resolved
 *  to the route it opens. The palette never reads storage itself — the shell
 *  owns those lists and hands them in. */
export interface PaletteEntry {
  /** stable identity, `<kind>:<key>` */
  id: string;
  path: string;
  label: string;
  type: string | null;
  kind: "object" | "type";
}

/** How many local rows a group may contribute once a query is being typed —
 *  the palette is a jump list there, not a second sidebar. */
const MAX_LOCAL_MATCHES = 4;

function matches(entries: readonly PaletteEntry[], q: string): PaletteEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((e) => e.label.toLowerCase().includes(needle)).slice(0, MAX_LOCAL_MATCHES);
}

/** ⌘K palette on shadcn Command (cmdk): debounced server-side search, so
 *  cmdk's own filtering is off — the box ranks, the palette renders. Two-pass
 *  like /search: instant lexical results paint first, then the deep hybrid
 *  pass (semantic + graph + rerank) upgrades the list in place.
 *
 *  Three sources, in trust order: the member's FAVORITES, their RECENTS, then
 *  the box's search. The first two are local and instant, so an empty palette
 *  is already useful — and the same query filters them without a round trip. */
export function CommandK({
  onClose,
  onPick,
  onSeeAll,
  onGo,
  favorites = [],
  recents = [],
}: {
  onClose: () => void;
  onPick: (id: string) => void;
  /** Hand the query off to the full search page — the palette is the
   *  abbreviated version of /search. */
  onSeeAll: (q: string) => void;
  /** Navigate to a local row's route (an object page, or a database). */
  onGo?: (path: string) => void;
  favorites?: readonly PaletteEntry[];
  recents?: readonly PaletteEntry[];
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  // Both passes failed for the current query (box 500ing / network down while
  // the SW serves the cached shell). Distinct from "no matches": a blank list
  // with no copy at all is indistinguishable from "still waiting".
  const [failed, setFailed] = useState(false);
  const [deepening, setDeepening] = useState(false);
  // Monotonic ticket: only the newest query may paint. deepDone guards the
  // lexical arm from overwriting a deep result that already landed (either arm
  // can win the race), mirroring SearchView.
  const ticket = useRef(0);
  const deepDone = useRef(false);

  useEffect(() => {
    const query = q.trim();
    ticket.current += 1;
    const mine = ticket.current;
    deepDone.current = false;
    if (!query) {
      setHits([]);
      setSearched(false);
      setFailed(false);
      setDeepening(false);
      return;
    }
    const t = setTimeout(() => {
      setDeepening(true);
      // Instant lexical pass — keeps the palette responsive.
      api
        .search(query, { limit: 8 })
        .then((r) => {
          if (ticket.current !== mine || deepDone.current) return;
          setHits(r);
          setSearched(true);
          setFailed(false);
        })
        .catch(() => {
          // A failed pass still "searched": leaving `searched` false rendered
          // NOTHING at all — no results, no empty state, no error — the moment
          // the spinner cleared. The copy below says search is unavailable
          // rather than the misleading "Nothing matches". The deep pass can
          // still succeed and overwrite this.
          if (ticket.current === mine && !deepDone.current) {
            setHits([]);
            setSearched(true);
            setFailed(true);
          }
        });
      // Deep pass — ranked by meaning + connections, same as /search.
      api
        .search(query, { limit: 8, deep: true })
        .then((r) => {
          if (ticket.current !== mine) return;
          deepDone.current = true;
          setHits(r);
          setSearched(true);
          setFailed(false);
          setDeepening(false);
        })
        .catch(() => {
          // Deep pass failing (embedder warming, box without pgvector…)
          // quietly leaves the lexical results standing.
          if (ticket.current === mine) setDeepening(false);
        });
    }, 160);
    return () => clearTimeout(t);
  }, [q]);

  const favMatches = useMemo(() => matches(favorites, q), [favorites, q]);
  const recentMatches = useMemo(() => matches(recents, q), [recents, q]);
  const localCount = favMatches.length + recentMatches.length;
  const go = (path: string) => {
    if (onGo) onGo(path);
  };

  return (
    <CommandDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Search the brain"
      description="Search every title and body you can see"
    >
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search the brain…" value={q} onValueChange={setQ} />
        {deepening && hits.length > 0 && (
          <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
            <span className="deep-pulse inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
            ranking by meaning…
          </div>
        )}
        <CommandList>
          {searched && !deepening && hits.length === 0 && localCount === 0 && (
            <CommandEmpty>
              {failed
                ? "Search is unavailable right now — check your connection and try again."
                : `Nothing matches “${q}”. Search covers titles and bodies.`}
            </CommandEmpty>
          )}
          <LocalGroup heading="Favorites" entries={favMatches} onGo={go} />
          <LocalGroup heading="Recent" entries={recentMatches} onGo={go} />
          <CommandGroup heading={localCount > 0 && hits.length > 0 ? "Search" : undefined}>
            {hits.map((h) => (
              <CommandItem key={h.id} value={h.id} onSelect={() => onPick(h.id)}>
                <TypeDot type={h.type} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">
                    {h.title ?? "untitled"}
                  </span>
                  {h.snippet && (
                    <span className="mt-0.5 line-clamp-1 block text-[12px] text-muted-foreground">
                      <Snippet text={h.snippet} />
                    </span>
                  )}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
          {q.trim() && (
            <CommandItem
              value="__see-all"
              onSelect={() => onSeeAll(q.trim())}
              className="text-[13px] text-muted-foreground"
            >
              <ArrowRight size={13} aria-hidden />
              See all results for “{q.trim()}”
            </CommandItem>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/** One local source, rendered as a cmdk group. Values are namespaced by the
 *  entry id so a favorite and a search hit for the same object cannot collide
 *  in cmdk's value registry. */
function LocalGroup({
  heading,
  entries,
  onGo,
}: {
  heading: string;
  entries: readonly PaletteEntry[];
  onGo: (path: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {entries.map((e) => (
        <CommandItem
          key={`${heading}:${e.id}`}
          value={`${heading}:${e.id}`}
          onSelect={() => onGo(e.path)}
        >
          <TypeDot type={e.type} />
          <span className="min-w-0 flex-1 truncate text-[13.5px]">{e.label}</span>
          {e.kind === "type" && <span className="text-[11px] text-muted-foreground">database</span>}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
