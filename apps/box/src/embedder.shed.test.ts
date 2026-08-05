import { describe, expect, it, vi } from "vitest";
import { startEmbedSweep } from "./embedder.js";

/**
 * The embed sweep PAUSES under disk write-shed: when
 * shouldShed() is true it skips the tick entirely (never queries the DB for due
 * rows), so the biggest re-derivable filler stops adding pressure while the box
 * is near-full. Due rows stay due and resume when the shed clears.
 */
describe("embed sweep — disk write-shed", () => {
  it("skips the DB query while shedding, and queries once the shed clears", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const ownerClient = { query } as unknown as import("pg").Client;
    let shedding = true;

    const sweep = startEmbedSweep({
      ownerClient,
      embedder: {
        embedQuery: async () => [],
        embedDocument: async () => [],
      } as unknown as import("./embedder.js").Embedder,
      intervalMs: 5,
      log: () => {},
      shouldShed: async () => shedding,
    });

    // First tick runs immediately on start; give the microtasks a beat.
    await new Promise((r) => setTimeout(r, 20));
    expect(query).not.toHaveBeenCalled(); // shedding → never touched the DB

    shedding = false;
    await new Promise((r) => setTimeout(r, 30)); // let a post-shed tick fire
    expect(query).toHaveBeenCalled(); // resumed once pressure cleared
    sweep.stop();
  });
});
