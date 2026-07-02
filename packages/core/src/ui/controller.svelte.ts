import type { ServiceId, StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS } from "@still/shared-types";
import { PRO_SERVICE_IDS } from "../rules/tiers.js";
import type { SettingsCache } from "../storage/cache.js";
import type { PurchaseResult } from "../native/bridge.js";
import type { RequestCodeOutcome, VerifyCodeOutcome } from "../sync/ports.js";
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

/** Auth flow states. `idle → sending → sent | error` is the magic-link path (Apple). The code
 * flow (plan U2/R1, extension hosts) adds `sending → code-entry → verifying → signed-in |
 * code-error`, with `error` doubling as the calm send-failure state for both paths. */
export type AuthFlow = "idle" | "sending" | "sent" | "error" | "code-entry" | "verifying" | "code-error";

/** Why the last code-flow step failed — the sheet maps each kind to its own calm line.
 * `wrong`/`expired` come from verify (expired = the request is older than the OTP TTL);
 * `check-failed`/`resend-failed` are network/backend failures, not attempts. */
export type CodeErrorKind = "wrong" | "expired" | "check-failed" | "resend-failed";

/** Resend is blocked for 60s after each send, with a visible countdown (Supabase's own resend
 * window — resending earlier would fail server-side anyway). */
export const RESEND_COOLDOWN_MS = 60_000;
/** Supabase OTP lifetime (project default 1h): past this, a failed verify reads as expired. */
export const OTP_TTL_MS = 60 * 60_000;
/** Invalid-code attempts before the sheet foregrounds request-a-new-code (R1: the server
 * invalidates the token after repeated failures — retyping stops being the remedy). */
export const CODE_ATTEMPTS_BEFORE_NEW_CODE = 3;

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
  /** Send a magic link (Apple hosts). Optional: code-flow hosts wire requestCode/verifyCode
   * instead — hosts advertise capabilities, and the sheet renders whichever path is present. */
  signIn?(email: string): Promise<{ error?: string }>;
  signOut(): Promise<void>;
  /** Delete the account (App Store 5.1.1 / GDPR). Optional: only wired on hosts with an account.
   * Throws on failure so the UI can surface it and keep the session. */
  deleteAccount?(): Promise<void>;
  /** Email a 6-digit sign-in code (plan U2/R1, extension hosts). Wire BOTH code methods or
   * neither — the code-entry UI only renders when the pair is present. */
  requestCode?(email: string): Promise<RequestCodeOutcome>;
  /** Exchange the entered code for a session. The host closure is where session side effects
   * (SyncService.onSignedIn etc.) run; the controller only consumes the structured outcome. */
  verifyCode?(email: string, token: string): Promise<VerifyCodeOutcome>;
}

/** The pending-OTP record the host persists so the code flow survives popup death (AE2): the
 * popup dies when the user switches to their mail app — rehydration is the design, not an edge
 * case. `requestedAt` restores the resend countdown on reopen. */
export interface PendingOtp {
  readonly email: string;
  readonly requestedAt: number;
}

/** Host-persistence seam for the code flow's cross-popup-death state (plan U2/R1). The controller
 * calls these on every transition that must survive the popup closing; the host mirrors them into
 * extension storage and feeds them back through `rehydrateCodeEntry` on mount. Deliberate exits
 * ("Not now", sign-out) clear both; popup death clears nothing. */
export interface AuthPersistence {
  /** Persist the pending-OTP record; null clears it (verify success, deliberate dismiss). */
  setPendingOtp(pending: PendingOtp | null): void;
  /** Persist the purchase-intent continuation flag (locked-row tap → sign-in → auto-open paywall). */
  setPurchaseIntent(active: boolean): void;
}

export interface UiControllerDeps {
  readonly cache: SettingsCache;
  readonly host: UiHost;
  readonly auth?: UiAuth;
  /** Host persistence for pendingOtp + purchase intent. Only code-flow hosts wire it. */
  readonly persistence?: AuthPersistence;
  /** Injected clock (ms epoch) for the resend cooldown / OTP expiry — Date.now in real wiring,
   * controlled in tests (same seam as SettingsCache / the entitlement adapters). */
  readonly clock?: () => number;
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

  // Code-flow state (plan U2/R1). The email a code was sent to (the sheet's input unmounts, so
  // verify/resend need it here), the visible resend countdown in whole seconds (0 = available),
  // why the last step failed, and how many codes were rejected (drives request-a-new-code).
  codeEmail = $state<string | null>(null);
  resendCooldown = $state(0);
  codeErrorKind = $state<CodeErrorKind | null>(null);
  codeAttempts = $state(0);
  /** Purchase-intent continuation: set by a signed-out locked-row tap so a successful sign-in
   * auto-OPENS the paywall (one confirming tap before money moves — never auto-checkout, AE1). */
  purchaseIntent = $state(false);
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
  private readonly persistence?: AuthPersistence;
  private readonly now: () => number;
  /** When the current code was requested — drives the resend countdown and expiry detection. */
  private codeRequestedAt: number | null = null;
  /** Ticks the visible countdown once a second while a cooldown runs; self-clears at 0 (the popup
   * dies with the sheet anyway, so no destroy hook is needed). */
  private cooldownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: UiControllerDeps) {
    this.cache = deps.cache;
    this.host = deps.host;
    this.auth = deps.auth;
    this.persistence = deps.persistence;
    this.now = deps.clock ?? (() => Date.now());
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

  /** Whether this host wired an auth path at all. The Safari extension doesn't, so the UI must
   * not render a sign-in CTA there — a send button with no auth behind it would silently do
   * nothing. Requires an actual sign-in capability (magic link or code), not just the interface. */
  get canSignIn(): boolean {
    return typeof this.auth?.signIn === "function" || this.canUseCode;
  }

  /** Whether this host signs in by emailed 6-digit code (plan U2/R1) — capability-driven, never
   * user-agent sniffing. Both methods must be wired for the code-entry UI to render. */
  get canUseCode(): boolean {
    return (
      typeof this.auth?.requestCode === "function" && typeof this.auth?.verifyCode === "function"
    );
  }

  /** After repeated rejected codes the remedy is a fresh code, not retyping (R1: the server
   * invalidates the token) — the sheet foregrounds the request-a-new-code affordance. */
  get suggestNewCode(): boolean {
    return this.codeAttempts >= CODE_ATTEMPTS_BEFORE_NEW_CODE;
  }

  toggleGlobal(): void {
    void this.cache.setGlobalOn(!this.settings.globalOn);
  }

  toggleService(id: ServiceId): void {
    void this.cache.setService(id, !this.settings.services[id]);
  }

  /** True when a service's surfaces are Pro-gated and this user isn't entitled — the row renders
   * locked (🔒 → paywall) instead of a toggle that would flip without blocking anything. */
  isLocked(id: ServiceId): boolean {
    return !this.entitled && PRO_SERVICE_IDS.has(id);
  }

  /** Tap on a locked row: the Pro discovery surface. Signed-out on a purchasable host → sign in
   * first (sign-in-before-purchase, monetization principle 8), recording purchase intent so a
   * successful sign-in continues to the paywall without re-tapping the row (AE1); otherwise open
   * the paywall — which renders its explanatory state on hosts without a purchase path. */
  lockedTap(): void {
    if (this.host.canPurchase && this.canSignIn && !this.userId) {
      this.setPurchaseIntent(true);
      this.openSignIn();
      return;
    }
    this.openPaywall();
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
    // A deliberate "Not now" abandons the code flow entirely (unlike popup death, which persists
    // it): clear the pending OTP so the next open starts fresh at the email field (R1).
    if (this.inCodeFlow) {
      this.clearCodeFlow();
      this.persistence?.setPendingOtp(null);
      this.authFlow = "idle";
    }
    // Any deliberate dismissal also abandons the purchase continuation — a stale intent flag must
    // never auto-open the paywall after a later, unrelated sign-in.
    this.setPurchaseIntent(false);
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

  /** The sheet's one send action. Code-capable hosts get the code flow (→ code-entry); everyone
   * else keeps the magic link (→ sent). Same button, capability-driven path (plan U2). */
  async signIn(email: string): Promise<void> {
    if (!this.auth || this.authFlow === "sending" || this.authFlow === "verifying") return;
    if (this.canUseCode) {
      await this.sendCode(email);
      return;
    }
    if (!this.auth.signIn) return;
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

  // ── Email-OTP code flow (plan U2/R1) ────────────────────────────────────────────────────────────

  /** Request a code and land on code entry. On failure the shared "error" state renders the
   * code-flow copy (the sheet branches on canUseCode) — authError stays null so no raw backend
   * text can ever reach the code path. */
  private async sendCode(email: string): Promise<void> {
    this.authFlow = "sending";
    this.authError = null;
    const outcome = await this.auth!.requestCode!(email);
    if (outcome.kind === "sent") {
      this.enterCodeEntry(email, this.now());
      this.persistence?.setPendingOtp({ email, requestedAt: this.codeRequestedAt! });
    } else {
      this.authFlow = "error";
    }
  }

  /** Verify the entered 6-digit code. Success signs in (and continues to the paywall when a
   * locked-row tap started this flow — auto-OPEN only, never auto-checkout); a rejected code keeps
   * the sheet on code-error for a retype, counting attempts toward request-a-new-code. */
  async verifyCode(code: string): Promise<void> {
    if (!this.auth?.verifyCode || this.codeEmail === null) return;
    if (this.authFlow === "verifying") return;
    this.authFlow = "verifying";
    this.codeErrorKind = null;
    const expired = this.codeIsExpired(); // judged against the request time, pre-await
    const outcome = await this.auth.verifyCode(this.codeEmail, code);
    if (outcome.kind === "verified") {
      this.userId = outcome.userId;
      this.clearCodeFlow();
      this.authFlow = "idle";
      this.signInOpen = false;
      this.persistence?.setPendingOtp(null);
      const continueToPaywall = this.purchaseIntent;
      this.setPurchaseIntent(false);
      if (continueToPaywall) this.openPaywall();
    } else if (outcome.kind === "invalid-code") {
      this.codeAttempts += 1;
      this.codeErrorKind = expired ? "expired" : "wrong";
      this.authFlow = "code-error";
    } else {
      // Network/backend failure: the code may still be good — not an attempt, calm retry copy.
      this.codeErrorKind = "check-failed";
      this.authFlow = "code-error";
    }
  }

  /** Resend a code to the same email. Gated on the 60s cooldown (clock-checked, not just the
   * displayed countdown); success restarts the countdown and resets the attempt count. */
  async resendCode(): Promise<void> {
    if (!this.auth?.requestCode || this.codeEmail === null) return;
    if (this.authFlow === "verifying" || this.resendRemainingMs() > 0) return;
    const email = this.codeEmail;
    const outcome = await this.auth.requestCode(email);
    if (outcome.kind === "sent") {
      this.enterCodeEntry(email, this.now());
      this.persistence?.setPendingOtp({ email, requestedAt: this.codeRequestedAt! });
    } else {
      // Stay on code entry — the previous code may still work; surface a calm resend line.
      this.codeErrorKind = "resend-failed";
    }
  }

  /** The "use a different email" escape (R1): back to the email field. Clears the pending OTP but
   * keeps any purchase intent — the user is still mid-unlock, just fixing a typo'd address. */
  useDifferentEmail(): void {
    this.clearCodeFlow();
    this.authFlow = "idle";
    this.authError = null;
    this.persistence?.setPendingOtp(null);
  }

  /** Host rehydration input (AE2): called on mount with the persisted pendingOtp so reopening the
   * popup within the OTP TTL lands straight on code entry for that email — countdown restored from
   * the original request time, purchase intent restored from the persisted flag. */
  rehydrateCodeEntry(pending: { email: string; requestedAt?: number; purchaseIntent?: boolean }): void {
    if (!this.canUseCode || this.userId) return;
    const at = pending.requestedAt;
    this.enterCodeEntry(pending.email, typeof at === "number" && Number.isFinite(at) ? at : null);
    this.purchaseIntent = pending.purchaseIntent === true; // already persisted — no seam echo
    this.signInOpen = true;
  }

  /** Shared entry into the code-entry state: remember the email + request time, reset the error/
   * attempt slate, start the visible resend countdown. */
  private enterCodeEntry(email: string, requestedAt: number | null): void {
    this.codeEmail = email;
    this.codeRequestedAt = requestedAt;
    this.codeAttempts = 0;
    this.codeErrorKind = null;
    this.authFlow = "code-entry";
    this.startResendCooldown();
  }

  private get inCodeFlow(): boolean {
    return this.codeEmail !== null;
  }

  private codeIsExpired(): boolean {
    return this.codeRequestedAt !== null && this.now() - this.codeRequestedAt > OTP_TTL_MS;
  }

  private setPurchaseIntent(active: boolean): void {
    if (this.purchaseIntent === active) return;
    this.purchaseIntent = active;
    this.persistence?.setPurchaseIntent(active);
  }

  private clearCodeFlow(): void {
    this.codeEmail = null;
    this.codeRequestedAt = null;
    this.codeAttempts = 0;
    this.codeErrorKind = null;
    this.stopCooldownTimer();
    this.resendCooldown = 0;
  }

  /** Milliseconds until resend unblocks. Clamped to [0, RESEND_COOLDOWN_MS] so a garbage/future
   * requestedAt (clock skew, tampered storage) can never produce a stuck or NaN countdown —
   * mirrors the chrome-adapter garbage-timestamp rule. */
  private resendRemainingMs(): number {
    if (this.codeRequestedAt === null) return 0;
    const remaining = RESEND_COOLDOWN_MS - (this.now() - this.codeRequestedAt);
    return Number.isFinite(remaining)
      ? Math.min(RESEND_COOLDOWN_MS, Math.max(0, remaining))
      : 0;
  }

  private startResendCooldown(): void {
    this.stopCooldownTimer();
    this.updateResendCooldown();
    if (this.resendCooldown > 0) {
      this.cooldownTimer = setInterval(() => this.updateResendCooldown(), 1000);
    }
  }

  private updateResendCooldown(): void {
    const remaining = this.resendRemainingMs();
    this.resendCooldown = Math.ceil(remaining / 1000);
    if (remaining <= 0) this.stopCooldownTimer();
  }

  private stopCooldownTimer(): void {
    if (this.cooldownTimer !== null) {
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
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
    // Code-flow leftovers must not survive a teardown: no pending code entry, no purchase intent
    // that could auto-open the paywall for the NEXT identity on this browser (R8 spirit).
    this.clearCodeFlow();
    this.setPurchaseIntent(false);
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
