// Environment-bound provider transport. Callers must freeze these bindings in the operation
// ledger and check confirmed identity/admission; this module never grants access rights.
// The caller must bind the operation to its complete immutable producer configuration
// hash and reject a mismatch BEFORE invoking this adapter. Do not rotate account,
// Price/product, return URLs, amount or RevenueCat app configuration while operations
// remain unresolved. Drain them first, or restore the exact preserved private config
// by hash and verify its provider bindings before recovery. This leaf has no config history.
// Managed parameters: https://docs.stripe.com/payments/managed-payments/update-checkout
// Import contract: https://www.revenuecat.com/docs/web/integrations/stripe/track-external-purchases
// Session managed_payments.enabled: official stripe-java Session at
// ce9777b6af496ae8b7251c04597bd89209fbb140. Version: https://docs.stripe.com/changelog/endive
export const STRIPE_API_VERSION = "2026-09-30.endive";
const STRIPE = "https://api.stripe.com/v1/checkout/sessions";
const RECEIPTS = "https://api.revenuecat.com/v1/receipts";
const MAX_RESPONSE_BYTES = 64 * 1024;
const OFFER_AMOUNT_USD_CENTS = 999;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type CheckoutEnvironment = "sandbox" | "production";
const MODES = Object.freeze({
  sandbox: Object.freeze({ live: false, sessionId: /^cs_test_[A-Za-z0-9]{1,200}$/, key: /^(?:sk|rk)_test_[A-Za-z0-9]{8,240}$/, idempotency: "still-qa-managed-" }),
  production: Object.freeze({ live: true, sessionId: /^cs_live_[A-Za-z0-9]{1,200}$/, key: /^(?:sk|rk)_live_[A-Za-z0-9]{8,240}$/, idempotency: "still-production-managed-" }),
});
type CheckoutMode = typeof MODES[CheckoutEnvironment];
// Initial dispatch stays inside the timestamp window used for later GET-only discovery.
// This is not a replay permit: only the winner of the persisted one-way claim may create.
const MAX_CREATION_CLAIM_AGE_MS = 120_000;

export interface ManagedCheckoutConfig {
  readonly environment: CheckoutEnvironment;
  readonly stripeSecretKey: string;
  readonly priceId: string;
  readonly productId: string;
  readonly stripeAccountId: string;
  // Key syntax cannot prove the RevenueCat app/platform. Deployment requires an
  // independent configuration readback binding this public key to the matching environment's Stripe app.
  readonly revenueCatStripePublicKey: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}
export interface CheckoutOperation {
  readonly operationId: string;
  readonly holderId: string;
}
export type CheckoutCreated = { readonly status: "created"; readonly sessionId: string; readonly checkoutUrl: string };
export type CheckoutRecovered = {
  readonly status: "recovered";
  readonly sessionId: string;
  readonly paymentState: "paid" | "expired_unpaid" | "payment_pending";
};
export type CheckoutUnknown = { readonly status: "unknown"; readonly sessionId?: string };
export type CheckoutRecovery = CheckoutCreated | CheckoutRecovered | CheckoutUnknown;
// "foreign": canonically readable and provably not a Still purchase. The live account is shared with
// another product, so its Charges reach this endpoint too and must be acknowledged, never retried.
export type ChargeRefund = { readonly status: "unknown" } | { readonly status: "foreign" } | {
  readonly status: "full_refund" | "partial_refund" | "not_refunded";
  readonly operationId: string; readonly holderId: string; readonly sessionId: string;
  readonly paymentIntentId: string; readonly createdAtMs: number;
};
type Unavailable = { readonly status: "unavailable" };
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function positiveAmount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function returnUrl(value: string): boolean {
  if (typeof value !== "string" || value.length > 2048 || !/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9/_-]*$/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && url.href === value && url.hostname.includes(".");
  } catch { return false; }
}
function binding(operation: CheckoutOperation): boolean {
  return UUID.test(operation.operationId) && UUID.test(operation.holderId);
}
function freshCreationClaim(timestamp: number): boolean {
  const age = Date.now() - timestamp;
  return Number.isSafeInteger(timestamp) && timestamp > 0 && age >= 0 && age <= MAX_CREATION_CLAIM_AGE_MS;
}
function checkoutUrl(value: unknown, id: string): value is string {
  return typeof value === "string" && value.length <= 4096 &&
    new RegExp(`^https://checkout\\.stripe\\.com/c/pay/${id}(?:#[A-Za-z0-9_%=+.-]{1,2048})?$`).test(value);
}
function session(value: unknown, operation: CheckoutOperation, mode: CheckoutMode, id?: string): JsonObject | null {
  const row = object(value);
  const metadata = object(row?.metadata);
  if (!row || typeof row.id !== "string" || !mode.sessionId.test(row.id) || (id !== undefined && row.id !== id) ||
    row.object !== "checkout.session" || row.livemode !== mode.live || row.mode !== "payment" ||
    object(row.managed_payments)?.enabled !== true || row.client_reference_id !== operation.holderId ||
    metadata?.operation_id !== operation.operationId || row.currency !== "usd" ||
    row.amount_subtotal !== OFFER_AMOUNT_USD_CENTS || !positiveAmount(row.amount_total)) return null;
  return row;
}
function lineItems(value: unknown, config: Readonly<ManagedCheckoutConfig>, row: JsonObject): boolean {
  const list = object(value);
  if (list?.object !== "list" || list.has_more !== false || !Array.isArray(list.data) || list.data.length !== 1) return false;
  const line = object(list.data[0]);
  const price = object(line?.price);
  const product = object(price?.product);
  return line?.object === "item" && line.quantity === 1 && line.currency === "usd" &&
    line.amount_subtotal === row.amount_subtotal && line.amount_total === row.amount_total &&
    price?.object === "price" && price.id === config.priceId && price.currency === "usd" && price.livemode === MODES[config.environment].live &&
    price.type === "one_time" && price.recurring === null && price.unit_amount === OFFER_AMOUNT_USD_CENTS &&
    product?.object === "product" && product.id === config.productId && product.livemode === MODES[config.environment].live;
}

export type SessionOwnership = "still" | "foreign" | "unknown";
/** Ownership only, never a purchase binding. A Session is Still's when any line carries Still's Price
 * or product. Still creates exactly one such line, so a Session whose visible lines carry neither can
 * never be a Still purchase (the strict lineItems check would refuse it anyway). An unreadable list is
 * unknown, so a transient provider failure is retried instead of being acknowledged. */
function ownership(value: unknown, config: Readonly<ManagedCheckoutConfig>): SessionOwnership {
  const list = object(value);
  if (list?.object !== "list" || typeof list.has_more !== "boolean" || !Array.isArray(list.data)) return "unknown";
  for (const entry of list.data) {
    const price = object(object(entry)?.price);
    const product = typeof price?.product === "string" ? price.product : object(price?.product)?.id;
    if (price?.id === config.priceId || product === config.productId) return "still";
  }
  return "foreign";
}

export class ManagedCheckout {
  private readonly config: Readonly<ManagedCheckoutConfig>;
  private readonly timeoutMs: number;
  private readonly mode: CheckoutMode;

  constructor(config: ManagedCheckoutConfig, private readonly fetcher: typeof fetch = fetch, timeoutMs = 8000) {
    if ((config.environment !== "sandbox" && config.environment !== "production") ||
      !MODES[config.environment].key.test(config.stripeSecretKey) ||
      !/^price_[A-Za-z0-9]{1,200}$/.test(config.priceId) ||
      !/^prod_[A-Za-z0-9]{1,200}$/.test(config.productId) ||
      !/^acct_[A-Za-z0-9]{1,200}$/.test(config.stripeAccountId) ||
      !/^[A-Za-z0-9_-]{1,1024}$/.test(config.revenueCatStripePublicKey) ||
      /^(?:appl_|goog_|amzn_|sk_|rk_|pk_)/.test(config.revenueCatStripePublicKey) ||
      !returnUrl(config.successUrl) || !returnUrl(config.cancelUrl) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw new Error(config.environment === "sandbox" ? "qa_checkout_unconfigured" : "checkout_unconfigured");
    this.config = Object.freeze({ ...config });
    this.timeoutMs = timeoutMs;
    this.mode = MODES[this.config.environment];
  }

  private async request(url: string, init: RequestInit, acknowledge = false, deadline?: number): Promise<unknown> {
    const remaining = deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, Math.ceil(deadline - performance.now()));
    if (remaining <= 0) return null;
    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        if (activeReader) void activeReader.cancel().catch(() => {});
        resolve(null);
      }, remaining);
    });
    try {
      return await Promise.race([expired, (async () => {
        const response = await this.fetcher(url, { ...init, redirect: "error", signal: controller.signal });
        if (!response.ok || response.redirected) {
          if (response.body) void response.body.cancel().catch(() => {});
          return null;
        }
        if (!response.body) return acknowledge ? true : null;
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
          void response.body.cancel().catch(() => {}); return null;
        }
        const reader = response.body.getReader();
        activeReader = reader;
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); return null; }
            if (!acknowledge) chunks.push(value);
          }
          if (acknowledge) return true;
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
        } finally { activeReader = undefined; reader.releaseLock(); }
      })()]);
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }

  private stripeHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.stripeSecretKey}`, "Stripe-Version": STRIPE_API_VERSION };
  }

  private lineItems(id: string, deadline?: number): Promise<unknown> {
    return this.request(`${STRIPE}/${id}/line_items?limit=2&expand%5B%5D=data.price.product`, { headers: this.stripeHeaders() }, false, deadline);
  }

  // `items` reuses a line-item list this request already read for ownership instead of reading it twice.
  private async readSession(operation: CheckoutOperation, id: string, accountVerified = false, deadline?: number, items?: unknown): Promise<JsonObject | null> {
    if (!accountVerified && !await this.accountMatches(deadline)) return null;
    const row = session(await this.request(`${STRIPE}/${id}`, { headers: this.stripeHeaders() }, false, deadline), operation, this.mode, id);
    if (!row || !lineItems(items !== undefined ? items : await this.lineItems(id, deadline), this.config, row)) return null;
    return row;
  }

  /** One GET of the Session's line items. Decides only whether a webhook Session can be Still's;
   * fulfilment still re-reads and strictly verifies the Session before anything is recorded. */
  async readSessionOwnership(sessionId: string): Promise<SessionOwnership> {
    if (!this.mode.sessionId.test(sessionId)) return "unknown";
    return ownership(await this.lineItems(sessionId, performance.now() + this.timeoutMs), this.config);
  }

  private async accountMatches(deadline?: number): Promise<boolean> {
    const account = object(await this.request("https://api.stripe.com/v1/account", { headers: this.stripeHeaders() }, false, deadline));
    return account?.object === "account" && account.id === this.config.stripeAccountId;
  }

  private recovery(row: JsonObject): CheckoutRecovery {
    if (row.status === "open" && row.payment_status === "unpaid" && checkoutUrl(row.url, row.id as string)) {
      return { status: "created", sessionId: row.id as string, checkoutUrl: row.url };
    }
    const paymentState = row.status === "complete" && row.payment_status === "paid" ? "paid" :
      row.status === "expired" && row.payment_status === "unpaid" ? "expired_unpaid" :
      row.status === "complete" && row.payment_status === "unpaid" ? "payment_pending" : null;
    return paymentState ? { status: "recovered", sessionId: row.id as string, paymentState } : { status: "unknown", sessionId: row.id as string };
  }

  // After the ledger's one-way creation claim, routes use ONLY these GET methods.
  // Replaying createCheckout could create a second Session after Stripe prunes its
  // idempotency cache. Unknown/absence never releases the claim for another POST.
  async recoverCheckout(operation: CheckoutOperation, boundSessionId: string): Promise<CheckoutRecovery> {
    if (!binding(operation) || !this.mode.sessionId.test(boundSessionId)) return { status: "unknown" };
    const frozen = Object.freeze({ operationId: operation.operationId, holderId: operation.holderId });
    const row = await this.readSession(frozen, boundSessionId, false, performance.now() + this.timeoutMs);
    return row ? this.recovery(row) : { status: "unknown", sessionId: boundSessionId };
  }

  async recoverUnknownCheckout(operation: CheckoutOperation, creationStartedAtMs: number): Promise<CheckoutRecovery> {
    const now = Date.now();
    // This timestamp comes from the persisted server claim, never a client request.
    // Age does not widen the bounded window: old unresolved purchases stay recoverable.
    if (!binding(operation) || !Number.isSafeInteger(creationStartedAtMs) || creationStartedAtMs <= 0 || creationStartedAtMs > now) {
      return { status: "unknown" };
    }
    const frozen = Object.freeze({ operationId: operation.operationId, holderId: operation.holderId });
    const deadline = performance.now() + this.timeoutMs;
    if (!await this.accountMatches(deadline)) return { status: "unknown" };
    const lower = Math.max(0, Math.floor(creationStartedAtMs / 1000) - 300);
    const upper = Math.floor(creationStartedAtMs / 1000) + 300;
    const seen = new Set<string>();
    const matches: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const query = new URLSearchParams({ "created[gte]": String(lower), "created[lte]": String(upper), limit: "100" });
      if (cursor) query.set("starting_after", cursor);
      const list = object(await this.request(`${STRIPE}?${query}`, { headers: this.stripeHeaders() }, false, deadline));
      if (list?.object !== "list" || list.url !== "/v1/checkout/sessions" || typeof list.has_more !== "boolean" ||
        !Array.isArray(list.data) || list.data.length > 100) return { status: "unknown" };
      for (const value of list.data) {
        const row = object(value);
        if (!row || row.object !== "checkout.session" || row.livemode !== this.mode.live || typeof row.id !== "string" ||
          !this.mode.sessionId.test(row.id) || seen.has(row.id) || typeof row.created !== "number" ||
          !Number.isSafeInteger(row.created) || row.created < lower || row.created > upper) return { status: "unknown" };
        seen.add(row.id);
        cursor = row.id;
        if (row.client_reference_id === frozen.holderId && object(row.metadata)?.operation_id === frozen.operationId) matches.push(row.id);
      }
      if (matches.length > 1 || (list.has_more && (list.data.length === 0 || page === 3))) return { status: "unknown" };
      if (!list.has_more) {
        if (matches.length !== 1) return { status: "unknown" };
        const row = await this.readSession(frozen, matches[0]!, true, deadline);
        return row ? this.recovery(row) : { status: "unknown", sessionId: matches[0]! };
      }
    }
    return { status: "unknown" };
  }

  /** Canonical Charge -> PaymentIntent -> unique managed Session. Snapshot metadata is
   * never a purchase binding; refunds do not import receipts or authorize access. Ownership is
   * decided first, from canonical reads only: a Charge with no PaymentIntent, a PaymentIntent with
   * no Checkout Session, or a Session without Still's Price or product is "foreign". A Still-priced
   * Session that lacks Still's operation binding stays "unknown" (retried), never dropped. */
  async readChargeRefund(chargeId: string): Promise<ChargeRefund> {
    const unknown = { status: "unknown" } as const, foreign = { status: "foreign" } as const;
    if (!/^ch_[A-Za-z0-9]{1,200}$/.test(chargeId)) return unknown;
    const deadline = performance.now() + this.timeoutMs;
    if (!await this.accountMatches(deadline)) return unknown;
    const charge = object(await this.request(`https://api.stripe.com/v1/charges/${chargeId}`, { headers: this.stripeHeaders() }, false, deadline));
    if (!charge || charge.object !== "charge" || charge.id !== chargeId || charge.livemode !== this.mode.live) return unknown;
    // Every Still purchase is a Checkout Session payment, which always has a PaymentIntent.
    if (charge.payment_intent === null) return foreign;
    if (typeof charge.payment_intent !== "string" || !/^pi_[A-Za-z0-9]{1,200}$/.test(charge.payment_intent)) return unknown;
    const query = new URLSearchParams({ payment_intent: charge.payment_intent, limit: "2" });
    const list = object(await this.request(`${STRIPE}?${query}`, { headers: this.stripeHeaders() }, false, deadline));
    if (list?.object !== "list" || list.url !== "/v1/checkout/sessions" || list.has_more !== false || !Array.isArray(list.data)) return unknown;
    if (list.data.length === 0) return foreign;
    if (list.data.length !== 1) return unknown;
    const hint = object(list.data[0]);
    if (typeof hint?.id !== "string" || !this.mode.sessionId.test(hint.id) || hint.object !== "checkout.session" || hint.livemode !== this.mode.live ||
      hint.payment_intent !== charge.payment_intent) return unknown;
    const items = await this.lineItems(hint.id, deadline);
    const owner = ownership(items, this.config);
    if (owner === "foreign") return foreign;
    if (owner !== "still") return unknown;
    const operationId = object(hint.metadata)?.operation_id, holderId = hint.client_reference_id;
    if (typeof operationId !== "string" || !UUID.test(operationId) || typeof holderId !== "string" || !UUID.test(holderId)) return unknown;
    if (charge.currency !== "usd" || charge.paid !== true || charge.status !== "succeeded" || !positiveAmount(charge.amount) ||
      typeof charge.amount_refunded !== "number" || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 ||
      charge.amount_refunded > (charge.amount as number) || typeof charge.refunded !== "boolean" ||
      charge.refunded !== (charge.amount_refunded === charge.amount)) return unknown;
    const row = await this.readSession({ operationId, holderId }, hint.id, true, deadline, items);
    if (!row || row.payment_intent !== charge.payment_intent || row.status !== "complete" || row.payment_status !== "paid" ||
      row.amount_total !== charge.amount || typeof row.created !== "number" || !Number.isSafeInteger(row.created) || row.created <= 0 ||
      !Number.isSafeInteger(row.created * 1000)) return unknown;
    return { status: charge.refunded ? "full_refund" : charge.amount_refunded > 0 ? "partial_refund" : "not_refunded",
      operationId, holderId, sessionId: row.id as string, paymentIntentId: charge.payment_intent, createdAtMs: row.created * 1000 };
  }

  /** Single initial dispatch by the SQL claim winner. Retries always use the GET recovery methods. */
  async createCheckout(operation: CheckoutOperation, creationStartedAtMs: number): Promise<CheckoutCreated | CheckoutRecovered | CheckoutUnknown | Unavailable> {
    if (!binding(operation)) return { status: "unavailable" };
    if (!freshCreationClaim(creationStartedAtMs)) return { status: "unknown" };
    // Copy before awaiting: the caller cannot mutate an identity binding mid-request.
    const frozen = Object.freeze({ operationId: operation.operationId, holderId: operation.holderId });
    if (!await this.accountMatches()) return { status: "unavailable" };
    if (!freshCreationClaim(creationStartedAtMs)) return { status: "unknown" };
    const body = new URLSearchParams({
      mode: "payment", "line_items[0][price]": this.config.priceId, "line_items[0][quantity]": "1",
      "managed_payments[enabled]": "true", client_reference_id: frozen.holderId,
      "metadata[operation_id]": frozen.operationId,
      success_url: this.config.successUrl, cancel_url: this.config.cancelUrl,
    });
    const created = session(await this.request(STRIPE, { method: "POST", headers: {
      ...this.stripeHeaders(), "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `${this.mode.idempotency}${frozen.operationId}`,
    }, body }), frozen, this.mode);
    // Once POST is dispatched, rejection/timeout cannot prove Stripe did not create
    // a Session. Keep the operation claimed, including its verified ID when known.
    if (!created) return { status: "unknown" };
    const row = await this.readSession(frozen, created.id as string, true);
    if (!row) return { status: "unknown", sessionId: created.id as string };
    // Retain a verified provider ID after a lost POST acknowledgement. The caller
    // persists it on the same frozen operation; recovery never authorizes access,
    // releases an unknown operation or chooses a fresh idempotency key.
    return this.recovery(row);
  }

  // A successful import is only a tracking acknowledgement. The caller must independently
  // reconcile RevenueCat's canonical purchase in this environment before issuing any access proof.
  async trackCompletedPurchase(operation: CheckoutOperation, sessionId: string): Promise<{ readonly status: "tracked" } | Unavailable> {
    if (!binding(operation) || !this.mode.sessionId.test(sessionId)) return { status: "unavailable" };
    const frozen = Object.freeze({ operationId: operation.operationId, holderId: operation.holderId });
    const deadline = performance.now() + this.timeoutMs;
    const row = await this.readSession(frozen, sessionId, false, deadline);
    if (!row || row.status !== "complete" || row.payment_status !== "paid" || typeof row.payment_intent !== "string" ||
      !/^pi_[A-Za-z0-9]{1,200}$/.test(row.payment_intent)) return { status: "unavailable" };
    // Checkout Sessions retain paid status after refund. Canonical PaymentIntent/Charge
    // readback blocks already-refunded receipts before import, independently of webhook order.
    // A refund arriving AFTER this read remains a distributed provider consistency gate.
    const intent = object(await this.request(`https://api.stripe.com/v1/payment_intents/${row.payment_intent}`, { headers: this.stripeHeaders() }, false, deadline));
    if (!intent || intent.object !== "payment_intent" || intent.id !== row.payment_intent || intent.livemode !== this.mode.live ||
      intent.currency !== "usd" || intent.amount !== row.amount_total || intent.status !== "succeeded" ||
      typeof intent.latest_charge !== "string" || !/^ch_[A-Za-z0-9]{1,200}$/.test(intent.latest_charge)) return { status: "unavailable" };
    const charge = object(await this.request(`https://api.stripe.com/v1/charges/${intent.latest_charge}`, { headers: this.stripeHeaders() }, false, deadline));
    if (!charge || charge.object !== "charge" || charge.id !== intent.latest_charge || charge.payment_intent !== intent.id ||
      charge.livemode !== this.mode.live || charge.currency !== "usd" || charge.paid !== true || charge.amount !== row.amount_total ||
      typeof charge.amount_refunded !== "number" || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 ||
      charge.amount_refunded > (charge.amount as number) || typeof charge.refunded !== "boolean" ||
      charge.refunded !== (charge.amount_refunded === charge.amount) || charge.refunded) return { status: "unavailable" };
    const imported = await this.request(RECEIPTS, { method: "POST", headers: {
      "Content-Type": "application/json", "X-Platform": "stripe",
      Authorization: `Bearer ${this.config.revenueCatStripePublicKey}`,
    }, body: JSON.stringify({ fetch_token: sessionId, app_user_id: frozen.holderId }) }, true, deadline);
    return imported !== null ? { status: "tracked" } : { status: "unavailable" };
  }
}
