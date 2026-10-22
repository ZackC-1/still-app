// ISS-0105 follow-up (owner, 22 Oct): native's benefit snapshot carries one display-only Boolean,
// `accountHoldsPro`, so the Safari popup and Settings page can say "Still Pro User" exactly when
// the Apple app would. The snapshot grammar grows from five keys to six; a record written before
// this change (five keys) stays readable and means "not the account's".
import { describe, expect, it, vi } from "vitest";
import shared from "../../../../../tests/access-proof/account-holds-pro-vectors.json";
import { FEATURE_IDS, type BenefitId } from "@still/shared-types";
import { initialAccessSnapshot, parseBenefitAccessSnapshot } from "../access-policy.js";
import { EntitlementCache } from "../cache.js";

const benefits = new Set<BenefitId>([...FEATURE_IDS, "tiktok.all"]);
const legacy = () => {
  const seed = initialAccessSnapshot({ paidMode: true, supported: benefits });
  return { schema: 1, generation: 3, states: { ...seed.states, "youtube.comments": "purchased" }, refreshAfterMs: 60_000, independentProtection: [] };
};

describe("parseBenefitAccessSnapshot: accountHoldsPro", () => {
  it("accepts native's six keys, the shared wire grammar, and keeps the answer", () => {
    expect(Object.keys(legacy()).sort()).toEqual(shared.legacySnapshotKeys);
    for (const held of [true, false]) {
      const wire = { ...legacy(), accountHoldsPro: held };
      expect(Object.keys(wire).sort()).toEqual(shared.snapshotKeys);
      const parsed = parseBenefitAccessSnapshot(wire);
      expect(parsed.accountHoldsPro).toBe(held);
      expect(parsed.states["youtube.comments"]).toBe("purchased");
      // A parsed snapshot re-parses unchanged (caches and the broker parse again).
      expect(parseBenefitAccessSnapshot(parsed)).toEqual(parsed);
    }
  });

  it("reads an older five-key snapshot as not the account's", () => {
    const parsed = parseBenefitAccessSnapshot(legacy());
    expect(parsed.accountHoldsPro).toBe(false);
    expect(parseBenefitAccessSnapshot(parsed)).toEqual(parsed);
  });

  it.each([["the string true", "true"], ["one", 1], ["null", null], ["an object", { held: true }]])("rejects %s", (_name, value) => {
    expect(() => parseBenefitAccessSnapshot({ ...legacy(), accountHoldsPro: value })).toThrow();
  });

  it("still rejects any other sixth key, or seven keys", () => {
    expect(() => parseBenefitAccessSnapshot({ ...legacy(), entitled: true })).toThrow();
    expect(() => parseBenefitAccessSnapshot({ ...legacy(), accountHoldsPro: true, entitled: true })).toThrow();
    const { refreshAfterMs: _dropped, ...missing } = legacy();
    expect(() => parseBenefitAccessSnapshot({ ...missing, accountHoldsPro: true })).toThrow();
  });

  it("a failed later read never keeps an earlier account answer", async () => {
    const first = { ...legacy(), accountHoldsPro: true };
    let fail = false;
    const adapter = { get: vi.fn(async () => false), set: vi.fn(), subscribe: vi.fn(() => () => {}), observeBenefits: vi.fn(async () => { if (fail) throw new Error("unavailable"); return first as never; }) };
    const cache = new EntitlementCache(adapter as never, { access: { paidMode: true, supported: benefits } });
    await cache.refreshAccess();
    expect(cache.currentAccessSnapshot().accountHoldsPro).toBe(true);
    fail = true;
    await cache.refreshAccess().catch(() => {});
    expect(cache.currentAccessSnapshot().accountHoldsPro).toBe(false);
  });
});
