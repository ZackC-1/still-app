import {
  AnalyticsClient,
  type AnalyticsConfig,
  type AnalyticsClientDeps,
  type AnalyticsObservation,
} from "./client.js";
import {
  privacyPolicyReady,
  readAnalyticsPermission,
  samePermission,
  type AnalyticsPermission,
  type AnalyticsPrivacyPolicy,
} from "./consent.js";
import { createAccountIdentifier, type SubjectDeps } from "./extension-host.js";
import type { AnalyticsKeyValue } from "./identity.js";
import { serverIdentifyFor } from "./events.js";
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
  /** Per-device identities (U5-W2, extension-host.ts SubjectDeps). Absent: the account id is
   * confirmed, as before. */
  readonly subjects?: SubjectDeps;
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
  /** Follow an explicit choice made through `createAppleConsentCommitter`, which writes native
   * itself, so this writes nothing. `false` is called at the Don't share tap, before native
   * confirms anything: like `setSharing(false)` it fences work in flight, stops reporting, drops
   * the queue and ends the permission in force (so a later Share needs a fresh one), and sends
   * nothing, whether or not the launch's native context read has finished. `true` is called only after native confirmed Share: it resumes
   * reporting without fencing (a launch already observed under the on-by-default value keeps its
   * events) and, like `setSharing(true)`, records `analytics_choice_made {choice:"share"}` once. */
  adoptCommittedConsent(enabled: boolean): void;
}

interface Ready {
  readonly client: AnalyticsClient;
  readonly context: AnalyticsContextReply;
  /** Confirm and identify the account (fast, local), then run the server attach on its own. */
  readonly identify: (userId: string) => Promise<void>;
  readonly attach: (observation?: AnalyticsObservation) => Promise<void>;
  /** After a deletion: forget this device's cached per-device subject for the account. */
  readonly forgetSubjects: (reportingAs: string | null, account?: string) => Promise<void>;
}

interface Observed extends Ready {
  readonly observation: AnalyticsObservation;
}

export function createAppAnalytics(deps: AppAnalyticsDeps): AppAnalytics {
  let consent = false;
  /** A Don't share tapped this session (adoptCommittedConsent(false)) holds web reporting off even
   * if native could not record it and still reads on; a later explicit Share clears it. */
  let declinedHere = false;
  /** A Don't share tapped before the launch's client existed, ending the permission in force (see
   * `stopBeforeReady`). The launch's client is built only once it has finished. */
  let stopping: Promise<void> | null = null;
  let noticeSeen = true;
  let readyPromise: Promise<Ready | null> | null = null;
  let currentReady: Ready | null = null;
  let epoch = 0;

  const ready = (): Promise<Ready | null> =>
    (readyPromise ??= (async () => {
      const asked = epoch;
      const permission = readAnalyticsPermission(
        await deps.permission?.().catch(() => null),
      );
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
        !samePermission(
          permission,
          readAnalyticsPermission(await deps.permission?.().catch(() => null)),
        )
      )
        return null;
      while (stopping) {
        const stop = stopping;
        await stop; // the two clients never write the same storage at once
        if (stopping === stop) stopping = null;
      }
      consent = context.consent && !declinedHere;
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
        identifyOnServer: serverIdentifyFor(deps.envelope, deps.identifyOnServer),
        subjects: deps.subjects,
      });
      currentReady = {
        client,
        context,
        // Confirms the account (client.ts rule 3) under this device's issued subject once the server
        // has issued it. Without per-device subjects nothing is confirmed: never the account id.
        identify: (userId: string) => accounts.identify(userId),
        attach: (observation) => accounts.attach(observation),
        forgetSubjects: (reportingAs: string | null, account?: string) => accounts.forgetSubjects(reportingAs, account),
      };
      return currentReady;
    })().then((r) => {
      if (!r) readyPromise = null;
      return r;
    }));

  // A Don't share before the launch's client exists (a first launch's native context read can wait
  // 5 s for iCloud) ends the permission in force at once, durably, through the client's own storage
  // path, exactly as a ready client's Don't share does: the queue is dropped and the permission's
  // origin recorded as stopped, so a later Share needs a fresh permission in both timings. The
  // client made here only touches that storage; it never records, attributes or sends anything.
  const stopBeforeReady = async (): Promise<void> => {
    const permission = readAnalyticsPermission(
      await deps.permission?.().catch(() => null),
    );
    if (
      !privacyPolicyReady(deps.privacyPolicy) ||
      permission?.state !== "granted" ||
      permission.version !== deps.privacyPolicy?.permissionVersion
    )
      return; // no client reports under it, so there is nothing to end
    const client = new AnalyticsClient({
      config: deps.config,
      surface: "app-ios", // not stored with the stop; any valid surface
      appVersion: "0.0.0",
      store: deps.store,
      identity: () => Promise.reject(new Error("This client never reports")),
      // Lets it take up the permission in force, so that is the origin it records as stopped.
      consent: async () => true,
      permission: deps.permission,
      privacyPolicy: deps.privacyPolicy,
      fetch: () => Promise.reject(new Error("This client never sends")),
      now: deps.now ?? Date.now,
      uuid: deps.uuid ?? (() => crypto.randomUUID()),
      startsUnconfirmed: true,
    });
    await client.canReport();
    await client.clearQueue();
  };

  // Eligibility belongs to the observed action, before native/startup promises settle.
  const observed = async (): Promise<Observed | null> => {
    const asked = epoch;
    const stamp = currentReady?.client.stamp();
    const permission = readAnalyticsPermission(
      await deps.permission?.().catch(() => null),
    );
    if (permission?.state !== "granted") return null;
    const r = await ready();
    if (
      !r ||
      asked !== epoch ||
      (stamp && !r.client.isCurrent(stamp)) ||
      !samePermission(
        permission,
        readAnalyticsPermission(await deps.permission?.().catch(() => null)),
      ) ||
      (stamp && !r.client.isCurrent(stamp))
    )
      return null;
    return {
      ...r,
      observation: { stamp: stamp ?? r.client.stamp(), permission },
    };
  };
  const withReady = (run: (r: Observed) => Promise<unknown> | void): void => {
    void observed()
      .then((r) => (r ? run(r) : undefined))
      .catch(() => {});
  };

  let extensionBaseline: boolean | null = null;
  const reportExtensionEnabled = async (
    r: Observed,
    enabled: boolean | null,
  ): Promise<void> => {
    if (r.context.platform !== "macos") return;
    const previous = extensionBaseline;
    extensionBaseline = enabled;
    if (enabled === null || previous === null || enabled === previous) return;
    await r.client.track(
      enabled ? "extension_enabled" : "extension_disabled",
      { detected_by: "app_check" },
      { quiet: true, observation: r.observation },
    );
  };

  const ui: UiAnalytics = {
    track: (name, props) =>
      withReady(async (r) => {
        await r.client.track(name, props, { observation: r.observation });
        await r.client.trackDaily(
          "active",
          "active",
          {},
          { observation: r.observation },
        ); // any use counts toward the day
        void r.attach(r.observation); // a failed launch attach is retried by ordinary app use
      }),
    identify: (userId) =>
      withReady(async (r) => {
        await r.identify(userId); // a completed sign-in confirms the account
        // With per-device subjects the identify was the server request; a failure is retried at
        // the next ordinary use, not again in the same turn.
        if (!deps.subjects) void r.attach();
      }),
    // Resolves once the account is let go of (deletion waits for it). A deletion also forgets this
    // device's cached per-device subject for the account.
    reset: (options) =>
      ready()
        .then(async (r) => {
          if (!r) return;
          const reportingAs = options?.forgetAccount && deps.subjects ? r.client.signedInAs() : null;
          await r.client.reset(options);
          if (options?.forgetAccount && deps.subjects) await r.forgetSubjects(await reportingAs, options.account);
        })
        .catch(() => undefined),
    async sharing() {
      const r = await ready();
      return r ? { enabled: await r.client.canReport(), noticeNeeded: !noticeSeen } : null;
    },
    async setSharing(enabled) {
      if (enabled) declinedHere = false;
      epoch += 1;
      const asked = epoch;
      const previous = currentReady;
      currentReady?.client.permissionChanged();
      consent = false;
      const stopping = !enabled ? previous?.client.clearQueue() : undefined;
      if (enabled && !deps.commitPermission) return false;
      const previousPermission =
        enabled && previous
          ? readAnalyticsPermission(await deps.permission?.().catch(() => null))
          : null;
      try {
        if (deps.commitPermission) await deps.commitPermission(enabled);
        else await deps.bridge.setAnalyticsConsent(false);
      } catch {
        await stopping;
        return false;
      }
      await stopping;
      if (!enabled) return false;
      if (asked !== epoch) return false;
      const permission = readAnalyticsPermission(
        await deps.permission?.().catch(() => null),
      );
      if (previous && samePermission(previousPermission, permission)) {
        const context = await deps.bridge.analyticsContext().catch(() => null);
        if (asked !== epoch || !context) return false;
        consent = context.consent;
        const allowed = await previous.client.canReport();
        if (!allowed || asked !== epoch) return false;
        await previous.client.track("analytics_choice_made", {
          choice: "share",
        });
        return true;
      }
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
      const options = { observation: r.observation };
      // Only launches observed under fresh permission are eligible; never replay stored history.
      if (context.previousVersion)
        await client.track(
          "updated",
          {
            from: context.previousVersion,
            to: context.appVersion,
          },
          options,
        );
      else if (context.created)
        await client.trackOnce(
          "installed",
          "installed",
          {
            returning: context.returning,
          },
          options,
        );
      await client.trackOnce(
        "app_opened",
        "setup_step",
        {
          step: "app_opened",
        },
        options,
      );
      await reportExtensionEnabled(r, context.extensionEnabled);
      await client.track("opened", { where: "app" }, options);
      await client.trackDaily("active", "active", {}, options);
      await client.flush(r.observation);
      void r.attach(r.observation); // the flush may have recovered the launch's account confirmation
    },
    async recheckSetup() {
      const r = await observed();
      if (!r) return;
      const observation = r.observation;
      const fresh = await deps.bridge.analyticsContext().catch(() => null);
      if (!(await r.client.observationCurrent(observation))) return;
      await reportExtensionEnabled(r, fresh?.extensionEnabled ?? null);
      await r.client.trackDaily("active", "active", {}, { observation });
      void r.attach(observation);
    },
    async identifyAccount(userId) {
      const r = await ready();
      if (!r) return;
      await r.identify(userId); // a live session confirms the account
      // The server attach is separate from the account check: its network time never delays it.
      // With per-device subjects the identify was the server request (see ui.identify).
      if (!deps.subjects) void r.attach();
    },
    async accountAbsent() {
      const r = await ready();
      if (!r) return;
      await r.client.confirm(null, { forget: true }); // known: nobody is signed in
    },
    adoptCommittedConsent(enabled) {
      if (!enabled) {
        declinedHere = true;
        epoch += 1; // observations and switch changes still in flight belong to the old choice
        consent = false;
        if (currentReady) {
          currentReady.client.permissionChanged();
          void currentReady.client.clearQueue().catch(() => {});
        } else
          stopping = (stopping ?? Promise.resolve())
            .then(stopBeforeReady)
            .catch(() => {});
        return;
      }
      declinedHere = false;
      consent = true;
      withReady(async (r) => {
        if (!(await r.client.canReport())) return;
        await r.client.track(
          "analytics_choice_made",
          { choice: "share" },
          { observation: r.observation },
        );
      });
    },
  };
}
