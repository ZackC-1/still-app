// The entitlement write surface. The interface is what handlers depend on (so tests inject a mock);
// the Postgres-backed implementation lives in pg-store.ts and connects as the narrow
// still_entitlement_writer role (KTD5) — never the full service_role key.

/** Claim outcome for a webhook event (idempotency protocol — see revenuecat-webhook/handler.ts). */
export type EventClaim = "claimed" | "duplicate" | "in_flight";

export interface EntitlementStore {
  /**
   * Atomically claim a webhook event BEFORE any side effects run. "claimed" → the caller owns it
   * (reconcile, then complete — or release on failure); "duplicate" → already fully processed;
   * "in_flight" → another worker holds a live claim.
   */
  claimEvent(eventId: string, appUserId: string, payload: unknown): Promise<EventClaim>;
  /** Commit a claimed event after successful reconciliation (the duplicate guard from then on). */
  completeEvent(eventId: string): Promise<void>;
  /** Release a claimed event after a failed reconciliation so the sender's retry can re-claim it. */
  releaseEvent(eventId: string): Promise<void>;
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

/** Small JSON Response helper shared by the functions. Extra headers layer over the CORS set. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json", ...headers },
  });
}
