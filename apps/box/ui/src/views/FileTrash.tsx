import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api, type FsTrashEntry } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Empty, Spinner } from "../components/bits";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDate } from "../lib/ui";
import { displayPath, errText, fmtBytes, loadTrash, restoreAndReload } from "../lib/fsversions";

/**
 * Deleted files, and the button that brings them back.
 * `rm` is a soft delete: the store keeps the removed bytes as a snapshot, so
 * anything listed here restores to its original path. RLS scopes the listing
 * exactly like the file tree — another member's home never appears.
 *
 * Restore refuses (EEXIST, shown verbatim) when something already lives at the
 * old path; that is the store's rule, not a UI guess.
 *
 * Paths render through displayPath, so your own home shows as `~/…` here just
 * as it does in the path bar — the file manager never prints the raw
 * /home/<slug>, and the restore call still uses the real path.
 */
const HEAD = "px-4 py-2.5 text-[11px] font-semibold tracking-[.07em] text-dim uppercase";

export function FileTrash({
  prefix,
  home,
  onRestored,
}: {
  prefix: string;
  /** your home dir's real path, so it can be shown as `~` (null = unknown). */
  home: string | null;
  onRestored: () => void;
}) {
  const [entries, setEntries] = useState<FsTrashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setEntries(null);
    setError(null);
    loadTrash(api, prefix)
      .then(setEntries)
      .catch((e: unknown) => {
        setEntries([]);
        setError(errText(e, "could not read the trash"));
      });
  }, [prefix]);
  useEffect(load, [load]);

  const restore = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await restoreAndReload(api, path, undefined, () => {
        load();
        onRestored();
      });
    } catch (e) {
      setError(errText(e, "restore failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1">
      {error && (
        <div className="mx-8 mt-4 max-w-[720px] border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive">
          {error}
        </div>
      )}

      {!entries && <Spinner />}

      {entries && entries.length === 0 && !error && (
        <div className="p-8">
          <Empty>
            <span className="block">
              Nothing deleted {prefix === "/" ? "" : `under ${displayPath(prefix, home)}`}.
            </span>
            <span className="mt-1 block text-[13px] text-dim">
              Deleting a file keeps its bytes here — it can always come back.
            </span>
          </Empty>
        </div>
      )}

      {entries && entries.length > 0 && (
        <Table className="text-[13.5px]">
          <TableHeader>
            <TableRow>
              <TableHead className={`${HEAD} pl-8`}>Path</TableHead>
              <TableHead className={HEAD}>Size</TableHead>
              <TableHead className={HEAD}>Deleted</TableHead>
              <TableHead className={HEAD}>Deleted by</TableHead>
              <TableHead className={`${HEAD} w-[110px] pr-8`} aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.path}>
                <TableCell className="max-w-[440px] py-2.5 pr-4 pl-8">
                  <span className="block truncate font-mono text-[12.5px] text-ink line-through opacity-80">
                    {displayPath(e.path, home)}
                  </span>
                </TableCell>
                <TableCell className="px-4 py-2.5 font-mono text-[12.5px] whitespace-nowrap text-mut">
                  {fmtBytes(e.size_bytes)}
                </TableCell>
                <TableCell className="px-4 py-2.5 whitespace-nowrap text-dim">
                  {fmtDate(e.deleted_at)}
                </TableCell>
                <TableCell className="px-4 py-2.5 text-mut">{e.edited_by ?? "—"}</TableCell>
                <TableCell className="py-1.5 pr-8 pl-4 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void restore(e.path)}
                  >
                    <RotateCcw aria-hidden /> Restore
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
