import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assertBudgetLadder,
  COLLAB_DRAIN_BUDGET_MS,
  COLLAB_FLUSH_BUDGET_MS,
  COMPOSE_STOP_GRACE_SECONDS,
  createShutdown,
  SHUTDOWN_BUDGET_MS,
} from "./shutdown.js";

/**
 * The failure this file exists to prevent is invisible in production: a
 * self-update SIGTERMs the box, a stage hangs, docker SIGKILLs it, and the last
 * paragraph of everyone who was typing is gone with no error anywhere. So the
 * assertions are about the properties that keep it bounded — ordering,
 * budgets, and "one bad stage never takes the others down" — plus the two
 * files (compose, Caddyfile) that have to agree with them.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A promise that never settles — the wedged-database stand-in. */
const wedged = (): Promise<void> => new Promise<void>(() => {});

describe("createShutdown", () => {
  it("flips readiness synchronously, before any stage runs", () => {
    const order: string[] = [];
    const drain = createShutdown({
      stages: [
        {
          name: "rooms",
          budgetMs: 50,
          run: async () => {
            await Promise.resolve();
            order.push("rooms");
          },
        },
      ],
      onDrainStart: () => order.push("not-ready"),
      exit: () => order.push("exit"),
      log: () => {},
      warn: () => {},
    });

    drain("SIGTERM");
    // Not "eventually": the very next /healthz probe must already see the
    // drain, so the flip cannot be behind an await.
    expect(order).toEqual(["not-ready"]);
  });

  it("runs stages in order — rooms before the audit queue — then exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const drain = createShutdown({
      stages: [
        {
          name: "collab rooms",
          budgetMs: 100,
          run: async () => {
            await Promise.resolve();
            order.push("collab rooms");
          },
        },
        {
          name: "call-audit queue",
          budgetMs: 100,
          run: async () => {
            order.push("call-audit queue");
          },
        },
      ],
      exit,
      log: () => {},
      warn: () => {},
    });

    drain("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(order).toEqual(["collab rooms", "call-audit queue"]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("a wedged stage is bounded and the LATER stages still run", async () => {
    const ran: string[] = [];
    const exit = vi.fn();
    const drain = createShutdown({
      stages: [
        { name: "collab rooms", budgetMs: 20, run: wedged },
        {
          name: "call-audit queue",
          budgetMs: 50,
          run: async () => {
            ran.push("call-audit queue");
          },
        },
      ],
      totalBudgetMs: 500,
      exit,
      log: () => {},
      warn: () => {},
    });

    drain("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    // A database that will not answer must not cost the audit flush too.
    expect(ran).toEqual(["call-audit queue"]);
  });

  it("a stage that throws is logged, not fatal, and does not stop the next", async () => {
    const ran: string[] = [];
    const warn = vi.fn();
    const exit = vi.fn();
    const drain = createShutdown({
      stages: [
        {
          name: "collab rooms",
          budgetMs: 50,
          run: async () => {
            throw new Error("flush exploded");
          },
        },
        {
          name: "call-audit queue",
          budgetMs: 50,
          run: async () => {
            ran.push("call-audit queue");
          },
        },
      ],
      exit,
      log: () => {},
      warn,
    });

    drain("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(ran).toEqual(["call-audit queue"]);
    expect(warn.mock.calls.flat().join(" ")).toContain("flush exploded");
  });

  it("exits inside the overall budget even when every stage hangs", async () => {
    const exit = vi.fn();
    const drain = createShutdown({
      stages: [
        { name: "collab rooms", budgetMs: 10_000, run: wedged },
        { name: "call-audit queue", budgetMs: 10_000, run: wedged },
      ],
      totalBudgetMs: 40,
      exit,
      log: () => {},
      warn: () => {},
    });

    const started = Date.now();
    drain("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    // The stage bounds are far past the ceiling; the watchdog is what fires.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("a second signal exits immediately, and exit is still called once", async () => {
    const exit = vi.fn();
    const drain = createShutdown({
      stages: [{ name: "collab rooms", budgetMs: 10_000, run: wedged }],
      totalBudgetMs: 10_000,
      exit,
      log: () => {},
      warn: () => {},
    });

    drain("SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    drain("SIGTERM");
    expect(exit).toHaveBeenCalledWith(0);
    drain("SIGTERM");
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("the shutdown budget ladder", () => {
  it("holds for the shipped constants", () => {
    expect(assertBudgetLadder()).toEqual([]);
  });

  it("catches an inverted ladder", () => {
    const problems = assertBudgetLadder({
      collabFlushMs: 30_000,
      collabDrainMs: 20_000,
      auditFlushMs: 5_000,
      totalMs: 30_000,
      stopGraceSeconds: 10,
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("compose gives the app a stop grace that covers the whole drain", () => {
    const compose = readFileSync(join(repoRoot, "deploy", "docker-compose.yml"), "utf8");
    const grace = /^\s{4}stop_grace_period:\s*(\d+)s\s*$/m.exec(compose);
    expect(grace?.[1]).toBe(String(COMPOSE_STOP_GRACE_SECONDS));
    // Docker's 10s default would SIGKILL the box mid-flush on every release.
    expect(Number(grace?.[1]) * 1000).toBeGreaterThan(SHUTDOWN_BUDGET_MS);
    expect(COLLAB_FLUSH_BUDGET_MS).toBeLessThan(COLLAB_DRAIN_BUDGET_MS);
  });

  it("caddy health-checks /healthz, so the not-ready flip actually reroutes", () => {
    const caddyfile = readFileSync(join(repoRoot, "deploy", "Caddyfile"), "utf8");
    expect(caddyfile).toMatch(/health_uri\s+\/healthz/);
    expect(caddyfile).toMatch(/health_interval\s+10s/);
    // No proxy read/write timeout may be introduced: either would sever a
    // long-lived idle collab websocket at that interval (caddy's default is
    // no timeout, which is what a websocket needs).
    expect(caddyfile).not.toMatch(/^\s*(read_timeout|write_timeout)\s/m);
  });
});
