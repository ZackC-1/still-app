import type { SettingsCache, SettingsCacheOptions } from "../../storage/cache.js";
import { EntitlementCache } from "../../entitlement/cache.js";
import {
  WKBenefitAccessAdapter,
  type NativeBenefitSource,
} from "../../entitlement/wk-benefit-adapter.js";
import type { UiAnalytics, DeleteFlow, PurchaseFlow } from "../controller.svelte.js";
import type { SafariSetupObservation } from "../../native/bridge.js";
import { STRINGS } from "../strings.js";
import { PRIVACY_POLICY_URL } from "../config.js";
import { createDesktopPopupBinding } from "./desktop-popup-binding.js";
import type { AppleSettingsProps } from "./apple-settings-presentation.js";
import type { OperationStatus, RestoreStatusCardProps } from "./extension-settings-presentation.js";
import type { CommittedPopupToggle } from "../index.js";

// Pure host rules for the Apple app's D04 settings screen. The app-webview entry and its host
// component only plumb these values; every decision that could present a saved choice, an account
// or an access state lives here and is unit-tested.
//
// Keep this module free of top-level side effects (no calls at module scope): it is re-exported
// from the shared UI index, and the configured Apple bundle must stay byte-identical to the legacy
// build, which relies on every unused export here being tree-shaken.

export type AppleSettingsMode = "atomic" | "legacy";

export interface AppleSettingsModeInput {
  readonly supabaseUrl: string | undefined;
  readonly supabaseAnonKey: string | undefined;
  /** The native message port exists at composition time (NativeBridge.available). */
  readonly nativePort: boolean;
}

/**
 * Committed (atomic) settings with the D04 screen only for an unconfigured Apple build running
 * inside the native host. "Configured" is the Apple entry's own rule: both Supabase values are
 * non-empty. Configured builds stay on the legacy screen whatever the modern-sync opt-in says,
 * until an Apple modern-sync rollout exists. Without a native port there is no committed
 * authority to read, so the legacy screen (unchanged) is kept rather than presenting defaults.
 */
export function selectAppleSettingsMode(input: AppleSettingsModeInput): AppleSettingsMode {
  const configured = Boolean(input.supabaseUrl && input.supabaseAnonKey);
  return !configured && input.nativePort === true ? "atomic" : "legacy";
}

/** The one cache's options. Atomic hydration initializes through native with unknown ownership. */
export function appleSettingsCacheOptions(mode: AppleSettingsMode): SettingsCacheOptions | undefined {
  return mode === "atomic" ? { atomicOwnership: "unknown" } : undefined;
}

/**
 * Committed authority over the existing cache plus read-only native benefit access. Nothing here
 * hydrates or writes settings; the entry keeps the cache's watch/hydrate lifetime.
 */
export function createAppleSettingsAuthority(cache: SettingsCache, native: NativeBenefitSource) {
  const entitlement = new EntitlementCache(new WKBenefitAccessAdapter(native));
  const unwatch = entitlement.watch();
  void entitlement.refreshAccess();
  const binding = createDesktopPopupBinding(cache, entitlement);
  return {
    binding,
    entitlement,
    stop(): void {
      binding.stop();
      unwatch();
    },
  };
}

/** Mac inventory only on a native Mac observation; an unknown host gets the narrower iOS list. */
export function appleSettingsPlatform(observation: SafariSetupObservation | null): "ios" | "mac" {
  return observation?.platform === "macos" ? "mac" : "ios";
}

/** Native setup reads are bounded; no reply in time means the state cannot be observed. */
export const APPLE_SETUP_OBSERVATION_DEADLINE_MS = 2_000;

export function observeAppleSetup(
  read: () => Promise<SafariSetupObservation | null>,
  deadlineMs: number = APPLE_SETUP_OBSERVATION_DEADLINE_MS,
): Promise<SafariSetupObservation | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), deadlineMs);
    const finish = (value: SafariSetupObservation | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    Promise.resolve()
      .then(read)
      .then(finish, () => finish(null));
  });
}

/**
 * The setup card appears only when native observes the Mac extension turned off. iOS cannot
 * observe it, and an unknown, missing or late observation never nags. No native message opens
 * Safari's settings, so the card's action stays unsupplied.
 */
export function appleSettingsSetup(observation: SafariSetupObservation | null): AppleSettingsProps["setup"] {
  if (observation?.platform !== "macos" || observation.extensionStatus !== "disabled") return undefined;
  return {
    title: "Turn on Still in Safari",
    detail: "Still works inside Safari. Your choices are saved and start working once it's on.",
    // Owner-approved macOS steps (2026-10-05); title, detail and label from the D04 reference.
    steps: [
      "Open Safari, then Settings, then Extensions.",
      "Turn on Still.",
      "Allow it on every website.",
    ],
    actionLabel: "Open Safari Settings",
  };
}

/**
 * Re-observe setup when the app returns to the foreground, so turning Still on in Safari removes
 * the card. Latest read wins; stopping removes the listener and ignores late replies.
 */
export function watchAppleSetup(
  read: () => Promise<SafariSetupObservation | null>,
  publish: (setup: AppleSettingsProps["setup"]) => void,
  doc: Document = document,
  deadlineMs: number = APPLE_SETUP_OBSERVATION_DEADLINE_MS,
): () => void {
  let ticket = 0;
  let stopped = false;
  const observe = () => {
    const current = ++ticket;
    void observeAppleSetup(read, deadlineMs).then((observation) => {
      if (!stopped && current === ticket) publish(appleSettingsSetup(observation));
    });
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") observe();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    stopped = true;
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

/** The controller fields D04 reads. UiController satisfies this structurally. */
export interface AppleSettingsAccountSource {
  readonly userId: string | null;
  readonly accountEmail: string | null;
  readonly accountRevision: number;
  readonly cloudReachable: boolean;
  readonly pendingUpload: boolean;
  readonly lastSyncedAt: number | null;
  readonly retrySync: (() => Promise<void>) | undefined;
  readonly canSignIn: boolean;
  readonly canDeleteAccount: boolean;
  readonly deleteFlow: DeleteFlow;
  openSignIn(): void;
  signOut(): Promise<void>;
  confirmDeleteAccount(): Promise<void>;
}

/**
 * Sync card from the existing controller. Operations are bound to the account identity and
 * revision they were rendered for and do nothing once either changes. An account without an
 * email keeps no address (the leaf requires a string; an empty one renders no address line).
 */
export function appleSettingsSync(source: AppleSettingsAccountSource): AppleSettingsProps["sync"] {
  const identity = source.userId;
  const revision = source.accountRevision;
  const current = () => source.userId === identity && source.accountRevision === revision;
  if (!identity) {
    return {
      onSignIn: source.canSignIn
        ? () => {
            if (current() && source.canSignIn) source.openSignIn();
          }
        : undefined,
    };
  }
  const retry = source.retrySync
    ? () => {
        if (current()) void source.retrySync?.().catch(() => {});
      }
    : undefined;
  const deletable = source.canDeleteAccount && source.deleteFlow !== "deleting";
  const base = {
    address: source.accountEmail ?? "",
    confirmed: false,
    status: accountStatus(source, retry),
    onSignOut: () => {
      if (current()) void source.signOut();
    },
  };
  if (!deletable) return { account: base };
  return {
    account: {
      ...base,
      identity,
      revision,
      onDeleteAccount: () => {
        if (current() && source.canDeleteAccount && source.deleteFlow !== "deleting")
          void source.confirmDeleteAccount();
      },
    },
  };
}

function accountStatus(source: AppleSettingsAccountSource, retry: (() => void) | undefined): OperationStatus {
  if (source.deleteFlow === "deleting") return { tone: "pending", text: STRINGS.account.deleting };
  if (source.deleteFlow === "error") return { tone: "failed", text: STRINGS.account.deleteError };
  if (!source.cloudReachable)
    return {
      tone: "failed",
      text: STRINGS.sync.unreachable,
      actionLabel: retry ? STRINGS.sync.retry : undefined,
      onAction: retry,
    };
  if (source.pendingUpload) return { tone: "pending", text: STRINGS.sync.syncing };
  if (source.lastSyncedAt !== null) return { tone: "success", text: STRINGS.sync.synced };
  return { tone: "pending", text: STRINGS.sync.checking };
}

/** Restore appears only while an actual Restore runs; there is no idle Restore entry. */
export function appleSettingsRestore(source: {
  readonly purchaseFlow: PurchaseFlow;
}): RestoreStatusCardProps | undefined {
  return source.purchaseFlow === "restoring" ? { state: "checking" } : undefined;
}

/**
 * Open an https page the way the legacy Apple screen does: a user-activated `target=_blank`
 * anchor, which the native navigation policy cancels in the web view and hands to the system.
 */
export function openExternalLink(url: string, doc: Document = document): void {
  if (!/^https:\/\//.test(url)) return;
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.hidden = true;
  doc.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

/** Privacy uses the shipped policy URL. Setup guide and support stay unsupplied (owner-open). */
export function appleSettingsHelp(open: (url: string) => void): AppleSettingsProps["help"] {
  return { onPrivacy: () => open(PRIVACY_POLICY_URL) };
}

/** The existing toggle events for committed toggles, as the legacy Apple screen reports them. */
export function appleSettingsToggleReporter(analytics: Pick<UiAnalytics, "track">) {
  return (toggle: CommittedPopupToggle): void => {
    try {
      if (toggle.service === undefined)
        analytics.track("global_toggled", { enabled: toggle.enabled, where: "app" });
      else
        analytics.track("service_toggled", {
          service: toggle.service,
          enabled: toggle.enabled,
          where: "app",
        });
    } catch {
      /* Telemetry never changes the saved outcome. */
    }
  };
}
