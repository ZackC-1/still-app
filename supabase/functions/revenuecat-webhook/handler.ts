import { constantTimeEqual } from "../_shared/token.ts";
import { type RevenueCatClient, stillSyncActive } from "../_shared/revenuecat.ts";
import { type EntitlementStore, jsonResponse } from "../_shared/store.ts";
import { affectedUuids, isUuid, type RcWebhookBody, type RcWebhookEvent } from "../_shared/types.ts";

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

  const uuids = affectedUuids(event);

  try {
    // Reconcile every affected UUID from canonical subscriber state (collapses out-of-order races).
    // The event is recorded only after successful reconciliation, so a transient RevenueCat/DB
    // failure remains retriable instead of being permanently hidden behind the duplicate guard.
    for (const uuid of uuids) {
      const subscriber = await deps.rc.getSubscriber(uuid);
      await deps.store.setEntitlement(
        uuid,
        stillSyncActive(subscriber),
        "webhook",
        subscriber?.original_app_user_id ?? null,
      );
    }

    // Idempotency/audit commit. Store only a minimized payload; raw RevenueCat webhook bodies may
    // contain billing/subscriber metadata we do not need for entitlement projection.
    const isNew = await deps.store.recordEvent(event.id, uuids[0] ?? "", redactedWebhookAuditPayload(event));
    if (!isNew) return jsonResponse(200, { status: "duplicate" });
  } catch (error) {
    console.error("revenuecat-webhook reconcile failed:", error);
    return jsonResponse(500, { error: "reconcile_failed" });
  }
  return jsonResponse(200, { status: "ok", reconciled: uuids.length });
}

function redactedWebhookAuditPayload(event: RcWebhookEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    event: {
      id: event.id,
      type: event.type,
      app_user_id: isUuid(event.app_user_id) ? event.app_user_id : null,
      original_app_user_id: isUuid(event.original_app_user_id) ? event.original_app_user_id : null,
      aliases: (event.aliases ?? []).filter(isUuid),
      transferred_from: (event.transferred_from ?? []).filter(isUuid),
      transferred_to: (event.transferred_to ?? []).filter(isUuid),
      environment: typeof event.environment === "string" ? event.environment : null,
      product_identifier: typeof event.product_identifier === "string" ? event.product_identifier : null,
      expiration_at_ms: typeof event.expiration_at_ms === "number" ? event.expiration_at_ms : null,
      expiration_date: typeof event.expiration_date === "string" ? event.expiration_date : null,
    },
  };
  return out;
}
