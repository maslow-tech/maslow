/**
 * Release-gate decision logic — pure, unit-tested functions
 * the CLI (release-gate-cli.ts) drives from `gh api` output. Kept here in the
 * updater package (where release/version logic lives + `test:unit` actually
 * runs) so the truth table is exercised in CI, not a dead test/ file.
 *
 * The gate refuses to build-sign-publish a tag unless its commit is (1) ON the
 * default branch and (2) the target of a FULLY-green required-CI run. Every
 * ambiguity fails CLOSED.
 */

type OnMainVerdict = "on-main" | "not-on-main" | "unknown";

/** GitHub `compare` .status → on-main verdict. identical/behind ⇒ the SHA is
 *  contained in the branch; ahead/diverged ⇒ it is not; anything else ⇒ unknown
 *  (the CLI retries within a grace window before refusing). */
export function onMainVerdict(status: string | null | undefined): OnMainVerdict {
  if (status === "identical" || status === "behind") return "on-main";
  if (status === "ahead" || status === "diverged") return "not-on-main";
  return "unknown";
}

export interface WorkflowRun {
  readonly id: number;
  readonly event?: string | null;
  readonly head_branch?: string | null;
  readonly conclusion?: string | null;
  readonly status?: string | null;
}
export interface JobRun {
  readonly conclusion?: string | null;
}

/** Only push runs on the default branch count (a PR run or a run on another
 *  branch is not the release gate). */
export function pickCiRuns(runs: readonly WorkflowRun[], branch: string): WorkflowRun[] {
  return runs.filter((r) => r.event === "push" && r.head_branch === branch);
}

type CiVerdict = "pass" | "fail" | "pending" | "none";

// Only the literal string "success" is a success — null/undefined/"" never are.
const isSuccess = (c: string | null | undefined): boolean => c === "success";

/**
 * pass  = ANY run whose conclusion is success AND every one of its jobs is
 *         success (closes "workflow success != all jobs ran" — a skipped/
 *         path-filtered job refuses the release, the safe direction).
 * fail  = a CONCLUDED non-success run exists and there is NO pass run.
 * pending = a queued/in_progress run exists with no pass (keep polling).
 * none  = no matching runs at all.
 */
export function ciVerdict(
  runs: readonly WorkflowRun[],
  jobsByRunId: Readonly<Record<number, readonly JobRun[]>>,
): CiVerdict {
  if (runs.length === 0) return "none";
  const allJobsGreen = (run: WorkflowRun): boolean => {
    const jobs = jobsByRunId[run.id];
    // No jobs known for a "successful" run ⇒ don't trust it (fail closed).
    return jobs !== undefined && jobs.length > 0 && jobs.every((j) => isSuccess(j.conclusion));
  };
  const hasPass = runs.some((r) => isSuccess(r.conclusion) && allJobsGreen(r));
  if (hasPass) return "pass";
  // A run is "concluded" once GitHub sets status=completed (conclusion present).
  const hasConcludedNonSuccess = runs.some(
    (r) => r.status === "completed" && !isSuccess(r.conclusion),
  );
  if (hasConcludedNonSuccess) return "fail";
  const hasPending = runs.some((r) => r.status === "queued" || r.status === "in_progress");
  return hasPending ? "pending" : "fail";
}
