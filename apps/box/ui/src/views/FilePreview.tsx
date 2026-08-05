import { useEffect, useRef, useState } from "react";
import { Download, FileQuestion, Lock, LockOpen, Trash2, X } from "lucide-react";
import { api, errorMessage, type FsLock } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Markdown } from "../components/Markdown";
import { Spinner } from "../components/bits";
import { FileHistory } from "./FileHistory";
import { fmtDateTime } from "../lib/ui";
import { errText, loadLock, lockHolder, toggleLock } from "../lib/fsversions";

/**
 * Inline file preview panel. Renders the
 * common kinds a human wants to glance at without downloading — decided
 * ENTIRELY by extension, never by the server-reported mime (fs_entries.mime is
 * caller-controlled, so trusting it would let a file named .png but typed
 * text/html steer the renderer).
 *
 * Safety: text/markdown/csv/json/code are fetched as TEXT and rendered through
 * React text nodes or the hardened skipHtml <Markdown> — no code path ever
 * feeds file bytes to an iframe, dangerouslySetInnerHTML, or a script/style
 * context, so a hostile file body is inert. Images use <img src> (CSP img-src
 * 'self'; X-Content-Type-Options: nosniff means a mistyped image just fails to
 * paint, it can't become script). PDFs and everything else fall back to a
 * download card — framing PDF bytes same-origin would run a spoofed text/html
 * body, so we never do it.
 */

const TEXT_EXT = new Set([
  "txt",
  "md",
  "markdown",
  "log",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "csv",
  "tsv",
  "js",
  "ts",
  "tsx",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "sh",
  "bash",
  "zsh",
  "sql",
  "html",
  "css",
  "scss",
  "xml",
  "svg",
  "diff",
  "patch",
  "gitignore",
  "dockerfile",
  "makefile",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const CODE_EXT = new Set([
  "js",
  "ts",
  "tsx",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "sh",
  "bash",
  "zsh",
  "sql",
  "css",
  "scss",
  "xml",
  "html",
  "diff",
  "patch",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
]);
// Cap what we'll pull into the browser for a text preview; bigger files stay a
// download (the file itself can be up to 25MB).
const TEXT_PREVIEW_MAX = 512 * 1024;

function extOf(name: string): string {
  const base = name.toLowerCase();
  if (base === "dockerfile" || base === "makefile") return base;
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
}

type Kind = "image" | "markdown" | "csv" | "code" | "text" | "unsupported";

function kindOf(name: string): Kind {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (!TEXT_EXT.has(ext)) return "unsupported";
  return CODE_EXT.has(ext) ? "code" : "text";
}

/** Minimal RFC-4180-ish CSV split: quoted fields, doubled quotes, CR/LF. */
function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

export function FilePreview({
  path,
  name,
  size,
  onClose,
  onChanged,
  onLockChange,
}: {
  path: string;
  name: string;
  size: number;
  onClose: () => void;
  /** the file's bytes changed here (a restore) — the listing should reload. */
  onChanged?: () => void;
  /** this file's lock was read or flipped here — the row can show the same. */
  onLockChange?: (lock: FsLock) => void;
}) {
  const kind = kindOf(name);
  const url = api.fsFileUrl(path);
  const wantsText = kind === "markdown" || kind === "csv" || kind === "code" || kind === "text";
  const tooBig = wantsText && size > TEXT_PREVIEW_MAX;

  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imgBroke, setImgBroke] = useState(false);
  const [tab, setTab] = useState<"preview" | "history">("preview");
  const [lock, setLock] = useState<FsLock | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  // Bumped by a restore so the preview refetches the file it just changed.
  const [reload, setReload] = useState(0);
  /** Two-step trash, disarmed by a timer (blur fires between the clicks). */
  const [armTrash, setArmTrash] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  useEffect(() => {
    if (!armTrash) return;
    const t = window.setTimeout(() => setArmTrash(false), 4000);
    return () => window.clearTimeout(t);
  }, [armTrash]);

  useEffect(() => {
    if (!wantsText || tooBig) return;
    let live = true;
    setText(null);
    setError(null);
    fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => live && setText(t))
      .catch(() => live && setError("Couldn't load this file."));
    return () => {
      live = false;
    };
  }, [url, wantsText, tooBig, reload]);

  // Who (if anyone) holds this file's lock. A failure here is not fatal —
  // an unreadable lock reads as unlocked, and the store still refuses the
  // write with its teaching ELOCKED.
  const notifyLock = useRef(onLockChange);
  notifyLock.current = onLockChange;
  useEffect(() => {
    let live = true;
    setLock(null);
    void loadLock(api, path).then((l) => {
      if (!live) return;
      setLock(l);
      notifyLock.current?.(l);
    });
    return () => {
      live = false;
    };
  }, [path]);

  const lockedBy = lockHolder(lock);

  const flipLock = async () => {
    if (lockBusy) return;
    setLockBusy(true);
    setLockError(null);
    try {
      const next = await toggleLock(api, path, lock);
      setLock(next);
      onLockChange?.(next);
    } catch (e) {
      setLockError(errText(e, lockedBy === null ? "could not lock" : "could not unlock"));
    } finally {
      setLockBusy(false);
    }
  };

  return (
    <aside className="flex w-[clamp(320px,38vw,560px)] shrink-0 flex-col border-l border-line-soft">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-[550] text-ink">
          {name}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={lockedBy === null ? "Lock this file" : "Unlock this file"}
          aria-pressed={lockedBy !== null}
          title={
            lockedBy === null
              ? "Lock — agents and members can't change it until it's unlocked"
              : `Locked by ${lockedBy}${lock?.locked_at ? ` · ${fmtDateTime(lock.locked_at)}` : ""}`
          }
          disabled={lockBusy}
          className={lockedBy === null ? "text-dim hover:text-ink" : "text-ink"}
          onClick={() => void flipLock()}
        >
          {lockedBy === null ? <LockOpen aria-hidden /> : <Lock aria-hidden />}
        </Button>
        <a href={url} download={name} aria-label="Download" title="Download">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-dim hover:text-ink"
            render={<span />}
          >
            <Download aria-hidden />
          </Button>
        </a>
        {/* Move to trash. `rm` on this filesystem is a SOFT delete — the trash
            page lists it and `restore` brings it back — so this is the same
            recoverable gesture the object page offers, not a shredder.
            Two-step, and disarmed on a TIMER rather than on blur: blur fires
            when the button loses focus between the two clicks, which silently
            re-arms instead of firing. A locked file is refused server-side
            (ELOCKED); the button is hidden there rather than offering a door
            that never opens. */}
        {lockedBy === null && (
          <Button
            variant={armTrash ? "default" : "ghost"}
            size={armTrash ? "sm" : "icon-sm"}
            aria-label={armTrash ? "Confirm — move to trash" : "Move to trash"}
            className={armTrash ? "" : "text-dim hover:text-ink"}
            disabled={trashing}
            onClick={() => {
              if (!armTrash) {
                setArmTrash(true);
                return;
              }
              setTrashing(true);
              api
                .fsDelete(path)
                .then(() => {
                  setArmTrash(false);
                  onChanged?.();
                  onClose?.();
                })
                .catch((e: unknown) => setTrashError(errorMessage(e)))
                .finally(() => setTrashing(false));
            }}
          >
            <Trash2 aria-hidden />
            {armTrash && <span className="ml-1 text-[12px]">Confirm</span>}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close preview"
          className="text-dim hover:text-ink"
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
      </div>

      {/* Preview | History — one file, two ways to look at it. */}
      <div className="flex items-center gap-1 border-b border-line-soft px-3 py-1.5">
        {(["preview", "history"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`px-2 py-1 text-[12px] font-medium capitalize transition-colors ${
              tab === t ? "bg-[var(--muted)] text-ink" : "text-mut hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {lockedBy !== null && (
        <div className="flex items-center gap-1.5 border-b border-line-soft bg-hover px-4 py-2 text-[12px] text-mut">
          <Lock size={12} aria-hidden className="shrink-0 text-dim" />
          <span className="min-w-0 truncate">
            Locked by {lockedBy} — writes are refused (agents get{" "}
            <code className="font-mono text-[11.5px] text-ink/80">ELOCKED</code>).
          </span>
        </div>
      )}

      {trashError !== null && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[12px] text-destructive">
          Couldn't move it to trash: {trashError}
        </div>
      )}

      {lockError && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[12px] text-destructive">
          {lockError}
        </div>
      )}

      {tab === "history" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <FileHistory
            path={path}
            name={name}
            size={size}
            diffable={isTextish(name)}
            lockedBy={lockedBy}
            onRestored={() => {
              setReload((n) => n + 1);
              onChanged?.();
            }}
          />
        </div>
      )}

      <div className={`min-h-0 flex-1 overflow-auto ${tab === "preview" ? "" : "hidden"}`}>
        {kind === "image" &&
          (imgBroke ? (
            <PreviewFallback name={name} url={url}>
              This image couldn't be displayed.
            </PreviewFallback>
          ) : (
            <div className="flex min-h-full items-center justify-center bg-[var(--muted)] p-4">
              <img
                src={url}
                alt={name}
                onError={() => setImgBroke(true)}
                className="max-h-full max-w-full object-contain"
                style={{ imageRendering: "auto" }}
              />
            </div>
          ))}

        {kind === "unsupported" && (
          <PreviewFallback name={name} url={url}>
            No inline preview for this file type.
          </PreviewFallback>
        )}

        {wantsText && tooBig && (
          <PreviewFallback name={name} url={url}>
            This file is too large to preview here.
          </PreviewFallback>
        )}

        {wantsText && !tooBig && text === null && !error && <Spinner rows={6} />}
        {wantsText && error && <div className="p-6 text-[13px] text-mut">{error}</div>}

        {kind === "markdown" && text !== null && (
          <div className="px-5 py-4">
            <Markdown body={text} />
          </div>
        )}

        {kind === "csv" && text !== null && (
          <CsvTable text={text} delim={name.toLowerCase().endsWith(".tsv") ? "\t" : ","} />
        )}

        {(kind === "code" || kind === "text") && text !== null && (
          <pre className="overflow-x-auto px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre text-ink">
            {text}
          </pre>
        )}
      </div>
    </aside>
  );
}

function CsvTable({ text, delim }: { text: string; delim: string }) {
  const rows = parseCsv(text, delim);
  if (rows.length === 0) return <div className="p-6 text-[13px] text-mut">Empty file.</div>;
  const head = rows[0] ?? [];
  const body = rows.slice(1);
  const shown = body.slice(0, 500);
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className="sticky top-0 border-b border-line bg-card px-3 py-2 text-left font-semibold whitespace-nowrap text-dim"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, ri) => (
            <tr key={ri} className="border-b border-line-soft">
              {head.map((_, ci) => (
                <td key={ci} className="px-3 py-1.5 whitespace-nowrap text-ink/90">
                  {r[ci] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length && (
        <div className="px-3 py-2 text-[12px] text-dim">
          Showing first {shown.length} of {body.length} rows — download for the rest.
        </div>
      )}
    </div>
  );
}

function PreviewFallback({
  name,
  url,
  children,
}: {
  name: string;
  url: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileQuestion size={28} aria-hidden className="text-dim" />
      <p className="text-[13px] text-mut">{children}</p>
      <a href={url} download={name}>
        <Button variant="outline" size="sm" render={<span />}>
          <Download aria-hidden /> Download
        </Button>
      </a>
    </div>
  );
}

/** Extension-only test used by FilesView to decide if a row opens the panel. */
export function isPreviewable(name: string): boolean {
  return kindOf(name) !== "unsupported";
}

/** Extension-only test: this file's bytes read (and therefore diff) as text. */
function isTextish(name: string): boolean {
  const k = kindOf(name);
  return k === "markdown" || k === "csv" || k === "code" || k === "text";
}
