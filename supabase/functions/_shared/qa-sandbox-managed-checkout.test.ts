import { assertEquals, assertThrows } from "@std/assert";
import { QA_STRIPE_API_VERSION, QaSandboxManagedCheckout, type QaManagedCheckoutConfig } from "./qa-sandbox-managed-checkout.ts";

const OP = { operationId: "22222222-2222-2222-2222-222222222222", holderId: "11111111-1111-1111-1111-111111111111" };
const ID = "cs_test_Fixture123";
const CONFIG: QaManagedCheckoutConfig = {
  stripeTestKey: "sk_test_SyntheticSecret123", priceId: "price_Fixture", productId: "prod_Fixture", stripeAccountId: "acct_Fixture",
  revenueCatStripePublicKey: "syntheticStripePublic123", successUrl: "https://stillapp.fit/qa/success", cancelUrl: "https://stillapp.fit/qa/cancel",
};
const UNAVAILABLE = { status: "unavailable" };
const UNKNOWN = { status: "unknown" } as const;
const UNKNOWN_SESSION = { status: "unknown", sessionId: ID } as const;
function checkout(paid = false): Record<string, unknown> {
  return { object: "checkout.session", id: ID, livemode: false, mode: "payment", managed_payments: { enabled: true },
    client_reference_id: OP.holderId, metadata: { operation_id: OP.operationId }, currency: "usd", amount_subtotal: 999, amount_total: 1087,
    status: paid ? "complete" : "open", payment_status: paid ? "paid" : "unpaid", url: paid ? null : `https://checkout.stripe.com/c/pay/${ID}#fixture%3Dabc` };
}
function lines(): Record<string, unknown> {
  return { object: "list", has_more: false, data: [{ object: "item", quantity: 1, currency: "usd", amount_subtotal: 999, amount_total: 1087,
    price: { object: "price", id: CONFIG.priceId, currency: "usd", unit_amount: 999, type: "one_time", recurring: null, livemode: false,
      product: { object: "product", id: CONFIG.productId, livemode: false } } }] };
}
type Call = { url: string; init: RequestInit };
function fixture(options: {
  paid?: boolean;
  replace?: (url: string, init: RequestInit, index: number) => Response | Promise<Response> | undefined;
  session?: Record<string, unknown>;
  items?: Record<string, unknown>;
  timeout?: number;
  config?: QaManagedCheckoutConfig;
} = {}) {
  const calls: Call[] = [];
  const fetcher = ((url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    const changed = options.replace?.(target, init, calls.length);
    const payload = target.endsWith("/account") ? { object: "account", id: CONFIG.stripeAccountId } :
      target.includes("/line_items?") ? options.items ?? lines() : target.includes("revenuecat.com") ? {} : options.session ?? checkout(options.paid);
    return Promise.resolve(changed ?? new Response(JSON.stringify(payload)));
  }) as typeof fetch;
  return { calls, client: new QaSandboxManagedCheckout(options.config ?? CONFIG, fetcher, options.timeout ?? 8000) };
}

Deno.test("managed creation checks canonical account, session and sole expanded price before returning URL", async () => {
  const { client, calls } = fixture();
  assertEquals(await client.createCheckout(OP, Date.now()), { status: "created", sessionId: ID, checkoutUrl: checkout().url as string });
  assertEquals(calls.map((c) => c.url), ["https://api.stripe.com/v1/account", "https://api.stripe.com/v1/checkout/sessions",
    `https://api.stripe.com/v1/checkout/sessions/${ID}`,
    `https://api.stripe.com/v1/checkout/sessions/${ID}/line_items?limit=2&expand%5B%5D=data.price.product`]);
  for (const call of calls) {
    assertEquals(call.init.redirect, "error");
    assertEquals(new Headers(call.init.headers).get("Stripe-Version"), QA_STRIPE_API_VERSION);
    assertEquals(new Headers(call.init.headers).get("Stripe-Account"), null);
  }
  assertEquals([...new URLSearchParams(calls[1]!.init.body as URLSearchParams).entries()].sort(), [
    ["mode", "payment"], ["line_items[0][price]", CONFIG.priceId], ["line_items[0][quantity]", "1"],
    ["managed_payments[enabled]", "true"], ["client_reference_id", OP.holderId], ["metadata[operation_id]", OP.operationId],
    ["success_url", CONFIG.successUrl], ["cancel_url", CONFIG.cancelUrl],
  ].sort()); // Exact allowlist also proves unsupported tax/payment-method/Connect fields absent.
});
Deno.test("each initial operation has its stable distinct idempotency key", async () => {
  const { client, calls } = fixture();
  await client.createCheckout(OP, Date.now());
  await client.createCheckout({ ...OP, operationId: "33333333-3333-3333-3333-333333333333" }, Date.now());
  const keys = calls.filter((c) => c.init.method === "POST").map((c) => new Headers(c.init.headers).get("Idempotency-Key"));
  assertEquals(keys, [`still-qa-managed-${OP.operationId}`, "still-qa-managed-33333333-3333-3333-3333-333333333333"]);
});
Deno.test("invalid server config fails locally and never accepts live keys, native SDK keys or dynamic return URLs", () => {
  for (const patch of [{ stripeTestKey: "sk_live_SyntheticSecret123" }, { stripeTestKey: "pk_test_SyntheticSecret123" },
    { priceId: "price_x/../y" }, { productId: "prod_x?evil" }, { stripeAccountId: "acct_x/evil" },
    { revenueCatStripePublicKey: "appl_SyntheticSecret123" }, { revenueCatStripePublicKey: "goog_SyntheticSecret123" },
    { revenueCatStripePublicKey: "sk_test_SyntheticSecret123" }, { revenueCatStripePublicKey: "bad\npublickey12345" },
    { successUrl: "http://stillapp.fit/qa/success" }, { cancelUrl: "https://evil.test@stillapp.fit/qa/cancel" },
    { successUrl: "https://stillapp.fit:443/qa/success" }, { successUrl: "https://stillapp.fit/qa/success?redirect=evil" },
    { successUrl: "https://stillapp.fit/qa/../success" }, { cancelUrl: "https://stillapp.fit/qa/cancel#evil" }]) {
    assertThrows(() => new QaSandboxManagedCheckout({ ...CONFIG, ...patch }), Error, "qa_checkout_unconfigured");
  }
  assertThrows(() => new QaSandboxManagedCheckout(CONFIG, fetch, 8001), Error, "qa_checkout_unconfigured");
});
Deno.test("RevenueCat public-key token accepts approved 1..1024 ASCII bounds without inventing a prefix or minimum", () => {
  for (const key of ["x", "a".repeat(1024), "synthetic_ABC-123"]) {
    assertEquals(new QaSandboxManagedCheckout({ ...CONFIG, revenueCatStripePublicKey: key }) instanceof QaSandboxManagedCheckout, true);
  }
  for (const key of ["", "a".repeat(1025), "has whitespace", "nonasciié", "appl_key", "goog_key", "amzn_key", "sk_key", "rk_key", "pk_key"]) {
    assertThrows(() => new QaSandboxManagedCheckout({ ...CONFIG, revenueCatStripePublicKey: key }), Error, "qa_checkout_unconfigured");
  }
});
Deno.test("invalid caller bindings and non-sandbox session IDs never reach providers", async () => {
  const { client, calls } = fixture();
  assertEquals(await client.createCheckout({ ...OP, holderId: "email@example.test" }, Date.now()), UNAVAILABLE);
  assertEquals(await client.createCheckout({ ...OP, operationId: "../../operation" }, Date.now()), UNAVAILABLE);
  for (const id of ["cs_live_Fixture", `${ID}/line_items`, `cs_test_${"x".repeat(201)}`]) assertEquals(await client.trackCompletedPurchase(OP, id), UNAVAILABLE);
  assertEquals(calls.length, 0);
});
Deno.test("wrong Stripe account fails before creation or receipt import", async () => {
  const { client, calls } = fixture({ replace: (url) => url.endsWith("/account") ? new Response(JSON.stringify({ object: "account", id: "acct_Other" })) : undefined });
  assertEquals(await client.createCheckout(OP, Date.now()), UNAVAILABLE);
  assertEquals(await client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
  assertEquals(calls.length, 2);
});
Deno.test("unknown/live/unmanaged/wrong-identity session fields fail closed at creation and completion", async () => {
  for (const patch of [{ object: "other" }, { id: "cs_live_Fixture" }, { livemode: true }, { livemode: null }, { mode: "subscription" },
    { managed_payments: null }, { managed_payments: {} }, { managed_payments: { enabled: false } },
    { client_reference_id: "33333333-3333-3333-3333-333333333333" }, { metadata: { operation_id: "other" } },
    { currency: "eur" }, { amount_total: 0 }, { amount_subtotal: null }, { amount_total: 1.5 }]) {
    const { client, calls } = fixture({ session: { ...checkout(true), ...patch } });
    assertEquals(await client.createCheckout(OP, Date.now()), UNKNOWN);
    assertEquals(await client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
    assertEquals(calls.some((c) => c.url.includes("revenuecat.com")), false);
  }
});
Deno.test("creation uses readback identity and managed flag rather than only the successful POST", async () => {
  for (const patch of [{ id: "cs_test_Other" }, { managed_payments: { enabled: false } },
    { client_reference_id: "33333333-3333-3333-3333-333333333333" }]) {
    const { client } = fixture({ replace: (url, init) => url.endsWith(`/${ID}`) && !init.method ? new Response(JSON.stringify({ ...checkout(), ...patch })) : undefined });
    assertEquals(await client.createCheckout(OP, Date.now()), UNKNOWN_SESSION);
  }
});
Deno.test("checkout URLs cannot escape exact Stripe origin, path, session or bounded fragment", async () => {
  for (const url of ["https://evil.test/checkout", `https://checkout.stripe.com.evil.test/c/pay/${ID}`,
    `https://checkout.stripe.com@evil.test/c/pay/${ID}`, `https://checkout.stripe.com:443/c/pay/${ID}`,
    `https://checkout.stripe.com/c/pay/${ID}?redirect=evil`, `https://checkout.stripe.com/c/pay/cs_test_Other`,
    `https://checkout.stripe.com/c/pay/${ID}#${"x".repeat(2049)}`, null]) {
    assertEquals(await fixture({ session: { ...checkout(), url } }).client.createCheckout(OP, Date.now()), UNKNOWN_SESSION);
  }
});
Deno.test("partial/multiple/wrong-price or product/nonpositive/recurring line items never hand off or import", async () => {
  const base = (lines().data as Record<string, unknown>[])[0]!;
  const price = base.price as Record<string, unknown>;
  const bad = [{ ...lines(), has_more: true }, { ...lines(), data: [] }, { ...lines(), data: [base, base] },
    ...[{ quantity: 2 }, { currency: "eur" }, { amount_total: 0 },
      { price: { ...price, id: "price_Other" } }, { price: { ...price, type: "recurring" } },
      { price: { ...price, recurring: {} } }, { price: { ...price, unit_amount: 0 } },
      { price: { ...price, livemode: true } }, { price: { ...price, product: "prod_Fixture" } },
      { price: { ...price, product: { object: "product", id: "prod_Other", livemode: false } } },
    ].map((patch) => ({ ...lines(), data: [{ ...base, ...patch }] }))];
  for (const items of bad) {
    const { client, calls } = fixture({ items, paid: true });
    assertEquals(await fixture({ items }).client.createCheckout(OP, Date.now()), UNKNOWN_SESSION);
    assertEquals(await client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
    assertEquals(calls.some((c) => c.url.includes("revenuecat.com")), false);
  }
});
Deno.test("only complete paid canonical managed session imports exact token and verified holder into RevenueCat", async () => {
  const { client, calls } = fixture({ paid: true });
  assertEquals(await client.trackCompletedPurchase(OP, ID), { status: "tracked" });
  const imported = calls.at(-1)!;
  assertEquals(imported.url, "https://api.revenuecat.com/v1/receipts");
  assertEquals(imported.init.method, "POST");
  assertEquals(new Headers(imported.init.headers).get("X-Platform"), "stripe");
  assertEquals(new Headers(imported.init.headers).get("Authorization"), `Bearer ${CONFIG.revenueCatStripePublicKey}`);
  assertEquals(JSON.parse(imported.init.body as string), { fetch_token: ID, app_user_id: OP.holderId });
});
Deno.test("unpaid, async processing, expired or unknown payment state cannot import", async () => {
  for (const patch of [{ status: "open" }, { status: "expired" }, { status: null }, { payment_status: "unpaid" },
    { payment_status: "no_payment_required" }, { payment_status: null }]) {
    const { client, calls } = fixture({ session: { ...checkout(true), ...patch } });
    assertEquals(await client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
    assertEquals(calls.some((c) => c.url.includes("revenuecat.com")), false);
  }
});
Deno.test("RevenueCat acknowledgement including empty 204 never returns a grant or provider payload", async () => {
  const { client } = fixture({ paid: true, replace: (url) => url.includes("revenuecat.com") ? new Response(null, { status: 204 }) : undefined });
  assertEquals(await client.trackCompletedPurchase(OP, ID), { status: "tracked" });
});
Deno.test("transport errors and all non-2xx provider responses are fixed unavailable outcomes", async () => {
  for (const status of [302, 400, 401, 403, 404, 429, 500]) {
    const { client } = fixture({ paid: true, replace: (url) => url.includes("revenuecat.com") ? new Response("private provider body", { status }) : undefined });
    assertEquals(await client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
  }
  const fetcher = (() => Promise.reject(new Error("private secret payload"))) as typeof fetch;
  const client = new QaSandboxManagedCheckout(CONFIG, fetcher);
  assertEquals(await client.createCheckout(OP, Date.now()), UNAVAILABLE);
  assertEquals(await client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
  const rcFailure = fixture({ paid: true, replace: (url) => {
    if (url.includes("revenuecat.com")) throw new Error("private RC error");
    return undefined;
  } });
  assertEquals(await rcFailure.client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
});
Deno.test("malformed, oversized and invalid UTF-8 response bodies fail closed", async () => {
  for (const response of [new Response("not JSON"), new Response("x".repeat(65537)),
    new Response("{}", { headers: { "content-length": "65537" } }),
    new Response("{}", { headers: { "content-length": "unknown" } }), new Response(new Uint8Array([0xff]))]) {
    assertEquals(await fixture({ replace: () => response }).client.createCheckout(OP, Date.now()), UNAVAILABLE);
  }
});
Deno.test("wrong account response type and Stripe error or redirect never yield a checkout", async () => {
  for (const response of [new Response(JSON.stringify({ object: "customer", id: CONFIG.stripeAccountId })),
    new Response("private error", { status: 401 }), new Response(null, { status: 302, headers: { Location: "https://evil.test" } })]) {
    const { client, calls } = fixture({ replace: () => response });
    assertEquals(await client.createCheckout(OP, Date.now()), UNAVAILABLE);
    assertEquals(calls.length, 1);
  }
});
Deno.test("oversized RevenueCat acknowledgement remains unavailable despite its 2xx status", async () => {
  const { client } = fixture({ paid: true, replace: (url) => url.includes("revenuecat.com") ? new Response("x".repeat(65537)) : undefined });
  assertEquals(await client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
});
Deno.test("timeout bounds even a transport that ignores AbortSignal", async () => {
  const fetcher = (() => new Promise<Response>(() => {})) as typeof fetch;
  assertEquals(await new QaSandboxManagedCheckout(CONFIG, fetcher, 5).createCheckout(OP, Date.now()), UNAVAILABLE);
});
Deno.test("timeout cancels a stalled response body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const fetcher = (() => Promise.resolve(response)) as typeof fetch;
  assertEquals(await new QaSandboxManagedCheckout(CONFIG, fetcher, 5).createCheckout(OP, Date.now()), UNAVAILABLE);
  assertEquals(cancelled, true);
});
Deno.test("operation and config mutation during awaits cannot change the frozen checkout binding", async () => {
  const operation = { ...OP };
  const config = { ...CONFIG };
  const { client, calls } = fixture({ config, replace: (_url, _init, index) => {
    if (index === 1) operation.holderId = "33333333-3333-3333-3333-333333333333";
    return undefined;
  } });
  config.priceId = "price_Attacker";
  assertEquals((await client.createCheckout(operation, Date.now())).status, "created");
  assertEquals(new URLSearchParams(calls[1]!.init.body as URLSearchParams).get("client_reference_id"), OP.holderId);
  assertEquals(new URLSearchParams(calls[1]!.init.body as URLSearchParams).get("line_items[0][price]"), CONFIG.priceId);
});

Deno.test("lost POST acknowledgement recovers the original paid Session through GET only", async () => {
  let creations = 0;
  const { client, calls } = discovery([sessionList([listedSession()])], { paid: true, replace: (url, init) => {
    if (url.endsWith("/checkout/sessions") && init.method === "POST") {
      creations++;
      // Stripe accepted the one-way claim, but the acknowledgement was lost.
      throw new Error("lost acknowledgement");
    }
    return undefined;
  } });
  assertEquals(await client.createCheckout(OP, CLAIMED_AT), UNKNOWN);
  const recovered = await client.recoverUnknownCheckout(OP, CLAIMED_AT);
  assertEquals(recovered, { status: "recovered", sessionId: ID, paymentState: "paid" });
  assertEquals("checkoutUrl" in recovered, false);
  assertEquals(await client.trackCompletedPurchase(OP, ID), { status: "tracked" });
  const posts = calls.filter((call) => call.init.method === "POST" && call.url.includes("stripe.com"));
  assertEquals(creations, 1);
  assertEquals(posts.length, 1);
  assertEquals(new Headers(posts[0]!.init.headers).get("Idempotency-Key"), `still-qa-managed-${OP.operationId}`);
  const imported = calls.find((call) => call.url.includes("revenuecat.com"))!;
  assertEquals(JSON.parse(imported.init.body as string), { fetch_token: ID, app_user_id: OP.holderId });
});
Deno.test("canonical expired unpaid and complete unpaid sessions recover IDs without checkout URL or rights", async () => {
  for (const [status, paymentState] of [["expired", "expired_unpaid"], ["complete", "payment_pending"]] as const) {
    const { client, calls } = fixture({ session: { ...checkout(), status, payment_status: "unpaid", url: null } });
    assertEquals(await client.createCheckout(OP, Date.now()), { status: "recovered", sessionId: ID, paymentState });
    assertEquals(await client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
    assertEquals(calls.some((call) => call.url.includes("revenuecat.com")), false);
  }
});
Deno.test("unknown or contradictory canonical payment state retains only the original bound ID as unknown", async () => {
  for (const [status, payment_status] of [["open", "paid"], ["expired", "paid"], ["complete", "no_payment_required"],
    ["unknown", "unpaid"], ["complete", "unknown"], [null, "paid"]]) {
    assertEquals(await fixture({ session: { ...checkout(), status, payment_status } }).client.createCheckout(OP, Date.now()), UNKNOWN_SESSION);
  }
});
Deno.test("current fixed offer requires 999-cent Price and consistent single-item subtotals and totals", async () => {
  const line = (lines().data as Record<string, unknown>[])[0]!;
  const price = line.price as Record<string, unknown>;
  for (const patch of [{ price: { ...price, unit_amount: 998 } }, { price: { ...price, unit_amount: 1000 } },
    { amount_subtotal: 998 }, { amount_total: 1086 }]) {
    const items = { ...lines(), data: [{ ...line, ...patch }] };
    assertEquals(await fixture({ items }).client.createCheckout(OP, Date.now()), UNKNOWN_SESSION);
    assertEquals(await fixture({ items, paid: true }).client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
  }
  for (const patch of [{ amount_subtotal: 998 }, { amount_total: 1086 }]) {
    assertEquals(await fixture({ session: { ...checkout(), ...patch } }).client.createCheckout(OP, Date.now()),
      "amount_subtotal" in patch ? UNKNOWN : UNKNOWN_SESSION);
    assertEquals(await fixture({ session: { ...checkout(true), ...patch } }).client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
  }
});

Deno.test("valid 999-cent inclusive or 1087-cent exclusive totals do not require invented tax arithmetic", async () => {
  for (const amount_total of [999, 1087]) {
    const line = (lines().data as Record<string, unknown>[])[0]!;
    const items = { ...lines(), data: [{ ...line, amount_total }] };
    assertEquals(await fixture({ items, session: { ...checkout(), amount_total } }).client.createCheckout(OP, Date.now()),
      { status: "created", sessionId: ID, checkoutUrl: checkout().url as string });
    assertEquals(await fixture({ items, session: { ...checkout(true), amount_total } }).client.trackCompletedPurchase(OP, ID), { status: "tracked" });
  }
});

Deno.test("successful POST retains its verified ID when canonical session or line-item readback fails", async () => {
  for (const failedPath of [`/checkout/sessions/${ID}`, "/line_items?"]) {
    for (const failure of ["timeout", "http500"]) {
      const { client, calls } = fixture({ timeout: 5, replace: (url, init) => {
        if (!init.method && (failedPath === "/line_items?" ? url.includes(failedPath) : url.endsWith(failedPath))) {
          return failure === "timeout" ? new Promise<Response>(() => {}) : new Response("private failure", { status: 500 });
        }
        return undefined;
      } });
      const result = await client.createCheckout(OP, Date.now());
      assertEquals(result, UNKNOWN_SESSION);
      assertEquals("checkoutUrl" in result, false);
      assertEquals(calls.filter((call) => call.init.method === "POST").length, 1);
      assertEquals(calls.some((call) => call.url.includes("revenuecat.com")), false);
    }
  }
});
Deno.test("post-dispatch malformed reply, error or timeout is unknown without an unverified session ID", async () => {
  for (const response of ["timeout", "http500", "malformed", "wrong_holder"]) {
    const { client, calls } = fixture({ timeout: 5, replace: (_url, init) => {
      if (init.method !== "POST") return undefined;
      return response === "timeout" ? new Promise<Response>(() => {}) : response === "http500" ? new Response("private error", { status: 500 }) :
        response === "malformed" ? new Response("not JSON") : new Response(JSON.stringify({ ...checkout(), client_reference_id: "other" }));
    } });
    assertEquals(await client.createCheckout(OP, Date.now()), UNKNOWN);
    assertEquals(calls.length, 2);
  }
});
Deno.test("rotated account, Price or product fails closed for a previously bound paid session", async () => {
  for (const patch of [{ stripeAccountId: "acct_Other" }, { priceId: "price_Other" }, { productId: "prod_Other" }]) {
    const { client, calls } = fixture({ paid: true, config: { ...CONFIG, ...patch } });
    assertEquals(await client.trackCompletedPurchase(OP, ID), UNAVAILABLE);
    assertEquals(calls.some((call) => call.init.method === "POST"), false);
    assertEquals(calls.some((call) => call.url.includes("revenuecat.com")), false);
  }
});

Deno.test("known Session recovery is strictly GET-only for open, paid, pending and expired canonical state", async () => {
  for (const [status, payment_status, expected] of [
    ["open", "unpaid", { status: "created", sessionId: ID, checkoutUrl: checkout().url }],
    ["complete", "paid", { status: "recovered", sessionId: ID, paymentState: "paid" }],
    ["complete", "unpaid", { status: "recovered", sessionId: ID, paymentState: "payment_pending" }],
    ["expired", "unpaid", { status: "recovered", sessionId: ID, paymentState: "expired_unpaid" }],
  ]) {
    const { client, calls } = fixture({ session: { ...checkout(), status, payment_status } });
    assertEquals(await client.recoverCheckout(OP, ID), expected as unknown);
    assertEquals(calls.length, 3);
    assertEquals(calls.every((call) => !call.init.method || call.init.method === "GET"), true);
    assertEquals(calls.some((call) => call.url.includes("revenuecat.com")), false);
  }
});
Deno.test("known recovery retains caller-bound ID on readback failure and validates inputs before transport", async () => {
  const { client, calls } = fixture({ replace: (url) => url.endsWith(`/${ID}`) ? new Response(null, { status: 503 }) : undefined });
  assertEquals(await client.recoverCheckout(OP, ID), UNKNOWN_SESSION);
  assertEquals(await client.recoverCheckout(OP, "cs_live_Other"), UNKNOWN);
  assertEquals(await client.recoverCheckout({ ...OP, holderId: "other" }, ID), UNKNOWN);
  assertEquals(calls.length, 2);
  assertEquals(calls.every((call) => !call.init.method), true);
});

const CLAIMED_AT = Date.now() - 1000;
Deno.test("creation rejects invalid or stale persisted claims before provider transport", async () => {
  const { client, calls } = fixture();
  for (const claim of [0, -1, NaN, Infinity, Date.now() + 10000, Date.now() - 121000, Date.now() - 25 * 60 * 60 * 1000]) {
    assertEquals(await Reflect.apply(client.createCheckout, client, [OP, claim]), UNKNOWN);
  }
  assertEquals(calls.length, 0);
});
function listedSession(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...checkout(), created: Math.floor(CLAIMED_AT / 1000), ...patch };
}
function sessionList(data: unknown[], has_more = false): Record<string, unknown> {
  return { object: "list", url: "/v1/checkout/sessions", data, has_more };
}
function discovery(pages: Record<string, unknown>[], options: Parameters<typeof fixture>[0] = {}) {
  let page = 0;
  return fixture({ ...options, replace: (url, init, index) => {
    const changed = options.replace?.(url, init, index);
    if (changed) return changed;
    if (url.includes("/checkout/sessions?")) return new Response(JSON.stringify(pages[page++] ?? null));
    return undefined;
  } });
}
Deno.test("unknown-ID discovery uses exact bounded created window and recovers a unique canonical paid Session without POST", async () => {
  const unrelated = listedSession({ id: "cs_test_Unrelated", metadata: { operation_id: "other" } });
  const { client, calls } = discovery([sessionList([unrelated], true), sessionList([listedSession()])], { paid: true });
  assertEquals(await client.recoverUnknownCheckout(OP, CLAIMED_AT), { status: "recovered", sessionId: ID, paymentState: "paid" });
  const listCalls = calls.filter((call) => call.url.includes("/checkout/sessions?"));
  assertEquals(listCalls.length, 2);
  for (const [index, call] of listCalls.entries()) {
    const url = new URL(call.url);
    assertEquals(url.origin, "https://api.stripe.com");
    assertEquals([...url.searchParams.entries()], [["created[gte]", String(Math.floor(CLAIMED_AT / 1000) - 300)],
      ["created[lte]", String(Math.floor(CLAIMED_AT / 1000) + 300)], ["limit", "100"], ...(index ? [["starting_after", "cs_test_Unrelated"]] : [])]);
  }
  assertEquals(calls.every((call) => !call.init.method), true);
});
Deno.test("unique complete discovery retains Session identity when canonical readback fails", async () => {
  const { client, calls } = discovery([sessionList([listedSession()])], {
    replace: (url) => url.endsWith(`/${ID}`) ? new Response(null, { status: 503 }) : undefined,
  });
  assertEquals(await client.recoverUnknownCheckout(OP, CLAIMED_AT), UNKNOWN_SESSION);
  assertEquals(calls.every(call => !call.init.method), true);
});
Deno.test("unknown discovery never treats zero, ambiguous, incomplete or malformed pagination as absence", async () => {
  const other = listedSession({ id: "cs_test_Other" });
  const cases = [[sessionList([])], [sessionList([listedSession(), other])], [sessionList([], true)],
    [sessionList([listedSession()], true), sessionList([other])],
    [sessionList([listedSession()], true), sessionList([listedSession()])],
    [sessionList([listedSession()], true), { ...sessionList([]), has_more: "false" }],
    [{ ...sessionList([listedSession()]), url: "https://evil.test/list" }],
    [sessionList([listedSession({ created: Math.floor(CLAIMED_AT / 1000) + 301 })])],
    [sessionList([listedSession({ id: "cs_live_Other" })])],
    [sessionList([listedSession({ livemode: true })])],
    [sessionList(Array.from({ length: 101 }, (_, index) => listedSession({ id: `cs_test_Row${index}` })))],
    Array.from({ length: 4 }, (_, index) => sessionList([listedSession({ id: `cs_test_Page${index}`, metadata: {} })], true))];
  for (const pages of cases) {
    const { client, calls } = discovery(pages);
    assertEquals(await client.recoverUnknownCheckout(OP, CLAIMED_AT), UNKNOWN);
    assertEquals(calls.every((call) => !call.init.method), true);
    assertEquals(calls.filter((call) => call.url.includes("/checkout/sessions?")).length <= 4, true);
  }
});
Deno.test("discovery rejects wrong list scope and retains unique ID without authority on failed canonical readback", async () => {
  for (const row of [listedSession({ client_reference_id: "other" }), listedSession({ metadata: { operation_id: "other" } })]) {
    assertEquals(await discovery([sessionList([row])]).client.recoverUnknownCheckout(OP, CLAIMED_AT), UNKNOWN);
  }
  const wrongAccount = discovery([sessionList([listedSession()])], { config: { ...CONFIG, stripeAccountId: "acct_Other" } });
  assertEquals(await wrongAccount.client.recoverUnknownCheckout(OP, CLAIMED_AT), UNKNOWN);
  assertEquals(wrongAccount.calls.length, 1);
  for (const session of [{ ...checkout(), managed_payments: { enabled: false } }, { ...checkout(), client_reference_id: "other" }]) {
    assertEquals(await discovery([sessionList([listedSession()])], { session }).client.recoverUnknownCheckout(OP, CLAIMED_AT), UNKNOWN_SESSION);
  }
});
Deno.test("discovery permits arbitrarily old persisted claims while rejecting invalid or future timestamps locally", async () => {
  const oldClaim = CLAIMED_AT - 400 * 24 * 60 * 60 * 1000;
  const { client, calls } = discovery([sessionList([listedSession({ created: Math.floor(oldClaim / 1000) })])], { paid: true });
  assertEquals(await client.recoverUnknownCheckout(OP, oldClaim), { status: "recovered", sessionId: ID, paymentState: "paid" });
  const count = calls.length;
  for (const time of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER, Date.now() + 10000]) {
    assertEquals(await client.recoverUnknownCheckout(OP, time), UNKNOWN);
  }
  assertEquals(calls.length, count);
});
Deno.test("discovery shares one total deadline across pagination and never starts canonical reads after expiry", async () => {
  let cancelled = false;
  const { client, calls } = discovery([], { timeout: 20, replace: (url, init, index) => {
    if (!url.includes("/checkout/sessions?")) return undefined;
    return new Promise<Response>((resolve) => {
      const abort = () => { cancelled = true; clearTimeout(timer); resolve(new Response(null, { status: 503 })); };
      const timer = setTimeout(() => {
        init.signal?.removeEventListener("abort", abort);
        resolve(new Response(JSON.stringify(sessionList([listedSession({ id: `cs_test_Delay${index}`, metadata: {} })], true))));
      }, 12);
      init.signal?.addEventListener("abort", abort, { once: true });
    });
  } });
  assertEquals(await client.recoverUnknownCheckout(OP, CLAIMED_AT), UNKNOWN);
  assertEquals(cancelled, true);
  assertEquals(calls.length <= 3, true);
  assertEquals(calls.every((call) => !call.init.method), true);
  assertEquals(calls.some((call) => call.url.endsWith(`/${ID}`)), false);
});
