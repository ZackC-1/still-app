import {
  DEFAULT_ON_USAGE_POLICY,
  isAnalyticsId,
  readAnalyticsPermission,
  type AnalyticsPermission,
  type AnalyticsPrivacyPolicy,
  type SubjectDeps,
} from "@still/core/analytics";

// V3 Safari builds: the extension reports only under the Apple app's usage-sharing permission
// (ADR 0004, reaffirmed for V3 on 2026-10-10: on by default in the app, which owns the notice and
// the switch; the extension follows it). It reads the app's record from the App Group through the
// native handler's read-only `analyticsPermission` lane and never grants, stops or writes one:
// before the app has created the record, the extension reports nothing.
//
// Signed in, it reports under the same per-device identity as the app (owner decision 50): the app
// asks Still's server for it and publishes it to the App Group; the extension reads it through the
// read-only `analyticsSubject` lane, only for the account the app reports as signed in and only
// under the same permission origin. It never calls the server itself and never ends sharing. Being a
// local read, it is consulted at every background start too, so signed-in use is attributed without
// a popup being opened, and an identity the app withdrew is dropped at once.
//
// Passed only from the background's V3 branch, a build-time choice that folds away in 2.x builds.

type SendNative = (message: Record<string, unknown>) => Promise<unknown>;

export function defaultOnSafariAnalytics(sendNative: SendNative): {
  readonly privacyPolicy: AnalyticsPrivacyPolicy;
  readonly permission: () => Promise<AnalyticsPermission | null>;
  readonly subjects: SubjectDeps;
} {
  return {
    privacyPolicy: DEFAULT_ON_USAGE_POLICY,
    subjects: {
      // A local App Group read, no network: a background start may use it, and it is checked
      // before a cached identity is reused (an identity retired elsewhere is never reused).
      local: true,
      async issue(body, _signal, account) {
        const entry = (
          (await sendNative({ kind: "analyticsSubject" })) as { analyticsSubject?: unknown } | null
        )?.analyticsSubject as { account?: unknown; originProof?: unknown; subject?: unknown } | null | undefined;
        // Only this account's identity under this same permission; otherwise wait for the app.
        if (
          !entry ||
          entry.account !== account.toLowerCase() ||
          entry.originProof !== body.originProof ||
          !isAnalyticsId(entry.subject)
        )
          throw new Error("The app has not published this device's identity");
        return { state: "active", subject: entry.subject };
      },
      // The extension never ends sharing; the app owns the switch and acts on a server stop.
      onStopped: async () => {},
    },
    // A granted or stopped record as the app holds it; anything else (no record yet, the app's
    // `false`, an older native handler without the lane, a malformed reply) is no permission.
    permission: async () =>
      readAnalyticsPermission(
        (
          (await sendNative({ kind: "analyticsPermission" })) as {
            analyticsPermission?: unknown;
          } | null
        )?.analyticsPermission,
      ),
  };
}
