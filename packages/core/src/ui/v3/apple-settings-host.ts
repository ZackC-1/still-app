import type { SettingsCache, SettingsCacheOptions } from "../../storage/cache.js";
import type { StoredSettingsRecord } from "../../storage/adapter.js";
import { EntitlementCache } from "../../entitlement/cache.js";
import {
  WKBenefitAccessAdapter,
  type NativeBenefitSource,
} from "../../entitlement/wk-benefit-adapter.js";
import type { UiAnalytics, DeleteFlow, PurchaseFlow } from "../controller.svelte.js";
import type { ReceiptStatusValue, SafariSetupObservation } from "../../native/bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";
import { safeParse } from "../../storage/settings-validation.js";
import { STRINGS } from "../strings.js";
import { PRIVACY_POLICY_URL, SETUP_GUIDE_URL } from "../config.js";
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

/**
 * - `atomic-local`: committed settings with D04, no account (the unconfigured developer opt-in).
 * - `atomic-cloud`: committed settings with D04 and per-field modern sync (U3-W4, configured builds
 *   with the modern sync flag, the same flag Chrome and Firefox use).
 * - `legacy`: the shipped settings screen and whole-record sync, unchanged.
 */
export type AppleSettingsMode = "atomic-local" | "atomic-cloud" | "legacy";

export interface AppleSettingsModeInput {
  /** VITE_APPLE_ATOMIC_SETTINGS: the unconfigured developer opt-in. Only "true" selects it. */
  readonly atomicSettingsFlag: string | undefined;
  /** VITE_MODERN_SETTINGS_SYNC_ENABLED: the modern sync flag shared with Chromium. Only "true". */
  readonly modernSyncFlag: string | undefined;
  readonly supabaseUrl: string | undefined;
  readonly supabaseAnonKey: string | undefined;
  /** The native message port exists at composition time (NativeBridge.available). */
  readonly nativePort: boolean;
}

/**
 * Committed (atomic) settings with the D04 screen only inside the native host (without a port there
 * is no committed authority, so the unchanged legacy screen is kept rather than presenting
 * defaults), and only when a build explicitly opts in:
 *
 * - configured (Apple's own rule: both Supabase values non-empty) with the modern sync flag
 *   exactly "true" → `atomic-cloud`;
 * - not configured with VITE_APPLE_ATOMIC_SETTINGS exactly "true" → `atomic-local`.
 *
 * Neither flag selects anything for the other configuration, and missing configuration alone
 * never selects atomic: converting the App Group record is one-way.
 */
export function selectAppleSettingsMode(input: AppleSettingsModeInput): AppleSettingsMode {
  if (input.nativePort !== true) return "legacy";
  const configured = Boolean(input.supabaseUrl && input.supabaseAnonKey);
  if (configured) return input.modernSyncFlag === "true" ? "atomic-cloud" : "legacy";
  return input.atomicSettingsFlag === "true" ? "atomic-local" : "legacy";
}

/** The one cache's options. Atomic hydration initializes through native with unknown ownership. */
export function appleSettingsCacheOptions(mode: AppleSettingsMode): SettingsCacheOptions | undefined {
  return mode === "legacy" ? undefined : { atomicOwnership: "unknown" };
}

export interface AppleSettingsAuthorityDeps {
  /** Native benefit observation (NativeBridge). */
  readonly native: NativeBenefitSource;
  /** The cache's own storage adapter instance: the one native writer. */
  readonly initializer: {
    initializeAtomic(ownership: "unknown"): Promise<StoredSettingsRecord>;
  };
  /** The cache's first native read (SettingsCache.whenHydrated()). */
  readonly hydration: Promise<unknown>;
}

/**
 * Committed authority over the existing cache plus read-only native benefit access. The entry
 * keeps the cache's watch/hydrate lifetime; this adds no second cache or writer.
 *
 * `recover` is the screen's "Try again". When the first native initialization never produced an
 * atomic record, it asks the same adapter to initialize again and then lets the cache accept the
 * result through its own validated authority reread, which only admits a committed atomic record
 * (never migrated or startup defaults). Otherwise it is that reread alone. One retry at a time.
 */
export function createAppleSettingsAuthority(cache: SettingsCache, deps: AppleSettingsAuthorityDeps) {
  const entitlement = new EntitlementCache(new WKBenefitAccessAdapter(deps.native));
  const unwatch = entitlement.watch();
  void entitlement.refreshAccess();
  const binding = createDesktopPopupBinding(cache, entitlement);
  const settled = deps.hydration.then(
    () => {},
    () => {},
  );
  let stopped = false;
  let recovery: Promise<void> | null = null;
  async function retry(): Promise<void> {
    await settled;
    if (stopped) return;
    if (!cache.currentRecord().atomic) {
      try {
        await deps.initializer.initializeAtomic("unknown");
      } catch {
        /* The hold stays; the reread below records the current reason. */
      }
      if (stopped) return;
    }
    try {
      await binding.rereadAuthority();
    } catch {
      /* The cache retains its authoritative hold. */
    }
  }
  return {
    binding,
    entitlement,
    /** Resolves once the first native read settled, either way. */
    settled,
    recover(): Promise<void> {
      if (stopped) return Promise.resolve();
      recovery ??= retry().finally(() => {
        recovery = null;
      });
      return recovery;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      binding.stop();
      unwatch();
    },
  };
}

export type AppleSettingsAuthority = ReturnType<typeof createAppleSettingsAuthority>;

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
 * Opens one fixed native destination from a tap (the `openDestination` message, through
 * `openNativeDestination`). The setup card only ever asks for Safari's extension settings.
 */
export type AppleSetupOpener = (destination: "safariExtensionSettings") => void;

/**
 * The setup card appears only when native observes the Mac extension turned off. iOS cannot
 * observe it, and an unknown, missing or late observation never nags. Its "Open Safari Settings"
 * action opens the fixed Safari extension settings destination when an opener is supplied, and
 * stays unsupplied (disabled) otherwise.
 */
export function appleSettingsSetup(
  observation: SafariSetupObservation | null,
  open?: AppleSetupOpener,
): AppleSettingsProps["setup"] {
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
    onAction: open ? () => open("safariExtensionSettings") : undefined,
  };
}

export interface AppleSetupView {
  readonly setup: AppleSettingsProps["setup"];
  /** Null when this read observed nothing; the caller keeps the platform it already has. */
  readonly platform: "ios" | "mac" | null;
}

/**
 * Observe setup now and again whenever the app returns to the foreground, so turning Still on in
 * Safari removes the card and a later successful read corrects the platform. The listener is
 * attached before the first read. Latest read wins; stopping removes the listener and ignores
 * late replies.
 */
export function watchAppleSetup(
  read: () => Promise<SafariSetupObservation | null>,
  publish: (view: AppleSetupView) => void,
  doc: Document = document,
  deadlineMs: number = APPLE_SETUP_OBSERVATION_DEADLINE_MS,
  open?: AppleSetupOpener,
): () => void {
  let ticket = 0;
  let stopped = false;
  const observe = () => {
    const current = ++ticket;
    void observeAppleSetup(read, deadlineMs).then((observation) => {
      if (stopped || current !== ticket) return;
      publish({
        setup: appleSettingsSetup(observation, open),
        platform: observation ? appleSettingsPlatform(observation) : null,
      });
    });
  };
  const onVisibility = () => {
    if (doc.visibilityState === "visible") observe();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  observe();
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

interface AccountOperations {
  readonly onSignIn?: () => void;
  readonly retry?: () => void;
  readonly onSignOut: () => void;
  readonly onDeleteAccount: () => void;
}

function accountOperations(source: AppleSettingsAccountSource): AccountOperations {
  const identity = source.userId;
  const revision = source.accountRevision;
  // Re-read at use: a sign-out and sign-in (even to the same account) advances the revision.
  const current = () => source.userId === identity && source.accountRevision === revision;
  return {
    onSignIn:
      !identity && source.canSignIn
        ? () => {
            if (current() && source.canSignIn) source.openSignIn();
          }
        : undefined,
    retry: source.retrySync
      ? () => {
          if (current()) void source.retrySync?.().catch(() => {});
        }
      : undefined,
    onSignOut: () => {
      if (current()) void source.signOut();
    },
    onDeleteAccount: () => {
      if (current() && source.canDeleteAccount && source.deleteFlow !== "deleting")
        void source.confirmDeleteAccount();
    },
  };
}

/**
 * Sync card from the existing controller. Operations are created once per account identity and
 * revision (like the D03 host's optionsOperations), so routine sync-status changes keep the same
 * callbacks and an open delete confirmation stays valid; a changed identity or revision replaces
 * them, and the old ones do nothing. An account without an email keeps no address (the leaf
 * requires a string; an empty one renders no address line).
 */
export function createAppleSettingsSync() {
  const epochs = new WeakMap<AppleSettingsAccountSource, { key: string; ops: AccountOperations }>();
  return (source: AppleSettingsAccountSource): AppleSettingsProps["sync"] => {
    const identity = source.userId;
    const revision = source.accountRevision;
    const key = JSON.stringify([identity, revision, source.canSignIn, Boolean(source.retrySync)]);
    let epoch = epochs.get(source);
    if (epoch?.key !== key) {
      epoch = { key, ops: accountOperations(source) };
      epochs.set(source, epoch);
    }
    const ops = epoch.ops;
    if (!identity) return { onSignIn: ops.onSignIn };
    const base = {
      address: source.accountEmail ?? "",
      confirmed: false,
      status: accountStatus(source, ops.retry),
      onSignOut: ops.onSignOut,
    };
    if (!source.canDeleteAccount || source.deleteFlow === "deleting") return { account: base };
    return { account: { ...base, identity, revision, onDeleteAccount: ops.onDeleteAccount } };
  };
}

function accountStatus(source: AppleSettingsAccountSource, retry: (() => void) | undefined): OperationStatus {
  if (source.deleteFlow === "deleting") return { tone: "pending", text: STRINGS.account.deleting };
  if (source.deleteFlow === "error") return { tone: "failed", text: STRINGS.account.deleteError };
  if (!source.cloudReachable)
    return {
      tone: "failed",
      text: STRINGS.sync.failed,
      actionLabel: retry ? STRINGS.sync.tryAgain : undefined,
      onAction: retry,
    };
  if (source.pendingUpload) return { tone: "pending", text: STRINGS.sync.syncing };
  if (source.lastSyncedAt !== null) return { tone: "success", text: STRINGS.sync.synced };
  return { tone: "pending", text: STRINGS.sync.checking };
}

/** A controller-driven Restore shows its status only while it actually runs. */
export function appleSettingsRestore(source: {
  readonly purchaseFlow: PurchaseFlow;
}): RestoreStatusCardProps | undefined {
  return source.purchaseFlow === "restoring" ? { state: "checking" } : undefined;
}

/**
 * The native Restore check's answer (FreePeriodRestore.swift): `none` only after the App Store
 * answered with no Still purchase, `failed` when there was no conclusive answer.
 */
export type AppleRestoreCheck = "restored" | "none" | "failed";

/** The native calls the free-period Restore uses; tests supply a fake. */
export interface AppleRestoreBridge {
  /** The restore reply's conclusive answer, or null when the reply carries none. */
  restoreCheck(): Promise<AppleRestoreCheck | null>;
  receiptStatus(): Promise<ReceiptStatusValue>;
}

/**
 * Read a native restore reply. The conclusive `restore` field wins; a bare `entitled: true` (the
 * paid-tier reply) is restored; anything else, including a malformed reply, is no answer, so it can
 * never become "nothing found".
 */
export function appleRestoreCheck(reply: unknown): AppleRestoreCheck | null {
  const obj: unknown = typeof reply === "string" ? safeParse(reply) : reply;
  if (!obj || typeof obj !== "object") return null;
  const { restore, entitled } = obj as Record<string, unknown>;
  if (restore === "restored" || restore === "none" || restore === "failed") return restore;
  return entitled === true ? "restored" : null;
}

/**
 * The Restore bridge over the one native port: the restore message read through
 * `appleRestoreCheck`, and the device receipt read through the existing NativeBridge. It lives here
 * rather than on NativeBridge so the default Apple bundle, which never shows this screen, is
 * unchanged.
 */
export function appleRestoreBridge(
  native: Pick<AppleRestoreBridge, "receiptStatus">,
  win: StillBridgeWindow = globalThis as unknown as StillBridgeWindow,
): AppleRestoreBridge {
  return {
    async restoreCheck() {
      const port = win.webkit?.messageHandlers?.still;
      return port ? appleRestoreCheck(await port.postMessage({ kind: "restore" })) : null;
    },
    receiptStatus: () => native.receiptStatus(),
  };
}

export interface AppleSettingsRestoreDeps {
  readonly bridge: AppleRestoreBridge;
  /**
   * The existing entitlement path (the authority's EntitlementCache.refreshAccess). While the paid
   * tier is off it returns the packaged free snapshot without asking native, so a restore never
   * reveals paid UI there.
   */
  readonly refreshAccess: () => Promise<unknown>;
  /** Receives the RestoreStatusCard state to show; undefined before the first tap. */
  readonly publish: (restore: RestoreStatusCardProps) => void;
}

/**
 * The plain "Restore purchase" link shown while the paid flags are off (owner decision 17). It
 * asks native to restore and then re-reads access through the existing entitlement path. It never
 * touches settings: no cache, binding or settings message is involved.
 *
 * Outcomes use only the existing RestoreStatusCard states. While the paid tier is off, native runs
 * a read-only App Store check and answers conclusively: restored, none ("nothing found") or failed
 * ("couldn't finish" with Try again). A reply with no conclusive answer falls back to the device
 * receipt read, as AppleSession.onRestore does: entitled is restored, verified not entitled is
 * nothing found, and no signal or any rejection is couldn't finish. One restore at a time. After `stop` (the screen unmounted) a late reply is ignored:
 * no further native read, no access re-read and nothing published.
 */
export function createAppleSettingsRestore(deps: AppleSettingsRestoreDeps) {
  let flight: Promise<void> | null = null;
  let stopped = false;
  async function outcome(): Promise<"restored" | "nothing" | "failed" | null> {
    try {
      const check = await deps.bridge.restoreCheck();
      if (check === "restored") return "restored";
      if (check === "none") return "nothing";
      if (check === "failed") return "failed";
      if (stopped) return null;
      const receipt = await deps.bridge.receiptStatus();
      if (receipt === "entitled") return "restored";
      return receipt === "verifiedNotEntitled" ? "nothing" : "failed";
    } catch {
      return "failed";
    }
  }
  async function run(): Promise<void> {
    deps.publish({ state: "checking" });
    const state = await outcome();
    if (stopped || state === null) return;
    try {
      await deps.refreshAccess();
    } catch {
      /* The entitlement cache keeps its own held state. */
    }
    if (stopped) return;
    deps.publish(state === "failed" ? { state, onAction: start } : { state });
  }
  function start(): void {
    if (stopped || flight) return;
    flight = run().finally(() => {
      flight = null;
    });
  }
  return {
    start,
    stop(): void {
      stopped = true;
    },
  };
}

/**
 * The approved support destination: exactly `mailto:${SUPPORT_EMAIL}` (config.ts), with no query
 * or other recipient; a test pins the two together. It is a literal because any top-level
 * expression over SUPPORT_EMAIL survives tree-shaking (string coercion is not provably pure) and
 * would change the default Apple bundle, which must stay byte-identical.
 */
export const SUPPORT_MAILTO = "mailto:support@stillapp.fit";

/**
 * Open an https page, or the support email, the way the legacy Apple screen opens links: a
 * user-activated `target=_blank` anchor, which the native navigation policy cancels in the web view
 * and hands to the system. Assigning `location.href` would reach native as a non-link navigation
 * and be cancelled, so the anchor click is required. The only mailto accepted is SUPPORT_MAILTO.
 */
export function openExternalLink(url: string, doc: Document = document): void {
  if (!/^https:\/\//.test(url) && url !== SUPPORT_MAILTO) return;
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

/**
 * Help destinations (owner decision 11): the live setup guide, the shipped support email and the
 * shipped privacy policy, all opened externally. The native navigation policy hands a user-tapped
 * link to exactly `mailto:support@stillapp.fit` to the system mail app.
 */
export function appleSettingsHelp(open: (url: string) => void): AppleSettingsProps["help"] {
  return {
    onGuide: () => open(SETUP_GUIDE_URL),
    onSupport: () => open(SUPPORT_MAILTO),
    onPrivacy: () => open(PRIVACY_POLICY_URL),
  };
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
