import { useMemo } from "react";
import type { History } from "../lib/api";
import { fmtDateTime } from "../lib/ui";
import { useTheme } from "../lib/theme";
import { diffTokens, lineTokens, unchanged, wordTokens, type DiffOp } from "../lib/diff";
import { propsChangesByVersion, reasonForVersion, type PropChange } from "../lib/provenance";
import { Dialog, DialogContent } from "@/components/ui/dialog";

/** Diff palette — greens for added, reds for removed — tuned per skin to match
 *  the app's semantic hues (same values as the type/enum tints). Exported with
 *  <LineDiff> so the file-version history renders the SAME diff, one engine. */
export const DIFF = {
  light: {
    addFg: "#047857",
    addBg: "rgba(5,150,105,0.10)",
    delFg: "#be123c",
    delBg: "rgba(225,29,72,0.09)",
  },
  dark: {
    addFg: "#34d399",
    addBg: "rgba(52,211,153,0.13)",
    delFg: "#fb7185",
    delBg: "rgba(251,113,133,0.13)",
  },
} as const;

type Snap = { title: string | null; body: string | null };
type Palette = (typeof DIFF)[keyof typeof DIFF];

const CONTEXT = 2; // unchanged body lines kept around each change

/**
 * The rich edit-history overlay: the object's version-by-version timeline,
 * newest first, each version showing who/when and a before→after word/line
 * diff of its title and body. "Scroll back" through how the object grew.
 */
type EntryKind = "create" | "update" | "delete" | "restore";

interface Entry {
  version: number; // the version this entry's edit produced
  kind: EntryKind;
  at: string;
  actorName: string | null;
  reason: string | null;
  before: Snap;
  after: Snap;
  propChange: { changes: PropChange[] } | undefined;
}

const ENTRY_LABEL: Record<EntryKind, string> = {
  create: "created this object",
  update: "edited it",
  delete: "deleted it",
  restore: "restored it",
};

export function HistoryDialog({
  open,
  onOpenChange,
  history,
  title,
  currentTitle,
  currentBody,
  refPropKeys,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  history: History;
  title: string;
  currentTitle: string | null;
  currentBody: string | null;
  /** ref-kind property names — shown as Links elsewhere, not raw UUIDs here. */
  refPropKeys: ReadonlySet<string>;
}) {
  const { theme } = useTheme();
  const pal = DIFF[theme === "light" ? "light" : "dark"];

  const propsByVersion = useMemo(() => propsChangesByVersion(history.events), [history.events]);

  // Newest first. One entry per version-producing create/update/delete/restore
  // EVENT, not per before_image row — a props-only edit (or a delete/restore,
  // which never touches title/body/props at all) still bumps the version and
  // fires one of these event kinds, but never writes a before_image row, so
  // deriving entries from rows alone silently drops it from the timeline.
  // contentAt(v) walks forward to the first recorded row at-or-after v (a
  // before_image row's own .version is exactly the content that was TRUE at
  // that version); falling through to `current` once nothing more was
  // recorded — correct because content only changes where a row exists.
  const entries = useMemo<Entry[]>(() => {
    const sortedRows = [...history.versions]
      .map((v) => ({ ...v, version: Number(v.version) }))
      .sort((a, b) => a.version - b.version);
    const current: Snap = { title: currentTitle, body: currentBody };
    const contentAt = (v: number): Snap =>
      sortedRows.find((r) => r.version >= v)?.snapshot ?? current;

    const versionEvents = history.events
      .filter(
        (e): e is typeof e & { kind: EntryKind } =>
          (e.kind === "create" ||
            e.kind === "update" ||
            e.kind === "delete" ||
            e.kind === "restore") &&
          typeof e.payload?.["version"] === "number",
      )
      .map((e) => ({ e, version: e.payload!["version"] as number }))
      .sort((a, b) => a.version - b.version);

    const list: Entry[] = versionEvents.map(({ e, version }) => {
      const attr = reasonForVersion(version, history.events);
      const rawPropChange = propsByVersion.get(version);
      const visibleChanges = rawPropChange?.changes.filter((c) => !refPropKeys.has(c.key));
      return {
        version,
        kind: e.kind,
        at: e.at,
        actorName: attr?.actorName ?? e.actor_name ?? e.actor,
        reason: attr?.reason ?? null,
        before: version === 1 ? { title: null, body: null } : contentAt(version - 1),
        after: contentAt(version),
        propChange:
          visibleChanges && visibleChanges.length > 0 ? { changes: visibleChanges } : undefined,
      };
    });
    return list.reverse();
  }, [history.versions, history.events, propsByVersion, currentTitle, currentBody, refPropKeys]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <div className="border-b border-line-soft px-5 py-4">
          <div className="text-[11px] font-semibold tracking-[.08em] text-dim uppercase">
            Edit history
          </div>
          <h2 className="mt-1 truncate pr-8 text-[16px] font-[650] tracking-[-0.01em] text-ink">
            {title}
          </h2>
          <div className="mt-1 text-[12px] text-mut">
            {entries.length} edit{entries.length === 1 ? "" : "s"} · {history.events.length} event
            {history.events.length === 1 ? "" : "s"}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {entries.length === 0 ? (
            <div className="rounded-none border border-line-soft bg-hover px-4 py-8 text-center text-[13px] text-mut">
              No version snapshots are recorded for this object yet.
            </div>
          ) : (
            <ol className="flex flex-col">
              {entries.map((e) => {
                const titleChanged = !unchanged(e.before.title, e.after.title);
                const bodyChanged = !unchanged(e.before.body, e.after.body);
                return (
                  <li key={e.version} className="relative flex gap-4 pb-6 last:pb-0">
                    {/* rail */}
                    <div className="flex flex-col items-center">
                      <span
                        aria-hidden
                        className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-[10px] font-semibold"
                        style={{
                          background:
                            e.kind === "create"
                              ? pal.addBg
                              : e.kind === "delete"
                                ? pal.delBg
                                : "var(--hover-strong)",
                          color:
                            e.kind === "create"
                              ? pal.addFg
                              : e.kind === "delete"
                                ? pal.delFg
                                : "var(--mut)",
                        }}
                      >
                        v{e.version}
                      </span>
                      <span aria-hidden className="mt-1 w-px flex-1 bg-line-soft" />
                    </div>

                    {/* content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[13px] font-medium text-ink">
                          {e.actorName ?? "someone"}
                        </span>
                        <span className="text-[12px] text-mut">{ENTRY_LABEL[e.kind]}</span>
                        <span className="text-[11px] text-dim">{fmtDateTime(e.at)}</span>
                      </div>
                      {e.reason && <p className="mt-1 text-[12px] text-mut italic">"{e.reason}"</p>}

                      {!titleChanged && !bodyChanged && !e.propChange ? (
                        <p className="mt-2 text-[12.5px] text-dim italic">
                          No change to title or body.
                        </p>
                      ) : (
                        <div className="mt-2.5 flex flex-col gap-2.5">
                          {titleChanged && (
                            <DiffBlock label="Title">
                              <p className="text-[13.5px] leading-relaxed break-words">
                                <WordDiff
                                  from={e.before.title ?? ""}
                                  to={e.after.title ?? ""}
                                  pal={pal}
                                />
                              </p>
                            </DiffBlock>
                          )}
                          {bodyChanged && (
                            <DiffBlock label="Body">
                              <LineDiff
                                from={e.before.body ?? ""}
                                to={e.after.body ?? ""}
                                pal={pal}
                              />
                            </DiffBlock>
                          )}
                          {e.propChange && (
                            <DiffBlock label="Properties">
                              <PropsDiff changes={e.propChange.changes} pal={pal} />
                            </DiffBlock>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DiffBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-none border border-line-soft bg-panel">
      <div className="border-b border-line-soft px-3 py-1.5 font-mono text-[10.5px] tracking-wide text-dim uppercase">
        {label}
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </div>
  );
}

/** Inline word-level diff, for titles. */
function WordDiff({ from, to, pal }: { from: string; to: string; pal: Palette }) {
  const ops = useMemo(() => diffTokens(wordTokens(from), wordTokens(to)), [from, to]);
  return (
    <>
      {ops.map((op, i) => {
        if (op.kind === "same") return <span key={i}>{op.value}</span>;
        const style =
          op.kind === "add"
            ? { background: pal.addBg, color: pal.addFg }
            : {
                background: pal.delBg,
                color: pal.delFg,
                textDecoration: "line-through" as const,
              };
        return (
          <span key={i} className="rounded-[2px] px-0.5" style={style}>
            {op.value}
          </span>
        );
      })}
    </>
  );
}

/** Old → new for each changed property in one edit (from update_props events). */
function PropsDiff({ changes, pal }: { changes: PropChange[]; pal: Palette }) {
  return (
    <dl className="flex flex-col gap-1.5 font-mono text-[12px]">
      {changes.map((c) => (
        <div key={c.key} className="flex items-baseline gap-2">
          <dt className="text-dim">{c.key}</dt>
          <dd className="min-w-0 break-words">
            <span
              className="rounded-[2px] px-0.5 line-through"
              style={{ background: pal.delBg, color: pal.delFg }}
            >
              {fmtPropValue(c.old)}
            </span>{" "}
            <span
              className="rounded-[2px] px-0.5"
              style={{ background: pal.addBg, color: pal.addFg }}
            >
              {fmtPropValue(c.new)}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function fmtPropValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return String(v);
}

/** Line-level diff, for bodies — unified style, unchanged runs collapsed.
 *  Also the file-history diff (a file body is the same kind of text). */
export function LineDiff({ from, to, pal }: { from: string; to: string; pal: Palette }) {
  const rows = useMemo(() => collapse(diffTokens(lineTokens(from), lineTokens(to))), [from, to]);
  return (
    <div className="flex flex-col overflow-x-auto font-mono text-[12px] leading-relaxed">
      {rows.map((row, i) => {
        if (row.kind === "gap") {
          return (
            <div key={i} className="px-2 py-1 text-[11px] text-dim italic select-none">
              ⋯ {row.count} unchanged line{row.count === 1 ? "" : "s"}
            </div>
          );
        }
        const marker = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
        const style =
          row.kind === "add"
            ? { background: pal.addBg, color: pal.addFg }
            : row.kind === "del"
              ? { background: pal.delBg, color: pal.delFg }
              : undefined;
        return (
          <div
            key={i}
            className={`flex gap-2 px-2 py-0.5 whitespace-pre-wrap ${row.kind === "same" ? "text-mut" : ""}`}
            style={style}
          >
            <span aria-hidden className="w-3 shrink-0 text-center opacity-70 select-none">
              {marker}
            </span>
            <span className="min-w-0 break-words">{row.value === "" ? " " : row.value}</span>
          </div>
        );
      })}
    </div>
  );
}

type Row = { kind: "same" | "add" | "del"; value: string } | { kind: "gap"; count: number };

/** Keep every add/del, plus CONTEXT unchanged lines around them; fold the rest
 *  into a single "N unchanged lines" gap so long bodies stay readable. */
function collapse(ops: DiffOp[]): Row[] {
  const keep = ops.map((op) => op.kind !== "same");
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === "same") continue;
    for (let d = 1; d <= CONTEXT; d++) {
      if (i - d >= 0) keep[i - d] = true;
      if (i + d < ops.length) keep[i + d] = true;
    }
  }
  const rows: Row[] = [];
  let gap = 0;
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) {
      if (gap > 0) {
        rows.push({ kind: "gap", count: gap });
        gap = 0;
      }
      rows.push({ kind: ops[i]!.kind, value: ops[i]!.value });
    } else {
      gap++;
    }
  }
  if (gap > 0) rows.push({ kind: "gap", count: gap });
  return rows;
}
