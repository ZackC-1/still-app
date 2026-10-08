import { describe, expect, it } from "vitest";
import { backendRouteEnvironmentMatches, backendRoutes, readBackendRouteProfile } from "../backend-route-profile.js";

describe("compiled backend route profile", () => {
  it("preserves absent and explicit production configuration", () => {
    expect(readBackendRouteProfile(undefined)).toBe("production");
    expect(readBackendRouteProfile("production")).toBe("production");
    expect(backendRoutes("production")).toEqual({
      policy: "product-policy", settings: "sync-settings", reconcile: "reconcile-entitlement",
      verifyApple: "verify-apple-access", linkApple: "link-apple-access",
      createCheckout: "create-web-checkout", completeCheckout: null,
    });
  });
  it("resolves the complete immutable seven-route QA namespace", () => {
    const profile = readBackendRouteProfile("shared-hosted-sandbox");
    expect(profile).toBe("shared-hosted-sandbox");
    const routes = backendRoutes(profile!);
    expect(Object.values(routes)).toEqual([
      "qa-sandbox-product-policy", "qa-sandbox-sync-settings", "qa-sandbox-reconcile-entitlement",
      "qa-sandbox-verify-apple-access", "qa-sandbox-link-apple-access",
      "qa-sandbox-create-web-checkout", "qa-sandbox-complete-web-checkout",
    ]);
    expect(Object.isFrozen(routes)).toBe(true);
  });
  it("holds every unknown value rather than choosing live routes", () => {
    for (const value of [null, "", "sandbox", "shared-hosted-sandbox ", "Production", {}, true, 1]) {
      expect(readBackendRouteProfile(value)).toBeNull();
      expect(() => backendRoutes(value as never)).toThrow();
    }
  });
  it("rejects profile/proof environment disagreement and unknown environments", () => {
    expect(backendRouteEnvironmentMatches("production", "production")).toBe(true);
    expect(backendRouteEnvironmentMatches("shared-hosted-sandbox", "sandbox")).toBe(true);
    expect(backendRouteEnvironmentMatches("production", "sandbox")).toBe(false);
    expect(backendRouteEnvironmentMatches("shared-hosted-sandbox", "production")).toBe(false);
    expect(backendRouteEnvironmentMatches("shared-hosted-sandbox", undefined)).toBe(false);
  });
});
