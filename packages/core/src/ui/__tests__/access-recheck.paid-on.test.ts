import { describe, expect, it, vi } from "vitest";

// The committed page's access re-check exists only with the paid tier compiled on.
vi.mock("@still/shared-types", async (original) => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));

import { FEATURE_REGISTRY, type AccessState, type BenefitAccessSnapshot } from "@still/shared-types";
import { ACCESS_BENEFITS, initialAccessSnapshot } from "../../entitlement/index.js";
import { createExtensionUiController } from "../extension-setup.js";
import type { CheckoutReconcileOutcome } from "../controller.svelte.js";
import { browser, flush, gate, purchase, stops } from "./committed-popup-host.fixtures.js";

function access(state: AccessState): BenefitAccessSnapshot {
  const value = initialAccessSnapshot({ paidMode: true, supported: new Set(ACCESS_BENEFITS) });
  return { ...value, states: Object.fromEntries(Object.entries(value.states).map(([id, prior]) =>
    [id, FEATURE_REGISTRY.some(row => row.id === id && row.tier === "pro") ? state : prior])) as BenefitAccessSnapshot["states"] };
}

async function page(options: { userId?: string | null; committed?: boolean } = {}) {
  const f = await browser();
  const events: string[] = [];
  let snapshot = access("verification_required");
  const original = chrome.runtime.sendMessage;
  Object.assign(chrome.runtime, {
    sendMessage: vi.fn(async (message: { kind?: string }) => {
      if (message.kind === "observeBenefits") { events.push(`observe:${snapshot.states["youtube.comments"]}`); return { ok: true, snapshot }; }
      return original(message);
    }),
  });
  const p = purchase();
  let reconcileGate: Promise<void> | null = null;
  const reconcile = vi.fn(async (): Promise<CheckoutReconcileOutcome> => {
    events.push("reconcile");
    if (reconcileGate) await reconcileGate;
    snapshot = access("locked");
    return "not-entitled";
  });
  const deps = {
    ...p.deps,
    getState: async () => ({ userId: options.userId === undefined ? "synthetic-account" : options.userId, entitled: false, pendingOtp: null, checkoutPending: null }),
    checkout: { ...p.deps.checkout, reconcile },
  };
  let binding: { current(): { access: BenefitAccessSnapshot }; stop(): void } | undefined;
  const controller = createExtensionUiController(deps, {
    accessHost: "chromium",
    onCommittedPopupBinding: options.committed === false ? undefined : (b) => { binding = b; stops.push(() => b.stop()); },
  });
  stops.push(() => controller.dispose());
  return { f, events, reconcile, controller, binding: () => binding!, hold(g: Promise<void>) { reconcileGate = g; } };
}

describe("committed paid page access re-check", () => {
  it("re-checks on open and reads access again after the reconcile, so a known none shows", async () => {
    const h = await page();
    await vi.waitFor(() => expect(h.binding().current().access.states["youtube.comments"]).toBe("locked"));
    expect(h.reconcile).toHaveBeenCalledOnce();
    const reconcileAt = h.events.indexOf("reconcile");
    expect(h.events.slice(reconcileAt + 1)).toContain("observe:locked");
  });

  it("shares one flight between the page-open check and the page's own request", async () => {
    const g = gate();
    const h = await page({ userId: null });
    h.hold(g.promise);
    const first = h.controller.recheckAccess!();
    const second = h.controller.recheckAccess!();
    expect(second).toBe(first);
    g.open();
    const result = await first;
    expect(result.outcome).toBe("not-entitled");
    expect(result.access.states["youtube.comments"]).toBe("locked");
    expect(h.reconcile).toHaveBeenCalledOnce();
    // A later request is a new flight.
    await h.controller.recheckAccess!();
    expect(h.reconcile).toHaveBeenCalledTimes(2);
  });

  it("signed out at open, nothing reconciles", async () => {
    const h = await page({ userId: null });
    await flush(); await flush();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("an uncommitted page gets no re-check capability", async () => {
    const h = await page({ committed: false });
    await flush();
    expect(h.controller.recheckAccess).toBeUndefined();
  });
});
