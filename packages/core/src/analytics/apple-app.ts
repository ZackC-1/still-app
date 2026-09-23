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
  /** The launch's account check is done (a session was resumed, or found absent). Nothing is sent
   * before this, so a launch without a session never sends the previous account's events. */
  accountResolved(): void;
}

/** Longest the app holds sends waiting for the launch's account check. */
export const ACCOUNT_RESOLUTION_LIMIT_MS = 15_000;
const PENDING_UPDATE_KEY = "still:analytics:pending-update";

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
      client.holdSendsUntil(sendGate);
      void accountSettled.then((known) => client.setAccountVerified(known));
      const accounts = createAccountIdentifier({
        client,
        local: deps.store,
        consent: async () => consent,
        identifyOnServer: deps.identifyOnServer,
      });
      return { client, context, identify: (userId: string) => accounts.identify(userId) };
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
  // Installs and updates are kept apart: an update before sharing is turned on must not erase the
  // install still waiting to be counted.
  const readPending = async (key: string): Promise<PendingLaunch | null> => {
    const v = (await deps.store.get(key).catch(() => null)) as Partial<PendingLaunch> | null;
    if (!v || (v.kind !== "installed" && v.kind !== "updated") || typeof v.at !== "number") return null;
    return { kind: v.kind, returning: v.returning === true, from: typeof v.from === "string" ? v.from : null, at: v.at };
  };
  const emitPending = async (r: Ready): Promise<void> => {
    if (!consent) return;
    const install = await readPending(PENDING_INSTALL_KEY);
    if (install) {
      await r.client.trackOnce("installed", "installed", { returning: install.returning }, { at: install.at });
      if (await r.client.hasTrackedOnce("installed")) await deps.store.set(PENDING_INSTALL_KEY, null).catch(() => undefined);
    }
    const update = await readPending(PENDING_UPDATE_KEY);
    if (update?.from) {
      const marker = `updated:${r.context.appVersion}`;
      await r.client.trackOnce(marker, "updated", { from: update.from, to: r.context.appVersion }, { at: update.at });
      if (await r.client.hasTrackedOnce(marker)) await deps.store.set(PENDING_UPDATE_KEY, null).catch(() => undefined);
    }
  };

  let resolveAccount!: (known: boolean) => void;
  // The latest account change (identify or let go); resolution waits for it, so the change always
  // lands before the first send.
  let accountOp: Promise<unknown> = Promise.resolve();
  const accountKnown = new Promise<boolean>((r) => (resolveAccount = r));
  // One bounded result for the launch's account check. On a timeout the account is unconfirmed:
  // only anonymous events may be sent until a sign-in or resume confirms it.
  const accountSettled: Promise<boolean> = Promise.race([
    accountKnown,
    new Promise<boolean>((r) => setTimeout(() => r(false), ACCOUNT_RESOLUTION_LIMIT_MS)),
  ]);
  const sendGate = accountSettled;

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
      const wasOn = consent;
      if (!enabled) consent = false; // takes effect now, before any native or network round trip
      consent = await deps.bridge.setAnalyticsConsent(enabled).catch(() => consent);
      if (consent) {
        await emitPending(r);
        void r.client.flush();
      } else {
        // Nothing waiting is sent; then one short standalone attempt records the opt-out.
        await r.client.clearQueue();
        if (wasOn && !enabled) void r.client.sendOptOut();
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
      // Attribution first: this launch's events are recorded only once the account is settled, so a
      // previous account being let go can never discard them.
      await accountSettled;
      const { client, context } = r;
      if (context.previousVersion) {
        await deps.store.set(PENDING_UPDATE_KEY, { kind: "updated", returning: false, from: context.previousVersion, at: now() })
          .catch(() => undefined);
      } else if (context.created && !(await readPending(PENDING_INSTALL_KEY))) {
        await deps.store.set(PENDING_INSTALL_KEY, { kind: "installed", returning: context.returning, from: null, at: now() })
          .catch(() => undefined);
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
    identifyAccount(userId) {
      const op = (async () => {
        const r = await ready();
        if (!r) return;
        r.client.setAccountVerified(true); // a live session confirms the account
        await r.identify(userId);
      })();
      accountOp = accountOp.then(() => op);
      return op;
    },
    accountResolved() {
      void accountOp.catch(() => undefined).then(() => resolveAccount(true));
    },
    accountAbsent() {
      const op = (async () => {
        const r = await ready();
        if (r) await r.client.reset({ onlyIfSignedIn: true, forgetAccount: true });
      })();
      accountOp = accountOp.then(() => op);
      return op;
    },
  };
}
