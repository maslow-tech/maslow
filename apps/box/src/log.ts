/**
 * Metadata-only structured log line: {"evt": "...", ...fields} on stdout —
 * docker stamps the timestamp. Fields carry ids, booleans, durations, counts,
 * and error classes ONLY. NEVER content: no tool arguments, message bodies,
 * emails, setting values, tokens, or provider response bodies — logs must not
 * become a side door around the brain's visibility model.
 */
export function logEvt(
  evt: string,
  fields: Record<string, unknown> = {},
  level: "log" | "warn" = "log",
): void {
  console[level](JSON.stringify({ evt, ...fields }));
}
