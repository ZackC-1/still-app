import { AnalyticsClient, type AnalyticsConfig } from "./client.js";
import { createAccountIdentifier, PENDING_INSTALL_KEY } from "./extension-host.js";
import type { AnalyticsKeyValue } from "./identity.js";
import type { AnalyticsContextReply } from "../native/bridge.js";
import type { UiAnalytics } from "../ui/controller.svelte.js";

// Analytics for the Apple app's web view (iPhone and Mac). The native side owns the ids and the
// "Share usage data" switch, in the App Group, so the Safari extension reports under the same
// install and follows the same switch (AnalyticsIdentity.swift). This side owns the client and the
// launch events. Everything waits for the native context; outside the app (no bridge) or on an
// unconfigured build it does nothing, and the settings switch does not render.

export interface AppAnalyticsBridge {
  analyticsContext(): Promise<AnalyticsContextReply | null>;
  setAnalyticsConsent(enabled: boolean): Promise<boolean>;
  acknowledgeAnalyticsNotice(): Promise<void>;
}

export interface AppAnalyticsDeps {
  readonly bridge: AppAnalyticsBridge;
  readonly config: AnalyticsConfig;
  /** Web view storage for the queue and markers (localStorage, or memory when refused). */
  readonly store: AnalyticsKeyValue;
  /** Ask Still's server to attach the signed-in account's email (analytics-identify). */
  readonly identifyOnServer?: () => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export interface AppAnalytics {
  /** The controller's seam. */
  readonly ui: UiAnalytics;
  /** Launch: install or update, setup progress, one open, one active day. */
  start(): Promise<void>;
  /** Foreground return: the person may have just switched the Safari extension on (Mac). */
  recheckSetup(): Promise<void>;
  /** A signed-in account (resume or sign-in). */
  identifyAccount(userId: string): Promise<void>;
  /** There is known to be no account (a launch with no session, or the session ended). Any earlier
   * account is let go, and its waiting events with it. */
  accountAbsent(): Promise<void>;
}

interface Ready {
  readonly client: AnalyticsClient;
  readonly context: AnalyticsContextReply;
  readonly identify: (userId: string) => Promise<void>;
}

export function createAppAnalytics(deps: AppAnalyticsDeps): AppAnalytics {
  let consent = false;
  let noticeSeen = true;
  let readyPromise: Promise<Ready | null> | null = null;

  const ready = (): Promise<Ready | null> =>
    (readyPromise ??= (async () => {
      const context = await deps.bridge.analyticsContext().catch(() => null);
      if (!context) return null;
      consent = context.consent;
      noticeSeen = context.noticeSeen;
      const client = new AnalyticsClient({
        config: deps.config,
        surface: context.platform === "macos" ? "app-macos" : "app-ios",
        device: context.device ?? (context.platform === "macos" ? "desktop" : undefined),
        appVersion: context.appVersion,
        store: deps.store,
        identity: async () => ({
          installId: context.installId,
          anchorId: context.anchorId,
          created: context.created,
          returning: context.returning,
          aliasOf: context.previousAnchorId ?? undefined,
        }),
        consent: async () => consent,
        fetch: deps.fetch ?? ((...args) => fetch(...args)),
        now: deps.now ?? Date.now,
        uuid: deps.uuid ?? (() => crypto.randomUUID()),
      });
      if (!client.enabled) return null;
      const identify = createAccountIdentifier({
        client,
        local: deps.store,
        consent: async () => consent,
        identifyOnServer: deps.identifyOnServer,
      });
      return { client, context, identify };
    })());

  const withReady = (run: (r: Ready) => Promise<unknown> | void): void => {
    void ready()
      .then((r) => (r ? run(r) : undefined))
      .catch(() => {});
  };

  // An install or update seen while sharing was off is kept (kind, versions, day) and reported the
  // first time sharing is on, so a person who turns sharing on later is still counted.
  interface PendingLaunch {
    readonly kind: "installed" | "updated";
    readonly returning: boolean;
    readonly from: string | null;
    readonly at: number;
  }
  const now = deps.now ?? Date.now;
  const readPending = async (): Promise<PendingLaunch | null> => {
    const v = (await deps.store.get(PENDING_INSTALL_KEY).catch(() => null)) as Partial<PendingLaunch> | null;
    if (!v || (v.kind !== "installed" && v.kind !== "updated") || typeof v.at !== "number") return null;
    return { kind: v.kind, returning: v.returning === true, from: typeof v.from === "string" ? v.from : null, at: v.at };
  };
  const emitPending = async (r: Ready): Promise<void> => {
    const pending = await readPending();
    if (!pending || !consent) return;
    if (pending.kind === "updated" && pending.from) {
      await r.client.trackOnce(`updated:${r.context.appVersion}`, "updated", { from: pending.from, to: r.context.appVersion }, { at: pending.at });
    } else if (pending.kind === "installed") {
      await r.client.trackOnce("installed", "installed", { returning: pending.returning }, { at: pending.at });
    }
    await deps.store.set(PENDING_INSTALL_KEY, null).catch(() => undefined);
  };

  const reportExtensionEnabled = async (r: Ready, enabled: boolean | null): Promise<void> => {
    if (enabled === true) await r.client.trackOnce("extension_enabled", "setup_step", { step: "extension_enabled" });
  };

  const ui: UiAnalytics = {
    track: (name, props) =>
      withReady(async (r) => {
        await r.client.track(name, props);
        await r.client.trackDaily("active", "active", {}); // any use counts toward the day
      }),
    identify: (userId) => withReady((r) => r.identify(userId)),
    reset: (options) => withReady((r) => r.client.reset(options)),
    async sharing() {
      const r = await ready();
      return r ? { enabled: consent, noticeNeeded: !noticeSeen } : null;
    },
    async setSharing(enabled) {
      const r = await ready();
      if (!r) return !enabled;
      if (!enabled && consent) {
        // One last, property-free event so the opt-out rate is measurable.
        await r.client.track("sharing_turned_off", {});
        await r.client.flush();
      }
      consent = await deps.bridge.setAnalyticsConsent(enabled).catch(() => consent);
      if (consent) {
        await emitPending(r);
        void r.client.flush();
      } else {
        await r.client.clearQueue();
      }
      return consent;
    },
    acknowledgeNotice() {
      noticeSeen = true;
      void deps.bridge.acknowledgeAnalyticsNotice().catch(() => {});
    },
  };

  return {
    ui,
    async start() {
      const r = await ready();
      if (!r) return;
      const { client, context } = r;
      if (context.previousVersion || context.created) {
        await deps.store.set(PENDING_INSTALL_KEY, {
          kind: context.previousVersion ? "updated" : "installed",
          returning: context.returning,
          from: context.previousVersion,
          at: now(),
        }).catch(() => undefined);
      }
      await emitPending(r);
      await client.trackOnce("app_opened", "setup_step", { step: "app_opened" });
      await reportExtensionEnabled(r, context.extensionEnabled);
      await client.track("opened", { where: "app" });
      await client.trackDaily("active", "active", {});
      await client.flush();
    },
    async recheckSetup() {
      const r = await ready();
      if (!r) return;
      const fresh = await deps.bridge.analyticsContext().catch(() => null);
      await reportExtensionEnabled(r, fresh?.extensionEnabled ?? null);
      await r.client.trackDaily("active", "active", {});
    },
    async identifyAccount(userId) {
      const r = await ready();
      if (r) await r.identify(userId);
    },
    async accountAbsent() {
      const r = await ready();
      if (r) await r.client.reset({ onlyIfSignedIn: true, forgetAccount: true });
    },
  };
}
