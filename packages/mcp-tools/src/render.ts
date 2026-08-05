/**
 * The MCP presentation layer: how a tool result READS to an agent.
 *
 * Every tool result used to hit the wire as JSON.stringify of whatever row
 * shape the reader returned — actor uuids beside actor names, float RRF
 * ranks, and every negative spelled out (`deleted_at:null`, `shared_with:[]`,
 * `links_truncated:false`). This module is the one place that decides how the
 * high-traffic read tools (get / search / recent / list) read on the wire:
 * compact line-oriented text, one line per row. Anything whose shape it
 * doesn't recognize returns null and keeps the JSON fallback — including
 * `recent` with summary:false, where the caller explicitly asked for raw
 * payloads. Errors are NOT rendered here: the BrainError JSON envelope is
 * load-bearing for callers.
 *
 * Two deliberate rules:
 * - Omission is meaning. False/empty/null fields render as nothing and appear
 *   only when they carry signal (deleted, truncated, hidden_from_you > 0,
 *   non-manual provenance).
 * - `get` prints the fetched object's own id in FULL — the deep read is where
 *   an agent picks up the id+version that edit/delete (full-uuid tools) need.
 *   Every other id (links, backlinks, hits, events, list rows) is a 12-hex
 *   short id, which get() resolves as an unambiguous prefix.
 */

import { renderCatalog, type CatalogSnapshot } from "./doctrine.js";

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 8-4 = 12 hex chars (48 bits). At 10k objects the chance of ANY colliding
 *  pair is ~2e-7 (vs ~1% at 8 chars — the reason short ids are 12, not 8). */
const SHORT_ID_CHARS = 13;

export function shortId(v: unknown): string {
  const s = String(v ?? "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) ? s.slice(0, SHORT_ID_CHARS) : s;
}

/** ISO to the minute — seconds/millis/timezone are noise at reading distance. */
function ts(v: unknown): string {
  if (v == null) return "?";
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Anti-forgery: every content value interpolated into a renderer-owned line
 * is flattened first. Under JSON.stringify a newline in a title was escaped;
 * here it would break out of its line and forge protocol text (a fake
 * DELETED marker, a fake batch separator, a fake search row) that agents are
 * taught to trust. Newlines, C0/C1 controls (incl. ANSI ESC), and unicode
 * line separators collapse to a space. Bodies are the one multi-line surface
 * and are neutralized by indentation instead (see renderObject).
 */
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

function clip(s: string, n: number): string {
  const t = oneLine(s);
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** One-line projection of any scalar/array value (prop values, mostly). */
function propVal(v: unknown, max = 200): string {
  if (v == null) return "null";
  if (Array.isArray(v)) return `[${v.map((x) => propVal(x, max)).join(", ")}]`;
  if (v instanceof Date) return ts(v);
  if (typeof v === "object") return clip(JSON.stringify(v), max);
  return clip(String(v).replace(/\s+/g, " ").trim(), max);
}

/** ts_headline emits <b>…</b> around matches; agents read words, not markup. */
function cleanSnippet(v: unknown): string {
  if (typeof v !== "string") return "";
  return clip(
    v
      .replace(/<\/?b>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    160,
  );
}

/**
 * The one entry point: render `out` for the named tool, or return null to
 * keep the JSON fallback. Never throws — an unexpected shape must degrade to
 * JSON, not fail a call that already succeeded.
 */
export function renderToolResult(name: string, args: unknown, out: unknown): string | null {
  const a: Row = isRow(args) ? args : {};
  try {
    switch (name) {
      case "get":
        return renderGet(out);
      case "search":
        return renderSearch(a, out);
      case "recent":
        // summary:false is an explicit ask for raw payloads — don't render.
        return a["summary"] === false ? null : renderRecent(out);
      case "list":
        return renderList(a, out);
      case "catalog":
        return renderCatalogResult(out);
      case "history":
        return renderHistory(out);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---- get ------------------------------------------------------------------

function renderGet(out: unknown): string | null {
  if (Array.isArray(out)) {
    if (!out.every(isRow)) return null;
    return out.map(renderObject).join("\n\n---\n\n");
  }
  return isRow(out) ? renderObject(out) : null;
}

function renderObject(o: Row): string {
  if (o["not_found"] === true) {
    const dym = o["did_you_mean"];
    const hint =
      Array.isArray(dym) && dym.length > 0
        ? ` — did you mean: ${dym.map((x) => String(x)).join(", ")}`
        : "";
    // The echoed id is caller input — flatten + cap it like any content.
    return `${clip(String(o["id"]), 64)}: not found${hint}`;
  }
  const head = [String(o["id"]), String(o["type"] ?? "note"), `v${o["version"]}`];
  head.push(`created ${ts(o["created_at"])}`, `updated ${ts(o["updated_at"])}`);
  if (typeof o["visibility"] === "string" && o["visibility"] !== "org")
    head.push(o["visibility"] as string);
  const lines = [head.join(" · ")];
  if (o["deleted_at"] != null) lines.push(`DELETED ${ts(o["deleted_at"])}`);
  lines.push(`title: ${oneLine(String(o["title"] ?? "(untitled)"))}`);
  // Sharing is first-class on the wire: the audience prints in the EXACT
  // vocabulary `share` accepts (emails for people, slugs for groups), so an
  // agent can read who sees an object and feed it straight back. Rows are an
  // OR of AND-rows: "a@co | pricing + us-person". When present it REPLACES
  // the legacy shared_with uuid line (same fact, unreadable form).
  const aud = o["audience"];
  if (Array.isArray(aud) && aud.length > 0) {
    const rows = aud
      .filter((r): r is string[] => Array.isArray(r) && r.length > 0)
      .map((r) => r.map(String).join(" + "));
    if (rows.length > 0) lines.push(`who can see: ${rows.join(" | ")}`);
  } else {
    const sw = o["shared_with"];
    if (Array.isArray(sw) && sw.length > 0) lines.push(`shared_with: ${sw.join(", ")}`);
  }
  if (isRow(o["props"])) {
    // Unset props (null / empty ref[]) are omitted, not spelled out. Ref
    // values keep FULL uuids — they may be passed to typed where-filters.
    const set = Object.entries(o["props"]).filter(
      ([, v]) => v != null && !(Array.isArray(v) && v.length === 0),
    );
    if (set.length > 0)
      lines.push(`props: ${set.map(([k, v]) => `${k}=${propVal(v, 1000)}`).join(" · ")}`);
  }
  renderEdges(lines, "links", o["links"], o["links_truncated"], "→");
  renderEdges(lines, "backlinks", o["backlinks"], o["backlinks_truncated"], "←");
  if (Array.isArray(o["neighborhood"]) && o["neighborhood"].length > 0) {
    // The hop-2 map (get neighbors:true): one row per object my neighbors
    // link to — enough to pick the next get without a blind fetch.
    const partial =
      o["neighborhood_partial"] === true ? ", partial — seeded from the first 20 links" : "";
    lines.push(`hop2 — what the linked objects link to (${o["neighborhood"].length}${partial}):`);
    for (const n of o["neighborhood"]) {
      if (!isRow(n)) continue;
      const rels = Array.isArray(n["rels"]) ? n["rels"].map(String).join(",") : "";
      lines.push(
        `  ${shortId(n["id"])} · ${n["type"] ?? "note"} · "${clip(String(n["title"] ?? "(untitled)"), 80)}"` +
          `${rels ? ` · ${rels}` : ""} · via ${shortId(n["via"])}`,
      );
    }
  }
  const hidden = o["hidden_from_you"];
  if (typeof hidden === "number" && hidden > 0)
    lines.push(`hidden_from_you: ${hidden} — links from private objects you can't see`);
  if (typeof o["body"] === "string" && o["body"].length > 0) {
    lines.push(
      o["body_truncated"] === true
        ? "body (truncated — get this id alone for the full body):"
        : "body:",
    );
    // Indented verbatim: column 0 stays renderer-owned, so a body can never
    // forge a DELETED line, a batch separator, or the next entry's header.
    for (const bl of o["body"].split("\n")) lines.push(`  ${bl}`);
  }
  return lines.join("\n");
}

function renderEdges(
  lines: string[],
  label: string,
  edges: unknown,
  truncated: unknown,
  arrow: string,
): void {
  if (!Array.isArray(edges) || (edges.length === 0 && truncated !== true)) return;
  lines.push(`${label} (${edges.length}${truncated === true ? "+, truncated" : ""}):`);
  // Sorted by rel so a heavily linked object scans as grouped runs.
  const sorted = edges
    .filter(isRow)
    .slice()
    .sort((a, b) => String(a["rel"]).localeCompare(String(b["rel"])));
  for (const e of sorted) {
    const title = e["target_title"] != null ? `"${clip(String(e["target_title"]), 100)}"` : "";
    const kind = [e["target_type"] ?? "note", shortId(e["id"])].join(" ");
    const flags = [
      e["target_deleted"] === true ? "deleted" : "",
      e["required"] === true ? "required" : "",
      // manual is the default provenance; only ref-mirrored edges annotate.
      typeof e["provenance"] === "string" && e["provenance"] !== "manual"
        ? (e["provenance"] as string)
        : "",
    ].filter(Boolean);
    const suffix = flags.length > 0 ? `, ${flags.join(", ")}` : "";
    lines.push(`  ${e["rel"]} ${arrow} ${title ? `${title} ` : ""}(${kind}${suffix})`);
  }
}

// ---- search ---------------------------------------------------------------

function renderSearch(args: Row, out: unknown): string | null {
  if (!Array.isArray(out)) return null;
  // searchMany (queries without combine) returns per-query groups. The args
  // discriminate the shape exactly — never sniff it off the rows, or a future
  // hit field named `hits` would silently flip the renderer into group mode.
  const grouped = Array.isArray(args["queries"]) && args["combine"] !== true;
  if (grouped && out.length > 0 && out.every((g) => isRow(g) && Array.isArray(g["hits"]))) {
    return out
      .map((g) => renderHitGroup(String((g as Row)["query"]), (g as Row)["hits"] as unknown[]))
      .join("\n\n");
  }
  const q =
    typeof args["query"] === "string"
      ? args["query"]
      : Array.isArray(args["queries"])
        ? args["queries"].map(String).join(" | ")
        : "";
  return renderHitGroup(q, out);
}

function renderHitGroup(query: string, hits: unknown[]): string {
  const head = `${hits.length} hit${hits.length === 1 ? "" : "s"} for "${clip(query, 80)}"`;
  if (hits.length === 0)
    return `${head} — zero hits ≠ doesn't exist: try different words or list by type`;
  return [head, ...hits.filter(isRow).map(hitLine)].join("\n");
}

function hitLine(h: Row): string {
  const bits = [
    shortId(h["id"]),
    String(h["type"] ?? "note"),
    `"${clip(String(h["title"] ?? "(untitled)"), 120)}"`,
    `upd ${ts(h["updated_at"])}`,
  ];
  if (typeof h["connections"] === "number") bits.push(`${h["connections"]} conn`);
  const via = isRow(h["via"]) ? h["via"] : undefined;
  const match = typeof h["match"] === "string" ? h["match"] : via ? "graph" : "";
  if (via) {
    // The seed's whole title used to repeat on every row — clip it hard; the
    // rels are the informative part.
    const seed = typeof via["seed"] === "string" ? ` "${clip(via["seed"], 40)}"` : "";
    const rels = Array.isArray(via["rels"]) ? via["rels"].map(String).join(",") : "";
    bits.push(`${match} via${seed}${rels ? ` (${rels})` : ""}`);
  } else if (match) {
    bits.push(match);
  }
  const snippet = cleanSnippet(h["snippet"]);
  return `${bits.join(" · ")}${snippet ? ` — ${snippet}` : ""}`;
}

// ---- recent ---------------------------------------------------------------

function renderRecent(out: unknown): string | null {
  if (!isRow(out) || !Array.isArray(out["events"])) return null;
  const events = out["events"].filter(isRow);
  const header =
    `${events.length} events · max_seq ${out["max_seq"]}` +
    (out["nextSeq"] != null ? ` · nextSeq ${out["nextSeq"]}` : " · (end)");
  const lines = [header];
  // Collapse consecutive runs on one target by one actor (autosave churn: the
  // same object saved 9 times in a second must read as one line, not nine).
  let i = 0;
  while (i < events.length) {
    let j = i + 1;
    while (j < events.length && sameRun(events[i]!, events[j]!)) j++;
    lines.push(eventLine(events.slice(i, j)));
    i = j;
  }
  return lines.join("\n");
}

function sameRun(a: Row, b: Row): boolean {
  return (
    b["target"] != null &&
    a["target"] === b["target"] &&
    a["actor"] === b["actor"] &&
    a["kind"] === b["kind"] &&
    a["ok"] === b["ok"]
  );
}

function eventLine(run: Row[]): string {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const seqs = run.length === 1 ? String(first["seq"]) : `${first["seq"]}–${last["seq"]}`;
  // A collapsed run may span days, and paging direction flips which end is
  // newest — show both endpoints whenever they differ, in the run's order.
  const when =
    run.length > 1 && ts(first["at"]) !== ts(last["at"])
      ? `${ts(first["at"])}→${ts(last["at"])}`
      : ts(first["at"]);
  const actor =
    typeof first["actor_name"] === "string" && first["actor_name"] !== ""
      ? clip(first["actor_name"], 60)
      : shortId(first["actor"]);
  const kind = String(first["kind"]);
  const times = run.length === 1 ? "" : ` ×${run.length}`;
  let target = "";
  if (first["target"] != null) {
    const title =
      first["target_title"] != null ? `"${clip(String(first["target_title"]), 80)}" ` : "";
    // A deleted target keeps its FULL id: prefix resolution is live-only, so
    // a short id would leave the tombstone unreachable for restore/history.
    const tid =
      first["target_deleted"] === true ? String(first["target"]) : shortId(first["target"]);
    const bits = [first["target_type"], tid].filter((x) => x != null);
    const del = first["target_deleted"] === true ? ", deleted" : "";
    target = ` ${title}(${bits.join(" ")}${del})`;
  } else if (typeof first["schema_type"] === "string") {
    // Schema events touch a TYPE, not an object — say which one.
    target = ` (type ${clip(first["schema_type"], 40)})`;
  }
  let call = "";
  if (kind.startsWith("call:")) {
    const outcome = first["ok"] === undefined ? "" : first["ok"] ? " ok" : " FAIL";
    const ms = typeof first["ms"] === "number" ? ` ${first["ms"]}ms` : "";
    const err = typeof first["error"] === "string" ? ` — ${clip(first["error"], 80)}` : "";
    call = `${outcome}${ms}${err}`;
  }
  return `${seqs} · ${when} · ${actor} · ${kind}${times}${target}${call}`;
}

// ---- catalog / history ----------------------------------------------------

/** The catalog tool reuses start's renderer — one voice for the same data. */
function renderCatalogResult(out: unknown): string | null {
  if (!isRow(out) || !Array.isArray(out["types"]) || !Array.isArray(out["members"])) return null;
  const you = isRow(out["you"]) ? out["you"] : undefined;
  const youLine = you ? `you: ${clip(String(you["name"] ?? "?"), 60)} (${you["role"]})` : "";
  const body = renderCatalog(out as unknown as CatalogSnapshot);
  return youLine ? `${youLine}\n\n${body}` : body;
}

function renderHistory(out: unknown): string | null {
  if (!isRow(out) || !Array.isArray(out["versions"]) || !Array.isArray(out["events"])) return null;
  const lines = [`history of ${String(out["id"])}`];
  const versions = out["versions"].filter(isRow);
  if (versions.length > 0) {
    lines.push(`versions (${versions.length}, newest first — snapshots are the PRIOR state):`);
    for (const v of versions) {
      const by =
        typeof v["by_name"] === "string" && v["by_name"] !== ""
          ? clip(v["by_name"], 60)
          : shortId(v["by"]);
      const snap = isRow(v["snapshot"]) ? v["snapshot"] : {};
      const title = snap["title"] != null ? ` "${clip(String(snap["title"]), 80)}"` : "";
      const body =
        typeof snap["body"] === "string" && snap["body"] !== ""
          ? ` — ${clip(snap["body"], 120)}`
          : "";
      lines.push(`  v${v["version"]} · ${ts(v["at"])} · ${by}${title}${body}`);
    }
  }
  const events = out["events"].filter(isRow);
  if (events.length > 0) {
    lines.push(`events (${events.length}, newest first):`);
    for (const e of events) {
      // Same line grammar as recent; history events carry no target columns,
      // so eventLine renders seq · time · actor · kind (+ call outcome).
      const payload = isRow(e["payload"]) ? e["payload"] : undefined;
      const peek =
        payload && Object.keys(payload).length > 0 && !String(e["kind"]).startsWith("call:")
          ? ` · ${Object.entries(payload)
              .map(([k, v]) => `${k}=${propVal(v, 60)}`)
              .join(" ")}`
          : "";
      lines.push(`  ${eventLine([e])}${peek}`);
    }
  }
  return lines.join("\n");
}

// ---- list -----------------------------------------------------------------

function renderList(args: Row, out: unknown): string | null {
  if (!isRow(out) || !Array.isArray(out["items"])) return null;
  const items = out["items"].filter(isRow);
  const label =
    typeof args["type"] === "string"
      ? args["type"]
      : args["deleted"] === true
        ? "deleted"
        : typeof args["visibility"] === "string"
          ? args["visibility"]
          : "items";
  const head = [`${label}: ${items.length} row${items.length === 1 ? "" : "s"}`];
  if (typeof out["total"] === "number") head.push(`total ${out["total"]}`);
  const lines = [head.join(" · "), ...items.map(listLine)];
  // The cursor is opaque and must round-trip verbatim — own line, never clipped.
  if (typeof out["nextCursor"] === "string" && out["nextCursor"] !== "")
    lines.push(`nextCursor: ${out["nextCursor"]}`);
  return lines.join("\n");
}

function listLine(r: Row): string {
  // Tombstones keep their FULL id — restore needs a full uuid and prefix
  // resolution is deliberately live-only, so a shortened trash row would be
  // unreachable from every rendered surface.
  const bits = [r["deleted_at"] != null ? String(r["id"]) : shortId(r["id"])];
  if (typeof r["type"] === "string") bits.push(r["type"]);
  bits.push(`"${clip(String(r["title"] ?? "(untitled)"), 120)}"`);
  if (r["version"] != null) bits.push(`v${r["version"]}`);
  if (r["updated_at"] != null) bits.push(`upd ${ts(r["updated_at"])}`);
  if (r["deleted_at"] != null) bits.push(`deleted ${ts(r["deleted_at"])}`);
  if (typeof r["visibility"] === "string" && r["visibility"] !== "org")
    bits.push(r["visibility"] as string);
  // The shared_with_me view's whole point is "who shared this" — keep it.
  if (typeof r["created_by"] === "string") bits.push(`by ${shortId(r["created_by"])}`);
  if (isRow(r["props"])) {
    const set = Object.entries(r["props"]).filter(([, v]) => v != null);
    if (set.length > 0) bits.push(set.map(([k, v]) => `${k}=${propVal(v, 120)}`).join(" · "));
  }
  return bits.join(" · ");
}
