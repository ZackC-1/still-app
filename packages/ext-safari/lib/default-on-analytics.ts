import {
  DEFAULT_ON_USAGE_POLICY,
  readAnalyticsPermission,
  type AnalyticsPermission,
  type AnalyticsPrivacyPolicy,
} from "@still/core/analytics";

// V3 Safari builds: the extension reports only under the Apple app's usage-sharing permission
// (ADR 0004, reaffirmed for V3 on 2026-10-10: on by default in the app, which owns the notice and
// the switch; the extension follows it). It reads the app's record from the App Group through the
// native handler's read-only `analyticsPermission` lane and never grants, stops or writes one:
// before the app has created the record, the extension reports nothing.
//
// Passed only from the background's V3 branch, a build-time choice that folds away in 2.x builds.

type SendNative = (message: Record<string, unknown>) => Promise<unknown>;

export function defaultOnSafariAnalytics(sendNative: SendNative): {
  readonly privacyPolicy: AnalyticsPrivacyPolicy;
  readonly permission: () => Promise<AnalyticsPermission | null>;
} {
  return {
    privacyPolicy: DEFAULT_ON_USAGE_POLICY,
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
