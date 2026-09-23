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
  setPersonEmail(userId: string, email: string, options?: { readonly accountCreated?: boolean }): Promise<void>;
  /** Delete the person and queue deletion of their events. Resolves when PostHog accepted it. */
  deletePerson(userId: string): Promise<void>;
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

  async setPersonEmail(
    userId: string,
    email: string,
    options: { readonly accountCreated?: boolean } = {},
  ): Promise<void> {
    if (!this.canIdentify) return;
    const timestamp = new Date().toISOString();
    const common = { distinct_id: userId, $lib: "still-server", $geoip_disable: true };
    const batch: unknown[] = [{ event: "$set", properties: { ...common, $set: { email } }, timestamp }];
    if (options.accountCreated) batch.push({ event: "account_created", properties: common, timestamp });
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
      // queued nothing is not a deletion either. Retry once, then report.
      if (deletionAccepted(first.body)) return;
      const retry = await this.bulkDelete(userId, true);
      if (retry.ok && deletionAccepted(retry.body)) return;
      throw new Error("PostHog accepted the request but did not queue the deletion");
    }
    if (first.status !== 400) throw new Error(`PostHog deletion failed: ${first.status}`);
    // With delete_events, PostHog refuses ids that match no person. Ask again without event
    // deletion, which instead reports the unmatched ids: only an explicit "no such person" (someone
    // who never shared usage) counts as done. Anything else is a real failure to log.
    const check = await this.bulkDelete(userId, false);
    if (check.ok) {
      const unmatched = (check.body as { unmatched_distinct_ids?: unknown } | null)?.unmatched_distinct_ids;
      if (Array.isArray(unmatched) && unmatched.includes(userId)) return;
      // It matched after all (and is now deleted), but its events were not queued for deletion.
      throw new Error("PostHog deleted the person but refused to delete its events");
    }
    throw new Error(`PostHog deletion failed: ${first.status}/${check.status}`);
  }

  private async bulkDelete(
    userId: string,
    deleteEvents: boolean,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const url = `${trimSlash(this.config.apiHost!)}/api/projects/${this.config.projectId}/persons/bulk_delete/`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.personalApiKey!.trim()}`,
      },
      body: JSON.stringify({ distinct_ids: [userId], delete_events: deleteEvents }),
    });
    const text = await res.text();
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
