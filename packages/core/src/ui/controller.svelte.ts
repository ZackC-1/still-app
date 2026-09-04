import type { ServiceId, StillSettings } from "@still/shared-types";
import { DEFAULT_SETTINGS, PAID_TIER_ENABLED } from "@still/shared-types";
import { PRO_SERVICE_IDS } from "../rules/tiers.js";
import { isValidEmail } from "./email.js";
import type { SettingsCache } from "../storage/cache.js";
import type { PurchaseResult } from "../native/bridge.js";
import type {
  RequestCodeOutcome,
  VerifyCodeOutcome,
  WebCheckoutOutcome,
} from "../sync/ports.js";

// The host-agnostic view-model for the shared UI (KTD4). It reads/writes settings through the
// injected SettingsCache and exposes the sync/auth/paywall state matrix (U9). The same controller
// drives the Chromium popup + options page and the Apple WKWebView; only the injected deps differ.

export type PopupState =
  | "signed-out"
  | "pro-no-account" // receipt-entitled with no session (purchase-first, R3): Pro active, sign-in optional
  | "pro-device-only" // signed in, receipt-entitled, but the ACCOUNT isn't (attach ineligible or not landed)
  | "not-entitled"
  | "entitlement-pending" // reconcile in flight (time-boxed)
  | "entitled-syncing"
  | "cloud-unreachable"; // signed in but offline → cached settings + a muted note

/** Auth flow states. The code flow (plan U2/R1) — `sending → code-entry → verifying → signed-in |
 * code-error` — is the ONLY live path (extensions and the Apple app both wire it, 2026-07-06).
 * `idle → sending → sent | error` is the magic-link path, currently wired by no host; `error`
 * doubles as the calm send-failure state for both paths. */
export type AuthFlow =
  | "idle"
  | "sending"
  | "sent"
  | "error"
  | "code-entry"
  | "verifying"
  | "code-error";

/** Why the last code-flow step failed — the sheet maps each kind to its own calm line.
 * `wrong`/`expired` come from verify (expired = the request is older than the OTP TTL);
 * `check-failed`/`resend-failed` are network/backend failures, not attempts. The rate-limited
 * kinds (R2/R3) are ALSO not attempts: they render wait copy with the matching affordance locked,
 * and self-clear when the lock elapses. */
export type CodeErrorKind =
  | "wrong"
  | "expired"
  | "check-failed"
  | "resend-failed"
  | "verify-rate-limited"
  | "resend-rate-limited";

/** Resend is blocked for 60s after each send, with a visible countdown (Supabase's own resend
 * window — resending earlier would fail server-side anyway). */
export const RESEND_COOLDOWN_MS = 60_000;
/** UI lock after a rate-limited send or verify (R2/R3): GoTrue's per-user cooldown is 60s, and
 * its 429 carries no structured retry-after (the seconds live in message TEXT, never parsed), so
 * a fixed lock is the honest default. Transports that DO know the real wait (review-signin's
 * rate-limit RPC) override it via `retryAfterSeconds`. Deliberately not persisted across popup
 * death — the server still enforces; the calm copy simply reappears on a too-early retry. */
export const RATE_LIMIT_LOCK_MS = 60_000;
/** Supabase OTP lifetime (project default 1h): past this, a failed verify reads as expired. */
export const OTP_TTL_MS = 60 * 60_000;
/** Invalid-code attempts before the sheet foregrounds request-a-new-code (R1: the server
 * invalidates the token after repeated failures — retyping stops being the remedy). */
export const CODE_ATTEMPTS_BEFORE_NEW_CODE = 3;

/** Account-deletion flow (App Store 5.1.1): idle → confirming (destructive confirm shown) → deleting
 * → idle (signed out) | error. */
export type DeleteFlow = "idle" | "confirming" | "deleting" | "error";

/** How long the quieter-web success payoff stays before auto-dismissing the paywall
 * (U3/R6): long enough to read one line, short enough that the unlock itself — the rows switching
 * on behind the sheet — is the star. */
export const PAYOFF_DURATION_MS = 2_500;

/** Purchase/restore flow surfaced in the paywall (P1 #5). The sheet stays open through every state
 * except a confirmed purchase (which resolves through the justUnlocked payoff, U3/R6). */
export type PurchaseFlow =
  | "idle"
  | "purchasing" // Apple's in-place native purchase
  | "opening-checkout" // web hand-off to a checkout tab (U3 presentation; U4 wires the mechanics)
  | "pending" // store accepted, entitlement not yet active (e.g. Ask-to-Buy)
  | "cancelled"
  | "failed"
  | "unavailable" // no offering / product not available right now
  | "stale-identity" // signed out but the purchase identity isn't verifiably anonymous (R15) — retry CTA
  | "restoring"
  | "restored-none"; // restore completed but nothing to restore

/** The post-purchase success screen (R3, purchase-first): a dedicated presentation — NOT the 2.5s
 * auto-dismissing payoff, which is a single line sized for quiet web unlocks. `account-pitch`
 * (signed-out) offers the optional account with equal-weight Create/Not-now; `synced` (signed-in)
 * confirms without an account CTA. Dismissal is always an explicit user choice. */
export type SuccessScreen = "none" | "account-pitch" | "synced";

// ── Web checkout-pending lifecycle (plan U4/R3/R5) ────────────────────────────────────────────────

/** The checkout-pending presentation, orthogonal to PurchaseFlow: PurchaseFlow tracks one tap's
 * in-flight purchase, this tracks the PERSISTED "a checkout tab was opened" flag across popup
 * deaths. `none` = no pending presentation. */
export type CheckoutFlow =
  | "none"
  | "checking" // rehydrated pending: the fast-poll window is running ("Checking your purchase…")
  | "quiet-pending" // poll window exhausted / tab just opened: reopen the popup for a fresh window
  | "stale-pending" // pending >24h (or garbage record): the find-my-purchase support state
  | "auth-required"; // session died mid-checkout: re-sign-in affordance, pending preserved

/** What a host reconcile reported — only `auth-required` changes the controller's course; the
 * entitled flip itself always arrives through the entitlement-store subscription (write-then-
 * notify ordering, R6), never through this return value. */
export type CheckoutReconcileOutcome =
  | "entitled"
  | "not-entitled"
  | "auth-required"
  | "unknown";

/** Reconcile fast-poll: 3s × 10 per popup-open window, then stop. Every poll is a live RevenueCat
 * query server-side — the cap is deliberate (plan Risks); reopening the popup starts a fresh
 * window, and the background nudge (AE3) covers users who never reopen it. */
export const CHECKOUT_POLL_INTERVAL_MS = 3_000;
export const CHECKOUT_POLL_MAX = 10;
/** A pending flag older than this decays into the find-my-purchase support state (U4): checkout
 * abandonment is the most common outcome, and "checking" forever would be a lie. */
export const CHECKOUT_PENDING_TTL_MS = 24 * 60 * 60_000;

export interface UiHost {
  /** false on hosts with no purchase path (non-Apple desktop): explanatory paywall, no CTA (R19). */
  readonly canPurchase: boolean;
}

export interface UiAuth {
  /** Send a magic link. Currently wired by NO host (extensions and the Apple app all use the
   * code pair below — a WKWebView/popup can never receive the link's browser redirect); retained
   * for a possible future full-browser host. Hosts advertise capabilities, and the sheet renders
   * whichever path is present — canUseCode takes precedence. */
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

/** The persisted checkout-pending record (plan U4/R3). Written BEFORE the checkout tab opens —
 * the popup dies the moment the tab takes focus, so anything not persisted first is lost.
 * `tabId` is a best-effort enrichment from the opener (U5's teardown closes the recorded tab). */
export interface CheckoutPending {
  readonly startedAt: number;
  readonly tabId?: number;
}

/** Host checkout seam (plan U4/R3/R5), injected like AuthPersistence above: the controller owns
 * the checkout state machine, the host owns the mechanics. U6 backs these with background
 * messages + chrome.tabs/chrome.storage; tests use in-memory fakes. Only web-purchasable hosts
 * (ext-chromium) wire it — the default shared wiring (Safari) stays checkout-free (R10/AE7). */
export interface UiCheckout {
  /** Ask the backend for a checkout URL (create-web-checkout, structured outcome). */
  createCheckout(): Promise<WebCheckoutOutcome>;
  /** Open the checkout tab. Resolves with the new tab's id when the host knows it — the popup
   * usually dies before this resolves, which is fine: the pending flag is already persisted. */
  openCheckoutTab(url: string): Promise<number | undefined>;
  /** Persist the pending record; null clears it. Must land synchronously-enough that a write
   * followed by popup death survives (chrome.storage queues the write, U6). */
  setPending(pending: CheckoutPending | null): void;
  /** Trigger a server reconcile (backend → entitlement-cache write). The entitled flip reaches
   * the controller through the entitlement subscription; the returned outcome only signals
   * auth-required (re-sign-in) vs keep-waiting. */
  reconcile(): Promise<CheckoutReconcileOutcome>;
}

export interface UiControllerDeps {
  readonly cache: SettingsCache;
  readonly host: UiHost;
  readonly auth?: UiAuth;
  /** Host persistence for pendingOtp + purchase intent. Only code-flow hosts wire it. */
  readonly persistence?: AuthPersistence;
  /** Host checkout seam (plan U4/R3). Only web-purchasable hosts wire it. */
  readonly checkout?: UiCheckout;
  /** Injected clock (ms epoch) for the resend cooldown / OTP expiry — Date.now in real wiring,
   * controlled in tests (same seam as SettingsCache / the entitlement adapters). */
  readonly clock?: () => number;
}

export class UiController {
  settings = $state<StillSettings>(DEFAULT_SETTINGS);

  // Sync + connectivity — the entrypoint updates these from SyncService events.
  userId = $state<string | null>(null);
  reconciling = $state(false);
  cloudReachable = $state(true);

  /** Backing stores for the `entitled` accessor below: the two entitlement lanes (ADR 0003).
   * Server-derived (reconcile/webhook truth, cleared on teardown) and receipt-derived (the
   * device's StoreKit receipt, R17 — SURVIVES sign-out/deletion; only a verified revocation or
   * receipt absence clears it). The UI renders their OR; sync-flavored UI keys off the server
   * lane specifically. */
  #serverEntitled = $state(false);
  #receiptEntitled = $state(false);
  /** The quieter-web success payoff (U3/R6): true from the moment entitlement turns
   * on with the paywall open until the payoff dismisses (~2.5s auto, or early on tap/Escape).
   * Never true while `entitled` is false — the setter clears it on any downgrade. */
  justUnlocked = $state(false);

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
  /** Seconds until a rate-limited SEND unblocks (R2/R4): locks the email-view CTA and the resend
   * button, whole seconds, 0 = unlocked. Independent of `codeRequestedAt` by design — that field
   * doubles as the expiry-classification input, and stamping it on a FAILED send would corrupt
   * expired-vs-wrong judgment. */
  sendBlockRemaining = $state(0);
  /** Seconds until a rate-limited VERIFY unblocks (R3): locks the verify button. */
  verifyBlockRemaining = $state(0);
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
  /** The post-purchase success screen (R3). Suppresses the payoff while active — a purchase
   * resolves through this dedicated presentation, never the auto-dismissing one-liner. */
  successScreen = $state<SuccessScreen>("none");
  /** The checkout-pending presentation (plan U4/R3): persisted-flag lifecycle across popup deaths,
   * orthogonal to purchaseFlow (which tracks one tap's in-flight purchase). */
  checkoutFlow = $state<CheckoutFlow>("none");

  readonly host: UiHost;
  private readonly cache: SettingsCache;
  private readonly auth?: UiAuth;
  private readonly persistence?: AuthPersistence;
  private readonly checkout?: UiCheckout;
  private readonly now: () => number;
  /** When the current code was requested — drives the resend countdown and expiry detection. */
  private codeRequestedAt: number | null = null;
  /** Bumped by any deliberate exit from the sign-in flow (dismiss / use-a-different-email). An
   * async auth call captures it before its await and bails if it changed — so a request/verify the
   * user abandoned mid-flight can't still persist a pendingOtp record or silently sign them in (F6,
   * mirrors pollReconcile's post-await re-check). */
  private authFlowGeneration = 0;
  /** Synchronous in-flight guard for resend: the resend cooldown only starts AFTER the request
   * resolves, so two rapid taps would both pass the cooldown check and fire concurrent requests
   * without this (F7). */
  private resendInFlight = false;
  /** Ticks the visible countdown once a second while a cooldown runs; self-clears at 0 (the popup
   * dies with the sheet anyway, so no destroy hook is needed). */
  private cooldownTimer: ReturnType<typeof setInterval> | null = null;
  /** Rate-limit lock deadlines + tickers (R2/R3) — same one-second idiom as cooldownTimer. */
  private sendBlockedUntil: number | null = null;
  private sendBlockTimer: ReturnType<typeof setInterval> | null = null;
  private verifyBlockedUntil: number | null = null;
  private verifyBlockTimer: ReturnType<typeof setInterval> | null = null;
  /** Auto-dismisses the payoff after PAYOFF_DURATION_MS; cleared on early dismiss (U3/R6). */
  private payoffTimer: ReturnType<typeof setTimeout> | null = null;
  /** The local mirror of the persisted checkout-pending record (U4/R3) — kept so re-invoking
   * checkout / start-over can replace or clear the flag without a storage round-trip. */
  private checkoutPending: CheckoutPending | null = null;
  /** The fast-poll window's timer + call count (3s × 10, then quiet-pending). Plain setTimeout is
   * the fake-timer seam, matching the payoff/cooldown pattern. */
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollCount = 0;

  constructor(deps: UiControllerDeps) {
    this.cache = deps.cache;
    this.host = deps.host;
    this.auth = deps.auth;
    this.persistence = deps.persistence;
    this.checkout = deps.checkout;
    this.now = deps.clock ?? (() => Date.now());
    this.settings = deps.cache.current();
    deps.cache.subscribe((s) => {
      this.settings = s;
    });
  }

  /** Entitlement as the UI renders it. Hosts still assign it like a plain property (apple-session's
   * onSyncState, the extension entitlement-storage subscription), but it routes through this
   * accessor pair so the controller itself observes the false→true transition — ONE payoff rule
   * for every host (U3/R6), instead of per-host dismiss calls.
   *
   * Ordering (R6: the payoff fires only AFTER the entitlement store write has landed): this
   * property is driven by the entitlement storage subscription on extension hosts — which fires
   * only once the record write landed — and by explicit setters after a server-confirmed reconcile
   * on Apple. So observing the controller's own transition IS the after-the-write signal; no extra
   * synchronization is needed here. */
  get entitled(): boolean {
    return this.#serverEntitled || this.#receiptEntitled;
  }

  /** SERVER-LANE setter — existing hosts assign it like a plain property (apple-session's
   * onSyncState, the extension entitlement-storage subscription). Teardown's `entitled = false`
   * clears only this lane: receipt-derived Pro survives sign-out by design (R6). */
  set entitled(value: boolean) {
    this.applyEntitlementInput(() => {
      this.#serverEntitled = value;
    });
  }

  /** The server lane alone — sync-flavored UI and the attach evaluation key off this, because the
   * merged `entitled` is true for a receipt-only device that the ACCOUNT doesn't yet own. */
  get serverEntitled(): boolean {
    return this.#serverEntitled;
  }

  get receiptEntitled(): boolean {
    return this.#receiptEntitled;
  }

  /** RECEIPT-LANE setter (R17) — fed from the bridge's receipt reads by the Apple session. */
  set receiptEntitled(value: boolean) {
    this.applyEntitlementInput(() => {
      this.#receiptEntitled = value;
    });
  }

  /** One transition rule over the MERGED entitlement, whichever lane moved: payoff on a rise with
   * a paywall surface open (unless the success screen owns the moment), checkout-pending lifecycle
   * ends on a rise, and the payoff never renders against a false entitlement. */
  private applyEntitlementInput(mutate: () => void): void {
    const before = this.entitled;
    mutate();
    const after = this.entitled;
    const rose = !before && after;
    // A rise that resolves a PENDING purchase (Ask-to-Buy approval, webhook landing) is a
    // purchase moment: it routes to the success screen, never the auto-dismissing payoff —
    // regardless of whether the server reconcile or the receipt read delivered the flip first
    // (the two race on foreground; adversarial review pin).
    if (rose && this.purchaseFlow === "pending") {
      this.showPurchaseSuccess();
      this.clearCheckoutPending();
      return;
    }
    // Payoff only when a paywall surface is open (a quiet background unlock stays quiet, R6).
    // Eligibility is judged BEFORE the pending flag is cleared below — the checkout-pending
    // presentation is exactly what makes a rehydrated paying user eligible (U4).
    if (rose && this.payoffEligible) this.showPayoff();
    // Confirmed entitlement ends any checkout-pending lifecycle: clear the persisted flag and
    // stop polling — the payoff (above) fires exactly once, on this edge (U4/R6).
    if (rose) this.clearCheckoutPending();
    // Ordering pin: the payoff must never render against a false entitlement — a revocation or
    // teardown mid-payoff clears it immediately.
    if (!after) this.clearPayoff();
  }

  /** Whether an entitled false→true transition should celebrate (U3/R6): while the paywall is
   * open, or while a checkout-pending presentation (U4: checking / quiet-pending / stale /
   * auth-required) is active — that presentation is a paywall-independent rehydration surface,
   * and a paying user must get the payoff, never a quiet unlock. */
  private get payoffEligible(): boolean {
    // The success screen owns purchase moments (R3): while it is active (or about to be — the
    // session shows it before feeding the receipt flip), the quiet payoff stays out of the way.
    if (this.successScreen !== "none") return false;
    return this.paywallOpen || this.checkoutFlow !== "none";
  }

  /** Resolve a completed purchase into the success screen (R3): signed-out buyers get the
   * optional-account pitch; signed-in buyers get the sync confirmation. Renders in the paywall
   * sheet with NO auto-dismiss — leaving is an explicit choice ("Not now" / account CTA). */
  showPurchaseSuccess(): void {
    // Dormant paid tier: see openPaywall below. Nothing can be purchased, so there is no purchase
    // to celebrate, and the success screen only exists inside the sheet that no longer mounts.
    if (!PAID_TIER_ENABLED) return;
    this.clearPayoff();
    this.successScreen = this.userId === null ? "account-pitch" : "synced";
    this.paywallOpen = true;
    this.purchaseFlow = "idle";
    this.purchaseError = null;
  }

  /** The success screen's account CTA: hand off to the sign-in sheet (the attach happens inside
   * the session's enterSession once the code verifies — no purchase intent needed; they own Pro).
   * Dismissal ("Not now" / Done / Escape) goes through dismissPaywall, which clears the success
   * screen along with the rest of the sheet state — one dismissal path, no sibling to drift. */
  createAccountFromSuccess(): void {
    this.successScreen = "none";
    this.paywallOpen = false;
    this.openSignIn();
  }

  /** Show the payoff and schedule its auto-dismiss. The payoff supersedes any in-flight/outcome
   * purchase copy (e.g. Apple's "pending" after an Ask-to-Buy approval finally reconciles). Plain
   * setTimeout is the settable timeout seam — tests drive it with vitest fake timers, matching the
   * resend-cooldown pattern (U3/R6). */
  private showPayoff(): void {
    this.justUnlocked = true;
    // The payoff renders inside the paywall sheet; when eligibility came from the checkout-pending
    // presentation with the sheet dismissed (U4), surface the sheet so the payoff is seen.
    this.paywallOpen = true;
    this.purchaseFlow = "idle";
    this.purchaseError = null;
    this.clearPayoffTimer();
    this.payoffTimer = setTimeout(
      () => this.dismissPaywall(),
      PAYOFF_DURATION_MS,
    );
  }

  private clearPayoff(): void {
    this.clearPayoffTimer();
    this.justUnlocked = false;
  }

  private clearPayoffTimer(): void {
    if (this.payoffTimer !== null) {
      clearTimeout(this.payoffTimer);
      this.payoffTimer = null;
    }
  }

  /**
   * Which sync card to draw.
   *
   * Three of these states exist only to describe what an entitlement did or did not grant, so
   * while the paid tier is dormant behind PAID_TIER_ENABLED they are unreachable and the card
   * turns on one fact: whether there is an account. Someone signed out is signed out whether or
   * not their device carries an old purchase; someone signed in is syncing whether or not they
   * ever bought anything. The three branches are preserved, not deleted, and each one's condition
   * returns with the switch.
   */
  get popupState(): PopupState {
    if (this.userId && !this.cloudReachable) return "cloud-unreachable";
    // Receipt-entitled with no session (purchase-first): Pro is ACTIVE — the home screen must not
    // render a buy CTA that startUpgrade() would silently no-op on. Sign-in stays visible (R3/R9).
    if (!this.userId) {
      return PAID_TIER_ENABLED && this.entitled ? "pro-no-account" : "signed-out";
    }
    if (this.reconciling) return "entitlement-pending";
    if (PAID_TIER_ENABLED && !this.entitled) return "not-entitled";
    // Sync-flavored state keys off the SERVER lane: a signed-in user whose Pro is receipt-only
    // (family-shared receipt is attach-ineligible; or the attach/webhook hasn't landed) is NOT
    // synced, because claiming a sync that will never happen would be false, possibly permanently
    // (Codex review pin). Device Pro still unlocks the rows via the merged `entitled`. With the
    // paid tier dormant this cannot arise: settings sync follows the account, not the receipt.
    if (PAID_TIER_ENABLED && !this.serverEntitled) return "pro-device-only";
    return "entitled-syncing";
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
      typeof this.auth?.requestCode === "function" &&
      typeof this.auth?.verifyCode === "function"
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
    // Nothing is locked while the paid tier is dormant behind PAID_TIER_ENABLED: every row is a
    // live toggle for everyone, and the lock returns with the switch.
    return PAID_TIER_ENABLED && !this.entitled && PRO_SERVICE_IDS.has(id);
  }

  /** Start the Pro upgrade path. NATIVE-purchase hosts (Apple — no checkout seam) open the
   * paywall directly regardless of session: purchase requires no account (purchase-first,
   * Guideline 5.1.1(v); plan 2026-07-15-001). WEB-checkout hosts keep sign-in-first — there the
   * account is the entitlement's delivery mechanism, not a compliance choice — recording purchase
   * intent so a successful sign-in continues to the paywall without re-tapping. Hosts without a
   * purchase path get the explanatory paywall state. */
  startUpgrade(): void {
    // The upgrade path is preserved and unreachable while the paid tier is dormant behind
    // PAID_TIER_ENABLED. There is nothing to buy, so every entry point into it is a no-op.
    if (!PAID_TIER_ENABLED) return;
    // Also a no-op while a purchase/restore is in flight — a second trigger (locked-row tap,
    // upgrade CTA) must not reset purchaseFlow mid-purchase.
    if (this.entitled || this.purchaseBusy) return;
    if (this.canWebCheckout && this.canSignIn && !this.userId) {
      this.setPurchaseIntent(true);
      this.openSignIn();
      return;
    }
    this.openPaywall();
  }

  /** Tap on a locked row: the Pro discovery surface. */
  lockedTap(): void {
    this.startUpgrade();
  }

  openSignIn(): void {
    this.signInOpen = true;
  }

  dismissSignIn(): void {
    this.authFlowGeneration += 1; // cancel any in-flight send/verify/resend continuation (F6)
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
    // Reset "sending" too: the generation bump above discards the in-flight send continuation, so a
    // dismissal mid-first-send would otherwise leave the reopened sheet stuck on a disabled
    // "Sending…" CTA (no reset path on the long-lived Apple webview short of an app relaunch).
    if (
      this.authFlow === "error" ||
      this.authFlow === "sent" ||
      this.authFlow === "sending"
    )
      this.authFlow = "idle";
    this.authError = null;
    // An email-view send lock (no code flow entered yet) is UI-only state — clear it with the
    // sheet for the same reason clearCodeFlow clears the in-flow locks.
    this.clearSendBlock();
  }

  openPaywall(): void {
    // The paid tier is dormant behind PAID_TIER_ENABLED, and the sheet this opens is not rendered
    // while it is. Refusing here, at the funnel rather than at the render, is what stops the
    // machinery behind the sheet from running against UI nobody can see or dismiss: the payoff
    // timer, the success screen, and the checkout poll window all key off paywallOpen.
    if (!PAID_TIER_ENABLED) return;
    if (this.purchaseBusy) return; // re-opening must not reset an in-flight purchase
    this.paywallOpen = true;
    this.purchaseFlow = "idle";
    this.purchaseError = null;
  }

  dismissPaywall(): void {
    // An early tap/Escape ends the payoff too; clearing the timer keeps a stale auto-dismiss from
    // firing into a later, unrelated paywall session (U3/R6). Escape on the success screen is an
    // explicit dismissal (equivalent to "Not now") — never an auto-dismiss.
    this.clearPayoff();
    this.successScreen = "none";
    this.paywallOpen = false;
    this.purchaseFlow = "idle";
    this.purchaseError = null;
  }

  // ── Purchase / restore flow (P1 #5) ─────────────────────────────────────────────────────────────

  /** Whether a purchase or restore is in flight — used to disable duplicate taps. */
  get purchaseBusy(): boolean {
    return (
      this.purchaseFlow === "purchasing" ||
      this.purchaseFlow === "opening-checkout" ||
      this.purchaseFlow === "restoring"
    );
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
      case "staleIdentity":
        // Signed out, but the purchase identity couldn't be verified anonymous (R15 — a prior
        // sign-out's logOut may have failed). The sheet renders a "Try again" CTA that re-runs
        // the native reset-then-purchase sequence — never a "sign out" instruction (the user
        // already is).
        this.purchaseFlow = "stale-identity";
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

  // ── Web checkout flow (plan U4/R3/R5) ───────────────────────────────────────────────────────────

  /** Whether this host purchases through a web checkout tab (the injected seam, U6) — the paywall
   * CTA then drives startWebCheckout instead of the host's native onGet closure. */
  get canWebCheckout(): boolean {
    return this.host.canPurchase && this.checkout !== undefined;
  }

  /** The paywall CTA on a web host: create-checkout with structured outcome routing (U4). Also the
   * retry from the stale find-my-purchase state — invoking checkout while a pending flag exists
   * REPLACES the flag (the server 409 is the double-entitlement guard); abandonment must never
   * trap the buyer for 24h. */
  async startWebCheckout(): Promise<void> {
    if (!this.checkout || this.purchaseBusy) return;
    // A fresh checkout supersedes any pending presentation/poll window (replace, not block).
    this.stopPollTimer();
    this.checkoutFlow = "none";
    this.purchaseFlow = "opening-checkout";
    this.purchaseError = null;
    const outcome = await this.checkout.createCheckout();
    switch (outcome.kind) {
      case "checkout-url": {
        // Persist BEFORE opening the tab: the popup dies the moment the tab takes focus (R3), so
        // a flag written after tabs.create would be lost with it.
        const pending: CheckoutPending = { startedAt: this.now() };
        this.setCheckoutPending(pending);
        const tabId = await this.checkout.openCheckoutTab(outcome.url);
        // Best-effort enrichment — in a popup this line usually never runs (the popup is dead).
        if (tabId !== undefined) this.setCheckoutPending({ ...pending, tabId });
        // A surviving context (options page) settles into the quiet-pending presentation: polling
        // costs a live RC query per hit, so fast-poll windows start on reopen/rehydration (U4).
        this.purchaseFlow = "idle";
        this.checkoutFlow = "quiet-pending";
        return;
      }
      case "already-entitled": {
        // R5/AE4: the cross-device restore case is a SUCCESS path — reconcile writes the cache,
        // the entitled flip arrives through the subscription and fires the payoff. Never an error.
        if (this.entitled || this.justUnlocked) {
          // The host's reconcile already landed before this outcome arrived — payoff handled.
          if (!this.justUnlocked) this.purchaseFlow = "idle";
          return;
        }
        this.purchaseFlow = "restoring";
        const result = await this.checkout.reconcile();
        if (this.entitled || this.justUnlocked) return; // write landed mid-await; payoff superseded
        if (result === "auth-required") {
          this.enterCheckoutAuthRequired();
          return;
        }
        if (result === "entitled") return; // cache write in flight — the flip fires the payoff (R6)
        // Entitled server-side (the 409) but the confirming reconcile couldn't land right now
        // (offline): calm retry copy, CTA re-enabled — still never an error state (R5).
        this.purchaseFlow = "unavailable";
        return;
      }
      case "auth-required":
        // Session died before checkout could start: re-sign-in affordance; the entitlement cache
        // and any prior pending flag both survive (KTD auth-required ≠ teardown).
        this.enterCheckoutAuthRequired();
        return;
      case "unavailable":
        // Calm failure copy; not busy, so the CTA re-enables for a retry (R3).
        this.purchaseFlow = "unavailable";
        return;
    }
  }

  /** Host rehydration input (U4/R3): called on mount with the persisted checkout-pending record.
   * Fresh pending → "checking your purchase…" + a fresh fast-poll window (reopening the popup IS
   * the retry gesture); >24h or garbage/missing startedAt → the stale find-my-purchase state —
   * expired-pending, never NaN-comparison limbo (mirrors the chrome-adapter garbage-timestamp
   * rule). Already entitled (the background nudge won the race, AE3) → clear the moot flag. */
  rehydrateCheckoutPending(
    pending: { startedAt?: number; tabId?: number } | null | undefined,
  ): void {
    if (!this.checkout || pending === null || pending === undefined) return;
    // A checkout that can no longer complete is moot while the paid tier is dormant behind
    // PAID_TIER_ENABLED, so clear the record instead of presenting it. Presenting would start a
    // repeating entitlement poll behind a sheet that does not render, and the only control that
    // cancels it ("I didn't finish checkout") lives inside that sheet. Clearing is what frees a
    // user carrying a stale flag from an older install: it happens once, and never again.
    if (!PAID_TIER_ENABLED) {
      this.setCheckoutPending(null);
      return;
    }
    if (this.entitled) {
      this.setCheckoutPending(null);
      return;
    }
    const at = pending.startedAt;
    // Normalize a garbage/missing startedAt to a just-expired stamp: there is nothing to measure
    // the 24h window from, so the record reads as expired-pending through the one shared
    // presentation path below — never a NaN comparison, never an eternal "checking".
    const startedAt =
      typeof at === "number" && Number.isFinite(at)
        ? at
        : this.now() - CHECKOUT_PENDING_TTL_MS - 1;
    this.presentCheckoutPending({ startedAt, tabId: pending.tabId });
  }

  /** "I didn't finish checkout — start over" (U4): clears the pending flag immediately and
   * re-enables the CTA. Checkout abandonment is the most common outcome — never a 24h trap. */
  abandonCheckout(): void {
    this.clearCheckoutPending();
    this.purchaseFlow = "idle";
    this.purchaseError = null;
  }

  /** The auth-required re-sign-in affordance (U4): the session is dead, so reflect it locally —
   * WITHOUT teardown semantics: no entitlement write (the cache rides out its TTL), no pending
   * clear (the purchase may have happened). Purchase intent makes the paywall reopen after the
   * sign-in completes, and verifyCode resumes the pending presentation (one continuous flow). */
  reSignInFromCheckout(): void {
    this.userId = null; // local mirror of the dead session — NOT resetToSignedOut (no downgrade)
    this.stopPollTimer(); // polls would keep hitting 401; sign-in restarts the window
    this.paywallOpen = false;
    this.setPurchaseIntent(true);
    this.openSignIn();
  }

  /** Shared presentation for a (normalized) pending record: stale → find-my-purchase; fresh →
   * checking + a fast-poll window. Both surface through the paywall sheet — the rehydrated
   * pending state counts as paywall-open (U3 rule / U4). */
  private presentCheckoutPending(pending: CheckoutPending): void {
    this.checkoutPending = pending;
    this.paywallOpen = true;
    this.purchaseFlow = "idle";
    this.purchaseError = null;
    if (this.now() - pending.startedAt > CHECKOUT_PENDING_TTL_MS) {
      this.stopPollTimer();
      this.checkoutFlow = "stale-pending";
      return;
    }
    this.startPollWindow();
  }

  /** A fresh fast-poll window: reconcile now, then every 3s up to the cap (U4). */
  private startPollWindow(): void {
    this.stopPollTimer();
    this.pollCount = 0;
    this.checkoutFlow = "checking";
    void this.pollReconcile();
  }

  private async pollReconcile(): Promise<void> {
    if (!this.checkout || this.checkoutFlow !== "checking") return;
    this.pollCount += 1;
    const outcome = await this.checkout.reconcile();
    // The window may have ended mid-await: the entitled flip cleared pending (payoff path), or
    // start-over / a fresh checkout superseded it — never act on a stale poll.
    if (this.checkoutFlow !== "checking") return;
    if (outcome === "auth-required") {
      this.enterCheckoutAuthRequired();
      return;
    }
    if (this.pollCount >= CHECKOUT_POLL_MAX) {
      // Cap reached (each poll is a live RC query): rest in the quiet-pending copy — reopening
      // the popup starts a fresh window, and the background nudge (AE3) keeps working meanwhile.
      this.checkoutFlow = "quiet-pending";
      return;
    }
    this.pollTimer = setTimeout(
      () => void this.pollReconcile(),
      CHECKOUT_POLL_INTERVAL_MS,
    );
  }

  private enterCheckoutAuthRequired(): void {
    this.stopPollTimer();
    this.checkoutFlow = "auth-required";
    this.purchaseFlow = "idle";
    this.purchaseError = null;
  }

  /** Persist (or clear) the pending record through the host seam, mirroring it locally. */
  private setCheckoutPending(pending: CheckoutPending | null): void {
    this.checkoutPending = pending;
    this.checkout?.setPending(pending);
  }

  /** End the pending lifecycle everywhere: poll window, presentation, persisted flag. Runs on the
   * entitled flip (purchase confirmed), start-over, and teardown. */
  private clearCheckoutPending(): void {
    this.stopPollTimer();
    if (this.checkoutPending !== null) this.setCheckoutPending(null);
    this.checkoutFlow = "none";
  }

  private stopPollTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** The sheet's one send action. Code-capable hosts get the code flow (→ code-entry); everyone
   * else keeps the magic link (→ sent). Same button, capability-driven path (plan U2). */
  async signIn(email: string): Promise<void> {
    if (
      !this.auth ||
      this.authFlow === "sending" ||
      this.authFlow === "verifying" ||
      this.sendBlockRemaining > 0 // rate-limit lock (R2) — the sheet disables the CTA; this covers programmatic callers
    )
      return;
    // Gate the request on a syntactically valid address so a malformed email never issues a
    // failing auth call (the sheet disables the button for the same reason; this also covers a
    // programmatic caller). No-op rather than an error state — nothing was attempted.
    if (!isValidEmail(email)) return;
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
   * text can ever reach the code path. A rate-limited first send (R2 — the state a user hits
   * under the hourly SMTP cap) additionally locks the email-view CTA: retrying cannot help and
   * only extends the server window. */
  private async sendCode(email: string): Promise<void> {
    this.authFlow = "sending";
    this.authError = null;
    const gen = this.authFlowGeneration;
    const outcome = await this.auth!.requestCode!(email);
    if (this.authFlowGeneration !== gen) return; // dismissed mid-request — don't persist or enter
    if (outcome.kind === "sent") {
      this.enterCodeEntry(email, this.now());
      this.persistence?.setPendingOtp({
        email,
        requestedAt: this.codeRequestedAt!,
      });
    } else {
      this.authFlow = "error";
      if (outcome.kind === "send-rate-limited")
        this.startSendBlock(outcome.retryAfterSeconds);
    }
  }

  /** Verify the entered 6-digit code. Success signs in (and continues to the paywall when a
   * locked-row tap started this flow — auto-OPEN only, never auto-checkout); a rejected code keeps
   * the sheet on code-error for a retype, counting attempts toward request-a-new-code. */
  async verifyCode(code: string): Promise<void> {
    if (!this.auth?.verifyCode || this.codeEmail === null) return;
    if (this.authFlow === "verifying" || this.verifyBlockRemaining > 0) return;
    this.authFlow = "verifying";
    this.codeErrorKind = null;
    const expired = this.codeIsExpired(); // judged against the request time, pre-await
    const gen = this.authFlowGeneration;
    const outcome = await this.auth.verifyCode(this.codeEmail, code);
    // Abandoned mid-verify (Not now / use-a-different-email): drop the result — a cancelled verify
    // must not silently sign the user in (F6).
    if (this.authFlowGeneration !== gen) return;
    if (outcome.kind === "verified") {
      this.userId = outcome.userId;
      this.clearCodeFlow();
      this.authFlow = "idle";
      this.signInOpen = false;
      this.persistence?.setPendingOtp(null);
      const continueToPaywall = this.purchaseIntent;
      this.setPurchaseIntent(false);
      // An already-Pro account signing in through an upgrade surface must not land on a buy
      // sheet. Hosts that reconcile entitlement inside the awaited verifyCode (the Apple host's
      // onCodeVerified) have `entitled` settled here; hosts whose reconcile lands later still
      // open the paywall, and the entitled flip converts it to the payoff (justUnlocked).
      if (continueToPaywall && !this.entitled) this.openPaywall();
      // Re-sign-in with a live checkout-pending flag (the U4 auth-required path): resume the
      // pending presentation — a fresh poll window, or the stale state if it decayed meanwhile.
      if (this.checkoutPending !== null)
        this.presentCheckoutPending(this.checkoutPending);
    } else if (outcome.kind === "invalid-code") {
      this.codeAttempts += 1;
      this.codeErrorKind = expired ? "expired" : "wrong";
      this.authFlow = "code-error";
    } else if (outcome.kind === "verify-rate-limited") {
      // Per-IP verify throttle (R3): NOT an attempt (codeAttempts untouched — the code was never
      // judged), and the verify button locks so the wait can't be extended by hammering.
      this.codeErrorKind = "verify-rate-limited";
      this.authFlow = "code-error";
      this.startVerifyBlock(outcome.retryAfterSeconds);
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
    if (
      this.authFlow === "verifying" ||
      this.resendInFlight ||
      this.resendRemainingMs() > 0 ||
      this.sendBlockRemaining > 0
    )
      return;
    const email = this.codeEmail;
    const gen = this.authFlowGeneration;
    this.resendInFlight = true; // synchronous guard: the cooldown only starts after this resolves (F7)
    try {
      const outcome = await this.auth.requestCode(email);
      if (this.authFlowGeneration !== gen) return; // abandoned mid-resend
      if (outcome.kind === "sent") {
        this.enterCodeEntry(email, this.now());
        this.persistence?.setPendingOtp({
          email,
          requestedAt: this.codeRequestedAt!,
        });
      } else if (outcome.kind === "send-rate-limited") {
        // A throttled resend locks the button (R4) — without this it re-enables instantly and two
        // taps in a row are guaranteed 429s. The prior code (and its expiry classification, via the
        // untouched codeRequestedAt/pendingOtp) survives: only the newest EMAIL invalidates it.
        this.codeErrorKind = "resend-rate-limited";
        this.startSendBlock(outcome.retryAfterSeconds);
      } else {
        // Stay on code entry — the previous code may still work; surface a calm resend line.
        this.codeErrorKind = "resend-failed";
      }
    } finally {
      this.resendInFlight = false;
    }
  }

  /** The "use a different email" escape (R1): back to the email field. Clears the pending OTP but
   * keeps any purchase intent — the user is still mid-unlock, just fixing a typo'd address. */
  useDifferentEmail(): void {
    this.authFlowGeneration += 1; // cancel any in-flight verify/resend continuation (F6)
    this.clearCodeFlow();
    this.authFlow = "idle";
    this.authError = null;
    this.persistence?.setPendingOtp(null);
  }

  /** Host rehydration input (AE2): called on mount with the persisted pendingOtp so reopening the
   * popup within the OTP TTL lands straight on code entry for that email — countdown restored from
   * the original request time, purchase intent restored from the persisted flag. */
  rehydrateCodeEntry(pending: {
    email: string;
    requestedAt?: number;
    purchaseIntent?: boolean;
  }): void {
    if (!this.canUseCode || this.userId) return;
    const at = pending.requestedAt;
    const validAt = typeof at === "number" && Number.isFinite(at) ? at : null;
    this.enterCodeEntry(pending.email, validAt);
    // A record older than the OTP TTL rehydrates straight into the expired presentation (R6):
    // landing on a live code form for a dead code invites a wasted attempt against the verify
    // limit. The resend affordance is already unlocked (the cooldown elapsed long ago).
    if (validAt !== null && this.now() - validAt > OTP_TTL_MS) {
      this.codeErrorKind = "expired";
      this.authFlow = "code-error";
    }
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
    this.clearSendBlock(); // a send just succeeded — the send window has demonstrably lifted
    this.startResendCooldown();
  }

  private get inCodeFlow(): boolean {
    return this.codeEmail !== null;
  }

  private codeIsExpired(): boolean {
    return (
      this.codeRequestedAt !== null &&
      this.now() - this.codeRequestedAt > OTP_TTL_MS
    );
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
    // UI locks only — the server window doesn't care about our sheet; a deliberate exit starts the
    // next open clean and a too-early retry just re-renders the calm wait copy.
    this.clearSendBlock();
    this.clearVerifyBlock();
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

  // ── Rate-limit locks (R2/R3/R4) ─────────────────────────────────────────────────────────────────
  // Fixed 60s unless the transport supplied a genuine retry-after (review-signin does; GoTrue
  // never does — its seconds live in message text, which is never parsed). On elapse each lock
  // clears its own presentation so the sheet returns to a clean, retryable state without a stale
  // error line.

  private startSendBlock(retryAfterSeconds?: number): void {
    const ms =
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : RATE_LIMIT_LOCK_MS;
    this.sendBlockedUntil = this.now() + ms;
    if (this.sendBlockTimer !== null) clearInterval(this.sendBlockTimer);
    this.updateSendBlock();
    this.sendBlockTimer = setInterval(() => this.updateSendBlock(), 1000);
  }

  private updateSendBlock(): void {
    const remaining = this.sendBlockedUntil === null ? 0 : this.sendBlockedUntil - this.now();
    this.sendBlockRemaining = Math.ceil(Math.max(0, remaining) / 1000);
    if (this.sendBlockRemaining > 0) return;
    this.clearSendBlock();
    // The lock was the only thing the wait presentations conveyed — clear them so the CTA
    // re-enables into a clean state rather than a stale "can't send" line.
    if (this.codeErrorKind === "resend-rate-limited") this.codeErrorKind = null;
    if (this.authFlow === "error" && !this.inCodeFlow) this.authFlow = "idle";
  }

  private clearSendBlock(): void {
    this.sendBlockedUntil = null;
    this.sendBlockRemaining = 0;
    if (this.sendBlockTimer !== null) {
      clearInterval(this.sendBlockTimer);
      this.sendBlockTimer = null;
    }
  }

  private startVerifyBlock(retryAfterSeconds?: number): void {
    const ms =
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : RATE_LIMIT_LOCK_MS;
    this.verifyBlockedUntil = this.now() + ms;
    if (this.verifyBlockTimer !== null) clearInterval(this.verifyBlockTimer);
    this.updateVerifyBlock();
    this.verifyBlockTimer = setInterval(() => this.updateVerifyBlock(), 1000);
  }

  private updateVerifyBlock(): void {
    const remaining = this.verifyBlockedUntil === null ? 0 : this.verifyBlockedUntil - this.now();
    this.verifyBlockRemaining = Math.ceil(Math.max(0, remaining) / 1000);
    if (this.verifyBlockRemaining > 0) return;
    this.clearVerifyBlock();
    if (this.codeErrorKind === "verify-rate-limited") this.codeErrorKind = null;
  }

  private clearVerifyBlock(): void {
    this.verifyBlockedUntil = null;
    this.verifyBlockRemaining = 0;
    if (this.verifyBlockTimer !== null) {
      clearInterval(this.verifyBlockTimer);
      this.verifyBlockTimer = null;
    }
  }

  /** Clear all signed-in UI state back to the signed-out baseline. Shared by signOut + delete so a
   * new field added here can't be forgotten in one path. Clears only the SERVER entitlement lane:
   * receipt-derived Pro belongs to the device's Apple Account and survives teardown (R6) — a
   * receipt-entitled device lands on `pro-no-account`, not a re-locked home screen. */
  private resetToSignedOut(): void {
    this.userId = null;
    this.entitled = false; // server lane only — the setter never touches #receiptEntitled
    this.authFlow = "idle";
    this.paywallOpen = false;
    this.successScreen = "none";
    this.purchaseFlow = "idle";
    this.purchaseError = null;
    // Code-flow leftovers must not survive a teardown: no pending code entry, no purchase intent
    // that could auto-open the paywall for the NEXT identity on this browser (R8 spirit).
    this.clearCodeFlow();
    this.setPurchaseIntent(false);
    // A VOLUNTARY sign-out/delete also ends any checkout-pending lifecycle (R8 teardown) — unlike
    // the involuntary auth-required path (reSignInFromCheckout), which preserves it.
    this.clearCheckoutPending();
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
