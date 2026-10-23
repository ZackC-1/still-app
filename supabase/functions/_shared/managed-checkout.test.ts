import { assertEquals, assertThrows } from "@std/assert";
import { ManagedCheckout, type ManagedCheckoutConfig } from "./managed-checkout.ts";

const OP = { operationId: "22222222-2222-2222-2222-222222222222", holderId: "11111111-1111-1111-1111-111111111111" };
const ID = "cs_live_Fixture123";
const CONFIG: ManagedCheckoutConfig = {
  environment: "production", stripeSecretKey: "sk_live_SyntheticSecret123", stripeAccountId: "acct_Fixture",
  priceId: "price_Fixture", productId: "prod_Fixture", revenueCatStripePublicKey: "syntheticStripePublic123",
  successUrl: "https://stillapp.fit/checkout/success", cancelUrl: "https://stillapp.fit/checkout/cancel",
};
type Payload = Record<string, unknown>;
function fixture(options: { paid?: boolean; refund?: boolean; patch?: (kind: string, value: Payload) => Payload } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const started = Date.now();
  const session = { object: "checkout.session", id: ID, livemode: true, mode: "payment", managed_payments: { enabled: true },
    client_reference_id: OP.holderId, metadata: { operation_id: OP.operationId }, currency: "usd", amount_subtotal: 999, amount_total: 1087,
    payment_intent: "pi_Fixture", created: Math.floor(started / 1000), status: options.paid ? "complete" : "open",
    payment_status: options.paid ? "paid" : "unpaid", url: options.paid ? null : `https://checkout.stripe.com/c/pay/${ID}` };
  const apply = (kind: string, value: Payload): Payload => options.patch?.(kind, value) ?? value;
  const fetcher = ((url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    const product = apply("product", { object: "product", id: CONFIG.productId, livemode: true });
    const price = apply("price", { object: "price", id: CONFIG.priceId, currency: "usd", unit_amount: 999, type: "one_time", recurring: null, livemode: true, product });
    const payload = target.endsWith("/account") ? apply("account", { object: "account", id: CONFIG.stripeAccountId }) :
      target.includes("/line_items?") ? { object: "list", has_more: false, data: [{ object: "item", quantity: 1, currency: "usd", amount_subtotal: 999, amount_total: 1087, price }] } :
      target.includes("/payment_intents/") ? apply("intent", { object: "payment_intent", id: "pi_Fixture", livemode: true, currency: "usd", amount: 1087, status: "succeeded", latest_charge: "ch_Fixture" }) :
      target.includes("/charges/") ? apply("charge", { object: "charge", id: "ch_Fixture", livemode: true, currency: "usd", amount: 1087, status: "succeeded", paid: true,
        payment_intent: "pi_Fixture", amount_refunded: options.refund ? 1087 : 0, refunded: options.refund ?? false }) :
      target.includes("/sessions?") ? { object: "list", url: "/v1/checkout/sessions", has_more: false, data: [apply("session", session)] } :
      target.includes("revenuecat.com") ? {} : apply("session", session);
    return Promise.resolve(new Response(JSON.stringify(payload)));
  }) as typeof fetch;
  return { client: new ManagedCheckout(CONFIG, fetcher), calls, started };
}

Deno.test("production creates the fixed managed offer and keeps a separate idempotency namespace", async () => {
  const { client, calls } = fixture();
  assertEquals(await client.createCheckout(OP, Date.now()), { status: "created", sessionId: ID, checkoutUrl: `https://checkout.stripe.com/c/pay/${ID}` });
  const create = calls.find(call => call.init.method === "POST")!;
  const body = create.init.body as URLSearchParams;
  assertEquals(body.get("managed_payments[enabled]"), "true");
  assertEquals(body.get("line_items[0][price]"), CONFIG.priceId);
  assertEquals(body.get("client_reference_id"), OP.holderId);
  assertEquals(new Headers(create.init.headers).get("Idempotency-Key"), `still-production-managed-${OP.operationId}`);
  assertEquals(new Headers(create.init.headers).get("Authorization"), `Bearer ${CONFIG.stripeSecretKey}`);
});

Deno.test("environment and credential mode must agree before any request", () => {
  for (const patch of [{ environment: undefined }, { environment: "live" }, { environment: "sandbox" },
    { stripeSecretKey: "sk_test_SyntheticSecret123" }, { stripeSecretKey: "pk_live_SyntheticSecret123" }]) {
    assertThrows(() => new ManagedCheckout({ ...CONFIG, ...patch } as ManagedCheckoutConfig));
  }
  assertEquals(new ManagedCheckout({ ...CONFIG, stripeSecretKey: "rk_live_SyntheticSecret123" }) instanceof ManagedCheckout, true);
});

Deno.test("production rejects test-mode IDs before contacting providers", async () => {
  const { client, calls } = fixture();
  assertEquals(await client.recoverCheckout(OP, "cs_test_Fixture123"), { status: "unknown" });
  assertEquals(await client.trackCompletedPurchase(OP, "cs_test_Fixture123"), { status: "unavailable" });
  assertEquals(calls.length, 0);
});

Deno.test("production receipt import verifies live mode at every provider layer and binds the holder", async () => {
  const { client, calls } = fixture({ paid: true });
  assertEquals(await client.trackCompletedPurchase(OP, ID), { status: "tracked" });
  const imported = calls.filter(call => call.url.includes("revenuecat.com"));
  assertEquals(imported.length, 1);
  assertEquals(JSON.parse(imported[0]!.init.body as string), { fetch_token: ID, app_user_id: OP.holderId });
  for (const kind of ["session", "price", "product", "intent", "charge"]) {
    for (const livemode of [false, undefined, "true"]) {
      const wrong = fixture({ paid: true, patch: (name, value) => name === kind ? { ...value, livemode } : value });
      assertEquals(await wrong.client.trackCompletedPurchase(OP, ID), { status: "unavailable" }, `${kind}: ${livemode}`);
      assertEquals(wrong.calls.some(call => call.url.includes("revenuecat.com")), false);
    }
  }
});

Deno.test("production unknown-session recovery is read-only and rejects sandbox results", async () => {
  const { client, calls, started } = fixture({ paid: true });
  assertEquals(await client.recoverUnknownCheckout(OP, started), { status: "recovered", sessionId: ID, paymentState: "paid" });
  assertEquals(calls.every(call => !call.init.method || call.init.method === "GET"), true);
  for (const patch of [{ livemode: false }, { id: "cs_test_Fixture123" }]) {
    const wrong = fixture({ paid: true, patch: (name, value) => name === "session" ? { ...value, ...patch } : value });
    assertEquals(await wrong.client.recoverUnknownCheckout(OP, wrong.started), { status: "unknown" });
  }
});

Deno.test("production refunds require canonical live binding and never import a refunded receipt", async () => {
  const { client, calls, started } = fixture({ paid: true, refund: true });
  assertEquals(await client.readChargeRefund("ch_Fixture"), { status: "full_refund", ...OP, sessionId: ID, paymentIntentId: "pi_Fixture", createdAtMs: Math.floor(started / 1000) * 1000 });
  assertEquals(await client.trackCompletedPurchase(OP, ID), { status: "unavailable" });
  assertEquals(calls.some(call => call.url.includes("revenuecat.com")), false);
  for (const kind of ["charge", "session", "price", "product"]) {
    const wrong = fixture({ paid: true, refund: true, patch: (name, value) => name === kind ? { ...value, livemode: false } : value });
    assertEquals(await wrong.client.readChargeRefund("ch_Fixture"), { status: "unknown" }, kind);
  }
});

// Adaptive Pricing (https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing):
// Session and PaymentIntent stay in the integration currency (usd, 999 subtotal); the customer's
// local currency appears only in presentment_details. The Charge's presentment_details likewise
// describes conversion "from the integration currency" (https://docs.stripe.com/api/charges/object).
const EUR = { presentment_amount: 899, presentment_currency: "eur" };
const adaptive = (kind: string, value: Payload): Payload =>
  ["session", "intent", "charge"].includes(kind) ? { ...value, presentment_details: EUR } : value;

Deno.test("Adaptive Pricing: a usd session presented in EUR still recovers by bound ID and by window search", async () => {
  const bound = fixture({ paid: true, patch: adaptive });
  assertEquals(await bound.client.recoverCheckout(OP, ID), { status: "recovered", sessionId: ID, paymentState: "paid" });
  const open = fixture({ patch: adaptive });
  assertEquals(await open.client.recoverCheckout(OP, ID), { status: "created", sessionId: ID, checkoutUrl: `https://checkout.stripe.com/c/pay/${ID}` });
  const unknown = fixture({ paid: true, patch: adaptive });
  assertEquals(await unknown.client.recoverUnknownCheckout(OP, unknown.started), { status: "recovered", sessionId: ID, paymentState: "paid" });
  assertEquals(unknown.calls.every(call => !call.init.method || call.init.method === "GET"), true);
});

Deno.test("Adaptive Pricing: a usd charge presented in EUR is imported once and its refund stays canonical", async () => {
  const { client, calls } = fixture({ paid: true, patch: adaptive });
  assertEquals(await client.trackCompletedPurchase(OP, ID), { status: "tracked" });
  const imported = calls.filter(call => call.url.includes("revenuecat.com"));
  assertEquals(imported.length, 1);
  assertEquals(JSON.parse(imported[0]!.init.body as string), { fetch_token: ID, app_user_id: OP.holderId });
  const refunded = fixture({ paid: true, refund: true, patch: adaptive });
  assertEquals((await refunded.client.readChargeRefund("ch_Fixture")).status, "full_refund");
});

Deno.test("Adaptive Pricing control: a session actually settled in a non-usd currency is still refused", async () => {
  for (const kind of ["session", "intent", "charge"]) {
    const wrong = fixture({ paid: true, patch: (name, value) => name === kind ? { ...adaptive(name, value), currency: "eur" } : value });
    assertEquals(await wrong.client.trackCompletedPurchase(OP, ID), { status: "unavailable" }, kind);
    assertEquals(wrong.calls.some(call => call.url.includes("revenuecat.com")), false, kind);
  }
  const subtotal = fixture({ paid: true, patch: (name, value) => name === "session" ? { ...adaptive(name, value), amount_subtotal: 899 } : value });
  assertEquals(await subtotal.client.recoverCheckout(OP, ID), { status: "unknown", sessionId: ID });
});

Deno.test("refund readback refuses a charge that did not settle in usd", async () => {
  for (const currency of ["eur", "USD", undefined]) {
    const wrong = fixture({ paid: true, refund: true, patch: (name, value) => name === "charge" ? { ...adaptive(name, value), currency } : value });
    assertEquals(await wrong.client.readChargeRefund("ch_Fixture"), { status: "unknown" }, String(currency));
  }
});
