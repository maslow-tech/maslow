import { Link } from "react-router";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Empty, LoadError, Spinner, TypePill } from "../components/bits";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDate, plainSnippet } from "../lib/ui";

type Tombstone = Awaited<ReturnType<typeof api.trash>>[number];

/**
 * The recycle bin that never empties: soft-delete keeps every row forever so
 * links can't cascade into dead ends. Restore is an owner action on the MCP
 * side — this page is read-only evidence.
 */
export function TrashView() {
  const { data: items, error, loading, reload } = useAsync<Tombstone[]>(() => api.trash(), []);

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line-soft px-8 pt-7 pb-5">
        <h1 className="text-[21px] font-[650] tracking-[-0.02em]">Trash</h1>
        <p className="mt-1 text-[13.5px] text-mut">
          Every deleted object, kept forever as a tombstone — an owner can restore any of them.
        </p>
      </header>

      <div className="min-h-0 flex-1">
        {loading && <Spinner />}
        {error && (
          <div className="p-8">
            <LoadError message={error} onRetry={reload} />
          </div>
        )}
        {items && items.length === 0 && (
          <div className="p-8">
            <Empty>The trash is empty — nothing has ever been deleted.</Empty>
          </div>
        )}
        {items && items.length > 0 && (
          <Table className="text-[13.5px]">
            <TableHeader>
              <TableRow>
                <TableHead className="py-2.5 pr-4 pl-8 text-[11px] font-semibold tracking-[.07em] text-dim uppercase">
                  Title
                </TableHead>
                <TableHead className="px-4 py-2.5 text-[11px] font-semibold tracking-[.07em] text-dim uppercase">
                  Type
                </TableHead>
                <TableHead className="px-4 py-2.5 text-[11px] font-semibold tracking-[.07em] text-dim uppercase">
                  Deleted by
                </TableHead>
                <TableHead className="py-2.5 pr-8 pl-4 text-right text-[11px] font-semibold tracking-[.07em] text-dim uppercase">
                  Deleted
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((o) => (
                <TableRow key={o.id} className="group">
                  <TableCell className="max-w-[440px] py-0 pr-4 pl-8">
                    <Link to={`/o/${o.id}`} className="block py-2.5">
                      <span className="block truncate font-[550] text-ink line-through opacity-70 group-hover:underline">
                        {o.title ?? "untitled"}
                      </span>
                      {o.snippet && (
                        <span className="mt-0.5 block truncate text-[12px] text-dim">
                          {plainSnippet(o.snippet)}
                        </span>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <TypePill type={o.type} />
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-mut">{o.deleted_by_name ?? "—"}</TableCell>
                  <TableCell className="py-2.5 pr-8 pl-4 text-right whitespace-nowrap text-dim">
                    {fmtDate(o.deleted_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
