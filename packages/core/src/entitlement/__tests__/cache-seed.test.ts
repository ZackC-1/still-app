import { describe, expect, it, vi } from "vitest";
import type { BenefitAccessSnapshot } from "@still/shared-types";
import { EntitlementCache, type EntitlementAdapter } from "../cache.js";
import { packagedAccessContext } from "../access-policy.js";

// A page's seed snapshot (before the access authority answers) on a host that spans phones.
// Explicit paid-on seam, scoped to this module.
vi.mock("@still/shared-types", async (original) => ({
  ...await original<typeof import("@still/shared-types")>(), PAID_TIER_ENABLED: true,
}));

function adapter(observe: () => Promise<BenefitAccessSnapshot>): EntitlementAdapter {
  return { get: async () => null, set: async () => {}, subscribe: () => () => {}, observeBenefits: observe };
}

describe("EntitlementCache seed for a late platform answer", () => {
  it("an unknown-platform seed never offers a desktop-layout extra; a desktop answer reseeds it as verifiable", () => {
    const cache = new EntitlementCache(adapter(() => new Promise(() => {})), { access: packagedAccessContext("firefox", "unknown") });
    expect(cache.currentAccess("youtube.endscreen")).toBe("unsupported");
    expect(cache.currentAccess("youtube.autoplay")).toBe("verification_required");
    cache.seedAccess(packagedAccessContext("firefox", "desktop"));
    expect(cache.currentAccess("youtube.endscreen")).toBe("verification_required");
    cache.seedAccess(packagedAccessContext("firefox", "android"));
    expect(cache.currentAccess("youtube.endscreen")).toBe("unsupported");
    expect(cache.currentAccess("youtube.shorts")).toBe("free");
  });

  it("is ignored once the access authority has answered (its snapshot is newer and per-device)", async () => {
    const observed = { ...packagedAccessContext("firefox", "android") };
    const base = (await import("../access-policy.js")).initialAccessSnapshot(observed);
    const answer: BenefitAccessSnapshot = { ...base, states: { ...base.states, "youtube.autoplay": "purchased" } };
    const cache = new EntitlementCache(adapter(async () => answer), { access: packagedAccessContext("firefox", "unknown") });
    await cache.refreshAccess();
    expect(cache.currentAccess("youtube.autoplay")).toBe("purchased");
    cache.seedAccess(packagedAccessContext("firefox", "desktop"));
    expect(cache.currentAccess("youtube.autoplay")).toBe("purchased");
    expect(cache.currentAccess("youtube.endscreen")).toBe("unsupported");
  });
});
