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

export interface UiHost {
  /** false on hosts with no purchase path (non-Apple desktop): explanatory paywall, no CTA (R19). */
  readonly canPurchase: boolean;
  /** The active tab's host for the per-site pause control. Absent on the options page. */
  readonly currentHost?: string;
}

export interface UiAuth {
  signIn(email: string): Promise<{ error?: string }>;
  signOut(): Promise<void>;
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
}
