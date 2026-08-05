import { describe, expect, it } from "vitest";
import { recordBoxError, snapshotBoxErrors } from "./errors.js";
import type { BoxErrorReport } from "@brain/shared";

describe("box error rollup (fleet channel)", () => {
  it("merges counts by code|note and drains on snapshot", () => {
    snapshotBoxErrors(); // clean slate
    recordBoxError({ code: "auth_rejected", count: 1 });
    recordBoxError({ code: "auth_rejected", count: 2 });
    recordBoxError({ code: "db_deadlock", count: 1, note: "type_id=7" });
    const snap = snapshotBoxErrors();
    expect(snap).toContainEqual({ code: "auth_rejected", count: 3 });
    expect(snap).toContainEqual({ code: "db_deadlock", count: 1, note: "type_id=7" });
    expect(snapshotBoxErrors()).toEqual([]); // drained
  });

  it("drops a malformed entry instead of letting it 400 the WHOLE heartbeat", () => {
    snapshotBoxErrors();
    recordBoxError({ code: "auth_rejected", count: 1 });
    // a bug hands us garbage — the snapshot must filter it, not ship it
    recordBoxError({ code: "not-a-real-code", count: 1 } as unknown as BoxErrorReport);
    recordBoxError({ code: "internal_error", count: -5 } as unknown as BoxErrorReport);
    const snap = snapshotBoxErrors();
    expect(snap).toEqual([{ code: "auth_rejected", count: 1 }]);
  });

  it("caps distinct keys — a note-flood cannot grow the map unbounded", () => {
    snapshotBoxErrors();
    for (let i = 0; i < 200; i++) {
      recordBoxError({ code: "internal_error", count: 1, note: `type_id=${i}` });
    }
    expect(snapshotBoxErrors().length).toBeLessThanOrEqual(64);
  });
});
