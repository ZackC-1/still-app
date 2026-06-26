import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeEntitlementAdapter, ENTITLEMENT_CACHE_TTL_MS } from "../chrome-adapter.js";

const STORAGE_KEY = "still:entitlement";

type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

// Minimal in-memory chrome.storage.local + onChanged so the adapter's TTL/round-trip/subscribe paths
// run without a browser. set() fans out to onChanged listeners exactly like the real API.
function installChrome(initial: Record<string, unknown> = {}): { store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  const listeners = new Set<Listener>();
  const chromeMock = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) {
            const oldValue = store[k];
            store[k] = v;
            for (const l of listeners) l({ [k]: { oldValue, newValue: v } }, "local");
          }
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  return { store };
}

afterEach(() => vi.unstubAllGlobals());

describe("ChromeEntitlementAdapter — offline TTL", () => {
  const NOW = 1_700_000_000_000;

  it("honors a fresh entitled cache within the TTL", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, updatedAt: NOW - 1000 } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBe(true);
  });

  it("honors an entitled cache just inside the TTL boundary", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, updatedAt: NOW - (ENTITLEMENT_CACHE_TTL_MS - 1) } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBe(true);
  });

  it("drops an entitled cache past the TTL (downgrades to free)", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true, updatedAt: NOW - (ENTITLEMENT_CACHE_TTL_MS + 1) } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBeNull();
  });

  it("treats a missing timestamp as expired — never an unbounded grant", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: true } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBeNull();
  });

  it("returns null when no entitlement is stored", async () => {
    installChrome();
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBeNull();
  });

  it("returns null for a non-boolean entitled field", async () => {
    installChrome({ [STORAGE_KEY]: { entitled: "yes", updatedAt: NOW } });
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    expect(await adapter.get()).toBeNull();
  });

  it("round-trips set→get within the TTL and stamps the write time", async () => {
    const { store } = installChrome();
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    await adapter.set(true);
    expect(store[STORAGE_KEY]).toEqual({ entitled: true, updatedAt: NOW });
    expect(await adapter.get()).toBe(true);
  });

  it("notifies subscribers when the stored entitlement changes", async () => {
    installChrome();
    const adapter = new ChromeEntitlementAdapter(() => NOW);
    const seen: boolean[] = [];
    const unsubscribe = adapter.subscribe((entitled) => seen.push(entitled));
    await adapter.set(true);
    await adapter.set(false);
    unsubscribe();
    await adapter.set(true);
    expect(seen).toEqual([true, false]);
  });
});
