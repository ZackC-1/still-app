import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionSession, ExtensionSessionDeps } from "@still/core/sync";
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

describe("createSessionWithCheckoutAvailability", () => {
  function host() {
    const listeners: SessionMessageListener[] = [];
    const chromeHost: CheckoutAvailabilityChrome = {
      runtime: { id: ID, getURL: (path: string) => ORIGIN + path, onMessage: { addListener: (listener) => listeners.push(listener) } },
    };
    return { chromeHost, listeners };
  }
  function session(userId: string | null): ExtensionSession {
    return { getState: vi.fn(async () => ({ userId, entitled: false, checkoutPending: null, pendingOtp: null })) } as unknown as ExtensionSession;
  }

  it("answers from the same canCreateCheckout the session uses, only for a signed-in session", async () => {
    const canCreateCheckout = vi.fn(async () => true);
    const deps = { canCreateCheckout } as unknown as ExtensionSessionDeps;
    const signedIn = host();
    const created = session("11111111-1111-4111-8111-111111111111");
    const create = vi.fn(() => created);
    expect(createSessionWithCheckoutAvailability(deps, signedIn.chromeHost, create)).toBe(created);
    expect(create).toHaveBeenCalledWith(deps);
    expect((await ask(signedIn.listeners[0]!, REQUEST)).response).toBe(true);
    expect(canCreateCheckout).toHaveBeenCalledOnce();

    const signedOut = host();
    createSessionWithCheckoutAvailability(deps, signedOut.chromeHost, () => session(null));
    expect((await ask(signedOut.listeners[0]!, REQUEST)).response).toBe(false);
    expect(canCreateCheckout).toHaveBeenCalledOnce(); // no policy request for a signed-out page
  });

  it("a route without a sales allowance registers nothing", () => {
    const h = host();
    createSessionWithCheckoutAvailability({} as ExtensionSessionDeps, h.chromeHost, () => session("x"));
    expect(h.listeners).toEqual([]);
  });

  it("background.ts picks it only behind the compiled paid switch", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const background = readFileSync(join(root, "entrypoints", "background.ts"), "utf8");
    expect(background).toContain("(PAID_TIER_ENABLED ? createSessionWithCheckoutAvailability : createExtensionSession)({");
  });
});
