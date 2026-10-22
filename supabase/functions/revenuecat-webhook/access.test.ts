import { assertEquals } from "@std/assert";
import { type ProductionWebhookAccess, refreshProductionWebhookAccess } from "./access.ts";
import type { CommittedAccess, ProviderRight } from "../_shared/access-issuer.ts";
import type { ProviderAccess } from "../_shared/revenuecat-access.ts";

const HOLDER = "11111111-1111-1111-1111-111111111111";
const paid: ProviderRight = { key: "a".repeat(64), product: "still_pro_v3" };
const refund: ProviderRight = { ...paid, state: "revoked" };

function fixture(provider: ProviderAccess = { status: "verified", rights: [paid] }) {
  const calls: string[] = [], writes: (readonly ProviderRight[])[] = [];
  const access: ProductionWebhookAccess = {
    rights: {
      begin: (holder, environment) => { assertEquals(holder, HOLDER); assertEquals(environment, "production"); calls.push("begin"); return Promise.resolve("token"); },
      commit: (holder, environment, token, rights) => {
        assertEquals([holder, environment, token], [HOLDER, "production", "token"]);
        writes.push(rights); calls.push("commit");
        return Promise.resolve({ status: "committed", rights: [], revocations: [], issuer_time: 100 });
      },
      confirm: () => { calls.push("confirm"); return Promise.resolve(true); },
    },
    provider: { getRights: (holder, environment) => {
      assertEquals([holder, environment], [HOLDER, "production"]); calls.push("provider"); return Promise.resolve(provider);
    } },
    apple: { refresh: (holder, environment) => {
      assertEquals([holder, environment], [HOLDER, "production"]); calls.push("apple"); return Promise.resolve({ ready: true, rights: [] });
    } },
  };
  return { access, calls, writes };
}

Deno.test("webhook persists only current production provider evidence, with no proof issuance", async () => {
  const { access, calls, writes } = fixture();
  assertEquals(await refreshProductionWebhookAccess(HOLDER, access), true);
  assertEquals(calls, ["begin", "provider", "apple", "commit", "confirm"]);
  assertEquals(writes, [[paid]]);
});

Deno.test("canonical refund persists even while Apple is unavailable; delivery retries", async () => {
  const { access, writes } = fixture({ status: "verified", rights: [refund] });
  assertEquals(await refreshProductionWebhookAccess(HOLDER, { ...access, apple: { refresh: () => Promise.reject(new Error("outage")) } }), false);
  assertEquals(writes, [[refund]]);
});

Deno.test("provider failure still allows independent linked Apple refresh to settle", async () => {
  const { access, writes } = fixture();
  let refreshed = false;
  const result = await refreshProductionWebhookAccess(HOLDER, { ...access,
    provider: { getRights: () => Promise.reject(new Error("outage")) },
    apple: { refresh: async () => { await Promise.resolve(); refreshed = true; return true; } },
  });
  assertEquals(result, false); assertEquals(refreshed, true); assertEquals(writes, []);
});

for (const provider of [
  { status: "verified", rights: [refund], complete: false },
  { status: "verified", rights: [], customerMissing: true },
] as const) {
  Deno.test(`partial or missing provider data remains retryable: ${JSON.stringify(provider)}`, async () => {
    const { access, writes } = fixture(provider);
    assertEquals(await refreshProductionWebhookAccess(HOLDER, access), false);
    assertEquals(writes, [provider.rights]);
  });
}

Deno.test("empty canonical read commits no inferred revocation", async () => {
  const { access, writes } = fixture({ status: "verified", rights: [] });
  assertEquals(await refreshProductionWebhookAccess(HOLDER, access), true);
  assertEquals(writes, [[]]);
});

for (const result of ["stale", "superseded"] as const) {
  Deno.test(`webhook observation ${result} is retried`, async () => {
    const { access } = fixture();
    const rights = { ...access.rights,
      ...(result === "stale" ? { commit: (): Promise<CommittedAccess> => Promise.resolve({ status: "stale" }) } :
        { confirm: () => Promise.resolve(false) }),
    };
    assertEquals(await refreshProductionWebhookAccess(HOLDER, { ...access, rights }), false);
  });
}

Deno.test("database failure cannot acknowledge delivery", async () => {
  const { access } = fixture();
  let failed = false;
  try {
    await refreshProductionWebhookAccess(HOLDER, { ...access, rights: { ...access.rights,
      commit: () => Promise.reject(new Error("database unavailable")),
    } });
  } catch { failed = true; }
  assertEquals(failed, true);
});
