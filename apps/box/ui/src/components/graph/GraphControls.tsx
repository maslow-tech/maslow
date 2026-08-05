/**
 * The graph's control surface: the six force/legibility sliders, the type
 * legend (which is also the type FILTER), the recency filter, the search box
 * and the camera controls.
 *
 * Three things are worth stating about the shape of this file:
 *
 *  1. **It is presentational and controlled.** Every value arrives as a prop
 *     and every change leaves as a callback, because the same controls are
 *     mounted twice at two different scales — the whole-brain view and the
 *     object page's rail — and the two must keep SEPARATE values (a −120
 *     charge in a 300px rail throws every neighbour off the edge). The state
 *     itself lives in `useGraphControls(scope)`, which is keyed by scope, so
 *     "persisted per view" is a property of the hook rather than a hidden
 *     global inside a component.
 *  2. **The sliders are the user-facing half of `ForceParams`,** not the same
 *     numbers. `repel` is a POSITIVE magnitude here (0→200) and becomes a
 *     negative `chargeStrength` in `forcesFrom` — a slider you drag right to
 *     get more of the thing named on it is the only version anyone can use,
 *     and a positive charge fed to d3 collapses the graph into a point and
 *     looks exactly like a crash. Everything else is clamped by
 *     `normalizeForces` worker-side as well, because these values round-trip
 *     through localStorage and (phase 6, later) a saved view.
 *  3. **Plain HTML controls.** `<input type="range">`, `<select>`, `<details>`
 *     and `<button>` are keyboard-operable, screen-reader-labelled and
 *     skin-agnostic for free; a bespoke drag handle is none of those. The
 *     styling is the dashboard's own CSS variables, so both skins follow the
 *     page rather than carrying a second palette.
 *
 * The type legend is deliberately the same control as the type filter. A
 * legend you cannot click is a colour key; the graph needs the filter inline
 * because that is what the truncation copy ("filter by type or date to see the
 * rest") tells you to reach for, and a filter that lives somewhere else makes
 * that sentence a lie.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Maximize2, RotateCcw, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { TypeIcon } from "../bits";
import type { ForceParams } from "../../lib/graph/physics-protocol";
import { useTheme } from "../../lib/theme";
import { fmtNumber, typeHue, typeName } from "../../lib/ui";

/* ------------------------------------------------------------------ *
 * values
 * ------------------------------------------------------------------ */

/**
 * What the six sliders hold. These are UI units — see `forcesFrom` for the
 * translation into the worker's `ForceParams` and the renderer's scales.
 */
export interface GraphControlValues {
  /** `forceX`/`forceY` strength pulling everything toward the origin, 0→0.15. */
  center: number;
  /** repulsion MAGNITUDE, 0→200; applied as a negative charge. */
  repel: number;
  /** multiplier on d3's degree-normalized link strength, 0→2. */
  linkStrength: number;
  /** target link length in world units, 10→250. */
  linkDistance: number;
  /** node-radius multiplier, 0.5→2. */
  nodeSize: number;
  /** camera scale at which labels start to fade in (`labelAlpha`), 0.1→3. */
  labelThreshold: number;
}

/** One slider's range and how its value reads out. */
interface ControlSpec {
  readonly key: keyof GraphControlValues;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (v: number) => string;
  /** the one-line "what does this do" under the label. */
  readonly hint: string;
}

const px = (v: number): string => `${Math.round(v)}px`;
const two = (v: number): string => v.toFixed(2);
const one = (v: number): string => v.toFixed(1);

/**
 * The committed user-control ranges. The order is the
 * order they render in: the three that change the SHAPE first, then the two
 * that change what you can READ.
 */
export const CONTROL_SPECS: readonly ControlSpec[] = [
  {
    key: "center",
    label: "Center pull",
    min: 0,
    max: 0.15,
    step: 0.005,
    format: two,
    hint: "how hard everything is drawn to the middle",
  },
  {
    key: "repel",
    label: "Repel",
    min: 0,
    max: 200,
    step: 5,
    format: (v) => String(Math.round(v)),
    hint: "how hard nodes push each other apart",
  },
  {
    key: "linkStrength",
    label: "Link force",
    min: 0,
    max: 2,
    step: 0.05,
    format: (v) => `${two(v)}×`,
    hint: "how strongly a link pulls its two objects together",
  },
  {
    key: "linkDistance",
    label: "Link distance",
    min: 10,
    max: 250,
    step: 5,
    format: px,
    hint: "the length a link settles at",
  },
  {
    key: "nodeSize",
    label: "Node size",
    min: 0.5,
    max: 2,
    step: 0.05,
    format: (v) => `${two(v)}×`,
    hint: "radius multiplier — area still grows with degree",
  },
  {
    key: "labelThreshold",
    label: "Label threshold",
    min: 0.1,
    max: 3,
    step: 0.05,
    format: one,
    hint: "the zoom level labels start appearing at",
  },
];

const SPEC_BY_KEY = new Map<keyof GraphControlValues, ControlSpec>(
  CONTROL_SPECS.map((s) => [s.key, s]),
);

/** The whole-brain view's defaults — the same layout `DEFAULT_FORCES` describes. */
export const GLOBAL_CONTROL_DEFAULTS: GraphControlValues = {
  center: 0.06,
  repel: 120,
  linkStrength: 1,
  linkDistance: 40,
  nodeSize: 1,
  labelThreshold: 0.6,
};

/**
 * The rail's defaults — `RAIL_FORCES` scaled to ~300px, plus a much lower label
 * threshold: a local graph of eight neighbours is useless unnamed, so its
 * labels are on from the first frame.
 */
export const RAIL_CONTROL_DEFAULTS: GraphControlValues = {
  center: 0.08,
  repel: 60,
  linkStrength: 1,
  linkDistance: 20,
  nodeSize: 1,
  labelThreshold: 0.15,
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Fold a partial (and possibly hostile — it came out of localStorage, and
 * later out of a saved view's jsonb) control bag onto a base. A NaN that
 * reaches d3 turns every position into NaN and the graph vanishes with no
 * error anywhere, so nothing here is trusted.
 */
export function normalizeControls(
  partial: Partial<GraphControlValues> | null | undefined,
  base: GraphControlValues = GLOBAL_CONTROL_DEFAULTS,
): GraphControlValues {
  const out = { ...base };
  const p = partial ?? {};
  for (const spec of CONTROL_SPECS) {
    const raw = p[spec.key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    out[spec.key] = clamp(raw, spec.min, spec.max);
  }
  return out;
}

/**
 * The slider bag as the worker's force bag. Only the four forces cross over —
 * node size and the label threshold are the renderer's and the overlay's, and
 * are applied by the view directly.
 */
export function forcesFrom(values: GraphControlValues): Partial<ForceParams> {
  const v = normalizeControls(values, values);
  return {
    centerStrength: v.center,
    // NEGATIVE: the slider is a magnitude (see the header).
    chargeStrength: -v.repel,
    linkStrength: v.linkStrength,
    linkDistance: v.linkDistance,
  };
}

/* ------------------------------------------------------------------ *
 * persistence — per scope, so global and rail never share a value
 * ------------------------------------------------------------------ */

/**
 * A control scope: `"global"`, `"rail"`, or `view:<savedViewId>` once graph
 * views are saved. It is the storage key's tail, so it must be stable and must
 * NOT contain user content.
 */
type GraphControlScope = string;

const CONTROLS_PREFIX = "brain.graph.controls.";

export function controlsStorageKey(scope: GraphControlScope): string {
  return `${CONTROLS_PREFIX}${scope}`;
}

/**
 * Read the persisted values for a scope. Storage can be absent or throw
 * (private mode, quota, policy) and the stored blob can be anything at all;
 * either way the answer is the defaults, never an exception — controls we
 * cannot persist are a preference lost, not a broken graph.
 */
export function loadControls(
  scope: GraphControlScope,
  base: GraphControlValues = GLOBAL_CONTROL_DEFAULTS,
): GraphControlValues {
  try {
    const raw = localStorage.getItem(controlsStorageKey(scope));
    if (raw === null) return { ...base };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...base };
    }
    return normalizeControls(parsed as Partial<GraphControlValues>, base);
  } catch {
    return { ...base };
  }
}

export function saveControls(scope: GraphControlScope, values: GraphControlValues): void {
  try {
    localStorage.setItem(controlsStorageKey(scope), JSON.stringify(values));
  } catch {
    // A preference we cannot store is not worth an error boundary.
  }
}

interface GraphControlsState {
  values: GraphControlValues;
  /** merge a patch (one slider moved) and persist. */
  set: (patch: Partial<GraphControlValues>) => void;
  /** back to this scope's defaults, and forget the stored blob. */
  reset: () => void;
}

/**
 * The controls for one scope, persisted. Two mounts with two scopes are two
 * independent bags — that is the whole reason the scope is a parameter.
 */
export function useGraphControls(
  scope: GraphControlScope,
  base: GraphControlValues = GLOBAL_CONTROL_DEFAULTS,
): GraphControlsState {
  const [values, setValues] = useState<GraphControlValues>(() => loadControls(scope, base));

  // A scope change (global → a saved view) reloads rather than carrying the
  // previous view's forces across. `base` is a module constant at every call
  // site, so it rides along in the dep list without re-running.
  useEffect(() => {
    setValues(loadControls(scope, base));
  }, [scope, base]);

  const set = useCallback(
    (patch: Partial<GraphControlValues>) => {
      setValues((prev) => {
        const next = normalizeControls({ ...prev, ...patch }, base);
        saveControls(scope, next);
        return next;
      });
    },
    [scope, base],
  );

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(controlsStorageKey(scope));
    } catch {
      // same as saveControls: best effort.
    }
    setValues({ ...base });
  }, [scope, base]);

  return { values, set, reset };
}

/* ------------------------------------------------------------------ *
 * the recency filter
 * ------------------------------------------------------------------ */

export type RecencyKey = "all" | "7d" | "30d" | "90d" | "1y";

export const RECENCY_OPTIONS: ReadonlyArray<{ key: RecencyKey; label: string; days: number }> = [
  { key: "all", label: "Any time", days: 0 },
  { key: "7d", label: "Updated in 7 days", days: 7 },
  { key: "30d", label: "Updated in 30 days", days: 30 },
  { key: "90d", label: "Updated in 90 days", days: 90 },
  { key: "1y", label: "Updated in a year", days: 365 },
];

/** The `updated_at >=` bound for a recency key, or null for "any time". */
export function recencySince(key: RecencyKey, now: number = Date.now()): string | null {
  const option = RECENCY_OPTIONS.find((o) => o.key === key);
  if (!option || option.days <= 0) return null;
  return new Date(now - option.days * 86_400_000).toISOString();
}

/* ------------------------------------------------------------------ *
 * the component
 * ------------------------------------------------------------------ */

/** One row of the legend: a type present in the loaded graph, and its count. */
export interface GraphTypeCount {
  /** null is the untyped bucket — the server's filter takes null for it too. */
  type: string | null;
  count: number;
}

export interface GraphControlsProps {
  values: GraphControlValues;
  onChange: (patch: Partial<GraphControlValues>) => void;
  /** reset the SLIDERS (not the camera) to this scope's defaults. */
  onResetForces: () => void;
  /** legend rows, most-populous first. Empty hides the legend entirely. */
  types?: readonly GraphTypeCount[];
  /** the types currently kept. Empty set = no type filter at all. */
  activeTypes?: ReadonlySet<string | null>;
  onToggleType?: (type: string | null) => void;
  onClearTypes?: () => void;
  recency?: RecencyKey;
  onRecencyChange?: (key: RecencyKey) => void;
  /** the search box. Omit the handler to hide it (the rail has no search). */
  query?: string;
  onQueryChange?: (q: string) => void;
  /** Enter in the search box — the view centers on the first match. */
  onQuerySubmit?: () => void;
  /** how many nodes the query matched, or null when it is empty. */
  matchCount?: number | null;
  onFitCamera?: () => void;
  /** the progress / truncation line — the view owns its copy. */
  status?: ReactNode;
  /** rail mode: sliders and camera only, denser. */
  compact?: boolean;
  /** the sliders start collapsed on the global view; the rail opens them. */
  defaultForcesOpen?: boolean;
}

/**
 * A labelled range input. Native on purpose: it is arrow-key and Home/End
 * operable, it announces its own value, and `accent-color` makes it follow the
 * skin without a second palette.
 */
function ControlSlider({
  spec,
  value,
  onChange,
  idPrefix,
}: {
  spec: ControlSpec;
  value: number;
  onChange: (v: number) => void;
  idPrefix: string;
}) {
  const id = `${idPrefix}-${spec.key}`;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[11.5px] text-mut">
          {spec.label}
        </label>
        <span className="font-mono text-[10.5px] text-dim tabular-nums" aria-hidden>
          {spec.format(value)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        title={spec.hint}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-none bg-[var(--line)] accent-[var(--ink-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink-strong)]"
      />
    </div>
  );
}

export function GraphControls({
  values,
  onChange,
  onResetForces,
  types = [],
  activeTypes,
  onToggleType,
  onClearTypes,
  recency = "all",
  onRecencyChange,
  query = "",
  onQueryChange,
  onQuerySubmit,
  matchCount = null,
  onFitCamera,
  status,
  compact = false,
  defaultForcesOpen = false,
}: GraphControlsProps) {
  const { theme } = useTheme();
  const idPrefix = useMemo(() => `graph-ctl-${compact ? "rail" : "global"}`, [compact]);
  const filtering = activeTypes !== undefined && activeTypes.size > 0;
  const showSearch = !compact && onQueryChange !== undefined;
  const showLegend = !compact && types.length > 0;

  return (
    // One cohesive panel, grouped by hairline dividers — not a stack of six
    // separate bordered island-cards floating in the column. The graph is the
    // hero; its controls should read as a single instrument.
    <div className="flex min-h-0 flex-1 flex-col divide-y divide-line-soft border border-line-soft bg-panel shadow-sm">
      {showSearch && (
        <div className="relative shrink-0">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => onQueryChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onQuerySubmit?.();
              }
              if (e.key === "Escape") onQueryChange?.("");
            }}
            placeholder="Find a node by title…"
            aria-label="Find a node by title"
            className="border-0 bg-transparent pl-7 shadow-none"
          />
          {query !== "" && (
            <button
              type="button"
              onClick={() => onQueryChange?.("")}
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-none p-1.5 text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)]"
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </div>
      )}

      {showSearch && query.trim() !== "" && matchCount !== null && (
        <div className="shrink-0 px-2.5 py-1.5 text-[11.5px] text-dim" role="status">
          {matchCount === 0
            ? "No nodes match — matches stay in place, they are never filtered away."
            : `${fmtNumber(matchCount)} match${matchCount === 1 ? "" : "es"} highlighted in place.`}
        </div>
      )}

      {status !== undefined && status !== null && (
        // The graph canvas is a role=application surface a screen reader cannot
        // enumerate, so this sentence — the object/link counts, the loading and
        // truncation states — is the only non-visual signal of what loaded. It
        // has to be announced, not just painted.
        <div
          role="status"
          aria-live="polite"
          className="shrink-0 px-2.5 py-1.5 text-[11.5px] text-dim"
        >
          {status}
        </div>
      )}

      {onFitCamera !== undefined && (
        // Button rows use container `p-1` so that, with the buttons' own `px-1.5`,
        // their content lands on the SAME 10px left edge as the text rows above
        // (which use `px-2.5`) — otherwise the single bordered instrument reads as
        // a stack of fragments whose left edge steps in and out.
        <div className="flex shrink-0 items-center gap-1 p-1">
          {onFitCamera !== undefined && (
            <Button
              size="xs"
              variant="ghost"
              onClick={onFitCamera}
              className="h-6 flex-1 gap-1 px-1.5 text-[11px] text-dim hover:text-ink"
            >
              <Maximize2 size={12} aria-hidden /> Fit
            </Button>
          )}
        </div>
      )}

      {showLegend && (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1">
          {types.map(({ type, count }) => {
            const active = activeTypes?.has(type) === true;
            return (
              <button
                type="button"
                key={type ?? "(untyped)"}
                onClick={() => onToggleType?.(type)}
                aria-pressed={active}
                // Selected rows go BLUE and everything else stays at full
                // strength. Fading the unselected ones to 50% read as "the
                // rest went away", which is exactly backwards for a filter you
                // are meant to keep adding to — the list is a set of switches,
                // and a switch you have not flipped is not a switch that
                // disappeared. `accent-soft` is the theme's own blue tint, so
                // this stays right in the paper skin too.
                className={`flex shrink-0 items-center gap-2 rounded-none px-1.5 py-1 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ink-strong)] ${
                  active ? "text-ink" : "hover:bg-hover focus-visible:bg-hover"
                }`}
                // The selected tint is written as a STYLE, not a utility class:
                // `--accent-soft`/`--brand` are the theme's own tokens (blue in
                // the dark skin, near-black in paper) but they are not exposed
                // as generated Tailwind colours, so `bg-accent-soft` produced a
                // class name and no rule — visibly nothing. This is the same
                // way `typeHue` already paints the legend dots.
                style={
                  active
                    ? {
                        background: "var(--accent-soft)",
                        boxShadow: "inset 0 0 0 1px var(--brand)",
                      }
                    : undefined
                }
              >
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: typeHue(type, theme) }}
                />
                <TypeIcon type={type} size={12} />
                <span className="min-w-0 flex-1 truncate text-ink">
                  {typeName(type) || "Untyped"}
                </span>
                <span className="font-mono text-dim">{fmtNumber(count)}</span>
              </button>
            );
          })}
          {filtering && onClearTypes !== undefined && (
            <button
              type="button"
              onClick={onClearTypes}
              className="mt-0.5 flex shrink-0 items-center gap-1.5 border-t border-line-soft px-1.5 pt-1.5 text-[11px] text-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--ink-strong)]"
            >
              <X size={11} aria-hidden /> clear type filter
            </button>
          )}
        </div>
      )}

      {!compact && onRecencyChange !== undefined && (
        <div className="shrink-0 px-2.5 py-2">
          {/* "Only show", not "Recency". This control REMOVES objects from the
              graph (it becomes an `updated_at >= …` term in the server query),
              while the scrubber's "Highlight changes since" leaves everything
              loaded and merely lights what moved. */}
          <SelectField
            dense
            id={`${idPrefix}-recency`}
            label="Only show"
            value={recency}
            onChange={(e) => onRecencyChange(e.target.value as RecencyKey)}
          >
            {RECENCY_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </SelectField>
        </div>
      )}

      <details open={defaultForcesOpen} className="shrink-0">
        <summary className="cursor-pointer list-none px-2.5 py-1.5 text-[11.5px] text-mut select-none marker:content-none hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ink-strong)]">
          Layout
        </summary>
        <div className="flex flex-col gap-2 border-t border-line-soft px-2.5 py-2">
          {CONTROL_SPECS.map((spec) => (
            <ControlSlider
              key={spec.key}
              spec={spec}
              value={values[spec.key]}
              idPrefix={idPrefix}
              onChange={(v) => onChange({ [spec.key]: v } as Partial<GraphControlValues>)}
            />
          ))}
          <Button
            size="xs"
            variant="ghost"
            onClick={onResetForces}
            className="h-6 gap-1 self-start px-1.5 text-[11px] text-dim hover:text-ink"
          >
            <RotateCcw size={11} aria-hidden /> Reset layout
          </Button>
        </div>
      </details>
    </div>
  );
}

/** Exported for tests and for the view's own slider-driven readouts. */
export function controlSpec(key: keyof GraphControlValues): ControlSpec {
  const spec = SPEC_BY_KEY.get(key);
  if (spec === undefined) throw new Error(`graph controls: no spec for "${key}"`);
  return spec;
}
