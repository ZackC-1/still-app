import { requireStaticToken } from "../_shared/token.ts";
import { type RevenueCatClient, stillProActive } from "../_shared/revenuecat.ts";
import { type ClaimResult, type EntitlementStore, jsonResponse } from "../_shared/store.ts";
import { affectedUuids, isUuid, type RcWebhookBody, type RcWebhookEvent } from "../_shared/types.ts";

// RevenueCat webhook (verify_jwt=false). Gated by the shared constant-time static-token check
// (KTD5), idempotent on the event id via an atomic claim taken BEFORE side effects, and ALWAYS
// derives entitlement from a server-side subscriber lookup — never from raw webhook fields or
// client-posted customerInfo.

export interface WebhookDeps {
  readonly token: string;
  readonly store: EntitlementStore;
  readonly rc: RevenueCatClient;
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const denied = requireStaticToken(req, deps.token);
  if (denied) return denied;

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
  let claim: ClaimResult;
  try {
    claim = await deps.store.claimEvent(event.id, uuids[0] ?? "", redactedWebhookAuditPayload(event));
  } catch (error) {
    console.error("revenuecat-webhook claim failed:", error);
    return jsonResponse(500, { error: "reconcile_failed" });
  }
  if (claim.status === "duplicate") return jsonResponse(200, { status: "duplicate" });
  if (claim.status === "in_flight") return jsonResponse(503, { error: "event_in_flight" });
  const token = claim.token!; // status === "claimed" always carries an ownership token

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
    await deps.store.completeEvent(event.id, token);
  } catch (error) {
    console.error("revenuecat-webhook reconcile failed:", error);
    // Best-effort release (token-scoped) so the sender's retry can re-claim immediately; if this
    // also fails, the stale-claim takeover (15 min, migration 0011) unwedges the event.
    try {
      await deps.store.releaseEvent(event.id, token);
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
