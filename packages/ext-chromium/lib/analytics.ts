import { SERVICE_IDS, type ServiceId } from "@still/shared-types";
import {
  AnalyticsClient,
  createStoredConsent,
  resolveAnalyticsIdentity,
  type AnalyticsConfig,
  type AnalyticsKeyValue,
  type AnalyticsSurface,
} from "@still/core/analytics";
import type { UiAnalytics, UsageSharingState } from "@still/core/ui";
import { isExtensionPageSender, type SessionMessageSender } from "./session-messages.js";

// Product analytics for the Chrome and Firefox builds. The background owns the one client, so a
// popup that closes mid-send loses nothing and there is one queue per browser profile. Pages talk
// to it over the message below; content scripts may only send `{ kind: "blocked", service }`, a
// single service name, which the background turns into at most one `blocking_worked` a day.
//
// Consent differs by store:
//   * Chrome: on by default, with the one-time notice and the settings switch as the off path.
//   * Firefox: off until the person grants the optional `technicalAndInteraction` data-collection
//     permission. That permission IS the switch there, so the two can never disagree.

export const ANALYTICS_MESSAGE_KIND = "still:analytics";
export const BLOCKED_MESSAGE_KIND = "blocked";
const NOTICE_KEY = "still:analytics:notice-seen";
const FIREFOX_DATA = { data_collection: ["technicalAndInteraction"] };

type AnalyticsRequest =
  | { readonly action: "track"; readonly name: string; readonly props?: unknown }
  | { readonly action: "identify"; readonly userId: string }
  | { readonly action: "reset" }
  | { readonly action: "sharing" }
  | { readonly action: "setSharing"; readonly enabled: boolean }
  | { readonly action: "acknowledgeNotice" };

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

// ── Background ────────────────────────────────────────────────────────────────────────────────

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
}

export interface BackgroundAnalytics {
  readonly client: AnalyticsClient;
  /** runtime.onInstalled: `installed` for a new install, `updated` for an update. */
  onInstalled(details: { reason: string; previousVersion?: string }): void;
  /** Background start: one `active` a day, and the current account if signed in. */
  onStart(userId: string | null): void;
  /** runtime.onMessage listener for pages and the content-script `blocked` note. */
  readonly listener: (
    message: unknown,
    sender: SessionMessageSender,
    sendResponse: (response?: unknown) => void,
  ) => boolean;
}

export function createBackgroundAnalytics(
  deps: BackgroundAnalyticsDeps,
  runtimeId: string,
  extensionOrigin: string,
): BackgroundAnalytics {
  const surface: AnalyticsSurface = deps.isFirefox ? "firefox" : "chrome";
  const storedConsent = createStoredConsent(deps.local, true);
  const granted =
    deps.firefoxPermissionGranted ??
    (() => dataPermissions().contains(FIREFOX_DATA).catch(() => false));
  const consent = (): Promise<boolean> => (deps.isFirefox ? granted() : storedConsent.get());
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  let identityPromise: ReturnType<typeof resolveAnalyticsIdentity> | null = null;
  const identity = () =>
    (identityPromise ??= resolveAnalyticsIdentity({ local: deps.local, shared: deps.shared, uuid }));

  const client = new AnalyticsClient({
    config: deps.config,
    surface,
    appVersion: deps.appVersion,
    store: deps.local,
    identity,
    consent,
    fetch: deps.fetch ?? ((...args) => fetch(...args)),
    now: deps.now ?? Date.now,
    uuid,
  });

  const sharing = async (): Promise<UsageSharingState | null> => {
    if (!client.enabled) return null;
    const enabled = await consent();
    const noticeNeeded = !deps.isFirefox && (await deps.local.get(NOTICE_KEY).catch(() => true)) !== true;
    return { enabled, noticeNeeded };
  };

  const handle = async (request: AnalyticsRequest): Promise<unknown> => {
    switch (request.action) {
      case "track":
        await client.trackUnchecked(request.name, request.props);
        return true;
      case "identify":
        await client.identify(request.userId);
        return true;
      case "reset":
        await client.reset();
        return true;
      case "sharing":
        return sharing();
      case "setSharing": {
        // Firefox pages change the permission themselves (it needs their user gesture) and then
        // tell the background; the permission is the source of truth there.
        if (!deps.isFirefox) await storedConsent.set(request.enabled);
        const enabled = await consent();
        if (enabled) {
          void client.flush();
        } else {
          await client.clearQueue();
        }
        return enabled;
      }
      case "acknowledgeNotice":
        await deps.local.set(NOTICE_KEY, true).catch(() => undefined);
        return true;
    }
  };

  return {
    client,
    onInstalled(details) {
      if (details.reason === "install") {
        void identity().then((id) => client.track("installed", { returning: id.returning }));
      } else if (details.reason === "update" && details.previousVersion !== deps.appVersion) {
        void client.trackUnchecked("updated", { from: details.previousVersion, to: deps.appVersion });
      }
    },
    onStart(userId) {
      if (userId) void client.identify(userId);
      void client.trackDaily("active", "active", {});
      void client.flush();
    },
    listener(message, sender, sendResponse) {
      if (typeof message !== "object" || message === null) return false;
      const m = message as Record<string, unknown>;
      if (m.kind === BLOCKED_MESSAGE_KIND) {
        // The one thing a content script may say. Only a known service name is read.
        if (typeof m.service === "string" && (SERVICE_IDS as readonly string[]).includes(m.service)) {
          const service = m.service as ServiceId;
          void client.trackDaily(`blocked:${service}`, "blocking_worked", { service });
        }
        return false;
      }
      if (m.kind !== ANALYTICS_MESSAGE_KIND || !isExtensionPageSender(sender, runtimeId, extensionOrigin)) {
        return false;
      }
      const request = parseRequest(m);
      if (!request) return false;
      void handle(request)
        .then(sendResponse, () => sendResponse(null))
        .catch(() => {});
      return true;
    },
  };
}

function parseRequest(m: Record<string, unknown>): AnalyticsRequest | null {
  switch (m.action) {
    case "track":
      return typeof m.name === "string" ? { action: "track", name: m.name, props: m.props } : null;
    case "identify":
      return typeof m.userId === "string" ? { action: "identify", userId: m.userId } : null;
    case "setSharing":
      return typeof m.enabled === "boolean" ? { action: "setSharing", enabled: m.enabled } : null;
    case "reset":
    case "sharing":
    case "acknowledgeNotice":
      return { action: m.action };
    default:
      return null;
  }
}

// ── Popup / options pages ─────────────────────────────────────────────────────────────────────

type Send = (message: Record<string, unknown>) => Promise<unknown>;

const defaultSend: Send = (message) =>
  Promise.resolve(chrome.runtime.sendMessage({ kind: ANALYTICS_MESSAGE_KIND, ...message }));

/** The page side of UiAnalytics: every call is a message to the background's client. */
export function createPageAnalytics(isFirefox: boolean, send: Send = defaultSend): UiAnalytics {
  const fire = (message: Record<string, unknown>): void => {
    void send(message).catch(() => {});
  };
  return {
    track: (name, props) => fire({ action: "track", name, props }),
    identify: (userId) => fire({ action: "identify", userId }),
    reset: () => fire({ action: "reset" }),
    async sharing() {
      const state = await send({ action: "sharing" }).catch(() => null);
      if (typeof state !== "object" || state === null) return null;
      const { enabled, noticeNeeded } = state as Record<string, unknown>;
      return typeof enabled === "boolean"
        ? { enabled, noticeNeeded: noticeNeeded === true }
        : null;
    },
    setSharing(enabled) {
      // Firefox: ask (or withdraw) inside the tap, before any await, then tell the background.
      const change = isFirefox
        ? (enabled ? dataPermissions().request(FIREFOX_DATA) : dataPermissions().remove(FIREFOX_DATA)).catch(
            () => false,
          )
        : Promise.resolve(true);
      return change.then(async () => {
        const result = await send({ action: "setSharing", enabled }).catch(() => null);
        return typeof result === "boolean" ? result : !enabled;
      });
    },
    acknowledgeNotice: () => fire({ action: "acknowledgeNotice" }),
  };
}
