import { parseBenefitAccessSnapshot } from "@still/core/entitlement";
import type { BenefitAccessSnapshot } from "@still/shared-types";

/**
 * The Safari handler answers {kind:"getBenefitAccess"} on its entitlement lane:
 * `{ entitlement: "{\"ok\":true,\"snapshot\":{...}}" }` (SafariWebExtensionHandler.swift). Anything
 * else, including a settings-lane reply or `ok:false`, is no authority and fails closed.
 * Paid builds only: the background reaches this solely from a branch folded by PAID_TIER_ENABLED.
 */
export function parseNativeBenefitReply(reply: unknown): BenefitAccessSnapshot {
  const envelope = reply && typeof reply === "object" ? (reply as { entitlement?: unknown }).entitlement : null;
  if (typeof envelope !== "string") throw new Error("Native benefit authority unavailable");
  const value: unknown = JSON.parse(envelope);
  if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) throw new Error("Native benefit authority unavailable");
  return parseBenefitAccessSnapshot((value as { snapshot?: unknown }).snapshot);
}
