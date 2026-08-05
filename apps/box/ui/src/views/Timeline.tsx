import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api, type FeedEvent } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { Empty, LoadError, Spinner, TypeDot } from "../components/bits";
import { coalesceFeed, verb } from "../lib/feed";
import { fmtDate } from "../lib/ui";

/** One page. The feed is newest-first and append-only, so "more" is always older. */
const PAGE = 120;

/**
 * The brain's memory of itself: every event, newest first, grouped by day.
 *
 * Paging is by GROWING THE LIMIT rather than by cursor, because the endpoint
 * takes a limit and nothing else. For a newest-first, append-only feed that is
 * honest — page two is a superset of page one, so nothing can be missed or
 * duplicated between them, which is the thing a cursor would buy. It costs a
 * re-fetch of what you already had; a real `before=<seq>` cursor is the upgrade
 * if this ever gets slow.
 * ponytail: limit-growth paging — swap for a seq cursor if the feed gets long.
 *
 * The person filter runs over the events actually LOADED, and says so, rather
 * than pretending to be a server-side query over all of history.
 */
export function Timeline() {
  const [limit, setLimit] = useState(PAGE);
  const [person, setPerson] = useState<string>("");
  const {
    data: feed,
    error,
    loading,
    reload,
  } = useAsync<FeedEvent[]>(() => api.feed(limit), [limit]);

  /** Everyone who appears in what we have — the filter can only offer these. */
  const people = useMemo(() => {
    const names = new Set<string>();
    for (const e of feed ?? []) if (e.actor_name) names.add(e.actor_name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [feed]);

  const shown = useMemo(
    () => (feed ?? []).filter((e) => person === "" || e.actor_name === person),
    [feed, person],
  );

  const groups = groupByDay(coalesceFeed(shown));
  // A short page means asking again would change nothing — EITHER the feed ran
  // out or the endpoint's own cap (200) refused to go further. We cannot tell
  // which from here, so the copy below never claims the timeline ended; it
  // states what is loaded, which is true in both cases. Saying "that's
  // everything" over a server cap is exactly the silent-truncation lie the
  // graph's own copy rules exist to prevent.
  const more = (feed?.length ?? 0) >= limit;

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line-soft px-8 pt-7 pb-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[21px] font-[650] tracking-[-0.02em]">Timeline</h1>
            <p className="mt-1 text-[13.5px] text-mut">
              Everything that happened in the brain, newest first.
            </p>
          </div>
          {people.length > 1 && (
            <SelectField
              id="timeline-person"
              label="Person"
              value={person}
              onChange={(e) => setPerson(e.target.value)}
            >
              <option value="">Everyone</option>
              {people.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </SelectField>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 px-8 py-6">
        {loading && feed === null && <Spinner />}
        {error && <LoadError message={error} onRetry={reload} />}
        {feed && feed.length === 0 && <Empty>No events yet.</Empty>}
        {feed && feed.length > 0 && shown.length === 0 && (
          <Empty>Nothing from {person} in the events loaded so far.</Empty>
        )}
        <div>
          {groups.map(([day, events]) => (
            <section key={day} className="mb-7">
              <h2 className="mb-2 text-[11px] font-semibold tracking-[.08em] text-dim uppercase">
                {day}
              </h2>
              <ul className="flex flex-col border-l border-line-soft pl-5">
                {events.map((e) => (
                  <li key={e.seq} className="relative py-2">
                    <span
                      aria-hidden
                      className="absolute top-[15px] -left-[23px] h-1.5 w-1.5 rounded-full bg-[var(--dim)]"
                    />
                    <div className="flex items-baseline gap-2 text-[13.5px] leading-relaxed">
                      <span className="shrink-0 font-medium whitespace-nowrap text-ink">
                        {e.actor_name ?? "someone"}
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-dim">{verb(e.kind)}</span>
                      {e.target ? (
                        <Link
                          to={`/o/${e.target}`}
                          className={`inline-flex min-w-0 flex-1 items-center gap-1.5 font-medium text-ink hover:underline ${
                            e.target_deleted ? "line-through opacity-60" : ""
                          }`}
                        >
                          <TypeDot type={e.target_type} size={6} />
                          <span className="truncate">{e.target_title ?? "an object"}</span>
                        </Link>
                      ) : (
                        <span className="text-mut">the schema</span>
                      )}
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">
                        {new Date(e.at).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {feed && feed.length > 0 && (
          <div className="flex items-center gap-3 border-t border-line-soft pt-4">
            {more ? (
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => setLimit((l) => l + PAGE)}
              >
                {loading ? "Loading…" : "Load older"}
              </Button>
            ) : (
              <span className="text-[12px] text-dim">
                Showing the most recent {feed.length} events.
              </span>
            )}
            <span className="text-[11.5px] text-dim">
              {shown.length === feed.length
                ? `${feed.length} events loaded`
                : `${shown.length} of ${feed.length} events loaded`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function groupByDay(feed: FeedEvent[]): Array<[string, FeedEvent[]]> {
  const out = new Map<string, FeedEvent[]>();
  for (const e of feed) {
    const day = fmtDate(e.at);
    out.set(day, [...(out.get(day) ?? []), e]);
  }
  return [...out.entries()];
}
