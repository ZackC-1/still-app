import { constantTimeEqual } from "../_shared/token.ts";
import { type RevenueCatClient, stillSyncActive } from "../_shared/revenuecat.ts";
import { type EntitlementStore, jsonResponse } from "../_shared/store.ts";
import { affectedUuids, type RcWebhookBody } from "../_shared/types.ts";

// RevenueCat webhook (verify_jwt=false). Gated by a constant-time static-token compare (KTD5),
// idempotent on the event id, and ALWAYS derives entitlement from a server-side subscriber lookup
// — never from raw webhook fields or client-posted customerInfo.

export interface WebhookDeps {
  readonly token: string;
  readonly store: EntitlementStore;
  readonly rc: RevenueCatClient;
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  // Primary gate: constant-time compare of the static Authorization token. A blank configured
  // token rejects everything (fail closed).
  const auth = req.headers.get("Authorization") ?? "";
  if (deps.token.length === 0 || !constantTimeEqual(auth, deps.token)) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  let body: RcWebhookBody;
  try {
    body = (await req.json()) as RcWebhookBody;
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const event = body?.event;
  if (!event || typeof event.id !== "string" || typeof event.type !== "string") {
    return jsonResponse(400, { error: "invalid_event" });
  }

  // Idempotency: a duplicate event id is acknowledged without reprocessing.
  const isNew = await deps.store.recordEvent(event.id, event.app_user_id ?? "", body);
  if (!isNew) return jsonResponse(200, { status: "duplicate" });

  // Reconcile every affected UUID from canonical subscriber state (collapses out-of-order races).
  const uuids = affectedUuids(event);
  for (const uuid of uuids) {
    const subscriber = await deps.rc.getSubscriber(uuid);
    await deps.store.setEntitlement(
      uuid,
      stillSyncActive(subscriber),
      "webhook",
      subscriber?.original_app_user_id ?? null,
    );
  }
  return jsonResponse(200, { status: "ok", reconciled: uuids.length });
}
