import { jsonResponse } from "./store.ts";
import { readQaSandboxCheckoutRuntime, processQaSandboxCheckout, type QaSandboxCheckoutDeps } from "./qa-sandbox-checkout-runtime.ts";
import { QaSandboxManagedCheckout, type QaChargeRefund } from "./qa-sandbox-managed-checkout.ts";
import type { QaPurchaseOperation } from "./qa-purchase-operation-store.ts";

const MAX_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION = /^cs_test_[A-Za-z0-9]{1,200}$/;
const TYPES = new Set(["checkout.session.completed", "checkout.session.expired", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"]);
export interface QaSandboxStripeWebhookDeps {
  readonly secret: string;
  readonly checkout: QaSandboxCheckoutDeps;
  readonly refunds: Pick<QaSandboxManagedCheckout, "readChargeRefund">;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const reply = (status: number) => jsonResponse(status, status === 200 ? { received: true } : { error: status === 400 ? "invalid_webhook" : "webhook_unavailable" });
const validSecret = (secret: string) => /^whsec_[A-Za-z0-9]{1,240}$/.test(secret);

export async function readQaSandboxStripeWebhookRuntime(read: (name: string) => string | undefined): Promise<QaSandboxStripeWebhookDeps | null> {
  const secret = read("STILL_QA_SANDBOX_STRIPE_WEBHOOK_SECRET") ?? "";
  if (!validSecret(secret)) return null;
  const checkout = await readQaSandboxCheckoutRuntime(read);
  return checkout?.billing instanceof QaSandboxManagedCheckout ? { secret, checkout, refunds: checkout.billing } : null;
}

async function rawBody(req: Request): Promise<Uint8Array | null> {
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) { void req.body?.cancel().catch(() => {}); return null; }
  const reader = req.body?.getReader();
  if (!reader) return null;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = new Promise<{ done: true; value: undefined }>(resolve => { timer = setTimeout(() => {
    expired = true; void reader.cancel().catch(() => {}); resolve({ done: true, value: undefined });
  }, 2000); });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (expired) return null;
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch { return null; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
async function verifiedSignature(raw: Uint8Array, header: string | null, secret: string): Promise<boolean> {
  if (!header || header.length > 2048 || !validSecret(secret)) return false;
  const fields = header.split(",");
  if (fields.length > 12) return false;
  const timestamps: string[] = [], signatures: Uint8Array[] = [];
  for (const field of fields) {
    const match = /^\s*([A-Za-z0-9]+)=([A-Za-z0-9]+)\s*$/.exec(field);
    if (!match) return false;
    if (match[1] === "t") timestamps.push(match[2]!);
    if (match[1] === "v1") {
      if (!/^[a-f0-9]{64}$/.test(match[2]!) || signatures.length === 5) return false;
      signatures.push(Uint8Array.from(match[2]!.match(/../g)!, byte => parseInt(byte, 16)));
    }
  }
  if (timestamps.length !== 1 || !/^[1-9][0-9]{0,12}$/.test(timestamps[0]!) || !signatures.length) return false;
  const timestamp = Number(timestamps[0]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const prefix = new TextEncoder().encode(`${timestamps[0]}.`);
  const signed = new Uint8Array(prefix.length + raw.length); signed.set(prefix); signed.set(raw, prefix.length);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  let valid = false;
  for (const signature of signatures) valid = await crypto.subtle.verify("HMAC", key, new Uint8Array(signature), signed) || valid;
  return valid;
}
function scoped(operation: QaPurchaseOperation | null, operationId: string, holder: string, hash: string, session: string): operation is QaPurchaseOperation {
  return !!operation && operation.operation_id === operationId && operation.holder === holder && operation.environment === "sandbox" &&
    operation.configuration_hash === hash && operation.creation_started_at !== null &&
    Number.isFinite(Date.parse(operation.creation_started_at)) && (operation.stripe_session_id === null || operation.stripe_session_id === session);
}
async function refund(chargeId: string, deps: QaSandboxStripeWebhookDeps): Promise<Response> {
  const canonical: QaChargeRefund = await deps.refunds.readChargeRefund(chargeId);
  if (canonical.status === "unknown") return reply(502);
  if (canonical.status !== "full_refund") return reply(200);
  const checkout = deps.checkout;
  let operation = await checkout.operations.read(canonical.operationId, canonical.holderId);
  if (!scoped(operation, canonical.operationId, canonical.holderId, checkout.configurationHash, canonical.sessionId) ||
    Math.abs(Date.parse(operation.creation_started_at!) - canonical.createdAtMs) > 300_000 || operation.status === "closed_unpaid") return reply(502);
  if (!operation.stripe_session_id) operation = await checkout.operations.bindSession(operation.operation_id, operation.holder, canonical.sessionId, checkout.configurationHash);
  // Persist terminal state before receipt import can resume. Duplicates still retry RC negatives.
  if (operation.status !== "refunded") operation = await checkout.operations.recordStatus(operation.operation_id, canonical.sessionId, "refunded");
  const access = checkout.access;
  if (!access || access.signer.environment !== "sandbox") return reply(502);
  // Start before provider latency; this invalidates earlier delayed positive observations.
  const token = await access.rights.begin(operation.holder, "sandbox");
  const observation = await access.provider.getRights(operation.holder, "sandbox");
  if (observation.status !== "verified") return reply(502);
  const negatives = observation.rights.filter(right => right.state === "revoked");
  // Never invent a Session/RC purchase relation, revoke by absence or create an unknown right.
  // SQL accepts known negative keys only, including a disabled/banned former provider holder.
  const committed = await access.rights.commit(operation.holder, "sandbox", token, negatives);
  if (committed.status === "stale" || observation.complete === false ||
    observation.rights.some(right => right.state !== "revoked") || committed.rights.length) return reply(502);
  return reply(200);
}

/** Dedicated endpoint: signature is the authority. No JWT, shared webhook token, live fallback,
 * account proof or checkout URL crosses this boundary. Snapshot payment state is never trusted. */
export async function handleQaSandboxStripeWebhook(req: Request, deps: QaSandboxStripeWebhookDeps | null): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });
  if (!deps || !validSecret(deps.secret)) return reply(503);
  try {
    const raw = await rawBody(req);
    if (!raw || !await verifiedSignature(raw, req.headers.get("Stripe-Signature"), deps.secret)) return reply(400);
    const event: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (!object(event) || event.object !== "event" || typeof event.id !== "string" || !/^evt_[A-Za-z0-9]{1,200}$/.test(event.id) ||
      event.livemode !== false || typeof event.type !== "string" || event.type.length > 160 || !object(event.data) || !object(event.data.object)) return reply(400);
    const hint = event.data.object;
    if (event.type === "charge.refunded") {
      if (hint.object !== "charge" || hint.livemode !== false || typeof hint.id !== "string" || !/^ch_[A-Za-z0-9]{1,200}$/.test(hint.id)) return reply(400);
      return await refund(hint.id, deps);
    }
    if (!TYPES.has(event.type)) return reply(200);
    const operationId = object(hint.metadata) ? hint.metadata.operation_id : null, holder = hint.client_reference_id;
    if (hint.object !== "checkout.session" || hint.livemode !== false || typeof hint.id !== "string" || !SESSION.test(hint.id) ||
      typeof operationId !== "string" || !UUID.test(operationId) || typeof holder !== "string" || !UUID.test(holder)) return reply(400);
    const checkout = deps.checkout;
    const operation = await checkout.operations.read(operationId, holder);
    if (!scoped(operation, operationId, holder, checkout.configurationHash, hint.id)) return reply(502);
    if (operation.status === "refunded" || operation.status === "closed_unpaid") return reply(200);
    const identity = { operationId, holderId: holder };
    const recovery = operation.stripe_session_id ? await checkout.billing.recoverCheckout(identity, operation.stripe_session_id) :
      await checkout.billing.recoverUnknownCheckout(identity, Date.parse(operation.creation_started_at!));
    // Unknown outcomes keep their existing claim; hint IDs cannot bind unverified provider rows.
    if (recovery.sessionId !== hint.id) return reply(502);
    const response = await processQaSandboxCheckout(operation, recovery, checkout, { authorize: () => Promise.resolve(true), canGrant: () => Promise.resolve(false) });
    if (!response.ok) return reply(502);
    const result = await response.json();
    return reply(result.status === "recovery_required" || recovery.status === "unknown" ? 502 : 200);
  } catch { return reply(502); }
}
