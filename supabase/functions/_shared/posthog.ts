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
  setPersonEmail(userId: string, email: string): Promise<void>;
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

  async setPersonEmail(userId: string, email: string): Promise<void> {
    if (!this.canIdentify) return;
    const res = await this.fetchImpl(`${trimSlash(this.config.host!)}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.config.projectKey!.trim(),
        batch: [{
          event: "$set",
          properties: { distinct_id: userId, $set: { email }, $lib: "still-server" },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`PostHog identify failed: ${res.status}`);
  }

  async deletePerson(userId: string): Promise<void> {
    if (!this.canDelete) return;
    const url = `${trimSlash(this.config.apiHost!)}/api/projects/${this.config.projectId}/persons/bulk_delete/`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.personalApiKey!.trim()}`,
      },
      body: JSON.stringify({ distinct_ids: [userId], delete_events: true }),
    });
    const text = await res.text();
    if (res.ok) return;
    // With delete_events, PostHog refuses ids that match no person. Someone who never shared usage
    // has no person to delete, which is the outcome deletion wants anyway.
    if (res.status === 400 && /distinct|match|not found/i.test(text)) return;
    throw new Error(`PostHog deletion failed: ${res.status}`);
  }
}
