import type { StillBridgeWindow, StillMessagePort } from "../storage/wkwebview-adapter.js";

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

export interface AppleCredential {
  readonly identityToken: string;
  readonly nonce: string;
  readonly email?: string;
  readonly fullName?: string;
}

export type PurchaseOutcome = "purchased" | "cancelled" | "pending" | "failed";

export interface PurchaseResult {
  readonly outcome: PurchaseOutcome;
  readonly entitled: boolean;
  readonly error?: string;
}

export type NativeMessage =
  | { readonly kind: "signInWithApple" }
  | { readonly kind: "configurePurchases"; readonly appUserID: string }
  | { readonly kind: "purchase" }
  | { readonly kind: "restore" }
  | { readonly kind: "purchaseStatus" };

export class NativeBridge {
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

  /** Key RevenueCat to the signed-in Supabase UUID (KTD5). Call only after a session exists. */
  async configurePurchases(appUserID: string): Promise<void> {
    await this.post({ kind: "configurePurchases", appUserID });
  }

  /** Buy Still Sync natively. `.entitled` unlocks the LOCAL UI; cross-device sync still waits on the
   * RevenueCat→Supabase webhook (U14) and the next reconcile. */
  async purchaseStillSync(): Promise<PurchaseResult> {
    const obj = asObject(await this.post({ kind: "purchase" })) ?? {};
    return {
      outcome: isOutcome(obj.outcome) ? obj.outcome : "failed",
      entitled: obj.entitled === true,
      error: typeof obj.error === "string" ? obj.error : undefined,
    };
  }

  /** Restore purchases; returns whether Still Sync is now active per RevenueCat. */
  async restore(): Promise<boolean> {
    return asObject(await this.post({ kind: "restore" }))?.entitled === true;
  }

  /** Current RevenueCat entitlement (the immediate local-UI gate only). */
  async purchaseStatus(): Promise<boolean> {
    return asObject(await this.post({ kind: "purchaseStatus" }))?.entitled === true;
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
  return value === "purchased" || value === "cancelled" || value === "pending" || value === "failed";
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
