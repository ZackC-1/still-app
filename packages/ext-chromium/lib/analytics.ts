import {
  ANALYTICS_MESSAGE_KIND,
  createExtensionAnalyticsHost,
  createPageAnalytics as createSharedPageAnalytics,
  createStoredConsent,
  resolveAnalyticsIdentity,
  type AnalyticsConfig,
  type AnalyticsKeyValue,
  type AnalyticsSend,
  type ExtensionAnalyticsHost,
} from "@still/core/analytics";
import type { UiAnalytics } from "@still/core/ui";
import { isExtensionPageSender } from "./session-messages.js";

// Product analytics for the Chrome and Firefox builds, over core's shared extension host
// (@still/core/analytics extension-host.ts). What is specific to these two browsers lives here:
//
//   * Ids: an install id in chrome.storage.local and a person anchor in chrome.storage.sync, which
//     follows the person's Google or Firefox account to their other computers.
//   * Consent. Chrome starts on, with the one-time notice and the settings switch as the off
//     path. Firefox starts off until the person grants the optional `technicalAndInteraction`
//     data-collection permission (at install, or from Still's settings); that permission IS the
//     switch there, so the two can never disagree.

export { ANALYTICS_MESSAGE_KIND, BLOCKED_MESSAGE_KIND } from "@still/core/analytics";

const FIREFOX_DATA = { data_collection: ["technicalAndInteraction"] };

/** Firefox's data-collection permission calls, which @types/chrome does not describe. */
interface DataCollectionPermissions {
  contains(p: typeof FIREFOX_DATA): Promise<boolean>;
  request(p: typeof FIREFOX_DATA): Promise<boolean>;
  remove(p: typeof FIREFOX_DATA): Promise<boolean>;
}

function dataPermissions(): DataCollectionPermissions {
  return chrome.permissions as unknown as DataCollectionPermissions;
}

export function storageKeyValue(area: chrome.storage.StorageArea): AnalyticsKeyValue {
  return {
    async get(key) {
      return (await area.get(key))[key] ?? null;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
  };
}

export interface BackgroundAnalyticsDeps {
  readonly isFirefox: boolean;
  readonly config: AnalyticsConfig;
  readonly appVersion: string;
  readonly local: AnalyticsKeyValue;
  /** chrome.storage.sync: follows the person's Google or Firefox account between computers. */
  readonly shared: AnalyticsKeyValue | null;
  /** Firefox permission check; injectable for tests. */
  readonly firefoxPermissionGranted?: () => Promise<boolean>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly uuid?: () => string;
  /** Ask Still's server to put the signed-in account's email on its PostHog person
   * (analytics-identify). Absent on builds without Supabase. */
  readonly identifyOnServer?: () => Promise<void>;
}

export function createBackgroundAnalytics(
  deps: BackgroundAnalyticsDeps,
  runtimeId: string,
  extensionOrigin: string,
): ExtensionAnalyticsHost {
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const stored = createStoredConsent(deps.local, true);
  const granted =
    deps.firefoxPermissionGranted ?? (() => dataPermissions().contains(FIREFOX_DATA).catch(() => false));
  let identity: ReturnType<typeof resolveAnalyticsIdentity> | null = null;
  return createExtensionAnalyticsHost({
    surface: deps.isFirefox ? "firefox" : "chrome",
    config: deps.config,
    appVersion: deps.appVersion,
    local: deps.local,
    identity: () => (identity ??= resolveAnalyticsIdentity({ local: deps.local, shared: deps.shared, uuid })),
    consent: deps.isFirefox ? granted : () => stored.get(),
    storeConsent: deps.isFirefox ? undefined : (enabled) => stored.set(enabled),
    noticeApplies: !deps.isFirefox,
    isTrustedPage: (sender) => isExtensionPageSender(sender, runtimeId, extensionOrigin),
    identifyOnServer: deps.identifyOnServer,
    fetch: deps.fetch,
    now: deps.now,
    uuid,
  });
}

const defaultSend: AnalyticsSend = (message) =>
  Promise.resolve(chrome.runtime.sendMessage({ kind: ANALYTICS_MESSAGE_KIND, ...message }));

/** The popup/options side: messages to the background, and Firefox's prompt inside the tap. */
export function createPageAnalytics(isFirefox: boolean, send: AnalyticsSend = defaultSend): UiAnalytics {
  return createSharedPageAnalytics({
    send,
    changeConsent: isFirefox
      ? (enabled) => (enabled ? dataPermissions().request(FIREFOX_DATA) : dataPermissions().remove(FIREFOX_DATA))
      : undefined,
  });
}
