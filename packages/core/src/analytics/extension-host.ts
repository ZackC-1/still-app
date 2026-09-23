import { AnalyticsClient, type AnalyticsConfig } from "./client.js";
import type { AnalyticsSurface } from "./events.js";
import type { AnalyticsIdentity, AnalyticsKeyValue } from "./identity.js";
import type { UiAnalytics, UsageSharingState } from "../ui/controller.svelte.js";

// The analytics host every browser extension build shares (Chrome, Firefox, Safari). The
// extension's background owns the one client, so a popup that closes mid-send loses nothing and
// there is one queue per browser profile. Pages talk to it over ANALYTICS_MESSAGE_KIND. Content
// scripts send nothing: they run on the sites people visit, and Still never records browsing.
//
// What differs by build is injected: where the ids come from (browser sync storage, or the Apple
// App Group), who owns consent (a stored switch, Firefox's data-collection permission, or the
// Apple app's switch), and whether the one-time notice applies.

export const ANALYTICS_MESSAGE_KIND = "still:analytics";
export const NOTICE_KEY = "still:analytics:notice-seen";
export const SERVER_IDENTIFIED_KEY = "still:analytics:server-identified";

export interface MessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: unknown;
}

export interface ExtensionAnalyticsHostDeps {
  readonly surface: AnalyticsSurface;
  readonly config: AnalyticsConfig;
  readonly appVersion: string;
  /** This extension's local storage: account, markers and notice flag. */
  readonly local: AnalyticsKeyValue;
  /** Where queued events wait: IndexedDB private to the background (idb.ts). */
  readonly queueStore?: AnalyticsKeyValue;
  readonly identity: () => Promise<AnalyticsIdentity>;
  readonly consent: () => Promise<boolean>;
  /** Persist a switch change. Absent where something else owns consent (Firefox's permission,
   * the Apple app's switch); the host then re-reads `consent` after a change. */
  readonly storeConsent?: (enabled: boolean) => Promise<void>;
  /** Whether this surface shows the one-time "sharing is on" notice. */
  readonly noticeApplies: boolean;
  /** Only extension pages (popup, options) may use the page protocol. */
  readonly isTrustedPage: (sender: MessageSender) => boolean;
  /** Ask Still's server to attach the signed-in account's email (analytics-identify). */
  readonly identifyOnServer?: () => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export interface ExtensionAnalyticsHost {
  readonly client: AnalyticsClient;
  /** runtime.onInstalled: `installed` for a new install, `updated` for an update. */
  onInstalled(details: { reason: string; previousVersion?: string }): void;
  /** Background start: one `active` a day, setup complete on Safari (the extension is running),
   * and the current account. `null` means known to be signed out (an earlier account is let go, whether it
   * signed out here, elsewhere or was deleted); `undefined` means it could not be read, so nothing
   * about the account changes. */
  onStart(userId: string | null | undefined): void;
  /** Identify the install, and once per account have the server attach the email. */
  identify(userId: string): Promise<void>;
  readonly listener: (
    message: unknown,
    sender: MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => boolean;
}

type PageRequest =
  | { readonly action: "track"; readonly name: string; readonly props?: unknown }
  | { readonly action: "identify"; readonly userId: string }
  | { readonly action: "reset"; readonly forgetAccount: boolean }
  | { readonly action: "sharing" }
  | { readonly action: "setSharing"; readonly enabled: boolean }
  | { readonly action: "acknowledgeNotice" };

/** Identify an install and, once per account while sharing is on, run the server email attach.
 * Shared by the extension host and the Apple app. */
export function createAccountIdentifier(deps: {
  readonly client: AnalyticsClient;
  readonly local: AnalyticsKeyValue;
  readonly consent: () => Promise<boolean>;
  readonly identifyOnServer?: () => Promise<void>;
}): (userId: string) => Promise<void> {
  return async (userId) => {
    await deps.client.identify(userId);
    if (!deps.identifyOnServer || !deps.client.enabled || !(await deps.consent().catch(() => false))) return;
    if ((await deps.local.get(SERVER_IDENTIFIED_KEY).catch(() => null)) === userId) return;
    try {
      await deps.identifyOnServer();
      await deps.local.set(SERVER_IDENTIFIED_KEY, userId);
    } catch {
      /* retried on the next start */
    }
  };
}

export function createExtensionAnalyticsHost(deps: ExtensionAnalyticsHostDeps): ExtensionAnalyticsHost {
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const client = new AnalyticsClient({
    config: deps.config,
    surface: deps.surface,
    appVersion: deps.appVersion,
    store: deps.local,
    queueStore: deps.queueStore,
    identity: deps.identity,
    consent: deps.consent,
    fetch: deps.fetch ?? ((...args) => fetch(...args)),
    now: deps.now ?? Date.now,
    uuid,
  });
  const identify = createAccountIdentifier({
    client,
    local: deps.local,
    consent: deps.consent,
    identifyOnServer: deps.identifyOnServer,
  });

  const sharing = async (): Promise<UsageSharingState | null> => {
    if (!client.enabled) return null;
    const enabled = await deps.consent().catch(() => false);
    const noticeNeeded =
      deps.noticeApplies && (await deps.local.get(NOTICE_KEY).catch(() => true)) !== true;
    return { enabled, noticeNeeded };
  };

  const handle = async (request: PageRequest): Promise<unknown> => {
    switch (request.action) {
      case "track":
        await client.trackUnchecked(request.name, request.props);
        // Any use counts toward the day, not only a background start (a worker can live overnight).
        await client.trackDaily("active", "active", {});
        // Chrome and Firefox: setup is complete the first time someone opens Still's popup.
        if (request.name === "opened" && (deps.surface === "chrome" || deps.surface === "firefox")) {
          await client.trackOnce("setup_completed", "setup_completed", {});
        }
        return true;
      case "identify":
        await identify(request.userId);
        return true;
      case "reset":
        await client.reset({ forgetAccount: request.forgetAccount });
        return true;
      case "sharing":
        return sharing();
      case "setSharing": {
        await deps.storeConsent?.(request.enabled);
        const enabled = await deps.consent().catch(() => false);
        if (enabled) void client.flush();
        else await client.clearQueue();
        return enabled;
      }
      case "acknowledgeNotice":
        await deps.local.set(NOTICE_KEY, true).catch(() => undefined);
        return true;
    }
  };

  return {
    client,
    identify,
    onInstalled(details) {
      if (details.reason === "install") {
        void deps
          .identity()
          .then((id) => client.track("installed", { returning: id.returning }))
          .catch(() => {});
      } else if (details.reason === "update" && details.previousVersion !== deps.appVersion) {
        void client.trackUnchecked("updated", { from: details.previousVersion, to: deps.appVersion });
      }
    },
    onStart(userId) {
      if (userId) {
        void identify(userId);
      } else if (userId === null) {
        // The account is gone (signed out elsewhere, deleted, expired). Its waiting events go with
        // it: if it was deleted, sending them would recreate the person the server just removed.
        void client.reset({ onlyIfSignedIn: true, forgetAccount: true });
      }
      // A running Safari extension is the only proof on iPhone that it was switched on.
      if (deps.surface === "safari-ios" || deps.surface === "safari-macos") {
        void client.trackOnce("extension_enabled", "setup_step", { step: "extension_enabled" });
        void client.trackOnce("setup_completed", "setup_completed", {});
      }
      void client.trackDaily("active", "active", {});
      void client.flush();
    },
    listener(message, sender, sendResponse) {
      if (typeof message !== "object" || message === null) return false;
      const m = message as Record<string, unknown>;
      if (m.kind !== ANALYTICS_MESSAGE_KIND || !deps.isTrustedPage(sender)) return false;
      const request = parsePageRequest(m);
      if (!request) return false;
      void handle(request)
        .then(sendResponse, () => sendResponse(null))
        .catch(() => {});
      return true;
    },
  };
}

function parsePageRequest(m: Record<string, unknown>): PageRequest | null {
  switch (m.action) {
    case "track":
      return typeof m.name === "string" ? { action: "track", name: m.name, props: m.props } : null;
    case "identify":
      return typeof m.userId === "string" ? { action: "identify", userId: m.userId } : null;
    case "setSharing":
      return typeof m.enabled === "boolean" ? { action: "setSharing", enabled: m.enabled } : null;
    case "reset":
      return { action: "reset", forgetAccount: m.forgetAccount === true };
    case "sharing":
    case "acknowledgeNotice":
      return { action: m.action };
    default:
      return null;
  }
}

// ── Popup / options pages ─────────────────────────────────────────────────────────────────────

export type AnalyticsSend = (message: Record<string, unknown>) => Promise<unknown>;

export interface PageAnalyticsOptions {
  /** Transport to the background (runtime.sendMessage with ANALYTICS_MESSAGE_KIND added). */
  readonly send: AnalyticsSend;
  /** Where the page itself must change consent inside the tap (Firefox's permission prompt).
   * Resolves once the change is made or declined. */
  readonly changeConsent?: (enabled: boolean) => Promise<unknown>;
  /** False where this page shows no switch (the Safari popup: the Apple app owns it). */
  readonly showsSwitch?: boolean;
}

/** The page side of UiAnalytics: every call is a message to the background's client. */
export function createPageAnalytics(options: PageAnalyticsOptions): UiAnalytics {
  const { send } = options;
  const fire = (message: Record<string, unknown>): void => {
    void send(message).catch(() => {});
  };
  const page: UiAnalytics = {
    track: (name, props) => fire({ action: "track", name, props }),
    identify: (userId) => fire({ action: "identify", userId }),
    reset: (options) => fire({ action: "reset", forgetAccount: options?.forgetAccount === true }),
    acknowledgeNotice: () => fire({ action: "acknowledgeNotice" }),
  };
  if (options.showsSwitch === false) return page;
  return {
    ...page,
    async sharing() {
      const state = await send({ action: "sharing" }).catch(() => null);
      if (typeof state !== "object" || state === null) return null;
      const { enabled, noticeNeeded } = state as Record<string, unknown>;
      return typeof enabled === "boolean" ? { enabled, noticeNeeded: noticeNeeded === true } : null;
    },
    setSharing(enabled) {
      // Called synchronously from the tap: a permission prompt here still has the user gesture.
      const change = options.changeConsent
        ? options.changeConsent(enabled).catch(() => undefined)
        : Promise.resolve();
      return change.then(async () => {
        const result = await send({ action: "setSharing", enabled }).catch(() => null);
        return typeof result === "boolean" ? result : !enabled;
      });
    },
  };
}
