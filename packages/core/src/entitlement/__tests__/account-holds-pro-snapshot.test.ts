// ISS-0105 follow-up (owner, 22 Oct): native's benefit snapshot carries a display-only answer,
// `accountHoldsPro`, and the account it is about, `accountHoldsProFor`, so the Safari popup and
// Settings page can say "Still Pro User" exactly when the Apple app would, and only beside that
// account. The snapshot grammar: five keys (an older app), six (an earlier QA build with only the
// Boolean, read as false) or seven (the Boolean and its account).
import { describe, expect, it, vi } from "vitest";
import shared from "../../../../../tests/access-proof/account-holds-pro-vectors.json";
import { FEATURE_IDS, type BenefitId } from "@still/shared-types";
import { initialAccessSnapshot, parseBenefitAccessSnapshot } from "../access-policy.js";
import { EntitlementCache } from "../cache.js";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const benefits = new Set<BenefitId>([...FEATURE_IDS, "tiktok.all"]);
const legacy = () => {
  const seed = initialAccessSnapshot({ paidMode: true, supported: benefits });
  return { schema: 1, generation: 3, states: { ...seed.states, "youtube.comments": "purchased" }, refreshAfterMs: 60_000, independentProtection: [] };
};
const held = () => ({ ...legacy(), accountHoldsPro: true, accountHoldsProFor: ACCOUNT });
const notHeld = () => ({ ...legacy(), accountHoldsPro: false, accountHoldsProFor: null });

describe("parseBenefitAccessSnapshot: accountHoldsPro", () => {
  it("accepts native's seven keys, the shared wire grammar, and keeps the answer and its account", () => {
    expect(Object.keys(legacy()).sort()).toEqual(shared.legacySnapshotKeys);
    expect(Object.keys(held()).sort()).toEqual(shared.snapshotKeys);
    const yes = parseBenefitAccessSnapshot(held());
    expect(yes.accountHoldsPro).toBe(true);
    expect(yes.accountHoldsProFor).toBe(ACCOUNT);
    expect(yes.states["youtube.comments"]).toBe("purchased");
    const no = parseBenefitAccessSnapshot(notHeld());
    expect(no.accountHoldsPro).toBe(false);
    expect(no.accountHoldsProFor).toBeNull();
    // A parsed snapshot re-parses unchanged (caches and the broker parse again).
    for (const parsed of [yes, no]) expect(parseBenefitAccessSnapshot(parsed)).toEqual(parsed);
  });

  it("reads an older five-key snapshot as not the account's", () => {
    const parsed = parseBenefitAccessSnapshot(legacy());
    expect(parsed.accountHoldsPro).toBe(false);
    expect(parsed.accountHoldsProFor).toBeNull();
    expect(parseBenefitAccessSnapshot(parsed)).toEqual(parsed);
  });

  it("reads a six-key snapshot (the Boolean without its account) as not the account's", () => {
    for (const value of [true, false]) {
      const parsed = parseBenefitAccessSnapshot({ ...legacy(), accountHoldsPro: value });
      expect(parsed.accountHoldsPro).toBe(false);
      expect(parsed.accountHoldsProFor).toBeNull();
    }
  });

  it.each([["the string true", "true"], ["one", 1], ["null", null], ["an object", { held: true }]])("rejects accountHoldsPro as %s", (_name, value) => {
    expect(() => parseBenefitAccessSnapshot({ ...legacy(), accountHoldsPro: value })).toThrow();
    expect(() => parseBenefitAccessSnapshot({ ...held(), accountHoldsPro: value })).toThrow();
  });

  it.each([
    ["a malformed account", { accountHoldsProFor: "not-a-uuid" }],
    ["a number", { accountHoldsProFor: 7 }],
    ["true without an account", { accountHoldsProFor: null }],
    ["false naming an account", { accountHoldsPro: false }],
  ])("rejects a seven-key snapshot with %s", (_name, change) => {
    expect(() => parseBenefitAccessSnapshot({ ...held(), ...change })).toThrow();
  });

  it("still rejects any other extra key, the account without the Boolean, or eight keys", () => {
    expect(() => parseBenefitAccessSnapshot({ ...legacy(), entitled: true })).toThrow();
    expect(() => parseBenefitAccessSnapshot({ ...legacy(), accountHoldsProFor: ACCOUNT })).toThrow();
    expect(() => parseBenefitAccessSnapshot({ ...legacy(), accountHoldsPro: true, entitled: true })).toThrow();
    expect(() => parseBenefitAccessSnapshot({ ...held(), entitled: true })).toThrow();
    const { refreshAfterMs: _dropped, ...missing } = held();
    expect(() => parseBenefitAccessSnapshot({ ...missing, entitled: true })).toThrow();
  });

  it("a failed later read never keeps an earlier account answer", async () => {
    let fail = false;
    const adapter = { get: vi.fn(async () => false), set: vi.fn(), subscribe: vi.fn(() => () => {}), observeBenefits: vi.fn(async () => { if (fail) throw new Error("unavailable"); return held() as never; }) };
    const cache = new EntitlementCache(adapter as never, { access: { paidMode: true, supported: benefits } });
    await cache.refreshAccess();
    expect(cache.currentAccessSnapshot().accountHoldsPro).toBe(true);
    fail = true;
    await cache.refreshAccess().catch(() => {});
    expect(cache.currentAccessSnapshot().accountHoldsPro).toBe(false);
    expect(cache.currentAccessSnapshot().accountHoldsProFor).toBeNull();
  });
});
