import { assertEquals } from "@std/assert";
import { HttpRevenueCatAccessClient, parseAccessProductMappings, type AccessProductMapping } from "./revenuecat-access.ts";

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
async function read(items: unknown[], extra: Record<string, unknown> = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ object: "list", items, next_page: null, ...extra })))) as typeof fetch;
  try { return await new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", [MAPPING]).getRights(HOLDER, "sandbox"); }
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
Deno.test("duplicate transaction or incomplete/hostile pagination cannot produce verified absence", async () => {
  assertEquals(await read([purchase(), purchase()]), { status: "unavailable" });
  assertEquals(await read([], { next_page: "https://evil.test/collect" }), { status: "unavailable" });
  assertEquals(await read([], { next_page: "/v2/projects/proj-other/customers/other/purchases?environment=sandbox" }), { status: "unavailable" });
  assertEquals(await read([], { next_page: "/v2/projects/proj-still/customers/" + HOLDER + "/purchases?environment=production" }), { status: "unavailable" });
});
Deno.test("provider transport and 404 do not mean never purchased", async () => {
  const real = globalThis.fetch;
  try {
    for (const status of [404, 403, 429, 500]) {
      globalThis.fetch = (() => Promise.resolve(new Response(null, { status }))) as typeof fetch;
      assertEquals(await new HttpRevenueCatAccessClient("synthetic-secret", "proj-still", [MAPPING]).getRights(HOLDER, "sandbox"), { status: "unavailable" });
    }
  } finally { globalThis.fetch = real; }
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
