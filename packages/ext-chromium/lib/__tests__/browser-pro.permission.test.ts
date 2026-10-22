import { describe, expect, it, vi } from "vitest";
import { FEATURE_REGISTRY, type AccessState, type BenefitAccessSnapshot } from "@still/shared-types";
import { initialAccessSnapshot, ACCESS_BENEFITS } from "@still/core/entitlement";
import type { AccessRecheck } from "@still/core/ui";
import type { DataPermission, DataPermissionKind } from "@still/core/ui/data-permission";
import type { WebCheckoutOutcome } from "@still/core/sync";
import { createBrowserPro, type BrowserProDeps, type BrowserProState, type ProOwnership } from "../browser-pro.js";

// Firefox: Get Still Pro starts a checkout for the account, which sends purchase data, an optional
// data-collection permission there. Its tap (and Try again's) asks first, synchronously and before
// anything is awaited; declined starts nothing and the card says why. Restore purchase and the page's
// own re-checks (page shown, signed in, renewals) only receive the account's Still Pro status, so
// they never ask and never wait on the grant: Still Pro cannot lock for want of it.

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

function access(state: AccessState): BenefitAccessSnapshot {
  const value = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  return {
    ...value,
    states: Object.fromEntries(
      Object.entries(value.states).map(([id, prior]) => [
        id,
        FEATURE_REGISTRY.some((row) => row.id === id && row.tier === "pro") ? state : prior,
      ]),
    ) as BenefitAccessSnapshot["states"],
  };
}

function harness(initiallyGranted: boolean) {
  const log: string[] = [];
  let granted = initiallyGranted;
  const permission: DataPermission = {
    ask: vi.fn((kind: DataPermissionKind) => {
      log.push(`ask:${kind}`);
      return Promise.resolve(granted);
    }),
    granted: vi.fn((kind: DataPermissionKind) => {
      log.push(`granted:${kind}`);
      return Promise.resolve(granted);
    }),
  };
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
  };
  const quiet = { addEventListener: () => {}, removeEventListener: () => {} };
  const controller = {
    userId: ACCOUNT as string | null,
    signInOpen: false,
    canSignIn: true,
    openSignIn: vi.fn(),
    recheckAccess: vi.fn(async (): Promise<AccessRecheck> => {
      log.push("recheck");
      return { access: access("locked"), outcome: "not-entitled" };
    }),
  };
  const checkout = {
    createCheckout: vi.fn(async (): Promise<WebCheckoutOutcome> => {
      log.push("createCheckout");
      return { kind: "checkout-url", url: "https://checkout.invalid/x" };
    }),
    openCheckoutTab: vi.fn(async () => 7),
  };
  let record: { startedAt?: number; tabId?: number } | null = null;
  const pending = {
    read: vi.fn(async () => {
      log.push("pending.read");
      return record;
    }),
    write: vi.fn(async (value: { startedAt?: number; tabId?: number } | null) => {
      record = value;
    }),
  };
  const tabs = { focus: vi.fn(async () => false), remember: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const states: BrowserProState[] = [];
  const analytics = { track: vi.fn() };
  const deps: BrowserProDeps = {
    analytics,
    controller,
    checkout,
    available: async () => true,
    pending,
    tabs,
    permission,
    page: page as unknown as BrowserProDeps["page"],
    focus: quiet as unknown as BrowserProDeps["focus"],
    network: quiet as unknown as BrowserProDeps["network"],
    online: () => true,
    now: () => 1_000_000,
  };
  const flow = createBrowserPro(deps, (state) => states.push(state));
  return {
    flow,
    log,
    page,
    listeners,
    permission,
    analytics,
    controller,
    checkout,
    get state() {
      return flow.state;
    },
    grant(next: boolean) {
      granted = next;
    },
    observe(ownership: ProOwnership, userId: string | null = ACCOUNT) {
      controller.userId = userId;
      flow.observe({ userId, signInOpen: controller.signInOpen, ownership });
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

describe("Get Still Pro on Firefox", () => {
  it("asks inside the tap before anything is awaited, then starts the checkout", async () => {
    const h = harness(true);
    h.observe("none");
    await settle();
    h.log.length = 0;
    h.flow.buy();
    expect(h.log).toEqual(["ask:purchase"]);
    await settle();
    expect(h.log).toContain("createCheckout");
    expect(h.state.purchase).toBe("waiting");
    h.flow.stop();
  });

  it("declined: no checkout is created and the card says Still Pro needs permission", async () => {
    const h = harness(false);
    h.observe("none");
    await settle();
    h.flow.buy();
    await settle();
    expect(h.checkout.createCheckout).not.toHaveBeenCalled();
    expect(h.state.purchase).toBe("idle");
    expect(h.state.restore).toEqual({ state: "permission" });
    h.flow.stop();
  });

  it("Try again asks first, inside its own tap", async () => {
    const h = harness(true);
    h.checkout.createCheckout.mockResolvedValueOnce({ kind: "unavailable" });
    h.observe("none");
    await settle();
    h.flow.buy();
    await settle();
    expect(h.state.purchase).toBe("failed");
    h.log.length = 0;
    h.flow.retry();
    expect(h.log).toEqual(["ask:purchase"]);
    await settle();
    expect(h.checkout.createCheckout).toHaveBeenCalledTimes(2);
    // The retry's own ask covers its checkout: no second ask after the awaits.
    expect(h.log.filter((entry) => entry.startsWith("ask:"))).toEqual(["ask:purchase"]);
    h.flow.stop();
  });
});

describe("the declined line on the Pro card", () => {
  it("goes with the account: a sign-out or an account switch clears it", async () => {
    const h = harness(false);
    h.observe("none");
    await settle();
    h.flow.buy();
    await settle();
    expect(h.state.restore).toEqual({ state: "permission" });
    h.observe("none", null); // signed out
    await settle();
    expect(h.state.restore).toBeUndefined();
    h.observe("none", "22222222-2222-4222-8222-222222222222");
    await settle(); // the new account's "may I offer Buy?" answer
    h.flow.buy();
    await settle();
    expect(h.state.restore).toEqual({ state: "permission" });
    h.observe("none", ACCOUNT); // another account
    await settle();
    expect(h.state.restore).toBeUndefined();
    h.flow.stop();
  });
});

describe("a purchase waiting in its checkout tab", () => {
  it("still settles when the purchase grant is withdrawn meanwhile (re-checks never wait on it)", async () => {
    const h = harness(true);
    h.observe("none");
    await settle();
    h.flow.buy();
    await settle();
    expect(h.state.purchase).toBe("waiting");
    h.grant(false); // withdrawn in about:addons while the checkout tab is open
    h.page.visibilityState = "hidden";
    for (const listener of [...h.listeners]) listener();
    h.page.visibilityState = "visible";
    for (const listener of [...h.listeners]) listener();
    await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalled();
    expect(h.state.purchase).toBe("idle");
    h.flow.stop();
  });
});

describe("Restore analytics on Firefox", () => {
  const restoreEvents = (h: ReturnType<typeof harness>) =>
    h.analytics.track.mock.calls.filter(([name]) => String(name).startsWith("restore_"));

  it("are not sent without the purchase grant (\"restored\" would reveal Still Pro ownership)", async () => {
    const h = harness(false);
    h.observe("none");
    await settle();
    h.flow.restore();
    await settle();
    expect(h.state.restore).toEqual({ state: "nothing" }); // the restore itself still runs
    expect(restoreEvents(h)).toEqual([]);
    h.flow.stop();
  });

  it("are sent as before with the grant", async () => {
    const h = harness(true);
    h.observe("none");
    await settle();
    h.flow.restore();
    await settle();
    expect(restoreEvents(h)).toEqual([
      ["restore_started", { purchase_origin: "web" }],
      ["restore_completed", { purchase_origin: "web", outcome: "nothing_to_restore" }],
    ]);
    h.flow.stop();
  });
});

describe("Restore purchase on Firefox", () => {
  it("checks without the purchase grant and without asking", async () => {
    const h = harness(false);
    h.observe("none");
    await settle();
    h.log.length = 0;
    h.flow.restore();
    await settle();
    expect(h.log).toContain("recheck");
    expect(h.log.some((entry) => entry.startsWith("ask:"))).toBe(false);
    expect(h.state.restore).toEqual({ state: "nothing" });
    h.flow.stop();
  });

  it("signed out, opens the normal sign-in, then checks, still without asking", async () => {
    const h = harness(false);
    h.observe("none", null);
    await settle();
    h.flow.restore();
    expect(h.controller.openSignIn).toHaveBeenCalledOnce();
    h.observe("none");
    await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalled();
    expect(h.permission.ask).not.toHaveBeenCalled();
    h.flow.stop();
  });
});

describe("the page's own re-checks on Firefox", () => {
  it("run without the purchase grant, never ask and never read the grant (Still Pro never locks for want of it)", async () => {
    const h = harness(false);
    h.observe("none", null);
    h.observe("verify"); // signed in on this page: a re-check runs now
    await settle();
    expect(h.controller.recheckAccess).toHaveBeenCalled();
    expect(h.permission.ask).not.toHaveBeenCalled();
    expect(h.permission.granted).not.toHaveBeenCalled();
    h.flow.stop();
  });
});
