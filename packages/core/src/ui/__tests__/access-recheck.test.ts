import { describe, expect, it, vi } from "vitest";
import { PAID_TIER_ENABLED } from "@still/shared-types";
import { createExtensionUiController } from "../extension-setup.js";
import { browser, flush, purchase, stops } from "./committed-popup-host.fixtures.js";

describe("committed page access re-check, paid tier compiled off", () => {
  it("is absent, and opening the page reconciles nothing", async () => {
    expect(PAID_TIER_ENABLED).toBe(false);
    await browser();
    const p = purchase();
    const reconcile = vi.fn(async () => "not-entitled" as const);
    const controller = createExtensionUiController({
      ...p.deps,
      getState: async () => ({ userId: "synthetic-account", entitled: false, pendingOtp: null, checkoutPending: null }),
      checkout: { ...p.deps.checkout, reconcile },
    }, { accessHost: "chromium", onCommittedPopupBinding: (binding) => { stops.push(() => binding.stop()); } });
    stops.push(() => controller.dispose());
    await flush(); await flush();
    expect(controller.recheckAccess).toBeUndefined();
    expect("recheckAccess" in controller).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
