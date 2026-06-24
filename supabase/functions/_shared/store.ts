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

/** Small JSON Response helper shared by both functions. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
