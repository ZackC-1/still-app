import { type AuthDeps, withAuthenticatedUser } from "../_shared/auth.ts";
import type { PostHogPort } from "../_shared/posthog.ts";
import { jsonResponse } from "../_shared/store.ts";

// Attach the signed-in account's email to its PostHog person. The app or extension calls this once
// per account after it has identified the install (and only while the person shares usage). The
// subject and the email both come from the server: the UUID from the verified JWT, the email from
// the auth record. Nothing in the request body is read.

export interface AccountEmailLookup {
  emailFor(userId: string): Promise<string | null>;
}

export interface AnalyticsIdentifyDeps extends AuthDeps {
  readonly accounts: AccountEmailLookup;
  readonly posthog: PostHogPort;
}

export function handleAnalyticsIdentify(req: Request, deps: AnalyticsIdentifyDeps): Promise<Response> {
  return withAuthenticatedUser(req, deps, async (userId) => {
    if (!deps.posthog.canIdentify) return jsonResponse(200, { identified: false });
    const email = await deps.accounts.emailFor(userId);
    if (!email) return jsonResponse(200, { identified: false });
    await deps.posthog.setPersonEmail(userId, email);
    return jsonResponse(200, { identified: true });
  });
}
