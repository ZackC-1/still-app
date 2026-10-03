import { AnalyticsClient, type AnalyticsConfig, type AnalyticsClientDeps } from "./client.js";
import {
  privacyPolicyReady,
  readAnalyticsPermission,
  samePermission,
  type AnalyticsPermission,
  type AnalyticsPrivacyPolicy,
} from "./consent.js";
import { createAccountIdentifier } from "./extension-host.js";
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
  readonly permission?: () => Promise<AnalyticsPermission | null>;
  readonly privacyPolicy?: AnalyticsPrivacyPolicy;
  readonly envelope?: AnalyticsClientDeps["envelope"];
  readonly commitPermission?: (enabled: boolean) => Promise<void>;
  /** Web view storage for the queue and markers (localStorage, or memory when refused). */
  readonly store: AnalyticsKeyValue;
  /** Ask Still's server to attach the signed-in account's email (analytics-identify). */
  readonly identifyOnServer?: (signal?: AbortSignal) => Promise<void>;
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
  /** Confirm and identify the account (fast, local), then run the server attach on its own. */
  readonly identify: (userId: string) => Promise<void>;
  readonly attach: () => Promise<void>;
}

export function createAppAnalytics(deps: AppAnalyticsDeps): AppAnalytics {
  let consent = false;
  let noticeSeen = true;
  let readyPromise: Promise<Ready | null> | null = null;
  let currentReady: Ready | null = null;
  let epoch = 0;

  const ready = (): Promise<Ready | null> =>
    (readyPromise ??= (async () => {
      const asked = epoch;
      const permission = readAnalyticsPermission(await deps.permission?.().catch(() => null));
      if (
        !privacyPolicyReady(deps.privacyPolicy) ||
        permission?.state !== "granted" ||
        permission.version !== deps.privacyPolicy?.permissionVersion
      )
        return null;
      const context = await deps.bridge.analyticsContext().catch(() => null);
      if (
        !context ||
        asked !== epoch ||
        !samePermission(permission, readAnalyticsPermission(await deps.permission?.().catch(() => null)))
      )
        return null;
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
        }),
        consent: async () => consent,
        permission: deps.permission,
        privacyPolicy: deps.privacyPolicy,
        envelope: deps.envelope,
        fetch: deps.fetch ?? ((...args) => fetch(...args)),
        now: deps.now ?? Date.now,
        uuid: deps.uuid ?? (() => crypto.randomUUID()),
        // Nobody is attributed until the launch's account check (or a sign-in) confirms the account.
        startsUnconfirmed: true,
      });
      if (!client.enabled) return null;

      const accounts = createAccountIdentifier({
        client,
        local: deps.store,
        consent: async () => consent,
        identifyOnServer: deps.identifyOnServer,
      });
      currentReady = {
        client,
        context,
        identify: (userId: string) => client.identify(userId), // confirms the account (client.ts rule 3)
        attach: () => accounts.attach(),
      };
      return currentReady;
    })().then((r) => {
      if (!r) readyPromise = null;
      return r;
    }));

  // Eligibility belongs to the observed action, before native/startup promises settle.
  const observed = async (): Promise<Ready | null> => {
    const asked = epoch;
    const stamp = currentReady?.client.stamp();
    const permission = readAnalyticsPermission(await deps.permission?.().catch(() => null));
    if (permission?.state !== "granted") return null;
    const r = await ready();
    if (
      !r ||
      asked !== epoch ||
      (stamp && !r.client.isCurrent(stamp)) ||
      !samePermission(permission, readAnalyticsPermission(await deps.permission?.().catch(() => null)))
    )
      return null;
    return r;
  };
  const withReady = (run: (r: Ready) => Promise<unknown> | void): void => {
    void observed()
      .then((r) => (r ? run(r) : undefined))
      .catch(() => {});
  };

  let extensionBaseline: boolean | null = null;
  const reportExtensionEnabled = async (r: Ready, enabled: boolean | null): Promise<void> => {
    if (r.context.platform !== "macos") return;
    const previous = extensionBaseline;
    extensionBaseline = enabled;
    if (enabled === null || previous === null || enabled === previous) return;
    await r.client.track(
      enabled ? "extension_enabled" : "extension_disabled",
      { detected_by: "app_check" },
      { quiet: true },
    );
  };

  const ui: UiAnalytics = {
    track: (name, props) =>
      withReady(async (r) => {
        await r.client.track(name, props);
        await r.client.trackDaily("active", "active", {}); // any use counts toward the day
        void r.attach(); // a failed launch attach is retried by ordinary app use
      }),
    identify: (userId) =>
      withReady(async (r) => {
        await r.identify(userId); // a completed sign-in confirms the account
        void r.attach();
      }),
    // Resolves once the account is let go of (deletion waits for it).
    reset: (options) =>
      ready()
        .then((r) => r?.client.reset(options))
        .catch(() => undefined),
    async sharing() {
      const r = await ready();
      return r ? { enabled: await r.client.canReport(), noticeNeeded: !noticeSeen } : null;
    },
    async setSharing(enabled) {
      epoch += 1;
      currentReady?.client.permissionChanged();
      consent = false;
      if (enabled && !deps.commitPermission) return false;
      try {
        if (deps.commitPermission) await deps.commitPermission(enabled);
        else await deps.bridge.setAnalyticsConsent(false);
      } catch {
        return false;
      }
      await currentReady?.client.clearQueue();
      if (!enabled) return false;
      readyPromise = null;
      currentReady = null;
      const r = await ready();
      consent = !!r && (await r.client.canReport());
      if (consent) await r!.client.track("analytics_choice_made", { choice: "share" });
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
      const r = await observed();
      if (!r) return;
      const { client, context } = r;
      // Only launches observed under fresh permission are eligible; never replay stored history.
      if (context.previousVersion)
        await client.track("updated", {
          from: context.previousVersion,
          to: context.appVersion,
        });
      else if (context.created)
        await client.trackOnce("installed", "installed", {
          returning: context.returning,
        });
      await client.trackOnce("app_opened", "setup_step", {
        step: "app_opened",
      });
      await reportExtensionEnabled(r, context.extensionEnabled);
      await client.track("opened", { where: "app" });
      await client.trackDaily("active", "active", {});
      await client.flush();
      void r.attach(); // the flush may have recovered the launch's account confirmation
    },
    async recheckSetup() {
      const r = await observed();
      if (!r) return;
      const observation = await r.client.captureObservation();
      const fresh = await deps.bridge.analyticsContext().catch(() => null);
      if (!(await r.client.observationCurrent(observation))) return;
      await reportExtensionEnabled(r, fresh?.extensionEnabled ?? null);
      await r.client.trackDaily("active", "active", {});
      void r.attach();
    },
    async identifyAccount(userId) {
      const r = await ready();
      if (!r) return;
      await r.identify(userId); // a live session confirms the account
      // The server attach is separate from the account check: its network time never delays it.
      void r.attach();
    },
    async accountAbsent() {
      const r = await ready();
      if (!r) return;
      await r.client.confirm(null, { forget: true }); // known: nobody is signed in
    },
  };
}
