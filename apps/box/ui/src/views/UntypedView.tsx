import { Link } from "react-router";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Empty, LoadError, PrivateBadge, Spinner } from "../components/bits";
import { Card } from "@/components/ui/card";
import { fmtNumber, fmtRelative, plainSnippet } from "../lib/ui";

type Note = Awaited<ReturnType<typeof api.untyped>>[number];

/** Free-form notes that live outside every database — the brain's margin. */
export function UntypedView() {
  const { data: items, error, loading, reload } = useAsync<Note[]>(() => api.untyped(), []);

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line-soft px-8 pt-7 pb-5">
        <h1 className="text-[21px] font-[650] tracking-[-0.02em]">Notes</h1>
        <p className="mt-1 text-[13.5px] text-mut">
          Untyped objects — captured before they belong to any database.
        </p>
      </header>

      <div className="min-h-0 flex-1 px-8 py-6">
        {loading && <Spinner />}
        {error && <LoadError message={error} onRetry={reload} />}
        {items && items.length === 0 && (
          <Empty>No loose notes — everything has found its database.</Empty>
        )}
        {items && items.length > 0 && (
          <div className="grid max-w-[1100px] grid-cols-1 gap-2.5 lg:grid-cols-2">
            {items.map((o) => (
              <Card key={o.id} className="card gap-0 rounded-none border-0 py-0">
                <Link to={`/o/${o.id}`} className="block px-4 py-3.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14.5px] font-[600] tracking-[-0.01em]">
                      {o.title ?? "untitled"}
                    </span>
                    <PrivateBadge visibility={o.visibility} />
                    <span className="ml-auto shrink-0 text-[11.5px] text-dim">
                      {fmtRelative(o.updated_at)}
                    </span>
                  </div>
                  {o.snippet && (
                    <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-mut">
                      {plainSnippet(o.snippet)}
                    </p>
                  )}
                  <div className="mt-2 text-[11px] text-dim">
                    {fmtNumber(o.degree)} connection{Number(o.degree) === 1 ? "" : "s"}
                  </div>
                </Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
