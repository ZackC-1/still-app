import type { ServiceId, StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import type { SettingsCache } from "../storage/cache.js";
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
  paywallOpen = $state(false);
  deleteFlow = $state<DeleteFlow>("idle");
  deleteError = $state<string | null>(null);

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

  openPaywall(): void {
    this.paywallOpen = true;
  }

  dismissPaywall(): void {
    this.paywallOpen = false;
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

  async signOut(): Promise<void> {
    await this.auth?.signOut();
    this.userId = null;
    this.entitled = false;
    this.authFlow = "idle";
    this.paywallOpen = false;
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
      this.userId = null;
      this.entitled = false;
      this.authFlow = "idle";
      this.paywallOpen = false;
      this.deleteFlow = "idle";
    } catch (e) {
      this.deleteFlow = "error";
      this.deleteError = e instanceof Error ? e.message : String(e);
    }
  }
}
