import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api, type FsVersion } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Empty, Spinner } from "../components/bits";
import { DIFF, LineDiff } from "../components/HistoryDialog";
import { useTheme } from "../lib/theme";
import { fmtDateTime } from "../lib/ui";
import {
  diffUrls,
  errText,
  fmtBytes,
  loadDiffPair,
  loadHistory,
  reasonLabel,
  restoreAndReload,
  tooBigToDiff,
} from "../lib/fsversions";

/**
 * A file's version history: every prior snapshot the
 * store kept, newest first, with a unified diff of that snapshot against the
 * file as it stands now and a one-click Restore.
 *
 * The bytes of a snapshot are fetched as TEXT from /api/v1/files/version and
 * rendered through React text nodes only — the same rule the preview panel
 * follows, so a hostile file body is inert here too. Only text-ish files get a
 * diff (a snapshot of a binary would render as mojibake); Restore is offered
 * for every kind, since the bytes round-trip regardless.
 *
 * A locked file still SHOWS its history — a lock protects writes, not reads —
 * but Restore is a write, so it is disabled with the reason visible.
 */
export function FileHistory({
  path,
  name,
  size,
  diffable,
  lockedBy,
  onRestored,
}: {
  path: string;
  name: string;
  /** live size of the file today — the right-hand side of every diff. */
  size: number;
  /** the file's bytes render as text (extension-decided, like the preview). */
  diffable: boolean;
  /** display name of whoever holds the lock, or null when writable. */
  lockedBy: string | null;
  onRestored: () => void;
}) {
  const { theme } = useTheme();
  const pal = DIFF[theme === "light" ? "light" : "dark"];

  const [versions, setVersions] = useState<FsVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setVersions(null);
    setError(null);
    loadHistory(api, path)
      .then((vs) => {
        if (!live) return;
        setVersions(vs);
        setSelected(vs[0]?.version_no ?? null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setVersions([]);
        setError(errText(e, "could not load this file's history"));
      });
    return () => {
      live = false;
    };
  }, [path, reload]);

  const restore = async (version: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await restoreAndReload(api, path, version, () => {
        setReload((n) => n + 1);
        onRestored();
      });
    } catch (e) {
      setError(errText(e, "restore failed"));
    } finally {
      setBusy(false);
    }
  };

  const chosen = versions?.find((v) => v.version_no === selected) ?? null;

  return (
    <div className="flex min-h-full flex-col">
      {error && (
        <div className="mx-4 mt-3 border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          {error}
        </div>
      )}

      {!versions && <Spinner rows={4} />}

      {versions && versions.length === 0 && !error && (
        <div className="p-5">
          <Empty>
            <span className="block">No earlier versions yet.</span>
            <span className="mt-1 block text-[12.5px] text-dim">
              A version is kept each time this file is overwritten or deleted.
            </span>
          </Empty>
        </div>
      )}

      {versions && versions.length > 0 && (
        <>
          <ol className="border-b border-line-soft">
            {versions.map((v) => {
              const on = v.version_no === selected;
              return (
                <li
                  key={v.version_no}
                  className={`flex items-center gap-2 border-b border-line-soft px-4 py-2 last:border-b-0 ${
                    on ? "bg-[var(--muted)]" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(v.version_no)}
                    aria-pressed={on}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="font-mono text-[12px] font-[600] text-ink">
                        v{v.version_no}
                      </span>
                      <span className="truncate text-[12.5px] text-mut">
                        {reasonLabel(v.reason)}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[11.5px] text-dim">
                        {fmtBytes(v.size_bytes)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-dim">
                      {v.edited_by ?? "someone"} · {fmtDateTime(v.created_at)}
                    </span>
                  </button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy || lockedBy !== null}
                    title={
                      lockedBy !== null
                        ? `locked by ${lockedBy} — unlock it to restore`
                        : "Put these bytes back; the current ones are kept as a new version"
                    }
                    onClick={() => void restore(v.version_no)}
                  >
                    <RotateCcw aria-hidden /> Restore
                  </Button>
                </li>
              );
            })}
          </ol>

          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {chosen && (
              <>
                <div className="mb-2 font-mono text-[11px] tracking-wide text-dim uppercase">
                  v{chosen.version_no} → now
                </div>
                <VersionDiff
                  // A restore rewrote the live bytes — remount so the diff's
                  // right-hand side is refetched, not the pre-restore text.
                  key={reload}
                  path={path}
                  name={name}
                  version={chosen}
                  size={size}
                  diffable={diffable}
                  pal={pal}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The chosen snapshot vs the live file, both fetched as text, diffed here. */
function VersionDiff({
  path,
  name,
  version,
  size,
  diffable,
  pal,
}: {
  path: string;
  name: string;
  version: FsVersion;
  size: number;
  diffable: boolean;
  pal: (typeof DIFF)[keyof typeof DIFF];
}) {
  const [pair, setPair] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooBig = tooBigToDiff(version.size_bytes, size);

  useEffect(() => {
    if (!diffable || tooBig) return;
    let live = true;
    setPair(null);
    setError(null);
    loadDiffPair(fetchText, diffUrls(api, path, version.version_no))
      .then((p) => live && setPair(p))
      .catch(() => live && setError("Couldn't load this version."));
    return () => {
      live = false;
    };
  }, [path, version.version_no, diffable, tooBig]);

  if (!diffable) {
    return (
      <p className="text-[12.5px] text-mut">
        No inline diff for this file type — download{" "}
        <a
          href={api.fsVersionUrl(path, version.version_no)}
          download={`${name}.v${version.version_no}`}
          className="underline hover:text-ink"
        >
          v{version.version_no}
        </a>{" "}
        to compare it yourself.
      </p>
    );
  }
  if (tooBig) {
    return (
      <p className="text-[12.5px] text-mut">
        Too large to diff in the browser — download{" "}
        <a
          href={api.fsVersionUrl(path, version.version_no)}
          download={`${name}.v${version.version_no}`}
          className="underline hover:text-ink"
        >
          v{version.version_no}
        </a>{" "}
        instead.
      </p>
    );
  }
  if (error) return <p className="text-[12.5px] text-mut">{error}</p>;
  if (pair === null) return <Spinner rows={3} />;
  if (pair.from === pair.to) {
    return <p className="text-[12.5px] text-dim italic">Identical to the file as it stands now.</p>;
  }
  return <LineDiff from={pair.from} to={pair.to} pal={pal} />;
}

/** Raw-bytes GET (the version/file routes serve bytes, never JSON). */
async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(String(r.status));
  return r.text();
}
