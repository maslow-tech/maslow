import { Link } from "react-router";
import { Lock, Users } from "lucide-react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Empty, LoadError, Spinner, TypePill } from "../components/bits";
import { Card } from "@/components/ui/card";
import { fmtRelative, plainSnippet } from "../lib/ui";

type PrivateObj = Awaited<ReturnType<typeof api.privateObjects>>[number];

/**
 * The caller's private world, split honestly: objects they created (only they
 * and their share list can see) vs objects someone else shared with them.
 * RLS decides what's in here — the page just groups it.
 */
export function PrivateView() {
  const {
    data: items,
    error,
    loading,
    reload,
  } = useAsync<PrivateObj[]>(() => api.privateObjects(), []);

  const mine = (items ?? []).filter((o) => o.mine);
  const shared = (items ?? []).filter((o) => !o.mine);

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line-soft px-8 pt-7 pb-5">
        <h1 className="text-[21px] font-[650] tracking-[-0.02em]">Private</h1>
        <p className="mt-1 text-[13.5px] text-mut">
          Only you can see this page's contents — your private objects, and what others shared with
          you.
        </p>
      </header>

      <div className="min-h-0 flex-1 px-8 py-6">
        {loading && <Spinner />}
        {error && <LoadError message={error} onRetry={reload} />}
        {items && items.length === 0 && (
          <Empty>Nothing private yet — everything you can see is org-visible.</Empty>
        )}
        {items && items.length > 0 && (
          <div className="flex max-w-[900px] flex-col gap-8">
            <Group
              icon={<Lock size={12} aria-hidden />}
              title="Yours"
              caption="visible to you and anyone you shared them with"
              items={mine}
            />
            <Group
              icon={<Users size={12} aria-hidden />}
              title="Shared with you"
              caption="private objects someone else let you in on"
              items={shared}
              showOwner
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Group({
  icon,
  title,
  caption,
  items,
  showOwner = false,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
  items: PrivateObj[];
  showOwner?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[.08em] text-dim uppercase">
        {icon}
        {title}
        <span className="font-normal normal-case">— {caption}</span>
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-2.5 xl:grid-cols-2">
        {items.map((o) => (
          <Card key={o.id} className="card gap-0 rounded-none border-0 py-0">
            <Link to={`/o/${o.id}`} className="block px-4 py-3.5">
              <div className="flex items-center gap-2">
                <TypePill type={o.type} />
                {showOwner && o.owner_name && (
                  <span className="text-[11.5px] text-dim">from {o.owner_name}</span>
                )}
                <span className="ml-auto shrink-0 text-[11.5px] text-dim">
                  {fmtRelative(o.updated_at)}
                </span>
              </div>
              <div className="mt-2 truncate text-[14.5px] font-[600] tracking-[-0.01em]">
                {o.title ?? "untitled"}
              </div>
              {o.snippet && (
                <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-mut">
                  {plainSnippet(o.snippet)}
                </p>
              )}
            </Link>
          </Card>
        ))}
      </div>
    </section>
  );
}
