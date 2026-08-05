import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, ChevronDown, ChevronUp, FileText, Lock } from "lucide-react";
import {
  api,
  type FeedEvent,
  type ListItem,
  type RecentObject,
  type Stats,
  type TypeSummary,
  type Whoami,
} from "../lib/api";
import { Empty, Spinner, TypeDot, TypeIcon } from "../components/bits";
import { Button } from "../components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { fmtNumber, fmtRelative, registerTypeIcons, typeHue, typeLabel, typeName } from "../lib/ui";
import { useTheme } from "../lib/theme";
import { useIsMobile } from "../lib/mobile";

/** Not every box has a "daily_digest" type defined — most won't, until an
 *  agent with brain-write access starts producing them (see the digest
 *  banner's own comment). A missing type 404s; that's silence, not error. */
const DAILY_DIGEST_TYPE = "daily_digest";

const FEATURED_COUNT = 6;

/**
 * How many notes/private objects the two shelf cards fetch. These endpoints
 * return a TRUNCATED LIST, not a count — so the cards must never present
 * `list.length` as a total beside the DatabaseCards' true `t.count` (a box
 * with 400 notes would read "Notes 30" as fact). At the cap the count renders
 * as "30+", which is what we actually know.
 */
const SHELF_FETCH_LIMIT = 30;
const JUMP_BACK_COUNT = 8;

/**
 * Home answers two questions, in priority order: "what did I just touch"
 * (Jump back in) and "what does this company know, where do I go" (the
 * library, biggest/most-active databases featured, the long tail collapsed
 * to a single line each). The activity rail is context, not a second
 * headline — it's quieter and grouped by day so it doesn't compete.
 */
export function Home({ user }: { user: Whoami }) {
  const { hideDeprecated, theme, mono } = useTheme();
  // Match every other primary view: the phone drops outer content padding from
  // px-8 to px-4 so Home doesn't render ~32px narrower than the databases you
  // tap into (TypeView / the four layouts / ObjectView all do the same switch).
  const isMobile = useIsMobile();
  const padX = isMobile ? "px-4" : "px-8";
  const [stats, setStats] = useState<Stats | null>(null);
  const [types, setTypes] = useState<TypeSummary[] | null>(null);
  const [recent, setRecent] = useState<RecentObject[] | null>(null);
  const [feed, setFeed] = useState<FeedEvent[] | null>(null);
  const [notes, setNotes] = useState<Awaited<ReturnType<typeof api.untyped>>>([]);
  const [priv, setPriv] = useState<Awaited<ReturnType<typeof api.privateObjects>>>([]);
  const [digest, setDigest] = useState<ListItem | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  // `types`/`recent` gate the ENTIRE main column's spinner, and `feed` the
  // rail's — so a transient failure of any (a 5xx / network drop on first
  // paint, most often the box self-updating) would leave that column spinning
  // FOREVER with no way out. Track the failures so the surface can offer a
  // retry instead. `reloadNonce` re-runs the load effect on demand.
  const [loadError, setLoadError] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const retry = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    setLoadError(false);
    setFeedError(false);
    api.stats().then(setStats).catch(console.error);
    api
      .types()
      .then((ts) => {
        registerTypeIcons(ts);
        setTypes(ts);
      })
      // `types` (with `recent`) gates the main column's spinner: a failure here
      // must become a retryable error, never an eternal spinner.
      .catch((e) => {
        console.error(e);
        setLoadError(true);
      });
    // Silent on failure — most boxes won't have this type defined yet, and
    // that's a normal, expected state, not an error to surface.
    api
      .list(DAILY_DIGEST_TYPE, { limit: 5 })
      .then((r) => {
        const latest = [...r.items].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
        setDigest(latest ?? null);
      })
      .catch(() => undefined);
    api
      .recentObjects(60)
      .then(setRecent)
      .catch((e) => {
        console.error(e);
        setLoadError(true);
      });
    api
      .feed(30)
      .then(setFeed)
      .catch((e) => {
        console.error(e);
        setFeedError(true);
      });
    api.untyped(SHELF_FETCH_LIMIT).then(setNotes).catch(console.error);
    api.privateObjects(SHELF_FETCH_LIMIT).then(setPriv).catch(console.error);
  }, [reloadNonce]);

  // newest objects per database, from one recent-objects call
  const newestByType = useMemo(() => {
    const m = new Map<string, RecentObject[]>();
    for (const o of recent ?? []) {
      if (!o.type) continue;
      const arr = m.get(o.type) ?? [];
      if (arr.length < 3) arr.push(o);
      m.set(o.type, arr);
    }
    return m;
  }, [recent]);

  // Databases, biggest/most-active first. The few that matter get the full
  // card; the long tail collapses to one quiet row each.
  const sortedTypes = useMemo(() => {
    const visible = (types ?? []).filter((t) => !hideDeprecated || !t.deprecated);
    return [...visible].sort((a, b) => b.count - a.count);
  }, [types, hideDeprecated]);
  const featured = sortedTypes.slice(0, FEATURED_COUNT);
  const longTail = sortedTypes.slice(FEATURED_COUNT);

  // Activity grouped by day so the rail reads as a timeline, not a pile.
  const feedGroups = useMemo(() => {
    const groups: Array<{ label: string; rows: ActivityRow[] }> = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const byLabel = new Map<string, FeedEvent[]>();
    for (const e of feed ?? []) {
      const d = new Date(e.at);
      const dayStart = new Date(d);
      dayStart.setHours(0, 0, 0, 0);
      const label =
        dayStart.getTime() === today.getTime()
          ? "Today"
          : dayStart.getTime() === yesterday.getTime()
            ? "Yesterday"
            : "Earlier";
      const arr = byLabel.get(label) ?? [];
      arr.push(e);
      byLabel.set(label, arr);
    }
    for (const label of ["Today", "Yesterday", "Earlier"]) {
      const events = byLabel.get(label);
      if (events?.length) groups.push({ label, rows: groupConsecutive(events) });
    }
    return groups;
  }, [feed]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const loading = !types || !recent;
  const jumpBackIn = (recent ?? []).slice(0, JUMP_BACK_COUNT);

  return (
    <div className="flex min-h-full flex-col">
      <header className={`border-b border-line-soft pt-7 pb-4 ${padX}`}>
        <h1 className="text-[21px] font-[650] tracking-[-0.02em]">
          {greeting}, {user.name.split(" ")[0]}
        </h1>
        <div className="mt-3.5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          {stats && (
            // The shape of the brain, given real presence: the numbers are the
            // point, so they are set in ink at display weight with the label a
            // quiet caption beneath — not a dim dot-separated run that reads as
            // an afterthought.
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Stat n={stats.entities} label="objects" />
              <Stat n={stats.relationships} label="links" />
              <Stat n={stats.types} label="databases" />
              <Stat n={stats.members} label="members" />
              <Stat n={stats.eventsToday} label="today" />
            </dl>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className={`min-w-0 flex-1 py-6 ${padX}`}>
          {loading &&
            (loadError ? (
              <Empty
                action={
                  <Button variant="outline" size="sm" onClick={retry}>
                    Try again
                  </Button>
                }
              >
                Couldn't load your dashboard — a hiccup, most likely while the box reconnects. It's
                still here.
              </Empty>
            ) : (
              <Spinner />
            ))}

          {digest && <DailyDigestBanner digest={digest} theme={theme} mono={mono} />}

          {/* the actionable thing: what you just touched */}
          {!loading && jumpBackIn.length > 0 && (
            <div className="mb-8">
              <SectionHeading>Jump back in</SectionHeading>
              {/* Stacked full-width rows on a phone (uniform right edge, time
                  pinned right), shrink-wrapped pills once there is room to flow
                  them — a wrap of text-width pills reads as a ragged margin on a
                  narrow screen. */}
              <div className="flex flex-col gap-2 md:flex-row md:flex-wrap">
                {jumpBackIn.map((o) => (
                  <Link
                    key={o.id}
                    to={`/o/${o.id}`}
                    className="card group flex w-full items-center gap-2 border border-line-soft bg-panel px-3 py-2 text-[13px] transition-colors hover:border-line hover:bg-hover focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)] focus-visible:outline-offset-[-2px] md:w-auto"
                  >
                    <TypeIcon type={o.type} size={13} />
                    <span className="min-w-0 flex-1 truncate text-ink md:max-w-[220px] md:flex-none">
                      {o.title ?? "untitled"}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-dim md:ml-0">
                      {fmtRelative(o.updated_at)}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {types && types.length === 0 && (
            <Empty>No databases yet — the brain builds its own schema as it learns.</Empty>
          )}

          {!loading && types && types.length > 0 && (
            <>
              <SectionHeading>Your databases</SectionHeading>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {featured.map((t) => (
                  <DatabaseCard key={t.name} type={t} newest={newestByType.get(t.name) ?? []} />
                ))}
                <ShelfCard
                  to="/notes"
                  icon={<FileText size={17} className="text-dim" aria-hidden />}
                  title="Notes"
                  count={shelfCount(notes.length)}
                  items={notes.slice(0, 2)}
                />
                <ShelfCard
                  to="/private"
                  icon={<Lock size={17} className="text-dim" aria-hidden />}
                  title="Private"
                  count={shelfCount(priv.length)}
                  items={priv.slice(0, 2)}
                />
              </div>

              {longTail.length > 0 && (
                <div className="mt-6">
                  <SectionHeading muted>More databases</SectionHeading>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                    {longTail.map((t) => (
                      <Link
                        key={t.name}
                        to={`/t/${t.name}`}
                        className="group flex items-center gap-2 border-b border-line-soft py-2 pr-2 text-[13px] transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)] focus-visible:outline-offset-[-2px]"
                      >
                        <TypeIcon icon={t.icon} type={t.name} size={13} />
                        <span
                          className={`min-w-0 flex-1 truncate text-ink ${t.deprecated ? "line-through opacity-60" : ""}`}
                        >
                          {typeLabel(t)}
                        </span>
                        <span className="font-mono text-[11px] text-dim">{t.count}</span>
                        <ArrowRight
                          size={12}
                          className="shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100"
                          aria-hidden
                        />
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* activity rail — quiet by default, grouped by day, collapsible.
            Stacks full-width below the library on narrow screens (lg:flex-row
            above is where it becomes a side rail) so it never gets squeezed
            into an illegible second column. */}
        <aside
          className={`shrink-0 border-t border-line-soft py-6 transition-[width] lg:border-t-0 lg:border-l ${
            // Stacked below the library (< lg), the rail must share the main
            // section's left edge — so it carries the SAME `padX` there and only
            // takes its own side-rail padding (px-6 / px-0) once it becomes a
            // column at lg. Otherwise its old flat px-6 sat 8px off the px-8
            // section on tablet and 8px off the px-4 section on the phone.
            railOpen ? `w-full ${padX} lg:w-[300px] lg:px-6` : `w-full ${padX} lg:w-11 lg:px-0`
          }`}
        >
          <button
            onClick={() => setRailOpen((v) => !v)}
            className="mb-3 flex w-full items-center gap-1.5 text-[11px] font-semibold tracking-[.08em] text-dim uppercase hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)] focus-visible:outline-offset-2"
            aria-expanded={railOpen}
            aria-label={railOpen ? "Collapse activity panel" : "Expand activity panel"}
          >
            {railOpen ? (
              <>
                Activity
                <ChevronUp size={12} className="ml-auto" aria-hidden />
              </>
            ) : (
              <ChevronDown size={12} className="mx-auto" aria-hidden />
            )}
          </button>
          {railOpen && (
            <>
              {!feed &&
                (feedError ? (
                  <Empty
                    action={
                      <Button variant="outline" size="sm" onClick={retry}>
                        Try again
                      </Button>
                    }
                  >
                    Couldn't load activity.
                  </Empty>
                ) : (
                  <Spinner />
                ))}
              {feed && feed.length === 0 && <Empty>No activity yet.</Empty>}
              {feedGroups.map((group) => (
                <div key={group.label} className="mb-3">
                  <div className="mb-1 text-[10.5px] font-medium tracking-wide text-dim uppercase">
                    {group.label}
                  </div>
                  <ul className="flex flex-col">
                    {group.rows.map((row) => (
                      <li
                        key={row.key}
                        className="flex gap-2.5 border-b border-line-soft py-2 last:border-0"
                      >
                        <span className="mt-[5px]">
                          <TypeDot type={row.targets[0]?.type ?? null} size={5} />
                        </span>
                        <div className="min-w-0 flex-1 text-[12px] leading-relaxed">
                          <div className="text-[10.5px] text-dim">
                            {row.actor_name ?? "someone"} {verb(row.kind)}
                            <span className="ml-1.5 whitespace-nowrap">{fmtRelative(row.at)}</span>
                          </div>
                          {row.targets.length === 0 ? (
                            <span className="text-mut">the schema</span>
                          ) : (
                            <span>
                              {row.targets.map((t, i) => (
                                <span key={t.id}>
                                  {i > 0 && <span className="text-dim">, </span>}
                                  <Link
                                    to={`/o/${t.id}`}
                                    className={`font-medium text-ink hover:underline focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)] focus-visible:outline-offset-[-2px] ${t.deleted ? "line-through opacity-60" : ""}`}
                                  >
                                    {t.title ?? "an object"}
                                  </Link>
                                </span>
                              ))}
                              {row.overflow > 0 && (
                                <span className="text-dim"> +{row.overflow} more</span>
                              )}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * The brain's own voice, once a day — deliberately NOT another card in the
 * grid below. No box, no shadow, just a quiet full-width band with a live
 * dot and prose set noticeably larger than the rest of the app's dense
 * small text, so it reads as "written," not "data." The stat chips below
 * the prose tie back into the same type-color language as everywhere else.
 *
 * Nothing here calls an LLM — this renders whatever object of type
 * "daily_digest" was written most recently, by whoever wrote it. That's
 * deliberate: no box needs its own API key. A templated non-AI digest can
 * write this same shape; so can an agent with brain-write access running
 * on a schedule (a cron’d agent, anything already
 * authenticated to the brain). The UI doesn't know or care which.
 */
function DailyDigestBanner({
  digest,
  theme,
  mono,
}: {
  digest: ListItem;
  theme: "light" | "dark";
  mono: boolean;
}) {
  const p = digest.props ?? {};
  const summary = typeof p["summary"] === "string" ? p["summary"] : null;
  if (!summary) return null;

  const touched = typeof p["objects_touched"] === "number" ? p["objects_touched"] : null;
  const topType = typeof p["top_type"] === "string" ? p["top_type"] : null;
  const topTypeCount = typeof p["top_type_count"] === "number" ? p["top_type_count"] : null;
  const activePeople = typeof p["active_people"] === "number" ? p["active_people"] : null;
  const hasChips = touched !== null || (topType && topTypeCount !== null) || activePeople !== null;

  return (
    <div className="relative mb-8 border-b border-line-soft pb-6">
      {!mono && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background: "radial-gradient(55% 160% at 6% 0%, rgba(74,108,245,.11), transparent 65%)",
          }}
        />
      )}
      <div className="mb-2 flex items-center gap-2">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--ink-strong)] opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--ink-strong)]" />
        </span>
        <span className="text-[11px] font-semibold tracking-[.08em] text-dim uppercase">
          Today's digest
        </span>
      </div>
      <p className="max-w-[640px] text-[15.5px] leading-relaxed text-pretty text-ink">{summary}</p>
      {hasChips && (
        <div className="mt-3 flex flex-wrap gap-2">
          {touched !== null && (
            <span className="border border-line-soft px-2.5 py-1 text-[11.5px] text-mut">
              <b className="font-semibold text-ink">{touched}</b> objects touched
            </span>
          )}
          {topType && topTypeCount !== null && (
            <span
              className="flex items-center gap-1.5 border px-2.5 py-1 text-[11.5px]"
              style={{
                borderColor: `${typeHue(topType, theme)}44`,
                color: typeHue(topType, theme),
                background: `${typeHue(topType, theme)}14`,
              }}
            >
              <TypeIcon type={topType} size={11} />
              {typeName(topType)} +{topTypeCount}
            </span>
          )}
          {activePeople !== null && (
            <span className="border border-line-soft px-2.5 py-1 text-[11.5px] text-mut">
              <b className="font-semibold text-ink">{activePeople}</b>{" "}
              {activePeople === 1 ? "person" : "people"} active
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** One number from the brain's shape, set with presence: a display-weight
 *  ink figure over a quiet label. */
function Stat({ n, label }: { n: number | string | null | undefined; label: string }) {
  // DOM order is dt-then-dd (the definition-list content model requires the term
  // before its description); `flex-col-reverse` keeps the number set in ink ON
  // TOP with the label a quiet caption beneath, so the semantics are correct
  // without inverting the visual.
  return (
    <div className="flex flex-col-reverse gap-0.5">
      <dt className="text-[10.5px] font-medium tracking-[.08em] text-dim uppercase">{label}</dt>
      <dd className="text-[22px] leading-none font-[650] tracking-[-0.02em] text-ink tabular-nums">
        {fmtNumber(n)}
      </dd>
    </div>
  );
}

function SectionHeading({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <h2
      className={`mb-2.5 text-[11px] font-semibold tracking-[.08em] uppercase ${muted ? "text-dim/70" : "text-dim"}`}
    >
      {children}
    </h2>
  );
}

/** Shared card chrome: a big soft-tinted icon (recognize by color/shape
 *  before you read a word), name + count, up to two recent items. No
 *  description sentence — that's one more thing to read on every one of
 *  eight cards, and the destination page already says what it is. */
/** A fetch-capped list length, rendered honestly: "30+" at the cap. */
function shelfCount(length: number): string {
  return length >= SHELF_FETCH_LIMIT ? `${SHELF_FETCH_LIMIT}+` : String(length);
}

function CardShell({
  to,
  icon,
  title,
  count,
  deprecated,
  items,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  /** a true total (DatabaseCard) or an honest capped figure like "30+". */
  count: number | string;
  deprecated?: boolean;
  items: Array<{ id: string; title: string | null; updated_at: string }>;
}) {
  return (
    <Card className="card group flex flex-col gap-0 rounded-none border-0 py-0">
      <Link
        to={to}
        className="flex items-center gap-3 px-4 py-3.5 focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)] focus-visible:outline-offset-[-2px]"
      >
        {/* A hairline-bordered glyph tile, not a pastel candy circle: the soft
            tinted circle was the one template-clone element on the page and it
            fought the radius:0 editorial geometry everywhere else. */}
        <div className="grid h-9 w-9 shrink-0 place-items-center border border-line-soft">
          {icon}
        </div>
        <span
          className={`min-w-0 flex-1 truncate text-[15px] font-[650] tracking-[-0.01em] ${
            deprecated ? "line-through opacity-60" : ""
          }`}
        >
          {title}
        </span>
        <span className="font-mono text-[11.5px] text-dim">{count}</span>
        <ArrowRight
          size={13}
          className="shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </Link>
      <Separator className="mx-4 w-auto" />
      <div className="flex flex-1 flex-col px-2 py-1.5">
        {items.length === 0 && (
          <span className="px-2 py-1.5 text-[12.5px] text-dim italic">Nothing here yet.</span>
        )}
        {items.slice(0, 2).map((o) => (
          <Link
            key={o.id}
            to={`/o/${o.id}`}
            className="flex items-baseline gap-2 rounded-none px-2 py-1.5 text-[13px] transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ink-strong)]"
          >
            <span className="min-w-0 truncate text-ink">{o.title ?? "untitled"}</span>
            <span className="ml-auto shrink-0 text-[11px] text-dim">
              {fmtRelative(o.updated_at)}
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function DatabaseCard({ type: t, newest }: { type: TypeSummary; newest: RecentObject[] }) {
  return (
    <CardShell
      to={`/t/${t.name}`}
      icon={<TypeIcon icon={t.icon} type={t.name} size={17} />}
      title={typeLabel(t)}
      count={t.count}
      deprecated={t.deprecated}
      items={newest}
    />
  );
}

function ShelfCard({
  to,
  icon,
  title,
  count,
  items,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  count: number | string;
  items: Array<{ id: string; title: string | null; updated_at: string }>;
}) {
  return <CardShell to={to} icon={icon} title={title} count={count} items={items} />;
}

const MAX_ROW_TARGETS = 3;

interface ActivityRow {
  key: string;
  actor_name: string | null;
  kind: string;
  at: string;
  targets: Array<{ id: string; title: string | null; deleted: boolean; type: string | null }>;
  overflow: number;
}

/** Collapse a run of consecutive same-actor, same-verb events (e.g. someone
 *  creating five things in a row) into one row — the rail otherwise repeats
 *  "Actor created …" once per object, which reads as noise, not signal. */
function groupConsecutive(events: FeedEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  // Same object edited five times in a row is one thing that happened, not
  // five — dedupe DISTINCT targets within a grouped row so a burst of saves on
  // one object doesn't print its title three times ("… , … , … +2 more").
  const seen: Array<Set<string>> = [];
  for (const e of events) {
    const last = rows[rows.length - 1];
    const target = e.target
      ? { id: e.target, title: e.target_title, deleted: e.target_deleted, type: e.target_type }
      : null;
    if (target && last && last.actor_name === e.actor_name && last.kind === e.kind) {
      const lastSeen = seen[seen.length - 1]!;
      if (lastSeen.has(target.id)) continue; // already in this row — not a second mention
      lastSeen.add(target.id);
      if (last.targets.length < MAX_ROW_TARGETS) last.targets.push(target);
      else last.overflow++;
      continue;
    }
    rows.push({
      key: e.seq,
      actor_name: e.actor_name,
      kind: e.kind,
      at: e.at,
      targets: target ? [target] : [],
      overflow: 0,
    });
    seen.push(new Set(target ? [target.id] : []));
  }
  return rows;
}

function verb(kind: string): string {
  switch (kind) {
    case "create":
      return "created";
    case "edit":
      return "edited";
    case "delete":
      return "deleted";
    case "restore":
      return "restored";
    case "link":
      return "linked";
    case "unlink":
      return "unlinked";
    default:
      return kind;
  }
}
