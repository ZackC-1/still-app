import {
  DEFAULT_ON_USAGE_POLICY,
  START_HOLD_LIMIT_MS,
  createDefaultOnUsage,
  createExtensionAnalyticsHost,
  resolveAnalyticsIdentity,
  versionedNotice,
  type ExtensionAnalyticsHost,
} from "@still/core/analytics";
import { isExtensionPageSender } from "./session-messages.js";
import { isFirefoxAndroid, type RuntimePlatform } from "./runtime-platform.js";
import type { BackgroundAnalyticsDeps } from "./analytics.js";

// Product analytics for V3 Chrome and Firefox builds: usage sharing on by default with a per-device
// off switch (ADR 0004, reaffirmed by the owner for V3 on 2026-10-10).
//
//   * Chrome: on from install. The one-time notice ("Still shares usage data...", Turn off / OK)
//     and the "Share usage data" switch on the first-run and settings pages are the off path, and
//     the switch turns it back on.
//   * Signed in: the device reports under its own identity, which the server issues and gives the
//     account's email (issueSubject; off until the server's ANALYTICS_SUBJECTS_ENABLED switch).
//   * Firefox: follows the optional `technicalAndInteraction` data-collection permission, which
//     Firefox offers in its own install prompt. Granted there means on from install; the switch
//     requests it (inside the tap, see createPageAnalytics) or withdraws it; withdrawing it in the
//     add-on manager turns sharing off at the next read.
//
// The background chooses this factory only in V3 builds (a build-time choice that folds away), so
// 2.x bundles keep `createBackgroundAnalytics` byte-for-byte; that twin goes when 2.x retires. Ids,
// surface and device work exactly as there.
const FIREFOX_DATA = { data_collection: ["technicalAndInteraction"] };

/** Firefox's data-collection permission calls, which @types/chrome does not describe. */
interface DataCollectionPermissions {
  contains(p: typeof FIREFOX_DATA): Promise<boolean>;
  remove(p: typeof FIREFOX_DATA): Promise<boolean>;
}

const firefoxData = () => chrome.permissions as unknown as DataCollectionPermissions;

export function createDefaultOnBackgroundAnalytics(
  deps: BackgroundAnalyticsDeps,
  runtimeId: string,
  extensionOrigin: string,
): ExtensionAnalyticsHost {
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const usage = createDefaultOnUsage({
    store: deps.local,
    browserPermission: deps.isFirefox
      ? {
          granted: deps.firefoxPermissionGranted ?? (() => firefoxData().contains(FIREFOX_DATA)),
          revoke: deps.firefoxPermissionRevoke ?? (() => firefoxData().remove(FIREFOX_DATA)),
        }
      : undefined,
  });
  let identity: ReturnType<typeof resolveAnalyticsIdentity> | null = null;
  let surface: "chrome" | "firefox" | "firefox-android" = deps.isFirefox ? "firefox" : "chrome";
  let device: "desktop" | undefined = "desktop";
  // Every event is built only after the permission is read, and that read waits for the platform
  // answer, so no event is ever built for a surface that is about to change (see analytics.ts).
  const platformKnown = (deps.platform ?? Promise.resolve<RuntimePlatform>("desktop"))
    .catch((): RuntimePlatform => "desktop")
    .then((platform) => {
      if (isFirefoxAndroid(deps.isFirefox, platform)) {
        surface = "firefox-android";
        device = undefined;
      }
    });
  const host = createExtensionAnalyticsHost({
    get surface() {
      return surface;
    },
    get device() {
      return device;
    },
    config: deps.config,
    envelope: deps.envelope,
    appVersion: deps.appVersion,
    // The notice flag follows the disclosure version, so an earlier acknowledgement (2.1's
    // included) shows the notice again; everything else is this extension's local storage.
    local: versionedNotice(deps.local),
    queueStore: deps.queue ?? undefined,
    identity: () =>
      (identity ??= resolveAnalyticsIdentity({
        local: deps.local,
        shared: deps.shared,
        uuid,
        sharedGraceMs: deps.sharedGraceMs ?? 4_000,
        sleep: deps.sleep,
      })),
    permission: () => platformKnown.then(usage.permission),
    consent: () => platformKnown.then(usage.consent),
    privacyPolicy: DEFAULT_ON_USAGE_POLICY,
    commitPermission: usage.commit,
    noticeApplies: !deps.isFirefox,
    isTrustedPage: (sender) => isExtensionPageSender(sender, runtimeId, extensionOrigin),
    identifyOnServer: deps.identifyOnServer,
    // Signed-in devices report under their own server-issued identity (owner decision 50); the
    // server attaches the account's email to it. A stop from the server ends sharing here.
    subjects: deps.issueSubject ? { issue: deps.issueSubject, onStopped: () => usage.commit(false) } : undefined,
    requestQuietFlush: deps.requestQuietFlush,
    fetch: deps.fetch,
    now: deps.now,
    uuid,
  });
  // The start's first account answer fences every observation made before it (client.ts `confirm`
  // cancels when the account asked for changes, and a fresh background has asked for none). The
  // background hands over its account read while it is still pending, and Chrome delivers
  // onInstalled before that read settles, so an install observed straight away would be dropped:
  // `installed` and `setup_completed` would never be counted. Observe it once the read has settled
  // (and the start has acted on it), bounded like every other wait on the start.
  let startRead: Promise<void> = Promise.resolve();
  return {
    ...host,
    onStart(read) {
      host.onStart(read);
      startRead = Promise.race([
        Promise.resolve(read).then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, START_HOLD_LIMIT_MS)),
      ]).then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    },
    onInstalled(details, observation) {
      if (observation) return host.onInstalled(details, observation);
      void startRead.then(() => host.onInstalled(details));
    },
  };
}
