#!/usr/bin/env node
/**
 * release-gate-cli — the thin I/O + bounded-poll wrapper that
 * release.yml's `verify-gate` job runs before build-sign-publish. It shells to
 * `gh api` (read-only GETs) and feeds the JSON to the PURE, unit-tested decision
 * functions in release-gate.ts. The gate REFUSES to let a tag be signed unless
 * its commit is (1) contained in the default branch AND (2) the target of a
 * FULLY-green required-CI run. Every ambiguity fails CLOSED (refuse), because a
 * false-green here could sign a broken image that self-updates onto a user's box.
 *
 *   node dist/release-gate-cli.js <sha>
 *
 * Env: GITHUB_REPOSITORY, GITHUB_SHA (or argv[2]), DEFAULT_BRANCH (main),
 * REQUIRED_WORKFLOWS (csv, ci.yml), POLL_TIMEOUT (900s), POLL_INTERVAL (30s),
 * ON_MAIN_GRACE (180s), GH_TOKEN. Exit 0 = release may proceed; nonzero = refuse.
 */

import { execFile } from "node:child_process";
import {
  onMainVerdict,
  pickCiRuns,
  ciVerdict,
  type WorkflowRun,
  type JobRun,
} from "./release-gate.js";

interface GhResult {
  readonly ok: boolean;
  readonly json: unknown;
}

/** `gh api <path>` → {ok,json}; NEVER throws into the poll (a transient error is
 *  a retry, never a pass). shell:false argv-array — no injection surface. */
function ghApi(path: string): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile("gh", ["api", path], { shell: false, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, json: null });
      try {
        resolve({ ok: true, json: JSON.parse(stdout) });
      } catch {
        resolve({ ok: false, json: null });
      }
    });
  });
}

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Config {
  repo: string;
  sha: string;
  branch: string;
  workflows: string[];
  pollTimeoutMs: number;
  pollIntervalMs: number;
  onMainGraceMs: number;
}

function loadConfig(argv: string[]): Config {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const sha = argv[2] ?? process.env.GITHUB_SHA ?? "";
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  if (!sha) throw new Error("a commit SHA is required (argv or GITHUB_SHA)");
  return {
    repo,
    sha,
    branch: process.env.DEFAULT_BRANCH ?? "main",
    workflows: (process.env.REQUIRED_WORKFLOWS ?? "ci.yml")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    pollTimeoutMs: num(process.env.POLL_TIMEOUT, 900) * 1000,
    pollIntervalMs: num(process.env.POLL_INTERVAL, 30) * 1000,
    onMainGraceMs: num(process.env.ON_MAIN_GRACE, 180) * 1000,
  };
}

/** All required workflows pass for the SHA? Returns a verdict + the failing/pending wf. */
async function ciGate(
  cfg: Config,
): Promise<{ verdict: "pass" | "fail" | "pending" | "none"; wf: string }> {
  for (const wf of cfg.workflows) {
    const runsRes = await ghApi(
      `repos/${cfg.repo}/actions/workflows/${encodeURIComponent(wf)}/runs?head_sha=${cfg.sha}&per_page=100`,
    );
    if (!runsRes.ok) return { verdict: "pending", wf }; // transient → keep polling, never pass
    const allRuns = ((runsRes.json as { workflow_runs?: WorkflowRun[] }).workflow_runs ??
      []) as WorkflowRun[];
    const runs = pickCiRuns(allRuns, cfg.branch);
    // Fetch each candidate run's jobs (latest attempt) so the all-jobs-success
    // invariant can be checked — a skipped/path-filtered job refuses the release.
    const jobsByRunId: Record<number, JobRun[]> = {};
    for (const run of runs) {
      const jobsRes = await ghApi(
        `repos/${cfg.repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      );
      if (jobsRes.ok)
        jobsByRunId[run.id] = ((jobsRes.json as { jobs?: JobRun[] }).jobs ?? []) as JobRun[];
    }
    const verdict = ciVerdict(runs, jobsByRunId);
    if (verdict !== "pass") return { verdict, wf }; // fail/pending/none on any required wf blocks
  }
  return { verdict: "pass", wf: cfg.workflows.join(",") };
}

async function main(argv: string[]): Promise<number> {
  const cfg = loadConfig(argv);
  const deadline = Date.now() + cfg.pollTimeoutMs;
  const onMainDeadline = Date.now() + cfg.onMainGraceMs;
  let onMain = false;

  for (;;) {
    // (1) ON-MAIN — retry within the grace window to survive post-merge replication lag.
    if (!onMain) {
      const cmp = await ghApi(`repos/${cfg.repo}/compare/${cfg.branch}...${cfg.sha}`);
      const status = cmp.ok ? (cmp.json as { status?: string }).status : undefined;
      const verdict = onMainVerdict(status);
      if (verdict === "on-main") {
        onMain = true;
      } else if (verdict === "not-on-main") {
        return refuse(`commit ${cfg.sha.slice(0, 8)} is not contained in ${cfg.branch}`);
      } else if (Date.now() > onMainDeadline) {
        return refuse(`could not confirm ${cfg.sha.slice(0, 8)} is on ${cfg.branch} within grace`);
      }
    }

    // (2) GREEN-FULL-CI.
    if (onMain) {
      const { verdict, wf } = await ciGate(cfg);
      if (verdict === "pass") {
        process.stdout.write(
          `release-gate: PASS — ${cfg.sha.slice(0, 8)} on ${cfg.branch}, all required CI green\n`,
        );
        return 0;
      }
      if (verdict === "fail") {
        return refuse(`required workflow ${wf} concluded non-success for ${cfg.sha.slice(0, 8)}`);
      }
      // pending / none → keep polling
    }

    if (Date.now() > deadline) {
      return refuse(
        `no successful required run on ${cfg.branch} for ${cfg.sha.slice(0, 8)} within ${cfg.pollTimeoutMs / 1000}s — wait for CI (or re-run it), then re-run the release`,
      );
    }
    process.stderr.write(`release-gate: waiting (on-main=${onMain}) …\n`);
    await sleep(cfg.pollIntervalMs);
  }
}

function refuse(reason: string): number {
  process.stderr.write(`release-gate: REFUSE — ${reason}\n`);
  return 1;
}

// Guarded entry so the CLI can be imported without running.
if (process.argv[1]?.endsWith("release-gate-cli.js")) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`release-gate: fatal ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}

export { main };
