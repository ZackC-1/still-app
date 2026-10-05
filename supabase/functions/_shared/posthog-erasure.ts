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
// persons_deleted, events_queued_for_deletion, deletion_errors) are documented by PostHog or
// observed in its source, and are read with the same rules as the account-deletion path (#305).
// The synthetic provider proof (U5-W5) must confirm them before any erasure capability is marked
// verified. A person deletion says nothing about when PostHog deletes that person's events (a later
// batch), which is why a device is not told "deleted" until 8 days after acceptance (0017).
// Configuration is the same function secrets as posthog.ts.

import type { PostHogConfig } from "./posthog.ts";
import type { ErasureOutcome } from "./erasure-store.ts";

/** PostHog accepts at most this many distinct ids per bulk_delete call. */
export const BULK_DELETE_LIMIT = 1000;

/**
 * The account_created event's uuid on the per-device path. Never an unsalted hash of the account id
 * (that would let anyone holding an account UUID find its event): an HMAC keyed by a server secret
 * (function secret ANALYTICS_EVENT_ID_SECRET) when one is configured, so a retry or a racing request
 * repeats the same uuid and PostHog keeps the event once; otherwise a random uuid (a rare race can
 * then count twice, which only affects a count).
 */
export async function subjectEventId(accountId: string, secret: string | undefined): Promise<string> {
  let bytes: Uint8Array;
  if (secret && secret.trim().length >= 32) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret.trim()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    bytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`still:account_created:${accountId}`)),
    );
  } else {
    bytes = crypto.getRandomValues(new Uint8Array(16));
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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

/**
 * Classify one bulk_delete response, with the same rules the account-deletion path uses (#305):
 *   - a 202 that queued or deleted at least one person, with no deletion_errors (an absent field is
 *     an empty list) and events not refused, is `queued`; fewer queued than found is partial;
 *   - a 202 with `persons_found: 0`, nothing queued or deleted and no errors is `none_found`
 *     (PostHog's current answer for ids with no person);
 *   - deletion_errors, `events_queued_for_deletion: false` or a match that queued nothing is
 *     `provider_partial`; 429 and 5xx are `provider_unavailable`; other statuses are
 *     `provider_rejected` (a 400 first gets the older-PostHog check in bulkDelete);
 *   - anything else is `provider_shape`. Unknown is never success.
 */
export function classifyBulkDelete(status: number, body: unknown): ErasureOutcome {
  if (status === 429 || status >= 500) return "provider_unavailable";
  if (status < 200 || status >= 300) return "provider_rejected";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "provider_shape";
  const b = body as Record<string, unknown>;
  if (b.deletion_errors !== undefined) {
    if (!Array.isArray(b.deletion_errors)) return "provider_shape";
    if (b.deletion_errors.length > 0) return "provider_partial";
  }
  const count = (value: unknown) => (value === undefined ? 0 : Number.isSafeInteger(value) ? value as number : NaN);
  const queued = count(b.persons_queued_for_deletion) + count(b.persons_deleted);
  const found = b.persons_found;
  if (Number.isNaN(queued) || (found !== undefined && (!Number.isSafeInteger(found) || (found as number) < 0))) {
    return "provider_shape";
  }
  if (found === 0) return queued === 0 ? "none_found" : "provider_shape";
  if (queued < 1) return found === undefined ? "provider_shape" : "provider_partial";
  if (b.events_queued_for_deletion === false) return "provider_partial";
  if (found !== undefined && queued < (found as number)) return "provider_partial";
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

async function readJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return null; // not JSON: a shape failure when the status was 2xx
  }
}

export class HttpPostHogErasure implements PostHogSubjectPort, PostHogErasurePort {
  constructor(
    private readonly config: PostHogConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    /** ANALYTICS_EVENT_ID_SECRET (see subjectEventId). Never hardcoded. */
    private readonly eventIdSecret?: string,
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
        uuid: await subjectEventId(options.accountId, this.eventIdSecret),
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
    const body = await readJson(res);
    if (res.status !== 400) return classifyBulkDelete(res.status, body);
    // Older PostHog behaviour (as in #305): with delete_events, ids that match no person were
    // refused with a 400. Ask again without event deletion, which reported the unmatched ids. Only
    // "none of these ids has a person" counts; anything else stays a failure. Caveat carried from
    // #305: if some ids did match, that second call deletes those persons without their events,
    // which the next run cannot re-target by person; it is reported as partial for follow-up.
    let check: Response;
    try {
      check = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.personalApiKey!.trim()}`,
        },
        body: JSON.stringify({ distinct_ids: distinctIds, delete_events: false }),
      });
    } catch {
      return "provider_unavailable";
    }
    const checked = await readJson(check);
    if (!check.ok) return classifyBulkDelete(check.status, checked);
    if (classifyBulkDelete(check.status, checked) === "none_found") return "none_found";
    const unmatched = (checked as { unmatched_distinct_ids?: unknown } | null)?.unmatched_distinct_ids;
    if (Array.isArray(unmatched) && distinctIds.every((id) => unmatched.includes(id))) return "none_found";
    return "provider_partial";
  }
}
