import { parseAccountSyncStatus } from "@still/core/sync";
import {
  ANALYTICS_MESSAGE_KIND,
  createExtensionAnalyticsHost,
  createPageAnalytics as createSharedPageAnalytics,
  isAnalyticsId,
  isDeviceClass,
  privacyPolicyReady,
  readAnalyticsPermission,
  type AnalyticsDevice,
  type AnalyticsConfig,
  type AnalyticsKeyValue,
  type ExtensionAnalyticsHost,
  type ExtensionAnalyticsHostDeps,
  type MessageSender,
} from "@still/core/analytics";
import type { UiAnalytics } from "@still/core/ui";

// Product analytics for the Safari extension (iPhone and Mac), over core's shared extension host.
// The existing common permission owns provider IDs and eligibility. Missing verified combined
// permission/capability bindings hold reporting, including optional native context reads. Once
// permitted, native context proves hardware metadata; its functional install/anchor IDs never
// become provider IDs. The popup shows no switch or notice: the Apple app owns the choice.
// The app's read-only account-status lane confirms attribution; native fresh-consent/provider
// capability bindings remain a separate integration gate.

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
  const { installId, anchorId, consent, platform, device } =
    analytics as Record<string, unknown>;
  if (!isAnalyticsId(installId) || !isAnalyticsId(anchorId)) return null;
  return {
    installId,
    anchorId,
    consent: consent === true, // fails closed if the field is ever missing
    platform: platform === "ios" || platform === "macos" ? platform : null,
    device: isDeviceClass(device) ? device : null,
  };
}

export interface SafariAnalyticsDeps extends Pick<
  ExtensionAnalyticsHostDeps,
  "permission" | "privacyPolicy" | "envelope" | "subjects"
> {
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
  /** Send what is queued (the quiet-flush alarm), after re-reading the app's account. */
  flush(): void;
  /** Real use (the content script's reconcile nudge). */
  onActivity(): void;
  /** Background start: reads the app's signed-in account, then reports setup and the active day. */
  onStart(): void;
  readonly listener: ExtensionAnalyticsHost["listener"];
  stop(): void;
}

export function createSafariBackgroundAnalytics(
  deps: SafariAnalyticsDeps,
): SafariBackgroundAnalytics {
  let stopped = false;
  const cancellations = new Set<() => void>();
  // Bounds belong to this host, not a second permission/account authority. Every successful,
  // failed or stopped read releases its timer; late native replies cannot publish metadata.
  const bounded = <T>(read: () => Promise<T>): Promise<T | null> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancellations.delete(cancel);
        resolve(value);
      };
      const cancel = () => finish(null);
      const timer = setTimeout(cancel, 5_000);
      cancellations.add(cancel);
      if (stopped) {
        cancel();
        return;
      }
      // Invoke now: deferring the read itself by a microtask can turn a held entry into a
      // later grant before the common client has captured its original authority.
      try {
        void Promise.resolve(read()).then(finish, cancel);
      } catch {
        cancel();
      }
    });
  const permission = async () =>
    readAnalyticsPermission(
      await bounded(() => deps.permission?.() ?? Promise.resolve(null)),
    );
  const granted = async () => {
    if (
      stopped ||
      !host.client.enabled ||
      !privacyPolicyReady(deps.privacyPolicy) ||
      !deps.permission
    )
      return null;
    const value = await permission();
    return value?.state === "granted" &&
      value.version === deps.privacyPolicy?.permissionVersion
      ? value
      : null;
  };
  let metadata: {
    surface: "safari-ios" | "safari-macos";
    device: AnalyticsDevice | undefined;
  } | null = null;
  let metadataFlight: Promise<boolean> | null = null;
  const proveMetadata = (): Promise<boolean> => {
    if (metadata) return Promise.resolve(true);
    if (metadataFlight) return metadataFlight;
    const operation = (async () => {
      // The current common permission/capabilities must allow this optional native read.
      if (!(await granted())) return false;
      const native = parseNativeAnalytics(
        await bounded(() => deps.sendNative({ kind: "analyticsContext" })),
      );
      if (!native || stopped) return false;
      const os = native.platform ?? (await bounded(deps.platform));
      if (
        stopped ||
        !(await granted()) ||
        !["ios", "macos", "mac"].includes(String(os))
      )
        return false;
      const mac = os === "macos" || os === "mac";
      metadata = {
        surface: mac ? "safari-macos" : "safari-ios",
        device: native.device ?? (mac ? "desktop" : undefined),
      };
      return true;
    })().catch(() => false);
    const flight = operation.finally(() => {
      if (metadataFlight === flight) metadataFlight = null;
    });
    metadataFlight = flight;
    return flight;
  };
  const host = createExtensionAnalyticsHost({
    // The provisional value only classifies this as a Safari host. No observation/admission
    // is allowed until proveMetadata has established the actual emitted surface/device.
    get surface() {
      return metadata?.surface ?? "safari-ios";
    },
    get device() {
      return metadata?.device;
    },
    config: deps.config,
    appVersion: deps.appVersion,
    local: deps.local,
    queueStore: deps.queue ?? undefined,
    privacyPolicy: deps.privacyPolicy,
    permission,
    envelope: deps.envelope,
    // One fresh App Group read per check once the surface is proven (it is cached for the life of
    // the background); the first check reads again after the native context read.
    consent: async () => {
      if (!(await granted())) return false;
      if (metadata) return true;
      return (await proveMetadata()) && !!(await granted());
    },
    identity: async () => {
      const current = await granted();
      if (!current) throw new Error("Optional provider identity unavailable");
      // A projection of the existing permission origin, never the native functional IDs.
      return {
        installId: current.provider.deviceId,
        anchorId: current.provider.anonymousId,
        created: false,
        returning: false,
      };
    },
    noticeApplies: false,
    // V3 builds: signed-in use reports under the device's identity the app was issued (owner
    // decision 50; lib/default-on-analytics.ts). The inline build-time check folds this away in
    // every 2.x build, byte-for-byte.
    ...(import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" ||
    import.meta.env.VITE_APPLE_ATOMIC_SETTINGS === "true"
      ? { subjects: deps.subjects }
      : {}),
    isTrustedPage: deps.isTrustedPage,
    requestQuietFlush: deps.requestQuietFlush,
    fetch: deps.fetch,
    now: deps.now,
    uuid: deps.uuid,
  });
  type Observation = ReturnType<typeof host.client.captureObservation>;
  type Captured = NonNullable<Awaited<Observation>>;
  const current = async (observation: Observation) => {
    const captured = await observation;
    return !stopped &&
      captured &&
      (await host.client.observationCurrent(captured))
      ? captured
      : null;
  };
  // The observation to carry on with, or null to drop the work (ISS-0115). A popup that wakes the
  // background races the start's own account check, and whichever confirms "signed out" first
  // fences what was observed before it, the popup's `opened` included. The client keeps such work
  // only when every confirmation since it was observed let go of nobody and the permission is the
  // very one it arrived under (client.revive); a sign-out of anyone, a deletion or a sharing change
  // still drops it, and a turn-on is never recorded under an earlier origin's ids.
  const revive = async (observation: Captured | null): Promise<Captured | null> =>
    !stopped && observation ? host.client.revive(observation) : null;
  // Account checks (the start's, each page event's, each flush's) read the app's account at once,
  // and the newest answer wins: an earlier answer never lands after a newer one. Applying an answer
  // (confirming, then judging the work) runs one check at a time, so a confirmation has always
  // finished before another check judges its work against it.
  let accountSequence = 0;
  let latestCheck: Promise<unknown> = Promise.resolve();
  let applying: Promise<unknown> = Promise.resolve();
  /** Confirms the app's account for `observation`; answers the observation to record under, or
   * null when the work is to be dropped. */
  const syncAccount = (observation: Observation): Promise<Captured | null> => {
    const check = checkAccount(observation);
    latestCheck = check.catch(() => undefined);
    return check;
  };
  const checkAccount = async (observation: Observation): Promise<Captured | null> => {
    // No permission when it was observed: nothing to record, and the account is not read.
    if (stopped || !(await observation)) return null;
    const sequence = ++accountSequence;
    const reply = await bounded(() =>
      deps.sendNative({ kind: "getAccountSyncStatus" }),
    );
    if (stopped) return null;
    if (sequence !== accountSequence) {
      // Overtaken by a newer check: this answer is not applied. The work is kept only when this
      // check's own answer was a readable "signed out" (the app named someone, or could not be
      // read, for it: dropped), and then only once every newer check has finished, if the device
      // is still signed out with nothing held and nothing but sign-outs of nobody fenced it
      // (revive). Otherwise it is dropped, as before.
      if ((reply as { accountSyncStatus?: unknown } | null)?.accountSyncStatus !== null) return null;
      for (let tail = latestCheck; ; tail = latestCheck) {
        await tail;
        if (tail === latestCheck) break;
      }
      if (stopped || !(await host.client.lettingGoOfNobody())) return null;
      return revive(await observation);
    }
    const next = applying.then(() => applyAccount(observation, reply));
    applying = next.catch(() => undefined);
    return next;
  };
  const applyAccount = async (observation: Observation, reply: unknown): Promise<Captured | null> => {
    let captured = await revive(await observation);
    if (!captured) return null;
    const status = (reply as { accountSyncStatus?: unknown } | null)
      ?.accountSyncStatus;
    const userId =
      status === null ? null : parseAccountSyncStatus(status)?.accountId;
    if (userId === undefined) return null; // unreadable is never confirmed signed-out
    // A repeated confirmed null answer must not retire the observation on every popup.
    if (userId === null) {
      if (
        !host.client.accountConfirmed ||
        (await host.client.signedInAs()) !== null
      ) {
        // V3 builds also forget the cached per-device identity of the account that ended (its
        // App Group entry is cleared by the app). Folded away in 2.x builds, byte-for-byte.
        if (
          import.meta.env.VITE_MODERN_SETTINGS_SYNC_ENABLED === "true" ||
          import.meta.env.VITE_APPLE_ATOMIC_SETTINGS === "true"
        ) {
          const reportingAs = await host.client.signedInAs();
          await host.client.confirm(null, { forget: true, quiet: true });
          await host.forgetSubjects?.(reportingAs);
        } else await host.client.confirm(null, { forget: true, quiet: true });
        captured = await revive(captured);
        if (!captured) return null;
      }
    } else await host.identify(userId, { quiet: true });
    if (stopped) return null;
    host.onStart(undefined); // settle the maintained startup gate after the actual confirmation
    return captured;
  };
  const run = (operation: () => Promise<unknown>) => {
    void operation().catch(() => {});
  };
  return {
    onStart() {
      if (stopped) return;
      const observation = host.client.captureObservation();
      run(() => syncAccount(observation));
    },
    onActivity() {
      if (stopped) return;
      const observation = host.client.captureObservation();
      host.onActivity(observation);
    },
    onInstalled(details) {
      if (stopped || details.reason !== "update") return;
      const observation = host.client.captureObservation();
      host.onInstalled(details, observation);
    },
    flush() {
      if (stopped) return;
      const observation = host.client.captureObservation();
      run(async () => {
        const confirmed = await syncAccount(observation);
        if (confirmed && (await current(Promise.resolve(confirmed))))
          await host.flushWhenReady();
      });
    },
    listener(message, sender, sendResponse) {
      if (
        stopped ||
        !deps.isTrustedPage(sender) ||
        sender.incognito === true ||
        (sender.tab &&
          typeof sender.tab === "object" &&
          (sender.tab as { incognito?: unknown }).incognito === true) ||
        !message ||
        typeof message !== "object" ||
        (message as { kind?: unknown }).kind !== ANALYTICS_MESSAGE_KIND
      )
        return false;
      // Kept even if the start's sign-out lands while it is read: syncAccount decides (revive).
      const observation = host.client.observe();
      run(async () => {
        const confirmed = await revive(await syncAccount(observation));
        if (!confirmed) {
          sendResponse(undefined);
          return;
        }
        if (
          !host.listener(
            message,
            sender,
            sendResponse,
            Promise.resolve(confirmed),
          )
        )
          sendResponse(undefined);
      });
      return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      accountSequence++;
      for (const cancel of [...cancellations]) cancel();
      host.stop();
    },
  };
}

/** The Safari popup's seam: messages to the background, no switch (the app owns it). */
export function createSafariPageAnalytics(
  send: (message: Record<string, unknown>) => Promise<unknown> = (message) =>
    Promise.resolve(
      browser.runtime.sendMessage({ kind: ANALYTICS_MESSAGE_KIND, ...message }),
    ),
): UiAnalytics {
  return createSharedPageAnalytics({ send, showsSwitch: false });
}
