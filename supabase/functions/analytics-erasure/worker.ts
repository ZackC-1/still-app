import type { ClaimedErasureJob, ErasureOutcome, ErasureStore } from "../_shared/erasure-store.ts";
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
  /** PostHog delete calls this run made (first deletions share one, up to 1,000 ids; every check
   * is its own call). */
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
  let calls = 0;
  const record = async (job: ClaimedErasureJob, outcome: ErasureOutcome) => {
    const result = await deps.store.recordOutcome(job.job, job.lease, outcome);
    if (!result.recorded) lost += 1;
    else if (outcome === "queued" || outcome === "none_found") advanced += 1;
    else failed += 1;
    if (result.recorded && result.overdue) overdue += 1;
  };
  const remove = async (ids: readonly string[], options: { unmatchedCheck: boolean }) => {
    calls += 1;
    try {
      return await deps.posthog.deleteByDistinctIds(ids, options);
    } catch {
      return "provider_unavailable" as const;
    }
  };
  const alone = async (job: ClaimedErasureJob) => {
    const outcome = await remove(job.targets, { unmatchedCheck: true });
    await record(job, outcome === "bad_request" ? "provider_rejected" : outcome);
  };
  // Only first deletions (stop_recorded) share a call: their outcome only has to prove a deletion
  // was queued. A check (accepted, confirmed, complete) needs evidence about its own ids alone, or a
  // steady stream of new jobs whose persons are found would keep it from ever completing.
  const first = jobs.filter((job) => job.stage === "stop_recorded");
  const checks = jobs.filter((job) => job.stage !== "stop_recorded");
  for (const batch of batchJobs(first)) {
    if (batch.length === 1) {
      await alone(batch[0]!);
      continue;
    }
    const outcome = await remove([...new Set(batch.flatMap((job) => job.targets))], { unmatchedCheck: false });
    if (outcome === "bad_request") {
      // An older PostHog refused the combined request: each job alone, with #305's check.
      for (const job of batch) await alone(job);
      continue;
    }
    for (const job of batch) await record(job, outcome);
  }
  for (const job of checks) await alone(job);
  // A fixed, identifier-free line the operator can alert on.
  if (overdue > 0) console.error(`analytics erasure overdue jobs: ${overdue}`);
  return { claimed: jobs.length, advanced, failed, lost, overdue, batches: calls };
}
