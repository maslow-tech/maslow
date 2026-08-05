/**
 * Typed property editing for the object page rail.
 *
 * The schema is not guessed: every field is driven by the `PropDef` list the
 * box already returns from `/api/v1/types` (and echoes on the object), so a
 * `date` is a date picker and an `enum` can only ever hold one of its declared
 * values. Two rules matter more than the widgets:
 *
 *  - **One field edit = one field-granular patch.** `onChange(name, value)`
 *    hands the caller exactly one key, which becomes `props: { name: value }`.
 *    Never the whole props object — that reverts keys this client never
 *    touched, including ones an agent wrote a second ago.
 *  - **Clearing sends `null`, not `""`.** `null` is the delete sentinel the
 *    PATCH route understands; an empty string is a value, and typing then
 *    erasing a number must not leave `0` or `""` behind.
 *
 * Read-only is a real mode, not disabled inputs: a viewer sees the same values
 * rendered exactly as the rest of the page renders them (so provenance
 * tooltips keep working through `renderValue`). The endpoints refuse a viewer's
 * write independently — this is UX, not the boundary.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PropDef } from "../lib/api";
import { api } from "../lib/api";
import { ObjectChip } from "./bits";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface PropsPanelProps {
  /** the type's declared properties, in declaration order */
  defs: PropDef[];
  /** current scalar values, keyed by property name */
  values: Record<string, unknown>;
  /** titles for ref-kind values, resolved from the object's edges */
  refTitles?: Record<string, { title: string | null; type: string | null }>;
  readOnly?: boolean;
  /** one field, one patch. `null` clears (deletes) the key. */
  onChange?: (name: string, value: unknown) => void;
  /** read-only rendering hook, so the page keeps its provenance tooltips */
  renderValue?: (name: string, value: unknown) => React.ReactNode;
}

/** Unit/format suffixes that name how the system stores a field, not what the
 *  person controls — dropped from the human label ("ceiling_usd" → "Ceiling"). */
const UNIT_SUFFIXES = new Set(["usd", "eur", "gbp", "pct", "pc", "id", "url", "ts", "iso", "utc"]);

/** The hint shown for a stripped suffix WHEN dropping it would make two shown
 *  fields read identically — so `fee_usd`/`fee_pct` become "Fee (USD)"/"Fee (%)"
 *  instead of two indistinguishable "Fee" rows the user could edit by mistake. */
const UNIT_HINTS: Record<string, string> = {
  usd: "USD",
  eur: "EUR",
  gbp: "GBP",
  pct: "%",
  pc: "%",
  id: "ID",
  url: "URL",
  ts: "time",
  iso: "ISO",
  utc: "UTC",
};

/** A property's human label: the field's name in the person's vocabulary, not
 *  the brain's snake_case identifier. Sentence case, unit suffix removed —
 *  "due_date" → "Due date", "pwin" → "Pwin", "ceiling_usd" → "Ceiling". */
export function propLabel(name: string): string {
  const parts = name.split(/[_\s]+/).filter(Boolean);
  if (parts.length > 1 && UNIT_SUFFIXES.has(parts[parts.length - 1]!.toLowerCase())) parts.pop();
  if (parts.length === 0) return name;
  return parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join(" ");
}

/**
 * Labels for a WHOLE set of property names at once, so a stripped unit suffix
 * can never silently collapse two distinct fields into one indistinguishable
 * row. `propLabel` is per-name and cannot see its neighbours; this can, so when
 * two names would share a base label it keeps a disambiguating unit hint
 * (`fee_usd` → "Fee (USD)", `fee_pct` → "Fee (%)"), falling back to the raw
 * identifier when the collision is not a unit suffix at all.
 */
export function propLabels(names: string[]): Map<string, string> {
  const base = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const name of names) {
    const label = propLabel(name);
    base.set(name, label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const name of names) {
    const label = base.get(name)!;
    if ((counts.get(label) ?? 0) <= 1) {
      out.set(name, label);
      continue;
    }
    const parts = name.split(/[_\s]+/).filter(Boolean);
    const last = parts.length > 1 ? parts[parts.length - 1]!.toLowerCase() : "";
    const hint = UNIT_HINTS[last];
    out.set(name, hint ? `${label} (${hint})` : name);
  }
  return out;
}

/** Properties the object carries that its type never declared — older writes,
 *  or an agent's ad-hoc key. They stay visible and editable as text; hiding
 *  them would be the UI quietly disagreeing with the brain. */
export function undeclaredKeys(defs: PropDef[], values: Record<string, unknown>): string[] {
  const declared = new Set(defs.map((d) => d.name));
  return Object.keys(values)
    .filter((k) => !declared.has(k))
    .sort();
}

export function PropsPanel({
  defs,
  values,
  refTitles,
  readOnly = false,
  onChange,
  renderValue,
}: PropsPanelProps) {
  const extras = useMemo(() => undeclaredKeys(defs, values), [defs, values]);
  // A deprecated property with no value is dead weight; with a value it is a
  // fact about this object and stays visible.
  const shown = defs.filter((d) => !d.deprecated || values[d.name] != null);
  // Labels are computed over the WHOLE rendered set so a unit suffix cannot
  // collapse two fields into one ambiguous "Fee" row (see `propLabels`).
  const labels = useMemo(
    () => propLabels([...shown.map((d) => d.name), ...extras]),
    [shown, extras],
  );

  if (shown.length === 0 && extras.length === 0) return null;

  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-dim uppercase">
        Properties
      </div>
      <dl className="flex flex-col gap-2">
        {shown.map((def) => (
          <Row
            key={def.name}
            label={labels.get(def.name) ?? propLabel(def.name)}
            name={def.name}
            required={def.required}
          >
            {readOnly ? (
              <ReadValue name={def.name} value={values[def.name]} render={renderValue} />
            ) : (
              <PropField
                def={def}
                value={values[def.name]}
                refTitle={refTitles?.[def.name]}
                onChange={(v) => onChange?.(def.name, v)}
              />
            )}
          </Row>
        ))}
        {extras.map((key) => (
          <Row key={key} label={labels.get(key) ?? propLabel(key)} name={key}>
            {readOnly ? (
              <ReadValue name={key} value={values[key]} render={renderValue} />
            ) : (
              <PropField
                def={{ name: key, kind: "text", required: false, deprecated: false }}
                value={values[key]}
                onChange={(v) => onChange?.(key, v)}
              />
            )}
          </Row>
        ))}
      </dl>
    </div>
  );
}

function Row({
  label,
  name,
  required,
  children,
}: {
  label: string;
  /** the raw property identifier — surfaced as the `<dt>` tooltip so the real
   *  name is always recoverable even when the label is truncated or shares a
   *  base with a sibling field. */
  name?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      {/* The label labels — it should read as ink, not recede in dim mono while
          an empty input box shouts beside it. */}
      <dt
        className="w-[104px] shrink-0 truncate pt-1 text-[12px] font-medium text-mut"
        title={name ?? label}
      >
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </dt>
      <dd className="min-w-0 flex-1 text-[13px] text-ink">{children}</dd>
    </div>
  );
}

function ReadValue({
  name,
  value,
  render,
}: {
  name: string;
  value: unknown;
  render?: ((name: string, value: unknown) => React.ReactNode) | undefined;
}) {
  if (render) return <>{render(name, value)}</>;
  if (value === null || value === undefined || value === "")
    return <span className="text-dim">—</span>;
  return <span className="break-words">{String(value)}</span>;
}

/* ---------------------------------------------------------------- fields */

interface FieldProps {
  def: PropDef;
  value: unknown;
  refTitle?: { title: string | null; type: string | null } | undefined;
  onChange: (value: unknown) => void;
}

export function PropField({ def, value, refTitle, onChange }: FieldProps) {
  switch (def.kind) {
    case "int":
    case "decimal":
    case "float":
      return <NumberField def={def} value={value} onChange={onChange} />;
    case "bool":
      return <BoolField value={value} onChange={onChange} />;
    case "date":
      return <DateField value={value} onChange={onChange} step="date" />;
    case "timestamp":
      return <DateField value={value} onChange={onChange} step="timestamp" />;
    case "enum":
      return <EnumField def={def} value={value} onChange={onChange} />;
    case "ref":
      return <RefField def={def} value={value} refTitle={refTitle} onChange={onChange} />;
    case "ref[]":
      // ref[] properties ARE edges — they ride the links rail, do not bump the
      // object version, and are edited there. Showing a text box here would
      // invite a write that the props patch cannot express.
      return (
        <span className="text-[12px] text-dim italic">
          {Array.isArray(value) ? `${value.length} linked` : "edited from Links"}
        </span>
      );
    default:
      return <TextField value={value} onChange={onChange} />;
  }
}

/** The shared commit rule: local state while typing, one patch on blur/Enter,
 *  and an empty box means `null` (delete), never `""`. */
function useCommitted(
  value: unknown,
  onChange: (v: unknown) => void,
  parse: (s: string) => unknown,
) {
  const [text, setText] = useState(() => toText(value));
  const dirty = useRef(false);

  useEffect(() => {
    // Adopt a foreign value (someone else's write, a take-theirs, a revert)
    // only while we are not mid-edit — otherwise it eats the user's keystrokes.
    if (!dirty.current) setText(toText(value));
  }, [value]);

  const commit = (): void => {
    if (!dirty.current) return;
    dirty.current = false;
    const trimmed = text.trim();
    const parsed = trimmed === "" ? null : parse(trimmed);
    // `undefined` means "that wasn't a value" (a typo'd number). Snap back to
    // the server's value rather than sending null, which would DELETE the key.
    if (parsed === undefined) {
      setText(toText(value));
      return;
    }
    onChange(parsed);
  };

  return {
    text,
    set: (s: string) => {
      dirty.current = true;
      setText(s);
    },
    commit,
    reset: () => {
      dirty.current = false;
      setText(toText(value));
    },
  };
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function TextField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const f = useCommitted(value, onChange, (s) => s);
  return (
    <Input
      value={f.text}
      onChange={(e) => f.set(e.target.value)}
      onBlur={f.commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") f.commit();
        if (e.key === "Escape") f.reset();
      }}
      placeholder="—"
    />
  );
}

function NumberField({
  def,
  value,
  onChange,
}: {
  def: PropDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const f = useCommitted(value, onChange, (s) => {
    const n = Number(s);
    // A typo is not a value: leave the server's number alone rather than
    // writing NaN (which JSON-encodes as null and would DELETE the key).
    if (!Number.isFinite(n)) return undefined;
    return def.kind === "int" ? Math.trunc(n) : n;
  });
  return (
    // Deliberately NOT `type="number"`: a number input silently reports garbage
    // as an EMPTY string, which is our delete sentinel — one typo would delete
    // the property. Plain text keeps what was typed, so a non-number can be
    // recognised and refused.
    <Input
      type="text"
      inputMode={def.kind === "int" ? "numeric" : "decimal"}
      value={f.text}
      onChange={(e) => f.set(e.target.value)}
      onBlur={f.commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") f.commit();
        if (e.key === "Escape") f.reset();
      }}
      // Sized to a number, not full-bleed: a two-digit value in a full-width
      // box is mostly empty box, and the label loses the weight contest.
      className="w-40 max-w-full font-mono"
      placeholder="—"
    />
  );
}

/** `date` → yyyy-mm-dd; `timestamp` → the local datetime the browser gives us,
 *  sent back as an ISO string the box can parse. */
function DateField({
  value,
  onChange,
  step,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  step: "date" | "timestamp";
}) {
  const current = toDateInput(value, step);
  return (
    <Input
      type={step === "date" ? "date" : "datetime-local"}
      value={current}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "") return onChange(null);
        if (step === "date") return onChange(v);
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return; // half-typed datetime; not a value yet
        onChange(d.toISOString());
      }}
      className={`${step === "date" ? "w-40" : "w-52"} max-w-full font-mono`}
    />
  );
}

export function toDateInput(value: unknown, step: "date" | "timestamp"): string {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value);
  if (step === "date") return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tri-state on purpose: yes / no / unset. A checkbox cannot express "this
 *  property has never been set", and coercing unset to `false` is a write. */
function BoolField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const state = value === null || value === undefined ? null : Boolean(value);
  const btn = (label: string, target: boolean | null) => (
    <Button
      type="button"
      size="xs"
      variant={state === target ? "default" : "outline"}
      aria-pressed={state === target}
      onClick={() => onChange(target)}
    >
      {label}
    </Button>
  );
  return (
    <div className="flex gap-1">
      {btn("Yes", true)}
      {btn("No", false)}
      {btn("—", null)}
    </div>
  );
}

function EnumField({
  def,
  value,
  onChange,
}: {
  def: PropDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const options = def.enum_values ?? [];
  const current = value === null || value === undefined ? "" : String(value);
  return (
    <div className="flex items-center gap-1.5">
      <Select value={current} onValueChange={(v) => onChange(v === "" ? null : v)}>
        <SelectTrigger size="sm" aria-label={def.name}>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {current !== "" && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Clear ${def.name}`}
          onClick={() => onChange(null)}
        >
          ×
        </Button>
      )}
    </div>
  );
}

/** A single ref: a real object, chosen by searching for it. Typing a raw uuid
 *  is not an affordance — a ref whose target the user cannot see would look
 *  like a broken link, and searching is already RLS-scoped for us. */
function RefField({
  def,
  value,
  refTitle,
  onChange,
}: {
  def: PropDef;
  value: unknown;
  refTitle?: { title: string | null; type: string | null } | undefined;
  onChange: (v: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<
    Array<{ id: string; title: string | null; type: string | null }>
  >([]);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .search(query, def.ref_type ? { type: def.ref_type, limit: 8 } : { limit: 8 })
        .then((rs) => {
          if (live) setHits(rs.map((r) => ({ id: r.id, title: r.title, type: r.type })));
        })
        .catch(() => {
          if (live) setHits([]);
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, open, def.ref_type]);

  const id = typeof value === "string" && value !== "" ? value : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {id ? (
          <ObjectChip id={id} title={refTitle?.title ?? id} type={refTitle?.type ?? null} />
        ) : (
          <span className="text-dim">—</span>
        )}
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => {
            setOpen((v) => !v);
            setQ("");
          }}
        >
          {id ? "Change" : "Set"}
        </Button>
        {id && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={`Clear ${def.name}`}
            onClick={() => onChange(null)}
          >
            Clear
          </Button>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-1">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${def.ref_type ?? "objects"}…`}
            aria-label={`Search for ${def.name}`}
          />
          {hits.length > 0 && (
            <ul className="flex flex-col border border-line-soft bg-panel">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    className="w-full cursor-pointer px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover"
                    onClick={() => {
                      onChange(h.id);
                      setOpen(false);
                    }}
                  >
                    {h.title ?? "untitled"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
