import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Link2, Search, Sparkles } from "lucide-react";
import { api, errorMessage, type SearchHit, type TypeSummary } from "../lib/api";
import { DEMO_SEARCH_SUGGESTIONS, isDemo } from "../demo";
import { Empty, LoadError, Snippet, TypePill } from "../components/bits";
import { useIsMobile } from "../lib/mobile";
import { fmtRelative } from "../lib/ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

/**
 * Full search page, two-stage: every keystroke runs the instant lexical pass;
 * when typing settles (or on Enter) the deep hybrid pass — semantic + graph +
 * rerank — replaces the list in place and per-hit provenance appears. The
 * palette (⌘K) is the abbreviated version of this page.
 */

const QUICK_DEBOUNCE_MS = 140;
const DEEP_SETTLE_MS = 450;
const LIMIT = 30;

type Stage = "idle" | "quick" | "deepening" | "deep";

export function SearchView() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // Search is one of the phone bottom bar's four persistent tabs, so it gets
  // the same px-8 → px-4 switch every branch-touched primary view carries
  // (Home documents it as the invariant); without it this tab spent 64px of a
  // 390px viewport on margins, visibly out of register with the other three.
  const isMobile = useIsMobile();
  const q = params.get("q") ?? "";
  const typeFilter = params.get("type") ?? "";
  const [input, setInput] = useState(q);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [types, setTypes] = useState<TypeSummary[]>([]);
  const [sel, setSel] = useState(-1);
  // The QUICK pass failing is a real error to surface (the deep pass failing is
  // silent — quick results stand). Cleared each keystroke; Retry bumps the tick.
  const [searchError, setSearchError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  // Monotonic ticket: only the newest pass (of either depth) may paint, and a
  // quick result must never overwrite a deep one for the same ticket.
  const ticket = useRef(0);
  const deepPainted = useRef(false);
  // Set once the deep pass has RESOLVED either way (success or failure). A
  // slow quick-pass response landing after a fast deep failure must not reset
  // the stage back to "deepening" — deepPainted alone (success-only) leaves
  // that gap and strands the pulse forever.
  const deepSettled = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    api.types().then(setTypes).catch(console.error);
  }, []);

  // Keep the URL the source of truth (shareable, back-buttonable) without
  // spamming history — every keystroke replaces the entry. Functional
  // setParams so a filter chip clicked inside the debounce window is read
  // fresh, never from this closure's snapshot.
  useEffect(() => {
    if (input === q) return;
    const t = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (input.trim()) next.set("q", input);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, QUICK_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input]);

  // External q changes (back button, palette handoff) update the box.
  useEffect(() => {
    setInput(q);
  }, [q]);

  useEffect(() => {
    const query = q.trim();
    ticket.current += 1;
    const mine = ticket.current;
    deepPainted.current = false;
    deepSettled.current = false;
    setSel(-1);
    setSearchError(null);
    if (!query) {
      setHits(null);
      setStage("idle");
      return;
    }
    const opts = { limit: LIMIT, ...(typeFilter ? { type: typeFilter } : {}) };
    api
      .search(query, opts)
      .then((r) => {
        // Once the deep pass has settled (either way), a late quick response
        // can never move the stage back to "deepening".
        if (ticket.current !== mine || deepSettled.current) return;
        setHits(r);
        setStage("deepening");
      })
      .catch((e: unknown) => {
        // The quick pass IS the page's primary content — a failure must surface,
        // not leave a silent empty page (the deep-pass catch below stays quiet).
        if (ticket.current !== mine) return;
        setSearchError(errorMessage(e));
        setStage("idle");
      });
    const deepTimer = setTimeout(() => {
      api
        .search(query, { ...opts, deep: true })
        .then((r) => {
          if (ticket.current !== mine) return;
          deepPainted.current = true;
          deepSettled.current = true;
          setHits(r);
          setStage("deep");
          // The deep pass reorders the list — a kept index would silently
          // point Enter at a different object.
          setSel(-1);
        })
        .catch(() => {
          // Deep pass failing (embedder still warming, box without pgvector…)
          // quietly leaves the quick results standing — never a broken page.
          // Mark it settled so a late quick response can't re-enter "deepening".
          if (ticket.current !== mine) return;
          deepSettled.current = true;
          setStage("quick");
        });
    }, DEEP_SETTLE_MS);
    return () => clearTimeout(deepTimer);
  }, [q, typeFilter, retryTick]);

  const open = (id: string) => navigate(`/o/${id}`);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!hits || hits.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(hits.length - 1, Math.max(0, sel + dir));
      setSel(next);
      listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && sel >= 0 && hits[sel]) {
      e.preventDefault();
      open(hits[sel].id);
    } else if (e.key === "Escape") {
      setSel(-1);
    }
  };

  const setFilter = (type: string | null) => {
    const next = new URLSearchParams(params);
    if (type) next.set("type", type);
    else next.delete("type");
    setParams(next, { replace: true });
  };

  // "+ connections" whenever graph provenance is visible on the page — a hit
  // a text arm also found keeps its via trail but is labeled by the text arm.
  const hasGraph = useMemo(
    () => (hits ?? []).some((h) => h.match === "graph" || h.via !== undefined),
    [hits],
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className={`border-b border-line-soft pb-5 ${isMobile ? "px-4 pt-4" : "px-8 pt-7"}`}>
        <div className="flex max-w-[720px] items-center gap-2.5">
          <Search size={17} className="shrink-0 text-dim" aria-hidden />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search everything the company knows…"
            className="h-11 border-0 !bg-transparent px-1 !text-[17px] shadow-none focus-visible:ring-0"
            autoFocus
            type="search"
            aria-label="Search"
          />
          <StageLine stage={stage} hasGraph={hasGraph} total={hits?.length ?? 0} />
        </div>

        {types.length > 0 && (
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            <FilterChip label="everything" active={!typeFilter} onClick={() => setFilter(null)} />
            {types.map((t) => (
              <FilterChip
                key={t.name}
                label={t.label ?? t.name}
                active={typeFilter === t.name}
                onClick={() => setFilter(typeFilter === t.name ? null : t.name)}
              />
            ))}
          </div>
        )}
      </header>

      <div className={`min-h-0 flex-1 py-4 ${isMobile ? "px-4" : "px-8"}`}>
        {searchError && !hits && (
          <LoadError message={searchError} onRetry={() => setRetryTick((n) => n + 1)} />
        )}
        {!q.trim() && (
          <Empty>
            Type to search — instant results as you type, then the deep pass ranks by meaning and
            connections.
            {isDemo() && (
              <span className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                <span className="text-[12px] text-dim">Try:</span>
                {DEMO_SEARCH_SUGGESTIONS.map((s) => (
                  <FilterChip key={s} label={s} active={false} onClick={() => setInput(s)} />
                ))}
              </span>
            )}
          </Empty>
        )}
        {q.trim() && hits && hits.length === 0 && (
          <Empty>
            Nothing matches “{q}”{typeFilter ? ` in ${typeFilter}` : ""}. Try a different word.
          </Empty>
        )}
        {hits && hits.length > 0 && (
          <ul ref={listRef} className="flex max-w-[840px] flex-col">
            {hits.map((h, i) => (
              <Hit key={h.id} hit={h} deep={stage === "deep"} selected={i === sel} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The quiet line that tells you which retrieval pass you are looking at. */
function StageLine({ stage, hasGraph, total }: { stage: Stage; hasGraph: boolean; total: number }) {
  if (stage === "idle") return null;
  return (
    <span className="shrink-0 text-right text-[11.5px] whitespace-nowrap text-dim tabular-nums">
      {stage === "deepening" && (
        <span className="inline-flex items-center gap-1.5">
          <span className="deep-pulse inline-block h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
          searching deeper…
        </span>
      )}
      {stage === "quick" && `${total} quick ${total === 1 ? "match" : "matches"}`}
      {stage === "deep" && (
        <span className="inline-flex items-center gap-1">
          <Sparkles size={11} aria-hidden className="text-[var(--brand)]" />
          {total} ranked by meaning{hasGraph ? " + connections" : ""}
        </span>
      )}
    </span>
  );
}

/** How this hit was found — the per-hit provenance badge. Exact-text is the
 *  expected case so it stays muted; the interesting provenances get tint. */
const PROVENANCE: Record<string, { label: string; accent: boolean }> = {
  fulltext: { label: "exact text", accent: false },
  semantic: { label: "meaning", accent: true },
  both: { label: "text + meaning", accent: true },
  graph: { label: "connected", accent: true },
  title_fuzzy: { label: "≈ title", accent: false },
};

function MatchBadge({ match }: { match: string }) {
  const p = PROVENANCE[match] ?? { label: match, accent: false };
  return (
    <Badge
      variant="outline"
      className={`match-badge rounded-full px-1.5 py-px text-[10.5px] leading-[1.5] font-normal ${
        p.accent
          ? "border-[var(--brand)]/35 bg-accent-soft text-[var(--mark-fg)]"
          : "border-line-soft text-dim"
      }`}
    >
      {p.label}
    </Badge>
  );
}

/** One result row — a real link (⌘-click, copy address, middle-click all
 *  work); Enter-on-selection navigates from the input's key handler. */
const Hit = memo(function Hit({
  hit: h,
  deep,
  selected,
}: {
  hit: SearchHit;
  deep: boolean;
  selected: boolean;
}) {
  return (
    <li
      className={`border-b border-line-soft last:border-0 ${selected ? "bg-hover" : ""}`}
      data-selected={selected || undefined}
    >
      <Link to={`/o/${h.id}`} className="group block px-2 py-4">
        <div className="flex items-center gap-2.5">
          <TypePill type={h.type} />
          <span className="truncate text-[15px] font-[600] tracking-[-0.01em] group-hover:underline group-hover:decoration-[var(--line)]">
            {h.title ?? "untitled"}
          </span>
          {deep && <MatchBadge match={h.match} />}
          <span className="ml-auto shrink-0 text-[11.5px] text-dim">
            {fmtRelative(h.updated_at)}
          </span>
        </div>
        {h.snippet && (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-mut">
            <Snippet text={h.snippet} />
          </p>
        )}
        {deep && h.via && (
          <p className="match-badge mt-1.5 flex items-center gap-1.5 text-[11.5px] text-dim">
            <Link2 size={11} aria-hidden className="shrink-0" />
            <span className="truncate">
              via <span className="text-mut">{h.via.seed}</span>
              {h.via.rels.length > 0 && (
                <>
                  {" "}
                  → <span className="font-mono">{h.via.rels.join(", ")}</span>
                </>
              )}
            </span>
          </p>
        )}
      </Link>
    </li>
  );
});

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`cursor-pointer rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
        active
          ? "border-[var(--brand)] bg-accent-soft text-[var(--mark-fg)]"
          : "border-line-soft text-mut hover:border-line hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
