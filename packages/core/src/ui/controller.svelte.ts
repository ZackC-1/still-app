import type { ServiceId, StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import type { SettingsCache } from "../storage/cache.js";
import type { PurchaseResult } from "../native/bridge.js";
import { etldPlusOne } from "../rules/match.js";

// The host-agnostic view-model for the shared UI (KTD4). It reads/writes settings through the
// injected SettingsCache and exposes the sync/auth/paywall state matrix (U9). The same controller
// drives the Chromium popup + options page and the Apple WKWebView; only the injected deps differ.

export type PopupState =
  | "signed-out"
  | "not-entitled"
  | "entitlement-pending" // reconcile in flight (time-boxed)
  | "entitled-syncing"
  | "cloud-unreachable"; // signed in but offline → cached settings + a muted note

export type AuthFlow = "idle" | "sending" | "sent" | "error";

/** Account-deletion flow (App Store 5.1.1): idle → confirming (destructive confirm shown) → deleting
 * → idle (signed out) | error. */
export type DeleteFlow = "idle" | "confirming" | "deleting" | "error";

/** Purchase/restore flow surfaced in the paywall (P1 #5). The sheet stays open through every state
 * except a confirmed purchase (which the host dismisses + re-enters session). */
export type PurchaseFlow =
  | "idle"
  | "purchasing"
  | "pending" // store accepted, entitlement not yet active (e.g. Ask-to-Buy)
  | "cancelled"
  | "failed"
  | "unavailable" // no offering / product not available right now
  | "restoring"
  | "restored-none"; // restore completed but nothing to restore

export interface UiHost {
  /** false on hosts with no purchase path (non-Apple desktop): explanatory paywall, no CTA (R19). */
  readonly canPurchase: boolean;
  /** The active tab's host for the per-site pause control. Absent on the options page. */
  readonly currentHost?: string;
}

export interface UiAuth {
  signIn(email: string): Promise<{ error?: string }>;
  signOut(): Promise<void>;
  /** Delete the account (App Store 5.1.1 / GDPR). Optional: only wired on hosts with an account.
   * Throws on failure so the UI can surface it and keep the session. */
  deleteAccount?(): Promise<void>;
}

export interface UiControllerDeps {
  readonly cache: SettingsCache;
  readonly host: UiHost;
  readonly auth?: UiAuth;
}

export class UiController {
  settings = $state<StillSettings>(DEFAULT_SETTINGS);

  // Sync + connectivity — the entrypoint updates these from SyncService events.
  userId = $state<string | null>(null);
  entitled = $state(false);
  reconciling = $state(false);
  cloudReachable = $state(true);

  // UI-local state.
  authFlow = $state<AuthFlow>("idle");
  authError = $state<string | null>(null);
  /** The sign-in sheet overlays the rest of the UI when the signed-out CTA is tapped. */
  signInOpen = $state(false);
  paywallOpen = $state(false);
  /** Localized store price for the buy CTA (e.g. "$1.99"), set by the host from StoreKit/RevenueCat.
   * Null until loaded / on hosts without a price — the CTA then shows no price rather than a guess. */
  paywallPrice = $state<string | null>(null);
  deleteFlow = $state<DeleteFlow>("idle");
  deleteError = $state<string | null>(null);
  purchaseFlow = $state<PurchaseFlow>("idle");
  purchaseError = $state<string | null>(null);

  readonly host: UiHost;
  private readonly cache: SettingsCache;
  private readonly auth?: UiAuth;

  constructor(deps: UiControllerDeps) {
    this.cache = deps.cache;
    this.host = deps.host;
    this.auth = deps.auth;
    this.settings = deps.cache.current();
    deps.cache.subscribe((s) => {
      this.settings = s;
    });
  }

  get popupState(): PopupState {
    if (this.userId && !this.cloudReachable) return "cloud-unreachable";
    if (!this.userId) return "signed-out";
    if (this.reconciling) return "entitlement-pending";
    if (!this.entitled) return "not-entitled";
    return "entitled-syncing";
  }

  get currentPaused(): boolean {
    return this.host.currentHost
      ? this.settings.pauses.includes(etldPlusOne(this.host.currentHost))
      : false;
  }

  /** Whether the host wired account deletion (so the UI shows the Delete account affordance, R/5.1.1). */
  get canDeleteAccount(): boolean {
    return typeof this.auth?.deleteAccount === "function";
  }

  /** Whether this host wired an auth path at all. The browser extensions don't (U10 is deferred),
   * so the UI must not render a sign-in CTA there — a send button with no auth behind it would
   * silently do nothing. */
  get canSignIn(): boolean {
    return this.auth !== undefined;
  }

  toggleGlobal(): void {
    void this.cache.setGlobalOn(!this.settings.globalOn);
  }

  toggleService(id: ServiceId): void {
    void this.cache.setService(id, !this.settings.services[id]);
  }

  togglePause(): void {
    const host = this.host.currentHost;
    if (!host) return;
    if (this.currentPaused) void this.cache.resumeHost(host);
    else void this.cache.pauseHost(host);
  }

  openSignIn(): void {
    this.signInOpen = true;
  }

  dismissSignIn(): void {
    this.signInOpen = false;
    // Reset terminal auth states so reopening the sheet starts fresh at the email field — otherwise a
    // lingering "sent" lands on a Resend that fires with an empty email (the sheet's local input is
    // unmounted on close), and a lingering "error" shows a stale message.
    if (this.authFlow === "error" || this.authFlow === "sent") this.authFlow = "idle";
    this.authError = null;
  }

  openPaywall(): void {
    this.paywallOpen = true;
    this.purchaseFlow = "idle";
    this.purchaseError = null;
  }

  dismissPaywall(): void {
    this.paywallOpen = false;
    this.purchaseFlow = "idle";
    this.purchaseError = null;
  }

  // ── Purchase / restore flow (P1 #5) ─────────────────────────────────────────────────────────────

  /** Whether a purchase or restore is in flight — used to disable duplicate taps. */
  get purchaseBusy(): boolean {
    return this.purchaseFlow === "purchasing" || this.purchaseFlow === "restoring";
  }

  /** Mark a purchase as started (disables the CTA). The host then drives the native purchase and
   * reports back via setPurchaseOutcome. No-op while already busy (duplicate-tap guard). */
  beginPurchase(): boolean {
    if (this.purchaseBusy) return false;
    this.purchaseFlow = "purchasing";
    this.purchaseError = null;
    return true;
  }

  /** Map the native purchase result to a visible flow state. `purchased` resets to idle (the host
   * dismisses the sheet + re-enters session); everything else keeps the sheet open with a message. */
  setPurchaseOutcome(result: PurchaseResult): void {
    switch (result.outcome) {
      case "purchased":
        this.purchaseFlow = "idle";
        this.purchaseError = null;
        break;
      case "pending":
        this.purchaseFlow = "pending";
        break;
      case "cancelled":
        this.purchaseFlow = "cancelled";
        break;
      case "unavailable":
        this.purchaseFlow = "unavailable";
        break;
      case "failed":
        this.purchaseFlow = "failed";
        this.purchaseError = result.error ?? null;
        break;
    }
  }

  /** Mark a restore as started (disables the CTA). No-op while already busy. */
  beginRestore(): boolean {
    if (this.purchaseBusy) return false;
    this.purchaseFlow = "restoring";
    this.purchaseError = null;
    return true;
  }

  /** Report the restore result. Restored → idle (host dismisses + re-enters); nothing → a note. */
  setRestoreOutcome(restored: boolean): void {
    this.purchaseFlow = restored ? "idle" : "restored-none";
  }

  async signIn(email: string): Promise<void> {
    if (!this.auth || this.authFlow === "sending") return;
    this.authFlow = "sending";
    this.authError = null;
    const { error } = await this.auth.signIn(email);
    if (error) {
      this.authFlow = "error";
      this.authError = error;
    } else {
      this.authFlow = "sent";
    }
  }

  /** Clear all signed-in UI state back to the signed-out baseline. Shared by signOut + delete so a
   * new field added here can't be forgotten in one path. */
  private resetToSignedOut(): void {
    this.userId = null;
    this.entitled = false;
    this.authFlow = "idle";
    this.paywallOpen = false;
    this.purchaseFlow = "idle";
    this.purchaseError = null;
  }

  async signOut(): Promise<void> {
    // Best-effort backend sign-out, but always clear local state and never throw — a failed
    // auth.signOut() must not leave the UI stuck in a signed-in state.
    try {
      await this.auth?.signOut();
    } catch {
      /* swallow: the user asked to sign out; clear local state regardless */
    }
    this.resetToSignedOut();
  }

  // ── Account deletion (App Store 5.1.1) ──────────────────────────────────────────────────────────

  /** Open the destructive-delete confirmation. */
  requestDeleteAccount(): void {
    this.deleteFlow = "confirming";
    this.deleteError = null;
  }

  /** Back out of the confirmation without deleting. */
  cancelDeleteAccount(): void {
    this.deleteFlow = "idle";
    this.deleteError = null;
  }

  /** Confirm: delete the account, then return to the signed-out state. On failure, surface the error
   * and keep the session (the account still exists). */
  async confirmDeleteAccount(): Promise<void> {
    if (!this.auth?.deleteAccount || this.deleteFlow === "deleting") return;
    this.deleteFlow = "deleting";
    this.deleteError = null;
    try {
      await this.auth.deleteAccount();
      // Account gone → mirror the signed-out reset.
      this.resetToSignedOut();
      this.deleteFlow = "idle";
    } catch (e) {
      this.deleteFlow = "error";
      this.deleteError = e instanceof Error ? e.message : String(e);
    }
  }
}
