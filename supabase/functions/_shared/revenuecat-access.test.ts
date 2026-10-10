import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { HttpRevenueCatAccessClient, parseAccessProductMappings, stripeMappingsBoundTo, type AccessProductMapping } from "./revenuecat-access.ts";

const HOLDER = "11111111-1111-1111-1111-111111111111";
const MAPPING: AccessProductMapping = { product_id: "prod-current", app_id: "app-still", store_identifier: "still_pro_v3",
  entitlement_lookup_key: "still_pro_v3", store: "rc_billing" };
// Independent synthetic identities: the Stripe product is not a Checkout Session,
// RevenueCat purchase/product, or canonical Still benefit.
const STRIPE_MAPPING = { product_id: "rc-stripe-product", app_id: "rc-stripe-app", store_identifier: "provider_Stripe-product_42",
  entitlement_lookup_key: "still_pro_v3", store: "stripe", benefit_product: "still_pro_v3" } as const;
const ENT_PRO = "entlProFixture01";
const ENT_SYNC = "entlSyncFixture02";
const PURCHASES_URL = `https://api.revenuecat.com/v2/projects/proj-still/customers/${HOLDER}/purchases?environment=sandbox&limit=100`;
const entitlementUrl = (id: string) => `https://api.revenuecat.com/v2/projects/proj-still/entitlements/${encodeURIComponent(id)}?expand=product`;

// Live-verified 2026-10-10: a purchase's entitlement item carries exactly these keys and NEVER embeds
// products; the products come only from GET /entitlements/{id}?expand=product.
function entitlementRef(id: string, lookupKey: string) {
  return { created_at: 1791374000000, display_name: "Fixture", id, lookup_key: lookupKey, object: "entitlement",
    project_id: "proj-still", state: "active" };
}
function purchase() {
  return { country: "US", customer_id: HOLDER, entitlements: { object: "list", items: [entitlementRef(ENT_PRO, "still_pro_v3")],
    next_page: null, url: "/v2/projects/proj-still/purchases/purch-verified/entitlements" }, environment: "sandbox",
    id: "purch-verified", object: "purchase", original_customer_id: HOLDER, ownership: "purchased", presented_offering_id: null,
    product_id: MAPPING.product_id, purchased_at: 1791374400000, quantity: 1,
    revenue_in_usd: { commission: 0.3, currency: "USD", gross: 9.99, proceeds: 9.69, tax: 0 }, status: "owned",
    store: "rc_billing", store_purchase_identifier: "store-purchase-fixture" };
}
function stripePurchase(): ReturnType<typeof purchase> {
  return { ...purchase(), id: "rc-stripe-purchase", product_id: STRIPE_MAPPING.product_id, store: "stripe" };
}
type Product = { object: string; id: string; app_id: string; store_identifier: string; state: string; type: string;
  one_time: { is_consumable: unknown } | null; subscription: null; created_at: number; display_name: string };
type Entitlement = ReturnType<typeof entitlementRef> & { products: { object: string; items: Product[]; next_page: string | null; url: string } };
type Catalog = Record<string, Entitlement>;
function product(id: string, appId: string, storeIdentifier: string, isConsumable: unknown = false): Product {
  return { object: "product", id, app_id: appId, store_identifier: storeIdentifier, state: "active", type: "one_time",
    one_time: { is_consumable: isConsumable }, subscription: null, created_at: 1791374000000, display_name: "Fixture" };
}
function entitlementDoc(id: string, lookupKey: string, items: Product[]): Entitlement {
  return { ...entitlementRef(id, lookupKey), products: { object: "list", items, next_page: null, url: `/v2/projects/proj-still/entitlements/${id}/products` } };
}
/** The entitlement endpoint's view: Pro holds the RevenueCat Billing and Stripe price products. */
function catalog(): Catalog {
  return {
    [ENT_PRO]: entitlementDoc(ENT_PRO, "still_pro_v3", [product(MAPPING.product_id, MAPPING.app_id, "still_pro_v3"),
      product(STRIPE_MAPPING.product_id, STRIPE_MAPPING.app_id, STRIPE_MAPPING.store_identifier, null)]),
    [ENT_SYNC]: entitlementDoc(ENT_SYNC, "still_sync", [product("historic-product", MAPPING.app_id, "still_sync")]),
  };
}
const proProduct = (c: Catalog) => c[ENT_PRO]!.products.items[0]!;
const stripeProduct = (c: Catalog) => c[ENT_PRO]!.products.items[1]!;
type Call = { url: string; init?: RequestInit };
/** Routes the purchases list and the entitlement read; anything else is an unexpected request. */
function fakeRevenueCat(list: unknown, entitlement: (id: string) => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  return ((input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    const match = /^https:\/\/api\.revenuecat\.com\/v2\/projects\/proj-still\/entitlements\/([^/?]+)\?expand=product$/.exec(input);
    if (match) return Promise.resolve(entitlement(decodeURIComponent(match[1]!)));
    if (input.startsWith(`https://api.revenuecat.com/v2/projects/proj-still/customers/${HOLDER}/purchases?`)) return Promise.resolve(Response.json(list));
    return Promise.reject(new Error(`unexpected request ${input}`));
  }) as typeof fetch;
}
const served = (c: Catalog) => (id: string) => c[id] ? Response.json(c[id]) : Response.json({ object: "error", type: "resource_missing" }, { status: 404 });
async function withFetch<T>(fake: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = real; }
}
function read(items: unknown[], extra: Record<string, unknown> = {}, mappings: readonly AccessProductMapping[] = [MAPPING],
  c: Catalog = catalog(), calls: Call[] = []) {
  return withFetch(fakeRevenueCat({ object: "list", items, next_page: null, ...extra }, served(c), calls),
    () => new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", mappings).getRights(HOLDER, "sandbox"));
}
Deno.test("canonical positive purchased lifetime yields stable transaction key, distinct from account", async () => {
  const first = await read([purchase()]);
  assertEquals(first.status, "verified");
  if (first.status !== "verified") throw new Error("Expected verified");
  assertEquals(first.rights.length, 1);
  assertEquals(first.rights[0]?.key.length, 64);
  assertEquals(first.rights[0]?.product, "still_pro_v3");
  assertEquals(await read([purchase()]), first);
});
Deno.test("complete absence remains distinct from an explicit current transaction refund", async () => {
  assertEquals(await read([]), { status: "verified", rights: [], complete: true });
  const positive = await read([purchase()]);
  if (positive.status !== "verified") throw new Error("Expected verified fixture");
  assertEquals(await read([{ ...purchase(), status: "refunded", revenue_in_usd: null }]),
    { status: "verified", rights: [{ ...positive.rights[0]!, state: "revoked" }], complete: true });
});
Deno.test("wrong customer/environment/store, zero or unknown payment, pending and malformed records fail closed", async () => {
  for (const patch of [{ customer_id: "other" }, { environment: "production" }, { store: "promotional" },
    { revenue_in_usd: { currency: "USD", gross: 0 } }, { revenue_in_usd: null }, { status: "pending" },
    { ownership: "family_shared" }, { entitlements: {} }, { purchased_at: NaN }]) {
    assertEquals(await read([{ ...purchase(), ...patch }]), "customer_id" in patch || "environment" in patch || "store" in patch
      ? { status: "unavailable" } : { status: "verified", rights: [], complete: false });
  }
});
Deno.test("wrong app, subscription/consumable product and wrong entitlement/project never grant", async () => {
  for (const mutate of [
    (c: Catalog) => { proProduct(c).app_id = "app-other"; },
    (c: Catalog) => { proProduct(c).type = "subscription"; },
    (c: Catalog) => { proProduct(c).one_time = { is_consumable: true }; },
  ]) {
    const c = catalog(); mutate(c); assertEquals(await read([purchase()], {}, [MAPPING], c), { status: "verified", rights: [], complete: false });
  }
  for (const mutate of [
    (p: ReturnType<typeof purchase>) => { p.entitlements.items[0]!.project_id = "proj-other"; },
    (p: ReturnType<typeof purchase>) => { p.entitlements.items[0]!.lookup_key = "anything"; },
  ]) {
    const p = purchase(); mutate(p); assertEquals(await read([p]), { status: "verified", rights: [], complete: false });
  }
});
Deno.test("RevenueCat's non_consumable product type grants only with an explicit non-consumable flag", async () => {
  // Observed RevenueCat v2 shape for App Store lifetime products: type non_consumable, is_consumable false.
  const nonConsumable = catalog();
  proProduct(nonConsumable).type = "non_consumable";
  const granted = await read([purchase()], {}, [MAPPING], nonConsumable);
  assertEquals(granted.status, "verified");
  if (granted.status !== "verified") throw new Error("Expected verified");
  assertEquals(granted.rights.map(right => right.product), ["still_pro_v3"]);
  assertEquals(granted.complete, true);
  // The flag must still say non-consumable: unknown (null), missing or consumable never grants,
  // and neither does RevenueCat's separate consumable type.
  for (const mutate of [
    (c: Catalog) => { proProduct(c).one_time = { is_consumable: null }; },
    (c: Catalog) => { proProduct(c).one_time = null; },
    (c: Catalog) => { proProduct(c).one_time = { is_consumable: true }; },
  ]) {
    for (const type of ["non_consumable", "one_time"]) {
      const c = catalog(); proProduct(c).type = type; mutate(c);
      assertEquals(await read([purchase()], {}, [MAPPING], c), { status: "verified", rights: [], complete: false }, type);
    }
  }
  for (const type of ["consumable", "non_renewing_subscription", "subscription"]) {
    const c = catalog(); proProduct(c).type = type;
    assertEquals(await read([purchase()], {}, [MAPPING], c), { status: "verified", rights: [], complete: false }, type);
  }
});
Deno.test("duplicate transaction or incomplete/hostile pagination cannot produce verified absence", async () => {
  assertEquals(await read([purchase(), purchase()]), { status: "unavailable" });
  assertEquals(await read([], { next_page: "https://evil.test/collect" }), { status: "unavailable" });
  assertEquals(await read([], { next_page: "/v2/projects/proj-other/customers/other/purchases?environment=sandbox" }), { status: "unavailable" });
  assertEquals(await read([], { next_page: "/v2/projects/proj-still/customers/" + HOLDER + "/purchases?environment=production" }), { status: "unavailable" });
});
Deno.test("provider transport and a bodiless 404 do not mean never purchased", async () => {
  const real = globalThis.fetch;
  try {
    for (const status of [404, 403, 429, 500]) {
      globalThis.fetch = (() => Promise.resolve(new Response(null, { status }))) as typeof fetch;
      assertEquals(await new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", [MAPPING]).getRights(HOLDER, "sandbox"), { status: "unavailable" });
    }
  } finally { globalThis.fetch = real; }
});
const RC_CUSTOMER_MISSING = { object: "error", type: "resource_missing", message: "Could not find customer ID associated with this project",
  retryable: false, doc_url: "https://errors.rev.cat/resource-missing" };
async function readError(status: number, body: string | null, project = "proj-still") {
  const real = globalThis.fetch; const urls: string[] = [];
  globalThis.fetch = ((input: string) => { urls.push(input); return Promise.resolve(new Response(body, { status })); }) as typeof fetch;
  try { return { access: await new HttpRevenueCatAccessClient("synthetic-secret", project, [MAPPING]).getRights(HOLDER, "sandbox"), urls }; }
  finally { globalThis.fetch = real; }
}
Deno.test("RevenueCat 404 resource_missing (customer never created) is a complete, empty list for that account", async () => {
  for (const body of [RC_CUSTOMER_MISSING, { ...RC_CUSTOMER_MISSING, param: "customer_id" },
    { ...RC_CUSTOMER_MISSING, param: null }]) {
    const { access, urls } = await readError(404, JSON.stringify(body));
    assertEquals(access, { status: "verified", rights: [], complete: true, customerMissing: true }, JSON.stringify(body));
    // The absence is read only from this project's purchases list for the authenticated holder.
    assertEquals(urls, [`https://api.revenuecat.com/v2/projects/proj-still/customers/${HOLDER}/purchases?environment=sandbox&limit=100`]);
  }
});
Deno.test("every other 404, missing/malformed body, retryable or non-404 error stays unavailable", async () => {
  const missing = JSON.stringify(RC_CUSTOMER_MISSING);
  for (const [status, body] of [
    [404, null], [404, ""], [404, "not json"], [404, "[]"], [404, "null"], [404, JSON.stringify({})],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, type: "parameter_error" })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, type: "Resource_Missing" })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, object: "list" })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, retryable: true })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, param: "project_id" })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, param: "app_id" })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, message: "Project not found" })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, message: "Could not find app associated with this project" })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, message: 42 })],
    [404, JSON.stringify({ type: "resource_missing" })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, message: null })],
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, object: undefined })],
    [400, missing], [401, missing], [403, missing], [410, missing], [429, missing], [500, missing], [503, missing],
  ] as const) {
    assertEquals((await readError(status, body)).access, { status: "unavailable" }, `${status} ${body}`);
  }
});
Deno.test("a customer-missing 404 after the first page, or a timed-out read, never proves absence", async () => {
  const real = globalThis.fetch; let calls = 0;
  globalThis.fetch = (() => Promise.resolve(++calls === 1
    ? new Response(JSON.stringify({ object: "list", items: [], next_page: `/v2/projects/proj-still/customers/${HOLDER}/purchases?environment=sandbox&starting_after=x` }))
    : new Response(JSON.stringify(RC_CUSTOMER_MISSING), { status: 404 }))) as typeof fetch;
  try { assertEquals(await new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", [MAPPING]).getRights(HOLDER, "sandbox"), { status: "unavailable" }); }
  finally { globalThis.fetch = real; }
  assertEquals(calls, 2);
  globalThis.fetch = (() => Promise.reject(new DOMException("timed out", "TimeoutError"))) as typeof fetch;
  try { assertEquals(await new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", [MAPPING]).getRights(HOLDER, "sandbox"), { status: "unavailable" }); }
  finally { globalThis.fetch = real; }
});
Deno.test("missing configuration never turns a customer-missing 404 into absence", async () => {
  for (const project of ["", "bad/project"]) assertEquals((await readError(404, JSON.stringify(RC_CUSTOMER_MISSING), project)).access, { status: "unavailable" });
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify(RC_CUSTOMER_MISSING), { status: 404 }))) as typeof fetch;
  try { assertEquals(await new HttpRevenueCatAccessClient("", "proj-still", [MAPPING]).getRights(HOLDER, "sandbox"), { status: "unavailable" }); }
  finally { globalThis.fetch = real; }
});
Deno.test("mapping must be explicit, bounded and map immutable product/entitlement pair", () => {
  assertEquals(parseAccessProductMappings(JSON.stringify([MAPPING])), [MAPPING]);
  for (const mappings of [[], [MAPPING, MAPPING], [{ ...MAPPING, entitlement_lookup_key: "still_sync" }], [{ ...MAPPING, app_id: "" }]]) {
    assertEquals(parseAccessProductMappings(JSON.stringify(mappings)), null);
  }
});

Deno.test("current Apple Pro cannot mint a second right through RevenueCat purchase identity", async () => {
  const real = globalThis.fetch;
  try {
    for (const store of ["app_store", "mac_app_store"] as const) {
      globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ object: "list", items: [{ ...purchase(), store }], next_page: null })))) as typeof fetch;
      const client = new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", [{ ...MAPPING, store }]);
      assertEquals(await client.getRights(HOLDER, "sandbox"), { status: "verified", rights: [], complete: true });
    }
  } finally { globalThis.fetch = real; }
});

Deno.test("ambiguous historic payment cannot mask a separately verified refund or become verified absence", async () => {
  const positive = await read([purchase()]);
  if (positive.status !== "verified") throw new Error("Expected verified fixture");
  for (const items of [[{ ...purchase(), status: "refunded" }, { ...purchase(), id: "unknown-historical", revenue_in_usd: null }],
    [{ ...purchase(), id: "unknown-historical", revenue_in_usd: null }, { ...purchase(), status: "refunded" }]]) {
    assertEquals(await read(items), { status: "verified", rights: [{ ...positive.rights[0]!, state: "revoked" }], complete: false });
  }
});

Deno.test("Stripe grammar separates six-field provider identity from canonical Still benefit", () => {
  assertEquals(parseAccessProductMappings(JSON.stringify([STRIPE_MAPPING])), [STRIPE_MAPPING]);
  assertEquals(parseAccessProductMappings(JSON.stringify([MAPPING, STRIPE_MAPPING])), [MAPPING, STRIPE_MAPPING]);
  for (const store of ["app_store", "mac_app_store", "rc_billing"] as const) {
    for (const product of ["still_pro_v3", "still_sync"] as const) {
      const legacy = { ...MAPPING, store, store_identifier: product, entitlement_lookup_key: product };
      assertEquals(parseAccessProductMappings(JSON.stringify([legacy])), [legacy]);
      assertEquals(parseAccessProductMappings(JSON.stringify([{ ...legacy, benefit_product: product }])), null);
    }
  }
  for (const patch of [
    { benefit_product: "still_sync" }, { benefit_product: undefined }, { entitlement_lookup_key: "still_sync" },
    { store_identifier: "" }, { store_identifier: "provider.product" }, { store_identifier: "with space" },
    { store_identifier: "é" }, { store_identifier: "x".repeat(129) }, { product_id: "x".repeat(97) },
    { app_id: "x".repeat(97) }, { unknown: true }, { store: "rc_billing" },
  ]) assertEquals(parseAccessProductMappings(JSON.stringify([{ ...STRIPE_MAPPING, ...patch }])), null);
  assertEquals(parseAccessProductMappings(JSON.stringify([{ ...STRIPE_MAPPING, store_identifier: "x".repeat(128) }])),
    [{ ...STRIPE_MAPPING, store_identifier: "x".repeat(128) }]);
  assertEquals(parseAccessProductMappings(JSON.stringify([MAPPING, { ...STRIPE_MAPPING, product_id: MAPPING.product_id }])), null);
});
Deno.test("Stripe owned evidence yields canonical benefit and stable provider purchase key", async () => {
  const mappings = parseAccessProductMappings(JSON.stringify([STRIPE_MAPPING]));
  if (!mappings) throw new Error("Stripe grammar rejected");
  const result = await read([stripePurchase()], {}, mappings);
  assertEquals(result.status, "verified");
  if (result.status !== "verified") throw new Error("Expected verified Stripe fixture");
  assertEquals(result.complete, true);
  assertEquals(result.rights.length, 1);
  assertEquals(result.rights[0]?.product, "still_pro_v3");
  assertEquals(result.rights[0]?.key.length, 64);
  assertEquals(await read([stripePurchase()], {}, mappings), result);
});
Deno.test("Stripe one_time with RevenueCat's unknown consumable flag grants; consumable or other types never do", async () => {
  // Observed for a Stripe price imported into RevenueCat: type one_time, is_consumable null. RevenueCat's
  // Stripe apps allow only subscription or one_time, so the flag cannot be set to false.
  const mappings = parseAccessProductMappings(JSON.stringify([STRIPE_MAPPING]));
  if (!mappings) throw new Error("Stripe grammar rejected");
  const unknownFlag = await read([stripePurchase()], {}, mappings);
  assertEquals(unknownFlag.status, "verified");
  if (unknownFlag.status !== "verified") throw new Error("Expected verified Stripe fixture");
  assertEquals(unknownFlag.rights.length, 1);
  const explicitFalse = catalog(); stripeProduct(explicitFalse).one_time = { is_consumable: false };
  assertEquals(await read([stripePurchase()], {}, mappings, explicitFalse), unknownFlag);
  for (const mutate of [
    (c: Catalog) => { stripeProduct(c).one_time = { is_consumable: true }; },
    (c: Catalog) => { stripeProduct(c).one_time = { is_consumable: undefined }; },
    (c: Catalog) => { stripeProduct(c).one_time = { is_consumable: "false" }; },
    (c: Catalog) => { stripeProduct(c).one_time = null; },
    (c: Catalog) => { stripeProduct(c).type = "non_consumable"; },
    (c: Catalog) => { stripeProduct(c).type = "consumable"; },
    (c: Catalog) => { stripeProduct(c).type = "subscription"; },
  ]) {
    const c = catalog(); mutate(c);
    assertEquals(await read([stripePurchase()], {}, mappings, c), { status: "verified", rights: [], complete: false });
  }
  // The relaxation is Stripe-only: an App Store or RevenueCat Billing product with an unknown flag never grants.
  const legacy = catalog(); proProduct(legacy).one_time = { is_consumable: null };
  assertEquals(await read([purchase()], {}, [MAPPING], legacy), { status: "verified", rights: [], complete: false });
});
Deno.test("QA Stripe mapping cannot classify production purchases or refunds", async () => {
  const real = globalThis.fetch;
  try {
    for (const status of ["owned", "refunded"]) {
      globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({
        object: "list", next_page: null,
        items: [{ ...stripePurchase(), status, environment: "production" }],
      })))) as typeof fetch;
      assertEquals(await new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", [STRIPE_MAPPING]).getRights(HOLDER, "production"), { status: "unavailable" });
    }
  } finally { globalThis.fetch = real; }
});
Deno.test("Stripe mapping rejects wrong product/app/store/entitlement and unknown or zero payment", async () => {
  const mappings = parseAccessProductMappings(JSON.stringify([STRIPE_MAPPING]));
  if (!mappings) throw new Error("Stripe grammar rejected");
  for (const patch of [{ customer_id: "other" }, { environment: "production" }, { store: "rc_billing" }]) {
    assertEquals(await read([{ ...stripePurchase(), ...patch }], {}, mappings), { status: "unavailable" });
  }
  assertEquals(await read([{ ...stripePurchase(), product_id: "unmapped-product" }], {}, mappings),
    { status: "verified", rights: [], complete: true });
  for (const patch of [{ revenue_in_usd: null }, { revenue_in_usd: { currency: "USD", gross: 0 } },
    { revenue_in_usd: { currency: "USD", gross: -1 } }, { revenue_in_usd: { currency: "EUR", gross: 9.99 } },
    { revenue_in_usd: { currency: "USD", gross: "9.99" } }, { ownership: "family_shared" }]) {
    assertEquals(await read([{ ...stripePurchase(), ...patch }], {}, mappings), { status: "verified", rights: [], complete: false });
  }
  for (const mutate of [
    (c: Catalog) => { stripeProduct(c).app_id = "different-app"; },
    (c: Catalog) => { stripeProduct(c).id = "different-product"; },
    (c: Catalog) => { stripeProduct(c).store_identifier = "different-store-id"; },
    (c: Catalog) => { stripeProduct(c).object = "entitlement"; },
    (c: Catalog) => { stripeProduct(c).state = "inactive"; },
    (c: Catalog) => { stripeProduct(c).type = "subscription"; },
    (c: Catalog) => { stripeProduct(c).one_time = { is_consumable: true }; },
  ]) {
    const c = catalog(); mutate(c);
    assertEquals(await read([stripePurchase()], {}, mappings, c), { status: "verified", rights: [], complete: false });
  }
  for (const mutate of [
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.lookup_key = "still_sync"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.project_id = "different-project"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.state = "inactive"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.object = "product"; },
  ]) {
    const p = stripePurchase(); mutate(p);
    assertEquals(await read([p], {}, mappings), { status: "verified", rights: [], complete: false });
  }
});
Deno.test("Stripe refunds revoke canonical benefit even after entitlement and revenue disappear", async () => {
  const mappings = parseAccessProductMappings(JSON.stringify([STRIPE_MAPPING]));
  if (!mappings) throw new Error("Stripe grammar rejected");
  const positive = await read([stripePurchase()], {}, mappings);
  if (positive.status !== "verified") throw new Error("Expected verified Stripe fixture");
  const refunded = { ...stripePurchase(), status: "refunded", entitlements: undefined, revenue_in_usd: null };
  assertEquals(await read([refunded], {}, mappings),
    { status: "verified", rights: [{ ...positive.rights[0]!, product: "still_pro_v3", state: "revoked" }], complete: true });
  assertEquals(await read([{ ...refunded, store: "rc_billing" }], {}, mappings), { status: "unavailable" });
  assertEquals(await read([{ ...refunded, environment: "production" }], {}, mappings), { status: "unavailable" });
  assertEquals(await read([{ ...refunded, product_id: "unmapped-product" }], {}, mappings),
    { status: "verified", rights: [], complete: true });
});
Deno.test("mixed legacy and Stripe mappings preserve historical rights and cannot cross-classify", async () => {
  const historical = { ...MAPPING, product_id: "historic-product", store_identifier: "still_sync", entitlement_lookup_key: "still_sync" } as const;
  const mappings = parseAccessProductMappings(JSON.stringify([MAPPING, STRIPE_MAPPING, historical]));
  if (!mappings) throw new Error("Mixed grammar rejected");
  const p = purchase();
  const historicPurchase = { ...p, id: "historic-purchase", product_id: historical.product_id, entitlements: {
    ...p.entitlements, items: [entitlementRef(ENT_SYNC, "still_sync")] } };
  const calls: Call[] = [];
  const result = await read([purchase(), stripePurchase(), historicPurchase], {}, mappings, catalog(), calls);
  if (result.status !== "verified") throw new Error("Expected verified mixed fixture");
  // Two purchases share the Pro entitlement: it is read once; the historical entitlement once.
  assertEquals(calls.map(call => call.url), [PURCHASES_URL, entitlementUrl(ENT_PRO), entitlementUrl(ENT_SYNC)]);
  assertEquals(result.complete, true);
  assertEquals(result.rights.map(right => right.product), ["still_pro_v3", "still_pro_v3", "still_sync"]);
  assertEquals(new Set(result.rights.map(right => right.key)).size, 3);
  assertEquals(await read([{ ...stripePurchase(), product_id: MAPPING.product_id }], {}, mappings), { status: "unavailable" });
  assertEquals(await read([{ ...purchase(), product_id: STRIPE_MAPPING.product_id }], {}, mappings), { status: "unavailable" });
});

Deno.test("legacy still_sync remains paid and revocable on all retained stores", async () => {
  for (const store of ["app_store", "mac_app_store", "rc_billing"] as const) {
    const legacy = { ...MAPPING, store, store_identifier: "still_sync", entitlement_lookup_key: "still_sync" } as const;
    const p = purchase();
    const historic = { ...p, store, entitlements: { ...p.entitlements, items: [entitlementRef(ENT_SYNC, "still_sync")] } };
    const c = catalog(); c[ENT_SYNC]!.products.items = [product(MAPPING.product_id, MAPPING.app_id, "still_sync")];
    const positive = await read([historic], {}, [legacy], c);
    if (positive.status !== "verified") throw new Error("Expected historical paid fixture");
    assertEquals(positive.complete, true);
    assertEquals(positive.rights.length, 1);
    assertEquals(positive.rights[0]?.product, "still_sync");
    assertEquals(await read([{ ...historic, status: "refunded", entitlements: undefined, revenue_in_usd: null }], {}, [legacy]),
      { status: "verified", rights: [{ ...positive.rights[0]!, state: "revoked" }], complete: true });
  }
});

Deno.test("Stripe mappings bind to the exact configured price; other stores are unaffected", () => {
  const mixed = parseAccessProductMappings(JSON.stringify([MAPPING, STRIPE_MAPPING]));
  if (!mixed) throw new Error("Mixed grammar rejected");
  assertEquals(stripeMappingsBoundTo(mixed, STRIPE_MAPPING.store_identifier), mixed);
  for (const price of ["", "price_other", STRIPE_MAPPING.store_identifier + "x"]) assertEquals(stripeMappingsBoundTo(mixed, price), null);
  assertEquals(stripeMappingsBoundTo([MAPPING], ""), [MAPPING]);
  assertEquals(stripeMappingsBoundTo(null, STRIPE_MAPPING.store_identifier), null);
});

// Regression (QA sandbox, 2026-10-10): a genuine owned Stripe purchase answered "unavailable" because
// the parser required products embedded in the purchase's entitlement item, which RevenueCat never sends.
Deno.test("real-shape owned Stripe purchase (no embedded products) verifies through one bounded entitlement read", async () => {
  const mappings = parseAccessProductMappings(JSON.stringify([STRIPE_MAPPING]));
  if (!mappings) throw new Error("Stripe grammar rejected");
  const real = stripePurchase();
  assertEquals(Object.keys(real.entitlements.items[0]!).sort(),
    ["created_at", "display_name", "id", "lookup_key", "object", "project_id", "state"]);
  const calls: Call[] = [];
  const result = await read([real], {}, mappings, catalog(), calls);
  assertEquals(result.status, "verified");
  if (result.status !== "verified") throw new Error("Expected verified Stripe purchase");
  assertEquals(result.complete, true);
  assertEquals(result.rights.map(right => right.product), ["still_pro_v3"]);
  assertEquals(calls.map(call => call.url), [PURCHASES_URL, entitlementUrl(ENT_PRO)]);
  const [list, entitlement] = calls;
  // One deadline covers the list and the entitlement read; redirects can never carry the secret away.
  assert(entitlement!.init?.signal instanceof AbortSignal);
  assertStrictEquals(entitlement!.init?.signal, list!.init?.signal);
  assertEquals(entitlement!.init?.redirect, "error");
  assertEquals((entitlement!.init?.headers as Record<string, string>).Authorization, "Bearer synthetic-secret");
});
Deno.test("an entitlement id outside the provider ID grammar is never requested and never grants", async () => {
  for (const id of ["../customers/other", "entl/x", "entl?x=1", "", "x".repeat(97)]) {
    const p = stripePurchase(); p.entitlements.items[0]!.id = id;
    const calls: Call[] = [];
    assertEquals(await read([p], {}, [STRIPE_MAPPING], catalog(), calls), { status: "verified", rights: [], complete: false }, id);
    assertEquals(calls.map(call => call.url), [PURCHASES_URL], id);
  }
  const missing = stripePurchase() as Record<string, unknown> & ReturnType<typeof stripePurchase>;
  delete (missing.entitlements.items[0] as Partial<ReturnType<typeof entitlementRef>>).id;
  assertEquals(await read([missing], {}, [STRIPE_MAPPING]), { status: "verified", rights: [], complete: false });
});
Deno.test("a failed, malformed or mismatched entitlement read is transient, never absence or a grant", async () => {
  const good = () => catalog()[ENT_PRO]!;
  const bodies: (() => Response | Promise<Response>)[] = [
    ...[500, 503, 429, 403, 401, 404].map(status => () => Response.json(good(), { status })),
    () => new Response("not json"), () => new Response(""), () => Response.json(null), () => Response.json([]),
    () => Response.json({ ...good(), object: "product" }),
    () => Response.json({ ...good(), id: "entlOther" }),
    () => Response.json({ ...good(), project_id: "proj-other" }),
    () => Response.json({ ...good(), project_id: undefined }),
    () => Response.json({ ...good(), lookup_key: "still_sync" }),
    () => Response.json({ ...good(), lookup_key: undefined }),
    () => Response.json({ ...good(), state: "inactive" }),
    () => Response.json({ ...good(), products: undefined }),
    () => Response.json({ ...good(), products: [good().products.items] }),
    () => Response.json({ ...good(), products: { ...good().products, object: "product" } }),
    () => Response.json({ ...good(), products: { ...good().products, next_page: "/v2/projects/proj-still/entitlements/x/products?starting_after=y" } }),
    () => Response.json({ ...good(), products: { ...good().products, next_page: undefined } }),
    () => Response.json({ ...good(), products: { ...good().products, items: null } }),
    () => Promise.reject(new DOMException("timed out", "TimeoutError")),
  ];
  for (const [index, body] of bodies.entries()) {
    const access = await withFetch(fakeRevenueCat({ object: "list", next_page: null, items: [stripePurchase()] }, body),
      () => new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", [STRIPE_MAPPING]).getRights(HOLDER, "sandbox"));
    assertEquals(access, { status: "unavailable" }, String(index));
  }
});
Deno.test("a product missing from the entitlement's product list never grants", async () => {
  for (const mutate of [
    (c: Catalog) => { c[ENT_PRO]!.products.items = []; },
    (c: Catalog) => { c[ENT_PRO]!.products.items = [proProduct(c)]; },
    (c: Catalog) => { c[ENT_PRO]!.products.items = [c[ENT_SYNC]!.products.items[0]!]; },
  ]) {
    const c = catalog(); mutate(c);
    assertEquals(await read([stripePurchase()], {}, [STRIPE_MAPPING], c), { status: "verified", rights: [], complete: false });
  }
});
Deno.test("products embedded in a purchase item are ignored; the entitlement read is the only source", async () => {
  const embedded = stripePurchase();
  Object.assign(embedded.entitlements.items[0]!, { products: catalog()[ENT_PRO]!.products });
  const c = catalog(); c[ENT_PRO]!.products.items = [proProduct(c)];
  assertEquals(await read([embedded], {}, [STRIPE_MAPPING], c), { status: "verified", rights: [], complete: false });
});
Deno.test("purchases sharing an entitlement read it once; more than four distinct entitlements is unavailable", async () => {
  const calls: Call[] = [];
  const result = await read([purchase(), { ...purchase(), id: "purch-second" }], {}, [MAPPING], catalog(), calls);
  if (result.status !== "verified") throw new Error("Expected verified");
  assertEquals(result.rights.length, 2);
  assertEquals(calls.map(call => call.url), [PURCHASES_URL, entitlementUrl(ENT_PRO)]);
  const spread = (count: number) => {
    const mappings: AccessProductMapping[] = [], items: unknown[] = [], c: Catalog = {};
    for (let i = 0; i < count; i++) {
      mappings.push({ ...MAPPING, product_id: `prod-${i}` });
      const p = purchase();
      items.push({ ...p, id: `purch-${i}`, product_id: `prod-${i}`, entitlements: { ...p.entitlements, items: [entitlementRef(`entl-${i}`, "still_pro_v3")] } });
      c[`entl-${i}`] = entitlementDoc(`entl-${i}`, "still_pro_v3", [product(`prod-${i}`, MAPPING.app_id, "still_pro_v3")]);
    }
    return { mappings, items, c };
  };
  const four = spread(4);
  const verified = await read(four.items, {}, four.mappings, four.c);
  assertEquals(verified.status === "verified" && verified.rights.length, 4);
  const five = spread(5), fiveCalls: Call[] = [];
  assertEquals(await read(five.items, {}, five.mappings, five.c, fiveCalls), { status: "unavailable" });
  assertEquals(fiveCalls.length, 5);
});
