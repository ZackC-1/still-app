import { assertEquals, assertRejects } from "@std/assert";
import { RevenueCatWebPurchaseLink } from "../_shared/web-billing.ts";

const A = "11111111-1111-1111-1111-111111111111";

Deno.test("builds a Web Purchase Link with the app_user_id and package", async () => {
  const link = new RevenueCatWebPurchaseLink("https://pay.rev.cat/abc123", "still_sync_web");
  const { checkout_url } = await link.createCheckout(A);
  assertEquals(checkout_url, `https://pay.rev.cat/abc123/${A}?package_id=still_sync_web`);
});

Deno.test("trims a trailing slash on the base purchase link", async () => {
  const link = new RevenueCatWebPurchaseLink("https://pay.rev.cat/abc123/", "still_sync_web");
  const { checkout_url } = await link.createCheckout(A);
  assertEquals(checkout_url, `https://pay.rev.cat/abc123/${A}?package_id=still_sync_web`);
});

Deno.test("encodes the app_user_id and package id", async () => {
  const link = new RevenueCatWebPurchaseLink("https://pay.rev.cat/abc123", "still sync/web");
  const { checkout_url } = await link.createCheckout("a b");
  assertEquals(checkout_url, "https://pay.rev.cat/abc123/a%20b?package_id=still%20sync%2Fweb");
});

Deno.test("throws when the base purchase link is unset (→ handler maps to 502)", async () => {
  const link = new RevenueCatWebPurchaseLink("", "still_sync_web");
  await assertRejects(() => link.createCheckout(A), Error, "not configured");
});
