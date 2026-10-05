import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURE_IDS, FEATURE_REGISTRY, type BenefitAccessSnapshot, type BenefitId } from "@still/shared-types";
import { EntitlementCache, type EntitlementAdapter } from "../cache.js";
import { WKBenefitAccessAdapter } from "../wk-benefit-adapter.js";
import { ACCESS_OBSERVATION_DEADLINE_MS, initialAccessSnapshot } from "../access-policy.js";
import { NativeBridge } from "../../native/bridge.js";
import type { StillBridgeWindow } from "../../storage/wkwebview-adapter.js";

const ALL = new Set<BenefitId>([...FEATURE_IDS, "tiktok.all"]);
const PRO = FEATURE_REGISTRY.filter((row) => row.tier === "pro").map((row) => row.id);
const FREE = FEATURE_REGISTRY.filter((row) => row.tier === "free").map((row) => row.id);
const paid = { access: { paidMode: true, supported: ALL } } as const;

function purchasedSnapshot(): BenefitAccessSnapshot {
  const base = initialAccessSnapshot({ paidMode: true, supported: ALL });
  return {
    ...base,
    generation: 3,
    states: { ...base.states, ...Object.fromEntries(PRO.map((id) => [id, "purchased"])) },
  };
}

function nativeWindow(reply: (message: unknown) => Promise<unknown>): StillBridgeWindow {
  return { webkit: { messageHandlers: { still: { postMessage: vi.fn(reply) } } } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WKBenefitAccessAdapter", () => {
  it("never reads native access while the paid tier is off and keeps the packaged snapshot", async () => {
    const observeBenefits = vi.fn(async () => purchasedSnapshot());
    const cache = new EntitlementCache(new WKBenefitAccessAdapter({ observeBenefits }));
    const unwatch = cache.watch();
    await cache.refreshAccess();
    const snapshot = cache.currentAccessSnapshot();
    expect(observeBenefits).not.toHaveBeenCalled();
    for (const id of FREE) expect(snapshot.states[id]).toBe("free");
    expect(snapshot.states["tiktok.all"]).toBe("free");
    for (const id of PRO) expect(snapshot.states[id]).toBe("unsupported");
    expect(Object.values(snapshot.states)).not.toContain("purchased");
    unwatch();
  });

  it("applies one resolved native snapshot in paid mode", async () => {
    const win = nativeWindow(async (message) =>
      (message as { kind: string }).kind === "getBenefitAccess" ? { ok: true, snapshot: purchasedSnapshot() } : null,
    );
    const cache = new EntitlementCache(new WKBenefitAccessAdapter(new NativeBridge(win)), paid);
    for (const id of PRO) expect(cache.currentAccess(id)).toBe("verification_required");
    await cache.refreshAccess();
    for (const id of PRO) expect(cache.currentAccess(id)).toBe("purchased");
  });

  it.each([
    ["a missing native host", {} as StillBridgeWindow],
    ["a failed native reply", nativeWindow(async () => ({ ok: false }))],
    ["an unreadable native reply", nativeWindow(async () => ({ ok: true, snapshot: { schema: 1 } }))],
    ["a native transport error", nativeWindow(async () => Promise.reject(new Error("bridge down")))],
  ])("holds Pro rows for verification after %s, never Pro or locked", async (_name, win) => {
    const cache = new EntitlementCache(new WKBenefitAccessAdapter(new NativeBridge(win)), paid);
    await cache.refreshAccess();
    const snapshot = cache.currentAccessSnapshot();
    for (const id of PRO) expect(snapshot.states[id]).toBe("verification_required");
    expect(Object.values(snapshot.states)).not.toContain("purchased");
    expect(Object.values(snapshot.states)).not.toContain("locked");
    for (const id of FREE) expect(snapshot.states[id]).toBe("free");
  });

  it("bounds a native read that never replies and holds instead of waiting", async () => {
    vi.useFakeTimers();
    const cache = new EntitlementCache(
      new WKBenefitAccessAdapter({ observeBenefits: () => new Promise<BenefitAccessSnapshot>(() => {}) }),
      paid,
    );
    const flight = cache.refreshAccess();
    await vi.advanceTimersByTimeAsync(ACCESS_OBSERVATION_DEADLINE_MS);
    const snapshot = await flight;
    for (const id of PRO) expect(snapshot.states[id]).toBe("verification_required");
  });

  it("cancels an observation when its signal aborts", async () => {
    const adapter = new WKBenefitAccessAdapter({ observeBenefits: () => new Promise<BenefitAccessSnapshot>(() => {}) });
    const controller = new AbortController();
    const read = adapter.observeBenefits(controller.signal);
    controller.abort();
    await expect(read).rejects.toThrow("cancelled");
  });

  it("is read-only: no legacy Boolean grant, refused writes and no listener retention", async () => {
    const adapter = new WKBenefitAccessAdapter({ observeBenefits: async () => purchasedSnapshot() });
    expect(await adapter.get()).toBeNull();
    await expect(adapter.set()).rejects.toThrow();
    const listener = vi.fn();
    const contract: EntitlementAdapter = adapter;
    const unsubscribe = contract.subscribe(listener);
    await contract.observeBenefits?.();
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    const cache = new EntitlementCache(adapter);
    expect(await cache.hydrate()).toBe(false);
  });

  it("leaves no timers armed after a paid-off watch is released", () => {
    vi.useFakeTimers();
    const cache = new EntitlementCache(new WKBenefitAccessAdapter({ observeBenefits: async () => purchasedSnapshot() }));
    const unwatch = cache.watch();
    void cache.refreshAccess();
    unwatch();
    expect(vi.getTimerCount()).toBe(0);
  });
});
