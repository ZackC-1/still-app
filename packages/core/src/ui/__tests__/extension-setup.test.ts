import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionUiController, type ExtensionPurchaseDeps } from "../extension-setup.js";
import {
  extensionSupabaseConfig,
  type ExtensionSessionState,
} from "../../sync/extension-session.js";
import type { RequestCodeOutcome, VerifyCodeOutcome, WebCheckoutOutcome } from "../../sync/ports.js";
import type { CheckoutReconcileOutcome } from "../controller.svelte.js";

// Plan U6: the shared extension wiring. The FIRST test is the Safari acceptance pin (AE7/3.1.1):
// no injection → no sign-in, no checkout CTA, no web price — byte-for-byte today's explanatory
// popup. The rest exercise the injected seams (message-closures in real wiring, mocks here) and
// the pure build-mode env gate (fail-safe: absent config disables the spine, never a dev fallback).

type Listener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;

// Minimal in-memory chrome.storage.local + onChanged (the chrome-adapter test pattern) so the
// wiring's SettingsCache/EntitlementCache adapters run without a browser.
function installChrome(initial: Record<string, unknown> = {}): { store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  const listeners = new Set<Listener>();
  const chromeMock = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) {
            const oldValue = store[k];
            store[k] = v;
            for (const l of listeners) l({ [k]: { oldValue, newValue: v } }, "local");
          }
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  return { store };
}

afterEach(() => vi.unstubAllGlobals());

/** Settle the mount microtasks (getState snapshot, hydrations). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const CHECKOUT_URL = "https://pay.rev.cat/tok/user-uuid";

function snapshot(over: Partial<ExtensionSessionState> = {}): ExtensionSessionState {
  return { userId: null, entitled: false, checkoutPending: null, pendingOtp: null, ...over };
}

/** An ext-chromium-shaped injection with in-memory fakes for the message closures. */
function makePurchase(over: { state?: ExtensionSessionState } = {}) {
  const openCheckoutTab = vi.fn((_url: string) => Promise.resolve<number | undefined>(7));
  const reconcile = vi.fn(() => Promise.resolve<CheckoutReconcileOutcome>("unknown"));
  const createCheckout = vi.fn(() =>
    Promise.resolve<WebCheckoutOutcome>({ kind: "checkout-url", url: CHECKOUT_URL }),
  );
  const deps: ExtensionPurchaseDeps = {
    displayPrice: "$1.99",
    getState: vi.fn(() => Promise.resolve(over.state ?? snapshot())),
    auth: {
      requestCode: vi.fn(() => Promise.resolve<RequestCodeOutcome>({ kind: "sent" })),
      verifyCode: vi.fn(() =>
        Promise.resolve<VerifyCodeOutcome>({ kind: "verified", userId: "user-1" }),
      ),
      signOut: vi.fn(() => Promise.resolve()),
      deleteAccount: vi.fn(() => Promise.resolve()),
    },
    persistence: { setPendingOtp: vi.fn(), setPurchaseIntent: vi.fn() },
    checkout: { createCheckout, openCheckoutTab, setPending: vi.fn(), reconcile },
  };
  return { deps, openCheckoutTab, reconcile, createCheckout };
}

describe("createExtensionUiController — no injection (the Safari pin, AE7/3.1.1)", () => {
  it("exposes no auth, no checkout, and no web price", async () => {
    installChrome();
    const c = createExtensionUiController("youtube.com");
    await flush();
    expect(c.host.canPurchase).toBe(false);
    expect(c.canSignIn).toBe(false);
    expect(c.canUseCode).toBe(false);
    expect(c.canWebCheckout).toBe(false);
    expect(c.canDeleteAccount).toBe(false);
    expect(c.paywallPrice).toBeNull();
    // No injected snapshot: the popup boots signed-out with no pending presentations.
    expect(c.userId).toBeNull();
    expect(c.checkoutFlow).toBe("none");
    expect(c.authFlow).toBe("idle");
  });
});

describe("createExtensionUiController — with the ext-chromium injection (plan U6)", () => {
  it("exposes sign-in, web checkout, delete-account, and the host display price", async () => {
    installChrome();
    const { deps } = makePurchase();
    const c = createExtensionUiController("youtube.com", deps);
    await flush();
    expect(c.host.canPurchase).toBe(true);
    expect(c.canSignIn).toBe(true);
    expect(c.canUseCode).toBe(true);
    expect(c.canWebCheckout).toBe(true);
    expect(c.canDeleteAccount).toBe(true);
    expect(c.paywallPrice).toBe("$1.99");
  });

  it("opens the checkout tab with the URL from the checkout outcome", async () => {
    installChrome();
    const { deps, openCheckoutTab } = makePurchase({ state: snapshot({ userId: "user-1" }) });
    const c = createExtensionUiController(undefined, deps);
    await flush();
    await c.startWebCheckout();
    expect(openCheckoutTab).toHaveBeenCalledWith(CHECKOUT_URL);
  });

  it("rehydrates code entry (with purchase intent) from the mount snapshot (AE2/AE1)", async () => {
    installChrome();
    const { deps } = makePurchase({
      state: snapshot({
        pendingOtp: { email: "a@b.co", requestedAt: Date.now(), purchaseIntent: true },
      }),
    });
    const c = createExtensionUiController(undefined, deps);
    await flush();
    expect(c.authFlow).toBe("code-entry");
    expect(c.codeEmail).toBe("a@b.co");
    expect(c.signInOpen).toBe(true);
    expect(c.purchaseIntent).toBe(true);
  });

  it("rehydrates a fresh checkout-pending flag into the checking presentation (U4/R3)", async () => {
    installChrome();
    const { deps, reconcile } = makePurchase({
      state: snapshot({ userId: "user-1", checkoutPending: { startedAt: Date.now() } }),
    });
    const c = createExtensionUiController(undefined, deps);
    await flush();
    expect(c.userId).toBe("user-1");
    expect(c.checkoutFlow).toBe("checking");
    expect(c.paywallOpen).toBe(true);
    // The pending rehydration starts its own fast-poll window — the poll IS the reconcile, so the
    // separate popup-open reconcile must not double-fire on top of it.
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("reconciles once on a signed-in popup open with no pending flag (R4)", async () => {
    installChrome();
    const { deps, reconcile } = makePurchase({ state: snapshot({ userId: "user-1" }) });
    createExtensionUiController(undefined, deps);
    await flush();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("never reconciles on a signed-out open (no session, nothing to check)", async () => {
    installChrome();
    const { deps, reconcile } = makePurchase({ state: snapshot() });
    createExtensionUiController(undefined, deps);
    await flush();
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("extensionSupabaseConfig — the build-mode trust gate (fail-safe)", () => {
  it("returns the config only when BOTH url and anon key are present", () => {
    expect(extensionSupabaseConfig("https://x.supabase.co", "anon-key")).toEqual({
      url: "https://x.supabase.co",
      anonKey: "anon-key",
    });
  });

  it("disables the spine on absent or blank config — never a dev fallback", () => {
    expect(extensionSupabaseConfig(undefined, undefined)).toBeNull();
    expect(extensionSupabaseConfig("https://x.supabase.co", undefined)).toBeNull();
    expect(extensionSupabaseConfig(undefined, "anon-key")).toBeNull();
    expect(extensionSupabaseConfig("", "anon-key")).toBeNull();
    expect(extensionSupabaseConfig("https://x.supabase.co", "")).toBeNull();
    expect(extensionSupabaseConfig("   ", "anon-key")).toBeNull();
    expect(extensionSupabaseConfig("https://x.supabase.co", "  ")).toBeNull();
  });

  it("trims surrounding whitespace from a real value (a padded .env line still works)", () => {
    expect(extensionSupabaseConfig(" https://x.supabase.co ", " anon-key ")).toEqual({
      url: "https://x.supabase.co",
      anonKey: "anon-key",
    });
  });
});
