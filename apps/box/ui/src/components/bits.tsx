import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { Link } from "react-router";
import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Edge } from "../lib/api";
import { useIsMobile } from "../lib/mobile";
import {
  enumTint,
  subscribeTypeIcons,
  typeHue,
  typeIcon,
  typeIconEpochSnapshot,
  typeName,
} from "../lib/ui";
import { useTheme } from "../lib/theme";

/** Colored dot that encodes an object type in both skins. */
export function TypeDot({ type, size = 7 }: { type: string | null | undefined; size?: number }) {
  const { theme } = useTheme();
  return (
    <span
      aria-hidden
      className="type-icon inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: typeHue(type, theme) }}
    />
  );
}

/**
 * A type's emoji, everywhere a type is shown. Prefers the explicit `icon`,
 * else the icon registered for `type`, else the colored TypeDot. Never throws
 * on an undefined/empty icon. `size` is the emoji font size in px; the dot
 * fallback scales to match the old dot footprint.
 */
export function TypeIcon({
  icon,
  type,
  size = 14,
  label,
  className = "",
}: {
  icon?: string | null | undefined;
  type?: string | null | undefined;
  size?: number;
  /** Give the glyph a name when it is the ONLY thing identifying the row (a
   *  collapsed sidebar, an icon-only chip). Left off, it stays decorative and
   *  a screen reader skips it — which is right wherever the type name is
   *  already written next to it. */
  label?: string;
  className?: string;
}) {
  // Subscribe so a late-arriving icon (types fetched after we painted) shows up.
  useSyncExternalStore(subscribeTypeIcons, typeIconEpochSnapshot, typeIconEpochSnapshot);
  const glyph = (icon && icon.trim()) || typeIcon(type) || "";
  // `.type-icon` is the shared hover affordance: inside a `.group` row the
  // glyph nudges on hover (index.css), and the scale token is 1 under reduced
  // motion, so this costs nothing to opt into.
  const cls = `type-icon inline-flex shrink-0 items-center justify-center select-none ${className}`;
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true };
  if (glyph) {
    return (
      <span
        {...a11y}
        className={cls}
        style={{ width: size, height: size, fontSize: size, lineHeight: 1 }}
      >
        {glyph}
      </span>
    );
  }
  return <TypeDot type={type} size={Math.max(5, Math.round(size * 0.5))} />;
}

export function TypePill({
  type,
  icon,
}: {
  type: string | null | undefined;
  icon?: string | null | undefined;
}) {
  const { theme } = useTheme();
  const hue = typeHue(type, theme);
  return (
    <Badge
      variant="outline"
      className="rounded-full text-[11px]"
      style={{ borderColor: `${hue}44`, color: hue, background: `${hue}14` }}
    >
      <TypeIcon icon={icon} type={type} size={11} />
      {type ? typeName(type) : "untyped"}
    </Badge>
  );
}

export function EnumPill({ value }: { value: string }) {
  const { theme } = useTheme();
  const tint = enumTint(value, theme);
  return (
    <Badge
      variant="secondary"
      className="rounded-full border-0 text-[11px]"
      style={{ color: tint, background: `${tint}1a` }}
    >
      {value}
    </Badge>
  );
}

/** `shared` flips the label for a restricted object whose audience extends
 *  beyond its governor — "private" next to group chips read as a
 *  contradiction. Still the lock: it is restricted either way. */
export function PrivateBadge({
  visibility,
  shared = false,
}: {
  visibility: string | null | undefined;
  shared?: boolean;
}) {
  if (visibility !== "private") return null;
  return (
    <Badge variant="secondary" className="rounded-full text-[11px] text-mut">
      <Lock aria-hidden />
      {shared ? "shared" : "private"}
    </Badge>
  );
}

/** A linked object reference: dot + title, the atom of the whole dashboard. */
export function ObjectChip({
  id,
  title,
  type,
  deleted,
}: {
  id: string;
  title: string | null;
  type: string | null;
  deleted?: boolean;
}) {
  return (
    <Link
      to={`/o/${id}`}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-none border border-line-soft bg-hover px-2 py-1 text-[13px] leading-tight transition-colors hover:border-line hover:bg-hover-strong ${
        deleted ? "line-through opacity-50" : ""
      }`}
    >
      <TypeDot type={type} size={6} />
      <span className="truncate">{title ?? "untitled"}</span>
    </Link>
  );
}

/** Grouped edge list for the object page rail. A link to a deleted object
 *  isn't useful to show — it's not clickable to anything current, and it
 *  reads as clutter rather than as a fact worth keeping visible. */
export function EdgeGroup({ label, edges }: { label: string; edges: Edge[] }) {
  const live = edges.filter((e) => !e.target_deleted);
  if (live.length === 0) return null;
  const byRel = new Map<string, Edge[]>();
  for (const e of live) {
    const k = e.rel;
    byRel.set(k, [...(byRel.get(k) ?? []), e]);
  }
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-dim uppercase">{label}</div>
      <div className="flex flex-col gap-2.5">
        {[...byRel.entries()].map(([rel, group]) => (
          <div key={rel}>
            <div className="mb-1 font-mono text-[11px] text-mut">{rel}</div>
            <div className="flex flex-wrap gap-1.5">
              {group.map((e, i) => (
                <ObjectChip
                  key={`${e.id}-${i}`}
                  id={e.id}
                  title={e.target_title}
                  type={e.target_type}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A keystroke, written the way the interface writes every other keystroke.
 *  One component so ⌘N reads identically in the sidebar, in an empty state
 *  and in a tooltip — the affordance is only teachable if it looks the same
 *  everywhere. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-flex items-center rounded border border-line-soft bg-hover px-1 py-px align-baseline font-mono text-[10.5px] leading-[1.5] text-mut">
      {children}
    </kbd>
  );
}

/**
 * Loading placeholder. Kept named Spinner so every existing call site keeps
 * working (and `rows` keeps meaning what it meant), but it is a SKELETON: the
 * shape of the thing that is coming, not a spinner that says nothing.
 *
 * `variant` picks the shape so the placeholder matches the layout it becomes —
 * a table skeleton must not become a gallery, or the page visibly re-lays out
 * the moment the data lands, which reads as a bug.
 */
export function Spinner({
  rows = 5,
  variant = "list",
}: {
  rows?: number;
  variant?: "list" | "table" | "cards" | "board" | "text";
}) {
  const label = { role: "status" as const, "aria-busy": true, "aria-label": "Loading" };
  // The skeleton's whole job is to be "the shape of what is coming" (TypeView),
  // and the real layouts drop to a 16px gutter on the phone — so the skeleton
  // must too, or every mobile load indents 32px and then visibly snaps left
  // the moment the data lands, which is exactly the re-layout it exists to
  // prevent.
  const isMobile = useIsMobile();
  const padX = isMobile ? "px-4" : "px-8";
  if (variant === "table") {
    return (
      <div className="flex flex-col" {...label}>
        <div className={`flex items-center gap-4 border-b border-line-soft py-2.5 ${padX}`}>
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="ml-auto h-2.5 w-14" />
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={`flex items-center gap-4 border-b border-line-soft py-3 ${padX}`}>
            <Skeleton className="h-3 w-3 shrink-0 rounded-full" />
            <Skeleton className="h-3.5" style={{ width: `${34 - ((i * 5) % 14)}%` }} />
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="ml-auto h-3 w-12" />
          </div>
        ))}
      </div>
    );
  }
  if (variant === "cards") {
    return (
      <div
        className={`grid gap-3 py-5 ${padX}`}
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}
        {...label}
      >
        {Array.from({ length: Math.max(rows, 6) }).map((_, i) => (
          <div key={i} className="border border-line-soft p-3.5">
            <Skeleton className="h-3.5" style={{ width: `${80 - ((i * 9) % 30)}%` }} />
            <Skeleton className="mt-2.5 h-2.5" />
            <Skeleton className="mt-1.5 h-2.5 w-2/3" />
            <Skeleton className="mt-3 h-4 w-14" />
          </div>
        ))}
      </div>
    );
  }
  if (variant === "board") {
    return (
      <div className={`flex gap-4 overflow-hidden py-5 ${padX}`} {...label}>
        {Array.from({ length: 4 }).map((_, c) => (
          <div key={c} className="w-[260px] shrink-0">
            <Skeleton className="h-2.5 w-20" />
            <div className="mt-3 flex flex-col gap-2">
              {Array.from({ length: Math.max(2, rows - c) }).map((_, i) => (
                <div key={i} className="border border-line-soft p-3">
                  <Skeleton className="h-3.5" style={{ width: `${85 - ((i * 11) % 35)}%` }} />
                  <Skeleton className="mt-2 h-2.5 w-1/2" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (variant === "text") {
    return (
      <div className="flex flex-col gap-2.5 py-4" {...label}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-3.5" style={{ width: `${96 - ((i * 13) % 40)}%` }} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5 py-4" {...label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5" style={{ width: `${70 - ((i * 7) % 35)}%` }} />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * An empty surface is an instruction, not a shrug.
 *
 * `children` says what is (not) here in the interface's own voice; `hint` says
 * what to do about it and is where the keystroke goes — "Press ⌘N to make
 * one." A surface nobody can write to passes no hint rather than a disabled
 * button, because telling a viewer to press ⌘N is a lie.
 */
export function Empty({
  children,
  hint,
  action,
}: {
  children: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="empty-in flex flex-col items-center gap-2 bg-hover px-6 py-12 text-center shadow-none">
      <div className="max-w-[52ch] text-[13.5px] text-balance text-mut">{children}</div>
      {hint ? <div className="max-w-[52ch] text-[12.5px] text-dim">{hint}</div> : null}
      {action ? <div className="pt-1.5">{action}</div> : null}
    </Card>
  );
}

/** The one written invitation, so every writable-but-empty surface says the
 *  same sentence. `what` names the thing in the surface's own vocabulary —
 *  "a card", "an object", "a Deal". */
export function CreateHint({ what = "one" }: { what?: string }) {
  return (
    <>
      Press <Kbd>⌘N</Kbd> to make {what}.
    </>
  );
}

/**
 * Read-path load failure with a manual Retry. Replaces the
 * infinite skeleton a rejected primary fetch used to render. Styled like the
 * MembersView destructive banner; retry is manual (no auto-retry storm).
 */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      aria-live="polite"
      className="mb-4 flex max-w-[720px] items-center justify-between gap-4 rounded-none border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-none border border-destructive/40 px-2.5 py-1 text-[12.5px] font-medium hover:bg-destructive/15"
      >
        Retry
      </button>
    </div>
  );
}

/** Search snippets arrive with ts_headline <b> markers only — render those as
    highlights and everything else as plain text. Never raw HTML. */
export function Snippet({ text }: { text: string | null }) {
  if (!text) return null;
  const parts = text.split(/<\/?b>/g);
  return (
    <span>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="rounded-sm px-0.5"
            style={{ background: "var(--mark-bg)", color: "var(--mark-fg)" }}
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}
