import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SupabaseBackendPort,
  type CheckoutOperationRecord,
  type CheckoutPendingRecord,
  type ExtensionSession,
  type ExtensionSessionDeps,
  type ExtensionSessionSync,
  type PersistedSlot,
} from "@still/core/sync";
import {
  CHECKOUT_AVAILABLE_ACTION,
  createCheckoutAvailabilityRouter,
  createSessionWithCheckoutAvailability,
  isCheckoutAvailableRequest,
  type CheckoutAvailabilityChrome,
} from "../checkout-availability.js";
import { SESSION_MESSAGE_KIND, createSessionMessageRouter, type SessionMessageListener } from "../session-messages.js";

const ID = "extension-id";
const ORIGIN = "chrome-extension://extension-id/";
const PAGE = { id: ID, url: ORIGIN + "options.html" };
const REQUEST = { kind: SESSION_MESSAGE_KIND, action: CHECKOUT_AVAILABLE_ACTION };

function ask(listener: SessionMessageListener, message: unknown, sender: { id?: string; url?: string; tab?: unknown } = PAGE) {
  return new Promise<{ handled: boolean; response: unknown }>((resolve) => {
    let handled = false;
    handled = listener(message, sender, (response) => resolve({ handled, response }));
    if (!handled) resolve({ handled, response: undefined });
  });
}

function chromeHost() {
  const listeners: SessionMessageListener[] = [];
  const host: CheckoutAvailabilityChrome = {
    runtime: { id: ID, getURL: (path: string) => ORIGIN + path, onMessage: { addListener: (listener) => listeners.push(listener) } },
  };
  return { host, listeners };
}

function slot<T>(initial: unknown = null) {
  const storage = { value: initial, get: vi.fn(async () => storage.value),
    set: vi.fn(async (value: T | null) => { storage.value = value; }) };
  return storage satisfies PersistedSlot<T> & { value: unknown };
}

describe("checkout availability router", () => {
  it("recognizes only the exact request", () => {
    expect(isCheckoutAvailableRequest(REQUEST)).toBe(true);
    expect(isCheckoutAvailableRequest({ ...REQUEST, kind: "reconcile" })).toBe(false);
    expect(isCheckoutAvailableRequest({ kind: SESSION_MESSAGE_KIND, action: "createCheckout" })).toBe(false);
    expect(isCheckoutAvailableRequest(null)).toBe(false);
  });

  it("answers extension pages from the check, and never a content script or another extension", async () => {
    const check = vi.fn(async () => true);
    const router = createCheckoutAvailabilityRouter(check, ID, ORIGIN);
    expect(await ask(router, REQUEST)).toEqual({ handled: true, response: true });
    expect(await ask(router, REQUEST, { id: ID, url: "https://www.youtube.com/", tab: {} })).toEqual({ handled: false, response: undefined });
    expect(await ask(router, REQUEST, { id: "other", url: ORIGIN })).toEqual({ handled: false, response: undefined });
    expect(check).toHaveBeenCalledOnce();
  });

  it.each([[false], [undefined], ["yes"]])("anything but true from the check is no (%j)", async (value) => {
    const router = createCheckoutAvailabilityRouter(async () => value as unknown as boolean, ID, ORIGIN);
    expect((await ask(router, REQUEST)).response).toBe(false);
  });

  it("a failed check is no", async () => {
    const router = createCheckoutAvailabilityRouter(async () => { throw new Error("offline"); }, ID, ORIGIN);
    expect((await ask(router, REQUEST)).response).toBe(false);
  });

  it("is not a session router request, so the two listeners never both answer", async () => {
    const session = { createCheckout: vi.fn() } as unknown as ExtensionSession;
    const sessionRouter = createSessionMessageRouter(session, ID, ORIGIN);
    expect(await ask(sessionRouter, REQUEST)).toEqual({ handled: false, response: undefined });
  });
});

const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPERATION = "11111111-1111-4111-8111-111111111111";

/** The real session over the real sandbox backend port; only the network, storage and browser
 * edges are synthetic (the same harness shape as core's sandbox checkout recovery suite). */
function realSession(options: { completion?: string; fresh?: boolean; read?: "entitled" | "not-entitled" | "unknown" } = {}) {
  let identity: { userId: string; sessionId: string } | null = { userId: ACCOUNT_A, sessionId: "session-a" };
  const { host } = chromeHost();
  const invoke = vi.fn(async (name: string) => ({
    data: name === "qa-sandbox-create-web-checkout" ? { operation_id: OPERATION, status: "session_bound", checkout_url: "https://checkout.stripe.com/c/pay/cs_test_synthetic" }
      : name === "qa-sandbox-complete-web-checkout" ? { operation_id: OPERATION, status: options.completion ?? "session_bound" } : {},
    error: null as unknown,
  }));
  const backend = new SupabaseBackendPort({ functions: { invoke } } as unknown as SupabaseClient, { routeProfile: "shared-hosted-sandbox" });
  // As background.ts does: the scoped reconciler answers the entitlement read.
  const read = vi.fn(async () => options.read ?? "not-entitled");
  backend.reconcileEntitlementChecked = async () => "ok";
  backend.readEntitlement = read;
  const records = {
    getRecord: vi.fn(async () => (options.fresh ? { entitled: false, userId: ACCOUNT_A, updatedAt: Date.now() } : null)),
    setRecord: vi.fn(async () => {}),
  };
  const auth = {
    signInWithMagicLink: vi.fn(async () => ({})), signOut: vi.fn(async () => {}),
    currentUserId: vi.fn(async () => identity?.userId ?? null),
    currentSettingsSession: vi.fn(async () => identity), requestCode: vi.fn(async () => ({ kind: "sent" as const })),
    verifyCode: vi.fn(async () => ({ kind: "verified" as const, userId: identity!.userId })),
  };
  const sync = { onSignedIn: vi.fn(async () => {}), onEntitlementConfirmed: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}), deleteAccount: vi.fn(async () => {}), resume: vi.fn(async () => {}),
    getState: vi.fn(() => ({ confirmed: false })) } as unknown as ExtensionSessionSync;
  const stores = { pendingOtp: slot(null), checkoutPending: slot<CheckoutPendingRecord>(null), nudgeStamp: slot<number>(),
    checkoutOperation: slot<CheckoutOperationRecord>(null) };
  const closeTab = vi.fn(async (_tabId: number) => {});
  const session = createSessionWithCheckoutAvailability({
    auth, backend, records, sync, stores, canCreateCheckout: vi.fn(async () => true),
    identity: { get: async () => ACCOUNT_A, set: async () => {} }, closeTab,
    clearAuthStorage: async () => { identity = null; },
  }, host);
  return { session, stores, closeTab, invoke, records, read, replace(next: typeof identity) { identity = next; } };
}

/** What the settings card does on Buy, through the same session actions its messages reach. */
async function settingsBuy(h: ReturnType<typeof realSession>) {
  expect(await h.session.createCheckout()).toMatchObject({ kind: "checkout-url" });
  await h.session.setCheckoutPending({ startedAt: 1 });
  await h.session.setCheckoutPending({ startedAt: 1, tabId: 41 });
}

describe("a settings-page checkout in the real session", () => {
  it("sign-out closes the checkout tab the settings card opened", async () => {
    const h = realSession();
    await settingsBuy(h);
    await h.session.signOut();
    expect(h.closeTab).toHaveBeenCalledWith(41);
    expect(h.stores.checkoutPending.value).toBeNull();
  });

  it("another account signing in closes that tab before anything of theirs lands", async () => {
    const h = realSession();
    await settingsBuy(h);
    h.replace({ userId: ACCOUNT_B, sessionId: "session-b" });
    await h.session.verifyCode("synthetic@example.invalid", "000000");
    expect(h.closeTab).toHaveBeenCalledWith(41);
    expect(h.stores.checkoutPending.value).toBeNull();
  });

  it("supported-site visits reconcile while it is pending, even with a fresh cached answer", async () => {
    const h = realSession({ fresh: true });
    expect(await h.session.onNudge()).toBe("no-op");
    await settingsBuy(h);
    expect(await h.session.onNudge()).toBe("reconciled");
  });

  it.each(["closed_unpaid", "refunded"])("a checkout that finished %s ends the pending record, so visits stop reconciling", async (completion) => {
    const h = realSession({ fresh: true, completion });
    await settingsBuy(h);
    expect(await h.session.reconcile()).toBe("not-entitled");
    expect(h.stores.checkoutOperation.value).toBeNull();
    expect(h.stores.checkoutPending.value).toBeNull();
    expect(await h.session.onNudge()).toBe("no-op");
  });

  it("paid but the entitlement read failed: the record stays, and visits keep reconciling", async () => {
    const h = realSession({ fresh: true, completion: "access_observed", read: "unknown" });
    await settingsBuy(h);
    expect(await h.session.reconcile()).toBe("unknown");
    expect(h.stores.checkoutOperation.value).toBeNull();
    expect(h.stores.checkoutPending.value).toEqual({ startedAt: 1, tabId: 41 });
    expect(await h.session.onNudge()).toBe("reconciled");
  });

  it("paid and confirmed: the record ends after the entitlement write, as before", async () => {
    const h = realSession({ fresh: true, completion: "access_observed", read: "entitled" });
    await settingsBuy(h);
    expect(await h.session.reconcile()).toBe("entitled");
    expect(h.records.setRecord).toHaveBeenCalledWith(expect.objectContaining({ entitled: true, userId: ACCOUNT_A }));
    expect(h.stores.checkoutPending.value).toBeNull();
  });

  it("a sign-out purge does not end the next account's checkout record early", async () => {
    const h = realSession({ fresh: true });
    await settingsBuy(h);
    await h.session.signOut(); // clears the operation and the record
    h.replace({ userId: ACCOUNT_A, sessionId: "session-a2" });
    await settingsBuy(h);
    expect(await h.session.reconcile()).toBe("not-entitled"); // checkout still open
    expect(h.stores.checkoutPending.value).toEqual({ startedAt: 1, tabId: 41 });
  });

  it("starting another checkout does not end an existing pending record", async () => {
    const h = realSession();
    await h.session.setCheckoutPending({ startedAt: 1, tabId: 40 });
    expect(await h.session.createCheckout()).toMatchObject({ kind: "checkout-url" });
    expect(h.stores.checkoutOperation.value).not.toBeNull();
    expect(h.stores.checkoutPending.value).toEqual({ startedAt: 1, tabId: 40 });
  });

  it("a checkout still open keeps the record", async () => {
    const h = realSession({ fresh: true, completion: "session_bound" });
    await settingsBuy(h);
    await h.session.reconcile();
    expect(h.stores.checkoutPending.value).toEqual({ startedAt: 1, tabId: 41 });
  });
});

describe("createSessionWithCheckoutAvailability", () => {
  function session(userId: string | null): ExtensionSession {
    return { getState: vi.fn(async () => ({ userId, entitled: false, checkoutPending: null, pendingOtp: null })) } as unknown as ExtensionSession;
  }
  const stores = () => ({ pendingOtp: slot(null), checkoutPending: slot(null), nudgeStamp: slot<number>() });

  it("answers from the same canCreateCheckout the session uses, only for a signed-in session", async () => {
    const canCreateCheckout = vi.fn(async () => true);
    const deps = { canCreateCheckout, stores: stores() } as unknown as ExtensionSessionDeps;
    const signedIn = chromeHost();
    const created = session("11111111-1111-4111-8111-111111111111");
    const create = vi.fn(() => created);
    expect(createSessionWithCheckoutAvailability(deps, signedIn.host, create)).toBe(created);
    expect(create).toHaveBeenCalledWith(deps);
    expect((await ask(signedIn.listeners[0]!, REQUEST)).response).toBe(true);
    expect(canCreateCheckout).toHaveBeenCalledOnce();

    const signedOut = chromeHost();
    createSessionWithCheckoutAvailability(deps, signedOut.host, () => session(null));
    expect((await ask(signedOut.listeners[0]!, REQUEST)).response).toBe(false);
    expect(canCreateCheckout).toHaveBeenCalledOnce(); // no policy request for a signed-out page
  });

  it("a route without a sales allowance registers nothing", () => {
    const h = chromeHost();
    createSessionWithCheckoutAvailability({ stores: stores() } as unknown as ExtensionSessionDeps, h.host, () => session("x"));
    expect(h.listeners).toEqual([]);
  });

  it("background.ts picks it only behind the compiled paid switch", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const background = readFileSync(join(root, "entrypoints", "background.ts"), "utf8");
    expect(background).toContain("(PAID_TIER_ENABLED ? createSessionWithCheckoutAvailability : createExtensionSession)({");
  });
});
