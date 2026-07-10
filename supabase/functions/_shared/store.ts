// The entitlement write surface. The interface is what handlers depend on (so tests inject a mock);
// the Postgres-backed implementation lives in pg-store.ts and connects as the narrow
// still_entitlement_writer role (KTD5) — never the full service_role key.

export interface EntitlementStore {
  /** Idempotently record a webhook event. Returns true if newly inserted (process it). */
  recordEvent(eventId: string, appUserId: string, payload: unknown): Promise<boolean>;
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
