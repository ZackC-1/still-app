/** Compiled route selection, independent of the proof environment. Never read from storage,
 * checkout URLs, messages or API responses. Unknown input cannot select production implicitly. */
export type BackendRouteProfile = "production" | "shared-hosted-sandbox";

export function readBackendRouteProfile(value: unknown): BackendRouteProfile | null {
  return value === undefined || value === "production" ? "production"
    : value === "shared-hosted-sandbox" ? value : null;
}

export interface BackendRoutes {
  readonly policy: string;
  readonly settings: string;
  readonly reconcile: string;
  readonly verifyApple: string;
  readonly linkApple: string;
  readonly createCheckout: string;
  readonly completeCheckout: string | null;
}

const PRODUCTION: BackendRoutes = Object.freeze({
  policy: "product-policy", settings: "sync-settings", reconcile: "reconcile-entitlement",
  verifyApple: "verify-apple-access", linkApple: "link-apple-access",
  createCheckout: "create-web-checkout", completeCheckout: null,
});
const SANDBOX: BackendRoutes = Object.freeze({
  policy: "qa-sandbox-product-policy", settings: "qa-sandbox-sync-settings",
  reconcile: "qa-sandbox-reconcile-entitlement", verifyApple: "qa-sandbox-verify-apple-access",
  linkApple: "qa-sandbox-link-apple-access", createCheckout: "qa-sandbox-create-web-checkout",
  completeCheckout: "qa-sandbox-complete-web-checkout",
});

export function backendRoutes(profile: BackendRouteProfile): BackendRoutes {
  if (profile === "production") return PRODUCTION;
  if (profile === "shared-hosted-sandbox") return SANDBOX;
  throw new Error("Backend route profile unavailable");
}

/** A QA route must consume sandbox authority. A production route may never consume it. */
export function backendRouteEnvironmentMatches(profile: BackendRouteProfile, environment: unknown): boolean {
  return profile === "production" && environment === "production" ||
    profile === "shared-hosted-sandbox" && environment === "sandbox";
}
