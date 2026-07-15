// The entitlement write surface. The interface is what handlers depend on (so tests inject a mock);
// the Postgres-backed implementation lives in pg-store.ts and connects as the narrow
// still_entitlement_writer role (KTD5) — never the full service_role key.

/** Claim outcome for a webhook event (idempotency protocol — see revenuecat-webhook/handler.ts). */
export type EventClaimStatus = "claimed" | "duplicate" | "in_flight";

export interface ClaimResult {
  readonly status: EventClaimStatus;
  /** Ownership token passed to completeEvent/releaseEvent; non-null only when status is "claimed". */
  readonly token: string | null;
}

/**
 * Thrown by setEntitlement when the subject no longer exists in auth.users (deleted account —
 * e.g. the losing side of a TRANSFER). The webhook treats ONLY this class as skip-and-continue
 * (R19): a deleted user can never be written, so failing the event would loop RevenueCat's
 * retries forever. Every other store error must keep fail-and-release retriability.
 */
export class MissingUserError extends Error {
  constructor(userId: string, options?: ErrorOptions) {
    super(`entitlement subject ${userId} no longer exists in auth.users`, options);
    this.name = "MissingUserError";
  }
}

export interface EntitlementStore {
  /**
   * Atomically claim a webhook event BEFORE any side effects run. "claimed" → the caller owns it
   * (reconcile, then complete — or release on failure) and gets the ownership token; "duplicate" →
   * already fully processed; "in_flight" → another worker holds a live claim.
   */
  claimEvent(eventId: string, appUserId: string, payload: unknown): Promise<ClaimResult>;
  /** Commit a claimed event after successful reconciliation (the duplicate guard from then on). */
  completeEvent(eventId: string, token: string): Promise<void>;
  /** Release a claimed event after a failed reconciliation so the sender's retry can re-claim it. */
  releaseEvent(eventId: string, token: string): Promise<void>;
  /** Write entitlement state via the narrow SECURITY DEFINER RPC. */
  setEntitlement(
    userId: string,
    stillSync: boolean,
    source: string,
    revenueCatSubscriberId: string | null,
  ): Promise<void>;
}

export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/** Small JSON Response helper shared by the functions. Extra headers may add fields, but never
 *  override the CORS set or content-type (those are spread last so they always win). */
export function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, ...corsHeaders, "content-type": "application/json" },
  });
}
