import type { BenefitAccessSnapshot } from "@still/shared-types";
import { boundedAccessRead, parseBenefitAccessSnapshot } from "../entitlement/access-policy.js";
import type { AccountSyncStatus } from "../sync/account-status.js";
import type { StillBridgeWindow, StillMessagePort } from "../storage/wkwebview-adapter.js";
import { safeParse } from "../storage/settings-validation.js";
import { isDeviceClass, isVersion, type AnalyticsDevice } from "../analytics/events.js";
import { isAnalyticsId } from "../analytics/identity.js";
import { parseAccessCacheRecord, type AccessCacheRecord } from "../entitlement/access-record.js";

// The native action client (U19): the web→native calls beyond settings get/set, posted through the
// same `window.webkit.messageHandlers.still` port the storage adapter uses (WebBridgeRouter.swift
// routes by `kind`). Present only inside the Apple app's WKWebView — on other hosts `available` is
// false and the UI hides the Apple sign-in / buy CTAs (the Chromium extension keeps the email
// magic-link path).
//
// Reply shapes (JSON objects from the native router):
//   signInWithApple    → { identityToken, nonce, email?, fullName? } | { error }
//   configurePurchases → { ok: true }
//   purchase           → { outcome, entitled, error? }
//   restore / status   → { entitled }
//   safariSetupState   → SafariSetupObservation (read-only; see observeSafariSetup)
//   onboardingState    → { ok: true, shouldShow, platform, osMajorVersion }
//   completeOnboarding → { ok: true } | rejected when the web view is not the onboarding presenter
//   setAnalyticsConsent → { ok: true, enabled, answered }
//   analyticsContext   → { …, consent, consentAnswered, … } (see AnalyticsContextReply)

export interface AppleCredential {
  readonly identityToken: string;
  readonly nonce: string;
  readonly email?: string;
  readonly fullName?: string;
}

export type PurchaseOutcome =
  | "purchased"
  | "cancelled"
  | "pending"
  | "unavailable"
  | "staleIdentity" // signed out but the SDK identity isn't verifiably anonymous (R15) — retryable
  | "failed";

export interface PurchaseResult {
  readonly outcome: PurchaseOutcome;
  readonly entitled: boolean;
  readonly error?: string;
}

/** The device receipt oracle's tri-state verdict (ADR 0003). `noSignal` is ambiguity (cold cache,
 * offline, no native host) and never downgrades anything. */
export type ReceiptStatusValue = "entitled" | "verifiedNotEntitled" | "noSignal";

/** Native extension state only; this never proves site permission or onboarding completion. */
export type SafariSetupObservation =
  | {
      readonly ok: true;
      readonly platform: "ios";
      readonly extensionStatus: "unknown";
      readonly enableLocation: "settingsAppStillPage";
    }
  | {
      readonly ok: true;
      readonly platform: "macos";
      readonly extensionStatus: "enabled" | "disabled" | "unknown";
      readonly enableLocation: "safariExtensionSettings";
    };

/** The one native onboarding gate, as the web view sees it (OnboardingGatePresenter.swift).
 * `shouldShow` is true only when the app hands onboarding to the web view and it is not complete. */
export interface OnboardingStateReply {
  readonly ok: true;
  readonly shouldShow: boolean;
  readonly platform: "ios" | "macos";
  /** The OS major version from the host (iOS 18 moved Safari's settings under Apps). */
  readonly osMajorVersion: number;
}

/** The committed native usage-sharing consent. `answered` is false while it is only the default. */
export interface AnalyticsConsentObservation {
  readonly consent: boolean;
  readonly answered: boolean;
}

/** Deadline for a native read whose caller must never hang (onboarding, Safari setup). */
export const NATIVE_READ_DEADLINE_MS = 3_000;

/** Resolve `read()` or `fallback`, whichever comes first: a rejection, a throw or a reply slower
 * than `deadlineMs` all become `fallback`, so a silent native host can never stall the caller. */
export function boundedNativeRead<T>(
  read: () => Promise<T>,
  fallback: T,
  deadlineMs: number = NATIVE_READ_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), deadlineMs);
    Promise.resolve()
      .then(read)
      .then(finish, () => finish(fallback));
  });
}

export type NativeMessage =
  | { readonly kind: "safariSetupState" }
  | { readonly kind: "onboardingState" }
  | { readonly kind: "completeOnboarding" }
  | { readonly kind: "signInWithApple" }
  | { readonly kind: "configurePurchases"; readonly appUserID: string }
  | { readonly kind: "purchase" }
  | { readonly kind: "restore" }
  | { readonly kind: "purchaseStatus" }
  | { readonly kind: "receiptStatus" }
  | { readonly kind: "attachPurchases" }
  | { readonly kind: "price" }
  | { readonly kind: "setAccountSyncStatus"; readonly status: AccountSyncStatus | null }
  | { readonly kind: "signOut" }
  | { readonly kind: "setEntitlement"; readonly entitled: boolean }
  | { readonly kind: "getAccess" }
  | { readonly kind: "getBenefitAccess" }
  | { readonly kind: "analyticsContext" }
  | { readonly kind: "setAnalyticsConsent"; readonly enabled: boolean }
  | { readonly kind: "acknowledgeAnalyticsNotice" };

/** The app's analytics launch context (AnalyticsIdentity.swift / WebBridgeRouter). */
export interface AnalyticsContextReply {
  readonly platform: "ios" | "macos";
  readonly appVersion: string;
  readonly installId: string;
  readonly anchorId: string;
  /** This launch created the device's install record. */
  readonly created: boolean;
  /** A new install whose iCloud person anchor already existed. */
  readonly returning: boolean;
  /** The version this device last ran, when it differs (an update). */
  readonly previousVersion: string | null;
  readonly consent: boolean;
  readonly noticeSeen: boolean;
  /** Whether Safari reports the extension on; null where the app cannot know (iPhone). */
  readonly extensionEnabled: boolean | null;
  /** Phone, tablet or desktop, from the device itself. */
  readonly device: AnalyticsDevice | null;
}

export class NativeBridge {
  private safariSetupReadGeneration = 0;
  private onboardingStateReadGeneration = 0;
  private onboardingCompletionGeneration = 0;
  private analyticsConsentReadGeneration = 0;
  private analyticsConsentWriteGeneration = 0;
  constructor(
    private readonly win: StillBridgeWindow = globalThis as unknown as StillBridgeWindow,
  ) {}

  private get port(): StillMessagePort | null {
    return this.win.webkit?.messageHandlers?.still ?? null;
  }

  /** True only inside the Apple WKWebView host. The UI gates Apple sign-in / purchase on this. */
  get available(): boolean {
    return this.port !== null;
  }

  /** Read the current host without opening settings. Unobserved A-B-A port swaps
   * cannot be distinguished by identity; overlapping observed reads are fenced. */
  async observeSafariSetup(): Promise<SafariSetupObservation | null> {
    const generation = ++this.safariSetupReadGeneration;
    const port = this.port;
    if (!port) return null;
    try {
      const reply = await port.postMessage({ kind: "safariSetupState" });
      if (generation !== this.safariSetupReadGeneration || port !== this.port)
        return null;
      const obj = asObject(reply);
      if (!obj || Array.isArray(obj) || obj.ok !== true) return null;
      if (
        obj.platform === "ios" &&
        obj.extensionStatus === "unknown" &&
        obj.enableLocation === "settingsAppStillPage"
      ) {
        return {
          ok: true,
          platform: "ios",
          extensionStatus: "unknown",
          enableLocation: "settingsAppStillPage",
        };
      }
      if (
        obj.platform === "macos" &&
        ["enabled", "disabled", "unknown"].includes(
          obj.extensionStatus as string,
        ) &&
        obj.enableLocation === "safariExtensionSettings"
      ) {
        return {
          ok: true,
          platform: "macos",
          extensionStatus: obj.extensionStatus as
            "enabled" | "disabled" | "unknown",
          enableLocation: "safariExtensionSettings",
        };
      }
      return null;
    } catch {
      return null;
    }
  }
  /** Ask the one native onboarding gate whether the web view should show onboarding. Null (never
   * a guessed `shouldShow`) outside the app, on any malformed reply, on a failed post, after a port
   * swap, or when a newer read was started. Callers bound it with `boundedNativeRead`. */
  async onboardingState(): Promise<OnboardingStateReply | null> {
    const generation = ++this.onboardingStateReadGeneration;
    const port = this.port;
    if (!port) return null;
    try {
      const reply = await port.postMessage({ kind: "onboardingState" });
      if (generation !== this.onboardingStateReadGeneration || port !== this.port) return null;
      const obj = asObject(reply);
      if (!obj || Array.isArray(obj) || obj.ok !== true) return null;
      if (typeof obj.shouldShow !== "boolean") return null;
      if (obj.platform !== "ios" && obj.platform !== "macos") return null;
      const major = obj.osMajorVersion;
      if (typeof major !== "number" || !Number.isInteger(major) || major < 1) return null;
      return { ok: true, shouldShow: obj.shouldShow, platform: obj.platform, osMajorVersion: major };
    } catch {
      return null;
    }
  }

  /** Mark the one native onboarding gate complete. True only for an explicit `{ ok: true }` from
   * the port this call posted to, while no newer completion was started; anything else (no host,
   * refusal, malformed reply, port swap) is false so the caller keeps onboarding visible. */
  async completeOnboarding(): Promise<boolean> {
    const generation = ++this.onboardingCompletionGeneration;
    const port = this.port;
    if (!port) return false;
    try {
      const reply = await port.postMessage({ kind: "completeOnboarding" });
      if (generation !== this.onboardingCompletionGeneration || port !== this.port) return false;
      const obj = asObject(reply);
      return !!obj && !Array.isArray(obj) && obj.ok === true;
    } catch {
      return false;
    }
  }

  /** Read back the usage-sharing consent the native App Group actually holds, and whether it is
   * an explicit answer. Sharing reads on until a choice is written (AnalyticsIdentity.swift), so
   * only `answered: true` may ever be presented as a saved choice. Strict: both fields must be
   * booleans, otherwise null (never "off"). Null outside the app, on a failed post, after a port
   * swap, or when a newer read was started. Callers bound it with `boundedNativeRead`. */
  async observeAnalyticsConsent(): Promise<AnalyticsConsentObservation | null> {
    const generation = ++this.analyticsConsentReadGeneration;
    const port = this.port;
    if (!port) return null;
    try {
      const reply = await port.postMessage({ kind: "analyticsContext" });
      if (generation !== this.analyticsConsentReadGeneration || port !== this.port) return null;
      const obj = asObject(reply);
      if (!obj || Array.isArray(obj)) return null;
      if (typeof obj.consent !== "boolean" || typeof obj.consentAnswered !== "boolean") return null;
      return { consent: obj.consent, answered: obj.consentAnswered };
    } catch {
      return null;
    }
  }

  /** Write the person's explicit usage-sharing choice straight to the native App Group (the
   * existing `setAnalyticsConsent` writer). True only for `{ ok: true, enabled: <choice>,
   * answered: true }` from the port this call posted to, while no newer write was started;
   * anything else (no host, refusal, an older native reply without `answered`, a stored value
   * that differs, a port swap) is false. Unlike `setAnalyticsConsent`, it never reports a value
   * it did not see stored. */
  async commitAnalyticsConsent(enabled: boolean): Promise<boolean> {
    const generation = ++this.analyticsConsentWriteGeneration;
    const port = this.port;
    if (!port) return false;
    try {
      const reply = await port.postMessage({ kind: "setAnalyticsConsent", enabled });
      if (generation !== this.analyticsConsentWriteGeneration || port !== this.port) return false;
      const obj = asObject(reply);
      return (
        !!obj &&
        !Array.isArray(obj) &&
        obj.ok === true &&
        obj.enabled === enabled &&
        obj.answered === true
      );
    } catch {
      return false;
    }
  }

  /**
   * Present native Sign in with Apple. Returns the identity token + raw nonce to exchange via Supabase
   * `signInWithIdToken({ provider: "apple", token, nonce })`. Throws on cancel/failure with the
   * native message.
   */
  async signInWithApple(): Promise<AppleCredential> {
    const obj = asObject(await this.post({ kind: "signInWithApple" }));
    if (!obj || typeof obj.identityToken !== "string") {
      throw new Error(typeof obj?.error === "string" ? obj.error : "Sign in with Apple failed");
    }
    return {
      identityToken: obj.identityToken,
      nonce: typeof obj.nonce === "string" ? obj.nonce : "",
      email: typeof obj.email === "string" ? obj.email : undefined,
      fullName: typeof obj.fullName === "string" ? obj.fullName : undefined,
    };
  }

  /** Re-key RevenueCat to the signed-in Supabase UUID (KTD5 — the timing moved to sign-in;
   * purchase itself runs anonymously, plan 2026-07-15-001). Call when a session exists/appears. */
  async configurePurchases(appUserID: string): Promise<void> {
    await this.post({ kind: "configurePurchases", appUserID });
  }

  /** Buy Still Pro natively. `.entitled` means local StoreKit/RevenueCat purchase feedback succeeded;
   * Pro authority still waits on the RevenueCat→Supabase webhook (U14) and the next reconcile. */
  async purchaseStillPro(): Promise<PurchaseResult> {
    const obj = asObject(await this.post({ kind: "purchase" })) ?? {};
    return {
      outcome: isOutcome(obj.outcome) ? obj.outcome : "failed",
      entitled: obj.entitled === true,
      error: typeof obj.error === "string" ? obj.error : undefined,
    };
  }

  /** Restore purchases; returns whether Still Pro is now active per RevenueCat. */
  async restore(): Promise<boolean> {
    return asObject(await this.post({ kind: "restore" }))?.entitled === true;
  }

  /** Current RevenueCat entitlement (the immediate local-UI gate only). */
  async purchaseStatus(): Promise<boolean> {
    return asObject(await this.post({ kind: "purchaseStatus" }))?.entitled === true;
  }

  /** The device receipt oracle (ADR 0003): identity-independent StoreKit 2 truth, refreshed
   * natively as a side effect of this read. Malformed/absent replies are `noSignal` — ambiguity
   * never downgrades. This is how a signed-out purchaser's UI learns it owns Pro (R17). */
  async receiptStatus(): Promise<ReceiptStatusValue> {
    const receipt = asObject(await this.post({ kind: "receiptStatus" }))?.receipt;
    return receipt === "entitled" || receipt === "verifiedNotEntitled" ? receipt : "noSignal";
  }

  /** Attach the device receipt to the signed-in Still account (R7 — RevenueCat syncPurchases,
   * natively gated on session + SDK-identity equality + purchased ownership). Returns whether the
   * entitlement is active on the account identity afterwards. */
  async attachPurchases(): Promise<boolean> {
    return asObject(await this.post({ kind: "attachPurchases" }))?.entitled === true;
  }

  /** The localized store price string for Still Pro (e.g. "$1.99"), from StoreKit via RevenueCat, or
   * null when unavailable (offering not loaded, not configured). The paywall shows the real price
   * instead of a hardcoded one. */
  async price(): Promise<string | null> {
    const price = asObject(await this.post({ kind: "price" }))?.price;
    return typeof price === "string" && price.length > 0 ? price : null;
  }

  /** Reset the native RevenueCat identity on sign-out (RevenueCat logOut + clear the configured user).
   * After this, purchase/restore/status reject until a new session reconfigures (KTD5). No-op on a
   * host with no native port. */
  async signOut(): Promise<void> {
    const reply = asObject(await this.post({ kind: "signOut" }));
    if (reply?.access === "verification_required") throw new Error("Account access requires verification");
  }

  /** Propose the server-reconciled entitlement into the App Group (a SERVER-LANE proposal — the
   * native StampPolicy decides; a downgrade over receipt-proven Pro is blocked there, R13). The
   * Safari extension's background pulls the stamp so paid Pro blocking activates in Safari. Call
   * only with server-confirmed values (a cached offline value must not refresh the TTL stamp). */
  async setEntitlement(entitled: boolean): Promise<void> {
    await this.post({ kind: "setEntitlement", entitled });
  }

  /** Modern scoped cache observation. Native commits time/latches under its actual shared lock.
   * A missing/failed host is recovery, never a conclusive never-owned result. No proof is installed
   * or signed by this read, and caller timestamps/flags are not sent. */
  async observeAccess(): Promise<AccessCacheRecord> {
    const reply = asObject(await this.post({ kind: "getAccess" }));
    if (reply?.ok !== true) throw new Error("Native access requires verification");
    return parseAccessCacheRecord(reply.record);
  }

  /** Resolved native projection only. The native host owns account/mapping/trust/time context. */
  async observeBenefits(): Promise<BenefitAccessSnapshot> {
    const reply = asObject(await boundedAccessRead(() => this.post({ kind: "getBenefitAccess" })));
    if (reply?.ok !== true) throw new Error("Native benefit access requires verification");
    return parseBenefitAccessSnapshot(reply.snapshot);
  }

  async setAccountSyncStatus(status: AccountSyncStatus | null): Promise<void> {
    const reply = asObject(await this.post({ kind: "setAccountSyncStatus", status }));
    if (this.available && reply?.ok !== true) throw new Error("Account status could not be saved");
  }

  /** The analytics launch context, or null outside the app or on a malformed reply. */
  async analyticsContext(): Promise<AnalyticsContextReply | null> {
    const o = asObject(await this.post({ kind: "analyticsContext" }));
    if (!o) return null;
    // Validated at the boundary: only Still ids and a version number may reach an event.
    const id = (v: unknown) => (isAnalyticsId(v) ? v : null);
    const version = (v: unknown) => (isVersion(v) ? v : null);
    const platform = o.platform === "ios" || o.platform === "macos" ? o.platform : null;
    const appVersion = version(o.appVersion);
    const installId = id(o.installId);
    const anchorId = id(o.anchorId);
    if (!platform || !appVersion || !installId || !anchorId) return null;
    return {
      platform,
      appVersion,
      installId,
      anchorId,
      created: o.created === true,
      returning: o.returning === true,
      previousVersion: version(o.previousVersion),
      consent: o.consent === true, // fails closed if the field is ever missing
      noticeSeen: o.noticeSeen === true,
      extensionEnabled: typeof o.extensionEnabled === "boolean" ? o.extensionEnabled : null,
      device: isDeviceClass(o.device) ? o.device : null,
    };
  }

  /** Save the app's "Share usage data" switch (the Safari extension follows it). Resolves to the
   * stored value. */
  async setAnalyticsConsent(enabled: boolean): Promise<boolean> {
    const reply = asObject(await this.post({ kind: "setAnalyticsConsent", enabled }));
    return typeof reply?.enabled === "boolean" ? reply.enabled : !enabled;
  }

  async acknowledgeAnalyticsNotice(): Promise<void> {
    await this.post({ kind: "acknowledgeAnalyticsNotice" });
  }

  private async post(message: NativeMessage): Promise<unknown> {
    // No native host (e.g. the bundle opened in a plain browser) → null, so callers degrade rather
    // than throw.
    const port = this.port;
    return port ? port.postMessage(message) : null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value == null || value === "") return null;
  const obj: unknown = typeof value === "string" ? safeParse(value) : value;
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
}

function isOutcome(value: unknown): value is PurchaseOutcome {
  return (
    value === "purchased" ||
    value === "cancelled" ||
    value === "pending" ||
    value === "unavailable" ||
    value === "staleIdentity" ||
    value === "failed"
  );
}
