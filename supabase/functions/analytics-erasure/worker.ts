import type { ErasureOutcome, ErasureStore } from "../_shared/erasure-store.ts";
import { BULK_DELETE_LIMIT, type PostHogErasurePort } from "../_shared/posthog-erasure.ts";

// The deletion worker: lease due jobs (those deleting issued subjects first), ask PostHog to delete
// every target with its events, record one fixed outcome per job. The database owns the stage
// machine (0017): a first accepted deletion moves a job to provider_delete_accepted; a sweep a day
// later that finds nobody confirms the persons are gone; a sweep at least 8 days after acceptance
// that finds nobody completes it (PostHog deletes events in a later batch); a last sweep at +35
// days ends the work; a sweep that finds someone again (a late event) re-deletes and re-checks a day
// later; a failure backs off, never advances, and from the fifth in a row is reported overdue.
// PostHog calls are idempotent, so a crash mid-run is safe: the lease expires and the job is
// claimed again.
//
// Not scheduled here. Who calls it, and how often, is an owner decision (U5-W2 question 7); until
// then it runs only when invoked.

export interface WorkerReport {
  readonly claimed: number;
  readonly advanced: number;
  readonly failed: number;
  readonly lost: number;
  /** Jobs that have now failed five or more times in a row (alert; retried with backoff). */
  readonly overdue: number;
  /** PostHog bulk_delete batches this run made (several jobs share one, up to 1,000 ids). */
  readonly batches?: number;
  readonly skipped?: "provider_unconfigured";
}

/** Group jobs so each batch names at most `limit` distinct ids; a larger job goes alone (the
 * adapter splits it). Exported for tests. */
export function batchJobs<T extends { readonly targets: readonly string[] }>(jobs: readonly T[], limit = BULK_DELETE_LIMIT): T[][] {
  const batches: { jobs: T[]; ids: Set<string> }[] = [];
  for (const job of jobs) {
    const fit = batches.find((b) => {
      const extra = job.targets.filter((id) => !b.ids.has(id)).length;
      return b.ids.size + extra <= limit;
    });
    if (fit) {
      fit.jobs.push(job);
      for (const id of job.targets) fit.ids.add(id);
    } else {
      batches.push({ jobs: [job], ids: new Set(job.targets) });
    }
  }
  return batches.map((b) => b.jobs);
}

export async function runErasureWorker(deps: {
  readonly store: ErasureStore;
  readonly posthog: PostHogErasurePort;
  readonly limit: number;
  readonly leaseSeconds: number;
}): Promise<WorkerReport> {
  // Without a deletion key nothing is claimed: a job must never look attempted when it was not.
  if (!deps.posthog.canDelete) {
    return { claimed: 0, advanced: 0, failed: 0, lost: 0, overdue: 0, skipped: "provider_unconfigured" };
  }
  const jobs = await deps.store.claimWork(deps.limit, deps.leaseSeconds);
  let advanced = 0;
  let failed = 0;
  let lost = 0;
  let overdue = 0;
  const batches = batchJobs(jobs);
  for (const batch of batches) {
    // One call for the batch. Its outcome is recorded for every job in it: "none_found" only when
    // no id of any job matched, so a job is never advanced on another job's evidence; a person
    // found for one job makes every job in the batch re-check a day later (conservative).
    let outcome: ErasureOutcome;
    try {
      outcome = await deps.posthog.deleteByDistinctIds([...new Set(batch.flatMap((job) => job.targets))]);
    } catch {
      outcome = "provider_unavailable";
    }
    for (const job of batch) {
      const result = await deps.store.recordOutcome(job.job, job.lease, outcome);
      if (!result.recorded) lost += 1;
      else if (outcome === "queued" || outcome === "none_found") advanced += 1;
      else failed += 1;
      if (result.recorded && result.overdue) overdue += 1;
    }
  }
  // A fixed, identifier-free line the operator can alert on.
  if (overdue > 0) console.error(`analytics erasure overdue jobs: ${overdue}`);
  return { claimed: jobs.length, advanced, failed, lost, overdue, batches: batches.length };
}
