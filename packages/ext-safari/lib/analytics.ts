import { parseAccountSyncStatus } from "@still/core/sync";
import {
  ANALYTICS_MESSAGE_KIND,
  createExtensionAnalyticsHost,
  createPageAnalytics as createSharedPageAnalytics,
  isAnalyticsId,
  isDeviceClass,
  type AnalyticsDevice,
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
  /** Compiled into the native handler, so it cannot confuse an iPad for a Mac. */
  readonly platform: "ios" | "macos" | null;
  readonly device: AnalyticsDevice | null;
}

export function parseNativeAnalytics(reply: unknown): NativeAnalytics | null {
  const analytics = (reply as { analytics?: unknown } | null)?.analytics;
  if (typeof analytics !== "object" || analytics === null) return null;
  const { installId, anchorId, consent, platform, device } = analytics as Record<string, unknown>;
  if (!isAnalyticsId(installId) || !isAnalyticsId(anchorId)) return null;
  return {
    installId,
    anchorId,
    consent: consent === true, // fails closed if the field is ever missing
    platform: platform === "ios" || platform === "macos" ? platform : null,
    device: isDeviceClass(device) ? device : null,
  };
}

export interface SafariAnalyticsDeps {
  readonly config: AnalyticsConfig;
  readonly appVersion: string;
  readonly sendNative: SendNative;
  /** browser.runtime.getPlatformInfo().os: "ios" on iPhone and iPad, "mac" on the Mac. */
  readonly platform: () => Promise<string>;
  readonly local: AnalyticsKeyValue;
  /** Where the queue waits: IndexedDB private to the background, never seen by content scripts. */
  readonly queue?: AnalyticsKeyValue | null;
  readonly isTrustedPage: (sender: MessageSender) => boolean;
  readonly requestQuietFlush?: () => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export interface SafariBackgroundAnalytics {
  onInstalled(details: { reason: string; previousVersion?: string }): void;
  /** Send what is queued (the quiet-flush alarm). */
  flush(): void;
  /** Background start: reads the app's signed-in account, then reports setup and the active day. */
  onStart(): void;
  readonly listener: ExtensionAnalyticsHost["listener"];
}

export function createSafariBackgroundAnalytics(deps: SafariAnalyticsDeps): SafariBackgroundAnalytics {
  // Read fresh every time: the app's switch and record can change while this background runs, and
  // events are few enough that a native round trip each is cheap.
  const nativeContext = async (): Promise<NativeAnalytics | null> =>
    parseNativeAnalytics(await deps.sendNative({ kind: "analyticsContext" }).catch(() => null));

  const host: Promise<ExtensionAnalyticsHost | null> = (async () => {
    const [first, os] = await Promise.all([nativeContext(), deps.platform().catch(() => "ios")]);
    if (!first) return null; // no app container: nothing to report under
    // The app can replace the provisional anchor after this background started; follow it.
    let current: AnalyticsIdentity = { installId: first.installId, anchorId: first.anchorId, created: false, returning: false };
    const identity = async (): Promise<AnalyticsIdentity> => {
      const latest = await nativeContext();
      if (latest) current = { installId: latest.installId, anchorId: latest.anchorId, created: false, returning: false };
      return current;
    };
    // The native handler's own platform wins; the browser's answer is only a fallback.
    const macos = first.platform ? first.platform === "macos" : os === "mac";
    return createExtensionAnalyticsHost({
      surface: macos ? "safari-macos" : "safari-ios",
      device: first.device ?? (macos ? "desktop" : undefined),
      config: deps.config,
      appVersion: deps.appVersion,
      local: deps.local,
      queueStore: deps.queue ?? undefined,
      identity,
      consent: async () => (await nativeContext())?.consent ?? false,
      noticeApplies: false,
      isTrustedPage: deps.isTrustedPage,
      requestQuietFlush: deps.requestQuietFlush,
      fetch: deps.fetch,
      now: deps.now,
      uuid: deps.uuid,
    });
  })().catch(() => null);

  // The app's account: an id, null when the app reports no account (signed out or deleted, so any
  // earlier account is let go), or undefined when it could not be read (nothing changes).
  const accountId = async (): Promise<string | null | undefined> => {
    const reply = (await deps.sendNative({ kind: "getAccountSyncStatus" }).catch(() => null)) as
      | { accountSyncStatus?: unknown }
      | null;
    if (!reply || !("accountSyncStatus" in reply)) return undefined;
    if (reply.accountSyncStatus === null) return null;
    return parseAccountSyncStatus(reply.accountSyncStatus)?.accountId ?? undefined;
  };

  const syncAccount = async (h: ExtensionAnalyticsHost): Promise<void> => {
    const userId = await accountId().catch(() => undefined);
    if (userId) await h.identify(userId);
    else if (userId === null) await h.client.reset({ onlyIfSignedIn: true, forgetAccount: true });
  };

  return {
    flush() {
      void host.then((h) => h?.client.flush());
    },
    onInstalled(details) {
      // The app reports the download itself (one install, one store); the extension only records
      // its own updates so the version it runs is visible.
      if (details.reason === "update") void host.then((h) => h?.onInstalled(details));
    },
    onStart() {
      void Promise.all([host, accountId().catch(() => undefined)]).then(([h, userId]) => h?.onStart(userId));
    },
    listener(message, sender, sendResponse) {
      if (typeof message !== "object" || message === null) return false;
      const kind = (message as { kind?: unknown }).kind;
      if (kind !== ANALYTICS_MESSAGE_KIND) return false;
      void host.then(async (h) => {
        if (!h) return sendResponse(undefined);
        // Follow the app's account before recording: it may have signed out or switched accounts
        // since this background started.
        if (deps.isTrustedPage(sender)) await syncAccount(h);
        if (!h.listener(message, sender, sendResponse)) sendResponse(undefined);
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
