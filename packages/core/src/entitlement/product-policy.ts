import { PAID_TIER_ENABLED } from "@still/shared-types";
// A separate subpath, not the package index, so the Deno settings runtime graph is unchanged.
import {
  DEFERRED_PRODUCT_POLICY_SURFACES, PRODUCT_POLICY_BUILD_PATTERN, PRODUCT_POLICY_ENVIRONMENTS,
  PRODUCT_POLICY_FRESH_WINDOW_MS, PRODUCT_POLICY_SURFACES, ProductPolicyGrammarError, SALES_CHANNEL_BY_SURFACE,
  parseProductPolicy, type ProductPolicyEnvironment, type ProductPolicySurface, type RatingPolicy, type SalesPolicy,
} from "@still/shared-types/product-policy";

/** Fail-safe evaluation of one fresh remote policy response (U6). Dormant: nothing calls this.
 *
 * Two keys for sales: the packaged compiled flag (passed in, never read from the payload) AND the
 * remote sales policy AND an allowlisted packaged build. With the compiled flag false every remote
 * value is inert. Missing, late, oversized, invalid, wrong-environment, stale or unknown input is
 * Off. Remote policy never supplies `paidMode` for access gating, and free blocking, free sync and
 * Restore never consult it. A cached projection is advisory UI state only and cannot authorize. */

export type ProductPolicyReason =
  | "context" | "compiled_off" | "deferred_surface" | "missing" | "late" | "oversized" | "invalid"
  | "environment" | "stale" | "build" | "off" | "on";

export interface ProductPolicyVerdict {
  readonly allowed: boolean;
  readonly reason: ProductPolicyReason;
  /** Present only once the body fully validated for this environment. */
  readonly revision: number | null;
}

/** Packaged identity only. No request, payload, cache or account may supply any of these. */
export interface PackagedPolicyContext {
  readonly paidTierEnabled: boolean;
  readonly environment: ProductPolicyEnvironment;
  readonly surface: ProductPolicySurface;
  readonly build: string;
}

/** One fresh check: raw body (null when absent) plus monotonic request-start/consumption times. */
export interface ProductPolicyResponse {
  readonly body: string | null;
  readonly requestStartedAt: number;
  readonly evaluatedAt: number;
}

export function packagedPolicyContext(environment: ProductPolicyEnvironment, surface: ProductPolicySurface, build: string): PackagedPolicyContext {
  return Object.freeze({ paidTierEnabled: PAID_TIER_ENABLED, environment, surface, build });
}

const verdict = (reason: ProductPolicyReason, revision: number | null = null): ProductPolicyVerdict =>
  Object.freeze({ allowed: reason === "on", reason, revision });
const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validContext(context: PackagedPolicyContext, highestSeenRevision: number): boolean {
  return !!context && typeof context === "object" && typeof context.paidTierEnabled === "boolean" &&
    (PRODUCT_POLICY_ENVIRONMENTS as readonly unknown[]).includes(context.environment) &&
    (PRODUCT_POLICY_SURFACES as readonly unknown[]).includes(context.surface) &&
    typeof context.build === "string" && PRODUCT_POLICY_BUILD_PATTERN.test(context.build) && safe(highestSeenRevision);
}

type Checked<P> = { readonly policy: P } | { readonly verdict: ProductPolicyVerdict };

/** Shared response checks after the namespace-specific packaged gates. */
function check<P extends SalesPolicy | RatingPolicy>(namespace: "sales" | "rating", context: PackagedPolicyContext,
  response: ProductPolicyResponse | null, highestSeenRevision: number): Checked<P> {
  if (!response || typeof response !== "object" || response.body === null || response.body === undefined) return { verdict: verdict("missing") };
  const { requestStartedAt, evaluatedAt } = response;
  if (!safe(requestStartedAt) || !safe(evaluatedAt) || evaluatedAt < requestStartedAt ||
      evaluatedAt - requestStartedAt >= PRODUCT_POLICY_FRESH_WINDOW_MS) return { verdict: verdict("late") };
  let policy: P;
  try {
    policy = parseProductPolicy(namespace, response.body) as P;
  } catch (error) {
    return { verdict: verdict(error instanceof ProductPolicyGrammarError && error.kind === "oversized" ? "oversized" : "invalid") };
  }
  if (policy.environment !== context.environment) return { verdict: verdict("environment") };
  if (policy.revision < highestSeenRevision) return { verdict: verdict("stale", policy.revision) };
  if (!policy.builds.some(entry => entry.surface === context.surface && entry.build === context.build)) {
    return { verdict: verdict("build", policy.revision) };
  }
  return { policy };
}

/** May this packaged build start a purchase right now? Restore never calls this. */
export function evaluateSalesPolicy(context: PackagedPolicyContext, response: ProductPolicyResponse | null,
  highestSeenRevision = 0): ProductPolicyVerdict {
  try {
    if (!validContext(context, highestSeenRevision)) return verdict("context");
    // Key one: the compiled constant from packaged code. The payload's flag is only key two.
    if (context.paidTierEnabled !== true) return verdict("compiled_off");
    const channel = SALES_CHANNEL_BY_SURFACE[context.surface];
    if (channel === null || DEFERRED_PRODUCT_POLICY_SURFACES.includes(context.surface)) return verdict("deferred_surface");
    const checked = check<SalesPolicy>("sales", context, response, highestSeenRevision);
    if ("verdict" in checked) return checked.verdict;
    const { policy } = checked;
    return verdict(policy.paidTierEnabled === true && policy.channels[channel].enabled === true ? "on" : "off", policy.revision);
  } catch {
    return verdict("invalid");
  }
}

/** May this packaged build request a review prompt right now? Master AND surface AND build. */
export function evaluateRatingPolicy(context: PackagedPolicyContext, response: ProductPolicyResponse | null,
  highestSeenRevision = 0): ProductPolicyVerdict {
  try {
    if (!validContext(context, highestSeenRevision)) return verdict("context");
    if (DEFERRED_PRODUCT_POLICY_SURFACES.includes(context.surface)) return verdict("deferred_surface");
    const checked = check<RatingPolicy>("rating", context, response, highestSeenRevision);
    if ("verdict" in checked) return checked.verdict;
    const { policy } = checked;
    return verdict(policy.master === true && policy.surfaces[context.surface] === true ? "on" : "off", policy.revision);
  } catch {
    return verdict("invalid");
  }
}
