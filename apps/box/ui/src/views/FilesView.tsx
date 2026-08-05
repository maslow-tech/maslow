import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { api, ApiError, type FsEntry, type FsLock } from "../lib/api";
import { FilePreview, isPreviewable } from "./FilePreview";
import { FileTrash } from "./FileTrash";
import { Empty, PrivateBadge, Spinner } from "../components/bits";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDate, fmtDateTime } from "../lib/ui";
import {
  displayPath,
  errText,
  fmtBytes,
  isWritablePath,
  lockHolder,
  locksFromListing,
  toggleLock,
} from "../lib/fsversions";

/**
 * The file manager over the brain filesystem: the same
 * tree agents write through the bash tool, listed live from the cookie-authed
 * /api/v1/files routes. The root is virtual — **Shared** (/shared, everyone)
 * and **My files** (your private /home/<slug>; the raw slug path is never
 * shown). RLS on the server decides what each session can see; this view is
 * convenience, not the gate.
 *
 * Design note: the signature element is the PATH BAR — the current location
 * rendered as the literal mono path agents type in bash and records store in
 * properties, segment-clickable and copyable. Home paths render as `~`, which
 * is both the terminal idiom and how the raw slug stays hidden.
 *
 * LOCKS live here: this page is their ONLY surface —
 * lock/unlock is deliberately not an agent verb, so every row (file AND folder,
 * previewable or not) carries the toggle in its menu, and a locked row shows it
 * and greys its own edit actions. A folder lock protects its whole subtree, and
 * the store — not this view — is the boundary: it answers ELOCKED regardless.
 * The toggle is offered only where the store would ACCEPT it (isWritablePath):
 * the fixed roots /shared and /home/<you> are out of write scope by design, so
 * standing in one shows no lock button rather than a button that always fails.
 * Every row's lock arrives with the listing itself — one request per folder.
 */

const HEAD = "px-4 py-2.5 text-[11px] font-semibold tracking-[.07em] text-dim uppercase";

const join = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** File-kind icon by extension — machine data gets a machine-true glyph. */
function extIcon(name: string) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["xlsx", "xls", "csv", "tsv", "ods"].includes(ext)) return FileSpreadsheet;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return FileImage;
  if (["md", "txt", "pdf", "doc", "docx", "rtf"].includes(ext)) return FileText;
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return FileAudio;
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return FileVideo;
  if (["zip", "tar", "gz", "tgz", "bz2", "7z", "rar"].includes(ext)) return FileArchive;
  if (
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "sh",
      "sql",
      "json",
      "yaml",
      "yml",
      "toml",
      "html",
      "css",
    ].includes(ext)
  )
    return FileCode;
  return FileIcon;
}

interface Seg {
  /** shown text — `~` for the home root */
  label: string;
  path: string;
}

/** The path split into clickable segments; the home prefix collapses to `~`. */
function segsFor(path: string, home: string | null): Seg[] {
  if (path === "/") return [];
  let acc = "";
  let rest = path;
  const out: Seg[] = [];
  if (home !== null && (path === home || path.startsWith(`${home}/`))) {
    out.push({ label: "~", path: home });
    acc = home;
    rest = path.slice(home.length);
  }
  for (const seg of rest.split("/").filter(Boolean)) {
    acc += `/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

/** What the copy button yields — the real path agents use (slug included). */
const sortEntries = (entries: FsEntry[]): FsEntry[] =>
  [...entries].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
  );

export function FilesView() {
  const [params, setParams] = useSearchParams();
  const path = params.get("path") ?? "/";
  const previewName = params.get("preview");
  const atRoot = path === "/";
  // `?trash=1` swaps the listing for the recoverable-deletions view, scoped to
  // the folder you're standing in (the whole tree at the root).
  const inTrash = params.get("trash") === "1";

  const setPreview = (name: string | null) => {
    const next = new URLSearchParams(params);
    if (name) next.set("preview", name);
    else next.delete("preview");
    setParams(next);
  };
  const [home, setHome] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [usage, setUsage] = useState<{ total_bytes: number; quota_bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renaming, setRenaming] = useState<FsEntry | null>(null);
  const [deleting, setDeleting] = useState<FsEntry | null>(null);
  // Lock state per FULL PATH (files and folders alike) — it rides the listing
  // response, so a whole folder costs one request, not one per row.
  const [locks, setLocks] = useState<Record<string, FsLock>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  // The folder the rows on screen belong to. A reload IN PLACE (after a write)
  // keeps them mounted; only a move to a different folder blanks the table.
  const shownPath = useRef<string | null>(null);

  // Your home dir is the only child of /home your session can see (RLS) —
  // one list call discovers the "My files" destination.
  useEffect(() => {
    api
      .fsList("/home")
      .then((r) => setHome(r.entries[0] ? `/home/${r.entries[0].name}` : null))
      .catch(() => setHome(null));
  }, []);

  useEffect(() => {
    if (atRoot) {
      api
        .fsUsage()
        .then(setUsage)
        .catch(() => setUsage(null));
    }
  }, [atRoot]);

  const load = useCallback(() => {
    setError(null);
    // Blank the table ONLY when the folder changes. A reload in place (after an
    // upload, a rename, a restore from the History tab) would otherwise unmount
    // the preview panel for a render and bounce you back to its Preview tab.
    const moved = shownPath.current !== path;
    shownPath.current = path;
    if (moved) {
      setLocks({});
      if (path !== "/") setEntries(null);
    }
    if (path === "/") {
      setEntries([]);
      return;
    }
    api
      .fsList(path)
      .then((r) => {
        setEntries(sortEntries(r.entries));
        // Lock state for THIS folder (it governs everything beneath it) and for
        // every row, straight off the listing — so a locked file or folder LOOKS
        // locked before anyone opens its menu, at no extra request. A lock the
        // server didn't send just isn't shown; the store still refuses the write.
        setLocks(locksFromListing(path, r));
      })
      .catch((e: unknown) => {
        setEntries([]);
        setError(e instanceof ApiError ? e.message : "could not list this folder");
      });
  }, [path]);
  useEffect(load, [load]);

  /** Lock or unlock a row (file or folder). Refusals — "already locked by X",
   *  "only the person who locked it or an owner can unlock" — show verbatim. */
  const flipLock = async (p: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await toggleLock(api, p, locks[p] ?? null);
      setLocks((cur) => ({ ...cur, [p]: next }));
    } catch (e) {
      setError(errText(e, "could not change the lock"));
    } finally {
      setBusy(false);
    }
  };

  const open = (p: string) => setParams({ path: p });
  const openTrash = () => setParams(path === "/" ? { trash: "1" } : { path, trash: "1" });
  const closeTrash = () => setParams(path === "/" ? {} : { path });

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (f: File | undefined) => {
    if (!f) return;
    await run(() => api.fsUpload(path, f), "upload failed");
    if (fileInput.current) fileInput.current.value = "";
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    let lost: string[] = [];
    const ok = await run(async () => {
      const res = await api.fsDelete(join(path, deleting.name), deleting.kind === "dir");
      lost = res.unrecoverable ?? [];
    }, "delete failed");
    setDeleting(null);
    // A delete whose snapshots outgrew the version budget is a HARD delete.
    // The dialog closing on a green path would read as "it's in the trash" —
    // say the opposite, by name.
    if (ok && lost.length > 0) {
      setError(
        `deleted — but the version budget was exceeded, so these are NOT in the trash: ${lost.join(", ")}`,
      );
    }
  };

  const segs = segsFor(path, home);
  const inHome = home !== null && (path === home || path.startsWith(`${home}/`));
  // A lock on the folder you're standing in covers its whole subtree — so it
  // greys this folder's own write actions, not just its row in the parent.
  const folderHolder = lockHolder(locks[path]);
  // The two fixed roots (/shared and your home) are OUT of the store's write
  // scope on purpose — nobody may lock /shared and freeze the org's whole tree.
  // Both root cards land exactly there, so offering the toggle would put a
  // button that can only ever fail in the first folder anyone opens.
  const lockable = isWritablePath(path, home);

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line-soft px-8 pt-7 pb-5">
        <h1 className="text-[21px] font-[650] tracking-[-0.02em]">Files</h1>
        <p className="mt-1 text-[13.5px] text-mut">
          One tree, two kinds of hands — everything agents save through bash, next to everything
          your team uploads.
        </p>
      </header>

      {/* the trash bar: what a delete kept, and the way back out. */}
      {inTrash && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-8 py-2.5">
          <Button variant="outline" size="sm" onClick={closeTrash}>
            <ArrowLeft aria-hidden /> Back to files
          </Button>
          <span className="text-[13px] text-mut">
            Deleted files
            {path === "/" ? (
              " — everything you can see"
            ) : (
              <>
                {" under "}
                <code className="font-mono text-[12.5px] text-ink/80">
                  {displayPath(path, home)}
                </code>
              </>
            )}
            . Restoring puts a file back where it was, recreating the folders it lived in.
          </span>
        </div>
      )}

      {/* the path bar: the literal address agents use, segment-clickable.
          Hidden at root — the zone cards are the root's whole story. */}
      {!atRoot && !inTrash && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-8 py-2.5">
          <nav
            aria-label="Current folder"
            className="flex min-w-0 flex-1 items-center gap-0.5 font-mono text-[13px]"
          >
            <Link to="/files" className="px-0.5 text-dim hover:text-ink" aria-label="Files root">
              /
            </Link>
            {segs.map((s, i) => (
              <span key={s.path} className="flex min-w-0 items-center gap-0.5">
                {i > 0 && <span className="text-dim">/</span>}
                {i === segs.length - 1 ? (
                  <span className="min-w-0 truncate font-[550] text-ink">{s.label}</span>
                ) : (
                  <Link
                    to={`/files?path=${encodeURIComponent(s.path)}`}
                    className="min-w-0 truncate text-mut hover:text-ink hover:underline"
                  >
                    {s.label}
                  </Link>
                )}
              </span>
            ))}
            {!inHome && <CopyPath path={path} />}
          </nav>
          <div className="flex shrink-0 items-center gap-1.5">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(e) => void onUpload(e.target.files?.[0])}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy || folderHolder !== null}
              title={
                folderHolder !== null
                  ? `locked by ${folderHolder} — unlock this folder to add files`
                  : undefined
              }
              onClick={() => fileInput.current?.click()}
            >
              <Upload aria-hidden /> Upload
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || folderHolder !== null}
              title={
                folderHolder !== null
                  ? `locked by ${folderHolder} — unlock this folder to add to it`
                  : undefined
              }
              onClick={() => setNewFolderOpen(true)}
            >
              <FolderPlus aria-hidden /> New folder
            </Button>
            {/* This folder's own lock. Locking a folder protects everything
                beneath it — and the dashboard is the only place to set one.
                Absent at /shared and at your home root: the store refuses to
                lock a fixed root, so the button would only ever produce that
                refusal. Folders INSIDE them each carry their own. */}
            {lockable && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-pressed={folderHolder !== null}
                title={
                  folderHolder !== null
                    ? `Locked by ${folderHolder}${locks[path]?.locked_at ? ` · ${fmtDateTime(locks[path].locked_at)}` : ""}`
                    : "Lock this folder — nothing inside it changes until it's unlocked"
                }
                onClick={() => void flipLock(path)}
              >
                {folderHolder !== null ? (
                  <>
                    <LockOpen aria-hidden /> Unlock folder
                  </>
                ) : (
                  <>
                    <Lock aria-hidden /> Lock folder
                  </>
                )}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={openTrash}>
              <Trash2 aria-hidden /> Trash
            </Button>
          </div>
        </div>
      )}

      {/* Standing inside a locked folder: say so once, here, instead of letting
          every row's greyed-out menu explain it separately. */}
      {!atRoot && !inTrash && folderHolder !== null && (
        <div className="flex items-center gap-1.5 border-b border-line-soft bg-hover px-8 py-2 text-[12.5px] text-mut">
          <Lock size={12} aria-hidden className="shrink-0 text-dim" />
          <span className="min-w-0">
            Locked by {folderHolder} — nothing in this folder can be changed, by a member or an
            agent (agents get <code className="font-mono text-[11.5px] text-ink/80">ELOCKED</code>).
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto">
          {error && (
            <div className="mx-8 mt-4 max-w-[720px] rounded-none border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive">
              {error}
            </div>
          )}

          {inTrash && <FileTrash prefix={path} home={home} onRestored={load} />}

          {!inTrash && (
            <>
              {!entries && <Spinner />}

              {entries && atRoot && (
                <div className="max-w-[860px] px-8 py-6">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => open("/shared")}
                      className="group border border-line-soft bg-card px-5 py-4 text-left transition-colors hover:border-line"
                    >
                      <span className="flex items-center gap-2.5 font-[600] text-ink">
                        <Users size={15} aria-hidden className="text-dim" />
                        Shared
                      </span>
                      <span className="mt-1.5 block text-[13px] leading-relaxed text-mut">
                        Every member and every agent sees this tree. Deliverables live here —{" "}
                        <code className="font-mono text-[12px] text-ink/80">/shared</code> in bash.
                      </span>
                    </button>
                    {home && (
                      <button
                        type="button"
                        onClick={() => open(home)}
                        className="group border border-line-soft bg-card px-5 py-4 text-left transition-colors hover:border-line"
                      >
                        <span className="flex items-center gap-2.5 font-[600] text-ink">
                          <Lock size={14} aria-hidden className="text-dim" />
                          My files
                          <PrivateBadge visibility="private" />
                        </span>
                        <span className="mt-1.5 block text-[13px] leading-relaxed text-mut">
                          Only you — other members' views don't contain it. Your shell starts here
                          as <code className="font-mono text-[12px] text-ink/80">~</code>.
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={openTrash}
                      className="group border border-line-soft bg-card px-5 py-4 text-left transition-colors hover:border-line"
                    >
                      <span className="flex items-center gap-2.5 font-[600] text-ink">
                        <Trash2 size={15} aria-hidden className="text-dim" />
                        Trash
                      </span>
                      <span className="mt-1.5 block text-[13px] leading-relaxed text-mut">
                        Deleting a file keeps its bytes — restore anything from here, or ask an
                        agent:{" "}
                        <code className="font-mono text-[12px] text-ink/80">restore --list</code>.
                      </span>
                    </button>
                  </div>

                  {usage && usage.quota_bytes > 0 && (
                    <div className="mt-6">
                      <div className="flex items-baseline justify-between text-[12px]">
                        <span className="font-semibold tracking-[.07em] text-dim uppercase">
                          Storage
                        </span>
                        <span className="font-mono text-mut">
                          {fmtBytes(usage.total_bytes)} of {fmtBytes(usage.quota_bytes)}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1 w-full bg-line" role="presentation">
                        <div
                          className="h-1 bg-ink/70"
                          style={{
                            width: `${Math.max(0.5, Math.min(100, (usage.total_bytes / usage.quota_bytes) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {entries && !atRoot && entries.length === 0 && !error && (
                <div className="p-8">
                  <Empty>
                    <span className="block">Nothing here yet.</span>
                    <span className="mt-1 block text-[13px] text-dim">
                      Upload a file — or ask an agent:{" "}
                      <code className="font-mono text-[12.5px] text-ink/70">
                        “save the report under {displayPath(path, home)}”
                      </code>
                    </span>
                  </Empty>
                </div>
              )}

              {entries && !atRoot && entries.length > 0 && (
                <Table className="text-[13.5px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className={`${HEAD} pl-8`}>Name</TableHead>
                      <TableHead className={HEAD}>Size</TableHead>
                      <TableHead className={HEAD}>Modified</TableHead>
                      <TableHead className={HEAD}>Modified by</TableHead>
                      <TableHead className={`${HEAD} w-[52px] pr-8`} aria-label="Actions" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((e) => {
                      const Icon = e.kind === "dir" ? Folder : extIcon(e.name);
                      const selected = e.kind === "file" && e.name === previewName;
                      const full = join(path, e.name);
                      const holder = lockHolder(locks[full]);
                      const lockedAt = locks[full]?.locked_at ?? null;
                      // A lock on this row OR on the folder it sits in refuses
                      // the write (the store's subtree rule) — grey both.
                      const editHolder = holder ?? folderHolder;
                      return (
                        <TableRow
                          key={e.name}
                          className={`group ${selected ? "bg-[var(--muted)]" : ""}`}
                        >
                          <TableCell className="max-w-[440px] py-0 pr-4 pl-8">
                            <div className="flex min-w-0 items-center gap-2">
                              {e.kind === "dir" ? (
                                <button
                                  type="button"
                                  onClick={() => open(full)}
                                  className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-left font-[550] text-ink group-hover:underline"
                                >
                                  <Icon size={15} aria-hidden className="shrink-0 text-dim" />
                                  <span className="truncate">{e.name}</span>
                                </button>
                              ) : isPreviewable(e.name) ? (
                                <button
                                  type="button"
                                  onClick={() => setPreview(e.name)}
                                  className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-left font-[550] text-ink group-hover:underline"
                                >
                                  <Icon size={15} aria-hidden className="shrink-0 text-dim" />
                                  <span className="truncate">{e.name}</span>
                                </button>
                              ) : (
                                <a
                                  href={api.fsFileUrl(full)}
                                  download={e.name}
                                  className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 font-[550] text-ink group-hover:underline"
                                >
                                  <Icon size={15} aria-hidden className="shrink-0 text-dim" />
                                  <span className="truncate">{e.name}</span>
                                </a>
                              )}
                              {holder !== null && (
                                <span
                                  title={`Locked by ${holder}${lockedAt ? ` · ${fmtDateTime(lockedAt)}` : ""} — ${
                                    e.kind === "dir"
                                      ? "nothing inside it can be changed"
                                      : "it can't be changed"
                                  } until it's unlocked`}
                                  className="flex shrink-0 items-center gap-1 text-[11.5px] text-dim"
                                >
                                  <Lock size={12} aria-hidden />
                                  <span className="sr-only">Locked by {holder}</span>
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="px-4 py-2.5 font-mono text-[12.5px] whitespace-nowrap text-mut">
                            {e.kind === "dir" ? "—" : fmtBytes(e.size)}
                          </TableCell>
                          <TableCell className="px-4 py-2.5 whitespace-nowrap text-dim">
                            {fmtDate(e.mtime)}
                          </TableCell>
                          <TableCell className="px-4 py-2.5 text-mut">
                            {e.updated_by ?? "—"}
                          </TableCell>
                          <TableCell className="py-1.5 pr-8 pl-4 text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Actions for ${e.name}`}
                                    className="text-dim hover:text-ink"
                                  >
                                    <MoreHorizontal aria-hidden />
                                  </Button>
                                }
                              />
                              <DropdownMenuContent align="end">
                                {e.kind === "file" && (
                                  <DropdownMenuItem
                                    onClick={() => {
                                      window.location.assign(api.fsFileUrl(full));
                                    }}
                                  >
                                    <Download aria-hidden /> Download
                                  </DropdownMenuItem>
                                )}
                                {!inHome && (
                                  <DropdownMenuItem
                                    onClick={() => {
                                      void navigator.clipboard.writeText(full);
                                    }}
                                  >
                                    <Copy aria-hidden /> Copy path
                                  </DropdownMenuItem>
                                )}
                                {/* The dashboard is the ONLY place a lock can be
                                    set — folders included, where the lock covers
                                    everything beneath it. Rows the store keeps
                                    out of write scope (a home root listed under
                                    /home) don't get the offer. */}
                                {isWritablePath(full, home) && (
                                  <DropdownMenuItem
                                    disabled={busy}
                                    onClick={() => void flipLock(full)}
                                  >
                                    {holder === null ? (
                                      <>
                                        <Lock aria-hidden />{" "}
                                        {e.kind === "dir" ? "Lock folder" : "Lock"}
                                      </>
                                    ) : (
                                      <>
                                        <LockOpen aria-hidden /> Unlock
                                      </>
                                    )}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  disabled={editHolder !== null}
                                  onClick={() => setRenaming(e)}
                                >
                                  <Pencil aria-hidden /> Rename
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={editHolder !== null}
                                  onClick={() => setDeleting(e)}
                                >
                                  <Trash2 aria-hidden /> Delete
                                </DropdownMenuItem>
                                {editHolder !== null && (
                                  <div className="max-w-[220px] px-2 pt-1 pb-2 text-[11.5px] leading-snug text-dim">
                                    {holder !== null
                                      ? `Locked by ${holder} — unlock it to rename or delete.`
                                      : `This folder is locked by ${editHolder} — unlock the folder to change anything inside.`}
                                  </div>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </div>
        {(() => {
          const sel =
            !atRoot && !inTrash && previewName
              ? (entries ?? []).find((e) => e.kind === "file" && e.name === previewName)
              : undefined;
          return sel ? (
            <FilePreview
              key={join(path, sel.name)}
              path={join(path, sel.name)}
              name={sel.name}
              size={sel.size}
              onClose={() => setPreview(null)}
              onChanged={load}
              onLockChange={(l) => setLocks((cur) => ({ ...cur, [join(path, sel.name)]: l }))}
            />
          ) : null;
        })()}
      </div>

      <NewFolderDialog
        open={newFolderOpen}
        busy={busy}
        onClose={() => setNewFolderOpen(false)}
        onCreate={async (name) => {
          if (await run(() => api.fsMkdir(join(path, name)), "could not create the folder")) {
            setNewFolderOpen(false);
          }
        }}
      />

      <RenameDialog
        entry={renaming}
        busy={busy}
        onClose={() => setRenaming(null)}
        onRename={async (to) => {
          if (
            renaming &&
            (await run(
              () => api.fsRename(join(path, renaming.name), join(path, to)),
              "rename failed",
            ))
          ) {
            setRenaming(null);
          }
        }}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.kind === "dir"
                ? "The folder and everything inside it goes away — every file inside stays in Trash, and restoring one puts it back at its old path, recreating the folders it lived in."
                : "The file moves to Trash — you can restore it from there, back at this same path."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {busy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Copy the current folder's real path — the contract string for records. */
function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label="Copy path"
      title="Copy path"
      className="ml-1.5 text-dim hover:text-ink"
      onClick={() => {
        void navigator.clipboard.writeText(path).then(() => setCopied(true));
      }}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

function NewFolderDialog({
  open,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() !== "") void onCreate(name.trim());
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>An empty folder persists — agents see it too.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="folder name"
            autoFocus
            required
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  entry,
  busy,
  onClose,
  onRename,
}: {
  entry: FsEntry | null;
  busy: boolean;
  onClose: () => void;
  onRename: (to: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (entry) setName(entry.name);
  }, [entry]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const to = name.trim();
    if (to !== "" && to !== entry?.name) void onRename(to);
  };

  return (
    <Dialog open={entry !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {entry?.name}</DialogTitle>
          <DialogDescription>
            Records may reference this path — links saved in record properties won't follow the
            rename.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="new name"
            autoFocus
            required
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || name.trim() === "" || name.trim() === entry?.name}
            >
              {busy ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
