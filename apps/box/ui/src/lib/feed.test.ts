import { describe, expect, it } from "vitest";
import { coalesceFeed, verb } from "./feed";
import type { FeedEvent } from "./api";

const ev = (over: Partial<FeedEvent>): FeedEvent =>
  ({
    seq: "1",
    at: "2026-07-15T17:56:00Z",
    kind: "update",
    actor_name: "Ishaan Sharma",
    target: "t1",
    target_title: "BUG: something",
    target_type: "task",
    target_deleted: false,
    ...over,
  }) as FeedEvent;

describe("verb — every live kind renders as prose, never a raw snake_case kind", () => {
  it("maps the kinds the events table actually contains", () => {
    expect(verb("create")).toBe("created");
    expect(verb("update")).toBe("updated");
    expect(verb("update_props")).toBe("updated");
    expect(verb("delete")).toBe("deleted");
    expect(verb("restore")).toBe("restored");
    expect(verb("think")).toBe("noted");
    expect(verb("define_type")).toBe("defined type");
    expect(verb("add_property")).toBe("added a property to");
    expect(verb("revoke_account")).toBe("revoked");
  });
  it("falls back to a de-snake-cased kind, not the raw string", () => {
    expect(verb("some_new_kind")).toBe("some new kind");
  });
});

describe("coalesceFeed — one edit shows as one row", () => {
  it("merges an adjacent update + update_props pair by the same actor on the same object", () => {
    const feed = [
      ev({ seq: "10", kind: "update_props" }),
      ev({ seq: "9", kind: "update" }),
      ev({ seq: "8", kind: "update", actor_name: "Alice", target: "t2", target_title: "Other" }),
    ];
    const out = coalesceFeed(feed);
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe("update");
    expect(out[0]!.seq).toBe("10"); // keeps the newest row's identity
  });

  it("does not merge different actors or different targets", () => {
    const feed = [
      ev({ seq: "10", kind: "update_props" }),
      ev({ seq: "9", kind: "update", actor_name: "Someone Else" }),
    ];
    expect(coalesceFeed(feed)).toHaveLength(2);
  });

  it("does not merge events more than a minute apart", () => {
    const feed = [
      ev({ seq: "10", kind: "update_props", at: "2026-07-15T17:56:00Z" }),
      ev({ seq: "9", kind: "update", at: "2026-07-15T17:53:00Z" }),
    ];
    expect(coalesceFeed(feed)).toHaveLength(2);
  });
});
