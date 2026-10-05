// Server-side PostHog calls for per-device identities and device erasure (U5-W2). Separate from
// posthog.ts, which keeps the released 2.1 behaviour (email on the account person, account
// deletion) unchanged.
//
//   * setSubjectEmail: put the account's email on one device's issued subject (never the account
//     UUID), and the one `account_created` event when the server decided this account is new.
//   * deleteByDistinctIds: bulk_delete persons by distinct id with their events, classified into
//     one fixed outcome word. Only a response that proves the deletion was queued (or that nothing
//     matched) counts; anything else is a failure the worker retries, never "done".
//
// The bulk_delete response fields used here (persons_found, persons_queued_for_deletion,
// events_queued_for_deletion, deletion_errors) are documented by PostHog or observed in its source;
// the synthetic provider proof (U5-W5) must confirm them before any erasure capability is marked
// verified. Configuration is the same function secrets as posthog.ts.

import { accountCreatedEventId, type PostHogConfig } from "./posthog.ts";
import type { ErasureOutcome } from "./erasure-store.ts";

/** PostHog accepts at most this many distinct ids per bulk_delete call. */
export const BULK_DELETE_LIMIT = 1000;

export interface SubjectEmailOptions {
  readonly accountCreated?: boolean;
  /** The account's creation time: the account_created event's timestamp. */
  readonly createdAt?: string | null;
  /** The account UUID: only for the account_created event id, never sent as an identity. */
  readonly accountId: string;
}

export interface PostHogSubjectPort {
  readonly canIdentify: boolean;
  setSubjectEmail(subject: string, email: string, options: SubjectEmailOptions): Promise<void>;
}

export interface PostHogErasurePort {
  readonly canDelete: boolean;
  deleteByDistinctIds(distinctIds: readonly string[]): Promise<ErasureOutcome>;
}

/** Classify one bulk_delete response. Unknown or partial shapes are failures, never success. */
export function classifyBulkDelete(status: number, body: unknown): ErasureOutcome {
  if (status === 429 || status >= 500) return "provider_unavailable";
  if (status < 200 || status >= 300) return "provider_rejected";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "provider_shape";
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.deletion_errors)) return "provider_shape";
  if (b.deletion_errors.length > 0) return "provider_partial";
  const found = b.persons_found;
  const queued = b.persons_queued_for_deletion;
  if (!Number.isSafeInteger(found) || (found as number) < 0) return "provider_shape";
  if (found === 0) return queued === undefined || queued === 0 ? "none_found" : "provider_shape";
  if (!Number.isSafeInteger(queued) || (queued as number) < 0) return "provider_shape";
  if ((queued as number) < (found as number)) return "provider_partial";
  if (queued !== found || b.events_queued_for_deletion !== true) return "provider_shape";
  return "queued";
}

/** Several calls' outcomes as one: any failure wins (unavailable first, so it is retried soonest
 * after a transient fault), then a queued deletion, and only all-none_found is none_found. */
export function combineOutcomes(outcomes: readonly ErasureOutcome[]): ErasureOutcome {
  for (
    const failure of ["provider_unavailable", "provider_rejected", "provider_partial", "provider_shape"] as const
  ) {
    if (outcomes.includes(failure)) return failure;
  }
  return outcomes.includes("queued") ? "queued" : "none_found";
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "");

export class HttpPostHogErasure implements PostHogSubjectPort, PostHogErasurePort {
  constructor(
    private readonly config: PostHogConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get canIdentify(): boolean {
    return Boolean(this.config.projectKey?.trim() && this.config.host?.trim());
  }

  get canDelete(): boolean {
    return Boolean(
      this.config.personalApiKey?.trim() && this.config.apiHost?.trim() && /^\d+$/.test(this.config.projectId ?? ""),
    );
  }

  async setSubjectEmail(subject: string, email: string, options: SubjectEmailOptions): Promise<void> {
    if (!this.canIdentify) return;
    if (subject === options.accountId) throw new Error("A subject is never the account id");
    const timestamp = new Date().toISOString();
    const common = { distinct_id: subject, $lib: "still-server", $geoip_disable: true };
    const batch: unknown[] = [{ event: "$set", properties: { ...common, $set: { email } }, timestamp }];
    if (options.accountCreated) {
      const created = options.createdAt && Number.isFinite(Date.parse(options.createdAt))
        ? new Date(options.createdAt).toISOString()
        : timestamp;
      batch.push({
        event: "account_created",
        uuid: await accountCreatedEventId(options.accountId),
        properties: common,
        timestamp: created,
      });
    }
    const res = await this.fetchImpl(`${trimSlash(this.config.host!)}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.config.projectKey!.trim(), batch }),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`PostHog identify failed: ${res.status}`);
  }

  async deleteByDistinctIds(distinctIds: readonly string[]): Promise<ErasureOutcome> {
    if (!this.canDelete) return "provider_unavailable";
    if (distinctIds.length === 0) return "none_found";
    const outcomes: ErasureOutcome[] = [];
    for (let i = 0; i < distinctIds.length; i += BULK_DELETE_LIMIT) {
      outcomes.push(await this.bulkDelete(distinctIds.slice(i, i + BULK_DELETE_LIMIT)));
      if (outcomes.at(-1) !== "queued" && outcomes.at(-1) !== "none_found") break;
    }
    return combineOutcomes(outcomes);
  }

  private async bulkDelete(distinctIds: readonly string[]): Promise<ErasureOutcome> {
    const url = `${trimSlash(this.config.apiHost!)}/api/projects/${this.config.projectId}/persons/bulk_delete/`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.personalApiKey!.trim()}`,
        },
        // Replay is off for Still; delete_recordings is belt and braces.
        body: JSON.stringify({ distinct_ids: distinctIds, delete_events: true, delete_recordings: true }),
      });
    } catch {
      return "provider_unavailable";
    }
    let body: unknown = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      /* not JSON: classified as a shape failure below when the status was 2xx */
    }
    return classifyBulkDelete(res.status, body);
  }
}
