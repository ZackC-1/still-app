import type { AnalyticsPermission, AnalyticsPrivacyPolicy } from "./consent.js";
import { AnalyticsClient, type AnalyticsConfig, type AnalyticsClientDeps, type TrackOptions } from "./client.js";
import { canonicalEvent, isAppClientEvent, type AnalyticsDevice, type AnalyticsSurface } from "./events.js";
import type { AnalyticsIdentity, AnalyticsKeyValue } from "./identity.js";
import type { UiAnalytics, UsageSharingState } from "../ui/controller.svelte.js";

// The analytics host every browser extension build shares (Chrome, Firefox, Safari). The
// extension's background owns the one client, so a popup that closes mid-send loses nothing and
// there is one queue per browser profile. Pages talk to it over ANALYTICS_MESSAGE_KIND. Content
// scripts send nothing: they run on the sites people visit, and Still never records browsing.
//
// A background usually starts because someone just opened YouTube, Instagram, Facebook or TikTok
// (the content script wakes it), or because the analytics alarm fired. So:
//   * Background work is "quiet": stamped with its day only and not sent then (client.ts
//     TrackOptions). It goes out with the next popup or settings open, or at the random time the
//     alarm picks, so neither the event nor its arrival says when a site was visited.
//   * A day of use (`active`) comes only from real use: the content script's visit nudge
//     (onActivity) or a Still screen. A background start by itself (an alarm, a browser restart)
//     records nothing, so the alarm can never manufacture retention.
//   * Every send waits for the start's account check, so an account that has ended is let go (and
//     its waiting events dropped) before anything leaves.
//
// What differs by build is injected: where the ids come from (browser sync storage, or the Apple
// App Group), who owns consent (a stored switch, Firefox's data-collection permission, or the
// Apple app's switch), and whether the one-time notice applies.

export const ANALYTICS_MESSAGE_KIND = "still:analytics";
export const NOTICE_KEY = "still:analytics:notice-seen";
export const SERVER_IDENTIFIED_KEY = "still:analytics:server-identified";
/** Legacy storage key retained for migration/tests. Its pre-consent history is never replayed. */
export const PENDING_INSTALL_KEY = "still:analytics:pending-install";

const QUIET: TrackOptions = { quiet: true };
/** Longest a send waits for the background start's account check. */
export const START_HOLD_LIMIT_MS = 10_000;
/** Longest one server email attach may take before a later screen may try again. */
export const SERVER_ATTACH_LIMIT_MS = 15_000;

export interface MessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: unknown;
  readonly incognito?: boolean;
}

export interface ExtensionAnalyticsHostDeps {
  readonly surface: AnalyticsSurface;
  readonly device?: AnalyticsDevice;
  readonly config: AnalyticsConfig;
  readonly appVersion: string;
  /** This extension's local storage: account, markers, notice flag and a pending install. */
  readonly local: AnalyticsKeyValue;
  /** Where queued events wait: IndexedDB private to the background (idb.ts). */
  readonly queueStore?: AnalyticsKeyValue;
  readonly identity: () => Promise<AnalyticsIdentity>;
  readonly consent: () => Promise<boolean>;
  readonly permission?: () => Promise<AnalyticsPermission | null>;
  readonly privacyPolicy?: AnalyticsPrivacyPolicy;
  readonly envelope?: AnalyticsClientDeps["envelope"];
  /** Existing common authority commits the actual reviewed combined choice; legacy toggles cannot grant. */
  readonly commitPermission?: (enabled: boolean) => Promise<void>;
  /** Persist a switch change. Absent where something else owns consent (Firefox's permission,
   * the Apple app's switch); the host then re-reads `consent` after a change. */
  readonly storeConsent?: (enabled: boolean) => Promise<void>;
  /** Whether this surface shows the one-time "sharing is on" notice. */
  readonly noticeApplies: boolean;
  /** Only extension pages (popup, options) may use the page protocol. */
  readonly isTrustedPage: (sender: MessageSender) => boolean;
  /** Ask Still's server to attach the signed-in account's email (analytics-identify). */
  readonly identifyOnServer?: (signal?: AbortSignal) => Promise<void>;
  /** Ask for a flush at a random later time (an alarm), for events recorded quietly at a
   * background start. Without it they wait for the next popup or settings open. */
  readonly requestQuietFlush?: () => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export interface ExtensionAnalyticsHost {
  readonly client: AnalyticsClient;
  /** runtime.onInstalled: `installed` for a new install, `updated` for an update. */
  onInstalled(details: { reason: string; previousVersion?: string }): void;
  /** Background start: one quiet `active` a day, setup complete on Safari (the extension is
   * running), a pending install if sharing is now on, and the current account. `null` means known to
   * be signed out (an earlier account is let go, whether it signed out here, elsewhere or was
   * deleted); `undefined` means it could not be read, so nothing about the account changes. */
  onStart(userId: string | null | undefined): void;
  /** The content script's visit nudge: real use. One quiet `active` for the day, and on Safari the
   * setup milestones (the extension demonstrably runs). */
  onActivity(): void;
  /** Flush after the start's account check has settled (the alarm handler). */
  flushWhenReady(): Promise<void>;
  /** Identify the install, and once per account have the server attach the email. */
  identify(userId: string, options?: TrackOptions): Promise<void>;
  readonly listener: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean;
}

type PageRequest =
  | {
      readonly action: "track";
      readonly name: string;
      readonly props?: unknown;
    }
  | { readonly action: "identify"; readonly userId: string }
  | { readonly action: "reset"; readonly forgetAccount: boolean }
  | { readonly action: "sharing" }
  | { readonly action: "setSharing"; readonly enabled: boolean }
  | { readonly action: "acknowledgeNotice" };

export interface AccountIdentifier {
  /** Identify the install as this account; an ordinary (not quiet) identify also runs the attach. */
  identify(userId: string, options?: TrackOptions): Promise<void>;
  /**
   * The server email attach for whichever account the client reports as right now, once per
   * account while sharing is on. It never changes the account itself (a stale read must not restore
   * an account that signed out meanwhile), it re-checks the account and sharing immediately before
   * the request, and concurrent calls share one attempt. A quiet identify (a background start)
   * never runs it: its arrival time would mark a site visit.
   */
  attach(): Promise<void>;
}

/** Shared by the extension host and the Apple app. */
export function createAccountIdentifier(deps: {
  readonly client: AnalyticsClient;
  readonly local: AnalyticsKeyValue;
  readonly consent: () => Promise<boolean>;
  readonly identifyOnServer?: (signal?: AbortSignal) => Promise<void>;
}): AccountIdentifier {
  const { client } = deps;
  const consented = () => deps.consent().catch(() => false);
  // One attempt at a time per account: a request still running for account A never stands in for
  // account B, and a hung request is abandoned after SERVER_ATTACH_LIMIT_MS so retries continue.
  const inflight = new Map<string, Promise<void>>();
  const attach = async (): Promise<void> => {
    if (!deps.identifyOnServer || !client.enabled || !client.accountConfirmed) return;
    const userId = await client.signedInAs();
    if (!userId) return;
    const existing = inflight.get(userId);
    if (existing) return existing;
    const attempt = (async () => {
      const stamp = client.stamp();
      const observation = await client.captureObservation();
      if (!observation) return;
      if (!(await consented()) || !(await client.canReport())) return;
      const marker = await deps.local.get(SERVER_IDENTIFIED_KEY).catch(() => null);
      const authority = {
        userId,
        origin: observation.permission.origin,
        generation: observation.permission.generation,
        version: observation.permission.version,
      };
      if (
        marker &&
        typeof marker === "object" &&
        Object.entries(authority).every(([key, value]) => (marker as Record<string, unknown>)[key] === value)
      )
        return;
      // Immediately before the request: same confirmed account, sharing still on, nothing reset.
      if ((await client.signedInAs()) !== userId || !(await consented())) return;
      if (
        !client.accountConfirmed ||
        !(await client.canReport()) ||
        !client.isCurrent(stamp) ||
        !(await client.observationCurrent(observation))
      )
        return;
      const controller = new AbortController();
      const scope = client.cancellationSignal();
      const abort = () => controller.abort();
      scope.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error("cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, {
          once: true,
        });
      });
      try {
        if (scope.aborted || !client.isCurrent(stamp)) return;
        await Promise.race([
          deps.identifyOnServer!(controller.signal),
          cancelled,
          new Promise<never>(
            (_, reject) =>
              (timer = setTimeout(() => {
                controller.abort();
                reject(new Error("timeout"));
              }, SERVER_ATTACH_LIMIT_MS)),
          ),
        ]);
        if (
          client.accountConfirmed &&
          client.isCurrent(stamp) &&
          (await client.canReport()) &&
          (await client.observationCurrent(observation)) &&
          client.isCurrent(stamp)
        )
          await deps.local.set(SERVER_IDENTIFIED_KEY, authority);
      } catch {
        /* retried at the next Still screen */
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        scope.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", rejectAbort);
      }
    })().finally(() => inflight.delete(userId));
    inflight.set(userId, attempt);
    return attempt;
  };
  return {
    async identify(userId, options = {}) {
      await client.identify(userId, options);
      if (!options.quiet) await attach();
    },
    attach,
  };
}

export function createExtensionAnalyticsHost(deps: ExtensionAnalyticsHostDeps): ExtensionAnalyticsHost {
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  const client = new AnalyticsClient({
    config: deps.config,
    surface: deps.surface,
    device: deps.device,
    appVersion: deps.appVersion,
    store: deps.local,
    queueStore: deps.queueStore,
    identity: deps.identity,
    consent: deps.consent,
    permission: deps.permission,
    privacyPolicy: deps.privacyPolicy,
    envelope: deps.envelope,
    fetch: deps.fetch ?? ((...args) => fetch(...args)),
    now,
    uuid,
    // Nobody is attributed until onStart (or a page) confirms the account.
    startsUnconfirmed: true,
  });
  const accounts = createAccountIdentifier({
    client,
    local: deps.local,
    consent: deps.consent,
    identifyOnServer: deps.identifyOnServer,
  });
  const identify = (userId: string, options?: TrackOptions) => accounts.identify(userId, options);
  const blocksAtInstall = deps.surface === "chrome" || deps.surface === "firefox";
  const isSafari = deps.surface === "safari-ios" || deps.surface === "safari-macos";
  // One bounded startup result that activity waits on. Only a start that actually established the
  // account confirms it (client.confirm); a start that never reports, or reports "unknown", leaves
  // the account unconfirmed, so nothing is sent and new events wait unattributed. Elapsed time is
  // never treated as a successful check.
  let startSettled!: () => void;
  const started = new Promise<void>((resolve) => (startSettled = resolve));
  let startResult: Promise<void> | null = null;
  const waitForStart = (): Promise<void> => {
    if (client.accountConfirmed) return Promise.resolve();
    return (startResult ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, START_HOLD_LIMIT_MS);
      void started.then(() => {
        clearTimeout(timer);
        resolve();
      });
    }));
  };
  const requestFlushIfNeeded = async (): Promise<void> => {
    if ((await client.queuedCount()) > 0) deps.requestQuietFlush?.();
  };

  const sharing = async (): Promise<UsageSharingState | null> => {
    if (!client.enabled) return null;
    const enabled = await client.canReport();
    const noticeNeeded = deps.noticeApplies && (await deps.local.get(NOTICE_KEY).catch(() => true)) !== true;
    return { enabled, noticeNeeded };
  };

  const handle = async (
    request: PageRequest,
    observation: ReturnType<AnalyticsClient["captureObservation"]>,
  ): Promise<unknown> => {
    switch (request.action) {
      case "track": {
        const captured = await observation;
        if (!captured) return false;
        await waitForStart();
        if (!(await client.observationCurrent(captured))) return false;
        await client.trackUnchecked(request.name, request.props);
        // Any use counts toward the day, not only a background start (a worker can live overnight).
        await client.trackDaily("active", "active", {});
        // A Still screen is an ordinary moment: finish a server email attach that a background
        // start deferred, or that failed earlier. It never changes the account (see attach).
        await accounts.attach();
        return true;
      }
      case "identify":
        // A page reports the signed-in account from its session: that confirms the account.
        await identify(request.userId);
        return true;
      case "reset":
        await client.reset({ forgetAccount: request.forgetAccount });
        return true;
      case "sharing":
        return sharing();
      case "setSharing": {
        client.permissionChanged();
        if (request.enabled && !deps.commitPermission) return false;
        if (deps.commitPermission) await deps.commitPermission(request.enabled);
        else await deps.storeConsent?.(false);
        await client.clearQueue();
        if (request.enabled && (await client.canReport())) {
          await client.track("analytics_choice_made", { choice: "share" });
          return true;
        }
        return false;
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
        const asked = client.stamp();
        void (async () => {
          if (!(await client.canReport()) || !client.isCurrent(asked)) return;
          const id = await deps.identity();
          if (!(await client.canReport()) || !client.isCurrent(asked)) return;
          await client.trackOnce("installed", "installed", {
            returning: id.returning,
          });
          if (blocksAtInstall) await client.trackOnce("setup_completed", "setup_completed", {});
        })().catch(() => {});
      } else if (details.reason === "update" && details.previousVersion !== deps.appVersion) {
        void client.trackUnchecked("updated", {
          from: details.previousVersion,
          to: deps.appVersion,
        });
      }
    },
    onStart(userId) {
      void (async () => {
        if (userId) {
          await identify(userId, QUIET);
        } else if (userId === null) {
          // The account is gone (signed out elsewhere, deleted, expired). Its waiting events go with
          // it: if it was deleted, sending them would recreate the person the server just removed.
          await client.confirm(null, { forget: true, quiet: true });
        }
        // undefined: the account could not be read. It stays unconfirmed.
        await requestFlushIfNeeded();
      })()
        .catch(() => {})
        .finally(() => startSettled());
    },
    onActivity() {
      const observation = client.captureObservation();
      void (async () => {
        const captured = await observation;
        if (!captured) return;
        await waitForStart();
        if (!(await client.observationCurrent(captured))) return;
        // A running Safari extension is the only proof on iPhone that it was switched on.
        if (isSafari) {
          await client.trackOnce("extension_enabled", "setup_step", { step: "extension_enabled" }, QUIET);
          await client.trackOnce("setup_completed", "setup_completed", {}, QUIET);
        }
        await client.trackDaily("active", "active", {}, QUIET);
        await requestFlushIfNeeded();
      })().catch(() => {});
    },
    async flushWhenReady() {
      await waitForStart();
      await client.flush();
    },
    listener(message, sender, sendResponse) {
      if (typeof message !== "object" || message === null) return false;
      const m = message as Record<string, unknown>;
      if (m.kind !== ANALYTICS_MESSAGE_KIND || !deps.isTrustedPage(sender)) return false;
      if (
        sender.incognito === true ||
        (sender.tab && typeof sender.tab === "object" && (sender.tab as { incognito?: unknown }).incognito === true)
      )
        return false;
      const request = parsePageRequest(m);
      if (!request) return false;
      if (request.action === "setSharing" && !request.enabled) {
        client.permissionChanged();
        void client.clearQueue();
      }
      void handle(request, client.captureObservation())
        .then(sendResponse, () => sendResponse(null))
        .catch(() => {});
      return true;
    },
  };
}

function parsePageRequest(m: Record<string, unknown>): PageRequest | null {
  switch (m.action) {
    case "track": {
      const event = canonicalEvent(m.name, m.props);
      return event && isAppClientEvent(event.name) ? { action: "track", name: event.name, props: event.props } : null;
    }
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
    // Resolves once the background has let go of the account (deletion waits for it).
    reset: (options) =>
      send({
        action: "reset",
        forgetAccount: options?.forgetAccount === true,
      }).then(
        () => undefined,
        () => undefined,
      ),
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
      const change = options.changeConsent ? options.changeConsent(enabled).catch(() => undefined) : Promise.resolve();
      return change.then(async () => {
        const result = await send({ action: "setSharing", enabled }).catch(() => null);
        return typeof result === "boolean" ? result : !enabled;
      });
    },
  };
}
