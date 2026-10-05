// Server-side PostHog calls. Two jobs, both keyed by the Supabase user UUID the verified JWT proved:
//
//   * Put the account's email on its PostHog person. The apps and extensions never send an email
//     to PostHog; the server does it here, so no client needs a personal-data permission for it.
//   * Delete the person and their events when the account is deleted (Guideline 5.1.1(v), GDPR).
//
// Configuration (function secrets):
//   POSTHOG_PROJECT_KEY    project API key (public, write-only ingestion)
//   POSTHOG_HOST           ingestion host, e.g. https://us.i.posthog.com
//   POSTHOG_API_HOST       private API host, e.g. https://us.posthog.com
//   POSTHOG_PROJECT_ID     numeric project id
//   POSTHOG_PERSONAL_API_KEY  personal key limited to person:write (deletion only)
// A missing value disables that job: `configured` reports it, and callers skip rather than fail.

export interface PostHogPort {
  readonly canIdentify: boolean;
  readonly canDelete: boolean;
  /** Put the email on the account's person; with `accountCreated`, also record the one
   * `account_created` event for that account (the server decides, once per account). */
  setPersonEmail(userId: string, email: string, options?: AccountCreatedOptions): Promise<void>;
  /** Delete the person and queue deletion of their events. Resolves when PostHog accepted it, or
   * when PostHog matched no person (nothing to delete). Rejects with a PostHogDeletionError whose
   * `reason` is the only thing safe to log. */
  deletePerson(userId: string): Promise<void>;
}

export interface AccountCreatedOptions {
  readonly accountCreated?: boolean;
  /** The account's creation time: the event's timestamp, so every copy of it is identical. */
  readonly createdAt?: string | null;
}

/** A UUID derived from the account id, so two racing requests produce the same event, which PostHog
 * keeps once (it deduplicates identical uuid, distinct id, event and timestamp). */
export async function accountCreatedEventId(userId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`still:account_created:${userId}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5 layout
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface PostHogConfig {
  readonly projectKey?: string;
  readonly host?: string;
  readonly apiHost?: string;
  readonly projectId?: string;
  readonly personalApiKey?: string;
}

export function postHogConfigFromEnv(env: (name: string) => string | undefined): PostHogConfig {
  return {
    projectKey: env("POSTHOG_PROJECT_KEY"),
    host: env("POSTHOG_HOST"),
    apiHost: env("POSTHOG_API_HOST"),
    projectId: env("POSTHOG_PROJECT_ID"),
    personalApiKey: env("POSTHOG_PERSONAL_API_KEY"),
  };
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "");

export class HttpPostHog implements PostHogPort {
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

  async setPersonEmail(userId: string, email: string, options: AccountCreatedOptions = {}): Promise<void> {
    if (!this.canIdentify) return;
    const timestamp = new Date().toISOString();
    const common = { distinct_id: userId, $lib: "still-server", $geoip_disable: true };
    const batch: unknown[] = [{ event: "$set", properties: { ...common, $set: { email } }, timestamp }];
    if (options.accountCreated) {
      const created = options.createdAt && Number.isFinite(Date.parse(options.createdAt))
        ? new Date(options.createdAt).toISOString()
        : timestamp;
      batch.push({ event: "account_created", uuid: await accountCreatedEventId(userId), properties: common, timestamp: created });
    }
    const res = await this.fetchImpl(`${trimSlash(this.config.host!)}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.config.projectKey!.trim(), batch }),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`PostHog identify failed: ${res.status}`);
  }

  async deletePerson(userId: string): Promise<void> {
    if (!this.canDelete) return;
    const first = await this.bulkDelete(userId, true);
    if (first.ok) {
      // A 202 can still carry failures: PostHog reports them in deletion_errors, and a match that
      // queued nothing is not a deletion either. Retry once, then report. A 202 that matched no
      // person at all (someone who never shared usage, or whose person is already gone) is done:
      // there is nothing to delete (see nothingToDelete).
      if (deletionAccepted(first.body) || nothingToDelete(first.body)) return;
      const retry = await this.bulkDelete(userId, true);
      if (retry.ok && (deletionAccepted(retry.body) || nothingToDelete(retry.body))) return;
      throw new PostHogDeletionError(retry.ok ? notQueuedReason(retry.body) : statusReason(retry.status));
    }
    if (first.status !== 400) throw new PostHogDeletionError(statusReason(first.status));
    // Older PostHog behaviour: with delete_events, ids that match no person were refused with a
    // 400. Ask again without event deletion, which reported the unmatched ids. Only an explicit
    // "no such person" counts as done; anything else is a real failure to log.
    const check = await this.bulkDelete(userId, false);
    if (check.ok) {
      if (nothingToDelete(check.body)) return;
      const unmatched = (check.body as { unmatched_distinct_ids?: unknown } | null)?.unmatched_distinct_ids;
      if (Array.isArray(unmatched) && unmatched.includes(userId)) return;
      // It matched after all (and is now deleted), but its events were not queued for deletion.
      throw new PostHogDeletionError("events_not_queued");
    }
    throw new PostHogDeletionError(statusReason(check.status));
  }

  private async bulkDelete(
    userId: string,
    deleteEvents: boolean,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const url = `${trimSlash(this.config.apiHost!)}/api/projects/${this.config.projectId}/persons/bulk_delete/`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.personalApiKey!.trim()}`,
        },
        body: JSON.stringify({ distinct_ids: [userId], delete_events: deleteEvents }),
      });
    } catch {
      // The raw error can carry the request URL; only the category leaves this function.
      throw new PostHogDeletionError("network");
    }
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, body };
  }
}

/** Whether an accepted bulk_delete actually queued this person's deletion. PostHog's documented
 * success signal is persons_queued_for_deletion (or persons_deleted); failures appear in
 * deletion_errors. A body that proves neither is not a deletion: the failure is logged for follow-up
 * rather than reported as done. */
export function deletionAccepted(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.deletion_errors) && b.deletion_errors.length > 0) return false;
  const queued = (typeof b.persons_queued_for_deletion === "number" ? b.persons_queued_for_deletion : 0) +
    (typeof b.persons_deleted === "number" ? b.persons_deleted : 0);
  if (queued < 1) return false;
  if (b.events_queued_for_deletion === false) return false;
  return true;
}

/**
 * Whether an accepted bulk_delete matched no person, so there is nothing to delete: the account
 * never shared usage (no events, so no person), or its person was already deleted.
 *
 * PostHog's current answer for such ids is a 202 with `persons_found: 0`, nothing queued or deleted,
 * and an empty `deletion_errors`; it no longer answers 400. Evidence (read 2026-10-05):
 *   - Docs, posthog.com `contents/docs/privacy/data-storage.mdx`, "Bulk delete response": the
 *     endpoint "returns a 202 once the request is accepted"; `persons_found` is the "Number of
 *     persons matched by the provided IDs or distinct IDs"; failures are reported "in
 *     deletion_errors rather than with an error status".
 *   - Source, PostHog/posthog `posthog/api/person.py` `_queue_bulk_delete_persons` (and the
 *     synchronous `_bulk_delete_persons`): returns `persons_found: len(persons)`,
 *     `persons_queued_for_deletion` / `persons_deleted` counted over those persons,
 *     `events_queued_for_deletion: delete_events and len(persons) > 0`, `deletion_errors: []`, with
 *     status 202. `posthog/models/person/bulk_delete.py` `resolve_persons_for_deletion` returns an
 *     empty list for ids with no person rather than raising.
 *
 * Strict on purpose: `persons_found` must be present and exactly 0, and nothing may report a
 * failure or a deletion. A body that proves nothing (`{}`) stays a failure.
 */
export function nothingToDelete(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (b.persons_found !== 0) return false;
  if (b.deletion_errors !== undefined && !(Array.isArray(b.deletion_errors) && b.deletion_errors.length === 0)) {
    return false;
  }
  const none = (value: unknown) => value === undefined || value === 0;
  return none(b.persons_queued_for_deletion) && none(b.persons_deleted);
}

/** Why an account's analytics deletion did not complete. A fixed vocabulary that is safe to log:
 * never an account id, email, URL, key or raw provider text. */
export type DeletionFailureReason =
  | "network"
  | "http_4xx"
  | "http_5xx"
  | "http_other"
  | "deletion_errors"
  | "not_queued"
  | "events_not_queued";

export class PostHogDeletionError extends Error {
  constructor(readonly reason: DeletionFailureReason) {
    super(`PostHog deletion failed: ${reason}`);
    this.name = "PostHogDeletionError";
  }
}

function statusReason(status: number): DeletionFailureReason {
  if (status >= 500 && status <= 599) return "http_5xx";
  if (status >= 400 && status <= 499) return "http_4xx";
  return "http_other";
}

function notQueuedReason(body: unknown): DeletionFailureReason {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (Array.isArray(b.deletion_errors) && b.deletion_errors.length > 0) return "deletion_errors";
  if (b.events_queued_for_deletion === false) return "events_not_queued";
  return "not_queued";
}

/** The loggable reason for a failed deletion: the fixed code, or "unknown" for anything else. */
export function deletionFailureReason(error: unknown): DeletionFailureReason | "unknown" {
  return error instanceof PostHogDeletionError ? error.reason : "unknown";
}
