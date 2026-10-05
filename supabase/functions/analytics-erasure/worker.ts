import type { ErasureOutcome, ErasureStore } from "../_shared/erasure-store.ts";
import type { PostHogErasurePort } from "../_shared/posthog-erasure.ts";

// The deletion worker: lease due jobs, ask PostHog to delete every target with its events, record
// one fixed outcome per job. The database owns the stage machine (0017): a first accepted deletion
// moves a job to provider_delete_accepted; a sweep a day later that finds nobody confirms it; sweeps
// at +7 and +35 days complete it; a sweep that finds someone again (a late event) re-deletes and
// re-checks a day later; a failure backs off and never advances. PostHog calls are idempotent, so
// a crash mid-run is safe: the lease expires and the job is claimed again.
//
// Not scheduled here. Who calls it, and how often, is an owner decision (U5-W2 question 7); until
// then it runs only when invoked.

export interface WorkerReport {
  readonly claimed: number;
  readonly advanced: number;
  readonly failed: number;
  readonly lost: number;
  readonly skipped?: "provider_unconfigured";
}

export async function runErasureWorker(deps: {
  readonly store: ErasureStore;
  readonly posthog: PostHogErasurePort;
  readonly limit: number;
  readonly leaseSeconds: number;
}): Promise<WorkerReport> {
  // Without a deletion key nothing is claimed: a job must never look attempted when it was not.
  if (!deps.posthog.canDelete) return { claimed: 0, advanced: 0, failed: 0, lost: 0, skipped: "provider_unconfigured" };
  const jobs = await deps.store.claimWork(deps.limit, deps.leaseSeconds);
  let advanced = 0;
  let failed = 0;
  let lost = 0;
  for (const job of jobs) {
    let outcome: ErasureOutcome;
    try {
      outcome = await deps.posthog.deleteByDistinctIds(job.targets);
    } catch {
      outcome = "provider_unavailable";
    }
    const recorded = await deps.store.recordOutcome(job.job, job.lease, outcome);
    if (!recorded) lost += 1;
    else if (outcome === "queued" || outcome === "none_found") advanced += 1;
    else failed += 1;
  }
  return { claimed: jobs.length, advanced, failed, lost };
}
