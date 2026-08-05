import type { FeedEvent } from "./api";

/** Event kind → timeline prose. Every live kind gets a mapping; anything new
 *  falls back to the kind with underscores humanized, never raw snake_case. */
export function verb(kind: string): string {
  switch (kind) {
    case "create":
      return "created";
    case "update":
    case "update_props":
    case "edit":
      return "updated";
    case "delete":
      return "deleted";
    case "restore":
      return "restored";
    case "think":
      return "noted";
    case "link":
      return "linked";
    case "unlink":
      return "unlinked";
    case "define_type":
      return "defined type";
    case "add_property":
      return "added a property to";
    case "revoke_account":
      return "revoked";
    default:
      return kind.replace(/_/g, " ");
  }
}

const MERGE_WINDOW_MS = 60_000;
const MERGEABLE = new Set(["update", "update_props"]);

/**
 * One edit produces two events (update + update_props) when it touches both
 * body and props — the timeline showed every edit twice. Merge adjacent
 * mergeable rows by the same actor on the same object within a minute into
 * the newest row, normalized to a plain "update".
 */
export function coalesceFeed(feed: FeedEvent[]): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const e of feed) {
    const prev = out[out.length - 1];
    if (
      prev &&
      MERGEABLE.has(prev.kind) &&
      MERGEABLE.has(e.kind) &&
      prev.actor_name === e.actor_name &&
      prev.target === e.target &&
      Math.abs(new Date(prev.at).getTime() - new Date(e.at).getTime()) <= MERGE_WINDOW_MS
    ) {
      // keep the newest row (feed is newest-first), normalize the kind
      if (prev.kind === "update_props") out[out.length - 1] = { ...prev, kind: "update" };
      continue;
    }
    out.push(e);
  }
  return out;
}
