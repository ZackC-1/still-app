import type { BenefitAccessSnapshot } from "@still/shared-types";
import type { EntitlementAdapter } from "./cache.js";
import { boundedAccessRead } from "./access-policy.js";

/** The one native read this adapter uses: NativeBridge.observeBenefits (`getBenefitAccess`). */
export interface NativeBenefitSource {
  observeBenefits(): Promise<BenefitAccessSnapshot>;
}

/**
 * Read-only benefit access for the Apple app's WKWebView settings screen. The native host owns
 * account, purchase and protection evidence and replies with one resolved snapshot; this adapter
 * only forwards that observation to an EntitlementCache, which keeps every failure as a held
 * state ("verification_required"), never Pro and never a conclusive "not owned".
 *
 * There is no legacy Boolean lane here: `get()` is always "no record" (the cache then starts from
 * its packaged snapshot), writes are refused, and there is no native push, so `subscribe` is inert.
 * While the paid tier is off the cache never calls `observeBenefits` at all.
 */
export class WKBenefitAccessAdapter implements EntitlementAdapter {
  constructor(private readonly native: NativeBenefitSource) {}

  async get(): Promise<boolean | null> {
    return null;
  }

  observeBenefits(signal?: AbortSignal): Promise<BenefitAccessSnapshot> {
    // A missing host rejects inside the bridge; absence is never read as "not purchased".
    return boundedAccessRead(() => this.native.observeBenefits(), signal);
  }

  async set(): Promise<void> {
    throw new Error("The Apple settings screen cannot write entitlement records");
  }

  subscribe(): () => void {
    return () => {};
  }
}
