import type { Theme } from "./theme";

/** Shared presentation helpers: type hues, enum tints, dates, formatters.
 *
 *  Both skins encode identity in colour, tuned to their ground. DARK is the
 *  aurora skin: saturated hues that glow on near-black. LIGHT is the paper
 *  skin — the SAME identity, held to a muted, ink-weight register: 600/700-band
 *  hues that read as "coloured ink" on white (each clears AA as pill text over a
 *  faint tint of itself), never as a candy tag. A knowledge graph, a pipeline
 *  board and a status column all answer "where are the people vs the deals" by
 *  colour at a glance — Notion and Linear both colour-code in their light skin
 *  for exactly this reason — so the paper skin carries hue too, just quietly.
 *  The one thing kept monochrome is the null/untyped case, which reads as ink. */

/** The muted graphite for an untyped / unknown object in the paper skin — the
 *  absence of a hue, read as "ink", never mistaken for a real type colour. */
const LIGHT_INK = "#52525b";

const DARK_TYPE_HUES: Record<string, string> = {
  agency: "#22d3ee",
  contract: "#34d399",
  opportunity: "#f472b6",
  person: "#4aa8ff",
  meeting: "#a78bfa",
  decision: "#fbbf24",
  playbook: "#fb7185",
  customer: "#22d3ee",
  project: "#34d399",
  runbook: "#fb7185",
};
const DARK_FALLBACK = ["#22d3ee", "#4aa8ff", "#a78bfa", "#fbbf24", "#34d399", "#fb7185", "#f472b6"];

/** Paper-skin type hues — the same identities as DARK, one register quieter.
 *  Every value clears 4.5:1 on white so it doubles as pill/label text. */
const LIGHT_TYPE_HUES: Record<string, string> = {
  agency: "#0e7490",
  contract: "#047857",
  opportunity: "#be185d",
  person: "#1d4ed8",
  meeting: "#6d28d9",
  decision: "#92400e",
  playbook: "#be123c",
  customer: "#0e7490",
  project: "#047857",
  runbook: "#be123c",
};
const LIGHT_FALLBACK = [
  "#0e7490",
  "#1d4ed8",
  "#6d28d9",
  "#92400e",
  "#047857",
  "#be123c",
  "#be185d",
];

export function typeHue(name: string | null | undefined, theme: Theme = "dark"): string {
  const known = theme === "light" ? LIGHT_TYPE_HUES : DARK_TYPE_HUES;
  const fallback = theme === "light" ? LIGHT_FALLBACK : DARK_FALLBACK;
  if (!name) return theme === "light" ? LIGHT_INK : "#8b8b98";
  const hit = known[name];
  if (hit) return hit;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return fallback[h % fallback.length] as string;
}

/**
 * Customer-facing name for a type. The brain's internal type names are
 * snake_case identifiers (status_report, mcp_test_gadget) — never show those
 * raw. Prefer the type's own label; otherwise Title-Case the identifier so a
 * customer reads "Status Report", not "status_report".
 */
export function typeLabel(t: { name: string; label?: string | null }): string {
  if (t.label && t.label.trim()) return t.label;
  return t.name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Same, from a bare type name (for places that only have the string). */
export function typeName(name: string | null | undefined): string {
  if (!name) return "";
  return typeLabel({ name });
}

/**
 * Type → emoji icon registry. The types API returns an `icon` per type, but
 * objects (search hits, chips, the object page) only carry a bare type name.
 * So we cache icons by type name whenever a types payload lands, and resolve
 * them anywhere. It's an external store so components re-render when icons
 * arrive after their first paint (e.g. deep-linking straight to an object).
 */
const typeIconMap: Record<string, string> = {};
let typeIconEpoch = 0;
const typeIconListeners = new Set<() => void>();

export function registerTypeIcons(
  types: Array<{ name: string; icon?: string | null }> | null | undefined,
): void {
  if (!types) return;
  let changed = false;
  for (const t of types) {
    const v = t.icon?.trim();
    if (v && typeIconMap[t.name] !== v) {
      typeIconMap[t.name] = v;
      changed = true;
    }
  }
  if (changed) {
    typeIconEpoch += 1;
    for (const l of typeIconListeners) l();
  }
}

export function typeIcon(name: string | null | undefined): string | null {
  if (!name) return null;
  return typeIconMap[name] ?? null;
}

export function subscribeTypeIcons(listener: () => void): () => void {
  typeIconListeners.add(listener);
  return () => {
    typeIconListeners.delete(listener);
  };
}

export function typeIconEpochSnapshot(): number {
  return typeIconEpoch;
}

const DAY_MS = 86_400_000;

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const delta = Date.now() - then;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * DAY_MS) return `${Math.floor(delta / DAY_MS)}d ago`;
  return fmtDate(iso);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return String(n);
  return v.toLocaleString();
}

/** enum value → a stable tint (status pills), per skin. A pipeline board or a
 *  status column is exactly where colour earns its keep: same status, same hue,
 *  every time, so a column of pills scans as colour blocks instead of a wall of
 *  gray you must read one label at a time. Terminal/neutral states (closed,
 *  lost, superseded) stay ink on purpose — "done" is the absence of a live hue. */
const DARK_ENUM_TINTS: Record<string, string> = {
  green: "#34d399",
  yellow: "#fbbf24",
  red: "#fb7185",
  active: "#4aa8ff",
  option_year: "#34d399",
  closeout: "#fbbf24",
  closed: "#8b8b98",
  identified: "#a78bfa",
  capture: "#4aa8ff",
  proposal: "#fbbf24",
  submitted: "#22d3ee",
  won: "#34d399",
  lost: "#8b8b98",
  accepted: "#34d399",
  proposed: "#fbbf24",
  superseded: "#8b8b98",
  civilian: "#4aa8ff",
  defense: "#34d399",
  intel: "#a78bfa",
};
const LIGHT_ENUM_TINTS: Record<string, string> = {
  green: "#047857",
  yellow: "#92400e",
  red: "#be123c",
  active: "#1d4ed8",
  option_year: "#047857",
  closeout: "#92400e",
  closed: LIGHT_INK,
  identified: "#6d28d9",
  capture: "#1d4ed8",
  proposal: "#92400e",
  submitted: "#0e7490",
  won: "#047857",
  lost: LIGHT_INK,
  accepted: "#047857",
  proposed: "#92400e",
  superseded: LIGHT_INK,
  civilian: "#1d4ed8",
  defense: "#047857",
  intel: "#6d28d9",
};
export function enumTint(value: string, theme: Theme = "dark"): string {
  if (theme === "light") return LIGHT_ENUM_TINTS[value] ?? "#6d28d9";
  return DARK_ENUM_TINTS[value] ?? "#a78bfa";
}

/** Flatten markdown syntax out of a body snippet for card previews. */
export function plainSnippet(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
