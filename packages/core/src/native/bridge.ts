import { PAID_ACCESS_WINDOW_MS, type BenefitAccessSnapshot } from "@still/shared-types";
import { boundedAccessRead, parseBenefitAccessSnapshot } from "../entitlement/access-policy.js";
import type { AccountSyncStatus } from "../sync/account-status.js";
import type { StillBridgeWindow, StillMessagePort } from "../storage/wkwebview-adapter.js";
import { safeParse } from "../storage/settings-validation.js";
import { isDeviceClass, isVersion, type AnalyticsDevice } from "../analytics/events.js";
import { isAnalyticsId } from "../analytics/identity.js";
import { readAnalyticsPermission, type AnalyticsPermission } from "../analytics/consent.js";
import { parseAccessCacheRecord, type AccessCacheRecord } from "../entitlement/access-record.js";
import { isAccessUUID, isSafeAccessInteger } from "../entitlement/access-proof.js";

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
//   openDestination    → { ok: true, destination } | rejected (see openNativeDestination; not a
//                        NativeBridge method, so builds that never open anything stay unchanged)
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

/** Native store metadata for the one approved lifetime tuple; never an access grant. */
export interface NativeLifetimeOffering {
  readonly productId: "still_pro_v3";
  readonly offeringId: "still_pro_v3";
  readonly packageId: "$rc_lifetime";
  readonly package: "still-pro-v3";
  readonly kind: "lifetime";
  readonly price: string;
  readonly currencyCode: string;
}

export type NativeProOutcome =
  | "purchased" | "restored" | "cancelled" | "pending" | "unavailable"
  | "staleIdentity" | "nothing" | "failed";

/** Local verified store feedback. Scoped account/local proof is a separate authority. */
export interface NativeProResult {
  readonly outcome: NativeProOutcome;
  readonly receipt: ReceiptStatusValue;
  readonly productId?: "still_pro_v3" | "still_sync";
}

/** Sensitive functional evidence for the authenticated verifier only; never analytics or logs. */
export interface NativeApplePurchaseEvidence {
  readonly productId: "still_pro_v3" | "still_sync";
  readonly bundleId: string;
  readonly signedTransaction: string;
}

/** Signed functional evidence only. Native independently verifies the current StoreKit holder. */
export interface NativeAppleAccessInstall {
  readonly nativeBinding: string;
  readonly localProof: string;
  readonly issuerTime: number;
  readonly accountProof?: string;
  /** Used transiently by native's compiled auth endpoint; never stored or logged. */
  readonly accessToken?: string;
}
export interface NativeAccountAccessCommit {
  readonly schema: 1;
  readonly status: "committed";
  readonly generation: number;
  readonly accountId: string;
  readonly sessionId: string;
  readonly issuerTime: number;
  readonly proofIdentities: readonly string[];
}
export interface NativeAppleAccessCommit {
  readonly schema: 1;
  readonly status: "committed";
  readonly generation: number;
  readonly localRight: string;
  readonly ownershipRevision: number;
  readonly verifiedAt: number;
  readonly expiresAt: number;
  readonly localProofIdentity: string;
  readonly accountProofIdentity: string | null;
}
export interface NativeAppleAccessRight {
  readonly localRight: string;
  readonly ownershipRevision: number;
  readonly verifiedAt: number;
  readonly expiresAt: number;
  readonly localProofIdentity: string;
  readonly status: "purchased" | "verification_required";
}
export interface NativeAppleAccessObservation {
  readonly schema: 1;
  readonly generation: number;
  readonly rights: readonly NativeAppleAccessRight[];
}
const APPLE_ACCESS_IDENTITY = /^[a-z0-9][a-z0-9._-]{0,95}:[0-9a-f]{128}$/;
export function parseNativeAppleAccessCommit(value: unknown): NativeAppleAccessCommit {
  const r = asObject(value);
  if (!r || Object.keys(r).sort().join(",") !== "accountProofIdentity,expiresAt,generation,localProofIdentity,localRight,ownershipRevision,schema,status,verifiedAt" ||
    r.schema !== 1 || r.status !== "committed" || !isAccessUUID(r.localRight) ||
    ![r.generation, r.ownershipRevision, r.verifiedAt, r.expiresAt].every(isSafeAccessInteger) ||
    (r.expiresAt as number) - (r.verifiedAt as number) !== PAID_ACCESS_WINDOW_MS ||
    typeof r.localProofIdentity !== "string" || !APPLE_ACCESS_IDENTITY.test(r.localProofIdentity) ||
    !(r.accountProofIdentity === null || (typeof r.accountProofIdentity === "string" && APPLE_ACCESS_IDENTITY.test(r.accountProofIdentity)))) {
    throw new Error("Native Apple access commit requires verification");
  }
  return r as unknown as NativeAppleAccessCommit;
}

export const NATIVE_PURCHASE_DEADLINE_MS = 150_000;
export const STILL_PRO_APP_URL = "still://pro";
export interface NativeAppRoute { readonly route: "pro"; readonly revision: number }

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

/** Null permission is a successfully observed legacy/unasked slot; null observation is failure. */
export interface AnalyticsPermissionObservation {
  readonly permission: AnalyticsPermission | false | null;
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

/** The fixed places native may open for the web view (NativeOpenDestination.swift). The names
 * match `SafariSetupObservation.enableLocation`. macOS opens Safari's Extensions settings and
 * Safari; iOS opens only Still's page in the Settings app. */
export type NativeOpenDestination =
  | "safariExtensionSettings"
  | "settingsAppStillPage"
  | "safari";

const NATIVE_OPEN_DESTINATIONS: readonly NativeOpenDestination[] = [
  "safariExtensionSettings",
  "settingsAppStillPage",
  "safari",
];

export interface OpenNativeDestinationOptions {
  /** The host window (default: globalThis). */
  readonly win?: StillBridgeWindow;
  /** The page's user activation (default: navigator.userActivation, where WebKit has it). */
  readonly userActivation?: { readonly isActive?: boolean } | null;
  readonly deadlineMs?: number;
}

/**
 * Ask native to open one fixed destination, from a tap. Posts exactly
 * `{ kind: "openDestination", destination }`: nothing else, and never a URL. Resolves true only
 * for `{ ok: true, destination: <the same one> }` within the deadline; no host, an unknown
 * destination, a page without user activation (where WebKit reports it), a refusal, a malformed
 * reply or a late one are all false, and nothing is posted for the first three.
 *
 * Native re-checks everything that matters (bundled main frame, platform support, app active);
 * WebKit gives native no gesture flag, so the activation check lives here.
 *
 * A standalone function, not a NativeBridge method: the class is in every Apple web bundle and a
 * method is never tree-shaken, while this is reachable only from the D12 onboarding wiring.
 */
export function openNativeDestination(
  destination: NativeOpenDestination,
  options: OpenNativeDestinationOptions = {},
): Promise<boolean> {
  if (!NATIVE_OPEN_DESTINATIONS.includes(destination)) return Promise.resolve(false);
  const activation =
    options.userActivation !== undefined
      ? options.userActivation
      : (globalThis.navigator as { userActivation?: { isActive?: boolean } } | undefined)
          ?.userActivation;
  if (activation && activation.isActive !== true) return Promise.resolve(false);
  const win = options.win ?? (globalThis as unknown as StillBridgeWindow);
  const port = win.webkit?.messageHandlers?.still ?? null;
  if (!port) return Promise.resolve(false);
  const message: NativeMessage = { kind: "openDestination", destination };
  return boundedNativeRead(
    async () => {
      const obj = asObject(await port.postMessage(message));
      return (
        !!obj && !Array.isArray(obj) && obj.ok === true && obj.destination === destination
      );
    },
    false,
    options.deadlineMs ?? NATIVE_READ_DEADLINE_MS,
  );
}

export type NativeMessage =
  | { readonly kind: "safariSetupState" }
  | { readonly kind: "openDestination"; readonly destination: NativeOpenDestination }
  | { readonly kind: "onboardingState" }
  | { readonly kind: "completeOnboarding" }
  | { readonly kind: "signInWithApple" }
  | { readonly kind: "configurePurchases"; readonly appUserID: string }
  | { readonly kind: "purchase" }
  | { readonly kind: "proOffering" }
  | { readonly kind: "purchasePro"; readonly offer: NativeLifetimeOffering }
  | { readonly kind: "restorePro" }
  | { readonly kind: "applePurchaseEvidence" }
  | { readonly kind: "appleLocalPurchaseEvidence" }
  | ({ readonly kind: "installAppleAccess" } & NativeAppleAccessInstall)
  | { readonly kind: "reconcileAccountAccess"; readonly accessToken: string }
  | { readonly kind: "observeAppleAccess" }
  | { readonly kind: "observeAppleLinkAccess" }
  | { readonly kind: "pendingAppRoute" }
  | { readonly kind: "acknowledgeAppRoute"; readonly revision: number }
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
  private analyticsPermissionReadGeneration = 0;
  private analyticsPermissionWriteGeneration = 0;
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
   * swap, or when a newer read was started. Callers bound it with `boundedNativeRead`.
   *
   * `answered` cannot tell an answer to the older 2.1 usage switch from an answer to the new
   * combined email-plus-usage question (owner decision 21): never link email from it alone. */
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

  /** Read only the combined permission slot; this never asks native to create analytics ids. */
  async observeAnalyticsPermission(): Promise<AnalyticsPermissionObservation | null> {
    const generation = ++this.analyticsPermissionReadGeneration;
    const write = this.analyticsPermissionWriteGeneration;
    const port = this.port;
    if (!port) return null;
    try {
      const reply = await port.postMessage({ kind: "analyticsPermission" });
      if (
        generation !== this.analyticsPermissionReadGeneration ||
        write !== this.analyticsPermissionWriteGeneration ||
        port !== this.port
      )
        return null;
      const obj = asObject(reply);
      if (
        !obj ||
        Array.isArray(obj) ||
        Object.keys(obj).length !== 2 ||
        obj.ok !== true
      )
        return null;
      if (obj.permission === null || obj.permission === false) return { permission: obj.permission };
      const permission = readAnalyticsPermission(obj.permission);
      return permission ? { permission } : null;
    } catch {
      return null;
    }
  }

  /** Existing consent authority's storage write, acknowledged from native committed readback. */
  async commitAnalyticsPermission(
    value: AnalyticsPermission | false,
  ): Promise<boolean> {
    const wanted = value === false ? false : readAnalyticsPermission(value);
    if (wanted === null) return false;
    const generation = ++this.analyticsPermissionWriteGeneration;
    this.analyticsPermissionReadGeneration += 1;
    const port = this.port;
    if (!port) return false;
    try {
      const reply = await port.postMessage({
        kind: "commitAnalyticsPermission",
        permission: wanted,
      });
      if (
        generation !== this.analyticsPermissionWriteGeneration ||
        port !== this.port
      )
        return false;
      const obj = asObject(reply);
      if (
        !obj ||
        Array.isArray(obj) ||
        Object.keys(obj).length !== 2 ||
        obj.ok !== true
      )
        return false;
      const stored =
        obj.permission === null
          ? null
          : readAnalyticsPermission(obj.permission);
      if (wanted === false)
        return obj.permission === false || stored?.state === "stopped";
      return (
        stored !== null && JSON.stringify(stored) === JSON.stringify(wanted)
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

  async proOffering(): Promise<NativeLifetimeOffering | null> {
    const reply = asObject(await boundedNativeRead(() => this.post({ kind: "proOffering" }), null));
    return parseLifetimeOffering(reply?.offer);
  }

  async purchasePro(offer: NativeLifetimeOffering): Promise<NativeProResult> {
    const validated = parseLifetimeOffering(offer);
    if (!validated || !this.available) return { outcome: "unavailable", receipt: "noSignal" };
    return parseProResult(await boundedNativeRead(
      () => this.post({ kind: "purchasePro", offer: validated }),
      { outcome: "pending", receipt: "noSignal" }, NATIVE_PURCHASE_DEADLINE_MS,
    ));
  }

  async restorePro(): Promise<NativeProResult> {
    if (!this.available) return { outcome: "unavailable", receipt: "noSignal" };
    return parseProResult(await boundedNativeRead(
      () => this.post({ kind: "restorePro" }),
      { outcome: "failed", receipt: "noSignal" }, NATIVE_PURCHASE_DEADLINE_MS,
    ));
  }

  async applePurchaseEvidence(): Promise<NativeApplePurchaseEvidence | null> {
    return this.readApplePurchaseEvidence("applePurchaseEvidence");
  }

  async appleLocalPurchaseEvidence(): Promise<NativeApplePurchaseEvidence | null> {
    return this.readApplePurchaseEvidence("appleLocalPurchaseEvidence");
  }

  private async readApplePurchaseEvidence(kind: "applePurchaseEvidence" | "appleLocalPurchaseEvidence"): Promise<NativeApplePurchaseEvidence | null> {
    const reply = asObject(await boundedNativeRead(() => this.post({ kind }), null, 10_000));
    const value = asObject(reply?.evidence);
    if (!value || Object.keys(value).sort().join(",") !== "bundleId,productId,signedTransaction" ||
      (value.productId !== "still_pro_v3" && value.productId !== "still_sync") ||
      typeof value.bundleId !== "string" || !value.bundleId || value.bundleId.length > 255 ||
      typeof value.signedTransaction !== "string" || value.signedTransaction.length > 65_536 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.signedTransaction)) return null;
    return { productId: value.productId, bundleId: value.bundleId, signedTransaction: value.signedTransaction };
  }

  async pendingAppRoute(): Promise<NativeAppRoute | null> {
    const reply = asObject(await boundedNativeRead(() => this.post({ kind: "pendingAppRoute" }), null));
    const pending = asObject(reply?.pending);
    if (!pending || Object.keys(pending).sort().join(",") !== "revision,route" || pending.route !== "pro" ||
      typeof pending.revision !== "number" || !Number.isSafeInteger(pending.revision) || pending.revision < 0) return null;
    return { route: "pro", revision: pending.revision };
  }

  async acknowledgeAppRoute(revision: number): Promise<boolean> {
    if (!Number.isSafeInteger(revision) || revision < 0) return false;
    const reply = asObject(await boundedNativeRead(() => this.post({ kind: "acknowledgeAppRoute", revision }), null));
    return reply?.ok === true && reply.revision === revision;
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

  /** Native independently obtains the server snapshot; JS supplies no proof, removal or endpoint. */
  async reconcileAccountAccess(accessToken: string): Promise<NativeAccountAccessCommit> {
    if (typeof accessToken !== "string" || !accessToken || new TextEncoder().encode(accessToken).length > 16384) {
      throw new Error("Invalid account access token");
    }
    const result = asObject(await boundedNativeRead(
      () => this.post({ kind: "reconcileAccountAccess", accessToken }), null, 30_000,
    ));
    if (!result || Array.isArray(result) || Object.keys(result).sort().join(",") !==
      "accountId,generation,issuerTime,proofIdentities,schema,sessionId,status" || result.schema !== 1 ||
      result.status !== "committed" || !isSafeAccessInteger(result.generation) ||
      !isSafeAccessInteger(result.issuerTime) || !isAccessUUID(result.accountId) || !isAccessUUID(result.sessionId) ||
      !Array.isArray(result.proofIdentities) || result.proofIdentities.length > 16 ||
      result.proofIdentities.some(value => typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}:[0-9a-f]{128}$/.test(value)) ||
      new Set(result.proofIdentities).size !== result.proofIdentities.length) {
      throw new Error("Native account access requires verification");
    }
    return result as unknown as NativeAccountAccessCommit;
  }

  async installAppleAccess(value: NativeAppleAccessInstall): Promise<NativeAppleAccessCommit> {
    const linked = value.accountProof !== undefined || value.accessToken !== undefined;
    const expected = ["issuerTime", "localProof", "nativeBinding", ...(linked ? ["accountProof", "accessToken"] : [])].sort().join(",");
    if (Object.keys(value).sort().join(",") !== expected || !isSafeAccessInteger(value.issuerTime) ||
      ![value.nativeBinding, value.localProof].every(v => typeof v === "string" && v.length > 0 && v.length <= 6144) ||
      (linked && !(typeof value.accountProof === "string" && value.accountProof.length > 0 && value.accountProof.length <= 6144 &&
        typeof value.accessToken === "string" && value.accessToken.length > 0 && value.accessToken.length <= 16384))) {
      throw new Error("Invalid native Apple access installation");
    }
    const result = parseNativeAppleAccessCommit(await boundedNativeRead(
      () => this.post({ kind: "installAppleAccess", ...value }), null, 30_000,
    ));
    if (result.verifiedAt !== value.issuerTime || linked !== (result.accountProofIdentity !== null)) {
      throw new Error("Mismatched native Apple access commit");
    }
    return result;
  }

  async observeAppleAccess(): Promise<NativeAppleAccessObservation> {
    return this.readAppleAccess("observeAppleAccess");
  }

  /** Native filters signed local bindings against current independently verified purchaser identity. */
  async observeAppleLinkAccess(): Promise<NativeAppleAccessObservation> {
    return this.readAppleAccess("observeAppleLinkAccess");
  }

  private async readAppleAccess(kind: "observeAppleAccess" | "observeAppleLinkAccess"): Promise<NativeAppleAccessObservation> {
    const r = asObject(await boundedAccessRead(() => this.post({ kind })));
    if (!r || Object.keys(r).sort().join(",") !== "generation,rights,schema" || r.schema !== 1 ||
      !isSafeAccessInteger(r.generation) || !Array.isArray(r.rights) || r.rights.length > 32) {
      throw new Error("Native Apple access observation requires verification");
    }
    const rights = r.rights.map(value => {
      const right = asObject(value);
      if (!right || Object.keys(right).sort().join(",") !== "expiresAt,localProofIdentity,localRight,ownershipRevision,status,verifiedAt" ||
        !["purchased", "verification_required"].includes(right.status as string)) {
        throw new Error("Invalid native Apple right observation");
      }
      parseNativeAppleAccessCommit({ ...right, schema: 1, status: "committed", generation: r.generation, accountProofIdentity: null });
      return right as unknown as NativeAppleAccessRight;
    });
    if (new Set(rights.map(r => r.localRight)).size !== rights.length) throw new Error("Duplicate native Apple right");
    return { schema: 1, generation: r.generation, rights };
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

function parseLifetimeOffering(raw: unknown): NativeLifetimeOffering | null {
  const value = asObject(raw);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !==
    "currencyCode,kind,offeringId,package,packageId,price,productId" ||
    value.productId !== "still_pro_v3" || value.offeringId !== "still_pro_v3" ||
    value.packageId !== "$rc_lifetime" || value.package !== "still-pro-v3" ||
    value.kind !== "lifetime" || typeof value.price !== "string" || !value.price.trim() ||
    typeof value.currencyCode !== "string" || !/^[A-Z]{3}$/.test(value.currencyCode)) return null;
  return { productId: "still_pro_v3", offeringId: "still_pro_v3", packageId: "$rc_lifetime",
    package: "still-pro-v3", kind: "lifetime", price: value.price, currencyCode: value.currencyCode };
}

function parseProResult(raw: unknown): NativeProResult {
  const value = asObject(raw);
  const failed: NativeProResult = { outcome: "failed", receipt: "noSignal" };
  if (!value || Array.isArray(value) || Object.keys(value).some((key) =>
    !["outcome", "receipt", "productId"].includes(key))) return failed;
  const outcomes: readonly NativeProOutcome[] = ["purchased", "restored", "cancelled", "pending",
    "unavailable", "staleIdentity", "nothing", "failed"];
  if (!outcomes.includes(value.outcome as NativeProOutcome) ||
    !["entitled", "verifiedNotEntitled", "noSignal"].includes(value.receipt as string)) return failed;
  const receipt = value.receipt as ReceiptStatusValue;
  const productId = value.productId === "still_pro_v3" || value.productId === "still_sync" ? value.productId : undefined;
  if (value.productId !== undefined && !productId) return failed;
  let outcome = value.outcome as NativeProOutcome;
  if ((outcome === "purchased" || outcome === "restored") &&
    (receipt !== "entitled" || !productId || (outcome === "purchased" && productId !== "still_pro_v3"))) outcome = "pending";
  if (outcome === "nothing" && receipt === "entitled") return failed;
  return { outcome, receipt, ...(productId ? { productId } : {}) };
}
