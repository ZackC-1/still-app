import { assertEquals } from "@std/assert";
import {
  PRO_ENTITLEMENT_IDS,
  STILL_PRO_ENTITLEMENT,
  STILL_PRO_V3_ENTITLEMENT,
  stillProActive,
  type RcSubscriber,
} from "./revenuecat.ts";

// U16-W2 entitlement-model truth table (decided): the server ORs the current `still_pro_v3`
// entitlement and the historical `still_sync` one into the existing entitlement boolean. Both ids
// mean lifetime Pro — no migration, no new client field, no new DB column.
const NOW = Date.parse("2026-10-06T00:00:00Z");
const PAST = new Date(NOW - 86_400_000).toISOString();
const FUTURE = new Date(NOW + 86_400_000).toISOString();

function sub(entitlements: RcSubscriber["entitlements"]): RcSubscriber {
  return { entitlements };
}

Deno.test("entitlement ids are the frozen pair, current offer first", () => {
  assertEquals(STILL_PRO_V3_ENTITLEMENT, "still_pro_v3");
  assertEquals(STILL_PRO_ENTITLEMENT, "still_sync");
  assertEquals([...PRO_ENTITLEMENT_IDS], ["still_pro_v3", "still_sync"]);
});

Deno.test("still_pro_v3-only subscriber is Pro", () => {
  assertEquals(stillProActive(sub({ still_pro_v3: { expires_date: null } }), NOW), true);
});

Deno.test("historical still_sync-only subscriber is still Pro", () => {
  assertEquals(stillProActive(sub({ still_sync: { expires_date: null } }), NOW), true);
});

Deno.test("both entitlements is Pro", () => {
  assertEquals(
    stillProActive(sub({ still_pro_v3: { expires_date: null }, still_sync: { expires_date: null } }), NOW),
    true,
  );
});

Deno.test("neither entitlement is not Pro", () => {
  assertEquals(stillProActive(sub({}), NOW), false);
});

Deno.test("null subscriber is not Pro", () => {
  assertEquals(stillProActive(null, NOW), false);
});

Deno.test("expired dated entitlement reads false for the one-time model", () => {
  assertEquals(stillProActive(sub({ still_pro_v3: { expires_date: PAST } }), NOW), false);
  assertEquals(stillProActive(sub({ still_sync: { expires_date: PAST } }), NOW), false);
});

Deno.test("unexpired dated entitlement still reads true while it is current", () => {
  assertEquals(stillProActive(sub({ still_pro_v3: { expires_date: FUTURE } }), NOW), true);
  assertEquals(stillProActive(sub({ still_sync: { expires_date: FUTURE } }), NOW), true);
});

Deno.test("unknown entitlement ids never grant Pro, even lifetime-shaped", () => {
  assertEquals(stillProActive(sub({ something_else: { expires_date: null } }), NOW), false);
  assertEquals(stillProActive(sub({ "$rc_lifetime": { expires_date: null } }), NOW), false);
});

Deno.test("unknown ids alongside a valid historical grant still read Pro", () => {
  assertEquals(
    stillProActive(sub({ something_else: { expires_date: null }, still_sync: { expires_date: null } }), NOW),
    true,
  );
});

Deno.test("unparseable expires_date fails closed", () => {
  assertEquals(stillProActive(sub({ still_pro_v3: { expires_date: "not-a-date" } }), NOW), false);
});

Deno.test("an expired v3 grant does not mask a live historical one", () => {
  assertEquals(
    stillProActive(sub({ still_pro_v3: { expires_date: PAST }, still_sync: { expires_date: null } }), NOW),
    true,
  );
});
