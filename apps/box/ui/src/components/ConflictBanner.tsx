/**
 * The banner that appears when a save could not simply land.
 *
 * Three causes, deliberately one component: the human question is the same
 * every time — "there are two versions of this text, which one wins?" — and the
 * answer must never be given by the machine. Nothing here auto-merges.
 *
 *  - `conflict`  someone else changed a field WE changed (or the queue ran out
 *    of rebases). We keep the local draft and ask: keep mine / take theirs.
 *  - `recovery`  a local draft mirror survived a crash or tab close but was
 *    typed against an older version, so `applicability` refused to reapply it
 *    blind. Same question, different words: restore it / discard it.
 *  - `locked`    a 409 carrying `{ reason }` (phase 2's `open_in_editor`): the
 *    live room owns the field, so there is nothing to diff and nothing to
 *    retry. Distinct message, distinct affordance — no keep/take buttons.
 *
 * The diff is the existing `lib/diff.ts` — the same LCS the history dialog
 * uses, so "view diff" reads identically everywhere in the app.
 */
import { useMemo, useState } from "react";
import { diffTokens, lineTokens, unchanged, wordTokens } from "../lib/diff";
import { useTheme } from "../lib/theme";
import { fmtRelative } from "../lib/ui";
import { Button } from "./ui/button";

/** Diff palette — same values as HistoryDialog, tuned per skin. */
const DIFF = {
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

type Palette = (typeof DIFF)[keyof typeof DIFF];

export interface BannerSnapshot {
  title: string | null;
  body: string | null;
  props: Record<string, unknown>;
}

interface ConflictBannerProps {
  variant: "conflict" | "recovery" | "locked";
  /** who produced the version that beat us, when we know */
  actorName?: string | null;
  /** ISO timestamp of their write (conflict) or of the draft (recovery) */
  when?: string | null;
  /** the 409's `reason`, for `locked` */
  reason?: string | null;
  /** field paths the queue was carrying, e.g. ["body", "props.stage"] */
  fields?: string[];
  /** what the server holds (conflict) / what is on screen now (recovery) */
  theirs?: BannerSnapshot | null;
  /** what we have locally (conflict) / the recovered draft (recovery) */
  mine?: BannerSnapshot | null;
  /** conflict: resend my values. recovery: restore the draft. */
  onKeepMine?: () => void;
  /** conflict: drop my values for the server's. recovery: discard the draft. */
  onTakeTheirs?: () => void;
  onDismiss?: () => void;
}

const COPY = {
  conflict: {
    keep: "Keep mine",
    take: "Take theirs",
    diffFrom: "theirs",
    diffTo: "mine",
  },
  recovery: {
    keep: "Restore draft",
    take: "Discard draft",
    diffFrom: "current",
    diffTo: "your draft",
  },
} as const;

export function ConflictBanner({
  variant,
  actorName,
  when,
  reason,
  fields,
  theirs,
  mine,
  onKeepMine,
  onTakeTheirs,
  onDismiss,
}: ConflictBannerProps) {
  const { theme } = useTheme();
  const pal = DIFF[theme === "light" ? "light" : "dark"];
  const [showDiff, setShowDiff] = useState(false);

  if (variant === "locked") {
    return (
      <Frame tone="locked" assertive>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug">
            {reason === "open_in_editor"
              ? "This object is open in the live editor, which owns the text right now — your change was not written."
              : `The server refused this write (${reason ?? "no reason given"}).`}
          </p>
          <p className="mt-0.5 text-[11.5px] text-dim">
            {reason === "open_in_editor"
              ? "Edit it in the editor session instead; nothing you typed here has been lost."
              : "Nothing you typed here has been lost."}
            {fields && fields.length > 0 ? ` · ${fields.join(", ")}` : ""}
          </p>
        </div>
        {onDismiss && (
          <Button size="sm" variant="outline" className="touch-target" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </Frame>
    );
  }

  const copy = COPY[variant];
  const headline =
    variant === "conflict"
      ? `Updated by ${actorName ?? "someone else"} ${fmtRelative(when)} — your version is still here.`
      : `You have unsaved edits from ${fmtRelative(when)}, typed against an older version.`;
  const sub =
    variant === "conflict"
      ? "Nothing was merged and nothing was overwritten. Pick which version wins."
      : "It was not reapplied automatically because this object changed since. Compare, then choose.";

  return (
    <Frame tone="conflict" assertive={variant === "conflict"}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-[13px] leading-snug font-medium">{headline}</p>
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            className="touch-target inline-flex cursor-pointer items-center text-[11.5px] font-medium text-mut underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            {showDiff ? "hide diff" : "view diff"}
          </button>
        </div>
        <p className="mt-0.5 text-[11.5px] text-dim">
          {sub}
          {fields && fields.length > 0 ? ` · ${fields.join(", ")}` : ""}
        </p>

        {showDiff && (
          <div className="mt-3 flex flex-col gap-2">
            <p className="font-mono text-[10.5px] tracking-wide text-dim uppercase">
              {copy.diffFrom} → {copy.diffTo}
            </p>
            <SnapshotDiff from={theirs ?? null} to={mine ?? null} pal={pal} />
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {onKeepMine && (
            <Button size="sm" className="touch-target" onClick={onKeepMine}>
              {copy.keep}
            </Button>
          )}
          {onTakeTheirs && (
            <Button size="sm" variant="outline" className="touch-target" onClick={onTakeTheirs}>
              {copy.take}
            </Button>
          )}
        </div>
      </div>
    </Frame>
  );
}

function Frame({
  tone,
  assertive,
  children,
}: {
  tone: "conflict" | "locked";
  /** A save-failure / lost-work message (conflict, locked) must interrupt: the
   *  user is likely still typing into an editor that is no longer saving, so a
   *  queued `polite` announcement can go unheard. The passive recovery offer
   *  stays polite. `role="alert"` carries an implicit `aria-live="assertive"`. */
  assertive: boolean;
  children: React.ReactNode;
}) {
  const skin =
    tone === "conflict" ? "border-warn/40 bg-warn/10" : "border-line-soft bg-hover text-ink";
  return (
    <div
      role={assertive ? "alert" : "status"}
      className={`mb-5 flex items-start gap-3 rounded-none border px-3.5 py-3 ${skin}`}
    >
      {children}
    </div>
  );
}

/** Title (word diff) + body (line diff) + changed scalar props, only where they
 *  actually differ — an unchanged field is noise in a "which one wins" moment. */
function SnapshotDiff({
  from,
  to,
  pal,
}: {
  from: BannerSnapshot | null;
  to: BannerSnapshot | null;
  pal: Palette;
}) {
  const titleChanged = !unchanged(from?.title ?? null, to?.title ?? null);
  const bodyChanged = !unchanged(from?.body ?? null, to?.body ?? null);
  const propRows = useMemo(() => changedProps(from?.props, to?.props), [from, to]);

  if (!titleChanged && !bodyChanged && propRows.length === 0) {
    return <p className="text-[12px] text-dim italic">No visible difference.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {titleChanged && (
        <Block label="Title">
          <WordDiff from={from?.title ?? ""} to={to?.title ?? ""} pal={pal} />
        </Block>
      )}
      {bodyChanged && (
        <Block label="Body">
          <LineDiff from={from?.body ?? ""} to={to?.body ?? ""} pal={pal} />
        </Block>
      )}
      {propRows.length > 0 && (
        <Block label="Properties">
          <dl className="flex flex-col gap-1.5 font-mono text-[12px]">
            {propRows.map((r) => (
              <div key={r.key} className="flex items-baseline gap-2">
                <dt className="text-dim">{r.key}</dt>
                <dd className="min-w-0 break-words">
                  <span
                    className="rounded-[2px] px-0.5 line-through"
                    style={{ background: pal.delBg, color: pal.delFg }}
                  >
                    {fmtValue(r.from)}
                  </span>{" "}
                  <span
                    className="rounded-[2px] px-0.5"
                    style={{ background: pal.addBg, color: pal.addFg }}
                  >
                    {fmtValue(r.to)}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </Block>
      )}
    </div>
  );
}

interface PropDiffRow {
  key: string;
  from: unknown;
  to: unknown;
}

/** Every key present on either side whose value differs. Absent and null are
 *  the same absence (a `null` in a patch DELETES the key). */
export function changedProps(
  from: Record<string, unknown> | undefined,
  to: Record<string, unknown> | undefined,
): PropDiffRow[] {
  const keys = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})]);
  const rows: PropDiffRow[] = [];
  for (const key of [...keys].sort()) {
    const a = from?.[key] ?? null;
    const b = to?.[key] ?? null;
    if (sameValue(a, b)) continue;
    rows.push({ key, from: a, to: b });
  }
  return rows;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-none border border-line-soft bg-panel">
      <div className="border-b border-line-soft px-3 py-1.5 font-mono text-[10.5px] tracking-wide text-dim uppercase">
        {label}
      </div>
      <div className="max-h-[240px] overflow-auto px-3 py-2.5">{children}</div>
    </div>
  );
}

function WordDiff({ from, to, pal }: { from: string; to: string; pal: Palette }) {
  const ops = useMemo(() => diffTokens(wordTokens(from), wordTokens(to)), [from, to]);
  return (
    <span className="text-[12.5px]">
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
    </span>
  );
}

function LineDiff({ from, to, pal }: { from: string; to: string; pal: Palette }) {
  const ops = useMemo(() => diffTokens(lineTokens(from), lineTokens(to)), [from, to]);
  return (
    <div className="flex flex-col overflow-x-auto font-mono text-[12px] leading-relaxed">
      {ops.map((op, i) => {
        if (op.kind === "same") {
          return (
            <div key={i} className="flex gap-2 px-2 py-0.5 whitespace-pre-wrap text-mut">
              <span aria-hidden className="w-3 shrink-0 text-center opacity-70 select-none">
                {" "}
              </span>
              <span className="min-w-0 break-words">{op.value === "" ? " " : op.value}</span>
            </div>
          );
        }
        const style =
          op.kind === "add"
            ? { background: pal.addBg, color: pal.addFg }
            : { background: pal.delBg, color: pal.delFg };
        return (
          <div key={i} className="flex gap-2 px-2 py-0.5 whitespace-pre-wrap" style={style}>
            <span aria-hidden className="w-3 shrink-0 text-center opacity-70 select-none">
              {op.kind === "add" ? "+" : "−"}
            </span>
            <span className="min-w-0 break-words">{op.value === "" ? " " : op.value}</span>
          </div>
        );
      })}
    </div>
  );
}
