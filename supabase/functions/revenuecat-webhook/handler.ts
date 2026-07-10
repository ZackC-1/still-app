import { constantTimeEqual } from "../_shared/token.ts";
import { type RevenueCatClient, stillProActive } from "../_shared/revenuecat.ts";
import { type EntitlementStore, type EventClaim, jsonResponse } from "../_shared/store.ts";
import { affectedUuids, isUuid, type RcWebhookBody, type RcWebhookEvent } from "../_shared/types.ts";

// RevenueCat webhook (verify_jwt=false). Gated by a constant-time static-token compare (KTD5),
// idempotent on the event id via an atomic claim taken BEFORE side effects, and ALWAYS derives
// entitlement from a server-side subscriber lookup — never from raw webhook fields or
// client-posted customerInfo.

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

  // Claim the event BEFORE side effects so a replayed delivery cannot re-run the RevenueCat
  // lookups and entitlement writes (workload idempotency). A failed reconcile RELEASES the claim,
  // keeping transient failures retriable — the property the old record-after ordering existed
  // for. The stored payload is minimized; raw RevenueCat webhook bodies may contain
  // billing/subscriber metadata we do not need for entitlement projection.
  let claim: EventClaim;
  try {
    claim = await deps.store.claimEvent(event.id, uuids[0] ?? "", redactedWebhookAuditPayload(event));
  } catch (error) {
    console.error("revenuecat-webhook claim failed:", error);
    return jsonResponse(500, { error: "reconcile_failed" });
  }
  if (claim === "duplicate") return jsonResponse(200, { status: "duplicate" });
  if (claim === "in_flight") return jsonResponse(503, { error: "event_in_flight" });

  try {
    // Reconcile every affected UUID from canonical subscriber state (collapses out-of-order races).
    for (const uuid of uuids) {
      const subscriber = await deps.rc.getSubscriber(uuid);
      await deps.store.setEntitlement(
        uuid,
        stillProActive(subscriber),
        "webhook",
        subscriber?.original_app_user_id ?? null,
      );
    }
    await deps.store.completeEvent(event.id);
  } catch (error) {
    console.error("revenuecat-webhook reconcile failed:", error);
    // Best-effort release so the sender's retry can re-claim immediately; if this also fails, the
    // stale-claim takeover (5 min, migration 0011) unwedges the event.
    try {
      await deps.store.releaseEvent(event.id);
    } catch (releaseError) {
      console.error("revenuecat-webhook release failed:", releaseError);
    }
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
