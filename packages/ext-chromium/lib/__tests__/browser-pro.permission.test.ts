import { describe, expect, it, vi } from "vitest";
import { FEATURE_REGISTRY, type AccessState, type BenefitAccessSnapshot } from "@still/shared-types";
import { initialAccessSnapshot, ACCESS_BENEFITS } from "@still/core/entitlement";
import type { AccessRecheck } from "@still/core/ui";
import type { DataPermission, DataPermissionKind } from "@still/core/ui/data-permission";
import type { WebCheckoutOutcome } from "@still/core/sync";
import { createBrowserPro, type BrowserProDeps, type BrowserProState, type ProOwnership } from "../browser-pro.js";

// Firefox: the Still Pro card's Get Still Pro and Restore purchase send the account's purchase
// status, an optional data-collection permission there. Each tap asks first, synchronously and
// before anything is awaited; declined sends nothing and the card says why; the page's own
// re-checks (page shown, signed in, renewals) never ask and are not made without the grant.

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
  const deps: BrowserProDeps = {
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
    permission,
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

describe("Restore purchase on Firefox", () => {
  it("asks inside the tap first, then re-checks the grant before the check", async () => {
    const h = harness(true);
    h.observe("none");
    await settle();
    h.log.length = 0;
    h.flow.restore();
    expect(h.log).toEqual(["ask:purchase"]);
    await settle();
    expect(h.log).toEqual(["ask:purchase", "granted:purchase", "granted:purchase", "recheck"]);
    expect(h.state.restore).toEqual({ state: "nothing" });
    h.flow.stop();
  });

  it("declined: nothing is checked, no sign-in is opened, and the card says why", async () => {
    const h = harness(false);
    h.observe("none", null);
    await settle();
    h.flow.restore();
    await settle();
    expect(h.controller.recheckAccess).not.toHaveBeenCalled();
    expect(h.controller.openSignIn).not.toHaveBeenCalled();
    expect(h.state.restore).toEqual({ state: "permission" });
    h.flow.stop();
  });
});

describe("the page's own re-checks on Firefox", () => {
  it("never ask, and are not made without the grant", async () => {
    const h = harness(false);
    h.observe("none", null);
    h.observe("verify"); // signed in on this page: a re-check would normally run now
    await settle();
    expect(h.permission.ask).not.toHaveBeenCalled();
    expect(h.controller.recheckAccess).not.toHaveBeenCalled();
    h.flow.stop();
  });

  it("are made once the grant is there", async () => {
    const h = harness(true);
    h.observe("none", null);
    h.observe("none");
    await settle();
    expect(h.permission.ask).not.toHaveBeenCalled();
    expect(h.controller.recheckAccess).toHaveBeenCalled();
    h.flow.stop();
  });
});
