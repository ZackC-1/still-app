import { describe, expect, it, vi } from "vitest";

// The browser price only matters in builds compiled with the paid tier on, the only builds that
// mount the paywall. Replace the one shared export before the wiring is imported.
vi.mock("@still/shared-types", async (original) => ({
  ...(await original<typeof import("@still/shared-types")>()),
  PAID_TIER_ENABLED: true,
}));
vi.mock("@still/core/ui", () => ({
  STRINGS: { account: { deleteError: "delete failed" } },
}));

import { createExtensionPurchaseDeps, type SessionSender } from "../purchase-wiring.js";

const sender = (async () => null) as unknown as SessionSender;

describe("purchase wiring with the paid tier on", () => {
  // Owner decision (10 October 2026): Chrome and Firefox offer Still Pro with no price; the
  // Stripe checkout page shows it. The retired 2.x $1.99 must never reach a paid build's paywall.
  it.each(["production", "shared-hosted-sandbox"] as const)(
    "passes no display price on the %s route",
    (route) => {
      expect(createExtensionPurchaseDeps(sender, route).displayPrice).toBeNull();
    },
  );

  it("passes no display price on the default route", () => {
    expect(createExtensionPurchaseDeps(sender).displayPrice).toBeNull();
  });
});
