import { assertEquals } from "@std/assert";
import { HttpRevenueCatAccessClient, parseAccessProductMappings, stripeMappingsBoundTo, type AccessProductMapping } from "./revenuecat-access.ts";

const HOLDER = "11111111-1111-1111-1111-111111111111";
const MAPPING: AccessProductMapping = { product_id: "prod-current", app_id: "app-still", store_identifier: "still_pro_v3",
  entitlement_lookup_key: "still_pro_v3", store: "rc_billing" };
function purchase() {
  return { object: "purchase", id: "purch-verified", customer_id: HOLDER, product_id: MAPPING.product_id,
    environment: "sandbox", purchased_at: 1791374400000, revenue_in_usd: { currency: "USD", gross: 9.99 },
    status: "owned", ownership: "purchased", store: "rc_billing", entitlements: { object: "list", next_page: null,
      items: [{ state: "active", object: "entitlement", project_id: "proj-still", lookup_key: "still_pro_v3",
        products: { object: "list", next_page: null, items: [{ state: "active", object: "product", id: MAPPING.product_id,
          store_identifier: "still_pro_v3", app_id: MAPPING.app_id, type: "one_time", one_time: { is_consumable: false } }] } }] } };
}
async function read(items: unknown[], extra: Record<string, unknown> = {}, mappings: readonly AccessProductMapping[] = [MAPPING]) {
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ object: "list", items, next_page: null, ...extra })))) as typeof fetch;
  try { return await new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", mappings).getRights(HOLDER, "sandbox"); }
  finally { globalThis.fetch = real; }
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
    (p: ReturnType<typeof purchase>) => { p.entitlements.items[0]!.products.items[0]!.app_id = "app-other"; },
    (p: ReturnType<typeof purchase>) => { p.entitlements.items[0]!.products.items[0]!.type = "subscription"; },
    (p: ReturnType<typeof purchase>) => { p.entitlements.items[0]!.products.items[0]!.one_time.is_consumable = true; },
    (p: ReturnType<typeof purchase>) => { p.entitlements.items[0]!.project_id = "proj-other"; },
    (p: ReturnType<typeof purchase>) => { p.entitlements.items[0]!.lookup_key = "anything"; },
  ]) {
    const p = purchase(); mutate(p); assertEquals(await read([p]), { status: "verified", rights: [], complete: false });
  }
});
Deno.test("RevenueCat's non_consumable product type grants only with an explicit non-consumable flag", async () => {
  // Observed RevenueCat v2 shape for App Store lifetime products: type non_consumable, is_consumable false.
  const nonConsumable = purchase();
  (nonConsumable.entitlements.items[0]!.products.items[0]! as { type: string }).type = "non_consumable";
  const granted = await read([nonConsumable]);
  assertEquals(granted.status, "verified");
  if (granted.status !== "verified") throw new Error("Expected verified");
  assertEquals(granted.rights.map(right => right.product), ["still_pro_v3"]);
  assertEquals(granted.complete, true);
  // The flag must still say non-consumable: unknown (null), missing or consumable never grants,
  // and neither does RevenueCat's separate consumable type.
  for (const mutate of [
    (p: ReturnType<typeof purchase>) => { (p.entitlements.items[0]!.products.items[0]!.one_time as { is_consumable: unknown }).is_consumable = null; },
    (p: ReturnType<typeof purchase>) => { (p.entitlements.items[0]!.products.items[0]! as { one_time: unknown }).one_time = null; },
    (p: ReturnType<typeof purchase>) => { p.entitlements.items[0]!.products.items[0]!.one_time.is_consumable = true; },
  ]) {
    for (const type of ["non_consumable", "one_time"]) {
      const p = purchase(); (p.entitlements.items[0]!.products.items[0]! as { type: string }).type = type; mutate(p);
      assertEquals(await read([p]), { status: "verified", rights: [], complete: false }, type);
    }
  }
  for (const type of ["consumable", "non_renewing_subscription", "subscription"]) {
    const p = purchase(); (p.entitlements.items[0]!.products.items[0]! as { type: string }).type = type;
    assertEquals(await read([p]), { status: "verified", rights: [], complete: false }, type);
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
const RC_CUSTOMER_MISSING = { object: "error", type: "resource_missing", message: "Customer not found",
  retryable: false, doc_url: "https://errors.rev.cat/resource-missing" };
async function readError(status: number, body: string | null, project = "proj-still") {
  const real = globalThis.fetch; const urls: string[] = [];
  globalThis.fetch = ((input: string) => { urls.push(input); return Promise.resolve(new Response(body, { status })); }) as typeof fetch;
  try { return { access: await new HttpRevenueCatAccessClient("synthetic-secret", project, [MAPPING]).getRights(HOLDER, "sandbox"), urls }; }
  finally { globalThis.fetch = real; }
}
Deno.test("RevenueCat 404 resource_missing (customer never created) is a complete, empty list for that account", async () => {
  for (const body of [RC_CUSTOMER_MISSING, { type: "resource_missing" }, { ...RC_CUSTOMER_MISSING, param: "customer_id" },
    { ...RC_CUSTOMER_MISSING, message: null, param: null }]) {
    const { access, urls } = await readError(404, JSON.stringify(body));
    assertEquals(access, { status: "verified", rights: [], complete: true }, JSON.stringify(body));
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
    [404, JSON.stringify({ ...RC_CUSTOMER_MISSING, message: 42 })],
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

// Independent synthetic identities: the Stripe product is not a Checkout Session,
// RevenueCat purchase/product, or canonical Still benefit.
const STRIPE_MAPPING = { product_id: "rc-stripe-product", app_id: "rc-stripe-app", store_identifier: "provider_Stripe-product_42",
  entitlement_lookup_key: "still_pro_v3", store: "stripe", benefit_product: "still_pro_v3" } as const;
function stripePurchase(): ReturnType<typeof purchase> {
  const p = purchase();
  return { ...p, id: "rc-stripe-purchase", product_id: STRIPE_MAPPING.product_id, store: "stripe", entitlements: {
    ...p.entitlements, items: [{ ...p.entitlements.items[0]!, products: {
      ...p.entitlements.items[0]!.products, items: [{ ...p.entitlements.items[0]!.products.items[0]!,
        id: STRIPE_MAPPING.product_id, app_id: STRIPE_MAPPING.app_id, store_identifier: STRIPE_MAPPING.store_identifier }] } }] } };
}
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
  const unknownFlag = stripePurchase();
  (unknownFlag.entitlements.items[0]!.products.items[0]!.one_time as { is_consumable: unknown }).is_consumable = null;
  assertEquals(await read([unknownFlag], {}, mappings), await read([stripePurchase()], {}, mappings));
  for (const mutate of [
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.products.items[0]!.one_time.is_consumable = true; },
    (p: ReturnType<typeof stripePurchase>) => { (p.entitlements.items[0]!.products.items[0]!.one_time as { is_consumable: unknown }).is_consumable = undefined; },
    (p: ReturnType<typeof stripePurchase>) => { (p.entitlements.items[0]!.products.items[0]!.one_time as { is_consumable: unknown }).is_consumable = "false"; },
    (p: ReturnType<typeof stripePurchase>) => { (p.entitlements.items[0]!.products.items[0]! as { one_time: unknown }).one_time = null; },
    (p: ReturnType<typeof stripePurchase>) => { (p.entitlements.items[0]!.products.items[0]! as { type: string }).type = "non_consumable"; },
    (p: ReturnType<typeof stripePurchase>) => { (p.entitlements.items[0]!.products.items[0]! as { type: string }).type = "consumable"; },
    (p: ReturnType<typeof stripePurchase>) => { (p.entitlements.items[0]!.products.items[0]! as { type: string }).type = "subscription"; },
  ]) {
    const p = stripePurchase(); mutate(p);
    assertEquals(await read([p], {}, mappings), { status: "verified", rights: [], complete: false });
  }
  // The relaxation is Stripe-only: an App Store or RevenueCat Billing product with an unknown flag never grants.
  const legacy = purchase();
  (legacy.entitlements.items[0]!.products.items[0]!.one_time as { is_consumable: unknown }).is_consumable = null;
  assertEquals(await read([legacy]), { status: "verified", rights: [], complete: false });
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
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.products.items[0]!.app_id = "different-app"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.products.items[0]!.id = "different-product"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.products.items[0]!.store_identifier = "different-store-id"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.lookup_key = "still_sync"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.project_id = "different-project"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.state = "inactive"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.products.items[0]!.state = "inactive"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.products.items[0]!.type = "subscription"; },
    (p: ReturnType<typeof stripePurchase>) => { p.entitlements.items[0]!.products.items[0]!.one_time.is_consumable = true; },
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
    ...p.entitlements, items: [{ ...p.entitlements.items[0]!, lookup_key: "still_sync", products: {
      ...p.entitlements.items[0]!.products, items: [{ ...p.entitlements.items[0]!.products.items[0]!, id: historical.product_id,
        store_identifier: "still_sync" }] } }] } };
  const result = await read([purchase(), stripePurchase(), historicPurchase], {}, mappings);
  if (result.status !== "verified") throw new Error("Expected verified mixed fixture");
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
    const historic = { ...p, store, entitlements: { ...p.entitlements, items: [{ ...p.entitlements.items[0]!,
      lookup_key: "still_sync", products: { ...p.entitlements.items[0]!.products,
        items: [{ ...p.entitlements.items[0]!.products.items[0]!, store_identifier: "still_sync" }] } }] } };
    const positive = await read([historic], {}, [legacy]);
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
