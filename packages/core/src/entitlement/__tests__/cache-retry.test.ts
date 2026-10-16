import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURE_REGISTRY, type BenefitAccessSnapshot } from "@still/shared-types";
import { EntitlementCache, type EntitlementAdapter } from "../cache.js";
import { ACCESS_BENEFITS, initialAccessSnapshot } from "../access-policy.js";

// ISS-0032: one failed access observation (a background still waking up, or an auth event in the
// background that makes an in-flight read stale) must not leave a page without an answer for a
// minute. The cache retries within seconds, then falls back to its ordinary recovery cadence.
vi.mock("@still/shared-types", async (original) => ({
  ...await original<typeof import("@still/shared-types")>(), PAID_TIER_ENABLED: true,
}));

afterEach(() => vi.useRealTimers());

const PRO = FEATURE_REGISTRY.find((row) => row.tier === "pro")!.id;
const context = { paidMode: true, supported: new Set(ACCESS_BENEFITS) };
function locked(): BenefitAccessSnapshot {
  const base = initialAccessSnapshot(context);
  const states = { ...base.states };
  for (const row of FEATURE_REGISTRY) if (row.tier === "pro") states[row.id] = "locked";
  return { ...base, states, refreshAfterMs: null };
}

function cacheWith(observe: () => Promise<BenefitAccessSnapshot>, onAccess?: (listener: () => void) => void) {
  const adapter: EntitlementAdapter = {
    get: async () => null, set: async () => {}, subscribe: () => () => {}, observeBenefits: observe,
    subscribeAccess: (listener) => { onAccess?.(listener); return () => {}; },
  };
  return new EntitlementCache(adapter, { access: context });
}

describe("EntitlementCache recovery after a failed observation", () => {
  it("a failed first observation is retried within seconds, not after a minute", async () => {
    vi.useFakeTimers();
    const observe = vi.fn<() => Promise<BenefitAccessSnapshot>>()
      .mockRejectedValueOnce(new Error("Receiving end does not exist"))
      .mockResolvedValue(locked());
    const cache = cacheWith(observe);
    const stop = cache.watch();
    await cache.refreshAccess();
    expect(observe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(cache.currentAccess(PRO)).toBe("locked");
    stop();
  });

  it("keeps backing off while observations fail, then returns to its ordinary minute", async () => {
    vi.useFakeTimers();
    const observe = vi.fn<() => Promise<BenefitAccessSnapshot>>().mockRejectedValue(new Error("down"));
    const cache = cacheWith(observe);
    const stop = cache.watch();
    await cache.refreshAccess();
    // 1 s, 2 s, 4 s and 8 s after each failure: four quick retries within 15 s.
    await vi.advanceTimersByTimeAsync(15_100);
    expect(observe).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(observe).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observe).toHaveBeenCalledTimes(6);
    // A failure never grants anything: a Pro row is never usable while unanswered.
    expect(["checking", "verification_required"]).toContain(cache.currentAccess(PRO));
    stop();
  });

  it("an access change after a run of failures starts the quick schedule again", async () => {
    vi.useFakeTimers();
    let changed: (() => void) | undefined;
    const observe = vi.fn<() => Promise<BenefitAccessSnapshot>>().mockRejectedValue(new Error("down"));
    const cache = cacheWith(observe, (listener) => { changed = listener; });
    const stop = cache.watch();
    await cache.refreshAccess();
    await vi.advanceTimersByTimeAsync(15_100);
    expect(observe).toHaveBeenCalledTimes(5);
    // An auth or record change: one immediate read (fails), then a retry within seconds.
    changed!();
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(observe).toHaveBeenCalledTimes(7);
    stop();
  });
});
