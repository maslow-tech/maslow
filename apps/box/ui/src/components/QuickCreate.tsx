import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { api, newIdempotencyKey, type TypeSummary } from "../lib/api";
import { typeLabel } from "../lib/ui";
import { TypeIcon } from "./bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** A plain note — an object with no type. The box models "untyped" as an
 *  absent `type`, so this sentinel never reaches the wire. */
const NOTE = "__note__";

/**
 * Is the keyboard focus somewhere that owns the keystroke? Text inputs,
 * textareas and the block editor (TipTap renders a contenteditable) all do —
 * a global shortcut must not steal a key out from under them. Exported
 * because Shell's ⌘N handler and the tests share exactly this rule.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  return !!el.closest("input, textarea, select, [contenteditable='true']");
}

/**
 * Quick-create (⌘N and the sidebar's New button).
 *
 * Two keyboard-first steps: pick what to make (a Note, or any type in the
 * catalog — filterable), then optionally name it. Enter carries you through
 * both, so ⌘N-Enter-Enter is a titled-later note in the editor.
 *
 * The idempotency key is minted ONCE per submission and reused for every
 * retry of that same submission — a create has no version to conflict on, so
 * a lost response without a key becomes a duplicate object. Changing the type
 * or the title makes it a DIFFERENT intent, which mints a fresh key.
 */
export function QuickCreate({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** The new object's id — the caller navigates to /o/<id>. */
  onCreated: (id: string) => void;
}) {
  const [types, setTypes] = useState<TypeSummary[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The key for the submission in flight. Null means "no intent yet"; it is
  // cleared whenever the type or title changes, so the next Create is a new
  // intent, and kept across failures, so Retry is the same one.
  const keyRef = useRef<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    api
      .types()
      .then((ts) => alive.current && setTypes(ts.filter((t) => !t.deprecated)))
      .catch(() => setTypes([]));
  }, []);

  function pick(name: string) {
    setPicked(name);
    keyRef.current = null;
    setError(null);
  }

  function retitle(v: string) {
    setTitle(v);
    keyRef.current = null;
    setError(null);
  }

  async function create() {
    if (busy || !picked) return;
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    setBusy(true);
    setError(null);
    try {
      const named = title.trim();
      const r = await api.createObject({
        idempotencyKey: keyRef.current,
        ...(picked === NOTE ? {} : { type: picked }),
        ...(named ? { title: named } : {}),
      });
      if (!alive.current) return;
      onCreated(r.id);
    } catch (e) {
      if (!alive.current) return;
      // Keep keyRef — pressing Create again retries the SAME intent, and the
      // box collapses it onto whatever the lost attempt already wrote.
      setError(e instanceof Error ? e.message : "Could not create it.");
      setBusy(false);
    }
  }

  // typeLabel, not raw `label ?? name`: most brain-authored types have no
  // explicit label (TypeSummary.label is nullable), and the step-2 heading was
  // the one place in the creation flow still showing the internal snake_case
  // identifier ("New status_report") one keystroke after the picker correctly
  // rendered "Status Report".
  const pickedType = picked === null ? undefined : types.find((t) => t.name === picked);
  const pickedLabel =
    picked === NOTE ? "Note" : pickedType ? typeLabel(pickedType) : (picked ?? "");

  return (
    <CommandDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Create something new"
      description="Make a note or a typed object and land in its editor"
    >
      {picked === null ? (
        <Command>
          <CommandInput placeholder="What do you want to make?" />
          <CommandList>
            <CommandEmpty>No type matches. Make a note instead.</CommandEmpty>
            <CommandItem value="Note" onSelect={() => pick(NOTE)}>
              <FileText size={14} aria-hidden />
              <span className="flex-1 text-[13.5px] font-medium">Note</span>
            </CommandItem>
            {types.map((t) => (
              <CommandItem key={t.name} value={typeLabel(t)} onSelect={() => pick(t.name)}>
                <TypeIcon icon={t.icon} type={t.name} />
                <span className="flex-1 text-[13.5px]">{typeLabel(t)}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      ) : (
        <form
          className="flex flex-col gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="text-[11px] font-semibold tracking-[.08em] text-muted-foreground uppercase">
            New {pickedLabel}
          </div>
          <Input
            autoFocus
            value={title}
            onChange={(e) => retitle(e.target.value)}
            placeholder="Title (optional)"
            aria-label="Title"
            onKeyDown={(e) => {
              if (e.key === "Escape" && title === "") {
                // Empty title, Escape steps back to the picker rather than
                // throwing the whole intent away.
                e.preventDefault();
                e.stopPropagation();
                setPicked(null);
              }
            }}
          />
          {error && (
            <div role="alert" className="text-[12px] text-destructive">
              {error} Press Create to retry — it won’t make a second object.
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(null)}>
              Back
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Creating…" : error ? "Retry" : "Create"}
            </Button>
          </div>
        </form>
      )}
    </CommandDialog>
  );
}
