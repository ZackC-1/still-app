import { parseAccountSyncStatus } from "@still/core/sync";
import {
  ANALYTICS_MESSAGE_KIND,
  createExtensionAnalyticsHost,
  createPageAnalytics as createSharedPageAnalytics,
  isAnalyticsId,
  type AnalyticsConfig,
  type AnalyticsIdentity,
  type AnalyticsKeyValue,
  type ExtensionAnalyticsHost,
  type MessageSender,
} from "@still/core/analytics";
import type { UiAnalytics } from "@still/core/ui";

// Product analytics for the Safari extension (iPhone and Mac), over core's shared extension host.
// The Apple app owns everything personal to the device: the install ids and the "Share usage data"
// switch live in the App Group, read over the read-only native lane `analyticsContext`
// (AnalyticsIdentity.swift), so the extension reports under the app's install and follows its
// switch. The popup shows no switch and no notice: those are the app's. The signed-in account comes
// from the app's account-status lane; the app, not the extension, attaches the email server-side.

type SendNative = (message: Record<string, unknown>) => Promise<unknown>;

interface NativeAnalytics {
  readonly installId: string;
  readonly anchorId: string;
  readonly consent: boolean;
}

/** How long a consent read is reused, so a burst of events costs one native round trip. */
export const CONSENT_TTL_MS = 30_000;

export function parseNativeAnalytics(reply: unknown): NativeAnalytics | null {
  const analytics = (reply as { analytics?: unknown } | null)?.analytics;
  if (typeof analytics !== "object" || analytics === null) return null;
  const { installId, anchorId, consent } = analytics as Record<string, unknown>;
  if (!isAnalyticsId(installId) || !isAnalyticsId(anchorId)) return null;
  return { installId, anchorId, consent: consent !== false };
}

export interface SafariAnalyticsDeps {
  readonly config: AnalyticsConfig;
  readonly appVersion: string;
  readonly sendNative: SendNative;
  /** browser.runtime.getPlatformInfo().os: "ios" on iPhone and iPad, "mac" on the Mac. */
  readonly platform: () => Promise<string>;
  readonly local: AnalyticsKeyValue;
  readonly isTrustedPage: (sender: MessageSender) => boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export interface SafariBackgroundAnalytics {
  onInstalled(details: { reason: string; previousVersion?: string }): void;
  /** Background start: reads the app's signed-in account, then reports setup and the active day. */
  onStart(): void;
  readonly listener: ExtensionAnalyticsHost["listener"];
}

export function createSafariBackgroundAnalytics(deps: SafariAnalyticsDeps): SafariBackgroundAnalytics {
  const now = deps.now ?? Date.now;
  let cached: { at: number; value: NativeAnalytics | null } | null = null;
  const nativeContext = async (): Promise<NativeAnalytics | null> => {
    if (cached && now() - cached.at < CONSENT_TTL_MS) return cached.value;
    const value = parseNativeAnalytics(await deps.sendNative({ kind: "analyticsContext" }).catch(() => null));
    cached = { at: now(), value };
    return value;
  };

  const host: Promise<ExtensionAnalyticsHost | null> = (async () => {
    const [first, os] = await Promise.all([nativeContext(), deps.platform().catch(() => "ios")]);
    if (!first) return null; // no app container: nothing to report under
    const identity: AnalyticsIdentity = {
      installId: first.installId,
      anchorId: first.anchorId,
      created: false,
      returning: false,
    };
    return createExtensionAnalyticsHost({
      surface: os === "mac" ? "safari-macos" : "safari-ios",
      config: deps.config,
      appVersion: deps.appVersion,
      local: deps.local,
      identity: async () => identity,
      consent: async () => (await nativeContext())?.consent ?? false,
      noticeApplies: false,
      isTrustedPage: deps.isTrustedPage,
      fetch: deps.fetch,
      now: deps.now,
      uuid: deps.uuid,
    });
  })().catch(() => null);

  const accountId = async (): Promise<string | null> => {
    const reply = (await deps.sendNative({ kind: "getAccountSyncStatus" }).catch(() => null)) as
      | { accountSyncStatus?: unknown }
      | null;
    return parseAccountSyncStatus(reply?.accountSyncStatus ?? null)?.accountId ?? null;
  };

  return {
    onInstalled(details) {
      // The app reports the download itself (one install, one store); the extension only records
      // its own updates so the version it runs is visible.
      if (details.reason === "update") void host.then((h) => h?.onInstalled(details));
    },
    onStart() {
      void Promise.all([host, accountId().catch(() => null)]).then(([h, userId]) => h?.onStart(userId));
    },
    listener(message, sender, sendResponse) {
      if (typeof message !== "object" || message === null) return false;
      const kind = (message as { kind?: unknown }).kind;
      if (kind !== ANALYTICS_MESSAGE_KIND && kind !== "blocked") return false;
      void host.then((h) => {
        if (!h || !h.listener(message, sender, sendResponse)) sendResponse(undefined);
      });
      return true;
    },
  };
}

/** The Safari popup's seam: messages to the background, no switch (the app owns it). */
export function createSafariPageAnalytics(
  send: (message: Record<string, unknown>) => Promise<unknown> = (message) =>
    Promise.resolve(browser.runtime.sendMessage({ kind: ANALYTICS_MESSAGE_KIND, ...message })),
): UiAnalytics {
  return createSharedPageAnalytics({ send, showsSwitch: false });
}
