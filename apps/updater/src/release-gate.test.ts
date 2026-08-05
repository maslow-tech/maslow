import { describe, expect, it } from "vitest";
import { ciVerdict, onMainVerdict, pickCiRuns, type WorkflowRun } from "./release-gate.js";

describe("onMainVerdict", () => {
  it("identical/behind → on-main; ahead/diverged → not-on-main; else unknown", () => {
    expect(onMainVerdict("identical")).toBe("on-main");
    expect(onMainVerdict("behind")).toBe("on-main");
    expect(onMainVerdict("ahead")).toBe("not-on-main");
    expect(onMainVerdict("diverged")).toBe("not-on-main");
    expect(onMainVerdict("")).toBe("unknown");
    expect(onMainVerdict(null)).toBe("unknown");
    expect(onMainVerdict(undefined)).toBe("unknown");
  });
});

describe("pickCiRuns", () => {
  it("keeps only push runs on the target branch", () => {
    const runs: WorkflowRun[] = [
      { id: 1, event: "push", head_branch: "main" },
      { id: 2, event: "pull_request", head_branch: "main" },
      { id: 3, event: "push", head_branch: "feature" },
    ];
    expect(pickCiRuns(runs, "main").map((r) => r.id)).toEqual([1]);
  });
});

describe("ciVerdict — fail-closed truth table", () => {
  const jobs = (arr: (string | null)[]) => arr.map((c) => ({ conclusion: c }));

  it("no runs → none", () => {
    expect(ciVerdict([], {})).toBe("none");
  });

  it("a fully-green run → pass", () => {
    const runs: WorkflowRun[] = [{ id: 1, status: "completed", conclusion: "success" }];
    expect(ciVerdict(runs, { 1: jobs(["success", "success"]) })).toBe("pass");
  });

  it("a cancelled-only run → fail (not pass)", () => {
    const runs: WorkflowRun[] = [{ id: 1, status: "completed", conclusion: "cancelled" }];
    expect(ciVerdict(runs, { 1: jobs(["success"]) })).toBe("fail");
  });

  it("cancelled + a later success → pass (any-success across reruns)", () => {
    const runs: WorkflowRun[] = [
      { id: 1, status: "completed", conclusion: "cancelled" },
      { id: 2, status: "completed", conclusion: "success" },
    ];
    expect(ciVerdict(runs, { 1: jobs(["cancelled"]), 2: jobs(["success", "success"]) })).toBe(
      "pass",
    );
  });

  it("a 'successful' run with one skipped job → NOT pass (all-jobs invariant)", () => {
    const runs: WorkflowRun[] = [{ id: 1, status: "completed", conclusion: "success" }];
    expect(ciVerdict(runs, { 1: jobs(["success", "skipped"]) })).toBe("fail");
  });

  it("a 'successful' run with NO known jobs → NOT pass (fail closed)", () => {
    const runs: WorkflowRun[] = [{ id: 1, status: "completed", conclusion: "success" }];
    expect(ciVerdict(runs, {})).toBe("fail");
  });

  it("a concluded failure with no success → fail", () => {
    const runs: WorkflowRun[] = [{ id: 1, status: "completed", conclusion: "failure" }];
    expect(ciVerdict(runs, { 1: jobs(["failure"]) })).toBe("fail");
  });

  it("queued/in_progress with no success → pending", () => {
    expect(ciVerdict([{ id: 1, status: "queued" }], {})).toBe("pending");
    expect(ciVerdict([{ id: 1, status: "in_progress" }], {})).toBe("pending");
  });

  it("null/'' conclusion can never satisfy pass", () => {
    const runs: WorkflowRun[] = [
      { id: 1, status: "completed", conclusion: null },
      { id: 2, status: "completed", conclusion: "" },
    ];
    expect(ciVerdict(runs, { 1: jobs([null]), 2: jobs([""]) })).toBe("fail");
  });
});
